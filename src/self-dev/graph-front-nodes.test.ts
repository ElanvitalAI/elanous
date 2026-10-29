import { beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { runLedgerPath } from '../self-implement/run-ledger.js';
import { spawnRealCli } from '../testing/real-cli-spawn.js';
import { CLI_DEV_ASK_ENTRANCE } from './entrance-registry.js';
import { runAskLaunchFlow } from './ask-launch-flow.js';
import { FRONT_VISIT_IDLE_TTL_MS, frontVisitRunCountForTesting, observeFrontNodeEntry, observeFrontNodeExit, observeFrontNodeUnit, resetFrontVisitCountsForTesting, runFrontNodeUnit } from './graph-front-nodes.js';

function observedFrontEntries(run: () => void): Array<{
  readonly category: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}> {
  const entries: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const originalLog = debug.log;
  debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'self-implement' && event === 'pipeline-node-entry') {
      entries.push({ category, event, data: data ?? {} });
    }
  }) as typeof debug.log;
  try {
    run();
    return entries;
  } finally {
    debug.log = originalLog;
  }
}

function observedFrontEvents(run: () => void): Array<{
  readonly event: string;
  readonly data: Record<string, unknown>;
}> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const originalLog = debug.log;
  debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'self-implement' && (event === 'pipeline-node-entry' || event === 'graph-visit-budget')) {
      events.push({ event, data: data ?? {} });
    }
  }) as typeof debug.log;
  try {
    run();
    return events;
  } finally {
    debug.log = originalLog;
  }
}

