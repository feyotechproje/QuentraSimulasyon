// story-tour.js
// Shared cinematic "story mode" for the Quentra simulation pages.
//
// Two pieces, both reusable by every simulation:
//
//   1. Scenario intro — a blurred-backdrop popup shown over the (already
//      running) page that tells the scenario in a few short paragraphs, with
//      a "start the story" and a "skip / free watch" button.
//   2. Guided tour — a sequence of steps. Each step points the "camera" at one
//      element: the page root is smoothly translate+scale'd so the target
//      fills the viewport, a spotlight ring dims everything else, and a
//      caption card narrates what the audience is looking at. Navigation is
//      keyboard-only (no on-screen buttons): →/D next, ←/A back, Space
//      pauses/resumes a narrated story, Esc exits.
//
// Step kinds (mixable in one sequence):
//   { target: "#panel", key, zoom }   — camera shot of a live UI element
//   { img: "img/scene.jpg", key }     — full-screen cinematic still (Ken Burns
//                                       drift, letterboxed over a blurred fill)
// Any step may carry `onEnter(tour)` — fired when the step becomes active, so
// the host can trigger real work (e.g. run the demo query) mid-story.
//
// The engine is i18n-agnostic: the host passes a `translate(step)` function
// (and label strings) and may re-render on the shared "quentra:langchange"
// event, which the tour listens to on its own.
//
// Usage:
//   import { StoryTour } from "/shared/story-tour.js";
//   const tour = new StoryTour({
//     root: ".app",
//     steps: [
//       { target: null,          key: "tour.s1" },            // wide shot
//       { target: "#somePanel",  key: "tour.s2", zoom: 2.2, hold: 12 },
//     ],
//     translate: (step) => ({ title: t(step.key + ".t"), text: t(step.key + ".x") }),
//     onDone: () => { ... },
//   });
//   tour.intro({ ... }).then((go) => { if (go) tour.start(); });

const CAM_MS = 1150;              // camera glide duration (matches CSS)

export class StoryTour {
  constructor(opts) {
    this.rootSel = (opts && opts.root) || ".app";
    this.steps = (opts && opts.steps) || [];
    this.translate = (opts && opts.translate) || ((s) => ({ title: s.title || "", text: s.text || "" }));
    this.labels = (opts && opts.labels) || (() => ({ back: "Back", next: "Next", done: "Done" }));
    this.onDone = (opts && opts.onDone) || (() => {});
    // Fired once per step CHANGE (never on resize re-apply) — hosts hang
    // narration/audio here so each beat's clip starts exactly with its card.
    this.onStep = (opts && opts.onStep) || null;
    // Optional { isPaused(), toggle() }: renders a Duraklat/Devam button in
    // the caption nav so a narrated, self-advancing story can be frozen.
    this.pauseCtl = (opts && opts.pauseControl) || null;
    this.active = false;
    this.index = -1;

    this._cam = { s: 1, tx: 0, ty: 0 };
    this._trackRaf = null;
    this._offLang = null;
    this._reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

    this._onKey = (e) => {
      if (!this.active) return;
      // The page stays clickable mid-tour — never hijack keys while the
      // presenter is typing into a real input on the page.
      const el = e.target;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const k = e.key;
      if (k === "Escape") this.stop();
      else if (k === "ArrowRight" || k === "d" || k === "D") { e.preventDefault(); this.next(); }
      else if (k === "ArrowLeft" || k === "a" || k === "A") { e.preventDefault(); this.prev(); }
      else if (k === " " || e.code === "Space") {
        e.preventDefault();
        if (this.pauseCtl) {
          this.pauseCtl.toggle();
          this._syncCineVideo(); // freeze/resume the ambient clip with the voice
        }
      }
    };
    this._onResize = () => { if (this.active) this._applyStep(); };
  }

  get root() { return document.querySelector(this.rootSel); }

