/**
 * Runs the gateway against live Kinde. Tokens are signed here with a local key, so the token check is local
 * and the entitlement lookups are real. Needs the Kinde values in .env.local and customers.json.
 * Usage: bun scripts/live-gate.ts
 */
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const PORT = 3101;
const base = `http://localhost:${PORT}`;
const ISSUER = "https://live-gate.test";
const orgs = [
  { name: "Acme", plan: "stub_free", code: "org_8c272f3458bd", allowed: ["/v1/reports"] },
  { name: "Globex", plan: "stub_pro", code: "org_8033a1353b09", allowed: ["/v1/reports", "/v1/exports"] },
  { name: "Initech", plan: "stub_business", code: "org_cb29ff36f67c", allowed: ["/v1/reports", "/v1/exports", "/v1/agents/run"] },
];
const routes = ["/v1/reports", "/v1/exports", "/v1/agents/run"];

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" }] });
const sign = (code: string) =>
  new SignJWT({ org_code: code }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setIssuedAt().setExpirationTime("1h").sign(privateKey);
const tokens = Object.fromEntries(await Promise.all(orgs.map(async (o) => [o.code, await sign(o.code)])));

async function start(mode: string) {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), JWKS_JSON: jwks, ISSUER, PROVIDER: "kinde", MODE: mode },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return proc;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const fmt = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return `median ${pct(s, 50).toFixed(1)} ms, 95th ${pct(s, 95).toFixed(1)} ms, 99th ${pct(s, 99).toFixed(1)} ms, max ${s[s.length - 1]!.toFixed(1)} ms`;
};
const count = (xs: string[]) => JSON.stringify(xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {}));

async function hit(route: string, code: string) {
  const t0 = performance.now();
  const res = await fetch(base + route, { headers: { authorization: `Bearer ${tokens[code]}` } });
  await res.arrayBuffer();
  return { status: res.status, source: res.headers.get("stub-source") ?? "none", ms: performance.now() - t0 };
}

async function pool(total: number, concurrency: number, job: (i: number) => Promise<{ status: number; source: string; ms: number }>) {
  const out: { status: number; source: string; ms: number }[] = [];
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) out.push(await job(next++));
    }),
  );
  return { out, seconds: (performance.now() - t0) / 1000 };
}

// 1. Who may call what, decided from live plans
let proc = await start("cache");
console.log("DECISIONS (live plans)");
for (const o of orgs) {
  for (const route of routes) {
    const r = await hit(route, o.code);
    const want = o.allowed.includes(route) ? 200 : 403;
    console.log(`  ${o.name.padEnd(8)} ${o.plan.padEnd(14)} ${route.padEnd(16)} ${r.status} ${r.status === want ? "as expected" : `EXPECTED ${want}`} (${r.source})`);
  }
}

// 2. Steady load with the cache
const load = await pool(2000, 50, (i) => hit(routes[i % 3]!, orgs[i % 3]!.code));
console.log(`\nCACHE MODE  2000 requests, 50 at a time: ${(2000 / load.seconds).toFixed(0)} a second`);
console.log(`  ${fmt(load.out.map((r) => r.ms))}`);
console.log(`  statuses ${count(load.out.map((r) => String(r.status)))}, sources ${count(load.out.map((r) => r.source))}`);
proc.kill();
await proc.exited;

// 3. Cold start: 200 simultaneous requests for one organization
proc = await start("cache");
const burst = await pool(200, 200, () => hit("/v1/reports", orgs[2]!.code));
console.log(`\nCOLD BURST  200 simultaneous requests for one new customer, all done in ${burst.seconds.toFixed(2)} s`);
console.log(`  ${fmt(burst.out.map((r) => r.ms))}`);
console.log(`  statuses ${count(burst.out.map((r) => String(r.status)))}, sources ${count(burst.out.map((r) => r.source))}`);
proc.kill();
await proc.exited;

// 4. A lookup on every request, kept small so the Kinde account is not pushed hard
proc = await start("always");
const always = await pool(40, 4, (i) => hit(routes[i % 3]!, orgs[i % 3]!.code));
console.log(`\nLOOKUP ON EVERY REQUEST  40 requests, 4 at a time: ${(40 / always.seconds).toFixed(1)} a second`);
console.log(`  ${fmt(always.out.map((r) => r.ms))}`);
console.log(`  statuses ${count(always.out.map((r) => String(r.status)))}, sources ${count(always.out.map((r) => r.source))}`);
proc.kill();
await proc.exited;
