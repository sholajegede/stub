import { expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { localKeys, makeVerifier } from "../src/auth";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = localKeys({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" }] });
  const sign = (claims: Record<string, unknown>, issuer?: string) => {
    const jwt = new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuedAt().setExpirationTime("1h");
    return (issuer ? jwt.setIssuer(issuer) : jwt).sign(privateKey);
  };
  return { keys, sign };
}

test("a token with no issuer is refused when an issuer is required", async () => {
  const { keys, sign } = await setup();
  await expect(makeVerifier(keys, "https://a.kinde.com")(await sign({ type: "customer.plan_changed" }))).rejects.toThrow();
});

test("a signed token with no issuer passes when no issuer is required", async () => {
  const { keys, sign } = await setup();
  const claims = await makeVerifier(keys)(await sign({ type: "customer.plan_changed" }));
  expect(claims.type).toBe("customer.plan_changed");
});

test("a token signed by another key is refused even when no issuer is required", async () => {
  const mine = await setup();
  const other = await setup();
  await expect(makeVerifier(mine.keys)(await other.sign({ type: "customer.plan_changed" }))).rejects.toThrow();
});
