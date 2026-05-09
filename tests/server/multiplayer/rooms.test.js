import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRoom,
  addPlayer,
  removePlayer,
  getRoom,
  deleteRoom,
  setQuiz,
  startGame,
  startRound,
  submitAnswer,
  resolveRound,
  nextRound,
  hasMoreQuestions,
  voteFinish,
  finishGame,
  getRoomState,
} from '../../../server/multiplayer/rooms.js';

const fakeWs = () => ({ send: () => {} });

function makeQuiz(overrides = {}) {
  return {
    id: 1,
    name: 'Test Quiz',
    questions: [
      {
        id: 10,
        prompt: 'Capital of France?',
        type: 'free',
        options: [],
        correctAnswers: ['Paris'],
      },
      {
        id: 11,
        prompt: 'Pick the vowel',
        type: 'single',
        options: ['b', 'a', 'c'],
        correctAnswers: [1],
      },
      {
        id: 12,
        prompt: 'Pick the primes',
        type: 'multiple',
        options: ['1', '2', '3', '4'],
        correctAnswers: [1, 2],
      },
    ],
    ...overrides,
  };
}

// Helper: create a room with N players seeded with consistent IDs.
// Returns { room, players: [{userId, displayName, ws}, ...] }.
function seededRoom(playerCount = 2, hostUserId = 1) {
  const room = createRoom(hostUserId, `Player${hostUserId}`);
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    const userId = i === 0 ? hostUserId : 100 + i;
    const ws = fakeWs();
    addPlayer(room, userId, `Player${userId}`, ws);
    players.push({ userId, displayName: `Player${userId}`, ws });
  }
  return { room, players };
}

test('createRoom: builds a lobby room with a 4-char code and zeroed state', () => {
  const room = createRoom(42, 'Host');
  assert.equal(typeof room.code, 'string');
  assert.equal(room.code.length, 4);
  assert.match(room.code, /^[A-Z2-9]{4}$/);
  assert.equal(room.hostUserId, 42);
  assert.equal(room.state, 'lobby');
  assert.equal(room.quiz, null);
  assert.equal(room.questionIndex, -1);
  assert.equal(room.currentRound, 0);
  assert.equal(room.currentChallenge, null);
  assert.equal(room.players.size, 0);
  assert.equal(room.roundAnswers.size, 0);
  assert.deepEqual(room.roundResults, []);
  assert.ok(room.createdAt > 0);
  // Cleanup
  deleteRoom(room.code);
});

test('createRoom: subsequent rooms get unique codes', () => {
  const a = createRoom(1, 'A');
  const b = createRoom(2, 'B');
  assert.notEqual(a.code, b.code);
  deleteRoom(a.code);
  deleteRoom(b.code);
});

test('addPlayer: registers player and zeroes score/streak entries', () => {
  const room = createRoom(1, 'Host');
  const ws = fakeWs();
  addPlayer(room, 7, 'Seven', ws);
  assert.equal(room.players.size, 1);
  assert.deepEqual(room.players.get(7), { userId: 7, displayName: 'Seven', ws });
  assert.equal(room.scores.get(7), 0);
  assert.equal(room.streaks.get(7), 0);
  assert.equal(room.maxStreaks.get(7), 0);
  deleteRoom(room.code);
});

test('removePlayer: in lobby, host migrates to next player when host leaves', () => {
  const { room } = seededRoom(2, 1); // host=1, also player 101
  const result = removePlayer(room, 1);
  assert.equal(result, room);
  assert.equal(room.hostUserId, 101);
  assert.equal(room.players.size, 1);
  deleteRoom(room.code);
});

test('removePlayer: deletes room when last player leaves', () => {
  const { room } = seededRoom(1, 1);
  const code = room.code;
  const result = removePlayer(room, 1);
  assert.equal(result, null);
  assert.equal(getRoom(code), null);
});

test('removePlayer: deletes room when host leaves and no one else is present', () => {
  const room = createRoom(1, 'Host');
  addPlayer(room, 1, 'Host', fakeWs());
  const code = room.code;
  const result = removePlayer(room, 1);
  assert.equal(result, null);
  assert.equal(getRoom(code), null);
});

test('removePlayer: non-host leaving keeps host unchanged', () => {
  const { room } = seededRoom(2, 1);
  const result = removePlayer(room, 101);
  assert.equal(result, room);
  assert.equal(room.hostUserId, 1);
  assert.equal(room.players.size, 1);
  deleteRoom(room.code);
});

