// PR 리뷰어 substrate 단위테스트 — substrate 직접 검증(mission-critique 은 re-export smoke).
import { describe, it, expect, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { capIntent } from './review-intent.js';
import {
  worseReviewVerdict, reviewPullRequest, parseReviewResult, buildReviewPrompt, renderReview,
  splitDiffByFile, budgetFileDiff, budgetedDiff, diffSection, diffShownPercent, reviewDiffCharLimit, budgetReviewerContext, capReviewImages,
  planReviewChunks, foldReviewResults, reviewMaxPasses,
  isScopeRevertMustFix, type ReviewInput, type ReviewerContextItem,
} from './pr-reviewer.js';

describe('reviewDiffCharLimit — 기본 예산·환경변수 계약', () => {
  it('기본 64,000자, 유효 override, 2,000 미만 무시 및 50,000자 diff 비절단', () => {
    const original = process.env.ELANOUS_PR_REVIEW_DIFF_CHARS;
    try {
      delete process.env.ELANOUS_PR_REVIEW_DIFF_CHARS;
      expect(reviewDiffCharLimit()).toBe(64_000);
      const prefix = 'diff --git a/large.ts b/large.ts\n@@\n+';
      const diff = prefix + 'x'.repeat(50_000 - prefix.length);
      expect(diff).toHaveLength(50_000);
      expect(budgetedDiff(diff)).toMatchObject({ text: diff, truncated: false });

      process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = '5000';
      expect(reviewDiffCharLimit()).toBe(5000);

      process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = '1999';
      expect(reviewDiffCharLimit()).toBe(64_000);
    } finally {
      if (original === undefined) delete process.env.ELANOUS_PR_REVIEW_DIFF_CHARS;
      else process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = original;
    }
  });
});

describe('worseReviewVerdict — canonical verdict 어휘', () => {
  it('더 나쁜 쪽(fail>warn>pass)', () => {
    expect(worseReviewVerdict('pass', 'fail')).toBe('fail');
    expect(worseReviewVerdict('warn', 'pass')).toBe('warn');
    expect(worseReviewVerdict('pass', 'pass')).toBe('pass');
  });
});

describe('isScopeRevertMustFix — 범위 사유 되돌림/분리 관측 분류', () => {
  it('목표와 무관하므로 되돌리거나 별도 PR로 분리하라는 지적을 표시한다', () => {
    expect(isScopeRevertMustFix('decomposeShadowGoals 의 소비 변경은 이 목표와 무관하니 되돌리거나 별도 PR 로 분리해야 한다')).toBe(true);
  });

  it('범위 사유 없이 테스트 누락만 지적하면 표시하지 않는다', () => {
    expect(isScopeRevertMustFix('테스트가 clean 갈래를 검증하지 않는다')).toBe(false);
  });
});

describe('parseReviewResult — VERDICT + MUST-FIX/SHOULD-FIX 파싱', () => {
  it('FAIL + 블로커 분해', () => {
    const r = parseReviewResult('VERDICT: FAIL\nMUST-FIX:\n- 미배선\nSHOULD-FIX:\n- 네이밍');
    expect(r.verdict).toBe('fail');
    expect(r.mustFix).toEqual(['미배선']);
    expect(r.shouldFix).toEqual(['네이밍']);
  });
  it('FAIL 인데 must-fix 미기재 → 최소 1 블로커 보장', () => {
    expect(parseReviewResult('VERDICT: FAIL\nSHOULD-FIX:\n- x').mustFix.length).toBeGreaterThanOrEqual(1);
  });
  it('VERDICT 부재 → pass 폴백', () => {
    expect(parseReviewResult('음').verdict).toBe('pass');
  });
  it('UNKNOWN-DEFAULT OUTPUT ASSERTION 이름표를 기존 MUST-FIX 분류와 문면 그대로 보존한다', () => {
    const finding = 'UNKNOWN-DEFAULT OUTPUT ASSERTION: unknown caller input becomes false in external output.';
    const result = parseReviewResult(`VERDICT: FAIL\nMUST-FIX:\n- ${finding}`);
    expect(result.mustFix).toEqual([finding]);
    expect(result.shouldFix).toEqual([]);
  });
  it('REQUIREMENTS는 관측만 하고 FAIL의 verdict·mustFix·shouldFix를 바꾸지 않는다', () => {
    const withRequirements = 'VERDICT: FAIL\nMUST-FIX:\nSHOULD-FIX:\nREQUIREMENTS:\n- src/index.ts 의 5930행 주변을 보아야 소비 경로를 판정할 수 있다';
    const withoutRequirements = 'VERDICT: FAIL\nMUST-FIX:\nSHOULD-FIX:';

    const observed = parseReviewResult(withRequirements);
    const baseline = parseReviewResult(withoutRequirements);

    expect(observed.requirements).toEqual(['src/index.ts 의 5930행 주변을 보아야 소비 경로를 판정할 수 있다']);
    expect(baseline.requirements).toBeUndefined();
    expect(observed.verdict).toBe('fail');
    expect(observed.verdict).toBe(baseline.verdict);
    expect(observed.mustFix).toEqual(['PR 리뷰 FAIL — 재작업 필요(구체 지적 미파싱).']);
    expect(observed.mustFix).toEqual(baseline.mustFix);
    expect(observed.shouldFix).toEqual(baseline.shouldFix);
  });
  it('REQUIREMENTS: 정확 헤더만 관측 절로 취급하고 일반 문장 뒤 bullet은 FAIL fallback으로 보존한다', () => {
    const result = parseReviewResult('VERDICT: FAIL\nRequirements are satisfied\n- 구체 지적');
    expect(result).toMatchObject({ verdict: 'fail', mustFix: ['구체 지적'], shouldFix: [] });
    expect(result.requirements).toBeUndefined();
  });
  it('FAIL의 일반 bullet은 기존처럼 mustFix fallback으로 승격한다', () => {
    const result = parseReviewResult('VERDICT: FAIL\n- 구체 지적');
    expect(result).toMatchObject({ verdict: 'fail', mustFix: ['구체 지적'], shouldFix: [] });
    expect(result.requirements).toBeUndefined();
  });
  it('비어 있거나 잘못된 REQUIREMENTS 절은 리뷰를 계속한다', () => {
    const result = parseReviewResult('VERDICT: PASS\nREQUIREMENTS:\n보아야 할 항목');
    expect(result).toMatchObject({ verdict: 'pass', mustFix: [], shouldFix: [] });
    expect(result.requirements).toBeUndefined();
  });
});

describe('reviewPullRequest — llmReview seam·fail-soft·reviewed 구분', () => {
  const input = { prDiff: '+x', phaseIntent: 'p' };
  it('미주입 → pass·reviewed=false(미검토)', async () => {
    const r = await reviewPullRequest(input);
    expect(r.verdict).toBe('pass');
    expect(r.reviewed).toBe(false);
  });
  it('실제 PASS → reviewed=true', async () => {
    expect((await reviewPullRequest(input, async () => 'VERDICT: PASS')).reviewed).toBe(true);
  });
  it('throw → fail-soft pass·reviewed=false', async () => {
    const r = await reviewPullRequest(input, async () => { throw new Error('down'); });
    expect(r.verdict).toBe('pass');
    expect(r.reviewed).toBe(false);
  });
  it.each([
    ['runId와 round 모두', { runId: 'run-1', round: 2 }, { runId: 'run-1', round: 2 }],
    ['runId만', { runId: 'run-1' }, { runId: 'run-1' }],
    // ⭐ round 단독 — 「받은 값만 남긴다」 계약은 두 키가 **각각** 독립이라야 성립한다.
    //   runId 만 검사하면 구현이 두 키를 묶어 다뤄도 통과한다(elanous self review should-fix · #7664).
    ['round만', { round: 5 }, { round: 5 }],
    ['조인 키 없음', undefined, {}],
  ])('리뷰어 컨텍스트 예산은 %s의 수치와 받은 조인 키만 관측에 남긴다', async (_label, reviewContext, joinKeys) => {
    const context = [{ label: 'sensitive.md', body: 'secret-context-body '.repeat(1_000) }];
    const expectedPrompt = buildReviewPrompt({ prDiff: '+x', phaseIntent: 'p', reviewerContext: context });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let seenPrompt = '';
    try {
      const result = await reviewPullRequest(
        { prDiff: '+x', phaseIntent: 'p', reviewerContext: context, ...(reviewContext ? { reviewContext } : {}) },
        async (prompt) => { seenPrompt = prompt; return 'VERDICT: WARN\nSHOULD-FIX:\n- watch'; },
      );
      const call = log.mock.calls.find(([category, event]) => category === 'review.images' && event === 'reviewer-context-budget');
      expect(call).toEqual(['review.images', 'reviewer-context-budget', {
        itemCount: 1, shownChars: 12_000, totalChars: 20_017, truncated: true,
        fullyIncludedItems: 0, truncatedItems: 1, omittedItems: 0,
        ...joinKeys,
      }]);
      expect(JSON.stringify(call)).not.toContain('secret-context-body');
      expect(seenPrompt).toBe(expectedPrompt);
      expect(result).toMatchObject({ verdict: 'warn', reviewed: true, shouldFix: ['watch'] });
    } finally {
      log.mockRestore();
    }
  });
  it('비절단 리뷰어 컨텍스트 예산도 truncated=false로 관측에 남긴다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await reviewPullRequest(
        { prDiff: '+x', phaseIntent: 'p', reviewerContext: [{ label: 'note', body: 'body' }] },
        async () => 'VERDICT: PASS',
      );
      const call = log.mock.calls.find(([category, event]) => category === 'review.images' && event === 'reviewer-context-budget');
      expect(call).toEqual(['review.images', 'reviewer-context-budget', {
        itemCount: 1, shownChars: 13, totalChars: 13, truncated: false,
        fullyIncludedItems: 1, truncatedItems: 0, omittedItems: 0,
      }]);
    } finally {
      log.mockRestore();
    }
  });
  it.each([
    ['절단', [{ label: 'large', body: 'x'.repeat(12_001) }], { itemCount: 1, shownChars: 12_000, totalChars: 12_011, truncated: true, fullyIncludedItems: 0, truncatedItems: 1, omittedItems: 0 }],
    ['비절단', [{ label: 'note', body: 'body' }], { itemCount: 1, shownChars: 13, totalChars: 13, truncated: false, fullyIncludedItems: 1, truncatedItems: 0, omittedItems: 0 }],
  ])('컨텍스트 %s이면 계산한 예산이 리뷰 결과 구조체에 실린다', async (_label, reviewerContext, contextBudget) => {
    const result = await reviewPullRequest({ prDiff: '+x', phaseIntent: 'p', reviewerContext }, async () => 'VERDICT: PASS');
    expect(result).toMatchObject({ verdict: 'pass', reviewed: true, contextBudget });
  });
  it('컨텍스트가 없으면 예산 관측과 결과 구조체 필드를 남기지 않고 관측 실패에도 리뷰는 계속한다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      if (category === 'review.images' && event === 'reviewer-context-budget') throw new Error('sink unavailable');
    }) as never);
    try {
      const noContext = await reviewPullRequest({ prDiff: '+x', phaseIntent: 'p' }, async () => 'VERDICT: PASS');
      expect(log.mock.calls.some(([category, event]) => category === 'review.images' && event === 'reviewer-context-budget')).toBe(false);
      expect(noContext.contextBudget).toBeUndefined();
      const result = await reviewPullRequest(
        { prDiff: '+x', phaseIntent: 'p', reviewerContext: [{ label: 'note', body: 'body' }] },
        async () => 'VERDICT: PASS',
      );
      expect(result).toMatchObject({ verdict: 'pass', reviewed: true });
    } finally {
      log.mockRestore();
    }
  });
  it('절단 diff는 주입된 저장소 경계 reader로 현재 파일 문맥을 보완하고 횟수를 기록한다', async () => {
    const diff = `diff --git a/src/changed.ts b/src/changed.ts\n@@\n+// see src/hidden.ts\n${'x'.repeat(65_000)}`;
    const paths: string[] = [];
    let prompt = '';
    const result = await reviewPullRequest({
      prDiff: diff,
      phaseIntent: 'p',
      readReferencedFile: (path) => {
        paths.push(path);
        return path === 'src/hidden.ts' ? { kind: 'ok', contents: 'export const recovered = true;' } : { kind: 'outside-repository' };
      },
    }, async (p) => { prompt = p; return 'VERDICT: PASS'; });
    expect(paths).toEqual(['src/changed.ts', 'src/hidden.ts']);
    expect(prompt).toContain('## Repository file context (read within repository boundary)');
    expect(prompt).toContain('export const recovered = true;');
    expect(result).toMatchObject({ reviewed: true, referencedFilesOpened: true, referencedFilesRead: 1 });
  });
});

