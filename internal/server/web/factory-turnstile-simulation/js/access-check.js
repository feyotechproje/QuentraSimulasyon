// access-check.js
// The access-control "business rule" as a swappable data source. The renderer
// and worker state machine never touch this directly beyond the abstract
// interface, so a real API-backed source can be dropped in later without any
// visual changes. Everything here is in-memory demo data — no persistence.

export const MOVEMENT = { EXIT: "EXIT", ENTRY: "ENTRY", NONE: "NONE" };
export const DECISION = {
  APPROVED: "ENTRY_APPROVED",
  DENIED: "ACCESS_DENIED",
  MANUAL: "MANUAL_REVIEW",
};

// Duration profiles. Only "SlowBaseline" is active in this phase; the optimized
// profile is declared so a BEFORE/AFTER toggle can be added later by swapping
// `SimulationProfile.active` — nothing else needs to change.
export const SimulationProfile = {
  SlowBaseline: {
    id: "SlowBaseline",
    label: "Baseline — slow last-movement query",
    slowThreshold: 2.5,
    timeoutThreshold: 10,
    // weighted buckets, seconds
    buckets: [
      { min: 0.4, max: 0.9, weight: 0.24 }, // normal
      { min: 2.5, max: 6.0, weight: 0.44 }, // slow
      { min: 7.0, max: 12.0, weight: 0.22 }, // very slow
      { min: 10.0, max: 15.0, weight: 0.1 }, // timeout range
    ],
  },
  QuentraOptimized: {
    id: "QuentraOptimized",
    label: "Quentra — cached last-movement lookup",
    slowThreshold: 0.25,
    timeoutThreshold: 2,
    buckets: [{ min: 0.08, max: 0.22, weight: 1 }],
  },
  active: null, // set below
};
SimulationProfile.active = SimulationProfile.SlowBaseline;

function weightedDuration(buckets) {
  let total = 0;
  for (const b of buckets) total += b.weight;
  let roll = Math.random() * total;
  for (const b of buckets) {
    if (roll < b.weight) return b.min + Math.random() * (b.max - b.min);
    roll -= b.weight;
  }
  const last = buckets[buckets.length - 1];
  return last.min + Math.random() * (last.max - last.min);
}

// Result distribution for the demo (see spec):
//  82% last=EXIT   -> approved
//   8% last=ENTRY  -> denied
//   5% none        -> manual review
//   3% timeout     -> manual review
//   2% invalid card-> denied
function rollOutcome() {
  const r = Math.random();
  if (r < 0.82) return { movement: MOVEMENT.EXIT, decision: DECISION.APPROVED, reason: "Last movement EXIT" };
  if (r < 0.9) return { movement: MOVEMENT.ENTRY, decision: DECISION.DENIED, reason: "Previous movement already ENTRY" };
  if (r < 0.95) return { movement: MOVEMENT.NONE, decision: DECISION.MANUAL, reason: "No previous movement found" };
  if (r < 0.98) return { movement: MOVEMENT.NONE, decision: DECISION.MANUAL, reason: "Movement query timeout", timeout: true };
  return { movement: MOVEMENT.NONE, decision: DECISION.DENIED, reason: "Invalid card" };
}

/** Abstract contract. A future ApiFactoryAccessDataSource can implement this. */
export class SimulationDataSource {
  // eslint-disable-next-line no-unused-vars
  requestCheck(_employee) {
    throw new Error("not implemented");
  }
}

/** In-memory demo source: fabricates a plausible check result + duration. */
export class InMemoryFactoryAccessDataSource extends SimulationDataSource {
  constructor(profile = SimulationProfile.active) {
    super();
    this.profile = profile;
  }

  requestCheck(_employee) {
    const outcome = rollOutcome();
    let duration = weightedDuration(this.profile.buckets);
    if (outcome.timeout) duration = Math.max(duration, this.profile.timeoutThreshold + Math.random() * 4);
    return {
      requestedAction: "ENTRY",
      rule: "Previous movement must be EXIT",
      lastMovement: outcome.movement,
      decision: outcome.decision,
      reason: outcome.reason,
      duration, // seconds the CHECKING_LAST_MOVEMENT state should last
      slow: duration >= this.profile.slowThreshold,
      timeout: !!outcome.timeout || duration >= this.profile.timeoutThreshold,
    };
  }
}
