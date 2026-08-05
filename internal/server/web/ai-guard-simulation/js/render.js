// render.js — every panel renders only what the server measured. Where a
// number cannot be measured the panel prints the reason instead of a figure.

const $ = (id) => document.getElementById(id);

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const num = (n) => (n == null ? "—" : Number(n).toLocaleString("tr-TR"));
const subst = (s, vars = {}) => Object.entries(vars).reduce(
  (out, [key, value]) => out.replaceAll(`{${key}}`, String(value)), String(s || ""));

// ------------------------------------------------------------------ KPIs ---

export function renderKPIs(s, t) {
  $("kPoisoned").textContent = num(s.poisonedRowsSeen);
  $("kQuarantine").textContent = num(s.quarantinedRows);
  $("kClean").textContent = num(s.cleanRowsPassed);
  $("kHijack").textContent = num(s.hijacks);
  $("kBlocked").textContent = num(s.blockedActions);
  $("kLeak").textContent = num(s.leakedRecords);
  $("kPrevented").textContent = num(s.preventedRecords);

  $("kModel").innerHTML = s.llmLive
    ? `<small>${esc(s.llmModel)}</small>`
    : `<small>${esc(t("llm.modeled"))}</small>`;

  $("kpiHijack").dataset.tone = s.hijacks > 0 ? "warn" : "";
  $("kpiBlocked").dataset.tone = s.blockedActions > 0 ? "good" : "";
  $("kpiLeak").dataset.tone = s.leakedRecords > 0 ? "bad" : "";
  $("kpiPrevented").dataset.tone = s.preventedRecords > 0 ? "good" : "";
}

// -------------------------------------------------- the model's context ---

// splitAtBoundary marks the instruction span. The boundary comes from the
// server's scan, so the highlight is exact on BOTH paths — including the
// unprotected one, where there is no transform to diff against.
function markPayload(text, boundary) {
  const runes = Array.from(String(text || ""));
  if (boundary == null || boundary < 0 || boundary >= runes.length) return esc(text);
  return esc(runes.slice(0, boundary).join("")) +
    `<mark>${esc(runes.slice(boundary).join(""))}</mark>`;
}

function markQuarantine(text, boundary) {
  const runes = Array.from(String(text || ""));
  if (boundary == null || boundary < 0 || boundary >= runes.length) return esc(text);
  return esc(runes.slice(0, boundary).join("")) +
    `<span class="qz">${esc(runes.slice(boundary).join(""))}</span>`;
}

