// main.js — Hospital Shield. Nothing simulated, nothing automatic: the user
// edits the SQL and presses Yürüt; the statement is executed for real on the
// direct connection and then, unchanged, through the Quentra gateway. Every
// number and every cell on screen comes from those two executions.

import { initQuentraApp, QuentraI18n } from "/shared/quentra-i18n.js";
import { StoryTour } from "/shared/story-tour.js";
import { StoryBubble } from "/shared/story-bubble.js";
import { HOSPITAL_INTRO, HOSPITAL_DICT } from "./i18n.js";
import { DEFAULT_SQL, IDENTITY_COLUMNS } from "./data.js";
import { Scene } from "./scene.js";
import { SqlWin } from "./sqlwin.js";
import { renderPanels } from "./render.js";

const $ = (id) => document.getElementById(id);
const t = (key, fb) => QuentraI18n.t(key, fb);

let strip, win;
let dbUp = false;
let gatewayUp = null;
let lastResult = null;
let history = [];
let busy = false;
let tour = null;

// ---- narration: every story beat is voiced through the server's TTS cache ----
// Sync model: one clip per step, started on the step change and killed on the
// next one (or on tour exit). Nothing runs on a timeline, so the voice can
// never drift from the slides. When a clip finishes, the story advances
// itself (autoNext); the caption card carries a Duraklat/Devam toggle that
// freezes both the voice and the auto-flow. Clips are prefetched when the
// story starts, so each beat plays instantly; without an API key every call
// fails quietly and the story is simply silent (manual İleri still works).

const narrator = {
  audio: null,
  seq: 0,
  paused: false,
  autoNext: null, // set by setupTour: advances the tour when a clip ends
  _onEnd: null, // per-clip continuation: dialogue chains here instead of autoNext
  cache: new Map(), // "<lang>|<voice>|<text>" -> Promise<objectURL>

  // Narration is ALWAYS Turkish (user's call) — the UI language only affects
  // the written captions. Voice text is therefore pulled from the TR dict.
  lang() { return "tr"; },

  // `voice` is a logical speaker role ("manager", "engineer"); empty means
  // the narrator voice. The server maps roles to ElevenLabs voice ids.
  fetchClip(text, voice) {
    const k = this.lang() + "|" + (voice || "") + "|" + text;
    if (!this.cache.has(k)) {
      const p = fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, lang: this.lang(), voice: voice || "" }),
      }).then((r) => {
        if (!r.ok) throw new Error("tts " + r.status);
        return r.blob();
      }).then((b) => URL.createObjectURL(b));
      // A failed clip must not poison the cache — retry on the next play.
      p.catch(() => this.cache.delete(k));
      this.cache.set(k, p);
    }
    return this.cache.get(k);
  },

  preload(texts) {
    texts.forEach((tx) => { if (tx) this.fetchClip(tx).catch(() => {}); });
  },

  // Word timings for a narration line (character start seconds). null when
  // the cache has none yet — callers fall back to proportional pacing, and a
  // miss is not cached so the timings are picked up on the next attempt.
  alignCache: new Map(),
  fetchAlign(text, voice) {
    const k = this.lang() + "|" + (voice || "") + "|" + text;
    if (!this.alignCache.has(k)) {
      const p = fetch("/api/tts/align", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, lang: this.lang(), voice: voice || "" }),
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        .then((v) => { if (!v) this.alignCache.delete(k); return v; });
      this.alignCache.set(k, p);
    }
    return this.alignCache.get(k);
  },

  // opts: { voice, onEnd, onStart, matchCine } — onEnd replaces the default
  // advance for THIS clip (a slide's narration hands over to its character
  // dialogue); onStart fires the moment the voice actually starts; matchCine
  // false keeps the clip from stretching the slide's ambient video (used by
  // the narration on dialogue slides, where the video belongs to the SPEECH).
  async play(text, opts) {
    const my = ++this.seq;
    const o = opts || {};
    this.paused = false; // navigating (manual or auto) resumes the flow
    this._onEnd = o.onEnd || null;
    if (this.audio) { this.audio.pause(); this.audio.currentTime = 0; }
    if (!text) return;
    try {
      const url = await this.fetchClip(text, o.voice);
      if (my !== this.seq) return; // the story already moved on
      if (!this.audio) this.audio = new Audio();
      this.audio.onended = () => {
        if (my === this.seq && !this.paused) this._finish();
      };
      // Tell the story engine how long this clip runs, so an ambient video
      // on the slide can slow down and finish with the voice.
      this.audio.onloadedmetadata = () => {
        if (o.matchCine !== false && my === this.seq && tour && tour.active && isFinite(this.audio.duration)) {
          tour.cineMatchDuration(this.audio.duration);
        }
      };
      this.audio.src = url;
      if (o.onStart) { try { o.onStart(); } catch { /* host hook */ } }
      this.audio.play().catch(() => {});
    } catch { /* no key / offline: silent story, manual advance */ }
  },

  // Runs the current clip's continuation (dialogue), or advances the story.
  _finish() {
    const f = this._onEnd;
    this._onEnd = null;
    if (f) f();
    else if (this.autoNext) this.autoNext();
  },

  // Space (Duraklat/Devam): freezes the voice AND the auto-advance together.
  togglePause() {
    if (this.paused) {
      this.paused = false;
      if (this.audio && this.audio.src) {
        // Clip already over while paused → continue the flow now.
        if (this.audio.ended) this._finish();
        else this.audio.play().catch(() => {});
      }
    } else {
      this.paused = true;
      if (this.audio) this.audio.pause();
    }
  },

  stop() {
    this.seq++;
    this.paused = false;
    this._onEnd = null;
    if (this.audio) { this.audio.pause(); this.audio.currentTime = 0; }
  },
};