test('real --test harness ask records decompose boundaries before the goal-done launch guard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'front-unit-cli-'));
  const configDir = join(root, 'config');
  mkdirSync(configDir, { recursive: true });
  const runId = `run-${randomUUID()}`;
  const goalFile = join(root, 'GOAL-front-unit-observation-2026-10-20.txt');
  try {
    writeFileSync(goalFile, [
      `- GoalId: ${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      '- GoalType: implement',
      '## WHAT TO BUILD',
      'Observe the front-half decomposition of a goal without launching its superseded work.',
      '## TRACED PATHS',
      '1. src/self-dev/graph-front-nodes.ts',
      '## ACCEPTANCE CRITERIA',
      '- Completed: Do not launch this superseded goal.',
    ].join('\n'));
    const result = await spawnRealCli([
      process.execPath, 'bin/elanous.mjs', '--test', '--config-dir', configDir, 'harness', 'ask', goalFile, '--no-auto-merge',
    ], { cwd: process.cwd(), env: { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'),
      ELANOUS_STATE_DIR: configDir, ELANOUS_KEY_CACHE_DIR: join(root, 'key-cache'),
      XAI_API_KEY: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GEMINI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined, LOCAL_LLM_URL: undefined,
      ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
      ELANOUS_RUN_ID: runId, ELANOUS_TASK_CARD_ID: 'ta-front-unit-observation' }, timeoutMs: 120_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[ask] ⑷ 발사 전 분해 권고');
    expect(result.stderr).toContain('골 완료 경계 누락');
    const lines = readFileSync(runLedgerPath(runId, join(configDir, 'run-ledger')), 'utf8')
      .trim().split('\n').filter((line) => JSON.parse(line).event === 'graph.unit');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ runId, event: 'graph.unit', data: expect.objectContaining({ unit: 'decompose', phase: 'enter', contractId: 'fabric-decompose-adapter' }) }),
      expect.objectContaining({ runId, event: 'graph.unit', data: expect.objectContaining({ unit: 'decompose', phase: 'exit', contractId: 'fabric-decompose-adapter' }) }),
    ]);
    console.log(`REAL CLI GRAPH.UNIT RAW ${lines.join(' | ')}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);

test('isolated ask launch entrance records actual decompose boundaries in one run ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'front-unit-'));
  const previousState = process.env.ELANOUS_STATE_DIR;
  const previousRunId = process.env.ELANOUS_RUN_ID;
  process.env.ELANOUS_STATE_DIR = join(root, '.elanous-test');
  const runId = 'run-11111111-2222-4333-8444-555555555555';
  process.env.ELANOUS_RUN_ID = runId;
  const previousLog = debug.log;
  const frontEntries: Record<string, unknown>[] = [];
  debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'self-implement' && event === 'pipeline-node-entry') frontEntries.push(data ?? {});
  }) as typeof debug.log;
  const goalFile = join(root, 'goal.md');
  const sourceFile = join(root, 'src', 'one.ts');
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(sourceFile, 'export {};');
    writeFileSync(goalFile, '## TRACED PATHS\n- src/one.ts\n');
    const events: string[] = [];
    const result = await runAskLaunchFlow({
      entrance: CLI_DEV_ASK_ENTRANCE, inputSource: 'say', askText: '대상 경로: src/one.ts\n검증',
      liveRunWindowMinutes: 30, recentChangeWindowDays: 7, forceRequested: false,
      decomposeBeforeLaunch: true,
    }, {
      cwd: () => root, print: () => undefined, log: () => undefined,
      readLine: async () => '', isInteractive: () => false, now: () => 1_000,
      measureInvokerBehindDefaultBranch: () => ({ state: 'measured', commits: 0, baseRef: 'origin/main' }),
      measureToolTreeBehindDefaultBranch: () => null,
      readFile: (path) => readFileSync(path, 'utf8'), writeFile: (path, value) => writeFileSync(path, value),
      relativeToCwd: (path) => path.replace(`${root}/`, ''),
      authorGoal: async () => { events.push('author'); return { path: goalFile }; },
      decomposeGoal: async () => {
        events.push('decompose');
        return { decomposition: { outcome: 'single-no-subtasks', actualTaskCount: 0,
          recommendedMaxTasks: 6, truncatedAtHardMax: false, exceededRecommendedMax: false }, goals: [] };
      },
      buildPreflightDeps: async () => ({
        readGoalDocument: (path) => readFileSync(path, 'utf8'), tracedPaths: () => ['src/one.ts'],
        askTargetPaths: () => ['src/one.ts'], listOpenPrs: () => [], listUnfinishedRuns: () => [],
        queryRunningRuns: () => { throw new Error('test query intentionally disabled'); },
        listPreexistingFailureTestFiles: () => ({ state: 'checked', files: [] }),
        countRecentChanges: () => ({}),
      }),
      priorBlockSamples: () => [], recentAuthoringSamples: () => [],
    });
    const lines = readFileSync(runLedgerPath(runId, join(root, '.elanous-test', 'run-ledger')), 'utf8')
      .trim().split('\n').filter((line) => JSON.parse(line).event === 'graph.unit');
    expect(events).toEqual(['author', 'decompose']);
    expect(result.kind).toBe('launch');
    expect(frontEntries).toEqual([
      expect.objectContaining({ node: 'author', runId }),
      expect.objectContaining({ node: 'plan', runId }),
      expect.objectContaining({ node: 'decompose', runId }),
    ]);
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ runId, event: 'graph.unit', data: expect.objectContaining({ unit: 'author', phase: 'enter', contractId: 'goal-author' }) }),
      expect.objectContaining({ runId, event: 'graph.unit', data: expect.objectContaining({ unit: 'author', phase: 'exit', contractId: 'goal-author' }) }),
      expect.objectContaining({ runId, event: 'graph.unit', data: expect.objectContaining({ unit: 'decompose', phase: 'enter', contractId: 'fabric-decompose-adapter' }) }),
      expect.objectContaining({ runId, event: 'graph.unit', data: expect.objectContaining({ unit: 'decompose', phase: 'exit', contractId: 'fabric-decompose-adapter' }) }),
    ]);
    console.log(`GRAPH.UNIT RAW ${lines.join(' | ')}`);
  } finally {
    debug.log = previousLog;
    if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousState;
    if (previousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
    else process.env.ELANOUS_RUN_ID = previousRunId;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

// ⭐ GRAPH-AUTHOR-FAIL-EDGE — 생산 흐름(runAskLaunchFlow)을 그대로 돌려 author 의 «나감»과 그 간선을 센다.
//   ⛔ 소스 문자열을 보지 않는다 — 저작기·전제 검사만 주입하고 나머지는 실제 코드다.
// 실제 전제 검사(우주·원장 조회 포함)를 그대로 돌리므로 부하 높은 호스트에서 수십 초가 걸린다.
const AUTHOR_FLOW_TIMEOUT_MS = 120_000;
async function runAuthorFlow(grounded: readonly boolean[], options: { readonly authorThrows?: Error } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'author-exit-'));
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = join(root, '.elanous-test');
  // 가상 골 문서(디스크에 없음) — 전제 검사의 파일 실재 축을 빼고 «대상 경로» 축만 남긴다(ask-launch-flow.test 의 /repo/goal 꼴).
  const goalFile = join(root, 'virtual-goal.md');
  const goalDocument = '## TRACED PATHS\n- src/one.ts\n';
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const unitEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  const originalLog = debug.log;
  debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'self-implement' && (event === 'front-node-exit' || event === 'graph-edge-taken')) events.push({ event, data: data ?? {} });
    if (category === 'graph.unit') unitEvents.push({ event, data: data ?? {} });
  }) as typeof debug.log;
  let authorCalls = 0;
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'one.ts'), 'export {};');
    // 접지 실패 = 골에서 대상 경로를 하나도 못 뽑았다(대상 경로 0 · 다른 막힘 없음) — NOT-GROUNDED 저작의 모양.
    const isGrounded = (): boolean => grounded[Math.max(0, authorCalls - 1)] === true;
    const paths = (): string[] => (isGrounded() ? ['src/one.ts'] : []);
    const outcome = await runAskLaunchFlow({
      entrance: CLI_DEV_ASK_ENTRANCE, inputSource: 'say', askText: 'one 모듈을 고친다',
      runId: 'run-author-flow-unit-boundary',
      liveRunWindowMinutes: 30, recentChangeWindowDays: 7, forceRequested: false, decomposeBeforeLaunch: false,
    }, {
      cwd: () => root, print: () => undefined, log: () => undefined,
      readLine: async () => '', isInteractive: () => false, now: () => 1_000,
      measureToolTreeBehindDefaultBranch: () => null, measureInvokerBehindDefaultBranch: () => ({ state: 'unmeasurable', reason: 'test' }),
      readFile: (path) => (path === goalFile ? goalDocument : readFileSync(path, 'utf8')), writeFile: () => undefined,
      relativeToCwd: (path) => path.replace(`${root}/`, ''),
      findPathCandidates: () => ({ tokens: [], paths: [] }),
      authorGoal: async () => {
        authorCalls += 1;
        if (options.authorThrows) throw options.authorThrows;
        return { path: goalFile };
      },
      decomposeGoal: async () => ({ decomposition: { outcome: 'single-no-subtasks', actualTaskCount: 0,
        recommendedMaxTasks: 6, truncatedAtHardMax: false, exceededRecommendedMax: false }, goals: [] }),
      buildPreflightDeps: async () => ({
        readGoalDocument: () => goalDocument, tracedPaths: paths, askTargetPaths: paths,
        listOpenPrs: () => [], listUnfinishedRuns: () => [], countRecentChanges: () => ({}),
        queryRunningRuns: () => { throw new Error('test query intentionally disabled'); },
        listPreexistingFailureTestFiles: () => ({ state: 'checked', files: [] }),
      }),
      priorBlockSamples: () => [], recentAuthoringSamples: () => [],
    });
    return { outcome, events, unitEvents, authorCalls };
  } finally {
    debug.log = originalLog;
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
    rmSync(root, { recursive: true, force: true });
  }
}

