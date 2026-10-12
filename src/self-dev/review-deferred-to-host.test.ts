/**
 * REVIEW-ACP-POD ②-b — Pod 안 리뷰 심: 표지(`ELANOUS_REVIEW_DEFERRED_TO_HOST=1`)가 있으면 api 리뷰어를 «부르지 않고»
 * `reviewed=false` ⊕ `failureReason=deferred-to-host` 를 낸다(⛔ 통과로 꾸미지 않는다). 표지가 없으면 지금과 같다.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDefaultSelfImplementSeams, planDevPipeline, type DevPipelineSpec } from './dev-pipeline.js';
import { setUserConfigOverlay } from '../user-config.js';
import { REVIEW_DEFERRED_TO_HOST_ENV, REVIEW_DEFERRED_TO_HOST_FAILURE, reviewDeferredToHostFromEnv } from '../self-implement/review-deferred-to-host.js';

const T = (over: Partial<DevPipelineSpec> = {}): DevPipelineSpec => ({ input: { text: '기능 X' }, ...over });
const DIFF = 'diff --git a/changed.ts b/changed.ts\n+export const changed = true;\n';

async function reviewOnce(opts: { deferred?: boolean; env?: string }) {
  const repo = mkdtempSync(join(tmpdir(), 'review-deferred-'));
  const calls: string[] = [];
  const saved = process.env[REVIEW_DEFERRED_TO_HOST_ENV];
  try {
    if (opts.env === undefined) delete process.env[REVIEW_DEFERRED_TO_HOST_ENV]; else process.env[REVIEW_DEFERRED_TO_HOST_ENV] = opts.env;
    writeFileSync(join(repo, 'changed.ts'), 'export const changed = true;\n');
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'openai-codex' }, roleLlm: {} }));
    const seams = await buildDefaultSelfImplementSeams(planDevPipeline(T()), {
      toolReviewerRate: 0,
      ...(opts.deferred !== undefined ? { reviewDeferredToHost: opts.deferred } : {}),
      streamLLM: async () => { calls.push('api'); return 'VERDICT: PASS'; },
      reviewScopeDiff: async () => DIFF,
    });
    const review = await seams.reviewDiff!(repo, { goal: 'deferred review' });
    return { review, calls };
  } finally {
    if (saved === undefined) delete process.env[REVIEW_DEFERRED_TO_HOST_ENV]; else process.env[REVIEW_DEFERRED_TO_HOST_ENV] = saved;
    setUserConfigOverlay(null);
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('REVIEW-ACP-POD ②-b — Pod review deferred to the host', () => {
  it('marker env=1: the api reviewer is called 0 times and the result is an explicit deferred non-review (not clean)', async () => {
    const { review, calls } = await reviewOnce({ env: '1' });
    expect(calls).toEqual([]);
    expect(review.reviewed).toBe(false);
    expect(review.verdict).not.toBe('pass');
    expect(review.failureReason).toBe(REVIEW_DEFERRED_TO_HOST_FAILURE);
    expect(review.deferredToHost).toBe(true);
    expect(review.mustFix).toEqual([]);
  });

  it('no marker: the api reviewer runs exactly as today (reviewed=true · no deferral field)', async () => {
    const { review, calls } = await reviewOnce({});
    expect(calls).toEqual(['api']);
    expect(review.reviewed).toBe(true);
    expect(review.deferredToHost).toBeUndefined();
  });

  it('option overrides env (test seam) — false keeps the api review even when env says 1', async () => {
    const { review, calls } = await reviewOnce({ env: '1', deferred: false });
    expect(calls).toEqual(['api']);
    expect(review.reviewed).toBe(true);
  });

  it('only the exact value 1 turns it on', () => {
    expect(reviewDeferredToHostFromEnv({ [REVIEW_DEFERRED_TO_HOST_ENV]: '1' })).toBe(true);
    for (const v of [undefined, '', '0', 'true', 'yes']) expect(reviewDeferredToHostFromEnv({ [REVIEW_DEFERRED_TO_HOST_ENV]: v })).toBe(false);
  });
});
