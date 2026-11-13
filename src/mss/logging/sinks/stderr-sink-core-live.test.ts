import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simCli } from '../../../ux-sim/in-process-cli.js';

type RecordLine = { category: string; event: string; level?: string };

function records(stderr: string): RecordLine[] {
  return stderr.split('\n').filter(Boolean).map((line) => {
    const record = JSON.parse(line) as RecordLine;
    if (typeof record.category !== 'string' || typeof record.event !== 'string') throw new Error('invalid stderr record');
    return record;
  });
}

function infoOnly(stderr: string): RecordLine[] {
  const parsed = records(stderr);
  if (parsed.some((line) => !['info', 'warn', 'error', 'critical'].includes(line.level ?? 'debug')))
    throw new Error('stderr contains a record below info');
  return parsed;
}

test('stderr assertion rejects non-JSON and unrelated debug records', () => {
  expect(() => infoOnly('not-json\n')).toThrow();
  expect(() => infoOnly('{"category":"other","event":"noise","level":"debug"}\n')).toThrow('below info');
});

test('core live stderr retains trace without a filter and suppresses it at info', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'a79-debug-leveling-'));
  try {
    const script = `
      const { debug } = await import('./src/debug/log.ts');
      for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'critical']) {
        debug.log('a79.core-live', 'marker-' + level, { probe: 'a79' }, { level });
      }
      debug.log('a79.core-live', 'marker-default-debug');
      debug.flush();
    `;
    const run = (level?: string) => spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir, MSS_STDERR_SINK: '1',
        ...(level ? { MSS_STDERR_LEVEL: level } : { MSS_STDERR_LEVEL: '' }) },
    });
    const unfiltered = run();
    const filtered = run('info');
    expect(unfiltered.status, unfiltered.stderr).toBe(0);
    expect(filtered.status, filtered.stderr).toBe(0);
    const markers = (stderr: string) => records(stderr).filter((line) => line.category === 'a79.core-live').map((line) => line.event);
    expect(markers(unfiltered.stderr)).toEqual(['marker-trace', 'marker-debug', 'marker-info', 'marker-warn', 'marker-error', 'marker-critical', 'marker-default-debug']);
    expect(infoOnly(filtered.stderr).map((line) => [line.event, line.level])).toEqual([
      ['marker-info', 'info'], ['marker-warn', 'warn'], ['marker-error', 'error'], ['marker-critical', 'critical'],
    ]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('actual repo public CLI noninteractive path obeys stderr level', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'a79-repo-cli-'));
  try {
    const run = (level?: string) => simCli(['repo', 'public'], {
      mode: 'spawn', allowPaths: [['repo', 'public']], cwd: process.cwd(), stateRoot: stateDir, timeoutMs: 30_000,
      env: { MSS_STDERR_SINK: '1', ...(level ? { MSS_STDERR_LEVEL: level } : { MSS_STDERR_LEVEL: '' }) },
    });
    const unfiltered = await run();
    const filtered = await run('info');
    expect(unfiltered.exitCode, unfiltered.stderr).toBe(0);
    expect(filtered.exitCode, filtered.stderr).toBe(0);
    expect(unfiltered.stdout).toContain('requires an interactive terminal');
    expect(filtered.stdout).toContain('requires an interactive terminal');
    const matches = (stderr: string) => records(stderr).filter((row) => row.category === 'repo-provision' && row.event === 'visibility-noninteractive');
    expect(matches(unfiltered.stderr)).toHaveLength(1);
    expect(infoOnly(filtered.stderr)).toEqual([]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