describe('buildReviewPrompt / renderReview', () => {
  it('buildReviewPrompt — POST-PR·VERDICT 계약·의도 주입', () => {
    const p = buildReviewPrompt({ prDiff: '+x', phaseIntent: 'lineage helper', acceptance: 'export+test' });
    expect(p).toContain('POST-PR review');
    expect(p).toContain('lineage helper');
    expect(p).toContain('VERDICT: PASS | VERDICT: WARN | VERDICT: FAIL');
    expect(p).toContain('"REQUIREMENTS:"');
    expect(p).toContain('This is observational only and does not change the verdict.');
  });
  it('buildReviewPrompt — 비절단 review intent는 종전 제목을 보존한다', () => {
    const intent = `${'a'.repeat(3999)}Z`;
    const p = buildReviewPrompt({ prDiff: '+x', phaseIntent: intent });
    expect(p).toContain(`## Phase intent\n${intent}`);
    expect(p).not.toContain('## Phase intent (budget-truncated:');
  });
  it('buildReviewPrompt — 절단 review intent의 실제 전달량과 원본량을 제목에 고지한다', () => {
    const intent = 'x'.repeat(35_417);
    const p = buildReviewPrompt({ prDiff: '+x', phaseIntent: intent });
    // ⛔⭐ 기대값을 `capIntent()` 로 «재계산»하지 않는다 — 그러면 상한이 바뀌어도 테스트가 통과해
    //   4,000자 계약 회귀를 못 잡는다(무인 리뷰 should-fix · 2026-08-04).
    //   ⇒ 실측 문면을 «리터럴»로 못 박는다. 상한을 바꾸면 이 줄이 «먼저» 깨져야 한다.
    expect(p).toContain('## Phase intent (budget-truncated: 4000/35417 chars shown, 11%)');
  });
  it('buildReviewPrompt — evidenceNote 는 의도와 분리된 증거 섹션으로 리뷰어에게 간다', () => {
    const p = buildReviewPrompt({ prDiff: '+x', phaseIntent: '기능 구현', evidenceNote: '## Gate execution evidence\nRan 6 tests across 1 file\n0 fail' });
    expect(p).toContain('## Evidence');
    expect(p).toContain('## Gate execution evidence');
    expect(p).toContain('Ran 6 tests across 1 file');
  });
  it('buildReviewPrompt — reviewerContext는 의도·증거와 별도 절에서 제공 순서를 보존한다', () => {
    const p = buildReviewPrompt({
      prDiff: '+x', phaseIntent: '의도 전용', evidenceNote: '증거 전용',
      reviewerContext: [
        { label: 'first.md', body: '첫 번째 파일' },
        { label: 'provided text', body: '두 번째 텍스트' },
        { label: 'last.md', body: '세 번째 파일' },
      ],
    });
    expect(p).toContain('## Phase intent\n의도 전용');
    expect(p).toContain('## Evidence\n증거 전용');
    expect(p).toContain('## Reviewer-provided context (3 fully included, 0 truncated, 0 omitted)');
    expect(p.indexOf('### first.md')).toBeLessThan(p.indexOf('### provided text'));
    expect(p.indexOf('### provided text')).toBeLessThan(p.indexOf('### last.md'));
  });
  it('budgetReviewerContext — 큰 참고 파일은 앞·생략 표식·뒤쪽 변경 구역을 함께 보존한다', () => {
    const body = `IMPORT_BLOCK\n${'middle context\n'.repeat(1_000)}CHANGED_REGION_AT_TAIL`;
    const budget = budgetReviewerContext([{ label: 'large.ts', body }]);

    expect(budget).toMatchObject({ itemCount: 1, truncated: true, fullyIncludedItems: 0, truncatedItems: 1, omittedItems: 0 });
    expect(budget.text).toContain('IMPORT_BLOCK');
    expect(budget.text).toContain('CHANGED_REGION_AT_TAIL');
    expect(budget.text).toMatch(/\.\.\. \[\d+ chars omitted from reviewer context item\] \.\.\./);
    expect(budget.shownChars).toBe(budget.text.length);
    expect(budget.text.length).toBeLessThanOrEqual(12_000);
  });
  it('budgetReviewerContext — 큰 앞 항목이 짧은 뒤 항목을 밀어내지 않고 실제 포함 상태를 고지한다', () => {
    const items = [{ label: 'large', body: 'x'.repeat(12_001) }, { label: 'short', body: 'short context survives' }];
    const budget = budgetReviewerContext(items);
    expect(budget).toMatchObject({ itemCount: 2, truncated: true, fullyIncludedItems: 1, truncatedItems: 1, omittedItems: 0 });
    expect(budget.text).toContain('... [');
    expect(budget.text).toContain('short context survives');
    expect(budget.shownChars).toBe(budget.text.length);
    expect(budget.text.length).toBeLessThanOrEqual(12_000);
  });
  it('budgetReviewerContext — 예산 안의 작은 본문은 전량과 계량을 그대로 보존한다', () => {
    const body = 'unknown-source text stays whole';
    const budget = budgetReviewerContext([{ label: 'provided text', body }]);

    expect(budget).toMatchObject({ text: `### provided text\n${body}`, truncated: false, fullyIncludedItems: 1, truncatedItems: 0, omittedItems: 0 });
    expect(budget.shownChars).toBe(budget.text.length);
    expect(budget.totalChars).toBe(budget.text.length);
  });
  it('budgetReviewerContext — 극소 항목 예산도 상한을 넘거나 예외를 던지지 않는다', () => {
    const budget = budgetReviewerContext([{ label: 'a', body: 'x'.repeat(1_000) }], 12);

    expect(budget.text.length).toBeLessThanOrEqual(12);
    expect(budget.shownChars).toBe(budget.text.length);
    expect(budget).toMatchObject({ truncated: true });
  });
  it('budgetReviewerContext — 여러 잘린 항목도 전체 예산 안에서 각각 앞·뒤를 보존한다', () => {
    const items = [
      { label: 'first.ts', body: `FIRST_HEAD${'x'.repeat(20_000)}FIRST_TAIL` },
      { label: 'second.ts', body: `SECOND_HEAD${'y'.repeat(20_000)}SECOND_TAIL` },
    ];
    const budget = budgetReviewerContext(items);

    expect(budget).toMatchObject({ truncated: true, truncatedItems: 2, fullyIncludedItems: 0, omittedItems: 0 });
    expect(budget.text).toContain('FIRST_TAIL');
    expect(budget.text).toContain('SECOND_TAIL');
    expect(budget.text.length).toBeLessThanOrEqual(12_000);
    expect(budget.shownChars).toBe(budget.text.length);
  });
  it('budgetReviewerContext — 작은 두 항목 뒤의 큰 184개도 회수 예산으로 다시 그린다', () => {
    const small = [{ label: 'small-a', body: 'ok' }, { label: 'small-b', body: 'ok' }];
    const large = Array.from({ length: 184 }, (_, index) => ({ label: `large-${index}`, body: 'x'.repeat(11_000) }));
    const budget = budgetReviewerContext([...small, ...large]);

    expect(budget).toMatchObject({ itemCount: 186, fullyIncludedItems: 2, truncatedItems: 2, omittedItems: 182, truncated: true });
    expect(budget.shownChars).toBeGreaterThanOrEqual(6_000);
    expect(budget.shownChars).toBeLessThanOrEqual(12_000);
  });
  it('budgetReviewerContext — 큰 186개만 있어도 회수 예산으로 생략분을 다시 그린다', () => {
    const items = Array.from({ length: 186 }, (_, index) => ({ label: `large-${index}`, body: 'x'.repeat(11_000) }));
    const budget = budgetReviewerContext(items);

    expect(budget).toMatchObject({ itemCount: 186, fullyIncludedItems: 1, truncatedItems: 0, omittedItems: 185, truncated: true });
    expect(budget.shownChars).toBeGreaterThanOrEqual(6_000);
    expect(budget.shownChars).toBeLessThanOrEqual(12_000);
  });
  it('budgetReviewerContext — 큰 다섯 항목의 기존 leftover 회수를 보존한다', () => {
    const items = Array.from({ length: 5 }, (_, index) => ({ label: `large-${index}`, body: 'x'.repeat(11_000) }));
    const budget = budgetReviewerContext(items);

    expect(budget).toMatchObject({ itemCount: 5, fullyIncludedItems: 0, truncatedItems: 5, omittedItems: 0, truncated: true });
    expect(budget.shownChars).toBeGreaterThanOrEqual(11_000);
    expect(budget.shownChars).toBeLessThanOrEqual(12_000);
  });
  it('budgetReviewerContext — 처음 몫에 못 담긴 항목의 leftover를 나머지 항목에 쓴다', () => {
    const items = [
      { label: 'x'.repeat(100), body: 'omitted' },
      { label: 'first', body: 'A'.repeat(2_000) },
      { label: 'second', body: 'B'.repeat(2_000) },
    ];
    const budget = budgetReviewerContext(items, 300);

    expect(budget).toMatchObject({ itemCount: 3, fullyIncludedItems: 0, truncatedItems: 2, omittedItems: 1, truncated: true });
    expect(budget.shownChars).toBeGreaterThan(200);
    expect(budget.text).toContain('### first');
    expect(budget.text).toContain('### second');
    expect(budget.text).toMatch(/\.\.\. \[\d+ chars omitted from reviewer context item\] \.\.\./);
    expect(budget.shownChars).toBeLessThanOrEqual(300);
  });
  it('budgetReviewerContext — 항목에 표지조차 담지 못해도 회수 예산으로 순서대로 채운다', () => {
    const items = Array.from({ length: 2_000 }, (_, index) => ({ label: `item-${index}`, body: 'x' }));
    const budget = budgetReviewerContext(items);
    expect(budget).toMatchObject({ itemCount: 2_000, fullyIncludedItems: 757, truncatedItems: 0, omittedItems: 1_243, truncated: true });
    expect(budget.text).toHaveLength(12_000);
  });
  it('buildReviewPrompt — G3 스코프 규율(dead/unused·scope creep) 명시', () => {
    const p = buildReviewPrompt({ prDiff: '+x', phaseIntent: 'helper' });
    expect(p).toContain('DEAD/UNUSED');
    expect(p).toContain('SCOPE CREEP');
    expect(p).toContain('dead/unused additions'); // FAIL 어휘에 포함
  });
  it('buildReviewPrompt — 기존 9개 규칙·응답 계약을 보존하고 GOODHART PASSING PROOF를 제10 항목으로 추가한다', () => {
    const p = buildReviewPrompt({ prDiff: '+x', phaseIntent: 'helper' });
    // ⛔⭐ 규칙 «구역»만 센다 — 프롬프트 전체를 세면 diff·intent 안의 `(1)` 까지 걸린다.
    //    📏 실측(2026-09-01 · 리뷰 watch item 을 받아 재봄):
    //      diff 에 `(1) (2) (3)` · intent 에 `(4)` 를 넣으면  전체자 10 → ***14*** (오탐)
    //      ⊕ 대안으로 시도한 `^\(\d+\)` 는 ***5*** 를 냈다 — 규칙 1~5 가 «한 줄»에 산문으로 있어 «미탐»이다.
    //      ⇒ 좁히는 축은 「줄머리」가 아니라 ***「규칙 구역」***이었다. 두 자를 눌러 보고 골랐다.
    const rulesRegion = p.slice(0, p.indexOf('Do NOT rubber-stamp'));
    const checklist = rulesRegion.match(/\(\d+\)/g) ?? [];
    expect(checklist).toHaveLength(10);
    expect(p).toContain('delivers the phase intent CORRECTLY and soundly: (1) correctness/latent bugs, (2) does it meet the stated\nacceptance criteria, (3) design/regression risk, (4) missing wiring (new code never called), (5) tests present\nand honest (no Goodhart),');
    expect(p).toContain('(6) DEAD/UNUSED additions: any new export, env var, field, constant, or function that NOTHING in the diff or\n    codebase consumes = FAIL (wire it or delete it — do not ship speculative/unused surface),');
    expect(p).toContain('(7) SCOPE CREEP: changes materially beyond the stated intent (unrequested refactors, extra features, contract\n    changes to shared functions not needed by the goal) — surface explicitly; FAIL if risky/unwarranted, else WARN.');
    expect(p).toContain('(8) TEST SIDE EFFECTS: when test files change alongside non-test repository files, determine whether those files are');
    expect(p).toContain('check literal repository paths in tests, injected stubs for functions that write them,');
    expect(p).toContain('and whether those path files changed in the same diff. A path the phase intent names as "이 런의 골 문서" is excluded from this');
    expect(p).toContain('test-side-effect/source suspicion only; still review that goal document\'s content for scope and correctness. If you cannot determine this, do not PASS; report the concern.');
    expect(p).toContain('(9) UNKNOWN-DEFAULT OUTPUT ASSERTION:');
    expect(p).toContain('Label every\n    such finding "UNKNOWN-DEFAULT OUTPUT ASSERTION"');
    expect(p).toContain('preserve unknown, require the value, or answer only\n    for callers that know it');
    expect(p).toContain('Do not report ordinary defaults or values that remain internal and are never surfaced in output.');
    expect(p).toContain('(10) GOODHART PASSING PROOF:');
    expect(p).toContain('First line EXACTLY one of: VERDICT: PASS | VERDICT: WARN | VERDICT: FAIL.');
    expect(p).toContain('"MUST-FIX:" followed by blocker findings');
    expect(p).toContain('"SHOULD-FIX:" followed by non-blocker findings');
  });
  it('buildReviewPrompt — Goodhart 지적 시에만 같은 줄에 통과 증명·관측 위치를 적으라고 하며 세 예시를 든다', () => {
    const p = buildReviewPrompt({ prDiff: '+x', phaseIntent: 'helper' });
    expect(p).toContain('(10) GOODHART PASSING PROOF: apply only when you identify Goodhart — not for ordinary must-fix findings.');
    expect(p).toContain('On that same finding line, state what would pass: one concrete observation and where to see it.');
    expect(p).toContain('run the real entrypoint and assert runtime output this change did not author');
    expect(p).toContain('force the call site to fail');
    expect(p).toContain('the error names that site');
    expect(p).toContain('use values the real caller produces instead of synthetic input');
  });
  it('renderReview — fail=must/should·pass=통과', () => {
    expect(renderReview({ verdict: 'fail', mustFix: ['미배선'], shouldFix: [] })).toContain('⛔');
    expect(renderReview({ verdict: 'pass', mustFix: [], shouldFix: [] })).toContain('리뷰 통과');
  });
});

