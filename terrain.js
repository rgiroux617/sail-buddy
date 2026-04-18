// terrain.js
// Loads hex terrain data, exposes isLand(worldX, worldY) and
// getRandomWaterHexes(count) for placing anchors at startup.
//
// Land detection:
//   null/undefined color → water (passable)
//   '#3c6270'            → water (passable)
//   any other color      → land (blocks ship, can't place anchors)

const COLS  = 52;
const ROWS  = 33;
const SIZE  = 22;
const PAD   = 20;

const WATER_COLOR = '#3c6270';

const HEX_H = Math.sqrt(3) * SIZE;
const DX    = 1.5 * SIZE;
const DY    = HEX_H;

function hexCenter(c, r) {
  return {
    x: PAD + SIZE + c * DX,
    y: PAD + (HEX_H / 2) + r * DY + ((c & 1) ? (DY / 2) : 0),
  };
}

function computeMapSize() {
  let maxX = 0, maxY = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const { x, y } = hexCenter(c, r);
      if (x + SIZE      > maxX) maxX = x + SIZE;
      if (y + HEX_H / 2 > maxY) maxY = y + HEX_H / 2;
    }
  }
  return { mapWidth: Math.ceil(maxX + PAD), mapHeight: Math.ceil(maxY + PAD) };
}

function worldToHex(wx, wy) {
  const approxC = Math.round((wx - PAD - SIZE) / DX);
  const approxR = Math.round((wy - PAD - HEX_H / 2) / DY);

  let bestC = approxC, bestR = approxR, bestDist = Infinity;

  for (let dc = -2; dc <= 2; dc++) {
    for (let dr = -2; dr <= 2; dr++) {
      const c = approxC + dc;
      const r = approxR + dr;
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      const { x, y } = hexCenter(c, r);
      const dist = (wx - x) ** 2 + (wy - y) ** 2;
      if (dist < bestDist) { bestDist = dist; bestC = c; bestR = r; }
    }
  }
  return { c: bestC, r: bestR };
}

export async function loadTerrain(campaignUrl) {
  const res     = await fetch(campaignUrl);
  const json    = await res.json();
  const hexData = json.hex?.data ?? {};

  // Land set — for O(1) collision lookup each frame
  const landSet = new Set();

  // Water hex list — all non-land hex world positions, used for anchor placement
  const waterHexes = [];

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const key = `${c},${r}`;
      const val = hexData[key];
      const isLand = val?.c && val.c !== WATER_COLOR;

      if (isLand) {
        landSet.add(key);
      } else {
        // Both explicitly painted water AND unpainted hexes are eligible
        waterHexes.push({ c, r, ...hexCenter(c, r) });
      }
    }
  }

  const { mapWidth, mapHeight } = computeMapSize();

  return {
    isLand(wx, wy) {
      const { c, r } = worldToHex(wx, wy);
      return landSet.has(`${c},${r}`);
    },

    // Returns `count` randomly chosen water hex world positions.
    // Shuffles a copy so original order is preserved.
    getRandomWaterHexes(count) {
      const pool = [...waterHexes];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, count);
    },

    mapWidth,
    mapHeight,
  };
}
