import { createCanvas, createGameLoop, createTouchInput } from '/shared/index.js';

// ── Constants ──────────────────────────────────────────────
const BG_COLOR = '#1a1a2e';
const TRI_COLORS = ['#e94560', '#0f3460', '#16213e', '#533483', '#e94560'];
const ACCENT = '#e94560';
const TEXT_COLOR = '#eee';

const INITIAL_SIZE = 60;         // triangle radius in px
const MIN_SIZE = 20;
const SIZE_DECAY = 0.97;         // multiplied per score point

const INITIAL_LIFETIME = 2.0;    // seconds before triangle vanishes
const MIN_LIFETIME = 0.5;
const LIFETIME_DECAY = 0.98;

const MAX_ACTIVE = 3;            // triangles on screen at once
const SPAWN_INTERVAL_INITIAL = 1.2; // seconds between spawns
const SPAWN_INTERVAL_MIN = 0.3;
const SPAWN_INTERVAL_DECAY = 0.98;

const MISS_PENALTY = 1;          // lives lost per missed triangle
const STARTING_LIVES = 3;

const STORAGE_KEY = 'triangle-tap-highscore';

// ── State ──────────────────────────────────────────────────
let state = 'start'; // start | playing | gameover
let score = 0;
let lives = 0;
let highScore = loadHighScore();
let triangles = [];
let spawnTimer = 0;
let currentSize = INITIAL_SIZE;
let currentLifetime = INITIAL_LIFETIME;
let currentSpawnInterval = SPAWN_INTERVAL_INITIAL;

// Visual feedback
let flashEffects = []; // { x, y, size, alpha, color }

// ── Setup ──────────────────────────────────────────────────
const container = document.getElementById('game');
const screen = createCanvas(container);
const { canvas, ctx } = screen;
const input = createTouchInput(canvas);

// ── Helpers ────────────────────────────────────────────────

function loadHighScore() {
  try { return parseInt(localStorage.getItem(STORAGE_KEY)) || 0; }
  catch { return 0; }
}

function saveHighScore(s) {
  try { localStorage.setItem(STORAGE_KEY, s); }
  catch { /* ignore */ }
}

function randomColor() {
  return TRI_COLORS[Math.floor(Math.random() * TRI_COLORS.length)];
}

function spawnTriangle() {
  const pad = currentSize + 10;
  const w = screen.width;
  const h = screen.height;
  const x = pad + Math.random() * (w - pad * 2);
  const y = pad + Math.random() * (h - pad * 2);
  // Random rotation for visual variety
  const rotation = Math.random() * Math.PI * 2;
  triangles.push({
    x, y,
    size: currentSize,
    rotation,
    color: randomColor(),
    age: 0,
    lifetime: currentLifetime,
    hit: false,
  });
}

/**
 * Point-in-triangle test using barycentric coordinates.
 * The triangle is equilateral, centered at (tri.x, tri.y), rotated by tri.rotation.
 */
function hitTest(px, py, tri) {
  const { x, y, size, rotation } = tri;
  // Vertices of equilateral triangle centered at origin
  const angles = [
    rotation - Math.PI / 2,           // top
    rotation - Math.PI / 2 + (2 * Math.PI / 3),
    rotation - Math.PI / 2 + (4 * Math.PI / 3),
  ];
  const verts = angles.map(a => ({
    x: x + Math.cos(a) * size,
    y: y + Math.sin(a) * size,
  }));

  // Use a generous circular hit zone for mobile friendliness
  const dx = px - x;
  const dy = py - y;
  return (dx * dx + dy * dy) <= (size * size * 1.2);
}

