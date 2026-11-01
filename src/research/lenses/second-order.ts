/** Chain order a synthesis step lands in: what happens first, what that causes, what that settles. */
export type SecondOrderOrder = 'primary' | 'secondary' | 'tertiary';

export interface SecondOrderLensStage {
  order: SecondOrderOrder;
  label: string;
  horizonDays: number;
  purpose: string;
}

/** Public lens definition: what the T2 second-order lens is and which orders it fans a synthesis into. */
export interface SecondOrderLensDefinition {
  id: string;
  cell: string;
  tier: string;
  rfc: string;
  description: string;
  stages: readonly SecondOrderLensStage[];
}

/** Public verification format attached to every secondary effect. */
export interface SecondOrderVerificationNode {
  claim: string;
  scenarioCondition: string | null;
  metric: string | null;
  expectedValue: number | null;
  threshold: number | null;
  unit: string | null;
  windowDays: number;
  falsifiable: boolean | null;
  measurementStatus: 'unmeasured' | 'needs-operationalization';
  evidenceSource: string | null;
}

export interface SecondOrderEvidenceFact {
  questionId: string;
  question: string;
  content: string;
  source: string;
  outcome: 'complete' | 'partial' | 'failed';
  observedWindow?: string;
  units?: string;
}

export interface SecondOrderChainNode {
  id: string;
  order: SecondOrderOrder;
  orderIndex: 1 | 2 | 3;
  statement: string;
  horizonDays: number;
  derivedFrom: readonly string[];
  verification: SecondOrderVerificationNode | null;
}

/** Public result-chain format: primary → secondary → tertiary, with secondary effects verified. */
export interface SecondOrderResultChain {
  lensId: string;
  question: string;
  orderStages: readonly SecondOrderLensStage[];
  nodes: readonly SecondOrderChainNode[];
}

export type SecondOrderTriggerKind = 'decision' | 'forecast' | 'none';

export interface SecondOrderTriggerDecision {
  triggered: boolean;
  kind: SecondOrderTriggerKind;
  score: number;
  matchedSignals: readonly string[];
  reason: string;
}

export interface SecondOrderLensInput {
  question: string;
  synthesis: readonly string[];
  /** IDs must align with synthesis; evidence is joined by questionId, never by flat-array position. */
  synthesisQuestionIds?: readonly string[];
  evidenceFacts?: readonly SecondOrderEvidenceFact[];
}

export interface SecondOrderLensResult {
  lens: SecondOrderLensDefinition;
  trigger: SecondOrderTriggerDecision;
  chain: SecondOrderResultChain | null;
}

/** Injection seam lets a host supply private trigger calibration without shipping it here. */
export type SecondOrderTriggerClassifier = (question: string) => SecondOrderTriggerDecision;

export const SECOND_ORDER_LENS: SecondOrderLensDefinition = {
  id: 'second-order',
  cell: 'THINK-LENS-T2-SECOND-ORDER',
  tier: 'T2',
  rfc: 'RFC-PRO §2',
  description: '결정·예측 질문에서 6단 종합을 1차 → 2차 → 3차 결과 사슬로 펼치고, 2차 효과마다 검증 노드를 붙인다.',
  stages: [
    {
      order: 'primary',
      label: '1차 결과',
      horizonDays: 30,
      purpose: '결정이나 예측이 직접 만드는 즉시 효과',
    },
    {
      order: 'secondary',
      label: '2차 결과',
      horizonDays: 180,
      purpose: '1차 효과가 다른 주체로 전이되며 생기는 효과 — 검증 노드가 붙는 자리',
    },
    {
      order: 'tertiary',
      label: '3차 결과',
      horizonDays: 540,
      purpose: '2차 효과가 구조·규범·시장에 정착하며 생기는 효과',
    },
  ],
};

const DECISION_QUESTION_FORM = /(?:해야\s*(?:할까|하나|할지)|(?:고르|선택|결정|전환|도입|투자|진입|매수|매도)(?:해야\s*(?:할까|하나|할지)|할까|할지\s*(?:말지|여부)))|\b(?:should\s+(?:i|we)|whether\s+to|choose\s+between|decide\s+whether)\b/i;
const FORECAST_QUESTION_FORM = /(?:얼마나\s+[^?\n]{0,80}(?:될|오를|내릴|늘어날|줄어들|바뀔|변할)|(?:언제|몇)\s+[^?\n]{0,80}(?:될|오를|내릴|늘어날|줄어들|바뀔)|어떻게\s+(?:될까|변할까))|\b(?:how\s+much|how\s+many)\s+(?:will|might|could|is\s+expected\s+to|is\s+projected\s+to)\b.{0,120}\b(?:rise|fall|grow|shrink|change|cost|be)\b|\b(?:when\s+will|what\s+will)\b.{0,120}\b(?:rise|fall|grow|shrink|change|cost|be)\b|\bwill\s+[^?\n]{1,120}\b(?:increase|decrease|rise|fall|grow|shrink|change|cost|remain|reach|exceed|decline)\b/i;

