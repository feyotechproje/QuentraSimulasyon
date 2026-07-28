// ui.js
// Binds the dashboard DOM to the simulation: KPI cards, register grid, event
// feed, selected-register detail panel and the toolbar controls.

import { ENGINE_STATE } from "./engine.js";
import { REGISTER_STATE } from "./checkout.js";
import { QuentraI18n } from "/shared/quentra-i18n.js";

const t = (k, f) => QuentraI18n.t(k, f);
function fmt(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? params[k] : "{" + k + "}"));
}
function regLabel(id) {
  return t("reg.short", "Register") + " " + String(id).padStart(2, "0");
}

export class UI {
  constructor() {
    this.el = {
      statusPill: document.getElementById("statusPill"),
      statusLabel: document.getElementById("statusLabel"),
      clock: document.getElementById("simClock"),
      kpiTotal: document.getElementById("kpiTotal"),
      kpiWaiting: document.getElementById("kpiWaiting"),
      kpiInCheckout: document.getElementById("kpiInCheckout"),
      kpiCompleted: document.getElementById("kpiCompleted"),
      kpiSales: document.getElementById("kpiSales"),
      kpiItems: document.getElementById("kpiItems"),
      kpiAvgCheckout: document.getElementById("kpiAvgCheckout"),
      kpiAvgQueue: document.getElementById("kpiAvgQueue"),
      // per-route breakdown under the two timing KPIs
      kpiAvgCheckoutSplit: document.getElementById("kpiAvgCheckoutSplit"),
      kpiChkDirect: document.getElementById("kpiChkDirect"),
      kpiChkQuentra: document.getElementById("kpiChkQuentra"),
      kpiTpm: document.getElementById("kpiTpm"),
      registerGrid: document.getElementById("registerGrid"),
      eventFeed: document.getElementById("eventFeed"),
      selected: document.getElementById("selectedRegister"),
      btnPause: document.getElementById("btnPause"),
      btnResume: document.getElementById("btnResume"),
      btnStop: document.getElementById("btnStop"),
      btnReset: document.getElementById("btnReset"),
      // scenario switch
      btnDemo: document.getElementById("btnDemo"),
      btnLive: document.getElementById("btnLive"),
      btnDirect: document.getElementById("btnDirect"),
      btnQuentra: document.getElementById("btnQuentra"),
      btnAuto: document.getElementById("btnAuto"),
      // stock-lookup before/after panel
      rwScope: document.getElementById("rwScope"),
      rwFoot: document.getElementById("rwFoot"),
      rwBreakdown: document.getElementById("rwBreakdown"),
      // auto-demo narration
      story: document.getElementById("story"),
      storyStep: document.getElementById("storyStep"),
      storyText: document.getElementById("storyText"),
      storyBar: document.getElementById("storyBar"),
      rwDirect: document.getElementById("rwDirect"),
      rwQuentra: document.getElementById("rwQuentra"),
      rwDirectSql: document.getElementById("rwDirectSql"),
      rwQuentraSql: document.getElementById("rwQuentraSql"),
      rwDirectVal: document.getElementById("rwDirectVal"),
      rwQuentraVal: document.getElementById("rwQuentraVal"),
      rwDirectBar: document.getElementById("rwDirectBar"),
      rwQuentraBar: document.getElementById("rwQuentraBar"),
    };
    this._gridBuilt = false;
  }

  /**
   * Fill a KPI's direct-vs-Quentra breakdown. A comparison is useful only when
   * both routes have samples; showing one route below the active value merely
   * repeats the same number and looks like a second unexplained metric.
   */
  _renderSplit(wrap, elDirect, elQuentra, direct, quentra) {
    if (!wrap) return;
    if (!direct || !quentra) { wrap.hidden = true; return; }
    wrap.hidden = false;
    if (elDirect) elDirect.textContent = t("scn.direct", "Direct") + " " + direct.toFixed(1) + "s";
    if (elQuentra) elQuentra.textContent = "Quentra " + quentra.toFixed(1) + "s";
  }

