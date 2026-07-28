// main.js — Turnstile access-control simulation.
// Self-contained (no backend): workers stream in, queue at the shortest lane,
// wait, then pass through a rotating turnstile and walk out the far side.
// Reuses the retail floor's humanoid renderer + dark-neon theme.

import { drawPerson } from "../../retail-simulation/js/customer.js";
import { initQuentraApp } from "/shared/quentra-i18n.js";
import { TURNSTILE_INTRO, TURNSTILE_DICT } from "./i18n.js";
import { initAccessLive } from "/shared/access-live.js";

const t = (key, fallback) => (window.QuentraI18n ? window.QuentraI18n.t(key, fallback) : fallback);

// ------------------------------------------------------------------ config ---
const SQUASH = 0.60;
const GATE_COUNT = 5;

const cfg = {
  firstX: 150,
  spacing: 160,
  barrierY: 210,          // the turnstile line
  queueStartY: 272,       // first waiting slot (in front / below the gate)
  queueGap: 40,
  maxQueueDraw: 12,
  passSec: 0.55,          // turnstile rotation time per person
  gateCooldown: 0.30,     // dead time before the next person may pass
  spawnEvery: 0.55,       // base seconds between arrivals (scaled by speed)
  softCap: GATE_COUNT * 9, // stop spawning past this many total waiting
};

const bounds = {
  minX: cfg.firstX - 110,
  maxX: cfg.firstX + (GATE_COUNT - 1) * cfg.spacing + 110,
  minY: 70,
  maxY: cfg.queueStartY + cfg.maxQueueDraw * cfg.queueGap + 40,
};
bounds.width = bounds.maxX - bounds.minX;
bounds.height = bounds.maxY - bounds.minY;

// hi-vis worker palette
const VEST = ["#f97316", "#f59e0b", "#facc15", "#fb923c", "#eab308", "#f6a723"];
const SKIN = ["#f2c9a4", "#e8b48c", "#c88f66", "#a56a44", "#7c4a2d", "#f6d5b8"];
const HAIR = ["#2b2118", "#111318", "#6b4a2b", "#4a3423", "#9a9a9a"];
const pick = (a) => a[(Math.random() * a.length) | 0];

let _id = 1;
function makeWorker() {
  return {
    id: _id++,
    app: {
      skin: pick(SKIN),
      hair: pick(HAIR),
      hairStyle: Math.random() < 0.62 ? "cap" : pick(["short", "buzz", "bun"]),
      shirt: pick(VEST),
      pants: "#1f2937",
      heightScale: 0.97 + Math.random() * 0.08,
    },
    pos: { x: 0, y: 0 },
    wp: [], wpi: 0, moving: false, arrived: false, facing: "up",
    speed: 76 * (0.9 + Math.random() * 0.2),
    phase: Math.random() * Math.PI * 2,
    state: "APPROACH",     // APPROACH -> QUEUE -> PASSING
    gate: null, slot: -1, waitStart: 0,
  };
}

// ------------------------------------------------------------------- state ---
const sim = {
  time: 0, speed: 1, running: true, status: "running",
  gates: [], workers: [], selected: null,
  totalSpawned: 0, totalPassed: 0,
  waitAccum: 0, waitCount: 0,
  spawnTimer: 0, events: [],
};

function buildGates() {
  sim.gates = [];
  for (let i = 0; i < GATE_COUNT; i++) {
    sim.gates.push({
      id: i + 1,
      x: cfg.firstX + i * cfg.spacing,
      y: cfg.barrierY,
      queue: [], busy: false, spin: 0, cooldown: 0,
      passed: 0, highlighted: false,
    });
  }
}
buildGates();

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const queueSlot = (g, idx) => ({ x: g.x, y: cfg.queueStartY + idx * cfg.queueGap });

function setPath(w, pts) { w.wp = pts; w.wpi = 0; w.arrived = false; w.moving = pts.length > 0; }

function stepWorker(w, dt) {
  if (w.moving) w.phase += dt * w.speed * 0.18;
  if (w.wpi >= w.wp.length) { w.moving = false; return; }
  const t = w.wp[w.wpi];
  const dx = t.x - w.pos.x, dy = t.y - w.pos.y;
  const d = Math.hypot(dx, dy);
  const step = w.speed * dt;
  if (d <= step || d < 0.5) {
    w.pos.x = t.x; w.pos.y = t.y; w.wpi++;
    if (w.wpi >= w.wp.length) { w.moving = false; w.arrived = true; }
  } else {
    w.pos.x += (dx / d) * step; w.pos.y += (dy / d) * step; w.moving = true;
    w.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
  }
}

