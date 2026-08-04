// scene.js — the slim network-topology strip above the SQL window: query and
// result packets travelling between the support engineer's laptop and the
// hospital DB, with the Quentra shield masking returning data in flight.

const SVGNS = "http://www.w3.org/2000/svg";

const OUT_MS = 900;    // laptop -> DB
const DB_PAUSE = 240;  // "executing" at the DB
const BACK_MS = 1150;  // DB -> laptop

const SHIELD = { x: 600, y: 62 };

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
  }

  setRole(role) { this.svg.dataset.role = role; }

  // masked: whether current data is genuinely masked; drives the strip's glow.
  setMasked(masked) { this.svg.classList.toggle("is-masked", !!masked); }

  // One query round trip on the given route. opts: { masked, dba }
  // The mask burst only fires when the data really is masked, so the strip
  // never claims a mask the gateway did not apply.
  spawnRoute(route, opts = {}) {
    const path = this.paths[route] || this.paths.direct;
    const len = route === "quentra" ? this.lens.quentra : this.lens.direct;

    const sql = this._makePacket("tplSql");
    this._animate(sql, path, len, 0, 1, OUT_MS, () => {
      sql.remove();
      this._dbBlip();
      setTimeout(() => {
        const data = this._makePacket("tplData");
        if (opts.dba) data.classList.add("dba");
        let fired = false;
        this._animate(data, path, len, 1, 0, BACK_MS, () => data.remove(), (pt, t) => {
          if (!fired && route === "quentra" && opts.masked && t <= 0.55) {
            fired = true;
            data.classList.add("masked");
            this.burst();
          }
        });
      }, DB_PAUSE);
    });
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
