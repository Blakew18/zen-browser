/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createServer as createHttpServer } from 'node:http';

import { Store } from './store.js';
import { createVerifier, extractBearer } from './auth.js';

// Small helpers ------------------------------------------------------------

function send(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Build the HTTP server. `deps` lets tests inject a verifier / store; in
 * production they are constructed from config.
 */
export async function createServer(config, deps = {}) {
  const store = deps.store ?? new Store(config);
  const verify = deps.verify ?? (await createVerifier(config.oidc));

  async function authenticate(req, res) {
    const token = extractBearer(req.headers['authorization']);
    if (!token) {
      send(res, 401, { error: 'missing_bearer_token' });
      return null;
    }
    try {
      return await verify(token);
    } catch (err) {
      send(res, 401, { error: 'invalid_token', detail: err.message });
      return null;
    }
  }

  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const parts = url.pathname.split('/').filter(Boolean);

      // GET /healthz — unauthenticated liveness probe.
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return send(res, 200, { ok: true });
      }

      // /v1/collections/:name
      if (parts[0] === 'v1' && parts[1] === 'collections' && parts[2]) {
        const collection = parts[2];
        if (!Store.isValidCollection(collection)) {
          return send(res, 400, { error: 'invalid_collection' });
        }

        const claims = await authenticate(req, res);
        if (!claims) {
          return undefined; // response already sent
        }
        const sub = claims.sub;
        const updatedBy = claims.preferred_username || claims.email || sub;

        if (req.method === 'GET') {
          const record = await store.get(sub, collection);
          if (!record) {
            return send(res, 404, { error: 'not_found', version: 0 });
          }
          return send(res, 200, record);
        }

        if (req.method === 'PUT') {
          const body = await readJsonBody(req, config.maxBlobBytes);
          if (typeof body.data === 'undefined') {
            return send(res, 400, { error: 'missing_data' });
          }
          const result = await store.put(sub, collection, {
            baseVersion: body.baseVersion ?? 0,
            data: body.data,
            updatedBy,
          });
          if (!result.ok) {
            return send(res, 409, {
              error: 'version_conflict',
              current: result.current,
            });
          }
          return send(res, 200, result.record);
        }

        return send(res, 405, { error: 'method_not_allowed' });
      }

      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      const status = err.status ?? 500;
      return send(res, status, {
        error: status === 500 ? 'internal_error' : 'bad_request',
        detail: err.message,
      });
    }
  });

  return server;
}
