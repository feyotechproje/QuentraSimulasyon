// main.js
// Entry point: wires the DUAL simulation (baseline bank on the left canvas,
// Quentra bank on the right, shared panels between them), the renderers, the
// frame engine and the dashboard together. No backend, no network — everything
// runs in the browser from in-memory demo data; the separate live card at the
// bottom talks to the real database.

import { Simulation } from "./simulation.js";
import { Renderer } from "./renderer.js";
import { Engine } from "./engine.js";
import { UI } from "./ui.js";
import { BANK_GATE_COUNT } from "./world.js";
import { initQuentraApp, QuentraI18n } from "/shared/quentra-i18n.js";
import { StoryTour } from "/shared/story-tour.js";
import { StoryBubble } from "/shared/story-bubble.js";
import { FACTORY_TURNSTILE_INTRO, FACTORY_TURNSTILE_DICT } from "./i18n.js";
import { initAccessLive } from "/shared/access-live.js";
import { InMemoryFactoryAccessDataSource, ApiFactoryAccessDataSource } from "./access-check.js";

const t = (k, fb) => QuentraI18n.t(k, fb);

let tour = null;

// ---- narration: every story beat is voiced through the server's TTS cache ----
// Same model as the hospital story: one clip per step, started on the step
// change and killed on the next one (or on tour exit). When a clip finishes,
// the story advances itself (autoNext); Space freezes both the voice and the
// auto-flow. Clips are prefetched when the story starts; without an API key
// every call fails quietly and the story is silent (manual İleri still works).

