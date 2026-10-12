import { executeClassifyNode } from '../workflow-runtime/nodes/classify.js';
import { buildPremiseCard, type PremiseReviewCard, type PremiseReviewInput } from './premise-review.js';
import { SUPERVISION_REWORK_SOURCES, type SupervisionReworkSource } from './supervision-vocabulary.js';
import type { ClassifyNode, JudgmentContext, JudgmentResult, NodeExecContext, WorkflowDefinition, WorkflowDeps } from '../workflow-runtime/types.js';

export const REWORK_BUDGET_JUDGMENT = 'rework-budget@v1';

// ⛔⭐⭐ **이 집합을 «손으로» 나열하지 않는다**(2026-08-14 회귀 · `[S]`).
//   `#9082` 가 `SupervisionReworkSource` 에 `'supervisor'` 를 더했는데 여기가 그 값을 몰라
//   ***런이 `rework-budget@v1 requires observation 'kind' …` 로 죽었다.***
//   🔑 「닫힌 집합에 값을 더했는데 그 값을 모르는 소비처」 — 이번엔 조용히 삼키지 «않고» 하드 에러였다.
//   ⇒ 어휘 SSOT 를 «물어» 다음 추가에서 이 자리가 자동으로 따라오게 한다.
type ReworkKind = SupervisionReworkSource;
type ReworkClass = 'EXTEND' | 'SUFFICIENT' | 'UNCONVERGEABLE';
type ReworkVerdict = 'continue' | 'complete' | 'abandon';
type ObservationState = 'missing' | 'empty' | 'present';

interface ObservedValue {
  state: ObservationState;
  value?: unknown;
}

interface ReworkBudgetEvidence {
  observations: Record<'goal' | 'outcome' | 'history' | 'kind', ObservedValue>;
  modelReasoning: string;
  /** UNCONVERGEABLE 직전에 세운 premise-review 카드(FLEX-RFC §A-③). 카드를 안 만든 판정에는 키가 없다. */
  premiseReview?: PremiseReviewCard | undefined;
}

type EvidencedJudgmentResult = JudgmentResult & { evidence: ReworkBudgetEvidence };

function withEvidence(result: JudgmentResult, evidence: ReworkBudgetEvidence): EvidencedJudgmentResult {
  return { ...result, evidence };
}

function observe(value: unknown): ObservedValue {
  if (value === undefined || value === null) return { state: 'missing' };
  if (typeof value === 'string' && value.length === 0) return { state: 'empty', value };
  if (Array.isArray(value) && value.length === 0) return { state: 'empty', value };
  if (typeof value === 'object' && Object.keys(value).length === 0) return { state: 'empty', value };
  return { state: 'present', value };
}

function observedContext(ctx: JudgmentContext, kind: ReworkKind): ReworkBudgetEvidence['observations'] {
  return {
    goal: observe(ctx.goal),
    outcome: observe(ctx.outcome),
    history: observe(ctx.history),
    kind: observe(kind),
  };
}

export const reworkBudgetWorkflow: WorkflowDefinition = {
  name: 'rework-budget-judgment',
  description: 'Declared rework budget judgment contract.',
  nodes: [{
    id: 'rework-budget',
    prompt: 'Classify the rework budget judgment.',
    judgment: REWORK_BUDGET_JUDGMENT,
    cadence: 'once',
    observes: ['goal', 'outcome', 'history', 'kind'],
    vocabulary: ['continue', 'complete', 'abandon'],
    executions: ['extend-budget', 'terminate', 'finalize'],
  }],
};

/** ⛔⭐⭐ 분류가 «안 읽혔을 때» 재시도 — `classify.ts` 가 이미 지원하는데 이 자리가 «안 줬다»(2026-08-11).
 *  📏 실측: 그래서 rework 예산이 «남았는데도»(3/5) 수렴 중이던 런이 죽었다 — 리뷰 지적이
 *     4→3→2 로 줄고 gate 도 매 라운드 통과하던 런이었다. 같은 결함으로 «그 결함을 고치려던 런»도 죽었다.
 *  ⚠️⛔ 오진 주의(같은 날 내가 밟았다): ***아래 `reworkClass` 의 엄격 일치는 원인이 «아니다».***
 *     `pickClass`(`classify.ts:23`)가 «관대»해서 `EXTEND.` · `probably EXTEND?` 도 `EXTEND` 로 읽는다.
 *     ⇒ 여기 도착하는 값은 «세 클래스 아니면 `'unknown'`» 뿐이다. 즉 실패는 ***LLM 이 세 이름을
 *     한 번도 안 쓴 경우***(빈 응답·거부·다른 말)이고, 그때 ***재시도가 0회***인 것이 결함이었다.
 *  ⚠️ 재시도는 `'unknown'` 해결과 throw 둘 다에 걸린다(`classify.ts:100`) ⇒ 여기서 그 둘을 다시 안 센다. */
const CLASSIFY_RETRIES = 2;
const CLASSIFY_RETRY_DELAY_MS = 400;

function reworkClass(value: unknown): ReworkClass | undefined {
  return value === 'EXTEND' || value === 'SUFFICIENT' || value === 'UNCONVERGEABLE' ? value : undefined;
}

/** ⛔ 「무엇이 왔는지」를 말한다 — 종전 문면은 «안 풀렸다»만 말했다(2026-08-11 실측).
 *  ⚠️⛔ 다만 ***이 층은 「원본」을 못 본다*** — `executeClassifyNode` 가 안 읽힌 산출을 이미
 *     `'unknown'` 으로 «정규화»해서 넘긴다(`classify.ts:99`). ⇒ 빈 응답과 엉뚱한 문장이 여기 오면
 *     ***둘 다 `'unknown'`*** 이다. 그 사실을 숨기지 않고 문면에 그대로 적는다.
 *     (원본을 보려면 `classify.ts` 가 실어 줘야 하고, 그것은 이 자리의 범위가 아니다.) */
