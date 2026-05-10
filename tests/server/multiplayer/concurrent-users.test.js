// TRI-84: Integration test that boots the real WebSocket server and drives
// many concurrent clients through a full Quiz Battle game. The goal is to
// prove the WS layer + in-memory rooms + DB persistence path stay consistent
// when ~10 users are connected at the same time and broadcasts fan out to
// every player on every round.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';

import { freshDataDir } from '../helpers/db.js';

freshDataDir();

const { default: db } = await import('../../../server/db.js');
const { attachWebSocketServer } = await import('../../../server/multiplayer/ws.js');

// Test-only "session parser" that reads userId / guestId from custom upgrade
// headers. Headers (instead of query string) so we don't have to relax the
// strict `req.url !== '/ws/quiz-battle'` check in ws.js. Avoids dragging
// express-session and a cookie jar into the test harness while still
// exercising the real ws.js authentication path (which only ever reads
// req.session.userId / req.session.guestId).
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
let guestIds = [];
let quizId;

const PLAYER_COUNT = 10; // 1 host + 9 guests
const QUESTION_COUNT = 4;

before(async () => {
  // Seed host + guests + a multi-question quiz the host owns.
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
  ).run('host@concurrent.test', 'h', 'Host').lastInsertRowid;

  const insertGuest = db.prepare(
    'INSERT INTO guests (guestToken, displayName) VALUES (?, ?)'
  );
  guestIds = [];
  for (let i = 1; i < PLAYER_COUNT; i++) {
    const { lastInsertRowid } = insertGuest.run(`guest-token-${i}`, `Guest${i}`);
    guestIds.push(lastInsertRowid);
  }

  quizId = db.prepare(
    'INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)'
  ).run(hostUserId, 'Concurrent Test Quiz').lastInsertRowid;

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

// Open a WS connection authenticated as a host user or a guest. Returns a
// thin client { send, close, messages, waitFor } where `messages` accumulates
// every parsed inbound message and `waitFor(predicate, timeoutMs)` resolves
// with the matching message (or rejects on timeout).
function connectClient({ userId, guestId, label }) {
  const headers = userId
    ? { 'x-test-user-id': String(userId) }
    : { 'x-test-guest-id': String(guestId) };
  const ws = new WebSocket(baseUrl, { headers });
  const messages = [];
  const waiters = []; // [{predicate, resolve, reject, timer}]

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
    // Resolve immediately if we've already seen a matching message.
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

test('TRI-84: 10 concurrent users complete a full Quiz Battle without message loss', async () => {
  const host = connectClient({ userId: hostUserId, label: 'host' });
  const guests = guestIds.map((id, i) =>
    connectClient({ guestId: id, label: `guest${i + 1}` }),
  );
  const all = [host, ...guests];

  try {
    // 1. All sockets connected concurrently.
    await Promise.all(all.map(c => c.opened));

    // 2. Host creates the room and we capture the code from the first
    //    room_state broadcast it receives.
    host.send({ type: 'create_room' });
    const created = await host.waitFor(m => m.type === 'room_state' && m.code);
    const code = created.code;
    assert.equal(typeof code, 'string');
    assert.equal(code.length, 4);

    // 3. All guests fire join_room simultaneously. This is the core
    //    concurrent-user stressor: 9 parallel WS messages mutate the same
    //    in-memory room and broadcast to every other participant.
    await Promise.all(guests.map(g => {
      g.send({ type: 'join_room', code });
      return g.waitFor(m => m.type === 'room_state' && m.code === code);
    }));

    // 4. Host eventually sees PLAYER_COUNT players in the lobby. We poll the
    //    most recent room_state the host received instead of relying on
    //    exact event count, because player_joined events may merge with
    //    room_state echoes server-side over time.
    const allJoined = await host.waitFor(
      (_m) => {
        const latest = [...host.messages].reverse().find(x =>
          x.type === 'room_state' || x.type === 'player_joined',
        );
        if (!latest) return false;
        if (latest.type === 'room_state') {
          return latest.players && latest.players.length === PLAYER_COUNT;
        }
        // player_joined messages don't carry the full roster; fall back to
        // counting distinct join events.
        const joinedIds = new Set(
          host.messages
            .filter(x => x.type === 'player_joined')
            .map(x => x.userId),
        );
        return joinedIds.size === PLAYER_COUNT - 1;
      },
      6000,
    );
    assert.ok(allJoined, 'host should observe all players joining');

    // 5. Host picks the quiz and starts the game.
    host.send({ type: 'select_quiz', quizId });
    await host.waitFor(m =>
      m.type === 'room_state' && m.quiz && m.quiz.id === quizId,
    );

    host.send({ type: 'start_game' });

    // 6. Every client should see round 1 begin. This proves the round_start
    //    broadcast reaches all PLAYER_COUNT subscribers.
    await Promise.all(all.map(c =>
      c.waitFor(m => m.type === 'round_start' && m.currentRound === 1),
    ));

    // 7. Play every round. All players submit the correct answer in a tight
    //    burst — the first to win, the others race in behind. Each round
    //    must produce exactly one round_result on every client before we
    //    advance.
    for (let round = 1; round <= QUESTION_COUNT; round++) {
      const before = all.map(c =>
        c.messages.filter(m => m.type === 'round_result').length,
      );

      // Fire-and-forget submissions in parallel.
      for (const c of all) c.send({ type: 'submit_answer', answer: 0 });

      // Wait for each client to receive the round_result for this round.
      await Promise.all(all.map((c, i) =>
        c.waitFor(m =>
          m.type === 'round_result' &&
          c.messages.filter(x => x.type === 'round_result').length > before[i],
        ),
      ));

      if (round < QUESTION_COUNT) {
        host.send({ type: 'next_round' });
        await Promise.all(all.map(c =>
          c.waitFor(m => m.type === 'round_start' && m.currentRound === round + 1),
        ));
      } else {
        // Last round: any player can advance and trigger game_over.
        host.send({ type: 'next_round' });
        await Promise.all(all.map(c =>
          c.waitFor(m => m.type === 'game_over'),
        ));
      }
    }

    // 8. Final assertions:
    //    - Every client received exactly QUESTION_COUNT round_result frames.
    //    - Every client received exactly one game_over.
    //    - No client received an `error` frame.
    for (const c of all) {
      const rounds = c.messages.filter(m => m.type === 'round_result');
      const overs = c.messages.filter(m => m.type === 'game_over');
      const errors = c.messages.filter(m => m.type === 'error');
      assert.equal(rounds.length, QUESTION_COUNT,
        `[${c.label}] expected ${QUESTION_COUNT} round_result, got ${rounds.length}`);
      assert.equal(overs.length, 1,
        `[${c.label}] expected 1 game_over, got ${overs.length}`);
      assert.deepEqual(errors, [],
        `[${c.label}] expected no error frames, got: ${JSON.stringify(errors)}`);
    }

    // 9. DB side-effects: the registered host should have a math_battle_games
    //    row, a math_battle_players row, and QUESTION_COUNT round records.
    const game = db.prepare(
      'SELECT id, quizId, totalRounds FROM math_battle_games WHERE roomCode = ?'
    ).get(code);
    assert.ok(game, 'game row should be persisted');
    assert.equal(game.quizId, quizId);
    assert.equal(game.totalRounds, QUESTION_COUNT);

    const playerRows = db.prepare(
      'SELECT userId FROM math_battle_players WHERE gameId = ?'
    ).all(game.id);
    // Only the registered host is persisted — guests have negative IDs and
    // are intentionally excluded from math_battle_players (FK -> users).
    assert.equal(playerRows.length, 1);
    assert.equal(playerRows[0].userId, hostUserId);

    const roundRows = db.prepare(
      'SELECT roundNumber FROM math_battle_rounds WHERE gameId = ? ORDER BY roundNumber ASC'
    ).all(game.id);
    assert.equal(roundRows.length, QUESTION_COUNT);
  } finally {
    for (const c of all) c.close();
  }
});
