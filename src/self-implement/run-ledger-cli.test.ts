import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LogStore, type LogStoreRow } from '../mss/logging/log-store.js';
import { writeHarnessScreen } from '../harness/harness-screen.js';
import { classifyRunScreenMissing, describeMissingRunLedger, formatUnattributableDetail, queryGoalSourceDistribution, queryMergeAttribution, queryRunScreenKey, queryUnfinishedRunLedgers, renderUnfinishedRunLedgers, type RunChainLogStore, type RunLedgerEntry } from './run-ledger.js';
import { makeRunObserver, observeRunOutcome } from './orchestrator.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

// ⛔⭐ 이 파일이 있는 이유 — 골의 «판정 신호»가 테스트로 물리게 한다.
//    골은 "없는 runId 를 주면 없다고 말하고 종료 코드가 성공이 아니다" 를 판정 신호로 걸었는데,
//    그 신호를 «착지 코드에서» 무는 회귀가 없었다(무인 리뷰 should-fix).
//    ⇒ 함수 단위 테스트는 「그 코드가 무는가」만 답하고 「그 코드가 실행 경로에 있는가」는 못 답한다.
//      그래서 실물 argv 로 프로세스를 띄운다(src/cli/logs-cli.test.ts 와 같은 형태).
const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const fixtureRunIds = {
  elanousMerged: 'run-00000000-0000-4000-8000-000000000010',
  failedMerge: 'run-00000000-0000-4000-8000-000000000011',
  humanOpenPr: 'run-00000000-0000-4000-8000-000000000012',
  humanMerge: 'run-00000000-0000-4000-8000-000000000013',
  humanOpenPrWithoutNumber: 'run-00000000-0000-4000-8000-000000000014',
  humanOpenPrStatusNumberOnly: 'run-00000000-0000-4000-8000-000000000015',
  contaminated: 'run-00000000-0000-4000-8000-000000000016',
  active: 'run-00000000-0000-4000-8000-000000000021',
  finished: 'run-00000000-0000-4000-8000-000000000022',
  nonTerminalStatus: 'run-00000000-0000-4000-8000-000000000023',
  unreadableGoal: 'run-00000000-0000-4000-8000-000000000024',
  unknownGoal: 'run-00000000-0000-4000-8000-000000000025',
  noBranch: 'run-00000000-0000-4000-8000-000000000026',
  lost: 'run-00000000-0000-4000-8000-000000000027',
  notFound: 'run-00000000-0000-4000-8000-000000000031',
  bracket: 'run-00000000-0000-4000-8000-000000000032',
  dotStar: 'run-00000000-0000-4000-8000-000000000033',
  ledgerGoal: 'run-00000000-0000-4000-8000-000000000034',
  timestampMissing: 'run-00000000-0000-4000-8000-000000000035',
  timestampInvalid: 'run-00000000-0000-4000-8000-000000000036',
  timestampEmpty: 'run-00000000-0000-4000-8000-000000000037',
} as const;

function fixtureRunId(name: keyof typeof fixtureRunIds): string {
  return fixtureRunIds[name];
}

function runCli(stateDir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [join(sourceRoot, 'bin/elanous.mjs'), 'self', 'run-ledger', ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env, ELANOUS_STATE_DIR: stateDir },
  });
}

function runGoalSourceDistributionCli(stateDir: string, args: string[] = []) {
  return spawnSync(process.execPath, [join(sourceRoot, 'bin/elanous.mjs'), 'self', 'goal-source-distribution', ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
  });
}

function runScreenCli(stateDir: string, args: string[]) {
  return spawnSync(process.execPath, [join(sourceRoot, 'bin/elanous.mjs'), 'self', 'screen', ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
  });
}

function runMergeAttributionCli(stateDir: string, args: string[] = []) {
  return spawnSync(process.execPath, [join(sourceRoot, 'bin/elanous.mjs'), 'self', 'merge-attribution', ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
  });
}

function runUnfinishedRunsCli(stateDir: string, cwd: string, args: string[] = []) {
  return spawnSync(process.execPath, [join(sourceRoot, 'bin/elanous.mjs'), 'self', 'unfinished-runs', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
  });
}

