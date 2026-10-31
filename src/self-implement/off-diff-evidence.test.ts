import { describe, expect, test } from 'bun:test';
import { authoredSignalExecution, goalDeclaresNoWiring, settleUncoveredEvidence, MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS, MAX_HARVESTED_EVIDENCE_CHARS, authorLimitationCountFromGoal, harvestEvidenceLines, harvestedEvidenceObservation, buildImplementReport, requiredEvidenceFromGoal, renderRequiredEvidencePrompt, runRequiredEvidenceChecks, coverRequiredEvidence, parseOffDiffEvidence, OFF_DIFF_EVIDENCE_PROMPT, tailWithOmissionMarker } from './off-diff-evidence.js';
import { buildReviewIntent } from '../agent-substrate/review-intent.js';
import { featurePrompt } from './seams.js';

describe('parseOffDiffEvidence', () => {
  test('claim 과 verify 를 둘 다 가진 줄만 항목이 된다', () => {
    const r = parseOffDiffEvidence([
      '작업을 마쳤다.',
      'EVIDENCE: 격리 인스턴스에서 실제로 draft PR 이 열리는 것을 봤다 || bun bin/elanous.mjs logs --category dev-pipeline',
      'GOAL-COMPLETE',
    ].join('\n'));
    expect(r.items).toEqual([{
      claim: '격리 인스턴스에서 실제로 draft PR 이 열리는 것을 봤다',
      verify: 'bun bin/elanous.mjs logs --category dev-pipeline',
    }]);
    expect(r.discardedMissingVerify).toBe(0);
  });

  // ⛔ #5920 리뷰 must-fix ②: 종전 구현은 verify 없는 항목을 오케스트레이터 도달 전에 버려
  //    관측값이 **항상 0** 이었다(Goodhart). 파싱은 분류만 하고 수를 남긴다.
  test('⭐ 버린 것을 세어 남긴다 — 0 과 "잰 적 없음" 을 섞지 않는다', () => {
    const r = parseOffDiffEvidence([
      'EVIDENCE: 확인 방법 없는 주장',
      'EVIDENCE:  || some-command',
      'EVIDENCE: 진짜 || real-command',
    ].join('\n'));
    expect(r.items).toHaveLength(1);
    expect(r.discardedMissingVerify).toBe(1);
    expect(r.discardedEmptyClaim).toBe(1);
  });

  // ⛔ 리뷰 must-fix: 두 결손이 겹치는 줄에서 먼저 걸린 하나만 세면
  //    discardedMissingVerify 가 "확인 불가한 주장이 몇 건인가" 를 과소보고한다.
  test('⭐ claim 과 verify 가 둘 다 비면 두 수가 모두 오른다 (독립 집계)', () => {
    const r = parseOffDiffEvidence(['EVIDENCE:', 'EVIDENCE: ||', 'EVIDENCE:   ||   '].join('\n'));
    expect(r.items).toHaveLength(0);
    expect(r.discardedEmptyClaim).toBe(3);
    expect(r.discardedMissingVerify).toBe(3);   // ⛔ 종전엔 0 이었다
  });

  test('한쪽만 빈 줄은 그쪽만 오른다', () => {
    const r = parseOffDiffEvidence(['EVIDENCE: 주장만 있다', 'EVIDENCE:  || 명령만 있다'].join('\n'));
    expect(r.discardedMissingVerify).toBe(1);
    expect(r.discardedEmptyClaim).toBe(1);
  });

  test('EVIDENCE 바로 다음 RESULT가 그 항목의 결과가 된다', () => {
    const r = parseOffDiffEvidence([
      'EVIDENCE: 추가한 테스트가 통과했다 || bun test src/self-implement/off-diff-evidence.test.ts',
      'RESULT: 12 pass, 0 fail',
    ].join('\n'));
    expect(r.items).toEqual([{
      claim: '추가한 테스트가 통과했다',
      verify: 'bun test src/self-implement/off-diff-evidence.test.ts',
      result: '12 pass, 0 fail',
    }]);
    expect(r.missingResult).toBe(0);
    expect(r.orphanResult).toBe(0);
  });

  test('PTY CRLF 전사의 중간 EVIDENCE/RESULT 쌍을 항목으로 읽는다', () => {
    const r = parseOffDiffEvidence('EVIDENCE: PTY 확인 || bun test focused.test.ts\r\nRESULT: 1 pass, 0 fail\r\nGOAL-COMPLETE');
    expect(r.items).toEqual([{
      claim: 'PTY 확인',
      verify: 'bun test focused.test.ts',
      result: '1 pass, 0 fail',
    }]);
    expect(r.missingResult).toBe(0);
    expect(r.orphanResult).toBe(0);
  });

  test('CRLF 뒤 마지막 줄에 캐리지리턴이 없어도 증거와 결과를 짝짓는다', () => {
    const r = parseOffDiffEvidence('EVIDENCE: 마지막 결과 확인 || bun test focused.test.ts\r\nRESULT: 1 pass, 0 fail');
    expect(r.items).toEqual([{
      claim: '마지막 결과 확인',
      verify: 'bun test focused.test.ts',
      result: '1 pass, 0 fail',
    }]);
    expect(r.missingResult).toBe(0);
    expect(r.orphanResult).toBe(0);
  });

  test('LF 전용 증거와 결과는 기존처럼 항목으로 읽는다', () => {
    const r = parseOffDiffEvidence('EVIDENCE: LF 확인 || bun test focused.test.ts\nRESULT: 1 pass, 0 fail');
    expect(r.items).toEqual([{
      claim: 'LF 확인',
      verify: 'bun test focused.test.ts',
      result: '1 pass, 0 fail',
    }]);
    expect(r.missingResult).toBe(0);
    expect(r.orphanResult).toBe(0);
  });

  test('명령 안에 || 가 든 옛 2항 줄은 claim 과 verify 를 온전히 보존한다', () => {
    const r = parseOffDiffEvidence('EVIDENCE: 확인 || cmd || fallback');
    expect(r.items).toEqual([{ claim: '확인', verify: 'cmd || fallback' }]);
    expect(r.missingResult).toBe(1);
  });

  test('두 칸짜리 옛 형식 줄은 결과 없이도 항목이 된다', () => {
    const r = parseOffDiffEvidence('EVIDENCE: 기존 확인 || bun test existing.test.ts');
    expect(r.items).toEqual([{ claim: '기존 확인', verify: 'bun test existing.test.ts' }]);
    expect(r.missingResult).toBe(1);
  });

  test('결과가 상한을 넘으면 잘렸음을 드러낸다', () => {
    const r = parseOffDiffEvidence(`EVIDENCE: 긴 결과 확인 || command\nRESULT: ${'x'.repeat(MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS + 1)}`);
    expect(r.items[0]?.result).toContain('[RESULT truncated: 501 chars]');
    expect(r.items[0]?.result?.length).toBe(MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS);
  });

  test('짝 없는 RESULT와 모든 EVIDENCE의 결과 누락을 독립적으로 센다', () => {
    const r = parseOffDiffEvidence(['RESULT: 고아 결과', 'EVIDENCE:  || command', 'EVIDENCE: 확인 || command'].join('\n'));
    expect(r.orphanResult).toBe(1);
    expect(r.missingResult).toBe(2);
  });

  // ★ 상한 절단을 세지 않으면 *"500자가 부족한가"* 를 물을 수가 없다 — 절단은 문자열 안 마커로만
  //    남고 조회되지 않는다. 뮤테이션 출력처럼 긴 결과를 실을 때 이 수가 곧 계약 압력이다.
  test('⭐ RESULT 가 상한을 넘으면 잘린 사실을 세고, 넘지 않으면 세지 않는다', () => {
    const long = 'x'.repeat(MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS + 1);
    const over = parseOffDiffEvidence(`EVIDENCE: 주장 || cmd\nRESULT: ${long}`);
    expect(over.truncatedResult).toBe(1);
    expect(over.items[0]?.result).toContain('[RESULT truncated:');
    expect((over.items[0]?.result ?? '').length).toBeLessThanOrEqual(MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS);

    const under = parseOffDiffEvidence(`EVIDENCE: 주장 || cmd\nRESULT: ${'y'.repeat(MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS)}`);
    expect(under.truncatedResult).toBe(0);
    expect(under.items[0]?.result).not.toContain('[RESULT truncated:');
  });

  test('EVIDENCE 줄이 없으면 전부 0 이다', () => {
    const r = parseOffDiffEvidence('그냥 요약\nGOAL-COMPLETE');
    expect(r).toEqual({ items: [], discardedMissingVerify: 0, discardedEmptyClaim: 0, missingResult: 0, orphanResult: 0, truncatedResult: 0, anchoredEvidence: 0 });
  });
});

