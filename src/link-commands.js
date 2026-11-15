// /link: link servers to share bans, timeouts and roles. Both servers opt in:
// one makes a code, the other redeems it, and each chooses what it sends and
// accepts. The sharing itself happens in linking.js.

import { escapeMarkdown, LINK_KINDS, linkMode, linkSettings } from './policy.js';
import { formatList, resolveTarget, targetOptions } from './targets.js';

const SUB = 1;
const GROUP = 2;
const STRING = 3;
const ROLE = 8;
const MENTIONABLE = 9;
const MANAGE_GUILD = String(1 << 5);
const COLOR = 0x5865f2;
const MAX_SHARED_ROLES = 10;

const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const KIND_LABEL = { bans: 'Bans', timeouts: 'Timeouts', roles: 'Roles' };
const MODE_TEXT = {
  off: "doesn't send or accept them",
  send: "sends its own (but doesn't accept theirs)",
  receive: "accepts theirs (but doesn't send its own)",
  both: 'sends its own and accepts theirs',
};
const MODE_LABEL = { off: 'Off', send: 'Send', receive: 'Receive', both: 'Send + receive' };
const sends = (mode) => mode === 'send' || mode === 'both';
const receives = (mode) => mode === 'receive' || mode === 'both';

export const LINK_COMMAND = {
  name: 'link',
  description: 'Link servers to share bans, timeouts and roles (both servers have to opt in)',
  default_member_permissions: MANAGE_GUILD,
  contexts: [0],
  integration_types: [0],
  options: [
    { type: SUB, name: 'create', description: 'Make a one-time code another server can use to link with this one' },
    {
      type: SUB,
      name: 'join',
      description: 'Link with the server that gave you a code',
      options: [{ type: STRING, name: 'code', description: 'The code from /link create in the other server', required: true }],
    },
    { type: SUB, name: 'list', description: 'Show linked servers and what is shared' },
    {
      type: SUB,
      name: 'remove',
      description: 'Unlink a server',
      options: [{ type: STRING, name: 'server', description: 'Server name or ID (see /link list)', required: true }],
    },
    {
      type: SUB,
      name: 'share',
      description: 'Choose what this server sends to and accepts from linked servers',
      options: [
        {
          type: STRING,
          name: 'kind',
          description: 'What to share',
          required: true,
          choices: [
            { name: 'Bans', value: 'bans' },
            { name: 'Timeouts', value: 'timeouts' },
            { name: 'Roles (the ones added with /link roles)', value: 'roles' },
          ],
        },
        {
          type: STRING,
          name: 'mode',
          description: 'Off, send only, receive only, or both',
          required: true,
          choices: [
            { name: 'Off', value: 'off' },
            { name: 'Send (share ours with linked servers)', value: 'send' },
            { name: 'Receive (apply theirs here)', value: 'receive' },
            { name: 'Both', value: 'both' },
            { name: "Default (with server: follow this server's main setting again)", value: 'default' },
          ],
        },
        {
          type: STRING,
          name: 'server',
          description: 'Only for this linked server (name or ID). Leave empty to set the default for all',
        },
      ],
    },
    {
      type: GROUP,
      name: 'roles',
      description: 'Roles kept in sync with same-named roles in linked servers',
      options: [
        {
          type: SUB,
          name: 'add',
          description: 'Share a role (matched by name with linked servers that share one too)',
          options: [{ type: ROLE, name: 'role', description: 'Role to share', required: true }],
        },
        {
          type: SUB,
          name: 'remove',
          description: 'Stop sharing a role',
          options: [{ type: ROLE, name: 'role', description: 'Role to stop sharing', required: true }],
        },
        { type: SUB, name: 'list', description: 'Show shared roles and which linked servers match them' },
      ],
    },
    {
      type: GROUP,
      name: 'exempt',
      description: 'Members and roles that linked servers never touch',
      options: [
        { type: SUB, name: 'add', description: 'Exempt a role or member', options: targetOptions('exempt', MENTIONABLE, STRING) },
        {
          type: SUB,
          name: 'remove',
          description: 'Stop exempting a role or member',
          options: targetOptions('stop exempting', MENTIONABLE, STRING),
        },
        { type: SUB, name: 'list', description: 'Show who is exempt' },
        { type: SUB, name: 'reset', description: 'Clear the exempt list' },
      ],
    },
  ],
};

/** Save this server's link settings. */
function saveLink(api, cfg, settings) {
  cfg.link = settings;
  api.saveConfig(cfg);
}

const PERMISSION_FOR = {
  bans: ['ban', 'Ban Members'],
  timeouts: ['moderateMembers', 'Moderate Members'],
  roles: ['manageRoles', 'Manage Roles'],
};

