// ui.js
// Binds the dashboard DOM to the DUAL simulation: per-bank KPI clusters, the
// shared register grid / event feed / selected-register panel in the middle,
// and the toolbar controls. The engine drives two sims: [0] = direct bank,
// [1] = Quentra bank.

import { ENGINE_STATE } from "./engine.js";
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
      // store-wide KPIs
      kpiTotal: document.getElementById("kpiTotal"),
      kpiSales: document.getElementById("kpiSales"),
      kpiItems: document.getElementById("kpiItems"),
      kpiTpm: document.getElementById("kpiTpm"),
      // per-bank KPI clusters
      kpiDWaiting: document.getElementById("kpiDWaiting"),
      kpiDAvgChk: document.getElementById("kpiDAvgChk"),
      kpiDScan: document.getElementById("kpiDScan"),
      kpiDCompleted: document.getElementById("kpiDCompleted"),
      kpiQWaiting: document.getElementById("kpiQWaiting"),
      kpiQAvgChk: document.getElementById("kpiQAvgChk"),
      kpiQScan: document.getElementById("kpiQScan"),
      kpiQCompleted: document.getElementById("kpiQCompleted"),
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
      btnAuto: document.getElementById("btnAuto"),
      // live start overlay
      liveStart: document.getElementById("liveStart"),
      liveCount: document.getElementById("liveCount"),
      livePresets: document.getElementById("livePresets"),
      btnLiveStart: document.getElementById("btnLiveStart"),
      // stock-lookup before/after panel
      rwScope: document.getElementById("rwScope"),
      rwFoot: document.getElementById("rwFoot"),
      rwBreakdown: document.getElementById("rwBreakdown"),
      // auto-demo narration
      story: document.getElementById("story"),
      storyText: document.getElementById("storyText"),
      storyBar: document.getElementById("storyBar"),
      rwDirect: document.getElementById("rwDirect"),
      rwQuentra: document.getElementById("rwQuentra"),
      rwQuentraBadge: document.getElementById("rwQuentraBadge"),
      rwDirectSql: document.getElementById("rwDirectSql"),
      rwQuentraSql: document.getElementById("rwQuentraSql"),
      rwDirectVal: document.getElementById("rwDirectVal"),
      rwQuentraVal: document.getElementById("rwQuentraVal"),
      rwDirectBar: document.getElementById("rwDirectBar"),
      rwQuentraBar: document.getElementById("rwQuentraBar"),
    };
    this._gridKey = "";
  }

  /**
   * Wire the demo/live switch and the story button to the scenario. When an
   * `onStory` launcher is given, the Story button starts the cinematic guided
   * tour instead of toggling the ambient caption band.
   */
  bindScenario(scenario, onStory) {
    this.scenario = scenario;
    this._storyLauncher = onStory || null;
    const e = this.el;
    if (e.btnDemo) e.btnDemo.addEventListener("click", () => scenario.setRunMode("demo"));
    if (e.btnLive) e.btnLive.addEventListener("click", () => scenario.setRunMode("live"));
    if (e.btnAuto) e.btnAuto.addEventListener("click", () => {
      if (this._storyLauncher) this._storyLauncher();
      else scenario.setAuto(!scenario.auto);
    });
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
    on(e.btnAuto, s.auto);
    // The ambient band is a demo-only affordance; the cinematic tour launcher
    // stays clickable everywhere (it switches back to demo mode itself).
    if (e.btnAuto) e.btnAuto.disabled = !s.isDemo && !this._storyLauncher;

    // Both banks are always active — the comparison is standing, not switched.
    // Demo shows the scripted pretty-printed pair; live shows the app's real
    // statement next to the text captured from SQL Server's DMVs.
    const sql = s.displaySQL || s.sql;
    if (e.rwDirect) e.rwDirect.dataset.active = "true";
    if (e.rwQuentra) e.rwQuentra.dataset.active = "true";
    if (e.rwDirectSql) e.rwDirectSql.textContent = sql.direct;
    if (e.rwQuentraSql) e.rwQuentraSql.textContent = sql.quentra;

    // The Quentra badge must reflect reality: only claim "Call eliminated" when a
    // rewrite actually removed the UDF. With no matching rule the captured SQL
    // still has the call, so the badge says "No rewrite" and drops the fast tone.
    if (e.rwQuentraBadge) {
      const key = s.rewritten ? "rw.quentra.badge" : "rw.quentra.badge.none";
      e.rwQuentraBadge.dataset.i18n = key;
      e.rwQuentraBadge.textContent = t(key, s.rewritten ? "Call eliminated" : "No rewrite");
      e.rwQuentraBadge.classList.toggle("fast", s.rewritten);
      e.rwQuentraBadge.classList.toggle("slow", !s.rewritten);
    }

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
          "Quentra gateway unreachable: both banks use the direct connection, so the comparison is not real.");
      } else {
        e.rwFoot.textContent = s.isDemo
          ? t("rw.foot.demo", "Demo mode plays a fixed 50x separation; no query is executed.")
          : t("rw.foot.live", "Live mode runs the real per-scan query on both banks at once; figures are measured query time.");
      }
    }

    const dMs = s.latencyMs("direct");
    const qMs = s.latencyMs("quentra");
    const dash = "—";
    if (e.rwDirectVal) e.rwDirectVal.textContent = dMs > 0 ? fmtMs(dMs) : dash;
    if (e.rwQuentraVal) e.rwQuentraVal.textContent = qMs > 0 ? fmtMs(qMs) : dash;

    // In live mode spell out how many scans each figure covers, so the numbers
    // are auditable rather than bare totals.
    if (e.rwBreakdown) {
      const total = (s.liveScans ? s.liveScans.direct + s.liveScans.quentra : 0);
      if (s.isDemo || !total) {
        e.rwBreakdown.textContent = "";
      } else {
        let line = fmt(
          t("rw.breakdown2", "Direct {d} scans · Quentra {q} scans"),
          { d: s.liveScans.direct, q: s.liveScans.quentra },
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

    // Live start overlay: presets fill the count input; Start hands the chosen
    // size to the backend and disables itself until the state change lands.
    if (this.el.livePresets) {
      this.el.livePresets.querySelectorAll(".ls-preset").forEach((b) => {
        b.addEventListener("click", () => {
          if (this.el.liveCount) this.el.liveCount.value = b.dataset.count;
          this.el.livePresets.querySelectorAll(".ls-preset").forEach((x) =>
            x.classList.toggle("is-active", x === b));
        });
      });
    }
    if (this.el.btnLiveStart && c.startLive) {
      this.el.btnLiveStart.addEventListener("click", async () => {
        this.el.btnLiveStart.disabled = true;
        try {
          await c.startLive(parseInt(this.el.liveCount && this.el.liveCount.value, 10));
        } finally {
          this.el.btnLiveStart.disabled = false;
        }
      });
    }

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
    this.el.btnPause.disabled = s !== ENGINE_STATE.RUNNING;
    this.el.btnResume.disabled = s !== ENGINE_STATE.PAUSED;
    if (this.el.btnStop) this.el.btnStop.disabled = s === ENGINE_STATE.STOPPED;
  }

  /** Main UI refresh: engine carries both banks ([0] direct, [1] Quentra). */
  update(engine) {
    const sims = engine.sims;
    const left = sims[0], right = sims[1];
    const isLive = typeof left.statusInfo === "function";
    this.renderStory();
    if (isLive) this._syncStatus(left.statusInfo());
    // The start overlay covers the floors whenever live mode is attached but
    // the backend engine is idle — the operator sizes the run before it begins.
    if (this.el.liveStart) {
      const idle = isLive && ["IDLE", "STOPPED", "COMPLETED", "ERROR"].includes(left.simState);
      this.el.liveStart.hidden = !idle;
    }
    this.el.clock.textContent = fmtClock(left.time);

    const lk = left.kpis();
    const rk = right.kpis();

    // Store-wide figures. Live snapshots already report store totals (both
    // banks), so read them once; demo sums the two independent floors.
    const g = isLive ? lk : {
      total: lk.total + rk.total,
      totalSales: lk.totalSales + rk.totalSales,
      itemsScanned: lk.itemsScanned + rk.itemsScanned,
      tpm: lk.tpm + rk.tpm,
    };
    this.el.kpiTotal.textContent = g.total;
    this.el.kpiSales.textContent = left.money(g.totalSales);
    this.el.kpiItems.textContent = g.itemsScanned;
    this.el.kpiTpm.textContent = g.tpm.toFixed(1);

    // Per-bank clusters. Live queue/completed counts come from that bank's own
    // registers; timing splits come from the backend's per-route metrics.
    const sumQ = (sim) => sim.registers.reduce((a, r) => a + (r.queueLength || 0), 0);
    const sumDone = (sim) => sim.registers.reduce((a, r) => a + (r.completedCust || 0), 0);
    const bank = (sim, k, live) => ({
      waiting: live ? sumQ(sim) : k.waiting,
      completed: live ? sumDone(sim) : k.completed,
      avgChk: live ? (sim === left ? k.avgCheckoutDirect : k.avgCheckoutQuentra) : k.avgCheckout,
      scanMs: live ? (sim === left ? k.scanMsDirect : k.scanMsQuentra) : k.scanMs,
    });
    const d = bank(left, lk, isLive);
    const q = bank(right, rk, isLive);

    this.el.kpiDWaiting.textContent = d.waiting;
    this.el.kpiDCompleted.textContent = d.completed;
    this.el.kpiDAvgChk.textContent = d.avgChk.toFixed(1) + "s";
    this.el.kpiDScan.textContent = d.scanMs > 0 ? fmtMs(d.scanMs) : "—";
    this.el.kpiQWaiting.textContent = q.waiting;
    this.el.kpiQCompleted.textContent = q.completed;
    this.el.kpiQAvgChk.textContent = q.avgChk.toFixed(1) + "s";
    this.el.kpiQScan.textContent = q.scanMs > 0 ? fmtMs(q.scanMs) : "—";
    // Severity colours make the slow bank obvious without reading the numbers.
    setSeverity(this.el.kpiDAvgChk, d.avgChk, 8, 20);
    setSeverity(this.el.kpiQAvgChk, q.avgChk, 8, 20);
    setSeverity(this.el.kpiDScan, d.scanMs / 1000, 1, 3);
    setSeverity(this.el.kpiQScan, q.scanMs / 1000, 1, 3);

    this._renderRegisterGrid(sims);
    this._renderFeed(sims);
    this._renderSelected(sims);
  }

  _findRegister(sim, id) {
    return sim.registers.find((r) => r.id === id) || null;
  }

  _routeOf(sims, sim, r) {
    if (r && r.route) return r.route;
    return sims.indexOf(sim) === 1 ? "quentra" : "direct";
  }

  _renderRegisterGrid(sims) {
    const grid = this.el.registerGrid;
    const key = sims.map((s) => s.registers.map((r) => r.id).join(",")).join("|");
    if (this._gridKey !== key) {
      this._gridKey = key;
      grid.innerHTML = "";
      sims.forEach((sim, si) => {
        for (const r of sim.registers) {
          const cell = document.createElement("div");
          cell.className = "reg-cell";
          cell.dataset.id = r.id;
          cell.dataset.sim = si;
          cell.tabIndex = 0;
          cell.setAttribute("role", "button");
          cell.innerHTML = `
            <div class="reg-cell-top"><span class="reg-name">${regLabel(r.id)}</span><span class="reg-queue"></span></div>
            <span class="reg-cashier"></span>
            <div class="reg-bar"><i></i></div>`;
          cell.addEventListener("click", () => this.selectRegister(this.engine, sim, r.id));
          cell.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); this.selectRegister(this.engine, sim, r.id); }
          });
          grid.appendChild(cell);
        }
      });
    }
    for (const cell of grid.children) {
      const sim = sims[Number(cell.dataset.sim)] || sims[0];
      const r = this._findRegister(sim, Number(cell.dataset.id));
      if (!r) continue;
      cell.dataset.route = this._routeOf(sims, sim, r);
      cell.classList.toggle("is-selected", r.id === sim.selectedRegisterId);
      const nameEl = cell.querySelector(".reg-name");
      if (nameEl) nameEl.textContent = regLabel(r.id);
      const cashierEl = cell.querySelector(".reg-cashier");
      if (cashierEl) cashierEl.textContent = r.cashier ? r.cashier.name : "";
      cell.querySelector(".reg-queue").textContent = fmt(t("reg.inLine", "{n} in line"), { n: r.queueLength });
      cell.querySelector(".reg-bar > i").style.width = Math.min(100, r.queueLength * 14) + "%";
    }
  }

  _renderFeed(sims) {
    const events = sims
      .flatMap((s) => s.events)
      .slice()
      .sort((a, b) => b.t - a.t)
      .slice(0, 40);
    this.el.eventFeed.innerHTML = events.map((e) => {
      const label = e.regId != null ? regLabel(e.regId) : (e.source || "");
      const text = e.key ? fmt(t(e.key, e.key), e.params) : (e.text || "");
      return `<div class="feed-item"><span class="feed-time">${fmtClock(e.t)}</span><span class="feed-text"><b>${label}</b> · ${text}</span></div>`;
    }).join("");
  }

  _renderSelected(sims) {
    const sim = sims.find((s) => s.selectedRegister) || null;
    const r = sim ? sim.selectedRegister : null;
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
    const route = this._routeOf(sims, sim, r);
    const routeTag = route === "quentra"
      ? `<span class="state-chip" data-s="QUENTRA" style="border-color:#c7d2fe;color:#4f46e5">Quentra</span>`
      : `<span class="state-chip" data-s="DIRECT" style="border-color:#fde68a;color:#b45309">${t("route.direct", "Direct")}</span>`;
    const c = r.currentCustomer;
    const cashApp = (r.cashier && r.cashier.appearance) || {};
    const cashierName = r.cashier && r.cashier.name ? r.cashier.name : t("cc.cashierOnDuty", "Cashier on duty");
    const scanning = r.state === "SCANNING";
    this.el.selected.innerHTML = `
      <div class="detail-title"><strong>${regLabel(r.id)}</strong>
        ${routeTag}
        <span class="state-chip" data-s="${r.state}">${r.state}</span></div>
      <div class="cc-cashier">
        ${cashierAvatar(cashApp, scanning)}
        <div class="cc-cash-meta">
          <button type="button" class="cc-cash-name" title="${t("cc.cashierSelect", "Select cashier")}">${esc(cashierName)}</button>
          <span class="cc-cash-role">${t("cc.cashierOnDuty", "Cashier on duty")}</span>
          <span class="cc-cash-status">${scanning ? t("cc.scanning", "Scanning items…") : (c ? t("cc.atRegister", "At the register") : t("cc.ready", "Ready"))}</span>
        </div>
      </div>
      ${scanItemBlock(r, sim)}
      ${scannedItemsBlock(r, sim)}
      <div class="detail-row"><span>${t("cc.currentCustomer", "Current customer")}</span><b>${c ? (c.name || "#" + c.id) : "—"}</b></div>
      <div class="detail-row"><span>${t("cc.queueLength", "Queue length")}</span><b>${r.queueLength}</b></div>
      <div class="detail-row"><span>${t("cc.scannedItems", "Scanned items")}</span><b>${c ? c.scannedItems + " / " + c.basketItems : "—"}</b></div>
      <div class="detail-row"><span>${t("cc.basketTotal", "Basket total")}</span><b>${c ? sim.money(c.runningTotal || 0) : "—"}</b></div>
      <div class="detail-row"><span>${t("cc.remainingTime", "Remaining time")}</span><b>${r.currentCustomer ? r.estimatedRemaining().toFixed(1) + "s" : "—"}</b></div>
      <div class="detail-row"><span>${t("cc.lastSale", "Last sale")}</span><b>${r.lastSale ? sim.money(r.lastSale.total) : "—"}</b></div>`;
    const cashierButton = this.el.selected.querySelector(".cc-cash-name");
    if (cashierButton) cashierButton.addEventListener("click", () => this.selectRegister(this.engine, sim, r.id));
  }

  /** Select a register on one bank, clearing any selection on the other. */
  selectRegister(engine, sim, id) {
    const sims = engine ? engine.sims : [sim];
    for (const s of sims) {
      if (s !== sim) s.selectRegister(null);
    }
    sim.selectRegister(id);
    this._renderRegisterGrid(sims);
    this._renderSelected(sims);
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
