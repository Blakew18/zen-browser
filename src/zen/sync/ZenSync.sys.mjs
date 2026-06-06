/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ZenSync — Phase 1: self-hosted settings sync.
 *
 * Authenticates the user against an OIDC provider (designed for Authentik)
 * using the Authorization Code + PKCE flow with a fixed loopback redirect, then
 * pushes/pulls a small allow-list of preferences to a self-hosted
 * `zen-sync-server` instance.
 *
 * This is a prototype: the transport, auth and pref plumbing are real, but it
 * has not yet been wired into the preferences UI (that's a follow-up). Enable it
 * via `zen.sync.enabled` and the `zen.sync.*` prefs documented in
 * prefs/zen/sync.yaml.
 */

import { XPCOMUtils } from 'resource://gre/modules/XPCOMUtils.sys.mjs';

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: 'resource:///modules/BrowserWindowTracker.sys.mjs',
  setTimeout: 'resource://gre/modules/Timer.sys.mjs',
  clearTimeout: 'resource://gre/modules/Timer.sys.mjs',
});

XPCOMUtils.defineLazyPreferenceGetter(lazy, 'gEnabled', 'zen.sync.enabled', false);
XPCOMUtils.defineLazyPreferenceGetter(lazy, 'gServerUrl', 'zen.sync.server-url', '');
XPCOMUtils.defineLazyPreferenceGetter(lazy, 'gIssuer', 'zen.sync.oidc.issuer', '');
XPCOMUtils.defineLazyPreferenceGetter(lazy, 'gClientId', 'zen.sync.oidc.client-id', '');
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  'gScope',
  'zen.sync.oidc.scope',
  'openid profile email offline_access'
);
XPCOMUtils.defineLazyPreferenceGetter(lazy, 'gRedirectPort', 'zen.sync.oidc.redirect-port', 8788);
XPCOMUtils.defineLazyPreferenceGetter(lazy, 'gIntervalMinutes', 'zen.sync.interval-minutes', 15);
XPCOMUtils.defineLazyPreferenceGetter(lazy, 'gExtraPrefs', 'zen.sync.extra-prefs', '');
XPCOMUtils.defineLazyPreferenceGetter(lazy, 'gShouldLog', 'zen.sync.log', false);

// The preferences we keep in step across devices by default. Deliberately a
// curated list (not "all of about:config") so syncing stays predictable.
// Add more at runtime with `zen.sync.extra-prefs` (comma-separated).
const DEFAULT_SYNCED_PREFS = [
  'zen.theme.accent-color',
  'zen.theme.color-prefs.amoled',
  'zen.theme.gradient',
  'zen.view.compact',
  'zen.view.compact.hide-tabbar',
  'zen.view.compact.hide-toolbar',
  'zen.view.sidebar-expanded',
  'zen.tabs.vertical',
  'zen.urlbar.behavior',
  'zen.workspaces.show-icon-strip',
];

const TOKEN_FILE = 'zen-sync-tokens.json';

