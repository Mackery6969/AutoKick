# AutoKick

A Discord bot that kicks members who haven't **sent a message** or **been in a voice channel** for a set number of days (30 by default). It runs entirely on **Cloudflare Workers**, on the free plan, with no server or PC to keep on.

## What counts as activity

- Sending a message anywhere in the server: channels, threads, forum posts, replies.
- Being in a voice channel: joining, leaving, switching, or just sitting in it. The server's AFK channel doesn't count.

## Muted members

It isn't fair to count time against someone who wasn't allowed to talk. While a member is **timed out**, or has a **pause role**, their inactivity clock stops. It picks up where it left off once the mute ends; it doesn't restart from zero. Nobody is kicked while they're muted.

Pause roles are any role named like "Muted" or "Mute" (picked up automatically), plus any roles you add with `/autokick pause add`, such as an "On Break" role.

## Who is never kicked

- Bots and the server owner.
- Anyone whose highest role is above the bot's role (Discord won't allow it).
- Whitelisted members and roles (see [Whitelist and blacklist](#whitelist-and-blacklist)).

## Safety features

- **Off by default.** Nothing gets kicked until someone runs `/autokick enable`.
- **One-hour grace period** after enabling (or lowering the day limit), so you can check `/autokick preview` and back out with `/autokick disable`.
- **Clean slate when the bot joins.** The bot can't see history from before it was added, so everyone's clock starts on the day it started tracking. New members' clocks start when they join.
- **Bot downtime isn't held against anyone.** If the bot is offline for a while, that time isn't counted as inactivity.
- Kicked members get a DM (if their DMs are open) saying why and that they can rejoin.

## Commands

All commands are under `/autokick`. By default only members with **Manage Server** can see and use them. You can change that in Server Settings → Integrations.

| Command | What it does |
| --- | --- |
| `/autokick enable` | Turn auto-kicking on |
| `/autokick disable` | Turn it off (activity keeps being tracked) |
| `/autokick status` | Settings, lists, and how many members are past the limit |
| `/autokick preview` | Who would be kicked right now |
| `/autokick check member:` | One member's last activity and status |
| `/autokick days days:` | Change the limit (1–365 days, default 30) |
| `/autokick logchannel [channel:]` | Post kicks and setting changes in a channel (leave empty to turn off) |
| `/autokick whitelist add/remove/list` | Roles or members that are never kicked |
| `/autokick blacklist add/remove/list` | Roles or members that can be kicked even if they have a whitelisted role |
| `/autokick pause add/remove/list` | Roles that pause a member's clock while they have them (timeouts always do) |
| `/activity [member:]` | When you (or another member) last sent a message or was in voice (anyone can use it) |
| `/ping` | Check the bot is online and replying (anyone can use it) |

### Whitelist and blacklist

Everyone is checked for inactivity unless the whitelist protects them. When rules conflict, the more specific one wins:

1. Member on the **whitelist** → never kicked.
2. Member on the **blacklist** → can be kicked.
3. Has a **blacklisted role** → can be kicked, even if they also have a whitelisted role.
4. Has a **whitelisted role** → never kicked.
5. Otherwise → kicked once inactive past the limit.

Example: whitelist `@Members`, blacklist `@Trial`. Inactive members with `@Members` are safe, unless they also have `@Trial`.

---

## Setup

You need a Discord account, a free Cloudflare account, and [Node.js](https://nodejs.org) 20 or newer.

### 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. On **General Information**, copy the **Application ID** and **Public Key**.
3. On **Bot**:
   - Click **Reset Token** and copy the token. It's only shown once; treat it like a password.
   - Under **Privileged Gateway Intents**, turn on **Server Members Intent**. Message Content Intent is *not* needed.

### 2. Deploy to Cloudflare

In this folder:

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

The deploy prints your Worker's address, like `https://autokick.<your-name>.workers.dev`. Then add the two secrets; each command asks you to paste the value:

```bash
npx wrangler secret put DISCORD_TOKEN
```

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
```

### 3. Point Discord at the Worker

Back in the Developer Portal, **General Information** → **Interactions Endpoint URL**, enter:

```
https://autokick.<your-name>.workers.dev/interactions
```

Click **Save**. Discord sends a test request, and it only saves if the Worker answers correctly.

### 4. Invite the bot

Open this link, with your Application ID filled in, and pick your server:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=19458
```

This grants Kick Members, View Channels, Send Messages and Embed Links.

Then in **Server Settings → Roles**, drag the bot's role **above** the roles of everyone it should be able to kick.

### 5. Check it's running

Open `https://autokick.<your-name>.workers.dev/`. You should see `"connected": true`. If `problem` isn't `null`, it tells you what to fix. The bot starts within a few minutes of deploying; opening this page also wakes it.

The `/autokick` commands appear about a minute after the bot first connects. If you don't see them, reload Discord (Ctrl+R).

### 6. Try it

1. `/autokick status`
2. `/autokick logchannel channel:#mod-log` (optional)
3. `/autokick preview`
4. `/autokick enable`

---

## Putting it on GitHub

- `.gitignore` already keeps secrets and build files out. **Never commit your bot token.** It lives only in Cloudflare (`wrangler secret put`).
- **Auto-deploy on push:** in the Cloudflare dashboard, open **Workers & Pages → autokick → Settings → Build** and connect your GitHub repository. Every push to your main branch redeploys. Secrets stay in Cloudflare.
- A deploy briefly restarts the bot. It reconnects on its own and Discord replays anything it missed.

## Cost and limits

- **Free plan:** one copy of this bot fits in Workers Free. Its Durable Object stays awake 24/7, using about 11,000 of the 13,000 "GB-seconds" Cloudflare gives free each day. So don't run another always-on Durable Object on the same free account. If you ever hit the limits, Workers Paid ($5/month) covers this bot many times over.
- The free plan allows 50 Discord API calls per run, so big batches of kicks are spread out (about 10 per minute).
- Very large servers (roughly 40,000+ members) may need Workers Paid for `/autokick status` and `preview` to finish.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `problem` mentions **Server Members Intent** | Turn it on (step 1), then wait up to 10 minutes. |
| `problem` says the **token was rejected** | Reset the token in the portal, then `npx wrangler secret put DISCORD_TOKEN` again. |
| Discord won't save the Interactions Endpoint URL | Check `DISCORD_PUBLIC_KEY` is set and the URL ends in `/interactions`. |
| `preview` says it **can't kick** someone | Move the bot's role above theirs, and make sure it has Kick Members. |
| Commands don't show up | Wait a minute after the first connect, then reload Discord. Check the status page says connected. |

Logs: Cloudflare dashboard → **Workers & Pages → autokick → Logs**, or run `npx wrangler tail`.

## Development

```bash
npm test
```

`npm run dev` runs the Worker locally (copy `.dev.vars.example` to `.dev.vars` first). Slash commands need a public URL though, so test those on the deployed Worker.

### How it fits together

| File | Role |
| --- | --- |
| `src/index.js` | Worker entry: receives slash commands (`/interactions`), status page, 5-minute cron that keeps the bot running |
| `src/bot.js` | Durable Object: stays connected to Discord, stores activity in SQLite, checks for inactive members hourly and kicks them |
| `src/commands.js` | The `/autokick` command definition and replies |
| `src/policy.js` | The kick rules (whitelist/blacklist, inactivity, downtime) |
| `src/discord.js` | Discord API calls and the "can the bot kick this member" check |
| `src/verify.js` | Checks Discord's signature on incoming slash commands |
