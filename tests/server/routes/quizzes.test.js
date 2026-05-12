import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { freshDataDir } from '../helpers/db.js';
import { makeApp, startServer } from '../helpers/http.js';

freshDataDir();

const { default: db } = await import('../../../server/db.js');
const { default: quizzesRouter } = await import('../../../server/routes/quizzes.js');

let server;
let request;
let session;

let ownerId;
let otherId;

before(async () => {
  const { app, session: s } = makeApp(quizzesRouter, '/api/quizzes');
  session = s;
  const handle = await startServer(app);
  request = handle.request;
  server = handle;
});

beforeEach(() => {
  for (const k of Object.keys(session)) delete session[k];
  db.exec('DELETE FROM quiz_questions');
  db.exec('DELETE FROM quiz_categories');
  db.exec('DELETE FROM quizzes');
  db.exec('DELETE FROM users');

  ownerId = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName) VALUES (?, ?, ?)'
  ).run('owner@x.io', 'h', 'Owner').lastInsertRowid;
  otherId = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName) VALUES (?, ?, ?)'
  ).run('other@x.io', 'h', 'Other').lastInsertRowid;
});

after(async () => {
  await server.close();
});

function asOwner() { session.userId = ownerId; }
function asOther() { session.userId = otherId; }

async function createQuiz(name = 'My Quiz') {
  asOwner();
  const res = await request('POST', '/api/quizzes', { name });
  assert.equal(res.status, 201);
  return res.body.quiz;
}

// ── Auth gate ──────────────────────────────────────────

test('all routes require auth — GET /api/quizzes 401 without session', async () => {
  const res = await request('GET', '/api/quizzes');
  assert.equal(res.status, 401);
});

// ── List ───────────────────────────────────────────────

test('GET /api/quizzes lists only the caller\'s quizzes with question counts', async () => {
  asOwner();
  await request('POST', '/api/quizzes', { name: 'Mine A' });
  await request('POST', '/api/quizzes', { name: 'Mine B' });
  asOther();
  await request('POST', '/api/quizzes', { name: 'Theirs' });
  asOwner();
  const res = await request('GET', '/api/quizzes');
  assert.equal(res.status, 200);
  assert.equal(res.body.quizzes.length, 2);
  assert.ok(res.body.quizzes.every(q => typeof q.questionCount === 'number'));
});

test('GET /api/quizzes hides archived quizzes from owners (TRI-81)', async () => {
  asOwner();
  const live = await request('POST', '/api/quizzes', { name: 'Live Quiz' });
  await request('POST', '/api/quizzes', { name: 'Archived Quiz' });
  db.prepare("UPDATE quizzes SET archivedAt = datetime('now') WHERE name = ?")
    .run('Archived Quiz');

  const res = await request('GET', '/api/quizzes');
  assert.equal(res.status, 200);
  assert.equal(res.body.quizzes.length, 1);
  assert.equal(res.body.quizzes[0].id, live.body.quiz.id);
});

// ── Create ─────────────────────────────────────────────

test('POST /api/quizzes creates a quiz and returns it with empty questions/categories', async () => {
  asOwner();
  const res = await request('POST', '/api/quizzes', { name: '  Trivia  ' });
  assert.equal(res.status, 201);
  assert.equal(res.body.quiz.name, 'Trivia');
  assert.deepEqual(res.body.quiz.questions, []);
  assert.deepEqual(res.body.quiz.categories, []);
});

test('POST /api/quizzes 400 when name missing', async () => {
  asOwner();
  const res = await request('POST', '/api/quizzes', { name: '   ' });
  assert.equal(res.status, 400);
});

test('POST /api/quizzes 400 when name too long', async () => {
  asOwner();
  const res = await request('POST', '/api/quizzes', { name: 'x'.repeat(81) });
  assert.equal(res.status, 400);
});

// ── Get one ────────────────────────────────────────────

