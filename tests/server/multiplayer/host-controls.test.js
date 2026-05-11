// TRI-99: Only the host (game creator) can advance to the next question.
// Non-host `next_round` messages are rejected and do not advance the game.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';

import { freshDataDir } from '../helpers/db.js';

freshDataDir();

const { default: db } = await import('../../../server/db.js');
const { attachWebSocketServer } = await import('../../../server/multiplayer/ws.js');

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

const QUESTION_COUNT = 3;

before(async () => {
  db.exec('DELETE FROM math_battle_rounds');
  db.exec('DELETE FROM math_battle_players');
  db.exec('DELETE FROM math_battle_games');
  db.exec('DELETE FROM quiz_questions');
  db.exec('DELETE FROM quiz_categories');
  db.exec('DELETE FROM quizzes');
  db.exec('DELETE FROM guests');
  db.exec('DELETE FROM users');

  hostUserId = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName) VALUES (?, ?, ?)'
  ).run('host@host-controls.test', 'h', 'Host').lastInsertRowid;

  guestId = db.prepare(
    'INSERT INTO guests (guestToken, displayName) VALUES (?, ?)'
  ).run('guest-token-tri99', 'Guest').lastInsertRowid;

  quizId = db.prepare(
    'INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)'
  ).run(hostUserId, 'Host Controls Quiz').lastInsertRowid;

  const insertQuestion = db.prepare(
    'INSERT INTO quiz_questions (quizId, position, prompt, type, options, correctAnswers) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (let i = 0; i < QUESTION_COUNT; i++) {
    insertQuestion.run(
      quizId,
      i,
      `Q${i + 1}: pick "a"`,
      'single',
      JSON.stringify(['a', 'b', 'c']),
      JSON.stringify([0]),
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

function connectClient({ userId, guestId: gId, label }) {
  const headers = userId
    ? { 'x-test-user-id': String(userId) }
    : { 'x-test-guest-id': String(gId) };
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

  function waitFor(predicate, timeoutMs = 4000) {
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

  function send(msg) { ws.send(JSON.stringify(msg)); }
  function close() { ws.close(); }

  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  return { ws, send, close, messages, waitFor, opened, label };
}

test('TRI-99: non-host next_round is rejected; host next_round advances the game', async () => {
  const host = connectClient({ userId: hostUserId, label: 'host' });
  const guest = connectClient({ guestId, label: 'guest' });

  try {
    await Promise.all([host.opened, guest.opened]);

    host.send({ type: 'create_room' });
    const created = await host.waitFor(m => m.type === 'room_state' && m.code);
    const code = created.code;

    guest.send({ type: 'join_room', code });
    await guest.waitFor(m => m.type === 'room_state' && m.code === code);
    await host.waitFor(m =>
      (m.type === 'room_state' && m.players && m.players.length === 2) ||
      m.type === 'player_joined',
    );

    host.send({ type: 'select_quiz', quizId });
    await host.waitFor(m => m.type === 'room_state' && m.quiz && m.quiz.id === quizId);

    host.send({ type: 'start_game' });
    await Promise.all([
      host.waitFor(m => m.type === 'round_start' && m.currentRound === 1),
      guest.waitFor(m => m.type === 'round_start' && m.currentRound === 1),
    ]);

    // Both players answer; round resolves to round_result.
    host.send({ type: 'submit_answer', answer: 0 });
    guest.send({ type: 'submit_answer', answer: 0 });
    await Promise.all([
      host.waitFor(m => m.type === 'round_result'),
      guest.waitFor(m => m.type === 'round_result'),
    ]);

    // Non-host tries to advance — server rejects, no round_start, no errors
    // sent to other players.
    guest.send({ type: 'next_round' });
    const err = await guest.waitFor(m => m.type === 'error');
    assert.match(err.message, /host/i);

    // Host hasn't seen a round_start for round 2 yet.
    const hostRoundStarts = host.messages.filter(m => m.type === 'round_start').length;
    assert.equal(hostRoundStarts, 1, 'guest next_round must not advance the round');

    // Host advance succeeds — both clients see round 2 begin.
    host.send({ type: 'next_round' });
    await Promise.all([
      host.waitFor(m => m.type === 'round_start' && m.currentRound === 2),
      guest.waitFor(m => m.type === 'round_start' && m.currentRound === 2),
    ]);

    // Host should not have received any error frames.
    const hostErrors = host.messages.filter(m => m.type === 'error');
    assert.deepEqual(hostErrors, [], `host should see no errors, got ${JSON.stringify(hostErrors)}`);
  } finally {
    host.close();
    guest.close();
  }
});
