// access-live.js — shared live wiring for the turnstile and factory-turnstile
// demos. Both ask the same "son hareket sorgusu" (last-movement) question, so
// they share one backend (/api/access/*) running against the TIGERMARKET ERP
// database. The application sends the SAME bad ad-hoc statement on both routes;
// only the Quentra gateway (given a rule) rewrites it — measured via DMV
// capture, never asserted.
//
// Since the turnstile floor itself is now the main live proof (each card read
// can be a REAL /api/access/check query), this card's role is the summary:
// totals, rewrite counts, rule status, gateway state and the last traceId.
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
// opts.onToggle(isLive) lets the page switch its own data source in sync with
// the card's Demo/Canlı control.
export function initAccessLive(workloadId, accent, opts = {}) {
  const isFactory = workloadId === 'factory-turnstile-simulation';
  const panel = mountLivePanel({
    sim: 'access',
    workloadId,
    // The factory page has no DB badge and no in-card mode switch: the query
    // path is fixed per bank (left direct, right Quentra).
    db: isFactory ? '' : 'TIGERMARKET',
    accent: accent || '#5eead4',
    // On the factory page the Demo/Canlı toggle lives on the merged status row
    // (next to sim time + shift); the turnstile page keeps it on the controls.
    anchor: isFactory ? '.toolbar-status' : '.toolbar-controls',
    mount: isFactory ? '.side' : null,
    onToggle: opts.onToggle,
    modes: isFactory ? null : [
      { label: 'Direkt', mode: 'baseline' },
      { label: 'Quentra', mode: 'quentra' },
      { label: 'Otomatik', mode: 'auto' },
    ],
    // Summary role: gateway + rule state prove HOW the comparison ran; the
    // counters aggregate the real workload and the floor's live card checks.
    fields: [
      { label: 'Gateway (:14330)', get: (s) => (s.gatewayUp ? 'AÇIK' : 'KAPALI'), tone: (s) => (s.gatewayUp ? 'ok' : 'bad') },
      { label: 'Rewrite Kuralı', get: (s) => (s.ruleMatched ? 'EŞLEŞTİ · ÖLÇÜLDÜ' : 'YOK'), tone: (s) => (s.ruleMatched ? 'ok' : 'warn') },
      { label: 'Canlı Kart Kontrolü', get: (s) => fmt.int(s.checksTotal) },
      { label: 'Rewrite Sayısı', get: (s) => fmt.int(s.checkRewrites) },
      { label: 'Son Trace', get: (s) => s.lastTraceId || '—' },
      { label: 'Hızlanma', get: speedup, tone: (s) => (s.refAvgMs > 0 && s.quentraAvgMs > 0 && s.refAvgMs / s.quentraAvgMs >= 2 ? 'ok' : 'warn') },
      { label: 'Direkt Ort. (:1433)', get: (s) => fmt.ms(s.refAvgMs), tone: () => 'warn' },
      { label: 'Quentra Ort. (:14330)', get: (s) => fmt.ms(s.quentraAvgMs), tone: () => 'ok' },
      { label: 'Toplam Sorgu', get: (s) => fmt.int(s.queriesTotal) },
      { label: 'Son Sorgu', get: (s) => fmt.ms(s.lastMs) },
    ],
    // Show only the few most recent lookups so the docked card's feed stays
    // readable (12 rows squeezed into the side column overlap and blur).
    feed: (s) => (s.recent || []).slice(0, isFactory ? 5 : 12).map((e) => ({
      text: `Anahtar #${e.key} · ${modeTr[e.mode] || e.mode} · ${fmt.ms(e.ms)}`,
      tone: e.mode === 'quentra' ? 'ok' : 'warn',
    })),
  });

  // The factory page shows both banks side by side with no mode switch at all,
  // so the live workload alternates routes automatically — both columns of the
  // card fill simultaneously, mirroring the dual floors above it.
  if (isFactory) {
    window.setAccessLiveMode = (mode) => panel.live.setMode(mode === 'quentra' ? 'quentra' : 'baseline');
    panel.live.setMode('auto');
  }
  return panel;
}
