// Draws one workstation from an elevated over-the-shoulder angle:
// desk, chair, dual monitors, keyboard/mouse/coffee/plant/accessories,
// and a detailed vector employee seen from behind with subtle idle animation.
import { C } from './config.js';
import { rr, seeded } from './draw.js';
import { drawScreen, drawSecondaryScreen } from './monitor.js';

// Employees are drawn larger than the desk/monitor geometry scale so they
// read as premium/life-sized without covering the monitors.
const BODY = 1.35;

export class Workstation {
  constructor(cam) { this.cam = cam; }

  // Returns the projected geometry so callers (e.g. the Quentra wave) can align.
  geometry(emp) {
    const p = this.cam.project(emp.desk.x, emp.desk.d, 0);
    return { cx: p.x, base: p.y, s: p.s };
  }

  draw(ctx, emp, t) {
    const g = this.geometry(emp);
    const { cx, base, s } = g;

    this._shadow(ctx, cx, base, s);
    this._monitors(ctx, emp, cx, base, s, t);
    this._desk(ctx, cx, base, s, emp);
    this._accessories(ctx, emp, cx, base, s, t);
    this._chair(ctx, emp, cx, base, s);
    this._human(ctx, emp, cx, base, s, t);
  }

  _shadow(ctx, cx, base, s) {
    ctx.fillStyle = 'rgba(40,45,60,0.12)';
    ctx.beginPath();
    ctx.ellipse(cx, base + 2 * s, 120 * s, 22 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  _desk(ctx, cx, base, s, emp) {
    const frontY = base - 46 * s, backY = base - 90 * s;
    const fH = 138 * s, bH = 128 * s;
    // Top surface (wood).
    const g = ctx.createLinearGradient(0, backY, 0, frontY);
    g.addColorStop(0, C.wood); g.addColorStop(1, C.woodDark);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx - fH, frontY); ctx.lineTo(cx + fH, frontY);
    ctx.lineTo(cx + bH, backY); ctx.lineTo(cx - bH, backY);
    ctx.closePath(); ctx.fill();
    // Wood grain.
    ctx.strokeStyle = 'rgba(90,60,35,0.10)'; ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const y = backY + (frontY - backY) * (i / 5);
      const wf = bH + (fH - bH) * (i / 5);
      ctx.beginPath(); ctx.moveTo(cx - wf, y); ctx.lineTo(cx + wf, y); ctx.stroke();
    }
    // Front lip.
    ctx.fillStyle = C.woodDark;
    ctx.beginPath();
    ctx.moveTo(cx - fH, frontY); ctx.lineTo(cx + fH, frontY);
    ctx.lineTo(cx + fH, frontY + 12 * s); ctx.lineTo(cx - fH, frontY + 12 * s);
    ctx.closePath(); ctx.fill();
    // Legs.
    ctx.fillStyle = '#8f8f96';
    ctx.fillRect(cx - fH + 6 * s, frontY + 10 * s, 5 * s, 44 * s);
    ctx.fillRect(cx + fH - 11 * s, frontY + 10 * s, 5 * s, 44 * s);
  }

