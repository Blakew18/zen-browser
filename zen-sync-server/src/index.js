/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { loadConfig } from './config.js';
import { createServer } from './server.js';

const config = loadConfig();
const server = await createServer(config);

server.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(
    `zen-sync-server listening on http://${config.host}:${config.port} ` +
      `(issuer: ${config.oidc.issuer}, at-rest encryption: ${
        config.encryptionKey ? 'on' : 'off'
      })`
  );
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