// ⭐⭐ #5920 리뷰 must-fix ③: 첫 시도는 "PR 본문 수정 같은 diff 밖 이행을 보고하라" 를 넣었는데
// 바로 앞 줄이 "git/PR 조작 금지" 였다. 자식이 상충하는 지시로 멈췄다. 이 가드가 그 재발을 막는다.
describe('자식 프롬프트가 자기모순을 만들지 않는다', () => {
  test('증거 안내는 행위를 부르지 않는다 (보고만)', () => {
    expect(OFF_DIFF_EVIDENCE_PROMPT).not.toMatch(/PR 본문|PR 을 수정|커밋하라|push/);
    expect(OFF_DIFF_EVIDENCE_PROMPT).toContain('보고만 하는 것이다');
  });

  test('RESULT 길이 안내는 실제 상한값을 보간하고 원문 보간식은 남기지 않는다', () => {
    expect(OFF_DIFF_EVIDENCE_PROMPT).toContain(`${MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS}자 이하`);
    expect(OFF_DIFF_EVIDENCE_PROMPT).not.toContain('${MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS}');
  });

  test('증거 안내는 || 구분자를 포함한 채워진 EVIDENCE 예시를 준다', () => {
    const example = 'EVIDENCE: 추가한 focused 테스트가 통과했다 || bun test src/self-implement/off-diff-evidence.test.ts';
    expect(OFF_DIFF_EVIDENCE_PROMPT).toContain(example);
    expect(parseOffDiffEvidence(example).items).toEqual([{
      claim: '추가한 focused 테스트가 통과했다',
      verify: 'bun test src/self-implement/off-diff-evidence.test.ts',
    }]);
  });

  test('featurePrompt 에 실려도 범위 제한과 충돌하지 않는다', () => {
    const p = featurePrompt('아무 기능');
    expect(p).toContain('git commit/push/PR/브랜치 조작 금지');   // 범위 제한은 그대로
    expect(p).toContain('EVIDENCE:');                              // 증거 채널도 있다
    expect(p).toContain('보고만 하는 것이다');                      // 그리고 둘이 명시적으로 화해한다
  });

  // ⛔⛔ **왜 이 테스트가 있나**(실측 2026-07-30): 자식이 `self typecheck` 에 `timeoutMs: 120000` 을
  //    골랐는데 실제 소요가 **146,518ms** 였다 ⇒ 27초 부족으로 `stage=aborted`. ⭐ **검증은 통과했고**
  //    (출력에 `✅ … 통과`) 그 타임아웃 하나가 완주한 런을 버렸다. 오늘 위임 실패의 반복 원인이다.
  //    ⇒ 걸리는 시간과 필요한 상한이 **안내문에 수로** 있어야 하고, 그 수가 조용히 사라지면 재발한다.
  test('타입 검사 안내가 소요 시간과 필요한 timeoutMs 를 수로 알려준다', () => {
    const p = featurePrompt('아무 기능');
    expect(p).toContain('self typecheck');
    // ⭐ 자식이 상한을 **추측하지 않게** 하는 두 수 — 둘 중 하나만 있으면 추측이 남는다.
    expect(p).toContain('150초');       // 얼마나 걸리나
    expect(p).toContain('240000');      // 그래서 얼마를 주어야 하나
  });

  // ⛔⛔ **왜 이 테스트가 있나**(실측 2026-07-30): 깊은 위임 **2/2**(R-b3 6R · R6b 6R)가
  //    중첩 인스턴스 가드에서 죽었다. 가드는 stderr 로
  //    *"prod 인스턴스를 nested 인터랙티브로 띄웠습니다 … 격리하려면 `--test` 를 붙이세요"* 를 냈고,
  //    자식은 **어떻게 하라는 것인지 몰라 3~4번의 툴 호출 뒤 조용히 죽었다**(`soft-timeout`).
  //    ⭐ 가드는 옳다(prod 스토어 보호). **없던 것은 "이렇게 하라" 다.**
  //    ⇒ 이 계열의 규율: ***금지만 주면 자식이 멈춘다 — 대체 명령을 같이 준다.***
  test('중첩 elanous 안내가 금지가 아니라 대체 명령(--test)을 준다', () => {
    const p = featurePrompt('아무 기능');
    expect(p).toContain('--test');                 // 무엇을 붙여야 하나
    expect(p).toContain('중첩');                    // 언제 붙여야 하나
    // ⭐ 왜 그래야 하는지도 있어야 한다 — 이유 없는 규칙은 자식이 다른 상황에 못 옮긴다.
    expect(p).toMatch(/가드|오염/);
  });

  test('빈 RESULT: 줄은 결과로 실리지 않고 missingResult 로 센다', () => {
    const r = parseOffDiffEvidence(['EVIDENCE: 확인했다 || cmd', 'RESULT:   '].join('\n'));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.result).toBeUndefined();
    expect(r.missingResult).toBe(1);
  });
});

