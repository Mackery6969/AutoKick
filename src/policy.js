// Pure decision logic: no Discord objects in here, so it can be unit tested.

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decide whether the whitelist/blacklist protects a member.
 *
 * The most specific rule wins:
 *   1. Member is whitelisted         -> protected
 *   2. Member is blacklisted         -> not protected
 *   3. Member has a blacklisted role -> not protected (beats whitelisted roles)
 *   4. Member has a whitelisted role -> protected
 *   5. Otherwise                     -> not protected (normal inactivity rules apply)
 */
export function listVerdict(cfg, userId, roleIds) {
  if (cfg.whitelist.users.includes(userId)) {
    return { protected: true, reason: 'whitelisted member' };
  }
  if (cfg.blacklist.users.includes(userId)) {
    return { protected: false, reason: 'blacklisted member' };
  }
  const blacklistedRole = cfg.blacklist.roles.find((id) => roleIds.includes(id));
  if (blacklistedRole) {
    return { protected: false, reason: 'blacklisted role', roleId: blacklistedRole };
  }
  const whitelistedRole = cfg.whitelist.roles.find((id) => roleIds.includes(id));
  if (whitelistedRole) {
    return { protected: true, reason: 'whitelisted role', roleId: whitelistedRole };
  }
  return { protected: false, reason: null };
}

/**
 * When the member's inactivity clock starts. Members with no recorded activity
 * start from whichever is later: when the bot began tracking this server, or
 * when they joined. Nobody is judged on time the bot wasn't watching.
 */
export function lastActiveAt(cfg, userId, joinedTimestamp) {
  return Math.max(cfg.activity[userId] ?? 0, cfg.trackingSince ?? 0, joinedTimestamp ?? 0);
}

/**
 * Does being in this voice state count as activity? Not in the AFK channel,
 * and not while deafened (by themselves or a moderator). Just muted still counts.
 */
export function countsAsVoice(channelId, deafened, afkChannelId) {
  return Boolean(channelId) && channelId !== afkChannelId && !deafened;
}

/** Sort and merge overlapping [start, end] intervals so overlaps aren't subtracted twice. */
export function mergeIntervals(intervals) {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Inactive time between `lastActive` and `now`, minus time that isn't held
 * against the member: periods when the bot was offline (it couldn't see their
 * activity) and periods when they were muted (they couldn't be active).
 * `excluded` is a list of [start, end] timestamps; overlaps are fine.
 */
export function observedInactiveMs(lastActive, now, excluded = []) {
  let ms = now - lastActive;
  for (const [start, end] of mergeIntervals(excluded)) {
    const overlap = Math.min(end, now) - Math.max(start, lastActive);
    if (overlap > 0) ms -= overlap;
  }
  return Math.max(0, ms);
}

/**
 * Assess one member. `member` is a plain snapshot:
 *   { id, bot, isOwner, kickable, roleIds, joinedTimestamp, pauses?, pausedBy? }
 * `pauses` are this member's muted periods as [start, end]; `pausedBy` is set
 * ('timeout' or 'role') when they are muted right now.
 *
 * Returns an object whose `action` is one of:
 *   'kick'      - past the limit and the bot is able to kick them
 *   'blocked'   - past the limit, but the bot's role is too low / lacks permission
 *   'keep'      - still within the limit
 *   'paused'    - muted right now, so their clock is stopped and they can't be kicked
 *   'protected' - covered by the whitelist
 *   'skip'      - bots and the server owner are never kicked
 */
export function assess(member, cfg, { now, downtime }) {
  const lastActive = lastActiveAt(cfg, member.id, member.joinedTimestamp);
  const inactiveMs = observedInactiveMs(lastActive, now, [...downtime, ...(member.pauses ?? [])]);
  const pausedMs = observedInactiveMs(lastActive, now, downtime) - inactiveMs;
  const thresholdMs = cfg.days * DAY_MS;
  const base = { lastActive, inactiveMs, pausedMs, thresholdMs, recorded: member.id in cfg.activity };

  if (member.bot) return { ...base, action: 'skip', reason: 'bot' };
  if (member.isOwner) return { ...base, action: 'skip', reason: 'server owner' };

  const list = listVerdict(cfg, member.id, member.roleIds);
  if (list.protected) {
    return { ...base, action: 'protected', reason: list.reason, roleId: list.roleId };
  }
  if (member.pausedBy) {
    return { ...base, action: 'paused', reason: member.pausedBy, remainingMs: Math.max(0, thresholdMs - inactiveMs) };
  }
  if (inactiveMs < thresholdMs) {
    return { ...base, action: 'keep', reason: 'active', remainingMs: thresholdMs - inactiveMs };
  }
  if (!member.kickable) {
    return { ...base, action: 'blocked', reason: 'role is above the bot or bot lacks Kick Members' };
  }
  return { ...base, action: 'kick', reason: list.reason ?? 'inactive' };
}

/**
 * What to record after looking at a member's current mute state.
 *   rows       their stored muted periods: { id, kind: 'timeout'|'role', started_at, ended_at|null }
 *   member     { timeoutUntil, roleIds }
 *   pauseRoles Set of role ids that pause the clock, or null if unknown (then roles are left alone)
 * Returns a list of { insert: { kind, start, end } } and { update: { id, end } }.
 */
export function pauseChanges(rows, member, pauseRoles, now) {
  const ops = [];
  // Timeouts come with an end time. Extended or shortened: move the end. Lifted early: end now.
  const timeout = rows.find((r) => r.kind === 'timeout' && r.ended_at > now);
  if (member.timeoutUntil > now) {
    if (!timeout) ops.push({ insert: { kind: 'timeout', start: now, end: member.timeoutUntil } });
    else if (timeout.ended_at !== member.timeoutUntil) ops.push({ update: { id: timeout.id, end: member.timeoutUntil } });
  } else if (timeout) {
    ops.push({ update: { id: timeout.id, end: now } });
  }
  // Pause roles: open a period when one is given, close it when the last one is taken away.
  if (pauseRoles) {
    const open = rows.find((r) => r.kind === 'role' && r.ended_at === null);
    const hasRole = member.roleIds.some((id) => pauseRoles.has(id));
    if (hasRole && !open) ops.push({ insert: { kind: 'role', start: now, end: null } });
    else if (!hasRole && open) ops.push({ update: { id: open.id, end: now } });
  }
  return ops;
}

export const escapeMarkdown = (text) => String(text).replace(/[\\*_`~|>]/g, '\\$&');

export function formatDuration(ms) {
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return 'less than an hour';
}
