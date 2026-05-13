import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';

import { freshDataDir } from '../helpers/db.js';
import { makeApp, startServer } from '../helpers/http.js';

freshDataDir();

const { default: db } = await import('../../../server/db.js');
const { default: authRouter } = await import('../../../server/routes/auth.js');

let server;
let request;
let session;

before(async () => {
  const { app, session: s } = makeApp(authRouter, '/api/auth');
  session = s;
  const handle = await startServer(app);
  request = handle.request;
  server = handle;
});

beforeEach(() => {
  // Reset session.
  for (const k of Object.keys(session)) delete session[k];
  // Reset tables touched by auth routes.
  db.exec('DELETE FROM guests');
  db.exec('DELETE FROM users');
});

after(async () => {
  await server.close();
});

// Helper to create a user directly in the DB without going through register.
function seedUser({
  email, password = 'secret123', displayName = 'Tester', isAdmin = 0,
  disabledAt = null, archivedAt = null,
} = {}) {
  const passwordHash = bcrypt.hashSync(password, 4);
  const r = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName, isAdmin, disabledAt, archivedAt) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(email, passwordHash, displayName, isAdmin, disabledAt, archivedAt);
  return { id: r.lastInsertRowid, email, password, displayName, isAdmin, disabledAt, archivedAt };
}

// ── GET /me ────────────────────────────────────────────

test('GET /me returns null user when no session', async () => {
  const res = await request('GET', '/api/auth/me');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { user: null });
});

test('GET /me returns the registered user when userId in session', async () => {
  const u = seedUser({ email: 'me@example.com', displayName: 'Me' });
  session.userId = u.id;
  const res = await request('GET', '/api/auth/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'me@example.com');
  assert.equal(res.body.user.isAdmin, false);
  assert.equal(res.body.user.isGuest, false);
});

test('GET /me destroys session and returns null when user is disabled', async () => {
  const u = seedUser({ email: 'banned@x.io', disabledAt: '2025-01-01 00:00:00' });
  session.userId = u.id;
  const res = await request('GET', '/api/auth/me');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { user: null });
  // session.destroy stub clears the session.
  assert.equal(session.userId, undefined);
});

test('GET /me destroys session and returns null when user is archived', async () => {
  const u = seedUser({ email: 'archived@x.io', archivedAt: '2025-01-01 00:00:00' });
  session.userId = u.id;
  const res = await request('GET', '/api/auth/me');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { user: null });
  assert.equal(session.userId, undefined);
});

test('GET /me returns null and destroys session when userId is missing user row', async () => {
  session.userId = 99999;
  const res = await request('GET', '/api/auth/me');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { user: null });
});

test('GET /me returns guest shape when guestId in session', async () => {
  const r = db.prepare(
    'INSERT INTO guests (guestToken, displayName) VALUES (?, ?)'
  ).run('tok-abcdef12', 'Guesty');
  session.guestId = r.lastInsertRowid;

  const res = await request('GET', '/api/auth/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.isGuest, true);
  assert.equal(res.body.user.id, -r.lastInsertRowid);
  assert.equal(res.body.user.displayName, 'Guesty');
});

test('GET /me clears guestId from session when guest row is missing', async () => {
  session.guestId = 9999;
  const res = await request('GET', '/api/auth/me');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { user: null });
  assert.equal(session.guestId, undefined);
});

// ── POST /register ─────────────────────────────────────

