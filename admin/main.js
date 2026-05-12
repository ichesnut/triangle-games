const API = '/api/chesnuts';

const els = {
  loading: document.getElementById('loading'),
  appShell: document.getElementById('app-shell'),
  denied: document.getElementById('denied'),
  me: document.getElementById('me'),
  sidebar: document.getElementById('sidebar'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  sidebarNav: document.getElementById('sidebar-nav'),
  menuToggle: document.getElementById('menu-toggle'),
  mobileTitle: document.getElementById('mobile-section-title'),
  sections: document.querySelectorAll('.app-section'),
  navButtons: document.querySelectorAll('.nav-btn'),
  quizzesSection: document.querySelector('.app-section[data-section="quizzes"]'),
  list: document.getElementById('user-list'),
  registerForm: document.getElementById('register-form'),
  registerMsg: document.getElementById('register-msg'),
  usersMsg: document.getElementById('users-msg'),
  usersMeta: document.getElementById('users-section-meta'),
  quizList: document.getElementById('quiz-list'),
  quizzesMsg: document.getElementById('quizzes-msg'),
  quizzesMeta: document.getElementById('quizzes-section-meta'),
  newQuizName: document.getElementById('new-quiz-name'),
  newQuizBtn: document.getElementById('new-quiz-btn'),
  gameList: document.getElementById('game-list'),
  gamesMsg: document.getElementById('games-msg'),
  gamesMeta: document.getElementById('games-section-meta'),
  activeRoomList: document.getElementById('active-room-list'),
  activeRoomsMsg: document.getElementById('active-rooms-msg'),
  refreshActiveRoomsBtn: document.getElementById('refresh-active-rooms-btn'),
  editor: document.getElementById('quiz-editor'),
  editorTitle: document.getElementById('editor-title'),
  editorMeta: document.getElementById('editor-meta'),
  editorBack: document.getElementById('editor-back'),
  editorRenameInput: document.getElementById('editor-rename-input'),
  editorRenameBtn: document.getElementById('editor-rename-btn'),
  editorRenameMsg: document.getElementById('editor-rename-msg'),
  categoryList: document.getElementById('category-list'),
  newCategoryName: document.getElementById('new-category-name'),
  newCategoryBtn: document.getElementById('new-category-btn'),
  categoryMsg: document.getElementById('category-msg'),
  questionList: document.getElementById('question-list'),
  qFormHead: document.getElementById('q-form-head'),
  qPrompt: document.getElementById('q-prompt'),
  qCategory: document.getElementById('q-category'),
  qType: document.getElementById('q-type'),
  qFreeArea: document.getElementById('q-free-area'),
  qFreeAnswers: document.getElementById('q-free-answers'),
  qChoiceArea: document.getElementById('q-choice-area'),
  qOptions: document.getElementById('q-options'),
  qAddOption: document.getElementById('q-add-option'),
  qFormMsg: document.getElementById('q-form-msg'),
  qSaveBtn: document.getElementById('q-save-btn'),
  qCancelBtn: document.getElementById('q-cancel-btn'),
};

let csrfToken = null;
let currentUser = null;

let editingQuizId = null;
let editingQuiz = null;
let editingQuestionId = null;
let qFormState = freshQFormState();

function freshQFormState() {
  return {
    type: 'free',
    prompt: '',
    categoryId: null,
    freeAnswers: '',
    options: ['', ''],
    correctAnswers: [],
  };
}

async function fetchJson(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.method && opts.method !== 'GET' && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  const res = await fetch(url, { credentials: 'same-origin', ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function setMsg(el, text, kind = '') {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(s) {
  if (!s) return '—';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDurationMs(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function renderWinner(winner) {
  if (!winner) return '<span class="dim">—</span>';
  const name = escapeHtml(winner.displayName || (winner.userId ? `User #${winner.userId}` : 'Guest'));
  const tag = winner.source === 'guest' ? ' <span class="badge badge-disabled">Guest</span>' : '';
  const rounds = winner.roundsWon != null
    ? ` (${winner.roundsWon} round${winner.roundsWon === 1 ? '' : 's'})`
    : '';
  return `${name}${tag}${rounds}`;
}

function renderUsers(users) {
  if (!users.length) {
    els.list.innerHTML = '<li class="empty">No users yet.</li>';
    return;
  }

  els.list.innerHTML = users.map(u => {
    const isMe = u.id === currentUser.id;
    const disabled = !!u.disabledAt;
    const archived = !!u.archivedAt;
    const badges = [
      isMe ? '<span class="badge badge-me">You</span>' : '',
      u.isAdmin ? '<span class="badge badge-admin">Admin</span>' : '',
      disabled ? '<span class="badge badge-disabled">Disabled</span>' : '',
      archived ? '<span class="badge badge-disabled">Archived</span>' : '',
    ].filter(Boolean).join(' ');

    const actions = [];
    actions.push(`<button class="btn btn-secondary btn-small" data-act="pwd" data-id="${u.id}">Change Password</button>`);
    if (!isMe) {
      actions.push(`<button class="btn btn-secondary btn-small" data-act="admin" data-id="${u.id}" data-val="${u.isAdmin ? 0 : 1}">${u.isAdmin ? 'Revoke Admin' : 'Make Admin'}</button>`);
      if (disabled) {
        actions.push(`<button class="btn btn-success btn-small" data-act="enable" data-id="${u.id}">Re-enable</button>`);
      } else {
        actions.push(`<button class="btn btn-danger btn-small" data-act="disable" data-id="${u.id}">Disable</button>`);
      }
      if (archived) {
        actions.push(`<button class="btn btn-success btn-small" data-act="unarchive" data-id="${u.id}">Unarchive</button>`);
      } else {
        actions.push(`<button class="btn btn-secondary btn-small" data-act="archive" data-id="${u.id}">Archive</button>`);
      }
    }

    return `
      <li class="user-row ${disabled || archived ? 'disabled' : ''}" data-id="${u.id}">
        <div class="user-head">
          <span class="user-name">${escapeHtml(u.displayName)}</span>
          <span class="user-email">${escapeHtml(u.email)}</span>
          ${badges}
        </div>
        <div class="user-meta">
          Chesnuts: ${u.chesnutBalance ?? 0} ·
          Streak: ${u.currentStreak ?? 0} (best ${u.bestStreak ?? 0}) ·
          Joined ${fmtDate(u.createdAt)}
          ${disabled ? ` · Disabled ${fmtDate(u.disabledAt)}` : ''}
          ${archived ? ` · Archived ${fmtDate(u.archivedAt)}` : ''}
        </div>
        <div class="user-actions">${actions.join('')}</div>
        <form class="pwd-form" data-pwd-form="${u.id}">
          <input type="text" name="password" placeholder="New password (min 6)" autocomplete="new-password" required minlength="6">
          <button type="submit" class="btn btn-primary btn-small">Save</button>
          <button type="button" class="btn btn-secondary btn-small" data-act="cancel-pwd" data-id="${u.id}">Cancel</button>
        </form>
      </li>
    `;
  }).join('');
}

async function loadUsers() {
  setMsg(els.usersMsg, '');
  try {
    const { users } = await fetchJson(`${API}/admin/users`);
    renderUsers(users);
    const active = users.filter(u => !u.disabledAt && !u.archivedAt).length;
    setNavCount('users', users.length);
    if (els.usersMeta) {
      els.usersMeta.textContent = `${users.length} total · ${active} active`;
    }
  } catch (err) {
    setMsg(els.usersMsg, err.message, 'error');
  }
}

function renderQuizzes(quizzes) {
  if (!quizzes.length) {
    els.quizList.innerHTML = '<li class="empty">No quizzes yet.</li>';
    return;
  }

  els.quizList.innerHTML = quizzes.map(q => {
    const owner = q.ownerDisplayName
      ? `${escapeHtml(q.ownerDisplayName)} <span class="user-email">&lt;${escapeHtml(q.ownerEmail || '')}&gt;</span>`
      : '<span class="user-email">(owner missing)</span>';
    const archived = !!q.archivedAt;
    const badge = archived
      ? '<span class="badge badge-disabled">Archived</span>'
      : '';
    const archiveBtn = archived
      ? `<button class="btn btn-success btn-small" data-act="unarchive" data-id="${q.id}">Unarchive</button>`
      : `<button class="btn btn-secondary btn-small" data-act="archive" data-id="${q.id}">Archive</button>`;
    const editBtn = `<button class="btn btn-secondary btn-small" data-act="edit" data-id="${q.id}">Edit</button>`;
    const deleteBtn = `<button class="btn btn-danger btn-small" data-act="delete" data-id="${q.id}">Delete</button>`;
    return `
      <li class="user-row ${archived ? 'disabled' : ''}" data-id="${q.id}">
        <div class="user-head">
          <span class="user-name">${escapeHtml(q.name)}</span>
          ${badge}
        </div>
        <div class="user-meta">
          ${q.questionCount} question${q.questionCount === 1 ? '' : 's'} ·
          owned by ${owner} ·
          Created ${fmtDate(q.createdAt)}
          ${archived ? ` · Archived ${fmtDate(q.archivedAt)}` : ''}
        </div>
        <div class="user-actions">${editBtn} ${archiveBtn} ${deleteBtn}</div>
      </li>
    `;
  }).join('');
}

async function loadQuizzes() {
  setMsg(els.quizzesMsg, '');
  try {
    const { quizzes } = await fetchJson(`${API}/admin/quizzes`);
    renderQuizzes(quizzes);
    const active = quizzes.filter(q => !q.archivedAt).length;
    setNavCount('quizzes', quizzes.length);
    if (els.quizzesMeta) {
      els.quizzesMeta.textContent = `${quizzes.length} total · ${active} active`;
    }
  } catch (err) {
    setMsg(els.quizzesMsg, err.message, 'error');
  }
}

els.quizList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = parseInt(btn.dataset.id, 10);
  const act = btn.dataset.act;
  setMsg(els.quizzesMsg, '');
  try {
    if (act === 'archive') {
      if (!confirm('Archive this quiz? Players will no longer see it.')) return;
      await fetchJson(`${API}/admin/quizzes/${id}/archive`, { method: 'POST' });
    } else if (act === 'unarchive') {
      await fetchJson(`${API}/admin/quizzes/${id}/unarchive`, { method: 'POST' });
    } else if (act === 'delete') {
      if (!confirm('Delete this quiz? This removes all questions and cannot be undone.')) return;
      await fetchJson(`${API}/quizzes/${id}`, { method: 'DELETE' });
    } else if (act === 'edit') {
      openQuizEditor(id);
      return;
    } else {
      return;
    }
    await loadQuizzes();
  } catch (err) {
    setMsg(els.quizzesMsg, err.message, 'error');
  }
});

els.newQuizBtn.addEventListener('click', async () => {
  setMsg(els.quizzesMsg, '');
  const name = els.newQuizName.value.trim();
  if (!name) {
    setMsg(els.quizzesMsg, 'Enter a quiz name.', 'error');
    return;
  }
  try {
    const { quiz } = await fetchJson(`${API}/quizzes`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    els.newQuizName.value = '';
    await loadQuizzes();
    openQuizEditor(quiz.id);
  } catch (err) {
    setMsg(els.quizzesMsg, err.message, 'error');
  }
});

els.newQuizName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); els.newQuizBtn.click(); }
});

function renderGames(games) {
  if (!games.length) {
    els.gameList.innerHTML = '<li class="empty">No games played yet.</li>';
    return;
  }

  els.gameList.innerHTML = games.map(g => {
    const winner = renderWinner(g.winner);
    const quiz = g.quizName ? escapeHtml(g.quizName) : '<span class="user-email">(quiz unknown)</span>';
    const archived = !!g.archivedAt;
    const badge = archived
      ? '<span class="badge badge-disabled">Archived</span>'
      : '';
    const archiveBtn = archived
      ? `<button class="btn btn-success btn-small" data-act="unarchive-game" data-id="${g.id}">Unarchive</button>`
      : `<button class="btn btn-secondary btn-small" data-act="archive-game" data-id="${g.id}">Archive</button>`;
    return `
      <li class="user-row ${archived ? 'disabled' : ''}" data-game-id="${g.id}">
        <div class="user-head">
          <span class="user-name">${quiz}</span>
          <span class="user-email">Room ${escapeHtml(g.roomCode)}</span>
          ${badge}
        </div>
        <div class="user-meta">
          ${fmtDateTime(g.startedAt || g.finishedAt)} ·
          ${fmtDurationMs(g.durationMs)} ·
          ${g.totalRounds} round${g.totalRounds === 1 ? '' : 's'} ·
          ${g.playerCount} player${g.playerCount === 1 ? '' : 's'} ·
          Winner: ${winner}
          ${archived ? ` · Archived ${fmtDate(g.archivedAt)}` : ''}
        </div>
        <div class="user-actions">
          <button class="btn btn-secondary btn-small" data-act="toggle-game" data-id="${g.id}">View details</button>
          ${archiveBtn}
        </div>
        <div class="game-detail" data-game-detail="${g.id}"></div>
      </li>
    `;
  }).join('');
}

function renderActiveRooms(rooms) {
  if (!rooms.length) {
    els.activeRoomList.innerHTML = '<li class="empty">No games in progress.</li>';
    return;
  }
  els.activeRoomList.innerHTML = rooms.map(r => {
    const quiz = r.quiz
      ? `${escapeHtml(r.quiz.name)} (${r.quiz.questionCount} q)`
      : '<span class="user-email">(no quiz selected)</span>';
    const host = r.hostDisplayName
      ? escapeHtml(r.hostDisplayName)
      : `User #${r.hostUserId}`;
    const stateBadge = r.state === 'playing'
      ? '<span class="badge badge-admin">Playing</span>'
      : '<span class="badge badge-disabled">Lobby</span>';
    const roundInfo = r.state === 'playing' && r.quiz
      ? `Round ${r.currentRound} / ${r.quiz.questionCount}`
      : '';
    const playerNames = r.players
      .map(p => escapeHtml(p.displayName || `User #${p.userId}`))
      .join(', ');
    const endBtn = r.state === 'playing'
      ? `<button class="btn btn-danger btn-small" data-act="end-room" data-code="${escapeHtml(r.code)}">End Game</button>`
      : '';
    return `
      <li class="user-row" data-code="${escapeHtml(r.code)}">
        <div class="user-head">
          <span class="user-name">Room ${escapeHtml(r.code)}</span>
          ${stateBadge}
        </div>
        <div class="user-meta">
          Host: ${host} ·
          Quiz: ${quiz}
          ${roundInfo ? ` · ${roundInfo}` : ''}
          ${r.startedAt ? ` · Started ${fmtDateTime(new Date(r.startedAt).toISOString().slice(0, 19).replace('T', ' '))}` : ''}
        </div>
        <div class="user-meta">Players (${r.players.length}): ${playerNames || '<em>none</em>'}</div>
        <div class="user-actions">${endBtn}</div>
      </li>
    `;
  }).join('');
}

async function loadActiveRooms() {
  setMsg(els.activeRoomsMsg, '');
  try {
    const { rooms } = await fetchJson(`${API}/admin/active-rooms`);
    renderActiveRooms(rooms);
    setNavCount('active-games', rooms.length);
  } catch (err) {
    setMsg(els.activeRoomsMsg, err.message, 'error');
  }
}

async function loadGames() {
  setMsg(els.gamesMsg, '');
  try {
    const { games } = await fetchJson(`${API}/admin/games`);
    renderGames(games);
    const active = games.filter(g => !g.archivedAt).length;
    setNavCount('games', games.length);
    if (els.gamesMeta) {
      els.gamesMeta.textContent = `${games.length} total · ${active} active`;
    }
  } catch (err) {
    setMsg(els.gamesMsg, err.message, 'error');
  }
}

function renderGameDetail(detail) {
  const winnerLine = `<div class="detail-winner">Winner: ${renderWinner(detail.winner)}</div>`;
  const playersRows = detail.players.length
    ? detail.players.map(p => `
        <tr>
          <td>${escapeHtml(p.displayName || `User #${p.userId}`)}</td>
          <td class="dim">${escapeHtml(p.email || '')}</td>
          <td class="num">${p.roundsWon}</td>
          <td class="num">${p.chesnutsEarned}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4" class="dim">No registered players recorded.</td></tr>';

  const roundsRows = detail.rounds.length
    ? detail.rounds.map(r => `
        <tr>
          <td class="num">${r.roundNumber}</td>
          <td>${escapeHtml(r.challenge)}</td>
          <td class="dim">${escapeHtml(r.correctAnswer)}</td>
          <td>${r.winnerDisplayName ? escapeHtml(r.winnerDisplayName) : '<span class="dim">—</span>'}</td>
          <td class="num dim">${r.timeTakenMs != null ? fmtDurationMs(r.timeTakenMs) : '—'}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="5" class="dim">No rounds recorded.</td></tr>';

  return `
    ${winnerLine}
    <h3>Players</h3>
    <table class="detail-table">
      <thead><tr><th>Name</th><th>Email</th><th>Rounds Won</th><th>Chesnuts</th></tr></thead>
      <tbody>${playersRows}</tbody>
    </table>
    <h3>Rounds</h3>
    <table class="detail-table">
      <thead><tr><th>#</th><th>Challenge</th><th>Answer</th><th>Winner</th><th>Time</th></tr></thead>
      <tbody>${roundsRows}</tbody>
    </table>
  `;
}

async function toggleGameDetail(gameId, btn) {
  const panel = els.gameList.querySelector(`[data-game-detail="${gameId}"]`);
  if (!panel) return;
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
    btn.textContent = 'View details';
    return;
  }

  if (!panel.dataset.loaded) {
    panel.innerHTML = '<div class="empty">Loading…</div>';
    panel.classList.add('open');
    btn.textContent = 'Hide details';
    try {
      const { game } = await fetchJson(`${API}/admin/games/${gameId}`);
      panel.innerHTML = renderGameDetail(game);
      panel.dataset.loaded = '1';
    } catch (err) {
      panel.innerHTML = `<div class="msg error">${escapeHtml(err.message)}</div>`;
    }
  } else {
    panel.classList.add('open');
    btn.textContent = 'Hide details';
  }
}

async function init() {
  try {
    const csrfRes = await fetchJson(`${API}/csrf-token`);
    csrfToken = csrfRes.csrfToken;
  } catch {
    els.loading.textContent = 'Could not contact the server.';
    return;
  }

  let me;
  try {
    const r = await fetchJson(`${API}/me`);
    me = r.user;
  } catch {
    me = null;
  }

  if (!me) {
    els.loading.style.display = 'none';
    els.denied.style.display = 'block';
    els.denied.innerHTML = `
      <h1 style="margin-bottom:0.5rem">Sign in required</h1>
      <p>You need to be signed in as an admin to view this page.</p>
      <p style="margin-top:1rem"><a href="/games/quiz-battle/">Sign in</a> · <a href="/">Home</a></p>
    `;
    return;
  }

  if (!me.isAdmin) {
    els.loading.style.display = 'none';
    els.denied.style.display = 'block';
    return;
  }

  currentUser = me;
  els.me.innerHTML = `Signed in as <span class="name">${escapeHtml(me.displayName)}</span>`;
  els.loading.style.display = 'none';
  els.appShell.style.display = 'flex';

  setupNavigation();
  showSection(initialSectionFromHash());

  await Promise.all([loadUsers(), loadQuizzes(), loadGames(), loadActiveRooms()]);
}

// ── Navigation ────────────────────────────────────────

const SECTION_TITLES = {
  'users': 'Users',
  'quizzes': 'Quizzes',
  'active-games': 'Active Games',
  'games': 'Games',
};

function initialSectionFromHash() {
  const fromHash = (location.hash || '').replace(/^#/, '');
  return SECTION_TITLES[fromHash] ? fromHash : 'users';
}

function showSection(name) {
  if (!SECTION_TITLES[name]) name = 'users';
  if (name !== 'quizzes' && editingQuizId != null) {
    closeQuizEditor();
  }
  els.sections.forEach(s => {
    s.classList.toggle('active', s.dataset.section === name);
  });
  els.navButtons.forEach(b => {
    const isActive = b.dataset.section === name;
    b.classList.toggle('active', isActive);
    if (isActive) {
      b.setAttribute('aria-current', 'page');
    } else {
      b.removeAttribute('aria-current');
    }
  });
  els.mobileTitle.textContent = SECTION_TITLES[name];
  if (location.hash.replace(/^#/, '') !== name) {
    history.replaceState(null, '', `#${name}`);
  }
  closeDrawer();
}

const mobileMQ = window.matchMedia('(max-width: 760px)');

function isDrawerOpen() {
  return els.appShell.classList.contains('drawer-open');
}

function syncDrawerA11y(isOpen) {
  els.menuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  // On mobile the sidebar is translated off-screen but still focusable. Use
  // `inert` so screen-reader users and keyboard tabbing skip it while closed.
  if (mobileMQ.matches && !isOpen) {
    els.sidebar.setAttribute('inert', '');
  } else {
    els.sidebar.removeAttribute('inert');
  }
}

function setupNavigation() {
  els.sidebarNav.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-section]');
    if (!btn) return;
    showSection(btn.dataset.section);
  });
  els.menuToggle.addEventListener('click', () => {
    const isOpen = els.appShell.classList.toggle('drawer-open');
    syncDrawerA11y(isOpen);
  });
  els.sidebarBackdrop.addEventListener('click', closeDrawer);
  window.addEventListener('hashchange', () => {
    showSection(initialSectionFromHash());
  });

  mobileMQ.addEventListener('change', () => syncDrawerA11y(isDrawerOpen()));
  syncDrawerA11y(false);
}

