import { randomBytes } from 'crypto';
import { createServer } from 'http';
import express from 'express';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import { mkdirSync } from 'fs';
import authRouter from './routes/auth.js';
import challengeRouter from './routes/challenges.js';
import rewardsRouter from './routes/rewards.js';
import { attachWebSocketServer } from './multiplayer/ws.js';
import './seed.js';

const SQLiteStore = connectSqlite3(session);

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;

// Ensure data directory exists for session store
mkdirSync(new URL('../data', import.meta.url).pathname, { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Session configuration (shared with WebSocket upgrade handler)
const sessionParser = session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: new URL('../data', import.meta.url).pathname,
  }),
  secret: process.env.SESSION_SECRET || 'triangle-games-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});
app.use(sessionParser);

// CSRF protection: generate token on GET, validate on POST/PUT/DELETE
app.use((req, res, next) => {
  // Generate CSRF token if not present in session
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString('hex');
  }
  next();
});

// CSRF validation middleware for state-changing requests
function csrfProtection(req, res, next) {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const token = req.headers['x-csrf-token'] || req.body?._csrf;
    if (!token || token !== req.session.csrfToken) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
  }
  next();
}

// API routes
app.get('/api/chesnuts/csrf-token', (req, res) => {
  res.json({ csrfToken: req.session.csrfToken });
});

app.use('/api/chesnuts/challenges', csrfProtection, challengeRouter);
app.use('/api/chesnuts/rewards', csrfProtection, rewardsRouter);
app.use('/api/chesnuts', csrfProtection, authRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Attach WebSocket server for multiplayer
attachWebSocketServer(httpServer, sessionParser);

httpServer.listen(PORT, () => {
  console.log(`Triangle Games server running on port ${PORT}`);
});
