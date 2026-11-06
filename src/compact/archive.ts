// ── Wave 2 · compact archive (JSONL persistence) ──────────────────
//
// When `policy.archiveEnabled` is true (default), every cleared
// chunk produced by Layer 1 / Layer 2 / fallback truncation is
// appended to `~/.elanous/compact-archive/<sessionId>.jsonl`. The
// pipeline writes asynchronously and best-effort — IO errors never
// surface to the chat loop (project policy:
// feedback_persistence_swallow_errors).
//
// Replay / post-mortem are out-of-scope for Wave 2; this module
// only writes. A future `/compact --inspect` slash can read.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { cleanupLogDir, type RetentionPolicy, type RetentionResult } from '../mss/logging/retention.js';
import type { CompactArchiveEntry } from './types.js';

export function getDefaultArchiveDir(home: string = homedir()): string {
  return join(home, '.elanous', 'compact-archive');
}

export function archivePath(sessionId: string, dir?: string): string {
  const root = dir ?? getDefaultArchiveDir();
  return join(root, `${sanitiseSessionId(sessionId)}.jsonl`);
}

/** Keep ordinary paths readable and quote paths containing stub delimiters or escapes. */
export function archiveReferencePath(sessionId: string, dir?: string): string {
  const path = archivePath(sessionId, dir);
  return /[\]\\"\x00-\x1f]/.test(path) ? JSON.stringify(path) : path;
}

function sanitiseSessionId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'default';
}

/** Append one entry. Best-effort — swallows fs errors. Returns true
 *  on success so tests can verify writes happen. */
