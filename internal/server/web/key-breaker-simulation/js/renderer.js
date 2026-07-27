// renderer.js — draws the whole scene onto the canvas. Separates simulation state
// from rendering: it only reads sim/world and never mutates game logic.

import { VIEW } from "./config.js";
import { drawShield } from "./shield.js";
import { drawKeyBreaker } from "./key-breaker.js";
import { drawGateway } from "./gateway.js";
import { drawDatabase } from "./database.js";
import { drawAttacker } from "./attacker.js";
import { drawAttackPacket } from "./attack-packet.js";
import { drawSafeQuery } from "./query.js";
import { drawThreatAnalysis } from "./threat-analysis.js";

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.scale = 1; this.offX = 0; this.offY = 0;
    this.time = 0;
    this._initMatrix();
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.cssW = r.width; this.cssH = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    // contain-fit VIEW into canvas
    this.scale = Math.min(r.width / VIEW.W, r.height / VIEW.H);
    this.offX = (r.width - VIEW.W * this.scale) / 2;
    this.offY = (r.height - VIEW.H * this.scale) / 2;
  }

  // screen (CSS px relative to canvas) -> virtual VIEW coords
  screenToWorld(sx, sy) {
    return { x: (sx - this.offX) / this.scale, y: (sy - this.offY) / this.scale };
  }

  _initMatrix() {
    // Matrix-movie style digital rain: dense columns of glyphs falling on a
    // per-cell grid, bright white-green leading char + fading green trail.
    this.MTX = { cell: 17, step: 0.055 };           // glyph size + reveal cadence
    const cols = Math.ceil(VIEW.W / this.MTX.cell) + 1;
    const rows = Math.ceil(VIEW.H / this.MTX.cell) + 2;
    this.mRows = rows;
    // Katakana + latin + digits — the classic Matrix glyph mix.
    this._glyphs = ("ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾚﾛﾜﾝ" +
      "0123456789ABCDEFZ$+*<>=|/\\").split("");
    const g = () => this._glyphs[(Math.random() * this._glyphs.length) | 0];
    this.cols = [];
    for (let i = 0; i < cols; i++) {
      this.cols.push({
        x: i * this.MTX.cell + this.MTX.cell * 0.15,
        head: Math.random() * -rows,                // start above screen, staggered
        speed: 7 + Math.random() * 22,              // rows per second
        trail: 8 + (Math.random() * 16 | 0),        // trail length in cells
        acc: 0,
        bright: 0.5 + Math.random() * 0.5,
        chars: Array.from({ length: rows }, g),      // per-cell glyph
      });
    }
    this._mtxG = g;
  }

  _updateMatrix(dt) {
    for (const c of this.cols) {
      c.head += c.speed * dt;
      // occasionally mutate a glyph in the trail (flicker)
      c.acc += dt;
      if (c.acc > this.MTX.step) {
        c.acc = 0;
        const idx = (Math.random() * this.mRows) | 0;
        c.chars[idx] = this._mtxG();
      }
      if (c.head - c.trail > this.mRows) {
        // respawn column above the top
        c.head = -Math.random() * 6;
        c.speed = 7 + Math.random() * 22;
        c.trail = 8 + (Math.random() * 16 | 0);
        c.bright = 0.5 + Math.random() * 0.5;
      }
    }
  }

  render(world, sim) {
    const dt = 1 / 60;
    this.time += dt * (sim.paused ? 0 : 1);
    if (!sim.paused) this._updateMatrix(dt);
    const ctx = this.ctx;
    const t = this.time;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.save();
    ctx.translate(this.offX, this.offY);
    ctx.scale(this.scale, this.scale);
    // clip to view
    ctx.beginPath(); ctx.rect(0, 0, VIEW.W, VIEW.H); ctx.clip();

    this._drawBackground(ctx);
    this._drawMatrix(ctx);
    this._drawNetwork(ctx, world, sim);
    if (sim.showPaths !== false) this._drawAttackPaths(ctx, sim);
    if (sim.showSafe !== false) this._drawSafeLane(ctx, world);

    // attackers
    for (const a of world.attackers) {
      const sel = sim.selection.type === "attacker" && sim.selection.ref === a;
      drawAttacker(ctx, a, t, sel);
    }

    // gateway + database (right)
    drawGateway(ctx, world, sim, t);
    drawDatabase(ctx, world, sim, t);

    // safe queries
    if (sim.showSafe !== false)
      for (const q of sim.safePackets) if (!q.dead) drawSafeQuery(ctx, q, t);

    // hero + shield (center)
    drawKeyBreaker(ctx, world, sim, t);
    drawShield(ctx, world, sim, t);

    // attack packets (in front, they impact the shield face)
    for (const p of sim.attackPackets) if (!p.dead) drawAttackPacket(ctx, p, t);

    // particles
    if (sim.showParticles !== false) sim.particles.draw(ctx);

    // threat analysis rail
    if (sim.showThreat !== false) drawThreatAnalysis(ctx, world, sim, t);

    this._drawZoneLabels(ctx);

    ctx.restore();
  }

  _drawBackground(ctx) {
    const g = ctx.createLinearGradient(0, 0, VIEW.W, VIEW.H);
    g.addColorStop(0, "#04070d");
    g.addColorStop(0.5, "#050b14");
    g.addColorStop(1, "#03060b");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);
    // central green glow behind hero
    const r = ctx.createRadialGradient(VIEW.W * 0.46, VIEW.H * 0.5, 40, VIEW.W * 0.46, VIEW.H * 0.5, 520);
    r.addColorStop(0, "rgba(20,70,52,0.25)");
    r.addColorStop(1, "rgba(20,70,52,0)");
    ctx.fillStyle = r;
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);
  }

  _drawMatrix(ctx) {
    const cell = this.MTX.cell;
    ctx.save();
    ctx.font = `${cell - 3}px 'Consolas', monospace`;
    ctx.textBaseline = "top";
    for (const c of this.cols) {
      const headRow = Math.floor(c.head);
      for (let k = 0; k < c.trail; k++) {
        const row = headRow - k;
        if (row < 0 || row > this.mRows) continue;
        const y = row * cell;
        const ch = c.chars[row] || "0";
        if (k === 0) {
          // leading glyph — bright, almost white with green glow
          ctx.fillStyle = `rgba(200,255,225,${0.85 * c.bright})`;
          ctx.shadowColor = "rgba(60,255,170,0.9)";
          ctx.shadowBlur = 8;
          ctx.fillText(ch, c.x, y);
          ctx.shadowBlur = 0;
        } else if (k === 1) {
          // second glyph slightly brighter for a crisp "tip"
          ctx.fillStyle = `rgba(90,255,180,${0.5 * c.bright})`;
          ctx.fillText(ch, c.x, y);
        } else {
          const a = (1 - k / c.trail) * 0.38 * c.bright;
          ctx.fillStyle = `rgba(38,225,140,${a})`;
          ctx.fillText(ch, c.x, y);
        }
      }
    }
    ctx.restore();
  }

  _drawNetwork(ctx, world, sim) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(60,120,110,0.08)";
    for (const a of world.attackers) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(world.shield.cx - world.shield.r * 0.7, world.shield.cy);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawAttackPaths(ctx, sim) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    for (const p of sim.attackPackets) {
      if (p.dead || p.blocked) continue;
      ctx.beginPath();
      ctx.moveTo(p.p0.x, p.p0.y);
      ctx.quadraticCurveTo(p.p1.x, p.p1.y, p.p2.x, p.p2.y);
      ctx.strokeStyle = "rgba(255,77,94,0.12)";
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawSafeLane(ctx, world) {
    ctx.save();
    const y = world.safeLaneY;
    const x0 = world.gatewayCore.x - 160, x1 = world.database.x - 60;
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, "rgba(45,212,191,0.02)");
    g.addColorStop(0.5, "rgba(45,212,191,0.12)");
    g.addColorStop(1, "rgba(45,212,191,0.03)");
    ctx.fillStyle = g;
    ctx.fillRect(x0, y - 26, x1 - x0, 52);
    ctx.strokeStyle = "rgba(45,212,191,0.22)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 8]);
    ctx.beginPath(); ctx.moveTo(x0, y - 26); ctx.lineTo(x1, y - 26); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x0, y + 26); ctx.lineTo(x1, y + 26); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(120,230,205,0.5)";
    ctx.font = "700 10px 'Segoe UI'";
    ctx.fillText("SAFE QUERY LANE → DATABASE", x0 + 8, y - 32);
    ctx.restore();
  }

  _drawZoneLabels(ctx) {
    ctx.save();
    ctx.font = "700 11px 'Segoe UI'";
    ctx.fillStyle = "rgba(255,120,130,0.55)";
    ctx.fillText("EXTERNAL ATTACKERS", 40, 108);
    ctx.fillStyle = "rgba(120,230,205,0.55)";
    ctx.textAlign = "right";
    ctx.fillText("DATABASE SERVER", VIEW.W - 40, 108);
    ctx.textAlign = "left";
    ctx.restore();
  }
}
