// scene.js — the cinematic SVG stage: query/result packets travelling between
// the vendor's monitor and the hospital DB, the Quentra shield masking the
// returning data in flight, and a lightweight viewBox "camera".

const SVGNS = "http://www.w3.org/2000/svg";

const OUT_MS = 1000;   // monitor -> DB
const DB_PAUSE = 260;  // "executing" at the DB
const BACK_MS = 1250;  // DB -> monitor

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
    this.role = "quentra";
    this.masked = true;
    this._loopTimer = null;
    this._camAnim = null;
  }

  setRole(role) {
    this.role = role;
    this.svg.dataset.role = role;
  }

  // masked: whether the CURRENT data (demo or live) is actually masked; the
  // shield only "fires" when true, so the scene never claims a mask that the
  // gateway did not apply.
  setMasked(masked) {
    this.masked = !!masked;
    this.svg.classList.toggle("is-masked", this.masked);
  }

  // ---- packet round trip ----

  spawnLookup() {
    const routeName = this.role === "quentra" ? "quentra" : "direct";
    const path = this.paths[routeName];
    const len = this.lens[routeName];
    const role = this.role;
    const masked = this.masked;

    const sql = this._makePacket("tplSql");
    this._animate(sql, path, len, 0, 1, OUT_MS, () => {
      sql.remove();
      this._dbBlip();
      setTimeout(() => {
        const data = this._makePacket("tplData");
        if (role === "dba") data.classList.add("dba");
        let fired = false;
        this._animate(data, path, len, 1, 0, BACK_MS, () => data.remove(), (pt, t) => {
          // Returning data crosses the shield at mid-path on the quentra route:
          // that is where the mask is applied — but only when it truly is.
          if (!fired && role === "quentra" && masked && t <= 0.55) {
            fired = true;
            data.classList.add("masked");
            this.burst();
          }
        });
      }, DB_PAUSE);
    });
  }

  startLoop(intervalMs = 2800) {
    this.stopLoop();
    const tick = () => {
      if (!document.hidden) this.spawnLookup();
      this._loopTimer = setTimeout(tick, intervalMs);
    };
    tick();
  }

  stopLoop() {
    if (this._loopTimer) { clearTimeout(this._loopTimer); this._loopTimer = null; }
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
      if (!node.isConnected) return;
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

  // ---- effects ----

  burst() {
    for (let i = 0; i < 7; i++) {
      const c = document.createElementNS(SVGNS, "circle");
      const a = (Math.PI * 2 * i) / 7;
      c.setAttribute("cx", 600 + Math.cos(a) * 30);
      c.setAttribute("cy", 236 + Math.sin(a) * 30);
      c.setAttribute("r", 5);
      c.setAttribute("class", "burst");
      c.style.transformOrigin = `${600 + Math.cos(a) * 30}px ${236 + Math.sin(a) * 30}px`;
      this.burstLayer.appendChild(c);
      requestAnimationFrame(() => c.classList.add("on"));
      setTimeout(() => c.remove(), 800);
    }
  }

  _dbBlip() {
    const db = this.svg.querySelector("#dbCylinder");
    if (!db) return;
    db.style.filter = "drop-shadow(0 0 12px rgba(56,189,248,.8))";
    setTimeout(() => { db.style.filter = ""; }, 320);
  }

  // ---- camera (animated viewBox) ----

  camera(box, ms = 1400) {
    if (this._camAnim) cancelAnimationFrame(this._camAnim);
    const cur = this.svg.getAttribute("viewBox").split(/\s+/).map(Number);
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const v = cur.map((c, i) => c + (box[i] - c) * e);
      this.svg.setAttribute("viewBox", v.join(" "));
      if (p < 1) this._camAnim = requestAnimationFrame(step);
    };
    this._camAnim = requestAnimationFrame(step);
  }
}

export const CAMERA = {
  FULL: [0, 0, 1200, 560],
  INTRO: [30, 120, 760, 420],
  SHIELD: [340, 90, 520, 330],
  WIDE: [60, 40, 1080, 520],
};