export function renderContext(findings, source, t, retrieval = null) {
  const box = $("ctxDiff");
  const badge = $("ctxBadge");
  const note = $("ctxNote");

  if (retrieval && retrieval.retrievalKind === "pending") {
    note.textContent = t("ctx.note.pending");
    box.innerHTML = `<p class="ag-empty">${esc(t("ctx.pending"))}</p>`;
    badge.textContent = t("ctx.badgePending");
    badge.dataset.tone = "idle";
    return;
  }

  if (retrieval && retrieval.retrievalKind === "none") {
    note.textContent = t("ctx.note.none");
  } else if (retrieval && retrieval.retrievalKind === "topic") {
    note.textContent = subst(t("ctx.note.topic"), { term: retrieval.retrievalTerm || "—", n: retrieval.retrievedRows || 0 });
  } else if (retrieval && retrieval.retrievalKind === "broad") {
    note.textContent = subst(t("ctx.note.broad"), { status: retrieval.retrievalStatus || t("ctx.all"), n: retrieval.retrievedRows || 0 });
  } else {
    note.textContent = t("ctx.note");
  }

  if (!findings || !findings.length) {
    const completed = retrieval && retrieval.retrievalKind && retrieval.retrievalKind !== "pending";
    box.innerHTML = `<p class="ag-empty">${esc(completed ? t("ctx.noMatch") : t("ctx.empty"))}</p>`;
    badge.textContent = completed ? t("ctx.badgeNoContext") : t("ctx.idle");
    badge.dataset.tone = "idle";
    return;
  }

  const hasPoison = findings.some((f) => f.poisoned);
  if (!hasPoison) {
    badge.textContent = t("ctx.badgeClean");
    badge.dataset.tone = "good";
  } else if (source === "gateway") {
    badge.textContent = t("ctx.badgeGateway");
    badge.dataset.tone = "good";
  } else if (source === "simulated") {
    badge.textContent = t("ctx.badgeSim");
    badge.dataset.tone = "warn";
  } else {
    badge.textContent = t("ctx.badgeOff");
    badge.dataset.tone = "bad";
  }

  const protectedRun = source === "gateway" || source === "simulated";

  box.innerHTML = findings.map((f) => {
    const head =
      `<div class="ag-row-head">` +
        `<span class="id">#${esc(f.id)}</span>` +
        `<span class="who">${esc(f.musteri)}</span>` +
        `<span class="konu">${esc(f.konu)}</span>` +
      `</div>`;

    if (!f.poisoned) {
      return `<article class="ag-row clean">${head}` +
        `<div class="ag-side plain"><span class="lbl">${esc(t("ctx.cleanRow"))}</span>` +
        `<div class="txt">${esc(f.after)}</div></div></article>`;
    }

    const signals = (f.signals || []).map((g) =>
      `<span class="ag-sig">${esc(g.label)}</span>`).join("");

    // Unprotected: one panel, payload intact and highlighted.
    if (!protectedRun) {
      return `<article class="ag-row poison">${head}` +
        `<div class="ag-side before"><span class="lbl">${esc(t("ctx.raw"))}</span>` +
        `<div class="txt">${markPayload(f.before, f.boundary)}</div></div>` +
        `<div class="ag-signals">${signals}</div></article>`;
    }

    // Protected: before and after, so the transform is shown, not claimed.
    return `<article class="ag-row poison">${head}` +
      `<div class="ag-side before"><span class="lbl">${esc(t("ctx.before"))}</span>` +
      `<div class="txt">${markPayload(f.before, f.boundary)}</div></div>` +
      `<div class="ag-side after"><span class="lbl">${esc(t("ctx.after"))}</span>` +
      `<div class="txt">${markQuarantine(f.after, f.boundary)}</div></div>` +
      `<div class="ag-signals">${signals}</div></article>`;
  }).join("");
}

// ---------------------------------------------------------- attack lens ---

// The dense context panel is useful for auditing; this strip is for immediate
// comprehension. It picks the first measured poisoned row and makes the attack
// chain literal: the database cell on the left, the gate in the middle, and
// the exact model input on the right.
export function renderAttackLens(findings, source, t, completedTurn = false) {
  const box = $("attackLens");
  const poisoned = (findings || []).find((f) => f.poisoned);

  if (!poisoned) {
    box.dataset.tone = "idle";
    box.innerHTML = `<p class="ag-empty">${esc(t(completedTurn ? "lens.noThreat" : "lens.empty"))}</p>`;
    return;
  }

  const protectedRun = source === "gateway" || source === "simulated";
  const sourceLabel = source === "gateway"
    ? t("lens.gate.measured")
    : (source === "simulated" ? t("lens.gate.simulated") : t("lens.gate.off"));
  const modelText = protectedRun
    ? markQuarantine(poisoned.after, poisoned.boundary)
    : markPayload(poisoned.before, poisoned.boundary);
  const modelLabel = protectedRun ? t("lens.model.safe") : t("lens.model.danger");

  box.dataset.tone = protectedRun ? "safe" : "danger";
  box.innerHTML =
    `<div class="lens-head">` +
      `<span class="lens-eyebrow">${esc(t("lens.title"))} · #${esc(poisoned.id)} · ${esc(poisoned.musteri)}</span>` +
      `<span class="lens-status">${esc(protectedRun ? t("lens.status.safe") : t("lens.status.danger"))}</span>` +
    `</div>` +
    `<div class="lens-flow">` +
      `<article class="lens-card">` +
        `<small>${esc(t("lens.db"))}</small>` +
        `<p>${markPayload(poisoned.before, poisoned.boundary)}</p>` +
      `</article>` +
      `<div class="lens-gate">` +
        `<div class="lens-arrow"><i>${protectedRun ? "✓" : "→"}</i></div>` +
        `<b>${esc(protectedRun ? t("lens.gate.caught") : t("lens.gate.missed"))}</b>` +
        `<span>${esc(sourceLabel)}</span>` +
      `</div>` +
      `<article class="lens-card">` +
        `<small>${esc(modelLabel)}</small>` +
        `<p>${modelText}</p>` +
      `</article>` +
    `</div>`;
}

