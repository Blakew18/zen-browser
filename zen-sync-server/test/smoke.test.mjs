/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
} from 'jose';

import { createServer } from '../src/server.js';
import { createVerifier } from '../src/auth.js';

const ISSUER = 'https://auth.example.test/application/o/zen-sync/';
const AUDIENCE = 'zen-sync-client';

let server;
let baseUrl;
let dataDir;
let signToken;

before(async () => {
  // Stand up a throwaway signing key and an in-memory JWKS, mimicking Authentik
  // without needing a real provider.
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [publicJwk] });

  signToken = (claims = {}, overrides = {}) =>
    new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(overrides.issuer ?? ISSUER)
      .setAudience(overrides.audience ?? AUDIENCE)
      .setSubject(overrides.sub ?? 'user-123')
      .setIssuedAt()
      .setExpirationTime(overrides.exp ?? '5m')
      .sign(privateKey);

  dataDir = await mkdtemp(join(tmpdir(), 'zen-sync-'));
  const config = {
    maxBlobBytes: 1_000_000,
    dataDir,
    encryptionKey: Buffer.from('0'.repeat(32)).toString('base64'),
  };
  const verify = await createVerifier(
    { issuer: ISSUER, audience: [AUDIENCE] },
    jwks
  );
  server = await createServer(config, { verify });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

test('healthz is open', async () => {
  const res = await fetch(`${baseUrl}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('rejects requests without a token', async () => {
  const res = await fetch(`${baseUrl}/v1/collections/settings`);
  assert.equal(res.status, 401);
});

test('rejects a forged / wrong-issuer token', async () => {
  const token = await signToken({}, { issuer: 'https://evil.example/' });
  const res = await fetch(`${baseUrl}/v1/collections/settings`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 401);
});

test('empty collection returns 404 with version 0', async () => {
  const token = await signToken();
  const res = await fetch(`${baseUrl}/v1/collections/settings`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).version, 0);
});

test('round-trips a settings blob and bumps the version', async () => {
  const token = await signToken();
  const auth = { authorization: `Bearer ${token}` };

  const put = await fetch(`${baseUrl}/v1/collections/settings`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      baseVersion: 0,
      data: { 'zen.theme.accent-color': '#aa00ff' },
    }),
  });
  assert.equal(put.status, 200);
  const stored = await put.json();
  assert.equal(stored.version, 1);
  assert.equal(stored.data['zen.theme.accent-color'], '#aa00ff');

  const get = await fetch(`${baseUrl}/v1/collections/settings`, {
    headers: auth,
  });
  assert.equal(get.status, 200);
  assert.equal((await get.json()).version, 1);
});

test('rejects a stale write with 409 and returns current', async () => {
  const token = await signToken({}, { sub: 'user-conflict' });
  const auth = { authorization: `Bearer ${token}` };
  const url = `${baseUrl}/v1/collections/settings`;

  await fetch(url, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ baseVersion: 0, data: { a: 1 } }),
  });

  const conflict = await fetch(url, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ baseVersion: 0, data: { a: 2 } }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).current.version, 1);
});

test('users are isolated from each other', async () => {
  const alice = { authorization: `Bearer ${await signToken({}, { sub: 'alice' })}` };
  const bob = { authorization: `Bearer ${await signToken({}, { sub: 'bob' })}` };
  const url = `${baseUrl}/v1/collections/settings`;

  await fetch(url, {
    method: 'PUT',
    headers: { ...alice, 'content-type': 'application/json' },
    body: JSON.stringify({ baseVersion: 0, data: { who: 'alice' } }),
  });

  const bobGet = await fetch(url, { headers: bob });
  assert.equal(bobGet.status, 404, 'bob should not see alice data');
});
