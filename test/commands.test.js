import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, runCommand } from '../src/commands.js';
import { DAY_MS } from '../src/policy.js';

const baseConfig = () => ({
  enabled: false,
  days: 30,
  logChannelId: null,
  trackingSince: Date.now() - 60 * DAY_MS,
  armedAt: null,
  whitelist: { roles: [], users: [] },
  blacklist: { roles: [], users: [] },
});

function fakeApi({ cfg = baseConfig(), results = [], logFails = false } = {}) {
  const state = { cfg: structuredClone(cfg), logs: [] };
  return {
    state,
    getConfig: () => structuredClone(state.cfg),
    saveConfig: (c) => {
      state.cfg = structuredClone(c);
    },
    assessGuild: async () => ({ cfg: structuredClone(state.cfg), results }),
    assessMember: async (id) => results.find((r) => r.member.id === id) ?? null,
    log: async (text) => {
      if (logFails) throw new Error('Missing Access');
      state.logs.push(text);
    },
    nextSweepAt: () => Date.now() + 30 * 60_000,
    connected: () => true,
    enableGraceMs: 60 * 60_000,
  };
}

const sub = (name, options = []) => ({
  guild_id: 'G',
  member: { user: { id: 'admin' } },
  data: { name: 'autokick', options: [{ type: 1, name, options }] },
});

const listCmd = (group, name, target, resolved) => ({
  guild_id: 'G',
  member: { user: { id: 'admin' } },
  data: {
    name: 'autokick',
    options: [{ type: 2, name: group, options: [{ type: 1, name, options: target ? [{ name: 'target', type: 9, value: target }] : [] }] }],
    resolved,
  },
});

const result = (id, action, extra = {}) => ({
  member: { id, username: `user_${id}` },
  result: { action, inactiveMs: 40 * DAY_MS, lastActive: 0, recorded: false, ...extra },
});

test('command definitions stay within Discord limits', () => {
  const walk = (opt) => {
    assert.match(opt.name, /^[a-z0-9_-]{1,32}$/);
    assert.ok(opt.description.length >= 1 && opt.description.length <= 100, `${opt.name} description length`);
    assert.ok((opt.options ?? []).length <= 25);
    (opt.options ?? []).forEach(walk);
  };
  COMMANDS.forEach(walk);
});

test('enable turns it on with a grace period and reports who is due', async () => {
  const api = fakeApi({ results: [result('a', 'kick'), result('b', 'keep'), result('c', 'blocked')] });
  const reply = await runCommand(sub('enable'), api);
  assert.equal(api.state.cfg.enabled, true);
  assert.ok(api.state.cfg.armedAt > Date.now() + 59 * 60_000);
  assert.match(reply.content, /1 member\*\* is past the limit/);
  assert.match(reply.content, /1 inactive member can't be kicked/);
  assert.equal(api.state.logs.length, 1);
});

test('disable turns it off', async () => {
  const api = fakeApi({ cfg: { ...baseConfig(), enabled: true } });
  const reply = await runCommand(sub('disable'), api);
  assert.equal(api.state.cfg.enabled, false);
  assert.match(reply.content, /off/);
});

test('whitelist add moves an entry off the blacklist; @everyone is refused', async () => {
  const cfg = baseConfig();
  cfg.blacklist.roles.push('R1');
  const api = fakeApi({ cfg });
  const reply = await runCommand(listCmd('whitelist', 'add', 'R1', { roles: { R1: { id: 'R1' } } }), api);
  assert.deepEqual(api.state.cfg.whitelist.roles, ['R1']);
  assert.deepEqual(api.state.cfg.blacklist.roles, []);
  assert.match(reply.content, /removed it from the blacklist/);

  const everyone = await runCommand(listCmd('blacklist', 'add', 'G', { roles: { G: { id: 'G' } } }), api);
  assert.match(everyone.content, /@everyone can't/);
  assert.deepEqual(api.state.cfg.blacklist.roles, []);
});

test('blacklist add/remove for a member', async () => {
  const api = fakeApi();
  await runCommand(listCmd('blacklist', 'add', 'U1', { users: { U1: { id: 'U1' } } }), api);
  assert.deepEqual(api.state.cfg.blacklist.users, ['U1']);
  const again = await runCommand(listCmd('blacklist', 'add', 'U1', { users: { U1: { id: 'U1' } } }), api);
  assert.match(again.content, /already/);
  await runCommand(listCmd('blacklist', 'remove', 'U1', { users: { U1: { id: 'U1' } } }), api);
  assert.deepEqual(api.state.cfg.blacklist.users, []);
  const list = await runCommand(listCmd('blacklist', 'list'), api);
  assert.equal(list.embeds[0].description, 'None');
});

test('lowering the limit while on re-arms the grace period', async () => {
  const api = fakeApi({ cfg: { ...baseConfig(), enabled: true, armedAt: Date.now() - DAY_MS } });
  await runCommand(sub('days', [{ name: 'days', type: 4, value: 7 }]), api);
  assert.equal(api.state.cfg.days, 7);
  assert.ok(api.state.cfg.armedAt > Date.now());
});

test('logchannel reverts when the bot cannot post there', async () => {
  const api = fakeApi({ logFails: true });
  const reply = await runCommand(sub('logchannel', [{ name: 'channel', type: 7, value: 'C1' }]), api);
  assert.equal(api.state.cfg.logChannelId, null);
  assert.match(reply.content, /couldn't post/);
});

test('preview lists members past the limit', async () => {
  const api = fakeApi({ results: [result('a', 'kick'), result('b', 'kick', { inactiveMs: 90 * DAY_MS })] });
  const reply = await runCommand(sub('preview'), api);
  const text = reply.embeds[0].description;
  assert.match(text, /2 members would be kicked/);
  assert.ok(text.indexOf('<@b>') < text.indexOf('<@a>'), 'longest inactive first');
});

test('check explains protection', async () => {
  const api = fakeApi({ results: [result('a', 'protected', { reason: 'whitelisted role', roleId: 'R9' })] });
  const reply = await runCommand(sub('check', [{ name: 'member', type: 6, value: 'a' }]), api);
  assert.match(reply.content, /Protected by the whitelisted role <@&R9>/);
  const missing = await runCommand(sub('check', [{ name: 'member', type: 6, value: 'zzz' }]), api);
  assert.match(missing.content, /isn't in this server/);
});
