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
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

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

// Math Battle game history
db.exec(`
  CREATE TABLE IF NOT EXISTS math_battle_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomCode TEXT NOT NULL,
    totalRounds INTEGER NOT NULL,
    finishedAt TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS math_battle_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameId INTEGER NOT NULL REFERENCES math_battle_games(id),
    userId INTEGER NOT NULL REFERENCES users(id),
    roundsWon INTEGER NOT NULL DEFAULT 0,
    chesnutsEarned INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS math_battle_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameId INTEGER NOT NULL REFERENCES math_battle_games(id),
    roundNumber INTEGER NOT NULL,
    challenge TEXT NOT NULL,
    correctAnswer INTEGER NOT NULL,
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
db.exec(`CREATE INDEX IF NOT EXISTS idx_math_battle_rounds_game ON math_battle_rounds(gameId)`);

export default db;
