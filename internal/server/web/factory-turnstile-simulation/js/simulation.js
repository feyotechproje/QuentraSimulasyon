// simulation.js
// The in-memory factory-access simulation. Owns the gates + workers, runs the
// access-control state machine, spawns arrivals and derives all KPIs. It knows
// nothing about the DOM or the canvas — the renderer and UI only read from it.

import {
  WORLD, BANK_GATE_COUNT, createWorld, spawnPoint, queueSlot, readerPoint, entryPath,
} from "./world.js";
import { Worker, WORKER_STATE } from "./worker.js";
import { buildTurnstiles, GATE_STATE, LIGHT } from "./turnstile.js";
import { joinQueue, popFront, pickBestGate } from "./queue.js";
import { InMemoryFactoryAccessDataSource, SimulationProfile } from "./access-check.js";
import { EventLog } from "./events.js";

const OPEN_TIME = 0.45;
const CLOSE_TIME = 0.5;
const PRESENT_TIME = 0.65;
const RESULT_HOLD = 1.1;
const SHIFT_START = 8 * 3600; // 08:00:00
const SPAWN_EVERY = 0.5;
const SOFT_CAP = 120; // per bank — the store runs two banks side by side
const MANUAL_LINGER = 7;

// Maps the fixed English "reason" strings produced by access-check.js's
// rollOutcome() to i18n dictionary keys, so the event feed can be re-rendered
// in the active language on toggle without re-simulating anything.
const REASON_KEY = {
  "Last movement EXIT": "reason.lastExit",
  "Previous movement already ENTRY": "reason.alreadyEntry",
  "No previous movement found": "reason.noMovement",
  "Movement query timeout": "reason.timeout",
  "Invalid card": "reason.invalidCard",
};
function reasonKey(reason) {
  return REASON_KEY[reason] || null;
}

export class Simulation {
  /**
   * @param {object} [opts] one BANK of the dual entrance:
   *        gateCount — turnstiles on this floor;
   *        idOffset  — first gate number minus one (right bank: 5);
   *        mode      — "baseline" | "quentra": fixes this floor's query profile
   *                    so the slow and fast banks run side by side.
   */
  constructor(opts = {}) {
    this.gateCount = opts.gateCount || BANK_GATE_COUNT;
    this.idOffset = opts.idOffset || 0;
    this.fixedMode = opts.mode === "quentra" ? "quentra" : "baseline";
    this.world = createWorld(this.gateCount);
    this.dataSource = new InMemoryFactoryAccessDataSource();
    this.events = new EventLog(60);
    this.reset();
  }

  reset() {
    this.clock = 0;
    this.speed = 1;
    // Boots idle: the seeded queues stand as a static preview until the
    // operator picks the shift size on the start overlay (retail-style).
    this.running = false;
    this.status = "IDLE";
    // Total workers this bank will admit for the shift; 0 = not started yet.
    this.totalWorkers = 0;
    this.mode = this.fixedMode;
    this.dataSource.profile = this.fixedMode === "quentra"
      ? SimulationProfile.QuentraOptimized
      : SimulationProfile.SlowBaseline;
    this.compare = {
      baseline: { sum: 0, n: 0, slow: 0, timeouts: 0, entries: 0 },
      quentra: { sum: 0, n: 0, slow: 0, timeouts: 0, entries: 0 },
    };
    this.gates = buildTurnstiles(this.gateCount, this.idOffset);
    this.workers = [];
    this.spawnTimer = 0;
    this.totalArrived = 0;
    this.successfulEntries = 0;
    this.accessDenied = 0;
    this.manualReview = 0;
    this.sumCheckTime = 0;
    this.checkSamples = 0;
    this.slowChecks = 0;
    this.queryTimeouts = 0;
    this.waitAccum = 0;
    this.waitSamples = 0;
    this.longestQueue = 0;
    this.entryTimes = [];
    this.selectedGate = null;
    this.selectedWorker = null;
    this.events.clear();
    this.kpi = {};
    this._seedQueues();
    this._recomputeKPIs();
  }

  clockString() {
    const t = Math.max(0, Math.floor(SHIFT_START + this.clock));
    const h = Math.floor(t / 3600) % 24;
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const p = (n) => String(n).padStart(2, "0");
    return `${p(h)}:${p(m)}:${p(s)}`;
  }

  _seedQueues() {
    for (const gate of this.gates) {
      const n = 3 + ((Math.random() * 10) | 0); // 3..12 already waiting
      for (let i = 0; i < n; i++) {
        const w = new Worker();
        const slot = queueSlot(gate.x, i);
        w.pos = { x: slot.x, y: slot.y };
        w.state = WORKER_STATE.WAITING_IN_QUEUE;
        w.turnstileId = gate.id;
        w.queueIndex = i;
        w.joinedAt = -Math.random() * 8;
        w.arrived = true;
        w.facing = "up";
        gate.queue.push(w);
        this.workers.push(w);
        this.totalArrived++;
      }
    }
  }