  // ------------------------------------------------------------ intro popup ---
  /**
   * Show the blurred scenario popup. `content` holds already-translated
   * strings: { eyebrow, title, paragraphs: [..], start, skip }.
   * Resolves true when the user starts the story, false when they skip.
   */
  intro(content) {
    return new Promise((resolve) => {
      const wrap = mk("div", "st-intro");
      const card = mk("div", "st-intro-card");
      const c = content || {};

      const render = (cc) => {
        card.innerHTML = "";
        if (cc.eyebrow) card.appendChild(mk("span", "st-eyebrow", esc(cc.eyebrow)));
        card.appendChild(mk("h2", "st-intro-title", esc(cc.title || "")));
        (cc.paragraphs || []).forEach((p) => card.appendChild(mk("p", "st-intro-p", esc(p))));
        const actions = mk("div", "st-intro-actions");
        const bStart = mk("button", "st-btn st-btn-primary", esc(cc.start || "Start"));
        const bSkip = mk("button", "st-btn st-btn-ghost", esc(cc.skip || "Skip"));
        bStart.type = "button"; bSkip.type = "button";
        bStart.addEventListener("click", () => finish(true));
        bSkip.addEventListener("click", () => finish(false));
        actions.appendChild(bStart);
        actions.appendChild(bSkip);
        card.appendChild(actions);
      };

      const onKey = (e) => { if (e.key === "Escape") finish(false); };
      const offLang = subLang(() => { if (typeof content === "function") render(content()); });
      const finish = (go) => {
        document.removeEventListener("keydown", onKey);
        if (offLang) offLang();
        wrap.classList.add("st-hide");
        setTimeout(() => wrap.remove(), 420);
        resolve(go);
      };

      render(typeof content === "function" ? content() : c);
      document.addEventListener("keydown", onKey);
      wrap.appendChild(card);
      document.body.appendChild(wrap);
    });
  }

  // ------------------------------------------------------------------- tour ---
  start() {
    if (this.active || !this.root || !this.steps.length) return;
    this.active = true;
    document.documentElement.classList.add("st-lock");
    this.root.style.willChange = "transform";
    this.root.style.transformOrigin = "0 0";
    this.root.classList.add("st-cam");

    // Four veil panels frame the spotlight hole: box-shadow cannot blur what
    // is behind it, so the blur outside the highlighted area comes from four
    // backdrop-filter strips (top/bottom/left/right of the target).
    this._veils = [0, 1, 2, 3].map(() => {
      const v = mk("div", "st-veil");
      document.body.appendChild(v);
      return v;
    });
    // Spotlight ring: just the glowing border around the sharp area.
    this._spot = mk("div", "st-spot");
    // Caption card: the only interactive piece (pointer-events on), so the
    // presenter can still click the page itself mid-tour. No nav buttons —
    // the story is driven from the keyboard (→/D, ←/A, Space, Esc).
    this._cap = mk("div", "st-cap");
    this._cap.innerHTML =
      '<div class="st-cap-head"><span class="st-step"></span><b class="st-title"></b>' +
      '<button class="st-x" type="button" aria-label="close">✕</button></div>' +
      '<p class="st-text"></p>';
    this._cap.querySelector(".st-x").addEventListener("click", () => this.stop());
    document.body.appendChild(this._spot);
    document.body.appendChild(this._cap);

    document.addEventListener("keydown", this._onKey);
    window.addEventListener("resize", this._onResize);
    this._offLang = subLang(() => {
      if (!this.active) return;
      this._renderCaption();
      this._placeCaption(this._frame);   // translated text changes card height
    });

    this.index = -1;
    this._enteredIndex = -1;
    this.next();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    if (this._trackRaf) cancelAnimationFrame(this._trackRaf);
    document.removeEventListener("keydown", this._onKey);
    window.removeEventListener("resize", this._onResize);
    if (this._offLang) { this._offLang(); this._offLang = null; }
    clearTimeout(this._sharpTimer);
    this._unsharpen();
    this._target = null;
    this._hideCine();
    if (this._cine) { this._cine.remove(); this._cine = null; }
    if (this._veils) { this._veils.forEach((v) => v.remove()); this._veils = null; }
    if (this._spot) { this._spot.remove(); this._spot = null; }
    if (this._cap) { this._cap.remove(); this._cap = null; }
    document.documentElement.classList.remove("st-lock");

    // Glide the camera home, then drop the transform entirely. The settle
    // timer in _setCam fires with scale 1 and restores the canvas renderers.
    this._setCam(1, 0, 0);
    const root = this.root;
    setTimeout(() => {
      if (!this.active && root) {
        root.classList.remove("st-cam");
        root.style.transform = "";
      }
    }, CAM_MS + 60);
    this.onDone();
  }

