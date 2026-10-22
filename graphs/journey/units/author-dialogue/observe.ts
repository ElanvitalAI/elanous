import { readFileSync } from 'node:fs';

/**
 * author-dialogue 단위의 읽기 전용 관측(RFC-progressive-goal-elaboration §7).
 * 기존 실행 경로(self-implement orchestrator)가 공급한 사건만 출구로 옮긴다 — 성공을 추정하지 않는다.
 * 사건이 없으면 needs-human(다른 여정 단위와 같은 규칙: 빠진 관측은 미해결 증거다).
 */
export type DialogueNode = 'author' | 'implement' | 'judge';
type Observation = { outcome?: unknown; data?: Record<string, unknown> };
type DialogueContext = { observations?: Record<string, Observation> };
/** 이 단위 안에서 앞서 돈 노드의 마지막 출력(graph-runner `outputs`) — 되돌이 판별·라운드 수에 쓴다. */
type PriorOutputs = Record<string, unknown>;

/**
 * author 는 E1 의 세 사건 중 «있는 것»을 읽는다 — `runArrivalElaboration`(src/self-implement/goal-elaborate.ts)이
 * 셋 중 하나만 낸다. skipped(공급자 없음·실패)는 카드 없이 오늘처럼 구현하므로 대화를 지나간다(deliver).
 */
const AUTHOR_EVENTS: ReadonlyArray<readonly [event: string, exit: string]> = [
  ['goal-elaboration-needs-human', 'needs-human'],
  ['goal-elaborated', 'deliver'],
  ['goal-elaboration-skipped', 'deliver'],
];
/**
 * author 되돌이(③ 답 = vN+1) — judge findings·implement ask 뒤 다시 들어오면 E3 `goal-refined`(GOAL-REFINE-FROM-FIRST-IMPL ·
 * src/self-implement/goal-refine.ts `runFirstRoundRefine`)를 읽는다. refined(v2)·kept(v1 유지 ⊕ 사유) 둘 다 deliver —
 * 방향·KPI 를 바꿔야 하는 경우는 goal-refine 이 v1 을 유지하고 사유(kept: fixed-layer-edit)를 남긴다.
 */
const REFINE_EVENT = 'goal-refined';
/** implement · judge 값 공급자 — 사건 값 → 출구 표 · 사건이 없으면 통과(done). judge 는 라운드별 값(`data.rounds`)도 읽는다. */
const VALUE_SOURCES: Record<Exclude<DialogueNode, 'author'>, { event: string; exits: Record<string, string> }> = {
  implement: { event: 'implement', exits: { done: 'done', ask: 'ask', 'needs-human': 'needs-human', failed: 'failed' } },
  judge: { event: 'judge', exits: { pass: 'done', findings: 'findings', 'needs-human': 'needs-human', failed: 'failed' } },
};
const NODES = new Set<DialogueNode>(['author', 'implement', 'judge']);

function observedValue(observation: Observation | undefined): string {
  const value = observation?.outcome ?? observation?.data?.outcome;
  return typeof value === 'string' ? value.trim() : '';
}

function priorResult(outputs: PriorOutputs | undefined, node: string): Record<string, unknown> | undefined {
  const output = outputs?.[node] as { result?: unknown } | undefined;
  return output && typeof output.result === 'object' && output.result !== null ? output.result as Record<string, unknown> : undefined;
}

export function observeDialogueNode(node: DialogueNode, context: DialogueContext, outputs?: PriorOutputs): {
  outcome: string;
  result: { node: DialogueNode; event: string; observed: boolean; value?: string; reason?: string; round?: number };
  evidence: { source: 'existing-harness-observation'; events: string[] };
} {
  const observations = context.observations ?? {};
  if (node === 'author' && (outputs?.judge !== undefined || outputs?.implement !== undefined)) {
    // ③ 되돌이 — 첫 왕복 뒤 다시 들어왔다. E3 goal-refined 가 없으면 미해결 증거(성공을 추정하지 않는다).
    const observation = observations[REFINE_EVENT];
    const evidence = { source: 'existing-harness-observation' as const, events: observation === undefined ? [] : [REFINE_EVENT] };
    if (observation === undefined) return { outcome: 'needs-human', result: { node, event: REFINE_EVENT, observed: false, reason: `missing-observation:${REFINE_EVENT}` }, evidence };
    const value = observedValue(observation);
    return { outcome: 'deliver', result: { node, event: REFINE_EVENT, observed: true, ...(value ? { value } : {}) }, evidence };
  }
  if (node === 'author') {
    const hit = AUTHOR_EVENTS.find(([event]) => observations[event] !== undefined);
    const events = AUTHOR_EVENTS.map(([event]) => event).filter((event) => observations[event] !== undefined);
    const evidence = { source: 'existing-harness-observation' as const, events };
    if (!hit) return { outcome: 'needs-human', result: { node, event: 'goal-elaborated', observed: false, reason: 'missing-observation:goal-elaborated' }, evidence };
    return { outcome: hit[1], result: { node, event: hit[0], observed: true, ...(observedValue(observations[hit[0]]) ? { value: observedValue(observations[hit[0]]) } : {}) }, evidence };
  }
  const { event, exits } = VALUE_SOURCES[node];
  // judge 는 라운드마다 다른 값을 낸다 — `data.rounds[n-1]`(n = 이 단위에서 judge 를 몇 번째로 도는가).
  const round = node === 'judge' ? Number(priorResult(outputs, 'judge')?.round ?? 0) + 1 : undefined;
  const rounds = observations[event]?.data?.rounds;
  const value = round !== undefined && Array.isArray(rounds)
    ? (typeof rounds[round - 1] === 'string' ? (rounds[round - 1] as string).trim() : '')
    : observedValue(observations[event]);
  const evidence = { source: 'existing-harness-observation' as const, events: value ? [event] : [] };
  // ⭐ 선언만인 간선(②③④)은 아직 관측 공급자가 없다(GOAL-REFINE-FROM-FIRST-IMPL) — 사건이 없으면 «통과»한다.
  //   성공을 추정하는 것이 아니라 «이 왕복은 아직 실행되지 않는다»를 이유와 함께 적는다(observed:false).
  //   그렇지 않으면 E1 이 성공해도 실제 여정이 여기서 needs-human 으로 멈춘다.
  const at = round !== undefined ? { round } : {};
  if (!value) return { outcome: 'done', result: { node, event, observed: false, reason: 'declared-only:pass-through', ...at }, evidence };
  const outcome = exits[value];
  if (!outcome) return { outcome: 'needs-human', result: { node, event, observed: true, value, reason: 'unknown-observation-value', ...at }, evidence };
  return { outcome, result: { node, event, observed: true, value, ...at }, evidence };
}

if (import.meta.main) {
  const node = process.argv[2] as DialogueNode;
  try {
    if (!NODES.has(node)) throw new Error(`unknown dialogue node: ${node}`);
    const path = process.env.ELANOUS_GRAPH_CONTEXT;
    if (!path) throw new Error('ELANOUS_GRAPH_CONTEXT is required');
    const graphContext = JSON.parse(readFileSync(path, 'utf8')) as { input?: { context?: DialogueContext }; outputs?: PriorOutputs };
    process.stdout.write(`${JSON.stringify(observeDialogueNode(node, graphContext.input?.context ?? {}, graphContext.outputs))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ outcome: 'failed', result: { node, observed: false, reason: error instanceof Error ? error.message : String(error) }, evidence: { source: 'existing-harness-observation', events: [] } })}\n`);
  }
}
