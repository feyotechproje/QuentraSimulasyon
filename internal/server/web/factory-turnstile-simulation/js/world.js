// world.js
// Pure geometry: the factory-entrance floor plan, gate layout and the waypoint
// graph. No rendering and no simulation logic lives here — only world-space
// coordinates and helpers so the layout can be reasoned about in one place.

export const SQUASH = 0.62; // vertical compression for the pseudo-isometric look
export const GATE_COUNT = 15;

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

  aisleGap: 150,      // gap between the last gate and the security area
};

// Derived gate X positions (index 0..14).
export function gateX(index) {
  return WORLD.firstGateX + index * WORLD.gateSpacing;
}

export const LAST_GATE_X = gateX(GATE_COUNT - 1);

// Security desk / manual-review area sits to the right of the gate bank.
export const SECURITY = {
  aisleX: LAST_GATE_X + 66,               // vertical aisle rejected workers use
  deskX: LAST_GATE_X + WORLD.aisleGap,    // guard desk position
  deskY: 300,
  queueStartY: 360,
  queueGap: 38,
};

// Outside exit (bottom-right) for denied workers who simply leave.
export const OUTSIDE_EXIT = { x: LAST_GATE_X + WORLD.aisleGap + 40, y: WORLD.spawnY + 40 };

// World bounding box, used by the camera to fit the whole scene.
export const WORLD_BOUNDS = {
  minX: -30,
  maxX: SECURITY.deskX + 120,
  minY: WORLD.insideY - 20,
  maxY: WORLD.spawnY + 60,
};

// ---- waypoint builders -----------------------------------------------------

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

// Denied worker steps back, moves into the right aisle and leaves outside.
export function rejectPath(gx) {
  return [
    { x: gx, y: WORLD.presentY + 26 },
    { x: SECURITY.aisleX, y: WORLD.presentY + 26 },
    { x: SECURITY.aisleX, y: OUTSIDE_EXIT.y },
    { x: OUTSIDE_EXIT.x, y: OUTSIDE_EXIT.y },
  ];
}

// Manual-review worker walks the aisle up to the security desk queue.
export function manualReviewPath(gx, deskIndex) {
  const slotY = SECURITY.queueStartY + deskIndex * SECURITY.queueGap;
  return [
    { x: gx, y: WORLD.presentY + 26 },
    { x: SECURITY.aisleX, y: WORLD.presentY + 26 },
    { x: SECURITY.aisleX, y: slotY },
    { x: SECURITY.deskX - 34, y: slotY },
  ];
}
