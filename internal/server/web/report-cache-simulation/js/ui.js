// ui.js — DOM dashboard: KPI cards, side panels, feed, location list, inspector.
// Reads simulation state; performs throttled DOM writes only.

import { REPORT } from "./config.js";
import { QuentraI18n } from "/shared/quentra-i18n.js";

const t = (k, f) => QuentraI18n.t(k, f);
function fmt(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? params[k] : "{" + k + "}"));
}

const KPIS = [
  { id:"users",    key:"kpi.users",    label:"Concurrent Users", tone:"purple", get:m => m.users },
  { id:"requests", key:"kpi.requests", label:"Report Requests",  tone:"",       get:m => m.requests },
  { id:"sqlExec",  key:"kpi.sqlExec",  label:"SQL Executions",   tone:"amber",  get:m => m.sqlExec },
  { id:"hits",     key:"kpi.hits",     label:"Cache Hits",       tone:"teal",   get:m => m.hits },
  { id:"misses",   key:"kpi.misses",   label:"Cache Misses",     tone:"",       get:m => m.misses },
  { id:"ratio",    key:"kpi.ratio",    label:"Cache Hit Ratio",  tone:"teal",   get:m => Math.round(m.hitRatio*100)+"%" },
  { id:"avg",      key:"kpi.avg",      label:"Avg Response",     tone:"purple", get:m => fmtMs(m.avgMs) },
  { id:"cpu",      key:"kpi.cpu",      label:"SQL Server CPU",   tone:"red",    get:m => Math.round(m.cpu)+"%" },
  { id:"reads",    key:"kpi.reads",    label:"Logical Reads",    tone:"",       get:m => fmtBig(m.logicalReads) },
  { id:"data",     key:"kpi.data",     label:"Data Returned",    tone:"",       get:m => m.dataMB+" MB" },
  { id:"avoided",  key:"kpi.avoided",  label:"Queries Avoided",  tone:"green",  get:m => m.avoided },
  { id:"saved",    key:"kpi.saved",    label:"Time Saved",       tone:"green",  get:m => (m.timeSavedMs/1000).toFixed(1)+"s" },
];

function fmtMs(ms){ if(!ms) return "—"; return ms>=1000 ? (ms/1000).toFixed(1)+" s" : Math.round(ms)+" ms"; }
function fmtBig(n){ n=Math.round(n); if(n>1e6) return (n/1e6).toFixed(1)+"M"; if(n>1e3) return (n/1e3).toFixed(0)+"K"; return String(n); }
const el = id => document.getElementById(id);
function locName(loc) { return t("loc." + loc.id, loc.name); }

export class UI {
  constructor(sim) {
    this.sim = sim;
    this.feed = [];
    this._buildKpis();
    this._buildLocations();
    this._staticPanels();
    this._bindTone();
  }

  _bindTone() {
    // tones toggle depending on mode for a couple cards
  }

  _buildKpis() {
    const row = el("kpiRow"); row.innerHTML = "";
    this.kpiEls = {};
    for (const k of KPIS) {
      const card = document.createElement("div");
      card.className = "kpi"; if (k.tone) card.dataset.tone = k.tone;
      card.innerHTML = `<span class="kpi-label" data-i18n="${k.key}">${k.label}</span><span class="kpi-value">–</span>`;
      row.appendChild(card);
      this.kpiEls[k.id] = card.querySelector(".kpi-value");
    }
  }

  _buildLocations() {
    const list = el("locList"); list.innerHTML = "";
    this.locEls = {};
    for (const loc of this.sim.world.locations) {
      const cell = document.createElement("div");
      cell.className = "loc-cell"; cell.dataset.loc = loc.id;
      cell.innerHTML =
        `<span class="loc-dot" style="background:#f59e0b"></span>
         <span class="loc-meta"><span class="loc-name">${locName(loc)}</span>
         <span class="loc-sub">–</span></span>
         <span class="loc-src" data-src="sql">${t("loc.sql","SQL")}</span>`;
      cell.addEventListener("click", () => { this.sim.select(loc.id); });
      list.appendChild(cell);
      this.locEls[loc.id] = {
        cell, dot: cell.querySelector(".loc-dot"), name: cell.querySelector(".loc-name"),
        sub: cell.querySelector(".loc-sub"), src: cell.querySelector(".loc-src"),
      };
    }
  }

