// scene.js — the topology strip. Every packet is driven by a REAL stage of the
// turn: the retrieval query leaving, the rows coming back, and the follow-up
// action the model produced. Nothing animates on a timer for decoration.

const SVGNS = "http://www.w3.org/2000/svg";

const ASK_MS = 480;
const OUT_MS = 780;
const BACK_MS = 900;
const ACT_MS = 700;

const GATE_X = 700;

// The UI must never wait forever on a frame callback: a hidden tab, reduced
// motion or a throttled rAF would otherwise strand the results panel.
function guard(p, ms) {
  return Promise.race([p, new Promise((r) => setTimeout(r, ms + 600))]);
}

export class Scene {
  constructor(svg, translate) {
    this.svg = svg;
    this.t = translate || ((key) => key);
    this.layer = svg.querySelector("#packetLayer");
    this.burstLayer = svg.querySelector("#burstLayer");
    this.atlas = svg.querySelector("#nodeAtlas");
    this.pathAsk = svg.querySelector("#pathAsk");
    this.pathMain = svg.querySelector("#pathMain");
    this.lenAsk = this.pathAsk.getTotalLength();
    this.lenMain = this.pathMain.getTotalLength();
    this.gateT = this._findGateT();
    this.setRoute(null);
  }

  setRoute(route) { this.svg.dataset.route = route || "idle"; }

  setHijacked(on) { this.atlas.classList.toggle("is-hijacked", !!on); }

  setSafe(on) { this.atlas.classList.toggle("is-safe", !!on); }

  // Employee -> assistant. The question itself, before any SQL exists.
  ask() {
    const pk = this._packet("tplQuery");
    return guard(new Promise((resolve) => {
      this._run(pk, this.pathAsk, this.lenAsk, 0, 1, ASK_MS, () => { pk.remove(); resolve(); });
    }), ASK_MS);
  }

  // Stage 1: the legitimate retrieval query travelling to SQL Server.
  sendQuery(route) {
    this.setRoute(route);
    const pk = this._packet("tplQuery");
    return guard(new Promise((resolve) => {
      this._run(pk, this.pathMain, this.lenMain, 0, 1, OUT_MS, () => {
        pk.remove();
        this._dbBlip();
        resolve();
      });
    }), OUT_MS);
  }

  // Stage 2: the rows coming back. `poisoned` says the payload really was in
  // the data; `cleaned` says the transform really was applied — both come from
  // the measured turn, so the shield never mimes a save that did not happen.
  returnRows({ poisoned = false, cleaned = false, count = 0, onClean = null } = {}) {
    const pk = this._packet("tplRows");
    const countLabel = pk.querySelector(".pk-text");
    if (countLabel) countLabel.textContent = this.t("scene.packet.count").replace("{n}", String(count));
    if (poisoned) pk.classList.add("poisoned");
    let fired = false;
    return guard(new Promise((resolve) => {
      this._run(pk, this.pathMain, this.lenMain, 1, 0, BACK_MS,
        () => { pk.remove(); resolve(); },
        (t) => {
          // The transform lands as the packet crosses the gateway, not before.
          if (!fired && cleaned && t <= this.gateT) {
            fired = true;
            pk.classList.remove("poisoned");
            pk.classList.add("cleaned");
            const alert = pk.querySelector(".pk-alert");
            if (alert) alert.textContent = this.t("scene.packet.quarantine");
            if (onClean) onClean();
            this.burst();
          }
        });
    }), BACK_MS);
  }

  // Stage 4: the hijacked assistant's follow-up statement hitting the gate.
  // When blocked the packet stops at the shield and dissolves there.
  sendAction({ blocked = false, hostile = false, onGate = null } = {}) {
    const pk = this._packet("tplAction");
    pk.classList.toggle("hostile", hostile);
    const label = pk.querySelector(".pk-text");
    if (label) label.textContent = this.t(hostile ? "scene.packet.action" : "scene.packet.followup");
    const stopAt = blocked ? this.gateT : 1;
    let crossedGate = false;
    return guard(new Promise((resolve) => {
      this._run(pk, this.pathMain, this.lenMain, 0, stopAt, ACT_MS, () => {
        if (blocked) {
          pk.classList.add("blocked");
          this.burst();
          setTimeout(() => { pk.remove(); resolve(); }, 380);
          return;
        }
        pk.remove();
        this._dbBlip();
        resolve();
      }, (t) => {
        if (!crossedGate && t >= this.gateT) {
          crossedGate = true;
          if (onGate) onGate();
        }
      });
    }), ACT_MS + (blocked ? 400 : 0));
  }

  burst() {
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8;
      const cx = GATE_X + Math.cos(a) * 24;
      const cy = 82 + Math.sin(a) * 24;
      const c = document.createElementNS(SVGNS, "circle");
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

  // ------------------------------------------------------------ internals ---

  // Where along the main path the shield sits, so a blocked packet stops on the
  // shield rather than at a hard-coded guess.
  _findGateT() {
    let best = 0.5;
    let bestDx = Infinity;
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      const dx = Math.abs(this.pathMain.getPointAtLength(t * this.lenMain).x - GATE_X);
      if (dx < bestDx) { bestDx = dx; best = t; }
    }
    return best;
  }

  _packet(tplId) {
    const tpl = this.svg.querySelector("#" + tplId);
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "packet");
    for (const child of tpl.children) g.appendChild(child.cloneNode(true));
    this.layer.appendChild(g);
    return g;
  }

  _run(node, path, len, from, to, ms, done, onStep) {
    const t0 = performance.now();
    const step = (now) => {
      if (!node.isConnected) { if (done) done(); return; }
      const p = Math.min(1, (now - t0) / ms);
      const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const t = from + (to - from) * ease;
      const pt = path.getPointAtLength(t * len);
      node.setAttribute("transform", `translate(${pt.x},${pt.y})`);
      if (onStep) onStep(t);
      if (p < 1) requestAnimationFrame(step);
      else if (done) done();
    };
    requestAnimationFrame(step);
  }

  _dbBlip() {
    const db = this.svg.querySelector("#dbCylinder");
    if (!db) return;
    db.style.filter = "drop-shadow(0 0 10px rgba(109,94,252,.75))";
    setTimeout(() => { db.style.filter = ""; }, 300);
  }
}
