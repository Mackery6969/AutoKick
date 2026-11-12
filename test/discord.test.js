import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botHasKickPermission, canKick, guildMeta, memberRecord, PERM_ADMINISTRATOR, PERM_KICK_MEMBERS } from '../src/discord.js';

const meta = guildMeta({
  id: 'G',
  name: 'Test',
  owner_id: 'owner',
  afk_channel_id: null,
  roles: [
    { id: 'G', position: 0, permissions: '0' }, // @everyone
    { id: 'botrole', position: 5, permissions: String(PERM_KICK_MEMBERS) },
    { id: 'mod', position: 8, permissions: '0' },
    { id: 'member', position: 2, permissions: '0' },
    { id: 'adminrole', position: 3, permissions: String(PERM_ADMINISTRATOR) },
  ],
});
const bot = { id: 'bot', roleIds: ['botrole'] };

test('canKick follows Discord role order', () => {
  assert.equal(canKick(meta, bot, { id: 'a', roleIds: ['member'] }), true);
  assert.equal(canKick(meta, bot, { id: 'a', roleIds: [] }), true);
  assert.equal(canKick(meta, bot, { id: 'a', roleIds: ['mod'] }), false, 'role above the bot');
  assert.equal(canKick(meta, bot, { id: 'a', roleIds: ['botrole'] }), false, 'same top role as the bot');
  assert.equal(canKick(meta, bot, { id: 'owner', roleIds: [] }), false, 'owner');
  assert.equal(canKick(meta, bot, { id: 'bot', roleIds: ['botrole'] }), false, 'itself');
  assert.equal(canKick(meta, undefined, { id: 'a', roleIds: [] }), false, 'bot member unknown');
});

test('canKick needs Kick Members or Administrator', () => {
  const noPerms = { id: 'bot', roleIds: ['mod'] };
  assert.equal(canKick(meta, noPerms, { id: 'a', roleIds: [] }), false);
  assert.equal(botHasKickPermission(meta, noPerms), false);
  const admin = { id: 'bot', roleIds: ['adminrole'] };
  assert.equal(canKick(meta, admin, { id: 'a', roleIds: ['member'] }), true);
  assert.equal(botHasKickPermission(meta, admin), true);
});

test('memberRecord reads API member objects', () => {
  const rec = memberRecord({
    user: { id: '1', username: 'sam', global_name: 'Sam', bot: false },
    roles: ['member'],
    joined_at: '2026-01-02T03:04:05.000Z',
  });
  assert.deepEqual(rec, {
    id: '1',
    username: 'Sam',
    bot: false,
    roleIds: ['member'],
    joinedTimestamp: Date.parse('2026-01-02T03:04:05.000Z'),
  });
});
