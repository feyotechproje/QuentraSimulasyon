// main.js — Hospital Shield. Nothing simulated, nothing automatic: the user
// edits the SQL and presses Yürüt; the statement is executed for real on the
// direct connection and then, unchanged, through the Quentra gateway. Every
// number and every cell on screen comes from those two executions.

import { initQuentraApp, QuentraI18n } from "/shared/quentra-i18n.js";
import { StoryTour } from "/shared/story-tour.js";
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
  cache: new Map(), // "<lang>|<text>" -> Promise<objectURL>

  // Narration is ALWAYS Turkish (user's call) — the UI language only affects
  // the written captions. Voice text is therefore pulled from the TR dict.
  lang() { return "tr"; },

  fetchClip(text) {
    const k = this.lang() + "|" + text;
    if (!this.cache.has(k)) {
      const p = fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, lang: this.lang() }),
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

  async play(text) {
    const my = ++this.seq;
    this.paused = false; // navigating (manual or auto) resumes the flow
    if (this.audio) { this.audio.pause(); this.audio.currentTime = 0; }
    if (!text) return;
    try {
      const url = await this.fetchClip(text);
      if (my !== this.seq) return; // the story already moved on
      if (!this.audio) this.audio = new Audio();
      this.audio.onended = () => {
        if (my === this.seq && !this.paused && this.autoNext) this.autoNext();
      };
      this.audio.src = url;
      this.audio.play().catch(() => {});
    } catch { /* no key / offline: silent story, manual advance */ }
  },

  // Duraklat/Devam: freezes the voice AND the auto-advance together.
  togglePause() {
    if (this.paused) {
      this.paused = false;
      if (this.audio && this.audio.src) {
        // Clip already over while paused → continue the flow now.
        if (this.audio.ended) { if (this.autoNext) this.autoNext(); }
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
    if (this.audio) { this.audio.pause(); this.audio.currentTime = 0; }
  },
};

let preloadNarration = () => {};

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
    steps: [
      { img: "img/01-hastane.jpg", key: "tour.s1" },
      { img: "img/02-ariza.jpg", key: "tour.s2" },
      { img: "img/03-destek.jpg", key: "tour.s3" },
      { img: "img/04-vpn.jpg", key: "tour.s4" },
      { target: "#sqlwin", key: "tour.s5", zoom: 1.35, onEnter: storyRun },
      { target: "#rsDirect", key: "tour.s6", zoom: 1.7 },
      { img: "img/05-quentra.jpg", key: "tour.s7", onEnter: storyReveal },
      { img: "img/07-sentinel.png", key: "tour.hero", cineClass: "st-cine-hero" },
      { target: "#rsQuentra", key: "tour.s8", zoom: 1.7, onEnter: storyReveal },
      { target: "#sqlPanel", key: "tour.s9", zoom: 1.45 },
      { img: "img/06-final.jpg", key: "tour.s10" },
    ],
    translate: (step) => ({ title: t(step.key + ".t"), text: t(step.key + ".x") }),
    labels: () => ({
      back: t("tour.back"), next: t("tour.next"), done: t("tour.done"),
      pause: t("tour.pause"), resume: t("tour.resume"),
    }),
    onStep: (step) => narrator.play(narrationText(step)),
    onDone: () => { narrator.stop(); storyReveal(); },
    pauseControl: {
      isPaused: () => narrator.paused,
      toggle: () => narrator.togglePause(),
    },
  });

  narrator.autoNext = () => { if (tour && tour.active) tour.next(); };
  preloadNarration = () => narrator.preload(tour.steps.map(narrationText));

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