function describeUnresolvedClass(value: unknown): string {
  if (value === undefined || value === null) return `absent (${value === null ? 'null' : 'undefined'})`;
  if (typeof value !== 'string') return `non-string ${typeof value}`;
  if (value.length === 0) return 'empty string';
  const trimmed = value.trim();
  if (trimmed.length === 0) return `whitespace-only (${value.length} chars)`;
  const shown = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
  return `${JSON.stringify(shown)} (${trimmed.length} chars)`;
}

export function mapReworkBudgetVerdict(picked: ReworkClass, kind: ReworkKind): ReworkVerdict {
  if (picked === 'EXTEND') return 'continue';
  if (picked === 'UNCONVERGEABLE') return 'abandon';
  return kind === 'review' ? 'complete' : 'continue';
}

export function reworkBudgetEvidenceForObservation(readEvidence: () => unknown): { evidence: unknown; evidenceReadError?: string } {
  try {
    return { evidence: readEvidence() ?? null };
  } catch (error) {
    return {
      evidence: null,
      evidenceReadError: String(error instanceof Error ? error.message : error).slice(0, 240),
    };
  }
}

/** `createReworkBudgetJudgment` 의 선택 인자 — 주지 않으면 카드 없이 지금 동작 그대로. */
export interface ReworkBudgetJudgmentOpts {
  /** UNCONVERGEABLE 판정 직전에 세울 premise-review 카드의 입력(값 객체). */
  premiseInput?: PremiseReviewInput | undefined;
}

export function createReworkBudgetJudgment(callLLM: WorkflowDeps['callLLM'], opts: ReworkBudgetJudgmentOpts = {}) {
  let latestEvidence: ReworkBudgetEvidence | undefined;
  const provider = async (contractId: string, ctx: JudgmentContext): Promise<JudgmentResult> => {
    if (contractId !== REWORK_BUDGET_JUDGMENT) {
      return { ok: false, output: '', error: `unsupported judgment contract '${contractId}'` };
    }

    // ⛔⭐ 목록을 «여기서» 다시 적지 않는다 — 어휘 SSOT 를 그대로 문다(위 머리말 참조).
    //   그리고 오류 문면도 그 SSOT 에서 «만든다»: 값이 늘면 사람이 보는 문장도 같이 늘어난다.
    const kind = ctx.kind as SupervisionReworkSource | undefined;
    if (!kind || !SUPERVISION_REWORK_SOURCES.includes(kind)) {
      return {
        ok: false,
        output: '',
        error: `rework-budget@v1 requires observation 'kind' to be one of ${SUPERVISION_REWORK_SOURCES.map((s) => `'${s}'`).join(' | ')}`,
      };
    }

    const node: ClassifyNode = {
      id: 'rework-budget',
      classify: {
        input: '$ARGUMENTS',
        classes: ['EXTEND', 'SUFFICIENT', 'UNCONVERGEABLE'],
        retries: CLASSIFY_RETRIES,
        retryDelayMs: CLASSIFY_RETRY_DELAY_MS,
      },
    };
    const observations = observedContext(ctx, kind);
    const execContext: NodeExecContext = {
      arguments: JSON.stringify({ observations }),
      artifactsDir: '',
      outputs: {},
      resolvedProvider: undefined,
      resolvedModel: undefined,
      toolPolicy: {},
    };
    let modelReasoning = '';
    let premiseReview: PremiseReviewCard | undefined;
    const result = await executeClassifyNode(node, execContext, {
      callLLM: async (args) => {
        modelReasoning = await callLLM(args);
        return modelReasoning;
      },
      runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });
    const evidence = (): ReworkBudgetEvidence => ({
      observations,
      modelReasoning,
      ...(premiseReview === undefined ? {} : { premiseReview }),
    });
    const evidenced = (judgment: JudgmentResult): EvidencedJudgmentResult => {
      const resultWithEvidence = withEvidence(judgment, evidence());
      latestEvidence = resultWithEvidence.evidence;
      return resultWithEvidence;
    };
    if (!result.ok) return evidenced({ ok: false, output: result.output, error: result.error });

    const picked = reworkClass(result.output);
    if (!picked) {
      // ⛔ 「분류가 안 읽혔다」와 「감독이 끝내라 했다(UNCONVERGEABLE)」는 «다른 사건»이다.
      //    후자는 아래에서 ok:true ⊕ verdict='abandon' 으로 나간다 — 이 자리는 «판정 부재»다.
      return evidenced({
        ok: false,
        output: result.output,
        error: `rework-budget@v1 classification did not resolve a supported class`
          + ` — got ${describeUnresolvedClass(result.output)} after ${CLASSIFY_RETRIES + 1} attempt(s);`
          + ` expected one of EXTEND|SUFFICIENT|UNCONVERGEABLE`,
      });
    }
    const verdict = mapReworkBudgetVerdict(picked, kind);
    // FLEX-RFC §A-③ — UNCONVERGEABLE 을 «내기 전에» 전제를 되짚는다. 카드는 기존 증거 관측에 실려
    // 원장('rework-budget' 사건)으로 나간다 — 사건 형식은 그대로, 카드는 증거 안의 추가 칸이다.
    if (picked === 'UNCONVERGEABLE' && opts.premiseInput !== undefined) {
      premiseReview = buildPremiseCard(opts.premiseInput);
    }
    return evidenced({ ok: true, output: picked, verdict });
  };
  return Object.assign(provider, { evidenceForObservation: () => latestEvidence });
}