  /** Wire the demo/live and direct/Quentra switches to the scenario controller. */
  bindScenario(scenario) {
    this.scenario = scenario;
    const e = this.el;
    if (e.btnDemo) e.btnDemo.addEventListener("click", () => scenario.setRunMode("demo"));
    if (e.btnLive) e.btnLive.addEventListener("click", () => scenario.setRunMode("live"));
    if (e.btnDirect) e.btnDirect.addEventListener("click", () => scenario.selectConnection("direct"));
    if (e.btnQuentra) e.btnQuentra.addEventListener("click", () => scenario.selectConnection("quentra"));
    if (e.btnAuto) e.btnAuto.addEventListener("click", () => scenario.setAuto(!scenario.auto));
    this.renderScenario();
  }

  /**
   * Paint the auto-demo caption. Called every UI frame so the beat's progress
   * bar advances smoothly; the text itself is only rewritten when the beat
   * actually changes, otherwise the entrance animation would restart nonstop.
   */
  renderStory() {
    const s = this.scenario;
    const e = this.el;
    if (!s || !e.story) return;

    const beat = s.beat;
    if (!beat) {
      e.story.hidden = true;
      this._beatShown = null;
      return;
    }
    e.story.hidden = false;

    if (this._beatShown !== beat) {
      this._beatShown = beat;
      e.story.dataset.tone = beat.tone || "neutral";
      e.storyText.textContent = t(beat.key, beat.fallback);
      e.storyStep.textContent = `${(s.beatIndex || 0) + 1}/${s.beatCount}`;
      // Replay the entrance animation for the new caption.
      e.story.style.animation = "none";
      void e.story.offsetWidth;
      e.story.style.animation = "";
    }
    if (e.storyBar) {
      const pct = beat.hold > 0 ? Math.min(1, s.beatProgress()) * 100 : 0;
      e.storyBar.style.width = pct + "%";
    }
  }

  /** Repaint the scenario buttons and the before/after comparison panel. */
  renderScenario() {
    const s = this.scenario;
    if (!s) return;
    const e = this.el;

    this.renderStory();

    const on = (el, active) => { if (el) el.classList.toggle("is-active", !!active); };
    on(e.btnDemo, s.isDemo);
    on(e.btnLive, !s.isDemo);
    on(e.btnDirect, !s.isQuentra);
    on(e.btnQuentra, s.isQuentra);
    on(e.btnAuto, s.auto);
    // Auto-cycling is a demo-only affordance; live mode is operator-driven.
    if (e.btnAuto) e.btnAuto.disabled = !s.isDemo;

    if (e.rwDirect) e.rwDirect.dataset.active = String(!s.isQuentra);
    if (e.rwQuentra) e.rwQuentra.dataset.active = String(s.isQuentra);
    if (e.rwDirectSql) e.rwDirectSql.textContent = s.sql.direct;
    if (e.rwQuentraSql) e.rwQuentraSql.textContent = s.sql.quentra;

    if (e.rwScope) {
      e.rwScope.dataset.live = String(!s.isDemo);
      e.rwScope.textContent = s.isDemo
        ? t("rw.scope.demo", "Demo — simulated")
        : t("rw.scope.live", "Live — measured");
    }
    if (e.rwFoot) {
      if (!s.isDemo && s.gatewayUp === false) {
        // Never let a down gateway read as a genuine comparison.
        e.rwFoot.textContent = t("rw.foot.noGateway",
          "Quentra gateway unreachable: both modes use the direct connection, so the comparison is not real.");
      } else {
        e.rwFoot.textContent = s.isDemo
          ? t("rw.foot.demo", "Demo mode plays a fixed 50x separation; no query is executed.")
          : t("rw.foot.live", "Live mode runs the real per-scan query; figures are measured query time.");
      }
    }

    const dMs = s.latencyMs("direct");
    const qMs = s.latencyMs("quentra");
    const dash = "—";
    if (e.rwDirectVal) e.rwDirectVal.textContent = dMs > 0 ? fmtMs(dMs) : dash;
    if (e.rwQuentraVal) e.rwQuentraVal.textContent = qMs > 0 ? fmtMs(qMs) : dash;

    // In live mode spell out what the per-scan figure is made of, so the number
    // is auditable rather than a bare total.
    if (e.rwBreakdown) {
      if (s.isDemo || !s.liveSamples) {
        e.rwBreakdown.textContent = "";
      } else {
        let line = fmt(
          t("rw.breakdown", "Active mode: {total} per scanned item · {n} scans"),
          { total: fmtMs(s.liveAvgMs), n: s.liveSamples },
        );
        // Never present an average as clean when queries were failing.
        if (s.liveErrors > 0) {
          line += " · " + fmt(t("rw.errors", "{n} failed (excluded)"), { n: s.liveErrors });
        }
        e.rwBreakdown.textContent = line;
      }
    }

    // Bars are scaled against the slower of the two so the ratio reads directly.
    const peak = Math.max(dMs, qMs, 1);
    if (e.rwDirectBar) e.rwDirectBar.style.width = (dMs > 0 ? (dMs / peak) * 100 : 0) + "%";
    if (e.rwQuentraBar) e.rwQuentraBar.style.width = (qMs > 0 ? (qMs / peak) * 100 : 0) + "%";
  }

