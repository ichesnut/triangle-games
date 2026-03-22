// Server-side math challenge generator with difficulty scaling

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickOperator(difficulty) {
  const ops = difficulty === 'easy'
    ? ['+', '-']
    : difficulty === 'medium'
      ? ['+', '-', '*']
      : ['+', '-', '*', '/'];
  return ops[randInt(0, ops.length - 1)];
}

function generateChallenge(difficulty = 'medium') {
  const op = pickOperator(difficulty);
  let a, b, answer;

  switch (difficulty) {
    case 'easy':
      a = randInt(1, 20);
      b = randInt(1, 20);
      break;
    case 'medium':
      a = randInt(10, 50);
      b = randInt(2, 30);
      break;
    case 'hard':
      a = randInt(20, 100);
      b = randInt(5, 50);
      break;
    default:
      a = randInt(10, 50);
      b = randInt(2, 30);
  }

  switch (op) {
    case '+':
      answer = a + b;
      break;
    case '-':
      // Ensure non-negative result
      if (b > a) [a, b] = [b, a];
      answer = a - b;
      break;
    case '*':
      // Keep multiplications reasonable
      if (difficulty === 'hard') {
        a = randInt(5, 25);
        b = randInt(2, 15);
      } else {
        a = randInt(2, 12);
        b = randInt(2, 12);
      }
      answer = a * b;
      break;
    case '/':
      // Generate clean division (no remainder)
      b = randInt(2, 12);
      answer = randInt(2, 15);
      a = b * answer;
      break;
  }

  return {
    prompt: `${a} ${op} ${b}`,
    answer: answer,
  };
}

// Scale difficulty based on round number
function difficultyForRound(roundNumber) {
  if (roundNumber <= 3) return 'easy';
  if (roundNumber <= 7) return 'medium';
  return 'hard';
}

export { generateChallenge, difficultyForRound };