const narrator = {
  audio: null,
  seq: 0,
  paused: false,
  autoNext: null, // set by setupStory: advances the tour when a clip ends
  _onEnd: null, // per-clip continuation: dialogue chains here instead of autoNext
  cache: new Map(), // "<lang>|<voice>|<text>" -> Promise<objectURL>

  // Narration is ALWAYS Turkish — the UI language only affects the captions.
  lang() { return "tr"; },

  // `voice` is a logical speaker role ("elif", "can", "mehmet"); empty means
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
  // the cache has none yet — the bubble then types proportionally, and a
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

// Character dialogue: after a slide's narration, the character on screen
// speaks their own line — their voice (per-role ElevenLabs voice), a comic
// bubble beside their head, letters typing with the words.
const bubble = new StoryBubble();

async function playDialogue(step) {
  const d = step.dialog;
  const text = FACTORY_TURNSTILE_DICT.tr[d.textKey] || "";
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
  // fetch below resolves the same cached promise play() used.
  let clipOk = true;
  try { await narrator.fetchClip(text, d.voice); } catch { clipOk = false; }
  // Silent story (no TTS): play()'s onStart never fires, so release the
  // deferred slide video here — the character must come alive regardless.
  if (!clipOk && tour && tour.active) tour.cineStartVideo();
  const align = clipOk ? await narrator.fetchAlign(text, d.voice) : null;
  // Navigating away meanwhile started another clip — this line is history.
  if (!tour || !tour.active || !bubble.el || narrator.seq !== dseq) return;
  bubble.type(text, { audioRef: clipOk ? () => narrator.audio : null, align });
}

// ---- story mode: the incident told end to end around the live sim ----
//
// Cinematic stills carry the plot (the factory at 07:50, the jammed hall,
// Elif, Can, the Quentra gateway, the fixed morning); the beats in between
// zoom the camera onto the REAL dual simulation — framed in the story as the
// monitoring screen Can pulls up in the control room.

// Always the TURKISH text, whatever the UI language shows on the captions.
// ".v" is the pronunciation variant: the caption shows digits/abbreviations,
// the voice reads the expanded form.
const narrationText = (step) =>
  FACTORY_TURNSTILE_DICT.tr[step.key + ".v"] || FACTORY_TURNSTILE_DICT.tr[step.key + ".x"] || t(step.key + ".x");

function setupStory(engine) {
  tour = new StoryTour({
    root: ".app",
    // Cine steps: `video` is the ambient mp4 that fades in over the still.
    // Slides whose clip does not exist yet (02, 03, 06) simply play the Ken
    // Burns still — dropping an mp4 with that exact name into img/ + rebuild
    // is all it takes. videoDeferred: the still stands like a photo during
    // the narration; the clip only starts when the character speaks.
    steps: [
      { img: "img/01-fabrika.png", video: "img/01-fabrika.mp4", key: "tour.s1" },
      // The queue is told over Elif's shot — a separate crowd still only
      // repeated what her frame already shows.
      { img: "img/03-elif.png", video: "img/03-elif.mp4", key: "tour.s3",
        dialog: { voice: "elif", textKey: "tour.s3.d", nameKey: "tour.s3.dn",
                  anchor: { x: 0.82, y: 0.38 }, side: "left" } },
      // videoDeferred: the control room stands like a photograph during the
      // narration and only comes alive when Can starts speaking.
      { img: "img/04-can.png", video: "img/04-can.mp4", key: "tour.s4", videoDeferred: true,
        dialog: { voice: "can", textKey: "tour.s4.d", nameKey: "tour.s4.dn",
                  anchor: { x: 0.34, y: 0.34 }, side: "left" } },
      // No wide shot: Quentra hasn't entered the story yet, so the camera
      // shows ONLY the baseline side — the crowd first, then the heatmap.
      // Framing the canvas (not the whole bank) lets the camera actually
      // zoom, pushing the blurred Quentra bank off to the edge.
      { target: ".bank-baseline .canvas-wrap", key: "tour.s5", zoom: 1.35 },
      { target: "#heatmapPanel",   key: "tour.s6", zoom: 2.0 },
      { target: ".pipeline-panel", key: "tour.s7", zoom: 2.0 },
      { target: "#sqApp",          key: "tour.s8", zoom: 2.2 },
      { img: "img/05-quentra.png", video: "img/05-quentra.mp4", key: "tour.s9" },
      // The brand hero: Last SQL Bender cuts the incoming red query stream —
      // pure black clip, so the default cine styling (cover + vignette) fits.
      { img: "img/06-hero.png", video: "img/06-hero.mp4", key: "tour.hero" },
      { target: "#sqQuentra",      key: "tour.s10", zoom: 2.2 },
      { target: ".bank-quentra",   key: "tour.s11", zoom: 1.6 },
      { target: "#kpiStrip",       key: "tour.s12", zoom: 1.3 },
      { img: "img/07-final.png", video: "img/07-final.mp4", key: "tour.s13" },
    ],
    translate: (step) => ({ title: t(step.key + ".t"), text: t(step.key + ".x") }),
    labels: () => ({
      back: t("tour.back"), next: t("tour.next"), done: t("tour.done"),
      pause: t("tour.pause"), resume: t("tour.resume"),
    }),
    onStep: (step) => {
      bubble.hide();
      // Dialogue slides: narration sets the scene (over the frozen still —
      // matchCine off, the deferred video belongs to the speech), then the
      // character takes over in their own voice; the story advances after.
      narrator.play(narrationText(step), step.dialog ? { onEnd: () => playDialogue(step), matchCine: false } : undefined);
    },
    onDone: () => { bubble.hide(); narrator.stop(); },
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
      const tx = FACTORY_TURNSTILE_DICT.tr[s.dialog.textKey];
      if (!tx) return;
      narrator.fetchClip(tx, s.dialog.voice)
        .then(() => narrator.fetchAlign(tx, s.dialog.voice))
        .catch(() => {});
    });
    // Warm the HTTP cache for the ambient clips too, so a cold server start
    // can never leave a slide black while its video is still streaming in.
    tour.steps.forEach((s) => { if (s.video) fetch(s.video).catch(() => {}); });
  };
}

