// world.js
// Pure geometry for the store floor. All coordinates are in WORLD units.
// The renderer applies the camera (scale + vertical squash) to project them.
// No rendering, no state — just the fixed layout and waypoint math.

export const WORLD = {
  squash: 0.60,            // vertical compression -> ~40deg high-angle feel
  registerCount: 10,

  // Counter layout
  firstRegisterX: 150,
  registerSpacing: 172,
  counterW: 104,
  counterDepth: 46,        // back edge -> front edge
  counterH: 34,            // drawn height of the counter body

  registerBackY: 150,      // depth of the counter's back edge (cashier behind)

  // Derived lanes
  queueGap: 130,           // spacing between queued customers (tight, crowded)
  queueFrontOffset: 150,   // front-of-counter -> first queue slot
  visibleQueueSlots: 24,   // live floor shows the same people counted in normal queues
  queueColumns: 3,         // compact crowd: 24 people occupy only 8 depth rows
  queueColumnGap: 38,
  laneOffset: 74,          // side aisle offset (into the gap on the right)
  corridorOffset: 84,      // exit corridor depth behind the counters

  // Store bounds (computed in build)
};

/**
 * Builds the immutable list of register descriptors + shared landmarks.
 * idOffset shifts the register numbering so a floor can represent one BANK of
 * the store (e.g. the Quentra bank renders registers 06..10 on its own canvas).
 */
export function buildWorld(registerCount = WORLD.registerCount, idOffset = 0) {
  const w = WORLD;
  const n = Math.max(1, registerCount | 0);
  const registers = [];
  for (let i = 0; i < n; i++) {
    const cx = w.firstRegisterX + i * w.registerSpacing;
    const backY = w.registerBackY;
    const frontY = backY + w.counterDepth;
    const paymentY = frontY + 30;
    const queueStartY = frontY + w.queueFrontOffset;
    const laneX = cx + w.counterW / 2 + w.laneOffset * 0.5;
    registers.push({
      id: idOffset + i + 1,
      cx,
      backY,
      frontY,
      paymentY,
      queueStartY,
      queueGap: w.queueGap,
      laneX,
      cashier: { x: cx, y: backY - 14 },
      payment: { x: cx, y: paymentY },
      pos: { x: cx - w.counterW / 2, y: backY }, // top-left of counter body
      w: w.counterW,
      h: w.counterH,
      depth: w.counterDepth,
    });
  }

  const lastX = registers[registers.length - 1].cx;
  const corridorY = w.registerBackY - w.corridorOffset;
  const bounds = {
    minX: w.firstRegisterX - 150,
    maxX: lastX + w.counterW / 2 + 150,
    minY: corridorY - 54,
    // Room for a long queue: the demo starts crowded and grows on the slow path.
    maxY: registers[0].queueStartY + Math.ceil(w.visibleQueueSlots / w.queueColumns) * w.queueGap + 60,
  };

  // Shoppers arrive from the sales floor at the BOTTOM (behind the queues) and
  // leave through the corridor behind the counters at the TOP. Keeping the two
  // flows on separate sides is what makes the queue growth readable: if both
  // used the same corridor, arrivals and departures would cross each other.
  const entranceY = bounds.maxY - 30;
  // The door is OFF-SCREEN to the left of the visible floor: arriving shoppers
  // spawn out of frame and are only drawn once they reach their queue, so the
  // scene shows the queues themselves rather than a stream of walkers.
  const entranceX = bounds.minX - 260;

  return {
    registers,
    corridorY,
    entranceY,
    entrance: { x: entranceX, y: entranceY },
    exit: { x: bounds.maxX - 30, y: corridorY },
    bounds,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    origin: { x: bounds.minX, y: bounds.minY },
  };
}

/** Queue slot world-position for a given register + index (0 = front). */
export function queueSlot(reg, index) {
  const row = Math.floor(index / WORLD.queueColumns);
  const col = index % WORLD.queueColumns;
  const columnOrder = [0, -1, 1];
  return {
    x: reg.cx + columnOrder[col] * WORLD.queueColumnGap,
    y: reg.queueStartY + row * reg.queueGap,
  };
}

/**
 * Waypoints for a newly-arriving customer: walk in from the sales floor at the
 * bottom, across to the chosen register's column, then up to the queue tail.
 * Arrivals never touch the exit corridor, so the two flows stay legible.
 */
export function arrivalWaypoints(world, reg, slotIndex) {
  const slot = queueSlot(reg, slotIndex);
  return [
    { x: world.entrance.x, y: world.entranceY },
    { x: slot.x, y: world.entranceY },
    { x: slot.x, y: slot.y },
  ];
}

/**
 * Waypoints from the front queue slot to the payment position — routed through
 * the side aisle so the customer never crosses the counter body.
 *   queue -> sideAisleEntry -> checkoutFront -> paymentPosition
 */
export function approachWaypoints(reg) {
  return [
    { x: reg.laneX, y: reg.queueStartY },   // sideAisleEntry
    { x: reg.laneX, y: reg.paymentY },      // checkoutFront
    { x: reg.payment.x, y: reg.payment.y }, // paymentPosition
  ];
}

/**
 * Waypoints leaving the checkout: back out to the side aisle, up to the exit
 * corridor, along it and out through the exit door.
 *   paymentPosition -> sideAisleReturn -> exitCorridor -> exitDoor
 */
export function departWaypoints(world, reg) {
  // exit-side aisle on the LEFT of the counter so departing shoppers pass
  // through/past the register and never backtrack into the incoming queue.
  const exitLaneX = reg.cx - WORLD.counterW / 2 - WORLD.laneOffset * 0.5;
  return [
    { x: reg.cx, y: reg.paymentY + 18 },      // step forward past the register
    { x: exitLaneX, y: reg.paymentY + 18 },   // slide to the exit-side aisle
    { x: exitLaneX, y: world.corridorY },     // up to the exit corridor
    { x: world.exit.x, y: world.corridorY },  // along to the exit door
    { x: world.exit.x + 120, y: world.corridorY }, // off-screen
  ];
}
