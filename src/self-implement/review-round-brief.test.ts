import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { buildReviewRoundBrief, classifyReviewFinding, loadReviewRoundBrief, renderReviewBriefIntentBlock, reviewBriefEvidence, REVIEW_BRIEF_INTENT_MAX_CHARS, type ReviewBriefInput } from './review-round-brief.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function input(overrides: Partial<ReviewBriefInput> = {}): ReviewBriefInput {
  const head = 'a'.repeat(40);
  return {
    pr: 42, head,
    body: 'Core contract: replay validates the complete one-file Job reference and records the verdict.',
    changedFiles: ['scripts/release-loop/gate-node.ts', 'scripts/release-loop/gate-node.test.ts'],
    results: [{ path: '/r1.json', mtimeMs: 1, value: { pr: '42', headCommit: head, reviewed: true, mustFix: ['gate-node.test.ts acceptance criteria must match the contract'] } }],
    ...overrides,
  };
}

describe('review-round-brief', () => {
  test('counts distinct reviewed heads, selects current head and caps core findings at five', () => {
    const base = input({ body: '## Q\nCan replay a complete one-file Job reference?\n\n## A\n- The `gate-v1` replay request is checked against the Job identity. Matched results finalize the lease; mismatch and uncertain results quarantine it. Missing reference and transition failures enter `warmShadow`; Job remains authoritative.' });
    const results = Array.from({ length: 7 }, (_, i) => ({
      path: `/r${i}.json`, mtimeMs: i,
      value: { pr: '42', headCommit: i === 1 ? 'b'.repeat(40) : base.head, reviewed: true, mustFix: [`finding-${i}`] },
    }));
    const brief = buildReviewRoundBrief({ ...base, results });
    expect(brief.rounds).toBe(2);
    expect(brief.status).toBe('ready');
    expect(brief.coreItems).toHaveLength(1);
    expect(brief.coreItems[0]?.text).toBe('finding-6');
    expect(brief.priorFindings.map((item) => item.text)).toEqual(['finding-1']);
    expect(brief.coreItems[0]?.id).toBe(`42:${base.head}:mustFix:1`);
    expect(brief.goalQuestion).toContain('complete one-file Job reference');
    expect(brief.acceptanceSignal).toContain('The `gate-v1` replay request is checked against the Job identity. Matched results finalize the lease; mismatch and uncertain results quarantine it. Missing reference and transition failures enter `warmShadow`; Job remains authoritative.');
    expect(renderReviewBriefIntentBlock(brief)).toContain('런 닥터 brief · PR #42');
  });

  test('keeps ambiguous items in core so an unclassified must-fix forces continue', () => {
    const base = input();
    const brief = buildReviewRoundBrief({ ...base, results: [
      { path: '/prior.json', mtimeMs: 1, value: { pr: '42', headCommit: 'b'.repeat(40), reviewed: true, mustFix: [] } },
      { path: '/r9.json', mtimeMs: 9, value: { pr: '42', headCommit: base.head, reviewed: true, mustFix: [
        'weak JUnit evidence is absent from the verdict',
        'late lease timeout must fence and quarantine the worker',
        'mysterious behavior needs attention',
      ] } },
    ] });
    expect(brief.rx).toBe('continue');
    expect(brief.coreItems.map((item) => item.kind)).toEqual(['b', 'c', 'unclassified']);
    expect(brief.scopeItems.map((item) => item.kind)).toEqual(['b', 'c']);
    expect(brief.scopeBoundary).toContain('FU 후보');
    expect(brief.scopeBoundary).toContain('주인·칸');
    const rendered = renderReviewBriefIntentBlock(brief)!;
    expect(rendered).toContain('FU 후보 (2/2):');
    expect(rendered).toContain('weak JUnit evidence is absent from the verdict');
    expect(rendered).toContain('late lease timeout must fence and quarantine the worker');
  });

  test('does not treat absent or stale saved reviews as zero findings', () => {
    const base = input({ results: [] });
    expect(buildReviewRoundBrief(base)).toMatchObject({ status: 'unmeasured', rounds: 0, currentHeadMeasured: false });
    const stale = buildReviewRoundBrief({ ...base, results: [{ path: '/old.json', mtimeMs: 1, value: {
      pr: '42', headCommit: 'b'.repeat(40), reviewed: true, mustFix: ['missing JUnit evidence in old head verdict'],
    } }] });
    expect(stale).toMatchObject({ status: 'stale', rounds: 1, currentHeadMeasured: false, rx: 'continue', coreItems: [], scopeItems: [], totalScopeItems: 0 });
    expect(stale.priorFindings.map((item) => item.text)).toEqual(['missing JUnit evidence in old head verdict']);
  });

  test('projects an explicit author split disposition without pretending the current head was reviewed', () => {
    const comment = 'OP: superseded by #29368 · 남은 범위 = WARM-POD-LATE-LEASE-FENCE-FU(0.2.35). r9 상한 초과로 분리.';
    const brief = buildReviewRoundBrief({ ...input({ results: [] }), comments: [comment] });
    expect(brief).toMatchObject({ source: 'pr-disposition', status: 'disposition-only', rounds: 0, currentHeadMeasured: false,
      reviewedVerdict: 'unknown', totalCoreItems: 1, omittedCoreItems: 0, rx: 'split', dispositionEvidence: comment });
    expect(brief.coreItems.map((item) => item.text)).toEqual(['WARM-POD-LATE-LEASE-FENCE-FU(0.2.35)']);
    expect(brief.resultPaths).toEqual([]);
    expect(brief.scopeBoundary).toContain('PR 작성자가 분리한 남은 범위');
    expect(brief.scopeBoundary).toContain('현재 head 리뷰의 판정으로 취급하지 않는다');
  });

  test('an author r99 comment cannot inflate measured rounds from saved reviewed heads', () => {
    const base = input({ results: [{ path: '/prior.json', mtimeMs: 1,
      value: { pr: 42, headCommit: 'b'.repeat(40), reviewed: true, mustFix: [] } }] });
    const brief = buildReviewRoundBrief({ ...base, comments: ['OP: 남은 범위 = follow-up. r99 상한 초과로 분리.'] });
    expect(brief).toMatchObject({ rounds: 1, status: 'disposition-only', rx: 'split', currentHeadMeasured: false });
    expect(buildReviewRoundBrief({ ...base, results: [], comments: ['OP: 남은 범위 = follow-up. r99 상한 초과로 분리.'] }).rounds).toBe(0);
  });

  test('unresolved core findings continue even when they map to independent FU categories', () => {
    const base = input({ body: '## A\n- Preserve the verdict.' });
    const results = (mustFix: string[]) => [{ path: '/review.json', mtimeMs: 1,
      value: { pr: 42, headCommit: base.head, reviewed: true, verdict: 'fail', mustFix } }];
    const split = buildReviewRoundBrief({ ...base, results: results(['missing JUnit evidence in gate verdict', 'late lease timeout race in worker']) });
    expect(split).toMatchObject({ status: 'ready', source: 'saved-review', rx: 'continue', reviewedRx: 'continue', totalCoreItems: 2 });
    expect(split.coreItems.map((item) => item.kind)).toEqual(['b', 'c']);
    expect(buildReviewRoundBrief({ ...base, results: results(['missing JUnit evidence in gate verdict', 'unclassified blocker']) }).rx).toBe('continue');
  });

  test('rejects non-explicit split language and prefers the saved current-head verdict over a disposition', () => {
    const comment = '남은 범위 = future task. r9 상한 초과로 분리.';
    const unmeasured = buildReviewRoundBrief({ ...input({ results: [] }), comments: ['r9 상한 초과로 분리.'] });
    expect(unmeasured).toMatchObject({ source: 'none', status: 'unmeasured', rounds: 0, rx: 'decision-card' });
    const reviewed = buildReviewRoundBrief({ ...input({ results: [{ path: '/saved.json', mtimeMs: 1,
      value: { pr: 42, headCommit: 'a'.repeat(40), reviewed: true, verdict: 'fail', mustFix: ['must fix'] } }] }), comments: [comment] });
    expect(reviewed).toMatchObject({ source: 'saved-review', status: 'ready', rounds: 1, rx: 'continue', totalCoreItems: 1 });
    expect(reviewed.dispositionEvidence).toBeUndefined();
  });

  test('keeps unresolved prior-head findings ahead of an author split disposition when current head is unreviewed', () => {
    const base = input({ results: [{ path: '/prior.json', mtimeMs: 1,
      value: { pr: 42, headCommit: 'b'.repeat(40), reviewed: true, verdict: 'fail', mustFix: ['old must fix'] } }] });
    const brief = buildReviewRoundBrief({ ...base, comments: ['OP: 남은 범위 = next task. r9 상한 초과로 분리.'] });
    expect(brief).toMatchObject({ source: 'saved-review', status: 'stale', rounds: 1, currentHeadMeasured: false,
      totalCoreItems: 0, rx: 'continue', reviewedHead: 'b'.repeat(40), reviewedVerdict: 'unknown' });
    expect(brief.coreItems).toEqual([]);
    expect(brief.priorFindings.map((item) => item.text)).toEqual(['old must fix']);
    expect(renderReviewBriefIntentBlock(brief)).toBeNull();
  });

  test('intent prescribes continue and includes older unresolved findings when newest stale review is empty', () => {
    const base = input({ head: 'c'.repeat(40), body: '## A\n- Preserve the measured acceptance.', results: [
      { path: '/older.json', mtimeMs: 1, value: { pr: 42, headCommit: 'a'.repeat(40), reviewed: true, verdict: 'fail', mustFix: ['older core finding remains unresolved'] } },
      { path: '/newest.json', mtimeMs: 2, value: { pr: 42, headCommit: 'b'.repeat(40), reviewed: true, verdict: 'pass', mustFix: [] } },
    ] });
    const brief = buildReviewRoundBrief(base);
    expect(brief).toMatchObject({ status: 'stale', rx: 'continue', reviewedRx: 'partial-land', totalPriorFindings: 1 });
    const intent = renderReviewBriefIntentBlock(brief)!;
    expect(intent).toContain('rx=continue');
    expect(intent).toContain('실제 처방: 현재 head 리뷰 전까지 과거 미해결 must-fix를 유지하고 계속 진행');
    expect(intent).toContain('older core finding remains unresolved');
    expect(intent).not.toContain('rx=partial-land');
  });

  test('a measured r9 author split sets split without erasing saved core findings', () => {
    const currentHead = 'a'.repeat(40);
    const results: ReviewBriefInput['results'] = Array.from({ length: 9 }, (_, index) => ({
      path: `/review-${index}.json`, mtimeMs: index,
      value: { pr: 42, headCommit: index === 8 ? currentHead : String(index + 1).repeat(40), reviewed: true, verdict: index === 8 ? 'fail' : 'pass',
        mustFix: index === 8 ? ['unresolved core finding'] : [] },
    }));
    const base = input({ body: '## A\n- Keep findings visible.', results,
      comments: ['OP: 남은 범위 = follow-up. r9 상한 초과로 분리.'] });
    const brief = buildReviewRoundBrief(base);
    expect(brief).toMatchObject({ status: 'ready', source: 'saved-review', rounds: 9, rx: 'split', totalCoreItems: 1,
      dispositionEvidence: base.comments![0] });
    expect(brief.coreItems.map((item) => item.text)).toEqual(['unresolved core finding']);
  });

  test('does not count a saved result that did not complete review', () => {
    const base = input({ results: [{ path: '/failed.json', mtimeMs: 1, value: {
      pr: 42, headCommit: 'a'.repeat(40), reviewed: false, verdict: 'pass', mustFix: [],
    } }] });
    expect(buildReviewRoundBrief(base)).toMatchObject({ status: 'unmeasured', rounds: 0, currentHeadMeasured: false, reviewedVerdict: 'unknown' });
  });

  test('does not count malformed current mustFix as an empty verified review', () => {
    const base = input();
    const brief = buildReviewRoundBrief({ ...base, results: [
      { path: '/malformed.json', mtimeMs: 1, value: { pr: base.pr, headCommit: base.head, reviewed: true, verdict: 'pass' } },
    ] });
    expect(brief).toMatchObject({ status: 'unmeasured', rounds: 0, currentHeadMeasured: false, reviewedVerdict: 'unknown', rx: 'decision-card' });
  });

  test('uses a path tie-break for latest cross-head result independent of input order', () => {
    const base = input();
    const sameTime = [
      { path: '/a-review.json', mtimeMs: 10, value: { pr: 42, headCommit: 'b'.repeat(40), reviewed: true, verdict: 'warn', mustFix: [] } },
      { path: '/z-review.json', mtimeMs: 10, value: { pr: 42, headCommit: 'c'.repeat(40), reviewed: true, verdict: 'fail', mustFix: ['stale head finding'] } },
    ];
    const first = buildReviewRoundBrief({ ...base, results: sameTime });
    const reversed = buildReviewRoundBrief({ ...base, results: [...sameTime].reverse() });
    expect(first.reviewedHead).toBe('c'.repeat(40));
    expect(reversed.reviewedHead).toBe(first.reviewedHead);
    expect(reversed.reviewedRx).toBe(first.reviewedRx);
  });

  test('uses the path tie-break for same-head files with identical mtimes', () => {
    const base = input();
    const results = [
      { path: '/a-same-head.json', mtimeMs: 20, value: { pr: 42, headCommit: base.head, reviewed: true, mustFix: ['earlier saved review'] } },
      { path: '/z-same-head.json', mtimeMs: 20, value: { pr: 42, headCommit: base.head, reviewed: true, mustFix: ['deterministic latest review'] } },
    ];
    const first = buildReviewRoundBrief({ ...base, results });
    const reversed = buildReviewRoundBrief({ ...base, results: [...results].reverse() });
    expect(first.coreItems[0]?.text).toBe('deterministic latest review');
    expect(reversed.coreItems[0]?.text).toBe(first.coreItems[0]?.text);
  });

  test('caps FU candidates while preserving every saved must-fix in the core count', () => {
    const base = input();
    const brief = buildReviewRoundBrief({ ...base, results: [
      { path: '/prior-empty.json', mtimeMs: 0, value: { pr: 42, headCommit: 'b'.repeat(40), reviewed: true, mustFix: [] } },
      { path: '/many-scope.json', mtimeMs: 1, value: { pr: 42, headCommit: base.head, reviewed: true, mustFix: Array.from({ length: 7 }, (_, index) => `missing JUnit evidence ${index + 1}`) } },
    ] });
    expect(brief).toMatchObject({ totalCoreItems: 7, omittedCoreItems: 2, totalScopeItems: 7, omittedScopeItems: 2, rx: 'continue' });
    expect(brief.coreItems).toHaveLength(5);
    expect(brief.scopeItems).toHaveLength(5);
    const rendered = renderReviewBriefIntentBlock(brief)!;
    expect(rendered).toContain('FU 후보 (5/7):');
    expect(rendered).toContain('FU 후보 2개 생략');
    expect(rendered).toContain('/many-scope.json');
  });

  test('renders the next R3 intent addendum from two prior distinct heads before the current head has a saved review', () => {
    const base = input();
    const results: ReviewBriefInput['results'] = ['b', 'c'].map((letter, index) => ({
      path: `/${letter}.json`, mtimeMs: index,
      value: { pr: '42', headCommit: letter.repeat(40), reviewed: true, mustFix: index === 1 ? ['late lease needs fencing'] : [] },
    }));
    const brief = buildReviewRoundBrief({ ...base, results });
    const rendered = renderReviewBriefIntentBlock(brief);
    expect(brief).toMatchObject({ rounds: 2, currentHeadMeasured: false, status: 'stale', rx: 'continue', reviewedRx: 'continue', reviewedHead: 'c'.repeat(40) });
    expect(rendered).toContain('prior head cccccccccccc');
    expect(rendered).toContain('rounds=2 · verdict=unknown · rx=continue');
    expect(rendered).toContain('late lease needs fencing');
    expect(rendered).toContain('의도적 스코프 경계:');
    expect(renderReviewBriefIntentBlock(buildReviewRoundBrief({ ...base, results: [results[0]!] }))).toBeNull();
  });

  test('classifies only explicit evidence and leaves ambiguous text unclassified', () => {
    const base = input();
    expect(classifyReviewFinding('missing JUnit evidence in gate verdict', base)).toBe('b');
    expect(classifyReviewFinding('late lease response needs fencing', base)).toBe('c');
    expect(classifyReviewFinding('new test file is needed', base)).toBe('unclassified');
    expect(classifyReviewFinding('late lease timeout needs fencing', base)).toBe('c');
    expect(classifyReviewFinding('worker record needs review', base)).toBe('unclassified');
    expect(classifyReviewFinding('unexpected behavior', base)).toBe('unclassified');
    expect(classifyReviewFinding('src/example.ts must retain JUnit evidence before pass', base)).toBe('b');
  });

  test('acceptance parsing keeps nested A headings and the card retains the current verdict', () => {
    const base = input({ body: '## Q\nCan the current question be preserved?\n\n## A\n- Top-level acceptance.\n\n### Runtime boundary\n- Nested acceptance remains part of A.\n\n## Follow-up\n- This is not acceptance.' });
    const brief = buildReviewRoundBrief({ ...base, results: [
      { path: '/prior.json', mtimeMs: 1, value: { pr: 42, headCommit: 'b'.repeat(40), reviewed: true, mustFix: [] } },
      { path: '/current.json', mtimeMs: 2, value: { pr: 42, headCommit: base.head, reviewed: true, verdict: 'warn', mustFix: [] } },
    ] });
    expect(brief.reviewedVerdict).toBe('warn');
    expect(brief.acceptanceSignal).toContain('Nested acceptance remains part of A.');
    expect(brief.acceptanceSignal).not.toContain('This is not acceptance.');
    expect(renderReviewBriefIntentBlock(brief)).toContain('verdict=warn');
  });

  test('parses titled SCQA headings and preserves the declared scope boundary in the rendered brief', () => {
    const base = input({ body: '## Q — 질문\nHow does this work?\n\n## A — 답\n- Keep the acceptance.\n\n### 경계\n- CLI 노출은 #29425 후속이다.\n- 실제 PR 적용은 이 PR에서 하지 않는다.' });
    const brief = buildReviewRoundBrief({ ...base, results: [
      { path: '/prior.json', mtimeMs: 1, value: { pr: 42, headCommit: 'b'.repeat(40), reviewed: true, mustFix: [] } },
      { path: '/current.json', mtimeMs: 2, value: { pr: 42, headCommit: base.head, reviewed: true, verdict: 'pass', mustFix: [] } },
    ] });
    const rendered = renderReviewBriefIntentBlock(brief)!;
    expect(brief.goalQuestion).toBe('How does this work?');
    expect(brief.acceptanceSignal).toContain('Keep the acceptance.');
    expect(brief.declaredScopeBoundary).toHaveLength(2);
    expect(rendered).toContain('How does this work?');
    expect(rendered).toContain('Keep the acceptance.');
    expect(rendered).toContain('CLI 노출은 #29425 후속이다.');
    expect(rendered).toContain('실제 PR 적용은 이 PR에서 하지 않는다.');
  });

  test('any remaining classified must-fix keeps the review direction at continue', () => {
    const base = input({ body: '## A\n- Acceptance exists.' });
    const brief = buildReviewRoundBrief({ ...base, results: [
      { path: '/prior.json', mtimeMs: 1, value: { pr: 42, headCommit: 'b'.repeat(40), reviewed: true, mustFix: [] } },
      { path: '/current.json', mtimeMs: 2, value: { pr: 42, headCommit: base.head, reviewed: true, verdict: 'pass', mustFix: ['missing JUnit evidence in the gate record'] } },
    ] });
    expect(brief.scopeItems.map((item) => item.kind)).toEqual(['b']);
    expect(brief.rx).toBe('continue');
  });

  test('shadow evidence retains the bounded prescription for observation storage', () => {
    const base = input({ body: '## Q\nWhy?\n\n## A\n- Preserve this acceptance.' });
    const brief = buildReviewRoundBrief({ ...base, results: [
      { path: '/prior.json', mtimeMs: 1, value: { pr: 42, headCommit: 'b'.repeat(40), reviewed: true, mustFix: [] } },
      { path: '/current.json', mtimeMs: 2, value: { pr: 42, headCommit: base.head, reviewed: true, verdict: 'warn', mustFix: ['unclassified finding'] } },
    ] });
    const event = reviewBriefEvidence(brief, 'run-12345678901234567890');
    expect(event).toMatchObject({
      runId: 'run-12345678901234567890', verdict: 'warn',
    });
    expect(event.intentBlock).toBe(renderReviewBriefIntentBlock(brief));
    expect((event.intentBlock as string).length).toBeLessThanOrEqual(REVIEW_BRIEF_INTENT_MAX_CHARS);
  });

  test('stale evidence does not attach a prior verdict to the current head key', () => {
    const base = input();
    const brief = buildReviewRoundBrief({ ...base, results: [
      { path: '/prior.json', mtimeMs: 1, value: { pr: 42, headCommit: 'b'.repeat(40), reviewed: true, verdict: 'fail', mustFix: ['old failure'] } },
      { path: '/older.json', mtimeMs: 2, value: { pr: 42, headCommit: 'c'.repeat(40), reviewed: true, verdict: 'pass', mustFix: [] } },
    ] });
    const event = reviewBriefEvidence(brief);
    expect(event).toMatchObject({ head: base.head, verdict: 'unknown', reviewedHead: 'c'.repeat(40), rx: 'continue' });
  });

  test('stale briefs prioritize the selected latest reviewed head findings over older rounds', () => {
    const base = input({ head: 'a'.repeat(40) });
    const brief = buildReviewRoundBrief({ ...base, results: [
      { path: '/older.json', mtimeMs: 1, value: { pr: 42, headCommit: 'b'.repeat(40), reviewed: true, mustFix: Array.from({ length: 6 }, (_, index) => `old finding ${index + 1}`) } },
      { path: '/latest.json', mtimeMs: 2, value: { pr: 42, headCommit: 'c'.repeat(40), reviewed: true, verdict: 'fail', mustFix: ['latest reviewed head finding'] } },
    ] });
    const rendered = renderReviewBriefIntentBlock(brief)!;
    expect(brief.priorFindings[0]?.text).toBe('latest reviewed head finding');
    expect(rendered).toContain('latest reviewed head finding');
    expect(rendered).toContain('현재 PR head 미측정');
    expect(rendered).not.toContain('현재 선택 head의 must-fix 없음');
  });

  test('intent block bounds large acceptance text, finding text, and source paths while preserving omission references', () => {
    const base = input({
      body: `## Q\n${'question '.repeat(100)}\n\n## A\n${Array.from({ length: 100 }, (_, index) => `- signal-${index} ${'acceptance '.repeat(100)}`).join('\n')}`,
      changedFiles: ['src/example.ts'],
    });
    const paths = Array.from({ length: 20 }, (_, index) => `/review-results/${index}-${'path'.repeat(80)}.json`);
    const longFindings = Array.from({ length: 8 }, (_, index) => `finding-${index} ${'detail '.repeat(100)}`);
    const brief = buildReviewRoundBrief({ ...base, results: [
      { path: paths[0]!, mtimeMs: 1, value: { pr: 42, headCommit: 'b'.repeat(40), reviewed: true, mustFix: longFindings } },
      ...paths.slice(1).map((path, index) => ({
        path, mtimeMs: index + 2,
        value: { pr: 42, headCommit: index === paths.length - 2 ? base.head : index.toString(16).padStart(40, 'c'), reviewed: true, verdict: 'fail', mustFix: longFindings },
      })),
    ] });
    const rendered = renderReviewBriefIntentBlock(brief)!;
    expect(rendered.length).toBeLessThanOrEqual(REVIEW_BRIEF_INTENT_MAX_CHARS);
    expect(rendered).toContain('수용 신호 95개 생략');
    expect(rendered).toContain('원문 파일 17개 생략');
    expect(brief.resultPaths[0]).toBe(paths[paths.length - 1]);
    expect(rendered).toContain('참고 원문 (3/20): /review-results/19-');
    expect(rendered).toContain('finding-0');
    expect(rendered).toContain('의도적 스코프 경계:');
  });

  test('loads saved JSON review rounds with 7-character filename head suffixes', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-brief-'));
    roots.push(root);
    const dir = join(root, 'reviews');
    mkdirSync(dir);
    const base = input();
    for (const [index, head] of ['1'.repeat(40), base.head].entries()) {
      writeFileSync(join(dir, `card-${index}-42-${head.slice(0, 7)}.json`), JSON.stringify({
        pr: '42', headCommit: head, reviewed: true, mustFix: [`finding-${index}`],
      }));
    }
    const brief = loadReviewRoundBrief({ pr: base.pr, head: base.head, body: base.body, changedFiles: base.changedFiles, reviewResultsDir: dir });
    expect(brief.rounds).toBe(2);
    expect(brief.status).toBe('ready');
    expect(brief.coreItems[0]?.text).toBe('finding-1');
  });

  test('marks matching malformed review result files unavailable instead of unmeasured', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-brief-unavailable-'));
    roots.push(root);
    const dir = join(root, 'reviews');
    mkdirSync(dir);
    writeFileSync(join(dir, `bad-42-${'a'.repeat(12)}.json`), '{broken');
    const base = input();
    const brief = loadReviewRoundBrief({ pr: 42, head: base.head, body: base.body, changedFiles: base.changedFiles, reviewResultsDir: dir });
    expect(brief).toMatchObject({ status: 'unavailable', rx: 'decision-card', rounds: 0, source: 'none' });
    expect(brief.readErrors?.[0]).toContain('bad-42-');
  });

  test('measures nine rounds only from nine distinct completed saved head records', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-brief-'));
    roots.push(root);
    const dir = join(root, 'reviews');
    mkdirSync(dir);
    const base = input({ head: '9'.repeat(40) });
    for (let round = 1; round <= 9; round += 1) {
      const head = String(round).repeat(40);
      writeFileSync(join(dir, `review-42-${head.slice(0, 12)}.json`), JSON.stringify({ pr: 42, headCommit: head, reviewed: true, mustFix: [] }));
    }
    const load = () => loadReviewRoundBrief({ pr: base.pr, head: base.head, body: base.body, changedFiles: base.changedFiles,
      comments: ['OP: 남은 범위 = follow-up. r99 상한 초과로 분리.'], reviewResultsDir: dir });
    expect(load()).toMatchObject({ rounds: 9, currentHeadMeasured: true, status: 'ready', source: 'saved-review', totalCoreItems: 0 });
    writeFileSync(join(dir, `review-42-${'8'.repeat(12)}.json`), JSON.stringify({ pr: 42, headCommit: '8'.repeat(40), reviewed: false, mustFix: [] }));
    expect(load()).toMatchObject({ rounds: 8, currentHeadMeasured: true, status: 'ready', source: 'saved-review' });
  });

  test('intent includes findings from every distinct prior head and declares capped core omissions', () => {
    const base = input({ head: 'c'.repeat(40), body: '## A\n- exact acceptance' });
    const results = [
      { path: '/r1.json', mtimeMs: 1, value: { pr: 42, headCommit: 'b'.repeat(40), reviewed: true, mustFix: ['first ambiguous finding'] } },
      { path: '/r2.json', mtimeMs: 2, value: { pr: 42, headCommit: 'c'.repeat(40), reviewed: true, mustFix: ['second ambiguous finding', 'third ambiguous finding', 'fourth ambiguous finding', 'fifth ambiguous finding', 'sixth ambiguous finding', 'seventh ambiguous finding'] } },
    ];
    const brief = buildReviewRoundBrief({ ...base, results });
    const rendered = renderReviewBriefIntentBlock(brief)!;
    expect(rendered).toContain('first ambiguous finding');
    expect(rendered).toContain('sixth ambiguous finding');
    expect(rendered).not.toContain('seventh ambiguous finding');
    expect(brief).toMatchObject({ totalCoreItems: 6, omittedCoreItems: 1 });
    expect(rendered).toContain('1개 생략');
    expect(rendered).toContain('/r2.json');
    const stale = buildReviewRoundBrief({ ...input({ body: '## A\n- exact acceptance' }), results });
    const staleRendered = renderReviewBriefIntentBlock(stale)!;
    expect(stale).toMatchObject({ coreItems: [], totalCoreItems: 0, totalPriorFindings: 7, omittedPriorFindings: 2 });
    expect(staleRendered).toContain('과거 라운드 검토 항목 (5/7');
    expect(staleRendered).toContain('과거 finding 2개 생략');
    expect(staleRendered.match(/second ambiguous finding/g)).toHaveLength(1);
    expect(brief.reviewedRx).toBe('continue');
  });
});
