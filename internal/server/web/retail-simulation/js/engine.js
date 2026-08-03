// engine.js
// requestAnimationFrame loop with delta-time updates so the simulation runs at a
// consistent pace regardless of monitor refresh rate. Owns run state + speed.
//
// The engine drives VIEWS: {sim, renderer} pairs, one per canvas. The dual
// store renders the direct bank on the left canvas and the Quentra bank on the
// right, both ticked with the same clock so the comparison is frame-accurate.

export const ENGINE_STATE = { RUNNING: "running", PAUSED: "paused", STOPPED: "stopped" };

export class Engine {
  /** @param {Array<{sim: object, renderer: object}>} views @param {object} ui */
  constructor(views, ui) {
    this.views = views;
    this.ui = ui;
    this.state = ENGINE_STATE.RUNNING;
    this.speed = 1;
    this.onTick = null;      // optional per-frame hook (scenario story pacing)
    this._last = 0;
    this._uiAccum = 0;
    this._raf = null;
    this._tick = this._tick.bind(this);
  }

  /** All live simulation objects, left bank first. */
  get sims() { return this.views.map((v) => v.sim); }

  start() {
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  _tick(now) {
    let dt = (now - this._last) / 1000;
    this._last = now;
    if (dt > 0.06) dt = 0.06; // guard against tab-switch spikes

    if (this.onTick) this.onTick(dt);
    if (this.state === ENGINE_STATE.RUNNING) {
      for (const v of this.views) v.sim.update(dt * this.speed);
    }

    for (const v of this.views) v.renderer.render(v.sim);

    this._uiAccum += dt;
    if (this._uiAccum >= 0.12) {
      this._uiAccum = 0;
      this.ui.update(this);
    }

    this._raf = requestAnimationFrame(this._tick);
  }

  pause() { if (this.state === ENGINE_STATE.RUNNING) this.state = ENGINE_STATE.PAUSED; this.ui.syncControls(this); }
  resume() { if (this.state !== ENGINE_STATE.STOPPED) this.state = ENGINE_STATE.RUNNING; this.ui.syncControls(this); }
  stop() { this.state = ENGINE_STATE.STOPPED; this.ui.syncControls(this); }

  reset() {
    for (const v of this.views) v.sim.reset();
    this.state = ENGINE_STATE.RUNNING;
    this._last = performance.now();
    this.ui.update(this);
    this.ui.syncControls(this);
  }

  setSpeed(v) { this.speed = v; }
}
