// dashboard.js — renders and drives ONE dashboard column (direct or quentra).
// It owns all DOM inside its mount element and exposes an imperative API used
// by the central controller.

import { int, dec, money, moneyFull, seconds, countUp } from "./format.js";
import { barChart, lineChart, donutChart, hbarChart } from "./charts.js";
import { highlightSQL } from "./sql.js";
import { QuentraI18n } from "/shared/quentra-i18n.js";

const REGION_ORDER = [
  "Marmara", "İç Anadolu", "Ege", "Akdeniz", "Karadeniz", "Güneydoğu Anadolu", "Doğu Anadolu",
];

function t(key, fallback) { return QuentraI18n.t(key, fallback); }

export class Dashboard {
  /** @param {HTMLElement} mount @param {"direct"|"quentra"} mode */
  constructor(mount, mode, meta) {
    this.mount = mount;
    this.mode = mode;
    this.meta = meta;
    this.data = null;
    this.fullData = null;          // untouched full data set (for region list)
    this.kpiCache = {};            // last numeric values for count-up "from"
    this.onRegionPick = null;      // callback(region)
    this._statusKey = "status.idle";
    this._statusCls = "is-idle";
    this._filterRegion = null;
    this._lastDetails = null;
    this._lastPlan = null;
    this._lastMetrics = null;
    this._executing = false;
    this._build();
  }

  /* ---------- DOM scaffolding ---------- */
  _build() {
    const isDirect = this.mode === "direct";
    this.mount.innerHTML = `
      <div class="dh">
        <div class="dh-title">
          <h2 data-title>${this.meta.title}</h2>
          <p data-subtitle>${this.meta.subtitle}</p>
        </div>
        <div class="dh-right">
          <div class="dh-timer">
            <span class="dht-label" data-timer-label>${t("dh.execTime", "Execution Time")}</span>
            <span class="dht-value mono" data-timer>0.00 s</span>
          </div>
          <span class="dh-status is-idle" data-status>${t("status.idle", "Idle")}</span>
        </div>
      </div>
      <div class="dash-body" data-body>
        <div class="filter-chip-row" data-chip>
          <span class="filter-chip-empty">${t("chip.noFilter", "No filter · full data set")}</span>
        </div>

        <div class="kpi-grid" data-kpis></div>

        <div class="widget-columns">
          <div class="wcol">
            <div class="widget">
              <div class="widget-head"><h3 data-w-region>${t("widget.salesByRegion", "Sales by Region")}</h3><span class="wh-note" data-w-masterfilter>${t("widget.masterFilter", "Master filter")}</span></div>
              <div class="region-list" data-regions role="grid" aria-label="Sales by region"></div>
            </div>
            <div class="widget">
              <div class="widget-head"><h3 data-w-gender>${t("widget.genderDistribution", "Gender Distribution")}</h3></div>
              <div class="chart-box" data-gender></div>
            </div>
          </div>

          <div class="wcol">
            <div class="chart-grid">
              <div class="widget">
                <div class="widget-head"><h3 data-w-month>${t("widget.salesByMonth", "Sales by Month")}</h3></div>
                <div class="chart-box" data-month></div>
              </div>
              <div class="widget">
                <div class="widget-head"><h3 data-w-category>${t("widget.salesByCategory", "Sales by Category")}</h3></div>
                <div class="chart-box" data-category></div>
              </div>
              <div class="widget">
                <div class="widget-head"><h3 data-w-trend>${t("widget.orderTrend", "Order Trend")}</h3></div>
                <div class="chart-box" data-trend></div>
              </div>
              <div class="widget">
                <div class="widget-head"><h3 data-w-products>${t("widget.topProducts", "Top Products")}</h3></div>
                <div class="chart-box" data-products></div>
              </div>
            </div>
            <div class="widget">
              <div class="widget-head"><h3 data-w-cities>${t("widget.topCities", "Top Cities")}</h3></div>
              <div data-cities></div>
            </div>
          </div>
        </div>

        <div class="exec">
          <div class="exec-top">
            <span class="exec-title" data-exec-title>${t("exec.queryExecution", "Query Execution")}</span>
            <div class="exec-badges" data-badges></div>
          </div>
          <ul class="exec-stages" data-stages></ul>
          <div class="exec-metrics" data-metrics></div>
          <div style="padding:12px; display:flex; flex-direction:column; gap:10px;" data-queries></div>
        </div>
      </div>`;

    const q = sel => this.mount.querySelector(sel);
    this.el = {
      title: q("[data-title]"),
      subtitle: q("[data-subtitle]"),
      timerLabel: q("[data-timer-label]"),
      wRegion: q("[data-w-region]"),
      wMasterFilter: q("[data-w-masterfilter]"),
      wGender: q("[data-w-gender]"),
      wMonth: q("[data-w-month]"),
      wCategory: q("[data-w-category]"),
      wTrend: q("[data-w-trend]"),
      wProducts: q("[data-w-products]"),
      wCities: q("[data-w-cities]"),
      execTitle: q("[data-exec-title]"),
      status: q("[data-status]"),
      chip: q("[data-chip]"),
      body: q("[data-body]"),
      kpis: q("[data-kpis]"),
      regions: q("[data-regions]"),
      month: q("[data-month]"),
      category: q("[data-category]"),
      cities: q("[data-cities]"),
      trend: q("[data-trend]"),
      products: q("[data-products]"),
      gender: q("[data-gender]"),
      timer: q("[data-timer]"),
      badges: q("[data-badges]"),
      stages: q("[data-stages]"),
      metrics: q("[data-metrics]"),
      queries: q("[data-queries]"),
    };
    this._buildKpis();
  }

