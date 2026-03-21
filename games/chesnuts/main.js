const API = '/api/chesnuts';

let csrfToken = null;
let currentUser = null;
let currentCategory = null;
let currentChallenge = null;

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

// ─── Screen management ──────────────────────────────────────
function hideAll() {
  loadingEl.style.display = 'none';
  authEl.style.display = 'none';
  dashboardEl.classList.remove('active');
  categoryScreen.classList.remove('active');
  playScreen.classList.remove('active');
  historyScreen.classList.remove('active');
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

async function startPlaying(slug, name) {
  currentCategory = slug;
  document.getElementById('play-category-name').textContent = name;
  hideAll();
  playScreen.classList.add('active');
  document.getElementById('streak-banner').classList.remove('active');
  await loadNextQuestion();
}

async function loadNextQuestion() {
  const questionCard = document.getElementById('question-card');
  const resultCard = document.getElementById('result-card');
  resultCard.classList.remove('active');
  questionCard.style.display = '';

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

    // Build option buttons
    const optionsGrid = document.getElementById('q-options');
    optionsGrid.innerHTML = '';

    for (const option of data.challenge.options) {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.textContent = option;
      btn.addEventListener('click', () => submitAnswer(option));
      optionsGrid.appendChild(btn);
    }
  } catch (err) {
    document.getElementById('q-prompt').textContent = `Error: ${err.message}`;
  }
}

async function submitAnswer(answer) {
  // Disable all option buttons immediately
  const buttons = document.querySelectorAll('.option-btn');
  buttons.forEach(b => b.disabled = true);

  try {
    const data = await api('/challenges/answer', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: currentChallenge.id,
        answer,
      }),
    });

    // Highlight correct/wrong options
    buttons.forEach(btn => {
      if (btn.textContent === data.correctAnswer) {
        btn.classList.add(data.correct ? 'correct' : 'reveal');
      } else if (btn.textContent === answer && !data.correct) {
        btn.classList.add('wrong');
      }
    });

    // Update user stats
    updateDashboardStats(data.user);

    // Show result card after a brief delay
    setTimeout(() => {
      document.getElementById('question-card').style.display = 'none';
      const resultCard = document.getElementById('result-card');
      resultCard.classList.add('active');

      if (data.correct) {
        document.getElementById('r-emoji').textContent = '\u2705';
        document.getElementById('r-text').textContent = 'Correct!';
      } else {
        document.getElementById('r-emoji').textContent = '\u274C';
        document.getElementById('r-text').textContent = `The answer was: ${data.correctAnswer}`;
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
    }, 600);

  } catch (err) {
    buttons.forEach(b => b.disabled = false);
    alert(err.message);
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