test('GET /api/quizzes/:id returns the quiz with questions', async () => {
  const quiz = await createQuiz();
  const res = await request('GET', `/api/quizzes/${quiz.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.quiz.id, quiz.id);
});

test('GET /api/quizzes/:id 404 when missing', async () => {
  asOwner();
  const res = await request('GET', '/api/quizzes/99999');
  assert.equal(res.status, 404);
});

test('GET /api/quizzes/:id 403 when caller is not the owner', async () => {
  const quiz = await createQuiz();
  asOther();
  const res = await request('GET', `/api/quizzes/${quiz.id}`);
  assert.equal(res.status, 403);
});

// ── Rename ─────────────────────────────────────────────

test('PATCH /api/quizzes/:id renames the quiz', async () => {
  const quiz = await createQuiz('Old');
  const res = await request('PATCH', `/api/quizzes/${quiz.id}`, { name: 'New' });
  assert.equal(res.status, 200);
  assert.equal(res.body.quiz.name, 'New');
});

test('PATCH /api/quizzes/:id 400 when new name empty', async () => {
  const quiz = await createQuiz();
  const res = await request('PATCH', `/api/quizzes/${quiz.id}`, { name: '' });
  assert.equal(res.status, 400);
});

test('PATCH /api/quizzes/:id 400 when new name too long', async () => {
  const quiz = await createQuiz();
  const res = await request('PATCH', `/api/quizzes/${quiz.id}`, { name: 'x'.repeat(81) });
  assert.equal(res.status, 400);
});

test('PATCH /api/quizzes/:id 404 when missing', async () => {
  asOwner();
  const res = await request('PATCH', '/api/quizzes/99999', { name: 'x' });
  assert.equal(res.status, 404);
});

test('PATCH /api/quizzes/:id 403 when not owner', async () => {
  const quiz = await createQuiz();
  asOther();
  const res = await request('PATCH', `/api/quizzes/${quiz.id}`, { name: 'X' });
  assert.equal(res.status, 403);
});

// ── Delete ─────────────────────────────────────────────

test('DELETE /api/quizzes/:id removes the quiz row', async () => {
  const quiz = await createQuiz();
  const res = await request('DELETE', `/api/quizzes/${quiz.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  const row = db.prepare('SELECT id FROM quizzes WHERE id = ?').get(quiz.id);
  assert.equal(row, undefined);
});

test('DELETE /api/quizzes/:id 404 missing, 403 not owner', async () => {
  asOwner();
  const a = await request('DELETE', '/api/quizzes/99999');
  assert.equal(a.status, 404);

  const quiz = await createQuiz();
  asOther();
  const b = await request('DELETE', `/api/quizzes/${quiz.id}`);
  assert.equal(b.status, 403);
});

// ── Categories ─────────────────────────────────────────

test('GET /api/quizzes/:id/categories starts empty', async () => {
  const quiz = await createQuiz();
  const res = await request('GET', `/api/quizzes/${quiz.id}/categories`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.categories, []);
});

test('GET /api/quizzes/:id/categories 404 unknown quiz, 403 not owner', async () => {
  asOwner();
  const a = await request('GET', '/api/quizzes/99999/categories');
  assert.equal(a.status, 404);

  const quiz = await createQuiz();
  asOther();
  const b = await request('GET', `/api/quizzes/${quiz.id}/categories`);
  assert.equal(b.status, 403);
});

test('POST /api/quizzes/:id/categories creates a category with auto position', async () => {
  const quiz = await createQuiz();
  const r1 = await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'A' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.category.position, 1);
  const r2 = await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'B' });
  assert.equal(r2.body.category.position, 2);
});

test('POST /api/quizzes/:id/categories validation', async () => {
  const quiz = await createQuiz();
  const empty = await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: '   ' });
  assert.equal(empty.status, 400);
  const long = await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'x'.repeat(61) });
  assert.equal(long.status, 400);
});

test('POST /api/quizzes/:id/categories 404 unknown quiz, 403 not owner', async () => {
  asOwner();
  const a = await request('POST', '/api/quizzes/99999/categories', { name: 'A' });
  assert.equal(a.status, 404);
  const quiz = await createQuiz();
  asOther();
  const b = await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'A' });
  assert.equal(b.status, 403);
});

