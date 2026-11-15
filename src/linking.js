// Linked servers: opt-in sharing of bans, timeouts and chosen roles between
// servers the bot is in. Mixed into AutoKickBot.
//
// - Linking: one server makes a code (/link create), the other redeems it (/link join).
// - Each server chooses per kind whether it sends, receives, both or neither,
//   which roles take part (matched by name), and who is exempt.
// - Gateway handlers only queue jobs (no REST calls there); the alarm runs them.
// - Sharing is one hop: something that arrived from a linked server is never
//   passed on again, so links A-B and B-C don't carry A's bans to C.

import { BudgetExceeded, memberRecord } from './discord.js';
import {
  escapeMarkdown,
  LINK_KINDS,
  linkExempt,
  linkMode,
  linkReceives,
  linkSends,
  linkSettings,
  makeLinkCode,
  normalizeLinkCode,
  roleKey,
  sharedRoleChanges,
} from './policy.js';

const LINK_CODE_MS = 60 * 60_000;
export const LINK_REASON = 'AutoKick link:';
const MARK_MS = 5 * 60_000;
const JOB_MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60_000; // Discord's limit
const UNDO_JOBS = new Set(['unban', 'untimeout']);
const JOB_WHAT = {
  ban: 'ban',
  unban: 'unban',
  timeout: 'timeout',
  untimeout: 'timeout removal',
  role_add: 'role',
  role_remove: 'role removal',
  role_pull: 'role',
};
const JOB_PERMISSION = {
  ban: 'Ban Members',
  unban: 'Ban Members',
  timeout: 'Moderate Members',
  untimeout: 'Moderate Members',
  role_add: 'Manage Roles',
  role_remove: 'Manage Roles',
  role_pull: 'Manage Roles',
};

const unix = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

