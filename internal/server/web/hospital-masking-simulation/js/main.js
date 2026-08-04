// main.js — boots the Hospital Shield demo. Nothing runs by itself: the film
// starts only from the ▶ button, and queries run only when the user presses
// Yürüt — which sends the editor's SQL to the backend and executes it for real
// on both routes (direct + Quentra). The page merely POLLS state (read-only)
// to know whether the live database is reachable.

import { initQuentraApp, QuentraI18n } from "/shared/quentra-i18n.js";
import { HOSPITAL_INTRO, HOSPITAL_DICT } from "./i18n.js";
import { demoWindow, maskRow, PATIENT_SQL } from "./data.js";
import { Scene } from "./scene.js";
import { SqlWin } from "./sqlwin.js";
import { Story } from "./story.js";
import { renderAll } from "./render.js";

const $ = (id) => document.getElementById(id);
const t = (key, fb) => QuentraI18n.t(key, fb);

const GRID_COLS = ["HASTA_ID", "AD", "SOYAD", "TCKN", "TELEFON", "KAN_GRUBU", "ADRES", "TANI"];
const rowToArr = (r) => [String(r.id), r.ad, r.soyad, r.tckn, r.telefon, r.kanGrubu, r.adres, r.tani];

let strip, win, story;
let currentRole = "quentra";
let backendUp = false;
let backendState = null;
let demoState = null;
let demoIdx = 0;
let execBusy = false;

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
  win.idle(PATIENT_SQL); // query prefilled, editable, nothing running

  story = new Story({
    win,
    strip,
    t,
    rows: storyRows,
    msg: setMessage,
    onRole: applyRole,
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

  // The user pulls the query themselves: one press runs THEIR SQL on both routes.
  $("btnExecute").addEventListener("click", () => {
    story.interrupt();
    runExecute();
  });

  window.addEventListener("quentra:langchange", renderPanels);

  buildDemoState();
  setInterval(() => { demoIdx = (demoIdx + 5) % 8; buildDemoState(); }, 2800);
  pollState();
  setInterval(pollState, 2000);
}

// ---- the film's data: always the fictional demo set, clearly a dramatization ----

function storyRows() {
  const open = demoWindow(demoIdx);
  return {
    columns: GRID_COLS,
    open: open.map(rowToArr),
    maskedRows: open.map((p) => rowToArr(maskRow(p))),
    masked: true,
    demo: true,
    ms: "",
  };
}

function buildDemoState() {
  demoState = {
    demo: true,
    provisioned: true,
    masked: true,
    directSql: PATIENT_SQL,
    quentraSql: PATIENT_SQL,
    recent: [],
    gatewayUp: null,
  };
  if (!backendUp) renderPanels();
}

// ---- interactive execute: the editor's SQL, really run on both routes ----

async function runExecute() {
  if (execBusy) return;
  execBusy = true;
  const sqlText = win.getQuery();

  win.clearResults();
  win.execFlash();
  win.setIdentity("destek", "direct");
  win.setStatus(t("sw.stExecuting"), { tone: "run" });
  strip.spawnRoute("direct");

  if (backendUp) {
    let res = null;
    try {
      const r = await fetch("/api/hospital/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: sqlText }),
      });
      res = await r.json();
    } catch { /* treated as error below */ }

    if (!res || res.error) {
      win.setStatus(res && res.error ? res.error : t("sw.stNoLive"), { tone: "warn", rows: 0 });
      execBusy = false;
      return;
    }
    showResultPair({
      columns: res.columns || [],
      open: res.directRows || [],
      maskedRows: res.quentraRows || [],
      masked: !!res.masked,
      directMs: res.directMs,
      quentraMs: res.quentraMs,
    });
    return;
  }

  // No live backend: only the canonical demo query can be dramatized.
  if (normalizeSQL(sqlText) === normalizeSQL(PATIENT_SQL)) {
    const r = storyRows();
    showResultPair({ columns: r.columns, open: r.open, maskedRows: r.maskedRows, masked: true });
  } else {
    win.setStatus(t("sw.stNoLive"), { tone: "warn", rows: 0 });
    execBusy = false;
  }
}

// Sequenced reveal: direct result lands first, then the identical query goes
// through Quentra and the second result set arrives.
function showResultPair(d) {
  setTimeout(() => {
    win.fillGrid("direct", { columns: d.columns, rows: d.open }, {
      compareTo: d.maskedRows, tone: d.masked ? "open" : "plain",
      revealP: 1, meta: d.directMs != null ? d.directMs + " ms" : "",
    });
    win.setStatus(d.masked ? t("sw.stDoneOpen") : t("sw.stDone"),
      { tone: d.masked ? "open" : "idle", rows: d.open.length });

    win.setIdentity("destek", "quentra");
    win.flashQueryUnchanged();
    win.setStatus(t("sw.stExecuting"), { tone: "run" });
    strip.spawnRoute("quentra", { masked: d.masked });

    setTimeout(() => {
      win.fillGrid("quentra", { columns: d.columns, rows: d.maskedRows }, {
        compareTo: d.open, tone: d.masked ? "masked" : "plain",
        revealP: 1, meta: d.quentraMs != null ? d.quentraMs + " ms" : "",
      });
      win.setStatus(d.masked ? t("sw.stDoneMasked") : t("sw.stDoneNoRule"),
        { tone: d.masked ? "masked" : "warn", rows: d.maskedRows.length });
      win.highlightSet("quentra", "teal");
      execBusy = false;
    }, 2400);
  }, 1300);
}

function normalizeSQL(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
}

// ---- read-only state poll: tells the page whether the live DB is reachable ----

async function pollState() {
  try {
    const r = await fetch("/api/hospital/state", { cache: "no-store" });
    if (!r.ok) throw new Error();
    backendState = await r.json();
    backendUp = !!backendState.provisioned;
  } catch {
    backendState = null;
    backendUp = false;
  }
  setPill(backendUp ? "live" : "demo");
  // Background worker traffic (started from the portal) shows on the strip.
  if (backendState && backendState.running && !story.playing && !execBusy) {
    strip.spawnRoute("direct");
    setTimeout(() => strip.spawnRoute("quentra", { masked: !!backendState.masked }), 500);
  }
  renderPanels();
}

function renderPanels() {
  const st = backendUp ? backendState : demoState;
  if (st) renderAll(st, currentRole, t, story ? story.playing : false);
}

// ---- role (only the film changes it) ----

function applyRole(role) {
  currentRole = role;
  strip.setRole(role);
  renderPanels();
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