test('PATCH /api/quizzes/:id/categories/reorder reorders positions', async () => {
  const quiz = await createQuiz();
  const a = (await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'A' })).body.category;
  const b = (await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'B' })).body.category;
  const c = (await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'C' })).body.category;

  const res = await request('PATCH', `/api/quizzes/${quiz.id}/categories/reorder`, {
    order: [c.id, a.id, b.id],
  });
  assert.equal(res.status, 200);
  const rows = db.prepare(
    'SELECT id, position FROM quiz_categories WHERE quizId = ? ORDER BY position'
  ).all(quiz.id);
  assert.deepEqual(rows.map(r => r.id), [c.id, a.id, b.id]);
});

test('PATCH categories/reorder 400 when order shape invalid', async () => {
  const quiz = await createQuiz();
  const r = await request('PATCH', `/api/quizzes/${quiz.id}/categories/reorder`, {
    order: 'not-an-array',
  });
  assert.equal(r.status, 400);
});

test('PATCH categories/reorder 400 when order is incomplete', async () => {
  const quiz = await createQuiz();
  const a = (await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'A' })).body.category;
  await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'B' });
  const r = await request('PATCH', `/api/quizzes/${quiz.id}/categories/reorder`, { order: [a.id] });
  assert.equal(r.status, 400);
});

test('PATCH categories/reorder: 404 quiz unknown, 403 not owner', async () => {
  asOwner();
  const a = await request('PATCH', '/api/quizzes/99999/categories/reorder', { order: [] });
  assert.equal(a.status, 404);
  const quiz = await createQuiz();
  asOther();
  const b = await request('PATCH', `/api/quizzes/${quiz.id}/categories/reorder`, { order: [] });
  assert.equal(b.status, 403);
});

test('PATCH /api/quizzes/:id/categories/:cid renames a category', async () => {
  const quiz = await createQuiz();
  const cat = (await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'Old' })).body.category;
  const res = await request('PATCH', `/api/quizzes/${quiz.id}/categories/${cat.id}`, { name: 'New' });
  assert.equal(res.status, 200);
  assert.equal(res.body.category.name, 'New');
});

test('PATCH category 404/400 paths', async () => {
  const quiz = await createQuiz();
  const a = await request('PATCH', `/api/quizzes/${quiz.id}/categories/9999`, { name: 'x' });
  assert.equal(a.status, 404);
  const cat = (await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'X' })).body.category;
  const empty = await request('PATCH', `/api/quizzes/${quiz.id}/categories/${cat.id}`, { name: '   ' });
  assert.equal(empty.status, 400);
  const long = await request('PATCH', `/api/quizzes/${quiz.id}/categories/${cat.id}`, { name: 'x'.repeat(61) });
  assert.equal(long.status, 400);
});

test('PATCH category 404 quiz unknown, 403 not owner', async () => {
  asOwner();
  const a = await request('PATCH', '/api/quizzes/99999/categories/1', { name: 'X' });
  assert.equal(a.status, 404);
  const quiz = await createQuiz();
  const cat = (await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'X' })).body.category;
  asOther();
  const b = await request('PATCH', `/api/quizzes/${quiz.id}/categories/${cat.id}`, { name: 'X' });
  assert.equal(b.status, 403);
});

test('DELETE /api/quizzes/:id/categories/:cid clears categoryId on its questions', async () => {
  const quiz = await createQuiz();
  const cat = (await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'Cat' })).body.category;
  const q = (await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q1', type: 'free', correctAnswers: ['yes'], categoryId: cat.id,
  })).body.question;

  const res = await request('DELETE', `/api/quizzes/${quiz.id}/categories/${cat.id}`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT categoryId FROM quiz_questions WHERE id = ?').get(q.id);
  assert.equal(row.categoryId, null);
});