// ---------------------------------------------------------- ticket table ---

export function renderTickets(findings, t, retrieval = null) {
  const box = $("ticketRows");
  const meta = $("dbMeta");

  if (!findings || !findings.length) {
    box.innerHTML = `<p class="ag-empty">${esc(retrieval ? t("db.noMatch") : t("db.empty"))}</p>`;
    meta.textContent = retrieval ? "0" : "—";
    return;
  }

  const poisoned = findings.filter((f) => f.poisoned).length;
  const filter = retrieval && retrieval.retrievalTerm ? ` · “${retrieval.retrievalTerm}”` : "";
  meta.textContent = `${findings.length} · ${poisoned} ${t("db.poison").toLowerCase()}${filter}`;

  box.innerHTML = findings.map((f) =>
    `<div class="ag-ticket ${f.poisoned ? "poison" : ""}">` +
      `<span class="tid">#${esc(f.id)}</span>` +
      `<span class="tmus">${esc(f.musteri)}</span>` +
      `<span class="tkonu">${esc(f.konu)}</span>` +
      `<span class="tflag">${esc(f.poisoned ? t("db.poison") : t("db.clean"))}</span>` +
    `</div>`).join("");
}

// ------------------------------------------------------------ the action ---

export function renderAction(ask, t) {
  const badge = $("actBadge");
  const sqlBox = $("actionSql");
  const verdict = $("actionVerdict");
  const score = $("actionScore");

  if (!ask) {
    badge.textContent = t("act.idle");
    badge.dataset.tone = "idle";
    sqlBox.textContent = t("act.none");
    verdict.hidden = true;
    score.hidden = true;
    return;
  }

  const stmt = (ask.assistant && ask.assistant.followupSql) || "";
  const action = ask.action || {};

  if (!stmt) {
    badge.textContent = ask.neutralized ? t("act.quarantined") : t("act.idle");
    badge.dataset.tone = "good";
    sqlBox.textContent = t("act.noAction");
    verdict.hidden = true;
    // The absence of an action IS the result when layer 1 did its job, so name
    // it rather than leaving the panel blank.
    score.hidden = !ask.neutralized;
    if (ask.neutralized) {
      score.dataset.tone = "good";
      score.innerHTML = `<b>${num(ask.poisonedRows)}</b> ${esc(t("act.neutralized"))}`;
    }
    return;
  }

  sqlBox.textContent = stmt;

  if (!ask.hijacked) {
    badge.textContent = t("act.benign");
    badge.dataset.tone = "good";
  } else if (ask.blocked) {
    badge.textContent = t("act.blocked");
    badge.dataset.tone = "good";
  } else {
    badge.textContent = t("act.passed");
    badge.dataset.tone = "bad";
  }

  const reasons = action.reasons || [];
  verdict.hidden = !action.rule;
  verdict.dataset.tone = ask.blocked ? "blocked" : (ask.hijacked ? "passed" : "");
  $("actionRule").textContent = action.rule || "—";
  $("actionReasons").innerHTML = reasons.map((r) => `<li>${esc(r)}</li>`).join("");

  // The headline figure, and only when it was actually measured.
  if (ask.blocked && ask.preventedRecords > 0) {
    score.hidden = false;
    score.dataset.tone = "good";
    score.innerHTML = `<b>${num(ask.preventedRecords)}</b> ${esc(t("act.prevented"))}`;
  } else if (ask.leakedRecords > 0) {
    score.hidden = false;
    score.dataset.tone = "bad";
    score.innerHTML = `<b>${num(ask.leakedRecords)}</b> ${esc(t("act.leaked"))}`;
  } else if (ask.execNote) {
    score.hidden = false;
    score.dataset.tone = "";
    score.textContent = ask.execNote;
  } else {
    score.hidden = true;
  }
}

