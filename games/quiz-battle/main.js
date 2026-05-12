// Quiz Battle — Pre-configured quiz multiplayer client.

const API = '/api/chesnuts';
const GUEST_TOKEN_KEY = 'triangle-games:guestToken';
const GUEST_NAME_KEY = 'triangle-games:guestName';
const OPEN_REGISTER_TAB_KEY = 'triangle-games:openRegisterTab';

// ── State ──────────────────────────────────────────────
let csrfToken = null;
let currentUser = null;
let ws = null;
let roomCode = null;
let roomState = null;
let isHost = false;

// Battle state
let currentChallenge = null;
let myAnswerFree = '';
let myAnswerChoice = null;        // single: index | multiple: Set<index>
let answerSubmitted = false;

// ── DOM refs ───────────────────────────────────────────
const screens = {
  auth: document.getElementById('auth-screen'),
  menu: document.getElementById('menu-screen'),
  lobby: document.getElementById('lobby-screen'),
  quizPicker: document.getElementById('quiz-picker-screen'),
  battle: document.getElementById('battle-screen'),
  result: document.getElementById('result-screen'),
  scoreboard: document.getElementById('scoreboard-screen'),
};

const flash = document.getElementById('flash-overlay');

function showScreen(name) {
  for (const s of Object.values(screens)) s.classList.remove('active');
  screens[name].classList.add('active');
}

