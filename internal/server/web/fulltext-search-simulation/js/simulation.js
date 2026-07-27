// Orchestrates the whole scene: camera, office, five workstations/employees,
// the Quentra activation choreography, metrics and the live event feed.
import { Camera } from './camera.js';
import { Office } from './office.js';
import { Workstation } from './person.js';
import { Employee } from './employee.js';
import { Wave, Toast } from './fx.js';
import { DESKS, PEOPLE, TIMELINE, PHASE, DOCS_TOTAL } from './config.js';
import { fmtInt } from './draw.js';

export class Simulation {
  constructor(view) {
    this.view = view;
    this.cam = new Camera(view);
    this.office = new Office(this.cam);
    this.station = new Workstation(this.cam);
    this.wave = new Wave(view);
    this.toast = new Toast(view);

    this.employees = DESKS.map((d, i) => new Employee(d.id, d, PEOPLE[i]));
    // Draw far desks first (painter's order by depth).
    this.drawOrder = [...this.employees].sort((a, b) => a.desk.d - b.desk.d);

    this.mode = 'auto';        // auto | baseline | quentra
    this.phase = PHASE.BASELINE;
    this.clock = 0;
    this.activated = false;
    this._activateQueue = [];
    this.t = 0;

    this.events = [];
    this.matches = 0;

    this._seedEvents();
  }

  _seedEvents() {
    this.pushEvent('feed.emp1Started', 'busy');
    this.pushEvent('feed.emp3Started', 'busy');
    this.pushEvent('feed.emp2StillSearching', 'busy');
  }

  // `key` is a QuentraI18n dictionary key (with an English fallback baked in
  // via `fallback`); `params` are interpolated into the translated string
  // ("{id}" etc). Stored as data so the feed can be re-rendered on language
  // change without losing history.
  pushEvent(key, kind = 'info', params = null, fallback = null) {
    this.events.unshift({ key, kind, params, fallback, clock: this.clock });
    if (this.events.length > 7) this.events.pop();
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'baseline') this._forceBaseline();
    else if (mode === 'quentra') this._forceQuentra();
    else this._restartAuto();
  }

  _forceBaseline() {
    this.phase = PHASE.BASELINE;
    this.activated = false; this._activateQueue = [];
    this.wave.reset(); this.toast.reset();
    this.matches = 0;
    for (const e of this.employees) e.reset();
    this.pushEvent('feed.baselineMode', 'busy');
  }

  _forceQuentra() {
    this.phase = PHASE.QUENTRA;
    this.activated = true; this._activateQueue = [];
    for (const e of this.employees) e.activateQuentra();
    this.pushEvent('feed.quentraActive', 'quentra');
  }

  _restartAuto() {
    this.clock = 0; this.phase = PHASE.BASELINE; this.activated = false;
    this._activateQueue = [];
    this.wave.reset(); this.toast.reset();
    this.matches = 0;
    for (const e of this.employees) e.reset();
    this.events = []; this._seedEvents();
  }

  reset() { this.setMode(this.mode === 'auto' ? 'auto' : this.mode); this._restartAuto(); this.mode = 'auto'; }

  update(dt) {
    this.t += dt;
    const surge = this.phase === PHASE.SURGE || this.phase === PHASE.ACTIVATING;

    if (this.mode === 'auto') this._tickTimeline(dt);

    // Each workstation flips to Quentra the instant the purple wave reaches it.
    for (let i = this._activateQueue.length - 1; i >= 0; i--) {
      const emp = this._activateQueue[i];
      const g = this.station.geometry(emp);
      if (this.wave.hasReached(emp.id, g.cx, g.base - 90 * g.s)) {
        emp.activateQuentra();
        this.pushEvent('feed.foundDocument', 'ok', { id: emp.id }, `Employee ${emp.id} found document`);
        this._activateQueue.splice(i, 1);
      }
    }

    this.office.update(dt);
    this.wave.update(dt);
    this.toast.update(dt);

    let prevMatches = this.matches;
    this.matches = 0;
    for (const e of this.employees) {
      e.update(dt, this.phase, surge);
      if (e.resolved) this.matches++;
    }
    if (this.matches !== prevMatches) { /* counters read live */ }
  }

  _tickTimeline(dt) {
    const prev = this.clock;
    this.clock += dt;
    const T = TIMELINE;

    if (prev < T.loadingSurge && this.clock >= T.loadingSurge) {
      this.phase = PHASE.SURGE;
      this.pushEvent('feed.emp4StillSearching', 'busy');
      this.pushEvent('feed.loadIncreasing', 'busy');
    }
    if (prev < T.quentraActivate && this.clock >= T.quentraActivate) {
      this._activateQuentra();
    }
    if (this.clock >= T.loopEnd) {
      this._restartAuto();
    }
  }

  _activateQuentra() {
    if (this.activated) return;
    this.activated = true;
    this.phase = PHASE.ACTIVATING;
    this.wave.trigger();
    this.toast.show();
    this.pushEvent('feed.quentraActivated', 'quentra');
    // Every monitor is queued; each one flips the instant the wave reaches it.
    this._activateQueue = [...this.employees];
    // Wave takes ~1.4s to cross the full canvas at its current speed;
    // give every desk time to be hit before forcing the phase over.
    setTimeout(() => { if (this.mode === 'auto') this.phase = PHASE.QUENTRA; }, 1900);
  }

  draw(ctx) {
    ctx.clearRect(0, 0, this.view.w, this.view.h);
    this.office.draw(ctx);
    // Workstations far -> near.
    for (const e of this.drawOrder) this.station.draw(ctx, e, this.t);
    // Purple activation wave over everything.
    this.wave.draw(ctx);
    this.toast.draw(ctx);
  }

  // ---- Metrics for the right panel ----
  metrics() {
    const resolvedFrac = this.matches / this.employees.length;
    const cpu = Math.round((this.phase === PHASE.BASELINE || this.phase === PHASE.SURGE ? 88 : 88 - resolvedFrac * 74) - (this.phase === PHASE.SURGE ? -6 : 0));
    let searchTime, scanned, queue;
    if (this.matches === this.employees.length) {
      const avgMs = Math.round(this.employees.reduce((a, e) => a + e.resultMs, 0) / this.employees.length);
      searchTime = `${avgMs} ms`;
    } else {
      const avgSec = this.employees.filter(e => !e.resolved).reduce((a, e) => a + e.elapsed, 0) / Math.max(1, this.employees.filter(e => !e.resolved).length);
      searchTime = `${avgSec.toFixed(2)} s`;
    }
    scanned = this.employees.reduce((a, e) => a + (e.mode === PHASE.BASELINE ? e.docsScanned : 0), 0);
    queue = this.employees.filter(e => !e.resolved).length;
    return {
      cpu: Math.max(8, Math.min(96, cpu)),
      searchTime,
      scanned: fmtInt(scanned),
      matches: `${this.matches} / ${this.employees.length}`,
      queue,
      docsTotal: fmtInt(DOCS_TOTAL),
      phase: this.phase,
      activated: this.activated,
    };
  }

  statusLabel() {
    const t = (window.QuentraI18n && window.QuentraI18n.t.bind(window.QuentraI18n)) || ((k, f) => f);
    if (this.matches === this.employees.length) return { text: t('status.quentra', 'Quentra'), kind: 'quentra' };
    if (this.activated) return { text: t('status.activating', 'Activating'), kind: 'quentra' };
    return { text: t('status.baseline', 'Baseline'), kind: 'baseline' };
  }
}