test('DELETE category 404/403 paths', async () => {
  asOwner();
  const a = await request('DELETE', '/api/quizzes/99999/categories/1');
  assert.equal(a.status, 404);
  const quiz = await createQuiz();
  const missing = await request('DELETE', `/api/quizzes/${quiz.id}/categories/9999`);
  assert.equal(missing.status, 404);
  const cat = (await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'X' })).body.category;
  asOther();
  const b = await request('DELETE', `/api/quizzes/${quiz.id}/categories/${cat.id}`);
  assert.equal(b.status, 403);
});

// ── Questions ──────────────────────────────────────────

test('POST /api/quizzes/:id/questions inserts a free-type question', async () => {
  const quiz = await createQuiz();
  const res = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'Capital of France?',
    type: 'free',
    correctAnswers: ['Paris', 'paris'],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.question.prompt, 'Capital of France?');
  assert.deepEqual(res.body.question.correctAnswers, ['Paris', 'paris']);
});

test('POST /api/quizzes/:id/questions inserts a single-choice question', async () => {
  const quiz = await createQuiz();
  const res = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'Pick A',
    type: 'single',
    options: ['A', 'B'],
    correctAnswers: [0],
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.question.correctAnswers, [0]);
});

test('POST /api/quizzes/:id/questions inserts a multiple-choice question, sorts indices', async () => {
  const quiz = await createQuiz();
  const res = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'Pick primes',
    type: 'multiple',
    options: ['1', '2', '3', '4'],
    correctAnswers: [3, 1, 2],
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.question.correctAnswers, [1, 2, 3]);
});

test('POST /api/quizzes/:id/questions accepts categoryId', async () => {
  const quiz = await createQuiz();
  const cat = (await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'C' })).body.category;
  const res = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'free', correctAnswers: ['x'], categoryId: cat.id,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.question.categoryId, cat.id);
});

test('POST /api/quizzes/:id/questions 400 when categoryId is from another quiz', async () => {
  const quizA = await createQuiz('A');
  const quizB = await createQuiz('B');
  const catB = (await request('POST', `/api/quizzes/${quizB.id}/categories`, { name: 'B-Cat' })).body.category;
  const res = await request('POST', `/api/quizzes/${quizA.id}/questions`, {
    prompt: 'q', type: 'free', correctAnswers: ['x'], categoryId: catB.id,
  });
  assert.equal(res.status, 400);
});

test('POST /api/quizzes/:id/questions 400 when categoryId not integer', async () => {
  const quiz = await createQuiz();
  const res = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'free', correctAnswers: ['x'], categoryId: 'abc',
  });
  assert.equal(res.status, 400);
});

test('POST /api/quizzes/:id/questions accepts categoryId === null explicitly', async () => {
  const quiz = await createQuiz();
  const res = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'free', correctAnswers: ['x'], categoryId: null,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.question.categoryId, null);
});

test('POST questions: validation errors', async () => {
  const quiz = await createQuiz();
  // Missing prompt.
  let r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    type: 'free', correctAnswers: ['x'],
  });
  assert.equal(r.status, 400);
  // Prompt too long.
  r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'x'.repeat(501), type: 'free', correctAnswers: ['x'],
  });
  assert.equal(r.status, 400);
  // Bad type.
  r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'whatever', correctAnswers: ['x'],
  });
  assert.equal(r.status, 400);
  // Free with no answers.
  r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'free', correctAnswers: [],
  });
  assert.equal(r.status, 400);
  // Free with empty/whitespace answer.
  r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'free', correctAnswers: ['   '],
  });
  assert.equal(r.status, 400);
  // Free with non-string answer.
  r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'free', correctAnswers: [123],
  });
  assert.equal(r.status, 400);
  // Free with overlong answer.
  r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'free', correctAnswers: ['x'.repeat(201)],
  });
  assert.equal(r.status, 400);
  // Single with too few options.
  r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'single', options: ['a'], correctAnswers: [0],
  });
  assert.equal(r.status, 400);
  // Single with too many options.
  r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'single', options: Array.from({ length: 11 }, (_, i) => `o${i}`), correctAnswers: [0],
  });
  assert.equal(r.status, 400);
  // Single with empty option.
  r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'single', options: ['a', '   '], correctAnswers: [0],
  });
  assert.equal(r.status, 400);
  // Single with overlong option.
  r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'single', options: ['a', 'x'.repeat(201)], correctAnswers: [0],
  });
  assert.equal(r.status, 400);
  // Single with no correct answers.
  r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'single', options: ['a', 'b'], correctAnswers: [],
  });
  assert.equal(r.status, 400);
  // Single with bad index.
  r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'single', options: ['a', 'b'], correctAnswers: [5],
  });
  assert.equal(r.status, 400);
  // Single with multiple correctAnswers.
  r = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'single', options: ['a', 'b'], correctAnswers: [0, 1],
  });
  assert.equal(r.status, 400);
});

