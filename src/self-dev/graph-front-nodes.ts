import { debug } from '../debug/log.js';
import type { GoalType } from '../self-implement/goal-author.js';
import { frontObservationTemplate, visitBudgetOfVisits, type VisitBudgetReading } from '../self-implement/graph-authority.js';
import { GRAPH_TEMPLATES_SOURCE, graphIdentityOf, pipelineNodeEntryPayload, type GraphTemplate } from '../self-implement/graph-templates.js';
import { appendRunLedgerEntry, runLedgerDir } from '../self-implement/run-ledger.js';
import { journeyJoinFields } from './graph-journey-nodes.js';
import { journeySpec, readJourneyEdge, recordJourneyEdge, type JourneyRoute } from './graph-journey-route.js';

/** ⭐ RFC §5 «5단계» — 전반부(저작·플랜·분해) 노드를 그래프 관측에 «잇는다».
 *
 *  🩸 계기(2026-09-08): `default-loop.yaml` 이 `author → plan → decompose` 를 «선언»했는데
 *    원장 표본이 **0** 이었다 — `self-dev` 에 `pipeline-node-entry` 가 «한 건도» 없다(실측).
 *    ⇒ 「선언했다」와 「돈다」가 갈린 자리가 «전반부 전체»였다.
 *
 *  ⛔⭐ 이것은 «관측»이지 «제어»가 아니다 — 흐름을 바꾸지 않는다.
 *    전반부를 그래프가 «몰게» 하는 것은 다음 판이고, 그 전에 ***돌고 있는 것을 볼 수 있어야 한다***.
 *  ⛔ 실패는 fail-soft — 관측이 저작을 죽이지 않는다. */
/** ⭐ 런타임 «값»으로 둔다 — 타입만 있으면 시험이 「YAML 이 이 셋만 더했나」를 «못 센다».
 *  🩸 2026-09-10: 이 상수가 없어서 YAML(11노드)과 코드 상수(8노드)의 갈림을 무는 자가
 *     「정확히 같다」로만 쓰여 있었고, 그래서 의도된 확장이 main 을 «빨갛게» 만들었다. */
export const FRONT_NODE_IDS = ['author', 'plan', 'decompose'] as const;
export type FrontNodeId = typeof FRONT_NODE_IDS[number];

export type FrontNodeEntryProvenance =
  | 'authoring-start'
  | 'authoring-plan'
  | 'authoring-decomposition-start'
  | 'supervisor-promotion-attempt'
  | 'supervisor-pre-promotion-decision';

/** 런별 전반부 노드 방문 계수 — runId → (node → 진입 횟수) ⊕ 마지막 진입 시각.
 *  ⛔ 방문 배열·기록 전체를 보관하지 않는다 — «노드→정수 카운트» 만 둔다(매 진입 O(1)·배열 없음).
 *  ⛔ «개수»로 버리지 않는다 — 개수 상한은 진행 중인 런도 밀어내 같은 런의 계수를 1 로 되돌린다.
 *  ✅ «유휴 시간»으로만 버린다: 마지막 진입 뒤 `FRONT_VISIT_IDLE_TTL_MS` 가 지난 런. 런 종료 신호가
 *     이 모듈에 없어서, 이것이 오래 도는 프로세스(TUI·데몬)의 누수를 막는 자리다. 한 런의 전반부
 *     (author·plan·decompose)는 분 단위로 이어지므로 6시간 멈춘 런은 «진행 중»이 아니다.
 *     보관 크기는 「그 시간 안에 전반부를 밟은 런 수」로 묶인다. */
export const FRONT_VISIT_IDLE_TTL_MS = 6 * 60 * 60 * 1000;
/** 정리 훑기는 «가끔»만 한다 — 직전 훑기 뒤 1분이 안 됐으면 건너뛴다(크기와 무관 · 소수 런도 정리된다).
 *  ⇒ 훑기 비용 O(n) 은 «분당 한 번»으로 상각되고, 나머지 진입은 O(1) 이다. */
const FRONT_VISIT_PRUNE_INTERVAL_MS = 60 * 1000;
let lastFrontVisitPruneMs = Number.NEGATIVE_INFINITY;
const frontNodeVisitCounts = new Map<string, { byNode: Map<string, number>; lastSeenMs: number }>();
let frontVisitNow: () => number = () => Date.now();

