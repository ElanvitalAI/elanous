import { redactSecrets } from '../task-cards/card-store.js';
import type { BudgetDecision } from '../self-implement/budget-gate.js';
import type { GateResult, MemoryDecision, PlacementDecision, RelationDecision } from './gates.js';

export type GateName = 'budget' | 'placement' | 'relation' | 'memory';

/** Only decision metadata belongs in the live log; full results remain in the card. */
export function summarizeGateDecision(gate: GateName, result: GateResult<unknown>): string {
  const { decision } = result;
  let summary: string;
  if (typeof decision === 'string') {
    summary = gate === 'memory' ? 'unavailable' : `unavailable · explanation=${redactSecrets(result.explanation).slice(0, 80)}`;
  } else if (gate === 'budget') {
    const budget = decision as BudgetDecision;
    summary = `action=${budget.action}${budget.provider ? ` · provider=${budget.provider}` : ''} · reason=${redactSecrets(budget.reasons[0] ?? '').slice(0, 80)}`;
  } else if (gate === 'placement') {
    const placement = decision as PlacementDecision;
    summary = `substrate=${placement.substrate} · pool=${placement.pool ?? 'none'}${placement.memory ? ` · memory=${placement.memory.limit}` : ''} · unknown=${placement.unknownInputs.join(',')}`;
  } else if (gate === 'relation') {
    const relation = decision as RelationDecision;
    const unknown = (['preflightOverlaps', 'dependsOn', 'similarCards', 'sameGoalActiveRuns'] as const)
      .filter((key) => relation[key] === 'unknown');
    summary = `overlap=${relation.overlappingCards.length} · unknown=${unknown.join(',')}`;
  } else {
    const memory = decision as MemoryDecision;
    summary = `context=${memory.context ? 'recalled' : 'none'} · fragments=${memory.fragmentIds.length}`;
  }
  return redactSecrets(summary).slice(0, 250);
}
