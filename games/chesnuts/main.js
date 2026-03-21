const API = '/api/chesnuts';

let csrfToken = null;
let currentUser = null;
let currentCategory = null;
let currentChallenge = null;

// Chess board state
let chessBoardCanvas = null;
let chessBoardCtx = null;
let chessBoard = []; // 8x8 array of piece chars or null
let selectedSquare = null; // { row, col } of currently selected piece
let chessTurn = 'w'; // whose turn it is from FEN

// Unicode chess pieces
const PIECE_CHARS = {
  K: '\u2654', Q: '\u2655', R: '\u2656', B: '\u2657', N: '\u2658', P: '\u2659',
  k: '\u265A', q: '\u265B', r: '\u265C', b: '\u265D', n: '\u265E', p: '\u265F',
};

// Parse FEN string into an 8x8 board array
function parseFEN(fen) {
  const parts = fen.split(' ');
  const rows = parts[0].split('/');
  const board = [];
  for (const row of rows) {
    const boardRow = [];
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < parseInt(ch); i++) boardRow.push(null);
      } else {
        boardRow.push(ch);
      }
    }
    board.push(boardRow);
  }
  return { board, turn: parts[1] || 'w' };
}

// Convert row,col to UCI square name (e.g. 0,0 -> "a8", 7,7 -> "h1")
function squareToUCI(row, col) {
  return String.fromCharCode(97 + col) + (8 - row);
}

// Draw the chess board on canvas
function drawChessBoard() {
  if (!chessBoardCanvas || !chessBoardCtx) return;
  const ctx = chessBoardCtx;
  const dpr = window.devicePixelRatio || 1;
  const size = chessBoardCanvas.clientWidth;
  chessBoardCanvas.width = size * dpr;
  chessBoardCanvas.height = size * dpr;
  ctx.scale(dpr, dpr);

  const sq = size / 8;
  const lightColor = '#f0d9b5';
  const darkColor = '#b58863';
  const selectColor = 'rgba(255, 255, 80, 0.5)';

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      // Square color
      ctx.fillStyle = (r + c) % 2 === 0 ? lightColor : darkColor;
      ctx.fillRect(c * sq, r * sq, sq, sq);

      // Highlight selected square
      if (selectedSquare && selectedSquare.row === r && selectedSquare.col === c) {
        ctx.fillStyle = selectColor;
        ctx.fillRect(c * sq, r * sq, sq, sq);
      }

      // Draw piece
      const piece = chessBoard[r] && chessBoard[r][c];
      if (piece) {
        ctx.fillStyle = '#000';
        ctx.font = `${sq * 0.75}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(PIECE_CHARS[piece], c * sq + sq / 2, r * sq + sq / 2 + sq * 0.03);
      }
    }
  }

  // Draw file/rank labels
  ctx.font = `${sq * 0.18}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let c = 0; c < 8; c++) {
    ctx.fillStyle = c % 2 === 0 ? darkColor : lightColor;
    ctx.fillText(String.fromCharCode(97 + c), c * sq + sq / 2, 8 * sq - sq * 0.1);
  }
  for (let r = 0; r < 8; r++) {
    ctx.fillStyle = r % 2 === 0 ? lightColor : darkColor;
    ctx.fillText(String(8 - r), sq * 0.12, r * sq + sq / 2);
  }
}

