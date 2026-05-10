// TRI-85: Integration test that boots the real WebSocket server and runs
// several Quiz Battle games in parallel. Where TRI-84 stressed many users
// inside ONE room, this proves the WS layer + in-memory rooms + DB
// persistence stay isolated when multiple independent rooms are at every
// stage of the protocol at the same time — no cross-room broadcasts, no
// DB row mixups, no shared-state leaks.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';

import { freshDataDir } from '../helpers/db.js';

freshDataDir();

const { default: db } = await import('../../../server/db.js');
const { attachWebSocketServer } = await import('../../../server/multiplayer/ws.js');

// Same trick as concurrent-users.test.js: a test-only "session parser" that
// reads userId/guestId from custom upgrade headers, so we don't have to drag
// express-session and a cookie jar in just to exercise ws.js auth.
function headerSessionParser(req, _res, next) {
  const userId = req.headers['x-test-user-id'];
  const guestId = req.headers['x-test-guest-id'];
  req.session = {};
  if (userId) req.session.userId = Number(userId);
  if (guestId) req.session.guestId = Number(guestId);
  next();
}

const GAME_COUNT = 4;            // 4 rooms running in parallel
const PLAYERS_PER_GAME = 3;      // 1 host + 2 guests per room
const QUESTION_COUNT = 3;        // 3 rounds per game

// Tag each question's prompt with the game index so we can detect any
// cross-room broadcast leak: if a client in game G ever receives a
// round_result whose challenge prompt is tagged for game G' != G, the
// fan-out has bled across rooms.
function promptFor(gameIndex, qIndex) {
  return `[G${gameIndex}] Q${qIndex + 1}: pick "a"`;
}

let server;
let baseUrl;
// Per-game seeded data: hostUserId, guestIds[2], quizId.
const games = [];

before(async () => {
  db.exec('DELETE FROM math_battle_rounds');
  db.exec('DELETE FROM math_battle_players');
  db.exec('DELETE FROM math_battle_games');
  db.exec('DELETE FROM quiz_questions');
  db.exec('DELETE FROM quiz_categories');
  db.exec('DELETE FROM quizzes');
  db.exec('DELETE FROM guests');
  db.exec('DELETE FROM users');

  const insertUser = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName) VALUES (?, ?, ?)'
  );
  const insertGuest = db.prepare(
    'INSERT INTO guests (guestToken, displayName) VALUES (?, ?)'
  );
  const insertQuiz = db.prepare(
    'INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)'
  );
  const insertQuestion = db.prepare(
    'INSERT INTO quiz_questions (quizId, position, prompt, type, options, correctAnswers) VALUES (?, ?, ?, ?, ?, ?)'
  );

  for (let g = 0; g < GAME_COUNT; g++) {
    const hostUserId = insertUser.run(
      `host-${g}@concurrent-games.test`, 'h', `Host${g}`,
    ).lastInsertRowid;

    const guestIds = [];
    for (let i = 1; i < PLAYERS_PER_GAME; i++) {
      guestIds.push(
        insertGuest.run(`guest-token-${g}-${i}`, `G${g}P${i}`).lastInsertRowid,
      );
    }

    const quizId = insertQuiz.run(hostUserId, `Quiz ${g}`).lastInsertRowid;
    for (let q = 0; q < QUESTION_COUNT; q++) {
      insertQuestion.run(
        quizId,
        q,
        promptFor(g, q),
        'single',
        JSON.stringify(['a', 'b', 'c']),
        JSON.stringify([0]),
      );
    }

    games.push({ index: g, hostUserId, guestIds, quizId });
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

// Lightweight client identical in spirit to the one in concurrent-users.test.js
// but kept local to this file so the two tests stay independently readable.
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

  function send(msg) { ws.send(JSON.stringify(msg)); }
  function close() { ws.close(); }

  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  return { ws, send, close, messages, waitFor, opened, label };
}

