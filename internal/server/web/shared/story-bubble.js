// story-bubble.js
// Comic speech bubble for the cinematic story slides: pops up above a
// character's head and TYPES its line letter by letter, each glyph landing
// with a Matrix-style neon-green glow, in sync with the character's voice.
//
// Sync model: the reveal clock is the dialogue audio's currentTime, so
// pausing the story freezes the typing exactly like it freezes the voice.
// With real character timings (/api/tts/align) every letter appears the
// moment it is spoken; without them the reveal spreads proportionally over
// the clip. With no audio at all (no API key) a wall-clock fallback types
// at reading speed so the silent story still works.
//
// Usage (host side):
//   const bubble = new StoryBubble();
//   await bubble.show({ imgSrc, anchor: {x:.36,y:.16}, tailFrac:.25, name });
//   bubble.type(text, { audioRef: () => narrator.audio, align });
//   bubble.hide();
//
// `anchor` is a fraction of the slide IMAGE (not the viewport): the cine
// layer letterboxes the still with object-fit contain, so the bubble first
// recovers the image's on-screen content box from its natural size, then
// pins its tail tip at (x, y) inside it. `tailFrac` is where the tail sits
// along the bubble's own width (0 left … 1 right), so the body can lean
// into the free area of the shot while the tail stays on the speaker.
// `side: "left" | "right"` floats the bubble BESIDE the speaker instead of
// above them (the tail reaches horizontally) — the fit for heads near the
// top of the frame, where an over-the-head bubble would clip.

export class StoryBubble {
  constructor() {
    this.el = null;
    this._cfg = null;
    this._natural = null;
    this._raf = null;
    this._seq = 0;
    this._onResize = () => this._place();
  }

  async show(cfg) {
    this.hide();
    const my = ++this._seq;
    this._cfg = cfg || {};
    this._natural = await naturalSize(this._cfg.imgSrc);
    if (my !== this._seq) return; // hidden (or re-shown) while the image loaded

    const el = document.createElement("div");
    el.className = "st-bubble";
    // The comic bubble itself is the delivered artwork (white body, purple
    // outline, swooping pointed tail): an <img> stretched so the art's BODY
    // region aligns with this element's box, tail reaching out of it.
    el.innerHTML =
      '<img class="st-bubble-art" alt="" aria-hidden="true">' +
      (this._cfg.name ? '<div class="st-bubble-name"></div>' : "") +
      '<div class="st-bubble-text"></div>';
    if (this._cfg.name) el.querySelector(".st-bubble-name").textContent = this._cfg.name;
    document.body.appendChild(el);
    this.el = el;
    window.addEventListener("resize", this._onResize);
    this._place();
  }