// ★ I-9 / RUN-T6 — 자식이 먼저 돌린 tsc·뮤테이션 출력이 꼬리 2000자 밖으로 밀려 파서에 도달조차
//    못 하던 자리. 수확은 **화면 전체**에서 하되 **짝을 만들어 내지 않는다**.
describe('harvestEvidenceLines — 꼬리가 아니라 화면 전체에서 증거를 건진다', () => {
  test('⭐⭐ 꼬리 2000자 밖의 증거를 건진다(RUN-T6 가 죽은 자리)', () => {
    const transcript = [
      'EVIDENCE: tsc 게이트를 돌렸다 || bun run scripts/ci-typecheck-changed.ts',
      'RESULT: [tsc-gate] PASS — 변경 파일에 신규 타입 에러 없음.',
      'x'.repeat(3000),   // 이 뒤로 밀려 slice(-2000) 에는 안 들어온다
      '작업 계속',
    ].join('\n');

    expect(transcript.slice(-2000)).not.toContain('EVIDENCE:');   // ⛔ 종전 경로는 못 본다
    const harvested = harvestEvidenceLines(transcript);
    expect(harvested).toContain('bun run scripts/ci-typecheck-changed.ts');
    expect(harvested).toContain('[tsc-gate] PASS');
    // 수확본이 파서에 그대로 먹힌다(계약 정합)
    const parsed = parseOffDiffEvidence(harvested);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.missingResult).toBe(0);
  });

  test('⛔ 없던 짝을 만들어 내지 않는다 — 원본에서 인접하지 않은 RESULT 는 안 가져간다', () => {
    const transcript = ['EVIDENCE: 주장 || cmd', '중간에 낀 줄', 'RESULT: 엉뚱한 결과'].join('\n');
    const harvested = harvestEvidenceLines(transcript);
    expect(harvested).toBe('EVIDENCE: 주장 || cmd');
    expect(parseOffDiffEvidence(harvested).missingResult).toBe(1);
  });

  test('증거가 없으면 빈 문자열(폴백이 요약을 쓰게)', () => {
    expect(harvestEvidenceLines('그냥 요약\nGOAL-COMPLETE')).toBe('');
  });

  test('⭐ 상한을 넘으면 뒤(최신)를 **레코드 통째로** 남기고 생략을 표기한다', () => {
    const pair = (i: number) => `EVIDENCE: 주장${i} || cmd${i}\nRESULT: 결과${i}`;
    const many = Array.from({ length: 400 }, (_, i) => pair(i)).join('\n');
    const harvested = harvestEvidenceLines(many, 300);

    expect(harvested).toContain('레코드 생략]');
    expect(harvested).toContain('주장399');
    expect(harvested).toContain('결과399');            // ⛔ 쌍이 갈리지 않는다
    expect(harvested).not.toContain('주장0 ');
    expect(harvested.length).toBeLessThanOrEqual(300); // 표지까지 합쳐 상한 안
    // ⛔ 고아 RESULT 를 만들지 않는다(줄 단위로 자르면 났던 결손)
    expect(parseOffDiffEvidence(harvested).orphanResult).toBe(0);
  });

  test('⛔⭐⭐ 최신 레코드가 예산보다 커도 버리지 않고, **EVIDENCE 줄(재현 명령)을 변조하지 않는다**', () => {
    const verify = 'bun run scripts/ci-typecheck-changed.ts --some --long --flags --that --must --survive';
    const claim = '아주 긴 검증을 했다';
    const huge = `EVIDENCE: ${claim} || ${verify}\nRESULT: ${'z'.repeat(5000)}`;
    const harvested = harvestEvidenceLines(`EVIDENCE: 옛것 || old\nRESULT: 옛결과\n${huge}`, 200);

    expect(harvested).not.toBe('');
    // ⭐ 문자열 포함이 아니라 **파싱 결과가 원본과 같은지**로 단언한다(변조를 잡는 유일한 방법).
    const parsed = parseOffDiffEvidence(harvested);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.claim).toBe(claim);
    expect(parsed.items[0]?.verify).toBe(verify);     // ⛔ 명령이 잘리면 여기서 죽는다
    expect(parsed.orphanResult).toBe(0);
    expect(harvested).toMatch(/\[RESULT (절단|생략)/);   // 절단 표기는 **별도 줄**
  });

  test('⛔ 상한 초과는 오직 하나 — 표지+EVIDENCE 줄 자체가 상한보다 클 때만', () => {
    const pair = (i: number) => `EVIDENCE: 주장${i} || cmd${i}\nRESULT: ${'r'.repeat(40)}`;
    for (const cap of [150, 200, 400, 1000]) {
      expect(harvestEvidenceLines(Array.from({ length: 50 }, (_, i) => pair(i)).join('\n'), cap).length).toBeLessThanOrEqual(cap);
    }

    // ⭐ 리뷰 5R 이 잡은 경계 — **짧은 EVIDENCE + 긴 RESULT**. 표지 때문에 넘으면 안 된다.
    for (const cap of [80, 120, 200]) {
      const out = harvestEvidenceLines(`EVIDENCE: a || old\nRESULT: x\nEVIDENCE: b || cmd\nRESULT: ${'y'.repeat(2000)}`, cap);
      expect(out.length).toBeLessThanOrEqual(cap);
      expect(parseOffDiffEvidence(out).items[0]?.verify).toBe('cmd');   // 명령은 온전하다
    }

    // 허용되는 유일한 초과: EVIDENCE 줄 자체가 예산보다 길 때 — 그때도 그 줄은 원본과 동일하다
    const longVerify = 'cmd ' + 'v'.repeat(400);
    const out = harvestEvidenceLines(`EVIDENCE: a || old\nEVIDENCE: 최신 || ${longVerify}`, 100);
    expect(parseOffDiffEvidence(out).items[0]?.verify).toBe(longVerify);
  });

  test('⛔⭐ 잔여 예산이 아주 작아도 비문을 만들지 않는다 — 접두를 못 살리면 생략으로 내려간다', () => {
    const transcript = `EVIDENCE: a || old\nRESULT: x\nEVIDENCE: b || c\nRESULT: ${'y'.repeat(500)}`;
    // 표지+EVIDENCE 를 겨우 담는 구간을 훑는다(잔여 1~7자가 나오는 지점을 포함)
    for (let cap = 40; cap <= 120; cap += 1) {
      const out = harvestEvidenceLines(transcript, cap);
      const parsed = parseOffDiffEvidence(out);
      // ⛔ 잘린 RESULT 줄이 비문이면 여기서 거짓 결손이 잡힌다
      for (const line of out.split('\n')) {
        if (/^\s*R(E(S(U(L(T(:.*)?)?)?)?)?)?$/.test(line) && !/^\s*RESULT:/.test(line)) {
          throw new Error(`비문 RESULT 줄: ${JSON.stringify(line)} (cap=${cap})`);
        }
      }
      expect(parsed.orphanResult).toBe(0);
      expect(parsed.items[0]?.verify).toBe('c');
    }
  });

  test('기본 상한은 꼬리 요약과 다른 예산이다(파서 입력 ≠ 사람이 읽는 요약)', () => {
    expect(MAX_HARVESTED_EVIDENCE_CHARS).toBeGreaterThan(2000);
  });
});

