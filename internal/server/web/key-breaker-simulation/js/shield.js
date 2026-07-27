// shield.js — the Quentra energy shield in front of the Key Breaker.
// Semi-transparent hexagonal barrier that pulses calmly and flares on impact.

import { Assets } from "./assets.js";

export function drawShield(ctx, world, sim, time) {
  const { cx, cy, r } = world.shield;
  const active = sim.protectionActive();
  const intensity = active ? sim.shieldIntensity : 0.18;
  const pulse = 0.5 + 0.5 * Math.sin(time * 1.6);

  ctx.save();

  // Outer aura
  const aura = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 1.25);
  const a = active ? 0.28 : 0.08;
  aura.addColorStop(0, `rgba(34,227,154,${a * (0.6 + 0.4 * pulse)})`);
  aura.addColorStop(1, "rgba(34,227,154,0)");
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.25, 0, Math.PI * 2);
  ctx.fill();

  // Shield body — slightly curved shield shape (rounded hexagon)
  ctx.beginPath();
  const sides = 6;
  for (let i = 0; i <= sides; i++) {
    const ang = -Math.PI / 2 + (i / sides) * Math.PI * 2;
    const rr = r * (1 + 0.03 * Math.sin(ang * 3 + time));
    const x = cx + Math.cos(ang) * rr * 0.92;
    const y = cy + Math.sin(ang) * rr;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();

  const body = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  body.addColorStop(0, `rgba(20,90,70,${0.10 + 0.16 * intensity})`);
  body.addColorStop(0.5, `rgba(34,227,154,${0.05 + 0.10 * intensity})`);
  body.addColorStop(1, `rgba(45,212,191,${0.08 + 0.14 * intensity})`);
  ctx.fillStyle = body;
  ctx.fill();

  // Hex mesh inside (clip to shield)
  ctx.save();
  ctx.clip();
  drawHexMesh(ctx, cx, cy, r, time, intensity);
  ctx.restore();

  // Rim
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = `rgba(34,227,154,${0.35 + 0.5 * intensity})`;
  ctx.shadowColor = "rgba(34,227,154,0.7)";
  ctx.shadowBlur = active ? 22 + 14 * pulse : 6;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Center Quentra icon
  drawShieldIcon(ctx, cx, cy, r * 0.24, active, time);

  // Impact ripples
  for (const rp of sim.ripples) {
    const t = rp.age / rp.life;
    ctx.beginPath();
    ctx.arc(rp.x, rp.y, rp.r0 + t * rp.spread, 0, Math.PI * 2);
    ctx.lineWidth = 3 * (1 - t);
    ctx.strokeStyle = `rgba(${rp.hostile ? "255,120,120" : "80,255,190"},${(1 - t) * 0.8})`;
    ctx.stroke();
  }

  ctx.restore();
}

function drawHexMesh(ctx, cx, cy, r, time, intensity) {
  const hs = 26;
  const w = hs * Math.sqrt(3);
  ctx.lineWidth = 1;
  ctx.strokeStyle = `rgba(60,225,255,${0.08 + 0.14 * intensity})`;
  for (let gy = -r; gy < r; gy += hs * 1.5) {
    for (let gx = -r; gx < r; gx += w) {
      const off = ((gy / (hs * 1.5)) % 2) * (w / 2);
      const x = cx + gx + off;
      const y = cy + gy;
      const flick = 0.5 + 0.5 * Math.sin(time * 3 + gx * 0.05 + gy * 0.05);
      ctx.globalAlpha = 0.4 + 0.6 * flick;
      hexPath(ctx, x, y, hs * 0.5);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function hexPath(ctx, x, y, s) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i / 6) * Math.PI * 2;
    const px = x + Math.cos(a) * s, py = y + Math.sin(a) * s;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawShieldIcon(ctx, cx, cy, r, active, time) {
  const img = Assets.get("icon");
  const pulse = 0.5 + 0.5 * Math.sin(time * 2);
  ctx.save();
  ctx.globalAlpha = active ? 0.85 + 0.15 * pulse : 0.4;
  if (img) {
    const s = r * 2.2;
    ctx.shadowColor = "rgba(34,227,154,0.8)";
    ctx.shadowBlur = active ? 20 : 6;
    ctx.drawImage(img, cx - s / 2, cy - s / 2, s, s);
  } else {
    // Vector fallback "Q"
    ctx.strokeStyle = active ? "#22e39a" : "rgba(120,180,160,.6)";
    ctx.lineWidth = r * 0.28;
    ctx.shadowColor = "rgba(34,227,154,0.8)";
    ctx.shadowBlur = active ? 18 : 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.35, cy + r * 0.35);
    ctx.lineTo(cx + r, cy + r);
    ctx.stroke();
  }
  ctx.restore();
}
