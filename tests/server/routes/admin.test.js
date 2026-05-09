import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';

import { freshDataDir } from '../helpers/db.js';
import { makeApp, startServer } from '../helpers/http.js';

freshDataDir();

const { default: db } = await import('../../../server/db.js');
const { default: adminRouter } = await import('../../../server/routes/admin.js');

let server;
let request;
let session;
let adminId;
let userId;

before(async () => {
  const { app, session: s } = makeApp(adminRouter, '/api/admin');
  session = s;
  const handle = await startServer(app);
  request = handle.request;
  server = handle;
});

beforeEach(() => {
  for (const k of Object.keys(session)) delete session[k];
  db.exec('DELETE FROM quiz_questions');
  db.exec('DELETE FROM quiz_categories');
  db.exec('DELETE FROM quizzes');
  db.exec('DELETE FROM users');

  const hash = bcrypt.hashSync('secret123', 4);
  adminId = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName, isAdmin) VALUES (?, ?, ?, 1)'
  ).run('admin@x.io', hash, 'Admin').lastInsertRowid;
  userId = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName, isAdmin) VALUES (?, ?, ?, 0)'
  ).run('user@x.io', hash, 'User').lastInsertRowid;
});

after(async () => {
  await server.close();
});

function asAdmin() { session.userId = adminId; }
function asUser()  { session.userId = userId; }

// ── Auth gate ──────────────────────────────────────────

test('GET /users 401 without session', async () => {
  const res = await request('GET', '/api/admin/users');
  assert.equal(res.status, 401);
});

test('GET /users 403 when caller is not admin', async () => {
  asUser();
  const res = await request('GET', '/api/admin/users');
  assert.equal(res.status, 403);
});

test('GET /users 403 when caller is disabled (even if admin)', async () => {
  db.prepare("UPDATE users SET disabledAt = datetime('now') WHERE id = ?").run(adminId);
  asAdmin();
  const res = await request('GET', '/api/admin/users');
  assert.equal(res.status, 403);
});

test('GET /users 403 when session.userId points to deleted user', async () => {
  asAdmin();
  db.prepare('DELETE FROM users WHERE id = ?').run(adminId);
  const res = await request('GET', '/api/admin/users');
  assert.equal(res.status, 403);
});

// ── GET /users ─────────────────────────────────────────

test('GET /users returns all users with isAdmin booleans', async () => {
  asAdmin();
  const res = await request('GET', '/api/admin/users');
  assert.equal(res.status, 200);
  assert.equal(res.body.users.length, 2);
  const admin = res.body.users.find(u => u.email === 'admin@x.io');
  assert.equal(admin.isAdmin, true);
  const user = res.body.users.find(u => u.email === 'user@x.io');
  assert.equal(user.isAdmin, false);
});

// ── POST /users ────────────────────────────────────────

test('POST /users creates a new user', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/users', {
    email: 'fresh@x.io', displayName: 'Fresh', password: 'secret123',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, 'fresh@x.io');
  assert.equal(res.body.user.isAdmin, false);
  // Confirm row inserted.
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get('fresh@x.io');
  assert.ok(row);
});

test('POST /users with isAdmin=true persists admin flag', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/users', {
    email: 'newadmin@x.io', displayName: 'NA', password: 'secret123', isAdmin: true,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.isAdmin, true);
});

test('POST /users 400 missing fields', async () => {
  asAdmin();
  let res = await request('POST', '/api/admin/users', { email: '', displayName: '', password: '' });
  assert.equal(res.status, 400);
  res = await request('POST', '/api/admin/users', {});
  assert.equal(res.status, 400);
});

test('POST /users 400 short password', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/users', {
    email: 'a@b.co', displayName: 'A', password: 'shrt',
  });
  assert.equal(res.status, 400);
});

test('POST /users 409 duplicate email', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/users', {
    email: 'user@x.io', displayName: 'Dupe', password: 'secret123',
  });
  assert.equal(res.status, 409);
});

// ── POST /users/:id/password ───────────────────────────

test('POST /users/:id/password updates the password hash', async () => {
  asAdmin();
  const res = await request('POST', `/api/admin/users/${userId}/password`, {
    password: 'brand-new-pw',
  });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT passwordHash FROM users WHERE id = ?').get(userId);
  assert.ok(bcrypt.compareSync('brand-new-pw', row.passwordHash));
});

test('POST /users/:id/password 400 short password', async () => {
  asAdmin();
  const res = await request('POST', `/api/admin/users/${userId}/password`, { password: 'x' });
  assert.equal(res.status, 400);
});

test('POST /users/:id/password 400 missing body', async () => {
  asAdmin();
  const res = await request('POST', `/api/admin/users/${userId}/password`, {});
  assert.equal(res.status, 400);
});

test('POST /users/:id/password 404 unknown user', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/users/99999/password', {
    password: 'secret123',
  });
  assert.equal(res.status, 404);
});

