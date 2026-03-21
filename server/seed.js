import { readFileSync } from 'fs';
import db from './db.js';

const VOCAB_PATH = new URL('./seeds/spanish-vocab.json', import.meta.url).pathname;

const REWARD_MAP = { easy: 1, medium: 2, hard: 5 };

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

// Run seed on import
seedSpanishVocab();