  /**
   * Type `text` into the bubble. opts:
   *   audioRef — () => HTMLAudioElement driving the reveal (null: wall clock)
   *   align    — { chars: [..], starts: [..] } character start seconds, or null
   */
  type(text, opts) {
    if (!this.el) return;
    const my = this._seq;
    const box = this.el.querySelector(".st-bubble-text");
    box.innerHTML = "";
    const chars = [...String(text)];
    // All glyphs are laid out invisibly up front, so the bubble takes its
    // final size immediately and nothing reflows while the line types out.
    const spans = chars.map((c) => {
      const s = document.createElement("span");
      s.className = "st-bl-ch";
      s.textContent = c;
      box.appendChild(s);
      return s;
    });
    const cursor = document.createElement("span");
    cursor.className = "st-bl-cursor";
    cursor.textContent = "▋";
    box.appendChild(cursor);
    this._place(); // content decided the final box — pin the tail again

    const align = opts && opts.align;
    const audioRef = (opts && opts.audioRef) || null;
    const starts =
      align && align.chars && align.starts && align.chars.join("") === chars.join("")
        ? align.starts
        : null;

    let shown = 0;
    const t0 = performance.now();
    const tick = () => {
      if (my !== this._seq || !this.el) return;
      const a = audioRef ? audioRef() : null;
      const live = a && a.src && isFinite(a.duration) && a.duration > 0;
      let want = 0;
      if (audioRef) {
        // Voiced line: the audio clock decides — before the clip actually
        // starts, currentTime is 0 and nothing types (no early text).
        const tsec = live ? a.currentTime : 0;
        if (starts) {
          while (want < chars.length && starts[want] <= tsec + 0.06) want++;
        } else if (live) {
          want = Math.floor(chars.length * Math.min(1, tsec / (a.duration * 0.94)));
        }
      } else {
        // Silent story: reading-speed wall clock.
        want = Math.min(chars.length, Math.floor((performance.now() - t0) / 42));
      }
      while (shown < want) spans[shown++].classList.add("on");
      if (shown < chars.length) {
        box.insertBefore(cursor, spans[shown]); // cursor rides the reveal edge
        this._raf = requestAnimationFrame(tick);
      } else {
        cursor.remove();
        this._raf = null;
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  hide() {
    this._seq++;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    window.removeEventListener("resize", this._onResize);
    if (this.el) {
      const el = this.el;
      this.el = null;
      el.classList.add("st-bubble-out");
      setTimeout(() => el.remove(), 260);
    }
  }

  // Recover the letterboxed image's content box, then pin the tail tip on the
  // anchor point and lean the body by tailFrac. Falls back to treating the
  // viewport as the image when the natural size is unknown.
  _place() {
    if (!this.el || !this._cfg) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    let box = { left: 0, top: 0, w: vw, h: vh };
    const n = this._natural;
    if (n && n.w && n.h) {
      const s = Math.min(vw / n.w, vh / n.h);
      const w = n.w * s, h = n.h * s;
      box = { left: (vw - w) / 2, top: (vh - h) / 2, w, h };
    }
    const anchor = this._cfg.anchor || { x: 0.5, y: 0.2 };
    const ax = box.left + box.w * anchor.x;
    const ay = box.top + box.h * anchor.y;
    const bw = this.el.offsetWidth, bh = this.el.offsetHeight;
    const img = this.el.querySelector(".st-bubble-art");
    const M = 10;
    let left, top;
    if (this._cfg.side === "left" || this._cfg.side === "right") {
      // Beside the speaker (an over-the-head bubble would clip at the screen
      // top). Variant choice: bubble on the RIGHT of the head needs a tail
      // reaching up-LEFT to the speaker, and vice versa. The element is
      // positioned so the art's tail TIP lands exactly on the anchor.
      const v = this._cfg.side === "right" ? "ul" : "urs";
      const g = bubbleArtGeometry(v, bw, bh);
      left = clamp(ax - g.tip.x, M, Math.max(M, vw - bw - M));
      top = clamp(ay - g.tip.y, M, Math.max(M, vh - bh - M));
      if (img) applyBubbleVariant(img, v, bw, bh);
    } else {
      // Above the speaker, body leaning by tailFrac, tail sweeping down;
      // the down-left/down-right art is picked from where the tip lands.
      const tf = this._cfg.tailFrac == null ? 0.5 : this._cfg.tailFrac;
      const TAIL = 48;
      left = clamp(ax - bw * tf, M, Math.max(M, vw - bw - M));
      top = clamp(ay - bh - TAIL, M, Math.max(M, vh - bh - M));
      if (img) applyBubbleArt(img, bw, bh, { x: ax - left, y: ay - top });
    }
    this.el.style.left = left + "px";
    this.el.style.top = top + "px";
  }
}

// ------------------------------------------------------ bubble artwork ---
// The delivered comic-bubble set (shared/img/bubble-*.png, transparent
// backgrounds): one PNG per tail direction. `body` is the rounded rect's
// region inside the artwork and `tip` the tail's end point, both as
// fractions of the image — measured once from the source files.
const BUBBLE_VARIANTS = {
  dl:  { src: "/shared/img/bubble-dl.png",  body: [0.069, 0.010, 0.968, 0.756], tip: [0.035, 0.982] },
  dr:  { src: "/shared/img/bubble-dr.png",  body: [0.030, 0.008, 0.928, 0.756], tip: [0.958, 0.986] },
  ul:  { src: "/shared/img/bubble-ul.png",  body: [0.069, 0.240, 0.969, 0.984], tip: [0.030, 0.012] },
  ur:  { src: "/shared/img/bubble-ur.png",  body: [0.030, 0.240, 0.927, 0.986], tip: [0.966, 0.010] },
  urs: { src: "/shared/img/bubble-urs.png", body: [0.063, 0.100, 0.766, 0.894], tip: [0.885, 0.194] },
};

// Warm the browser cache so the first bubble never pops in art-less.
for (const k in BUBBLE_VARIANTS) {
  const im = new Image();
  im.src = BUBBLE_VARIANTS[k].src;
}

/**
 * Geometry for stretching a variant's artwork so its BODY region exactly
 * covers a w×h content box: image size/offset (element-local px) and where
 * the tail tip lands (may be far outside the box — that is the point).
 */
export function bubbleArtGeometry(variant, w, h) {
  const V = BUBBLE_VARIANTS[variant];
  const bw = V.body[2] - V.body[0], bh = V.body[3] - V.body[1];
  const iw = w / bw, ih = h / bh;
  const left = -V.body[0] * iw, top = -V.body[1] * ih;
  return {
    src: V.src, iw, ih, left, top,
    tip: { x: (V.tip[0] - V.body[0]) * iw, y: (V.tip[1] - V.body[1]) * ih },
  };
}

/** Stretch a known variant's art over the host element's w×h box. */
export function applyBubbleVariant(img, variant, w, h) {
  const g = bubbleArtGeometry(variant, w, h);
  if (img.getAttribute("src") !== g.src) img.src = g.src;
  img.style.left = g.left + "px";
  img.style.top = g.top + "px";
  img.style.width = g.iw + "px";
  img.style.height = g.ih + "px";
  img.style.display = "block";
  const host = img.parentElement;
  if (host) host.classList.remove("st-plain");
  return g;
}

/**
 * Dress a w×h box in bubble art, picking the tail direction from where the
 * `tip` point (element-local px) lies. tip null = no tail: the art is hidden
 * and the host element falls back to the plain CSS bubble (.st-plain).
 */
export function applyBubbleArt(img, w, h, tip) {
  if (!img) return;
  if (!tip || !w || !h) {
    img.style.display = "none";
    const host = img.parentElement;
    if (host) host.classList.add("st-plain");
    return;
  }
  const dx = tip.x - w / 2, dy = tip.y - h / 2;
  const v = dy >= 0
    ? (dx >= 0 ? "dr" : "dl")
    : dx >= 0 ? (Math.abs(dx) > Math.abs(dy) * 1.3 ? "urs" : "ur") : "ul";
  applyBubbleVariant(img, v, w, h);
}

function naturalSize(src) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const im = new Image();
    im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
