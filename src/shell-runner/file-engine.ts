// ── FileCaptureEngine (NT-A5) ──
//
// Engine for ShellMode ∈ { inline, bg }. Spawns the command with
// `child_process.spawn` and captures stdout/stderr via pipes. No
// PTY, no xterm emulator, no OSC 133 — this is the claude-code
// "quick Bash tool" path. Boundary = child exit event.
//
// Reference: ~/source/ref/claude-code-fork
//   src/utils/ShellCommand.ts   (ShellCommand + ExecResult)
//   src/utils/task/TaskOutput.ts (1000-line CircularBuffer + disk spill)
//   src/utils/shell/outputLimits.ts (8MB, 30KB, 150KB caps)
//
// Design notes
// ────────────
// • We keep stdout / stderr separated here because (unlike a PTY)
//   there is no TTY merging — callers that want interleave get
//   `aggregated`, which reconstructs chunks in spawn order from the
//   per-stream timestamp queue.
// • CircularBuffer size = 1000 lines matches claude-code. Anything
//   older rolls off the live tail; the full history is on disk.
// • Disk spill kicks in at DEFAULT_MAX_MEMORY (8 MiB per stream)
//   — beyond that, we keep appending to a tmp file and only retain
//   the tail lines in memory for progress display. The returned
//   StreamOutput.text is head+tail-capped to `maxOutputBytes` (the
//   LLM-facing cap); the full on-disk path is returned separately
//   as ShellResult.outputFilePath for callers that want the full
//   record (e.g. a later ShellPoll tool read).
// • Commands are spawned with `bash -lc <string>` when `command` is
//   a string; array commands are direct argv with no shell involved
//   (cleaner, no quoting surprises — codex-style).

import { requirePosixShell } from '../platform/default-shell.js';
import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import { mkdtempSync, createWriteStream, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  BoundaryEvent,
  BufferMark,
  CaptureEngine,
  OutputChunk,
  PromoteOpts,
  RunCtx,
  ShellHandle,
  ShellMode,
  ShellRequest,
  ShellResult,
  ShellStatus,
  StreamOutput,
  Unsubscribe,
} from './types.js';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUTS,
} from './types.js';

const DEFAULT_MAX_MEMORY_BYTES = 8 * 1024 * 1024;   // 8 MiB — claude-code default
const CIRCULAR_LINE_LIMIT = 1000;

export interface FileEngineOpts {
  now?: () => number;
  /** Override child_process.spawn for tests. */
  spawnFn?: typeof nodeSpawn;
  /** Per-stream in-memory cap before disk spill. */
  maxMemoryBytes?: number;
  /** tmp dir factory — tests can inject a deterministic path. */
  tmpDir?: () => string;
}

export function createFileCaptureEngine(opts: FileEngineOpts = {}): CaptureEngine {
  return {
    kind: 'file',
    run(req, ctx) {
      return startRun(req, ctx, opts);
    },
  };
}

