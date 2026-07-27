// models.js — enums, small math helpers, packet/query/particle factories.

export const MODE = { OFF: "off", ACTIVE: "active", AUTO: "auto" };

// Attack packet lifecycle (Key Breaker Active path).
export const PSTATE = {
  CREATED: "CREATED",
  LEAVING_SOURCE: "LEAVING_SOURCE",
  TRAVELING: "TRAVELING",
  APPROACHING_GATEWAY: "APPROACHING_GATEWAY",
  INSPECTING: "INSPECTING",
  THREAT_CONFIRMED: "THREAT_CONFIRMED",
  IMPACTING_SHIELD: "IMPACTING_SHIELD",
  BLOCKED: "BLOCKED",
  FRAGMENTING: "FRAGMENTING",
  FADING: "FADING",
  COMPLETED: "COMPLETED",
  // Protection-Off path
  BYPASSING_GATEWAY: "BYPASSING_GATEWAY",
  REACHING_DATABASE: "REACHING_DATABASE",
  INCIDENT_TRIGGERED: "INCIDENT_TRIGGERED",
};

export const SAFE_STATE = {
  CREATED: "CREATED",
  TRAVELING: "TRAVELING",
  VALIDATING: "VALIDATING",
  ALLOWED: "ALLOWED",
  REACHED_DB: "REACHED_DB",
  COMPLETED: "COMPLETED",
};

let _pid = 247;
let _sid = 0;
export const nextAttackId = () => `ATK-${String(++_pid).padStart(6, "0")}`;
export const nextSafeId = () => `SQ-${String(++_sid).padStart(5, "0")}`;

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// Quadratic bezier point.
export function bezier(p0, p1, p2, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

// Format helpers.
export const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
export const fmtMs = (n) => `${n.toFixed(2)} ms`;
export const fmtClock = (s) => {
  if (!(s > 0)) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};
