// TA-POD-REVIEW-PROVIDER-ALLOW — the review model actually used is recorded as one line `reviewer=<provider>/<model>` (`reviewer=none` if none ran).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { streamLLM } from '../llm.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { clearLaunchRoleLlmOverrides, setUserConfigOverlay } from '../user-config.js';
import { buildDefaultSelfImplementSeams, planDevPipeline } from './dev-pipeline.js';
import { reviewerRecordLine } from './no-review-provider.js';
import { prBody } from '../self-implement/orchestrator.js';
import { readTaskCard, taskAgentStatePath, writeTaskCards, type TaskCard } from '../task-agent/task-hand.js';

const QWEN = 'qwen/qwen3-coder';
const REVIEWER = /reviewer=[A-Za-z0-9._:@+-]+\/[A-Za-z0-9._:@+/-]+/;
const CARD = 'card-reviewer-rec';

async function reviewOnce(stream: typeof streamLLM): Promise<{ summary: string; history: string[] }> {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-record-'));
  const prior = { card: process.env.ELANOUS_TASK_CARD_ID, sub: process.env.ELANOUS_SUBSTRATE, key: process.env.OPENROUTER_API_KEY };
  try {
    setElanousConfigDir(root);
    process.env.ELANOUS_TASK_CARD_ID = CARD;
    process.env.ELANOUS_SUBSTRATE = 'pod';
    process.env.OPENROUTER_API_KEY = 'test-key';
    writeTaskCards(taskAgentStatePath(), [{ id: CARD, status: 'launched', runId: 'run-x', history: [] } as unknown as TaskCard]);
    clearLaunchRoleLlmOverrides();
    setUserConfigOverlay((config) => ({ ...config, roleLlm: {}, llm: { ...config.llm, roleProviderChains: { review: [QWEN], judgement: [QWEN], recovery: [QWEN] } } }));
    const seams = await buildDefaultSelfImplementSeams(planDevPipeline({ input: { text: 'reviewer record' } }), {
      toolReviewerRate: 0, streamLLM: stream,
      reviewScopeDiff: async () => 'diff --git a/a.ts b/a.ts\n+export const a = 1;\n',
    });
    const review = await seams.reviewDiff!(root, { goal: 'reviewer record', runId: 'run-x' });
    const history = (readTaskCard(CARD)?.history ?? []).filter((e) => e.event === 'review-reviewer').map((e) => e.detail ?? '');
    return { summary: prBody('feat', 'impl', undefined, review), history };
  } finally {
    resetElanousConfigDir(); setUserConfigOverlay(null); clearLaunchRoleLlmOverrides();
    for (const [k, v] of [['ELANOUS_TASK_CARD_ID', prior.card], ['ELANOUS_SUBSTRATE', prior.sub], ['OPENROUTER_API_KEY', prior.key]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

describe('reviewer record line', () => {
  test('a real review writes reviewer=<provider>/<model> on the card history and in the PR body', async () => {
    const { summary, history } = await reviewOnce((async () => 'VERDICT: PASS') as unknown as typeof streamLLM);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatch(REVIEWER);
    expect(history[0]).toContain('reviewer=openrouter/');
    expect(summary).toContain(history[0]!);
  });

  test('a review that never ran records reviewer=none on both', async () => {
    const { summary, history } = await reviewOnce((async () => { throw new Error('boom'); }) as unknown as typeof streamLLM);
    expect(history).toEqual(['reviewer=none']);
    expect(summary).toContain('reviewer=none');
  });

  test('secret-shaped names never reach the line', () => {
    const key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    expect(reviewerRecordLine({ provider: 'openrouter', model: key })).toBe('reviewer=openrouter/unknown');
    expect(reviewerRecordLine({ provider: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', model: 'm' })).not.toContain('ghp_');
    expect(reviewerRecordLine({ provider: 'p q\nBearer x', model: 'm=1' })).not.toMatch(/\s|=1/);
    expect(reviewerRecordLine({ provider: 'openrouter', model: `openai/${key}` })).toBe('reviewer=openrouter/unknown');
    expect(reviewerRecordLine(undefined)).toBe('reviewer=none');
  });
});