function startRun(req: ShellRequest, ctx: RunCtx, opts: FileEngineOpts): ShellHandle {
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const now = opts.now ?? Date.now;
  const maxMemory = opts.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES;
  const tmpDir = opts.tmpDir ?? (() => tmpdir());

  const mode: Exclude<ShellMode, 'auto'> = resolveMode(req.mode);
  const id = `sh-${Math.random().toString(36).slice(2, 10)}`;
  const started = now();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUTS[mode];
  const maxOutputBytes = req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const chunkSubs = new Set<(c: OutputChunk) => void>();
  const boundarySubs = new Set<(ev: BoundaryEvent) => void>();
  const statusSubs = new Set<(s: ShellStatus) => void>();

  let status: ShellStatus = 'running';
  const setStatus = (next: ShellStatus) => {
    if (status === next) return;
    status = next;
    for (const cb of statusSubs) { try { cb(next); } catch { /* isolate */ } }
  };

  const bookmark: BufferMark = { row: 0, col: 0, ts: started, bytes: 0 };

  const stdout = createStreamSink('stdout', maxMemory, tmpDir);
  const stderr = createStreamSink('stderr', maxMemory, tmpDir);
  const aggregatedEntries: Array<{ bytes: string; ts: number }> = [];

  let settled = false;
  let timedOut = false;
  let interrupted = false;
  let outcome: ShellResult['outcome'] = 'exit';

  const resolvers: Array<(r: ShellResult) => void> = [];
  const result = new Promise<ShellResult>((resolve) => { resolvers.push(resolve); });

  const unsubs: Unsubscribe[] = [];
  const child = spawnChild(req, spawnFn);
  let exitCode: number | undefined;
  let spawnError: string | undefined;

  // spawn-error path: caller sees a settled-without-exit handle.
  child.once('error', (err) => {
    spawnError = String((err as Error)?.message ?? err);
    outcome = 'spawn-error';
    finalize({ source: 'exit' });
  });

  const wireStream = (
    kind: 'stdout' | 'stderr',
    src: NodeJS.ReadableStream,
  ) => {
    const sink = kind === 'stdout' ? stdout : stderr;
    src.on('data', (buf: Buffer | string) => {
      if (settled) return;
      const bytes = typeof buf === 'string' ? buf : buf.toString('utf8');
      sink.append(bytes);
      aggregatedEntries.push({ bytes, ts: now() });
      const chunk: OutputChunk = { stream: kind, bytes, ts: now() };
      for (const cb of chunkSubs) { try { cb(chunk); } catch { /* isolate */ } }
    });
  };
  wireStream('stdout', child.stdout);
  wireStream('stderr', child.stderr);

  child.once('exit', (code, signal) => {
    if (settled) return;
    // Node's exit event fires before stdout/stderr 'end', so any
    // late buffered bytes are still pushed onto the sinks by then;
    // we wait one microtask so all 'data' handlers flush.
    queueMicrotask(() => {
      if (signal && code === null) {
        exitCode = 128 + signalToNumber(signal);
      } else if (code !== null) {
        exitCode = code;
      }
      finalize({ source: 'exit' });
    });
  });

  // Hard timeout — SIGTERM first, escalate to SIGKILL after 2s.
  const hardTimer = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    interrupted = true;
    outcome = 'timeout';
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000);
    // Let 'exit' finalize. But if the child somehow refuses even
    // SIGKILL, force-resolve here after one more second so the
    // Promise is never orphaned.
    setTimeout(() => {
      if (!settled) finalize({ source: 'exit' });
    }, 3000);
  }, timeoutMs);
  unsubs.push(() => clearTimeout(hardTimer));

  // AbortSignal support.
  if (req.signal) {
    const onAbort = () => {
      if (settled) return;
      interrupted = true;
      outcome = 'aborted';
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    };
    if (req.signal.aborted) onAbort();
    else req.signal.addEventListener('abort', onAbort, { once: true });
  }

  function finalize(end: { source: BoundaryEvent['source'] }) {
    if (settled) return;
    settled = true;
    for (const u of unsubs) { try { u(); } catch { /* ignore */ } }
    stdout.close();
    stderr.close();
    for (const cb of boundarySubs) {
      try {
        cb({ kind: 'cmd-end', source: end.source, at: now(), exitCode });
      } catch { /* isolate */ }
    }
    setStatus(interrupted && !timedOut ? 'killed' : 'completed');
    try { ctx.onSettled?.(undefined as never); } catch { /* ignore */ }
    const r = buildResult(
      stdout,
      stderr,
      aggregatedEntries,
      started,
      now(),
      {
        exitCode,
        outcome,
        timedOut,
        interrupted,
        spawnError,
        maxOutputBytes,
        bookmark,
      },
    );
    try { ctx.onSettled?.(r); } catch { /* ignore */ }
    for (const rr of resolvers) rr(r);
  }

  const handle: ShellHandle = {
    id,
    mode,
    get status() { return status; },
    bookmark,
    kill(signal) {
      if (settled) return;
      interrupted = true;
      outcome = 'aborted';
      try { child.kill(signal ?? 'SIGTERM'); } catch { /* ignore */ }
    },
    background() {
      if (settled || status !== 'running') return false;
      setStatus('backgrounded');
      return true;
    },
    promote(_to: 'modal' | 'vw' | 'inline', _opts?: PromoteOpts) { return false; },
    write(bytes) {
      if (settled) return;
      try { child.stdin?.write(bytes); } catch { /* child closed stdin */ }
    },
    resize() { /* no-op: file engine has no PTY dims */ },
    onChunk(cb) { chunkSubs.add(cb); return () => chunkSubs.delete(cb); },
    onBoundary(cb) { boundarySubs.add(cb); return () => boundarySubs.delete(cb); },
    onStatus(cb) { statusSubs.add(cb); return () => statusSubs.delete(cb); },
    result,
  };

  // If stdin was provided, feed it now and close — common pattern
  // for non-interactive commands (echo "input" | cmd).
  if (req.stdin !== undefined) {
    try {
      child.stdin?.write(req.stdin);
      child.stdin?.end();
    } catch { /* ignore */ }
  }

  return handle;
}

// ── Stream sink — in-memory circular + disk spill ──

interface StreamSink {
  append(bytes: string): void;
  close(): void;
  /** Head-first serialization (up to `maxBytes`), with optional tail. */
  readonly allBytes: number;
  toStream(maxBytes: number): StreamOutput;
  readonly spillPath?: string;
}

