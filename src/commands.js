// /autokick slash command: definition (registered automatically) and handlers.
// Handlers only talk to the `api` object the Durable Object passes in, so they
// can be tested without Discord or Cloudflare.

import {
  ACTION_DONE,
  actionOf,
  DAY_MS,
  escapeMarkdown,
  formatDuration,
  slowmodeScale,
  slowmodeSettings,
} from './policy.js';
import { snowflakeTime } from './discord.js';
import { LINK_COMMAND, runLinkCommand } from './link-commands.js';
import { MAX_SLOWMODE_CHANNELS } from './slowmode.js';
import { formatList, resolveTarget, targetOptions } from './targets.js';

const SUB = 1;
const GROUP = 2;
const STRING = 3;
const INTEGER = 4;
const USER = 6;
const CHANNEL = 7;
const ROLE = 8;
const MENTIONABLE = 9;
const MANAGE_GUILD = String(1 << 5);
const COLOR = 0x5865f2;

function listGroup(name, description) {
  const target = (verb) => targetOptions(verb, MENTIONABLE, STRING);
  return {
    type: GROUP,
    name,
    description,
    options: [
      { type: SUB, name: 'add', description: `Add a role or member to the ${name}`, options: target('add') },
      { type: SUB, name: 'remove', description: `Remove a role or member from the ${name}`, options: target('remove') },
      { type: SUB, name: 'list', description: `Show the ${name}` },
      { type: SUB, name: 'reset', description: `Clear the whole ${name}` },
    ],
  };
}

// Text, voice, category, announcement, threads, stage, forum, media.
const LISTABLE_CHANNEL_TYPES = [0, 2, 4, 5, 10, 11, 12, 13, 15, 16];
const CATEGORY = 4;

function channelListGroup(name, description) {
  const label = name.replace('-', ' ');
  const channel = (verb) => [
    {
      type: CHANNEL,
      name: 'channel',
      description: `Channel, category or thread to ${verb}`,
      required: true,
      channel_types: LISTABLE_CHANNEL_TYPES,
    },
  ];
  return {
    type: GROUP,
    name,
    description,
    options: [
      { type: SUB, name: 'add', description: `Add a channel or category to the ${label}`, options: channel('add') },
      { type: SUB, name: 'remove', description: `Remove a channel or category from the ${label}`, options: channel('remove') },
      { type: SUB, name: 'list', description: `Show the ${label}` },
      { type: SUB, name: 'reset', description: `Clear the whole ${label}` },
    ],
  };
}

const ACTION_CHOICES = [
  { name: 'Kick (default)', value: 'kick' },
  { name: 'Give/take roles (set them with /autokick inactive-roles)', value: 'role' },
  { name: 'Temporary ban (unbanned automatically)', value: 'tempban' },
  { name: 'Soft ban (kick + delete their last 7 days of messages)', value: 'softban' },
];

// Text, voice and stage channels (the ones with a chat that slow mode applies to).
const SLOWMODE_CHANNEL_TYPES = [0, 2, 13];

const slowmodeTargetOptions = (verb) => [
  { type: CHANNEL, name: 'channel', description: `Channel to ${verb}`, channel_types: SLOWMODE_CHANNEL_TYPES },
  ...targetOptions(verb, MENTIONABLE, STRING),
];

const roleOption = (description) => [{ type: ROLE, name: 'role', description, required: true }];

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
        name: 'warn',
        description: 'DM members this many days before they are kicked (0 turns warnings off)',
        options: [
          {
            type: INTEGER,
            name: 'days',
            description: 'Days of notice before a kick (0 = off)',
            required: true,
            min_value: 0,
            max_value: 364,
          },
        ],
      },
      {
        type: SUB,
        name: 'action',
        description: 'Choose what happens to inactive members (default: kick)',
        options: [
          { type: STRING, name: 'type', description: 'What to do once someone is past the limit', required: true, choices: ACTION_CHOICES },
          {
            type: INTEGER,
            name: 'ban-days',
            description: 'For a temporary ban: how many days it lasts (default 7)',
            min_value: 1,
            max_value: 365,
          },
        ],
      },
      {
        type: GROUP,
        name: 'inactive-roles',
        description: 'Roles given to or taken from inactive members (for the give/take roles action)',
        options: [
          { type: SUB, name: 'give', description: 'Give this role to members when they go inactive', options: roleOption('Role to give') },
          {
            type: SUB,
            name: 'take',
            description: 'Take this role away from members when they go inactive',
            options: roleOption('Role to take away'),
          },
          { type: SUB, name: 'unset', description: 'Stop giving or taking this role', options: roleOption('Role to stop using') },
          { type: SUB, name: 'list', description: 'Show the roles given and taken' },
          { type: SUB, name: 'reset', description: 'Stop giving or taking any roles' },
        ],
      },
      {
        type: SUB,
        name: 'quickleave',
        description: 'Temporarily ban people who leave right after joining (minutes 0 turns it off)',
        options: [
          {
            type: INTEGER,
            name: 'minutes',
            description: 'Leaving within this many minutes of joining counts (0 = off)',
            required: true,
            min_value: 0,
            max_value: 1440,
          },
          {
            type: INTEGER,
            name: 'ban-days',
            description: 'How many days the ban lasts (default 7)',
            min_value: 1,
            max_value: 365,
          },
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
      channelListGroup('channel-whitelist', 'If set, only activity in these channels/categories counts'),
      channelListGroup('channel-blacklist', "Activity in these channels/categories doesn't count"),
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
      {
        type: GROUP,
        name: 'slowmode',
        description: "Automatic slow mode whitelist: channels it runs in, roles/users whose messages don't count",
        options: [
          {
            type: SUB,
            name: 'add',
            description: "Whitelist a channel (to manage) or a role/member (their messages don't count)",
            options: [
              ...slowmodeTargetOptions('add'),
              { type: INTEGER, name: 'min-seconds', description: 'Channels: slow mode when chat is quiet (default 0 = off)', min_value: 0, max_value: 21600 },
              { type: INTEGER, name: 'max-seconds', description: 'Channels: most slow mode when chat is busiest (default 30)', min_value: 1, max_value: 21600 },
              {
                type: STRING,
                name: 'sensitivity',
                description: 'Channels: how easily it kicks in (default Normal)',
                choices: [
                  { name: 'Low (needs twice as many messages)', value: 'low' },
                  { name: 'Normal', value: 'normal' },
                  { name: 'High (kicks in at half as many messages)', value: 'high' },
                ],
              },
              { type: INTEGER, name: 'calm-minutes', description: 'Channels: calm minutes before it eases off (default 3)', min_value: 1, max_value: 30 },
            ],
          },
          {
            type: SUB,
            name: 'remove',
            description: 'Take a channel, role or member off the slow mode whitelist',
            options: slowmodeTargetOptions('remove'),
          },
          { type: SUB, name: 'list', description: 'Show the slow mode whitelist and how busy each channel is' },
          { type: SUB, name: 'reset', description: 'Clear the slow mode whitelist (channels get their old slow mode back)' },
        ],
      },
    ],
  },
  LINK_COMMAND,
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
    // Past the limit, but warnings are on and their notice hasn't run out (or they haven't been warned yet).
    waiting: results.filter((r) => r.result.action === 'keep' && r.result.reason === 'notice'),
    blocked: results.filter((r) => r.result.action === 'blocked'),
  };
}

