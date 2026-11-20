// TA-POD-REVIEW-PROVIDER-ALLOW — a review whose provider chain is exhausted: ledger line · needs-owner · no automatic repair.
import { afterEach, describe, expect, spyOn, test, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDefaultSelfImplementSeams, planDevPipeline } from './dev-pipeline.js';
import { orchestrateSelfDev } from './orchestrate.js';
import { repairRetryVerdict } from './repair-retry-policy.js';
import { setUserConfigOverlay } from '../user-config.js';
import { loadRunLedger } from '../self-implement/run-ledger.js';
import { classifyMergeHoldStop } from '../self-implement/run-stop.js';
import { runReviewWithFallback, NoUsableReviewProviderError } from './review-provider-fallback.js';
import { noReviewProviderError, unreviewedMergeReason } from './no-review-provider.js';
import { pickAutohealAction } from '../self-implement/stop-autoheal.js';
import { debug } from '../debug/log.js';
import * as hostConfig from '../config.js';

afterEach(() => { mock.restore(); setUserConfigOverlay(null); });

const DIFF = 'diff --git a/changed.ts b/changed.ts\n+export const changed = true;\n';
// Nothing credential-shaped may reach the ledger line or the failure text: only provider names and fixed reason codes.
const CREDENTIAL_SHAPED = /sk-|api[_-]?key|token|bearer|secret/i;

