// sqlwin.js — controller for the SSMS-style SQL client window: typing the
// query, pressing Yürüt, filling the two result sets (direct vs Quentra),
// identity/status chips. Purely presentational; the DATA it renders comes from
// the demo set or, in live mode, verbatim from the backend's two routes.

const COLUMNS = [
  { col: "HASTA_ID", key: "id" },
  { col: "AD", key: "ad" },
  { col: "SOYAD", key: "soyad" },
  { col: "TCKN", key: "tckn" },
  { col: "TELEFON", key: "telefon" },
  { col: "KAN_GRUBU", key: "kanGrubu" },
  { col: "ADRES", key: "adres" },
  { col: "TANI", key: "tani" },
];

// Identity columns that light up red when they come back unprotected.
const SENSITIVE = new Set(["ad", "soyad", "tckn", "telefon", "kanGrubu", "adres"]);

const $ = (id) => document.getElementById(id);

export class SqlWin {
  constructor(t) {
    this.t = t;
    this.el = $("sqlwin");
    this.query = $("swQuery");
    this.caret = $("swCaret");
    this.execBtn = $("btnExecute");
    this.conn = $("connChip");
    this.status = $("swStatus");
    this.cursorEl = $("fakeCursor");
    this._lastReveal = { direct: -1, quentra: -1 };
    this._treeShown = -1;
  }

  // ---- window lifecycle ----

  reset() {
    this.setQuery("");
    this.showCaret(false);
    this.clearResults();
    this.treeReveal(0);
    this.setIdentity("destek", "direct");
    this.setStatus(this.t("sw.stReady"), { tone: "idle", rows: null });
    this.dim(false);
  }

  dim(on) { this.el.classList.toggle("dimmed", !!on); }

  // ---- object explorer ----

  treeReveal(p) {
    const items = this.el.querySelectorAll(".tr-item");
    const n = Math.round(p * items.length);
    if (n === this._treeShown) return;
    this._treeShown = n;
    items.forEach((li, i) => li.classList.toggle("show", i < n));
  }

  // ---- editor ----

  setQuery(text) { this.query.textContent = text; }

  typeQuery(p, text) {
    const n = Math.max(0, Math.round(p * text.length));
    const cut = text.slice(0, n);
    if (this.query.textContent !== cut) this.query.textContent = cut;
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
    this._lastReveal = { direct: -1, quentra: -1 };
  }

  // fillGrid('direct'|'quentra', rows, {tone:'open'|'masked'|'dba'|'plain',
  //   maskedFields:[], revealP:0..1, meta:''})
  fillGrid(which, rows, opts = {}) {
    const { tone = "plain", maskedFields = [], revealP = 1, meta = "" } = opts;
    const wrap = which === "direct" ? $("rsDirect") : $("rsQuentra");
    const table = which === "direct" ? $("gridDirect") : $("gridQuentra");
    wrap.hidden = false;
    $("rsEmpty").hidden = true;

    const sig = tone + ":" + rows.length + ":" + rows.map((r) => r.id).join(",");
    if (table.dataset.sig !== sig) {
      table.dataset.sig = sig;
      this._lastReveal[which] = -1;
      const maskSet = new Set(maskedFields);
      const head = "<tr><th></th>" + COLUMNS.map((c) => `<th>${c.col}</th>`).join("") + "</tr>";
      const body = rows.map((r, i) => {
        const cells = COLUMNS.map((c) => {
          const v = r[c.key];
          let cls = "";
          if (c.key !== "id") {
            if (tone === "masked" && maskSet.has(c.key)) cls = "c-masked";
            else if (tone === "open" && SENSITIVE.has(c.key)) cls = "c-open";
            else if (tone === "dba" && SENSITIVE.has(c.key)) cls = "c-dba";
          }
          return `<td class="${cls}">${esc(v)}</td>`;
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

  // route: 'direct' | 'quentra'; user: 'destek' | 'dba'
  setIdentity(user, route) {
    const server = route === "quentra" ? "QUENTRA :14330 → HOSPITAL-SQL01" : "HOSPITAL-SQL01";
    this.conn.textContent = `${user} @ ${server}`;
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
