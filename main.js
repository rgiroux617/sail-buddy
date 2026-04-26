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

// ─── Supabase ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://iyhvjnymuntqszejdnkx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_LW_47VRbX2cV-znzs6CDVQ_MxjHuf3O';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchLeaderboard() {
  const tbody = document.getElementById('leaderboard-body');
  tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;opacity:0.5;">Loading...</td></tr>';
  const { data, error } = await sb
    .from('leaderboard')
    .select('name, score, device')
    .order('score', { ascending: false })
    .limit(20);
  if (error || !data) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;opacity:0.5;">Unavailable</td></tr>';
    return [];
  }
  return data;
}

function renderLeaderboard(data, highlightScore) {
  const tbody = document.getElementById('leaderboard-body');
  if (!data || data.length === 0) {
    // ← change 1: colspan bumped from 3 to 4 to cover the new icon column
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;opacity:0.5;">No scores yet</td></tr>';
    return;
  }
  tbody.innerHTML = data.map((row, i) => {
    const highlight = row.score === highlightScore ? ' class="lb-highlight"' : '';
    // ← change 2: determine the icon from the device field
    const icon = row.device === 'desktop' ? '🖥️' : '📱';
    return `<tr${highlight}>
      <td>${i + 1}</td>
      <td>${row.name}</td>
      <td>${row.score}</td>
      <td>${icon}</td>
    </tr>`;  // ← change 3: new <td> added for the icon
  }).join('');
}

async function submitScore(name, minesCleared) {
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
    || window.innerWidth < 768;
  const device = isMobile ? 'mobile' : 'desktop';

  const { error } = await sb
    .from('leaderboard')
    .insert({ name, score: minesCleared, device });
  if (error) console.log('submitScore error:', error);
}

// ─── Player progression (device-based, Supabase-backed) ──────────────────────
// Each device gets a UUID on first visit stored in localStorage.
// That ID is the primary key in the `players` Supabase table.
function getDeviceId() {
  let id = localStorage.getItem('sb_device_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('sb_device_id', id);
  }
  return id;
}
const DEVICE_ID = getDeviceId();

// Live state — populated by loadPlayerRecord() on boot.
// Maps 1+2 and motorboat+motorboat_2 are always unlocked; only these three are gated.
let playerRecord = {
  total_mines: 0,
  unlocks: { map_3: false, destroyer: false, jetboat: false },
};

// Locks are only enforced after the player record has loaded.
// This flag prevents the initial selectMap/selectShip calls from being blocked.
let progressionLoaded = false;

async function loadPlayerRecord() {
  const { data, error } = await sb
    .from('players')
    .select('total_mines, unlocks')
    .eq('device_id', DEVICE_ID)
    .single();

  if (!error && data) {
    playerRecord = {
      total_mines: data.total_mines || 0,
      unlocks: {
        map_3: data.unlocks?.map_3 || false,
        destroyer: data.unlocks?.destroyer || false,
        jetboat: data.unlocks?.jetboat || false,
      },
    };
    console.log('loadPlayerRecord OK:', playerRecord);
  } else {
    console.log('loadPlayerRecord — no row found, creating one. error:', error?.message);
    const { error: insertError } = await sb
      .from('players')
      .insert({ device_id: DEVICE_ID, total_mines: 0, unlocks: {} });
    if (insertError) console.log('insert error:', insertError.message);
    else console.log('insert OK — fresh player row created');
  }
}

// Fire-and-forget — called after each run ends. Doesn't block the UI.
function savePlayerRecord() {
  sb.from('players').upsert({
    device_id: DEVICE_ID,
    total_mines: playerRecord.total_mines,
    unlocks: playerRecord.unlocks,
    updated_at: new Date().toISOString(),
  }).then(({ error }) => {
    if (error) console.log('savePlayerRecord error:', error);
    else console.log('savePlayerRecord OK — total_mines:', playerRecord.total_mines, 'unlocks:', playerRecord.unlocks);
  });
}