test('POST questions: 404 unknown quiz, 403 not owner', async () => {
  asOwner();
  const a = await request('POST', '/api/quizzes/99999/questions', {
    prompt: 'q', type: 'free', correctAnswers: ['x'],
  });
  assert.equal(a.status, 404);
  const quiz = await createQuiz();
  asOther();
  const b = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'free', correctAnswers: ['x'],
  });
  assert.equal(b.status, 403);
});

test('PATCH /api/quizzes/:id/questions/reorder rewrites positions', async () => {
  const quiz = await createQuiz();
  const q1 = (await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q1', type: 'free', correctAnswers: ['a'],
  })).body.question;
  const q2 = (await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q2', type: 'free', correctAnswers: ['b'],
  })).body.question;
  const q3 = (await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q3', type: 'free', correctAnswers: ['c'],
  })).body.question;

  const res = await request('PATCH', `/api/quizzes/${quiz.id}/questions/reorder`, {
    order: [q3.id, q1.id, q2.id],
  });
  assert.equal(res.status, 200);
  const rows = db.prepare(
    'SELECT id, position FROM quiz_questions WHERE quizId = ? ORDER BY position'
  ).all(quiz.id);
  assert.deepEqual(rows.map(r => r.id), [q3.id, q1.id, q2.id]);
});

test('PATCH questions/reorder 400 invalid order', async () => {
  const quiz = await createQuiz();
  let r = await request('PATCH', `/api/quizzes/${quiz.id}/questions/reorder`, { order: 'nope' });
  assert.equal(r.status, 400);
  // Incomplete list.
  await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q1', type: 'free', correctAnswers: ['a'],
  });
  await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q2', type: 'free', correctAnswers: ['b'],
  });
  r = await request('PATCH', `/api/quizzes/${quiz.id}/questions/reorder`, { order: [99999] });
  assert.equal(r.status, 400);
});

test('PATCH questions/reorder 404 quiz, 403 not owner', async () => {
  asOwner();
  const a = await request('PATCH', '/api/quizzes/99999/questions/reorder', { order: [] });
  assert.equal(a.status, 404);
  const quiz = await createQuiz();
  asOther();
  const b = await request('PATCH', `/api/quizzes/${quiz.id}/questions/reorder`, { order: [] });
  assert.equal(b.status, 403);
});

test('PATCH /api/quizzes/:id/questions/:qid updates a question', async () => {
  const quiz = await createQuiz();
  const q = (await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'old', type: 'free', correctAnswers: ['a'],
  })).body.question;
  const res = await request('PATCH', `/api/quizzes/${quiz.id}/questions/${q.id}`, {
    prompt: 'new', type: 'single', options: ['a', 'b'], correctAnswers: [1],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.question.prompt, 'new');
  assert.deepEqual(res.body.question.correctAnswers, [1]);
});

