import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  botHasKickPermission,
  canKick,
  editOriginalReply,
  guildMeta,
  memberRecord,
  PERM_ADMINISTRATOR,
  PERM_KICK_MEMBERS,
} from '../src/discord.js';

async function withFetch(responses, fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const [status, body] = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(body), { status });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const unknownWebhook = [404, { message: 'Unknown Webhook', code: 10015 }];
const interaction = { application_id: '111', token: 'secret-token' };

test('editOriginalReply retries until Discord has registered the deferred reply', async () => {
  await withFetch([unknownWebhook, unknownWebhook, [200, { id: 'msg' }]], async (calls) => {
    const waits = [];
    const msg = await editOriginalReply(interaction, { content: 'hi' }, { wait: async (ms) => waits.push(ms) });
    assert.equal(msg.id, 'msg');
    assert.equal(calls.length, 3);
    assert.deepEqual(waits, [500, 1000]);
    assert.equal(calls[0].init.method, 'PATCH');
    assert.match(calls[0].url, /\/webhooks\/111\/secret-token\/messages\/@original$/);
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(calls[0].init.body).allowed_mentions, { parse: [] });
  });
});

test('editOriginalReply gives up after its retries and keeps the token out of the error', async () => {
  await withFetch([unknownWebhook], async (calls) => {
    const err = await editOriginalReply(interaction, { content: 'hi' }, { wait: async () => {} }).catch((e) => e);
    assert.equal(calls.length, 5);
    assert.equal(err.code, 10015);
    assert.doesNotMatch(err.message, /secret-token/);
  });
});

test('editOriginalReply does not retry other errors', async () => {
  await withFetch([[403, { message: 'Missing Access', code: 50001 }]], async (calls) => {
    await assert.rejects(editOriginalReply(interaction, { content: 'hi' }, { wait: async () => {} }));
    assert.equal(calls.length, 1);
  });
});

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
