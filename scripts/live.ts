import { entitlementsFromKinde } from "../src/core";

const domain = (process.env.KINDE_DOMAIN ?? "").replace(/\/$/, "");
const clientId = process.env.KINDE_M2M_CLIENT_ID ?? "";
const clientSecret = process.env.KINDE_M2M_CLIENT_SECRET ?? "";
if (!domain || !clientId || !clientSecret) {
  console.error("KINDE_DOMAIN, KINDE_M2M_CLIENT_ID and KINDE_M2M_CLIENT_SECRET must be set in .env.local");
  process.exit(1);
}

const customers = [
  { name: "Acme", plan: "stub_free", org: "org_8c272f3458bd", customer: "customer_01a1847400791d709d062c5949873e2b" },
  { name: "Globex", plan: "stub_pro", org: "org_8033a1353b09", customer: "customer_01a1847440288e18ca1d6712f9c2c542" },
  { name: "Initech", plan: "stub_business", org: "org_cb29ff36f67c", customer: "customer_01a1847472402c38e3b648e44434997c" },
];

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const limitHeaders = (res: Response) =>
  [...res.headers.entries()].filter(([k]) => /rate|limit|retry|concurren/i.test(k)).map(([k, v]) => `${k}: ${v}`);

async function getToken() {
  const t0 = performance.now();
  const res = await fetch(`${domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience: `${domain}/api`,
    }),
  });
  const took = ms(t0);
  if (!res.ok) {
    console.log(`TOKEN  status ${res.status} in ${took} ms`);
    console.log((await res.text()).slice(0, 400));
    process.exit(1);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  const payload = JSON.parse(Buffer.from(body.access_token.split(".")[1], "base64url").toString());
  console.log(`TOKEN  status ${res.status} in ${took} ms, expires_in ${body.expires_in}s`);
  console.log(`       aud ${JSON.stringify(payload.aud)}, scopes ${JSON.stringify(payload.scp ?? payload.scope ?? null)}`);
  return body.access_token;
}

async function entitlements(token: string, id: string) {
  const url = new URL(`${domain}/api/v1/billing/entitlements`);
  url.searchParams.set("customer_id", id);
  url.searchParams.set("page_size", "100");
  const t0 = performance.now();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const took = ms(t0);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, took, text, json };
}

const token = await getToken();
console.log("");

let working: string | null = null;
for (const c of customers) {
  for (const [kind, id] of [["customer ID", c.customer], ["org code", c.org]] as const) {
    const r = await entitlements(token, id);
    console.log(`${c.name} (${c.plan}) by ${kind}: status ${r.res.status} in ${r.took} ms`);
    if (r.res.ok) {
      console.log(`  parsed by Stub: ${JSON.stringify(entitlementsFromKinde(r.json))}`);
      console.log(`  raw: ${r.text.slice(0, 700)}`);
      if (kind === "customer ID" && !working) working = id;
    } else {
      console.log(`  body: ${r.text.slice(0, 300)}`);
    }
    const hs = limitHeaders(r.res);
    if (hs.length) console.log(`  headers: ${hs.join(" | ")}`);
  }
}

console.log("");
if (!working) {
  console.log("No customer ID returned entitlements, so the latency run is skipped.");
  process.exit(0);
}

const times: number[] = [];
let failures = 0;
for (let i = 0; i < 30; i++) {
  const r = await entitlements(token, working);
  if (r.res.ok) times.push(r.took);
  else failures++;
}
times.sort((a, b) => a - b);
console.log(`LATENCY  30 sequential lookups, ${failures} failed`);
if (times.length) {
  console.log(`         min ${times[0]} ms, median ${pct(times, 0.5)} ms, 95th ${pct(times, 0.95)} ms, max ${times[times.length - 1]} ms`);
}
