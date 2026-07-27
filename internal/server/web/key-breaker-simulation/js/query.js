// query.js — legitimate (safe) application query packet: factory + renderer.
// Safe queries flow along a separate green lane, get validated by the gateway,
// and reach the database. They are never blocked by the shield.

import { rand, nextSafeId, SAFE_STATE } from "./models.js";

export function createSafeQuery(text, world) {
  const p0 = { x: world.gatewayCore.x - 150, y: world.safeLaneY + rand(-16, 16) };
  const validateX = world.gatewayCore.x;
  const p2 = { x: world.database.x - 70, y: world.database.cy - rand(20, 70) };
  return {
    kind: "safe",
    id: nextSafeId(),
    query: text,
    p0, validateX, p2,
    x: p0.x, y: p0.y,
    t: 0,
    speed: rand(0.4, 0.55),
    state: SAFE_STATE.TRAVELING,
    validated: false,
    fade: 1,
    reachedDB: false,
    responseMs: rand(0.14, 0.22),
    risk: 2,
    dead: false,
    selected: false,
  };
}

export function drawSafeQuery(ctx, q, time) {
  ctx.save();
  ctx.globalAlpha = q.fade;
  ctx.translate(q.x, q.y);
  const w = 40, h = 20;
  ctx.shadowColor = "rgba(45,212,191,0.8)";
  ctx.shadowBlur = 12;
  const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  g.addColorStop(0, "#2dd4bf");
  g.addColorStop(1, "#22c39a");
  ctx.fillStyle = g;
  cap(ctx, -w / 2, -h / 2, w, h, h / 2);
  ctx.fill();
  if (q.selected) { ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke(); }
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#012019";
  ctx.font = "800 9px 'Consolas'";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(q.validated ? "ALLOWED" : "SAFE", 0, 0.5);
  ctx.restore();
}

function cap(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