test('PATCH question 404 unknown quiz/question, 403 not owner, 400 invalid', async () => {
  asOwner();
  const a = await request('PATCH', '/api/quizzes/99999/questions/1', {
    prompt: 'q', type: 'free', correctAnswers: ['x'],
  });
  assert.equal(a.status, 404);

  const quiz = await createQuiz();
  const missing = await request('PATCH', `/api/quizzes/${quiz.id}/questions/99999`, {
    prompt: 'q', type: 'free', correctAnswers: ['x'],
  });
  assert.equal(missing.status, 404);

  const q = (await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'free', correctAnswers: ['x'],
  })).body.question;
  const bad = await request('PATCH', `/api/quizzes/${quiz.id}/questions/${q.id}`, {
    prompt: '', type: 'free', correctAnswers: ['x'],
  });
  assert.equal(bad.status, 400);

  // Bad categoryId branch
  const badCat = await request('PATCH', `/api/quizzes/${quiz.id}/questions/${q.id}`, {
    prompt: 'p', type: 'free', correctAnswers: ['x'], categoryId: 99999,
  });
  assert.equal(badCat.status, 400);

  asOther();
  const forbidden = await request('PATCH', `/api/quizzes/${quiz.id}/questions/${q.id}`, {
    prompt: 'q', type: 'free', correctAnswers: ['x'],
  });
  assert.equal(forbidden.status, 403);
});

test('DELETE /api/quizzes/:id/questions/:qid removes the row', async () => {
  const quiz = await createQuiz();
  const q = (await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'q', type: 'free', correctAnswers: ['x'],
  })).body.question;

  const res = await request('DELETE', `/api/quizzes/${quiz.id}/questions/${q.id}`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT id FROM quiz_questions WHERE id = ?').get(q.id);
  assert.equal(row, undefined);
});

test('DELETE question 404 unknown quiz, 403 not owner', async () => {
  asOwner();
  const a = await request('DELETE', '/api/quizzes/99999/questions/1');
  assert.equal(a.status, 404);
  const quiz = await createQuiz();
  asOther();
  const b = await request('DELETE', `/api/quizzes/${quiz.id}/questions/1`);
  assert.equal(b.status, 403);
});

// ── Question ordering: by category position, uncategorized last ─────────

test('GET quiz orders questions by category position then question position; uncategorized last', async () => {
  const quiz = await createQuiz();
  const catA = (await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'A' })).body.category;
  const catB = (await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'B' })).body.category;

  const qUncat = (await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'uncat', type: 'free', correctAnswers: ['x'],
  })).body.question;
  const qB = (await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'in B', type: 'free', correctAnswers: ['x'], categoryId: catB.id,
  })).body.question;
  const qA = (await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'in A', type: 'free', correctAnswers: ['x'], categoryId: catA.id,
  })).body.question;

  const res = await request('GET', `/api/quizzes/${quiz.id}`);
  assert.equal(res.status, 200);
  const order = res.body.quiz.questions.map(q => q.id);
  assert.deepEqual(order, [qA.id, qB.id, qUncat.id]);
});

// ── Admin override (TRI-88) ────────────────────────────
//
// Admins can manage any quiz from the admin console, bypassing the per-route
// owner check. A non-admin user still cannot touch someone else's quiz.

function asAdmin() {
  // Promote `otherId` to admin and sign in as them.
  db.prepare('UPDATE users SET isAdmin = 1 WHERE id = ?').run(otherId);
  session.userId = otherId;
}

