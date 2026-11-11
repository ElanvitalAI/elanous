import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGateNode, type GateRunner } from '../../scripts/release-loop/gate-node.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

test('GATE-NO-WALLCLOCK-1: entry observation and failed verdict use the injected clock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-no-wallclock-'));
  const progressFile = join(root, 'progress.jsonl');
  // Source: the scenario advances the gate clock by 250 ms while the process clock stays untouched.
  const elapsedMs = 250;
  const epoch = Date.parse('2026-11-09T00:00:00.000Z');
  let now = epoch;
  const runner = { now: () => now } as GateRunner;
  const output = spyOn(console, 'log').mockImplementation(() => {});
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  setElanousConfigDir(root);
  try {
    const code = await runGateNode(
      ['--commit', 'a'.repeat(40), '--version', '1.0.1', '--baseline-version', '1.0.0', '--json'],
      { ELANOUS_GATE_PROGRESS_FILE: progressFile }, runner,
      async () => { now += elapsedMs; throw new Error('simulated gate failure'); },
    );
    expect(code).toBe(2);
    const events = readFileSync(progressFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event: string; at?: string });
    expect(events.find((event) => event.event === 'gate-startup')?.at).toBe(new Date(epoch).toISOString());
    const result = output.mock.calls.map(([line]) => {
      try { return JSON.parse(String(line)) as { durationMs?: number; outcome?: string }; }
      catch { return null; }
    }).find((entry) => entry?.durationMs !== undefined);
    expect(result).toMatchObject({ outcome: 'error', durationMs: elapsedMs });
  } finally {
    output.mockRestore();
    errors.mockRestore();
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});