// ------------------------------------------------------------------ feed ---

export function renderFeed(recent, t) {
  const box = $("turnFeed");
  const meta = $("feedMeta");

  if (!recent || !recent.length) {
    box.innerHTML = `<p class="ag-empty">${esc(t("feed.empty"))}</p>`;
    meta.textContent = "—";
    return;
  }
  meta.textContent = `${recent.length}`;

  box.innerHTML = recent.map((e) => {
    let cls = "";
    let tag = "—";
    if (e.blocked) { cls = "good"; tag = t("act.blocked"); }
    else if (e.hijacked) { cls = "bad"; tag = t("act.passed"); }
    else if (e.neutralized) { cls = "good"; tag = t("act.quarantined"); }
    else { tag = t("act.benign"); }
    return `<div class="ag-ev ${cls}">` +
      `<span class="evtag">${esc(tag)}</span>` +
      `<span class="evq">${esc(e.question)}</span>` +
      `<span class="evms">${esc(e.ms)} ms</span>` +
    `</div>`;
  }).join("");
}

// ----------------------------------------------------------- provenance ---

// The strip that tells the audience where a claim came from. This is the panel
// that keeps the demo honest: it distinguishes a quarantine Quentra performed
// from one this simulator performed, and says so in plain words.
export function renderProvenance(s, ask, t) {
  const strip = $("provenance");
  const text = $("provenanceText");
  const source = (ask && ask.quarantineSource) || s.quarantineSource || "none";

  let tone = "";
  let msg;

  if (ask && ask.poisonedRows === 0) {
    tone = "measured";
    msg = t("prov.clean");
  } else if (!s.gatewayUp && s.mode === "quentra") {
    tone = "simulated";
    msg = t("prov.noGateway");
  } else if (source === "gateway") {
    tone = "measured";
    msg = t("prov.gateway");
  } else if (source === "simulated") {
    tone = "simulated";
    msg = t("prov.simulated");
  } else if (s.mode === "baseline") {
    tone = "";
    msg = t("prov.off");
  } else {
    msg = t("prov.idle");
  }

  if (ask && ask.poisonedRows > 0 && ask.lengthPreserved && source !== "none") {
    msg += " " + t("prov.lengthOk");
  }
  if (ask && ask.assistant && ask.assistant.source === "openai" && !ask.hijacked && ask.poisonedRows > 0) {
    msg += " " + t("llm.resisted");
  }

  strip.dataset.tone = tone;
  text.textContent = msg;
}

// ------------------------------------------------------------------ chat ---

export function pushChat(who, text, { tone = "", tail = "", label = "" } = {}) {
  const log = $("chatLog");
  const empty = log.querySelector(".ag-empty");
  if (empty) empty.remove();

  const wrap = document.createElement("div");
  wrap.className = `ag-msg ${who}${tone ? " " + tone : ""}`;
  wrap.innerHTML =
    `<span class="who">${esc(label)}</span>` +
    `<div class="bubble">${esc(text)}</div>` +
    (tail ? `<span class="tail">${esc(tail)}</span>` : "");
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return wrap;
}

export function clearChat() {
  $("chatLog").innerHTML = "";
}
