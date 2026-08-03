// main.js — bootstrap + control wiring for the Key Breaker simulation.
// Fully client-side visual demo. No backend, DB, API, or WebSocket is contacted.

import { Assets } from "./assets.js";
import { InMemoryKeyBreakerDataSource } from "./datasource.js";
import { Simulation } from "./simulation.js";
import { Renderer } from "./renderer.js";
import { UI } from "./ui.js";
import { Engine } from "./engine.js";
import { hitTest } from "./world.js";
import { MODE } from "./models.js";
import { initQuentraApp } from "/shared/quentra-i18n.js";
import { KEYBREAKER_INTRO, KEYBREAKER_DICT } from "./i18n.js";
import { initKeyBreakerLive } from "./live-data.js";

async function boot(livePanel) {
  await Assets.load();

  const ds = new InMemoryKeyBreakerDataSource();
  const sim = new Simulation(ds);
  sim.setMode(MODE.AUTO);
  const canvas = document.getElementById("scene");
  const renderer = new Renderer(canvas);
  const ui = new UI(sim, ds);
  const engine = new Engine(sim, renderer, ui);

  // ---- toggles (default on) ----
  sim.showPaths = true; sim.showSafe = true; sim.showThreat = true; sim.showParticles = true;
  bindToggle("tglPaths", (v) => sim.showPaths = v);
  bindToggle("tglSafe", (v) => sim.showSafe = v);
  bindToggle("tglThreat", (v) => sim.showThreat = v);
  bindToggle("tglParticles", (v) => sim.showParticles = v);

  // ---- mode buttons ----
  const modeBtns = {
    btnOff: { mode: MODE.OFF, cls: "is-off-active", backend: "baseline" },
    btnActive: { mode: MODE.ACTIVE, cls: "", backend: "quentra" },
    btnAuto: { mode: MODE.AUTO, cls: "is-auto-active", backend: "auto" },
  };
  const setActiveBtn = (activeId) => {
    Object.keys(modeBtns).forEach(id => {
      const b = document.getElementById(id);
      b.classList.toggle("is-active", id === activeId);
      Object.values(modeBtns).forEach(m => m.cls && b.classList.remove(m.cls));
      if (id === activeId && modeBtns[id].cls) b.classList.add(modeBtns[id].cls);
    });
  };
  Object.entries(modeBtns).forEach(([id, cfg]) => {
    document.getElementById(id).addEventListener("click", () => {
      sim.setMode(cfg.mode);
      setActiveBtn(id);
      // Flip the real backend shield to match the chosen visual mode.
      if (livePanel && livePanel.live) livePanel.live.setMode(cfg.backend);
    });
  });
  setActiveBtn("btnAuto");

  // ---- transport controls ----
  document.getElementById("btnPause").addEventListener("click", () => sim.pause());
  document.getElementById("btnResume").addEventListener("click", () => sim.resume());
  document.getElementById("btnReset").addEventListener("click", () => {
    const wasAuto = sim.autoDemo;
    sim.reset(wasAuto ? MODE.AUTO : sim.mode);
    if (wasAuto) sim.setMode(MODE.AUTO);
  });

  // ---- speed ----
  document.querySelectorAll(".speed-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".speed-btn").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      engine.setSpeed(parseFloat(btn.dataset.speed));
    });
  });

  // ---- canvas click hit-test ----
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const w = renderer.screenToWorld(e.clientX - r.left, e.clientY - r.top);
    const hit = hitTest(sim.world, w.x, w.y, sim);
    sim.select(hit);
  });
  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    const w = renderer.screenToWorld(e.clientX - r.left, e.clientY - r.top);
    canvas.style.cursor = hitTest(sim.world, w.x, w.y, sim) ? "pointer" : "default";
  });

  // ---- resize ----
  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => renderer.resize(), 120); });

  ui.update();
  engine.start();
  window._kb = { sim, renderer, engine }; // debug handle
}

function bindToggle(id, fn) {
  const el = document.getElementById(id);
  fn(el.checked);
  el.addEventListener("change", () => fn(el.checked));
}

initQuentraApp({
  appId: "key-breaker",
  accent: "#10b981",
  accent2: "#2dd4bf",
  brand: { name: "Quentra Key Breaker", sub: "SQL Injection Defense", logo: "/assets/quentra-logo.png" },
  intro: KEYBREAKER_INTRO,
  dict: KEYBREAKER_DICT,
  onReady: () => {
    // The single set of mode controls lives in the top toolbar; the live panel's
    // in-card mode buttons are removed, so wire the toolbar buttons to also flip
    // the real backend shield (baseline / quentra / auto).
    const live = initKeyBreakerLive();
    boot(live);
  },
});
