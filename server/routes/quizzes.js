import { Router } from 'express';
import db from '../db.js';

const router = Router();

const MAX_NAME_LEN = 80;
const MAX_CATEGORY_NAME_LEN = 60;
const MAX_PROMPT_LEN = 500;
const MAX_OPTION_LEN = 200;
const MAX_OPTIONS = 10;

function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// True when the current session belongs to an active admin user. Cached on
// the request so admin-overridden routes only hit the DB once per request.
function isAdminSession(req) {
  if (!req.session?.userId) return false;
  if (req._isAdminCache !== undefined) return req._isAdminCache;
  const u = db.prepare('SELECT isAdmin, disabledAt FROM users WHERE id = ?')
    .get(req.session.userId);
  const isAdmin = !!u && !u.disabledAt && !!u.isAdmin;
  req._isAdminCache = isAdmin;
  return isAdmin;
}

function loadQuestionRow(row) {
  return {
    id: row.id,
    quizId: row.quizId,
    categoryId: row.categoryId ?? null,
    position: row.position,
    prompt: row.prompt,
    type: row.type,
    options: JSON.parse(row.options || '[]'),
    correctAnswers: JSON.parse(row.correctAnswers || '[]'),
  };
}

function loadCategoryRow(row) {
  return {
    id: row.id,
    quizId: row.quizId,
    position: row.position,
    name: row.name,
  };
}

// Look up a quiz and enforce access. Admins bypass the owner check so they
// can manage any quiz from the admin console.
function getQuiz(quizId, req) {
  const quiz = db.prepare(
    'SELECT id, ownerUserId, name, archivedAt, createdAt FROM quizzes WHERE id = ?'
  ).get(quizId);
  if (!quiz) return null;
  if (isAdminSession(req)) return quiz;
  if (quiz.ownerUserId !== req.session.userId) return 'forbidden';
  return quiz;
}

