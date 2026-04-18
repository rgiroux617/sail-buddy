// fog.js
// Canvas-based fog of war for SailBuddy.
//
// Architecture:
//   One offscreen canvas (same pixel size as the map) starts fully dark.
//   As the ship moves, revealAt(x, y) permanently erases a soft circle
//   around that world position using 'destination-out' compositing.
//   The result is drawn over the map each frame — revealed areas stay clear.
//
// Breathing effect:
//   The reveal radius pulses gently using a sine wave keyed to elapsed time.
//   This gives the fog boundary a slow living quality with zero extra cost.
//
// Usage:
//   const fog = createFog({ mapW, mapH });
//   // each frame:
//   fog.revealAt(ship.x, ship.y, elapsedTime);
//   // in renderer, after background, before ship:
//   fog.draw(ctx, camera, zoom);

// ── Tweakable constants ────────────────────────────────────────────────────────
const FOG_COLOR        = 'rgba(171, 174, 177, 0.0)'; // dark navy fog fill
const REVEAL_RADIUS    = 45;    // base world-px radius of the clear circle
const REVEAL_PULSE     = 2;     // world-px amplitude of the breathing pulse
const REVEAL_PULSE_HZ  = 0.38;  // cycles per second — lower = slower breath
const EDGE_SOFTNESS    = 0.85;  // 0 = hard edge, 1 = fully gradual (0.5 is nice)
                                 // controls where the gradient fade begins as a
                                 // fraction of REVEAL_RADIUS

export function createFog({ mapW, mapH }) {
  // Offscreen canvas — lives at map resolution, never resized
  const offscreen    = document.createElement('canvas');
  offscreen.width    = mapW;
  offscreen.height   = mapH;
  const offCtx       = offscreen.getContext('2d');

  // Fill entirely with fog color to start
  offCtx.fillStyle = FOG_COLOR;
  offCtx.fillRect(0, 0, mapW, mapH);

  // Track last reveal position to avoid redundant redraws when ship is still
  let lastX = -9999;
  let lastY = -9999;

  // ── Reveal a circle of clear area around a world position ──────────────────
  // Safe to call every frame — skips the erase if position hasn't moved enough.
  function revealAt(wx, wy, elapsedTime = 0) {
    // Pulse the radius using a sine wave for the breathing effect
    const pulse  = Math.sin(elapsedTime * Math.PI * 2 * REVEAL_PULSE_HZ) * REVEAL_PULSE;
    const radius = REVEAL_RADIUS + pulse;

    // Skip if we haven't moved more than 1px since last reveal
    const moved = Math.abs(wx - lastX) + Math.abs(wy - lastY);
    if (moved < 1) return;
    lastX = wx;
    lastY = wy;

    // Radial gradient: fully transparent at center, opaque at edge
    // This creates the soft feathered boundary
    const innerR = radius * (1 - EDGE_SOFTNESS);
    const grad   = offCtx.createRadialGradient(wx, wy, innerR, wx, wy, radius);
    grad.addColorStop(0,   'rgba(0,0,0,1)');   // fully erased at center
    grad.addColorStop(1,   'rgba(0,0,0,0)');   // no erase at edge

    offCtx.save();
    offCtx.globalCompositeOperation = 'destination-out';
    offCtx.fillStyle = grad;
    offCtx.beginPath();
    offCtx.arc(wx, wy, radius, 0, Math.PI * 2);
    offCtx.fill();
    offCtx.restore();
  }

  // ── Draw the fog canvas over the map in screen space ───────────────────────
  // Must be called inside the renderer's save/scale/translate block so it
  // sits correctly in world space alongside the map and ship.
  function draw(ctx) {
    ctx.drawImage(offscreen, 0, 0);
  }

  // ── Reset all revealed area back to opaque fog ─────────────────────────────
  // Called by main.js when the player chooses "Return to Port" and the game
  // needs to restart from scratch without a full page reload.
  function reset() {
    offCtx.save();
    offCtx.globalCompositeOperation = 'source-over';
    offCtx.fillStyle = FOG_COLOR;
    offCtx.fillRect(0, 0, mapW, mapH);
    offCtx.restore();
    lastX = -9999;
    lastY = -9999;
  }

  return { revealAt, draw, reset };
}
