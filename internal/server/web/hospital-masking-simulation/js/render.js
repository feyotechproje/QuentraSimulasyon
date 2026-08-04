// render.js — writes one state snapshot onto the DOM. The same code path
// renders demo and live states; a live state's rows are shown VERBATIM, so the
// screen can only claim a mask the gateway really applied.

import { MASKED_FIELDS } from "./data.js";
import { fmt } from "/shared/live-workload.js";

const $ = (id) => document.getElementById(id);

const SENSITIVE = ["patient", "tc", "phone", "blood", "addr"];

export function renderAll(state, role, t) {
  if (!state) return;
  renderKpis(state, role, t);
  renderScreen(state, role, t);
  renderSql(state, t);
  renderFeed(state, t);
  renderBadges(state, role);
}

function roleName(role, t) { return t("roleName." + role, role); }

function renderKpis(state, role, t) {
  $("kRole").textContent = roleName(role, t);
  $("kQueries").textContent = state.demo ? "—" : fmt.int(state.queriesTotal);
  $("kDirectMs").textContent = state.demo ? "—" : fmt.ms(state.directMs);
  $("kQuentraMs").textContent = state.demo ? "—" : fmt.ms(state.quentraMs);

  const km = $("kpiMask"), kv = $("kMasking");
  km.className = "kpi";
  if (state.demo) { kv.textContent = t("mask.demo"); km.classList.add("k-teal"); }
  else if (state.masked) { kv.textContent = t("mask.on"); km.classList.add("k-ok"); }
  else { kv.textContent = t("mask.off"); km.classList.add("k-warn"); }

  const kg = $("kpiGw"), gv = $("kGateway");
  kg.className = "kpi";
  if (state.demo || state.gatewayUp == null) { gv.textContent = "—"; }
  else if (state.gatewayUp) { gv.textContent = t("gw.up"); kg.classList.add("k-ok"); }
  else { gv.textContent = t("gw.down"); kg.classList.add("k-bad"); }
}

function renderScreen(state, role, t) {
  // The support engineer's session travels the Quentra route; every other role
  // sees the direct route's row.
  const row = role === "quentra" ? state.quentraRow : state.directRow;
  const maskedFields = state.demo ? MASKED_FIELDS : state.maskedFields || [];
  const isMasked = (f) => role === "quentra" && maskedFields.includes(f);

  const badge = $("routeBadge");
  if (role === "quentra") { badge.textContent = t("badge.quentra"); badge.className = "route-badge"; }
  else if (role === "dba") { badge.textContent = t("badge.dba"); badge.className = "route-badge dba"; }
  else { badge.textContent = t("badge.direct"); badge.className = "route-badge direct"; }
  $("termWho").textContent = t("term.who." + role);

  const card = $("patientCard");
  if (!row) {
    card.innerHTML = `<div class="t-head">${t("t.patient")}</div><div class="t-rule">-------------------------</div>`;
    return;
  }

  const rows = [
    { key: "patient", label: t("t.patient"), val: `${row.ad} ${row.soyad}`.trim(), masked: isMasked("ad") || isMasked("soyad") },
    { key: "tc",      label: t("t.tc"),      val: row.tckn,     masked: isMasked("tckn") },
    { key: "phone",   label: t("t.phone"),   val: row.telefon,  masked: isMasked("telefon") },
    { key: "blood",   label: t("t.blood"),   val: row.kanGrubu, masked: isMasked("kanGrubu") },
    { key: "addr",    label: t("t.addr"),    val: row.adres,    masked: isMasked("adres") },
    { key: "diag",    label: t("t.diag"),    val: row.tani,     masked: isMasked("tani") },
  ];

  card.innerHTML =
    `<div class="t-head">HASTA #${row.id ?? "—"}</div>` +
    `<div class="t-rule">-------------------------------------------</div>` +
    rows.map((r) => {
      const exposed = role === "baseline" && SENSITIVE.includes(r.key);
      const cls = r.masked ? "masked" : exposed ? "exposed" : "";
      const rowCls = exposed ? "t-row flash-exposed" : "t-row";
      return `<div class="${rowCls}"><span class="t-key">${esc(r.label)}</span><span class="t-val ${cls}">${esc(r.val)}</span></div>`;
    }).join("");

  renderNote(state, role, t);
}

function renderNote(state, role, t) {
  const note = $("termNote");
  let key = "", cls = "";
  if (state.demo) { key = "note.demo"; cls = "warn"; }
  else if (!state.provisioned) { key = "note.prov"; cls = "warn"; }
  else if (role === "baseline") { key = "note.baseline"; cls = "bad"; }
  else if (role === "dba") { key = "note.dba"; cls = "ok"; }
  else if (state.gatewayUp === false) { key = "note.gwDown"; cls = "bad"; }
  else if (state.masked) { key = "note.masked"; cls = "ok"; }
  else { key = "note.noRule"; cls = "warn"; }
  note.hidden = false;
  note.className = "term-note " + cls;
  note.textContent = t(key);
}

function renderSql(state, t) {
  const same = (state.directSql || "") === (state.quentraSql || "");
  const badge = $("sqlBadge");
  badge.textContent = same ? t("sql.same") : t("sql.diff");
  badge.className = same ? "sql-badge" : "sql-badge diff";

  const blocks = $("sqlBlocks");
  if (same) {
    blocks.innerHTML = sqlBlock(t("sql.both"), "qn", state.directSql || "");
  } else {
    blocks.innerHTML =
      sqlBlock(t("sql.direct"), "dr", state.directSql || "") +
      sqlBlock(t("sql.quentra"), "qn", state.quentraSql || "");
  }
}

function sqlBlock(title, tone, sql) {
  return `<div class="sql-blk"><div class="sql-blk-h"><b class="${tone}">▸</b> ${esc(title)}</div><pre>${esc(sql)}</pre></div>`;
}

function renderFeed(state, t) {
  const feed = $("lookupFeed");
  const items = state.recent || [];
  $("feedStats").textContent = state.demo
    ? t("status.demo")
    : `${fmt.int(state.queriesTotal)} · ${state.queriesPerSec || 0}/s`;
  if (!items.length) {
    feed.innerHTML = `<p class="empty">${esc(t("feed.empty"))}</p>`;
    return;
  }
  feed.innerHTML = items.map((e) => {
    const tag = e.masked
      ? `<span class="fe-tag masked">${esc(t("tag.masked"))}</span>`
      : `<span class="fe-tag open">${esc(t("tag.open"))}</span>`;
    const ms = e.quentraMs != null ? `<span class="fe-ms">${fmt.ms(e.quentraMs)}</span>` : "";
    return `<div class="fe"><span class="fe-name">#${e.id} · ${esc(e.nameSeen || "")}</span>${tag}${ms}</div>`;
  }).join("");
}

function renderBadges(state, role) {
  const masked = state.demo ? true : !!state.masked;
  document.getElementById("kvkkBadge").hidden = role !== "baseline";
  document.getElementById("maskedBadge").hidden = !(role === "quentra" && masked);
  document.getElementById("dbaBadge").hidden = role !== "dba";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