function closeDrawer() {
  els.appShell.classList.remove('drawer-open');
  syncDrawerA11y(false);
}

function setNavCount(name, count) {
  const node = document.querySelector(`.nav-count[data-count="${name}"]`);
  if (node) node.textContent = count == null ? '—' : String(count);
}

els.refreshActiveRoomsBtn.addEventListener('click', loadActiveRooms);

els.activeRoomList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="end-room"]');
  if (!btn) return;
  const code = btn.dataset.code;
  if (!code) return;
  if (!confirm(`End game in room ${code}? Players will see a final scoreboard.`)) return;
  setMsg(els.activeRoomsMsg, '');
  btn.disabled = true;
  try {
    await fetchJson(`${API}/admin/active-rooms/${encodeURIComponent(code)}/end`, { method: 'POST' });
    setMsg(els.activeRoomsMsg, `Ended room ${code}.`, 'success');
    await Promise.all([loadActiveRooms(), loadGames()]);
  } catch (err) {
    btn.disabled = false;
    setMsg(els.activeRoomsMsg, err.message, 'error');
  }
});

els.gameList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = parseInt(btn.dataset.id, 10);

  if (act === 'toggle-game') {
    toggleGameDetail(id, btn);
    return;
  }

  if (act !== 'archive-game' && act !== 'unarchive-game') return;

  setMsg(els.gamesMsg, '');
  try {
    if (act === 'archive-game') {
      if (!confirm('Archive this game? It will be hidden from the games list.')) return;
      await fetchJson(`${API}/admin/games/${id}/archive`, { method: 'POST' });
    } else {
      await fetchJson(`${API}/admin/games/${id}/unarchive`, { method: 'POST' });
    }
    await loadGames();
  } catch (err) {
    setMsg(els.gamesMsg, err.message, 'error');
  }
});