describe('harvestedEvidenceObservation — 관측이 PR 과 같은 수확 본문을 나른다', () => {
  test('⭐ 여러 증거 줄이 본문으로 남고 PR 수확과 같다', () => {
    const transcript = [
      '작업 시작',
      'EVIDENCE: [requested] 첫 확인 || bun test a',
      'RESULT: 1 pass',
      '중간 산문',
      'EVIDENCE: [preservation] 둘째 확인 || bun test b',
      'RESULT: 2 pass',
    ].join('\n');
    const harvested = harvestEvidenceLines(transcript);
    const obs = harvestedEvidenceObservation(harvested);
    expect(obs).toEqual({
      harvestedEvidenceStatus: 'complete',
      harvestedEvidenceKept: 2,
      harvestedEvidenceTotal: 2,
      harvestedEvidence: harvested,
    });
    expect(obs.harvestedEvidence).toContain('EVIDENCE: [requested] 첫 확인 || bun test a');
    expect(obs.harvestedEvidence).toContain('EVIDENCE: [preservation] 둘째 확인 || bun test b');
    expect(obs.harvestedEvidence).toBe(harvested);
  });

  test('⭐ 상한을 넘으면 실은 수와 전체 수가 함께 남고 잘림이 값이다', () => {
    const pair = (i: number) => `EVIDENCE: 주장${i} || cmd${i}\nRESULT: 결과${i}`;
    const many = Array.from({ length: 400 }, (_, i) => pair(i)).join('\n');
    const harvested = harvestEvidenceLines(many, 300);
    const obs = harvestedEvidenceObservation(harvested);
    expect(obs.harvestedEvidenceStatus).toBe('truncated');
    expect(obs.harvestedEvidenceKept).toBeGreaterThan(0);
    expect(obs.harvestedEvidenceTotal).toBeGreaterThan(obs.harvestedEvidenceKept);
    expect(obs.harvestedEvidence).toBe(harvested);
    expect(obs.harvestedEvidence).toContain('레코드 생략]');
    expect(obs.harvestedEvidenceKept + (harvested.match(/앞부분 (\d+)레코드 생략/)?.[1] ? Number(harvested.match(/앞부분 (\d+)레코드 생략/)![1]) : 0)).toBe(obs.harvestedEvidenceTotal);
  });

  test('⭐ 최신 하나가 커서 RESULT 만 잘려도 truncated 이지 empty 가 아니다', () => {
    const huge = `EVIDENCE: 아주 긴 검증을 했다 || bun run scripts/ci-typecheck-changed.ts\nRESULT: ${'z'.repeat(5000)}`;
    const harvested = harvestEvidenceLines(`EVIDENCE: 옛것 || old\nRESULT: 옛결과\n${huge}`, 200);
    const obs = harvestedEvidenceObservation(harvested);
    expect(obs.harvestedEvidenceStatus).toBe('truncated');
    expect(obs.harvestedEvidenceKept).toBe(1);
    expect(obs.harvestedEvidenceTotal).toBeGreaterThan(1);
    expect(obs.harvestedEvidence).toBe(harvested);
    expect('harvestedEvidence' in obs).toBe(true);
  });

  test('⭐ 증거가 없으면 empty 이고 본문 키가 없다 — truncated 와 다른 값', () => {
    const empty = harvestedEvidenceObservation(harvestEvidenceLines('그냥 요약\nGOAL-COMPLETE'));
    const alsoEmpty = harvestedEvidenceObservation(undefined);
    const blank = harvestedEvidenceObservation('   \n  ');
    for (const obs of [empty, alsoEmpty, blank]) {
      expect(obs).toEqual({ harvestedEvidenceStatus: 'empty', harvestedEvidenceKept: 0, harvestedEvidenceTotal: 0 });
      expect('harvestedEvidence' in obs).toBe(false);
    }
    const truncated = harvestedEvidenceObservation(harvestEvidenceLines(
      Array.from({ length: 400 }, (_, i) => `EVIDENCE: 주장${i} || cmd${i}\nRESULT: 결과${i}`).join('\n'),
      300,
    ));
    expect(truncated.harvestedEvidenceStatus).not.toBe(empty.harvestedEvidenceStatus);
    expect(truncated.harvestedEvidenceStatus).toBe('truncated');
  });
});

describe('tailWithOmissionMarker — 꼬리 전달의 결손을 정직하게 표시한다', () => {
  test('상한 안이면 원문을 바꾸지 않고, 넘으면 앞부분의 생략 문자 수와 tail을 남긴다', () => {
    expect(tailWithOmissionMarker('unchanged', 2000)).toBe('unchanged');
    const source = `FIRST-${'x'.repeat(2500)}-LAST`;
    const rendered = tailWithOmissionMarker(source, 2000);
    expect(rendered).toMatch(/^\[상한 2000자 — 앞부분 \d+자 생략\]/);
    expect(rendered).toEndWith('-LAST');
    expect(rendered).not.toContain('FIRST-');
    expect(rendered.length).toBeLessThanOrEqual(2000);
  });
});

