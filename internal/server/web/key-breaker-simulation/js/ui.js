// ui.js — DOM/telemetry side panels. Reads sim state; throttled by the engine.

import { ATTACK_TYPES } from "./config.js";
import { fmtInt, fmtMs, fmtClock } from "./models.js";
import { Assets } from "./assets.js";

const t = (key, fallback) => (window.QuentraI18n ? window.QuentraI18n.t(key, fallback) : fallback);

const SEV_LABEL = { critical: "sev.critical", high: "sev.high", medium: "sev.medium" };
const ATTACK_TYPE_KEY = {
  TAUTOLOGY: "atype.TAUTOLOGY",
  UNION: "atype.UNION",
  STACKED: "atype.STACKED",
  AUTH_BYPASS: "atype.AUTH_BYPASS",
  CMD_EXEC: "atype.CMD_EXEC",
  TIME_BLIND: "atype.TIME_BLIND",
  COMMENT: "atype.COMMENT",
  INFO_SCHEMA: "atype.INFO_SCHEMA",
  ERROR_BASED: "atype.ERROR_BASED",
};
function attackTypeLabel(typeKey, fallback) {
  const i18nKey = ATTACK_TYPE_KEY[typeKey];
  return i18nKey ? t(i18nKey, fallback) : fallback;
}

export class UI {
  constructor(sim, ds) {
    this.sim = sim; this.ds = ds;
    this.el = {
      kpiStrip: document.getElementById("kpiStrip"),
      attackerList: document.getElementById("attackerList"),
      distList: document.getElementById("distList"),
      inspector: document.getElementById("inspector"),
      inspectorTitle: document.getElementById("inspectorTitle"),
      serverBox: document.getElementById("serverBox"),
      feed: document.getElementById("feed"),
      kbStatus: document.getElementById("kbStatus"),
      pipeline: document.getElementById("pipeline"),
      clock: document.getElementById("simClock"),
      modePill: document.getElementById("modePill"),
      statusPill: document.getElementById("statusPill"),
      statusLabel: document.getElementById("statusLabel"),
      trend: document.getElementById("trend"),
      brandMark: document.getElementById("brandMark"),
      cinematic: document.getElementById("cinematic"),
      cinematicText: document.getElementById("cinematicText"),
    };
    this.trendCtx = this.el.trend.getContext("2d");
    this.buildStatic();
    this._lastFeedLen = -1;

    window.addEventListener("quentra:langchange", () => {
      this.buildStatic();
      this._lastFeedLen = -1; // force feed + dependent panels to re-render in new language
      this.update();
    });
  }

  buildStatic() {
    this._brand();
    this._buildKpis();
    this._buildAttackers();
    this._buildPipeline();
  }

  _brand() {
    const logo = Assets.get("logo") || Assets.get("icon");
    if (logo) {
      const img = document.createElement("img");
      img.src = logo.src; img.alt = "Quentra";
      this.el.brandMark.appendChild(img);
    } else {
      // vector Quentra "Q" mark (purple/green)
      this.el.brandMark.innerHTML = `
      <svg viewBox="0 0 40 40" width="40" height="40">
        <defs><linearGradient id="qg" x1="0" y1="0" x2="40" y2="40">
          <stop offset="0" stop-color="#22e39a"/><stop offset="1" stop-color="#9d7bff"/>
        </linearGradient></defs>
        <circle cx="20" cy="20" r="14" fill="none" stroke="url(#qg)" stroke-width="3.4" stroke-dasharray="66 22" stroke-linecap="round"/>
        <path d="M20 26 q8 2 12 8" fill="none" stroke="url(#qg)" stroke-width="3.4" stroke-linecap="round"/>
      </svg>`;
    }
  }