describe('observeFrontNodeExit — GRAPH-AUTHOR-FAIL-EDGE', () => {
  test('author exit records not-grounded and the edge to re-ground', async () => {
    const { outcome, events, authorCalls } = await runAuthorFlow([false, true]);
    expect(authorCalls).toBe(2);
    expect(outcome.kind).toBe('launch');
    const exits = events.filter((row) => row.event === 'front-node-exit').map((row) => row.data);
    expect(exits).toEqual([
      expect.objectContaining({ graphId: 'self-implement', node: 'author', outcome: 'not-grounded', attempt: 1, to: 're-ground', taken: 're-ground', honored: true,
        evidenceCard: [expect.objectContaining({ kind: 'no-target-paths' })] }),
      expect.objectContaining({ node: 're-ground', outcome: 'retry', to: 'author', taken: 'author' }),
      expect.objectContaining({ node: 'author', outcome: 're-authored', attempt: 2, to: 'plan', taken: 'plan', honored: true }),
    ]);
    const edges = events.filter((row) => row.event === 'graph-edge-taken').map((row) => row.data);
    expect(edges).toEqual([
      expect.objectContaining({ graphId: 'self-implement', from: 'author', on: 'outcome', label: 'not-grounded', to: 're-ground', taken: 're-ground', source: 'graph', honored: true }),
      expect.objectContaining({ from: 're-ground', to: 'author', taken: 'author', source: 'graph' }),
      expect.objectContaining({ from: 'author', label: 're-authored', to: 'plan', taken: 'plan', honored: true }),
    ]);
  }, AUTHOR_FLOW_TIMEOUT_MS);

  test('second not-grounded ends at needs-human', async () => {
    const { outcome, events, authorCalls } = await runAuthorFlow([false, false]);
    // ⛔ 단언 «전»에 찍는다 — bun 의 toMatchObject 가 받은 객체 칸을 비대칭 매처로 바꿔 놓아 뒤에 찍으면 {} 가 된다.
    console.log(`AUTHOR EXIT RAW ${events.map((row) => JSON.stringify({ event: row.event, data: row.data })).join(' | ')}`);
    expect(authorCalls).toBe(2);
    expect(outcome.kind).toBe('stopped-by-preflight');
    const second = events.filter((row) => row.event === 'front-node-exit' && row.data.node === 'author').map((row) => row.data)[1];
    expect(second).toMatchObject({ outcome: 'not-grounded', attempt: 2, to: 'needs-human', taken: 'needs-human', honored: true,
      evidenceCard: [expect.objectContaining({ kind: 'no-target-paths', name: '(대상 경로 0)' })] });
    expect(String(second?.reason)).toContain('re-ground-visit-budget-exhausted');
    const last = events.filter((row) => row.event === 'graph-edge-taken').at(-1)?.data;
    expect(last).toMatchObject({ from: 'author', label: 'not-grounded', to: 'needs-human', taken: 'needs-human', honored: true });
  }, AUTHOR_FLOW_TIMEOUT_MS);

  test('ok author takes plan and a throwing author records fail toward needs-human while rethrowing', async () => {
    const ok = await runAuthorFlow([true]);
    expect(ok.authorCalls).toBe(1);
    expect(ok.unitEvents).toEqual([
      expect.objectContaining({ event: 'enter', data: expect.objectContaining({ nodeId: 'author', unit: 'author', phase: 'enter' }) }),
      expect.objectContaining({ event: 'exit', data: expect.objectContaining({ nodeId: 'author', unit: 'author', phase: 'exit' }) }),
    ]);
    expect(ok.events.map((row) => [row.event, row.data.node ?? row.data.from, row.data.outcome ?? row.data.label, row.data.taken]))
      .toEqual([['graph-edge-taken', 'author', 'ok', 'plan'], ['front-node-exit', 'author', 'ok', 'plan']]);
    const error = new Error('author exploded');
    let caught: unknown;
    let failed: Awaited<ReturnType<typeof runAuthorFlow>> | undefined;
    try { failed = await runAuthorFlow([true], { authorThrows: error }); } catch (thrown) { caught = thrown; }
    expect(failed).toBeUndefined();
    expect(caught).toBe(error);
  }, AUTHOR_FLOW_TIMEOUT_MS);

  test('observation failure does not change the author flow', async () => {
    const previous = debug.log;
    debug.log = (() => { throw new Error('observer failed'); }) as typeof debug.log;
    try {
      expect(observeFrontNodeExit({ node: 'author', outcome: 'not-grounded' }, { attempt: 2 })).toMatchObject({ to: 'needs-human' });
    } finally { debug.log = previous; }
  });
});

