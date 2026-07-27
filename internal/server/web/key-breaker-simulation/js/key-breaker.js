// key-breaker.js — the Key Breaker hero character.
// Uses the provided PNG (assets/key-breaker.png) when available; otherwise draws a
// vector fallback silhouette (long black coat, glasses, extended hand, chest logo).
// Do NOT redraw / replace the provided character — this is only a graceful fallback.

import { Assets } from "./assets.js";

export function drawKeyBreaker(ctx, world, sim, time) {
  const { cx, baseY, h } = world.hero;
  const active = sim.protectionActive();
  const breathe = Math.sin(time * 1.1) * 3;          // subtle breathing
  const float = Math.sin(time * 0.6) * 4;            // gentle floating
  const topY = baseY - h + breathe + float;

  // Ground energy ring
  ctx.save();
  ctx.globalAlpha = active ? 0.5 : 0.2;
  const grd = ctx.createRadialGradient(cx, baseY, 8, cx, baseY, 150);
  grd.addColorStop(0, "rgba(34,227,154,0.5)");
  grd.addColorStop(1, "rgba(34,227,154,0)");
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.ellipse(cx, baseY, 150, 34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const img = Assets.get("hero");
  if (img) {
    const ar = img.width / img.height;
    const dh = h;
    const dw = dh * ar;
    ctx.save();
    ctx.shadowColor = "rgba(34,227,154,0.35)";
    ctx.shadowBlur = active ? 30 : 10;
    ctx.drawImage(img, cx - dw / 2, topY, dw, dh);
    ctx.restore();
    // chest logo pulse glow overlay (approx chest position)
    if (active) chestGlow(ctx, cx, topY + dh * 0.34, time);
  } else {
    drawVectorHero(ctx, cx, topY, h, active, time);
  }

  // Energy rings emitting from the extended hand (right side, toward attackers)
  if (active) drawHandEnergy(ctx, cx - h * 0.30, topY + h * 0.46, time);
}

function chestGlow(ctx, x, y, time) {
  const pulse = 0.5 + 0.5 * Math.sin(time * 2.4);
  ctx.save();
  ctx.globalAlpha = 0.35 + 0.4 * pulse;
  const g = ctx.createRadialGradient(x, y, 2, x, y, 46);
  g.addColorStop(0, "rgba(34,227,154,0.9)");
  g.addColorStop(1, "rgba(34,227,154,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, 46, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawHandEnergy(ctx, hx, hy, time) {
  ctx.save();
  for (let i = 0; i < 3; i++) {
    const t = ((time * 0.8 + i / 3) % 1);
    ctx.beginPath();
    ctx.arc(hx, hy, 10 + t * 60, 0, Math.PI * 2);
    ctx.lineWidth = 2 * (1 - t);
    ctx.strokeStyle = `rgba(34,227,154,${(1 - t) * 0.7})`;
    ctx.stroke();
  }
  ctx.restore();
}

// ---- Vector fallback silhouette (used only if the PNG is not present) ----
function drawVectorHero(ctx, cx, topY, h, active, time) {
  const w = h * 0.42;
  const x = cx - w / 2;
  const pulse = 0.5 + 0.5 * Math.sin(time * 2.4);
  ctx.save();

  // Coat body
  ctx.fillStyle = "#0b0f14";
  ctx.strokeStyle = active ? "rgba(34,227,154,0.6)" : "rgba(80,120,110,0.4)";
  ctx.lineWidth = 2;
  ctx.shadowColor = active ? "rgba(34,227,154,0.4)" : "transparent";
  ctx.shadowBlur = active ? 24 : 0;

  // Head
  const headR = w * 0.18;
  const headY = topY + headR + 6;
  ctx.beginPath();
  ctx.arc(cx, headY, headR, 0, Math.PI * 2);
  ctx.fillStyle = "#14181d";
  ctx.fill();
  ctx.stroke();

  // Glasses
  ctx.fillStyle = "#000";
  ctx.fillRect(cx - headR * 0.75, headY - 2, headR * 1.5, headR * 0.5);
  ctx.strokeStyle = active ? "rgba(34,227,154,0.9)" : "rgba(120,160,150,0.5)";
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - headR * 0.75, headY - 2, headR * 1.5, headR * 0.5);

  // Shoulders + coat (tapered trapezoid)
  const shY = headY + headR + 4;
  const shW = w * 0.9;
  const botY = topY + h;
  ctx.beginPath();
  ctx.moveTo(cx - shW / 2, shY);
  ctx.lineTo(cx + shW / 2, shY);
  ctx.lineTo(cx + w * 0.34, botY);
  ctx.lineTo(cx - w * 0.34, botY);
  ctx.closePath();
  ctx.fillStyle = "#0b0f14";
  ctx.fill();
  ctx.strokeStyle = active ? "rgba(34,227,154,0.5)" : "rgba(80,120,110,0.35)";
  ctx.stroke();

  // Coat opening line
  ctx.beginPath();
  ctx.moveTo(cx, shY);
  ctx.lineTo(cx, botY);
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.stroke();

  // Extended arm toward attackers (left)
  const armY = shY + (botY - shY) * 0.32;
  ctx.beginPath();
  ctx.moveTo(cx - shW * 0.4, shY + 10);
  ctx.lineTo(cx - w * 0.72, armY);
  ctx.lineWidth = w * 0.16;
  ctx.strokeStyle = "#0b0f14";
  ctx.lineCap = "round";
  ctx.stroke();
  // Palm
  ctx.beginPath();
  ctx.arc(cx - w * 0.74, armY, w * 0.11, 0, Math.PI * 2);
  ctx.fillStyle = "#14181d";
  ctx.fill();

  // Chest Quentra logo
  ctx.shadowBlur = 0;
  const clY = shY + (botY - shY) * 0.14;
  ctx.globalAlpha = active ? 0.7 + 0.3 * pulse : 0.5;
  ctx.beginPath();
  ctx.arc(cx, clY, w * 0.11, 0, Math.PI * 2);
  ctx.strokeStyle = active ? "#22e39a" : "rgba(120,180,160,0.7)";
  ctx.lineWidth = w * 0.035;
  ctx.shadowColor = "rgba(34,227,154,0.8)";
  ctx.shadowBlur = active ? 14 : 4;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + w * 0.05, clY + w * 0.05);
  ctx.lineTo(cx + w * 0.13, clY + w * 0.13);
  ctx.stroke();

  ctx.restore();
}