function createStreamSink(
  kind: 'stdout' | 'stderr',
  maxMemoryBytes: number,
  tmpDirFn: () => string,
): StreamSink {
  const lines: string[] = [];
  let head = '';
  let tail = '';
  let allBytes = 0;
  let spillStream: WriteStream | null = null;
  let spillPath: string | undefined;
  let partialLine = '';

  const openSpill = () => {
    if (spillStream) return;
    const dir = mkdtempSync(join(tmpDirFn(), 'shell-runner-'));
    spillPath = join(dir, `${kind}.log`);
    spillStream = createWriteStream(spillPath, { encoding: 'utf8' });
    if (head) spillStream.write(head);
  };

  return {
    append(bytes) {
      allBytes += Buffer.byteLength(bytes, 'utf8');
      if (spillStream) {
        spillStream.write(bytes);
      } else if (allBytes > maxMemoryBytes) {
        openSpill();
        // Re-read the variable after openSpill() since tsc's
        // narrowing of `spillStream` is stale across the call.
        (spillStream as WriteStream | null)?.write(bytes);
      } else {
        head += bytes;
      }
      // Maintain a tail ring of CIRCULAR_LINE_LIMIT lines so
      // progress consumers get recent lines without slurping disk.
      const combined = partialLine + bytes;
      const parts = combined.split('\n');
      partialLine = parts.pop() ?? '';
      for (const line of parts) {
        lines.push(line);
        if (lines.length > CIRCULAR_LINE_LIMIT) lines.shift();
      }
      tail = [...lines, partialLine].join('\n');
    },
    close() {
      try { spillStream?.end(); } catch { /* ignore */ }
    },
    get allBytes() { return allBytes; },
    toStream(maxBytes) {
      if (allBytes <= maxBytes) {
        return { text: spillStream ? tail : head };
      }
      // Head + tail preserve halves when output exceeds the cap.
      const half = Math.floor(maxBytes / 2);
      const headBytes = spillStream
        ? tail.slice(0, half)
        : Buffer.from(head, 'utf8').subarray(0, half).toString('utf8');
      const tailBytes = spillStream
        ? tail.slice(Math.max(0, tail.length - half))
        : Buffer.from(head, 'utf8').subarray(Math.max(0, allBytes - half)).toString('utf8');
      return { text: headBytes, truncatedAfterBytes: half, tail: tailBytes };
    },
    get spillPath() { return spillPath; },
  };
}

function buildResult(
  stdout: StreamSink,
  stderr: StreamSink,
  aggregated: Array<{ bytes: string; ts: number }>,
  started: number,
  ended: number,
  meta: {
    exitCode: number | undefined;
    outcome: ShellResult['outcome'];
    timedOut: boolean;
    interrupted: boolean;
    spawnError?: string;
    maxOutputBytes: number;
    bookmark: BufferMark;
  },
): ShellResult {
  const agg = aggregated
    .sort((a, b) => a.ts - b.ts)
    .map(e => e.bytes)
    .join('');
  const aggCapped = capString(agg, meta.maxOutputBytes);
  const r: ShellResult = {
    ...(meta.exitCode !== undefined ? { exitCode: meta.exitCode } : {}),
    ...(meta.spawnError !== undefined ? { failureReason: meta.spawnError } : {}),
    stdout: stdout.toStream(meta.maxOutputBytes),
    stderr: stderr.toStream(meta.maxOutputBytes),
    aggregated: aggCapped,
    durationMs: Math.max(0, ended - started),
    timedOut: meta.timedOut,
    interrupted: meta.interrupted,
    truncated:
      aggCapped.truncatedAfterBytes !== undefined ||
      stdout.allBytes > meta.maxOutputBytes ||
      stderr.allBytes > meta.maxOutputBytes,
    outcome: meta.outcome,
    bookmarkId: `m${meta.bookmark.ts}`,
  };
  if (stdout.spillPath || stderr.spillPath) {
    r.outputFilePath = stdout.spillPath ?? stderr.spillPath;
  }
  return r;
}

function capString(s: string, maxBytes: number): StreamOutput {
  const size = Buffer.byteLength(s, 'utf8');
  if (size <= maxBytes) return { text: s };
  const half = Math.floor(maxBytes / 2);
  const buf = Buffer.from(s, 'utf8');
  return {
    text: buf.subarray(0, half).toString('utf8'),
    truncatedAfterBytes: half,
    tail: buf.subarray(size - half).toString('utf8'),
  };
}

function spawnChild(
  req: ShellRequest,
  spawnFn: typeof nodeSpawn,
): ChildProcessWithoutNullStreams {
  const spawnOpts: SpawnOptions = {
    cwd: req.cwd,
    env: req.env ? { ...process.env, ...req.env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  if (typeof req.command === 'string') {
    return spawnFn(
      requirePosixShell('/bin/bash'),
      ['-lc', req.command],
      spawnOpts,
    ) as ChildProcessWithoutNullStreams;
  }
  const [argv0, ...rest] = req.command as readonly string[];
  return spawnFn(argv0 ?? '', rest, spawnOpts) as ChildProcessWithoutNullStreams;
}

function resolveMode(mode: ShellMode | undefined): Exclude<ShellMode, 'auto'> {
  if (!mode || mode === 'auto') return 'inline';
  return mode;
}

function signalToNumber(signal: NodeJS.Signals): number {
  // Minimal mapping — matches bash's $? convention (128 + signal).
  const map: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9,
    SIGTERM: 15,
  };
  return map[signal] ?? 0;
}
