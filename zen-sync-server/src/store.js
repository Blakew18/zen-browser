/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// A deliberately tiny persistence layer: one JSON document per
// (user, collection) pair, stored under DATA_DIR. This is plenty for a small
// self-hosted deployment and has zero native dependencies. Swap for SQLite/
// Postgres later without touching the HTTP layer.

const COLLECTION_RE = /^[a-z0-9_-]{1,64}$/;

function safeName(value) {
  // Never trust `sub` (or a collection name) as a path component.
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export class Store {
  #dataDir;
  #key;

  constructor({ dataDir, encryptionKey }) {
    this.#dataDir = dataDir;
    this.#key = encryptionKey ? Buffer.from(encryptionKey, 'base64') : null;
    if (this.#key && this.#key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be base64 for exactly 32 bytes');
    }
  }

  static isValidCollection(name) {
    return COLLECTION_RE.test(name);
  }

  #pathFor(sub, collection) {
    return join(this.#dataDir, safeName(sub), `${safeName(collection)}.json`);
  }

  #encode(record) {
    const plaintext = Buffer.from(JSON.stringify(record), 'utf8');
    if (!this.#key) {
      return plaintext;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Envelope: {v:1, iv, tag, ct} so we can tell encrypted from plaintext.
    return Buffer.from(
      JSON.stringify({
        v: 1,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ct: enc.toString('base64'),
      }),
      'utf8'
    );
  }

  #decode(buf) {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed && parsed.v === 1 && parsed.ct) {
      if (!this.#key) {
        throw new Error('Stored blob is encrypted but no ENCRYPTION_KEY is set');
      }
      const iv = Buffer.from(parsed.iv, 'base64');
      const tag = Buffer.from(parsed.tag, 'base64');
      const ct = Buffer.from(parsed.ct, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
      return JSON.parse(dec.toString('utf8'));
    }
    return parsed;
  }

  /** Returns the stored record, or null if the user has nothing yet. */
  async get(sub, collection) {
    const path = this.#pathFor(sub, collection);
    if (!existsSync(path)) {
      return null;
    }
    return this.#decode(await readFile(path));
  }

  /**
   * Optimistic-concurrency write. `baseVersion` must match the currently stored
   * version (or be 0 for a first write). On conflict returns
   * { ok: false, current }. On success returns { ok: true, record }.
   */
  async put(sub, collection, { baseVersion, data, updatedBy }) {
    const path = this.#pathFor(sub, collection);
    const current = await this.get(sub, collection);
    const currentVersion = current ? current.version : 0;

    if (Number(baseVersion) !== currentVersion) {
      return { ok: false, current };
    }

    const record = {
      version: currentVersion + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: updatedBy ?? null,
      data,
    };

    await mkdir(join(this.#dataDir, safeName(sub)), { recursive: true });
    // Write-then-rename for atomicity.
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, this.#encode(record));
    await rename(tmp, path);
    return { ok: true, record };
  }
}
