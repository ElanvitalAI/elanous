import { afterEach, describe, expect, test } from 'bun:test';
import { runSelfImplement, type SelfImplementReview } from './orchestrator.js';
import { seams } from './test-seams.js';
import { reviewerTag } from './reviewer-record.js';
import type { RunLedgerEntry } from './run-ledger.js';

const savedCard = process.env.ELANOUS_TASK_CARD_ID;
afterEach(() => {
  if (savedCard === undefined) delete process.env.ELANOUS_TASK_CARD_ID;
  else process.env.ELANOUS_TASK_CARD_ID = savedCard;
});

function review(extra: Partial<SelfImplementReview>): SelfImplementReview {
  return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'looks fine', reviewed: true, ...extra };
}

async function runWith(reviewResult: SelfImplementReview, cardWriter?: (cardId: string, event: { detail: string; runId?: string }) => void) {
  process.env.ELANOUS_TASK_CARD_ID = 'ta-reviewer-record';
  const posts: string[] = [];
  const ledger: RunLedgerEntry[] = [];
  const cardLines: Array<{ cardId: string; detail: string; runId?: string }> = [];
  const result = await runSelfImplement({
    feature: 'reviewer record', runId: 'run-reviewer-record', maxReworkRounds: 0, // 출처: #39206 — one round, no rework
    seams: seams({
      reviewDiff: async () => reviewResult,
      writeRunLedger: (entry) => { ledger.push(entry); },
      postPrComment: async ({ body }) => { posts.push(body); },
      recordReviewerOnCard: cardWriter ?? ((cardId, event) => { cardLines.push({ cardId, ...event }); }),
    }),
  });
  return { result, posts, ledger, cardLines };
}

describe('reviewer record', () => {
  test('a completed review names its provider/model on the card history and the PR comment', async () => {
    const { result, posts, ledger, cardLines } = await runWith(review({ reviewer: { provider: 'openrouter', model: 'z-ai/glm-4.6' } }));
    expect(result.stage).toBe('pr-opened');
    expect(cardLines).toEqual([{ cardId: 'ta-reviewer-record', detail: 'reviewer=openrouter/z-ai/glm-4.6', runId: 'run-reviewer-record' }]);
    expect(posts.some((body) => body.includes('reviewer=openrouter/z-ai/glm-4.6'))).toBe(true);
    const reviewed = ledger.find((entry) => entry.event === 'reviewed');
    expect(reviewed?.data.reviewer).toBe('reviewer=openrouter/z-ai/glm-4.6');
  });

  test('without a reviewer value the run ends with no reviewer line anywhere (the gap this PR closes)', async () => {
    const { posts, cardLines } = await runWith(review({}));
    expect(cardLines).toEqual([]);
    expect(posts.some((body) => body.includes('reviewer='))).toBe(false);
  });

  test('an unreviewed round records no reviewer even if a value is attached', async () => {
    const { cardLines, posts } = await runWith(review({ reviewed: false, failureReason: 'no-review-provider: x', reviewer: { provider: 'grok', model: 'grok-4' } }));
    expect(cardLines).toEqual([]);
    expect(posts.some((body) => body.includes('reviewer=grok'))).toBe(false);
  });

  test('a throwing card writer never fails the run', async () => {
    const { result } = await runWith(review({ reviewer: { provider: 'grok', model: 'grok-4' } }), () => { throw new Error('card store down'); });
    expect(result.stage).toBe('pr-opened');
  });

  test('a credential-looking value is never written anywhere', async () => {
    const secret = 'sk-live-abcdef0123456789';
    const { cardLines, posts, ledger } = await runWith(review({ reviewer: { provider: 'openrouter', model: secret } }));
    expect(cardLines).toEqual([]);
    expect(JSON.stringify([posts, ledger])).not.toContain(secret);
  });
});

describe('reviewerTag', () => {
  test.each([
    [{ provider: 'openai-codex', model: 'gpt-5.1' }, 'reviewer=openai-codex/gpt-5.1'],
    [{ provider: 'claude-acp', model: 'claude-acp:cct' }, 'reviewer=claude-acp/claude-acp:cct'],
  ])('plain names pass: %j', (input, expected) => { expect(reviewerTag(input)).toBe(expected); });

  test.each([
    [undefined],
    [{ provider: '', model: 'm' }],
    [{ provider: 'p', model: 'm'.repeat(81) }],
    [{ provider: 'p', model: 'a b' }],
    [{ provider: 'p', model: 'x\nreviewer=forged' }],
    [{ provider: 'p', model: 'ghp_abcdefghijklmnop' }],
    [{ provider: 'p', model: 'Bearer-abc' }],
    [{ provider: 'p', model: 'eyJhbGciOiJIUzI1NiJ9' }],
  ])('non-names are dropped: %j', (input) => { expect(reviewerTag(input as never)).toBeUndefined(); });
});

describe('reviewer record across rounds and truncation', () => {
  // 출처: JUD-B #114162 — 증거 미충족 재작업(라운드0 리뷰 완료) 뒤에도 라운드0 reviewer 코멘트가 게시돼야 한다.
  test('a completed round-0 review is posted even when uncovered evidence sends the run to round 1', async () => {
    const posts: string[] = [];
    let impl = 0;
    const reviewRounds: number[] = [];
    await runSelfImplement({
      feature: 'fixture\n## REQUIRED EVIDENCE\n- [wiring] evidence of wiring', runId: 'run-reviewer-multi', autoMerge: true, maxReworkRounds: 1, memory: false, // 출처: #39251 — one rework round
      seams: seams({
        implement: async () => ({ ok: true, summary: ++impl === 1 ? 'first implementation' : 'EVIDENCE: [wiring] wired || inspect\nRESULT: PASS' }),
        reviewDiff: async (_cwd, ctx) => { reviewRounds.push(ctx?.round ?? -1); return review({ summary: `unique review round ${ctx?.round}`, diffTruncated: false, reviewer: { provider: 'grok', model: 'grok-4' } }); },
        postPrComment: async ({ body }) => { posts.push(body); },
        persistReviewArtifact: () => ({ path: '/tmp/fake-review-artifact' }),
        persistReworkNoteArtifact: () => ({ path: '/tmp/fake-rework-artifact' }),
      }),
    });
    expect(reviewRounds).toEqual([0, 1]);
    expect(posts.filter((b) => b.includes('reviewer=grok/grok-4')).length).toBe(2);
    expect(posts.some((b) => b.includes('unique review round 0'))).toBe(true);
  }, 30000);

  // 출처: orchestrator MAX_PR_COMMENT_BODY_CHARS = 60_000 — 절단은 본문 뒤를 자른다.
  test('the reviewer tag survives the 60000-char comment truncation after a must-fix', async () => {
    const posts: string[] = [];
    await runSelfImplement({
      feature: 'huge must-fix', runId: 'run-reviewer-trunc', maxReworkRounds: 1, memory: false, // 출처: #39251 — one rework round
      seams: seams({
        reviewDiff: async (_cwd, ctx) => ctx?.round === 0
          ? review({ verdict: 'fail', mustFix: ['x'.repeat(70_000)], reviewer: { provider: 'grok', model: 'grok-4' } })
          : review({}),
        postPrComment: async ({ body }) => { posts.push(body); },
      }),
    });
    const mustFixPost = posts.find((b) => b.includes('omitted'));
    expect(mustFixPost).toBeDefined();
    expect(mustFixPost!.length).toBeLessThanOrEqual(60_000);
    expect(mustFixPost!).toContain('reviewer=grok/grok-4');
  }, 30000);
});
