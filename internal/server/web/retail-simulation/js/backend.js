// backend.js
// Bridges the visual layer to the REAL Go simulation engine (which reads
// QUENTRA_RETAIL for checkout transactions, products and stock reads).
//
// BackendClient  -> talks to the existing HTTP/SSE API (/api/*).
// ApiSimulation  -> exposes the same surface the Renderer/UI/Engine expect, but
//                   its state is reconciled from live SSE snapshots instead of a
//                   local in-memory model.

import { WORLD, buildWorld, queueSlot, arrivalWaypoints, approachWaypoints, departWaypoints } from "./world.js";
import { Customer, CUSTOMER_STATE } from "./customer.js";
import { Cashier } from "./cashier.js";
import { REGISTER_STATE } from "./checkout.js";
import { InMemoryDemoDataSource } from "./datasource.js";

// ------------------------------------------------------------------ client ---
export class BackendClient {
  constructor(base = "") { this.base = base; this.es = null; }

  async getState() {
    const r = await fetch(this.base + "/api/state");
    if (!r.ok) throw new Error("state " + r.status);
    return r.json();
  }
  async getSettings() {
    const r = await fetch(this.base + "/api/settings");
    return r.ok ? r.json() : null;
  }
  async _post(path, body) {
    try {
      const r = await fetch(this.base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return r.ok ? r.json().catch(() => ({})) : null;
    } catch { return null; }
  }
  /** Current stock-lookup scenario + the exact SQL run on each side. */
  async getStockMode() {
    const r = await fetch(this.base + "/api/stock-mode");
    return r.ok ? r.json() : null;
  }
  /** Switch the per-scan stock lookup: "off" | "baseline" | "quentra". */
  setStockMode(mode) { return this._post("/api/stock-mode", { mode }); }

  start() { return this._post("/api/start"); }
  pause() { return this._post("/api/pause"); }
  resume() { return this._post("/api/resume"); }
  stop() { return this._post("/api/stop"); }
  reset() { return this._post("/api/reset"); }
  configure(settings) { return this._post("/api/settings", settings); }

  /** Subscribe to the live snapshot stream. Auto-reconnects. */
  connect(onSnapshot) {
    const open = () => {
      this.es = new EventSource(this.base + "/api/events");
      this.es.onmessage = (ev) => {
        try { onSnapshot(JSON.parse(ev.data)); } catch { /* keep-alive */ }
      };
      this.es.onerror = () => {
        this.es.close();
        setTimeout(open, 1500);
      };
    };
    open();
  }
}

// ------------------------------------------------------------- reconciler ---
const SCAN_SEC_FALLBACK = 0.4;

// Keep the floor and the overview cards visually consistent for normal queue
// sizes. Extremely long stress-test queues remain capped to keep rendering
// bounded, while the card continues to report the exact backend total.
const MAX_VISIBLE_QUEUE = WORLD.visibleQueueSlots;

function mapStatus(s) {
  switch (s) {
    case "Scanning": return REGISTER_STATE.SCANNING;
    case "Printing Receipt": return REGISTER_STATE.RECEIPT;
    case "Waiting": return REGISTER_STATE.UNLOADING;
    case "Idle":
    case "Closed":
    case "Paused":
    case "Error":
    default: return REGISTER_STATE.IDLE;
  }
}

export class ApiSimulation {
  /**
   * @param {number} registerCount registers on THIS floor (one bank of the store)
   * @param {object} [opts] idOffset: first register number minus one, so the
   *        right bank renders backend registers 06..10 on its own canvas.
   */
  constructor(registerCount, opts = {}) {
    this.data = new InMemoryDemoDataSource((Date.now() & 0xffff) || 7); // visuals only
    this.idOffset = opts.idOffset || 0;
    this.world = buildWorld(registerCount, this.idOffset);
    this.registers = this.world.registers.map((r) => this._makeVisualRegister(r));
    this.customers = [];

    this.time = 0;
    this.selectedRegisterId = null;
    this._currency = "₺";
    this.simState = "IDLE";
    this.scanSec = SCAN_SEC_FALLBACK;

    this.events = [];
    this._seenSales = new Set();
    this._prevQueueLen = new Map();
    // False until the first snapshot has been applied. The initial queues are
    // placed directly in their slots (the store is already busy when we attach);
    // everyone after that walks in through the entrance.
    this._seeded = false;

    this._metrics = {};
  }