export function appendArchiveEntry(
  entry: CompactArchiveEntry,
  dir?: string,
): boolean {
  try {
    const path = archivePath(entry.sessionId, dir);
    const parent = dirname(path);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ── PR2 §5.2 · Archive retention (mirrors MSS M2.3 pattern) ─────────
//
// Same age + size policy the MSS log retention uses, applied to
// `<sessionId>.jsonl` archive files instead of `debug-*.log`. The
// `cleanupLogDir` helper is generic over a regex pattern, so we
// reuse it directly with a `*.jsonl` filter — keeping a single
// canonical implementation. Both knobs `0` ⇒ no-op, matching the
// feature-flag opt-out path.

const ARCHIVE_PATTERN = /^[A-Za-z0-9._-]+\.jsonl$/;

/** Synchronous cleanup. Same shape as `cleanupLogDir` so callers
 *  reuse the same `RetentionPolicy` knobs. */
export function cleanupArchiveDir(
  dir: string = getDefaultArchiveDir(),
  policy: Partial<RetentionPolicy> = {},
): RetentionResult {
  return cleanupLogDir(dir, { pattern: ARCHIVE_PATTERN, ...policy });
}

let archiveRetentionScheduled = false;

/** Detach a single retention run via `setImmediate`. Idempotent —
 *  subsequent calls are no-ops within the same process so a turn loop
 *  can call this every turn without bloating fs scan cost. Both knobs
 *  `0` ⇒ no schedule. */
export function scheduleArchiveRetentionOnce(
  policy: { maxAgeDays?: number; maxTotalMb?: number },
  dir: string = getDefaultArchiveDir(),
): void {
  if (archiveRetentionScheduled) return;
  if ((policy.maxAgeDays ?? 0) <= 0 && (policy.maxTotalMb ?? 0) <= 0) return;
  archiveRetentionScheduled = true;
  setImmediate(() => {
    try {
      cleanupArchiveDir(dir, policy);
    } catch {
      // best-effort — startup must not be blocked or interrupted
    }
  });
}

/** Test-only reset for the once-per-process guard. */
export function resetArchiveRetentionForTest(): void {
  archiveRetentionScheduled = false;
}

// ── PR3 §5.3 · /compact --inspect (archive replay viewer) ───────────
//
// Read-only access to the JSONL archive so the user can audit what
// the pipeline cleared. Skips malformed lines silently (counts them
// in `parseErrors`) — file is append-only by design and individual
// line corruption shouldn't hide the rest.

export interface InspectArchiveResult {
  path: string;
  exists: boolean;
  entries: CompactArchiveEntry[];
  /** Bytes of original content reclaimable from the archive (sum of
   *  `entry.content.length`). Useful for the slash status block. */
  totalContentChars: number;
  /** Per-layer counts so the slash response can show e.g. "tool-output:
   *  12 entries · microcompact: 3 entries". */
  perLayer: Record<string, number>;
  parseErrors: number;
  readError?: string;
}

export function inspectArchive(
  sessionId: string,
  dir?: string,
): InspectArchiveResult {
  const path = archivePath(sessionId, dir);
  const entries: CompactArchiveEntry[] = [];
  const perLayer: Record<string, number> = {};
  let totalContentChars = 0;
  let parseErrors = 0;

  if (!existsSync(path)) {
    return { path, exists: false, entries, totalContentChars, perLayer, parseErrors };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return {
      path,
      exists: true,
      entries,
      totalContentChars,
      perLayer,
      parseErrors,
      readError: err instanceof Error ? err.message : String(err),
    };
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as CompactArchiveEntry;
      if (
        typeof entry.ts === 'number' &&
        typeof entry.layer === 'string' &&
        typeof entry.sessionId === 'string' &&
        entry.origin && typeof entry.origin === 'object' &&
        typeof entry.content === 'string' &&
        typeof entry.replacement === 'string'
      ) {
        entries.push(entry);
        totalContentChars += entry.content.length;
        perLayer[entry.layer] = (perLayer[entry.layer] ?? 0) + 1;
      } else {
        parseErrors += 1;
      }
    } catch {
      parseErrors += 1;
    }
  }

  return { path, exists: true, entries, totalContentChars, perLayer, parseErrors };
}

export interface ArchiveSessionSummary {
  /** Filename without the .jsonl suffix — pass back to inspectArchive. */
  sessionId: string;
  /** Absolute path. */
  path: string;
  /** Bytes on disk. */
  size: number;
  /** mtime in ms. */
  mtimeMs: number;
}

export function listArchiveSessions(
  dir: string = getDefaultArchiveDir(),
): { sessions: ArchiveSessionSummary[]; readError?: string } {
  const sessions: ArchiveSessionSummary[] = [];
  if (!existsSync(dir)) return { sessions };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    return { sessions, readError: err instanceof Error ? err.message : String(err) };
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      sessions.push({
        sessionId: name.replace(/\.jsonl$/, ''),
        path,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // skip unreadable file
    }
  }
  // newest first
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { sessions };
}

/** Format an `inspectArchive` result for the chat surface. Caps the
 *  number of entries shown so a 10K-line archive doesn't flood the
 *  log; user can re-run with a higher limit if needed. */
export function formatInspectOutput(
  result: InspectArchiveResult,
  opts: { sessionId: string; limit?: number } = { sessionId: 'default' },
): string {
  const limit = opts.limit ?? 20;
  const lines: string[] = [];
  lines.push('── /compact --inspect ───────────────────────────────────');
  lines.push(`Session:  ${opts.sessionId}`);
  lines.push(`Archive:  ${result.path}`);
  if (!result.exists) {
    lines.push('(no archive — pipeline never wrote to this session, or retention swept it)');
    return lines.join('\n');
  }
  if (result.readError) {
    lines.push(`(read error: ${result.readError})`);
    return lines.join('\n');
  }
  lines.push(`Entries:  ${result.entries.length}${result.parseErrors > 0 ? `  (${result.parseErrors} malformed line(s) skipped)` : ''}`);
  lines.push(`Reclaim:  ${formatChars(result.totalContentChars)} chars across all entries`);
  if (result.entries.length === 0) return lines.join('\n');

  lines.push('');
  lines.push('Per layer:');
  for (const layer of Object.keys(result.perLayer).sort()) {
    lines.push(`  ${layer.padEnd(28)} ${String(result.perLayer[layer]).padStart(4)} entr${result.perLayer[layer] === 1 ? 'y' : 'ies'}`);
  }

  const shown = result.entries.slice(-limit);
  lines.push('');
  lines.push(`Latest ${shown.length} of ${result.entries.length}:`);
  for (const entry of shown) {
    const when = new Date(entry.ts).toISOString().replace('T', ' ').slice(0, 19);
    const originDesc = entry.origin.kind === 'tool_result'
      ? `tool_result${entry.origin.tool_use_id ? ` (${entry.origin.tool_use_id.slice(0, 12)})` : ''}`
      : `truncated_tail${entry.origin.messageIndex !== undefined ? ` [${entry.origin.messageIndex}]` : ''}`;
    lines.push(`  ${when}  ${entry.layer.padEnd(24)} ${originDesc.padEnd(36)} ${formatChars(entry.content.length).padStart(8)} chars`);
  }
  return lines.join('\n');
}

/** Format a session list for the chat surface. */
export function formatSessionList(
  result: { sessions: ArchiveSessionSummary[]; readError?: string },
): string {
  const lines: string[] = [];
  lines.push('── /compact --inspect list ──────────────────────────────');
  if (result.readError) {
    lines.push(`(read error: ${result.readError})`);
    return lines.join('\n');
  }
  if (result.sessions.length === 0) {
    lines.push('(no archives — directory empty or missing)');
    return lines.join('\n');
  }
  lines.push(`Found ${result.sessions.length} archive file(s):`);
  for (const s of result.sessions) {
    const when = new Date(s.mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
    lines.push(`  ${when}  ${s.sessionId.padEnd(36)} ${formatBytes(s.size).padStart(8)}`);
  }
  return lines.join('\n');
}

function formatChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