describe('diff 예산 절단 — 파일별 head/tail·≤ limit 하드 보장', () => {
  const fileDiff = (path: string, n: number) => `diff --git a/${path} b/${path}\n@@\n` + Array.from({ length: n }, (_, i) => `+line ${i} of ${path}`).join('\n') + '\n';

  it('splitDiffByFile — diff --git 경계 분할', () => {
    expect(splitDiffByFile(fileDiff('a.ts', 2) + fileDiff('b.ts', 2))).toHaveLength(2);
  });
  it('budgetFileDiff — 초과 시 head+tail(후반 hunk 보존)', () => {
    const b = budgetFileDiff(fileDiff('big.ts', 200), 600);
    expect(b).toContain('line 0 of big.ts');
    expect(b).toContain('line 199 of big.ts');
    expect(b).toContain('omitted mid-file');
  });
  it('budgetedDiff — 한도 이내는 원본·정직 계량을 그대로 보존한다', () => {
    const diff = fileDiff('small.ts', 2);
    const r = budgetedDiff(diff, 2000);
    expect(r).toMatchObject({ text: diff, truncated: false, files: 1, shownChars: diff.length, totalChars: diff.length, omittedFiles: 0 });
    expect(r.shownChars).toBe(r.text.length);
    expect(r.truncated).toBe(r.shownChars < r.totalChars);
  });
  it('★ budgetedDiff — 작은 파일 多(초대형) → 실제 파일 누락·정직 계량', () => {
    const many = Array.from({ length: 20 }, (_, i) => fileDiff(`f${i}.ts`, 2)).join('');
    const r = budgetedDiff(many, 1000);
    expect(r.text.length).toBeLessThanOrEqual(1000);
    expect(r.files).toBe(20);
    expect(r.omittedFiles).toBe(17);
    expect(r.text).toContain('more changed file(s) omitted');
    expect(r.shownChars).toBe(r.text.length);
    expect(r.totalChars).toBe(many.length);
    expect(r.truncated).toBe(r.shownChars < r.totalChars);
  });
  it('diffSection — 절단 시 실제 시청량·unverified 계약을 고지한다', () => {
    const diff = fileDiff('a.ts', 300) + fileDiff('b.ts', 300);
    const s = diffSection(diff, 2000).join('\n');
    const r = budgetedDiff(diff, 2000);
    expect(s).toContain(`budget-truncated: ${r.shownChars}/${r.totalChars} chars shown`);
    expect(s).toMatch(/chars shown, \d+%/);
    expect(s).toContain('SHOULD-FIX as unverified (could not see)');
    expect(s).toContain('MUST-FIX only for findings with concrete visible evidence');
    expect(s).toContain('EVERY changed file is represented');
  });
  it('diffSection — 파일 완전 누락 시 거짓 대표성 문구 대신 누락 수를 고지한다', () => {
    const diff = Array.from({ length: 20 }, (_, i) => fileDiff(`f${i}.ts`, 2)).join('');
    const s = diffSection(diff, 1000).join('\n');
    expect(s).toContain('17 files entirely omitted');
    expect(s).not.toContain('EVERY changed file is represented');
  });
  it('diffSection — 0/32,000 절단은 0%로 표시한다', () => {
    const diff = 'x'.repeat(32_000);
    const s = diffSection(diff, 0).join('\n');
    expect(diffShownPercent(0, 32_000)).toBe(0);
    expect(s).toContain('budget-truncated: 0/32000 chars shown, 0%');
  });
  it('diffSection — 31,999/32,000 절단은 100%로 오표시하지 않는다', () => {
    expect(diffShownPercent(31_999, 32_000)).toBe(99);
    const s = diffSection('x'.repeat(32_000), 31_999).join('\n');
    expect(s).toContain('chars shown, 99%');
    expect(s).not.toContain('chars shown, 100%');
  });
  it('diffSection — 32,000/32,000 비절단 출력은 종전과 동일하다', () => {
    const diff = 'x'.repeat(32_000);
    expect(diffSection(diff, 32_000)).toEqual(['## PR diff', diff]);
  });
});