/** Decide whether a question is a decision or a forecast, i.e. whether the second-order lens applies. */
export function detectSecondOrderTrigger(question: string): SecondOrderTriggerDecision {
  const text = requireText(question, 'question').toLowerCase();
  if (!/[?？]\s*$/u.test(text)) return noTrigger();
  const decision = DECISION_QUESTION_FORM.exec(text);
  const forecast = FORECAST_QUESTION_FORM.exec(text);
  const kind: SecondOrderTriggerKind = decision ? 'decision' : forecast ? 'forecast' : 'none';
  const score = kind === 'none' ? 0 : 1;
  const matchedSignals = Object.freeze(kind === 'decision' ? ['decision-form'] : kind === 'forecast' ? ['forecast-form'] : []);
  if (kind === 'none') {
    return {
      triggered: false,
      kind: 'none',
      score,
      matchedSignals,
      reason: '질문이 결정이나 예측이 아니라 결과 사슬을 펼치지 않는다',
    };
  }
  return {
    triggered: true,
    kind,
    score,
    matchedSignals,
    reason: kind === 'decision'
      ? '결정 질문이므로 1차 → 2차 → 3차 결과 사슬을 펼친다'
      : '예측 질문이므로 1차 → 2차 → 3차 결과 사슬을 펼친다',
  };
}

function noTrigger(): SecondOrderTriggerDecision {
  return {
    triggered: false,
    kind: 'none',
    score: 0,
    matchedSignals: Object.freeze([]),
    reason: '결정·예측 질문형이 아니므로 결과 사슬을 펼치지 않는다',
  };
}

/** Expand synthesis steps into a primary → secondary → tertiary chain with a verification node on each secondary effect. */
export function buildSecondOrderResultChain(input: SecondOrderLensInput): SecondOrderResultChain {
  const question = requireText(input.question, 'question');
  const steps = input.synthesis.map((step, index) => requireText(step, `synthesis[${index}]`));
  if (input.evidenceFacts?.length && input.synthesisQuestionIds?.length !== steps.length) {
    throw new Error('synthesisQuestionIds must align with synthesis when evidenceFacts are supplied');
  }
  if (steps.length < SECOND_ORDER_LENS.stages.length) {
    throw new Error('synthesis requires at least three steps to expand into a result chain');
  }

  const buckets = splitIntoOrders(steps, SECOND_ORDER_LENS.stages.length);
  const nodes: SecondOrderChainNode[] = [];
  let previousIds: string[] = [];
  for (const [stageIndex, stage] of SECOND_ORDER_LENS.stages.entries()) {
    const stageIds: string[] = [];
    for (const [stepIndex, statement] of buckets[stageIndex]!.entries()) {
      const inputIndex = buckets.slice(0, stageIndex).reduce((count, bucket) => count + bucket.length, 0) + stepIndex;
      const questionId = input.synthesisQuestionIds?.[inputIndex];
      const fact = questionId ? combineQuestionEvidence(questionId, input.evidenceFacts ?? []) : undefined;
      const id = `${stage.order}-${stepIndex + 1}`;
      stageIds.push(id);
      const parentIndex = stageIndex === 0 ? -1 : Math.min(stepIndex, previousIds.length - 1);
      const parentId = parentIndex >= 0 ? previousIds[parentIndex] : undefined;
      const parent = parentId ? nodes.find((node) => node.id === parentId) : undefined;
      const outputStatement = fact
        ? makeOutcomeHypothesis(stage.order, question, fact, parent?.statement)
        : stage.order === 'primary'
          ? `1차 가설: ${statement}`
          : `${stage.order === 'secondary' ? '2차' : '3차'} 가설: ${parent?.statement ?? '앞 단계 결과'}가 이어지면 ${statement}라는 후속 결과가 생길 수 있다.`;
      nodes.push({
        id,
        order: stage.order,
        orderIndex: (stageIndex + 1) as 1 | 2 | 3,
        statement: outputStatement,
        horizonDays: stage.horizonDays,
        derivedFrom: Object.freeze(parentId ? [parentId] : []),
        verification: stage.order === 'secondary'
          ? buildVerificationNode(outputStatement, fact, stepIndex)
          : null,
      });
    }
    previousIds = stageIds;
  }

  return {
    lensId: SECOND_ORDER_LENS.id,
    question,
    orderStages: SECOND_ORDER_LENS.stages,
    nodes: Object.freeze(nodes),
  };
}

