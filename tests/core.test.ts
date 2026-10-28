import { expect, test } from "bun:test";
import { ageOf, customerKey, decide, entitlementsFromKinde, FRESH_MS, STALE_OK_MS } from "../src/core";

test("an answer is fresh, then stale, then expired", () => {
  const e = { value: { a: 1 }, fetchedAt: 1000 };
  expect(ageOf(e, 1000 + FRESH_MS - 1)).toBe("fresh");
  expect(ageOf(e, 1000 + FRESH_MS)).toBe("stale");
  expect(ageOf(e, 1000 + STALE_OK_MS)).toBe("expired");
});

test("a granted feature is allowed and a missing one is refused with 403", () => {
  expect(decide({ reports: 5 }, "reports", "cheap")).toEqual({ allow: true, reason: "granted" });
  const d = decide({ reports: 5 }, "exports", "sensitive");
  expect(d.allow).toBe(false);
  if (!d.allow) expect(d.status).toBe(403);
});

test("a null maximum still grants the feature", () => {
  expect(decide({ exports: null }, "exports", "sensitive").allow).toBe(true);
});

test("an unknown plan lets a cheap route through and closes a sensitive route", () => {
  expect(decide(null, "reports", "cheap")).toEqual({ allow: true, reason: "unknown-allowed" });
  const d = decide(null, "exports", "sensitive");
  expect(d.allow).toBe(false);
  if (!d.allow) expect(d.status).toBe(503);
});

test("a route with no feature needs only a valid token", () => {
  expect(decide(null, null, "sensitive").allow).toBe(true);
});

test("Kinde's answer is read into feature codes, and the larger maximum wins", () => {
  const got = entitlementsFromKinde({
    entitlements: [
      { feature_code: "reports", entitlement_limit_max: 10 },
      { feature_code: "reports", entitlement_limit_max: 50 },
      { feature_code: "exports", entitlement_limit_max: null },
      { feature_code: "agent_runs", entitlement_limit_max: 3 },
      { feature_code: "agent_runs", entitlement_limit_max: null },
      { nope: true },
    ],
  });
  expect(got).toEqual({ reports: 50, exports: null, agent_runs: null });
  expect(entitlementsFromKinde(null)).toEqual({});
});

test("the cache key uses the organization first and the user second", () => {
  expect(customerKey({ org_code: "org_1", sub: "u" })).toBe("org:org_1");
  expect(customerKey({ sub: "u" })).toBe("user:u");
  expect(customerKey({})).toBeNull();
});
