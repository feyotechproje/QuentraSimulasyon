// workload-control.js
// Shared client for the portal's run/stop API (/api/workloads).
//
// No backend workload runs at boot any more, so a simulation page must claim
// its own workload when it opens and release it when it goes away. That keeps
// SQL Server idle while nobody is looking at a demo, and means whichever
// simulation you pick is the one — and the only one — actually running.

const BASE = "/api/workloads";

/** Fetch the run state of every workload. Returns [] when the API is down. */
export async function listWorkloads() {
  try {
    const r = await fetch(BASE, { cache: "no-store" });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data.workloads) ? data.workloads : [];
  } catch {
    return [];
  }
}

/**
 * Start or stop one workload.
 * Resolves to {ok, workload?, error?} — never rejects, so callers can drive UI
 * state without wrapping every call in try/catch.
 */
export async function setWorkload(id, running) {
  const action = running ? "start" : "stop";
  try {
    const r = await fetch(`${BASE}/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data.error || `HTTP ${r.status}` };
    return { ok: true, workload: data.workload };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Claim a workload for as long as this page is open: start it now, and stop it
 * again on pagehide (sendBeacon, so it survives the tab closing).
 *
 * Returns a handle with release() for pages that also want a manual stop
 * button, plus the result of the initial start attempt via .ready.
 */
export function claimWorkload(id, { autoStart = true, stopOnExit = true } = {}) {
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    const url = `${BASE}/${encodeURIComponent(id)}/stop`;
    // sendBeacon survives unload where fetch would be cancelled.
    if (!navigator.sendBeacon?.(url, new Blob([], { type: "application/json" }))) {
      // keepalive lets the request outlive the page when sendBeacon is absent.
      fetch(url, { method: "POST", keepalive: true }).catch(() => {});
    }
  };

  if (stopOnExit) {
    window.addEventListener("pagehide", release);
  }

  const ready = autoStart ? setWorkload(id, true) : Promise.resolve({ ok: true });

  return {
    id,
    ready,
    release,
    start: () => {
      released = false;
      return setWorkload(id, true);
    },
    stop: () => {
      released = true;
      return setWorkload(id, false);
    },
  };
}
