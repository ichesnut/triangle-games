// TRI-100: replaces "vote to finish" with host-only `end_game` plus an
// admin force-end via the HTTP route. This drives the real WS server so we
// can prove the host gate (non-hosts get an error, host triggers a clean
// game_over), and exercises snapshotActiveRooms/endActiveGameAsAdmin so the
// admin route's contract stays honest.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';

import { freshDataDir } from '../helpers/db.js';

freshDataDir();

const { default: db } = await import('../../../server/db.js');
const {
  attachWebSocketServer,
  snapshotActiveRooms,
  endActiveGameAsAdmin,
} = await import('../../../server/multiplayer/ws.js');

function headerSessionParser(req, _res, next) {
  const userId = req.headers['x-test-user-id'];
  const guestId = req.headers['x-test-guest-id'];
  req.session = {};
  if (userId) req.session.userId = Number(userId);
  if (guestId) req.session.guestId = Number(guestId);
  next();
}

let server;
let baseUrl;
let hostUserId;
let guestId;
let quizId;

before(async () => {
  db.exec('DELETE FROM math_battle_rounds');
  db.exec('DELETE FROM math_battle_players');
  db.exec('DELETE FROM math_battle_guest_players');
  db.exec('DELETE FROM math_battle_games');
  db.exec('DELETE FROM quiz_questions');
  db.exec('DELETE FROM quiz_categories');
  db.exec('DELETE FROM quizzes');
  db.exec('DELETE FROM guests');
  db.exec('DELETE FROM users');

  hostUserId = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName) VALUES (?, ?, ?)'
  ).run('host@end-game.test', 'h', 'Host').lastInsertRowid;
  guestId = db.prepare(
    'INSERT INTO guests (guestToken, displayName) VALUES (?, ?)'
  ).run('end-game-guest', 'GuestPlayer').lastInsertRowid;

  quizId = db.prepare(
    'INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)'
  ).run(hostUserId, 'End Game Quiz').lastInsertRowid;
  // 4 questions so an early end leaves rounds on the table.
  const insertQuestion = db.prepare(
    'INSERT INTO quiz_questions (quizId, position, prompt, type, options, correctAnswers) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (let i = 0; i < 4; i++) {
    insertQuestion.run(
      quizId, i, `Q${i + 1}: pick "a"`, 'single',
      JSON.stringify(['a', 'b', 'c']), JSON.stringify([0]),
    );
  }

  server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachWebSocketServer(server, headerSessionParser);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `ws://127.0.0.1:${port}/ws/quiz-battle`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function connectClient({ userId, guestId: gid, label }) {
  const headers = userId
    ? { 'x-test-user-id': String(userId) }
    : { 'x-test-guest-id': String(gid) };
  const ws = new WebSocket(baseUrl, { headers });
  const messages = [];
  const waiters = [];

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.predicate(msg)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(msg);
      }
    }
  });

  function waitFor(predicate, timeoutMs = 5000) {
    for (const m of messages) if (predicate(m)) return Promise.resolve(m);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex(w => w.predicate === predicate);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(
          `[${label}] timed out waiting for message after ${timeoutMs}ms; ` +
          `last 3 seen: ${JSON.stringify(messages.slice(-3))}`,
        ));
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timer });
    });
  }

  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  return {
    ws, messages, waitFor, opened, label,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}

async function startPlayingRoom() {
  const host = connectClient({ userId: hostUserId, label: 'host' });
  const guest = connectClient({ guestId, label: 'guest' });
  await Promise.all([host.opened, guest.opened]);

  host.send({ type: 'create_room' });
  const created = await host.waitFor(m => m.type === 'room_state' && m.code);
  const code = created.code;

  guest.send({ type: 'join_room', code });
  await guest.waitFor(m => m.type === 'room_state' && m.code === code);
  await host.waitFor(m => m.type === 'player_joined');

  host.send({ type: 'select_quiz', quizId });
  await host.waitFor(m => m.type === 'room_state' && m.quiz && m.quiz.id === quizId);

  host.send({ type: 'start_game' });
  await Promise.all([
    host.waitFor(m => m.type === 'round_start' && m.currentRound === 1),
    guest.waitFor(m => m.type === 'round_start' && m.currentRound === 1),
  ]);

  return { host, guest, code };
}

test('end_game: non-host gets an error and the room keeps playing', async () => {
  const { host, guest, code } = await startPlayingRoom();
  try {
    guest.send({ type: 'end_game' });
    const err = await guest.waitFor(m => m.type === 'error');
    assert.match(err.message, /only the game creator/i);
    // Sanity: no game_over fired, room is still playing for both clients.
    assert.equal(host.messages.find(m => m.type === 'game_over'), undefined);
    assert.equal(guest.messages.find(m => m.type === 'game_over'), undefined);
    assert.ok(snapshotActiveRooms().some(r => r.code === code && r.state === 'playing'));
  } finally {
    host.close();
    guest.close();
  }
});

test('end_game: host ends mid-game, both clients get game_over and the room is dropped', async () => {
  const { host, guest, code } = await startPlayingRoom();
  try {
    host.send({ type: 'end_game' });
    const [hostOver, guestOver] = await Promise.all([
      host.waitFor(m => m.type === 'game_over'),
      guest.waitFor(m => m.type === 'game_over'),
    ]);
    // Host-initiated end is a clean finish (not aborted) and carries the
    // standard finishGame payload.
    assert.equal(hostOver.aborted, undefined);
    assert.equal(guestOver.aborted, undefined);
    assert.equal(typeof hostOver.totalRounds, 'number');
    // Room is gone from the in-memory map.
    assert.equal(snapshotActiveRooms().some(r => r.code === code), false);
  } finally {
    host.close();
    guest.close();
  }
});

test('endActiveGameAsAdmin: ends a playing room, broadcasts aborted=ended_by_admin, drops it', async () => {
  const { host, guest, code } = await startPlayingRoom();
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM math_battle_games').get().n;

    const snap = snapshotActiveRooms().find(r => r.code === code);
    assert.ok(snap, 'admin snapshot should list the active room');
    assert.equal(snap.state, 'playing');
    assert.equal(snap.hostUserId, hostUserId);
    assert.equal(snap.quiz.id, quizId);
    assert.equal(snap.players.length, 2);

    endActiveGameAsAdmin(code);

    const [hostOver, guestOver] = await Promise.all([
      host.waitFor(m => m.type === 'game_over'),
      guest.waitFor(m => m.type === 'game_over'),
    ]);
    assert.equal(hostOver.aborted, true);
    assert.equal(hostOver.reason, 'ended_by_admin');
    assert.equal(guestOver.aborted, true);
    assert.equal(guestOver.reason, 'ended_by_admin');

    assert.equal(snapshotActiveRooms().some(r => r.code === code), false);
    const after = db.prepare('SELECT COUNT(*) AS n FROM math_battle_games').get().n;
    assert.equal(after, before + 1, 'admin force-end should record a math_battle_games row');
  } finally {
    host.close();
    guest.close();
  }
});

test('endActiveGameAsAdmin: throws 404 for unknown room and 400 for non-playing room', () => {
  let caught;
  try { endActiveGameAsAdmin('ZZZZ'); } catch (e) { caught = e; }
  assert.ok(caught, 'should throw for unknown room');
  assert.equal(caught.status, 404);
});
