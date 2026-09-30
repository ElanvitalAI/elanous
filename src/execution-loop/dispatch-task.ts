import { createHash, randomUUID } from 'node:crypto';
import { debug } from '../debug/log.js';
import { emitDecision, type DecisionEvent } from '../live/detail-switch.js';
import { CardStore, redactSecrets } from '../task-cards/card-store.js';
import type { DevPipelineSpec } from '../self-dev/dev-pipeline.js';
import {
  budgetGate, placementGate, relationGate, memoryGate,
  type BudgetGateDeps, type GateResult, type MemoryDecision, type MemoryGateDeps, type PlacementGateDeps,
  type PlacementGateInput, type RelationGateDeps,
} from './gates.js';
import { summarizeGateDecision, type GateName } from './gate-decision-summary.js';

export interface DispatchTaskInput {
  goalId: string;
  title: string;
  goalText: string;
  targetPaths: readonly string[];
  spec: DevPipelineSpec;
  runKey?: string;
}

export type ObservedGateResult = GateResult<unknown>;
export interface DispatchTaskResult {
  cardId: string;
  decisions: Record<GateName, ObservedGateResult>;
  mode: 'observe';
}

export interface DispatchTaskDeps {
  createStore?: () => CardStore;
  budgetGate?: typeof budgetGate;
  placementGate?: typeof placementGate;
  relationGate?: typeof relationGate;
  memoryGate?: (card: Parameters<typeof memoryGate>[0], deps?: MemoryGateDeps) => Promise<GateResult<MemoryDecision | string>>;
  budgetDeps?: BudgetGateDeps;
  placementDeps?: PlacementGateDeps;
  relationDeps?: RelationGateDeps;
  memoryDeps?: MemoryGateDeps;
  emitDecision?: (event: DecisionEvent) => unknown;
  /** Called as soon as the card exists, before any gate can reach its deadline. */
  onCardCreated?: (cardId: string) => void;
  log?: (gate: GateName, data: { cardId: string; verdict: string; ms: number }) => void;
  /** Cancels pending observations and settles dispatch before any further card writes. */
  signal?: AbortSignal;
  /** Optional shorter deadline for tests; never extends the five-second cap. */
  timeoutMs?: number;
}

const UNAVAILABLE = '측정 불가';

function verdictFor(gate: GateName, result: ObservedGateResult): string {
  if (result.decision === UNAVAILABLE) return UNAVAILABLE;
  const decision = result.decision as Record<string, unknown> | null;
  const key = gate === 'budget' ? 'action' : gate === 'placement' ? 'substrate' : 'action';
  return typeof decision?.[key] === 'string' ? String(decision[key]) : 'unknown';
}

/** A goal id is an identifier, not a secret: secret-shape redaction turned every long hex id
 *  (e.g. `request-<sha256>`) into the same `<redacted>` and merged all goals into one card.
 *  Keep ids that use the identifier alphabet; anything else becomes a stable hash. */
export function cardGoalId(goalId: string): string {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(goalId) ? goalId : `goal-${createHash('sha256').update(goalId).digest('hex').slice(0, 32)}`;
}

/** Observation only: neither the decision nor a failure can select the launch, substrate or model. */
export async function dispatchTask(input: DispatchTaskInput, deps: DispatchTaskDeps = {}): Promise<DispatchTaskResult> {
  const timeoutMs = Math.min(5_000, Math.max(0, deps.timeoutMs ?? 5_000));
  const deadline = Date.now() + timeoutMs;
  if (deps.signal?.aborted) throw new Error('dispatch observation aborted');
  const store = (deps.createStore ?? (() => new CardStore()))();
  try {
    if (deps.signal?.aborted) throw new Error('dispatch observation aborted');
    const card = store.createCard({ goalId: cardGoalId(input.goalId), title: redactSecrets(input.title) });
    if (card.status !== 'open') throw new Error(`Card is closed: ${card.id}`);
    try { deps.onCardCreated?.(card.id); } catch { /* Ledger observation cannot stop dispatch. */ }
    const runKey = redactSecrets(input.runKey ?? randomUUID());
    const relationDeps: RelationGateDeps = deps.relationDeps ?? {
      openCards: () => store.listCards({ open: true }),
      priorTermination: () => undefined,
      // No active-run source is wired here yet: keep that one field unknown and still measure the rest.
      activeRuns: () => 'unknown',
    };
    const placement: PlacementGateInput = { goal: input.goalText };
    const gates: Record<GateName, () => Promise<ObservedGateResult> | ObservedGateResult> = {
      budget: () => (deps.budgetGate ?? budgetGate)(deps.budgetDeps),
      placement: () => (deps.placementGate ?? placementGate)(placement, deps.placementDeps),
      relation: () => (deps.relationGate ?? relationGate)(card, input.targetPaths, relationDeps),
      memory: () => (deps.memoryGate ?? memoryGate)(card, deps.memoryDeps),
    };
    const results = await Promise.all((Object.keys(gates) as GateName[]).map(async (gate) => {
      const started = Date.now();
      const cap = Math.max(0, deadline - started);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      let result: ObservedGateResult;
      try {
        result = await Promise.race([
          Promise.resolve().then(() => {
            if (deps.signal?.aborted) throw new Error('dispatch observation aborted');
            return gates[gate]();
          }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), cap); }),
          new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error('dispatch observation aborted'));
            deps.signal?.addEventListener('abort', onAbort, { once: true });
            if (deps.signal?.aborted) onAbort();
          }),
        ]);
      } catch (error) {
        result = { decision: UNAVAILABLE, explanation: `${UNAVAILABLE}: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) deps.signal?.removeEventListener('abort', onAbort);
      }
      if (deps.signal?.aborted) return [gate, result] as const;
      const ms = Date.now() - started;
      const verdict = verdictFor(gate, result);
      try { (deps.log ?? ((name, data) => debug.log('execution-loop.gate', name, data)))(gate, { cardId: card.id, verdict, ms }); }
      catch { /* Observability must not change the launch. */ }
      try {
        (deps.emitDecision ?? emitDecision)({
          kind: gate === 'placement' ? 'ROUTE' : 'PLAN', what: `execution-loop ${gate} gate`,
          reason: summarizeGateDecision(gate, result), purpose: 'observe dispatch only', target: card.id,
          ...(input.spec.runId ? { runId: input.spec.runId } : {}), phase: 'dispatch',
        });
      } catch { /* Live-detail logging is optional. */ }
      return [gate, result] as const;
    }));
    if (deps.signal?.aborted) throw new Error('dispatch observation aborted');
    const decisions = Object.fromEntries(results) as Record<GateName, ObservedGateResult>;
    const content = (value: unknown) => redactSecrets(JSON.stringify(value));
    store.appendSection(card.id, { key: `gates:${runKey}`, owner: 'execution-loop', content: content({ budget: decisions.budget, placement: decisions.placement }) });
    store.appendSection(card.id, { key: `relations:${runKey}`, owner: 'execution-loop', content: content(decisions.relation) });
    store.appendSection(card.id, { key: `memory:${runKey}`, owner: 'execution-loop', content: content(decisions.memory) });
    return { cardId: card.id, decisions, mode: 'observe' };
  } finally {
    store.close();
  }
}
