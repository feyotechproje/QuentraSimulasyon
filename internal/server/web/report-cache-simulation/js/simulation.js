// simulation.js — in-memory simulation state & logic. Drives the world's hero
// screens, network packets, cache/SQL state and all KPIs.
//
// It makes no backend calls itself, but when live mode is on the poller in
// backend.js assigns the measured server state to `this.backend`. Packet flight
// times and hero progress are then derived from those REAL latencies, so the
// balls move at the speed the Quentra gateway actually answered. With no
// backend attached every timing falls back to the scripted ranges.

import { REPORT, TOTAL_USERS, COLORS } from "./config.js";
import {
  SCREEN, makeCache, makeSql, bezier, controlPoint, clamp, approach, rand, pick,
} from "./models.js";
import { QuentraI18n } from "/shared/quentra-i18n.js";

const MODE = { BASELINE:"baseline", CACHE:"cache" };

function locLabel(loc) { return QuentraI18n.t("loc." + loc.id, loc.name); }

export class Simulation {
  constructor(world, ds, onEvent) {
    this.world = world;
    this.ds = ds;
    this.onEvent = onEvent || (() => {});
    this.reset(true);
  }

  reset(hard = false) {
    this.time = 0;
    this.mode = MODE.BASELINE;
    this.auto = true;                 // start in auto-demo
    this.running = true;
    this.selected = null;

    this.packets = [];
    this.pool = this.pool || [];
    this.cache = makeCache();
    this.sql = makeSql();

    this.metrics = {
      users: TOTAL_USERS, requests: 0, sqlExec: 0, hits: 0, misses: 0,
      hitRatio: 0, avgMs: 0, cpu: 8, logicalReads: 0, dataMB: 0,
      avoided: 0, timeSavedMs: 0,
    };

    this.requested = 0;
    this.processed = 0;
    this.warming = false;             // cache miss in flight
    this._spawnT = 0;
    this._locCursor = 0;
    this._autoPhase = -1;
    this.callout = null;

    // reset heroes
    for (const l of this.world.locations) {
      l.hero.screen = SCREEN.IDLE; l.hero.progress = 0; l.hero.source = null;
      l.pending = 0; l.completed = 0; l.avgMs = 0; l.dataSource = "sql";
      l._req = null;
    }
    if (hard) this._emit("feed.init", "Simulation initialized — 100 users, one heavy report", "info");
  }

  // ---- controls ----
  setMode(mode, fromAuto = false) {
    if (!fromAuto) this.auto = false;
    if (this.mode === mode && !fromAuto) return;
    this.mode = mode;
    // keep scene; reset the measurement batch
    this.packets.length = 0;
    this.requested = 0; this.processed = 0; this.warming = false;
    this.metrics.requests = 0; this.metrics.sqlExec = 0; this.metrics.hits = 0;
    this.metrics.misses = 0; this.metrics.hitRatio = 0; this.metrics.avoided = 0;
    this.metrics.timeSavedMs = 0;
    this.sql.sameQueryRuns = 0; this.sql.runningCards.length = 0; this.sql.activeQueries = 0;
    for (const l of this.world.locations) {
      l.hero.screen = SCREEN.IDLE; l.hero.progress = 0; l.hero.source = null;
      l.pending = 0; l.completed = 0; l._req = null;
      l.dataSource = mode === MODE.CACHE ? "cache" : "sql";
    }
    if (mode === MODE.CACHE) {
      this.cache = makeCache();
      this.cache.reportId = REPORT.id; this.cache.cacheKey = REPORT.cacheKey;
      this._emit("feed.cacheActivated", "Quentra Cache activated — Cache Lookup ACTIVE", "hit");
    } else {
      this.cache = makeCache();
      this._emit("feed.baselineMode", "Baseline mode — every request runs on SQL Server", "sql");
    }
  }

  setAuto() { this.auto = true; this._autoPhase = -1; this.time = 0; this.setMode(MODE.BASELINE, true); this.callout = null; }
  pause()  { this.running = false; }
  resume() { this.running = true; }
  stop()   { this.running = false; }
  select(id) { this.selected = (this.selected === id) ? null : id; }

  // ---- main loop ----
  update(dt) {
    if (!this.running) return;
    this.time += dt;
    for (const l of this.world.locations) l.t += dt;

    if (this.auto) this._autoDemo();

    this._spawn(dt);
    this._advancePackets(dt);
    this._heroes(dt);
    this._cacheTick(dt);
    this._sqlTick(dt);
    this._metrics(dt);
  }

