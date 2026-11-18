// NEXUS · runtime sidecar (Phase N-1 PR α)
//
// `~/.elanous/nexus/runtime.json` carries non-lock metadata so external
// tools (PWA · control-client · external monitors) can discover the
// running nexus without grepping ps. Mirrors `elanous.runtime.json`
// pattern from elanous-daemon.ts but with nexus-specific fields.
//
// Fields (extended PR-by-PR — PR α has the minimum set):
//   pid · startedAt · nexusVersion · phase
//   httpPort · httpHost · httpAuth     ← PR δ
//   tailnetUrl · tailnetRecordedAt     ← daemon-owned Tailscale Serve result
//   template                           ← PR β when --template
//   sourceHead                         ← RAIL-STALE-TUI-HEAD (pinned code head)
//
// `tailnetUrl` records the URL returned while this daemon mounted Tailscale
// Serve. The mount may later be removed independently, so consumers must not
// treat this startup-time fact as a reachability guarantee.
//
// Best-effort write: never throws. Read returns null on missing /
// malformed (keeps callers terse).

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { ensureNexusRootDir, nexusRuntimePath } from './paths.js';

export interface NexusRuntimeMeta {
  pid: number;
  startedAt: string;
  /** Nexus arc version — bumped per phase (N-1 = '0.1', N-2 = '0.2', ...). */
  nexusVersion: string;
  /** Phase identifier surfaced by `elanous nexus --status`. */
  phase: string;
  /** HTTP listener actual port (auto-picked starting from 31415 — PR δ). */
  httpPort?: number;
  httpHost?: string;
  httpAuth?: 'on' | 'off';
  /** Complete URL returned by this daemon's successful Tailscale Serve mount. */
  tailnetUrl?: string;
  /** ISO timestamp for the successful Tailscale Serve result recorded above. */
  tailnetRecordedAt?: string;
  /** Template name when launched via `--template <name>` (PR β / N-3). */
  template?: string;
  /** Code head (40 hex) this nexus pinned at start — the app-build bridge refuses other heads
   *  (RAIL-STALE-TUI-HEAD). A TUI compares it to its own pinned head to show «재기동 필요». */
  sourceHead?: string;
}

export function writeNexusRuntime(meta: NexusRuntimeMeta): void {
  ensureNexusRootDir();
  try {
    writeFileSync(
      nexusRuntimePath(),
      JSON.stringify(meta, null, 2),
      { mode: 0o600 },
    );
  } catch { /* best-effort — never break boot */ }
}

export function readNexusRuntime(): NexusRuntimeMeta | null {
  return readNexusRuntimeAt(nexusRuntimePath());
}

/** Read and validate a runtime sidecar at an explicit lifecycle root. */
export function readNexusRuntimeAt(path: string): NexusRuntimeMeta | null {
  if (!existsSync(path)) return null;
  try {
    const body = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(body) as Partial<NexusRuntimeMeta>;
    if (typeof parsed.pid !== 'number') return null;
    if (typeof parsed.startedAt !== 'string') return null;
    if (typeof parsed.nexusVersion !== 'string') return null;
    if (typeof parsed.phase !== 'string') return null;
    return parsed as NexusRuntimeMeta;
  } catch {
    return null;
  }
}

export function deleteNexusRuntime(): void {
  const path = nexusRuntimePath();
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch { /* best-effort */ }
}
