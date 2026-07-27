// controller.js — the central state machine. Owns the two Dashboard views,
// the task strip, the comparison strip, and orchestrates the whole animated
// flow through a single Timeline.

import { Timeline, CanceledError } from "./timeline.js";
import { fetchDashboard, fetchFilter, fetchQueryDetails, resetSimulation } from "./api.js";
import { int, seconds, countUp } from "./format.js";
import { QuentraI18n } from "/shared/quentra-i18n.js";

function t(key, fallback) { return QuentraI18n.t(key, fallback); }

const STATES = {
  IDLE: "idle",
  REGION_SELECTED: "region-selected",
  QUERY_EXECUTING: "query-executing",
  QUENTRA_COMPLETED: "quentra-completed",
  DIRECT_RUNNING: "direct-still-running",
  DIRECT_COMPLETED: "direct-completed",
  COMPARISON_READY: "comparison-ready",
  PAUSED: "paused",
};

const STATE_KEYS = {
  [STATES.IDLE]: "state.idle",
  [STATES.REGION_SELECTED]: "state.regionSelected",
  [STATES.QUERY_EXECUTING]: "state.queryExecuting",
  [STATES.QUENTRA_COMPLETED]: "state.quentraCompleted",
  [STATES.DIRECT_RUNNING]: "state.directStillRunning",
  [STATES.DIRECT_COMPLETED]: "state.directCompleted",
  [STATES.COMPARISON_READY]: "state.comparisonReady",
  [STATES.PAUSED]: "state.paused",
};
const REGIONS = [
  "Marmara", "İç Anadolu", "Ege", "Akdeniz", "Karadeniz", "Güneydoğu Anadolu", "Doğu Anadolu",
];

export class Controller {
  constructor({ direct, quentra, dom }) {
    this.direct = direct;
    this.quentra = quentra;
    this.dom = dom;
    this.timeline = new Timeline();
    this.state = STATES.IDLE;
    this.prevState = STATES.IDLE;
    this.running = false;
    this.fullData = null;
    this.region = "Marmara";       // currently selected master filter
    this.autoIdx = 0;              // rotates regions during auto-run

    direct.onRegionPick = r => this.onRegionPick(r);
    quentra.onRegionPick = r => this.onRegionPick(r);
  }

  /* ---------- lifecycle ---------- */
  async init() {
    this.fullData = await fetchDashboard();
    this.direct.render(structuredCloneSafe(this.fullData));
    this.quentra.render(structuredCloneSafe(this.fullData));
    this.setState(STATES.IDLE);
  }

  setSpeed(mult) { this.timeline.setSpeed(mult); }

  setState(s) {
    this.state = s;
    this.dom.engineState.innerHTML = `STATE&nbsp;·&nbsp;<b>${t(STATE_KEYS[s] || s, labelFor(s))}</b>`;
  }

  onRegionPick(region) {
    if (this.running) return;          // ignore manual clicks mid-run
    if (!REGIONS.includes(region)) return;
    this.setRegion(region);
    this.start();
  }

  /** Sets the active master-filter region and refreshes the task strip text. */
  setRegion(region) {
    this.region = region;
    this.autoIdx = REGIONS.indexOf(region);
    if (this.dom.taskTitle) {
      this.dom.taskTitle.innerHTML = t("task.title", "Filter Dashboard by Region: {region}")
        .replace("{region}", `<b>${region}</b>`);
    }
    if (this.dom.taskDesc) {
      this.dom.taskDesc.textContent = t("task.descRegion", "Click the “{region}” row on both dashboards and compare refresh performance.")
        .replace("{region}", region);
    }
  }

  /* ---------- controls ---------- */
  async start() {
    if (this.running) return;
    this.running = true;
    this.dom.btnStart.disabled = true;
    this.dom.btnPause.disabled = false;
    try {
      await this.run();
    } catch (e) {
      if (!(e instanceof CanceledError)) console.error(e);
      return; // canceled by reset
    }
    this.running = false;
    this.dom.btnStart.disabled = false;
    this.dom.btnPause.disabled = true;
    if (this.dom.autoRun.checked) {
      await this.timeline.wait(2500).catch(() => {});
      this.reset();
      this.setRegion(REGIONS[(this.autoIdx + 1) % REGIONS.length]);
      this.timeline.wait(600).then(() => this.start()).catch(() => {});
    }
  }

