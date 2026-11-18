// ── LogSink abstraction (MSS M2.2 Phase A1) ──
//
// Pluggable destinations for LogRecord events. The `DebugLog` singleton
// (`src/debug/log.ts`) owns three built-in sinks — `FileSink`, `RingSink`,
// `MirrorSink` — and accepts external `LogSink` implementations via
// `debug.registerSink(sink)`. M2.2 Phase A2 adds `StderrSink` as the first
// opt-in external sink.
//
// Design invariants:
//   • `emit()` MUST NOT throw. Sinks run synchronously on the caller's
//     thread — a propagated error would break every instrumented site.
//     The DebugLog dispatcher wraps `emit` in `try/catch` as defense-in-
//     depth; implementations still absorb their own I/O failures.
//   • The shape here is intentionally narrow. Keep richer state
//     (capacity, paths, byte counters) on the concrete sink class and
//     expose it via class-specific getters, not the shared interface.
//
// Extraction scope: field/method ownership moves from `DebugLog` to
// these classes, but visible behaviour (batch thresholds, rotation
// cadence, symlink creation, exit-handler install) is preserved
// byte-for-byte. Pre-extraction tests keep passing without modification.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

import type { LogRecord } from './record.js';

export interface LogSink {
  readonly name: string;
  emit(rec: LogRecord): void;
  flush?(): void;
  clear?(): void;
}

// ── RingSink ───────────────────────────────────────────────────────

/** In-memory ring buffer. Backs `debug.tail()` / `debug.events()` so
 *  `/debug tail` works even when the file sink is off or its writes
 *  failed (read-only fs, permissions). Always populated whenever
 *  DebugLog decides at least one sink wants the event. */
export class RingSink implements LogSink {
  readonly name = 'ring';
  private _buf: LogRecord[] = [];
  private _cap: number;

  constructor(cap: number = 500) {
    this._cap = Math.max(1, cap);
  }

  emit(rec: LogRecord): void {
    this._buf.push(rec);
    if (this._buf.length > this._cap) {
      this._buf.splice(0, this._buf.length - this._cap);
    }
  }

  /** Last N entries (oldest first). Returns a copy so callers can mutate. */
  events(n: number = Number.POSITIVE_INFINITY): LogRecord[] {
    if (!Number.isFinite(n)) return this._buf.slice();
    return this._buf.slice(-Math.max(1, n));
  }

  clear(): void {
    this._buf = [];
  }

  get length(): number { return this._buf.length; }
  get capacity(): number { return this._cap; }
}

// ── MirrorSink ─────────────────────────────────────────────────────

export type FormatFn = (rec: LogRecord) => string;
export type MirrorHook = (line: string) => void;

/** Formats records into a one-line string and dispatches to a registered
 *  hook. The dashboard wires a closure over `chatLines` when the user
 *  toggles `/debug mirror on`. `emit()` is a no-op when no hook is
 *  registered — the gating of *whether* mirror dispatch should run is
 *  kept on `DebugLog` (via `_mirrorEnabled`), matching the pre-
 *  extraction call path. */
export class MirrorSink implements LogSink {
  readonly name = 'mirror';
  private _hook: MirrorHook | null = null;
  private _format: FormatFn;

  constructor(format: FormatFn) {
    this._format = format;
  }

  setHook(hook: MirrorHook | null): void {
    this._hook = hook;
  }

  hasHook(): boolean {
    return this._hook !== null;
  }

  emit(rec: LogRecord): void {
    if (!this._hook) return;
    try { this._hook(this._format(rec)); } catch { /* swallow */ }
  }
}

// ── FileSink ───────────────────────────────────────────────────────

