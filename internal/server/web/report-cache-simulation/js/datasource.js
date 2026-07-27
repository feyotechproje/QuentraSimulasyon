// datasource.js — SimulationDataSource abstraction.
// The renderer/sim never touch a real backend. This layer only supplies
// static report metadata + timing config, so a future ApiReportCacheDataSource
// could swap in without changing the simulation or rendering code.

import { REPORT, TIMINGS, TOTAL_USERS } from "./config.js";

/** Base contract. */
export class SimulationDataSource {
  report() { throw new Error("not implemented"); }
  timings() { throw new Error("not implemented"); }
  totalUsers() { throw new Error("not implemented"); }
}

/** In-memory, fully client-side data source (no DB / no API). */
export class InMemoryReportCacheDataSource extends SimulationDataSource {
  report() { return REPORT; }
  timings() { return TIMINGS; }
  totalUsers() { return TOTAL_USERS; }
}

// NOTE: ApiReportCacheDataSource is intentionally NOT implemented in this phase.
