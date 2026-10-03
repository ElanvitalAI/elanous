import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AmbiguousHarnessStopRunIdError, discoverStopProcesses, formatHarnessStop, readPidRecordFrom, stopGoalPathFromLedger, stopHarnessRun, stopRunIdCandidates, START_TOLERANCE_MS, type HarnessStopDeps } from './harness-stop.js';

function fakeDeps(o: { record?: { pid: number; startedAt: number } | null; starts: Array<number | null>; contexts?: string[]; jobs?: number; table?: string; scanFailed?: boolean; goalPath?: string | null; cwd?: (pid: number) => string | null }) {
  const signals: Array<[number, NodeJS.Signals]> = [];
  const kubectlCalls: string[][] = [];
  let i = 0;
  const deps: HarnessStopDeps = {
    readPidRecord: () => o.record ?? null,
    readGoalPath: () => o.goalPath ?? null,
    scanProcesses: (runId, goalPath) => o.scanFailed ? { status: 'failed', reason: 'ps unavailable' } : discoverStopProcesses(runId, goalPath, o.table ?? '', o.cwd),
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
  test('유일한 원장 접두는 전체 runId 로 풀어 pid 와 Job 라벨에 함께 쓴다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-prefix-'));
    const ledger = join(dir, 'ledger');
    const runs = join(dir, 'self-dev-runs');
    const full = 'run-4ce91e08-0934-45d1-9f1b-f0277e0812bd';
    try {
      mkdirSync(ledger);
      mkdirSync(runs);
      writeFileSync(join(ledger, `${full}.jsonl`), '');
      const f = fakeDeps({ record: { pid: 4242, startedAt: 1_000_000 }, starts: [1_000_000, null], jobs: 1 });
      f.deps.runIdCandidates = (given) => stopRunIdCandidates(given, [ledger], runs);
      f.deps.readPidRecord = (id) => id === full ? { pid: 4242, startedAt: 1_000_000 } : null;
      const r = await stopHarnessRun('run-4ce91e08', f.deps);
      expect(r.runId).toBe(full);
      expect(formatHarnessStop(r).split('\n')[0]).toBe(`↳ run-4ce91e08 → ${full}(전체)`);
      expect(f.signals).toEqual([[4242, 'SIGTERM']]);
      expect(f.kubectlCalls).toEqual([['--context', 'ctx-a', '-n', 'elanous-test', 'delete', 'job', '-l', `elanous.run=${full}`, '--wait=false']]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('같은 접두 원장 둘은 후보를 출력하고 신호·삭제 전에 exit 1 오류로 중단한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-ambiguous-'));
    const ledger = join(dir, 'ledger');
    const runs = join(dir, 'self-dev-runs');
    const ids = ['run-4ce91e08-0934-45d1-9f1b-f0277e0812bd', 'run-4ce91e08-0934-45d1-9f1b-f0277e0812be'];
    try {
      mkdirSync(ledger);
      mkdirSync(runs);
      for (const id of ids) writeFileSync(join(ledger, `${id}.jsonl`), '');
      const f = fakeDeps({ record: { pid: 4242, startedAt: 1_000_000 }, starts: [1_000_000] });
      f.deps.runIdCandidates = (given) => stopRunIdCandidates(given, [ledger], runs);
      let error: unknown;
      try { await stopHarnessRun('run-4ce91e08', f.deps); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(AmbiguousHarnessStopRunIdError);
      for (const id of ids) expect((error as Error).message).toContain(id);
      expect((error as Error).message).toContain('더 긴 id 를 주십시오');
      expect(f.signals).toEqual([]);
      expect(f.kubectlCalls).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('실제 CLI: 모호한 접두는 exit 1 · 두 후보 출력 · 프로세스 신호와 kubectl 호출 0', async () => {
    const dir = mkdtempSync(join(process.cwd(), '.stop-cli-'));
    const bin = join(dir, 'bin');
    const ledger = join(dir, 'run-ledger');
    const ids = ['run-4ce91e08-0934-45d1-9f1b-f0277e0812bd', 'run-4ce91e08-0934-45d1-9f1b-f0277e0812be'];
    const kubectlCalls = join(dir, 'kubectl-calls');
    const ready = join(dir, 'child-ready');
    const signalled = join(dir, 'child-signalled');
    const child = spawn(process.execPath, ['-e', `const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(signalled)}, 'SIGTERM'); process.exit(0); }); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`], { stdio: 'ignore' });
    try {
      for (let n = 0; n < 200 && !existsSync(ready); n++) await Bun.sleep(10);
      expect(existsSync(ready)).toBe(true);
      mkdirSync(bin);
      mkdirSync(ledger);
      for (const id of ids) writeFileSync(join(ledger, `${id}.jsonl`), '');
      mkdirSync(join(dir, 'self-dev-runs', ids[0]!), { recursive: true });
      const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(child.pid)], { encoding: 'utf8' });
      expect(ps.status).toBe(0);
      const startedAt = Date.parse(ps.stdout.trim());
      expect(Number.isFinite(startedAt)).toBe(true);
      writeFileSync(join(dir, 'self-dev-runs', ids[0]!, 'pid.json'), JSON.stringify({ pid: child.pid, startedAt }));
      writeFileSync(join(bin, 'kubectl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${kubectlCalls}'\n`, { mode: 0o755 });
      const result = spawnSync(process.execPath, ['bin/elanous.mjs', `--test=${dir}`, 'harness', 'stop', 'run-4ce91e08', '--context', 'ctx-a'], {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('더 긴 id 를 주십시오');
      for (const id of ids) expect(result.stderr).toContain(id);
      expect(existsSync(kubectlCalls)).toBe(false);
      expect(existsSync(signalled)).toBe(false);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  test('전체 runId 는 풀지 않고 기존 동작을 유지한다', async () => {
    const full = 'run-4ce91e08-0934-45d1-9f1b-f0277e0812bd';
    const f = fakeDeps({ starts: [null] });
    f.deps.runIdCandidates = () => { throw new Error('full ID must bypass lookup'); };
    const r = await stopHarnessRun(full, f.deps);
    expect(r.runId).toBe(full);
    expect(formatHarnessStop(r).split('\n')[0]).toBe(`harness stop ${full}`);
    expect(f.kubectlCalls[0]).toContain(`elanous.run=${full}`);
  });

  test('원장 없는 접두는 받은 id 그대로 Job 라벨로 보낸다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-absent-'));
    try {
      const f = fakeDeps({ starts: [null] });
      f.deps.runIdCandidates = (given) => stopRunIdCandidates(given, [join(dir, 'ledger')], join(dir, 'runs'));
      const r = await stopHarnessRun('run-4ce91e08', f.deps);
      expect(r.runId).toBe('run-4ce91e08');
      expect(f.kubectlCalls[0]).toContain('elanous.run=run-4ce91e08');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('pid.json 디렉터리와 연합 원장도 후보에 합치되 같은 runId 는 중복하지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-federated-'));
    const local = join(dir, 'local');
    const federated = join(dir, 'federated');
    const runs = join(dir, 'runs');
    const id = 'run-4ce91e08-0934-45d1-9f1b-f0277e0812bd';
    try {
      mkdirSync(local);
      mkdirSync(federated);
      mkdirSync(join(runs, id), { recursive: true });
      writeFileSync(join(federated, `${id}.jsonl`), '');
      writeFileSync(join(runs, id, 'pid.json'), '{}');
      writeFileSync(join(local, 'run-4ce91e08-unrelated.jsonl'), '');
      expect(stopRunIdCandidates('run-4ce91e08', [local, federated], runs)).toEqual([id]);
      rmSync(join(federated, `${id}.jsonl`));
      expect(stopRunIdCandidates('run-4ce91e08', [local, federated], runs)).toEqual([id]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

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

  test('가짜 원장의 start 골 경로 ⊕ pid.json 없음: ask 발사 후보를 찾고 TERM 1회', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-ledger-'));
    try {
      writeFileSync(join(dir, 'run-abc.jsonl'), `${JSON.stringify({ runId: 'run-abc', event: 'start', data: { goalFile: 'docs/goals/X.md', targetRoot: '/repo' } })}\n`);
      const goalPath = stopGoalPathFromLedger('run-abc', dir);
      expect(goalPath).toBe('/repo/docs/goals/X.md');
      expect(discoverStopProcesses('run-abc', '/repo/docs/goals/X.md', '55 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs harness ask docs/goals/X.md', () => '/repo')).toEqual({ status: 'ok', candidates: [{ pid: 55, startedAt: Date.parse('Mon Sep 29 06:55:00 2026'), via: 'argv-goal' }] });
      const f = fakeDeps({ starts: [Date.parse('Mon Sep 29 06:55:00 2026'), null], goalPath, cwd: () => '/repo', table: '44391 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs harness ask docs/goals/X.md' });
      const r = await stopHarnessRun('run-abc', f.deps);
      expect(r.candidates).toEqual([{ pid: 44391, startedAt: Date.parse('Mon Sep 29 06:55:00 2026'), via: 'argv-goal' }]);
      expect(f.signals).toEqual([[44391, 'SIGTERM']]);
      expect(formatHarnessStop(r)).toContain('pid 44391 · 시작');
      expect(formatHarnessStop(r)).toContain('argv-goal');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('harness say 위치 골 경로 발사 프로세스를 찾아 TERM 1회', async () => {
    const f = fakeDeps({ starts: [Date.parse('Mon Sep 29 06:55:00 2026'), null], goalPath: '/repo/docs/goals/X.md', cwd: () => '/repo', table: '44392 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs harness say docs/goals/X.md' });
    const r = await stopHarnessRun('run-abc', f.deps);
    expect(r.candidates).toEqual([{ pid: 44392, startedAt: Date.parse('Mon Sep 29 06:55:00 2026'), via: 'argv-goal' }]);
    expect(f.signals).toEqual([[44392, 'SIGTERM']]);
    expect(formatHarnessStop(r)).toContain('pid 44392 · 시작');
  });

  test('PID 1 행을 건너뛰고 뒤의 발사 프로세스를 찾아 TERM 한다', async () => {
    const f = fakeDeps({ starts: [Date.parse('Mon Sep 29 06:55:00 2026'), null], table: [
      '1 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs self orchestrate --run-id=run-abc',
      '56 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs self orchestrate --run-id=run-abc',
    ].join('\n') });
    const r = await stopHarnessRun('run-abc', f.deps);
    expect(r.scanned).toBe(true);
    expect(r.candidates.map(({ pid }) => pid)).toEqual([56]);
    expect(f.signals).toEqual([[56, 'SIGTERM']]);
  });

  test('상대 골 경로는 후보 cwd로 확인할 때만 TERM; 다른 저장소·cwd 불명은 제외', async () => {
    const row = (pid: number) => `${pid} Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs harness ask docs/goals/X.md`;
    const cwd = (pid: number) => pid === 57 ? '/repo' : pid === 58 ? '/other-repo' : null;
    const f = fakeDeps({ starts: [Date.parse('Mon Sep 29 06:55:00 2026'), null], goalPath: '/repo/docs/goals/X.md', cwd, table: [row(57), row(58), row(59)].join('\n') });
    const r = await stopHarnessRun('run-abc', f.deps);
    expect(r.candidates.map(({ pid, via }) => [pid, via])).toEqual([[57, 'argv-goal']]);
    expect(f.signals).toEqual([[57, 'SIGTERM']]);
    expect(discoverStopProcesses('run-abc', '/repo/docs/goals/X.md', row(59), () => { throw new Error('cwd denied'); })).toEqual({ status: 'ok', candidates: [] });
  });

  test('runId 명령줄은 argv-runId · 같은 pid 중복은 1회', async () => {
    const f = fakeDeps({ record: { pid: 42, startedAt: 1_000 }, starts: [1_000, null], table: '42 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs self orchestrate --run-id=run-abc' });
    const r = await stopHarnessRun('run-abc', f.deps);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.via).toBe('pid.json');
    expect(f.signals).toEqual([[42, 'SIGTERM']]);
    const other = fakeDeps({ starts: [Date.parse('Mon Sep 29 06:55:00 2026'), null], table: '43 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs self orchestrate --run-id=run-abc' });
    expect((await stopHarnessRun('run-abc', other.deps)).candidates[0]?.via).toBe('argv-runId');
    expect(other.signals).toEqual([[43, 'SIGTERM']]);
  });

  test('두 발사 후보는 모두 TERM 을 먼저 받고 나서 grace 대기로 간다', async () => {
    const log: string[] = [];
    const f = fakeDeps({ starts: [Date.parse('Mon Sep 29 06:55:00 2026'), Date.parse('Mon Sep 29 06:55:00 2026'), null, null], table: [
      '70 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs self orchestrate --run-id=run-abc',
      '71 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs self orchestrate --run-id=run-abc',
    ].join('\n') });
    f.deps.kill = (pid, signal) => { log.push(`${pid}:${signal}`); };
    f.deps.sleep = async () => { log.push('sleep'); };
    await stopHarnessRun('run-abc', f.deps);
    expect(log.slice(0, 2)).toEqual(['70:SIGTERM', '71:SIGTERM']);
    expect(log).toContain('sleep');
  });

  test('발사 입구별 골 문서 인자만 일치시키고 runId 부분 문자열은 배제한다', () => {
    const table = [
      '60 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs self orchestrate /repo/docs/goals/X.md',
      '61 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs dev --say /repo/docs/goals/X.md',
      '62 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs harness say --run-id=run-abc-extra',
      '63 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs harness ask /repo/docs/goals/X.md-other',
      '64 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs harness ask /repo/docs/goals/X.md --run-id=run-other',
    ].join('\n');
    const result = discoverStopProcesses('run-abc', '/repo/docs/goals/X.md', table);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.candidates.map(({ pid, via }) => [pid, via])).toEqual([[60, 'argv-goal'], [61, 'argv-goal']]);
  });

  test('남의 런·골, 셸 인용이나 비발사 명령은 후보가 아니다', async () => {
    const f = fakeDeps({ starts: [null], goalPath: '/repo/docs/goals/X.md', table: [
      '40 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs harness ask /repo/docs/goals/Y.md',
      '41 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs self orchestrate --run-id=run-other',
      '42 Mon Sep 29 06:55:00 2026 sh -c bun bin/elanous.mjs harness ask /repo/docs/goals/X.md',
      '43 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs logs run-abc',
    ].join('\n') });
    const r = await stopHarnessRun('run-abc', f.deps);
    expect(r.candidates).toEqual([]);
    expect(f.signals).toEqual([]);
  });

  test('두 조회에서 0 이면 못 찾음 · 측정 실패면 못 잼', async () => {
    const empty = fakeDeps({ starts: [null] });
    const e = await stopHarnessRun('run-abc', empty.deps);
    expect(formatHarnessStop(e)).toContain('못 찾음(pid.json 없음 · 프로세스 표에서 runId·골 경로 0)');
    const failed = fakeDeps({ starts: [null], scanFailed: true });
    expect(formatHarnessStop(await stopHarnessRun('run-abc', failed.deps))).toContain('못 잼');
    expect(failed.signals).toEqual([]);
  });

  test('원장 없음은 runId 로만 찾고, ps 부분 파싱 실패는 빈 표가 아니다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-no-ledger-'));
    try {
      expect(stopGoalPathFromLedger('run-abc', dir)).toBeNull();
      const f = fakeDeps({ starts: [Date.parse('Mon Sep 29 06:55:00 2026'), null], table: [
        '50 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs harness ask docs/goals/X.md',
        '51 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs dev --say hello --run-id=run-abc',
      ].join('\n') });
      const r = await stopHarnessRun('run-abc', f.deps);
      expect(r.candidates.map(({ pid, via }) => ({ pid, via }))).toEqual([{ pid: 51, via: 'argv-runId' }]);
      expect(f.signals).toEqual([[51, 'SIGTERM']]);
      expect(discoverStopProcesses('run-abc', null, 'malformed line').status).toBe('failed');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('pid.json 중지는 표를 못 재도 그대로 수행하되 출력은 미측정을 밝힌다', async () => {
    const f = fakeDeps({ record: { pid: 53, startedAt: 1000 }, starts: [1000, null], scanFailed: true });
    const r = await stopHarnessRun('run-abc', f.deps);
    expect(f.signals).toEqual([[53, 'SIGTERM']]);
    expect(formatHarnessStop(r)).toContain('프로세스 표: 못 잼');
  });

  test('표 스캔이 던져도 못 잼으로 기록하고 Pod 정리는 계속한다', async () => {
    const f = fakeDeps({ starts: [null] });
    f.deps.scanProcesses = () => { throw new Error('ps denied'); };
    const r = await stopHarnessRun('run-abc', f.deps);
    expect(r.process).toBe('unmeasured');
    expect(f.kubectlCalls).toHaveLength(1);
  });

  test('pid.json 시작 시각 불일치와 표의 같은 PID 가 겹쳐도 신호를 보내지 않는다', async () => {
    const f = fakeDeps({ record: { pid: 52, startedAt: 1000 }, starts: [9000], table: '52 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs self orchestrate --run-id=run-abc' });
    const r = await stopHarnessRun('run-abc', f.deps);
    expect(r.process).toBe('owner-mismatch');
    expect(r.candidates).toEqual([]);
    expect(f.signals).toEqual([]);
  });

  test('--dry-run 은 후보를 표시하되 프로세스 신호·Pod Job 삭제 0', async () => {
    const f = fakeDeps({ starts: [1_000], table: '44 Mon Sep 29 06:55:00 2026 bun bin/elanous.mjs dev --ask /repo/docs/goals/X.md', goalPath: '/repo/docs/goals/X.md' });
    const r = await stopHarnessRun('run-abc', f.deps, undefined, true);
    expect(r.candidates).toHaveLength(1);
    expect(f.signals).toEqual([]);
    expect(f.kubectlCalls).toEqual([]);
    expect(formatHarnessStop(r)).toContain('dry-run');
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
