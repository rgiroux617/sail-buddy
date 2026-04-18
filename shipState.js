// shipState.js
// Owns the ship's continuous world position, heading, and speed.
// No rendering — pure data and physics.
//
// Collision reporting:
//   isBlocked is true for any frame where terrain stopped at least one axis.
//   Resets to false automatically at the start of each update().

const DEFAULT_BASE_SPEED  = 55;    // world-pixels per second, normal sailing
const DEFAULT_BOOST_SPEED = 110;   // world-pixels per second, boosted
const TURN_RATE           = 72;    // degrees per second
const SHIELD_SPEED_MULT   = 0.4;   // 60% speed reduction while shielded — tweak freely

export function createShipState({ startX, startY, startHeading = 0,
                                  baseSpeed = DEFAULT_BASE_SPEED,
                                  boostSpeed = DEFAULT_BOOST_SPEED }) {
  let x             = startX;
  let y             = startY;
  let heading       = startHeading;
  let blocked       = false;
  let currentBase   = baseSpeed;
  let currentBoost  = boostSpeed;

  return {
    update(dt, input, terrain = null, mapW = 0, mapH = 0) {
      // 1. Turn — still works even while braking
      if (input.turnLeft)  heading -= TURN_RATE * dt;
      if (input.turnRight) heading += TURN_RATE * dt;
      heading = ((heading % 360) + 360) % 360;

      // 2. Speed — boost increases, shield slows movement
      const speed      = input.boost ? currentBoost : currentBase;
      const finalSpeed = input.shield ? speed * SHIELD_SPEED_MULT : speed;

      const rad = (heading * Math.PI) / 180;
      const dx = Math.sin(rad) * finalSpeed * dt;
      const dy = -Math.cos(rad) * finalSpeed * dt;

      // 3. Per-axis terrain collision
      blocked = false;

      if (terrain) {
        const PROBE = 16;   // world-px — tune this to match visual hull edge
        const nx = x + dx;
        if (!terrain.isLand(nx + Math.sin(rad) * PROBE, y + (-Math.cos(rad)) * PROBE)) {
          x = nx;
        } else { blocked = true; }

        const ny = y + dy;
        if (!terrain.isLand(x + Math.sin(rad) * PROBE, ny + (-Math.cos(rad)) * PROBE)) {
          y = ny;
        } else { blocked = true; }
      } else {
        x += dx;
        y += dy;
      }

      // 4. Hard clamp to map bounds
      if (mapW > 0) x = Math.max(10, Math.min(mapW - 10, x));
      if (mapH > 0) y = Math.max(10, Math.min(mapH - 10, y));
    },

    get x()         { return x; },
    get y()         { return y; },
    get heading()   { return heading; },
    get isBlocked() { return blocked; },

    setPosition(nx, ny) { x = nx; y = ny; },
    setHeading(deg)     { heading = ((deg % 360) + 360) % 360; },
    setSpeeds(base, boost) { currentBase = base; currentBoost = boost; },
  };
}