let preloadNarration = () => {};

// ---- field-sweep choreography: while the narration lists the fields of the
// first result row, a rectangle marks each one and the camera does a short
// zoom onto it; when the narration moves on ("Mühendis…"), the camera pulls
// back to the whole grid. Beat times come from the clip's REAL word timings
// (/api/tts/align — character start seconds), so each frame appears exactly
// when its word is spoken; without timings a proportional estimate is used.
// The clock is the audio's currentTime: pausing the story freezes the sweep.

const choreo = { timer: null, mark: null, token: 0 };

function stopChoreo() {
  choreo.token++;
  if (choreo.timer) { clearInterval(choreo.timer); choreo.timer = null; }
  if (choreo.mark) { choreo.mark.remove(); choreo.mark = null; }
}

// The sensitive-field groups, in the order BOTH the sweep and the narration
// texts enumerate them. A step may pass a subset via cfg.groups/cfg.words
// (the masked grid skips TANI — it stays readable there by design).
const SWEEP_GROUPS = [["AD", "SOYAD"], ["TCKN"], ["TELEFON"], ["ADRES"], ["TANI"]];
const SWEEP_WORDS = ["ad soyad", "kimlik numarası", "telefon", "adres", "tanı"];

async function startFieldSweep(cfg) {
  stopChoreo();
  const myToken = choreo.token;
  const groups = cfg.groups || SWEEP_GROUPS;
  const words = cfg.words || SWEEP_WORDS;
  const table = document.getElementById(cfg.table);
  if (!table || !table.rows || table.rows.length < 2) return;
  const heads = [...table.rows[0].cells].map((c) => c.textContent.trim().toUpperCase());
  const row = table.rows[1];
  const rects = groups
    .map((group) => {
      const cells = group.map((h) => row.cells[heads.indexOf(h)]).filter(Boolean);
      if (!cells.length) return null;
      const left = Math.min(...cells.map((c) => c.offsetLeft));
      const right = Math.max(...cells.map((c) => c.offsetLeft + c.offsetWidth));
      const top = Math.min(...cells.map((c) => c.offsetTop));
      const bottom = Math.max(...cells.map((c) => c.offsetTop + c.offsetHeight));
      return { left, top, w: right - left, h: bottom - top };
    })
    .filter(Boolean);
  if (rects.length !== groups.length) return;

  // Real word timings for THIS narration text, if the cache has them.
  let sched = null, wideAt = null;
  const align = await narrator.fetchAlign(cfg.voiceText);
  if (choreo.token !== myToken) return; // the story moved on meanwhile
  if (align && align.chars && align.starts && align.chars.length === align.starts.length) {
    const text = align.chars.join("");
    const times = [];
    let from = 0;
    for (const word of words) {
      const i = text.indexOf(word, from);
      if (i < 0) { times.length = 0; break; }
      times.push(Math.max(0, align.starts[i] - 0.15)); // shade early: frame lands with the word
      from = i + word.length;
    }
    if (times.length === words.length) {
      sched = times;
      const wi = text.indexOf("Mühendis", from);
      wideAt = wi >= 0 ? Math.max(0, align.starts[wi] - 0.15) : null;
    }
  }

  const scroll = table.closest(".rs-scroll") || table.parentElement;
  const mark = document.createElement("div");
  mark.className = "story-mark" + (cfg.markClass ? " " + cfg.markClass : "");
  mark.id = "storyMark";
  scroll.appendChild(mark);
  choreo.mark = mark;

  const place = (r) => {
    mark.style.left = table.offsetLeft + r.left - 4 + "px";
    mark.style.top = table.offsetTop + r.top - 3 + "px";
    mark.style.width = r.w + 8 + "px";
    mark.style.height = r.h + 6 + "px";
    // Keep the marked field inside the grid's own horizontal scroll window.
    scroll.scrollLeft = Math.max(0, table.offsetLeft + r.left + r.w / 2 - scroll.clientWidth / 2);
  };

  let idx = -1, wide = false;
  const t0 = performance.now();
  choreo.timer = setInterval(() => {
    if (!tour || !tour.active) { stopChoreo(); return; }
    const a = narrator.audio;
    const voiced = a && a.src && isFinite(a.duration) && a.duration > 0;
    const tsec = voiced ? a.currentTime : (performance.now() - t0) / 1000;

    let want = -1, wideNow = false;
    if (sched) {
      for (let i = 0; i < sched.length; i++) if (tsec >= sched[i]) want = i;
      wideNow = wideAt != null && tsec >= wideAt;
    } else {
      // No timings: spread the beats proportionally over the clip.
      const total = voiced ? a.duration : 16;
      const frac = tsec / total;
      for (let i = 0; i < cfg.fracSched.length; i++) if (frac >= cfg.fracSched[i]) want = i;
      wideNow = frac >= cfg.fracWide;
    }

    if (wideNow) {
      if (!wide) {
        wide = true;
        mark.style.opacity = "0";
        tour.focus(cfg.wideTarget, cfg.wideZoom);
      }
      return;
    }
    if (want >= 0 && want !== idx) {
      idx = want;
      place(rects[idx]);
      mark.style.opacity = "1";
      tour.focus("#storyMark", 2.6);
    }
  }, 150);
}