function reslot(g) {
  for (let i = 0; i < g.queue.length; i++) {
    const w = g.queue[i];
    w.slot = i;
    const s = queueSlot(g, i);
    if (dist(w.pos, s) > 1) setPath(w, [s]);
  }
}

function spawnWorker() {
  // pick the shortest lane
  let g = sim.gates[0];
  for (const c of sim.gates) if (c.queue.length < g.queue.length) g = c;
  const w = makeWorker();
  const idx = g.queue.length;
  const slot = queueSlot(g, idx);
  w.pos = { x: g.x + (Math.random() * 90 - 45), y: bounds.maxY + 22 };
  w.gate = g; w.slot = idx; w.state = "APPROACH";
  setPath(w, [slot]);
  g.queue.push(w);
  sim.workers.push(w);
  sim.totalSpawned++;
  pushEvent(g.id, t("feed.joined", "worker joined the lane"));
}

function pushEvent(gateId, text) {
  sim.events.unshift({ t: sim.time, gateId, text });
  if (sim.events.length > 40) sim.events.pop();
}

// -------------------------------------------------------------- simulation ---
function update(dt) {
  sim.time += dt;

  // arrivals
  sim.spawnTimer -= dt;
  const totalWaiting = sim.gates.reduce((s, g) => s + g.queue.length, 0);
  if (sim.spawnTimer <= 0 && totalWaiting < cfg.softCap) {
    spawnWorker();
    sim.spawnTimer = cfg.spawnEvery * (0.6 + Math.random() * 0.9);
  }

  // gates
  for (const g of sim.gates) {
    if (g.cooldown > 0) g.cooldown -= dt;
    if (g.busy) {
      g.spin += dt / cfg.passSec;
      if (g.spin >= 1) { g.spin = 0; g.busy = false; g.cooldown = cfg.gateCooldown; }
    }
    const front = g.queue[0];
    if (front && !g.busy && g.cooldown <= 0 && front.state === "QUEUE" &&
        !front.moving && dist(front.pos, queueSlot(g, 0)) < 3) {
      g.queue.shift();
      front.state = "PASSING";
      g.busy = true; g.spin = 0; g.passed++;
      sim.totalPassed++;
      sim.waitAccum += (sim.time - front.waitStart); sim.waitCount++;
      // walk through the turnstile and off the top of the frame
      setPath(front, [{ x: g.x, y: cfg.barrierY - 8 }, { x: g.x, y: bounds.minY - 34 }]);
      pushEvent(g.id, t("feed.passed", "worker passed the turnstile"));
      reslot(g);
    }
  }

  // workers
  for (const w of sim.workers) {
    stepWorker(w, dt);
    if (w.state === "APPROACH" && w.arrived) {
      w.state = "QUEUE"; w.facing = "up"; w.waitStart = sim.time;
    }
  }

  // retire workers that walked off the top
  sim.workers = sim.workers.filter((w) => !(w.state === "PASSING" && w.arrived));
}

