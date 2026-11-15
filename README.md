# AutoKick

A Discord bot that kicks members who haven't **sent a message** or **been in a voice channel** for a set number of days (30 by default). It runs entirely on **Cloudflare Workers**, on the free plan, with no server or PC to keep on.

## What counts as activity

- Sending a message anywhere in the server: channels, threads, forum posts, replies.
- Being in a voice channel: joining, leaving, switching, or just sitting in it. Being muted still counts. Being **deafened** doesn't (self-deafened or by a moderator), and neither does the server's AFK channel.
- You can limit which channels count with the [channel whitelist and blacklist](#channel-whitelist-and-blacklist).

## Muted members

It isn't fair to count time against someone who wasn't allowed to talk. While a member is **timed out**, or has a **pause role**, their inactivity clock stops. It picks up where it left off once the mute ends; it doesn't restart from zero. Nobody is kicked while they're muted.

Pause roles are any role named like "Muted" or "Mute" (picked up automatically), plus any roles you add with `/autokick pause add`, such as an "On Break" role.

## What happens to inactive members

Choose with `/autokick action type:`. Kicking is the default.

| Action | What it does | Bot needs |
| --- | --- | --- |
| **Kick** | Removes them. They can rejoin with an invite. | Kick Members |
| **Give/take roles** | They stay, but get the roles you set with `/autokick inactive-roles give` and lose the ones set with `take` (up to 5 each), for example give "Inactive" and take "Member". As soon as they're active again the bot undoes exactly what it changed. | Manage Roles, and its role above every role it gives or takes |
| **Temporary ban** | Bans them for `ban-days` (default 7), then unbans them automatically. | Ban Members |
| **Soft ban** | Bans and immediately unbans them: they're removed, and their messages from the last 7 days are deleted. They can rejoin with an invite. | Ban Members |

With the role action, make sure inactive members can still send a message or join voice somewhere (a "welcome back" channel, say). Otherwise they can't become active again to get their roles back.

Members get a DM explaining what happened (if their DMs are open), and everything is posted in the log channel. Switching the action while AutoKick is on starts a new one-hour grace period.

## Who is never kicked

- Bots and the server owner.
- Anyone whose highest role is above the bot's role (Discord won't allow it). This doesn't apply to the role action, which only needs the bot's role above the roles it gives or takes.
- Whitelisted members and roles (see [Whitelist and blacklist](#whitelist-and-blacklist)).

## Safety features

- **Off by default.** Nothing gets kicked until someone runs `/autokick enable`.
- **One-hour grace period** after enabling (or lowering the day limit), so you can check `/autokick preview` and back out with `/autokick disable`.
- **Clean slate when the bot joins.** The bot can't see history from before it was added, so everyone's clock starts on the day it started tracking. New members' clocks start when they join.
- **Bot downtime isn't held against anyone.** If the bot is offline for a while, that time isn't counted as inactivity.
- Kicked members get a DM (if their DMs are open) saying why and that they can rejoin.
- **Optional warning DM** before a kick: `/autokick warn days:7` messages members 7 days before they'd be kicked (`days:0` turns it off; it's off by default). Nobody is kicked until the date their warning gave them, even if they were already past the limit when warnings were turned on. One warning per stretch of inactivity: being active again resets it. Members with DMs closed are still kicked on the same schedule. Warnings go out at most 10 per minute per server, and are posted in the log channel.

## Quick-leave bans

Optional, off by default, and separate from inactivity kicks (it works even while `/autokick` is disabled). `/autokick quickleave minutes:10 ban-days:7` bans anyone who leaves within 10 minutes of joining for 7 days, then unbans them automatically. `minutes:0` turns it off.

- It stops the same people from bouncing in and out again. It can't stop someone's first join and leave, because they're already gone by then.
- Never banned: bots and whitelisted members. Someone who rejoins before the ban goes out (within about a minute) isn't banned.
- People kicked by a moderator or another bot (a verification bot, say) aren't banned, as long as the bot has **View Audit Log** so it can tell a kick from a leave.
- The bot needs **Ban Members**. `/autokick status` warns if either permission is missing.
- Bans show up in Server Settings → Bans with the date they end. Unban someone there to let them back early. If a moderator replaces the ban with their own, the bot leaves it in place.
- Bans and unbans are posted in the log channel.

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
| `/autokick action type: [ban-days:]` | What happens to inactive members: kick (default), give/take roles, temporary ban, or soft ban |
| `/autokick inactive-roles give/take/unset/list/reset` | Roles given to or taken from inactive members (for the give/take roles action) |
| `/autokick warn days:` | DM members this many days before they're kicked (0 = off, the default) |
| `/autokick quickleave minutes: [ban-days:]` | Temporarily ban people who leave within that many minutes of joining (0 = off, the default; ban 7 days unless set) |
| `/autokick logchannel [channel:]` | Post kicks, warnings, bans and setting changes in a channel (leave empty to turn off) |
| `/autokick whitelist add/remove/list/reset` | Roles or members that are never kicked. `add`/`remove` take a role or member, or a `user-id` for someone not in the server |
| `/autokick blacklist add/remove/list/reset` | Roles or members that can be kicked even if they have a whitelisted role (same options as the whitelist) |
| `/autokick channel-whitelist add/remove/list/reset` | If set, only activity in these channels/categories counts |
| `/autokick channel-blacklist add/remove/list/reset` | Activity in these channels/categories doesn't count |
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

`reset` clears a whole list. Clearing the whitelist while AutoKick is on restarts the one-hour grace period, so people who were protected aren't kicked straight away.

### Channel whitelist and blacklist

These control **where activity counts**, for messages and voice alike:

- **Blacklisted** channels never count, for example a counting or spam channel.
- If the **channel whitelist** has anything in it, *only* whitelisted channels count.
- A **category** covers every channel in it, and **threads and forum posts** follow their channel.
- The most specific entry wins. You can blacklist a whole category but whitelist one channel inside it.

Changes only affect activity from then on; activity already recorded stays. The bot only sees messages in channels it has **View Channel** access to, so make sure it can see every channel that should count. `/autokick status` warns about any channel it can't see, leaving out channels your channel lists already ignore.

## Invite

Open this link, with your Application ID filled in, and pick your server:

```
https://discord.com/oauth2/authorize?client_id=1570482569844097064
```

Then in **Server Settings → Roles**, drag the bot's role **above** the roles of everyone it should be able to kick.

## Check if the bot is running

Open `https://autokick.mackery.com/`. You should see `"connected": true`. If `problem` isn't `null`, it tells you what to fix. The bot starts within a few minutes of deploying; opening this page also wakes it.

The `/autokick` commands appear about a minute after the bot first connects. If you don't see them, reload Discord (Ctrl+R).

## Getting started

1. `/autokick status`
2. `/autokick logchannel channel:#mod-log` (optional)
3. `/autokick preview`
4. `/autokick enable`

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