initQuentraApp({
  appId: "hospital",
  accent: "#2dd4bf",
  accent2: "#38bdf8",
  brand: { name: "Quentra", sub: "Hospital Shield", logo: "/assets/quentra-logo.png" },
  intro: HOSPITAL_INTRO,
  dict: HOSPITAL_DICT,
  onReady: boot,
});

function boot() {
  strip = new Scene($("stageSvg"));
  win = new SqlWin(t);
  win.setQuery(DEFAULT_SQL);
  win.setIdentity("destek", "direct");
  win.setStatus(t("sw.stReady"), { tone: "idle", rows: 0 });

  $("btnExecute").addEventListener("click", runQuery);
  $("btnTour").addEventListener("click", () => {
    if (tour && !tour.active) { preloadNarration(); tour.start(); }
  });
  $("swRoutes").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-route]");
    if (b && !busy) setRouteMode(b.dataset.route);
  });
  window.addEventListener("quentra:langchange", paint);

  pollState();
  setInterval(pollState, 4000);
  paint();
  setupTour();
}

// ---- story mode: the incident told end to end around the live sim ----
//
// Cinematic stills carry the plot; the beats in between zoom the camera onto
// the REAL interface. Dramaturgy of the two routes: entering the SSMS step
// runs the query but shows ONLY the direct leg (Quentra does not exist in the
// story yet); the Quentra leg becomes visible during the reveal slide, so the
// masked grid is already on screen when the camera reaches it.

