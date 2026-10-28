/**
 * Measures Stub. Each test starts a fresh server process, so no state is shared between runs.
 * Usage: bun scripts/bench.ts perf|burst|down|stale [--delay 150]
 */
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1]! : fallback;
};
const test = process.argv[2] ?? "perf";
const DELAY = Number(arg("delay", "150"));
const CUSTOMERS = 200;
const ISSUER = "https://bench.kinde.com";
const PORT = 3100;
const base = `http://localhost:${PORT}`;

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" }] });
const sign = (claims: Record<string, unknown>) =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setIssuedAt().setExpirationTime("24h").sign(privateKey);

async function start(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), JWKS_JSON: jwks, ISSUER, PROVIDER: "standin", PROVIDER_DELAY_MS: String(DELAY), ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return proc;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("server did not start");
}

const full = { reports: 100, exports: 100, agent_runs: 100 };
async function seed(n: number, plan: Record<string, number | null> = full) {
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      fetch(`${base}/_admin/plan`, { method: "POST", body: JSON.stringify({ key: `org:c${i}`, plan }) }),
    ),
  );
}
const stats = async () => (await fetch(`${base}/_admin/stats`)).json() as Promise<Record<string, number>>;
const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const summary = (ms: number[]) => {
  const s = [...ms].sort((a, b) => a - b);
  return { median: +pct(s, 50).toFixed(2), p95: +pct(s, 95).toFixed(2), p99: +pct(s, 99).toFixed(2), max: +s[s.length - 1]!.toFixed(2) };
};

// 80% of requests go to 20% of the customers. Routes: 70% reports, 20% exports, 10% agent runs.
const rnd = mulberry(7);
function mulberry(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickCustomer = () => (rnd() < 0.8 ? Math.floor(rnd() * (CUSTOMERS * 0.2)) : Math.floor(rnd() * CUSTOMERS));
const pickRoute = () => { const r = rnd(); return r < 0.7 ? "/v1/reports" : r < 0.9 ? "/v1/exports" : "/v1/agents/run"; };

async function load(total: number, concurrency: number, tokens: string[], pick = pickCustomer) {
  const lat: number[] = [];
  const codes: Record<string, number> = {};
  let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next++ < total) {
      const route = pickRoute();
      const token = tokens[pick()]!;
      const s = performance.now();
      const res = await fetch(base + route, { headers: { authorization: `Bearer ${token}` } });
      await res.arrayBuffer();
      lat.push(performance.now() - s);
      codes[res.status] = (codes[res.status] ?? 0) + 1;
    }
  }));
  const secs = (performance.now() - t0) / 1000;
  return { requests: total, seconds: +secs.toFixed(2), perSecond: Math.round(total / secs), codes, latencyMs: summary(lat) };
}

const tokens = await Promise.all(Array.from({ length: CUSTOMERS }, (_, i) => sign({ org_code: `c${i}` })));
const out: Record<string, unknown> = { test, providerDelayMs: DELAY, customers: CUSTOMERS };

if (test === "perf") {
  // Each mode runs twice on one server: the first run starts with an empty cache, the second with a warm one.
  for (const mode of ["none", "always", "cache"] as const) {
    const p = await start({ MODE: mode });
    await seed(CUSTOMERS);
    const first = await load(3000, 20, tokens);
    const s1 = await stats();
    const second = await load(3000, 20, tokens);
    const s2 = await stats();
    const hit = (st: Record<string, number>, prev: Record<string, number> | null) =>
      +(((st.fresh! - (prev?.fresh ?? 0)) + (st.stale! - (prev?.stale ?? 0))) / 3000).toFixed(4);
    out[mode] = {
      emptyCache: { ...first, providerCalls: s1.calls, hitRate: mode === "cache" ? hit(s1!, null) : null },
      warmCache: { ...second, providerCalls: s2.calls! - s1.calls!, hitRate: mode === "cache" ? hit(s2!, s1) : null },
    };
    p.kill();
    await Bun.sleep(300);
  }
}

if (test === "burst") {
  for (const merge of ["0", "1"]) {
    const p = await start({ MODE: "cache", MERGE: merge });
    await seed(1);
    const lat: number[] = [];
    await Promise.all(Array.from({ length: 200 }, async () => {
      const s = performance.now();
      await (await fetch(`${base}/v1/reports`, { headers: { authorization: `Bearer ${tokens[0]}` } })).arrayBuffer();
      lat.push(performance.now() - s);
    }));
    const st = await stats();
    out[merge === "1" ? "merged" : "unmerged"] = { concurrentRequests: 200, providerCalls: st.calls, latencyMs: summary(lat) };
    p.kill();
    await Bun.sleep(200);
  }
}

