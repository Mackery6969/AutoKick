// Reading a "role or member, or a pasted user ID" choice from a slash command.

/**
 * `opts.target` is a mentionable option, `opts['user-id']` a pasted ID (or
 * mention) for someone who may not be in the server. Returns
 * { id, isRole, mention } or { error }.
 */
export function resolveTarget(opts, interaction) {
  const rawId = opts['user-id']?.trim();
  if (opts.target && rawId) return { error: '❌ Pick a role or member, **or** paste a user ID, not both.' };
  if (!opts.target && !rawId) return { error: '❌ Pick a role or member, or paste a user ID.' };
  const id = opts.target ?? rawId.replace(/^<@!?(\d+)>$/, '$1');
  if (!opts.target && !/^\d{17,20}$/.test(id)) {
    return {
      error:
        "❌ That doesn't look like a user ID. In Discord, turn on Developer Mode (User Settings → Advanced), " +
        'then right-click the user and choose **Copy User ID**.',
    };
  }
  const isRole = Boolean(opts.target && interaction.data.resolved?.roles?.[id]);
  const mention = isRole ? `<@&${id}>` : opts.target ? `<@${id}>` : `<@${id}> (ID \`${id}\`)`;
  return { id, isRole, mention };
}

/** Options for a role/member target that also takes a pasted user ID. */
export const targetOptions = (verb, MENTIONABLE = 9, STRING = 3) => [
  { type: MENTIONABLE, name: 'target', description: `Role or member to ${verb}` },
  { type: STRING, name: 'user-id', description: `Or the ID of a user to ${verb} (works for people not in the server)` },
];

/** "<@&role>, <@user>" for a { roles, users } list, cut short to fit an embed field. */
export function formatList(list) {
  const items = [...list.roles.map((id) => `<@&${id}>`), ...list.users.map((id) => `<@${id}>`)];
  if (!items.length) return 'None';
  let text = '';
  for (const [i, item] of items.entries()) {
    if (text.length + item.length > 950) return `${text} …and ${items.length - i} more`;
    text += (text ? ', ' : '') + item;
  }
  return text;
}