describe('buildImplementReport — 두 갈래가 같은 조립기를 쓴다', () => {
  const transcript = ['EVIDENCE: tsc 돌렸다 || bun run tsc', 'RESULT: PASS', 'x'.repeat(3000), '끝'].join('\n');

  test('⭐ summary(꼬리)와 evidenceTranscript(수확본)는 다른 예산이다', () => {
    const r = buildImplementReport(transcript, { changed: true, toolCalls: 3, reached: true, timedOut: false });
    expect(r.summary).not.toContain('EVIDENCE:');       // 꼬리에는 밀려서 없다
    expect(r.evidenceTranscript).toContain('bun run tsc');
    expect(r.evidenceTranscript).toContain('PASS');
    expect(r.summary).toContain('[변경: yes · 툴콜 3');
  });

  test('시험 실행 출력은 요약 꼬리 밖에서도 command/result 원문으로 evidenceTranscript에 들어간다', () => {
    const toolOutput = `⏺ Bash({"command":"bun test -- 'src/feature.test.ts'"})\\n ↳ bun test v1.4.2\\n ↳ 3 pass 0 fail`;
    const r = buildImplementReport(`${'x'.repeat(2600)}\\n${toolOutput}`, { changed: true, toolCalls: 1, reached: true, timedOut: false });
    expect(r.summary).toContain('[상한 2000자 — 앞부분');
    expect(r.evidenceTranscript).toContain('[child-test-output] command=bun test --');
    expect(r.evidenceTranscript).toContain('[child-test-result] 3 pass · 0 fail');
  });

  test('⭐ 보고문이 2000자를 넘으면 앞부분 결손을 표시한다', () => {
    const r = buildImplementReport(`CHILD-REPORT-FIRST-${'x'.repeat(2500)}-CHILD-REPORT-LAST`, { changed: true, toolCalls: 1, reached: true, timedOut: false });
    expect(r.summary).toContain('[상한 2000자 — 앞부분');
    expect(r.summary).toContain('CHILD-REPORT-LAST');
    expect(r.summary).not.toContain('CHILD-REPORT-FIRST');
  });

  test('부팅 실패 사유와 PTY id 는 있을 때만 실린다', () => {
    const withPty = buildImplementReport('t', { bootReason: '부팅 못함', changed: false, toolCalls: 0, reached: false, timedOut: true, ptyId: 'self_x' });
    expect(withPty.summary).toContain('[부팅 실패] 부팅 못함');
    expect(withPty.summary).toContain('PTY self_x');
    const without = buildImplementReport('t', { changed: false, toolCalls: 0, reached: false, timedOut: false });
    expect(without.summary).not.toContain('부팅 실패');
    expect(without.summary).not.toContain('PTY ');
  });
});

// ★ 리뷰 7R — 화면 **전체**를 수확하므로 프롬프트에 실린 **예시**가 증거로 오인될 수 있다.
//    지금은 예시가 백틱으로 감싸여 앵커에 안 걸린다. 그 성질을 **계약으로 고정**한다
//    (프롬프트를 고치다 백틱을 떼면 여기서 죽는다).
describe('자식 프롬프트의 EVIDENCE 예시가 수확되지 않는다 (오탐 가드)', () => {
  test('프롬프트 전문을 수확해도 0건이다', () => {
    const promptText = OFF_DIFF_EVIDENCE_PROMPT;
    expect(harvestEvidenceLines(promptText)).toBe('');
    expect(parseOffDiffEvidence(promptText).items).toHaveLength(0);
  });
});

// ★ I-23 — 충전율을 재려면 **정직한 분모**가 필요하다. 관측의 `evidenceStringCount` 는 낱말 수라
//    산문·프롬프트 반향까지 세고, 그것으로 나누면 도달률이 실제보다 낮게 나온다(실측 56% ↔ 98%).
describe('anchoredEvidence — 충전율의 분모는 앵커에 걸린 줄 수다', () => {
  test('⭐ 낱말이 아니라 줄을 센다', () => {
    const text = [
      'EVIDENCE 를 남기라고 했다',            // 산문 — 낱말은 있으나 앵커 아님
      '`EVIDENCE: 예시 || cmd`',              // 프롬프트 반향(백틱) — 앵커 아님
      'EVIDENCE: 진짜 || cmd',
      'RESULT: ok',
    ].join('\n');
    const r = parseOffDiffEvidence(text);
    expect(text.match(/EVIDENCE/gi)).toHaveLength(3);   // 낱말은 셋
    expect(r.anchoredEvidence).toBe(1);                 // ⭐ 줄은 하나
    expect(r.items).toHaveLength(1);
  });

  test('버려진 줄도 분모에 든다(그래야 충전율이 참이다)', () => {
    const r = parseOffDiffEvidence('EVIDENCE: verify 없음\nEVIDENCE: 있다 || cmd\nRESULT: ok');
    expect(r.anchoredEvidence).toBe(2);
    expect(r.items).toHaveLength(1);
    expect(r.discardedMissingVerify).toBe(1);
  });
});

