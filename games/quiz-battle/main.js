// Quiz Battle — Pre-configured quiz multiplayer client.

const API = '/api/chesnuts';

// ── State ──────────────────────────────────────────────
let csrfToken = null;
let currentUser = null;
let ws = null;
let roomCode = null;
let roomState = null;
let isHost = false;
let hasVotedFinish = false;

// Editor state
let editingQuizId = null;
let editingQuiz = null;
let editingQuestionId = null;
let qFormState = freshQFormState();

// Battle state
let currentChallenge = null;
let myAnswerFree = '';
let myAnswerChoice = null;        // single: index | multiple: Set<index>
let answerSubmitted = false;

// ── DOM refs ───────────────────────────────────────────
const screens = {
  auth: document.getElementById('auth-screen'),
  menu: document.getElementById('menu-screen'),
  quizzes: document.getElementById('quizzes-screen'),
  quizEditor: document.getElementById('quiz-editor-screen'),
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

function freshQFormState() {
  return {
    type: 'free',
    prompt: '',
    freeAnswers: '',
    options: ['', ''],
    correctAnswers: [],
  };
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

// ── Back-link buttons ──────────────────────────────────
document.querySelectorAll('[data-target]').forEach(b => {
  b.addEventListener('click', () => showScreen(b.dataset.target));
});

// ══════════════════════════════════════════════════════
// QUIZ MANAGEMENT
// ══════════════════════════════════════════════════════

document.getElementById('manage-quizzes-btn').addEventListener('click', async () => {
  showScreen('quizzes');
  await loadQuizList();
});

async function loadQuizList() {
  const list = document.getElementById('quiz-list');
  const errEl = document.getElementById('quizzes-error');
  errEl.textContent = '';
  list.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const data = await api('/quizzes');
    renderQuizList(data.quizzes);
  } catch (err) {
    list.innerHTML = '';
    errEl.textContent = err.message;
  }
}

function renderQuizList(quizzes) {
  const list = document.getElementById('quiz-list');
  list.innerHTML = '';
  if (quizzes.length === 0) {
    list.innerHTML = '<div class="empty-state">No quizzes yet. Create one below!</div>';
    return;
  }
  for (const q of quizzes) {
    const li = document.createElement('li');
    li.className = 'quiz-row';
    li.innerHTML = `
      <span class="quiz-name">${escapeHtml(q.name)}</span>
      <span class="quiz-meta">${q.questionCount} q</span>
      <button class="icon-btn" title="Delete">&times;</button>
    `;
    li.querySelector('.quiz-name').addEventListener('click', () => openQuizEditor(q.id));
    li.querySelector('.icon-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete quiz "${q.name}"?`)) return;
      try {
        await api(`/quizzes/${q.id}`, { method: 'DELETE' });
        await loadQuizList();
      } catch (err) {
        document.getElementById('quizzes-error').textContent = err.message;
      }
    });
    list.appendChild(li);
  }
}