test('removePlayer: host leaving while playing as the last player deletes the room', () => {
  const room = createRoom(1, 'Host');
  addPlayer(room, 1, 'Host', fakeWs());
  setQuiz(room, makeQuiz());
  startGame(room);
  const code = room.code;
  // Host migration is skipped (state==='playing'), then size==0 cleanup hits.
  const result = removePlayer(room, 1);
  assert.equal(result, null);
  assert.equal(getRoom(code), null);
});

test('removePlayer: host leaving while playing does NOT migrate host', () => {
  const { room } = seededRoom(2, 1);
  setQuiz(room, makeQuiz());
  startGame(room);
  // Host leaves mid-game. The branch only migrates host when state==='lobby'.
  const result = removePlayer(room, 1);
  assert.equal(result, room);
  assert.equal(room.hostUserId, 1); // unchanged
  assert.equal(room.players.size, 1);
  deleteRoom(room.code);
});

test('getRoom: case-insensitive lookup, null for missing or nullish input', () => {
  const room = createRoom(1, 'Host');
  assert.equal(getRoom(room.code), room);
  assert.equal(getRoom(room.code.toLowerCase()), room);
  assert.equal(getRoom('ZZZZ'), null);
  assert.equal(getRoom(null), null);
  assert.equal(getRoom(undefined), null);
  deleteRoom(room.code);
});

test('deleteRoom: returns true on hit, false on miss, false on empty input', () => {
  const room = createRoom(1, 'Host');
  assert.equal(deleteRoom(room.code.toLowerCase()), true);
  assert.equal(deleteRoom(room.code), false);
  assert.equal(deleteRoom(''), false);
  assert.equal(deleteRoom(null), false);
});

test('setQuiz: assigns quiz to room', () => {
  const room = createRoom(1, 'Host');
  const quiz = makeQuiz();
  setQuiz(room, quiz);
  assert.equal(room.quiz, quiz);
  deleteRoom(room.code);
});

test('startGame: rejects when quiz is missing', () => {
  const { room } = seededRoom(1, 1);
  assert.equal(startGame(room), false);
  assert.equal(room.state, 'lobby');
  deleteRoom(room.code);
});

test('startGame: rejects when quiz has no questions', () => {
  const { room } = seededRoom(1, 1);
  setQuiz(room, makeQuiz({ questions: [] }));
  assert.equal(startGame(room), false);
  assert.equal(room.state, 'lobby');
  deleteRoom(room.code);
});

test('startGame: rejects when quiz.questions is not an array', () => {
  const { room } = seededRoom(1, 1);
  setQuiz(room, { id: 1, name: 'bad', questions: null });
  assert.equal(startGame(room), false);
  deleteRoom(room.code);
});

test('startGame: starts game, resets scores/streaks, kicks off first round', () => {
  const { room } = seededRoom(2, 1);
  // Seed dirty state to make sure it's reset.
  room.scores.set(1, 99);
  room.streaks.set(1, 4);
  room.maxStreaks.set(1, 7);
  setQuiz(room, makeQuiz());
  assert.equal(startGame(room), true);
  assert.equal(room.state, 'playing');
  assert.equal(room.questionIndex, 0);
  assert.equal(room.currentRound, 1);
  assert.deepEqual(room.roundResults, []);
  assert.equal(room.scores.get(1), 0);
  assert.equal(room.streaks.get(1), 0);
  assert.equal(room.maxStreaks.get(1), 0);
  assert.ok(room.currentChallenge);
  assert.equal(room.currentChallenge.questionId, 10);
  assert.equal(room.roundResolved, false);
  deleteRoom(room.code);
});

test('startRound: with no question at questionIndex sets currentChallenge to null', () => {
  const { room } = seededRoom(1, 1);
  setQuiz(room, makeQuiz());
  // Force questionIndex past the end before calling startRound directly.
  room.questionIndex = 99;
  startRound(room);
  assert.equal(room.currentChallenge, null);
  deleteRoom(room.code);
});

