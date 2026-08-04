// main.js — Hospital Shield. Nothing simulated, nothing automatic: the user
// edits the SQL and presses Yürüt; the statement is executed for real on the
// direct connection and then, unchanged, through the Quentra gateway. Every
// number and every cell on screen comes from those two executions.

import { initQuentraApp, QuentraI18n } from "/shared/quentra-i18n.js";
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
  window.addEventListener("quentra:langchange", paint);

  pollState();
  setInterval(pollState, 4000);
  paint();
}

// ---- execute: the user's SQL, both routes, real rows ----

async function runQuery() {
  if (busy) return;
  busy = true;
  win.setBusy(true);
  const sql = win.getQuery();

  win.clearResults();
  win.execFlash();
  win.setIdentity("destek", "direct");
  win.setStatus(t("sw.stExecuting"), { tone: "run", rows: 0 });
  hideBadges();

  // The packet leaves as the request goes out; the result packet only comes
  // back once the server actually answered.
  const outbound = strip.sendQuery("direct");
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

  if (!res || res.error) {
    win.setStatus(res && res.error ? res.error : t("sw.stNoLive"), { tone: "warn", rows: 0 });
    strip.setRoute(null);
    finish();
    return;
  }

  lastResult = res;
  gatewayUp = res.gatewayUp;
  const direct = res.directRows || [];
  const quentra = res.quentraRows || [];
  const masked = !!res.masked;

  // 1) direct result lands
  await strip.returnResult("direct");
  win.fillGrid("direct", { columns: res.columns, rows: direct }, {
    compareTo: quentra, tone: masked ? "open" : "plain", meta: fmtMs(res.directMs),
  });
  win.setStatus(masked ? t("sw.stDoneOpen") : t("sw.stDone"),
    { tone: masked ? "open" : "idle", rows: direct.length });

  // 2) the IDENTICAL statement through Quentra
  win.setIdentity("destek", "quentra");
  win.flashQueryUnchanged();
  win.setStatus(t("sw.stExecuting"), { tone: "run" });
  await strip.sendQuery("quentra");
  await strip.returnResult("quentra", { masked });
  win.fillGrid("quentra", { columns: res.columns, rows: quentra }, {
    compareTo: direct, tone: masked ? "masked" : "plain", meta: fmtMs(res.quentraMs),
  });
  win.setStatus(masked ? t("sw.stDoneMasked") : t("sw.stDoneNoRule"),
    { tone: masked ? "masked" : "warn", rows: quentra.length });
  win.highlightSet("quentra", "teal");
  strip.setRoute(null);

  showBadges(res);
  history.unshift({
    rows: direct.length,
    masked,
    directMs: res.directMs,
    quentraMs: res.quentraMs,
    sql: firstLine(sql),
  });
  history = history.slice(0, 8);
  finish();
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
  const pill = $("statusPill");
  const label = $("statusLabel");
  pill.dataset.state = dbUp ? "live" : "idle";
  label.textContent = dbUp ? t("status.live") : t("status.offline");
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
