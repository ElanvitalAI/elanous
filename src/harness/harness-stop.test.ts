import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPidRecordFrom, stopHarnessRun, START_TOLERANCE_MS, type HarnessStopDeps } from './harness-stop.js';

function fakeDeps(o: { record?: { pid: number; startedAt: number } | null; starts: Array<number | null>; contexts?: string[]; jobs?: number }) {
  const signals: Array<[number, NodeJS.Signals]> = [];
  const kubectlCalls: string[][] = [];
  let i = 0;
  const deps: HarnessStopDeps = {
    readPidRecord: () => o.record ?? null,
    processStartMs: () => o.starts[Math.min(i++, o.starts.length - 1)] ?? null,
    kill: (pid, signal) => { signals.push([pid, signal]); },
    sleep: async () => {},
    kubeContexts: () => o.contexts ?? ['ctx-a'],
    kubectl: (args) => {
      kubectlCalls.push([...args]);
      return { status: 0, stdout: Array.from({ length: o.jobs ?? 0 }, (_, n) => `job.batch/si-task-${n} deleted`).join('\n'), stderr: '' };
    },
    namespace: 'elanous-test',
    graceMs: 1_000,
  };
  return { deps, signals, kubectlCalls };
}

describe('harness stop — 소유 확인 뒤에만 신호 · 라벨 Job 만 삭제', () => {
  test('시작 시각이 맞으면 SIGTERM 을 보내고 라벨 선택자로 Job 을 지운다', async () => {
    const f = fakeDeps({ record: { pid: 4242, startedAt: 1_000_000 }, starts: [1_000_900, null], jobs: 2 });
    const r = await stopHarnessRun('run-abc', f.deps);
    expect(r.process).toBe('stopped');
    expect(f.signals).toEqual([[4242, 'SIGTERM']]);
    expect(f.kubectlCalls).toEqual([['--context', 'ctx-a', '-n', 'elanous-test', 'delete', 'job', '-l', 'elanous.run=run-abc', '--wait=false']]);
    expect(r.jobsDeleted).toBe(2);
  });

  test('시작 시각이 다르면(PID 재사용) 신호 0 · owner-mismatch · Job 삭제는 그대로', async () => {
    const f = fakeDeps({ record: { pid: 4242, startedAt: 1_000_000 }, starts: [1_000_000 + START_TOLERANCE_MS + 1] });
    const r = await stopHarnessRun('run-abc', f.deps);
    expect(r.process).toBe('owner-mismatch');
    expect(f.signals).toEqual([]);
    expect(f.kubectlCalls).toHaveLength(1);
  });

  test('기록이 없으면 absent · 신호 0 · Job 삭제는 그대로', async () => {
    const f = fakeDeps({ record: null, starts: [null], contexts: ['c1', 'c2'] });
    const r = await stopHarnessRun('run-abc', f.deps);
    expect(r.process).toBe('absent');
    expect(f.signals).toEqual([]);
    expect(f.kubectlCalls.map((a) => a[1])).toEqual(['c1', 'c2']);
  });

  test('제한 시간 안에 안 끝나면 같은 프로세스일 때만 SIGKILL', async () => {
    const f = fakeDeps({ record: { pid: 7, startedAt: 5_000 }, starts: [5_000] });
    const r = await stopHarnessRun('run-x', f.deps);
    expect(r.process).toBe('killed');
    expect(f.signals).toEqual([[7, 'SIGTERM'], [7, 'SIGKILL']]);
  });

  test('명시한 문맥만 쓴다 · 잘못된 run id 는 거부', async () => {
    const f = fakeDeps({ record: null, starts: [null], contexts: ['should-not-be-used'] });
    await stopHarnessRun('run-abc', f.deps, ['only-this']);
    expect(f.kubectlCalls.map((a) => a[1])).toEqual(['only-this']);
    await expect(stopHarnessRun('run abc; rm', f.deps)).rejects.toThrow('invalid run id');
  });

  test('pid.json 은 B 조각의 자리(<runsDir>/<runId>/pid.json)에서 읽고 망가진 기록은 없는 것으로 본다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-stop-'));
    try {
      mkdirSync(join(dir, 'run-ok'));
      writeFileSync(join(dir, 'run-ok', 'pid.json'), JSON.stringify({ pid: 123, startedAt: 99, argv0: 'bun' }));
      chmodSync(join(dir, 'run-ok', 'pid.json'), 0o600);
      mkdirSync(join(dir, 'run-bad'));
      writeFileSync(join(dir, 'run-bad', 'pid.json'), '{"pid":1}');
      expect(readPidRecordFrom(dir, 'run-ok')).toEqual({ pid: 123, startedAt: 99, argv0: 'bun' });
      expect(readPidRecordFrom(dir, 'run-bad')).toBeNull();
      expect(readPidRecordFrom(dir, 'run-missing')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
