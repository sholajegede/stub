/**
 * The rules of Stub that need no network. Every function here is pure,
 * so the same input gives the same answer and a test can check each rule alone.
 */

/** An entitlement answer is used with no refresh for this long. */
export const FRESH_MS = 30_000;
/** An older answer may still be served, with a refresh running behind it, for this long. */
export const STALE_OK_MS = 5 * 60_000;
/** After this many failed lookups in a row, the gate stops asking the provider for a short time. */
export const BREAKER_FAILS = 3;
/** How long the gate stays away from the provider after the failures above. Then one lookup tests it again. */
export const BREAKER_OPEN_MS = 2_000;

/** What a customer's plan grants: a feature code mapped to its maximum, or null for no maximum. */
export type Entitlements = Record<string, number | null>;

export interface Entry {
  value: Entitlements;
  fetchedAt: number;
}

export type Age = "fresh" | "stale" | "expired";

export function ageOf(entry: Entry, now: number, freshMs = FRESH_MS, staleOkMs = STALE_OK_MS): Age {
  const age = now - entry.fetchedAt;
  if (age < freshMs) return "fresh";
  if (age < staleOkMs) return "stale";
  return "expired";
}

/** How much a wrong answer costs. A route declares this once. */
export type RouteClass = "cheap" | "sensitive";

export type Decision =
  | { allow: true; reason: "granted" | "unknown-allowed" }
  | { allow: false; status: 403 | 503; reason: string };

/**
 * The access decision.
 * With a known answer, the feature is either granted or not.
 * With no usable answer, a cheap route lets the request through and a sensitive route refuses it.
 */
export function decide(entitlements: Entitlements | null, feature: string | null, routeClass: RouteClass): Decision {
  if (feature === null) return { allow: true, reason: "granted" };
  if (entitlements === null) {
    if (routeClass === "cheap") return { allow: true, reason: "unknown-allowed" };
    return { allow: false, status: 503, reason: "The plan could not be checked right now, so this route is closed until it can." };
  }
  if (feature in entitlements) return { allow: true, reason: "granted" };
  return { allow: false, status: 403, reason: `The plan does not include "${feature}".` };
}

/** Read feature codes and maximums from the answer of Kinde's billing entitlements endpoint. */
export function entitlementsFromKinde(body: unknown): Entitlements {
  const out: Entitlements = {};
  const list = (body as { entitlements?: unknown } | null)?.entitlements;
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.feature_code !== "string") continue;
    const raw = e.entitlement_limit_max;
    const max = typeof raw === "number" ? raw : null;
    const previous = out[e.feature_code];
    // The same feature can come from more than one plan. Keep the larger maximum, and null (no maximum) wins.
    out[e.feature_code] = previous === undefined ? max : previous === null || max === null ? null : Math.max(previous, max);
  }
  return out;
}

/** Kinde has no billing customer for this key, so no lookup is made. This is not a provider failure. */
export class UnknownCustomerError extends Error {}

/** The cache key. One organization's answer is never served to another. */
export function customerKey(claims: { org_code?: unknown; sub?: unknown }): string | null {
  if (typeof claims.org_code === "string" && claims.org_code !== "") return `org:${claims.org_code}`;
  if (typeof claims.sub === "string" && claims.sub !== "") return `user:${claims.sub}`;
  return null;
}
