// checkout.js
// A single register: owns its queue, cashier and the checkout state machine
// (UNLOADING -> SCANNING -> PAYING -> RECEIPT). Timing is delta-time driven.

import { Queue } from "./queue.js";
import { Cashier } from "./cashier.js";
import { CUSTOMER_STATE } from "./customer.js";
import { approachWaypoints, departWaypoints } from "./world.js";

export const REGISTER_STATE = {
  IDLE: "IDLE",
  WAITING: "WAITING",
  UNLOADING: "UNLOADING",
  SCANNING: "SCANNING",
  PAYING: "PAYING",
  RECEIPT: "RECEIPT",
};

export const SCAN_INTERVAL = 0.24; // default seconds per item
const PAY_TIME = 1.2;
const RECEIPT_TIME = 1.0;

export class Register {
  constructor(reg) {
    this.id = reg.id;
    this.reg = reg;
    this.queue = new Queue(reg);
    this.cashier = new Cashier(reg);

    this.state = REGISTER_STATE.IDLE;
    this.currentCustomer = null;

    this.timer = 0;
    this.scanTimer = 0;
    // Seconds per scanned item. The demo scenario overrides this to model the
    // per-scan scalar-UDF query: slower direct, faster through Quentra.
    this.scanInterval = SCAN_INTERVAL;
    this.receipt = 0;      // 0..1 printer extrusion
    this.beltFill = 0;     // 0..1 belt loading
    this.lastSale = null;
    this.highlighted = false;
    this.activeItem = "";
    this.activeItemCode = "";
    this.activeUnitPrice = 0;
    this.activeQty = 0;
    this.activeLineTotal = 0;
    this.activeQueryMs = 0;
    this.scannedItems = [];
  }

  get queueLength() { return this.queue.length; }

  enqueue(customer) {
    customer.registerId = this.id;
    this.queue.enqueue(customer);
  }

  /** Rough remaining seconds for the active checkout (for the detail panel). */
  estimatedRemaining() {
    const c = this.currentCustomer;
    if (!c) return 0;
    switch (this.state) {
      case REGISTER_STATE.WAITING: return 1 + c.basketItems * this.scanInterval + PAY_TIME + RECEIPT_TIME;
      case REGISTER_STATE.UNLOADING: return this.timer + c.basketItems * this.scanInterval + PAY_TIME + RECEIPT_TIME;
      case REGISTER_STATE.SCANNING: return (c.basketItems - c.scannedItems) * this.scanInterval + PAY_TIME + RECEIPT_TIME;
      case REGISTER_STATE.PAYING: return this.timer + RECEIPT_TIME;
      case REGISTER_STATE.RECEIPT: return this.timer;
      default: return 0;
    }
  }

  update(dt, sim) {
    this.cashier.update(dt, this.state === REGISTER_STATE.SCANNING);
    this.queue.update();
    const c = this.currentCustomer;

    switch (this.state) {
      case REGISTER_STATE.IDLE:
        if (!this.currentCustomer && this.queue.length > 0) {
          const next = this.queue.shift();
          this.currentCustomer = next;
          next.registerId = this.id;
          next.serviceStartedAt = sim.time;
          sim.recordQueueWait(sim.time - next.joinedQueueAt);
          next.setPath(approachWaypoints(this.reg));
          next.state = CUSTOMER_STATE.APPROACHING;
          // Called to the counter: visible from here on, even if this shopper
          // was still walking in from the door.
          next.enteringStore = false;
          this.state = REGISTER_STATE.WAITING;
        }
        break;

      case REGISTER_STATE.WAITING:
        if (c && c.arrived) {
          c.facing = "up";
          c.state = CUSTOMER_STATE.UNLOADING;
          c.runningTotal = 0;
          c.scannedItems = 0;
          this.scannedItems = [];
          this.state = REGISTER_STATE.UNLOADING;
          this.timer = 0.6 + c.basketItems * 0.045;
          this.beltFill = 0;
          this._checkoutStartedAt = sim.time;
          sim.pushEvent(`Register ${this.id}`, `customer unloading ${c.basketItems} items`);
        }
        break;

      case REGISTER_STATE.UNLOADING:
        this.timer -= dt;
        this.beltFill = Math.min(1, this.beltFill + dt / 0.9);
        if (this.timer <= 0) {
          this.state = REGISTER_STATE.SCANNING;
          this.scanTimer = this.scanInterval;
          c.state = CUSTOMER_STATE.SCANNING;
        }
        break;

      case REGISTER_STATE.SCANNING:
        this.scanTimer -= dt;
        if (this.scanTimer <= 0 && c.scannedItems < c.basketItems) {
          const item = (c.items && c.items[c.scannedItems]) || { name: "Ürün", code: "", brand: "", category: "", price: c.itemPrices[c.scannedItems] || 0 };
          const price = item.price || 0;
          this.activeItem = item.name;
          this.activeItemCode = item.code;
          this.activeUnitPrice = price;
          this.activeQty = 1;
          this.activeLineTotal = price;
          this.activeQueryMs = Math.round(this.scanInterval * 1000);
          c.scannedItems++;
          c.runningTotal += price;
          this.scannedItems.push({
            code: item.code, name: item.name, brand: item.brand, category: item.category,
            quantity: 1, unitPrice: price, lineTotal: price,
            queryMs: this.activeQueryMs,
            route: sim.scenario && sim.scenario.isQuentra ? "quentra" : "direct",
            scannedAt: Math.round(sim.time * 1000),
          });
          this._rcptLines = this.scannedItems.map((x) => ({ name: x.name, price: x.lineTotal }));
          sim.onItemScanned();
          this.scanTimer += this.scanInterval;
        }
        if (c.scannedItems >= c.basketItems) {
          this.state = REGISTER_STATE.PAYING;
          this.timer = PAY_TIME;
          c.state = CUSTOMER_STATE.PAYING;
        }
        break;

      case REGISTER_STATE.PAYING:
        this.timer -= dt;
        if (this.timer <= 0) {
          this.state = REGISTER_STATE.RECEIPT;
          this.timer = RECEIPT_TIME;
          this.receipt = 0;
          c.state = CUSTOMER_STATE.RECEIPT;
        }
        break;

      case REGISTER_STATE.RECEIPT:
        this.timer -= dt;
        this.receipt = Math.max(0, Math.min(1, 1 - this.timer / RECEIPT_TIME));
        if (this.timer <= 0) {
          const sale = {
            register: this.id,
            items: c.basketItems,
            total: c.runningTotal,
            duration: sim.time - this._checkoutStartedAt,
          };
          this.lastSale = sale;
          sim.onSaleComplete(sale);
          sim.pushEvent(`Register ${this.id}`, `sale ${sim.money(sale.total)} · ${sale.items} items`);
          c.state = CUSTOMER_STATE.LEAVING;
          c.setPath(departWaypoints(sim.world, this.reg));
          this.currentCustomer = null;
          this.state = REGISTER_STATE.IDLE;
          this.activeItem = "";
          this.activeItemCode = "";
          this.activeUnitPrice = 0;
          this.activeQty = 0;
          this.activeLineTotal = 0;
          this.activeQueryMs = 0;
          this.receipt = 0;
          this.beltFill = 0;
        }
        break;
    }
  }
}
