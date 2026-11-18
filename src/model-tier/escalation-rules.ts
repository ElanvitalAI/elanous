// HARNESS-ADVISOR-CHECKPOINTS — the «escalate» rule of the model orchestration core (ASK-RIFLE-NOT-TANK-HARNESS-1117
// «한 몸 원칙»). Pure judgment only: given the loop's escalation state and one event, decide whether THIS moment
// goes up to the strong grade. No model call, no ledger, no I/O — the core (HARNESS-DIFFICULTY-ROUTER) turns a
// decision into {grade, model, account, reason} and records it in the one ledger. An escalation covers one call
// with a short answer budget; the next call is back to the core's normal choice (immediate de-escalation).

export type EscalationMoment = 'before-plan' | 'same-error-twice' | 'before-complete';

// 출처: ASK-RIFLE-NOT-TANK-HARNESS-1117 §2 «짧은 조언(≤400 토큰)».
export const ESCALATION_MAX_OUTPUT_TOKENS = 400;
/** A loop that keeps hitting new repeated errors escalates at most this many times for them. */
export const MAX_SAME_ERROR_ESCALATIONS = 2;

export interface EscalationState {
  readonly planned: boolean;
  readonly completionReviewed: boolean;
  /** error signature → times seen in this loop */
  readonly errorCounts: Readonly<Record<string, number>>;
  readonly sameErrorEscalations: number;
}

export type EscalationEvent =
  | { readonly kind: 'turn-start'; readonly iteration: number }
  | { readonly kind: 'tool-result'; readonly tool: string; readonly result: unknown }
  | { readonly kind: 'completion-claim'; readonly iteration: number; readonly maxIterations: number; readonly aborted?: boolean };

export type EscalationDecision =
  | { readonly escalate: false }
  | {
      readonly escalate: true;
      readonly moment: EscalationMoment;
      /** Answer budget for the one escalated call. */
      readonly maxOutputTokens: number;
      /** Ledger reason; for same-error-twice it carries the folded error signature. */
      readonly reason: string;
    };

export function initialEscalationState(): EscalationState {
  return { planned: false, completionReviewed: false, errorCounts: {}, sameErrorEscalations: 0 };
}

const STAY: EscalationDecision = { escalate: false };

const up = (moment: EscalationMoment, reason: string): EscalationDecision =>
  ({ escalate: true, moment, maxOutputTokens: ESCALATION_MAX_OUTPUT_TOKENS, reason });

/**
 * The three moments, each once-bounded:
 * - before-plan: the first turn of a loop, once.
 * - same-error-twice: a failure whose signature is seen for the 2nd time; capped per loop.
 * - before-complete: a completion claim, once per loop, and only while one more round is left —
 *   a «revise» verdict on the last round would cost the run its completion. Never on a cancelled loop.
 */
export function judgeEscalation(state: EscalationState, event: EscalationEvent): { state: EscalationState; decision: EscalationDecision } {
  switch (event.kind) {
    case 'turn-start': {
      if (state.planned || event.iteration !== 1) return { state, decision: STAY };
      return { state: { ...state, planned: true }, decision: up('before-plan', 'before-plan') };
    }
    case 'tool-result': {
      const signature = toolErrorSignature(event.tool, event.result);
      if (signature === undefined) return { state, decision: STAY };
      const count = (state.errorCounts[signature] ?? 0) + 1;
      const counted: EscalationState = { ...state, errorCounts: { ...state.errorCounts, [signature]: count } };
      if (count !== 2 || state.sameErrorEscalations >= MAX_SAME_ERROR_ESCALATIONS) return { state: counted, decision: STAY };
      return {
        state: { ...counted, sameErrorEscalations: state.sameErrorEscalations + 1 },
        decision: up('same-error-twice', `same-error-twice:${signature}`),
      };
    }
    case 'completion-claim': {
      if (state.completionReviewed || event.aborted || event.iteration >= event.maxIterations) return { state, decision: STAY };
      return { state: { ...state, completionReviewed: true }, decision: up('before-complete', 'before-complete') };
    }
  }
}

/**
 * A failed tool result's identity: tool name + its error text with numbers, hex ids and whitespace folded, so the
 * «same error» survives changing line numbers, pids and timestamps. undefined = the result is not a failure.
 */
export function toolErrorSignature(name: string, result: unknown): string | undefined {
  let text: string | undefined;
  if (typeof result === 'string') {
    if (/^(?:error|\[error\]|TOOL CALL REJECTED)/i.test(result.trim())) text = result;
  } else if (result && typeof result === 'object') {
    const row = result as Record<string, unknown>;
    if (typeof row.error === 'string' && row.error.trim()) text = row.error;
    else if (row.ok === false || row.isError === true) text = String(row.message ?? row.stderr ?? row.output ?? 'failed');
    else if (typeof row.exitCode === 'number' && row.exitCode !== 0) {
      text = `exit ${row.exitCode} ${String(row.stderr || row.stdout || '')}`;
    }
  }
  if (text === undefined) return undefined;
  const folded = text.replace(/0x[0-9a-f]+|[0-9a-f]{8,}|\d+/gi, '#').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${name}:${folded}`;
}

/** Strong verdict on a completion claim. Only a first line `VERDICT: revise` asks for another round — fail-open. */
export function parseCompletionVerdict(text: string): 'accept' | 'revise' {
  const first = text.trim().split('\n', 1)[0] ?? '';
  return /^VERDICT:\s*revise\b/i.test(first.trim()) ? 'revise' : 'accept';
}