// Handle tap/click on chess board
function handleBoardClick(e) {
  if (!chessBoardCanvas) return;
  const rect = chessBoardCanvas.getBoundingClientRect();
  const x = (e.clientX || e.touches[0].clientX) - rect.left;
  const y = (e.clientY || e.touches[0].clientY) - rect.top;
  const sq = rect.width / 8;
  const col = Math.floor(x / sq);
  const row = Math.floor(y / sq);

  if (row < 0 || row > 7 || col < 0 || col > 7) return;

  const piece = chessBoard[row] && chessBoard[row][col];

  if (selectedSquare) {
    // Second tap — try to make a move
    const from = selectedSquare;

    if (from.row === row && from.col === col) {
      // Tapped same square — deselect
      selectedSquare = null;
      drawChessBoard();
      return;
    }

    // If tapped own piece, reselect it instead
    if (piece && isOwnPiece(piece)) {
      selectedSquare = { row, col };
      drawChessBoard();
      return;
    }

    // Submit the move
    const uci = squareToUCI(from.row, from.col) + squareToUCI(row, col);
    selectedSquare = null;
    drawChessBoard();
    submitAnswer(uci);
  } else {
    // First tap — select a piece
    if (piece && isOwnPiece(piece)) {
      selectedSquare = { row, col };
      drawChessBoard();
    }
  }
}

// Check if piece belongs to the side to move
function isOwnPiece(piece) {
  if (chessTurn === 'w') return piece === piece.toUpperCase();
  return piece === piece.toLowerCase();
}

async function fetchCsrf() {
  const res = await fetch(`${API}/csrf-token`);
  const data = await res.json();
  csrfToken = data.csrfToken;
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─── DOM refs ────────────────────────────────────────────────
const loadingEl = document.getElementById('loading');
const authEl = document.getElementById('auth');
const dashboardEl = document.getElementById('dashboard');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginError = document.getElementById('login-error');
const registerError = document.getElementById('register-error');
const logoutBtn = document.getElementById('logout-btn');

const categoryScreen = document.getElementById('category-screen');
const categoryList = document.getElementById('category-list');
const playScreen = document.getElementById('play-screen');
const historyScreen = document.getElementById('history-screen');
const rewardsScreen = document.getElementById('rewards-screen');
const redemptionsScreen = document.getElementById('redemptions-screen');
const redeemOverlay = document.getElementById('redeem-overlay');

// ─── Screen management ──────────────────────────────────────
function hideAll() {
  loadingEl.style.display = 'none';
  authEl.style.display = 'none';
  dashboardEl.classList.remove('active');
  categoryScreen.classList.remove('active');
  playScreen.classList.remove('active');
  historyScreen.classList.remove('active');
  rewardsScreen.classList.remove('active');
  redemptionsScreen.classList.remove('active');
  redeemOverlay.classList.remove('active');
}

function showAuth() {
  hideAll();
  authEl.style.display = '';
}

function showDashboard(user) {
  currentUser = user;
  hideAll();
  dashboardEl.classList.add('active');
  document.getElementById('user-name').textContent = user.displayName;
  document.getElementById('stat-balance').textContent = user.chesnutBalance;
  document.getElementById('stat-streak').textContent = user.currentStreak;
  document.getElementById('stat-best').textContent = user.bestStreak;
}

function updateDashboardStats(user) {
  currentUser = user;
  document.getElementById('stat-balance').textContent = user.chesnutBalance;
  document.getElementById('stat-streak').textContent = user.currentStreak;
  document.getElementById('stat-best').textContent = user.bestStreak;
}

// ─── Tab switching ───────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    loginForm.classList.toggle('active', tab === 'login');
    registerForm.classList.toggle('active', tab === 'register');
    loginError.textContent = '';
    registerError.textContent = '';
  });
});

// ─── Auth handlers ───────────────────────────────────────────
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const btn = loginForm.querySelector('.submit-btn');
  btn.disabled = true;
  try {
    const data = await api('/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value,
      }),
    });
    showDashboard(data.user);
  } catch (err) {
    loginError.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  registerError.textContent = '';
  const btn = registerForm.querySelector('.submit-btn');
  btn.disabled = true;
  try {
    const data = await api('/register', {
      method: 'POST',
      body: JSON.stringify({
        displayName: document.getElementById('reg-name').value,
        email: document.getElementById('reg-email').value,
        password: document.getElementById('reg-password').value,
      }),
    });
    showDashboard(data.user);
  } catch (err) {
    registerError.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await api('/logout', { method: 'POST' });
  } catch { /* ignore */ }
  currentUser = null;
  showAuth();
});

