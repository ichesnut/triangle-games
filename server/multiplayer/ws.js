// WebSocket server for Quiz Battle multiplayer

import { WebSocketServer } from 'ws';
import db from '../db.js';
import {
  createRoom,
  addPlayer,
  removePlayer,
  getRoom,
  deleteRoom,
  setQuiz,
  startGame,
  submitAnswer,
  resolveRound,
  nextRound,
  hasMoreQuestions,
  voteFinish,
  finishGame,
  getRoomState,
} from './rooms.js';
import { loadQuizWithQuestions } from '../routes/quizzes.js';

// Participant IDs are integers: positive = registered users (users.id),
// negative = guests (-guests.id). This lets the in-memory room treat both
// kinds the same while we still know which DB table to write to.
const isUserId = (id) => Number(id) > 0;

const awardChesnuts = db.transaction((totalChesnuts) => {
  const stmt = db.prepare('UPDATE users SET chesnutBalance = chesnutBalance + ? WHERE id = ?');
  for (const [participantId, amount] of Object.entries(totalChesnuts)) {
    if (!isUserId(participantId) || !amount) continue;
    stmt.run(amount, Number(participantId));
  }
});

const persistStreaks = db.transaction((gameResult, players) => {
  const updateUser = db.prepare(
    'UPDATE users SET currentStreak = ?, bestStreak = MAX(bestStreak, ?) WHERE id = ?'
  );
  const updateGuest = db.prepare(`
    UPDATE guests
    SET currentStreak = ?,
        bestStreak = MAX(bestStreak, ?),
        gamesPlayed = gamesPlayed + 1,
        roundsWon = roundsWon + ?,
        lastSeenAt = datetime('now')
    WHERE id = ?
  `);

  for (const p of players) {
    const final = gameResult.finalStreaks[p.userId] || 0;
    const best = gameResult.bestStreaksInGame[p.userId] || 0;
    if (isUserId(p.userId)) {
      updateUser.run(final, best, p.userId);
    } else {
      const guestPk = -p.userId;
      const won = gameResult.scores[p.userId] || 0;
      updateGuest.run(final, best, won, guestPk);
    }
  }
});

