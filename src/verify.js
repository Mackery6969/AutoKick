// Discord signs every interaction request with Ed25519. Requests that fail the
// check must be rejected, or Discord refuses to save the Interactions Endpoint URL.

const encoder = new TextEncoder();
const keyCache = new Map();

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export async function verifyDiscordRequest(publicKeyHex, signatureHex, timestamp, body) {
  const signature = hexToBytes(signatureHex);
  const publicKey = hexToBytes(publicKeyHex);
  if (!signature || !publicKey || !timestamp) return false;

  let key = keyCache.get(publicKeyHex);
  if (!key) {
    key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    keyCache.set(publicKeyHex, key);
  }
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, encoder.encode(timestamp + body));
  } catch {
    return false;
  }
}
