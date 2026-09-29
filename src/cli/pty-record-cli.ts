import type { Command } from 'commander';
import { getPty, listPty } from '../pty-shell/registry.js';
import { listPtyManifest } from '../pty-shell/pty-manifest.js';
import { resolvePtyRef } from '../pty-shell/pty-ref.js';
import { requestRemotePtyControl } from '../pty-shell/pty-control-ipc.js';
import { startPtyRecording, stopPtyRecording } from '../pty-shell/pty-recording.js';

export interface PtyRecordDeps {
  readonly local: typeof getPty;
  readonly refs: () => readonly { id: string; kind: string; nickname?: string }[];
  readonly remote: typeof requestRemotePtyControl;
  readonly start: typeof startPtyRecording;
  readonly stop: typeof stopPtyRecording;
}

const liveDeps: PtyRecordDeps = {
  local: getPty,
  refs: () => [
    ...listPty().filter((handle) => handle.isAlive()).map(({ id, kind, nickname }) => ({ id, kind, nickname })),
    ...listPtyManifest().filter((row) => row.alive && !getPty(row.id)).map(({ id, kind, nickname }) => ({ id, kind, nickname })),
  ],
  remote: requestRemotePtyControl,
  start: startPtyRecording,
  stop: stopPtyRecording,
};

export async function runPtyRecord(ref: string, options: { stop?: boolean; json?: boolean } = {}, deps: PtyRecordDeps = liveDeps): Promise<{ exitCode: 0 | 1; message: string }> {
  const resolution = resolvePtyRef(ref, deps.refs());
  if (!resolution.match) {
    const reason = resolution.reason === 'ambiguous'
      ? `ambiguous ref; candidates: ${resolution.candidates.map((item) => item.id).join(', ')}`
      : 'PTY not found';
    return { exitCode: 1, message: options.json ? JSON.stringify({ ok: false, reason }) : `pty record: ${ref}: ${reason}` };
  }
  const id = resolution.match.id;
  const handle = deps.local(id);
  const result = handle?.isAlive()
    ? options.stop ? deps.stop(id) : deps.start(id, { cols: handle.cols, rows: handle.rows })
    : await deps.remote(id, options.stop ? 'record-stop' : 'record-start');
  const ok = 'ok' in result ? result.ok : 'status' in result && result.status === 'success' && typeof result.path === 'string';
  const reason = !ok ? ('reason' in result ? result.reason : 'status' in result && result.status !== 'success' ? result.status : 'invalid-record-result') : undefined;
  const payload = { ok, ptyId: id, ...('path' in result && result.path ? { path: result.path } : {}),
    ...('recordingId' in result && result.recordingId ? { recordingId: result.recordingId } : {}),
    ...('bytes' in result && result.bytes !== undefined ? { bytes: result.bytes } : {}),
    ...('durationMs' in result && result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(reason ? { reason } : {}) };
  const message = options.json ? JSON.stringify(payload) : ok
    ? `${payload.path}${'bytes' in payload ? ` (${payload.bytes} bytes, ${payload.durationMs} ms)` : ''}`
    : `pty record: ${id}: ${reason}`;
  return { exitCode: ok ? 0 : 1, message };
}

export function registerPtyRecordCommand(pty: Command, deps: PtyRecordDeps = liveDeps): void {
  pty.command('record <ref>')
    .description('Record PTY output as asciicast v2; --stop saves the capture')
    .option('--stop', 'stop recording and save the cast')
    .option('--json', 'emit structured result')
    .action(async (ref: string, options: { stop?: boolean; json?: boolean }) => {
      const result = await runPtyRecord(ref, options, deps);
      (result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.message}\n`);
      process.exitCode = result.exitCode;
    });
}