/** Accepts this kind from at least one linked server (by default or a per-server setting). */
const acceptsAny = (settings, kind) =>
  receives(settings[kind]) || Object.values(settings.servers ?? {}).some((custom) => receives(custom[kind]));

async function permissionWarnings(api, settings) {
  const perms = await api.botPermissions().catch(() => null);
  if (!perms) return [];
  return LINK_KINDS.filter((kind) => acceptsAny(settings, kind) && !perms[PERMISSION_FOR[kind][0]]).map(
    (kind) =>
      `⚠️ This server accepts ${kind}, but I don't have the **${PERMISSION_FOR[kind][1]}** permission here. ` +
      `Give my role ${PERMISSION_FOR[kind][1]} in Server Settings → Roles.`,
  );
}

async function create({ api, userId }) {
  const { code, expiresAt } = api.linkCreate();
  await api.log(`🔗 <@${userId}> made a link code (expires ${ts(expiresAt)}).`).catch(() => {});
  return {
    content:
      `🔗 Link code: **\`${code}\`** (works once, expires ${ts(expiresAt)}).\n` +
      `Give it to an admin of the other server. They run \`/link join code:${code}\` there. I have to be in both servers.\n` +
      'Once linked, nothing is shared until each server picks what it sends and accepts with `/link share`.',
  };
}

async function join({ api, opts, userId }) {
  const result = await api.linkJoin(opts.code, userId);
  switch (result.error) {
    case 'invalid':
      return { content: "❌ That code isn't valid or has expired. Ask for a new one (`/link create` in the other server)." };
    case 'self':
      return { content: '❌ That code was made in this server. Run `/link join` in the *other* server.' };
    case 'gone':
      return { content: "❌ I'm no longer in the server that made that code." };
    case 'already':
      return { content: `This server is already linked with **${escapeMarkdown(result.name)}**.` };
    default:
      return {
        content:
          `✅ Linked with **${escapeMarkdown(result.name)}**.\n` +
          'Nothing is shared yet. Each server chooses what it sends and accepts with `/link share`, ' +
          'and which roles take part with `/link roles add`. See everything with `/link list`.',
      };
  }
}

/** A linked server by ID or name (ignoring case). */
const findLink = (links, query) => {
  const q = String(query ?? '').trim();
  return links.find((l) => l.id === q || l.name.toLowerCase() === q.toLowerCase()) ?? null;
};

function flowText(ourMode, theirMode) {
  const out = sends(ourMode) && receives(theirMode);
  const inn = sends(theirMode) && receives(ourMode);
  return out && inn ? '⇄ both ways' : out ? '→ from here to them' : inn ? '← from them to here' : 'not shared';
}

function list({ api }) {
  const cfg = api.getConfig();
  const ours = linkSettings(cfg);
  const links = api.linkList();
  const fields = links.map(({ id, name, theirs }) => {
    const flows = LINK_KINDS.map((kind) => `${KIND_LABEL[kind]}: ${flowText(linkMode(cfg, kind, id), theirs[kind])}`);
    const custom = Object.entries(ours.servers[id] ?? {}).map(([kind, mode]) => `${KIND_LABEL[kind]} ${MODE_LABEL[mode]}`);
    if (custom.length) flows.push(`*Set just for them here: ${custom.join(', ')}*`);
    return { name: `${name} (${id})`.slice(0, 256), value: flows.join('\n') };
  });
  const sharedRoles = ours.sharedRoles.length ? ours.sharedRoles.map((id) => `<@&${id}>`).join(', ') : 'None';
  return {
    embeds: [
      {
        title: 'Linked servers',
        color: COLOR,
        description: links.length
          ? 'What actually flows between this server and each linked server (both sides have to agree).'
          : 'Not linked to any server yet. Run `/link create` here, then `/link join` in the other server.',
        fields: [
          ...fields.slice(0, 20),
          {
            name: 'This server (defaults for every linked server)',
            value:
              LINK_KINDS.map((kind) => `${KIND_LABEL[kind]}: ${MODE_LABEL[ours[kind]]}`).join(' · ') +
              `\nShared roles: ${sharedRoles}`.slice(0, 900),
          },
          { name: 'Exempt (never touched by linked servers)', value: formatList(ours.exempt) },
        ],
      },
    ],
  };
}

async function remove({ api, opts, userId }) {
  const match = await api.linkRemove(opts.server, userId);
  if (!match) return { content: "❌ This server isn't linked to a server with that name or ID. Check `/link list`." };
  return {
    content:
      `✅ Unlinked from **${escapeMarkdown(match.name)}**. Nothing more is shared between you. ` +
      'Bans and timeouts already copied here stay, and are still lifted if the original is lifted.',
  };
}

