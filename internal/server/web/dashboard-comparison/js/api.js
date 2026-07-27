// api.js — thin wrappers around the /demo/dashboard endpoints.

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export function fetchDashboard(region = "") {
  const q = region ? `?region=${encodeURIComponent(region)}` : "";
  return getJSON(`/demo/dashboard${q}`);
}

export function fetchFilter(region, mode) {
  return getJSON(`/demo/dashboard/filter?region=${encodeURIComponent(region)}&mode=${mode}`);
}

export function fetchQueryDetails(region) {
  return getJSON(`/demo/dashboard/query-details?region=${encodeURIComponent(region)}`);
}

export async function resetSimulation() {
  const res = await fetch(`/demo/dashboard/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`reset -> ${res.status}`);
  return res.json();
}
