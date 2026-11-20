// The eln toggle's els rules (ELS-NESTING-RULE ① ③): the call site of `elnSidetabPlacement` / `handOffToEls`.
// Inside an els pane the toggle stays eln's own sidetab; a bare eln with a live els server puts els around this session.
// Every other case — no server, a turn running, any failure — is `local`: the caller does what the toggle always did.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { requestEls } from '../els/client.js';
import { humanOwnerToken } from '../els/human-terminal-auth.js';
import { elnSidetabPlacement, handOffToEls, type ElsHandoffDeps } from '../els/nesting.js';
import { elsSocketPath, elsSocketTaken } from '../els/server.js';
import { elanousCommandFor } from '../els/supervisor.js';

export type ToggleHandoff =
  | { readonly kind: 'local' }
  | { readonly kind: 'local'; readonly message: string }
  | { readonly kind: 'exit'; readonly message: string };

export interface ToggleHandoffDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sessionId: string;
  readonly cwd: string;
  /** A turn is running: moving the session now could lose its output. */
  readonly busy: boolean;
  readonly serverLive: () => Promise<boolean>;
  readonly request: ElsHandoffDeps['request'];
  /** Arms the outer frame to start once this TUI has closed; true when armed. */
  readonly armOuter: () => boolean;
}

export async function elnToggleHandoff(deps: ToggleHandoffDeps): Promise<ToggleHandoff> {
  if (elnSidetabPlacement(deps.env) === 'inside-pane') return { kind: 'local' };
  if (deps.busy) return { kind: 'local' };
  let live = false;
  try { live = await deps.serverLive(); } catch { live = false; }
  if (!live) return { kind: 'local' };
  try {
    const result = await handOffToEls({
      env: deps.env, sessionId: deps.sessionId, cwd: deps.cwd, ws: basename(deps.cwd) || 'els',
      request: deps.request, launchOuter: async () => deps.armOuter(),
    });
    return result.kind === 'handed-off' ? { kind: 'exit', message: result.message } : { kind: 'local', message: result.message };
  } catch (error) {
    return { kind: 'local', message: `els: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Real seams: the server socket of this state dir and the person's terminal credential (never put into env). */
export function realToggleHandoffSeams(): Pick<ToggleHandoffDeps, 'serverLive' | 'request'> {
  const stateRoot = elanousStateRoot();
  const socket = elsSocketPath(stateRoot);
  return {
    serverLive: async () => (await elsSocketTaken(socket)) === 'live',
    request: (req) => requestEls(socket, req, undefined, humanOwnerToken({ env: process.env, socketPath: socket, isTerminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) })),
  };
}

/** Starts the outer els as this terminal's foreground program (call after the TUI is closed). Its exit ends the hand-off. */
export function runOuterEls(): number {
  const command = [...elanousCommandFor({ prefixEnv: process.env.ELANOUS_INSTALL_PREFIX, home: homedir(), exists: existsSync, execPath: process.execPath, entry: process.argv[1] }), 'side'];
  return spawnSync(command[0]!, command.slice(1), { stdio: 'inherit' }).status ?? 1;
}
