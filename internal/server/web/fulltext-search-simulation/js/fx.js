// Floating comparison panel, the Quentra activation notification toast,
// and the purple energy wave that sweeps across the office on activation.
import { C } from './config.js';
import { rr, clamp, smooth, t as tr } from './draw.js';

export class Wave {
  constructor(view) { this.view = view; this.active = false; this.t = 0; this.hits = new Set(); this.cx = view.w * 0.5; this.cy = 120; }
  trigger() { this.active = true; this.t = 0; this.hits.clear(); }
  reset() { this.active = false; this.t = 0; this.hits.clear(); }
  update(dt) { if (this.active) { this.t += dt; if (this.t > 1.8) this.active = false; } }
  // Radius the leading edge has reached (screen px), for syncing monitor flips.
  radius() { return this.t * 1150; }
  // True once the wave has swept past (px, py); latches per id so a monitor
  // flips exactly once even after the ring itself fades out.
  hasReached(id, px, py) {
    if (this.hits.has(id)) return true;
    if (this.t <= 0) return false;
    if (Math.hypot(px - this.cx, py - this.cy) <= this.radius()) { this.hits.add(id); return true; }
    return false;
  }
  draw(ctx) {
    if (!this.active) return;
    const { w, h } = this.view;
    const cx = this.cx, cy = this.cy;
    const maxR = Math.hypot(w, h);
    const p = smooth(clamp(this.t / 1.6, 0, 1));
    const r = p * maxR;
    ctx.save();
    // leading ring
    ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.createRadialGradient(cx, cy, Math.max(0, r - 90), cx, cy, r + 12);
    grad.addColorStop(0, 'rgba(124,58,237,0)');
    grad.addColorStop(0.82, 'rgba(139,92,246,0.05)');
    grad.addColorStop(0.94, `rgba(167,139,250,${0.35 * (1 - p)})`);
    grad.addColorStop(1, 'rgba(124,58,237,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx, cy, r + 12, 0, Math.PI * 2); ctx.fill();
    // crisp ring line
    ctx.strokeStyle = `rgba(124,58,237,${0.5 * (1 - p)})`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    // sparks
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + this.t;
      const rr2 = r + Math.sin(i * 3.3) * 10;
      const x = cx + Math.cos(a) * rr2, y = cy + Math.sin(a) * rr2 * 0.86;
      ctx.fillStyle = `rgba(196,181,253,${0.5 * (1 - p)})`;
      ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

export class Toast {
  constructor(view) { this.view = view; this.t = -1; }
  show() { this.t = 0; }
  reset() { this.t = -1; }
  update(dt) { if (this.t >= 0) { this.t += dt; if (this.t > 4.2) this.t = -1; } }
  draw(ctx) {
    if (this.t < 0) return;
    const { w } = this.view;
    const inA = smooth(clamp(this.t / 0.4, 0, 1));
    const outA = 1 - smooth(clamp((this.t - 3.6) / 0.6, 0, 1));
    const a = inA * outA;
    const pw = 300, ph = 66;
    const x = w * 0.5 - pw / 2;
    const y = 96 - (1 - inA) * 20;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.shadowColor = 'rgba(124,58,237,0.35)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#ffffff';
    rr(ctx, x, y, pw, ph, 14); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    // purple emblem
    ctx.fillStyle = C.purple;
    rr(ctx, x + 14, y + 15, 36, 36, 10); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '800 22px -apple-system, Segoe UI, Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Q', x + 32, y + 34);
    // text
    ctx.textAlign = 'left';
    ctx.fillStyle = C.purple; ctx.font = '800 15px -apple-system, Segoe UI, Inter, sans-serif';
    ctx.fillText(tr('toast.brand', 'QUENTRA'), x + 62, y + 24);
    ctx.fillStyle = C.ink; ctx.font = '600 12.5px -apple-system, Segoe UI, Inter, sans-serif';
    ctx.fillText(tr('toast.activated', 'FullText / NGram Engine Activated'), x + 62, y + 44);
    ctx.restore();
  }
}

