// The real environment of the sidetab ⇄ els subscription: this host's socket, hosts.json, the tailnet read window.
// (els-rows.ts holds the logic and takes this as a parameter so tests never touch a real server.)
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { requestEls } from '../../els/client.js';
import { createFederation } from '../../els/federation.js';
import { withHerdrHost } from '../../els/herdr-host.js';
import { elsHostsPath, fetchHostJson, loadHostRegistry } from '../../els/hosts.js';
import { humanOwnerToken } from '../../els/human-terminal-auth.js';
import { elsHostName, elsSocketPath } from '../../els/server.js';
import { subscribeEls } from '../../els/subscribe-client.js';
import { fetchElsSidetabRows, type ElsSubscribeDeps } from './els-rows.js';

export { fetchElsSidetabRows };

// 출처: same bounds as `els ls` (src/cli/els-cli.ts): a socket answers at once; a tailnet host that is silent for
// this long is shown ✕ instead of holding up the panel's 1 s refresh (which skips a poll while one is pending).
const LOCAL_TIMEOUT_MS = 2_000;
const REMOTE_TIMEOUT_MS = 2_000;

// 출처: the receiving owner renders the pane's screen to check it is not busy before it answers (≤ the 10 s local request);
// same bound as `els do` in src/cli/els-cli.ts.
const DO_TIMEOUT_MS = 8_000;

/** The person's own terminal presents the server's owner token (gated: real TTY, no pane env, 0600 own file). It is handed to
 *  the request only — never put into this process's env, so nothing the TUI spawns inherits it. */
function personTerminalCredential(stateRoot: string): string | undefined {
  return humanOwnerToken({ env: process.env, socketPath: elsSocketPath(stateRoot), isTerminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
}

/** This host's els federation as the sidetab sees it: the list, a read and a `do` — the same three the CLI has. */
export function realElsFederation(): { federation: ReturnType<typeof createFederation>; localHost: string } {
  const stateRoot = elanousStateRoot();
  const localHost = elsHostName();
  // ELS-ONE-SPACE ④ — the herdr panes of this machine appear as the `herdr` host in the same list.
  const hosts = withHerdrHost({
    registry: loadHostRegistry(elsHostsPath(stateRoot)),
    fetchJson: (host, path) => fetchHostJson(host, path, REMOTE_TIMEOUT_MS),
    postJson: (host, path, payload) => fetchHostJson(host, path, DO_TIMEOUT_MS, payload),
  });
  const federation = createFederation({
    localHost,
    askLocal: (request) => requestEls(elsSocketPath(stateRoot), request, LOCAL_TIMEOUT_MS, personTerminalCredential(stateRoot)),
    registry: hosts.registry,
    fetchJson: hosts.fetchJson,
    postJson: hosts.postJson,
  });
  return { federation, localHost };
}

export function realElsSubscribeDeps(): ElsSubscribeDeps {
  const { federation, localHost } = realElsFederation();
  return { list: () => federation.list(), localHost };
}

// ELS-DESKTOP-SIDETAB-SUBSCRIBE gap (a): the panel follows the server by push instead of asking `ls` every second.
// The 1 s panel timer stays as the fallback: while the subscription is not live (no server, an older server without the
// `subscribe` op, a dropped connection) every tick polls as before, and a dropped one is re-tried every few ticks.
// While live the timer only polls on a slow heartbeat, because the push covers this host's server and not the tailnet
// hosts or herdr panes of the federated list.
const HEARTBEAT_TICKS = 15;
const RETRY_TICKS = 5;

export interface ElsFeedDeps {
  readonly subscribe: (handlers: { onList: (message: string) => void; onEnd: (reason: string) => void }) => { close: () => void };
  /** The server pushed a list: re-read the federated list and repaint. */
  readonly onChange: () => void;
  readonly heartbeatTicks?: number;
  readonly retryTicks?: number;
}

export interface ElsFeed {
  /** Call once per panel timer tick. `poll` says whether this tick must also ask the federated list. */
  readonly tick: () => { poll: boolean };
  /** True once the server has pushed and the connection has not ended since. */
  readonly live: () => boolean;
  readonly stop: () => void;
}

export function createElsFeed(deps: ElsFeedDeps): ElsFeed {
  const heartbeat = deps.heartbeatTicks ?? HEARTBEAT_TICKS;
  const retry = deps.retryTicks ?? RETRY_TICKS;
  let stopped = false;
  let connection: { close: () => void } | undefined;
  let live = false;
  let ticks = 0;
  let sinceAttempt = Number.POSITIVE_INFINITY;
  const connect = (): void => {
    sinceAttempt = 0;
    const mine: { close: () => void } = deps.subscribe({
      onList: () => { if (stopped || connection !== mine) return; live = true; deps.onChange(); },
      onEnd: () => { if (connection !== mine) return; connection = undefined; live = false; },
    });
    connection = mine;
  };
  return {
    tick() {
      ticks++;
      if (stopped) return { poll: true };
      if (!connection) { sinceAttempt++; if (sinceAttempt >= retry) connect(); }
      return { poll: !live || ticks % heartbeat === 0 };
    },
    live: () => live,
    stop() {
      stopped = true;
      live = false;
      const open = connection;
      connection = undefined;
      open?.close();
    },
  };
}

/** The feed against this host's real server socket. */
export function realElsFeed(onChange: () => void): ElsFeed {
  const socket = elsSocketPath(elanousStateRoot());
  return createElsFeed({ subscribe: (handlers) => subscribeEls(socket, handlers), onChange });
}
