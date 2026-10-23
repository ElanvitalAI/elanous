// review-observation — 절단 정책·정직 표기 회귀 가드.
//
// 이 모듈의 존재 이유는 **관측 갭 수리**다(수동 `elanous self review` 의 verdict 가 보존되지 않았다).
// 절단이 과하면 감사가 안 되고 느슨하면 로그가 폭주한다 — 그 균형을 여기서 고정한다.
import { describe, expect, test } from 'bun:test';
import { buildReviewObservation, safeLogText } from './review-observation.js';

// ⚠️⚠️ **테스트 입력 함정**(세 번 밟았다) — `'x'.repeat(N)` 같은 **연속 영숫자**는 `redact()` 의
//    "32자 이상 무작위 토큰" 규칙에 걸려 `***`(3자)이 된다. 길이 경계를 재려면 **공백·한글이 섞인
//    자연문**을 쓴다. 이 파일에서 길이를 단정할 때는 항상 이걸 확인할 것.
//
// ⚠️ **고정 경계값**(리뷰 must-fix) — 운영 상수를 import 해 입력·기대를 함께 계산하면 상한이 8→10000
//    으로 커져도 테스트가 통과해 **정책이 잠기지 않는다**(Goodhart). 숫자를 여기 박아 정책을 고정한다.
const LIMIT = 8;
const CHARS = 160;
import type { ReviewResult } from './pr-reviewer.js';

const base = (over: Partial<ReviewResult> = {}): ReviewResult =>
  ({ verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true, ...over }) as ReviewResult;

const obs = (review: ReviewResult, intent = 'x') =>
  buildReviewObservation({ pr: '5500', model: 'gpt-5.6-sol', intent, review, durationMs: 1234 });

describe('buildReviewObservation — 감사에 필요한 최소 집합', () => {
  test('verdict·개수·소요시간을 싣는다', () => {
    const o = obs(base({ verdict: 'fail', mustFix: ['a', 'b'], shouldFix: ['c'] }));
    expect(o.verdict).toBe('fail');
    expect(o.mustFix).toBe(2);
    expect(o.scopeRevertMustFix).toBe(0);
    expect(o.shouldFix).toBe(1);
    expect(o.durationMs).toBe(1234);
    expect(o.pr).toBe('5500');
  });

  test('범위 사유의 되돌림/분리 MUST-FIX 빈도를 verdict·원문을 바꾸지 않고 센다', () => {
    const mustFix = [
      'decomposeShadowGoals 의 소비 변경은 이 목표와 무관하니 되돌리거나 별도 PR 로 분리해야 한다',
      '테스트가 clean 갈래를 검증하지 않는다',
    ];
    const o = obs(base({ verdict: 'fail', mustFix }));
    expect(o).toMatchObject({ verdict: 'fail', mustFix: 2, scopeRevertMustFix: 1 });
    expect(o.mustFixItems).toEqual(mustFix);
  });

  test('SCOPE-ESCAPE-AS-REFINE — 강등된 범위-되돌림 지적 수를 따로 센다(관측 유지)', () => {
    const demoted = 'decomposeShadowGoals 의 소비 변경은 이 목표와 무관하니 되돌리거나 별도 PR 로 분리해야 한다';
    const o = obs(base({ verdict: 'warn', mustFix: [], shouldFix: [demoted], scopeRevertDemoted: [demoted] }));
    expect(o).toMatchObject({ verdict: 'warn', mustFix: 0, scopeRevertMustFix: 0, scopeRevertDemoted: 1, shouldFix: 1 });
    expect(obs(base({ verdict: 'pass', mustFix: [] })).scopeRevertDemoted).toBe(0);
  });

  test('⭐ 지적 앞부분을 남긴다 — "같은 지적이 반복되나"를 로그만으로 보려면 필요하다', () => {
    const o = obs(base({ verdict: 'fail', mustFix: ['풀 폴백이 되살아나는 구멍'] }));
    expect(o.mustFixItems).toEqual(['풀 폴백이 되살아나는 구멍']);
  });

  test('공백을 접어 한 줄로 만든다(로그 가독)', () => {
    const o = obs(base({ mustFix: ['a\n  b\t c'] }));
    expect(o.mustFixItems[0]).toBe('a b c');
  });

  test('항목 수 상한은 **8**이고 초과분은 omitted 로 개수를 남긴다(정직 표기)', () => {
    const many = Array.from({ length: LIMIT + 3 }, (_, i) => `item${i}`);
    const o = obs(base({ mustFix: many }));
    expect(o.mustFixItems.length).toBe(8);
    expect(o.mustFix).toBe(many.length);          // 개수는 전체를 센다
    expect(o.omitted).toBe(3);                    // 로그에 안 실린 수를 명시
  });

  test('must/should 양쪽 생략분이 omitted 에 합산된다', () => {
    const many = Array.from({ length: LIMIT + 2 }, (_, i) => `i${i}`);
    const o = obs(base({ mustFix: many, shouldFix: many }));
    expect(o.omitted).toBe(4);
  });

  test('항목 문자 상한은 **160**이다(로그 비대 방지)', () => {
    // ⚠️ 입력을 `'x'.repeat(...)` 로 두면 **긴 무작위 토큰 마스킹**에 걸려 `***`(3자)이 된다 —
    //    상한이 아니라 마스킹을 재게 된다(테스트가 실제로 그걸 잡았다). 자연문으로 길이를 만든다.
    const natural = '게이트 판정이 틀렸다 '.repeat(30);          // 공백 포함 → 토큰 패턴 미매치
    const o = obs(base({ mustFix: [natural] }));
    expect(o.mustFixItems[0]?.length).toBe(160);
  });

  test('⭐ 상한이 커져도 통과하지 않는다 — 9번째 항목은 잘리고 161자는 160자가 된다', () => {
    // ⚠️ `'y'.repeat(161)` 은 **무작위 토큰 마스킹**에 먹혀 `***` 가 된다 → 160 경계를 못 잰다.
    //    (같은 함정을 앞 라운드에도 밟았다.) 공백 포함 자연문으로 길이를 만든다.
    const natural = '게이트 판정 서술 '.repeat(40);            // 160자 초과·토큰 패턴 미매치
    expect(natural.length).toBeGreaterThan(160);
    const o = obs(base({ mustFix: Array.from({ length: 9 }, () => natural) }));
    expect(o.mustFixItems.length).toBe(8);                    // 9번째는 잘린다
    for (const it of o.mustFixItems) expect(it.length).toBe(160);
  });

  test('intent 는 원문이 아니라 길이만 남긴다(로그 비대·비밀 유출 방지)', () => {
    const o = obs(base(), '수용기준 1..N 아주 긴 텍스트');
    expect(o.intentChars).toBe('수용기준 1..N 아주 긴 텍스트'.length);
    expect(JSON.stringify(o)).not.toContain('수용기준');
  });
});

