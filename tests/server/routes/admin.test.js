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
  db.exec('DELETE FROM guests');
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

test('GET /users 403 when caller is archived (even if admin)', async () => {
  db.prepare("UPDATE users SET archivedAt = datetime('now') WHERE id = ?").run(adminId);
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
  assert.equal(admin.archivedAt, null);
  const user = res.body.users.find(u => u.email === 'user@x.io');
  assert.equal(user.isAdmin, false);
  assert.equal(user.archivedAt, null);
});

test('GET /users includes archived users with archivedAt populated', async () => {
  db.prepare("UPDATE users SET archivedAt = datetime('now') WHERE id = ?").run(userId);
  asAdmin();
  const res = await request('GET', '/api/admin/users');
  assert.equal(res.status, 200);
  const archived = res.body.users.find(u => u.id === userId);
  assert.ok(archived);
  assert.ok(archived.archivedAt);
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

// ── POST /users/:id/archive ───────────────────────────

test('POST /users/:id/archive sets archivedAt on a non-admin', async () => {
  asAdmin();
  const res = await request('POST', `/api/admin/users/${userId}/archive`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT archivedAt FROM users WHERE id = ?').get(userId);
  assert.ok(row.archivedAt);
});

test('POST /users/:id/archive is idempotent and preserves original archive time', async () => {
  db.prepare("UPDATE users SET archivedAt = '2026-01-01 00:00:00' WHERE id = ?").run(userId);
  asAdmin();
  const res = await request('POST', `/api/admin/users/${userId}/archive`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT archivedAt FROM users WHERE id = ?').get(userId);
  assert.equal(row.archivedAt, '2026-01-01 00:00:00');
});

test('POST /users/:id/archive 400 cannot archive self', async () => {
  asAdmin();
  const res = await request('POST', `/api/admin/users/${adminId}/archive`);
  assert.equal(res.status, 400);
  const row = db.prepare('SELECT archivedAt FROM users WHERE id = ?').get(adminId);
  assert.equal(row.archivedAt, null);
});

test('POST /users/:id/archive: archiving an admin works when other active admins exist', async () => {
  const second = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName, isAdmin) VALUES (?, ?, ?, 1)'
  ).run('admin2@x.io', 'h', 'Admin2').lastInsertRowid;
  asAdmin();
  const res = await request('POST', `/api/admin/users/${second}/archive`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT archivedAt FROM users WHERE id = ?').get(second);
  assert.ok(row.archivedAt);
});

test('POST /users/:id/archive 404 unknown user', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/users/99999/archive');
  assert.equal(res.status, 404);
});

test('POST /users/:id/archive 400 non-numeric id', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/users/not-a-number/archive');
  assert.equal(res.status, 400);
});

test('POST /users/:id/archive 403 for non-admin caller', async () => {
  asUser();
  const res = await request('POST', `/api/admin/users/${adminId}/archive`);
  assert.equal(res.status, 403);
});

// ── POST /users/:id/unarchive ─────────────────────────

test('POST /users/:id/unarchive clears archivedAt', async () => {
  db.prepare("UPDATE users SET archivedAt = datetime('now') WHERE id = ?").run(userId);
  asAdmin();
  const res = await request('POST', `/api/admin/users/${userId}/unarchive`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT archivedAt FROM users WHERE id = ?').get(userId);
  assert.equal(row.archivedAt, null);
});

test('POST /users/:id/unarchive does not touch disabledAt', async () => {
  db.prepare("UPDATE users SET archivedAt = datetime('now'), disabledAt = datetime('now') WHERE id = ?")
    .run(userId);
  asAdmin();
  const res = await request('POST', `/api/admin/users/${userId}/unarchive`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT archivedAt, disabledAt FROM users WHERE id = ?').get(userId);
  assert.equal(row.archivedAt, null);
  assert.ok(row.disabledAt);
});

test('POST /users/:id/unarchive 404 unknown user', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/users/99999/unarchive');
  assert.equal(res.status, 404);
});

test('POST /users/:id/unarchive 400 non-numeric id', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/users/not-a-number/unarchive');
  assert.equal(res.status, 400);
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
  winnerUserId = null,
  winnerGuestId = null,
  winnerDisplayName = null,
  winnerRoundsWon = null,
  players = [],
  rounds = [],
} = {}) {
  const insertGame = db.prepare(`
    INSERT INTO math_battle_games (
      roomCode, quizId, totalRounds, startedAt, finishedAt,
      winnerUserId, winnerGuestId, winnerDisplayName, winnerRoundsWon
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const gameId = insertGame.run(
    roomCode, quizId, totalRounds, startedAt, finishedAt,
    winnerUserId, winnerGuestId, winnerDisplayName, winnerRoundsWon,
  ).lastInsertRowid;

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

function seedGuest({ displayName = 'Guesty', guestToken = 'tok-' + Math.random() } = {}) {
  return db.prepare(
    'INSERT INTO guests (guestToken, displayName) VALUES (?, ?)'
  ).run(guestToken, displayName).lastInsertRowid;
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

test('GET /games returns games newest first with quiz, duration, and registered winner', async () => {
  const quizId = db.prepare('INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)')
    .run(adminId, 'Capitals').lastInsertRowid;

  const olderGameId = seedGame({
    roomCode: 'OLDR',
    quizId,
    totalRounds: 3,
    startedAt: '2026-05-08 09:00:00',
    finishedAt: '2026-05-08 09:04:00',
    winnerUserId: userId,
    winnerDisplayName: 'User',
    winnerRoundsWon: 2,
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
    winnerUserId: adminId,
    winnerDisplayName: 'Admin',
    winnerRoundsWon: 4,
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
  assert.equal(newer.winner.source, 'user');
  assert.equal(newer.winner.userId, adminId);
  assert.equal(newer.winner.guestId, null);
  assert.equal(newer.winner.displayName, 'Admin');
  assert.equal(newer.winner.roundsWon, 4);
});

test('GET /games surfaces an unregistered guest as the winner', async () => {
  const guestId = seedGuest({ displayName: 'Sneaky Guest' });
  const gameId = seedGame({
    roomCode: 'GSTW',
    winnerGuestId: guestId,
    winnerDisplayName: 'Sneaky Guest',
    winnerRoundsWon: 3,
    // Registered loser participates; guest winner is not in math_battle_players.
    players: [{ userId: userId, roundsWon: 1, chesnutsEarned: 3 }],
  });

  asAdmin();
  const res = await request('GET', '/api/admin/games');
  assert.equal(res.status, 200);
  const g = res.body.games.find(x => x.id === gameId);
  assert.ok(g);
  assert.equal(g.winner.source, 'guest');
  assert.equal(g.winner.userId, null);
  assert.equal(g.winner.guestId, guestId);
  assert.equal(g.winner.displayName, 'Sneaky Guest');
  assert.equal(g.winner.roundsWon, 3);
});

test('GET /games surfaces winner for all-guest games (no math_battle_players rows)', async () => {
  const guestId = seedGuest({ displayName: 'Solo Guest' });
  const gameId = seedGame({
    roomCode: 'ALGS',
    winnerGuestId: guestId,
    winnerDisplayName: 'Solo Guest',
    winnerRoundsWon: 2,
    players: [],
  });

  asAdmin();
  const res = await request('GET', '/api/admin/games');
  assert.equal(res.status, 200);
  const g = res.body.games.find(x => x.id === gameId);
  assert.ok(g);
  assert.equal(g.playerCount, 0);
  assert.equal(g.winner.source, 'guest');
  assert.equal(g.winner.displayName, 'Solo Guest');
  assert.equal(g.winner.roundsWon, 2);
});

test('GET /games falls back to top math_battle_players scorer for legacy rows missing winner snapshot', async () => {
  // Legacy row recorded before TRI-101: winner* columns are NULL but the
  // top math_battle_players row still identifies who took the most rounds.
  seedGame({
    roomCode: 'LEGW',
    players: [
      { userId: adminId, roundsWon: 1, chesnutsEarned: 3 },
      { userId: userId, roundsWon: 3, chesnutsEarned: 9 },
    ],
  });

  asAdmin();
  const res = await request('GET', '/api/admin/games');
  assert.equal(res.status, 200);
  const g = res.body.games[0];
  assert.equal(g.winner.source, 'user');
  assert.equal(g.winner.userId, userId);
  assert.equal(g.winner.displayName, 'User');
  assert.equal(g.winner.roundsWon, 3);
});

test('GET /games returns winner=null for games with no rounds won', async () => {
  seedGame({
    roomCode: 'NOWN',
    players: [{ userId: adminId, roundsWon: 0, chesnutsEarned: 0 }],
  });
  asAdmin();
  const res = await request('GET', '/api/admin/games');
  assert.equal(res.status, 200);
  assert.equal(res.body.games[0].winner, null);
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

test('GET /games/:id returns players, rounds, and winner', async () => {
  const quizId = db.prepare('INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)')
    .run(adminId, 'Trivia').lastInsertRowid;
  const gameId = seedGame({
    roomCode: 'GAME',
    quizId,
    totalRounds: 2,
    startedAt: '2026-05-09 10:00:00',
    finishedAt: '2026-05-09 10:02:00',
    winnerUserId: adminId,
    winnerDisplayName: 'Admin',
    winnerRoundsWon: 1,
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
  assert.equal(game.winner.source, 'user');
  assert.equal(game.winner.displayName, 'Admin');
  assert.equal(game.winner.roundsWon, 1);
});

test('GET /games/:id returns guest winner with empty players list (all-guest game)', async () => {
  const guestId = seedGuest({ displayName: 'Guest Champ' });
  const gameId = seedGame({
    roomCode: 'GSTD',
    winnerGuestId: guestId,
    winnerDisplayName: 'Guest Champ',
    winnerRoundsWon: 2,
    players: [],
  });
  asAdmin();
  const res = await request('GET', `/api/admin/games/${gameId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.game.winner.source, 'guest');
  assert.equal(res.body.game.winner.guestId, guestId);
  assert.equal(res.body.game.winner.displayName, 'Guest Champ');
  assert.equal(res.body.game.players.length, 0);
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

// ── Game archive (TRI-82) ─────────────────────────────

test('GET /games returns archivedAt (null for live games)', async () => {
  seedGame({ roomCode: 'LIVE' });
  asAdmin();
  const res = await request('GET', '/api/admin/games');
  assert.equal(res.status, 200);
  assert.equal(res.body.games[0].archivedAt, null);
});

test('GET /games includes archived games with archivedAt populated', async () => {
  const gameId = seedGame({ roomCode: 'ARCH' });
  db.prepare("UPDATE math_battle_games SET archivedAt = datetime('now') WHERE id = ?").run(gameId);
  asAdmin();
  const res = await request('GET', '/api/admin/games');
  assert.equal(res.status, 200);
  const archived = res.body.games.find(g => g.id === gameId);
  assert.ok(archived);
  assert.ok(archived.archivedAt);
});

test('GET /games/:id returns archivedAt for archived games', async () => {
  const gameId = seedGame({ roomCode: 'ARCD' });
  db.prepare("UPDATE math_battle_games SET archivedAt = '2026-04-01 00:00:00' WHERE id = ?").run(gameId);
  asAdmin();
  const res = await request('GET', `/api/admin/games/${gameId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.game.archivedAt, '2026-04-01 00:00:00');
});

test('POST /games/:id/archive sets archivedAt', async () => {
  const gameId = seedGame({ roomCode: 'TARC' });
  asAdmin();
  const res = await request('POST', `/api/admin/games/${gameId}/archive`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT archivedAt FROM math_battle_games WHERE id = ?').get(gameId);
  assert.ok(row.archivedAt);
});

test('POST /games/:id/archive is idempotent and preserves original archive time', async () => {
  const gameId = seedGame({ roomCode: 'IDEM' });
  db.prepare("UPDATE math_battle_games SET archivedAt = '2026-01-01 00:00:00' WHERE id = ?").run(gameId);
  asAdmin();
  const res = await request('POST', `/api/admin/games/${gameId}/archive`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT archivedAt FROM math_battle_games WHERE id = ?').get(gameId);
  assert.equal(row.archivedAt, '2026-01-01 00:00:00');
});

test('POST /games/:id/archive 404 unknown game', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/games/99999/archive');
  assert.equal(res.status, 404);
});

test('POST /games/:id/archive 400 non-numeric id', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/games/not-a-number/archive');
  assert.equal(res.status, 400);
});

test('POST /games/:id/archive 403 for non-admin caller', async () => {
  const gameId = seedGame({ roomCode: 'NOPE' });
  asUser();
  const res = await request('POST', `/api/admin/games/${gameId}/archive`);
  assert.equal(res.status, 403);
});

test('POST /games/:id/unarchive clears archivedAt', async () => {
  const gameId = seedGame({ roomCode: 'UNAR' });
  db.prepare("UPDATE math_battle_games SET archivedAt = datetime('now') WHERE id = ?").run(gameId);
  asAdmin();
  const res = await request('POST', `/api/admin/games/${gameId}/unarchive`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT archivedAt FROM math_battle_games WHERE id = ?').get(gameId);
  assert.equal(row.archivedAt, null);
});

test('POST /games/:id/unarchive 404 unknown game', async () => {
  asAdmin();
  const res = await request('POST', '/api/admin/games/99999/unarchive');
  assert.equal(res.status, 404);
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
