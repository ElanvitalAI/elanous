// 리뷰 intent 조립 회귀 — [[RFC-pr-as-review-conversation-medium-2026-07-27]] §2A.
//
// ⚠️ 이 조립기는 **생산자가 있는 블록만** 만든다 — 빈 헤더를 만들지 않는다. 4블록 전부의
//    생산자가 실재한다: 목표·직전 반영분은 파이프라인이, **수용기준·의도적 스코프 경계는
//    골 텍스트**가(`extractIntentBlocks` · 결정론 파싱 · LLM 0).
//    RFC **P3**(자기 합성)의 몫은 *"골에 그 절이 **없을 때** 합성으로 채우는 것"* 이다.
//    사람이 손으로 쓰는 4블록 틀은 [[MANUAL-review-operations-2026-07-27]] §2a 가 SSOT 이고
//    `--intent` 로 직접 주므로 이 함수를 거치지 않는다.

import { describe, expect, test } from 'bun:test';
import { buildManualReviewIntent, buildReviewIntent, capIntent, extractIntentBlocks, intentFromPr, prIntentSectionCoverage, reviewIntentTruncationObservation, stripExtractedSections, MAX_INTENT_ITEMS, MAX_INTENT_ITEM_CHARS, MAX_REVIEW_INTENT_CHARS, type ExtractedIntentBlocks } from './review-intent.js';
import { toReviewIntentInput } from '../self-implement/seams.js';

