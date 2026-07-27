// database.js — the SQL Server / database server on the right side of the stage.

import { roundRect } from "./gateway.js";

export function drawDatabase(ctx, world, sim, time) {
  const { x, cy, w, h } = world.database;
  const secure = sim.databaseSecure();
  const pulse = 0.5 + 0.5 * Math.sin(time * (secure ? 1.4 : 5));
  const accent = secure ? "34,227,154" : "255,77,94";

  ctx.save();

  // Secure perimeter glow
  ctx.globalAlpha = 0.5;
  const g = ctx.createRadialGradient(x, cy, 20, x, cy, 150);
  g.addColorStop(0, `rgba(${accent},${0.18 + 0.12 * pulse})`);
  g.addColorStop(1, `rgba(${accent},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, cy, 150, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Server rack
  roundRect(ctx, x - w / 2, cy - h / 2, w, h, 12);
  const body = ctx.createLinearGradient(x, cy - h / 2, x, cy + h / 2);
  body.addColorStop(0, "#0d1826");
  body.addColorStop(1, "#08101c");
  ctx.fillStyle = body;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = `rgba(${accent},${0.5 + 0.4 * pulse})`;
  ctx.shadowColor = `rgba(${accent},0.7)`;
  ctx.shadowBlur = 16;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // DB cylinders (3 stacked)
  const cw = w * 0.6;
  for (let i = 0; i < 3; i++) {
    const cyl = cy - h / 2 + 34 + i * 46;
    drawCylinder(ctx, x, cyl, cw, 32, accent, secure);
  }

  // Status lights row
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(x - w / 2 + 18 + i * 14, cy + h / 2 - 14, 4, 0, Math.PI * 2);
    const on = secure ? true : i % 2 === 0;
    ctx.fillStyle = on ? `rgba(${accent},${0.7 + 0.3 * pulse})` : "rgba(80,100,110,0.4)";
    ctx.fill();
  }

  // Labels
  ctx.textAlign = "center";
  ctx.font = "700 12px 'Segoe UI'";
  ctx.fillStyle = "#dfeaf2";
  ctx.fillText("SQL SERVER", x, cy - h / 2 - 26);
  ctx.font = "800 11px 'Segoe UI'";
  ctx.fillStyle = `rgb(${accent})`;
  ctx.shadowColor = `rgba(${accent},0.7)`;
  ctx.shadowBlur = 8;
  ctx.fillText(secure ? "PROTECTED" : "AT RISK", x, cy - h / 2 - 10);
  ctx.shadowBlur = 0;

  // Incident alarm ring (Protection Off)
  if (!secure) {
    for (const al of sim.dbAlarms) {
      const t = al.age / al.life;
      ctx.beginPath();
      ctx.arc(x, cy, 30 + t * 90, 0, Math.PI * 2);
      ctx.lineWidth = 3 * (1 - t);
      ctx.strokeStyle = `rgba(255,77,94,${(1 - t) * 0.8})`;
      ctx.stroke();
    }
  } else {
    // safe query arrival pulses
    for (const pp of sim.dbPulses) {
      const t = pp.age / pp.life;
      ctx.beginPath();
      ctx.arc(x, cy, 20 + t * 60, 0, Math.PI * 2);
      ctx.lineWidth = 2.5 * (1 - t);
      ctx.strokeStyle = `rgba(34,227,154,${(1 - t) * 0.7})`;
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawCylinder(ctx, x, y, w, h, accent, secure) {
  const rx = w / 2, ry = 7;
  ctx.fillStyle = "#0a1522";
  ctx.strokeStyle = `rgba(${accent},0.55)`;
  ctx.lineWidth = 1.4;
  // body
  ctx.beginPath();
  ctx.moveTo(x - rx, y);
  ctx.lineTo(x - rx, y + h);
  ctx.ellipse(x, y + h, rx, ry, 0, Math.PI, 0, true);
  ctx.lineTo(x + rx, y);
  ctx.stroke();
  ctx.fillRect(x - rx, y, w, h);
  // top ellipse
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${accent},0.18)`;
  ctx.fill();
  ctx.stroke();
}
