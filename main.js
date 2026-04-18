// main.js
// Entry point for SailBuddy. Wires all modules together and starts the game loop.

import { createGameLoop }  from './gameLoop.js';
import { createShipState } from './shipState.js';
import { createInput }     from './input.js';
import { createRenderer }  from './renderer.js';
import { loadTerrain }     from './terrain.js';
import { createCamera }    from './camera.js';
import { createFog }       from './fog.js';
import { ADS }             from './BugmanAds/ads-data.js';
import { createSoundEngine } from './sound.js';
import { resultForMinesLeft } from './results.js';

// ─── Grid / map constants ─────────────────────────────────────────────────────
const COLS = 52;
const ROWS = 33;
const SIZE = 22;
const PAD  = 20;

const HEX_H = Math.sqrt(3) * SIZE;
const DX    = 1.5 * SIZE;
const DY    = HEX_H;

function hexCenter(c, r) {
  return {
    x: PAD + SIZE + c * DX,
    y: PAD + (HEX_H / 2) + r * DY + ((c & 1) ? (DY / 2) : 0),
  };
}

const START_HEX = hexCenter(26, 16);

// ─── Game constants ───────────────────────────────────────────────────────────
const SHIP_CONFIGS = {
  motorboat: {
    baseSpeed:     70,
    boostSpeed:    140,
    countdown:     30,
    soundRpm:      2600,
    soundBoostRpm: 3600,
    soundFilterHz: 300,
  },
  motorboat_2: {
    baseSpeed:     110,
    boostSpeed:    180,
    countdown:     75,
    soundRpm:      3200,
    soundBoostRpm: 4800,
    soundFilterHz: 700,
  },
};
let selectedShip = 'motorboat';   // default selection

const ANCHOR_COUNT       = 30;
const ANCHOR_RADIUS      = SIZE * 1.2;
const ANCHOR_DAMAGE      = 10;
const HP_MAX             = 100;
const HP_PER_COLLISION   = 10;
const COLLISION_COOLDOWN = 1.5;
const COUNTDOWN_START    = 120;
const URGENT_THRESHOLD   = 30;

// ─── Zoom-in intro constants ──────────────────────────────────────────────────
const INTRO_ZOOM_START = 0.35;
const INTRO_ZOOM_END   = 2.5;
const INTRO_DURATION   = 2.2;

// ─── Radar constants ──────────────────────────────────────────────────────────
const RADAR_COOLDOWN = 4.0;   // seconds between pings

// ─── Hourglass constants ──────────────────────────────────────────────────────
const HOURGLASS_COUNT  = 6;
const HOURGLASS_RADIUS = SIZE * 1.2;   // same pickup radius as mines
const HOURGLASS_BONUS  = 15;           // seconds added to timer on collection

// ─── Depth charge constants ───────────────────────────────────────────────────
const DC_MAX_CHARGES    = 3;
const DC_FUSE_DELAY     = 2.5;   // seconds from drop to detonation
// 4 hexes in world-px: hex size=22, horizontal spacing DX=33, 4*33 ≈ 132
const DC_BLAST_RADIUS   = 132;   // world-px sweep radius

// ─── Haptic patterns ──────────────────────────────────────────────────────────
const HAPTIC = {
  collision:        [80],
  anchorUnshielded: [60, 40, 60],
  anchorShielded:   [20],
};
function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch (_) {}
}

