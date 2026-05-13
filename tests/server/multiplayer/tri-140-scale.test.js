// TRI-140: Scale verification — 50 concurrent players in one game with a
// 20-question quiz. Extends the TRI-84 pattern (10 players / 4 questions) to
// the size the product spec calls out, and records broadcast fan-out latency
// per round so a regression in WS throughput is visible in test output, not
// just in a pass/fail bit.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';

import { freshDataDir } from '../helpers/db.js';

freshDataDir();

const { default: db } = await import('../../../server/db.js');
const { attachWebSocketServer } = await import('../../../server/multiplayer/ws.js');

// See TRI-84 test for rationale: header-based "session parser" lets us
// authenticate WS upgrades without dragging express-session into the harness.
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

const PLAYER_COUNT = 50; // 1 host + 49 guests
const QUESTION_COUNT = 20;
// Generous per-message timeout: at 50 players the round_result fan-out is
// 50 sends per round, plus the 49 parallel join_room broadcasts (~2.4k sends)
// at room setup. A laptop comfortably finishes each in <1s, but CI can be
// noisy; 15s leaves slack without hiding real WS stalls.
const WAIT_TIMEOUT_MS = 15_000;

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
  ).run('host@tri140.test', 'h', 'Host').lastInsertRowid;

  const insertGuest = db.prepare(
    'INSERT INTO guests (guestToken, displayName) VALUES (?, ?)'
  );
  guestIds = [];
  for (let i = 1; i < PLAYER_COUNT; i++) {
    const { lastInsertRowid } = insertGuest.run(`tri140-guest-${i}`, `Guest${i}`);
    guestIds.push(lastInsertRowid);
  }

  quizId = db.prepare(
    'INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)'
  ).run(hostUserId, 'TRI-140 Scale Quiz').lastInsertRowid;

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

