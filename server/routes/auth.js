import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';

const router = Router();
const SALT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_DISPLAY_NAME_LENGTH = 40;

// If the session is upgrading from a guest, copy guest streak/best-streak
// onto the user (preferring whichever is higher) and mark the guest row as
// merged so its token can't keep accruing stats. Returns the user row in
// case its streak fields changed.
const mergeGuestIntoUser = db.transaction((guestId, userId) => {
  const guest = db.prepare(
    'SELECT id, currentStreak, bestStreak, mergedIntoUserId FROM guests WHERE id = ?'
  ).get(guestId);
  if (!guest || guest.mergedIntoUserId) return;

  db.prepare(`
    UPDATE users
    SET currentStreak = MAX(currentStreak, ?),
        bestStreak    = MAX(bestStreak, ?)
    WHERE id = ?
  `).run(guest.currentStreak, guest.bestStreak, userId);

  db.prepare(
    "UPDATE guests SET mergedIntoUserId = ?, mergedAt = datetime('now') WHERE id = ?"
  ).run(userId, guestId);
});

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
      'SELECT id, displayName, currentStreak, bestStreak, createdAt FROM guests WHERE id = ? AND mergedIntoUserId IS NULL'
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
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const rawDisplayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!rawEmail || !password || !rawDisplayName) {
    return res.status(400).json({ error: 'Email, display name, and password are required' });
  }

  if (rawEmail.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(rawEmail)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  if (rawDisplayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return res.status(400).json({ error: 'Display name must be 1-40 characters' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const email = rawEmail;
  const displayName = rawDisplayName;

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

  const newUserId = result.lastInsertRowid;

  if (req.session.guestId) {
    try { mergeGuestIntoUser(req.session.guestId, newUserId); } catch (_) {}
  }

  req.session.userId = newUserId;
  delete req.session.guestId;

  const user = db.prepare(
    'SELECT id, email, displayName, chesnutBalance, currentStreak, bestStreak, isAdmin, createdAt FROM users WHERE id = ?'
  ).get(newUserId);

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

  if (req.session.guestId) {
    try { mergeGuestIntoUser(req.session.guestId, user.id); } catch (_) {}
  }

  req.session.userId = user.id;
  delete req.session.guestId;

  // Re-read so any streak fields lifted from the merged guest are returned.
  const fresh = db.prepare(
    'SELECT id, email, displayName, chesnutBalance, currentStreak, bestStreak, isAdmin, createdAt FROM users WHERE id = ?'
  ).get(user.id);

  res.json({
    user: { ...fresh, isAdmin: !!fresh.isAdmin, isGuest: false },
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

  // A merged guest row has been promoted into a registered user already;
  // the same browser reusing the token after upgrade should get a fresh
  // guest, not the old (now-empty) one. Free up the unique guestToken on
  // the merged row so we can reuse it for the new guest.
  const existing = db.prepare(
    'SELECT id, mergedIntoUserId FROM guests WHERE guestToken = ?'
  ).get(guestToken);
  if (existing && existing.mergedIntoUserId) {
    db.prepare(
      "UPDATE guests SET guestToken = ? WHERE id = ?"
    ).run(`merged:${existing.id}:${guestToken}`, existing.id);
  }

  let guest = (existing && !existing.mergedIntoUserId)
    ? db.prepare(
        'SELECT id, displayName, currentStreak, bestStreak, createdAt FROM guests WHERE id = ?'
      ).get(existing.id)
    : null;

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
