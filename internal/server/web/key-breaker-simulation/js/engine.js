// engine.js — requestAnimationFrame loop with delta-time (frame-rate independent).

export class Engine {
  constructor(sim, renderer, ui) {
    this.sim = sim; this.renderer = renderer; this.ui = ui;
    this.speed = 1;
    this._last = 0;
    this._uiAccum = 0;
    this._raf = null;
    this._tick = this._tick.bind(this);
  }
  start() { this._last = performance.now(); this._raf = requestAnimationFrame(this._tick); }
  setSpeed(s) { this.speed = s; }

  _tick(now) {
    this._raf = requestAnimationFrame(this._tick);
    let dt = (now - this._last) / 1000;
    this._last = now;
    if (!(dt > 0)) dt = 0;            // guard first frame / tab wake
    dt = Math.min(dt, 0.05);          // clamp large gaps
    const sdt = dt * this.speed;

    this.sim.update(sdt);
    this.renderer.render(this.sim.world, this.sim);

    this._uiAccum += dt;
    if (this._uiAccum >= 0.12) { this.ui.update(); this._uiAccum = 0; }
  }
}