describe('buildReviewObservation — ACP fallback provenance', () => {
  test('폴백을 시도하지 않은 이유를 done 관측에 보존한다', () => {
    const o = buildReviewObservation({
      pr: '5500', model: 'api:gpt', intent: 'x', review: base(), durationMs: 1,
      fallbackAttempted: false, fallbackNotAttemptedReason: 'primary-review-succeeded',
    });
    expect(o).toMatchObject({ fallbackAttempted: false, fallbackNotAttemptedReason: 'primary-review-succeeded' });
    expect(o).not.toHaveProperty('fallbackBackend');
  });

  test('자동 후보에서 제외한 백엔드와 사유를 안전하게 싣는다', () => {
    const o = buildReviewObservation({
      pr: '5500', model: 'acp:claude', intent: 'x', review: base(), durationMs: 1,
      skippedAcpFallbackBackends: [{ backend: 'gemini', reason: 'IneligibleTierError (free-tier UNSUPPORTED_CLIENT)' }],
    });
    expect(o).toMatchObject({
      skippedAcpFallbackBackends: [{ backend: 'gemini', reason: 'IneligibleTierError (free-tier UNSUPPORTED_CLIENT)' }],
    });
  });

  test('자동 후보 제외 provenance가 없으면 payload에서 생략한다', () => {
    expect('skippedAcpFallbackBackends' in obs(base())).toBe(false);
  });
});

describe('buildReviewObservation — diff 절단 계량(미지정은 구 호출자 무회귀)', () => {
  test('diff 계량이 주어지면 숫자·불리언을 그대로 싣는다', () => {
    const o = buildReviewObservation({
      pr: '5500', model: 'gpt-5.6-sol', intent: 'x', review: base(), durationMs: 1,
      diffTruncated: true, diffShownChars: 1000, diffTotalChars: 4000, diffOmittedFiles: 3,
    });
    expect(o).toMatchObject({ diffTruncated: true, diffShownChars: 1000, diffTotalChars: 4000, diffOmittedFiles: 3 });
  });

  test('diff 계량이 미지정이면 payload에서 생략한다', () => {
    const o = obs(base());
    expect('diffTruncated' in o).toBe(false);
    expect('diffShownChars' in o).toBe(false);
    expect('diffTotalChars' in o).toBe(false);
    expect('diffOmittedFiles' in o).toBe(false);
  });
});