  // ---- main tick ----------------------------------------------------------
  update(dt) {
    if (!this.running) return;
    this.clock += dt;

    this._spawn(dt);
    for (const w of this.workers) {
      w.step(dt);
      w.idleTimer += dt;
      if (w.state === WORKER_STATE.WALKING_TO_QUEUE && w.arrived) {
        w.state = WORKER_STATE.WAITING_IN_QUEUE;
      }
    }
    for (const gate of this.gates) this._processGate(gate, dt);
    this._cleanup();
    this._recomputeKPIs();

    // Shift complete: every admitted worker has been resolved and left the
    // floor. The overlay reappears so the operator can size the next shift.
    if (this.totalWorkers > 0 && this.totalArrived >= this.totalWorkers && this.workers.length === 0) {
      this.running = false;
      this.status = "COMPLETED";
    }
  }

  _spawn(dt) {
    if (this.workers.length >= SOFT_CAP) return;
    // Stop admitting once the shift's worker budget has walked in.
    if (this.totalWorkers > 0 && this.totalArrived >= this.totalWorkers) return;
    this.spawnTimer -= dt;
    while (this.spawnTimer <= 0) {
      this.spawnTimer += SPAWN_EVERY * (0.6 + Math.random() * 0.9);
      const gate = pickBestGate(this.gates);
      const w = new Worker();
      const sp = spawnPoint(gate.x);
      w.pos = { x: sp.x, y: sp.y };
      w.state = WORKER_STATE.WALKING_TO_QUEUE;
      w.joinedAt = this.clock;
      joinQueue(gate, w);
      this.workers.push(w);
      this.totalArrived++;
      if (gate.queueLength >= 11) {
        this.events.push(
          this.clockString(),
          `Turnstile ${gate.label} queue reached ${gate.queueLength} workers`,
          "warn",
          "feed.queueReached",
          { gate: gate.label, n: gate.queueLength },
        );
      }
    }
  }