test('unit boundary is fail-soft and preserves rejected stage result', async () => {
  const error = new Error('stage failed');
  const previousLog = debug.log;
  debug.log = (() => { throw new Error('observer failed'); }) as typeof debug.log;
  try {
    await expect(observeFrontNodeUnit('author', 'invalid/run', 'implement', async () => { throw error; })).rejects.toBe(error);
  } finally { debug.log = previousLog; }
});

test('typed front-node unit receives the original input and shared context and returns its output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'front-unit-context-'));
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = join(root, '.elanous-test');
  const context = { runId: 'run-front-unit-context', goalType: 'implement' as const };
  const input = { goal: 'ground one target', evidence: ['src/one.ts'] };
  let received: unknown;
  try {
    const result = await runFrontNodeUnit({
      node: 'author',
      execute: async (actualInput, actualContext) => {
        received = { input: actualInput, context: actualContext };
        return { outcome: 'grounded', evidence: actualInput.evidence };
      },
    }, input, context);
    expect(received).toEqual({ input, context });
    expect(result).toEqual({ outcome: 'grounded', evidence: ['src/one.ts'] });
    const noMetadataContext = {};
    const noMetadataResult = await runFrontNodeUnit({
      node: 'plan',
      execute: async (actualInput, actualContext) => ({ actualInput, actualContext }),
    }, input, noMetadataContext);
    expect(noMetadataResult).toEqual({ actualInput: input, actualContext: noMetadataContext });
  } finally {
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
    rmSync(root, { recursive: true, force: true });
  }
});