const warnSetting = (cfg) => (cfg.warnDays ? `${plural(cfg.warnDays, 'day')} before a kick` : 'Off');

const quickLeaveOf = (cfg) => cfg.quickLeave ?? { minutes: 0, banDays: 7 };

function quickLeaveSetting(cfg, active) {
  const { minutes, banDays } = quickLeaveOf(cfg);
  if (!minutes) return 'Off';
  return `Leave within ${plural(minutes, 'minute')} → ${banDays}-day ban (${active} banned right now)`;
}

const NO_BAN_PERMISSION =
  "⚠️ I don't have the **Ban Members** permission, so quick-leave bans can't happen. " +
  'Give my role Ban Members in Server Settings → Roles.';
const NO_AUDIT_LOG =
  "⚠️ I can't see the audit log, so people a moderator (or a verification bot) kicks soon after they join " +
  'get banned too. Give my role **View Audit Log** so I can tell them apart.';

function formatPauseRoles(cfg, detected = []) {
  const items = [
    ...cfg.pauseRoles.map((id) => `<@&${id}>`),
    ...detected.filter((id) => !cfg.pauseRoles.includes(id)).map((id) => `<@&${id}> (auto)`),
  ];
  return items.length ? items.join(', ').slice(0, 1000) : 'None';
}

function formatChannelRules(cfg) {
  const { whitelist, blacklist } = cfg.channels;
  if (!whitelist.length && !blacklist.length) return 'Every channel counts';
  const ids = (list) => list.map((id) => `<#${id}>`).join(', ');
  const lines = [];
  if (whitelist.length) lines.push(`Only: ${ids(whitelist)}`);
  if (blacklist.length) lines.push(`Ignored: ${ids(blacklist)}`);
  return lines.join('\n').slice(0, 1000);
}

/** `hidden`: channel ids, null (bot's own roles unknown) or undefined (check failed). */
function formatHidden(hidden) {
  if (!hidden) return "Couldn't check right now.";
  if (!hidden.length) return 'None ✅ I can see every channel that counts.';
  const help = '\nGive my role **View Channel** in these (or give me Administrator).';
  let text = '';
  for (const [i, id] of hidden.entries()) {
    const item = `<#${id}>`;
    if (text.length + item.length + help.length > 980) {
      text += ` …and ${hidden.length - i} more`;
      break;
    }
    text += (text ? ', ' : '') + item;
  }
  return text + help;
}

const CHANNEL_RULES =
  'Blacklisted channels never count. If the channel whitelist has anything in it, only whitelisted channels count. ' +
  'A category covers every channel in it, and threads follow their channel. The most specific entry wins, ' +
  'so you can blacklist a category but whitelist one channel inside it.';

const MAX_ACTION_ROLES = 5;
const roleMentions = (ids) => ids.map((id) => `<@&${id}>`).join(', ');

/** Wording for the configured inactivity action. */
function actionWords(cfg) {
  const action = actionOf(cfg);
  const done = ACTION_DONE[action.type] ?? 'kicked';
  switch (action.type) {
    case 'tempban':
      return {
        action,
        done,
        full: `banned for ${plural(action.banDays, 'day')}`,
        verb: 'ban',
        can: 'ban them',
        perm: 'Ban Members',
        label: `Temporary ban (${plural(action.banDays, 'day')})`,
      };
    case 'softban':
      return {
        action,
        done,
        full: 'soft-banned (removed, with their last 7 days of messages deleted)',
        verb: 'soft-ban',
        can: 'soft-ban them',
        perm: 'Ban Members',
        label: 'Soft ban (removes them and deletes their last 7 days of messages)',
      };
    case 'role': {
      const parts = [];
      if (action.give.length) parts.push(`given ${roleMentions(action.give)}`);
      if (action.take.length) parts.push(`stripped of ${roleMentions(action.take)}`);
      const label = [
        action.give.length ? `give ${roleMentions(action.give)}` : '',
        action.take.length ? `take ${roleMentions(action.take)}` : '',
      ].filter(Boolean);
      return {
        action,
        done,
        full: parts.join(' and ') || 'marked inactive (no roles set yet)',
        verb: 'change the roles of',
        can: 'change their roles',
        perm: 'Manage Roles',
        label: label.length
          ? `Change roles: ${label.join(', ')}`
          : 'Change roles (none set yet: use `/autokick inactive-roles`)',
      };
    }
    default:
      return { action, done, full: 'kicked', verb: 'kick', can: 'kick them', perm: 'Kick Members', label: 'Kick' };
  }
}

/** Why the bot can't carry out the action on someone. */
function blockedHelp(cfg) {
  const w = actionWords(cfg);
  if (w.action.type === 'role') {
    const roles = [...w.action.give, ...w.action.take];
    if (!roles.length) return 'no roles are set. Use `/autokick inactive-roles give` or `take`.';
    return `I need **Manage Roles**, and my role has to be above ${roleMentions(roles)}. Drag my role higher in Server Settings → Roles.`;
  }
  return `they have a role above mine (or I'm missing ${w.perm}). Drag my role higher in Server Settings → Roles.`;
}