// ★ I-24 / RUN-T6 — 자식은 증거를 썼는데 **골이 요구한 것에 대해** 안 썼다. 태그 동등으로 못 박는다
//    (문면 판정을 요구하면 자식이 휴리스틱을 만들고 그것은 Goodhart 다 — [S] GOAL-S3).
describe('requiredEvidenceFromGoal — 골이 이름으로 요구한다', () => {
  const goal = [
    '## RULES', '- 아무거나',
    '## REQUIRED EVIDENCE',
    '- [tsc] bun run scripts/ci-typecheck-changed.ts',
    '- [mutation] 1회 제한을 풀면 죽는 검사',
    '- [tsc] 중복 태그',
    '',
    '## ACCEPTANCE CRITERIA', '- [무시] 다음 절이므로 안 읽는다',
  ].join('\n');

  test('⭐ 태그와 설명을 읽고 다음 절에서 멈춘다', () => {
    expect(requiredEvidenceFromGoal(goal)).toEqual([
      { tag: 'tsc', raw: '- [tsc] bun run scripts/ci-typecheck-changed.ts' },
      { tag: 'mutation', raw: '- [mutation] 1회 제한을 풀면 죽는 검사' },
    ]);
  });

  test('골의 || 뒤 명령을 선택 필드로 보존하고 하니스가 직접 실행한다', () => {
    const withCommand = '## REQUIRED EVIDENCE\n- [shell] 하니스 셸 체크 || echo ok';
    expect(requiredEvidenceFromGoal(withCommand)).toEqual([
      { tag: 'shell', raw: '- [shell] 하니스 셸 체크 || echo ok', verifyCommand: 'echo ok' },
    ]);
    const [run] = runRequiredEvidenceChecks(withCommand, process.cwd());
    expect(run).toMatchObject({ tag: 'shell', command: 'echo ok', exitCode: 0, stdout: 'ok\n' });
    expect(run?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('저작 판정 신호 rg와 bun test를 실제 실행하고 같은 원문 결과를 돌려준다', () => {
    for (const command of [
      'rg -n 미측정 docs/plans/plan.md',
      'bun test src/example.test.ts',
    ]) {
      const calls: string[] = [];
      const goal = `## 판정 신호\n- Candidate decision signal:\n  - Condition: ${command}\n`;
      const checks = runRequiredEvidenceChecks(goal, process.cwd(), 'run-signal-test', {
        run: (actual) => { calls.push(actual); return { status: 0, stdout: 'observed\\n', stderr: '', error: undefined }; },
      });
      expect(calls).toEqual([command]);
      expect(authoredSignalExecution(goal, checks)).toEqual({ command, exitCode: 0, stdout: 'observed\\n', stderr: '' });
    }
  });

  test('저작 판정 신호의 셸 조합은 실행하지 않는다', () => {
    const command = 'rg foo file && touch /tmp/nope';
    const goal = `## 판정 신호\n- Candidate decision signal:\n  - Condition: ${command}\n`;
    const calls: string[] = [];
    const checks = runRequiredEvidenceChecks(goal, process.cwd(), 'run-signal-unsafe', {
      run: (actual) => { calls.push(actual); return { status: 0, stdout: '', stderr: '', error: undefined }; },
    });
    expect(calls).toEqual([]);
    expect(authoredSignalExecution(goal, checks)).toBeUndefined();
  });

  test('저작 판정 신호에서 셸 래퍼와 원격 셸은 실행하지 않는다', () => {
    for (const command of ["bash -c 'rg foo file'", "sh -c 'rg foo file'", 'ssh host rg foo file']) {
      const goal = `## 판정 신호\n- Candidate decision signal:\n  - Condition: ${command}\n`;
      const calls: string[] = [];
      const checks = runRequiredEvidenceChecks(goal, process.cwd(), 'run-signal-wrapper', {
        run: (actual) => { calls.push(actual); return { status: 0, stdout: '', stderr: '', error: undefined }; },
      });
      expect(calls).toEqual([]);
      expect(authoredSignalExecution(goal, checks)).toBeUndefined();
    }
  });

  test('|| 없는 기존 요구는 verifyCommand 없이 실행 0건이다', () => {
    const withoutCommand = '## REQUIRED EVIDENCE\n- [legacy] 기존 요구';
    expect(requiredEvidenceFromGoal(withoutCommand)).toEqual([
      { tag: 'legacy', raw: '- [legacy] 기존 요구' },
    ]);
    expect(runRequiredEvidenceChecks(withoutCommand, process.cwd())).toEqual([]);
  });

  test('실패한 셸 체크도 관측값으로 반환하고 던지지 않는다', () => {
    const [run] = runRequiredEvidenceChecks('## REQUIRED EVIDENCE\n- [nonzero] 실패 관측 || exit 7', process.cwd());
    expect(run).toMatchObject({ tag: 'nonzero', command: 'exit 7', exitCode: 7, stdout: '' });
  });

  test('⛔ 다음 절에서 멈춘다 — `#`·`###` 도 절이다', () => {
    for (const heading of ['# 큰 제목', '### 작은 제목', '## 다음 절']) {
      const g = `## REQUIRED EVIDENCE\n- [ok] 안쪽\n${heading}\n- [밖] 바깥`;
      expect(requiredEvidenceFromGoal(g).map((i) => i.tag)).toEqual(['ok']);
    }
  });

  test('⚠️ 받는 표기를 계약으로 고정한다 — 불릿 `-`/`*` · 대괄호 앞 공백 선택', () => {
    const g = '## REQUIRED EVIDENCE\n- [a] 하이픈 공백\n-[b] 하이픈 붙임\n* [c] 별표\n  - [d] 들여쓰기';
    expect(requiredEvidenceFromGoal(g).map((i) => i.tag)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('⚠️ 코드블록 안의 예시도 절로 읽는다(알려진 관대함 · 골에 예시를 넣지 마라)', () => {
    const g = '## RULES\n```\n## REQUIRED EVIDENCE\n- [예시] 문서에서 인용\n```';
    expect(requiredEvidenceFromGoal(g).map((i) => i.tag)).toEqual(['예시']);
  });

  test('⛔ 제목이 없으면 추측하지 않는다(요구 0)', () => {
    expect(requiredEvidenceFromGoal('## RULES\n- bun run tsc 를 돌려라')).toEqual([]);
  });

  test('⛔ 다른 제목은 계약이 아니다 · ⚠️ 표기 차이(대소문자·공백)는 같은 제목이다', () => {
    expect(requiredEvidenceFromGoal('## REQUIRED EVIDENCE NOTES\n- [tsc] x')).toEqual([]);
    expect(requiredEvidenceFromGoal('## REQUIRED EVIDENCES\n- [tsc] x')).toEqual([]);
    // 표기 차이는 받는다 — 여기서 엄격하면 저작자가 조용히 요구 0 을 얻는다
    expect(requiredEvidenceFromGoal('  ## required evidence  \n- [tsc] x')).toHaveLength(1);
  });

  test('⛔ 태그만 있고 무엇인지 없으면 요구가 아니다(채울 수 없는 계약 금지)', () => {
    expect(requiredEvidenceFromGoal('## REQUIRED EVIDENCE\n- [tsc]\n- [ok] 실체가 있다')).toEqual([
      { tag: 'ok', raw: '- [ok] 실체가 있다' },
    ]);
  });

  test('⛔ 구분자 뒤 명령만 있고 설명이 없으면 요구가 아니다', () => {
    expect(requiredEvidenceFromGoal('## REQUIRED EVIDENCE\n- [shell] || echo ok\n- [ok] 실체가 있다 || echo ok')).toEqual([
      { tag: 'ok', raw: '- [ok] 실체가 있다 || echo ok', verifyCommand: 'echo ok' },
    ]);
  });

  test('요구가 없으면 프롬프트에 아무 줄도 안 붙인다(빈 계약 금지)', () => {
    expect(renderRequiredEvidencePrompt([])).toEqual([]);
    const rendered = renderRequiredEvidencePrompt(requiredEvidenceFromGoal(goal)).join('\n');
    // ⭐ 저작자가 고른 낱말이 **재작성되지 않는다**(들여쓰기만 붙는다)
    expect(rendered).toContain('- [tsc] bun run scripts/ci-typecheck-changed.ts');
    expect(rendered).toContain('- [mutation] 1회 제한을 풀면 죽는 검사');
    expect(rendered).toContain('EVIDENCE: [tsc]');
  });

  test('Author limitation이 태그와 전체 설명을 명시적으로 일치시킬 때만 요구를 남긴 채 덮임 근거를 붙인다', () => {
    const withLimitation = [
      '## REQUIRED EVIDENCE',
      '- [wiring] changed unit is reached from the existing caller',
      '- [preservation] existing contract remains true',
      '## 답하지 못하는 것',
      '- Author limitation: changed unit is reached from the existing caller',
    ].join('\n');
    expect(requiredEvidenceFromGoal(withLimitation)).toEqual([
      {
        tag: 'wiring',
        raw: '- [wiring] changed unit is reached from the existing caller',
        coveredByLimitation: '- Author limitation: changed unit is reached from the existing caller',
      },
      { tag: 'preservation', raw: '- [preservation] existing contract remains true' },
    ]);
  });

  test('Author limitation은 정확히 `## 답하지 못하는 것` 절에서만 읽어 예시·수용기준의 문구로 덮지 않는다', () => {
    const outOfSection = [
      '## REQUIRED EVIDENCE',
      '- [wiring] changed unit is reached from the existing caller',
      '## ACCEPTANCE CRITERIA',
      '- Author limitation: changed unit is reached from the existing caller',
      '## EXAMPLE',
      '- Author limitation: changed unit is reached from the existing caller',
    ].join('\n');
    const required = requiredEvidenceFromGoal(outOfSection);
    expect(required).toEqual([
      { tag: 'wiring', raw: '- [wiring] changed unit is reached from the existing caller' },
    ]);
    expect(authorLimitationCountFromGoal(outOfSection)).toBe(0);
    expect(coverRequiredEvidence(required, [])).toEqual({
      covered: [], missing: ['wiring'], coveredByLimitation: [], uncovered: ['wiring'], coveredByLimitationCount: 0, uncoveredCount: 1,
    });
  });

  test('Author limitation의 대소문자 차이는 locale과 무관하게 허용한다', () => {
    const withCaseDifference = [
      '## REQUIRED EVIDENCE',
      '- [wiring] Changed Unit Is Reached From The Existing Caller',
      '## 답하지 못하는 것',
      '- Author limitation: changed unit is reached from the existing caller',
    ].join('\n');
    expect(requiredEvidenceFromGoal(withCaseDifference)).toEqual([
      {
        tag: 'wiring',
        raw: '- [wiring] Changed Unit Is Reached From The Existing Caller',
        coveredByLimitation: '- Author limitation: changed unit is reached from the existing caller',
      },
    ]);
  });

  test('Author limitation의 부분 문구·다른 태그·자유문은 보수적으로 덮지 않는다', () => {
    const requirements = [
      '## REQUIRED EVIDENCE',
      '- [wiring] existing caller reaches changed unit',
      '- [preservation] existing contract remains true',
      '## 답하지 못하는 것',
      '- Author limitation: [wiring] existing caller reaches',
      '- Author limitation: [other] existing contract remains true',
      '- Author limitation: this requirement cannot be answered',
    ].join('\n');
    expect(requiredEvidenceFromGoal(requirements)).toEqual([
      { tag: 'wiring', raw: '- [wiring] existing caller reaches changed unit' },
      { tag: 'preservation', raw: '- [preservation] existing contract remains true' },
    ]);
  });
});

describe('coverRequiredEvidence — 판정은 태그 동등이지 해석이 아니다', () => {
  const required = requiredEvidenceFromGoal('## REQUIRED EVIDENCE\n- [tsc] x\n- [mutation] y');

  test('⭐ 태그를 단 증거만 충족으로 센다', () => {
    const parsed = parseOffDiffEvidence([
      'EVIDENCE: [tsc] 타입검사 돌렸다 || bun run tsc', 'RESULT: PASS',
      'EVIDENCE: 뮤테이션 비슷한 걸 했다 || cmd', 'RESULT: ok',   // ⛔ 태그가 없다 — 안 센다
    ].join('\n'));
    expect(coverRequiredEvidence(required, parsed.items)).toEqual({ covered: ['tsc'], missing: ['mutation'], coveredByLimitation: [], uncovered: ['mutation'], coveredByLimitationCount: 0, uncoveredCount: 1 });
  });

  test('⛔ 대소문자가 다르면 충족이 아니다 — 동등이지 유사가 아니다', () => {
    const parsed = parseOffDiffEvidence([
      'EVIDENCE: [TSC] 대문자 태그 || cmd', 'RESULT: ok',
      'EVIDENCE: [mutation-2] 비슷한 태그 || cmd', 'RESULT: ok',
    ].join('\n'));
    expect(coverRequiredEvidence(required, parsed.items)).toEqual({ covered: [], missing: ['tsc', 'mutation'], coveredByLimitation: [], uncovered: ['tsc', 'mutation'], coveredByLimitationCount: 0, uncoveredCount: 2 });
  });

  test('같은 설명을 공유하는 복수 요구는 단일 limitation으로 덮지 않는다', () => {
    const ambiguous = requiredEvidenceFromGoal([
      '## REQUIRED EVIDENCE',
      '- [first] shared requirement',
      '- [second] shared requirement',
      '## 답하지 못하는 것',
      '- Author limitation: shared requirement',
    ].join('\n'));
    expect(ambiguous).toEqual([
      { tag: 'first', raw: '- [first] shared requirement' },
      { tag: 'second', raw: '- [second] shared requirement' },
    ]);
    expect(coverRequiredEvidence(ambiguous, [])).toEqual({
      covered: [], missing: ['first', 'second'], coveredByLimitation: [], uncovered: ['first', 'second'], coveredByLimitationCount: 0, uncoveredCount: 2,
    });
  });

  test('선언 덮임 수와 실제 증거 충족은 분리하고, 덮이지 않은 요구만 uncovered로 남긴다', () => {
    const withLimitation = requiredEvidenceFromGoal([
      '## REQUIRED EVIDENCE',
      '- [wiring] changed unit is reached from the existing caller',
      '- [preservation] existing contract remains true',
      '## 답하지 못하는 것',
      '- Author limitation: changed unit is reached from the existing caller',
    ].join('\n'));
    expect(coverRequiredEvidence(withLimitation, parseOffDiffEvidence('EVIDENCE: [preservation] checked || cmd\nRESULT: ok').items))
      .toEqual({ covered: ['preservation'], missing: ['wiring'], coveredByLimitation: ['wiring'], uncovered: [], coveredByLimitationCount: 1, uncoveredCount: 0 });
  });

  test('복수 선언은 해당 정확 일치 요구만 덮고 같은 입력은 같은 값을 낸다', () => {
    const goalWithTwoLimitations = [
      '## REQUIRED EVIDENCE',
      '- [one] first explicit requirement',
      '- [two] second explicit requirement',
      '- [three] third explicit requirement',
      '## 답하지 못하는 것',
      '- Author limitation: first explicit requirement',
      '- Author limitation: third explicit requirement',
    ].join('\n');
    const first = requiredEvidenceFromGoal(goalWithTwoLimitations);
    expect(first).toEqual(requiredEvidenceFromGoal(goalWithTwoLimitations));
    expect(coverRequiredEvidence(first, [])).toEqual({
      covered: [], missing: ['one', 'two', 'three'], coveredByLimitation: ['one', 'three'], uncovered: ['two'], coveredByLimitationCount: 2, uncoveredCount: 1,
    });
  });

  test('요구가 0이면 선언 유무와 관계없이 덮임·미덮임·실제 충족도 모두 0이다', () => {
    expect(coverRequiredEvidence([], parseOffDiffEvidence('EVIDENCE: a || b\nRESULT: c').items))
      .toEqual({ covered: [], missing: [], coveredByLimitation: [], uncovered: [], coveredByLimitationCount: 0, uncoveredCount: 0 });
    expect(requiredEvidenceFromGoal('## 답하지 못하는 것\n- Author limitation: [wiring] x')).toEqual([]);
  });

  test('리뷰 intent는 선언 덮임·미덮임과 0-요구 선언을 실제 출력에서 구분한다', () => {
    const covered = buildReviewIntent({
      goal: '골',
      evidenceCoverage: {
        required: 2, covered: 1, missing: ['wiring'], coveredByLimitation: ['wiring'], uncovered: [],
        coveredByLimitationCount: 1, uncoveredCount: 0, limitationCount: 1,
      },
    });
    expect(covered).toContain('Author limitation 선언 1개 · 선언으로 덮임: wiring · 선언·자식 보고 어느 쪽으로도 덮이지 않음: 없음');
    expect(covered).toContain('골이 요구한 태그 2개 · 자식 보고에서 매칭 1개 · 누락: wiring');

    const zeroRequiredWithLimitation = buildReviewIntent({
      goal: '골',
      evidenceCoverage: {
        required: 0, covered: 0, missing: [], coveredByLimitation: [], uncovered: [],
        coveredByLimitationCount: 0, uncoveredCount: 0, limitationCount: 1,
      },
    });
    const zeroRequiredWithoutLimitation = buildReviewIntent({
      goal: '골',
      evidenceCoverage: {
        required: 0, covered: 0, missing: [], coveredByLimitation: [], uncovered: [],
        coveredByLimitationCount: 0, uncoveredCount: 0, limitationCount: 0,
      },
    });
    expect(zeroRequiredWithLimitation).toContain('골이 요구한 태그 0개');
    expect(zeroRequiredWithLimitation).toContain('Author limitation 선언 1개');
    expect(zeroRequiredWithoutLimitation).not.toContain('골이 요구한 증거 태그');
  });

  test('limitation 수는 요구 0인 골에서도 선언 부재와 결정론적으로 구분된다', () => {
    const withLimitation = '## 답하지 못하는 것\n- Author limitation: [wiring] x';
    expect(authorLimitationCountFromGoal(withLimitation)).toBe(1);
    expect(authorLimitationCountFromGoal('## 답하지 못하는 것\n- 없다.')).toBe(0);
    expect(authorLimitationCountFromGoal(withLimitation)).toBe(authorLimitationCountFromGoal(withLimitation));
  });
});

describe('EVIDENCE-WIRING-EXEMPT', () => {
  test('a goal that rules wiring out exempts [wiring] as a declared limitation; other goals keep it', () => {
    for (const marker of ['배선·부작용 0(순수 함수만)', '배선 0', '순수 함수만', 'no wiring', 'pure function only']) {
      expect(goalDeclaresNoWiring(`ask: ${marker}`)).toBe(true);
      const [wiring] = requiredEvidenceFromGoal(`ask: ${marker}\n## REQUIRED EVIDENCE\n- [wiring] caller connection`);
      expect(wiring?.coveredByLimitation).toBeDefined();
      expect(coverRequiredEvidence([wiring!], []).uncovered).toEqual([]);
    }
    for (const text of ['배선 03 건', '배선한다', 'wire it from runTrain']) expect(goalDeclaresNoWiring(text)).toBe(false);
    const [kept] = requiredEvidenceFromGoal('ask: wire it\n## REQUIRED EVIDENCE\n- [wiring] caller connection');
    expect(kept?.coveredByLimitation).toBeUndefined();
  });

  test('a passing bun test check covers its tag; a failing, empty or non-bun check does not', () => {
    const run = (command: string, exitCode: number | null, stderr: string, stdout = '') => ({ tag: 'requested', command, exitCode, stdout, stderr, durationMs: 1 });
    const pass = run("bun test -- 'a.test.ts'", 0, ' 5 pass\n 0 fail\nRan 5 tests');
    expect(settleUncoveredEvidence(['requested'], { checks: [pass] })).toEqual({ uncovered: [], coveredByCheck: ['requested'], coveredByGate: [] });
    for (const bad of [run("bun test -- 'a.test.ts'", 1, ' 4 pass\n 1 fail'), run("bun test -- 'a.test.ts'", 0, ' 0 pass\n 0 fail'),
      run('echo ok', 0, '', ' 5 pass\n 0 fail'), run("bun test -- 'a.test.ts'", null, '')]) {
      expect(settleUncoveredEvidence(['requested'], { checks: [bad] }).uncovered).toEqual(['requested']);
    }
  });

  test('a commandless [preservation] is covered by a passed gate; one with its own command, or a failed gate, is not', () => {
    const required = requiredEvidenceFromGoal('## REQUIRED EVIDENCE\n- [preservation] still true\n- [other] something');
    expect(settleUncoveredEvidence(['preservation', 'other'], { gatePassed: true, required })).toEqual({ uncovered: ['other'], coveredByCheck: [], coveredByGate: ['preservation'] });
    expect(settleUncoveredEvidence(['preservation'], { gatePassed: false, required }).uncovered).toEqual(['preservation']);
    const withCommand = requiredEvidenceFromGoal('## REQUIRED EVIDENCE\n- [preservation] still true || exit 1');
    expect(settleUncoveredEvidence(['preservation'], { gatePassed: true, required: withCommand }).uncovered).toEqual(['preservation']);
  });

  test('the check run keeps stderr — where bun test writes its summary', () => {
    const [r] = runRequiredEvidenceChecks("## REQUIRED EVIDENCE\n- [s] stderr || printf ' 1 pass\\n 0 fail\\n' >&2", process.cwd());
    expect(r).toMatchObject({ exitCode: 0, stdout: '', stderr: ' 1 pass\n 0 fail\n' });
  });
});
