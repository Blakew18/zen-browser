/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createRemoteJWKSet, jwtVerify } from 'jose';

// Discover the JWKS endpoint from the OIDC issuer if one was not provided
// explicitly. Authentik publishes a standard discovery document.
async function discoverJwksUri(issuer) {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
  const url = new URL('.well-known/openid-configuration', base);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `OIDC discovery failed (${res.status}) for ${url.toString()}`
    );
  }
  const doc = await res.json();
  if (!doc.jwks_uri) {
    throw new Error('OIDC discovery document did not contain jwks_uri');
  }
  return doc.jwks_uri;
}

/**
 * Build a token verifier.
 *
 * `jwks` may be injected (used by tests). In production we resolve the JWKS URI
 * from config / discovery and let jose fetch + cache the keys.
 *
 * Returns an async `verify(token)` that resolves to the validated payload, or
 * throws if the token is missing/expired/forged/wrong-audience.
 */
export async function createVerifier({ issuer, audience, jwksUri }, jwks) {
  let keyset = jwks;
  if (!keyset) {
    const uri = jwksUri ?? (await discoverJwksUri(issuer));
    keyset = createRemoteJWKSet(new URL(uri));
  }

  return async function verify(token) {
    const options = { issuer };
    // Only enforce audience if the operator configured one. Some providers put
    // the resource server in `aud`, others leave it as the client id.
    if (audience && audience.length > 0) {
      options.audience = audience;
    }
    const { payload } = await jwtVerify(token, keyset, options);
    if (!payload.sub) {
      throw new Error('Token has no subject (sub) claim');
    }
    return payload;
  };
}

// Pull a bearer token out of an Authorization header.
export function extractBearer(headerValue) {
  if (!headerValue) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match ? match[1] : null;
}
