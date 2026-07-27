// attacker.js — draws external attacker source nodes on the canvas (left side).

export function drawAttacker(ctx, a, time, selected) {
  const pulse = 0.5 + 0.5 * Math.sin(time * 3 + a.pulse);
  ctx.save();

  // threat aura
  ctx.globalAlpha = 0.4;
  const g = ctx.createRadialGradient(a.x, a.y, 4, a.x, a.y, 44);
  g.addColorStop(0, `rgba(255,77,94,${0.25 + 0.2 * pulse})`);
  g.addColorStop(1, "rgba(255,77,94,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(a.x, a.y, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // node hexagon
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ang = Math.PI / 6 + (i / 6) * Math.PI * 2;
    const x = a.x + Math.cos(ang) * a.r, y = a.y + Math.sin(ang) * a.r;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "#160a0e";
  ctx.fill();
  ctx.lineWidth = selected ? 2.4 : 1.6;
  ctx.strokeStyle = selected ? "#fff" : `rgba(255,77,94,${0.6 + 0.4 * pulse})`;
  ctx.shadowColor = "rgba(255,77,94,0.7)";
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // skull-ish glyph
  ctx.fillStyle = `rgba(255,120,130,${0.8})`;
  ctx.font = "700 13px 'Segoe UI'";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("⚠", a.x, a.y + 1);

  // ip label
  ctx.fillStyle = "rgba(200,220,215,0.75)";
  ctx.font = "600 9px 'Consolas'";
  ctx.fillText(a.ip, a.x, a.y + a.r + 11);

  ctx.restore();
}
