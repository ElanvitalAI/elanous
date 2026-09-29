import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { PreviewTerminal } from '../preview/terminal.js';
import type { AcpServerHandle } from '../acp/server.js';
import { registerPtyRecordCommand, runPtyRecord, type PtyRecordDeps } from './pty-record-cli.js';

function deps(): PtyRecordDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    refs: () => [{ id: 'shell_abcd1234', kind: 'shell', nickname: 'demo' }],
    local: () => undefined,
    remote: async (id, action) => {
      calls.push(`${id}:${action}`);
      return action === 'record-start'
        ? { status: 'success', recordingId: 'rec-1', path: '/tmp/rec.cast' }
        : { status: 'success', path: '/tmp/rec.cast', bytes: 123, durationMs: 25 };
    },
    start: () => ({ ok: true, recordingId: 'local', path: '/tmp/local.cast' }),
    stop: () => ({ ok: true, path: '/tmp/local.cast', bytes: 6, durationMs: 20 }),
  };
}

test('remote ref start/stop use owner actions; JSON and text include path, bytes and duration', async () => {
  const d = deps();
  expect(JSON.parse((await runPtyRecord('demo', { json: true }, d)).message))
    .toEqual({ ok: true, ptyId: 'shell_abcd1234', path: '/tmp/rec.cast', recordingId: 'rec-1' });
  expect((await runPtyRecord('shell_abcd', { stop: true }, d)).message).toBe('/tmp/rec.cast (123 bytes, 25 ms)');
  expect(d.calls).toEqual(['shell_abcd1234:record-start', 'shell_abcd1234:record-stop']);
});

test('local handle uses current dimensions; failures do not print success paths', async () => {
  const d = deps();
  let dimensions: unknown;
  const localDeps: PtyRecordDeps = {
    ...d,
    local: (() => ({ isAlive: () => true, cols: 111, rows: 33 })) as unknown as PtyRecordDeps['local'],
    start: (_, options) => { dimensions = options; return { ok: false, reason: 'already-recording' }; },
  };
  const failed = await runPtyRecord('demo', { json: true }, localDeps);
  expect(dimensions).toEqual({ cols: 111, rows: 33 });
  expect(failed.exitCode).toBe(1);
  expect(JSON.parse(failed.message)).toEqual({ ok: false, ptyId: 'shell_abcd1234', reason: 'already-recording' });
  expect(d.calls).toEqual([]);
  expect((await runPtyRecord('absent', {}, d)).exitCode).toBe(1);
});

test('an owner success without a recording path is rejected rather than printed as undefined', async () => {
  const d = deps();
  const invalid: PtyRecordDeps = { ...d, remote: async () => ({ status: 'success' }) };
  expect(JSON.parse((await runPtyRecord('demo', { json: true }, invalid)).message))
    .toEqual({ ok: false, ptyId: 'shell_abcd1234', reason: 'invalid-record-result' });
});

test('Commander registers record under pty and dispatches stop', async () => {
  const program = new Command();
  const pty = program.command('pty');
  const d = deps();
  registerPtyRecordCommand(pty, d);
  const previous = process.stdout.write;
  const lines: string[] = [];
  try {
    process.stdout.write = ((chunk: string) => { lines.push(chunk); return true; }) as typeof process.stdout.write;
    await program.parseAsync(['node', 'elanous', 'pty', 'record', 'demo', '--stop']);
    expect(lines.join('')).toBe('/tmp/rec.cast (123 bytes, 25 ms)\n');
    expect(d.calls).toEqual(['shell_abcd1234:record-stop']);
  } finally {
    process.stdout.write = previous;
    process.exitCode = 0;
  }
});

