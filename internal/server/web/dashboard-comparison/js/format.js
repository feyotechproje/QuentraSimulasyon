// format.js — number formatting + count-up animation helpers.

const nf = new Intl.NumberFormat("en-US");
const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function int(n) { return nf.format(Math.round(n || 0)); }
export function dec(n) { return nf2.format(n || 0); }

/** Compact currency-ish: 24.5M / 8.2M / 253K. */
export function money(n) {
  n = n || 0;
  if (n >= 1_000_000) return "₺" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "₺" + (n / 1_000).toFixed(1) + "K";
  return "₺" + nf2.format(n);
}
export function moneyFull(n) { return "₺" + nf.format(Math.round(n || 0)); }

export function seconds(ms) { return (ms / 1000).toFixed(2) + " s"; }

export function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Count-up animation on a DOM element's text. Driven by setInterval so it keeps
 * running (and always lands on the exact target) even in a backgrounded tab,
 * where requestAnimationFrame is paused.
 * @param {HTMLElement} el
 * @param {number} to target value
 * @param {(v:number)=>string} fmt formatter
 * @param {object} opts { duration, from }
 */
export function countUp(el, to, fmt, opts = {}) {
  if (!el) return;
  const from = opts.from ?? 0;
  const duration = prefersReducedMotion() ? 0 : (opts.duration ?? 700);
  if (el._countTimer) { clearInterval(el._countTimer); el._countTimer = null; }
  if (duration <= 0 || from === to) { el.textContent = fmt(to); return; }
  const start = performance.now();
  el._countTimer = setInterval(() => {
    const t = Math.min(1, (performance.now() - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    el.textContent = fmt(from + (to - from) * eased);
    if (t >= 1) { clearInterval(el._countTimer); el._countTimer = null; el.textContent = fmt(to); }
  }, 16);
}
