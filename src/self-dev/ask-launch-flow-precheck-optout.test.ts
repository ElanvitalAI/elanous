import { expect, test } from 'bun:test';
import { runAskLaunchFlow, type AskLaunchFlowDeps } from './ask-launch-flow.js';
import { CLI_DEV_ASK_ENTRANCE } from './entrance-registry.js';
import type { AskPreflightDeps, PreflightPreexistingFailuresStatus } from './launch-preflight.js';
import type { RunningRunsResult } from '../self-implement/running-runs.js';

const PASS_GOAL = [
  '대상 경로: src/target.ts',
  '- GoalType: implement',
  '',
  'CELL-A — 무엇을 왜',
  '',
  '완료선:',
  '- 단언 — bun test src/target.test.ts',
  '',
  '범위 밖=FU: 없음',
  '',
  '## PROBLEM',
  '- x',
].join('\n');

const NEEDS_REWRITE_GOAL = PASS_GOAL.replace('- 단언 — bun test src/target.test.ts', '- 잘 동작한다');

const FIXED_GOAL = `${PASS_GOAL}\n\n### 검증 예산\n- 원격 1 · pregate 1\n`;

const noRunningRuns = (): RunningRunsResult => ({
  entries: [],
  counts: { running: 0, 'probable-running': 0, 'ended-unclosed': 0, unknown: 0 },
  total: 0,
  countedStatuses: ['running', 'probable-running'],
  quantities: {
    counts: { value: { running: 0, 'probable-running': 0, 'ended-unclosed': 0, unknown: 0 }, population: 'all assessed runs', observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: true } },
    total: { value: 0, population: 'all assessed runs', observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: true } },
    entries: { value: 0, population: 'all assessed runs', observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: true } },
    running: { value: 0, population: 'assessed runs whose status is in countedStatuses', observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: true } },
  },
  observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: true },
  ledger: { ledgerDirectories: [], unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 },
  pty: { unreadable: [], observedRefCount: 0, withoutRunIdCount: 0, notCountedRefCount: 0 },
});

const noPreexistingFailureTestFiles = (): PreflightPreexistingFailuresStatus => ({ state: 'checked', files: [] });

function preflightDeps(document: string): AskPreflightDeps {
  return {
    readGoalDocument: () => document,
    tracedPaths: () => ['src/target.ts', 'src/target.test.ts'],
    listOpenPrs: () => [],
    listUnfinishedRuns: () => [],
    queryRunningRuns: noRunningRuns,
    listPreexistingFailureTestFiles: noPreexistingFailureTestFiles,
    countRecentChanges: () => ({}),
  };
}

function deps(options: {
  readonly document: string;
  readonly printed: string[];
  readonly logs: Array<{ event: string; data: Record<string, unknown>; level: 'info' | 'warn' }>;
  readonly writes: string[];
  readonly onDecompose?: () => void;
  readonly readFile?: AskLaunchFlowDeps['readFile'];
  readonly writeFile?: AskLaunchFlowDeps['writeFile'];
}): AskLaunchFlowDeps {
  return {
    print: (line) => options.printed.push(line),
    log: (event, data, level) => options.logs.push({ event, data, level }),
    readLine: async () => '',
    readFile: options.readFile ?? (() => options.document),
    writeFile: options.writeFile ?? ((_path, data) => { options.writes.push(data); }),
    cwd: () => '/repo',
    measureToolTreeBehindDefaultBranch: () => null,
    now: () => 1_000,
    isInteractive: () => false,
    buildPreflightDeps: async () => preflightDeps(options.document),
    priorBlockSamples: () => [],
    recentAuthoringSamples: () => [],
    authorGoal: async () => ({ path: '/repo/docs/goals/GOAL.txt' }),
    decomposeGoal: async () => {
      options.onDecompose?.();
      throw new Error('opt-out must not call the decomposer');
    },
    relativeToCwd: (path) => path.replace('/repo/', ''),
  };
}

