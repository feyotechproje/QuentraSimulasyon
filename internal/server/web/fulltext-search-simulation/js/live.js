// live.js — wires the FullText demo page to REAL data from /api/fulltext/*.
//
// In live mode the client simulation keeps animating the office, but the right
// panel metrics and the event feed are driven by measured numbers: real LIKE
// scans over ~5M CRM2 customer rows vs full-text CONTAINS lookups.
import { LiveController, mountLiveToggle, fmt, renderSqlPair } from '/shared/live-workload.js';

export function initFulltextLive({ engine }) {
  // Standalone "gönderilen sorgu" card (bottom-left): slow LIKE on the direct
  // link vs full-text CONTAINS through Quentra (:14330).
  const sqlCard = document.createElement('div');
  sqlCard.className = 'live-sqlcard';
  sqlCard.hidden = true;
  sqlCard.innerHTML =
    `<div class="lsc-head"><span class="lp-dot"></span><span class="lsc-title">GÖNDERİLEN SORGU · CANLI</span>` +
    `<button class="lsc-close" type="button" title="Kapat">×</button></div><div class="lp-sql"></div>`;
  document.body.appendChild(sqlCard);
  const sqlEl = sqlCard.querySelector('.lp-sql');
  sqlCard.querySelector('.lsc-close').addEventListener('click', () => { sqlCard.hidden = true; });

  const el = {
    status: document.getElementById('statusPill'),
    statusText: document.getElementById('statusText'),
    cpu: document.getElementById('mCpu'),
    cpuBar: document.getElementById('mCpuBar'),
    time: document.getElementById('mTime'),
    timeCard: document.getElementById('timeCard'),
    scanned: document.getElementById('mScanned'),
    scannedCard: document.getElementById('scannedCard'),
    matches: document.getElementById('mMatches'),
    queue: document.getElementById('mQueue'),
    feed: document.getElementById('feed'),
  };

  const live = new LiveController({
    sim: 'fulltext',
    workloadId: 'fulltext-search-simulation',
    intervalMs: 1500,
    onState: render,
    onError: () => { el.statusText.textContent = 'Canlı — bağlantı bekleniyor'; },
  });

  function render(s) {
    if (!s || !s.running) {
      el.statusText.textContent = s && s.provisioned ? 'Canlı — başlatılıyor' : 'Canlı — hazırlanıyor';
      return;
    }
    const modeName = s.mode === 'quentra' ? 'Quentra FullText' : s.mode === 'auto' ? 'Otomatik' : 'Referans LIKE';
    el.statusText.textContent = 'CANLI · CRM2 · ' + modeName;
    el.status.className = 'status-pill ' + (s.mode === 'quentra' ? 'quentra' : 'baseline');

    const cpu = s.sqlCpuPct || 0;
    el.cpu.textContent = fmt.pct(cpu);
    el.cpuBar.style.width = cpu + '%';
    el.cpuBar.className = 'meter-fill ' + (cpu > 60 ? 'hot' : 'cool');

    el.time.textContent = fmt.ms(s.avgMs);
    const fast = s.mode === 'quentra';
    el.timeCard.classList.toggle('good', fast);
    el.timeCard.classList.toggle('bad', !fast);

    el.scanned.textContent = fmt.int(s.lastScanned);
    el.scannedCard.classList.toggle('bad', (s.lastScanned || 0) > 100000);

    el.matches.textContent = fmt.int(s.lastMatches);
    el.queue.textContent = fmt.int(s.searchesPerSec) + '/sn';

    renderSqlPair(sqlEl, s);

    if (Array.isArray(s.recent)) {
      el.feed.innerHTML = s.recent.map((e) => {
        const kind = e.mode === 'quentra' ? 'quentra' : 'busy';
        const label = e.mode === 'quentra' ? 'CONTAINS' : 'LIKE';
        return `<li class="feed-item ${kind}"><span class="dot"></span><span>` +
          `<b>${escapeHtml(e.term)}</b> · ${label} · ${fmt.ms(e.ms)} · ${fmt.int(e.matches)} eşleşme` +
          `</span></li>`;
      }).join('');
    }
  }

  // Mode buttons drive the live path when live is on.
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (live.active) live.setMode(btn.dataset.mode);
    });
  });

  // Demo / Canlı toggle, mounted into the toolbar.
  const anchor = document.querySelector('.toolbar') || document.body;
  mountLiveToggle(anchor, (isLive) => {
    window.__ftLive = isLive;
    sqlCard.hidden = !isLive;
    if (isLive) {
      // Adopt the current mode selection when entering live.
      const cur = document.querySelector('[data-mode].active');
      live.enable().then(() => cur && live.setMode(cur.dataset.mode));
    } else {
      live.disable();
      if (engine) engine.resume && engine.resume();
    }
  });

  window.addEventListener('beforeunload', () => live.disable());
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
