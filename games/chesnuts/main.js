const API = '/api/chesnuts';

let csrfToken = null;

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

// DOM refs
const loadingEl = document.getElementById('loading');
const authEl = document.getElementById('auth');
const dashboardEl = document.getElementById('dashboard');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginError = document.getElementById('login-error');
const registerError = document.getElementById('register-error');
const logoutBtn = document.getElementById('logout-btn');

// Tab switching
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

function showAuth() {
  loadingEl.style.display = 'none';
  authEl.style.display = '';
  dashboardEl.classList.remove('active');
}

function showDashboard(user) {
  loadingEl.style.display = 'none';
  authEl.style.display = 'none';
  dashboardEl.classList.add('active');
  document.getElementById('user-name').textContent = user.displayName;
  document.getElementById('stat-balance').textContent = user.chesnutBalance;
  document.getElementById('stat-streak').textContent = user.currentStreak;
  document.getElementById('stat-best').textContent = user.bestStreak;
}

// Login
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

// Register
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

// Logout
logoutBtn.addEventListener('click', async () => {
  try {
    await api('/logout', { method: 'POST' });
  } catch { /* ignore */ }
  showAuth();
});

// Init: check if already logged in
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
