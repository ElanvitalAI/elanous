// TURN-GIVES-UP-NO-WORK (CEO field report 11-28 21:5x) — a delegation (Agent/Task) that did not start must not end the work.
// Field: «메모리 조사해 계약 문서로 저장» in a fresh folder — the research turn refused the Agent call with
// `{ error: 'Research tool budget reached. Answer with the evidence collected so far.' }` (count 0 of 20), the row
// painted ✗ and the model answered «확인하지 못해 작성하지 못했습니다». The refusal told it to stop.
//
// Three faces:
//   관측 = `core.turn delegation-failed {tool, reason}` on every failed delegation (thrown, refused or success:false).
//   판단 = structural only: the tool name is a delegation tool and the dispatch threw / said success:false / carried a
//          non-empty `error` field. No reply text is read.
//   수복 = the tool result the model reads is one structured shape — status `failed`, `fallback: 'inline'` and an
//          instruction to do the same work now, in this turn, with its own tools. The turn goes on; nothing is asked.

/** The model-facing delegation tools (the subagent spawn and its legacy alias). */
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task']);

export const DELEGATION_INLINE_INSTRUCTION = 'The delegated agent did not start, so none of this work was delegated. '
  + 'Do the same work yourself now, in this turn, with your own tools (search, read, and write any file the request asked for). '
  + 'Do not end the turn by saying the work could not be done.';

/** Why a delegation failed — a code, never prose from the model. */
export type DelegationFailureReason =
  | 'spawn-threw'
  | 'spawn-refused'
  | 'research-subagent-gate';

export interface DelegationFailedResult {
  success: false;
  status: 'failed';
  delegation: 'failed';
  fallback: 'inline';
  reason: DelegationFailureReason;
  error: string;
  instruction: string;
}

export function isDelegationTool(name: string): boolean {
  return DELEGATION_TOOL_NAMES.has(name);
}

export function delegationFailedResult(reason: DelegationFailureReason, error: string): DelegationFailedResult {
  return {
    success: false,
    status: 'failed',
    delegation: 'failed',
    fallback: 'inline',
    reason,
    error: error.trim() || 'delegation failed',
    instruction: DELEGATION_INLINE_INSTRUCTION,
  };
}

/** A delegation dispatch result that says it did not run: `success:false` / `ok:false` / `isError:true` / non-empty `error`. */
export function delegationResultFailed(result: unknown): boolean {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
  const r = result as Record<string, unknown>;
  if (r.success === false || r.ok === false || r.isError === true) return true;
  return typeof r.error === 'string' && r.error.trim() !== '';
}

/** The message of a failed delegation result (its `error` field, else a fixed code line). */
export function delegationFailureMessage(result: unknown): string {
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    const error = (result as Record<string, unknown>).error;
    if (typeof error === 'string' && error.trim()) return error.trim();
  }
  return 'delegation refused';
}
