import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';

const router = Router();
const SALT_ROUNDS = 12;

function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const me = db.prepare('SELECT isAdmin, disabledAt, archivedAt FROM users WHERE id = ?')
    .get(req.session.userId);
  if (!me || me.disabledAt || me.archivedAt || !me.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    chesnutBalance: row.chesnutBalance,
    currentStreak: row.currentStreak,
    bestStreak: row.bestStreak,
    isAdmin: !!row.isAdmin,
    disabledAt: row.disabledAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}

// "Active admin" for last-admin guards: an admin who can still log in and use
// the admin console (not disabled, not archived).
const COUNT_OTHER_ACTIVE_ADMINS = `
  SELECT COUNT(*) AS n FROM users
  WHERE isAdmin = 1 AND disabledAt IS NULL AND archivedAt IS NULL AND id != ?
`;

// GET /users — list all users (archived rows included so admins can manage
// them; the UI surfaces them with an Archived badge, mirroring quizzes).
router.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, email, displayName, chesnutBalance, currentStreak, bestStreak,
           isAdmin, disabledAt, archivedAt, createdAt
    FROM users
    ORDER BY createdAt ASC
  `).all().map(publicUser);
  res.json({ users });
});

// POST /users — register a new user
router.post('/users', requireAdmin, (req, res) => {
  const { email, displayName, password, isAdmin } = req.body || {};

  if (!email || !password || !displayName) {
    return res.status(400).json({ error: 'Email, display name, and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  const result = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName, isAdmin) VALUES (?, ?, ?, ?)'
  ).run(email, passwordHash, displayName, isAdmin ? 1 : 0);

  const user = db.prepare(`
    SELECT id, email, displayName, chesnutBalance, currentStreak, bestStreak,
           isAdmin, disabledAt, archivedAt, createdAt
    FROM users WHERE id = ?
  `).get(result.lastInsertRowid);

  res.status(201).json({ user: publicUser(user) });
});

// POST /users/:id/password — change a user's password
router.post('/users/:id/password', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { password } = req.body || {};

  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(passwordHash, userId);

  res.json({ ok: true });
});

// POST /users/:id/disable — revoke access (soft delete)
router.post('/users/:id/disable', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (userId === req.session.userId) {
    return res.status(400).json({ error: 'You cannot disable your own account' });
  }

  const target = db.prepare('SELECT id, isAdmin, disabledAt FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.isAdmin) {
    const otherAdmins = db.prepare(COUNT_OTHER_ACTIVE_ADMINS).get(userId).n;
    if (otherAdmins === 0) {
      return res.status(400).json({ error: 'Cannot disable the last active admin' });
    }
  }

  db.prepare("UPDATE users SET disabledAt = datetime('now') WHERE id = ?").run(userId);
  res.json({ ok: true });
});

// POST /users/:id/enable — restore access
router.post('/users/:id/enable', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET disabledAt = NULL WHERE id = ?').run(userId);
  res.json({ ok: true });
});

// POST /users/:id/archive — hide from default admin views and revoke access
// (login + session restore are blocked, mirroring `disable`). Idempotent.
// Disable is the temporary lockout; archive is the soft-delete for users
// who are gone for good but whose history we keep for referential integrity.
router.post('/users/:id/archive', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });
  if (userId === req.session.userId) {
    return res.status(400).json({ error: 'You cannot archive your own account' });
  }

  const target = db.prepare('SELECT id, isAdmin, archivedAt FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.isAdmin && !target.archivedAt) {
    const otherAdmins = db.prepare(COUNT_OTHER_ACTIVE_ADMINS).get(userId).n;
    if (otherAdmins === 0) {
      return res.status(400).json({ error: 'Cannot archive the last active admin' });
    }
  }

  if (!target.archivedAt) {
    db.prepare("UPDATE users SET archivedAt = datetime('now') WHERE id = ?").run(userId);
  }
  res.json({ ok: true });
});

// POST /users/:id/unarchive — restore an archived user. Idempotent. Does not
// touch disabledAt — an archived-and-disabled user comes back disabled.
router.post('/users/:id/unarchive', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET archivedAt = NULL WHERE id = ?').run(userId);
  res.json({ ok: true });
});

// GET /quizzes — list all quizzes across all owners (archived rows included
// so admins can manage them; the UI surfaces them with an archive badge).
router.get('/quizzes', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT q.id, q.name, q.createdAt, q.archivedAt,
           q.ownerUserId,
           u.email AS ownerEmail,
           u.displayName AS ownerDisplayName,
           (SELECT COUNT(*) FROM quiz_questions WHERE quizId = q.id) AS questionCount
    FROM quizzes q
    LEFT JOIN users u ON u.id = q.ownerUserId
    ORDER BY q.createdAt DESC, q.id DESC
  `).all();
  res.json({ quizzes: rows });
});

