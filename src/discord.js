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
    super(`Discord API ${method} ${path} failed (${status}): ${body?.message ?? 'no details'}`);
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

/** Convert a guild object from the API into what the bot keeps in memory. */
export function guildMeta(guild) {
  return {
    id: guild.id,
    name: guild.name,
    ownerId: guild.owner_id,
    afkChannelId: guild.afk_channel_id ?? null,
    roles: new Map(
      (guild.roles ?? []).map((r) => [r.id, { position: r.position, permissions: BigInt(r.permissions) }]),
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
  };
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

/** True if the bot has Kick Members at all (ignores role order). */
export function botHasKickPermission(meta, botMember) {
  if (!botMember) return false;
  let perms = meta.roles.get(meta.id)?.permissions ?? 0n;
  for (const id of botMember.roleIds) perms |= meta.roles.get(id)?.permissions ?? 0n;
  return Boolean(perms & PERM_ADMINISTRATOR) || Boolean(perms & PERM_KICK_MEMBERS);
}
