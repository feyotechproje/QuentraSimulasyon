// ui.js
// DOM layer: caches elements, wires controls + canvas interaction and pushes
// throttled updates into the side panels. Reads simulation state only.

import { adHocSql, procSql } from "./query.js";
import { VEHICLE_TYPES } from "./vehicle.js";
import { GPS_STATE } from "./gps-update.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : n);
const t = (key, fallback) => (window.QuentraI18n ? window.QuentraI18n.t(key, fallback) : fallback);

export class UI {
  constructor(sim, renderer, engine) {
    this.sim = sim; this.renderer = renderer; this.engine = engine;
    this._cache();
    this._wire();
    this._renderRewrite();
    this._feedCount = 0;
    window.addEventListener("quentra:langchange", () => this._onLangChange());
  }

  // Re-render everything that holds translated text but isn't covered by the
  // static [data-i18n] pass (dynamic labels, canvas-independent DOM built from
  // JS templates that embed translated strings/values).
  _onLangChange() {
    this._status();
    this._modeButtons();
    this._renderRewrite();
    this._renderSelected();
    this._renderPlanCache(this.sim, this.sim.mode === "quentra");
    this._renderGpsCurrent(this.sim);
    this._renderRegions(this.sim);
    this._renderSqlStatus(this.sim.metrics.snapshot(this.sim), this.sim.mode === "quentra");
    this._renderFleet(this.sim);
    this._renderSavings(this.sim.metrics.snapshot(this.sim), this.sim.mode === "quentra");
    // Existing feed lines were generated in the previous language; drop them so
    // the next ticks' fresh (already-translated) entries repopulate the panel.
    this.sim.feed.length = 0;
    this.el.feed.innerHTML = "";
    this._feedCount = 0;
    const e = this.el;
    if (e.modeLabel) e.modeLabel.textContent = this.sim.auto.active
      ? t("mode.auto", "Auto Demo")
      : this.sim.mode === "quentra" ? t("mode.quentra", "Quentra") : t("mode.baseline", "Baseline");
  }

  _cache() {
    this.el = {
      statusPill: $("statusPill"), statusLabel: $("statusLabel"), clock: $("simClock"), modeLabel: $("modeLabel"),
      liveDb: $("liveDb"), liveDbLabel: $("liveDbLabel"),
      kConnected: $("kConnected"), kVisible: $("kVisible"), kUpdates: $("kUpdates"), kBatch: $("kBatch"),
      kComp: $("kComp"), kRecomp: $("kRecomp"), kCpu: $("kCpu"), kCache: $("kCache"), kSingle: $("kSingle"),
      kAvgTime: $("kAvgTime"), kDelay: $("kDelay"), kProcessed: $("kProcessed"), kReused: $("kReused"), kAvoided: $("kAvoided"),
      sqlState: $("sqlState"), sqlStatus: $("sqlStatus"),
      queueSub: $("queueSub"), queueBar: $("queueBar"),
      planCache: $("planCache"), gpsCurrent: $("gpsCurrent"),
      selTitle: $("selTitle"), selDetail: $("selDetail"),
      regionList: $("regionList"), fleetList: $("fleetList"), savings: $("savings"), feed: $("feed"),
      rewritePanel: $("rewritePanel"), rewriteTag: $("rewriteTag"),
    };
  }

