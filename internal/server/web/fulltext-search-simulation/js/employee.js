// Per-employee state machine: search progress, counters, subtle body animation,
// and an object-pooled stream of document icons flowing across the monitor.
import { REFS, DOCS_TOTAL, PHASE } from './config.js';
import { seeded, clamp } from './draw.js';

const DOC_POOL = 60;

export class Employee {
  constructor(id, desk, person) {
    this.id = id;
    this.desk = desk;
    this.person = person;
    this.ref = REFS[id - 1];

    this.mode = PHASE.BASELINE;   // baseline | quentra
    this.searching = true;

    // Baseline metrics.
    this.elapsed = 3 + seeded(id) * 2;         // seconds, climbs
    this.docsScanned = 9_800_000 + Math.floor(seeded(id * 3) * 1_500_000);
    this.scanRate = 380000 + seeded(id * 5) * 120000; // docs/sec (visual)

    // Quentra result.
    this.resolved = false;
    this.resultMs = 42 + Math.floor(seeded(id * 7) * 34);   // 42..76 ms
    this.pipeStage = 0;      // 0 build, 1 search, 2 match
    this.pipeT = 0;
    this.flyDoc = null;      // { t } single highlighted document
    this.reveal = 0;         // 0..1 result card reveal

    // Body animation params.
    this.breathe = seeded(id * 11) * Math.PI * 2;
    this.typePhase = seeded(id * 2) * Math.PI * 2;
    this.typeIntensity = 1;         // 0 idle .. 1 typing
    this.mouse = { x: 0.6, y: 0.7, tx: 0.6, ty: 0.7, moveT: 0 };
    this.headTurn = 0;              // -1..1
    this.headTarget = 0;
    this.frustration = 0;           // 0..1 grows while waiting in baseline surge
    this.leanBack = 0;
    this.fingerTap = seeded(id * 13) * Math.PI * 2;

    // Document flow pool (normalized coords inside the search area).
    this.docs = [];
    for (let i = 0; i < DOC_POOL; i++) this.docs.push(this._spawnDoc(seeded(id * 17 + i)));
  }

  _spawnDoc(seed) {
    return {
      x: -0.1 - seed * 1.1,           // 0..1 across; start off left
      y: 0.15 + seed * 0.7,
      spd: 0.10 + seed * 0.12,
      alpha: 0.5 + seed * 0.5,
      row: Math.floor(seed * 5),
    };
  }

  // Called by simulation to switch this employee to Quentra mode.
  activateQuentra() {
    if (this.mode === PHASE.QUENTRA) return;
    this.mode = PHASE.QUENTRA;
    this.searching = true;
    this.resolved = false;
    this.pipeStage = 0;
    this.pipeT = 0;
    this.reveal = 0;
    this.flyDoc = { t: 0 };
    this.frustration = 0;
    this.leanBack = 0;
  }

  reset() {
    this.mode = PHASE.BASELINE;
    this.searching = true;
    this.elapsed = 3 + seeded(this.id) * 2;
    this.docsScanned = 9_800_000 + Math.floor(seeded(this.id * 3) * 1_500_000);
    this.resolved = false;
    this.pipeStage = 0; this.pipeT = 0; this.reveal = 0;
    this.flyDoc = null;
    this.frustration = 0; this.leanBack = 0;
  }

  update(dt, phase, surge) {
    this.breathe += dt * 1.4;
    this.typePhase += dt * 14 * this.typeIntensity;
    this.fingerTap += dt * 9;

    // Mouse drift.
    this.mouse.moveT -= dt;
    if (this.mouse.moveT <= 0) {
      this.mouse.tx = 0.45 + seeded(this.id + this.breathe) * 0.4;
      this.mouse.ty = 0.55 + seeded(this.id * 2 + this.breathe) * 0.35;
      this.mouse.moveT = 0.6 + seeded(this.id * 3 + this.breathe) * 1.4;
    }
    this.mouse.x += (this.mouse.tx - this.mouse.x) * clamp(dt * 4, 0, 1);
    this.mouse.y += (this.mouse.ty - this.mouse.y) * clamp(dt * 4, 0, 1);

    // Head glance.
    if (seeded(this.id + Math.floor(this.breathe * 2)) > 0.985) {
      this.headTarget = (seeded(this.breathe) - 0.5) * 1.6;
    }
    this.headTurn += (this.headTarget - this.headTurn) * clamp(dt * 3, 0, 1);
    this.headTarget *= (1 - dt * 0.5);

    if (this.mode === PHASE.BASELINE) {
      this._updateBaseline(dt, surge);
    } else {
      this._updateQuentra(dt);
    }
  }

  _updateBaseline(dt, surge) {
    this.searching = true;
    this.elapsed += dt;
    this.docsScanned = Math.min(DOCS_TOTAL, this.docsScanned + this.scanRate * dt);
    // Frustration builds during the surge phase.
    const target = surge ? 0.85 : 0.25;
    this.frustration += (target - this.frustration) * clamp(dt * 0.6, 0, 1);
    this.leanBack += (this.frustration * 0.8 - this.leanBack) * clamp(dt * 0.8, 0, 1);
    this.typeIntensity += (0.15 - this.typeIntensity) * clamp(dt * 2, 0, 1); // barely typing, waiting

    // advance flowing documents
    for (const d of this.docs) {
      d.x += d.spd * dt * (surge ? 1.15 : 1);
      if (d.x > 1.12) {
        const s = seeded(this.id * 31 + this.breathe * 3 + d.y);
        d.x = -0.12;
        d.y = 0.15 + s * 0.7;
        d.spd = 0.10 + s * 0.12;
        d.alpha = 0.5 + s * 0.5;
        d.row = Math.floor(s * 5);
      }
    }
  }

  _updateQuentra(dt) {
    // Pipeline: build index -> searching -> match.
    if (!this.resolved) {
      this.pipeT += dt;
      const durs = [0.5, 0.5, 0.35];
      if (this.pipeT > durs[this.pipeStage]) {
        this.pipeT = 0;
        this.pipeStage++;
        if (this.pipeStage >= 3) { this.pipeStage = 2; this.resolved = true; }
      }
    } else {
      this.reveal = clamp(this.reveal + dt * 2.2, 0, 1);
    }
    // Flying document toward result area.
    if (this.flyDoc) {
      this.flyDoc.t = clamp(this.flyDoc.t + dt * 2.6, 0, 1);
    }
    // Content, relaxed employee: typing resumes.
    this.frustration += (0 - this.frustration) * clamp(dt * 2, 0, 1);
    this.leanBack += (0 - this.leanBack) * clamp(dt * 2, 0, 1);
    this.typeIntensity += (0.9 - this.typeIntensity) * clamp(dt * 2, 0, 1);
  }
}
