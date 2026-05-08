// WebSocket server for Quiz Battle multiplayer

import { WebSocketServer } from 'ws';
import db from '../db.js';
import {
  createRoom,
  addPlayer,
  removePlayer,
  getRoom,
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

const awardChesnuts = db.transaction((totalChesnuts) => {
  const stmt = db.prepare('UPDATE users SET chesnutBalance = chesnutBalance + ? WHERE id = ?');
  for (const [userId, amount] of Object.entries(totalChesnuts)) {
    stmt.run(amount, Number(userId));
  }
});

const recordGame = db.transaction((roomCode, gameResult, players) => {
  const insertGame = db.prepare(
    'INSERT INTO math_battle_games (roomCode, totalRounds, finishedAt) VALUES (?, ?, datetime(\'now\'))'
  );
  const { lastInsertRowid: gameId } = insertGame.run(roomCode, gameResult.totalRounds);

  const insertPlayer = db.prepare(
    'INSERT INTO math_battle_players (gameId, userId, roundsWon, chesnutsEarned) VALUES (?, ?, ?, ?)'
  );
  for (const p of players) {
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
    insertRound.run(gameId, r.round, r.challenge, String(r.correctAnswer), r.winnerId, r.timeTaken);
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

function endGameAndRecord(room) {
  const gameResult = finishGame(room);

  if (Object.keys(gameResult.totalChesnuts).length > 0) {
    awardChesnuts(gameResult.totalChesnuts);
  }

  const players = Array.from(room.players.values());
  try {
    recordGame(room.code, gameResult, players);
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
      if (!req.session?.userId) {
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
    const userId = req.session.userId;
    const user = db.prepare(
      'SELECT id, displayName FROM users WHERE id = ?'
    ).get(userId);

    if (!user) {
      sendError(ws, 'User not found');
      ws.close();
      return;
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
          const room = createRoom(userId, user.displayName);
          addPlayer(room, userId, user.displayName, ws);
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
          if (room.players.has(userId)) {
            sendError(ws, 'Already in this room');
            return;
          }
          addPlayer(room, userId, user.displayName, ws);
          currentRoom = room.code;

          broadcast(room, {
            type: 'player_joined',
            userId,
            displayName: user.displayName,
          }, userId);

          sendTo(ws, { type: 'room_state', ...getRoomState(room) });
          break;
        }

        case 'select_quiz': {
          const room = getRoom(currentRoom);
          if (!room) { sendError(ws, 'Not in a room'); return; }
          if (room.hostUserId !== userId) { sendError(ws, 'Only host can pick a quiz'); return; }
          if (room.state !== 'lobby') { sendError(ws, 'Quiz can only be set in the lobby'); return; }

          const quizId = Number(msg.quizId);
          if (!Number.isInteger(quizId)) {
            sendError(ws, 'Invalid quizId'); return;
          }
          const quiz = loadQuizWithQuestions(quizId);
          if (!quiz) { sendError(ws, 'Quiz not found'); return; }
          if (quiz.ownerUserId !== userId) {
            sendError(ws, 'Only the quiz owner can host it');
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
          if (room.hostUserId !== userId) { sendError(ws, 'Only host can start'); return; }
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

          const result = submitAnswer(room, userId, msg.answer);
          if (!result) return;

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

          const shouldFinish = voteFinish(room, userId);
          if (shouldFinish) {
            const gameResult = endGameAndRecord(room);
            broadcast(room, { type: 'game_over', ...gameResult }, null);
          } else {
            broadcast(room, {
              type: 'vote_update',
              voterId: userId,
              voterName: user.displayName,
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
      if (currentRoom) {
        const room = getRoom(currentRoom);
        if (room) {
          const remaining = removePlayer(room, userId);
          if (remaining) {
            broadcast(remaining, {
              type: 'player_left',
              userId,
              displayName: user.displayName,
              ...getRoomState(remaining),
            });
          }
        }
      }
    });
  });

  return wss;
}
