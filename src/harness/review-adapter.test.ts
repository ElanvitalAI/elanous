// Reviewer 어댑터(H1) — combineReview(테스트게이트 하드 + critique 소프트)·buildReviewSeam 검증.
import { test, expect, describe } from 'bun:test';
import { appendGateWorktreeFreshnessEvidence, combineReview, buildReviewSeam, gateEvidenceNote, reviewResultToCritiqueLike, reviewResultToVerdict, type GateLike, type CritiqueLike } from './review-adapter.js';
import type { ReviewResult } from '../agent-substrate/pr-reviewer.js';

describe('P3 위임 브릿지 — substrate PR 리뷰어 → 하니스 형상(verdict 어휘 단일)', () => {
  const rr = (over: Partial<ReviewResult>): ReviewResult => ({ verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true, ...over });
  test('reviewResultToCritiqueLike — fail 은 실블로커(mustFix)만·nit(shouldFix) 제외(nit 완화)', () => {
    const c = reviewResultToCritiqueLike(rr({ verdict: 'fail', mustFix: ['미배선'], shouldFix: ['네이밍'] }));
    expect(c.verdict).toBe('fail');
    expect(c.findings).toEqual(['미배선']);   // 네이밍 nit 은 rework 블로커에서 제외
  });
  test('★ nit 완화 — warn/pass 는 shouldFix 포함(종전대로·메모 이양)', () => {
    const cw = reviewResultToCritiqueLike(rr({ verdict: 'warn', mustFix: [], shouldFix: ['네이밍', '주석'] }));
    expect(cw.verdict).toBe('warn');
    expect(cw.findings).toEqual(['네이밍', '주석']);   // warn=비블로커 nit → PR 메모 경로 유지
  });
  test('reviewResultToVerdict — 하니스 ReviewVerdict struct·mustFix 보존', () => {
    const v = reviewResultToVerdict(rr({ verdict: 'fail', mustFix: ['블로커'], shouldFix: ['s'] }));
    expect(v.verdict).toBe('fail');
    expect(v.mustFix).toEqual(['블로커']);
    expect(v.findings).toEqual(['블로커', 's']);
  });
  test('★ 위임 왕복 — PR 리뷰어 fail 을 combineReview 소프트 critique 로 실으면 fail', () => {
    const c = reviewResultToCritiqueLike(rr({ verdict: 'fail', mustFix: ['x'] }));
    expect(combineReview({ passed: true }, c).verdict).toBe('fail'); // 게이트 pass + PR리뷰 fail → fail
  });
  test('warn 매핑 — verdict/findings 통일', () => {
    const c = reviewResultToCritiqueLike(rr({ verdict: 'warn', shouldFix: ['네이밍'] }));
    expect(c.verdict).toBe('warn');
    expect(reviewResultToVerdict(rr({ verdict: 'warn', shouldFix: ['네이밍'] })).verdict).toBe('warn');
  });
  test('★ reviewed=false(미실행 fail-soft pass) → warn 강등(pass 위장 금지·dogfood #4798)', () => {
    const notReviewed = rr({ verdict: 'pass', reviewed: false });
    expect(reviewResultToCritiqueLike(notReviewed).verdict).toBe('warn');
    expect(reviewResultToVerdict(notReviewed).verdict).toBe('warn');
    // 게이트 pass + 미검토 → warn(authoritative pass 아님 — 미검토 PR 이 harness review 를 통과하지 않게).
    expect(combineReview({ passed: true }, reviewResultToCritiqueLike(notReviewed)).verdict).toBe('warn');
  });
  test('reviewed=false의 failureReason을 critique와 하니스 verdict까지 보존한다', () => {
    const notReviewed = rr({ verdict: 'pass', reviewed: false, failureReason: 'review backend unavailable' });
    const critique = reviewResultToCritiqueLike(notReviewed);
    expect(critique.failureReason).toBe('review backend unavailable');
    expect(reviewResultToVerdict(notReviewed).failureReason).toBe('review backend unavailable');
    expect(combineReview({ passed: true }, critique).failureReason).toBe('review backend unavailable');
  });
  test('reviewed=false에 failureReason이 없으면 합성하지 않고 이유 자리를 비운다', () => {
    const notReviewed = rr({ verdict: 'pass', reviewed: false });
    const critique = reviewResultToCritiqueLike(notReviewed);
    expect(critique).not.toHaveProperty('failureReason');
    expect(reviewResultToVerdict(notReviewed)).not.toHaveProperty('failureReason');
    expect(combineReview({ passed: true }, critique)).not.toHaveProperty('failureReason');
  });
});

