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
  db.exec('DELETE FROM math_battle_rounds');
  db.exec('DELETE FROM math_battle_players');
  db.exec('DELETE FROM math_battle_games');
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

// ── GET /games ─────────────────────────────────────────

function seedGame({
  roomCode = 'AAAA',
  quizId = null,
  totalRounds = 2,
  startedAt = '2026-05-09 10:00:00',
  finishedAt = '2026-05-09 10:05:30',
  players = [],
  rounds = [],
} = {}) {
  const insertGame = db.prepare(
    'INSERT INTO math_battle_games (roomCode, quizId, totalRounds, startedAt, finishedAt) VALUES (?, ?, ?, ?, ?)'
  );
  const gameId = insertGame.run(roomCode, quizId, totalRounds, startedAt, finishedAt).lastInsertRowid;

  const insertPlayer = db.prepare(
    'INSERT INTO math_battle_players (gameId, userId, roundsWon, chesnutsEarned) VALUES (?, ?, ?, ?)'
  );
  for (const p of players) insertPlayer.run(gameId, p.userId, p.roundsWon, p.chesnutsEarned);

  const insertRound = db.prepare(
    'INSERT INTO math_battle_rounds (gameId, roundNumber, challenge, correctAnswer, winnerId, timeTakenMs) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of rounds) {
    insertRound.run(gameId, r.roundNumber, r.challenge, r.correctAnswer, r.winnerId ?? null, r.timeTakenMs ?? null);
  }
  return gameId;
}

test('GET /games 401 without session', async () => {
  const res = await request('GET', '/api/admin/games');
  assert.equal(res.status, 401);
});

test('GET /games 403 when caller is not admin', async () => {
  asUser();
  const res = await request('GET', '/api/admin/games');
  assert.equal(res.status, 403);
});

test('GET /games returns games newest first with quiz, duration, and top scorer', async () => {
  const quizId = db.prepare('INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)')
    .run(adminId, 'Capitals').lastInsertRowid;

  const olderGameId = seedGame({
    roomCode: 'OLDR',
    quizId,
    totalRounds: 3,
    startedAt: '2026-05-08 09:00:00',
    finishedAt: '2026-05-08 09:04:00',
    players: [
      { userId: adminId, roundsWon: 1, chesnutsEarned: 3 },
      { userId: userId, roundsWon: 2, chesnutsEarned: 6 },
    ],
  });

  const newerGameId = seedGame({
    roomCode: 'NEWR',
    quizId,
    totalRounds: 5,
    startedAt: '2026-05-09 10:00:00',
    finishedAt: '2026-05-09 10:05:30',
    players: [
      { userId: adminId, roundsWon: 4, chesnutsEarned: 12 },
      { userId: userId, roundsWon: 1, chesnutsEarned: 3 },
    ],
  });

  asAdmin();
  const res = await request('GET', '/api/admin/games');
  assert.equal(res.status, 200);
  assert.equal(res.body.games.length, 2);

  // Newest first.
  assert.equal(res.body.games[0].id, newerGameId);
  assert.equal(res.body.games[1].id, olderGameId);

  const newer = res.body.games[0];
  assert.equal(newer.roomCode, 'NEWR');
  assert.equal(newer.quizId, quizId);
  assert.equal(newer.quizName, 'Capitals');
  assert.equal(newer.totalRounds, 5);
  assert.equal(newer.playerCount, 2);
  assert.equal(newer.durationMs, 5 * 60 * 1000 + 30 * 1000);
  assert.equal(newer.topScorer.userId, adminId);
  assert.equal(newer.topScorer.roundsWon, 4);
  assert.equal(newer.topScorer.displayName, 'Admin');
});

test('GET /games tolerates legacy rows missing startedAt/quizId', async () => {
  seedGame({
    roomCode: 'LEGY',
    quizId: null,
    startedAt: null,
    finishedAt: '2026-05-09 11:00:00',
    players: [{ userId: userId, roundsWon: 0, chesnutsEarned: 0 }],
  });
  asAdmin();
  const res = await request('GET', '/api/admin/games');
  assert.equal(res.status, 200);
  const g = res.body.games[0];
  assert.equal(g.quizId, null);
  assert.equal(g.quizName, null);
  assert.equal(g.startedAt, null);
  assert.equal(g.durationMs, null);
});

// ── GET /games/:id ─────────────────────────────────────

