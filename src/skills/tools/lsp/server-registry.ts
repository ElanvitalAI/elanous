// ── LSP server registry (Phase L4) ──
//
// Maps language → { command, args, extensions } and handles binary
// probing per language. Built lazily from user-config so tests /
// live config reloads see the current state without a process
// restart.
//
// Adapter per language is thin: tsserver / pyright / rust-analyzer
// all speak LSP over stdio, so the generic spawn flow in pool.ts
// works unchanged — this module just supplies the command + hint
// per language.

import { spawnSync } from 'node:child_process';
import { extname } from 'node:path';
import { debug } from '../../../debug/log.js';
import { getUserConfig } from '../../../user-config/reader.js';
import type { LspLanguageConfig } from '../../../user-config/types.js';

export type LspLanguageName = 'typescript' | 'python' | 'rust';

export interface LspLanguageEntry {
  language: LspLanguageName;
  command: string;
  args: readonly string[];
  extensions: readonly string[];
  /** Per-language human-friendly install hint surfaced when the
   *  binary probe fails. */
  installHint: string;
}

const INSTALL_HINTS: Record<LspLanguageName, string> = {
  typescript: 'Install with `npm i -g typescript-language-server typescript`.',
  python:     'Install with `npm i -g pyright` (recommended) or `pip install pyright`.',
  rust:       'Install with `rustup component add rust-analyzer` or `brew install rust-analyzer`.',
};

/** Probe cache per language. `undefined` = not probed; `null` = not
 *  installed; `string` = resolved path. */
const probeCache = new Map<string, string | null>();

/** Test-only: clear the probe cache so language tests can rerun
 *  without process restart. */
export function __resetServerRegistryForTests(): void {
  probeCache.clear();
}

/** Resolve the configured entry for a language. Returns `null` when
 *  the language is disabled in user config (`false`). */
export function resolveLanguageByName(name: LspLanguageName): LspLanguageEntry | null {
  const cfg = getUserConfig();
  if (!cfg.lsp.enabled) return null;
  const raw = cfg.lsp[name];
  if (raw === false) return null;
  return {
    language: name,
    command: raw.command,
    args: raw.args ?? [],
    extensions: raw.extensions,
    installHint: INSTALL_HINTS[name],
  };
}

/** Map a file path to the language entry serving its extension.
 *  Case-insensitive; first-match wins across typescript → python → rust
 *  in config order. Returns null when no configured language claims
 *  the extension or when the matched language is disabled. */
export function resolveLanguageForFile(filePath: string): LspLanguageEntry | null {
  const cfg = getUserConfig();
  if (!cfg.lsp.enabled) return null;
  const ext = extname(filePath).slice(1).toLowerCase();
  if (!ext) return null;
  // Ordered list — typescript first so .js / .jsx go there even if
  // python or rust later claims them (user's explicit config order
  // wins, but the default order is intentional).
  const order: LspLanguageName[] = ['typescript', 'python', 'rust'];
  for (const name of order) {
    const raw = cfg.lsp[name];
    if (raw === false) continue;
    if (raw.extensions.includes(ext)) {
      return {
        language: name,
        command: raw.command,
        args: raw.args ?? [],
        extensions: raw.extensions,
        installHint: INSTALL_HINTS[name],
      };
    }
  }
  return null;
}

/** Probe whether the binary for a language is on PATH. Cached per
 *  language name (not per command string — a config change is rare
 *  enough that we reset via `__resetServerRegistryForTests` /
 *  process restart rather than invalidating on every get). */
export function probeLanguageBinary(entry: LspLanguageEntry): string | null {
  const key = `${entry.language}:${entry.command}`;
  const cached = probeCache.get(key);
  if (cached !== undefined) return cached;
  let resolved: string | null = null;
  try {
    const r = spawnSync('which', [entry.command], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout) {
      const found = r.stdout.trim();
      if (found.length > 0) resolved = found;
    }
  } catch {
    /* swallow — probe failure => not installed */
  }
  probeCache.set(key, resolved);
  if (debug.enabled) {
    debug.log('lsp.registry.probe', entry.language, {
      command: entry.command, path: resolved,
    });
  }
  return resolved;
}

/** Readable "not installed" error string for dispatch sites. Combines
 *  the language-specific install hint with the configured binary name
 *  so users see exactly what we tried to spawn. */
export function installHintError(entry: LspLanguageEntry): Error {
  return new Error(
    `Lsp: \`${entry.command}\` (${entry.language}) is not installed. ${entry.installHint}`,
  );
}

export type { LspLanguageConfig };
