// main.js — AI Guard. Nothing here is scripted: the page asks the server to run
// a real assistant turn and then renders exactly what came back. The animation
// sequences around the measured stages; it never invents one.

import { initQuentraApp, QuentraI18n } from "/shared/quentra-i18n.js";
import { StoryTour } from "/shared/story-tour.js";
import { claimWorkload } from "/shared/workload-control.js";
import { AIGUARD_INTRO, AIGUARD_DICT } from "./i18n.js";
import { Scene } from "./scene.js";
import {
  renderKPIs, renderContext, renderTickets, renderAction,
  renderFeed, renderProvenance, renderAttackLens, pushChat,
} from "./render.js";

const $ = (id) => document.getElementById(id);
const t = (key, fb) => QuentraI18n.t(key, fb);

const WORKLOAD_ID = "ai-guard-simulation";

let scene = null;
let claim = null;
let state = { mode: "quentra", provisioned: false, gatewayUp: false, llmLive: false };
let lastAsk = null;
let busy = false;
let tour = null;
let storyState = {
  phase: 0, tone: "idle", kicker: "story.idle.kicker",
  title: "story.idle.title", text: "story.idle.text", vars: {},
};

initQuentraApp({
  appId: "aiguard",
  accent: "#6d5efc",
  accent2: "#0ea5e9",
  brand: { name: "Quentra", sub: "AI Guard", logo: "/assets/quentra-logo.png" },
  intro: AIGUARD_INTRO,
  dict: AIGUARD_DICT,
  onReady: boot,
});

function boot() {
  scene = new Scene($("stageSvg"), t);
  claim = claimWorkload(WORKLOAD_ID);

  $("btnAsk").addEventListener("click", () => ask($("askInput").value));
  $("askInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") ask($("askInput").value);
  });
  $("askChips").addEventListener("click", (e) => {
    const chip = e.target.closest(".ag-chip");
    if (chip) ask(chip.dataset.q);
  });
  $("modeBar").addEventListener("click", (e) => {
    const btn = e.target.closest(".ag-mode");
    if (btn) setMode(btn.dataset.mode);
  });
  $("btnTour").addEventListener("click", startTour);
  window.addEventListener("quentra:langchange", paint);

  setupTour();
  resetStory();
  pollState();
  setInterval(pollState, 4000);
}

// ------------------------------------------------------------------ mode ---