export interface FileSinkOptions {
  /** Directory containing the active log file (mkdir -p on each flush). */
  logDir: string;
  /** Initial absolute path to the active log file. */
  filePath: string;
  /** Timer-based flush cadence. Default 100 ms. */
  flushIntervalMs?: number;
  /** Count threshold that detaches the current batch and writes on the
   *  next macrotask so hot-path ticks (render, keystroke) do not block on
   *  `appendFileSync`. Default 32. */
  flushBatchSize?: number;
  /** Bytes threshold for the same detach-and-defer path. Guards against
   *  a single large payload (LLM streaming chunk) sitting in memory for a
   *  full 100 ms window just because event count is low. Default 64 KiB. */
  flushBatchBytes?: number;
  /** Size-based rotation threshold. Default 10 MiB. */
  maxFileBytes?: number;
  /** Rotated backups to keep. Default 3 (bounded at ~MAX × (KEEP+1)). */
  rotationKeep?: number;
  /** Register beforeExit / SIGINT / SIGTERM flush hooks lazily on first
   *  emit. Default true; tests/isolated fixtures can pass false. */
  installExitHandlers?: boolean;
  /** Optional category filter — when set, only records whose
   *  `category` matches the regex are appended to this file. Used to
   *  carve a chat-only mirror (`log/latest_chat`) out of the firehose
   *  so debugging the conversation flow doesn't require grepping
   *  through input-core / focus-manager / mouse noise. Undefined =
   *  accept everything (legacy behaviour). */
  categoryPattern?: RegExp;
  /** Symlink basename created inside `logDir` once the first byte
   *  successfully lands. Defaults to `'latest'` for backward
   *  compatibility. The chat-only sink uses `'latest_chat'`. */
  symlinkName?: string;
}

/** Forensic on-disk sink. Owns the buffered-write batching, file
 *  rotation, `latest` symlink, and exit-flush hooks that used to live
 *  directly on `DebugLog`. Behaviour parity with the pre-extraction
 *  code is a design invariant — thresholds, rotation cascade, symlink
 *  memoisation, and the setImmediate detach path all match byte-for-
 *  byte. */
export class FileSink implements LogSink {
  readonly name = 'file';
  private _enabled: boolean;
  private _pendingWrites: string[] = [];
  private _pendingBytes = 0;
  private _pendingOverflow: string[] | null = null;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _exitHandlersInstalled = false;
  private _file: string;
  private _logDir: string;
  private _bytesWritten = 0;
  private _maxFileBytes: number;
  private _rotationKeep: number;
  private _flushIntervalMs: number;
  private _flushBatchSize: number;
  private _flushBatchBytes: number;
  private _latestSymlinkCreated = false;
  private _installExit: boolean;
  private _categoryPattern: RegExp | null;
  private _symlinkName: string;

  constructor(opts: FileSinkOptions, enabled: boolean = true) {
    this._logDir = opts.logDir;
    this._file = opts.filePath;
    this._enabled = enabled;
    this._flushIntervalMs = opts.flushIntervalMs ?? 100;
    this._flushBatchSize = opts.flushBatchSize ?? 32;
    this._flushBatchBytes = opts.flushBatchBytes ?? 64 * 1024;
    this._maxFileBytes = opts.maxFileBytes ?? 10 * 1024 * 1024;
    this._rotationKeep = opts.rotationKeep ?? 3;
    this._installExit = opts.installExitHandlers ?? true;
    this._categoryPattern = opts.categoryPattern ?? null;
    this._symlinkName = opts.symlinkName ?? 'latest';
  }

  isEnabled(): boolean { return this._enabled; }
  setEnabled(on: boolean): void {
    if (this._enabled && !on) this.flush();
    this._enabled = on;
  }

  path(): string { return this._file; }
  bytesWritten(): number { return this._bytesWritten; }
  setMaxFileBytes(bytes: number): void {
    this._maxFileBytes = bytes > 0 ? bytes : Number.POSITIVE_INFINITY;
  }

  emit(rec: LogRecord): void {
    if (!this._enabled) return;
    if (this._categoryPattern && !this._categoryPattern.test(rec.category)) return;
    const line = JSON.stringify(rec) + '\n';
    this._pendingWrites.push(line);
    this._pendingBytes += Buffer.byteLength(line, 'utf8');
    if (this._installExit) this._installExitHandlersOnce();
    if (
      this._pendingWrites.length >= this._flushBatchSize ||
      this._pendingBytes >= this._flushBatchBytes
    ) {
      this._flushDeferred();
    } else if (this._flushTimer === null) {
      this._flushTimer = setTimeout(() => this.flush(), this._flushIntervalMs);
      if (typeof (this._flushTimer as { unref?: () => void }).unref === 'function') {
        (this._flushTimer as unknown as { unref: () => void }).unref();
      }
    }
  }