  _buildKpis() {
    this.kpiDefs = [
      { id: "detected", key: "kpi.detected", label: "Attacks Detected", cls: "" },
      { id: "blocked", key: "kpi.blocked", label: "Attacks Blocked", cls: "k-red" },
      { id: "safe", key: "kpi.safe", label: "Safe Queries Allowed", cls: "k-teal" },
      { id: "accuracy", key: "kpi.accuracy", label: "Threat Accuracy", cls: "" },
      { id: "resp", key: "kpi.resp", label: "Avg Response Time", cls: "k-teal" },
      { id: "sources", key: "kpi.sources", label: "Active Sources", cls: "k-amber" },
      { id: "highrisk", key: "kpi.highrisk", label: "High-Risk Events", cls: "k-amber" },
      { id: "incidents", key: "kpi.incidents", label: "False Positives", cls: "" },
      { id: "dbstatus", key: "kpi.dbstatus", label: "Database Status", cls: "" },
      { id: "qps", key: "kpi.qps", label: "Queries Inspected/sec", cls: "k-purple" },
    ];
    this.el.kpiStrip.innerHTML = this.kpiDefs.map(k =>
      `<div class="kpi ${k.cls}"><div class="kpi-label" id="kl-${k.id}">${t(k.key, k.label)}</div><div class="kpi-val" id="kv-${k.id}">–</div></div>`
    ).join("");
  }

  _buildAttackers() {
    const html = this.ds.attackers().map(a => {
      const info = ATTACK_TYPES[a.type];
      const pl = this.ds.payload(a.type);
      return `<div class="atk-card" data-id="${a.id}">
        <div class="atk-top"><span class="atk-id">${a.id}</span><span class="atk-risk">${t("atk.risk", "RISK")} ${info.risk}</span></div>
        <div class="atk-ip">${a.ip}</div>
        <div class="atk-type">${attackTypeLabel(a.type, info.label)}</div>
        <div class="atk-payload">${this._hot(pl)}</div>
      </div>`;
    }).join("");
    this.el.attackerList.innerHTML = html;
    this.el.attackerList.querySelectorAll(".atk-card").forEach(card => {
      card.addEventListener("click", () => {
        const a = this.sim.world.attackers.find(x => x.id === card.dataset.id);
        this.sim.select({ type: "attacker", ref: a });
      });
    });
  }

  _buildPipeline() {
    const steps = [
      ["pipe.received", "Request Received"],
      ["pipe.fingerprint", "SQL Fingerprint"],
      ["pipe.syntax", "Syntax Analysis"],
      ["pipe.pattern", "Pattern Match"],
      ["pipe.risk", "Risk Assessment"],
      ["pipe.decision", "Decision"],
      ["pipe.blockAllow", "Block / Allow"],
    ];
    this.el.pipeline.innerHTML = steps.map(([key, fallback], i) =>
      `<div class="pipe-step" id="ps-${i}"><span class="ps-num">${i + 1}</span><span>${t(key, fallback)}</span></div>`
    ).join("");
  }

  _hot(pl) {
    if (!pl) return "";
    const esc = (s) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (!pl.hot) return esc(pl.text);
    const idx = pl.text.indexOf(pl.hot);
    if (idx < 0) return esc(pl.text);
    return esc(pl.text.slice(0, idx)) +
      `<span style="color:#ff5a68;font-weight:800">${esc(pl.hot)}</span>` +
      esc(pl.text.slice(idx + pl.hot.length));
  }

  update() {
    const s = this.sim, m = s.metrics;
    const active = s.protectionActive();

    // toolbar
    this.el.clock.textContent = fmtClock(s.time);
    const mode = s.autoDemo ? "auto" : (active ? "active" : "off");
    this.el.modePill.dataset.mode = mode;
    this.el.modePill.textContent = s.autoDemo ? t("mode.pill.auto", "AUTO DEMO") : (active ? t("mode.pill.active", "KEY BREAKER ACTIVE") : t("mode.pill.off", "PROTECTION OFF"));
    this.el.statusPill.dataset.state = s.paused ? "paused" : "running";
    this.el.statusLabel.textContent = s.paused ? t("status.paused", "SIMULATION PAUSED") : t("status.running", "SIMULATION RUNNING");

    // KPIs
    const set = (id, val, cls) => {
      const el = document.getElementById("kv-" + id);
      el.textContent = val;
      el.className = "kpi-val" + (cls ? " " + cls : "");
    };
    set("detected", fmtInt(m.attacksDetected));
    set("blocked", active ? fmtInt(m.attacksBlocked) : "0", active ? "v-green" : "v-red");
    set("safe", fmtInt(m.safeAllowed), "v-teal");
    set("accuracy", active ? m.threatAccuracy.toFixed(2) + "%" : t("val.disabled", "DISABLED"), active ? "v-green" : "v-red");
    set("resp", fmtMs(m.avgResponseMs), active ? "v-teal" : "v-amber");
    set("sources", String(m.activeSources), "v-amber");
    set("highrisk", fmtInt(m.highRisk), "v-amber");
    document.getElementById("kl-incidents").textContent = active ? t("kpi.falsePositives", "False Positives") : t("kpi.incidents", "Incidents");
    set("incidents", active ? "0" : fmtInt(m.incidents), active ? "v-green" : "v-red");
    set("dbstatus", active ? t("val.secure", "SECURE") : t("val.atRisk", "AT RISK"), active ? "v-green" : "v-red");
    set("qps", active ? fmtInt(m.queriesPerSec) : "—", "v-purple");

    this._updateInspector();
    this._updateServer(active);
    this._updateFeed();
    this._updateKbStatus(active);
    this._updatePipeline(active);
    this._updateDist();
    this._updateAttackerSel();
    this._drawTrend();
    this._updateCinematic();
  }

