// datasource.js
// Abstraction that feeds the simulation with demo data. This is intentionally
// decoupled so a real backend/API source (ApiSimulationDataSource) can replace
// InMemoryDemoDataSource later WITHOUT touching the simulation/render code.
//
// NOTE: This phase is visual-only. There is NO database, no network, no API.

/**
 * SimulationDataSource — the contract every data source must satisfy.
 * A future ApiSimulationDataSource would implement the same methods.
 */
export class SimulationDataSource {
  /** @returns {object} visual appearance descriptor for a new customer */
  nextCustomerAppearance() { throw new Error("not implemented"); }
  /** @returns {number} number of items in a customer's basket */
  nextBasketSize() { throw new Error("not implemented"); }
  /** @returns {number} unit price for a single scanned item */
  nextItemPrice() { throw new Error("not implemented"); }
  /** @returns {number} seconds until the next customer arrives at the store */
  nextArrivalDelay() { throw new Error("not implemented"); }
  /** @returns {number} how many customers start queued at each register */
  initialQueueSize() { throw new Error("not implemented"); }
}

const SKIN_TONES = ["#f2c9a4", "#e8b48c", "#c88f66", "#a56a44", "#7c4a2d", "#f6d5b8"];
const HAIR_COLORS = ["#2b2118", "#4a3423", "#6b4a2b", "#111318", "#8a6a3a", "#9a9a9a", "#c96b3a"];
const SHIRT_COLORS = ["#4f6bed", "#e0574e", "#2fa27a", "#e6a23c", "#7c5cd6", "#3b3f4a", "#d65a9a", "#2c8fb3", "#e28e4d"];
const PANTS_COLORS = ["#33384a", "#4a4f63", "#2f3b52", "#5a4632", "#3a2f4a", "#22303f"];
const HAIR_STYLES = ["short", "buzz", "bun", "long", "cap", "bald"];

let _seq = 0;

/**
 * InMemoryDemoDataSource — deterministic-ish pseudo random demo data.
 * All values are purely cosmetic; none of them are persisted anywhere.
 */
export class InMemoryDemoDataSource extends SimulationDataSource {
  constructor(seed = 1) {
    super();
    this._s = seed >>> 0 || 1;
  }

  _rand() {
    // xorshift32 — small, fast, reproducible.
    let x = this._s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._s = x >>> 0;
    return (this._s % 100000) / 100000;
  }
  _pick(arr) { return arr[Math.floor(this._rand() * arr.length)]; }
  _range(a, b) { return a + Math.floor(this._rand() * (b - a + 1)); }

  nextCustomerAppearance() {
    const gender = this._rand() < 0.5 ? "female" : "male";
    let hair = this._pick(HAIR_STYLES);
    if (gender === "female" && (hair === "buzz" || hair === "bald")) hair = "long";
    return {
      id: ++_seq,
      gender,
      skin: this._pick(SKIN_TONES),
      hair: this._pick(HAIR_COLORS),
      hairStyle: hair,
      shirt: this._pick(SHIRT_COLORS),
      pants: this._pick(PANTS_COLORS),
      heightScale: 0.9 + this._rand() * 0.25,
      carry: this._rand() < 0.35 ? "cart" : "basket",
    };
  }

  nextBasketSize() { return this._range(4, 22); }
  nextItemPrice() { return Math.round((3 + this._rand() * 180) * 100) / 100; }
  nextArrivalDelay() { return 1.4 + this._rand() * 2.6; }
  initialQueueSize() { return this._range(3, 7); }
}