  // ---- spawning ----
  _spawn(dt) {
    this._spawnT -= dt;
    const interval = this.mode === MODE.CACHE ? 0.16 : 0.34;
    if (this._spawnT > 0) return;
    if (this.packets.length > 42) { this._spawnT = interval; return; }

    // In cache mode, hold spawns while the very first miss is warming the cache.
    if (this.mode === MODE.CACHE && this.warming) { this._spawnT = interval; return; }

    this._spawnT = interval;

    // pick a location whose hero is idle (no request, report already viewed)
    const locs = this.world.locations;
    let loc = null;
    for (let i=0;i<locs.length;i++) {
      const cand = locs[(this._locCursor + i) % locs.length];
      if (!cand._req && cand.hero.screen === SCREEN.IDLE) { loc = cand; this._locCursor = (this._locCursor + i + 1) % locs.length; break; }
    }
    if (!loc) { this._spawnT = interval; return; }

    // decide kind
    let kind;
    if (this.mode === MODE.BASELINE) kind = "sql";
    else if (this.cache.state !== "READY") { kind = "miss"; this.warming = true; }
    else kind = "hit";

    this.requested = Math.min(TOTAL_USERS, this.requested + 1);
    if (kind === "miss") this.metrics.misses = 1;
    this._launch(loc, kind);
  }

  _obtain() { return this.pool.pop() || {}; }
  _release(p) { if (this.pool.length < 80) this.pool.push(p); }

  _launch(loc, kind) {
    const p = this._obtain();
    p.kind = kind; p.locId = loc.id; p.li = 0; p.lt = 0; p.done = false;
    p.pos = { x: loc.anchor.x, y: loc.anchor.y };
    p.card = null;
    p.legs = this._buildLegs(loc, kind, p);
    this.packets.push(p);

    // hero starts loading
    loc._req = p;
    loc.pending++;
    loc.hero.screen = SCREEN.LOADING; loc.hero.progress = 0;
    loc.hero.source = null;
    // Progress bar should finish when the packet actually gets back, so in live
    // mode it tracks the same measured round trip the legs were built from.
    const rt = this._liveRoundTripSec(kind);
    loc.hero._expect = rt ? rt
                    : kind === "hit" ? rand(0.6, 1.1)
                    : kind === "miss" ? rand(6, 8) : rand(6, 10);
    loc.hero._elapsed = 0;

    const params = { loc: locLabel(loc), id: REPORT.id };
    if (kind === "hit") this._emit("feed.reqHit", `${params.loc} request: <b>CACHE HIT</b>`, "hit", params);
    else if (kind === "miss") this._emit("feed.reqMiss", `${params.loc} requested <b>${REPORT.id}</b> — Cache lookup: <b>MISS</b>`, "miss", params);
    else this._emit("feed.reqSql", `${params.loc} requested <b>${REPORT.id}</b> → SQL Server`, "sql", params);
  }

  /**
   * Round-trip time this packet should animate, in seconds.
   *
   * Live mode: the REAL measured latency of the path currently in force —
   * `quentraAvgMs` while running through the gateway, `baselineAvgMs` while
   * running direct — so a cache hit that actually returns in 200 ms flies
   * across in 200 ms instead of the scripted duration. Demo mode (or live
   * with no sample yet) falls back to the scripted range, which is what keeps
   * the unconnected page looking the same as before.
   *
   * Returns null when there is no real measurement to honour.
   */
  _liveRoundTripSec(kind) {
    const s = this.backend;
    if (!s || !s.provisioned || !s.running) return null;

    // Read the path that is actually executing. A cache "hit" and the SQL leg
    // of a "miss" travel different routes, so they must not share a number.
    const viaGateway = this.mode === MODE.CACHE && kind === "hit";
    const ms = viaGateway ? s.quentraAvgMs : s.baselineAvgMs;
    const runs = viaGateway ? s.quentraRuns : s.baselineRuns;
    if (!runs || !(ms > 0)) return null;   // no sample on this path yet

    // Clamped so the animation stays watchable: a sub-50ms hit would otherwise
    // teleport, and a 60s stall would freeze the scene. The displayed metrics
    // remain the unclamped truth — this bound is presentation only.
    return clamp(ms / 1000, 0.35, 12);
  }

  /** Split a round-trip budget across legs weighted by the scripted shape. */
  _scaleLegs(total, weights) {
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map((w) => Math.max(0.05, total * (w / sum)));
  }

