// timeline.js — a single pausable, speed-scaled clock that drives every timed
// step and per-frame ticker. All simulation timing flows through this so there
// are no scattered setTimeouts and one speed multiplier controls everything.

export class CanceledError extends Error {
  constructor() { super("timeline canceled"); this.name = "CanceledError"; }
}

export class Timeline {
  constructor() {
    this.speed = 1;
    this.paused = false;
    this._waits = [];      // { remaining, resolve, reject }
    this._tickers = new Set();
    this._raf = null;
    this._interval = null;
    this._last = 0;
  }

  setSpeed(s) { this.speed = s; }
  pause() { this.paused = true; }
  resume() { this.paused = false; this._last = performance.now(); this._ensure(); }

  /** Resolves after `ms` of simulation time (scaled by speed, frozen on pause). */
  wait(ms) {
    return new Promise((resolve, reject) => {
      this._waits.push({ remaining: ms, resolve, reject });
      this._ensure();
    });
  }

  addTicker(fn) { this._tickers.add(fn); this._ensure(); return fn; }
  removeTicker(fn) { this._tickers.delete(fn); }

  /** Aborts every pending wait (rejecting with CanceledError) and stops ticking. */
  cancel() {
    const pending = this._waits;
    this._waits = [];
    this._tickers.clear();
    this._stop();
    pending.forEach(w => w.reject(new CanceledError()));
  }

  _stop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }

  _ensure() {
    if (this._interval != null) return;
    this._last = performance.now();
    // requestAnimationFrame gives smooth 60fps updates when the tab is visible;
    // a setInterval fallback keeps the clock advancing even when the tab is
    // backgrounded (where rAF is fully paused). Both funnel into _frame, which
    // measures real elapsed time, so they never double-count.
    const loop = () => { this._frame(); if (this._raf != null) this._raf = requestAnimationFrame(loop); };
    this._raf = requestAnimationFrame(loop);
    this._interval = setInterval(() => this._frame(), 100);
  }

  _frame() {
    const now = performance.now();
    // Clamp to allow catch-up after throttling/tab-switch, without huge jumps.
    const realDt = Math.min(500, Math.max(0, now - this._last));
    this._last = now;

    if (!this.paused && realDt > 0) {
      const simDt = realDt * this.speed;
      this._tickers.forEach(fn => { try { fn(simDt); } catch (_) { /* ignore */ } });
      if (this._waits.length) {
        const done = [];
        for (const w of this._waits) {
          w.remaining -= simDt;
          if (w.remaining <= 0) done.push(w);
        }
        if (done.length) {
          this._waits = this._waits.filter(w => !done.includes(w));
          done.forEach(w => w.resolve());
        }
      }
    }

    if (!this._waits.length && !this._tickers.size) this._stop();
  }
}
