// /autokick slash command: definition (registered automatically) and handlers.
// Handlers only talk to the `api` object the Durable Object passes in, so they
// can be tested without Discord or Cloudflare.

import { DAY_MS, escapeMarkdown, formatDuration } from './policy.js';

const SUB = 1;
const GROUP = 2;
const INTEGER = 4;
const USER = 6;
const CHANNEL = 7;
const ROLE = 8;
const MENTIONABLE = 9;
const MANAGE_GUILD = String(1 << 5);
const COLOR = 0x5865f2;

function listGroup(name, description) {
  const target = (verb) => [
    { type: MENTIONABLE, name: 'target', description: `Role or member to ${verb}`, required: true },
  ];
  return {
    type: GROUP,
    name,
    description,
    options: [
      { type: SUB, name: 'add', description: `Add a role or member to the ${name}`, options: target('add') },
      { type: SUB, name: 'remove', description: `Remove a role or member from the ${name}`, options: target('remove') },
      { type: SUB, name: 'list', description: `Show the ${name}` },
    ],
  };
}

export const COMMANDS = [
  {
    name: 'autokick',
    description: 'Kick members who have been inactive (no messages, no voice) for too long',
    default_member_permissions: MANAGE_GUILD, // only people with Manage Server see it by default
    contexts: [0], // servers only
    integration_types: [0],
    options: [
      { type: SUB, name: 'enable', description: 'Turn auto-kicking on for this server' },
      { type: SUB, name: 'disable', description: 'Turn auto-kicking off (activity keeps being tracked)' },
      { type: SUB, name: 'status', description: 'Show settings and how many members are past the limit' },
      { type: SUB, name: 'preview', description: 'List members who would be kicked right now' },
      {
        type: SUB,
        name: 'check',
        description: "Show one member's last activity",
        options: [{ type: USER, name: 'member', description: 'Member to check', required: true }],
      },
      {
        type: SUB,
        name: 'days',
        description: 'Set how many days of inactivity before a kick (default 30)',
        options: [
          { type: INTEGER, name: 'days', description: 'Number of days (1-365)', required: true, min_value: 1, max_value: 365 },
        ],
      },
      {
        type: SUB,
        name: 'logchannel',
        description: 'Set where kicks are logged (leave empty to turn logging off)',
        options: [
          { type: CHANNEL, name: 'channel', description: 'Text channel for kick logs', channel_types: [0, 5] },
        ],
      },
      listGroup('whitelist', 'Roles and members that are never auto-kicked'),
      listGroup('blacklist', 'Roles and members that can be kicked even with a whitelisted role'),
      {
        type: GROUP,
        name: 'pause',
        description: "Roles that pause a member's clock, like a Muted role (timeouts always pause)",
        options: [
          {
            type: SUB,
            name: 'add',
            description: 'Add a pause role',
            options: [{ type: ROLE, name: 'role', description: 'Role that pauses the clock', required: true }],
          },
          {
            type: SUB,
            name: 'remove',
            description: 'Remove a pause role',
            options: [{ type: ROLE, name: 'role', description: 'Role to remove', required: true }],
          },
          { type: SUB, name: 'list', description: 'Show pause roles' },
        ],
      },
    ],
  },
  {
    name: 'activity',
    description: 'See when you or another member was last active',
    contexts: [0],
    integration_types: [0],
    options: [{ type: USER, name: 'member', description: 'Member to look up (default: you)' }],
  },
  {
    name: 'ping',
    description: 'Check that the bot is online and replying',
    contexts: [0],
    integration_types: [0],
  },
];

export const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name));

// ---------------------------------------------------------------- helpers

const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function tally(results) {
  return {
    due: results.filter((r) => r.result.action === 'kick'),
    blocked: results.filter((r) => r.result.action === 'blocked'),
  };
}

function formatList(list) {
  const items = [...list.roles.map((id) => `<@&${id}>`), ...list.users.map((id) => `<@${id}>`)];
  if (!items.length) return 'None';
  let text = '';
  for (const [i, item] of items.entries()) {
    if (text.length + item.length > 950) return `${text} …and ${items.length - i} more`;
    text += (text ? ', ' : '') + item;
  }
  return text;
}

