import { Router } from 'express';
import db from '../db.js';

const router = Router();

const MAX_NAME_LEN = 80;
const MAX_PROMPT_LEN = 500;
const MAX_OPTION_LEN = 200;
const MAX_OPTIONS = 10;

function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function loadQuestionRow(row) {
  return {
    id: row.id,
    quizId: row.quizId,
    position: row.position,
    prompt: row.prompt,
    type: row.type,
    options: JSON.parse(row.options || '[]'),
    correctAnswers: JSON.parse(row.correctAnswers || '[]'),
  };
}

function getQuiz(quizId, userId) {
  const quiz = db.prepare(
    'SELECT id, ownerUserId, name, createdAt FROM quizzes WHERE id = ?'
  ).get(quizId);
  if (!quiz) return null;
  if (userId != null && quiz.ownerUserId !== userId) return 'forbidden';
  return quiz;
}

function loadQuizWithQuestions(quizId) {
  const quiz = db.prepare(
    'SELECT id, ownerUserId, name, createdAt FROM quizzes WHERE id = ?'
  ).get(quizId);
  if (!quiz) return null;
  const questionRows = db.prepare(
    'SELECT id, quizId, position, prompt, type, options, correctAnswers FROM quiz_questions WHERE quizId = ? ORDER BY position ASC, id ASC'
  ).all(quizId);
  return {
    ...quiz,
    questions: questionRows.map(loadQuestionRow),
  };
}

function validateQuestionPayload(body) {
  const { prompt, type, options, correctAnswers } = body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return 'Prompt is required';
  }
  if (prompt.length > MAX_PROMPT_LEN) {
    return `Prompt too long (max ${MAX_PROMPT_LEN} chars)`;
  }
  if (!['free', 'single', 'multiple'].includes(type)) {
    return 'type must be one of: free, single, multiple';
  }

  if (type === 'free') {
    if (!Array.isArray(correctAnswers) || correctAnswers.length === 0) {
      return 'Free-type questions need at least one accepted answer';
    }
    for (const a of correctAnswers) {
      if (typeof a !== 'string' || !a.trim()) return 'Accepted answers must be non-empty strings';
      if (a.length > MAX_OPTION_LEN) return `Answer too long (max ${MAX_OPTION_LEN} chars)`;
    }
    return null;
  }

  // single / multiple
  if (!Array.isArray(options) || options.length < 2) {
    return 'Choice questions need at least 2 options';
  }
  if (options.length > MAX_OPTIONS) {
    return `Too many options (max ${MAX_OPTIONS})`;
  }
  for (const o of options) {
    if (typeof o !== 'string' || !o.trim()) return 'Options must be non-empty strings';
    if (o.length > MAX_OPTION_LEN) return `Option too long (max ${MAX_OPTION_LEN} chars)`;
  }
  if (!Array.isArray(correctAnswers) || correctAnswers.length === 0) {
    return 'Mark at least one correct option';
  }
  for (const idx of correctAnswers) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
      return 'Correct answer indices must reference a valid option';
    }
  }
  if (type === 'single' && correctAnswers.length !== 1) {
    return 'Single-choice questions must have exactly one correct option';
  }
  return null;
}

function normalizeQuestionPayload(body) {
  const { prompt, type } = body;
  if (type === 'free') {
    return {
      prompt: prompt.trim(),
      type,
      options: [],
      correctAnswers: body.correctAnswers.map(a => a.trim()).filter(Boolean),
    };
  }
  return {
    prompt: prompt.trim(),
    type,
    options: body.options.map(o => o.trim()),
    correctAnswers: [...body.correctAnswers].sort((a, b) => a - b),
  };
}

