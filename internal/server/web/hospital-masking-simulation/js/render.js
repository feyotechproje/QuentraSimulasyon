// render.js — writes one state snapshot onto the DOM. The same code path
// renders demo and live states; a live state's rows are shown VERBATIM, so the
// screen can only claim a mask the gateway really applied.

import { fmt } from "/shared/live-workload.js";

const $ = (id) => document.getElementById(id);

export function renderAll(state, role, t, playing) {
  if (!state) return;
  renderKpis(state, role, t);
  renderSql(state, t);
  renderFeed(state, t);
  renderBadges(state, role, playing);
}

function roleName(role, t) { return t("roleName." + role, role); }

function renderKpis(state, role, t) {
  // Worker counters only mean something while the background workload runs;
  // otherwise they would show stale zeros and read as "live but dead".
  const active = !state.demo && state.running;
  $("kRole").textContent = roleName(role, t);
  $("kQueries").textContent = active ? fmt.int(state.queriesTotal) : "—";
  $("kDirectMs").textContent = active ? fmt.ms(state.directMs) : "—";
  $("kQuentraMs").textContent = active ? fmt.ms(state.quentraMs) : "—";

  const km = $("kpiMask"), kv = $("kMasking");
  km.className = "kpi";
  if (state.demo) { kv.textContent = t("mask.demo"); km.classList.add("k-teal"); }
  else if (!active) { kv.textContent = "—"; }
  else if (state.masked) { kv.textContent = t("mask.on"); km.classList.add("k-ok"); }
  else { kv.textContent = t("mask.off"); km.classList.add("k-warn"); }

  const kg = $("kpiGw"), gv = $("kGateway");
  kg.className = "kpi";
  if (state.demo || state.gatewayUp == null) { gv.textContent = "—"; }
  else if (state.gatewayUp) { gv.textContent = t("gw.up"); kg.classList.add("k-ok"); }
  else { gv.textContent = t("gw.down"); kg.classList.add("k-bad"); }
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

// The stage badges belong to the film's narration; outside playback they stay
// hidden so an idle page never claims KVKK risk or an applied mask.
function renderBadges(state, role, playing) {
  const masked = state.demo ? true : !!state.masked;
  document.getElementById("kvkkBadge").hidden = !playing || role !== "baseline";
  document.getElementById("maskedBadge").hidden = !playing || !(role === "quentra" && masked);
  document.getElementById("dbaBadge").hidden = !playing || role !== "dba";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
