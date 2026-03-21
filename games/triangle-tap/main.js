import { createCanvas, createGameLoop, createTouchInput } from '/shared/index.js';

// Placeholder — Triangle Tap game logic goes here (TRI-4)
const container = document.getElementById('game');
const { canvas, ctx, width, height } = createCanvas(container);

ctx.fillStyle = '#1a1a2e';
ctx.fillRect(0, 0, width, height);
ctx.fillStyle = '#e94560';
ctx.font = 'bold 24px system-ui';
ctx.textAlign = 'center';
ctx.fillText('Triangle Tap — Coming Soon', width / 2, height / 2);