  bind(engine, controls) {
    this.engine = engine;
    const c = controls || engine;
    this.el.btnPause.addEventListener("click", () => c.pause());
    this.el.btnResume.addEventListener("click", () => c.resume());
    this.el.btnStop.addEventListener("click", () => c.stop());
    this.el.btnReset.addEventListener("click", () => c.reset());

    document.querySelectorAll(".speed-btn").forEach((b) => {
      b.addEventListener("click", () => {
        c.setSpeed(parseFloat(b.dataset.speed));
        document.querySelectorAll(".speed-btn").forEach((x) => x.classList.remove("is-active"));
        b.classList.add("is-active");
      });
    });

    this.syncControls(engine);
  }

  _syncStatus(info) {
    this.el.statusPill.dataset.state = info.state;
    this.el.statusLabel.textContent = info.key ? t(info.key, info.label) : info.label;
    this.el.btnPause.disabled = !info.canPause;
    this.el.btnResume.disabled = !info.canResume;
    if (this.el.btnStop) this.el.btnStop.disabled = info.state === "stopped";
  }

  syncControls(engine) {
    const s = engine.state;
    const map = {
      [ENGINE_STATE.RUNNING]: ["running", "st.running"],
      [ENGINE_STATE.PAUSED]: ["paused", "st.paused"],
      [ENGINE_STATE.STOPPED]: ["stopped", "st.stopped"],
    };
    const [state, key] = map[s];
    this.el.statusPill.dataset.state = state;
    this.el.statusLabel.textContent = t(key, key);
    // Pause is available only while running; Resume ONLY while paused. "Stopped"
    // is terminal — Resume cannot continue it (use Reset), so it must be disabled
    // rather than look clickable and do nothing.
    this.el.btnPause.disabled = s !== ENGINE_STATE.RUNNING;
    this.el.btnResume.disabled = s !== ENGINE_STATE.PAUSED;
    // Stop is pointless once stopped; Reset is the way back.
    if (this.el.btnStop) this.el.btnStop.disabled = s === ENGINE_STATE.STOPPED;
  }

