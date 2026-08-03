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
import { initQuentraApp } from "/shared/quentra-i18n.js";
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