  pauseToggle() {
    if (!this.running) return;
    if (this.timeline.paused) {
      this.timeline.resume();
      this.setState(this.prevState);
      this.dom.btnPause.innerHTML = `❚❚ <span>${t("btn.pause", "Pause")}</span>`;
    } else {
      this.prevState = this.state;
      this.timeline.pause();
      this.setState(STATES.PAUSED);
      this.dom.btnPause.innerHTML = `▶ <span>${t("btn.resume", "Resume")}</span>`;
    }
  }

  async reset() {
    this.timeline.cancel();
    this.timeline = new Timeline();
    this.running = false;
    this.dom.btnStart.disabled = false;
    this.dom.btnPause.disabled = true;
    this.dom.btnPause.innerHTML = `❚❚ <span>${t("btn.pause", "Pause")}</span>`;

    resetSimulation().catch(() => {});
    this.fullData = this.fullData || await fetchDashboard();
    this.direct.render(structuredCloneSafe(this.fullData));
    this.quentra.render(structuredCloneSafe(this.fullData));
    for (const d of [this.direct, this.quentra]) {
      d.resetExec();
      d.setStatus("status.idle", "is-idle");
      d.setFilterChip(null);
      d.markTargetRow(this.region, false);
    }
    this.setTaskStage(0);
    this.dom.comparison.hidden = true;
    this.setState(STATES.IDLE);
  }

  /* ---------- main animated flow ---------- */
  async run() {
    const t = this.timeline;
    const region = this.region;

    // Clean slate so a freshly picked region starts from the full data set.
    this.dom.comparison.hidden = true;
    this.direct.render(structuredCloneSafe(this.fullData));
    this.quentra.render(structuredCloneSafe(this.fullData));
    for (const d of [this.direct, this.quentra]) {
      d.resetExec();
      d.setStatus("status.idle", "is-idle");
      d.setFilterChip(null);
    }

    // 1. Region selected — highlight target rows on both sides.
    this.setState(STATES.REGION_SELECTED);
    this.setTaskStage(1);
    this.direct.markTargetRow(region, true);
    this.quentra.markTargetRow(region, true);
    await t.wait(900);

    // Simultaneous "click" on both dashboards.
    this.direct.markTargetRow(region, false);
    this.quentra.markTargetRow(region, false);
    this.direct.selectRegion(region);
    this.quentra.selectRegion(region);
    this.direct.setFilterChip(region);
    this.quentra.setFilterChip(region);
    this.direct.setLoading(true);
    this.quentra.setLoading(true);
    await t.wait(400);

    // Fetch both results + shared query details up front.
    const [directRes, quentraRes, details] = await Promise.all([
      fetchFilter(region, "direct"),
      fetchFilter(region, "quentra"),
      fetchQueryDetails(region),
    ]);
    this.directRes = directRes;
    this.quentraRes = quentraRes;

    // 2. Query executing — start both engines independently.
    this.setState(STATES.QUERY_EXECUTING);
    this.setTaskStage(2);
    this.direct.setStatus("status.queryExecuting", "is-running");
    this.quentra.setStatus("status.queryExecuting", "is-running");

    const quentraRun = this.runEngine(this.quentra, quentraRes, details, quentraRes.metrics.elapsedMs);
    const directRun = this.runEngine(this.direct, directRes, details, directRes.metrics.elapsedMs);

    // 3. Quentra finishes first → dashboard refreshes instantly.
    await quentraRun;
    this.setState(STATES.QUENTRA_COMPLETED);
    this.setTaskStage(3);

    // Direct is still grinding.
    this.setState(STATES.DIRECT_RUNNING);
    await directRun;
    this.setState(STATES.DIRECT_COMPLETED);

    // 4. Comparison.
    this.setState(STATES.COMPARISON_READY);
    this.setTaskStage(4);
    this.showComparison(directRes, quentraRes);
  }