async function share({ api, opts, userId }) {
  const cfg = api.getConfig();
  const settings = linkSettings(cfg);
  const { kind, mode } = opts;
  const links = api.linkList();

  let only = null;
  if (opts.server) {
    only = findLink(links, opts.server);
    if (!only) return { content: "❌ This server isn't linked to a server with that name or ID. Check `/link list`." };
    const custom = { ...(settings.servers[only.id] ?? {}) };
    if (mode === 'default') delete custom[kind];
    else custom[kind] = mode;
    const servers = { ...settings.servers, [only.id]: custom };
    if (!Object.keys(custom).length) delete servers[only.id];
    settings.servers = servers;
  } else {
    if (mode === 'default') {
      return { content: "❌ **Default** only works together with `server:`. It puts that server back on this server's main setting." };
    }
    settings[kind] = mode;
  }
  saveLink(api, cfg, settings);
  const effective = (id) => linkMode(cfg, kind, id);

  let header;
  if (only) {
    const name = escapeMarkdown(only.name);
    header =
      mode === 'default'
        ? `✅ ${KIND_LABEL[kind]} with **${name}** follow this server's main setting again: it ${MODE_TEXT[effective(only.id)]}.`
        : `✅ ${KIND_LABEL[kind]} with **${name}** only: this server ${MODE_TEXT[mode]}.`;
    await api.log(`⚙️ <@${userId}> set ${kind} with **${name}** to **${mode === 'default' ? 'Default' : MODE_LABEL[mode]}**.`).catch(() => {});
  } else {
    header = `✅ ${KIND_LABEL[kind]}: by default this server ${MODE_TEXT[mode]}.`;
    await api.log(`⚙️ <@${userId}> set linked-server ${kind} to **${MODE_LABEL[mode]}**.`).catch(() => {});
  }
  const lines = [header];
  if (!only) {
    const custom = links.filter((l) => settings.servers[l.id]?.[kind]);
    if (custom.length) {
      lines.push(`Servers with their own ${kind} setting keep it: ${custom.map((l) => `**${escapeMarkdown(l.name)}**`).join(', ')}.`);
    }
  }
  for (const link of only ? [only] : links) {
    const ourMode = effective(link.id);
    const parts = [];
    if (sends(ourMode)) parts.push(receives(link.theirs[kind]) ? 'they accept yours ✅' : "they don't accept yours (yet)");
    if (receives(ourMode)) parts.push(sends(link.theirs[kind]) ? 'you get theirs ✅' : "they don't send theirs (yet)");
    if (parts.length) lines.push(`• **${escapeMarkdown(link.name)}**: ${parts.join(', ')}`);
  }
  if (mode !== 'off') {
    if (kind === 'bans') {
      lines.push(
        "Only bans made by people (or other bots) are shared, not AutoKick's own inactivity or quick-leave bans. " +
          'Lifting the original ban lifts the copies.',
      );
    }
    if (kind === 'timeouts') lines.push('Copies end at the same time as the original, and lifting the original lifts them.');
    if (kind === 'roles') {
      lines.push(
        settings.sharedRoles.length
          ? 'Roles are matched by name: a shared role here syncs with a shared role of the same name in the other server.'
          : '⚠️ No roles are shared yet. Add some with `/link roles add`.',
      );
    }
  }
  if (!links.length) lines.push("This server isn't linked to any server yet: `/link create` makes a code.");
  lines.push(...(await permissionWarnings(api, settings)));
  return { content: lines.join('\n') };
}