function formatPauseRoles(cfg, detected = []) {
  const items = [
    ...cfg.pauseRoles.map((id) => `<@&${id}>`),
    ...detected.filter((id) => !cfg.pauseRoles.includes(id)).map((id) => `<@&${id}> (auto)`),
  ];
  return items.length ? items.join(', ').slice(0, 1000) : 'None';
}

const BLOCKED_HELP =
  "they have a role above mine (or I'm missing Kick Members). Drag my role higher in Server Settings → Roles.";
const NOT_CONNECTED =
  "⚠️ I'm not connected to Discord right now, so new activity isn't being recorded. Open the bot's status page to see why.";

/** When the next kicks can happen, taking the post-enable grace period into account. */
function firstKickAt(cfg, api) {
  return Math.max(cfg.armedAt ?? 0, api.nextSweepAt());
}

// ---------------------------------------------------------------- handlers

const handlers = {
  async enable({ api, userId }) {
    const cfg = api.getConfig();
    const wasOn = cfg.enabled;
    if (!wasOn) {
      cfg.enabled = true;
      cfg.armedAt = Date.now() + api.enableGraceMs;
      api.saveConfig(cfg);
      await api.log(`▶️ AutoKick turned on by <@${userId}>.`).catch(() => {});
    }
    const { results } = await api.assessGuild();
    const { due, blocked } = tally(results);

    const lines = [
      wasOn ? '✅ AutoKick was already **on**.' : '✅ **AutoKick is on.**',
      `Members are kicked after **${cfg.days} days** without sending a message or being in a voice channel.`,
    ];
    const earliest = cfg.trackingSince + cfg.days * DAY_MS;
    if (earliest > Date.now()) {
      lines.push(
        `• I started tracking activity ${ts(cfg.trackingSince, 'D')}, so nobody can be kicked before ${ts(earliest, 'D')}.`,
      );
    }
    if (due.length) {
      lines.push(
        `• **${plural(due.length, 'member')}** ${due.length === 1 ? 'is' : 'are'} past the limit. ` +
          `Kicks start no sooner than ${ts(firstKickAt(cfg, api))}. ` +
          'Use `/autokick preview` to see who, or `/autokick disable` to stop.',
      );
    } else {
      lines.push('• Nobody is past the limit right now.');
    }
    if (blocked.length) lines.push(`⚠️ ${plural(blocked.length, 'inactive member')} can't be kicked: ${BLOCKED_HELP}`);
    if (!api.connected()) lines.push(NOT_CONNECTED);
    return { content: lines.join('\n') };
  },

  async disable({ api, userId }) {
    const cfg = api.getConfig();
    if (!cfg.enabled) return { content: 'AutoKick is already **off**.' };
    cfg.enabled = false;
    cfg.armedAt = null;
    api.saveConfig(cfg);
    await api.log(`⏸️ AutoKick turned off by <@${userId}>.`).catch(() => {});
    return {
      content: "⏸️ **AutoKick is off.** I'll keep tracking activity, so turning it back on picks up where it left off.",
    };
  },

  async status({ api }) {
    const { cfg, results, detectedPauseRoles } = await api.assessGuild();
    const { due, blocked } = tally(results);
    const muted = results.filter((r) => r.result.action === 'paused').length;
    const now = Date.now();
    let state = 'Off';
    if (cfg.enabled) state = cfg.armedAt > now ? `On (kicks start ${ts(cfg.armedAt)})` : 'On';

    const embed = {
      title: 'AutoKick status',
      color: COLOR,
      fields: [
        { name: 'Auto-kick', value: state, inline: true },
        { name: 'Inactivity limit', value: plural(cfg.days, 'day'), inline: true },
        { name: 'Log channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set', inline: true },
        { name: 'Tracking since', value: ts(cfg.trackingSince, 'D'), inline: true },
        { name: 'Next check', value: cfg.enabled ? ts(firstKickAt(cfg, api)) : '—', inline: true },
        {
          name: 'Past the limit',
          value: `${due.length}${blocked.length ? ` (+${blocked.length} I can't kick)` : ''}`,
          inline: true,
        },
        { name: 'Muted right now (clock paused)', value: String(muted), inline: true },
        { name: 'Whitelist (never kicked)', value: formatList(cfg.whitelist) },
        { name: 'Blacklist (kickable even with a whitelisted role)', value: formatList(cfg.blacklist) },
        { name: 'Pause roles (plus anyone timed out)', value: formatPauseRoles(cfg, detectedPauseRoles) },
      ],
      footer: {
        text:
          'Activity = sending messages or being in a voice channel (not deafened, not the AFK channel). ' +
          "Time spent timed out or with a pause role doesn't count.",
      },
    };
    const content = api.connected() ? undefined : NOT_CONNECTED;
    return { content, embeds: [embed] };
  },

  async preview({ api }) {
    const { cfg, results } = await api.assessGuild();
    const { due, blocked } = tally(results);
    if (!due.length && !blocked.length) {
      return { content: `Nobody has been inactive for ${plural(cfg.days, 'day')} or more. ✨` };
    }
    due.sort((a, b) => b.result.inactiveMs - a.result.inactiveMs);

    const line = ({ member, result }) =>
      `• <@${member.id}> (${escapeMarkdown(member.username)}): inactive ${formatDuration(result.inactiveMs)}` +
      (result.recorded ? `, last seen ${ts(result.lastActive)}` : ', no activity recorded');

    const parts = [];
    if (due.length) {
      parts.push(
        cfg.enabled
          ? `**${plural(due.length, 'member')} will be kicked** (no sooner than ${ts(firstKickAt(cfg, api))}):`
          : `**${plural(due.length, 'member')} would be kicked**. AutoKick is off, so nothing happens until \`/autokick enable\`.`,
      );
      parts.push(...due.map(line));
    }
    if (blocked.length) {
      parts.push('', `**${plural(blocked.length, 'member')} past the limit that I can't kick**: ${BLOCKED_HELP}`);
      parts.push(...blocked.map(line));
    }

    let description = '';
    for (const [i, part] of parts.entries()) {
      if (description.length + part.length > 3900) {
        description += `\n…and ${parts.length - i} more.`;
        break;
      }
      description += (description ? '\n' : '') + part;
    }
    return { embeds: [{ title: `Inactive for ${plural(cfg.days, 'day')}+`, color: COLOR, description }] };
  },

  async check({ api, opts }) {
    const found = await api.assessMember(opts.member);
    if (!found) return { content: `<@${opts.member}> isn't in this server.` };
    const { member, result } = found;
    const cfg = api.getConfig();

    const lines = [`**${escapeMarkdown(member.username)}** (<@${member.id}>)`];
    if (result.recorded) {
      lines.push(`Last activity: ${ts(result.lastActive)}`);
    } else {
      const from = result.lastActive === cfg.trackingSince ? 'when I started tracking' : 'when they joined';
      lines.push(`Last activity: none recorded. Counting from ${ts(result.lastActive, 'D')} (${from}).`);
    }
    lines.push(`Counted inactivity: ${formatDuration(result.inactiveMs)} (limit ${plural(cfg.days, 'day')})`);
    if (result.pausedMs >= 60_000) lines.push(`Muted time not counted: ${formatDuration(result.pausedMs)}`);

    switch (result.action) {
      case 'paused':
        lines.push(
          `⏸️ Clock paused: ${result.reason === 'timeout' ? "they're timed out" : 'they have a pause role'}. ` +
            `${formatDuration(result.remainingMs)} left once that ends.`,
        );
        break;
      case 'kick':
        lines.push(
          cfg.enabled
            ? `🔴 Past the limit. Will be kicked at the next check (${ts(firstKickAt(cfg, api))}).`
            : '🔴 Past the limit, but AutoKick is off.',
        );
        break;
      case 'blocked':
        lines.push(`🟠 Past the limit, but I can't kick them: ${BLOCKED_HELP}`);
        break;
      case 'keep':
        lines.push(`🟢 Fine for now. Would be kicked ${ts(Date.now() + result.remainingMs)} if they stay inactive.`);
        break;
      case 'protected':
        lines.push(
          result.reason === 'whitelisted role'
            ? `🛡️ Protected by the whitelisted role <@&${result.roleId}>.`
            : '🛡️ Protected: they are on the whitelist.',
        );
        break;
      default:
        lines.push(result.reason === 'bot' ? '🤖 Bots are never kicked.' : '👑 The server owner is never kicked.');
    }
    return { content: lines.join('\n') };
  },

  async days({ api, opts, userId }) {
    const cfg = api.getConfig();
    const previous = cfg.days;
    cfg.days = opts.days;
    // Lowering the limit while on could suddenly make lots of people kickable:
    // give admins the same one-hour window as when turning it on.
    if (cfg.enabled && cfg.days < previous) cfg.armedAt = Math.max(cfg.armedAt ?? 0, Date.now() + api.enableGraceMs);
    api.saveConfig(cfg);
    await api.log(`⚙️ Inactivity limit changed from ${previous} to ${cfg.days} days by <@${userId}>.`).catch(() => {});

    const { due } = tally((await api.assessGuild()).results);
    const after = cfg.enabled
      ? ` Kicks start no sooner than ${ts(firstKickAt(cfg, api))}.`
      : ' AutoKick is off, so nobody will be kicked until `/autokick enable`.';
    return {
      content:
        `✅ Members will now be kicked after **${plural(cfg.days, 'day')}** of inactivity. ` +
        `${plural(due.length, 'member')} ${due.length === 1 ? 'is' : 'are'} past that right now.${after}`,
    };
  },

  async logchannel({ api, opts, userId }) {
    const cfg = api.getConfig();
    if (!opts.channel) {
      cfg.logChannelId = null;
      api.saveConfig(cfg);
      return { content: 'Kick logging is now **off**.' };
    }
    const previous = cfg.logChannelId;
    cfg.logChannelId = opts.channel;
    api.saveConfig(cfg);
    try {
      await api.log(`📋 AutoKick will post kicks and setting changes here (set by <@${userId}>).`);
    } catch (err) {
      cfg.logChannelId = previous;
      api.saveConfig(cfg);
      return {
        content:
          `❌ I couldn't post in <#${opts.channel}> (${err.message}). ` +
          'Give me View Channel and Send Messages there, then try again.',
      };
    }
    return { content: `✅ Kicks will be logged in <#${opts.channel}>.` };
  },
};

const LIST_EXPLAINERS = {
  whitelist: {
    roles: (m) => `Members with ${m} will never be auto-kicked (unless they're blacklisted or have a blacklisted role).`,
    users: (m) => `${m} will never be auto-kicked.`,
  },
  blacklist: {
    roles: (m) =>
      `Members with ${m} can be auto-kicked for inactivity even if they also have a whitelisted role ` +
      '(individually whitelisted members stay protected).',
    users: (m) => `${m} can be auto-kicked for inactivity even if they have a whitelisted role.`,
  },
};

async function editList({ api, opts, interaction, userId }, listName, action) {
  const cfg = api.getConfig();
  if (action === 'list') {
    const title = listName === 'whitelist' ? 'Whitelist (never kicked)' : 'Blacklist (kickable even with a whitelisted role)';
    return { embeds: [{ title, color: COLOR, description: formatList(cfg[listName]) }] };
  }

  const id = opts.target;
  const isRole = Boolean(interaction.data.resolved?.roles?.[id]);
  if (isRole && id === interaction.guild_id) {
    return { content: "@everyone can't go on a list. To stop all kicks, use `/autokick disable`." };
  }
  const kind = isRole ? 'roles' : 'users';
  const mention = isRole ? `<@&${id}>` : `<@${id}>`;
  const other = listName === 'whitelist' ? 'blacklist' : 'whitelist';
  const list = cfg[listName][kind];

  if (action === 'add') {
    if (list.includes(id)) return { content: `${mention} is already on the ${listName}.` };
    list.push(id);
    const moved = cfg[other][kind].includes(id);
    cfg[other][kind] = cfg[other][kind].filter((x) => x !== id);
    api.saveConfig(cfg);
    await api.log(`⚙️ <@${userId}> added ${mention} to the ${listName}.`).catch(() => {});
    return {
      content:
        `✅ Added ${mention} to the ${listName}${moved ? ` (and removed it from the ${other})` : ''}. ` +
        LIST_EXPLAINERS[listName][kind](mention),
    };
  }

  if (!list.includes(id)) return { content: `${mention} isn't on the ${listName}.` };
  cfg[listName][kind] = list.filter((x) => x !== id);
  api.saveConfig(cfg);
  await api.log(`⚙️ <@${userId}> removed ${mention} from the ${listName}.`).catch(() => {});
  return { content: `✅ Removed ${mention} from the ${listName}.` };
}

async function editPauseRoles({ api, opts, interaction, userId }, action) {
  const cfg = api.getConfig();
  const detected = await api.detectedPauseRoles();
  if (action === 'list') {
    return {
      embeds: [
        {
          title: 'Pause roles',
          color: COLOR,
          description:
            `${formatPauseRoles(cfg, detected)}\n\n` +
            "While a member has one of these roles, or is timed out, their inactivity clock is stopped and they can't be kicked. " +
            'Roles named like "Muted" are picked up automatically.',
        },
      ],
    };
  }

  const id = opts.role;
  const mention = `<@&${id}>`;
  if (id === interaction.guild_id) return { content: "@everyone can't be a pause role. Use `/autokick disable` instead." };

  if (action === 'add') {
    if (cfg.pauseRoles.includes(id)) return { content: `${mention} is already a pause role.` };
    cfg.pauseRoles.push(id);
    api.saveConfig(cfg);
    await api.log(`⚙️ <@${userId}> added ${mention} as a pause role.`).catch(() => {});
    return {
      content: `✅ Members with ${mention} won't lose time while they have it, and can't be auto-kicked until it's removed.`,
    };
  }

  if (!cfg.pauseRoles.includes(id)) {
    return {
      content: detected.includes(id)
        ? `${mention} was picked up automatically because of its name, so it can't be removed. Rename the role if it shouldn't pause anyone.`
        : `${mention} isn't a pause role.`,
    };
  }
  cfg.pauseRoles = cfg.pauseRoles.filter((x) => x !== id);
  api.saveConfig(cfg);
  await api.log(`⚙️ <@${userId}> removed ${mention} as a pause role.`).catch(() => {});
  const still = detected.includes(id) ? ' It still counts automatically because of its name.' : '';
  return { content: `✅ ${mention} is no longer a pause role.${still}` };
}

/** Discord IDs encode their creation time. */
const snowflakeTime = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);

