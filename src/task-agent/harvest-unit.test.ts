import { describe, expect, test } from 'bun:test';
import { runHarvestUnit, type ReviewInvocation } from './harvest-unit.js';

const input = { context: { pr: 123, reviewIntent: 'review the current head', expectedHead: 'a'.repeat(40) } };
function response(overrides: Record<string, unknown> = {}, exitCode: number | null = 0): ReviewInvocation {
  return { exitCode, stdout: JSON.stringify([{ pr: 123, reviewed: true, verdict: 'pass', mustFix: [], model: 'gpt-6-sol', headCommit: 'a'.repeat(40), currentHeadCommit: 'a'.repeat(40), ...overrides }]) };
}

describe('harvest unit', () => {
  test('mf0 on the unchanged expected head exits done', async () => {
    const result = await runHarvestUnit(input, async () => response());
    expect(result.outcome).toBe('done');
    expect(result.result.mustFix).toEqual([]);
    expect(result.evidence.headCommit).toBe('a'.repeat(40));
  });

  test('warn without must-fix findings is an accepted done result', async () => {
    const result = await runHarvestUnit(input, async () => response({ verdict: 'warn', mustFix: [] }));
    expect(result.outcome).toBe('done');
    expect(result.evidence.verdict).toBe('warn');
  });

  test('graph ask supplies the review intent when context omits one', async () => {
    let receivedIntent = '';
    const result = await runHarvestUnit({
      ask: 'Check that the current PR head has no must-fix findings',
      context: { pr: 123, expectedHead: 'a'.repeat(40) },
    }, async args => { receivedIntent = args.intent; return response(); });
    expect(result.outcome).toBe('done');
    expect(receivedIntent).toBe('Check that the current PR head has no must-fix findings');
  });

  test('explicit context review intent takes precedence over graph ask', async () => {
    let receivedIntent = '';
    const result = await runHarvestUnit({
      ask: 'general graph ask',
      context: { ...input.context, reviewIntent: 'explicit review intent' },
    }, async args => { receivedIntent = args.intent; return response(); });
    expect(result.outcome).toBe('done');
    expect(receivedIntent).toBe('explicit review intent');
  });

  test('an explicitly invalid context intent fails without falling back to ask', async () => {
    let calls = 0;
    const invoke = async () => { calls++; return response(); };
    const blank = await runHarvestUnit({
      ask: 'fallback must not be used',
      context: { pr: 123, reviewIntent: '', expectedHead: 'a'.repeat(40) },
    }, invoke);
    const wrongType = await runHarvestUnit({
      ask: 'fallback must not be used',
      context: { pr: 123, reviewIntent: { instruction: 'bad type' }, expectedHead: 'a'.repeat(40) },
    }, invoke);
    expect(blank.outcome).toBe('failed');
    expect(blank.result.error).toBe('context.reviewIntent must be a non-empty string');
    expect(wrongType.outcome).toBe('failed');
    expect(wrongType.result.error).toBe('context.reviewIntent must be a non-empty string');
    expect(calls).toBe(0);
  });

  test('must-fix findings route to rework with the review evidence', async () => {
    const result = await runHarvestUnit(input, async () => response({ verdict: 'fail', mustFix: ['missing regression test'] }));
    expect(result.outcome).toBe('rework');
    expect(result.result.mustFix).toEqual(['missing regression test']);
    expect(result.result.attempts).toBe(1);
  });

  test('re-entry carries attempts through prior.result', async () => {
    const prior = await runHarvestUnit(input, async () => response({ verdict: 'fail', mustFix: ['fix it'] }));
    const next = await runHarvestUnit({ ...input, prior: { result: prior.result } }, async () => response());
    expect(prior.outcome).toBe('rework');
    expect(next.outcome).toBe('done');
    expect(next.result.attempts).toBe(2);
    expect(next.evidence.attempts).toBe(2);
  });

  test('stale or unexpected heads route to needs-human', async () => {
    const stale = await runHarvestUnit(input, async () => response({ currentHeadCommit: 'b'.repeat(40) }));
    const unexpected = await runHarvestUnit(input, async () => response({ headCommit: 'c'.repeat(40), currentHeadCommit: 'c'.repeat(40) }));
    expect(stale.outcome).toBe('needs-human');
    expect(unexpected.outcome).toBe('needs-human');
  });

  test('unreviewed and malformed outputs route to needs-human', async () => {
    const unavailable = await runHarvestUnit(input, async () => response({ reviewed: false }));
    const malformed = await runHarvestUnit(input, async () => ({ exitCode: 1, stdout: 'not json' }));
    expect(unavailable.outcome).toBe('needs-human');
    expect(malformed.outcome).toBe('needs-human');
  });

  test('missing or inconsistent verdict cannot complete an empty review', async () => {
    const failedWithoutFindings = await runHarvestUnit(input, async () => response({ verdict: 'fail', mustFix: [] }));
    const passedWithFindings = await runHarvestUnit(input, async () => response({ verdict: 'pass', mustFix: ['contradictory finding'] }));
    const warnedWithFindings = await runHarvestUnit(input, async () => response({ verdict: 'warn', mustFix: ['contradictory finding'] }));
    const missingVerdict = await runHarvestUnit(input, async () => response({ verdict: undefined }));
    expect(failedWithoutFindings.outcome).toBe('needs-human');
    expect(passedWithFindings.outcome).toBe('needs-human');
    expect(warnedWithFindings.outcome).toBe('needs-human');
    expect(missingVerdict.outcome).toBe('needs-human');
  });

  test('ambiguous multi-result review arrays cannot complete from their first item', async () => {
    const first = JSON.parse(response().stdout)[0];
    const laterFailure = { ...first, verdict: 'fail', mustFix: ['later must-fix'] };
    const result = await runHarvestUnit(input, async () => ({ exitCode: 0, stdout: JSON.stringify([first, laterFailure]) }));
    expect(result.outcome).toBe('needs-human');
    expect(result.result.reason).toBe('review result is missing or incomplete');
  });

  test('missing expected head, wrong PR, or failed reviewer process cannot complete', async () => {
    let calls = 0;
    const invoke = async () => { calls++; return response(); };
    const noExpected = await runHarvestUnit({ context: { pr: 123, reviewIntent: 'review' } }, invoke);
    const priorHeadIsNotAnExpectedHead = await runHarvestUnit({
      context: { pr: 123, reviewIntent: 'review' },
      prior: { result: { headCommit: 'a'.repeat(40) } },
    }, invoke);
    const wrongPr = await runHarvestUnit(input, async () => response({ pr: 456 }));
    const nonzero = await runHarvestUnit(input, async () => response({}, 2));
    expect(noExpected.outcome).toBe('needs-human');
    expect(priorHeadIsNotAnExpectedHead.outcome).toBe('needs-human');
    expect(wrongPr.outcome).toBe('needs-human');
    expect(nonzero.outcome).toBe('needs-human');
    expect(calls).toBe(0);
  });

  test('empty must-fix findings route to needs-human', async () => {
    const empty = await runHarvestUnit(input, async () => response({ verdict: 'fail', mustFix: [''] }));
    const whitespace = await runHarvestUnit(input, async () => response({ verdict: 'fail', mustFix: ['  '] }));
    expect(empty.outcome).toBe('needs-human');
    expect(whitespace.outcome).toBe('needs-human');
  });

  test('missing PR or intent fails before invoking the reviewer', async () => {
    let calls = 0;
    const invoke = async () => { calls++; return response(); };
    expect((await runHarvestUnit({ context: { reviewIntent: 'x' } }, invoke)).outcome).toBe('failed');
    expect((await runHarvestUnit({ context: { pr: 123 } }, invoke)).outcome).toBe('failed');
    expect(calls).toBe(0);
  });
});