// ── API helpers ────────────────────────────────────────
async function fetchCsrf() {
  const res = await fetch(`${API}/csrf-token`);
  const data = await res.json();
  csrfToken = data.csrfToken;
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Guest token (browser-stable identity) ─────────────
function getOrCreateGuestToken() {
  let token = null;
  try { token = localStorage.getItem(GUEST_TOKEN_KEY); } catch (_) {}
  if (!token) {
    token = (crypto && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
    try { localStorage.setItem(GUEST_TOKEN_KEY, token); } catch (_) {}
  }
  return token;
}

// ── Auth ───────────────────────────────────────────────
async function checkAuth() {
  const loadingMsg = document.getElementById('loading-msg');
  const authForms = document.getElementById('auth-forms');
  try {
    await fetchCsrf();
    const data = await api('/me');
    if (data.user) {
      currentUser = data.user;
      onAuthenticated();
      return;
    }
    // No active session — but if we previously played as a guest on this
    // browser, transparently re-establish the guest session so streaks etc.
    // continue to be tracked.
    let storedName = null;
    try { storedName = localStorage.getItem(GUEST_NAME_KEY); } catch (_) {}
    if (storedName) {
      try {
        const guestData = await api('/guest', {
          method: 'POST',
          body: JSON.stringify({
            guestToken: getOrCreateGuestToken(),
            displayName: storedName,
          }),
        });
        currentUser = guestData.user;
        onAuthenticated();
        return;
      } catch (_) { /* fall through to auth screen */ }
    }
  } catch (_) { /* not logged in */ }
  loadingMsg.style.display = 'none';
  authForms.style.display = 'flex';

  // Pre-fill the guest name field with the last used name, if any.
  try {
    const last = localStorage.getItem(GUEST_NAME_KEY);
    if (last) {
      document.querySelector('#guest-form input[name="displayName"]').value = last;
    }
  } catch (_) {}

  // If we landed here from the "Register to keep your chesnuts" CTA, open
  // the Register tab instead of the default Guest tab.
  let openRegister = false;
  try {
    if (sessionStorage.getItem(OPEN_REGISTER_TAB_KEY)) {
      openRegister = true;
      sessionStorage.removeItem(OPEN_REGISTER_TAB_KEY);
    }
  } catch (_) {}
  if (openRegister) {
    const tab = document.querySelector('.auth-tab[data-tab="register"]');
    if (tab) tab.click();
  }
}

function refreshMenuForCurrentUser() {
  const welcome = document.getElementById('welcome-msg');
  const streak = document.getElementById('streak-msg');
  const nameSuffix = currentUser.isGuest ? ' (guest)' : '';
  welcome.textContent = `Welcome, ${currentUser.displayName}${nameSuffix}!`;

  const cur = currentUser.currentStreak || 0;
  const best = currentUser.bestStreak || 0;
  if (cur > 0 || best > 0) {
    streak.textContent = `Current streak: ${cur} · Best: ${best}`;
    streak.style.display = '';
  } else {
    streak.style.display = 'none';
  }

  // Guests can't host (no account).
  const isGuest = !!currentUser.isGuest;
  document.getElementById('create-btn').style.display = isGuest ? 'none' : '';
}

function onAuthenticated() {
  refreshMenuForCurrentUser();
  showScreen('menu');

  const params = new URLSearchParams(window.location.search);
  const joinCode = params.get('room');
  if (joinCode) {
    document.getElementById('join-code-input').value = joinCode;
    connectAndJoin(joinCode.toUpperCase());
  }
}

document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`${tab.dataset.tab}-form`).classList.add('active');
  });
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  const fd = new FormData(e.target);
  try {
    const data = await api('/login', {
      method: 'POST',
      body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }),
    });
    currentUser = data.user;
    onAuthenticated();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('register-error');
  errEl.textContent = '';
  const fd = new FormData(e.target);
  try {
    const data = await api('/register', {
      method: 'POST',
      body: JSON.stringify({
        email: fd.get('email'),
        password: fd.get('password'),
        displayName: fd.get('displayName'),
      }),
    });
    currentUser = data.user;
    onAuthenticated();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('guest-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('guest-error');
  errEl.textContent = '';
  const fd = new FormData(e.target);
  const displayName = (fd.get('displayName') || '').toString().trim();
  if (!displayName) { errEl.textContent = 'Please enter a name'; return; }
  try {
    const data = await api('/guest', {
      method: 'POST',
      body: JSON.stringify({
        guestToken: getOrCreateGuestToken(),
        displayName,
      }),
    });
    try { localStorage.setItem(GUEST_NAME_KEY, displayName); } catch (_) {}
    currentUser = data.user;
    onAuthenticated();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('switch-user-link').addEventListener('click', async (e) => {
  e.preventDefault();
  try { await api('/logout', { method: 'POST' }); } catch (_) {}
  try { localStorage.removeItem(GUEST_NAME_KEY); } catch (_) {}
  // Reload so we re-init CSRF + state cleanly.
  location.href = location.pathname;
});

// Guest scoreboard CTA: log them out, hint that the auth screen should land
// on the Register tab, then reload. Their guest streaks live on the guest
// row keyed by guestToken; registering with the same browser session merges
// them in (see mergeGuestIntoUser in server/routes/auth.js).
document.getElementById('register-to-keep-btn').addEventListener('click', async () => {
  try { sessionStorage.setItem(OPEN_REGISTER_TAB_KEY, '1'); } catch (_) {}
  try { await api('/logout', { method: 'POST' }); } catch (_) {}
  location.href = location.pathname;
});

// ══════════════════════════════════════════════════════
// MULTIPLAYER WS
// ══════════════════════════════════════════════════════

function connectWS() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/quiz-battle`);

    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WebSocket connection failed'));

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      if (roomCode && screens.battle.classList.contains('active')) {
        setTimeout(() => {
          connectAndJoin(roomCode).catch(() => showScreen('menu'));
        }, 2000);
      }
    };
  });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'room_state': handleRoomState(msg); break;
    case 'player_joined': handlePlayerJoined(msg); break;
    case 'player_left': handleRoomState(msg); break;
    case 'round_start': handleRoundStart(msg); break;
    case 'answer_received': handleAnswerReceived(msg); break;
    case 'round_result': handleRoundResult(msg); break;
    case 'game_over': handleGameOver(msg); break;
    case 'error':
      console.error('Server error:', msg.message);
      showMenuError(msg.message || 'Something went wrong.');
      break;
  }
}

function handleRoomState(msg) {
  roomCode = msg.code;
  roomState = msg;
  isHost = msg.hostUserId === currentUser.id;

  if (msg.state === 'lobby') {
    showScreen('lobby');
    renderLobby();
  } else if (msg.state === 'playing' && msg.currentChallenge) {
    handleRoundStart(msg);
  }
}

function handlePlayerJoined(msg) {
  if (roomState) {
    roomState.players.push({
      userId: msg.userId,
      displayName: msg.displayName,
      score: 0,
      isHost: false,
    });
    renderLobby();
  }
}

function handleRoundStart(msg) {
  roomState = msg;
  currentChallenge = msg.currentChallenge;
  myAnswerFree = '';
  myAnswerChoice = currentChallenge.type === 'multiple' ? new Set() : null;
  answerSubmitted = false;

  document.getElementById('round-info').textContent =
    `Question ${msg.currentRound}${msg.totalRounds ? ' / ' + msg.totalRounds : ''}`;
  document.getElementById('challenge-text').textContent = currentChallenge.prompt;
  document.getElementById('battle-waiting').style.display = 'none';
  renderAnswerArea();
  renderScoresBar(document.getElementById('scores-bar'), msg.players);
  showScreen('battle');
}

function handleAnswerReceived(msg) {
  answerSubmitted = true;
  document.getElementById('battle-waiting').style.display = '';
  setAnswerAreaDisabled(true);
  showFlash(msg.correct ? 'correct' : 'wrong');
}

function handleRoundResult(msg) {
  const winnerText = msg.winnerId
    ? (msg.winnerId === currentUser.id ? 'You won!' : `${msg.winnerName} wins!`)
    : 'No one got it right!';

  document.getElementById('result-winner').textContent = winnerText;
  document.getElementById('result-winner').style.color =
    msg.winnerId === currentUser.id ? 'var(--gold)' : 'var(--text)';

  document.getElementById('result-answer').textContent =
    `Answer: ${msg.correctAnswer}`;

  document.getElementById('result-time').textContent = msg.timeTaken
    ? `Answered in ${(msg.timeTaken / 1000).toFixed(2)}s`
    : '';

  const players = roomState?.players || [];
  const updatedPlayers = players.map(p => ({ ...p, score: msg.scores[p.userId] || 0 }));
  renderScoresBar(document.getElementById('result-scores'), updatedPlayers);

  if (roomState) roomState.players = updatedPlayers;

  const nextBtn = document.getElementById('next-round-btn');
  const nextHint = document.getElementById('next-round-hint');
  const finalRound = msg.hasMoreQuestions === false;
  nextBtn.textContent = finalRound ? 'See Final Scores' : 'Next Question';
  nextBtn.disabled = false;

  // Only the host (game creator) can advance the game.
  nextBtn.hidden = !isHost;
  if (isHost) {
    nextHint.hidden = true;
    nextHint.textContent = '';
  } else {
    nextHint.hidden = false;
    nextHint.textContent = finalRound
      ? 'Waiting for the host to end the game…'
      : 'Waiting for the host to start the next question…';
  }

  // End Game is host-only; non-hosts never see the button. Hide on the final
  // round since "See Final Scores" will end the game on its own.
  const endBtn = document.getElementById('end-game-btn');
  endBtn.disabled = false;
  endBtn.textContent = 'End Game';
  endBtn.style.display = (isHost && msg.hasMoreQuestions !== false) ? '' : 'none';

  showScreen('result');
}

function handleGameOver(msg) {
  const title = document.getElementById('scoreboard-title');
  const banner = document.getElementById('scoreboard-banner');
  if (msg.aborted) {
    title.textContent = 'Game Ended';
    const who = msg.leftDisplayName ? escapeHtml(msg.leftDisplayName) : 'Your opponent';
    banner.textContent = `${who} left the game. Final scores below.`;
    banner.hidden = false;
  } else {
    title.textContent = 'Game Over!';
    banner.textContent = '';
    banner.hidden = true;
  }
  renderScoreboard(msg);
  showScreen('scoreboard');
}

// ── Lobby rendering ────────────────────────────────────
function renderLobby() {
  document.getElementById('room-code').textContent = roomCode;

  const list = document.getElementById('player-list');
  list.innerHTML = '';
  for (const p of roomState.players) {
    const li = document.createElement('li');
    li.className = 'player-item';
    li.innerHTML = `<span>${escapeHtml(p.displayName)}</span>${p.isHost ? '<span class="host-badge">HOST</span>' : ''}`;
    list.appendChild(li);
  }

  const sel = document.getElementById('selected-quiz');
  const pickBtn = document.getElementById('pick-quiz-btn');
  if (roomState.quiz) {
    sel.textContent = `${roomState.quiz.name} · ${roomState.quiz.questionCount} questions`;
  } else {
    sel.textContent = 'None selected';
  }
  pickBtn.style.display = isHost ? '' : 'none';
  pickBtn.textContent = roomState.quiz ? 'Change Quiz' : 'Choose Quiz';

  const startBtn = document.getElementById('start-btn');
  const canStart = isHost && roomState.players.length >= 2 && !!roomState.quiz;
  startBtn.disabled = !canStart;
  document.getElementById('lobby-status').textContent = isHost
    ? (!roomState.quiz
        ? 'Pick a quiz to host'
        : (roomState.players.length < 2 ? 'Waiting for players...' : 'Ready to start!'))
    : 'Waiting for host to start...';
}

document.getElementById('pick-quiz-btn').addEventListener('click', async () => {
  showScreen('quizPicker');
  const list = document.getElementById('picker-quiz-list');
  const errEl = document.getElementById('picker-error');
  errEl.textContent = '';
  list.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const data = await api('/quizzes');
    list.innerHTML = '';
    if (!data.quizzes.length) {
      list.innerHTML = '<div class="empty-state">No quizzes available yet. Ask an admin to create one.</div>';
      return;
    }
    for (const q of data.quizzes) {
      const li = document.createElement('li');
      li.className = 'quiz-row';
      const disabled = q.questionCount === 0;
      li.innerHTML = `
        <span class="quiz-name">${escapeHtml(q.name)}</span>
        <span class="quiz-meta">${q.questionCount} q</span>
        <button class="btn btn-primary btn-small" ${disabled ? 'disabled' : ''}>${disabled ? 'Empty' : 'Pick'}</button>
      `;
      const btn = li.querySelector('button');
      if (!disabled) {
        btn.addEventListener('click', () => {
          send({ type: 'select_quiz', quizId: q.id });
          showScreen('lobby');
        });
      }
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = '';
    errEl.textContent = err.message;
  }
});

document.getElementById('quiz-picker-back').addEventListener('click', () => showScreen('lobby'));

// ── Scores bar rendering ───────────────────────────────
function renderScoresBar(container, players) {
  container.innerHTML = '';
  for (const p of players) {
    const chip = document.createElement('span');
    chip.className = `score-chip${p.userId === currentUser.id ? ' me' : ''}`;
    chip.textContent = `${p.displayName}: ${p.score}`;
    container.appendChild(chip);
  }
}

// ── Scoreboard rendering ───────────────────────────────
function renderScoreboard(data) {
  const list = document.getElementById('scoreboard-list');
  list.innerHTML = '';

  const players = roomState?.players || [];
  const ranked = players.map(p => ({
    ...p,
    score: data.scores[p.userId] || 0,
    chesnuts: data.totalChesnuts[p.userId] || 0,
  })).sort((a, b) => b.score - a.score);

  ranked.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = `scoreboard-row${i === 0 ? ' first' : ''}`;
    row.innerHTML = `
      <span class="scoreboard-rank">${i + 1}</span>
      <span class="scoreboard-name">${escapeHtml(p.displayName)}${p.userId === currentUser.id ? ' (You)' : ''}</span>
      <span class="scoreboard-stats">
        ${p.score} won<br>
        <span class="chesnuts">+${p.chesnuts} chesnuts</span>
      </span>
    `;
    list.appendChild(row);
  });

  // Guest CTA: server filters guest IDs out of totalChesnuts (TRI-55), so a
  // guest never sees a "+N chesnuts" line for themselves. If they would have
  // earned chesnuts as a registered user, prompt them to register.
  const cta = document.getElementById('register-to-keep-btn');
  cta.hidden = true;
  if (currentUser?.isGuest) {
    let wouldHaveEarned = 0;
    for (const r of data.roundResults || []) {
      wouldHaveEarned += Number(r.chesnutAwards?.[currentUser.id]) || 0;
    }
    if (wouldHaveEarned > 0) {
      cta.textContent = `Register to keep your ${wouldHaveEarned} chesnut${wouldHaveEarned === 1 ? '' : 's'}!`;
      cta.hidden = false;
    }
  }
}

// ── Visual feedback ────────────────────────────────────
function showFlash(type) {
  flash.className = `flash-overlay ${type}`;
  setTimeout(() => { flash.className = 'flash-overlay'; }, 400);
}

// ══════════════════════════════════════════════════════
// ANSWER UI (per question type)
// ══════════════════════════════════════════════════════

function renderAnswerArea() {
  const area = document.getElementById('answer-area');
  area.innerHTML = '';
  if (!currentChallenge) return;

  if (currentChallenge.type === 'free') {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'free-input';
    input.placeholder = 'Type your answer';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.addEventListener('input', () => { myAnswerFree = input.value; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitFreeAnswer();
    });
    area.appendChild(input);
    setTimeout(() => input.focus(), 30);

    const submit = document.createElement('button');
    submit.className = 'submit-btn';
    submit.textContent = 'Submit';
    submit.addEventListener('click', submitFreeAnswer);
    area.appendChild(submit);
  } else {
    const isMultiple = currentChallenge.type === 'multiple';
    if (!isMultiple) myAnswerChoice = null;
    else myAnswerChoice = new Set();

    currentChallenge.options.forEach((opt, idx) => {
      const btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.textContent = opt;
      btn.addEventListener('click', () => {
        if (answerSubmitted) return;
        if (isMultiple) {
          if (myAnswerChoice.has(idx)) myAnswerChoice.delete(idx);
          else myAnswerChoice.add(idx);
        } else {
          // Single-choice → submit immediately
          send({ type: 'submit_answer', answer: idx });
          answerSubmitted = true;
          setAnswerAreaDisabled(true);
          document.getElementById('battle-waiting').style.display = '';
          return;
        }
        // Re-render selected state for multi
        [...area.querySelectorAll('.choice-btn')].forEach((b, i) => {
          b.classList.toggle('selected', myAnswerChoice.has(i));
        });
      });
      area.appendChild(btn);
    });

    if (isMultiple) {
      const submit = document.createElement('button');
      submit.className = 'submit-btn';
      submit.textContent = 'Submit';
      submit.addEventListener('click', () => {
        if (answerSubmitted) return;
        if (!myAnswerChoice || myAnswerChoice.size === 0) return;
        send({ type: 'submit_answer', answer: [...myAnswerChoice] });
        answerSubmitted = true;
        setAnswerAreaDisabled(true);
        document.getElementById('battle-waiting').style.display = '';
      });
      area.appendChild(submit);
    }
  }
}

function submitFreeAnswer() {
  if (answerSubmitted) return;
  const value = (myAnswerFree || '').trim();
  if (!value) return;
  send({ type: 'submit_answer', answer: value });
  answerSubmitted = true;
  setAnswerAreaDisabled(true);
  document.getElementById('battle-waiting').style.display = '';
}

function setAnswerAreaDisabled(disabled) {
  const area = document.getElementById('answer-area');
  area.querySelectorAll('button, input').forEach(el => { el.disabled = disabled; });
}

// ══════════════════════════════════════════════════════
// MENU / ROOM ACTIONS
// ══════════════════════════════════════════════════════

function showMenuError(msg) {
  const el = document.getElementById('menu-error');
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 5000);
}

async function connectAndCreate() {
  try {
    await connectWS();
    send({ type: 'create_room' });
  } catch (err) {
    console.error('Failed to connect:', err);
    showMenuError('Could not connect to server. Please try again.');
  }
}

async function connectAndJoin(code) {
  try {
    await connectWS();
    send({ type: 'join_room', code });
  } catch (err) {
    console.error('Failed to connect:', err);
    showMenuError('Could not connect to server. Please try again.');
  }
}

document.getElementById('create-btn').addEventListener('click', connectAndCreate);

document.getElementById('join-btn').addEventListener('click', () => {
  const code = document.getElementById('join-code-input').value.toUpperCase().trim();
  if (code.length === 4) connectAndJoin(code);
});

document.getElementById('join-code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('join-btn').click();
});

document.getElementById('start-btn').addEventListener('click', () => {
  send({ type: 'start_game' });
});

document.getElementById('copy-link-btn').addEventListener('click', () => {
  const url = `${location.origin}/games/quiz-battle/?room=${roomCode}`;
  const btn = document.getElementById('copy-link-btn');

  function onCopied() {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy Invite Link'; }, 2000);
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try {
      const ok = document.execCommand('copy');
      if (ok) onCopied();
      else prompt('Share this link:', text);
    } catch (_) {
      prompt('Share this link:', text);
    }
    document.body.removeChild(ta);
  }

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(onCopied).catch(() => fallbackCopy(url));
  } else {
    fallbackCopy(url);
  }
});

document.getElementById('next-round-btn').addEventListener('click', () => {
  if (!isHost) return;
  document.getElementById('next-round-btn').disabled = true;
  send({ type: 'next_round' });
});

document.getElementById('end-game-btn').addEventListener('click', () => {
  if (!isHost) return;
  if (!confirm('End the game now and show final scores?')) return;
  const btn = document.getElementById('end-game-btn');
  btn.disabled = true;
  btn.textContent = 'Ending…';
  send({ type: 'end_game' });
});

document.getElementById('play-again-btn').addEventListener('click', async () => {
  if (ws) ws.close();
  ws = null;
  roomCode = null;
  roomState = null;
  // Refresh streak display from the latest persisted values.
  try {
    const data = await api('/me');
    if (data.user) {
      currentUser = data.user;
      refreshMenuForCurrentUser();
    }
  } catch (_) {}
  showScreen('menu');
});

// ── Helpers ────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ── Init ───────────────────────────────────────────────
checkAuth();