  _updateAttackerSel() {
    const sel = this.sim.selection;
    this.el.attackerList.querySelectorAll(".atk-card").forEach(c => {
      const on = sel.type === "attacker" && sel.ref && sel.ref.id === c.dataset.id;
      c.classList.toggle("sel", !!on);
    });
  }

  _updateInspector() {
    const sel = this.sim.selection;
    const titleEl = this.el.inspectorTitle, box = this.el.inspector;
    const tt = t;
    const row = (k, v, cls = "") => `<div class="detail-row"><span class="dk">${k}</span><span class="dv ${cls}">${v}</span></div>`;

    if (sel.type === "attacker" && sel.ref) {
      const a = sel.ref, info = ATTACK_TYPES[a.type];
      titleEl.textContent = tt("insp.attackSource", "Attack Source");
      box.innerHTML =
        row(tt("row.sourceIp", "Source IP"), a.ip) + row(tt("row.attackType", "Attack Type"), attackTypeLabel(a.type, info.label)) +
        row(tt("row.attacksSent", "Attacks Sent"), a.count) + row(tt("row.riskLevel", "Risk Level"), info.risk + " / 100", "bad") +
        row(tt("row.severity", "Severity"), tt(SEV_LABEL[info.sev], info.sev) || info.sev, "bad") +
        row(tt("row.status", "Status"), `<span class="state-chip blocked">${tt("val.monitored", "MONITORED")}</span>`);
      return;
    }
    if (sel.type === "keybreaker") {
      const s = this.sim;
      titleEl.textContent = tt("insp.keyBreaker", "Key Breaker");
      box.innerHTML =
        row(tt("row.shield", "Shield"), s.protectionActive() ? tt("val.active", "ACTIVE") : tt("val.standby", "STANDBY"), s.protectionActive() ? "ok" : "bad") +
        row(tt("row.integrity", "Integrity"), Math.round(Math.min(100, s.shieldIntensity * 100)) + "%", "ok") +
        row(tt("row.totalBlocked", "Total Blocked"), fmtInt(s.metrics.attacksBlocked), "ok") +
        row(tt("row.safeAllowed", "Safe Allowed"), fmtInt(s.metrics.safeAllowed), "ok") +
        row(tt("row.decisionTime", "Decision Time"), fmtMs(s.metrics.avgResponseMs));
      return;
    }
    if (sel.type === "database") {
      const active = this.sim.protectionActive();
      titleEl.textContent = tt("insp.database", "Database Server");
      box.innerHTML =
        row(tt("row.engine", "Engine"), "SQL Server") +
        row(tt("row.status", "Status"), active ? tt("val.secure", "SECURE") : tt("val.atRisk", "AT RISK"), active ? "ok" : "bad") +
        row(tt("row.connection", "Connection"), active ? tt("val.protected", "PROTECTED") : tt("val.exposed", "EXPOSED"), active ? "ok" : "bad") +
        row(tt("row.incidents", "Incidents"), active ? "0" : fmtInt(this.sim.metrics.incidents), active ? "ok" : "bad") +
        row(tt("row.safeQueries", "Safe Queries"), fmtInt(this.sim.metrics.safeAllowed), "ok");
      return;
    }
    if (sel.type === "safe" && sel.ref && !sel.ref.dead) {
      const q = sel.ref;
      titleEl.textContent = tt("insp.safeQuery", "Safe Query");
      box.innerHTML =
        row(tt("row.query", "Query"), `<span class="dv code">${q.query}</span>`) +
        row(tt("row.riskScore", "Risk Score"), "2 / 100", "ok") +
        row(tt("row.decision", "Decision"), tt("val.allow", "ALLOW"), "ok") +
        row(tt("row.response", "Response"), fmtMs(q.responseMs)) +
        row(tt("row.status", "Status"), `<span class="state-chip allowed">${tt("val.allowed", "ALLOWED")}</span>`);
      return;
    }

    // default: current attack
    const p = this.sim.currentAttack();
    titleEl.textContent = tt("insp.currentAttack", "Current Attack");
    if (!p) { box.innerHTML = `<div class="empty-note">${tt("empty.noAttack", "No active attack.<br/>Waiting for malicious traffic…")}</div>`; return; }
    const active = this.sim.protectionActive();
    box.innerHTML =
      row(tt("row.attackId", "Attack ID"), p.id) +
      row(tt("row.source", "Source"), p.ip) +
      row(tt("row.attackType", "Attack Type"), attackTypeLabel(p.attackType, p.typeLabel)) +
      row(tt("row.payload", "Payload"), `<span class="dv code">${this._hotStr(p.payload)}</span>`) +
      row(tt("row.riskScore", "Risk Score"), p.risk + " / 100", "bad") +
      row(tt("row.matchedPattern", "Matched Pattern"), `<span class="dv code">${p.pattern}</span>`) +
      row(tt("row.decision", "Decision"), active ? tt("val.block", "BLOCK") : tt("val.reachedDb", "REACHED DB"), active ? "ok" : "bad") +
      row(tt("row.response", "Response"), fmtMs(p.responseMs)) +
      row(tt("row.status", "Status"), active
        ? `<span class="state-chip blocked">${tt("val.blocked", "BLOCKED")}</span>`
        : `<span class="state-chip blocked">${tt("val.incident", "INCIDENT")}</span>`);
  }

