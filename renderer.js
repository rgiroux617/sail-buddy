// renderer.js
// Draw order (back to front):
//   1. Dark background fill
//   2. Map background image
//   3. Goal markers
//   4. Fog of war overlay
//   5. Wake trail (over fog, under ship — always in revealed territory)
//   6. Shield ring (when active)
//   7. Ship sprite
//   8. Anchor shock rings (world-space)
//   9. Radar ping ring (screen-space)
//  10. Radar edge flashes (screen-space)
//  11. Damage vignette (screen-space)

// ── Tweakable constants ────────────────────────────────────────────────────────
const ZOOM_NORMAL  = 2.5;
const ZOOM_OUT     = 0.6;
const ZOOM_SPEED   = 0.3;
const SHIP_SIZE    = 48;
const MARKER_SIZE  = 28;
const MARKER_ICON  = '⚓';

// Shield ring
const SHIELD_RADIUS     = 38;
const SHIELD_COLOR      = 'rgba(100, 200, 255, 0.55)';
const SHIELD_GLOW_COLOR = 'rgba(100, 200, 255, 0.15)';
const SHIELD_WIDTH      = 3;
const SHIELD_PULSE_HZ   = 1.2;

// Anchor shock ring
const SHOCK_DURATION     = 0.4;
const SHOCK_MAX_RADIUS   = 70;
const SHOCK_START_RADIUS = 20;
const SHOCK_COLOR        = 'rgba(255, 230, 80, 1)';

// Damage vignette
const VIGNETTE_DURATION = 0.5;
const VIGNETTE_COLOR    = 'rgba(220, 40, 40,';

// Wake constants
const WAKE_POINT_INTERVAL = 0.06;
const WAKE_LIFETIME       = 2.8;
const WAKE_MAX_WIDTH      = 22;
const WAKE_MIN_WIDTH      = 4;
const WAKE_WOBBLE_AMP     = 3.5;
const WAKE_WOBBLE_HZ      = 0.9;
const WAKE_COLOR          = 'rgba(180, 220, 255,';

const MINE_SIZE    = 18;
const MINE_BOB_AMP = 3;
const MINE_BOB_HZ  = 0.4;

// Radar constants
const RADAR_PING_DURATION   = 0.7;   // seconds for outgoing ring
const RADAR_PING_MAX_RADIUS = 180;   // world-px max radius of ping
const RADAR_FLASH_DURATION  = 1.8;   // seconds edge flashes stay visible
const RADAR_FLASH_WIDTH     = 80;    // screen-px width of edge flash band

// Depth charge constants
// 4 hexes radius at SIZE=22 and DX=33: ~4 * 33 ≈ 132 world-px is the gameplay radius.
// The visual rings expand a bit beyond that for drama.
const DC_DURATION      = 1.2;   // seconds for the full wave animation
const DC_MAX_RADIUS    = 155;   // world-px — slightly beyond the 4-hex gameplay radius
const DC_RING_COUNT    = 4;     // number of concentric rings staggered in time
const DC_RING_DELAY    = 0.12;  // seconds between each ring's start

