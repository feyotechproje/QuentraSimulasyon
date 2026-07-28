// ui.js
// Binds the DOM dashboard to the simulation. All DOM writes are throttled so
// the render loop stays smooth even with hundreds of workers on the floor.

import { GATE_STATE } from "./turnstile.js";
import { WORKER_STATE } from "./worker.js";

const SHIFT_TARGET = 500;
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
  constructor(sim, renderer, engine) {
    this.sim = sim;
    this.renderer = renderer;
    this.engine = engine;
    this._acc = 0;
    this._lastEventSeq = -1;

    this.el = {
      statusPill: $("statusPill"), statusLabel: $("statusLabel"),
      clock: $("simClock"), shift: $("simShift"),
      kBaseAvg: $("kBaseAvg"), kQnAvg: $("kQnAvg"), kSpeedup: $("kSpeedup"),
      kAvgQueue: $("kAvgQueue"), kPending: $("kPending"), kPerMin: $("kPerMin"),
      kUtil: $("kUtil"), kWaiting: $("kWaiting"),
      gateGrid: $("gateGrid"), gateSummary: $("gateSummary"),
      heatmap: $("heatmap"), bottleneck: $("bottleneck"),
      cwc: $("cwc"), feed: $("accessFeed"),
      pipeline: $("pipeline"), pipeFindTime: $("pipeFindTime"), pipeTag: $("pipeTag"),
      canvasHint: $("canvasHint"),
      rwImprove: $("rwImprove"), rwBefore: $("rwBefore"), rwAfter: $("rwAfter"),
      rwBaseAvg: $("rwBaseAvg"), rwQnAvg: $("rwQnAvg"),
      rwBaseBar: $("rwBaseBar"), rwQnBar: $("rwQnBar"),
      rwBaseMeta: $("rwBaseMeta"), rwQnMeta: $("rwQnMeta"),
      shiftBar: $("shiftBar"), shiftPct: $("shiftPct"),
      shiftEntered: $("shiftEntered"), shiftTarget: $("shiftTarget"),
      selectedPanel: $("selectedPanel"), selTitle: $("selTitle"), selDetail: $("selDetail"),
    };
    this.el.shiftTarget.textContent = fmt(t("shift.target", "target {n}"), { n: SHIFT_TARGET });

    this._buildGateGrid();
    this._buildHeatmap();
    this._wireControls();
    this._wireCanvas();
    this._applyMode();
    this.refresh(); // initial paint

    // Re-render every dynamic (non data-i18n) string when the user switches
    // language — static DOM text is already handled by the shared runtime.
    window.addEventListener("quentra:langchange", () => {
      this.el.shiftTarget.textContent = fmt(t("shift.target", "target {n}"), { n: SHIFT_TARGET });
      this._syncControls();
      this._applyMode();
      this._lastEventSeq = -1; // force feed re-render with new language
      this.refresh();
    });
  }

  // ---- static scaffolding -------------------------------------------------
  _buildGateGrid() {
    const grid = this.el.gateGrid;
    grid.innerHTML = "";
    this._gateCells = [];
    for (let i = 0; i < this.sim.gates.length; i++) {
      const cell = document.createElement("div");
      cell.className = "gate-cell";
      cell.innerHTML =
        `<div class="gc-top"><span class="gc-name"></span><span class="gc-light off"></span></div>` +
        `<div class="gc-q"></div><div class="gc-bar"><i></i></div>`;
      cell.addEventListener("click", () => this._selectGate(this.sim.gates[i]));
      grid.appendChild(cell);
      this._gateCells.push({
        root: cell,
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
    for (let i = 0; i < this.sim.gates.length; i++) {
      const c = document.createElement("div");
      c.className = "hm-cell";
      c.innerHTML = `<div class="hm-bar"><div class="hm-fill"></div></div><span class="hm-label"></span>`;
      hm.appendChild(c);
      this._heatCells.push({ fill: c.querySelector(".hm-fill"), label: c.querySelector(".hm-label") });
    }
  }

  _wireControls() {
    $("btnPause").addEventListener("click", () => { this.sim.pause(); this._syncControls(); });
    $("btnResume").addEventListener("click", () => { this.sim.resume(); this._syncControls(); });
    $("btnStop").addEventListener("click", () => { this.sim.stop(); this._syncControls(); });
    $("btnReset").addEventListener("click", () => {
      this.sim.reset();
      this._buildGateGrid();
      this._buildHeatmap();
      this._lastEventSeq = -1;
      this._syncControls();
      this._applyMode();
      this.refresh();
    });
    document.querySelectorAll(".speed-btn").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".speed-btn").forEach((x) => x.classList.remove("is-active"));
        b.classList.add("is-active");
        this.sim.setSpeed(parseFloat(b.dataset.speed));
      });
    });
    document.querySelectorAll(".mode-btn").forEach((b) => {
      b.addEventListener("click", () => {
        this.sim.setMode(b.dataset.mode);
        this._applyMode();
        this.refresh();
      });
    });
    const search = $("searchInput");
    search.addEventListener("input", () => {
      const q = search.value.trim().toUpperCase();
      if (!q) return;
      const w = this.sim.workers.find((x) => x.employeeId.includes(q));
      for (const x of this.sim.workers) x.highlight = false;
      if (w) { w.highlight = true; this.sim.selectedWorker = w; this.sim.selectedGate = null; }
    });
    $("clearSel").addEventListener("click", () => {
      this.sim.selectedGate = null;
      this.sim.selectedWorker = null;
      for (const g of this.sim.gates) g.selected = false;
      for (const w of this.sim.workers) w.highlight = false;
    });
  }

  _wireCanvas() {
    const canvas = this.renderer.canvas;
    canvas.addEventListener("click", (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const w = this.renderer.pickWorker(this.sim, sx, sy);
      if (w) { this._selectWorker(w); return; }
      const g = this.renderer.pickGate(this.sim, sx, sy);
      if (g) this._selectGate(g);
    });
    window.addEventListener("resize", () => this.renderer.resize());
  }

  _selectGate(g) {
    for (const x of this.sim.gates) x.selected = false;
    g.selected = true;
    this.sim.selectedGate = g;
    this.sim.selectedWorker = null;
    for (const w of this.sim.workers) w.highlight = false;
  }

  _selectWorker(w) {
    for (const x of this.sim.workers) x.highlight = false;
    w.highlight = true;
    this.sim.selectedWorker = w;
    this.sim.selectedGate = null;
    for (const g of this.sim.gates) g.selected = false;
  }

  _syncControls() {
    const stopped = this.sim.status === "STOPPED";
    const paused = this.sim.status === "PAUSED";
    $("btnPause").disabled = !this.sim.running;
    $("btnResume").disabled = this.sim.running || stopped;
    const state = stopped ? "stopped" : paused ? "paused" : "running";
    this.el.statusPill.dataset.state = state;
    const statusKey = stopped ? "status.stopped" : paused ? "status.paused" : "status.running";
    const statusFallback = stopped ? "SIMULATION STOPPED" : paused ? "SIMULATION PAUSED" : "SIMULATION RUNNING";
    this.el.statusLabel.textContent = t(statusKey, statusFallback);
  }

  _applyMode() {
    const q = this.sim.mode === "quentra";
    document.querySelectorAll(".mode-btn").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.mode === this.sim.mode));
    this.el.pipeTag.textContent = q ? t("pipeline.tag.quentra", "QUENTRA") : t("pipeline.tag.baseline", "BASELINE");
    this.el.pipeTag.classList.toggle("warn", !q);
    if (this.el.canvasHint) {
      this.el.canvasHint.textContent = q
        ? t("hint.quentra", "Click a turnstile or a worker to inspect · 15 lanes · Quentra (rewritten keyed last-movement lookup)")
        : t("hint.baseline", "Click a turnstile or a worker to inspect · 15 lanes · Baseline (slow last-movement query)");
    }
    if (this.el.rwBefore) this.el.rwBefore.dataset.active = (!q).toString();
    if (this.el.rwAfter) this.el.rwAfter.dataset.active = q.toString();
  }

  // ---- throttled refresh --------------------------------------------------
  tick(dt) {
    this._acc += dt;
    if (this._acc < DOM_INTERVAL) return;
    this._acc = 0;
    this.refresh();
  }

  refresh() {
    const k = this.sim.kpi;
    const comparison = this.sim.compareStats();
    const e = this.el;
    e.clock.textContent = this.sim.clockString();
    e.kBaseAvg.textContent = formatQueryDuration(comparison.bAvg);
    e.kQnAvg.textContent = formatQueryDuration(comparison.qAvg);
    e.kSpeedup.textContent = comparison.bAvg > 0 && comparison.qAvg > 0
      ? formatSpeedup(comparison.bAvg / comparison.qAvg)
      : "—";
    e.kWaiting.textContent = k.waiting;
    e.kAvgQueue.textContent = k.avgQueue.toFixed(1) + "s";
    e.kPerMin.textContent = Math.round(k.entriesPerMin);
    e.kUtil.textContent = Math.round(k.utilization * 100) + "%";
    e.kPending.textContent = k.pendingChecks;
    if (!this._acc) this._syncControls();

    this._renderGates();
    this._renderHeatmap();
    this._renderBottleneck();
    this._renderCurrentCheck();
    this._renderPipeline();
    this._renderRewrite();
    this._renderShift(k);
    this._renderFeed();
    this._renderSelected();
  }

  _lightClass(g) {
    return g.light || "off";
  }

  _renderGates() {
    for (let i = 0; i < this._gateCells.length; i++) {
      const g = this.sim.gates[i];
      const c = this._gateCells[i];
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
    this.el.gateSummary.textContent = fmt(t("gate.summary", "{lanes} lanes · {checking} checking"), {
      lanes: this.sim.gates.length,
      checking: this.sim.kpi.pendingChecks,
    });
  }

  _renderHeatmap() {
    for (let i = 0; i < this._heatCells.length; i++) {
      const g = this.sim.gates[i];
      const c = this._heatCells[i];
      const ql = g.queueLength;
      const heat = ql <= 3 ? "#22c55e" : ql <= 6 ? "#f5b301" : ql <= 9 ? "#f97316" : "#ef4444";
      c.fill.style.height = Math.min(100, (ql / 13) * 100) + "%";
      c.fill.style.background = heat;
      c.label.textContent = g.id;
    }
  }

  _renderBottleneck() {
    const rows = this.sim.bottlenecks(4);
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

  _renderCurrentCheck() {
    const ac = this.sim.activeCheck();
    if (!ac) {
      this.el.cwc.innerHTML = `<p class="empty">${t("empty.waitingForCard", "Waiting for a card to be presented…")}</p>`;
      return;
    }
    const w = ac.worker, g = ac.gate;
    const elapsed = w.checkElapsed || 0;
    const cls = elapsed >= 7 ? "elapsed-crit" : elapsed >= 2.5 ? "elapsed-slow" : "";
    const decided = w.check && w.checkElapsed >= (w.check.duration || Infinity);
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
      `<div class="cwc-row"><span class="k">${t("cwc.previousMovement", "Previous Movement")}</span><span class="v">${lastMove}</span></div>` +
      `<div class="cwc-row"><span class="k">${t("cwc.decision", "Decision")}</span><span class="v">${decision}</span></div>`;
  }

  _renderPipeline() {
    const ac = this.sim.activeCheck();
    const findStep = this.el.pipeline.querySelector('[data-step="find"]');
    const openStep = this.el.pipeline.querySelector('[data-step="open"]');
    const elapsed = ac ? (ac.worker.checkElapsed || 0) : 0;
    this.el.pipeFindTime.textContent = elapsed.toFixed(1) + "s";
    const flag = findStep.querySelector(".ps-flag");
    if (this.sim.mode === "quentra") {
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
    const opening = this.sim.gates.some((g) => g.state === GATE_STATE.OPENING || g.state === GATE_STATE.PASSING);
    openStep.classList.toggle("is-ok", opening);
    openStep.querySelector(".ps-time").textContent = opening ? "0.4s" : "—";
  }

  _renderRewrite() {
    const s = this.sim.compareStats();
    const e = this.el;
    const maxAvg = Math.max(s.bAvg, s.qAvg, 0.01);
    e.rwBaseAvg.textContent = s.b.n ? s.bAvg.toFixed(2) + "s" : "—";
    e.rwQnAvg.textContent = s.q.n ? s.qAvg.toFixed(2) + "s" : "—";
    e.rwBaseBar.style.width = (s.b.n ? (s.bAvg / maxAvg) * 100 : 0) + "%";
    e.rwQnBar.style.width = (s.q.n ? (s.qAvg / maxAvg) * 100 : 0) + "%";
    e.rwBaseMeta.textContent = fmt(t("rewrite.checksDetail", "{n} checks · {slow} slow · {timeouts} timeout"),
      { n: s.b.n, slow: s.b.slow, timeouts: s.b.timeouts });
    e.rwQnMeta.textContent = fmt(t("rewrite.checksDetail", "{n} checks · {slow} slow · {timeouts} timeout"),
      { n: s.q.n, slow: s.q.slow, timeouts: s.q.timeouts });
    if (s.b.n && s.q.n && s.qAvg > 0) {
      const factor = s.bAvg / s.qAvg;
      e.rwImprove.textContent = fmt(t("rewrite.xFaster", "{n}× faster"),
        { n: factor >= 10 ? factor.toFixed(0) : factor.toFixed(1) });
    } else {
      e.rwImprove.textContent = t("rewrite.compareHint", "Run both modes to compare");
    }
  }

  _renderShift(k) {
    const pct = Math.min(100, (k.successfulEntries / SHIFT_TARGET) * 100);
    this.el.shiftBar.style.width = pct + "%";
    this.el.shiftPct.textContent = Math.round(pct) + "%";
    this.el.shiftEntered.textContent = fmt(t("shift.entered", "{n} entered"), { n: k.successfulEntries });
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
    const feed = this.sim.events.feed;
    const top = feed.length ? feed[0].id : -1;
    if (top === this._lastEventSeq) return;
    this._lastEventSeq = top;
    this.el.feed.innerHTML = feed.map((ev) =>
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
    const g = this.sim.selectedGate;
    const w = this.sim.selectedWorker;
    if (!g && !w) { this.el.selectedPanel.hidden = true; return; }
    this.el.selectedPanel.hidden = false;
    if (g) {
      this.el.selTitle.textContent = fmt(t("detail.turnstileTitle", "Turnstile {label}"), { label: g.label });
      const cw = g.currentWorker;
      const rows = [
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