// Returns true if any unlock was newly granted.
function checkAndGrantUnlocks(runMines, madLeaderboard) {
  let changed = false;
  // Map 3: clear ≥ 15 mines in a single run on map 1 or 2
  if (!playerRecord.unlocks.map_3 && runMines >= 15 && selectedMapIndex < 2) {
    playerRecord.unlocks.map_3 = true;
    changed = true;
  }
  // Destroyer: ever make the leaderboard (top 10 at time of submission)
  if (!playerRecord.unlocks.destroyer && madLeaderboard) {
    playerRecord.unlocks.destroyer = true;
    changed = true;
  }
  // Jetboat: accumulate 50 total mines across all runs
  if (!playerRecord.unlocks.jetboat && playerRecord.total_mines >= 50) {
    playerRecord.unlocks.jetboat = true;
    changed = true;
  }
  return changed;
}

// Lock helpers — SHIP_KEYS order: motorboat(0), motorboat_2(1), destroyer(2), jetboat(3)
function isShipLocked(index) {
  if (!progressionLoaded) return false;
  if (index === 2) return !playerRecord.unlocks.destroyer;
  if (index === 3) return !playerRecord.unlocks.jetboat;
  return false;
}
function isMapLocked(index) {
  if (!progressionLoaded) return false;
  if (index === 2) return !playerRecord.unlocks.map_3;
  return false;
}

// Lock label copy — matches SHIP_KEYS and MAPS order respectively.
const SHIP_LOCK_LABELS = [null, null, 'Make the leaderboard', 'Clear 50 total mines'];
const MAP_LOCK_LABELS  = [null, null, 'Clear 15 mines\nin one run'];

// Injects or removes lock overlays on every ship and map card.
// Safe to call multiple times — always rebuilds from current playerRecord.
function applyUnlockUI() {
  document.querySelectorAll('.ship-card').forEach((card, i) => {
    card.querySelector('.lock-overlay')?.remove();
    if (isShipLocked(i)) {
      card.classList.add('locked');
      const ov = document.createElement('div');
      ov.className = 'lock-overlay';
      ov.innerHTML = `<span class="lock-icon">🔒</span><span class="lock-label">${SHIP_LOCK_LABELS[i]}</span>`;
      card.appendChild(ov);
    } else {
      card.classList.remove('locked');
    }
  });

  document.querySelectorAll('.map-card').forEach((card, i) => {
    card.querySelector('.lock-overlay')?.remove();
    if (isMapLocked(i)) {
      card.classList.add('locked');
      const ov = document.createElement('div');
      ov.className = 'lock-overlay';
      ov.innerHTML = `<span class="lock-icon">🔒</span><span class="lock-label">${MAP_LOCK_LABELS[i]}</span>`;
      card.appendChild(ov);
    } else {
      card.classList.remove('locked');
    }
  });
}

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

// const START_HEX = hexCenter(26, 16);

// ─── Game constants ───────────────────────────────────────────────────────────
const SHIP_CONFIGS = {
  motorboat: {
    baseSpeed:     70,
    boostSpeed:    140,
    countdown:     3,
    hpMax:         100,
    turnRate:      72,
    dcCharges:     4,
    soundRpm:      2600,
    soundBoostRpm: 3600,
    soundFilterHz: 300,
  },
  motorboat_2: {
    baseSpeed:     110,
    boostSpeed:    180,
    countdown:     45,
    hpMax:         60,
    turnRate:      90,
    dcCharges:     2,
    soundRpm:      3200,
    soundBoostRpm: 4800,
    soundFilterHz: 700,
  },
  jetboat: {
    baseSpeed:     95,
    boostSpeed:    200,
    countdown:     50,
    hpMax:         80,
    turnRate:      180,
    dcCharges:     3,
    soundRpm:      3000,
    soundBoostRpm: 4400,
    soundFilterHz: 500,
  },
  destroyer: {
    baseSpeed:     45,
    boostSpeed:    90,
    countdown:     60,
    hpMax:         200,
    turnRate:      40,
    dcCharges:     6,
    soundRpm:      2200,
    soundBoostRpm: 3000,
    soundFilterHz: 200,
  },
};
let selectedShip = 'motorboat';   // default selection

