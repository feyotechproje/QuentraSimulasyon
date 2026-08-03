// main.js
// Bootstrap for the retail checkout simulation. The store runs as TWO register
// banks side by side — direct connection on the left canvas, Quentra gateway on
// the right — with the shared detail panel between them. Two run modes:
//
//   DEMO — a self-contained in-browser simulation (no DB, no queries). The left
//          floor uses the slow fixed cadence, the right the fast one, so the
//          comparison plays out visually without a backend.
//   LIVE — the Go engine splits its registers into the same two banks and every
//          scan runs real SQL over that bank's connection. Switching to live
//          does NOT auto-start: the operator picks the customer count on the
//          start overlay first. Snapshots stream over SSE, split per bank.

import { BackendClient, ApiSimulation } from "./backend.js";
import { Simulation } from "./simulation.js";
import { InMemoryDemoDataSource } from "./datasource.js";
import { ScenarioController, RUN_MODE } from "./scenario.js";
import { Renderer } from "./renderer.js";
import { UI } from "./ui.js";
import { Engine, ENGINE_STATE } from "./engine.js";
import { initQuentraApp } from "/shared/quentra-i18n.js";
import { RETAIL_INTRO, RETAIL_DICT } from "./i18n.js";

const LIVE_REGISTER_COUNT = 10;               // 5 direct + 5 quentra
const BANK_SIZE = LIVE_REGISTER_COUNT / 2;

/**
 * Split a backend snapshot into the two bank views. Registers are numbered
 * 1..half (direct) and half+1..n (quentra) by the engine; completed sales
 * follow their register.
 */
function splitSnapshot(snap) {
  const regs = (snap && snap.registers) || [];
  const half = Math.ceil(regs.length / 2) || BANK_SIZE;
  const isLeft = (no) => no <= half;
  const left = Object.assign({}, snap, {
    registers: regs.filter((r) => isLeft(r.no)),
    completed: (snap.completed || []).filter((s) => isLeft(s.register)),
  });
  const right = Object.assign({}, snap, {
    registers: regs.filter((r) => !isLeft(r.no)),
    completed: (snap.completed || []).filter((s) => !isLeft(s.register)),
  });
  return { left, right };
}

