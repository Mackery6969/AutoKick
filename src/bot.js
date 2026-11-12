// The always-on part of the bot: one Durable Object that stays connected to the
// Discord gateway, records activity in its SQLite storage, and kicks members who
// have been inactive too long.
//
// Free-plan rule that shapes this file: each invocation (an alarm, or one slash
// command) may make at most 50 outbound requests. So gateway event handlers
// never call the Discord REST API; they only write to storage. All REST calls
// happen in alarm() or handleCommand(), each with its own request Budget.

import { DurableObject } from 'cloudflare:workers';
import {
  assess,
  channelCounts,
  countsAsVoice,
  DAY_MS,
  escapeMarkdown,
  formatDuration,
  pauseChanges,
} from './policy.js';
import {
  APP_FLAGS_MEMBERS_INTENT,
  Budget,
  BudgetExceeded,
  canKick,
  canViewChannel,
  detectedPauseRoleIds,
  discordRest,
  editOriginalReply,
  guildMeta,
  INTENTS,
  memberRecord,
  pauseRoleIds,
} from './discord.js';
import { COMMANDS, runCommand } from './commands.js';

const ALARM_MS = 60_000; // check in once a minute (also keeps the object in memory)
const SWEEP_INTERVAL_MS = 60 * 60_000; // look for inactive members hourly
const ENABLE_GRACE_MS = 60 * 60_000; // first kicks no sooner than 1 hour after /autokick enable
const DOWNTIME_GAP_MS = 3 * 60_000; // offline longer than this counts as downtime
const DOWNTIME_KEEP_MS = 400 * DAY_MS;
const TOUCH_THROTTLE_MS = 60 * 60_000; // store each member's activity at most hourly
const MEMBER_CACHE_MS = 6 * 60 * 60_000;
const FATAL_RETRY_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
// Discord resets a bot's token after 1000 logins in a day. Normal use is a few
// per day; this cap makes sure a reconnect loop can never get anywhere near that.
const MAX_IDENTIFIES_PER_DAY = 200;
const KICK_RETRY_MS = 6 * 60 * 60_000;
const REQUEST_BUDGET = 44; // leaves headroom under the free plan's 50
const DEFAULT_GATEWAY = 'wss://gateway.discord.gg';
const COUNTED_MESSAGE_TYPES = new Set([0, 18, 19]); // normal message, thread created, reply
// Channels where people can be active: text, voice, announcement, stage, forum, media.
const ACTIVITY_CHANNEL_TYPES = new Set([0, 2, 5, 13, 15, 16]);

// Shown under the bot's name in Discord: "Watching Activity..." (activity type 3 = Watching).
const PRESENCE = { since: null, activities: [{ name: 'Activity...', type: 3 }], status: 'online', afk: false };

const TOKEN_PROBLEM = 'Discord rejected the bot token. Set the DISCORD_TOKEN secret again.';
const INTENT_PROBLEM =
  'Discord says "Server Members Intent" is off. Turn it on under Bot > Privileged Gateway Intents ' +
  'in the Discord Developer Portal and click "Save Changes". The bot checks again every minute.';

const FATAL_CLOSE_CODES = {
  4004: TOKEN_PROBLEM,
  4010: 'Discord says the shard is invalid.',
  4011: 'The bot is in too many servers to run without sharding.',
  4012: 'Discord says the gateway version is invalid.',
  4013: 'Discord says the intents are invalid.',
  4014: INTENT_PROBLEM,
};
const NO_RESUME_CLOSE_CODES = new Set([4007, 4009]);

