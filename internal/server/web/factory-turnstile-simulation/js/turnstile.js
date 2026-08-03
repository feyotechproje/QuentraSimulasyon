// turnstile.js
// A single turnstile lane: its queue, the worker currently at the reader, the
// gate mechanism angle, status light and rolling metrics.

import { gateX } from "./world.js";

export const GATE_STATE = {
  IDLE: "IDLE",
  READING: "READING",
  CHECKING: "CHECKING",
  APPROVED: "APPROVED",
  DENIED: "DENIED",
  MANUAL: "MANUAL",
  OPENING: "OPENING",
  PASSING: "PASSING",
  CLOSING: "CLOSING",
};

export const LIGHT = { OFF: "off", RED: "red", YELLOW: "yellow", GREEN: "green", BLUE: "blue" };

export class Turnstile {
  /** idOffset shifts numbering so the right bank renders T06.. on its canvas. */
  constructor(index, idOffset = 0) {
    this.id = idOffset + index + 1;
    this.index = index;
    this.label = "T" + String(this.id).padStart(2, "0");
    this.x = gateX(index);

    this.queue = [];            // workers waiting (ordered front -> back)
    this.currentWorker = null;  // worker at the reader / passing through

    this.state = GATE_STATE.IDLE;
    this.light = LIGHT.OFF;
    this.gateAngle = 0;         // 0 = closed, ~1 = fully open
    this.blinkPhase = Math.random() * Math.PI * 2;

    this.checkTimer = 0;        // live duration of the active check
    this.message = { name: "", sub: "", line: "" }; // top-screen text

    // metrics
    this.totalProcessed = 0;
    this.deniedCount = 0;
    this.timeoutCount = 0;
    this.manualCount = 0;
    this.sumCheck = 0;
    this.checkCount = 0;
    this.selected = false;
  }

  get queueLength() { return this.queue.length + (this.currentWorker ? 1 : 0); }

  get avgCheck() { return this.checkCount ? this.sumCheck / this.checkCount : 0; }

  // Rough "estimated wait" a worker uses when choosing a lane: queue size
  // weighted by this lane's observed average check time (slow lanes look worse).
  get estimatedWait() {
    const perWorker = this.checkCount ? Math.max(1.2, this.avgCheck) : 3.5;
    return this.queueLength * perWorker;
  }

  recordCheck(seconds, decision, timedOut) {
    this.sumCheck += seconds;
    this.checkCount += 1;
    this.totalProcessed += 1;
    if (decision === "ACCESS_DENIED") this.deniedCount += 1;
    if (decision === "MANUAL_REVIEW") this.manualCount += 1;
    if (timedOut) this.timeoutCount += 1;
  }
}

export function buildTurnstiles(count, idOffset = 0) {
  const gates = [];
  for (let i = 0; i < count; i++) gates.push(new Turnstile(i, idOffset));
  return gates;
}
