// Updates the DOM toolbar values, right-panel metrics and live event feed.
export class UI {
  constructor(sim) {
    this.sim = sim;
    this.el = {
      status: document.getElementById('statusPill'),
      statusText: document.getElementById('statusText'),
      cpu: document.getElementById('mCpu'),
      cpuBar: document.getElementById('mCpuBar'),
      searchTime: document.getElementById('mTime'),
      scanned: document.getElementById('mScanned'),
      matches: document.getElementById('mMatches'),
      queue: document.getElementById('mQueue'),
      feed: document.getElementById('feed'),
      timeCard: document.getElementById('timeCard'),
      scannedCard: document.getElementById('scannedCard'),
    };
    this._lastFeedLen = -1;
    this._lastFeedTop = '';
  }

  update() {
    // In live mode the metrics/feed DOM is driven by real measured numbers from
    // the backend (see live.js); the canvas animation still runs, so only skip
    // the metric/feed writes here to avoid overwriting the live values.
    if (window.__ftLive) return;

    const m = this.sim.metrics();
    const st = this.sim.statusLabel();

    this.el.statusText.textContent = st.text;
    this.el.status.className = 'status-pill ' + st.kind;

    this.el.cpu.textContent = m.cpu + '%';
    this.el.cpuBar.style.width = m.cpu + '%';
    this.el.cpuBar.className = 'meter-fill ' + (m.cpu > 60 ? 'hot' : 'cool');

    this.el.searchTime.textContent = m.searchTime;
    const fast = m.searchTime.includes('ms');
    this.el.timeCard.classList.toggle('good', fast);
    this.el.timeCard.classList.toggle('bad', !fast);

    this.el.scanned.textContent = m.scanned;
    this.el.scannedCard.classList.toggle('bad', m.matches !== `${this.sim.employees.length} / ${this.sim.employees.length}`);

    this.el.matches.textContent = m.matches;
    this.el.queue.textContent = m.queue;

    // Feed (rebuild only when it changes, or when the language changes).
    const lang = (window.QuentraI18n && window.QuentraI18n.getLang()) || '';
    const top = (this.sim.events[0] ? this.sim.events[0].key + this.sim.events.length : '') + '|' + lang;
    if (top !== this._lastFeedTop) {
      this._lastFeedTop = top;
      this.el.feed.innerHTML = this.sim.events.map(e =>
        `<li class="feed-item ${e.kind}"><span class="dot"></span><span>${escapeHtml(this._eventText(e))}</span></li>`
      ).join('');
    }
  }

  _eventText(e) {
    const t = (window.QuentraI18n && window.QuentraI18n.t.bind(window.QuentraI18n)) || ((k, f) => f || k);
    let text = t(e.key, e.fallback || e.key);
    if (e.params) {
      for (const [k, v] of Object.entries(e.params)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      }
    }
    return text;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
