import { formatGateFailedId } from './premise-review.js';
import { describe, expect, it } from 'bun:test';
import { runWorkflowToCompletion } from '../workflow-runtime/executor.js';
import type { JudgmentContext, RunWorkflowOpts, WorkflowDeps } from '../workflow-runtime/types.js';
import { applyReworkBudgetDecision } from './rework-policy.js';
import {
  createReworkBudgetJudgment,
  mapReworkBudgetVerdict,
  reworkBudgetEvidenceForObservation,
  REWORK_BUDGET_JUDGMENT,
  reworkBudgetWorkflow,
} from './rework-budget-judgment.js';

function runJudgment(classification: string, kind: 'gate' | 'review') {
  const callLLM = async () => classification;
  return runWorkflowToCompletion(
    {
      workflow: reworkBudgetWorkflow,
      arguments: 'BUDGET: EXTEND\nREASON: contract input',
      artifactsDir: '',
      persistRun: false,
      judgmentContext: { kind, history: ['prior round'] },
    },
    {
      callLLM,
      runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      runJudgment: createReworkBudgetJudgment(callLLM),
    },
  );
}

describe('rework-budget@v1 judgment provider', () => {
  it('declares the once contract and types the required kind observation', () => {
    const context: JudgmentContext = { kind: 'review', history: ['prior round'] };
    const opts: RunWorkflowOpts = {
      workflow: reworkBudgetWorkflow,
      arguments: 'input',
      judgmentContext: context,
    };
    const provider: NonNullable<WorkflowDeps['runJudgment']> = createReworkBudgetJudgment(async () => 'EXTEND');
    const node = reworkBudgetWorkflow.nodes[0]!;
    expect(opts.judgmentContext).toEqual(context);
    expect(typeof provider).toBe('function');
    expect(node).toMatchObject({
      judgment: REWORK_BUDGET_JUDGMENT,
      cadence: 'once',
      observes: ['goal', 'outcome', 'history', 'kind'],
      vocabulary: ['continue', 'complete', 'abandon'],
      executions: ['extend-budget', 'terminate', 'finalize'],
    });
  });

  it('rejects unsupported contracts explicitly', async () => {
    const provider = createReworkBudgetJudgment(async () => 'EXTEND');
    await expect(provider('other@v1', { kind: 'gate' })).resolves.toMatchObject({
      ok: false,
      error: "unsupported judgment contract 'other@v1'",
    });
  });

  it('requires the declared kind observation', async () => {
    const provider = createReworkBudgetJudgment(async () => 'EXTEND');
    const result = await provider(REWORK_BUDGET_JUDGMENT, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("requires observation 'kind'");
  });

  it('blocks an on-signal declaration before it calls the provider', async () => {
    let called = false;
    const result = await runWorkflowToCompletion(
      {
        workflow: {
          ...reworkBudgetWorkflow,
          nodes: [{ ...reworkBudgetWorkflow.nodes[0]!, cadence: 'on-signal' }],
        },
        arguments: 'input',
        artifactsDir: '',
        persistRun: false,
        judgmentContext: { kind: 'gate' },
      },
      {
        callLLM: async () => 'EXTEND',
        runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        runJudgment: async () => {
          called = true;
          return { ok: true, output: 'EXTEND', verdict: 'continue' };
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.outputs['rework-budget']?.error).toContain("cadence 'on-signal' is not wired");
    expect(called).toBe(false);
  });

  it.each([
    ['EXTEND', 'review', 'continue', { stop: false, exit: 'continue' }],
    ['SUFFICIENT', 'gate', 'continue', { stop: false, exit: 'continue' }],
    ['SUFFICIENT', 'review', 'complete', { stop: true, exit: 'proceed' }],
    ['UNCONVERGEABLE', 'review', 'abandon', { stop: true, exit: 'blocked' }],
  ] as const)('executes %s/%s through the declared workflow and preserves its rework execution', async (classification, kind, verdict, execution) => {
    const provider = createReworkBudgetJudgment(async () => classification);
    await expect(provider(REWORK_BUDGET_JUDGMENT, { goal: 'input', kind })).resolves.toMatchObject({
      ok: true,
      output: classification,
      verdict,
    });
    const result = await runJudgment(classification, kind);
    expect(result.ok).toBe(true);
    expect(result.outputs['rework-budget']).toMatchObject({ ok: true, output: classification });
    expect(mapReworkBudgetVerdict(classification, kind)).toBe(verdict);
    expect(applyReworkBudgetDecision(2, { verdict: classification, reason: 'contract' }, 5, kind, 1)).toMatchObject(execution);
  });

  it('sends every declared observation and preserves the model rationale without text inference', async () => {
    let prompt = '';
    const reasoning = 'documentation update was blocked; choose UNCONVERGEABLE.';
    const result = await createReworkBudgetJudgment(async ({ prompt: value }) => {
      prompt = value;
      return reasoning;
    })(REWORK_BUDGET_JUDGMENT, {
      goal: 'prior-round diagnosis',
      outcome: {},
      history: [],
      kind: 'review',
    });

    const input = JSON.parse(prompt.slice(prompt.indexOf('Input:\n') + 'Input:\n'.length));
    expect(input).toEqual({
      observations: {
        goal: { state: 'present', value: 'prior-round diagnosis' },
        outcome: { state: 'empty', value: {} },
        history: { state: 'empty', value: [] },
        kind: { state: 'present', value: 'review' },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      output: 'UNCONVERGEABLE',
      verdict: 'abandon',
      evidence: { observations: input.observations, modelReasoning: reasoning },
    });

    let missingPrompt = '';
    await createReworkBudgetJudgment(async ({ prompt: value }) => {
      missingPrompt = value;
      return 'EXTEND';
    })(REWORK_BUDGET_JUDGMENT, { kind: 'gate' });
    const missingInput = JSON.parse(missingPrompt.slice(missingPrompt.indexOf('Input:\n') + 'Input:\n'.length));
    expect(missingInput.observations).toEqual({
      goal: { state: 'missing' },
      outcome: { state: 'missing' },
      history: { state: 'missing' },
      kind: { state: 'present', value: 'gate' },
    });
  });

  it('retains evidence for observation after the workflow consumes the judgment result', async () => {
    const provider = createReworkBudgetJudgment(async () => 'EXTEND');
    await provider(REWORK_BUDGET_JUDGMENT, { goal: 'goal', outcome: {}, history: [], kind: 'review' });

    expect(reworkBudgetEvidenceForObservation(provider.evidenceForObservation)).toEqual({
      evidence: {
        observations: {
          goal: { state: 'present', value: 'goal' },
          outcome: { state: 'empty', value: {} },
          history: { state: 'empty', value: [] },
          kind: { state: 'present', value: 'review' },
        },
        modelReasoning: 'EXTEND',
      },
    });
  });

  it('makes an absent or throwing evidence accessor observational only', () => {
    expect(reworkBudgetEvidenceForObservation(() => undefined)).toEqual({ evidence: null });
    expect(reworkBudgetEvidenceForObservation(() => { throw new Error('evidence unavailable'); })).toEqual({
      evidence: null,
      evidenceReadError: 'evidence unavailable',
    });
  });

  it('does not silently accept an undeclared verdict from the provider', async () => {
    const result = await runWorkflowToCompletion(
      {
        workflow: {
          ...reworkBudgetWorkflow,
          nodes: [{ ...reworkBudgetWorkflow.nodes[0]!, vocabulary: ['continue', 'complete'] }],
        },
        arguments: 'input',
        artifactsDir: '',
        persistRun: false,
        judgmentContext: { kind: 'review' },
      },
      {
        callLLM: async () => 'UNCONVERGEABLE',
        runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        runJudgment: createReworkBudgetJudgment(async () => 'UNCONVERGEABLE'),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.outputs['rework-budget']?.error).toContain("judgment verdict 'abandon'");
  });
});

// ⛔⭐⭐⭐ 2026-08-11 실측 — 수렴 «중»이던 런이 이 자리에서 죽었다(리뷰 지적 4→3→2 · gate 매 라운드
//   통과 · rework 예산 3/5 로 «남아 있었다»). 그리고 ***그 결함을 고치려던 런도 같은 자리에서 죽었다.***
//   근본 둘: ⑴ 분류 재시도를 `classify.ts` 가 지원하는데 이 자리가 «안 줬다» ⑵ 실패 문면이
//   「무엇이 왔는지」를 «안 말해» 빈 산출·`'unknown'`·오탈자를 하나도 못 갈랐다.
describe('rework-budget@v1 — 분류가 안 읽혔을 때', () => {
  it('[retries-are-wired] 세 이름이 «한 번도» 안 온 뒤 나중 시도가 읽히면 판정이 산다', async () => {
    let attempts = 0;
    const provider = createReworkBudgetJudgment(async () => {
      attempts += 1;
      // ⛔ 첫 산출에 세 이름을 «넣지 않는다» — `pickClass` 가 관대해서(단어 경계 부분 일치)
      //    'probably EXTEND?' 같은 문장은 그대로 EXTEND 로 읽힌다. 그것은 실패가 «아니다».
      return attempts === 1 ? 'I cannot determine this from the given context.' : 'EXTEND';
    });
    const result = await provider(REWORK_BUDGET_JUDGMENT, { kind: 'review', goal: 'input' });
    // ⛔ 모집단 확인 — 시도가 «한 번»이면 재시도가 안 걸린 것이고 이 시험은 통과가 아니다.
    expect(attempts).toBeGreaterThan(1);
    expect(result).toMatchObject({ ok: true, output: 'EXTEND', verdict: 'continue' });
  });

  it('[lenient-parse-is-not-the-bug] 세 이름이 문장 «안»에 있으면 재시도 없이 읽힌다', async () => {
    let attempts = 0;
    const provider = createReworkBudgetJudgment(async () => {
      attempts += 1;
      return 'Given the trend, EXTEND. (rounds are converging)';
    });
    const result = await provider(REWORK_BUDGET_JUDGMENT, { kind: 'review', goal: 'input' });
    // ⭐ 이 시험이 있는 이유: 2026-08-11 에 내가 「엄격 일치가 런을 죽인다」고 «오진»했다.
    //    실제로는 이 경우가 «정상 통과»이고, 실패는 세 이름이 아예 안 온 경우다.
    expect(attempts).toBe(1);
    expect(result).toMatchObject({ ok: true, output: 'EXTEND' });
  });

  it('[says-how-many-attempts] 끝내 안 읽히면 시도 수와 기대 이름을 문면에 담는다', async () => {
    const provider = createReworkBudgetJudgment(async () => 'I cannot determine this.');
    const result = await provider(REWORK_BUDGET_JUDGMENT, { kind: 'review', goal: 'input' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('did not resolve a supported class');
    // ⭐ 이 두 줄이 이 시험의 값이다 — 종전 문면은 「안 풀렸다」만 말했다.
    expect(result.error).toContain('attempt(s)');
    expect(result.error).toContain('EXTEND|SUFFICIENT|UNCONVERGEABLE');
  });

  it('[normalized-loss-is-stated] 이 층은 «원본»을 못 본다 — 빈 응답과 엉뚱한 문장이 같은 값으로 온다', async () => {
    const empty = await createReworkBudgetJudgment(async () => '')(REWORK_BUDGET_JUDGMENT, { kind: 'gate', goal: 'input' });
    const wrong = await createReworkBudgetJudgment(async () => 'no idea')(REWORK_BUDGET_JUDGMENT, { kind: 'gate', goal: 'input' });
    expect(empty.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    // ⛔ 이것은 «바람직해서» 못 박는 것이 아니라 ***지금 그렇다는 사실***을 고정하는 것이다.
    //    `executeClassifyNode` 가 안 읽힌 산출을 'unknown' 으로 정규화해 넘기므로 이 층은 원본을 잃는다.
    //    ⇒ 원본이 필요해지면 `classify.ts` 가 실어야 하고, 그때 이 시험이 «깨져서» 알려 준다.
    expect(empty.error).toBe(wrong.error);
    expect(empty.error).toContain('unknown');
  });
});

// FLEX-RFC §A-③ — UNCONVERGEABLE 직전에 세우는 premise-review 카드. 카드는 기존 증거 관측에 실려
// 원장('rework-budget' 사건)으로 나간다 — 증거 관측 꼴은 카드가 있을 때만 `premiseReview` 칸이 더해진다.
describe('rework-budget@v1 — premise-review 카드', () => {
  it('UNCONVERGEABLE 직전에 카드를 세워 증거·원장 관측에 남긴다', async () => {
    const provider = createReworkBudgetJudgment(async () => 'UNCONVERGEABLE', {
      premiseInput: {
        runId: 'run-premise-wire',
        gateFailedIdsByRound: [
          [
            formatGateFailedId({ name: 'flex works', file: 'src/self-implement/flex-signals.test.ts', attribution: 'introduced' }),
            formatGateFailedId({ name: 'other red', file: 'src/other/place.test.ts', attribution: 'introduced' }),
          ],
        ],
        failureAttributions: ['introduced', 'introduced'],
        round: 3,
        plannedRounds: 3,
        targetPaths: ['src/self-implement/flex-signals.ts'],
      },
    });
    const result = await provider(REWORK_BUDGET_JUDGMENT, { kind: 'review', goal: 'input' });
    expect(result).toMatchObject({
      ok: true,
      output: 'UNCONVERGEABLE',
      verdict: 'abandon',
      evidence: {
        modelReasoning: 'UNCONVERGEABLE',
        premiseReview: {
          runId: 'run-premise-wire',
          proposal: { premise: 'P3', verdict: 'wrong', evidence: 'src/other/place.test.ts' },
        },
      },
    });
    expect(reworkBudgetEvidenceForObservation(provider.evidenceForObservation)).toEqual({
      evidence: {
        observations: {
          goal: { state: 'present', value: 'input' },
          outcome: { state: 'missing' },
          history: { state: 'missing' },
          kind: { state: 'present', value: 'review' },
        },
        modelReasoning: 'UNCONVERGEABLE',
        premiseReview: {
          runId: 'run-premise-wire',
          findings: [
            { premise: 'P1', verdict: 'unknown', evidence: '못 잼' },
            { premise: 'P2', verdict: 'ok', evidence: 'preexisting 0/2' },
            { premise: 'P3', verdict: 'wrong', evidence: 'src/other/place.test.ts' },
            { premise: 'P4', verdict: 'unknown', evidence: '못 잼' },
            { premise: 'P5', verdict: 'unknown', evidence: '못 잼' },
          ],
          proposal: { premise: 'P3', verdict: 'wrong', evidence: 'src/other/place.test.ts' },
        },
      },
    });
  });

  it('카드 입력을 주지 않으면 UNCONVERGEABLE 도 증거 꼴을 바꾸지 않는다', async () => {
    const provider = createReworkBudgetJudgment(async () => 'UNCONVERGEABLE');
    const result = await provider(REWORK_BUDGET_JUDGMENT, { kind: 'review', goal: 'input' });
    expect(result).toMatchObject({ ok: true, output: 'UNCONVERGEABLE', verdict: 'abandon' });
    expect(reworkBudgetEvidenceForObservation(provider.evidenceForObservation)).toEqual({
      evidence: {
        observations: {
          goal: { state: 'present', value: 'input' },
          outcome: { state: 'missing' },
          history: { state: 'missing' },
          kind: { state: 'present', value: 'review' },
        },
        modelReasoning: 'UNCONVERGEABLE',
      },
    });
  });
});
