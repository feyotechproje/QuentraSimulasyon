// Global configuration, palette and layout for the Office FullText/NGram simulation.

export const VIEW = { w: 1600, h: 900 };

// Enterprise light palette — Office / Azure / Stripe / Linear inspired.
export const C = {
  bg: '#f7f8fb',
  bgTop: '#eef1f7',
  floor: '#e9e3d8',        // warm light wood tone base
  floorPlank: '#e2dccf',
  floorPlank2: '#ded6c6',
  rug: '#eef2f8',
  wall: '#f2f4f9',
  wallShade: '#e6e9f1',
  glass: 'rgba(191,214,236,0.20)',
  glassEdge: 'rgba(120,150,190,0.55)',
  ink: '#1f2733',
  muted: '#6b7688',
  faint: '#9aa4b5',
  line: '#d9dfea',
  panel: '#ffffff',
  panelBd: '#e4e8f0',

  purple: '#7c3aed',
  purpleSoft: '#a78bfa',
  purpleGlow: 'rgba(124,58,237,0.55)',
  blue: '#2563eb',
  blueSoft: '#60a5fa',
  green: '#16a34a',
  greenSoft: '#4ade80',
  orange: '#f59e0b',
  red: '#ef4444',

  wood: '#c8a27a',
  woodDark: '#b08a63',
  chair: '#3a4150',
  chairSoft: '#4d5566',
  plant: '#4c9a5b',
  plantDark: '#3d7d49',
};

// Skin / hair variety for the five employees (seen from behind).
export const PEOPLE = [
  { skin: '#e8b98f', hair: '#2c2320', shirt: '#3f5b8b', build: 1.00 }, // Emp 1
  { skin: '#c88a5e', hair: '#171310', shirt: '#5a6472', build: 0.94 }, // Emp 2
  { skin: '#f0c8a0', hair: '#6b4a2b', shirt: '#8a5a7a', build: 1.05 }, // Emp 3
  { skin: '#d9a074', hair: '#3a2a1e', shirt: '#2f7d6b', build: 0.97 }, // Emp 4
  { skin: '#e6b892', hair: '#c9a24b', shirt: '#4b5563', build: 1.02 }, // Emp 5
];

// Staggered desk arrangement (matches the requested diagonal layout).
// Zoomed-in premium framing: desks are large and sit in the lower half.
//   x: horizontal world position (-1 left .. +1 right)
//   d: depth 0 (far) .. 1 (near). Nearer employees are drawn larger and lower.
export const DESKS = [
  { id: 1, x: -0.58, d: 0.58, face: 0.10 },  // Employee 1 — left, mid depth
  { id: 2, x: -0.20, d: 0.28, face: 0.02 },  // Employee 2 — back / center-left
  { id: 3, x: -0.12, d: 0.66, face: -0.06 }, // Employee 3 — pulled left & back, clear of Employee 1
  { id: 4, x:  0.40, d: 0.44, face: -0.02 }, // Employee 4 — upper right
  { id: 5, x:  0.52, d: 0.90, face: -0.10 }, // Employee 5 — front / bottom right
];

// Reference numbers each employee searches for.
export const REFS = ['45872319', '77120934', '20938471', '88301276', '61574092'];

export const DOCS_TOTAL = 12842118;

// Auto-demo timeline (seconds). Loops.
export const TIMELINE = {
  baselineStart: 0,
  loadingSurge: 5,
  quentraActivate: 8.5,
  resolveStart: 10,
  loopEnd: 20,
};

// Phase enum.
export const PHASE = { BASELINE: 'baseline', SURGE: 'surge', ACTIVATING: 'activating', QUENTRA: 'quentra' };
