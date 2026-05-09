import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';

const router = Router();
const SALT_ROUNDS = 12;

// Get current user info
router.get('/me', (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }

  const user = db.prepare(
    'SELECT id, email, displayName, chesnutBalance, currentStreak, bestStreak, isAdmin, disabledAt, createdAt FROM users WHERE id = ?'
  ).get(req.session.userId);

  if (!user || user.disabledAt) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }

  res.json({
    user: {
      ...user,
      isAdmin: !!user.isAdmin,
      disabledAt: undefined,
    },
  });
});

// Register
router.post('/register', (req, res) => {
  const { email, displayName, password } = req.body;

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

  // Promote the user if their email is in ADMIN_EMAILS, or if this is the
  // first account to exist and no admin has been seeded yet.
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const haveAdmin = !!db.prepare('SELECT 1 FROM users WHERE isAdmin = 1 LIMIT 1').get();
  const shouldBeAdmin = adminEmails.includes(email.toLowerCase()) || !haveAdmin;

  const result = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName, isAdmin) VALUES (?, ?, ?, ?)'
  ).run(email, passwordHash, displayName, shouldBeAdmin ? 1 : 0);

  req.session.userId = result.lastInsertRowid;

  const user = db.prepare(
    'SELECT id, email, displayName, chesnutBalance, currentStreak, bestStreak, isAdmin, createdAt FROM users WHERE id = ?'
  ).get(result.lastInsertRowid);

  res.status(201).json({ user: { ...user, isAdmin: !!user.isAdmin } });
});

// Login
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.disabledAt) {
    return res.status(403).json({ error: 'This account has been disabled' });
  }

  req.session.userId = user.id;

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      chesnutBalance: user.chesnutBalance,
      currentStreak: user.currentStreak,
      bestStreak: user.bestStreak,
      isAdmin: !!user.isAdmin,
      createdAt: user.createdAt,
    },
  });
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

export default router;