function boot() {
  const canvasBase = document.getElementById("sceneBaseline");
  const canvasQn = document.getElementById("sceneQuentra");

  // Left bank: the slow baseline query on every card check. Right bank: the
  // SAME check through the Quentra rewrite. Both run simultaneously, so the
  // queue difference on screen is purely the query profile.
  const simBase = new Simulation({ gateCount: BANK_GATE_COUNT, idOffset: 0, mode: "baseline" });
  const simQn = new Simulation({ gateCount: BANK_GATE_COUNT, idOffset: BANK_GATE_COUNT, mode: "quentra" });

  // Two run modes per bank: Demo (in-memory, fast controlled story) vs Canlı
  // (each card read is ONE real /api/access/check query on that bank's route;
  // the turnstile decision IS the query result). Switched by the shared
  // Demo/Canlı toggle below.
  const demoSources = [new InMemoryFactoryAccessDataSource(), new InMemoryFactoryAccessDataSource()];
  const liveSources = [new ApiFactoryAccessDataSource("direct"), new ApiFactoryAccessDataSource("quentra")];
  const setLiveMode = (isLive) => {
    simBase.setDataSource(isLive ? liveSources[0] : demoSources[0], isLive);
    simQn.setDataSource(isLive ? liveSources[1] : demoSources[1], isLive);
  };
  setLiveMode(false);

  const renBase = new Renderer(canvasBase, { world: simBase.world, banner: "BASELINE  ·  SLOW QUERY" });
  const renQn = new Renderer(canvasQn, { world: simQn.world, banner: "QUENTRA  ·  REWRITTEN" });

  const engine = new Engine([
    { sim: simBase, renderer: renBase },
    { sim: simQn, renderer: renQn },
  ]);
  const ui = new UI(engine);

  // Route throttled DOM updates through the UI layer.
  engine.onFrame = (dt) => ui.tick(dt);

  // The canvases are sized by the grid AFTER boot (intro overlay, font load,
  // panel layout) — re-fit the camera whenever their box actually changes so
  // the floors never render letterboxed into a stale rectangle.
  const ro = new ResizeObserver(() => {
    for (const v of engine.views) v.renderer.resize();
  });
  ro.observe(canvasBase.parentElement);
  ro.observe(canvasQn.parentElement);

  engine.start();

  // ---- cinematic story mode ----------------------------------------------
  setupStory(engine);

  // The story must play over RUNNING floors (by the time the camera reaches
  // them, the baseline queue has already built up) — start the shift quietly
  // with the current worker-count input, never via the overlay.
  const startStory = () => {
    if (tour.active) return;
    ui.ensureShiftRunning();
    preloadNarration();
    tour.start();
  };
  const btnStory = document.getElementById("btnStory");
  if (btnStory) btnStory.addEventListener("click", startStory);
  // When the story camera settles, re-render both floors at the zoomed
  // resolution (and back at 1x when the tour releases the camera).
  window.addEventListener("quentra:storycam", () => {
    for (const v of engine.views) v.renderer.resize();
  });

  // Scenario popup over the already-animating demo; the tour only takes over
  // if the presenter opts in.
  tour.intro(() => ({
    eyebrow: t("tour.intro.eyebrow"),
    title: t("tour.intro.title"),
    paragraphs: [t("tour.intro.p1"), t("tour.intro.p2"), t("tour.intro.p3")],
    start: t("tour.intro.start"),
    skip: t("tour.intro.skip"),
  })).then((go) => { if (go) startStory(); });

  // Exposed for the Demo/Canlı toggle wiring below + console debugging.
  window.__factory = { simBase, simQn, engine, ui, setLiveMode };
}

initQuentraApp({
  appId: "factory-turnstile",
  accent: "#f5b301",
  accent2: "#3a4252",
  brand: { name: "Quentra Factory Access", sub: "Turnstile Control", logo: "/assets/quentra-logo.jpeg" },
  intro: FACTORY_TURNSTILE_INTRO,
  dict: FACTORY_TURNSTILE_DICT,
  onReady: () => {
    boot();
    // The Demo/Canlı toggle drives BOTH the summary card and the floors' data
    // source, so "Canlı" means the turnstiles themselves run real queries.
    initAccessLive("factory-turnstile-simulation", "#6d5efc", {
      onToggle: (isLive) => window.__factory && window.__factory.setLiveMode(isLive),
    });
  },
});
