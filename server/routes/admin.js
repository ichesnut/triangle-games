import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';

const router = Router();
const SALT_ROUNDS = 12;

function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const me = db.prepare('SELECT isAdmin, disabledAt FROM users WHERE id = ?')
    .get(req.session.userId);
  if (!me || me.disabledAt || !me.isAdmin) {
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
    createdAt: row.createdAt,
  };
}

// GET /users — list all users
router.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, email, displayName, chesnutBalance, currentStreak, bestStreak,
           isAdmin, disabledAt, createdAt
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
           isAdmin, disabledAt, createdAt
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
    const otherAdmins = db.prepare(
      'SELECT COUNT(*) as n FROM users WHERE isAdmin = 1 AND disabledAt IS NULL AND id != ?'
    ).get(userId).n;
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
    const otherAdmins = db.prepare(
      'SELECT COUNT(*) as n FROM users WHERE isAdmin = 1 AND disabledAt IS NULL AND id != ?'
    ).get(userId).n;
    if (otherAdmins === 0) {
      return res.status(400).json({ error: 'Cannot remove admin from the last active admin' });
    }
  }

  db.prepare('UPDATE users SET isAdmin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
  res.json({ ok: true });
});

export default router;
