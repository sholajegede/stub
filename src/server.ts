import { addWebhook, createApp } from "./app";
import { localKeys, makeVerifier, remoteKeys } from "./auth";
import { EntitlementCache } from "./cache";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { KindeProvider, StandInProvider } from "./providers";

const env = process.env;
const mode = env.MODE ?? "cache"; // none | always | cache
const useStandIn = (env.PROVIDER ?? "standin") === "standin";
const domain = env.KINDE_DOMAIN ?? "https://example.kinde.com";
const issuer = env.ISSUER ?? domain;

const customersFile = Bun.file(env.CUSTOMERS_FILE ?? "customers.json");
const customers: Record<string, string> = !useStandIn && (await customersFile.exists()) ? await customersFile.json() : {};
const orgOfCustomer = new Map(Object.entries(customers).map(([org, customer]) => [customer, org]));

const provider = useStandIn
  ? new StandInProvider(Number(env.PROVIDER_DELAY_MS ?? 0))
  : new KindeProvider(domain, env.KINDE_M2M_CLIENT_ID ?? "", env.KINDE_M2M_CLIENT_SECRET ?? "", customers);
if (provider instanceof KindeProvider) await provider.warm().catch((error) => console.error(`Kinde token request failed: ${error.message}`));

const cache = new EntitlementCache(provider, {
  freshMs: mode === "always" ? 0 : Number(env.FRESH_MS ?? 30_000),
  staleOkMs: mode === "always" ? 0 : Number(env.STALE_OK_MS ?? 300_000),
  merge: env.MERGE !== undefined ? env.MERGE === "1" : mode !== "always",
  timeoutMs: Number(env.TIMEOUT_MS ?? 1500),
  onError: (key, error) => console.error(`lookup failed for ${key}: ${error instanceof Error ? error.message : error}`),
});

// With the stand-in and no keys given, the server makes its own key pair so the inspector page can sign test tokens.
let signer: ((claims: Record<string, unknown>) => Promise<string>) | null = null;
let jwksJson = env.JWKS_JSON;
if (!jwksJson && useStandIn) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  jwksJson = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: "local", alg: "RS256", use: "sig" }] });
  signer = (claims) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "local" }).setIssuer(issuer).setIssuedAt().setExpirationTime("24h").sign(privateKey);
}
const keys = jwksJson ? localKeys(JSON.parse(jwksJson)) : remoteKeys(domain);
const verify = makeVerifier(keys, issuer, env.AUDIENCE);
const verifyEvent = makeVerifier(keys);

const app = createApp({ verify, cache, check: mode !== "none" });
addWebhook(app, cache, verifyEvent, (event) => {
  const data = event.data as { customer_id?: unknown; org_code?: unknown } | undefined;
  if (typeof data?.org_code === "string") return `org:${data.org_code}`;
  if (typeof data?.customer_id === "string") {
    const org = orgOfCustomer.get(data.customer_id);
    return org ? `org:${org}` : null;
  }
  return null;
}, console.log);

if (provider instanceof StandInProvider) {
  app.post("/_admin/down", (c) => ((provider.down = c.req.query("on") === "1"), c.json({ down: provider.down })));
  app.post("/_admin/plan", async (c) => {
    const { key, plan } = (await c.req.json()) as { key: string; plan: Record<string, number | null> };
    provider.setPlan(key, plan);
    return c.json({ ok: true });
  });
  app.post("/_admin/purge", (c) => (cache.purge(c.req.query("key") ?? ""), c.json({ ok: true })));
  if (signer) {
    const sign = signer;
    const web = (name: string, type: string) => () => new Response(Bun.file(new URL(`./web/${name}`, import.meta.url)), { headers: { "content-type": type } });
    app.get("/", web("index.html", "text/html; charset=utf-8"));
    app.get("/app", web("app.html", "text/html; charset=utf-8"));
    app.get("/style.css", web("style.css", "text/css"));
    app.get("/stub.js", web("stub.js", "text/javascript"));
    app.get("/logo.svg", web("logo.svg", "image/svg+xml"));
    app.get("/fonts/geist.woff2", () => new Response(Bun.file(new URL("../node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2", import.meta.url)), { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=86400" } }));
    app.get("/_admin/token", async (c) => c.json({ token: await sign({ org_code: c.req.query("org") ?? "acme" }) }));
    provider.setPlan("org:acme", { reports: 100 });
    provider.setPlan("org:globex", { reports: 100, exports: 100 });
    provider.setPlan("org:initech", { reports: 100, exports: 100, agent_runs: 100 });
  }
  app.get("/_admin/stats", (c) => c.json({ ...cache.stats, size: cache.size(), calls: provider.calls }));
}

export default { port: Number(env.PORT ?? 3100), fetch: app.fetch };
console.log(`Stub on :${env.PORT ?? 3100} mode=${mode} provider=${useStandIn ? "standin" : "kinde"}`);