describe('elanous self run-ledger — 실물 argv (판정 신호 회귀)', () => {
  it('원장이 없고 self-dev checkpoint가 있으면 다른 스토어와 조회 명령을 가리키며 exit 1을 보존한다', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'run-ledger-cli-self-dev-'));
    const runId = 'self-dev-only-run';
    try {
      const selfDevDir = join(stateDir, 'self-dev-runs');
      mkdirSync(selfDevDir, { recursive: true });
      writeFileSync(join(selfDevDir, `${runId}.json`), JSON.stringify({
        runId,
        createdAt: 0,
        updatedAt: 0,
        results: [],
      }), 'utf8');

      const r = runCli(stateDir, [runId]);
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(`status=${r.status}`).toBe('status=1');
      expect(out).toContain(`run ledger not found: ${join(stateDir, 'run-ledger', `${runId}.jsonl`)}`);
      expect(out).toContain(`checked 2 paths: ${join(stateDir, 'run-ledger', `${runId}.jsonl`)}; ${join(stateDir, 'self-dev-runs', `${runId}.json`)}`);
      expect(out).toContain(`self-dev run checkpoint found: ${join(stateDir, 'self-dev-runs', `${runId}.json`)}`);
      expect(out).toContain(`inspect it with: elanous self participants ${runId}`);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('특수문자 runId의 진단은 실제 정규화된 두 조회 경로를 가리킨다', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'run-ledger-cli-normalized-'));
    const runId = 'self/dev:only';
    const normalizedRunId = 'self-dev-only';
    try {
      const selfDevDir = join(stateDir, 'self-dev-runs');
      mkdirSync(selfDevDir, { recursive: true });
      writeFileSync(join(selfDevDir, `${normalizedRunId}.json`), JSON.stringify({
        runId: normalizedRunId,
        createdAt: 0,
        updatedAt: 0,
        results: [],
      }), 'utf8');

      const missing = describeMissingRunLedger(runId, stateDir);
      const ledgerPath = join(stateDir, 'run-ledger', `${normalizedRunId}.jsonl`);
      const checkpointPath = join(selfDevDir, `${normalizedRunId}.json`);
      expect(missing.runLedgerPath).toBe(ledgerPath);
      expect(missing.selfDevRunPath).toBe(checkpointPath);
      expect(missing.checkedPaths).toEqual([ledgerPath, checkpointPath]);
      expect(missing.selfDevRunFound).toBe(true);
      expect(missing.checkedPaths.join('; ')).not.toContain(`${runId}.json`);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('두 스토어에 없는 runId는 두 경로를 모두 확인했다고 말하고 exit 1을 보존한다', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'run-ledger-cli-missing-'));
    const runId = 'does-not-exist-run-id';
    try {
      const r = runCli(stateDir, [runId]);
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(`status=${r.status}`).toBe('status=1');
      expect(out).toContain('run ledger not found');
      expect(out).toContain(`checked 2 paths: ${join(stateDir, 'run-ledger', `${runId}.jsonl`)}; ${join(stateDir, 'self-dev-runs', `${runId}.json`)}`);
      expect(out).toContain(`self-dev run checkpoint not found: ${join(stateDir, 'self-dev-runs', `${runId}.json`)}`);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('원장이 있으면 그 이벤트를 산출에 싣는다', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'run-ledger-cli-present-'));
    try {
      const dir = join(stateDir, 'run-ledger');
      mkdirSync(dir, { recursive: true });
      const lines = [
        { timestamp: '2026-08-04T00:00:00.000Z', runId: 'r1', event: 'pipeline-node-entry', data: { node: 'gate' } },
        { timestamp: '2026-08-04T00:00:01.000Z', runId: 'r1', event: 'run-status', data: { stage: 'merged' } },
      ].map((l) => JSON.stringify(l)).join('\n');
      writeFileSync(join(dir, 'r1.jsonl'), `${lines}\n`, 'utf8');

      const r = runCli(stateDir, ['r1']);
      expect(`status=${r.status}`).toBe('status=0');
      expect(r.stdout).toContain('pipeline-node-entry');
      expect(r.stdout).toContain('run-status');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('--json은 개행 없는 UTF-8 trailing fragment를 건너뛰고 source byte count를 stderr에 낸다', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'run-ledger-cli-trailing-fragment-'));
    const runId = 'run-incomplete-trailing';
    const completeEntry = { timestamp: '2026-09-15T00:00:00.000Z', runId, event: 'start', data: { ready: true } };
    const trailingFragment = Buffer.concat([
      Buffer.from('{"runId":"run-incomplete-trailing","data":"', 'utf8'),
      Buffer.from('한', 'utf8').subarray(0, 2),
    ]);
    try {
      const dir = join(stateDir, 'run-ledger');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${runId}.jsonl`), Buffer.concat([Buffer.from(`${JSON.stringify(completeEntry)}\n`, 'utf8'), trailingFragment]));

      const r = runCli(stateDir, [runId, '--json']);
      expect(`status=${r.status}`).toBe('status=0');
      const outputLines = r.stdout.trim().split('\n').filter(Boolean);
      expect(outputLines.map((line) => JSON.parse(line))).toEqual([completeEntry]);
      expect(r.stderr).toContain(`skipped incomplete trailing run ledger line: ${trailingFragment.length} bytes`);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('--json은 개행 없는 구문 손상 trailing record를 건너뛰지 않고 실패한다', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'run-ledger-cli-malformed-trailing-'));
    const runId = 'run-malformed-trailing';
    const completeEntry = { timestamp: '2026-09-15T00:00:00.000Z', runId, event: 'start', data: { ready: true } };
    try {
      const dir = join(stateDir, 'run-ledger');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${runId}.jsonl`), `${JSON.stringify(completeEntry)}\n{\"runId\":!}`, 'utf8');

      const r = runCli(stateDir, [runId, '--json']);
      expect(`status=${r.status}`).toBe('status=1');
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('unable to load run ledger: invalid run ledger JSON at line 2');
      expect(r.stderr).not.toContain('skipped incomplete trailing run ledger line');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('연합 조회는 다른 우주의 정확 ID와 유일 접두를 찾고, test 우주는 --include-test로만 포함한다', () => {
    const prodStateDir = mkdtempSync(join(tmpdir(), 'run-ledger-cli-prod-'));
    const otherStateDir = mkdtempSync(join(tmpdir(), 'run-ledger-cli-other-'));
    const testStateDir = mkdtempSync(join(tmpdir(), 'run-ledger-cli-test-'));
    const home = mkdtempSync(join(tmpdir(), 'run-ledger-cli-home-'));
    const runId = 'run-00801fba-fd19-42e2-ba1c-6bf9b5b5f526';
    const testRunId = 'run-00801fba-fd19-42e2-ba1c-6bf9b5b5f527';
    try {
      for (const stateDir of [prodStateDir, otherStateDir, testStateDir]) {
        mkdirSync(join(stateDir, 'logs'), { recursive: true });
        new LogStore(join(stateDir, 'logs', 'logs.db')).close();
      }
      mkdirSync(join(home, '.elanous', 'logs'), { recursive: true });
      writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [
        { name: 'other', stateDir: otherStateDir, kind: 'prod', configDir: otherStateDir, pid: 0, startedAt: '' },
        { name: 'test:fixture', stateDir: testStateDir, kind: 'test', configDir: testStateDir, pid: 0, startedAt: '' },
      ] }), 'utf8');
      mkdirSync(join(otherStateDir, 'run-ledger'), { recursive: true });
      mkdirSync(join(testStateDir, 'run-ledger'), { recursive: true });
      writeFileSync(join(otherStateDir, 'run-ledger', `${runId}.jsonl`), `${JSON.stringify({ runId, event: 'elsewhere', data: {} })}\n`, 'utf8');
      writeFileSync(join(testStateDir, 'run-ledger', `${testRunId}.jsonl`), `${JSON.stringify({ runId: testRunId, event: 'test-only', data: {} })}\n`, 'utf8');
      const env = { HOME: home };

      const exact = runCli(prodStateDir, [runId, '--all'], env);
      expect(`status=${exact.status}`).toBe('status=0');
      expect(exact.stdout).toContain('elsewhere');
      expect(exact.stdout).toContain(`run ledger found in universe: other (${join(otherStateDir, 'run-ledger')})`);

      const prefix = runCli(prodStateDir, ['run-00801fba-fd19-42e2-ba1c-6bf9b5b5', '--all'], env);
      expect(`status=${prefix.status}`).toBe('status=0');
      expect(prefix.stdout).toContain('elsewhere');

      const json = runCli(prodStateDir, [runId, '--all', '--json'], env);
      expect(`status=${json.status}`).toBe('status=0');
      expect(json.stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ runId, event: 'elsewhere' }),
      ]);

      const excludedTest = runCli(prodStateDir, [testRunId, '--all'], env);
      expect(`status=${excludedTest.status}`).toBe('status=1');
      expect(excludedTest.stderr).toContain('checked');
      expect(excludedTest.stderr).not.toContain(join(testStateDir, 'run-ledger', `${testRunId}.jsonl`));

      const includedTest = runCli(prodStateDir, [testRunId, '--all', '--include-test'], env);
      expect(`status=${includedTest.status}`).toBe('status=0');
      expect(includedTest.stdout).toContain('test-only');
      expect(includedTest.stdout).toContain(`run ledger found in universe: test:fixture (${join(testStateDir, 'run-ledger')})`);
    } finally {
      for (const directory of [prodStateDir, otherStateDir, testStateDir, home]) rmSync(directory, { recursive: true, force: true });
    }
  }, 75_000);

  it('접두 모호성·중복 정확 ID·원장 읽기 실패는 후보나 오류를 내고 exit 1로 멈춘다', () => {
    const prodStateDir = mkdtempSync(join(tmpdir(), 'run-ledger-cli-ambiguous-prod-'));
    const otherStateDir = mkdtempSync(join(tmpdir(), 'run-ledger-cli-ambiguous-other-'));
    const home = mkdtempSync(join(tmpdir(), 'run-ledger-cli-ambiguous-home-'));
    const firstRunId = 'run-11111111-1111-4111-8111-111111111111';
    const secondRunId = 'run-11111111-1111-4111-8111-111111111112';
    try {
      for (const stateDir of [prodStateDir, otherStateDir]) {
        mkdirSync(join(stateDir, 'logs'), { recursive: true });
        new LogStore(join(stateDir, 'logs', 'logs.db')).close();
      }
      mkdirSync(join(home, '.elanous', 'logs'), { recursive: true });
      new LogStore(join(home, '.elanous', 'logs', 'logs.db')).close();
      writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [
        { name: 'other', stateDir: otherStateDir, kind: 'prod', configDir: otherStateDir, pid: 0, startedAt: '' },
      ] }), 'utf8');
      for (const stateDir of [home + '/.elanous', otherStateDir]) mkdirSync(join(stateDir, 'run-ledger'), { recursive: true });
      writeFileSync(join(home, '.elanous', 'run-ledger', `${firstRunId}.jsonl`), `${JSON.stringify({ runId: firstRunId, event: 'first', data: {} })}\n`, 'utf8');
      writeFileSync(join(otherStateDir, 'run-ledger', `${secondRunId}.jsonl`), `${JSON.stringify({ runId: secondRunId, event: 'second', data: {} })}\n`, 'utf8');
      const env = { HOME: home };

      const prefix = runCli(prodStateDir, ['run-11111111-1111-4111-8111-11111111111', '--all'], env);
      expect(`status=${prefix.status}`).toBe('status=1');
      expect(prefix.stderr).toContain('run ledger lookup is ambiguous');
      expect(prefix.stderr).toContain(firstRunId);
      expect(prefix.stderr).toContain(secondRunId);

      writeFileSync(join(otherStateDir, 'run-ledger', `${firstRunId}.jsonl`), `${JSON.stringify({ runId: firstRunId, event: 'duplicate', data: {} })}\n`, 'utf8');
      const duplicate = runCli(prodStateDir, [firstRunId, '--all'], env);
      expect(`status=${duplicate.status}`).toBe('status=1');
      expect(duplicate.stderr).toContain('run ledger lookup is ambiguous');
      expect(duplicate.stderr).toContain(`candidate runId=${firstRunId}`);
      expect(duplicate.stderr).toContain('universe=prod');
      expect(duplicate.stderr).toContain('universe=other');
      expect(duplicate.stderr).toContain(join(home, '.elanous', 'run-ledger'));
      expect(duplicate.stderr).toContain(join(otherStateDir, 'run-ledger'));

      writeFileSync(join(otherStateDir, 'run-ledger', `${secondRunId}.jsonl`), '{broken\n', 'utf8');
      const unreadable = runCli(prodStateDir, [secondRunId, '--all'], env);
      expect(`status=${unreadable.status}`).toBe('status=1');
      expect(unreadable.stderr).toContain('unable to load run ledger');
      expect(unreadable.stderr).toContain('invalid run ledger JSON');
    } finally {
      for (const directory of [prodStateDir, otherStateDir, home]) rmSync(directory, { recursive: true, force: true });
    }
  });

  it('merge attribution은 사람 출력과 JSON에 세 귀속 사실, 제외 수, 정의역 note를 낸다', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'merge-attribution-cli-'));
    try {
      const dir = join(stateDir, 'run-ledger');
      mkdirSync(dir, { recursive: true });
      const write = (runId: string, entries: object[]) => writeFileSync(join(dir, `${runId}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
      write(fixtureRunId('elanousMerged'), [{ timestamp: '2026-08-05T10:00:00.000Z', runId: fixtureRunId('elanousMerged'), event: 'merged', data: { number: 1, merged: true } }]);
      write(fixtureRunId('failedMerge'), [
        { timestamp: '2026-08-05T10:28:00.000Z', runId: fixtureRunId('failedMerge'), event: 'pr-opened', data: { number: 4 } },
        { timestamp: '2026-08-05T10:29:00.000Z', runId: fixtureRunId('failedMerge'), event: 'run-status', data: { stage: 'pr-opened', node: 'merge', mergeReason: 'merge-attempt-failed' } },
        { timestamp: '2026-08-05T10:30:00.000Z', runId: fixtureRunId('failedMerge'), event: 'merged', data: { number: 4, merged: false } },
      ]);
      write(fixtureRunId('humanOpenPr'), [
        { timestamp: '2026-08-05T10:59:00.000Z', runId: fixtureRunId('humanOpenPr'), event: 'pr-opened', data: { number: 5 } },
        { timestamp: '2026-08-05T11:00:00.000Z', runId: fixtureRunId('humanOpenPr'), event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr', mergeReason: 'no-auto-flag' } },
      ]);
      write(fixtureRunId('humanMerge'), [
        { timestamp: '2026-08-05T11:58:00.000Z', runId: fixtureRunId('humanMerge'), event: 'pr-opened', data: { number: 60 } },
        { timestamp: '2026-08-05T11:59:00.000Z', runId: fixtureRunId('humanMerge'), event: 'pr-opened', data: { number: 6 } },
        { timestamp: '2026-08-05T12:00:00.000Z', runId: fixtureRunId('humanMerge'), event: 'run-status', data: { stage: 'pr-opened', node: 'merge' } },
      ]);
      write(fixtureRunId('humanOpenPrWithoutNumber'), [{ timestamp: '2026-08-05T12:30:00.000Z', runId: fixtureRunId('humanOpenPrWithoutNumber'), event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr' } }]);
      write(fixtureRunId('humanOpenPrStatusNumberOnly'), [{ timestamp: '2026-08-05T12:45:00.000Z', runId: fixtureRunId('humanOpenPrStatusNumberOnly'), event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr', number: 7 } }]);
      write(fixtureRunId('contaminated'), [
        { timestamp: '2026-08-05T13:00:00.000Z', runId: fixtureRunId('contaminated'), event: 'merged', data: { number: 2, merged: true } },
        { timestamp: '2026-08-05T13:01:00.000Z', runId: fixtureRunId('contaminated'), event: 'merged', data: { number: 3, merged: true } },
        { timestamp: '2026-08-05T13:02:00.000Z', runId: fixtureRunId('contaminated'), event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr' } },
      ]);

      const withoutCrossStoreTotal = queryMergeAttribution({ dir });
      expect(withoutCrossStoreTotal.unattributable).toEqual({
        status: 'not-countable',
        reason: 'Merges that did not pass through elanous cannot be counted from run ledgers alone.',
      });
      expect(queryMergeAttribution({ dir, crossStoreMergedTotal: 1 }).unattributable).toEqual({ status: 'counted', count: 0 });
      expect(queryMergeAttribution({ dir, crossStoreMergedTotal: 3 }).unattributable).toEqual({ status: 'counted', count: 2 });
      const invalidCrossStoreTotal: { status: 'not-countable'; reason: string } = {
        status: 'not-countable',
        reason: 'The cross-store merged total must be a finite non-negative integer that is not less than the elanous merged count.',
      };
      for (const crossStoreMergedTotal of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(queryMergeAttribution({ dir, crossStoreMergedTotal }).unattributable).toEqual(invalidCrossStoreTotal);
      }
      expect(queryMergeAttribution({ dir: join(stateDir, 'empty-run-ledger'), crossStoreMergedTotal: 0 }).unattributable).toEqual({ status: 'counted', count: 0 });

      const text = runMergeAttributionCli(stateDir);
      expect(`status=${text.status}`).toBe('status=0');
      expect(text.stdout).toContain(`ledger directory: ${dir}`);
      expect(text.stdout).toContain('elanous merged: 1');
      expect(text.stdout).toContain('handed to human (no merge attempt): 3');
      expect(text.stdout).toContain('handed to human (merge attempted): 2');
      expect(text.stdout).toContain(`PR 5 runId=${fixtureRunId('humanOpenPr')} timestamp=2026-08-05T11:00:00.000Z mergeReason=no-auto-flag`);
      expect(text.stdout).toContain(`PR unknown runId=${fixtureRunId('humanOpenPrWithoutNumber')} timestamp=2026-08-05T12:30:00.000Z mergeReason=none`);
      expect(text.stdout).toContain(`PR unknown runId=${fixtureRunId('humanOpenPrStatusNumberOnly')} timestamp=2026-08-05T12:45:00.000Z mergeReason=none`);
      expect(text.stdout).toContain(`PR 4 runId=${fixtureRunId('failedMerge')} timestamp=2026-08-05T10:30:00.000Z mergeReason=merge-attempt-failed`);
      expect(text.stdout).toContain(`PR 6 runId=${fixtureRunId('humanMerge')} timestamp=2026-08-05T12:00:00.000Z mergeReason=none`);
      expect(text.stdout).toContain('unattributable: not-countable — Merges that did not pass through elanous cannot be counted from run ledgers alone.');
      expect(text.stdout).toContain('excluded merged entries: 2');
      expect(text.stdout).toContain('excluded ledgers: 1');
      expect(text.stdout).toContain('note: Reads only self-implement run ledgers; it does not read the log-store observations for review-loop auto-merged events or MergePullRequest tool calls.');

      const json = runMergeAttributionCli(stateDir, ['--json']);
      expect(`status=${json.status}`).toBe('status=0');
      expect(JSON.parse(json.stdout)).toMatchObject({
        elanousMergedEntries: [{ runId: fixtureRunId('elanousMerged') }],
        ledgerDirectory: dir,
        handedToHumanWithoutMergeAttemptCount: 3,
        handedToHumanAfterMergeAttemptCount: 2,
        handedToHumanEntries: [
          { prNumber: 4, runId: fixtureRunId('failedMerge'), timestamp: '2026-08-05T10:30:00.000Z', branch: 'after-merge-attempt', mergeReason: 'merge-attempt-failed' },
          { prNumber: 5, runId: fixtureRunId('humanOpenPr'), timestamp: '2026-08-05T11:00:00.000Z', branch: 'without-merge-attempt', mergeReason: 'no-auto-flag' },
          { prNumber: 6, runId: fixtureRunId('humanMerge'), timestamp: '2026-08-05T12:00:00.000Z', branch: 'after-merge-attempt' },
          { runId: fixtureRunId('humanOpenPrWithoutNumber'), timestamp: '2026-08-05T12:30:00.000Z', branch: 'without-merge-attempt' },
          { runId: fixtureRunId('humanOpenPrStatusNumberOnly'), timestamp: '2026-08-05T12:45:00.000Z', branch: 'without-merge-attempt' },
        ],
        unattributable: { status: 'not-countable' },
        excludedMergedEntryCount: 2,
        excludedLedgerCount: 1,
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('elanous self goal-source-distribution — 실물 argv', () => {
  it('세 goalSource 값과 부재를 각각 세며, malformed 원장은 읽지 못한 원장으로 분리한다', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'goal-source-distribution-'));
    try {
      const ledgerDir = join(stateDir, 'run-ledger');
      mkdirSync(ledgerDir, { recursive: true });
      const write = (runId: string, goalSource?: string) => writeFileSync(
        join(ledgerDir, `${runId}.jsonl`),
        `${JSON.stringify({ timestamp: '2026-08-11T00:00:00.000Z', runId, event: 'start', data: goalSource === undefined ? {} : { goalSource } })}\n`,
        'utf8',
      );
      write(fixtureRunId('elanousMerged'), 'authored-goal-file');
      write(fixtureRunId('failedMerge'), 'natural-language-dispatch');
      write(fixtureRunId('humanOpenPr'), 'no-goal-file');
      write(fixtureRunId('humanMerge'));
      writeFileSync(join(ledgerDir, `${fixtureRunId('lost')}.jsonl`), '{not json}\n', 'utf8');
      writeFileSync(join(ledgerDir, 'noncanonical.jsonl'), '{not json}\n', 'utf8');

      const text = runGoalSourceDistributionCli(stateDir);
      expect(`status=${text.status}`).toBe('status=0');
      expect(text.stdout).toContain('runs: 5');
      expect(text.stdout).toContain('authored-goal-file: 1');
      expect(text.stdout).toContain('natural-language-dispatch: 1');
      expect(text.stdout).toContain('no-goal-file: 1');
      expect(text.stdout).toContain('goalSource missing: 1');
      expect(text.stdout).toContain('unreadable ledgers: 1');
      expect(text.stdout).toContain('ledger directory missing: false');

      const json = runGoalSourceDistributionCli(stateDir, ['--json']);
      expect(`status=${json.status}`).toBe('status=0');
      expect(JSON.parse(json.stdout)).toMatchObject({
        ledgerDirectory: ledgerDir,
        runCount: 5,
        authoredGoalFileCount: 1,
        naturalLanguageDispatchCount: 1,
        noGoalFileCount: 1,
        goalSourceMissingCount: 1,
        unreadableLedgerCount: 1,
        ledgerDirectoryMissing: false,
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('열거 후 사라진 원장과 미지원 goalSource를 부재와 분리한다', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'goal-source-distribution-race-'));
    try {
      const ledgerDir = join(stateDir, 'run-ledger');
      mkdirSync(ledgerDir, { recursive: true });
      const disappearedRunId = fixtureRunId('active');
      const unknownRunId = fixtureRunId('finished');
      const unknownLedger = JSON.stringify({ timestamp: '2026-08-11T00:00:00.000Z', runId: unknownRunId, event: 'start', data: { goalSource: 'future-goal-source' } });
      const result = queryGoalSourceDistribution({
        dir: ledgerDir,
        list: () => [`${disappearedRunId}.jsonl`, `${unknownRunId}.jsonl`],
        read: (path) => {
          if (path.endsWith(`${disappearedRunId}.jsonl`)) {
            const error = new Error('file disappeared') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return unknownLedger;
        },
      });
      expect(result).toMatchObject({
        runCount: 2,
        unreadableLedgerCount: 1,
        goalSourceMissingCount: 0,
        authoredGoalFileCount: 0,
        naturalLanguageDispatchCount: 0,
        noGoalFileCount: 0,
        ledgerDirectoryMissing: false,
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('없는 원장 디렉터리와 정상 빈 디렉터리를 0건과 다른 상태로 낸다', () => {
    const missingStateDir = mkdtempSync(join(tmpdir(), 'goal-source-distribution-missing-'));
    const emptyStateDir = mkdtempSync(join(tmpdir(), 'goal-source-distribution-empty-'));
    try {
      const missing = runGoalSourceDistributionCli(missingStateDir, ['--json']);
      expect(`status=${missing.status}`).toBe('status=0');
      expect(JSON.parse(missing.stdout)).toMatchObject({
        runCount: 0,
        unreadableLedgerCount: 0,
        ledgerDirectoryMissing: true,
      });

      mkdirSync(join(emptyStateDir, 'run-ledger'), { recursive: true });
      const empty = runGoalSourceDistributionCli(emptyStateDir, ['--json']);
      expect(`status=${empty.status}`).toBe('status=0');
      expect(JSON.parse(empty.stdout)).toMatchObject({
        runCount: 0,
        unreadableLedgerCount: 0,
        ledgerDirectoryMissing: false,
      });

      const help = spawnSync(process.execPath, [join(sourceRoot, 'bin/elanous.mjs'), 'self', '--help'], { encoding: 'utf8', timeout: 60_000 });
      expect(`status=${help.status}`).toBe('status=0');
      expect(help.stdout).toContain('goal-source-distribution');
    } finally {
      rmSync(missingStateDir, { recursive: true, force: true });
      rmSync(emptyStateDir, { recursive: true, force: true });
    }
  });
});

// ⛔⭐ 리뷰 must-fix «반론»의 계약 (2026-08-06 · MANUAL-review-operations §3).
//    리뷰는 `src/index.ts` 의 unattributable 출력 수정을 두 라운드 「스코프 크리프」로 지적했으나,
//    `unattributable` 이 판별 유니온이라 그 수정은 touch-clean tsc 게이트에서 «강제»된다.
//    ⇒ 되돌리지 않고, 리뷰가 옳게 지적한 「테스트가 없다」를 여기서 닫는다.
describe('elanous self unfinished-runs — 실물 argv', () => {
  it('종결 기록 부재와 읽지 못한 원장을 구분하고, 마지막 브랜치 마디로 찾은 골의 경로와 탐색 범위를 낸다', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'unfinished-run-ledger-'));
    const cwd = mkdtempSync(join(tmpdir(), 'unfinished-run-goals-'));
    try {
      const ledgerDir = join(stateDir, 'run-ledger');
      const goalsDir = join(cwd, 'docs', 'goals');
      mkdirSync(ledgerDir, { recursive: true });
      mkdirSync(goalsDir, { recursive: true });
      writeFileSync(join(goalsDir, 'GOAL-observe-active-runs-a1b2c3d4-2026-08-06.txt'), '## TRACED PATHS\n1. src/self-implement/run-ledger.ts — ledger\n2. `src/index.ts`:12 — CLI\n', 'utf8');
      writeFileSync(join(goalsDir, 'GOAL-unreadable-goal-c3d4e5f6-2026-08-06.txt'), '## TRACED PATHS\n1. src/ignored.ts\n', 'utf8');
      writeFileSync(join(ledgerDir, `${fixtureRunId('active')}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-06T00:00:00.000Z', runId: fixtureRunId('active'), event: 'worktree', data: { branch: 'self-impl/observe-active-runs-a1b2c3d4' } })}\n`, 'utf8');
      const finishedEntries: RunLedgerEntry[] = [];
      const finishedObserver = makeRunObserver(fixtureRunId('finished'), (_category, _event, _data) => {}, undefined, (entry) => finishedEntries.push(entry));
      finishedObserver('worktree', { branch: 'self-impl/observe-active-runs-a1b2c3d4' });
      observeRunOutcome(finishedObserver, { stage: 'pr-opened', node: 'open-pr', outcome: undefined, worktreePath: undefined, review: undefined, completionDisposition: undefined, supervisorVerdict: undefined, mergeApprovalReceived: undefined, abandonedClassification: undefined, mergeReason: undefined });
      writeFileSync(join(ledgerDir, `${fixtureRunId('finished')}.jsonl`), `${finishedEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
      writeFileSync(join(ledgerDir, `${fixtureRunId('nonTerminalStatus')}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-06T00:00:00.000Z', runId: fixtureRunId('nonTerminalStatus'), event: 'worktree', data: { branch: 'self-impl/observe-active-runs-a1b2c3d4' } })}\n${JSON.stringify({ timestamp: '2026-08-06T00:00:01.000Z', runId: fixtureRunId('nonTerminalStatus'), event: 'run-status', data: { runStatus: 'running' } })}\n`, 'utf8');
      writeFileSync(join(ledgerDir, `${fixtureRunId('unreadableGoal')}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-06T00:00:00.000Z', runId: fixtureRunId('unreadableGoal'), event: 'worktree', data: { branch: 'self-impl/unreadable-goal-c3d4e5f6' } })}\n`, 'utf8');
      writeFileSync(join(ledgerDir, `${fixtureRunId('unknownGoal')}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-06T00:00:00.000Z', runId: fixtureRunId('unknownGoal'), event: 'worktree', data: { branch: 'self-impl/unknown-e5f6a7b8' } })}\n`, 'utf8');
      writeFileSync(join(ledgerDir, `${fixtureRunId('noBranch')}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-06T00:00:00.000Z', runId: fixtureRunId('noBranch'), event: 'run-start', data: {} })}\n`, 'utf8');
      writeFileSync(join(ledgerDir, `${fixtureRunId('lost')}.jsonl`), '{not json}\n', 'utf8');

      const unreadableGoalPath = join(goalsDir, 'GOAL-unreadable-goal-c3d4e5f6-2026-08-06.txt');
      const queried = queryUnfinishedRunLedgers({
        dir: ledgerDir,
        goalsDir,
        read: (path, encoding) => path === unreadableGoalPath ? (() => { throw new Error('goal read failed'); })() : readFileSync(path, encoding),
      });
      expect(queried.ledgerDirectory).toBe(ledgerDir);
      expect(queried.goalsDirectory).toBe(goalsDir);
      expect(queried.entries).toEqual([
        expect.objectContaining({ runId: fixtureRunId('active'), status: 'terminal-status-missing', plannedPathStatus: 'found-branch-fallback', goalDocumentPath: join(goalsDir, 'GOAL-observe-active-runs-a1b2c3d4-2026-08-06.txt'), goalDocumentSearchDirectory: goalsDir, plannedPaths: ['src/self-implement/run-ledger.ts', 'src/index.ts'] }),
        expect.objectContaining({ runId: fixtureRunId('nonTerminalStatus'), status: 'terminal-status-missing', plannedPathStatus: 'found-branch-fallback', goalDocumentPath: join(goalsDir, 'GOAL-observe-active-runs-a1b2c3d4-2026-08-06.txt'), goalDocumentSearchDirectory: goalsDir, plannedPaths: ['src/self-implement/run-ledger.ts', 'src/index.ts'] }),
        expect.objectContaining({ runId: fixtureRunId('unreadableGoal'), status: 'terminal-status-missing', plannedPathStatus: 'goal-document-unreadable', plannedPaths: [], goalDocumentPath: unreadableGoalPath }),
        expect.objectContaining({ runId: fixtureRunId('unknownGoal'), status: 'terminal-status-missing', plannedPathStatus: 'goal-document-not-found', plannedPaths: [] }),
        expect.objectContaining({ runId: fixtureRunId('noBranch'), status: 'terminal-status-missing', branch: null, plannedPathStatus: 'branch-missing', plannedPaths: [] }),
        expect.objectContaining({ runId: fixtureRunId('lost'), status: 'ledger-unreadable', plannedPathStatus: 'unknown', plannedPaths: [] }),
      ]);
      expect(queried.unreadableLedgerCount).toBe(1);
      const rendered = renderUnfinishedRunLedgers(queried);
      expect(rendered).toContain('unfinished runs: 5');
      expect(rendered).toContain('unreadable ledgers: 1');
      expect(rendered).toContain(`runId=${fixtureRunId('lost')} status=ledger-unreadable branch=unknown plannedPaths=unknown`);
      expect(rendered).toContain(`runId=${fixtureRunId('noBranch')} status=terminal-status-missing branch=unknown plannedPaths=branch-missing`);
      expect(rendered).toContain(`  goal document: ${join(goalsDir, 'GOAL-observe-active-runs-a1b2c3d4-2026-08-06.txt')}`);
      expect(rendered).toContain(`  goal document search directory: ${goalsDir}`);

      // ⭐ 사람 출구가 «JSON 과 같은 것»을 말한다(2026-08-11 · 🅢 지적).
      //   ⛔ `status` 는 미완 런에서 언제나 한 값이라 아무것도 안 가른다 — `lifecycle` 이 가른다.
      const lifecycleValues = queried.entries.map((entry) => entry.lifecycle);
      expect(new Set(lifecycleValues).size).toBeGreaterThan(1);   // ⛔ 모집단이 1이면 아래 단언이 공허해진다
      for (const entry of queried.entries) {
        // 기존 표기 «뒤»에 붙는다 — 앞부분의 이름·순서는 그대로다.
        expect(rendered).toContain(`lastActivityStatus=${entry.lastActivityStatus} lifecycle=${entry.lifecycle}`);
      }
      const lifecycleSummary = rendered.split('\n').find((line) => line.startsWith('lifecycle: '));
      expect(lifecycleSummary).toBeDefined();
      for (const value of new Set(lifecycleValues)) {
        expect(lifecycleSummary).toContain(`${value} ${lifecycleValues.filter((each) => each === value).length}`);
      }

      const textCli = runUnfinishedRunsCli(stateDir, cwd);
      expect(`status=${textCli.status}`).toBe('status=0');
      expect(textCli.stdout).toContain('unfinished runs: 5');
      expect(textCli.stdout).toContain('unreadable ledgers: 1');
      expect(textCli.stdout).toContain(`runId=${fixtureRunId('lost')} status=ledger-unreadable branch=unknown plannedPaths=unknown`);
      expect(textCli.stdout).toContain(`runId=${fixtureRunId('noBranch')} status=terminal-status-missing branch=unknown plannedPaths=branch-missing`);
      expect(textCli.stdout).toContain(`  goal document: ${join(realpathSync(goalsDir), 'GOAL-observe-active-runs-a1b2c3d4-2026-08-06.txt')}`);
      expect(textCli.stdout).toContain(`  goal document search directory: ${realpathSync(goalsDir)}`);

      const cli = runUnfinishedRunsCli(stateDir, cwd, ['--json']);
      expect(`status=${cli.status}`).toBe('status=0');
      expect(JSON.parse(cli.stdout)).toMatchObject({
        ledgerDirectory: ledgerDir,
        goalsDirectory: realpathSync(goalsDir),
        unreadableLedgerCount: 1,
        entries: [
          { runId: fixtureRunId('active'), status: 'terminal-status-missing', branch: 'self-impl/observe-active-runs-a1b2c3d4', plannedPathStatus: 'found-branch-fallback', goalDocumentPath: join(realpathSync(goalsDir), 'GOAL-observe-active-runs-a1b2c3d4-2026-08-06.txt'), goalDocumentSearchDirectory: realpathSync(goalsDir), plannedPaths: ['src/self-implement/run-ledger.ts', 'src/index.ts'] },
          { runId: fixtureRunId('nonTerminalStatus'), status: 'terminal-status-missing', branch: 'self-impl/observe-active-runs-a1b2c3d4', plannedPathStatus: 'found-branch-fallback', goalDocumentPath: join(realpathSync(goalsDir), 'GOAL-observe-active-runs-a1b2c3d4-2026-08-06.txt'), goalDocumentSearchDirectory: realpathSync(goalsDir), plannedPaths: ['src/self-implement/run-ledger.ts', 'src/index.ts'] },
          { runId: fixtureRunId('unreadableGoal'), status: 'terminal-status-missing', branch: 'self-impl/unreadable-goal-c3d4e5f6', plannedPathStatus: 'found-branch-fallback', plannedPaths: ['src/ignored.ts'] },
          { runId: fixtureRunId('unknownGoal'), status: 'terminal-status-missing', branch: 'self-impl/unknown-e5f6a7b8', plannedPathStatus: 'goal-document-not-found', plannedPaths: [] },
          { runId: fixtureRunId('noBranch'), status: 'terminal-status-missing', branch: null, plannedPathStatus: 'branch-missing', plannedPaths: [] },
          { runId: fixtureRunId('lost'), status: 'ledger-unreadable' },
        ],
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('경로 필터는 일치 런과 경로를 읽지 못한 미상 런만 따로 세고 실물 CLI로 전달한다', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'unfinished-run-ledger-path-filter-'));
    const cwd = mkdtempSync(join(tmpdir(), 'unfinished-run-goals-path-filter-'));
    try {
      const ledgerDir = join(stateDir, 'run-ledger');
      const goalsDir = join(cwd, 'docs', 'goals');
      mkdirSync(ledgerDir, { recursive: true });
      mkdirSync(goalsDir, { recursive: true });
      const matchingGoal = join(goalsDir, 'GOAL-matching-a1b2c3d4-2026-08-10.txt');
      const otherGoal = join(goalsDir, 'GOAL-other-b2c3d4e5-2026-08-10.txt');
      writeFileSync(matchingGoal, 'Original ask (verbatim, unmodified):\n```\n대상 경로: src/self-implement/goal-author.ts\n```\n## TRACED PATHS\n1. src/self-implement/goal-author.ts\n', 'utf8');
      writeFileSync(otherGoal, 'Original ask (verbatim, unmodified):\n```\n대상 경로: src/self-implement/headless-elanous-driver.ts\n```\n## TRACED PATHS\n1. src/self-implement/headless-elanous-driver.ts\n', 'utf8');
      const matchingRunId = fixtureRunId('active');
      const otherRunId = fixtureRunId('nonTerminalStatus');
      const unknownRunId = fixtureRunId('unknownGoal');
      writeFileSync(join(ledgerDir, `${matchingRunId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-10T00:00:00.000Z', runId: matchingRunId, event: 'start', data: { goalFile: matchingGoal } })}\n`, 'utf8');
      writeFileSync(join(ledgerDir, `${otherRunId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-10T00:00:00.000Z', runId: otherRunId, event: 'start', data: { goalFile: otherGoal } })}\n`, 'utf8');
      writeFileSync(join(ledgerDir, `${unknownRunId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-10T00:00:00.000Z', runId: unknownRunId, event: 'run-start', data: { branch: 'self-impl/missing-c3d4e5f6' } })}\n`, 'utf8');

      const queried = queryUnfinishedRunLedgers({ dir: ledgerDir, goalsDir, path: 'src/self-implement/goal-author.ts' });
      expect(queried.pathFilter).toBe('src/self-implement/goal-author.ts');
      expect(queried.matchingPathCount).toBe(1);
      expect(queried.unknownPathCount).toBe(1);
      expect(queried.entries).toEqual([
        expect.objectContaining({
          runId: matchingRunId,
          plannedPaths: ['src/self-implement/goal-author.ts'],
          plannedPathStatus: 'found-ledger-goal-file',
          declaredPaths: ['src/self-implement/goal-author.ts'],
          declaredPathStatus: 'found',
          pathMatchReasons: { 'src/self-implement/goal-author.ts': 'both' },
        }),
        expect.objectContaining({
          runId: unknownRunId,
          plannedPaths: [],
          plannedPathStatus: 'goal-document-not-found',
          declaredPaths: [],
          declaredPathStatus: 'unknown',
          pathMatchReasons: {},
        }),
      ]);
      const unfiltered = queryUnfinishedRunLedgers({ dir: ledgerDir, goalsDir });
      expect(unfiltered.entries.find((entry) => entry.runId === otherRunId)).toMatchObject({
        plannedPaths: ['src/self-implement/headless-elanous-driver.ts'],
        plannedPathStatus: 'found-ledger-goal-file',
        declaredPaths: ['src/self-implement/headless-elanous-driver.ts'],
        declaredPathStatus: 'found',
        pathMatchReasons: { 'src/self-implement/headless-elanous-driver.ts': 'both' },
      });
      expect(renderUnfinishedRunLedgers(queried)).toContain('matching paths: 1\nunknown paths: 1');

      const cli = runUnfinishedRunsCli(stateDir, cwd, ['--path', 'src/self-implement/goal-author.ts']);
      expect(`status=${cli.status}`).toBe('status=0');
      expect(cli.stdout).toContain('matching paths: 1');
      expect(cli.stdout).toContain('unknown paths: 1');
      expect(cli.stdout).toContain(`runId=${matchingRunId}`);
      expect(cli.stdout).toContain(`runId=${unknownRunId}`);
      expect(cli.stdout).not.toContain(`runId=${otherRunId}`);

      const jsonCli = runUnfinishedRunsCli(stateDir, cwd, ['--path', 'src/self-implement/goal-author.ts', '--json']);
      expect(`status=${jsonCli.status}`).toBe('status=0');
      expect(JSON.parse(jsonCli.stdout)).toMatchObject({ pathFilter: 'src/self-implement/goal-author.ts', matchingPathCount: 1, unknownPathCount: 1 });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('원장 goalFile을 브랜치 suffix보다 우선하고 마지막 활동 시각의 결손과 불량 값을 세 표면에서 null로 정규화한다', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'unfinished-run-ledger-authoritative-'));
    const cwd = mkdtempSync(join(tmpdir(), 'unfinished-run-goals-authoritative-'));
    try {
      const ledgerDir = join(stateDir, 'run-ledger');
      const goalsDir = join(cwd, 'docs', 'goals');
      mkdirSync(ledgerDir, { recursive: true });
      mkdirSync(goalsDir, { recursive: true });
      const authoritativeGoal = join(goalsDir, 'GOAL-authoritative-a1b362c8-2026-08-09.txt');
      writeFileSync(authoritativeGoal, '## TRACED PATHS\n1. src/self-implement/run-ledger.ts\n', 'utf8');
      writeFileSync(join(goalsDir, 'GOAL-decoy-0bf272e2-2026-08-09.txt'), '## TRACED PATHS\n1. src/decoy.ts\n', 'utf8');
      writeFileSync(join(ledgerDir, `${fixtureRunId('ledgerGoal')}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-09T00:00:00.000Z', runId: fixtureRunId('ledgerGoal'), event: 'start', data: { branch: 'self-impl/incorrect-0bf272e2', goalFile: authoritativeGoal } })}\n`, 'utf8');
      writeFileSync(join(ledgerDir, `${fixtureRunId('timestampMissing')}.jsonl`), `${JSON.stringify({ runId: fixtureRunId('timestampMissing'), event: 'start', data: {} })}\n`, 'utf8');
      writeFileSync(join(ledgerDir, `${fixtureRunId('timestampInvalid')}.jsonl`), `${JSON.stringify({ timestamp: 'not-a-timestamp', runId: fixtureRunId('timestampInvalid'), event: 'start', data: {} })}\n`, 'utf8');
      writeFileSync(join(ledgerDir, `${fixtureRunId('timestampEmpty')}.jsonl`), `${JSON.stringify({ timestamp: '', runId: fixtureRunId('timestampEmpty'), event: 'start', data: {} })}\n`, 'utf8');

      const queried = queryUnfinishedRunLedgers({ dir: ledgerDir, goalsDir });
      expect(queried.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: fixtureRunId('ledgerGoal'), plannedPathStatus: 'found-ledger-goal-file', goalDocumentPath: authoritativeGoal, plannedPaths: ['src/self-implement/run-ledger.ts'], lastActivityTimestamp: '2026-08-09T00:00:00.000Z', lastActivityStatus: 'available' }),
        expect.objectContaining({ runId: fixtureRunId('timestampMissing'), lastActivityTimestamp: null, lastActivityAgeMs: null, lastActivityStatus: 'timestamp-missing' }),
        expect.objectContaining({ runId: fixtureRunId('timestampInvalid'), lastActivityTimestamp: null, lastActivityAgeMs: null, lastActivityStatus: 'timestamp-invalid' }),
        expect.objectContaining({ runId: fixtureRunId('timestampEmpty'), lastActivityTimestamp: null, lastActivityAgeMs: null, lastActivityStatus: 'timestamp-invalid' }),
      ]));
      expect(renderUnfinishedRunLedgers(queried)).toContain(`runId=${fixtureRunId('timestampInvalid')} status=terminal-status-missing branch=unknown plannedPaths=branch-missing declaredPaths=unknown lastActivity=null lastActivityAgeMs=null lastActivityStatus=timestamp-invalid`);
      expect(renderUnfinishedRunLedgers(queried)).toContain(`runId=${fixtureRunId('timestampEmpty')} status=terminal-status-missing branch=unknown plannedPaths=branch-missing declaredPaths=unknown lastActivity=null lastActivityAgeMs=null lastActivityStatus=timestamp-invalid`);

      const textCli = runUnfinishedRunsCli(stateDir, cwd);
      expect(`status=${textCli.status}`).toBe('status=0');
      expect(textCli.stdout).toContain(`runId=${fixtureRunId('timestampMissing')} status=terminal-status-missing branch=unknown plannedPaths=branch-missing declaredPaths=unknown lastActivity=null lastActivityAgeMs=null lastActivityStatus=timestamp-missing`);
      expect(textCli.stdout).toContain(`runId=${fixtureRunId('timestampEmpty')} status=terminal-status-missing branch=unknown plannedPaths=branch-missing declaredPaths=unknown lastActivity=null lastActivityAgeMs=null lastActivityStatus=timestamp-invalid`);

      const cli = runUnfinishedRunsCli(stateDir, cwd, ['--json']);
      expect(`status=${cli.status}`).toBe('status=0');
      expect(JSON.parse(cli.stdout).entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: fixtureRunId('ledgerGoal'), plannedPathStatus: 'found-ledger-goal-file', goalDocumentPath: authoritativeGoal, plannedPaths: ['src/self-implement/run-ledger.ts'] }),
        expect.objectContaining({ runId: fixtureRunId('timestampMissing'), lastActivityTimestamp: null, lastActivityAgeMs: null, lastActivityStatus: 'timestamp-missing' }),
        expect.objectContaining({ runId: fixtureRunId('timestampInvalid'), lastActivityTimestamp: null, lastActivityAgeMs: null, lastActivityStatus: 'timestamp-invalid' }),
        expect.objectContaining({ runId: fixtureRunId('timestampEmpty'), lastActivityTimestamp: null, lastActivityAgeMs: null, lastActivityStatus: 'timestamp-invalid' }),
      ]));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('골 문서 탐색의 부재·중복·디렉터리 판독 실패를 서로 다른 예정 경로 상태로 보존한다', () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'unfinished-run-goal-lookup-ledger-'));
    const goalsDir = mkdtempSync(join(tmpdir(), 'unfinished-run-goal-lookup-goals-'));
    const branch = 'self-impl/observe-goal-lookup-a1b2c3d4';
    const writeLedger = (runId: string) => writeFileSync(join(ledgerDir, `${runId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-06T00:00:00.000Z', runId, event: 'worktree', data: { branch } })}\n`, 'utf8');
    try {
      writeLedger(fixtureRunId('notFound'));
      expect(queryUnfinishedRunLedgers({ dir: ledgerDir, goalsDir }).entries).toEqual([
        expect.objectContaining({ runId: fixtureRunId('notFound'), plannedPathStatus: 'goal-document-not-found', goalDocumentPath: null }),
      ]);

      writeFileSync(join(goalsDir, 'GOAL-first-a1b2c3d4-2026-08-06.txt'), '## TRACED PATHS\n1. src/first.ts\n', 'utf8');
      writeFileSync(join(goalsDir, 'GOAL-second-a1b2c3d4-2026-08-07.txt'), '## TRACED PATHS\n1. src/second.ts\n', 'utf8');
      expect(queryUnfinishedRunLedgers({ dir: ledgerDir, goalsDir }).entries).toEqual([
        expect.objectContaining({ runId: fixtureRunId('notFound'), plannedPathStatus: 'goal-document-ambiguous', goalDocumentPath: null, plannedPaths: [] }),
      ]);

      const unreadableGoals = join(goalsDir, 'unreadable');
      const queried = queryUnfinishedRunLedgers({
        dir: ledgerDir,
        goalsDir: unreadableGoals,
        list: (path) => {
          if (path === ledgerDir) return [`${fixtureRunId('notFound')}.jsonl`];
          throw new Error('goal directory unavailable');
        },
      });
      expect(queried.entries).toEqual([
        expect.objectContaining({ runId: fixtureRunId('notFound'), plannedPathStatus: 'goal-directory-unreadable', goalDocumentPath: null, plannedPaths: [] }),
      ]);
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
      rmSync(goalsDir, { recursive: true, force: true });
    }
  });

  it('브랜치 suffix의 정규식 메타문자를 리터럴로 비교해 구문 오류와 과잉 매칭을 막는다', () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'unfinished-run-literal-suffix-ledger-'));
    const goalsDir = mkdtempSync(join(tmpdir(), 'unfinished-run-literal-suffix-goals-'));
    try {
      const writeLedger = (runId: string, branch: string) => writeFileSync(join(ledgerDir, `${runId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-06T00:00:00.000Z', runId, event: 'worktree', data: { branch } })}\n`, 'utf8');
      writeLedger(fixtureRunId('bracket'), 'self-impl/literal-[');
      writeLedger(fixtureRunId('dotStar'), 'self-impl/literal-.*');
      writeFileSync(join(goalsDir, 'GOAL-literal-[-2026-08-06.txt'), '## TRACED PATHS\n1. src/bracket.ts\n', 'utf8');
      writeFileSync(join(goalsDir, 'GOAL-literal-not-literal-2026-08-06.txt'), '## TRACED PATHS\n1. src/decoy.ts\n', 'utf8');

      expect(queryUnfinishedRunLedgers({ dir: ledgerDir, goalsDir }).entries).toEqual([
        expect.objectContaining({ runId: fixtureRunId('bracket'), plannedPathStatus: 'found-branch-fallback', plannedPaths: ['src/bracket.ts'] }),
        expect.objectContaining({ runId: fixtureRunId('dotStar'), plannedPathStatus: 'goal-document-not-found', plannedPaths: [] }),
      ]);
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
      rmSync(goalsDir, { recursive: true, force: true });
    }
  });

  it('텍스트 CLI가 원장 디렉터리 부재와 정상 빈 원장 범위를 다르게 표시한다', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'unfinished-run-ledger-scope-'));
    const cwd = mkdtempSync(join(tmpdir(), 'unfinished-run-goals-scope-'));
    try {
      const missing = runUnfinishedRunsCli(stateDir, cwd);
      expect(`status=${missing.status}`).toBe('status=0');
      expect(missing.stdout).toContain(`ledger directory: ${join(stateDir, 'run-ledger')}`);
      expect(missing.stdout).toContain('ledger directory status: missing (no run ledgers were scanned)');
      expect(missing.stdout).toContain('unfinished runs: 0');

      mkdirSync(join(stateDir, 'run-ledger'), { recursive: true });
      const empty = runUnfinishedRunsCli(stateDir, cwd);
      expect(`status=${empty.status}`).toBe('status=0');
      expect(empty.stdout).toContain('ledger directory status: present');
      expect(empty.stdout).toContain('unfinished runs: 0');
      expect(empty.stdout).not.toContain('missing (no run ledgers were scanned)');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('run screen key resolution', () => {
  it('returns the newest matching headless.spawn screen key through the injected log-store seam', () => {
    const runId = 'run-00000000-0000-4000-8000-000000000099';
    const rows: LogStoreRow[] = [
      { id: 1, ts: '2026-08-07T00:00:00.000Z', ts_ms: 0, level: 'info', instance: 'test', surface: 'test', category: 'self-implement', event: 'headless.spawn', session_id: null, trace_id: null, data: JSON.stringify({ runId, screenKey: 'old-space' }) },
      { id: 2, ts: '2026-08-07T00:01:00.000Z', ts_ms: 0, level: 'info', instance: 'test', surface: 'test', category: 'self-implement', event: 'headless.spawn', session_id: null, trace_id: null, data: JSON.stringify({ runId, screenKey: 'new-space' }) },
    ];
    const store: RunChainLogStore = { query: () => rows };

    expect(queryRunScreenKey(runId, { logStorePath: '/fixture/logs.db', logStore: store })).toMatchObject({
      runId,
      screenKey: 'new-space',
      matchedSpawnCount: 2,
      logStoreStatus: 'read',
    });
  });

  // ⛔⭐⭐ 리뷰 should-fix — `ts` 가 파싱 불가하면 «첫 행에 고정»됐다.
  //   `Date.parse` 가 둘 다 `NaN` 이면 `NaN !== NaN` 이 «참»이라 시각 분기로 들어가고,
  //   그 안의 `NaN > NaN` 은 «거짓»이라 항상 `current` 가 남는다 ⇒ `row.id` 타이브레이크에
  //   ***영영 도달하지 못한다.*** 「가장 최근」이라 광고하면서 「가장 오래된」을 냈다.
  it('ts 가 파싱 불가해도 «행 id» 로 최신을 고른다 — 첫 행에 고정되지 않는다', () => {
    const runId = 'run-00000000-0000-4000-8000-000000000093';
    const row = (id: number, screenKey: string): LogStoreRow => ({
      id, ts: 'not-a-timestamp', ts_ms: 0, level: 'info', instance: 'test', surface: 'test',
      category: 'self-implement', event: 'headless.spawn', session_id: null, trace_id: null,
      data: JSON.stringify({ runId, screenKey }),
    });
    const store: RunChainLogStore = { query: () => [row(1, 'old-space'), row(2, 'new-space')] };
    expect(queryRunScreenKey(runId, { logStorePath: '/fixture/logs.db', logStore: store }))
      .toMatchObject({ screenKey: 'new-space', matchedSpawnCount: 2, logStoreStatus: 'read' });
  });

  it('returns a value instead of throwing when no matching headless.spawn exists', () => {
    const store: RunChainLogStore = { query: () => [] };
    expect(queryRunScreenKey('run-00000000-0000-4000-8000-000000000098', { logStorePath: '/fixture/logs.db', logStore: store }))
      .toMatchObject({ screenKey: null, matchedSpawnCount: 0, lastEvent: null, logStoreStatus: 'read' });
  });

  it('⭐ runId 를 «다른 필드»에 담은 이벤트도 마지막 이벤트로 잡는다 — grep 폴백(2026-08-12 라이브 실측)', () => {
    // 📏 실물: `harness.clean/removed` 는 runId 를 payload 의 `reason` 문자열 «안»에 박는다:
    //   reason: "abandoned; … ownership=recorded:owner=dev:run-57af0be1-…"  ⊕ `runId` 필드 «없음».
    // ⛔ 종전 필터(`data.runId === runId`)가 그것을 버려 「이 runId의 이벤트가 «없습니다»」라는
    //   ***거짓***을 냈다 — 그 런은 「정리됨(cleaned)」이었다.
    const runId = 'run-00000000-0000-4000-8000-000000000099';
    const store: RunChainLogStore = {
      query: () => [{
        id: 7, ts: '2026-08-04T22:50:07.775Z', ts_ms: 1, level: 'info', instance: 'test', surface: 'test',
        category: 'harness.clean', event: 'removed', session_id: null, trace_id: null,
        data: JSON.stringify({ branch: 'x', hadWorktree: true, reason: `abandoned; ownership=recorded:owner=dev:${runId}` }),
      }],
    };
    const result = queryRunScreenKey(runId, { logStorePath: '/fixture/logs.db', logStore: store });
    expect(result.screenKey).toBeNull();
    expect(result.lastEvent).toMatchObject({ category: 'harness.clean', event: 'removed' });
    expect(classifyRunScreenMissing(result.lastEvent)).toBe('cleaned');
  });

  it('⭐ 필드 일치가 «있으면» 그쪽이 이긴다 — 폴백이 정확도를 낮추지 않는다', () => {
    const runId = 'run-00000000-0000-4000-8000-000000000097';
    const store: RunChainLogStore = {
      query: () => [
        { id: 1, ts: '2026-08-01T00:00:00.000Z', ts_ms: 1, level: 'info', instance: 'test', surface: 'test',
          category: 'harness.clean', event: 'removed', session_id: null, trace_id: null,
          data: JSON.stringify({ reason: `mentions ${runId} only in text` }) },
        { id: 2, ts: '2026-07-01T00:00:00.000Z', ts_ms: 2, level: 'info', instance: 'test', surface: 'test',
          category: 'dev-pipeline', event: 'error', session_id: null, trace_id: null,
          data: JSON.stringify({ runId }) },
      ],
    };
    const result = queryRunScreenKey(runId, { logStorePath: '/fixture/logs.db', logStore: store });
    // ⛔ 시각으로는 harness.clean 이 더 최근이지만, «필드 일치»가 하나라도 있으면 그 무리 안에서 고른다
    expect(result.lastEvent).toMatchObject({ category: 'dev-pipeline', event: 'error' });
    expect(classifyRunScreenMissing(result.lastEvent)).toBe('pipeline-failed');
  });

  it('classifies every missing-screen state and returns the latest matching event through the injected store', () => {
    expect(classifyRunScreenMissing({ category: 'clarification', event: 'waiting' })).toBe('awaiting-start');
    expect(classifyRunScreenMissing({ category: 'goal-author', event: 'drafted' })).toBe('awaiting-start');
    expect(classifyRunScreenMissing({ category: 'goal-author.clarify', event: 'answer-injected' })).toBe('awaiting-start');
    expect(classifyRunScreenMissing({ category: 'authorization', event: 'granted' })).toBe('unclassified');
    expect(classifyRunScreenMissing({ category: 'self-implement', event: 'authorization' })).toBe('unclassified');
    expect(classifyRunScreenMissing({ category: 'dev-pipeline', event: 'error' })).toBe('pipeline-failed');
    expect(classifyRunScreenMissing({ category: 'harness.clean', event: 'removed' })).toBe('cleaned');
    expect(classifyRunScreenMissing(null)).toBe('not-found');
    expect(classifyRunScreenMissing({ category: 'self-implement', event: 'start' })).toBe('unclassified');

    const runId = 'run-00000000-0000-4000-8000-000000000091';
    const rows: LogStoreRow[] = [
      { id: 1, ts: '2026-08-07T00:00:00.000Z', ts_ms: 0, level: 'info', instance: 'test', surface: 'test', category: 'self-implement', event: 'start', session_id: null, trace_id: null, data: JSON.stringify({ runId }) },
      { id: 2, ts: '2026-08-07T00:02:00.000Z', ts_ms: 0, level: 'error', instance: 'test', surface: 'test', category: 'dev-pipeline', event: 'error', session_id: null, trace_id: null, data: JSON.stringify({ runId }) },
    ];
    const store: RunChainLogStore = { query: () => rows };
    expect(queryRunScreenKey(runId, { logStorePath: '/fixture/logs.db', logStore: store })).toMatchObject({
      screenKey: null,
      matchedSpawnCount: 0,
      lastEvent: { category: 'dev-pipeline', event: 'error', timestamp: '2026-08-07T00:02:00.000Z' },
      logStoreStatus: 'read',
    });
  });

  it('self screen --run resolves the logged key, rejects ambiguous input, and reports a missing frame without throwing', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'run-screen-cli-'));
    const runId = 'run-00000000-0000-4000-8000-000000000097';
    try {
      const logPath = join(stateDir, 'logs', 'logs.db');
      mkdirSync(dirname(logPath), { recursive: true });
      const store = new LogStore(logPath, { instance: 'test' });
      store.insertBatch([{ surface: 'test', rec: { ts: '2026-08-07T00:00:00.000Z', category: 'self-implement', event: 'headless.spawn', data: { runId, screenKey: 'resolved-screen' } } }]);
      store.close();
      writeHarnessScreen('resolved-screen', 'resolved frame', { ELANOUS_STATE_DIR: stateDir });

      const resolved = runScreenCli(stateDir, ['--run', runId]);
      expect(`status=${resolved.status}`).toBe('status=0');
      expect(resolved.stdout).toContain(`하니스 화면: resolved-screen · runId=${runId}`);
      expect(resolved.stdout).toContain('resolved frame');

      const collisionRunId = 'run-00000000-0000-4000-8000-000000000094';
      const collisionStore = new LogStore(logPath, { instance: 'test' });
      collisionStore.insertBatch([{ surface: 'test', rec: { ts: '2026-08-07T00:00:30.000Z', category: 'self-implement', event: 'headless.spawn', data: { runId: collisionRunId, screenKey: 'foo' } } }]);
      collisionStore.close();
      writeHarnessScreen('foo-old', 'wrong partial-match frame', { ELANOUS_STATE_DIR: stateDir });

      const exactMissing = runScreenCli(stateDir, ['--run', collisionRunId]);
      expect(`status=${exactMissing.status}`).toBe('status=0');
      expect(exactMissing.stdout).toContain(`화면 버퍼 없음: foo (runId=${collisionRunId} 해석됨·아직 프레임 미기록)`);
      expect(exactMissing.stdout).not.toContain('wrong partial-match frame');

      writeHarnessScreen('foo', 'exact frame', { ELANOUS_STATE_DIR: stateDir });
      const exact = runScreenCli(stateDir, ['--run', collisionRunId]);
      expect(`status=${exact.status}`).toBe('status=0');
      expect(exact.stdout).toContain(`하니스 화면: foo · runId=${collisionRunId}`);
      expect(exact.stdout).toContain('exact frame');
      expect(exact.stdout).not.toContain('wrong partial-match frame');

      const ambiguous = runScreenCli(stateDir, ['--run', runId, '--space', 'resolved-screen']);
      expect(`status=${ambiguous.status}`).toBe('status=2');
      expect(`${ambiguous.stdout}${ambiguous.stderr}`).toContain('--run 과 --space 는 함께 사용할 수 없습니다.');

      // ⛔⭐⭐ 리뷰 should-fix — **해석 실패가 `0` 이면 자동화가 「화면을 봤다」로 읽는다.**
      //   사람은 문장을 읽지만 스크립트는 «종료 코드»만 본다. 사유는 갈라서 내되 코드는 «0 이 아니다».
      //   ⚠️ `2` 는 위 「동시 지정」이 쓰는 «사용법 오류»다 — 해석 실패는 `1` 이다(서로 다른 값이어야 갈린다).
      const unknownRun = runScreenCli(stateDir, ['--run', 'run-00000000-0000-4000-8000-000000000092']);
      expect(`status=${unknownRun.status}`).toBe('status=1');
      expect(`${unknownRun.stdout}${unknownRun.stderr}`).toContain('이 runId의 이벤트가 없습니다. runId와 인스턴스 우주를 확인하세요. 마지막 이벤트: 없음');

      // ⛔⭐⭐ 리뷰 must-fix — **`--run ''` «단독»이 핵심 누출 경로다.** 종전엔 `if (opts.run)` 이
      //   truthy 라 해석을 통째로 건너뛰고 ***조용히 최신 화면(= 남의 런일 수 있다)***을 냈다.
      //   ⇒ 이 옵션이 «막으려던 바로 그 사고»를 이 옵션이 다시 만들었다. 그래서 «단독»을 따로 잰다.
      const emptyRunAlone = runScreenCli(stateDir, ['--run', '']);
      expect(`status=${emptyRunAlone.status}`).toBe('status=2');
      expect(`${emptyRunAlone.stdout}${emptyRunAlone.stderr}`).toContain('--run 에 빈 runId 를 줄 수 없습니다.');
      expect(emptyRunAlone.stdout).not.toContain('resolved frame');

      // ⛔⭐ 그리고 «충돌 조합»에서도 뚫렸다(같은 truthy 결함의 다른 얼굴).
      const emptyRunWithSpace = runScreenCli(stateDir, ['--run', '', '--space', 'resolved-screen']);
      expect(`status=${emptyRunWithSpace.status}`).toBe('status=2');
      expect(`${emptyRunWithSpace.stdout}${emptyRunWithSpace.stderr}`).toContain('--run 과 --space 는 함께 사용할 수 없습니다.');

      const noStoreDir = mkdtempSync(join(tmpdir(), 'run-screen-cli-nostore-'));
      try {
        const missingStore = runScreenCli(noStoreDir, ['--run', runId]);
        expect(`status=${missingStore.status}`).toBe('status=1');
        expect(`${missingStore.stdout}${missingStore.stderr}`).toContain('로그 스토어 missing');
      } finally {
        rmSync(noStoreDir, { recursive: true, force: true });
      }

      const noFrameRunId = 'run-00000000-0000-4000-8000-000000000096';
      const writable = new LogStore(logPath, { instance: 'test' });
      writable.insertBatch([{ surface: 'test', rec: { ts: '2026-08-07T00:01:00.000Z', category: 'self-implement', event: 'headless.spawn', data: { runId: noFrameRunId, screenKey: 'not-yet-written' } } }]);
      writable.close();
      const missingFrame = runScreenCli(stateDir, ['--run', noFrameRunId]);
      expect(`status=${missingFrame.status}`).toBe('status=0');
      expect(missingFrame.stdout).toContain(`화면 버퍼 없음: not-yet-written (runId=${noFrameRunId} 해석됨·아직 프레임 미기록)`);

      // ⛔⭐ **계약이 바뀌었다: 해석 실패는 «0 이 아니다»**(리뷰 should-fix).
      //   ⚠️ 「화면 버퍼 없음」(바로 위)은 «해석에 성공했고 프레임만 아직 없는» 것이라 `0` 이 맞다 —
      //   그것과 「해석 자체가 실패」를 종료 코드로 «가른다».
      const noSpawnRunId = 'run-00000000-0000-4000-8000-000000000095';
      const failedStore = new LogStore(logPath, { instance: 'test' });
      failedStore.insertBatch([{ surface: 'test', rec: { ts: new Date(Date.now() - 60_000).toISOString(), category: 'dev-pipeline', event: 'error', data: { runId: noSpawnRunId } } }]);
      failedStore.close();
      const noSpawn = runScreenCli(stateDir, ['--run', noSpawnRunId]);
      const noSpawnOutput = `${noSpawn.stdout}${noSpawn.stderr}`;
      expect(`status=${noSpawn.status}`).toBe('status=1');
      expect(noSpawnOutput).toContain('파이프라인이 오류로 멈췄습니다. 해당 error를 읽어 원인을 수리하세요.');
      expect(noSpawnOutput).toContain('마지막 이벤트: dev-pipeline/error');
      expect(noSpawnOutput).toContain('분 전');
      expect(noSpawnOutput).not.toContain('headless.spawn 기록 없음');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  // The observed runtime is 16.8–20.8s; retain margin beyond the 60s child timeout so its diagnostic wins.
  }, 75_000);
});

describe('formatUnattributableDetail', () => {
  it('셀 수 없으면 사유를, 셀 수 있으면 수를 낸다', () => {
    expect(formatUnattributableDetail({ status: 'not-countable', reason: '교차 스토어 합계 없음' }))
      .toBe('교차 스토어 합계 없음');
    expect(formatUnattributableDetail({ status: 'counted', count: 0 })).toBe('0');
    expect(formatUnattributableDetail({ status: 'counted', count: 7 })).toBe('7');
  });
});
