// main.js — bootstrap: wires data source → simulation → renderer/UI → engine.

import { InMemoryReportCacheDataSource } from "./datasource.js";
import { buildWorld } from "./world.js";
import { Simulation } from "./simulation.js";
import { Renderer } from "./renderer.js";
import { UI } from "./ui.js";
import { Engine } from "./engine.js";
import { ReportCacheBackend } from "./backend.js";
import { initQuentraApp, QuentraI18n } from "/shared/quentra-i18n.js";
import { REPORTCACHE_INTRO, REPORTCACHE_DICT } from "./i18n.js";

function boot() {
  const ds = new InMemoryReportCacheDataSource();
  const world = buildWorld();
  const renderer = new Renderer(document.getElementById("stage"));
  let ui;                                   // set after sim (UI needs sim ref)
  const sim = new Simulation(world, ds, evt => ui && ui.pushFeed(evt));
  ui = new UI(sim);
  const backend = new ReportCacheBackend(sim);
  ui.backend = backend;
  const engine = new Engine(sim, renderer, ui);

  // ---- resize ----
  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(document.getElementById("stage"));
  window.addEventListener("resize", () => renderer.resize());

  // ---- canvas hit-testing ----
  const canvas = document.getElementById("stage");
  canvas.style.cursor = "pointer";
  canvas.addEventListener("click", e => {
    const r = canvas.getBoundingClientRect();
    const w = renderer.screenToWorld(e.clientX - r.left, e.clientY - r.top);
    const n = world.nodes;
    const inside = (rect) => w.x>=rect.x && w.x<=rect.x+rect.w && w.y>=rect.y && w.y<=rect.y+rect.h;
    if (inside(n.gateway)) return sim.select("gateway");
    if (inside(n.cache))   return sim.select("cache");
    if (inside(n.sql))     return sim.select("sql");
    for (const loc of world.locations) if (inside(loc.tile)) return sim.select(loc.id);
    sim.select(null);
  });

  // ---- controls ----
  const $ = id => document.getElementById(id);
  const modeBtns = { baseline:$("btnBaseline"), cache:$("btnCache"), auto:$("btnAuto") };
  function syncModeButtons() {
    modeBtns.baseline.classList.toggle("is-active", !sim.auto && sim.mode === "baseline");
    modeBtns.cache.classList.toggle("is-active", !sim.auto && sim.mode === "cache");
    modeBtns.auto.classList.toggle("is-active", sim.auto);
  }
  modeBtns.baseline.addEventListener("click", () => { sim.setMode("baseline"); syncModeButtons(); });
  modeBtns.cache.addEventListener("click", () => { sim.setMode("cache"); syncModeButtons(); });
  modeBtns.auto.addEventListener("click", () => {
    // Auto-demo drives the scripted narrative, which only makes sense off-line.
    if (backend.live) { backend.setLive(false); syncSrcButtons(); }
    sim.setAuto(); syncModeButtons();
  });

  // ---- demo vs live data source ----
  const srcBtns = { demo: $("btnDemo"), live: $("btnLive") };
  function syncSrcButtons() {
    srcBtns.demo.classList.toggle("is-active", !backend.live);
    srcBtns.live.classList.toggle("is-active", backend.live);
    $("liveStrip").hidden = !backend.live;
  }
  srcBtns.demo.addEventListener("click", async () => {
    await backend.setLive(false);
    syncSrcButtons();
  });
  srcBtns.live.addEventListener("click", async () => {
    // Auto-demo cycles modes every few seconds; against a real server that
    // would thrash the connection, so live mode pins an explicit mode.
    if (sim.auto) { sim.setMode("baseline"); syncModeButtons(); }
    await backend.resetStats();
    await backend.setLive(true);
    syncSrcButtons();
  });

  $("btnPause").addEventListener("click", () => sim.pause());
  $("btnResume").addEventListener("click", () => sim.resume());
  $("btnStop").addEventListener("click", () => {
    sim.stop();
    $("statusPill").dataset.state = "stopped";
    $("statusLabel").textContent = QuentraI18n.t("st.stopped", "STOPPED");
  });
  $("btnReset").addEventListener("click", () => {
    sim.reset(); sim.setAuto(); syncModeButtons();
    if (backend.live) { backend.setLive(false); syncSrcButtons(); }
  });

  // Stop the real workload when the page goes away, so a closed tab never
  // leaves the heavy report running against SQL Server.
  window.addEventListener("pagehide", () => {
    if (!backend.live) return;
    const body = JSON.stringify({ mode: "baseline", live: false });
    navigator.sendBeacon?.("/api/reportcache/mode", new Blob([body], { type: "application/json" }));
  });

  document.querySelectorAll(".speed-btn").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".speed-btn").forEach(x => x.classList.remove("is-active"));
      b.classList.add("is-active");
      engine.setSpeed(parseFloat(b.dataset.speed));
    });
  });

  window.addEventListener("quentra:langchange", () => {
    if (!sim.running) {
      $("statusLabel").textContent = QuentraI18n.t("st.stopped", "STOPPED");
    }
  });

  // keep mode buttons synced with auto-demo transitions
  setInterval(syncModeButtons, 300);
  syncModeButtons();

  // ---- go ----
  renderer.resize();
  engine.start();
}

initQuentraApp({
  appId: "report-cache",
  accent: "#7c3aed",
  accent2: "#14b8a6",
  brand: { name: "Quentra Report Cache", sub: "Distributed Report Cache Simulation", logo: "/assets/quentra-logo.jpeg" },
  intro: REPORTCACHE_INTRO,
  dict: REPORTCACHE_DICT,
  onReady: () => boot(),
});
