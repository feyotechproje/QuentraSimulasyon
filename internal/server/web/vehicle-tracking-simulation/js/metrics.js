// metrics.js
// Aggregates the demo KPIs from the SQL server, gateway and the live vehicle
// population. Produces one plain snapshot object per throttled tick for the UI,
// plus per-region load figures. Nothing here touches the DOM.

import { ZONES } from "./world.js";

export class Metrics {
  constructor() {
    this.connectedVehicles = 200000;
    this.gpsUpdatesPerSec = 20000;
    this.updatesProcessed = 0;
    this.gpsDelay = 4.8;
    this.plansReused = "Low";
    this.regions = {};
    for (const z of ZONES) {
      if (z.id === "highway") continue;
      this.regions[z.id] = { name: z.name, vehicles: 0, updates: 0, avgSpeed: 0, delay: 0, load: 0 };
    }
  }

  update(dt, sim) {
    const q = sim.mode === "quentra";
    // Slight jitter around 20k updates/sec.
    this.gpsUpdatesPerSec = 20000 + Math.round(Math.sin(performance.now() / 500) * 260);
    this.updatesProcessed += Math.round(this.gpsUpdatesPerSec * dt);
    this.plansReused = q ? "Very High" : "Low";

    // Aggregate vehicle-derived figures.
    let delaySum = 0;
    const racc = {};
    for (const id in this.regions) racc[id] = { v: 0, s: 0, d: 0 };
    for (const v of sim.vehicles) {
      delaySum += v.gpsDelay;
      const z = v.zone;
      if (z && racc[z]) { racc[z].v++; racc[z].s += v.speedKmh; racc[z].d += v.gpsDelay; }
    }
    const n = sim.vehicles.length || 1;
    this.gpsDelay = delaySum / n;

    for (const id in this.regions) {
      const r = this.regions[id], a = racc[id];
      r.vehicles = a.v;
      r.avgSpeed = a.v ? Math.round(a.s / a.v) : 0;
      r.delay = a.v ? +(a.d / a.v).toFixed(1) : 0;
      // Scale visible vehicles up to the 200k fleet proportion.
      r.updates = Math.round((a.v / n) * this.gpsUpdatesPerSec);
      r.load = Math.min(100, Math.round((a.v / n) * 100 * 3.2));
    }
  }

  // Build the KPI object the UI renders.
  snapshot(sim) {
    const sql = sim.sql, gw = sim.gateway;
    const q = sim.mode === "quentra";
    const snap = {
      connectedVehicles: this.connectedVehicles,
      visibleVehicles: sim.vehicles.length,
      gpsUpdatesPerSec: this.gpsUpdatesPerSec,
      batchRequestsPerSec: this.gpsUpdatesPerSec,
      compilationsPerSec: sql.compilationsPerSecond,
      recompilationsPerSec: sql.recompilationsPerSecond,
      sqlCpu: Math.round(sql.cpu),
      planCacheUsage: Math.round(sql.planCacheUsage),
      singleUsePlans: sql.singleUsePlans,
      averageUpdateTime: sql.averageDuration,
      gpsPositionDelay: +this.gpsDelay.toFixed(1),
      updatesProcessed: this.updatesProcessed,
      plansReused: this.plansReused,
      compilationsAvoided: q ? "99%+" : "0%",
      memory: Math.round(sql.memory),
      activeUpdates: sql.activeUpdates,
      queuedUpdates: sql.queuedUpdates,
      // Simulated fallback; replaced with the measured value in live mode.
      compileWaiters: sql.queuedUpdates,
      reusePlanUseCount: sql.reusePlanUseCount(),
      mode: sim.mode,
      live: false,
    };

    // Overlay REAL measurements from the SQL Server workload when connected.
    const b = sim.backend;
    if (b && b.provisioned) {
      snap.live = true;
      snap.connectedVehicles = b.vehicleCount;
      snap.gpsUpdatesPerSec = Math.round(b.updatesPerSec);
      snap.batchRequestsPerSec = Math.round(b.batchReqPerSec || b.updatesPerSec);
      snap.compilationsPerSec = Math.round(b.compilationsPerSec);
      snap.recompilationsPerSec = Math.round(b.recompilesPerSec || 0);
      snap.singleUsePlans = b.singleUsePlans;
      snap.averageUpdateTime = +b.avgLatencyMs.toFixed(1);
      snap.updatesProcessed = b.updatesTotal;
      snap.planCacheMB = Math.round(b.planCacheMB);
      snap.totalPlans = b.totalPlans;
      // Use the measured CPU even when it reads 0: an idle server genuinely is
      // at 0%, and falling back to the simulated curve there would show motion
      // that is not happening.
      if (b.sqlCpuPct != null) snap.sqlCpu = b.sqlCpuPct;
      // Real server state. Zero from the backend means "not readable", so keep
      // the simulated value rather than showing a misleading 0.
      if (b.sqlMemoryPct > 0) snap.memory = b.sqlMemoryPct;
      if (b.activeRequests != null) snap.activeUpdates = b.activeRequests;
      if (b.queuedRequests != null) snap.queuedUpdates = b.queuedRequests;
      // Real compilation backlog: sessions waiting on the compile gateway.
      // Previously this bar showed a locally invented number even in live mode.
      if (b.compileWaiters != null) snap.compileWaiters = b.compileWaiters;
      // Plan-cache pressure measured against the server's own plan count.
      if (b.totalPlans > 0) {
        snap.planCacheUsage = Math.min(100, Math.round((b.singleUsePlans / b.totalPlans) * 100));
      }
      if (q) snap.reusePlanUseCount = b.updatesTotal;
      snap.compilationsAvoided = q ? "99%+" : "0%";
    }
    return snap;
  }
}
