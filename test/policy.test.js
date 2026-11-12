import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, DAY_MS, formatDuration, lastActiveAt, listVerdict, observedInactiveMs } from '../src/policy.js';

const cfg = (overrides = {}) => ({
  days: 30,
  trackingSince: 0,
  activity: {},
  whitelist: { roles: [], users: [] },
  blacklist: { roles: [], users: [] },
  ...overrides,
});

test('listVerdict: most specific rule wins', () => {
  const c = cfg({
    whitelist: { roles: ['staff'], users: ['vip'] },
    blacklist: { roles: ['trial'], users: ['troll'] },
  });
  assert.equal(listVerdict(c, 'vip', ['trial']).protected, true, 'whitelisted member beats blacklisted role');
  assert.equal(listVerdict(c, 'troll', ['staff']).protected, false, 'blacklisted member beats whitelisted role');
  assert.equal(listVerdict(c, 'x', ['staff', 'trial']).protected, false, 'blacklisted role beats whitelisted role');
  assert.equal(listVerdict(c, 'x', ['staff']).protected, true, 'whitelisted role protects');
  assert.equal(listVerdict(c, 'x', []).protected, false, 'no lists: not protected');
});

test('lastActiveAt never goes earlier than tracking start or join date', () => {
  const c = cfg({ trackingSince: 1000, activity: { a: 500, b: 5000 } });
  assert.equal(lastActiveAt(c, 'a', 200), 1000);
  assert.equal(lastActiveAt(c, 'b', 200), 5000);
  assert.equal(lastActiveAt(c, 'c', 3000), 3000);
});

test('observedInactiveMs subtracts bot downtime', () => {
  assert.equal(observedInactiveMs(0, 100, []), 100);
  assert.equal(observedInactiveMs(0, 100, [[20, 30]]), 90);
  assert.equal(observedInactiveMs(50, 100, [[20, 60]]), 40, 'only the overlapping part counts');
  assert.equal(observedInactiveMs(50, 100, [[0, 10]]), 50, 'downtime before last activity ignored');
  assert.equal(observedInactiveMs(0, 100, [[0, 200]]), 0);
});

test('assess covers every outcome', () => {
  const now = 100 * DAY_MS;
  const ctx = { now, downtime: [] };
  const c = cfg({ whitelist: { roles: ['staff'], users: [] }, activity: { recent: now - DAY_MS } });
  const member = (o) => ({ id: 'm', bot: false, isOwner: false, kickable: true, roleIds: [], joinedTimestamp: 0, ...o });

  assert.equal(assess(member({ bot: true }), c, ctx).action, 'skip');
  assert.equal(assess(member({ isOwner: true }), c, ctx).action, 'skip');
  assert.equal(assess(member({ roleIds: ['staff'] }), c, ctx).action, 'protected');
  assert.equal(assess(member({ kickable: false }), c, ctx).action, 'blocked');
  assert.equal(assess(member({}), c, ctx).action, 'kick');

  const recent = assess(member({ id: 'recent' }), c, ctx);
  assert.equal(recent.action, 'keep');
  assert.equal(recent.remainingMs, 29 * DAY_MS);

  const newcomer = assess(member({ joinedTimestamp: now - 5 * DAY_MS }), c, ctx);
  assert.equal(newcomer.action, 'keep', 'new members get the full limit from their join date');
});

test('assess does not count downtime toward the limit', () => {
  const now = 40 * DAY_MS;
  const c = cfg({ activity: { m: 5 * DAY_MS } }); // 35 days ago
  const member = { id: 'm', bot: false, isOwner: false, kickable: true, roleIds: [], joinedTimestamp: 0 };
  assert.equal(assess(member, c, { now, downtime: [] }).action, 'kick');
  assert.equal(assess(member, c, { now, downtime: [[10 * DAY_MS, 20 * DAY_MS]] }).action, 'keep');
});

test('formatDuration', () => {
  assert.equal(formatDuration(31 * DAY_MS + 5), '31 days');
  assert.equal(formatDuration(DAY_MS), '1 day');
  assert.equal(formatDuration(2 * 3600_000), '2 hours');
  assert.equal(formatDuration(1000), 'less than an hour');
});
