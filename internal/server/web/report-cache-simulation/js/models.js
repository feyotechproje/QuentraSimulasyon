// models.js — state enums, small math utils, and object factories.

export const USER_STATE = {
  IDLE:"IDLE", REQUESTING:"REQUESTING_REPORT", SENT:"REQUEST_SENT", WAITING:"WAITING",
  PROCESSING:"REPORT_PROCESSING", RECEIVING:"RECEIVING_RESPONSE", READY:"REPORT_READY",
  TIMEOUT:"TIMEOUT", COMPLETED:"COMPLETED",
};

export const REQ_STATE = {
  CREATED:"CREATED", TO_QUENTRA:"TRAVELING_TO_QUENTRA", FINGERPRINT:"FINGERPRINTING",
  LOOKUP:"CACHE_LOOKUP", MISS:"CACHE_MISS", TO_SQL:"TRAVELING_TO_SQL", EXEC:"EXECUTING_SQL",
  STORING:"STORING_CACHE", HIT:"CACHE_HIT", RETURNING:"RETURNING_RESULT", DELIVERED:"DELIVERED",
};

export const SCREEN = { IDLE:"idle", LOADING:"loading", READY:"ready", TIMEOUT:"timeout" };

// ---- math / helpers ----
export const rand  = (a, b) => a + Math.random() * (b - a);
export const randi = (a, b) => Math.floor(rand(a, b + 1));
export const pick  = arr => arr[(Math.random() * arr.length) | 0];
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp  = (a, b, t) => a + (b - a) * t;
export const approach = (v, target, rate, dt) => v + (target - v) * (1 - Math.exp(-rate * dt));
export const ease = t => t < .5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2;

let _uid = 0;
export const uid = (p="") => `${p}${(_uid++).toString(36)}`;

// Quadratic bezier point + a light "arc" control so wires aren't straight.
export function bezier(p0, p1, p2, t) {
  const u = 1 - t;
  return {
    x: u*u*p0.x + 2*u*t*p1.x + t*t*p2.x,
    y: u*u*p0.y + 2*u*t*p1.y + t*t*p2.y,
  };
}
export function controlPoint(a, b, bow = 0.16) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  return { x: mx - dy * bow, y: my + dx * bow };
}

// ---- factories (pure data holders) ----
export function makeCache() {
  return { state:"EMPTY", reportId:null, cacheKey:null, ttl:0, hits:0, misses:0,
           storedAt:null, size:0, savedExecutions:0, lastAccess:null, pulse:0 };
}
export function makeSql() {
  return { cpu:8, memory:34, logicalReads:0, diskReads:6, activeQueries:0, queuedQueries:0,
           executions:0, sameQueryRuns:0, state:"IDLE", heat:0,
           runningCards:[] /* {id,elapsed,dur} */ };
}