describe('gateEvidenceNote — runner/compiler 판정 줄만 증거 채널로 보존', () => {
  test('new module missing at base reaches the reviewer with its actual RED interpretation', () => {
    const note = gateEvidenceNote({
      passed: true,
      log: [
        '[changed-test-evidence] head=pass; base-fail=0/1; red-witness=1/1; verdict=proved',
        '- src/ux-sim/new-device.test.ts: missing-at-base',
        'unrelated child stdout',
      ].join('\n'),
    });
    expect(note).toContain('[changed-test-evidence] head=pass; base-fail=0/1; red-witness=1/1; verdict=proved');
    expect(note).toContain('- src/ux-sim/new-device.test.ts: missing-at-base');
    expect(note).toContain('base에 없는 신규 모듈의 base RED 목격을 must-fix로 요구하지 말 것');
    expect(note).not.toContain('unrelated child stdout');
  });

  test('changed-test evidence survives the review note cap, without missing-at-base advice on ordinary RED', () => {
    const note = gateEvidenceNote({
      passed: true,
      log: [
        '[gate-baseline] introduced=0, preexisting=0, unknown=0, precondition-unmet=0',
        ...Array.from({ length: 30 }, (_unused, index) => `- preexisting: test/base-${index}.test.ts > failure`),
        ...Array.from({ length: 30 }, (_unused, index) => `Ran ${index + 1} tests across 1 file`),
        '[changed-test-evidence] head=pass; base-fail=1/1; red-witness=1/1; verdict=proved',
        '- introduced: test/new-feature.test.ts > failure',
      ].join('\n'),
    });
    expect(note).toContain('[changed-test-evidence] head=pass; base-fail=1/1; red-witness=1/1; verdict=proved');
    expect(note).toContain('- introduced: test/new-feature.test.ts > failure');
    expect(note).not.toContain('base에 없는 신규 모듈');
  });

  test('changed-test evidence preserves attribution even without a baseline header', () => {
    const note = gateEvidenceNote({
      passed: false,
      log: '[changed-test-evidence] head=fail; verdict=failed\n- introduced: test/new-feature.test.ts > failure',
    });
    expect(note).toContain('[changed-test-evidence] head=fail; verdict=failed');
    expect(note).toContain('- introduced: test/new-feature.test.ts > failure');
  });

  test('changed-test evidence reports omitted heads and keeps the cap without baseline', () => {
    const note = gateEvidenceNote({
      passed: true,
      log: [
        ...Array.from({ length: 5 }, (_unused, index) => `[changed-test-evidence] file=${index}; verdict=proved`),
        ...Array.from({ length: 30 }, (_unused, index) => `Ran ${index + 1} tests across 1 file`),
      ].join('\n'),
    });
    expect(note).toContain('[changed-test-evidence] file=0; verdict=proved');
    expect(note).toContain('[changed-test-evidence] file=2; verdict=proved');
    expect(note).toContain('…[2개 생략됨]');
    expect(note!.split('\n').length).toBeLessThanOrEqual(25); // 제목 1줄 + evidence 최대 24줄
  });

  test('baseline and many structural RED witnesses stay within the evidence cap', () => {
    const note = gateEvidenceNote({
      passed: true,
      log: [
        '[gate-baseline] introduced=0, preexisting=1, unknown=0',
        '[changed-test-evidence] head=pass; red-witness=6/6; verdict=proved',
        ...Array.from({ length: 6 }, (_unused, index) => `- test/new-${index}.test.ts: missing-at-base`),
        ...Array.from({ length: 30 }, (_unused, index) => `- preexisting: test/old-${index}.test.ts > failure`),
        '- introduced: test/new-feature.test.ts > failure',
        ...Array.from({ length: 30 }, (_unused, index) => `Ran ${index + 1} tests across 1 file`),
      ].join('\n'),
    });
    expect(note).toContain('[changed-test-evidence] head=pass; red-witness=6/6; verdict=proved');
    expect(note).toContain('…[2개 생략됨]');
    expect(note).toContain('- introduced: test/new-feature.test.ts > failure');
    expect(note!.split('\n').length).toBeLessThanOrEqual(25);
  });

  test('an attribution containing missing-at-base appears only once', () => {
    const line = '- introduced: test/new-feature.test.ts: missing-at-base';
    const note = gateEvidenceNote({ passed: true, log: `[changed-test-evidence] verdict=proved\n${line}` });
    expect(note!.split('\n').filter((item) => item === line)).toHaveLength(1);
  });

  test('포커스 테스트·타입검사·Verify-by-breaking 원문을 보존하고 잡음은 제외한다', () => {
    const note = gateEvidenceNote({
      passed: true,
      log: ['starting gate', '23 pass', '0 fail', 'Ran 6 tests across 1 file', 'error TS9999: old failure', 'Verify-by-breaking: injected 1 fail, restored 0 fail', 'verbose noise'].join('\n'),
    });
    expect(note).toContain('## Gate execution evidence');
    expect(note).toContain('23 pass');
    expect(note).toContain('Ran 6 tests across 1 file');
    expect(note).toContain('error TS9999: old failure');
    expect(note).toContain('Verify-by-breaking: injected 1 fail, restored 0 fail');
    expect(note).not.toContain('verbose noise');
  });

  test('baseline 면책 결론과 실패별 귀속을 리뷰어 증빙으로 보낸다', () => {
    const note = gateEvidenceNote({
      passed: true,
      log: [
        '[gate-baseline] introduced=0, preexisting=1, unknown=0, precondition-unmet=0',
        '- preexisting: src/self-implement/orchestrator.test.ts > base failure',
        '⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.',
        '2 fail',
      ].join('\n'),
    });
    expect(note).toContain('- preexisting: src/self-implement/orchestrator.test.ts > base failure');
    expect(note).toContain('⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.');
  });

  test('baseline 머리·면책을 선예약하고 귀속은 8건만 나르며 실행 증거를 보존한다', () => {
    const attributions = Array.from({ length: 50 }, (_unused, index) => `- preexisting: test/base-${index}.test.ts > failure`);
    const note = gateEvidenceNote({
      passed: true,
      log: [
        '[gate-baseline] introduced=0, preexisting=50, unknown=0, precondition-unmet=0',
        ...attributions,
        'Verify-by-breaking: injected 1 fail, restored 0 fail',
        'Ran 400 tests across 9 files.',
        '50 fail',
        'error TS2322: old failure',
        '⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.',
      ].join('\n'),
    });
    const lines = note?.split('\n') ?? [];
    expect(lines).toHaveLength(16);
    expect(lines.slice(1)).toHaveLength(15);
    expect(lines[1]).toBe('[gate-baseline] introduced=0, preexisting=50, unknown=0, precondition-unmet=0');
    expect(lines[2]).toBe('⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.');
    expect(lines.slice(3, 11)).toEqual(attributions.slice(0, 8));
    expect(lines[11]).toBe('…[42개 생략됨]');
    expect(lines).toContain('Verify-by-breaking: injected 1 fail, restored 0 fail');
    expect(lines).toContain('Ran 400 tests across 9 files.');
    expect(lines).toContain('50 fail');
    expect(lines).toContain('error TS2322: old failure');
  });

  test('24줄 절단의 생략 표기는 독립된 마지막 줄이다', () => {
    const log = [
      '[gate-baseline] introduced=0, preexisting=0, unknown=0, precondition-unmet=0',
      '⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.',
      ...Array.from({ length: 24 }, (_unused, index) => `Ran ${index + 1} tests across 1 file`),
    ].join('\n');
    const lines = gateEvidenceNote({ passed: true, log })?.split('\n') ?? [];
    expect(lines).toHaveLength(25);
    expect(lines.at(-2)).toBe('Ran 21 tests across 1 file');
    expect(lines.at(-1)).toBe('…[3개 생략됨]');
  });

  test('병적으로 많은 baseline 머리줄 뒤의 면책 결론도 상한 안에 보존한다', () => {
    const heads = Array.from({ length: 24 }, (_unused, index) => `[gate-baseline] duplicate=${index}`);
    const note = gateEvidenceNote({
      passed: true,
      log: [...heads, '⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.', '2 fail'].join('\n'),
    });
    const lines = note?.split('\n') ?? [];
    expect(lines).toHaveLength(25);
    expect(lines[1]).toBe('[gate-baseline] duplicate=0');
    expect(lines[2]).toBe('⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.');
    expect(lines.at(-1)).toBe('…[3개 생략됨]');
  });

  test('24줄 이하 baseline 입력은 종전 선택 결과와 문자 동등하다', () => {
    const log = [
      '[gate-baseline] introduced=0, preexisting=2, unknown=0, precondition-unmet=0',
      '- preexisting: test/base-0.test.ts > failure',
      '- preexisting: test/base-1.test.ts > failure',
      '⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.',
      '2 fail',
    ].join('\n');
    expect(gateEvidenceNote({ passed: true, log })).toBe([
      '## Gate execution evidence',
      '[gate-baseline] introduced=0, preexisting=2, unknown=0, precondition-unmet=0',
      '⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.',
      '- preexisting: test/base-0.test.ts > failure',
      '- preexisting: test/base-1.test.ts > failure',
      '2 fail',
    ].join('\n'));
  });

  test('선택 후보가 24줄 이하이면 비선택 잡음이 많아도 종전 baseline 결과와 문자 동등하다', () => {
    const selected = [
      '[gate-baseline] introduced=0, preexisting=2, unknown=0, precondition-unmet=0',
      '⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.',
      '- preexisting: test/base-0.test.ts > failure',
      '- preexisting: test/base-1.test.ts > failure',
      '2 fail',
    ];
    const log = [...selected, ...Array.from({ length: 25 }, (_unused, index) => `unselected noise ${index}`)].join('\n');
    expect(gateEvidenceNote({ passed: true, log })).toBe([
      '## Gate execution evidence',
      ...selected,
    ].join('\n'));
  });

  // ⚠️ 2026-08-01 계약 변경([S] must-fix · 인수): baseline 블록이 없어도 **같은 절단 표기**를 쓴다.
  //   ⛔ 종전엔 A 경로만 영문 suffix(`[+N lines omitted]`)를 **마지막 줄에 덧붙여**, 같은 입력에
  //   언어·위치·수 셋이 갈렸다. 그리고 그 줄이 **온전한데 잘린 것처럼** 읽혔다.
  //   ⇒ `omission()` 을 공유해 **별도 줄**로 낸다. 지우지 않고 뒤집어 계약 변경을 남긴다.
  test('baseline 블록이 없어도 공유 절단 표기를 별도 줄로 쓴다', () => {
    const selected = Array.from({ length: 25 }, (_unused, index) => `${index + 1} pass`);
    const log = [...selected, ...Array.from({ length: 25 }, (_unused, index) => `unselected noise ${index}`)].join('\n');
    expect(gateEvidenceNote({ passed: true, log })).toBe([
      '## Gate execution evidence',
      ...selected.slice(0, 23),
      '…[2개 생략됨]',
    ].join('\n'));
  });

  test('baseline 블록이 없으면 종전 선택 순서와 문자 표현을 보존한다', () => {
    const log = ['starting gate', '23 pass', '0 fail', 'Ran 6 tests across 1 file', 'error TS9999: old failure', 'Verify-by-breaking: injected 1 fail, restored 0 fail', 'verbose noise'].join('\n');
    expect(gateEvidenceNote({ passed: true, log })).toBe([
      '## Gate execution evidence',
      '23 pass',
      '0 fail',
      'Ran 6 tests across 1 file',
      'error TS9999: old failure',
      'Verify-by-breaking: injected 1 fail, restored 0 fail',
    ].join('\n'));
  });
});

