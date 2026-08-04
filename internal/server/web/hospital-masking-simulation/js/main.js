// main.js — boots the Hospital Shield demo: intro overlay + i18n, the SVG
// scene, the scripted "video" story, role switching and the Demo/Canlı bridge
// to the real HOSPITALSIM workload.

import { initQuentraApp, QuentraI18n } from "/shared/quentra-i18n.js";
import { LiveController, mountLiveToggle } from "/shared/live-workload.js";
import { HOSPITAL_INTRO, HOSPITAL_DICT } from "./i18n.js";
import { DEMO_PATIENTS, maskRow, MASKED_FIELDS, PATIENT_SQL } from "./data.js";
import { Scene } from "./scene.js";
import { Story } from "./story.js";
import { renderAll } from "./render.js";

const $ = (id) => document.getElementById(id);
const t = (key, fb) => QuentraI18n.t(key, fb);

let scene, story, live;
let currentRole = "quentra";
let currentState = null;
let isLive = false;
let demoTimer = null;
let demoIdx = 0;
let demoFeed = [];

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
  scene = new Scene($("stageSvg"));
  scene.setRole(currentRole);
  scene.setMasked(true);
  scene.startLoop(2800);

  story = new Story({
    scene,
    t,
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

  // Manual role selection pauses the film and takes over.
  document.querySelectorAll(".role-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      story.interrupt();
      applyRole(btn.dataset.role);
    })
  );

  live = new LiveController({
    sim: "hospital",
    workloadId: "hospital-masking-simulation",
    intervalMs: 1500,
    onState: onLiveState,
    onError: () => setPill("starting"),
  });

  mountLiveToggle($("toolbarRight"), onLiveToggle, { demo: t("lt.demo"), live: t("lt.live") });

  window.addEventListener("quentra:langchange", () => {
    if (currentState) renderAll(currentState, currentRole, t);
  });

  startDemo();
  story.play();
}

// ---- role handling ----

function applyRole(role, opts = {}) {
  currentRole = role;
  document.querySelectorAll(".role-btn").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.role === role)
  );
  scene.setRole(role);
  if (isLive) live.setMode(role);
  if (!opts.fromStory && !isLive) advanceDemo(); // instant feedback on click
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

function advanceDemo() {
  if (isLive) return;
  const p = DEMO_PATIENTS[demoIdx % DEMO_PATIENTS.length];
  demoIdx++;
  const masked = maskRow(p);
  const seen = currentRole === "quentra" ? masked : p;
  demoFeed.unshift({
    id: p.id,
    nameSeen: `${seen.ad} ${seen.soyad}`,
    masked: currentRole === "quentra",
    quentraMs: null,
  });
  demoFeed = demoFeed.slice(0, 8);
  currentState = {
    demo: true,
    provisioned: true,
    masked: true,
    maskedFields: MASKED_FIELDS,
    directRow: p,
    quentraRow: masked,
    directSql: PATIENT_SQL,
    quentraSql: PATIENT_SQL,
    recent: demoFeed,
    gatewayUp: null,
  };
  scene.setMasked(true);
  renderAll(currentState, currentRole, t);
}

// ---- live mode: verbatim backend state ----

function onLiveToggle(liveOn) {
  isLive = liveOn;
  if (liveOn) {
    stopDemo();
    demoFeed = [];
    setPill("starting");
    live.setMode(currentRole);
    live.enable();
  } else {
    live.disable();
    startDemo();
  }
}

function onLiveState(s) {
  if (!isLive) return;
  currentState = s;
  setPill(s.running ? "live" : "starting");
  // The scene only shows the mask where the gateway really applied one.
  scene.setMasked(!!s.masked);
  renderAll(s, currentRole, t);
}

// ---- status pill ----

function setPill(state) {
  const pill = $("statusPill");
  const label = $("statusLabel");
  if (state === "live") {
    pill.dataset.state = "live";
    label.textContent = t("status.live");
  } else if (state === "starting") {
    pill.dataset.state = "idle";
    label.textContent = t("status.starting");
  } else {
    pill.dataset.state = "idle";
    label.textContent = t("status.demo");
  }
}
