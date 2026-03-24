import { Router } from 'express';
import db from '../db.js';

const router = Router();

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// Simple in-memory rate limiter for answer submissions
const answerAttempts = new Map(); // userId -> { count, resetAt }
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30; // max 30 answers per minute

function rateLimitAnswers(req, res, next) {
  const userId = req.session.userId;
  const now = Date.now();
  let bucket = answerAttempts.get(userId);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    answerAttempts.set(userId, bucket);
  }

  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a moment.' });
  }
  next();
}

// GET /categories — list available categories
router.get('/categories', requireAuth, (req, res) => {
  const categories = db.prepare(`
    SELECT categorySlug, COUNT(*) as totalChallenges,
           MIN(difficulty) as minDifficulty
    FROM challenges
    GROUP BY categorySlug
  `).all();

  const result = categories.map(c => ({
    slug: c.categorySlug,
    name: formatCategoryName(c.categorySlug),
    totalChallenges: c.totalChallenges,
  }));

  res.json({ categories: result });
});

// GET /next?category=spanish-vocab — get next challenge
// Never sends the answer to the client
router.get('/next', requireAuth, (req, res) => {
  const { category } = req.query;
  if (!category) {
    return res.status(400).json({ error: 'Category is required' });
  }

  const userId = req.session.userId;

  // Pick a random challenge the user hasn't answered recently,
  // falling back to any challenge if they've answered them all
  let challenge = db.prepare(`
    SELECT c.id, c.categorySlug, c.type, c.difficulty, c.prompt, c.chesnutReward
    FROM challenges c
    WHERE c.categorySlug = ?
      AND c.id NOT IN (
        SELECT challengeId FROM attempt_history
        WHERE userId = ?
        ORDER BY answeredAt DESC
        LIMIT 50
      )
    ORDER BY RANDOM()
    LIMIT 1
  `).get(category, userId);

  if (!challenge) {
    // User has seen most challenges — pick any random one
    challenge = db.prepare(`
      SELECT id, categorySlug, type, difficulty, prompt, chesnutReward
      FROM challenges
      WHERE categorySlug = ?
      ORDER BY RANDOM()
      LIMIT 1
    `).get(category);
  }

  if (!challenge) {
    return res.status(404).json({ error: 'No challenges found for this category' });
  }

  // For puzzle-type challenges, return board data instead of multiple-choice options
  if (challenge.type === 'puzzle') {
    const fullChallenge = db.prepare('SELECT data, answer FROM challenges WHERE id = ?').get(challenge.id);
    const data = JSON.parse(fullChallenge.data);
    const playerMoves = fullChallenge.answer.split(',');
    const puzzleResponse = {
      id: challenge.id,
      category: challenge.categorySlug,
      type: 'puzzle',
      difficulty: challenge.difficulty,
      prompt: challenge.prompt,
      reward: challenge.chesnutReward,
      fen: data.fen,
      totalPlayerMoves: playerMoves.length,
    };
    // Include opponent response moves for multi-move puzzles (not the solution!)
    if (data.opponentMoves && data.opponentMoves.length > 0) {
      puzzleResponse.opponentMoves = data.opponentMoves;
    }
    return res.json({ challenge: puzzleResponse });
  }

  // Generate multiple-choice options for question-type challenges
  const options = generateOptions(challenge.id, category);

  res.json({
    challenge: {
      id: challenge.id,
      category: challenge.categorySlug,
      type: 'question',
      difficulty: challenge.difficulty,
      prompt: challenge.prompt,
      reward: challenge.chesnutReward,
      options,
    },
  });
});

