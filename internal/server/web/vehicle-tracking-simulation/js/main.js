// main.js
// Entry point. Wires the simulation, renderer, engine and UI together, then
// starts the animation loop. No backend, no network — every vehicle, GPS packet,
// query and metric is in-memory demo state. Auto Demo starts automatically.

import { Simulation } from "./simulation.js";
import { Renderer } from "./renderer.js";
import { Engine } from "./engine.js";
import { UI } from "./ui.js";
import { VehicleBackend } from "./backend.js";
import { initQuentraApp } from "/shared/quentra-i18n.js";
import { FLEET_INTRO, FLEET_DICT } from "./i18n.js";

function boot() {
  const canvas = document.getElementById("scene");

  const sim = new Simulation();
  const renderer = new Renderer(canvas);
  const engine = new Engine(sim, renderer);
  const ui = new UI(sim, renderer, engine);

  // Live link to the real SQL Server workload (VEHICLEGPS · 100,000 vehicles).
  const backend = new VehicleBackend(sim);

  // Demo / Live switch. Live drives the real workload; demo stops it and lets
  // the visualisation run on simulated numbers.
  const btnDemo = document.getElementById("btnDemoRun");
  const btnLive = document.getElementById("btnLiveRun");
  const syncRunButtons = () => {
    if (btnDemo) btnDemo.classList.toggle("is-active", !backend.live);
    if (btnLive) btnLive.classList.toggle("is-active", backend.live);
  };
  if (btnDemo) btnDemo.addEventListener("click", () => { backend.setLive(false); syncRunButtons(); });
  if (btnLive) btnLive.addEventListener("click", () => { backend.setLive(true); syncRunButtons(); });
  syncRunButtons();

  engine.onFrame = () => ui.tick();

  engine.start();

  // Harmless debug handle (demo only).
  window.__fleet = { sim, renderer, engine, ui, backend };
}

initQuentraApp({
  appId: "vehicle-tracking",
  accent: "#2dd4bf",
  accent2: "#7c3aed",
  brand: { name: "Quentra Fleet", sub: "Vehicle Tracking Simulation", logo: "/assets/quentra-logo.png" },
  intro: FLEET_INTRO,
  dict: FLEET_DICT,
  onReady: () => boot(),
});