describe('observeFrontNodeEntry', () => {
  // 모듈 수준 계수는 시험 사이에 남는다 — 매 시험 비운다(runId 가 겹쳐도 간섭하지 않게).
  beforeEach(() => resetFrontVisitCountsForTesting());

  test('keeps the shared event and preserved payload fields while recording required provenance', () => {
    const entries = observedFrontEntries(() => {
      observeFrontNodeEntry('author', {
        provenance: 'authoring-start', runId: 'run-declared', goalType: 'implement', round: 3,
      });
      observeFrontNodeEntry('not-declared' as never, {
        provenance: 'authoring-plan', runId: 'run-undeclared', goalType: 'implement',
      });
    });

    expect(entries).toHaveLength(2);
    expect(entries.map(({ event }) => event)).toEqual(['pipeline-node-entry', 'pipeline-node-entry']);
    expect(entries[0].data).toMatchObject({
      graphId: 'self-implement',
      node: 'author',
      nodeDeclarationStatus: 'declared',
      runId: 'run-declared',
      round: 3,
      phase: 'front',
      graphTemplatesSource: expect.any(String),
      provenance: 'authoring-start',
    });
    expect(entries[1].data).toMatchObject({
      graphId: 'self-implement',
      node: 'not-declared',
      nodeDeclarationStatus: 'undeclared',
      runId: 'run-undeclared',
      phase: 'front',
      graphTemplatesSource: expect.any(String),
      provenance: 'authoring-plan',
    });
  });

  test('records mutually distinct provenance for the three decompose entry causes', () => {
    const entries = observedFrontEntries(() => {
      observeFrontNodeEntry('decompose', { provenance: 'authoring-decomposition-start', runId: 'run-author' });
      observeFrontNodeEntry('decompose', { provenance: 'supervisor-promotion-attempt', runId: 'run-supervisor' });
      observeFrontNodeEntry('decompose', { provenance: 'supervisor-pre-promotion-decision', runId: 'run-supervisor' });
    });

    expect(entries.map(({ event }) => event)).toEqual([
      'pipeline-node-entry',
      'pipeline-node-entry',
      'pipeline-node-entry',
    ]);
    expect(entries.map(({ data }) => data.provenance)).toEqual([
      'authoring-decomposition-start',
      'supervisor-promotion-attempt',
      'supervisor-pre-promotion-decision',
    ]);
    expect(entries.slice(1).map(({ data }) => data.runId)).toEqual(['run-supervisor', 'run-supervisor']);
    expect(new Set(entries.map(({ data }) => data.provenance)).size).toBe(3);
  });

  test('implement 이외와 미확정 골은 default-loop 정체성을 보존한다', () => {
    const entries = observedFrontEntries(() => {
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-research', goalType: 'research' });
      observeFrontNodeEntry('plan', { provenance: 'authoring-plan', runId: 'run-unknown' });
    });

    expect(entries.map(({ data }) => data)).toEqual([
      expect.objectContaining({ graphId: 'default-loop', node: 'author', runId: 'run-research', goalType: 'research' }),
      expect.objectContaining({ graphId: 'default-loop', node: 'plan', runId: 'run-unknown' }),
    ]);
  });

  test('requires provenance at compile time', () => {
    // @ts-expect-error provenance is a required call-site contract
    observeFrontNodeEntry('decompose', { runId: 'legacy-call-shape' });
  });

  test('관측 소비자가 실패해도 저작 흐름을 중단하지 않는다', () => {
    const originalLog = debug.log;
    debug.log = (() => { throw new Error('observation failed'); }) as typeof debug.log;
    try {
      expect(() => observeFrontNodeEntry('author', { provenance: 'authoring-start' })).not.toThrow();
    } finally {
      debug.log = originalLog;
    }
  });

  test('같은 runId 로 author 를 세 번 진입하면 방문 예산 판독이 graph-visit-budget 로 남는다', () => {
    const events = observedFrontEvents(() => {
      for (let i = 0; i < 3; i += 1) {
        observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-budget-author', round: i });
      }
    });

    const nodeEntries = events.filter(({ event }) => event === 'pipeline-node-entry');
    expect(nodeEntries).toHaveLength(3);
    const budgets = events.filter(({ event }) => event === 'graph-visit-budget');
    expect(budgets).toHaveLength(3);
    expect(budgets[0].data).toMatchObject({
      node: 'author', visits: 1, maxVisits: 2, exceeded: false,
      runId: 'run-budget-author', round: 0, phase: 'front',
    });
    expect(budgets[2].data).toMatchObject({
      node: 'author', visits: 3, maxVisits: 2, exceeded: true,
      runId: 'run-budget-author', round: 2, phase: 'front',
    });
    expect(budgets.map(({ data }) => data.exceeded)).toEqual([false, false, true]);
  });

  test('runId 없는 진입은 graph-visit-budget 을 내지 않고 두 runId 의 방문 수는 섞이지 않는다', () => {
    const events = observedFrontEvents(() => {
      observeFrontNodeEntry('plan', { provenance: 'authoring-plan' }); // runId 없음
      observeFrontNodeEntry('plan', { provenance: 'authoring-plan', runId: 'run-alt-1' });
      observeFrontNodeEntry('plan', { provenance: 'authoring-plan', runId: 'run-alt-2' });
      observeFrontNodeEntry('plan', { provenance: 'authoring-plan', runId: 'run-alt-1' });
    });

    const nodeEntries = events.filter(({ event }) => event === 'pipeline-node-entry');
    expect(nodeEntries).toHaveLength(4);
    const budgets = events.filter(({ event }) => event === 'graph-visit-budget');
    expect(budgets).toHaveLength(3); // runId 없는 진입은 판독을 내지 않는다
    expect(budgets.map(({ data }) => [data.runId, data.visits] as const)).toEqual([
      ['run-alt-1', 1],
      ['run-alt-2', 1],
      ['run-alt-1', 2],
    ]);
  });

  test('다른 runId 65개 이상을 거친 뒤 재진입해도 같은 runId 의 방문 수는 이어서 센다', () => {
    const events = observedFrontEvents(() => {
      // 첫 runId 진입(visited 1).
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-first' });
      // 그 사이 다른 runId 65개 이상을 진입시킨다.
      for (let i = 0; i < 65; i += 1) {
        observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: `run-other-${i}` });
      }
      // 첫 runId 재진입 — 계수는 1 로 재시작하지 «않고» 2 가 되어야 한다(런별 정확한 계수).
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-first' });
    });

    const budgets = events.filter(({ event }) => event === 'graph-visit-budget');
    const firstRunReadings = budgets.filter(({ data }) => data.runId === 'run-first');
    expect(firstRunReadings).toHaveLength(2);
    expect(firstRunReadings[0].data).toMatchObject({ node: 'author', visits: 1, maxVisits: 2, exceeded: false });
    // visits=2 · maxVisits=2 → exceeded=false (exceeded 는 visits «>» maxVisits — 셋째 진입이 3 이 되어야 true).
    expect(firstRunReadings[1].data).toMatchObject({ node: 'author', visits: 2, maxVisits: 2, exceeded: false });
    expect(budgets).toHaveLength(67);
  });

  test('같은 runId 안에서 노드별 계수는 섞이지 않고 decompose 는 선언 예산 12 를 읽는다', () => {
    const events = observedFrontEvents(() => {
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-mixed' });
      observeFrontNodeEntry('plan', { provenance: 'authoring-plan', runId: 'run-mixed' });
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-mixed' });
      for (let i = 0; i < 13; i += 1) {
        observeFrontNodeEntry('decompose', { provenance: 'authoring-decomposition-start', runId: 'run-mixed' });
      }
    });
    const budgets = events.filter(({ event }) => event === 'graph-visit-budget').map(({ data }) => data);
    expect(budgets.slice(0, 3).map((d) => [d.node, d.visits, d.maxVisits])).toEqual([
      ['author', 1, 2], ['plan', 1, 2], ['author', 2, 2],
    ]);
    const decompose = budgets.filter((d) => d.node === 'decompose');
    expect(decompose).toHaveLength(13);
    expect(decompose[11]).toMatchObject({ visits: 12, maxVisits: 12, exceeded: false });
    expect(decompose[12]).toMatchObject({ visits: 13, maxVisits: 12, exceeded: true });
  });

  test('진행 중인 런은 다른 런이 아무리 많이 지나가도 버리지 않고, 유휴 시간이 지난 런만 버린다', () => {
    let now = 1_000_000;
    resetFrontVisitCountsForTesting(() => now);
    const events = observedFrontEvents(() => {
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-active' });
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-idle' });
      for (let i = 0; i < 5000; i += 1) {
        observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: `run-other-${i}` });
      }
      // 5000 런이 지나간 뒤에도 같은 런은 이어서 센다(개수로 버리지 않는다).
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-active' });
      // 유휴 시간이 지나면 — run-active 는 그 사이 한 번 더 밟혀 살아 있고, run-idle 은 버려진다.
      now += FRONT_VISIT_IDLE_TTL_MS / 2;
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-active' });
      now += FRONT_VISIT_IDLE_TTL_MS / 2 + 1;
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-active' });
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-idle' });
    });
    const budgets = events.filter(({ event }) => event === 'graph-visit-budget').map(({ data }) => data);
    expect(budgets.filter((d) => d.runId === 'run-active').map((d) => d.visits)).toEqual([1, 2, 3, 4]);
    // ⚠️ 6시간 넘게 아무 진입이 없던 런은 «진행 중»이 아니다 — 새 런처럼 1 부터 센다.
    expect(budgets.filter((d) => d.runId === 'run-idle').map((d) => d.visits)).toEqual([1, 1]);
    // 유휴 런 5001 개(run-other-* ⊕ 옛 run-idle)가 정리됐다 — 남은 것은 run-active 와 다시 들어온 run-idle 뿐.
    expect(frontVisitRunCountForTesting()).toBe(2);
  });

  test('런이 몇 개뿐이어도 유휴 시간이 지난 런은 정리된다(크기 임계 없음)', () => {
    let now = 5_000_000;
    resetFrontVisitCountsForTesting(() => now);
    observedFrontEvents(() => {
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-a' });
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-b' });
      expect(frontVisitRunCountForTesting()).toBe(2);
      now += FRONT_VISIT_IDLE_TTL_MS + 1;
      observeFrontNodeEntry('author', { provenance: 'authoring-start', runId: 'run-c' });
    });
    // run-a·run-b 는 6시간 넘게 멈췄다 — 정리되고 run-c 만 남는다.
    expect(frontVisitRunCountForTesting()).toBe(1);
  });

  test('pipeline-node-entry 로그가 던져도 계수는 이어지고 판독은 남는다', () => {
    const budgets: Array<Record<string, unknown>> = [];
    const originalLog = debug.log;
    debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'pipeline-node-entry') throw new Error('log sink down');
      if (category === 'self-implement' && event === 'graph-visit-budget') budgets.push(data ?? {});
    }) as typeof debug.log;
    try {
      expect(() => observeFrontNodeEntry('plan', { provenance: 'authoring-plan', runId: 'run-log-fail' })).not.toThrow();
      expect(() => observeFrontNodeEntry('plan', { provenance: 'authoring-plan', runId: 'run-log-fail' })).not.toThrow();
    } finally {
      debug.log = originalLog;
    }
    expect(budgets.map((d) => d.visits)).toEqual([1, 2]);
  });

  test('graph-visit-budget 로그가 던져도 계수는 이어지고 pipeline-node-entry 는 남는다', () => {
    const entries: Array<Record<string, unknown>> = [];
    let budgetCalls = 0;
    const originalLog = debug.log;
    debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'graph-visit-budget') {
        budgetCalls += 1;
        if (budgetCalls === 1) throw new Error('budget sink down');
        entries.push({ event, ...(data ?? {}) });
        return;
      }
      if (category === 'self-implement' && event === 'pipeline-node-entry') entries.push({ event, ...(data ?? {}) });
    }) as typeof debug.log;
    try {
      expect(() => observeFrontNodeEntry('plan', { provenance: 'authoring-plan', runId: 'run-budget-fail' })).not.toThrow();
      expect(() => observeFrontNodeEntry('plan', { provenance: 'authoring-plan', runId: 'run-budget-fail' })).not.toThrow();
    } finally {
      debug.log = originalLog;
    }
    expect(entries.filter((e) => e.event === 'pipeline-node-entry')).toHaveLength(2);
    // 첫 판독 로그가 던졌어도 계수는 올라갔다 — 둘째 판독은 visits=2.
    expect(entries.filter((e) => e.event === 'graph-visit-budget').map((e) => e.visits)).toEqual([2]);
  });
});
