// events.js
// A tiny ring buffer of human-readable access events plus KPI-friendly
// counters. The UI reads `feed` and renders the newest first.

export class EventLog {
  constructor(limit = 60) {
    this.limit = limit;
    this.feed = [];
    this._seq = 0;
  }

  // `text` is the English fallback (also shown if i18n isn't loaded yet);
  // `textKey`/`vars` let the UI re-render the same entry in the active
  // language when the user switches TR/EN without losing the event history.
  push(clock, text, kind = "info", textKey = null, vars = null) {
    this._seq += 1;
    this.feed.unshift({ id: this._seq, time: clock, text, kind, textKey, vars });
    if (this.feed.length > this.limit) this.feed.pop();
  }

  clear() {
    this.feed.length = 0;
    this._seq = 0;
  }
}