test('admin can GET another user\'s quiz (TRI-88)', async () => {
  const quiz = await createQuiz('Owned by Owner');
  asAdmin();
  const res = await request('GET', `/api/quizzes/${quiz.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.quiz.id, quiz.id);
});

test('admin can rename another user\'s quiz (TRI-88)', async () => {
  const quiz = await createQuiz('Original');
  asAdmin();
  const res = await request('PATCH', `/api/quizzes/${quiz.id}`, { name: 'Renamed by admin' });
  assert.equal(res.status, 200);
  assert.equal(res.body.quiz.name, 'Renamed by admin');
  const row = db.prepare('SELECT ownerUserId FROM quizzes WHERE id = ?').get(quiz.id);
  assert.equal(row.ownerUserId, ownerId, 'admin edit must not transfer ownership');
});

test('admin can delete another user\'s quiz (TRI-88)', async () => {
  const quiz = await createQuiz('To delete');
  asAdmin();
  const res = await request('DELETE', `/api/quizzes/${quiz.id}`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT id FROM quizzes WHERE id = ?').get(quiz.id);
  assert.equal(row, undefined);
});

test('admin can add a category to another user\'s quiz (TRI-88)', async () => {
  const quiz = await createQuiz();
  asAdmin();
  const res = await request('POST', `/api/quizzes/${quiz.id}/categories`, { name: 'Admin Cat' });
  assert.equal(res.status, 201);
  assert.equal(res.body.category.name, 'Admin Cat');
});

test('admin can add a question to another user\'s quiz (TRI-88)', async () => {
  const quiz = await createQuiz();
  asAdmin();
  const res = await request('POST', `/api/quizzes/${quiz.id}/questions`, {
    prompt: 'Capital of France?',
    type: 'single',
    options: ['Paris', 'Berlin'],
    correctAnswers: [0],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.question.prompt, 'Capital of France?');
});

test('disabled admin loses override — gets 403 like any other non-owner (TRI-88)', async () => {
  const quiz = await createQuiz();
  // Promote, then disable, the admin.
  db.prepare("UPDATE users SET isAdmin = 1, disabledAt = datetime('now') WHERE id = ?")
    .run(otherId);
  session.userId = otherId;
  const res = await request('PATCH', `/api/quizzes/${quiz.id}`, { name: 'Should fail' });
  assert.equal(res.status, 403);
});

test('archived admin loses override — gets 403 like any other non-owner (TRI-131)', async () => {
  const quiz = await createQuiz();
  // Promote, then archive, the admin. Mirrors the disabled-admin case so the
  // quiz override matches requireAdmin's rules everywhere.
  db.prepare("UPDATE users SET isAdmin = 1, archivedAt = datetime('now') WHERE id = ?")
    .run(otherId);
  session.userId = otherId;
  const res = await request('PATCH', `/api/quizzes/${quiz.id}`, { name: 'Should fail' });
  assert.equal(res.status, 403);
});

test('non-admin override does not apply — third user still gets 403 (TRI-88)', async () => {
  const quiz = await createQuiz();
  const thirdId = db.prepare(
    'INSERT INTO users (email, passwordHash, displayName) VALUES (?, ?, ?)'
  ).run('third@x.io', 'h', 'Third').lastInsertRowid;
  session.userId = thirdId;
  const res = await request('PATCH', `/api/quizzes/${quiz.id}`, { name: 'Nope' });
  assert.equal(res.status, 403);
});

test('admin GET /api/quizzes lists every owner\'s non-archived quizzes (TRI-102)', async () => {
  // Owner has two quizzes, one archived; admin has none of their own.
  asOwner();
  await request('POST', '/api/quizzes', { name: 'Owner Live' });
  await request('POST', '/api/quizzes', { name: 'Owner Archived' });
  db.prepare("UPDATE quizzes SET archivedAt = datetime('now') WHERE name = ?")
    .run('Owner Archived');

  asAdmin();
  const res = await request('GET', '/api/quizzes');
  assert.equal(res.status, 200);
  const names = res.body.quizzes.map(q => q.name).sort();
  assert.deepEqual(names, ['Owner Live']);
});

test('disabled admin does not see other owners\' quizzes in list (TRI-102)', async () => {
  asOwner();
  await request('POST', '/api/quizzes', { name: 'Owner Live' });
  // Promote and disable the admin — the override must not apply.
  db.prepare("UPDATE users SET isAdmin = 1, disabledAt = datetime('now') WHERE id = ?")
    .run(otherId);
  session.userId = otherId;

  const res = await request('GET', '/api/quizzes');
  assert.equal(res.status, 200);
  assert.equal(res.body.quizzes.length, 0);
});

test('archived admin does not see other owners\' quizzes in list (TRI-131)', async () => {
  asOwner();
  await request('POST', '/api/quizzes', { name: 'Owner Live' });
  // Promote and archive the admin — the override must not apply.
  db.prepare("UPDATE users SET isAdmin = 1, archivedAt = datetime('now') WHERE id = ?")
    .run(otherId);
  session.userId = otherId;

  const res = await request('GET', '/api/quizzes');
  assert.equal(res.status, 200);
  assert.equal(res.body.quizzes.length, 0);
});
