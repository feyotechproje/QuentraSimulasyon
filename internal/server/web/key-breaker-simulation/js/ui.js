// ui.js — DOM/telemetry side panels. Reads sim state; throttled by the engine.

import { fmtInt, fmtMs, fmtClock, PSTATE } from "./models.js";
import { Assets } from "./assets.js";

const t = (key, fallback) => (window.QuentraI18n ? window.QuentraI18n.t(key, fallback) : fallback);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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
      qstream: document.getElementById("qstream"),
    };
    this.buildStatic();
    this._lastFeedLen = -1;
    this._qseen = new Map();     // packet id -> { el, st } stream entry
    this._qtime = 0;             // sim clock at last stream sync (reset detection)

    window.addEventListener("quentra:langchange", () => {
      this.buildStatic();
      this._lastFeedLen = -1; // force feed + dependent panels to re-render in new language
      // Stream entries bake translated tags into their markup — rebuild them.
      if (this.el.qstream) { this.el.qstream.innerHTML = ""; this._qseen.clear(); }
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
    this._updateQueryStream();
    this._updateCinematic();
  }

  // ---- outgoing query stream (left column) ----
  // One row per packet headed for the database — attack payloads (hot part
  // highlighted) and the app's parameterised safe queries — with a status
  // badge that tracks the packet's fate live.
  _updateQueryStream() {
    const host = this.el.qstream;
    if (!host) return;
    const s = this.sim;
    if (s.time < this._qtime) { host.innerHTML = ""; this._qseen.clear(); } // sim reset
    this._qtime = s.time;

    const track = (p) => {
      let ent = this._qseen.get(p.id);
      if (!ent) {
        const div = document.createElement("div");
        div.className = "qs-item " + (p.kind === "attack" ? "qs-attack" : "qs-safe");
        div.dataset.qid = p.id;
        let sql, tag;
        if (p.kind === "attack") {
          tag = esc(p.tag);
          const text = esc(p.payload.text), hot = esc(p.payload.hot || "");
          sql = hot ? text.replace(hot, `<span class="qs-hot">${hot}</span>`) : text;
        } else {
          tag = esc(t("qs.safeTag", "SAFE"));
          sql = esc(p.query);
        }
        div.innerHTML =
          `<div class="qs-top"><span class="qs-tag">${tag}</span><span class="qs-status"></span></div>` +
          `<code class="qs-sql">${sql}</code>`;
        host.prepend(div);
        ent = { el: div, st: div.querySelector(".qs-status") };
        this._qseen.set(p.id, ent);
        while (host.children.length > 14) {
          const last = host.lastElementChild;
          this._qseen.delete(last.dataset.qid);
          last.remove();
        }
      }
      const [txt, tone] = this._qStatus(p);
      if (ent.st.textContent !== txt) { ent.st.textContent = txt; ent.st.dataset.tone = tone; }
    };

    for (const p of s.attackPackets) track(p);
    for (const q of s.safePackets) track(q);
  }

  _qStatus(p) {
    if (p.kind === "attack") {
      if (p.reachedDB) return [t("val.reachedDb", "REACHED DB"), "bad"];
      if (p.blocked) return [t("val.blocked", "BLOCKED"), "ok"];
      if (p.state === PSTATE.INSPECTING || p.state === PSTATE.THREAT_CONFIRMED)
        return [t("qs.inspecting", "INSPECTING"), "warn"];
      return [t("qs.transit", "IN TRANSIT"), ""];
    }
    if (p.validated || p.reachedDB) return [t("val.allowed", "ALLOWED"), "ok"];
    return [t("qs.transit", "IN TRANSIT"), ""];
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
