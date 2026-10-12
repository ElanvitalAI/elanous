import { describe, expect, test } from 'bun:test';
import { buildPremiseCard, formatGateFailedId, gateFailedIdFile, narrowestWrong, pairedSourceOf, type PremiseFinding, type PremiseReviewInput } from './premise-review.js';
import { computeFlexSignals } from './flex-signals.js';

// 실패 id 는 생산자(orchestrator 의 roundSummaryEntries.failedIds)와 같은 함수로 만든다 — 지어낸 꼴로 시험하지 않는다.
const id = (name: string, file: string | undefined, attribution = 'introduced') => formatGateFailedId({ name, file, attribution });
const TARGETS = ['src/self-implement/flex-signals.ts', 'src/self-implement/premise-review.ts'];
const p3Of = (input: PremiseReviewInput) => buildPremiseCard(input).findings.find((finding) => finding.premise === 'P3')!;
const gateInput = (ids: string[], targetPaths: readonly string[] = TARGETS): PremiseReviewInput => ({
  runId: 'run-p3', gateFailedIdsByRound: [ids], failureAttributions: ids.map(() => 'introduced'), round: 2, plannedRounds: 3, targetPaths,
});

describe('실패 id 파싱·짝 소스', () => {
  test('생산자 꼴 `name@file (귀속)` 에서 파일만 남긴다 — `?`·`@` 없음은 못 잼', () => {
    expect(id('flex works', 'src/self-implement/flex-signals.test.ts')).toBe('flex works@src/self-implement/flex-signals.test.ts (introduced)');
    expect(gateFailedIdFile(id('a > b', 'src/x.test.ts'))).toBe('src/x.test.ts');
    expect(gateFailedIdFile(id('has @ inside name', 'src/x.test.ts'))).toBe('src/x.test.ts');
    expect(gateFailedIdFile(id('scoped', 'src/@scope/pkg.test.ts'))).toBe('src/@scope/pkg.test.ts');
    expect(gateFailedIdFile(id('parses user@example.com', 'src/self-implement/flex-signals.test.ts'))).toBe('src/self-implement/flex-signals.test.ts');
    expect(gateFailedIdFile(id('imports @scope/pkg', 'src/x.test.ts'))).toBe('src/x.test.ts');
    expect(gateFailedIdFile(id('imports @scope/pkg', 'src/@scope/pkg.test.ts'))).toBe('src/@scope/pkg.test.ts');
    expect(gateFailedIdFile(id('no file', undefined))).toBeUndefined();
    expect(gateFailedIdFile('legacy-without-at (introduced)')).toBeUndefined();
  });

  test('x.test.ts → 같은 폴더 x.ts · 시험 전용 폴더는 짝을 추측하지 않는다', () => {
    expect(pairedSourceOf('src/self-implement/flex-signals.test.ts')).toBe('src/self-implement/flex-signals.ts');
    expect(pairedSourceOf('apps/pwa/src/a.test.tsx')).toBe('apps/pwa/src/a.tsx');
    expect(pairedSourceOf('test/dashboard.test.ts')).toBeUndefined();
    expect(pairedSourceOf('src/__tests__/a.test.ts')).toBeUndefined();
    expect(pairedSourceOf('src/a.ts')).toBe('src/a.ts');
  });
});