  _staticPanels() {
    el("currentReport").innerHTML =
      row(t("report.report","Report"), t("report.name",REPORT.name)) + row(t("report.id","Report ID"), REPORT.id, true) +
      row(t("report.queryType","Query Type"), t("report.queryTypeVal",REPORT.queryType)) + row(t("report.resultSize","Result Size"), REPORT.resultSize) +
      row(t("report.baselineExec","Baseline Exec"), t("report.baselineExecVal",REPORT.baselineExec)) + row(t("report.cachedResponse","Cached Response"), REPORT.cachedResponse) +
      row(t("report.concurrent","Concurrent"), REPORT.concurrent) +
      `<div class="detail-row"><span class="k">${t("report.currentSource","Current Source")}</span><span class="v mono" id="crSource">${t("src.sql","SQL SERVER")}</span></div>`;

    el("cacheStatus").innerHTML =
      row(t("cache.state","Cache State"), "—", false, "csState") + row(t("cache.key","Cache Key"), "—", true, "csKey") +
      row(t("report.id","Report ID"), REPORT.id, true) + row(t("cache.stored","Stored At"), "—", true, "csStored") +
      row(t("cache.ttl","TTL"), "—", true, "csTtl") + row(t("cache.size","Cache Size"), "—", false, "csSize") +
      row(t("cache.totalHits","Total Hits"), "0", false, "csHits") + row(t("cache.totalMisses","Total Misses"), "0", false, "csMiss") +
      row(t("cache.savedExec","Saved Executions"), "0", false, "csSaved");

    el("sqlLoad").innerHTML =
      gauge(t("sql.cpu","CPU"),"slCpu") + gauge(t("sql.memory","Memory"),"slMem") + gauge(t("sql.disk","Disk Reads"),"slDisk") +
      row(t("sql.active","Active Queries"),"0",false,"slActive") + row(t("sql.queue","Query Queue"),"0",false,"slQueue") +
      row(t("sql.net","Network Output"),"—",false,"slNet");

    el("inspectClose").addEventListener("click", () => { this.sim.select(null); });

    window.addEventListener("quentra:langchange", () => {
      this._staticPanels();
      for (const loc of this.sim.world.locations) {
        const e = this.locEls[loc.id];
        if (e && e.name) e.name.textContent = locName(loc);
      }
      this._rerenderFeed();
      this.update();
    });
  }

  pushFeed(evt) {
    this.feed.unshift(evt);
    if (this.feed.length > 40) this.feed.pop();
    this._renderFeedItem(evt, true);
  }

  _renderFeedItem(evt, prepend) {
    const f = el("feed");
    const item = document.createElement("div");
    item.className = "feed-item"; item.dataset.kind = evt.kind;
    const text = evt.key ? fmt(t(evt.key, evt.fallback || evt.key), evt.params) : evt.text;
    item.innerHTML = `<span class="feed-time">${evt.time}</span><span class="feed-text">${text}</span>`;
    if (prepend) { f.prepend(item); while (f.children.length > 40) f.removeChild(f.lastChild); }
    return item;
  }

  _rerenderFeed() {
    const f = el("feed");
    f.innerHTML = "";
    for (let i = this.feed.length - 1; i >= 0; i--) f.appendChild(this._renderFeedItem(this.feed[i], false));
  }

