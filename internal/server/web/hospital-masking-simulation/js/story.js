// story.js — the "video": a scripted, auto-playing screen recording of a real
// support session. Each scene drives the SQL client window with keyframes
// (one-shot actions at a time offset) and spans (progressive actions like
// typing or row-by-row grid fills), so seeking to any point fast-forwards the
// window into the correct state.

import { PATIENT_SQL } from "./data.js";

// Scene factory: ctx = { win, strip, rows(), t }
//   rows() -> { open:[], masked:[], maskedFields:[], masked:boolean, demo:boolean }
function makeScenes(ctx) {
  const { win, strip, t } = ctx;
  const rows = () => ctx.rows();
  const metaMs = (r) => (r.demo ? "" : r.ms || "");

  return [
    {
      key: "connect", dur: 8000, role: "baseline", caps: ["cap.connect"],
      keys: [
        { at: 0, run: () => { win.reset(); ctx.msg(false); win.setIdentity("destek", "direct"); } },
        { at: 600, run: () => win.setStatus(t("sw.stConnecting"), { tone: "run" }) },
        { at: 3400, run: () => win.setStatus(t("sw.stConnected"), { tone: "idle", rows: 0 }) },
      ],
      spans: [
        { from: 700, to: 3200, render: (p) => win.treeReveal(p) },
      ],
    },
    {
      key: "type", dur: 7500, role: "baseline", caps: ["cap.type"],
      keys: [
        { at: 0, run: () => { win.treeReveal(1); win.clearResults(); win.showCaret(true); } },
        { at: 5000, run: () => win.showCaret(false) },
        { at: 5400, run: () => { win.pressExecute({ cursor: true }); win.setStatus(t("sw.stExecuting"), { tone: "run" }); } },
        { at: 6000, run: () => strip.spawnRoute("direct") },
      ],
      spans: [
        { from: 300, to: 4900, render: (p) => win.typeQuery(p, PATIENT_SQL) },
      ],
    },
    {
      key: "open", dur: 11000, role: "baseline", caps: ["cap.open"],
      keys: [
        { at: 0, run: () => { win.treeReveal(1); win.setQuery(PATIENT_SQL); win.setIdentity("destek", "direct"); } },
        { at: 200, run: () => strip.spawnRoute("direct") },
        { at: 2400, run: () => {
          const r = rows();
          win.setStatus(t("sw.stDoneOpen"), { tone: "open", rows: r.open.length });
        } },
      ],
      spans: [
        { from: 2400, to: 4600, render: (p) => {
          const r = rows();
          win.fillGrid("direct", r.open, { tone: "open", revealP: p, meta: metaMs(r) });
        } },
      ],
    },
    {
      key: "quentra", dur: 13000, role: "quentra", caps: ["cap.quentra"],
      keys: [
        { at: 0, run: () => {
          const r = rows();
          win.treeReveal(1); win.setQuery(PATIENT_SQL);
          win.fillGrid("direct", r.open, { tone: "open", revealP: 1 });
          win.setIdentity("destek", "quentra");
          win.flashQueryUnchanged();
          win.setStatus(t("sw.stExecuting"), { tone: "run" });
        } },
        { at: 700, run: () => strip.spawnRoute("quentra", { masked: rows().masked }) },
        { at: 3200, run: () => {
          const r = rows();
          win.setStatus(r.masked ? t("sw.stDoneMasked") : t("sw.stDoneNoRule"),
            { tone: r.masked ? "masked" : "warn", rows: r.maskedRows.length });
        } },
      ],
      spans: [
        { from: 3200, to: 5400, render: (p) => {
          const r = rows();
          win.fillGrid("quentra", r.maskedRows, {
            tone: r.masked ? "masked" : "plain",
            maskedFields: r.maskedFields, revealP: p, meta: metaMs(r),
          });
        } },
      ],
    },
    {
      key: "dba", dur: 11000, role: "dba", caps: ["cap.dba"],
      keys: [
        { at: 0, run: () => {
          const r = rows();
          win.treeReveal(1); win.setQuery(PATIENT_SQL);
          win.fillGrid("quentra", r.maskedRows, { tone: r.masked ? "masked" : "plain", maskedFields: r.maskedFields, revealP: 1 });
          win.setIdentity("dba", "direct");
          win.setStatus(t("sw.stExecuting"), { tone: "run" });
        } },
        { at: 400, run: () => strip.spawnRoute("direct", { dba: true }) },
        { at: 2600, run: () => {
          const r = rows();
          win.fillGrid("direct", r.open, { tone: "dba", revealP: 1 });
          win.highlightSet("direct", "dba");
          win.setStatus(t("sw.stDoneDba"), { tone: "dba", rows: r.open.length });
        } },
      ],
      spans: [],
    },
    {
      key: "message", dur: 10000, role: "quentra", caps: [],
      keys: [
        { at: 0, run: () => { win.dim(true); ctx.msg(true, t("cap.msg1"), ""); } },
        { at: 4200, run: () => ctx.msg(true, t("cap.msg1"), t("cap.msg2")) },
      ],
      spans: [],
      exit: () => { win.dim(false); ctx.msg(false); },
    },
  ];
}