  _hotStr(pl) {
    const esc = (s) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (!pl || !pl.hot) return esc(pl ? pl.text : "");
    const i = pl.text.indexOf(pl.hot);
    if (i < 0) return esc(pl.text);
    return esc(pl.text.slice(0, i)) + `<span style="color:#ff5a68">${esc(pl.hot)}</span>` + esc(pl.text.slice(i + pl.hot.length));
  }

  _updateServer(active) {
    const m = this.sim.metrics;
    this.el.serverBox.innerHTML = `
      <div class="srv-state ${active ? "secure" : "risk"}">
        <span class="srv-dot"></span>
        <div class="srv-txt"><b>${active ? t("val.secure", "SECURE") : t("val.atRisk", "AT RISK")}</b>
          <span>${active ? t("srv.opOk", "All systems operational") : t("srv.opBad", "Malicious query detected · incident active")}</span></div>
      </div>
      <div class="srv-metrics">
        <div class="srv-metric">${t("srv.cpu", "CPU")} <b>${active ? "34%" : "88%"}</b></div>
        <div class="srv-metric">${t("srv.activeQ", "Active Q")} <b>${active ? "12" : "41"}</b></div>
        <div class="srv-metric">${t("srv.queryDur", "Query Dur")} <b>${active ? "0.18 ms" : "6.4 ms"}</b></div>
        <div class="srv-metric">${t("srv.threatPrev", "Threat Prev")} <b class="${active ? "" : ""}" style="color:${active ? "#22e39a" : "#ff4d5e"}">${active ? t("val.enabled", "ENABLED") : t("val.disabled", "DISABLED")}</b></div>
        <div class="srv-metric">${t("srv.incidents", "Incidents")} <b>${active ? "0" : fmtInt(m.incidents)}</b></div>
        <div class="srv-metric">${t("srv.batch", "Batch/s")} <b>${fmtInt(active ? 20000 : 8200)}</b></div>
      </div>`;
  }

  _updateFeed() {
    if (this.sim.events.items.length === this._lastFeedLen &&
        this.el.feed.dataset.first === (this.sim.events.items[0]?.time || "")) return;
    this._lastFeedLen = this.sim.events.items.length;
    this.el.feed.dataset.first = this.sim.events.items[0]?.time || "";
    this.el.feed.innerHTML = this.sim.events.items.map(e =>
      `<div class="feed-item ${e.kind ? "f-" + e.kind : ""}"><span class="feed-time">${e.time}</span><span class="feed-text">${e.text}</span></div>`
    ).join("");
  }

