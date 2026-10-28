import { expect, test } from "bun:test";
import { EntitlementCache } from "../src/cache";
import { UnknownCustomerError } from "../src/core";
import { StandInProvider } from "../src/providers";

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

test("the second request is served from the cache", async () => {
  const p = new StandInProvider();
  const c = new EntitlementCache(p);
  expect((await c.get("org:a")).source).toBe("fetched");
  expect((await c.get("org:a")).source).toBe("fresh");
  expect(p.calls).toBe(1);
});

test("simultaneous requests for one customer make one provider call", async () => {
  const p = new StandInProvider(20);
  const c = new EntitlementCache(p);
  const all = await Promise.all(Array.from({ length: 50 }, () => c.get("org:a")));
  expect(all.every((r) => r.entitlements !== null)).toBe(true);
  expect(p.calls).toBe(1);
  expect(c.stats.merged).toBe(49);
});

test("with merging off, each simultaneous request calls the provider", async () => {
  const p = new StandInProvider(5);
  const c = new EntitlementCache(p, { merge: false });
  await Promise.all(Array.from({ length: 10 }, () => c.get("org:a")));
  expect(p.calls).toBe(10);
});

test("a stale answer is served at once and refreshed behind it", async () => {
  const k = clock();
  const p = new StandInProvider();
  const c = new EntitlementCache(p, { now: k.now });
  await c.get("org:a");
  p.setPlan("org:a", { exports: 1 });
  k.advance(31_000);
  const r = await c.get("org:a");
  expect(r.source).toBe("stale");
  expect(r.entitlements).toEqual({ reports: 100 });
  await Bun.sleep(5);
  expect((await c.get("org:a")).entitlements).toEqual({ exports: 1 });
});

test("a stale answer keeps working while the provider is down", async () => {
  const k = clock();
  const p = new StandInProvider();
  const c = new EntitlementCache(p, { now: k.now });
  await c.get("org:a");
  p.down = true;
  k.advance(60_000);
  const r = await c.get("org:a");
  expect(r.source).toBe("stale");
  expect(r.entitlements).not.toBeNull();
});

test("an answer older than the stale limit is not used, and the result is unknown", async () => {
  const k = clock();
  const p = new StandInProvider();
  const c = new EntitlementCache(p, { now: k.now });
  await c.get("org:a");
  p.down = true;
  k.advance(301_000);
  const r = await c.get("org:a");
  expect(r.source).toBe("unknown");
  expect(r.entitlements).toBeNull();
});

test("after three failures in a row the provider is left alone for two seconds, then tested again", async () => {
  const k = clock();
  const p = new StandInProvider();
  p.down = true;
  const c = new EntitlementCache(p, { now: k.now });
  for (let i = 0; i < 6; i++) await c.get(`org:${i}`);
  expect(p.calls).toBe(3);
  k.advance(2_001);
  p.down = false;
  expect((await c.get("org:x")).source).toBe("fetched");
  expect(p.calls).toBe(4);
});

test("purge makes the next request ask the provider", async () => {
  const p = new StandInProvider();
  const c = new EntitlementCache(p);
  await c.get("org:a");
  p.setPlan("org:a", { exports: 1 });
  c.purge("org:a");
  expect((await c.get("org:a")).entitlements).toEqual({ exports: 1 });
});

test("two customers never share an answer", async () => {
  const p = new StandInProvider();
  p.setPlan("org:a", { exports: 1 });
  p.setPlan("org:b", { reports: 1 });
  const c = new EntitlementCache(p);
  expect((await c.get("org:a")).entitlements).toEqual({ exports: 1 });
  expect((await c.get("org:b")).entitlements).toEqual({ reports: 1 });
});

test("a provider call that takes too long counts as a failure", async () => {
  const p = new StandInProvider(200);
  const c = new EntitlementCache(p, { timeoutMs: 20 });
  const started = performance.now();
  const r = await c.get("org:a");
  expect(r.source).toBe("unknown");
  expect(performance.now() - started).toBeLessThan(150);
  expect(c.stats.providerErrors).toBe(1);
});

test("a customer with no billing mapping is unknown and does not open the breaker", async () => {
  let calls = 0;
  const provider = {
    async fetchEntitlements(key: string) {
      calls++;
      if (key === "org:unmapped") throw new UnknownCustomerError("no mapping");
      return { reports: 1 };
    },
  };
  const c = new EntitlementCache(provider);
  for (let i = 0; i < 5; i++) expect((await c.get("org:unmapped")).source).toBe("unknown");
  expect(c.stats.providerErrors).toBe(0);
  expect((await c.get("org:known")).source).toBe("fetched");
  expect(calls).toBe(6);
});