  update() {
    const sim = this.sim, m = sim.metrics;
    this._live();
    // clock
    el("simClock").textContent = fmtClock(sim.time);
    // status + mode
    const sp = el("statusPill");
    sp.dataset.state = sim.running ? "running" : "paused";
    el("statusLabel").textContent = sim.running ? t("st.running","SIMULATION RUNNING") : t("st.paused","PAUSED");
    const mp = el("modePill");
    mp.dataset.mode = sim.mode; mp.textContent = sim.mode === "cache" ? t("mode.cache","QUENTRA CACHE") : t("mode.baseline","BASELINE");

    // KPIs. In live mode the measurable ones are replaced by what the server
    // actually recorded; the rest stay as the demo's illustrative values.
    const live = this.backend && this.backend.live ? this.backend.state : null;
    for (const k of KPIS) this.kpiEls[k.id].textContent = k.get(m);
    if (live && live.provisioned) {
      this.kpiEls.requests.textContent = live.requestsTotal;
      this.kpiEls.sqlExec.textContent = live.mode === "quentra" ? live.quentraRuns : live.baselineRuns;
      this.kpiEls.avg.textContent = live.avgLatencyMs ? fmtMs(live.avgLatencyMs) : "—";
      this.kpiEls.data.textContent = fmtBig(live.rowsReturned) + " " + t("live.rows", "rows");
      if (live.sqlCpuPct > 0) this.kpiEls.cpu.textContent = live.sqlCpuPct + "%";
    }

    // current report source
    const isCache = sim.mode === "cache" && sim.cache.state === "READY";
    const src = isCache ? t("src.cache","QUENTRA CACHE") : t("src.sql","SQL SERVER");
    el("crSource").textContent = src;
    const tag = el("reportSourceTag");
    tag.textContent = src; tag.className = "tag " + (isCache ? "tag-teal" : "tag-amber");

    // cache status
    const c = sim.cache;
    const cst = el("cacheStateTag");
    cst.textContent = t("cacheState."+c.state, c.state); cst.className = "tag " + (c.state==="READY"?"tag-teal":c.state==="EMPTY"?"":"tag-purple");
    setV("csState", t("cacheState."+c.state, c.state)); setV("csKey", c.cacheKey || "—");
    setV("csStored", c.storedAt || "—"); setV("csTtl", c.state==="READY"?fmtClock(c.ttl):"—");
    setV("csSize", c.size?c.size+" MB":"—"); setV("csHits", c.hits); setV("csMiss", c.misses);
    setV("csSaved", c.savedExecutions);

    // sql load — in live mode these are REAL readings from the server (SQL
    // Server DMVs, or Windows counters when the DMVs are unreadable). Demo mode
    // keeps the simulated curve. A zero means "not reported", so the simulated
    // value is kept rather than dropping the gauge to nothing.
    const s = sim.sql;
    const useLive = live && live.provisioned;
    const cpu  = useLive && live.sqlCpuPct  > 0 ? live.sqlCpuPct  : s.cpu;
    const mem  = useLive && live.memUsedPct > 0 ? live.memUsedPct : s.memory;
    const disk = useLive && live.diskPct    > 0 ? live.diskPct    : s.diskReads;
    setGauge("slCpu", cpu, cpu>70);
    setGauge("slMem", mem, mem>80);
    setGauge("slDisk", disk, disk>70);
    setV("slActive", Math.round(s.activeQueries));
    setV("slQueue", Math.round(s.queuedQueries));
    setV("slNet", useLive && live.batchPerSec > 0
      ? fmtBig(live.batchPerSec) + " " + t("live.batches", "batch/s")
      : fmtBig(m.dataMB*1024)+" KB/s");

    // Feed the same real numbers to the canvas rack gauges, so the drawn server
    // and the side panel never disagree about how loaded the box is.
    sim.hostLoad = useLive ? { cpu, mem, disk, source: live.metricSource } : null;

    // locations
    for (const loc of sim.world.locations) {
      const e = this.locEls[loc.id];
      e.sub.textContent = `${t("loc.pending","Pending")} ${loc.pending} · ${t("loc.done","Done")} ${loc.completed}` + (loc.avgMs?` · ${fmtMs(loc.avgMs)}`:"");
      e.src.dataset.src = loc.dataSource; e.src.textContent = loc.dataSource==="cache"?t("loc.cache","CACHE"):t("loc.sql","SQL");
      e.dot.style.background = loc.dataSource==="cache" ? "#14b8a6" : (loc.pending>0?"#f59e0b":"#94a3b8");
      e.cell.classList.toggle("is-sel", sim.selected===loc.id);
    }

    // callout
    const co = el("callout");
    if (sim.callout) { co.hidden = false; el("calloutText").textContent = sim.callout.key ? t(sim.callout.key, sim.callout.fallback) : sim.callout; }
    else co.hidden = true;

    this._inspect();
  }

