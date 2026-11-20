// The person's own terminal presents the server's OWNER credential (JUD #39096 ⓒ: «a human types with the owner token»).
// The server writes it to a 0600 file next to its socket; `attachEls` and `requestEls` read it only from the process env,
// and nothing but `els seat set` ever loaded it, so a bare `els` / `els attach` typed into nothing after #39143.
//
// A pane never takes this path: a pane process carries its server-minted pane token (and the ELANOUS_ELS_* pane names), so
// a process that has any of them is not the person's terminal and keeps exactly the credential it was given. Nothing here
// prints or logs the token; the caller puts it in its own process env, as `els seat set` does.

import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from './server-auth.js';

/** Env names that only an els pane's process inherits from the server (client.ts reads the token, nesting.ts the socket). */
const PANE_MARKER_ENV = ['ELANOUS_ELS_PANE', 'ELANOUS_ELS_WS', 'ELANOUS_ELS_SOCKET'] as const;

export interface HumanTerminalAuthDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly socketPath: string;
  /** Both stdin and stdout are a terminal: scripts and pipes never adopt the owner credential. */
  readonly isTerminal: boolean;
  readonly uid?: number;
  readonly stat?: typeof lstatSync;
  readonly read?: (path: string) => string;
}

/** The owner token for the person's terminal, or undefined when this process is not that (or the file is not trustworthy). */
export function humanOwnerToken(deps: HumanTerminalAuthDeps): string | undefined {
  if (!deps.isTerminal) return undefined;
  if (deps.env[AUTH_PANE_TOKEN_ENV] || deps.env[AUTH_OWNER_TOKEN_ENV]) return undefined; // already holds a credential: never override it
  if (PANE_MARKER_ENV.some((name) => (deps.env[name] ?? '') !== '')) return undefined;   // a pane process, even with the token scrubbed
  const file = join(dirname(deps.socketPath), 'owner-token');
  try {
    const info = (deps.stat ?? lstatSync)(file);
    const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
    // Only the server's own file: a regular file (no symlink), ours, owner-only — anything else could be planted.
    if (!info.isFile() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) return undefined;
    const token = (deps.read ?? ((path: string) => readFileSync(path, 'utf8')))(file).trim();
    return token === '' ? undefined : token;
  } catch { return undefined; }
}