  _processGate(gate, dt) {
    gate.blinkPhase += dt * 6;

    if (gate.state === GATE_STATE.IDLE) {
      const front = gate.queue[0];
      if (!gate.currentWorker && front && front.arrived && !front.moving) {
        const w = popFront(gate);
        gate.currentWorker = w;
        w.state = WORKER_STATE.APPROACHING_READER;
        w.setPath([readerPoint(gate.x)]);
        // queue-wait metric
        this.waitAccum += Math.max(0, this.clock - (w.joinedAt || this.clock));
        this.waitSamples++;
        gate.state = GATE_STATE.READING;
        gate.light = LIGHT.OFF;
        gate.message = { name: w.displayName, sub: `${w.employeeId} · ${w.department}`, line: "APPROACHING" };
      }
      return;
    }

    const w = gate.currentWorker;
    if (!w && gate.state !== GATE_STATE.DENIED && gate.state !== GATE_STATE.MANUAL) {
      gate.state = GATE_STATE.IDLE;
      return;
    }

    switch (gate.state) {
      case GATE_STATE.READING: {
        if (w.state === WORKER_STATE.APPROACHING_READER && w.arrived) {
          w.state = WORKER_STATE.PRESENTING_CARD;
          w.stateTimer = PRESENT_TIME;
          gate.light = LIGHT.BLUE; // reader pulse while the card is read
          gate.message.line = "PRESENT CARD";
        } else if (w.state === WORKER_STATE.PRESENTING_CARD) {
          w.stateTimer -= dt;
          if (w.stateTimer <= 0) {
            w.state = WORKER_STATE.CHECKING_LAST_MOVEMENT;
            w.check = this.dataSource.requestCheck(w);
            w.check.mode = this.mode;
            w.checkElapsed = 0;
            w._slowLogged = false;
            gate.checkTimer = 0;
            gate.state = GATE_STATE.CHECKING;
            gate.light = LIGHT.YELLOW;
            gate.message.line = "CHECKING LAST MOVEMENT";
            this.events.push(
              this.clockString(),
              `${w.employeeId} presented card at ${gate.label}`,
              "info",
              "feed.presentedCard",
              { emp: w.employeeId, gate: gate.label },
            );
            this.events.push(
              this.clockString(),
              `Checking last movement · ${gate.label}`,
              "info",
              "feed.checkingMovement",
              { gate: gate.label },
            );
          }
        }
        break;
      }
      case GATE_STATE.CHECKING: {
        w.checkElapsed += dt;
        gate.checkTimer += dt;
        gate.light = LIGHT.YELLOW;
        gate.message.line = `QUERY ${w.checkElapsed.toFixed(1)}s`;
        if (!w._slowLogged && w.check.slow && w.checkElapsed >= this.dataSource.profile.slowThreshold) {
          w._slowLogged = true;
          this.events.push(
            this.clockString(),
            `Slow query detected: ${w.check.duration.toFixed(1)} sec · ${gate.label}`,
            "warn",
            "feed.slowQuery",
            { sec: w.check.duration.toFixed(1), gate: gate.label },
          );
        }
        if (w.checkElapsed >= w.check.duration) this._resolve(gate, w);
        break;
      }
      case GATE_STATE.OPENING: {
        gate.gateAngle += dt / OPEN_TIME;
        if (gate.gateAngle >= 1) {
          gate.gateAngle = 1;
          gate.state = GATE_STATE.PASSING;
          w.state = WORKER_STATE.PASSING_GATE;
          w.setPath(entryPath(gate.x));
        }
        break;
      }
      case GATE_STATE.PASSING: {
        if (w.pos.y <= WORLD.corridorY) {
          gate.state = GATE_STATE.CLOSING;
          w.state = WORKER_STATE.WALKING_INSIDE;
          gate.currentWorker = null;
          this.events.push(
            this.clockString(),
            `Worker passed through ${gate.label}`,
            "ok",
            "feed.passedThrough",
            { gate: gate.label },
          );
        }
        break;
      }
      case GATE_STATE.CLOSING: {
        gate.gateAngle -= dt / CLOSE_TIME;
        if (gate.gateAngle <= 0) {
          gate.gateAngle = 0;
          gate.state = GATE_STATE.IDLE;
          gate.light = LIGHT.OFF;
          gate.message = { name: "", sub: "", line: "" };
        }
        break;
      }
      case GATE_STATE.DENIED:
      case GATE_STATE.MANUAL: {
        gate.holdTimer -= dt;
        if (gate.holdTimer <= 0) {
          gate.state = GATE_STATE.IDLE;
          gate.light = LIGHT.OFF;
          gate.currentWorker = null;
          gate.message = { name: "", sub: "", line: "" };
        }
        break;
      }
      default:
        break;
    }
  }

  _resolve(gate, w) {
    const c = w.check;
    gate.recordCheck(c.duration, c.decision, c.timeout);
    this.sumCheckTime += c.duration;
    this.checkSamples++;
    if (c.slow) this.slowChecks++;
    if (c.timeout) this.queryTimeouts++;
    const cs = this.compare[c.mode] || this.compare[this.mode];
    cs.sum += c.duration;
    cs.n++;
    if (c.slow) cs.slow++;
    if (c.timeout) cs.timeouts++;
    if (c.decision === "ENTRY_APPROVED") cs.entries++;
    gate.message.name = w.displayName;
    gate.message.sub = `Last movement: ${c.lastMovement}`;

    if (c.decision === "ENTRY_APPROVED") {
      w.state = WORKER_STATE.ENTRY_APPROVED;
      gate.state = GATE_STATE.OPENING;
      gate.light = LIGHT.GREEN;
      gate.message.line = "ENTRY APPROVED";
      this.successfulEntries++;
      this.entryTimes.push(this.clock);
      this.events.push(
        this.clockString(),
        `Entry approved at ${gate.label} · last movement EXIT`,
        "ok",
        "feed.entryApproved",
        { gate: gate.label },
      );
    } else if (c.decision === "ACCESS_DENIED") {
      w.state = WORKER_STATE.ACCESS_DENIED;
      gate.state = GATE_STATE.DENIED;
      gate.holdTimer = RESULT_HOLD;
      gate.light = LIGHT.RED;
      gate.message.line = "ACCESS DENIED";
      this.accessDenied++;
      w.setPath(this.world.rejectPath(gate.x));
      w.state = WORKER_STATE.WALKING_OUT;
      this.events.push(
        this.clockString(),
        `Access denied at ${gate.label} · ${c.reason}`,
        "bad",
        "feed.accessDenied",
        { gate: gate.label, reason: c.reason, reasonKey: reasonKey(c.reason) },
      );
    } else {
      w.state = WORKER_STATE.MANUAL_REVIEW;
      gate.state = GATE_STATE.MANUAL;
      gate.holdTimer = RESULT_HOLD;
      gate.light = LIGHT.BLUE;
      gate.message.line = "MANUAL REVIEW";
      this.manualReview++;
      const deskIndex = this._manualQueueCount();
      w.setPath(this.world.manualReviewPath(gate.x, deskIndex));
      w.manualLinger = MANUAL_LINGER;
      this.events.push(
        this.clockString(),
        `Manual review requested · ${gate.label} · ${c.reason}`,
        "manual",
        "feed.manualReview",
        { gate: gate.label, reason: c.reason, reasonKey: reasonKey(c.reason) },
      );
    }
  }

