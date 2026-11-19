import { loadRunLedger } from '../self-implement/run-ledger.js';
import { updateTaskCard } from './task-card-state.js';

/** Reconcile only the card still bound to this failed dispatch. */
export function reconcileLateLaunchFailure(path: string, cardId: string, runId: string): void {
  const failure = (loadRunLedger(runId) ?? []).find((entry) =>
    entry.event === 'launch-failed-supervisor');
  if (!failure) return;
  const detail = typeof failure.data?.cause === 'string' ? failure.data.cause : 'supervisor launch failed';
  updateTaskCard(path, cardId, (card) => {
    if (!card || card.status !== 'launched' || card.runId !== runId) return undefined;
    return { ...card, status: 'launch-failed', history: [...card.history,
      { at: new Date().toISOString(), event: 'launch-failed', detail, runId }] };
  });
}