  update(sim, engine) {
    const k = sim.kpis();
    this.renderStory();
    if (typeof sim.statusInfo === "function") this._syncStatus(sim.statusInfo());
    this.el.clock.textContent = fmtClock(sim.time);
    this.el.kpiTotal.textContent = k.total;
    this.el.kpiWaiting.textContent = k.waiting;
    this.el.kpiInCheckout.textContent = k.inCheckout;
    this.el.kpiCompleted.textContent = k.completed;
    this.el.kpiSales.textContent = sim.money(k.totalSales);
    this.el.kpiItems.textContent = k.itemsScanned;
    this.el.kpiAvgCheckout.textContent = k.avgCheckout.toFixed(1) + "s";
    this.el.kpiAvgQueue.textContent = k.avgQueue.toFixed(1) + "s";
    // Both timing KPIs shift colour with severity and pulse once they turn bad,
    // so the slow path is obvious without reading the numbers.
    setSeverity(this.el.kpiAvgCheckout, k.avgCheckout, 8, 20);
    setSeverity(this.el.kpiAvgQueue, k.avgQueue, 15, 40);
    // Direct vs Quentra breakdown, shown once either route has samples.
    this._renderSplit(this.el.kpiAvgCheckoutSplit, this.el.kpiChkDirect, this.el.kpiChkQuentra,
      k.avgCheckoutDirect, k.avgCheckoutQuentra);
    this.el.kpiTpm.textContent = k.tpm.toFixed(1);

    this._renderRegisterGrid(sim);
    this._renderFeed(sim);
    this._renderSelected(sim);
  }

  _renderRegisterGrid(sim) {
    const grid = this.el.registerGrid;
    if (!this._gridBuilt) {
      grid.innerHTML = "";
      for (const r of sim.registers) {
        const cell = document.createElement("div");
        cell.className = "reg-cell";
        cell.dataset.id = r.id;
        cell.tabIndex = 0;
        cell.setAttribute("role", "button");
        cell.innerHTML = `
          <div class="reg-cell-top"><span class="reg-name">${regLabel(r.id)}</span><span class="reg-queue"></span></div>
          <span class="reg-cashier"></span>
          <div class="reg-bar"><i></i></div>`;
        cell.addEventListener("click", () => this.selectRegister(sim, r.id));
        cell.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); this.selectRegister(sim, r.id); }
        });
        grid.appendChild(cell);
      }
      this._gridBuilt = true;
    }
    for (const cell of grid.children) {
      const r = sim.registers[Number(cell.dataset.id) - 1];
      cell.classList.toggle("is-selected", r.id === sim.selectedRegisterId);
      const nameEl = cell.querySelector(".reg-name");
      if (nameEl) nameEl.textContent = regLabel(r.id);
      const cashierEl = cell.querySelector(".reg-cashier");
      if (cashierEl) cashierEl.textContent = r.cashier ? r.cashier.name : "";
      cell.querySelector(".reg-queue").textContent = fmt(t("reg.inLine", "{n} in line"), { n: r.queueLength });
      cell.querySelector(".reg-bar > i").style.width = Math.min(100, r.queueLength * 14) + "%";
    }
  }

  _renderFeed(sim) {
    this.el.eventFeed.innerHTML = sim.events.map((e) => {
      const label = e.regId != null ? regLabel(e.regId) : (e.source || "");
      const text = e.key ? fmt(t(e.key, e.key), e.params) : (e.text || "");
      return `<div class="feed-item"><span class="feed-time">${fmtClock(e.t)}</span><span class="feed-text"><b>${label}</b> · ${text}</span></div>`;
    }).join("");
  }

  _renderSelected(sim) {
    const r = sim.selectedRegister;
    if (!r) {
      this.el.selected.innerHTML = `
        <div class="cc-empty">
          <svg class="cc-art" viewBox="0 0 200 160" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="ccp" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a855f7"/><stop offset="1" stop-color="#6d28d9"/></linearGradient>
              <linearGradient id="ccc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>
            </defs>
            <ellipse cx="100" cy="132" rx="66" ry="14" fill="#22d3ee" opacity="0.12"/>
            <path d="M60 96l40-20 40 20-40 20z" fill="url(#ccp)" opacity="0.85"/>
            <path d="M60 96l40 20v22l-40-20z" fill="#4c1d95" opacity="0.8"/>
            <path d="M140 96l-40 20v22l40-20z" fill="#6d28d9" opacity="0.8"/>
            <path d="M74 60l30-15 30 15-30 15z" fill="#0e1524" stroke="url(#ccc)" stroke-width="2"/>
            <path d="M84 57l20-10 20 10-20 10z" fill="url(#ccc)" opacity="0.85"/>
            <path d="M104 45V24" stroke="url(#ccc)" stroke-width="2" stroke-linecap="round"/>
            <circle cx="104" cy="20" r="5" fill="#5eead4"/>
            <circle cx="104" cy="20" r="9" fill="#5eead4" opacity="0.25"/>
          </svg>
          <p class="muted">${t("cc.selectFloor", "Select register<br/>on the floor<br/>to see live checkout details.")}</p>
        </div>`;
      return;
    }
    const c = r.currentCustomer;
    const cashApp = (r.cashier && r.cashier.appearance) || {};
    const cashierName = r.cashier && r.cashier.name ? r.cashier.name : t("cc.cashierOnDuty", "Cashier on duty");
    const scanning = r.state === "SCANNING";
    this.el.selected.innerHTML = `
      <div class="detail-title"><strong>${regLabel(r.id)}</strong>
        <span class="state-chip" data-s="${r.state}">${r.state}</span></div>
      <div class="cc-cashier">
        ${cashierAvatar(cashApp, scanning)}
        <div class="cc-cash-meta">
          <button type="button" class="cc-cash-name" title="${t("cc.cashierSelect", "Select cashier")}">${esc(cashierName)}</button>
          <span class="cc-cash-role">${t("cc.cashierOnDuty", "Cashier on duty")}</span>
          <span class="cc-cash-status">${scanning ? t("cc.scanning", "Scanning items\u2026") : (c ? t("cc.atRegister", "At the register") : t("cc.ready", "Ready"))}</span>
        </div>
      </div>
      ${scanItemBlock(r, sim)}
      ${scannedItemsBlock(r, sim)}
      <div class="detail-row"><span>${t("cc.currentCustomer", "Current customer")}</span><b>${c ? (c.name || "#" + c.id) : "\u2014"}</b></div>
      <div class="detail-row"><span>${t("cc.queueLength", "Queue length")}</span><b>${r.queueLength}</b></div>
      <div class="detail-row"><span>${t("cc.scannedItems", "Scanned items")}</span><b>${c ? c.scannedItems + " / " + c.basketItems : "—"}</b></div>
      <div class="detail-row"><span>${t("cc.basketTotal", "Basket total")}</span><b>${c ? sim.money(c.runningTotal || 0) : "—"}</b></div>
      <div class="detail-row"><span>${t("cc.remainingTime", "Remaining time")}</span><b>${r.currentCustomer ? r.estimatedRemaining().toFixed(1) + "s" : "—"}</b></div>
      <div class="detail-row"><span>${t("cc.lastSale", "Last sale")}</span><b>${r.lastSale ? sim.money(r.lastSale.total) : "—"}</b></div>`;
    const cashierButton = this.el.selected.querySelector(".cc-cash-name");
    if (cashierButton) cashierButton.addEventListener("click", () => this.selectRegister(sim, r.id));
  }

  selectRegister(sim, id) {
    sim.selectRegister(id);
    this._renderRegisterGrid(sim);
    this._renderSelected(sim);
  }
}

