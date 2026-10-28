import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JSONWebKeySet } from "jose";

/**
 * Local token check: signature (RS256 only), expiry, and the issuer and audience when they are given.
 * Kinde's webhook events carry no issuer claim, so the webhook check passes none.
 * The public keys are fetched once and kept by the library, so a request makes no network call.
 */
export function makeVerifier(keys: JWTVerifyGetKey, issuer?: string, audience?: string) {
  return async (token: string): Promise<Record<string, unknown>> => {
    const { payload } = await jwtVerify(token, keys, { algorithms: ["RS256"], ...(issuer ? { issuer } : {}), ...(audience ? { audience } : {}) });
    return payload as Record<string, unknown>;
  };
}

export const remoteKeys = (domain: string) => createRemoteJWKSet(new URL(`${domain}/.well-known/jwks`));
export const localKeys = (jwks: JSONWebKeySet) => createLocalJWKSet(jwks);