// ─── Dashboard actions ───────────────────────────────────────
document.getElementById('play-btn').addEventListener('click', showCategories);
document.getElementById('history-btn').addEventListener('click', showHistory);
document.getElementById('rewards-btn').addEventListener('click', showRewards);
document.getElementById('redemptions-btn').addEventListener('click', showRedemptions);

// ─── Category screen ─────────────────────────────────────────
document.getElementById('cat-back-btn').addEventListener('click', () => showDashboard(currentUser));

async function showCategories() {
  hideAll();
  categoryScreen.classList.add('active');
  categoryList.innerHTML = '<div class="loading">Loading categories...</div>';

  try {
    const data = await api('/challenges/categories');
    categoryList.innerHTML = '';

    if (data.categories.length === 0) {
      categoryList.innerHTML = '<div class="history-empty">No categories available yet.</div>';
      return;
    }

    for (const cat of data.categories) {
      const card = document.createElement('div');
      card.className = 'category-card';
      card.innerHTML = `
        <h3>${cat.name}</h3>
        <span class="category-meta">${cat.totalChallenges} questions</span>
      `;
      card.addEventListener('click', () => startPlaying(cat.slug, cat.name));
      categoryList.appendChild(card);
    }
  } catch (err) {
    categoryList.innerHTML = `<div class="history-empty">Error: ${err.message}</div>`;
  }
}

// ─── Play screen ─────────────────────────────────────────────
document.getElementById('play-back-btn').addEventListener('click', () => showDashboard(currentUser));
document.getElementById('next-btn').addEventListener('click', loadNextQuestion);

function updateStreakDisplay() {
  const el = document.getElementById('streak-display');
  const streak = currentUser ? currentUser.currentStreak : 0;
  if (streak > 0) {
    const fire = streak >= 5 ? '<span class="fire">&#128293;</span>' : '';
    el.innerHTML = `${fire} Streak: ${streak} ${fire}`;
    el.classList.toggle('on-fire', streak >= 5);
  } else {
    el.textContent = '';
    el.classList.remove('on-fire');
  }
}

function spawnChesnutFly(count) {
  for (let i = 0; i < Math.min(count, 5); i++) {
    const el = document.createElement('div');
    el.className = 'chesnut-fly';
    el.textContent = '\uD83C\uDF30';
    el.style.left = `${40 + Math.random() * 20}%`;
    el.style.top = `${50 + Math.random() * 10}%`;
    el.style.animationDelay = `${i * 0.12}s`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }
}

async function startPlaying(slug, name) {
  currentCategory = slug;
  document.getElementById('play-category-name').textContent = name;
  hideAll();
  playScreen.classList.add('active');
  document.getElementById('streak-banner').classList.remove('active');
  updateStreakDisplay();
  await loadNextQuestion();
}