// ─── P4b — 이미지가 «리뷰어까지» 간다 (배선 판별력 · 2026-08-07) ───────────────
//
// ⛔ `#7486` 리뷰 must-fix: "①~④ 배선을 검증하는 테스트가 없다 — reader sniff 만 확인한다".
//   옳은 지적이다. 층을 다 고쳐도 «한 층이 인자를 떨어뜨리면» 아무것도 안 간다
//   (실제로 `index.ts` 래퍼가 그랬고, 관측 0 으로만 잡혔다).
describe('reviewPullRequest — 이미지 컨텍스트 전달(P4b)', () => {
  const input = (items: ReviewerContextItem[]): ReviewInput => ({
    prDiff: 'diff --git a/x b/x\n+1\n',
    phaseIntent: 'test',
    reviewerContext: items,
  } as ReviewInput);

  it('image 가 실린 항목은 두 번째 인자로 «따로» 간다 — 프롬프트 문자열엔 base64 가 없다', async () => {
    let seenPrompt = '';
    let seenImages: readonly { label: string; mimeType: string; data: string }[] | undefined;
    await reviewPullRequest(
      input([
        { label: 'note.md', body: '텍스트' },
        { label: 'shot.png', body: '[image image/png · 9 bytes]', image: { mimeType: 'image/png', data: 'QUJDREVGRw==' } },
      ]),
      async (prompt, images) => { seenPrompt = prompt; seenImages = images; return '✅ PASS'; },
    );
    expect(seenImages).toHaveLength(1);
    expect(seenImages![0]).toEqual({ label: 'shot.png', mimeType: 'image/png', data: 'QUJDREVGRw==' });
    // ⛔ 판별력 — base64 가 프롬프트에 «새면» 예산을 먹고 모델은 이미지로 못 본다.
    expect(seenPrompt).not.toContain('QUJDREVGRw==');
    // 텍스트 항목은 종전대로 프롬프트에 실린다(회귀 방어).
    expect(seenPrompt).toContain('note.md');
  });

  it('이미지가 없으면 두 번째 인자는 undefined 다 (빈 배열을 억지로 안 만든다)', async () => {
    let seenImages: unknown = 'unset';
    await reviewPullRequest(
      input([{ label: 'note.md', body: '텍스트' }]),
      async (_prompt, images) => { seenImages = images; return '✅ PASS'; },
    );
    expect(seenImages).toBeUndefined();
  });
});