test('TRI-85: multiple games run concurrently in isolation', async () => {
  // 1. Open every WS connection for every game at once.
  const sessions = games.map((g) => {
    const host = connectClient({
      userId: g.hostUserId,
      label: `g${g.index}-host`,
    });
    const guests = g.guestIds.map((id, i) => connectClient({
      guestId: id,
      label: `g${g.index}-guest${i + 1}`,
    }));
    return { ...g, host, guests, all: [host, ...guests] };
  });
  const everyClient = sessions.flatMap(s => s.all);

  try {
    await Promise.all(everyClient.map(c => c.opened));

    // 2. Hosts create rooms in parallel; collect each game's code.
    await Promise.all(sessions.map(async (s) => {
      s.host.send({ type: 'create_room' });
      const created = await s.host.waitFor(m => m.type === 'room_state' && m.code);
      s.code = created.code;
    }));

    const allCodes = sessions.map(s => s.code);
    assert.equal(new Set(allCodes).size, GAME_COUNT,
      `expected ${GAME_COUNT} unique room codes, got ${JSON.stringify(allCodes)}`);

    // 3. Guests across every game join their own room in parallel. This is
    //    the core cross-room stressor: GAME_COUNT * (PLAYERS_PER_GAME - 1)
    //    join_room messages hit the server back-to-back and the broadcasts
    //    must only reach players in the matching room.
    await Promise.all(sessions.flatMap(s =>
      s.guests.map(g => {
        g.send({ type: 'join_room', code: s.code });
        return g.waitFor(m => m.type === 'room_state' && m.code === s.code);
      }),
    ));

    // 4. Each host should see its full roster. Join broadcasts arrive as
    //    `player_joined` events on the host (only the joiner gets a fresh
    //    `room_state`), so count distinct join events plus the host itself.
    await Promise.all(sessions.map(s =>
      s.host.waitFor((_m) => {
        const joinedIds = new Set(
          s.host.messages
            .filter(x => x.type === 'player_joined')
            .map(x => x.userId),
        );
        return joinedIds.size === PLAYERS_PER_GAME - 1;
      }, 6000),
    ));

    // 5. Every host picks its quiz, then starts its game — all in parallel.
    await Promise.all(sessions.map(async (s) => {
      s.host.send({ type: 'select_quiz', quizId: s.quizId });
      await s.host.waitFor(m =>
        m.type === 'room_state' && m.code === s.code &&
        m.quiz && m.quiz.id === s.quizId,
      );
    }));

    sessions.forEach(s => s.host.send({ type: 'start_game' }));

    // Every client across every game must see round 1 begin in its own room.
    await Promise.all(sessions.flatMap(s =>
      s.all.map(c =>
        c.waitFor(m =>
          m.type === 'round_start' && m.code === s.code && m.currentRound === 1,
        ),
      ),
    ));

    // 6. Play every round, interleaving submissions across all games.
    for (let round = 1; round <= QUESTION_COUNT; round++) {
      const before = new Map(
        everyClient.map(c =>
          [c, c.messages.filter(m => m.type === 'round_result').length],
        ),
      );

      // Fire submissions for every player in every game in a single burst.
      for (const s of sessions) {
        for (const c of s.all) c.send({ type: 'submit_answer', answer: 0 });
      }

      // Each client receives one new round_result whose challenge prompt is
      // tagged for ITS game. The prompt check catches any cross-room leak —
      // round_result doesn't carry a room code, so the tag is the proxy.
      await Promise.all(sessions.flatMap(s =>
        s.all.map(c =>
          c.waitFor(m =>
            m.type === 'round_result' &&
            c.messages.filter(x => x.type === 'round_result').length > before.get(c),
          ),
        ),
      ));

      for (const s of sessions) {
        const expectedPrompt = promptFor(s.index, round - 1);
        for (const c of s.all) {
          const r = c.messages.filter(m => m.type === 'round_result').at(-1);
          assert.equal(r.challenge, expectedPrompt,
            `[${c.label}] round ${round}: expected challenge "${expectedPrompt}", got "${r.challenge}"`);
        }
      }

      // Advance — last round's next_round triggers game_over instead of
      // another round_start.
      sessions.forEach(s => s.host.send({ type: 'next_round' }));

      if (round < QUESTION_COUNT) {
        await Promise.all(sessions.flatMap(s =>
          s.all.map(c =>
            c.waitFor(m =>
              m.type === 'round_start' && m.code === s.code &&
              m.currentRound === round + 1,
            ),
          ),
        ));
      } else {
        await Promise.all(sessions.flatMap(s =>
          s.all.map(c => c.waitFor(m => m.type === 'game_over')),
        ));
      }
    }

    // 7. Per-client correctness across every game.
    for (const s of sessions) {
      for (const c of s.all) {
        const rounds = c.messages.filter(m => m.type === 'round_result');
        const overs = c.messages.filter(m => m.type === 'game_over');
        const errors = c.messages.filter(m => m.type === 'error');
        assert.equal(rounds.length, QUESTION_COUNT,
          `[${c.label}] expected ${QUESTION_COUNT} round_result, got ${rounds.length}`);
        assert.equal(overs.length, 1,
          `[${c.label}] expected 1 game_over, got ${overs.length}`);
        assert.deepEqual(errors, [],
          `[${c.label}] expected no error frames, got: ${JSON.stringify(errors)}`);

        // No frame this client ever received should reference another room's
        // code. (round_result/game_over carry no code, so this only catches
        // the room_state/round_start/player_joined family — but those are
        // exactly the broadcasts that fan out per-room.)
        const leakedCode = c.messages.find(
          m => typeof m.code === 'string' && m.code !== s.code,
        );
        assert.equal(leakedCode, undefined,
          `[${c.label}] saw foreign room code in message: ${JSON.stringify(leakedCode)}`);
      }
    }

    // 8. DB side-effects: each room produced its OWN game row with its OWN
    //    quizId, only the registered host is persisted, and the rounds count
    //    matches.
    for (const s of sessions) {
      const game = db.prepare(
        'SELECT id, quizId, totalRounds FROM math_battle_games WHERE roomCode = ?'
      ).get(s.code);
      assert.ok(game, `[g${s.index}] game row should be persisted for code ${s.code}`);
      assert.equal(game.quizId, s.quizId,
        `[g${s.index}] expected quizId ${s.quizId}, got ${game.quizId}`);
      assert.equal(game.totalRounds, QUESTION_COUNT);

      const playerRows = db.prepare(
        'SELECT userId FROM math_battle_players WHERE gameId = ?'
      ).all(game.id);
      assert.equal(playerRows.length, 1,
        `[g${s.index}] expected only the registered host in math_battle_players`);
      assert.equal(playerRows[0].userId, s.hostUserId);

      const roundRows = db.prepare(
        'SELECT roundNumber FROM math_battle_rounds WHERE gameId = ? ORDER BY roundNumber ASC'
      ).all(game.id);
      assert.equal(roundRows.length, QUESTION_COUNT);
    }

    // One row per game; nothing extra spilled into the schema.
    const totalGames = db.prepare(
      'SELECT COUNT(*) AS n FROM math_battle_games'
    ).get().n;
    assert.equal(totalGames, GAME_COUNT);
  } finally {
    for (const c of everyClient) c.close();
  }
});
