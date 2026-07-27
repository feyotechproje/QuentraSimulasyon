// customer.js
// Visual customer: a small vector humanoid with a finite state machine and
// waypoint-based movement. Cosmetic only — no data is persisted.

export const CUSTOMER_STATE = {
  APPROACHING: "APPROACHING",
  WAITING: "WAITING",
  UNLOADING: "UNLOADING",
  SCANNING: "SCANNING",
  PAYING: "PAYING",
  RECEIPT: "RECEIPT",
  LEAVING: "LEAVING",
  COMPLETED: "COMPLETED",
};

const BASE_SPEED = 96; // world units / second

export class Customer {
  constructor(appearance) {
    this.id = appearance.id;
    this.appearance = appearance;

    this.pos = { x: 0, y: 0 };
    this.waypoints = [];
    this.wpIndex = 0;
    this.moving = false;
    this.arrived = false;
    this.facing = "down";

    this.speed = BASE_SPEED * (0.92 + Math.random() * 0.16);
    this.animPhase = Math.random() * Math.PI * 2;

    this.state = CUSTOMER_STATE.APPROACHING;
    this.registerId = null;
    this.queueIndex = -1;

    this.basketItems = 0;
    this.scannedItems = 0;
    this.basketTotal = 0;

    // metric timestamps (sim seconds)
    this.joinedQueueAt = 0;
    // True while walking in from the off-screen door; such shoppers are not
    // drawn, so the scene shows queues rather than entrance traffic.
    this.enteringStore = false;
    this.serviceStartedAt = 0;
  }

  setPath(waypoints) {
    this.waypoints = waypoints;
    this.wpIndex = 0;
    this.arrived = false;
    this.moving = waypoints.length > 0;
  }

  goTo(point) { this.setPath([{ x: point.x, y: point.y }]); }

  update(dt) {
    // limb animation only advances while actually walking
    if (this.moving) this.animPhase += dt * this.speed * 0.18;

    if (this.wpIndex >= this.waypoints.length) { this.moving = false; return; }
    const t = this.waypoints[this.wpIndex];
    const dx = t.x - this.pos.x;
    const dy = t.y - this.pos.y;
    const dist = Math.hypot(dx, dy);
    const step = this.speed * dt;

    if (dist <= step || dist < 0.5) {
      this.pos.x = t.x;
      this.pos.y = t.y;
      this.wpIndex++;
      if (this.wpIndex >= this.waypoints.length) {
        this.moving = false;
        this.arrived = true;
      }
    } else {
      this.pos.x += (dx / dist) * step;
      this.pos.y += (dy / dist) * step;
      this.moving = true;
      this.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
    }
  }

  get depth() { return this.pos.y; }
}

/**
 * Renders a humanoid at world (x,y). Shared by customers and cashiers.
 * pose: { facing, walkPhase, moving, armAction ('scan'|'receipt'|null), carry }
 */