// ─── P4b — 이미지 «개수·총량» 상한 (#7486 재리뷰 must-fix) ────────────────────
describe('capReviewImages — 전송량 상한', () => {
  const img = (label: string, bytes: number) => ({ label, mimeType: 'image/png', data: 'A'.repeat(Math.ceil(bytes * 4 / 3)) });

  it('⛔ 개수 상한 — --context 를 반복해도 4개까지만 간다', () => {
    const many = Array.from({ length: 9 }, (_, i) => img(`a${i}.png`, 1_000));
    const { kept, dropped } = capReviewImages(many);
    expect(kept).toHaveLength(4);
    expect(kept.map((k) => k.label)).toEqual(['a0.png', 'a1.png', 'a2.png', 'a3.png']);
    // ⭐ 잘라 낸 수를 «값으로» 돌려준다 — 조용히 줄이면 누락이 영영 안 보인다(#7486).
    expect(dropped).toBe(5);
  });

  it('⛔ 총량 상한 — 개수가 남아도 총 바이트를 넘으면 멈춘다', () => {
    const { kept, dropped } = capReviewImages([img('big1.png', 7 * 1024 * 1024), img('big2.png', 7 * 1024 * 1024)]);
    // 7MB + 7MB = 14MB > 12MB ⇒ 두 번째는 안 간다(개수 상한 4 는 아직 여유가 있다).
    expect(kept).toHaveLength(1);
    expect(kept[0]!.label).toBe('big1.png');
    expect(dropped).toBe(1);
  });

  it('상한 안이면 전부 그대로 간다 (과잉 차단 없음)', () => {
    const { kept, dropped } = capReviewImages([img('a.png', 10), img('b.png', 10)]);
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(0);
  });
});

