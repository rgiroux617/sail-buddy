// gameLoop.js
// Manages the requestAnimationFrame loop.
//
// Responsibilities:
//   - Start and stop the loop cleanly
//   - Calculate delta-time (seconds) between frames
//   - Cap dt at 0.1 s so a tab-switch or lag spike never teleports the ship
//   - Call update(dt) then draw(dt) each frame
//
// Usage:
//   const loop = createGameLoop({ update, draw });
//   loop.start();
//   loop.stop();  // safe to call even if already stopped

export function createGameLoop({ update, draw }) {
  let running  = false;
  let lastTime = null;   // ms timestamp of the previous frame
  let rafId    = null;

  function tick(timestamp) {
    if (!running) return;

    // Delta-time in seconds, capped to prevent physics explosions after a pause
    const dt = lastTime === null
      ? 0
      : Math.min((timestamp - lastTime) / 1000, 0.1);

    lastTime = timestamp;

    update(dt);
    draw(dt);

    rafId = requestAnimationFrame(tick);
  }

  return {
    start() {
      if (running) return;
      running  = true;
      lastTime = null;               // reset so first frame gets dt = 0
      rafId    = requestAnimationFrame(tick);
    },

    stop() {
      running = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },

    get isRunning() { return running; },
  };
}
