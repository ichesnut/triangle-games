// Quiz-driven challenge logic.
//
// Each challenge in a room comes from a pre-configured quiz question.
// Three answer types are supported:
//   - free      : free-text input. Server matches case-insensitively against
//                 any of the accepted answers.
//   - single    : multiple-choice list, exactly one correct option.
//   - multiple  : multiple-choice list, any subset of correct options.

function challengeFromQuestion(question) {
  return {
    questionId: question.id,
    prompt: question.prompt,
    type: question.type,
    options: question.options,           // [] for free
    correctAnswers: question.correctAnswers,
    startedAt: Date.now(),
  };
}

function normalizeFree(s) {
  return String(s ?? '').trim().toLowerCase();
}

// Returns true if `submitted` is a correct answer to `challenge`.
//
// Submission shape:
//   - free      : string
//   - single    : integer (option index)
//   - multiple  : array of integers (option indices)
function isAnswerCorrect(challenge, submitted) {
  if (!challenge) return false;

  switch (challenge.type) {
    case 'free': {
      if (typeof submitted !== 'string') return false;
      const norm = normalizeFree(submitted);
      if (!norm) return false;
      return challenge.correctAnswers.some(a => normalizeFree(a) === norm);
    }
    case 'single': {
      if (!Number.isInteger(submitted)) return false;
      const correct = challenge.correctAnswers[0];
      return submitted === correct;
    }
    case 'multiple': {
      if (!Array.isArray(submitted)) return false;
      if (!submitted.every(i => Number.isInteger(i))) return false;
      const got = new Set(submitted);
      const want = new Set(challenge.correctAnswers);
      if (got.size !== want.size) return false;
      for (const v of want) if (!got.has(v)) return false;
      return true;
    }
    default:
      return false;
  }
}

// Build a public, redacted view of the challenge for clients (no answers).
function publicChallenge(challenge) {
  if (!challenge) return null;
  return {
    questionId: challenge.questionId,
    prompt: challenge.prompt,
    type: challenge.type,
    options: challenge.options,
    startedAt: challenge.startedAt,
  };
}

// Build a public correct-answer string for the round-result reveal.
function correctAnswerDisplay(challenge) {
  if (!challenge) return '';
  if (challenge.type === 'free') {
    return challenge.correctAnswers.join(' / ');
  }
  // For choice questions, show the option text.
  return challenge.correctAnswers
    .map(i => challenge.options[i])
    .filter(Boolean)
    .join(', ');
}

export {
  challengeFromQuestion,
  isAnswerCorrect,
  publicChallenge,
  correctAnswerDisplay,
};