test('GOAL-PRECHECK-OPTOUT-PATH: 완료선 명령이 없는 골은 opt-out에서도 사전 검토로 정지한다', async () => {
  const printed: string[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown>; level: 'info' | 'warn' }> = [];
  const writes: string[] = [];
  let decomposeCalls = 0;
  const result = await runAskLaunchFlow({
    entrance: CLI_DEV_ASK_ENTRANCE,
    inputSource: 'say',
    askText: '대상 경로: src/target.ts · src/target.test.ts\nopt-out needs-rewrite',
    liveRunWindowMinutes: 30,
    recentChangeWindowDays: 7,
    forceRequested: false,
    decomposeBeforeLaunch: false,
  }, deps({
    document: NEEDS_REWRITE_GOAL,
    printed,
    logs,
    writes,
    onDecompose: () => { decomposeCalls += 1; },
  }));

  expect(result.kind).toBe('stopped-by-preflight');
  if (result.kind !== 'stopped-by-preflight') return;
  expect(result.blockers).toContainEqual(expect.objectContaining({
    name: 'GOAL-PRECHECK',
    checkName: 'goal-precheck',
  }));
  expect(result.blockers.some((blocker) => blocker.detail.includes('needs-rewrite'))).toBe(true);
  expect(decomposeCalls).toBe(0);
  expect(printed.some((line) => line.includes('⑷ 발사 전 분해 권고'))).toBe(false);
  expect(printed.some((line) => line.includes('⑶b 골 사전 검토 — needs-rewrite'))).toBe(true);
  expect(writes.some((data) => data.includes('## 사전 검토(GOAL-PRECHECK)') && data.includes('- 판정: needs-rewrite'))).toBe(true);
  expect(writes.some((data) => data.includes('## 발사 전 분해 권고'))).toBe(false);
  expect(logs).toContainEqual(expect.objectContaining({
    event: 'goal-precheck',
    data: expect.objectContaining({ verdict: 'needs-rewrite', path: 'opt-out' }),
    level: 'warn',
  }));
  expect(logs.some(({ event }) => event === 'ask-launch-decomposition' || event === 'ask-launch-decomposition-skipped')).toBe(false);
}, 30_000);

test('GOAL-PRECHECK-OPTOUT-PATH: 유효한 골은 opt-out에서 문서 그대로 발사하고 분해하지 않는다', async () => {
  const printed: string[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown>; level: 'info' | 'warn' }> = [];
  const writes: string[] = [];
  let decomposeCalls = 0;
  let reads = 0;
  const result = await runAskLaunchFlow({
    entrance: CLI_DEV_ASK_ENTRANCE,
    inputSource: 'say',
    askText: '대상 경로: src/target.ts · src/target.test.ts\nopt-out pass',
    liveRunWindowMinutes: 30,
    recentChangeWindowDays: 7,
    forceRequested: false,
    decomposeBeforeLaunch: false,
  }, deps({
    document: PASS_GOAL,
    printed,
    logs,
    writes,
    onDecompose: () => { decomposeCalls += 1; },
    readFile: () => {
      reads += 1;
      return PASS_GOAL;
    },
  }));

  expect(result).toEqual({ kind: 'launch', goalFile: '/repo/docs/goals/GOAL.txt' });
  expect(decomposeCalls).toBe(0);
  expect(reads).toBe(2);
  expect(writes).toEqual([]);
  expect(printed).toContain('[ask] ⑷ 발사 전 분해 권고 — 꺼짐');
  expect(printed).toContain('[ask] ⑶b 골 사전 검토 — pass');
  expect(logs).toContainEqual(expect.objectContaining({
    event: 'goal-precheck',
    data: expect.objectContaining({ verdict: 'pass', path: 'opt-out' }),
    level: 'info',
  }));
  expect(logs.some(({ event }) => event === 'ask-launch-decomposition')).toBe(false);
}, 30_000);