// POST /quizzes/:id/archive — hide a quiz from owner lists and quiz picker
// without deleting it (and its history). Idempotent: archiving an already
// archived quiz is a no-op.
router.post('/quizzes/:id/archive', requireAdmin, (req, res) => {
  const quizId = parseInt(req.params.id, 10);
  if (!Number.isInteger(quizId)) return res.status(400).json({ error: 'Invalid quiz id' });

  const target = db.prepare('SELECT id, archivedAt FROM quizzes WHERE id = ?').get(quizId);
  if (!target) return res.status(404).json({ error: 'Quiz not found' });

  if (!target.archivedAt) {
    db.prepare("UPDATE quizzes SET archivedAt = datetime('now') WHERE id = ?").run(quizId);
  }
  res.json({ ok: true });
});

// POST /quizzes/:id/unarchive — restore an archived quiz.
router.post('/quizzes/:id/unarchive', requireAdmin, (req, res) => {
  const quizId = parseInt(req.params.id, 10);
  if (!Number.isInteger(quizId)) return res.status(400).json({ error: 'Invalid quiz id' });

  const target = db.prepare('SELECT id FROM quizzes WHERE id = ?').get(quizId);
  if (!target) return res.status(404).json({ error: 'Quiz not found' });

  db.prepare('UPDATE quizzes SET archivedAt = NULL WHERE id = ?').run(quizId);
  res.json({ ok: true });
});