// ─── fail-soft 는 옳지만 «침묵하는» fail-soft 는 아니다 (2026-08-07) ──────────
describe('reviewPullRequest — 실패 이유 보존', () => {
  it('리뷰어가 던지면 verdict 는 fail-soft pass 지만 «이유»가 남는다', async () => {
    const result = await reviewPullRequest(
      { prDiff: 'diff --git a/x b/x\n+1\n', phaseIntent: 't' } as ReviewInput,
      async () => { throw new Error('Unknown ACP backend "claude-code". Known: claude, gemini'); },
    );
    expect(result.reviewed).toBe(false);
    expect(result.verdict).toBe('pass');   // fail-soft 계약 보존
    // ⛔ 이 단언이 없으면 맨 catch 로 되돌아가도 아무것도 안 깨진다(#7480/#7486 에서 배운 형태).
    expect(result.failureReason).toContain('Unknown ACP backend');
  });

  it.each([
    ['Error', new Error('ACP unavailable'), 'ACP unavailable'],
    ['JSON-RPC 오류 객체', { code: -32602, message: 'Invalid params' }, '-32602: Invalid params'],
    ['문자열', 'Authentication required', 'Authentication required'],
  ])('%s rejection은 사람이 읽는 한 줄 failureReason으로 정규화한다', async (_kind, rejection, expected) => {
    const result = await reviewPullRequest(
      { prDiff: 'd', phaseIntent: 't' } as ReviewInput,
      async () => { throw rejection; },
    );
    expect(result).toMatchObject({ reviewed: false, failureReason: expected });
    expect(result.failureReason).not.toBe('[object Object]');
    expect(result.failureReason).not.toContain('\n');
  });

  it('⛔ 리뷰어 «미주입»은 실패가 아니라 미검토다 — 이유를 안 채운다', async () => {
    const result = await reviewPullRequest({ prDiff: 'd', phaseIntent: 't' } as ReviewInput, undefined);
    expect(result.reviewed).toBe(false);
    expect(result.failureReason).toBeUndefined();
  });
});

