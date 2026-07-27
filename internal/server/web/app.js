"use strict";

const T = (key, fallback) => (window.QuentraI18n ? window.QuentraI18n.t(key, fallback) : fallback);

const $ = (id) => document.getElementById(id);
const api = (path, body) =>
  fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  });

const SETTING_FIELDS = [
  "totalCustomers", "registerCount", "itemsPerCustomer", "minQty", "maxQty",
  "scanMs", "receiptMs", "arrivalMs", "speed", "maxConcurrent", "seed",
  "dispatchMode", "autoDistribute", "allowRepeatCustomer", "perUnitScan",
];
const LOCK_WHILE_RUNNING = [
  "totalCustomers", "registerCount", "itemsPerCustomer", "minQty", "maxQty", "seed",
];

let currency = "USD";
let money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
function setCurrency(c) {
  if (c && c !== currency) {
    currency = c;
    try { money = new Intl.NumberFormat(undefined, { style: "currency", currency: c }); }
    catch { money = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  }
}
const fmtMoney = (n) => money.format(n || 0);
const fmtInt = (n) => new Intl.NumberFormat().format(Math.round(n || 0));
const fmtDur = (ms) => {
  ms = ms || 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
};
const fmtTime = (ms) => new Date(ms).toLocaleTimeString();

/* ---------- Settings form ---------- */
function fillSettings(s) {
  for (const f of SETTING_FIELDS) {
    const el = $("s_" + f);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!s[f];
    else el.value = s[f];
  }
}
function readSettings() {
  const out = {};
  for (const f of SETTING_FIELDS) {
    const el = $("s_" + f);
    if (!el) continue;
    if (el.type === "checkbox") out[f] = el.checked;
    else if (el.type === "number") out[f] = f === "speed" ? parseFloat(el.value) : parseInt(el.value, 10);
    else out[f] = el.value;
  }
  return out;
}
async function saveSettings() {
  try { await api("/api/settings", readSettings()); }
  catch (e) { /* rejected while running; ignore */ }
}

/* ---------- State-driven UI lock ---------- */
let lastSimState = "IDLE";
function applyStateUI(state) {
  lastSimState = state;
  const st = $("simState");
  st.textContent = T("state." + state.toLowerCase(), state);
  st.className = "sim-state state-" + state.toLowerCase();

  const active = state === "RUNNING" || state === "PREPARING";
  const paused = state === "PAUSED";
  $("btnStart").disabled = active || paused;
  $("btnPause").disabled = state !== "RUNNING";
  $("btnResume").disabled = !paused;
  $("btnStop").disabled = !(active || paused);
  $("btnReset").disabled = active || paused;
  $("btnAddCustomer").disabled = state !== "RUNNING";
  $("btnOpenReg").disabled = !(state === "RUNNING" || paused);
  $("btnCloseReg").disabled = !(state === "RUNNING" || paused);

  const locked = active || paused;
  for (const f of LOCK_WHILE_RUNNING) {
    const el = $("s_" + f);
    if (el) el.disabled = locked;
  }
}

/* ---------- KPI cards ---------- */
const KPI_DEFS = [
  ["totalCustomers", "kpi.totalCustomers", "Total Customers", (m) => fmtInt(m.totalCustomers), ""],
  ["waiting", "kpi.waiting", "In Queue", (m) => fmtInt(m.waiting), ""],
  ["inCheckout", "kpi.inCheckout", "In Checkout", (m) => fmtInt(m.inCheckout), "accent"],
  ["completed", "kpi.completed", "Completed", (m) => fmtInt(m.completed), "green"],
  ["openRegisters", "kpi.openRegisters", "Open Registers", (m) => fmtInt(m.openRegisters), ""],
  ["totalSales", "kpi.totalSales", "Total Sales", (m) => fmtMoney(m.totalSales), "accent"],
  ["txnPerMinute", "kpi.txnPerMinute", "Txn / min", (m) => (m.txnPerMinute || 0).toFixed(1), ""],
  ["avgWaitMs", "kpi.avgWaitMs", "Avg Wait", (m) => fmtDur(m.avgWaitMs), ""],
  ["avgProcessMs", "kpi.avgProcessMs", "Avg Checkout", (m) => fmtDur(m.avgProcessMs), ""],
  ["itemsScanned", "kpi.itemsScanned", "Items Scanned", (m) => fmtInt(m.itemsScanned), ""],
  ["errors", "kpi.errors", "Errors", (m) => fmtInt(m.errors), "red"],
  ["elapsedMs", "kpi.elapsedMs", "Elapsed", (m) => fmtDur(m.elapsedMs), ""],
];
let kpiInit = false;
let lastMetrics = null;
function renderKPIs(m) {
  lastMetrics = m;
  const row = $("kpiRow");
  if (!kpiInit) {
    row.innerHTML = KPI_DEFS.map(
      ([id, key, label, , cls]) =>
        `<div class="kpi ${cls}"><div class="kpi-label" data-i18n="${key}">${T(key, label)}</div><div class="kpi-value" id="kpi_${id}">-</div></div>`
    ).join("");
    kpiInit = true;
  }
  for (const [id, , , fn] of KPI_DEFS) $("kpi_" + id).textContent = fn(m);

  const total = m.totalCustomers || 0;
  const pct = total ? Math.min(100, (m.completed / total) * 100) : 0;
  $("progressFill").style.width = pct + "%";
  $("progressText").textContent = `${fmtInt(m.completed)} / ${fmtInt(total)}`;
}

/* ---------- Register floor ---------- */
const regEls = new Map();
let regData = new Map();
let openDrawerNo = null;

function statusClass(status) { return "st-" + status.replace(/\s+/g, ""); }

function renderRegisters(registers) {
  const floor = $("registerFloor");
  const seen = new Set();
  for (const r of registers) {
    seen.add(r.no);
    regData.set(r.no, r);
    let el = regEls.get(r.no);
    if (!el) {
      el = document.createElement("div");
      el.className = "register-card";
      el.addEventListener("click", () => openDrawer(r.no));
      floor.appendChild(el);
      regEls.set(r.no, el);
    }
    el.className = "register-card " + statusClass(r.status);
    el.innerHTML = registerCardHTML(r);
  }
  // Remove registers no longer present.
  for (const [no, el] of regEls) {
    if (!seen.has(no)) { el.remove(); regEls.delete(no); regData.delete(no); }
  }
  $("floorMeta").textContent = T("floor.meta", "{n} registers").replace("{n}", registers.length);
  if (openDrawerNo !== null) renderDrawer(regData.get(openDrawerNo));
}

// Register/customer status strings arrive from the backend in fixed English
// tokens (e.g. "Closed", "Printing Receipt"); map them through the dictionary
// for on-screen display while keeping the raw token for class names / logic.
const STATUS_KEY_MAP = {
  "Closed": "state.stopped",
  "Idle": "state.idle",
  "Scanning": "cc.scanning",
  "Printing Receipt": "cc.printingReceipt",
};
function statusLabel(status) {
  const key = STATUS_KEY_MAP[status];
  return key ? T(key, status) : status;
}

function registerCardHTML(r) {
  const active = r.activeCustomer;
  const display = active
    ? `<div class="rc-item-name">${esc(r.activeItem || "—")}</div>
       <div class="rc-item-sub">
         <span>${esc(r.activeItemCode || "")} · ${fmtMoney(r.activeUnitPrice)} × ${r.activeQty}</span>
         <span class="rc-linetotal">${fmtMoney(r.activeLineTotal)}</span>
       </div>`
    : `<div class="rc-idle-note">${r.status === "Closed" ? T("reg.registerClosed", "Register closed") : T("reg.waitingForCustomer", "Waiting for customer")}</div>`;

  const prog = r.itemTotal ? Math.round((r.itemProgress / r.itemTotal) * 100) : 0;
  const printing = r.status === "Printing Receipt";
  const dots = queueDots(r.queueLen);

  return `
    <div class="rc-head">
      <span class="rc-no">${T("reg.short", "Register {n}").replace("{n}", r.no)}</span>
      <span class="status-badge">${esc(statusLabel(r.status))}</span>
    </div>
    <div class="rc-display ${printing ? "rc-printing" : ""}">${display}</div>
    ${active ? `<div class="rc-customer"><span class="lbl">${T("reg.customerLabel", "Customer:")}</span> ${esc(active)}</div>` : ""}
    <div class="rc-progress ${printing ? "rc-printing" : ""}"><div class="rc-progress-fill" style="width:${printing ? 100 : prog}%"></div></div>
    <div class="rc-meta">
      <span>${r.itemProgress}/${r.itemTotal} ${T("reg.itemsSuffix", "items")}</span>
      <span class="rc-subtotal">${fmtMoney(r.basketSubtotal)}</span>
    </div>
    <div class="rc-meta">
      <span>${T("reg.queueLabel", "Queue:")} ${r.queueLen}</span>
      <span>${T("reg.doneLabel", "Done:")} ${r.completedCustomers} · ${fmtMoney(r.totalSales)}</span>
    </div>
    <div class="queue-dots">${dots}</div>`;
}

function queueDots(n) {
  if (!n) return `<span class="queue-more">${T("reg.queueEmpty", "empty")}</span>`;
  const shown = Math.min(n, 8);
  let s = "";
  for (let i = 0; i < shown; i++) s += `<span class="queue-dot"></span>`;
  if (n > shown) s += `<span class="queue-more">+${n - shown}</span>`;
  return s;
}

/* ---------- Drawer ---------- */
function openDrawer(no) {
  openDrawerNo = no;
  $("drawer").classList.remove("hidden");
  $("drawerScrim").classList.remove("hidden");
  renderDrawer(regData.get(no));
}
function closeDrawer() {
  openDrawerNo = null;
  $("drawer").classList.add("hidden");
  $("drawerScrim").classList.add("hidden");
}
function renderDrawer(r) {
  if (!r) return;
  $("drawerTitle").textContent = `${T("reg.short", "Register {n}").replace("{n}", r.no)} · ${esc(statusLabel(r.status))}`;
  const previews = (r.queuePreview || [])
    .map((c) => `<div class="d-kv"><span class="k">${esc(c.customer.name)}</span><span>${c.distinctCount} ${T("drawer.itemsQtyLabel", "items")} · ${c.totalQty} qty</span></div>`)
    .join("") || `<div class="empty-note">${T("drawer.noWaiting", "No customers waiting")}</div>`;

  const prog = r.itemTotal ? Math.round((r.itemProgress / r.itemTotal) * 100) : 0;
  const btn = r.status === "Closed"
    ? `<button class="btn btn-small" onclick="regAction(${r.no}, true)">${T("action.openRegister", "Open Register")}</button>`
    : `<button class="btn btn-small" onclick="regAction(${r.no}, false)">${T("action.closeRegister", "Close Register")}</button>`;

  $("drawerBody").innerHTML = `
    <div class="d-section">
      <h3>${T("drawer.liveStatus", "Live Status")}</h3>
      <div class="d-kv"><span class="k">${T("drawer.state", "State")}</span><span>${esc(statusLabel(r.status))}</span></div>
      <div class="d-kv"><span class="k">${T("drawer.activeCustomer", "Active customer")}</span><span>${esc(r.activeCustomer || "—")}</span></div>
      <div class="d-kv"><span class="k">${T("drawer.itemProgress", "Item progress")}</span><span>${r.itemProgress}/${r.itemTotal} (${prog}%)</span></div>
      <div class="d-kv"><span class="k">${T("drawer.basketSubtotal", "Basket subtotal")}</span><span>${fmtMoney(r.basketSubtotal)}</span></div>
    </div>
    <div class="d-section">
      <h3>${T("drawer.currentItem", "Current Item")}</h3>
      <div class="d-kv"><span class="k">${esc(r.activeItem || "—")}</span><span class="d-lt">${fmtMoney(r.activeLineTotal)}</span></div>
      <div class="d-kv"><span class="k">${T("drawer.code", "Code")}</span><span>${esc(r.activeItemCode || "—")}</span></div>
      <div class="d-kv"><span class="k">${T("drawer.unitPriceQty", "Unit price × qty")}</span><span>${fmtMoney(r.activeUnitPrice)} × ${r.activeQty}</span></div>
    </div>
    <div class="d-section">
      <h3>${T("drawer.performance", "Performance")}</h3>
      <div class="d-kv"><span class="k">${T("drawer.completedCustomers", "Completed customers")}</span><span>${r.completedCustomers}</span></div>
      <div class="d-kv"><span class="k">${T("drawer.totalSales", "Total sales")}</span><span>${fmtMoney(r.totalSales)}</span></div>
      <div class="d-kv"><span class="k">${T("drawer.avgCheckout", "Avg checkout")}</span><span>${fmtDur(r.avgProcessMs)}</span></div>
      <div class="d-kv"><span class="k">${T("drawer.queueLength", "Queue length")}</span><span>${r.queueLen} (${r.queueQty} qty)</span></div>
    </div>
    <div class="d-section">
      <h3>${T("drawer.waitingCustomers", "Waiting Customers")}</h3>
      ${previews}
    </div>
    <div class="d-section">${btn}</div>`;
}
window.regAction = async (no, open) => {
  try { await api(open ? "/api/open-register" : "/api/close-register", { no }); }
  catch (e) { alert(e.message); }
};

/* ---------- Bottom lists ---------- */
const MAX_LIST = 200;
function appendRows(listId, rows) {
  if (!rows || !rows.length) return;
  const list = $(listId);
  const empty = list.querySelector(".empty-note");
  if (empty) empty.remove();
  const frag = document.createDocumentFragment();
  for (const html of rows) {
    const div = document.createElement("div");
    div.innerHTML = html;
    frag.appendChild(div.firstElementChild);
  }
  list.insertBefore(frag, list.firstChild);
  while (list.children.length > MAX_LIST) list.removeChild(list.lastChild);
}

function activityRow(ev) {
  const p = ev.payload || {};
  const reg = p.register != null ? "R" + p.register : "—";
  const cust = p.customer || "";
  const item = p.item || "";
  const amt = p.total != null ? fmtMoney(p.total) : p.lineTotal != null ? fmtMoney(p.lineTotal) : "";
  return `<div class="row activity"><span class="t">${fmtTime(ev.time)}</span><span>${reg}</span><span class="ev">${esc(evLabel(ev.type))}</span><span>${esc(cust || item)}</span><span class="amt">${amt}</span></div>`;
}
function evLabel(t) {
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function completedRow(s) {
  return `<div class="row completed"><span>${esc(s.invoiceNo)}</span><span>${esc(s.customer)}</span><span>R${s.register}</span><span>${s.lineCount} lines</span><span>${s.totalQty} qty</span><span class="amt">${fmtMoney(s.total)}</span><span class="t">${fmtDur(s.durationMs)}</span></div>`;
}
function errorRow(e) {
  return `<div class="row errors"><span class="t">${fmtTime(e.time)}</span><span>R${e.register}</span><span>${esc(e.customer)}</span><span>${esc(e.stage)}</span><span>${esc(e.message)}</span><button class="mini-btn" onclick="retry('${e.basketId}')">${T("action.retry", "Retry")}</button></div>`;
}
window.retry = async (basketId) => {
  try { await api("/api/retry", { basketId }); }
  catch (e) { alert(e.message); }
};

function renderWaiting(registers) {
  const list = $("waitingList");
  const rows = [];
  let seq = 1;
  for (const r of registers) {
    for (const c of r.queuePreview || []) {
      rows.push(`<div class="row waiting"><span>${seq++}</span><span>${esc(c.customer.name)}</span><span>R${r.no}</span><span>${c.distinctCount}</span><span>${c.totalQty}</span><span class="t">${estWait(r)}</span></div>`);
      if (rows.length >= 100) break;
    }
    if (rows.length >= 100) break;
  }
  list.innerHTML = rows.length
    ? `<div class="row waiting list-head"><span>${T("list.head.no", "#")}</span><span>${T("list.head.customer", "Customer")}</span><span>${T("list.head.register", "Register")}</span><span>${T("list.head.items", "Items")}</span><span>${T("list.head.qty", "Qty")}</span><span>${T("list.head.estWait", "Est. wait")}</span></div>` + rows.join("")
    : `<div class="empty-note">${T("list.noWaiting", "No customers waiting")}</div>`;
}
function estWait(r) {
  const ms = r.queueQty * 500; // rough estimate for display only
  return fmtDur(ms);
}

function renderStats(registers, m) {
  const grid = $("statsGrid");
  let busiest = null, fastest = null;
  let totalQueue = 0;
  for (const r of registers) {
    totalQueue += r.queueLen;
    if (!busiest || r.queueLen > busiest.queueLen) busiest = r;
    if (r.avgProcessMs > 0 && (!fastest || r.avgProcessMs < fastest.avgProcessMs)) fastest = r;
  }
  const open = registers.filter((r) => r.status !== "Closed").length || 1;
  const cards = [
    [T("stats.customersPerRegister", "Customers / register"), (m.completed / open).toFixed(1)],
    [T("stats.salesPerRegister", "Sales / register"), fmtMoney(m.totalSales / open)],
    [T("stats.avgQueueLength", "Avg queue length"), (totalQueue / (registers.length || 1)).toFixed(1)],
    [T("stats.avgWait", "Avg wait"), fmtDur(m.avgWaitMs)],
    [T("stats.avgCheckout", "Avg checkout"), fmtDur(m.avgProcessMs)],
    [T("stats.busiestRegister", "Busiest register"), busiest ? `R${busiest.no} (${busiest.queueLen})` : "—"],
    [T("stats.fastestRegister", "Fastest register"), fastest ? `R${fastest.no} (${fmtDur(fastest.avgProcessMs)})` : "—"],
    [T("stats.itemsScanned", "Items scanned"), fmtInt(m.itemsScanned)],
  ];
  grid.innerHTML = cards
    .map(([l, v]) => `<div class="stat-card"><div class="s-label">${l}</div><div class="s-value">${v}</div></div>`)
    .join("");
}

/* ---------- Snapshot handling ---------- */
function handleSnapshot(snap) {
  setCurrency(snap.metrics.currency);
  applyStateUI(snap.simState);
  renderKPIs(snap.metrics);
  renderRegisters(snap.registers || []);
  appendRows("activityList", (snap.activity || []).map(activityRow));
  appendRows("completedList", (snap.completed || []).map(completedRow));
  appendRows("errorsList", (snap.errors || []).map(errorRow));
  renderWaiting(snap.registers || []);
  renderStats(snap.registers || [], snap.metrics);
}

/* ---------- SSE ---------- */
function connectStream() {
  const es = new EventSource("/api/events");
  es.onopen = () => $("connDot").classList.add("on");
  es.onerror = () => { $("connDot").classList.remove("on"); };
  es.onmessage = (e) => {
    try { handleSnapshot(JSON.parse(e.data)); } catch { /* ignore malformed */ }
  };
}

/* ---------- Environment check ---------- */
async function runEnvCheck() {
  const box = $("envResults");
  box.classList.remove("hidden");
  box.innerHTML = `<div class="env-item"><span class="env-msg">${T("env.running", "Running checks…")}</span></div>`;
  try {
    const rep = await api("/api/env-check", {});
    box.innerHTML = rep.checks
      .map((c) => `<div class="env-item"><span class="env-badge env-${c.status}">${c.status.toUpperCase()}</span><span class="env-name">${esc(c.name)}</span><span class="env-msg">${esc(c.message)}</span></div>`)
      .join("");
    $("btnStart").disabled = !rep.canRun;
  } catch (e) {
    box.innerHTML = `<div class="env-item"><span class="env-badge env-failed">${T("env.failed", "FAILED")}</span><span class="env-msg">${esc(e.message)}</span></div>`;
  }
}

/* ---------- Utils ---------- */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Wiring ---------- */
function wire() {
  $("btnEnvCheck").onclick = runEnvCheck;
  $("btnStart").onclick = async () => { await saveSettings(); try { await api("/api/start", {}); } catch (e) { alert(e.message); } };
  $("btnPause").onclick = () => api("/api/pause", {}).catch((e) => alert(e.message));
  $("btnResume").onclick = () => api("/api/resume", {}).catch((e) => alert(e.message));
  $("btnStop").onclick = () => api("/api/stop", {}).catch((e) => alert(e.message));
  $("btnReset").onclick = () => api("/api/reset", {}).catch((e) => alert(e.message));
  $("btnAddCustomer").onclick = () => api("/api/add-customer", {}).catch((e) => alert(e.message));
  $("btnOpenReg").onclick = () => {
    const no = parseInt(prompt(T("prompt.openRegister", "Register number to open?")), 10);
    if (no) api("/api/open-register", { no }).catch((e) => alert(e.message));
  };
  $("btnCloseReg").onclick = () => {
    const no = parseInt(prompt(T("prompt.closeRegister", "Register number to close?")), 10);
    if (no) api("/api/close-register", { no }).catch((e) => alert(e.message));
  };
  $("toggleSettings").onclick = () => {
    const body = $("settingsBody");
    body.classList.toggle("hidden");
    $("toggleSettings").textContent = body.classList.contains("hidden")
      ? T("settings.toggle.show", "Show")
      : T("settings.toggle.hide", "Hide");
  };
  $("drawerClose").onclick = closeDrawer;
  $("drawerScrim").onclick = closeDrawer;

  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $("tab-" + t.dataset.tab).classList.add("active");
    };
  });

  for (const f of SETTING_FIELDS) {
    const el = $("s_" + f);
    if (el) el.addEventListener("change", saveSettings);
  }
}

let started = false;
async function init() {
  if (started) return;
  started = true;
  wire();
  try {
    const st = await api("/api/state");
    fillSettings(st.settings);
    setCurrency(st.snapshot.metrics.currency);
    handleSnapshot(st.snapshot);
  } catch (e) {
    console.error(e);
  }
  connectStream();

  // Re-render every dynamic piece of on-screen text when the user switches
  // language via the shared Quentra language switch.
  window.addEventListener("quentra:langchange", () => {
    applyStateUI(lastSimState);
    kpiInit = false;
    if (lastMetrics) renderKPIs(lastMetrics);
    if (regData.size) renderRegisters(Array.from(regData.values()));
    if (openDrawerNo !== null) renderDrawer(regData.get(openDrawerNo));
    $("toggleSettings").textContent = $("settingsBody").classList.contains("hidden")
      ? T("settings.toggle.show", "Show")
      : T("settings.toggle.hide", "Hide");
  });
}

// Boot is triggered from js/main.js once the Quentra language-picker overlay
// has been dismissed (initQuentraApp's onReady), so translated strings are
// available before the panel first renders.
window.CheckoutClassicApp = { start: init };