  _monitors(ctx, emp, cx, base, s, t) {
    const backY = base - 90 * s;
    // Secondary monitor (right, angled).
    const secW = 96 * s, secH = 60 * s;
    const secX = cx + 86 * s, secBottom = backY - 6 * s;
    this._secondaryMonitor(ctx, emp, secX, secBottom, secW, secH, s, t);

    // Primary monitor (faces camera), slightly left of center — large and premium.
    const mW = 168 * s, mH = 100 * s;
    const mX = cx - 18 * s;
    const mBottom = backY - 4 * s;
    const screenY = mBottom - mH;
    const screenX = mX - mW / 2;

    // Stand.
    ctx.fillStyle = '#c4c9d4';
    ctx.fillRect(mX - 4 * s, mBottom, 8 * s, 12 * s);
    ctx.fillStyle = '#aeb4c2';
    rr(ctx, mX - 20 * s, mBottom + 10 * s, 40 * s, 6 * s, 3 * s); ctx.fill();

    // Bezel (thin, enterprise).
    ctx.fillStyle = '#20242c';
    rr(ctx, screenX - 3 * s, screenY - 3 * s, mW + 6 * s, mH + 6 * s, 4 * s); ctx.fill();

    // Screen content (clipped).
    ctx.save();
    rr(ctx, screenX, screenY, mW, mH, 2.5 * s); ctx.clip();
    drawScreen(ctx, screenX, screenY, mW, mH, emp, t, s);
    ctx.restore();

    // Glass reflection sheen.
    ctx.save();
    rr(ctx, screenX, screenY, mW, mH, 2.5 * s); ctx.clip();
    const sg = ctx.createLinearGradient(screenX, screenY, screenX + mW, screenY + mH);
    sg.addColorStop(0, 'rgba(255,255,255,0.12)');
    sg.addColorStop(0.25, 'rgba(255,255,255,0.02)');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sg; ctx.fillRect(screenX, screenY, mW, mH);
    ctx.restore();
    // Bezel outline highlight.
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    rr(ctx, screenX - 3 * s, screenY - 3 * s, mW + 6 * s, mH + 6 * s, 4 * s); ctx.stroke();
  }