/** 시험 전용 — 보관 중인 런 수. */
export function frontVisitRunCountForTesting(): number {
  return frontNodeVisitCounts.size;
}

/** 시험 전용 — 모듈 상태를 비우고 시계를 되돌린다(시험 사이 간섭 방지). */
export function resetFrontVisitCountsForTesting(now?: () => number): void {
  frontNodeVisitCounts.clear();
  frontVisitNow = now ?? (() => Date.now());
  lastFrontVisitPruneMs = Number.NEGATIVE_INFINITY;
}

/** Explicit context carried by a front-node handler. The same object can grow to
 *  hold authoring evidence and budget/checkpoint data without changing handlers. */
export interface FrontNodeUnitContext {
  readonly runId?: string;
  readonly goalType?: GoalType;
}

/** A front-half processing unit with an explicit input, context, and output. */
export interface FrontNodeUnit<Input, Output> {
  readonly node: FrontNodeId;
  readonly execute: (input: Input, context: FrontNodeUnitContext) => Promise<Output>;
}

/** Record the actual front-half execution boundary, without controlling the stage. */
export async function observeFrontNodeUnit<T>(node: FrontNodeId, runId: string | undefined, goalType: GoalType | undefined, execute: () => Promise<T>): Promise<T> {
  const emit = (phase: 'enter' | 'exit'): void => {
    if (!runId) return;
    try {
      const template = frontObservationTemplate(goalType);
      const contractId = template.nodes.find((item) => item.nodeId === node)?.recipe ?? null;
      const data = { graphId: template.graphId, nodeId: node, unit: node, contractId, phase };
      try { appendRunLedgerEntry({ timestamp: new Date().toISOString(), runId, event: 'graph.unit', data }, runLedgerDir()); }
      catch { /* ledger failure cannot change execution */ }
      try { debug.log('graph.unit', phase, { ...data, runId }); }
      catch { /* debug failure cannot change execution */ }
    } catch { /* template failure cannot change execution */ }
  };
  emit('enter');
  try { return await execute(); }
  finally { emit('exit'); }
}

/** Execute one typed front-node unit while preserving the caller's context and
 *  the fail-soft graph.unit observation contract. */
export function runFrontNodeUnit<Input, Output>(
  unit: FrontNodeUnit<Input, Output>,
  input: Input,
  context: FrontNodeUnitContext,
): Promise<Output> {
  return observeFrontNodeUnit(unit.node, context.runId, context.goalType, () => unit.execute(input, context));
}

function pruneIdleFrontVisitRuns(nowMs: number): void {
  if (nowMs - lastFrontVisitPruneMs < FRONT_VISIT_PRUNE_INTERVAL_MS) return;
  lastFrontVisitPruneMs = nowMs;
  for (const [runId, entry] of frontNodeVisitCounts) {
    if (nowMs - entry.lastSeenMs > FRONT_VISIT_IDLE_TTL_MS) frontNodeVisitCounts.delete(runId);
  }
}

/** 같은 runId 안의 노드별 진입 수로 `visitBudgetOf` 와 같은 모양의 판독을 만든다. */
function frontNodeVisitCount(template: GraphTemplate, node: string, runId: string): VisitBudgetReading | null {
  const nowMs = frontVisitNow();
  pruneIdleFrontVisitRuns(nowMs);
  let entry = frontNodeVisitCounts.get(runId);
  if (entry === undefined || nowMs - entry.lastSeenMs > FRONT_VISIT_IDLE_TTL_MS) {
    entry = { byNode: new Map<string, number>(), lastSeenMs: nowMs };
    frontNodeVisitCounts.set(runId, entry);
  }
  entry.lastSeenMs = nowMs;
  const visits = (entry.byNode.get(node) ?? 0) + 1;
  entry.byNode.set(node, visits);
  // ⛔ 방문 배열을 만들지 않는다 — 계수를 직접 건넨다(매 진입마다 배열 할당 없이 같은 판독).
  return visitBudgetOfVisits(template, node, visits);
}

/** 전반부 노드 진입을 원장에 남긴다. ⛔ `runSelfImplement` 의 것과 «같은 사건 이름»을 쓴다 —
 *  이름이 갈리면 「한 런이 어디까지 갔나」를 한 질의로 못 묻는다.
 *  ⭐ runId 가 있으면 방문 예산 판독(`graph-visit-budget`)도 남긴다 — 후반부 `visitBudgetOf` 와 같은 모양.
 *  호출부(실행 경로): src/self-dev/ask-launch-flow.ts — author(authoring-start) · plan(authoring-plan) ·
 *    decompose(authoring-decomposition-start) / src/self-dev/dev-cli.ts — decompose 둘(supervisor-*). */
