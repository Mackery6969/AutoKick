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
 * Inactive time between `lastActive` and `now`, minus any time the bot was
 * offline. Activity during an outage can't be seen, so it isn't held against anyone.
 * `downtime` is a list of non-overlapping [start, end] timestamps.
 */
export function observedInactiveMs(lastActive, now, downtime = []) {
  let ms = now - lastActive;
  for (const [start, end] of downtime) {
    const overlap = Math.min(end, now) - Math.max(start, lastActive);
    if (overlap > 0) ms -= overlap;
  }
  return Math.max(0, ms);
}

/**
 * Assess one member. `member` is a plain snapshot:
 *   { id, bot, isOwner, kickable, roleIds, joinedTimestamp }
 *
 * Returns an object whose `action` is one of:
 *   'kick'      - past the limit and the bot is able to kick them
 *   'blocked'   - past the limit, but the bot's role is too low / lacks permission
 *   'keep'      - still within the limit
 *   'protected' - covered by the whitelist
 *   'skip'      - bots and the server owner are never kicked
 */
export function assess(member, cfg, { now, downtime }) {
  const lastActive = lastActiveAt(cfg, member.id, member.joinedTimestamp);
  const inactiveMs = observedInactiveMs(lastActive, now, downtime);
  const thresholdMs = cfg.days * DAY_MS;
  const base = { lastActive, inactiveMs, thresholdMs, recorded: member.id in cfg.activity };

  if (member.bot) return { ...base, action: 'skip', reason: 'bot' };
  if (member.isOwner) return { ...base, action: 'skip', reason: 'server owner' };

  const list = listVerdict(cfg, member.id, member.roleIds);
  if (list.protected) {
    return { ...base, action: 'protected', reason: list.reason, roleId: list.roleId };
  }
  if (inactiveMs < thresholdMs) {
    return { ...base, action: 'keep', reason: 'active', remainingMs: thresholdMs - inactiveMs };
  }
  if (!member.kickable) {
    return { ...base, action: 'blocked', reason: 'role is above the bot or bot lacks Kick Members' };
  }
  return { ...base, action: 'kick', reason: list.reason ?? 'inactive' };
}

export const escapeMarkdown = (text) => String(text).replace(/[\\*_`~|>]/g, '\\$&');

export function formatDuration(ms) {
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return 'less than an hour';
}