test('default web terminal exposes owner control, preserves ACP output, and records raw bytes via pty CLI', async () => {
  const state = mkdtempSync(join(tmpdir(), 'webterm-pty-record-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = state;
  const { registerPreviewTerminalForWebTap, unregisterPreviewTerminalForWebTap, __resetPreviewTapRegistry } = await import('../web-terminal/preview-tap-registry.js');
  const { listPtyManifest, setPtyManifestDbPathForTesting } = await import('../pty-shell/pty-manifest.js');
  const { processPtyControlRequests, resetPtyControlIpcForTesting } = await import('../pty-shell/pty-control-ipc.js');
  const { getPtyControlTarget } = await import('../pty-shell/registry.js');
  const { startWebTerminalRecording, stopWebTerminalRecording } = await import('../web-terminal/recording-registry.js');
  const taps = new Set<(chunk: string) => void>();
  const pt = {
    pid: process.pid, cols: 92 /* a live pid: the manifest reaps rows whose pty pid is gone */, rows: 28, isAlive: true,
    write: () => {}, resize: () => {},
    addRawOutputTap(cb: (chunk: string) => void) { taps.add(cb); return () => { taps.delete(cb); }; },
  } as unknown as PreviewTerminal;
  const broadcast: string[] = [];
  const owner = { terminalOutput: async (_sid: string, _tid: string, chunk: string) => { broadcast.push(chunk); } } as unknown as AcpServerHandle;
  try {
    const detachSid = registerPreviewTerminalForWebTap(pt, 'sid', 'tab', owner);
    const [row] = listPtyManifest().filter((item) => item.kind === 'webterm');
    expect(row).toMatchObject({ id: `webterm:tab:${pt.pid}`, alive: true });
    const legacy = startWebTerminalRecording('sid', 'tab', { baseDir: join(state, 'legacy') });
    const start = runPtyRecord(row!.id, { json: true });
    await Bun.sleep(60);
    await processPtyControlRequests(getPtyControlTarget, () => false);
    const started = JSON.parse((await start).message) as { ok: boolean; path: string };
    expect(started.ok).toBe(true);
    for (const tap of taps) tap('hello');
    await Bun.sleep(20);
    for (const tap of taps) tap('hello');
    const stop = runPtyRecord(row!.id, { stop: true, json: true });
    await Bun.sleep(60);
    await processPtyControlRequests(getPtyControlTarget, () => false);
    const stopped = JSON.parse((await stop).message) as { ok: boolean; path: string; bytes: number; durationMs: number };
    expect(stopped).toMatchObject({ ok: true, path: started.path, bytes: expect.any(Number), durationMs: expect.any(Number) });
    expect(readFileSync(started.path, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line)).slice(1).map((frame: unknown[]) => frame.slice(1)))
      .toEqual([['o', 'hello'], ['o', 'hello']]);
    expect(broadcast).toEqual(['hello', 'hello']);
    const legacyStopped = stopWebTerminalRecording('sid', 'tab');
    expect(legacyStopped.recorderId).toBe(legacy.recorderId);
    expect(readFileSync(legacyStopped.path, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line)).slice(1).map((frame: unknown[]) => frame.slice(1)))
      .toEqual([['o', 'hello'], ['o', 'hello']]);
    const auto = runPtyRecord(row!.id, { json: true });
    await Bun.sleep(60);
    await processPtyControlRequests(getPtyControlTarget, () => false);
    const autoStarted = JSON.parse((await auto).message) as { ok: boolean; path: string };
    expect(autoStarted.ok).toBe(true);
    detachSid();
    expect(existsSync(autoStarted.path)).toBe(false);
    expect(listPtyManifest().find((item) => item.id === row!.id)?.alive).toBe(true);
    for (const tap of taps) tap('exit-output');
    unregisterPreviewTerminalForWebTap(pt);
    expect(existsSync(autoStarted.path)).toBe(true);
    expect(readFileSync(autoStarted.path, 'utf8')).toContain('"o","exit-output"');
    expect(listPtyManifest().find((item) => item.id === row!.id)?.alive).toBe(false);
  } finally {
    __resetPreviewTapRegistry();
    resetPtyControlIpcForTesting();
    setPtyManifestDbPathForTesting(null);
    rmSync(state, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
  }
});

test('real CLI entry exposes pty record below pty', () => {
  const result = spawnSync(process.execPath, ['bin/elanous.mjs', '--test', 'pty', 'record', '--help'], {
    cwd: join(import.meta.dir, '../..'), env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30_000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--stop');
  expect(result.stdout).toContain('--json');
});
