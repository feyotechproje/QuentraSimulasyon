// attack-packet.js — malicious SQL packet factory + renderer.
// Movement/state transitions are driven centrally by simulation.js; this module
// owns the data shape and how a packet is drawn.

import { bezier, rand, nextAttackId } from "./models.js";
import { PSTATE } from "./models.js";

export function createAttackPacket(source, typeKey, typeInfo, payload, mode, world) {
  const p0 = { x: source.x + 24, y: source.y };
  const target = mode === "off"
    ? { x: world.database.x - 70, y: world.database.cy + rand(-40, 40) }
    : { x: world.impactZone.x + rand(-14, 14), y: world.impactZone.y + rand(-90, 90) };
  // control point creates a curved trajectory
  const midX = (p0.x + target.x) / 2;
  const p1 = { x: midX + rand(-40, 60), y: (p0.y + target.y) / 2 + rand(-120, 120) };

  return {
    kind: "attack",
    id: nextAttackId(),
    sourceId: source.id,
    ip: source.ip,
    attackType: typeKey,
    typeLabel: typeInfo.label,
    tag: typeInfo.tag,
    pattern: typeInfo.pattern,
    sev: typeInfo.sev,
    risk: typeInfo.risk,
    payload: { ...payload },
    p0, p1, p2: target,
    t: 0,
    speed: rand(0.34, 0.5),
    x: p0.x, y: p0.y,
    state: PSTATE.CREATED,
    blocked: false,
    reachedDB: false,
    animPhase: 0,
    inspect: 0,
    frag: 0,
    fade: 1,
    shards: null,
    createdAt: performance.now(),
    responseMs: rand(0.16, 0.28),
    dead: false,
    selected: false,
  };
}

export function drawAttackPacket(ctx, p, time) {
  ctx.save();
  const glow = p.state === PSTATE.INSPECTING ? 0.5 + 0.5 * Math.sin(time * 12) : 1;

  if (p.state === PSTATE.FRAGMENTING || p.state === PSTATE.FADING) {
    // shards
    if (p.shards) {
      for (const s of p.shards) {
        ctx.globalAlpha = p.fade * 0.9;
        ctx.fillStyle = "#ff5a68";
        ctx.beginPath();
        ctx.arc(p.x + s.dx, p.y + s.dy, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    return;
  }

  // capsule body
  ctx.globalAlpha = p.fade;
  ctx.translate(p.x, p.y);
  const w = 46, h = 22;
  ctx.shadowColor = "rgba(255,77,94,0.8)";
  ctx.shadowBlur = 14 * glow;
  const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  g.addColorStop(0, "#ff2d43");
  g.addColorStop(1, "#c81e33");
  ctx.fillStyle = g;
  roundCap(ctx, -w / 2, -h / 2, w, h, h / 2);
  ctx.fill();
  if (p.selected) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  }
  // tag
  ctx.shadowBlur = 0;
  ctx.globalAlpha = p.fade;
  ctx.fillStyle = "#fff";
  ctx.font = "700 10px 'Consolas'";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(p.tag, 0, 0.5);
  ctx.restore();
}

function roundCap(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Position sampler used by simulation.
export function packetPos(p, t) { return bezier(p.p0, p.p1, p.p2, t); }