// Convert epoch-ms (e.g. room.startedAt) to the SQLite TEXT format used by
// datetime('now') so admin queries can compare/display them uniformly.
function toSqliteTimestamp(epochMs) {
  if (!epochMs) return null;
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

const recordGame = db.transaction((roomCode, gameResult, players, gameMeta = {}) => {
  const registeredPlayers = players.filter(p => isUserId(p.userId));
  if (!registeredPlayers.length) {
    // No registered players → nothing to persist in math_battle_* (those
    // tables FK on users.id). Streaks are still recorded via persistStreaks.
    return null;
  }

  const insertGame = db.prepare(
    "INSERT INTO math_battle_games (roomCode, quizId, totalRounds, startedAt, finishedAt) VALUES (?, ?, ?, ?, datetime('now'))"
  );
  const { lastInsertRowid: gameId } = insertGame.run(
    roomCode,
    gameMeta.quizId ?? null,
    gameResult.totalRounds,
    toSqliteTimestamp(gameMeta.startedAt),
  );

  const insertPlayer = db.prepare(
    'INSERT INTO math_battle_players (gameId, userId, roundsWon, chesnutsEarned) VALUES (?, ?, ?, ?)'
  );
  for (const p of registeredPlayers) {
    insertPlayer.run(
      gameId,
      p.userId,
      gameResult.scores[p.userId] || 0,
      gameResult.totalChesnuts[p.userId] || 0
    );
  }

  const insertRound = db.prepare(
    'INSERT INTO math_battle_rounds (gameId, roundNumber, challenge, correctAnswer, winnerId, timeTakenMs) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of gameResult.roundResults) {
    // Guests can win a round, but math_battle_rounds.winnerId FKs to users(id).
    // Store NULL for guest winners — the round record still captures the round.
    const winnerId = isUserId(r.winnerId) ? r.winnerId : null;
    insertRound.run(gameId, r.round, r.challenge, String(r.correctAnswer), winnerId, r.timeTaken);
  }

  return gameId;
});

function broadcast(room, message, excludeUserId) {
  const data = JSON.stringify(message);
  for (const [userId, p] of room.players) {
    if (userId !== excludeUserId && p.ws.readyState === 1) {
      p.ws.send(data);
    }
  }
}

function sendTo(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws, message) {
  sendTo(ws, { type: 'error', message });
}

function endGameAndRecord(room, players = Array.from(room.players.values())) {
  const gameResult = finishGame(room);

  if (Object.keys(gameResult.totalChesnuts).length > 0) {
    awardChesnuts(gameResult.totalChesnuts);
  }

  try {
    persistStreaks(gameResult, players);
  } catch (err) {
    console.error('Failed to persist streaks:', err);
  }
  try {
    recordGame(room.code, gameResult, players, {
      startedAt: room.startedAt,
      quizId: room.quiz?.id ?? null,
    });
  } catch (err) {
    console.error('Failed to record game:', err);
  }

  return gameResult;
}

export function attachWebSocketServer(httpServer, sessionParser) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws/quiz-battle') {
      socket.destroy();
      return;
    }

    sessionParser(req, {}, () => {
      if (!req.session?.userId && !req.session?.guestId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  });

  wss.on('connection', (ws, req) => {
    let participantId, displayName, isGuest;
    if (req.session.userId) {
      const user = db.prepare(
        'SELECT id, displayName FROM users WHERE id = ?'
      ).get(req.session.userId);
      if (!user) {
        sendError(ws, 'User not found');
        ws.close();
        return;
      }
      participantId = user.id;
      displayName = user.displayName;
      isGuest = false;
    } else {
      const guest = db.prepare(
        'SELECT id, displayName FROM guests WHERE id = ?'
      ).get(req.session.guestId);
      if (!guest) {
        sendError(ws, 'Guest not found');
        ws.close();
        return;
      }
      participantId = -guest.id;
      displayName = guest.displayName;
      isGuest = true;
    }

    let currentRoom = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        sendError(ws, 'Invalid JSON');
        return;
      }

      switch (msg.type) {
        case 'create_room': {
          if (currentRoom) {
            sendError(ws, 'Already in a room');
            return;
          }
          if (isGuest) {
            sendError(ws, 'Guests cannot host games — register an account to host');
            return;
          }
          const room = createRoom(participantId, displayName);
          addPlayer(room, participantId, displayName, ws);
          currentRoom = room.code;
          sendTo(ws, { type: 'room_state', ...getRoomState(room) });
          break;
        }

        case 'join_room': {
          if (currentRoom) {
            sendError(ws, 'Already in a room');
            return;
          }
          const code = msg.code?.toUpperCase();
          const room = getRoom(code);
          if (!room) {
            sendError(ws, 'Room not found');
            return;
          }
          if (room.state !== 'lobby') {
            sendError(ws, 'Game already in progress');
            return;
          }
          if (room.players.has(participantId)) {
            sendError(ws, 'Already in this room');
            return;
          }
          addPlayer(room, participantId, displayName, ws);
          currentRoom = room.code;

          broadcast(room, {
            type: 'player_joined',
            userId: participantId,
            displayName,
          }, participantId);

          sendTo(ws, { type: 'room_state', ...getRoomState(room) });
          break;
        }

        case 'select_quiz': {
          const room = getRoom(currentRoom);
          if (!room) { sendError(ws, 'Not in a room'); return; }
          if (room.hostUserId !== participantId) { sendError(ws, 'Only host can pick a quiz'); return; }
          if (room.state !== 'lobby') { sendError(ws, 'Quiz can only be set in the lobby'); return; }

          const quizId = Number(msg.quizId);
          if (!Number.isInteger(quizId)) {
            sendError(ws, 'Invalid quizId'); return;
          }
          const quiz = loadQuizWithQuestions(quizId);
          if (!quiz) { sendError(ws, 'Quiz not found'); return; }
          if (quiz.ownerUserId !== participantId) {
            sendError(ws, 'Only the quiz owner can host it');
            return;
          }
          if (quiz.archivedAt) {
            sendError(ws, 'Quiz has been archived');
            return;
          }
          if (!quiz.questions.length) {
            sendError(ws, 'Quiz has no questions yet');
            return;
          }

          setQuiz(room, quiz);
          broadcast(room, { type: 'room_state', ...getRoomState(room) }, null);
          break;
        }

        case 'start_game': {
          const room = getRoom(currentRoom);
          if (!room) { sendError(ws, 'Not in a room'); return; }
          if (room.hostUserId !== participantId) { sendError(ws, 'Only host can start'); return; }
          if (room.players.size < 2) { sendError(ws, 'Need at least 2 players'); return; }
          if (room.state !== 'lobby') { sendError(ws, 'Game already started'); return; }
          if (!room.quiz) { sendError(ws, 'Pick a quiz first'); return; }

          const ok = startGame(room);
          if (!ok) { sendError(ws, 'Cannot start: quiz has no questions'); return; }
          const state = getRoomState(room);
          broadcast(room, { type: 'round_start', ...state }, null);
          break;
        }

        case 'submit_answer': {
          const room = getRoom(currentRoom);
          if (!room) { sendError(ws, 'Not in a room'); return; }
          if (room.state !== 'playing') { sendError(ws, 'No active game'); return; }

          const result = submitAnswer(room, participantId, msg.answer);
          if (!result) return;

          if (!result.accepted) {
            sendTo(ws, {
              type: 'answer_received',
              correct: result.correct,
              late: result.reason === 'round_already_resolved',
              duplicate: result.reason === 'already_answered',
            });
            return;
          }

          sendTo(ws, { type: 'answer_received', correct: result.correct });

          if (result.firstCorrect || result.allAnswered) {
            const roundResult = resolveRound(room);
            broadcast(room, { type: 'round_result', ...roundResult }, null);
          }
          break;
        }

        case 'next_round': {
          const room = getRoom(currentRoom);
          if (!room) { sendError(ws, 'Not in a room'); return; }
          if (room.state !== 'playing') { sendError(ws, 'No active game'); return; }

          if (!hasMoreQuestions(room)) {
            const gameResult = endGameAndRecord(room);
            broadcast(room, { type: 'game_over', ...gameResult }, null);
            break;
          }

          nextRound(room);
          const state = getRoomState(room);
          broadcast(room, { type: 'round_start', ...state }, null);
          break;
        }

        case 'vote_finish': {
          const room = getRoom(currentRoom);
          if (!room) { sendError(ws, 'Not in a room'); return; }
          if (room.state !== 'playing') { sendError(ws, 'No active game'); return; }

          const shouldFinish = voteFinish(room, participantId);
          if (shouldFinish) {
            const gameResult = endGameAndRecord(room);
            broadcast(room, { type: 'game_over', ...gameResult }, null);
          } else {
            broadcast(room, {
              type: 'vote_update',
              voterId: participantId,
              voterName: displayName,
              votesNeeded: Math.ceil(room.players.size / 2) - room.votesToFinish.size,
            }, null);
          }
          break;
        }

        default:
          sendError(ws, `Unknown message type: ${msg.type}`);
      }
    });

    ws.on('close', () => {
      if (!currentRoom) return;
      const room = getRoom(currentRoom);
      if (!room) return;

      const wasPlaying = room.state === 'playing';
      // Snapshot players BEFORE the leaver is removed so the abort path can
      // still credit their streaks/chesnuts for rounds they helped resolve.
      const playersBeforeLeave = Array.from(room.players.values());

      const remaining = removePlayer(room, participantId);
      if (!remaining) return;

      // Mid-game disconnect that drops the room below the 2-player minimum:
      // end the game, broadcast a final scoreboard, and tear the room down so
      // it does not sit in `playing` indefinitely (TRI-48 / TRI-49).
      if (wasPlaying && remaining.players.size < 2) {
        const gameResult = endGameAndRecord(remaining, playersBeforeLeave);
        broadcast(remaining, {
          type: 'game_over',
          aborted: true,
          reason: 'opponent_left',
          leftUserId: participantId,
          leftDisplayName: displayName,
          ...gameResult,
        });
        deleteRoom(remaining.code);
        return;
      }

      broadcast(remaining, {
        type: 'player_left',
        userId: participantId,
        displayName,
        ...getRoomState(remaining),
      });
    });
  });

  return wss;
}
