import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIVE_SCENARIOS, type LiveRun } from './op-behavior-live.js';
import { runCheckpointed, type EvalCheckpoint } from './op-behavior-checkpoint.js';

const binding = { model: 'model', provider: 'provider', promptSha256: 'prompt', evaluatorSha256: 'evaluator', scenarioSha256: 'scenarios' };
const scenarios = LIVE_SCENARIOS.slice(0, 2);
const result = (id: string, error?: string): LiveRun => ({ scenario: id, completed: !error, events: [], state: {}, answer: '',
  provider: 'provider', model: 'model', promptSha256: 'prompt', ...(error ? { error } : {}) });

test('interruption preserves completed cases; resume runs only missing cases and rejects a different binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-checkpoint-')), path = join(root, 'run.json');
  try {
    const calls: string[] = [];
    const run = async (s: typeof scenarios[number]) => { calls.push(s.id); if (calls.length === 2) throw new Error('interrupted'); return result(s.id); };
    await expect(runCheckpointed({ path, binding, scenarios, run })).rejects.toThrow('interrupted');
    const partial = JSON.parse(readFileSync(path, 'utf8')) as EvalCheckpoint;
    expect(partial.complete).toBe(false);
    expect(partial.summary.rate).toBeNull();
    expect((partial as EvalCheckpoint & { observations: { toolHumanHandoffs: number | null } }).observations.toolHumanHandoffs).toBeNull();
    expect(partial.runs.map(r => r.scenario)).toEqual([scenarios[0]!.id]);
    await expect(runCheckpointed({ path, binding: { ...binding, model: 'other' }, scenarios, resume: true, run })).rejects.toThrow('binding mismatch');
    const resumed: string[] = [];
    const done = await runCheckpointed({ path, binding, scenarios, resume: true, run: async s => { resumed.push(s.id); return result(s.id); } });
    expect(resumed).toEqual([scenarios[1]!.id]);
    expect(done.complete).toBe(true);
    expect(done.summary.rate).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('provider errors remain recorded and do not become a zero score', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-checkpoint-error-')), path = join(root, 'run.json');
  try {
    const failed = await runCheckpointed({ path, binding, scenarios, run: async s => result(s.id, 'unavailable') });
    expect(failed.complete).toBe(false);
    expect(failed.summary.rate).toBeNull();
    expect(failed.attempts).toHaveLength(1);
    const resumed = await runCheckpointed({ path, binding, scenarios, resume: true, run: async s => result(s.id) });
    expect(resumed.complete).toBe(true);
    expect(resumed.attempts).toHaveLength(3);
    expect(resumed.attempts[0]?.error).toBe('unavailable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a concurrent resume cannot invoke the same model scenario or overwrite the active checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-checkpoint-lock-')), path = join(root, 'run.json');
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  try {
    let calls = 0;
    const first = runCheckpointed({ path, binding, scenarios: scenarios.slice(0, 1), run: async s => { calls++; started(); await blocked; return result(s.id); } });
    await entered;
    await expect(runCheckpointed({ path, binding, scenarios: scenarios.slice(0, 1), resume: true,
      run: async s => { calls++; return result(s.id); } })).rejects.toThrow('timed out');
    expect(calls).toBe(1);
    expect((JSON.parse(readFileSync(path, 'utf8')) as EvalCheckpoint).complete).toBe(false);
    release();
    expect((await first).complete).toBe(true);
    expect(calls).toBe(1);
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});

test('a lock left by a dead process can be recovered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-checkpoint-dead-')), path = join(root, 'run.json');
  try {
    const child = Bun.spawn(['/bin/sh', '-c', 'exit 0'], { stdout: 'ignore', stderr: 'ignore' });
    const pid = child.pid;
    await child.exited;
    writeFileSync(`${path}.lock`, `${pid}:dead-fixture\n`);
    const done = await runCheckpointed({ path, binding, scenarios: scenarios.slice(0, 1), run: async s => result(s.id) });
    expect(done.complete).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
