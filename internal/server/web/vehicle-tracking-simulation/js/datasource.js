// datasource.js
// Abstraction that feeds the simulation. The renderer/UI never know whether data
// comes from memory or a backend. This first phase ships only the in-memory
// implementation. An ApiVehicleTrackingDataSource could be added later without
// touching the renderer — intentionally NOT implemented in this phase.

const tr = (key, fallback, vars) => {
  let s = window.QuentraI18n ? window.QuentraI18n.t(key, fallback) : fallback;
  if (vars) for (const k in vars) s = s.replace(`{${k}}`, vars[k]);
  return s;
};

export class SimulationDataSource {
  getConfig() { throw new Error("not implemented"); }
  nextEvent() { return null; }
}

export class InMemoryVehicleTrackingDataSource extends SimulationDataSource {
  getConfig() {
    return {
      connectedVehicles: 200000,
      gpsUpdatesPerSec: 20000,
      visibleTarget: 420,
    };
  }

  // Produce a plausible live-feed line for the current mode + a random vehicle.
  nextEvent(mode, sim) {
    const time = sim.clockLabel();
    const v = sim.vehicles.length
      ? sim.vehicles[(Math.random() * sim.vehicles.length) | 0]
      : { vid: "VEH-154283" };
    const base = [
      tr("feed.gpsSent", "{time} — {vid} sent GPS update", { time, vid: v.vid }),
    ];
    if (mode === "quentra") {
      const q = [
        tr("feed.fpMatched", "{time} — Query fingerprint matched", { time }),
        tr("feed.paramsExtracted", "{time} — Parameters extracted", { time }),
        tr("feed.rewritten", "{time} — Rewritten to sp_UpdateVehicleState", { time }),
        tr("feed.planReused", "{time} — Existing plan reused", { time }),
        tr("feed.compAvoided", "{time} — Compilation avoided", { time }),
        tr("feed.posUpdatedFast", "{time} — Vehicle position updated in 80 ms", { time }),
        tr("feed.cpuStable", "{time} — SQL CPU stabilized at 36%", { time }),
        tr("feed.delayReduced", "{time} — GPS display delay reduced to 0.2 sec", { time }),
      ];
      return { kind: "good", text: pick(base.concat(q)) };
    }
    const queueVal = 1000 + ((Math.random() * 400) | 0);
    const b = [
      { text: tr("feed.adhocReceived", "{time} — Ad-hoc UPDATE received", { time }), bad: false },
      { text: tr("feed.cacheMiss", "{time} — Plan cache miss", { time }), bad: true },
      { text: tr("feed.compStarted", "{time} — Compilation started", { time }), bad: true },
      { text: tr("feed.newPlan", "{time} — New single-use plan created", { time }), bad: false },
      { text: tr("feed.posUpdated", "{time} — Vehicle position updated", { time }), bad: false },
      { text: tr("feed.cpuSpike", "{time} — CPU spike detected", { time }), bad: true },
      { text: tr("feed.compQueue", "{time} — Compilation queue reached {n}", { time, n: queueVal }), bad: true },
      { text: tr("feed.delayReached", "{time} — GPS display delay reached 4.8 sec", { time }), bad: true },
    ];
    const all = base.map((s) => ({ text: s, bad: false })).concat(b);
    const chosen = pick(all);
    return { kind: chosen.bad ? "bad" : "info", text: chosen.text };
  }
}

function pick(a) { return a[(Math.random() * a.length) | 0]; }
