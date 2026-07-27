// renderer.js
// Canvas 2D view of the factory entrance. Pure drawing: it reads simulation
// state and paints it. Pseudo-isometric projection, DPR-aware, depth-sorted so
// workers pass *between* the turnstile cabinets rather than over them.

import { drawPerson } from "../../retail-simulation/js/customer.js";
import {
  WORLD, WORLD_BOUNDS, SQUASH, GATE_COUNT, gateX, LAST_GATE_X, SECURITY,
} from "./world.js";
import { GATE_STATE, LIGHT } from "./turnstile.js";

// Small helper so canvas-drawn scenery text (banners, signs, on-screen gate
// messages) tracks the active language too, not just the DOM. Falls back to
// the English literal if the shared i18n runtime hasn't booted yet.
const t = (key, fallback) => (window.QuentraI18n ? window.QuentraI18n.t(key, fallback) : fallback);

// Fixed English "message.line" tags set by simulation.js's state machine —
// mapped to dictionary keys so the on-screen turnstile display re-renders in
// the active language.
const GATE_LINE_KEY = {
  APPROACHING: "msg.approaching",
  "PRESENT CARD": "msg.presentCard",
  "CHECKING LAST MOVEMENT": "msg.checkingLastMovement",
  "ENTRY APPROVED": "msg.entryApproved",
  "ACCESS DENIED": "msg.accessDenied",
  "MANUAL REVIEW": "msg.manualReview",
};
function gateLineText(line) {
  if (!line) return "";
  const m = /^QUERY ([\d.]+)s$/.exec(line);
  if (m) return t("msg.query", line).replace("{n}", m[1]);
  const key = GATE_LINE_KEY[line];
  return key ? t(key, line) : line;
}

// gate.message.sub is either "EMP-#### · DEPARTMENT" (left as-is — it's data,
// not UI copy) or "Last movement: EXIT/ENTRY/NONE" once a check resolves.
const MOVEMENT_KEY = { EXIT: "movement.EXIT", ENTRY: "movement.ENTRY", NONE: "movement.NONE" };
function gateSubText(sub) {
  if (!sub) return "";
  const m = /^Last movement: (\w+)$/.exec(sub);
  if (!m) return sub;
  const movement = MOVEMENT_KEY[m[1]] ? t(MOVEMENT_KEY[m[1]], m[1]) : m[1];
  return t("msg.lastMovementPrefix", "Last movement: {movement}").replace("{movement}", movement);
}

const LANE_HALF = 30;       // half-width of a lane in world units
const CABINET_W = 20;
const CABINET_D = 40;
const CABINET_H = 30;
const SCREEN_Z = 84;        // height of the top info screen

const COL = {
  floor: "#eef1f6",
  floorEdge: "#e2e7ef",
  grid: "#dde3ec",
  matArrow: "#c7d0dd",
  wall: "#dfe4ec",
  wallDark: "#cbd3df",
  corridor: "#e7ebf2",
  metalTop: "#dbe1ea",
  metalFront: "#c0c8d4",
  metalSide: "#aeb8c6",
  metalLine: "#9aa4b4",
  glass: "rgba(120,180,220,0.42)",
  glassEdge: "#8fb7d8",
  screenBg: "#141a2b",
  screenEdge: "#0c1120",
  accent: "#6d5efc",
  navy: "#1e2a4a",
  text: "#1e2536",
};

