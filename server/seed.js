import { readFileSync } from 'fs';
import db from './db.js';

const VOCAB_PATH = new URL('./seeds/spanish-vocab.json', import.meta.url).pathname;
const CHESS_PATH = new URL('./seeds/chess-puzzles.json', import.meta.url).pathname;

const REWARD_MAP = { easy: 1, medium: 2, hard: 5 };
const CHESS_REWARD_MAP = { easy: 2, medium: 5, hard: 10 };

export function seedSpanishVocab() {
  const existing = db.prepare(
    "SELECT COUNT(*) as count FROM challenges WHERE categorySlug = 'spanish-vocab'"
  ).get();

  if (existing.count > 0) return;

  const words = JSON.parse(readFileSync(VOCAB_PATH, 'utf-8'));

  const insert = db.prepare(`
    INSERT INTO challenges (categorySlug, type, difficulty, prompt, data, answer, chesnutReward)
    VALUES (?, 'question', ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((words) => {
    for (const w of words) {
      // Type 1: English → Spanish ("What is the Spanish word for ___?")
      insert.run(
        'spanish-vocab',
        w.difficulty,
        `What is the Spanish word for "${w.english}"?`,
        JSON.stringify({ english: w.english, spanish: w.spanish }),
        w.spanish,
        REWARD_MAP[w.difficulty]
      );
      // Type 2: Spanish → English ("What does ___ mean in English?")
      insert.run(
        'spanish-vocab',
        w.difficulty,
        `What does "${w.spanish}" mean in English?`,
        JSON.stringify({ english: w.english, spanish: w.spanish }),
        w.english,
        REWARD_MAP[w.difficulty]
      );
    }
  });

  insertMany(words);
  console.log(`Seeded ${words.length * 2} Spanish vocab challenges`);
}

export function seedChessPuzzles() {
  const existing = db.prepare(
    "SELECT COUNT(*) as count FROM challenges WHERE categorySlug = 'chess-puzzles'"
  ).get();

  if (existing.count > 0) return;

  const puzzles = JSON.parse(readFileSync(CHESS_PATH, 'utf-8'));

  const insert = db.prepare(`
    INSERT INTO challenges (categorySlug, type, difficulty, prompt, data, answer, chesnutReward)
    VALUES (?, 'puzzle', ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((puzzles) => {
    for (const p of puzzles) {
      insert.run(
        'chess-puzzles',
        p.difficulty,
        `${p.theme}: Find the winning move`,
        JSON.stringify({ fen: p.fen }),
        p.solution,
        CHESS_REWARD_MAP[p.difficulty]
      );
    }
  });

  insertMany(puzzles);
  console.log(`Seeded ${puzzles.length} chess puzzles`);
}

export function seedRewards() {
  const existing = db.prepare('SELECT COUNT(*) as count FROM rewards').get();
  if (existing.count > 0) return;

  const rewards = [
    { name: '10 minutes of screen time', description: 'Redeem for 10 minutes of screen time', cost: 10 },
    { name: '$1', description: 'Redeem for one dollar', cost: 20 },
    { name: 'Car ride to a friend\'s house', description: 'Get a ride to visit a friend', cost: 50 },
    { name: 'Day trip', description: 'Earn a fun day trip adventure', cost: 200 },
  ];

  const insert = db.prepare(
    'INSERT INTO rewards (name, description, chesnutCost) VALUES (?, ?, ?)'
  );

  const insertMany = db.transaction((rewards) => {
    for (const r of rewards) insert.run(r.name, r.description, r.cost);
  });

  insertMany(rewards);
  console.log(`Seeded ${rewards.length} rewards`);
}

// Run seeds on import
seedSpanishVocab();
seedChessPuzzles();
seedRewards();