if (test === "down") {
  const p = await start({ MODE: "cache", FRESH_MS: "1000", STALE_OK_MS: "300000" });
  await seed(CUSTOMERS);
  // Warm 40 customers, then let their answers go stale and take the provider down.
  await Promise.all(Array.from({ length: 40 }, (_, i) => fetch(`${base}/v1/reports`, { headers: { authorization: `Bearer ${tokens[i]}` } })));
  await Bun.sleep(1200);
  await fetch(`${base}/_admin/down?on=1`, { method: "POST" });
  const known = await load(1000, 20, tokens.slice(0, 40), () => Math.floor(rnd() * 40));
  // Customers never seen before: one cheap route and one sensitive route each.
  const cold: Record<string, { codes: Record<string, number>; latencyMs: ReturnType<typeof summary> }> = {};
  for (const route of ["/v1/reports", "/v1/exports"]) {
    const lat: number[] = []; const codes: Record<string, number> = {};
    for (let i = 100; i < 140; i++) {
      const s = performance.now();
      const res = await fetch(base + route, { headers: { authorization: `Bearer ${tokens[i + (route === "/v1/exports" ? 40 : 0)]}` } });
      await res.arrayBuffer();
      lat.push(performance.now() - s);
      codes[res.status] = (codes[res.status] ?? 0) + 1;
    }
    cold[route] = { codes, latencyMs: summary(lat) };
  }
  out.knownCustomersWhileDown = known;
  out.unseenCustomersWhileDown = cold;
  p.kill();
}

if (test === "slow") {
  // The provider hangs. A lookup is cut off after 300 ms, and three failures in a row open the breaker.
  const p = await start({ MODE: "cache", PROVIDER_DELAY_MS: "5000", TIMEOUT_MS: "300" });
  await seed(CUSTOMERS);
  const result: Record<string, unknown> = { timeoutMs: 300, providerHangsFor: 5000 };
  for (const route of ["/v1/reports", "/v1/exports"]) {
    const lat: number[] = []; const codes: Record<string, number> = {};
    const offset = route === "/v1/reports" ? 0 : 60;
    for (let i = 0; i < 60; i++) {
      const s = performance.now();
      const res = await fetch(base + route, { headers: { authorization: `Bearer ${tokens[offset + i]}` } });
      await res.arrayBuffer();
      lat.push(performance.now() - s);
      codes[res.status] = (codes[res.status] ?? 0) + 1;
    }
    result[route] = { firstThreeMs: lat.slice(0, 3).map(Math.round), afterThatMedianMs: +summary(lat.slice(3)).median.toFixed(2), codes };
  }
  result.providerCalls = (await stats()).calls;
  out.hangingProvider = result;
  p.kill();
}

if (test === "stale") {
  const trials = Number(arg("trials", "3"));
  const readings: Record<string, number[]> = { expiryOnly: [], webhookPurge: [] };
  for (const way of ["expiryOnly", "webhookPurge"] as const) {
    for (let t = 0; t < trials; t++) {
      const p = await start({ MODE: "cache" });
      await seed(1, { reports: 100 });
      const token = tokens[0]!;
      const call = async () => (await fetch(`${base}/v1/exports`, { headers: { authorization: `Bearer ${token}` } })).status;
      if ((await call()) !== 403) throw new Error("expected 403 before the change");
      await Bun.sleep(Math.floor(rnd() * 25_000)); // change lands at a random point of the 30 s window
      await fetch(`${base}/_admin/plan`, { method: "POST", body: JSON.stringify({ key: "org:c0", plan: { reports: 100, exports: 100 } }) });
      const changedAt = performance.now();
      if (way === "webhookPurge") {
        const event = await sign({ type: "customer.plan_changed", data: { org_code: "c0" } });
        await fetch(`${base}/webhooks/kinde`, { method: "POST", body: event });
      }
      let seen = -1;
      while (performance.now() - changedAt < 90_000) {
        if ((await call()) === 200) { seen = performance.now() - changedAt; break; }
        await Bun.sleep(50);
      }
      readings[way].push(Math.round(seen));
      p.kill();
      await Bun.sleep(200);
    }
  }
  out.msUntilTheChangeIsSeen = readings;
}

console.log(JSON.stringify(out, null, 2));
await Bun.write(`results-${test}.json`, JSON.stringify(out, null, 2));
process.exit(0);