els.registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setMsg(els.registerMsg, '');
  const data = new FormData(els.registerForm);
  const payload = {
    displayName: data.get('displayName')?.trim(),
    email: data.get('email')?.trim(),
    password: data.get('password'),
    isAdmin: !!data.get('isAdmin'),
  };
  try {
    await fetchJson(`${API}/admin/users`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setMsg(els.registerMsg, `Created ${payload.email}.`, 'success');
    els.registerForm.reset();
    await loadUsers();
  } catch (err) {
    setMsg(els.registerMsg, err.message, 'error');
  }
});

els.list.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = parseInt(btn.dataset.id, 10);
  const act = btn.dataset.act;

  if (act === 'pwd') {
    const form = els.list.querySelector(`form[data-pwd-form="${id}"]`);
    form.classList.toggle('open');
    if (form.classList.contains('open')) {
      form.querySelector('input[name=password]').focus();
    }
    return;
  }

  if (act === 'cancel-pwd') {
    const form = els.list.querySelector(`form[data-pwd-form="${id}"]`);
    form.classList.remove('open');
    form.reset();
    return;
  }

  setMsg(els.usersMsg, '');

  try {
    if (act === 'disable') {
      if (!confirm('Disable this user? They will not be able to log in.')) return;
      await fetchJson(`${API}/admin/users/${id}/disable`, { method: 'POST' });
    } else if (act === 'enable') {
      await fetchJson(`${API}/admin/users/${id}/enable`, { method: 'POST' });
    } else if (act === 'archive') {
      if (!confirm('Archive this user? They will not be able to log in and will be marked as archived.')) return;
      await fetchJson(`${API}/admin/users/${id}/archive`, { method: 'POST' });
    } else if (act === 'unarchive') {
      await fetchJson(`${API}/admin/users/${id}/unarchive`, { method: 'POST' });
    } else if (act === 'admin') {
      const isAdmin = btn.dataset.val === '1';
      const verb = isAdmin ? 'grant admin to' : 'remove admin from';
      if (!confirm(`Are you sure you want to ${verb} this user?`)) return;
      await fetchJson(`${API}/admin/users/${id}/admin`, {
        method: 'POST',
        body: JSON.stringify({ isAdmin }),
      });
    }
    await loadUsers();
  } catch (err) {
    setMsg(els.usersMsg, err.message, 'error');
  }
});

