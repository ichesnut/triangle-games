// Math Battle — Real-time multiplayer math game client

const API = '/api/chesnuts';

// ── State ──────────────────────────────────────────────
let csrfToken = null;
let currentUser = null;
let ws = null;
let roomCode = null;
let roomState = null; // full room state from server
let myAnswer = '';
let answerSubmitted = false;
let isHost = false;
let hasVotedFinish = false;

// ── DOM refs ───────────────────────────────────────────
const screens = {
  auth: document.getElementById('auth-screen'),
  menu: document.getElementById('menu-screen'),
  lobby: document.getElementById('lobby-screen'),
  battle: document.getElementById('battle-screen'),
  result: document.getElementById('result-screen'),
  scoreboard: document.getElementById('scoreboard-screen'),
};

const flash = document.getElementById('flash-overlay');

// ── Screen management ──────────────────────────────────
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
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
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
  } catch (_) { /* not logged in */ }
  loadingMsg.style.display = 'none';
  authForms.style.display = 'flex';
}

function onAuthenticated() {
  document.getElementById('welcome-msg').textContent = `Welcome, ${currentUser.displayName}!`;
  showScreen('menu');

  // Auto-join from URL param
  const params = new URLSearchParams(window.location.search);
  const joinCode = params.get('room');
  if (joinCode) {
    document.getElementById('join-code-input').value = joinCode;
    connectAndJoin(joinCode.toUpperCase());
  }
}

// Auth tab switching
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`${tab.dataset.tab}-form`).classList.add('active');
  });
});

// Login form
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

// Register form
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

// ── WebSocket ──────────────────────────────────────────
function connectWS() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/math-battle`);

    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WebSocket connection failed'));

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      // If we're in an active game, try to reconnect
      if (roomCode && screens.battle.classList.contains('active')) {
        setTimeout(() => {
          connectAndJoin(roomCode).catch(() => {
            showScreen('menu');
          });
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

// ── Server message handler ─────────────────────────────
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'room_state':
      handleRoomState(msg);
      break;

    case 'player_joined':
      handlePlayerJoined(msg);
      break;

    case 'player_left':
      handleRoomState(msg); // contains full state
      break;

    case 'round_start':
      handleRoundStart(msg);
      break;

    case 'answer_received':
      handleAnswerReceived(msg);
      break;

    case 'round_result':
      handleRoundResult(msg);
      break;

    case 'vote_update':
      handleVoteUpdate(msg);
      break;

    case 'game_over':
      handleGameOver(msg);
      break;

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
    // Add to player list
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
  myAnswer = '';
  answerSubmitted = false;
  hasVotedFinish = false;

  document.getElementById('round-info').textContent = `Round ${msg.currentRound}`;
  document.getElementById('challenge-text').textContent = msg.currentChallenge.prompt;
  document.getElementById('answer-display').textContent = '\u00A0';
  document.getElementById('battle-waiting').style.display = 'none';
  enableNumpad(true);
  renderScoresBar(document.getElementById('scores-bar'), msg.players);
  showScreen('battle');
}

function handleAnswerReceived(msg) {
  answerSubmitted = true;
  enableNumpad(false);
  document.getElementById('battle-waiting').style.display = '';

  // Flash feedback
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
    `${msg.challenge} = ${msg.correctAnswer}`;

  document.getElementById('result-time').textContent = msg.timeTaken
    ? `Answered in ${(msg.timeTaken / 1000).toFixed(2)}s`
    : '';

  // Build scores list for result
  const players = roomState?.players || [];
  const updatedPlayers = players.map(p => ({
    ...p,
    score: msg.scores[p.userId] || 0,
  }));
  renderScoresBar(document.getElementById('result-scores'), updatedPlayers);

  // Update roomState scores
  if (roomState) {
    roomState.players = updatedPlayers;
  }

  document.getElementById('vote-info').textContent = '';
  showScreen('result');
}

function handleVoteUpdate(msg) {
  document.getElementById('vote-info').textContent =
    `${msg.voterName} voted to finish. ${msg.votesNeeded} more vote${msg.votesNeeded !== 1 ? 's' : ''} needed.`;
}

function handleGameOver(msg) {
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
    li.innerHTML = `<span>${p.displayName}</span>${p.isHost ? '<span class="host-badge">HOST</span>' : ''}`;
    list.appendChild(li);
  }

  const startBtn = document.getElementById('start-btn');
  startBtn.disabled = !isHost || roomState.players.length < 2;
  document.getElementById('lobby-status').textContent = isHost
    ? (roomState.players.length < 2 ? 'Waiting for players...' : 'Ready to start!')
    : 'Waiting for host to start...';
}

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

  // Build player array sorted by score desc
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
      <span class="scoreboard-name">${p.displayName}${p.userId === currentUser.id ? ' (You)' : ''}</span>
      <span class="scoreboard-stats">
        ${p.score} won<br>
        <span class="chesnuts">+${p.chesnuts} chesnuts</span>
      </span>
    `;
    list.appendChild(row);
  });
}