  _updateKbStatus(active) {
    const s = this.sim;
    const rows = [
      [t("kb.status", "Status"), active ? t("val.active", "ACTIVE") : t("val.standby", "STANDBY"), active ? "on" : "off"],
      [t("kb.shieldIntegrity", "Shield Integrity"), Math.round(Math.min(100, s.shieldIntensity * 100)) + "%", active ? "on" : "warn"],
      [t("kb.sqlParser", "SQL Parser"), active ? t("val.online", "ONLINE") : t("val.idle", "IDLE"), active ? "on" : "warn"],
      [t("kb.patternEngine", "Pattern Engine"), active ? t("val.online", "ONLINE") : t("val.idle", "IDLE"), active ? "on" : "warn"],
      [t("kb.behavior", "Behavior Analysis"), active ? t("val.learning", "LEARNING") : t("val.idle", "IDLE"), active ? "warn" : "warn"],
      [t("kb.policy", "Policy Engine"), active ? t("val.enforcing", "ENFORCING") : t("val.off", "OFF"), active ? "on" : "off"],
      [t("kb.attacksBlocked", "Attacks Blocked"), fmtInt(s.metrics.attacksBlocked), "on"],
      [t("kb.decisionTime", "Decision Time"), fmtMs(s.metrics.avgResponseMs), ""],
    ];
    this.el.kbStatus.innerHTML = rows.map(([k, v, c]) =>
      `<div class="kb-row"><span class="kk">${k}</span><span class="kv ${c}">${v}</span></div>`
    ).join("");
  }

  _updatePipeline(active) {
    const step = active && this.sim.pipelineActive ? this.sim.pipelineStep : -1;
    const bad = this.sim.lastDecision && this.sim.lastDecision.block;
    for (let i = 0; i < 7; i++) {
      const el = document.getElementById("ps-" + i);
      if (!el) continue;
      el.classList.toggle("on", i <= step);
      el.classList.toggle("bad", i <= step && bad && i >= 3);
    }
  }

  _updateDist() {
    const m = this.sim.metrics.byType;
    const entries = Object.entries(ATTACK_TYPES);
    const max = Math.max(1, ...entries.map(([k]) => m[k] || 0));
    this.el.distList.innerHTML = entries
      .filter(([k]) => (m[k] || 0) > 0)
      .sort((a, b) => (m[b[0]] || 0) - (m[a[0]] || 0))
      .slice(0, 7)
      .map(([k, info]) => {
        const c = m[k] || 0;
        const label = attackTypeLabel(k, info.label);
        return `<div class="dist-row"><span class="dist-name">${label.split(" ")[0]}</span>
          <span class="dist-bar"><i style="width:${(c / max) * 100}%"></i></span>
          <span class="dist-cnt">${c}</span></div>`;
      }).join("") || `<div class="empty-note">${t("empty.noAttacksRecorded", "No attacks recorded yet.")}</div>`;
  }

  _drawTrend() {
    const c = this.el.trend, ctx = this.trendCtx;
    const r = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    const data = this.sim.metrics.trend;
    if (data.length < 2) return;
    const pad = 6, w = r.width - pad * 2, h = r.height - pad * 2;
    const maxB = Math.max(1, ...data.map(d => d.blocked));
    const maxA = Math.max(1, ...data.map(d => d.allowed));
    const line = (key, max, color) => {
      ctx.beginPath();
      data.forEach((d, i) => {
        const x = pad + (i / (data.length - 1)) * w;
        const y = pad + h - (d[key] / max) * h;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.shadowColor = color; ctx.shadowBlur = 6;
      ctx.stroke(); ctx.shadowBlur = 0;
    };
    line("allowed", maxA, "#22e39a");
    line("blocked", maxB, "#ff4d5e");
    // legend
    ctx.font = "9px 'Segoe UI'";
    ctx.fillStyle = "#ff4d5e"; ctx.fillText("● " + t("trend.blocked", "Blocked"), pad, 10);
    ctx.fillStyle = "#22e39a"; ctx.fillText("● " + t("trend.allowed", "Allowed"), pad + 54, 10);
  }

  _updateCinematic() {
    const cap = this.sim.caption;
    if (cap) {
      this.el.cinematicText.textContent = cap.text;
      this.el.cinematic.classList.add("show");
      this.el.cinematic.classList.toggle("danger", !!cap.danger);
    } else {
      this.el.cinematic.classList.remove("show");
    }
  }
}
