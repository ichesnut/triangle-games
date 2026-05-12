import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.DATA_DIR || new URL('../data', import.meta.url).pathname;
const DB_PATH = join(DATA_DIR, 'chesnuts.db');

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    displayName TEXT NOT NULL,
    chesnutBalance INTEGER NOT NULL DEFAULT 0,
    currentStreak INTEGER NOT NULL DEFAULT 0,
    bestStreak INTEGER NOT NULL DEFAULT 0,
    isAdmin INTEGER NOT NULL DEFAULT 0,
    disabledAt TEXT,
    archivedAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: add isAdmin, disabledAt, and archivedAt to existing installs
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('isAdmin')) {
  db.exec('ALTER TABLE users ADD COLUMN isAdmin INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('disabledAt')) {
  db.exec('ALTER TABLE users ADD COLUMN disabledAt TEXT');
}
if (!userCols.includes('archivedAt')) {
  db.exec('ALTER TABLE users ADD COLUMN archivedAt TEXT');
}

// Guests: unauthenticated players identified by a browser-generated token.
// Duplicate displayNames are intentionally allowed; the guestToken is the
// stable identity and lives in the player's localStorage.
db.exec(`
  CREATE TABLE IF NOT EXISTS guests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guestToken TEXT UNIQUE NOT NULL,
    displayName TEXT NOT NULL,
    currentStreak INTEGER NOT NULL DEFAULT 0,
    bestStreak INTEGER NOT NULL DEFAULT 0,
    gamesPlayed INTEGER NOT NULL DEFAULT 0,
    roundsWon INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastSeenAt TEXT NOT NULL DEFAULT (datetime('now')),
    mergedIntoUserId INTEGER REFERENCES users(id),
    mergedAt TEXT
  )
`);

// Migration: add merge-tracking columns to existing guests installs.
const guestCols = db.prepare('PRAGMA table_info(guests)').all().map(c => c.name);
if (!guestCols.includes('mergedIntoUserId')) {
  db.exec('ALTER TABLE guests ADD COLUMN mergedIntoUserId INTEGER REFERENCES users(id)');
}
if (!guestCols.includes('mergedAt')) {
  db.exec('ALTER TABLE guests ADD COLUMN mergedAt TEXT');
}

// Challenge data table
db.exec(`
  CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    categorySlug TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('question', 'puzzle')),
    difficulty TEXT NOT NULL CHECK(difficulty IN ('easy', 'medium', 'hard')),
    prompt TEXT NOT NULL,
    data TEXT NOT NULL,
    answer TEXT NOT NULL,
    chesnutReward INTEGER NOT NULL
  )
`);

// Attempt history table
db.exec(`
  CREATE TABLE IF NOT EXISTS attempt_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL REFERENCES users(id),
    challengeId INTEGER NOT NULL REFERENCES challenges(id),
    correct INTEGER NOT NULL DEFAULT 0,
    chesnutsEarned INTEGER NOT NULL DEFAULT 0,
    answeredAt TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Rewards table
db.exec(`
  CREATE TABLE IF NOT EXISTS rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    chesnutCost INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Redemptions table
db.exec(`
  CREATE TABLE IF NOT EXISTS redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL REFERENCES users(id),
    rewardId INTEGER NOT NULL REFERENCES rewards(id),
    chesnutsSpent INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'fulfilled', 'cancelled')),
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Quizzes (pre-configured question sets used by Quiz Battle)
db.exec(`
  CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ownerUserId INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    archivedAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: add archivedAt to existing installs (TRI-81).
const quizCols = db.prepare('PRAGMA table_info(quizzes)').all().map(c => c.name);
if (!quizCols.includes('archivedAt')) {
  db.exec('ALTER TABLE quizzes ADD COLUMN archivedAt TEXT');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS quiz_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quizId INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS quiz_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quizId INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    categoryId INTEGER REFERENCES quiz_categories(id) ON DELETE SET NULL,
    position INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('free', 'single', 'multiple')),
    options TEXT NOT NULL DEFAULT '[]',
    correctAnswers TEXT NOT NULL DEFAULT '[]'
  )
`);

// Add categoryId column to existing quiz_questions installs that predate
// the categories feature.
const hasCategoryId = db.prepare("PRAGMA table_info(quiz_questions)")
  .all()
  .some(col => col.name === 'categoryId');
if (!hasCategoryId) {
  db.exec('ALTER TABLE quiz_questions ADD COLUMN categoryId INTEGER REFERENCES quiz_categories(id) ON DELETE SET NULL');
}

// Quiz Battle game history.
// Note: legacy table names use "math_battle_" — kept to avoid migrating
// existing rows; renaming the tables is purely cosmetic.
db.exec(`
  CREATE TABLE IF NOT EXISTS math_battle_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomCode TEXT NOT NULL,
    quizId INTEGER REFERENCES quizzes(id) ON DELETE SET NULL,
    totalRounds INTEGER NOT NULL,
    startedAt TEXT,
    archivedAt TEXT,
    winnerUserId INTEGER REFERENCES users(id) ON DELETE SET NULL,
    winnerGuestId INTEGER REFERENCES guests(id) ON DELETE SET NULL,
    winnerDisplayName TEXT,
    winnerRoundsWon INTEGER,
    finishedAt TEXT NOT NULL
  )
`);

// Migration: older installs created math_battle_games before quizId / startedAt
// existed; add them so the admin game view (TRI-80) can show which quiz played
// and how long the game took. Existing rows keep NULL for both.
// archivedAt (TRI-82) is added the same way for installs predating archive.
// winner* (TRI-101) snapshots who won the game so the admin console can show
// a winner even when the winner was an unregistered guest (or when only guests
// played and no math_battle_players row exists).
const gameCols = db.prepare('PRAGMA table_info(math_battle_games)').all().map(c => c.name);
if (!gameCols.includes('quizId')) {
  db.exec('ALTER TABLE math_battle_games ADD COLUMN quizId INTEGER REFERENCES quizzes(id) ON DELETE SET NULL');
}
if (!gameCols.includes('startedAt')) {
  db.exec('ALTER TABLE math_battle_games ADD COLUMN startedAt TEXT');
}
if (!gameCols.includes('archivedAt')) {
  db.exec('ALTER TABLE math_battle_games ADD COLUMN archivedAt TEXT');
}
if (!gameCols.includes('winnerUserId')) {
  db.exec('ALTER TABLE math_battle_games ADD COLUMN winnerUserId INTEGER REFERENCES users(id) ON DELETE SET NULL');
}
if (!gameCols.includes('winnerGuestId')) {
  db.exec('ALTER TABLE math_battle_games ADD COLUMN winnerGuestId INTEGER REFERENCES guests(id) ON DELETE SET NULL');
}
if (!gameCols.includes('winnerDisplayName')) {
  db.exec('ALTER TABLE math_battle_games ADD COLUMN winnerDisplayName TEXT');
}
if (!gameCols.includes('winnerRoundsWon')) {
  db.exec('ALTER TABLE math_battle_games ADD COLUMN winnerRoundsWon INTEGER');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS math_battle_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameId INTEGER NOT NULL REFERENCES math_battle_games(id),
    userId INTEGER NOT NULL REFERENCES users(id),
    roundsWon INTEGER NOT NULL DEFAULT 0,
    chesnutsEarned INTEGER NOT NULL DEFAULT 0
  )
`);