async function loadNextQuestion() {
  const questionCard = document.getElementById('question-card');
  const resultCard = document.getElementById('result-card');
  const boardContainer = document.getElementById('chess-board-container');
  resultCard.classList.remove('active');
  questionCard.style.display = '';
  boardContainer.style.display = 'none';
  selectedSquare = null;

  document.getElementById('q-prompt').textContent = 'Loading...';
  document.getElementById('q-options').innerHTML = '';

  try {
    const data = await api(`/challenges/next?category=${encodeURIComponent(currentCategory)}`);
    currentChallenge = data.challenge;

    // Set difficulty badge
    const diffEl = document.getElementById('q-difficulty');
    diffEl.textContent = data.challenge.difficulty.toUpperCase();
    diffEl.className = `difficulty-badge difficulty-${data.challenge.difficulty}`;

    // Set reward text
    document.getElementById('q-reward').textContent =
      `+${data.challenge.reward} Chesnut${data.challenge.reward > 1 ? 's' : ''}`;

    // Set prompt
    document.getElementById('q-prompt').textContent = data.challenge.prompt;

    if (data.challenge.type === 'puzzle') {
      // Chess puzzle — show the board
      document.getElementById('q-options').innerHTML = '';
      boardContainer.style.display = 'block';

      // Parse FEN and draw board
      const parsed = parseFEN(data.challenge.fen);
      chessBoard = parsed.board;
      chessTurn = parsed.turn;

      // Init canvas if needed
      chessBoardCanvas = document.getElementById('chess-canvas');
      chessBoardCtx = chessBoardCanvas.getContext('2d');
      drawChessBoard();

      // Show instruction text
      document.getElementById('chess-instruction').textContent =
        'Tap a piece, then tap the destination square.';
    } else {
      // Multiple-choice question
      const optionsGrid = document.getElementById('q-options');
      optionsGrid.innerHTML = '';

      for (const option of data.challenge.options) {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        btn.textContent = option;
        btn.addEventListener('click', () => submitAnswer(option));
        optionsGrid.appendChild(btn);
      }
    }
  } catch (err) {
    document.getElementById('q-prompt').textContent = `Error: ${err.message}`;
  }
}

async function submitAnswer(answer) {
  const isPuzzle = currentChallenge.type === 'puzzle';

  // Disable all option buttons immediately (for question type)
  const buttons = document.querySelectorAll('.option-btn');
  buttons.forEach(b => b.disabled = true);

  // For puzzles, disable board interaction
  if (isPuzzle && chessBoardCanvas) {
    chessBoardCanvas.style.pointerEvents = 'none';
  }

  try {
    const data = await api('/challenges/answer', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: currentChallenge.id,
        answer,
      }),
    });

    if (!isPuzzle) {
      // Highlight correct/wrong options for question type
      buttons.forEach(btn => {
        if (btn.textContent === data.correctAnswer) {
          btn.classList.add(data.correct ? 'correct' : 'reveal');
        } else if (btn.textContent === answer && !data.correct) {
          btn.classList.add('wrong');
        }
      });
    } else {
      // For puzzles, update the instruction text with result
      const instruction = document.getElementById('chess-instruction');
      if (data.correct) {
        instruction.textContent = 'Correct!';
        instruction.style.color = '#b7e4c7';
      } else {
        instruction.textContent = `The correct move was: ${data.correctAnswer}`;
        instruction.style.color = '#fcd5ce';
      }
    }

    // Update user stats and streak display
    updateDashboardStats(data.user);
    updateStreakDisplay();

    // Chesnut earning animation
    if (data.chesnutsEarned > 0) {
      spawnChesnutFly(data.chesnutsEarned);
    }

    // Show result card after a brief delay
    setTimeout(() => {
      document.getElementById('question-card').style.display = 'none';
      document.getElementById('chess-board-container').style.display = 'none';
      const resultCard = document.getElementById('result-card');
      resultCard.classList.add('active');

      if (data.correct) {
        document.getElementById('r-emoji').textContent = '\u2705';
        document.getElementById('r-text').textContent = 'Correct!';
      } else {
        document.getElementById('r-emoji').textContent = '\u274C';
        const answerText = isPuzzle
          ? `The correct move was: ${data.correctAnswer}`
          : `The answer was: ${data.correctAnswer}`;
        document.getElementById('r-text').textContent = answerText;
      }

      let earningsText = `+${data.chesnutsEarned} Chesnut${data.chesnutsEarned !== 1 ? 's' : ''}`;
      if (data.streakBonus > 0) {
        earningsText += ` (includes +${data.streakBonus} streak bonus!)`;
      }
      document.getElementById('r-earnings').textContent = data.correct ? earningsText : 'No Chesnuts earned';

      document.getElementById('r-streak').textContent =
        data.streak > 0 ? `Streak: ${data.streak}` : 'Streak reset';

      // Streak banner for milestones
      const banner = document.getElementById('streak-banner');
      if (data.streakBonus > 0) {
        banner.textContent = `${data.streak} in a row! +${data.streakBonus} bonus Chesnuts!`;
        banner.classList.add('active');
      } else {
        banner.classList.remove('active');
      }

      // Re-enable board interaction for next puzzle
      if (chessBoardCanvas) {
        chessBoardCanvas.style.pointerEvents = '';
        document.getElementById('chess-instruction').style.color = '';
      }
    }, isPuzzle ? 1200 : 600);

  } catch (err) {
    buttons.forEach(b => b.disabled = false);
    if (isPuzzle && chessBoardCanvas) {
      chessBoardCanvas.style.pointerEvents = '';
    }
    alert(err.message);
  }
}