  // Renders the live strip from REAL measured server data. Every value here is
  // something that actually happened: no smoothing, no scripted numbers. When
  // the gateway is caching, quentraAvg drops below directAvg on its own.
  _live() {
    const b = this.backend;
    const strip = el("liveStrip");
    if (!strip) return;
    if (!b || !b.live) { strip.hidden = true; return; }
    strip.hidden = false;

    const s = b.state;
    const badge = el("liveBadge");
    if (!s || !s.provisioned) {
      badge.textContent = t("live.connecting", "CONNECTING…");
      badge.style.background = "#b45309";
      setV("livePath", "—"); setV("liveProc", "—"); setV("liveLast", "—");
      setV("liveAvg", "—"); setV("liveBaseAvg", "—"); setV("liveQuenAvg", "—");
      setV("liveRuns", "—");
      return;
    }

    // Requested "quentra" but the gateway is down -> the worker silently ran
    // direct, so show the path that actually carried the query.
    const viaQuentra = s.mode === "quentra" && s.quentraUp;
    badge.textContent = t("live.badge", "LIVE — REAL SQL");
    badge.style.background = "#dc2626";

    const pathEl = el("livePath");
    if (pathEl) {
      pathEl.textContent = viaQuentra
        ? `Quentra ${s.quentraTarget || ""}`.trim()
        : `SQL ${s.directTarget || ""}`.trim();
      pathEl.dataset.path = viaQuentra ? "quentra" : "baseline";
    }
    setV("liveProc", "SP_REPORT_CACHE_EXAMPLE");
    setV("liveLast", s.lastLatencyMs ? fmtMs(s.lastLatencyMs) : "—");
    setV("liveAvg", s.avgLatencyMs ? fmtMs(s.avgLatencyMs) : "—");
    setV("liveBaseAvg", s.baselineAvgMs ? `${fmtMs(s.baselineAvgMs)} (${s.baselineRuns})` : "—");
    setV("liveQuenAvg", s.quentraAvgMs ? `${fmtMs(s.quentraAvgMs)} (${s.quentraRuns})` : "—");
    setV("liveRuns", `${s.requestsTotal} · ${fmtBig(s.rowsReturned)} ${t("live.rows", "rows")}`);

    const errEl = el("liveErr");
    if (errEl) {
      // Windows counters describe the whole machine, not the SQL process, so
      // say so — otherwise the CPU figure reads as SQL's alone.
      const srcNote = s.metricSource === "windows"
        ? t("live.metricsWin", "Load metrics: Windows counters (whole machine)") : "";
      const msg = s.lastError || (!s.quentraUp && s.mode === "quentra"
        ? t("live.gwDown", "Quentra gateway unreachable — running direct") : srcNote);
      errEl.hidden = !msg;
      errEl.textContent = msg || "";
    }
  }

