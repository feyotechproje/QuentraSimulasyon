// main.js
// Entry point: wires the simulation, renderer, engine and dashboard together
// and starts the animation loop. No backend, no network — everything runs in
// the browser from in-memory demo data.

import { Simulation } from "./simulation.js";
import { Renderer } from "./renderer.js";
import { Engine } from "./engine.js";
import { UI } from "./ui.js";
import { initQuentraApp } from "/shared/quentra-i18n.js";
import { FACTORY_TURNSTILE_INTRO, FACTORY_TURNSTILE_DICT } from "./i18n.js";
import { initAccessLive } from "/shared/access-live.js";

function boot() {
  const canvas = document.getElementById("scene");

  const sim = new Simulation();
  const renderer = new Renderer(canvas);
  const engine = new Engine(sim, renderer);
  const ui = new UI(sim, renderer, engine);

  // Route throttled DOM updates through the UI layer.
  engine.onFrame = (dt) => ui.tick(dt);

  engine.start();

  // Expose for quick debugging in the console (harmless, demo only).
  window.__factory = { sim, renderer, engine, ui };
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