export const linkMethods = {
  initLinks() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS link_codes (
      code TEXT PRIMARY KEY, guild_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
    // One row per linked pair, smaller ID first.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS links (
      guild_a TEXT NOT NULL, guild_b TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (guild_a, guild_b))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS link_jobs (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, source_guild TEXT NOT NULL, target_guild TEXT NOT NULL,
      user_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    // Bans and timeouts placed here because of a linked server (so they're not passed on, and can be undone).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS linked_bans (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, source_guild TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS linked_timeouts (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, source_guild TEXT NOT NULL, until INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id))`);
    // Which shared roles each member holds, to tell what was added or removed.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS link_role_state (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, roles TEXT NOT NULL, PRIMARY KEY (guild_id, user_id))`);

    this.ownBanMarks = new Map(); // "guild:user" -> when the bot banned/unbanned them itself
    this.expectedRoleChanges = new Map(); // "guild:user:role:+|-" -> when a link job made that change
  },

  // ---------------------------------------------------------------- lookups

  linkedGuilds(guildId) {
    return this.sql
      .exec('SELECT guild_a, guild_b FROM links WHERE guild_a = ? OR guild_b = ?', guildId, guildId)
      .toArray()
      .map((r) => (r.guild_a === guildId ? r.guild_b : r.guild_a));
  },

  areLinked(a, b) {
    const [x, y] = [a, b].sort();
    return this.sql.exec('SELECT 1 FROM links WHERE guild_a = ? AND guild_b = ?', x, y).toArray().length > 0;
  },

  /** Linked servers that should get this kind of event from `guildId`: it sends to them, and they accept from it. */
  linkTargets(guildId, kind, cfg = this.getConfig(guildId)) {
    return this.linkedGuilds(guildId).filter(
      (id) => linkSends(cfg, kind, id) && linkReceives(this.getConfig(id), kind, guildId),
    );
  },

  guildName(guildId) {
    const cached = this.guildCache.get(guildId)?.name;
    if (cached) return cached;
    const row = this.sql.exec('SELECT meta FROM guilds WHERE id = ?', guildId).toArray()[0];
    return (row?.meta && JSON.parse(row.meta).name) || `server ${guildId}`;
  },

  /** A member of that server, or null if they aren't in it. */
  async linkMember(guildId, userId, budget) {
    const cached = this.memberCache.get(guildId)?.members.get(userId);
    if (cached) return cached;
    try {
      return memberRecord(await this.rest('GET', `/guilds/${guildId}/members/${userId}`, { budget }));
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  },

  /** The target server's shared role with the same name, or null. */
  async matchSharedRole(guildId, name, budget) {
    const shared = linkSettings(this.getConfig(guildId)).sharedRoles;
    if (!shared.length) return null;
    const meta = await this.getMeta(guildId, budget);
    return shared.find((id) => roleKey(meta.roles.get(id)?.name) === roleKey(name)) ?? null;
  },

  // ---------------------------------------------------------------- marks (the bot's own changes)

  markOwnBan(guildId, userId) {
    this.ownBanMarks.set(`${guildId}:${userId}`, Date.now());
  },

  recentMark(map, key, consume = false) {
    const at = map.get(key);
    if (at === undefined) return false;
    if (consume || Date.now() - at > MARK_MS) map.delete(key);
    return Date.now() - at <= MARK_MS;
  },

  pruneMarks() {
    const cutoff = Date.now() - MARK_MS;
    for (const map of [this.ownBanMarks, this.expectedRoleChanges]) {
      for (const [key, at] of map) if (at < cutoff) map.delete(key);
    }
  },

  queueLinkJob(kind, source, target, userId, data = {}) {
    this.sql.exec(
      'INSERT INTO link_jobs (kind, source_guild, target_guild, user_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      kind,
      source,
      target,
      userId,
      JSON.stringify(data),
      Date.now(),
    );
  },

  // ---------------------------------------------------------------- gateway events (no REST here)

  onLinkBan(d, banned) {
    const guildId = d.guild_id;
    const user = d.user;
    if (!guildId || !user || user.bot) return;
    if (this.recentMark(this.ownBanMarks, `${guildId}:${user.id}`)) return; // quick-leave, inactivity or link ban
    const username = user.global_name ?? user.username;
    if (banned) {
      const fromLink = this.sql
        .exec('SELECT 1 FROM linked_bans WHERE guild_id = ? AND user_id = ?', guildId, user.id)
        .toArray().length;
      const cfg = this.getConfig(guildId);
      if (fromLink || linkExempt(cfg, user.id)) return;
      for (const target of this.linkTargets(guildId, 'bans', cfg)) {
        this.queueLinkJob('ban', guildId, target, user.id, { username });
      }
      return;
    }
    // Unbanned here. If this was a copy from a linked server, a moderator lifted it: forget it.
    this.sql.exec('DELETE FROM linked_bans WHERE guild_id = ? AND user_id = ?', guildId, user.id);
    // If this server's ban was shared, lift the copies it made.
    const copies = this.sql
      .exec('SELECT guild_id FROM linked_bans WHERE source_guild = ? AND user_id = ?', guildId, user.id)
      .toArray();
    for (const { guild_id: target } of copies) this.queueLinkJob('unban', guildId, target, user.id, { username });
  },

  /** A member's timeout or roles changed. `prevTimeout` is their timeout end before this update (or null). */
  onLinkMemberUpdate(guildId, record, prevTimeout) {
    if (record.bot || !this.linkedGuilds(guildId).length) return;
    const cfg = this.getConfig(guildId);
    if (!cfg) return;
    const now = Date.now();
    const exempt = linkExempt(cfg, record.id, record.roleIds);

    // Timeouts
    const until = record.timeoutUntil > now ? record.timeoutUntil : null;
    if (until !== prevTimeout && !exempt) {
      const copy = this.sql
        .exec('SELECT until FROM linked_timeouts WHERE guild_id = ? AND user_id = ?', guildId, record.id)
        .toArray()[0];
      if (until) {
        const ours = copy && Math.abs(copy.until - until) < 1000; // the timeout a link job just applied
        if (!ours) {
          if (copy) this.sql.exec('DELETE FROM linked_timeouts WHERE guild_id = ? AND user_id = ?', guildId, record.id);
          for (const target of this.linkTargets(guildId, 'timeouts', cfg)) {
            this.queueLinkJob('timeout', guildId, target, record.id, { until, username: record.username });
          }
        }
      } else {
        if (copy) this.sql.exec('DELETE FROM linked_timeouts WHERE guild_id = ? AND user_id = ?', guildId, record.id);
        const copies = this.sql
          .exec('SELECT guild_id FROM linked_timeouts WHERE source_guild = ? AND user_id = ?', guildId, record.id)
          .toArray();
        for (const { guild_id: target } of copies) {
          this.queueLinkJob('untimeout', guildId, target, record.id, { username: record.username });
        }
      }
    }

    // Shared roles
    const { sharedRoles } = linkSettings(cfg);
    if (!sharedRoles.length) return;
    const row = this.sql
      .exec('SELECT roles FROM link_role_state WHERE guild_id = ? AND user_id = ?', guildId, record.id)
      .toArray()[0];
    const before = row ? JSON.parse(row.roles) : [];
    const after = record.roleIds.filter((id) => sharedRoles.includes(id));
    this.saveRoleState(guildId, record.id, after);
    if (exempt) return;
    const { added, removed } = sharedRoleChanges(before, after, sharedRoles);
    const targets = this.linkTargets(guildId, 'roles', cfg);
    for (const [roleId, op] of [...added.map((id) => [id, '+']), ...removed.map((id) => [id, '-'])]) {
      // Made by a link job (copied from another server): don't pass it on.
      if (this.recentMark(this.expectedRoleChanges, `${guildId}:${record.id}:${roleId}:${op}`, true)) continue;
      for (const target of targets) {
        this.queueLinkJob(op === '+' ? 'role_add' : 'role_remove', guildId, target, record.id, { roleId });
      }
    }
  },

  /** Someone joined: copy shared roles they have in linked servers. */
  onLinkJoin(guildId, record) {
    if (record.bot) return;
    const cfg = this.getConfig(guildId);
    const { sharedRoles } = linkSettings(cfg);
    const held = record.roleIds.filter((id) => sharedRoles.includes(id));
    if (held.length) this.saveRoleState(guildId, record.id, held);
    if (linkExempt(cfg, record.id, record.roleIds)) return;
    for (const source of this.linkedGuilds(guildId)) {
      if (linkReceives(cfg, 'roles', source) && linkSends(this.getConfig(source), 'roles', guildId)) {
        this.queueLinkJob('role_pull', source, guildId, record.id, {});
      }
    }
  },

  saveRoleState(guildId, userId, roles) {
    if (roles.length) {
      this.sql.exec(
        'INSERT OR REPLACE INTO link_role_state (guild_id, user_id, roles) VALUES (?, ?, ?)',
        guildId,
        userId,
        JSON.stringify(roles),
      );
    } else {
      this.sql.exec('DELETE FROM link_role_state WHERE guild_id = ? AND user_id = ?', guildId, userId);
    }
  },

  forgetMemberLinks(guildId, userId) {
    this.sql.exec('DELETE FROM link_role_state WHERE guild_id = ? AND user_id = ?', guildId, userId);
    this.sql.exec('DELETE FROM linked_timeouts WHERE guild_id = ? AND user_id = ?', guildId, userId);
  },

  /** Forget `guildId`'s per-server share settings for `otherId`. */
  dropLinkOverrides(guildId, otherId) {
    const cfg = this.getConfig(guildId);
    if (!cfg?.link?.servers?.[otherId]) return;
    delete cfg.link.servers[otherId];
    this.saveConfig(guildId, cfg);
  },

  forgetGuildLinks(guildId) {
    for (const other of this.linkedGuilds(guildId)) this.dropLinkOverrides(other, guildId);
    this.sql.exec('DELETE FROM links WHERE guild_a = ? OR guild_b = ?', guildId, guildId);
    this.sql.exec('DELETE FROM link_codes WHERE guild_id = ?', guildId);
    this.sql.exec('DELETE FROM link_jobs WHERE source_guild = ? OR target_guild = ?', guildId, guildId);
    this.sql.exec('DELETE FROM linked_bans WHERE guild_id = ? OR source_guild = ?', guildId, guildId);
    this.sql.exec('DELETE FROM linked_timeouts WHERE guild_id = ? OR source_guild = ?', guildId, guildId);
    this.sql.exec('DELETE FROM link_role_state WHERE guild_id = ?', guildId);
  },

  // ---------------------------------------------------------------- jobs (run from the alarm)

  async runLinkJobs(budget) {
    const now = Date.now();
    this.pruneMarks();
    this.sql.exec('DELETE FROM link_codes WHERE expires_at < ?', now);
    this.sql.exec('DELETE FROM link_jobs WHERE created_at < ?', now - JOB_MAX_AGE_MS);
    const jobs = this.sql
      .exec('SELECT id, kind, source_guild, target_guild, user_id, data FROM link_jobs ORDER BY id LIMIT 50')
      .toArray();
    for (const job of jobs) {
      if (budget.remaining < 8) return;
      const done = () => this.sql.exec('DELETE FROM link_jobs WHERE id = ?', job.id);
      // Unlinked since it was queued: drop it. Undoing earlier copies still goes ahead.
      if (!UNDO_JOBS.has(job.kind) && !this.areLinked(job.source_guild, job.target_guild)) {
        done();
        continue;
      }
      try {
        await this.runLinkJob(job, JSON.parse(job.data), budget);
        done();
      } catch (err) {
        if (err instanceof BudgetExceeded) return; // the rest next minute
        if (err.status >= 500 || err.status === 429 || !err.status) {
          console.warn(`Link job ${job.kind} will be retried: ${err.message}`);
          continue;
        }
        done();
        console.warn(`Link job ${job.kind} for ${job.user_id} in ${job.target_guild} failed: ${err.message}`);
        const why =
          err.status === 403
            ? `I need **${JOB_PERMISSION[job.kind]}**, and my role has to be above theirs.`
            : err.message;
        await this.logSafely(
          job.target_guild,
          `⚠️ Couldn't apply a ${JOB_WHAT[job.kind]} from **${escapeMarkdown(this.guildName(job.source_guild))}** ` +
            `to <@${job.user_id}>: ${why}`,
          budget,
        );
      }
    }
  },

  async runLinkJob(job, data, budget) {
    const { source_guild: source, target_guild: target, user_id: userId } = job;
    const tcfg = this.getConfig(target);
    if (!tcfg) return;
    const sourceName = escapeMarkdown(this.guildName(source));
    const who = `<@${userId}>${data.username ? ` (**${escapeMarkdown(data.username)}**)` : ''}`;

    switch (job.kind) {
      case 'ban': {
        if (!linkReceives(tcfg, 'bans', source) || linkExempt(tcfg, userId)) return;
        const meta = await this.getMeta(target, budget);
        if (userId === meta.ownerId) return;
        const member = await this.linkMember(target, userId, budget);
        if (member && (member.bot || linkExempt(tcfg, userId, member.roleIds))) return;
        if (await this.findBan(target, userId, budget)) return; // already banned there
        // The original's reason. If the bot can't read bans there (no Ban Members), copy it without one.
        const sourceBan = await this.findBan(source, userId, budget).catch((err) => {
          if (err instanceof BudgetExceeded) throw err;
          return { reason: null };
        });
        if (!sourceBan) return; // lifted again before this ran
        const why = sourceBan.reason ? `: ${sourceBan.reason}` : '';
        // Recorded first, so the ban event it causes here isn't passed on.
        this.sql.exec(
          'INSERT OR REPLACE INTO linked_bans (guild_id, user_id, source_guild, at) VALUES (?, ?, ?, ?)',
          target,
          userId,
          source,
          Date.now(),
        );
        try {
          await this.rest('PUT', `/guilds/${target}/bans/${userId}`, {
            body: { delete_message_seconds: 0 },
            reason: `${LINK_REASON} banned in ${this.guildName(source)}${why}`.slice(0, 500),
            budget,
          });
        } catch (err) {
          this.sql.exec('DELETE FROM linked_bans WHERE guild_id = ? AND user_id = ?', target, userId);
          throw err;
        }
        await this.logSafely(
          target,
          `🔗 Banned ${who}: they were banned in **${sourceName}**` +
            (sourceBan.reason ? ` (${escapeMarkdown(sourceBan.reason).slice(0, 300)})` : '') +
            '.',
          budget,
        );
        return;
      }

      case 'unban': {
        const copy = this.sql
          .exec('SELECT source_guild FROM linked_bans WHERE guild_id = ? AND user_id = ?', target, userId)
          .toArray()[0];
        if (copy?.source_guild !== source) return;
        this.sql.exec('DELETE FROM linked_bans WHERE guild_id = ? AND user_id = ?', target, userId);
        const ban = await this.findBan(target, userId, budget);
        if (!ban?.reason?.startsWith(LINK_REASON)) return; // already lifted, or replaced by a moderator's own ban
        this.markOwnBan(target, userId);
        await this.rest('DELETE', `/guilds/${target}/bans/${userId}`, {
          reason: `${LINK_REASON} unbanned in ${this.guildName(source)}`,
          budget,
        });
        await this.logSafely(target, `🔗 Unbanned ${who}: their ban in **${sourceName}** was lifted.`, budget);
        return;
      }

      case 'timeout': {
        if (!linkReceives(tcfg, 'timeouts', source) || linkExempt(tcfg, userId)) return;
        const member = await this.linkMember(target, userId, budget);
        if (!member || member.bot || linkExempt(tcfg, userId, member.roleIds)) return;
        const meta = await this.getMeta(target, budget);
        if (userId === meta.ownerId) return;
        const until = Math.min(data.until, Date.now() + MAX_TIMEOUT_MS - 60_000);
        if (until <= Date.now() || (member.timeoutUntil ?? 0) >= until) return; // over, or already timed out longer
        this.sql.exec(
          'INSERT OR REPLACE INTO linked_timeouts (guild_id, user_id, source_guild, until) VALUES (?, ?, ?, ?)',
          target,
          userId,
          source,
          until,
        );
        try {
          await this.rest('PATCH', `/guilds/${target}/members/${userId}`, {
            body: { communication_disabled_until: new Date(until).toISOString() },
            reason: `${LINK_REASON} timed out in ${this.guildName(source)}`,
            budget,
          });
        } catch (err) {
          this.sql.exec('DELETE FROM linked_timeouts WHERE guild_id = ? AND user_id = ?', target, userId);
          throw err;
        }
        await this.logSafely(
          target,
          `🔗 Timed out ${who} until ${unix(until, 'f')}: they were timed out in **${sourceName}**.`,
          budget,
        );
        return;
      }

      case 'untimeout': {
        const copy = this.sql
          .exec('SELECT source_guild, until FROM linked_timeouts WHERE guild_id = ? AND user_id = ?', target, userId)
          .toArray()[0];
        if (copy?.source_guild !== source) return;
        this.sql.exec('DELETE FROM linked_timeouts WHERE guild_id = ? AND user_id = ?', target, userId);
        const member = await this.linkMember(target, userId, budget);
        // Gone, already over, or changed by a moderator since: leave it.
        if (!member?.timeoutUntil || Math.abs(member.timeoutUntil - copy.until) >= 1000) return;
        await this.rest('PATCH', `/guilds/${target}/members/${userId}`, {
          body: { communication_disabled_until: null },
          reason: `${LINK_REASON} timeout lifted in ${this.guildName(source)}`,
          budget,
        });
        await this.logSafely(target, `🔗 Lifted ${who}'s timeout: it was lifted in **${sourceName}**.`, budget);
        return;
      }

      case 'role_add':
      case 'role_remove': {
        const add = job.kind === 'role_add';
        if (!linkReceives(tcfg, 'roles', source) || linkExempt(tcfg, userId)) return;
        if (!linkSettings(this.getConfig(source)).sharedRoles.includes(data.roleId)) return;
        const sourceRole = (await this.getMeta(source, budget)).roles.get(data.roleId);
        if (!sourceRole) return;
        const roleId = await this.matchSharedRole(target, sourceRole.name, budget);
        if (!roleId) return;
        const member = await this.linkMember(target, userId, budget);
        if (!member || member.bot || linkExempt(tcfg, userId, member.roleIds)) return;
        if (member.roleIds.includes(roleId) === add) return; // already that way
        await this.changeLinkedRole(target, userId, roleId, add, source, budget);
        return;
      }

      case 'role_pull': {
        // They joined `target`: give them the shared roles they have in `source`.
        const scfg = this.getConfig(source);
        if (!linkReceives(tcfg, 'roles', source) || !linkSends(scfg, 'roles', target)) return;
        const shared = linkSettings(scfg).sharedRoles;
        if (!shared.length) return;
        const sourceMember = await this.linkMember(source, userId, budget);
        if (!sourceMember) return;
        const member = await this.linkMember(target, userId, budget);
        if (!member || member.bot || linkExempt(tcfg, userId, member.roleIds)) return;
        const sourceMeta = await this.getMeta(source, budget);
        for (const id of sourceMember.roleIds.filter((r) => shared.includes(r))) {
          const roleId = await this.matchSharedRole(target, sourceMeta.roles.get(id)?.name, budget);
          if (roleId && !member.roleIds.includes(roleId)) {
            await this.changeLinkedRole(target, userId, roleId, true, source, budget);
          }
        }
        return;
      }
    }
  },

  async changeLinkedRole(guildId, userId, roleId, add, source, budget) {
    // Marked first, so the member update it causes isn't passed on.
    this.expectedRoleChanges.set(`${guildId}:${userId}:${roleId}:${add ? '+' : '-'}`, Date.now());
    await this.rest(add ? 'PUT' : 'DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      reason: `${LINK_REASON} role ${add ? 'given' : 'removed'} in ${this.guildName(source)}`,
      budget,
    });
  },

  // ---------------------------------------------------------------- commands

  createLinkCode(guildId) {
    this.sql.exec('DELETE FROM link_codes WHERE guild_id = ?', guildId);
    let code = makeLinkCode();
    while (this.sql.exec('SELECT 1 FROM link_codes WHERE code = ?', code).toArray().length) code = makeLinkCode();
    const expiresAt = Date.now() + LINK_CODE_MS;
    this.sql.exec('INSERT INTO link_codes (code, guild_id, expires_at) VALUES (?, ?, ?)', code, guildId, expiresAt);
    return { code, expiresAt };
  },

  async joinLink(guildId, input, userId, budget) {
    const code = normalizeLinkCode(input);
    const row = this.sql.exec('SELECT guild_id, expires_at FROM link_codes WHERE code = ?', code).toArray()[0];
    if (!row || row.expires_at < Date.now()) return { error: 'invalid' };
    const other = row.guild_id;
    if (other === guildId) return { error: 'self' };
    if (!this.getConfig(other)) {
      this.sql.exec('DELETE FROM link_codes WHERE code = ?', code);
      return { error: 'gone' };
    }
    const name = this.guildName(other);
    if (this.areLinked(guildId, other)) return { error: 'already', name };
    const [a, b] = [guildId, other].sort();
    this.sql.exec('INSERT INTO links (guild_a, guild_b, created_at) VALUES (?, ?, ?)', a, b, Date.now());
    this.sql.exec('DELETE FROM link_codes WHERE code = ?', code);
    const here = escapeMarkdown(this.guildName(guildId));
    await this.logSafely(
      other,
      `🔗 Linked with **${here}** (they used this server's code). Nothing is shared until you choose with \`/link share\`.`,
      budget,
    ).catch(() => {});
    await this.logSafely(guildId, `🔗 Linked with **${escapeMarkdown(name)}** by <@${userId}>.`, budget).catch(() => {});
    return { id: other, name };
  },

  /** Linked servers, with what each one sends/accepts toward this server (`theirs`, a mode per kind). */
  linkList(guildId) {
    return this.linkedGuilds(guildId).map((id) => {
      const cfg = this.getConfig(id);
      return {
        id,
        name: this.guildName(id),
        theirs: Object.fromEntries(LINK_KINDS.map((kind) => [kind, linkMode(cfg, kind, guildId)])),
      };
    });
  },

  async unlink(guildId, query, userId, budget) {
    const q = String(query ?? '').trim();
    const match = this.linkList(guildId).find((l) => l.id === q || l.name.toLowerCase() === q.toLowerCase());
    if (!match) return null;
    const [a, b] = [guildId, match.id].sort();
    this.sql.exec('DELETE FROM links WHERE guild_a = ? AND guild_b = ?', a, b);
    this.dropLinkOverrides(guildId, match.id);
    this.dropLinkOverrides(match.id, guildId);
    this.sql.exec(
      `DELETE FROM link_jobs WHERE kind NOT IN ('unban', 'untimeout') AND
       ((source_guild = ? AND target_guild = ?) OR (source_guild = ? AND target_guild = ?))`,
      guildId,
      match.id,
      match.id,
      guildId,
    );
    await this.logSafely(match.id, `🔗 **${escapeMarkdown(this.guildName(guildId))}** unlinked from this server.`, budget).catch(
      () => {},
    );
    await this.logSafely(guildId, `🔗 Unlinked from **${escapeMarkdown(match.name)}** by <@${userId}>.`, budget).catch(() => {});
    return match;
  },

  /** For each shared role here: the linked servers that share a role with the same name. */
  async linkRoleMatches(guildId, budget) {
    const { sharedRoles } = linkSettings(this.getConfig(guildId));
    const meta = await this.getMeta(guildId, budget);
    const linked = this.linkedGuilds(guildId);
    const others = [];
    for (const id of linked) {
      const shared = linkSettings(this.getConfig(id)).sharedRoles;
      const otherMeta = shared.length ? await this.getMeta(id, budget).catch(() => null) : null;
      others.push({ name: this.guildName(id), keys: new Set(shared.map((r) => roleKey(otherMeta?.roles.get(r)?.name))) });
    }
    return sharedRoles.map((roleId) => {
      const name = meta.roles.get(roleId)?.name ?? null;
      return { roleId, name, servers: others.filter((o) => name && o.keys.has(roleKey(name))).map((o) => o.name) };
    });
  },

  /** Record who already has a newly shared role, so later removals can be told apart. */
  async seedSharedRole(guildId, roleId, budget) {
    const { members } = await this.loadGuild(guildId, budget);
    for (const member of members.values()) {
      if (!member.roleIds.includes(roleId)) continue;
      const row = this.sql
        .exec('SELECT roles FROM link_role_state WHERE guild_id = ? AND user_id = ?', guildId, member.id)
        .toArray()[0];
      const roles = new Set(row ? JSON.parse(row.roles) : []);
      roles.add(roleId);
      this.saveRoleState(guildId, member.id, [...roles]);
    }
  },
};
