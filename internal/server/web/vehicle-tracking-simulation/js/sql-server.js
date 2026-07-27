// sql-server.js
// In-memory model of the SQL Server node: CPU/memory, compilation + plan-cache
// behaviour, and the visible plan cards. Values ease toward baseline or Quentra
// targets so mode switches animate smoothly.

import { PlanCard } from "./query.js";

export class SqlServer {
  constructor() {
    this.cpu = 40;
    this.memory = 58;
    this.batchRequestsPerSecond = 20000;
    this.compilationsPerSecond = 200;
    this.recompilationsPerSecond = 40;
    this.activeUpdates = 0;
    this.queuedUpdates = 0;
    this.averageDuration = 120;
    this.planCacheUsage = 20;
    this.singleUsePlans = 20;
    this.reusablePlans = 4;
    this.totalExecutions = 0;
    this.totalCompilations = 0;
    this.compilationsAvoided = 0;
    this.state = "STABLE";
    this.planCards = [];        // visible plan cache cards
    this._planSeed = 0;
    this._reusePlan = new PlanCard("sp_UpdateVehicleState", false, 0);
  }

  // arrivals = how many GPS updates hit SQL this frame.
  update(dt, mode, arrivals) {
    const q = mode === "quentra";

    // --- targets ------------------------------------------------------------
    const tgt = q
      ? { cpu: 36, comp: 110, recomp: 35, dur: 80, single: 12, usage: 34, queue: 12 }
      : { cpu: 94, comp: 22000, recomp: 18000, dur: 420, single: 185000, usage: 97, queue: 1240 };

    const ease = (cur, to, k) => cur + (to - cur) * Math.min(1, k * dt);
    this.cpu = ease(this.cpu, tgt.cpu + Math.sin(performance.now() / 700) * 1.5, 0.8);
    this.compilationsPerSecond = Math.round(ease(this.compilationsPerSecond, tgt.comp, 0.7));
    this.recompilationsPerSecond = Math.round(ease(this.recompilationsPerSecond, tgt.recomp, 0.7));
    this.averageDuration = Math.round(ease(this.averageDuration, tgt.dur, 0.7));
    this.singleUsePlans = Math.round(ease(this.singleUsePlans, tgt.single, q ? 1.4 : 0.5));
    this.planCacheUsage = ease(this.planCacheUsage, tgt.usage, 0.6);
    this.queuedUpdates = Math.round(ease(this.queuedUpdates, tgt.queue, 0.6));
    this.memory = ease(this.memory, q ? 55 : 82, 0.5);
    this.activeUpdates = Math.round(ease(this.activeUpdates, q ? 6 : 42, 0.7));
    this.state = q ? "OPTIMIZED" : this.cpu > 85 ? "OVERLOADED" : "STRESSED";

    // --- counters -----------------------------------------------------------
    this.totalExecutions += arrivals;
    if (q) {
      this.reusablePlans = 3;
      this._reusePlan.useCount += arrivals;
      this.compilationsAvoided += arrivals;
    } else {
      this.totalCompilations += arrivals;
    }

    // --- plan cache cards ---------------------------------------------------
    this._syncPlanCards(mode, arrivals);
  }

  _syncPlanCards(mode, arrivals) {
    if (mode === "quentra") {
      // Collapse to one reusable plan whose use-count rockets.
      if (this.planCards.length !== 1 || this.planCards[0].hash !== "sp_UpdateVehicleState") {
        this.planCards = [this._reusePlan];
      }
      this.planCards[0].single = false;
      this.planCards[0].useCount = this._reusePlan.useCount;
      return;
    }
    // Baseline: keep spawning single-use plan cards, cap the visible count.
    for (let i = 0; i < arrivals; i++) {
      if (Math.random() < 0.7) {
        const hash = "PLAN-" + (this._planSeed++ % 9000 + 1000).toString(16).toUpperCase();
        this.planCards.push(new PlanCard(hash, true, 1));
      }
    }
    if (this.planCards.length > 40) this.planCards.splice(0, this.planCards.length - 40);
  }

  reusePlanUseCount() { return this._reusePlan.useCount; }
}