describe('buildManualReviewIntent', () => {
  test('상한 이하는 종전 수동 조립 문자열과 문자 동등하다', () => {
    const explicit = '명시 범위  \n\n';
    const body = '검증 증거';
    const expected = `## 명시 intent\n${explicit}\n\n## PR 본문\n${body}`;
    const output = buildManualReviewIntent(explicit, body);
    expect(output).toBe(expected);
    console.info(`[under-cap-identical] outputChars=${output.length} expectedChars=${expected.length} identical=${output === expected}`);
  });

  test('상한 초과도 모든 절에 예산을 나눠 마지막 절과 생략 표기를 남긴다', () => {
    const explicit = ['## RULES', '규칙 '.repeat(1_500), '## 범위', '범위 '.repeat(1_500)].join('\n');
    const body = ['## 구현', '구현 '.repeat(1_500), '## 검증', 'VERIFY-EVIDENCE', '증거 '.repeat(1_500), '## 뒤쪽', '뒤 '.repeat(1_500)].join('\n');
    const out = buildManualReviewIntent(explicit, body);
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain('## 검증');
    expect(out).toContain('VERIFY-EVIDENCE');
    expect(out).toContain('…[');
    for (const heading of ['## 명시 intent', '## RULES', '## 범위', '## PR 본문', '## 구현', '## 검증', '## 뒤쪽']) {
      expect(out).toContain(heading);
    }
  });

  test('긴 절은 배정 예산 안에서 본문을 보존해 상한을 채우고 첫·마지막 절이 살아남는다', () => {
    const explicit = [
      '## 목표', `FIRST-BODY-MARKER ${'명시 '.repeat(1_100)}`,
      '## 수용 기준', '수용 '.repeat(1_100),
      '## 상황', '상황 '.repeat(1_100),
      '## 결정', '결정 '.repeat(1_100),
      '## 답', '답 '.repeat(1_100),
    ].join('\n');
    const body = [
      '## 구현', '구현 '.repeat(1_100),
      '## 검증', '검증 '.repeat(1_100),
      '## 관측', '관측 '.repeat(1_100),
      '## 위험', '위험 '.repeat(1_100),
      '## 증거', '증거 '.repeat(1_100),
      '## 마지막', `LAST-BODY-MARKER ${'마지막 '.repeat(1_100)}`,
    ].join('\n');
    const out = buildManualReviewIntent(explicit, body);
    const totalSections = 11;
    const wholeDrops = [...out.matchAll(/^#{1,6} .+\n…\[\d+개 생략됨]$/gm)].length;
    const outputChars = out.length;
    const utilization = outputChars / MAX_REVIEW_INTENT_CHARS;
    const wholeDropRatio = wholeDrops / totalSections;
    const firstSurvives = out.includes('FIRST-BODY-MARKER');
    const lastSurvives = out.includes('LAST-BODY-MARKER');
    console.info(`[budget-utilization] outputChars=${outputChars} maxChars=${MAX_REVIEW_INTENT_CHARS} utilization=${utilization.toFixed(4)} threshold=2800`);
    console.info(`[whole-drop-ratio] wholeDrops=${wholeDrops} totalSections=${totalSections} ratio=${wholeDropRatio.toFixed(4)} threshold<0.5`);
    console.info(`[first-and-last-survive] first=FIRST-BODY-MARKER found=${firstSurvives} last=LAST-BODY-MARKER found=${lastSurvives}`);
    console.info(`[length-cap] outputChars=${outputChars} maxChars=${MAX_REVIEW_INTENT_CHARS} withinCap=${outputChars <= MAX_REVIEW_INTENT_CHARS}`);
    expect(outputChars).toBeGreaterThanOrEqual(MAX_REVIEW_INTENT_CHARS * 0.7);
    expect(outputChars).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(wholeDrops).toBeLessThan(totalSections / 2);
    expect(firstSurvives).toBe(true);
    expect(lastSurvives).toBe(true);
  });

  test('다중 행 부분 절단은 부분 행과 뒤의 완전 생략 행을 모두 센다', () => {
    const explicit = [
      '## 여러 행',
      `FIRST-KEPT ${'a'.repeat(1_000)}`,
      `PARTIAL-LINE ${'b'.repeat(3_500)}`,
      `FULLY-DROPPED ${'c'.repeat(2_000)}`,
    ].join('\n');
    const body = ['## 짧은 본문', 'x'].join('\n');
    const out = buildManualReviewIntent(explicit, body);
    expect(out).toContain('FIRST-KEPT');
    expect(out).toContain('PARTIAL-LINE');
    expect(out).not.toContain('FULLY-DROPPED');
    expect(out).toContain('…[2개 생략됨]');
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
  });

  test('부분 행 예산이 정확히 완전 행 길이일 때 음수 slice 없이 상한과 생략 수를 지킨다', () => {
    const explicit = [
      '## 경계',
      `COMPLETE-${'a'.repeat(2_948)}`,
      `PARTIAL-MUST-NOT-LEAK-${'b'.repeat(6_000)}`,
    ].join('\n');
    const body = ['## 본문', 'x'.repeat(6_000)].join('\n');
    const out = buildManualReviewIntent(explicit, body);
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain(`COMPLETE-${'a'.repeat(2_948)}`);
    expect(out).not.toContain('PARTIAL-MUST-NOT-LEAK');
    expect(out).toContain('## 본문\nx');
    expect([...out.matchAll(/…\[(\d+)개 생략됨]/g)].map((match) => Number(match[1]))).toEqual([1, 1]);
  });

  test('짧은 절의 남은 몫을 긴 절에 재배분해 상한을 채운다', () => {
    const explicit = ['## 짧음', 'x', '## 김', '긴 '.repeat(3_000)].join('\n');
    const body = ['## 끝', '끝 '.repeat(3_000)].join('\n');
    const out = buildManualReviewIntent(explicit, body);
    console.info(`[redistribution] outputChars=${out.length} maxChars=${MAX_REVIEW_INTENT_CHARS} utilization=${(out.length / MAX_REVIEW_INTENT_CHARS).toFixed(4)} threshold=3600`);
    expect(out.length).toBeGreaterThanOrEqual(MAX_REVIEW_INTENT_CHARS * 0.9);
    expect(out).toContain('## 짧음\nx');
    expect(out).toContain('긴 긴 긴');
  });

  test('절 수가 슬롯보다 많아도 보존 절과 생략 수가 전체 절 수를 정확히 설명한다', () => {
    const sectionCount = 200;
    const title = '제목'.repeat(20);
    const body = Array.from({ length: sectionCount }, (_, index) => `## 절${index}-${title}\n${`내용${index} `.repeat(20)}`).join('\n\n');
    const out = buildManualReviewIntent('명시', body);
    const retained = [...out.matchAll(/## 절(\d+)-제목+/g)].map((match) => Number(match[1]));
    const omissions = [...out.matchAll(/…\[(\d+)개 생략됨]/g)].map((match) => Number(match[1]));
    const omitted = omissions.at(-1);
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(retained.length).toBeGreaterThan(0);
    expect(new Set(retained).size).toBe(retained.length);
    expect(retained).toEqual([...retained].sort((a, b) => a - b));
    expect(omitted).toBeDefined();
    expect(retained.length + omitted!).toBe(sectionCount);
  });
});

describe('buildReviewIntent design gate', () => {
  const base = { direction: 'paper', tokensSource: null, advisoryTotal: 0, truncated: false, omitted: 0, checkedAt: '2026-01-01T00:00:00Z' } as const;
  test('P0 findings become review must-fix candidates without changing the absent output', () => {
    const input = { goal: 'Design an index' };
    const previous = buildReviewIntent(input);
    const designGate = {
      ...base, verdict: 'fail' as const, p0Total: 2,
      files: [{ path: 'index.html', p0: 2, advisory: 0, skipped: [], findings: [
        { rule: 'display-font-mismatch', severity: 'p0' as const, line: 12 },
        { rule: 'raw-color', severity: 'p0' as const, line: 30 },
      ] }],
    };
    const out = buildReviewIntent({ ...input, designGate });
    expect(out).toContain('디자인 게이트 — must-fix 후보(P0 2)');
    expect(out).toContain('index.html:12 display-font-mismatch');
    expect(out).toContain('index.html:30 raw-color');
    expect(buildReviewIntent(input)).toBe(previous);
    expect(buildReviewIntent({ ...input, designGate: { ...designGate, verdict: 'not-applicable', reason: 'no-direction' } })).toBe(previous);
  });

  test('pass and unmeasured are visible; P0 list is capped at twenty', () => {
    const input = { goal: 'Design an index' };
    const pass = { ...base, verdict: 'pass' as const, p0Total: 0, files: [] };
    expect(buildReviewIntent({ ...input, designGate: pass })).toContain('디자인 게이트 통과(방향 paper)');
    expect(buildReviewIntent({ ...input, designGate: { unmeasured: 'git unavailable' } })).toContain('측정 불가: git unavailable');
    const findings = Array.from({ length: 23 }, (_, index) => ({ rule: `rule-${index}`, severity: 'p0' as const, line: index + 1 }));
    const out = buildReviewIntent({ ...input, designGate: { ...base, verdict: 'fail', p0Total: 23, files: [{ path: 'index.html', p0: 23, advisory: 0, skipped: [], findings }] } });
    expect(out).toContain('index.html:20 rule-19');
    expect(out).not.toContain('index.html:21 rule-20');
    expect(out).toContain('…3개 생략');
  });
});

describe('buildReviewIntent', () => {
  test('shard boundary gets budget before a long goal; JSON footer is absent from the goal block', () => {
    const identity = {
      orchestrationId: 'run-1', shardId: 'handler', totalShards: 3, position: 1,
      summary: 'Build the handler', siblings: [
        { shardId: 'route', summary: 'Register the route' },
        { shardId: 'screen', summary: 'Build the screen' },
      ],
    };
    const goal = `G${'x'.repeat(6000)}\n\n## Shard identity\n${JSON.stringify(identity)}`;
    const out = buildReviewIntent({ goal });
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain('형제 조각이 맡는 일:');
    expect(out).toContain('- route: Register the route');
    expect(out).toContain('- screen: Build the screen');
    expect(out.indexOf('조각 경계')).toBeLessThan(out.indexOf('목표'));
    expect(out).not.toContain('## Shard identity');
    expect(out).not.toContain('"orchestrationId"');
  });

  test('missing or malformed shard JSON preserves the pre-change review string byte-for-byte', () => {
    expect(buildReviewIntent({ goal: '  게이트 스코프를 고친다  ' }))
      .toBe('골 종류와 성공 조건\n종류: implement\n성공: 게이트 통과와 PR 머지다.\n\n목표\n게이트 스코프를 고친다');
    const malformed = 'G\n\n## Shard identity\n{"shardId":';
    expect(buildReviewIntent({ goal: malformed }))
      .toBe(`골 종류와 성공 조건\n종류: implement\n성공: 게이트 통과와 PR 머지다.\n\n목표\n${malformed}`);
  });

  test('prior-run findings require a decision but an absent or empty list leaves the intent byte-identical', () => {
    const baseline = buildReviewIntent({ goal: 'G' });
    const finding = { pr: 21457, runId: 'run-old', round: 1, items: ['프록시가 압축 응답 헤더를 그대로 넘긴다'] };
    const intent = buildReviewIntent({ goal: 'G', priorRunFindings: [finding] });
    expect(intent).toContain('앞 런이 남긴 지적(같은 골 · 다른 런)');
    expect(intent).toContain('#21457 · 라운드 1 · 프록시가 압축 응답 헤더를 그대로 넘긴다');
    expect(intent).toContain('닫혔는지 판정하라');
    expect(intent).toContain('닫히지 않았고 이 PR 범위에 해당하면 must-fix 로 올린다 · 해당 없으면 이유 한 줄');
    expect(baseline).not.toContain('앞 런이 남긴 지적');
    expect(buildReviewIntent({ goal: 'G', priorRunFindings: [] })).toBe(baseline);
    // Exercise the actual reviewDiff adapter input, not only the intent builder.
    const forwarded = toReviewIntentInput({ goal: 'G', priorRunFindings: [finding] });
    expect(forwarded?.priorRunFindings).toEqual([finding]);
    expect(buildReviewIntent(forwarded!)).toContain('#21457 · 라운드 1');
  });

  test('절이 없는 골은 implement 종류와 기존 성공 조건을 알린다', () => {
    const out = buildReviewIntent({ goal: '  게이트 스코프를 고친다  ' });
    expect(out).toBe('골 종류와 성공 조건\n종류: implement\n성공: 게이트 통과와 PR 머지다.\n\n목표\n게이트 스코프를 고친다');
    expect(out).not.toContain('직전 라운드 반영분');
  });

  test('goalFile이 있으면 골 문서가 정상 산출물임을 지정 문면으로 알린다', () => {
    const out = buildReviewIntent({ goal: 'G', goalFile: 'docs/goals/GOAL-x-2026-09-14.md' });
    expect(out).toContain('이 런의 골 문서: docs/goals/GOAL-x-2026-09-14.md — 하니스가 발사 때 쓴 산출물이다. diff 에 있는 것이 정상이며 시험 부작용이 아니다.');
  });

  test('goalFile을 생략하면 기존 intent 문자열이 정확히 같다', () => {
    expect(buildReviewIntent({ goal: '  게이트 스코프를 고친다  ' }))
      .toBe('골 종류와 성공 조건\n종류: implement\n성공: 게이트 통과와 PR 머지다.\n\n목표\n게이트 스코프를 고친다');
  });

  test('research 골은 종류별 성공 조건을 알리고 코드 변경 부재를 결손으로 보지 않는다', () => {
    const out = buildReviewIntent({ goal: '리서치 골\n- GoalType: research\n\n리서치 산출물을 만든다' });
    expect(out).toContain('골 종류와 성공 조건\n종류: research');
    expect(out).toContain('산출 문서가 존재하고 그 안에 반증 명령이 있고 인용이 열리는 것이다. 코드 변경이 없다는 것 자체는 결손이 아니다.');
  });

  test('document와 operate 골은 각각의 성공 조건을 알린다', () => {
    const documentIntent = buildReviewIntent({ goal: '문서 골\n- GoalType: document\n\n문서를 쓴다' });
    expect(documentIntent).toContain('종류: document');
    expect(documentIntent).toContain('산출 경로에 파일이 생겼고 링크 린트가 통과하는 것이다. 코드 변경이 없다는 것 자체는 결손이 아니다.');
    const operateIntent = buildReviewIntent({ goal: '운영 골\n- GoalType: operate\n\n명세를 등록한다' });
    expect(operateIntent).toContain('종류: operate');
    expect(operateIntent).toContain('명세 파일이 생겼고 그것을 읽어 등록하는 dry-run 이 통과하는 것이다. 스케줄을 실제로 등록하지 않는 것이 옳다.');
  });

  test('알 수 없거나 중복된 GoalType이면 종류 블록을 붙이지 않는다', () => {
    expect(buildReviewIntent({ goal: '골\n- GoalType: unknown\n\n본문' })).not.toContain('골 종류와 성공 조건');
    expect(buildReviewIntent({ goal: '골\n- GoalType: research\n- GoalType: document\n\n본문' })).not.toContain('골 종류와 성공 조건');
  });

  // ⚠️ 이 테스트는 종전에 "라운드 0 이면 생략한다" 였고 **main 에서 이미 실패하고 있었다**
  //   (clean checkout `fbb89009d` 에서 1 fail 재현 · 내 변경 이전부터). 프로덕션이 옳다 —
  //   라운드 0 에도 **직전 런에서 carry 된 반영분**(`carriedAppliedItems`)이 legitimately 존재한다.
  //   ⇒ 스테일한 테스트를 프로덕션에 맞춘다. 계약을 약화시키는 것이 아니라 **이미 어긋난 것을 고친다**.
  test('라운드 0이어도 전달된 직전 반영분을 보존한다 (carry 가 있을 수 있다)', () => {
    const out = buildReviewIntent({ goal: 'G', round: 0, appliedLastRound: ['보존돼야 함'] });
    expect(out).toContain('직전 라운드 반영분\n- 보존돼야 함');
  });

  test('라운드 1 이상이면 직전 반영분이 목록으로 붙는다 (공백 항목은 버린다)', () => {
    const out = buildReviewIntent({ goal: 'G', round: 1, appliedLastRound: [' 봉인을 복사보다 먼저 ', '', '  '] });
    expect(out).toBe('골 종류와 성공 조건\n종류: implement\n성공: 게이트 통과와 PR 머지다.\n\n목표\nG\n\n직전 라운드 반영분\n- 봉인을 복사보다 먼저');
  });

  test('마크다운 강조를 넣지 않는다 (리터럴로 리뷰어에게 전달되면 노이즈)', () => {
    expect(buildReviewIntent({ goal: 'G', round: 2, appliedLastRound: ['x'] })).not.toContain('**');
  });

  test('gate evidence와 shard siblings를 각각의 리뷰 블록으로 렌더하고 빈 입력은 생략한다', () => {
    const out = buildReviewIntent({
      goal: 'G',
      gateEvidenceNote: 'Ran focused tests: 0 fail',
      shardSiblings: {
        items: [{ runId: 'run-sibling', shardId: 'shard-a', pieceIndex: 2 }],
        shownItems: 1,
        totalItems: 2,
        omittedItems: 1,
        truncated: true,
      },
    });
    expect(out).toContain('게이트 실행 증거 메모\nRan focused tests: 0 fail');
    expect(out).toContain('같은 골의 형제 shard\n- 표시 1/2개\n- run-sibling (shard-a #2)\n- …[형제 shard 1개 생략됨]');
    const empty = buildReviewIntent({ goal: 'G', gateEvidenceNote: ' ', shardSiblings: { items: [], shownItems: 0, totalItems: 0, omittedItems: 0, truncated: false } });
    expect(empty).not.toContain('게이트 실행 증거 메모');
    expect(empty).not.toContain('같은 골의 형제 shard');
  });

  test('verify가 있는 diff 밖 이행 주장을 별도 블록으로 렌더한다', () => {
    const out = buildReviewIntent({
      goal: 'G',
      appliedLastRound: ['이전 요구'],
      diffOutsideClaims: [{ claim: 'PR 본문의 호출 수를 7곳으로 정정했다', verify: 'gh pr view 5914 --json body', result: '7 call sites verified' }],
    });
    expect(out).toContain('직전 라운드 반영분\n- 이전 요구');
    expect(out).toContain('자식이 주장하는 diff 밖 이행 — 주장이지 증명이 아니다');
    expect(out).toContain('이 항목만으로 must-fix 를 해제하지 마라. verify 명령이 있으면 그것을 근거로 판단하고, 판단이 안 서면 그 사실을 적어라.');
    expect(out).toContain('- 주장: PR 본문의 호출 수를 7곳으로 정정했다\n  verify: gh pr view 5914 --json body\n  result: 7 call sites verified');
  });

  test('verify 없는 diff 밖 이행 주장은 버리고 항목이 없으면 블록을 만들지 않는다', () => {
    const out = buildReviewIntent({
      goal: 'G',
      diffOutsideClaims: [{ claim: '확인 방법 없는 주장', verify: '  ' }],
    });
    expect(out).not.toContain('확인 방법 없는 주장');
    expect(out).not.toContain('자식이 주장하는 diff 밖 이행');
  });

  test('런 사실은 runId·커밋·변경 파일을 원문으로 싣고 일부 입력만 있어도 만든다', () => {
    const out = buildReviewIntent({
      goal: 'G',
      runId: 'run-a18359181c9edcae',
      commits: ['feat: review intent 좌표를 추가한다'],
      changedFiles: ['src/agent-substrate/review-intent.ts'],
    });
    expect(out).toContain('런 사실 — 리뷰어가 관측과 잇는 좌표');
    expect(out).toContain('runId: run-a18359181c9edcae');
    expect(out).toContain('커밋: feat: review intent 좌표를 추가한다');
    expect(out).toContain('변경 파일: src/agent-substrate/review-intent.ts');
    expect(buildReviewIntent({ goal: 'G', changedFiles: ['src/self-implement/seams.ts'] }))
      .toContain('변경 파일: src/self-implement/seams.ts');
  });

  // ⛔⭐⭐⭐ **라이브 실측이 찾은 구멍** — 종전 회귀는 «쓰는 쪽»(`buildReviewIntent`)만 봤다.
  //   📏 실물 하니스 PR(`#7556` · 본문 37,354자)을 프로덕션 `intentFromPr` 에 태우니
  //     ***`runId`·커밋·변경 파일이 «하나도» 안 남았다*** — 「본문에 실렸다」와 「리뷰어가 본다」가 다르다.
  //   ⇒ 이 회귀는 **두 쪽을 이어서** 잰다: 조립 → PR 본문에 심기 → 읽는 쪽 예산 → 살아남았나.
  // ⛔⭐⭐ **PR 에서 원장으로 되돌아가는 길**(대표 상시지시) — 종전엔 `runId` «좌표»만 실려서
  //   그 런의 관측 원장을 열려면 읽는 사람이 명령을 «알고 있어야» 했다. 명령 그대로가 실리는지 잰다.
  //   ⭐ 그리고 이 절은 `prBody` 가 품으므로 PR 본문과 리뷰어 프롬프트 «둘 다»에 닿는다.
  // ⛔⭐⭐⭐ **왕복까지 잰다**(리뷰 should-fix ⊕ *"배선 PR 은 실물을 한 번 돌린다"*) — 조립기만
  //   재면 「그 줄을 «만든다»」까지고, ***「그 줄이 리뷰어에게 «닿는다»」는 못 답한다.***
  //   실제 경로는 조립기 → PR 본문 → `intentFromPr`(리뷰어가 PR 을 읽는 자리)다. 그 왕복을 잰다.
  test('⭐ 원장 명령이 조립기 → PR 본문 → intentFromPr 왕복에서 살아남는다', () => {
    const runId = 'run-6a09390d-7b3d-4f08-9fcb-0289247194ee';
    const assembled = buildReviewIntent({ goal: '골 원문', runId });
    expect(assembled).toContain(`원장: elanous self run-ledger ${runId}`);
    // PR 본문은 그 intent 를 «품는다»(orchestrator 의 prBody 가 하는 것과 같은 형태).
    const body = ['## 요청', '골 원문', '', '## 리뷰 intent', assembled].join('\n');
    const rendered = intentFromPr({ title: '대상 경로: src/x.ts', body });
    expect(rendered).toContain(`elanous self run-ledger ${runId}`);
  });

  test('⭐ 런 사실에 원장을 여는 «명령 그대로»가 runId 뒤에 실린다', () => {
    const out = buildReviewIntent({ goal: 'G', runId: 'run-6a09390d-7b3d-4f08-9fcb-0289247194ee' });
    expect(out).toContain('runId: run-6a09390d-7b3d-4f08-9fcb-0289247194ee');
    expect(out).toContain('원장: elanous self run-ledger run-6a09390d-7b3d-4f08-9fcb-0289247194ee');
    // ⭐ 순서 — 좌표 «뒤»에 길이 온다(읽는 쪽이 머리만 남겨도 좌표가 먼저다).
    expect(out.indexOf('runId: run-6a09390d')).toBeLessThan(out.indexOf('원장: elanous self run-ledger'));
    // ⛔ runId 가 없으면 «길도 없다» — 없는 런의 명령을 만들지 않는다.
    expect(buildReviewIntent({ goal: 'G', commits: ['c1'] })).not.toContain('elanous self run-ledger');
  });

  test('⭐ 런 사실이 조립 산출의 «맨 앞»이다 — 읽는 쪽이 머리만 남겨도 좌표가 닿는다', () => {
    const rendered = buildReviewIntent({
      goal: '골 본문'.repeat(400),
      acceptance: ['게이트를 통과한다'],
      scopeBoundaries: ['A 는 이 착지에서 안 한다'],
      runId: 'run-1d9b3495',
      commits: ['첫 커밋 제목'],
      changedFiles: ['src/a.ts'],
    });
    // ⛔⭐⭐⭐ **이 단언이 이 회귀의 «이빨»이다.** `intentFromPr` 는 PR 본문의 `## 리뷰 intent` 를
    //   «한 덩어리»로 보고 예산이 모자라면 그 «머리»만 남긴다. 그러므로 좌표가 리뷰어에게 닿는
    //   유일한 보장은 ***조립 산출의 맨 앞에 있는 것***이다.
    //   📏 실측 근거: `#7556`(본문 37,354자)을 프로덕션 `intentFromPr` 에 태우니 종전 순서에서는
    //     `runId`·커밋·변경 파일이 «하나도» 안 남았다.
    expect(rendered.startsWith('런 사실 — 리뷰어가 관측과 잇는 좌표')).toBe(true);
    expect(rendered.indexOf('run-1d9b3495')).toBeLessThan(rendered.indexOf('수용기준'));
    // ⊕ 맨 앞으로 옮겨도 보호 블록은 «조립 산출에» 그대로 있다 — 좌표를 살리려고 기준을 죽이지 않았다.
    expect(rendered).toContain('수용기준');
    expect(rendered).toContain('의도적 스코프 경계');

    // ⊕ 시나리오 — 실물 하니스 본문의 형태(경쟁 절 다수 ⊕ `## 리뷰 intent` 가 뒤)에서도 닿는가.
    //   ⚠️ 이 시나리오 «단독»으로는 순서를 못 잡는다(작은 intent 는 통째로 살아남는다) — 위 단언과 «짝»이다.
    const rival = (head: string) => [head, 'Y'.repeat(4_000)].join('\n');
    const body = [
      rival('## RULES'), rival('## ACCEPTANCE CRITERIA'), rival('## 불변식'),
      rival('## 자식이 남긴 증거 (EVIDENCE/RESULT · 화면 전체에서 수확)'), rival('## 구현 요약'),
      '## 리뷰 intent', rendered,
    ].join('\n');
    const seen = intentFromPr({ title: 'PR', body });
    expect(seen.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(seen).toContain('run-1d9b3495');
    // ⚠️ **여기서 `수용기준` 생존은 «단언하지 않는다»** — 이 픽스처는 목표 본문이 2,000자라
    //   `## 리뷰 intent` 안에서 그것이 남은 몫을 먹는다(실물 `#7556` 에서는 살아남았다).
    //   ⇒ 그 성질은 픽스처 비율에 달렸고 «다른 회귀»가 이미 지킨다(보호 블록 절·전역 상한 절).
    //     여기서 단언하면 이 회귀가 «자기 픽스처를 재는» 것이 된다.
  });

  test('런 사실 입력이 모두 비면 헤더를 만들지 않고 긴 목록은 생략 수를 적는다', () => {
    expect(buildReviewIntent({ goal: 'G', runId: ' ', commits: ['  '], changedFiles: [] }))
      .not.toContain('런 사실 — 리뷰어가 관측과 잇는 좌표');
    const out = buildReviewIntent({
      goal: 'G',
      changedFiles: Array.from({ length: 14 }, (_, index) => `src/file-${index}.ts`),
    });
    expect(out).toContain('…[2개 생략됨]');
    expect(out).toContain('변경 파일: src/file-11.ts');
    expect(out).not.toContain('변경 파일: src/file-12.ts');
  });

  test('런 사실은 긴 보호·증거 블록과 전역 상한을 경쟁해도 절단된 각 사실 종류를 보존한다', () => {
    const longProtectedItems = (prefix: string, fill: string) => Array.from(
      { length: MAX_INTENT_ITEMS },
      (_, index) => `- ${prefix}-${index} ${fill.repeat(MAX_REVIEW_INTENT_CHARS)}`,
    );
    const goal = [
      `GOAL-MUST-COMPETE ${'g'.repeat(MAX_REVIEW_INTENT_CHARS * 2)}`,
      '## 수용기준', ...longProtectedItems('ACCEPTANCE-MUST-SURVIVE', 'a'),
      '## 의도적 스코프 경계', ...longProtectedItems('BOUNDARY-MUST-SURVIVE', 'b'),
    ].join('\n');
    const out = buildReviewIntent({
      goal,
      runId: 'RUN-ID-MUST-SURVIVE',
      commits: [`COMMIT-MUST-SURVIVE ${'c'.repeat(MAX_REVIEW_INTENT_CHARS * 2)}`],
      changedFiles: [`FILE-MUST-SURVIVE.ts/${'f'.repeat(MAX_REVIEW_INTENT_CHARS * 2)}`],
      diffOutsideClaims: [{ claim: `EVIDENCE-MUST-COMPETE ${'e'.repeat(MAX_REVIEW_INTENT_CHARS * 2)}`, verify: 'verify-command' }],
    });
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain('ACCEPTANCE-MUST-SURVIVE-0');
    expect(out).toContain('BOUNDARY-MUST-SURVIVE-0');
    expect(out).toContain('runId: RUN-ID-MUST-SURVIVE');
    expect(out).toContain('커밋: COMMIT-MUST-SURVIVE');
    expect(out).toContain('변경 파일: FILE-MUST-SURVIVE.ts');
    expect(out).toContain('…[');
  });

  // ⭐⭐ 사후 리뷰 must-fix — 종전 구현은 **판정은 MAX 로, 절단은 MAX-마커 로** 해서 실제로 잘린
  //   블록보다 **뒤 블록**을 지목할 수 있었다(선행 블록이 잘렸는데 "다음 블록부터 잘림" 이라 보고).
  //   마커 자리를 먼저 예약해야 표기가 사실과 맞는다.
  test('⭐ 상한 초과 — 절단 표기가 실제로 잘린 블록을 지목하고 선행 블록은 보존된다', () => {
    const out = buildReviewIntent({
      goal: '짧은 목표', round: 1, appliedLastRound: ['B'.repeat(MAX_REVIEW_INTENT_CHARS)],
    });
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain('직전 라운드 반영분\n…[1개 생략됨]');
    // ★ 선행 블록(목표)은 **온전히** 남는다.
    expect(out).toContain('목표\n짧은 목표');
  });

  test('⭐ 16,000자 골에서도 수용기준·경계를 먼저 보존하고 목표 생략을 표기한다', () => {
    const goal = [
      'G'.repeat(16_000),
      '## 수용기준', '- 집중 테스트가 통과한다.',
      '## 의도적 스코프 경계', '- 상한 4000은 올리지 않는다.',
    ].join('\n\n');
    const out = buildReviewIntent({
      goal,
      runId: 'run-budget-protection',
      changedFiles: ['src/agent-substrate/review-intent.ts'],
    });
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain('수용기준\n- 집중 테스트가 통과한다.');
    expect(out).toContain('의도적 스코프 경계\n- 상한 4000은 올리지 않는다.');
    expect(out).toContain('런 사실 — 리뷰어가 관측과 잇는 좌표');
    expect(out).toContain('…[1개 생략됨]');
  });

  test('⭐ 목표 자체가 상한을 넘으면 목표 안에 생략 사실을 남긴다', () => {
    const out = buildReviewIntent({
      goal: 'G'.repeat(MAX_REVIEW_INTENT_CHARS * 2), round: 1, appliedLastRound: ['x'],
    });
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain('목표\n…[1개 생략됨]');
  });

  test('상한 초과 시 diff 밖 이행 주장 블록도 절단 지목에 편입된다', () => {
    const out = buildReviewIntent({
      goal: 'G',
      diffOutsideClaims: [{ claim: 'C'.repeat(MAX_REVIEW_INTENT_CHARS), verify: 'verify-command' }],
    });
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain('…[2개 생략됨]');
  });
});

// ⭐⭐ 사후 리뷰 must-fix — *"생산자가 없다"* 며 수용기준·스코프 경계를 뺀 것은 **범위 축소**였다.
//   생산자는 실재한다: **골 텍스트 자체**. 파싱은 ①조망이지 ②합성(LLM)이 아니므로 P1 범위 안이다.
describe('extractIntentBlocks — 골에서 결정론 추출(LLM 없음)', () => {
  const GOAL = [
    '게이트를 고친다.', '',
    '## 수용기준', '1. 파생 루트 계산이 SSOT 를 공유한다.', '- 물질화는 test 우주로만 간다.', '',
    '## 구현할 것', '- 이건 수집되면 안 된다', '',
    '## 하지 말 것', '- runPtyControlLoop 수렴은 별건이다.', '- LLM 호출 추가 금지.', '',
  ].join('\n');

  test('⭐ 인식하는 절만 수집한다 — 모르는 절은 버린다(과잉 수집 금지)', () => {
    // 반환 계약을 타입으로도 붙잡는다(필드 이름이 바뀌면 컴파일이 잡는다).
    const blocks: ExtractedIntentBlocks = extractIntentBlocks(GOAL);
    const { acceptance, scopeBoundaries } = blocks;
    expect(acceptance).toEqual(['파생 루트 계산이 SSOT 를 공유한다.', '물질화는 test 우주로만 간다.']);
    expect(scopeBoundaries).toEqual(['runPtyControlLoop 수렴은 별건이다.', 'LLM 호출 추가 금지.']);
    // ★ `## 구현할 것` 의 항목이 새어들면 intent 가 오염된다.
    expect([...acceptance, ...scopeBoundaries]).not.toContain('이건 수집되면 안 된다');
  });

  // ⭐⭐ 리뷰 must-fix — 초판 `stripExtractedSections` 는 인식된 절을 만나면 **다음 헤더까지 통째로**
  //   버려 그 절의 **산문**(맥락·이유·주의)까지 intent 에서 사라졌다. 추출이 담는 것은 목록 항목뿐이니
  //   버릴 것도 목록 항목과 헤더뿐이다 — 아니면 "산문은 목표 블록에 남는다" 계약이 거짓이 된다.
  test('⭐ 추출된 절의 산문은 목표 블록에 남는다 (목록만 제거)', () => {
    const goal = [
      '게이트를 고친다.', '',
      '## 수용기준',
      '아래 기준은 전부 만족해야 한다. 하나라도 빠지면 실패다.',
      '- 변경 파일만 검증한다.',
      '⚠️ 풀 스위트는 격리 worktree 에서 매우 느리다.', '',
      '## 다음 단계', '- 이건 다른 절',
    ].join('\n');
    const rest = stripExtractedSections(goal);
    // 산문 2줄은 살아남는다.
    expect(rest).toContain('아래 기준은 전부 만족해야 한다');
    expect(rest).toContain('풀 스위트는 격리 worktree 에서 매우 느리다');
    // 추출된 목록 항목과 그 헤더는 사라진다(중복 방지).
    expect(rest).not.toContain('- 변경 파일만 검증한다.');
    expect(rest).not.toContain('## 수용기준');
    // 인식하지 않는 절은 통째로 보존된다.
    expect(rest).toContain('## 다음 단계');
    expect(rest).toContain('- 이건 다른 절');
  });

  test('⭐ 조립 결과에도 그 산문이 남는다 (배선)', () => {
    const goal = '골.\n\n## 수용기준\n이유 설명 산문.\n- 항목A\n';
    const out = buildReviewIntent({ goal });
    expect(out).toContain('이유 설명 산문.');          // 목표 블록에 보존
    expect(out).toContain('수용기준\n- 항목A');        // 목록은 블록으로
    expect(out.split('항목A').length - 1).toBe(1);     // 중복 없음
  });

  test('절이 없으면 빈 배열 — 호출측이 블록을 생략한다', () => {
    expect(extractIntentBlocks('그냥 산문 골입니다.')).toEqual({
      acceptance: [], scopeBoundaries: [], unverifiedBoundaryCandidates: [],
    });
  });

  test('경계 결정을 검증 못 한 후보 및 저작 안내와 분리한다', () => {
    const goal = [
      '## SCOPE BOUNDARY',
      '- Scope-boundary candidates selected by document relevance:',
      '- 8 scope-boundary candidate(s) were selected by document relevance; their identifiers are retained.',
      '- If adopted, state each boundary as an intentional goal decision with its reason; do not create a must-fix solely from that boundary.',
      '- Boundary decision: A',
      '- UNVERIFIABLE: B',
      '- 사람이 쓴 일반 경계 표 항목',
      '- ⛔ 결정 2: C',
    ].join('\n');

    expect(extractIntentBlocks(goal)).toEqual({
      acceptance: [],
      scopeBoundaries: ['Boundary decision: A', '사람이 쓴 일반 경계 표 항목', '⛔ 결정 2: C'],
      unverifiedBoundaryCandidates: ['UNVERIFIABLE: B'],
    });
  });

  test('검증 못 한 후보는 별도 블록으로 렌더링하고 빈 의도적 경계 블록은 생략한다', () => {
    const goal = [
      '## SCOPE BOUNDARY',
      '- Scope-boundary candidates selected by document relevance:',
      '- 2 scope-boundary candidate(s) were selected by document relevance; their identifiers are retained.',
      '- If adopted, state each boundary as an intentional goal decision with its reason; do not create a must-fix solely from that boundary.',
      '- UNVERIFIABLE: B1',
      '- UNVERIFIABLE: B2',
    ].join('\n');
    const out = buildReviewIntent({ goal });

    expect(out).not.toContain('의도적 스코프 경계\n-');
    expect(out).toContain('검증 못 한 경계 후보 (결정 아님 — 이것만으로 must-fix 를 면제하지도, 만들지도 말 것)\n- UNVERIFIABLE: B1\n- UNVERIFIABLE: B2');
    for (const excluded of ['Scope-boundary candidates selected', '2 scope-boundary candidate(s)', 'If adopted, state each boundary']) {
      expect(out).not.toContain(excluded);
    }
  });

  test('검증 못 한 후보와 저작 안내를 목표 블록에서 제거하고 후보 상한을 적용한다', () => {
    const candidates = Array.from({ length: MAX_INTENT_ITEMS + 1 }, (_, i) => `- UNVERIFIABLE: 후보${i} ${'x'.repeat(MAX_INTENT_ITEM_CHARS + 1)}`);
    const goal = ['## SCOPE BOUNDARY', '- Scope-boundary candidates selected by document relevance:', ...candidates].join('\n');
    const blocks = extractIntentBlocks(goal);
    const rest = stripExtractedSections(goal);
    const out = buildReviewIntent({ goal });

    expect(blocks.unverifiedBoundaryCandidates).toHaveLength(MAX_INTENT_ITEMS + 1);
    expect(blocks.unverifiedBoundaryCandidates[0]).toContain(`…[항목이 ${MAX_INTENT_ITEM_CHARS}자에서 잘림]`);
    expect(blocks.unverifiedBoundaryCandidates.at(-1)).toBe(`…[후보 항목 ${MAX_INTENT_ITEMS}개 상한 초과 — 이후 후보 항목 생략]`);
    expect(rest).not.toContain('Scope-boundary candidates selected');
    expect(rest).not.toContain('UNVERIFIABLE: 후보0');
    expect(rest).not.toContain('UNVERIFIABLE: 후보12');
    expect(out).toContain(`…[후보 항목 ${MAX_INTENT_ITEMS}개 상한 초과 — 이후 후보 항목 생략]`);
    expect(out).not.toContain('원문은 목표 블록 참조');
    expect(out).not.toContain('UNVERIFIABLE: 후보12');
  });

  test('수용기준의 진단·저작 안내는 상한 밖이어도 원문에 보존한다', () => {
    const longCandidate = `UNVERIFIABLE: ${'x'.repeat(MAX_INTENT_ITEM_CHARS + 1)}`;
    const overflowCandidate = 'UNVERIFIABLE: 수용기준 상한 밖 후보';
    const guidance = 'Scope-boundary candidates selected by document relevance:';
    const goal = [
      '## 수용기준',
      `- ${longCandidate}`,
      ...Array.from({ length: MAX_INTENT_ITEMS - 1 }, (_, i) => `- 일반 기준${i}`),
      `- ${overflowCandidate}`,
      `- ${guidance}`,
      '## 다음 절',
    ].join('\n');

    const rest = stripExtractedSections(goal);
    expect(rest).toContain(longCandidate);
    expect(rest).toContain(overflowCandidate);
    expect(rest).toContain(guidance);
    expect(rest).not.toContain('일반 기준0');
  });

  test('목록이 아닌 산문은 담지 않는다 (목표 블록에 이미 있다)', () => {
    expect(extractIntentBlocks('## 수용기준\n이건 산문이라 안 담긴다\n- 이건 담긴다').acceptance)
      .toEqual(['이건 담긴다']);
  });

  test('영문 SCOPE BOUNDARY 헤더에서 경계를 추출한다', () => {
    expect(extractIntentBlocks('## SCOPE BOUNDARY\n- Do not raise the cap.').scopeBoundaries)
      .toEqual(['Do not raise the cap.']);
  });

  // ⭐⭐ 리뷰 must-fix — 상한 절단이 **무표식**이면 4000자 미만에서도 기준이 **조용히 유실**된다.
  //   게다가 그 항목은 목표 블록에서도 제거되므로 **완전 유실**이다. 잘렸으면 말하고, 원문은 남긴다.
  test('⭐ 13번째 항목 — 보존 기준을 먼저 담고 생략 사실을 표기한다', () => {
    const many = ['## 수용기준',
      ...Array.from({ length: 12 }, (_, i) => `- 요청 기준${i}`),
      '- Checkable preservation criterion: 13번째 보존 불변식',
      ...Array.from({ length: 2 }, (_, i) => `- 요청 기준 후속${i}`), '', '## 다음'].join('\n');
    const acc = extractIntentBlocks(many).acceptance;
    expect(acc.length).toBe(MAX_INTENT_ITEMS + 1);              // 12 + 표기 1줄
    expect(acc[0]).toBe('Checkable preservation criterion: 13번째 보존 불변식');
    expect(acc).not.toContain('요청 기준11');
    expect(acc.at(-1)).toBe(`…[항목 ${MAX_INTENT_ITEMS}개 상한 초과 — 이후 항목 생략(원문은 목표 블록 참조)]`);
    // ★ 생략된 13번째는 목표 블록에 살아 있다(완전 유실 금지).
    expect(stripExtractedSections(many)).toContain('요청 기준11');
    // 담긴 12개는 목표에서 빠진다(중복 없음).
    expect(stripExtractedSections(many)).not.toContain('- 요청 기준0');
  });

  test('상한 미도달 항목은 내용과 순서를 그대로 보존한다', () => {
    const items = ['요청 기준', 'Checkable preservation criterion: 보존 불변식', '마지막 요청'];
    const goal = ['## 수용기준', ...items.map((item) => `- ${item}`)].join('\n');
    expect(extractIntentBlocks(goal).acceptance).toEqual(items);
  });

  // ⭐ 반론 계약 고정(9R 리뷰가 *"절 전체가 목표에서 제거돼 원문이 유실된다"* 고 했으나 **불성립**).
  //   추출본과 원문이 **다른** 항목(생략·절단)은 목표 블록에 남는다 — 아래가 그 반증이다.
  //   재현: `stripExtractedSections(goal)` 에 13~15번째가 그대로 있다.
  test('⭐ 반증 — 12개 초과 항목은 조립 결과 전체에서 실제로 읽힌다 (유실 0)', () => {
    const goal = ['골 서술.', '', '## 수용기준',
      ...Array.from({ length: 15 }, (_, i) => `- 기준${i}`), '', '## 다음 절', '- 딴것'].join('\n');
    const rest = stripExtractedSections(goal);
    for (const k of ['기준12', '기준13', '기준14']) expect(rest).toContain(k);   // 목표 블록에 생존
    const full = buildReviewIntent({ goal });
    for (const k of ['기준12', '기준13', '기준14']) expect(full).toContain(k);   // 최종 intent 에도
    // 담긴 12개는 중복되지 않는다.
    expect(full.split('기준0').length - 1).toBe(1);
  });

  test('⭐ 201자 항목 — 앞·뒤를 함께 남기고 기존 표식으로 가운데를 접는다', () => {
    const source = `앞부분-${'x'.repeat(MAX_INTENT_ITEM_CHARS)}-뒷부분`;
    const long = `## 수용기준\n- ${source}`;
    const item = extractIntentBlocks(long).acceptance[0]!;
    expect(item).toContain('앞부분-');
    expect(item).toContain('-뒷부분');
    expect(item).toContain(`…[항목이 ${MAX_INTENT_ITEM_CHARS}자에서 잘림]`);
    expect(item.indexOf('앞부분-')).toBeLessThan(item.indexOf(`…[항목이 ${MAX_INTENT_ITEM_CHARS}자에서 잘림]`));
    expect(item.indexOf(`…[항목이 ${MAX_INTENT_ITEM_CHARS}자에서 잘림]`)).toBeLessThan(item.indexOf('-뒷부분'));
    // ★ 잘린 항목의 원문은 목표 블록에 보존된다.
    expect(stripExtractedSections(long)).toContain(source);
  });

  test('⭐ 조립기가 그 추출을 실제로 쓴다 (배선)', () => {
    const out = buildReviewIntent({ goal: GOAL, round: 1, appliedLastRound: ['봉인 먼저'] });
    expect(out).toContain('수용기준\n- 파생 루트 계산이 SSOT 를 공유한다.');
    expect(out).toContain('의도적 스코프 경계\n- runPtyControlLoop 수렴은 별건이다.');
    expect(out).toContain('직전 라운드 반영분\n- 봉인 먼저');
    // 4블록 순서: 목표 → 수용기준 → 직전 반영분 → 스코프 경계
    expect(out.indexOf('수용기준')).toBeLessThan(out.indexOf('직전 라운드 반영분'));
    expect(out.indexOf('직전 라운드 반영분')).toBeLessThan(out.indexOf('의도적 스코프 경계'));
  });

  test('명시값이 추출을 이긴다 (호출자가 알면 그게 우선)', () => {
    const out = buildReviewIntent({ goal: GOAL, acceptance: ['명시 기준'], scopeBoundaries: [] });
    // ⚠️ 골 원문은 **목표 블록에 그대로** 들어가므로 전체 문자열로 단정하면 안 된다
    //   (초판 단정이 그 함정에 걸렸다) — **수용기준 블록만** 잘라서 본다.
    // ⚠️ 골 원문 안의 `## 수용기준` 이 먼저 잡히므로 **조립된 블록**만 골라야 한다
    //   (조립 블록은 앞에 빈 줄 + 접두사 없는 제목 — 초판이 이 함정에 걸렸다).
    const block = out.split('\n\n수용기준\n')[1]!.split('\n\n')[0]!;
    expect(block).toBe('- 명시 기준');
    expect(block).not.toContain('파생 루트 계산');
    // 빈 배열 = "명시적으로 없음" ⇒ 그 블록 자체가 생기지 않는다.
    expect(out).not.toContain('의도적 스코프 경계\n-');
  });
});

describe('intentFromPr — 본문 우선·제목 폴백', () => {
  test('본문이 있으면 본문 · 공백이면 제목 · 둘 다 비면 빈 문자열', () => {
    expect(intentFromPr({ title: '제목', body: '  본문 수용기준  ' })).toBe('본문 수용기준');
    expect(intentFromPr({ title: ' 제목 ', body: '   \n  ' })).toBe('제목');
    expect(intentFromPr({ title: '제목' })).toBe('제목');
    expect(intentFromPr({ title: '  ', body: '' })).toBe('');
  });

  // ⭐⭐ 리뷰 must-fix — 수용기준 7(절단 표기)이 **조립기 경로에만** 적용돼 있었다. 수동 경로
  //   (`--intent`·PR 본문)는 무표식 `slice` 라, 4블록을 잘 쓴 본문이 중간에 잘려도 리뷰어는
  //   **완전한 intent 로 착각**한다. 같은 형식으로 알려야 한다.
  // ⛔⭐ **2026-08-07 정정** — 이 검사는 종전에 `"'수용기준' 블록부터 잘렸습니다"` 를 단언했다.
  //   그 문면은 **앞자르기 구현의 산물**이었고, 그 구현은 ***수용기준을 통째로 버렸다***.
  //   원칙(*무표식 절단 금지*)은 그대로 두고, 마커는 이 모듈이 canonical 로 선언한 공용
  //   `omission()` 으로 본다. ⭐ 그리고 **판정 기준이 살아남는지**를 같이 문다 — 그게 이 수리의 목적이다.
  test('⭐ 상한을 넘어도 절단은 «표기»되고 판정 기준은 «살아남는다»', () => {
    const body = ['## 목표', 'g'.repeat(MAX_REVIEW_INTENT_CHARS), '', '## 수용기준', '- 반드시 지킬 것'].join('\n');
    const out = intentFromPr({ title: 'T', body });
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain('생략됨');        // 무표식 절단 금지(원칙 유지)
    expect(out).toContain('## 목표');        // 선행 절 제목은 보존
    // ⭐⭐ 핵심 — 앞자르기였다면 이 줄은 «사라졌다». 우선순위 예산이 이것을 지킨다.
    expect(out).toContain('- 반드시 지킬 것');
  });

  // ⛔⭐⭐⭐ **무회귀 계약** — 절을 하나도 못 알아보면 «종전과 완전 동일»해야 한다.
  //   이 검사가 없으면 새 경로가 조용히 옛 동작을 바꿔도 아무도 모른다.
  test('⛔ 절이 없는 본문은 종전 앞자르기와 «완전 동일»하다 (무회귀)', () => {
    const body = 'x'.repeat(MAX_REVIEW_INTENT_CHARS + 500);   // 마크다운 헤더 0개
    expect(intentFromPr({ title: 'T', body })).toBe(capIntent(body));
  });

  test('⭐ 뒤쪽에 있는 판정 기준을 «앞의 덤프»가 밀어내지 않는다 (실측 결함 #7443·#7477 형태)', () => {
    // 실측: 하니스 본문은 `## 구현 요약`(transcript 꼬리)이 앞이라 `## 리뷰 intent` 가 22k~31k 위치였다.
    const body = [
      '## 요청', '기능을 만든다',
      '', '## 구현 요약', 'z'.repeat(30_000),
      '', '## 리뷰 intent', '수용기준', '- 게이트를 통과해야 한다',
    ].join('\n');
    const out = intentFromPr({ title: 'T', body });
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain('- 게이트를 통과해야 한다');
    expect(out).toContain('## 리뷰 intent');
  });

  test('앞 절과 같은 Markdown 항목 사본을 빼서 같은 상한에서 고유 리뷰 항목을 더 살린다', () => {
    const copied = '- DUPLICATE-CRITERION';
    const unique = '- UNIQUE-REVIEW-CRITERION';
    const body = [
      '## 요청', copied, '',
      '## 리뷰 intent', copied, unique, '',
      '## 구현 요약', 'z'.repeat(MAX_REVIEW_INTENT_CHARS * 3),
    ].join('\n');
    const out = intentFromPr({ title: 'T', body });
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out.match(/DUPLICATE-CRITERION/g)?.length).toBe(1);
    expect(out).toContain(unique);
    expect(out.indexOf(copied)).toBeLessThan(out.indexOf(unique));
  });

  test('사본만 든 intent 절은 빈 헤더 없이 제외한다', () => {
    const copied = '- ONLY-DUPLICATE-CRITERION';
    const body = ['## 요청', copied, '', '## 리뷰 intent', copied, '', '## 구현 요약', 'z'.repeat(MAX_REVIEW_INTENT_CHARS * 3)].join('\n');
    const out = intentFromPr({ title: 'T', body });
    expect(out).toContain(copied);
    expect(out).not.toContain('## 리뷰 intent');
  });

  test('코드 펜스 안의 기준처럼 보이는 줄은 중복 사본으로 판정하지 않는다', () => {
    const fenced = '- FENCED-CRITERION';
    const body = [
      '## 요청', '```md', fenced, '```', '',
      '## 리뷰 intent', fenced, '- UNIQUE-REVIEW-CRITERION', '',
      '## 구현 요약', 'z'.repeat(MAX_REVIEW_INTENT_CHARS * 3),
    ].join('\n');
    const out = intentFromPr({ title: 'T', body });
    expect(out).toContain(fenced);
    expect(out.match(/FENCED-CRITERION/g)?.length).toBe(2);
  });

  test('다중 행 목록 사본은 이어지는 줄까지 함께 제거해 고아를 남기지 않는다', () => {
    const body = [
      '## 요청', '- DUPLICATE-MULTILINE', '  CONTINUATION-MUST-NOT-ORPHAN', '',
      '## 리뷰 intent', '- DUPLICATE-MULTILINE', '  CONTINUATION-MUST-NOT-ORPHAN', '- UNIQUE-REVIEW-CRITERION', '',
      '## 구현 요약', 'z'.repeat(MAX_REVIEW_INTENT_CHARS * 3),
    ].join('\n');
    const out = intentFromPr({ title: 'T', body });
    expect(out.match(/DUPLICATE-MULTILINE/g)?.length).toBe(1);
    expect(out.match(/CONTINUATION-MUST-NOT-ORPHAN/g)?.length).toBe(1);
    expect(out).toContain('- UNIQUE-REVIEW-CRITERION');
  });

  test('intent 내부 코드 펜스는 중복 비교와 무관하게 구분자·내용·공백까지 보존한다', () => {
    const copied = '- DUPLICATE-OUTSIDE-FENCE';
    const fenced = ['```md', '- FENCED-INTENT-CRITERION', '  fenced continuation', '```'].join('\n');
    const body = [
      '## 요청', copied, '',
      '## 리뷰 intent', copied, '', fenced, '', '- UNIQUE-AFTER-FENCE', '',
      '## 구현 요약', 'z'.repeat(MAX_REVIEW_INTENT_CHARS * 3),
    ].join('\n');
    const out = intentFromPr({ title: 'T', body });
    expect(out.match(/DUPLICATE-OUTSIDE-FENCE/g)?.length).toBe(1);
    expect(out).toContain(fenced);
    expect(out).toContain('- UNIQUE-AFTER-FENCE');
  });

  test('앞 절과 겹침이 없으면 비정형 공백을 포함한 intent 원문을 정확히 유지한다', () => {
    const intent = ['## 리뷰 intent', '', '- intent 고유  ', '', '', '> 인용도 원문 간격 유지', '', '- 다음 항목'].join('\n');
    const body = ['## 요청', '- 앞 절 고유', '', intent, '', '## 구현 요약', 'z'.repeat(MAX_REVIEW_INTENT_CHARS * 3)].join('\n');
    const out = intentFromPr({ title: 'T', body });
    expect(out).toContain(intent);
    expect(out).toContain('- 앞 절 고유');
  });

  test('첫 헤더 앞의 머리말을 «잃지 않는다»', () => {
    const body = ['사람이 쓴 머리말', '', '## 수용기준', '- 지킬 것', 'q'.repeat(MAX_REVIEW_INTENT_CHARS)].join('\n');
    const out = intentFromPr({ title: 'T', body });
    expect(out).toContain('사람이 쓴 머리말');
  });

  // ⛔⭐ 리뷰 should-fix — 우선순위 절이 «여럿»이면 머리말이 밀릴 수 있는데 종전 검사는 단순 사례뿐이었다.
  test('우선순위 절이 여럿이어도 머리말 «본문»이 남는다', () => {
    const body = [
      '사람이 쓴 머리말 — 이 줄이 살아야 한다', '',
      '## 수용기준', '- A'.repeat(400), '',
      '## SCOPE BOUNDARY', '- B'.repeat(400), '',
      '## 불변식', '- C'.repeat(400), '',
      '## 판정 신호', '- D'.repeat(400), '',
      '## RULES', '- E'.repeat(400), '',
      '## 구현 요약', 'z'.repeat(20_000),
    ].join('\n');
    const out = intentFromPr({ title: 'T', body });
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain('사람이 쓴 머리말 — 이 줄이 살아야 한다');
  });
});

// ⛔⭐⭐⭐ 무인 리뷰 must-fix 둘 — 관측기가 «완성 문자열을 되파싱»해서 생긴 오판 두 형태.
//   근본은 되파싱이었고 조립기가 절별 조각을 직접 넘기게 바꿨다. 그 형태를 여기서 문다.
describe('prIntentSectionCoverage — 되파싱이 냈던 오판 둘', () => {
  // ⛔⭐⭐ **2R must-fix** — 초판 검사는 `intentPriorityWithBody <= intentPriorityTotal` 이라는
  //   ***항상 참인 관계***만 단언해 과대계상을 **전혀 못 잡았다**(비우선순위 제목을 중복시킨 탓도 겹쳤다).
  //   ⇒ ***옛 되파싱 구현이면 «실패»하고 지금 구현이면 «통과»하는*** 형태로 다시 세운다:
  //     같은 «우선순위» 제목이 둘인데 앞은 온전히 살고 뒤는 제목만 남는 배치를 만든다.
  //     옛 코드는 두 블록 다 `indexOf('## 수용기준')` → 첫 occurrence 를 봐 **2** 를 냈다. 정답은 **1**.
  test('⛔ 같은 «우선순위» 제목이 두 번이어도 뒤쪽의 생존을 앞쪽으로 «접어» 세지 않는다', () => {
    // ⚠️ 첫 판은 「뒤쪽이 제목만 남는다」로 지었는데 **안 갈렸다** — `preserveBody` 가 부분 본문을
    //   살려 둘 다 body 를 갖는다(의도된 동작). ⇒ 뒤쪽이 «통째로 빠지는» 배치로 짓는다:
    //   절이 아주 많으면 조립기가 compacted 분기로 가 뒤쪽 블록을 **빈 조각**으로 떨군다.
    const filler = Array.from({ length: 300 }, (_, i) => `## 절${i}\n${'f'.repeat(200)}`).join('\n\n');
    const body = ['## 수용기준', '- 앞쪽은 온전히 산다', '', filler, '', '## 수용기준', '- 뒤쪽'].join('\n');
    const cov = prIntentSectionCoverage({ title: 'T', body });
    expect(cov.intentPriorityTotal).toBe(2);      // ⭐ 제목이 같아도 «두 절»로 센다(신원 기준)
    // ⛔⭐⭐ **3R 리뷰 must-fix ①** — 종전엔 이 자리에서 `0` 을 «정상»으로 못 박아
    //   *"판정 절이 본문까지 살아남는다"* 는 핵심 수용기준을 이 분기에서 위반하고 있었다.
    //   ⇒ 이제 남는 예산으로 판정 절의 본문을 살린다. 최소 하나는 본문을 갖는다.
    expect(cov.intentPriorityWithBody!).toBeGreaterThanOrEqual(1);
    const out = intentFromPr({ title: 'T', body });
    expect(out).toContain('- 앞쪽은 온전히 산다');
  });

  // ⛔⭐⭐⭐ **3R must-fix ①** — 절이 아주 많아 compacted 분기로 가도 «판정 절»이 살아남아야 한다.
  //   종전 선택은 «문서 순서»라 뒤쪽을 잘랐는데, 이 저장소의 하니스 본문은 `## 리뷰 intent` 가 «맨 뒤»다
  //   — ***고치려던 그 결함이 이 분기에 그대로 있었다.***
  test('⛔ 절이 폭발해도 «맨 뒤»의 판정 절이 살아남는다 (선택이 우선순위 순)', () => {
    const filler = Array.from({ length: 400 }, (_, i) => `## 절${i}\n${'f'.repeat(300)}`).join('\n\n');
    const body = [filler, '', '## 리뷰 intent', '수용기준', '- 이 줄이 리뷰어에게 닿아야 한다'].join('\n');
    const out = intentFromPr({ title: 'T', body });
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain('## 리뷰 intent');
    expect(out).toContain('- 이 줄이 리뷰어에게 닿아야 한다');   // ⭐ 제목만이 아니라 «본문»까지
  });

  // ⛔⭐ **3R must-fix ②** — 우선순위 0 헤더가 많아도 머리말(우선순위 1)이 통째로 탈락하면 안 된다.
  test('⛔ 판정 절이 아주 많아도 머리말이 «통째로» 탈락하지 않는다', () => {
    const many = Array.from({ length: 120 }, (_, i) => `## 수용기준 ${i}\n- ${'a'.repeat(100)}`).join('\n\n');
    const body = ['사람이 쓴 머리말 — 이 줄이 살아야 한다', '', many].join('\n');
    const out = intentFromPr({ title: 'T', body });
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain('사람이 쓴 머리말');
  });

  // ⛔⭐ **못 잠근 것을 적는다**(2R must-fix 를 «완전히»는 못 닫았다):
  //   되파싱 버그의 결정적 형태는 ***같은 제목 둘 중 앞은 본문이 살고 뒤는 제목만 남는*** 비대칭인데,
  //   그 배치를 «결정론으로» 못 지었다 — 예산 분기는 두 절에 fair share 를 같이 주고(둘 다 부분 본문),
  //   compacted 분기는 둘 다 minimumBlock 으로 만든다(둘 다 본문 0). 두 분기 다 옛 구현과 «같은 값»이다.
  //   ⇒ 여기서 잠근 것은 **①신원 기준 계수 ②빠진 절의 본문 누출 없음**까지다.
  //     되파싱 재발은 이 검사들이 아니라 **구현이 `perBlock` 을 받는다는 사실**이 막는다.
  test('제목이 같아도 절 신원으로 센다 — 계수가 제목으로 접히지 않는다', () => {
    const body = ['## 수용기준', '- 하나', '', '## 수용기준', '- 둘', '', '## 구현 요약', 'z'.repeat(30_000)].join('\n');
    const cov = prIntentSectionCoverage({ title: 'T', body });
    expect(cov.intentSections).toBe(3);
    expect(cov.intentPriorityTotal).toBe(2);
  });

  // ⛔⭐ **2R should-fix** — 「출력의 절 순서가 원문과 같다」를 상한 초과 경로에서 직접 문다.
  //   우선순위 «정렬»이 출력 «정렬»로 번지면 여기서 깨진다.
  test('⛔ 우선순위 예산이 출력 «순서»로 번지지 않는다 (원문 순서 유지)', () => {
    const body = [
      '## 요청', '기능을 만든다'.repeat(50), '',       // 우선순위 2 인데 원문에선 «앞»
      '## 수용기준', '- 판정 기준', '',               // 우선순위 0 인데 원문에선 «뒤»
      '## 구현 요약', 'z'.repeat(30_000),
    ].join('\n');
    const out = intentFromPr({ title: 'T', body });
    const atRequest = out.indexOf('## 요청');
    const atAcceptance = out.indexOf('## 수용기준');
    expect(atRequest).toBeGreaterThanOrEqual(0);
    expect(atAcceptance).toBeGreaterThanOrEqual(0);
    expect(atRequest).toBeLessThan(atAcceptance);   // ⭐ 예산은 뒤집혀도 순서는 원문 그대로
  });

  test('⛔ 헤더 뒤 «빈 줄»이 있어도 본문 생존을 오판하지 않는다 (정상 마크다운)', () => {
    // 초판은 split('\n\n')[0] 이라 `## 수용기준\n\n- 항목` 에서 빈 문자열을 보고 「제목만」이라 적었다.
    const body = [
      '## 수용기준', '', '- 반드시 지킬 것', '',
      '## 구현 요약', 'z'.repeat(20_000),
    ].join('\n');
    const cov = prIntentSectionCoverage({ title: 'T', body });
    expect(cov.intentPriorityWithBody).toBe(1);
    expect(cov.intentTitleOnly ?? []).not.toContain('수용기준');
  });

  test('상한 이하면 관측도 «빈 객체»다 (구 payload 보존)', () => {
    expect(prIntentSectionCoverage({ title: 'T', body: '## 수용기준\n- 짧다' })).toEqual({});
  });

  test('상한 이하면 손대지 않는다', () => {
    expect(intentFromPr({ title: 'T', body: '짧은 본문' })).toBe('짧은 본문');
  });
});

describe('capIntent — 절단 표기 공용화(수동·조립 경로 공통)', () => {
  test('상한 이하면 그대로', () => {
    expect(capIntent('짧다')).toBe('짧다');
  });

  test('관측 메타데이터는 절단 때만 상한 전 길이와 절을 낸다', () => {
    const text = ['## 목표', 'x'.repeat(100), '## 검증', 'y'.repeat(MAX_REVIEW_INTENT_CHARS)].join('\n');
    expect(reviewIntentTruncationObservation(text)).toEqual({
      intentTruncated: true,
      intentTotalChars: text.length,
      intentSection: '검증',
    });
    expect(reviewIntentTruncationObservation('짧다')).toEqual({});
  });

  test('마크다운 헤더를 절 이름으로 인식한다', () => {
    const t = ['# 서론', 'x'.repeat(50), '## 세부 계약', 'y'.repeat(MAX_REVIEW_INTENT_CHARS)].join('\n');
    const out = capIntent(t);
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain("'세부 계약' 블록부터 잘렸습니다");
  });

  test('절 제목이 없으면 뒤쪽으로 표기한다 (거짓 지목 금지)', () => {
    const out = capIntent('z'.repeat(MAX_REVIEW_INTENT_CHARS + 200));
    expect(out).toContain("'뒤쪽' 블록부터 잘렸습니다");
  });
});

// ⛔⭐⭐ 인수 검증(2026-07-31) — 자율 런은 여기까지 못 왔다. 셋을 고정한다:
//   ① 표로 쓴 경계도 읽힌다(이 저장소의 골은 경계를 **표로** 쓴다 — 실측)
//   ② 표 **헤더 행**은 항목이 아니다(열 제목이 경계로 새면 리뷰가 헛것을 본다)
//   ③ 예산 배분이 실제로 동작한다(⭐ 이것이 없으면 되돌려도 초록이라 `[break]` 가 성립 안 한다)
describe('review-intent 인수 검증 — 표 경계 · 헤더 · 예산 배분', () => {
  const bigGoal = (boundaryAsTable: boolean): string => [
    '## PROBLEM',
    // ⛔ **여러 줄**이어야 한다 — 한 줄짜리 거대 본문은 줄 단위 압축이 **통째로 버려** 결과가
    //    작아지고, 그러면 예산 배분을 되돌려도 상한을 안 넘어 `[break]` 가 성립하지 않는다(실측).
    ...Array.from({ length: 400 }, (_, n) => `문제 서술 ${n} ${'가'.repeat(40)}`),
    '## SCOPE BOUNDARY',
    ...(boundaryAsTable
      ? ['| ⛔ 하지 않는 것 | 이유 |', '|---|---|', '| 상한을 올리지 않는다 | 배분이 문제다 |', '| 관측을 더하지 않는다 | 별개 항목이다 |']
      : ['- 상한을 올리지 않는다', '- 관측을 더하지 않는다']),
    '## 수용기준',
    '- 경계가 리뷰에 도달한다',
  ].join('\n');

  test('⭐ 표로 쓴 경계도 리뷰에 도달한다(불릿만 읽던 종전 형태의 회귀)', () => {
    const out = buildReviewIntent({ goal: bigGoal(true), round: 1 } as never);
    expect(out).toContain('상한을 올리지 않는다');
    expect(out).toContain('관측을 더하지 않는다');
  });

  test('⛔ 표 헤더 행은 경계 항목이 아니다', () => {
    const out = buildReviewIntent({ goal: bigGoal(true), round: 1 } as never);
    expect(out).not.toContain('하지 않는 것 |');
    expect(out).not.toMatch(/-\s*⛔ 하지 않는 것\s*$/m);
  });

  // ⭐⭐ `[break]` 의 실체 — 예산 배분을 되돌리면 **여기가 붉어진다**.
  //    되돌리면 모든 블록이 상한을 통째로 받아 합계가 상한을 넘는다.
  test('⭐⭐ 거대한 골에서도 상한을 지키면서 경계를 보존한다(예산 배분이 실제로 동작한다)', () => {
    const out = buildReviewIntent({ goal: bigGoal(false), round: 1 } as never);
    expect(out.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(out).toContain('상한을 올리지 않는다');       // 경계가 살아남는다
    expect(out).toContain('경계가 리뷰에 도달한다');       // 수용기준도 살아남는다
    expect(out).toContain('생략됨');                    // 목표는 통째로 버려지지 않고 압축된다
  });
});

// ⭐⭐⭐ 실측 회귀 — 두 트랙 합쳐 여섯 런이 *"통합 테스트를 실행하지 않았다 · break/restore 출력이 없다"*
// 로 죽었는데, 자식은 셋을 전부 했고 그 EVIDENCE/RESULT 가 **intent 예산 배분에서 통째로 증발**했다.
// 종전 순서는 [보호블록, 목표, 나머지] 라 15,383자짜리 골이 남은 예산을 먹고 증거는 제목 + `…[N개
// 생략됨]` 만 남았다. ⛔ 원인은 **순서 하나뿐**이다 — 1R 은 `fitBlock` 미달분 회수도 원인이라 적었으나
// 실제 골로 분리 측정하니 순서만으로 3,899 · 회수를 더해도 3,899 로 **기여가 0** 이었다(그 코드는 지웠다).
describe('review-intent — 자식의 증거가 목표 본문보다 먼저다 (여섯 런 사망 회귀)', () => {
  const hugeGoal = `## PROBLEM\n${'골 본문이 예산을 통째로 먹는다. '.repeat(600)}\n\n## ACCEPTANCE CRITERIA\n- 수용기준 하나\n\n## SCOPE BOUNDARY\n- 경계 하나`;
  const claims = [
    { claim: '명시된 통합 회귀를 실행했다', verify: 'bun test src/self-implement/goal-author.test.ts', result: '49 pass, 0 fail' },
    { claim: '의도적 break 후 focused 회귀를 실행했다', verify: 'bun test src/autopilot/mission-codebase-gate.test.ts -t "identifier"', result: 'break 상태에서 Expected: false / Received: true 로 1 fail, 이후 복원' },
  ];

  test('거대한 골에서도 자식의 주장·검증명령·결과가 셋 다 살아남는다', () => {
    const intent = buildReviewIntent({ goal: hugeGoal, diffOutsideClaims: claims });
    expect(intent.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    for (const { claim, verify, result } of claims) {
      expect(intent).toContain(claim);
      expect(intent).toContain(verify);
      expect(intent).toContain(result);
    }
  });

  test('base 적색 목록도 목표 본문보다 먼저 실린다', () => {
    const intent = buildReviewIntent({
      goal: hugeGoal,
      preexistingTestFailures: ['goal author > derives the general-search warning'],
    });
    expect(intent.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    expect(intent).toContain('goal author > derives the general-search warning');
  });

  test('어떤 골 크기에서도 상한을 넘지 않는다', () => {
    for (const repeat of [200, 400, 600, 800]) {
      const goal = `## PROBLEM\n${'가나다라마바사 '.repeat(repeat)}\n\n## ACCEPTANCE CRITERIA\n- 하나\n\n## SCOPE BOUNDARY\n- 하나`;
      expect(buildReviewIntent({ goal, diffOutsideClaims: claims }).length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    }
  });

  // ⭐⭐⭐ JDG-S5 회귀 — 순서를 고쳐도(#6271) **보호 블록이 예산을 다 먹으면** 증거는 제목만 남는다.
  // 실측: 골 17,867자에서 `수용기준 1,459` ⊕ `의도적 스코프 경계 2,414` 가 4,000 을 거의 다 먹고
  // 증거 블록은 **44자(제목)** 였다. 같은 라운드에 하니스는 `coveredEvidence: 8 · missingEvidence: []`
  // 를 기록했는데 리뷰는 "필수 파괴 검증 증거가 없다" 를 냈다 — 파서는 봤고 판정자는 못 봤다.
  // ⭐⭐⭐ JDG-S4·S5 셋째 얼굴 — 하니스가 `coveredEvidence`/`missingEvidence` 를 **이미 계산해**
  // 로그에 남기는데 그 값이 리뷰어에게 안 갔다. 오늘 두 번, 리뷰가 "증거가 없다" 를 냈고 같은 라운드
  // 로그는 `missingEvidence:[]` 였다. ⇒ 기계 판정을 intent 에 싣는다(⛔ 판정을 대신하지 않는다).
  test('하니스의 증거 충족도가 intent 에 실린다', () => {
    const intent = buildReviewIntent({
      goal: '## PROBLEM\n짧은 골',
      evidenceCoverage: { required: 8, covered: 8, missing: [] },
    });
    expect(intent).toContain('골이 요구한 증거 태그');
    expect(intent).toContain('태그 8개');
    expect(intent).toContain('매칭 8개');
    expect(intent).toContain('누락: 없음');
  });

  test('누락이 있으면 태그 이름이 그대로 실린다', () => {
    const intent = buildReviewIntent({
      goal: '## PROBLEM\n짧은 골',
      evidenceCoverage: { required: 3, covered: 1, missing: ['break-restore', 'tsc'] },
    });
    expect(intent).toContain('누락: break-restore, tsc');
  });

  test('골이 태그를 요구하지 않으면 그 절이 아예 없다 — 빈 계약을 만들지 않는다', () => {
    const intent = buildReviewIntent({
      goal: '## PROBLEM\n짧은 골',
      evidenceCoverage: { required: 0, covered: 0, missing: [] },
    });
    expect(intent).not.toContain('골이 요구한 증거 태그');
  });

  test('보호 블록이 커도 증거가 제목만 남지 않는다 — 공정 몫', () => {
    // ⚠️ 형태를 실측에 맞춘다: 보호 블록은 **12항목 × 긴 줄**(항목 상한이 12라 그 이상은 안 커진다).
    const boundary = Array.from({ length: 12 }, (_, i) => `- 경계 ${i}: ${'이 PR 이 일부러 안 하는 것과 그 이유를 길게 적는다. '.repeat(6)}`).join('\n');
    const acceptance = Array.from({ length: 12 }, (_, i) => `- 수용 기준 ${i}: ${'관측 가능한 신호 하나를 길게 적는다. '.repeat(4)}`).join('\n');
    const goal = `## PROBLEM\n${'본문 '.repeat(2000)}\n\n## ACCEPTANCE CRITERIA\n${acceptance}\n\n## SCOPE BOUNDARY\n${boundary}`;
    const evidence = Array.from({ length: 6 }, (_, i) => ({
      claim: `[tag-${i}] 확인 항목 ${i} 를 실행했다`,
      verify: `bun test src/foo-${i}.test.ts`,
      result: i === 0 ? 'error: expect(received).toContain(expected) / 복원 후 1 pass 0 fail' : `${10 + i} pass 0 fail`,
    }));
    const intent = buildReviewIntent({ goal, diffOutsideClaims: evidence });
    expect(intent.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    // ⛔ 공정 몫이 없으면 경계가 예산을 먹고 이 여섯이 **전부** 사라진다(실측 0/6).
    for (const { claim, verify, result } of evidence) {
      expect(intent).toContain(claim);
      expect(intent).toContain(verify);   // 리뷰 1R should-fix — 재현 명령도 도달해야 한다
      expect(intent).toContain(result);
    }
  });

  // 한 줄이 통째로 예산을 넘는 병리적 골에서도 증거는 살아남아야 한다(순서 불변식).
  test('목표의 한 줄이 예산보다 커도 증거는 살아남는다', () => {
    const giant = 'ㄱ'.repeat(3000);   // 한 줄이 통째로 커서 어떤 slack 으로도 못 들어간다
    const intent = buildReviewIntent({
      goal: `## PROBLEM\n${giant}\n\n## ACCEPTANCE CRITERIA\n- 하나\n\n## SCOPE BOUNDARY\n- 하나`,
      appliedLastRound: [`직전 반영 항목 ${'가'.repeat(40)}`],
      diffOutsideClaims: claims,
    });
    expect(intent.length).toBeLessThanOrEqual(MAX_REVIEW_INTENT_CHARS);
    for (const { claim, result } of claims) {
      expect(intent).toContain(claim);
      expect(intent).toContain(result);
    }
  });
});
