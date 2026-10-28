const $ = (s, r = document) => r.querySelector(s);
const tokens = {};
async function token(org) {
  if (!tokens[org]) tokens[org] = (await (await fetch("/_admin/token?org=" + org)).json()).token;
  return tokens[org];
}
function chip(text, cls) {
  const s = document.createElement("span");
  s.className = "chip " + cls;
  s.textContent = text;
  return s;
}
async function call(route, org) {
  const t = await token(org);
  const started = performance.now();
  const res = await fetch(route, { headers: { authorization: "Bearer " + t } });
  await res.arrayBuffer();
  return { status: res.status, source: res.headers.get("stub-source") || "none", ms: performance.now() - started, route, org };
}
async function refreshStats() {
  const s = await (await fetch("/_admin/stats")).json();
  const served = s.fresh + s.stale + s.fetched + s.unknown;
  return { served, hit: served ? Math.round((100 * (s.fresh + s.stale)) / served) : 0, calls: s.calls, merged: s.merged, errors: s.providerErrors };
}
function describe(r) {
  const names = { "/v1/reports": "Reports", "/v1/exports": "Exports", "/v1/agents/run": "Agent run" };
  return names[r.route] + " as " + r.org;
}