describe('reviewPullRequest — 실패 이유 «마스킹»', () => {
  it('⛔ 오류 메시지 속 비밀값은 원본에서 가려진다 (--json 유출 방지)', async () => {
    const result = await reviewPullRequest(
      { prDiff: 'd', phaseIntent: 't' } as ReviewInput,
      async () => { throw new Error('auth failed: token sk-abcdefghijklmnopqrstuvwxyz012345'); },
    );
    expect(result.failureReason).toBeDefined();
    // ⛔ 이 단언이 없으면 마스킹을 빼도 안 깨진다 — failureReason 은 --json 의 ...review 로 그대로 나간다.
    expect(result.failureReason).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });
});


// ── 분할 리뷰(2026-08-19) — 「예산을 넘으면 버린다」에서 「나눠서 다 본다」로 ──────────────
//
// 🚨 왜 이 계약이 있나: 리뷰가 diff 의 18%만 보고 `pass` 를 냈고 병합 게이트가 옳게 막아
//   ***성공한 런이 원리상 착지할 수 없었다***(북극성 조각 ⓪ · 283,155자 중 52,000자).

const file = (name: string, body: string): string =>
  `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${body}\n`;

describe('planReviewChunks — 나눠서 «다 보는» 계획', () => {
  it('예산 안에 들어가면 한 패스이고 전부 덮는다', () => {
    const diff = file('a.ts', '+one') + file('b.ts', '+two');
    const plan = planReviewChunks(diff, 10_000, 6);
    expect(plan.passes).toHaveLength(1);
    expect(plan.coversAll).toBe(true);
    expect(plan.omittedFiles).toBe(0);
    expect(plan.coveredChars).toBe(diff.length);
  });

  it('⭐ 예산을 넘으면 «파일 경계»로 갈라 여러 패스가 되고, 그래도 전부 덮는다', () => {
    const diff = file('a.ts', '+' + 'x'.repeat(400))
      + file('b.ts', '+' + 'y'.repeat(400))
      + file('c.ts', '+' + 'z'.repeat(400));
    const plan = planReviewChunks(diff, 500, 6);
    expect(plan.passes.length).toBeGreaterThan(1);
    expect(plan.coversAll).toBe(true);          // ← 이것이 이 기능의 존재 이유다
    expect(plan.omittedFiles).toBe(0);
    expect(plan.coveredChars).toBe(diff.length);
    for (const pass of plan.passes) expect(pass.length).toBeLessThanOrEqual(500);
  });

  it('⛔ 파일 «하나»가 예산보다 크면 절단되고 coversAll 이 false 로 남는다', () => {
    const diff = file('huge.ts', '+' + 'x'.repeat(5000));
    const plan = planReviewChunks(diff, 500, 6);
    expect(plan.oversizedFiles).toBe(1);
    expect(plan.coversAll).toBe(false);         // ← 상한 회피가 «아니다»
  });

  it('⛔ 패스 상한에 걸리면 «조용히» 덜 보지 않는다 — droppedByCap 이 값이 되고 coversAll=false', () => {
    const diff = Array.from({ length: 8 }, (_, i) => file(`f${i}.ts`, '+' + 'x'.repeat(400))).join('');
    const plan = planReviewChunks(diff, 500, 2);
    expect(plan.passes).toHaveLength(2);
    expect(plan.droppedByCap).toBeGreaterThan(0);
    expect(plan.coversAll).toBe(false);
    expect(plan.omittedFiles).toBeGreaterThan(0);
  });

  it('빈 diff 는 패스 0 이고 전부 덮은 것으로 본다', () => {
    const plan = planReviewChunks('', 500, 6);
    expect(plan.passes).toHaveLength(0);
    expect(plan.coversAll).toBe(true);
  });
});