  flush(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    // Drain overflow batch first so ordering matches emit sequence.
    const overflow = this._pendingOverflow;
    this._pendingOverflow = null;
    if (this._pendingWrites.length === 0 && !overflow) return;
    const bulk = (overflow ? overflow.join('') : '') + this._pendingWrites.join('');
    this._pendingWrites = [];
    this._pendingBytes = 0;
    if (!this._enabled || bulk.length === 0) return;
    try {
      mkdirSync(this._logDir, { recursive: true });
      appendFileSync(this._file, bulk);
      this._bytesWritten += Buffer.byteLength(bulk, 'utf8');
      this._maybeCreateLatestSymlink();
      this._rotateIfNeeded();
    } catch { /* disk full / readonly — ring buffer still valid */ }
  }

  /** Detach current batch onto a setImmediate so the hot-path tick stays
   *  short. Concurrent overflows coalesce into the same detached buffer. */
  private _flushDeferred(): void {
    if (this._pendingWrites.length === 0) return;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._pendingOverflow) {
      for (const s of this._pendingWrites) this._pendingOverflow.push(s);
      this._pendingWrites = [];
      this._pendingBytes = 0;
      return;
    }
    const detached = this._pendingWrites;
    this._pendingWrites = [];
    this._pendingBytes = 0;
    this._pendingOverflow = detached;
    setImmediate(() => {
      const toWrite = this._pendingOverflow;
      this._pendingOverflow = null;
      if (!toWrite || toWrite.length === 0) return;
      if (!this._enabled) return;
      try {
        mkdirSync(this._logDir, { recursive: true });
        const bulk = toWrite.join('');
        appendFileSync(this._file, bulk);
        this._bytesWritten += Buffer.byteLength(bulk, 'utf8');
        this._maybeCreateLatestSymlink();
        this._rotateIfNeeded();
      } catch { /* swallow */ }
    });
  }

  clear(): void {
    this._pendingWrites = [];
    this._pendingBytes = 0;
    this._pendingOverflow = null;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._latestSymlinkCreated = false;
    if (!this._enabled) return;
    try {
      mkdirSync(this._logDir, { recursive: true });
      writeFileSync(this._file, '');
      this._bytesWritten = 0;
    } catch { /* swallow */ }
  }

  /** Flush and read back the active file. Empty string on read failure —
   *  caller falls back to ring buffer. */
  readFile(): string {
    this.flush();
    try {
      if (existsSync(this._file)) return readFileSync(this._file, 'utf8');
    } catch { /* fallthrough */ }
    return '';
  }

  private _rotateIfNeeded(): void {
    if (this._bytesWritten < this._maxFileBytes) return;
    const file = this._file;
    const dotLog = file.lastIndexOf('.log');
    const base = dotLog >= 0 ? file.slice(0, dotLog) : file;
    try {
      try { unlinkSync(`${base}.${this._rotationKeep}.log`); } catch { /* not there */ }
      for (let i = this._rotationKeep - 1; i >= 1; i--) {
        try { renameSync(`${base}.${i}.log`, `${base}.${i + 1}.log`); } catch { /* not there */ }
      }
      renameSync(file, `${base}.1.log`);
      this._bytesWritten = 0;
    } catch { /* leave in place */ }
  }

  private _maybeCreateLatestSymlink(): void {
    if (this._latestSymlinkCreated) return;
    const latest = join(this._logDir, this._symlinkName);
    try {
      try { unlinkSync(latest); } catch { /* not there */ }
      symlinkSync(this._file, latest);
      this._latestSymlinkCreated = true;
    } catch { /* permissions / non-POSIX fs — skip */ }
  }

  private _installExitHandlersOnce(): void {
    if (this._exitHandlersInstalled) return;
    this._exitHandlersInstalled = true;
    const onExit = (): void => { this.flush(); };
    process.once('beforeExit', onExit);
    // Remove only this sink's listener. Re-raise only when nobody else is
    // listening so the default terminate action is restored; remaining
    // handlers already run in the current dispatch (re-raising would run
    // them a second time). `removeAllListeners` would wipe them.
    // Prepend so an earlier `process.once` listener still counts (see log-store.ts).
    const install = (signal: NodeJS.Signals): void => {
      const onSig = (): void => {
        onExit();
        process.removeListener(signal, onSig);
        if (process.listenerCount(signal) === 0) {
          process.kill(process.pid, signal);
        }
      };
      process.prependListener(signal, onSig);
    };
    install('SIGINT');
    install('SIGTERM');
  }
}