async function exhaustedReview(opts: { runId: string }) {
  const repo = mkdtempSync(join(tmpdir(), 'no-review-provider-'));
  const priorSubstrate = process.env.ELANOUS_SUBSTRATE;
  const priorRun = process.env.ELANOUS_RUN_ID;
  const calls: string[] = [];
  try {
    writeFileSync(join(repo, 'changed.ts'), 'export const changed = true;\n');
    process.env.ELANOUS_RUN_ID = opts.runId;
    process.env.ELANOUS_SUBSTRATE = 'pod';
    // 호스트 자격에 의존하지 않게 고정(JUD #110533): OpenRouter 키가 있는 호스트에선 Pod 의 Luna 대체 공급자가 살아나 «소진» 이 안 됨 —
    // 이 시험은 «사슬 전부 소진» 계약을 보므로 키 조회를 «없음» 으로 주입한다(afterEach 의 mock.restore 가 복원).
    spyOn(hostConfig, 'getOpenRouterApiKey').mockReturnValue(undefined);
    setUserConfigOverlay((config) => ({
      ...config, roleLlm: {}, roleModels: { review: 'unregistered-review-model' },
      // glm-5.3 is refused for review/judgement (not-in-review-allowlist): every candidate is ruled out by configuration.
      llm: { ...config.llm, provider: 'openai-codex', reviewFallbackModels: ['grok-4.6'], roleProviderChains: { review: ['glm-5.3'], judgement: ['glm-5.3'], recovery: ['glm-5.3'] } },
    }));
    const seams = await buildDefaultSelfImplementSeams(planDevPipeline({ input: { text: '기능 X' } }), {
      toolReviewerRate: 0, reviewGrokQuota: () => 'exhausted',
      streamLLM: async (_m, _c, o) => { calls.push(o?.model ?? 'unknown'); return 'VERDICT: PASS'; },
      reviewScopeDiff: async () => DIFF,
    });
    const review = await seams.reviewDiff!(repo, { goal: 'exhausted chain' });
    return { review, calls, ledger: loadRunLedger(opts.runId) ?? [] };
  } finally {
    if (priorSubstrate === undefined) delete process.env.ELANOUS_SUBSTRATE; else process.env.ELANOUS_SUBSTRATE = priorSubstrate;
    if (priorRun === undefined) delete process.env.ELANOUS_RUN_ID; else process.env.ELANOUS_RUN_ID = priorRun;
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('review provider chain exhausted', () => {
  {
    test(`Pod chain: one no-review-provider ledger line, no credential value, no reviewer call, no auto repair`, async () => {
      const runId = `run-nrp-${randomUUID()}`;
      const { review, calls, ledger } = await exhaustedReview({ runId });
      expect(calls).toEqual([]);
      expect(review.reviewed).toBe(false);
      const rows = ledger.filter((entry) => entry.event === 'no-review-provider');
      expect(rows).toHaveLength(1);
      const data = rows[0]!.data as { role: string; reason: string; providers: string[]; skipped: Array<{ provider: string; why: string }> };
      expect(data.role).toBe('review');
      expect(data.reason).toBe('role-chain-exhausted');
      expect(data.providers.length).toBeGreaterThan(0);
      expect(Object.keys(data).sort()).toEqual(['providers', 'reason', 'role', 'skipped']);
      expect(JSON.stringify(rows[0]!.data)).not.toMatch(CREDENTIAL_SHAPED);
      expect(String(review.failureReason)).not.toMatch(CREDENTIAL_SHAPED);
      // (b) the unreviewed round is held as needs-owner, (c) the one automatic repair is not spent on it.
      expect(String(review.failureReason)).toStartWith('no-review-provider:');
      expect(repairRetryVerdict('pod-child-failed', review.failureReason)).toEqual({ retry: false, failureClass: 'no-review-provider' });
    });
  }

  test('an unreviewed round names provider exhaustion; any other unreviewed reason stays no-real-review', () => {
    expect(unreviewedMergeReason('no-review-provider: role-chain-exhausted: review: x(y)=no-credential')).toBe('no-review-provider');
    expect(unreviewedMergeReason('role-chain-exhausted: judgement: x(y)=no-credential')).toBe('no-review-provider');
    expect(unreviewedMergeReason('429 rate limited')).toBe('no-real-review');
    expect(unreviewedMergeReason(undefined)).toBe('no-real-review');
  });

  test('the stop class of an unreviewed provider exhaustion is needs-owner (not the generic review-out-of-scope)', () => {
    expect(classifyMergeHoldStop('no-review-provider')).toBe('no-review-provider');
    expect(pickAutohealAction('no-review-provider').action).toBe('needs-owner');
    expect(classifyMergeHoldStop('no-real-review')).toBe('review-out-of-scope');
  });
});

describe('non-Pod path (defaultApiReview): every attempt unavailable at call time', () => {
  // dev-pipeline plans non-Pod attempts with no availability filter, so this branch only fires when `skipUnavailable`
  // rules out every attempt; the real runReviewWithFallback is driven here with exactly that and the wrapper's conversion.
  test('the real fallback runner throws the structured error; the marked message skips the repair and carries no call text', async () => {
    const attempt = (label: string, model: string) => ({ label, model, provider: { name: label } as never });
    let called = 0;
    const error = await runReviewWithFallback(
      [attempt('grok', 'grok-4.6'), attempt('openrouter', 'openrouter/z-ai/glm-5.3')],
      async () => { called++; return 'VERDICT: PASS'; }, () => {},
      { skipUnavailable: (a) => ({ label: a.label, model: a.model, provider: a.label, why: 'no-credential' as const }) },
    ).catch((e: unknown) => e);
    expect(called).toBe(0);
    expect(error).toBeInstanceOf(NoUsableReviewProviderError);
    const exhausted = error as NoUsableReviewProviderError;
    expect(exhausted.skipped.map((s) => [s.provider, s.why])).toEqual([['grok', 'no-credential'], ['openrouter', 'no-credential']]);
    const marked = noReviewProviderError(exhausted.message);
    expect(marked.message).toStartWith('no-review-provider: no-usable-provider: grok(grok-4.6)=no-credential');
    expect(repairRetryVerdict('pod-child-failed', marked.message)).toEqual({ retry: false, failureClass: 'no-review-provider' });
    // the unmarked text keeps its old verdict (no-credential is not a configuration-decided skip reason there)
    expect(repairRetryVerdict('pod-child-failed', exhausted.message)).toEqual({ retry: true });
  });
});

describe('repairRetryVerdict — role-chain exhaustion (defect: the prefix was not recognised)', () => {
  const CHAIN = 'role-chain-exhausted: review: openai-codex(gpt-6.1-terra)=no-credential, grok(grok-4.7)=grok-usage-at-or-above-70, openrouter(openrouter/z-ai/glm-5.3)=not-in-review-allowlist';
  test('the bare chain text and the marked text both skip the repair', () => {
    expect(repairRetryVerdict('pod-child-failed', CHAIN)).toEqual({ retry: false, failureClass: 'no-review-provider' });
    expect(repairRetryVerdict('pod-child-failed', `no-review-provider: ${CHAIN}`)).toEqual({ retry: false, failureClass: 'no-review-provider' });
  });
  test('unrelated failures keep the one repair', () => {
    expect(repairRetryVerdict('pod-child-failed', '수렴 못 함(단계 aborted)')).toEqual({ retry: true });
    expect(repairRetryVerdict('pod-child-failed', 'no-usable-provider: codex(codex)=already-attempted')).toEqual({ retry: true });
  });
});

describe('orchestrateSelfDev — chain exhaustion', () => {
  const card = {
    taskCardId: 'ta-20261120-no-review-provider',
    parentRequest: '완료 경계 코드: src/a.ts 변경\n완료 경계 실물: 조각 PR\n완료 경계 증거 명령: bun test src/self-dev/no-review-provider.test.ts',
  };
  const MESSAGE = 'role-chain-exhausted: review: openai-codex(gpt-6.1-terra)=no-credential';
  test('launches once, no repair Job, and the card goes needs-owner', async () => {
    const needsOwner: Array<[string, string]> = [];
    let launches = 0;
    spyOn(debug, 'log').mockImplementation((() => {}) as never);
    const results = await orchestrateSelfDev({
      ...card, goals: [{ id: 'a', feature: 'A' }],
      recordCardEvent: () => {}, markCardNeedsOwner: (id, detail) => { needsOwner.push([id, detail]); },
      spawn: (input) => { launches++; return { address: input.spaceId, done: Promise.resolve({ exitCode: 1, output: MESSAGE, error: { code: 'pod-child-failed', message: MESSAGE } }) }; },
    });
    expect(launches).toBe(1);
    expect(results[0]?.status).toBe('failed');
    expect(needsOwner).toHaveLength(1);
    expect(needsOwner[0]![0]).toBe('ta-20261120-no-review-provider');
    expect(needsOwner[0]![1]).toStartWith('failed/needs-owner — no-review-provider');
  });
  test('an unrelated failure never marks the card', async () => {
    const needsOwner: string[] = [];
    spyOn(debug, 'log').mockImplementation((() => {}) as never);
    await orchestrateSelfDev({
      ...card, goals: [{ id: 'a', feature: 'A' }], recordCardEvent: () => {}, markCardNeedsOwner: (id) => { needsOwner.push(id); },
      spawn: (input) => ({ address: input.spaceId, done: Promise.resolve({ exitCode: 1, output: 'x', error: { code: 'pod-child-failed', message: '수렴 못 함(단계 aborted)' } }) }),
    });
    expect(needsOwner).toEqual([]);
  });
});