function loadQuizWithQuestions(quizId) {
  const quiz = db.prepare(
    'SELECT id, ownerUserId, name, archivedAt, createdAt FROM quizzes WHERE id = ?'
  ).get(quizId);
  if (!quiz) return null;

  const categoryRows = db.prepare(
    'SELECT id, quizId, position, name FROM quiz_categories WHERE quizId = ? ORDER BY position ASC, id ASC'
  ).all(quizId);

  // Order questions by their category's position (uncategorized last),
  // then by question position within the category.
  const questionRows = db.prepare(`
    SELECT q.id, q.quizId, q.categoryId, q.position, q.prompt, q.type, q.options, q.correctAnswers
    FROM quiz_questions q
    LEFT JOIN quiz_categories c ON c.id = q.categoryId
    WHERE q.quizId = ?
    ORDER BY
      CASE WHEN q.categoryId IS NULL THEN 1 ELSE 0 END ASC,
      c.position ASC,
      q.position ASC,
      q.id ASC
  `).all(quizId);

  return {
    ...quiz,
    categories: categoryRows.map(loadCategoryRow),
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

// List quizzes for current user (with question counts). Archived quizzes are
// hidden — they can only be restored from the admin console.
// Admins see every owner's non-archived quizzes here, mirroring the per-route
// override in getQuiz(). This is what lets an admin who hasn't authored any
// quizzes still pick one when hosting a game (TRI-102).
router.get('/', requireAuth, (req, res) => {
  const rows = isAdminSession(req)
    ? db.prepare(`
        SELECT q.id, q.name, q.createdAt,
               (SELECT COUNT(*) FROM quiz_questions WHERE quizId = q.id) AS questionCount
        FROM quizzes q
        WHERE q.archivedAt IS NULL
        ORDER BY q.createdAt DESC, q.id DESC
      `).all()
    : db.prepare(`
        SELECT q.id, q.name, q.createdAt,
               (SELECT COUNT(*) FROM quiz_questions WHERE quizId = q.id) AS questionCount
        FROM quizzes q
        WHERE q.ownerUserId = ? AND q.archivedAt IS NULL
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
  const quiz = getQuiz(quizId, req);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });
  res.json({ quiz: loadQuizWithQuestions(quizId) });
});

// Rename a quiz
router.patch('/:id', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = getQuiz(quizId, req);
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
  const quiz = getQuiz(quizId, req);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });
  db.prepare('DELETE FROM quizzes WHERE id = ?').run(quizId);
  res.json({ ok: true });
});

// Resolve and validate a categoryId on a question payload. Returns
// { error } on bad input, or { categoryId } (which may be null).
function resolveQuestionCategoryId(quizId, body) {
  if (body == null || body.categoryId === undefined) {
    return { categoryId: null };
  }
  if (body.categoryId === null) return { categoryId: null };
  const cid = Number(body.categoryId);
  if (!Number.isInteger(cid)) return { error: 'categoryId must be an integer or null' };
  const found = db.prepare(
    'SELECT id FROM quiz_categories WHERE id = ? AND quizId = ?'
  ).get(cid, quizId);
  if (!found) return { error: 'Category not found in this quiz' };
  return { categoryId: cid };
}

// ── Categories ─────────────────────────────────────────

// List categories for a quiz
router.get('/:id/categories', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = getQuiz(quizId, req);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });

  const rows = db.prepare(
    'SELECT id, quizId, position, name FROM quiz_categories WHERE quizId = ? ORDER BY position ASC, id ASC'
  ).all(quizId);
  res.json({ categories: rows.map(loadCategoryRow) });
});

// Create a category
router.post('/:id/categories', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = getQuiz(quizId, req);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });

  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  if (name.length > MAX_CATEGORY_NAME_LEN) {
    return res.status(400).json({ error: `Name too long (max ${MAX_CATEGORY_NAME_LEN})` });
  }

  const maxPos = db.prepare(
    'SELECT COALESCE(MAX(position), 0) AS m FROM quiz_categories WHERE quizId = ?'
  ).get(quizId).m;

  const result = db.prepare(
    'INSERT INTO quiz_categories (quizId, position, name) VALUES (?, ?, ?)'
  ).run(quizId, maxPos + 1, name);

  const row = db.prepare(
    'SELECT id, quizId, position, name FROM quiz_categories WHERE id = ?'
  ).get(result.lastInsertRowid);
  res.status(201).json({ category: loadCategoryRow(row) });
});

// Reorder categories. Body: { order: [categoryId, ...] }. Defined before
// the /:cid routes so "reorder" is not parsed as a category id.
router.patch('/:id/categories/reorder', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = getQuiz(quizId, req);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });

  const order = req.body?.order;
  if (!Array.isArray(order) || order.some(id => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'order must be an array of category IDs' });
  }

  const existing = db.prepare(
    'SELECT id FROM quiz_categories WHERE quizId = ?'
  ).all(quizId).map(r => r.id);

  if (order.length !== existing.length || !order.every(id => existing.includes(id))) {
    return res.status(400).json({ error: 'order must include every category exactly once' });
  }

  const update = db.prepare(
    'UPDATE quiz_categories SET position = ? WHERE id = ? AND quizId = ?'
  );
  const tx = db.transaction((ids) => {
    ids.forEach((id, i) => update.run(i + 1, id, quizId));
  });
  tx(order);

  res.json({ quiz: loadQuizWithQuestions(quizId) });
});

// Rename a category
router.patch('/:id/categories/:cid', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const cId = Number(req.params.cid);
  const quiz = getQuiz(quizId, req);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });

  const existing = db.prepare(
    'SELECT id FROM quiz_categories WHERE id = ? AND quizId = ?'
  ).get(cId, quizId);
  if (!existing) return res.status(404).json({ error: 'Category not found' });

  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (name.length > MAX_CATEGORY_NAME_LEN) {
    return res.status(400).json({ error: `Name too long (max ${MAX_CATEGORY_NAME_LEN})` });
  }
  db.prepare('UPDATE quiz_categories SET name = ? WHERE id = ?').run(name, cId);

  const row = db.prepare(
    'SELECT id, quizId, position, name FROM quiz_categories WHERE id = ?'
  ).get(cId);
  res.json({ category: loadCategoryRow(row) });
});

// Delete a category. Questions in it become uncategorized (FK ON DELETE
// SET NULL).
router.delete('/:id/categories/:cid', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const cId = Number(req.params.cid);
  const quiz = getQuiz(quizId, req);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });

  const existing = db.prepare(
    'SELECT id FROM quiz_categories WHERE id = ? AND quizId = ?'
  ).get(cId, quizId);
  if (!existing) return res.status(404).json({ error: 'Category not found' });

  db.prepare('DELETE FROM quiz_categories WHERE id = ?').run(cId);
  res.json({ ok: true });
});

// ── Questions ──────────────────────────────────────────

// Add a question to a quiz
router.post('/:id/questions', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = getQuiz(quizId, req);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });

  const err = validateQuestionPayload(req.body);
  if (err) return res.status(400).json({ error: err });
  const data = normalizeQuestionPayload(req.body);
  const cat = resolveQuestionCategoryId(quizId, req.body);
  if (cat.error) return res.status(400).json({ error: cat.error });

  const maxPos = db.prepare(
    'SELECT COALESCE(MAX(position), 0) AS m FROM quiz_questions WHERE quizId = ?'
  ).get(quizId).m;

  const result = db.prepare(`
    INSERT INTO quiz_questions (quizId, categoryId, position, prompt, type, options, correctAnswers)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    quizId,
    cat.categoryId,
    maxPos + 1,
    data.prompt,
    data.type,
    JSON.stringify(data.options),
    JSON.stringify(data.correctAnswers),
  );

  const row = db.prepare(
    'SELECT id, quizId, categoryId, position, prompt, type, options, correctAnswers FROM quiz_questions WHERE id = ?'
  ).get(result.lastInsertRowid);

  res.status(201).json({ question: loadQuestionRow(row) });
});

// Reorder all questions in one shot. Body: { order: [questionId, questionId, ...] }
// Defined before /:id/questions/:qid so the literal "reorder" segment doesn't
// get parsed as a question id.
router.patch('/:id/questions/reorder', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = getQuiz(quizId, req);
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
  const quiz = getQuiz(quizId, req);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });

  const existing = db.prepare(
    'SELECT id FROM quiz_questions WHERE id = ? AND quizId = ?'
  ).get(qId, quizId);
  if (!existing) return res.status(404).json({ error: 'Question not found' });

  const err = validateQuestionPayload(req.body);
  if (err) return res.status(400).json({ error: err });
  const data = normalizeQuestionPayload(req.body);
  const cat = resolveQuestionCategoryId(quizId, req.body);
  if (cat.error) return res.status(400).json({ error: cat.error });

  db.prepare(`
    UPDATE quiz_questions
    SET categoryId = ?, prompt = ?, type = ?, options = ?, correctAnswers = ?
    WHERE id = ?
  `).run(
    cat.categoryId,
    data.prompt,
    data.type,
    JSON.stringify(data.options),
    JSON.stringify(data.correctAnswers),
    qId,
  );

  const row = db.prepare(
    'SELECT id, quizId, categoryId, position, prompt, type, options, correctAnswers FROM quiz_questions WHERE id = ?'
  ).get(qId);
  res.json({ question: loadQuestionRow(row) });
});

// Delete a question
router.delete('/:id/questions/:qid', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const qId = Number(req.params.qid);
  const quiz = getQuiz(quizId, req);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (quiz === 'forbidden') return res.status(403).json({ error: 'Not your quiz' });

  db.prepare('DELETE FROM quiz_questions WHERE id = ? AND quizId = ?').run(qId, quizId);
  res.json({ ok: true });
});

export default router;
export { loadQuizWithQuestions };
