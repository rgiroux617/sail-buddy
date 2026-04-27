// terrain.js
// Loads hex terrain data, exposes isLand(worldX, worldY),
// getRandomWaterHexes(count), and getPerimeterWaterHexes(count)
// for placing anchors and hourglasses at startup.
//
// Land detection:
//   null/undefined color → water (passable)
//   '#3c6270'            → water (passable)
//   any other color      → land (blocks ship, can't place anchors)
//
// Mine placement (getRandomWaterHexes):
//   Half the requested count is placed using a zone grid to ensure
//   even coverage across the map. The other half is placed fully
//   randomly from the remaining pool.
//
// Hourglass placement (getPerimeterWaterHexes):
//   Returns water hexes found only on the outermost rows and columns
//   of the map, giving hourglasses a perimeter distribution.

const COLS  = 52;
const ROWS  = 33;
const SIZE  = 22;
const PAD   = 20;

const WATER_COLOR = '#3c6270';

const HEX_H = Math.sqrt(3) * SIZE;
const DX    = 1.5 * SIZE;
const DY    = HEX_H;

// Zone grid dimensions for the structured half of mine placement.
// 4 columns × 3 rows = 12 zones across the 52×33 hex map.
const ZONE_COLS = 4;
const ZONE_ROWS = 3;

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

// Fisher-Yates shuffle — mutates the array in place, returns it.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function loadTerrain(campaignUrl) {
  const res     = await fetch(campaignUrl);
  const json    = await res.json();
  const hexData = json.hex?.data ?? {};

  // Land set — for O(1) collision lookup each frame
  const landSet = new Set();

  // All water hexes (interior + perimeter)
  const waterHexes = [];

  // Perimeter-only water hexes for hourglass placement.
  // A hex is on the perimeter if it sits on the outermost row or column.
  const perimeterWaterHexes = [];

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const key = `${c},${r}`;
      const val = hexData[key];
      const isLand = val?.c && val.c !== WATER_COLOR;

      if (isLand) {
        landSet.add(key);
      } else {
        const hex = { c, r, ...hexCenter(c, r) };
        waterHexes.push(hex);

        const onPerimeter = c === 0 || c === COLS - 1 || r === 0 || r === ROWS - 1;
        if (onPerimeter) perimeterWaterHexes.push(hex);
      }
    }
  }

  const { mapWidth, mapHeight } = computeMapSize();

  return {
    isLand(wx, wy) {
      const { c, r } = worldToHex(wx, wy);
      return landSet.has(`${c},${r}`);
    },

    // Returns `count` water hex positions using a hybrid strategy:
    //   - The first half  comes from a zone grid (one hex per zone,
    //     cycling through zones) to guarantee map-wide spread.
    //   - The second half is drawn randomly from whatever hexes remain.
    // No hex is returned twice.
    getRandomWaterHexes(count) {
      const structuredCount = Math.floor(count / 2);
      const randomCount     = count - structuredCount;

      // Build a zone lookup: zone index → array of water hexes in that zone.
      // Zone is determined by dividing the hex grid into ZONE_COLS × ZONE_ROWS
      // equal rectangular regions.
      const zoneBuckets = Array.from({ length: ZONE_COLS * ZONE_ROWS }, () => []);
      for (const hex of waterHexes) {
        const zoneC = Math.min(Math.floor(hex.c / COLS  * ZONE_COLS), ZONE_COLS - 1);
        const zoneR = Math.min(Math.floor(hex.r / ROWS  * ZONE_ROWS), ZONE_ROWS - 1);
        zoneBuckets[zoneR * ZONE_COLS + zoneC].push(hex);
      }

      // Shuffle each bucket so we pick a random hex from each zone.
      zoneBuckets.forEach(bucket => shuffle(bucket));

      const chosen   = [];
      const usedKeys = new Set();

      // Cycle through zones, picking one hex per zone until we have
      // the structured half. Skips any zone that has run out of hexes.
      let zoneIndex = 0;
      let safetyLimit = ZONE_COLS * ZONE_ROWS * 10; // avoid infinite loop on tiny maps
      while (chosen.length < structuredCount && safetyLimit-- > 0) {
        const bucket = zoneBuckets[zoneIndex % zoneBuckets.length];
        zoneIndex++;
        const hex = bucket.pop();
        if (!hex) continue;                          // zone had no water hexes
        const key = `${hex.c},${hex.r}`;
        if (usedKeys.has(key)) continue;
        usedKeys.add(key);
        chosen.push(hex);
      }

      // Build a pool of remaining hexes for the random half.
      const pool = shuffle(
        waterHexes.filter(h => !usedKeys.has(`${h.c},${h.r}`))
      );
      for (let i = 0; i < randomCount && i < pool.length; i++) {
        chosen.push(pool[i]);
      }

      return chosen;
    },

    // Returns `count` water hexes drawn only from the map perimeter
    // (outermost rows and columns). Falls back to any water hex if the
    // perimeter doesn't have enough.
    getPerimeterWaterHexes(count) {
      const pool = shuffle([...perimeterWaterHexes]);
      if (pool.length >= count) return pool.slice(0, count);

      // Fallback: pad with interior hexes if perimeter is too sparse.
      const usedKeys = new Set(pool.map(h => `${h.c},${h.r}`));
      const interior = shuffle(
        waterHexes.filter(h => !usedKeys.has(`${h.c},${h.r}`))
      );
      return pool.concat(interior).slice(0, count);
    },

    // Returns a single safe water hex for ship spawning.
    // A hex is considered safe only if all 6 of its neighbors are also water
    // (not in landSet and not missing from hexData). This prevents spawning
    // on boundary hexes or hexes adjacent to land where the ship can't move.
    // Falls back to any interior water hex if no fully-open hex exists.
    getStartHex() {
      // Flat-top hex neighbor offsets (col-parity aware).
      // Even columns and odd columns have different neighbor offsets.
      function neighbors(c, r) {
        const even = (c & 1) === 0;
        return [
          { c: c - 1, r: even ? r - 1 : r },
          { c: c - 1, r: even ? r     : r + 1 },
          { c: c + 1, r: even ? r - 1 : r },
          { c: c + 1, r: even ? r     : r + 1 },
          { c,        r: r - 1 },
          { c,        r: r + 1 },
        ];
      }

      // Filter to hexes that are interior (not perimeter) and have all
      // 6 neighbors classified as water.
      const safe = waterHexes.filter(hex => {
        if (hex.c === 0 || hex.c === COLS - 1 || hex.r === 0 || hex.r === ROWS - 1) return false;
        return neighbors(hex.c, hex.r).every(n => !landSet.has(`${n.c},${n.r}`));
      });

      const pool = safe.length > 0 ? safe : waterHexes;
      return pool[Math.floor(Math.random() * pool.length)];
    },

    mapWidth,
    mapHeight,
  };
}
