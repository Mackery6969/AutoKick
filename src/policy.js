// Pure decision logic: no Discord objects in here, so it can be unit tested.

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decide whether the member lists protect a member. The blacklist is left out
 * of inactivity kicks; the whitelist can be kicked even with a blacklisted role.
 *
 * The most specific rule wins:
 *   1. Member is blacklisted         -> protected
 *   2. Member is whitelisted         -> not protected
 *   3. Member has a whitelisted role -> not protected (beats blacklisted roles)
 *   4. Member has a blacklisted role -> protected
 *   5. Otherwise                     -> not protected (normal inactivity rules apply)
 */
export function listVerdict(cfg, userId, roleIds) {
  if (cfg.blacklist.users.includes(userId)) {
    return { protected: true, reason: 'blacklisted member' };
  }
  if (cfg.whitelist.users.includes(userId)) {
    return { protected: false, reason: 'whitelisted member' };
  }
  const whitelistedRole = cfg.whitelist.roles.find((id) => roleIds.includes(id));
  if (whitelistedRole) {
    return { protected: false, reason: 'whitelisted role', roleId: whitelistedRole };
  }
  const blacklistedRole = cfg.blacklist.roles.find((id) => roleIds.includes(id));
  if (blacklistedRole) {
    return { protected: true, reason: 'blacklisted role', roleId: blacklistedRole };
  }
  return { protected: false, reason: null };
}

/**
 * A stored config from before the member lists swapped meaning (whitelist used to
 * be "never kicked"), with its lists swapped so every entry keeps doing what it did.
 */
