import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { createRecorder } from '../capture/recorder.js';
import { getRecordingStore } from '../capture/recording-store.js';
import type { RecorderHandle } from '../capture/types.js';
import { debug } from '../debug/log.js';

interface ActiveRecording {
  readonly recordingId: string;
  readonly path: string;
  readonly handle: RecorderHandle;
  readonly startedAt: number;
}

const active = new Map<string, ActiveRecording>();

export type StartPtyRecordingResult =
  | { readonly ok: true; readonly recordingId: string; readonly path: string }
  | { readonly ok: false; readonly reason: 'already-recording' };
export type StopPtyRecordingResult =
  | { readonly ok: true; readonly path: string; readonly bytes: number; readonly durationMs: number }
  | { readonly ok: false; readonly reason: 'not-recording' };

/** A process-local output tap; the capture store is shared with other recording hosts. */
export function startPtyRecording(ptyId: string, opts: { cols: number; rows: number; title?: string }): StartPtyRecordingResult {
  if (active.has(ptyId)) return { ok: false, reason: 'already-recording' };
  if (!Number.isSafeInteger(opts.cols) || opts.cols < 1 || !Number.isSafeInteger(opts.rows) || opts.rows < 1) {
    throw new Error('invalid PTY recording dimensions');
  }
  const startedAt = Date.now();
  const directory = join(elanousStateRoot(), 'recordings');
  const safeId = ptyId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  let timestamp = startedAt;
  let path = join(directory, `pty-${safeId}-${timestamp}.cast`);
  while (existsSync(path) || [...active.values()].some((entry) => entry.path === path)) {
    path = join(directory, `pty-${safeId}-${++timestamp}.cast`);
  }
  const handle = createRecorder({ dims: { cols: opts.cols, rows: opts.rows }, ...(opts.title === undefined ? {} : { title: opts.title }) });
  handle.start();
  const entry = getRecordingStore().start({ handle, encoder: 'asciicast', source: { surfaceLabel: `pty:${ptyId}` } });
  active.set(ptyId, { recordingId: entry.id, path, handle, startedAt });
  debug.log('pty.record', 'start', { ptyId, path, bytes: 0 });
  return { ok: true, recordingId: entry.id, path };
}

export function tapPtyOutput(ptyId: string, chunk: string): void {
  active.get(ptyId)?.handle.write(chunk, 'o');
}

function finish(ptyId: string, event: 'stop' | 'auto-stop' | 'auto-stop-recovered', path?: string): StopPtyRecordingResult {
  const entry = active.get(ptyId);
  if (!entry) return { ok: false, reason: 'not-recording' };
  const target = path ?? entry.path;
  const body = entry.handle.serialize();
  mkdirSync(dirname(target), { recursive: true });
  // Atomic save: write a temp file, then rename. A failed write leaves no partial cast at the
  // target path and keeps the recording active, so the caller can retry the stop.
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, body, { encoding: 'utf8', flag: 'w' });
    renameSync(temp, target);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    debug.log('pty.record', 'save-error', { ptyId, path: target, error: String(error) });
    throw error;
  }
  // The cast is on disk from here: the recording is finished whatever the bookkeeping below does,
  // otherwise a retry would find nothing to stop and the store would keep an active row forever.
  active.delete(ptyId);
  const bytes = Buffer.byteLength(body, 'utf8');
  const durationMs = Date.now() - entry.startedAt;
  closeBookkeeping(ptyId, entry, target);
  debug.log('pty.record', event, { ptyId, path: target, bytes });
  return { ok: true, path: target, bytes, durationMs };
}

function closeBookkeeping(ptyId: string, entry: ActiveRecording, artifactPath: string | undefined): void {
  try { entry.handle.stop(); }
  catch (error) { debug.log('pty.record', 'handle-stop-error', { ptyId, error: String(error) }); }
  try { getRecordingStore().markStopped(entry.recordingId, artifactPath ? { artifactPath } : {}); }
  catch (error) { debug.log('pty.record', 'mark-stopped-error', { ptyId, error: String(error) }); }
}

export function stopPtyRecording(ptyId: string): StopPtyRecordingResult {
  return finish(ptyId, 'stop');
}

/** Called on PTY exit (and on unregister when exit was never delivered). Nothing can call
 *  `--stop` on a PTY that is gone, so a failed save is retried once at a recovery path through the
 *  same atomic save and close-out; if that fails too the recording is closed with the loss on record
 *  — it never stays active with no way out. */
export function autoStopPtyRecording(ptyId: string): StopPtyRecordingResult {
  try {
    return finish(ptyId, 'auto-stop');
  } catch (error) {
    const entry = active.get(ptyId);
    if (!entry) throw error;
    try {
      return finish(ptyId, 'auto-stop-recovered', `${entry.path}.recovered`);
    } catch (retryError) {
      active.delete(ptyId);
      closeBookkeeping(ptyId, entry, undefined);
      debug.log('pty.record', 'auto-stop-save-failed', { ptyId, path: entry.path, error: String(error), retryError: String(retryError) });
      throw retryError;
    }
  }
}
