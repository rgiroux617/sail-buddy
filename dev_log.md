# SailBuddy Dev Log
**Game title:** Minesweeper: Hormuz Edition  
**Presented by:** Bugman Industries  
**Last updated:** 2026-04-16

---

## SESSION OPENER (do this at the start of every session)

> **Hey Claude — before we start, please read all the SailBuddy source files so you know the current state of the code, then check the dev log for context on where we left off.**

Files to read:
- `dev_log.md` (this file)
- `main.js`, `index.html`
- `shipState.js`, `renderer.js`, `terrain.js`
- `fog.js`, `gameLoop.js`, `sound.js`, `input.js`, `camera.js`
- `results.js` (end-screen lookup table, added 2026-04-16)

---

## Project Overview

A browser-based top-down sailing game built with vanilla JavaScript and HTML5 Canvas. The player pilots a boat through the Strait of Hormuz on a hex-grid map, trying to locate and clear 5 mines within a 2-minute countdown. No build step — all ES modules, runs directly in browser.

**File structure:**
| File | Role |
|---|---|
| `index.html` | Shell, all CSS, UI overlays (start screen, HUD, end screens, ad modal) |
| `main.js` | Entry point — wires all modules, owns game state and game loop logic |
| `shipState.js` | Ship physics: position, heading, speed, braking, collision reporting |
| `renderer.js` | All canvas drawing, layered back-to-front |
| `terrain.js` | Loads hex map JSON, land/water detection, random water hex picking |
| `fog.js` | Fog of war via offscreen canvas + destination-out compositing |
| `gameLoop.js` | requestAnimationFrame loop with dt cap |
| `sound.js` | Web Audio synthesized sounds (engine, collision, mine hit, radar ping) |
| `input.js` | Keyboard + on-screen button input → shared state object |
| `camera.js` | Viewport offset so ship stays centered (largely superseded by renderer's inline transform) |
| `campaign_default.json` | Hex map terrain data |
| `CompiledBackground.jpeg` | Pre-rendered background image of the Strait |
| `implication_zoom_2.svg` | Ship sprite |
| `mine.png` | Mine sprite |
| `results.js` | 31-row lookup table for the debrief end-screen (indexed by `minesLeft`) |
| `results.xlsx` | Source-of-truth spreadsheet for the results table — edit here, then regenerate `results.js` |

---

## Key Constants (current values as of last read)

### main.js
- Mine count: `ANCHOR_COUNT = 30`
- Mine detection radius: `ANCHOR_RADIUS = SIZE * 1.2` (~26px)
- Mine damage: `ANCHOR_DAMAGE = 10 HP`
- Coastline damage: `HP_PER_COLLISION = 10 HP`
- Collision cooldown: `COLLISION_COOLDOWN = 1.5s`
- Timer: `COUNTDOWN_START = 120s` (2 minutes)
- Urgent threshold (timer goes red): `URGENT_THRESHOLD = 30s`
- Intro zoom: `0.35 → 2.5` over `2.2s`
- Radar cooldown: `RADAR_COOLDOWN = 4.0s`
- Grid: `52 cols × 33 rows`, hex size `22px`, pad `20px`

### shipState.js
- Normal speed: `55 px/s`
- Boost speed: `110 px/s`
- Brake multiplier: `0.20` (80% speed reduction)
- Turn rate: `72 deg/s`
- Shield speed multiplier: `0.4` (60% speed reduction while shielded)
- Collision probe distance: `16px`

### renderer.js
- Normal zoom: `2.5x`
- Zoomed-out: `0.6x`
- Zoom transition speed: `0.3`
- Ship size: `48px`
- Mine size: `18px`, bob amplitude `3px` at `0.4 Hz`
- Shield ring radius: `38px`, pulses at `1.2 Hz`
- Wake: interval `0.06s`, lifetime `2.8s`, max width `22px`
- Shock ring: `0.4s` duration, max radius `70px`
- Vignette: `0.5s` duration (red damage flash)
- Radar ping: `0.7s`, max radius `180px`
- Radar edge flash: `1.8s` duration

### fog.js
- Fog color: `rgba(171, 174, 177, 0.92)` (light grey)
- Reveal radius: `45px` base, ±`2px` pulse at `0.38 Hz`
- Edge softness: `0.85`

### sound.js
- Engine: pulse-based (noise bursts through lowpass filter at `300 Hz`)
- Normal RPM: `1400`, Boost RPM: `2800`, glide time: `0.6s`
- Collision: lowpass at `180 Hz`, `0.45` volume, `0.15s`
- Mine hit: lowpass at `120 Hz` + sine thump `120→30 Hz`, `0.55` volume
- Radar ping: sine `880→220 Hz` over `1.6s`, double ping (second at `0.35` volume)
- Alternate band-pass engine commented out in `sound.js` (good reference)

---

## Architecture Notes

- **No build step.** Pure ES modules — just open `index.html` in a browser (or serve locally).
- **Ad system** is shared with other Bugman apps — pulls from `../BugmanAds/ads-data.js` and `../BugmanAds/ad-engine.js`. The start screen displays a random banner ad; an ad modal is wired in `index.html` for the ad engine to use.
- **Radar mechanic:** Hold shield + zoom simultaneously to trigger. Shows edge flashes pointing toward mines (brightest = nearest). 4-second cooldown.
- **Shield mechanic:** Blocks both mine damage and coastline damage while active. Slows ship to 40% speed.
- **Fog of war:** Permanently revealed as ship explores. Offscreen canvas, destination-out erase. Mines are drawn *under* the fog so they stay hidden until explored.
- **Debug overlay:** Press `P` in-game to toggle a live readout of ship position, heading, blocked state, HP, mines found, radar cooldown, zoom.

---

## Session History

### 2026-04-16 — Bugfix: engine keeps playing after game ends
**Files changed:** `main.js`

The motorboat engine sound was continuing through the debrief screen after the game ended. Fixed by calling `sound.stopEngine()` inside `triggerEnd()` right after `_stopGame()`. `stopEngine()` already existed in `sound.js` with a nice 0.3s fade-out — no changes to `sound.js` needed. When the player hits "Return to Port" and clicks GO again, `startIntro()` calls `startEngine()` which reinitializes the masterGain and starts fresh, so the reset flow still works.

---

### 2026-04-16 — Debrief report-card end screen
**Files changed:** `index.html`, `main.js`, `fog.js`, `renderer.js`, `dev_log.md`
**Files added:** `results.js`, `results_v2.xlsx`

Replaced the two simple "Mission Failed" / "Strait Cleared!" overlays with a single **DEBRIEF** report card themed to match the start screen (warm gradient background + cream `.start-card` panel, Righteous title, Nunito body).

**Card anatomy (top to bottom):**
- "💣 Bugman Industries Debrief" teal subtitle + big "DEBRIEF" title.
- Hero stats row: 🚢 Tankers Destroyed + 🛢️ Barrels Spilled (big orange numbers).
- Small secondary stat: `Hull: X / 100`.
- 2×2 grid of flavor verdicts: 📉 Economic / 🐟 Ecological / 🏛️ Political / 🔮 Future.
- Italic Bible-verse quip (placeholder until Ray replaces with a real quip column).
- Random BugmanAds banner (fresh each time the card is shown).
- Orange "⚓ RETURN TO PORT ⚓" button — does a full in-place reset, no page reload.

**What drives the content:** a single `minesLeft = ANCHOR_COUNT - anchorsFound` value is fed to `resultForMinesLeft()` in `results.js`, which returns the row. Every end condition (hull to 0, timer to 0, all 30 cleared) shows the same card — the only thing that varies is the lookup row.

**`index.html`** — removed `#game-over` and `#goal-reached` blocks and their CSS. Added `#end-screen` block with hero-stats row, 2×2 verdict grid, quip, ad slot, and return-to-port button. Kept `.overlay-btn` as a small shared utility class (still used by `#how-to-close`).

**`main.js`** — imports `resultForMinesLeft` from `./results.js`. Replaced `triggerGameOver()` + `triggerWin()` with one `triggerEnd(reason)` that populates the card and shows it. Added `resetGame()` for the Return-to-Port button — resets all scalar state (`hp`, `anchorsFound`, `timeRemaining`, cooldowns, intro flags), re-randomizes mines, resets ship position/heading, calls `fog.reset()` and `renderer.reset()`, and re-shows the start screen with a fresh random ad. Extracted `populateAdSlot(slotId)` helper so the start screen and end screen use the same ad wiring. Changed `const markers` → `let markers` so the reset flow can re-assign it.

**`fog.js`** — added `reset()` method. Refills the offscreen canvas with the base fog color and clears the lastX/lastY cache so the next `revealAt` actually redraws.

**`renderer.js`** — added `reset()` method. Clears `shocks`, `wakePoints`, `wakeTimer`, `wakeIndex`, `radarPingAge`, `radarFlashes`, resets `vignetteAge`, and returns zoom to `ZOOM_NORMAL`. Images, markers, and fog layer are left alone since the reset flow in main.js re-supplies markers.

**`results.js` (new)** — exports a 31-row `RESULTS` array indexed by `minesLeft` (0 = cleared, 30 = full disaster). Each row has `tankers`, `oilB`, `economic`, `ecological`, `political`, `future`, `quip`. Also exports `resultForMinesLeft(n)` with bounds clamping. Oil values are the snapshot from the spreadsheet's last cached recalc (the xlsx uses a `RAND()` formula so oil jitters with each open — we snapshot rather than duplicating that randomness).

**`results_v2.xlsx` (new)** — same as `results.xlsx` but with a new column J labeled `quip`, pre-filled with 31 severity-scaled Bible verses. Intended to replace `results.xlsx` when Ray has a chance to rename it manually (the sandbox can't overwrite existing binary files in the mounted folder).

**Known quirks / follow-ups:**
- Sound engine keeps running across reset — when the player is back on the start screen they may still hear the engine sputter for a split second until they click GO again. Minor; fix later if it feels wrong.
- The quip column is placeholder Bible verses per Ray's request ("for now just cite bible verses"). Replace with proper copy when the tone for each row is finalized.
- If `results.xlsx` values are edited, re-run the regen snippet below to refresh `results.js`.

**Regenerating `results.js` from `results.xlsx`:**
```python
from openpyxl import load_workbook
wb = load_workbook('results.xlsx', data_only=True)
ws = wb.active
rows = []
for r in range(8, 39):
    mines_left, tankers, oil, eco, ecol, pol, fut, quip = [
        ws.cell(row=r, column=c).value for c in [4,5,6,7,8,9,10,11]
    ]
    rows.append((mines_left, tankers, oil, eco, ecol, pol, fut, quip))
rows.sort(key=lambda x: x[0])
# then dump to results.js in the same format as the hand-written file
```

---

### 2026-04-15 — Ship selection system
**Files changed:** `index.html`, `renderer.js`, `shipState.js`, `sound.js`, `main.js`

Added a two-ship selection system to the start screen.

- **`index.html`** — Added "Pick your Ship" section between the how-to button and controls grid. Two selectable `.ship-card` divs side by side (`#ship-motorboat`, `#ship-motorboat2`), each with a 192×192 PNG and an italic quip label. CSS handles selected state (orange border + glow) and hover.
- **`renderer.js`** — `loadImages()` now accepts two ship URLs (`shipUrlA`, `shipUrlB`), stores both, defaults to `shipImageA`. New `setShipImage(key)` method switches active sprite.
- **`shipState.js`** — `createShipState()` now accepts optional `baseSpeed` / `boostSpeed` params (defaults: 55/110). New `setSpeeds(base, boost)` method for runtime updates. `BRAKE_MULT` and `SHIELD_SPEED_MULT` remain fixed regardless of ship.
- **`sound.js`** — `startEngine()` now accepts `{ normalRpm, boostRpm, filterHz }` overrides. Stores as `engineNormalRpm`, `engineBoostRpm`, `pulseFilterHz`. `setBoost()` uses engine-specific values. `_schedulePulse()` uses `pulseFilterHz` instead of hardcoded 300.
- **`main.js`** — Added `SHIP_CONFIGS` object with both ship profiles. `selectedShip` tracks current choice (default: `'motorboat'`). Selector cards wired with click listeners. `startIntro()` now applies config: calls `ship.setSpeeds()`, updates `timeRemaining`, calls `renderer.setShipImage()`, and passes sound params to `startEngine()`.

**Ship stats:**
| Ship | Base speed | Boost | Countdown | Sound RPM | Filter |
|---|---|---|---|---|---|
| motorboat | 55 | 110 | 2:00 | 1400/2800 | 300 Hz |
| motorboat_2 | 71.5 | 143 | 1:45 | 2000/3600 | 450 Hz |

**Also noted:** `ANCHOR_COUNT` is 30 (dev log had 5 — corrected below), `ANCHOR_DAMAGE` is 10 HP (not 25).

- **Next steps:** Power-ups system.

---

### 2026-04-15 — Bug fixes: How-to overlay + radar zoom suppression
**Changes made to `main.js`:**

1. **How-to overlay wiring** — Added event listeners for `#how-to-btn` and `#how-to-close`. The CSS classes (`how-to-hidden` / `how-to-visible`) were already correct; the listeners were simply missing. Wired just after the `go-btn` listener.

2. **Radar zoom suppression** — Changed `renderer.setZoomOut(inputState.zoomOut || zoomBtn)` to `renderer.setZoomOut((inputState.zoomOut || zoomBtn) && !isShielded)`. Suppresses zoom-out whenever shield is held, which covers the radar case (radar requires shield + zoom simultaneously). One-line fix.

- **Next steps / open questions:** None specified — awaiting direction from Ray.

---

### 2026-04-15 — Initial dev log created
- First Cowork session with direct file access established.
- Full codebase read and documented above.

---

## Known Issues / To-Do

*Nothing logged yet. Add items here as they come up.*

---

## Decisions & Reasoning Log

*Use this section to record WHY we made specific choices, so future sessions don't re-litigate them.*

- **Pulse engine over band-pass:** Band-pass alternate is preserved as commented code in `sound.js` in case we want to switch. Current pulse engine was chosen for its more realistic low-RPM "thup thup" behavior.
- **Mines drawn under fog:** Intentional — player must physically explore to find mine locations. Radar gives directional hints only.
