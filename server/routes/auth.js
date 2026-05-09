import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';

const router = Router();
const SALT_ROUNDS = 12;

// Shape a guest row for the client. Guest IDs are returned as a negative
// number so callers can use a single numeric `id` to identify any
// participant — positive = registered user, negative = guest.
function shapeGuest(guest) {
  return {
    id: -guest.id,
    displayName: guest.displayName,
    chesnutBalance: 0,
    currentStreak: guest.currentStreak,
    bestStreak: guest.bestStreak,
    isAdmin: false,
    isGuest: true,
    createdAt: guest.createdAt,
  };
}

// Get current user info — supports both registered users and guests
router.get('/me', (req, res) => {
  if (req.session.userId) {
    const user = db.prepare(
      'SELECT id, email, displayName, chesnutBalance, currentStreak, bestStreak, isAdmin, disabledAt, createdAt FROM users WHERE id = ?'
    ).get(req.session.userId);

    if (user && !user.disabledAt) {
      return res.json({
        user: {
          ...user,
          isAdmin: !!user.isAdmin,
          isGuest: false,
          disabledAt: undefined,
        },
      });
    }
    req.session.destroy(() => {});
    return res.json({ user: null });
  }

  if (req.session.guestId) {
    const guest = db.prepare(
      'SELECT id, displayName, currentStreak, bestStreak, createdAt FROM guests WHERE id = ?'
    ).get(req.session.guestId);
    if (guest) {
      db.prepare("UPDATE guests SET lastSeenAt = datetime('now') WHERE id = ?").run(guest.id);
      return res.json({ user: shapeGuest(guest) });
    }
    delete req.session.guestId;
  }

  res.json({ user: null });
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
  delete req.session.guestId;

  const user = db.prepare(
    'SELECT id, email, displayName, chesnutBalance, currentStreak, bestStreak, isAdmin, createdAt FROM users WHERE id = ?'
  ).get(result.lastInsertRowid);

  res.status(201).json({ user: { ...user, isAdmin: !!user.isAdmin, isGuest: false } });
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
  delete req.session.guestId;

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      chesnutBalance: user.chesnutBalance,
      currentStreak: user.currentStreak,
      bestStreak: user.bestStreak,
      isAdmin: !!user.isAdmin,
      isGuest: false,
      createdAt: user.createdAt,
    },
  });
});

// Guest sign-in: identified by a browser-generated token in localStorage.
// Returning visitors with the same token keep their streaks across sessions.
router.post('/guest', (req, res) => {
  const { guestToken, displayName } = req.body;

  if (typeof guestToken !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(guestToken)) {
    return res.status(400).json({ error: 'Invalid guest token' });
  }
  const cleanName = (typeof displayName === 'string' ? displayName : '').trim();
  if (cleanName.length < 1 || cleanName.length > 40) {
    return res.status(400).json({ error: 'Display name must be 1-40 characters' });
  }

  let guest = db.prepare(
    'SELECT id, displayName, currentStreak, bestStreak, createdAt FROM guests WHERE guestToken = ?'
  ).get(guestToken);

  if (guest) {
    if (guest.displayName !== cleanName) {
      db.prepare(
        "UPDATE guests SET displayName = ?, lastSeenAt = datetime('now') WHERE id = ?"
      ).run(cleanName, guest.id);
      guest.displayName = cleanName;
    } else {
      db.prepare("UPDATE guests SET lastSeenAt = datetime('now') WHERE id = ?").run(guest.id);
    }
  } else {
    const result = db.prepare(
      'INSERT INTO guests (guestToken, displayName) VALUES (?, ?)'
    ).run(guestToken, cleanName);
    guest = db.prepare(
      'SELECT id, displayName, currentStreak, bestStreak, createdAt FROM guests WHERE id = ?'
    ).get(result.lastInsertRowid);
  }

  delete req.session.userId;
  req.session.guestId = guest.id;

  res.json({ user: shapeGuest(guest) });
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