async function boot() {
  const canvasDirect = document.getElementById("sceneDirect");
  const canvasQuentra = document.getElementById("sceneQuentra");
  const client = new BackendClient("");

  const rendererDirect = new Renderer(canvasDirect, {
    floorLabel: "DOĞRUDAN BAĞLANTI  ·  localhost",
    sections: ["PRODUCE", "BAKERY", "DAIRY", "MEAT"],
  });
  const rendererQuentra = new Renderer(canvasQuentra, {
    floorLabel: "QUENTRA GATEWAY  ·  :14330",
    sections: ["FROZEN", "PANTRY", "DRINKS", "HOME"],
  });
  const ui = new UI();

  // Demo simulations are always constructed: they are the default view and need
  // no backend, so the page is useful even when SQL Server is unreachable.
  const scenario = new ScenarioController(client, () => ui.renderScenario());
  const demoDirect = new Simulation(new InMemoryDemoDataSource(7), {
    registerCount: BANK_SIZE, idOffset: 0, conn: "direct",
  });
  const demoQuentra = new Simulation(new InMemoryDemoDataSource(11), {
    registerCount: BANK_SIZE, idOffset: BANK_SIZE, conn: "quentra",
  });

  let liveDirect = null;              // built lazily on first switch to live
  let liveQuentra = null;
  let backendOK = false;

  const engine = new Engine(
    [{ sim: demoDirect, renderer: rendererDirect }, { sim: demoQuentra, renderer: rendererQuentra }],
    ui,
  );
  // Story pacing is global (one narration for the whole store), so it ticks in
  // the frame loop rather than inside either bank's simulation.
  engine.onTick = (dt) => scenario.tick(dt);

  // ---- live-mode plumbing -------------------------------------------------
  // Attaches to the backend WITHOUT starting anything: builds the two bank
  // views, seeds them from the current state (the engine may already be
  // running) and subscribes to snapshots. Starting a fresh run is the start
  // overlay's job, so the operator picks the customer count first.
  async function ensureLive() {
    if (liveDirect && liveQuentra) return true;
    let st = null;
    try {
      st = await client.getState();
      backendOK = true;
    } catch (e) {
      console.warn("Backend not reachable; staying in demo mode.", e);
      backendOK = false;
      return false;
    }
    liveDirect = new ApiSimulation(BANK_SIZE, { idOffset: 0 });
    liveQuentra = new ApiSimulation(BANK_SIZE, { idOffset: BANK_SIZE });
    // Seed the lifecycle state (and any running floor) from the snapshot we
    // already have, so the overlay knows whether the engine is idle.
    liveDirect.simState = st.state || "IDLE";
    liveQuentra.simState = st.state || "IDLE";
    if (st.snapshot) {
      const { left, right } = splitSnapshot(st.snapshot);
      liveDirect.applySnapshot(left);
      liveQuentra.applySnapshot(right);
    }
    client.connect((snap) => {
      scenario.applySnapshot(snap);
      if (liveDirect && liveQuentra) {
        const { left, right } = splitSnapshot(snap);
        liveDirect.applySnapshot(left);
        liveQuentra.applySnapshot(right);
      }
      if (scenario.runMode === RUN_MODE.LIVE) ui.renderScenario();
    });
    return true;
  }

  // Swap both banks' simulations whenever the run mode changes. The local rAF
  // engine is forced back to RUNNING on every switch: it only animates visuals,
  // and a demo-side pause must never freeze the live floors (that was the
  // "buttons stop working" bug — pause/resume in live drive the BACKEND, so a
  // paused local engine had no unpause path).
  const baseSetRunMode = scenario.setRunMode.bind(scenario);
  scenario.setRunMode = async (mode) => {
    await baseSetRunMode(mode);
    if (mode === RUN_MODE.LIVE && (await ensureLive())) {
      engine.views[0].sim = liveDirect;
      engine.views[1].sim = liveQuentra;
    } else {
      if (mode === RUN_MODE.LIVE) await baseSetRunMode(RUN_MODE.DEMO);
      engine.views[0].sim = demoDirect;
      engine.views[1].sim = demoQuentra;
    }
    engine.state = ENGINE_STATE.RUNNING;
    rendererDirect.resize(engine.views[0].sim.world);
    rendererQuentra.resize(engine.views[1].sim.world);
    ui.syncControls(engine);
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
      // Live reset: stop first if active, then retry the reset briefly — the
      // engine rejects it until its workers finish winding down (STOPPING).
      // No auto-restart: the start overlay reappears for a fresh, sized run.
      await client.stop();
      for (let i = 0; i < 10; i++) {
        if (await client.reset()) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    },
    setSpeed: async (v) => {
      engine.setSpeed(v);                     // demo speed is local
      if (scenario.isDemo || !backendOK) return;
      const s = await client.getSettings();
      if (s) { s.speed = v; await client.configure(s); }
    },
    // Start a live run with the operator-chosen customer count. Registers are
    // always the two banks of five; the per-scan lookup is armed from scan one.
    startLive: async (customers) => {
      const n = Math.max(10, Math.min(5000, customers | 0 || 500));
      const settings = (await client.getSettings()) || {};
      const cfg = Object.assign({}, settings, {
        registerCount: LIVE_REGISTER_COUNT,
        totalCustomers: n,
        speed: engine.speed,
        stockLookup: true,
      });
      await client.configure(cfg);
      const started = await client.start();
      // Reflect the accepted start locally right away: the overlay must not
      // wait for the first SSE frame to hide (a lagging or dropped stream left
      // it covering a run that was already underway).
      if (started && liveDirect && liveQuentra) {
        liveDirect.simState = "PREPARING";
        liveQuentra.simState = "PREPARING";
      }
    },
  };

  ui.bind(engine, controls);
  ui.bindScenario(scenario);

  // Pull the grounded SQL text (falls back to the built-in strings offline).
  scenario.loadSQL();
  // In live mode, re-capture periodically: enabling/disabling a rewrite rule in
  // Quentra mid-run must show up on the panel without a page reload. The capture
  // query uses a no-match key, so the poll never evaluates the expensive UDF.
  setInterval(() => { if (!scenario.isDemo) scenario.loadSQL(); }, 10_000);

  // Click/hover selection, one handler pair per bank canvas.
  const wire = (canvas, renderer, viewIndex) => {
    canvas.addEventListener("click", (ev) => {
      const rect = canvas.getBoundingClientRect();
      const sim = engine.views[viewIndex].sim;
      const id = renderer.pickRegister(ev.clientX - rect.left, ev.clientY - rect.top, sim);
      if (id) ui.selectRegister(engine, sim, id);
    });
    canvas.addEventListener("mousemove", (ev) => {
      const rect = canvas.getBoundingClientRect();
      const sim = engine.views[viewIndex].sim;
      const id = renderer.pickRegister(ev.clientX - rect.left, ev.clientY - rect.top, sim);
      canvas.style.cursor = id ? "pointer" : "default";
    });
  };
  wire(canvasDirect, rendererDirect, 0);
  wire(canvasQuentra, rendererQuentra, 1);

  let resizeRaf = null;
  window.addEventListener("resize", () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      rendererDirect.resize(engine.views[0].sim.world);
      rendererQuentra.resize(engine.views[1].sim.world);
    });
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