  next() {
    if (!this.active) return;
    if (this.index >= this.steps.length - 1) { this.stop(); return; }
    this.index += 1;
    this._applyStep();
  }

  prev() {
    if (!this.active || this.index <= 0) return;
    this.index -= 1;
    this._applyStep();
  }

  /** Re-frame the current step — for hosts that reveal a step's target late
   *  (onEnter kicked off real work and the panel only just appeared). */
  refresh() {
    if (this.active) this._applyStep();
  }

  // ------------------------------------------------------------- internals ---
  // Steps only advance on user input (→/D, ←/A) or the host's narration
  // auto-advance — no built-in auto-play.
  _applyStep() {
    const step = this.steps[this.index];
    if (!step) return;
    // Fire on step CHANGE only — a resize re-applies the current step and must
    // not re-trigger host work (or restart the narration).
    if (this._enteredIndex !== this.index) {
      this._enteredIndex = this.index;
      if (typeof step.onEnter === "function") {
        try { step.onEnter(this); } catch (e) { /* story must not die on host errors */ }
      }
      if (this.onStep) {
        try { this.onStep(step, this.index); } catch (e) { /* ditto */ }
      }
    }

    // Cinematic still: no camera, no spotlight — the image IS the shot.
    if (step.img) {
      clearTimeout(this._sharpTimer);
      this._unsharpen();
      this._target = null;
      this._frame = null;
      this._cineActive = true;
      this._setCam(1, 0, 0);
      this._showCine(step);
      this._renderCaption();
      this._placeCaption(null);
      return;
    }
    this._cineActive = false;
    this._hideCine();

    let target = step.target ? document.querySelector(step.target) : null;
    // A hidden target (responsive layout dropped it) degrades to a wide shot.
    if (target) {
      const r = target.getBoundingClientRect();
      if (!r.width || !r.height) target = null;
    }
    clearTimeout(this._sharpTimer);
    this._unsharpen();
    this._target = target;

    // Frame the shot first, then drop the caption card into the largest free
    // area around the target's final on-screen rect (dead centre on wide
    // shots) so the card floats like a popup instead of docking to an edge.
    this._frame = this._camera(target, step.zoom || 2.2);
    this._renderCaption();
    this._placeCaption(this._frame);
    this._trackSpot(target);
  }

