// TA-RETRY-VISIBLE-NO-AUTO (POOL-QUEUE 59) — a deterministic child failure gets no automatic repair Job.
// Live 11-18: run-7f94dd65 si-task-fce321706961 failed «no-usable-provider: …=provider-not-allowed» at 09:21:13 and the
// one automatic repair launched si-task-9f832bcdbf28 at 09:21:21 — same failure. Real orchestrateSelfDev · fake spawn
// with the pod surface's own failure shape (error {code: 'pod-child-failed', message: podReason} · self-implement-pod.ts).
import { describe, expect, spyOn, test, afterEach, mock } from 'bun:test';
import { debug } from '../debug/log.js';
import { orchestrateSelfDev } from './orchestrate.js';
import { repairRetryVerdict } from './repair-retry-policy.js';

afterEach(() => { mock.restore(); });

const LIVE = 'no-usable-provider: openrouter(openrouter/z-ai/glm-5.3)=provider-not-allowed, grok(grok-4.7)=provider-not-allowed';

describe('repairRetryVerdict', () => {
  test('the live no-usable-provider text is deterministic; a convergence abort is not', () => {
    expect(repairRetryVerdict('SELF_IMPLEMENT_FAILED', LIVE)).toEqual({ retry: false, failureClass: 'no-usable-provider' });
    expect(repairRetryVerdict(undefined, 'grok(grok-4.7)=provider-not-allowed')).toEqual({ retry: false, failureClass: 'provider-not-allowed' });
    expect(repairRetryVerdict('SELF_IMPLEMENT_FAILED', '수렴 못 함(단계 aborted)')).toEqual({ retry: true });
    expect(repairRetryVerdict(undefined, undefined)).toEqual({ retry: true });
  });

  test('JUD #38634 ⓑ — providers exhausted THIS turn (already-attempted · not-available) are transient: the repair stays', () => {
    expect(repairRetryVerdict('pod-child-failed', 'no-usable-provider: codex(codex)=already-attempted, grok(grok)=already-attempted')).toEqual({ retry: true });
    expect(repairRetryVerdict('pod-child-failed', 'no-usable-provider: openrouter(openrouter/z-ai/glm-5.3)=provider-not-allowed, grok(grok-4.7)=not-available')).toEqual({ retry: true });
    expect(repairRetryVerdict('pod-child-failed', 'no-usable-provider: codex-credits=folded-into-earlier-step, foo=unknown-step')).toEqual({ retry: false, failureClass: 'no-usable-provider' });
    expect(repairRetryVerdict('pod-child-failed', 'no-usable-provider: ')).toEqual({ retry: true });
  });
});

describe('orchestrateSelfDev — the one automatic repair', () => {
  const card = {
    taskCardId: 'ta-20261118-retry-visible',
    parentRequest: '완료 경계 코드: src/a.ts 변경\n완료 경계 실물: 조각 PR\n완료 경계 증거 명령: bun test src/self-dev/repair-retry-policy.test.ts',
  };

  test('a no-usable-provider failure launches once, no repair Job; the skip is logged with its class', async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const original = debug.log.bind(debug);
    spyOn(debug, 'log').mockImplementation((category, event, data, options) => {
      if (category === 'self-dev.slice') events.push([String(event), data as Record<string, unknown>]);
      else original(category, event, data, options);
    });
    let launches = 0;
    const results = await orchestrateSelfDev({
      ...card, goals: [{ id: 'a', feature: 'A' }],
      spawn: (input) => { launches++; return { address: input.spaceId, done: Promise.resolve({ exitCode: 1, output: LIVE, error: { code: 'pod-child-failed', message: LIVE } }) }; },
    });
    expect(launches).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('failed');
    expect(events.map(([event]) => event)).toEqual(['repair-skipped']);
    expect(events[0]![1]).toMatchObject({ slice: 'a', failureClass: 'no-usable-provider', reason: 'deterministic-failure' });
  });

  test('a convergence abort still gets exactly one repair attempt (unchanged)', async () => {
    let launches = 0;
    await orchestrateSelfDev({
      ...card, goals: [{ id: 'a', feature: 'A' }],
      spawn: (input) => { launches++; return { address: input.spaceId, done: Promise.resolve({ exitCode: 1, output: '수렴 못 함(단계 aborted)', error: { code: 'pod-child-failed', message: '수렴 못 함(단계 aborted)' } }) }; },
    });
    // 출처: #38430 — the existing «자동 수복 1회»: the original launch plus one repair
    expect(launches).toBe(2);
  });

  test('the task card gets one history line for the skip, and one for a repair that ran (visible, not just a log)', async () => {
    const lines: Array<[string, { event: string; detail: string }]> = [];
    await orchestrateSelfDev({
      ...card, goals: [{ id: 'a', feature: 'A' }], recordCardEvent: (id, event) => { lines.push([id, event]); },
      spawn: (input) => ({ address: input.spaceId, done: Promise.resolve({ exitCode: 1, output: LIVE, error: { code: 'pod-child-failed', message: LIVE } }) }),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toBe('ta-20261118-retry-visible');
    expect(lines[0]![1].event).toBe('repair-skipped');
    expect(lines[0]![1].detail).toStartWith('no-usable-provider — deterministic, a retry fails the same way · failed task:');

    lines.length = 0;
    await orchestrateSelfDev({
      ...card, goals: [{ id: 'a', feature: 'A' }], recordCardEvent: (id, event) => { lines.push([id, event]); },
      spawn: (input) => ({ address: input.spaceId, done: Promise.resolve({ exitCode: 1, output: 'x', error: { code: 'pod-child-failed', message: '수렴 못 함(단계 aborted)' } }) }),
    });
    expect(lines.map(([, event]) => event.event)).toEqual(['repair-retry']);
    expect(lines[0]![1].detail).toMatch(/^attempt 1 · task:[0-9a-f]+ → task:[0-9a-f]+ · pod-child-failed: 수렴 못 함\(단계 aborted\)$/);
  });

  test('a card writer that throws never stops the run', async () => {
    const results = await orchestrateSelfDev({
      ...card, goals: [{ id: 'a', feature: 'A' }], recordCardEvent: () => { throw new Error('card file locked'); },
      spawn: (input) => ({ address: input.spaceId, done: Promise.resolve({ exitCode: 1, output: LIVE, error: { code: 'pod-child-failed', message: LIVE } }) }),
    });
    expect(results[0]?.status).toBe('failed');
  });
});
