// ── LSP server pool (Phase L4 — language-keyed) ──
//
// L3's pool keyed entries by `cwd` alone — fine while only tsserver
// was in play. L4 adds python / rust, so keying widens to
// `${language}:${cwd}` and the spawn helper becomes generic (one LSP
// handshake flow, per-language command supplied by server-registry).
//
// Reuse semantics:
//   - same (language, cwd) → same client, idle timer rearmed
//   - different language, same cwd → separate pooled client
//   - different cwd, same language → separate pooled client
//     (tsserver / pyright / rust-analyzer all care about project
//     root; L5-style cross-project sharing policies are deferred)
//
// Teardown: 10-minute default idle reap (configurable via
// user-config.lsp.idleTimeoutMs); `process.once('exit', …)` best-
// effort cleanup; `__resetLspPoolForTests` for test hygiene.

import { pathToFileURL } from 'node:url';
import { debug } from '../../../debug/log.js';
import { getUserConfig } from '../../../user-config/reader.js';
import { spawnLspClient, type LspClient } from './client.js';
import {
  installHintError, probeLanguageBinary,
  type LspLanguageEntry, type LspLanguageName,
} from './server-registry.js';
import type { LspInitializeParams, LspInitializeResult } from './types.js';

interface PoolEntry {
  client: LspClient;
  idleTimer: ReturnType<typeof setTimeout>;
  language: LspLanguageName;
  cwd: string;
}

const pool = new Map<string, PoolEntry>();

/** Test-only hook to wipe the pool state between test suites. */
export function __resetLspPoolForTests(): void {
  for (const entry of pool.values()) {
    clearTimeout(entry.idleTimer);
    entry.client.dispose().catch(() => undefined);
  }
  pool.clear();
}

function keyFor(language: LspLanguageName, cwd: string): string {
  return `${language}:${cwd}`;
}

/** Get (or spawn) a live LSP client for the given (language, cwd).
 *  Runs the initialize / initialized handshake with a minimal
 *  capability set that covers every op L2 exercises (hover,
 *  definition, references, documentSymbol, workspaceSymbol). */
export async function getLspClient(
  entry: LspLanguageEntry,
  cwd: string,
): Promise<LspClient> {
  const bin = probeLanguageBinary(entry);
  if (!bin) throw installHintError(entry);

  const key = keyFor(entry.language, cwd);
  const existing = pool.get(key);
  if (existing && existing.client.alive) {
    clearTimeout(existing.idleTimer);
    existing.idleTimer = scheduleIdleReap(key);
    if (debug.enabled) {
      debug.log('lsp.pool.reuse', entry.language, { cwd });
    }
    return existing.client;
  }
  if (existing) {
    clearTimeout(existing.idleTimer);
    pool.delete(key);
    if (debug.enabled) {
      debug.log('lsp.pool.evict-dead', entry.language, { cwd });
    }
  }

  const client = spawnLspClient({
    command: entry.command,
    args: [...entry.args],
    cwd,
  });

  try {
    await runInitializeHandshake(client, entry, cwd);
  } catch (err) {
    await client.dispose().catch(() => undefined);
    throw err;
  }

  pool.set(key, {
    client,
    language: entry.language,
    cwd,
    idleTimer: scheduleIdleReap(key),
  });
  if (debug.enabled) {
    debug.log('lsp.pool.spawn', entry.language, { cwd, poolSize: pool.size });
  }
  return client;
}

/** Back-compat helper: L3 call sites used getTypescriptClient; the L4
 *  version routes through the generic path with a hard-coded
 *  `typescript` language. Kept exported so any stale import still
 *  compiles; new code should prefer getLspClient with an explicit
 *  entry. */
export async function getTypescriptClient(cwd: string): Promise<LspClient> {
  const { resolveLanguageByName } = await import('./server-registry.js');
  const entry = resolveLanguageByName('typescript');
  if (!entry) {
    throw new Error('Lsp: typescript is disabled in user-config.lsp.typescript');
  }
  return getLspClient(entry, cwd);
}

/** Release a client reference. No-op in L4 (idle reap handles
 *  teardown); kept so call sites still read cleanly. Refcounted
 *  variant is an L5-era optimisation. */
export function releaseLspClient(_language: LspLanguageName, _cwd: string): void {
  /* no-op */
}
export function releaseTypescriptClient(cwd: string): void {
  releaseLspClient('typescript', cwd);
}

/** Reap every pooled client right now. */
export async function disposeAllPooledClients(): Promise<void> {
  const entries = Array.from(pool.values());
  pool.clear();
  for (const entry of entries) clearTimeout(entry.idleTimer);
  await Promise.all(entries.map(e => e.client.dispose().catch(() => undefined)));
  if (debug.enabled) {
    debug.log('lsp.pool.dispose-all', 'all', { count: entries.length });
  }
}

async function runInitializeHandshake(
  client: LspClient,
  entry: LspLanguageEntry,
  cwd: string,
): Promise<void> {
  const initParams: LspInitializeParams = {
    processId: process.pid,
    rootUri: pathToFileURL(cwd).toString(),
    clientInfo: { name: 'monad-agent-lsp-client' },
    capabilities: {
      textDocument: {
        hover: { contentFormat: ['markdown', 'plaintext'] },
        synchronization: { didOpen: true, didClose: true },
        definition: { linkSupport: false },
        references: {},
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      } as Record<string, unknown>,
      workspace: {
        workspaceFolders: false,
        symbol: {},
      } as Record<string, unknown>,
    },
    workspaceFolders: null,
  };
  await client.request<LspInitializeResult>('initialize', initParams);
  client.notify('initialized', {});
  if (debug.enabled) {
    debug.log('lsp.pool.handshake', entry.language, { cwd });
  }
}

function scheduleIdleReap(key: string): ReturnType<typeof setTimeout> {
  const cfg = getUserConfig();
  const ms = cfg.lsp.idleTimeoutMs;
  const timer = setTimeout(() => {
    const entry = pool.get(key);
    if (!entry) return;
    pool.delete(key);
    if (debug.enabled) {
      debug.log('lsp.pool.idle-reap', entry.language, { cwd: entry.cwd });
    }
    entry.client.dispose().catch(() => undefined);
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

process.once('exit', () => {
  for (const entry of pool.values()) {
    clearTimeout(entry.idleTimer);
    try { entry.client.dispose().catch(() => undefined); }
    catch { /* swallow */ }
  }
  pool.clear();
});