describe('foldReviewResults — 접는 규칙', () => {
  const r = (over: Partial<Parameters<typeof foldReviewResults>[0][number]> = {}) =>
    ({ verdict: 'pass' as const, mustFix: [], shouldFix: [], reviewed: true, ...over });

  it('⭐ 하나라도 fail 이면 fail — 다수결이 «아니다»', () => {
    expect(foldReviewResults([r(), r(), r({ verdict: 'fail', mustFix: ['널 역참조'] })]).verdict).toBe('fail');
  });

  it('warn 도 전파한다 (fail 이 없을 때)', () => {
    expect(foldReviewResults([r(), r({ verdict: 'warn' })]).verdict).toBe('warn');
  });

  it('⭐ 한 패스라도 못 돌았으면 reviewed=false — 그 조각을 «안 본» 것이다', () => {
    const folded = foldReviewResults([r(), r({ reviewed: false, failureReason: '제공자 과부하' })]);
    expect(folded.reviewed).toBe(false);
    expect(folded.failureReason).toBe('제공자 과부하');
  });

  it('지적은 순서 보존 ⊕ 정확 중복 제거 ⊕ 상한 6', () => {
    const folded = foldReviewResults([
      r({ verdict: 'fail', mustFix: ['A', 'B'] }),
      r({ verdict: 'fail', mustFix: ['B', 'C'] }),
    ]);
    expect(folded.mustFix).toEqual(['A', 'B', 'C']);
  });

  it('빈 목록은 reviewed=false — 「아무것도 안 돌았다」를 pass 로 꾸미지 않는다', () => {
    expect(foldReviewResults([]).reviewed).toBe(false);
  });
});

describe('reviewPullRequest — 분할 리뷰 배선', () => {
  it('⭐ 예산 초과 diff 를 여러 번 리뷰하고, 전부 봤으면 truncated=false 로 낸다', async () => {
    // ⚠️ reviewDiffCharLimit() 은 최소 2000 이 바닥이다 — 그 아래를 주면 «기본값으로 되돌아간다».
    const diff = Array.from({ length: 4 }, (_, i) => file(`f${i}.ts`, '+' + 'x'.repeat(800))).join('');
    const prev = process.env.ELANOUS_PR_REVIEW_DIFF_CHARS;
    process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = '2000';
    try {
      const seen: string[] = [];
      const result = await reviewPullRequest(
        { prDiff: diff, phaseIntent: '테스트' },
        async (prompt) => { seen.push(prompt); return 'VERDICT: PASS'; },
      );
      expect(seen.length).toBeGreaterThan(1);            // 여러 번 불렸다
      expect(result.reviewed).toBe(true);
      expect(result.diffBudget?.truncated).toBe(false);  // ← 병합 게이트가 더 이상 막지 않는다
      expect(result.diffBudget?.totalChars).toBe(diff.length);
      expect(result.diffBudget?.shownChars).toBe(diff.length);
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_PR_REVIEW_DIFF_CHARS;
      else process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = prev;
    }
  });

  it('⛔ 조각 리뷰어에게 「몇 분의 몇을 보는지」를 알린다 — 없으면 SCOPE 규칙이 오작동한다', async () => {
    // ⚠️ reviewDiffCharLimit() 은 최소 2000 이 바닥이다 — 그 아래를 주면 «기본값으로 되돌아간다».
    const diff = Array.from({ length: 4 }, (_, i) => file(`f${i}.ts`, '+' + 'x'.repeat(800))).join('');
    const prev = process.env.ELANOUS_PR_REVIEW_DIFF_CHARS;
    process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = '2000';
    try {
      const seen: string[] = [];
      await reviewPullRequest(
        { prDiff: diff, phaseIntent: '테스트' },
        async (prompt) => { seen.push(prompt); return 'VERDICT: PASS'; },
      );
      expect(seen[0]).toContain('조각');
      expect(seen[0]).toMatch(/1번째 조각/);
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_PR_REVIEW_DIFF_CHARS;
      else process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = prev;
    }
  });

  it('한 패스로 충분하면 종전 경로 그대로 — 한 번만 부른다', async () => {
    let calls = 0;
    const result = await reviewPullRequest(
      { prDiff: file('a.ts', '+one'), phaseIntent: '테스트' },
      async () => { calls += 1; return 'VERDICT: PASS'; },
    );
    expect(calls).toBe(1);
    expect(result.diffBudget?.truncated).toBe(false);
  });
});

describe('reviewMaxPasses — 상한 계약', () => {
  it('기본 6 · env override · 1 미만은 무시', () => {
    const prev = process.env.ELANOUS_PR_REVIEW_MAX_PASSES;
    try {
      delete process.env.ELANOUS_PR_REVIEW_MAX_PASSES;
      expect(reviewMaxPasses()).toBe(6);
      process.env.ELANOUS_PR_REVIEW_MAX_PASSES = '3';
      expect(reviewMaxPasses()).toBe(3);
      process.env.ELANOUS_PR_REVIEW_MAX_PASSES = '0';
      expect(reviewMaxPasses()).toBe(6);
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_PR_REVIEW_MAX_PASSES;
      else process.env.ELANOUS_PR_REVIEW_MAX_PASSES = prev;
    }
  });
});

describe('renderReview — 리뷰가 안 돈 결과', () => {
  it('reviewed=false 면 verdict 가 pass 여도 PASS·«지적 없음» 을 쓰지 않고 사유를 쓴다', () => {
    const body = renderReview({ verdict: 'pass', mustFix: [], shouldFix: [], reviewed: false, failureReason: 'Codex overloaded' });
    expect(body).toBe('⚠️ 자율 PR 리뷰: 리뷰 안 돎 — 사유 Codex overloaded (통과 판정 아님)');
    expect(body).not.toContain('PASS');
    expect(body).not.toContain('지적 없음');
  });
  it('reviewed 가 없거나 true 면 지금 렌더 그대로', () => {
    expect(renderReview({ verdict: 'pass', mustFix: [], shouldFix: [] })).toContain('자율 PR 리뷰: PASS');
    expect(renderReview({ verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true })).toContain('자율 PR 리뷰: PASS');
  });
});
