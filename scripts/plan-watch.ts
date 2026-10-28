/**
 * Watches Kinde's entitlements for one customer and prints a timestamped line each time the answer changes.
 * Run it, change that customer's plan in Kinde, and compare the time with the webhook line Stub prints.
 * Usage: bun scripts/plan-watch.ts [customer_id]
 */
const domain = (process.env.KINDE_DOMAIN ?? "").replace(/\/$/, "");
const clientId = process.env.KINDE_M2M_CLIENT_ID ?? "";
const clientSecret = process.env.KINDE_M2M_CLIENT_SECRET ?? "";
if (!domain || !clientId || !clientSecret) {
  console.error("KINDE_DOMAIN, KINDE_M2M_CLIENT_ID and KINDE_M2M_CLIENT_SECRET must be set in .env.local");
  process.exit(1);
}
const customer = process.argv[2] ?? "customer_01a1847400791d709d062c5949873e2b"; // Acme

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

async function features(): Promise<string> {
  const url = new URL(`${domain}/api/v1/billing/entitlements`);
  url.searchParams.set("customer_id", customer);
  url.searchParams.set("page_size", "100");
  const res = await fetch(url, { headers: { authorization: `Bearer ${access_token}` } });
  if (!res.ok) return `error ${res.status}`;
  const body = (await res.json()) as { entitlements?: { feature_code?: string }[] };
  return (body.entitlements ?? []).map((e) => e.feature_code).sort().join(", ") || "(none)";
}

let last = "";
const started = Date.now();
console.log(`Watching ${customer}. Change its plan in Kinde now. Stops after 3 minutes, or press Ctrl+C.`);
while (Date.now() - started < 180_000) {
  const now = await features();
  if (now !== last) {
    console.log(`${new Date().toISOString()}  entitlements: ${now}`);
    last = now;
  }
  await Bun.sleep(250);
}
