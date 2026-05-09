import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDataDir } from '../helpers/db.js';
import { makeApp, startServer } from '../helpers/http.js';

freshDataDir();

const { default: db } = await import('../../../server/db.js');
const { default: rewardsRouter } = await import('../../../server/routes/rewards.js');

let server;
let request;
let session;
let userId;

before(async () => {
  const { app, session: s } = makeApp(rewardsRouter, '/api/rewards');
  session = s;
  const handle = await startServer(app);
  request = handle.request;
  server = handle;
});

beforeEach(() => {
  for (const k of Object.keys(session)) delete session[k];
  db.exec('DELETE FROM redemptions');
  db.exec('DELETE FROM rewards');
  db.exec('DELETE FROM users');

  userId = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName, chesnutBalance) VALUES (?, ?, ?, ?)'
  ).run('shopper@x.io', 'h', 'Shopper', 100).lastInsertRowid;
});

after(async () => {
  await server.close();
});

function seedReward({ name = 'Sticker', cost = 50, active = 1, description = '' } = {}) {
  return db.prepare(
    'INSERT INTO rewards (name, description, chesnutCost, active) VALUES (?, ?, ?, ?)'
  ).run(name, description, cost, active).lastInsertRowid;
}

// ── Auth gate ──────────────────────────────────────────

test('GET /catalog 401 without session', async () => {
  const res = await request('GET', '/api/rewards/catalog');
  assert.equal(res.status, 401);
});

test('POST /redeem 401 without session', async () => {
  const res = await request('POST', '/api/rewards/redeem', { rewardId: 1 });
  assert.equal(res.status, 401);
});

test('GET /redemptions 401 without session', async () => {
  const res = await request('GET', '/api/rewards/redemptions');
  assert.equal(res.status, 401);
});

// ── /catalog ───────────────────────────────────────────

test('GET /catalog returns active rewards sorted by cost and current balance', async () => {
  seedReward({ name: 'Big', cost: 200 });
  seedReward({ name: 'Small', cost: 25 });
  seedReward({ name: 'Inactive', cost: 30, active: 0 });

  session.userId = userId;
  const res = await request('GET', '/api/rewards/catalog');
  assert.equal(res.status, 200);
  assert.equal(res.body.balance, 100);
  // Sorted ascending, inactive excluded.
  const names = res.body.rewards.map(r => r.name);
  assert.deepEqual(names, ['Small', 'Big']);
});

// ── /redeem ────────────────────────────────────────────

test('POST /redeem deducts balance, inserts redemption, returns updated user', async () => {
  const rewardId = seedReward({ name: 'Hat', cost: 60 });
  session.userId = userId;
  const res = await request('POST', '/api/rewards/redeem', { rewardId });
  assert.equal(res.status, 200);
  assert.equal(res.body.redemption.rewardName, 'Hat');
  assert.equal(res.body.redemption.chesnutsSpent, 60);
  assert.equal(res.body.redemption.status, 'pending');
  assert.equal(res.body.user.chesnutBalance, 40);

  // Side effects on db.
  const userRow = db.prepare('SELECT chesnutBalance FROM users WHERE id = ?').get(userId);
  assert.equal(userRow.chesnutBalance, 40);
  const red = db.prepare('SELECT * FROM redemptions WHERE userId = ?').get(userId);
  assert.equal(red.rewardId, rewardId);
  assert.equal(red.chesnutsSpent, 60);
  assert.equal(red.status, 'pending');
});

test('POST /redeem 400 on missing rewardId', async () => {
  session.userId = userId;
  const res = await request('POST', '/api/rewards/redeem', {});
  assert.equal(res.status, 400);
});

test('POST /redeem 404 on unknown reward', async () => {
  session.userId = userId;
  const res = await request('POST', '/api/rewards/redeem', { rewardId: 99999 });
  assert.equal(res.status, 404);
});

test('POST /redeem 404 when reward exists but is inactive', async () => {
  const rewardId = seedReward({ name: 'Old', cost: 10, active: 0 });
  session.userId = userId;
  const res = await request('POST', '/api/rewards/redeem', { rewardId });
  assert.equal(res.status, 404);
});

test('POST /redeem 400 when balance is insufficient', async () => {
  const rewardId = seedReward({ name: 'Pricey', cost: 1000 });
  session.userId = userId;
  const res = await request('POST', '/api/rewards/redeem', { rewardId });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Not enough Chesnuts');
  assert.equal(res.body.needed, 1000);
  assert.equal(res.body.have, 100);
  // No deduction occurred.
  const userRow = db.prepare('SELECT chesnutBalance FROM users WHERE id = ?').get(userId);
  assert.equal(userRow.chesnutBalance, 100);
});

// ── /redemptions ───────────────────────────────────────

test('GET /redemptions returns history for current user with stats', async () => {
  const rewardId = seedReward({ name: 'Pin', cost: 20 });
  session.userId = userId;
  await request('POST', '/api/rewards/redeem', { rewardId });
  await request('POST', '/api/rewards/redeem', { rewardId });

  const res = await request('GET', '/api/rewards/redemptions');
  assert.equal(res.status, 200);
  assert.equal(res.body.redemptions.length, 2);
  assert.equal(res.body.stats.totalRedemptions, 2);
  assert.equal(res.body.stats.totalSpent, 40);
});

test('GET /redemptions honors limit and offset query params', async () => {
  const rewardId = seedReward({ name: 'Pin', cost: 5 });
  session.userId = userId;
  for (let i = 0; i < 3; i++) {
    await request('POST', '/api/rewards/redeem', { rewardId });
  }
  const limited = await request('GET', '/api/rewards/redemptions?limit=2');
  assert.equal(limited.status, 200);
  assert.equal(limited.body.redemptions.length, 2);

  const offset = await request('GET', '/api/rewards/redemptions?limit=10&offset=2');
  assert.equal(offset.body.redemptions.length, 1);

  // Limit gets clamped to 200 max.
  const huge = await request('GET', '/api/rewards/redemptions?limit=10000');
  assert.equal(huge.status, 200);
  assert.ok(huge.body.redemptions.length <= 200);
});

test('GET /redemptions filters by current user only', async () => {
  const rewardId = seedReward({ name: 'Solo', cost: 5 });
  // Another user with their own redemption.
  const otherId = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName, chesnutBalance) VALUES (?, ?, ?, ?)'
  ).run('other@x.io', 'h', 'Other', 100).lastInsertRowid;
  db.prepare(
    'INSERT INTO redemptions (userId, rewardId, chesnutsSpent) VALUES (?, ?, ?)'
  ).run(otherId, rewardId, 5);

  session.userId = userId;
  const res = await request('GET', '/api/rewards/redemptions');
  assert.equal(res.body.redemptions.length, 0);
  assert.equal(res.body.stats.totalRedemptions, 0);
});
