// queue.js
// Independent per-register queue. Keeps customers ordered and smoothly re-targets
// them to their slot whenever the line advances (no teleporting).

import { queueSlot } from "./world.js";
import { CUSTOMER_STATE } from "./customer.js";

export class Queue {
  constructor(register) {
    this.register = register;
    this.members = []; // Customer[], index 0 = front
  }

  get length() { return this.members.length; }
  get front() { return this.members[0] || null; }

  /** Append a customer to the tail; returns its slot index. */
  enqueue(customer) {
    const idx = this.members.length;
    this.members.push(customer);
    customer.queueIndex = idx;
    return idx;
  }

  /** Remove and return the front customer (called when service begins). */
  shift() {
    const c = this.members.shift();
    this._retarget();
    return c || null;
  }

  tailSlotIndex() { return this.members.length; }

  /** Re-assign slot targets after the line moves forward. */
  _retarget() {
    for (let i = 0; i < this.members.length; i++) {
      const c = this.members[i];
      c.queueIndex = i;
      const slot = queueSlot(this.register, i);
      // only nudge if the customer is materially off its slot
      if (Math.hypot(slot.x - c.pos.x, slot.y - c.pos.y) > 1) {
        c.goTo(slot);
        c.state = CUSTOMER_STATE.WAITING;
      }
    }
  }

  update() {
    // keep waiting customers facing the camera while idle
    for (const c of this.members) {
      if (!c.moving && c.state === CUSTOMER_STATE.WAITING) c.facing = "down";
    }
  }
}