  _wire() {
    const e = this.engine, s = this.sim;
    // Mode.
    $("btnBaseline").addEventListener("click", () => this._setMode("baseline"));
    $("btnQuentra").addEventListener("click", () => this._setMode("quentra"));
    $("btnAuto").addEventListener("click", () => { s.startAutoDemo(); this._modeButtons(); });
    // Controls.
    $("btnPause").addEventListener("click", () => { e.pause(); this._status(); $("btnPause").disabled = true; $("btnResume").disabled = false; });
    $("btnResume").addEventListener("click", () => { e.resume(); this._status(); $("btnPause").disabled = false; $("btnResume").disabled = true; });
    $("btnStop").addEventListener("click", () => { e.stop(); this._status(); });
    $("btnReset").addEventListener("click", () => { e.reset(); this._status(); $("btnPause").disabled = false; $("btnResume").disabled = true; this._modeButtons(); });
    // Speed.
    document.querySelectorAll(".speed-btn").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll(".speed-btn").forEach((x) => x.classList.remove("is-active"));
        b.classList.add("is-active");
        e.setSpeed(parseFloat(b.dataset.speed));
      }));
    // Layer toggles.
    document.querySelectorAll(".tgl").forEach((b) =>
      b.addEventListener("click", () => {
        b.classList.toggle("is-on");
        const on = b.classList.contains("is-on");
        const layer = b.dataset.layer;
        if (layer === "packets") s.showPackets = on;
        if (layer === "delay") s.showDelay = on;
        if (layer === "traffic") s.showTraffic = on;
        if (layer === "sql") s.showSqlFlow = on;
      }));
    // Canvas picking.
    const canvas = this.renderer.canvas;
    canvas.addEventListener("click", (ev) => {
      const r = canvas.getBoundingClientRect();
      const hit = this.renderer.pick(ev.clientX - r.left, ev.clientY - r.top, s);
      if (!hit) { s.clearSelection(); return; }
      if (hit.kind === "vehicle") s.selectVehicle(hit.ref);
      else s.select(hit.kind, hit.kind === "region" ? hit.ref : hit.ref);
      this._renderSelected();
    });
    $("clearSel").addEventListener("click", () => { s.clearSelection(); this._renderSelected(); });
    // Region list delegation set up on first render.
  }

  _setMode(mode) {
    this.sim.setMode(mode);
    this._modeButtons();
  }
  _modeButtons() {
    const m = this.sim.mode, auto = this.sim.auto.active;
    $("btnBaseline").classList.toggle("is-active", m === "baseline" && !auto);
    $("btnQuentra").classList.toggle("is-active", m === "quentra" && !auto);
    $("btnAuto").classList.toggle("is-active", auto);
  }

  _status() {
    // Status pill removed from the toolbar; keep the guard so the tick is safe.
    const pill = this.el.statusPill;
    if (!pill) return;
    if (this.engine.stopped) { pill.dataset.state = "stopped"; this.el.statusLabel.textContent = t("st.stopped", "DURDURULDU"); }
    else if (this.engine.running) { pill.dataset.state = "running"; this.el.statusLabel.textContent = t("st.running", "RUNNING"); }
    else { pill.dataset.state = "paused"; this.el.statusLabel.textContent = t("st.paused", "PAUSED"); }
  }

  // ---- throttled tick ------------------------------------------------------
  tick() {
    const s = this.sim, m = s.metrics.snapshot(s), e = this.el;
    const q = s.mode === "quentra";
    // Sim-time / mode readouts were removed from the toolbar; update only if present.
    if (e.clock) e.clock.textContent = s.clockLabel();
    if (e.modeLabel) e.modeLabel.textContent = s.auto.active ? t("mode.auto", "Auto Demo") : q ? t("mode.quentra", "Quentra") : t("mode.baseline", "Baseline");
    this._modeButtons();
    this._renderLiveDb(m);

    // KPIs.
    e.kConnected.textContent = fmt(m.connectedVehicles);
    e.kVisible.textContent = fmt(m.visibleVehicles);
    e.kUpdates.textContent = fmt(m.gpsUpdatesPerSec);
    e.kBatch.textContent = fmt(m.batchRequestsPerSec);
    e.kComp.textContent = fmt(m.compilationsPerSec);
    e.kRecomp.textContent = fmt(m.recompilationsPerSec);
    e.kCpu.textContent = m.sqlCpu + "%";
    e.kCache.textContent = m.planCacheUsage + "%";
    e.kSingle.textContent = fmt(m.singleUsePlans);
    e.kAvgTime.textContent = m.averageUpdateTime + " ms";
    e.kDelay.textContent = m.gpsPositionDelay.toFixed(1) + "s";
    e.kProcessed.textContent = fmt(m.updatesProcessed);
    e.kReused.textContent = m.plansReused === "Very High" ? t("plans.veryHigh", "Very High") : t("plans.low", "Low");
    e.kAvoided.textContent = m.compilationsAvoided;
    this._recolorKpi(q);

    this._renderSqlStatus(m, q);
    this._renderQueue(s, m);
    this._renderPlanCache(s, q);
    this._renderGpsCurrent(s);
    this._renderSelected();
    this._renderRegions(s);
    this._renderFleet(s);
    this._renderSavings(m, q);
    this._renderFeed(s);
    this._renderRewrite();
    this._status();
  }

  _renderLiveDb(m) {
    if (!this.el.liveDb) return;
    if (m.live) {
      this.el.liveDb.dataset.live = "true";
      const plans = m.singleUsePlans != null ? fmt(m.singleUsePlans) : "0";
      this.el.liveDbLabel.textContent = t("db.live", "VEHICLEGPS · 100k · {plans} plans").replace("{plans}", plans);
    } else if (this.sim && this.sim.liveMode === false) {
      // Demo mode: no query is running, so "connecting…" would be a lie.
      this.el.liveDb.dataset.live = "demo";
      this.el.liveDbLabel.textContent = t("db.demo", "Demo · simulated, no SQL executed");
    } else {
      this.el.liveDb.dataset.live = "false";
      this.el.liveDbLabel.textContent = t("db.connecting", "VEHICLEGPS · connecting…");
    }
  }

  _recolorKpi(q) {
    // CPU / compilation KPIs turn green under Quentra.
    const map = [["kCpu", "kpi-bad"], ["kComp", "kpi-warn"], ["kRecomp", "kpi-warn"], ["kSingle", "kpi-bad"], ["kDelay", "kpi-bad"]];
    for (const [id, cls] of map) {
      const card = document.getElementById(id).parentElement;
      card.classList.toggle(cls, !q);
      card.classList.toggle("kpi-good", q);
    }
  }

  _renderSqlStatus(m, q) {
    this.el.sqlState.textContent = t("sqlState." + this.sim.sql.state, this.sim.sql.state);
    this.el.sqlState.style.color = q ? "var(--green)" : "var(--red)";
    const rows = [
      [t("ss.cpu", "CPU"), m.sqlCpu + "%", m.sqlCpu, q],
      [t("ss.memory", "Memory"), m.memory + "%", m.memory, q],
      [t("ss.batch", "Batch Req/sec"), fmt(m.batchRequestsPerSec), 100, q],
      [t("ss.comp", "Compilations/sec"), fmt(m.compilationsPerSec), q ? 8 : 100, q],
      [t("ss.recomp", "Recompilations/sec"), fmt(m.recompilationsPerSec), q ? 6 : 100, q],
      [t("ss.active", "Active Updates"), m.activeUpdates, q ? 15 : 90, q],
      [t("ss.queue", "Query Queue"), fmt(m.queuedUpdates), q ? 3 : 100, q],
      [t("ss.avgDur", "Avg Duration"), m.averageUpdateTime + " ms", q ? 20 : 100, q],
    ];
    this.el.sqlStatus.innerHTML = rows.map(([label, val, pct, good]) => `
      <div class="ss-row">
        <div class="ss-label">${label}</div>
        <div class="ss-value">${val}</div>
        <div class="ss-bar"><i style="width:${Math.min(100, pct)}%;background:${good ? "var(--green)" : "var(--red)"}"></i></div>
      </div>`).join("");
  }

  _renderQueue(s, m) {
    // Prefer the measured compile backlog; fall back to the simulated value
    // when running offline (demo mode).
    const qd = m && m.compileWaiters != null ? m.compileWaiters : s.sql.queuedUpdates;
    this.el.queueSub.textContent = fmt(qd);
    // Measured waiter counts are small integers, not the hundreds the old
    // simulated value produced, so scale for that range.
    this.el.queueBar.style.width = Math.min(100, qd * 8) + "%";
    this.el.queueBar.style.background = s.mode === "quentra"
      ? "linear-gradient(90deg,var(--teal),var(--green))"
      : "linear-gradient(90deg,var(--orange),var(--red))";
  }

  _renderPlanCache(s, q) {
    if (q) {
      const pc = s.sql.planCards[0];
      this.el.planCache.innerHTML = `
        <div class="pc-reuse">
          <div class="name">sp_UpdateVehicleState</div>
          <div class="count">${fmt(pc ? pc.useCount : 0)}</div>
          <div class="meta">${t("pc.useStatus", "USE COUNT · STATUS: REUSED")}</div>
        </div>`;
    } else {
      const cards = s.sql.planCards.slice(-24);
      this.el.planCache.innerHTML = `<div class="pc-grid">${cards.map(() => `<div class="pc-card"></div>`).join("")}</div>
        <div class="mini-note">${t("pc.singleNote", "Single-use plans · use count 1 each")}</div>`;
    }
  }

  _renderGpsCurrent(s) {
    // Prefer the selected vehicle's live packet, else any active packet.
    let pk = null;
    if (s.selected && s.selected.kind === "vehicle") {
      pk = s.activeGps.find((p) => p.vehicleNum === s.selected.ref.id) || null;
    }
    if (!pk) pk = s.activeGps.length ? s.activeGps[(s.activeGps.length * 0.5) | 0] : null;
    if (!pk) { this.el.gpsCurrent.innerHTML = `<p class="empty">${t("gps.waiting", "Waiting for a GPS update…")}</p>`; return; }
    const chip = pk.state === GPS_STATE.COMPILING ? "chip-bad" : pk.state === GPS_STATE.PLAN_REUSED ? "chip-good" : "chip-purple";
    const queryTypeLabel = pk.queryType === "Stored Procedure" ? t("query.proc", "Stored Procedure") : t("query.adhoc", "Ad-hoc SQL");
    const rows = [
      [t("gps.vehicle", "Vehicle"), pk.vehicleId], [t("gps.latitude", "Latitude"), pk.latitude], [t("gps.longitude", "Longitude"), pk.longitude],
      [t("gps.speed", "Speed"), pk.speed + " km/h"], [t("gps.heading", "Heading"), pk.heading + "°"], [t("gps.sequence", "Sequence"), fmt(pk.sequenceNo)],
      [t("gps.updateType", "Update Type"), queryTypeLabel],
    ];
    const stateLabel = t("gpsState." + pk.state, pk.state);
    this.el.gpsCurrent.innerHTML = rows.map(([k, v]) => `<div class="gps-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")
      + `<div class="gps-row"><span class="k">${t("gps.queryState", "Query State")}</span><span class="state-chip ${chip}">${stateLabel}</span></div>`
      + `<div class="gps-row"><span class="k">${t("gps.elapsed", "Elapsed")}</span><span class="v">${Math.round(pk.elapsed * 1000)} ms</span></div>`;
  }

  _renderSelected() {
    const s = this.sim, sel = s.selected;
    if (!sel) { this.el.selTitle.textContent = t("sel.title", "Selected"); this.el.selDetail.innerHTML = `<p class="empty">${t("sel.empty", "Click a vehicle, region, Gateway or SQL Server.")}</p>`; return; }
    if (sel.kind === "vehicle") {
      const v = sel.ref, q = s.mode === "quentra";
      this.el.selTitle.textContent = v.vid;
      const chip = q ? "chip-good" : "chip-purple";
      const vType = t("vtype." + v.vehicleType, v.vehicleType);
      const vState = t("vState." + v.state, v.state);
      const rows = [
        [t("sel.type", "Type"), vType], [t("sel.speed", "Speed"), v.speedKmh + " km/h"], [t("sel.heading", "Heading"), Math.round(v.headingDeg) + "°"],
        [t("sel.state", "State"), vState], [t("sel.zone", "Zone"), v.zone || "—"],
        [t("sel.actualPos", "Actual Pos"), `${(41.2 - v.y / 1180 * 0.22).toFixed(6)}, ${(28.85 + v.x / 1720 * 0.30).toFixed(6)}`],
        [t("sel.displayedPos", "Displayed Pos"), `${(41.2 - v.displayedY / 1180 * 0.22).toFixed(6)}, ${(28.85 + v.displayedX / 1720 * 0.30).toFixed(6)}`],
        [t("sel.lastGps", "Last GPS"), s.clockLabel()], [t("sel.queryType", "Query Type"), q ? t("query.proc", "Stored Procedure") : t("query.adhoc", "Ad-hoc SQL")],
      ];
      this.el.selDetail.innerHTML = rows.map(([k, val]) => `<div class="detail-row"><span class="k">${k}</span><span class="v">${val}</span></div>`).join("")
        + `<div class="detail-row"><span class="k">${t("sel.gpsDelay", "GPS Delay")}</span><span class="state-chip ${chip}">${t("sel.seconds", "{n} sec").replace("{n}", v.gpsDelay.toFixed(1))}</span></div>`;
    } else if (sel.kind === "region") {
      const r = s.metrics.regions[sel.ref];
      this.el.selTitle.textContent = r ? t("region." + sel.ref, r.name) : t("sel.zone", "Region");
      if (!r) return;
      const rows = [[t("selr.vehicles", "Active Vehicles"), fmt(r.vehicles)], [t("selr.updates", "GPS Updates/sec"), fmt(r.updates)], [t("selr.avgSpeed", "Avg Speed"), r.avgSpeed + " km/h"], [t("selr.delay", "Position Delay"), r.delay + " s"], [t("selr.load", "Network Load"), r.load + "%"]];
      this.el.selDetail.innerHTML = rows.map(([k, v]) => `<div class="detail-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
    } else if (sel.kind === "gateway") {
      const g = s.gateway;
      this.el.selTitle.textContent = t("sel.gateway", "Quentra Gateway");
      const rows = [[t("selg.fingerprints", "Fingerprints"), fmt(g.fingerprints)], [t("selg.matches", "Rewrite Matches"), fmt(g.rewriteMatches)], [t("selg.params", "Parameters Extracted"), fmt(g.parametersExtracted)], [t("selg.procs", "Procedures Used"), g.proceduresUsed], [t("selg.avoided", "Compilations Avoided"), fmt(g.compilationsAvoided)]];
      this.el.selDetail.innerHTML = rows.map(([k, v]) => `<div class="detail-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
    } else if (sel.kind === "sql" || sel.kind === "planCache" || sel.kind === "opsCenter") {
      const sq = s.sql;
      this.el.selTitle.textContent = sel.kind === "planCache" ? t("sel.planCache", "Plan Cache") : sel.kind === "opsCenter" ? t("sel.opsCenter", "Operations Center") : t("sel.sqlServer", "SQL Server");
      const rows = [[t("sels.cpu", "CPU"), Math.round(sq.cpu) + "%"], [t("sels.comp", "Compilations/sec"), fmt(sq.compilationsPerSecond)], [t("sels.single", "Single-use Plans"), fmt(sq.singleUsePlans)], [t("sels.reusable", "Reusable Plans"), sq.reusablePlans], [t("sels.totalExec", "Total Executions"), fmt(sq.totalExecutions)], [t("sels.avoided", "Compilations Avoided"), fmt(sq.compilationsAvoided)]];
      this.el.selDetail.innerHTML = rows.map(([k, v]) => `<div class="detail-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
    }
  }

  _renderRegions(s) {
    const html = Object.entries(s.metrics.regions).map(([id, r]) => {
      const load = r.load;
      const col = load > 66 ? "var(--red)" : load > 33 ? "var(--orange)" : "var(--green)";
      const selCls = s.selected && s.selected.kind === "region" && s.selected.ref === id ? " sel" : "";
      const name = t("region." + id, r.name);
      const sub = t("ri.sub", "{n} veh · {s} km/h · Δ{d}s").replace("{n}", fmt(r.vehicles)).replace("{s}", r.avgSpeed).replace("{d}", r.delay);
      return `<div class="region-item${selCls}" data-region="${id}">
        <div><div class="ri-name">${name}</div><div class="ri-sub">${sub}</div></div>
        <div class="ri-load"><div class="ss-bar"><i style="width:${load}%;background:${col}"></i></div></div>
      </div>`;
    }).join("");
    if (this.el.regionList.innerHTML !== html) {
      this.el.regionList.innerHTML = html;
      this.el.regionList.querySelectorAll(".region-item").forEach((it) =>
        it.addEventListener("click", () => { s.select("region", it.dataset.region); this._renderSelected(); }));
    }
  }

  _renderFleet(s) {
    const counts = {};
    for (const v of s.vehicles) counts[v.vehicleType] = (counts[v.vehicleType] || 0) + 1;
    const order = VEHICLE_TYPES.map((t) => t.type).filter((t) => counts[t]);
    this.el.fleetList.innerHTML = order.slice(0, 8).map((vt) =>
      `<div class="fleet-item"><span class="ri-name">${t("vtype." + vt, vt)}</span><span class="fi-count">${counts[vt]}</span></div>`).join("");
  }

  _renderSavings(m, q) {
    const cards = q
      ? [["99%+", t("sv.compAvoided", "Compilations Avoided")], ["-62%", t("sv.sqlCpu", "SQL CPU")], ["0.2s", t("sv.gpsDelay", "GPS Delay")], ["5.3x", t("sv.fasterUpdates", "Faster Updates")]]
      : [["0%", t("sv.compAvoided", "Compilations Avoided")], ["94%", t("sv.sqlCpu", "SQL CPU")], ["4.8s", t("sv.gpsDelay", "GPS Delay")], ["1.0x", t("sv.updateSpeed", "Update Speed")]];
    this.el.savings.innerHTML = cards.map(([n, l]) =>
      `<div class="sv-card" style="${q ? "" : "background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.25)"}">
        <div class="sv-num" style="${q ? "" : "color:var(--red)"}">${n}</div><div class="sv-lbl">${l}</div></div>`).join("");
  }

  _renderFeed(s) {
    if (s.feed.length === this._feedCount) return;
    this._feedCount = s.feed.length;
    this.el.feed.innerHTML = s.feed.slice(0, 22).map((ev) =>
      `<div class="feed-item ${ev.kind}">${ev.text}</div>`).join("");
  }

  _renderRewrite() {
    const s = this.sim, q = s.mode === "quentra";
    // Representative payload (selected vehicle or a stable sample).
    const v = s.selected && s.selected.kind === "vehicle" ? s.selected.ref : s.vehicles[0];
    const u = {
      vehicleNum: v ? v.id + 154000 : 154283,
      latitude: v ? +(41.2 - v.y / 1180 * 0.22).toFixed(6) : 41.123456,
      longitude: v ? +(28.85 + v.x / 1720 * 0.30).toFixed(6) : 28.987654,
      speed: v ? v.speedKmh : 82, heading: v ? Math.round(v.headingDeg) : 146,
    };
    this.el.rewriteTag.textContent = q ? t("tag.param", "PARAMETERIZED") : t("tag.adhoc", "AD-HOC");
    this.el.rewriteTag.style.color = q ? "var(--green)" : "var(--red)";
    const adhoc = adHocSql(u), proc = procSql(u);
    const adhocHtml = adhoc.lines.map((l) => `<div class="sql-line">${esc(l.t)}${l.lit ? `<span class="lit">${esc(l.lit)}</span>` : ""}</div>`).join("");
    const procHtml = proc.lines.map((l) => {
      const lt = esc(l.t).replace(/(@\w+)/, `<span class="param">$1</span>`);
      return `<div class="sql-line">${lt}${l.val ? `<span class="pval">${esc(l.val)}</span>` : ""}</div>`;
    }).join("");
    this.el.rewritePanel.innerHTML = `
      <div class="sql-box adhoc">${adhocHtml}</div>
      <div class="rewrite-arrow"><div class="ar">${q ? "⟶" : "⟶"}</div><div class="lbl">${t("rw.label", "QUENTRA<br>REWRITE")}</div></div>
      <div class="sql-box proc" style="${q ? "" : "opacity:0.45"}">${procHtml}</div>`;
  }
}

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