describe('buildReviewObservation — referenced file 계량(미지정은 구 호출자 무회귀)', () => {
  test('안전 reader가 파일을 열었는지와 몇 번 열었는지를 그대로 싣는다', () => {
    const o = buildReviewObservation({
      pr: '5500', model: 'gpt-5.6-sol', intent: 'x', review: base(), durationMs: 1,
      referencedFilesOpened: true, referencedFilesRead: 2,
    });
    expect(o).toMatchObject({ referencedFilesOpened: true, referencedFilesRead: 2 });
  });

  test('reader 계량이 미지정이면 payload에서 생략한다', () => {
    const o = obs(base());
    expect('referencedFilesOpened' in o).toBe(false);
    expect('referencedFilesRead' in o).toBe(false);
  });
});

describe('buildReviewObservation — intent 절단 계량(미지정은 구 호출자 무회귀)', () => {
  test('절단 계량이 주어지면 잘린 전 길이와 절을 그대로 싣고 intentChars는 실제 수신 길이다', () => {
    const o = buildReviewObservation({
      pr: '5500', model: 'gpt-5.6-sol', intent: '수신된 intent', review: base(), durationMs: 1,
      intentTruncated: true, intentTotalChars: 5_000, intentSection: '검증',
    });
    expect(o).toMatchObject({ intentTruncated: true, intentTotalChars: 5_000, intentSection: '검증' });
    expect(o.intentChars).toBe('수신된 intent'.length);
  });

  test('절단 계량이 미지정이면 새 키는 payload에서 생략한다', () => {
    const o = obs(base());
    expect('intentTruncated' in o).toBe(false);
    expect('intentTotalChars' in o).toBe(false);
    expect('intentSection' in o).toBe(false);
  });
});

describe('buildReviewObservation — reviewed 플래그(감사 핵심)', () => {
  test('⭐ 명시 false 만 false — fail-soft pass 와 진짜 PASS 를 구분한다', () => {
    expect(obs(base({ reviewed: false })).reviewed).toBe(false);
    expect(obs(base({ reviewed: true })).reviewed).toBe(true);
  });

  test('⚠️ 미지정은 false 로 낮추지 않는다 — 미지정 = 구버전 경로이지 "리뷰 안 됨"이 아니다', () => {
    const r = { verdict: 'pass', mustFix: [], shouldFix: [] } as unknown as ReviewResult;
    expect(obs(r).reviewed).toBe(true);
  });
});

describe('buildReviewObservation — 결측 방어', () => {
  test('mustFix/shouldFix 가 없어도 0 으로 안전하다', () => {
    const r = { verdict: 'pass' } as unknown as ReviewResult;
    const o = obs(r);
    expect(o.mustFix).toBe(0);
    expect(o.shouldFix).toBe(0);
    expect(o.omitted).toBe(0);
    expect(o.mustFixItems).toEqual([]);
  });
});

// ── 비밀 마스킹 (리뷰 must-fix · 로그는 logs.db 에 **영속**된다) ────────────────────────
//
// 리뷰 지적은 **PR diff 에서 유래한 모델 출력**이라 diff 에 있던 토큰이 인용될 수 있다.
// 그대로 실으면 "코드에서 지운 비밀이 로그에 남는" 재노출이 된다.
describe('buildReviewObservation — 비밀 마스킹(공용 `redactSecretText` 위임)', () => {
  const item = (m: string) => obs(base({ verdict: 'fail', mustFix: [m] })).mustFixItems[0] ?? '';

  // ⚠️ **정책 출처가 바뀌었다**(2026-07-27 · 대표 지시 "재발명 말고 검증된 것을 써라"):
  //    자체 정규식 → **공용 `redactSecretText`**(`debug/log.ts` · **gitleaks 기본 config(MIT) 규칙 이식**).
  //    ⇒ 종전 자체 구현의 *"32자 이상 무작위 토큰"* 이라는 **포괄 규칙은 채택하지 않았다**:
  //       gitleaks 는 그런 blanket 규칙 대신 **구체 패턴 + 엔트로피**를 쓴다. 포괄 규칙은 해시·base64
  //       fixture·긴 식별자를 무차별 훼손해 **로그를 못 쓰게 만든다**(이 파일 테스트가 실제로 3번 걸렸다).
  //    ⇒ 트레이드오프: 알려지지 않은 형식의 토큰은 놓칠 수 있다. 그건 §근본 방어(원문을 길게 싣지
  //       않는다·160자 상한)가 받는다.
  test('⭐ 알려진 접두 토큰을 가린다(gitleaks 규칙)', () => {
    expect(item(`키가 sk-ant-api03-${'a'.repeat(93)}AA 로 하드코딩됨`)).toContain('sk-ant-api03-***');
    expect(item(`ghp_${'A'.repeat(36)} 노출`)).toContain('ghp_***');
    expect(item('AKIAIOSFODNN7EXAMPLE 사용')).toContain('AKIA***');
    expect(item('xoxb-1234567890-1234567890-abcdefghij 노출')).toContain('xoxb-***');
    expect(item(`AIza${'B'.repeat(35)} 노출`)).toContain('AIza***');
  });

  test('⭐ Authorization 헤더를 가린다', () => {
    expect(item('Authorization: Bearer abcdefghijklmnopqrst')).not.toContain('abcdefghijklmnopqrst');
  });

  test('⭐ key=value 형태의 비밀 키워드를 가린다', () => {
    expect(item('api_key = "supersecretvalue" 를 커밋')).toContain('api_key = ***');
    expect(item('password: hunter2xyz 노출')).toContain('password: ***');
    expect(item('token=abcd1234efgh')).toContain('token=***');
  });

  test('⚠️ 정상 서술은 훼손하지 않는다 — 오탐이면 로그가 못 쓰게 된다', () => {
    const normal = 'src/self-implement/gate-scope.ts 의 판정이 틀렸다';
    expect(item(normal)).toBe(normal);
    const normal2 = 'unverified 가 개수만 실려 Goodhart 테스트가 됐다';
    expect(item(normal2)).toBe(normal2);
  });

  test('마스킹은 절단 **전에** 적용된다(잘린 조각으로 비밀이 남지 않게)', () => {
    const long = `앞부분 ${'서술 '.repeat(40)} sk-ant-api03-${'z'.repeat(93)}AA`;
    // 160자 절단 전에 마스킹되므로 원문 본문이 어디에도 남지 않는다.
    expect(item(long)).not.toContain('zzzzzzzz');
  });
});

