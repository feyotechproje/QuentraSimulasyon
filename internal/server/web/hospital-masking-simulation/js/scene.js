// scene.js — the slim network-topology strip above the SQL window. Packets are
// driven by the REAL request/response: sendQuery() when the statement leaves,
// returnResult() when its rows actually come back.

const SVGNS = "http://www.w3.org/2000/svg";

const OUT_MS = 850;   // laptop -> DB
const BACK_MS = 950;  // DB -> laptop

const SHIELD = { x: 600, y: 62 };

// Results must appear even if the animation cannot run (hidden tab, reduced
// motion, throttled rAF): never let the UI wait on a frame callback forever.
function guard(p, ms) {
  return Promise.race([p, new Promise((r) => setTimeout(r, ms + 600))]);
}

export class Scene {
  constructor(svg) {
    this.svg = svg;
    this.layer = svg.querySelector("#packetLayer");
    this.burstLayer = svg.querySelector("#burstLayer");
    this.paths = {
      quentra: svg.querySelector("#pathQn"),
      direct: svg.querySelector("#pathDirect"),
    };
    this.lens = {
      quentra: this.paths.quentra.getTotalLength(),
      direct: this.paths.direct.getTotalLength(),
    };
    this.setRoute(null);
  }

  // Highlights the route currently in use (null = idle, both dim).
  setRoute(route) { this.svg.dataset.route = route || "idle"; }

  // The statement leaving the editor. Returns a promise that settles when the
  // packet reaches the database, so the caller can sequence its UI.
  sendQuery(route) {
    this.setRoute(route);
    const path = this.paths[route] || this.paths.direct;
    const len = route === "quentra" ? this.lens.quentra : this.lens.direct;
    const pk = this._makePacket("tplSql");
    return guard(new Promise((resolve) => {
      this._animate(pk, path, len, 0, 1, OUT_MS, () => {
        pk.remove();
        this._dbBlip();
        resolve();
      });
    }), OUT_MS);
  }

  // The rows coming back. masked=true only when the two routes really returned
  // different data; the caller passes the measured comparison, so the shield
  // never fakes a mask.
  returnResult(route, { masked = false } = {}) {
    const path = this.paths[route] || this.paths.direct;
    const len = route === "quentra" ? this.lens.quentra : this.lens.direct;
    const pk = this._makePacket("tplData");
    let fired = false;
    return guard(new Promise((resolve) => {
      this._animate(pk, path, len, 1, 0, BACK_MS, () => { pk.remove(); resolve(); }, (pt, t) => {
        if (!fired && route === "quentra" && masked && t <= 0.55) {
          fired = true;
          pk.classList.add("masked");
          this.burst();
        }
      });
    }), BACK_MS);
  }

  _makePacket(tplId) {
    const tpl = this.svg.querySelector("#" + tplId);
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "packet");
    for (const child of tpl.children) g.appendChild(child.cloneNode(true));
    this.layer.appendChild(g);
    return g;
  }

  _animate(node, path, len, from, to, ms, done, onStep) {
    const t0 = performance.now();
    const step = (now) => {
      if (!node.isConnected) { if (done) done(); return; }
      const p = Math.min(1, (now - t0) / ms);
      const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const t = from + (to - from) * ease;
      const pt = path.getPointAtLength(t * len);
      node.setAttribute("transform", `translate(${pt.x},${pt.y})`);
      if (onStep) onStep(pt, t);
      if (p < 1) requestAnimationFrame(step);
      else if (done) done();
    };
    requestAnimationFrame(step);
  }

  burst() {
    for (let i = 0; i < 7; i++) {
      const c = document.createElementNS(SVGNS, "circle");
      const a = (Math.PI * 2 * i) / 7;
      const cx = SHIELD.x + Math.cos(a) * 22;
      const cy = SHIELD.y + Math.sin(a) * 22;
      c.setAttribute("cx", cx);
      c.setAttribute("cy", cy);
      c.setAttribute("r", 4);
      c.setAttribute("class", "burst");
      c.style.transformOrigin = `${cx}px ${cy}px`;
      this.burstLayer.appendChild(c);
      requestAnimationFrame(() => c.classList.add("on"));
      setTimeout(() => c.remove(), 800);
    }
  }

  _dbBlip() {
    const db = this.svg.querySelector("#dbCylinder");
    if (!db) return;
    db.style.filter = "drop-shadow(0 0 10px rgba(56,189,248,.8))";
    setTimeout(() => { db.style.filter = ""; }, 300);
  }
}
