// access-live.js — shared live wiring for the turnstile and factory-turnstile
// demos. Both ask the same "son hareket sorgusu" (last-movement) question, so
// they share one backend (/api/access/*) running against the TIGERMARKET ERP
// database: ad-hoc concatenated lookups (single-use plans, constant compiles)
// vs the parameterized Quentra path (one reused plan). All numbers are measured.
import { mountLivePanel } from '/shared/live-panel.js';
import { fmt } from '/shared/live-workload.js';

const modeTr = { baseline: 'Ad-hoc', quentra: 'Parametreli', auto: 'Otomatik' };

function speedup(s) {
  if (!(s.refAvgMs > 0) || !(s.quentraAvgMs > 0)) return '—';
  const ratio = s.refAvgMs / s.quentraAvgMs;
  return ratio.toFixed(ratio < 10 ? 1 : 0) + '×';
}

// workloadId is the portal key for the page ("turnstile" or
// "factory-turnstile-simulation"); both drive the same access manager.
export function initAccessLive(workloadId, accent) {
  mountLivePanel({
    sim: 'access',
    workloadId,
    db: 'TIGERMARKET',
    accent: accent || '#5eead4',
    anchor: '.toolbar-controls',
    mount: workloadId === 'factory-turnstile-simulation' ? '.side' : null,
    modes: [
      { label: 'Ad-hoc', mode: 'baseline' },
      { label: 'Quentra', mode: 'quentra' },
      { label: 'Otomatik', mode: 'auto' },
    ],
    fields: [
      { label: 'Hızlanma', get: speedup, tone: (s) => (s.refAvgMs > 0 && s.quentraAvgMs > 0 && s.refAvgMs / s.quentraAvgMs >= 2 ? 'ok' : 'warn') },
      { label: 'Direkt Ort.', get: (s) => fmt.ms(s.refAvgMs), tone: () => 'warn' },
      { label: 'Quentra Ort.', get: (s) => fmt.ms(s.quentraAvgMs), tone: () => 'ok' },
      { label: 'Son Hareket/sn', get: (s) => fmt.int(s.queriesPerSec) },
      { label: 'Ad-hoc Plan (tekil)', get: (s) => fmt.int(s.singleUsePlans), tone: (s) => (s.singleUsePlans > 5000 ? 'bad' : 'ok') },
      { label: 'Plan Cache', get: (s) => (s.planCacheMB == null ? '—' : s.planCacheMB.toLocaleString('tr-TR') + ' MB') },
      { label: 'Derleme/sn', get: (s) => fmt.int(s.compilationsPerSec), tone: (s) => (s.compilationsPerSec > 20 ? 'warn' : 'ok') },
      { label: 'SQL CPU', get: (s) => fmt.pct(s.sqlCpuPct), tone: (s) => (s.sqlCpuPct > 70 ? 'bad' : 'ok') },
    ],
    feed: (s) => (s.recent || []).map((e) => ({
      text: `Anahtar #${e.key} · ${modeTr[e.mode] || e.mode} · ${fmt.ms(e.ms)}`,
      tone: e.mode === 'quentra' ? 'ok' : 'warn',
    })),
  });
}