const LIGHT_RGB = {
  [LIGHT.RED]: "#ef4444",
  [LIGHT.YELLOW]: "#f5b301",
  [LIGHT.GREEN]: "#22c55e",
  [LIGHT.BLUE]: "#8b5cf6",
  [LIGHT.OFF]: "#5b6472",
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = 1;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.time = 0;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(320, rect.width);
    const cssH = Math.max(320, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.cssW = cssW;
    this.cssH = cssH;

    const bw = WORLD_BOUNDS.maxX - WORLD_BOUNDS.minX;
    const bh = (WORLD_BOUNDS.maxY - WORLD_BOUNDS.minY) * SQUASH;
    const padX = 46;
    const padY = 40;
    this.scale = Math.min((cssW - padX * 2) / bw, (cssH - padY * 2) / bh);
    const usedW = bw * this.scale;
    const usedH = bh * this.scale;
    this.offsetX = (cssW - usedW) / 2 - WORLD_BOUNDS.minX * this.scale;
    this.offsetY = (cssH - usedH) / 2 - WORLD_BOUNDS.minY * SQUASH * this.scale;
  }

  toScreen(x, y, z = 0) {
    return {
      x: this.offsetX + x * this.scale,
      y: this.offsetY + y * SQUASH * this.scale - z * this.scale,
    };
  }

  roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  render(sim, dt) {
    this.time += dt;
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    this._floor();
    this._backWall(sim);
    this._securityDesk(sim);
    this._laneGuides(sim);

    // Layered, depth-sorted scene: gate cabinets (back), then a sorted list of
    // workers + gate fascias so passers-through sit between the posts.
    for (const g of sim.gates) this._gateBack(g);

    const items = [];
    for (const g of sim.gates) items.push({ depth: WORLD.gateLineY + 9, kind: "gateFront", g });
    for (const w of sim.workers) items.push({ depth: w.depth, kind: "worker", w });
    items.sort((a, b) => a.depth - b.depth);
    for (const it of items) {
      if (it.kind === "worker") this._worker(it.w, sim);
      else this._gateFront(it.g);
    }

    for (const g of sim.gates) this._gateScreen(g);
    ctx.restore();
  }

  // ---- environment --------------------------------------------------------
  _floor() {
    const ctx = this.ctx;
    const a = this.toScreen(WORLD_BOUNDS.minX, WORLD_BOUNDS.minY);
    const b = this.toScreen(WORLD_BOUNDS.maxX, WORLD_BOUNDS.maxY);
    const grad = ctx.createLinearGradient(0, a.y, 0, b.y);
    grad.addColorStop(0, "#e7ebf3");
    grad.addColorStop(1, COL.floor);
    ctx.fillStyle = grad;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);

    // grid
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= WORLD_BOUNDS.maxX; gx += 80) {
      const p1 = this.toScreen(gx, WORLD_BOUNDS.minY);
      const p2 = this.toScreen(gx, WORLD_BOUNDS.maxY);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }
    for (let gy = 0; gy <= WORLD_BOUNDS.maxY; gy += 80) {
      const p1 = this.toScreen(WORLD_BOUNDS.minX, gy);
      const p2 = this.toScreen(WORLD_BOUNDS.maxX, gy);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }

    // entrance mat band in front of gates
    const m1 = this.toScreen(WORLD.firstGateX - 60, WORLD.readerY + 8);
    const m2 = this.toScreen(LAST_GATE_X + 60, WORLD.queueStartY - 8);
    ctx.fillStyle = "rgba(109,94,252,0.05)";
    ctx.fillRect(m1.x, m1.y, m2.x - m1.x, m2.y - m1.y);
  }

  _backWall(sim) {
    const ctx = this.ctx;
    const wallY = WORLD.corridorY - 26;
    const left = this.toScreen(WORLD_BOUNDS.minX, wallY);
    const right = this.toScreen(WORLD_BOUNDS.maxX, wallY);
    const wallH = 58 * this.scale;
    // wall slab
    ctx.fillStyle = COL.wall;
    ctx.fillRect(left.x, left.y - wallH, right.x - left.x, wallH);
    ctx.fillStyle = COL.wallDark;
    ctx.fillRect(left.x, left.y - wallH, right.x - left.x, 8 * this.scale);
    // corridor opening behind the gates (glass doors)
    const cLeft = this.toScreen(WORLD.firstGateX - 40, wallY);
    const cRight = this.toScreen(LAST_GATE_X + 40, wallY);
    ctx.fillStyle = COL.corridor;
    ctx.fillRect(cLeft.x, cLeft.y - wallH + 8 * this.scale, cRight.x - cLeft.x, wallH - 8 * this.scale);

    // EMPLOYEE ENTRANCE banner
    const bx = this.toScreen((WORLD.firstGateX + LAST_GATE_X) / 2, wallY);
    ctx.save();
    ctx.fillStyle = COL.navy;
    const bw = (LAST_GATE_X - WORLD.firstGateX + 40) * this.scale;
    const bh = 22 * this.scale;
    this.roundRect(bx.x - bw / 2, bx.y - wallH - bh - 4, bw, bh, 4 * this.scale);
    ctx.fill();
    ctx.fillStyle = "#eef1ff";
    ctx.font = `700 ${Math.max(10, 12 * this.scale)}px 'Segoe UI',sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(t("scene.employeeEntrance", "EMPLOYEE ENTRANCE"), bx.x, bx.y - wallH - bh / 2 - 4);
    ctx.fillStyle = COL.accent;
    ctx.fillRect(bx.x - bw / 2, bx.y - wallH - 4, bw, 3 * this.scale);
    ctx.restore();

    // shift clock + factory tag on the wall
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const clockP = this.toScreen(WORLD.firstGateX - 30, wallY);
    ctx.fillStyle = "#0f1626";
    this.roundRect(clockP.x - 6, clockP.y - wallH + 6 * this.scale, 92 * this.scale, 20 * this.scale, 4 * this.scale);
    ctx.fill();
    ctx.fillStyle = "#5eead4";
    ctx.font = `700 ${Math.max(9, 11 * this.scale)}px 'Consolas',monospace`;
    ctx.fillText(sim.clockString(), clockP.x + 4, clockP.y - wallH + 20 * this.scale);
    ctx.restore();

    // security cameras
    this._camera(WORLD.firstGateX + 30, wallY - 4);
    this._camera(LAST_GATE_X - 30, wallY - 4);
    // EXIT sign
    this._exitSign(LAST_GATE_X + 70, wallY);
  }

  _camera(wx, wy) {
    const ctx = this.ctx;
    const p = this.toScreen(wx, wy, 58);
    ctx.save();
    ctx.fillStyle = "#3a4252";
    this.roundRect(p.x - 7 * this.scale, p.y, 14 * this.scale, 6 * this.scale, 2 * this.scale);
    ctx.fill();
    ctx.fillStyle = "#2a303c";
    this.roundRect(p.x + 4 * this.scale, p.y + 1 * this.scale, 7 * this.scale, 4 * this.scale, 1.5 * this.scale);
    ctx.fill();
    ctx.fillStyle = this.time % 1.6 < 0.8 ? "#ef4444" : "#7a2020";
    ctx.beginPath(); ctx.arc(p.x - 4 * this.scale, p.y + 3 * this.scale, 1.5 * this.scale, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  _exitSign(wx, wy) {
    const ctx = this.ctx;
    const p = this.toScreen(wx, wy, 46);
    ctx.save();
    ctx.fillStyle = "#15803d";
    this.roundRect(p.x - 16 * this.scale, p.y, 32 * this.scale, 12 * this.scale, 2 * this.scale);
    ctx.fill();
    ctx.fillStyle = "#eafff2";
    ctx.font = `700 ${Math.max(7, 8 * this.scale)}px 'Segoe UI',sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(t("scene.exit", "EXIT"), p.x, p.y + 6 * this.scale);
    ctx.restore();
  }

  _laneGuides(sim) {
    const ctx = this.ctx;
    for (const g of sim.gates) {
      // queue lane guide lines
      ctx.strokeStyle = "rgba(150,164,180,0.4)";
      ctx.lineWidth = 1;
      for (const off of [-LANE_HALF, LANE_HALF]) {
        const p1 = this.toScreen(g.x + off, WORLD.readerY);
        const p2 = this.toScreen(g.x + off, WORLD.spawnY - 20);
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      }
      // direction arrow (into the factory)
      const ap = this.toScreen(g.x, WORLD.queueStartY - 26);
      ctx.fillStyle = COL.matArrow;
      ctx.beginPath();
      ctx.moveTo(ap.x, ap.y - 6 * this.scale);
      ctx.lineTo(ap.x - 5 * this.scale, ap.y + 3 * this.scale);
      ctx.lineTo(ap.x + 5 * this.scale, ap.y + 3 * this.scale);
      ctx.closePath(); ctx.fill();

      // queue heatmap bar at the lane mouth
      const ql = g.queueLength;
      const heat = ql <= 3 ? "#22c55e" : ql <= 6 ? "#f5b301" : ql <= 9 ? "#f97316" : "#ef4444";
      const hb = this.toScreen(g.x - LANE_HALF + 4, WORLD.readerY + 6);
      ctx.fillStyle = "rgba(200,208,220,0.7)";
      this.roundRect(hb.x, hb.y, (2 * LANE_HALF - 8) * this.scale, 4 * this.scale, 2);
      ctx.fill();
      ctx.fillStyle = heat;
      const frac = Math.min(1, ql / 12);
      this.roundRect(hb.x, hb.y, (2 * LANE_HALF - 8) * this.scale * frac, 4 * this.scale, 2);
      ctx.fill();
    }
  }

  // ---- turnstile ----------------------------------------------------------
  _isoBox(cx, cy, w, d, h, top, front, side, line) {
    const ctx = this.ctx;
    const blB = this.toScreen(cx - w / 2, cy + d / 2, 0);
    const brB = this.toScreen(cx + w / 2, cy + d / 2, 0);
    const blT = this.toScreen(cx - w / 2, cy + d / 2, h);
    const brT = this.toScreen(cx + w / 2, cy + d / 2, h);
    const tlT = this.toScreen(cx - w / 2, cy - d / 2, h);
    const trT = this.toScreen(cx + w / 2, cy - d / 2, h);
    const trB = this.toScreen(cx + w / 2, cy - d / 2, 0);
    // right side
    ctx.fillStyle = side;
    ctx.beginPath();
    ctx.moveTo(brB.x, brB.y); ctx.lineTo(trB.x, trB.y); ctx.lineTo(trT.x, trT.y); ctx.lineTo(brT.x, brT.y);
    ctx.closePath(); ctx.fill();
    // front
    ctx.fillStyle = front;
    ctx.beginPath();
    ctx.moveTo(blB.x, blB.y); ctx.lineTo(brB.x, brB.y); ctx.lineTo(brT.x, brT.y); ctx.lineTo(blT.x, blT.y);
    ctx.closePath(); ctx.fill();
    // top
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.moveTo(blT.x, blT.y); ctx.lineTo(brT.x, brT.y); ctx.lineTo(trT.x, trT.y); ctx.lineTo(tlT.x, tlT.y);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.stroke();
  }

  _gateBack(g) {
    // rear cabinets (drawn before workers) — the far posts of the lane
    this._isoBox(g.x - LANE_HALF, WORLD.gateLineY - 6, CABINET_W, CABINET_D, CABINET_H,
      COL.metalTop, COL.metalFront, COL.metalSide, COL.metalLine);
    this._isoBox(g.x + LANE_HALF, WORLD.gateLineY - 6, CABINET_W, CABINET_D, CABINET_H,
      COL.metalTop, COL.metalFront, COL.metalSide, COL.metalLine);
  }

  _gateFront(g) {
    const ctx = this.ctx;
    // selection highlight footprint
    if (g.selected) {
      const c = this.toScreen(g.x, WORLD.gateLineY + 4);
      ctx.strokeStyle = COL.accent; ctx.lineWidth = 2;
      this.roundRect(c.x - (LANE_HALF + 14) * this.scale, c.y - 30 * this.scale,
        (2 * LANE_HALF + 28) * this.scale, 46 * this.scale, 6);
      ctx.stroke();
    }

    // flap gate: two glass panels across the lane, retracting as gateAngle->1
    const open = g.gateAngle;
    const panelLen = LANE_HALF * (1 - open) * 0.96;
    for (const dir of [-1, 1]) {
      const baseX = g.x + dir * LANE_HALF;
      const tipX = baseX - dir * panelLen;
      const b1 = this.toScreen(baseX, WORLD.gateLineY + 2, 2);
      const b2 = this.toScreen(baseX, WORLD.gateLineY + 2, 20);
      const t1 = this.toScreen(tipX, WORLD.gateLineY + 2, 2);
      const t2 = this.toScreen(tipX, WORLD.gateLineY + 2, 20);
      ctx.fillStyle = COL.glass;
      ctx.beginPath();
      ctx.moveTo(b1.x, b1.y); ctx.lineTo(t1.x, t1.y); ctx.lineTo(t2.x, t2.y); ctx.lineTo(b2.x, b2.y);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = COL.glassEdge; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // front cabinets (near posts)
    this._isoBox(g.x - LANE_HALF, WORLD.gateLineY + 10, CABINET_W, CABINET_D * 0.5, CABINET_H,
      COL.metalTop, COL.metalFront, COL.metalSide, COL.metalLine);
    this._isoBox(g.x + LANE_HALF, WORLD.gateLineY + 10, CABINET_W, CABINET_D * 0.5, CABINET_H,
      COL.metalTop, COL.metalFront, COL.metalSide, COL.metalLine);

    // card reader on the right near post
    const rd = this.toScreen(g.x + LANE_HALF - 4, WORLD.gateLineY + 16, CABINET_H - 4);
    ctx.fillStyle = "#2b3446";
    this.roundRect(rd.x - 5 * this.scale, rd.y - 8 * this.scale, 12 * this.scale, 10 * this.scale, 2 * this.scale);
    ctx.fill();
    // reader glow when reading a card
    if (g.light === LIGHT.BLUE) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 9);
      ctx.fillStyle = `rgba(139,92,246,${0.35 + pulse * 0.4})`;
      ctx.beginPath(); ctx.arc(rd.x + 1 * this.scale, rd.y - 3 * this.scale, 5 * this.scale, 0, Math.PI * 2); ctx.fill();
    }

    // status light on top of the left post
    this._statusLight(g);

    // number plate on the near-left post
    const np = this.toScreen(g.x - LANE_HALF, WORLD.gateLineY + 16, 10);
    ctx.fillStyle = COL.navy;
    this.roundRect(np.x - 9 * this.scale, np.y - 5 * this.scale, 18 * this.scale, 10 * this.scale, 2 * this.scale);
    ctx.fill();
    ctx.fillStyle = "#e9ecff";
    ctx.font = `700 ${Math.max(7, 8 * this.scale)}px 'Segoe UI',sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(g.label, np.x, np.y);
  }

  _statusLight(g) {
    const ctx = this.ctx;
    const p = this.toScreen(g.x + LANE_HALF, WORLD.gateLineY + 4, CABINET_H + 6);
    let on = true;
    if (g.light === LIGHT.YELLOW || g.light === LIGHT.RED) {
      on = Math.sin(g.blinkPhase) > -0.2; // blink while waiting / denied
    }
    const color = LIGHT_RGB[g.light] || LIGHT_RGB.off;
    if (on && g.light !== LIGHT.OFF) {
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4.5 * this.scale, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = "#4b5563";
      ctx.beginPath(); ctx.arc(p.x, p.y, 4.5 * this.scale, 0, Math.PI * 2); ctx.fill();
    }
    // small housing
    ctx.strokeStyle = "#6b7280"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(p.x, p.y, 5.5 * this.scale, 0, Math.PI * 2); ctx.stroke();
  }

  _gateScreen(g) {
    const ctx = this.ctx;
    const p = this.toScreen(g.x, WORLD.gateLineY - 4, SCREEN_Z);
    const w = 58 * this.scale;
    const h = 52 * this.scale;
    // supporting posts
    const post = this.toScreen(g.x, WORLD.gateLineY - 4, CABINET_H);
    ctx.strokeStyle = COL.metalLine; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(p.x - w / 2 + 4, p.y + h); ctx.lineTo(p.x - w / 2 + 4, post.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x + w / 2 - 4, p.y + h); ctx.lineTo(p.x + w / 2 - 4, post.y); ctx.stroke();

    // screen bezel + panel
    ctx.fillStyle = COL.screenEdge;
    this.roundRect(p.x - w / 2 - 2, p.y - 2, w + 4, h + 4, 4);
    ctx.fill();
    ctx.fillStyle = COL.screenBg;
    this.roundRect(p.x - w / 2, p.y, w, h, 3);
    ctx.fill();

    // screen content
    const m = g.message || {};
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (!m.name && !m.line) {
      ctx.fillStyle = "#3b4a63";
      ctx.font = `600 ${Math.max(7, 8 * this.scale)}px 'Segoe UI',sans-serif`;
      ctx.fillText(t("screen.ready", "READY"), p.x, p.y + h / 2);
    } else {
      const lineColor = this._screenLineColor(g);
      ctx.fillStyle = "#dfe6f5";
      ctx.font = `700 ${Math.max(7, 8.5 * this.scale)}px 'Segoe UI',sans-serif`;
      ctx.fillText(this._clip(m.name, 16), p.x, p.y + 12 * this.scale);
      ctx.fillStyle = "#8a99b5";
      ctx.font = `500 ${Math.max(6, 6.5 * this.scale)}px 'Segoe UI',sans-serif`;
      ctx.fillText(this._clip(gateSubText(m.sub), 22), p.x, p.y + 25 * this.scale);
      ctx.fillStyle = lineColor;
      ctx.font = `700 ${Math.max(6, 7.5 * this.scale)}px 'Consolas',monospace`;
      ctx.fillText(this._clip(gateLineText(m.line), 22), p.x, p.y + 40 * this.scale);
    }

    // loading dots while checking
    if (g.state === GATE_STATE.CHECKING) {
      const n = Math.floor(this.time * 3) % 4;
      ctx.fillStyle = "#f5b301";
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = i < n ? 1 : 0.25;
        ctx.beginPath(); ctx.arc(p.x - 6 * this.scale + i * 6 * this.scale, p.y + h - 3 * this.scale, 1.4 * this.scale, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  _screenLineColor(g) {
    switch (g.light) {
      case LIGHT.GREEN: return "#4ade80";
      case LIGHT.RED: return "#f87171";
      case LIGHT.BLUE: return "#c4b5fd";
      case LIGHT.YELLOW: return "#fbbf24";
      default: return "#94a3b8";
    }
  }

  _clip(s, n) { s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  // ---- workers ------------------------------------------------------------
  _worker(w, sim) {
    if (w.highlight || w === sim.selectedWorker) {
      const f = this.toScreen(w.pos.x, w.pos.y, 0);
      const ctx = this.ctx;
      ctx.strokeStyle = COL.accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(f.x, f.y, 12 * this.scale, 5 * this.scale, 0, 0, Math.PI * 2); ctx.stroke();
    }
    drawPerson(this, w.pos.x, w.pos.y, w.appearance, w.pose());
  }

  // ---- security / manual review ------------------------------------------
  _securityDesk(sim) {
    const ctx = this.ctx;
    // desk
    this._isoBox(SECURITY.deskX, SECURITY.deskY, 46, 30, 18,
      "#e6d9c4", "#cdbb9c", "#b9a684", "#9c8a6c");
    // monitor
    const mon = this.toScreen(SECURITY.deskX - 8, SECURITY.deskY - 6, 22);
    ctx.fillStyle = "#1f2937";
    this.roundRect(mon.x - 8 * this.scale, mon.y - 10 * this.scale, 16 * this.scale, 11 * this.scale, 2);
    ctx.fill();
    ctx.fillStyle = "#8b5cf6";
    this.roundRect(mon.x - 6 * this.scale, mon.y - 8 * this.scale, 12 * this.scale, 7 * this.scale, 1);
    ctx.fill();
    // guard (static person behind the desk)
    if (!this._guard) {
      this._guard = { skin: "#d29b6e", hair: "#2a2320", hairStyle: "cap", shirt: "#3a4252", pants: "#22262f", heightScale: 1.05 };
    }
    drawPerson(this, SECURITY.deskX + 6, SECURITY.deskY - 18, this._guard, { facing: "down", moving: false, walkPhase: 0, armAction: null, carry: null });

    // MANUAL REVIEW label + purple indicator
    const lp = this.toScreen(SECURITY.deskX, SECURITY.deskY + 22);
    ctx.fillStyle = COL.navy;
    this.roundRect(lp.x - 40 * this.scale, lp.y, 80 * this.scale, 14 * this.scale, 3);
    ctx.fill();
    ctx.fillStyle = "#ddd6fe";
    ctx.font = `700 ${Math.max(7, 8 * this.scale)}px 'Segoe UI',sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(t("chip.manual", "MANUAL REVIEW"), lp.x, lp.y + 7 * this.scale);
    const dot = this.toScreen(SECURITY.deskX - 46, SECURITY.deskY + 7);
    ctx.fillStyle = this.time % 1.4 < 0.7 ? "#8b5cf6" : "#5b3fb0";
    ctx.beginPath(); ctx.arc(dot.x, dot.y, 3 * this.scale, 0, Math.PI * 2); ctx.fill();
  }

  // ---- picking ------------------------------------------------------------
  pickGate(sim, sx, sy) {
    let best = null, bestD = 42;
    for (const g of sim.gates) {
      const p = this.toScreen(g.x, WORLD.gateLineY);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  pickWorker(sim, sx, sy) {
    let best = null, bestD = 22;
    for (const w of sim.workers) {
      const p = this.toScreen(w.pos.x, w.pos.y, 24);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bestD) { bestD = d; best = w; }
    }
    return best;
  }
}
