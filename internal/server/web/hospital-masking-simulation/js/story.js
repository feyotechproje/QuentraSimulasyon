// story.js — the "video": a scripted, auto-playing scenario timeline. Each
// scene sets the connection role, moves the camera and shows a subtitle; the
// player bar gives play/pause, replay, seek and per-scene chips.

import { CAMERA } from "./scene.js";

export const SCENES = [
  { key: "intro",    dur: 7500,  role: "quentra",  cam: CAMERA.INTRO, caps: ["cap.intro"] },
  { key: "baseline", dur: 11500, role: "baseline", cam: CAMERA.FULL,  caps: ["cap.baseline"] },
  { key: "quentra",  dur: 13500, role: "quentra",  cam: CAMERA.FULL,  caps: ["cap.quentra"] },
  { key: "dba",      dur: 11500, role: "dba",      cam: CAMERA.FULL,  caps: ["cap.dba"] },
  { key: "message",  dur: 10000, role: "quentra",  cam: CAMERA.WIDE,  caps: ["cap.msg1", "cap.msg2"] },
];

const TOTAL = SCENES.reduce((s, sc) => s + sc.dur, 0);

export class Story {
  // opts: { scene, t, onRole(role), els: {btnPlay, icPlay, icPause, btnReplay,
  //         track, progress, chips, caption} }
  constructor(opts) {
    this.scene = opts.scene;
    this.t = opts.t; // i18n lookup fn
    this.onRole = opts.onRole;
    this.els = opts.els;
    this.playing = false;
    this.elapsed = 0;
    this.idx = -1;
    this._raf = null;
    this._last = 0;
    this._capIdx = -1;
    this._wire();
  }

  _wire() {
    this.els.btnPlay.addEventListener("click", () => (this.playing ? this.pause() : this.play()));
    this.els.btnReplay.addEventListener("click", () => this.seekTo(0, true));
    this.els.chips.forEach((chip) =>
      chip.addEventListener("click", () => {
        const i = Number(chip.dataset.scene);
        let off = 0;
        for (let k = 0; k < i; k++) off += SCENES[k].dur;
        this.seekTo(off, true);
      })
    );
    this.els.track.addEventListener("click", (e) => {
      const r = this.els.track.getBoundingClientRect();
      this.seekTo(((e.clientX - r.left) / r.width) * TOTAL, true);
    });
    window.addEventListener("quentra:langchange", () => this._showCaption(true));
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

  // External interaction (user picked a role by hand) pauses the film.
  interrupt() { if (this.playing) this.pause(); }

  seekTo(ms, autoplay) {
    this.elapsed = Math.max(0, Math.min(ms, TOTAL - 1));
    this.idx = -1; // force scene re-entry
    this._applyFrame();
    if (autoplay && !this.playing) this.play();
  }

  _tick(now) {
    if (!this.playing) return;
    this.elapsed += now - this._last;
    this._last = now;
    if (this.elapsed >= TOTAL) this.elapsed = 0; // loop like a booth video
    this._applyFrame();
    this._raf = requestAnimationFrame((n) => this._tick(n));
  }

  _applyFrame() {
    let off = 0, idx = 0;
    for (let i = 0; i < SCENES.length; i++) {
      if (this.elapsed < off + SCENES[i].dur) { idx = i; break; }
      off += SCENES[i].dur;
    }
    const sc = SCENES[idx];
    if (idx !== this.idx) {
      this.idx = idx;
      this._capIdx = -1;
      this.scene.camera(sc.cam);
      this.onRole(sc.role);
      this.els.chips.forEach((c) => c.classList.toggle("is-active", Number(c.dataset.scene) === idx));
    }
    // caption sequence within the scene
    const local = this.elapsed - off;
    const capIdx = Math.min(sc.caps.length - 1, Math.floor((local / sc.dur) * sc.caps.length));
    if (capIdx !== this._capIdx) {
      this._capIdx = capIdx;
      this._showCaption();
    }
    this.els.progress.style.width = ((this.elapsed / TOTAL) * 100).toFixed(2) + "%";
  }

  _showCaption(keepIdx) {
    const sc = SCENES[this.idx < 0 ? 0 : this.idx];
    const key = sc.caps[Math.max(0, this._capIdx)];
    const el = this.els.caption;
    el.innerHTML = this.t(key, "");
    // retrigger the fade-in
    el.style.animation = "none";
    void el.offsetWidth;
    el.style.animation = "capin .6s ease-out";
  }

  _updatePlayIcon() {
    this.els.icPlay.hidden = this.playing;
    this.els.icPause.hidden = !this.playing;
  }
}