export class Story {
  // opts: { win, strip, t, onRole(role), rows(), msg(show,l1,l2),
  //         els: {btnPlay, icPlay, icPause, btnReplay, track, progress, chips, caption} }
  constructor(opts) {
    this.ctx = { win: opts.win, strip: opts.strip, t: opts.t, rows: opts.rows, msg: opts.msg };
    this.t = opts.t;
    this.onRole = opts.onRole;
    this.els = opts.els;
    this.scenes = makeScenes(this.ctx);
    this.total = this.scenes.reduce((s, sc) => s + sc.dur, 0);
    this.playing = false;
    this.elapsed = 0;
    this.idx = -1;
    this._keyPtr = 0;
    this._capIdx = -1;
    this._raf = null;
    this._last = 0;
    this._wire();
  }

  _wire() {
    this.els.btnPlay.addEventListener("click", () => (this.playing ? this.pause() : this.play()));
    this.els.btnReplay.addEventListener("click", () => this.seekTo(0, true));
    this.els.chips.forEach((chip) =>
      chip.addEventListener("click", () => {
        const i = Number(chip.dataset.scene);
        let off = 0;
        for (let k = 0; k < i; k++) off += this.scenes[k].dur;
        this.seekTo(off, true);
      })
    );
    this.els.track.addEventListener("click", (e) => {
      const r = this.els.track.getBoundingClientRect();
      this.seekTo(((e.clientX - r.left) / r.width) * this.total, true);
    });
    window.addEventListener("quentra:langchange", () => { if (this.idx >= 0) this._showCaption(); });
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this._last = performance.now();
    this._updatePlayIcon();
    this._raf = requestAnimationFrame((n) => this._tick(n));
  }

  pause() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._updatePlayIcon();
  }

  // External interaction (role click / manual Yürüt) pauses the film.
  interrupt() {
    if (this.playing) this.pause();
    const sc = this.scenes[this.idx];
    if (sc && sc.exit) sc.exit();
  }

  // Leaves the current scene properly (runs its exit hook) before the index
  // is reset — otherwise a loop/seek out of the message scene would strand
  // its overlay on screen.
  _exitScene() {
    const sc = this.scenes[this.idx];
    if (sc && sc.exit) sc.exit();
    this.idx = -1;
  }

  seekTo(ms, autoplay) {
    this.elapsed = Math.max(0, Math.min(ms, this.total - 1));
    this._exitScene(); // force scene re-entry (fast-forwards the window state)
    this._applyFrame();
    if (autoplay && !this.playing) this.play();
  }

  _tick(now) {
    if (!this.playing) return;
    this.elapsed += now - this._last;
    this._last = now;
    if (this.elapsed >= this.total) { this.elapsed = 0; this._exitScene(); } // loop
    this._applyFrame();
    this._raf = requestAnimationFrame((n) => this._tick(n));
  }

  _applyFrame() {
    let off = 0, idx = 0;
    for (let i = 0; i < this.scenes.length; i++) {
      if (this.elapsed < off + this.scenes[i].dur) { idx = i; break; }
      off += this.scenes[i].dur;
    }
    const sc = this.scenes[idx];
    if (idx !== this.idx) {
      const prev = this.scenes[this.idx];
      if (prev && prev.exit) prev.exit();
      this.idx = idx;
      this._keyPtr = 0;
      this._capIdx = -1;
      this.onRole(sc.role);
      this.els.chips.forEach((c) => c.classList.toggle("is-active", Number(c.dataset.scene) === idx));
    }
    const local = this.elapsed - off;

    // one-shot keyframes (also fast-forwards after a seek)
    while (this._keyPtr < sc.keys.length && sc.keys[this._keyPtr].at <= local) {
      sc.keys[this._keyPtr].run();
      this._keyPtr++;
    }
    // progressive spans
    for (const sp of sc.spans) {
      if (local >= sp.from) sp.render(Math.min(1, (local - sp.from) / (sp.to - sp.from)));
    }
    // captions
    if (sc.caps.length) {
      const capIdx = Math.min(sc.caps.length - 1, Math.floor((local / sc.dur) * sc.caps.length));
      if (capIdx !== this._capIdx) { this._capIdx = capIdx; this._showCaption(); }
      this.els.caption.parentElement.hidden = false;
    } else {
      this.els.caption.parentElement.hidden = true;
    }
    this.els.progress.style.width = ((this.elapsed / this.total) * 100).toFixed(2) + "%";
  }

  _showCaption() {
    const sc = this.scenes[this.idx < 0 ? 0 : this.idx];
    if (!sc.caps.length) return;
    const el = this.els.caption;
    el.innerHTML = this.t(sc.caps[Math.max(0, this._capIdx)], "");
    el.style.animation = "none";
    void el.offsetWidth;
    el.style.animation = "capin .6s ease-out";
  }

  _updatePlayIcon() {
    this.els.icPlay.hidden = this.playing;
    this.els.icPause.hidden = !this.playing;
  }
}
