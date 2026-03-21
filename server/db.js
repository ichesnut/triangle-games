import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const DB_PATH = new URL('../data/chesnuts.db', import.meta.url).pathname;

// Ensure data directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

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

// Indexes for fast lookups
db.exec(`CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempt_history(userId)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_challenges_category ON challenges(categorySlug)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_redemptions_user ON redemptions(userId)`);

export default db;