  _buildLegs(loc, kind, p) {
    const A = loc.anchor, G = this.world.gatewayIn;
    const sql = this.world.nodes.sql, cache = this.world.nodes.cache;
    const sqlIn = { x: sql.x, y: sql.cy - 30 };
    const cacheIn = { x: cache.cx, y: cache.y };
    const mv = (a, b, dur, k) => ({ t:"move", a, b, ctrl:controlPoint(a,b,0.12), dur, kind:k });
    const hold = (at, dur, k, on) => ({ t:"hold", a:at, b:at, dur, kind:k, onStart:on });

    const liveRT = this._liveRoundTripSec(kind);

    if (kind === "sql") {
      // Weights keep the scripted rhythm (most of the time is the exec hold);
      // live mode only rescales them to the measured round trip.
      const [toG, toSql, exec, backG, backA] = liveRT
        ? this._scaleLegs(liveRT, [0.8, 0.5, 6.5, 0.4, 0.65])
        : [rand(0.6,1.0), rand(0.4,0.6), rand(4,9), rand(0.3,0.5), rand(0.5,0.8)];
      return [
        mv(A, G, toG, "sql"),
        mv(G, sqlIn, toSql, "sql"),
        hold(sqlIn, exec, "sql", () => this._sqlStart(p, exec)),
        mv(sqlIn, G, backG, "sql", ),
        { ...mv(G, A, backA, "sql"), onEnd:() => this._deliver(loc, "sql") },
      ].map(seg => this._wrapExecEnd(seg, p));
    }
    if (kind === "miss") {
      // A miss is the cold path: it pays the full SQL execution, so it is timed
      // off the baseline measurement even while the gateway is selected.
      const [toG, lookup, toSql, exec, toCache, store, backA] = liveRT
        ? this._scaleLegs(liveRT, [0.8, 0.22, 0.5, 5.5, 0.5, 0.5, 0.65])
        : [rand(0.6,1.0), rand(0.15,0.3), rand(0.4,0.6), rand(4,7), rand(0.4,0.6), 0.5, rand(0.5,0.8)];
      return [
        mv(A, G, toG, "miss"),
        hold(G, lookup, "miss"),
        mv(G, sqlIn, toSql, "miss"),
        hold(sqlIn, exec, "sql", () => this._sqlStart(p, exec)),
        { ...mv(sqlIn, cacheIn, toCache, "sql"), onEnd:() => this._sqlEnd(p) },
        { ...hold(cacheIn, store, "hit"), onStart:() => this._store(loc) },
        { ...mv(cacheIn, A, backA, "hit"), onEnd:() => { this._deliver(loc,"cache"); this.warming = false; } },
      ];
    }
    // hit — the leg that live mode changes most visibly: when Quentra answers
    // from cache in ~200ms the ball crosses almost instantly, which is the
    // whole point of watching it live rather than scripted.
    const [hToG, hLookup, hToCache, hHold, hBackA] = liveRT
      ? this._scaleLegs(liveRT, [0.6, 0.15, 0.38, 0.15, 0.42])
      : [rand(0.45,0.7), rand(0.1,0.2), rand(0.3,0.45), 0.15, rand(0.3,0.5)];
    return [
      mv(A, G, hToG, "hit"),
      hold(G, hLookup, "hit"),
      mv(G, cacheIn, hToCache, "hit"),
      { ...hold(cacheIn, hHold, "hit"), onStart:() => this.cache.pulse = 1 },
      { ...mv(cacheIn, A, hBackA, "hit"), onEnd:() => this._deliver(loc,"cache") },
    ];
  }

  _wrapExecEnd(seg, p) {
    // baseline: when leaving the exec hold, close the SQL card
    if (seg.t === "move" && !seg.onStart && p.card && seg.kind === "sql") {
      // no-op; handled in _sqlEnd via explicit call below
    }
    return seg;
  }

  _sqlStart(p, dur) {
    this.sql.activeQueries++;
    this.sql.sameQueryRuns++;
    p.card = { id: REPORT.id, elapsed: 0, dur };
    this.sql.runningCards.unshift(p.card);
    if (this.sql.runningCards.length > 6) this.sql.runningCards.pop();
    this._emit("feed.sqlStart", `Query sent to SQL Server — heavy report running`, "sql");
  }
  _sqlEnd(p) {
    if (p.card) {
      const i = this.sql.runningCards.indexOf(p.card);
      if (i >= 0) this.sql.runningCards.splice(i, 1);
      p.card = null;
    }
    this.sql.activeQueries = Math.max(0, this.sql.activeQueries - 1);
    this.processed = Math.min(TOTAL_USERS, this.processed + 1);
    if (this.metrics.sqlExec < TOTAL_USERS) this.metrics.sqlExec++;
  }

