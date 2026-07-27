// particles.js — object-pooled particle system for impact bursts.

export class ParticlePool {
  constructor(max = 400) {
    this.max = max;
    this.pool = [];
    this.active = [];
    for (let i = 0; i < max; i++) this.pool.push(this._blank());
  }
  _blank() {
    return { x: 0, y: 0, vx: 0, vy: 0, life: 0, age: 0, r: 1, color: "255,77,94" };
  }
  spawn(x, y, opts) {
    const p = this.pool.pop();
    if (!p) return;
    p.x = x; p.y = y;
    const ang = opts.ang ?? Math.random() * Math.PI * 2;
    const spd = opts.spd ?? (40 + Math.random() * 120);
    p.vx = Math.cos(ang) * spd;
    p.vy = Math.sin(ang) * spd;
    p.life = opts.life ?? (0.4 + Math.random() * 0.5);
    p.age = 0;
    p.r = opts.r ?? (1.5 + Math.random() * 2.5);
    p.color = opts.color ?? "255,77,94";
    this.active.push(p);
  }
  burst(x, y, color, count, spdMax = 150) {
    for (let i = 0; i < count; i++) {
      if (!this.pool.length) break;
      this.spawn(x, y, {
        ang: Math.random() * Math.PI * 2,
        spd: 30 + Math.random() * spdMax,
        color,
      });
    }
  }
  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.active.splice(i, 1);
        this.pool.push(p);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.94;
      p.vy = p.vy * 0.94 + 40 * dt; // slight gravity
    }
  }
  draw(ctx) {
    for (const p of this.active) {
      const a = 1 - p.age / p.life;
      ctx.globalAlpha = a;
      ctx.fillStyle = `rgba(${p.color},${a})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