test('hasMoreQuestions: tracks whether further questions exist', () => {
  const { room } = seededRoom(1, 1);
  // No quiz yet → falsy.
  assert.ok(!hasMoreQuestions(room));
  setQuiz(room, makeQuiz()); // 3 questions
  startGame(room);
  // questionIndex=0, two more remaining.
  assert.equal(hasMoreQuestions(room), true);
  room.questionIndex = 2;
  assert.equal(hasMoreQuestions(room), false);
  deleteRoom(room.code);
});

test('submitAnswer: returns null when not playing or no challenge', () => {
  const { room } = seededRoom(1, 1);
  assert.equal(submitAnswer(room, 1, 'Paris'), null);
  setQuiz(room, makeQuiz());
  startGame(room);
  // Wipe challenge to cover the !room.currentChallenge branch.
  room.currentChallenge = null;
  assert.equal(submitAnswer(room, 1, 'Paris'), null);
  deleteRoom(room.code);
});

test('submitAnswer: rejects with round_already_resolved but reports correctness', () => {
  const { room } = seededRoom(1, 1);
  setQuiz(room, makeQuiz());
  startGame(room);
  room.roundResolved = true;
  const wrong = submitAnswer(room, 1, 'London');
  assert.deepEqual(wrong, { accepted: false, reason: 'round_already_resolved', correct: false });
  const right = submitAnswer(room, 1, 'Paris');
  assert.deepEqual(right, { accepted: false, reason: 'round_already_resolved', correct: true });
  deleteRoom(room.code);
});

test('submitAnswer: rejects already_answered and reports prior correctness', () => {
  const { room } = seededRoom(1, 1);
  setQuiz(room, makeQuiz());
  startGame(room);
  const first = submitAnswer(room, 1, 'Paris');
  assert.equal(first.accepted, true);
  assert.equal(first.correct, true);
  const second = submitAnswer(room, 1, 'Paris');
  assert.deepEqual(second, { accepted: false, reason: 'already_answered', correct: true });
  deleteRoom(room.code);
});

test('submitAnswer: flags firstCorrect for the first correct answer only', () => {
  const { room, players } = seededRoom(3, 1);
  setQuiz(room, makeQuiz());
  startGame(room);
  const a = submitAnswer(room, players[0].userId, 'wrong'); // wrong, not firstCorrect
  assert.equal(a.accepted, true);
  assert.equal(a.correct, false);
  assert.equal(a.firstCorrect, false);

  const b = submitAnswer(room, players[1].userId, 'Paris'); // first correct
  assert.equal(b.correct, true);
  assert.equal(b.firstCorrect, true);

  const c = submitAnswer(room, players[2].userId, 'Paris'); // also correct, not first
  assert.equal(c.correct, true);
  assert.equal(c.firstCorrect, false);
  assert.equal(c.allAnswered, true);
  deleteRoom(room.code);
});

test('submitAnswer: allAnswered flips true once last player answers', () => {
  const { room, players } = seededRoom(2, 1);
  setQuiz(room, makeQuiz());
  startGame(room);
  const first = submitAnswer(room, players[0].userId, 'Paris');
  assert.equal(first.allAnswered, false);
  const second = submitAnswer(room, players[1].userId, 'Paris');
  assert.equal(second.allAnswered, true);
  deleteRoom(room.code);
});

test('resolveRound: picks winner with earliest correct timestamp and awards 3 chesnuts', () => {
  const { room, players } = seededRoom(3, 1);
  setQuiz(room, makeQuiz());
  startGame(room);

  // Hand-craft answers to control timing deterministically.
  room.currentChallenge.startedAt = 1000;
  room.roundAnswers.set(players[0].userId, { answer: 'Paris', correct: true, timestamp: 1500 });
  room.roundAnswers.set(players[1].userId, { answer: 'Paris', correct: true, timestamp: 1200 });
  room.roundAnswers.set(players[2].userId, { answer: 'wrong', correct: false, timestamp: 1100 });

  const result = resolveRound(room);
  assert.equal(result.winnerId, players[1].userId);
  assert.equal(result.winnerName, players[1].displayName);
  assert.equal(result.timeTaken, 200);
  assert.deepEqual(result.chesnutAwards, { [players[1].userId]: 3 });
  assert.equal(result.scores[players[1].userId], 1);
  assert.equal(result.streaks[players[1].userId], 1);
  // Non-correct players keep streak=0.
  assert.equal(result.streaks[players[0].userId], 0);
  assert.equal(result.streaks[players[2].userId], 0);
  // Round is recorded.
  assert.equal(room.roundResults.length, 1);
  assert.equal(room.roundResolved, true);
  deleteRoom(room.code);
});