  _makeVisualRegister(reg) {
    const vr = {
      id: reg.id,
      reg,
      cashier: new Cashier(reg),
      state: REGISTER_STATE.IDLE,
      waiting: [],          // Customer[] queued
      currentCustomer: null,
      receipt: 0,
      beltFill: 0,
      highlighted: false,
      lastSale: null,
      itemTotal: 0,
      itemProgress: 0,
      subtotal: 0,
      totalSales: 0,
      completedCust: 0,
      status: "Idle",
    };
    // renderer/ui read `queue.length` and `queueLength`. queueLength reports the
    // BACKEND's real count, not the drawn subset, so the panel never understates
    // a queue just because the floor can only show so many figures.
    Object.defineProperty(vr, "queue", { get() { return vr.waiting; } });
    Object.defineProperty(vr, "queueLength", {
      get() { return vr.trueQueueLen != null ? vr.trueQueueLen : vr.waiting.length; },
    });
    vr.estimatedRemaining = () => {
      const rem = Math.max(0, vr.itemTotal - vr.itemProgress);
      return rem * this.scanSec + (vr.state === REGISTER_STATE.RECEIPT ? (1 - vr.receipt) : 0.5);
    };
    return vr;
  }

  registerById(id) { return this.registers.find((r) => r.id === id) || null; }

  // rebuild the floor when the backend register count changes
  _ensureRegisterCount(n) {
    if (n > 0 && n !== this.registers.length) {
      const sel = this.selectedRegisterId;
      this.world = buildWorld(n, this.idOffset);
      this.registers = this.world.registers.map((r) => this._makeVisualRegister(r));
      this.customers = [];
      this._prevQueueLen.clear();
      // The floor was rebuilt, so re-seed: place the current queues directly
      // rather than marching the whole crowd back in through the door.
      this._seeded = false;
      if (sel && this.registerById(sel)) this.selectRegister(sel);
    }
  }

  // ---- appearance helper for visual proxies ----
  _spawnProxy(basketItems) {
    const app = this.data.nextCustomerAppearance();
    const c = new Customer(app);
    c.basketItems = basketItems || this.data.nextBasketSize();
    c.scannedItems = 0;
    c.runningTotal = 0;
    return c;
  }

  _reslot(vr) {
    for (let i = 0; i < vr.waiting.length; i++) {
      const c = vr.waiting[i];
      c.queueIndex = i;
      const slot = queueSlot(vr.reg, i);
      if (Math.hypot(slot.x - c.pos.x, slot.y - c.pos.y) > 1) c.goTo(slot);
    }
  }

  // =============================================================== snapshot ===
  applySnapshot(snap) {
    if (!snap || !snap.metrics) return;
    this.simState = snap.simState || "IDLE";
    this._metrics = snap.metrics;
    this.time = (snap.metrics.elapsedMs || 0) / 1000;
    this._currency = snap.metrics.currency || "₺";

    const regs = snap.registers || [];
    this._ensureRegisterCount(regs.length || this.registers.length);

    for (const rs of regs) {
      const vr = this.registerById(rs.no);
      if (!vr) continue;
      vr.route = rs.route || "direct";
      vr.status = rs.status;
      vr.state = mapStatus(rs.status);
      // Item currently under the scanner, for the selected-register panel.
      vr.activeItem = rs.activeItem || "";
      vr.activeItemCode = rs.activeItemCode || "";
      vr.activeUnitPrice = rs.activeUnitPrice || 0;
      vr.activeQty = rs.activeQty || 0;
      vr.activeLineTotal = rs.activeLineTotal || 0;
      vr.activeQueryMs = rs.activeStockMs || 0;
      vr.scannedItems = Array.isArray(rs.scannedItems) ? rs.scannedItems : [];
      vr.itemTotal = rs.itemTotal || 0;
      vr.itemProgress = rs.itemProgress || 0;
      vr.subtotal = rs.basketSubtotal || 0;
      vr.totalSales = rs.totalSales || 0;
      vr.completedCust = rs.completedCustomers || 0;

      const hasActive = rs.status === "Scanning" || rs.status === "Printing Receipt" ||
        rs.status === "Waiting" || (rs.activeCustomer && rs.activeCustomer !== "");

      // a customer just finished at this register (completed count ticked up):
      // send the active shopper out through the register so throughput is visible,
      // even when the register immediately starts serving the next customer.
      const completed = rs.completedCustomers || 0;
      if (vr._lastCompleted === undefined) vr._lastCompleted = completed;
      if (completed > vr._lastCompleted && vr.currentCustomer) {
        const done = vr.currentCustomer;
        done._role = "leave";
        done.state = CUSTOMER_STATE.LEAVING;
        done.setPath(departWaypoints(this.world, vr.reg));
        vr.currentCustomer = null;
      }
      vr._lastCompleted = completed;

      // begin service: promote a waiting proxy (or spawn one at the counter)
      if (hasActive && !vr.currentCustomer) {
        let c = vr.waiting.shift();
        if (!c) c = this._spawnProxy(rs.itemTotal);
        else this._reslot(vr);
        c._role = "active";
        // Promoted to the counter: always visible, even if this proxy was still
        // walking in from the door when the register called it forward.
        c.enteringStore = false;
        c.name = rs.activeCustomer || ("#" + c.id);
        c.state = CUSTOMER_STATE.SCANNING;
        c.basketItems = rs.itemTotal || c.basketItems;
        c.setPath(approachWaypoints(vr.reg));
        if (!this.customers.includes(c)) this.customers.push(c);
        vr.currentCustomer = c;
      }

      // finish service: release the active proxy toward the exit
      if (!hasActive && vr.currentCustomer) {
        const c = vr.currentCustomer;
        c._role = "leave";
        c.state = CUSTOMER_STATE.LEAVING;
        c.setPath(departWaypoints(this.world, vr.reg));
        vr.currentCustomer = null;
        vr._rcptLines = null;
        vr._rcptCustId = null;
      }

      // keep the active proxy's live figures in sync
      if (vr.currentCustomer) {
        const c = vr.currentCustomer;
        c.basketItems = rs.itemTotal || c.basketItems;
        c.scannedItems = rs.itemProgress || 0;
        c.runningTotal = rs.basketSubtotal || 0;
        c.name = rs.activeCustomer || c.name;
        this._updateReceipt(vr, rs, c);
      }

      // reconcile queue length to the backend truth
      vr.trueQueueLen = rs.queueLen || 0;
      this._reconcileQueue(vr, rs.queueLen || 0, rs.queuePreview);
      this._trackArrivals(vr, rs.queueLen || 0);
    }

    this._ingestSales(snap.completed);
    this._seeded = true;   // subsequent arrivals walk in from the entrance
  }

