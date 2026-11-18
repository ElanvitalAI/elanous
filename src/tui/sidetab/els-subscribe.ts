// The real environment of the sidetab ⇄ els subscription: this host's socket, hosts.json, the tailnet read window.
// (els-rows.ts holds the logic and takes this as a parameter so tests never touch a real server.)
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { requestEls } from '../../els/client.js';
import { createFederation } from '../../els/federation.js';
import { withHerdrHost } from '../../els/herdr-host.js';
import { elsHostsPath, fetchHostJson, loadHostRegistry } from '../../els/hosts.js';
import { elsHostName, elsSocketPath } from '../../els/server.js';
import { fetchElsSidetabRows, type ElsSubscribeDeps } from './els-rows.js';

export { fetchElsSidetabRows };

// 출처: same bounds as `els ls` (src/cli/els-cli.ts): a socket answers at once; a tailnet host that is silent for
// this long is shown ✕ instead of holding up the panel's 1 s refresh (which skips a poll while one is pending).
const LOCAL_TIMEOUT_MS = 2_000;
const REMOTE_TIMEOUT_MS = 2_000;

export function realElsSubscribeDeps(): ElsSubscribeDeps {
  const stateRoot = elanousStateRoot();
  const localHost = elsHostName();
  // ELS-ONE-SPACE ④ — the herdr panes of this machine appear as the `herdr` host in the same list (read-only here).
  const hosts = withHerdrHost({
    registry: loadHostRegistry(elsHostsPath(stateRoot)),
    fetchJson: (host, path) => fetchHostJson(host, path, REMOTE_TIMEOUT_MS),
  });
  const federation = createFederation({
    localHost,
    askLocal: (request) => requestEls(elsSocketPath(stateRoot), request, LOCAL_TIMEOUT_MS),
    registry: hosts.registry,
    fetchJson: hosts.fetchJson,
  });
  return { list: () => federation.list(), localHost };
}
