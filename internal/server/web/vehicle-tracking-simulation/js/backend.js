// backend.js
// Connects the vehicle-tracking visualisation to the REAL SQL Server workload
// running against the VEHICLEGPS database (100,000 rows). It polls live metrics
// (updates/sec, compilations/sec, single-use plans, plan-cache size, latency,
// SQL CPU) and pushes the current mode to the backend so the ad-hoc vs stored
// procedure comparison is measured, not scripted.

import { claimWorkload } from "/shared/workload-control.js";

const POLL_MS = 500;
const WORKLOAD_ID = "vehicle-tracking-simulation";

export class VehicleBackend {
  constructor(sim) {
    this.sim = sim;
    this.state = null;
    this.connected = false;
    this._lastMode = null;
    // Live by default: this page exists to show the real workload. Demo mode
    // stops the SQL traffic entirely and lets the visualisation run on its own
    // simulated numbers, which are labelled as such.
    this.live = true;
    sim.backend = null;
    sim.liveMode = true;
    // The server starts no workload at boot: claim ours while this page is
    // open and release it on unload so a closed tab stops the SQL traffic.
    this.workload = claimWorkload(WORKLOAD_ID);
    this._poll();
    this._watchMode();
  }

  /** Switch between the real SQL workload and the offline demo. */
  setLive(on) {
    const next = !!on;
    if (next === this.live) return;
    this.live = next;
    this.sim.liveMode = next;
    if (next) {
      this.workload.start();
    } else {
      // Leaving live mode must actually stop the workload, otherwise "demo"
      // would keep hammering SQL Server while claiming nothing is running.
      this.workload.stop();
      this.sim.backend = null;
      this.state = null;
      this.connected = false;
    }
  }

  async _poll() {
    for (;;) {
      try {
        if (!this.live) {
          this.sim.backend = null;
          this.connected = false;
        } else {
          const r = await fetch("/api/vehicle/state", { cache: "no-store" });
          if (r.ok) {
            const data = await r.json();
            this.state = data;
            this.connected = !!data.provisioned;
            this.sim.backend = data.provisioned ? data : null;
            // Provisioning runs in the background, so the claim made at page
            // load can land before the database is ready. Retry once it is.
            if (data.provisioned && !data.running) this.workload.start();
          }
        }
      } catch {
        this.connected = false;
      }
      await sleep(POLL_MS);
    }
  }

  // Whenever the simulation mode changes (manual toggle or the auto demo),
  // route the real workload to match.
  _watchMode() {
    setInterval(() => {
      if (this.sim.mode !== this._lastMode) {
        this._lastMode = this.sim.mode;
        // In demo mode the baseline/Quentra choice only drives the animation;
        // pushing it to the server would start real queries.
        if (this.live) this.setMode(this.sim.mode);
      }
    }, 200);
  }

  async setMode(mode) {
    try {
      await fetch("/api/vehicle/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
    } catch {
      /* ignore transient errors; poller keeps the UI live */
    }
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
