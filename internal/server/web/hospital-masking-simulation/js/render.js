// render.js — the two bottom panels. Every value comes from the last real
// execution (or is a dash), so the page never implies activity that did not
// happen.

const $ = (id) => document.getElementById(id);

export function renderPanels(view, t) {
  renderSql(view, t);
  renderHistory(view, t);
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
