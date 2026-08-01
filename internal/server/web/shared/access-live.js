// access-live.js — shared live wiring for the turnstile and factory-turnstile
// demos. Both ask the same "son hareket sorgusu" (last-movement) question, so
// they share one backend (/api/access/*) running against the TIGERMARKET ERP
// database: ad-hoc concatenated lookups (single-use plans, constant compiles)
// vs the parameterized Quentra path (one reused plan). All numbers are measured.
import { mountLivePanel } from '/shared/live-panel.js';
import { fmt } from '/shared/live-workload.js';

const modeTr = { baseline: 'Direkt', quentra: 'Quentra', auto: 'Otomatik' };

function speedup(s) {
  if (!(s.refAvgMs > 0) || !(s.quentraAvgMs > 0)) return '—';
  const ratio = s.refAvgMs / s.quentraAvgMs;
  return ratio.toFixed(ratio < 10 ? 1 : 0) + '×';
}

// workloadId is the portal key for the page ("turnstile" or
// "factory-turnstile-simulation"); both drive the same access manager.
export function initAccessLive(workloadId, accent) {
  const isFactory = workloadId === 'factory-turnstile-simulation';
  const panel = mountLivePanel({
    sim: 'access',
    workloadId,
    // The factory page has no DB badge and no in-card mode switch: the query
    // path is already chosen from the top toolbar's Sorgu (Temel/Quentra)
    // control, so repeating it here just clutters the card.
    db: isFactory ? '' : 'TIGERMARKET',
    accent: accent || '#5eead4',
    // On the factory page the Demo/Canlı toggle lives on the merged status row
    // (next to sim time + shift); the turnstile page keeps it on the controls.
    anchor: isFactory ? '.toolbar-status' : '.toolbar-controls',
    mount: isFactory ? '.side' : null,
    modes: isFactory ? null : [
      { label: 'Direkt', mode: 'baseline' },
      { label: 'Quentra', mode: 'quentra' },
      { label: 'Otomatik', mode: 'auto' },
    ],
    // Both routes now run the IDENTICAL parameterized last-movement lookup; the
    // only difference is the path — direct to SQL Server (localhost) vs through
    // the Quentra gateway (:14330). So the metrics compare the two connections
    // on the same query rather than telling an ad-hoc-vs-parameterized story.
    fields: [
      { label: 'Hızlanma', get: speedup, tone: (s) => (s.refAvgMs > 0 && s.quentraAvgMs > 0 && s.refAvgMs / s.quentraAvgMs >= 2 ? 'ok' : 'warn') },
      { label: 'Direkt Ort. (localhost)', get: (s) => fmt.ms(s.refAvgMs), tone: () => 'warn' },
      { label: 'Quentra Ort. (:14330)', get: (s) => fmt.ms(s.quentraAvgMs), tone: () => 'ok' },
      { label: 'Son Hareket/sn', get: (s) => fmt.int(s.queriesPerSec) },
      { label: 'Toplam Kontrol', get: (s) => fmt.int(s.queriesTotal) },
      { label: 'Son Sorgu', get: (s) => fmt.ms(s.lastMs) },
    ],
    // Show only the few most recent lookups so the docked card's feed stays
    // readable (12 rows squeezed into the side column overlap and blur).
    feed: (s) => (s.recent || []).slice(0, isFactory ? 5 : 12).map((e) => ({
      text: `Anahtar #${e.key} · ${modeTr[e.mode] || e.mode} · ${fmt.ms(e.ms)}`,
      tone: e.mode === 'quentra' ? 'ok' : 'warn',
    })),
  });

  // The factory card dropped its own mode switch, so let the page's top Sorgu
  // (Temel/Quentra) control drive the live backend path instead: map "baseline"
  // → the direct route, "quentra" → the gateway route.
  if (isFactory) {
    window.setAccessLiveMode = (mode) => panel.live.setMode(mode === 'quentra' ? 'quentra' : 'baseline');
  }
  return panel;
}