  _kpiDefs() {
    return [
      ["totalSales", t("kpi.totalSales", "Total Sales")],
      ["totalOrders", t("kpi.totalOrders", "Total Orders")],
      ["customers", t("kpi.customers", "Customers")],
      ["averageOrderValue", t("kpi.averageOrderValue", "Avg Order Value")],
      ["itemsSold", t("kpi.itemsSold", "Items Sold")],
      ["activeCities", t("kpi.activeCities", "Active Cities")],
    ];
  }

  _buildKpis() {
    const defs = this._kpiDefs();
    this.el.kpis.innerHTML = defs.map(([k, label]) =>
      `<div class="kpi"><div class="kpi-label" data-kpi-label="${k}">${label}</div>` +
      `<div class="kpi-value mono" data-kpi="${k}">–</div></div>`).join("");
    this.kpiEls = {};
    defs.forEach(([k]) => { this.kpiEls[k] = this.el.kpis.querySelector(`[data-kpi="${k}"]`); });
  }

  /* ---------- initial render ---------- */
  render(fullData) {
    this.fullData = fullData;
    this.data = fullData;
    this._renderRegions(fullData, null);
    this._paintKpis(fullData.kpis, false);
    this._paintCharts(fullData);
    this._paintCities(fullData);
  }

  _renderRegions(data, selected) {
    const rows = this.fullData ? this.fullData.salesByRegion : data.salesByRegion;
    const byName = Object.fromEntries((data.salesByRegion || []).map(r => [r.region, r]));
    const maxSales = Math.max(...rows.map(r => r.sales));
    let html = `<div class="region-row region-head" role="row">` +
      `<span>${t("region.header", "Region")}</span><span>${t("region.salesAmount", "Sales Amount")}</span>` +
      `<span class="rr-share">${t("region.share", "Share")}</span><span class="rr-orders">${t("region.orders", "Orders")}</span></div>`;
    for (const name of REGION_ORDER) {
      const base = rows.find(r => r.region === name);
      if (!base) continue;
      const active = byName[name] || base;
      const isSel = selected === name;
      html += `<div class="region-row${isSel ? " is-selected" : ""}" role="row" tabindex="0" data-region="${name}" aria-selected="${isSel}">
          <span class="rr-name">${name}</span>
          <span class="rr-bar-wrap"><span class="rr-bar" style="width:${(active.sales / maxSales * 100).toFixed(1)}%"></span></span>
          <span class="rr-share">${(active.share ?? (active.sales / rows.reduce((s, r) => s + r.sales, 0) * 100)).toFixed(1)}%</span>
          <span class="rr-orders">${int(active.orders)}</span>
        </div>`;
    }
    this.el.regions.innerHTML = html;
    this.el.regions.querySelectorAll("[data-region]").forEach(row => {
      const pick = () => this.onRegionPick && this.onRegionPick(row.dataset.region);
      row.addEventListener("click", pick);
      row.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
      });
    });
  }

  _paintKpis(k, animate) {
    const map = [
      ["totalSales", v => moneyFull(v)],
      ["totalOrders", v => int(v)],
      ["customers", v => int(v)],
      ["averageOrderValue", v => "₺" + dec(v)],
      ["itemsSold", v => int(v)],
      ["activeCities", v => int(v)],
    ];
    for (const [key, fmt] of map) {
      const el = this.kpiEls[key];
      const to = k[key];
      if (animate) countUp(el, to, fmt, { from: this.kpiCache[key] ?? 0, duration: 700 });
      else el.textContent = fmt(to);
      this.kpiCache[key] = to;
    }
  }

  _paintCharts(data) {
    barChart(this.el.month, data.salesByMonth, "sales",
      { color: this.mode === "direct" ? "#8b5cf6" : "#6d3bd1", tip: p => money(p.sales) });
    donutChart(this.el.category, data.salesByCategory);
    lineChart(this.el.trend, data.orderTrend, "orders", { color: "#12b5b0" });
    hbarChart(this.el.products, data.topProducts.map(p => ({ label: `${p.itemName} · ${p.brand}`, value: p.revenue })),
      { fmt: v => moneyFull(v), colors: ["#6d3bd1", "#8b5cf6", "#12b5b0", "#17a673", "#f0a91d"] });
    const g = data.genderDistribution.map(x => ({
      label: x.gender === "K" ? t("gender.female", "Female") : t("gender.male", "Male"), value: x.count,
    }));
    hbarChart(this.el.gender, g, { fmt: v => int(v), colors: ["#8b5cf6", "#12b5b0"] });
  }

  _paintCities(data) {
    // Filled from the exact region "sales by city" query shown in the query
    // panel, which returns only city + sales — so the table is two columns.
    const rows = data.topCities.map(c =>
      `<tr><td>${c.city}</td><td class="num">${moneyFull(c.sales)}</td></tr>`).join("");
    this.el.cities.innerHTML =
      `<table class="dtable"><thead><tr><th>${t("city.city", "City")}</th>` +
      `<th style="text-align:right">${t("city.sales", "Sales")}</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
  }

  /* ---------- state transitions used by the controller ---------- */
  /** @param {string} key i18n key (e.g. "status.idle") @param {string} cls status class */
  setStatus(key, cls) {
    this._statusKey = key;
    this._statusCls = cls;
    this.el.status.textContent = t(key, key);
    this.el.status.className = `dh-status ${cls}`;
  }

  setFilterChip(region) {
    this._filterRegion = region;
    if (!region) {
      this.el.chip.innerHTML = `<span class="filter-chip-empty">${t("chip.noFilter", "No filter · full data set")}</span>`;
      return;
    }
    this.el.chip.innerHTML =
      `<span class="filter-chip">${t("chip.region", "REGION = {region}").replace("{region}", region)}<span class="chip-x">✕</span></span>`;
  }

  markTargetRow(region, on) {
    const row = this.el.regions.querySelector(`[data-region="${region}"]`);
    if (row) row.classList.toggle("is-target", on);
  }

  selectRegion(region) {
    this.el.regions.querySelectorAll("[data-region]").forEach(r => {
      const sel = r.dataset.region === region;
      r.classList.toggle("is-selected", sel);
      r.setAttribute("aria-selected", sel);
    });
  }

  /** Puts chart areas + KPIs into a skeleton/dim loading state. */
  setLoading(on) {
    this.el.body.classList.toggle("is-loading", on);
    [this.el.month, this.el.category, this.el.trend, this.el.products, this.el.gender]
      .forEach(box => box.classList.toggle("is-loading", on));
    this.el.kpis.classList.toggle("is-loading", on);
  }

  /** Applies the filtered data set with count-up + chart re-draw. */
  applyData(data, animate = true) {
    this.data = data;
    this.setLoading(false);
    this._renderRegions(data, data.filter && data.filter.region);
    if (data.filter && data.filter.region) this.selectRegion(data.filter.region);
    this._paintKpis(data.kpis, animate);
    this._paintCharts(data);
    this._paintCities(data);
  }

  setTimer(ms, live) {
    this.el.timer.textContent = seconds(ms);
    this.el.timer.classList.toggle("is-live", !!live);
  }

  setStages(stages) {
    this.el.stages.innerHTML = stages.map(s =>
      `<li class="exec-stage sev-${s.severity}" data-stage="${s.label}">
         <span class="es-icon">•</span><span class="es-spin"></span><span>${s.label}</span>
       </li>`).join("");
    this._stageEls = Array.from(this.el.stages.children);
  }

  activateStage(index) {
    if (!this._stageEls) return;
    this._stageEls.forEach((li, i) => {
      li.classList.toggle("is-active", i === index);
      li.classList.toggle("is-done", i < index);
    });
  }

  finishStages() {
    if (!this._stageEls) return;
    this._stageEls.forEach(li => { li.classList.remove("is-active"); li.classList.add("is-done"); });
  }

  setMetrics(metrics, plan) {
    this.beginMetrics();
    this.finalizeMetrics(metrics, plan);
  }

  _metricDefs() {
    return [
      ["elapsed", t("metric.elapsed", "Elapsed Time")], ["cpu", t("metric.cpu", "CPU Time")],
      ["reads", t("metric.reads", "Logical Reads")], ["rows", t("metric.rows", "Rows Returned")],
      ["exec", t("metric.exec", "Query Executions")], ["plan", t("metric.plan", "Plan")],
    ];
  }

  /** Renders the metric grid skeleton + an "executing" badge set. */
  beginMetrics() {
    this._executing = true;
    const keys = this._metricDefs();
    this.el.metrics.innerHTML = keys.map(([k, l]) =>
      `<div class="exec-metric"><div class="em-label">${l}</div>` +
      `<div class="em-value" data-em="${k}">–</div></div>`).join("");
    this._em = Object.fromEntries(keys.map(([k]) => [k, this.el.metrics.querySelector(`[data-em="${k}"]`)]));
    this.el.badges.innerHTML = `<span class="exec-badge${this.mode === "direct" ? " warn" : ""}">${t("exec.executing", "Executing…")}</span>`;
  }

  /** Interpolates the elapsed / CPU / read counters as progress climbs 0→1. */
  updateMetricsLive(p, m) {
    if (!this._em) return;
    const hot = this.mode === "direct" ? "hot" : "cool";
    this._em.elapsed.textContent = seconds(m.elapsedMs * p); this._em.elapsed.className = "em-value " + hot;
    this._em.cpu.textContent = seconds(m.cpuMs * p); this._em.cpu.className = "em-value " + hot;
    this._em.reads.textContent = int(m.logicalReadPages * p) + " pg"; this._em.reads.className = "em-value " + hot;
    this._em.rows.textContent = p >= 1 ? int(m.rowsReturned) : "0";
    this._em.exec.textContent = int(m.queryExecutions);
    this._em.plan.textContent = p >= 1 ? "" : "…";
  }

  finalizeMetrics(m, plan) {
    this._executing = false;
    this._lastMetrics = m;
    this._lastPlan = plan;
    if (!this._em) this.beginMetrics();
    this.updateMetricsLive(1, m);
    this._em.plan.textContent = plan.accessMethod;
    const badges = [];
    if (this.mode === "direct") {
      badges.push(`<span class="exec-badge bad">${t("badge.implicitDetected", "Implicit Conversion: Detected")}</span>`);
      badges.push(`<span class="exec-badge warn">${t("badge.dashboardRefresh", "Dashboard Refresh: {value}").replace("{value}", plan.dashboardRefresh)}</span>`);
    } else {
      badges.push(`<span class="exec-badge good">${t("badge.implicitRemoved", "Implicit Conversion: Removed")}</span>`);
      badges.push(`<span class="exec-badge good">${t("badge.dashboardRefresh", "Dashboard Refresh: {value}").replace("{value}", plan.dashboardRefresh)}</span>`);
    }
    this.el.badges.innerHTML = badges.join("");
  }

  /** Direct: generated query + issues. Quentra: original + rewritten + optimizations. */
  setQueryDetails(details) {
    this._lastDetails = details;
    const panels = [];
    if (this.mode === "direct") {
      panels.push(this._queryPanel(t("query.generatedQuery", "Generated Query"), details.originalQuery, true));
      panels.push(this._issuePanel(t("query.detectedIssues", "Detected Issues"), details.issues.map(i => i.detail), "bad"));
    } else {
      // The Quentra column shows the REWRITTEN statement — the SQL the gateway
      // actually forwarded — so when a rule matches this panel differs from the
      // Direct column's original. When no rule matches it falls back to the same
      // text, so the panel still renders.
      panels.push(this._queryPanel(t("query.rewrittenQuery", "Rewritten Query"), details.rewrittenQuery, true));
      panels.push(this._issuePanel(t("query.appliedOptimizations", "Applied Optimizations"), details.optimizations, "good"));
    }
    this.el.queries.innerHTML = panels.join("");
    this.el.queries.querySelectorAll(".qpanel-head").forEach(h => {
      h.addEventListener("click", () => h.parentElement.classList.toggle("is-open"));
    });
  }

  _queryPanel(title, sql, open) {
    return `<div class="qpanel${open ? " is-open" : ""}">
        <div class="qpanel-head"><span>${title}</span><span class="qp-caret">▸</span></div>
        <div class="qpanel-body"><pre class="sql">${highlightSQL(sql)}</pre></div>
      </div>`;
  }
  _issuePanel(title, items, cls) {
    return `<div class="qpanel is-open">
        <div class="qpanel-head"><span>${title}</span><span class="qp-caret">▸</span></div>
        <div class="qpanel-body"><ul class="issue-list ${cls}">${items.map(i => `<li>${i}</li>`).join("")}</ul></div>
      </div>`;
  }

  resetExec() {
    this.setTimer(0, false);
    this.el.badges.innerHTML = "";
    this.el.stages.innerHTML = "";
    this.el.metrics.innerHTML = "";
    this.el.queries.innerHTML = "";
    this._stageEls = null;
    this._lastDetails = null;
    this._lastPlan = null;
    this._lastMetrics = null;
    this._executing = false;
  }

  /** Re-renders every static/dynamic label after a "quentra:langchange" event. */
  relabel() {
    this.el.title.textContent = this.meta.title;
    this.el.subtitle.textContent = this.meta.subtitle;
    this.el.timerLabel.textContent = t("dh.execTime", "Execution Time");
    this.el.wRegion.textContent = t("widget.salesByRegion", "Sales by Region");
    this.el.wMasterFilter.textContent = t("widget.masterFilter", "Master filter");
    this.el.wGender.textContent = t("widget.genderDistribution", "Gender Distribution");
    this.el.wMonth.textContent = t("widget.salesByMonth", "Sales by Month");
    this.el.wCategory.textContent = t("widget.salesByCategory", "Sales by Category");
    this.el.wTrend.textContent = t("widget.orderTrend", "Order Trend");
    this.el.wProducts.textContent = t("widget.topProducts", "Top Products");
    this.el.wCities.textContent = t("widget.topCities", "Top Cities");
    this.el.execTitle.textContent = t("exec.queryExecution", "Query Execution");

    // KPI labels.
    this._kpiDefs().forEach(([k, label]) => {
      const lbl = this.el.kpis.querySelector(`[data-kpi-label="${k}"]`);
      if (lbl) lbl.textContent = label;
    });

    this.setStatus(this._statusKey, this._statusCls);
    this.setFilterChip(this._filterRegion);

    // Re-render data-driven widgets (regions table, cities table, charts, gender labels).
    if (this.data) {
      this._renderRegions(this.data, this._filterRegion);
      if (this._filterRegion) this.selectRegion(this._filterRegion);
      this._paintCharts(this.data);
      this._paintCities(this.data);
    }

    // Exec metrics / badges / query panels reflect the last known state.
    if (this._executing) {
      this.beginMetrics();
    } else if (this._lastMetrics && this._lastPlan) {
      this.finalizeMetrics(this._lastMetrics, this._lastPlan);
    }
    if (this._lastDetails) this.setQueryDetails(this._lastDetails);
  }
}
