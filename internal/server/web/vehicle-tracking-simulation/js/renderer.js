// renderer.js
// All canvas drawing. Owns the camera + orthographic-squash projection (a soft
// ~40° perspective), device-pixel-ratio handling and every draw layer. Reads
// simulation state; never mutates it.

import { WORLD, ZONES } from "./world.js";
import { GATEWAY_MODULES } from "./gateway.js";

let SQUASH = 0.60;

const t = (key, fallback) => (window.QuentraI18n ? window.QuentraI18n.t(key, fallback) : fallback);
const NODE_LABEL_KEYS = {
  gateway: ["sel.gateway", "QUENTRA GATEWAY"],
  sql: ["sel.sqlServer", "SQL SERVER"],
  planCache: ["sel.planCache", "PLAN CACHE"],
  opsCenter: ["sel.opsCenter", "OPS CENTER"],
};

const C = {
  bg0: "#f8fafc", bg1: "#edf2f7",
  grid: "rgba(71,85,105,0.08)",
  roadBase: "#cbd5e1", roadEdge: "#94a3b8", roadTop: "#e2e8f0",
  highway: "#b8c5d6", lane: "rgba(255,255,255,0.82)", laneY: "rgba(217,119,6,0.62)",
  water: "#dbeafe", park: "#dcfce7", tree: "#15803d",
  purple: "#8b5cf6", indigo: "#4661e6", teal: "#2dd4bf", green: "#34d399",
  red: "#ef4444", orange: "#f59e0b", text: "#1e293b", dim: "#64748b",
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.scale = 1; this.offX = 0; this.offY = 0;
    this.cw = 0; this.ch = 0;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    // Toolbar translations and responsive wrapping can change the available
    // canvas height without firing a window resize event. Track the rendered
    // canvas box so the drawing scale always follows the actual panel size.
    if ("ResizeObserver" in window) {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    }
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
    const nextWidth = Math.max(320, rect.width);
    const nextHeight = Math.max(240, rect.height);
    if (Math.abs(nextWidth - this.cw) < 0.5 &&
        Math.abs(nextHeight - this.ch) < 0.5 &&
        nextDpr === this.dpr) return;
    this.dpr = nextDpr;
    this.cw = nextWidth;
    this.ch = nextHeight;
    this.canvas.width = Math.round(this.cw * this.dpr);
    this.canvas.height = Math.round(this.ch * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Fit the whole world into the canvas. On short, wide dashboard panels,
    // reduce the orthographic squash so the map uses the available width
    // instead of becoming a tiny island in the middle of the canvas.
    const pad = 24;
    const availableW = Math.max(1, this.cw - pad * 2);
    const availableH = Math.max(1, this.ch - pad * 2);
    const matchedWorldH = WORLD.w * availableH / availableW;
    SQUASH = Math.max(0.24, Math.min(0.60, (matchedWorldH - 90) / WORLD.h));
    const worldH = WORLD.h * SQUASH + 90; // + central cluster margin
    const s = Math.min(availableW / WORLD.w, availableH / worldH);
    this.scale = s;
    this.offX = (this.cw - WORLD.w * s) / 2;
    this.offY = pad + 6;
  }

  project(wx, wy, wz = 0) {
    return { x: this.offX + wx * this.scale, y: this.offY + wy * SQUASH * this.scale - wz * this.scale };
  }
  screenToWorld(sx, sy) {
    return { x: (sx - this.offX) / this.scale, y: (sy - this.offY) / (SQUASH * this.scale) };
  }

  render(sim) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cw, this.ch);
    this._ground(ctx);
    this._zones(ctx, sim);
    this._roads(ctx, sim);
    this._props(ctx, sim);
    this._buildings(ctx, sim);
    this._trafficLights(ctx, sim);
    if (sim.showSqlFlow) this._networkLines(ctx, sim);
    this._vehicles(ctx, sim);
    if (sim.showPackets) this._packets(ctx, sim);
    this._central(ctx, sim);
    this._selection(ctx, sim);
    this._banner(ctx, sim);
  }

  // ---- layers --------------------------------------------------------------
  _ground(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, this.ch);
    g.addColorStop(0, C.bg0); g.addColorStop(1, C.bg1);
    ctx.fillStyle = g; ctx.fillRect(0, 0, this.cw, this.ch);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    for (let x = 0; x <= WORLD.w; x += 120) {
      const a = this.project(x, 0), b = this.project(x, WORLD.h);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let y = 0; y <= WORLD.h; y += 120) {
      const a = this.project(0, y), b = this.project(WORLD.w, y);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }

  _zones(ctx, sim) {
    for (const z of ZONES) {
      const p = this.project(z.x, z.y);
      const w = z.w * this.scale, h = z.h * SQUASH * this.scale;
      const sel = sim.selected && sim.selected.kind === "region" && sim.selected.ref === z.id;
      ctx.fillStyle = z.tint;
      ctx.globalAlpha = sel ? 0.9 : 0.55;
      this._rr(ctx, p.x, p.y, w, h, 10); ctx.fill();
      ctx.globalAlpha = 1;
      if (sel) { ctx.strokeStyle = C.purple; ctx.lineWidth = 2; this._rr(ctx, p.x, p.y, w, h, 10); ctx.stroke(); }
      ctx.fillStyle = "rgba(71,85,105,0.48)";
      ctx.font = "600 11px 'Segoe UI',sans-serif";
      ctx.fillText(t("region." + z.id, z.name).toUpperCase(), p.x + 10, p.y + 18);
    }
  }

  _props(ctx, sim) {
    for (const pr of sim.world.props) {
      if (pr.type === "water") {
        const p = this.project(pr.x, pr.y);
        ctx.fillStyle = C.water; ctx.globalAlpha = 0.9;
        this._rr(ctx, p.x, p.y, pr.w * this.scale, pr.h * SQUASH * this.scale, 8); ctx.fill();
        ctx.globalAlpha = 1;
      } else if (pr.type === "park") {
        const p = this.project(pr.x, pr.y);
        ctx.fillStyle = C.park;
        this._rr(ctx, p.x, p.y, pr.w * this.scale, pr.h * SQUASH * this.scale, 8); ctx.fill();
      } else if (pr.type === "tree") {
        const p = this.project(pr.x, pr.y, 8);
        const b = this.project(pr.x, pr.y, 0);
        ctx.strokeStyle = "#3a2c1e"; ctx.lineWidth = 2 * this.scale;
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.fillStyle = C.tree;
        ctx.beginPath(); ctx.arc(p.x, p.y, pr.r * this.scale, 0, Math.PI * 2); ctx.fill();
      } else if (pr.type === "fuel") {
        const p = this.project(pr.x, pr.y, 10);
        ctx.fillStyle = "#e2e8f0"; this._rr(ctx, p.x - 9, p.y - 8, 18, 12, 3); ctx.fill();
        ctx.fillStyle = C.teal; ctx.font = "700 7px 'Segoe UI'"; ctx.fillText("F", p.x - 2, p.y + 1);
      } else if (pr.type === "sign") {
        const p = this.project(pr.x, pr.y, 14);
        ctx.fillStyle = "#cbd5e1"; this._rr(ctx, p.x - 16, p.y - 7, 32, 12, 2); ctx.fill();
        ctx.fillStyle = C.dim; ctx.font = "600 7px 'Segoe UI'"; ctx.textAlign = "center";
        ctx.fillText(pr.text, p.x, p.y + 2); ctx.textAlign = "left";
      }
    }
  }

  _roads(ctx, sim) {
    // Base fill.
    for (const s of sim.net.segmentList) {
      const col = s.roadType === "highway" ? C.highway
        : s.roadType === "bridge" ? "#c4b5fd"
        : s.roadType === "tunnel" ? "#94a3b8" : C.roadBase;
      this._roadStroke(ctx, s, s.width, col);
    }
    // Center lane markings.
    ctx.save();
    for (const s of sim.net.segmentList) {
      if (s.roadType === "tunnel") continue;
      const dash = s.roadType === "highway" ? C.laneY : C.lane;
      const a = this.project(s.ax, s.ay), b = this.project(s.bx, s.by);
      ctx.strokeStyle = dash; ctx.lineWidth = 1.2; ctx.setLineDash([6, 8]);
      ctx.beginPath();
      if (s.control) {
        const c = this.project(s.control.x, s.control.y);
        ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
      } else { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      ctx.stroke();
    }
    ctx.setLineDash([]); ctx.restore();

    // Roundabout ring.
    if (sim.world.roundabout) {
      const rb = sim.world.roundabout;
      const p = this.project(rb.x, rb.y);
      ctx.strokeStyle = C.roadBase; ctx.lineWidth = 12 * this.scale;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, rb.r * this.scale, rb.r * SQUASH * this.scale, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#dcfce7";
      ctx.beginPath(); ctx.ellipse(p.x, p.y, rb.r * 0.5 * this.scale, rb.r * 0.5 * SQUASH * this.scale, 0, 0, Math.PI * 2); ctx.fill();
    }
  }

  _roadStroke(ctx, s, width, col) {
    const a = this.project(s.ax, s.ay), b = this.project(s.bx, s.by);
    ctx.strokeStyle = C.roadEdge; ctx.lineCap = "round";
    ctx.lineWidth = (width + 4) * this.scale;
    ctx.beginPath();
    if (s.control) { const c = this.project(s.control.x, s.control.y); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); }
    else { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = width * this.scale;
    ctx.beginPath();
    if (s.control) { const c = this.project(s.control.x, s.control.y); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); }
    else { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    ctx.stroke();
  }

  _buildings(ctx, sim) {
    const list = sim.world.buildings.slice().sort((a, b) => (a.y + a.h) - (b.y + b.h));
    for (const bd of list) this._drawBox(ctx, bd);
  }

  _drawBox(ctx, bd) {
    const z = bd.h3d;
    const g0 = this.project(bd.x, bd.y, 0);
    const g1 = this.project(bd.x + bd.w, bd.y, 0);
    const g2 = this.project(bd.x + bd.w, bd.y + bd.h, 0);
    const g3 = this.project(bd.x, bd.y + bd.h, 0);
    const t0 = this.project(bd.x, bd.y, z);
    const t1 = this.project(bd.x + bd.w, bd.y, z);
    const t2 = this.project(bd.x + bd.w, bd.y + bd.h, z);
    const t3 = this.project(bd.x, bd.y + bd.h, z);
    const base = bd.color || "#d8e1ec";
    // South face.
    ctx.fillStyle = shade(base, -0.32);
    ctx.beginPath(); ctx.moveTo(g3.x, g3.y); ctx.lineTo(g2.x, g2.y); ctx.lineTo(t2.x, t2.y); ctx.lineTo(t3.x, t3.y); ctx.closePath(); ctx.fill();
    // East face.
    ctx.fillStyle = shade(base, -0.18);
    ctx.beginPath(); ctx.moveTo(g1.x, g1.y); ctx.lineTo(g2.x, g2.y); ctx.lineTo(t2.x, t2.y); ctx.lineTo(t1.x, t1.y); ctx.closePath(); ctx.fill();
    // Roof.
    ctx.fillStyle = shade(base, 0.12);
    ctx.beginPath(); ctx.moveTo(t0.x, t0.y); ctx.lineTo(t1.x, t1.y); ctx.lineTo(t2.x, t2.y); ctx.lineTo(t3.x, t3.y); ctx.closePath(); ctx.fill();
    // Window rows on the south face for towers.
    if (bd.kind === "tower" || bd.h3d > 60) {
      ctx.strokeStyle = "rgba(71,85,105,0.16)"; ctx.lineWidth = 1;
      const rows = Math.floor(z / 16);
      for (let i = 1; i < rows; i++) {
        const yy = i / rows;
        const a = { x: g3.x + (t3.x - g3.x) * yy, y: g3.y + (t3.y - g3.y) * yy };
        const b = { x: g2.x + (t2.x - g2.x) * yy, y: g2.y + (t2.y - g2.y) * yy };
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    if (bd.label) {
      ctx.fillStyle = "rgba(30,41,59,0.78)"; ctx.font = "600 9px 'Segoe UI'"; ctx.textAlign = "center";
      ctx.fillText(bd.label, (t0.x + t2.x) / 2, (t0.y + t2.y) / 2);
      ctx.textAlign = "left";
    }
  }

  _trafficLights(ctx, sim) {
    for (const n of sim.net.nodeList) {
      if (!n.trafficLight) continue;
      const p = this.project(n.x, n.y, 16);
      ctx.fillStyle = "#475569"; this._rr(ctx, p.x - 3, p.y - 9, 6, 18, 2); ctx.fill();
      const ns = n.lightPhase === 0;
      ctx.fillStyle = ns ? C.green : "#3a2020";
      ctx.beginPath(); ctx.arc(p.x, p.y - 5, 2.2, 0, 7); ctx.fill();
      ctx.fillStyle = !ns ? C.green : "#20321f";
      ctx.beginPath(); ctx.arc(p.x, p.y + 3, 2.2, 0, 7); ctx.fill();
    }
  }

  _networkLines(ctx, sim) {
    // Faint animated link between gateway and SQL server.
    const gp = this.project(sim.gatewayPt.x, sim.gatewayPt.y);
    const sp = this.project(sim.sqlPt.x, sim.sqlPt.y);
    const q = sim.mode === "quentra";
    ctx.strokeStyle = q ? "rgba(45,212,191,0.35)" : "rgba(239,68,68,0.30)";
    ctx.lineWidth = 2; ctx.setLineDash([4, 6]);
    ctx.lineDashOffset = -(performance.now() / 60) % 10;
    ctx.beginPath(); ctx.moveTo(gp.x, gp.y); ctx.lineTo(sp.x, sp.y); ctx.stroke();
    ctx.setLineDash([]);
  }

  _vehicles(ctx, sim) {
    const list = sim.vehicles.slice().sort((a, b) => a.y - b.y);
    for (const v of list) {
      // Position delay marker (displayed lags actual).
      if (sim.showDelay) {
        const dp = this.project(v.displayedX, v.displayedY, 2);
        const ap = this.project(v.x, v.y, 4);
        const gap = Math.hypot(ap.x - dp.x, ap.y - dp.y);
        if (gap > 3) {
          const q = sim.mode === "quentra";
          ctx.strokeStyle = q ? "rgba(52,211,153,0.55)" : "rgba(245,158,11,0.55)";
          ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(dp.x, dp.y); ctx.lineTo(ap.x, ap.y); ctx.stroke();
          ctx.fillStyle = q ? C.green : C.orange;
          ctx.beginPath(); ctx.arc(dp.x, dp.y, 2.6, 0, 7); ctx.fill();
        }
      }
      this._drawVehicle(ctx, v, sim);
    }
  }

  _drawVehicle(ctx, v, sim) {
    const p = this.project(v.x, v.y, 3);
    const a = this.project(v.x, v.y, 0);
    const b = this.project(v.x + Math.cos(v.heading) * 6, v.y + Math.sin(v.heading) * 6, 0);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const sp = v.spec;
    // Keep vehicles readable even when the whole world is zoomed out.
    const vs = Math.max(this.scale, 0.5);
    const L = sp.L * vs, W = sp.W * vs;

    // Shadow.
    ctx.save();
    ctx.translate(a.x, a.y + 2); ctx.rotate(ang);
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    this._rr(ctx, -L / 2, -W / 2, L, W, W * 0.4); ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(ang);

    // Wheels.
    ctx.fillStyle = "#0c0f18";
    const wl = L * 0.16, ww = W * 0.16;
    for (const [wx, wy] of [[L*0.28,-W/2],[L*0.28,W/2-ww],[-L*0.34,-W/2],[-L*0.34,W/2-ww]])
      { this._rr(ctx, wx - wl/2, wy, wl, ww, 1); ctx.fill(); }

    // Body.
    ctx.fillStyle = v.color;
    this._rr(ctx, -L / 2, -W / 2, L, W, Math.min(W * 0.42, 5)); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    this._rr(ctx, -L / 2, -W / 2, L, W * 0.42, W * 0.3); ctx.fill();

    // Roof / cabin.
    const roofL = sp.bus || sp.semi ? L * 0.72 : L * 0.46;
    const roofX = sp.bus || sp.semi ? -L * 0.1 : L * 0.02;
    ctx.fillStyle = shade(v.color, -0.28);
    this._rr(ctx, roofX - roofL / 2, -W * 0.34, roofL, W * 0.68, 2); ctx.fill();
    // Windshield.
    ctx.fillStyle = "rgba(150,200,240,0.55)";
    this._rr(ctx, roofX + roofL / 2 - L * 0.06, -W * 0.30, L * 0.05, W * 0.60, 1); ctx.fill();

    // Cargo box for vans/trucks.
    if (sp.box || sp.semi) {
      ctx.fillStyle = shade(v.color, -0.1);
      const bx = -L / 2 + 1, bw = L * (sp.semi ? 0.55 : 0.4);
      this._rr(ctx, bx, -W / 2 + 1, bw, W - 2, 2); ctx.fill();
    }

    // Head/tail lights.
    ctx.fillStyle = "#fff3c0";
    this._rr(ctx, L / 2 - 2, -W / 2 + 1, 1.6, 2, 0.5); ctx.fill();
    this._rr(ctx, L / 2 - 2, W / 2 - 3, 1.6, 2, 0.5); ctx.fill();
    ctx.fillStyle = "#ff5a4a";
    this._rr(ctx, -L / 2 + 0.5, -W / 2 + 1, 1.4, 2, 0.5); ctx.fill();
    this._rr(ctx, -L / 2 + 0.5, W / 2 - 3, 1.4, 2, 0.5); ctx.fill();

    // Taxi sign / emergency bar.
    if (sp.taxi) { ctx.fillStyle = "#1b1b1b"; this._rr(ctx, -2, -1.6, 4, 3, 0.5); ctx.fill(); }
    if (sp.emergency || sp.beacon) {
      const blink = (Math.sin(performance.now() / 120 + v.id) > 0);
      if (sp.emergency === "pol") { ctx.fillStyle = blink ? "#3b82f6" : "#ef4444"; this._rr(ctx, -3, -W*0.28, 6, W*0.2, 1); ctx.fill(); }
      else { ctx.fillStyle = blink ? C.orange : "#7a4a10"; this._rr(ctx, -2, -1.5, 4, 3, 1); ctx.fill(); }
    }
    if (sp.emergency === "amb") {
      ctx.fillStyle = "#e23b3b"; this._rr(ctx, -L*0.1, -1.4, L*0.2, 2.8, 0.4); ctx.fill();
      this._rr(ctx, -1.2, -W*0.24, 2.4, W*0.48, 0.4); ctx.fill();
    }
    ctx.restore();

    // GPS pulse.
    if (v.pulse > 0) {
      ctx.strokeStyle = `rgba(139,92,246,${v.pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, (1 - v.pulse) * 16 + 6, 0, 7); ctx.stroke();
    }
  }

  _packets(ctx, sim) {
    for (const pk of sim.activeGps) {
      const p = this.project(pk.pos.x, pk.pos.y, 8);
      const q = pk.mode === "quentra";
      const col = q ? C.teal : C.orange;
      ctx.fillStyle = col; ctx.globalAlpha = 0.95;
      this._rr(ctx, p.x - 4, p.y - 4, 8, 8, 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#475569"; ctx.beginPath(); ctx.arc(p.x, p.y, 1.6, 0, 7); ctx.fill();
      // Label only for the selected vehicle's packets to avoid clutter.
      if (sim.selected && sim.selected.kind === "vehicle" && sim.selected.ref.id === pk.vehicleNum) {
        ctx.fillStyle = col; ctx.font = "700 8px 'Segoe UI'";
        ctx.fillText("GPS UPDATE", p.x + 7, p.y - 2);
        ctx.fillStyle = C.text; ctx.fillText(pk.vehicleId, p.x + 7, p.y + 7);
      }
    }
  }

  _central(ctx, sim) {
    const c = sim.world.central;
    const q = sim.mode === "quentra";
    this._node(ctx, sim, c.gateway, q ? C.purple : C.indigo, "gateway", sim.gateway.activity);
    this._node(ctx, sim, c.sql, q ? C.teal : C.red, "sql", (sim.sql.cpu) / 100);
    this._planCache(ctx, sim, c.planCache);
    this._node(ctx, sim, c.opsCenter, C.indigo, "opsCenter", 0.4);

    // Gateway module chips.
    const gp = this.project(c.gateway.x, c.gateway.y);
    ctx.font = "600 8px 'Segoe UI'";
    GATEWAY_MODULES.forEach((m, i) => {
      const on = q;
      ctx.fillStyle = on ? "rgba(139,92,246,0.85)" : "rgba(120,130,160,0.4)";
      const x = gp.x + 6 + (i % 3) * 66, y = gp.y + 44 + Math.floor(i / 3) * 16;
      this._rr(ctx, x, y, 62, 13, 3); ctx.fill();
      ctx.fillStyle = on ? "#fff" : "#9aa4bd";
      ctx.fillText(t("gwmod." + m.id, m.label).slice(0, 10), x + 4, y + 9);
    });
  }

  _node(ctx, sim, n, color, kind, glow) {
    const p = this.project(n.x - n.w / 2, n.y - n.h / 2);
    const w = n.w * this.scale, h = n.h * SQUASH * this.scale;
    const sel = sim.selected && sim.selected.kind === kind;
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = (12 + (glow || 0) * 18);
    ctx.fillStyle = "#ffffff";
    this._rr(ctx, p.x, p.y, w, h, 8); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = sel ? "#1e293b" : color; ctx.lineWidth = sel ? 2.5 : 1.5;
    this._rr(ctx, p.x, p.y, w, h, 8); ctx.stroke();
    // Header bar.
    ctx.fillStyle = color; ctx.globalAlpha = 0.9;
    this._rr(ctx, p.x, p.y, w, 16, 8); ctx.fill(); ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff"; ctx.font = "700 9px 'Segoe UI'";
    const lk = NODE_LABEL_KEYS[kind];
    const label = lk ? t(lk[0], lk[1]).toUpperCase() : n.label;
    ctx.fillText(label, p.x + 8, p.y + 11);
    return { p, w, h };
  }

  _planCache(ctx, sim, n) {
    const box = this._node(ctx, sim, n, sim.mode === "quentra" ? C.green : C.orange, "planCache", 0.3);
    const cards = sim.sql.planCards;
    const p = box.p;
    if (sim.mode === "quentra") {
      const pc = cards[0];
      ctx.fillStyle = "rgba(52,211,153,0.18)"; this._rr(ctx, p.x + 8, p.y + 22, box.w - 16, 26, 4); ctx.fill();
      ctx.fillStyle = C.green; ctx.font = "700 8px 'Segoe UI'";
      ctx.fillText("sp_UpdateVehicleState", p.x + 12, p.y + 33);
      ctx.fillStyle = C.text; ctx.font = "600 7px 'Segoe UI'";
      const reused = window.QuentraI18n ? window.QuentraI18n.t("gpsState.PLAN_REUSED", "REUSED").toUpperCase() : "REUSED";
      ctx.fillText(t("pc.useStatus", "USE COUNT · STATUS: REUSED").split("·")[0].trim() + " " + fmt(pc ? pc.useCount : 0) + " · " + reused, p.x + 12, p.y + 43);
    } else {
      // Grid of single-use plan cards.
      const cols = 6, cw = (box.w - 14) / cols;
      for (let i = 0; i < Math.min(cards.length, 30); i++) {
        const cx = p.x + 7 + (i % cols) * cw, cy = p.y + 20 + Math.floor(i / cols) * 6;
        ctx.fillStyle = "rgba(239,68,68,0.5)"; this._rr(ctx, cx, cy, cw - 2, 4.5, 1); ctx.fill();
      }
    }
  }

  _selection(ctx, sim) {
    if (!sim.selected || sim.selected.kind !== "vehicle") return;
    const v = sim.selected.ref;
    const p = this.project(v.x, v.y, 3);
    ctx.strokeStyle = C.purple; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(p.x, p.y, 20, 20 * SQUASH, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(139,92,246,0.4)";
    ctx.beginPath(); ctx.ellipse(p.x, p.y, 28, 28 * SQUASH, 0, 0, Math.PI * 2); ctx.stroke();
    // Tag.
    ctx.fillStyle = "rgba(255,255,255,0.94)"; this._rr(ctx, p.x + 16, p.y - 34, 96, 26, 4); ctx.fill();
    ctx.strokeStyle = C.purple; ctx.lineWidth = 1; this._rr(ctx, p.x + 16, p.y - 34, 96, 26, 4); ctx.stroke();
    ctx.fillStyle = "#1e293b"; ctx.font = "700 9px 'Segoe UI'"; ctx.fillText(v.vid, p.x + 22, p.y - 22);
    ctx.fillStyle = sim.mode === "quentra" ? C.green : C.orange; ctx.font = "600 8px 'Segoe UI'";
    ctx.fillText(v.speedKmh + " km/h · Δ" + v.gpsDelay.toFixed(1) + "s", p.x + 22, p.y - 12);
  }

  _banner(ctx, sim) {
    if (!sim.banner) return;
    const b = sim.banner;
    const tone = b.tone === "bad" ? C.red : b.tone === "good" ? C.green : b.tone === "quentra" ? C.purple : C.indigo;
    ctx.textAlign = "center";
    ctx.font = "800 20px 'Segoe UI'";
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    const w = ctx.measureText(b.title).width + 60;
    this._rr(ctx, this.cw / 2 - w / 2, 14, w, 52, 10); ctx.fill();
    ctx.strokeStyle = tone; ctx.lineWidth = 1.5; this._rr(ctx, this.cw / 2 - w / 2, 14, w, 52, 10); ctx.stroke();
    ctx.fillStyle = tone; ctx.fillText(b.title, this.cw / 2, 38);
    ctx.fillStyle = C.text; ctx.font = "600 11px 'Segoe UI'";
    ctx.fillText(b.sub, this.cw / 2, 56);
    ctx.textAlign = "left";
  }

  // ---- hit testing ---------------------------------------------------------
  pick(sx, sy, sim) {
    // Central nodes first.
    const c = sim.world.central;
    for (const [kind, n] of [["gateway", c.gateway], ["sql", c.sql], ["planCache", c.planCache], ["opsCenter", c.opsCenter]]) {
      const p = this.project(n.x - n.w / 2, n.y - n.h / 2);
      const w = n.w * this.scale, h = n.h * SQUASH * this.scale;
      if (sx >= p.x && sx <= p.x + w && sy >= p.y && sy <= p.y + h) return { kind, ref: n };
    }
    // Vehicles (nearest within radius).
    let best = null, bestD = 18 * 18;
    for (const v of sim.vehicles) {
      const p = this.project(v.x, v.y, 3);
      const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best) return { kind: "vehicle", ref: best };
    // Regions.
    const wpt = this.screenToWorld(sx, sy);
    for (const z of ZONES) {
      if (z.id === "highway") continue;
      if (wpt.x >= z.x && wpt.x <= z.x + z.w && wpt.y >= z.y && wpt.y <= z.y + z.h) return { kind: "region", ref: z.id };
    }
    return null;
  }

  // ---- utils ---------------------------------------------------------------
  _rr(ctx, x, y, w, h, r) {
    if (w <= 0 || h <= 0) { ctx.beginPath(); return; }
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

function shade(hex, amt) {
  const c = hex.replace("#", "");
  let r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
  r = clamp(r + amt * 255); g = clamp(g + amt * 255); b = clamp(b + amt * 255);
  return `rgb(${r|0},${g|0},${b|0})`;
}
function clamp(v) { return Math.max(0, Math.min(255, v)); }
function fmt(n) { return n.toLocaleString("en-US"); }
