// ui.js — DOM/telemetry side panels. Reads sim state; throttled by the engine.

import { fmtInt, fmtMs, fmtClock } from "./models.js";
import { Assets } from "./assets.js";

const t = (key, fallback) => (window.QuentraI18n ? window.QuentraI18n.t(key, fallback) : fallback);

export class UI {
  constructor(sim, ds) {
    this.sim = sim; this.ds = ds;
    this.el = {
      kpiStrip: document.getElementById("kpiStrip"),
      feed: document.getElementById("feed"),
      clock: document.getElementById("simClock"),
      modePill: document.getElementById("modePill"),
      statusPill: document.getElementById("statusPill"),
      statusLabel: document.getElementById("statusLabel"),
      brandMark: document.getElementById("brandMark"),
      cinematic: document.getElementById("cinematic"),
      cinematicText: document.getElementById("cinematicText"),
    };
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

    this._updateFeed();
    this._updateCinematic();
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