// SQLite stores TEXT timestamps as `YYYY-MM-DD HH:MM:SS` in UTC. Parse them
// back to a Date so we can compute durations between startedAt and finishedAt.
function parseSqlTimestamp(s) {
  if (!s) return null;
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

function gameDurationMs(startedAt, finishedAt) {
  const s = parseSqlTimestamp(startedAt);
  const f = parseSqlTimestamp(finishedAt);
  if (!s || !f) return null;
  return f.getTime() - s.getTime();
}

// Build a winner descriptor from the math_battle_games row, falling back to
// the top math_battle_players scorer for legacy rows recorded before TRI-101
// added the winner snapshot. Returns null when nobody won a round (or for
// legacy rows where no math_battle_players row exists either).
function buildGameWinner(g, topScorer) {
  if (g.winnerDisplayName) {
    return {
      source: g.winnerGuestId ? 'guest' : 'user',
      userId: g.winnerUserId,
      guestId: g.winnerGuestId,
      displayName: g.winnerDisplayName,
      roundsWon: g.winnerRoundsWon,
    };
  }
  if (topScorer && topScorer.roundsWon > 0) {
    return {
      source: 'user',
      userId: topScorer.userId,
      guestId: null,
      displayName: topScorer.displayName || null,
      roundsWon: topScorer.roundsWon,
    };
  }
  return null;
}

// GET /games — list every recorded Quiz Battle game with summary stats.
// Archived rows are included so admins can manage them; the UI surfaces an
// archived badge and an unarchive action.
router.get('/games', requireAdmin, (req, res) => {
  const games = db.prepare(`
    SELECT g.id, g.roomCode, g.quizId, g.totalRounds, g.startedAt, g.finishedAt,
           g.archivedAt,
           g.winnerUserId, g.winnerGuestId, g.winnerDisplayName, g.winnerRoundsWon,
           q.name AS quizName,
           (SELECT COUNT(*) FROM math_battle_players WHERE gameId = g.id) AS playerCount
    FROM math_battle_games g
    LEFT JOIN quizzes q ON q.id = g.quizId
    ORDER BY g.finishedAt DESC, g.id DESC
  `).all();

  const topStmt = db.prepare(`
    SELECT p.userId, p.roundsWon, u.displayName
    FROM math_battle_players p
    LEFT JOIN users u ON u.id = p.userId
    WHERE p.gameId = ?
    ORDER BY p.roundsWon DESC, p.id ASC
    LIMIT 1
  `);

  res.json({
    games: games.map(g => {
      const topScorer = topStmt.get(g.id) || null;
      return {
        id: g.id,
        roomCode: g.roomCode,
        quizId: g.quizId,
        quizName: g.quizName,
        totalRounds: g.totalRounds,
        startedAt: g.startedAt,
        finishedAt: g.finishedAt,
        archivedAt: g.archivedAt,
        durationMs: gameDurationMs(g.startedAt, g.finishedAt),
        playerCount: g.playerCount,
        winner: buildGameWinner(g, topScorer),
      };
    }),
  });
});

// POST /games/:id/archive — hide a game from the admin Games view without
// deleting it (and its rounds/players). Idempotent: archiving an already
// archived game is a no-op and preserves the original archive time.
router.post('/games/:id/archive', requireAdmin, (req, res) => {
  const gameId = parseInt(req.params.id, 10);
  if (!Number.isInteger(gameId)) return res.status(400).json({ error: 'Invalid game id' });

  const target = db.prepare('SELECT id, archivedAt FROM math_battle_games WHERE id = ?').get(gameId);
  if (!target) return res.status(404).json({ error: 'Game not found' });

  if (!target.archivedAt) {
    db.prepare("UPDATE math_battle_games SET archivedAt = datetime('now') WHERE id = ?").run(gameId);
  }
  res.json({ ok: true });
});

// POST /games/:id/unarchive — restore an archived game.
router.post('/games/:id/unarchive', requireAdmin, (req, res) => {
  const gameId = parseInt(req.params.id, 10);
  if (!Number.isInteger(gameId)) return res.status(400).json({ error: 'Invalid game id' });

  const target = db.prepare('SELECT id FROM math_battle_games WHERE id = ?').get(gameId);
  if (!target) return res.status(404).json({ error: 'Game not found' });

  db.prepare('UPDATE math_battle_games SET archivedAt = NULL WHERE id = ?').run(gameId);
  res.json({ ok: true });
});

// GET /games/:id — full detail: every player and every round.
router.get('/games/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid game id' });

  const game = db.prepare(`
    SELECT g.id, g.roomCode, g.quizId, g.totalRounds, g.startedAt, g.finishedAt,
           g.archivedAt,
           g.winnerUserId, g.winnerGuestId, g.winnerDisplayName, g.winnerRoundsWon,
           q.name AS quizName
    FROM math_battle_games g
    LEFT JOIN quizzes q ON q.id = g.quizId
    WHERE g.id = ?
  `).get(id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const players = db.prepare(`
    SELECT p.userId, p.roundsWon, p.chesnutsEarned,
           u.displayName, u.email
    FROM math_battle_players p
    LEFT JOIN users u ON u.id = p.userId
    WHERE p.gameId = ?
    ORDER BY p.roundsWon DESC, p.id ASC
  `).all(id);

  const rounds = db.prepare(`
    SELECT r.roundNumber, r.challenge, r.correctAnswer, r.winnerId, r.timeTakenMs,
           u.displayName AS winnerDisplayName
    FROM math_battle_rounds r
    LEFT JOIN users u ON u.id = r.winnerId
    WHERE r.gameId = ?
    ORDER BY r.roundNumber ASC
  `).all(id);

  const topScorer = players.length
    ? { userId: players[0].userId, roundsWon: players[0].roundsWon, displayName: players[0].displayName }
    : null;

  res.json({
    game: {
      ...game,
      durationMs: gameDurationMs(game.startedAt, game.finishedAt),
      winner: buildGameWinner(game, topScorer),
      players,
      rounds,
    },
  });
});

// POST /users/:id/admin — set admin flag
router.post('/users/:id/admin', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { isAdmin } = req.body || {};
  const target = db.prepare('SELECT id, isAdmin FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (!isAdmin && userId === req.session.userId) {
    return res.status(400).json({ error: 'You cannot remove your own admin role' });
  }

  if (!isAdmin && target.isAdmin) {
    const otherAdmins = db.prepare(COUNT_OTHER_ACTIVE_ADMINS).get(userId).n;
    if (otherAdmins === 0) {
      return res.status(400).json({ error: 'Cannot remove admin from the last active admin' });
    }
  }

  db.prepare('UPDATE users SET isAdmin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
  res.json({ ok: true });
});

export default router;