  _store(loc) {
    this.cache.state = "READY";
    this.cache.storedAt = this._clock();
    this.cache.ttl = 300;
    this.cache.size = 48;
    this.cache.pulse = 1;
    this._emit("feed.cached", `Report result cached — <b>${REPORT.cacheKey}</b>`, "hit", { key: REPORT.cacheKey });
  }

  _deliver(loc, source) {
    loc._req = null;
    loc.pending = Math.max(0, loc.pending - 1);
    loc.completed++;
    loc.dataSource = source;
    loc.hero.screen = SCREEN.READY; loc.hero.progress = 0.001; loc.hero.source = source;
    // Live mode reports the measured latency of the path that served this
    // request; demo mode keeps the scripted figures.
    const b = this.backend;
    const liveMs = b && b.provisioned && b.running
      ? (source === "cache" ? b.quentraAvgMs : b.baselineAvgMs)
      : 0;

    if (source === "cache") {
      loc.hero.lastMs = liveMs > 0 ? Math.round(liveMs) : Math.round(rand(140, 320));
      if (this.metrics.hits < TOTAL_USERS - Math.max(1, this.metrics.misses)) { this.metrics.hits++; }
    } else {
      loc.hero.lastMs = liveMs > 0 ? Math.round(liveMs) : Math.round(rand(7200, 9400));
      // baseline sql exec counted in _sqlEnd via card? baseline has no _sqlEnd move onEnd.
    }
    loc.avgMs = loc.hero.lastMs;
    if (source === "cache")
      this._emit("feed.deliverCache", `Report delivered to ${locLabel(loc)} in ${loc.hero.lastMs} ms — <b>CACHED</b>`, "hit", { loc: locLabel(loc), ms: loc.hero.lastMs });
    else
      this._emit("feed.deliverSql", `Report returned to ${locLabel(loc)} — <b>SOURCE: SQL SERVER</b>`, "sql", { loc: locLabel(loc) });
  }

  // baseline packets close their card + count exec at end of exec-hold. We detect
  // the transition inside _advancePackets when a hold(sql) leg finishes.

