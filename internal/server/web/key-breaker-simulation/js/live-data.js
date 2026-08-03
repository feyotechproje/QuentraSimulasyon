// live-data.js — connects the Key Breaker demo to REAL data from
// /api/keybreaker/*. A floating "CANLI VERİ" card shows measured attack/block
// counts against the disposable KEYBREAKER database; the mode buttons flip the
// Quentra shield on/off for real. See /shared/live-panel.js.
import { mountLivePanel } from '/shared/live-panel.js';
import { fmt } from '/shared/live-workload.js';

const outcomeTr = { blocked: 'engellendi', breached: 'İHLAL', denied: 'reddedildi', allowed: 'izin verildi', error: 'hata' };
const outcomeTone = { blocked: 'ok', allowed: 'ok', denied: 'warn', breached: 'bad', error: 'warn' };

export function initKeyBreakerLive() {
  // Docked into the left column as the page's only left-side panel. No in-card
  // mode buttons: the single mode control is the top toolbar (Koruma Kapalı /
  // Key Breaker Aktif / Otomatik Demo), which drives this panel's backend mode.
  return mountLivePanel({
    sim: 'keybreaker',
    workloadId: 'key-breaker-simulation',
    db: 'KEYBREAKER',
    accent: '#22e39a',
    anchor: '.toolbar-controls',
    mount: '.col-left',
    persistDocked: true,
    demoNote: 'Gerçek ölçümler için üstteki "Canlı" moduna geçin.',
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