async function roles({ api, opts, interaction, userId }, sub) {
  const cfg = api.getConfig();
  const settings = linkSettings(cfg);

  if (sub === 'list') {
    const matches = await api.linkRoleMatches().catch(() => null);
    const lines = settings.sharedRoles.map((id) => {
      const match = matches?.find((m) => m.roleId === id);
      const where = match?.servers.length ? `syncs with ${match.servers.map(escapeMarkdown).join(', ')}` : 'no linked server shares a role with this name yet';
      return `• <@&${id}>: ${where}`;
    });
    return {
      embeds: [
        {
          title: 'Shared roles',
          color: COLOR,
          description:
            (lines.length ? lines.join('\n') : 'None yet. Add one with `/link roles add`.') +
            `\n\nRoles: this server **${MODE_LABEL[settings.roles]}** (change with \`/link share kind:Roles\`). ` +
            'Getting a shared role here gives the same-named role in linked servers, and losing it takes it away. ' +
            'People who join get the shared roles they already have in a linked server.',
        },
      ],
    };
  }

  const id = opts.role;
  const mention = `<@&${id}>`;
  if (id === interaction.guild_id) return { content: "@everyone can't be shared." };
  const name = interaction.data.resolved?.roles?.[id]?.name;

  if (sub === 'remove') {
    if (!settings.sharedRoles.includes(id)) return { content: `${mention} isn't shared.` };
    settings.sharedRoles = settings.sharedRoles.filter((r) => r !== id);
    saveLink(api, cfg, settings);
    await api.log(`⚙️ <@${userId}> stopped sharing ${mention} with linked servers.`).catch(() => {});
    return { content: `✅ ${mention} is no longer shared. Nobody gains or loses it because of linked servers anymore.` };
  }

  if (settings.sharedRoles.includes(id)) return { content: `${mention} is already shared.` };
  if (settings.sharedRoles.length >= MAX_SHARED_ROLES) {
    return { content: `❌ Up to ${MAX_SHARED_ROLES} roles can be shared. Remove one with \`/link roles remove\` first.` };
  }
  settings.sharedRoles = [...settings.sharedRoles, id];
  saveLink(api, cfg, settings);
  await api.linkSeedRole(id).catch(() => {}); // note who has it now, so removals later are noticed
  await api.log(`⚙️ <@${userId}> started sharing ${mention} with linked servers.`).catch(() => {});

  const lines = [`✅ ${mention} is shared. It syncs with a shared role named **${escapeMarkdown(name ?? 'the same')}** in linked servers.`];
  const match = (await api.linkRoleMatches().catch(() => null))?.find((m) => m.roleId === id);
  if (match?.servers.length) lines.push(`Matches in: ${match.servers.map(escapeMarkdown).join(', ')}.`);
  else lines.push('No linked server shares a role with that name yet. They need to add their own with `/link roles add`.');
  const rolesOn = settings.roles !== 'off' || Object.values(settings.servers).some((c) => c.roles && c.roles !== 'off');
  if (!rolesOn) lines.push('⚠️ Role sharing is off for this server. Turn it on with `/link share kind:Roles`.');
  lines.push(...(await permissionWarnings(api, settings)));
  return { content: lines.join('\n') };
}

async function exempt({ api, opts, interaction, userId }, sub) {
  const cfg = api.getConfig();
  const settings = linkSettings(cfg);
  if (sub === 'list') {
    return {
      embeds: [
        {
          title: 'Exempt from linked servers',
          color: COLOR,
          description:
            `${formatList(settings.exempt)}\n\n` +
            "Linked servers never ban, time out or change the roles of these members here, and what happens to them here isn't shared.",
        },
      ],
    };
  }
  if (sub === 'reset') {
    const count = settings.exempt.roles.length + settings.exempt.users.length;
    if (!count) return { content: 'The exempt list is already empty.' };
    settings.exempt = { roles: [], users: [] };
    saveLink(api, cfg, settings);
    await api.log(`⚙️ <@${userId}> cleared the linked-server exempt list.`).catch(() => {});
    return { content: `✅ Cleared the exempt list (${count} ${count === 1 ? 'entry' : 'entries'}).` };
  }

  const target = resolveTarget(opts, interaction);
  if (target.error) return { content: target.error };
  if (target.id === interaction.guild_id) return { content: "@everyone can't be exempt. To stop sharing, use `/link share`." };
  const kind = target.isRole ? 'roles' : 'users';
  const entries = settings.exempt[kind];
  if (sub === 'add') {
    if (entries.includes(target.id)) return { content: `${target.mention} is already exempt.` };
    settings.exempt[kind] = [...entries, target.id];
    saveLink(api, cfg, settings);
    await api.log(`⚙️ <@${userId}> exempted ${target.mention} from linked servers.`).catch(() => {});
    return {
      content:
        `✅ ${target.mention} ${target.isRole ? '(everyone with it) ' : ''}won't be banned, timed out or have roles changed ` +
        "by linked servers, and their bans and timeouts here aren't shared.",
    };
  }
  if (!entries.includes(target.id)) return { content: `${target.mention} isn't exempt.` };
  settings.exempt[kind] = entries.filter((x) => x !== target.id);
  saveLink(api, cfg, settings);
  await api.log(`⚙️ <@${userId}> removed ${target.mention} from the linked-server exempt list.`).catch(() => {});
  return { content: `✅ ${target.mention} is no longer exempt.` };
}

export async function runLinkCommand(ctx, group, sub) {
  if (group === 'roles') return roles(ctx, sub);
  if (group === 'exempt') return exempt(ctx, sub);
  const handler = { create, join, list, remove, share }[sub];
  return handler ? handler(ctx) : { content: 'Unknown command.' };
}