els.list.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-pwd-form]');
  if (!form) return;
  e.preventDefault();
  const id = parseInt(form.dataset.pwdForm, 10);
  const password = form.querySelector('input[name=password]').value;
  setMsg(els.usersMsg, '');
  try {
    await fetchJson(`${API}/admin/users/${id}/password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    form.reset();
    form.classList.remove('open');
    setMsg(els.usersMsg, 'Password updated.', 'success');
  } catch (err) {
    setMsg(els.usersMsg, err.message, 'error');
  }
});

// ── Quiz editor ─────────────────────────────────────────

async function openQuizEditor(quizId) {
  editingQuizId = quizId;
  editingQuestionId = null;
  qFormState = freshQFormState();
  setMsg(els.editorRenameMsg, '');
  setMsg(els.categoryMsg, '');
  setMsg(els.qFormMsg, '');
  showSection('quizzes');
  els.quizzesSection.classList.add('editor-open');
  els.editorTitle.textContent = 'Loading…';
  els.editorMeta.textContent = '';
  els.editorRenameInput.value = '';
  els.categoryList.innerHTML = '';
  els.questionList.innerHTML = '';
  await reloadEditingQuiz();
  renderQForm();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeQuizEditor() {
  editingQuizId = null;
  editingQuiz = null;
  editingQuestionId = null;
  qFormState = freshQFormState();
  els.quizzesSection.classList.remove('editor-open');
  loadQuizzes();
}

async function reloadEditingQuiz() {
  try {
    const { quiz } = await fetchJson(`${API}/quizzes/${editingQuizId}`);
    editingQuiz = quiz;
    els.editorTitle.textContent = quiz.name;
    els.editorRenameInput.value = quiz.name;
    const qCount = quiz.questions.length;
    const cCount = (quiz.categories || []).length;
    els.editorMeta.textContent =
      `${qCount} question${qCount === 1 ? '' : 's'} · ${cCount} categor${cCount === 1 ? 'y' : 'ies'}`;

    const cats = quiz.categories || [];
    if (qFormState.categoryId != null
        && !cats.some(c => c.id === qFormState.categoryId)) {
      qFormState.categoryId = null;
    }
    renderCategories();
    renderQuestions();
    renderCategoryOptions();
  } catch (err) {
    els.editorTitle.textContent = 'Error';
    els.editorMeta.textContent = err.message;
  }
}

els.editorBack.addEventListener('click', closeQuizEditor);

els.editorRenameBtn.addEventListener('click', async () => {
  setMsg(els.editorRenameMsg, '');
  const name = els.editorRenameInput.value.trim();
  if (!name) { setMsg(els.editorRenameMsg, 'Name is required.', 'error'); return; }
  if (editingQuiz && name === editingQuiz.name) return;
  try {
    await fetchJson(`${API}/quizzes/${editingQuizId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    setMsg(els.editorRenameMsg, 'Name updated.', 'success');
    await reloadEditingQuiz();
  } catch (err) {
    setMsg(els.editorRenameMsg, err.message, 'error');
  }
});

