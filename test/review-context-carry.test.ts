import { describe, expect, it } from 'bun:test';
import { extractAppliedReviewItems } from '../src/agent-mission/review-loop.js';
import { buildReviewIntent } from '../src/agent-substrate/review-intent.js';

const REINFORCEMENT_HEADLINE = '✅ 리뷰 보강 자동 반영(codex-in-elanous·제1원칙 렌즈):';
const ACP_REWORK_HEADLINE = '🔁 ACP Claude Code 2차 심판: **REWORK**';
const identityHeader = '<!-- elanous-pr-comment v1 role=author -->';

describe('cross-run applied review context', () => {
  it('extracts both known loop headlines, ignores status notices and unrelated text', () => {
    const result = extractAppliedReviewItems([
      { createdAt: '2026-07-27T10:00:00Z', body: `${REINFORCEMENT_HEADLINE}\n- preserve headline rule\n- add focused test\n\n(tsc/test 통과·push·소작업 light). 재리뷰 부탁.` },
      { createdAt: '2026-07-27T11:00:00Z', body: `${ACP_REWORK_HEADLINE} (라운드 1). 추가 지적 반영 재시도:\n- restore trace event` },
      { createdAt: '2026-07-27T12:00:00Z', body: '✅ ACP Claude Code 2차 최종심판: **MERGE 준비됨**' },
      { createdAt: '2026-07-27T13:00:00Z', body: 'unrelated text\n- not an applied item' },
    ]);
    expect(result).toEqual(['restore trace event', 'preserve headline rule', 'add focused test']);
  });

  it('skips a leading identity header while retaining direct headlines and distinguishing missing headlines', () => {
    const result = extractAppliedReviewItems([
      { createdAt: '2026-07-27T12:00:00Z', body: `${identityHeader}\n${REINFORCEMENT_HEADLINE}\n- from metadata header` },
      { createdAt: '2026-07-27T11:00:00Z', body: `${ACP_REWORK_HEADLINE}\n- from direct headline` },
      { createdAt: '2026-07-27T10:00:00Z', body: `${identityHeader}\nunrelated text\n- ignored` },
    ]);
    expect(result).toEqual(['from metadata header', 'from direct headline']);
    expect(extractAppliedReviewItems([{ body: `${identityHeader}\nunrelated text` }])).toEqual([]);
  });

  it('distinguishes a recognized headline without bullets from no recognized headline', () => {
    expect(extractAppliedReviewItems([{ body: `${identityHeader}\n${REINFORCEMENT_HEADLINE}\nno bullet follows` }])).toEqual([]);
    expect(extractAppliedReviewItems([{ body: 'unrelated text' }])).toEqual([]);
  });

  it('deduplicates repeated items across newest-first comments and ignores malformed shapes', () => {
    const result = extractAppliedReviewItems([
      { createdAt: '2026-07-27T10:00:00Z', body: `${REINFORCEMENT_HEADLINE}\n- retain guard\n- add test` },
      { createdAt: '2026-07-27T11:00:00Z', body: `${ACP_REWORK_HEADLINE} (라운드 2). 추가 지적 반영 재시도:\n- retain guard\n- trace it` },
      { createdAt: '2026-07-27T12:00:00Z', body: `${REINFORCEMENT_HEADLINE}\nnot a bullet` },
    ]);
    expect(result).toEqual(['retain guard', 'trace it', 'add test']);
  });

  it('renders carried context at round zero and rework context after round zero, but not when empty', () => {
    expect(buildReviewIntent({ goal: 'ship it', round: 0, appliedLastRound: ['preserve headline rule'] })).toContain('직전 라운드 반영분\n- preserve headline rule');
    expect(buildReviewIntent({ goal: 'ship it', round: 2, appliedLastRound: ['inside-run fix'] })).toContain('직전 라운드 반영분\n- inside-run fix');
    expect(buildReviewIntent({ goal: 'ship it', round: 0, appliedLastRound: [] })).not.toContain('직전 라운드 반영분');
  });

  it('renders each normalized changed file once when execution rounds repeat it', () => {
    const intent = buildReviewIntent({
      goal: 'ship it',
      changedFiles: ['src/harness/staged-harness.ts', ' src/harness/staged-harness.ts ', 'test/review-context-carry.test.ts'],
    });

    expect(intent.match(/변경 파일: src\/harness\/staged-harness\.ts/g)).toHaveLength(1);
    expect(intent).toContain('변경 파일: test/review-context-carry.test.ts');
  });
});

describe('shard review contract through the real reviewDiff seam', () => {
  it('defaultSeams.reviewDiff hands the shard contract to the reviewer prompt (phaseIntent → reviewPullRequest)', async () => {
    const { defaultSeams } = await import('../src/self-implement/seams.js');
    const identity = { orchestrationId: 'carry', shardId: 'task:handler', totalShards: 4, position: 1,
      summary: 'Implement handler', siblings: [
        { shardId: 'task:route', summary: 'Register route' },
        { shardId: 'task:screen', summary: 'Build screen' },
        { shardId: 'task:docs', summary: 'Write docs' },
      ] };
    const goal = ['대상 경로: src/handler.ts', '보존 계약: 원장 형식은 지금과 같다', '',
      '## Shard identity', JSON.stringify(identity)].join('\n');
    const prompts: string[] = [];
    const seams = defaultSeams({
      llmReview: async (prompt: string) => { prompts.push(prompt); return 'VERDICT: PASS'; },
      reviewScopeDiff: async () => 'diff --git a/src/handler.ts b/src/handler.ts\n--- a/src/handler.ts\n+++ b/src/handler.ts\n@@ -1 +1 @@\n-a\n+b\n',
    });
    await seams.reviewDiff!('/nonexistent-review-carry', { goal, changedFiles: ['src/handler.ts'] });
    expect(prompts).toHaveLength(1);
    for (const text of ['샤드 계약 — 리뷰 범위', '- task:route: Register route', '- task:screen: Build screen',
      '- task:docs: Write docs', 'out-of-scope → 담당 형제 조각 <id>', '반증 확인 한 줄']) expect(prompts[0]).toContain(text);
  });
});