test('POST /register creates a user, becomes admin when first account', async () => {
  const res = await request('POST', '/api/auth/register', {
    email: 'first@x.io', password: 'secret123', displayName: 'First',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, 'first@x.io');
  assert.equal(res.body.user.isAdmin, true, 'first user is auto-admin');
  // Side effect: session.userId set.
  assert.equal(session.userId, res.body.user.id);
  // Side effect: row inserted.
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get('first@x.io');
  assert.ok(row);
});

test('POST /register: second user is non-admin (admin already exists)', async () => {
  seedUser({ email: 'admin@x.io', isAdmin: 1 });
  const res = await request('POST', '/api/auth/register', {
    email: 'second@x.io', password: 'secret123', displayName: 'Two',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.isAdmin, false);
});

test('POST /register: 400 on missing fields', async () => {
  const res = await request('POST', '/api/auth/register', { email: '', password: '', displayName: '' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /required/);
});

test('POST /register: 400 on invalid email', async () => {
  const res = await request('POST', '/api/auth/register', {
    email: 'not-an-email', password: 'secret123', displayName: 'X',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Invalid email/);
});

test('POST /register: 400 on too-long display name', async () => {
  const res = await request('POST', '/api/auth/register', {
    email: 'a@b.co', password: 'secret123', displayName: 'x'.repeat(41),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Display name/);
});

test('POST /register: 400 on too-short password', async () => {
  const res = await request('POST', '/api/auth/register', {
    email: 'a@b.co', password: 'short', displayName: 'X',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Password/);
});

test('POST /register: 409 on duplicate email', async () => {
  seedUser({ email: 'dupe@x.io' });
  const res = await request('POST', '/api/auth/register', {
    email: 'dupe@x.io', password: 'secret123', displayName: 'Y',
  });
  assert.equal(res.status, 409);
});

test('POST /register: 400 when email exceeds max length', async () => {
  const longLocal = 'a'.repeat(260);
  const res = await request('POST', '/api/auth/register', {
    email: `${longLocal}@x.io`, password: 'secret123', displayName: 'X',
  });
  assert.equal(res.status, 400);
});

test('POST /register: ADMIN_EMAILS env promotes matching email to admin', async () => {
  // Pre-seed an admin so we trigger the env-list branch (rather than
  // first-user fallback).
  seedUser({ email: 'root@x.io', isAdmin: 1 });
  process.env.ADMIN_EMAILS = 'special@x.io,other@x.io';
  try {
    const res = await request('POST', '/api/auth/register', {
      email: 'special@x.io', password: 'secret123', displayName: 'Special',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.isAdmin, true);
  } finally {
    delete process.env.ADMIN_EMAILS;
  }
});

test('POST /register: merges existing guest streak/best into new user', async () => {
  const g = db.prepare(
    'INSERT INTO guests (guestToken, displayName, currentStreak, bestStreak) VALUES (?, ?, 4, 7)'
  ).run('guest-token-merge', 'Pre');
  session.guestId = g.lastInsertRowid;

  const res = await request('POST', '/api/auth/register', {
    email: 'merge@x.io', password: 'secret123', displayName: 'Merger',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, 'merge@x.io');
  // Side effect: guest is marked merged.
  const guest = db.prepare('SELECT mergedIntoUserId, mergedAt FROM guests WHERE id = ?').get(g.lastInsertRowid);
  assert.equal(guest.mergedIntoUserId, res.body.user.id);
  assert.ok(guest.mergedAt);
  // session.guestId removed.
  assert.equal(session.guestId, undefined);
});

// ── POST /login ────────────────────────────────────────

test('POST /login: 200 on valid credentials, sets session.userId', async () => {
  const u = seedUser({ email: 'login@x.io' });
  const res = await request('POST', '/api/auth/login', {
    email: 'login@x.io', password: 'secret123',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, u.id);
  assert.equal(session.userId, u.id);
});

test('POST /login: 400 on missing fields', async () => {
  const res = await request('POST', '/api/auth/login', {});
  assert.equal(res.status, 400);
});

test('POST /login: 401 on unknown email', async () => {
  const res = await request('POST', '/api/auth/login', {
    email: 'nobody@x.io', password: 'secret123',
  });
  assert.equal(res.status, 401);
});

test('POST /login: 401 on bad password', async () => {
  seedUser({ email: 'badpass@x.io', password: 'secret123' });
  const res = await request('POST', '/api/auth/login', {
    email: 'badpass@x.io', password: 'wrong-password',
  });
  assert.equal(res.status, 401);
});

test('POST /login: 403 when account is archived', async () => {
  seedUser({ email: 'archived@x.io', archivedAt: '2025-01-01 00:00:00' });
  const res = await request('POST', '/api/auth/login', {
    email: 'archived@x.io', password: 'secret123',
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /archived/i);
});

test('POST /login: 403 when account is disabled', async () => {
  seedUser({ email: 'disabled@x.io', disabledAt: '2025-01-01 00:00:00' });
  const res = await request('POST', '/api/auth/login', {
    email: 'disabled@x.io', password: 'secret123',
  });
  assert.equal(res.status, 403);
});

test('POST /login: merges guest streaks into user on login', async () => {
  const u = seedUser({ email: 'merger2@x.io' });
  const g = db.prepare(
    'INSERT INTO guests (guestToken, displayName, currentStreak, bestStreak) VALUES (?, ?, 5, 9)'
  ).run('login-merge', 'Pre');
  session.guestId = g.lastInsertRowid;

  const res = await request('POST', '/api/auth/login', {
    email: 'merger2@x.io', password: 'secret123',
  });
  assert.equal(res.status, 200);
  // The merge transaction lifts streak/best onto the user (max).
  const fresh = db.prepare('SELECT currentStreak, bestStreak FROM users WHERE id = ?').get(u.id);
  assert.equal(fresh.currentStreak, 5);
  assert.equal(fresh.bestStreak, 9);
  assert.equal(session.guestId, undefined);
});

// ── POST /guest ────────────────────────────────────────

test('POST /guest: creates a new guest row when token is unseen', async () => {
  const res = await request('POST', '/api/auth/guest', {
    guestToken: 'fresh-token-1234',
    displayName: 'Newbie',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.isGuest, true);
  assert.equal(res.body.user.displayName, 'Newbie');
  // Side effect: session.guestId set, no userId.
  assert.ok(session.guestId);
  assert.equal(session.userId, undefined);
  // Row exists.
  const row = db.prepare('SELECT displayName FROM guests WHERE guestToken = ?').get('fresh-token-1234');
  assert.equal(row.displayName, 'Newbie');
});

test('POST /guest: returning visitor with same token reuses guest row', async () => {
  const r1 = await request('POST', '/api/auth/guest', {
    guestToken: 'reuse-token-12345',
    displayName: 'Original',
  });
  const r2 = await request('POST', '/api/auth/guest', {
    guestToken: 'reuse-token-12345',
    displayName: 'Original',
  });
  assert.equal(r2.body.user.id, r1.body.user.id);
});

test('POST /guest: updates displayName when it changes', async () => {
  const r1 = await request('POST', '/api/auth/guest', {
    guestToken: 'rename-token-12345',
    displayName: 'Old',
  });
  const r2 = await request('POST', '/api/auth/guest', {
    guestToken: 'rename-token-12345',
    displayName: 'New',
  });
  assert.equal(r2.body.user.displayName, 'New');
  assert.equal(r2.body.user.id, r1.body.user.id);
});

test('POST /guest: merged token on prior guest yields a fresh guest row', async () => {
  // Pre-seed a merged guest with a known token.
  const u = seedUser({ email: 'reg@x.io' });
  db.prepare(
    "INSERT INTO guests (guestToken, displayName, mergedIntoUserId, mergedAt) VALUES (?, ?, ?, datetime('now'))"
  ).run('merged-token-xyz', 'Old', u.id);

  const res = await request('POST', '/api/auth/guest', {
    guestToken: 'merged-token-xyz',
    displayName: 'Fresh',
  });
  assert.equal(res.status, 200);
  // The pre-existing guest's token was rewritten so the new guest could claim it.
  const merged = db.prepare("SELECT guestToken FROM guests WHERE displayName = 'Old'").get();
  assert.match(merged.guestToken, /^merged:/);
  // A new (unmerged) guest row exists with the original token.
  const fresh = db.prepare(
    'SELECT id, mergedIntoUserId FROM guests WHERE guestToken = ?'
  ).get('merged-token-xyz');
  assert.equal(fresh.mergedIntoUserId, null);
});

test('POST /guest: 400 on invalid guestToken', async () => {
  const res = await request('POST', '/api/auth/guest', {
    guestToken: 'short',
    displayName: 'X',
  });
  assert.equal(res.status, 400);
});

test('POST /guest: 400 on empty displayName', async () => {
  const res = await request('POST', '/api/auth/guest', {
    guestToken: 'valid-token-12345',
    displayName: '   ',
  });
  assert.equal(res.status, 400);
});

test('POST /guest: 400 on missing displayName field', async () => {
  const res = await request('POST', '/api/auth/guest', {
    guestToken: 'valid-token-67890',
  });
  assert.equal(res.status, 400);
});

test('POST /guest: clears any prior session.userId', async () => {
  const u = seedUser({ email: 'prior@x.io' });
  session.userId = u.id;
  const res = await request('POST', '/api/auth/guest', {
    guestToken: 'switch-token-12345',
    displayName: 'Switcher',
  });
  assert.equal(res.status, 200);
  assert.equal(session.userId, undefined);
  assert.ok(session.guestId);
});

// ── POST /logout ───────────────────────────────────────

test('POST /logout: clears session and returns ok', async () => {
  const u = seedUser({ email: 'logout@x.io' });
  session.userId = u.id;
  const res = await request('POST', '/api/auth/logout');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(session.userId, undefined);
});

// ── Impersonation (TRI-146) ─────────────────────────────

test('GET /me includes impersonator field when actively impersonating', async () => {
  const admin = seedUser({ email: 'imp-admin@x.io', displayName: 'Administa', isAdmin: 1 });
  const target = seedUser({ email: 'imp-target@x.io', displayName: 'Targetina' });
  session.userId = target.id;
  session.impersonatorId = admin.id;

  const res = await request('GET', '/api/auth/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, target.id);
  assert.equal(res.body.user.displayName, 'Targetina');
  assert.ok(res.body.impersonator, '/me should expose the impersonator block');
  assert.equal(res.body.impersonator.id, admin.id);
  assert.equal(res.body.impersonator.displayName, 'Administa');
});

test('GET /me does NOT include impersonator field when not impersonating', async () => {
  const u = seedUser({ email: 'plain@x.io' });
  session.userId = u.id;
  const res = await request('GET', '/api/auth/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.impersonator, undefined);
});

test('POST /stop-impersonating: 400 when no impersonation is active', async () => {
  const u = seedUser({ email: 'noop@x.io' });
  session.userId = u.id;
  const res = await request('POST', '/api/auth/stop-impersonating');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Not impersonating/);
});

test('POST /stop-impersonating: restores admin session and clears impersonatorId', async () => {
  const admin = seedUser({ email: 'stop-admin@x.io', displayName: 'StopAdmin', isAdmin: 1 });
  const target = seedUser({ email: 'stop-target@x.io', displayName: 'StopTarget' });
  session.userId = target.id;
  session.impersonatorId = admin.id;

  const res = await request('POST', '/api/auth/stop-impersonating');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, admin.id);
  assert.equal(res.body.user.isAdmin, true);
  assert.equal(session.userId, admin.id);
  assert.equal(session.impersonatorId, undefined);
});

test('POST /stop-impersonating: destroys session if original admin is archived', async () => {
  const admin = seedUser({
    email: 'gone-admin@x.io', displayName: 'Gone', isAdmin: 1,
    archivedAt: '2026-01-01 00:00:00',
  });
  const target = seedUser({ email: 'gone-target@x.io' });
  session.userId = target.id;
  session.impersonatorId = admin.id;

  const res = await request('POST', '/api/auth/stop-impersonating');
  assert.equal(res.status, 400);
  assert.equal(session.userId, undefined);
  assert.equal(session.impersonatorId, undefined);
});

test('POST /login clears prior session.impersonatorId', async () => {
  // A stale impersonatorId could otherwise bleed across re-logins.
  const u = seedUser({ email: 'relogin@x.io' });
  session.impersonatorId = 999;
  const res = await request('POST', '/api/auth/login', {
    email: 'relogin@x.io', password: 'secret123',
  });
  assert.equal(res.status, 200);
  assert.equal(session.impersonatorId, undefined);
});

test('POST /register clears prior session.impersonatorId', async () => {
  session.impersonatorId = 999;
  const res = await request('POST', '/api/auth/register', {
    email: 'firstreg@x.io', password: 'secret123', displayName: 'F',
  });
  assert.equal(res.status, 201);
  assert.equal(session.impersonatorId, undefined);
});

test('POST /guest clears prior session.impersonatorId', async () => {
  session.impersonatorId = 999;
  const res = await request('POST', '/api/auth/guest', {
    guestToken: 'imp-clear-guest-token',
    displayName: 'GuestX',
  });
  assert.equal(res.status, 200);
  assert.equal(session.impersonatorId, undefined);
});
