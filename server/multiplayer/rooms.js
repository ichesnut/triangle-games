// In-memory room management for Math Battle

import { generateChallenge, difficultyForRound } from './challenges.js';

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
    currentRound: 0,
    currentChallenge: null,
    roundAnswers: new Map(), // Map<userId, { answer, timestamp }>
    scores: new Map(),
    streaks: new Map(), // consecutive round wins per player
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
  room.lastActivity = Date.now();
}

function removePlayer(room, userId) {
  room.players.delete(userId);
  room.lastActivity = Date.now();

  // If host leaves lobby, promote next player or destroy room
  if (userId === room.hostUserId && room.state === 'lobby') {
    const next = room.players.keys().next();
    if (!next.done) {
      room.hostUserId = next.value;
    } else {
      rooms.delete(room.code);
      return null;
    }
  }

  // Destroy empty rooms
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return null;
  }

  return room;
}

function getRoom(code) {
  return rooms.get(code?.toUpperCase()) || null;
}

function startGame(room) {
  room.state = 'playing';
  room.currentRound = 1;
  room.roundResults = [];
  room.votesToFinish.clear();
  // Reset scores and streaks
  for (const userId of room.players.keys()) {
    room.scores.set(userId, 0);
    room.streaks.set(userId, 0);
  }
  startRound(room);
}

function startRound(room) {
  const difficulty = difficultyForRound(room.currentRound);
  room.currentChallenge = {
    ...generateChallenge(difficulty),
    difficulty,
    startedAt: Date.now(),
  };
  room.roundAnswers.clear();
  room.roundResolved = false;
  room.votesToFinish.clear();
  room.lastActivity = Date.now();
}

function submitAnswer(room, userId, answer) {
  if (room.state !== 'playing' || !room.currentChallenge) return null;
  if (room.roundResolved) return null; // round already resolved
  if (room.roundAnswers.has(userId)) return null; // already answered

  const numAnswer = Number(answer);
  if (isNaN(numAnswer)) return null;

  const correct = numAnswer === room.currentChallenge.answer;
  // Check if this is the first correct answer in the round
  let firstCorrect = false;
  if (correct) {
    firstCorrect = ![...room.roundAnswers.values()].some(a => a.correct);
  }

  room.roundAnswers.set(userId, {
    answer: numAnswer,
    correct,
    timestamp: Date.now(),
  });

  return { correct, firstCorrect, allAnswered: room.roundAnswers.size === room.players.size };
}

function resolveRound(room) {
  room.roundResolved = true;
  const correctAnswers = [];
  for (const [userId, ans] of room.roundAnswers) {
    if (ans.correct) {
      correctAnswers.push({ userId, timestamp: ans.timestamp });
    }
  }

  // Sort by timestamp — first correct answer wins
  correctAnswers.sort((a, b) => a.timestamp - b.timestamp);

  const winner = correctAnswers.length > 0 ? correctAnswers[0] : null;
  const chesnutAwards = new Map();

  // Award chesnuts
  for (const { userId } of correctAnswers) {
    if (winner && userId === winner.userId) {
      // Winner: 3 chesnuts
      chesnutAwards.set(userId, 3);
      room.scores.set(userId, (room.scores.get(userId) || 0) + 1);
      // Update streak
      const streak = (room.streaks.get(userId) || 0) + 1;
      room.streaks.set(userId, streak);
      // Streak bonus: +5 for 3+ consecutive wins
      if (streak >= 3) {
        chesnutAwards.set(userId, chesnutAwards.get(userId) + 5);
      }
    } else {
      // Correct but not winner: 1 chesnut
      chesnutAwards.set(userId, 1);
      room.streaks.set(userId, 0);
    }
  }

  // Reset streak for incorrect/no-answer players
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
    correctAnswer: room.currentChallenge.answer,
    winnerId: winner?.userId || null,
    winnerName: winnerPlayer?.displayName || null,
    timeTaken,
    chesnutAwards: Object.fromEntries(chesnutAwards),
    scores: Object.fromEntries(room.scores),
    streaks: Object.fromEntries(room.streaks),
  };

  room.roundResults.push(result);
  return result;
}

function nextRound(room) {
  room.currentRound++;
  startRound(room);
}

function voteFinish(room, userId) {
  room.votesToFinish.add(userId);
  // Majority vote to finish
  return room.votesToFinish.size >= Math.ceil(room.players.size / 2);
}

function finishGame(room) {
  room.state = 'finished';
  room.currentChallenge = null;

  // Calculate total chesnuts earned per player across all rounds
  const totalChesnuts = new Map();
  for (const result of room.roundResults) {
    for (const [userId, amount] of Object.entries(result.chesnutAwards)) {
      const key = Number(userId);
      totalChesnuts.set(key, (totalChesnuts.get(key) || 0) + amount);
    }
  }

  return {
    scores: Object.fromEntries(room.scores),
    totalChesnuts: Object.fromEntries(totalChesnuts),
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
    currentRound: room.currentRound,
    currentChallenge: room.state === 'playing' && room.currentChallenge
      ? { prompt: room.currentChallenge.prompt, difficulty: room.currentChallenge.difficulty }
      : null,
  };
}

// Clean up stale rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      // Notify remaining players
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
  startGame,
  startRound,
  submitAnswer,
  resolveRound,
  nextRound,
  voteFinish,
  finishGame,
  getRoomState,
};
