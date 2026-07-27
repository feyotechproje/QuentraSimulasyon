// events.js — rolling live-event feed (last N events, in-memory).

export class EventLog {
  constructor(max = 8) { this.max = max; this.items = []; this._t = 0; }

  clock() {
    // demo wall-clock starting 10:15:20
    const base = 10 * 3600 + 15 * 60 + 20 + Math.floor(this._t);
    const h = Math.floor(base / 3600) % 24;
    const m = Math.floor((base % 3600) / 60);
    const s = base % 60;
    return `${p(h)}:${p(m)}:${p(s)}`;
  }
  tick(dt) { this._t += dt; }

  push(text, kind = "") {
    this.items.unshift({ time: this.clock(), text, kind });
    if (this.items.length > this.max) this.items.pop();
  }
  clear() { this.items = []; this._t = 0; }
}

const p = (n) => String(n).padStart(2, "0");
