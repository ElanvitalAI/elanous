import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideAndRecordGateAutoheal, decideGateAutoheal, gateAutohealCause, GATE_AUTOHEAL_OVERALL_CAP_MS, GATE_AUTOHEAL_SHARD_CAP_MS, type GateAutohealCause } from './gate-autoheal.js';

test.each([
  ['shard-pod-death', 'reroute-shard'],
  ['timeout', 'retry-shard'],
  ['host-down', 'host-switch'],
  ['interference', 'partial-resume'],
  ['true-regression', 'hitl'],
  ['environment', 'hitl'],
] as const)('%s selects %s', (cause: GateAutohealCause, action) => {
  expect(decideGateAutoheal({ cause, signature: `sig:${cause}`, shardElapsedMs: 1_000, overallElapsedMs: 2_000 }).action).toBe(action);
});

test('repeat signature stops after the first attempted repair', () => {
  expect(decideGateAutoheal({ cause: 'timeout', signature: 'same', shardElapsedMs: 1, overallElapsedMs: 2, priorSameSignatureCount: 1 }))
    .toMatchObject({ action: 'hitl', reason: 'same incident signature repeated' });
});

test('run history stops a repeated signature across process calls', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-autoheal-ledger-'));
  try {
    const input = { cause: 'timeout' as const, signature: 'same', version: '1.2.3', runId: 'run/1', shardKey: 'shard-2', storeRoot: root, shardElapsedMs: 100, overallElapsedMs: 100 };
    expect(decideAndRecordGateAutoheal(input).action).toBe('retry-shard');
    expect(decideAndRecordGateAutoheal(input)).toMatchObject({ action: 'hitl', reason: 'same incident signature repeated' });
    expect(JSON.parse(readFileSync(join(root, 'release/1.2.3/gate-autoheal/run_1.json'), 'utf8'))).toMatchObject({ overallElapsedMs: 200, signatures: { 'shard-2:same': 2 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run history adds attempt duration against shard and total caps', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-autoheal-cap-'));
  try {
    const input = { cause: 'timeout' as const, signature: 'first', version: '1.2.3', runId: 'cap', shardKey: 'shard-0', storeRoot: root,
      shardElapsedMs: GATE_AUTOHEAL_SHARD_CAP_MS - 5, overallElapsedMs: GATE_AUTOHEAL_OVERALL_CAP_MS - 5 };
    expect(decideAndRecordGateAutoheal(input).action).toBe('retry-shard');
    expect(decideAndRecordGateAutoheal({ ...input, signature: 'second', shardElapsedMs: 10, overallElapsedMs: 10 }))
      .toMatchObject({ action: 'hitl', reason: 'per-shard timebox exceeded' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('multi-shard attempts charge each shard separately under the per-shard cap', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-autoheal-shards-'));
  try {
    const base = { cause: 'timeout' as const, version: '1.2.3', runId: 'multi', storeRoot: root, overallElapsedMs: 10 };
    expect(decideAndRecordGateAutoheal({ ...base, signature: 'first', shardKey: 'auto', shardKeys: ['1', '2'], shardElapsedMs: GATE_AUTOHEAL_SHARD_CAP_MS - 5 }).action).toBe('retry-shard');
    expect(decideAndRecordGateAutoheal({ ...base, signature: 'second', shardKey: '1', shardKeys: ['1'], shardElapsedMs: 10 }))
      .toMatchObject({ action: 'hitl', reason: 'per-shard timebox exceeded' });
    expect(JSON.parse(readFileSync(join(root, 'release/1.2.3/gate-autoheal/multi.json'), 'utf8')).shards)
      .toEqual({ '1': GATE_AUTOHEAL_SHARD_CAP_MS + 5, '2': GATE_AUTOHEAL_SHARD_CAP_MS - 5 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('measured regressions, Pod incidents and interference retain distinct causes', () => {
  expect(gateAutohealCause({ outcome: 'regression', introduced: ['src/a.test.ts'], durationMs: 10 })).toBe('true-regression');
  expect(gateAutohealCause({ outcome: 'error', durationMs: 10, stalledShards: [{ shard: 1, files: ['a'], reason: 'job-failed' }] })).toBe('environment');
  expect(gateAutohealCause({ outcome: 'error', durationMs: 10, stalledShards: [{ shard: 1, files: ['a'], reason: 'job-failed', detail: 'Pod evicted' }] })).toBe('shard-pod-death');
  expect(gateAutohealCause({ outcome: 'error', durationMs: 10, error: 'ssh host unreachable', stalledShards: [{ shard: 1, files: ['a'], reason: 'job-failed' }] })).toBe('host-down');
  expect(gateAutohealCause({ outcome: 'error', durationMs: 10, stalledShards: [{ shard: 1, files: ['a'], reason: 'exit-code' }] })).toBe('environment');
  expect(gateAutohealCause({ outcome: 'error', durationMs: 10, stalledShards: [{ shard: 1, files: ['a'], reason: 'timeout' }] })).toBe('timeout');
  expect(gateAutohealCause({ outcome: 'error', durationMs: 10, interferenceErrors: ['src/a.test.ts'] })).toBe('interference');
  expect(gateAutohealCause({ outcome: 'error', durationMs: 10, error: 'ssh host unreachable' })).toBe('host-down');
  expect(gateAutohealCause({ outcome: 'ok', durationMs: 10 })).toBeUndefined();
});

test('an introduced regression is HITL and never gets a retry, reroute, partial resume or waiver action', () => {
  const cause = gateAutohealCause({ outcome: 'regression', introduced: ['src/product.test.ts > regressed'], durationMs: 5_000 });
  expect(cause).toBe('true-regression');
  const decision = decideGateAutoheal({ cause: cause!, signature: 'introduced-regression', shardElapsedMs: 5_000, overallElapsedMs: 5_000 });
  expect(decision.action).toBe('hitl');
  expect(['retry-shard', 'reroute-shard', 'partial-resume', 'host-switch', 'waive']).not.toContain(decision.action);
});

test.each([
  [GATE_AUTOHEAL_SHARD_CAP_MS, 0, 'per-shard timebox exceeded'],
  [0, GATE_AUTOHEAL_OVERALL_CAP_MS, 'overall timebox exceeded'],
] as const)('timebox breach goes to HITL', (shardElapsedMs, overallElapsedMs, reason) => {
  expect(decideGateAutoheal({ cause: 'timeout', signature: 'sig', shardElapsedMs, overallElapsedMs })).toMatchObject({ action: 'hitl', reason });
});
