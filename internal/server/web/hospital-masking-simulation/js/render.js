// render.js — KPI strip and the two bottom panels. Every value comes from the
// last real execution (or is a dash), so the page never implies activity that
// did not happen.

const $ = (id) => document.getElementById(id);

export function renderPanels(view, t) {
  renderKpis(view, t);
  renderSql(view, t);
  renderHistory(view, t);
}

function renderKpis({ dbUp, gatewayUp, result }, t) {
  const kc = $("kpiConn");
  kc.className = "kpi";
  $("kConn").textContent = dbUp ? t("db.up") : t("db.down");
  kc.classList.add(dbUp ? "k-ok" : "k-bad");

  $("kRows").textContent = result ? String((result.directRows || []).length) : "—";
  $("kDirectMs").textContent = result && result.directMs != null ? result.directMs + " ms" : "—";
  $("kQuentraMs").textContent = result && result.quentraMs != null ? result.quentraMs + " ms" : "—";

  const km = $("kpiMask"), kv = $("kMasking");
  km.className = "kpi";
  if (!result) kv.textContent = "—";
  else if (result.masked) { kv.textContent = t("mask.on"); km.classList.add("k-ok"); }
  else { kv.textContent = t("mask.off"); km.classList.add("k-warn"); }

  const kg = $("kpiGw"), gv = $("kGateway");
  kg.className = "kpi";
  if (gatewayUp == null) gv.textContent = "—";
  else if (gatewayUp) { gv.textContent = t("gw.up"); kg.classList.add("k-ok"); }
  else { gv.textContent = t("gw.down"); kg.classList.add("k-bad"); }
}

// The statement travels both routes unchanged — that IS the demo's claim, so
// the panel shows the single text the editor sent.
function renderSql({ sqlText }, t) {
  const badge = $("sqlBadge");
  badge.textContent = t("sql.same");
  badge.className = "sql-badge";
  $("sqlBlocks").innerHTML =
    `<div class="sql-blk"><div class="sql-blk-h"><b class="qn">▸</b> ${esc(t("sql.both"))}</div><pre>${esc(sqlText || "")}</pre></div>`;
}

function renderHistory({ history }, t) {
  const feed = $("lookupFeed");
  $("feedStats").textContent = history.length ? `${history.length}` : "—";
  if (!history.length) {
    feed.innerHTML = `<p class="empty">${esc(t("feed.empty"))}</p>`;
    return;
  }
  feed.innerHTML = history.map((h) => {
    const tag = h.masked
      ? `<span class="fe-tag masked">${esc(t("tag.masked"))}</span>`
      : `<span class="fe-tag open">${esc(t("tag.open"))}</span>`;
    return `<div class="fe"><span class="fe-name">${esc(h.sql)}</span>${tag}` +
      `<span class="fe-ms">${h.rows} ${esc(t("sw.rowsWord"))} · ${h.directMs}/${h.quentraMs} ms</span></div>`;
  }).join("");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