describe('appendGateWorktreeFreshnessEvidence — 무손실·무소음·미지 계약', () => {
  const executionEvidence = `## Gate execution evidence\n[test] PASS bun test test/chat-text-input-paste.test.ts — Ran 1 tests across 1 file\n1 pass\n0 fail`;

  test('behind면 새 줄을 더하고, 최신이면 기존 실행 증빙을 정확히 보존한다', () => {
    expect(appendGateWorktreeFreshnessEvidence(executionEvidence, 3)).toBe(`${executionEvidence}\n[worktree] origin/main 대비 3 commits behind (local ref; no fetch)`);
    expect(appendGateWorktreeFreshnessEvidence(executionEvidence, 0)).toBe(executionEvidence);
  });

  test('긴 기존 증빙에서도 실행 증빙 전체와 behind 사실을 함께 보존한다', () => {
    const fullExistingEvidence = `${executionEvidence}\n${'x'.repeat(1200)}`;
    expect(appendGateWorktreeFreshnessEvidence(fullExistingEvidence, 3)).toBe(`${fullExistingEvidence}\n[worktree] origin/main 대비 3 commits behind (local ref; no fetch)`);
  });

  test('조회 불가는 unknown으로 구분하고 기존 실행 증빙 전체를 보존한다', () => {
    expect(appendGateWorktreeFreshnessEvidence(executionEvidence, undefined)).toBe(`${executionEvidence}\n[worktree] origin/main 대비 뒤처짐: unknown (local ref unavailable; no fetch)`);
  });
});

