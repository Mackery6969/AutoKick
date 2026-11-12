import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDiscordRequest } from '../src/verify.js';

const toHex = (buf) => Buffer.from(buf).toString('hex');

test('verifyDiscordRequest accepts valid signatures and rejects everything else', async () => {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicHex = toHex(await crypto.subtle.exportKey('raw', publicKey));
  const timestamp = '1700000000';
  const body = JSON.stringify({ type: 1 });
  const signature = toHex(
    await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(timestamp + body)),
  );

  assert.equal(await verifyDiscordRequest(publicHex, signature, timestamp, body), true);
  assert.equal(await verifyDiscordRequest(publicHex, signature, timestamp, body + ' '), false, 'tampered body');
  assert.equal(await verifyDiscordRequest(publicHex, signature, '1700000001', body), false, 'wrong timestamp');
  assert.equal(await verifyDiscordRequest(publicHex, 'zz', timestamp, body), false, 'garbage signature');
  assert.equal(await verifyDiscordRequest(publicHex, null, timestamp, body), false, 'missing signature');
});
