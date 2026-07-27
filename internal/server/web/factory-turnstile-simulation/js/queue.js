// queue.js
// Queue placement helpers. Keeps the "who stands where" maths out of the
// simulation loop so movement stays smooth and predictable.

import { queueSlot } from "./world.js";

// Send a worker to the tail of a gate's queue (walking, not teleporting).
export function joinQueue(gate, worker) {
  worker.turnstileId = gate.id;
  worker.queueIndex = gate.queue.length;
  gate.queue.push(worker);
  const slot = queueSlot(gate.x, worker.queueIndex);
  worker.setPath([{ x: slot.x, y: slot.y }]);
}

// Re-index the queue after the front worker leaves and walk everyone forward
// one slot with a smooth path (no snapping).
export function advanceQueue(gate) {
  for (let i = 0; i < gate.queue.length; i++) {
    const w = gate.queue[i];
    if (w.queueIndex === i) continue;
    w.queueIndex = i;
    const slot = queueSlot(gate.x, i);
    w.setPath([{ x: slot.x, y: slot.y }]);
  }
}

// Remove the front worker (the one about to be served) and shuffle the rest.
export function popFront(gate) {
  const front = gate.queue.shift() || null;
  advanceQueue(gate);
  return front;
}

// Pick the gate with the lowest estimated wait; light random jitter avoids all
// workers piling onto the exact same lane on the same frame.
export function pickBestGate(gates) {
  let best = null;
  let bestScore = Infinity;
  for (const g of gates) {
    const score = g.estimatedWait + Math.random() * 2.5;
    if (score < bestScore) { bestScore = score; best = g; }
  }
  return best;
}