  _reconcileQueue(vr, desired, preview) {
    // The backend can hold far more people per register than the floor can show
    // (hundreds under load). Draw at most a laneful: beyond this the figures
    // would fall outside the world bounds and squash the whole scene.
    desired = Math.min(desired, MAX_VISIBLE_QUEUE);
    while (vr.waiting.length < desired) {
      const idx = vr.waiting.length;
      const pv = preview && preview[idx];
      const c = this._spawnProxy(pv ? pv.distinctCount : 0);
      c._role = "wait";
      // Stamp the join time so the head-up wait timer counts from now; without
      // this the proxy would inherit 0 and appear to have waited since boot.
      c.joinedQueueAt = this.time;
      const slot = queueSlot(vr.reg, idx);

      if (!this._seeded) {
        // First snapshot: the store is already busy, so place the backend's
        // existing queues straight into their slots instead of walking a whole
        // crowd in from the door at once.
        c.state = CUSTOMER_STATE.WAITING;
        c.facing = "down";
        c.pos = { x: slot.x, y: slot.y };
      } else {
        // Later arrivals walk in from the off-screen door and stay hidden until
        // they reach the queue tail. They never use the exit corridor.
        c.state = CUSTOMER_STATE.APPROACHING;
        c.enteringStore = true;
        c.pos = { x: this.world.entrance.x, y: this.world.entranceY };
        c.setPath(arrivalWaypoints(this.world, vr.reg, idx));
      }
      vr.waiting.push(c);
      this.customers.push(c);
    }
    while (vr.waiting.length > desired) {
      const c = vr.waiting.pop();
      const i = this.customers.indexOf(c);
      if (i >= 0) this.customers.splice(i, 1);
    }
  }

  _trackArrivals(vr, queueLen) {
    const prev = this._prevQueueLen.get(vr.id);
    if (prev !== undefined && queueLen > prev) {
      this._pushEvent(vr.id, "feed.customerJoined");
    }
    this._prevQueueLen.set(vr.id, queueLen);
  }

  _ingestSales(completed) {
    if (!completed) return;
    // completed is newest-first; iterate oldest-first so feed order is natural
    for (let i = completed.length - 1; i >= 0; i--) {
      const s = completed[i];
      // This floor shows one bank of the store: skip the other bank's sales so
      // the shared feed (merged across both floors) never duplicates an invoice.
      const vr = this.registerById(s.register);
      if (!vr) continue;
      const key = s.invoiceNo || `${s.register}-${s.completedAt}-${s.total}`;
      if (this._seenSales.has(key)) continue;
      this._seenSales.add(key);
      vr.lastSale = { total: s.total, items: s.lineCount };
      this._pushEvent(s.register, "feed.invoice", { invoice: s.invoiceNo || "", money: this.money(s.total), items: s.lineCount });
    }
    if (this._seenSales.size > 500) this._seenSales = new Set([...this._seenSales].slice(-300));
  }

