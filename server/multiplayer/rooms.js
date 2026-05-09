// In-memory room management for Quiz Battle.

import {
  challengeFromQuestion,
  isAnswerCorrect,
  publicChallenge,
  correctAnswerDisplay,
} from './challenges.js';

const rooms = new Map();
const ROOM_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function createRoom(hostUserId, hostDisplayName) {
  const code = generateCode();
  const room = {
    code,
    hostUserId,
    players: new Map(),
    state: 'lobby', // lobby | playing | finished
    quiz: null,
    questionIndex: -1,
    currentRound: 0,
    currentChallenge: null,
    roundAnswers: new Map(),
    scores: new Map(),
    streaks: new Map(),
    maxStreaks: new Map(),
    roundResults: [],
    votesToFinish: new Set(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, userId, displayName, ws) {
  room.players.set(userId, { userId, displayName, ws });
  room.scores.set(userId, 0);
  room.streaks.set(userId, 0);
  room.maxStreaks.set(userId, 0);
  room.lastActivity = Date.now();
}

function removePlayer(room, userId) {
  room.players.delete(userId);
  room.lastActivity = Date.now();

  if (userId === room.hostUserId && room.state === 'lobby') {
    const next = room.players.keys().next();
    if (!next.done) {
      room.hostUserId = next.value;
    } else {
      rooms.delete(room.code);
      return null;
    }
  }

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return null;
  }

  return room;
}

function getRoom(code) {
  return rooms.get(code?.toUpperCase()) || null;
}

function deleteRoom(code) {
  if (!code) return false;
  return rooms.delete(code.toUpperCase());
}

function setQuiz(room, quiz) {
  room.quiz = quiz; // { id, name, questions: [...] }
}

function startGame(room) {
  if (!room.quiz || !Array.isArray(room.quiz.questions) || room.quiz.questions.length === 0) {
    return false;
  }
  room.state = 'playing';
  room.questionIndex = 0;
  room.currentRound = 1;
  room.roundResults = [];
  room.votesToFinish.clear();
  for (const userId of room.players.keys()) {
    room.scores.set(userId, 0);
    room.streaks.set(userId, 0);
    room.maxStreaks.set(userId, 0);
  }
  startRound(room);
  return true;
}

function startRound(room) {
  const question = room.quiz.questions[room.questionIndex];
  if (!question) {
    room.currentChallenge = null;
    return;
  }
  room.currentChallenge = challengeFromQuestion(question);
  room.roundAnswers.clear();
  room.roundResolved = false;
  room.votesToFinish.clear();
  room.lastActivity = Date.now();
}

function hasMoreQuestions(room) {
  return room.quiz && room.questionIndex + 1 < room.quiz.questions.length;
}

function submitAnswer(room, userId, answer) {
  if (room.state !== 'playing' || !room.currentChallenge) return null;

  if (room.roundResolved) {
    return {
      accepted: false,
      reason: 'round_already_resolved',
      correct: isAnswerCorrect(room.currentChallenge, answer),
    };
  }
  if (room.roundAnswers.has(userId)) {
    return {
      accepted: false,
      reason: 'already_answered',
      correct: room.roundAnswers.get(userId).correct,
    };
  }

  const correct = isAnswerCorrect(room.currentChallenge, answer);

  let firstCorrect = false;
  if (correct) {
    firstCorrect = ![...room.roundAnswers.values()].some(a => a.correct);
  }

  room.roundAnswers.set(userId, {
    answer,
    correct,
    timestamp: Date.now(),
  });

  return {
    accepted: true,
    correct,
    firstCorrect,
    allAnswered: room.roundAnswers.size === room.players.size,
  };
}

function resolveRound(room) {
  room.roundResolved = true;
  const correctAnswers = [];
  for (const [userId, ans] of room.roundAnswers) {
    if (ans.correct) {
      correctAnswers.push({ userId, timestamp: ans.timestamp });
    }
  }

  correctAnswers.sort((a, b) => a.timestamp - b.timestamp);

  const winner = correctAnswers.length > 0 ? correctAnswers[0] : null;
  const chesnutAwards = new Map();

  for (const { userId } of correctAnswers) {
    if (winner && userId === winner.userId) {
      chesnutAwards.set(userId, 3);
      room.scores.set(userId, (room.scores.get(userId) || 0) + 1);
      const streak = (room.streaks.get(userId) || 0) + 1;
      room.streaks.set(userId, streak);
      const max = room.maxStreaks.get(userId) || 0;
      if (streak > max) room.maxStreaks.set(userId, streak);
      if (streak >= 3) {
        chesnutAwards.set(userId, chesnutAwards.get(userId) + 5);
      }
    } else {
      chesnutAwards.set(userId, 1);
      room.streaks.set(userId, 0);
    }
  }

  for (const userId of room.players.keys()) {
    if (!room.roundAnswers.has(userId) || !room.roundAnswers.get(userId).correct) {
      room.streaks.set(userId, 0);
    }
  }

  const winnerPlayer = winner ? room.players.get(winner.userId) : null;
  const timeTaken = winner ? winner.timestamp - room.currentChallenge.startedAt : null;

  const result = {
    round: room.currentRound,
    challenge: room.currentChallenge.prompt,
    correctAnswer: correctAnswerDisplay(room.currentChallenge),
    winnerId: winner?.userId || null,
    winnerName: winnerPlayer?.displayName || null,
    timeTaken,
    chesnutAwards: Object.fromEntries(chesnutAwards),
    scores: Object.fromEntries(room.scores),
    streaks: Object.fromEntries(room.streaks),
    hasMoreQuestions: hasMoreQuestions(room),
  };

  room.roundResults.push(result);
  return result;
}

function nextRound(room) {
  if (!hasMoreQuestions(room)) return false;
  room.questionIndex++;
  room.currentRound++;
  startRound(room);
  return true;
}

function voteFinish(room, userId) {
  room.votesToFinish.add(userId);
  return room.votesToFinish.size >= Math.ceil(room.players.size / 2);
}

function finishGame(room) {
  room.state = 'finished';
  room.currentChallenge = null;

  // Aggregate chesnuts only for registered users. Guest IDs are negative
  // (see isUserId in ws.js) and have no balance column to write to —
  // including them would put a "+N chesnuts" line on the scoreboard that
  // doesn't match GET /api/chesnuts/me (TRI-55). Per-round chesnutAwards
  // in roundResults stay unchanged so the client can still surface a
  // "register to keep your chesnuts" CTA for guests who would have earned.
  const totalChesnuts = new Map();
  for (const result of room.roundResults) {
    for (const [userId, amount] of Object.entries(result.chesnutAwards)) {
      const key = Number(userId);
      if (key <= 0) continue;
      totalChesnuts.set(key, (totalChesnuts.get(key) || 0) + amount);
    }
  }

  return {
    scores: Object.fromEntries(room.scores),
    totalChesnuts: Object.fromEntries(totalChesnuts),
    finalStreaks: Object.fromEntries(room.streaks),
    bestStreaksInGame: Object.fromEntries(room.maxStreaks),
    roundResults: room.roundResults,
    totalRounds: room.roundResults.length,
  };
}

function getRoomState(room) {
  const players = [];
  for (const [userId, p] of room.players) {
    players.push({
      userId,
      displayName: p.displayName,
      score: room.scores.get(userId) || 0,
      isHost: userId === room.hostUserId,
    });
  }

  return {
    code: room.code,
    state: room.state,
    hostUserId: room.hostUserId,
    players,
    quiz: room.quiz
      ? {
          id: room.quiz.id,
          name: room.quiz.name,
          questionCount: room.quiz.questions.length,
        }
      : null,
    currentRound: room.currentRound,
    totalRounds: room.quiz ? room.quiz.questions.length : 0,
    currentChallenge: room.state === 'playing'
      ? publicChallenge(room.currentChallenge)
      : null,
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      for (const p of room.players.values()) {
        try {
          p.ws.send(JSON.stringify({ type: 'error', message: 'Room expired due to inactivity' }));
        } catch (_) { /* ignore */ }
      }
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

export {
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
};