export function observeFrontNodeEntry(node: FrontNodeId, data: {
  readonly provenance: FrontNodeEntryProvenance;
  readonly runId?: string;
  readonly goalId?: string;
  readonly goalType?: string;
  readonly round?: number;
}): void {
  try {
    const template = frontObservationTemplate(data.goalType === 'implement' ? 'implement' : undefined);
    debug.log('self-implement', 'pipeline-node-entry', {
      ...pipelineNodeEntryPayload(template, node),
      node,
      round: data.round ?? 0,
      ...(data.runId === undefined ? {} : { runId: data.runId }),
      ...(data.goalId === undefined ? {} : { goalId: data.goalId }),
      ...(data.goalType === undefined ? {} : { goalType: data.goalType }),
      provenance: data.provenance,
      // ⛔ 「전반부에서 왔다」를 값으로 — 후반부 걸음과 «섞이지» 않게.
      phase: 'front',
      graphTemplatesSource: GRAPH_TEMPLATES_SOURCE,
    });
  } catch { /* 관측은 fail-soft — 저작을 죽이지 않는다 */ }
  // ⛔ 방문 계수는 pipeline-node-entry 와 «별도의 try» 에서 — 어느 하나가 실패해도 다른 관측이 산다.
  if (data.runId === undefined) return; // runId 없는 진입은 판독을 내지 않는다 — 다른 런과 섞인 수를 지어내지 않는다.
  try {
    const template = frontObservationTemplate(data.goalType === 'implement' ? 'implement' : undefined);
    const reading = frontNodeVisitCount(template, node, data.runId);
    if (reading === null) return; // 선언에 없는 노드 — 예산을 지어내지 않는다.
    debug.log('self-implement', 'graph-visit-budget', {
      ...graphIdentityOf(template),
      ...reading,
      node,
      runId: data.runId,
      round: data.round ?? 0,
      // ⛔ 「전반부에서 왔다」를 값으로 — 후반부 판독과 «섞이지» 않게.
      phase: 'front',
      graphTemplatesSource: GRAPH_TEMPLATES_SOURCE,
    });
  } catch { /* 판독 실패는 fail-soft — 예산은 관측이고 저작을 막지 않는다 */ }
}

/** GRAPH-AUTHOR-FAIL-EDGE — author 결과가 고르는 «앞단 결과 노드». ⛔ 런타임 값 — YAML 이 더한 노드를 시험이 센다. */
export const AUTHOR_OUTCOME_NODE_IDS = ['re-ground', 'needs-human'] as const;

/** author 노드의 결과 라벨 — implement-loop.yaml `from: author · on: outcome` 의 map 키와 «같은» 닫힌 집합. */
export const AUTHOR_EXIT_OUTCOMES = ['ok', 're-authored', 'not-grounded', 'fail'] as const;
export type AuthorExitOutcome = typeof AUTHOR_EXIT_OUTCOMES[number];

export type FrontNodeExit =
  | { readonly node: 'author'; readonly outcome: AuthorExitOutcome }
  | { readonly node: 're-ground'; readonly outcome: 'retry' };

export interface FrontNodeExitData {
  /** 1 = 첫 저작 · 2 = 자동 재저작(re-ground 를 한 번 지난 뒤). */
  readonly attempt: number;
  /** 코드가 «실제로» 간 다음 노드 — 그래프 답과 다르면 graph-edge-taken 이 honored:false 로 남긴다. 없으면 그래프 답. */
  readonly taken?: string;
  readonly reason?: string;
  readonly runId?: string;
  readonly goalId?: string;
  readonly goalType?: string;
  readonly goalFile?: string;
  /** 근거 카드 — needs-human 으로 갈 때 사람이 «무엇 때문에»를 다시 캐지 않게 막힘을 그대로 싣는다. */
  readonly blockers?: readonly { readonly kind: string; readonly name: string; readonly detail?: string }[];
}

const EVIDENCE_DETAIL_CHARS = 400;