export function createRenderer(canvas, mapW, mapH) {
  const ctx = canvas.getContext('2d');

  let bgImage      = null;
  let shipImageA   = null;   // motorboat
  let shipImageB   = null;   // motorboat_2
  let shipImage    = null;   // currently active ship
  let markers      = [];
  let fogLayer     = null;
  let shielded     = false;
  let mineImage       = null;
  let dcMapImage      = null;   // depth-charge-map.png — the dropped marker
  let hourglassImage  = null;
  let hourglasses     = [];

  let currentZoom = ZOOM_NORMAL;
  let targetZoom  = ZOOM_NORMAL;
  let introZoom   = null;

  // Shock state
  const shocks = [];

  // Depth charge state — each entry: { age, x, y }
  const depthCharges = [];

  // Vignette state
  let vignetteAge = VIGNETTE_DURATION;

  // Wake state
  const wakePoints = [];
  let wakeTimer    = 0;
  let wakeIndex    = 0;

  // Radar state
  let radarPingAge   = null;
  const radarFlashes = [];

  async function loadImages(bgUrl, shipUrlA, shipUrlB, mineUrl, dcMapUrl, hourglassUrl) {
    [bgImage, shipImageA, shipImageB, mineImage, dcMapImage, hourglassImage] = await Promise.all([
      _loadImage(bgUrl),
      _loadImage(shipUrlA),
      _loadImage(shipUrlB),
      _loadImage(mineUrl),
      _loadImage(dcMapUrl),
      _loadImage(hourglassUrl),
    ]);
    shipImage = shipImageA;   // default to motorboat
  }

  function setHourglasses(newHourglasses) { hourglasses = newHourglasses; }

  function setShipImage(key) {
    shipImage = key === 'motorboat_2' ? shipImageB : shipImageA;
  }

  function setMarkers(newMarkers) { markers = newMarkers; }
  function setFog(fog)            { fogLayer = fog; }
  function setZoomOut(active)     { targetZoom = active ? ZOOM_OUT : ZOOM_NORMAL; }
  function setShielded(active)    { shielded = active; }
  function setIntroZoom(z)        { introZoom = z; if (z !== null) { currentZoom = z; targetZoom = z; } }
  function triggerShock(wx, wy)       { shocks.push({ age: 0, x: wx, y: wy }); }
  function triggerVignette()          { vignetteAge = 0; }
  function triggerDepthCharge(wx, wy) { depthCharges.push({ age: 0, x: wx, y: wy }); }

  // Radar trigger — called from main.js when shield+zoom held simultaneously
  function triggerRadar(shipX, shipY, activeMarkers) {
    radarPingAge = 0;
    radarFlashes.length = 0;

    const entries = activeMarkers
      .filter(m => !m.reached)
      .map(m => {
        const dx    = m.x - shipX;
        const dy    = m.y - shipY;
        const dist  = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dx, -dy);  // bearing: 0=up, clockwise
        return { angle, dist };
      });

    if (entries.length === 0) return;

    const minDist = Math.min(...entries.map(e => e.dist));
    const maxDist = Math.max(...entries.map(e => e.dist));
    const range   = maxDist - minDist || 1;

    entries.forEach(e => {
      // Closest mine = 1.0, farthest = 0.2
      const intensity = 0.2 + 0.8 * (1 - (e.dist - minDist) / range);
      radarFlashes.push({ angle: e.angle, intensity, age: 0 });
    });
  }

  function addWakePoint(wx, wy, heading, dt) {
    wakeTimer += dt;
    if (wakeTimer >= WAKE_POINT_INTERVAL) {
      wakeTimer = 0;
      wakePoints.push({ x: wx, y: wy, heading, age: 0, index: wakeIndex++ });
    }
    for (let i = wakePoints.length - 1; i >= 0; i--) {
      wakePoints[i].age += dt;
      if (wakePoints[i].age >= WAKE_LIFETIME) wakePoints.splice(i, 1);
    }
  }

  function draw(ship, camera, dt, elapsedTime = 0, dcPending = null) {
    const W = canvas.width;
    const H = canvas.height;

    // Advance shocks
    for (let i = shocks.length - 1; i >= 0; i--) {
      shocks[i].age += dt;
      if (shocks[i].age >= SHOCK_DURATION) shocks.splice(i, 1);
    }

    // Advance depth charges
    for (let i = depthCharges.length - 1; i >= 0; i--) {
      depthCharges[i].age += dt;
      if (depthCharges[i].age >= DC_DURATION + DC_RING_DELAY * (DC_RING_COUNT - 1)) {
        depthCharges.splice(i, 1);
      }
    }

    // Advance vignette
    vignetteAge = Math.min(vignetteAge + dt, VIGNETTE_DURATION);

    // Zoom — intro overrides the lerp; normal play lerps toward target
    if (introZoom !== null) {
      currentZoom = introZoom;
    } else {
      const maxStep = (Math.abs(ZOOM_NORMAL - ZOOM_OUT) / ZOOM_SPEED) * dt;
      if (Math.abs(currentZoom - targetZoom) <= maxStep) {
        currentZoom = targetZoom;
      } else {
        currentZoom += Math.sign(targetZoom - currentZoom) * maxStep;
      }
    }

    // 1. Clear
    ctx.fillStyle = '#1a2a35';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.scale(currentZoom, currentZoom);
    const ox = ship.x - (W / currentZoom) / 2;
    const oy = ship.y - (H / currentZoom) / 2;
    ctx.translate(-ox, -oy);

    // 2. Map background
    if (bgImage) {
      ctx.drawImage(bgImage, 0, 0, mapW, mapH);
    } else {
      ctx.fillStyle = '#3c6270';
      ctx.fillRect(0, 0, mapW, mapH);
    }

    // 3. Goal markers
    markers.forEach((m, i) => {
      if (m.reached) return;
      const bob  = Math.sin(elapsedTime * Math.PI * 2 * MINE_BOB_HZ + i * 1.3) * MINE_BOB_AMP;
      const half = MINE_SIZE / 2;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur  = 8;
      if (mineImage) {
        ctx.drawImage(mineImage, m.x - half, m.y - half + bob, MINE_SIZE, MINE_SIZE);
      } else {
        ctx.font         = `${MINE_SIZE}px sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('💣', m.x, m.y + bob);
      }
      ctx.restore();
    });

    // 3.5. Hourglasses
    const HOURGLASS_SIZE = 22;
    hourglasses.forEach((h, i) => {
      if (h.collected) return;
      const bob  = Math.sin(elapsedTime * Math.PI * 2 * MINE_BOB_HZ + i * 2.1) * MINE_BOB_AMP;
      const half = HOURGLASS_SIZE / 2;
      ctx.save();
      ctx.shadowColor = 'rgba(80, 220, 120, 0.6)';
      ctx.shadowBlur  = 10;
      if (hourglassImage) {
        ctx.drawImage(hourglassImage, h.x - half, h.y - half + bob, HOURGLASS_SIZE, HOURGLASS_SIZE);
      } else {
        ctx.font         = `${HOURGLASS_SIZE}px sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⏳', h.x, h.y + bob);
      }
      ctx.restore();
    });

    // 4. Fog
    if (fogLayer) fogLayer.draw(ctx);

    // 5. Wake trail
    wakePoints.forEach(p => {
      const t       = p.age / WAKE_LIFETIME;
      const opacity = (1 - t) * 0.45;
      if (opacity < 0.01) return;

      const halfW       = WAKE_MIN_WIDTH + t * (WAKE_MAX_WIDTH - WAKE_MIN_WIDTH);
      const halfH       = halfW * 0.28;
      const wobblePhase = elapsedTime * Math.PI * 2 * WAKE_WOBBLE_HZ + p.index * 0.8;
      const wobble      = Math.sin(wobblePhase) * WAKE_WOBBLE_AMP * t;
      const perpRad     = (p.heading * Math.PI) / 180;
      const perpX       =  Math.cos(perpRad) * wobble;
      const perpY       =  Math.sin(perpRad) * wobble;

      ctx.save();
      ctx.translate(p.x + perpX, p.y + perpY);
      ctx.rotate(((p.heading + 90) * Math.PI) / 180);
      ctx.scale(halfW, halfH);
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fillStyle = `${WAKE_COLOR} ${opacity.toFixed(3)})`;
      ctx.fill();
      ctx.restore();
    });

    // 5.5. Pending depth charge marker — bobbing icon at drop location
    if (dcPending !== null) {
      const DC_MARKER_SIZE = 16;
      const half           = DC_MARKER_SIZE / 2;
      // Fuse progress 0→1 — used for urgency pulsing as it approaches detonation
      const fuseT    = Math.max(0, 1 - (dcPending.timer / 2.5));
      const bob      = Math.sin(elapsedTime * Math.PI * 2 * 1.8) * 3;
      // Pulse glow faster as fuse runs out
      const pulseHz  = 1.5 + fuseT * 4;
      const pulse    = 0.5 + 0.5 * Math.sin(elapsedTime * Math.PI * 2 * pulseHz);
      const glowSize = 18 + pulse * 14;
      const glowAlpha = (0.3 + pulse * 0.35).toFixed(3);

      ctx.save();
      ctx.translate(dcPending.x, dcPending.y + bob);

      // Orange glow behind the icon
      ctx.beginPath();
      ctx.arc(0, 0, glowSize, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 140, 20, ${glowAlpha})`;
      ctx.fill();

      // The icon itself
      if (dcMapImage) {
        ctx.drawImage(dcMapImage, -half, -half, DC_MARKER_SIZE, DC_MARKER_SIZE);
      } else {
        // Fallback: orange circle with a cross-hair if image didn't load
        ctx.beginPath();
        ctx.arc(0, 0, half, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 140, 20, 0.9)';
        ctx.fill();
      }
      ctx.restore();
    }

    // 6. Shield ring
    if (shielded) {
      const pulse = 0.6 + 0.4 * Math.sin(elapsedTime * Math.PI * 2 * SHIELD_PULSE_HZ);
      ctx.save();
      ctx.translate(ship.x, ship.y);
      ctx.beginPath();
      ctx.arc(0, 0, SHIELD_RADIUS + 6, 0, Math.PI * 2);
      ctx.strokeStyle = SHIELD_GLOW_COLOR;
      ctx.lineWidth   = SHIELD_WIDTH + 6;
      ctx.globalAlpha = pulse;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, SHIELD_RADIUS, 0, Math.PI * 2);
      ctx.strokeStyle = SHIELD_COLOR;
      ctx.lineWidth   = SHIELD_WIDTH;
      ctx.globalAlpha = pulse;
      ctx.stroke();
      ctx.restore();
    }

    // 7. Ship
    _drawShip(ctx, ship.x, ship.y, ship.heading);

    // 8. Shock rings
    shocks.forEach(shock => {
      const t      = shock.age / SHOCK_DURATION;
      const eased  = 1 - (1 - t) * (1 - t);
      const radius = SHOCK_START_RADIUS + eased * (SHOCK_MAX_RADIUS - SHOCK_START_RADIUS);
      ctx.save();
      ctx.translate(shock.x, shock.y);
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.strokeStyle = SHOCK_COLOR;
      ctx.lineWidth   = 3 * (1 - t * 0.5);
      ctx.globalAlpha = 1 - t;
      ctx.stroke();
      ctx.restore();
    });

    // 8.5. Depth charge waves — orange expanding rings in world space
    depthCharges.forEach(dc => {
      for (let ring = 0; ring < DC_RING_COUNT; ring++) {
        const ringAge = dc.age - ring * DC_RING_DELAY;
        if (ringAge <= 0) continue;               // this ring hasn't started yet
        const t      = Math.min(ringAge / DC_DURATION, 1);
        const eased  = 1 - (1 - t) * (1 - t);   // ease-out quad
        const radius = eased * DC_MAX_RADIUS;
        const alpha  = (1 - t) * (ring === 0 ? 0.9 : 0.6);
        if (alpha < 0.01) continue;

        ctx.save();
        ctx.translate(dc.x, dc.y);

        // Thick outer glow ring
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 140, 20, ${(alpha * 0.4).toFixed(3)})`;
        ctx.lineWidth   = 18 * (1 - t * 0.5);
        ctx.stroke();

        // Crisp bright inner ring
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 200, 60, ${alpha.toFixed(3)})`;
        ctx.lineWidth   = 3;
        ctx.stroke();

        ctx.restore();
      }
    });

    ctx.restore();   // end world-space transform

    // 9. Radar ping ring — screen-space, expands from canvas center
    if (radarPingAge !== null) {
      radarPingAge += dt;
      const t      = radarPingAge / RADAR_PING_DURATION;
      const eased  = 1 - (1 - t) * (1 - t);
      const radius = eased * RADAR_PING_MAX_RADIUS * currentZoom;
      const alpha  = (1 - t) * 0.7;

      if (t < 1) {
        ctx.save();
        // Outer glow
        ctx.beginPath();
        ctx.arc(W / 2, H / 2, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(80, 220, 120, ${(alpha * 0.5).toFixed(3)})`;
        ctx.lineWidth   = 8;
        ctx.stroke();
        // Inner crisp ring
        ctx.beginPath();
        ctx.arc(W / 2, H / 2, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(160, 255, 180, ${alpha.toFixed(3)})`;
        ctx.lineWidth   = 2;
        ctx.stroke();
        ctx.restore();
      } else {
        radarPingAge = null;
      }
    }

    // 10. Radar edge circles — pulsing rings at screen edge in mine direction
    for (let i = radarFlashes.length - 1; i >= 0; i--) {
      const flash = radarFlashes[i];
      flash.age += dt;

      if (flash.age >= RADAR_FLASH_DURATION) {
        radarFlashes.splice(i, 1);
        continue;
      }

      const fadeIn = Math.min(flash.age / 0.15, 1);
      const fadeOut = 1 - Math.max(
        (flash.age - RADAR_FLASH_DURATION * 0.6) / (RADAR_FLASH_DURATION * 0.4), 0
      );
      const baseAlpha = flash.intensity * fadeIn * fadeOut * 1.6;
      if (baseAlpha < 0.01) continue;

      // Find where bearing hits the screen edge
      const cx = W / 2;
      const cy = H / 2;
      const sin = Math.sin(flash.angle);
      const cos = -Math.cos(flash.angle);
      const tx = sin !== 0 ? (sin > 0 ? (W - cx) : -cx) / sin : Infinity;
      const ty = cos !== 0 ? (cos > 0 ? (H - cy) : -cy) / cos : Infinity;
      const tMin = Math.min(Math.abs(tx), Math.abs(ty));
      const ex = cx + sin * tMin;
      const ey = cy + cos * tMin;

      // Two expanding rings per flash — offset in phase so they ripple
      for (let ring = 0; ring < 2; ring++) {
        const ringPhase = (flash.age * 0.8 + ring * 0.5) % 1;  // 0→1 per cycle
        const ringRadius = 28 + ringPhase * 90 * flash.intensity;
        const ringAlpha = baseAlpha * (1 - ringPhase) *
          (ring === 0 ? 1.0 : 0.5);             // second ring dimmer

        ctx.save();
        ctx.beginPath();
        ctx.arc(ex, ey, ringRadius, 0, Math.PI * 2);
        // Bright core color for closest mines, dimmer green for farther
        const r = Math.round(80 + flash.intensity * 140);
        const g = Math.round(200 + flash.intensity * 55);
        const b = Math.round(120 + flash.intensity * 80);
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${ringAlpha.toFixed(3)})`;
        ctx.lineWidth = 2.5 - ringPhase * 1.5;
        ctx.stroke();

        // Filled bright dot at center for closest mine only
        if (flash.intensity > 0.5 && ring === 0) {
          ctx.beginPath();
          ctx.arc(ex, ey, 4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(220, 255, 220, ${(baseAlpha * 0.9).toFixed(3)})`;
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // 11. Damage vignette — screen space
    const vignetteOpacity = 1 - vignetteAge / VIGNETTE_DURATION;
    if (vignetteOpacity > 0.01) {
      const grad = ctx.createRadialGradient(
        W / 2, H / 2, H * 0.3,
        W / 2, H / 2, H * 0.85
      );
      grad.addColorStop(0, `${VIGNETTE_COLOR} 0)`);
      grad.addColorStop(1, `${VIGNETTE_COLOR} ${(vignetteOpacity * 0.7).toFixed(3)})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function _drawShip(ctx, wx, wy, headingDeg) {
    ctx.save();
    ctx.translate(wx, wy);
    ctx.rotate(((headingDeg + 180) * Math.PI) / 180);
    if (shipImage) {
      const half = SHIP_SIZE / 2;
      ctx.drawImage(shipImage, -half, -half, SHIP_SIZE, SHIP_SIZE);
    } else {
      ctx.fillStyle   = '#f0e6d0';
      ctx.strokeStyle = '#4a3a20';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -18);
      ctx.lineTo(10, 14);
      ctx.lineTo(-10, 14);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Reset all transient visual state ───────────────────────────────────────
  // Called by main.js on "Return to Port" so leftover wake, shocks, radar
  // flashes, and vignette from the previous run don't bleed into the new one.
  // Images, markers, and fog layer are left alone (they're re-supplied by
  // the reset flow in main.js).
  function reset() {
    shocks.length        = 0;
    depthCharges.length  = 0;
    wakePoints.length    = 0;
    wakeTimer           = 0;
    wakeIndex           = 0;
    radarPingAge        = null;
    radarFlashes.length = 0;
    vignetteAge         = VIGNETTE_DURATION;
    currentZoom         = ZOOM_NORMAL;
    targetZoom          = ZOOM_NORMAL;
    introZoom           = null;
    shielded            = false;
  }

  return {
    loadImages, draw, setMarkers, setFog, setZoomOut, setShielded,
    triggerShock, triggerVignette, triggerDepthCharge, addWakePoint,
    setIntroZoom, triggerRadar, setShipImage, setHourglasses, reset,
    get zoom() { return currentZoom; },
  };
}

function _loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => { console.warn(`[renderer] Failed to load: ${url}`); resolve(null); };
    img.src = url;
  });
}
