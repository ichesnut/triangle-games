/**
 * requestAnimationFrame-based game loop.
 *
 * Usage:
 *   const loop = createGameLoop({
 *     update(dt) { ... },  // dt in seconds
 *     render() { ... },
 *   });
 *   loop.start();
 *   loop.stop();
 */
export function createGameLoop({ update, render }) {
  let rafId = null;
  let lastTime = 0;
  let running = false;

  function tick(timestamp) {
    if (!running) return;

    // Cap delta to 100ms to avoid spiral-of-death on tab switch
    const dt = Math.min((timestamp - lastTime) / 1000, 0.1);
    lastTime = timestamp;

    update(dt);
    render();

    rafId = requestAnimationFrame(tick);
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastTime = performance.now();
      rafId = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
    get running() { return running; },
  };
}
