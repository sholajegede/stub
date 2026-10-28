import { Hono } from "hono";
import type { EntitlementCache } from "./cache";
import { customerKey, decide, RouteClass } from "./core";

export interface Route {
  path: string;
  /** The feature the plan must grant. Null means any signed-in caller. */
  feature: string | null;
  routeClass: RouteClass;
}

/** Each route declares what it needs and what a wrong answer would cost. */
export const ROUTES: Route[] = [
  { path: "/v1/reports", feature: "reports", routeClass: "cheap" },
  { path: "/v1/exports", feature: "exports", routeClass: "sensitive" },
  { path: "/v1/agents/run", feature: "agent_runs", routeClass: "sensitive" },
];

export interface AppOptions {
  /** Checks the signature and claims of a token. Returns the claims or throws. */
  verify: (token: string) => Promise<Record<string, unknown>>;
  cache: EntitlementCache;
  /** When false, the gate skips the entitlement check. Used only to measure the cost of the check. */
  check?: boolean;
}

export function createApp({ verify, cache, check = true }: AppOptions): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  for (const route of ROUTES) {
    app.all(route.path, async (c) => {
      const header = c.req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!token) return c.json({ error: "Send a bearer token." }, 401);

      let claims: Record<string, unknown>;
      try {
        claims = await verify(token);
      } catch {
        return c.json({ error: "The token is not valid." }, 401);
      }

      if (check) {
        const key = customerKey(claims);
        if (key === null) return c.json({ error: "The token names no customer." }, 401);
        const { entitlements, source } = await cache.get(key);
        c.header("stub-source", source);
        const decision = decide(entitlements, route.feature, route.routeClass);
        if (!decision.allow) return c.json({ error: decision.reason }, decision.status);
      }
      return c.json({ ok: true, route: route.path });
    });
  }

  return app;
}

/**
 * The webhook route. Kinde sends the event as a signed token.
 * Any billing event purges the customer named in it. If the event names no customer, everything is purged,
 * because a missed purge is worse than an extra lookup.
 */
export function addWebhook(
  app: Hono,
  cache: EntitlementCache,
  verify: (token: string) => Promise<Record<string, unknown>>,
  customerOf: (event: Record<string, unknown>) => string | null,
  log: (line: string) => void = () => {},
): void {
  app.post("/webhooks/kinde", async (c) => {
    let event: Record<string, unknown>;
    try {
      event = await verify((await c.req.text()).trim());
    } catch (error) {
      log(`webhook rejected at ${new Date().toISOString()}: ${error instanceof Error ? error.message : error}`);
      return c.json({ error: "The event is not signed by Kinde." }, 401);
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (!type.startsWith("customer.")) return c.json({ purged: 0, ignored: true });
    const key = customerOf(event);
    if (key) cache.purge(key);
    else cache.purgeAll();
    log(`webhook at ${new Date().toISOString()} purged ${key ?? "all"}: ${JSON.stringify(event).slice(0, 900)}`);
    return c.json({ purged: key ?? "all" });
  });
}
