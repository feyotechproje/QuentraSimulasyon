// simulation.js
// The orchestrator. Owns the world, the vehicle population, the GPS packet pool,
// the Quentra Gateway, the SQL Server, the metrics aggregator and the demo
// timeline. Pure state + logic — it never renders. The renderer and UI read from
// it; the datasource feeds it. No backend, no network.

import { World, zoneAt } from "./world.js";
import { Router } from "./route.js";
import { Vehicle } from "./vehicle.js";
import { GpsUpdate } from "./gps-update.js";
import { Gateway } from "./gateway.js";
import { SqlServer } from "./sql-server.js";
import { Metrics } from "./metrics.js";
import { QueryCard } from "./query.js";
import { InMemoryVehicleTrackingDataSource } from "./datasource.js";

const START_CLOCK = 9 * 3600 + 15 * 60; // 09:15:00

export class Simulation {
  constructor() {
    this.world = new World();
    this.net = this.world.net;
    this.router = new Router(this.net);
    this.ds = new InMemoryVehicleTrackingDataSource();
    this.config = this.ds.getConfig();

    this.gateway = new Gateway();
    this.sql = new SqlServer();
    this.metrics = new Metrics();

    this.vehicles = [];
    this.gpsPool = [];
    this.activeGps = [];
    this.cardPool = [];
    this.activeCards = [];

    this.mode = "baseline";
    this.clock = START_CLOCK;
    this.feed = [];
    this.selected = null;      // { kind:'vehicle'|'region'|'gateway'|'sql'|'planCache', ref }
    this.banner = null;

    // Layer toggles.
    this.showPackets = true;
    this.showDelay = true;
    this.showTraffic = true;
    this.showSqlFlow = true;

    // Auto demo state.
    this.auto = { active: true, t: 0 };
    this._eventTimer = 0;
    this._sqlArrivals = 0;

    // Central node centre points for packet routing.
    const c = this.world.central;
    this.gatewayPt = { x: c.gateway.x, y: c.gateway.y - 10 };
    this.sqlPt = { x: c.sql.x, y: c.sql.y - 10 };

    this._spawnInitial();
  }

  _spawnInitial() {
    const target = this.config.visibleTarget;
    for (let i = 0; i < target; i++) {
      const node = this.router.randomNode();
      this.vehicles.push(new Vehicle(this.net, this.router, node.id));
    }
  }

  // ---- clock helpers -------------------------------------------------------
  clockLabel() {
    const s = Math.floor(this.clock) % 86400;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return `${p2(h)}:${p2(m)}:${p2(ss)}`;
  }

  // ---- mode / demo ---------------------------------------------------------
  setMode(mode, fromAuto = false) {
    if (!fromAuto) { this.auto.active = false; this.banner = null; }
    this.mode = mode;
  }

  startAutoDemo() {
    this.auto = { active: true, t: 0 };
    this.mode = "baseline";
    this.banner = null;
  }

  _updateAuto(dt) {
    if (!this.auto.active) return;
    this.auto.t += dt;
    const t = this.auto.t;
    const tr = (key, fallback) => (window.QuentraI18n ? window.QuentraI18n.t(key, fallback) : fallback);
    if (t < 5) {
      this.setMode("baseline", true);
      this.banner = { title: tr("banner.introTitle", "200,000 CONNECTED VEHICLES"), sub: tr("banner.introSub", "20,000 GPS UPDATES EVERY SECOND"), tone: "neutral" };
    } else if (t < 15) {
      this.banner = { title: tr("banner.baselineTitle", "BASELINE · AD-HOC SQL"), sub: tr("banner.baselineSub", "Every UPDATE compiles a new plan"), tone: "bad" };
    } else if (t < 20) {
      this.banner = { title: tr("banner.literalsTitle", "SAME UPDATE PATTERN — DIFFERENT LITERALS"), sub: tr("banner.literalsSub", "NEW COMPILATION EVERY TIME"), tone: "bad" };
    } else if (t < 24) {
      this.setMode("quentra", true);
      this.banner = { title: tr("banner.rewriteTitle", "QUENTRA REWRITE ENGINE ACTIVE"), sub: tr("banner.rewriteSub", "Ad-hoc UPDATE → sp_UpdateVehicleState"), tone: "quentra" };
    } else if (t < 38) {
      this.banner = { title: tr("banner.paramTitle", "PARAMETERIZED · PLAN REUSED"), sub: tr("banner.paramSub", "Compilation avoided · CPU falling"), tone: "good" };
    } else if (t < 44) {
      this.banner = {
        title: tr("banner.resultTitle", "SAME WORKLOAD · 99% FEWER COMPILATIONS"),
        sub: tr("banner.resultSub", "Lower CPU · Real-time positions · Zero application change"),
        tone: "good",
      };
    } else {
      this.auto.t = 0; // loop the story
    }
  }

