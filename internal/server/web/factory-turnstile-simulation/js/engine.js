// engine.js
// requestAnimationFrame driver with delta-time stepping. Keeps animation
// independent of monitor refresh rate and applies the simulation speed
// multiplier. Rendering and DOM updates are delegated via callbacks.

export class Engine {
  constructor(sim, renderer) {
    this.sim = sim;
    this.renderer = renderer;
    this.onFrame = null; // (dt) => void, for throttled DOM updates
    this._last = 0;
    this._raf = 0;
    this._tick = this._tick.bind(this);
  }

  start() {
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  _tick(now) {
    let dt = (now - this._last) / 1000;
    this._last = now;
    if (dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1; // clamp after tab-switch / long frames

    const simDt = dt * this.sim.speed;
    if (this.sim.running) this.sim.update(simDt);
    this.renderer.render(this.sim, this.sim.running ? simDt : dt);
    if (this.onFrame) this.onFrame(dt);

    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }
}