// ─── Rewards screen ──────────────────────────────────────────
document.getElementById('rew-back-btn').addEventListener('click', () => showDashboard(currentUser));

let pendingRedeemId = null;

async function showRewards() {
  hideAll();
  rewardsScreen.classList.add('active');
  const listEl = document.getElementById('reward-list');
  listEl.innerHTML = '<div class="loading">Loading rewards...</div>';

  try {
    const data = await api('/rewards/catalog');
    document.getElementById('rew-balance').textContent = data.balance;
    listEl.innerHTML = '';

    if (data.rewards.length === 0) {
      listEl.innerHTML = '<div class="history-empty">No rewards available yet.</div>';
      return;
    }

    for (const reward of data.rewards) {
      const card = document.createElement('div');
      card.className = 'reward-card';
      const canAfford = data.balance >= reward.chesnutCost;
      card.innerHTML = `
        <div class="reward-info">
          <h3>${escapeHtml(reward.name)}</h3>
          <span class="reward-desc">${escapeHtml(reward.description)}</span>
        </div>
        <button class="redeem-btn" ${canAfford ? '' : 'disabled'}
          data-id="${reward.id}" data-name="${escapeHtml(reward.name)}" data-cost="${reward.chesnutCost}">
          ${reward.chesnutCost} &#127330;
        </button>
      `;
      card.querySelector('.redeem-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        showRedeemConfirm(
          parseInt(btn.dataset.id),
          btn.dataset.name,
          parseInt(btn.dataset.cost),
          data.balance
        );
      });
      listEl.appendChild(card);
    }
  } catch (err) {
    listEl.innerHTML = `<div class="history-empty">Error: ${err.message}</div>`;
  }
}

function showRedeemConfirm(rewardId, name, cost, balance) {
  pendingRedeemId = rewardId;
  document.getElementById('redeem-detail').textContent = name;
  document.getElementById('redeem-cost').textContent = cost;
  document.getElementById('redeem-remaining').textContent = `${balance - cost} Chesnuts after redemption`;
  redeemOverlay.classList.add('active');
}

document.getElementById('redeem-cancel-btn').addEventListener('click', () => {
  redeemOverlay.classList.remove('active');
  pendingRedeemId = null;
});

