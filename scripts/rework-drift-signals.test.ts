import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refuseProductionLedgerWriteInTest } from '../src/harness/ledger-write-guard.js';
import { analyzeRunDriftSignals, renderReworkDriftSignals, runReworkDriftSignals, scanReworkDriftSignals } from './rework-drift-signals.js';
import type { RunLedgerEntry } from '../src/self-implement/run-ledger.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'rework-drift-signals-'));
  roots.push(path);
  return path;
}

function entry(runId: string, event: string, data: Record<string, unknown>): RunLedgerEntry {
  return { runId, event, data };
}

function ledger(runId: string, mustFix: readonly number[]): RunLedgerEntry[] {
  return mustFix.flatMap((count, index) => [
    entry(runId, 'reviewed', { round: index + 1, mustFix: count }),
    entry(runId, 'rework-budget', { round: index + 1, verdict: 'EXTEND', effectiveMaxBefore: index + 1, effectiveMaxAfter: index + 2 }),
  ]);
}

function writeLedger(dir: string, runId: string, entries: readonly RunLedgerEntry[]): string {
  const path = join(dir, `${runId}.jsonl`);
  writeFileSync(path, `${entries.map((value) => JSON.stringify(value)).join('\n')}\n`);
  return path;
}

test('drift reader remains read-only while the shared writer guard rejects a nested production ledger', () => {
  const production = root();
  const dir = join(production, 'nested', 'run-ledger');
  expect(refuseProductionLedgerWriteInTest(dir, 'run-ledger', { NODE_ENV: 'test' }, production, production)).toBe(true);
  expect(runReworkDriftSignals(['--dir', dir]).scan).toMatchObject({ readableRunCount: 0, unreadableRunCount: 0 });
});

