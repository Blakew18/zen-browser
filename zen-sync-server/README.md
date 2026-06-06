<!--
   - This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

# zen-sync-server

A minimal, self-hosted backend for syncing **Zen Browser settings** between
devices, authenticated by your own OIDC provider (designed and tested against
[Authentik](https://goauthentik.io/)).

This is **Phase 1**: it syncs a curated allow-list of `zen.*` preferences. The
storage/auth/transport is collection-based, so open tabs (Phase 2) and history
(Phase 3) can be added later without changing the protocol.

> **Status: prototype.** The server is fully working and tested. The browser
> client (`src/zen/sync/ZenSync.sys.mjs` in the main repo) is wired into the
> build but not yet exposed in the Settings UI — it's driven by `zen.sync.*`
> prefs for now.

## How it works

```
  Zen Browser (ZenSync.sys.mjs)                 Your infra
  ┌──────────────────────────┐
  │ 1. PKCE login ───────────┼────────────────▶  Authentik  (OIDC)
  │    (loopback redirect)    │ ◀── access+refresh token ──┘
  │                          │
  │ 2. GET/PUT settings ─────┼──── Bearer token ───▶  zen-sync-server
  └──────────────────────────┘                         │ validates token
                                                        │ against Authentik JWKS
                                                        ▼
                                                  per-user blob on disk
                                                  (optionally AES-256-GCM)
```

- **Identity is entirely Authentik.** The server never has its own accounts; it
  trusts access tokens signed by your provider and keys data by the token's
  `sub`. Your Authentik users *are* your sync users.
- **No passwords are synced** (use 1Password etc.). Settings are lower
  sensitivity, so by default the server stores blobs behind TLS without a user
  passphrase. Set `ENCRYPTION_KEY` to additionally encrypt at rest.
- **Optimistic concurrency.** Each write carries the version it was based on; a
  stale write gets `409` and the client re-syncs on the next cycle.

## API

| Method | Path                        | Auth   | Notes                                   |
| ------ | --------------------------- | ------ | --------------------------------------- |
| GET    | `/healthz`                  | none   | Liveness probe                          |
| GET    | `/v1/collections/:name`     | Bearer | Returns `{version,updatedAt,data}` or 404 |
| PUT    | `/v1/collections/:name`     | Bearer | Body `{baseVersion, data}` → 200 / 409  |

Phase 1 uses the `settings` collection. The name must match `[a-z0-9_-]{1,64}`.

## Configure Authentik

1. **Create an OAuth2/OpenID Provider**
   - Authorization flow: your usual `default-authentication-flow`.
   - Client type: **Public** (the browser is a public client using PKCE; no
     client secret).
   - Redirect URIs: `http://127.0.0.1:8788/`
     (must match `zen.sync.oidc.redirect-port` in the browser).
   - Scopes: `openid`, `profile`, `email`, `offline_access` (offline_access is
     what gets you a refresh token for silent background syncs).
2. **Create an Application** bound to that provider. Note its **Client ID** and
   the provider's **OpenID Configuration Issuer** (Providers → your provider).
3. That Issuer is your `OIDC_ISSUER`; the Client ID is both the browser's
   `zen.sync.oidc.client-id` and the server's `OIDC_AUDIENCE`.

## Run the server

```bash
cp .env.example .env        # fill in OIDC_ISSUER + OIDC_AUDIENCE
# optionally: ENCRYPTION_KEY=$(openssl rand -base64 32)

npm install
node --env-file=.env src/index.js
# or: docker compose -f docker-compose.example.yml up --build
```

Put TLS in front of it (a reverse proxy, or Authentik's own outpost). The
service speaks plain HTTP and expects to be terminated upstream.

```bash
npm test        # runs the offline test suite (mints its own tokens)
```

## Point Zen at it

In `about:config` on each device (or ship these as defaults), set:

| Pref                          | Value                                                   |
| ----------------------------- | ------------------------------------------------------- |
| `zen.sync.enabled`            | `true`                                                  |
| `zen.sync.server-url`         | `https://sync.example.com`                              |
| `zen.sync.oidc.issuer`        | `https://auth.example.com/application/o/zen-sync/`      |
| `zen.sync.oidc.client-id`     | *(Authentik application Client ID)*                     |
| `zen.sync.oidc.redirect-port` | `8788` (must match the Authentik redirect URI)          |

The first sync triggers an Authentik login in a tab; after that, refresh tokens
keep it silent. `zen.sync.log = true` prints `[ZenSync]` diagnostics to the
Browser Console.

### Which settings sync

A curated default list (accent color, compact mode, sidebar layout, vertical
tabs, etc. — see `DEFAULT_SYNCED_PREFS` in `ZenSync.sys.mjs`). Add more with
`zen.sync.extra-prefs` (comma-separated). The client only ever reads/writes
prefs on this allow-list, so the server can never flip arbitrary settings.

## Roadmap

- **Phase 2 — open tabs:** push each device's tab list as a `tabs` collection,
  surfaced as a read-only "tabs from your other devices" view.
- **Phase 3 — history:** opt-in `history` collection with dedupe + retention.
- **UI:** a panel in Settings to sign in / pick what to sync, replacing the
  `about:config` setup above.
- **Optional zero-knowledge mode:** client-side passphrase encryption for users
  who don't want the server to see plaintext.