describe('buildPremiseCard — 전제 되짚기(FLEX-RFC §A-③)', () => {
  test('범위 안 시험 파일(짝 소스가 대상 경로) → P3 ok', () => {
    const p3 = p3Of(gateInput([id('flex works', 'src/self-implement/flex-signals.test.ts')]));
    expect(p3.verdict).toBe('ok');
  });

  test('시험 파일 자체가 대상 경로(신설:)여도 범위 안이다', () => {
    const p3 = p3Of(gateInput([id('card', 'src/self-implement/premise-review.test.ts')], ['src/self-implement/premise-review.test.ts']));
    expect(p3.verdict).toBe('ok');
  });

  test('범위 밖 실패 파일이면 P3 wrong — 그 시험 파일을 근거로, proposal 은 그 하나', () => {
    const input = gateInput([
      id('flex works', 'src/self-implement/flex-signals.test.ts'),
      id('other red', 'src/other/place.test.ts'),
    ]);
    // 같은 값 객체가 `computeFlexSignals` 에도 그대로 먹히는 꼴이다(«same shape» 계약).
    expect(computeFlexSignals(input)).toEqual({ fail_signature_repeat: 0, base_reproduce: 0, budget_burn: 2 / 3 });
    const card = buildPremiseCard(input);
    const p3 = card.findings.find((finding) => finding.premise === 'P3')!;
    expect(p3).toEqual({ premise: 'P3', verdict: 'wrong', evidence: 'src/other/place.test.ts' });
    expect(card.proposal).toEqual({ premise: 'P3', verdict: 'wrong', evidence: 'src/other/place.test.ts' });
  });

  test('파일이 `?` 인 실패 → P3 unknown(ok 아님)', () => {
    const p3 = p3Of(gateInput([id('flex works', 'src/self-implement/flex-signals.test.ts'), id('no file', undefined)]));
    expect(p3.verdict).toBe('unknown');
  });

  test('짝을 못 짓는 시험(test/…) → P3 unknown — 추측해 wrong 을 만들지 않는다', () => {
    const p3 = p3Of(gateInput([id('dashboard', 'test/dashboard.test.ts')]));
    expect(p3.verdict).toBe('unknown');
  });

  test('preexisting 실패면 P2 wrong — 그 실패 id 를 근거로', () => {
    const failed = id('flex works', 'src/self-implement/flex-signals.test.ts', 'preexisting');
    const card = buildPremiseCard({
      runId: 'run-premise-2',
      gateFailedIdsByRound: [[failed]],
      failureAttributions: ['preexisting'],
      round: 3,
      plannedRounds: 5,
      targetPaths: ['src/self-implement/flex-signals.ts'],
    });
    const p2 = card.findings.find((finding) => finding.premise === 'P2')!;
    expect(p2.verdict).toBe('wrong');
    expect(p2.evidence).toBe(failed);
    expect(card.findings.find((finding) => finding.premise === 'P3')!.verdict).toBe('ok');
    expect(card.proposal?.premise).toBe('P2');
  });

  test('wrong 이 여럿(P2+P3)이면 «가장 좁은 것» P2(자 정정) 하나만 제안한다', () => {
    const failed = id('other red', 'src/other/place.test.ts', 'preexisting');
    const card = buildPremiseCard({
      runId: 'run-narrowest', gateFailedIdsByRound: [[failed]], failureAttributions: ['preexisting'],
      round: 2, plannedRounds: 3, targetPaths: TARGETS,
    });
    expect(card.findings.find((f) => f.premise === 'P2')!.verdict).toBe('wrong');
    expect(card.findings.find((f) => f.premise === 'P3')!.verdict).toBe('wrong');
    expect(card.proposal?.premise).toBe('P2');
  });

  test('이름에 `@` 가 섞인 대상 안 실패는 P3 를 wrong 으로 만들지 않는다', () => {
    const failed = id('parses user@example.com', 'src/self-implement/flex-signals.test.ts', 'introduced');
    const card = buildPremiseCard({
      runId: 'run-at-in-name', gateFailedIdsByRound: [[failed]], failureAttributions: ['introduced'],
      round: 2, plannedRounds: 3, targetPaths: TARGETS,
    });
    expect(card.findings.find((f) => f.premise === 'P3')!.verdict).toBe('ok');
    expect(card.proposal?.premise).not.toBe('P3');
  });

  test('narrowestWrong 은 배열 순서가 아니라 rank(P2→P5→P4→P3→P1)로 고른다', () => {
    const wrong = (premise: PremiseFinding['premise']): PremiseFinding => ({ premise, verdict: 'wrong', evidence: premise });
    expect(narrowestWrong([wrong('P1'), wrong('P3'), wrong('P4'), wrong('P5'), wrong('P2')])?.premise).toBe('P2');
    expect(narrowestWrong([wrong('P1'), wrong('P3'), wrong('P4'), wrong('P5')])?.premise).toBe('P5');
    expect(narrowestWrong([wrong('P1'), wrong('P3'), wrong('P4')])?.premise).toBe('P4');
    expect(narrowestWrong([wrong('P1'), wrong('P3')])?.premise).toBe('P3');
    expect(narrowestWrong([{ premise: 'P2', verdict: 'ok', evidence: '' }, wrong('P1')])?.premise).toBe('P1');
    expect(narrowestWrong([{ premise: 'P2', verdict: 'unknown', evidence: '' }])).toBeUndefined();
  });

  test('근거가 없으면 unknown — 어떤 전제도 ok 가 아니고 proposal 도 없다', () => {
    const card = buildPremiseCard({
      runId: 'run-premise-3',
      gateFailedIdsByRound: [],
      round: 1,
    });
    expect(card.runId).toBe('run-premise-3');
    expect(card.findings.map((finding) => finding.premise)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
    expect(card.findings.every((finding) => finding.verdict === 'unknown')).toBe(true);
    expect(card.proposal).toBeUndefined();
  });
});