// ── Categories ─────────────────────────────────────────

function renderCategories() {
  els.categoryList.innerHTML = '';
  const cats = editingQuiz.categories || [];
  if (!cats.length) {
    const empty = document.createElement('li');
    empty.className = 'cat-empty';
    empty.textContent = 'No categories yet. Add one to group your questions.';
    els.categoryList.appendChild(empty);
    return;
  }
  cats.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'category-row';
    const isFirst = i === 0;
    const isLast = i === cats.length - 1;
    li.innerHTML = `
      <span class="cat-name"></span>
      <button class="icon-btn" data-act="up" title="Move up" ${isFirst ? 'disabled' : ''}>&uarr;</button>
      <button class="icon-btn" data-act="down" title="Move down" ${isLast ? 'disabled' : ''}>&darr;</button>
      <button class="icon-btn" data-act="rename" title="Rename">&#9998;</button>
      <button class="icon-btn" data-act="delete" title="Delete">&times;</button>
    `;
    li.querySelector('.cat-name').textContent = c.name;
    li.querySelector('[data-act="up"]').addEventListener('click', () => moveCategory(c.id, -1));
    li.querySelector('[data-act="down"]').addEventListener('click', () => moveCategory(c.id, 1));
    li.querySelector('[data-act="rename"]').addEventListener('click', () => startRenameCategory(li, c));
    li.querySelector('[data-act="delete"]').addEventListener('click', () => deleteCategory(c));
    els.categoryList.appendChild(li);
  });
}