export const ZenSync = {
  _timer: null,
  _syncing: false,
  _tokens: null, // { access_token, refresh_token, expires_at }

  init() {
    if (!lazy.gEnabled) {
      return;
    }
    this._log('init');
    // Give the browser a moment to settle before the first sync.
    this._timer = lazy.setTimeout(() => this.syncNow(), 10_000);
  },

  uninit() {
    if (this._timer) {
      lazy.clearTimeout(this._timer);
      this._timer = null;
    }
  },

  _log(...args) {
    if (lazy.gShouldLog) {
      console.log('[ZenSync]', ...args);
    }
  },

  _scheduleNext() {
    if (this._timer) {
      lazy.clearTimeout(this._timer);
    }
    const ms = Math.max(1, lazy.gIntervalMinutes) * 60_000;
    this._timer = lazy.setTimeout(() => this.syncNow(), ms);
  },

  _configValid() {
    return Boolean(lazy.gServerUrl && lazy.gIssuer && lazy.gClientId);
  },

  // --- Public entry points -------------------------------------------------

  /** Run a full pull+push cycle. Safe to call repeatedly; self-serializes. */
  async syncNow({ interactive = false } = {}) {
    if (this._syncing) {
      return;
    }
    if (!this._configValid()) {
      this._log('skipping: incomplete configuration');
      return;
    }
    this._syncing = true;
    try {
      const token = await this._getAccessToken({ interactive });
      if (!token) {
        this._log('no token; user not signed in');
        return;
      }
      await this._reconcile(token);
    } catch (err) {
      this._log('sync failed', err);
    } finally {
      this._syncing = false;
      this._scheduleNext();
    }
  },

  /** Kick off the interactive sign-in (opens Authentik in a tab). */
  async signIn() {
    const tokens = await this._authorizeInteractive();
    if (tokens) {
      await this._saveTokens(tokens);
      await this.syncNow();
    }
  },

  async signOut() {
    this._tokens = null;
    try {
      await IOUtils.remove(this._tokenPath());
    } catch {
      /* nothing stored */
    }
  },

  // --- Reconciliation ------------------------------------------------------

  async _reconcile(accessToken) {
    const remote = await this._fetchCollection('settings', accessToken);
    const remoteData = remote?.data ?? {};
    const remoteVersion = remote?.version ?? 0;

    const localData = this._readLocalPrefs();

    // Phase 1 policy: remote is the source of truth on pull (last-write-wins by
    // version), then we push our local view back up. A future phase can do
    // per-key 3-way merge using a stored base snapshot.
    let changed = false;
    for (const [name, value] of Object.entries(remoteData)) {
      if (this._applyPref(name, value)) {
        changed = true;
      }
    }
    if (changed) {
      this._log('applied remote settings');
    }

    const merged = { ...remoteData, ...this._readLocalPrefs() };
    if (JSON.stringify(merged) === JSON.stringify(remoteData)) {
      this._log('no local changes to push');
      return;
    }

    await this._putCollection('settings', merged, remoteVersion, accessToken);
    this._log('pushed local settings');
  },

  _syncedPrefNames() {
    const extra = lazy.gExtraPrefs
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return [...new Set([...DEFAULT_SYNCED_PREFS, ...extra])];
  },

  _readLocalPrefs() {
    const out = {};
    for (const name of this._syncedPrefNames()) {
      const value = this._getPref(name);
      if (value !== undefined) {
        out[name] = value;
      }
    }
    return out;
  },

  _getPref(name) {
    const branch = Services.prefs;
    switch (branch.getPrefType(name)) {
      case branch.PREF_BOOL:
        return branch.getBoolPref(name);
      case branch.PREF_INT:
        return branch.getIntPref(name);
      case branch.PREF_STRING:
        return branch.getStringPref(name);
      default:
        return undefined; // unset prefs are simply not synced
    }
  },

  /** Returns true if the pref's value actually changed. */
  _applyPref(name, value) {
    // Only touch prefs we're willing to sync, regardless of what the server
    // sends, so a compromised/buggy server can't flip arbitrary settings.
    if (!this._syncedPrefNames().includes(name)) {
      return false;
    }
    const current = this._getPref(name);
    if (current === value) {
      return false;
    }
    try {
      if (typeof value === 'boolean') {
        Services.prefs.setBoolPref(name, value);
      } else if (typeof value === 'number') {
        Services.prefs.setIntPref(name, value);
      } else if (typeof value === 'string') {
        Services.prefs.setStringPref(name, value);
      } else {
        return false;
      }
      return true;
    } catch (err) {
      this._log('failed to apply pref', name, err);
      return false;
    }
  },

  // --- Server API ----------------------------------------------------------

  _api(path) {
    const base = lazy.gServerUrl.replace(/\/$/, '');
    return `${base}${path}`;
  },

  async _fetchCollection(name, accessToken) {
    const res = await fetch(this._api(`/v1/collections/${name}`), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`GET ${name} failed: ${res.status}`);
    }
    return res.json();
  },

  async _putCollection(name, data, baseVersion, accessToken) {
    const res = await fetch(this._api(`/v1/collections/${name}`), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ baseVersion, data }),
    });
    if (res.status === 409) {
      // Someone else wrote first; next cycle will pull their version and merge.
      this._log('push conflict; will retry next cycle');
      return null;
    }
    if (!res.ok) {
      throw new Error(`PUT ${name} failed: ${res.status}`);
    }
    return res.json();
  },

  // --- OIDC token management ----------------------------------------------

  _tokenPath() {
    return PathUtils.join(PathUtils.profileDir, TOKEN_FILE);
  },

  async _saveTokens(tokens) {
    this._tokens = tokens;
    await IOUtils.writeJSON(this._tokenPath(), tokens);
  },

  async _loadTokens() {
    if (this._tokens) {
      return this._tokens;
    }
    try {
      this._tokens = await IOUtils.readJSON(this._tokenPath());
    } catch {
      this._tokens = null;
    }
    return this._tokens;
  },

  async _getAccessToken({ interactive }) {
    let tokens = await this._loadTokens();

    // Still valid? (60s safety margin)
    if (tokens?.access_token && tokens.expires_at > Date.now() + 60_000) {
      return tokens.access_token;
    }

    // Try a silent refresh.
    if (tokens?.refresh_token) {
      try {
        tokens = await this._refresh(tokens.refresh_token);
        await this._saveTokens(tokens);
        return tokens.access_token;
      } catch (err) {
        this._log('refresh failed', err);
      }
    }

    // Fall back to interactive sign-in only when explicitly allowed.
    if (interactive) {
      tokens = await this._authorizeInteractive();
      if (tokens) {
        await this._saveTokens(tokens);
        return tokens.access_token;
      }
    }
    return null;
  },

  async _discovery() {
    const base = lazy.gIssuer.endsWith('/') ? lazy.gIssuer : `${lazy.gIssuer}/`;
    const res = await fetch(new URL('.well-known/openid-configuration', base));
    if (!res.ok) {
      throw new Error(`OIDC discovery failed: ${res.status}`);
    }
    return res.json();
  },

  async _refresh(refreshToken) {
    const disco = await this._discovery();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: lazy.gClientId,
    });
    const res = await fetch(disco.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`token refresh failed: ${res.status}`);
    }
    return this._normalizeTokenResponse(await res.json(), refreshToken);
  },

  _normalizeTokenResponse(json, fallbackRefresh) {
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? fallbackRefresh,
      expires_at: Date.now() + (json.expires_in ?? 300) * 1000,
    };
  },

  // --- Interactive Authorization Code + PKCE over a loopback socket ---------

  async _authorizeInteractive() {
    const disco = await this._discovery();
    const verifier = this._randomString(64);
    const challenge = await this._pkceChallenge(verifier);
    const state = this._randomString(24);
    const redirectUri = `http://127.0.0.1:${lazy.gRedirectPort}/`;

    const authUrl = new URL(disco.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', lazy.gClientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', lazy.gScope);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    // Start listening before we open the tab so we never miss the redirect.
    const codePromise = this._awaitLoopbackCode(lazy.gRedirectPort, state);
    this._openInBrowser(authUrl.href);

    const code = await codePromise;
    if (!code) {
      return null;
    }

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: lazy.gClientId,
      code_verifier: verifier,
    });
    const res = await fetch(disco.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    if (!res.ok) {
      throw new Error(`code exchange failed: ${res.status}`);
    }
    return this._normalizeTokenResponse(await res.json());
  },

  _openInBrowser(url) {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    if (win?.gBrowser) {
      win.gBrowser.selectedTab = win.gBrowser.addTrustedTab(url);
    }
  },

  /**
   * Open an nsIServerSocket on 127.0.0.1:port, accept exactly one request, read
   * the `?code=&state=` from the request line, send back a small HTML page and
   * resolve with the authorization code (or null on mismatch/timeout).
   */
  _awaitLoopbackCode(port, expectedState) {
    return new Promise((resolve) => {
      const serverSocket = Cc[
        '@mozilla.org/network/server-socket;1'
      ].createInstance(Ci.nsIServerSocket);
      // loopback-only: third arg `aLoopbackOnly` true.
      serverSocket.init(port, true, -1);

      let settled = false;
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          serverSocket.close();
        } catch {
          /* already closed */
        }
        resolve(value);
      };

      // Give the user a couple of minutes to complete the login.
      const timeout = lazy.setTimeout(() => finish(null), 120_000);

      serverSocket.asyncListen({
        onSocketAccepted: (_socket, transport) => {
          try {
            const input = transport.openInputStream(0, 0, 0);
            const output = transport.openOutputStream(0, 0, 0);
            const sin = Cc[
              '@mozilla.org/scriptableinputstream;1'
            ].createInstance(Ci.nsIScriptableInputStream);
            sin.init(input);

            let raw = '';
            // The request line arrives in the first packet; read what's there.
            while (sin.available() > 0) {
              raw += sin.read(sin.available());
            }

            const requestLine = raw.split('\r\n')[0] || '';
            const match = /GET\s+(\S+)\s+HTTP/.exec(requestLine);
            let code = null;
            if (match) {
              const reqUrl = new URL(match[1], `http://127.0.0.1:${port}`);
              if (reqUrl.searchParams.get('state') === expectedState) {
                code = reqUrl.searchParams.get('code');
              }
            }

            const html =
              '<!doctype html><meta charset=utf-8>' +
              '<title>Zen Sync</title>' +
              '<body style="font-family:system-ui;padding:2rem">' +
              (code
                ? '<h2>Signed in to Zen Sync ✔</h2><p>You can close this tab.</p>'
                : '<h2>Sign-in failed</h2><p>You can close this tab and try again.</p>') +
              '</body>';
            const response =
              'HTTP/1.1 200 OK\r\n' +
              'Content-Type: text/html; charset=utf-8\r\n' +
              `Content-Length: ${html.length}\r\n` +
              'Connection: close\r\n\r\n' +
              html;
            output.write(response, response.length);
            output.close();
            input.close();

            lazy.clearTimeout(timeout);
            finish(code);
          } catch (err) {
            lazy.clearTimeout(timeout);
            finish(null);
          }
        },
        onStopListening: () => {},
      });
    });
  },

  // --- crypto helpers ------------------------------------------------------

  _randomString(bytes) {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return this._base64Url(buf);
  },

  async _pkceChallenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return this._base64Url(new Uint8Array(digest));
  },

  _base64Url(bytes) {
    let str = '';
    for (const b of bytes) {
      str += String.fromCharCode(b);
    }
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
};
