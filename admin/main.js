const API = '/api/chesnuts';

const els = {
  loading: document.getElementById('loading'),
  content: document.getElementById('content'),
  denied: document.getElementById('denied'),
  me: document.getElementById('me'),
  list: document.getElementById('user-list'),
  registerForm: document.getElementById('register-form'),
  registerMsg: document.getElementById('register-msg'),
  usersMsg: document.getElementById('users-msg'),
  quizList: document.getElementById('quiz-list'),
  quizzesMsg: document.getElementById('quizzes-msg'),
};

let csrfToken = null;
let currentUser = null;

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

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function renderUsers(users) {
  if (!users.length) {
    els.list.innerHTML = '<li class="empty">No users yet.</li>';
    return;
  }

  els.list.innerHTML = users.map(u => {
    const isMe = u.id === currentUser.id;
    const disabled = !!u.disabledAt;
    const badges = [
      isMe ? '<span class="badge badge-me">You</span>' : '',
      u.isAdmin ? '<span class="badge badge-admin">Admin</span>' : '',
      disabled ? '<span class="badge badge-disabled">Disabled</span>' : '',
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
    }

    return `
      <li class="user-row ${disabled ? 'disabled' : ''}" data-id="${u.id}">
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
    return `
      <li class="user-row" data-id="${q.id}">
        <div class="user-head">
          <span class="user-name">${escapeHtml(q.name)}</span>
        </div>
        <div class="user-meta">
          ${q.questionCount} question${q.questionCount === 1 ? '' : 's'} ·
          owned by ${owner} ·
          Created ${fmtDate(q.createdAt)}
        </div>
      </li>
    `;
  }).join('');
}

async function loadQuizzes() {
  setMsg(els.quizzesMsg, '');
  try {
    const { quizzes } = await fetchJson(`${API}/admin/quizzes`);
    renderQuizzes(quizzes);
  } catch (err) {
    setMsg(els.quizzesMsg, err.message, 'error');
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
  els.content.style.display = 'block';

  await Promise.all([loadUsers(), loadQuizzes()]);
}

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

init();