export function drawPerson(r, x, y, app, pose) {
  const ctx = r.ctx;
  const s = r.scale;
  const hs = app.heightScale || 1;
  const feet = r.toScreen(x, y, 0);
  const fx = feet.x, fy = feet.y;

  const facing = pose.facing || "down";
  const swing = pose.moving ? Math.sin(pose.walkPhase) : 0;

  const legLen = 15 * hs * s;
  const torsoH = 18 * hs * s;
  const torsoW = 15 * hs * s;
  const headR = 6.4 * hs * s;
  const shoulderW = 16 * hs * s;

  const hipY = fy - legLen;
  const shoulderY = hipY - torsoH;
  const headCY = shoulderY - headR * 0.85;

  // shadow
  ctx.save();
  ctx.fillStyle = "rgba(20,25,40,0.13)";
  ctx.beginPath();
  ctx.ellipse(fx, fy + 1.5 * s, 10 * hs * s, 3.8 * hs * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const sideView = facing === "left" || facing === "right";
  const dir = facing === "left" ? -1 : 1;

  // ---- legs ----
  const legW = 5 * hs * s;
  const legSwing = swing * 4 * s;
  const pants = app.pants;
  const shoe = "#2a2f3a";
  const drawLeg = (ox, phase) => {
    const footShift = phase;
    r.roundRect(fx + ox - legW / 2, hipY, legW, legLen, 2 * s);
    ctx.fillStyle = pants; ctx.fill();
    // shoe
    ctx.fillStyle = shoe;
    r.roundRect(fx + ox - legW / 2 + footShift, fy - 3 * s, legW + 1.5 * s, 4 * s, 1.5 * s);
    ctx.fill();
  };
  if (sideView) {
    drawLeg(-2 * s + legSwing * 0.6, legSwing * 0.5 * dir);
    drawLeg(2 * s - legSwing * 0.6, -legSwing * 0.5 * dir);
  } else {
    drawLeg(-3.5 * hs * s, legSwing);
    drawLeg(3.5 * hs * s, -legSwing);
  }

  // ---- torso ----
  ctx.fillStyle = app.shirt;
  r.roundRect(fx - torsoW / 2, shoulderY, torsoW, torsoH + 2 * s, 4 * s);
  ctx.fill();
  // subtle shading on one side
  ctx.fillStyle = "rgba(0,0,0,0.07)";
  r.roundRect(fx + torsoW / 2 - 4 * s, shoulderY, 4 * s, torsoH + 2 * s, 3 * s);
  ctx.fill();

  // ---- arms ----
  const armW = 4.2 * hs * s;
  const armLen = torsoH * 0.92;
  const armSwing = swing * 3.5 * s;
  let handL, handR;
  const drawArm = (ox, phase, forward) => {
    const topX = fx + ox;
    let botX = topX + phase;
    let botY = shoulderY + armLen;
    if (forward) { botX = fx + ox * 0.35; botY = shoulderY + armLen * 0.72; }
    ctx.strokeStyle = app.shirt;
    ctx.lineWidth = armW;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(topX, shoulderY + 2 * s);
    ctx.lineTo(botX, botY);
    ctx.stroke();
    // hand
    ctx.fillStyle = app.skin;
    ctx.beginPath();
    ctx.arc(botX, botY, 2.6 * hs * s, 0, Math.PI * 2);
    ctx.fill();
    return { x: botX, y: botY };
  };

  const carrying = pose.carry === "basket";
  const scanning = pose.armAction === "scan";
  const armPhase = scanning ? Math.abs(Math.sin(pose.walkPhase * 3)) : 0;

  if (scanning) {
    // both arms reach forward/down over the belt, alternating
    handL = drawArm(-shoulderW / 2, 0, true);
    handR = drawArm(shoulderW / 2, 0, true);
    ctx.strokeStyle = app.shirt; ctx.lineWidth = armW; ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(fx + shoulderW / 2, shoulderY + 2 * s);
    ctx.lineTo(fx + 2 * s, shoulderY + armLen * (0.55 + armPhase * 0.4));
    ctx.stroke();
  } else if (carrying) {
    handL = drawArm(-shoulderW / 2, 0, true);
    handR = drawArm(shoulderW / 2, 0, true);
  } else {
    handL = drawArm(-shoulderW / 2, armSwing, false);
    handR = drawArm(shoulderW / 2, -armSwing, false);
  }

  // ---- carried basket / cart (in front, drawn over lower body) ----
  if (pose.carry === "basket" && (pose.facing === "down" || pose.moving)) {
    const bx = fx, by = shoulderY + armLen * 0.78;
    ctx.fillStyle = "#c2452f";
    r.roundRect(bx - 9 * s, by, 18 * s, 8 * s, 2 * s);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    r.roundRect(bx - 9 * s, by, 18 * s, 2.5 * s, 1.5 * s);
    ctx.fill();
    ctx.strokeStyle = "#8f2f1f"; ctx.lineWidth = 1.4 * s;
    ctx.beginPath(); ctx.arc(bx, by, 8 * s, Math.PI, 0); ctx.stroke();
  } else if (pose.carry === "cart" && (pose.facing === "down" || pose.moving)) {
    const cxp = fx, cyp = fy - 2 * s;
    ctx.strokeStyle = "#9aa3b2"; ctx.lineWidth = 2 * s; ctx.lineJoin = "round";
    ctx.strokeRect(cxp - 11 * s, cyp - 16 * s, 22 * s, 12 * s);
    ctx.beginPath();
    ctx.moveTo(cxp - 11 * s, cyp - 16 * s);
    ctx.lineTo(cxp - 15 * s, cyp - 22 * s);
    ctx.stroke();
    ctx.fillStyle = "#c7ced9";
    ctx.beginPath(); ctx.arc(cxp - 7 * s, cyp - 2 * s, 2.4 * s, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cxp + 7 * s, cyp - 2 * s, 2.4 * s, 0, Math.PI * 2); ctx.fill();
  }

  // ---- head ----
  ctx.fillStyle = app.skin;
  ctx.beginPath();
  ctx.arc(fx, headCY, headR, 0, Math.PI * 2);
  ctx.fill();
  // neck shade
  ctx.fillStyle = "rgba(0,0,0,0.08)";
  r.roundRect(fx - 3 * s, shoulderY - 3 * s, 6 * s, 4 * s, 1.5 * s);
  ctx.fill();

  // ---- hair ----
  drawHair(r, fx, headCY, headR, app, facing, dir);

  // ---- face (only when facing camera) ----
  if (facing === "down") {
    ctx.fillStyle = "#2a2f3a";
    const eyeY = headCY + headR * 0.05;
    ctx.beginPath(); ctx.arc(fx - headR * 0.38, eyeY, 0.95 * s, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(fx + headR * 0.38, eyeY, 0.95 * s, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(120,70,60,0.6)"; ctx.lineWidth = 1 * s;
    ctx.beginPath(); ctx.arc(fx, eyeY + headR * 0.42, headR * 0.28, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  } else if (sideView) {
    ctx.fillStyle = "#2a2f3a";
    ctx.beginPath(); ctx.arc(fx + dir * headR * 0.45, headCY + headR * 0.05, 0.95 * s, 0, Math.PI * 2); ctx.fill();
  }
}

function drawHair(r, cx, cy, headR, app, facing, dir) {
  const ctx = r.ctx;
  const s = r.scale;
  ctx.fillStyle = app.hair;
  const style = app.hairStyle;
  if (style === "bald") return;

  const backFacing = facing === "up";
  switch (style) {
    case "buzz":
      ctx.beginPath();
      ctx.arc(cx, cy - headR * 0.12, headR * (backFacing ? 1.02 : 0.98), Math.PI, 0);
      ctx.fill();
      break;
    case "cap":
      ctx.fillStyle = "#3b4252";
      r.roundRect(cx - headR, cy - headR * 1.0, headR * 2, headR * 0.9, 3 * s);
      ctx.fill();
      if (!backFacing) { ctx.fillRect(cx - headR * 1.1, cy - headR * 0.2, headR * 1.1, headR * 0.35); }
      break;
    case "bun":
      ctx.beginPath(); ctx.arc(cx, cy - headR * 0.15, headR * 1.02, Math.PI, 0); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy - headR * 1.15, headR * 0.55, 0, Math.PI * 2); ctx.fill();
      if (backFacing) { r.roundRect(cx - headR * 0.9, cy - headR * 0.2, headR * 1.8, headR * 1.0, 3 * s); ctx.fill(); }
      break;
    case "long":
      ctx.beginPath(); ctx.arc(cx, cy - headR * 0.1, headR * 1.05, Math.PI, 0); ctx.fill();
      r.roundRect(cx - headR * 1.02, cy - headR * 0.5, headR * 2.04, headR * (backFacing ? 2.1 : 1.5), 4 * s);
      ctx.fill();
      break;
    default: // short
      ctx.beginPath(); ctx.arc(cx, cy - headR * 0.12, headR * 1.02, Math.PI, 0); ctx.fill();
      if (backFacing) { r.roundRect(cx - headR * 0.95, cy - headR * 0.2, headR * 1.9, headR * 0.7, 3 * s); ctx.fill(); }
      else { ctx.fillRect(cx - headR, cy - headR * 0.3, headR * 2, headR * 0.28); }
      break;
  }
}
