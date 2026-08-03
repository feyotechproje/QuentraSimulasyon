// world.js
// Pure geometry: the factory-entrance floor plan, gate layout and the waypoint
// graph. No rendering and no simulation logic lives here — only world-space
// coordinates and helpers so the layout can be reasoned about in one place.
//
// The entrance is rendered as TWO independent banks (baseline on the left
// canvas, Quentra on the right), so everything that depends on the gate COUNT
// lives in createWorld(gateCount) — each bank builds its own world instance.

export const SQUASH = 0.62; // vertical compression for the pseudo-isometric look
export const BANK_GATE_COUNT = 5; // gates per bank (two banks side by side)

// All values are world units (later multiplied by the camera scale).
export const WORLD = {
  gateSpacing: 96,
  firstGateX: 110,

  gateLineY: 170,     // depth of the turnstile body (rotor)
  readerY: 214,       // where a worker stops to present the card
  presentY: 226,      // slightly in front of the reader while waiting
  queueStartY: 268,   // first queue slot in front of a gate
  queueGap: 40,
  maxQueueDraw: 11,   // queue slots that are physically rendered

  corridorY: 92,      // just behind the gates (inside the factory)
  insideY: -60,       // despawn depth inside the plant
  spawnY: 500,        // bottom edge where workers walk in from

  // Gap between the last gate and the security area. Kept tight: each bank has
  // only five gates, so a wide security margin would shrink the gates to fit.
  aisleGap: 112,
};

// Gate X position within a bank's own canvas (index 0..count-1).
export function gateX(index) {
  return WORLD.firstGateX + index * WORLD.gateSpacing;
}

// ---- count-independent waypoint builders -----------------------------------

export function spawnPoint(gx) {
  return { x: gx + (Math.random() * 40 - 20), y: WORLD.spawnY };
}

export function queueSlot(gx, index) {
  const capped = Math.min(index, WORLD.maxQueueDraw);
  return { x: gx, y: WORLD.queueStartY + capped * WORLD.queueGap };
}

export function readerPoint(gx) {
  return { x: gx, y: WORLD.readerY };
}

// Full path from a queue slot up to, through and past a gate (successful entry).
export function entryPath(gx) {
  return [
    { x: gx, y: WORLD.readerY },      // approach reader
    { x: gx, y: WORLD.gateLineY },    // gate centre
    { x: gx, y: WORLD.corridorY },    // just inside
    { x: gx, y: WORLD.insideY },      // walk into the plant + despawn
  ];
}

/**
 * Builds the geometry that depends on how many gates the floor has: the
 * security/manual-review area to the right of the bank, the outside exit and
 * the camera bounds — plus the waypoint builders that route through them.
 */
export function createWorld(gateCount = BANK_GATE_COUNT) {
  const lastGateX = gateX(gateCount - 1);

  // Security desk / manual-review area sits to the right of the gate bank.
  const SECURITY = {
    aisleX: lastGateX + 66,               // vertical aisle rejected workers use
    deskX: lastGateX + WORLD.aisleGap,    // guard desk position
    deskY: 300,
    queueStartY: 360,
    queueGap: 38,
  };

  // Outside exit (bottom-right) for denied workers who simply leave.
  const OUTSIDE_EXIT = { x: lastGateX + WORLD.aisleGap + 40, y: WORLD.spawnY + 40 };

  // World bounding box, used by the camera to fit the whole scene.
  const WORLD_BOUNDS = {
    minX: -30,
    maxX: SECURITY.deskX + 64,
    minY: WORLD.insideY - 20,
    maxY: WORLD.spawnY + 60,
  };

  // Denied worker steps back, moves into the right aisle and leaves outside.
  function rejectPath(gx) {
    return [
      { x: gx, y: WORLD.presentY + 26 },
      { x: SECURITY.aisleX, y: WORLD.presentY + 26 },
      { x: SECURITY.aisleX, y: OUTSIDE_EXIT.y },
      { x: OUTSIDE_EXIT.x, y: OUTSIDE_EXIT.y },
    ];
  }

  // Manual-review worker walks the aisle up to the security desk queue.
  function manualReviewPath(gx, deskIndex) {
    const slotY = SECURITY.queueStartY + deskIndex * SECURITY.queueGap;
    return [
      { x: gx, y: WORLD.presentY + 26 },
      { x: SECURITY.aisleX, y: WORLD.presentY + 26 },
      { x: SECURITY.aisleX, y: slotY },
      { x: SECURITY.deskX - 34, y: slotY },
    ];
  }

  return {
    GATE_COUNT: gateCount,
    LAST_GATE_X: lastGateX,
    SECURITY,
    OUTSIDE_EXIT,
    WORLD_BOUNDS,
    rejectPath,
    manualReviewPath,
  };
}
