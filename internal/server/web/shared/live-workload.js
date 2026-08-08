// live-workload.js — shared helper that lets a demo page switch to LIVE data.
//
// A workload's real metrics come from GET /api/<sim>/state; its ad-hoc vs
// Quentra path is switched with POST /api/<sim>/mode; and the backend worker
// pool is started/stopped with the portal's POST /api/workloads/<id>/start|stop.
// Each page supplies its own render callback that writes the state onto its DOM.

async function post(url, body) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.ok;
  } catch { return false; }
}

export function startWorkload(id) { return post(`/api/workloads/${id}/start`); }
export function stopWorkload(id) { return post(`/api/workloads/${id}/stop`); }
export function setLiveMode(sim, mode) { return post(`/api/${sim}/mode`, { mode }); }

// LiveController manages the poll loop and the workload lifecycle for one page.
//
//   const live = new LiveController({
//     sim: 'fulltext',                 // /api/fulltext/*
//     workloadId: 'fulltext-search-simulation',
//     intervalMs: 1500,
//     onState: (s) => { ... write DOM ... },
//     onError: (msg) => { ... },
//   });
//   live.enable();  // start workload + polling
//   live.disable(); // stop polling (+ optional workload stop)
export class LiveController {
  constructor(opts) {
    this.sim = opts.sim;
    this.workloadId = opts.workloadId;
    this.intervalMs = opts.intervalMs || 1500;
    this.onState = opts.onState || (() => {});
    this.onError = opts.onError || (() => {});
    this.stopWorkloadOnDisable = opts.stopWorkloadOnDisable !== false;
    this._timer = null;
    this._active = false;
  }

  get active() { return this._active; }

  async enable() {
    if (this._active) return;
    this._active = true;
    await startWorkload(this.workloadId);
    await this._tick();
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  disable() {
    if (!this._active) return;
    this._active = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.stopWorkloadOnDisable) stopWorkload(this.workloadId);
  }

  setMode(mode) { return setLiveMode(this.sim, mode); }

  async _tick() {
    try {
      const r = await fetch(`/api/${this.sim}/state`, { cache: 'no-store' });
      if (!r.ok) { this.onError(`HTTP ${r.status}`); return; }
      const s = await r.json();
      this.onState(s);
    } catch (e) {
      this.onError(String(e && e.message ? e.message : e));
    }
  }
}

// Small formatting helpers shared by the live renderers.
export const fmt = {
  int: (n) => (n == null ? '—' : Math.round(n).toLocaleString('tr-TR')),
  ms: (v) => {
    if (v == null) return '—';
    if (v >= 1000) return (v / 1000).toFixed(2) + ' s';
    return (Math.round(v * 10) / 10) + ' ms';
  },
  pct: (n) => (n == null ? '—' : Math.round(n) + '%'),
};

// Renders the "gönderilen sorgu" panel. When a single path is selected
// (baseline OR quentra) only that block is shown, matching the page's top
// Temel/Quentra control; "auto" shows both side by side. Reads
// state.directSql / state.quentraSql / mode.
export function renderSqlPair(el, s) {
  if (!el) return;
  if (!s || (!s.directSql && !s.quentraSql)) { el.innerHTML = ''; return; }
  const mode = s.mode || 'auto';
  const gwDown = s.gatewayUp === false;
  const isBaseline = mode === 'baseline' || mode === 'reference' || mode === 'like';
  const isQuentra = mode === 'quentra';

  // ruleMatched is measured (DMV capture): only then may the Quentra block
  // claim a rewrite. Without a rule the gateway passes the text through.
  const qnLabel = s.ruleMatched === true ? '<b>rewrite · ölçüldü</b>'
    : s.ruleMatched === false ? '<b>kural yok · aynen geçti</b>'
    : '<b>optimize</b>';
  const directBlk =
    `<div class="lp-sqlblk direct is-active">
       <div class="lp-sqlh">Direkt bağlantı · <b>kötü sorgu</b></div>
       <pre>${esc(s.directSql || '')}</pre>
     </div>`;
  const quentraBlk =
    `<div class="lp-sqlblk quentra is-active">
       <div class="lp-sqlh">Quentra <span>:14330</span> · ${qnLabel}${gwDown ? ' · <i>gw kapalı</i>' : ''}</div>
       <pre>${esc(s.quentraSql || '')}</pre>
     </div>`;

  if (isBaseline) el.innerHTML = directBlk;
  else if (isQuentra) el.innerHTML = quentraBlk;
  else el.innerHTML = directBlk + quentraBlk; // auto → both
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Injects a Demo / Canlı segmented toggle and wires it. Returns the container.
// onToggle(isLive) is called on every change.
export function mountLiveToggle(anchor, onToggle, labels = {}) {
  const demo = labels.demo || 'Demo';
  const live = labels.live || 'Canlı';
  const wrap = document.createElement('div');
  wrap.className = 'live-toggle';
  wrap.innerHTML =
    `<button type="button" class="lt-btn is-active" data-live="0">${demo}</button>` +
    `<button type="button" class="lt-btn" data-live="1">${live}</button>`;
  const btns = wrap.querySelectorAll('.lt-btn');
  btns.forEach((b) => b.addEventListener('click', () => {
    if (b.classList.contains('is-active')) return;
    btns.forEach((x) => x.classList.toggle('is-active', x === b));
    onToggle(b.dataset.live === '1');
  }));
  if (anchor) anchor.appendChild(wrap);
  return wrap;
}