// POST /answer — submit an answer
// For multi-move puzzles, accepts moveIndex to validate one move at a time.
// When moveIndex < totalPlayerMoves - 1 and correct, returns the next opponent
// move without scoring. Scoring happens only on the final correct move.
router.post('/answer', requireAuth, rateLimitAnswers, (req, res) => {
  const { challengeId, answer, moveIndex } = req.body;
  const stepIndex = typeof moveIndex === 'number' ? moveIndex : 0;

  if (!challengeId || answer === undefined || answer === null) {
    return res.status(400).json({ error: 'challengeId and answer are required' });
  }

  const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(challengeId);
  if (!challenge) {
    return res.status(404).json({ error: 'Challenge not found' });
  }

  const solutionMoves = challenge.answer.split(',');
  const totalPlayerMoves = solutionMoves.length;
  const data = JSON.parse(challenge.data);

  // Validate the specific move
  const expectedMove = solutionMoves[stepIndex];
  const correct = answer.trim().toLowerCase() === (expectedMove || '').trim().toLowerCase();
  const isFinalMove = stepIndex >= totalPlayerMoves - 1;

  // If correct but not the final move, return intermediate result with opponent's next move
  if (correct && !isFinalMove) {
    const opponentMove = data.opponentMoves ? data.opponentMoves[stepIndex] : null;
    return res.json({
      correct: true,
      completed: false,
      opponentMove,
      nextMoveIndex: stepIndex + 1,
      totalPlayerMoves,
    });
  }

  // Final move (correct or wrong) — score the attempt
  const userId = req.session.userId;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  let chesnutsEarned = 0;
  let newStreak = user.currentStreak;
  let streakBonus = 0;

  if (correct) {
    chesnutsEarned = challenge.chesnutReward;
    newStreak = user.currentStreak + 1;

    // Streak bonuses
    if (newStreak % 10 === 0) {
      streakBonus = 5;
    } else if (newStreak % 5 === 0) {
      streakBonus = 3;
    }
    chesnutsEarned += streakBonus;
  } else {
    newStreak = 0; // Reset streak on wrong answer
  }

  const bestStreak = Math.max(user.bestStreak, newStreak);

  // Update everything in a transaction
  const applyResult = db.transaction(() => {
    // Record attempt
    db.prepare(`
      INSERT INTO attempt_history (userId, challengeId, correct, chesnutsEarned)
      VALUES (?, ?, ?, ?)
    `).run(userId, challengeId, correct ? 1 : 0, chesnutsEarned);

    // Update user stats
    db.prepare(`
      UPDATE users
      SET chesnutBalance = chesnutBalance + ?,
          currentStreak = ?,
          bestStreak = ?
      WHERE id = ?
    `).run(chesnutsEarned, newStreak, bestStreak, userId);

    return db.prepare(
      'SELECT id, email, displayName, chesnutBalance, currentStreak, bestStreak FROM users WHERE id = ?'
    ).get(userId);
  });

  const updatedUser = applyResult();

  res.json({
    correct,
    completed: true,
    correctAnswer: challenge.answer,
    chesnutsEarned,
    streakBonus,
    streak: newStreak,
    user: updatedUser,
  });
});

// GET /history — get attempt history for current user
router.get('/history', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  const attempts = db.prepare(`
    SELECT ah.id, ah.correct, ah.chesnutsEarned, ah.answeredAt,
           c.categorySlug, c.difficulty, c.prompt
    FROM attempt_history ah
    JOIN challenges c ON c.id = ah.challengeId
    WHERE ah.userId = ?
    ORDER BY ah.answeredAt DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset);

  const stats = db.prepare(`
    SELECT
      COUNT(*) as totalAttempts,
      SUM(correct) as totalCorrect,
      SUM(chesnutsEarned) as totalEarned
    FROM attempt_history
    WHERE userId = ?
  `).get(userId);

  res.json({ attempts, stats });
});

// Generate 4 multiple-choice options including the correct answer
function generateOptions(challengeId, category) {
  const correct = db.prepare('SELECT answer FROM challenges WHERE id = ?').get(challengeId);

  // Get 3 random wrong answers from same category with same answer type
  // (if prompt asks for Spanish word, options should be Spanish words)
  const challenge = db.prepare('SELECT prompt, data FROM challenges WHERE id = ?').get(challengeId);
  const data = JSON.parse(challenge.data);

  // Determine if we need Spanish or English options based on the prompt
  const needsSpanish = challenge.prompt.includes('Spanish word for');
  const field = needsSpanish ? 'spanish' : 'english';

  const distractors = db.prepare(`
    SELECT DISTINCT json_extract(data, '$.${field}') as option
    FROM challenges
    WHERE categorySlug = ? AND id != ?
    ORDER BY RANDOM()
    LIMIT 3
  `).all(category, challengeId);

  const options = [correct.answer, ...distractors.map(d => d.option)];

  // Shuffle options (Fisher-Yates)
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }

  return options;
}

function formatCategoryName(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export default router;
