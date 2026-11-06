// NEXUS · /v1/nexus/tabs/:id/logs route (Phase N-3 PR λ)
//
// Two response modes:
//   - GET /v1/nexus/tabs/:id/logs?lines=200       → JSON tail
//   - GET /v1/nexus/tabs/:id/logs?stream=1        → SSE: new lines as they
//                                                    are written (poll-based,
//                                                    500ms cadence)
//
// File sources:
//   ~/.elanous/nexus/logs/<id>/stdout.log
//   ~/.elanous/nexus/logs/<id>/stderr.log
//   (Created by the supervisor's spawn primitive — see PR ε spawn.ts.)
//
// Tail mode reads the last `lines` lines from each file. Stream mode opens
// both files for tailing (poll byte length, emit decoded delta as
// line-by-line SSE frames). Cancel = client disconnects = stop polling.

import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { nexusLogsDir } from '../paths.js';
import type { TabRegistry } from '../state/tab-registry.js';
import { jsonResponse } from './json-response.js';
import { SSE_HEARTBEAT_MS } from './sse-heartbeat.js';

const STREAM_POLL_MS = 500;
const STREAM_CHUNK_BYTES = 64 * 1024;

export function handleTabLogs(registry: TabRegistry, id: string, url: URL): Response {
  const tab = registry.get(id);
  if (!tab) return jsonResponse({ error: 'tab-not-found', id }, 404);

  if (url.searchParams.get('stream') === '1') {
    return streamTabLogs(id);
  }

  const linesParam = url.searchParams.get('lines');
  const linesN = parseLines(linesParam);
  return jsonResponse(tailTabLogs(id, linesN), 200);
}

export interface TabLogsTail {
  id: string;
  lines: number;
  stdout: { path: string; tail: string[]; size: number; mtime?: number };
  stderr: { path: string; tail: string[]; size: number; mtime?: number };
}

function tailTabLogs(id: string, lines: number): TabLogsTail {
  const stdoutPath = joinPath(nexusLogsDir(id), 'stdout.log');
  const stderrPath = joinPath(nexusLogsDir(id), 'stderr.log');
  return {
    id,
    lines,
    stdout: readTail(stdoutPath, lines),
    stderr: readTail(stderrPath, lines),
  };
}

function readTail(path: string, lines: number): { path: string; tail: string[]; size: number; mtime?: number } {
  if (!existsSync(path)) return { path, tail: [], size: 0 };
  try {
    const st = statSync(path);
    const raw = readFileSync(path, 'utf-8');
    const all = raw.split('\n');
    // Drop trailing empty entry from a final newline so consumers see
    // exactly `lines` non-empty entries (when there are that many).
    if (all.length > 0 && all[all.length - 1] === '') all.pop();
    const tail = lines >= all.length ? all : all.slice(all.length - lines);
    return { path, tail, size: st.size, mtime: st.mtimeMs };
  } catch {
    return { path, tail: [], size: 0 };
  }
}

function parseLines(raw: string | null): number {
  if (!raw) return 200;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(n, 5000); // cap so a malicious caller can't pull a huge tail in memory
}

// ---------------------------------------------------------------------------
// SSE stream — poll both files for size deltas
// ---------------------------------------------------------------------------

function streamTabLogs(id: string): Response {
  const stdoutPath = joinPath(nexusLogsDir(id), 'stdout.log');
  const stderrPath = joinPath(nexusLogsDir(id), 'stderr.log');
  let cancelled = false;
  let stdoutCursor = currentSize(stdoutPath);
  let stderrCursor = currentSize(stderrPath);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (chunk: string): void => {
        if (cancelled) return;
        try { controller.enqueue(encoder.encode(chunk)); } catch { /* closed */ }
      };

      send(`: nexus tab logs stream (id=${id})\n\n`);

      const tick = (): void => {
        if (cancelled) return;
        try {
          const newOut = drainNew(stdoutPath, stdoutCursor);
          if (newOut.delta.length > 0) {
            stdoutCursor = newOut.size;
            for (const line of newOut.delta) {
              send(`event: log\ndata: ${JSON.stringify({ stream: 'stdout', line })}\n\n`);
            }
          } else {
            stdoutCursor = newOut.size; // file may have been rotated → reset cursor
          }
          const newErr = drainNew(stderrPath, stderrCursor);
          if (newErr.delta.length > 0) {
            stderrCursor = newErr.size;
            for (const line of newErr.delta) {
              send(`event: log\ndata: ${JSON.stringify({ stream: 'stderr', line })}\n\n`);
            }
          } else {
            stderrCursor = newErr.size;
          }
        } catch {
          /* swallow polling errors */
        }
      };

      const pollInterval = setInterval(tick, STREAM_POLL_MS);
      const heartbeat = setInterval(() => send(`: ping\n\n`), SSE_HEARTBEAT_MS);

      (controller as unknown as { _nexusLogsCleanup?: () => void })._nexusLogsCleanup = () => {
        cancelled = true;
        clearInterval(pollInterval);
        clearInterval(heartbeat);
      };
    },
    cancel(): void {
      cancelled = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}

function currentSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

interface DrainResult {
  delta: string[];
  size: number;
}

function drainNew(path: string, fromCursor: number): DrainResult {
  if (!existsSync(path)) return { delta: [], size: 0 };
  let size = 0;
  try { size = statSync(path).size; } catch { return { delta: [], size: 0 }; }

  if (size <= fromCursor) {
    // File shrank (rotation) or unchanged. Reset cursor; no new delta.
    return { delta: [], size };
  }
  const need = size - fromCursor;
  const buf = Buffer.alloc(Math.min(need, STREAM_CHUNK_BYTES));
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, buf.length, fromCursor);
  } catch {
    return { delta: [], size };
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch { /* ignore */ }
  }
  const text = buf.toString('utf-8');
  const lines = text.split('\n');
  // Drop trailing partial line if the chunk was capped — best-effort.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const newSize = fromCursor + Math.min(need, STREAM_CHUNK_BYTES);
  return { delta: lines, size: newSize };
}