let storyRes = null; // direct leg shown, Quentra leg still held back

// Character dialogue: after a slide's narration, the character on screen
// speaks their own line — their voice (per-role ElevenLabs voice), a comic
// bubble above their head, letters typing in Matrix-green with the words.
const bubble = new StoryBubble();

async function playDialogue(step) {
  const d = step.dialog;
  const text = HOSPITAL_DICT.tr[d.textKey] || "";
  if (!text || !tour || !tour.active) { if (narrator.autoNext) narrator.autoNext(); return; }

  await bubble.show({
    imgSrc: step.img,
    anchor: d.anchor,
    side: d.side,
    tailFrac: d.tailFrac,
    name: t(d.nameKey),
  });
  if (!tour || !tour.active) { bubble.hide(); return; }

  narrator.play(text, {
    voice: d.voice,
    // The slide's ambient video was held back (videoDeferred) — the still
    // stood like a photograph through the narration; the character comes
    // alive exactly when their voice starts.
    onStart: () => { if (tour && tour.active) tour.cineStartVideo(); },
    onEnd: () => {
      // Let the last glowing letters land before the slide moves on.
      const settled = narrator.seq;
      setTimeout(() => {
        if (narrator.seq === settled && !narrator.paused && tour && tour.active && narrator.autoNext) {
          narrator.autoNext();
        }
      }, 700);
    },
  });
  const dseq = narrator.seq; // play() bumped it synchronously — this IS our clip

  // Typing sync: real character timings when the cache has them; the clip
  // fetch below resolves the same cached promise play() used, so the align
  // sidecar is only asked for once the clip actually exists.
  let clipOk = true;
  try { await narrator.fetchClip(text, d.voice); } catch { clipOk = false; }
  const align = clipOk ? await narrator.fetchAlign(text, d.voice) : null;
  // Navigating away meanwhile started another clip — this line is history.
  if (!tour || !tour.active || !bubble.el || narrator.seq !== dseq) return;
  bubble.type(text, { audioRef: clipOk ? () => narrator.audio : null, align });
}

