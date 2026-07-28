// engine.js
// requestAnimationFrame loop with delta-time integration (frame-rate
// independent), a speed multiplier and pause/resume/stop/reset. DOM/KPI updates
// are throttled through onFrame so we never touch the DOM every frame.

export class Engine {
  constructor(sim, renderer) {
    this.sim = sim;
    this.renderer = renderer;
    this.running = true;
    this.stopped = false;
    this.speed = 1;
    this.last = 0;
    this._uiAcc = 0;
    this.onFrame = null;      // (dt) => void, throttled ~12Hz
    this._loop = this._loop.bind(this);
  }

  start() { this.last = performance.now(); requestAnimationFrame(this._loop); }

  pause() { this.running = false; }
  resume() { if (!this.running) { this.running = true; this.stopped = false; this.last = performance.now(); } }
  setSpeed(s) { this.speed = s; }

  stop() {
    this.running = false;
    this.stopped = true;
    // Freeze on the current frame.
    this.renderer.render(this.sim);
  }

  reset() {
    this.sim.reset();
    this.running = true;
    this.stopped = false;
    this.speed = 1;
    this.last = performance.now();
  }

  _loop(now) {
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.05) dt = 0.05;         // clamp big gaps (tab switch)
    if (dt < 0) dt = 0;

    if (this.running) {
      const sdt = dt * this.speed;
      this.sim.update(sdt);
    }
    this.renderer.render(this.sim);

    this._uiAcc += dt;
    if (this._uiAcc >= 0.08) {
      if (this.onFrame) this.onFrame(this._uiAcc);
      this._uiAcc = 0;
    }
    requestAnimationFrame(this._loop);
  }
}
