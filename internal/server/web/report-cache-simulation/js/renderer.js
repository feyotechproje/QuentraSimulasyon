// renderer.js — draws the whole scene each frame. Reads world + sim state only;
// it does not know whether data is in-memory or from a backend.

import { WORLD, COLORS } from "./config.js";
import { roundRect, shadowEllipse, drawPerson, drawScreen, miniGauge } from "./draw.js";
import { SCREEN, bezier } from "./models.js";
import { tileRect } from "./world.js";
import { QuentraI18n } from "/shared/quentra-i18n.js";

const t = (k, f) => QuentraI18n.t(k, f);
const locLabel = (loc) => t("loc." + loc.id, loc.name);
function sqlStateKey(state) {
  if (state === "IDLE") return "idle";
  if (state === "HEAVY LOAD") return "heavy";
  if (state === "EXECUTING") return "executing";
  return "idle";
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = 1;
    this.scale = 1; this.ox = 0; this.oy = 0;
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.cssW = r.width; this.cssH = r.height;
    // contain WORLD inside canvas
    this.scale = Math.min(r.width / WORLD.w, r.height / WORLD.h);
    this.ox = (r.width - WORLD.w * this.scale) / 2;
    this.oy = (r.height - WORLD.h * this.scale) / 2;
  }

  worldToScreen(x, y) { return { x: this.ox + x*this.scale, y: this.oy + y*this.scale }; }
  screenToWorld(x, y) { return { x: (x - this.ox)/this.scale, y: (y - this.oy)/this.scale }; }

  render(world, sim) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    // world transform
    ctx.save();
    ctx.translate(this.ox, this.oy); ctx.scale(this.scale, this.scale);

    this._bg(ctx);
    this._paths(ctx, world, sim);
    this._center(ctx, world, sim);
    this._locations(ctx, world, sim);
    this._packets(ctx, world, sim);

    ctx.restore();
  }

  // ---- layers ----
  _bg(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, WORLD.h);
    g.addColorStop(0, "#f4f7ff"); g.addColorStop(1, "#eaeef8");
    ctx.fillStyle = g; ctx.fillRect(0, 0, WORLD.w, WORLD.h);
    // faint dotted operations grid
    ctx.fillStyle = "rgba(120,135,175,.10)";
    for (let x=40; x<WORLD.w; x+=48)
      for (let y=40; y<WORLD.h; y+=48){ ctx.beginPath(); ctx.arc(x, y, 1.1, 0, 7); ctx.fill(); }
    // soft central region glow
    const rg = ctx.createRadialGradient(830, 470, 60, 830, 470, 460);
    rg.addColorStop(0, "rgba(109,92,245,.07)"); rg.addColorStop(1, "rgba(109,92,245,0)");
    ctx.fillStyle = rg; ctx.fillRect(0, 0, WORLD.w, WORLD.h);
  }

  _paths(ctx, world, sim) {
    for (const p of world.paths) {
      const loc = world.locations.find(l => l.id === p.locId);
      const busy = loc ? Math.min(1, loc.pending * 0.5) : 0;
      ctx.lineWidth = 2 + busy*2.5;
      ctx.strokeStyle = "rgba(150,165,205,.5)";
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(p.a.x, p.a.y);
      ctx.quadraticCurveTo(p.c.x, p.c.y, p.b.x, p.b.y); ctx.stroke();
    }
    // gateway <-> sql and gateway <-> cache trunk lines
    const { gateway, cache, sql } = world.nodes;
    // gateway to sql — thickness = sql load
    ctx.strokeStyle = sim.sql.heat > .4 ? "rgba(245,158,11,.6)" : "rgba(150,165,205,.6)";
    ctx.lineWidth = 3 + sim.sql.heat*7;
    ctx.beginPath(); ctx.moveTo(gateway.x+gateway.w, gateway.cy); ctx.lineTo(sql.x, sql.cy-40); ctx.stroke();
    // gateway to cache
    ctx.strokeStyle = sim.mode === "cache" ? "rgba(20,184,166,.6)" : "rgba(150,165,205,.35)";
    ctx.lineWidth = 3 + (sim.mode==="cache"? sim.cache.pulse*5 : 0);
    ctx.beginPath(); ctx.moveTo(gateway.cx, gateway.y+gateway.h); ctx.lineTo(cache.cx, cache.y); ctx.stroke();
  }

  _center(ctx, world, sim) {
    const { gateway, cache, sql } = world.nodes;
    this._sqlRack(ctx, sql, sim);
    this._gateway(ctx, gateway, sim);
    this._cache(ctx, cache, sim);
  }

  _gateway(ctx, n, sim) {
    shadowEllipse(ctx, n.cx, n.y+n.h+6, n.w*0.5, 12);
    const g = ctx.createLinearGradient(n.x, n.y, n.x, n.y+n.h);
    g.addColorStop(0, "#5b53e8"); g.addColorStop(1, "#7c3aed");
    ctx.fillStyle = g; roundRect(ctx, n.x, n.y, n.w, n.h, 16); ctx.fill();
    if (sim.selected === "gateway") this._ring(ctx, n);
    ctx.fillStyle = "rgba(255,255,255,.95)";
    ctx.font = "700 15px Inter, sans-serif"; ctx.textBaseline = "top"; ctx.textAlign="left";
    ctx.fillText(t("canvas.gateway.name","QUENTRA"), n.x+16, n.y+14);
    ctx.font = "600 10px Inter, sans-serif"; ctx.fillStyle = "rgba(255,255,255,.8)";
    ctx.fillText(t("canvas.gateway.sub","INTELLIGENT SQL GATEWAY"), n.x+16, n.y+33);
    // modules
    const mods = [
      [t("canvas.gateway.requestRouter","Request Router"), true, false],
      [t("canvas.gateway.queryFingerprint","Query Fingerprint"), true, false],
      [t("canvas.gateway.cacheLookup","Cache Lookup"), sim.mode === "cache", true],
      [t("canvas.gateway.responseCache","Response Cache"), sim.mode === "cache", false],
    ];
    let my = n.y+50;
    for (const [label, on, isLookup] of mods) {
      ctx.fillStyle = on ? "rgba(94,234,212,.95)" : "rgba(255,255,255,.35)";
      ctx.beginPath(); ctx.arc(n.x+20, my+5, 3.5, 0, 7); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.font = "600 10px Inter, sans-serif";
      ctx.fillText(label, n.x+30, my);
      ctx.textAlign="right"; ctx.fillStyle = on ? "#5eead4" : "rgba(255,255,255,.55)";
      ctx.font = "700 8px SFMono-Regular, monospace";
      ctx.fillText(isLookup ? (on?t("canvas.val.active","ACTIVE"):t("canvas.val.bypass","BYPASS")) : (on?t("canvas.val.on","ON"):t("canvas.val.off","—")), n.x+n.w-14, my);
      ctx.textAlign="left";
      my += 15;
    }
  }

  _cache(ctx, n, sim) {
    shadowEllipse(ctx, n.cx, n.y+n.h+6, n.w*0.5, 12);
    const active = sim.mode === "cache" && sim.cache.state !== "EMPTY";
    ctx.save();
    const g = ctx.createLinearGradient(n.x, n.y, n.x, n.y+n.h);
    if (active){ g.addColorStop(0, "rgba(20,184,166,.22)"); g.addColorStop(1, "rgba(124,58,237,.22)"); }
    else { g.addColorStop(0, "rgba(200,210,235,.5)"); g.addColorStop(1, "rgba(200,210,235,.3)"); }
    ctx.fillStyle = g; roundRect(ctx, n.x, n.y, n.w, n.h, 14); ctx.fill();
    ctx.lineWidth = 1.5 + (active? sim.cache.pulse*3 : 0);
    ctx.strokeStyle = active ? `rgba(20,184,166,${.5+sim.cache.pulse*.5})` : "rgba(150,165,205,.5)";
    roundRect(ctx, n.x, n.y, n.w, n.h, 14); ctx.stroke();
    if (sim.selected === "cache") this._ring(ctx, n);
    ctx.fillStyle = COLORS.ink; ctx.font = "700 13px Inter, sans-serif";
    ctx.textBaseline="top"; ctx.textAlign="left";
    ctx.fillText(t("canvas.cache.name","QUENTRA CACHE"), n.x+14, n.y+12);
    ctx.font = "600 9px SFMono-Regular, monospace"; ctx.fillStyle = COLORS.ink3;
    ctx.fillText(sim.cache.cacheKey || "report:—", n.x+14, n.y+30);

    // stored report snapshot card
    if (active) {
      const cx = n.x+16, cy = n.y+46, cw = n.w-32, ch = 58;
      ctx.fillStyle = "#fff"; roundRect(ctx, cx, cy, cw, ch, 8); ctx.fill();
      ctx.strokeStyle = "rgba(20,184,166,.4)"; ctx.lineWidth = 1.5; roundRect(ctx, cx, cy, cw, ch, 8); ctx.stroke();
      drawScreen(ctx, cx+6, cy+6, cw-12, ch-12, SCREEN.READY, 1, "mini", "cache", sim.time);
      ctx.fillStyle = "#0d9488"; ctx.font = "700 9px Inter, sans-serif"; ctx.textAlign="left";
      ctx.fillText(t("canvas.cache.ready","READY"), n.x+14, n.y+n.h-20);
      ctx.textAlign="right"; ctx.fillStyle = COLORS.ink2; ctx.font="700 9px SFMono-Regular, monospace";
      ctx.fillText(t("canvas.cache.hits","HITS")+" "+sim.cache.hits, n.x+n.w-14, n.y+n.h-20);
      ctx.textAlign="left";
    } else {
      ctx.fillStyle = COLORS.ink3; ctx.font = "600 11px Inter, sans-serif";
      ctx.fillText(sim.mode==="cache" ? t("canvas.cache.lookupMiss","LOOKUP: MISS — warming…") : t("canvas.cache.disabled","Cache disabled (baseline)"), n.x+16, n.y+58);
    }
    ctx.restore();
  }

  _sqlRack(ctx, n, sim) {
    shadowEllipse(ctx, n.cx, n.y+n.h+6, n.w*0.5, 14);
    const heat = sim.sql.heat;
    // heat halo
    if (heat > 0.05) {
      const hg = ctx.createRadialGradient(n.cx, n.cy, 20, n.cx, n.cy, 170);
      const c = heat > 0.6 ? "239,68,68" : "245,158,11";
      hg.addColorStop(0, `rgba(${c},${0.28*heat})`); hg.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = hg; ctx.fillRect(n.x-100, n.y-100, n.w+200, n.h+200);
    }
    const g = ctx.createLinearGradient(n.x, n.y, n.x, n.y+n.h);
    g.addColorStop(0, "#2a3350"); g.addColorStop(1, "#1c2338");
    ctx.fillStyle = g; roundRect(ctx, n.x, n.y, n.w, n.h, 14); ctx.fill();
    if (sim.selected === "sql") this._ring(ctx, n);
    // rack units
    ctx.fillStyle = "rgba(255,255,255,.06)";
    for (let i=0;i<4;i++){ roundRect(ctx, n.x+10, n.y+40+i*12, n.w-20, 8, 2); ctx.fill(); }
    // blinking rack LEDs
    for (let i=0;i<4;i++){
      const on = ((sim.time*3 + i) % 2) < (0.5 + heat);
      ctx.fillStyle = on ? (heat>.6?"#ff6b6b":"#ffcf6b") : "rgba(255,255,255,.2)";
      ctx.beginPath(); ctx.arc(n.x+n.w-18, n.y+44+i*12, 2, 0, 7); ctx.fill();
    }
    ctx.fillStyle = "#fff"; ctx.font = "700 13px Inter, sans-serif"; ctx.textBaseline="top"; ctx.textAlign="left";
    ctx.fillText(t("canvas.sql.name","SQL SERVER"), n.x+14, n.y+12);
    ctx.font="600 9px SFMono-Regular, monospace"; ctx.fillStyle = heat>.5?"#ffb4a1":"#8fa0c8";
    ctx.textAlign="right"; ctx.fillText(t("sqlState."+sqlStateKey(sim.sql.state), sim.sql.state), n.x+n.w-14, n.y+15); ctx.textAlign="left";

    // gauges — real host/instance load when live mode is feeding it
    const hl = sim.hostLoad;
    const gCpu  = hl ? hl.cpu  : sim.sql.cpu;
    const gDisk = hl ? hl.disk : sim.sql.diskReads;
    let gy = n.y+104;
    miniGauge(ctx, n.x+14, gy, n.w-28, t("canvas.sql.cpu","CPU"), gCpu, gCpu>70?"#ef4444":"#f59e0b"); gy+=22;
    miniGauge(ctx, n.x+14, gy, n.w-28, t("canvas.sql.diskReads","Disk Reads"), gDisk, gDisk>70?"#ef4444":"#f59e0b"); gy+=22;
    miniGauge(ctx, n.x+14, gy, n.w-28, t("canvas.sql.activeQueries","Active Queries"), Math.min(100, sim.sql.activeQueries*8), "#a5b4fc"); gy+=8;

    // running query cards (same RPT id repeated) — shows re-execution
    const cards = sim.sql.runningCards.slice(0, 3);
    let ry = n.y+n.h+14;
    ctx.textAlign="left";
    for (const c of cards) {
      const cw = 118, ch = 30, cx = n.x+n.w+16;
      ctx.fillStyle = "#fff"; ctx.strokeStyle = "rgba(245,158,11,.5)"; ctx.lineWidth=1.5;
      roundRect(ctx, cx, ry-40-cards.indexOf(c)*36, cw, ch, 7); ctx.fill(); ctx.stroke();
    }
    // Draw stacked cards to the right of rack
    let cardY = n.y;
    for (let i=0;i<cards.length;i++){
      const c = cards[i];
      const cw=124, ch=32, cx=n.x+n.w+18, cyy=cardY+i*38;
      ctx.fillStyle="#fff"; roundRect(ctx,cx,cyy,cw,ch,7); ctx.fill();
      ctx.strokeStyle="rgba(245,158,11,.55)"; ctx.lineWidth=1.4; roundRect(ctx,cx,cyy,cw,ch,7); ctx.stroke();
      ctx.fillStyle=COLORS.ink; ctx.font="700 10px SFMono-Regular, monospace";
      ctx.fillText("RPT-2026-0042", cx+8, cyy+6);
      ctx.fillStyle="#b45309"; ctx.font="700 8px Inter, sans-serif";
      ctx.fillText(t("canvas.sql.running","RUNNING"), cx+8, cyy+19);
      ctx.textAlign="right"; ctx.fillStyle=COLORS.ink2; ctx.font="700 8px SFMono-Regular, monospace";
      ctx.fillText(c.elapsed.toFixed(1)+"s", cx+cw-8, cyy+19); ctx.textAlign="left";
    }
    // same-query counter
    ctx.fillStyle = COLORS.ink2; ctx.font="700 10px Inter, sans-serif";
    ctx.fillText(t("canvas.sql.sameQueryExec","SAME QUERY EXECUTIONS"), n.x+n.w+18, n.y+cards.length*38+8);
    ctx.fillStyle = sim.mode==="cache" ? "#0d9488" : "#b45309"; ctx.font="800 22px SFMono-Regular, monospace";
    ctx.fillText(String(sim.sql.sameQueryRuns), n.x+n.w+18, n.y+cards.length*38+22);
  }

  _ring(ctx, n) {
    ctx.save(); ctx.strokeStyle = COLORS.purple; ctx.lineWidth = 3; ctx.setLineDash([6,5]);
    roundRect(ctx, n.x-6, n.y-6, n.w+12, n.h+12, 18); ctx.stroke(); ctx.restore();
  }

  // ---- locations ----
  _locations(ctx, world, sim) {
    // y-sort so lower tiles overlap higher ones naturally
    const sorted = [...world.locations].sort((a,b)=>a.y-b.y);
    for (const loc of sorted) this._locationTile(ctx, loc, sim);
  }

  _locationTile(ctx, loc, sim) {
    const r = loc.tile;
    shadowEllipse(ctx, loc.x, r.y+r.h-4, r.w*0.42, 12);
    // tile card
    ctx.fillStyle = "#ffffff"; roundRect(ctx, r.x, r.y, r.w, r.h, 16); ctx.fill();
    this._requestBorder(ctx, loc, sim, r);

    // environment backdrop
    this._environment(ctx, loc);

    // header label
    ctx.fillStyle = COLORS.ink; ctx.font = "700 13px Inter, sans-serif";
    ctx.textBaseline="top"; ctx.textAlign="left";
    ctx.fillText(locLabel(loc), r.x+14, r.y+11);
    ctx.font="600 10px Inter, sans-serif"; ctx.fillStyle = COLORS.ink3;
    ctx.fillText(`${loc.users} ${t("canvas.loc.users","users")}`, r.x+14, r.y+28);
    // data source chip
    const src = loc.dataSource;
    const chipW = 46, chipX = r.x+r.w-chipW-12, chipY = r.y+12;
    ctx.fillStyle = src==="cache" ? "rgba(20,184,166,.12)" : "rgba(245,158,11,.12)";
    roundRect(ctx, chipX, chipY, chipW, 16, 5); ctx.fill();
    ctx.fillStyle = src==="cache" ? "#0d9488" : "#b45309"; ctx.font="700 8px SFMono-Regular, monospace";
    ctx.textAlign="center"; ctx.fillText(src==="cache"?t("canvas.loc.cache","CACHE"):t("canvas.loc.sql","SQL"), chipX+chipW/2, chipY+4); ctx.textAlign="left";

    // extras (background crowd)
    for (const e of loc.extras) {
      drawPerson(ctx, { x: loc.hero.sx + e.dx*1.6, y: r.y+r.h-16, scale:0.42, app:e.app,
        pose:"stand", t: loc.t + e.phase });
    }
    // hero + device scene
    this._deviceScene(ctx, loc, sim);
    // waiting marker sits on top of the scene so the device never covers it
    this._waitingMarker(ctx, loc);
  }

  /**
   * Marks the user who is still waiting for a report: a blinking red rectangle
   * around the hero figure plus a small hourglass. Drawn after the device scene
   * so nothing occludes it, and cleared the moment the report lands.
   */
  _waitingMarker(ctx, loc) {
    const h = loc.hero;
    if (h.screen !== SCREEN.LOADING && h.screen !== SCREEN.TIMEOUT) return;

    // Same phase as the tile border, so the two pulse together instead of
    // beating against each other.
    const blink = 0.55 + 0.45 * Math.sin(loc.t * 7);
    const alpha = 0.45 + blink * 0.55;

    // Box around the figure+device. Seated poses sit lower in the tile than
    // standing ones, so the top edge follows the pose rather than being fixed.
    const bx = h.sx - 52, bw = 104;
    const by = h.sy - (h.device === "desktop" || h.device === "laptop" ? 58 : 74);
    const bh = h.sy - by + 26;

    ctx.save();
    ctx.strokeStyle = `rgba(239,68,68,${alpha})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = -loc.t * 18;   // slow crawl reads as "in progress"
    roundRect(ctx, bx, by, bw, bh, 10); ctx.stroke();
    ctx.restore();

    this._hourglass(ctx, bx + bw - 11, by - 3, 1, loc.t, alpha);
  }

  /**
   * Small hourglass glyph: two triangles, a draining upper chamber and a
   * filling lower one, flipping once per cycle. Pure canvas — no glyph font,
   * because the emoji hourglass renders differently on every platform.
   */
  _hourglass(ctx, cx, cy, s, time, alpha) {
    const w = 9 * s, hh = 6 * s;          // half width / half height
    const cycle = (time * 0.5) % 1;        // 2s per full turn
    const drain = cycle;                   // 0 = full top, 1 = empty top

    ctx.save();
    ctx.translate(cx, cy);
    // Flip in the last fifth of the cycle so the sand visibly resets.
    if (cycle > 0.8) ctx.rotate(Math.PI * ((cycle - 0.8) / 0.2));

    // badge backdrop keeps the glyph legible over any environment colour
    ctx.fillStyle = `rgba(255,255,255,${0.85 * alpha})`;
    ctx.beginPath(); ctx.arc(0, 0, w * 1.15, 0, Math.PI * 2); ctx.fill();

    const red = `rgba(239,68,68,${alpha})`;
    // frame: top and bottom caps
    ctx.strokeStyle = red; ctx.lineWidth = 1.6 * s; ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-w * 0.55, -hh); ctx.lineTo(w * 0.55, -hh);
    ctx.moveTo(-w * 0.55,  hh); ctx.lineTo(w * 0.55,  hh);
    ctx.stroke();
    // glass outline: two triangles meeting at the neck
    ctx.beginPath();
    ctx.moveTo(-w * 0.5, -hh); ctx.lineTo(w * 0.5, -hh); ctx.lineTo(0, 0); ctx.closePath();
    ctx.moveTo(-w * 0.5,  hh); ctx.lineTo(w * 0.5,  hh); ctx.lineTo(0, 0); ctx.closePath();
    ctx.stroke();

    // sand: upper chamber shrinks toward the neck, lower one grows from the base
    ctx.fillStyle = red;
    const topH = hh * (1 - drain);
    if (topH > 0.4) {
      const topW = w * 0.5 * (topH / hh);
      ctx.beginPath();
      ctx.moveTo(-topW, -topH); ctx.lineTo(topW, -topH); ctx.lineTo(0, 0);
      ctx.closePath(); ctx.fill();
    }
    const botH = hh * drain;
    if (botH > 0.4) {
      const botW = w * 0.5 * (botH / hh);
      ctx.beginPath();
      ctx.moveTo(-botW, hh); ctx.lineTo(botW, hh);
      ctx.lineTo(botW * 0.15, hh - botH); ctx.lineTo(-botW * 0.15, hh - botH);
      ctx.closePath(); ctx.fill();
    }
    // falling grain
    if (drain > 0.05 && drain < 0.95) {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, hh * 0.72);
      ctx.lineWidth = 1 * s; ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Tile border, driven by where this user's report request currently is:
   * red + blinking while the request is out (LOADING), solid green once the
   * report has arrived (READY), neutral when idle. Selection still wins, so
   * clicking a tile never loses its highlight to the request state.
   */
  _requestBorder(ctx, loc, sim, r) {
    const screen = loc.hero.screen;
    let color = "#e3e8f2", width = 1.4;

    if (screen === SCREEN.LOADING || screen === SCREEN.TIMEOUT) {
      // Blink via a smooth alpha ramp rather than an on/off toggle: at 60fps a
      // hard toggle reads as flicker, and the ramp survives frame drops.
      const blink = 0.55 + 0.45 * Math.sin(loc.t * 7);
      color = `rgba(239,68,68,${0.45 + blink * 0.55})`;
      width = 2.5 + blink * 1.5;
    } else if (screen === SCREEN.READY) {
      color = "#16a34a";
      width = 2.5;
    }

    if (loc.id === sim.selected) { color = COLORS.purple; width = Math.max(width, 2.5); }

    ctx.save();
    // Glow only while a request is in flight — it is what draws the eye to the
    // user still waiting, and a steady green tile should stay calm.
    if (screen === SCREEN.LOADING || screen === SCREEN.TIMEOUT) {
      ctx.shadowColor = "rgba(239,68,68,.55)"; ctx.shadowBlur = 12;
    }
    ctx.strokeStyle = color; ctx.lineWidth = width;
    roundRect(ctx, r.x, r.y, r.w, r.h, 16); ctx.stroke();
    ctx.restore();
  }

  _environment(ctx, loc) {
    const r = loc.tile;
    ctx.save();
    roundRect(ctx, r.x+1, r.y+1, r.w-2, r.h-2, 15); ctx.clip();
    // floor band
    const fy = r.y + r.h*0.62;
    let floor = "#f2f5fc", wall = "#eef2fb";
    switch (loc.env) {
      case "factory": wall="#eef1f6"; floor="#e7ebf3"; break;
      case "warehouse": wall="#f0efe9"; floor="#e8e6dc"; break;
      case "cafe": wall="#f6efe6"; floor="#efe4d6"; break;
      case "airport": wall="#eaf1fb"; floor="#e2eaf6"; break;
      case "hotel": wall="#f3eef8"; floor="#ece3f2"; break;
      case "home": wall="#f4f0ea"; floor="#ece5db"; break;
      case "meeting": wall="#eef3f2"; floor="#e3ece9"; break;
      case "field": wall="#eef4ec"; floor="#e2ede0"; break;
    }
    ctx.fillStyle = wall; ctx.fillRect(r.x, r.y+34, r.w, fy-r.y-34);
    ctx.fillStyle = floor; ctx.fillRect(r.x, fy, r.w, r.h-(fy-r.y));

    // env-specific props (simple architectural hints)
    ctx.strokeStyle = "rgba(120,135,175,.25)"; ctx.lineWidth=1.5;
    if (loc.env==="airport") {
      // window mullions + flight board
      for (let i=0;i<4;i++){ ctx.beginPath(); ctx.moveTo(r.x+20+i*26, r.y+40); ctx.lineTo(r.x+20+i*26, fy); ctx.stroke(); }
      ctx.fillStyle="#334155"; roundRect(ctx, r.x+r.w-70, r.y+44, 56, 22, 4); ctx.fill();
      ctx.fillStyle="#6ee7b7"; ctx.font="700 7px SFMono-Regular, monospace"; ctx.fillText("DEP 12:40", r.x+r.w-64, r.y+52);
    } else if (loc.env==="cafe") {
      ctx.fillStyle="#8bbf7a"; ctx.beginPath(); ctx.arc(r.x+30, r.y+58, 12, 0, 7); ctx.fill(); // plant
      ctx.fillStyle="#5a3b26"; ctx.fillRect(r.x+26, r.y+64, 8, 12);
    } else if (loc.env==="warehouse" || loc.env==="factory") {
      ctx.strokeStyle="rgba(120,135,175,.3)";
      for (let i=0;i<3;i++){ ctx.strokeRect(r.x+18+i*40, r.y+42, 30, 20); } // shelving/steel
    } else if (loc.env==="hotel") {
      ctx.fillStyle="#c9a24b"; ctx.fillRect(r.x+20, fy-34, 8, 34); ctx.fillRect(r.x+r.w-28, fy-34, 8, 34); // pillars
    } else if (loc.env==="meeting") {
      ctx.strokeStyle="rgba(120,135,175,.3)"; ctx.strokeRect(r.x+r.w*0.5-40, r.y+44, 80, 16); // whiteboard
    }
    ctx.restore();
  }

  _deviceScene(ctx, loc, sim) {
    const h = loc.hero, x = h.sx, y = h.sy;
    switch (h.device) {
      case "desktop": this._desk(ctx, loc, x, y); break;
      case "laptop":  this._laptop(ctx, loc, x, y); break;
      case "tablet":  this._tablet(ctx, loc, x, y); break;
      case "phone":   this._phone(ctx, loc, x, y); break;
    }
  }

  _desk(ctx, loc, x, y) {
    const h = loc.hero;
    // person seated behind desk (drawn first, lower z)
    drawPerson(ctx, { x, y: y-30, scale:0.72, app:h.app, pose:"sit", t: loc.t });
    // desk top
    ctx.fillStyle = "#d8c3a8"; roundRect(ctx, x-70, y+2, 140, 12, 4); ctx.fill();
    ctx.fillStyle = "#c9b291"; roundRect(ctx, x-70, y+12, 140, 6, 3); ctx.fill();
    // monitor 1 (left, angled away, dim work app)
    ctx.save();
    ctx.fillStyle="#2a2f3d"; roundRect(ctx, x-66, y-30, 44, 30, 3); ctx.fill();
    ctx.fillStyle="#3b4763"; roundRect(ctx, x-63, y-27, 38, 24, 2); ctx.fill();
    ctx.fillStyle="#556289"; for(let i=0;i<3;i++){ roundRect(ctx, x-60, y-23+i*6, 30-i*4, 3, 1); ctx.fill(); }
    ctx.fillStyle="#2a2f3d"; ctx.fillRect(x-46, y, 6, 4); // stand
    ctx.restore();
    // monitor 2 (viewer-facing, the report) — dark bezel + report screen
    const mw=72, mh=48, mx=x-4, my=y-40;
    ctx.fillStyle="#1c2130"; roundRect(ctx, mx-2, my-2, mw+4, mh+4, 4); ctx.fill();
    drawScreen(ctx, mx, my, mw, mh, h.screen, h.progress, "full", h.source, loc.t);
    // stand + base
    ctx.fillStyle="#2a2f3d"; ctx.fillRect(mx+mw/2-3, my+mh, 6, 8); roundRect(ctx, mx+mw/2-12, my+mh+8, 24, 4, 2); ctx.fill();
    // keyboard + mouse + mug
    ctx.fillStyle="#eef1f7"; roundRect(ctx, x-30, y+3, 46, 9, 2); ctx.fill();
    ctx.fillStyle="#dfe4ee"; roundRect(ctx, x+20, y+4, 10, 7, 3); ctx.fill();
    ctx.fillStyle="#c74e88"; roundRect(ctx, x-52, y+2, 12, 12, {tl:2,tr:2,br:4,bl:4}); ctx.fill(); // mug
  }

  _laptop(ctx, loc, x, y) {
    const h = loc.hero;
    // small table
    ctx.fillStyle="#cdb69a"; roundRect(ctx, x-46, y+8, 92, 8, 3); ctx.fill();
    ctx.fillStyle="#b89a78"; ctx.fillRect(x-40, y+16, 5, 18); ctx.fillRect(x+35, y+16, 5, 18);
    // person seated-ish behind
    drawPerson(ctx, { x, y: y-14, scale:0.62, app:h.app, pose:"sit", t: loc.t, armReach:0.4 });
    // laptop base + screen (screen tilted toward viewer)
    ctx.fillStyle="#b8c0d4"; roundRect(ctx, x-30, y+2, 60, 8, 2); ctx.fill(); // keyboard base
    const sw=54, sh=34, sx=x-27, sy=y-30;
    ctx.fillStyle="#1c2130"; roundRect(ctx, sx-2, sy-2, sw+4, sh+4, 3); ctx.fill();
    drawScreen(ctx, sx, sy, sw, sh, h.screen, h.progress, "mini", h.source, loc.t);
    // coffee cup
    ctx.fillStyle="#8a5a2b"; roundRect(ctx, x+34, y+2, 9, 9, {tl:1,tr:1,br:3,bl:3}); ctx.fill();
  }

  _tablet(ctx, loc, x, y) {
    const h = loc.hero;
    drawPerson(ctx, { x, y, scale:0.72, app:h.app, pose:"stand", t: loc.t, armReach:0.7 });
    // tablet held in front, facing viewer
    const tw=42, th=54, tx=x-tw/2, ty=y-6;
    ctx.fillStyle="#1c2130"; roundRect(ctx, tx-3, ty-3, tw+6, th+6, 6); ctx.fill();
    drawScreen(ctx, tx, ty, tw, th, h.screen, h.progress, "mini", h.source, loc.t);
    // hands overlay
    ctx.fillStyle=h.app.skin; ctx.beginPath(); ctx.arc(tx-2, ty+th-6, 4, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(tx+tw+2, ty+th-6, 4, 0, 7); ctx.fill();
  }

  _phone(ctx, loc, x, y) {
    const h = loc.hero;
    const sway = Math.sin(loc.t*1.5)*2;
    drawPerson(ctx, { x: x+sway, y, scale:0.72, app:h.app, pose:"stand", t: loc.t, armReach:0.85 });
    // phone in hand, tilted toward viewer
    const pw=24, ph=44, px=x+10+sway, py=y-4;
    ctx.fillStyle="#1c2130"; roundRect(ctx, px-2, py-2, pw+4, ph+4, 5); ctx.fill();
    drawScreen(ctx, px, py, pw, ph, h.screen, h.progress, "mini", h.source, loc.t);
    ctx.fillStyle=h.app.skin; ctx.beginPath(); ctx.arc(px-1, py+ph-4, 3.5, 0, 7); ctx.fill();
  }

  // ---- packets ----
  _packets(ctx, world, sim) {
    for (const p of sim.packets) {
      const pos = p.pos;
      const isHit = p.kind === "hit";
      const isMiss = p.kind === "miss";
      const col = isHit ? COLORS.hit : isMiss ? COLORS.miss : COLORS.sql;
      // trailing glow
      ctx.save();
      ctx.shadowColor = col; ctx.shadowBlur = 10;
      ctx.fillStyle = col;
      if (isMiss) {
        // diamond for cache-miss (shape differs, not only color)
        ctx.translate(pos.x, pos.y); ctx.rotate(Math.PI/4);
        roundRect(ctx, -6, -6, 12, 12, 3); ctx.fill();
      } else {
        roundRect(ctx, pos.x-9, pos.y-6, 18, 12, 4); ctx.fill();
      }
      ctx.restore();
      // tiny label (report id / RUN)
      ctx.fillStyle = "#fff"; ctx.font = "700 6px SFMono-Regular, monospace";
      ctx.textAlign="center"; ctx.textBaseline="middle";
      if (!isMiss) ctx.fillText(isHit?t("canvas.packet.hit","HIT"):t("canvas.packet.run","RUN"), pos.x, pos.y);
      ctx.textAlign="left";
    }
  }
}