export function swapMemberLists(cfg) {
  const empty = () => ({ roles: [], users: [] });
  return { ...cfg, whitelist: cfg.blacklist ?? empty(), blacklist: cfg.whitelist ?? empty() };
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
 * Does activity in this channel count? `chain` is the channel followed by its
 * parents, most specific first: thread → channel → category.
 * The most specific listed entry wins, so a whitelisted channel inside a
 * blacklisted category counts, and a blacklisted channel inside a whitelisted
 * category doesn't. If nothing in the chain is listed: counts unless a channel
 * whitelist exists (then only whitelisted places count).
 */
export function channelCounts(cfg, chain) {
  const { whitelist = [], blacklist = [] } = cfg?.channels ?? {};
  for (const id of chain) {
    if (blacklist.includes(id)) return false;
    if (whitelist.includes(id)) return true;
  }
  return whitelist.length === 0;
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
 * What happens to a member once they're past the limit:
 *   type 'kick' (default), 'role' (give `give` roles, take `take` roles; undone when
 *   they're active again), 'tempban' (banned for `banDays`, then unbanned), or
 *   'softban' (banned and unbanned right away, which deletes their recent messages).
 */
export function actionOf(cfg) {
  return { type: 'kick', banDays: 7, give: [], take: [], ...(cfg?.action ?? {}) };
}

/** "Will be ___": a short word for each action. */
export const ACTION_DONE = { kick: 'kicked', tempban: 'banned', softban: 'soft-banned', role: 'marked inactive' };

/** How long before a kick members get a warning DM, or 0 when warnings are off. */
export function warningMs(cfg) {
  const days = cfg.warnDays ?? 0;
  return days > 0 && days < cfg.days ? days * DAY_MS : 0;
}

/**
 * Assess one member. `member` is a plain snapshot:
 *   { id, bot, isOwner, kickable, roleIds, joinedTimestamp, pauses?, pausedBy?, warning?, marked? }
 * `kickable` means the bot is able to carry out the configured action on them.
 * `pauses` are this member's muted periods as [start, end]; `pausedBy` is set
 * ('timeout' or 'role') when they are muted right now. `warning` is the last
 * warning DM sent to them: { at, kickAfter, delivered }. `marked` is set when
 * the role action was applied to them: { at }.
 *
 * Returns an object whose `action` is one of:
 *   'kick'      - past the limit (and any warning period): carry out the action now
 *                 (kick, roles, temp ban or soft ban; the name is kept from when kicking was the only one)
 *   'done'      - the role action was already applied and they haven't been active since
 *   'blocked'   - past the limit, but the bot's role is too low / lacks permission
 *   'keep'      - still within the limit (reason 'active'), or past it but still
 *                 inside the notice their warning DM gave them (reason 'notice')
 *   'paused'    - muted right now, so their clock is stopped and they can't be kicked
 *   'protected' - covered by the blacklist (left out of inactivity kicks)
 *   'skip'      - bots and the server owner are never kicked
 * `warnNow` is true when a warning DM should be sent now.
 */
export function assess(member, cfg, { now, downtime }) {
  const lastActive = lastActiveAt(cfg, member.id, member.joinedTimestamp);
  const inactiveMs = observedInactiveMs(lastActive, now, [...downtime, ...(member.pauses ?? [])]);
  const pausedMs = observedInactiveMs(lastActive, now, downtime) - inactiveMs;
  const thresholdMs = cfg.days * DAY_MS;
  // A warning only counts for the stretch of inactivity it was sent in.
  const warning = member.warning && member.warning.at >= lastActive ? member.warning : null;
  const base = {
    lastActive,
    inactiveMs,
    pausedMs,
    thresholdMs,
    recorded: member.id in cfg.activity,
    kickable: Boolean(member.kickable),
    warning,
    warnNow: false,
  };

  if (member.bot) return { ...base, action: 'skip', reason: 'bot' };
  if (member.isOwner) return { ...base, action: 'skip', reason: 'server owner' };

  const list = listVerdict(cfg, member.id, member.roleIds);
  // Which list entry (if any) decided this member's protection, for display.
  const listed = { ...base, listed: list.reason ? { reason: list.reason, roleId: list.roleId ?? null } : null };
  if (list.protected) {
    return { ...listed, action: 'protected', reason: list.reason, roleId: list.roleId };
  }
  // Role action already applied, and not active since: nothing more to do until they are.
  if (actionOf(cfg).type === 'role' && member.marked && member.marked.at >= lastActive) {
    return { ...listed, action: 'done', markedAt: member.marked.at };
  }

  // With warnings on, nobody is kicked until the date their warning DM gave them.
  // A warning already sent keeps its date even if the setting changes later.
  const warnMs = warningMs(cfg);
  let noticeLeftMs = 0;
  if (warning) noticeLeftMs = Math.max(0, warning.kickAfter - now);
  else if (warnMs && member.kickable) noticeLeftMs = warnMs;
  const remainingMs = Math.max(0, thresholdMs - inactiveMs, noticeLeftMs);

  if (member.pausedBy) {
    return { ...listed, action: 'paused', reason: member.pausedBy, remainingMs };
  }
  if (remainingMs > 0) {
    const warnNow = Boolean(warnMs) && Boolean(member.kickable) && !warning && thresholdMs - inactiveMs <= warnMs;
    const reason = inactiveMs < thresholdMs ? 'active' : 'notice';
    return { ...listed, action: 'keep', reason, remainingMs, warnNow };
  }
  if (!member.kickable) {
    return { ...listed, action: 'blocked', reason: 'role is above the bot or bot lacks Kick Members' };
  }
  return { ...listed, action: 'kick', reason: list.reason ?? 'inactive' };
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

/**
 * How long to ban someone who just left, or 0 for no ban. Leaving within
 * `quickLeave.minutes` of joining counts (0 = feature off). Blacklisted
 * members are never banned.
 */
export function quickLeaveBanMs(cfg, { userId, joinedAt, leftAt }) {
  const { minutes = 0, banDays = 7 } = cfg?.quickLeave ?? {};
  if (!minutes || joinedAt == null) return 0;
  if (cfg.blacklist?.users?.includes(userId)) return 0;
  if (leftAt - joinedAt > minutes * 60_000) return 0;
  return banDays * DAY_MS;
}

// ---------------------------------------------------------------- auto slow mode

/** Messages in the last minute -> slow mode seconds. The busier the chat, the longer the wait. */
export const SLOWMODE_TIERS = [
  [0, 0],
  [12, 2],
  [20, 5],
  [30, 10],
  [45, 15],
  [60, 30],
  [90, 60],
  [150, 120],
];
const SLOWMODE_RAISE_GAP_MS = 60_000; // raise at most once a minute

/**
 * Sensitivity scales how busy chat has to be: 'high' kicks in at half the
 * messages, 'low' needs twice as many.
 */
export const SLOWMODE_SENSITIVITY = { low: 0.5, normal: 1, high: 2 };

export function slowmodeForRate(rate, sensitivity = 'normal') {
  const scaled = rate * (SLOWMODE_SENSITIVITY[sensitivity] ?? 1);
  let seconds = 0;
  for (const [minRate, s] of SLOWMODE_TIERS) if (scaled >= minRate) seconds = s;
  return seconds;
}

/** Messages a minute needed for each step at this sensitivity: [[messages, seconds], ...] (the off step left out). */
export function slowmodeScale(sensitivity = 'normal') {
  const factor = SLOWMODE_SENSITIVITY[sensitivity] ?? 1;
  return SLOWMODE_TIERS.slice(1).map(([minRate, s]) => [Math.ceil(minRate / factor), s]);
}

/**
 * Next slow mode for a channel. Raises quickly when chat speeds up; lowers
 * only after it has been calm for `calmMinutes` checks in a row, so it doesn't flap.
 *   rate          messages in the last minute (whitelisted roles/users not counted)
 *   current       the channel's slow mode now (null if unknown)
 *   min, max      limits set for this channel
 *   sensitivity   'low', 'normal' or 'high'
 *   calmMinutes   calm minutes in a row before it eases off (one check a minute)
 *   lowStreak     how many checks in a row the target has been below `current`
 *   sinceChangeMs time since the bot last changed it
 * Returns { seconds, lowStreak }; change the channel when seconds !== current.
 */
export function nextSlowmode({
  rate,
  current,
  min = 0,
  max = 30,
  sensitivity = 'normal',
  calmMinutes = 3,
  lowStreak = 0,
  sinceChangeMs = Infinity,
}) {
  const target = Math.min(max, Math.max(min, slowmodeForRate(rate, sensitivity)));
  if (current === null || current === undefined) return { seconds: target, lowStreak: 0 };
  if (target > current) {
    return { seconds: sinceChangeMs >= SLOWMODE_RAISE_GAP_MS ? target : current, lowStreak: 0 };
  }
  if (target < current) {
    // Outside the configured limits (just changed): fix right away.
    if (current > max) return { seconds: target, lowStreak: 0 };
    const streak = lowStreak + 1;
    if (streak >= calmMinutes && sinceChangeMs >= calmMinutes * 60_000) return { seconds: target, lowStreak: 0 };
    return { seconds: current, lowStreak: streak };
  }
  return { seconds: current, lowStreak: 0 };
}

/** Slow mode whitelist: { channels: { id: settings }, roles: [], users: [] }. */
export function slowmodeSettings(cfg) {
  const s = cfg?.slowmode ?? {};
  return { channels: s.channels ?? {}, roles: s.roles ?? [], users: s.users ?? [] };
}

/** Whitelisted roles and users don't count toward how busy a channel is. */
export function countsForSlowmode(cfg, userId, roleIds = []) {
  const { roles, users } = slowmodeSettings(cfg);
  return !users.includes(userId) && !roleIds.some((id) => roles.includes(id));
}

// ---------------------------------------------------------------- server linking

export const LINK_KINDS = ['bans', 'timeouts', 'roles'];

/**
 * This server's link settings, with defaults: nothing is shared until turned on.
 * bans/timeouts/roles are the defaults for every linked server; `servers` holds
 * per-server overrides: { serverId: { bans?, timeouts?, roles? } }.
 */
export function linkSettings(cfg) {
  const link = cfg?.link ?? {};
  return {
    bans: link.bans ?? 'off',
    timeouts: link.timeouts ?? 'off',
    roles: link.roles ?? 'off',
    servers: link.servers ?? {},
    sharedRoles: link.sharedRoles ?? [],
    exempt: { roles: link.exempt?.roles ?? [], users: link.exempt?.users ?? [] },
  };
}

/** Mode ('off', 'send', 'receive' or 'both') for one kind, toward one linked server (or the default). */
export function linkMode(cfg, kind, otherId = null) {
  const settings = linkSettings(cfg);
  return (otherId && settings.servers[otherId]?.[kind]) || settings[kind];
}

export const linkSends = (cfg, kind, otherId = null) => ['send', 'both'].includes(linkMode(cfg, kind, otherId));
export const linkReceives = (cfg, kind, otherId = null) => ['receive', 'both'].includes(linkMode(cfg, kind, otherId));

/** Exempt members are never touched by linked servers, and what happens to them here isn't shared. */
export function linkExempt(cfg, userId, roleIds = []) {
  const { exempt } = linkSettings(cfg);
  return exempt.users.includes(userId) || roleIds.some((id) => exempt.roles.includes(id));
}

/** Shared roles a member gained and lost. Only roles still on the shared list count. */
export function sharedRoleChanges(before, after, shared) {
  const had = new Set(before.filter((id) => shared.includes(id)));
  const has = new Set(after.filter((id) => shared.includes(id)));
  return { added: [...has].filter((id) => !had.has(id)), removed: [...had].filter((id) => !has.has(id)) };
}

/** Shared roles are matched across servers by name (ignoring case and spaces at the ends). */
export const roleKey = (name) => String(name ?? '').trim().toLowerCase();

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L to mix up

/** One-time link code like "K7QX-M2PA". */
export function makeLinkCode(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const chars = [...random(8)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

export const normalizeLinkCode = (input) => {
  const raw = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
};

export const escapeMarkdown = (text) => String(text).replace(/[\\*_`~|>]/g, '\\$&');

export function formatDuration(ms) {
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return 'less than an hour';
}

/** Like formatDuration, but down to seconds and minutes (for "left 2 minutes after joining"). */
export function formatShortDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return formatDuration(ms);
}
