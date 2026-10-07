import type { TaskCard } from '../task-cards/card-store.js';
import { decideBudget, readBudgetInputsLive, type BudgetDecision, type BudgetInputs } from '../self-implement/budget-gate.js';
import { resolveHarnessSubstrate, type ResolvedHarnessSubstrate } from '../harness/harness-substrate-default.js';
import { podMemoryLimitFor } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { recallMemoryContext } from '../agent-substrate/execution/memory-context.js';
import { CONTEXT_CARD_SCREEN_CHARS } from '../context-card/index.js';

export interface GateResult<T> {
  decision: T;
  explanation: string;
}

export interface BudgetGateDeps {
  readInputs: () => Promise<BudgetInputs>;
  decide: (inputs: BudgetInputs) => BudgetDecision;
}

/** Observe the existing quota decision; callers record it, not apply it to the launch. */
export async function budgetGate(
  deps: BudgetGateDeps = { readInputs: readBudgetInputsLive, decide: decideBudget },
): Promise<GateResult<BudgetDecision>> {
  const decision = deps.decide(await deps.readInputs());
  return { decision, explanation: decision.reasons.join(' · ') || `budget: ${decision.action}` };
}

export interface PlacementGateInput {
  goal: string;
  /** A local-only capability or file is an observation, not a reason to probe a remote pool. */
  needsBrowser?: boolean;
  needsVideo?: boolean;
  needsAppSigning?: boolean;
  localFiles?: readonly string[];
  flag?: { substrate?: 'pod' | 'local'; podPool?: string };
}

export interface PlacementGateDeps {
  resolveSubstrate: (input: { flag?: { substrate?: 'pod' | 'local'; podPool?: string } }) => ResolvedHarnessSubstrate;
  memoryLimit: (goal: string) => { limit: string; tier: string; source: string };
}

export type PlacementDecision = (ResolvedHarnessSubstrate | {
  substrate: 'unknown';
  pool: null;
  source: 'unknown';
}) & {
  /** Reachability is deliberately not probed by this observational gate. */
  poolReachability: 'unknown' | 'not-applicable';
  memory?: { limit: string; tier: string; source: string };
  localReasons: string[];
  /** Omitted observations must not be silently treated as negative evidence. */
  unknownInputs: string[];
};

const defaultPlacementDeps: PlacementGateDeps = {
  resolveSubstrate: ({ flag }) => resolveHarnessSubstrate({ flag, env: process.env, currentContext: () => undefined }),
  memoryLimit: (goal) => podMemoryLimitFor(goal, process.env),
};

export function placementGate(
  input: PlacementGateInput,
  deps: PlacementGateDeps = defaultPlacementDeps,
): GateResult<PlacementDecision> {
  const unknownInputs = [
    ...(input.needsBrowser === undefined ? ['needsBrowser'] : []),
    ...(input.needsVideo === undefined ? ['needsVideo'] : []),
    ...(input.needsAppSigning === undefined ? ['needsAppSigning'] : []),
    ...(input.localFiles === undefined ? ['localFiles'] : []),
    ...(input.flag?.substrate === undefined ? ['substrate'] : []),
  ];
  const localReasons = [
    ...(input.needsBrowser ? ['browser'] : []),
    ...(input.needsVideo ? ['video'] : []),
    ...(input.needsAppSigning ? ['app signing'] : []),
    ...(input.localFiles?.length ? [`local files: ${input.localFiles.join(', ')}`] : []),
  ];
  // A measured local-only need wins; otherwise unknown needs cannot justify a remote assertion.
  if (!localReasons.length && input.flag?.substrate !== 'local' && unknownInputs.length) {
    return {
      decision: { substrate: 'unknown', pool: null, source: 'unknown', poolReachability: 'unknown', localReasons, unknownInputs },
      explanation: `placement=unknown; unmeasured=${unknownInputs.join(', ')}; pool reachability not checked`,
    };
  }
  const flag = localReasons.length ? { substrate: 'local' as const } : input.flag;
  let resolved: ResolvedHarnessSubstrate;
  try {
    resolved = deps.resolveSubstrate({ flag });
  } catch (error) {
    if (flag?.substrate !== 'pod' || !(error instanceof Error) || !error.message.includes('Pod 풀 또는 현재 컨텍스트에 닿지 못했다')) throw error;
    // No configured pool is not evidence that a remote pool is unreachable.
    resolved = { substrate: 'pod', pool: null, source: 'flag' };
  }
  const poolReachability = resolved.substrate === 'pod' ? 'unknown' : 'not-applicable';
  const memory = resolved.substrate === 'pod' ? deps.memoryLimit(input.goal) : undefined;
  const decision: PlacementDecision = {
    ...resolved, poolReachability, localReasons, unknownInputs,
    ...(memory ? { memory } : {}),
  };
  return {
    decision,
    explanation: (resolved.substrate === 'local'
      ? `local: ${localReasons.join(' · ') || `substrate ${resolved.source}`}`
      : `pod: pool=${resolved.pool ?? 'unknown'}; reachability=unknown (not checked); memory=${memory?.tier ?? 'unknown'} (${memory?.limit ?? 'unknown'})`)
      + (unknownInputs.length ? `; unmeasured=${unknownInputs.join(', ')}` : ''),
  };
}

