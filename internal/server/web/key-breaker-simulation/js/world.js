// world.js — builds the static scene geometry (positions & hit boxes) in VIEW space.

import { LAYOUT } from "./config.js";

export function buildWorld(dataSource) {
  const attackers = dataSource.attackers().map((a, i) => ({
    ...a,
    x: LAYOUT.attackerX,
    y: LAYOUT.attackerTop + i * LAYOUT.attackerGap,
    r: 22,
    pulse: Math.random() * Math.PI * 2,
    lastFire: 0,
    count: 0,
  }));

  const gatewayCore = { x: LAYOUT.gatewayX, y: LAYOUT.shieldCy };

  return {
    attackers,
    shield: { cx: LAYOUT.shieldCx, cy: LAYOUT.shieldCy, r: LAYOUT.shieldR },
    hero: { cx: LAYOUT.heroCx, baseY: LAYOUT.heroBaseY, h: LAYOUT.heroHeight },
    gatewayCore,
    database: { x: LAYOUT.dbX, cy: LAYOUT.dbCy, w: 128, h: 200 },
    safeLaneY: LAYOUT.safeLaneY,
    // Impact zone: front-left face of the shield where attacks are stopped.
    impactZone: { x: LAYOUT.shieldCx - LAYOUT.shieldR * 0.72, y: LAYOUT.shieldCy },
  };
}

// Returns { type, ref } for a click at virtual coords, or null.
export function hitTest(world, vx, vy, sim) {
  // packets first (small, on top)
  for (const p of sim.attackPackets) {
    if (p.dead) continue;
    if (Math.hypot(p.x - vx, p.y - vy) < 20) return { type: "attack", ref: p };
  }
  for (const q of sim.safePackets) {
    if (q.dead) continue;
    if (Math.hypot(q.x - vx, q.y - vy) < 20) return { type: "safe", ref: q };
  }
  // attackers
  for (const a of world.attackers) {
    if (Math.hypot(a.x - vx, a.y - vy) < a.r + 10) return { type: "attacker", ref: a };
  }
  // shield / hero
  const s = world.shield;
  if (Math.hypot(s.cx - vx, s.cy - vy) < s.r) return { type: "keybreaker", ref: null };
  // database
  const d = world.database;
  if (vx > d.x - d.w / 2 && vx < d.x + d.w / 2 && vy > d.cy - d.h / 2 && vy < d.cy + d.h / 2)
    return { type: "database", ref: null };
  return null;
}
