// datasource.js — SimulationDataSource abstraction.
// The simulation/renderer never touch a real backend, real DB, or real security
// engine. This layer only supplies static demo metadata. A future
// ApiKeyBreakerDataSource could swap in without changing sim or rendering code.

import { ATTACKERS, SAFE_QUERIES, ATTACK_TYPES, PAYLOADS, TIMINGS } from "./config.js";

/** Base contract. */
export class SimulationDataSource {
  attackers()   { throw new Error("not implemented"); }
  attackType(k) { throw new Error("not implemented"); }
  payload(k)    { throw new Error("not implemented"); }
  safeQueries() { throw new Error("not implemented"); }
  timings()     { throw new Error("not implemented"); }
}

/** In-memory, fully client-side data source (NO DB / NO API / NO WebSocket). */
export class InMemoryKeyBreakerDataSource extends SimulationDataSource {
  attackers()   { return ATTACKERS; }
  attackType(k) { return ATTACK_TYPES[k]; }
  payload(k)    { return PAYLOADS[k]; }
  safeQueries() { return SAFE_QUERIES; }
  timings()     { return TIMINGS; }
}

// NOTE: ApiKeyBreakerDataSource is intentionally NOT implemented in this phase.