/** Run the lens: the trigger decides whether a chain is produced at all. */
export function applySecondOrderLens(
  input: SecondOrderLensInput,
  classifyTrigger: SecondOrderTriggerClassifier = detectSecondOrderTrigger,
): SecondOrderLensResult {
  const trigger = classifyTrigger(input.question);
  if (!trigger.triggered) return { lens: SECOND_ORDER_LENS, trigger, chain: null };
  return { lens: SECOND_ORDER_LENS, trigger, chain: buildSecondOrderResultChain(input) };
}

function buildVerificationNode(statement: string, fact: SecondOrderEvidenceFact | undefined, index: number): SecondOrderVerificationNode {
  const metric = fact?.outcome === 'complete' ? extractObservableMetric(fact.content) : null;
  const windowDays = 90 * (index + 1);
  const scenarioCondition = metric && fact
    ? `${fact.observedWindow ? `${fact.observedWindow} 기준선` : '확인 가능한 기준선'}과 ${windowDays}일 뒤 ${metric}을 비교한다. 판정 임계값은 아직 정하지 않았다.`
    : null;
  return {
    claim: statement,
    scenarioCondition,
    metric,
    expectedValue: null,
    threshold: null,
    unit: fact?.units ?? null,
    windowDays,
    falsifiable: null,
    measurementStatus: metric ? 'needs-operationalization' : 'unmeasured',
    evidenceSource: fact?.source ?? null,
  };
}

function splitIntoOrders(steps: readonly string[], orderCount: number): string[][] {
  const base = Math.floor(steps.length / orderCount);
  const remainder = steps.length % orderCount;
  const buckets: string[][] = [];
  let cursor = 0;
  for (let index = 0; index < orderCount; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    buckets.push(steps.slice(cursor, cursor + size));
    cursor += size;
  }
  return buckets;
}

function makeOutcomeHypothesis(
  order: SecondOrderOrder,
  question: string,
  fact: SecondOrderEvidenceFact,
  parentStatement?: string,
): string {
  const detail = compactEvidence(fact.content);
  const citation = `[${fact.questionId}; ${fact.source}; ${fact.outcome}]`;
  if (fact.outcome !== 'complete') {
    return `${order === 'primary' ? '1차' : order === 'secondary' ? '2차' : '3차'} 가설 미작성: ${fact.question}에 대한 완전한 근거를 확보하지 못했다 (${fact.outcome}; ${citation}).`;
  }
  if (order === 'primary') return `1차 가설: 「${question}」의 직접 효과 후보는 「${detail}」이다. 근거 ${citation}`;
  if (order === 'secondary') return `2차 가설: 「${parentStatement ?? '직접 결과'}」가 이어질 경우 「${detail}」라는 후속 효과가 생길 수 있다. 근거 ${citation}`;
  return `3차 가설: 「${parentStatement ?? '2차 효과'}」가 지속될 경우 「${detail}」라는 장기 결과로 이어질 수 있다. 근거 ${citation}`;
}

function compactEvidence(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function combineQuestionEvidence(questionId: string, evidenceFacts: readonly SecondOrderEvidenceFact[]): SecondOrderEvidenceFact | undefined {
  const matching = evidenceFacts.filter((fact) => fact.questionId === questionId);
  if (!matching.length) return undefined;
  const complete = matching.filter((fact) => fact.outcome === 'complete');
  const selected = complete.length ? complete : matching;
  const units = [...new Set(selected.map((fact) => fact.units).filter((unit): unit is string => Boolean(unit)))].join(', ');
  const observedWindow = [...new Set(selected.map((fact) => fact.observedWindow).filter((window): window is string => Boolean(window)))].join(', ');
  return {
    questionId,
    question: selected[0]!.question,
    content: selected.map((fact) => fact.content).join(' · '),
    source: [...new Set(selected.map((fact) => fact.source))].join(', '),
    outcome: complete.length ? 'complete' : selected.some((fact) => fact.outcome === 'partial') ? 'partial' : 'failed',
    ...(observedWindow ? { observedWindow } : {}),
    ...(units ? { units } : {}),
  };
}

function extractObservableMetric(value: string): string | null {
  const patterns = [
    /(?:응답\s*시간|처리\s*시간|처리량|대기\s*시간|전환율|이탈률|잔존율|오류율|정확도|매출|수익|비용|수출액|수출량|문의\s*건수|사용자\s*수|판매량|생산성|파이프라인)/iu,
    /\b(?:response time|processing time|wait time|conversion rate|churn rate|retention rate|error rate|accuracy|revenue|cost|export volume|inquiry count|user count|sales volume|productivity|pipeline|adoption rate|demand)\b/iu,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[0]) return match[0].replace(/\s+/g, ' ').trim();
  }
  return null;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  return value.trim();
}
