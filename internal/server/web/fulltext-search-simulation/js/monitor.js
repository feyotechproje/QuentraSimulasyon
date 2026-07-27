// Renders the enterprise document-management application shown on each monitor.
// Baseline mode = slow LIKE '%...%' sequential scan with thousands of documents
// flowing past. Quentra mode = NGram index pipeline + instant MATCH result card.
import { C, PHASE } from './config.js';
import { rr, fmtInt, clamp, smooth, t as tr } from './draw.js';

const FONT = '-apple-system, "Segoe UI", Inter, system-ui, sans-serif';

function docIcon(ctx, x, y, w, col) {
  const h = w * 1.28;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w * 0.7, y);
  ctx.lineTo(x + w, y + h * 0.24);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fill();
  // folded corner
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath();
  ctx.moveTo(x + w * 0.7, y);
  ctx.lineTo(x + w, y + h * 0.24);
  ctx.lineTo(x + w * 0.7, y + h * 0.24);
  ctx.closePath();
  ctx.fill();
  // text lines
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.lineWidth = Math.max(0.5, w * 0.06);
  for (let i = 0; i < 3; i++) {
    const ly = y + h * (0.45 + i * 0.16);
    ctx.beginPath(); ctx.moveTo(x + w * 0.18, ly); ctx.lineTo(x + w * 0.82, ly); ctx.stroke();
  }
}

export function drawScreen(ctx, x, y, w, h, emp, t, s) {
  // Base.
  ctx.fillStyle = '#f4f6fa';
  ctx.fillRect(x, y, w, h);

  // Title bar.
  const barH = h * 0.15;
  ctx.fillStyle = emp.mode === PHASE.QUENTRA ? '#5b2bc4' : '#243044';
  ctx.fillRect(x, y, w, barH);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = `600 ${barH * 0.62}px ${FONT}`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText(tr('screen.title', 'DocuVault · Records'), x + w * 0.04, y + barH * 0.54);
  // window dots
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = ['#ff5f57', '#febc2e', '#28c840'][i];
    ctx.beginPath(); ctx.arc(x + w - w * 0.05 - i * barH * 0.5, y + barH * 0.5, barH * 0.16, 0, Math.PI * 2); ctx.fill();
  }

  // Search row.
  const sy = y + barH + h * 0.03;
  const sh = h * 0.15;
  ctx.fillStyle = '#ffffff';
  rr(ctx, x + w * 0.04, sy, w * 0.62, sh, sh * 0.25); ctx.fill();
  ctx.strokeStyle = '#d5dae4'; ctx.lineWidth = Math.max(0.6, s * 0.8);
  rr(ctx, x + w * 0.04, sy, w * 0.62, sh, sh * 0.25); ctx.stroke();
  ctx.fillStyle = C.ink;
  ctx.font = `600 ${sh * 0.62}px ${FONT}`;
  ctx.fillText(emp.ref, x + w * 0.08, sy + sh * 0.54);
  // caret blink
  if (Math.floor(t * 2) % 2 === 0) {
    const cw = ctx.measureText(emp.ref).width;
    ctx.fillStyle = C.blue;
    ctx.fillRect(x + w * 0.085 + cw, sy + sh * 0.22, Math.max(0.8, s), sh * 0.6);
  }
  // Search button.
  ctx.fillStyle = emp.mode === PHASE.QUENTRA ? C.purple : C.blue;
  rr(ctx, x + w * 0.70, sy, w * 0.26, sh, sh * 0.25); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
  ctx.font = `600 ${sh * 0.56}px ${FONT}`;
  ctx.fillText(tr('screen.searchBtn', 'Search'), x + w * 0.83, sy + sh * 0.54);
  ctx.textAlign = 'left';

  // Content region.
  const cy = sy + sh + h * 0.03;
  const ch = y + h - cy - h * 0.02;
  const cx0 = x + w * 0.04, cw0 = w * 0.92;

  if (emp.mode === PHASE.BASELINE) {
    drawBaselineContent(ctx, emp, t, s, cx0, cy, cw0, ch, x, y, w, h);
  } else {
    drawQuentraContent(ctx, emp, t, s, cx0, cy, cw0, ch);
  }
}

