// Engine: contain-fit canvas sizing, delta-time logic stepping and rAF drawing.
// Logic runs on a setInterval clock (survives rAF throttling in hidden tabs);
// drawing runs on requestAnimationFrame.
export class Engine {
  constructor(canvas, sim, onFrame) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = sim;
    this.onFrame = onFrame;
    this.speed = 1;
    this.paused = false;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this._logicLast = performance.now();
    this._uiAccum = 0;

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const { w, h } = this.sim.view;
    // contain-fit
    const scale = Math.min(rect.width / w, rect.height / h);
    this.cssW = w * scale; this.cssH = h * scale;
    this.canvas.style.width = this.cssW + 'px';
    this.canvas.style.height = this.cssH + 'px';
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  start() {
    // Logic clock — authoritative, ~60Hz, robust to background throttling.
    this._logicLast = performance.now();
    this._timer = setInterval(() => this._logicTick(), 1000 / 60);
    // Draw clock.
    const draw = () => {
      this.sim.draw(this.ctx);
      this._raf = requestAnimationFrame(draw);
    };
    this._raf = requestAnimationFrame(draw);
  }

  _logicTick() {
    const now = performance.now();
    let dt = (now - this._logicLast) / 1000;
    this._logicLast = now;
    if (dt > 0.1) dt = 0.1;        // clamp long stalls
    if (this.paused || dt <= 0) return;
    this.sim.update(dt * this.speed);
    this._uiAccum += dt;
    if (this._uiAccum >= 0.1) { this._uiAccum = 0; this.onFrame && this.onFrame(); }
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; this._logicLast = performance.now(); }
  setSpeed(m) { this.speed = m; }
  stop() { clearInterval(this._timer); cancelAnimationFrame(this._raf); }
}
