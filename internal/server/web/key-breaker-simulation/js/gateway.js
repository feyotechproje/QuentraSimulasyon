// gateway.js — the "Quentra AI SQL Gateway" module column between shield and DB.

import { GATEWAY_MODULES, LAYOUT } from "./config.js";
import { Assets } from "./assets.js";

export function drawGateway(ctx, world, sim, time) {
  const x = LAYOUT.gatewayX;
  const top = LAYOUT.gatewayTop;
  const gap = LAYOUT.gatewayGap;
  const w = 150;
  const active = sim.protectionActive();

  ctx.save();

  // Header plate
  ctx.font = "700 11px 'Segoe UI'";
  ctx.textAlign = "center";
  ctx.fillStyle = active ? "#22e39a" : "rgba(150,180,170,0.6)";
  ctx.shadowColor = "rgba(34,227,154,0.6)";
  ctx.shadowBlur = active ? 10 : 0;
  // Quentra icon (small) beside header
  const img = Assets.get("icon");
  if (img) ctx.drawImage(img, x - 66, top - 34, 20, 20);
  ctx.fillText("QUENTRA AI SQL GATEWAY", x, top - 20);
  ctx.shadowBlur = 0;

  GATEWAY_MODULES.forEach((name, i) => {
    const y = top + i * gap;
    const lit = active && sim.gatewayLit[i];
    // module card
    roundRect(ctx, x - w / 2, y, w, gap - 12, 8);
    ctx.fillStyle = lit ? "rgba(34,227,154,0.14)" : "rgba(255,255,255,0.03)";
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = lit ? "rgba(34,227,154,0.7)" : "rgba(120,160,150,0.16)";
    ctx.shadowColor = "rgba(34,227,154,0.6)";
    ctx.shadowBlur = lit ? 12 : 0;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // index dot
    ctx.beginPath();
    ctx.arc(x - w / 2 + 16, y + (gap - 12) / 2, 9, 0, Math.PI * 2);
    ctx.fillStyle = lit ? "#22e39a" : "rgba(120,160,150,0.25)";
    ctx.fill();
    ctx.fillStyle = lit ? "#031" : "rgba(200,220,215,0.5)";
    ctx.font = "700 10px 'Consolas'";
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1), x - w / 2 + 16, y + (gap - 12) / 2 + 3.5);

    // label
    ctx.textAlign = "left";
    ctx.font = "600 11px 'Segoe UI'";
    ctx.fillStyle = lit ? "#e8f6ef" : "rgba(160,185,180,0.55)";
    ctx.fillText(name, x - w / 2 + 32, y + (gap - 12) / 2 + 4);
  });

  ctx.restore();
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
