// sqlwin.js — controller for the SSMS-style SQL client window. The editor is a
// real, user-editable textarea sitting transparently over a syntax-highlight
// layer; the grids render whatever columns/rows the executed query returned.

const $ = (id) => document.getElementById(id);

export class SqlWin {
  constructor(t) {
    this.t = t;
    this.query = $("swQuery");
    this.input = $("swInput");
    this.execBtn = $("btnExecute");
    this.conn = $("connChip");
    this.status = $("swStatus");
    this._lastCode = null;
    this.input.addEventListener("input", () => this._renderCode(this.input.value));
    // Ctrl+Enter / F5 execute, exactly like SSMS.
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) {
        e.preventDefault();
        this.execBtn.click();
      }
    });
  }

  // ---- editor ----

  getQuery() { return this.input.value; }

  setQuery(text) {
    this.input.value = text;
    this._renderCode(text);
  }

  _renderCode(code) {
    this._lastCode = code;
    this.query.innerHTML = highlightSQL(code);
    const lines = Math.max(1, code.split("\n").length);
    const gutter = $("swGutter");
    if (Number(gutter.dataset.n) !== lines) {
      gutter.dataset.n = lines;
      gutter.innerHTML = Array.from({ length: lines }, (_, i) => i + 1).join("<br>");
    }
  }

  // Emphasizes that the text did NOT change when the second route runs it.
  flashQueryUnchanged() {
    const ed = $("swEditor");
    ed.classList.remove("unchanged");
    void ed.offsetWidth;
    ed.classList.add("unchanged");
  }

  execFlash() {
    this.execBtn.classList.remove("pressed");
    void this.execBtn.offsetWidth;
    this.execBtn.classList.add("pressed");
  }

  setBusy(on) { this.execBtn.disabled = !!on; }

  // ---- results ----

  clearResults() {
    for (const id of ["rsDirect", "rsQuentra"]) $(id).hidden = true;
    for (const id of ["gridDirect", "gridQuentra"]) $(id).innerHTML = "";
    for (const id of ["rsDirectMeta", "rsQuentraMeta"]) $(id).textContent = "";
    $("rsEmpty").hidden = false;
  }

  // fillGrid('direct'|'quentra', {columns, rows}, opts)
  //   compareTo: the OTHER route's rows — cells that differ get the tone class,
  //              so a highlight only ever marks a real difference.
  fillGrid(which, data, opts = {}) {
    const { compareTo = null, tone = "plain", meta = "" } = opts;
    const wrap = which === "direct" ? $("rsDirect") : $("rsQuentra");
    const table = which === "direct" ? $("gridDirect") : $("gridQuentra");
    wrap.hidden = false;
    $("rsEmpty").hidden = true;

    const cols = data.columns || [];
    const rows = data.rows || [];
    const toneCls = tone === "masked" ? "c-masked" : tone === "open" ? "c-open" : "";
    const head = "<tr><th></th>" + cols.map((c) => `<th>${esc(c)}</th>`).join("") + "</tr>";
    const body = rows.map((r, i) => {
      const cells = r.map((cell, j) => {
        const other = compareTo && compareTo[i] ? compareTo[i][j] : undefined;
        const differs = other !== undefined && String(other).trim() !== String(cell).trim();
        return `<td class="${toneCls && differs ? toneCls : ""}">${esc(cell)}</td>`;
      }).join("");
      return `<tr class="rrow show"><td class="rn">${i + 1}</td>${cells}</tr>`;
    }).join("");
    table.innerHTML = head + body;
    (which === "direct" ? $("rsDirectMeta") : $("rsQuentraMeta")).textContent = meta;
  }

  highlightSet(which, tone) {
    const wrap = which === "direct" ? $("rsDirect") : $("rsQuentra");
    wrap.classList.remove("hl-dba", "hl-teal");
    void wrap.offsetWidth;
    wrap.classList.add(tone === "dba" ? "hl-dba" : "hl-teal");
  }

  // ---- identity + status ----

  setIdentity(user, route) {
    const server = route === "quentra" ? "quentra:14330 › HOSPITAL-SQL01" : "HOSPITAL-SQL01";
    this.conn.textContent = `SQLQuery1.sql — ${server}.HOSPITALSIM (${user} (58))`;
    this.conn.dataset.route = route;
    this.conn.dataset.user = user;
    $("stServer").textContent = route === "quentra" ? "quentra:14330" : "HOSPITAL-SQL01";
    $("stUser").textContent = `${user} (58)`;
  }

  setStatus(msg, { tone = "idle", rows = null } = {}) {
    $("stMsg").textContent = msg;
    this.status.dataset.tone = tone;
    if (rows != null) $("stRows").textContent = `${rows} ${this.t("sw.rowsWord")}`;
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Minimal SSMS palette: keywords blue, variables teal, strings dark red,
// numbers green, comments green. Input is escaped first, so the spans are safe.
function highlightSQL(sql) {
  return esc(sql)
    .replace(/\b(SELECT|FROM|WHERE|BETWEEN|AND|OR|NOT|TOP|ORDER|GROUP|BY|LIKE|IN|AS|JOIN|ON|INNER|LEFT|RIGHT|DISTINCT|COUNT|SUM|AVG|MIN|MAX|DESC|ASC)\b/gi,
      '<span class="k">$1</span>')
    .replace(/(@\w+)/g, '<span class="v">$1</span>')
    .replace(/(&#39;[^&]*&#39;)/g, '<span class="s">$1</span>')
    .replace(/(--[^\n]*)/g, '<span class="c">$1</span>');
}
