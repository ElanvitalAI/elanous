// MVP M1.2 — Elanous daemon paths + lock helpers.
//
// Mirrors `src/scheduler/lock.ts` + `src/scheduler/paths.ts`. The
// daemon (= ACP server with unix-socket transport) writes a single
// pid lock so `elanous serve --status` / `--stop` can find it without
// scanning the process list.
//
// Paths (all under `~/.elanous/`):
//   elanous.sock — Unix domain socket bound by `bootAcpServer({ transport: 'unix-socket' })`
//   elanous.pid  — single-instance lock (pid + start ts + label · 0600)
//   elanous.log  — stdout/stderr capture for detached mode
//
// The lock module reuses telegram-lock's primitives so future tooling
// can read all three locks (telegram / scheduler / daemon) with the
// same shape.

import { join as joinPath } from 'node:path';
import { getElanousConfigDir } from './elanous-config-dir.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

import {
  acquireTelegramLock,
  safeReadLock,
  isAliveLock,
  TelegramLockError,
  type AcquireOpts,
  type LockMeta,
} from './telegram-lock.js';

import { defaultUnixSocketPath } from './boot/acp-socket-path.js';

export type ElanousDaemonLockMeta = LockMeta;
export class ElanousDaemonLockError extends TelegramLockError {}

export function elanousDaemonDir(): string {
  // Delegates to the central resolver (src/elanous-config-dir.ts).
  // The `--config-dir <dir>` CLI flag and `setElanousConfigDir()`
  // test helper both populate the same source. Legacy
  // `ELANOUS_DAEMON_DIR` env var is still honoured by the resolver
  // for backwards-compatibility but emits a one-shot deprecation
  // nudge on stderr.
  return getElanousConfigDir();
}

export function elanousDaemonLockPath(): string {
  return joinPath(elanousDaemonDir(), 'elanous.pid');
}

export function elanousDaemonLogPath(): string {
  return joinPath(elanousDaemonDir(), 'elanous.log');
}

/** Default unix socket path the daemon binds. Resolved from
 *  `boot/acp-socket-path.ts` without loading the ACP server. */
export function elanousDaemonSocketPath(): string {
  return defaultUnixSocketPath();
}

/** Ensure `~/.elanous/` exists. Idempotent. */
export function ensureElanousDaemonDir(): void {
  mkdirSync(elanousDaemonDir(), { recursive: true });
}

export function acquireElanousDaemonLock(opts: AcquireOpts = {}): () => void {
  ensureElanousDaemonDir();
  try {
    return acquireTelegramLock(elanousDaemonLockPath(), opts);
  } catch (err) {
    if (err instanceof TelegramLockError) {
      throw Object.assign(
        new ElanousDaemonLockError(err.existing, err.lockPath),
        { cause: err },
      );
    }
    throw err;
  }
}

export function readElanousDaemonLock(): ElanousDaemonLockMeta | null {
  return safeReadLock(elanousDaemonLockPath());
}

export function isAliveElanousDaemonLock(meta: ElanousDaemonLockMeta): boolean {
  return isAliveLock(meta);
}

/** Sidecar JSON beside the lock file. Captures runtime metadata
 *  beyond what the basic lock format carries (pid + startedAt +
 *  label). C4 uses it so `elanous serve --status` can echo the http
 *  port, host, and auth mode the daemon was started with. */
export interface ElanousDaemonRuntimeMeta {
  pid: number;
  startedAt: string;
  socketPath: string;
  httpPort?: number;
  httpHost?: string;
  httpAuth?: 'on' | 'off';
  /** M1.5 A.1 — disk-backed history directory the daemon was started
   *  with. `undefined` (or absent) means in-memory only. Surfaced by
   *  `elanous serve --status` so users can verify their `ELANOUS_HISTORY_DIR`
   *  env was picked up. */
  historyDir?: string;
  /** M1.5 A.2 — active tool surface ('none' default, 'readonly' adds
   *  Read · Grep · WebSearch, 'webterm' adds the WT-L-1 web-terminal
   *  tools — List · Snapshot · Input — for PWA-only mode). Surfaced
   *  by `--status`. */
  tools?: 'none' | 'readonly' | 'webterm';
  /** M1.5 A.2 — tool-cwd for fs-bound tools (Read · Grep). Only
   *  meaningful when `tools !== 'none'`. */
  toolCwd?: string;
  /** Step 3 PR β — uuid the daemon registered itself under in
   *  `~/.elanous/registry/daemons/<id>.json`. Lets `--status` echo
   *  both the legacy runtime sidecar + the new registry record so
   *  users (and the Phase 2 migration helper) can correlate them. */
  daemonId?: string;
}

export function elanousDaemonRuntimePath(): string {
  return joinPath(elanousDaemonDir(), 'elanous.runtime.json');
}

export function writeElanousDaemonRuntime(meta: ElanousDaemonRuntimeMeta): void {
  ensureElanousDaemonDir();
  writeFileSync(
    elanousDaemonRuntimePath(),
    JSON.stringify(meta, null, 2),
    { mode: 0o600 },
  );
}

export function readElanousDaemonRuntime(): ElanousDaemonRuntimeMeta | null {
  const path = elanousDaemonRuntimePath();
  if (!existsSync(path)) return null;
  try {
    const body = readFileSync(path, 'utf-8');
    return JSON.parse(body) as ElanousDaemonRuntimeMeta;
  } catch {
    return null;
  }
}

export function deleteElanousDaemonRuntime(): void {
  const path = elanousDaemonRuntimePath();
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch { /* best-effort */ }
}
