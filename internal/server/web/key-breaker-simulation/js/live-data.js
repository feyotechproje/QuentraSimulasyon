// live-data.js — connects the Key Breaker demo to REAL data from
// /api/keybreaker/*. A floating "CANLI VERİ" card shows measured attack/block
// counts against the disposable KEYBREAKER database; the mode buttons flip the
// Quentra shield on/off for real. See /shared/live-panel.js.
import { mountLivePanel } from '/shared/live-panel.js';
import { fmt } from '/shared/live-workload.js';

const outcomeTr = { blocked: 'engellendi', breached: 'İHLAL', denied: 'reddedildi', allowed: 'izin verildi', error: 'hata' };
const outcomeTone = { blocked: 'ok', allowed: 'ok', denied: 'warn', breached: 'bad', error: 'warn' };

export function initKeyBreakerLive() {
  mountLivePanel({
    sim: 'keybreaker',
    workloadId: 'key-breaker-simulation',
    db: 'KEYBREAKER',
    accent: '#22e39a',
    anchor: '.toolbar-controls',
    modes: [
      { label: 'Kalkan Açık', mode: 'quentra' },
      { label: 'Kalkan Kapalı', mode: 'baseline' },
      { label: 'Otomatik', mode: 'auto' },
    ],
    fields: [
      { label: 'Denenen Saldırı', get: (s) => fmt.int(s.attempts) },
      { label: 'Engellenen', get: (s) => fmt.int(s.blocked), tone: () => 'ok' },
      { label: "DB'ye Ulaşan", get: (s) => fmt.int(s.reachedDb), tone: (s) => (s.reachedDb > 0 ? 'bad' : 'ok') },
      { label: 'Tespit Oranı', get: (s) => fmt.pct(s.detectionRate) },
      { label: 'Veritabanı', get: (s) => (s.dbStatus === 'risk' ? 'RİSK ALTINDA' : 'GÜVENLİ'), tone: (s) => (s.dbStatus === 'risk' ? 'bad' : 'ok') },
      { label: 'Ort. Yanıt', get: (s) => fmt.ms(s.avgMs) },
    ],
    feed: (s) => (s.recent || []).map((e) => ({
      text: `${e.label} · ${outcomeTr[e.outcome] || e.outcome}`,
      tone: outcomeTone[e.outcome] || '',
    })),
  });
}
