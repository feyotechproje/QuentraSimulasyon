// main.js — boots the Hospital Shield demo: intro overlay + i18n, the slim
// topology strip, the SSMS-style SQL window, the scripted "video" story, the
// interactive Yürüt flow (same query down both routes) and the Demo/Canlı
// bridge to the real HOSPITALSIM workload.

import { initQuentraApp, QuentraI18n } from "/shared/quentra-i18n.js";
import { LiveController, startWorkload } from "/shared/live-workload.js";
import { HOSPITAL_INTRO, HOSPITAL_DICT } from "./i18n.js";
import { demoWindow, maskRow, MASKED_FIELDS, PATIENT_SQL } from "./data.js";
import { Scene } from "./scene.js";
import { SqlWin } from "./sqlwin.js";
import { Story } from "./story.js";
import { renderAll } from "./render.js";

const $ = (id) => document.getElementById(id);
const t = (key, fb) => QuentraI18n.t(key, fb);

let strip, win, story, live;
let currentRole = "quentra";
let currentState = null;
let isLive = false;
let demoTimer = null;
let demoIdx = 0;
let execBusy = false;
let lastRestartPost = 0;

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
  strip.setRole(currentRole);
  strip.setMasked(true);
  win = new SqlWin(t);
  win.reset();

  story = new Story({
    win,
    strip,
    t,
    rows: storyRows,
    msg: setMessage,
    onRole: (role) => applyRole(role, { fromStory: true }),
    els: {
      btnPlay: $("btnPlay"),
      icPlay: $("icPlay"),
      icPause: $("icPause"),
      btnReplay: $("btnReplay"),
      track: $("plTrack"),
      progress: $("plProgress"),
      chips: Array.from(document.querySelectorAll(".pl-chip")),
      caption: $("captionText"),
    },
  });

  // The user pulls the query themselves: one press runs it on BOTH routes.
  $("btnExecute").addEventListener("click", () => {
    story.interrupt();
    runExecute();
  });

  // No Demo/Canlı switch: the page starts in demo visuals and silently
  // upgrades itself to live data as soon as the real workload responds. The
  // pill is the single source of truth: DEMO MODU until then, CANLI VERİ after.
  live = new LiveController({
    sim: "hospital",
    workloadId: "hospital-masking-simulation",
    intervalMs: 1500,
    onState: onLiveState,
    onError: () => {},
  });
  live.enable();
  window.addEventListener("pagehide", () => live.disable());

  window.addEventListener("quentra:langchange", () => {
    if (currentState) renderAll(currentState, currentRole, t);
  });

  startDemo();
  story.play();
}

// ---- the data the SQL window renders ----
// Demo: fictional page + client-side masks (labeled Demo). Live: verbatim rows
// from the two real routes — grid 2 is only "masked" if the gateway masked it.
function storyRows() {
  if (isLive && currentState && (currentState.directRows || []).length) {
    const s = currentState;
    return {
      open: s.directRows || [],
      maskedRows: s.quentraRows || [],
      masked: !!s.masked,
      maskedFields: s.maskedFields || [],
      demo: false,
      ms: s.quentraMs ? s.quentraMs + " ms" : "",
    };
  }
  const open = demoWindow(demoIdx);
  return {
    open,
    maskedRows: open.map(maskRow),
    masked: true,
    maskedFields: MASKED_FIELDS,
    demo: true,
    ms: "",
  };
}

// ---- interactive execute: same query, both routes, two result sets ----