  // ------------------------------------------------------------ cine layer ---
  /**
   * Full-screen still: a blurred cover copy fills the screen, the sharp image
   * letterboxes on top with a slow Ken Burns drift (direction alternates per
   * step so consecutive slides don't feel copy-pasted).
   *
   * A step may also carry `video` (mp4 path): the clip fades in OVER the still
   * as soon as it can play — muted, looping, ambient; the narration stays the
   * only soundtrack and keeps driving the auto-advance. A missing or broken
   * file simply leaves the Ken Burns still on screen, so hosts can declare
   * video paths before the files exist.
   */
  _showCine(step) {
    if (!this._cine) {
      this._cine = mk("div", "st-cine");
      this._cine.innerHTML =
        '<img class="st-cine-bg" alt="" aria-hidden="true" />' +
        '<img class="st-cine-img" alt="" />' +
        '<video class="st-cine-video" muted playsinline preload="auto"></video>' +
        '<div class="st-cine-vignette"></div>';
      document.body.appendChild(this._cine);
      const v = this._cine.querySelector(".st-cine-video");
      v.muted = true; // the narration is the soundtrack; video sound is ignored
      v.addEventListener("canplay", () => {
        if (this._cineWant && v.getAttribute("src") === this._cineWant) {
          this._cine.classList.add("st-video-on");
          this._applyCineRate();
          this._syncCineVideo();
        }
      });
      v.addEventListener("error", () => this._cine.classList.remove("st-video-on"));
      // No loop: a clip that finishes before the narration HOLDS its last
      // frame instead of jarringly restarting.
    }
    const bg = this._cine.querySelector(".st-cine-bg");
    const im = this._cine.querySelector(".st-cine-img");
    const vid = this._cine.querySelector(".st-cine-video");
    // Per-slide styling hook (e.g. "st-cine-hero" for transparent character art).
    this._cine.className = "st-cine" + (step.cineClass ? " " + step.cineClass : "");
    bg.src = step.img;
    im.src = step.img;
    // Restart the entrance + drift animations on every slide change.
    im.classList.remove("st-kb-a", "st-kb-b");
    void this._cine.offsetWidth;
    im.classList.add(this.index % 2 ? "st-kb-b" : "st-kb-a");
    this._cine.classList.add("st-cine-in");
    this._cine.style.display = "block";

    // Ambient video layer for this slide (if declared).
    this._cineWant = step.video || null;
    this._cineTargetDur = null; // narration duration arrives async (host call)
    vid.pause();
    vid.playbackRate = 1;
    if (this._cineWant) {
      if (vid.getAttribute("src") !== this._cineWant) {
        vid.setAttribute("src", this._cineWant);
        vid.load(); // canplay listener fades it in
      } else {
        // Same slide revisited: canplay will not re-fire, resume directly.
        vid.currentTime = 0;
        if (vid.readyState >= 3) { this._cine.classList.add("st-video-on"); this._syncCineVideo(); }
      }
    } else {
      vid.removeAttribute("src");
      vid.load();
    }

    // The frost veils and the spotlight ring belong to camera shots only.
    if (this._veils) this._veils.forEach((v) => { v.style.display = "none"; });
    if (this._spot) this._spot.style.display = "none";
  }