/** 그래프가 고른 다음 노드에 «방문 예산»을 겹친다 — re-ground(max_visits 1)를 이미 지났으면 같은 결과의
 *  두 번째는 re-ground 가 아니라 author 의 `fail` 출구(needs-human)로 간다. ⛔ 노드 이름·예산은 선언에서 읽는다. */
function withVisitBudget(route: JourneyRoute, exit: FrontNodeExit, attempt: number): { readonly to: string | null; readonly budgetReason?: string } {
  // ⛔ 예산을 겹치는 대상은 re-ground 뿐이다 — attempt-1 은 «re-ground 를 지난 횟수»이지 다른 노드의 방문 수가 아니다.
  if (exit.node !== 'author' || route.to !== 're-ground') return { to: route.to };
  const target = journeySpec({}).spec?.nodes.find((node) => node.nodeId === route.to);
  const priorVisits = Math.max(0, attempt - 1);
  if (target === undefined || priorVisits < target.maxVisits) return { to: route.to };
  const exhausted = readJourneyEdge('author', 'fail');
  return { to: exhausted.to, budgetReason: `${route.to}-visit-budget-exhausted (max_visits ${target.maxVisits})` };
}

/** ⭐ GRAPH-AUTHOR-FAIL-EDGE ① — 앞 노드의 «나감»을 결과와 함께 남긴다(진입만 있던 자리).
 *  호출부(실행 경로): src/self-dev/ask-launch-flow.ts — 저작 끝(author ok · not-grounded · re-authored) ·
 *    저작기 throw(author fail) · 자동 재저작 시작(re-ground retry).
 *  🔎 관측: `self-implement` / `front-node-exit` ⊕ 같은 자리의 `graph-edge-taken`(from author|re-ground).
 *  ⛔ 관측이지 제어가 아니다 — 다음 걸음은 여전히 코드가 정하고, 그래프 답과 다르면 honored:false 로 남는다.
 *  ⛔ fail-soft — 관측 실패가 저작을 죽이지 않는다. */
export function observeFrontNodeExit(exit: FrontNodeExit, data: FrontNodeExitData): JourneyRoute | null {
  let recorded: JourneyRoute | null = null;
  try {
    const route = readJourneyEdge(exit.node, exit.outcome);
    const budget = withVisitBudget(route, exit, data.attempt);
    const graphRoute: JourneyRoute = { ...route, to: budget.to };
    const taken = data.taken ?? budget.to ?? exit.outcome;
    const reason = [budget.budgetReason, data.reason].filter((part): part is string => part !== undefined).join(' · ');
    recordJourneyEdge(graphRoute, taken, reason.length > 0 ? reason : undefined);
    recorded = graphRoute;
    const payload = {
      graphId: 'self-implement',
      node: exit.node,
      outcome: exit.outcome,
      attempt: data.attempt,
      to: budget.to,
      taken,
      honored: budget.to === null || budget.to === taken,
      ...(reason.length > 0 ? { reason } : {}),
      ...(data.runId === undefined ? {} : { runId: data.runId }),
      ...(data.goalId === undefined ? {} : { goalId: data.goalId }),
      ...(data.goalType === undefined ? {} : { goalType: data.goalType }),
      ...(data.goalFile === undefined ? {} : { goalFile: data.goalFile }),
      ...(data.blockers === undefined || data.blockers.length === 0 ? {} : {
        evidenceCard: data.blockers.map((blocker) => ({
          kind: blocker.kind, name: blocker.name,
          ...(blocker.detail === undefined ? {} : { detail: blocker.detail.slice(0, EVIDENCE_DETAIL_CHARS) }),
        })),
      }),
      phase: 'front',
      graphTemplatesSource: GRAPH_TEMPLATES_SOURCE,
      ...journeyJoinFields(),
    };
    try { debug.log('self-implement', 'front-node-exit', payload); }
    catch { /* debug failure cannot change authoring */ }
    // Pod 의 logs.db 는 Job 과 사라진다 — 원장에도 남겨 호스트가 NOT-GROUNDED 의 길을 사후에 읽게 한다.
    if (data.runId !== undefined) {
      try { appendRunLedgerEntry({ timestamp: new Date().toISOString(), runId: data.runId, event: 'front-node-exit', data: payload }, runLedgerDir()); }
      catch { /* ledger failure cannot change authoring */ }
    }
  } catch { /* 관측은 fail-soft — 저작을 죽이지 않는다 */ }
  return recorded;
}
