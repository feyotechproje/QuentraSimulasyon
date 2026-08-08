// ui.js
// Binds the DOM dashboard to the DUAL simulation: the baseline bank on the left
// canvas, the Quentra bank on the right, and the shared panels between them.
// All DOM writes are throttled so the render loop stays smooth even with
// hundreds of workers on the floor.

import { GATE_STATE } from "./turnstile.js";
import { WORKER_STATE } from "./worker.js";

const DEFAULT_SHIFT_TARGET = 250;
const DOM_INTERVAL = 0.15; // seconds between DOM refreshes

const $ = (id) => document.getElementById(id);

// Shorthand for the shared i18n runtime; falls back to the given English
// string if the key/dictionary isn't ready yet (e.g. very first paint).
const t = (key, fallback) => (window.QuentraI18n ? window.QuentraI18n.t(key, fallback) : fallback);

function fmt(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars && k in vars ? vars[k] : `{${k}}`));
}

function formatQueryDuration(seconds) {
  if (!(seconds > 0)) return "—";
  if (seconds < 1) return Math.round(seconds * 1000) + " ms";
  return seconds.toFixed(seconds < 10 ? 1 : 0) + " s";
}

function formatSpeedup(value) {
  if (!(value > 0) || !Number.isFinite(value)) return "—";
  return value.toFixed(value < 10 ? 1 : 0) + "×";
}

export class UI {
  /** @param {object} engine multi-view engine: views[0] baseline, views[1] Quentra */
  constructor(engine) {
    this.engine = engine;
    this.sims = engine.sims;
    this._acc = 0;
    this._lastEventSeq = "";
    // Operator-chosen shift size (both banks combined); set on the overlay.
    this.shiftTarget = DEFAULT_SHIFT_TARGET;

    this.el = {
      statusPill: $("statusPill"), statusLabel: $("statusLabel"),
      clock: $("simClock"), shift: $("simShift"),
      kBaseAvg: $("kBaseAvg"), kQnAvg: $("kQnAvg"), kSpeedup: $("kSpeedup"),
      kEntered: $("kEntered"), kPerMin: $("kPerMin"), kUtil: $("kUtil"),
      kBaseWaiting: $("kBaseWaiting"), kBaseCheck: $("kBaseCheck"), kBaseEntered: $("kBaseEntered"),
      kQnWaiting: $("kQnWaiting"), kQnCheck: $("kQnCheck"), kQnEntered: $("kQnEntered"),
      gateGrid: $("gateGrid"), gateSummary: $("gateSummary"),
      heatmap: $("heatmap"), bottleneck: $("bottleneck"),
      cwc: $("cwc"), feed: $("accessFeed"),
      pipeline: $("pipeline"), pipeFindTime: $("pipeFindTime"),
      rwImprove: $("rwImprove"),
      rwBaseAvg: $("rwBaseAvg"), rwQnAvg: $("rwQnAvg"),
      rwBaseBar: $("rwBaseBar"), rwQnBar: $("rwQnBar"),
      rwBaseMeta: $("rwBaseMeta"), rwQnMeta: $("rwQnMeta"),
      sqSource: $("sqSource"), sqTransport: $("sqTransport"),
      sqAppSql: $("sqAppSql"), sqDirectSql: $("sqDirectSql"), sqQuentraSql: $("sqQuentraSql"),
      sqAppTrace: $("sqAppTrace"), sqDirectTrace: $("sqDirectTrace"), sqQnTrace: $("sqQnTrace"),
      sqDirectBadge: $("sqDirectBadge"), sqQnBadge: $("sqQnBadge"),
      shiftBar: $("shiftBar"), shiftPct: $("shiftPct"),
      shiftEntered: $("shiftEntered"), shiftTarget: $("shiftTarget"),
      selectedPanel: $("selectedPanel"), selTitle: $("selTitle"), selDetail: $("selDetail"),
      shiftStart: $("shiftStart"), shiftCount: $("shiftCount"),
      shiftPresets: $("shiftPresets"), btnShiftStart: $("btnShiftStart"),
    };
    // The worker-count overlay is opt-in: it opens from the play button when
    // the banks are idle, never on its own. (It used to auto-show whenever
    // both banks were idle — so when the shift COMPLETED mid-story, the
    // blurred card popped up behind the story camera.)
    this._ssOpen = false;
    this.el.shiftTarget.textContent = fmt(t("shift.target", "target {n}"), { n: this.shiftTarget });

    this._buildGateGrid();
    this._buildHeatmap();
    this._wireControls();
    this._wireCanvases();
    this.refresh(); // initial paint

    // Re-render every dynamic (non data-i18n) string when the user switches
    // language — static DOM text is already handled by the shared runtime.
    window.addEventListener("quentra:langchange", () => {
      this.el.shiftTarget.textContent = fmt(t("shift.target", "target {n}"), { n: this.shiftTarget });
      this._syncControls();
      this._lastEventSeq = ""; // force feed re-render with new language
      this.refresh();
    });
  }