  _pushEvent(regId, key, params) {
    this.events.unshift({ t: this.time, regId, key, params: params || {} });
    if (this.events.length > 40) this.events.pop();
  }

  // Build the customer-facing receipt from the grounded QUENTRA_RETAIL products
  // carried on the live register snapshot.
  _updateReceipt(vr, rs, c) {
    if (vr._rcptCustId !== c.id) vr._rcptCustId = c.id;
    vr._rcptLines = (vr.scannedItems || []).map((item) => ({
      name: item.name || item.code || "Ürün",
      price: item.lineTotal || item.unitPrice || 0,
    }));
  }

  // =============================================================== per-frame ===
  update(dt) {
    for (const c of this.customers) {
      c.update(dt);
      if (c.arrived) {
        if (c._role === "wait" && c.state === CUSTOMER_STATE.APPROACHING) {
          c.state = CUSTOMER_STATE.WAITING; c.facing = "down";
          c.enteringStore = false;      // in the queue now: becomes visible
          c.joinedQueueAt = this.time;  // wait counts from reaching the queue
        } else if (c._role === "active") {
          c.facing = "up";
        }
      }
      if (!c.moving && c._role === "wait" && c.state === CUSTOMER_STATE.WAITING) c.facing = "down";
    }

    for (const vr of this.registers) {
      vr.cashier.update(dt, vr.state === REGISTER_STATE.SCANNING);
      if (vr.state === REGISTER_STATE.RECEIPT) vr.receipt = Math.min(1, vr.receipt + dt / 1.0);
      else vr.receipt = 0;
      if (vr.state === REGISTER_STATE.SCANNING || vr.state === REGISTER_STATE.UNLOADING) {
        vr.beltFill = Math.min(1, vr.beltFill + dt / 0.9);
      } else vr.beltFill = 0;
    }

    this.customers = this.customers.filter((c) => !(c._role === "leave" && c.arrived));
  }

  // =============================================================== read APIs ===
  kpis() {
    const m = this._metrics || {};
    return {
      total: m.totalCustomers || 0,
      waiting: m.waiting || 0,
      inCheckout: m.inCheckout || 0,
      completed: m.completed || 0,
      totalSales: m.totalSales || 0,
      itemsScanned: m.itemsScanned || 0,
      avgCheckout: (m.avgProcessMs || 0) / 1000,
      avgQueue: (m.avgWaitMs || 0) / 1000,
      tpm: m.txnPerMinute || 0,
      // Per-route splits (0 when that route has no samples yet).
      avgCheckoutDirect: (m.avgProcessDirectMs || 0) / 1000,
      avgCheckoutQuentra: (m.avgProcessQuentraMs || 0) / 1000,
      avgQueueDirect: (m.avgWaitDirectMs || 0) / 1000,
      avgQueueQuentra: (m.avgWaitQuentraMs || 0) / 1000,
      // Measured per-scan DB time per bank (ms), for the side KPI clusters.
      scanMsDirect: m.avgScanDbDirectMs || 0,
      scanMsQuentra: m.avgScanDbQuentraMs || 0,
      scanCountDirect: m.scanCountDirect || 0,
      scanCountQuentra: m.scanCountQuentra || 0,
    };
  }

  statusInfo() {
    switch (this.simState) {
      case "RUNNING": return { state: "running", label: "RUNNING", key: "st.running", canPause: true, canResume: false };
      case "PAUSED": return { state: "paused", label: "PAUSED", key: "st.paused", canPause: false, canResume: true };
      case "PREPARING": return { state: "running", label: "PREPARING", key: "st.preparing", canPause: false, canResume: false };
      case "STOPPING": return { state: "stopped", label: "STOPPING", key: "st.stopping", canPause: false, canResume: false };
      case "COMPLETED": return { state: "stopped", label: "COMPLETED", key: "st.completed", canPause: false, canResume: false };
      case "ERROR": return { state: "stopped", label: "ERROR", key: "st.error", canPause: false, canResume: false };
      case "STOPPED": return { state: "stopped", label: "STOPPED", key: "st.stopped", canPause: false, canResume: false };
      default: return { state: "stopped", label: "IDLE", key: "st.idle", canPause: false, canResume: false };
    }
  }

  selectRegister(id) {
    this.selectedRegisterId = id;
    for (const r of this.registers) r.highlighted = r.id === id;
  }
  get selectedRegister() { return this.registerById(this.selectedRegisterId); }

  money(v) {
    return this._currency + Number(v || 0).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // reset is handled by the backend; kept for interface parity
  reset() { /* no-op: authoritative reset happens on the server */ }
}
