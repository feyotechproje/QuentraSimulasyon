// draw.js — reusable canvas primitives: people, devices, report screens, gauges.
// Everything is drawn from code (no images, no emoji).

import { SCREEN } from "./models.js";
import { QuentraI18n } from "/shared/quentra-i18n.js";

const t = (k, f) => QuentraI18n.t(k, f);

export function roundRect(ctx, x, y, w, h, r) {
  if (typeof r === "number") r = { tl:r, tr:r, br:r, bl:r };
  ctx.beginPath();
  ctx.moveTo(x + r.tl, y);
  ctx.lineTo(x + w - r.tr, y);
  ctx.arcTo(x + w, y, x + w, y + r.tr, r.tr);
  ctx.lineTo(x + w, y + h - r.br);
  ctx.arcTo(x + w, y + h, x + w - r.br, y + h, r.br);
  ctx.lineTo(x + r.bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - r.bl, r.bl);
  ctx.lineTo(x, y + r.tl);
  ctx.arcTo(x, y, x + r.tl, y, r.tl);
  ctx.closePath();
}

export function shadowEllipse(ctx, x, y, rx, ry) {
  ctx.save();
  ctx.fillStyle = "rgba(40,52,94,.13)";
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

export const SKINS = ["#f2c9a0","#e8b98c","#d69f76","#b87d54","#8d5a3a","#f6d3b3"];
export const HAIRS = ["#2b2b31","#5a3b26","#8a5a2b","#c9a24b","#9aa0ad","#3a2f2a"];
export const SHIRTS = ["#5b74e6","#0f9d8f","#7c58e0","#e0685a","#f0a83a","#3a4a6b","#c74e88","#2fa4d0"];

/**
 * Parametric human figure (head, hair, face, eyes, body, arms, hands, legs, shoes).
 * opts: { x, y, scale, app:{skin,hair,shirt,pants}, pose:"sit"|"stand",
 *         armReach:0..1 (holds device), t (anim phase), flip }
 */
export function drawPerson(ctx, opts) {
  const { x, y } = opts;
  const s = opts.scale ?? 1;
  const app = opts.app || {};
  const skin = app.skin || SKINS[0];
  const hair = app.hair || HAIRS[0];
  const shirt = app.shirt || SHIRTS[0];
  const pants = app.pants || "#3a4256";
  const pose = opts.pose || "stand";
  const t = opts.t || 0;
  const bob = Math.sin(t * 2) * 0.8 * s;      // subtle idle sway
  const flip = opts.flip ? -1 : 1;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(flip, 1);

  const headR = 11 * s;
  const bodyW = 26 * s, bodyH = 30 * s;

  if (pose === "stand") {
    // legs
    ctx.fillStyle = pants;
    roundRect(ctx, -10*s, 0, 8*s, 26*s, 4*s); ctx.fill();
    roundRect(ctx, 2*s, 0, 8*s, 26*s, 4*s); ctx.fill();
    // shoes
    ctx.fillStyle = "#2a2f3d";
    roundRect(ctx, -12*s, 24*s, 12*s, 6*s, 3*s); ctx.fill();
    roundRect(ctx, 0, 24*s, 12*s, 6*s, 3*s); ctx.fill();
    // torso
    ctx.fillStyle = shirt;
    roundRect(ctx, -bodyW/2, -bodyH + bob, bodyW, bodyH, {tl:11*s,tr:11*s,br:5*s,bl:5*s}); ctx.fill();
  } else {
    // seated: thighs forward, lower legs down
    ctx.fillStyle = pants;
    roundRect(ctx, -13*s, 2*s, 26*s, 11*s, 5*s); ctx.fill(); // lap
    roundRect(ctx, -12*s, 12*s, 8*s, 20*s, 4*s); ctx.fill();
    roundRect(ctx, 4*s, 12*s, 8*s, 20*s, 4*s); ctx.fill();
    ctx.fillStyle = "#2a2f3d";
    roundRect(ctx, -13*s, 30*s, 11*s, 6*s, 3*s); ctx.fill();
    roundRect(ctx, 3*s, 30*s, 11*s, 6*s, 3*s); ctx.fill();
    // torso
    ctx.fillStyle = shirt;
    roundRect(ctx, -bodyW/2, -bodyH + 6*s + bob, bodyW, bodyH, {tl:11*s,tr:11*s,br:5*s,bl:5*s}); ctx.fill();
  }

  const torsoTop = (pose === "stand" ? -bodyH : -bodyH + 6*s) + bob;
  const shoulder = torsoTop + 6*s;

  // arms — reach forward if holding a device
  const reach = opts.armReach ?? 0;
  ctx.strokeStyle = shirt; ctx.lineCap = "round"; ctx.lineWidth = 7*s;
  const handY = shoulder + 18*s - reach*10*s;
  const handX = 14*s + reach*6*s;
  ctx.beginPath(); ctx.moveTo(-11*s, shoulder+2*s); ctx.lineTo(-handX, handY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo( 11*s, shoulder+2*s); ctx.lineTo( handX, handY); ctx.stroke();
  // hands
  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.arc(-handX, handY, 4*s, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc( handX, handY, 4*s, 0, 7); ctx.fill();

  // neck
  ctx.fillStyle = skin;
  roundRect(ctx, -4*s, torsoTop - 6*s, 8*s, 10*s, 3*s); ctx.fill();

  // head
  const hy = torsoTop - headR - 3*s;
  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.arc(0, hy, headR, 0, Math.PI*2); ctx.fill();
  // hair
  ctx.fillStyle = hair;
  const hs = app.hairStyle ?? 0;
  ctx.beginPath();
  if (hs === 0) { // short
    ctx.arc(0, hy, headR+1.5*s, Math.PI*1.02, Math.PI*2 - .02);
    ctx.lineTo(headR*0.9, hy); ctx.lineTo(-headR*0.9, hy);
  } else if (hs === 1) { // longer / bob
    ctx.arc(0, hy, headR+2*s, Math.PI*0.92, Math.PI*2.08);
    ctx.lineTo(headR*1.1, hy + headR*1.1);
    ctx.lineTo(-headR*1.1, hy + headR*1.1);
  } else { // side part
    ctx.arc(0, hy, headR+1.5*s, Math.PI, Math.PI*2);
    ctx.lineTo(headR*0.6, hy); ctx.lineTo(-headR, hy);
  }
  ctx.closePath(); ctx.fill();
  // face — eyes (looking toward viewer / device)
  ctx.fillStyle = "#2a2f3d";
  ctx.beginPath(); ctx.arc(-4*s, hy+1*s, 1.5*s, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc( 4*s, hy+1*s, 1.5*s, 0, 7); ctx.fill();
  // nose + mouth
  ctx.strokeStyle = "rgba(120,80,60,.5)"; ctx.lineWidth = 1.2*s;
  ctx.beginPath(); ctx.moveTo(0, hy+2*s); ctx.lineTo(0, hy+5*s); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, hy+6*s, 2.4*s, .2, Math.PI-.2); ctx.stroke();

  ctx.restore();
}

// ---------- device screens (report / loading) ----------

/**
 * Draws report content inside a screen rect (already positioned).
 * detail: "full" desktop, "mini" phone/tablet.
 * screen: SCREEN.*  progress:0..1  source:"sql"|"cache"|null
 */
export function drawScreen(ctx, x, y, w, h, screen, progress, detail, source, time) {
  const t = (k, f) => QuentraI18n.t(k, f);
  ctx.save();
  roundRect(ctx, x, y, w, h, Math.min(6, w*0.06)); ctx.clip();
  // bg
  ctx.fillStyle = "#f7f9ff"; ctx.fillRect(x, y, w, h);

  if (screen === SCREEN.IDLE) {
    ctx.fillStyle = "#dfe5f2";
    roundRect(ctx, x+w*0.2, y+h*0.42, w*0.6, h*0.12, 3); ctx.fill();
    ctx.restore(); return;
  }

  // purple report header bar (same for every device => "same report")
  const hh = Math.max(9, h*0.19);
  const g = ctx.createLinearGradient(x, y, x+w, y);
  g.addColorStop(0, "#6d5cf5"); g.addColorStop(1, "#7c3aed");
  ctx.fillStyle = g; ctx.fillRect(x, y, w, hh);
  if (w > 90) {
    ctx.fillStyle = "rgba(255,255,255,.95)";
    ctx.font = `700 ${Math.max(7, h*0.08)}px Inter, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(t("canvas.screen.title","GLOBAL SALES PERFORMANCE"), x+7, y+hh*0.5);
    ctx.font = `600 ${Math.max(6, h*0.06)}px SFMono-Regular, monospace`;
    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.fillText("RPT-2026-0042", x+w-64, y+hh*0.5);
  } else {
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.font = `700 ${Math.max(5, h*0.11)}px Inter, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(t("canvas.screen.titleShort","GLOBAL SALES"), x+4, y+hh*0.5);
  }

  const cy = y + hh + 4;
  const cw = w - 10, cx = x + 5;
  const bodyH = h - hh - 8;

  if (screen === SCREEN.LOADING) {
    // skeleton + spinner + label
    ctx.fillStyle = "#e6ebf6";
    const rows = detail === "full" ? 4 : 2;
    for (let i=0;i<rows;i++){ roundRect(ctx, cx, cy+i*(bodyH/rows-2)+2, cw*(0.9-i*0.08), Math.max(4,bodyH/rows-8), 3); ctx.fill(); }
    // spinner
    const sr = Math.min(w,h)*0.14, sx = x+w*0.5, sy = y+h*0.55;
    ctx.strokeStyle = "#c7cfe2"; ctx.lineWidth = Math.max(2, sr*0.28);
    ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI*2); ctx.stroke();
    ctx.strokeStyle = "#6d5cf5";
    ctx.beginPath(); ctx.arc(sx, sy, sr, time*4, time*4 + Math.PI*1.2); ctx.stroke();
    // progress bar
    ctx.fillStyle = "#e2e7f1"; roundRect(ctx, cx, y+h-10, cw, 4, 2); ctx.fill();
    ctx.fillStyle = "#6d5cf5"; roundRect(ctx, cx, y+h-10, cw*progress, 4, 2); ctx.fill();
    if (w > 90) {
      ctx.fillStyle = "#8b93a7"; ctx.font = `600 ${Math.max(6,h*0.07)}px Inter, sans-serif`;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(progress < .5 ? t("canvas.screen.loadingData","Loading Data…") : t("canvas.screen.generating","Generating Report…"), cx, y+h-14);
    }
  } else if (screen === SCREEN.TIMEOUT) {
    ctx.fillStyle = "#fdecec"; ctx.fillRect(x, cy, w, bodyH);
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x+w*0.5, y+h*0.55, Math.min(w,h)*0.13, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x+w*0.5, y+h*0.48); ctx.lineTo(x+w*0.5, y+h*0.58); ctx.stroke();
    ctx.beginPath(); ctx.arc(x+w*0.5, y+h*0.63, 1.4, 0, 7); ctx.fillStyle="#ef4444"; ctx.fill();
  } else { // READY — live dashboard
    const build = progress; // 0..1 build-up
    // KPI cards
    const kn = detail === "full" ? 3 : 3;
    const kw = (cw - (kn-1)*4) / kn, kh = Math.max(9, bodyH*0.32);
    const kcol = ["#eef0ff","#e6faf5","#fef2e4"], kacc=["#6d5cf5","#14b8a6","#f59e0b"];
    for (let i=0;i<kn;i++){
      ctx.fillStyle = kcol[i]; roundRect(ctx, cx+i*(kw+4), cy, kw, kh, 3); ctx.fill();
      ctx.fillStyle = kacc[i]; roundRect(ctx, cx+i*(kw+4)+3, cy+3, kw*0.5*build, 3, 1.5); ctx.fill();
      ctx.fillStyle = "#c3cbdd"; roundRect(ctx, cx+i*(kw+4)+3, cy+kh-6, kw*0.7, 2.5, 1); ctx.fill();
    }
    // bar chart
    const chY = cy + kh + 4, chH = bodyH - kh - 6;
    if (chH > 6) {
      const bars = detail === "full" ? 8 : 5;
      const bw = (cw)/bars - 2;
      for (let i=0;i<bars;i++){
        const bh = chH * (0.35 + 0.6*Math.abs(Math.sin(i*1.3+2))) * build;
        ctx.fillStyle = i%2 ? "#a5b4fc" : "#6d5cf5";
        roundRect(ctx, cx+i*(bw+2), chY+chH-bh, bw, bh, 1.5); ctx.fill();
      }
      // line overlay
      ctx.strokeStyle = "#14b8a6"; ctx.lineWidth = 1.5; ctx.beginPath();
      for (let i=0;i<bars;i++){
        const px = cx+i*(bw+2)+bw/2;
        const py = chY + chH*(0.6 - 0.4*Math.sin(i*0.9)) ;
        i? ctx.lineTo(px, py): ctx.moveTo(px, py);
      }
      ctx.stroke();
    }
    // source badge
    if (source && w > 80) {
      const label = source === "cache" ? t("canvas.screen.cached","CACHED") : t("canvas.screen.live","LIVE");
      const bc = source === "cache" ? "#14b8a6" : "#f59e0b";
      ctx.fillStyle = bc; roundRect(ctx, x+w-42, y+hh+3, 38, 11, 3); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = `700 7px SFMono-Regular, monospace`;
      ctx.textBaseline = "middle"; ctx.fillText(label, x+w-38, y+hh+9);
    }
  }
  ctx.restore();
}

// ---------- gauge (used by SQL rack drawing) ----------
export function miniGauge(ctx, x, y, w, label, val, color) {
  ctx.fillStyle = "rgba(255,255,255,.14)"; ctx.font = "600 9px Inter, sans-serif";
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  ctx.fillStyle = "#c9d0e6"; ctx.fillText(label, x, y - 3);
  ctx.fillStyle = "#e7ebf7"; ctx.textAlign = "right";
  ctx.fillText(typeof val === "number" ? Math.round(val)+"%" : val, x+w, y-3);
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,.12)"; roundRect(ctx, x, y, w, 5, 2.5); ctx.fill();
  const p = typeof val === "number" ? val/100 : 0.5;
  ctx.fillStyle = color; roundRect(ctx, x, y, w*p, 5, 2.5); ctx.fill();
}