function setupTour() {
  const storyRun = async () => {
    if (busy) return;
    setRouteMode("direct");
    storyRes = await runDirectLeg();
  };
  const storyReveal = async () => {
    if (!storyRes || busy) return;
    const res = storyRes;
    storyRes = null;
    setRouteMode("both");
    await runQuentraLeg(res);
    // If the camera is already waiting on the masked grid, re-frame it.
    if (tour && tour.active) {
      const s = tour.steps[tour.index];
      if (s && s.target === "#rsQuentra") tour.refresh();
    }
  };

  // Always the TURKISH text, whatever the UI language shows on the captions.
  // ".v" is the pronunciation variant: the caption shows the abbreviation
  // (SSMS, TCKN, KVKK), the voice reads the expanded form.
  const narrationText = (step) =>
    HOSPITAL_DICT.tr[step.key + ".v"] || HOSPITAL_DICT.tr[step.key + ".x"] || t(step.key + ".x");

  tour = new StoryTour({
    root: ".app",
    // Cine steps: `video` is the ambient mp4 that fades in over the still.
    // Until the file exists (user delivers them) the Ken Burns still plays —
    // dropping an mp4 with this exact name into img/ + rebuild is all it takes.
    steps: [
      { img: "img/01-hastane.jpg", video: "img/01-hastane.mp4", key: "tour.s1" },
      // Dialogue beats: after the narration, the character speaks their own
      // line. The bubble floats BESIDE the head (side) — over-the-head would
      // clip at the top of the frame; anchor = fraction of the IMAGE, at the
      // speaker's head. videoDeferred: the still stands like a photo during
      // the narration; the clip only starts when the character speaks.
      { img: "img/02-ariza.jpg", video: "img/02-ariza.mp4", key: "tour.s2", videoDeferred: true,
        dialog: { voice: "manager", textKey: "tour.s2.d", nameKey: "tour.s2.dn",
                  anchor: { x: 0.38, y: 0.28 }, side: "right" } },
      { img: "img/03-destek.jpg", video: "img/03-destek.mp4", key: "tour.s3", videoDeferred: true,
        dialog: { voice: "engineer", textKey: "tour.s3.d", nameKey: "tour.s3.dn",
                  anchor: { x: 0.67, y: 0.24 }, side: "left" } },
      { img: "img/04-vpn.png", video: "img/04-vpn.mp4", key: "tour.s4" },
      { target: "#sqlwin", key: "tour.s5", zoom: 1.35, onEnter: storyRun },
      { target: "#rsDirect", key: "tour.s6", zoom: 1.7 },
      { img: "img/05-quentra.jpg", video: "img/05-quentra.mp4", key: "tour.s7", onEnter: storyReveal },
      { img: "img/07-sentinel.png", video: "img/07-sentinel.mp4", key: "tour.hero", cineClass: "st-cine-hero" },
      { target: "#rsQuentra", key: "tour.s8", zoom: 1.7, onEnter: storyReveal },
      { target: "#sqlPanel", key: "tour.s9", zoom: 1.45 },
      // Video intentionally off: 06-final.mp4 was rendered from the OLD final
      // still and would cover the new artwork — re-add the path when a clip
      // matching the new frame is delivered.
      { img: "img/06-final.jpg", key: "tour.s10" },
    ],
    translate: (step) => ({ title: t(step.key + ".t"), text: t(step.key + ".x") }),
    labels: () => ({
      back: t("tour.back"), next: t("tour.next"), done: t("tour.done"),
      pause: t("tour.pause"), resume: t("tour.resume"),
    }),
    onStep: (step) => {
      stopChoreo();
      bubble.hide();
      // Dialogue slides: narration sets the scene (over the frozen still —
      // matchCine off, the deferred video belongs to the speech), then the
      // character takes over in their own voice; the story advances after.
      narrator.play(narrationText(step), step.dialog ? { onEnd: () => playDialogue(step), matchCine: false } : undefined);
      if (step.key === "tour.s6") {
        startFieldSweep({
          table: "gridDirect", voiceText: narrationText(step),
          wideTarget: "#rsDirect", wideZoom: 1.7,
          fracSched: [0.11, 0.18, 0.26, 0.33, 0.41], fracWide: 0.53,
        });
      } else if (step.key === "tour.s8") {
        startFieldSweep({
          table: "gridQuentra", markClass: "mask-ok", voiceText: narrationText(step),
          groups: SWEEP_GROUPS.slice(0, 4), words: SWEEP_WORDS.slice(0, 4),
          wideTarget: "#rsQuentra", wideZoom: 1.7,
          fracSched: [0.24, 0.32, 0.40, 0.48], fracWide: 0.62,
        });
      }
    },
    onDone: () => { stopChoreo(); bubble.hide(); narrator.stop(); storyReveal(); },
    pauseControl: {
      isPaused: () => narrator.paused,
      toggle: () => narrator.togglePause(),
    },
  });

  narrator.autoNext = () => { if (tour && tour.active) tour.next(); };
  preloadNarration = () => {
    narrator.preload(tour.steps.map(narrationText));
    // Character dialogue clips synthesize with their own voices — prefetch
    // them (and then their word timings) so bubbles type without a stall.
    tour.steps.forEach((s) => {
      if (!s.dialog) return;
      const tx = HOSPITAL_DICT.tr[s.dialog.textKey];
      if (!tx) return;
      narrator.fetchClip(tx, s.dialog.voice)
        .then(() => narrator.fetchAlign(tx, s.dialog.voice))
        .catch(() => {});
    });
    // Warm the HTTP cache for the ambient clips too, so a cold server start
    // can never leave a slide black while its video is still streaming in.
    tour.steps.forEach((s) => { if (s.video) fetch(s.video).catch(() => {}); });
  };

  tour.intro(() => ({
    eyebrow: t("tour.intro.eyebrow"),
    title: t("tour.intro.title"),
    paragraphs: [t("tour.intro.p1"), t("tour.intro.p2"), t("tour.intro.p3")],
    start: t("tour.intro.start"),
    skip: t("tour.intro.skip"),
  })).then((go) => { if (go) { preloadNarration(); tour.start(); } });
}

