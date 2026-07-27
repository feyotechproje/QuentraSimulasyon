// Bootstrap: build simulation, wire the toolbar controls, run the engine.
import { VIEW } from './config.js';
import { Simulation } from './simulation.js';
import { Engine } from './engine.js';
import { UI } from './ui.js';
import { initQuentraApp } from '/shared/quentra-i18n.js';
import { FULLTEXT_INTRO, FULLTEXT_DICT } from './i18n.js';

function boot() {
  const canvas = document.getElementById('scene');
  const sim = new Simulation(VIEW);
  const ui = new UI(sim);
  const engine = new Engine(canvas, sim, () => ui.update());
  engine.start();
  ui.update();

  function setActive(group, btn) {
    document.querySelectorAll(`[data-group="${group}"]`).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      sim.setMode(btn.dataset.mode);
      setActive('mode', btn);
    });
  });

  document.getElementById('btnPause').addEventListener('click', () => engine.pause());
  document.getElementById('btnResume').addEventListener('click', () => engine.resume());
  document.getElementById('btnReset').addEventListener('click', () => {
    sim.reset();
    document.querySelectorAll('[data-group="mode"]').forEach(b => b.classList.toggle('active', b.dataset.mode === 'auto'));
  });

  document.getElementById('speed').addEventListener('change', e => engine.setSpeed(parseFloat(e.target.value)));

  window.addEventListener('quentra:langchange', () => ui.update());

  window.__office = { sim, engine, ui };
}

initQuentraApp({
  appId: 'fulltext-search',
  accent: '#7c3aed',
  accent2: '#2563eb',
  brand: { name: 'Quentra FullText', sub: 'NGram Search', logo: '/assets/quentra-logo.png' },
  intro: FULLTEXT_INTRO,
  dict: FULLTEXT_DICT,
  onReady: () => boot(),
});
