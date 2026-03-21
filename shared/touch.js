/**
 * Touch/pointer input helper for mobile-friendly games.
 *
 * Unifies mouse and touch into a single stream of events.
 * Coordinates are in CSS pixels relative to the target element.
 *
 * Usage:
 *   const input = createTouchInput(canvas);
 *   // In your update loop:
 *   for (const tap of input.drain()) {
 *     handleTap(tap.x, tap.y);
 *   }
 *   // Cleanup:
 *   input.destroy();
 */
export function createTouchInput(element) {
  const queue = [];

  function getPos(e, rect) {
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  function onPointerDown(e) {
    // Prevent double-fire on touch devices
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const rect = element.getBoundingClientRect();
    const pos = getPos(e, rect);
    queue.push({ type: 'start', ...pos, id: e.pointerId });
  }

  function onPointerMove(e) {
    const rect = element.getBoundingClientRect();
    const pos = getPos(e, rect);
    queue.push({ type: 'move', ...pos, id: e.pointerId });
  }

  function onPointerUp(e) {
    const rect = element.getBoundingClientRect();
    const pos = getPos(e, rect);
    queue.push({ type: 'end', ...pos, id: e.pointerId });
  }

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerUp);

  return {
    /** Drain all queued events since last call */
    drain() {
      const events = queue.splice(0);
      return events;
    },
    /** Check if there are pending events */
    get pending() { return queue.length > 0; },
    destroy() {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      queue.length = 0;
    },
  };
}
