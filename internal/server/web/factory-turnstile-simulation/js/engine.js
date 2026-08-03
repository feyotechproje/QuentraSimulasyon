// engine.js
// requestAnimationFrame driver with delta-time stepping. Keeps animation
// independent of monitor refresh rate and applies the simulation speed
// multiplier. Rendering and DOM updates are delegated via callbacks.
//
// Drives VIEWS: {sim, renderer} pairs — the baseline bank on the left canvas
// and the Quentra bank on the right, ticked with the same clock so the
// comparison is frame-accurate.

export class Engine {
  /** @param {Array<{sim: object, renderer: object}>} views */
  constructor(views) {
    this.views = views;
    this.onFrame = null; // (dt) => void, for throttled DOM updates
    this._last = 0;
    this._raf = 0;
    this._tick = this._tick.bind(this);
  }

  /** All simulations, baseline bank first. */
  get sims() { return this.views.map((v) => v.sim); }

  start() {
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  _tick(now) {
    let dt = (now - this._last) / 1000;
    this._last = now;
    if (dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1; // clamp after tab-switch / long frames

    for (const v of this.views) {
      const simDt = dt * v.sim.speed;
      if (v.sim.running) v.sim.update(simDt);
      v.renderer.render(v.sim, v.sim.running ? simDt : dt);
    }
    if (this.onFrame) this.onFrame(dt);

    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }
}