function ping(interaction, api) {
  const lines = ['🏓 **Pong!**'];
  if (interaction.id) {
    lines.push(`• Your command reached me in ${Math.max(0, Date.now() - snowflakeTime(interaction.id))} ms`);
  }
  const latency = api.latency();
  lines.push(
    api.connected()
      ? `• Connected to Discord${latency != null ? ` (heartbeat ${latency} ms)` : ''}`
      : "• ⚠️ Not connected to Discord right now, so activity isn't being tracked.",
  );
  return { content: lines.join('\n') };
}

/** /activity: anyone can see when a member was last active (nothing about lists or kicks). */
async function activity(interaction, api) {
  const self = interaction.member?.user?.id;
  const userId = interaction.data.options?.find((o) => o.name === 'member')?.value ?? self;
  const found = await api.assessMember(userId);
  if (!found) return { content: `<@${userId}> isn't in this server.` };
  const { member, result } = found;
  if (member.bot) return { content: "Bots aren't tracked." };

  const who = userId === self ? 'You were' : `**${escapeMarkdown(member.username)}** was`;
  if (result.recorded) {
    return { content: `${who} last active ${ts(result.lastActive)} (${ts(result.lastActive, 'f')}).` };
  }
  const since = result.lastActive === api.getConfig().trackingSince ? 'I started tracking' : 'joining';
  const subject = userId === self ? "You haven't" : `**${escapeMarkdown(member.username)}** hasn't`;
  return {
    content: `${subject} sent a message or been in voice since ${since} (${ts(result.lastActive, 'D')}).`,
  };
}

export async function runCommand(interaction, api) {
  if (interaction.data?.name === 'ping') return ping(interaction, api);
  if (interaction.data?.name === 'activity') return activity(interaction, api);
  const top = interaction.data?.options?.[0];
  if (!top) return { content: 'Unknown command.' };
  const group = top.type === GROUP ? top.name : null;
  const sub = group ? top.options?.[0] : top;
  const ctx = {
    api,
    interaction,
    userId: interaction.member?.user?.id,
    opts: Object.fromEntries((sub?.options ?? []).map((o) => [o.name, o.value])),
  };
  if (group === 'pause') return editPauseRoles(ctx, sub.name);
  if (group) return editList(ctx, group, sub.name);
  const handler = handlers[sub.name];
  return handler ? handler(ctx) : { content: 'Unknown command.' };
}
