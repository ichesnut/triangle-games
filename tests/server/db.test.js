import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// db.js evaluates side-effects at import time (creates the DB, runs
// migrations, builds indexes). Each test wants a fresh DATA_DIR plus a
// fresh module evaluation, so we cache-bust the import URL.
let nonce = 0;
async function importDbWith(dataDir) {
  process.env.DATA_DIR = dataDir;
  const mod = await import(`../../server/db.js?fresh=${++nonce}`);
  return mod.default;
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'tri-db-test-'));
}

const EXPECTED_TABLES = [
  'users',
  'guests',
  'challenges',
  'attempt_history',
  'rewards',
  'redemptions',
  'quizzes',
  'quiz_categories',
  'quiz_questions',
  'math_battle_games',
  'math_battle_players',
  'math_battle_rounds',
];

const EXPECTED_INDEXES = [
  'idx_attempts_user',
  'idx_challenges_category',
  'idx_redemptions_user',
  'idx_math_battle_players_user',
  'idx_math_battle_players_game',
  'idx_math_battle_rounds_game',
  'idx_quizzes_owner',
  'idx_quiz_questions_quiz',
  'idx_quiz_categories_quiz',
  'idx_quiz_questions_category',
  'idx_guests_token',
];

test('db.js: import creates chesnuts.db with all expected tables', async () => {
  const dir = freshDir();
  const db = await importDbWith(dir);

  assert.ok(existsSync(join(dir, 'chesnuts.db')), 'DB file should exist');

  const tableNames = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);

  for (const t of EXPECTED_TABLES) {
    assert.ok(tableNames.includes(t), `expected table ${t}`);
  }
});

test('db.js: import creates all expected indexes', async () => {
  const dir = freshDir();
  const db = await importDbWith(dir);

  const indexNames = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
  ).all().map(r => r.name);

  for (const idx of EXPECTED_INDEXES) {
    assert.ok(indexNames.includes(idx), `expected index ${idx}`);
  }
});

test('db.js: enables WAL journal mode and foreign keys', async () => {
  const dir = freshDir();
  const db = await importDbWith(dir);

  const journalMode = db.pragma('journal_mode', { simple: true });
  assert.equal(journalMode, 'wal');

  const fkOn = db.pragma('foreign_keys', { simple: true });
  assert.equal(fkOn, 1);
});

test('db.js: migrates users table — adds isAdmin and disabledAt', async () => {
  const dir = freshDir();
  // Pre-seed a stripped-down users table missing isAdmin/disabledAt.
  const pre = new Database(join(dir, 'chesnuts.db'));
  pre.exec(`
    CREATE TABLE users (
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
  pre.prepare(
    'INSERT INTO users (email, passwordHash, displayName) VALUES (?, ?, ?)'
  ).run('a@b.c', 'hash', 'Alice');
  pre.close();

  const db = await importDbWith(dir);
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  assert.ok(cols.includes('isAdmin'), 'isAdmin column added');
  assert.ok(cols.includes('disabledAt'), 'disabledAt column added');

  // Existing row is preserved and gets the default isAdmin=0.
  const row = db.prepare('SELECT email, isAdmin, disabledAt FROM users WHERE email = ?')
    .get('a@b.c');
  assert.equal(row.email, 'a@b.c');
  assert.equal(row.isAdmin, 0);
  assert.equal(row.disabledAt, null);
});

test('db.js: migrates guests table — adds mergedIntoUserId and mergedAt', async () => {
  const dir = freshDir();
  const pre = new Database(join(dir, 'chesnuts.db'));
  pre.exec(`
    CREATE TABLE guests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guestToken TEXT UNIQUE NOT NULL,
      displayName TEXT NOT NULL,
      currentStreak INTEGER NOT NULL DEFAULT 0,
      bestStreak INTEGER NOT NULL DEFAULT 0,
      gamesPlayed INTEGER NOT NULL DEFAULT 0,
      roundsWon INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      lastSeenAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  pre.prepare(
    'INSERT INTO guests (guestToken, displayName) VALUES (?, ?)'
  ).run('tok-12345678', 'GuestZero');
  pre.close();

  const db = await importDbWith(dir);
  const cols = db.prepare('PRAGMA table_info(guests)').all().map(c => c.name);
  assert.ok(cols.includes('mergedIntoUserId'));
  assert.ok(cols.includes('mergedAt'));
  const guest = db.prepare('SELECT * FROM guests WHERE guestToken = ?').get('tok-12345678');
  assert.equal(guest.displayName, 'GuestZero');
  assert.equal(guest.mergedIntoUserId, null);
  assert.equal(guest.mergedAt, null);
});

test('db.js: migrates quiz_questions table — adds categoryId', async () => {
  const dir = freshDir();
  const pre = new Database(join(dir, 'chesnuts.db'));
  pre.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      displayName TEXT NOT NULL,
      chesnutBalance INTEGER NOT NULL DEFAULT 0,
      currentStreak INTEGER NOT NULL DEFAULT 0,
      bestStreak INTEGER NOT NULL DEFAULT 0,
      isAdmin INTEGER NOT NULL DEFAULT 0,
      disabledAt TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  pre.exec(`
    CREATE TABLE quizzes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ownerUserId INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Old quiz_questions schema with no categoryId column.
  pre.exec(`
    CREATE TABLE quiz_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quizId INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('free', 'single', 'multiple')),
      options TEXT NOT NULL DEFAULT '[]',
      correctAnswers TEXT NOT NULL DEFAULT '[]'
    )
  `);
  pre.prepare(
    'INSERT INTO users (email, passwordHash, displayName) VALUES (?, ?, ?)'
  ).run('owner@x.io', 'hash', 'Owner');
  pre.prepare('INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)').run(1, 'Old');
  pre.prepare(
    'INSERT INTO quiz_questions (quizId, position, prompt, type) VALUES (?, ?, ?, ?)'
  ).run(1, 1, 'old?', 'free');
  pre.close();

  const db = await importDbWith(dir);
  const cols = db.prepare('PRAGMA table_info(quiz_questions)').all().map(c => c.name);
  assert.ok(cols.includes('categoryId'), 'categoryId column added');

  const q = db.prepare('SELECT prompt, categoryId FROM quiz_questions WHERE position = 1').get();
  assert.equal(q.prompt, 'old?');
  assert.equal(q.categoryId, null);
});

test('db.js: re-importing on an already-migrated DB is idempotent', async () => {
  const dir = freshDir();
  const first = await importDbWith(dir);
  // Force a row through to confirm persistence across re-imports.
  first.prepare(
    'INSERT INTO users (email, passwordHash, displayName) VALUES (?, ?, ?)'
  ).run('persist@x.io', 'h', 'P');

  const second = await importDbWith(dir);
  const row = second.prepare('SELECT email FROM users WHERE email = ?').get('persist@x.io');
  assert.equal(row.email, 'persist@x.io');
  // No extra columns added on the second pass — the migrations are guarded.
  const userCols = second.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  assert.equal(userCols.filter(c => c === 'isAdmin').length, 1);
});