function runExecute() {
  if (execBusy) return;
  execBusy = true;
  const r = storyRows();
  const user = currentRole === "dba" ? "dba" : "destek";

  win.setQuery(PATIENT_SQL);
  win.showCaret(false);
  win.clearResults();
  win.execFlash();
  win.setIdentity(user, "direct");
  win.setStatus(t("sw.stExecuting"), { tone: "run" });
  strip.spawnRoute("direct", { dba: currentRole === "dba" });

  setTimeout(() => {
    const tone = currentRole === "dba" ? "dba" : "open";
    win.fillGrid("direct", r.open, { tone, revealP: 1, meta: r.demo ? "" : r.ms });
    win.setStatus(currentRole === "dba" ? t("sw.stDoneDba") : t("sw.stDoneOpen"),
      { tone: currentRole === "dba" ? "dba" : "open", rows: r.open.length });

    // leg 2: the identical query through Quentra
    win.setIdentity(user, "quentra");
    win.flashQueryUnchanged();
    win.setStatus(t("sw.stExecuting"), { tone: "run" });
    strip.spawnRoute("quentra", { masked: r.masked });

    setTimeout(() => {
      win.fillGrid("quentra", r.maskedRows, {
        tone: r.masked ? "masked" : "plain",
        maskedFields: r.maskedFields,
        revealP: 1,
        meta: r.demo ? "" : r.ms,
      });
      win.setStatus(r.masked ? t("sw.stDoneMasked") : t("sw.stDoneNoRule"),
        { tone: r.masked ? "masked" : "warn", rows: r.maskedRows.length });
      win.highlightSet("quentra", "teal");
      execBusy = false;
    }, 2400);
  }, 2400);
}

// ---- role handling (driven by the story scenes / player chips) ----

function applyRole(role, opts = {}) {
  currentRole = role;
  strip.setRole(role);
  if (isLive) live.setMode(role);
  if (currentState) renderAll(currentState, currentRole, t);
}

// ---- demo mode: dramatized, clearly labeled ----

function startDemo() {
  stopDemo();
  advanceDemo();
  demoTimer = setInterval(advanceDemo, 2800);
  setPill("demo");
}

function stopDemo() {
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
}

// Demo state only feeds the story grids and the static SQL panel; the live
// feed stays empty so demo people never masquerade as real traffic.
function advanceDemo() {
  if (isLive) return;
  demoIdx = (demoIdx + 5) % 8;
  const open = demoWindow(demoIdx);
  currentState = {
    demo: true,
    provisioned: true,
    masked: true,
    maskedFields: MASKED_FIELDS,
    directRows: open,
    quentraRows: open.map(maskRow),
    directSql: PATIENT_SQL,
    quentraSql: PATIENT_SQL,
    recent: [],
    gatewayUp: null,
  };
  strip.setMasked(true);
  renderAll(currentState, currentRole, t);
}

// ---- live mode: verbatim backend state, adopted automatically ----

function onLiveState(s) {
  // If the server was restarted while the page is open, the workload comes
  // back idle: kick it again (throttled) instead of showing a dead live view.
  if (s && s.provisioned && !s.running && Date.now() - lastRestartPost > 5000) {
    lastRestartPost = Date.now();
    startWorkload("hospital-masking-simulation");
  }

  const usable = s && s.provisioned && s.running && (s.directRows || []).length;
  if (!isLive) {
    if (!usable) return; // stay on demo visuals until real data flows
    isLive = true;
    stopDemo();
    setPill("live");
    live.setMode(currentRole);
  }
  if (!usable) return; // keep the last good live frame during a restart gap
  currentState = s;
  strip.setMasked(!!s.masked);
  // Real traffic on the strip: each poll of a running workload is an actual
  // pair of lookups that just happened on both routes.
  if (!story.playing && !execBusy) {
    strip.spawnRoute("direct");
    setTimeout(() => strip.spawnRoute("quentra", { masked: !!s.masked }), 500);
  }
  renderAll(s, currentRole, t);
}

// ---- message overlay + status pill ----

function setMessage(show, l1 = "", l2 = "") {
  const ovl = $("msgOverlay");
  ovl.hidden = !show;
  if (show) {
    $("msgLine1").innerHTML = l1;
    $("msgLine2").innerHTML = l2;
  }
}

// Two states only, so there is never any doubt about what the page shows:
// amber DEMO MODU or green CANLI VERİ.
function setPill(state) {
  const pill = $("statusPill");
  const label = $("statusLabel");
  if (state === "live") {
    pill.dataset.state = "live";
    label.textContent = t("status.live");
  } else {
    pill.dataset.state = "idle";
    label.textContent = t("status.demo");
  }
}
