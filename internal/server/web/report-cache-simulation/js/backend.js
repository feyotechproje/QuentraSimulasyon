// backend.js — Live mode client for the report-cache simulation.
//
// Demo mode: this class stays idle and the page runs its scripted animation.
// Live mode: the server executes the REAL heavy report
// (QUENTRA_RETAIL.dbo.SP_REPORT_CACHE_EXAMPLE) over one of two connections —
// straight to SQL Server ("baseline") or through the Quentra gateway
// ("quentra") — and this client polls the measured results.
//
// Nothing here fakes a speed-up: whatever latency the gateway produces is what
// gets displayed. If Quentra is serving the report from its cache the numbers
// drop on their own; if it is not, both paths read the same.

const POLL_MS = 500;

export class ReportCacheBackend {
  constructor(sim) {
    this.sim = sim;
    this.state = null;
    this.live = false;
    this.connected = false;
    this._lastMode = null;
    this._stopped = false;
    sim.backend = null;
    this._poll();
    this._watchMode();
  }

  /** Turn live mode on/off. Starts/stops the real workload server-side. */
  async setLive(on) {
    this.live = !!on;
    if (!this.live) {
      this.sim.backend = null;
      this.state = null;
    }
    await this._push();
  }

  /** Clear the measurement batch so a fresh comparison can start. */
  async resetStats() {
    try {
      await fetch("/api/reportcache/reset", { method: "POST" });
    } catch { /* transient */ }
  }

  async _poll() {
    for (;;) {
      if (this.live) {
        try {
          const r = await fetch("/api/reportcache/state", { cache: "no-store" });
          if (r.ok) {
            const data = await r.json();
            this.state = data;
            this.connected = !!data.provisioned;
            this.sim.backend = data.provisioned ? data : null;
          }
        } catch {
          this.connected = false;
        }
      }
      await sleep(POLL_MS);
    }
  }

  // The simulation's own mode is the source of truth; mirror it onto the
  // server so the real workload uses the matching connection.
  _watchMode() {
    setInterval(() => {
      if (!this.live) return;
      if (this.sim.mode !== this._lastMode) {
        this._lastMode = this.sim.mode;
        this._push();
      }
    }, 200);
  }

  async _push() {
    // The sim calls its cached path "cache"; the server expects "quentra".
    const mode = this.sim.mode === "cache" ? "quentra" : "baseline";
    this._lastMode = this.sim.mode;
    try {
      await fetch("/api/reportcache/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, live: this.live }),
      });
    } catch { /* ignore; the poller keeps the UI honest */ }
  }
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
