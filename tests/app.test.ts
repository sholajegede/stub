import { expect, test } from "bun:test";
import { setup } from "./helpers";

test("a request with no token is refused with 401", async () => {
  const { call } = await setup();
  expect((await call("/v1/reports")).status).toBe(401);
});

test("a token signed by another key is refused with 401", async () => {
  const a = await setup();
  const b = await setup();
  expect((await a.call("/v1/reports", await b.sign({ org_code: "org_1" }))).status).toBe(401);
});

test("an expired token is refused with 401", async () => {
  const { call, sign } = await setup();
  const old = await sign({ org_code: "org_1" }, Math.floor(Date.now() / 1000) - 60);
  expect((await call("/v1/reports", old)).status).toBe(401);
});

test("a plan with the feature passes and a plan without it gets 403", async () => {
  const { call, sign, provider } = await setup();
  provider.setPlan("org:a", { reports: 5 });
  const token = await sign({ org_code: "a" });
  expect((await call("/v1/reports", token)).status).toBe(200);
  const denied = await call("/v1/exports", token);
  expect(denied.status).toBe(403);
});

test("the response says where the answer came from", async () => {
  const { call, sign } = await setup();
  const token = await sign({ org_code: "a" });
  expect((await call("/v1/reports", token)).headers.get("stub-source")).toBe("fetched");
  expect((await call("/v1/reports", token)).headers.get("stub-source")).toBe("fresh");
});

test("when the provider is down and nothing is cached, a cheap route passes and a sensitive route returns 503", async () => {
  const { call, sign, provider } = await setup();
  provider.down = true;
  const token = await sign({ org_code: "new" });
  expect((await call("/v1/reports", token)).status).toBe(200);
  expect((await call("/v1/exports", token)).status).toBe(503);
});

test("one organization's plan is never applied to another", async () => {
  const { call, sign, provider } = await setup();
  provider.setPlan("org:a", { exports: 1 });
  provider.setPlan("org:b", { reports: 1 });
  expect((await call("/v1/exports", await sign({ org_code: "a" }))).status).toBe(200);
  expect((await call("/v1/exports", await sign({ org_code: "b" }))).status).toBe(403);
});

test("a signed plan-change event purges the customer, and an unsigned one does not", async () => {
  const { call, sign, provider } = await setup();
  const token = await sign({ org_code: "a" });
  provider.setPlan("org:a", { reports: 1 });
  expect((await call("/v1/exports", token)).status).toBe(403);
  provider.setPlan("org:a", { reports: 1, exports: 1 });
  expect((await call("/v1/exports", token)).status).toBe(403); // still cached
  const bad = await call("/webhooks/kinde", undefined, { method: "POST", body: "not-a-token" });
  expect(bad.status).toBe(401);
  expect((await call("/v1/exports", token)).status).toBe(403);
  const event = await sign({ type: "customer.plan_changed", data: { org_code: "a" } });
  const ok = await call("/webhooks/kinde", undefined, { method: "POST", body: event });
  expect(ok.status).toBe(200);
  expect((await call("/v1/exports", token)).status).toBe(200);
});