const NOT_CONNECTED =
  "⚠️ I'm not connected to Discord right now, so new activity isn't being recorded. Open the bot's status page to see why.";

/**
 * Warning when the bot can't carry out the action on most of the members it
 * might need to (not bots, the owner or whitelisted members): usually a missing
 * permission or the bot's role sitting too low. Returns null when it's fine.
 * `assessed` is what api.assessGuild() returned (botCanAct, rolesAboveBot).
 */
function actionPowerWarning(results, assessed, cfg) {
  const w = actionWords(cfg);
  const candidates = results.filter((r) => !['skip', 'protected', 'done'].includes(r.result.action));
  if (!candidates.length) return null;
  if (w.action.type === 'role') {
    if (!w.action.give.length && !w.action.take.length) {
      return (
        '⚠️ The action is **give/take roles**, but no roles are set, so nothing happens to inactive members. ' +
        'Use `/autokick inactive-roles give` or `take`.'
      );
    }
    if (assessed.botCanAct === false) {
      return "⚠️ I don't have the **Manage Roles** permission, so I can't change anyone's roles. Give my role Manage Roles in Server Settings → Roles.";
    }
    const above = assessed.rolesAboveBot ?? [];
    if (!above.length) return null;
    return (
      `⚠️ I can't give or take ${roleMentions(above)}: my role has to be above ${above.length === 1 ? 'it' : 'them'}. ` +
      'Drag my role higher in Server Settings → Roles.'
    );
  }
  if (assessed.botCanAct === false) {
    return (
      `⚠️ I don't have the **${w.perm}** permission, so I can't ${w.verb} anyone. ` +
      `Give my role ${w.perm} in Server Settings → Roles.`
    );
  }
  const unkickable = candidates.filter((r) => !r.result.kickable).length;
  if (unkickable * 2 <= candidates.length) return null;
  return (
    `⚠️ I can't ${w.verb} most members (${unkickable} of ${candidates.length}), probably because their roles are above mine. ` +
    `Drag my role higher in Server Settings → Roles, above the roles of members who should be ${w.done}.`
  );
}

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
    const assessed = await api.assessGuild();
    const { results } = assessed;
    const { due, waiting, blocked } = tally(results);
    const powerWarning = actionPowerWarning(results, assessed, cfg);
    const w = actionWords(cfg);

    const lines = [
      wasOn ? '✅ AutoKick was already **on**.' : '✅ **AutoKick is on.**',
      `Members are ${w.full} after **${cfg.days} days** without sending a message or being in a voice channel.` +
        (cfg.warnDays ? ` They get a warning DM ${plural(cfg.warnDays, 'day')} before.` : ''),
    ];
    const earliest = cfg.trackingSince + cfg.days * DAY_MS;
    if (earliest > Date.now()) {
      lines.push(
        `• I started tracking activity ${ts(cfg.trackingSince, 'D')}, so nobody can be ${w.done} before ${ts(earliest, 'D')}.`,
      );
    }
    const past = due.length + waiting.length;
    if (past) {
      const when =
        cfg.warnDays && !due.length
          ? `They get a warning DM first (no sooner than ${ts(firstKickAt(cfg, api))}) and are ${w.done} ` +
            `${plural(cfg.warnDays, 'day')} later if they stay inactive.`
          : `They'll be ${w.done} no sooner than ${ts(firstKickAt(cfg, api))}.`;
      lines.push(
        `• **${plural(past, 'member')}** ${past === 1 ? 'is' : 'are'} past the limit. ${when} ` +
          'Use `/autokick preview` to see who, or `/autokick disable` to stop.',
      );
    } else {
      lines.push('• Nobody is past the limit right now.');
    }
    if (powerWarning) lines.push(powerWarning);
    else if (blocked.length) {
      lines.push(`⚠️ ${plural(blocked.length, 'inactive member')} can't be ${w.done}: ${blockedHelp(cfg)}`);
    }
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
    const assessed = await api.assessGuild();
    const { cfg, results, detectedPauseRoles, botCanBan, botCanViewAuditLog } = assessed;
    const { due, waiting, blocked } = tally(results);
    const w = actionWords(cfg);
    const quickLeaveOn = Boolean(quickLeaveOf(cfg).minutes);
    const pastNotes = [];
    if (waiting.length) pastNotes.push(`${waiting.length} still in their warning period`);
    if (blocked.length) pastNotes.push(`+${blocked.length} I can't ${w.verb}`);
    const muted = results.filter((r) => r.result.action === 'paused').length;
    const marked = results.filter((r) => r.result.action === 'done').length;
    const powerWarning = actionPowerWarning(results, assessed, cfg);
    const hidden = await api.hiddenChannels().catch(() => undefined);
    const now = Date.now();
    let state = 'Off';
    if (cfg.enabled) state = cfg.armedAt > now ? `On (starts ${ts(cfg.armedAt)})` : 'On';

    const embed = {
      title: 'AutoKick status',
      color: COLOR,
      fields: [
        { name: 'AutoKick', value: state, inline: true },
        { name: 'Inactivity limit', value: plural(cfg.days, 'day'), inline: true },
        { name: 'Action when inactive', value: w.label },
        { name: 'Warning DM', value: warnSetting(cfg), inline: true },
        { name: 'Log channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set', inline: true },
        { name: 'Tracking since', value: ts(cfg.trackingSince, 'D'), inline: true },
        { name: 'Next check', value: cfg.enabled ? ts(firstKickAt(cfg, api)) : '—', inline: true },
        {
          name: 'Past the limit',
          value: `${due.length + waiting.length}${pastNotes.length ? ` (${pastNotes.join(', ')})` : ''}`,
          inline: true,
        },
        { name: 'Muted right now (clock paused)', value: String(muted), inline: true },
        ...(w.action.type === 'role' || marked
          ? [{ name: 'Marked inactive (roles changed)', value: String(marked), inline: true }]
          : []),
        { name: 'Quick-leave bans', value: quickLeaveSetting(cfg, api.tempBanCount()) },
        { name: 'Whitelist (never kicked)', value: formatList(cfg.whitelist) },
        { name: 'Blacklist (kickable even with a whitelisted role)', value: formatList(cfg.blacklist) },
        { name: 'Pause roles (plus anyone timed out)', value: formatPauseRoles(cfg, detectedPauseRoles) },
        { name: 'Channels where activity counts', value: formatChannelRules(cfg) },
        { name: "Channels I can't see", value: formatHidden(hidden) },
      ],
      footer: {
        text:
          'Activity = sending messages or being in a voice channel (not deafened, not the AFK channel). ' +
          "Time spent timed out or with a pause role doesn't count.",
      },
    };
    const warnings = [];
    if (!api.connected()) warnings.push(NOT_CONNECTED);
    if (powerWarning) warnings.push(powerWarning);
    if (quickLeaveOn && botCanBan === false) warnings.push(NO_BAN_PERMISSION);
    else if (quickLeaveOn && botCanViewAuditLog === false) warnings.push(NO_AUDIT_LOG);
    if (hidden?.length) {
      warnings.push(
        `⚠️ I can't see ${plural(hidden.length, 'channel')}, so activity there isn't tracked and people ` +
          'who only talk there will look inactive. Details below.',
      );
    }
    return { content: warnings.join('\n') || undefined, embeds: [embed] };
  },

  async preview({ api }) {
    const { cfg, results } = await api.assessGuild();
    const { due, waiting, blocked } = tally(results);
    const w = actionWords(cfg);
    if (!due.length && !waiting.length && !blocked.length) {
      return { content: `Nobody has been inactive for ${plural(cfg.days, 'day')} or more. ✨` };
    }
    const longestFirst = (a, b) => b.result.inactiveMs - a.result.inactiveMs;
    due.sort(longestFirst);
    waiting.sort(longestFirst);

    const line = ({ member, result }) =>
      `• <@${member.id}> (${escapeMarkdown(member.username)}): inactive ${formatDuration(result.inactiveMs)}` +
      (result.recorded ? `, last seen ${ts(result.lastActive)}` : ', no activity recorded');
    const noticeLine = (entry) =>
      line(entry) +
      (entry.result.warning
        ? `. Warned ${ts(entry.result.warning.at)}, ${w.done} ${ts(Date.now() + entry.result.remainingMs)}`
        : '. Not warned yet');

    const parts = [];
    if (due.length) {
      parts.push(
        cfg.enabled
          ? `**${plural(due.length, 'member')} will be ${w.full}** (no sooner than ${ts(firstKickAt(cfg, api))}):`
          : `**${plural(due.length, 'member')} would be ${w.full}**. AutoKick is off, so nothing happens until \`/autokick enable\`.`,
      );
      parts.push(...due.map(line));
    }
    if (waiting.length) {
      if (parts.length) parts.push('');
      parts.push(
        `**${plural(waiting.length, 'member')} past the limit ${waiting.length === 1 ? 'is' : 'are'} in their warning period** ` +
          `(${w.done} once it ends, if they're still inactive):`,
      );
      parts.push(...waiting.map(noticeLine));
    }
    if (blocked.length) {
      if (parts.length) parts.push('');
      parts.push(`**${plural(blocked.length, 'member')} past the limit that I can't ${w.verb}**: ${blockedHelp(cfg)}`);
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
    const w = actionWords(cfg);

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
            ? `🔴 Past the limit. Will be ${w.full} at the next check (${ts(firstKickAt(cfg, api))}).`
            : '🔴 Past the limit, but AutoKick is off.',
        );
        break;
      case 'blocked':
        lines.push(`🟠 Past the limit, but I can't ${w.can}: ${blockedHelp(cfg)}`);
        break;
      case 'done':
        lines.push(`🏷️ Marked inactive ${ts(result.markedAt)} (roles changed). They get their roles back once they're active again.`);
        break;
      case 'keep': {
        const kickAt = Date.now() + result.remainingMs;
        const past = result.reason === 'notice' ? 'Past the limit. ' : '';
        if (result.warning) {
          const missed = result.warning.delivered ? '' : " (their DMs are closed, so it didn't reach them)";
          lines.push(`🟡 ${past}Warned ${ts(result.warning.at)}${missed}. Will be ${w.done} ${ts(kickAt)} if they stay inactive.`);
        } else if (result.warnNow) {
          const send = cfg.enabled
            ? `Gets a warning DM at the next check (${ts(firstKickAt(cfg, api))})`
            : 'Would get a warning DM now, but AutoKick is off';
          lines.push(`🟡 ${past}${send}, and can't be ${w.done} until ${plural(cfg.warnDays, 'day')} after it.`);
        } else {
          const warnFirst = cfg.warnDays ? ` They'd get a warning DM ${plural(cfg.warnDays, 'day')} before.` : '';
          lines.push(`🟢 Fine for now. Would be ${w.done} ${ts(kickAt)} if they stay inactive.${warnFirst}`);
        }
        break;
      }
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

    // Admin-only details: blacklist and whether the bot could act on them at all.
    if (result.listed?.reason === 'blacklisted member') {
      lines.push("📛 Blacklisted (as a member), so whitelisted roles don't protect them.");
    } else if (result.listed?.reason === 'blacklisted role') {
      lines.push(`📛 Blacklisted through the role <@&${result.listed.roleId}>, so whitelisted roles don't protect them.`);
    }
    if (result.action !== 'skip' && result.action !== 'blocked') {
      lines.push(result.kickable ? `👢 I can ${w.can}.` : `🚫 I can't ${w.can}: ${blockedHelp(cfg)}`);
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
    // A warning has to come before the kick; if it no longer fits, turn warnings off and say so.
    const droppedWarn = cfg.warnDays && cfg.warnDays >= cfg.days ? cfg.warnDays : 0;
    if (droppedWarn) cfg.warnDays = 0;
    api.saveConfig(cfg);
    await api
      .log(
        `⚙️ Inactivity limit changed from ${previous} to ${cfg.days} days by <@${userId}>.` +
          (droppedWarn ? ' Warning DMs turned off (they no longer fit before the limit).' : ''),
      )
      .catch(() => {});

    const { due, waiting } = tally((await api.assessGuild()).results);
    const past = due.length + waiting.length;
    const w = actionWords(cfg);
    const after = cfg.enabled
      ? ` Nobody is ${w.done} before ${ts(firstKickAt(cfg, api))}.`
      : ` AutoKick is off, so nobody will be ${w.done} until \`/autokick enable\`.`;
    const lines = [
      `✅ Members will now be ${w.full} after **${plural(cfg.days, 'day')}** of inactivity. ` +
        `${plural(past, 'member')} ${past === 1 ? 'is' : 'are'} past that right now.${after}`,
    ];
    if (droppedWarn) {
      lines.push(
        `⚠️ Warning DMs were set to ${plural(droppedWarn, 'day')} before a kick, which doesn't fit in a ` +
          `${plural(cfg.days, 'day')} limit, so I turned them off. Set them again with \`/autokick warn\`.`,
      );
    }
    return { content: lines.join('\n') };
  },

  async warn({ api, opts, userId }) {
    const cfg = api.getConfig();
    const days = opts.days;
    const previous = cfg.warnDays ?? 0;
    if (days >= cfg.days) {
      return {
        content:
          `❌ The warning has to come before the kick, so it must be less than the **${plural(cfg.days, 'day')}** limit. ` +
          'Pick a smaller number, or raise the limit first with `/autokick days`.',
      };
    }
    if (days === previous) {
      return { content: days ? `Warning DMs are already set to ${plural(days, 'day')} before a kick.` : 'Warning DMs are already **off**.' };
    }
    cfg.warnDays = days;
    api.saveConfig(cfg);
    await api
      .log(
        days
          ? `⚙️ Warning DMs set to ${plural(days, 'day')} before a kick by <@${userId}>.`
          : `⚙️ Warning DMs turned off by <@${userId}>.`,
      )
      .catch(() => {});

    const w = actionWords(cfg);
    if (!days) {
      return {
        content:
          `✅ Warning DMs are **off**. Members only get a DM when they are ${w.done}. ` +
          `Anyone already warned keeps the date they were given, so they won't be ${w.done} before it.`,
      };
    }
    const lines = [
      `✅ Members now get a DM **${plural(days, 'day')}** before they're ${w.done}, and can't be ${w.done} until ` +
        `${plural(days, 'day')} after it, even if they're already past the limit.`,
      'If they send a message or join voice before then, their clock resets and the warning no longer counts.',
      `Members with DMs closed can't receive it; they're still ${w.done} on the same schedule.`,
    ];
    if (!cfg.enabled) lines.push('AutoKick is off, so no warnings go out until `/autokick enable`.');
    return { content: lines.join('\n') };
  },

  async quickleave({ api, opts, userId }) {
    const cfg = api.getConfig();
    const previous = quickLeaveOf(cfg);
    const minutes = opts.minutes;
    const banDays = opts['ban-days'] ?? previous.banDays;

    if (!minutes) {
      if (!previous.minutes) return { content: 'Quick-leave bans are already **off**.' };
      cfg.quickLeave = { ...previous, minutes: 0 };
      api.saveConfig(cfg);
      await api.log(`⚙️ Quick-leave bans turned off by <@${userId}>.`).catch(() => {});
      return { content: '✅ Quick-leave bans are **off**. Bans already placed still end on their own date.' };
    }

    cfg.quickLeave = { minutes, banDays };
    api.saveConfig(cfg);
    await api
      .log(
        `⚙️ Quick-leave bans set by <@${userId}>: leaving within ${plural(minutes, 'minute')} of joining ` +
          `means a ${banDays}-day ban.`,
      )
      .catch(() => {});

    const lines = [
      `✅ Anyone who leaves within **${plural(minutes, 'minute')}** of joining gets banned for **${plural(banDays, 'day')}**, ` +
        "then unbanned automatically. This works whether or not inactivity kicks are on.",
      'Bots and whitelisted members are never banned. Bans show up in Server Settings → Bans with the date they end; ' +
        'unban someone there to let them back early.',
    ];
    const perms = await api.botPermissions().catch(() => null);
    if (perms && !perms.ban) lines.push(NO_BAN_PERMISSION);
    else if (perms && !perms.auditLog) lines.push(NO_AUDIT_LOG);
    return { content: lines.join('\n') };
  },

  async action({ api, opts, userId }) {
    const cfg = api.getConfig();
    const previous = actionOf(cfg);
    const type = opts.type;
    const banDays = opts['ban-days'] ?? previous.banDays;
    if (type === previous.type && banDays === previous.banDays) {
      return { content: `The action is already **${actionWords(cfg).label}**.` };
    }
    cfg.action = { ...previous, type, banDays };
    // A different action can suddenly apply to everyone already past the limit
    // (including members marked by the role action): same one-hour window as enabling.
    const changedType = type !== previous.type;
    if (cfg.enabled && changedType) cfg.armedAt = Math.max(cfg.armedAt ?? 0, Date.now() + api.enableGraceMs);
    api.saveConfig(cfg);
    const w = actionWords(cfg);
    await api.log(`⚙️ Inactivity action changed to **${w.label}** by <@${userId}>.`).catch(() => {});

    const lines = [`✅ Inactive members will now be **${w.full}** after ${plural(cfg.days, 'day')} without activity.`];
    if (type === 'tempban') lines.push("They're unbanned automatically when it ends, and can rejoin with an invite.");
    if (type === 'softban') {
      lines.push(
        'A soft ban bans and immediately unbans them: they leave the server, their messages from the last 7 days ' +
          'are deleted, and they can rejoin with an invite.',
      );
    }
    if (type === 'role') {
      lines.push(
        w.action.give.length || w.action.take.length
          ? "Members stay in the server. Their roles are changed back as soon as they're active again."
          : '⚠️ No roles are set yet, so nothing happens to inactive members until you add some with ' +
              '`/autokick inactive-roles give` or `take`.',
      );
    }
    if (previous.type === 'role' && changedType) {
      lines.push("Members already marked inactive are due for the new action too (their roles still go back if they're active).");
    }

    const perms = await api.botPermissions().catch(() => null);
    if (perms) {
      const missing = { kick: !perms.kick, tempban: !perms.ban, softban: !perms.ban, role: !perms.manageRoles }[type];
      if (missing) lines.push(`⚠️ I don't have the **${w.perm}** permission yet. Give my role ${w.perm} in Server Settings → Roles.`);
      else if (type === 'role' && perms.rolesAboveBot.length) {
        lines.push(`⚠️ My role has to be above ${roleMentions(perms.rolesAboveBot)} to give or take it. Drag my role higher in Server Settings → Roles.`);
      }
    }
    if (cfg.enabled && changedType) {
      lines.push(`To give you time to check \`/autokick preview\`, nothing happens before ${ts(cfg.armedAt)}.`);
    }
    return { content: lines.join('\n') };
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
      await api.log(`📋 AutoKick will post kicks, warnings and setting changes here (set by <@${userId}>).`);
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
  if (listName !== 'whitelist' && listName !== 'blacklist') return { content: 'Unknown command.' };
  const cfg = api.getConfig();
  if (action === 'list') {
    const title = listName === 'whitelist' ? 'Whitelist (never kicked)' : 'Blacklist (kickable even with a whitelisted role)';
    return { embeds: [{ title, color: COLOR, description: formatList(cfg[listName]) }] };
  }

  if (action === 'reset') {
    const count = cfg[listName].roles.length + cfg[listName].users.length;
    if (!count) return { content: `The ${listName} is already empty.` };
    const cleared = formatList(cfg[listName]);
    cfg[listName] = { roles: [], users: [] };
    let grace = '';
    if (listName === 'whitelist' && cfg.enabled) {
      // People who were protected may now be past the limit: same one-hour window as enabling.
      cfg.armedAt = Math.max(cfg.armedAt ?? 0, Date.now() + api.enableGraceMs);
      grace = ` Anyone who was protected can't be kicked before ${ts(cfg.armedAt)}.`;
    }
    api.saveConfig(cfg);
    await api.log(`⚙️ <@${userId}> cleared the ${listName}.`).catch(() => {});
    return { content: `✅ Cleared the ${listName} (${count} ${count === 1 ? 'entry' : 'entries'}: ${cleared}).${grace}` };
  }

  // Either a picked role/member, or a pasted user ID (for someone who isn't in the server).
  const target = resolveTarget(opts, interaction);
  if (target.error) return { content: target.error };
  const { id, isRole, mention } = target;
  if (id === interaction.guild_id) {
    return { content: "@everyone can't go on a list. To stop all kicks, use `/autokick disable`." };
  }
  const kind = isRole ? 'roles' : 'users';
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

const seconds = (n) => (n === 0 ? 'off' : n < 60 || n % 60 ? `${n}s` : `${n / 60}m`);
const SENSITIVITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High' };
const scaleText = (sensitivity) =>
  slowmodeScale(sensitivity)
    .map(([messages, s], i) => `${messages}+${i === 0 ? ' messages a minute' : ''} → ${seconds(s)}`)
    .join(', ');
const CHANNEL_SETTINGS = ['min-seconds', 'max-seconds', 'sensitivity', 'calm-minutes'];
const BYPASS_TIP =
  "They're still slowed like everyone else. To let them skip slow mode too, give them Discord's **Bypass Slowmode** " +
  'permission (Server Settings → Roles, or the channel\'s permissions).';

/** Restore a channel's slow mode to what it was before the bot managed it. Returns true if it worked. */
const restoreSlowmode = (api, channelId, entry) =>
  api.setSlowmode(channelId, entry.original ?? 0, 'AutoKick: automatic slow mode turned off').catch(() => false);

/**
 * /autokick slowmode: one whitelist. Channels on it get automatic slow mode;
 * messages from roles and users on it don't count toward how busy chat is.
 */
async function editSlowmode({ api, opts, interaction, userId }, sub) {
  const cfg = api.getConfig();
  const settings = slowmodeSettings(cfg);
  const save = () => {
    cfg.slowmode = settings;
    api.saveConfig(cfg);
  };

  if (sub === 'list') {
    const lines = Object.entries(settings.channels).map(([id, c]) => {
      const sensitivity = c.sensitivity ?? 'normal';
      return (
        `• <#${id}>: ${seconds(c.min ?? 0)} to ${seconds(c.max ?? 30)}, ${SENSITIVITY_LABEL[sensitivity]} sensitivity, ` +
        `eases off after ${plural(c.calm ?? 3, 'calm minute')}. ${api.messageRate(id)} counted messages in the last minute.`
      );
    });
    return {
      embeds: [
        {
          title: 'Automatic slow mode whitelist',
          color: COLOR,
          fields: [
            { name: 'Channels (slow mode follows how busy they are)', value: (lines.join('\n') || 'None yet. Add one with `/autokick slowmode add channel:`.').slice(0, 1024) },
            { name: "Roles and members (their messages don't count)", value: formatList(settings) },
          ],
          footer: { text: `Normal scale: ${scaleText('normal')}. High sensitivity needs half the messages, Low twice as many.` },
        },
      ],
    };
  }

  if (sub === 'reset') {
    const channelIds = Object.keys(settings.channels);
    const count = channelIds.length + settings.roles.length + settings.users.length;
    if (!count) return { content: 'The slow mode whitelist is already empty.' };
    let restored = 0;
    for (const id of channelIds) if (await restoreSlowmode(api, id, settings.channels[id])) restored += 1;
    cfg.slowmode = { channels: {}, roles: [], users: [] };
    api.saveConfig(cfg);
    await api.log(`⚙️ <@${userId}> cleared the slow mode whitelist.`).catch(() => {});
    const failed = channelIds.length - restored;
    return {
      content:
        `✅ Cleared the slow mode whitelist (${count} ${count === 1 ? 'entry' : 'entries'}). ` +
        (channelIds.length ? `${plural(restored, 'channel')} got their old slow mode back.` : '') +
        (failed ? ` ${plural(failed, 'channel')} couldn't be put back, so check them by hand.` : ''),
    };
  }

  // add / remove: a channel, or a role/member/user ID.
  const channelId = opts.channel;
  if (channelId && (opts.target || opts['user-id'])) {
    return { content: '❌ One at a time: a channel, **or** a role/member/user ID.' };
  }
  if (!channelId && !opts.target && !opts['user-id']) {
    return { content: '❌ Pick a channel, a role or member, or paste a user ID.' };
  }
  if (!channelId && CHANNEL_SETTINGS.some((name) => opts[name] !== undefined)) {
    return { content: '❌ `min-seconds`, `max-seconds`, `sensitivity` and `calm-minutes` only apply to channels.' };
  }

  if (!channelId) {
    const target = resolveTarget(opts, interaction);
    if (target.error) return { content: target.error };
    if (target.id === interaction.guild_id) return { content: "@everyone can't go on the slow mode whitelist." };
    const kind = target.isRole ? 'roles' : 'users';
    const listed = settings[kind].includes(target.id);
    if (sub === 'add') {
      if (listed) return { content: `${target.mention} is already on the slow mode whitelist.` };
      settings[kind] = [...settings[kind], target.id];
      save();
      await api.log(`⚙️ <@${userId}> added ${target.mention} to the slow mode whitelist.`).catch(() => {});
      return {
        content:
          `✅ Messages from ${target.mention}${target.isRole ? ' (everyone with it)' : ''} no longer count toward how busy chat is, ` +
          `so they can't set off slow mode.\n${BYPASS_TIP}`,
      };
    }
    if (!listed) return { content: `${target.mention} isn't on the slow mode whitelist.` };
    settings[kind] = settings[kind].filter((x) => x !== target.id);
    save();
    await api.log(`⚙️ <@${userId}> removed ${target.mention} from the slow mode whitelist.`).catch(() => {});
    return { content: `✅ Messages from ${target.mention} count toward how busy chat is again.` };
  }

  if (sub === 'remove') {
    const entry = settings.channels[channelId];
    if (!entry) return { content: `<#${channelId}> isn't on the slow mode whitelist.` };
    delete settings.channels[channelId];
    save();
    await api.log(`⚙️ <@${userId}> turned off automatic slow mode in <#${channelId}>.`).catch(() => {});
    return {
      content:
        `✅ Automatic slow mode is off in <#${channelId}>. ` +
        ((await restoreSlowmode(api, channelId, entry))
          ? `Slow mode is back to what it was before (${seconds(entry.original ?? 0)}).`
          : "I couldn't put its slow mode back, so set it by hand if needed."),
    };
  }

  // Add a channel, or change its settings.
  const existing = settings.channels[channelId];
  if (!existing && Object.keys(settings.channels).length >= MAX_SLOWMODE_CHANNELS) {
    return { content: `❌ Up to ${MAX_SLOWMODE_CHANNELS} channels can have automatic slow mode.` };
  }
  const min = opts['min-seconds'] ?? existing?.min ?? 0;
  const max = opts['max-seconds'] ?? existing?.max ?? 30;
  const sensitivity = opts.sensitivity ?? existing?.sensitivity ?? 'normal';
  const calm = opts['calm-minutes'] ?? existing?.calm ?? 3;
  if (min > max) return { content: `❌ The minimum (${seconds(min)}) can't be more than the maximum (${seconds(max)}).` };
  const original = existing ? existing.original : await api.channelSlowmode(channelId).catch(() => 0);
  settings.channels[channelId] = { min, max, sensitivity, calm, original };
  save();
  await api
    .log(
      `⚙️ <@${userId}> ${existing ? 'changed' : 'turned on'} automatic slow mode in <#${channelId}> ` +
        `(${seconds(min)} to ${seconds(max)}, ${SENSITIVITY_LABEL[sensitivity]} sensitivity).`,
    )
    .catch(() => {});

  const lines = [
    `✅ ${existing ? 'Updated' : "I'll manage"} slow mode in <#${channelId}>: **${seconds(min)}** when it's quiet, ` +
      `up to **${seconds(max)}** when it's busy, **${SENSITIVITY_LABEL[sensitivity]}** sensitivity.`,
    `Scale: ${scaleText(sensitivity)}. It goes up within a minute of chat speeding up and eases off after ` +
      `${plural(calm, 'calm minute')} in a row.`,
    'If a moderator changes the slow mode by hand, I leave that channel alone for 30 minutes.',
  ];
  const perms = await api.botPermissions().catch(() => null);
  if (perms && !perms.manageChannels) {
    lines.push("⚠️ I don't have the **Manage Channels** permission, so I can't change slow mode yet. Give my role Manage Channels.");
  }
  return { content: lines.join('\n') };
}

/** /autokick inactive-roles: which roles the role action gives and takes. */
async function editInactiveRoles({ api, opts, interaction, userId }, sub) {
  const cfg = api.getConfig();
  const action = actionOf(cfg);
  const notRoleAction =
    action.type === 'role'
      ? ''
      : `\nThe action is **${actionWords(cfg).label}** right now. Switch with \`/autokick action type:Give/take roles\`.`;

  if (sub === 'list') {
    return {
      embeds: [
        {
          title: 'Inactive roles',
          color: COLOR,
          description:
            `**Given:** ${action.give.length ? roleMentions(action.give) : 'None'}\n` +
            `**Taken away:** ${action.take.length ? roleMentions(action.take) : 'None'}\n\n` +
            "Used when the action is give/take roles. Changes are undone as soon as the member is active again." +
            notRoleAction,
        },
      ],
    };
  }
  if (sub === 'reset') {
    if (!action.give.length && !action.take.length) return { content: 'No inactive roles are set.' };
    cfg.action = { ...action, give: [], take: [] };
    api.saveConfig(cfg);
    await api.log(`⚙️ <@${userId}> cleared the inactive roles.`).catch(() => {});
    return { content: "✅ Cleared the inactive roles. Members already marked still get their roles back once they're active." };
  }

  const id = opts.role;
  const mention = `<@&${id}>`;
  if (id === interaction.guild_id) return { content: "@everyone can't be given or taken away." };

  if (sub === 'unset') {
    if (!action.give.includes(id) && !action.take.includes(id)) return { content: `${mention} isn't given or taken.` };
    cfg.action = { ...action, give: action.give.filter((x) => x !== id), take: action.take.filter((x) => x !== id) };
    api.saveConfig(cfg);
    await api.log(`⚙️ <@${userId}> stopped using ${mention} as an inactive role.`).catch(() => {});
    return { content: `✅ ${mention} is no longer given or taken. Members already marked still get their roles put back once they're active.` };
  }

  const list = sub === 'give' ? 'give' : 'take';
  const other = list === 'give' ? 'take' : 'give';
  if (action[list].includes(id)) return { content: `${mention} is already ${list === 'give' ? 'given' : 'taken away'}.` };
  if (action[list].length >= MAX_ACTION_ROLES) {
    return { content: `❌ You can ${list} at most ${MAX_ACTION_ROLES} roles. Remove one with \`/autokick inactive-roles unset\` first.` };
  }
  const moved = action[other].includes(id);
  cfg.action = { ...action, [list]: [...action[list], id], [other]: action[other].filter((x) => x !== id) };
  api.saveConfig(cfg);
  await api.log(`⚙️ <@${userId}> set ${mention} to be ${list === 'give' ? 'given to' : 'taken from'} inactive members.`).catch(() => {});

  const lines = [
    list === 'give'
      ? `✅ Inactive members will be given ${mention}.`
      : `✅ Inactive members will have ${mention} taken away. Make sure they can still talk or join voice somewhere, or they can't become active again.`,
  ];
  if (moved) lines.push(`(It was set to be ${other === 'give' ? 'given' : 'taken away'}; not anymore.)`);
  const perms = await api.botPermissions().catch(() => null);
  if (perms && !perms.manageRoles) lines.push("⚠️ I don't have the **Manage Roles** permission yet. Give my role Manage Roles in Server Settings → Roles.");
  else if (perms?.rolesAboveBot.includes(id)) lines.push(`⚠️ My role has to be above ${mention} to ${list} it. Drag my role higher in Server Settings → Roles.`);
  return { content: lines.join('\n') + notRoleAction };
}

const CHANNEL_LISTS = { 'channel-whitelist': 'whitelist', 'channel-blacklist': 'blacklist' };

async function editChannelList({ api, opts, interaction, userId }, group, action) {
  const listName = CHANNEL_LISTS[group];
  const other = listName === 'whitelist' ? 'blacklist' : 'whitelist';
  const label = `channel ${listName}`;
  const cfg = api.getConfig();
  const list = cfg.channels[listName];

  if (action === 'list') {
    const title = listName === 'whitelist' ? 'Channel whitelist (only these count)' : "Channel blacklist (these don't count)";
    const items = list.length ? list.map((id) => `<#${id}>`).join(', ').slice(0, 3000) : 'None';
    return { embeds: [{ title, color: COLOR, description: `${items}\n\n${CHANNEL_RULES}` }] };
  }

  if (action === 'reset') {
    if (!list.length) return { content: `The ${label} is already empty.` };
    const count = list.length;
    cfg.channels[listName] = [];
    api.saveConfig(cfg);
    await api.log(`⚙️ <@${userId}> cleared the ${label}.`).catch(() => {});
    const everywhere = cfg.channels.whitelist.length || cfg.channels.blacklist.length ? '' : ' Activity in every channel counts again.';
    return { content: `✅ Cleared the ${label} (${plural(count, 'channel')}).${everywhere}` };
  }

  const id = opts.channel;
  const resolved = interaction.data.resolved?.channels?.[id];
  const where =
    resolved?.type === CATEGORY ? `the **${escapeMarkdown(resolved.name)}** category (every channel in it)` : `<#${id}>`;

  if (action === 'add') {
    if (list.includes(id)) return { content: `${where} is already on the ${label}.` };
    const firstWhitelisted = listName === 'whitelist' && list.length === 0;
    list.push(id);
    const moved = cfg.channels[other].includes(id);
    cfg.channels[other] = cfg.channels[other].filter((x) => x !== id);
    api.saveConfig(cfg);
    await api.log(`⚙️ <@${userId}> added <#${id}> to the ${label}.`).catch(() => {});

    const lines = [
      (listName === 'whitelist' ? `✅ Activity in ${where} counts.` : `✅ Activity in ${where} no longer counts.`) +
        (moved ? ` (Removed it from the channel ${other}.)` : ''),
    ];
    if (firstWhitelisted) {
      lines.push(
        '⚠️ This is the first whitelisted channel, so from now on **only** activity in whitelisted channels counts. ' +
          'Use `/autokick channel-whitelist reset` to undo.',
      );
    }
    lines.push('This only affects activity from now on; activity already recorded stays.');
    return { content: lines.join('\n') };
  }

  if (!list.includes(id)) return { content: `${where} isn't on the ${label}.` };
  cfg.channels[listName] = list.filter((x) => x !== id);
  api.saveConfig(cfg);
  await api.log(`⚙️ <@${userId}> removed <#${id}> from the ${label}.`).catch(() => {});
  const nowEmpty =
    listName === 'whitelist' && !cfg.channels.whitelist.length
      ? ' The channel whitelist is now empty, so activity counts everywhere except blacklisted channels.'
      : '';
  return { content: `✅ Removed ${where} from the ${label}.${nowEmpty}` };
}

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
  if (interaction.data.name === 'link') return runLinkCommand(ctx, group, sub?.name);
  if (group === 'pause') return editPauseRoles(ctx, sub.name);
  if (group === 'inactive-roles') return editInactiveRoles(ctx, sub.name);
  if (group === 'slowmode') return editSlowmode(ctx, sub.name);
  if (Object.hasOwn(CHANNEL_LISTS, group ?? '')) return editChannelList(ctx, group, sub.name);
  if (group) return editList(ctx, group, sub.name);
  const handler = handlers[sub.name];
  return handler ? handler(ctx) : { content: 'Unknown command.' };
}