describe('combineReview — test-gate first, judge second', () => {
  test('게이트 fail → 즉시 fail(하드·mustFix=실패 스텝)', () => {
    const gate: GateLike = { passed: false, steps: [{ name: 'test', ok: false }] };
    const v = combineReview(gate);
    expect(v.verdict).toBe('fail');
    expect(v.mustFix).toEqual(['test']);
  });
  test('게이트 pass + critique 없음 → pass', () => {
    expect(combineReview({ passed: true }).verdict).toBe('pass');
  });
  test('게이트 pass + critique warn → warn(소프트)', () => {
    const c: CritiqueLike = { verdict: 'warn', findings: ['nit'] };
    const v = combineReview({ passed: true }, c);
    expect(v.verdict).toBe('warn');
    expect(v.findings).toEqual(['nit']);
  });
  test('게이트 pass + critique fail → fail(소프트 blocking)', () => {
    const c: CritiqueLike = { verdict: 'fail', findings: ['설계 결함'] };
    const v = combineReview({ passed: true }, c);
    expect(v.verdict).toBe('fail');
    expect(v.mustFix).toEqual(['설계 결함']);
  });
  test('게이트 fail 이면 critique pass 여도 fail(하드 우선)', () => {
    expect(combineReview({ passed: false, steps: [{ name: 'test', ok: false }] }, { verdict: 'pass' }).verdict).toBe('fail');
  });
  test('게이트 fail + 미실행 critique 사유 → 하드 fail을 유지하며 사유도 보존', () => {
    const v = combineReview(
      { passed: false, steps: [{ name: 'test', ok: false }] },
      { verdict: 'warn', reviewed: false, failureReason: 'review backend unavailable' },
    );
    expect(v.verdict).toBe('fail');
    expect(v.mustFix).toEqual(['test']);
    expect(v.failureReason).toBe('review backend unavailable');
  });
});

