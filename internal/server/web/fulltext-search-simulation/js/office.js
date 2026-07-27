// Draws the modern open-plan office: floor, glass walls, meeting room,
// plants, coffee machine, wall displays, soft sunlight, walking workers.
import { C } from './config.js';
import { rr, vgrad, seeded, lerp } from './draw.js';

export class Office {
  constructor(cam) {
    this.cam = cam;
    this.t = 0;
    // Background workers walking along the back corridor.
    this.walkers = [];
    for (let i = 0; i < 6; i++) {
      this.walkers.push({
        p: seeded(i * 9 + 3),
        speed: 0.02 + seeded(i * 4 + 1) * 0.02,
        d: 0.08 + seeded(i * 7) * 0.09,
        dir: i % 2 ? 1 : -1,
        skin: ['#e8b98f', '#c88a5e', '#f0c8a0', '#d9a074'][i % 4],
        shirt: ['#6b7280', '#3f5b8b', '#2f7d6b', '#8a5a7a', '#5b6b8a', '#7a5a6a'][i % 6],
      });
    }
  }

  update(dt) {
    this.t += dt;
    for (const w of this.walkers) {
      w.p += w.speed * dt * w.dir;
      if (w.p > 1.15) w.p = -0.15;
      if (w.p < -0.15) w.p = 1.15;
    }
  }

  draw(ctx) {
    this._backdrop(ctx);
    this._ceiling(ctx);
    this._floor(ctx);
    this._backWall(ctx);
    this._meetingRoom(ctx);
    this._partitions(ctx);
    this._printerArea(ctx);
    this._coffee(ctx);
    this._plants(ctx);
    this._walkers(ctx);
    this._sunlight(ctx);
  }