describe('buildReviewObservation — 스칼라 상한(payload 비대 방지 완결)', () => {
  test('pr·model 도 길이 상한 64 를 넘지 않는다', () => {
    const o = buildReviewObservation({
      pr: 'pr 번호 서술 '.repeat(30), model: '모델 이름 서술 '.repeat(30), intent: 'i',
      review: base(), durationMs: 1,
    });
    expect(o.pr.length).toBe(64);
    expect(o.model.length).toBe(64);
  });
});

// ── safeLogText — 모든 self-review 발화가 쓰는 안전 변환 (리뷰 must-fix 2R) ─────────────
//
// 종전엔 `done` 만 마스킹·상한을 탔고 `start`(pr·model·backend)·`diff-fail`(pr·stderr)은 **원문**이
// 영속 로그에 들어갔다. 한 함수로 모아 우회를 없앴으므로 그 함수를 직접 잠근다.
describe('safeLogText — 마스킹 후 절단', () => {
  test('기본 상한은 64자', () => {
    expect(safeLogText('가'.repeat(200)).length).toBe(64);
  });

  test('상한을 넘겨줄 수 있다(diff-fail 은 160)', () => {
    expect(safeLogText('가'.repeat(500), 160).length).toBe(160);
  });

  test('⭐ 마스킹이 절단보다 **먼저** — 잘린 조각에 비밀이 남지 않는다', () => {
    const s = `stderr: 인증 실패 sk-SECRETVALUE0123456789 ${'끝'.repeat(100)}`;
    const out = safeLogText(s, 160);
    expect(out).not.toContain('SECRETVALUE');
    expect(out).toContain('sk-***');
  });

  test('공백을 접고 트림한다', () => {
    expect(safeLogText('  a\n  b  ')).toBe('a b');
  });

  test('null/undefined 도 빈 문자열로 안전하다', () => {
    expect(safeLogText(undefined as unknown as string)).toBe('');
  });
});

// ─── 실패 이유가 «영속 관측»에 실린다 (#7495 should-fix) ─────────────────────
describe('buildReviewObservation — failureReason', () => {
  test('reviewed:false ⊕ 이유가 있으면 관측에 싣는다', () => {
    const o = buildReviewObservation({
      pr: '1', model: 'acp:x', intent: '', durationMs: 1,
      review: { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: false, failureReason: 'Unknown ACP backend "zz"' },
    });
    expect(o.reviewed).toBe(false);
    // ⛔ 이 단언이 없으면 이유를 다시 버려도 아무것도 안 깨진다 — --json 없이는 원인을 못 본다.
    expect(o.failureReason).toContain('Unknown ACP backend');
  });

  test('⛔ 미검토(이유 없음)는 칸이 «안» 생긴다 — 실패와 미검토를 구분한다', () => {
    const o = buildReviewObservation({
      pr: '1', model: 'api:y', intent: '', durationMs: 1,
      review: { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: false },
    });
    expect(o.failureReason).toBeUndefined();
  });
});