// ── POST /users/:id/disable ───────────────────────────

test('POST /users/:id/disable disables a non-admin', async () => {
  asAdmin();
  const res = await request('POST', `/api/admin/users/${userId}/disable`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT disabledAt FROM users WHERE id = ?').get(userId);
  assert.ok(row.disabledAt);
});

test('POST /users/:id/disable 400 cannot disable self', async () => {
  asAdmin();
  const res = await request('POST', `/api/admin/users/${adminId}/disable`);
  assert.equal(res.status, 400);
});

test('POST /users/:id/disable 404 unknown user', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/users/99999/disable');
  assert.equal(res.status, 404);
});

test('POST /users/:id/disable: disabling an admin works when other active admins exist', async () => {
  // Adds a second active admin so disabling them passes the last-admin guard.
  const second = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName, isAdmin) VALUES (?, ?, ?, ?)'
  ).run('admin2@x.io', 'h', 'Admin2', 1).lastInsertRowid;
  asAdmin();
  const res = await request('POST', `/api/admin/users/${second}/disable`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT disabledAt FROM users WHERE id = ?').get(second);
  assert.ok(row.disabledAt);
});

// ── POST /users/:id/enable ────────────────────────────

test('POST /users/:id/enable restores access', async () => {
  db.prepare("UPDATE users SET disabledAt = datetime('now') WHERE id = ?").run(userId);
  asAdmin();
  const res = await request('POST', `/api/admin/users/${userId}/enable`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT disabledAt FROM users WHERE id = ?').get(userId);
  assert.equal(row.disabledAt, null);
});

test('POST /users/:id/enable 404 unknown user', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/users/99999/enable');
  assert.equal(res.status, 404);
});

// ── POST /users/:id/admin ─────────────────────────────

test('POST /users/:id/admin promotes a user to admin', async () => {
  asAdmin();
  const res = await request('POST', `/api/admin/users/${userId}/admin`, { isAdmin: true });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT isAdmin FROM users WHERE id = ?').get(userId);
  assert.equal(row.isAdmin, 1);
});

test('POST /users/:id/admin demotes a user from admin', async () => {
  // Add a second admin so demoting userId is possible.
  const second = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName, isAdmin) VALUES (?, ?, ?, ?)'
  ).run('admin2@x.io', 'h', 'Admin2', 1).lastInsertRowid;
  asAdmin();
  const res = await request('POST', `/api/admin/users/${second}/admin`, { isAdmin: false });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT isAdmin FROM users WHERE id = ?').get(second);
  assert.equal(row.isAdmin, 0);
});

test('POST /users/:id/admin 404 unknown user', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/users/99999/admin', { isAdmin: true });
  assert.equal(res.status, 404);
});

test('POST /users/:id/admin 400 cannot remove own admin role', async () => {
  asAdmin();
  const res = await request('POST', `/api/admin/users/${adminId}/admin`, { isAdmin: false });
  assert.equal(res.status, 400);
});

test('POST /users/:id/admin: demoting a non-admin no-ops without the last-admin guard', async () => {
  // Demoting a non-admin (target.isAdmin is already 0) skips both guards
  // and just runs the UPDATE — exercises the !target.isAdmin branch.
  asAdmin();
  const res = await request('POST', `/api/admin/users/${userId}/admin`, { isAdmin: false });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT isAdmin FROM users WHERE id = ?').get(userId);
  assert.equal(row.isAdmin, 0);
});

// ── GET /quizzes ──────────────────────────────────────

test('GET /quizzes lists every quiz with owner info and question counts', async () => {
  // Owner-1 quiz with 2 questions, owner-2 quiz with 0.
  const q1 = db.prepare('INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)').run(adminId, 'Admin Q').lastInsertRowid;
  db.prepare('INSERT INTO quiz_questions (quizId, position, prompt, type, options, correctAnswers) VALUES (?, ?, ?, ?, ?, ?)')
    .run(q1, 1, 'p1', 'free', '[]', '["a"]');
  db.prepare('INSERT INTO quiz_questions (quizId, position, prompt, type, options, correctAnswers) VALUES (?, ?, ?, ?, ?, ?)')
    .run(q1, 2, 'p2', 'free', '[]', '["b"]');
  db.prepare('INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)').run(userId, 'User Q');

  asAdmin();
  const res = await request('GET', '/api/admin/quizzes');
  assert.equal(res.status, 200);
  assert.equal(res.body.quizzes.length, 2);
  const adminQuiz = res.body.quizzes.find(q => q.name === 'Admin Q');
  assert.equal(adminQuiz.questionCount, 2);
  assert.equal(adminQuiz.ownerEmail, 'admin@x.io');
  const userQuiz = res.body.quizzes.find(q => q.name === 'User Q');
  assert.equal(userQuiz.questionCount, 0);
  assert.equal(userQuiz.ownerEmail, 'user@x.io');
});
