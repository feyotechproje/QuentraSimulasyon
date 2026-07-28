// main.js
// Bootstrap for the retail checkout simulation. Two run modes share one canvas:
//
//   DEMO — a self-contained in-browser simulation (no DB, no queries). Scan
//          cadence is driven by the scenario so the direct-connection queue
//          visibly piles up and drains once the same query uses Quentra.
//   LIVE — the Go engine uses QUENTRA_RETAIL for transactions, products and
//          stock reads. Snapshots stream over SSE and every scan runs real SQL.
//
// Switching modes swaps the simulation object under the renderer/UI; both
// implement the same surface (update/kpis/money/registers/customers/world).

import { BackendClient, ApiSimulation } from "./backend.js";
import { Simulation } from "./simulation.js";
import { InMemoryDemoDataSource } from "./datasource.js";
import { ScenarioController, RUN_MODE } from "./scenario.js";
import { Renderer } from "./renderer.js";
import { UI } from "./ui.js";
import { Engine } from "./engine.js";
import { initQuentraApp } from "/shared/quentra-i18n.js";
import { RETAIL_INTRO, RETAIL_DICT } from "./i18n.js";

const RUNNING_STATES = ["RUNNING", "PAUSED", "PREPARING", "STOPPING"];
const LIVE_REGISTER_COUNT = 10;

// Enough shoppers queued that the floor reads as busy on the first frame.
const SEED_TARGET_WAITING = 60;
const SEED_MAX_WAIT_MS = 6000;

/**
 * Poll /api/state until the engine has queued a reasonable crowd, so switching
 * to live mode shows a busy store rather than an empty floor that fills in.
 * Returns the freshest state payload; gives up (returning what it has) once
 * SEED_MAX_WAIT_MS elapses so a stalled backend cannot block the switch.
 */
async function waitForQueues(client, initial) {
  let st = initial;
  const deadline = Date.now() + SEED_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      st = await client.getState();
    } catch {
      break;                       // backend went away; use what we have
    }
    const waiting = st.snapshot && st.snapshot.metrics ? st.snapshot.metrics.waiting || 0 : 0;
    if (waiting >= SEED_TARGET_WAITING) break;
  }
  return st;
}

async function boot() {
  const canvas = document.getElementById("scene");
  const client = new BackendClient("");

  const renderer = new Renderer(canvas);
  const ui = new UI();

  // Demo simulation is always constructed: it is the default view and needs no
  // backend, so the page is useful even when SQL Server is unreachable.
  const scenario = new ScenarioController(client, () => ui.renderScenario());
  const demoSim = new Simulation(new InMemoryDemoDataSource(7), scenario);

  let liveSim = null;                 // built lazily on first switch to live
  let registerCount = LIVE_REGISTER_COUNT;
  let backendOK = false;

  const engine = new Engine(demoSim, renderer, ui);

  // ---- live-mode plumbing -------------------------------------------------
  async function ensureLive() {
    if (liveSim) return liveSim;
    let firstSnap = null;
    try {
      let st = await client.getState();
      const settings = st.settings || {};
      const snapRegs = st.snapshot && st.snapshot.registers ? st.snapshot.registers.length : 0;
      registerCount = snapRegs || settings.registerCount || LIVE_REGISTER_COUNT;

      if (!RUNNING_STATES.includes(st.state)) {
        // Keep live and demo geometry identical. A larger live-only register
        // count made the same floor shrink abruptly when the mode changed.
        const cfg = Object.assign({}, settings, { registerCount: LIVE_REGISTER_COUNT, totalCustomers: 500, speed: 1 });
        await client.configure(cfg);
        registerCount = LIVE_REGISTER_COUNT;
        await client.start();
        // Wait until the engine has actually built up queues before painting.
        // A fixed delay is unreliable: the generator ramps up, so poll for a
        // populated floor (with a ceiling so a stalled backend cannot hang us).
        st = await waitForQueues(client, st);
        if (st.snapshot && st.snapshot.registers) {
          registerCount = st.snapshot.registers.length || registerCount;
        }
      }
      firstSnap = st.snapshot || null;
      backendOK = true;
    } catch (e) {
      console.warn("Backend not reachable; staying in demo mode.", e);
      backendOK = false;
      return null;
    }
    liveSim = new ApiSimulation(registerCount);
    // Seed from the snapshot we already have instead of waiting for the first
    // SSE frame: switching to live should show a populated store immediately,
    // not an empty floor that fills in a moment later.
    if (firstSnap) liveSim.applySnapshot(firstSnap);
    client.connect((snap) => {
      scenario.applySnapshot(snap);
      if (liveSim) liveSim.applySnapshot(snap);
      if (scenario.runMode === RUN_MODE.LIVE) ui.renderScenario();
    });
    return liveSim;
  }

  // Swap the active simulation whenever the run mode changes.
  const baseSetRunMode = scenario.setRunMode.bind(scenario);
  scenario.setRunMode = async (mode) => {
    await baseSetRunMode(mode);
    if (mode === RUN_MODE.LIVE) {
      const sim = await ensureLive();
      if (!sim) {
        // Backend unavailable — fall back rather than showing a dead canvas.
        await baseSetRunMode(RUN_MODE.DEMO);
        engine.sim = demoSim;
      } else {
        engine.sim = sim;
      }
    } else {
      engine.sim = demoSim;
    }
    renderer.resize(engine.sim.world);
    ui.renderScenario();
  };

  // ---- toolbar controls ---------------------------------------------------
  // In live mode these drive the authoritative Go engine; in demo mode they
  // drive the local rAF engine.
  const controls = {
    pause: () => (scenario.isDemo ? engine.pause() : client.pause()),
    resume: () => (scenario.isDemo ? engine.resume() : client.resume()),
    stop: () => (scenario.isDemo ? engine.stop() : client.stop()),
    reset: async () => {
      if (scenario.isDemo) { engine.reset(); return; }
      await client.reset();
      await client.start();
    },
    setSpeed: async (v) => {
      engine.setSpeed(v);                     // demo speed is local
      if (scenario.isDemo || !backendOK) return;
      const s = await client.getSettings();
      if (s) { s.speed = v; await client.configure(s); }
    },
  };

  ui.bind(engine, controls);
  ui.bindScenario(scenario);

  // Pull the grounded SQL text (falls back to the built-in strings offline).
  scenario.loadSQL();

  canvas.addEventListener("click", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const sim = engine.sim;
    const id = renderer.pickRegister(ev.clientX - rect.left, ev.clientY - rect.top, sim);
    if (id) ui.selectRegister(sim, id);
  });
  canvas.addEventListener("mousemove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const id = renderer.pickRegister(ev.clientX - rect.left, ev.clientY - rect.top, engine.sim);
    canvas.style.cursor = id ? "pointer" : "default";
  });

  let resizeRaf = null;
  window.addEventListener("resize", () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => renderer.resize(engine.sim.world));
  });

  engine.start();
}

initQuentraApp({
  appId: "retail",
  accent: "#7c3aed",
  accent2: "#22d3ee",
  brand: { name: "Quentra Retail", sub: "Checkout Simulation", logo: "/assets/quentra-logo.jpeg" },
  intro: RETAIL_INTRO,
  dict: RETAIL_DICT,
  onReady: () => boot(),
});