function connectClient({ userId, guestId, label }) {
  const headers = userId
    ? { 'x-test-user-id': String(userId) }
    : { 'x-test-guest-id': String(guestId) };
  const ws = new WebSocket(baseUrl, { headers });
  const messages = [];
  const waiters = [];

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    msg.__recvAt = Date.now();
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

  function waitFor(predicate, timeoutMs = WAIT_TIMEOUT_MS) {
    for (const m of messages) if (predicate(m)) return Promise.resolve(m);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex(w => w.predicate === predicate);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(
          `[${label}] timed out waiting for message after ${timeoutMs}ms; ` +
          `last 3 seen: ${JSON.stringify(messages.slice(-3).map(({ __recvAt, ...m }) => m))}`,
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

test('TRI-140: 50 concurrent users complete a 20-question Quiz Battle without message loss', async () => {
  const host = connectClient({ userId: hostUserId, label: 'host' });
  const guests = guestIds.map((id, i) =>
    connectClient({ guestId: id, label: `guest${i + 1}` }),
  );
  const all = [host, ...guests];

  const roundFanoutMs = []; // [{ round, count, min, max, mean }]

  try {
    await Promise.all(all.map(c => c.opened));

    host.send({ type: 'create_room' });
    const created = await host.waitFor(m => m.type === 'room_state' && m.code);
    const code = created.code;
    assert.equal(typeof code, 'string');
    assert.equal(code.length, 4);

    // 49 parallel joins — the real concurrent-user stressor at this scale.
    await Promise.all(guests.map(g => {
      g.send({ type: 'join_room', code });
      return g.waitFor(m => m.type === 'room_state' && m.code === code);
    }));

    // Wait for the host's view to reach 50 players.
    await host.waitFor(() => {
      const latest = [...host.messages].reverse().find(x =>
        x.type === 'room_state' || x.type === 'player_joined',
      );
      if (latest?.type === 'room_state' && latest.players?.length === PLAYER_COUNT) return true;
      const joinedIds = new Set(
        host.messages.filter(x => x.type === 'player_joined').map(x => x.userId),
      );
      return joinedIds.size === PLAYER_COUNT - 1;
    });

    host.send({ type: 'select_quiz', quizId });
    await host.waitFor(m =>
      m.type === 'room_state' && m.quiz && m.quiz.id === quizId,
    );

    host.send({ type: 'start_game' });

    await Promise.all(all.map(c =>
      c.waitFor(m => m.type === 'round_start' && m.currentRound === 1),
    ));

    for (let round = 1; round <= QUESTION_COUNT; round++) {
      const before = all.map(c =>
        c.messages.filter(m => m.type === 'round_result').length,
      );

      // All 50 players answer (correctly) in a tight burst. The first to be
      // accepted wins; the rest get answer_received + the broadcast result.
      const submitAt = Date.now();
      for (const c of all) c.send({ type: 'submit_answer', answer: 0 });

      // Wait for round_result on every client and record per-client fan-out
      // latency (server submit → client receive).
      const recvTimes = await Promise.all(all.map(async (c, i) => {
        const msg = await c.waitFor(m =>
          m.type === 'round_result' &&
          c.messages.filter(x => x.type === 'round_result').length > before[i],
        );
        return msg.__recvAt;
      }));
      const min = Math.min(...recvTimes) - submitAt;
      const max = Math.max(...recvTimes) - submitAt;
      const mean = Math.round(
        recvTimes.reduce((s, t) => s + (t - submitAt), 0) / recvTimes.length,
      );
      roundFanoutMs.push({ round, count: recvTimes.length, min, max, mean });

      if (round < QUESTION_COUNT) {
        host.send({ type: 'next_round' });
        await Promise.all(all.map(c =>
          c.waitFor(m => m.type === 'round_start' && m.currentRound === round + 1),
        ));
      } else {
        host.send({ type: 'next_round' });
        await Promise.all(all.map(c =>
          c.waitFor(m => m.type === 'game_over'),
        ));
      }
    }

    // Reliability assertions.
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

    // DB persistence assertions.
    const game = db.prepare(
      'SELECT id, quizId, totalRounds FROM math_battle_games WHERE roomCode = ?'
    ).get(code);
    assert.ok(game, 'game row should be persisted');
    assert.equal(game.quizId, quizId);
    assert.equal(game.totalRounds, QUESTION_COUNT);

    const playerRows = db.prepare(
      'SELECT userId FROM math_battle_players WHERE gameId = ?'
    ).all(game.id);
    assert.equal(playerRows.length, 1, 'one registered host should be persisted');
    assert.equal(playerRows[0].userId, hostUserId);

    const guestPlayerRows = db.prepare(
      'SELECT guestId FROM math_battle_guest_players WHERE gameId = ? ORDER BY id ASC'
    ).all(game.id);
    assert.equal(guestPlayerRows.length, guestIds.length,
      `expected ${guestIds.length} guest player rows, got ${guestPlayerRows.length}`);
    // Count alone misses "one guest dropped, another's row duplicated"-shape
    // bugs — verify the full set of guest ids landed in the table.
    assert.deepEqual(
      guestPlayerRows.map(r => r.guestId).sort((a, b) => a - b),
      [...guestIds].sort((a, b) => a - b),
    );

    const roundRows = db.prepare(
      'SELECT roundNumber FROM math_battle_rounds WHERE gameId = ?'
    ).all(game.id);
    assert.equal(roundRows.length, QUESTION_COUNT);

    // Surface latency stats in test output. Not an assertion (we don't want
    // a flaky CI box to fail a correctness test on timing), but a regression
    // here is visible to anyone reading the run.
    const worstRound = roundFanoutMs.reduce((a, b) => (b.max > a.max ? b : a));
    const avgMax = Math.round(
      roundFanoutMs.reduce((s, r) => s + r.max, 0) / roundFanoutMs.length,
    );
    console.log(
      `[TRI-140] ${PLAYER_COUNT} players × ${QUESTION_COUNT} rounds; ` +
      `per-round fan-out max: avg ${avgMax}ms, worst round ${worstRound.round} = ${worstRound.max}ms ` +
      `(min ${worstRound.min}ms, mean ${worstRound.mean}ms)`,
    );
  } finally {
    for (const c of all) c.close();
  }
});
