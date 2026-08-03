// simulation.js
// In-memory orchestrator: owns registers + customers, spawns arrivals, runs the
// checkout state machines and aggregates KPI metrics. No backend, no database.

import { buildWorld, arrivalWaypoints, queueSlot } from "./world.js";
import { Register } from "./checkout.js";
import { Customer, CUSTOMER_STATE } from "./customer.js";
import { DEMO_SCAN_SEC } from "./scenario.js";

export class Simulation {
  /**
   * @param {object} dataSource cosmetic demo data provider
   * @param {object} [opts] one BANK of the dual store:
   *        registerCount — registers on this floor;
   *        idOffset      — first register number minus one (right bank: 5);
   *        conn          — "direct" | "quentra": fixes this floor's scan cadence
   *                        so the slow and fast banks run side by side.
   */
  constructor(dataSource, opts = {}) {
    this.data = dataSource;
    this.conn = opts.conn || "direct";
    this.registerCount = opts.registerCount || undefined;
    this.idOffset = opts.idOffset || 0;
    this.world = buildWorld(this.registerCount, this.idOffset);
    this.registers = this.world.registers.map((r) => new Register(r));
    this.customers = [];

    this.time = 0;              // simulation seconds elapsed
    this.arrivalTimer = 0;
    this.selectedRegisterId = null;

    this.metrics = this._blankMetrics();
    this.events = [];

    this._seedInitialQueues();
  }

  _blankMetrics() {
    return {
      total: 0, completed: 0, itemsScanned: 0, totalSales: 0,
      checkoutTimes: [], queueTimes: [],
    };
  }

  reset() {
    this.world = buildWorld(this.registerCount, this.idOffset);
    this.registers = this.world.registers.map((r) => new Register(r));
    this.customers = [];
    this.time = 0;
    this.arrivalTimer = 0;
    this.metrics = this._blankMetrics();
    this.events = [];
    const sel = this.selectedRegisterId;
    this._seedInitialQueues();
    if (sel) this.selectRegister(sel);
  }

  // ---- customer factory ----
  _makeCustomer() {
    const app = this.data.nextCustomerAppearance();
    const c = new Customer(app);
    const n = this.data.nextBasketSize();
    c.basketItems = n;
    c.items = Array.from({ length: n }, () => this.data.nextProduct());
    c.itemPrices = c.items.map((item) => item.price);
    c.basketTotal = c.itemPrices.reduce((a, b) => a + b, 0);
    c.runningTotal = 0;
    this.metrics.total++;
    this.customers.push(c);
    return c;
  }

  _shortestRegister() {
    let best = this.registers[0];
    let bestLoad = Infinity;
    for (const r of this.registers) {
      const load = r.queueLength + (r.currentCustomer ? 1 : 0);
      if (load < bestLoad) { bestLoad = load; best = r; }
    }
    return best;
  }

  _seedInitialQueues() {
    for (const r of this.registers) {
      const n = this.data.initialQueueSize();
      for (let i = 0; i < n; i++) {
        const c = this._makeCustomer();
        const slot = queueSlot(r.reg, i);
        c.pos = { x: slot.x, y: slot.y };
        c.state = CUSTOMER_STATE.WAITING;
        c.facing = "down";
        c.joinedQueueAt = 0;
        r.enqueue(c);
      }
    }
  }

  _spawnArrival() {
    const c = this._makeCustomer();
    const reg = this._shortestRegister();
    const idx = reg.queue.tailSlotIndex();
    // Spawn at the off-screen door on the shop floor, not the exit corridor.
    c.pos = { x: this.world.entrance.x, y: this.world.entranceY };
    c.state = CUSTOMER_STATE.APPROACHING;
    c.enteringStore = true;      // hidden until they reach their queue slot
    c.joinedQueueAt = this.time;
    c.setPath(arrivalWaypoints(this.world, reg.reg, idx));
    reg.enqueue(c);
    this.pushEvent(`Register ${reg.id}`, "new customer joined the queue");
  }

  // ---- main tick ----
  update(dt) {
    this.time += dt;

    // This floor's cadence is FIXED to its bank: the direct bank pays the slow
    // per-scan query on every item while the Quentra bank runs the rewritten
    // one — both visible simultaneously, which is the whole comparison.
    const iv = DEMO_SCAN_SEC[this.conn] || DEMO_SCAN_SEC.direct;
    for (const r of this.registers) r.scanInterval = iv;

    // spawn new arrivals
    this.arrivalTimer -= dt;
    if (this.arrivalTimer <= 0) {
      this._spawnArrival();
      this.arrivalTimer = this.data.nextArrivalDelay();
    }

    // move customers
    for (const c of this.customers) {
      c.update(dt);
      if (c.state === CUSTOMER_STATE.APPROACHING && c.arrived) {
        c.state = CUSTOMER_STATE.WAITING;
        c.facing = "down";
        c.enteringStore = false;   // in the queue now: becomes visible
        c.joinedQueueAt = this.time; // wait counts from reaching the queue
      }
    }

    // run registers
    for (const r of this.registers) r.update(dt, this);

    // retire customers that walked off-screen
    this.customers = this.customers.filter((c) => {
      if (c.state === CUSTOMER_STATE.LEAVING && c.arrived) {
        c.state = CUSTOMER_STATE.COMPLETED;
        return false;
      }
      return true;
    });
  }

  // ---- hooks called by registers ----
  onItemScanned() { this.metrics.itemsScanned++; }
  onSaleComplete(sale) {
    this.metrics.completed++;
    this.metrics.totalSales += sale.total;
    this.metrics.checkoutTimes.push(sale.duration);
    if (this.metrics.checkoutTimes.length > 200) this.metrics.checkoutTimes.shift();
  }
  recordQueueWait(sec) {
    this.metrics.queueTimes.push(sec);
    if (this.metrics.queueTimes.length > 200) this.metrics.queueTimes.shift();
  }

  pushEvent(source, text) {
    this.events.unshift({ t: this.time, source, text });
    if (this.events.length > 40) this.events.pop();
  }

  // ---- selection ----
  selectRegister(id) {
    this.selectedRegisterId = id;
    for (const r of this.registers) r.highlighted = r.id === id;
  }
  get selectedRegister() {
    return this.registers.find((r) => r.id === this.selectedRegisterId) || null;
  }

  // ---- derived KPIs ----
  kpis() {
    const m = this.metrics;
    const waiting = this.registers.reduce((a, r) => a + r.queueLength, 0);
    const inCheckout = this.registers.reduce((a, r) => a + (r.currentCustomer ? 1 : 0), 0);
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const tpm = this.time > 0 ? m.completed / (this.time / 60) : 0;
    return {
      total: m.total,
      waiting,
      inCheckout,
      completed: m.completed,
      totalSales: m.totalSales,
      itemsScanned: m.itemsScanned,
      avgCheckout: avg(m.checkoutTimes),
      avgQueue: avg(m.queueTimes),
      tpm,
      // This floor's fixed demo cadence (ms per scan) for the side KPI cluster.
      scanMs: (DEMO_SCAN_SEC[this.conn] || 0) * 1000,
    };
  }

  money(v) {
    return "₺" + v.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
