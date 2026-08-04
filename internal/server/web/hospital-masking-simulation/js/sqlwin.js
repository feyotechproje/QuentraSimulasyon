// sqlwin.js — controller for the SSMS-style SQL client window. The editor is a
// real, user-editable textarea (with a syntax-highlight layer underneath); the
// result grids render whatever columns/rows the executed query returned. The
// window only ever displays data it was handed — in live mode that is the
// verbatim output of the two routes.

const $ = (id) => document.getElementById(id);

export class SqlWin {
  constructor(t) {
    this.t = t;
    this.el = $("sqlwin");
    this.query = $("swQuery");
    this.caret = $("swCaret");
    this.input = $("swInput");
    this.execBtn = $("btnExecute");
    this.conn = $("connChip");
    this.status = $("swStatus");
    this.cursorEl = $("fakeCursor");
    this._lastReveal = { direct: -1, quentra: -1 };
    this._treeShown = -1;
    this._lastCode = null;
    this.input.addEventListener("input", () => this._renderCode(this.input.value));
  }

  // ---- window lifecycle ----

  reset() {
    this.setQuery("");
    this.showCaret(false);
    this.clearResults();
    this.treeReveal(0);
    this.setIdentity("destek", "direct");
    this.setStatus(this.t("sw.stReady"), { tone: "idle", rows: 0 });
    this.dim(false);
  }

  // The page's resting state: tree open, query prefilled, ready to edit/run.
  idle(queryText) {
    this.reset();
    this.treeReveal(1);
    this.setQuery(queryText);
    this.setEditable(true);
  }

  dim(on) { this.el.classList.toggle("dimmed", !!on); }

  setEditable(on) { this.input.readOnly = !on; }

  // ---- object explorer ----

  treeReveal(p) {
    const items = this.el.querySelectorAll(".tr-item");
    const n = Math.round(p * items.length);
    if (n === this._treeShown) return;
    this._treeShown = n;
    items.forEach((li, i) => li.classList.toggle("show", i < n));
  }

  // ---- editor ----

  getQuery() { return this.input.value; }

  setQuery(text) {
    this.input.value = text;
    this._renderCode(text);
  }