function startRenameCategory(li, cat) {
  const nameEl = li.querySelector('.cat-name');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 60;
  input.className = 'cat-name-input';
  input.value = cat.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    if (!newName || newName === cat.name) { renderCategories(); return; }
    try {
      await fetchJson(`${API}/quizzes/${editingQuizId}/categories/${cat.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: newName }),
      });
      await reloadEditingQuiz();
    } catch (err) {
      setMsg(els.categoryMsg, err.message, 'error');
      renderCategories();
    }
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { renderCategories(); }
  });
}

async function deleteCategory(cat) {
  if (!confirm(`Delete category "${cat.name}"? Questions in it will become uncategorized.`)) return;
  try {
    await fetchJson(`${API}/quizzes/${editingQuizId}/categories/${cat.id}`, { method: 'DELETE' });
    await reloadEditingQuiz();
  } catch (err) {
    setMsg(els.categoryMsg, err.message, 'error');
  }
}

async function moveCategory(cId, delta) {
  const cats = editingQuiz.categories || [];
  const ids = cats.map(c => c.id);
  const i = ids.indexOf(cId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try {
    await fetchJson(`${API}/quizzes/${editingQuizId}/categories/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ order: ids }),
    });
    await reloadEditingQuiz();
  } catch (err) {
    setMsg(els.categoryMsg, err.message, 'error');
  }
}

