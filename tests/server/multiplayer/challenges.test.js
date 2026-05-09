import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  challengeFromQuestion,
  isAnswerCorrect,
  publicChallenge,
  correctAnswerDisplay,
} from '../../../server/multiplayer/challenges.js';

test('challengeFromQuestion copies question fields and stamps startedAt', () => {
  const before = Date.now();
  const ch = challengeFromQuestion({
    id: 7,
    prompt: 'What is 2 + 2?',
    type: 'free',
    options: [],
    correctAnswers: ['4'],
  });
  assert.equal(ch.questionId, 7);
  assert.equal(ch.prompt, 'What is 2 + 2?');
  assert.equal(ch.type, 'free');
  assert.deepEqual(ch.options, []);
  assert.deepEqual(ch.correctAnswers, ['4']);
  assert.ok(ch.startedAt >= before);
});

test('isAnswerCorrect returns false when challenge is null', () => {
  assert.equal(isAnswerCorrect(null, 'anything'), false);
});

test('isAnswerCorrect: free-text matches case-insensitively across accepted answers', () => {
  const ch = { type: 'free', options: [], correctAnswers: ['Paris', 'paris, france'] };
  assert.equal(isAnswerCorrect(ch, 'paris'), true);
  assert.equal(isAnswerCorrect(ch, '  PARIS  '), true);
  assert.equal(isAnswerCorrect(ch, 'Paris, France'), true);
  assert.equal(isAnswerCorrect(ch, 'london'), false);
});

test('isAnswerCorrect: free-text rejects non-string and empty input', () => {
  const ch = { type: 'free', options: [], correctAnswers: ['x'] };
  assert.equal(isAnswerCorrect(ch, 42), false);
  assert.equal(isAnswerCorrect(ch, ''), false);
  assert.equal(isAnswerCorrect(ch, '   '), false);
  assert.equal(isAnswerCorrect(ch, null), false);
});

test('isAnswerCorrect: single-choice requires integer matching the first correct answer', () => {
  const ch = { type: 'single', options: ['a', 'b', 'c'], correctAnswers: [1] };
  assert.equal(isAnswerCorrect(ch, 1), true);
  assert.equal(isAnswerCorrect(ch, 0), false);
  assert.equal(isAnswerCorrect(ch, '1'), false);
  assert.equal(isAnswerCorrect(ch, 1.5), false);
});

test('isAnswerCorrect: multiple-choice requires exact set match', () => {
  const ch = { type: 'multiple', options: ['a', 'b', 'c', 'd'], correctAnswers: [0, 2] };
  assert.equal(isAnswerCorrect(ch, [0, 2]), true);
  assert.equal(isAnswerCorrect(ch, [2, 0]), true);
  assert.equal(isAnswerCorrect(ch, [0]), false);
  assert.equal(isAnswerCorrect(ch, [0, 1, 2]), false);
  assert.equal(isAnswerCorrect(ch, []), false);
  assert.equal(isAnswerCorrect(ch, 'not-an-array'), false);
  assert.equal(isAnswerCorrect(ch, [0, '2']), false);
});

test('isAnswerCorrect: unknown type returns false', () => {
  const ch = { type: 'mystery', options: [], correctAnswers: [] };
  assert.equal(isAnswerCorrect(ch, 'anything'), false);
});

test('publicChallenge strips correctAnswers but keeps display fields', () => {
  const ch = {
    questionId: 3,
    prompt: 'p',
    type: 'single',
    options: ['a', 'b'],
    correctAnswers: [1],
    startedAt: 1234,
  };
  const pub = publicChallenge(ch);
  assert.deepEqual(pub, {
    questionId: 3,
    prompt: 'p',
    type: 'single',
    options: ['a', 'b'],
    startedAt: 1234,
  });
  assert.equal('correctAnswers' in pub, false);
});

test('publicChallenge returns null for null challenge', () => {
  assert.equal(publicChallenge(null), null);
});

test('correctAnswerDisplay: free joins accepted answers with " / "', () => {
  const ch = { type: 'free', options: [], correctAnswers: ['Paris', 'paris, france'] };
  assert.equal(correctAnswerDisplay(ch), 'Paris / paris, france');
});

test('correctAnswerDisplay: choice questions resolve indices to option text', () => {
  const single = { type: 'single', options: ['a', 'b', 'c'], correctAnswers: [1] };
  assert.equal(correctAnswerDisplay(single), 'b');

  const multi = { type: 'multiple', options: ['a', 'b', 'c'], correctAnswers: [0, 2] };
  assert.equal(correctAnswerDisplay(multi), 'a, c');
});

test('correctAnswerDisplay: filters out-of-range indices', () => {
  const ch = { type: 'single', options: ['only'], correctAnswers: [99] };
  assert.equal(correctAnswerDisplay(ch), '');
});

test('correctAnswerDisplay returns empty string for null challenge', () => {
  assert.equal(correctAnswerDisplay(null), '');
});