/**
 * The item currently under the scanner, for the selected-register panel.
 *
 * Live mode carries the real QUENTRA_RETAIL product on the register snapshot. Demo
 * mode uses the built-in product catalogue with the same display contract.
 */
function scanItemBlock(r, sim) {
  const name = r.activeItem || "";
  if (!name) return "";
  const qty = r.activeQty || 0;
  const unit = r.activeUnitPrice || 0;
  const line = r.activeLineTotal || unit * qty;
  const qtyTxt = qty && qty !== 1 ? ` × ${qty % 1 ? qty.toFixed(2) : qty}` : "";
  const query = r.activeQueryMs > 0 ? fmtMs(r.activeQueryMs) : "—";
  return `
      <div class="cc-scan">
        <span class="cc-scan-label">${t("cc.scanningItem", "Scanning")}</span>
        <span class="cc-scan-product"><b class="cc-scan-name" title="${esc(name)}">${esc(name)}</b><small>${esc(r.activeItemCode || "—")} · ${t("cc.queryTime", "Query")} ${query}</small></span>
        <span class="cc-scan-price">${sim.money(line)}<small>${esc(sim.money(unit))}${qtyTxt}</small></span>
      </div>`;
}

function scannedItemsBlock(r, sim) {
  const items = Array.isArray(r.scannedItems) ? r.scannedItems : [];
  if (!items.length) return `<div class="cc-products-empty">${t("cc.noScannedProducts", "No products scanned at this register yet.")}</div>`;
  const start = Math.max(0, items.length - 8);
  const rows = items.slice(start).reverse().map((item, reverseIndex) => {
    const sequence = items.length - reverseIndex;
    return `
      <div class="cc-product-row">
        <span class="cc-product-seq">${String(sequence).padStart(2, "0")}</span>
        <span class="cc-product-main"><b>${esc(item.name || item.code || "Ürün")}</b><small>${esc(item.code || "—")}${item.brand ? " · " + esc(item.brand) : ""}${item.category ? " · " + esc(item.category) : ""}</small></span>
        <span class="cc-product-query"><b>${fmtMs(item.queryMs || 0)}</b><small>${esc(routeLabel(item.route))}</small></span>
        <span class="cc-product-total"><b>${sim.money(item.lineTotal || 0)}</b><small>${formatQty(item.quantity)} × ${sim.money(item.unitPrice || 0)}</small></span>
      </div>`;
  }).join("");
  return `<section class="cc-products"><div class="cc-products-head"><span>${t("cc.scannedProductDetails", "Scanned product details")}</span><b>${items.length}</b></div>${rows}</section>`;
}