// ── Visual feedback ────────────────────────────────────
function showFlash(type) {
  flash.className = `flash-overlay ${type}`;
  setTimeout(() => { flash.className = 'flash-overlay'; }, 400);
}

// ── Numpad ─────────────────────────────────────────────
function enableNumpad(enabled) {
  document.querySelectorAll('.numpad-btn').forEach(btn => {
    btn.disabled = !enabled;
  });
}

document.getElementById('numpad').addEventListener('click', (e) => {
  const btn = e.target.closest('.numpad-btn');
  if (!btn || btn.disabled || answerSubmitted) return;

  const val = btn.dataset.val;

  if (val === 'submit') {
    if (myAnswer === '' || myAnswer === '-') return;
    send({ type: 'submit_answer', answer: Number(myAnswer) });
    return;
  }

  if (val === 'back') {
    myAnswer = myAnswer.slice(0, -1);
  } else if (val === 'neg') {
    // Toggle negative sign
    if (myAnswer.startsWith('-')) {
      myAnswer = myAnswer.slice(1);
    } else {
      myAnswer = '-' + myAnswer;
    }
  } else {
    // Prevent leading zeros
    if (myAnswer === '0') myAnswer = '';
    if (myAnswer === '-0') myAnswer = '-';
    myAnswer += val;
  }

  document.getElementById('answer-display').textContent = myAnswer || '\u00A0';
});

// ── Menu error display ────────────────────────────────
function showMenuError(msg) {
  const el = document.getElementById('menu-error');
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 5000);
}

// ── Create / Join ──────────────────────────────────────
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
  if (code.length === 4) {
    connectAndJoin(code);
  }
});

// Allow Enter key on join code input
document.getElementById('join-code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    document.getElementById('join-btn').click();
  }
});

// ── Lobby actions ──────────────────────────────────────
document.getElementById('start-btn').addEventListener('click', () => {
  send({ type: 'start_game' });
});

document.getElementById('copy-link-btn').addEventListener('click', () => {
  const url = `${location.origin}/games/math-battle/?room=${roomCode}`;
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
    ta.focus();
    ta.select();
    try {
      const ok = document.execCommand('copy');
      if (ok) { onCopied(); } else { prompt('Share this link:', text); }
    } catch (_) {
      prompt('Share this link:', text);
    }
    document.body.removeChild(ta);
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(onCopied).catch(() => fallbackCopy(url));
  } else {
    fallbackCopy(url);
  }
});

// ── Round result actions ───────────────────────────────
document.getElementById('next-round-btn').addEventListener('click', () => {
  send({ type: 'next_round' });
});

document.getElementById('vote-finish-btn').addEventListener('click', () => {
  if (!hasVotedFinish) {
    hasVotedFinish = true;
    send({ type: 'vote_finish' });
    document.getElementById('vote-finish-btn').disabled = true;
    document.getElementById('vote-finish-btn').textContent = 'Voted';
  }
});

// ── Play Again ─────────────────────────────────────────
document.getElementById('play-again-btn').addEventListener('click', () => {
  // Close existing connection and go back to menu
  if (ws) ws.close();
  ws = null;
  roomCode = null;
  roomState = null;
  showScreen('menu');
});

// ── Init ───────────────────────────────────────────────
checkAuth();