els.newCategoryBtn.addEventListener('click', async () => {
  setMsg(els.categoryMsg, '');
  const name = els.newCategoryName.value.trim();
  if (!name) { setMsg(els.categoryMsg, 'Enter a category name.', 'error'); return; }
  try {
    await fetchJson(`${API}/quizzes/${editingQuizId}/categories`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    els.newCategoryName.value = '';
    await reloadEditingQuiz();
  } catch (err) {
    setMsg(els.categoryMsg, err.message, 'error');
  }
});

els.newCategoryName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); els.newCategoryBtn.click(); }
});

function renderCategoryOptions() {
  els.qCategory.innerHTML = '';
  const cats = editingQuiz.categories || [];
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Uncategorized';
  els.qCategory.appendChild(none);
  for (const c of cats) {
    const opt = document.createElement('option');
    opt.value = String(c.id);
    opt.textContent = c.name;
    els.qCategory.appendChild(opt);
  }
  els.qCategory.value = qFormState.categoryId == null ? '' : String(qFormState.categoryId);
}

// ── Questions ──────────────────────────────────────────

function renderQuestions() {
  els.questionList.innerHTML = '';
  if (!editingQuiz.questions.length) {
    els.questionList.innerHTML = '<li class="empty">No questions yet. Add one below.</li>';
    return;
  }

  const cats = editingQuiz.categories || [];
  const groups = new Map();
  for (const c of cats) groups.set(c.id, []);
  groups.set(null, []);
  for (const q of editingQuiz.questions) {
    const key = q.categoryId ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }

  const orderedKeys = [...cats.map(c => c.id), null];
  let displayIndex = 0;
  for (const key of orderedKeys) {
    const items = groups.get(key) || [];
    if (!items.length) continue;
    const head = document.createElement('div');
    head.className = 'question-group-head';
    head.textContent = key == null
      ? 'Uncategorized'
      : (cats.find(c => c.id === key)?.name || 'Category');
    els.questionList.appendChild(head);

    items.forEach((q, idxInGroup) => {
      displayIndex++;
      const li = document.createElement('li');
      li.className = 'question-card';

      const answerSummary = q.type === 'free'
        ? `Accepts: ${q.correctAnswers.join(' / ')}`
        : q.options
          .map((o, idx) => `${q.correctAnswers.includes(idx) ? '✓' : '·'} ${o}`)
          .join(' · ');

      const isFirst = idxInGroup === 0;
      const isLast = idxInGroup === items.length - 1;

      li.innerHTML = `
        <div class="question-head">
          <span class="question-pos">${displayIndex}</span>
          <span class="question-type-tag">${q.type}</span>
        </div>
        <div class="question-prompt"></div>
        <div class="question-answers"></div>
        <div class="question-actions">
          <button class="btn btn-secondary btn-small" data-act="up" ${isFirst ? 'disabled' : ''}>&uarr;</button>
          <button class="btn btn-secondary btn-small" data-act="down" ${isLast ? 'disabled' : ''}>&darr;</button>
          <button class="btn btn-secondary btn-small" data-act="edit">Edit</button>
          <button class="btn btn-danger btn-small" data-act="delete">Delete</button>
        </div>
      `;
      li.querySelector('.question-prompt').textContent = q.prompt;
      li.querySelector('.question-answers').textContent = answerSummary;
      li.querySelector('[data-act="up"]').addEventListener('click', () => moveQuestion(q.id, -1));
      li.querySelector('[data-act="down"]').addEventListener('click', () => moveQuestion(q.id, 1));
      li.querySelector('[data-act="edit"]').addEventListener('click', () => startEditQuestion(q));
      li.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        if (!confirm('Delete this question?')) return;
        try {
          await fetchJson(`${API}/quizzes/${editingQuizId}/questions/${q.id}`, { method: 'DELETE' });
          await reloadEditingQuiz();
        } catch (err) {
          setMsg(els.qFormMsg, err.message, 'error');
        }
      });
      els.questionList.appendChild(li);
    });
  }
}

