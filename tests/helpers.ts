import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import { createApp, addWebhook } from "../src/app";
import { localKeys, makeVerifier } from "../src/auth";
import { EntitlementCache, type CacheOptions } from "../src/cache";
import { StandInProvider } from "../src/providers";

export const ISSUER = "https://test.kinde.com";

export async function setup(options: CacheOptions = {}, delayMs = 0) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const jwks: JSONWebKeySet = { keys: [jwk] };
  const verify = makeVerifier(localKeys(jwks), ISSUER);
  const provider = new StandInProvider(delayMs);
  const cache = new EntitlementCache(provider, options);
  const app = createApp({ verify, cache });
  addWebhook(app, cache, verify, (e) => {
    const data = e.data as { org_code?: string } | undefined;
    return data?.org_code ? `org:${data.org_code}` : null;
  });
  const sign = (claims: Record<string, unknown>, expires: string | number = "1h") =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setIssuedAt().setExpirationTime(expires).sign(privateKey);
  const call = async (path: string, token?: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers as object) } });
  return { app, cache, provider, sign, call };
}
