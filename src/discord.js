// Small Discord REST client plus helpers that don't depend on the Workers runtime.

export const API = 'https://discord.com/api/v10';

// Gateway intents: GUILDS | GUILD_MEMBERS | GUILD_VOICE_STATES | GUILD_MESSAGES.
// GUILD_MEMBERS is privileged: turn on "Server Members Intent" in the Developer Portal.
// Message *content* is not needed; MESSAGE_CREATE still says who sent the message.
export const INTENTS = (1 << 0) | (1 << 1) | (1 << 7) | (1 << 9);

// Application flags that mean the Server Members Intent toggle is on
// (GATEWAY_GUILD_MEMBERS for verified bots, _LIMITED for bots in under 100 servers).
export const APP_FLAGS_MEMBERS_INTENT = (1 << 14) | (1 << 15);

export const PERM_KICK_MEMBERS = 1n << 1n;
export const PERM_ADMINISTRATOR = 1n << 3n;

/**
 * Free-plan Workers may make 50 outbound requests per invocation. Every REST
 * call draws from a budget so a big job stops cleanly and resumes on the next
 * alarm instead of crashing.
 */
export class Budget {
  constructor(limit) {
    this.remaining = limit;
  }
  use() {
    if (this.remaining <= 0) throw new BudgetExceeded();
    this.remaining -= 1;
  }
}

export class BudgetExceeded extends Error {
  constructor() {
    super('Request budget for this run is used up; continuing on the next run.');
  }
}

export class DiscordError extends Error {
  constructor(status, body, method, path) {
    const shownPath = path.replace(/(\/webhooks\/\d+\/)[^/]+/, '$1…'); // keep interaction tokens out of logs
    super(`Discord API ${method} ${shownPath} failed (${status}): ${body?.message ?? 'no details'}`);
    this.status = status;
    this.code = body?.code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function discordRest(token, method, path, { body, reason, budget, auth = true } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    budget?.use();
    const headers = { 'User-Agent': 'DiscordBot (https://discord.com, 1.0) AutoKick' };
    if (auth) headers.Authorization = `Bot ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);

    const res = await fetch(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      await sleep(Math.min((data.retry_after ?? 1) * 1000, 10_000));
      continue;
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new DiscordError(res.status, data, method, path);
    return data;
  }
  throw new DiscordError(429, { message: 'still rate limited after retries' }, method, path);
}

const UNKNOWN_WEBHOOK = 10015;

/**
 * Replace a deferred interaction's "thinking..." message with the real reply.
 * When a command finishes very fast, Discord may not have registered the
 * deferred response yet and answers "Unknown Webhook"; wait a moment and retry.
 */
export async function editOriginalReply(interaction, reply, { delays = [500, 1000, 2000, 4000], wait = sleep } = {}) {
  const path = `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const body = { ...reply, allowed_mentions: { parse: [] } };
  for (let attempt = 0; ; attempt++) {
    try {
      return await discordRest(null, 'PATCH', path, { body, auth: false });
    } catch (err) {
      if (err.code !== UNKNOWN_WEBHOOK || attempt >= delays.length) throw err;
      await wait(delays[attempt]);
    }
  }
}

/** Convert a guild object from the API into what the bot keeps in memory. */
export function guildMeta(guild) {
  return {
    id: guild.id,
    name: guild.name,
    ownerId: guild.owner_id,
    afkChannelId: guild.afk_channel_id ?? null,
    roles: new Map(
      (guild.roles ?? []).map((r) => [r.id, { name: r.name, position: r.position, permissions: BigInt(r.permissions) }]),
    ),
  };
}

/** Convert a guild member object from the API into a compact record. */
export function memberRecord(m) {
  return {
    id: m.user.id,
    username: m.user.global_name ?? m.user.username,
    bot: Boolean(m.user.bot),
    roleIds: m.roles ?? [],
    joinedTimestamp: m.joined_at ? Date.parse(m.joined_at) : null,
    timeoutUntil: m.communication_disabled_until ? Date.parse(m.communication_disabled_until) : null,
  };
}

// Roles named like "Muted" / "Mute" / "🔇 Muted" count as pause roles automatically.
const MUTED_ROLE_NAME = /\bmuted?\b/i;

/** Pause roles for a server: the ones configured with /autokick pause, plus auto-detected "Muted" roles. */
export function pauseRoleIds(cfg, meta) {
  const ids = new Set(cfg?.pauseRoles ?? []);
  for (const [id, role] of meta?.roles ?? []) {
    if (role.name && MUTED_ROLE_NAME.test(role.name)) ids.add(id);
  }
  return ids;
}

/** Auto-detected pause roles only (for display). */
export function detectedPauseRoleIds(meta) {
  return [...(meta?.roles ?? [])].filter(([, role]) => role.name && MUTED_ROLE_NAME.test(role.name)).map(([id]) => id);
}

function highestPosition(meta, roleIds) {
  let highest = 0;
  for (const id of roleIds) {
    const role = meta.roles.get(id);
    if (role && role.position > highest) highest = role.position;
  }
  return highest;
}

/**
 * Can the bot kick `target`? Same rules Discord enforces: the bot needs
 * Kick Members (or Administrator), can't kick the owner, and its highest role
 * must sit above the target's highest role.
 */
export function canKick(meta, botMember, target) {
  if (!botMember || target.id === meta.ownerId || target.id === botMember.id) return false;

  let perms = meta.roles.get(meta.id)?.permissions ?? 0n; // @everyone role shares the guild's id
  for (const id of botMember.roleIds) perms |= meta.roles.get(id)?.permissions ?? 0n;
  if (!(perms & PERM_ADMINISTRATOR) && !(perms & PERM_KICK_MEMBERS)) return false;

  return highestPosition(meta, botMember.roleIds) > highestPosition(meta, target.roleIds);
}

export const PERM_VIEW_CHANNEL = 1n << 10n;

/**
 * Can the bot see this channel? Follows Discord's permission order: server-wide
 * role permissions, then the channel's @everyone overwrite, then role overwrites
 * (combined), then an overwrite for the bot itself. Administrator sees everything.
 * `channel` is a channel object from the API (with permission_overwrites).
 */
export function canViewChannel(meta, botMember, channel) {
  let perms = meta.roles.get(meta.id)?.permissions ?? 0n;
  for (const id of botMember.roleIds) perms |= meta.roles.get(id)?.permissions ?? 0n;
  if (perms & PERM_ADMINISTRATOR) return true;

  const overwrites = channel.permission_overwrites ?? [];
  const apply = (o) => {
    perms &= ~BigInt(o.deny);
    perms |= BigInt(o.allow);
  };
  const everyone = overwrites.find((o) => o.id === meta.id);
  if (everyone) apply(everyone);
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (Number(o.type) === 0 && o.id !== meta.id && botMember.roleIds.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  apply({ allow, deny });
  const own = overwrites.find((o) => Number(o.type) === 1 && o.id === botMember.id);
  if (own) apply(own);
  return Boolean(perms & PERM_VIEW_CHANNEL);
}

/** True if the bot has Kick Members at all (ignores role order). */
export function botHasKickPermission(meta, botMember) {
  if (!botMember) return false;
  let perms = meta.roles.get(meta.id)?.permissions ?? 0n;
  for (const id of botMember.roleIds) perms |= meta.roles.get(id)?.permissions ?? 0n;
  return Boolean(perms & PERM_ADMINISTRATOR) || Boolean(perms & PERM_KICK_MEMBERS);
}