document.getElementById('new-quiz-btn').addEventListener('click', async () => {
  const input = document.getElementById('new-quiz-name');
  const name = input.value.trim();
  const errEl = document.getElementById('quizzes-error');
  errEl.textContent = '';
  if (!name) { errEl.textContent = 'Enter a quiz name'; return; }
  try {
    const data = await api('/quizzes', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    input.value = '';
    openQuizEditor(data.quiz.id);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

// ── Quiz editor ────────────────────────────────────────
async function openQuizEditor(quizId) {
  editingQuizId = quizId;
  editingQuestionId = null;
  qFormState = freshQFormState();
  showScreen('quizEditor');
  await reloadEditingQuiz();
  renderQForm();
}

async function reloadEditingQuiz() {
  const titleEl = document.getElementById('quiz-editor-title');
  const metaEl = document.getElementById('quiz-editor-meta');
  try {
    const data = await api(`/quizzes/${editingQuizId}`);
    editingQuiz = data.quiz;
    titleEl.textContent = editingQuiz.name;
    metaEl.textContent = `${editingQuiz.questions.length} question${editingQuiz.questions.length === 1 ? '' : 's'}`;
    renderQuestions();
  } catch (err) {
    titleEl.textContent = 'Error';
    metaEl.textContent = err.message;
  }
}

document.getElementById('quiz-editor-back').addEventListener('click', () => {
  editingQuizId = null;
  editingQuiz = null;
  showScreen('quizzes');
  loadQuizList();
});

function renderQuestions() {
  const list = document.getElementById('question-list');
  list.innerHTML = '';
  if (!editingQuiz.questions.length) {
    list.innerHTML = '<div class="empty-state">No questions yet. Add one below!</div>';
    return;
  }
  editingQuiz.questions.forEach((q, i) => {
    const li = document.createElement('li');
    li.className = 'question-card';

    const answerSummary = q.type === 'free'
      ? `Accepts: ${q.correctAnswers.join(' / ')}`
      : q.options
        .map((o, idx) => `${q.correctAnswers.includes(idx) ? '✓' : '·'} ${o}`)
        .join(' · ');

    li.innerHTML = `
      <div class="question-head">
        <span class="question-pos">${i + 1}</span>
        <span class="question-type-tag">${q.type}</span>
      </div>
      <div class="question-prompt">${escapeHtml(q.prompt)}</div>
      <div class="question-answers">${escapeHtml(answerSummary)}</div>
      <div class="question-actions">
        <button class="btn btn-secondary btn-small" data-act="up" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
        <button class="btn btn-secondary btn-small" data-act="down" ${i === editingQuiz.questions.length - 1 ? 'disabled' : ''}>&darr;</button>
        <button class="btn btn-secondary btn-small" data-act="edit">Edit</button>
        <button class="btn btn-danger btn-small" data-act="delete">Delete</button>
      </div>
    `;
    li.querySelector('[data-act="up"]').addEventListener('click', () => moveQuestion(q.id, -1));
    li.querySelector('[data-act="down"]').addEventListener('click', () => moveQuestion(q.id, 1));
    li.querySelector('[data-act="edit"]').addEventListener('click', () => startEditQuestion(q));
    li.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirm('Delete this question?')) return;
      try {
        await api(`/quizzes/${editingQuizId}/questions/${q.id}`, { method: 'DELETE' });
        await reloadEditingQuiz();
      } catch (err) {
        document.getElementById('q-form-error').textContent = err.message;
      }
    });
    list.appendChild(li);
  });
}

async function moveQuestion(qId, delta) {
  const ids = editingQuiz.questions.map(q => q.id);
  const i = ids.indexOf(qId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try {
    await api(`/quizzes/${editingQuizId}/questions/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ order: ids }),
    });
    await reloadEditingQuiz();
  } catch (err) {
    document.getElementById('q-form-error').textContent = err.message;
  }
}

function startEditQuestion(q) {
  editingQuestionId = q.id;
  qFormState = {
    type: q.type,
    prompt: q.prompt,
    freeAnswers: q.type === 'free' ? q.correctAnswers.join('\n') : '',
    options: q.type === 'free' ? ['', ''] : [...q.options],
    correctAnswers: q.type === 'free' ? [] : [...q.correctAnswers],
  };
  renderQForm();
  document.getElementById('q-prompt').focus();
}

function resetQForm() {
  editingQuestionId = null;
  qFormState = freshQFormState();
  document.getElementById('q-form-error').textContent = '';
  renderQForm();
}

// ── Question form rendering / handlers ─────────────────
function renderQForm() {
  document.getElementById('q-prompt').value = qFormState.prompt;
  document.getElementById('q-type').value = qFormState.type;
  document.getElementById('q-free-answers').value = qFormState.freeAnswers;

  const isFree = qFormState.type === 'free';
  document.getElementById('q-free-area').style.display = isFree ? '' : 'none';
  document.getElementById('q-choice-area').style.display = isFree ? 'none' : '';
  if (!isFree) renderOptions();

  document.getElementById('q-save-btn').textContent = editingQuestionId ? 'Save Changes' : 'Add Question';
  document.getElementById('q-cancel-btn').style.display = editingQuestionId ? '' : 'none';
}

function renderOptions() {
  const wrap = document.getElementById('q-options');
  wrap.innerHTML = '';
  qFormState.options.forEach((opt, idx) => {
    const row = document.createElement('div');
    row.className = 'option-row';
    const inputType = qFormState.type === 'multiple' ? 'checkbox' : 'radio';
    const checked = qFormState.correctAnswers.includes(idx);
    row.innerHTML = `
      <input type="${inputType}" name="q-correct" ${checked ? 'checked' : ''}>
      <input type="text" class="input-field" placeholder="Option ${idx + 1}">
      <button type="button" class="icon-btn" title="Remove">&times;</button>
    `;
    const [check, text, remove] = row.children;
    text.value = opt;
    text.addEventListener('input', () => { qFormState.options[idx] = text.value; });
    check.addEventListener('change', () => {
      if (qFormState.type === 'single') {
        qFormState.correctAnswers = [idx];
      } else {
        const set = new Set(qFormState.correctAnswers);
        if (check.checked) set.add(idx); else set.delete(idx);
        qFormState.correctAnswers = [...set].sort((a, b) => a - b);
      }
      // Re-render to update radio group
      if (qFormState.type === 'single') renderOptions();
    });
    remove.addEventListener('click', () => {
      if (qFormState.options.length <= 2) return;
      qFormState.options.splice(idx, 1);
      qFormState.correctAnswers = qFormState.correctAnswers
        .filter(i => i !== idx)
        .map(i => i > idx ? i - 1 : i);
      renderOptions();
    });
    wrap.appendChild(row);
  });
}

document.getElementById('q-prompt').addEventListener('input', (e) => {
  qFormState.prompt = e.target.value;
});

document.getElementById('q-type').addEventListener('change', (e) => {
  qFormState.type = e.target.value;
  if (qFormState.type === 'single') {
    qFormState.correctAnswers = qFormState.correctAnswers.slice(0, 1);
  }
  renderQForm();
});

document.getElementById('q-free-answers').addEventListener('input', (e) => {
  qFormState.freeAnswers = e.target.value;
});

document.getElementById('q-add-option').addEventListener('click', () => {
  if (qFormState.options.length >= 10) return;
  qFormState.options.push('');
  renderOptions();
});

document.getElementById('q-cancel-btn').addEventListener('click', resetQForm);

document.getElementById('q-save-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('q-form-error');
  errEl.textContent = '';

  const payload = { prompt: qFormState.prompt, type: qFormState.type };
  if (qFormState.type === 'free') {
    payload.correctAnswers = qFormState.freeAnswers
      .split('\n').map(s => s.trim()).filter(Boolean);
  } else {
    payload.options = qFormState.options.map(o => o.trim());
    payload.correctAnswers = qFormState.correctAnswers;
  }

  try {
    if (editingQuestionId) {
      await api(`/quizzes/${editingQuizId}/questions/${editingQuestionId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    } else {
      await api(`/quizzes/${editingQuizId}/questions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    resetQForm();
    await reloadEditingQuiz();
  } catch (err) {
    errEl.textContent = err.message;
  }
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
    case 'vote_update': handleVoteUpdate(msg); break;
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
  hasVotedFinish = false;

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

  document.getElementById('vote-info').textContent = '';

  // If quiz is exhausted, hide Next and rename it
  const nextBtn = document.getElementById('next-round-btn');
  if (msg.hasMoreQuestions === false) {
    nextBtn.textContent = 'See Final Scores';
  } else {
    nextBtn.textContent = 'Next Question';
  }
  nextBtn.disabled = false;

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
      list.innerHTML = '<div class="empty-state">No quizzes yet. Go to "Manage Quizzes" from the menu first.</div>';
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
  document.getElementById('next-round-btn').disabled = true;
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

document.getElementById('play-again-btn').addEventListener('click', () => {
  if (ws) ws.close();
  ws = null;
  roomCode = null;
  roomState = null;
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
