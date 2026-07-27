// main.js — bootstraps the Quentra Dashboard Performance Lab page.

import { Dashboard } from "./dashboard.js";
import { Controller } from "./controller.js";
import { initQuentraApp, QuentraI18n } from "/shared/quentra-i18n.js";
import { DASHBOARD_INTRO, DASHBOARD_DICT } from "./i18n.js";

function $(id) { return document.getElementById(id); }

async function boot() {
  const t = (k, f) => QuentraI18n.t(k, f);
  const direct = new Dashboard($("directMount"), "direct", {
    title: t("dash.direct.title", "DIRECT CONNECTION"),
    subtitle: t("dash.direct.subtitle", "No Query Optimization"),
  });
  const quentra = new Dashboard($("quentraMount"), "quentra", {
    title: t("dash.quentra.title", "QUENTRA AI SQL GATEWAY"),
    subtitle: t("dash.quentra.subtitle", "Runtime Query Optimization"),
  });

  const dom = {
    engineState: $("engineState"),
    stageTrack: $("stageTrack"),
    taskTitle: $("taskTitle"),
    taskDesc: $("taskDesc"),
    btnStart: $("btnStart"),
    btnPause: $("btnPause"),
    autoRun: $("autoRun"),
    comparison: $("comparison"),
    cmpDirectTime: $("cmpDirectTime"),
    cmpQuentraTime: $("cmpQuentraTime"),
    cmpGain: $("cmpGain"),
    cmpMetrics: $("cmpMetrics"),
  };

  const controller = new Controller({ direct, quentra, dom });
  await controller.init();

  // Controls.
  dom.btnStart.addEventListener("click", () => controller.start());
  dom.btnPause.addEventListener("click", () => controller.pauseToggle());
  $("btnReset").addEventListener("click", () => controller.reset());

  $("speedButtons").addEventListener("click", e => {
    const btn = e.target.closest(".speed-btn");
    if (!btn) return;
    $("speedButtons").querySelectorAll(".speed-btn").forEach(b => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    controller.setSpeed(Number(btn.dataset.speed));
  });

  // Re-draw charts on resize so SVG scales cleanly without jumping.
  let rt = null;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      direct.applyData(direct.data, false);
      quentra.applyData(quentra.data, false);
    }, 180);
  });

  // Re-render every dynamic (JS-authored) string when the language changes:
  // dashboard column headers, chart legends/labels, region table, status
  // pills, exec metrics, query panels and the task strip text.
  window.addEventListener("quentra:langchange", () => {
    direct.meta.title = t("dash.direct.title", "DIRECT CONNECTION");
    direct.meta.subtitle = t("dash.direct.subtitle", "No Query Optimization");
    quentra.meta.title = t("dash.quentra.title", "QUENTRA AI SQL GATEWAY");
    quentra.meta.subtitle = t("dash.quentra.subtitle", "Runtime Query Optimization");
    direct.relabel();
    quentra.relabel();
    controller.relabel();
  });
}

function bootWithErrorHandling() {
  boot().catch(err => {
    console.error("Dashboard boot failed:", err);
    const t = (k, f) => (window.QuentraI18n ? window.QuentraI18n.t(k, f) : f);
    document.body.insertAdjacentHTML("afterbegin",
      `<div style="padding:16px;color:#e0453f;font-family:sans-serif">${t("error.bootFailed", "Failed to load dashboard: {message}").replace("{message}", err.message)}</div>`);
  });
}

initQuentraApp({
  appId: "dashboard-comparison",
  accent: "#6d3bd1",
  accent2: "#12b5b0",
  brand: { name: "Quentra Dashboard", sub: "Performance Lab", logo: "/assets/quentra-logo.png" },
  intro: DASHBOARD_INTRO,
  dict: DASHBOARD_DICT,
  onReady: () => bootWithErrorHandling(),
});
