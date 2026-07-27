// engine.js
// requestAnimationFrame loop with delta-time updates so the simulation runs at a
// consistent pace regardless of monitor refresh rate. Owns run state + speed.

export const ENGINE_STATE = { RUNNING: "running", PAUSED: "paused", STOPPED: "stopped" };

export class Engine {
  constructor(simulation, renderer, ui) {
    this.sim = simulation;
    this.renderer = renderer;
    this.ui = ui;
    this.state = ENGINE_STATE.RUNNING;
    this.speed = 1;
    this._last = 0;
    this._uiAccum = 0;
    this._raf = null;
    this._tick = this._tick.bind(this);
  }

  start() {
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  _tick(now) {
    let dt = (now - this._last) / 1000;
    this._last = now;
    if (dt > 0.06) dt = 0.06; // guard against tab-switch spikes

    if (this.state === ENGINE_STATE.RUNNING) {
      this.sim.update(dt * this.speed);
    }

    this.renderer.render(this.sim);

    this._uiAccum += dt;
    if (this._uiAccum >= 0.12) {
      this._uiAccum = 0;
      this.ui.update(this.sim, this);
    }

    this._raf = requestAnimationFrame(this._tick);
  }

  pause() { if (this.state === ENGINE_STATE.RUNNING) this.state = ENGINE_STATE.PAUSED; this.ui.syncControls(this); }
  resume() { if (this.state !== ENGINE_STATE.STOPPED) this.state = ENGINE_STATE.RUNNING; this.ui.syncControls(this); }
  stop() { this.state = ENGINE_STATE.STOPPED; this.ui.syncControls(this); }

  reset() {
    this.sim.reset();
    this.state = ENGINE_STATE.RUNNING;
    this._last = performance.now();
    this.ui.update(this.sim, this);
    this.ui.syncControls(this);
  }

  setSpeed(v) { this.speed = v; }
}