async function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  lastAsk = null;
  scene.setHijacked(false);
  scene.setSafe(false);
  paintModeBar();
  resetStory();
  try {
    await fetch("/api/aiguard/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  } catch { /* the next poll reports the truth */ }
  scene.setRoute(mode === "quentra" ? "quentra" : "direct");
  pollState();
}

function paintModeBar() {
  document.querySelectorAll(".ag-mode").forEach((b) =>
    b.classList.toggle("is-on", b.dataset.mode === state.mode));
}

// ------------------------------------------------------------- the turn ---

async function ask(question) {
  const q = String(question || "").trim();
  if (!q || busy) return;
  busy = true;
  lastAsk = null;
  $("btnAsk").disabled = true;
  $("askInput").value = "";
  hideBadges();
  scene.setHijacked(false);
  scene.setSafe(false);
  renderContext([], "none", t, { retrievalKind: "pending" });
  renderAttackLens([], "none", t, false);

  pushChat("user", q, { label: t("chat.you") });
  const pending = pushChat("ai", t("chat.thinking"), { label: t("chat.ai") });

  const route = state.mode === "quentra" ? "quentra" : "direct";
  showStory(1, "idle", "story.ask.kicker", "story.ask.title", "story.ask.text");
  await scene.ask();
  showStory(2, "idle", "story.query.kicker", "story.query.title", "story.query.text");
  const outbound = scene.sendQuery(route);

  let res = null;
  try {
    const r = await fetch("/api/aiguard/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    });
    res = await r.json();
  } catch {
    res = { error: t("err.offline") };
  }
  await outbound;

  if (!res || res.error) {
    pending.querySelector(".bubble").textContent = (res && res.error) || t("err.offline");
    pending.classList.add("leaked");
    showStory(0, "danger", "story.error.kicker", "story.error.title", "story.error.text");
    finish();
    return;
  }

  lastAsk = res;
  const cleaned = res.quarantineSource === "gateway" || res.quarantineSource === "simulated";

  if (res.poisonedRows > 0) {
    showStory(3, "danger", "story.rows.kicker", "story.rows.title", "story.rows.text", { n: res.poisonedRows });
  } else if (res.retrievedRows > 0) {
    showStory(3, "idle", "story.rows.clean.kicker", "story.rows.clean.title", "story.rows.clean.text", { n: res.retrievedRows });
  } else {
    showStory(3, "idle", "story.rows.none.kicker", "story.rows.none.title", "story.rows.none.text");
  }

  // Stage 2 lands: the rows come back, and the transform (if any) happens as
  // the packet crosses the shield.
  await scene.returnRows({
    poisoned: res.poisonedRows > 0,
    cleaned: cleaned && res.poisonedRows > 0,
    count: res.retrievedRows,
    onClean: () => showStory(3, "safe", "story.catch.kicker", "story.catch.title", "story.catch.text", {
      n: res.poisonedRows,
    }),
  });

  renderContext(res.findings, res.quarantineSource, t, res);
  renderTickets(res.findings, t, res);
  renderAttackLens(res.findings, res.quarantineSource, t, true);

  // Stage 3/4: the model answered; if it produced an action, send it at the gate.
  const answer = (res.assistant && res.assistant.answer) || "—";
  scene.setHijacked(res.hijacked);
  scene.setSafe(res.neutralized);

  if (res.hijacked) {
    showStory(4, "danger", "story.model.bad.kicker", "story.model.bad.title", "story.model.bad.text");
  } else if (res.neutralized) {
    showStory(4, "safe", "story.model.safe.kicker", "story.model.safe.title", "story.model.safe.text");
  } else {
    showStory(4, "idle", "story.model.clean.kicker", "story.model.clean.title", "story.model.clean.text");
  }

  if (res.assistant && res.assistant.followupSql) {
    await scene.sendAction({
      blocked: res.blocked,
      hostile: res.hijacked,
      onGate: () => showStory(5, res.blocked ? "safe" : (res.hijacked ? "danger" : "idle"), "story.gate.kicker", "story.gate.title", "story.gate.text"),
    });
  }

  const bubble = pending.querySelector(".bubble");
  bubble.textContent = answer;
  pending.classList.remove("leaked", "safe");
  if (res.hijacked && !res.blocked) pending.classList.add("leaked");
  else if (res.poisonedRows > 0 && res.blocked) pending.classList.add("safe");

  const tail = pending.querySelector(".tail") || document.createElement("span");
  tail.className = "tail";
  tail.textContent = `${res.assistant.source === "openai" ? t("llm.real") : t("llm.modeled")}` +
    ` · ${res.totalMs} ms`;
  pending.appendChild(tail);

  renderAction(res, t);
  showBadges(res);
  showOutcome(res);
  scene.setRoute(null);
  finish();
}

function finish() {
  busy = false;
  $("btnAsk").disabled = false;
  pollState();
}

// ---------------------------------------------------------------- badges ---

function hideBadges() {
  $("leakBadge").hidden = true;
  $("safeBadge").hidden = true;
}

// Badges report the measured outcome of the turn. A hijack that leaked nothing
// does not get a "leak" badge, and a turn with no attack does not get a "saved"
// badge — neither would be true.
function showBadges(res) {
  hideBadges();
  if (res.leakedRecords > 0) {
    $("leakBadge").hidden = false;
    $("leakBadgeSub").textContent = `${Number(res.leakedRecords).toLocaleString("tr-TR")} ${t("act.leaked")}`;
    return;
  }
  if (res.blocked) {
    $("safeBadge").hidden = false;
    $("safeBadgeSub").textContent = res.preventedRecords > 0
      ? `${Number(res.preventedRecords).toLocaleString("tr-TR")} ${t("act.prevented")}`
      : (res.action && res.action.rule) || "";
    return;
  }
  // A layer-1 save leaves nothing to block, so without this the primary
  // defense would render as an uneventful turn.
  if (res.neutralized) {
    $("safeBadge").hidden = false;
    $("safeBadgeSub").textContent = `${res.poisonedRows} ${t("act.neutralized")}`;
  }
}

// --------------------------------------------------------- live story ---

function fmt(key, vars = {}) {
  return Object.entries(vars).reduce(
    (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
    t(key),
  );
}

function showStory(phase, tone, kicker, title, text, vars = {}) {
  storyState = { phase, tone, kicker, title, text, vars };
  renderStory();
}

function renderStory() {
  const s = storyState;
  $("storyConsole").dataset.tone = s.tone;
  $("storyKicker").textContent = fmt(s.kicker, s.vars);
  $("storyTitle").textContent = fmt(s.title, s.vars);
  $("storyText").textContent = fmt(s.text, s.vars);
  document.querySelectorAll("#storySteps li").forEach((item) => {
    const phase = Number(item.dataset.phase);
    item.classList.toggle("is-active", phase === s.phase);
    item.classList.toggle("is-done", phase < s.phase);
  });
}

function resetStory() {
  const off = state.mode === "baseline";
  showStory(0, off ? "danger" : "idle", "story.idle.kicker",
    off ? "story.idle.off.title" : "story.idle.title",
    off ? "story.idle.off.text" : "story.idle.text");
}

function showOutcome(res) {
  if (res.leakedRecords > 0) {
    showStory(5, "danger", "story.outcome.leak.kicker", "story.outcome.leak.title", "story.outcome.leak.text", { n: res.leakedRecords });
  } else if (res.blocked) {
    showStory(5, "safe", "story.outcome.block.kicker", "story.outcome.block.title", "story.outcome.block.text", { n: res.preventedRecords });
  } else if (res.neutralized) {
    showStory(5, "safe", "story.outcome.neutral.kicker", "story.outcome.neutral.title", "story.outcome.neutral.text", { n: res.poisonedRows });
  } else {
    showStory(5, "idle", "story.outcome.clean.kicker", "story.outcome.clean.title", "story.outcome.clean.text");
  }
}

// ------------------------------------------------------------ state poll ---

async function pollState() {
  try {
    const r = await fetch("/api/aiguard/state", { cache: "no-store" });
    if (!r.ok) throw new Error();
    const s = await r.json();
    state = { ...s };

    // Provisioning runs in the background at boot, so the first claim can land
    // before the database exists. Retry once it is ready rather than leaving
    // the page with an idle workload.
    if (s.provisioned && !s.running && claim) claim.start();
  } catch {
    state.provisioned = false;
  }
  paint();
}

function paint() {
  const live = !!state.provisioned;
  $("statusPill").dataset.state = live ? "live" : "idle";
  $("statusLabel").textContent = live ? t("status.live") : t("status.offline");

  paintModeBar();
  renderKPIs(state, t);
  renderFeed(state.recent, t);
  renderProvenance(state, lastAsk, t);
  renderAction(lastAsk, t);
  renderStory();

  // Between turns the ambient worker keeps the row panels fresh.
  const ticketFindings = (lastAsk && lastAsk.findings) || state.findings;
  renderTickets(ticketFindings, t, lastAsk);

  // Ambient SQL keeps the database panel live, but it is NOT model context.
  // Only rows retrieved for an explicit employee question belong in the
  // center panel or the attack lens.
  const contextFindings = lastAsk ? lastAsk.findings : [];
  const contextSource = lastAsk ? lastAsk.quarantineSource : "none";
  const retrieval = lastAsk || (busy ? { retrievalKind: "pending" } : null);
  renderContext(contextFindings, contextSource, t, retrieval);
  renderAttackLens(contextFindings, contextSource, t, !!lastAsk);

  $("chatMeta").textContent = state.llmLive
    ? `${t("llm.real")} · ${state.llmModel}`
    : t("llm.modeled");
}

// ------------------------------------------------------------------ tour ---

function setupTour() {
  tour = new StoryTour({
    root: ".app",
    steps: [
      { target: null, key: "tour.s1" },
      { target: "#anchorEmployee", key: "tour.s2", zoom: 1.9 },
      { target: "#anchorDb", key: "tour.s3", zoom: 1.9 },
      { target: "#anchorGate", key: "tour.s4", zoom: 2.0 },
      { target: "#ctxPanel", key: "tour.s5", zoom: 1.45 },
      { target: "#actionPanel", key: "tour.s6", zoom: 1.55 },
      { target: "#kpiStrip", key: "tour.s7", zoom: 1.25 },
    ],
    translate: (step) => ({ title: t(step.key + ".t"), text: t(step.key + ".x") }),
    labels: () => ({ back: t("tour.back"), next: t("tour.next"), done: t("tour.done") }),
  });

  tour.intro(() => ({
    eyebrow: t("tour.intro.eyebrow"),
    title: t("tour.intro.title"),
    paragraphs: [t("tour.intro.p1"), t("tour.intro.p2"), t("tour.intro.p3")],
    start: t("tour.intro.start"),
    skip: t("tour.intro.skip"),
  })).then((go) => { if (go) tour.start(); });
}

function startTour() {
  if (tour && !tour.active) tour.start();
}
