// charts.js — dependency-free SVG chart builders with fixed viewBoxes
// (so canvas/SVG areas never resize and the layout never jumps).

import { prefersReducedMotion } from "./format.js";
import { QuentraI18n } from "/shared/quentra-i18n.js";

const SVGNS = "http://www.w3.org/2000/svg";
const PALETTE = ["#6d3bd1", "#12b5b0", "#8b5cf6", "#17a673", "#f0a91d"];

function t(key, fallback) { return QuentraI18n.t(key, fallback); }

function el(name, attrs = {}) {
  const n = document.createElementNS(SVGNS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function svgRoot(w, h) {
  const s = el("svg", { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "xMidYMid meet" });
  s.setAttribute("width", "100%");
  return s;
}
function clear(container) { while (container.firstChild) container.removeChild(container.firstChild); }

/** Vertical bar chart. points: [{label, <valueKey>}]. */
export function barChart(container, points, valueKey, opts = {}) {
  clear(container);
  const W = 520, H = 190, padL = 6, padR = 6, padB = 22, padT = 12;
  const svg = svgRoot(W, H);
  const max = Math.max(1, ...points.map(p => p[valueKey]));
  const n = points.length;
  const slot = (W - padL - padR) / n;
  const bw = Math.min(30, slot * 0.62);
  const reduce = prefersReducedMotion();

  points.forEach((p, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const full = (H - padB - padT) * (p[valueKey] / max);
    const y = H - padB - full;
    const rect = el("rect", {
      x, y: reduce ? y : (H - padB), width: bw, height: reduce ? full : 0,
      rx: 3, fill: opts.color || PALETTE[0], opacity: 0.9,
    });
    svg.appendChild(rect);
    if (!reduce) {
      requestAnimationFrame(() => {
        rect.style.transition = `y .6s ease ${i * 30}ms, height .6s ease ${i * 30}ms`;
        rect.setAttribute("y", y);
        rect.setAttribute("height", full);
      });
    }
    const t = el("text", { x: x + bw / 2, y: H - padB + 14, "text-anchor": "middle",
      "font-size": 9, fill: "#7b85a6", "font-family": "IBM Plex Mono, monospace" });
    t.textContent = p.label;
    svg.appendChild(t);

    // tooltip
    const hit = el("rect", { x: padL + i * slot, y: padT, width: slot, height: H - padB - padT, fill: "transparent" });
    hit.appendChild(titleNode(`${p.label} · ${opts.tip ? opts.tip(p) : p[valueKey]}`));
    hit.style.cursor = "default";
    svg.appendChild(hit);
  });
  container.appendChild(svg);
}

/** Line chart. points: [{label, <valueKey>}]. */
export function lineChart(container, points, valueKey, opts = {}) {
  clear(container);
  const W = 520, H = 180, padL = 8, padR = 8, padB = 22, padT = 12;
  const svg = svgRoot(W, H);
  const max = Math.max(1, ...points.map(p => p[valueKey]));
  const min = Math.min(...points.map(p => p[valueKey]));
  const n = points.length;
  const stepX = (W - padL - padR) / (n - 1);
  const yFor = v => H - padB - (H - padB - padT) * ((v - min) / Math.max(1, max - min));
  const color = opts.color || PALETTE[1];

  const coords = points.map((p, i) => [padL + i * stepX, yFor(p[valueKey])]);
  const dLine = coords.map((c, i) => (i ? "L" : "M") + c[0] + " " + c[1]).join(" ");
  const dArea = dLine + ` L ${coords[n - 1][0]} ${H - padB} L ${coords[0][0]} ${H - padB} Z`;

  const grad = el("linearGradient", { id: "lg" + Math.random().toString(36).slice(2), x1: 0, y1: 0, x2: 0, y2: 1 });
  const gid = grad.getAttribute("id");
  grad.appendChild(el("stop", { offset: "0%", "stop-color": color, "stop-opacity": .22 }));
  grad.appendChild(el("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0 }));
  svg.appendChild(grad);
  svg.appendChild(el("path", { d: dArea, fill: `url(#${gid})` }));

  const path = el("path", { d: dLine, fill: "none", stroke: color, "stroke-width": 2.4,
    "stroke-linjoin": "round", "stroke-linecap": "round" });
  svg.appendChild(path);
  if (!prefersReducedMotion()) {
    const len = path.getTotalLength();
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = len;
    requestAnimationFrame(() => {
      path.style.transition = "stroke-dashoffset .9s ease";
      path.style.strokeDashoffset = 0;
    });
  }
  coords.forEach((c, i) => {
    svg.appendChild(el("circle", { cx: c[0], cy: c[1], r: 2.6, fill: "#fff", stroke: color, "stroke-width": 1.6 }));
    const t = el("text", { x: c[0], y: H - padB + 14, "text-anchor": "middle", "font-size": 9,
      fill: "#7b85a6", "font-family": "IBM Plex Mono, monospace" });
    t.textContent = points[i].label;
    svg.appendChild(t);
  });
  container.appendChild(svg);
}

/** Donut chart with external legend. slices: [{category, sales}]. */
export function donutChart(container, slices, opts = {}) {
  clear(container);
  const wrap = document.createElement("div");
  wrap.className = "donut-wrap";
  const size = 140, r = 56, cx = size / 2, cy = size / 2, sw = 22;
  const svg = svgRoot(size, size);
  svg.style.width = size + "px";
  svg.style.flex = "none";
  const total = slices.reduce((s, x) => s + x.sales, 0) || 1;
  const C = 2 * Math.PI * r;
  let acc = 0;
  const reduce = prefersReducedMotion();

  slices.forEach((s, i) => {
    const frac = s.sales / total;
    const seg = el("circle", {
      cx, cy, r, fill: "none",
      stroke: PALETTE[i % PALETTE.length], "stroke-width": sw,
      "stroke-dasharray": `${frac * C} ${C}`,
      "stroke-dashoffset": -acc * C,
      transform: `rotate(-90 ${cx} ${cy})`,
    });
    seg.appendChild(titleNode(`${s.category} · ${(frac * 100).toFixed(1)}%`));
    if (!reduce) {
      seg.style.opacity = 0;
      requestAnimationFrame(() => { seg.style.transition = `opacity .4s ease ${i * 80}ms`; seg.style.opacity = 1; });
    }
    svg.appendChild(seg);
    acc += frac;
  });
  const label = el("text", { x: cx, y: cy - 2, "text-anchor": "middle", "font-size": 11,
    fill: "#7b85a6", "font-family": "Space Grotesk, sans-serif" });
  label.textContent = t("chart.category", "Category");
  const label2 = el("text", { x: cx, y: cy + 12, "text-anchor": "middle", "font-size": 13,
    fill: "#17204a", "font-weight": 700, "font-family": "Space Grotesk, sans-serif" });
  label2.textContent = t("chart.groups", "{n} groups").replace("{n}", slices.length);
  svg.appendChild(label); svg.appendChild(label2);
  wrap.appendChild(svg);

  const legend = document.createElement("div");
  legend.className = "donut-legend";
  slices.forEach((s, i) => {
    const frac = (s.sales / total * 100).toFixed(1);
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML =
      `<span class="legend-swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>` +
      `<span>${s.category}</span><span class="legend-val">${frac}%</span>`;
    legend.appendChild(item);
  });
  wrap.appendChild(legend);
  container.appendChild(wrap);
}

/** Horizontal bars for gender or products. items: [{label, value}]. */
export function hbarChart(container, items, opts = {}) {
  clear(container);
  const W = 520, rowH = 30, padL = 4, padR = 60;
  const H = items.length * rowH + 6;
  const svg = svgRoot(W, H);
  const max = Math.max(1, ...items.map(i => i.value));
  const reduce = prefersReducedMotion();
  items.forEach((it, i) => {
    const y = i * rowH + 4;
    svg.appendChild(textNode(padL, y + 11, it.label, { size: 11, fill: "#46507a", weight: 500 }));
    const bx = padL, by = y + 15, bw = (W - padL - padR) * (it.value / max), bh = 9;
    svg.appendChild(el("rect", { x: bx, y: by, width: W - padL - padR, height: bh, rx: 4, fill: "#f0f2f8" }));
    const bar = el("rect", { x: bx, y: by, width: reduce ? bw : 0, height: bh, rx: 4,
      fill: opts.colors ? opts.colors[i % opts.colors.length] : PALETTE[i % PALETTE.length] });
    svg.appendChild(bar);
    if (!reduce) requestAnimationFrame(() => { bar.style.transition = `width .6s ease ${i * 40}ms`; bar.setAttribute("width", bw); });
    svg.appendChild(textNode(W - padR + 6, y + 15, opts.fmt ? opts.fmt(it.value) : it.value,
      { size: 11, fill: "#17204a", mono: true }));
  });
  container.appendChild(svg);
}

function textNode(x, y, str, o = {}) {
  const t = el("text", { x, y, "font-size": o.size || 11,
    fill: o.fill || "#17204a", "text-anchor": o.anchor || "start",
    "font-family": o.mono ? "IBM Plex Mono, monospace" : "Space Grotesk, sans-serif" });
  if (o.weight) t.setAttribute("font-weight", o.weight);
  t.textContent = str;
  return t;
}
function titleNode(str) { const t = el("title"); t.textContent = str; return t; }
