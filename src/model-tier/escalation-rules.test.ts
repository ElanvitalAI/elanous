// HARNESS-ADVISOR-CHECKPOINTS — the core's «escalate» rule as a pure function (no model call, no ledger).
import { describe, expect, test } from 'bun:test';
import {
  ESCALATION_MAX_OUTPUT_TOKENS,
  MAX_SAME_ERROR_ESCALATIONS,
  initialEscalationState,
  judgeEscalation,
  parseCompletionVerdict,
  toolErrorSignature,
  type EscalationDecision,
  type EscalationEvent,
  type EscalationState,
} from './escalation-rules.js';

function run(events: readonly EscalationEvent[], start: EscalationState = initialEscalationState()) {
  let state = start;
  const decisions: EscalationDecision[] = [];
  for (const event of events) {
    const next = judgeEscalation(state, event);
    state = next.state;
    decisions.push(next.decision);
  }
  return { state, decisions, moments: decisions.map((d) => (d.escalate ? d.moment : null)) };
}

describe('escalation rule — three moments', () => {
  test('before-plan: the first turn escalates once; later turns and a replayed first turn do not', () => {
    const { moments, decisions } = run([
      { kind: 'turn-start', iteration: 1 },
      { kind: 'turn-start', iteration: 2 },
      { kind: 'turn-start', iteration: 1 },
    ]);
    expect(moments).toEqual(['before-plan', null, null]);
    expect(decisions[0]).toEqual({ escalate: true, moment: 'before-plan', maxOutputTokens: ESCALATION_MAX_OUTPUT_TOKENS, reason: 'before-plan' });
  });

  test('a loop that starts past iteration 1 (resumed) gets no plan escalation', () => {
    expect(run([{ kind: 'turn-start', iteration: 3 }]).moments).toEqual([null]);
  });

  test('same-error-twice: first failure is silent, second (line numbers differ) escalates, third is silent', () => {
    const fail = (line: number): EscalationEvent => ({ kind: 'tool-result', tool: 'Bash', result: { exitCode: 1, stderr: `x.ts:${line} boom` } });
    const { moments, decisions } = run([fail(10), fail(42), fail(77)]);
    expect(moments).toEqual([null, 'same-error-twice', null]);
    expect(decisions[1]).toMatchObject({ reason: 'same-error-twice:Bash:exit # x.ts:# boom' });
  });

  test('successes never count; different errors are counted apart', () => {
    const { moments } = run([
      { kind: 'tool-result', tool: 'Bash', result: { exitCode: 0, stdout: 'ok' } },
      { kind: 'tool-result', tool: 'Read', result: { error: 'ENOENT a' } },
      { kind: 'tool-result', tool: 'Bash', result: { error: 'ENOENT a' } },
      { kind: 'tool-result', tool: 'Bash', result: { exitCode: 0, stdout: 'ok' } },
    ]);
    expect(moments).toEqual([null, null, null, null]);
  });

  test(`same-error escalations stop after the cap (${MAX_SAME_ERROR_ESCALATIONS}) even for new repeated errors`, () => {
    const err = (m: string): EscalationEvent => ({ kind: 'tool-result', tool: 'X', result: { error: m } });
    const { moments, state } = run([err('a'), err('a'), err('b'), err('b'), err('c'), err('c')]);
    expect(moments).toEqual([null, 'same-error-twice', null, 'same-error-twice', null, null]);
    expect(state.sameErrorEscalations).toBe(MAX_SAME_ERROR_ESCALATIONS);
    expect(state.errorCounts['X:c']).toBe(2);
  });

  test('before-complete: once per loop, and the second claim is accepted without escalation', () => {
    // 출처: #38171 — a loop budget with rounds left for revise + re-claim; not a product bound.
    const claim = (iteration: number): EscalationEvent => ({ kind: 'completion-claim', iteration, maxIterations: 6 });
    expect(run([claim(2), claim(3)]).moments).toEqual(['before-complete', null]);
  });

  test('failure path: a claim on the last allowed iteration never escalates (revise would cost the completion)', () => {
    // 출처: #38171 — last-iteration boundary case.
    expect(run([{ kind: 'completion-claim', iteration: 4, maxIterations: 4 }]).moments).toEqual([null]);
  });

  test('failure path: a cancelled loop never escalates its completion claim, and the review is not spent', () => {
    // 출처: #38171 — cancelled-claim case; the loop budget is arbitrary.
    const { moments, state } = run([{ kind: 'completion-claim', iteration: 1, maxIterations: 6, aborted: true }]);
    expect(moments).toEqual([null]);
    expect(state.completionReviewed).toBe(false);
  });

  test('every escalation carries the ≤400 answer budget; judging never mutates the input state', () => {
    const start = initialEscalationState();
    const frozen = JSON.stringify(start);
    const { decisions } = run([
      { kind: 'turn-start', iteration: 1 },
      { kind: 'tool-result', tool: 'T', result: 'Error: x' },
      { kind: 'tool-result', tool: 'T', result: 'Error: x' },
      // 출처: #38171 — a claim with rounds left.
      { kind: 'completion-claim', iteration: 2, maxIterations: 6 },
    ], start);
    for (const d of decisions.filter((x) => x.escalate)) {
      expect(d.escalate && d.maxOutputTokens).toBe(ESCALATION_MAX_OUTPUT_TOKENS);
    }
    expect(decisions.filter((d) => d.escalate)).toHaveLength(3);
    expect(JSON.stringify(start)).toBe(frozen);
  });
});

describe('escalation rule — helpers', () => {
  test('toolErrorSignature folds numbers/hex and ignores successes', () => {
    expect(toolErrorSignature('Bash', { exitCode: 0, stdout: 'ok' })).toBeUndefined();
    expect(toolErrorSignature('Read', 'file body')).toBeUndefined();
    expect(toolErrorSignature('Read', { error: 'ENOENT /tmp/a1b2c3d4e5 pid 4411' })).toBe('Read:ENOENT /tmp/# pid #');
    expect(toolErrorSignature('X', { ok: false, message: 'denied' })).toBe('X:denied');
    expect(toolErrorSignature('X', 'TOOL CALL REJECTED: nope')).toBe('X:TOOL CALL REJECTED: nope');
  });

  test('verdict parsing is fail-open: only a first-line «VERDICT: revise» asks for another round', () => {
    expect(parseCompletionVerdict('VERDICT: revise\n- x')).toBe('revise');
    expect(parseCompletionVerdict('  verdict: REVISE')).toBe('revise');
    expect(parseCompletionVerdict('VERDICT: accept')).toBe('accept');
    expect(parseCompletionVerdict('looks fine\nVERDICT: revise')).toBe('accept');
    expect(parseCompletionVerdict('')).toBe('accept');
  });
});
