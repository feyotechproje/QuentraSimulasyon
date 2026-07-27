// simulation.js — in-memory demo state + all state machines.
// 100% client-side. No DB, no API, no WebSocket, no real query is ever executed.

import { MODE, PSTATE, SAFE_STATE, rand, pick, clamp } from "./models.js";
import { TIMINGS, GATEWAY_MODULES } from "./config.js";
import { buildWorld } from "./world.js";
import { createAttackPacket, packetPos } from "./attack-packet.js";
import { createSafeQuery } from "./query.js";
import { ParticlePool } from "./particles.js";
import { Metrics } from "./metrics.js";
import { EventLog } from "./events.js";

const t = (key, fallback, vars) => {
  let s = window.QuentraI18n ? window.QuentraI18n.t(key, fallback) : fallback;
  if (vars) for (const k in vars) s = s.split(`{${k}}`).join(vars[k]);
  return s;
};

// Auto-demo timeline (seconds within a 40s loop). Captions are resolved live via
// i18n keys (captionKey) rather than baked-in text, so language changes apply.
const AUTO_PHASES = [
  { t: 0,  auto: "off",    attacks: false, captionKey: "cap.underAttack", danger: false, dur: 3.4 },
  { t: 4,  auto: "off",    attacks: true,  captionKey: null },
  { t: 12, auto: "off",    attacks: true,  captionKey: "cap.reaching", danger: true, dur: 3.4 },
  { t: 16, auto: "active", attacks: true,  captionKey: "cap.activated", danger: false, dur: 3 },
  { t: 34, auto: "active", attacks: true,  captionKey: "cap.protected", danger: false, dur: 5 },
];
const AUTO_LOOP = 40;

export class Simulation {
  constructor(ds) {
    this.ds = ds;
    this.world = buildWorld(ds);
    this.particles = new ParticlePool(360);
    this.metrics = new Metrics();
    this.events = new EventLog(8);
    this.reset(MODE.AUTO);
  }

  reset(mode = this.mode || MODE.ACTIVE) {
    this.mode = mode === MODE.AUTO ? MODE.ACTIVE : mode;
    this.autoDemo = mode === MODE.AUTO;
    this.paused = false;
    this.time = 0;
    this._autoClock = 0;
    this._autoPhase = -1;
    this._autoMode = "off";
    this._attacksEnabled = !this.autoDemo; // manual modes always fire
    this.attackPackets = [];
    this.safePackets = [];
    this.ripples = [];
    this.dbAlarms = [];
    this.dbPulses = [];
    this.particles.active.length = 0;
    while (this.particles.active.length) this.particles.pool.push(this.particles.active.pop());
    this.metrics.reset();
    this.events.clear();
    this.shieldIntensity = this.protectionActive() ? 1 : 0.15;
    this.gatewayLit = GATEWAY_MODULES.map(() => false);
    this.pipelineStep = 0;
    this.pipelineActive = false;
    this._inspectTimer = 0;
    this.lastDecision = null;
    this.selection = { type: "attack", ref: null };
    this._atkTimer = 0;
    this._safeTimer = 0.4;
    this.caption = null;
    this._captionTimer = 0;
    for (const a of this.world.attackers) { a.count = 0; a.lastFire = 0; }
    this.events.push(t("feed.simStarted", "Simulation started · Key Breaker online"), "green");
  }

  // ---- mode helpers ----
  effectiveMode() { return this.autoDemo ? this._autoMode : this.mode; }
  protectionActive() { return this.effectiveMode() === "active"; }
  databaseSecure() { return this.protectionActive(); }