  /** Start a shift of `total` workers, split evenly across the two banks. */
  _startShift(total) {
    const n = Math.max(20, Math.min(4000, total | 0 || DEFAULT_SHIFT_TARGET));
    this.shiftTarget = n;
    this.sims[0].startShift(Math.ceil(n / 2));
    this.sims[1].startShift(Math.floor(n / 2));
    this.el.shiftTarget.textContent = fmt(t("shift.target", "target {n}"), { n });
    // startShift rebuilt the gates, so the shared panel scaffolding must too.
    this._buildGateGrid();
    this._buildHeatmap();
    this._lastEventSeq = "";
    this._syncControls();
    this.refresh();
  }

  /** All (sim, gate) pairs, baseline bank first — the shared panel order. */
  _allGates() {
    const out = [];
    this.sims.forEach((sim, si) => {
      for (const g of sim.gates) out.push({ sim, si, g });
    });
    return out;
  }

  // ---- static scaffolding -------------------------------------------------
  _buildGateGrid() {
    const grid = this.el.gateGrid;
    grid.innerHTML = "";
    this._gateCells = [];
    for (const { sim, si, g } of this._allGates()) {
      const cell = document.createElement("div");
      cell.className = "gate-cell";
      cell.dataset.route = si === 1 ? "quentra" : "baseline";
      cell.innerHTML =
        `<div class="gc-top"><span class="gc-name"></span><span class="gc-light off"></span></div>` +
        `<div class="gc-q"></div><div class="gc-bar"><i></i></div>`;
      cell.addEventListener("click", () => this._selectGate(sim, g));
      grid.appendChild(cell);
      this._gateCells.push({
        root: cell,
        g,
        name: cell.querySelector(".gc-name"),
        light: cell.querySelector(".gc-light"),
        q: cell.querySelector(".gc-q"),
        bar: cell.querySelector(".gc-bar > i"),
      });
    }
  }

  _buildHeatmap() {
    const hm = this.el.heatmap;
    hm.innerHTML = "";
    this._heatCells = [];
    const gates = this._allGates();
    hm.style.gridTemplateColumns = `repeat(${gates.length}, 1fr)`;
    for (const { g } of gates) {
      const c = document.createElement("div");
      c.className = "hm-cell";
      c.innerHTML = `<div class="hm-bar"><div class="hm-fill"></div></div><span class="hm-label"></span>`;
      hm.appendChild(c);
      this._heatCells.push({ g, fill: c.querySelector(".hm-fill"), label: c.querySelector(".hm-label") });
    }
  }