// ---------------------------------------------------------------- renderer ---
class View {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.scale = 1; this.offsetX = 0; this.offsetY = 0;
    this.resize();
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, Math.round(rect.width));
    this.cssH = Math.max(1, Math.round(rect.height));
    this.dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2.5));
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }
  camera() {
    const pad = 46;
    const worldW = bounds.width;
    const worldH = bounds.height * SQUASH;
    const availW = Math.max(40, this.cssW - 2 * pad);
    const availH = Math.max(40, this.cssH - 2 * pad);
    this.scale = Math.max(0.05, Math.min(availW / worldW, availH / worldH));
    const screenW = worldW * this.scale, screenH = worldH * this.scale;
    this.offsetX = (this.cssW - screenW) / 2 - bounds.minX * this.scale;
    this.offsetY = (this.cssH - screenH) / 2 - bounds.minY * SQUASH * this.scale;
  }
  toScreen(wx, wy, z = 0) {
    return {
      x: this.offsetX + wx * this.scale,
      y: this.offsetY + wy * SQUASH * this.scale - z * this.scale,
    };
  }
  roundRect(x, y, w, h, rad) {
    const ctx = this.ctx;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    const rr = Math.max(0, Math.min(rad, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  render() {
    this.camera();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this._floor();
    this._lanes();
    this._barrier();
    this._signs();

    const draws = [];
    for (const g of sim.gates) draws.push({ y: g.y, fn: () => this._gate(g) });
    for (const w of sim.workers) draws.push({ y: w.pos.y, fn: () => this._worker(w) });
    draws.sort((a, b) => a.y - b.y);
    for (const d of draws) d.fn();
  }

  _floor() {
    const ctx = this.ctx;
    const tl = this.toScreen(bounds.minX, bounds.minY);
    const br = this.toScreen(bounds.maxX, bounds.maxY);
    ctx.fillStyle = "#eef3f8";
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.strokeStyle = "rgba(100,116,139,0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = bounds.minX; x <= bounds.maxX; x += 64) {
      const a = this.toScreen(x, bounds.minY), b = this.toScreen(x, bounds.maxY);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (let y = bounds.minY; y <= bounds.maxY; y += 64) {
      const a = this.toScreen(bounds.minX, y), b = this.toScreen(bounds.maxX, y);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  _lanes() {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = "rgba(34,211,238,0.5)"; ctx.shadowBlur = 12;
    for (const g of sim.gates) {
      const top = this.toScreen(g.x, cfg.barrierY + 6);
      const tail = this.toScreen(g.x, cfg.queueStartY + 7 * cfg.queueGap);
      ctx.strokeStyle = "rgba(34,211,238,0.38)"; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(tail.x, tail.y); ctx.stroke();
    }
    ctx.restore();
    ctx.shadowBlur = 0;
  }

  _barrier() {
    const ctx = this.ctx;
    const y = cfg.barrierY;
    const l = this.toScreen(bounds.minX + 30, y);
    const r = this.toScreen(bounds.maxX - 30, y);
    ctx.save();
    ctx.shadowColor = "rgba(94,234,212,0.55)"; ctx.shadowBlur = 10;
    ctx.strokeStyle = "rgba(94,234,212,0.45)"; ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.stroke();
    ctx.restore();
    ctx.setLineDash([]);
  }

  _neonText(text, wx, wy, color) {
    const ctx = this.ctx;
    const p = this.toScreen(wx, wy, 10);
    ctx.save();
    ctx.font = "800 12px Inter, system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width + 22;
    ctx.shadowColor = color; ctx.shadowBlur = 12;
    ctx.fillStyle = "#ffffff";
    this.roundRect(p.x - w / 2, p.y - 11, w, 22, 7); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = color; ctx.lineWidth = 1.3;
    this.roundRect(p.x - w / 2, p.y - 11, w, 22, 7); ctx.stroke();
    ctx.fillStyle = "#1e293b";
    ctx.fillText(text, p.x, p.y);
    ctx.restore();
  }

  _signs() {
    const midX = (bounds.minX + bounds.maxX) / 2;
    this._neonText(t("sign.exit", "EXIT"), midX, bounds.minY + 8, "#5eead4");
    this._neonText(t("sign.entrance", "ENTRANCE"), midX, bounds.maxY - 14, "#22d3ee");
  }

  _gate(g) {
    const ctx = this.ctx;
    const active = g.busy;
    const edge = g.highlighted ? "#5eead4" : "rgba(94,234,212,0.5)";
    const topZ = 30;

    // two posts either side of the lane
    const drawPost = (wx) => {
      const b = this.toScreen(wx, g.y, 0);
      const t = this.toScreen(wx, g.y, topZ);
      const pw = 9;
      ctx.fillStyle = "#cbd5e1";
      this.roundRect(b.x - pw / 2, t.y, pw, b.y - t.y, 3); ctx.fill();
      ctx.strokeStyle = edge; ctx.lineWidth = 1.2;
      this.roundRect(b.x - pw / 2, t.y, pw, b.y - t.y, 3); ctx.stroke();
      // glowing cap
      ctx.save();
      ctx.shadowColor = active ? "rgba(94,234,212,0.9)" : "rgba(34,211,238,0.5)";
      ctx.shadowBlur = active ? 14 : 8;
      ctx.fillStyle = active ? "#5eead4" : "#22d3ee";
      ctx.beginPath(); ctx.arc(t.x, t.y, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };
    drawPost(g.x - 20);
    drawPost(g.x + 20);

    // rotating tripod arm (viewed from high angle)
    const hub = this.toScreen(g.x, g.y, 15);
    const baseAng = g.busy ? g.spin * (Math.PI * 2 / 3) : (g.id * 0.7);
    ctx.save();
    ctx.shadowColor = active ? "rgba(94,234,212,0.9)" : "rgba(34,211,238,0.45)";
    ctx.shadowBlur = active ? 14 : 7;
    ctx.strokeStyle = active ? "#5eead4" : "rgba(94,234,212,0.7)";
    ctx.lineWidth = 3; ctx.lineCap = "round";
    const len = 19 * this.scale;
    for (let i = 0; i < 3; i++) {
      const ang = baseAng + i * (Math.PI * 2 / 3);
      const ex = hub.x + Math.cos(ang) * len;
      const ey = hub.y + Math.sin(ang) * len * SQUASH;
      ctx.beginPath(); ctx.moveTo(hub.x, hub.y); ctx.lineTo(ex, ey); ctx.stroke();
    }
    ctx.fillStyle = "#475569";
    ctx.beginPath(); ctx.arc(hub.x, hub.y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 1.4; ctx.stroke();
    ctx.restore();

    // hanging gate number sign
    const sign = this.toScreen(g.x, g.y - 6, topZ + 22);
    ctx.save();
    ctx.shadowColor = g.highlighted ? "rgba(94,234,212,0.9)" : "rgba(34,211,238,0.5)";
    ctx.shadowBlur = g.highlighted ? 18 : 10;
    ctx.fillStyle = "#ffffff";
    this.roundRect(sign.x - 15, sign.y - 12, 30, 22, 6); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = g.highlighted ? "#5eead4" : "rgba(94,234,212,0.55)";
    ctx.lineWidth = 1.4;
    this.roundRect(sign.x - 15, sign.y - 12, 30, 22, 6); ctx.stroke();
    ctx.fillStyle = "#1e293b";
    ctx.font = "700 12px Inter, system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("G" + g.id, sign.x, sign.y);
    ctx.restore();
  }

  _worker(w) {
    drawPerson(this, w.pos.x, w.pos.y, w.app, {
      facing: w.facing, moving: w.moving, walkPhase: w.phase, armAction: null, carry: null,
    });
  }
}

// ---------------------------------------------------------------------- DOM ---
const $ = (id) => document.getElementById(id);
const canvas = $("scene");
const view = new View(canvas);

const el = {
  workers: $("kWorkers"), waiting: $("kWaiting"), waitSub: $("kWaitSub"),
  passing: $("kPassing"), passed: $("kPassed"), avgWait: $("kAvgWait"), tpm: $("kTpm"),
  clock: $("simClock"), statusPill: $("statusPill"), statusLabel: $("statusLabel"),
  selected: $("selectedGate"), grid: $("gateGrid"), feed: $("accessFeed"),
  btnPause: $("btnPause"), btnResume: $("btnResume"), btnStop: $("btnStop"), btnReset: $("btnReset"),
};

function fmtClock(sec) {
  if (!(sec > 0)) sec = 0;
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

const STATUS_KEYS = { running: "st.running", paused: "st.paused", stopped: "st.stopped" };

function setStatus(state) {
  sim.status = state;
  el.statusPill.dataset.state = state;
  el.statusLabel.textContent = t(STATUS_KEYS[state] || "st.running", state.toUpperCase());
  el.btnPause.disabled = state !== "running";
  el.btnResume.disabled = state === "running";
}

let _domTimer = 0;
function updateDOM(dt) {
  el.clock.textContent = fmtClock(sim.time);
  _domTimer -= dt;
  if (_domTimer > 0) return;
  _domTimer = 0.15;

  const waiting = sim.gates.reduce((s, g) => s + g.queue.length, 0);
  const passing = sim.gates.reduce((s, g) => s + (g.busy ? 1 : 0), 0);
  const avgWait = sim.waitCount ? sim.waitAccum / sim.waitCount : 0;
  const tpm = sim.time > 0 ? sim.totalPassed / (sim.time / 60) : 0;

  el.workers.textContent = sim.totalSpawned;
  el.waiting.textContent = waiting;
  el.waitSub.textContent = avgWait.toFixed(1) + "s";
  el.passing.textContent = passing;
  el.passed.textContent = sim.totalPassed;
  el.avgWait.textContent = avgWait.toFixed(1) + "s";
  el.tpm.textContent = tpm.toFixed(1);

  renderGrid();
  renderFeed();
  renderSelected();
}

function renderGrid() {
  el.grid.innerHTML = sim.gates.map((g) => {
    const pct = Math.min(100, (g.queue.length / 9) * 100);
    const inLane = t("gate.inLane", "{n} in lane").replace("{n}", g.queue.length);
    return `<div class="reg-cell ${g.id === sim.selected ? "is-selected" : ""}" data-gate="${g.id}">
      <div class="reg-cell-top"><span class="reg-name">${t("gate.short", "Gate")} ${String(g.id).padStart(2, "0")}</span><span class="reg-queue">${inLane}</span></div>
      <div class="reg-bar"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join("");
}

function renderFeed() {
  el.feed.innerHTML = sim.events.map((e) =>
    `<div class="feed-item"><span class="feed-time">${fmtClock(e.t)}</span><span class="feed-text"><b>${t("gate.short", "Gate")} ${e.gateId}</b> · ${e.text}</span></div>`
  ).join("");
}

function renderSelected() {
  const g = sim.gates.find((x) => x.id === sim.selected);
  if (!g) {
    el.selected.innerHTML = `<p class="muted">${t("cc.selectPrompt", "Select a turnstile on the floor to see its live lane details.")}</p>`;
    return;
  }
  const state = g.busy ? t("state.passing", "PASSING") : t("state.open", "OPEN");
  const chip = g.busy ? "SCANNING" : "UNLOADING";
  const chipLabel = g.busy ? t("chip.scanning", "SCANNING") : t("chip.unloading", "UNLOADING");
  const tpm = sim.time > 0 ? g.passed / (sim.time / 60) : 0;
  el.selected.innerHTML = `
    <div class="detail-title"><strong>${t("gate.short", "Gate")} ${String(g.id).padStart(2, "0")}</strong>
      <span class="state-chip" data-s="${chip}" title="${chipLabel}">${state}</span></div>
    <div class="detail-row"><span>${t("detail.laneLength", "Lane length")}</span><b>${g.queue.length}</b></div>
    <div class="detail-row"><span>${t("detail.passedThrough", "Passed through")}</span><b>${g.passed}</b></div>
    <div class="detail-row"><span>${t("detail.tpm", "Passes / min")}</span><b>${tpm.toFixed(1)}</b></div>
    <div class="detail-row"><span>${t("detail.turnstile", "Turnstile")}</span><b>${g.busy ? t("detail.rotating", "Rotating") : t("detail.ready", "Ready")}</b></div>`;
}

function selectGate(id) {
  sim.selected = id;
  for (const g of sim.gates) g.highlighted = g.id === id;
  renderGrid(); renderSelected();
}

// -------------------------------------------------------------- interaction ---
canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  let best = null, bd = 1e9;
  for (const g of sim.gates) {
    const p = view.toScreen(g.x, g.y, 16);
    const d = Math.hypot(p.x - mx, p.y - my);
    if (d < bd) { bd = d; best = g; }
  }
  if (best && bd < 64) selectGate(best.id);
});

el.grid.addEventListener("click", (e) => {
  const cell = e.target.closest(".reg-cell");
  if (cell) selectGate(Number(cell.dataset.gate));
});

el.btnPause.addEventListener("click", () => { sim.running = false; setStatus("paused"); });
el.btnResume.addEventListener("click", () => { sim.running = true; setStatus("running"); });
el.btnStop.addEventListener("click", () => { sim.running = false; setStatus("stopped"); });
el.btnReset.addEventListener("click", () => {
  sim.workers = []; buildGates();
  sim.time = 0; sim.totalSpawned = 0; sim.totalPassed = 0;
  sim.waitAccum = 0; sim.waitCount = 0; sim.spawnTimer = 0; sim.events = [];
  sim.selected = null; sim.running = true;
  setStatus("running");
  renderGrid(); renderFeed(); renderSelected();
});

window.addEventListener("quentra:langchange", () => {
  setStatus(sim.status);
  renderGrid(); renderFeed(); renderSelected();
});

document.querySelectorAll(".speed-btn").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".speed-btn").forEach((x) => x.classList.remove("is-active"));
    b.classList.add("is-active");
    sim.speed = Number(b.dataset.speed);
  });
});

window.addEventListener("resize", () => view.resize());

// --------------------------------------------------------------------- loop ---
function boot() {
  setStatus("running");
  renderGrid(); renderFeed(); renderSelected();

  let last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000; last = now;
    if (dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;
    const scaled = dt * sim.speed;
    if (sim.running) update(scaled);
    view.render();
    updateDOM(sim.running ? scaled : dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

initQuentraApp({
  appId: "turnstile",
  accent: "#22d3ee",
  accent2: "#5eead4",
  brand: { name: "Quentra Turnstile", sub: "Access Simulation", logo: "/assets/quentra-logo.jpeg" },
  intro: TURNSTILE_INTRO,
  dict: TURNSTILE_DICT,
  onReady: () => { boot(); initAccessLive("turnstile", "#5eead4"); },
});