describe('buildReviewSeam — 주입 게이트/critique 실행', () => {
  test('cwd 없으면 fail(배선 오류)', async () => {
    const seam = buildReviewSeam({ runGate: () => ({ passed: true }), cwd: () => undefined });
    expect((await seam({ objective: 'x', changes: [] })).verdict).toBe('fail');
  });
  test('게이트+critique 주입 실행 → combineReview', async () => {
    const seam = buildReviewSeam({
      runGate: () => ({ passed: true }),
      runCritique: () => ({ verdict: 'warn', findings: ['w'] }),
      cwd: () => '/wt',
    });
    const v = await seam({ objective: 'x', changes: ['a.ts'] });
    expect(v.verdict).toBe('warn');
  });
  test('critique 없으면 게이트만', async () => {
    const seam = buildReviewSeam({ runGate: () => ({ passed: false, steps: [{ name: 'test', ok: false }] }), cwd: () => '/wt' });
    expect((await seam({ objective: 'x', changes: [] })).verdict).toBe('fail');
  });
});

// ⛔⭐⭐ 절단 표기 통일 회귀 가드 (2026-08-01 · [S] must-fix → [T] 저작 → [S] 인수).
//   같은 함수가 두 규약을 썼다: A 경로는 영문 `[+N lines omitted]` 를 **마지막 줄에 덧붙였고**,
//   B 경로는 한글 `…[N개 생략됨]` 을 **별도 줄로** 냈다. ⇒ 언어·위치·수 셋이 갈렸다.
//   ⚠️ A 경로(baseline 블록이 없는 게이트 로그)는 그대로 옛 표기를 받고 있었다.
describe('절단 표기 통일', () => {
  test('baseline 블록이 없어도 한글 별도 줄 표기를 쓴다 (A 경로)', () => {
    const log = Array.from({ length: 40 }, (_u, i) => `Ran ${i} tests across 1 files.`).join('\n');
    const note = gateEvidenceNote({ log } as never) ?? '';
    expect(note).toContain('개 생략됨');
    expect(note).not.toContain('lines omitted');
  });
  test('두 경로가 같은 함수를 쓴다 (소스 결속)', async () => {
    const src = await Bun.file(new URL('./review-adapter.ts', import.meta.url)).text();
    expect(src).toContain("import { omission } from '../agent-substrate/review-intent.js'");
    expect(src).not.toMatch(/lines omitted/);
  });
});