  _wireControls() {
    const each = (fn) => this.sims.forEach(fn);
    $("btnPause").addEventListener("click", () => { each((s) => s.pause()); this._syncControls(); });
    // Play: resumes a pause; on an idle/finished floor it OPENS the worker
    // count dialog instead (the shift never starts without being sized).
    $("btnResume").addEventListener("click", () => {
      if (this.sims[0].status === "PAUSED") {
        each((s) => s.resume());
        this._syncControls();
      } else {
        this._ssOpen = true;
        this.refresh();
      }
    });
    $("btnStop").addEventListener("click", () => { each((s) => s.stop()); this._syncControls(); });
    $("btnReset").addEventListener("click", () => {
      each((s) => s.reset());
      this._buildGateGrid();
      this._buildHeatmap();
      this._lastEventSeq = "";
      this._syncControls();
      this.refresh();
    });
    document.querySelectorAll(".speed-btn").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".speed-btn").forEach((x) => x.classList.remove("is-active"));
        b.classList.add("is-active");
        each((s) => s.setSpeed(parseFloat(b.dataset.speed)));
      });
    });
    $("clearSel").addEventListener("click", () => this._clearSelection());

    // Shift start overlay: presets fill the count input; Start launches both
    // banks with the chosen worker budget split between them.
    if (this.el.shiftPresets) {
      this.el.shiftPresets.querySelectorAll(".ss-preset").forEach((b) => {
        b.addEventListener("click", () => {
          if (this.el.shiftCount) this.el.shiftCount.value = b.dataset.count;
          this.el.shiftPresets.querySelectorAll(".ss-preset").forEach((x) =>
            x.classList.toggle("is-active", x === b));
        });
      });
    }
    if (this.el.btnShiftStart) {
      this.el.btnShiftStart.addEventListener("click", () => {
        this._ssOpen = false;
        this.el.shiftStart.hidden = true;
        this._startShift(parseInt(this.el.shiftCount && this.el.shiftCount.value, 10));
      });
    }
    // Clicking the dimmed backdrop (not the card) closes the dialog.
    if (this.el.shiftStart) {
      this.el.shiftStart.addEventListener("click", (ev) => {
        if (ev.target === this.el.shiftStart) {
          this._ssOpen = false;
          this.refresh();
        }
      });
    }
  }

  /** Story hook: make sure a shift is running WITHOUT showing the picker —
   *  the story must play over live floors, sized by the current input. */
  ensureShiftRunning() {
    if (["IDLE", "STOPPED", "COMPLETED"].includes(this.sims[0].status)) {
      this._ssOpen = false;
      this._startShift(parseInt(this.el.shiftCount && this.el.shiftCount.value, 10));
    }
  }

  _wireCanvases() {
    for (const view of this.engine.views) {
      const { sim, renderer } = view;
      const canvas = renderer.canvas;
      canvas.addEventListener("click", (e) => {
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const w = renderer.pickWorker(sim, sx, sy);
        if (w) { this._selectWorker(sim, w); return; }
        const g = renderer.pickGate(sim, sx, sy);
        if (g) this._selectGate(sim, g);
      });
    }
    window.addEventListener("resize", () => {
      for (const view of this.engine.views) view.renderer.resize();
    });
  }

  _clearSelection() {
    for (const s of this.sims) {
      s.selectedGate = null;
      s.selectedWorker = null;
      for (const g of s.gates) g.selected = false;
      for (const w of s.workers) w.highlight = false;
    }
  }

  _selectGate(sim, g) {
    this._clearSelection();
    g.selected = true;
    sim.selectedGate = g;
  }

  _selectWorker(sim, w) {
    this._clearSelection();
    w.highlight = true;
    sim.selectedWorker = w;
  }

  _syncControls() {
    const lead = this.sims[0];
    const st = lead.status; // IDLE | RUNNING | PAUSED | STOPPED | COMPLETED
    $("btnPause").disabled = !lead.running;
    // Play resumes a pause OR (idle/stopped/completed) opens the size dialog.
    $("btnResume").disabled = st === "RUNNING";
    const stateMap = { RUNNING: "running", PAUSED: "paused" };
    this.el.statusPill.dataset.state = stateMap[st] || "stopped";
    const labels = {
      IDLE: ["status.idle", "READY TO START"],
      RUNNING: ["status.running", "SIMULATION RUNNING"],
      PAUSED: ["status.paused", "SIMULATION PAUSED"],
      STOPPED: ["status.stopped", "SIMULATION STOPPED"],
      COMPLETED: ["status.completed", "SHIFT COMPLETED"],
    };
    const [key, fallback] = labels[st] || labels.RUNNING;
    this.el.statusLabel.textContent = t(key, fallback);
  }

  // ---- throttled refresh --------------------------------------------------
  tick(dt) {
    this._acc += dt;
    if (this._acc < DOM_INTERVAL) return;
    this._acc = 0;
    this.refresh();
  }

  refresh() {
    const [base, qn] = this.sims;
    const kb = base.kpi, kq = qn.kpi;
    const e = this.el;
    e.clock.textContent = base.clockString();

    // The start overlay only shows while the banks are idle AND the operator
    // asked for it (play button) — never on its own, so a shift completing
    // mid-story can no longer blur the floors behind the story camera.
    if (e.shiftStart) {
      const idle = ["IDLE", "STOPPED", "COMPLETED"].includes(base.status);
      if (!idle) this._ssOpen = false;
      e.shiftStart.hidden = !(idle && this._ssOpen);
    }

    // The two query columns fill SIMULTANEOUSLY — each bank feeds its own side.
    const bStat = base.compare.baseline;
    const qStat = qn.compare.quentra;
    const bAvg = bStat.n ? bStat.sum / bStat.n : 0;
    const qAvg = qStat.n ? qStat.sum / qStat.n : 0;
    e.kBaseAvg.textContent = formatQueryDuration(bAvg);
    e.kQnAvg.textContent = formatQueryDuration(qAvg);
    e.kSpeedup.textContent = bAvg > 0 && qAvg > 0 ? formatSpeedup(bAvg / qAvg) : "—";

    // Per-bank clusters, mirroring the two floors below the band.
    e.kBaseWaiting.textContent = kb.waiting;
    e.kQnWaiting.textContent = kq.waiting;
    e.kBaseEntered.textContent = kb.successfulEntries;
    e.kQnEntered.textContent = kq.successfulEntries;
    const bCheck = base.checkSamples ? base.sumCheckTime / base.checkSamples : 0;
    const qCheck = qn.checkSamples ? qn.sumCheckTime / qn.checkSamples : 0;
    e.kBaseCheck.textContent = bCheck.toFixed(1) + "s";
    e.kQnCheck.textContent = qCheck.toFixed(1) + "s";

    // Facility-wide aggregates across both banks.
    e.kEntered.textContent = kb.successfulEntries + kq.successfulEntries;
    e.kPerMin.textContent = Math.round(kb.entriesPerMin + kq.entriesPerMin);
    e.kUtil.textContent = Math.round(((kb.utilization + kq.utilization) / 2) * 100) + "%";
    if (!this._acc) this._syncControls();

    this._renderGates();
    this._renderHeatmap();
    this._renderBottleneck();
    this._renderCurrentCheck();
    this._renderPipeline();
    this._renderRewrite(bStat, qStat, bAvg, qAvg);
    this._renderSqlTriple();
    this._renderShift(kb, kq);
    this._renderFeed();
    this._renderSelected();
  }

  _lightClass(g) {
    return g.light || "off";
  }

  _renderGates() {
    for (const c of this._gateCells) {
      const g = c.g;
      c.name.textContent = g.label;
      c.light.className = "gc-light " + this._lightClass(g);
      c.q.textContent = fmt(t("gate.inQueue", "{n} in queue · {state}"), {
        n: g.queueLength,
        state: t(`gs.${g.state}`, g.state).toLowerCase(),
      });
      const ql = g.queueLength;
      const heat = ql <= 3 ? "#22c55e" : ql <= 6 ? "#f5b301" : ql <= 9 ? "#f97316" : "#ef4444";
      c.bar.style.width = Math.min(100, (ql / 12) * 100) + "%";
      c.bar.style.background = heat;
      c.root.classList.toggle("sel", g.selected);
    }
    const lanes = this._gateCells.length;
    const checking = this.sims.reduce((a, s) => a + (s.kpi.pendingChecks || 0), 0);
    this.el.gateSummary.textContent = fmt(t("gate.summary", "{lanes} lanes · {checking} checking"), {
      lanes, checking,
    });
  }

  _renderHeatmap() {
    for (const c of this._heatCells) {
      const ql = c.g.queueLength;
      const heat = ql <= 3 ? "#22c55e" : ql <= 6 ? "#f5b301" : ql <= 9 ? "#f97316" : "#ef4444";
      c.fill.style.height = Math.min(100, (ql / 13) * 100) + "%";
      c.fill.style.background = heat;
      c.label.textContent = c.g.id;
    }
  }

  _renderBottleneck() {
    const rows = this.sims
      .flatMap((s) => s.bottlenecks(4))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    if (!rows.length) {
      this.el.bottleneck.innerHTML = `<p class="empty">${t("panel.noBottleneck", "No active bottlenecks.")}</p>`;
      return;
    }
    const max = rows[0].score || 1;
    this.el.bottleneck.innerHTML = rows.map((r, i) => {
      const g = r.gate;
      const checking = g.state === GATE_STATE.CHECKING && g.currentWorker;
      const meta = checking
        ? fmt(t("bottleneck.queryMeta", "query {t}s · queue {q}"), { t: g.checkTimer.toFixed(1), q: g.queueLength })
        : fmt(t("bottleneck.queueMeta", "queue {q}"), { q: g.queueLength });
      return `<div class="bn-row"><div class="bn-rank">${i + 1}</div>` +
        `<div class="bn-info"><div class="bn-name">${fmt(t("bottleneck.turnstile", "Turnstile {label}"), { label: g.label })}</div>` +
        `<div class="bn-meta">${meta}</div>` +
        `<div class="bn-bar"><i style="width:${Math.min(100, (r.score / max) * 100)}%"></i></div></div></div>`;
    }).join("");
  }

  _decisionChip(state) {
    switch (state) {
      case WORKER_STATE.ENTRY_APPROVED: return `<span class="chip approved">${t("chip.approved", "ENTRY APPROVED")}</span>`;
      case WORKER_STATE.ACCESS_DENIED: return `<span class="chip denied">${t("chip.denied", "ACCESS DENIED")}</span>`;
      case WORKER_STATE.MANUAL_REVIEW: return `<span class="chip manual">${t("chip.manual", "MANUAL REVIEW")}</span>`;
      case WORKER_STATE.CHECKING_LAST_MOVEMENT: return `<span class="chip checking">${t("chip.checking", "CHECKING")}</span>`;
      default: return `<span class="chip pending">${t("chip.pending", "PENDING")}</span>`;
    }
  }

  _initials(name) {
    return name.split(" ").map((p) => p[0]).slice(0, 2).join("");
  }

  _movementLabel(m) {
    return t(`movement.${m}`, m || "—");
  }

  /** The longest-running active check across BOTH banks (selection wins). */
  _activeCheck() {
    for (const s of this.sims) {
      if (s.selectedWorker) {
        const g = s.gates.find((x) => x.currentWorker === s.selectedWorker);
        if (g) return { sim: s, gate: g, worker: s.selectedWorker };
      }
    }
    let best = null;
    for (const s of this.sims) {
      const ac = s.activeCheck();
      if (ac && (!best || ac.worker.checkElapsed > best.worker.checkElapsed)) {
        best = { sim: s, gate: ac.gate, worker: ac.worker };
      }
    }
    return best;
  }

  _renderCurrentCheck() {
    const ac = this._activeCheck();
    if (!ac) {
      this.el.cwc.innerHTML = `<p class="empty">${t("empty.waitingForCard", "Waiting for a card to be presented…")}</p>`;
      return;
    }
    const w = ac.worker, g = ac.gate;
    const elapsed = w.checkElapsed || 0;
    const isLive = !!(w.check && w.check.live) || ac.sim.live;
    // In live mode the visual clock is narration; only demo escalates its style.
    const cls = isLive ? "" : elapsed >= 7 ? "elapsed-crit" : elapsed >= 2.5 ? "elapsed-slow" : "";
    // Decided = the state machine already ran _resolve (async-safe: the check
    // may arrive late, so elapsed-vs-duration alone is not enough).
    const decided = !!w.check && w.state !== WORKER_STATE.CHECKING_LAST_MOVEMENT;
    const result = decided ? this._decisionChip(w.state) : `<span class="chip checking">${t("chip.running", "RUNNING")}</span>`;
    const lastMove = decided && w.check ? this._movementLabel(w.check.lastMovement) : "—";
    const decision = decided
      ? (w.state === WORKER_STATE.ENTRY_APPROVED ? t("chip.approved", "ENTRY APPROVED")
        : w.state === WORKER_STATE.ACCESS_DENIED ? t("chip.denied", "ACCESS DENIED") : t("chip.manual", "MANUAL REVIEW"))
      : t("cwc.decision.pending", "Pending");
    this.el.cwc.innerHTML =
      `<div class="cwc-head"><div class="cwc-avatar">${this._initials(w.displayName)}</div>` +
      `<div class="cwc-id"><strong>${w.displayName}</strong><span>${w.employeeId} · ${w.department}</span></div></div>` +
      `<div class="cwc-row"><span class="k">${t("cwc.turnstile", "Turnstile")}</span><span class="v">${g.label}</span></div>` +
      `<div class="cwc-row"><span class="k">${t("cwc.requestedAction", "Requested Action")}</span><span class="v">${t("cwc.requestedAction.entry", "ENTRY")}</span></div>` +
      `<div class="cwc-row"><span class="k">${t("cwc.validationRule", "Validation Rule")}</span><span class="v">${t("cwc.validationRule.value", "Previous = EXIT")}</span></div>` +
      `<div class="cwc-row"><span class="k">${t("cwc.currentOperation", "Current Operation")}</span><span class="v">${t("cwc.currentOperation.value", "Searching latest movement")}</span></div>` +
      `<div class="cwc-row"><span class="k">${t("cwc.queryStatus", "Query Status")}</span><span class="v">${result}</span></div>` +
      `<div class="cwc-row"><span class="k">${t("cwc.elapsed", "Elapsed")}</span><span class="v elapsed-big ${cls}">${elapsed.toFixed(1)}s</span></div>` +
      // Two separate clocks in live mode: the REAL query time (KPI input) vs
      // the visual narration time shown above.
      (w.check && w.check.live
        ? `<div class="cwc-row"><span class="k">${t("cwc.sqlMs", "Real SQL time")}</span><span class="v">${(w.check.sqlMs || 0).toFixed(1)} ms</span></div>` +
          (w.check.traceId ? `<div class="cwc-row"><span class="k">${t("cwc.trace", "Trace")}</span><span class="v">${w.check.traceId}</span></div>` : "")
        : "") +
      `<div class="cwc-row"><span class="k">${t("cwc.previousMovement", "Previous Movement")}</span><span class="v">${lastMove}</span></div>` +
      `<div class="cwc-row"><span class="k">${t("cwc.decision", "Decision")}</span><span class="v">${decision}</span></div>`;
  }

  _renderPipeline() {
    const ac = this._activeCheck();
    const findStep = this.el.pipeline.querySelector('[data-step="find"]');
    const openStep = this.el.pipeline.querySelector('[data-step="open"]');
    const elapsed = ac ? (ac.worker.checkElapsed || 0) : 0;
    this.el.pipeFindTime.textContent = elapsed.toFixed(1) + "s";
    const flag = findStep.querySelector(".ps-flag");
    // The tracked check's own bank decides the flag: a Quentra-bank check is
    // fast by construction, a baseline one escalates with elapsed time.
    if (ac && ac.sim.mode === "quentra") {
      findStep.classList.remove("is-slow", "is-critical");
      findStep.classList.add("is-ok");
      if (flag) flag.textContent = t("pipeline.flag.fast", "FAST");
    } else {
      findStep.classList.remove("is-ok");
      findStep.classList.toggle("is-critical", elapsed >= 7);
      findStep.classList.toggle("is-slow", elapsed < 7);
      if (flag) flag.textContent = elapsed >= 7 ? t("pipeline.flag.critical", "CRITICAL") : t("pipeline.flag.slow", "SLOW");
    }
    // OPEN step lights up green briefly when someone is being approved / passing
    const opening = this.sims.some((s) =>
      s.gates.some((g) => g.state === GATE_STATE.OPENING || g.state === GATE_STATE.PASSING));
    openStep.classList.toggle("is-ok", opening);
    openStep.querySelector(".ps-time").textContent = opening ? "0.4s" : "—";
  }

  // The three-column query journey: what the app SENT (always the bad ad-hoc
  // statement) vs what SQL Server RECEIVED on each route. Demo mode shows the
  // representative texts; live mode shows the DMV-captured statements of the
  // most recent real card check, tied together by its traceId.
  _renderSqlTriple() {
    const e = this.el;
    if (!e.sqAppSql) return;
    const live = this.sims.some((s) => s.live);
    const lc = this.sims
      .map((s) => s.lastLiveCheck)
      .filter(Boolean)
      .sort((a, b) => (b.at || 0) - (a.at || 0))[0];

    if (!live || !lc) {
      e.sqSource.textContent = t("sq.source.demo", "REPRESENTATIVE");
      e.sqSource.dataset.tone = "demo";
      e.sqAppSql.textContent = t("sq.app.sql",
        "SELECT TOP 1 LOGICALREF, TARIH, HAREKET_TIPI\nFROM dbo.PERSONEL_HAREKET\nWHERE PERSONELREF = 11249   -- NO date boundary\nORDER BY TARIH DESC; /*ACC-XXXXXX*/");
      e.sqDirectSql.textContent = t("sq.direct.sql",
        "-- SQL Server received the SAME query\n-- the employee's ENTIRE history is scanned\n-- millions of rows read, each check takes seconds");
      e.sqQuentraSql.textContent = t("sq.quentra.sql",
        "-- With a matching rule Quentra rewrites in flight:\nSELECT TOP (1) LOGICALREF, TARIH, HAREKET_TIPI\nFROM dbo.PERSONEL_HAREKET\nWHERE PERSONELREF = 11249\n  AND TARIH >= DATEADD(DAY, -10, GETDATE())   -- last 10 days is enough\nORDER BY TARIH DESC");
      e.sqAppTrace.textContent = "—";
      e.sqDirectTrace.textContent = "—";
      e.sqQnTrace.textContent = "—";
      e.sqDirectBadge.textContent = t("sq.direct.badge", "Rewrite: none");
      e.sqQnBadge.textContent = t("sq.quentra.waiting", "Awaiting rule");
      e.sqQnBadge.dataset.tone = "";
      // The demo rewrite narrows the scan window; the transport itself is
      // untouched (live mode overwrites this with what really happened).
      e.sqTransport.textContent = "SQLBatch → SQLBatch";
      return;
    }

    e.sqSource.textContent = t("sq.source.live", "LIVE · MEASURED");
    e.sqSource.dataset.tone = "live";
    e.sqAppSql.textContent = lc.applicationSql || "—";
    e.sqDirectSql.textContent = lc.directBackendSql || "—";
    e.sqQuentraSql.textContent = lc.gatewayUp
      ? (lc.quentraBackendSql || "—")
      : t("sq.quentra.down", "Quentra gateway down — query was NOT sent");
    const traceTxt = fmt(t("sq.trace", "trace {id} · {emp} · {gate}"), {
      id: lc.traceId || "—", emp: lc.employeeId || "—", gate: lc.gate || "—",
    });
    e.sqAppTrace.textContent = traceTxt;
    e.sqDirectTrace.textContent = traceTxt;
    e.sqQnTrace.textContent = traceTxt;
    e.sqDirectBadge.textContent = t("sq.direct.badge", "Rewrite: none");
    if (!lc.gatewayUp) {
      e.sqQnBadge.textContent = t("sq.quentra.gwdown", "Gateway DOWN");
      e.sqQnBadge.dataset.tone = "bad";
    } else if (lc.ruleMatched) {
      e.sqQnBadge.textContent = t("sq.quentra.matched", "Rule matched · MEASURED");
      e.sqQnBadge.dataset.tone = "ok";
    } else {
      e.sqQnBadge.textContent = t("sq.quentra.nomatch", "No rule — passed through unchanged");
      e.sqQnBadge.dataset.tone = "warn";
    }
    e.sqTransport.textContent = (lc.inputTransport || "SQLBatch") + " → " + (lc.outputTransport || "SQLBatch");
  }

  _renderRewrite(bStat, qStat, bAvg, qAvg) {
    const e = this.el;
    const maxAvg = Math.max(bAvg, qAvg, 0.01);
    // formatQueryDuration renders sub-second (live) averages in ms and demo
    // averages in seconds, so both modes stay readable.
    e.rwBaseAvg.textContent = bStat.n ? formatQueryDuration(bAvg) : "—";
    e.rwQnAvg.textContent = qStat.n ? formatQueryDuration(qAvg) : "—";
    e.rwBaseBar.style.width = (bStat.n ? (bAvg / maxAvg) * 100 : 0) + "%";
    e.rwQnBar.style.width = (qStat.n ? (qAvg / maxAvg) * 100 : 0) + "%";
    e.rwBaseMeta.textContent = fmt(t("rewrite.checksDetail", "{n} checks · {slow} slow · {timeouts} timeout"),
      { n: bStat.n, slow: bStat.slow, timeouts: bStat.timeouts });
    e.rwQnMeta.textContent = fmt(t("rewrite.checksDetail", "{n} checks · {slow} slow · {timeouts} timeout"),
      { n: qStat.n, slow: qStat.slow, timeouts: qStat.timeouts });
    if (bStat.n && qStat.n && qAvg > 0) {
      const factor = bAvg / qAvg;
      e.rwImprove.textContent = fmt(t("rewrite.xFaster", "{n}× faster"),
        { n: factor >= 10 ? factor.toFixed(0) : factor.toFixed(1) });
    } else {
      e.rwImprove.textContent = t("rewrite.compareHint", "Both banks are measuring…");
    }
  }

  _renderShift(kb, kq) {
    const entered = kb.successfulEntries + kq.successfulEntries;
    const pct = Math.min(100, (entered / this.shiftTarget) * 100);
    this.el.shiftBar.style.width = pct + "%";
    this.el.shiftPct.textContent = Math.round(pct) + "%";
    this.el.shiftEntered.textContent = fmt(t("shift.entered", "{n} entered"), { n: entered });
  }

  _feedText(ev) {
    if (!ev.textKey) return ev.text;
    const vars = ev.vars || {};
    const resolvedVars = vars.reasonKey
      ? { ...vars, reason: t(vars.reasonKey, vars.reason) }
      : vars;
    return fmt(t(ev.textKey, ev.text), resolvedVars);
  }

  _renderFeed() {
    // Merge both banks' feeds newest-first; the shared clock makes the string
    // timestamps directly comparable.
    const merged = this.sims
      .flatMap((s, si) => s.events.feed.map((ev) => ({ ev, si })))
      .sort((a, b) => (a.ev.time < b.ev.time ? 1 : a.ev.time > b.ev.time ? -1 : 0))
      .slice(0, 60);
    const top = merged.length ? `${merged[0].si}:${merged[0].ev.id}:${merged.length}` : "";
    if (top === this._lastEventSeq) return;
    this._lastEventSeq = top;
    this.el.feed.innerHTML = merged.map(({ ev }) =>
      `<div class="feed-item ${ev.kind}"><span class="ft">${ev.time}</span><span class="fx">${this._feedText(ev)}</span></div>`
    ).join("");
  }

  // Gate "message.line" values are short state tags set by the simulation in
  // English (e.g. "APPROACHING", "QUERY 1.2s"); map the fixed ones through the
  // dictionary and keep the dynamic "QUERY Ns" one formatted with the current
  // language's template.
  _gateLine(line) {
    if (!line) return "—";
    const m = /^QUERY ([\d.]+)s$/.exec(line);
    if (m) return fmt(t("msg.query", "QUERY {n}s"), { n: m[1] });
    const map = {
      APPROACHING: "msg.approaching",
      "PRESENT CARD": "msg.presentCard",
      "CHECKING LAST MOVEMENT": "msg.checkingLastMovement",
      "ENTRY APPROVED": "msg.entryApproved",
      "ACCESS DENIED": "msg.accessDenied",
      "MANUAL REVIEW": "msg.manualReview",
      // Live pipeline narration (async state machine).
      "QUERY SENT": "msg.querySent",
      "WAITING RESULT": "msg.waitingResult",
      "RULE MATCHED": "msg.ruleMatched",
      "QUERY REWRITTEN": "msg.queryRewritten",
      "DB EXECUTING": "msg.dbExecuting",
      "RESULT RECEIVED": "msg.resultReceived",
    };
    const key = map[line];
    return key ? t(key, line) : line;
  }

  _gateStateLabel(state) {
    return t(`gs.${state}`, state);
  }

  _workerStateLabel(state) {
    return t(`ws.${state}`, state);
  }

  _renderSelected() {
    let sim = null, g = null, w = null;
    for (const s of this.sims) {
      if (s.selectedGate) { sim = s; g = s.selectedGate; break; }
      if (s.selectedWorker) { sim = s; w = s.selectedWorker; break; }
    }
    if (!g && !w) { this.el.selectedPanel.hidden = true; return; }
    this.el.selectedPanel.hidden = false;
    if (g) {
      this.el.selTitle.textContent = fmt(t("detail.turnstileTitle", "Turnstile {label}"), { label: g.label });
      const cw = g.currentWorker;
      const rows = [
        [t("detail.route", "Query route"), sim.mode === "quentra" ? "Quentra" : t("mode.baseline", "Baseline")],
        [t("detail.currentStatus", "Current status"), this._gateStateLabel(g.state)],
        [t("detail.queueLength", "Queue length"), g.queueLength],
        [t("detail.currentWorker", "Current worker"), cw ? cw.displayName : "—"],
        [t("detail.queryDuration", "Query duration"), g.state === GATE_STATE.CHECKING ? g.checkTimer.toFixed(1) + "s" : "—"],
        [t("detail.lastMovement", "Last movement"), cw && cw.check ? this._movementLabel(cw.check.lastMovement) : "—"],
        [t("detail.accessResult", "Access result"), this._gateLine(g.message.line)],
        [t("detail.avgProcessing", "Avg processing"), g.avgCheck.toFixed(1) + "s"],
        [t("detail.totalProcessed", "Total processed"), g.totalProcessed],
        [t("detail.deniedCount", "Denied count"), g.deniedCount],
        [t("detail.manualCount", "Manual count"), g.manualCount],
        [t("detail.timeoutCount", "Timeout count"), g.timeoutCount],
      ];
      this.el.selDetail.innerHTML = rows.map(([kk, vv]) =>
        `<div class="detail-row"><span class="k">${kk}</span><span class="v">${vv}</span></div>`).join("");
    } else {
      this.el.selTitle.textContent = w.displayName;
      const decisionLabel = w.check
        ? (w.check.decision === "ENTRY_APPROVED" ? t("chip.approved", "ENTRY APPROVED")
          : w.check.decision === "ACCESS_DENIED" ? t("chip.denied", "ACCESS DENIED")
          : t("chip.manual", "MANUAL REVIEW"))
        : t("cwc.decision.pending", "Pending");
      const rows = [
        [t("detail.employeeId", "Employee ID"), w.employeeId],
        [t("detail.department", "Department"), w.department],
        [t("detail.currentState", "Current state"), this._workerStateLabel(w.state)],
        [t("detail.turnstile", "Turnstile"), w.turnstileId ? "T" + String(w.turnstileId).padStart(2, "0") : "—"],
        [t("detail.queuePosition", "Queue position"), w.queueIndex >= 0 ? w.queueIndex + 1 : "—"],
        [t("detail.lastMovement", "Last movement"), w.check ? this._movementLabel(w.check.lastMovement) : "—"],
        [t("detail.checkElapsed", "Check elapsed"), (w.checkElapsed || 0).toFixed(1) + "s"],
        [t("detail.accessDecision", "Access decision"), decisionLabel],
      ];
      this.el.selDetail.innerHTML = rows.map(([kk, vv]) =>
        `<div class="detail-row"><span class="k">${kk}</span><span class="v">${vv}</span></div>`).join("");
    }
  }
}