test('resolveRound: streak reaching 3 awards bonus 5 chesnuts (8 total)', () => {
  const { room, players } = seededRoom(2, 1);
  setQuiz(room, makeQuiz());
  startGame(room);
  // Pre-seed two prior wins for player 0 so this resolution makes streak=3.
  room.streaks.set(players[0].userId, 2);

  room.currentChallenge.startedAt = 0;
  room.roundAnswers.set(players[0].userId, { answer: 'Paris', correct: true, timestamp: 100 });

  const result = resolveRound(room);
  assert.equal(result.winnerId, players[0].userId);
  assert.equal(result.chesnutAwards[players[0].userId], 8);
  assert.equal(result.streaks[players[0].userId], 3);
  // maxStreaks should also bump.
  assert.equal(room.maxStreaks.get(players[0].userId), 3);
  deleteRoom(room.code);
});

test('resolveRound: null winner case (no correct answers)', () => {
  const { room, players } = seededRoom(2, 1);
  setQuiz(room, makeQuiz());
  startGame(room);
  // Pre-seed a streak so we can confirm it gets reset.
  room.streaks.set(players[0].userId, 4);

  room.currentChallenge.startedAt = 0;
  room.roundAnswers.set(players[0].userId, { answer: 'wrong', correct: false, timestamp: 50 });

  const result = resolveRound(room);
  assert.equal(result.winnerId, null);
  assert.equal(result.winnerName, null);
  assert.equal(result.timeTaken, null);
  assert.deepEqual(result.chesnutAwards, {});
  // Streaks reset for all who didn't answer correctly.
  assert.equal(result.streaks[players[0].userId], 0);
  assert.equal(result.streaks[players[1].userId], 0);
  deleteRoom(room.code);
});

test('resolveRound: maxStreak does NOT decrease when current streak resets', () => {
  const { room, players } = seededRoom(1, 1);
  setQuiz(room, makeQuiz());
  startGame(room);
  // Win round 1.
  room.currentChallenge.startedAt = 0;
  room.roundAnswers.set(players[0].userId, { answer: 'Paris', correct: true, timestamp: 10 });
  resolveRound(room);
  assert.equal(room.maxStreaks.get(players[0].userId), 1);

  // Advance to next round and lose it.
  nextRound(room);
  room.currentChallenge.startedAt = 0;
  room.roundAnswers.set(players[0].userId, { answer: 0, correct: false, timestamp: 10 });
  resolveRound(room);
  assert.equal(room.streaks.get(players[0].userId), 0);
  assert.equal(room.maxStreaks.get(players[0].userId), 1); // unchanged
  deleteRoom(room.code);
});

test('nextRound: advances to next question and starts it; returns false at the end', () => {
  const { room } = seededRoom(1, 1);
  setQuiz(room, makeQuiz()); // 3 questions
  startGame(room);
  assert.equal(room.questionIndex, 0);
  assert.equal(room.currentRound, 1);

  assert.equal(nextRound(room), true);
  assert.equal(room.questionIndex, 1);
  assert.equal(room.currentRound, 2);
  assert.equal(room.currentChallenge.questionId, 11);

  assert.equal(nextRound(room), true);
  assert.equal(room.questionIndex, 2);
  assert.equal(room.currentChallenge.questionId, 12);

  assert.equal(nextRound(room), false);
  assert.equal(room.questionIndex, 2); // unchanged
  deleteRoom(room.code);
});

test('voteFinish: requires ceil(players/2) votes', () => {
  // 3 players → ceil(3/2)=2.
  const { room, players } = seededRoom(3, 1);
  assert.equal(voteFinish(room, players[0].userId), false);
  // Same vote twice: still 1 unique voter.
  assert.equal(voteFinish(room, players[0].userId), false);
  assert.equal(voteFinish(room, players[1].userId), true);
  deleteRoom(room.code);
});

test('voteFinish: 1 player meets threshold immediately', () => {
  const { room, players } = seededRoom(1, 1);
  assert.equal(voteFinish(room, players[0].userId), true);
  deleteRoom(room.code);
});

