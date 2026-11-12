import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assess,
  DAY_MS,
  formatDuration,
  lastActiveAt,
  listVerdict,
  mergeIntervals,
  observedInactiveMs,
  pauseChanges,
} from '../src/policy.js';

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

test('rejoining restarts the clock even if an old activity record was left behind', () => {
  // Left 60 days ago (leave event missed while the bot was offline), rejoined 2 days ago.
  const now = 100 * DAY_MS;
  const c = cfg({ activity: { m: 40 * DAY_MS } });
  const member = { id: 'm', bot: false, isOwner: false, kickable: true, roleIds: [], joinedTimestamp: now - 2 * DAY_MS };
  const result = assess(member, c, { now, downtime: [] });
  assert.equal(result.lastActive, now - 2 * DAY_MS);
  assert.equal(result.action, 'keep');
  assert.equal(result.remainingMs, 28 * DAY_MS);
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

test('mergeIntervals joins overlaps so nothing is subtracted twice', () => {
  assert.deepEqual(mergeIntervals([[50, 60], [0, 10], [5, 20], [60, 70], [30, 30]]), [[0, 20], [50, 70]]);
  // Bot offline 10-20 while the member was also muted 15-30: only 20 units excluded, not 25.
  assert.equal(observedInactiveMs(0, 100, [[10, 20], [15, 30]]), 80);
});

const plain = (o = {}) => ({ id: 'm', bot: false, isOwner: false, kickable: true, roleIds: [], joinedTimestamp: 0, ...o });

test('muted time does not count toward the limit', () => {
  const now = 40 * DAY_MS;
  const c = cfg({ activity: { m: 5 * DAY_MS } }); // 35 days ago
  // Timed out for 10 days in between, now over: 25 days counted.
  const result = assess(plain({ pauses: [[10 * DAY_MS, 20 * DAY_MS]] }), c, { now, downtime: [] });
  assert.equal(result.action, 'keep');
  assert.equal(result.inactiveMs, 25 * DAY_MS);
  assert.equal(result.pausedMs, 10 * DAY_MS);
});

test('a member who is muted right now is never kicked and their clock is frozen', () => {
  const now = 100 * DAY_MS;
  const c = cfg({ activity: { m: 50 * DAY_MS } });
  // Muted since day 60, still muted: 10 days counted, clock stopped.
  const result = assess(plain({ pauses: [[60 * DAY_MS, now]], pausedBy: 'role' }), c, { now, downtime: [] });
  assert.equal(result.action, 'paused');
  assert.equal(result.reason, 'role');
  assert.equal(result.inactiveMs, 10 * DAY_MS);
  assert.equal(result.remainingMs, 20 * DAY_MS);
});

test('a whitelisted member stays protected even while muted', () => {
  const c = cfg({ whitelist: { roles: [], users: ['m'] } });
  assert.equal(assess(plain({ pausedBy: 'timeout' }), c, { now: DAY_MS, downtime: [] }).action, 'protected');
});

test('pauseChanges: timeouts are recorded, extended and lifted early', () => {
  const now = 1000;
  const none = { timeoutUntil: null, roleIds: [] };
  const roles = new Set(['muted']);
  assert.deepEqual(pauseChanges([], none, roles, now), [], 'nothing to do');

  assert.deepEqual(pauseChanges([], { ...none, timeoutUntil: 5000 }, roles, now), [
    { insert: { kind: 'timeout', start: 1000, end: 5000 } },
  ]);
  const row = { id: 7, kind: 'timeout', started_at: 500, ended_at: 5000 };
  assert.deepEqual(pauseChanges([row], { ...none, timeoutUntil: 5000 }, roles, now), [], 'unchanged');
  assert.deepEqual(pauseChanges([row], { ...none, timeoutUntil: 9000 }, roles, now), [{ update: { id: 7, end: 9000 } }]);
  assert.deepEqual(pauseChanges([row], none, roles, now), [{ update: { id: 7, end: 1000 } }], 'lifted early');

  const expired = { id: 8, kind: 'timeout', started_at: 100, ended_at: 900 };
  assert.deepEqual(pauseChanges([expired], none, roles, now), [], 'expired timeouts are left alone');
});

test('pauseChanges: pause roles open and close a period', () => {
  const now = 1000;
  const roles = new Set(['muted']);
  const muted = { timeoutUntil: null, roleIds: ['muted', 'x'] };
  const free = { timeoutUntil: null, roleIds: ['x'] };
  const open = { id: 3, kind: 'role', started_at: 200, ended_at: null };

  assert.deepEqual(pauseChanges([], muted, roles, now), [{ insert: { kind: 'role', start: 1000, end: null } }]);
  assert.deepEqual(pauseChanges([open], muted, roles, now), [], 'already open');
  assert.deepEqual(pauseChanges([open], free, roles, now), [{ update: { id: 3, end: 1000 } }]);
  assert.deepEqual(pauseChanges([open], free, null, now), [], 'roles unknown: leave role periods alone');
});

test('formatDuration', () => {
  assert.equal(formatDuration(31 * DAY_MS + 5), '31 days');
  assert.equal(formatDuration(DAY_MS), '1 day');
  assert.equal(formatDuration(2 * 3600_000), '2 hours');
  assert.equal(formatDuration(1000), 'less than an hour');
});
