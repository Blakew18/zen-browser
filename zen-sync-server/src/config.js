/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Central place to read configuration. Everything comes from the environment
// so the service can be dropped into Docker / systemd without code changes.

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  // Authentik (or any OIDC provider) discovery. The issuer is the value of the
  // `iss` claim in the access tokens, e.g.
  //   https://auth.example.com/application/o/zen-sync/
  const issuer = env.OIDC_ISSUER ?? required('OIDC_ISSUER');

  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',

    oidc: {
      issuer,
      // Optional explicit JWKS URI. If omitted we discover it from
      // `${issuer}.well-known/openid-configuration` at startup.
      jwksUri: env.OIDC_JWKS_URI || null,
      // The token audience to require. For Authentik this is usually the
      // application's Client ID. Comma-separated for multiple accepted values.
      audience: (env.OIDC_AUDIENCE || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },

    // Where per-user blobs live on disk.
    dataDir: env.DATA_DIR ?? './data',

    // Optional at-rest encryption. Provide a base64-encoded 32-byte key to have
    // the server encrypt every stored blob with AES-256-GCM. If unset, blobs are
    // stored as plaintext JSON (still fine behind TLS on trusted infra).
    encryptionKey: env.ENCRYPTION_KEY || null,

    // Reject blobs larger than this many bytes (defends against accidents).
    maxBlobBytes: Number(env.MAX_BLOB_BYTES ?? 1_000_000),
  };
}