  _manualQueueCount() {
    let n = 0;
    for (const w of this.workers) if (w.state === WORKER_STATE.MANUAL_REVIEW && w.arrived) n++;
    return n;
  }

  _cleanup() {
    const keep = [];
    for (const w of this.workers) {
      if (w.state === WORKER_STATE.WALKING_INSIDE && w.arrived) continue; // reached the plant
      if (w.state === WORKER_STATE.WALKING_OUT && w.arrived) continue;    // left outside
      if (w.state === WORKER_STATE.MANUAL_REVIEW && w.arrived) {
        w.manualLinger -= 1 / 60;
        if (w.manualLinger <= 0) continue;
      }
      keep.push(w);
    }
    this.workers = keep;
    if (this.selectedWorker && !this.workers.includes(this.selectedWorker)) this.selectedWorker = null;
  }

  _recomputeKPIs() {
    let waiting = 0;
    let processing = 0;
    let pending = 0;
    let busy = 0;
    let longest = 0;
    for (const g of this.gates) {
      waiting += g.queue.length;
      if (g.currentWorker) busy++;
      if (g.state === GATE_STATE.READING || g.state === GATE_STATE.CHECKING) processing++;
      if (g.state === GATE_STATE.CHECKING) pending++;
      if (g.queueLength > longest) longest = g.queueLength;
    }
    if (longest > this.longestQueue) this.longestQueue = longest;

    // entries in the last 60 sim-seconds
    const cutoff = this.clock - 60;
    while (this.entryTimes.length && this.entryTimes[0] < cutoff) this.entryTimes.shift();
    const perMin = this.clock < 60
      ? (this.clock > 0 ? (this.successfulEntries / this.clock) * 60 : 0)
      : this.entryTimes.length;

    this.kpi = {
      totalWorkers: this.totalArrived,
      waiting,
      processing,
      successfulEntries: this.successfulEntries,
      accessDenied: this.accessDenied,
      manualReview: this.manualReview,
      avgCheck: this.checkSamples ? this.sumCheckTime / this.checkSamples : 0,
      avgQueue: this.waitSamples ? this.waitAccum / this.waitSamples : 0,
      longestQueue: longest,
      entriesPerMin: perMin,
      utilization: busy / this.gates.length,
      pendingChecks: pending,
      slowChecks: this.slowChecks,
      queryTimeouts: this.queryTimeouts,
      currentLongest: longest,
    };
  }

  // The worker whose check is currently taking the longest — feeds the
  // "Current Worker Check" panel and the query-pipeline widget.
  activeCheck() {
    let best = null;
    for (const g of this.gates) {
      if (g.state === GATE_STATE.CHECKING && g.currentWorker) {
        if (!best || g.currentWorker.checkElapsed > best.worker.checkElapsed) {
          best = { gate: g, worker: g.currentWorker };
        }
      }
    }
    if (this.selectedWorker) {
      const g = this.gates.find((x) => x.currentWorker === this.selectedWorker);
      if (g) return { gate: g, worker: this.selectedWorker };
    }
    return best;
  }

  // Gates ranked by current bottleneck severity (active slow check + queue).
  bottlenecks(limit = 3) {
    return [...this.gates]
      .map((g) => ({
        gate: g,
        score: (g.currentWorker && g.state === GATE_STATE.CHECKING ? g.checkTimer * 3 : 0) + g.queueLength,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ---- controls -----------------------------------------------------------
  pause() { if (this.running) { this.running = false; this.status = "PAUSED"; } }
  resume() { if (this.status === "PAUSED") { this.running = true; this.status = "RUNNING"; } }
  stop() { this.running = false; this.status = "STOPPED"; }
  setSpeed(mult) { this.speed = mult; }

  /** Start a fresh shift admitting `total` workers on this bank. */
  startShift(total) {
    this.reset();
    this.totalWorkers = Math.max(1, total | 0);
    this.running = true;
    this.status = "RUNNING";
  }

  compareStats() {
    const b = this.compare.baseline, q = this.compare.quentra;
    const bAvg = b.n ? b.sum / b.n : 0;
    const qAvg = q.n ? q.sum / q.n : 0;
    return { b, q, bAvg, qAvg, mode: this.mode };
  }
}
