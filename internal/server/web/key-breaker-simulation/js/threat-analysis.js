// threat-analysis.js — on-canvas threat analysis readout near the gateway.

import { PIPELINE } from "./config.js";
import { roundRect } from "./gateway.js";

export function drawThreatAnalysis(ctx, world, sim, time) {
  if (!sim.protectionActive()) return;
  const x = 690, top = 150, w = 4;
  // vertical rail of pipeline steps beside the shield
  ctx.save();
  ctx.font = "700 9px 'Segoe UI'";
  ctx.textAlign = "left";
  const stepH = 30;
  for (let i = 0; i < PIPELINE.length; i++) {
    const y = top + i * stepH;
    const on = sim.pipelineStep >= i && sim.pipelineActive;
    ctx.fillStyle = on ? "rgba(34,227,154,0.9)" : "rgba(120,160,150,0.35)";
    ctx.beginPath();
    ctx.arc(x, y, on ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fill();
    if (on) {
      ctx.shadowColor = "rgba(34,227,154,0.7)";
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    // connector
    if (i < PIPELINE.length - 1) {
      ctx.strokeStyle = on ? "rgba(34,227,154,0.5)" : "rgba(120,160,150,0.15)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y + 6);
      ctx.lineTo(x, y + stepH - 6);
      ctx.stroke();
    }
    ctx.fillStyle = on ? "#dff5ec" : "rgba(150,180,170,0.4)";
    ctx.fillText(PIPELINE[i].toUpperCase(), x + 12, y + 3);
  }

  // current decision card
  const dec = sim.lastDecision;
  if (dec) {
    const cx = x - 8, cardY = top + PIPELINE.length * stepH + 6;
    roundRect(ctx, cx, cardY, 150, 44, 8);
    ctx.fillStyle = dec.block ? "rgba(255,77,94,0.12)" : "rgba(34,227,154,0.12)";
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = dec.block ? "rgba(255,77,94,0.5)" : "rgba(34,227,154,0.5)";
    ctx.stroke();
    ctx.fillStyle = "rgba(180,200,195,0.7)";
    ctx.font = "600 9px 'Segoe UI'";
    ctx.fillText("RISK SCORE", cx + 10, cardY + 15);
    ctx.font = "800 16px 'Consolas'";
    ctx.fillStyle = dec.block ? "#ff5a68" : "#22e39a";
    ctx.fillText(String(dec.risk), cx + 10, cardY + 34);
    ctx.font = "800 11px 'Segoe UI'";
    ctx.textAlign = "right";
    ctx.fillText(dec.block ? "BLOCKED" : "ALLOWED", cx + 140, cardY + 28);
    ctx.textAlign = "left";
  }
  ctx.restore();
}