  setMode(mode) {
    if (mode === MODE.AUTO) {
      this.autoDemo = true;
      this._autoClock = 0; this._autoPhase = -1;
    } else {
      this.autoDemo = false;
      this.mode = mode;
      this._attacksEnabled = true;
      this.events.push(mode === "active"
        ? t("feed.kbActive", "Key Breaker ACTIVE · shield raised")
        : t("feed.protOffManual", "Protection OFF · demo only (real defense unchanged)"),
        mode === "active" ? "green" : "red");
    }
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  // ---- main tick ----
  update(dt) {
    if (this.paused) return;
    this.time += dt;
    this.events.tick(dt);
    if (this.autoDemo) this._updateAuto(dt);

    // shield intensity easing
    const target = this.protectionActive() ? 1 : 0.15;
    this.shieldIntensity += (target - this.shieldIntensity) * Math.min(1, dt * 4);

    // spawns
    if (this._attacksEnabled) {
      this._atkTimer -= dt;
      if (this._atkTimer <= 0 && this.attackPackets.filter(p => !p.dead).length < TIMINGS.maxAttackPackets) {
        this._atkTimer = TIMINGS.attackInterval * rand(0.6, 1.3);
        this._spawnAttack();
      }
    }
    this._safeTimer -= dt;
    if (this._safeTimer <= 0 && this.safePackets.filter(p => !p.dead).length < TIMINGS.maxSafePackets) {
      this._safeTimer = TIMINGS.safeInterval * rand(0.7, 1.2);
      this._spawnSafe();
    }

    this._updateAttacks(dt);
    this._updateSafe(dt);
    this._updateEffects(dt);
    this.particles.update(dt);
    this.metrics.update(dt, this.protectionActive());

    if (this.caption) {
      this._captionTimer -= dt;
      if (this._captionTimer <= 0) this.caption = null;
    }

    // pipeline inspection decay
    if (this._inspectTimer > 0) {
      this._inspectTimer -= dt;
      const prog = 1 - clamp(this._inspectTimer / 0.6, 0, 1);
      this.pipelineStep = Math.floor(prog * 7);
      for (let i = 0; i < this.gatewayLit.length; i++)
        this.gatewayLit[i] = prog > i / this.gatewayLit.length;
    } else if (!this.protectionActive()) {
      this.pipelineActive = false;
      this.gatewayLit = this.gatewayLit.map(() => false);
    }
  }

  _updateAuto(dt) {
    this._autoClock = (this._autoClock + dt);
    if (this._autoClock >= AUTO_LOOP) { this._autoClock -= AUTO_LOOP; this._autoPhase = -1; }
    // find current phase
    let idx = -1;
    for (let i = 0; i < AUTO_PHASES.length; i++) if (this._autoClock >= AUTO_PHASES[i].t) idx = i;
    if (idx !== this._autoPhase && idx >= 0) {
      this._autoPhase = idx;
      const ph = AUTO_PHASES[idx];
      this._autoMode = ph.auto;
      this._attacksEnabled = ph.attacks;
      if (ph.captionKey) this._showCaption(ph.captionKey, ph.danger, ph.dur || 3);
      if (ph.auto === "active") this.events.push(t("feed.kbActive", "Key Breaker ACTIVE · shield raised"), "green");
      if (ph.auto === "off" && ph.attacks) this.events.push(t("feed.protOffAttacks", "Protection OFF · attacks reaching database"), "red");
    }
  }

  _showCaption(captionKey, danger, dur) {
    const fallback = {
      "cap.underAttack": "Your database is under constant attack.",
      "cap.reaching": "Malicious SQL is reaching the database.",
      "cap.activated": "Quentra Key Breaker activated.",
      "cap.protected": "SQL INJECTION BLOCKED\nSAFE QUERIES ALLOWED\nDATABASE PROTECTED",
    }[captionKey] || captionKey;
    this.caption = { text: t(captionKey, fallback), danger, key: captionKey };
    this._captionTimer = dur;
  }

  // ---- spawns ----
  _spawnAttack() {
    const src = pick(this.world.attackers);
    const typeKey = src.type;
    const info = this.ds.attackType(typeKey);
    const payload = this.ds.payload(typeKey);
    const p = createAttackPacket(src, typeKey, info, payload, this.effectiveMode(), this.world);
    p.state = PSTATE.LEAVING_SOURCE;
    src.count++;
    this.attackPackets.push(p);
    this.metrics.countAttack(typeKey);
    this.events.push(t("feed.sqliReceived", "SQL injection received · {ip}", { ip: src.ip }), "red");
    if (this.selection.type === "attack" && !this.selection.ref) this.selection.ref = p;
  }

  _spawnSafe() {
    const text = pick(this.ds.safeQueries());
    const q = createSafeQuery(text, this.world);
    this.safePackets.push(q);
  }

  // ---- attack packet state machine ----
  _updateAttacks(dt) {
    const active = this.protectionActive();
    for (const p of this.attackPackets) {
      if (p.dead) continue;

      if (p.state === PSTATE.FRAGMENTING || p.state === PSTATE.FADING) {
        p.blockTimer -= dt;
        p.fade = clamp(p.blockTimer / 0.5, 0, 1);
        if (p.shards) for (const s of p.shards) { s.dx += s.vx * dt; s.dy += s.vy * dt; s.r *= 0.96; }
        if (p.blockTimer <= 0) { p.dead = true; p.state = PSTATE.COMPLETED; }
        continue;
      }

      // slow down while inspecting near the gateway (active mode only)
      let sp = p.speed;
      if (active && p.t > 0.68 && p.t < 0.92) {
        sp *= 0.4;
        if (p.state !== PSTATE.INSPECTING) {
          p.state = PSTATE.INSPECTING;
          this._beginInspection(p);
        }
      } else if (p.t > 0.35 && p.state === PSTATE.LEAVING_SOURCE) {
        p.state = PSTATE.TRAVELING;
      } else if (p.t > 0.6 && p.state === PSTATE.TRAVELING) {
        p.state = active ? PSTATE.APPROACHING_GATEWAY : PSTATE.BYPASSING_GATEWAY;
      }

      p.t += sp * dt;
      const pos = packetPos(p, Math.min(p.t, 1));
      p.x = pos.x; p.y = pos.y;

      if (p.t >= 1) {
        if (active) this._blockPacket(p);
        else this._reachDatabase(p);
      }
    }
    // cull
    if (this.attackPackets.length > 60)
      this.attackPackets = this.attackPackets.filter(p => !p.dead);
  }

  _beginInspection(p) {
    this._inspectTimer = 0.6;
    this.pipelineActive = true;
    this.pipelineStep = 0;
    this.lastDecision = { risk: p.risk, block: true, pattern: p.pattern };
    p.state = PSTATE.THREAT_CONFIRMED;
  }

  _blockPacket(p) {
    p.state = PSTATE.BLOCKED;
    p.blocked = true;
    p.blockTimer = 0.5;
    p.state = PSTATE.FRAGMENTING;
    p.shards = Array.from({ length: 6 }, () => {
      const a = Math.random() * Math.PI * 2, s = rand(30, 90);
      return { dx: 0, dy: 0, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: rand(2, 4) };
    });
    // impact effects at shield
    const ix = p.x, iy = p.y;
    this.ripples.push({ x: ix, y: iy, r0: 6, spread: 90, age: 0, life: 0.6, hostile: true });
    this.ripples.push({ x: ix, y: iy, r0: 2, spread: 60, age: 0, life: 0.5, hostile: false });
    this.particles.burst(ix, iy, "255,77,94", 20, 150);
    this.particles.burst(ix, iy, "80,255,190", 12, 110);
    this.shieldIntensity = clamp(this.shieldIntensity + 0.25, 0, 1.4);
    this.metrics.block();
    this.events.push(t("feed.attackBlocked", "{tag} attack blocked · risk {risk} · {ms} ms", {
      tag: p.tag, risk: p.risk, ms: p.responseMs.toFixed(2),
    }), "green");
  }

  _reachDatabase(p) {
    p.state = PSTATE.INCIDENT_TRIGGERED;
    p.reachedDB = true;
    p.blockTimer = 0.5;
    p.fade = 1;
    p.state = PSTATE.FADING;
    this.dbAlarms.push({ x: 0, y: 0, age: 0, life: 0.8 });
    this.particles.burst(this.world.database.x, this.world.database.cy, "255,77,94", 16, 120);
    this.metrics.incident();
    this.events.push(t("feed.sqlReachedDb", "Malicious SQL reached database · incident #{n}", { n: this.metrics.incidents }), "red");
  }

  // ---- safe query state machine ----
  _updateSafe(dt) {
    for (const q of this.safePackets) {
      if (q.dead) continue;
      if (q.state === SAFE_STATE.REACHED_DB) {
        q.fade -= dt * 2;
        if (q.fade <= 0) { q.dead = true; q.state = SAFE_STATE.COMPLETED; }
        continue;
      }
      q.t += q.speed * dt;
      // path: p0 -> validateX (straighten) -> p2
      const x = q.p0.x + (q.p2.x - q.p0.x) * q.t;
      const y = q.p0.y + (q.p2.y - q.p0.y) * (q.t * q.t * (3 - 2 * q.t)); // ease
      q.x = x; q.y = y;
      if (!q.validated && x >= q.validateX) {
        q.validated = true;
        q.state = SAFE_STATE.ALLOWED;
      }
      if (q.t >= 1) {
        q.state = SAFE_STATE.REACHED_DB;
        q.reachedDB = true;
        this.dbPulses.push({ x: 0, y: 0, age: 0, life: 0.6 });
        this.metrics.allow();
      }
    }
    if (this.safePackets.length > 40)
      this.safePackets = this.safePackets.filter(q => !q.dead);
  }

  _updateEffects(dt) {
    const age = (arr) => { for (let i = arr.length - 1; i >= 0; i--) { arr[i].age += dt; if (arr[i].age >= arr[i].life) arr.splice(i, 1); } };
    age(this.ripples); age(this.dbAlarms); age(this.dbPulses);
  }

  // ---- selection ----
  select(hit) {
    // clear previous flags
    for (const p of this.attackPackets) p.selected = false;
    for (const q of this.safePackets) q.selected = false;
    if (!hit) { this.selection = { type: "none", ref: null }; return; }
    if (hit.type === "attack" && hit.ref) hit.ref.selected = true;
    if (hit.type === "safe" && hit.ref) hit.ref.selected = true;
    this.selection = hit;
  }

  currentAttack() {
    if (this.selection.type === "attack" && this.selection.ref && !this.selection.ref.dead)
      return this.selection.ref;
    // else most recent live attack
    for (let i = this.attackPackets.length - 1; i >= 0; i--)
      if (!this.attackPackets[i].dead) return this.attackPackets[i];
    return null;
  }
}