test('finishGame: sums per-round chesnutAwards, filters guests (userId<=0)', () => {
  const { room, players } = seededRoom(2, 1);
  // Add a guest player with negative userId.
  const guestId = -5;
  addPlayer(room, guestId, 'Guest', fakeWs());
  setQuiz(room, makeQuiz());
  startGame(room);

  // Round 1: registered player 1 wins.
  room.currentChallenge.startedAt = 0;
  room.roundAnswers.set(players[0].userId, { answer: 'Paris', correct: true, timestamp: 10 });
  resolveRound(room);

  // Round 2: guest wins (would award chesnuts but filtered).
  nextRound(room);
  room.currentChallenge.startedAt = 0;
  room.roundAnswers.set(guestId, { answer: 1, correct: true, timestamp: 10 });
  resolveRound(room);

  // Round 3: registered player 1 wins again.
  nextRound(room);
  room.currentChallenge.startedAt = 0;
  room.roundAnswers.set(players[0].userId, { answer: [1, 2], correct: true, timestamp: 10 });
  resolveRound(room);

  const summary = finishGame(room);
  assert.equal(room.state, 'finished');
  assert.equal(room.currentChallenge, null);
  // Player 1 won rounds 1 and 3 → 3 + 3 = 6 chesnuts (no streak bonus, only 2 wins so far in row but interrupted).
  assert.equal(summary.totalChesnuts[players[0].userId], 6);
  // Guest is excluded entirely from totalChesnuts.
  assert.equal(guestId in summary.totalChesnuts, false);
  // Per-round chesnutAwards remain in roundResults so the client can show "register to keep" CTA.
  assert.equal(summary.roundResults[1].chesnutAwards[guestId], 3);
  assert.equal(summary.totalRounds, 3);
  deleteRoom(room.code);
});

test('finishGame: includes streak bonus in totalChesnuts when winner reaches streak >=3', () => {
  const { room, players } = seededRoom(1, 1);
  setQuiz(room, makeQuiz());
  startGame(room);

  // Win 3 rounds in a row → 3 + 3 + (3+5) = 14.
  for (let i = 0; i < 3; i++) {
    if (i > 0) nextRound(room);
    room.currentChallenge.startedAt = 0;
    const ans = i === 0 ? 'Paris' : i === 1 ? 1 : [1, 2];
    room.roundAnswers.set(players[0].userId, { answer: ans, correct: true, timestamp: 10 });
    resolveRound(room);
  }
  const summary = finishGame(room);
  assert.equal(summary.totalChesnuts[players[0].userId], 14);
  assert.equal(summary.bestStreaksInGame[players[0].userId], 3);
  assert.equal(summary.finalStreaks[players[0].userId], 3);
  deleteRoom(room.code);
});

test('getRoomState: returns redacted state in lobby (no challenge), with player list', () => {
  const { room } = seededRoom(2, 1);
  setQuiz(room, makeQuiz());
  const state = getRoomState(room);
  assert.equal(state.code, room.code);
  assert.equal(state.state, 'lobby');
  assert.equal(state.hostUserId, 1);
  assert.equal(state.players.length, 2);
  // Host marked correctly.
  const host = state.players.find(p => p.userId === 1);
  assert.equal(host.isHost, true);
  const other = state.players.find(p => p.userId !== 1);
  assert.equal(other.isHost, false);
  // Quiz summary present without questions array.
  assert.deepEqual(state.quiz, { id: 1, name: 'Test Quiz', questionCount: 3 });
  assert.equal(state.totalRounds, 3);
  // No currentChallenge in lobby state.
  assert.equal(state.currentChallenge, null);
  deleteRoom(room.code);
});

test('getRoomState: in playing state exposes redacted publicChallenge (no correctAnswers)', () => {
  const { room } = seededRoom(1, 1);
  setQuiz(room, makeQuiz());
  startGame(room);
  const state = getRoomState(room);
  assert.equal(state.state, 'playing');
  assert.ok(state.currentChallenge);
  assert.equal(state.currentChallenge.questionId, 10);
  assert.equal('correctAnswers' in state.currentChallenge, false);
  deleteRoom(room.code);
});

test('getRoomState: with no quiz, quiz field is null and totalRounds is 0', () => {
  const { room } = seededRoom(1, 1);
  const state = getRoomState(room);
  assert.equal(state.quiz, null);
  assert.equal(state.totalRounds, 0);
  deleteRoom(room.code);
});
