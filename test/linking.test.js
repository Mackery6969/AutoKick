// Runs the real linking and slow mode code (linking.js, slowmode.js) against
// in-memory SQLite and a fake Discord that echoes every change straight back
// as a gateway event, the worst case for loops.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Budget, memberRecord } from '../src/discord.js';
import { linkMethods } from '../src/linking.js';
import { slowmodeMethods } from '../src/slowmode.js';

function fakeSql() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = stmt.all(...params);
        return { toArray: () => rows };
      }
      stmt.run(...params);
      return { toArray: () => [] };
    },
  };
}

class FakeDiscordError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/**
 * guilds: { id: { name, owner?, roles?: { roleId: name }, members?: { userId: { roles?, timeout? } }, cfg? } }
 * links: [[a, b], ...]
 */
function setup({ guilds, links = [] }) {
  const configs = {};
  const discord = { bans: {}, members: {}, channels: {} };
  const bot = Object.assign({}, linkMethods, slowmodeMethods);
  bot.sql = fakeSql();
  bot.guildCache = new Map();
  bot.memberCache = new Map();
  bot.logs = [];
  bot.calls = [];

  for (const [id, g] of Object.entries(guilds)) {
    configs[id] = g.cfg ?? {};
    discord.bans[id] = new Map();
    discord.members[id] = new Map(
      Object.entries(g.members ?? {}).map(([uid, m]) => [uid, { roles: m.roles ?? [], timeout: m.timeout ?? null }]),
    );
    bot.guildCache.set(id, {
      id,
      name: g.name,
      ownerId: g.owner ?? 'owner',
      roles: new Map(Object.entries(g.roles ?? {}).map(([rid, name]) => [rid, { name, position: 1, permissions: 0n }])),
    });
  }

  const record = (guildId, userId) => {
    const m = discord.members[guildId].get(userId);
    return memberRecord({
      user: { id: userId, username: `user_${userId}` },
      roles: [...m.roles],
      communication_disabled_until: m.timeout ? new Date(m.timeout).toISOString() : null,
    });
  };

  bot.getConfig = (id) => configs[id] ?? null;
  bot.saveConfig = (id, cfg) => {
    configs[id] = cfg;
  };
  bot.getMeta = async (id) => bot.guildCache.get(id);
  bot.logSafely = async (guildId, text) => {
    bot.logs.push([guildId, text]);
  };
  bot.findBan = async (guildId, userId, budget) => {
    try {
      return await bot.rest('GET', `/guilds/${guildId}/bans/${userId}`, { budget });
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  };
  bot.loadGuild = async (guildId) => ({
    members: new Map([...discord.members[guildId].keys()].map((uid) => [uid, record(guildId, uid)])),
  });

  // Fake Discord REST: applies the change, then fires the gateway event it would cause.
  bot.rest = async (method, path, { body, reason, budget } = {}) => {
    budget?.use();
    bot.calls.push(`${method} ${path}`);
    let m;
    if ((m = path.match(/^\/guilds\/(\w+)\/bans\/(\w+)$/))) {
      const [, g, u] = m;
      if (method === 'GET') {
        if (!discord.bans[g].has(u)) throw new FakeDiscordError(404);
        return { reason: discord.bans[g].get(u) };
      }
      if (method === 'PUT') {
        discord.bans[g].set(u, reason ?? null);
        discord.members[g].delete(u);
        bot.onLinkBan({ guild_id: g, user: { id: u, username: `user_${u}` } }, true);
        return null;
      }
      if (method === 'DELETE') {
        discord.bans[g].delete(u);
        bot.onLinkBan({ guild_id: g, user: { id: u, username: `user_${u}` } }, false);
        return null;
      }
    }
    if ((m = path.match(/^\/guilds\/(\w+)\/members\/(\w+)\/roles\/(\w+)$/))) {
      const [, g, u, r] = m;
      const member = discord.members[g].get(u);
      if (!member) throw new FakeDiscordError(404);
      const prev = member.timeout;
      member.roles = method === 'PUT' ? [...new Set([...member.roles, r])] : member.roles.filter((x) => x !== r);
      bot.onLinkMemberUpdate(g, record(g, u), prev);
      return null;
    }
    if ((m = path.match(/^\/guilds\/(\w+)\/members\/(\w+)$/))) {
      const [, g, u] = m;
      const member = discord.members[g].get(u);
      if (!member) throw new FakeDiscordError(404);
      if (method === 'GET') {
        return { user: { id: u, username: `user_${u}` }, roles: member.roles, communication_disabled_until: member.timeout ? new Date(member.timeout).toISOString() : null };
      }
      if (method === 'PATCH') {
        const prev = member.timeout;
        member.timeout = body.communication_disabled_until ? Date.parse(body.communication_disabled_until) : null;
        bot.onLinkMemberUpdate(g, record(g, u), prev);
        return null;
      }
    }
    if ((m = path.match(/^\/channels\/(\w+)$/)) && method === 'PATCH') {
      discord.channels[m[1]] = body.rate_limit_per_user;
      bot.noteChannelSlowmode({ id: m[1], rate_limit_per_user: body.rate_limit_per_user });
      return null;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };

  bot.initLinks();
  bot.initSlowmode();
  for (const [a, b] of links) {
    const [x, y] = [a, b].sort();
    bot.sql.exec('INSERT INTO links (guild_a, guild_b, created_at) VALUES (?, ?, ?)', x, y, Date.now());
  }

  const jobs = () => bot.sql.exec('SELECT kind, source_guild, target_guild, user_id FROM link_jobs ORDER BY id').toArray();
  const run = async () => {
    for (let i = 0; i < 10 && jobs().length; i++) await bot.runLinkJobs(new Budget(44));
  };
  // A moderator acts directly in a server (the gateway event follows).
  const moderator = {
    ban: (g, u, why = null) => {
      discord.bans[g].set(u, why);
      discord.members[g].delete(u);
      bot.onLinkBan({ guild_id: g, user: { id: u, username: `user_${u}` } }, true);
    },
    unban: (g, u) => {
      discord.bans[g].delete(u);
      bot.onLinkBan({ guild_id: g, user: { id: u, username: `user_${u}` } }, false);
    },
    timeout: (g, u, until) => {
      const member = discord.members[g].get(u);
      const prev = member.timeout;
      member.timeout = until;
      bot.onLinkMemberUpdate(g, record(g, u), prev);
    },
    roles: (g, u, roles) => {
      const member = discord.members[g].get(u);
      member.roles = roles;
      bot.onLinkMemberUpdate(g, record(g, u), member.timeout);
    },
  };
  return { bot, discord, configs, jobs, run, moderator, record };
}

const both = (extra = {}) => ({ link: { bans: 'both', timeouts: 'both', roles: 'both', ...extra } });

test('a ban is copied one hop (A-B and B-C links never carry it to C), and lifted with the original', async () => {
  const { discord, jobs, run, moderator, bot } = setup({
    guilds: { A: { name: 'Server A', cfg: both() }, B: { name: 'Server B', cfg: both() }, C: { name: 'Server C', cfg: both() } },
    links: [['A', 'B'], ['B', 'C']],
  });
  moderator.ban('A', 'u1', 'spam');
  assert.deepEqual(jobs().map((j) => `${j.kind}:${j.target_guild}`), ['ban:B']);
  await run();
  assert.equal(discord.bans.B.get('u1'), 'AutoKick link: banned in Server A: spam');
  assert.equal(discord.bans.C.has('u1'), false, 'not passed on from B to C');
  assert.match(bot.logs.find(([g]) => g === 'B')[1], /🔗 Banned <@u1>.*banned in \*\*Server A\*\* \(spam\)/);

  moderator.unban('A', 'u1');
  await run();
  assert.equal(discord.bans.B.has('u1'), false, 'copy lifted');
  assert.deepEqual(jobs(), []);
});

test("a ban is still copied when the bot can't read the original's reason", async () => {
  const { bot, discord, run, moderator } = setup({
    guilds: { A: { name: 'Server A', cfg: both() }, B: { name: 'Server B', cfg: both() } },
    links: [['A', 'B']],
  });
  const rest = bot.rest;
  bot.rest = async (method, path, opts) => {
    if (method === 'GET' && path.startsWith('/guilds/A/bans/')) {
      opts?.budget?.use();
      const err = new Error('Missing Permissions');
      err.status = 403;
      throw err;
    }
    return rest(method, path, opts);
  };
  moderator.ban('A', 'u1', 'spam');
  await run();
  assert.equal(discord.bans.B.get('u1'), 'AutoKick link: banned in Server A');
});

test('per-server settings: share only timeouts with one server and bans with another', async () => {
  const until = Date.now() + 3600_000;
  const { discord, jobs, run, moderator } = setup({
    guilds: {
      A: { name: 'A', cfg: { link: { bans: 'both', timeouts: 'off', servers: { B: { bans: 'off', timeouts: 'both' } } } }, members: { u1: {} } },
      B: { name: 'B', cfg: { link: { timeouts: 'both' } }, members: { u1: {} } },
      C: { name: 'C', cfg: { link: { bans: 'both', timeouts: 'both' } }, members: { u1: {} } },
    },
    links: [['A', 'B'], ['A', 'C']],
  });
  moderator.timeout('A', 'u1', until);
  assert.deepEqual(jobs().map((j) => `${j.kind}:${j.target_guild}`), ['timeout:B'], 'timeouts only go to B');
  moderator.ban('A', 'u2');
  assert.deepEqual(jobs().map((j) => `${j.kind}:${j.target_guild}`), ['timeout:B', 'ban:C'], 'bans only go to C');
  await run();
  assert.ok(discord.members.B.get('u1').timeout);
  assert.equal(discord.members.C.get('u1').timeout, null);
  assert.equal(discord.bans.C.has('u2'), true);
  assert.equal(discord.bans.B.has('u2'), false);
});

test("bans follow each side's send/receive choice", async () => {
  const { discord, jobs, run, moderator } = setup({
    guilds: { A: { name: 'A', cfg: both({ bans: 'send' }) }, B: { name: 'B', cfg: both({ bans: 'send' }) } },
    links: [['A', 'B']],
  });
  moderator.ban('A', 'u1');
  assert.deepEqual(jobs(), [], "B doesn't accept bans");
  moderator.ban('B', 'u2');
  assert.deepEqual(jobs(), [], "A doesn't accept bans either");
  await run();
  assert.equal(discord.bans.B.has('u1'), false);
});

test("the bot's own bans aren't shared, exempt members are skipped, and a moderator's replacement ban stays", async () => {
  const { bot, discord, jobs, run, moderator } = setup({
    guilds: {
      A: { name: 'A', cfg: both() },
      B: { name: 'B', cfg: both({ exempt: { roles: ['staff'], users: ['vip'] } }), members: { mod: { roles: ['staff'] } } },
    },
    links: [['A', 'B']],
  });
  bot.markOwnBan('A', 'u1'); // e.g. an inactivity temp ban
  moderator.ban('A', 'u1');
  assert.deepEqual(jobs(), []);

  moderator.ban('A', 'vip');
  moderator.ban('A', 'mod');
  await run();
  assert.equal(discord.bans.B.has('vip'), false, 'exempt by ID');
  assert.equal(discord.bans.B.has('mod'), false, 'exempt by role');

  moderator.ban('A', 'u3');
  await run();
  discord.bans.B.set('u3', 'permanent: raided us'); // a moderator in B replaced the copy with their own ban
  moderator.unban('A', 'u3');
  await run();
  assert.equal(discord.bans.B.get('u3'), 'permanent: raided us');
});

test('timeouts are copied with the same end, not echoed back, and lifted with the original', async () => {
  const until = Date.now() + 3600_000;
  const { discord, jobs, run, moderator } = setup({
    guilds: {
      A: { name: 'A', cfg: both(), members: { u1: {} } },
      B: { name: 'B', cfg: both(), members: { u1: {} } },
    },
    links: [['A', 'B']],
  });
  moderator.timeout('A', 'u1', until);
  await run();
  assert.equal(Math.abs(discord.members.B.get('u1').timeout - until) < 1000, true);
  assert.deepEqual(jobs(), [], "B's copy isn't sent back to A");

  moderator.timeout('A', 'u1', null);
  await run();
  assert.equal(discord.members.B.get('u1').timeout, null, 'lifted');
});

test('a timeout changed by a moderator in the other server is left alone', async () => {
  const until = Date.now() + 3600_000;
  const { discord, run, moderator } = setup({
    guilds: {
      A: { name: 'A', cfg: both(), members: { u1: {} } },
      B: { name: 'B', cfg: both({ timeouts: 'receive' }), members: { u1: {} } },
    },
    links: [['A', 'B']],
  });
  moderator.timeout('A', 'u1', until);
  await run();
  const longer = until + 86_400_000;
  moderator.timeout('B', 'u1', longer);
  moderator.timeout('A', 'u1', null);
  await run();
  assert.equal(discord.members.B.get('u1').timeout, longer);
});

test('shared roles sync by name both ways without echoing, and are copied when someone joins', async () => {
  const { bot, discord, jobs, run, moderator, record } = setup({
    guilds: {
      A: { name: 'A', cfg: both({ sharedRoles: ['VA'] }), roles: { VA: 'Verified' }, members: { u1: {}, u2: { roles: ['VA'] } } },
      B: { name: 'B', cfg: both({ sharedRoles: ['VB'] }), roles: { VB: ' verified ' }, members: { u1: {} } },
    },
    links: [['A', 'B']],
  });
  moderator.roles('A', 'u1', ['VA']);
  await run();
  assert.deepEqual(discord.members.B.get('u1').roles, ['VB']);
  assert.deepEqual(jobs(), [], "B's change isn't sent back");

  moderator.roles('A', 'u1', []);
  await run();
  assert.deepEqual(discord.members.B.get('u1').roles, []);

  // u2 has Verified in A and joins B.
  discord.members.B.set('u2', { roles: [], timeout: null });
  bot.onLinkJoin('B', record('B', 'u2'));
  await run();
  assert.deepEqual(discord.members.B.get('u2').roles, ['VB']);
});

test('roles only sync when both sides share a role with that name', async () => {
  const { discord, run, moderator } = setup({
    guilds: {
      A: { name: 'A', cfg: both({ sharedRoles: ['VA'] }), roles: { VA: 'Verified' }, members: { u1: {} } },
      B: { name: 'B', cfg: both({ sharedRoles: ['XB'] }), roles: { XB: 'Other' }, members: { u1: {} } },
    },
    links: [['A', 'B']],
  });
  moderator.roles('A', 'u1', ['VA']);
  await run();
  assert.deepEqual(discord.members.B.get('u1').roles, []);
});

test('link codes: one use, not in the same server, not twice, and unlinking drops pending jobs', async () => {
  const { bot, jobs, moderator } = setup({
    guilds: { A: { name: 'A', cfg: both() }, B: { name: 'B', cfg: both() } },
  });
  const { code } = bot.createLinkCode('A');
  assert.deepEqual(await bot.joinLink('A', code, 'x', new Budget(44)), { error: 'self' });
  assert.deepEqual(await bot.joinLink('B', code.toLowerCase().replace('-', ' '), 'x', new Budget(44)), { id: 'A', name: 'A' });
  assert.equal(bot.areLinked('A', 'B'), true);
  assert.deepEqual(await bot.joinLink('B', code, 'x', new Budget(44)), { error: 'invalid' }, 'used up');

  const again = bot.createLinkCode('A').code;
  assert.equal((await bot.joinLink('B', again, 'x', new Budget(44))).error, 'already');

  moderator.ban('A', 'u1');
  assert.equal(jobs().length, 1);
  await bot.unlink('B', 'a', 'x', new Budget(44));
  assert.equal(bot.areLinked('A', 'B'), false);
  assert.deepEqual(jobs(), []);
});

test('slow mode rises with chat, ignores its own echo, and backs off after a manual change', async () => {
  const { bot, discord, configs } = setup({ guilds: { A: { name: 'A', cfg: { slowmode: { channels: { C1: { min: 0, max: 30 } } } } } } });
  bot.sql.exec('CREATE TABLE IF NOT EXISTS guilds (id TEXT PRIMARY KEY, config TEXT NOT NULL)');
  bot.sql.exec('INSERT INTO guilds (id, config) VALUES (?, ?)', 'A', JSON.stringify(configs.A));
  bot.noteChannelSlowmode({ id: 'C1', rate_limit_per_user: 0 });

  for (let i = 0; i < 25; i++) bot.countMessage('C1');
  await bot.runSlowmode(new Budget(44));
  assert.equal(discord.channels.C1, 5, '25 messages a minute → 5s');
  assert.equal(bot.slowmodeState.get('C1').manualUntil, undefined, 'its own change is not a manual one');

  bot.noteChannelSlowmode({ id: 'C1', rate_limit_per_user: 60 }); // a moderator sets 60s by hand
  for (let i = 0; i < 100; i++) bot.countMessage('C1');
  await bot.runSlowmode(new Budget(44));
  assert.equal(discord.channels.C1, 5, 'left alone after a manual change');
  assert.ok(bot.slowmodeState.get('C1').manualUntil > Date.now());
});
