import type { SelfDevJobResult, SupervisorStopReason, SupervisorNext } from './run-types.js';
export type { SupervisorNext } from './run-types.js';
export type SupervisorVerdictEdge = { readonly meaning: string; readonly next: SupervisorNext };

// 목표 규칙: 사람 관문은 결제·공개·자격·비가역 결정에만. 지금 max-rounds·provider-exhausted·step-timeout 이 human-gate 인 것은
// 그 규칙의 예외로 «그대로» 둔 값이다(시험에 고정 — 바꾸면 보인다).
export const SUPERVISOR_VERDICT_EDGES = {
  converged: { meaning: 'run converged', next: 'harvest' },
  'human-stopped': { meaning: 'human stopped the run', next: 'human-gate' },
  'parent-signals-red': { meaning: 'parent decision signals are red', next: 'human-gate' },
  'needs-human': { meaning: 'unresolved human or harvest decision', next: 'human-gate' },
  'no-actionable-work': { meaning: 'no actionable work remains', next: 'self-review' },
  'harvestable-awaiting-human': { meaning: 'implementation awaits harvest', next: 'harvest' },
  'handed-off-to-salvage': { meaning: 'salvage already owns the work', next: 'harvest' },
  'max-rounds': { meaning: 'round budget exhausted', next: 'human-gate' },
  'no-progress': { meaning: 'run stalled', next: 'scope-decompose' },
  'provider-exhausted': { meaning: 'provider quota exhausted', next: 'human-gate' },
  'step-timeout': { meaning: 'step budget exhausted', next: 'human-gate' },
  'decomposable-no-progress': { meaning: 'stalled with a decomposition proposal', next: 'scope-decompose' },
  'review-unobserved': { meaning: 'review was not observed', next: 'self-review' },
  'deliverable-unobserved': { meaning: 'deliverable was not observed', next: 'self-review' },
  'deliverable-merged': { meaning: 'deliverable is merged', next: 'harvest' },
} as const satisfies Record<SupervisorStopReason, SupervisorVerdictEdge>;

const HUMAN_GATE_MERGE_REASONS: ReadonlySet<string> = new Set(['decision-signal-red', 'signal-incomplete', 'parent-unlanded', 'human-gate']);

/** Unknown stop vocabularies are proposals, never silently treated as approved edges. */
export function routeSupervisorVerdict(
  reason: string,
  results: readonly Partial<Pick<SelfDevJobResult, 'status' | 'stage' | 'merged' | 'prNumber' | 'prUrl' | 'blockReason' | 'mergeReason'>>[] = [],
): SupervisorVerdictEdge {
  const edge = Object.hasOwn(SUPERVISOR_VERDICT_EDGES, reason)
    ? SUPERVISOR_VERDICT_EDGES[reason as SupervisorStopReason]
    : undefined;
  if (!edge) return { meaning: 'unregistered supervisor stop reason', next: 'proposal' };
  if (reason !== 'needs-human') return edge;
  if (results.some((result) => result.blockReason === 'parent-unlanded')) return edge;
  // A human-gate reason on ANY result in the run keeps the whole run at the human gate.
  if (results.some((result) => HUMAN_GATE_MERGE_REASONS.has(String(result.mergeReason)))) return edge;
  const openPrs = results.filter((result) => result.status === 'done' && result.stage === 'pr-opened'
    && result.merged !== true && (result.prNumber !== undefined || Boolean(result.prUrl)));
  if (openPrs.length === 0) return edge;
  return { meaning: 'open PR ready for harvest', next: 'harvest' };
}
