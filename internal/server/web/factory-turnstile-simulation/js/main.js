// main.js
// Entry point: wires the DUAL simulation (baseline bank on the left canvas,
// Quentra bank on the right, shared panels between them), the renderers, the
// frame engine and the dashboard together. No backend, no network — everything
// runs in the browser from in-memory demo data; the separate live card at the
// bottom talks to the real database.

import { Simulation } from "./simulation.js";
import { Renderer } from "./renderer.js";
import { Engine } from "./engine.js";
import { UI } from "./ui.js";
import { BANK_GATE_COUNT } from "./world.js";
import { initQuentraApp, QuentraI18n } from "/shared/quentra-i18n.js";
import { StoryTour } from "/shared/story-tour.js";
import { FACTORY_TURNSTILE_INTRO, FACTORY_TURNSTILE_DICT } from "./i18n.js";
import { initAccessLive } from "/shared/access-live.js";

function boot() {
  const canvasBase = document.getElementById("sceneBaseline");
  const canvasQn = document.getElementById("sceneQuentra");

  // Left bank: the slow baseline query on every card check. Right bank: the
  // SAME check through the Quentra rewrite. Both run simultaneously, so the
  // queue difference on screen is purely the query profile.
  const simBase = new Simulation({ gateCount: BANK_GATE_COUNT, idOffset: 0, mode: "baseline" });
  const simQn = new Simulation({ gateCount: BANK_GATE_COUNT, idOffset: BANK_GATE_COUNT, mode: "quentra" });

  const renBase = new Renderer(canvasBase, { world: simBase.world, banner: "BASELINE  ·  SLOW QUERY" });
  const renQn = new Renderer(canvasQn, { world: simQn.world, banner: "QUENTRA  ·  REWRITTEN" });

  const engine = new Engine([
    { sim: simBase, renderer: renBase },
    { sim: simQn, renderer: renQn },
  ]);
  const ui = new UI(engine);

  // Route throttled DOM updates through the UI layer.
  engine.onFrame = (dt) => ui.tick(dt);

  // The canvases are sized by the grid AFTER boot (intro overlay, font load,
  // panel layout) — re-fit the camera whenever their box actually changes so
  // the floors never render letterboxed into a stale rectangle.
  const ro = new ResizeObserver(() => {
    for (const v of engine.views) v.renderer.resize();
  });
  ro.observe(canvasBase.parentElement);
  ro.observe(canvasQn.parentElement);

  engine.start();

  // ---- cinematic story mode ----------------------------------------------
  // Blurred scenario popup at boot, then a guided tour: wide shot → baseline
  // queue → pipeline (slow stage) → baseline SQL → Quentra rewrite (the diff)
  // → Quentra bank → KPI strip. The toolbar Story button replays it.
  const t = (k, fb) => QuentraI18n.t(k, fb);
  const tour = new StoryTour({
    root: ".app",
    steps: [
      { target: null,              key: "tour.s1" },
      { target: ".bank-baseline",  key: "tour.s2", zoom: 1.6 },
      { target: ".pipeline-panel", key: "tour.s3", zoom: 2.0 },
      { target: "#rwBefore",       key: "tour.s4", zoom: 2.2 },
      { target: "#rwAfter",        key: "tour.s5", zoom: 2.2 },
      { target: ".bank-quentra",   key: "tour.s6", zoom: 1.6 },
      { target: "#kpiStrip",       key: "tour.s7", zoom: 1.3 },
    ],
    translate: (step) => ({ title: t(step.key + ".t"), text: t(step.key + ".x") }),
    labels: () => ({ back: t("tour.back"), next: t("tour.next"), done: t("tour.done") }),
  });
  // The shift-start overlay covers (and blurs) both floors while the banks
  // are idle — the story must play over a RUNNING demo, so starting the tour
  // first starts the shift with the selected/default worker count.
  const startStory = () => {
    if (tour.active) return;
    const overlay = document.getElementById("shiftStart");
    if (overlay && !overlay.hidden) {
      const b = document.getElementById("btnShiftStart");
      if (b) b.click();
    }
    tour.start();
  };
  const btnStory = document.getElementById("btnStory");
  if (btnStory) btnStory.addEventListener("click", startStory);
  // When the story camera settles, re-render both floors at the zoomed
  // resolution (and back at 1x when the tour releases the camera).
  window.addEventListener("quentra:storycam", () => {
    for (const v of engine.views) v.renderer.resize();
  });

  // Scenario popup over the already-animating demo; the tour only takes over
  // if the presenter opts in.
  tour.intro(() => ({
    eyebrow: t("tour.intro.eyebrow"),
    title: t("tour.intro.title"),
    paragraphs: [t("tour.intro.p1"), t("tour.intro.p2"), t("tour.intro.p3")],
    start: t("tour.intro.start"),
    skip: t("tour.intro.skip"),
  })).then((go) => { if (go) startStory(); });

  // Expose for quick debugging in the console (harmless, demo only).
  window.__factory = { simBase, simQn, engine, ui };
}

initQuentraApp({
  appId: "factory-turnstile",
  accent: "#f5b301",
  accent2: "#3a4252",
  brand: { name: "Quentra Factory Access", sub: "Turnstile Control", logo: "/assets/quentra-logo.jpeg" },
  intro: FACTORY_TURNSTILE_INTRO,
  dict: FACTORY_TURNSTILE_DICT,
  onReady: () => { boot(); initAccessLive("factory-turnstile-simulation", "#6d5efc"); },
});
