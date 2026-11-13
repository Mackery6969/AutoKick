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
  pauseRoles: [],
  channels: { whitelist: [], blacklist: [] },
});

function fakeApi({ cfg = baseConfig(), results = [], logFails = false, detected = [], hidden = [], botCanKick = true } = {}) {
  const state = { cfg: structuredClone(cfg), logs: [] };
  return {
    state,
    getConfig: () => structuredClone(state.cfg),
    saveConfig: (c) => {
      state.cfg = structuredClone(c);
    },
    assessGuild: async () => ({ cfg: structuredClone(state.cfg), results, detectedPauseRoles: detected, botCanKick }),
    detectedPauseRoles: async () => detected,
    hiddenChannels: async () => hidden,
    assessMember: async (id) => results.find((r) => r.member.id === id) ?? null,
    log: async (text) => {
      if (logFails) throw new Error('Missing Access');
      state.logs.push(text);
    },
    nextSweepAt: () => Date.now() + 30 * 60_000,
    connected: () => true,
    latency: () => 42,
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

test('ping replies with timing and connection state', async () => {
  // Snowflake for "now": (ms since Discord epoch) << 22
  const id = String((BigInt(Date.now() - 250) - 1420070400000n) << 22n);
  const reply = await runCommand({ id, guild_id: 'G', data: { name: 'ping' } }, fakeApi());
  assert.match(reply.content, /Pong!/);
  assert.match(reply.content, /reached me in \d+ ms/);
  assert.match(reply.content, /heartbeat 42 ms/);

  const offline = { ...fakeApi(), connected: () => false, latency: () => null };
  assert.match((await runCommand({ id, guild_id: 'G', data: { name: 'ping' } }, offline)).content, /Not connected/);
});

test('enable turns it on with a grace period and reports who is due', async () => {
  const api = fakeApi({
    results: [
      result('a', 'kick', { kickable: true }),
      result('b', 'keep', { kickable: true }),
      result('c', 'blocked', { kickable: false }),
    ],
  });
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

const pauseCmd = (name, role) => ({
  guild_id: 'G',
  member: { user: { id: 'admin' } },
  data: {
    name: 'autokick',
    options: [{ type: 2, name: 'pause', options: [{ type: 1, name, options: role ? [{ name: 'role', type: 8, value: role }] : [] }] }],
  },
});

test('pause roles can be added, listed and removed; auto-detected ones are shown', async () => {
  const api = fakeApi({ detected: ['MUTED'] });
  const added = await runCommand(pauseCmd('add', 'BREAK'), api);
  assert.deepEqual(api.state.cfg.pauseRoles, ['BREAK']);
  assert.match(added.content, /won't lose time/);

  const list = await runCommand(pauseCmd('list'), api);
  assert.match(list.embeds[0].description, /<@&BREAK>, <@&MUTED> \(auto\)/);

  const auto = await runCommand(pauseCmd('remove', 'MUTED'), api);
  assert.match(auto.content, /picked up automatically/);

  await runCommand(pauseCmd('remove', 'BREAK'), api);
  assert.deepEqual(api.state.cfg.pauseRoles, []);

  const everyone = await runCommand(pauseCmd('add', 'G'), api);
  assert.match(everyone.content, /@everyone/);
});

test('status counts muted members and shows pause roles', async () => {
  const api = fakeApi({ results: [result('a', 'paused', { reason: 'timeout' }), result('b', 'kick')], detected: ['MUTED'] });
  const fields = Object.fromEntries((await runCommand(sub('status'), api)).embeds[0].fields.map((f) => [f.name, f.value]));
  assert.equal(fields['Muted right now (clock paused)'], '1');
  assert.equal(fields['Past the limit'], '1');
  assert.equal(fields['Pause roles (plus anyone timed out)'], '<@&MUTED> (auto)');
});

test("status warns about channels the bot can't see", async () => {
  const statusFields = async (api) => {
    const reply = await runCommand(sub('status'), api);
    return { reply, fields: Object.fromEntries(reply.embeds[0].fields.map((f) => [f.name, f.value])) };
  };

  const hidden = await statusFields(fakeApi({ hidden: ['C1', 'C2'] }));
  assert.match(hidden.reply.content, /I can't see 2 channels/);
  assert.match(hidden.fields["Channels I can't see"], /^<#C1>, <#C2>\nGive my role \*\*View Channel\*\*/);

  const clear = await statusFields(fakeApi());
  assert.equal(clear.reply.content, undefined);
  assert.match(clear.fields["Channels I can't see"], /None/);

  const failing = { ...fakeApi(), hiddenChannels: async () => Promise.reject(new Error('nope')) };
  assert.match((await statusFields(failing)).fields["Channels I can't see"], /Couldn't check/);
});

test("status warns when the bot can't kick most members", async () => {
  const member = (id, action, kickable, reason) => result(id, action, { kickable, reason });
  const statusText = async (opts) => (await runCommand(sub('status'), fakeApi(opts))).content ?? '';

  // 3 of 4 candidates can't be kicked; bots/owner/whitelisted don't count either way.
  const mostlyBlocked = [
    member('a', 'keep', false),
    member('b', 'keep', false),
    member('c', 'blocked', false),
    member('d', 'keep', true),
    member('bot', 'skip', false, 'bot'),
    member('staff', 'protected', false, 'whitelisted role'),
  ];
  assert.match(await statusText({ results: mostlyBlocked }), /can't kick most members \(3 of 4\)/);
  assert.match(await statusText({ results: mostlyBlocked, botCanKick: false }), /don't have the \*\*Kick Members\*\* permission/);

  const fine = [member('a', 'keep', true), member('b', 'keep', true), member('c', 'keep', false)];
  assert.doesNotMatch(await statusText({ results: fine }), /can't kick most/);
  assert.doesNotMatch(await statusText({ results: [member('bot', 'skip', false, 'bot')] }), /Kick/, 'nobody to kick');

  // enable shows it too, instead of the narrower "N inactive members" note
  const enable = await runCommand(sub('enable'), fakeApi({ results: mostlyBlocked }));
  assert.match(enable.content, /can't kick most members \(3 of 4\)/);
  assert.doesNotMatch(enable.content, /inactive member can't be kicked/);
});

test('check always shows blacklist status and whether the bot can kick them', async () => {
  const api = fakeApi({
    results: [
      result('a', 'keep', { kickable: true, remainingMs: DAY_MS, listed: { reason: 'blacklisted role', roleId: 'TRIAL' } }),
      result('b', 'keep', { kickable: false, remainingMs: DAY_MS, listed: null }),
      result('c', 'blocked', { kickable: false, listed: { reason: 'blacklisted member', roleId: null } }),
      result('o', 'skip', { kickable: false, reason: 'server owner', listed: null }),
    ],
  });
  const check = async (id) => (await runCommand(sub('check', [{ name: 'member', type: 6, value: id }]), api)).content;

  const a = await check('a');
  assert.match(a, /Blacklisted through the role <@&TRIAL>/);
  assert.match(a, /I can kick them/);

  const b = await check('b');
  assert.doesNotMatch(b, /Blacklisted/);
  assert.match(b, /I can't kick them: they have a role above mine/);

  const c = await check('c');
  assert.match(c, /Blacklisted \(as a member\)/);
  assert.equal(c.match(/can't kick them/g).length, 1, 'not repeated for past-the-limit members');

  assert.doesNotMatch(await check('o'), /I can|I can't kick/, 'owner line already says it');
});

test('check explains a paused clock', async () => {
  const api = fakeApi({
    results: [result('a', 'paused', { reason: 'timeout', remainingMs: 5 * DAY_MS, pausedMs: 3 * DAY_MS, inactiveMs: 25 * DAY_MS })],
  });
  const reply = await runCommand(sub('check', [{ name: 'member', type: 6, value: 'a' }]), api);
  assert.match(reply.content, /Clock paused: they're timed out\. 5 days left/);
  assert.match(reply.content, /Muted time not counted: 3 days/);
});

test('/activity shows last activity for you or another member', async () => {
  const seen = Date.now() - 3 * 3600_000;
  const api = fakeApi({
    results: [
      result('me', 'keep', { recorded: true, lastActive: seen }),
      result('other', 'protected', { recorded: true, lastActive: seen, reason: 'whitelisted member' }),
      result('quiet', 'keep', { recorded: false, lastActive: baseConfig().trackingSince }),
    ],
  });
  const cmd = (member) => ({
    guild_id: 'G',
    member: { user: { id: 'me' } },
    data: { name: 'activity', options: member ? [{ name: 'member', type: 6, value: member }] : [] },
  });
  const unix = Math.floor(seen / 1000);

  assert.equal((await runCommand(cmd(), api)).content, `You were last active <t:${unix}:R> (<t:${unix}:f>).`);
  const other = (await runCommand(cmd('other'), api)).content;
  assert.match(other, /\*\*user\\_other\*\* was last active/);
  assert.doesNotMatch(other, /whitelist|protected/i, 'no moderation details for members');
  assert.match((await runCommand(cmd('quiet'), api)).content, /hasn't sent a message or been in voice since I started tracking/);
  assert.match((await runCommand(cmd('ghost'), api)).content, /isn't in this server/);
});

const channelCmd = (group, name, channel, resolved) => ({
  guild_id: 'G',
  member: { user: { id: 'admin' } },
  data: {
    name: 'autokick',
    options: [{ type: 2, name: group, options: [{ type: 1, name, options: channel ? [{ name: 'channel', type: 7, value: channel }] : [] }] }],
    resolved: resolved ? { channels: resolved } : undefined,
  },
});

test('channel blacklist and whitelist: add, move, remove, list, reset', async () => {
  const api = fakeApi();
  const spam = await runCommand(channelCmd('channel-blacklist', 'add', 'C1', { C1: { id: 'C1', type: 0, name: 'spam' } }), api);
  assert.deepEqual(api.state.cfg.channels.blacklist, ['C1']);
  assert.match(spam.content, /<#C1> no longer counts/);

  const cat = await runCommand(channelCmd('channel-blacklist', 'add', 'K1', { K1: { id: 'K1', type: 4, name: 'Bots' } }), api);
  assert.match(cat.content, /\*\*Bots\*\* category \(every channel in it\)/);

  const first = await runCommand(channelCmd('channel-whitelist', 'add', 'C1', { C1: { id: 'C1', type: 0, name: 'spam' } }), api);
  assert.deepEqual(api.state.cfg.channels.whitelist, ['C1']);
  assert.deepEqual(api.state.cfg.channels.blacklist, ['K1'], 'moved off the blacklist');
  assert.match(first.content, /Removed it from the channel blacklist/);
  assert.match(first.content, /first whitelisted channel/);

  const list = await runCommand(channelCmd('channel-whitelist', 'list'), api);
  assert.match(list.embeds[0].description, /^<#C1>/);

  const removed = await runCommand(channelCmd('channel-whitelist', 'remove', 'C1'), api);
  assert.match(removed.content, /whitelist is now empty/);

  const reset = await runCommand(channelCmd('channel-blacklist', 'reset'), api);
  assert.deepEqual(api.state.cfg.channels.blacklist, []);
  assert.match(reset.content, /Cleared the channel blacklist \(1 channel\)\. Activity in every channel counts again/);
  assert.match((await runCommand(channelCmd('channel-blacklist', 'reset'), api)).content, /already empty/);
});

test('whitelist reset clears it and re-arms the grace period while on', async () => {
  const cfg = { ...baseConfig(), enabled: true, armedAt: Date.now() - DAY_MS };
  cfg.whitelist = { roles: ['STAFF'], users: ['U1'] };
  const api = fakeApi({ cfg });
  const reply = await runCommand(listCmd('whitelist', 'reset'), api);
  assert.deepEqual(api.state.cfg.whitelist, { roles: [], users: [] });
  assert.ok(api.state.cfg.armedAt > Date.now() + 59 * 60_000);
  assert.match(reply.content, /Cleared the whitelist \(2 entries: <@&STAFF>, <@U1>\)/);
  assert.match(reply.content, /can't be kicked before/);
});

test('blacklist reset clears it without touching the grace period', async () => {
  const cfg = { ...baseConfig(), enabled: true, armedAt: null };
  cfg.blacklist = { roles: [], users: ['U1'] };
  const api = fakeApi({ cfg });
  const reply = await runCommand(listCmd('blacklist', 'reset'), api);
  assert.deepEqual(api.state.cfg.blacklist, { roles: [], users: [] });
  assert.equal(api.state.cfg.armedAt, null);
  assert.match(reply.content, /Cleared the blacklist \(1 entry: <@U1>\)\.$/);
});

test('warn sets, refuses and turns off the warning DM', async () => {
  const api = fakeApi({ cfg: { ...baseConfig(), enabled: true } });
  const warn = async (days) => (await runCommand(sub('warn', [{ name: 'days', type: 4, value: days }]), api)).content;

  assert.match(await warn(7), /DM \*\*7 days\*\* before they're kicked/);
  assert.equal(api.state.cfg.warnDays, 7);
  assert.match(api.state.logs.at(-1), /Warning DMs set to 7 days/);
  assert.match(await warn(7), /already set to 7 days/);

  assert.match(await warn(30), /must be less than the \*\*30 days\*\* limit/);
  assert.equal(api.state.cfg.warnDays, 7, 'unchanged');

  assert.match(await warn(0), /Warning DMs are \*\*off\*\*.*keeps the date/);
  assert.equal(api.state.cfg.warnDays, 0);
  assert.match(await warn(0), /already \*\*off\*\*/);
});

test('lowering the limit below the warning turns warnings off and says so', async () => {
  const api = fakeApi({ cfg: { ...baseConfig(), warnDays: 10 } });
  const reply = await runCommand(sub('days', [{ name: 'days', type: 4, value: 7 }]), api);
  assert.equal(api.state.cfg.warnDays, 0);
  assert.match(reply.content, /Warning DMs were set to 10 days .* so I turned them off/);

  const keeps = fakeApi({ cfg: { ...baseConfig(), warnDays: 3 } });
  const fine = await runCommand(sub('days', [{ name: 'days', type: 4, value: 7 }]), keeps);
  assert.equal(keeps.state.cfg.warnDays, 3);
  assert.doesNotMatch(fine.content, /turned them off/);
});

test('status, preview and check show warnings', async () => {
  const now = Date.now();
  const cfg = { ...baseConfig(), enabled: true, warnDays: 7 };
  const api = fakeApi({
    cfg,
    results: [
      result('due', 'kick', { kickable: true }),
      result('warned', 'keep', {
        reason: 'notice',
        kickable: true,
        remainingMs: 2 * DAY_MS,
        warning: { at: now - 5 * DAY_MS, kickAfter: now + 2 * DAY_MS, delivered: false },
      }),
      result('next', 'keep', { reason: 'notice', kickable: true, remainingMs: 7 * DAY_MS, warnNow: true, warning: null }),
      result('soon', 'keep', { reason: 'active', kickable: true, inactiveMs: 10 * DAY_MS, remainingMs: 20 * DAY_MS, warning: null }),
    ],
  });

  const fields = Object.fromEntries((await runCommand(sub('status'), api)).embeds[0].fields.map((f) => [f.name, f.value]));
  assert.equal(fields['Warning DM'], '7 days before a kick');
  assert.equal(fields['Past the limit'], '3 (2 still in their warning period)');

  const preview = (await runCommand(sub('preview'), api)).embeds[0].description;
  assert.match(preview, /1 member will be kicked/);
  assert.match(preview, /2 members past the limit are in their warning period/);
  assert.match(preview, /<@warned>.*Warned <t:\d+:R>, kicked <t:\d+:R>/);
  assert.match(preview, /<@next>.*Not warned yet/);

  const check = async (id) => (await runCommand(sub('check', [{ name: 'member', type: 6, value: id }]), api)).content;
  assert.match(await check('warned'), /🟡 Past the limit\. Warned <t:\d+:R> \(their DMs are closed, so it didn't reach them\)\. Will be kicked/);
  assert.match(await check('next'), /Gets a warning DM at the next check .*can't be kicked until 7 days after it/);
  assert.match(await check('soon'), /🟢 Fine for now\..*warning DM 7 days before/);

  const enable = await runCommand(sub('enable'), fakeApi({ cfg: { ...cfg, enabled: false }, results: [result('next', 'keep', { reason: 'notice' })] }));
  assert.match(enable.content, /warning DM 7 days before/);
  assert.match(enable.content, /1 member\*\* is past the limit\. They get a warning DM first .* kicked 7 days later/);
});

test('check explains protection', async () => {
  const api = fakeApi({ results: [result('a', 'protected', { reason: 'whitelisted role', roleId: 'R9' })] });
  const reply = await runCommand(sub('check', [{ name: 'member', type: 6, value: 'a' }]), api);
  assert.match(reply.content, /Protected by the whitelisted role <@&R9>/);
  const missing = await runCommand(sub('check', [{ name: 'member', type: 6, value: 'zzz' }]), api);
  assert.match(missing.content, /isn't in this server/);
});