document.getElementById('redeem-confirm-btn').addEventListener('click', async () => {
  if (!pendingRedeemId) return;
  const btn = document.getElementById('redeem-confirm-btn');
  btn.disabled = true;

  try {
    const data = await api('/rewards/redeem', {
      method: 'POST',
      body: JSON.stringify({ rewardId: pendingRedeemId }),
    });

    // Update dashboard stats
    updateDashboardStats(data.user);
    redeemOverlay.classList.remove('active');
    pendingRedeemId = null;

    // Refresh catalog to update afford status
    await showRewards();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ─── Redemptions screen ──────────────────────────────────────
document.getElementById('rdh-back-btn').addEventListener('click', () => showDashboard(currentUser));

async function showRedemptions() {
  hideAll();
  redemptionsScreen.classList.add('active');
  const listEl = document.getElementById('redemptions-list');
  listEl.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const data = await api('/rewards/redemptions');
    document.getElementById('rdh-total').textContent = data.stats.totalRedemptions || 0;
    document.getElementById('rdh-spent').textContent = data.stats.totalSpent || 0;

    listEl.innerHTML = '';

    if (data.redemptions.length === 0) {
      listEl.innerHTML = '<div class="history-empty">No redemptions yet. Earn Chesnuts and spend them on rewards!</div>';
      return;
    }

    for (const rd of data.redemptions) {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <span class="h-prompt">${escapeHtml(rd.rewardName)}</span>
        <span class="h-result">
          <span class="rdh-status rdh-${rd.status}">${rd.status}</span>
          <span class="h-earned">-${rd.chesnutsSpent}</span>
        </span>
      `;
      listEl.appendChild(item);
    }
  } catch (err) {
    listEl.innerHTML = `<div class="history-empty">Error: ${err.message}</div>`;
  }
}

// ─── History screen ──────────────────────────────────────────
document.getElementById('hist-back-btn').addEventListener('click', () => showDashboard(currentUser));

let historyOffset = 0;

async function showHistory() {
  hideAll();
  historyScreen.classList.add('active');
  historyOffset = 0;

  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const data = await api(`/challenges/history?limit=50&offset=0`);

    document.getElementById('hist-total').textContent = data.stats.totalAttempts || 0;
    document.getElementById('hist-correct').textContent = data.stats.totalCorrect || 0;
    document.getElementById('hist-earned').textContent = data.stats.totalEarned || 0;

    listEl.innerHTML = '';

    if (data.attempts.length === 0) {
      listEl.innerHTML = '<div class="history-empty">No attempts yet. Start playing!</div>';
      return;
    }

    renderAttempts(data.attempts);
    historyOffset = data.attempts.length;

    if (data.attempts.length === 50) {
      addLoadMoreButton();
    }
  } catch (err) {
    listEl.innerHTML = `<div class="history-empty">Error: ${err.message}</div>`;
  }
}

function renderAttempts(attempts) {
  const listEl = document.getElementById('history-list');

  for (const a of attempts) {
    const item = document.createElement('div');
    item.className = 'history-item';

    const correctClass = a.correct ? 'h-correct' : 'h-wrong';
    const correctText = a.correct ? '\u2713' : '\u2717';
    const earned = a.chesnutsEarned > 0 ? `+${a.chesnutsEarned}` : '';

    item.innerHTML = `
      <span class="h-prompt">${escapeHtml(a.prompt)}</span>
      <span class="h-result">
        <span class="${correctClass}">${correctText}</span>
        ${earned ? `<span class="h-earned">${earned}</span>` : ''}
      </span>
    `;
    listEl.appendChild(item);
  }
}

function addLoadMoreButton() {
  const listEl = document.getElementById('history-list');
  const btn = document.createElement('button');
  btn.className = 'load-more-btn';
  btn.textContent = 'Load more';
  btn.addEventListener('click', async () => {
    btn.textContent = 'Loading...';
    btn.disabled = true;
    try {
      const data = await api(`/challenges/history?limit=50&offset=${historyOffset}`);
      btn.remove();
      renderAttempts(data.attempts);
      historyOffset += data.attempts.length;
      if (data.attempts.length === 50) {
        addLoadMoreButton();
      }
    } catch (err) {
      btn.textContent = 'Error loading. Tap to retry.';
      btn.disabled = false;
    }
  });
  listEl.appendChild(btn);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Init ────────────────────────────────────────────────────
async function init() {
  try {
    await fetchCsrf();

    // Set up chess board click handler
    const canvas = document.getElementById('chess-canvas');
    canvas.addEventListener('click', handleBoardClick);
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      handleBoardClick(e);
    }, { passive: false });

    const data = await api('/me');
    if (data.user) {
      showDashboard(data.user);
    } else {
      showAuth();
    }
  } catch {
    showAuth();
  }
}

init();