  _advancePackets(dt) {
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const p = this.packets[i];
      let leg = p.legs[p.li];
      if (!leg) { this._finish(p, i); continue; }
      if (p.lt === 0 && leg.onStart) leg.onStart();
      p.lt += dt;

      if (leg.t === "hold") {
        p.pos.x = leg.a.x; p.pos.y = leg.a.y;
        if (p.card) p.card.elapsed = Math.min(p.card.dur, p.card.elapsed + dt);
      } else {
        const t = clamp(p.lt / leg.dur, 0, 1);
        const pos = bezier(leg.a, leg.ctrl, leg.b, t);
        p.pos.x = pos.x; p.pos.y = pos.y;
      }
      p.kind = leg.kind;

      if (p.lt >= leg.dur) {
        // leaving a SQL exec hold in baseline path: close card + count exec
        if (leg.t === "hold" && leg.kind === "sql" && p.card && p.kind !== "miss") {
          // (miss handles _sqlEnd on its next move.onEnd)
          if (this._isBaselineCard(p)) this._sqlEnd(p);
        }
        if (leg.onEnd) leg.onEnd();
        p.li++; p.lt = 0;
      }
    }
  }
  _isBaselineCard(p) {
    // baseline packets have exactly the 5-leg SQL journey (no cache store leg)
    return p.legs.length === 5;
  }

  _finish(p, idx) {
    this.packets.splice(idx, 1);
    this._release(p);
  }

  // ---- heroes (screen state) ----
  _heroes(dt) {
    for (const l of this.world.locations) {
      const h = l.hero;
      if (h.screen === SCREEN.LOADING) {
        h._elapsed = (h._elapsed || 0) + dt;
        h.progress = clamp(h._elapsed / (h._expect || 6), 0, 0.97);
      } else if (h.screen === SCREEN.READY) {
        h.progress = Math.min(1, h.progress + dt * 2.2);      // build-up animation
        // once the charts have finished building, linger so the delivered
        // report is clearly visible before the user requests again.
        if (h.progress >= 1) h._hold = (h._hold || 0) + dt;
        const linger = this.mode === MODE.CACHE ? 2.0 : 2.6;
        if ((h._hold || 0) > linger) { h.screen = SCREEN.IDLE; h._hold = 0; }
      }
    }
  }

  // ---- cache / sql metric easing ----
  _cacheTick(dt) {
    this.cache.pulse = Math.max(0, this.cache.pulse - dt * 1.6);
    if (this.cache.state === "READY" && this.cache.ttl > 0) this.cache.ttl -= dt;
    this.cache.hits = this.metrics.hits;
    this.cache.misses = this.metrics.misses;
    this.cache.savedExecutions = this.metrics.hits;
    this.cache.lastAccess = this.metrics.hits + this.metrics.misses > 0 ? this._clock() : null;
  }

  _sqlTick(dt) {
    for (const c of this.sql.runningCards) c.elapsed = Math.min(c.dur, c.elapsed + dt);
    const baseline = this.mode === MODE.BASELINE;
    const load = clamp(this.sql.activeQueries / 6, 0, 1);
    const cpuTarget = baseline ? 40 + load * 55 : (this.sql.activeQueries > 0 ? 30 : 12);
    const diskTarget = baseline ? 45 + load * 50 : (this.sql.activeQueries > 0 ? 28 : 8);
    this.sql.cpu = approach(this.sql.cpu, cpuTarget, 2.2, dt);
    this.sql.diskReads = approach(this.sql.diskReads, diskTarget, 2.2, dt);
    this.sql.queuedQueries = Math.max(0, this.sql.runningCards.length - 3);
    this.sql.heat = approach(this.sql.heat, clamp(this.sql.cpu / 100, 0, 1), 2.0, dt);
    this.sql.state = this.sql.activeQueries > 0 ? (baseline ? "HEAVY LOAD" : "EXECUTING") : "IDLE";
    this.sql.memory = approach(this.sql.memory, baseline ? 78 : 40, 1.5, dt);
    this.sql.logicalReads += (baseline ? this.sql.activeQueries * 1400 : this.sql.activeQueries * 900) * dt;
  }

  _metrics(dt) {
    const m = this.metrics;
    m.requests = this.requested;
    const denom = m.hits + m.misses;
    m.hitRatio = denom ? m.hits / denom : 0;
    m.avoided = m.hits;
    m.cpu = this.sql.cpu;
    m.logicalReads = this.sql.logicalReads;
    m.avgMs = this.mode === MODE.BASELINE
      ? 8400
      : denom ? Math.round((m.misses * 6200 + m.hits * 260) / denom) : 0;
    m.dataMB = (m.sqlExec) * 48;
    m.timeSavedMs = m.hits * (8200 - 260);
  }

  // ---- auto demo ----
  _autoDemo() {
    const t = this.time;
    const phase =
      t < 3  ? 0 :
      t < 12 ? 1 :
      t < 15 ? 2 :
      t < 18 ? 3 :
      t < 22 ? 4 :
      t < 32 ? 5 :
      t < 37 ? 6 : 7;

    if (phase === this._autoPhase) return;
    this._autoPhase = phase;
    switch (phase) {
      case 0: this.callout = { key:"callout.sameReport", fallback:"100 users request the same report" }; break;
      case 1: this.callout = null; if (this.mode !== MODE.BASELINE) this.setMode(MODE.BASELINE, true); break;
      case 2: this.callout = { key:"callout.sameData", fallback:"Same report. Same data. 100 executions." };
        this.requested = TOTAL_USERS; this.metrics.sqlExec = TOTAL_USERS; this.sql.sameQueryRuns = TOTAL_USERS; break;
      case 3: this.callout = { key:"callout.cacheActivated", fallback:"Quentra Cache activated" }; this.setMode(MODE.CACHE, true); break;
      case 4: this.callout = { key:"callout.firstMiss", fallback:"First request → CACHE MISS → warming cache" }; break;
      case 5: this.callout = null; break;
      case 6: this.callout = { key:"callout.result", fallback:"100 REQUESTS · 1 SQL EXECUTION · 99 CACHE HITS" };
        this.requested = TOTAL_USERS; this.metrics.sqlExec = 1; this.metrics.misses = 1; this.metrics.hits = 99; break;
      case 7: // loop
        this.time = 0; this._autoPhase = -1; this.setMode(MODE.BASELINE, true); this.callout = null; break;
    }
  }

  // ---- helpers ----
  _clock() {
    const total = 9 * 3600 + Math.floor(this.time);
    const hh = String(Math.floor(total/3600)%24).padStart(2,"0");
    const mm = String(Math.floor(total/60)%60).padStart(2,"0");
    const ss = String(total%60).padStart(2,"0");
    return `${hh}:${mm}:${ss}`;
  }
  _emit(key, fallback, kind, params) { this.onEvent({ time: this._clock(), key, fallback, params, kind: kind || "info" }); }
}

export { MODE };
