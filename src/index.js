// Worker entry point.
//   POST /interactions  - Discord slash commands (set this as the Interactions Endpoint URL)
//   GET  /              - health check; also wakes the bot if it isn't running
//   cron (every 5 min)  - safety net that makes sure the bot is running
//
// The always-on part (the Discord gateway connection, storage and kicking)
// lives in the AutoKickBot Durable Object in bot.js.

import { verifyDiscordRequest } from './verify.js';

export { AutoKickBot } from './bot.js';

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 };
const ResponseType = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5 };
const EPHEMERAL = 1 << 6;

const getBot = (env) => env.AUTOKICK.getByName('main');

async function handleInteraction(request, env, ctx) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  const body = await request.text();
  if (!(await verifyDiscordRequest(env.DISCORD_PUBLIC_KEY, signature, timestamp, body))) {
    return new Response('Invalid request signature', { status: 401 });
  }

  const interaction = JSON.parse(body);
  if (interaction.type === InteractionType.PING) {
    return Response.json({ type: ResponseType.PONG });
  }
  if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data?.name === 'autokick') {
    // Discord needs an answer within 3 seconds; reply "thinking..." now and
    // let the bot edit in the real answer when it's done.
    ctx.waitUntil(getBot(env).handleCommand(interaction));
    return Response.json({ type: ResponseType.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
  }
  return Response.json({
    type: ResponseType.MESSAGE,
    data: { content: 'Unknown command.', flags: EPHEMERAL },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/interactions') {
      return handleInteraction(request, env, ctx);
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return Response.json(await getBot(env).status(), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(getBot(env).status());
  },
};