  /**
   * Point the camera at a SUB-target of the current step without changing the
   * step itself — choreography inside one beat (e.g. sweeping over the cells
   * of a result row while the narration lists them). Keeps the caption text,
   * moves the shot + spotlight; selector null returns to a wide shot.
   */
  focus(selector, zoom) {
    if (!this.active) return;
    let el = selector ? document.querySelector(selector) : null;
    if (el) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) el = null;
    }
    clearTimeout(this._sharpTimer);
    this._unsharpen();
    this._target = el;
    this._frame = this._camera(el, zoom || 2.2);
    this._placeCaption(this._frame);
    this._trackSpot(el);
  }

  /**
   * Stretch the ambient clip over the narration: the host reports how long
   * the voice clip runs (seconds), and the video slows down (never below
   * half speed, never sped up) so it finishes WITH the voice instead of
   * looping mid-sentence. Slow motion reads as intentional cinema; whatever
   * still ends early simply holds its last frame.
   */
  cineMatchDuration(sec) {
    this._cineTargetDur = sec > 0 && isFinite(sec) ? sec : null;
    this._applyCineRate();
  }

  _applyCineRate() {
    const v = this._cine && this._cine.querySelector(".st-cine-video");
    if (!v || !this._cineActive) return;
    let rate = 1;
    if (this._cineTargetDur && v.duration && isFinite(v.duration)) {
      rate = Math.min(1, Math.max(0.5, v.duration / this._cineTargetDur));
    }
    v.playbackRate = rate;
  }

  // Play/pause the ambient clip in lockstep with the story's pause state.
  _syncCineVideo() {
    const v = this._cine && this._cine.querySelector(".st-cine-video");
    if (!v || !this._cineActive || !this._cine.classList.contains("st-video-on")) return;
    if (this.pauseCtl && this.pauseCtl.isPaused()) v.pause();
    else v.play().catch(() => {});
  }

  _hideCine() {
    if (this._cine) {
      this._cine.style.display = "none";
      const v = this._cine.querySelector(".st-cine-video");
      if (v) v.pause();
    }
  }

  _renderCaption() {
    if (!this._cap) return;
    const step = this.steps[this.index];
    const { title, text } = this.translate(step) || {};
    this._cap.querySelector(".st-step").textContent = `${this.index + 1}/${this.steps.length}`;
    this._cap.querySelector(".st-title").textContent = title || "";
    this._cap.querySelector(".st-text").textContent = text || "";
    // Replay the caption entrance.
    this._cap.classList.remove("st-in");
    void this._cap.offsetWidth;
    this._cap.classList.add("st-in");
  }

  /**
   * Point the camera. The root carries `translate(tx,ty) scale(s)` with origin
   * 0 0; we invert the current transform to recover natural (untransformed)
   * geometry, then solve for the transform that centers the target in the
   * viewport. Returns the target's FINAL on-screen rect (where it will sit
   * once the glide settles) so the caption can be placed around it, or null
   * for wide shots.
   */
  _camera(targetEl, zoomMax) {
    const root = this.root;
    if (!root) return null;
    if (!targetEl) { this._setCam(1, 0, 0); return null; }
    if (this._reduced) {
      // No camera motion: the target stays where it is, so its live rect IS
      // the final frame for caption placement.
      this._setCam(1, 0, 0);
      const r = targetEl.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }

    const vw = window.innerWidth, vh = window.innerHeight;
    // Read the LIVE transform (mid-glide it is the interpolated value, which is
    // what the rects below reflect) — this._cam only holds the glide's end
    // state, so inverting with it would misplace the camera on a quick Next.
    const cur = liveTransform(root);
    const r0 = root.getBoundingClientRect();
    const rootNat = {
      left: r0.left - cur.tx, top: r0.top - cur.ty,
      w: r0.width / cur.s, h: r0.height / cur.s,
    };
    const tr = targetEl.getBoundingClientRect();
    const nat = {
      x: (tr.left - r0.left) / cur.s, y: (tr.top - r0.top) / cur.s,
      w: tr.width / cur.s, h: tr.height / cur.s,
    };
    if (!nat.w || !nat.h) { this._setCam(1, 0, 0); return null; }

    // Leave breathing room around the shot so the caption has a free region.
    const availW = vw * 0.82, availH = vh * 0.82;
    let s = Math.min(zoomMax || 2.2, availW / nat.w, availH / nat.h);
    s = Math.max(1, s);

    const cx = nat.x + nat.w / 2, cy = nat.y + nat.h / 2;
    let tx = vw / 2 - rootNat.left - s * cx;
    let ty = vh / 2 - rootNat.top - s * cy;

    // Never pull a scaled-up root's edge inside the viewport (no void showing).
    const rw = rootNat.w * s, rh = rootNat.h * s;
    tx = rw >= vw ? clamp(tx, vw - (rootNat.left + rw), -rootNat.left) : 0;
    ty = rh >= vh ? clamp(ty, vh - (rootNat.top + rh), -rootNat.top) : 0;
    this._setCam(s, tx, ty);

    const left = rootNat.left + tx + s * nat.x;
    const top = rootNat.top + ty + s * nat.y;
    return { left, top, right: left + s * nat.w, bottom: top + s * nat.h };
  }

  /**
   * Float the caption card in the largest free viewport region around the
   * target's final rect — beside it when a side is roomy (the card narrows to
   * fit), otherwise centered in the space above/below. Wide shots get the
   * card dead centre. Never docked to a screen edge.
   */
  _placeCaption(rect) {
    const cap = this._cap;
    if (!cap) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const M = 28;                       // margin to the viewport edges
    cap.style.width = "";               // back to the CSS default before measuring
    let w = cap.offsetWidth, h = cap.offsetHeight;
    let x, y;

    if (rect) {
      const pad = 22;                   // clearance from the spotlight ring
      const regions = [
        { side: "left",   x0: rect.right + pad, x1: vw, y0: 0, y1: vh },   // card right of target → tail on its left
        { side: "right",  x0: 0, x1: rect.left - pad, y0: 0, y1: vh },     // card left of target → tail right
        { side: "top",    x0: 0, x1: vw, y0: rect.bottom + pad, y1: vh },  // card below → tail top
        { side: "bottom", x0: 0, x1: vw, y0: 0, y1: rect.top - pad },      // card above → tail bottom
      ];
      let best = null;
      for (const r of regions) {
        const rw = r.x1 - r.x0 - M * 2, rh = r.y1 - r.y0 - M * 2;
        if (rw < 340 || rh < 110) continue;
        const useW = Math.min(w, rw);   // narrow side regions rewrap the text
        cap.style.width = useW + "px";
        const useH = cap.offsetHeight;
        cap.style.width = "";
        if (useH > rh) continue;
        const area = (r.x1 - r.x0) * (r.y1 - r.y0);
        if (!best || area > best.area) best = { ...r, area, useW };
      }
      if (best) {
        cap.style.width = best.useW + "px";
        w = best.useW;
        h = cap.offsetHeight;
        x = (best.x0 + best.x1) / 2 - w / 2;
        y = (best.y0 + best.y1) / 2 - h / 2;
        this._tail = best.side;
      } else {
        // Nothing fits cleanly: float over the lower part of the shot.
        x = (vw - w) / 2;
        y = vh - h - M * 2;
        this._tail = null;
      }
    } else if (this._cineActive) {
      // Cinematic slide: the card floats low, leaving the picture in view.
      x = (vw - w) / 2;
      y = vh - h - Math.max(24, vh * 0.06);
      this._tail = null;
    } else {
      x = (vw - w) / 2;
      y = (vh - h) / 2;
      this._tail = null;
    }

    x = clamp(x, M, Math.max(M, vw - w - M));
    y = clamp(y, M, Math.max(M, vh - h - M));
    cap.style.left = x + "px";
    cap.style.top = y + "px";

    // Speech-bubble tail: aim it at the spotlighted panel's centre so the
    // card reads as the story SPEAKING about what it highlights.
    if (this._tail && rect) {
      cap.dataset.tail = this._tail;
      if (this._tail === "left" || this._tail === "right") {
        cap.style.setProperty("--tail-y", clamp((rect.top + rect.bottom) / 2 - y, 26, h - 26) + "px");
      } else {
        cap.style.setProperty("--tail-x", clamp((rect.left + rect.right) / 2 - x, 26, w - 26) + "px");
      }
    } else {
      cap.removeAttribute("data-tail");
    }
  }

  /**
   * Give the spotlighted element its own composited layer that rasters at the
   * REAL accumulated scale, so its text stays crisp under the camera zoom.
   * Measured recipe: a layer born via plain translateZ keeps its initial 1x
   * raster forever, but REMOVING a `will-change: transform` (while a
   * translateZ keeps the layer alive) makes the compositor re-evaluate and
   * re-raster at the accumulated scale. So: will-change first, swap a beat
   * later.
   */
  _sharpen(el) {
    this._sharpEl = el;
    this._sharpPrev = el.style.transform;
    el.style.willChange = "transform";           // the layer is born (1x raster)
    clearTimeout(this._sharpSwap);
    this._sharpSwap = setTimeout(() => {
      if (this._sharpEl !== el) return;
      el.style.transform = "translateZ(0)";       // keep the layer alive...
      el.style.willChange = "";                    // ...re-raster at true scale
    }, 500);
  }

  _unsharpen() {
    clearTimeout(this._sharpSwap);
    if (!this._sharpEl) return;
    this._sharpEl.style.willChange = "";
    this._sharpEl.style.transform = this._sharpPrev || "";
    this._sharpEl = null;
  }

  _setCam(s, tx, ty) {
    this._cam = { s, tx, ty };
    const root = this.root;
    if (!root) return;
    // Composite only WHILE gliding. Both `will-change` and the transition
    // property pin the layer's raster scale at 1x (blurry when scaled up), so
    // once the glide settles drop both, sharpen the spotlighted target (see
    // below) and announce the settled scale so canvas renderers re-render
    // their backing stores at zoom resolution.
    root.classList.add("st-cam");
    void root.offsetWidth;              // transition must be active before the change
    root.style.willChange = "transform";
    root.style.transform = (s === 1 && !tx && !ty) ? "translate(0px, 0px) scale(1)" : `translate(${tx}px, ${ty}px) scale(${s})`;
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      root.classList.remove("st-cam");
      root.style.willChange = "auto";
      if (this.active) {
        // The huge scaled root stays at its 1x raster (Chrome caps raster
        // scale on large layers), which is invisible under the blur veils —
        // but the spotlighted panel must be sharp. Promoting IT to its own
        // small composited layer makes it raster at the accumulated scale.
        clearTimeout(this._sharpTimer);
        this._sharpTimer = setTimeout(() => {
          if (this.active && this._target && s !== 1) this._sharpen(this._target);
        }, 400);
      } else {
        // After stop() the camera is home — leave no inline style behind.
        root.style.transform = "";
        root.style.willChange = "";
      }
      window.__quentraStoryScale = s;
      window.dispatchEvent(new CustomEvent("quentra:storycam", { detail: { scale: s } }));
    }, CAM_MS + 80);
  }

  /**
   * Follow the target with the spotlight ring and the four blur veils while
   * the camera glides. The veils tile the viewport around the ring's hole, so
   * everything except the highlighted area is blurred.
   */
  _trackSpot(targetEl) {
    if (this._trackRaf) cancelAnimationFrame(this._trackRaf);
    const spot = this._spot, veils = this._veils;
    if (!spot || !veils) return;
    const box = (el, x, y, w, h) => {
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.style.width = Math.max(0, w) + "px";
      el.style.height = Math.max(0, h) + "px";
    };
    if (!targetEl) {
      // Wide shot: nothing to keep sharp, so one veil blurs the whole page
      // behind the centered card — the same reading as the intro popup.
      spot.style.display = "none";
      veils.forEach((v, i) => { v.style.display = i === 0 ? "block" : "none"; });
      box(veils[0], 0, 0, window.innerWidth, window.innerHeight);
      return;
    }
    spot.style.display = "block";
    veils.forEach((v) => { v.style.display = "block"; });
    const t0 = performance.now();
    const pad = 10;
    const tick = () => {
      if (!this.active || !this._spot) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      const r = targetEl.getBoundingClientRect();
      const L = r.left - pad, T = r.top - pad, R = r.right + pad, B = r.bottom + pad;
      box(spot, L, T, R - L, B - T);
      box(veils[0], 0, 0, vw, T);            // above the hole
      box(veils[1], 0, B, vw, vh - B);       // below
      box(veils[2], 0, T, L, B - T);         // left strip
      box(veils[3], R, T, vw - R, B - T);    // right strip
      if (performance.now() - t0 < CAM_MS + 200) this._trackRaf = requestAnimationFrame(tick);
      else this._trackRaf = null;
    };
    tick();
  }
}

// -------------------------------------------------------------- helpers ---
function mk(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

/** Current translate+scale of el, read from the computed matrix. */
function liveTransform(el) {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return { s: 1, tx: 0, ty: 0 };
  const m = t.match(/matrix\(([^)]+)\)/);
  if (!m) return { s: 1, tx: 0, ty: 0 };
  const p = m[1].split(",").map(Number);
  return { s: p[0] || 1, tx: p[4] || 0, ty: p[5] || 0 };
}

/** Re-render on the shared language switch; returns an unsubscribe fn. */
function subLang(fn) {
  const h = () => fn();
  window.addEventListener("quentra:langchange", h);
  return () => window.removeEventListener("quentra:langchange", h);
}