/** Short hash of the token, so a stored error can tell whether the token has since been changed. */
async function tokenFingerprint(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const today = () => new Date().toISOString().slice(0, 10);

function defaultConfig(now) {
  return {
    enabled: false,
    days: 30,
    logChannelId: null,
    trackingSince: now,
    armedAt: null,
    whitelist: { roles: [], users: [] },
    blacklist: { roles: [], users: [] },
    pauseRoles: [], // members with these roles don't lose time (plus auto-detected "Muted" roles)
    channels: { whitelist: [], blacklist: [] }, // where activity counts (channels, categories, threads)
  };
}

export class AutoKickBot extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS guilds (id TEXT PRIMARY KEY, config TEXT NOT NULL, meta TEXT)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS activity (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, last_active INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voice (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT NOT NULL, deaf INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id))`);
    try {
      // Older versions created the table without the deafened flag.
      this.sql.exec('ALTER TABLE voice ADD COLUMN deaf INTEGER NOT NULL DEFAULT 0');
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
    // Periods when a member was muted (kind 'timeout' or 'role'); ended_at is NULL while ongoing.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pauses (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS pauses_member ON pauses (guild_id, user_id)');

    this.ws = null;
    this.ready = false;
    this.seq = null;
    this.hbTimeout = null;
    this.hbInterval = null;
    this.hbAcked = true;
    this.failures = 0;
    this.nextConnectAt = 0;
    this.tokenId = null;
    this.lastWrite = new Map(); // "guild:user" -> last stored activity time
    this.recent = new Map(); // guildId -> Map<userId, exact last activity time> (memory only)
    this.guildCache = new Map(); // guildId -> guildMeta (roles, owner, AFK channel)
    this.memberCache = new Map(); // guildId -> { fetchedAt, members: Map<userId, record> }
    this.channelParents = new Map(); // guildId -> Map<channelId, parentId|null> (thread → channel → category)
    this.kickFailures = new Map(); // "guild:user" -> time of last failed kick
  }

  // ---------------------------------------------------------------- storage

  getState(key, fallback = null) {
    const row = this.sql.exec('SELECT value FROM state WHERE key = ?', key).toArray()[0];
    return row ? JSON.parse(row.value) : fallback;
  }

  setState(key, value) {
    if (value === null || value === undefined) {
      this.sql.exec('DELETE FROM state WHERE key = ?', key);
    } else {
      this.sql.exec(
        'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        JSON.stringify(value),
      );
    }
  }

  getConfig(guildId) {
    const row = this.sql.exec('SELECT config FROM guilds WHERE id = ?', guildId).toArray()[0];
    return row ? { ...defaultConfig(0), ...JSON.parse(row.config) } : null;
  }

  ensureConfig(guildId) {
    const existing = this.getConfig(guildId);
    if (existing) return existing;
    const cfg = defaultConfig(Date.now());
    this.saveConfig(guildId, cfg);
    return cfg;
  }

  saveConfig(guildId, cfg) {
    this.sql.exec(
      'INSERT INTO guilds (id, config) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config',
      guildId,
      JSON.stringify(cfg),
    );
  }

  saveMeta(guild) {
    const meta = { name: guild.name, ownerId: guild.owner_id, afkChannelId: guild.afk_channel_id ?? null };
    this.sql.exec('UPDATE guilds SET meta = ? WHERE id = ?', JSON.stringify(meta), guild.id);
  }

  afkChannel(guildId) {
    const cached = this.guildCache.get(guildId);
    if (cached) return cached.afkChannelId;
    const row = this.sql.exec('SELECT meta FROM guilds WHERE id = ?', guildId).toArray()[0];
    return row?.meta ? JSON.parse(row.meta).afkChannelId : null;
  }

  setChannelParents(guildId, channels) {
    this.channelParents.set(guildId, new Map(channels.map((c) => [c.id, c.parent_id ?? null])));
  }

  /** The channel followed by its parents, most specific first: thread → channel → category. */
  channelChain(guildId, channelId) {
    const parents = this.channelParents.get(guildId);
    const chain = [];
    for (let id = channelId; id && chain.length < 4; id = parents?.get(id) ?? null) chain.push(id);
    return chain;
  }

  /** Does activity in this channel count, given the channel whitelist/blacklist? */
  countsInChannel(guildId, channelId, cfg = this.getConfig(guildId)) {
    return channelCounts(cfg, this.channelChain(guildId, channelId));
  }

  touch(guildId, userId, ts = Date.now()) {
    // Exact time in memory; storage is only updated hourly to save writes.
    if (!this.recent.has(guildId)) this.recent.set(guildId, new Map());
    const recent = this.recent.get(guildId);
    if (ts > (recent.get(userId) ?? 0)) recent.set(userId, ts);

    const key = `${guildId}:${userId}`;
    if (ts - (this.lastWrite.get(key) ?? 0) < TOUCH_THROTTLE_MS) return;
    this.sql.exec(
      `INSERT INTO activity (guild_id, user_id, last_active) VALUES (?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET last_active = MAX(last_active, excluded.last_active)`,
      guildId,
      userId,
      ts,
    );
    this.lastWrite.set(key, ts);
  }

  /** Everyone in a voice channel (not the AFK channel, not deafened) counts as active right now. */
  touchVoice(onlyGuildId = null) {
    const query = 'SELECT guild_id, user_id, channel_id, deaf FROM voice';
    const rows = onlyGuildId
      ? this.sql.exec(`${query} WHERE guild_id = ?`, onlyGuildId).toArray()
      : this.sql.exec(query).toArray();
    const now = Date.now();
    const configs = new Map();
    const configFor = (guildId) => {
      if (!configs.has(guildId)) configs.set(guildId, this.getConfig(guildId));
      return configs.get(guildId);
    };
    for (const row of rows) {
      if (
        countsAsVoice(row.channel_id, Boolean(row.deaf), this.afkChannel(row.guild_id)) &&
        this.countsInChannel(row.guild_id, row.channel_id, configFor(row.guild_id))
      ) {
        this.touch(row.guild_id, row.user_id, now);
      }
    }
  }

  activityMap(guildId) {
    const rows = this.sql.exec('SELECT user_id, last_active FROM activity WHERE guild_id = ?', guildId).toArray();
    const map = Object.fromEntries(rows.map((r) => [r.user_id, r.last_active]));
    for (const [userId, ts] of this.recent.get(guildId) ?? []) {
      if (ts > (map[userId] ?? 0)) map[userId] = ts;
    }
    return map;
  }

  /** Muted periods for a server (or one member), grouped by member. */
  pauseRows(guildId, userId = null) {
    const query = 'SELECT rowid AS id, user_id, kind, started_at, ended_at FROM pauses WHERE guild_id = ?';
    const rows = userId
      ? this.sql.exec(`${query} AND user_id = ?`, guildId, userId).toArray()
      : this.sql.exec(query, guildId).toArray();
    const byUser = new Map();
    for (const row of rows) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id).push(row);
    }
    return byUser;
  }

  /**
   * Record when a member becomes muted (timed out, or given a pause role) and
   * when that stops. `pauseRoles` is null when the server's roles aren't known
   * yet; then only timeouts are synced. Returns true if anything was written.
   */
  syncPause(guildId, member, rows, pauseRoles, now = Date.now()) {
    const ops = pauseChanges(rows, member, pauseRoles, now);
    for (const { insert, update } of ops) {
      if (insert) {
        this.sql.exec(
          'INSERT INTO pauses (guild_id, user_id, kind, started_at, ended_at) VALUES (?, ?, ?, ?, ?)',
          guildId,
          member.id,
          insert.kind,
          insert.start,
          insert.end,
        );
      } else {
        this.sql.exec('UPDATE pauses SET ended_at = ? WHERE rowid = ?', update.end, update.id);
      }
    }
    return ops.length > 0;
  }

  forgetMember(guildId, userId) {
    this.sql.exec('DELETE FROM activity WHERE guild_id = ? AND user_id = ?', guildId, userId);
    this.sql.exec('DELETE FROM voice WHERE guild_id = ? AND user_id = ?', guildId, userId);
    this.sql.exec('DELETE FROM pauses WHERE guild_id = ? AND user_id = ?', guildId, userId);
    this.lastWrite.delete(`${guildId}:${userId}`);
    this.recent.get(guildId)?.delete(userId);
    this.memberCache.get(guildId)?.members.delete(userId);
  }

  forgetGuild(guildId) {
    this.sql.exec('DELETE FROM guilds WHERE id = ?', guildId);
    this.sql.exec('DELETE FROM activity WHERE guild_id = ?', guildId);
    this.sql.exec('DELETE FROM voice WHERE guild_id = ?', guildId);
    this.sql.exec('DELETE FROM pauses WHERE guild_id = ?', guildId);
    this.recent.delete(guildId);
    this.channelParents.delete(guildId);
    this.guildCache.delete(guildId);
    this.memberCache.delete(guildId);
  }

  rest(method, path, options) {
    return discordRest(this.env.DISCORD_TOKEN, method, path, options);
  }

  // ---------------------------------------------------------------- gateway

  identifyAllowed() {
    const counter = this.getState('identifies');
    return !(counter?.day === today() && counter.count >= MAX_IDENTIFIES_PER_DAY);
  }

  countIdentify() {
    const counter = this.getState('identifies');
    const count = counter?.day === today() ? counter.count + 1 : 1;
    this.setState('identifies', { day: today(), count });
  }

  async connect(budget) {
    const token = this.env.DISCORD_TOKEN;
    if (!token || Date.now() < this.nextConnectAt) return;
    this.tokenId = await tokenFingerprint(token);
    const fatal = this.getState('fatal');
    if (fatal && fatal.token === this.tokenId) {
      // Ask Discord whether the problem is fixed. Unlike a gateway login, this
      // doesn't count toward the daily login limit, so it can run every minute.
      const problem = await this.applicationProblem(budget);
      if (problem) {
        this.setState('fatal', { ...fatal, message: problem, checkedAt: Date.now() });
        return;
      }
      const fixable = fatal.code === undefined || fatal.code === 4004 || fatal.code === 4014;
      if (!fixable && Date.now() - fatal.at < FATAL_RETRY_MS) return;
    }

    const session = this.getState('session');
    if (!session && !this.identifyAllowed()) return;
    const base = (session?.resumeUrl ?? DEFAULT_GATEWAY).replace(/^wss:\/\//, 'https://').replace(/\/+$/, '');
    budget.use();
    const resp = await fetch(`${base}/?v=10&encoding=json`, { headers: { Upgrade: 'websocket' } });
    const ws = resp.webSocket;
    if (!ws) throw new Error(`Discord gateway refused the connection (HTTP ${resp.status})`);
    ws.accept();

    this.ws = ws;
    this.ready = false;
    this.seq = session?.seq ?? null;
    ws.addEventListener('message', (event) => this.safely(() => this.onGatewayMessage(ws, event.data)));
    ws.addEventListener('close', (event) => this.safely(() => this.onGatewayClose(ws, event.code, event.reason)));
    ws.addEventListener('error', () =>
      this.safely(() => this.dropConnection(ws, 'socket error', { resumable: true })),
    );
  }

  /** Returns why the bot can't log in (bad token, intent off), or null if Discord says it's fine. */
  async applicationProblem(budget) {
    try {
      const app = await this.rest('GET', '/applications/@me', { budget });
      return app.flags & APP_FLAGS_MEMBERS_INTENT ? null : INTENT_PROBLEM;
    } catch (err) {
      if (err.status === 401) return TOKEN_PROBLEM;
      throw err;
    }
  }

  safely(fn) {
    try {
      fn();
    } catch (err) {
      console.error('Gateway handler error:', err?.stack ?? err);
    }
  }

  send(payload) {
    this.ws?.send(JSON.stringify(payload));
  }

  onGatewayMessage(ws, raw) {
    if (ws !== this.ws) return;
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const { op, d, s, t } = JSON.parse(text);
    if (s != null) this.seq = s;

    switch (op) {
      case 0: // dispatch
        this.onDispatch(t, d);
        break;
      case 1: // Discord asks for a heartbeat right now
        this.send({ op: 1, d: this.seq });
        break;
      case 7: // reconnect
        this.dropConnection(ws, 'Discord asked for a reconnect', { resumable: true });
        break;
      case 9: // invalid session; d says whether it can be resumed
        this.dropConnection(ws, 'invalid session', { resumable: Boolean(d) });
        break;
      case 10: // hello
        this.onHello(ws, d.heartbeat_interval);
        break;
      case 11: // heartbeat ack
        this.hbAcked = true;
        if (this.hbSentAt) this.latency = Date.now() - this.hbSentAt;
        break;
    }
  }

  onHello(ws, interval) {
    this.startHeartbeat(ws, interval);
    const session = this.getState('session');
    if (session?.id && this.seq != null) {
      this.send({ op: 6, d: { token: this.env.DISCORD_TOKEN, session_id: session.id, seq: this.seq } });
    } else {
      if (!this.identifyAllowed()) {
        this.dropConnection(ws, 'daily login limit reached', { resumable: false });
        return;
      }
      this.countIdentify();
      this.send({
        op: 2,
        d: {
          token: this.env.DISCORD_TOKEN,
          intents: INTENTS,
          properties: { os: 'cloudflare', browser: 'autokick', device: 'autokick' },
          large_threshold: 50,
          presence: PRESENCE,
        },
      });
    }
  }

  startHeartbeat(ws, interval) {
    this.stopHeartbeat();
    this.hbAcked = true;
    const beat = () => {
      if (ws !== this.ws) return this.stopHeartbeat();
      if (!this.hbAcked) return this.dropConnection(ws, 'heartbeat not acknowledged', { resumable: true });
      this.hbAcked = false;
      this.hbSentAt = Date.now();
      this.send({ op: 1, d: this.seq });
    };
    this.hbTimeout = setTimeout(() => {
      this.safely(beat);
      this.hbInterval = setInterval(() => this.safely(beat), interval);
    }, Math.floor(interval * Math.random()));
  }

  stopHeartbeat() {
    clearTimeout(this.hbTimeout);
    clearInterval(this.hbInterval);
    this.hbTimeout = this.hbInterval = null;
  }

  onGatewayClose(ws, code, reason) {
    if (ws !== this.ws) return;
    const fatal = FATAL_CLOSE_CODES[code];
    if (fatal) {
      console.error(`Gateway closed with ${code}: ${fatal}`);
      this.dropConnection(ws, `closed (${code})`, { resumable: false, fatalMessage: fatal, fatalCode: code });
      return;
    }
    this.dropConnection(ws, `closed by Discord (${code} ${reason})`, { resumable: !NO_RESUME_CLOSE_CODES.has(code) });
  }

  dropConnection(ws, reason, { resumable, fatalMessage, fatalCode } = {}) {
    if (ws !== this.ws) return;
    this.stopHeartbeat();
    this.ws = null;
    this.ready = false;

    const session = this.getState('session');
    if (resumable && session && this.seq != null) this.setState('session', { ...session, seq: this.seq });
    else this.setState('session', null);
    if (fatalMessage) {
      this.setState('fatal', { at: Date.now(), checkedAt: Date.now(), code: fatalCode, message: fatalMessage, token: this.tokenId });
    }

    try {
      // 4000 keeps the session resumable; 1000 tells Discord we're done with it.
      ws.close(resumable ? 4000 : 1000, String(reason).slice(0, 100));
    } catch {
      // already closed
    }
    console.log(`Gateway disconnected: ${reason}`);

    // Reconnect from an alarm (its own invocation, with its own request budget),
    // backing off 2s, 4s, 8s ... up to 15 minutes while it keeps failing.
    this.failures += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.min(this.failures - 1, 10));
    this.nextConnectAt = Date.now() + delay;
    this.ctx.storage.setAlarm(Date.now() + Math.min(delay, ALARM_MS));
  }

  onDispatch(t, d) {
    switch (t) {
      case 'READY':
        return this.onReady(d);
      case 'RESUMED':
        // A resumed session may predate the current presence; set it again.
        this.send({ op: 3, d: PRESENCE });
        return this.markWatching(false);
      case 'GUILD_CREATE':
        return this.onGuildCreate(d);
      case 'GUILD_UPDATE':
        this.saveMeta(d);
        this.guildCache.set(d.id, guildMeta(d));
        return;
      case 'GUILD_DELETE':
        if (!d.unavailable) this.forgetGuild(d.id); // the bot was removed from the server
        return;
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE': {
        const { role } = d;
        this.guildCache.get(d.guild_id)?.roles.set(role.id, {
          name: role.name,
          position: role.position,
          permissions: BigInt(role.permissions),
        });
        return;
      }
      case 'GUILD_ROLE_DELETE':
        this.guildCache.get(d.guild_id)?.roles.delete(d.role_id);
        return;
      case 'GUILD_MEMBER_ADD':
      case 'GUILD_MEMBER_UPDATE': {
        const record = memberRecord(d);
        this.memberCache.get(d.guild_id)?.members.set(record.id, record);
        const cfg = this.getConfig(d.guild_id);
        if (cfg) {
          const meta = this.guildCache.get(d.guild_id);
          const rows = this.pauseRows(d.guild_id, record.id).get(record.id) ?? [];
          this.syncPause(d.guild_id, record, rows, meta ? pauseRoleIds(cfg, meta) : null);
        }
        return;
      }
      case 'GUILD_MEMBER_REMOVE':
        return this.forgetMember(d.guild_id, d.user.id);
      // Keep the channel → category / thread → channel map current (for the channel lists).
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE':
        if (d.guild_id) this.channelParents.get(d.guild_id)?.set(d.id, d.parent_id ?? null);
        return;
      case 'CHANNEL_DELETE':
      case 'THREAD_DELETE':
        if (d.guild_id) this.channelParents.get(d.guild_id)?.delete(d.id);
        return;
      case 'THREAD_LIST_SYNC':
        for (const thread of d.threads ?? []) this.channelParents.get(d.guild_id)?.set(thread.id, thread.parent_id ?? null);
        return;
      case 'MESSAGE_CREATE':
        return this.onMessage(d);
      case 'VOICE_STATE_UPDATE':
        return this.onVoiceState(d);
    }
  }

  onReady(d) {
    this.setState('session', { id: d.session_id, resumeUrl: d.resume_gateway_url, seq: this.seq });
    this.setState('appId', d.application.id);
    this.setState('botId', d.user.id);
    this.setState('fatal', null);

    // Forget servers the bot was removed from while it was offline.
    const current = new Set(d.guilds.map((g) => g.id));
    for (const { id } of this.sql.exec('SELECT id FROM guilds').toArray()) {
      if (!current.has(id)) this.forgetGuild(id);
    }
    this.guildCache.clear();
    this.memberCache.clear();
    this.markWatching(true);
    console.log(`Connected to Discord as ${d.user.username} in ${current.size} server(s).`);
  }

  /**
   * Called when the connection is live. After a fresh login (not a resume),
   * events from the offline gap are lost, so that gap is recorded as downtime
   * and isn't counted against anyone.
   */
  markWatching(freshSession) {
    const now = Date.now();
    const watchedAt = this.getState('watchedAt');
    if (freshSession && watchedAt && now - watchedAt > DOWNTIME_GAP_MS) {
      const downtime = this.getState('downtime', []).filter(([, end]) => end > now - DOWNTIME_KEEP_MS);
      downtime.push([watchedAt, now]);
      this.setState('downtime', downtime);
    }
    this.setState('watchedAt', now);
    this.ready = true;
    this.failures = 0;
    this.nextConnectAt = 0;
  }

  onGuildCreate(d) {
    if (d.unavailable) return;
    this.ensureConfig(d.id);
    this.saveMeta(d);
    this.guildCache.set(d.id, guildMeta(d));
    this.memberCache.delete(d.id);
    this.setChannelParents(d.id, [...(d.channels ?? []), ...(d.threads ?? [])]);

    // Replace the voice snapshot for this server.
    this.sql.exec('DELETE FROM voice WHERE guild_id = ?', d.id);
    for (const vs of d.voice_states ?? []) {
      if (vs.channel_id) {
        this.sql.exec(
          'INSERT INTO voice (guild_id, user_id, channel_id, deaf) VALUES (?, ?, ?, ?)',
          d.id,
          vs.user_id,
          vs.channel_id,
          vs.self_deaf || vs.deaf ? 1 : 0,
        );
      }
    }
    this.touchVoice(d.id);
  }

  onMessage(d) {
    if (!d.guild_id || d.author?.bot || d.webhook_id || !COUNTED_MESSAGE_TYPES.has(d.type)) return;
    if (!this.countsInChannel(d.guild_id, d.channel_id)) return; // channel whitelist/blacklist
    this.touch(d.guild_id, d.author.id);
  }

  onVoiceState(d) {
    if (!d.guild_id || d.member?.user?.bot) return;
    const prev = this.sql
      .exec('SELECT channel_id, deaf FROM voice WHERE guild_id = ? AND user_id = ?', d.guild_id, d.user_id)
      .toArray()[0];
    const prevChannel = prev?.channel_id ?? null;
    const prevDeaf = Boolean(prev?.deaf);
    const deaf = Boolean(d.self_deaf || d.deaf);
    const afk = this.afkChannel(d.guild_id);
    const cfg = this.getConfig(d.guild_id);
    const counts = (channelId, deafened) =>
      countsAsVoice(channelId, deafened, afk) && this.countsInChannel(d.guild_id, channelId, cfg);

    // Joining, leaving, switching, deafening or undeafening: if they were (or now are)
    // in voice in a way that counts, they're active right now.
    if (counts(prevChannel, prevDeaf) || counts(d.channel_id, deaf)) {
      this.touch(d.guild_id, d.user_id);
    }

    if (prevChannel === d.channel_id && prevDeaf === deaf) return; // only mute/video/stream changed
    if (d.channel_id) {
      this.sql.exec(
        `INSERT INTO voice (guild_id, user_id, channel_id, deaf) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id = excluded.channel_id, deaf = excluded.deaf`,
        d.guild_id,
        d.user_id,
        d.channel_id,
        deaf ? 1 : 0,
      );
    } else {
      this.sql.exec('DELETE FROM voice WHERE guild_id = ? AND user_id = ?', d.guild_id, d.user_id);
    }
  }

  // ---------------------------------------------------------------- alarm

  async alarm() {
    const budget = new Budget(REQUEST_BUDGET);
    try {
      if (!this.ws) await this.connect(budget);
      if (this.ready) {
        this.setState('watchedAt', Date.now());
        const session = this.getState('session');
        if (session && this.seq != null) this.setState('session', { ...session, seq: this.seq });
        this.touchVoice();
        await this.syncCommands(budget);
        await this.loadMissingGuildMeta(budget);
        await this.runSweeps(budget);
      }
    } catch (err) {
      if (!(err instanceof BudgetExceeded)) console.error('Alarm run failed:', err?.stack ?? err);
    } finally {
      // Keep checking in once a minute, unless a reconnect is already scheduled sooner.
      const next = Date.now() + ALARM_MS;
      const existing = await this.ctx.storage.getAlarm();
      if (existing == null || existing <= Date.now() || existing > next) {
        await this.ctx.storage.setAlarm(next);
      }
    }
  }

  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  async syncCommands(budget) {
    const appId = this.getState('appId');
    if (!appId) return;
    const json = JSON.stringify(COMMANDS);
    if (this.getState('commandsSynced') === json) return;
    await this.rest('PUT', `/applications/${appId}/commands`, { body: COMMANDS, budget });
    this.setState('commandsSynced', json);
    console.log('Slash commands registered.');
  }

  // ---------------------------------------------------------------- assessing & kicking

  async getMeta(guildId, budget) {
    let meta = this.guildCache.get(guildId);
    if (!meta) {
      meta = guildMeta(await this.rest('GET', `/guilds/${guildId}`, { budget }));
      this.guildCache.set(guildId, meta);
    }
    return meta;
  }

  async loadGuild(guildId, budget) {
    const meta = await this.getMeta(guildId, budget);
    let cache = this.memberCache.get(guildId);
    if (!cache || Date.now() - cache.fetchedAt > MEMBER_CACHE_MS) {
      const members = new Map();
      let after = '0';
      for (;;) {
        const page = await this.rest('GET', `/guilds/${guildId}/members?limit=1000&after=${after}`, { budget });
        for (const m of page) members.set(m.user.id, memberRecord(m));
        if (page.length < 1000) break;
        after = page[page.length - 1].user.id;
      }
      cache = { fetchedAt: Date.now(), members };
      this.memberCache.set(guildId, cache);
    }
    return { meta, members: cache.members };
  }

  assessWith(cfg, meta, botMember, member, pauseRows, ctx) {
    const { now } = ctx;
    const current = pauseRows.find((r) => r.started_at <= now && (r.ended_at === null || r.ended_at > now));
    const snapshot = {
      ...member,
      isOwner: member.id === meta.ownerId,
      kickable: canKick(meta, botMember, member),
      pauses: pauseRows.map((r) => [r.started_at, r.ended_at ?? now]),
      pausedBy: current?.kind ?? null,
    };
    return assess(snapshot, cfg, ctx);
  }

  /** Bring the muted-period records up to date for these members (catches anything missed while offline). */
  syncPauses(guildId, cfg, meta, members, now) {
    const roles = pauseRoleIds(cfg, meta);
    const before = this.pauseRows(guildId);
    let changed = false;
    for (const member of members) {
      if (this.syncPause(guildId, member, before.get(member.id) ?? [], roles, now)) changed = true;
    }
    return changed ? this.pauseRows(guildId) : before;
  }

  async assessGuild(guildId, budget) {
    const cfg = this.ensureConfig(guildId);
    const { meta, members } = await this.loadGuild(guildId, budget);
    this.touchVoice(guildId);
    const now = Date.now();
    const pauses = this.syncPauses(guildId, cfg, meta, members.values(), now);
    const botMember = members.get(this.getState('botId'));
    const full = { ...cfg, activity: this.activityMap(guildId) };
    const ctx = { now, downtime: this.getState('downtime', []) };
    const results = [...members.values()].map((member) => ({
      member,
      result: this.assessWith(full, meta, botMember, member, pauses.get(member.id) ?? [], ctx),
    }));
    return { cfg, meta, botMember, results, detectedPauseRoles: detectedPauseRoleIds(meta) };
  }

  async assessMember(guildId, userId, budget) {
    const cfg = this.ensureConfig(guildId);
    const { meta, members } = await this.loadGuild(guildId, budget);
    const member = members.get(userId);
    if (!member) return null;
    this.touchVoice(guildId);
    const now = Date.now();
    const pauses = this.syncPauses(guildId, cfg, meta, [member], now);
    const full = { ...cfg, activity: this.activityMap(guildId) };
    const ctx = { now, downtime: this.getState('downtime', []) };
    const botMember = members.get(this.getState('botId'));
    return { member, result: this.assessWith(full, meta, botMember, member, pauses.get(userId) ?? [], ctx) };
  }

  /**
   * Channels where activity should count but the bot can't see them (no View
   * Channel), so it gets no messages or voice updates from them. Sorted like
   * the channel list. Returns null if the bot's own membership isn't known.
   */
  async hiddenChannels(guildId, budget) {
    const cfg = this.ensureConfig(guildId);
    const { meta, members } = await this.loadGuild(guildId, budget);
    const botMember = members.get(this.getState('botId'));
    if (!botMember) return null;
    const channels = await this.rest('GET', `/guilds/${guildId}/channels`, { budget });

    // Refresh the channel → category map while we have it.
    const parents = this.channelParents.get(guildId);
    if (parents) for (const c of channels) parents.set(c.id, c.parent_id ?? null);

    return channels
      .filter((c) => ACTIVITY_CHANNEL_TYPES.has(c.type))
      .filter((c) => channelCounts(cfg, [c.id, c.parent_id].filter(Boolean)))
      .filter((c) => !canViewChannel(meta, botMember, c))
      .sort((a, b) => a.position - b.position)
      .map((c) => c.id);
  }

  /**
   * After a restart, fetch each server's roles and channels so pause roles and
   * the channel lists (threads and categories included) work in real time.
   */
  async loadMissingGuildMeta(budget) {
    for (const { id } of this.sql.exec('SELECT id FROM guilds').toArray()) {
      if (budget.remaining < 20) return;
      try {
        if (!this.guildCache.has(id)) await this.getMeta(id, budget);
        if (!this.channelParents.has(id)) {
          const channels = await this.rest('GET', `/guilds/${id}/channels`, { budget });
          const { threads = [] } = await this.rest('GET', `/guilds/${id}/threads/active`, { budget });
          this.setChannelParents(id, [...channels, ...threads]);
        }
      } catch (err) {
        if (err instanceof BudgetExceeded) throw err;
        console.warn(`Could not load server ${id}: ${err.message}`);
      }
    }
  }

  async runSweeps(budget) {
    let queue = this.getState('sweepQueue');
    if (!queue) {
      const now = Date.now();
      if (now < this.getState('nextSweepAt', 0)) return;
      this.setState('nextSweepAt', now + SWEEP_INTERVAL_MS);
      this.sql.exec('DELETE FROM pauses WHERE ended_at IS NOT NULL AND ended_at < ?', now - DOWNTIME_KEEP_MS);
      queue = this.sql
        .exec('SELECT id, config FROM guilds')
        .toArray()
        .filter((row) => JSON.parse(row.config).enabled)
        .map((row) => row.id);
      this.setState('sweepQueue', queue);
    }
    while (queue.length) {
      const finished = await this.sweepGuild(queue[0], budget);
      if (!finished) break; // out of requests for this run; carry on next minute
      queue.shift();
      this.setState('sweepQueue', queue);
    }
    if (!queue.length) this.setState('sweepQueue', null);
  }

  /** Returns true when the server is done for this round, false to continue next run. */
  async sweepGuild(guildId, budget) {
    const cfg = this.getConfig(guildId);
    if (!cfg?.enabled || (cfg.armedAt && Date.now() < cfg.armedAt)) return true;
    try {
      const { meta, results } = await this.assessGuild(guildId, budget);
      const now = Date.now();
      const targets = results
        .filter(({ member, result }) => {
          if (result.action !== 'kick') return false;
          const failedAt = this.kickFailures.get(`${guildId}:${member.id}`);
          return !failedAt || now - failedAt > KICK_RETRY_MS;
        })
        .sort((a, b) => b.result.inactiveMs - a.result.inactiveMs);

      for (const { member, result } of targets) {
        if (budget.remaining < 4) return false;
        if (!this.getConfig(guildId)?.enabled) return true; // turned off mid-sweep
        await this.kickMember(guildId, meta, member, result, budget);
      }
      return true;
    } catch (err) {
      if (err instanceof BudgetExceeded) return false;
      console.error(`Inactivity check failed for server ${guildId}:`, err?.message ?? err);
      return true;
    }
  }

  async kickMember(guildId, meta, member, result, budget) {
    const duration = formatDuration(result.inactiveMs);
    try {
      const dm = await this.rest('POST', '/users/@me/channels', { body: { recipient_id: member.id }, budget });
      await this.rest('POST', `/channels/${dm.id}/messages`, {
        body: {
          content:
            `You were removed from **${escapeMarkdown(meta.name)}** because you hadn't sent a message ` +
            `or joined a voice channel there in ${duration}. You're welcome to rejoin any time.`,
        },
        budget,
      });
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      // DMs closed or blocked: kick anyway.
    }

    try {
      await this.rest('DELETE', `/guilds/${guildId}/members/${member.id}`, {
        reason: `AutoKick: inactive for ${duration}`,
        budget,
      });
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      this.kickFailures.set(`${guildId}:${member.id}`, Date.now());
      console.warn(`Could not kick ${member.id} from ${guildId}: ${err.message}`);
      return;
    }

    this.forgetMember(guildId, member.id);
    console.log(`Kicked ${member.id} from ${guildId} (inactive ${duration}).`);
    await this.log(
      guildId,
      `👢 Kicked <@${member.id}> (**${escapeMarkdown(member.username)}**): no messages or voice activity for ${duration}.`,
      budget,
    ).catch((err) => {
      if (err instanceof BudgetExceeded) throw err;
    });
  }

  async log(guildId, content, budget) {
    const channelId = this.getConfig(guildId)?.logChannelId;
    if (!channelId) return;
    await this.rest('POST', `/channels/${channelId}/messages`, {
      body: { content, allowed_mentions: { parse: [] } },
      budget,
    });
  }

  // ---------------------------------------------------------------- RPC from the Worker

  async status() {
    await this.ensureAlarm();
    const fatal = this.getState('fatal');
    let problem = fatal?.message ?? null;
    if (!this.env.DISCORD_TOKEN) problem = 'The DISCORD_TOKEN secret is not set.';
    else if (!this.env.DISCORD_PUBLIC_KEY) problem = "The DISCORD_PUBLIC_KEY secret is not set, so slash commands won't work.";
    else if (!this.ready && !this.identifyAllowed()) problem = 'Too many Discord logins today; paused until tomorrow (UTC).';
    return {
      bot: 'AutoKick',
      connected: this.ready,
      servers: this.sql.exec('SELECT COUNT(*) AS n FROM guilds').toArray()[0].n,
      problem,
      lastChecked: problem && fatal?.checkedAt ? new Date(fatal.checkedAt).toISOString() : undefined,
    };
  }

  async handleCommand(interaction) {
    const budget = new Budget(REQUEST_BUDGET);
    const guildId = interaction.guild_id;
    let reply;
    try {
      if (!guildId) throw new Error('This command only works inside a server.');
      this.ensureConfig(guildId);
      reply = await runCommand(interaction, this.commandApi(guildId, budget));
    } catch (err) {
      console.error('Command failed:', err?.stack ?? err);
      reply = {
        content:
          err instanceof BudgetExceeded
            ? 'This server is too big to check in a single request on the free plan. Try again in a minute.'
            : `Something went wrong: ${err.message}`,
      };
    }
    try {
      await editOriginalReply(interaction, reply);
    } catch (err) {
      console.error('Could not send command reply:', err.message);
    }
    await this.ensureAlarm();
  }

  /** The narrow interface commands.js uses, scoped to one server. */
  commandApi(guildId, budget) {
    return {
      getConfig: () => this.getConfig(guildId),
      saveConfig: (cfg) => this.saveConfig(guildId, cfg),
      assessGuild: () => this.assessGuild(guildId, budget),
      assessMember: (userId) => this.assessMember(guildId, userId, budget),
      detectedPauseRoles: async () => detectedPauseRoleIds(await this.getMeta(guildId, budget)),
      hiddenChannels: () => this.hiddenChannels(guildId, budget),
      log: (content) => this.log(guildId, content, budget),
      nextSweepAt: () => (this.getState('sweepQueue') ? Date.now() : this.getState('nextSweepAt', Date.now())),
      connected: () => this.ready,
      latency: () => (this.ready ? (this.latency ?? null) : null),
      enableGraceMs: ENABLE_GRACE_MS,
    };
  }
}