// List quizzes for current user (with question counts)
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT q.id, q.name, q.createdAt,
           (SELECT COUNT(*) FROM quiz_questions WHERE quizId = q.id) AS questionCount
    FROM quizzes q
    WHERE q.ownerUserId = ?
    ORDER BY q.createdAt DESC, q.id DESC
  `).all(req.session.userId);
  res.json({ quizzes: rows });
});

// Create a new quiz
router.post('/', requireAuth, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Quiz name is required' });
  if (name.length > MAX_NAME_LEN) {
    return res.status(400).json({ error: `Name too long (max ${MAX_NAME_LEN})` });
  }
  const result = db.prepare(
    'INSERT INTO quizzes (ownerUserId, name) VALUES (?, ?)'
  ).run(req.session.userId, name);
  res.status(201).json({ quiz: loadQuizWithQuestions(result.lastInsertRowid) });
});

// Get one quiz with its questions
router.get('/:id', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = getQuiz(quizId, req.session.userId);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });
  res.json({ quiz: loadQuizWithQuestions(quizId) });
});

// Rename a quiz
router.patch('/:id', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = getQuiz(quizId, req.session.userId);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (name.length > MAX_NAME_LEN) {
    return res.status(400).json({ error: `Name too long (max ${MAX_NAME_LEN})` });
  }
  db.prepare('UPDATE quizzes SET name = ? WHERE id = ?').run(name, quizId);
  res.json({ quiz: loadQuizWithQuestions(quizId) });
});

// Delete a quiz (cascades questions)
router.delete('/:id', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = getQuiz(quizId, req.session.userId);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });
  db.prepare('DELETE FROM quizzes WHERE id = ?').run(quizId);
  res.json({ ok: true });
});

// Add a question to a quiz
router.post('/:id/questions', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = getQuiz(quizId, req.session.userId);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });

  const err = validateQuestionPayload(req.body);
  if (err) return res.status(400).json({ error: err });
  const data = normalizeQuestionPayload(req.body);

  const maxPos = db.prepare(
    'SELECT COALESCE(MAX(position), 0) AS m FROM quiz_questions WHERE quizId = ?'
  ).get(quizId).m;

  const result = db.prepare(`
    INSERT INTO quiz_questions (quizId, position, prompt, type, options, correctAnswers)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    quizId,
    maxPos + 1,
    data.prompt,
    data.type,
    JSON.stringify(data.options),
    JSON.stringify(data.correctAnswers),
  );

  const row = db.prepare(
    'SELECT id, quizId, position, prompt, type, options, correctAnswers FROM quiz_questions WHERE id = ?'
  ).get(result.lastInsertRowid);

  res.status(201).json({ question: loadQuestionRow(row) });
});

// Reorder all questions in one shot. Body: { order: [questionId, questionId, ...] }
// Defined before /:id/questions/:qid so the literal "reorder" segment doesn't
// get parsed as a question id.
router.patch('/:id/questions/reorder', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = getQuiz(quizId, req.session.userId);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });

  const order = req.body?.order;
  if (!Array.isArray(order) || order.some(id => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'order must be an array of question IDs' });
  }

  const existing = db.prepare(
    'SELECT id FROM quiz_questions WHERE quizId = ?'
  ).all(quizId).map(r => r.id);

  if (order.length !== existing.length || !order.every(id => existing.includes(id))) {
    return res.status(400).json({ error: 'order must include every question exactly once' });
  }

  const update = db.prepare(
    'UPDATE quiz_questions SET position = ? WHERE id = ? AND quizId = ?'
  );
  const tx = db.transaction((ids) => {
    ids.forEach((id, i) => update.run(i + 1, id, quizId));
  });
  tx(order);

  res.json({ quiz: loadQuizWithQuestions(quizId) });
});

// Update a question
router.patch('/:id/questions/:qid', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const qId = Number(req.params.qid);
  const quiz = getQuiz(quizId, req.session.userId);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });

  const existing = db.prepare(
    'SELECT id FROM quiz_questions WHERE id = ? AND quizId = ?'
  ).get(qId, quizId);
  if (!existing) return res.status(404).json({ error: 'Question not found' });

  const err = validateQuestionPayload(req.body);
  if (err) return res.status(400).json({ error: err });
  const data = normalizeQuestionPayload(req.body);

  db.prepare(`
    UPDATE quiz_questions
    SET prompt = ?, type = ?, options = ?, correctAnswers = ?
    WHERE id = ?
  `).run(
    data.prompt,
    data.type,
    JSON.stringify(data.options),
    JSON.stringify(data.correctAnswers),
    qId,
  );

  const row = db.prepare(
    'SELECT id, quizId, position, prompt, type, options, correctAnswers FROM quiz_questions WHERE id = ?'
  ).get(qId);
  res.json({ question: loadQuestionRow(row) });
});

// Delete a question
router.delete('/:id/questions/:qid', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const qId = Number(req.params.qid);
  const quiz = getQuiz(quizId, req.session.userId);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });

  db.prepare('DELETE FROM quiz_questions WHERE id = ? AND quizId = ?').run(qId, quizId);
  res.json({ ok: true });
});

export default router;
export { loadQuizWithQuestions };