function drawBaselineContent(ctx, emp, t, s, cx0, cy, cw0, ch, x, y, w, h) {
  // Flowing document band (thousands scanned).
  ctx.save();
  rr(ctx, cx0, cy, cw0, ch * 0.62, 2 * s); ctx.clip();
  ctx.fillStyle = '#eef1f6'; ctx.fillRect(cx0, cy, cw0, ch * 0.62);
  const dw = cw0 * 0.05;
  for (const d of emp.docs) {
    const dx = cx0 + d.x * cw0;
    const dy = cy + d.y * ch * 0.5 + ch * 0.04;
    ctx.globalAlpha = d.alpha * 0.9;
    docIcon(ctx, dx, dy, dw, d.row % 2 ? '#9fb0c8' : '#b7c2d4');
    ctx.globalAlpha = 1;
  }
  // moving scan sweep
  const sweep = (t * 0.35 % 1) * cw0;
  const sg = ctx.createLinearGradient(cx0 + sweep - cw0 * 0.1, 0, cx0 + sweep + cw0 * 0.1, 0);
  sg.addColorStop(0, 'rgba(245,158,11,0)');
  sg.addColorStop(0.5, 'rgba(245,158,11,0.30)');
  sg.addColorStop(1, 'rgba(245,158,11,0)');
  ctx.fillStyle = sg; ctx.fillRect(cx0, cy, cw0, ch * 0.62);
  ctx.restore();

  // Query chip.
  ctx.fillStyle = 'rgba(239,68,68,0.10)';
  rr(ctx, cx0, cy + ch * 0.66, cw0 * 0.66, ch * 0.14, 2 * s); ctx.fill();
  ctx.fillStyle = C.red;
  ctx.font = `600 ${ch * 0.095}px ${FONT}`; ctx.textBaseline = 'middle';
  ctx.fillText(`LIKE '%${emp.ref}%'`, cx0 + cw0 * 0.02, cy + ch * 0.735);

  // Spinner.
  const spx = cx0 + cw0 * 0.06, spy = cy + ch * 0.90, sr = ch * 0.06;
  ctx.strokeStyle = '#e4c48a'; ctx.lineWidth = Math.max(1, s * 1.2);
  ctx.beginPath(); ctx.arc(spx, spy, sr, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = C.orange;
  ctx.beginPath(); ctx.arc(spx, spy, sr, t * 6, t * 6 + Math.PI * 1.1); ctx.stroke();

  // Status text + elapsed + docs scanned.
  ctx.fillStyle = C.muted; ctx.font = `600 ${ch * 0.085}px ${FONT}`;
  ctx.fillText(tr('screen.scanning', 'Scanning documents…'), spx + sr + cw0 * 0.03, spy - ch * 0.045);
  ctx.fillStyle = C.orange; ctx.font = `700 ${ch * 0.11}px ${FONT}`;
  ctx.fillText(`${emp.elapsed.toFixed(2)} s`, spx + sr + cw0 * 0.03, spy + ch * 0.055);
  ctx.textAlign = 'right';
  ctx.fillStyle = C.faint; ctx.font = `600 ${ch * 0.08}px ${FONT}`;
  ctx.fillText(`${fmtInt(emp.docsScanned)} ${tr('screen.scannedSuffix', 'scanned')}`, cx0 + cw0, spy + ch * 0.055);
  ctx.textAlign = 'left';

  // Progress bar (indeterminate feel).
  const pby = cy + ch * 0.99;
  ctx.fillStyle = '#e2e6ee'; rr(ctx, cx0 + cw0 * 0.66, cy + ch * 0.66, cw0 * 0.34, ch * 0.14, 2 * s); ctx.fill();
  const prog = (Math.sin(t * 2 + emp.id) * 0.5 + 0.5) * 0.5 + 0.15;
  ctx.fillStyle = C.orange;
  rr(ctx, cx0 + cw0 * 0.66, cy + ch * 0.66, cw0 * 0.34 * prog, ch * 0.14, 2 * s); ctx.fill();
}

function drawQuentraContent(ctx, emp, t, s, cx0, cy0, cw0, ch0) {
  // Big state label: Searching... -> Match Found (the wave-visible headline).
  const labelH = ch0 * 0.16;
  ctx.fillStyle = emp.resolved ? C.green : C.purple;
  ctx.font = `800 ${labelH * 0.72}px ${FONT}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(emp.resolved ? tr('screen.matchFound', 'Match Found') : tr('screen.searching', 'Searching…'), cx0, cy0 + labelH * 0.62);

  const cy = cy0 + labelH, ch = ch0 - labelH;

  // NGram pipeline chips.
  const stages = [tr('screen.stage.ngram', 'NGram Index'), tr('screen.stage.searching', 'Searching'), tr('screen.stage.match', 'MATCH')];
  const chipW = cw0 * 0.31, chipH = ch * 0.16, gap = cw0 * 0.015;
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 3; i++) {
    const cxp = cx0 + i * (chipW + gap);
    const done = emp.resolved || i < emp.pipeStage;
    const active = !emp.resolved && i === emp.pipeStage;
    let bg = '#e8ebf1', fg = C.faint;
    if (done && i === 2) { bg = 'rgba(22,163,74,0.14)'; fg = C.green; }
    else if (done) { bg = 'rgba(124,58,237,0.14)'; fg = C.purple; }
    else if (active) { bg = 'rgba(124,58,237,0.20)'; fg = C.purple; }
    ctx.fillStyle = bg; rr(ctx, cxp, cy, chipW, chipH, chipH * 0.28); ctx.fill();
    ctx.fillStyle = fg; ctx.font = `700 ${chipH * 0.42}px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText(stages[i], cxp + chipW / 2, cy + chipH * 0.54);
    if (active) {
      ctx.fillStyle = C.purple;
      const dotsN = 1 + Math.floor(t * 3) % 3;
      ctx.fillText('•'.repeat(dotsN), cxp + chipW / 2, cy + chipH * 0.9);
    }
    // arrow
    if (i < 2) { ctx.fillStyle = C.faint; ctx.fillText('›', cxp + chipW + gap / 2, cy + chipH / 2); }
  }
  ctx.textAlign = 'left';

  // Elapsed (fast, green).
  const ey = cy + chipH + ch * 0.05;
  ctx.fillStyle = C.green; ctx.font = `800 ${ch * 0.15}px ${FONT}`;
  ctx.fillText(`${emp.resultMs} ms`, cx0, ey + ch * 0.02);
  ctx.fillStyle = C.muted; ctx.font = `600 ${ch * 0.08}px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText(tr('screen.indexSeek', 'Index Seek · 1 exec'), cx0 + cw0, ey + ch * 0.02);
  ctx.textAlign = 'left';

  // Result card reveal.
  const rv = smooth(emp.reveal);
  if (rv <= 0.01) return;
  const ry = ey + ch * 0.11;
  const rh = ch * 0.40;
  ctx.save();
  ctx.globalAlpha = rv;
  ctx.fillStyle = '#ffffff';
  rr(ctx, cx0, ry, cw0, rh, 3 * s); ctx.fill();
  ctx.strokeStyle = 'rgba(22,163,74,0.5)'; ctx.lineWidth = Math.max(0.8, s);
  rr(ctx, cx0, ry, cw0, rh, 3 * s); ctx.stroke();

  // PDF icon — pops with a brief scale/glow the moment it "arrives" (reveal
  // just crossed the flight landing point), echoing the flying doc above.
  const iw = cw0 * 0.12, ix = cx0 + cw0 * 0.03, iy = ry + rh * 0.2;
  const justLanded = clamp(1 - Math.abs(rv - 0.15) * 6, 0, 1);
  const pop = 1 + justLanded * 0.35;
  ctx.save();
  ctx.translate(ix + iw * 0.5, iy + iw * 0.64); ctx.scale(pop, pop); ctx.translate(-(ix + iw * 0.5), -(iy + iw * 0.64));
  if (justLanded > 0.05) { ctx.shadowColor = C.purpleGlow; ctx.shadowBlur = 14 * s * justLanded; }
  docIcon(ctx, ix, iy, iw, '#e2453c');
  ctx.fillStyle = '#fff'; ctx.font = `800 ${iw * 0.34}px ${FONT}`; ctx.textAlign = 'center';
  ctx.fillText('PDF', ix + iw * 0.5, iy + iw * 0.95);
  ctx.restore();
  ctx.textAlign = 'left';

  // Details.
  const tx = ix + iw + cw0 * 0.04;
  ctx.fillStyle = C.ink; ctx.font = `700 ${rh * 0.17}px ${FONT}`;
  ctx.fillText(`Contract_${emp.ref}.pdf`, tx, ry + rh * 0.22);
  ctx.fillStyle = C.muted; ctx.font = `500 ${rh * 0.13}px ${FONT}`;
  ctx.fillText(`Ref ${emp.ref} · 2024-11-08`, tx, ry + rh * 0.45);
  ctx.fillText(`${tr('screen.department', 'Legal Dept')} · 2.4 MB`, tx, ry + rh * 0.64);

  // Green check + "Result found".
  ctx.fillStyle = C.green;
  ctx.beginPath(); ctx.arc(cx0 + cw0 - rh * 0.24, ry + rh * 0.26, rh * 0.14, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1, s * 1.2); ctx.lineCap = 'round';
  const kx = cx0 + cw0 - rh * 0.24, ky = ry + rh * 0.26, kr = rh * 0.07;
  ctx.beginPath(); ctx.moveTo(kx - kr, ky); ctx.lineTo(kx - kr * 0.2, ky + kr); ctx.lineTo(kx + kr, ky - kr * 0.9); ctx.stroke();
  ctx.fillStyle = C.green; ctx.font = `700 ${rh * 0.12}px ${FONT}`; ctx.textAlign = 'right';
  ctx.fillText(tr('screen.resultFound', 'Result found'), cx0 + cw0 - rh * 0.05, ry + rh * 0.9);
  ctx.textAlign = 'left';
  ctx.restore();

  // Flying "target acquired" document — launches from the pipeline chips
  // and flies directly into the result window's PDF icon.
  if (emp.flyDoc && emp.flyDoc.t < 1) {
    const ft = smooth(emp.flyDoc.t);
    const startX = cx0 + cw0 * 0.85, startY = cy + chipH * 0.5;
    const targetX = ix + iw * 0.1, targetY = iy + iw * 0.1;
    const arcLift = -ch0 * 0.06 * Math.sin(ft * Math.PI);
    const fx = startX + (targetX - startX) * ft;
    const fy = startY + (targetY - startY) * ft + arcLift;
    const fscale = 1 - ft * 0.35;
    ctx.save();
    ctx.globalAlpha = 1 - ft * 0.2;
    ctx.shadowColor = C.purpleGlow; ctx.shadowBlur = (10 - ft * 6) * s;
    docIcon(ctx, fx, fy, cw0 * 0.11 * fscale, C.purple);
    ctx.restore();
  }
}

export function drawSecondaryScreen(ctx, x, y, w, h, emp, t, s) {
  // A muted secondary display: file browser / email-ish list.
  ctx.fillStyle = emp.mode === PHASE.QUENTRA ? '#f3f0fb' : '#eef1f6';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = emp.mode === PHASE.QUENTRA ? '#7c3aed' : '#33405a';
  ctx.fillRect(x, y, w, h * 0.14);
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 6; i++) {
    const ly = y + h * (0.2 + i * 0.12);
    ctx.globalAlpha = 0.8;
    rr(ctx, x + w * 0.08, ly, w * 0.84, h * 0.075, h * 0.03); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = i === 1 && emp.mode === PHASE.QUENTRA ? C.greenSoft : '#cfd6e2';
    ctx.beginPath(); ctx.arc(x + w * 0.14, ly + h * 0.037, h * 0.025, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
  }
}