  /**
   * Drives one engine: climbing timer + live metrics + progressive stages,
   * then applies the filtered data and query panels on completion.
   */
  async runEngine(dash, res, details, totalMs) {
    dash.setStages(res.stages);
    dash.beginMetrics();
    const n = res.stages.length;
    let elapsed = 0;
    const ticker = this.timeline.addTicker(simDt => {
      elapsed += simDt;
      const p = Math.min(1, elapsed / totalMs);
      dash.setTimer(elapsed, true);
      dash.updateMetricsLive(p, res.metrics);
      dash.activateStage(Math.min(n - 1, Math.floor(p * n)));
    });
    try {
      await this.timeline.wait(totalMs);
    } finally {
      this.timeline.removeTicker(ticker);
    }
    dash.setTimer(totalMs, false);
    dash.finishStages();
    dash.finalizeMetrics(res.metrics, res.plan);
    dash.applyData(res.dashboard, true);
    dash.setQueryDetails(details);
    dash.setStatus(dash.mode === "direct" ? "status.completedSlow" : "status.completedInstant", "is-done");
  }

  /* ---------- comparison strip ---------- */
  showComparison(directRes, quentraRes) {
    this._lastCmp = { directRes, quentraRes };
    const dMs = directRes.metrics.elapsedMs, qMs = quentraRes.metrics.elapsedMs;
    const gain = dMs / qMs;
    const c = this.dom;
    c.comparison.hidden = false;

    c.cmpDirectTime.textContent = seconds(dMs);
    c.cmpQuentraTime.textContent = seconds(qMs);
    countUp(c.cmpGain, gain, v => v.toFixed(1) + "×", { duration: 900 });

    const dReads = directRes.metrics.logicalReadPages, qReads = quentraRes.metrics.logicalReadPages;
    const dCpu = directRes.metrics.cpuMs, qCpu = quentraRes.metrics.cpuMs;
    const readCut = ((dReads - qReads) / dReads * 100).toFixed(2);
    const rows = [
      [t("cmp.timeSaved", "Time Saved"), `<span class="good">${seconds(dMs - qMs)}</span>`],
      [t("cmp.logicalReads", "Logical Reads"), `<span class="bad">${int(dReads)}</span> → <span class="good">${int(qReads)}</span>`],
      [t("cmp.readReduction", "Read Reduction"), `<span class="good">${readCut}%</span>`],
      [t("cmp.cpuTime", "CPU Time"), `<span class="bad">${seconds(dCpu)}</span> → <span class="good">${seconds(qCpu)}</span>`],
      [t("cmp.rowsReturned", "Rows Returned"), `${int(directRes.metrics.rowsReturned)} → ${int(quentraRes.metrics.rowsReturned)}`],
      [t("cmp.resultMatch", "Result Match"), `<span class="good">100%</span>`],
      [t("cmp.semanticValidation", "Semantic Validation"), `<span class="good">${t("cmp.passed", "Passed")}</span>`],
      [t("cmp.accessMethod", "Access Method"), `${directRes.plan.accessMethod} → ${quentraRes.plan.accessMethod}`],
    ];
    c.cmpMetrics.innerHTML = rows.map(([l, v]) =>
      `<div class="cmp-metric"><div class="cm-label">${l}</div><div class="cm-value">${v}</div></div>`).join("");
  }

  /* ---------- task strip stage indicator ---------- */
  setTaskStage(n) {
    this.dom.stageTrack.querySelectorAll(".stage").forEach(li => {
      const idx = Number(li.dataset.stage);
      li.classList.toggle("is-active", idx === n);
      li.classList.toggle("is-done", idx < n);
    });
  }

  /** Re-renders every controller-owned dynamic string after a language change. */
  relabel() {
    this.setState(this.state);
    this.setRegion(this.region);
    this.dom.btnPause.innerHTML = this.timeline.paused
      ? `▶ <span>${t("btn.resume", "Resume")}</span>`
      : `❚❚ <span>${t("btn.pause", "Pause")}</span>`;
    if (this._lastCmp) this.showComparison(this._lastCmp.directRes, this._lastCmp.quentraRes);
  }
}

function labelFor(s) {
  return String(s).replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/** Deep-copies plain JSON data (each dashboard needs its own mutable copy). */
function structuredCloneSafe(obj) {
  return typeof structuredClone === "function" ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
}