describe('rework drift signals', () => {
  test('emits distinct independent last-round signals for divergent and convergent histories', () => {
    const divergent = analyzeRunDriftSignals('run-divergent', ledger('run-divergent', [3, 4, 2, 3, 2, 3, 2]));
    const convergent = analyzeRunDriftSignals('run-convergent', ledger('run-convergent', [2, 2, 1, 0]));
    expect(divergent.rows.at(-1)).toEqual({ round: 7, mustFixCount: 2, cumulativeMustFixCount: 19, budgetIncreaseCount: 7, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 });
    expect(convergent.rows.at(-1)).toEqual({ round: 4, mustFixCount: 0, cumulativeMustFixCount: 5, budgetIncreaseCount: 4, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 });
  });

  test('uses no future entries when calculating an earlier round', () => {
    const full = analyzeRunDriftSignals('run-causal', ledger('run-causal', [2, 2, 1, 0]));
    const truncated = analyzeRunDriftSignals('run-causal', ledger('run-causal', [2, 2]));
    expect(full.rows[1]).toEqual({ round: 2, mustFixCount: 2, cumulativeMustFixCount: 4, budgetIncreaseCount: 2, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 });
    expect(truncated.rows[1]).toEqual({ round: 2, mustFixCount: 2, cumulativeMustFixCount: 4, budgetIncreaseCount: 2, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 });
  });

  test('uses EXTEND verdict and carries cumulative signals through a reviewless round', () => {
    const result = analyzeRunDriftSignals('run-cumulative', [
      entry('run-cumulative', 'reviewed', { round: 1, mustFix: ['a', 'b'] }),
      entry('run-cumulative', 'rework-budget', { round: 1, verdict: 'HOLD', effectiveMaxBefore: 1, effectiveMaxAfter: 2 }),
      entry('run-cumulative', 'refute-not-submitted', { round: 2, refutableCount: 3 }),
      entry('run-cumulative', 'rework-budget', { round: 2, verdict: 'EXTEND', effectiveMaxBefore: 2, effectiveMaxAfter: 3 }),
      entry('run-cumulative', 'reviewed', { round: 3, mustFix: ['c'] }),
    ]);
    expect(result.rows).toEqual([
      { round: 1, mustFixCount: 2, cumulativeMustFixCount: 2, budgetIncreaseCount: 0, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 },
      { round: 2, mustFixCount: null, cumulativeMustFixCount: 2, budgetIncreaseCount: 1, refuteNotSubmittedCount: 1, refutableNotSubmittedCount: 3 },
      { round: 3, mustFixCount: 1, cumulativeMustFixCount: 3, budgetIncreaseCount: 1, refuteNotSubmittedCount: 1, refutableNotSubmittedCount: 3 },
    ]);
  });

  test('renders a selected run as one line per round and a scan as last-signal rows with stored outcomes', () => {
    const dir = root();
    writeLedger(dir, 'run-a', [...ledger('run-a', [2, 0]), entry('run-a', 'run-rollup', { runStatus: 'completed' })]);
    writeLedger(dir, 'run-b', [...ledger('run-b', [3]), entry('run-b', 'run-status', { runStatus: 'failed' })]);
    const scan = scanReworkDriftSignals(dir);
    expect(renderReworkDriftSignals(scan, 'run-a').split('\n').map((line) => JSON.parse(line))).toEqual([
      { runId: 'run-a', outcome: 'completed', status: 'measured', verdict: { verdict: 'unmeasurable', reason: 'finding-ids-unavailable', persistentFindingIds: [], maximumPersistenceCount: null }, recommendation: 'Finding persistence cannot be measured from this ledger. Recommendation: retain the unknown state until comparable reviewed rounds are available. (No automatic action; HITL.)', round: 1, mustFixCount: 2, cumulativeMustFixCount: 2, budgetIncreaseCount: 1, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 },
      { runId: 'run-a', outcome: 'completed', status: 'measured', verdict: { verdict: 'unmeasurable', reason: 'finding-ids-unavailable', persistentFindingIds: [], maximumPersistenceCount: null }, recommendation: 'Finding persistence cannot be measured from this ledger. Recommendation: retain the unknown state until comparable reviewed rounds are available. (No automatic action; HITL.)', round: 2, mustFixCount: 0, cumulativeMustFixCount: 2, budgetIncreaseCount: 2, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 },
    ]);
    expect(renderReworkDriftSignals(scan).split('\n').map((line) => JSON.parse(line))).toEqual([
      { runId: 'run-a', outcome: 'completed', status: 'measured', verdict: { verdict: 'unmeasurable', reason: 'finding-ids-unavailable', persistentFindingIds: [], maximumPersistenceCount: null }, recommendation: 'Finding persistence cannot be measured from this ledger. Recommendation: retain the unknown state until comparable reviewed rounds are available. (No automatic action; HITL.)', lastSignal: { round: 2, mustFixCount: 0, cumulativeMustFixCount: 2, budgetIncreaseCount: 2, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 } },
      { runId: 'run-b', outcome: 'failed', status: 'measured', verdict: { verdict: 'unmeasurable', reason: 'insufficient-review-rounds', persistentFindingIds: [], maximumPersistenceCount: null }, recommendation: 'Finding persistence cannot be measured from this ledger. Recommendation: retain the unknown state until comparable reviewed rounds are available. (No automatic action; HITL.)', lastSignal: { round: 1, mustFixCount: 3, cumulativeMustFixCount: 3, budgetIncreaseCount: 1, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 } },
      { type: 'summary', readableRunCount: 2, unreadableRunCount: 0 },
    ]);
    expect(runReworkDriftSignals(['--dir', dir, '--run', 'run-a']).stdout).toBe(renderReworkDriftSignals(scan, 'run-a'));
  });

  test('classifies every discovered jsonl filename, including noncanonical names, as readable or unreadable', () => {
    const dir = root();
    writeLedger(dir, 'run-readable', ledger('run-readable', [1]));
    writeFileSync(join(dir, 'not a canonical run id.jsonl'), '{}\n');

    const result = runReworkDriftSignals(['--dir', dir]);

    expect(result.exitCode).toBe(1);
    expect(result.scan.readableRunCount).toBe(1);
    expect(result.scan.unreadableRunCount).toBe(1);
    // ⛔ 사유가 «로더의 것»이어야 한다 — 이 자가 로더 «전»에 자체 거부하면 그 우회가 계약으로 굳는다(리뷰 must-fix).
    //   ⇒ 아래 문면은 `loadRunLedger` 가 내는 것이고, 이 자는 그것을 그대로 싣기만 한다.
    expect(result.scan.unreadable).toEqual([{
      runId: 'not a canonical run id',
      error: 'invalid runId: not a canonical run id',
    }]);
    expect(renderReworkDriftSignals(result.scan).split('\n').map((line) => JSON.parse(line))).toEqual([
      { runId: 'run-readable', outcome: null, status: 'measured', verdict: { verdict: 'unmeasurable', reason: 'insufficient-review-rounds', persistentFindingIds: [], maximumPersistenceCount: null }, recommendation: 'Finding persistence cannot be measured from this ledger. Recommendation: retain the unknown state until comparable reviewed rounds are available. (No automatic action; HITL.)', lastSignal: { round: 1, mustFixCount: 1, cumulativeMustFixCount: 1, budgetIncreaseCount: 1, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 } },
      { runId: 'not a canonical run id', status: 'unreadable', error: 'invalid runId: not a canonical run id' },
      { type: 'summary', readableRunCount: 1, unreadableRunCount: 1 },
    ]);
  });

  // ⛔ `load: () => null` 스텁은 「없다」와 「못 읽었다」를 «구별하지 못한다» — 실제 파일시스템으로 잰다(리뷰 must-fix).
  test('separates an empty ledger, a real ENOENT directory, and an unreadable file on the real filesystem', () => {
    // ⓐ 빈 원장 — 파일은 «있고» 라운드가 «없다». 실패가 아니라 「잴 라운드가 없었다」다.
    const emptyDir = root();
    writeFileSync(join(emptyDir, 'run-empty.jsonl'), '');
    const empty = runReworkDriftSignals(['--dir', emptyDir]);
    expect(empty.exitCode).toBe(0);
    expect(empty.scan.readableRunCount).toBe(1);
    expect(empty.scan.unreadableRunCount).toBe(0);
    expect(empty.scan.runs[0]!.rows).toEqual([]);

    // ⓑ 실제 ENOENT — 디렉토리가 «없다». 던지지 않고 0건으로 낸다.
    const missingDir = join(root(), 'does-not-exist');
    const missing = runReworkDriftSignals(['--dir', missingDir]);
    expect(missing.exitCode).toBe(0);
    expect(missing.scan).toMatchObject({ readableRunCount: 0, unreadableRunCount: 0, runs: [], unreadable: [] });

    // ⓒ 읽기 불가 I/O — 권한을 지운 «실제» 파일. 「없다」가 아니라 「못 읽었다」로 남는다.
    // ⛔ root 는 권한을 무시하고 읽는다 ⇒ 그 환경에서 이 검사는 「거짓 초록」이 된다(리뷰 should-fix).
    //   ⇒ 권한 모델이 실제로 «막는지» 먼저 확인하고, 안 막으면 「못 쟀다」로 «명시적으로» 건너뛴다.
    const lockedDir = root();
    const locked = join(lockedDir, 'run-locked.jsonl');
    writeFileSync(locked, '{"runId":"run-locked","event":"reviewed","data":{"round":1,"mustFix":1}}\n');
    chmodSync(locked, 0o000);
    let permissionModelBlocks = false;
    try { readFileSync(locked, 'utf8'); } catch { permissionModelBlocks = true; }
    try {
      if (permissionModelBlocks) {
        const result = runReworkDriftSignals(['--dir', lockedDir]);
        expect(result.scan.readableRunCount).toBe(0);
        expect(result.scan.unreadableRunCount).toBe(1);
        expect(result.scan.unreadable[0]!.runId).toBe('run-locked');
        expect(result.exitCode).toBe(1);
      } else {
        // ⛔ 「검사가 통과했다」로 읽히지 않게 «못 쟀다»를 남긴다 — 조용히 지나가면 거짓 초록이다.
        console.warn('[rework-drift-signals.test] chmod 000 이 이 환경에서 읽기를 안 막는다 — 읽기 불가 축은 «못 쟀다»');
        expect(permissionModelBlocks).toBe(false);
      }
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  // ⛔ 종료 코드는 «이 호출이 물은 것»을 답한다 — 남의 원장이 깨졌다고 1 을 내면 안 된다(리뷰 must-fix).
  test('exit code of --run reflects the selected run, not other ledgers', () => {
    const dir = root();
    writeLedger(dir, 'run-good', ledger('run-good', [1]));
    writeFileSync(join(dir, 'run-broken.jsonl'), '{broken\n');

    // ⓐ 고른 런은 «정상» — 다른 원장이 깨졌어도 0
    const selected = runReworkDriftSignals(['--dir', dir, '--run', 'run-good']);
    expect(selected.exitCode).toBe(0);

    // ⓑ 고른 런을 «못 읽었다» — 다른 원장이 정상이어도 1
    const broken = runReworkDriftSignals(['--dir', dir, '--run', 'run-broken']);
    expect(broken.exitCode).toBe(1);
    expect(JSON.parse(broken.stdout)).toMatchObject({ runId: 'run-broken', status: 'unreadable' });

    // ⓒ 고른 런이 «아예 없다» — 그것도 1
    const absent = runReworkDriftSignals(['--dir', dir, '--run', 'run-absent']);
    expect(absent.exitCode).toBe(1);

    // ⓓ 전체 모드는 전체 실패 수가 정한다
    expect(runReworkDriftSignals(['--dir', dir]).exitCode).toBe(1);
  });

  test('preserves unreadable and vanished discovered ledgers separately and leaves no-review runs measurable', () => {
    const dir = root();
    const readablePath = writeLedger(dir, 'run-readable', [
      ...ledger('run-readable', [2]),
      entry('run-readable', 'run-rollup', { runStatus: 'completed' }),
    ]);
    writeFileSync(join(dir, 'run-broken.jsonl'), '{broken\n');
    const before = readFileSync(readablePath, 'utf8');
    const result = runReworkDriftSignals(['--dir', dir]);
    expect(result.exitCode).toBe(1);
    expect(result.scan.readableRunCount).toBe(1);
    expect(result.scan.unreadableRunCount).toBe(1);
    expect(result.scan.unreadable).toEqual([{ runId: 'run-broken', error: expect.stringContaining('invalid run ledger JSON at line 1') }]);
    // ⛔ 정확 비교로 «되돌린» 자리 — toMatchObject 는 새 verdict·recommendation 의 계약과
    //    예상치 못한 필드 회귀를 «숨긴다». 기대값은 리터럴로 적는다(빌더를 부르면 판별력이 0 이 된다).
    expect(result.scan.runs).toEqual([{
      runId: 'run-readable',
      outcome: 'completed',
      status: 'measured',
      rows: [{ round: 1, mustFixCount: 2, cumulativeMustFixCount: 2, budgetIncreaseCount: 1, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 }],
      warnings: [],
      verdict: { verdict: 'unmeasurable', reason: 'insufficient-review-rounds', persistentFindingIds: [], maximumPersistenceCount: null },
      recommendation: 'Finding persistence cannot be measured from this ledger. Recommendation: retain the unknown state until comparable reviewed rounds are available. (No automatic action; HITL.)',
    }]);
    expect(readFileSync(readablePath, 'utf8')).toBe(before);

    const vanished = scanReworkDriftSignals(dir, {
      list: () => ['run-vanished.jsonl'],
      load: () => null,
    });
    expect(vanished).toEqual({ ledgerDirectory: dir, readableRunCount: 0, unreadableRunCount: 1, runs: [], unreadable: [{ runId: 'run-vanished', error: 'ledger missing after discovery' }] });

    const noReviews = analyzeRunDriftSignals('run-empty-review', [entry('run-empty-review', 'run-status', { runStatus: 'failed' })]);
    expect(noReviews).toEqual({
      runId: 'run-empty-review',
      outcome: 'failed',
      status: 'no-review-rounds',
      rows: [],
      warnings: [],
      verdict: { verdict: 'unmeasurable', reason: 'no-review-rounds', persistentFindingIds: [], maximumPersistenceCount: null },
      recommendation: 'Finding persistence cannot be measured from this ledger. Recommendation: retain the unknown state until comparable reviewed rounds are available. (No automatic action; HITL.)',
    });
  });

  test('reports duplicate and out-of-order events without changing deterministic rows', () => {
    const result = analyzeRunDriftSignals('run-warnings', [
      entry('run-warnings', 'reviewed', { round: 2, mustFix: 2 }),
      entry('run-warnings', 'reviewed', { round: 1, mustFix: 3 }),
      entry('run-warnings', 'reviewed', { round: 2, mustFix: 1 }),
      entry('run-warnings', 'refute-not-submitted', { round: 2, refutableCount: 4 }),
    ]);
    expect(result.rows).toEqual([
      { round: 1, mustFixCount: 3, cumulativeMustFixCount: 3, budgetIncreaseCount: 0, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 },
      { round: 2, mustFixCount: 1, cumulativeMustFixCount: 4, budgetIncreaseCount: 0, refuteNotSubmittedCount: 1, refutableNotSubmittedCount: 4 },
    ]);
    expect(result.warnings).toEqual(['out-of-order round=1 after=2', 'duplicate reviewed round=2']);
  });

  test('counts discovered ledgers at execution time rather than a fixed historical total', () => {
    const dir = root();
    writeLedger(dir, 'run-z', ledger('run-z', [1]));
    writeLedger(dir, 'run-a', ledger('run-a', [0]));
    const scan = scanReworkDriftSignals(dir);
    expect(scan.readableRunCount).toBe(2);
    expect(scan.runs.map(({ runId }) => runId)).toEqual(['run-a', 'run-z']);
    expect(Object.keys(scan.runs[0]!.rows[0]!)).toEqual(['round', 'mustFixCount', 'cumulativeMustFixCount', 'budgetIncreaseCount', 'refuteNotSubmittedCount', 'refutableNotSubmittedCount']);
  });

  test('renders measured drift, no-drift, and unavailable persistence verdicts without changing summary', () => {
    const dir = root();
    const reviewed = (runId: string, round: number, mustFix: number, findingIds: readonly string[]) => entry(runId, 'reviewed', { round, mustFix, findingIds, verdict: 'fail' });
    writeLedger(dir, 'run-drift', [
      reviewed('run-drift', 1, 1, ['same']),
      reviewed('run-drift', 2, 1, ['same']),
      reviewed('run-drift', 3, 1, ['same']),
    ]);
    writeLedger(dir, 'run-no-drift', [
      reviewed('run-no-drift', 1, 1, ['first']),
      reviewed('run-no-drift', 2, 1, ['second']),
    ]);
    writeLedger(dir, 'run-unmeasurable', [
      entry('run-unmeasurable', 'reviewed', { round: 1, mustFix: 1, verdict: 'fail' }),
      entry('run-unmeasurable', 'reviewed', { round: 2, mustFix: 1, verdict: 'fail' }),
    ]);
    const scan = scanReworkDriftSignals(dir);
    expect(scan.runs.map((run) => [run.runId, run.verdict.verdict, run.verdict.reason])).toEqual([
      ['run-drift', 'drift', 'persistent-must-fix'],
      ['run-no-drift', 'no-drift', 'no-persistent-must-fix'],
      ['run-unmeasurable', 'unmeasurable', 'finding-ids-unavailable'],
    ]);
    const rendered = renderReworkDriftSignals(scan).split('\n').map((line) => JSON.parse(line));
    expect(rendered).toEqual([
      { runId: 'run-drift', outcome: null, status: 'measured', verdict: { verdict: 'drift', reason: 'persistent-must-fix', persistentFindingIds: ['same'], maximumPersistenceCount: 2 }, recommendation: 'Recurring must-fix findings crossed the persistence threshold (same). Recommendation: inspect the rework plan before another round. (No automatic action; HITL.)', lastSignal: { round: 3, mustFixCount: 1, cumulativeMustFixCount: 3, budgetIncreaseCount: 0, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 } },
      { runId: 'run-no-drift', outcome: null, status: 'measured', verdict: { verdict: 'no-drift', reason: 'no-persistent-must-fix', persistentFindingIds: [], maximumPersistenceCount: 0 }, recommendation: 'No must-fix finding crossed the persistence threshold. Recommendation: continue normal review observation. (No automatic action; HITL.)', lastSignal: { round: 2, mustFixCount: 1, cumulativeMustFixCount: 2, budgetIncreaseCount: 0, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 } },
      { runId: 'run-unmeasurable', outcome: null, status: 'measured', verdict: { verdict: 'unmeasurable', reason: 'finding-ids-unavailable', persistentFindingIds: [], maximumPersistenceCount: null }, recommendation: 'Finding persistence cannot be measured from this ledger. Recommendation: retain the unknown state until comparable reviewed rounds are available. (No automatic action; HITL.)', lastSignal: { round: 2, mustFixCount: 1, cumulativeMustFixCount: 2, budgetIncreaseCount: 0, refuteNotSubmittedCount: 0, refutableNotSubmittedCount: 0 } },
      { type: 'summary', readableRunCount: 3, unreadableRunCount: 0 },
    ]);
  });
});