// ---- execute: the user's SQL, real rows ----
// The run is split into legs so (a) the SSMS route picker decides which view
// comes back — direct, Quentra, or both — and (b) the STORY can hold the
// Quentra view back until its reveal beat. The server always executes the
// statement on both routes; the legs only control what gets DISPLAYED.

let routeMode = "both"; // "direct" | "quentra" | "both" — the SSMS picker

function setRouteMode(mode) {
  routeMode = mode;
  document.querySelectorAll("#swRoutes button").forEach((b) =>
    b.classList.toggle("is-on", b.dataset.route === mode));
}

async function runQuery() {
  if (routeMode === "quentra") { await runQuentraOnly(); return; }
  const res = await runDirectLeg();
  if (res && routeMode === "both") await runQuentraLeg(res);
}

// One real round-trip; the outbound packet travels the given route.
async function fetchRun(sql, route) {
  const outbound = strip.sendQuery(route);
  let res = null;
  try {
    const r = await fetch("/api/hospital/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    res = await r.json();
  } catch (e) {
    res = { error: t("sw.stNoLive") };
  }
  await outbound;
  return res;
}

function failRun(res) {
  win.setStatus(res && res.error ? res.error : t("sw.stNoLive"), { tone: "warn", rows: 0 });
  strip.setRoute(null);
  finish();
}

// Leg 1 — display only what the raw connection returned.
// Returns the server result, or null on failure.
async function runDirectLeg() {
  if (busy) return null;
  busy = true;
  win.setBusy(true);
  const sql = win.getQuery();

  win.clearResults();
  win.execFlash();
  win.setIdentity("destek", "direct");
  win.setStatus(t("sw.stExecuting"), { tone: "run", rows: 0 });
  hideBadges();

  const res = await fetchRun(sql, "direct");
  if (!res || res.error) { failRun(res); return null; }

  res._sql = sql;
  lastResult = res;
  gatewayUp = res.gatewayUp;
  const direct = res.directRows || [];
  const masked = !!res.masked;

  await strip.returnResult("direct");
  win.fillGrid("direct", { columns: res.columns, rows: direct }, {
    compareTo: res.quentraRows || [], tone: masked ? "open" : "plain", meta: fmtMs(res.directMs),
  });
  win.setStatus(masked ? t("sw.stDoneOpen") : t("sw.stDone"),
    { tone: masked ? "open" : "idle", rows: direct.length });
  showDirectBadge(res);
  strip.setRoute(null);
  if (routeMode === "direct") pushHistory(res, false);
  finish();
  return res;
}

// Leg 2 — the IDENTICAL statement through Quentra. Pure display of the rows
// that already came back with leg 1's execution; no second fetch.
async function runQuentraLeg(res) {
  if (busy) return;
  busy = true;
  win.setBusy(true);
  const masked = !!res.masked;

  win.setIdentity("destek", "quentra");
  win.flashQueryUnchanged();
  win.setStatus(t("sw.stExecuting"), { tone: "run" });
  await strip.sendQuery("quentra");
  await showQuentraResult(res);
  pushHistory(res, masked);
  finish();
}

// Quentra-only mode: single fetch, outbound packet on the Quentra route,
// and only the gateway's view of the data appears.
async function runQuentraOnly() {
  if (busy) return;
  busy = true;
  win.setBusy(true);
  const sql = win.getQuery();

  win.clearResults();
  win.execFlash();
  win.setIdentity("destek", "quentra");
  win.setStatus(t("sw.stExecuting"), { tone: "run", rows: 0 });
  hideBadges();

  const res = await fetchRun(sql, "quentra");
  if (!res || res.error) { failRun(res); return; }

  res._sql = sql;
  lastResult = res;
  gatewayUp = res.gatewayUp;
  await showQuentraResult(res);
  pushHistory(res, !!res.masked);
  finish();
}

// Shared tail of both Quentra paths: result packet, grid, status, badges.
async function showQuentraResult(res) {
  const quentra = res.quentraRows || [];
  const masked = !!res.masked;
  await strip.returnResult("quentra", { masked });
  win.fillGrid("quentra", { columns: res.columns, rows: quentra }, {
    compareTo: res.directRows || [], tone: masked ? "masked" : "plain", meta: fmtMs(res.quentraMs),
  });
  win.setStatus(masked ? t("sw.stDoneMasked") : t("sw.stDoneNoRule"),
    { tone: masked ? "masked" : "warn", rows: quentra.length });
  win.highlightSet("quentra", "teal");
  strip.setRoute(null);
  showBadges(res);
}

function pushHistory(res, shownMasked) {
  history.unshift({
    rows: (res.directRows || []).length,
    masked: shownMasked,
    directMs: res.directMs,
    quentraMs: res.quentraMs,
    sql: firstLine(res._sql || ""),
  });
  history = history.slice(0, 8);
}

function finish() {
  busy = false;
  win.setBusy(false);
  paint();
}

// ---- badges: verdict of the real comparison, never a decoration ----

function hideBadges() {
  $("kvkkBadge").hidden = true;
  $("maskedBadge").hidden = true;
}

function showBadges(res) {
  const identityShown = (res.columns || []).some((c) => IDENTITY_COLUMNS.includes(String(c).toUpperCase()));
  $("maskedBadge").hidden = !res.masked;
  // Only warn about exposure when identity columns really came back unmasked.
  $("kvkkBadge").hidden = res.masked || !identityShown || !(res.directRows || []).length;
}

// After the direct leg alone: the masked view is not on screen (yet), so the
// verdict is about what IS visible — identity data in the clear.
function showDirectBadge(res) {
  const identityShown = (res.columns || []).some((c) => IDENTITY_COLUMNS.includes(String(c).toUpperCase()));
  $("kvkkBadge").hidden = !identityShown || !(res.directRows || []).length;
}

// ---- read-only status poll ----

async function pollState() {
  try {
    const r = await fetch("/api/hospital/state", { cache: "no-store" });
    if (!r.ok) throw new Error();
    const s = await r.json();
    dbUp = !!s.provisioned;
    if (gatewayUp === null) gatewayUp = s.gatewayUp;
  } catch {
    dbUp = false;
  }
  paint();
}

function paint() {
  renderPanels({ dbUp, gatewayUp, result: lastResult, history, sqlText: win ? win.getQuery() : "" }, t);
}

function fmtMs(v) { return v == null ? "" : v + " ms"; }
function firstLine(s) {
  const line = String(s || "").trim().split("\n")[0];
  return line.length > 52 ? line.slice(0, 52) + "…" : line;
}
