// Small shared canvas helpers.

export function rr(ctx, x, y, w, h, r) {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
export function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

// Deterministic pseudo-random from an integer seed.
export function seeded(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function fmtInt(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Small helper so canvas-drawing modules can pull translated strings without
// each one importing the shared i18n runtime directly.
export function t(key, fallback) {
  return (window.QuentraI18n && window.QuentraI18n.t(key, fallback)) || fallback || key;
}

// Vertical linear gradient helper.
export function vgrad(ctx, x, y0, y1, stops) {
  const g = ctx.createLinearGradient(x, y0, x, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}
