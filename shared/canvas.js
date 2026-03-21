/**
 * Canvas setup helper with auto-sizing and DPI scaling.
 *
 * Usage:
 *   const { canvas, ctx } = createCanvas(document.getElementById('container'));
 *
 * The canvas fills its container and stays sharp on high-DPI screens.
 * Call the returned `destroy()` to clean up the resize listener.
 */
export function createCanvas(container) {
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let dpr = 1;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    width = container.clientWidth;
    height = container.clientHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resize();
  window.addEventListener('resize', resize);

  return {
    canvas,
    ctx,
    /** Logical width in CSS pixels */
    get width() { return width; },
    /** Logical height in CSS pixels */
    get height() { return height; },
    /** Current device pixel ratio */
    get dpr() { return dpr; },
    /** Force a resize recalculation */
    resize,
    /** Remove resize listener */
    destroy() {
      window.removeEventListener('resize', resize);
    },
  };
}