  _inspect() {
    const sim = this.sim, p = el("pInspect");
    if (!sim.selected) { p.hidden = true; return; }
    p.hidden = false;
    const b = el("inspectBody"), title = el("inspectTitle");
    const s = sim.selected;
    if (s === "sql") {
      title.textContent = t("inspect.sql","SQL Server");
      b.innerHTML = row(t("insp.state","State"), sim.sql.state) + row(t("insp.cpu","CPU"), Math.round(sim.sql.cpu)+"%") +
        row(t("insp.memory","Memory"), Math.round(sim.sql.memory)+"%") + row(t("insp.disk","Disk Reads"), Math.round(sim.sql.diskReads)+"%") +
        row(t("insp.active","Active Queries"), Math.round(sim.sql.activeQueries)) +
        row(t("insp.sameRuns","Same Query Runs"), sim.sql.sameQueryRuns) + row(t("insp.executions","Executions"), sim.metrics.sqlExec);
    } else if (s === "cache") {
      title.textContent = t("inspect.cache","Quentra Cache");
      const c = sim.cache;
      b.innerHTML = row(t("insp.state","State"), t("cacheState."+c.state, c.state)) + row(t("insp.key","Key"), c.cacheKey||"—", true) +
        row(t("insp.ttl","TTL"), c.state==="READY"?fmtClock(c.ttl):"—") + row(t("insp.hits","Hits"), c.hits) +
        row(t("insp.misses","Misses"), c.misses) + row(t("insp.savedExec","Saved Executions"), c.savedExecutions);
    } else if (s === "gateway") {
      title.textContent = t("inspect.gateway","Quentra Gateway");
      b.innerHTML = row(t("insp.cacheLookup","Cache Lookup"), sim.mode==="cache"?t("val.active","ACTIVE"):t("val.bypass","BYPASS")) +
        row(t("insp.requestRouter","Request Router"),t("val.on","ON")) + row(t("insp.queryFingerprint","Query Fingerprint"),t("val.on","ON")) +
        row(t("insp.responseCache","Response Cache"), sim.mode==="cache"?t("val.on","ON"):"—");
    } else {
      const loc = sim.world.locations.find(l => l.id === s);
      if (!loc) { p.hidden = true; return; }
      title.textContent = locName(loc);
      b.innerHTML = row(t("insp.activeUsers","Active Users"), loc.users) + row(t("insp.devices","Devices"), loc.devices.join(", ")) +
        row(t("insp.pending","Pending"), loc.pending) + row(t("insp.completed","Completed"), loc.completed) +
        row(t("insp.avgResponse","Avg Response"), loc.avgMs?fmtMs(loc.avgMs):"—") +
        `<div class="detail-row"><span class="k">${t("insp.dataSource","Data Source")}</span><span class="v mono">${loc.dataSource==="cache"?t("src.cache","QUENTRA CACHE"):t("src.sql","SQL SERVER")}</span></div>`;
    }
  }
}

// ---- html helpers ----
function row(k, v, mono=false, id=null){
  return `<div class="detail-row"><span class="k">${k}</span><span class="v ${mono?"mono":""}"${id?` id="${id}"`:""}>${v}</span></div>`;
}
function gauge(label, id){
  return `<div class="gauge"><div class="gauge-top"><span>${label}</span><span class="gv" id="${id}v">0%</span></div>
    <div class="gauge-track"><div class="gauge-fill" id="${id}" style="width:0%;background:#f59e0b"></div></div></div>`;
}
function setV(id, v){ const n = el(id); if (n) n.textContent = v; }
function setGauge(id, val, hot){
  const f = el(id), v = el(id+"v");
  if (f){ f.style.width = Math.round(val)+"%"; f.style.background = hot?"#ef4444":val<25?"#14b8a6":"#f59e0b"; }
  if (v) v.textContent = Math.round(val)+"%";
}
function fmtClock(sec){
  sec = Math.max(0, Math.floor(sec));
  const m = String(Math.floor(sec/60)).padStart(2,"0");
  const s = String(sec%60).padStart(2,"0");
  return `${m}:${s}`;
}