  _secondaryMonitor(ctx, emp, x, bottom, w, h, s, t) {
    // Angled (parallelogram) — back edge pushed toward the primary.
    const skew = 12 * s;
    const yTop = bottom - h;
    // stand
    ctx.fillStyle = '#c4c9d4'; ctx.fillRect(x + w / 2 - 3 * s, bottom, 6 * s, 10 * s);
    ctx.fillStyle = '#20242c';
    ctx.beginPath();
    ctx.moveTo(x - 2 * s, yTop - 2 * s + skew);
    ctx.lineTo(x + w + 2 * s, yTop - 2 * s);
    ctx.lineTo(x + w + 2 * s, bottom + 2 * s);
    ctx.lineTo(x - 2 * s, bottom + 2 * s + skew);
    ctx.closePath(); ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, yTop + skew); ctx.lineTo(x + w, yTop);
    ctx.lineTo(x + w, bottom); ctx.lineTo(x, bottom + skew);
    ctx.closePath(); ctx.clip();
    drawSecondaryScreen(ctx, x, yTop, w, h + skew, emp, t, s);
    ctx.restore();
  }

  _accessories(ctx, emp, cx, base, s, t) {
    // Keyboard — sits forward on the desk so it lands under the hands rather
    // than behind the seated body (see _human's handX/kbY).
    const kbY = base - 72 * s;
    ctx.fillStyle = '#e7e9ee';
    rr(ctx, cx - 58 * s, kbY, 116 * s, 24 * s, 4 * s); ctx.fill();
    ctx.fillStyle = '#cfd3dc';
    for (let r = 0; r < 3; r++) for (let c = 0; c < 13; c++) {
      const kx = cx - 53 * s + c * 8.4 * s;
      const ky = kbY + 3 * s + r * 6.4 * s;
      // pressed keys flash while typing
      const pressed = emp.typeIntensity > 0.4 && seeded(r * 11 + c + Math.floor(t * 10)) > 0.9;
      ctx.fillStyle = pressed ? C.blueSoft : '#cfd3dc';
      rr(ctx, kx, ky, 6.2 * s, 5.6 * s, 1.2 * s); ctx.fill();
    }
    // Mouse (follows emp.mouse), beside the keyboard on the same forward band.
    const mx = cx + 68 * s + (emp.mouse.x - 0.6) * 14 * s;
    const my = kbY + 2 * s + (emp.mouse.y - 0.6) * 12 * s;
    ctx.fillStyle = '#e7e9ee';
    rr(ctx, mx, my, 14 * s, 20 * s, 7 * s); ctx.fill();
    ctx.strokeStyle = '#cfd3dc'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(mx + 7 * s, my + 2 * s); ctx.lineTo(mx + 7 * s, my + 10 * s); ctx.stroke();

    // Coffee cup.
    const cupX = cx - 100 * s, cupY = base - 70 * s;
    ctx.fillStyle = '#ffffff';
    rr(ctx, cupX, cupY, 15 * s, 17 * s, 3 * s); ctx.fill();
    ctx.fillStyle = C.purple;
    rr(ctx, cupX, cupY, 15 * s, 5 * s, 2 * s); ctx.fill();
    ctx.strokeStyle = '#c9cdd6'; ctx.lineWidth = 2 * s;
    ctx.beginPath(); ctx.arc(cupX + 17 * s, cupY + 8 * s, 5 * s, -1, 1.4); ctx.stroke();
    // steam
    ctx.strokeStyle = 'rgba(160,170,185,0.45)'; ctx.lineWidth = 1.2 * s;
    ctx.beginPath();
    for (let k = 0; k <= 4; k++) {
      const yy = cupY - k * 3.4 * s;
      const xx = cupX + 7 * s + Math.sin(t * 3 + k * 0.9) * 1.8 * s;
      k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
    }
    ctx.stroke();

    // Small desk plant.
    const px = cx + 104 * s, py = base - 70 * s;
    ctx.fillStyle = '#d9d2c2'; rr(ctx, px, py, 14 * s, 14 * s, 2 * s); ctx.fill();
    ctx.fillStyle = C.plantDark;
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i - 3) * 0.35;
      ctx.save(); ctx.translate(px + 7 * s, py);
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * 7 * s, Math.sin(a) * 7 * s - 5 * s, 3 * s, 8 * s, a, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? C.plant : C.plantDark; ctx.fill();
      ctx.restore();
    }

    // A couple of paper sheets / sticky note.
    ctx.fillStyle = '#ffffff';
    ctx.save(); ctx.translate(cx - 90 * s, base - 50 * s); ctx.rotate(-0.15);
    rr(ctx, 0, 0, 22 * s, 28 * s, 1 * s); ctx.fill();
    ctx.strokeStyle = '#e2e5ec'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(3 * s, i * 6 * s); ctx.lineTo(19 * s, i * 6 * s); ctx.stroke(); }
    ctx.restore();
    ctx.fillStyle = '#ffe9a8';
    rr(ctx, cx + 78 * s, base - 52 * s, 16 * s, 16 * s, 1 * s); ctx.fill();

    // Closed notebook (left of keyboard).
    const nbX = cx - 118 * s, nbY = base - 46 * s;
    ctx.fillStyle = '#3a4150';
    ctx.save(); ctx.translate(nbX, nbY); ctx.rotate(-0.05);
    rr(ctx, 0, 0, 30 * s, 20 * s, 2 * s); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    rr(ctx, 3 * s, 3 * s, 24 * s, 14 * s, 1.5 * s); ctx.fill();
    ctx.restore();

    // Desk phone (upper right, angled), lights up subtly.
    const phX = cx + 104 * s, phY = base - 96 * s;
    ctx.save(); ctx.translate(phX, phY); ctx.rotate(0.08);
    ctx.fillStyle = '#2a2f3a';
    rr(ctx, -16 * s, -4 * s, 32 * s, 22 * s, 3 * s); ctx.fill();
    ctx.fillStyle = '#1c202a';
    rr(ctx, -13 * s, -1 * s, 26 * s, 12 * s, 2 * s); ctx.fill();
    const ringPulse = 0.4 + Math.sin(t * 4) * 0.25 + 0.25;
    ctx.fillStyle = `rgba(74,163,255,${ringPulse.toFixed(2)})`;
    ctx.beginPath(); ctx.arc(11 * s, 5 * s, 2.2 * s, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  _chair(ctx, emp, cx, base, s) {
    const bs = s * BODY;
    const lean = emp.leanBack * 6 * bs;
    // Backrest sits behind the seated body, which meets the desk at seatY.
    const seatY = base - 40 * s;
    const topY = seatY - 66 * bs - lean;
    const backH = seatY - topY + 10 * s;
    ctx.fillStyle = C.chair;
    rr(ctx, cx - 36 * bs, topY, 72 * bs, backH, 14 * bs); ctx.fill();
    // Mesh sheen.
    ctx.fillStyle = C.chairSoft;
    rr(ctx, cx - 30 * bs, topY + 6 * bs, 60 * bs, 26 * bs, 11 * bs); ctx.fill();
    // Headrest.
    ctx.fillStyle = C.chair;
    rr(ctx, cx - 20 * bs, topY - 20 * bs, 40 * bs, 24 * bs, 11 * bs); ctx.fill();
    // Armrests.
    ctx.fillStyle = C.chairSoft;
    rr(ctx, cx - 47 * bs, topY + backH * 0.55, 9 * bs, 26 * bs, 4 * bs); ctx.fill();
    rr(ctx, cx + 38 * bs, topY + backH * 0.55, 9 * bs, 26 * bs, 4 * bs); ctx.fill();
    // Chair base / gas lift column.
    ctx.fillStyle = '#2c313d';
    ctx.fillRect(cx - 4 * bs, base + 4 * bs, 8 * bs, 18 * bs);
  }

  _human(ctx, emp, cx, base, s, t) {
    const p = emp.person;
    const bs = s * BODY;
    const breath = Math.sin(emp.breathe) * 1.6 * bs;
    const lean = emp.leanBack * 6 * bs;

    // The employee sits BEHIND the desk: the torso is cut off at the desk's
    // front edge (drawn in `s` scale) rather than floating in front of it, so
    // the keyboard and mouse stay visible on the desktop surface.
    const seatY = base - 40 * s;                     // where the body meets the desk edge
    const yShoulder = seatY - 62 * bs - lean + breath;

    // Torso / shirt (seen from behind) — narrower than the keyboard so the
    // desk surface and its accessories are never fully hidden.
    ctx.fillStyle = p.shirt;
    ctx.beginPath();
    ctx.moveTo(cx - 34 * bs, seatY);
    ctx.quadraticCurveTo(cx - 38 * bs, yShoulder + 8 * bs, cx - 29 * bs, yShoulder);
    ctx.quadraticCurveTo(cx, yShoulder - 8 * bs, cx + 29 * bs, yShoulder);
    ctx.quadraticCurveTo(cx + 38 * bs, yShoulder + 8 * bs, cx + 34 * bs, seatY);
    ctx.closePath(); ctx.fill();
    // Shirt shading down the spine.
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    ctx.fillRect(cx - 3 * bs, yShoulder, 6 * bs, seatY - yShoulder);
    // Collar.
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    rr(ctx, cx - 14 * bs, yShoulder - 2 * bs, 28 * bs, 7 * bs, 3.5 * bs); ctx.fill();

    // Arms resting on the chair armrests. The hand sits LOW on the armrest,
    // below the elbow bend, so the widest sideways point of the limb (the elbow)
    // stays covered by the long sleeve and only a small hand shows — otherwise a
    // skin patch at elbow height reads as a bare elbow poking through the sleeve.
    const kbY = base - 50 * s;   // low on the armrest, well under the elbow
    const handX = 47 * s;   // resting on the armrest, just outside the torso
    const typeL = Math.sin(emp.typePhase) * 2.5 * s * emp.typeIntensity;
    const typeR = Math.sin(emp.typePhase + 1.7) * 2.5 * s * emp.typeIntensity;
    this._arm(ctx, p.shirt, p.skin, cx - 30 * bs, yShoulder + 12 * bs, cx - handX, kbY + typeL, bs, s);
    this._arm(ctx, p.shirt, p.skin, cx + 30 * bs, yShoulder + 12 * bs, cx + handX, kbY + typeR, bs, s);

    // Finger tapping when frustrated (right hand).
    if (emp.frustration > 0.4) {
      const tap = Math.max(0, Math.sin(emp.fingerTap)) * 3 * s;
      ctx.fillStyle = p.skin;
      ctx.beginPath(); ctx.arc(cx + handX, kbY - tap, 3.4 * s, 0, Math.PI * 2); ctx.fill();
    }

    // Neck — visible between the collar and the head.
    ctx.fillStyle = p.skin;
    rr(ctx, cx - 7 * bs, yShoulder - 15 * bs, 14 * bs, 18 * bs, 4 * bs); ctx.fill();

    // Head (back of the head only — the employee faces the monitor, away
    // from the camera). Hair covers almost the entire visible sphere so it
    // never reads as a face; only a thin skin sliver (the nape) shows low
    // at the bottom, well below eye-level, plus small ear hints.
    const shake = emp.frustration > 0.5 ? Math.sin(t * 5) * 2 * bs * (emp.frustration - 0.5) : 0;
    const hx = cx + emp.headTurn * 6 * bs + shake;
    const hy = yShoulder - 30 * bs;
    const hr = 17 * bs;
    // Nape (small skin sliver at the very bottom of the head, under the hairline).
    ctx.fillStyle = p.skin;
    ctx.beginPath(); ctx.arc(hx, hy + hr * 0.55, hr * 0.62, 0, Math.PI, false); ctx.fill();
    // Hair — covers the entire back/top/sides of the head.
    ctx.fillStyle = p.hair;
    ctx.beginPath(); ctx.arc(hx, hy, hr, 0, Math.PI * 2); ctx.fill();
    // Hair highlight (crown sheen).
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.arc(hx - 4 * s, hy - 7 * s, hr * 0.55, Math.PI, Math.PI * 1.7); ctx.fill();
    // Hair strand texture lines.
    ctx.strokeStyle = 'rgba(0,0,0,0.10)'; ctx.lineWidth = Math.max(0.6, s * 0.7);
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(hx + i * hr * 0.32, hy - hr * 0.75);
      ctx.quadraticCurveTo(hx + i * hr * 0.38, hy, hx + i * hr * 0.30, hy + hr * 0.5);
      ctx.stroke();
    }
    // Ears — small, subtle hints peeking from under the hair (not full discs).
    ctx.fillStyle = p.skin;
    ctx.beginPath(); ctx.ellipse(hx - hr + 2 * s, hy + hr * 0.35, 2 * s, 3.4 * s, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(hx + hr - 2 * s, hy + hr * 0.35, 2 * s, 3.4 * s, 0, 0, Math.PI * 2); ctx.fill();
  }

  // Draws one arm from the shoulder (sx, sy — body scale `bs`) to the hand
  // resting on the keyboard (hx, hy — desk scale `ds`). The elbow is placed
  // outside the shoulder-hand line so the limb bends outward like a real arm
  // reaching forward onto a desk, instead of hanging straight down.
  _arm(ctx, sleeve, skin, sx, sy, hx, hy, bs, ds) {
    const outward = Math.sign(hx - sx) || 1;
    // Elbow sits BETWEEN the shoulder and the hand — closer to the shoulder and
    // only a little lower — so the limb reads as "upper arm angling down, forearm
    // resting forward". Previously it was pushed outward past the hand, which
    // splayed the elbows out like wings.
    const ex = sx + (hx - sx) * 0.34 + outward * 1 * bs;
    const ey = sy + (hy - sy) * 0.5 + 5 * bs;

    // The WHOLE arm is sleeve-coloured (long sleeve) drawn as one continuous
    // limb — a bare skin forearm at this angle read as an odd flipper poking out
    // the side. Shoulder → elbow → hand, tapering slightly toward the wrist.
    ctx.strokeStyle = sleeve; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.lineWidth = 12 * bs;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(sx + outward * 2 * bs, (sy + ey) / 2, ex, ey);
    ctx.stroke();
    ctx.lineWidth = 9.5 * bs;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.quadraticCurveTo((ex + hx) / 2 - outward * 1 * ds, (ey + hy) / 2 + 2 * ds, hx, hy);
    ctx.stroke();

    // Small hand resting at the wrist (skin), just peeking past the cuff.
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.ellipse(hx, hy, 4.6 * ds, 4 * ds, 0, 0, Math.PI * 2); ctx.fill();
  }
}