test('GET /games/:id returns players and rounds', async () => {
  const quizId = db.prepare('INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)')
    .run(adminId, 'Trivia').lastInsertRowid;
  const gameId = seedGame({
    roomCode: 'GAME',
    quizId,
    totalRounds: 2,
    startedAt: '2026-05-09 10:00:00',
    finishedAt: '2026-05-09 10:02:00',
    players: [
      { userId: adminId, roundsWon: 1, chesnutsEarned: 3 },
      { userId: userId, roundsWon: 1, chesnutsEarned: 3 },
    ],
    rounds: [
      { roundNumber: 1, challenge: 'p1', correctAnswer: 'a1', winnerId: adminId, timeTakenMs: 1500 },
      { roundNumber: 2, challenge: 'p2', correctAnswer: 'a2', winnerId: null, timeTakenMs: null },
    ],
  });

  asAdmin();
  const res = await request('GET', `/api/admin/games/${gameId}`);
  assert.equal(res.status, 200);
  const game = res.body.game;
  assert.equal(game.id, gameId);
  assert.equal(game.quizName, 'Trivia');
  assert.equal(game.durationMs, 2 * 60 * 1000);
  assert.equal(game.players.length, 2);
  // Sorted by roundsWon desc, then by player row id asc — both have 1, so admin first.
  assert.equal(game.players[0].userId, adminId);
  assert.equal(game.players[0].email, 'admin@x.io');
  assert.equal(game.rounds.length, 2);
  assert.equal(game.rounds[0].winnerDisplayName, 'Admin');
  assert.equal(game.rounds[1].winnerId, null);
  assert.equal(game.rounds[1].winnerDisplayName, null);
});

test('GET /games/:id 404 for unknown game', async () => {
  asAdmin();
  const res = await request('GET', '/api/admin/games/99999');
  assert.equal(res.status, 404);
});

test('GET /games/:id 400 for non-numeric id', async () => {
  asAdmin();
  const res = await request('GET', '/api/admin/games/not-a-number');
  assert.equal(res.status, 400);
});

test('GET /games/:id 403 for non-admin caller', async () => {
  const gameId = seedGame({ roomCode: 'XXXX' });
  asUser();
  const res = await request('GET', `/api/admin/games/${gameId}`);
  assert.equal(res.status, 403);
});

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
  assert.equal(adminQuiz.archivedAt, null);
  const userQuiz = res.body.quizzes.find(q => q.name === 'User Q');
  assert.equal(userQuiz.questionCount, 0);
  assert.equal(userQuiz.ownerEmail, 'user@x.io');
});

test('GET /quizzes includes archived quizzes with archivedAt populated', async () => {
  const q1 = db.prepare("INSERT INTO quizzes (ownerUserId, name, archivedAt) VALUES (?, ?, datetime('now'))")
    .run(userId, 'Archived Q').lastInsertRowid;
  asAdmin();
  const res = await request('GET', '/api/admin/quizzes');
  assert.equal(res.status, 200);
  const archived = res.body.quizzes.find(q => q.id === q1);
  assert.ok(archived);
  assert.ok(archived.archivedAt);
});

// ── POST /quizzes/:id/archive ─────────────────────────

test('POST /quizzes/:id/archive sets archivedAt', async () => {
  const quizId = db.prepare('INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)')
    .run(userId, 'To Archive').lastInsertRowid;
  asAdmin();
  const res = await request('POST', `/api/admin/quizzes/${quizId}/archive`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT archivedAt FROM quizzes WHERE id = ?').get(quizId);
  assert.ok(row.archivedAt);
});

test('POST /quizzes/:id/archive is idempotent and preserves original archive time', async () => {
  const quizId = db.prepare("INSERT INTO quizzes (ownerUserId, name, archivedAt) VALUES (?, ?, '2026-01-01 00:00:00')")
    .run(userId, 'Already Archived').lastInsertRowid;
  asAdmin();
  const res = await request('POST', `/api/admin/quizzes/${quizId}/archive`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT archivedAt FROM quizzes WHERE id = ?').get(quizId);
  assert.equal(row.archivedAt, '2026-01-01 00:00:00');
});

test('POST /quizzes/:id/archive 404 unknown quiz', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/quizzes/99999/archive');
  assert.equal(res.status, 404);
});

test('POST /quizzes/:id/archive 400 non-numeric id', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/quizzes/not-a-number/archive');
  assert.equal(res.status, 400);
});

test('POST /quizzes/:id/archive 403 for non-admin caller', async () => {
  const quizId = db.prepare('INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)')
    .run(userId, 'X').lastInsertRowid;
  asUser();
  const res = await request('POST', `/api/admin/quizzes/${quizId}/archive`);
  assert.equal(res.status, 403);
});

// ── POST /quizzes/:id/unarchive ───────────────────────

test('POST /quizzes/:id/unarchive clears archivedAt', async () => {
  const quizId = db.prepare("INSERT INTO quizzes (ownerUserId, name, archivedAt) VALUES (?, ?, datetime('now'))")
    .run(userId, 'Restore me').lastInsertRowid;
  asAdmin();
  const res = await request('POST', `/api/admin/quizzes/${quizId}/unarchive`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT archivedAt FROM quizzes WHERE id = ?').get(quizId);
  assert.equal(row.archivedAt, null);
});

test('POST /quizzes/:id/unarchive 404 unknown quiz', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/quizzes/99999/unarchive');
  assert.equal(res.status, 404);
});