// ─── Map definitions ──────────────────────────────────────────────────────────
const MAPS = [
  { json: './map1.json', bg: './map1.jpeg', title: 'Strait of Hormuz'  },
  { json: './map2.json', bg: './map2.jpeg', title: 'South China Sea'   },
  { json: './map3.json', bg: './map3.jpeg', title: 'Aleutian Islands'  },
];
// Persist the player's last-used map across sessions.
let selectedMapIndex = parseInt(localStorage.getItem('sb_selectedMap') ?? '0', 10);
if (isNaN(selectedMapIndex) || selectedMapIndex < 0 || selectedMapIndex >= MAPS.length) {
  selectedMapIndex = 0;
}

const ANCHOR_COUNT       = 30;
const ANCHOR_RADIUS      = SIZE * 1.2;
const ANCHOR_DAMAGE      = 10;
let hpMax                = 100;  // overwritten at start by selected ship's config
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
const HOURGLASS_COUNT  = 4;
const HOURGLASS_RADIUS = SIZE * 1.2;   // same pickup radius as mines
const HOURGLASS_BONUS  = 10;           // seconds added to timer on collection

// ─── Depth charge constants ───────────────────────────────────────────────────
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

  let terrain = await loadTerrain(MAPS[selectedMapIndex].json);
  const { mapWidth, mapHeight } = terrain;

  const canvas = document.getElementById('sailCanvas');
  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const { state: inputState } = createInput();

  const startHex = terrain.getRandomWaterHexes(1)[0];
  const ship = createShipState({
    startX: startHex.x,
    startY: startHex.y,
    startHeading: 0,
  });

  const camera   = createCamera();
  const renderer = createRenderer(canvas, mapWidth, mapHeight);

  renderer.loadImages(MAPS[selectedMapIndex].bg, './motorboat.png', './motorboat_2.png', './jetboat.png', './destroyer.png', './mine.png', './depth-charge-map.png', './hourglass.png', selectedShip);

  // ── Sound engine ──────────────────────────────────────────────────────────
  const sound = createSoundEngine();
  sound.setMuted(true);   // muted by default — user toggles with the 🔇 button

  const fog = createFog({ mapW: mapWidth, mapH: mapHeight });
  renderer.setFog(fog);

  // ── Random anchor placement ───────────────────────────────────────────────
  // `let` so we can re-randomize on "Return to Port" without a page reload.
  let markers = terrain.getRandomWaterHexes(ANCHOR_COUNT)
    .map(({ x, y }) => ({ x, y, reached: false }));
  renderer.setMarkers(markers);

  // ── Random hourglass placement ────────────────────────────────────────────
  let hourglasses = terrain.getPerimeterWaterHexes(HOURGLASS_COUNT)
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
  let zoomActiveTime = 0;      // how long zoom has been held this use
  let zoomCooldown = 0;      // countdown before zoom can be used again

  bindHeld('btn-zoom',
    () => { zoomBtn = true; },
    () => { zoomBtn = false; }
  );
  bindHeld('btn-shield',
    () => { shieldBtn = true; },
    () => { shieldBtn = false; }
  );

  // ── Game state ────────────────────────────────────────────────────────────
  let hp            = hpMax;
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
  let dcCharges      = 0;            // set per-ship by startIntro() / resetGame()
  let dcWasActive    = false;        // edge detection — was combo held last frame?
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
  const dcChargesEl = document.getElementById('dc-charges');

  // Builds the correct number of icon <img> elements for the selected ship.
  // Called once at startup and again whenever the ship selection changes.
  function buildDcIcons(count) {
    if (!dcChargesEl) return;
    dcChargesEl.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const img = document.createElement('img');
      img.id        = `dc-icon-${i}`;
      img.className = 'dc-icon';
      img.src       = './depth-charge.png';
      img.alt       = 'Depth charge';
      img.title     = 'Depth charge';
      dcChargesEl.appendChild(img);
    }
  }

  function updateHpHud(currentHp) {
    const pct = (currentHp / hpMax) * 100;
    if (hpFillEl) {
      hpFillEl.style.width      = `${pct}%`;
      hpFillEl.style.background =
        pct > 60 ? '#4caf82' : pct > 30 ? '#e8a838' : '#e84c38';
    }
    if (hpTextEl) hpTextEl.textContent = `${currentHp} / ${hpMax}`;
  }

  function updateTallyHud() {
    if (tallyEl) tallyEl.innerHTML = `<img src="./mine.png" style="width:60px;height:60px;vertical-align:middle;"> ${anchorsFound} / ${ANCHOR_COUNT}`;
  }

  function updateDcHud() {
    if (!dcChargesEl) return;
    dcChargesEl.querySelectorAll('.dc-icon').forEach((el, i) => {
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
  async function triggerEnd(reason) {
    _stopGame();
    sound.stopEngine();
    sound.stopMusic();

    // Tally this run's mines into the cumulative total before checking unlocks.
    playerRecord.total_mines += anchorsFound;

    const minesLeft = ANCHOR_COUNT - anchorsFound;
    const row = resultForMinesLeft(minesLeft);

    // Fill end screen content
    document.getElementById('end-tankers').textContent = row.tankers;
    document.getElementById('end-oil').textContent = `${row.oilB.toFixed(1)}M`;
    document.getElementById('end-hull').textContent = `Hull: ${hp} / ${hpMax}`;
    document.getElementById('end-economic').textContent = row.economic;
    document.getElementById('end-ecological').textContent = row.ecological;
    document.getElementById('end-political').textContent = row.political;
    document.getElementById('end-future').textContent = row.future;
    // Quint banner: pick a random quote from the group matching mines cleared
    const QUINT_QUOTES = {
      // Good run: cleared 21–30 mines
      high: [
        '"I\'m not talking about pleasure boatin\' or day sailin. This is minesweepin!"',
        '"Easy on the throttle lad - it makes all the difference."',
        '"Farewell and adieu to you, fair Spanish ladies."',
        '"A proper effort - next we hunt the Great White!"',
        '"We could have used you on the USS Indianapolis."',
      ],
      // Mid run: cleared 11–20 mines
      mid: [
        '"Japanese submarine slammed two torpedoes into our side, Chief."',
        '"Sometimes that shark, he looks right into ya. Where am I?"',
        '"The thing about a shark... he\'s got lifeless eyes. Black eyes. Like a doll\'s eyes."',
        '"We\'re not going to make it to the harbor."',
        '"Shop Bugman Pawn & Loan for the most affordable rations in the North Sea."',
      ],
      // Bad run: cleared 0–10 mines
      low: [
        '"You\'re going to need a lot more than a bigger boat, son."',
        '"You\'re spazzing out, kid. Chill."',
        '"They shouldn\'t let slack-jaws like you go out to sea "',
        '"Here\'s to swimming with bow-legged women."',
        '"You pull that cork out and the sea goes in and the boat goes down. Just like that."',
      ],
    };
    let quoteGroup;
    if (anchorsFound >= 21)      quoteGroup = QUINT_QUOTES.high;
    else if (anchorsFound >= 11) quoteGroup = QUINT_QUOTES.mid;
    else                          quoteGroup = QUINT_QUOTES.low;
    const randomQuote = quoteGroup[Math.floor(Math.random() * quoteGroup.length)];
    document.getElementById('quint-quote-text').textContent = randomQuote;
    populateAdSlot('endScreenAd');

    document.getElementById('hud').classList.remove('visible');
    document.getElementById('controls').classList.remove('visible');

    // Fetch current leaderboard to check if score qualifies
    const currentBoard = await fetchLeaderboard();
    const lowestTop20 = currentBoard.length < 20
      ? 0
      : currentBoard[currentBoard.length - 1].score;
    const isHighScore = anchorsFound > lowestTop20;

    // Check for newly earned unlocks, refresh UI, and persist.
    const newUnlocks = checkAndGrantUnlocks(anchorsFound, isHighScore);
    if (newUnlocks) applyUnlockUI();
    savePlayerRecord();   // fire-and-forget — doesn't block the end screen

    if (isHighScore) {
      // Show initials screen first
      document.getElementById('initials-score').textContent = anchorsFound;
      const initialsScreen = document.getElementById('initials-screen');
      const initialsInput = document.getElementById('initials-input');
      initialsScreen.style.display = 'flex';
      document.getElementById('sailCanvas').style.pointerEvents = 'none';
      initialsInput.value = '';
      initialsInput.focus();

      // Wait for submit button
      document.getElementById('initials-submit-btn').onclick = async () => {
        console.log('submit clicked, name will be:', initialsInput.value);
        const name = initialsInput.value.trim().toUpperCase().slice(0, 3) || '???';
        initialsScreen.style.display = 'none';
        document.getElementById('sailCanvas').style.pointerEvents = 'auto';
        await submitScore(name, anchorsFound);
        const updatedBoard = await fetchLeaderboard();
        renderLeaderboard(updatedBoard, anchorsFound);
        document.getElementById('end-screen').style.display = 'flex';
        setTimeout(() => { document.querySelector('#end-screen .start-card').scrollTop = 0; }, 50);
      };
    } else {
      // No high score — show results directly with leaderboard
      renderLeaderboard(currentBoard, null);
      document.getElementById('end-screen').style.display = 'flex';
      setTimeout(() => { document.querySelector('#end-screen .start-card').scrollTop = 0; }, 50);
    }
  }

  // Full in-place reset — wipes every piece of game state so the player can
  // go back to the start screen and play again without a page reload.
  async function resetGame() {
    // Reload terrain + background in case the player switched maps.
    terrain = await loadTerrain(MAPS[selectedMapIndex].json);
    renderer.loadImages(MAPS[selectedMapIndex].bg, './motorboat.png', './motorboat_2.png', './jetboat.png', './destroyer.png', './mine.png', './depth-charge-map.png', './hourglass.png', selectedShip);

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
    hp             = hpMax;
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
    dcCharges      = SHIP_CONFIGS[selectedShip].dcCharges;
    buildDcIcons(SHIP_CONFIGS[selectedShip].dcCharges);
    dcWasActive    = false;
    dcPending      = null;

    // Re-randomize mine and hourglass placement, refresh HUD
    markers = terrain.getRandomWaterHexes(ANCHOR_COUNT)
      .map(({ x, y }) => ({ x, y, reached: false }));
    renderer.setMarkers(markers);
    hourglasses = terrain.getPerimeterWaterHexes(HOURGLASS_COUNT)
      .map(({ x, y }) => ({ x, y, collected: false }));
    renderer.setHourglasses(hourglasses);
    updateHpHud(hp);
    updateTallyHud();
    updateTimerHud(timeRemaining);
    updateDcHud();

    // Reset ship back to the starting hex, heading due "north"
    const startHex = terrain.getRandomWaterHexes(1)[0];
    ship.setPosition(startHex.x, startHex.y);
    ship.setHeading(0);

    // Clear the fog layer and the renderer's transient visual state
    fog.reset();
    renderer.reset();

    // Resume the render loop so the start-screen canvas keeps ticking
    // (needed so the intro zoom works on the next play)
    loop.start();
  }

  // ── Start screen / intro ──────────────────────────────────────────────────
  async function startIntro() {
    // Reload terrain + background for whichever map the player chose.
    // This runs on every play so a map change on the start screen always takes effect.
    terrain = await loadTerrain(MAPS[selectedMapIndex].json);
    renderer.loadImages(MAPS[selectedMapIndex].bg, './motorboat.png', './motorboat_2.png', './jetboat.png', './destroyer.png', './mine.png', './depth-charge-map.png', './hourglass.png', selectedShip);
    markers = terrain.getRandomWaterHexes(ANCHOR_COUNT)
      .map(({ x, y }) => ({ x, y, reached: false }));
    renderer.setMarkers(markers);
    hourglasses = terrain.getPerimeterWaterHexes(HOURGLASS_COUNT)
      .map(({ x, y }) => ({ x, y, collected: false }));
    renderer.setHourglasses(hourglasses);

    const cfg = SHIP_CONFIGS[selectedShip];
    ship.setSpeeds(cfg.baseSpeed, cfg.boostSpeed);
    ship.setTurnRate(cfg.turnRate);
    hpMax = cfg.hpMax;
    hp = hpMax;
    updateHpHud(hp);
    timeRemaining = cfg.countdown;
    updateTimerHud(timeRemaining);
    dcCharges = cfg.dcCharges;
    buildDcIcons(cfg.dcCharges);
    updateDcHud();
    sound.init();          // must be called from user gesture — also calls ctx.resume() for iOS
    await sound.loadSamples('.'); // fetch + decode audio files before starting playback
    sound.startEngine({ normalRpm: cfg.soundRpm, boostRpm: cfg.soundBoostRpm, filterHz: cfg.soundFilterHz });
    sound.startMusic();
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

  // ── Mute toggle (start screen top-left) ──────────────────────────────────
  // Also calls sound.init() so that ANY tap on this button unlocks the
  // AudioContext on iOS — even if the user taps it before "SAVE THE DAY".
  document.getElementById('mute-btn').addEventListener('click', () => {
    sound.init();   // safe to call multiple times; iOS: unlocks AudioContext on first tap
    const nowMuted = !sound.getMuted();
    sound.setMuted(nowMuted);
    document.getElementById('mute-btn').textContent = nowMuted ? '🔇' : '🔊';
  });

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

  // ── Ship selector wiring ─────────────────────────────────────────────────
  const SHIP_KEYS = ['motorboat', 'motorboat_2', 'destroyer', 'jetboat'];

  function selectShip(index) {
    if (isShipLocked(index)) return;   // locked ships cannot be selected
    selectedShip = SHIP_KEYS[index];
    document.querySelectorAll('.ship-card').forEach((el, i) => {
      el.classList.toggle('selected', i === index);
    });
    document.querySelectorAll('.ship-dot').forEach((el, i) => {
      el.classList.toggle('active', i === index);
    });
  }

  const _shipCarousel = document.getElementById('ship-carousel');

  function scrollToShip(index, smooth = true) {
    if (!_shipCarousel) return;
    const card = document.getElementById(`ship-card-${index}`);
    if (!card) return;
    const carouselRect = _shipCarousel.getBoundingClientRect();
    const cardRect     = card.getBoundingClientRect();
    const cardCenter   = _shipCarousel.scrollLeft + cardRect.left - carouselRect.left + cardRect.width / 2;
    const target       = cardCenter - _shipCarousel.clientWidth / 2;
    _shipCarousel.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'instant' });
  }

  if (_shipCarousel) {
    // Scroll to card 0 on load
    requestAnimationFrame(() => scrollToShip(0, false));

    // Update selection as user swipes
    _shipCarousel.addEventListener('scroll', () => {
      const carouselRect = _shipCarousel.getBoundingClientRect();
      const carouselCenter = carouselRect.left + carouselRect.width / 2;
      const cards = _shipCarousel.querySelectorAll('.ship-card');
      let closest = 0, minDist = Infinity;
      cards.forEach((card, i) => {
        const cardRect = card.getBoundingClientRect();
        const cardCenter = cardRect.left + cardRect.width / 2;
        const dist = Math.abs(cardCenter - carouselCenter);
        if (dist < minDist) { minDist = dist; closest = i; }
      });
      selectShip(closest);
    }, { passive: true });

    // Tap a card to select and center it
    document.querySelectorAll('.ship-card').forEach((card, i) => {
      card.addEventListener('click', () => scrollToShip(i));
    });
  }

  // Dot clicks
  document.querySelectorAll('.ship-dot').forEach((dot, i) => {
    dot.addEventListener('click', () => scrollToShip(i));
  });

  // Initialize selection
  selectShip(0);

  // ── Map selector wiring ───────────────────────────────────────────────────
  function selectMap(index) {
    if (isMapLocked(index)) return;    // locked maps cannot be selected
    selectedMapIndex = index;
    localStorage.setItem('sb_selectedMap', index);
    document.querySelectorAll('.map-card').forEach((el, i) => {
      el.classList.toggle('selected', i === index);
    });
    document.querySelectorAll('.map-dot').forEach((el, i) => {
      el.classList.toggle('active', i === index);
    });
  }

  // Apply the persisted selection to the UI on load.
  selectMap(selectedMapIndex);

  // ── Map carousel scroll helpers ───────────────────────────────────────────
  // scrollIntoView(inline:'start') ignores our centering padding, so we
  // calculate scrollLeft manually: card's offsetLeft + half card width
  // minus half carousel client width puts the card center at carousel center.
  const _carousel = document.getElementById('map-carousel');

  function scrollToCard(index, smooth = true) {
    if (!_carousel) return;
    const card = document.getElementById(`map-card-${index}`);
    if (!card) return;
    // getBoundingClientRect gives position relative to viewport, so subtract
    // the carousel's own left edge and add current scrollLeft to get the
    // scroll-content position — unaffected by padding or offset parent quirks.
    const carouselRect = _carousel.getBoundingClientRect();
    const cardRect     = card.getBoundingClientRect();
    const cardCenter   = _carousel.scrollLeft + cardRect.left - carouselRect.left + cardRect.width / 2;
    const target       = cardCenter - _carousel.clientWidth / 2;
    _carousel.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'instant' });
  }

  if (_carousel) {
    // Scroll to persisted card on load — defer so layout is fully complete.
    requestAnimationFrame(() => scrollToCard(selectedMapIndex, false));

    // Update selected map as user swipes — compare card centers to carousel center.
    _carousel.addEventListener('scroll', () => {
      const carouselCenter = _carousel.scrollLeft + _carousel.clientWidth / 2;
      const cards = _carousel.querySelectorAll('.map-card');
      let closest = 0, minDist = Infinity;
      cards.forEach((card, i) => {
        const cardCenter = card.offsetLeft + card.offsetWidth / 2;
        const dist = Math.abs(cardCenter - carouselCenter);
        if (dist < minDist) { minDist = dist; closest = i; }
      });
      if (closest !== selectedMapIndex) selectMap(closest);
    }, { passive: true });
  }

  // Card clicks — select and scroll to the clicked map.
  document.querySelectorAll('.map-card').forEach((card, i) => {
    card.addEventListener('click', () => {
      selectMap(i);
      scrollToCard(i);
    });
  });

  // Dot clicks — scroll to the corresponding card, centered.
  document.querySelectorAll('.map-dot').forEach((dot, i) => {
    dot.addEventListener('click', () => {
      selectMap(i);
      scrollToCard(i);
    });
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
      // ── Zoom out — max 1.5s use, 2s cooldown ──────────────────────────
      const ZOOM_MAX = 1.5;   // seconds zoom can be held
      const ZOOM_COOLDOWN = 2.0;   // seconds before zoom is available again

      const zoomPressed = (inputState.zoomOut || zoomBtn) && !isShielded;

      if (zoomCooldown > 0) {
        // On cooldown — can't use zoom regardless of input
        zoomCooldown = Math.max(0, zoomCooldown - dt);
        renderer.setZoomOut(false);
      } else if (zoomPressed && zoomActiveTime < ZOOM_MAX) {
        // Zoom is active and within time limit
        zoomActiveTime += dt;
        renderer.setZoomOut(true);
      } else if (zoomPressed && zoomActiveTime >= ZOOM_MAX) {
        // Time limit hit — cut zoom and start cooldown
        zoomActiveTime = 0;
        zoomCooldown = ZOOM_COOLDOWN;
        renderer.setZoomOut(false);
      } else {
        // Not pressed — reset the usage timer (no cooldown for releasing early)
        zoomActiveTime = 0;
        renderer.setZoomOut(false);
      }

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
          `depth charges: ${dcCharges}/${SHIP_CONFIGS[selectedShip].dcCharges}  fuse: ${dcFuse}`;
      }
    },

    draw(dt) {
      renderer.draw(ship, camera, dt, elapsedTime, dcPending);
    },
  });

  // ── Load player progression ───────────────────────────────────────────────
  // Await so unlock state is known before the player touches the carousels.
  await loadPlayerRecord();
  progressionLoaded = true;
  // If the persisted map selection is now locked (new device, cleared data, etc.)
  // quietly fall back to map 1 so the game always starts in a valid state.
  if (isMapLocked(selectedMapIndex)) {
    selectedMapIndex = 0;
    localStorage.setItem('sb_selectedMap', '0');
    selectMap(0);
    requestAnimationFrame(() => scrollToCard(0, false));
  }
  applyUnlockUI();

  loop.start();
  console.log('[SailBuddy] running — P for debug overlay');

})();