  // ---- GPS packet emission -------------------------------------------------
  emitGpsUpdate(v) {
    this.gateway.process({});
    // Limit visible packets for performance; always show for the selected car.
    const cap = 220;
    if (this.showPackets && (v.selected || this.activeGps.length < cap)) {
      const pkt = this.gpsPool.pop() || new GpsUpdate();
      pkt.reset(v, this.gatewayPt, this.sqlPt, this.mode);
      pkt._reachedSql = false;
      this.activeGps.push(pkt);
    }
    // Feed a small query card near the SQL server occasionally.
    if (this.activeCards.length < 26 && Math.random() < 0.5) {
      const card = this.cardPool.pop() || new QueryCard();
      card.reset(v.id, this.mode);
      this.activeCards.push(card);
    }
  }

  // ---- main tick -----------------------------------------------------------
  update(dt) {
    this.clock += dt;
    this._updateAuto(dt);
    this._sqlArrivals = 0;

    // Traffic-light phases.
    for (const n of this.net.nodeList) {
      if (!n.trafficLight) continue;
      n.lightTimer -= dt;
      if (n.lightTimer <= 0) {
        n.lightPhase ^= 1;
        n.lightTimer = n.lightPhase === 0 ? 6.5 : 5.5;
      }
    }

    // Zone assignment.
    for (const v of this.vehicles) {
      const z = zoneAt(v.x, v.y);
      v.zone = z ? z.id : null;
    }

    // Car-following: bucket by segment+dir, sort by t, set leadGap.
    this.net.clearLanes();
    for (const v of this.vehicles) this.net.registerOnLane(v);
    for (const arr of this.net.lanes.values()) {
      if (arr.length < 2) { if (arr[0]) arr[0].leadGap = 9999; continue; }
      arr.sort((a, b) => a.t - b.t);
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        v.leadGap = 9999;
        for (let j = i + 1; j < arr.length; j++) {
          if (arr[j].laneIndex === v.laneIndex) {
            const seg = this.net.segment(v.currentSegmentId);
            v.leadGap = (arr[j].t - v.t) * seg.length;
            break;
          }
        }
      }
    }

    // Vehicles.
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      v.update(dt, this.net, this);
      if (v._despawn) {
        const sel = v.selected;
        this.vehicles.splice(i, 1);
        // Respawn to keep the population steady.
        const node = this.router.randomNode();
        const nv = new Vehicle(this.net, this.router, node.id);
        if (sel) { nv.selected = true; this.selected = { kind: "vehicle", ref: nv }; }
        this.vehicles.push(nv);
      }
    }

    // GPS packets.
    for (let i = this.activeGps.length - 1; i >= 0; i--) {
      const p = this.activeGps[i];
      const wasLeg = p.leg;
      p.update(dt);
      if (p.leg >= 2 && !p._reachedSql) { p._reachedSql = true; this._sqlArrivals++; }
      if (p.done || !p.active) {
        this.activeGps.splice(i, 1);
        this.gpsPool.push(p);
      }
    }

    // Query cards.
    for (let i = this.activeCards.length - 1; i >= 0; i--) {
      const c = this.activeCards[i];
      c.update(dt);
      if (!c.active) { this.activeCards.splice(i, 1); this.cardPool.push(c); }
    }

    // Central + metrics.
    this.gateway.update(dt, this.mode);
    this.sql.update(dt, this.mode, this._sqlArrivals);
    this.metrics.update(dt, this);

    // Live event feed (throttled).
    this._eventTimer += dt;
    if (this._eventTimer > 0.55) {
      this._eventTimer = 0;
      const ev = this.ds.nextEvent(this.mode, this);
      if (ev) {
        this.feed.unshift(ev);
        if (this.feed.length > 40) this.feed.pop();
      }
    }
  }

  // ---- selection -----------------------------------------------------------
  selectVehicle(v) {
    if (this.selected && this.selected.ref && this.selected.ref.selected !== undefined)
      this.selected.ref.selected = false;
    for (const o of this.vehicles) o.selected = false;
    if (v) { v.selected = true; this.selected = { kind: "vehicle", ref: v }; }
  }

  select(kind, ref) {
    for (const o of this.vehicles) o.selected = false;
    this.selected = { kind, ref };
  }

  clearSelection() {
    for (const o of this.vehicles) o.selected = false;
    this.selected = null;
  }

  reset() {
    this.vehicles = [];
    this.activeGps = [];
    this.activeCards = [];
    this.feed = [];
    this.clock = START_CLOCK;
    this.selected = null;
    this.gateway = new Gateway();
    this.sql = new SqlServer();
    this.metrics = new Metrics();
    this.startAutoDemo();
    this._spawnInitial();
  }
}

function p2(n) { return n < 10 ? "0" + n : "" + n; }