  _ceiling(ctx) {
    const cam = this.cam, { w } = cam.view;
    const h = cam.topY * 0.42;
    ctx.fillStyle = vgrad(ctx, 0, 0, h, [[0, '#ffffff'], [1, '#eef1f7']]);
    ctx.fillRect(0, 0, w, h);
    // recessed panel lights
    const n = 6;
    for (let i = 0; i < n; i++) {
      const lx = w * ((i + 0.5) / n);
      const pulse = 0.85 + Math.sin(this.t * 0.6 + i) * 0.05;
      ctx.fillStyle = `rgba(255,255,255,${pulse.toFixed(2)})`;
      ctx.shadowColor = 'rgba(255,250,235,0.9)'; ctx.shadowBlur = 14;
      rr(ctx, lx - 34, h * 0.32, 68, 7, 3); ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  _partitions(ctx) {
    const cam = this.cam;
    // Low frosted-glass desk partitions along the mid-depth row, behind the
    // desk cluster, to break up the open floor and add depth layers.
    const spots = [-0.75, -0.30, 0.20, 0.70];
    for (const wx of spots) {
      const a = cam.project(wx - 0.16, 0.24, 0);
      const b = cam.project(wx + 0.16, 0.24, 0);
      const hgt = 46 * a.s;
      ctx.save();
      ctx.fillStyle = 'rgba(210,220,235,0.35)';
      ctx.fillRect(a.x, a.y - hgt, b.x - a.x, hgt);
      ctx.strokeStyle = 'rgba(170,185,205,0.5)'; ctx.lineWidth = 1.5;
      ctx.strokeRect(a.x, a.y - hgt, b.x - a.x, hgt);
      ctx.fillStyle = '#c7cfdd';
      ctx.fillRect(a.x, a.y - 4, b.x - a.x, 4);
      ctx.restore();
    }
  }

  _printerArea(ctx) {
    const cam = this.cam;
    // Printer / copy nook, far back-left near the corridor.
    const base = cam.project(-1.30, 0.15, 0);
    const s = base.s;
    ctx.save();
    ctx.fillStyle = 'rgba(60,60,70,0.10)';
    ctx.beginPath(); ctx.ellipse(base.x, base.y, 30 * s, 8 * s, 0, 0, Math.PI * 2); ctx.fill();
    // body
    ctx.fillStyle = '#e7e9ee';
    rr(ctx, base.x - 26 * s, base.y - 58 * s, 52 * s, 50 * s, 4 * s); ctx.fill();
    ctx.fillStyle = '#cfd3dc';
    rr(ctx, base.x - 26 * s, base.y - 58 * s, 52 * s, 12 * s, 4 * s); ctx.fill();
    // paper tray
    ctx.fillStyle = '#ffffff';
    rr(ctx, base.x - 20 * s, base.y - 14 * s, 40 * s, 8 * s, 1 * s); ctx.fill();
    // control panel light
    const blink = Math.sin(this.t * 2) > 0.3 ? C.greenSoft : '#8fae9a';
    ctx.fillStyle = blink;
    ctx.beginPath(); ctx.arc(base.x + 18 * s, base.y - 50 * s, 2.4 * s, 0, Math.PI * 2); ctx.fill();
    // output sheet occasionally sliding out
    const cyc = (this.t * 0.4) % 1;
    if (cyc < 0.6) {
      const slide = Math.min(1, cyc / 0.5);
      ctx.fillStyle = '#ffffff';
      rr(ctx, base.x - 12 * s, base.y - 18 * s, 24 * s, 10 * s * slide, 1 * s); ctx.fill();
    }
    ctx.restore();
  }

  _backdrop(ctx) {
    const { w, h } = this.cam.view;
    ctx.fillStyle = vgrad(ctx, 0, 0, h, [[0, C.bgTop], [0.5, C.bg], [1, '#eef1f7']]);
    ctx.fillRect(0, 0, w, h);
  }

  _floor(ctx) {
    const cam = this.cam, { w } = cam.view;
    const topY = cam.topY, botY = cam.botY;
    // Warm wood floor with perspective planks.
    ctx.fillStyle = vgrad(ctx, 0, topY, botY, [[0, '#efeadf'], [1, '#e2dbcc']]);
    ctx.fillRect(0, topY, w, botY - topY);

    // Perspective plank lines (converging slightly).
    ctx.save();
    ctx.lineWidth = 1;
    for (let i = -7; i <= 7; i++) {
      const xf = i / 7;
      const far = cam.project(xf * 1.5, 0.02, 0);
      const near = cam.project(xf * 1.5, 1.0, 0);
      ctx.strokeStyle = 'rgba(150,130,100,0.10)';
      ctx.beginPath(); ctx.moveTo(far.x, far.y); ctx.lineTo(near.x, near.y); ctx.stroke();
    }
    // Horizontal depth seams.
    for (let d = 0.1; d < 1.0; d += 0.12) {
      const l = cam.project(-1.6, d, 0), r = cam.project(1.6, d, 0);
      ctx.strokeStyle = 'rgba(150,130,100,0.07)';
      ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.stroke();
    }
    ctx.restore();

    // Soft area rug under the desk cluster.
    const rugL = cam.project(-1.0, 0.35, 0), rugR = cam.project(1.0, 0.35, 0);
    const rugBL = cam.project(-1.05, 1.0, 0), rugBR = cam.project(1.05, 1.0, 0);
    ctx.fillStyle = 'rgba(224,232,244,0.45)';
    ctx.beginPath();
    ctx.moveTo(rugL.x, rugL.y); ctx.lineTo(rugR.x, rugR.y);
    ctx.lineTo(rugBR.x, rugBR.y); ctx.lineTo(rugBL.x, rugBL.y);
    ctx.closePath(); ctx.fill();
  }

  _backWall(ctx) {
    const cam = this.cam, { w } = cam.view;
    const wallH = cam.topY;
    // Wall gradient.
    ctx.fillStyle = vgrad(ctx, 0, 0, wallH, [[0, '#f4f6fb'], [1, '#e9edf5']]);
    ctx.fillRect(0, 0, w, wallH);
    // Baseboard.
    ctx.fillStyle = '#dfe4ee';
    ctx.fillRect(0, wallH - 6, w, 6);

    // Large glass window band with sky beyond.
    const winY = wallH * 0.24, winH = wallH * 0.52;
    const winX = w * 0.05, winW = w * 0.44;
    ctx.fillStyle = vgrad(ctx, 0, winY, winY + winH, [[0, '#dce9f6'], [1, '#eef4fb']]);
    rr(ctx, winX, winY, winW, winH, 6); ctx.fill();
    // Mullions.
    ctx.strokeStyle = '#c7cfdd'; ctx.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      const x = winX + winW * (i / 4);
      ctx.beginPath(); ctx.moveTo(x, winY); ctx.lineTo(x, winY + winH); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(winX, winY + winH * 0.5); ctx.lineTo(winX + winW, winY + winH * 0.5); ctx.stroke();
    ctx.strokeStyle = '#b8c2d2'; ctx.lineWidth = 4; rr(ctx, winX, winY, winW, winH, 6); ctx.stroke();

    // Hallway opening leading deeper into the office (far right).
    const hwX = w * 0.90, hwW = w * 0.10;
    ctx.fillStyle = 'rgba(200,208,222,0.55)';
    ctx.fillRect(hwX, wallH * 0.10, hwW, wallH * 0.90);
    ctx.fillStyle = vgrad(ctx, 0, wallH * 0.12, wallH, [[0, '#e4e9f2'], [1, '#cfd6e4']]);
    ctx.fillRect(hwX + 6, wallH * 0.12, hwW - 12, wallH * 0.88);
    ctx.strokeStyle = '#b8c2d2'; ctx.lineWidth = 3;
    ctx.strokeRect(hwX, wallH * 0.10, hwW, wallH * 0.90);

    // Wall displays (dashboards on the right side of the back wall).
    for (let i = 0; i < 2; i++) {
      const dx = w * 0.58 + i * w * 0.145;
      const dy = wallH * 0.28, dw = w * 0.11, dh = wallH * 0.34;
      ctx.fillStyle = '#20283a'; rr(ctx, dx, dy, dw, dh, 5); ctx.fill();
      ctx.fillStyle = i ? '#173a5e' : '#1c3b2e'; rr(ctx, dx + 5, dy + 5, dw - 10, dh - 10, 3); ctx.fill();
      // fake chart bars
      ctx.fillStyle = i ? '#4aa3ff' : '#43d68a';
      for (let b = 0; b < 5; b++) {
        const bh = (dh - 18) * (0.3 + seeded(i * 5 + b) * 0.6);
        ctx.fillRect(dx + 10 + b * ((dw - 20) / 5), dy + dh - 8 - bh, (dw - 20) / 5 - 3, bh);
      }
    }
  }

  _meetingRoom(ctx) {
    const cam = this.cam;
    // Glass-walled meeting room in the far-left back corner.
    const a = cam.project(-1.55, 0.05, 0);
    const b = cam.project(-0.95, 0.05, 0);
    const top = cam.topY;
    const hTop = top - 118;
    ctx.save();
    // glass panels
    ctx.fillStyle = C.glass;
    ctx.fillRect(a.x, hTop, b.x - a.x, top - hTop);
    ctx.strokeStyle = C.glassEdge; ctx.lineWidth = 2;
    ctx.strokeRect(a.x, hTop, b.x - a.x, top - hTop);
    // vertical frame divisions
    for (let i = 1; i < 3; i++) {
      const x = a.x + (b.x - a.x) * (i / 3);
      ctx.beginPath(); ctx.moveTo(x, hTop); ctx.lineTo(x, top); ctx.stroke();
    }
    // reflection sheen
    const g = ctx.createLinearGradient(a.x, hTop, b.x, top);
    g.addColorStop(0, 'rgba(255,255,255,0.25)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.02)');
    ctx.fillStyle = g;
    ctx.fillRect(a.x, hTop, b.x - a.x, top - hTop);
    ctx.restore();
  }

  _coffee(ctx) {
    const cam = this.cam;
    // Coffee point on the far right.
    const base = cam.project(1.35, 0.14, 0);
    const s = base.s;
    ctx.save();
    // counter
    ctx.fillStyle = '#d8d1c2';
    rr(ctx, base.x - 34 * s, base.y - 26 * s, 68 * s, 26 * s, 4); ctx.fill();
    // machine body
    ctx.fillStyle = '#2b3242';
    rr(ctx, base.x - 16 * s, base.y - 72 * s, 32 * s, 48 * s, 5); ctx.fill();
    ctx.fillStyle = '#3c4658';
    rr(ctx, base.x - 12 * s, base.y - 66 * s, 24 * s, 14 * s, 3); ctx.fill();
    // spout + cup
    ctx.fillStyle = '#8b93a6';
    ctx.fillRect(base.x - 3 * s, base.y - 40 * s, 6 * s, 8 * s);
    ctx.fillStyle = '#ffffff';
    rr(ctx, base.x - 5 * s, base.y - 30 * s, 10 * s, 9 * s, 2); ctx.fill();
    // steam
    ctx.strokeStyle = 'rgba(180,190,205,0.5)'; ctx.lineWidth = 1.4 * s;
    for (let i = 0; i < 2; i++) {
      const ox = (i - 0.5) * 5 * s;
      ctx.beginPath();
      for (let k = 0; k <= 6; k++) {
        const yy = base.y - 30 * s - k * 4 * s;
        const xx = base.x + ox + Math.sin(this.t * 3 + k * 0.8 + i) * 2.2 * s;
        k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  _plants(ctx) {
    const spots = [
      { x: -1.42, d: 0.20 }, { x: 1.42, d: 0.30 },
      { x: -1.30, d: 0.62 }, { x: 1.30, d: 0.72 },
    ];
    for (let i = 0; i < spots.length; i++) this._plant(ctx, spots[i].x, spots[i].d, i);
  }

  _plant(ctx, wx, d, seed) {
    const cam = this.cam;
    const p = cam.project(wx, d, 0);
    const s = p.s;
    ctx.save();
    // shadow
    ctx.fillStyle = 'rgba(60,60,70,0.10)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y, 26 * s, 8 * s, 0, 0, Math.PI * 2); ctx.fill();
    // pot
    ctx.fillStyle = '#cfc6b4';
    ctx.beginPath();
    ctx.moveTo(p.x - 16 * s, p.y - 2 * s);
    ctx.lineTo(p.x + 16 * s, p.y - 2 * s);
    ctx.lineTo(p.x + 12 * s, p.y - 30 * s);
    ctx.lineTo(p.x - 12 * s, p.y - 30 * s);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    ctx.fillRect(p.x - 12 * s, p.y - 32 * s, 24 * s, 4 * s);
    // foliage — layered leaves
    const leaves = 11;
    for (let i = 0; i < leaves; i++) {
      const a = -Math.PI / 2 + (i - leaves / 2) * 0.28 + Math.sin(this.t * 0.8 + seed + i) * 0.02;
      const len = (50 + seeded(seed * 7 + i) * 34) * s;
      const bx = p.x, by = p.y - 30 * s;
      const ex = bx + Math.cos(a) * len, ey = by + Math.sin(a) * len;
      const cx = bx + Math.cos(a) * len * 0.5 - Math.sin(a) * 12 * s;
      const cy = by + Math.sin(a) * len * 0.5 + Math.cos(a) * 12 * s;
      ctx.strokeStyle = i % 2 ? C.plant : C.plantDark;
      ctx.lineWidth = (5 + seeded(seed + i) * 3) * s;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(cx, cy, ex, ey); ctx.stroke();
    }
    ctx.restore();
  }

  _walkers(ctx) {
    const cam = this.cam;
    for (const wk of this.walkers) {
      const wx = lerp(-1.5, 1.5, wk.p);
      const p = cam.project(wx, wk.d, 0);
      const s = p.s * 0.85;
      const bob = Math.sin(this.t * 6 + wk.p * 20) * 2 * s;
      ctx.save();
      ctx.fillStyle = 'rgba(60,60,70,0.10)';
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 12 * s, 4 * s, 0, 0, Math.PI * 2); ctx.fill();
      // legs
      ctx.strokeStyle = '#3a4150'; ctx.lineWidth = 5 * s; ctx.lineCap = 'round';
      const step = Math.sin(this.t * 6 + wk.p * 20) * 6 * s;
      ctx.beginPath(); ctx.moveTo(p.x - 4 * s, p.y - 44 * s); ctx.lineTo(p.x - 4 * s + step, p.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p.x + 4 * s, p.y - 44 * s); ctx.lineTo(p.x + 4 * s - step, p.y); ctx.stroke();
      // body
      ctx.fillStyle = wk.shirt;
      rr(ctx, p.x - 11 * s, p.y - 78 * s + bob, 22 * s, 40 * s, 8 * s); ctx.fill();
      // head
      ctx.fillStyle = wk.skin;
      ctx.beginPath(); ctx.arc(p.x, p.y - 90 * s + bob, 10 * s, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2c2320';
      ctx.beginPath(); ctx.arc(p.x, p.y - 93 * s + bob, 10 * s, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
      ctx.restore();
    }
  }

  _sunlight(ctx) {
    const { w, h } = this.cam.view;
    // Soft diagonal sunlight beam from the window.
    const g = ctx.createLinearGradient(w * 0.12, 0, w * 0.5, h * 0.7);
    g.addColorStop(0, 'rgba(255,246,214,0.20)');
    g.addColorStop(0.6, 'rgba(255,250,235,0.04)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(w * 0.08, 0); ctx.lineTo(w * 0.34, 0);
    ctx.lineTo(w * 0.62, h); ctx.lineTo(w * 0.24, h);
    ctx.closePath(); ctx.fill();
    // subtle vignette
    const vg = ctx.createRadialGradient(w / 2, h * 0.5, h * 0.4, w / 2, h * 0.5, h * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(30,40,60,0.10)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
  }
}