function routeLabel(route) {
  return route === "quentra" ? "Quentra" : route === "direct" ? t("route.direct", "Direct") : "—";
}

function formatQty(value) {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// Product names come from the database, so escape before interpolating.
function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function fmtClock(sec) {
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

// Latency for the before/after panel: sub-second stays in ms, above that reads
// in seconds so a 2.5s scalar-UDF call is legible at a glance.
function fmtMs(ms) {
  return ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : Math.round(ms) + "ms";
}

// Tag a timing KPI as ok / warn / bad. CSS colours it and pulses the bad state.
// Written only on change so the pulse animation is not restarted every frame.
function setSeverity(el, value, warnAt, badAt) {
  if (!el) return;
  const level = value >= badAt ? "bad" : value >= warnAt ? "warn" : "ok";
  if (el.dataset.sev !== level) el.dataset.sev = level;
}

// Front-facing cashier bust built from the register cashier's own appearance
// colours (skin / hair / navy uniform). Purely cosmetic SVG.
function cashierAvatar(app, active) {
  const skin = app.skin || "#e8b48c";
  const hair = app.hair || "#2b2118";
  const shirt = app.shirt || "#4338ca";
  const bun = app.hairStyle === "bun";
  return `
  <svg class="cc-face" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="ccring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>
      <clipPath id="ccclip"><circle cx="32" cy="32" r="29"/></clipPath>
    </defs>
    <circle cx="32" cy="32" r="30" fill="#0b1220" stroke="url(#ccring)" stroke-width="2"/>
    <g clip-path="url(#ccclip)">
      <rect x="3" y="3" width="58" height="58" fill="#101a30"/>
      ${bun ? `<circle cx="32" cy="15" r="5" fill="${hair}"/>` : ""}
      <path d="M13 62 Q32 41 51 62 Z" fill="${shirt}"/>
      <path d="M27 46 l5 9 5-9 Z" fill="#0b1220" opacity=".45"/>
      <rect x="28.5" y="34" width="7" height="9" rx="3" fill="${skin}"/>
      <circle cx="32" cy="26" r="11.5" fill="${skin}"/>
      <path d="M20.5 25 Q22 12 32 12 Q42 12 43.5 25 Q41 18 32 17.5 Q23 18 20.5 25 Z" fill="${hair}"/>
    </g>
    <circle cx="50" cy="15" r="5" fill="${active ? "#5eead4" : "#64748b"}" stroke="#0b1220" stroke-width="2"/>
  </svg>`;
}