async function moveQuestion(qId, delta) {
  const all = editingQuiz.questions;
  const i = all.findIndex(q => q.id === qId);
  if (i < 0) return;

  const cat = all[i].categoryId ?? null;
  let j = i + delta;
  while (j >= 0 && j < all.length && (all[j].categoryId ?? null) !== cat) {
    j += delta;
  }
  if (j < 0 || j >= all.length) return;

  const ids = all.map(q => q.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try {
    await fetchJson(`${API}/quizzes/${editingQuizId}/questions/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ order: ids }),
    });
    await reloadEditingQuiz();
  } catch (err) {
    setMsg(els.qFormMsg, err.message, 'error');
  }
}

function startEditQuestion(q) {
  editingQuestionId = q.id;
  qFormState = {
    type: q.type,
    prompt: q.prompt,
    categoryId: q.categoryId ?? null,
    freeAnswers: q.type === 'free' ? q.correctAnswers.join('\n') : '',
    options: q.type === 'free' ? ['', ''] : [...q.options],
    correctAnswers: q.type === 'free' ? [] : [...q.correctAnswers],
  };
  setMsg(els.qFormMsg, '');
  renderQForm();
  els.qFormHead.scrollIntoView({ behavior: 'smooth', block: 'start' });
  els.qPrompt.focus();
}

function resetQForm() {
  editingQuestionId = null;
  qFormState = freshQFormState();
  setMsg(els.qFormMsg, '');
  renderQForm();
}

function renderQForm() {
  els.qPrompt.value = qFormState.prompt;
  els.qType.value = qFormState.type;
  els.qFreeAnswers.value = qFormState.freeAnswers;
  if (els.qCategory.options.length) {
    els.qCategory.value = qFormState.categoryId == null ? '' : String(qFormState.categoryId);
  }
  const isFree = qFormState.type === 'free';
  els.qFreeArea.style.display = isFree ? '' : 'none';
  els.qChoiceArea.style.display = isFree ? 'none' : '';
  if (!isFree) renderOptions();
  els.qFormHead.textContent = editingQuestionId ? 'Edit Question' : 'Add Question';
  els.qSaveBtn.textContent = editingQuestionId ? 'Save Changes' : 'Add Question';
  els.qCancelBtn.style.display = editingQuestionId ? '' : 'none';
}

function moveOption(from, to) {
  const opts = qFormState.options;
  if (from === to || from < 0 || to < 0 || from >= opts.length || to >= opts.length) return;
  const [moved] = opts.splice(from, 1);
  opts.splice(to, 0, moved);
  qFormState.correctAnswers = qFormState.correctAnswers
    .map(k => {
      if (k === from) return to;
      if (from < to && k > from && k <= to) return k - 1;
      if (from > to && k >= to && k < from) return k + 1;
      return k;
    })
    .sort((a, b) => a - b);
  renderOptions();
}

function renderOptions() {
  els.qOptions.innerHTML = '';
  qFormState.options.forEach((opt, idx) => {
    const row = document.createElement('div');
    row.className = 'option-row';
    const inputType = qFormState.type === 'multiple' ? 'checkbox' : 'radio';
    const checked = qFormState.correctAnswers.includes(idx);
    const isFirst = idx === 0;
    const isLast = idx === qFormState.options.length - 1;
    row.innerHTML = `
      <input type="${inputType}" name="q-correct" ${checked ? 'checked' : ''}>
      <input type="text" class="input-field" placeholder="Option ${idx + 1}">
      <button type="button" class="icon-btn" data-act="up" title="Move up" aria-label="Move option up" ${isFirst ? 'disabled' : ''}>&uarr;</button>
      <button type="button" class="icon-btn" data-act="down" title="Move down" aria-label="Move option down" ${isLast ? 'disabled' : ''}>&darr;</button>
      <button type="button" class="icon-btn" data-act="remove" title="Remove" aria-label="Remove option">&times;</button>
    `;
    const check = row.children[0];
    const text = row.children[1];
    const upBtn = row.querySelector('[data-act="up"]');
    const downBtn = row.querySelector('[data-act="down"]');
    const remove = row.querySelector('[data-act="remove"]');
    text.value = opt;
    const currentIdx = () => [...els.qOptions.children].indexOf(row);
    text.addEventListener('input', () => { qFormState.options[currentIdx()] = text.value; });
    check.addEventListener('change', () => {
      const i = currentIdx();
      if (qFormState.type === 'single') {
        qFormState.correctAnswers = [i];
      } else {
        const set = new Set(qFormState.correctAnswers);
        if (check.checked) set.add(i); else set.delete(i);
        qFormState.correctAnswers = [...set].sort((a, b) => a - b);
      }
      if (qFormState.type === 'single') renderOptions();
    });
    upBtn.addEventListener('click', () => moveOption(currentIdx(), currentIdx() - 1));
    downBtn.addEventListener('click', () => moveOption(currentIdx(), currentIdx() + 1));
    remove.addEventListener('click', () => {
      if (qFormState.options.length <= 2) return;
      const i = currentIdx();
      qFormState.options.splice(i, 1);
      qFormState.correctAnswers = qFormState.correctAnswers
        .filter(k => k !== i)
        .map(k => k > i ? k - 1 : k);
      renderOptions();
    });
    els.qOptions.appendChild(row);
  });
}

els.qPrompt.addEventListener('input', (e) => { qFormState.prompt = e.target.value; });
els.qType.addEventListener('change', (e) => {
  qFormState.type = e.target.value;
  if (qFormState.type === 'single') {
    qFormState.correctAnswers = qFormState.correctAnswers.slice(0, 1);
  }
  renderQForm();
});
els.qCategory.addEventListener('change', (e) => {
  const v = e.target.value;
  qFormState.categoryId = v === '' ? null : Number(v);
});
els.qFreeAnswers.addEventListener('input', (e) => { qFormState.freeAnswers = e.target.value; });
els.qAddOption.addEventListener('click', () => {
  if (qFormState.options.length >= 10) return;
  qFormState.options.push('');
  renderOptions();
});
els.qCancelBtn.addEventListener('click', resetQForm);

els.qSaveBtn.addEventListener('click', async () => {
  setMsg(els.qFormMsg, '');
  const payload = {
    prompt: qFormState.prompt,
    type: qFormState.type,
    categoryId: qFormState.categoryId,
  };
  if (qFormState.type === 'free') {
    payload.correctAnswers = qFormState.freeAnswers
      .split('\n').map(s => s.trim()).filter(Boolean);
  } else {
    payload.options = qFormState.options.map(o => o.trim());
    payload.correctAnswers = qFormState.correctAnswers;
  }
  try {
    if (editingQuestionId) {
      await fetchJson(`${API}/quizzes/${editingQuizId}/questions/${editingQuestionId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    } else {
      await fetchJson(`${API}/quizzes/${editingQuizId}/questions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    resetQForm();
    await reloadEditingQuiz();
  } catch (err) {
    setMsg(els.qFormMsg, err.message, 'error');
  }
});

init();
