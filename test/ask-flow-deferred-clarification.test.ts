// ⭐ 72차: 비대화형 표면(무인 런 · TUI 슬래시)에서 저작기의 물음이 «사실상 사라졌다» —
//   「N건 있다」만 말하고 «무엇을 묻는지»도 «어떻게 답하는지»도 안 줬다.
// ⛔ 새 인터뷰 UI 를 만들지 «않는다» — 답변 창구(`elanous self clarify answer`)는 이미 있다.
//   이 시험은 그 «가리킴»이 실제로 나오는지를 문다.
import { describe, expect, test } from 'bun:test';
import { runAskLaunchFlow, type AskLaunchFlowDeps } from '../src/self-dev/ask-launch-flow.js';
import { CLI_DEV_ASK_ENTRANCE } from '../src/self-dev/entrance-registry.js';

const GOAL = '/repo/docs/goals/GOAL-x.md';
const DOCUMENT = [
  '## PROBLEM',
  '',
  '- Clarification:',
  '  - id: implementation_anchor',
  '  - header: Clarification',
  '  - question: Which function should the target contain?',
  '  - options:',
  '    - label: Function or constant',
  '      description: name one',
  '  - includeOther: true',
  '  - answer: DEFERRED-UNTIL: human',
  '',
].join('\n');

function harness(overrides: Partial<AskLaunchFlowDeps> = {}) {
  const printed: string[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  let decomposeCalls = 0;
  let invokerMeasurementCalls = 0;
  const deps: AskLaunchFlowDeps = {
    print: (line) => printed.push(line),
    log: (event, data) => logs.push({ event, data }),
    readLine: async () => { throw new Error('비대화형인데 물었다 — 계약 위반'); },
    readFile: () => DOCUMENT,
    writeFile: () => {},
    cwd: () => '/repo',
    now: () => 1_786_440_000_000,
    isInteractive: () => false,
    buildPreflightDeps: async () => ({
      readGoalDocument: () => DOCUMENT,
      tracedPaths: () => ['src/a.ts'],
      listOpenPrs: () => [],
      listUnfinishedRuns: () => [],
      countRecentChanges: () => ({}),
    }),
    priorBlockSamples: () => [],
    recentAuthoringSamples: () => [],
    authorGoal: async () => ({ path: GOAL, authored: { document: DOCUMENT, grounded: true } }),
    decomposeGoal: async (document) => {
      decomposeCalls++;
      expect(document).toBe(DOCUMENT);
      return {
        decomposition: {
          recommendedMaxTasks: 6,
          actualTaskCount: 0,
          truncatedAtHardMax: false,
          exceededRecommendedMax: false,
          outcome: 'single-no-subtasks',
        },
        goals: [],
      };
    },
    measureInvokerBehindDefaultBranch: () => {
      invokerMeasurementCalls++;
      return { state: 'measured', commits: 0, baseRef: 'origin/main' };
    },
    relativeToCwd: (file) => file.replace('/repo/', ''),
    ...overrides,
  };
  return {
    deps,
    printed,
    logs,
    decomposeCalls: () => decomposeCalls,
    invokerMeasurementCalls: () => invokerMeasurementCalls,
  };
}

describe('runAskLaunchFlow — 비대화형 되묻기', () => {
  test('물음 «내용»과 «답변 경로»를 낸다 — 「N건 있다」로 끝내지 않는다', async () => {
    const { deps, printed, logs, decomposeCalls, invokerMeasurementCalls } = harness();
    const result = await runAskLaunchFlow(
      { entrance: CLI_DEV_ASK_ENTRANCE, inputSource: 'say', askText: '대상 경로: src/a.ts 를 고친다.', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, forceRequested: false },
      deps,
    );
    const text = printed.join('\n');

    expect(result.kind).toBe('launch');
    expect(text).toContain('미답 되묻기 1건');
    // ⛔ 물음 «내용»과 questionId — 이것이 없으면 사람이 무엇에 답할지 모른다.
    expect(text).toContain('[implementation_anchor]');
    expect(text).toContain('Which function should the target contain?');
    // ⛔ 답변 «경로» — 이미 있는 창구를 가리킨다(새 UI 를 만들지 않는다).
    expect(text).toContain('선택지 답변: elanous self clarify answer docs/goals/GOAL-x.md implementation_anchor <0-based-optionIndex>');
    expect(text).toContain('골을 다시 저작하려면: elanous self author --from-clarification docs/goals/GOAL-x.md#implementation_anchor');
    expect(logs.find(({ event }) => event === 'ask-clarification-intake')?.data)
      .toMatchObject({ mode: 'deferred-noninteractive', pendingCount: 1, interactive: false });
    // runAskLaunchFlow → recommendLaunchDecomposition 및 인보커 git 관측은 둘 다 fake seam만 소비한다.
    expect(decomposeCalls()).toBe(1);
    expect(invokerMeasurementCalls()).toBe(1);
  }, 30_000);

  // ⛔ 비대화형이면 «절대» 묻지 않는다 — 무인 계약이다(readLine 이 불리면 이 시험이 던진다).
  test('비대화형에서는 readLine 을 부르지 않는다', async () => {
    const { deps } = harness();
    await expect(runAskLaunchFlow(
      { entrance: CLI_DEV_ASK_ENTRANCE, inputSource: 'say', askText: '대상 경로: src/a.ts', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, forceRequested: false },
      deps,
    )).resolves.toMatchObject({ kind: 'launch' });
  }, 30_000);

  test('물을 것이 «없으면» 답변 경로도 안 낸다(빈 안내를 만들지 않는다)', async () => {
    const answered = DOCUMENT.replace('  - answer: DEFERRED-UNTIL: human', '  - answer: Function or constant');
    const { deps, printed } = harness({ readFile: () => answered, authorGoal: async () => ({ path: GOAL, authored: { document: answered, grounded: true } }) });
    await runAskLaunchFlow(
      { entrance: CLI_DEV_ASK_ENTRANCE, inputSource: 'say', askText: '대상 경로: src/a.ts', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, forceRequested: false },
      deps,
    );
    const text = printed.join('\n');
    expect(text).toContain('되묻기 없음');
    expect(text).not.toContain('elanous self clarify answer');
  }, 30_000);
});