  typeQuery(p, text) {
    const n = Math.max(0, Math.round(p * text.length));
    const cut = text.slice(0, n);
    if (this._lastCode !== cut) {
      this.input.value = cut;
      this._renderCode(cut);
    }
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

  showCaret(on) { this.caret.hidden = !on; }

  // Emphasize that the text did NOT change when Quentra enters the path.
  flashQueryUnchanged() {
    const ed = $("swEditor");
    ed.classList.remove("unchanged");
    void ed.offsetWidth;
    ed.classList.add("unchanged");
  }

  // ---- execute ----

  execFlash() {
    this.execBtn.classList.remove("pressed");
    void this.execBtn.offsetWidth;
    this.execBtn.classList.add("pressed");
  }

  // Moves a fake mouse cursor onto Yürüt and presses it (story mode only).
  pressExecute({ cursor = false } = {}) {
    if (!cursor) { this.execFlash(); return; }
    const stage = document.getElementById("stage").getBoundingClientRect();
    const btn = this.execBtn.getBoundingClientRect();
    const c = this.cursorEl;
    c.hidden = false;
    c.style.transition = "none";
    c.style.left = stage.width * 0.55 + "px";
    c.style.top = stage.height * 0.55 + "px";
    void c.offsetWidth;
    c.style.transition = "left .45s ease, top .45s ease";
    c.style.left = btn.left - stage.left + btn.width / 2 - 4 + "px";
    c.style.top = btn.top - stage.top + btn.height / 2 - 2 + "px";
    setTimeout(() => this.execFlash(), 480);
    setTimeout(() => { c.hidden = true; }, 950);
  }

  // ---- results ----

  clearResults() {
    $("rsDirect").hidden = true;
    $("rsQuentra").hidden = true;
    $("rsEmpty").hidden = false;
    $("gridDirect").innerHTML = "";
    $("gridQuentra").innerHTML = "";
    $("gridDirect").dataset.sig = "";
    $("gridQuentra").dataset.sig = "";
    this._lastReveal = { direct: -1, quentra: -1 };
  }

  // fillGrid('direct'|'quentra', {columns:[], rows:[][]}, opts)
  //   opts.compareTo: the OTHER route's rows — any differing cell gets the
  //                   tone's highlight, so a mask only ever shows where the
  //                   two routes really returned different values.
  //   opts.tone: 'open' | 'masked' | 'dba' | 'plain'
  fillGrid(which, data, opts = {}) {
    const { compareTo = null, tone = "plain", revealP = 1, meta = "" } = opts;
    const wrap = which === "direct" ? $("rsDirect") : $("rsQuentra");
    const table = which === "direct" ? $("gridDirect") : $("gridQuentra");
    wrap.hidden = false;
    $("rsEmpty").hidden = true;

    const cols = data.columns || [];
    const rows = data.rows || [];
    const sig = tone + "|" + cols.join(",") + "|" + JSON.stringify(rows);
    if (table.dataset.sig !== sig) {
      table.dataset.sig = sig;
      this._lastReveal[which] = -1;
      const toneCls = tone === "masked" ? "c-masked" : tone === "dba" ? "c-dba" : tone === "open" ? "c-open" : "";
      const head = "<tr><th></th>" + cols.map((c) => `<th>${esc(c)}</th>`).join("") + "</tr>";
      const body = rows.map((r, i) => {
        const cells = r.map((cell, j) => {
          let cls = "";
          const other = compareTo && compareTo[i] ? compareTo[i][j] : undefined;
          if (toneCls && other !== undefined && String(other).trim() !== String(cell).trim()) cls = toneCls;
          return `<td class="${cls}">${esc(cell)}</td>`;
        }).join("");
        return `<tr class="rrow"><td class="rn">${i + 1}</td>${cells}</tr>`;
      }).join("");
      table.innerHTML = head + body;
    }

    const trs = table.querySelectorAll("tr.rrow");
    const n = Math.max(0, Math.min(trs.length, Math.ceil(revealP * trs.length)));
    if (n !== this._lastReveal[which]) {
      this._lastReveal[which] = n;
      trs.forEach((tr, i) => tr.classList.toggle("show", i < n));
    }
    if (meta) (which === "direct" ? $("rsDirectMeta") : $("rsQuentraMeta")).textContent = meta;
  }

  highlightSet(which, tone) {
    const wrap = which === "direct" ? $("rsDirect") : $("rsQuentra");
    wrap.classList.remove("hl-dba", "hl-teal");
    void wrap.offsetWidth;
    wrap.classList.add(tone === "dba" ? "hl-dba" : "hl-teal");
  }

  // ---- identity + status ----

  // route: 'direct' | 'quentra'; user: 'destek' | 'dba' — shown SSMS-style in
  // the window title ("SQLQuery1.sql — server.db (login (spid))").
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

// Minimal SSMS palette: keywords blue, variables teal, numbers green,
// comments green. Input is escaped first, so the spans are safe.
function highlightSQL(sql) {
  return esc(sql)
    .replace(/\b(SELECT|FROM|WHERE|BETWEEN|AND|OR|TOP|ORDER|GROUP|BY|LIKE|IN|AS|JOIN|ON|INNER|LEFT|RIGHT|DISTINCT|COUNT|SUM|AVG|MIN|MAX)\b/gi, '<span class="k">$1</span>')
    .replace(/(@\w+)/g, '<span class="v">$1</span>')
    .replace(/('[^']*')/g, '<span class="s">$1</span>')
    .replace(/\b(\d+)\b(?![^<]*>)/g, '<span class="n">$1</span>')
    .replace(/(--[^\n]*)/g, '<span class="c">$1</span>');
}