test('GOAL-PRECHECK-OPTOUT-PATH: fixed 는 고친 문서를 기록하고 분해 권고는 하지 않은 채 발사한다', async () => {
  const printed: string[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown>; level: 'info' | 'warn' }> = [];
  const writes: string[] = [];
  let decomposeCalls = 0;
  const result = await runAskLaunchFlow({
    entrance: CLI_DEV_ASK_ENTRANCE,
    inputSource: 'say',
    askText: '대상 경로: src/target.ts · src/target.test.ts\nopt-out fixed',
    liveRunWindowMinutes: 30,
    recentChangeWindowDays: 7,
    forceRequested: false,
    decomposeBeforeLaunch: false,
  }, deps({
    document: FIXED_GOAL,
    printed,
    logs,
    writes,
    onDecompose: () => { decomposeCalls += 1; },
  }));

  expect(result).toEqual({ kind: 'launch', goalFile: '/repo/docs/goals/GOAL.txt' });
  expect(decomposeCalls).toBe(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain('## 사전 검토(GOAL-PRECHECK)');
  expect(writes[0]).toContain('- 판정: fixed');
  expect(writes[0]).toContain('완료선·증거 명령은 모두 실행');
  expect(writes[0]).not.toContain('## 발사 전 분해 권고');
  expect(printed.some((line) => line.includes('⑶b 골 사전 검토 — fixed'))).toBe(true);
  expect(logs).toContainEqual(expect.objectContaining({
    event: 'goal-precheck',
    data: expect.objectContaining({ verdict: 'fixed', path: 'opt-out' }),
    level: 'info',
  }));
}, 30_000);

test('GOAL-PRECHECK-OPTOUT-PATH: fixed 기록 실패는 관측하고 정상 발사하지 않는다', async () => {
  const printed: string[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown>; level: 'info' | 'warn' }> = [];
  const writes: string[] = [];
  let decomposeCalls = 0;
  const result = await runAskLaunchFlow({
    entrance: CLI_DEV_ASK_ENTRANCE,
    inputSource: 'say',
    askText: '대상 경로: src/target.ts · src/target.test.ts\\nopt-out fixed write failure',
    liveRunWindowMinutes: 30,
    recentChangeWindowDays: 7,
    forceRequested: false,
    decomposeBeforeLaunch: false,
  }, deps({
    document: FIXED_GOAL,
    printed,
    logs,
    writes,
    onDecompose: () => { decomposeCalls += 1; },
    writeFile: () => { throw new Error('disk full'); },
  }));

  expect(result.kind).toBe('stopped-by-preflight');
  if (result.kind !== 'stopped-by-preflight') return;
  expect(result.kind).not.toBe('launch');
  expect(result.blockers).toContainEqual(expect.objectContaining({
    name: 'GOAL-PRECHECK',
    checkName: 'goal-precheck',
    detail: '골 사전 검토 fixed — 수정 문서 기록 실패',
  }));
  expect(decomposeCalls).toBe(0);
  expect(writes).toEqual([]);
  expect(printed).toContain('[ask] ⑶b 골 사전 검토 — ⚠️ 수정 문서 기록 못 남김 (골 문서 쓰기 실패: disk full)');
  expect(printed.some((line) => line.includes('⑷ 발사 전 분해 권고'))).toBe(false);
  expect(logs).toContainEqual(expect.objectContaining({
    event: 'goal-precheck',
    data: expect.objectContaining({ verdict: 'fixed-write-failed', error: 'disk full', path: 'opt-out' }),
    level: 'warn',
  }));
}, 30_000);

test('GOAL-PRECHECK-OPTOUT-PATH: 사전 검토 읽기 실패는 발사를 유지하고 경고로 남긴다', async () => {
  const printed: string[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown>; level: 'info' | 'warn' }> = [];
  const writes: string[] = [];
  let reads = 0;
  const result = await runAskLaunchFlow({
    entrance: CLI_DEV_ASK_ENTRANCE,
    inputSource: 'say',
    askText: '대상 경로: src/target.ts · src/target.test.ts\nopt-out read failure',
    liveRunWindowMinutes: 30,
    recentChangeWindowDays: 7,
    forceRequested: false,
    decomposeBeforeLaunch: false,
  }, deps({
    document: PASS_GOAL,
    printed,
    logs,
    writes,
    readFile: () => {
      reads += 1;
      if (reads === 1) return PASS_GOAL;
      throw new Error('goal document unavailable');
    },
  }));

  expect(result).toEqual({ kind: 'launch', goalFile: '/repo/docs/goals/GOAL.txt' });
  expect(printed).toContain('[ask] ⑶b 골 사전 검토 — ⚠️ 못 읽었다 (골 문서 읽기 실패: goal document unavailable)');
  expect(printed).toContain('[ask] ⑷ 발사 전 분해 권고 — 꺼짐');
  expect(logs).toContainEqual(expect.objectContaining({
    event: 'goal-precheck',
    data: expect.objectContaining({ verdict: 'read-failed', error: 'goal document unavailable' }),
    level: 'warn',
  }));
  expect(writes).toEqual([]);
}, 30_000);
