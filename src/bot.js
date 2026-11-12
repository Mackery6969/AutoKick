// The always-on part of the bot: one Durable Object that stays connected to the
// Discord gateway, records activity in its SQLite storage, and kicks members who
// have been inactive too long.
//
// Free-plan rule that shapes this file: each invocation (an alarm, or one slash
// command) may make at most 50 outbound requests. So gateway event handlers
// never call the Discord REST API; they only write to storage. All REST calls
// happen in alarm() or handleCommand(), each with its own request Budget.

import { DurableObject } from 'cloudflare:workers';
import { assess, DAY_MS, escapeMarkdown, formatDuration } from './policy.js';
import {
  APP_FLAGS_MEMBERS_INTENT,
  Budget,
  BudgetExceeded,
  canKick,
  discordRest,
  editOriginalReply,
  guildMeta,
  INTENTS,
  memberRecord,
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
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id))`);

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
    this.guildCache = new Map(); // guildId -> guildMeta (roles, owner, AFK channel)
    this.memberCache = new Map(); // guildId -> { fetchedAt, members: Map<userId, record> }
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

  touch(guildId, userId, ts = Date.now()) {
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

  /** Everyone sitting in a voice channel (other than the AFK channel) counts as active right now. */
  touchVoice(onlyGuildId = null) {
    const rows = onlyGuildId
      ? this.sql.exec('SELECT guild_id, user_id, channel_id FROM voice WHERE guild_id = ?', onlyGuildId).toArray()
      : this.sql.exec('SELECT guild_id, user_id, channel_id FROM voice').toArray();
    const now = Date.now();
    for (const row of rows) {
      if (row.channel_id !== this.afkChannel(row.guild_id)) this.touch(row.guild_id, row.user_id, now);
    }
  }

  activityMap(guildId) {
    const rows = this.sql.exec('SELECT user_id, last_active FROM activity WHERE guild_id = ?', guildId).toArray();
    return Object.fromEntries(rows.map((r) => [r.user_id, r.last_active]));
  }

  forgetMember(guildId, userId) {
    this.sql.exec('DELETE FROM activity WHERE guild_id = ? AND user_id = ?', guildId, userId);
    this.sql.exec('DELETE FROM voice WHERE guild_id = ? AND user_id = ?', guildId, userId);
    this.lastWrite.delete(`${guildId}:${userId}`);
    this.memberCache.get(guildId)?.members.delete(userId);
  }

  forgetGuild(guildId) {
    this.sql.exec('DELETE FROM guilds WHERE id = ?', guildId);
    this.sql.exec('DELETE FROM activity WHERE guild_id = ?', guildId);
    this.sql.exec('DELETE FROM voice WHERE guild_id = ?', guildId);
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
      case 'GUILD_ROLE_UPDATE':
      case 'GUILD_ROLE_DELETE':
        this.guildCache.delete(d.guild_id); // re-fetched the next time it's needed
        return;
      case 'GUILD_MEMBER_ADD':
      case 'GUILD_MEMBER_UPDATE':
        this.memberCache.get(d.guild_id)?.members.set(d.user.id, memberRecord(d));
        return;
      case 'GUILD_MEMBER_REMOVE':
        return this.forgetMember(d.guild_id, d.user.id);
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

    // Replace the voice snapshot for this server.
    this.sql.exec('DELETE FROM voice WHERE guild_id = ?', d.id);
    for (const vs of d.voice_states ?? []) {
      if (vs.channel_id) {
        this.sql.exec('INSERT INTO voice (guild_id, user_id, channel_id) VALUES (?, ?, ?)', d.id, vs.user_id, vs.channel_id);
      }
    }
    this.touchVoice(d.id);
  }

  onMessage(d) {
    if (!d.guild_id || d.author?.bot || d.webhook_id || !COUNTED_MESSAGE_TYPES.has(d.type)) return;
    this.touch(d.guild_id, d.author.id);
  }

  onVoiceState(d) {
    if (!d.guild_id || d.member?.user?.bot) return;
    const prev =
      this.sql.exec('SELECT channel_id FROM voice WHERE guild_id = ? AND user_id = ?', d.guild_id, d.user_id).toArray()[0]
        ?.channel_id ?? null;
    const afk = this.afkChannel(d.guild_id);
    const counts = (channelId) => Boolean(channelId) && channelId !== afk;

    // Joining, leaving or switching channels all count as being in voice.
    if (counts(prev) || counts(d.channel_id)) this.touch(d.guild_id, d.user_id);

    if (prev === d.channel_id) return; // mute/deafen changes only
    if (d.channel_id) {
      this.sql.exec(
        `INSERT INTO voice (guild_id, user_id, channel_id) VALUES (?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id = excluded.channel_id`,
        d.guild_id,
        d.user_id,
        d.channel_id,
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

  async loadGuild(guildId, budget) {
    let meta = this.guildCache.get(guildId);
    if (!meta) {
      meta = guildMeta(await this.rest('GET', `/guilds/${guildId}`, { budget }));
      this.guildCache.set(guildId, meta);
    }
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

  assessWith(cfg, meta, botMember, member, ctx) {
    const snapshot = { ...member, isOwner: member.id === meta.ownerId, kickable: canKick(meta, botMember, member) };
    return assess(snapshot, cfg, ctx);
  }

  async assessGuild(guildId, budget) {
    const cfg = this.ensureConfig(guildId);
    const { meta, members } = await this.loadGuild(guildId, budget);
    this.touchVoice(guildId);
    const botMember = members.get(this.getState('botId'));
    const full = { ...cfg, activity: this.activityMap(guildId) };
    const ctx = { now: Date.now(), downtime: this.getState('downtime', []) };
    const results = [...members.values()].map((member) => ({
      member,
      result: this.assessWith(full, meta, botMember, member, ctx),
    }));
    return { cfg, meta, botMember, results };
  }

  async assessMember(guildId, userId, budget) {
    const cfg = this.ensureConfig(guildId);
    const { meta, members } = await this.loadGuild(guildId, budget);
    const member = members.get(userId);
    if (!member) return null;
    this.touchVoice(guildId);
    const full = { ...cfg, activity: this.activityMap(guildId) };
    const ctx = { now: Date.now(), downtime: this.getState('downtime', []) };
    return { member, result: this.assessWith(full, meta, members.get(this.getState('botId')), member, ctx) };
  }

  async runSweeps(budget) {
    let queue = this.getState('sweepQueue');
    if (!queue) {
      const now = Date.now();
      if (now < this.getState('nextSweepAt', 0)) return;
      this.setState('nextSweepAt', now + SWEEP_INTERVAL_MS);
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
      log: (content) => this.log(guildId, content, budget),
      nextSweepAt: () => (this.getState('sweepQueue') ? Date.now() : this.getState('nextSweepAt', Date.now())),
      connected: () => this.ready,
      latency: () => (this.ready ? (this.latency ?? null) : null),
      enableGraceMs: ENABLE_GRACE_MS,
    };
  }
}
