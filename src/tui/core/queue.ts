import {
  createTurnTypeaheadState,
  dequeueTurnTypeaheadHandoff,
  drainTurnTypeaheadOnce,
  restoreTurnTypeaheadSubmission,
  type TurnTypeaheadState,
} from '../../chat/turn-typeahead.js';

export type NextTuiQueueSettle =
  | { kind: 'none' }
  | { kind: 'wake' }
  | { kind: 'restore'; text: string; count: number };

export type NextTuiQueueDequeue =
  | { kind: 'none' }
  | { kind: 'submit'; text: string; remaining: number };

/** Owns submissions made while a Next TUI turn is running. The input layer owns key interpretation. */
export function createNextTuiQueue() {
  let state: TurnTypeaheadState = createTurnTypeaheadState();
  let interrupted = false;
  return {
    get count(): number { return state.queuedSubmissions.length; },
    get pendingTexts(): readonly string[] { return state.queuedSubmissions; },
    get interrupted(): boolean { return interrupted; },
    enqueue(text: string): number {
      state = restoreTurnTypeaheadSubmission(state, text);
      return state.queuedSubmissions.length;
    },
    recall(draft: string): { text: string; count: number } | null {
      const count = state.queuedSubmissions.length;
      if (count === 0) return null;
      const text = [...state.queuedSubmissions, ...(draft ? [draft] : [])].join('\n');
      state = createTurnTypeaheadState();
      return { text, count };
    },
    markInterrupted(): void { interrupted = true; },
    settle(draft: string): NextTuiQueueSettle {
      const count = state.queuedSubmissions.length;
      if (interrupted) {
        interrupted = false;
        if (count === 0) return { kind: 'none' };
        const drained = drainTurnTypeaheadOnce(state, null, { interrupted: true });
        state = drained.state;
        const restored = drained.nextInitial ?? '';
        return { kind: 'restore', text: draft ? `${restored}\n${draft}` : restored, count };
      }
      return count > 0 ? { kind: 'wake' } : { kind: 'none' };
    },
    dequeue(): NextTuiQueueDequeue {
      const next = dequeueTurnTypeaheadHandoff(state);
      if (next.handoff.kind !== 'submit') return { kind: 'none' };
      state = next.state;
      return { kind: 'submit', text: next.handoff.text, remaining: state.queuedSubmissions.length };
    },
  };
}

/** Status-line count of what waits for the running turn — empty when nothing waits. */
export function nextTuiQueueSuffix(count: number): string {
  return count > 0 ? ` · 대기 ${count}` : '';
}

/** A model reply may be interrupted only after a fresh execution-side snapshot has no active tools. */
export function nextTuiPushNowDecision(activeToolNames: readonly string[]): 'interrupt' | 'deferred' {
  return activeToolNames.length === 0 ? 'interrupt' : 'deferred';
}