// ─── Entry point ──────────────────────────────────────────────────────────────
(async () => {

  const terrain = await loadTerrain('./campaign_default.json');
  const { mapWidth, mapHeight } = terrain;

  const canvas = document.getElementById('sailCanvas');
  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const { state: inputState } = createInput();

  const ship = createShipState({
    startX:       START_HEX.x,
    startY:       START_HEX.y,
    startHeading: 0,
  });

  const camera   = createCamera();
  const renderer = createRenderer(canvas, mapWidth, mapHeight);

  renderer.loadImages('./CompiledBackground.jpeg', './motorboat.png', './motorboat_2.png', './mine.png', './depth-charge-map.png', './hourglass.png');

  // ── Sound engine ──────────────────────────────────────────────────────────
  const sound = createSoundEngine();

  const fog = createFog({ mapW: mapWidth, mapH: mapHeight });
  renderer.setFog(fog);

  // ── Random anchor placement ───────────────────────────────────────────────
  // `let` so we can re-randomize on "Return to Port" without a page reload.
  let markers = terrain.getRandomWaterHexes(ANCHOR_COUNT)
    .map(({ x, y }) => ({ x, y, reached: false }));
  renderer.setMarkers(markers);

  // ── Random hourglass placement ────────────────────────────────────────────
  let hourglasses = terrain.getRandomWaterHexes(HOURGLASS_COUNT)
    .map(({ x, y }) => ({ x, y, collected: false }));
  renderer.setHourglasses(hourglasses);

  // ── Ad helper — fill any slot with a random banner ad ────────────────────
  // Called once for the start screen at boot, and again for the end screen
  // every time we show the debrief card.
  const AD_IMAGE_PATH = './BugmanAds/images/';
  function populateAdSlot(slotId) {
    const slot = document.getElementById(slotId);
    if (!slot) return;
    const ad = ADS[Math.floor(Math.random() * ADS.length)];
    if (!ad) return;
    slot.dataset.ad = ad.id;
    slot.classList.add('ad-slot-' + (ad.slotSize || 'banner'));
    slot.innerHTML = `
      <img src="${AD_IMAGE_PATH}${ad.bannerImage}"
           class="ad-banner"
           data-ad="${ad.id}"
           style="width:320px; height:auto; display:block;">
    `;
  }
  populateAdSlot('startScreenAd');

  // ── Button wiring ─────────────────────────────────────────────────────────
  function bindHeld(id, onDown, onUp) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('pointerdown',   onDown);
    el.addEventListener('pointerup',     onUp);
    el.addEventListener('pointerleave',  onUp);
    el.addEventListener('pointercancel', onUp);
  }

  // Declare button state vars before bindHeld calls that reference them
  let zoomBtn   = false;
  let shieldBtn = false;

  bindHeld('btn-zoom',
    () => { zoomBtn = true; },
    () => { zoomBtn = false; }
  );
  bindHeld('btn-shield',
    () => { shieldBtn = true; },
    () => { shieldBtn = false; }
  );

  // ── Game state ────────────────────────────────────────────────────────────
  let hp            = HP_MAX;
  let wasBlocked    = false;
  let cooldownTimer = 0;
  let anchorsFound  = 0;
  let timeRemaining = COUNTDOWN_START;
  let gameActive    = false;
  let elapsedTime   = 0;
  let isShielded    = false;

  // ── Radar state ───────────────────────────────────────────────────────────
  let radarCooldown  = 0;
  let radarWasActive = false;

  // ── Depth charge state ────────────────────────────────────────────────────
  let dcCharges      = DC_MAX_CHARGES;   // charges remaining
  let dcWasActive    = false;            // edge detection — was combo held last frame?
  // Pending detonation: null or { x, y, timer }
  let dcPending      = null;

  // ── Intro zoom state ──────────────────────────────────────────────────────
  let introActive = false;
  let introAge    = 0;

  // ── HUD elements ─────────────────────────────────────────────────────────
  const timerEl    = document.getElementById('timer');
  const tallyEl    = document.getElementById('anchor-tally');
  const hpFillEl   = document.getElementById('hp-fill');
  const hpTextEl   = document.getElementById('hp-text');
  const dcIconEls  = [
    document.getElementById('dc-icon-0'),
    document.getElementById('dc-icon-1'),
    document.getElementById('dc-icon-2'),
  ];

  function updateHpHud(currentHp) {
    const pct = (currentHp / HP_MAX) * 100;
    if (hpFillEl) {
      hpFillEl.style.width      = `${pct}%`;
      hpFillEl.style.background =
        pct > 60 ? '#4caf82' : pct > 30 ? '#e8a838' : '#e84c38';
    }
    if (hpTextEl) hpTextEl.textContent = `${currentHp} / ${HP_MAX}`;
  }

  function updateTallyHud() {
    if (tallyEl) tallyEl.textContent = `💣 ${anchorsFound} / ${ANCHOR_COUNT}`;
  }

  function updateDcHud() {
    dcIconEls.forEach((el, i) => {
      if (!el) return;
      // Charges are "used" from right to left: index 0 = leftmost = last to go
      el.classList.toggle('dc-used', i >= dcCharges);
    });
  }

  function triggerTimerFlash() {
    if (!timerEl) return;
    // Remove first so re-triggering mid-animation restarts cleanly
    timerEl.classList.remove('timer-bonus');
    // Force reflow so the browser registers the removal before re-adding
    void timerEl.offsetWidth;
    timerEl.classList.add('timer-bonus');
    // Clean up once animation finishes so 'urgent' red can take over normally
    timerEl.addEventListener('animationend', () => {
      timerEl.classList.remove('timer-bonus');
    }, { once: true });
  }

  function updateTimerHud(seconds) {
    const m  = Math.floor(seconds / 60);
    const s  = Math.floor(seconds % 60).toString().padStart(2, '0');
    const cs = Math.floor((seconds % 1) * 100).toString().padStart(2, '0');
    if (timerEl) {
      timerEl.textContent = `${m}:${s}.${cs}`;
      timerEl.classList.toggle('urgent', seconds < URGENT_THRESHOLD);
    }
  }

  updateHpHud(hp);
  updateTallyHud();
  updateTimerHud(timeRemaining);
  updateDcHud();

  // ── Damage helper ─────────────────────────────────────────────────────────
  function dealDamage(amount) {
    hp = Math.max(0, hp - amount);
    updateHpHud(hp);
    if (hp <= 0) triggerEnd('hull');
  }

  // ── Coastline collision ───────────────────────────────────────────────────
  function applyCollisionDamage(dt) {
    const isBlocked = ship.isBlocked;
    if (cooldownTimer > 0) cooldownTimer = Math.max(0, cooldownTimer - dt);

    if (isBlocked && !wasBlocked && cooldownTimer === 0) {
      if (!isShielded) {
        dealDamage(HP_PER_COLLISION);
        vibrate(HAPTIC.collision);
        renderer.triggerVignette();
        sound.playCollision();
      }
      cooldownTimer = COLLISION_COOLDOWN;
    }
    wasBlocked = isBlocked;
  }

  // ── Anchor collection ─────────────────────────────────────────────────────
  function checkAnchors() {
    markers.forEach(m => {
      if (m.reached) return;
      const dx = ship.x - m.x;
      const dy = ship.y - m.y;
      if (Math.sqrt(dx * dx + dy * dy) > ANCHOR_RADIUS) return;

      m.reached = true;
      renderer.setMarkers(markers);
      renderer.triggerShock(m.x, m.y);

      if (isShielded) {
        vibrate(HAPTIC.anchorShielded);
      } else {
        dealDamage(ANCHOR_DAMAGE);
        vibrate(HAPTIC.anchorUnshielded);
        sound.playMineHit();
      }

      anchorsFound++;
      updateTallyHud();
      if (anchorsFound >= ANCHOR_COUNT) triggerEnd('cleared');
    });
  }

  // ── Hourglass collection ──────────────────────────────────────────────────
  function checkHourglasses() {
    hourglasses.forEach(h => {
      if (h.collected) return;
      const dx = ship.x - h.x;
      const dy = ship.y - h.y;
      if (Math.sqrt(dx * dx + dy * dy) > HOURGLASS_RADIUS) return;

      h.collected = true;
      renderer.setHourglasses(hourglasses);
      timeRemaining += HOURGLASS_BONUS;
      triggerTimerFlash();
      sound.playHourglassCollect();
      vibrate([20, 30, 20]);
    });
  }

  // ── Depth charge detonation ───────────────────────────────────────────────
  // Called when the fuse timer expires. Sweeps all unreached mines within
  // DC_BLAST_RADIUS world-px, marks them found (no hull damage), and fires
  // the orange wave visual.
  function detonateDepthCharge(wx, wy) {
    renderer.triggerDepthCharge(wx, wy);
    sound.playMineHit();   // reuse boom sound for now — replace if you add a DC sound

    let swept = 0;
    markers.forEach(m => {
      if (m.reached) return;
      const dx   = m.x - wx;
      const dy   = m.y - wy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > DC_BLAST_RADIUS) return;

      m.reached = true;
      renderer.triggerShock(m.x, m.y);   // small yellow pop on each caught mine
      anchorsFound++;
      swept++;
    });

    if (swept > 0) {
      renderer.setMarkers(markers);
      updateTallyHud();
      if (anchorsFound >= ANCHOR_COUNT) triggerEnd('cleared');
    }

    // Also sweep hourglasses in the blast radius
    let hourglassesSwept = 0;
    hourglasses.forEach(h => {
      if (h.collected) return;
      const dx   = h.x - wx;
      const dy   = h.y - wy;
      if (Math.sqrt(dx * dx + dy * dy) > DC_BLAST_RADIUS) return;
      h.collected = true;
      timeRemaining += HOURGLASS_BONUS;
      hourglassesSwept++;
    });
    if (hourglassesSwept > 0) {
      renderer.setHourglasses(hourglasses);
      triggerTimerFlash();
    }
  }

  // ── End states ────────────────────────────────────────────────────────────
  function _stopGame() {
    if (!gameActive && !introActive) return;
    gameActive  = false;
    introActive = false;
    sound.stopDepthChargeFuse();   // kill fuse tick if game ends mid-countdown
    loop.stop();
  }

  // Show the debrief/report card.  Same card for every end condition — the
  // only input that changes the content is minesLeft (= ANCHOR_COUNT - found).
  // `reason` is kept as a parameter for future differentiation but currently
  // unused — every run just looks up the row and fills the card.
  function triggerEnd(reason) {
    _stopGame();
    sound.stopEngine();   // silence the motorboat — fades out over ~0.3s

    const minesLeft = ANCHOR_COUNT - anchorsFound;
    const row       = resultForMinesLeft(minesLeft);

    // Hero stats
    document.getElementById('end-tankers').textContent = row.tankers;
    document.getElementById('end-oil').textContent     = `${row.oilB.toFixed(1)}B`;
    // Secondary stat
    document.getElementById('end-hull').textContent    = `Hull: ${hp} / ${HP_MAX}`;
    // 2x2 verdicts
    document.getElementById('end-economic').textContent   = row.economic;
    document.getElementById('end-ecological').textContent = row.ecological;
    document.getElementById('end-political').textContent  = row.political;
    document.getElementById('end-future').textContent     = row.future;
    // Quip
    document.getElementById('end-quip').textContent       = row.quip;
    // Fresh random ad
    populateAdSlot('endScreenAd');

    // Hide HUD/controls, show end screen
    document.getElementById('hud').classList.remove('visible');
    document.getElementById('controls').classList.remove('visible');
    document.getElementById('end-screen').style.display = 'flex';
  }

  // Full in-place reset — wipes every piece of game state so the player can
  // go back to the start screen and play again without a page reload.
  function resetGame() {
    // Hide the end screen, re-show the start screen
    const endEl   = document.getElementById('end-screen');
    const startEl = document.getElementById('start-screen');
    endEl.style.display     = 'none';
    startEl.style.display   = 'flex';
    startEl.classList.remove('fade-out');
    startEl.style.opacity   = '';
    // Re-shuffle the start-screen ad so the player doesn't see the same one
    populateAdSlot('startScreenAd');

    // Reset scalar game state
    hp             = HP_MAX;
    wasBlocked     = false;
    cooldownTimer  = 0;
    anchorsFound   = 0;
    timeRemaining  = COUNTDOWN_START;   // overwritten by startIntro() on play
    gameActive     = false;
    elapsedTime    = 0;
    isShielded     = false;
    radarCooldown  = 0;
    radarWasActive = false;
    introActive    = false;
    introAge       = 0;
    dcCharges      = DC_MAX_CHARGES;
    dcWasActive    = false;
    dcPending      = null;

    // Re-randomize mine and hourglass placement, refresh HUD
    markers = terrain.getRandomWaterHexes(ANCHOR_COUNT)
      .map(({ x, y }) => ({ x, y, reached: false }));
    renderer.setMarkers(markers);
    hourglasses = terrain.getRandomWaterHexes(HOURGLASS_COUNT)
      .map(({ x, y }) => ({ x, y, collected: false }));
    renderer.setHourglasses(hourglasses);
    updateHpHud(hp);
    updateTallyHud();
    updateTimerHud(timeRemaining);
    updateDcHud();

    // Reset ship back to the starting hex, heading due "north"
    ship.setPosition(START_HEX.x, START_HEX.y);
    ship.setHeading(0);

    // Clear the fog layer and the renderer's transient visual state
    fog.reset();
    renderer.reset();

    // Resume the render loop so the start-screen canvas keeps ticking
    // (needed so the intro zoom works on the next play)
    loop.start();
  }

  // ── Start screen / intro ──────────────────────────────────────────────────
  function startIntro() {
    const cfg = SHIP_CONFIGS[selectedShip];
    ship.setSpeeds(cfg.baseSpeed, cfg.boostSpeed);
    timeRemaining = cfg.countdown;
    updateTimerHud(timeRemaining);
    renderer.setShipImage(selectedShip);
    sound.init();          // must be called from user gesture
    sound.loadSamples('.');  // fetch + decode WAV files now that AudioContext exists
    sound.startEngine({ normalRpm: cfg.soundRpm, boostRpm: cfg.soundBoostRpm, filterHz: cfg.soundFilterHz });
    const startEl = document.getElementById('start-screen');
    startEl.classList.add('fade-out');
    setTimeout(() => { startEl.style.display = 'none'; }, 800);
    setTimeout(() => {
      document.getElementById('hud').classList.add('visible');
      document.getElementById('controls').classList.add('visible');
    }, 400);
    introActive = true;
    introAge    = 0;
    renderer.setIntroZoom(INTRO_ZOOM_START);
  }

  document.getElementById('go-btn').addEventListener('click', startIntro);

  // ── Return-to-Port button (end-screen → start-screen, full state reset) ──
  document.getElementById('return-port-btn').addEventListener('click', resetGame);

  // ── How-to overlay ────────────────────────────────────────────────────────
  document.getElementById('how-to-btn').addEventListener('click', () => {
    document.getElementById('how-to-card').classList.remove('how-to-hidden');
    document.getElementById('how-to-card').classList.add('how-to-visible');
  });
  // AFTER:
  document.getElementById('how-to-close').addEventListener('click', () => {
    const card = document.getElementById('how-to-card');
    card.classList.add('how-to-leaving');
    setTimeout(() => {
      card.classList.remove('how-to-visible');
      card.classList.remove('how-to-leaving');
      card.classList.add('how-to-hidden');
    }, 300);
  });

  // ── Ship selector wiring ──────────────────────────────────────────────────
  document.getElementById('ship-motorboat').addEventListener('click', () => {
    selectedShip = 'motorboat';
    document.getElementById('ship-motorboat').classList.add('selected');
    document.getElementById('ship-motorboat2').classList.remove('selected');
  });
  document.getElementById('ship-motorboat2').addEventListener('click', () => {
    selectedShip = 'motorboat_2';
    document.getElementById('ship-motorboat2').classList.add('selected');
    document.getElementById('ship-motorboat').classList.remove('selected');
  });

  // ── Debug overlay ─────────────────────────────────────────────────────────
  const debugEl = document.getElementById('debug');
  let showDebug = false;
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyP' && !e.repeat) {
      showDebug = !showDebug;
      debugEl.style.display = showDebug ? 'block' : 'none';
    }
  });

  // ── Game loop ─────────────────────────────────────────────────────────────
  const loop = createGameLoop({
    update(dt) {

      if (introActive) {
        introAge += dt;
        const t     = Math.min(introAge / INTRO_DURATION, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        const zoom  = INTRO_ZOOM_START + eased * (INTRO_ZOOM_END - INTRO_ZOOM_START);
        renderer.setIntroZoom(zoom);
        if (t >= 1) {
          introActive = false;
          gameActive  = true;
          renderer.setIntroZoom(null);
        }
        return;
      }

      if (!gameActive) return;

      // Merge keyboard + button state
      isShielded = shieldBtn || inputState.shield;
      renderer.setShielded(isShielded);
      sound.setBoost(inputState.boost);
      renderer.setZoomOut((inputState.zoomOut || zoomBtn) && !isShielded);

      // Radar — fires when shield AND zoom both held, off cooldown
      if (radarCooldown > 0) radarCooldown = Math.max(0, radarCooldown - dt);
      const radarActive = (shieldBtn || inputState.shield) && (zoomBtn || inputState.zoomOut);
      if (radarActive && !radarWasActive && radarCooldown === 0) {
        renderer.triggerRadar(ship.x, ship.y, markers);
        sound.playRadarPing();
        radarCooldown = RADAR_COOLDOWN;
      }
      radarWasActive = radarActive;

      // ── Depth charge — drop on rising edge of combo, detonate after fuse ──
      const dcActive = inputState.depthCharge;
      if (dcActive && !dcWasActive && dcCharges > 0 && dcPending === null) {
        dcCharges--;
        updateDcHud();
        dcPending = { x: ship.x, y: ship.y, timer: DC_FUSE_DELAY };
        sound.playDepthChargeFuse(DC_FUSE_DELAY);
        vibrate([30, 20, 30]);   // subtle double-tap haptic for "drop"
      }
      dcWasActive = dcActive;

      if (dcPending !== null) {
        dcPending.timer -= dt;
        if (dcPending.timer <= 0) {
          sound.stopDepthChargeFuse();
          detonateDepthCharge(dcPending.x, dcPending.y);
          vibrate([80, 40, 120]);   // "boom" haptic
          dcPending = null;
        }
      }

      ship.update(dt, inputState, terrain, mapWidth, mapHeight);
      applyCollisionDamage(dt);
      checkAnchors();
      checkHourglasses();

      elapsedTime += dt;
      fog.revealAt(ship.x, ship.y, elapsedTime);
      renderer.addWakePoint(ship.x, ship.y, ship.heading, dt);

      timeRemaining = Math.max(0, timeRemaining - dt);
      updateTimerHud(timeRemaining);
      if (timeRemaining <= 0) triggerEnd('time');

      if (showDebug) {
        const dcFuse = dcPending ? dcPending.timer.toFixed(1) + 's' : 'none';
        debugEl.textContent =
          `x: ${ship.x.toFixed(1)}  y: ${ship.y.toFixed(1)}\n` +
          `heading: ${ship.heading.toFixed(1)}°\n` +
          `blocked: ${ship.isBlocked}  cooldown: ${cooldownTimer.toFixed(2)}s\n` +
          `shielded: ${isShielded}  hp: ${hp}\n` +
          `mines: ${anchorsFound}/${ANCHOR_COUNT}  time: ${timeRemaining.toFixed(1)}s\n` +
          `radar cooldown: ${radarCooldown.toFixed(1)}s  zoom: ${renderer.zoom.toFixed(2)}\n` +
          `depth charges: ${dcCharges}/${DC_MAX_CHARGES}  fuse: ${dcFuse}`;
      }
    },

    draw(dt) {
      renderer.draw(ship, camera, dt, elapsedTime, dcPending);
    },
  });

  loop.start();

  window._sb = { loop, ship, camera, terrain, fog, inputState, renderer };
  console.log('[SailBuddy] running — P for debug overlay');

})();