function drawTriangle(tri, alpha) {
  const { x, y, size, rotation, color } = tri;
  const angles = [
    rotation - Math.PI / 2,
    rotation - Math.PI / 2 + (2 * Math.PI / 3),
    rotation - Math.PI / 2 + (4 * Math.PI / 3),
  ];

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const vx = x + Math.cos(angles[i]) * size;
    const vy = y + Math.sin(angles[i]) * size;
    if (i === 0) ctx.moveTo(vx, vy);
    else ctx.lineTo(vx, vy);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function resetGame() {
  score = 0;
  lives = STARTING_LIVES;
  triangles = [];
  flashEffects = [];
  spawnTimer = 0;
  currentSize = INITIAL_SIZE;
  currentLifetime = INITIAL_LIFETIME;
  currentSpawnInterval = SPAWN_INTERVAL_INITIAL;
}

function scaleDifficulty() {
  currentSize = Math.max(MIN_SIZE, INITIAL_SIZE * Math.pow(SIZE_DECAY, score));
  currentLifetime = Math.max(MIN_LIFETIME, INITIAL_LIFETIME * Math.pow(LIFETIME_DECAY, score));
  currentSpawnInterval = Math.max(SPAWN_INTERVAL_MIN, SPAWN_INTERVAL_INITIAL * Math.pow(SPAWN_INTERVAL_DECAY, score));
}

// ── Update ─────────────────────────────────────────────────
function update(dt) {
  const taps = input.drain().filter(e => e.type === 'start');

  if (state === 'start') {
    if (taps.length > 0) {
      resetGame();
      state = 'playing';
    }
    return;
  }

  if (state === 'gameover') {
    if (taps.length > 0) {
      resetGame();
      state = 'playing';
    }
    return;
  }

  // ── Playing state ────────────────────────────────────────

  // Spawn new triangles
  spawnTimer += dt;
  if (spawnTimer >= currentSpawnInterval && triangles.length < MAX_ACTIVE) {
    spawnTriangle();
    spawnTimer = 0;
  }

  // Process taps
  for (const tap of taps) {
    let hitAny = false;
    // Check newest triangles first (drawn on top)
    for (let i = triangles.length - 1; i >= 0; i--) {
      if (!triangles[i].hit && hitTest(tap.x, tap.y, triangles[i])) {
        triangles[i].hit = true;
        hitAny = true;
        score++;
        scaleDifficulty();
        // Add tap flash effect
        flashEffects.push({
          x: triangles[i].x,
          y: triangles[i].y,
          size: triangles[i].size,
          alpha: 1,
          color: '#fff',
        });
        break; // only hit one per tap
      }
    }
  }

  // Age triangles and remove expired ones
  for (let i = triangles.length - 1; i >= 0; i--) {
    const tri = triangles[i];
    tri.age += dt;

    if (tri.hit) {
      // Shrink and fade hit triangles quickly
      tri.size *= 0.85;
      if (tri.size < 3) {
        triangles.splice(i, 1);
      }
    } else if (tri.age >= tri.lifetime) {
      // Missed — lose a life
      lives -= MISS_PENALTY;
      flashEffects.push({
        x: tri.x,
        y: tri.y,
        size: tri.size * 1.5,
        alpha: 1,
        color: '#ff0000',
      });
      triangles.splice(i, 1);

      if (lives <= 0) {
        state = 'gameover';
        if (score > highScore) {
          highScore = score;
          saveHighScore(score);
        }
      }
    }
  }

  // Update flash effects
  for (let i = flashEffects.length - 1; i >= 0; i--) {
    flashEffects[i].alpha -= dt * 4;
    flashEffects[i].size += dt * 80;
    if (flashEffects[i].alpha <= 0) {
      flashEffects.splice(i, 1);
    }
  }
}

// ── Render ─────────────────────────────────────────────────
function render() {
  const w = screen.width;
  const h = screen.height;

  // Clear
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, w, h);

  if (state === 'start') {
    renderStartScreen(w, h);
    return;
  }

  if (state === 'gameover') {
    renderGameOverScreen(w, h);
    return;
  }

  // ── Playing ──────────────────────────────────────────────

  // Draw triangles
  for (const tri of triangles) {
    // Fade out as they approach expiry (last 30% of lifetime)
    const remaining = 1 - tri.age / tri.lifetime;
    const alpha = tri.hit ? 0.6 : (remaining < 0.3 ? remaining / 0.3 : 1);
    // Pulse when close to expiring
    const pulse = remaining < 0.3 ? 1 + Math.sin(tri.age * 20) * 0.1 : 1;
    const savedSize = tri.size;
    tri.size *= pulse;
    drawTriangle(tri, alpha);
    tri.size = savedSize;
  }

  // Draw flash effects
  for (const fx of flashEffects) {
    ctx.save();
    ctx.globalAlpha = fx.alpha * 0.5;
    ctx.strokeStyle = fx.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(fx.x, fx.y, fx.size, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // HUD
  renderHUD(w);
}

function renderHUD(w) {
  // Score
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = 'bold 24px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText(`Score: ${score}`, 16, 36);

  // Lives as small triangles
  ctx.textAlign = 'right';
  const heartSize = 12;
  for (let i = 0; i < lives; i++) {
    const hx = w - 20 - i * (heartSize * 2 + 8);
    const hy = 28;
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.moveTo(hx, hy - heartSize);
    ctx.lineTo(hx + heartSize, hy + heartSize * 0.6);
    ctx.lineTo(hx - heartSize, hy + heartSize * 0.6);
    ctx.closePath();
    ctx.fill();
  }
}

function renderStartScreen(w, h) {
  // Title
  ctx.fillStyle = ACCENT;
  ctx.font = 'bold 42px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('Triangle Tap', w / 2, h * 0.3);

  // Big decorative triangle
  const triSize = 60;
  const cx = w / 2;
  const cy = h * 0.48;
  ctx.fillStyle = ACCENT;
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.moveTo(cx, cy - triSize);
  ctx.lineTo(cx + triSize, cy + triSize * 0.6);
  ctx.lineTo(cx - triSize, cy + triSize * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;

  // Instructions
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = '18px system-ui';
  ctx.fillText('Tap the triangles before they vanish!', w / 2, h * 0.62);

  // High score
  if (highScore > 0) {
    ctx.fillStyle = '#aaa';
    ctx.font = '16px system-ui';
    ctx.fillText(`Best: ${highScore}`, w / 2, h * 0.68);
  }

  // Start prompt
  ctx.fillStyle = ACCENT;
  ctx.font = 'bold 22px system-ui';
  // Pulsing effect
  const pulse = 0.7 + Math.sin(performance.now() / 400) * 0.3;
  ctx.globalAlpha = pulse;
  ctx.fillText('Tap to Start', w / 2, h * 0.8);
  ctx.globalAlpha = 1;
}

function renderGameOverScreen(w, h) {
  // Dim background
  ctx.fillStyle = 'rgba(26, 26, 46, 0.85)';
  ctx.fillRect(0, 0, w, h);

  // Game Over
  ctx.fillStyle = ACCENT;
  ctx.font = 'bold 42px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('Game Over', w / 2, h * 0.3);

  // Score
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = 'bold 32px system-ui';
  ctx.fillText(`Score: ${score}`, w / 2, h * 0.45);

  // High score
  if (score >= highScore && score > 0) {
    ctx.fillStyle = '#ffd700';
    ctx.font = 'bold 20px system-ui';
    ctx.fillText('New High Score!', w / 2, h * 0.53);
  } else if (highScore > 0) {
    ctx.fillStyle = '#aaa';
    ctx.font = '18px system-ui';
    ctx.fillText(`Best: ${highScore}`, w / 2, h * 0.53);
  }

  // Restart prompt
  ctx.fillStyle = ACCENT;
  ctx.font = 'bold 22px system-ui';
  const pulse = 0.7 + Math.sin(performance.now() / 400) * 0.3;
  ctx.globalAlpha = pulse;
  ctx.fillText('Tap to Play Again', w / 2, h * 0.7);
  ctx.globalAlpha = 1;
}

// ── Start the loop ─────────────────────────────────────────
const loop = createGameLoop({ update, render });
loop.start();

// Initial render for start screen animation
render();