// Per-game roster of unregistered guest participants (TRI-117). Kept in a
// separate table so we don't have to recreate math_battle_players to relax
// its NOT NULL userId. displayName is snapshotted so the admin detail view
// still names a guest even if the guests row is later deleted.
db.exec(`
  CREATE TABLE IF NOT EXISTS math_battle_guest_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameId INTEGER NOT NULL REFERENCES math_battle_games(id),
    guestId INTEGER REFERENCES guests(id) ON DELETE SET NULL,
    displayName TEXT NOT NULL,
    roundsWon INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS math_battle_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameId INTEGER NOT NULL REFERENCES math_battle_games(id),
    roundNumber INTEGER NOT NULL,
    challenge TEXT NOT NULL,
    correctAnswer TEXT NOT NULL,
    winnerId INTEGER REFERENCES users(id),
    timeTakenMs INTEGER
  )
`);

// Indexes for fast lookups
db.exec(`CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempt_history(userId)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_challenges_category ON challenges(categorySlug)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_redemptions_user ON redemptions(userId)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_math_battle_players_user ON math_battle_players(userId)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_math_battle_players_game ON math_battle_players(gameId)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_math_battle_guest_players_game ON math_battle_guest_players(gameId)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_math_battle_rounds_game ON math_battle_rounds(gameId)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_quizzes_owner ON quizzes(ownerUserId)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz ON quiz_questions(quizId, position)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_quiz_categories_quiz ON quiz_categories(quizId, position)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_quiz_questions_category ON quiz_questions(categoryId)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_guests_token ON guests(guestToken)`);

export default db;