export interface RelationGateDeps {
  openCards: () => Promise<readonly TaskCard[]> | readonly TaskCard[];
  /** A previous completed run is reported as a fact, never inferred from a matching title. */
  priorTermination: (goalId: string) => Promise<string | undefined> | string | undefined;
  /** 'unknown' = the caller cannot observe running runs; recorded as unknown, never as none. */
  activeRuns: (goalId: string) => Promise<readonly string[] | 'unknown'> | readonly string[] | 'unknown';
  /** Optional preflight overlap observations are kept separate from open-card overlap. */
  preflightOverlaps?: (paths: readonly string[]) => Promise<readonly string[]> | readonly string[];
  dependsOn?: (goalId: string) => Promise<readonly string[]> | readonly string[];
  similarCards?: (card: TaskCard, openCards: readonly TaskCard[]) => Promise<readonly string[]> | readonly string[];
}

export interface RelationDecision {
  overlappingCards: string[];
  preflightOverlaps: string[] | 'unknown';
  dependsOn: string[] | 'unknown';
  similarCards: string[] | 'unknown';
  sameGoalActiveRuns: string[] | 'unknown';
  priorTermination?: string;
  /** Overlaps and similarity are observations, not dispatch locks. */
  action: 'record';
}

export async function relationGate(
  card: TaskCard,
  targetPaths: readonly string[],
  deps: RelationGateDeps,
): Promise<GateResult<RelationDecision>> {
  const [cards, priorTermination, sameGoalActiveRuns] = await Promise.all([
    deps.openCards(), deps.priorTermination(card.goalId), deps.activeRuns(card.goalId),
  ]);
  const [preflightOverlaps, dependsOn, similarCards] = await Promise.all([
    deps.preflightOverlaps?.(targetPaths) ?? 'unknown',
    deps.dependsOn?.(card.goalId) ?? 'unknown',
    deps.similarCards?.(card, cards) ?? 'unknown',
  ]);
  const target = new Set(targetPaths);
  const overlappingCards = cards
    .filter((other) => other.id !== card.id && other.status === 'open' && other.sections.some((section) => {
      if (!section.key.startsWith('workspace')) return false;
      try {
        const workspace = JSON.parse(section.content) as { targetPaths?: unknown; paths?: unknown };
        const paths = workspace.targetPaths ?? workspace.paths;
        return Array.isArray(paths) && paths.some((path) => typeof path === 'string' && target.has(path));
      } catch { return false; }
    }))
    .map((other) => other.id);
  const observed = (value: readonly string[] | string): string =>
    typeof value === 'string' ? value : value.join(',') || 'none';
  const decision: RelationDecision = {
    action: 'record', overlappingCards,
    preflightOverlaps: preflightOverlaps === 'unknown' ? 'unknown' : [...preflightOverlaps],
    dependsOn: dependsOn === 'unknown' ? 'unknown' : [...dependsOn],
    similarCards: similarCards === 'unknown' ? 'unknown' : [...similarCards],
    sameGoalActiveRuns: sameGoalActiveRuns === 'unknown' ? 'unknown' : [...sameGoalActiveRuns],
    ...(priorTermination === undefined ? {} : { priorTermination }),
  };
  return {
    decision,
    explanation: `overlap=${observed(overlappingCards)}; preflight=${observed(preflightOverlaps)}; dependsOn=${observed(dependsOn)}; similar=${observed(similarCards)}; active=${observed(sameGoalActiveRuns)}; prior=${priorTermination ?? 'unknown'}; overlaps do not block launch`,
  };
}

export interface MemoryGateDeps {
  recall: (query: string) => Promise<string>;
  priorAbandonment: (goalId: string) => Promise<string | undefined> | string | undefined;
  priorMustFix?: (goalId: string) => readonly string[];
}

export interface MemoryDecision {
  context: string;
  priorAbandonment?: string;
  /** The existing recall API returns formatted context, not stable fragment IDs. */
  fragmentIds: string[];
  action: 'record';
}

export async function memoryGate(
  card: Pick<TaskCard, 'goalId' | 'title'>,
  deps: MemoryGateDeps = { recall: recallMemoryContext, priorAbandonment: () => undefined },
): Promise<GateResult<MemoryDecision>> {
  const [recall, priorAbandonment] = await Promise.all([
    deps.recall(card.title), deps.priorAbandonment(card.goalId),
  ]);
  // must-fix 와 recall 은 서로 독립이다 — recall 이 비어도 앞선 must-fix 는 맥락에 남는다.
  const mustFix = deps.priorMustFix?.(card.goalId) ?? [];
  const mustFixBlock = mustFix.length ? `앞선 must-fix:\n${mustFix.map((item) => `- ${item}`).join('\n')}` : '';
  const combined = [mustFixBlock, recall].filter(Boolean).join('\n');
  const codePoints = [...combined];
  const truncated = codePoints.length > CONTEXT_CARD_SCREEN_CHARS;
  const context = truncated ? codePoints.slice(0, CONTEXT_CARD_SCREEN_CHARS).join('') : combined;
  const decision: MemoryDecision = {
    action: 'record', context, fragmentIds: [],
    ...(priorAbandonment === undefined ? {} : { priorAbandonment }),
  };
  return {
    decision,
    explanation: `memory=${recall ? 'recalled' : 'none or unavailable'}; prior abandonment=${priorAbandonment ?? 'unknown'}; fragment IDs unavailable from recall API${truncated ? `; truncated; chars=${[...context].length}/${CONTEXT_CARD_SCREEN_CHARS}` : ''}`,
  };
}
