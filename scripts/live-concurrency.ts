/**
 * Calls Kinde's entitlements endpoint directly, with no timeout, at rising concurrency.
 * Shows how latency and status codes change when calls overlap. Kept small on purpose.
 * Usage: bun scripts/live-concurrency.ts
 */
const domain = (process.env.KINDE_DOMAIN ?? "").replace(/\/$/, "");
const clientId = process.env.KINDE_M2M_CLIENT_ID ?? "";
const clientSecret = process.env.KINDE_M2M_CLIENT_SECRET ?? "";
if (!domain || !clientId || !clientSecret) {
  console.error("KINDE_DOMAIN, KINDE_M2M_CLIENT_ID and KINDE_M2M_CLIENT_SECRET must be set in .env.local");
  process.exit(1);
}
const customer = "customer_01a1847472402c38e3b648e44434997c";

const tokenRes = await fetch(`${domain}/oauth2/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, audience: `${domain}/api` }),
});
if (!tokenRes.ok) {
  console.log(`token failed: ${tokenRes.status}`);
  process.exit(1);
}
const { access_token } = (await tokenRes.json()) as { access_token: string };

async function lookup() {
  const url = new URL(`${domain}/api/v1/billing/entitlements`);
  url.searchParams.set("customer_id", customer);
  url.searchParams.set("page_size", "100");
  const t0 = performance.now();
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${access_token}` } });
    const body = await res.text();
    const headers = [...res.headers.entries()].filter(([k]) => /rate|limit|retry|concurren/i.test(k)).map(([k, v]) => `${k}: ${v}`);
    return { status: String(res.status), ms: performance.now() - t0, body: res.ok ? "" : body.slice(0, 200), headers };
  } catch (error) {
    return { status: `error: ${error instanceof Error ? error.message : error}`, ms: performance.now() - t0, body: "", headers: [] as string[] };
  }
}

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
await lookup(); // one call to open the connection, not counted

for (const concurrency of [1, 4, 8, 16]) {
  const total = 16;
  const results: Awaited<ReturnType<typeof lookup>>[] = [];
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) {
        next++;
        results.push(await lookup());
      }
    }),
  );
  const seconds = (performance.now() - t0) / 1000;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const statuses = results.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  console.log(`${String(concurrency).padStart(2)} at a time: ${total} calls in ${seconds.toFixed(2)} s, median ${pct(ms, 50).toFixed(0)} ms, 95th ${pct(ms, 95).toFixed(0)} ms, max ${ms[ms.length - 1]!.toFixed(0)} ms, statuses ${JSON.stringify(statuses)}`);
  const bad = results.find((r) => r.status !== "200");
  if (bad) console.log(`   first failure: ${bad.status} ${bad.body} ${bad.headers.join(" | ")}`);
  await Bun.sleep(1500);
}
