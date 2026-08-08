// live-panel.js — a self-contained "CANLI VERİ" readout for demo pages whose
// metrics are drawn in JS/canvas and so cannot be targeted element-by-element.
//
// It adds a Demo / Canlı toggle to the toolbar and a floating card that, in
// live mode, shows REAL measured numbers from GET /api/<sim>/state plus a small
// live feed. Optional mode buttons switch the workload's ad-hoc vs Quentra
// path via POST /api/<sim>/mode. Nothing here is synthesized — every value is
// the backend's measurement.
import { LiveController, mountLiveToggle, renderSqlPair } from '/shared/live-workload.js';

// opts:
//   sim, workloadId, title, db, accent
//   anchor:  CSS selector for the toolbar to host the Demo/Canlı toggle
//   mount:   optional CSS selector that docks the card into the page flow
//   fields:  [{ label, get:(state)=>string, tone?:(state)=>'ok'|'warn'|'bad' }]
//   modes:   [{ label, mode }]  (optional path switch)
//   feed:    (state)=>[{ text, tone }]  (optional)
export function mountLivePanel(opts) {
  const accent = opts.accent || '#7c6bff';
  document.documentElement.style.setProperty('--lp-accent', accent);

  // --- floating card ---
  const card = document.createElement('div');
  card.className = 'live-panel';
  card.hidden = true;
  card.innerHTML =
    `<div class="lp-head">
       <span class="lp-dot"></span>
       <span class="lp-title">CANLI VERİ</span>
       <span class="lp-db">${opts.db || ''}</span>
       <button class="lp-close" title="Kapat" type="button">×</button>
     </div>
     <div class="lp-modes"></div>
     <div class="lp-grid"></div>
     <div class="lp-sql"></div>
     <div class="lp-feed"></div>
     <div class="lp-note"></div>`;
  const mount = opts.mount && document.querySelector(opts.mount);
  if (mount) {
    card.classList.add('is-docked');
    mount.prepend(card);
  } else {
    document.body.appendChild(card);
  }
  // A persistent docked card stays in the layout even in Demo mode (it is the
  // page's only side panel, so hiding it would leave an empty column); instead
  // it shows a prompt to switch to Canlı. Only meaningful when docked.
  const persist = !!(opts.persistDocked && mount);

  const grid = card.querySelector('.lp-grid');
  const sqlEl = card.querySelector('.lp-sql');
  const feedEl = card.querySelector('.lp-feed');
  const noteEl = card.querySelector('.lp-note');
  const modesEl = card.querySelector('.lp-modes');

  grid.innerHTML = opts.fields.map((f, i) =>
    `<div class="lp-cell"><span class="lp-k">${f.label}</span><span class="lp-v" data-i="${i}">—</span></div>`
  ).join('');

  const live = new LiveController({
    sim: opts.sim,
    workloadId: opts.workloadId,
    intervalMs: 1500,
    onState: render,
    onError: (m) => { noteEl.textContent = 'bağlantı bekleniyor · ' + m; },
  });

  if (opts.modes && opts.modes.length) {
    modesEl.innerHTML = opts.modes.map((m, i) =>
      `<button type="button" class="lp-mode${i === 0 ? ' is-active' : ''}" data-mode="${m.mode}">${m.label}</button>`
    ).join('');
    modesEl.querySelectorAll('.lp-mode').forEach((b) => b.addEventListener('click', () => {
      modesEl.querySelectorAll('.lp-mode').forEach((x) => x.classList.toggle('is-active', x === b));
      live.setMode(b.dataset.mode);
    }));
  }

  const closeBtn = card.querySelector('.lp-close');
  if (persist) {
    // No close affordance for a docked, always-present panel.
    closeBtn.remove();
  } else {
    closeBtn.addEventListener('click', () => {
      live.disable(); card.hidden = true;
      toggleWrap.querySelectorAll('.lt-btn').forEach((x) => x.classList.toggle('is-active', x.dataset.live === '0'));
    });
  }

  // Clear measured values back to placeholders (used when leaving live mode).
  function resetCells() {
    grid.querySelectorAll('.lp-v').forEach((c) => { c.textContent = '—'; c.dataset.tone = ''; });
    sqlEl.innerHTML = '';
    feedEl.innerHTML = '';
  }

  function render(s) {
    if (!s || !s.provisioned) { noteEl.textContent = 'veritabanı hazırlanıyor…'; return; }
    if (!s.running) { noteEl.textContent = 'çalıştırılıyor…'; return; }
    noteEl.textContent = '';
    opts.fields.forEach((f, i) => {
      const cell = grid.querySelector(`.lp-v[data-i="${i}"]`);
      cell.textContent = safe(() => f.get(s));
      cell.dataset.tone = (f.tone && safe(() => f.tone(s))) || '';
    });
    renderSqlPair(sqlEl, s);
    if (opts.feed) {
      const items = safe(() => opts.feed(s)) || [];
      feedEl.innerHTML = items.map((it) =>
        `<div class="lp-fi" data-tone="${it.tone || ''}"><span class="lp-fd"></span>${escapeHtml(it.text)}</div>`
      ).join('');
    }
  }

  // --- Demo / Canlı toggle in the toolbar ---
  const anchor = document.querySelector(opts.anchor) || document.querySelector('.toolbar') || document.body;
  const toggleWrap = mountLiveToggle(anchor, (isLive) => {
    if (isLive) { card.hidden = false; noteEl.textContent = ''; live.enable(); }
    else if (persist) { live.disable(); resetCells(); noteEl.textContent = opts.demoNote || ''; }
    else { live.disable(); card.hidden = true; }
    // Let the page react too (e.g. swap the simulation's data source).
    if (opts.onToggle) opts.onToggle(isLive);
  });

  // A persistent docked card is visible from the start (Demo mode) with a prompt;
  // a floating card stays hidden until the user switches to Canlı.
  if (persist) { card.hidden = false; noteEl.textContent = opts.demoNote || ''; }

  window.addEventListener('beforeunload', () => live.disable());
  return { live, card };
}

function safe(fn) { try { return fn(); } catch { return '—'; } }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
