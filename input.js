// input.js
// Listens for keyboard and on-screen button events.
//
// Exposes a single `state` object { turnLeft, turnRight, boost }.
// shipState.js reads this every frame — it never needs to know how the
// input was produced (keyboard, touch button, gamepad, etc.).
//
// Usage:
//   const { state } = createInput();
//   // each frame: ship.update(dt, state)

export function createInput() {
  const state = {
    turnLeft: false,
    turnRight: false,
    boost: false,
    shield: false,
    zoomOut: false,
    depthCharge: false,  // true while both turnLeft AND turnRight are held
  };

  // ── Keyboard mapping ─────────────────────────────────────────────────────
  // Map KeyboardEvent.code → state key.
  // Using .code (physical key) rather than .key so layout doesn't matter.
  const KEY_MAP = {
    ArrowLeft: 'turnLeft',
    ArrowRight: 'turnRight',
    Space: 'boost',
    ShiftLeft: 'boost',
    ShiftRight: 'boost',
    KeyA: 'shield',
    KeyS: 'boost',
    KeyD: 'zoomOut',
  };

  // Recompute the depth-charge combo flag after any left/right change.
  function updateCombo() {
    state.depthCharge = state.turnLeft && state.turnRight;
  }

  window.addEventListener('keydown', e => {
    const action = KEY_MAP[e.code];
    if (action) {
      state[action] = true;
      updateCombo();
      e.preventDefault();   // prevent arrow keys scrolling the page
    }
  });

  window.addEventListener('keyup', e => {
    const action = KEY_MAP[e.code];
    if (action) {
      state[action] = false;
      updateCombo();
    }
  });

  // Safety: release all keys if the window loses focus
  window.addEventListener('blur', () => {
    state.turnLeft   = false;
    state.turnRight  = false;
    state.boost      = false;
    state.depthCharge = false;
  });

  // ── On-screen buttons ────────────────────────────────────────────────────
  // Uses pointer events so it works for both mouse and touch.
  function bindButton(id, action) {
    const el = document.getElementById(id);
    if (!el) return;

    const press   = () => { state[action] = true;  updateCombo(); el.classList.add('held'); };
    const release = () => { state[action] = false; updateCombo(); el.classList.remove('held'); };

    el.addEventListener('pointerdown',  press);
    el.addEventListener('pointerup',    release);
    el.addEventListener('pointerleave', release);
    el.addEventListener('pointercancel', release);
  }

  // Buttons are wired after the DOM is ready.
  // If this module is imported before DOMContentLoaded, defer the binding.
  function bindButtons() {
    bindButton('btn-left',  'turnLeft');
    bindButton('btn-right', 'turnRight');
    bindButton('btn-boost', 'boost');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindButtons);
  } else {
    bindButtons();
  }

  return { state };
}
