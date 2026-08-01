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
    // Side-by-side comparison card.
    cmpCard: document.getElementById('cmpCard'),
    cmpRefMs: document.getElementById('cmpRefMs'),
    cmpRefScanned: document.getElementById('cmpRefScanned'),
    cmpQnMs: document.getElementById('cmpQnMs'),
    cmpQnScanned: document.getElementById('cmpQnScanned'),
    cmpSpeedVal: document.getElementById('cmpSpeedVal'),
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

    // Comparison card: always show BOTH measured paths so the gap is obvious,
    // whatever the active mode. refAvgMs/quentraAvgMs are cumulative averages,
    // so they stay populated even while only one mode is currently running.
    if (el.cmpCard) {
      const ref = s.refAvgMs, qn = s.quentraAvgMs;
      const haveBoth = ref > 0 && qn > 0;
      el.cmpCard.hidden = !haveBoth;
      if (haveBoth) {
        el.cmpRefMs.textContent = fmt.ms(ref);
        el.cmpQnMs.textContent = fmt.ms(qn);
        el.cmpRefScanned.textContent = fmt.int(s.tableRows);
        if (el.cmpQnScanned) el.cmpQnScanned.textContent = fmt.int(s.tableRows);
        const t = (k, d) => (window.QuentraI18n ? window.QuentraI18n.t(k, d) : d);
        const x = ref / qn;
        // Both routes run the same LIKE scan, so unless the gateway rewrites it
        // the two times are about equal — say so honestly instead of "~1× faster".
        el.cmpSpeedVal.textContent = (x >= 1.25)
          ? '~' + (x >= 10 ? Math.round(x) : x.toFixed(1)) + '× ' + t('cmp.faster', 'daha hızlı')
          : t('cmp.same', '≈ aynı süre');
      }
    }

    renderSqlPair(sqlEl, s);

    if (Array.isArray(s.recent)) {
      el.feed.innerHTML = s.recent.map((e) => {
        const kind = e.mode === 'quentra' ? 'quentra' : 'busy';
        // Same LIKE query on both routes now — the tag shows the ROUTE taken,
        // not a different statement.
        const route = e.mode === 'quentra' ? 'LIKE · :14330' : 'LIKE · doğrudan';
        return `<li class="feed-item ${kind}"><span class="dot"></span><span>` +
          `<b>${escapeHtml(e.term)}</b> · ${route} · ${fmt.ms(e.ms)} · ${fmt.int(e.matches)} eşleşme` +
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

  // Demo / Canlı toggle, mounted into its dedicated toolbar slot up front.
  const anchor = document.getElementById('liveToggleSlot') || document.querySelector('.toolbar') || document.body;
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
