// ── mission-critique(R0) 단위테스트 — dogfood 6 PR 실패유형 회귀 픽스처(대표 2026-07-12). ──
import { describe, it, expect } from 'bun:test';
import { critiquePhaseDeterministic, planReferencedFiles, renderCritique, critiquePhaseWithLLM, parseLLMCritique, worseVerdict, buildCritiquePrompt, isSplitSubphasePlan, buildReviewPrompt, parseReviewResult, reviewPullRequest, reviewToPhaseFields, renderReview, diffSection, DIFF_TRUNCATION_RULES, splitDiffByFile, budgetFileDiff, budgetedDiff } from './mission-critique.js';

describe('isSplitSubphasePlan / buildCritiquePrompt — 분할 서브페이즈 비평 스코핑(대표 2026-07-12)', () => {
  it('[분할 N/M] 마커 감지', () => {
    expect(isSplitSubphasePlan('# PLAN\n[분할 1/4] KGS 스키마 마이그레이션')).toBe(true);
    expect(isSplitSubphasePlan('[ 분할 2 / 4 ] pack 왕복')).toBe(true);
    expect(isSplitSubphasePlan('# PLAN\nKGS 메타데이터 추가')).toBe(false);
  });
  it('분할 프롬프트엔 dead-code/범위밖-파일 완화 컨텍스트 주입', () => {
    const split = buildCritiquePrompt({ planBody: '[분할 1/4] 스키마', changedFiles: ['a.ts'], diff: '' });
    expect(split).toContain('ONE PIECE of a larger feature');
    expect(split).toContain('WIRED BY LATER sub-phases');
    const normal = buildCritiquePrompt({ planBody: '일반 페이즈', changedFiles: ['a.ts'], diff: '' });
    expect(normal).not.toContain('ONE PIECE of a larger feature');
  });
});

describe('critiquePhaseDeterministic — dogfood 실패유형', () => {
  it('범위밖 코어 훼손(1차 재실행 #3840류: mission-engine) → fail', () => {
    const r = critiquePhaseDeterministic({
      planBody: 'src/knowledge/kgs/types.ts 에 lifecycle 메타 추가',
      changedFiles: ['src/knowledge/kgs/types.ts', 'src/autopilot/mission-engine.ts'],
      diff: '',
    });
    expect(r.verdict).toBe('fail');
    expect(r.outOfScope).toContain('src/autopilot/mission-engine.ts');
    expect(r.findings.join(' ')).toContain('코어 민감');
  });

  it('범위 내(순수 대상 파일) → pass (2차 재실행 #3848류)', () => {
    const r = critiquePhaseDeterministic({
      planBody: 'src/knowledge/kgs/types.ts·src/knowledge/kgs/pack.ts 확장',
      changedFiles: ['src/knowledge/kgs/types.ts', 'src/knowledge/kgs/pack.ts'],
      diff: '',
    });
    expect(r.verdict).toBe('pass');
    expect(r.outOfScope).toEqual([]);
  });

  it('같은 디렉토리 파일은 관대(범위 내 pass)', () => {
    const r = critiquePhaseDeterministic({
      planBody: 'src/domains/memory-lifecycle.ts 확장',
      changedFiles: ['src/domains/memory-archive.ts'],
      diff: '',
    });
    expect(r.verdict).toBe('pass');
  });

  it('Goodhart: 프로덕션 코드 삭제 + 테스트 변경 → fail', () => {
    const r = critiquePhaseDeterministic({
      planBody: 'src/domains/x.ts',
      changedFiles: ['src/domains/x.ts', 'src/domains/x.test.ts'],
      diff: '\n-  export function spawnRun() {}\n+// removed',
    });
    expect(r.goodhartSuspect).toBe(true);
    expect(r.verdict).toBe('fail');
  });

  it('검증 페이즈(테스트 파일만) → 범위밖 제외·pass (#3855류)', () => {
    const r = critiquePhaseDeterministic({
      planBody: '검증 코드만 추가',
      changedFiles: ['src/domains/memory-archive.test.ts'],
      diff: '+test(...)',
    });
    expect(r.verdict).toBe('pass');
  });

  it('범위밖이나 코어 아님 → warn(PR 은 만들되 표시)', () => {
    const r = critiquePhaseDeterministic({
      planBody: 'src/domains/a.ts 확장',
      changedFiles: ['src/domains/a.ts', 'src/knowledge/unrelated.ts'],
      diff: '',
    });
    expect(r.verdict).toBe('warn');
    expect(r.outOfScope).toContain('src/knowledge/unrelated.ts');
  });
});

describe('planReferencedFiles', () => {
  it('경로 추출', () => {
    const s = planReferencedFiles('수정 대상: src/a/b.ts 와 scripts/c.ts 및 test/d.test.ts');
    expect(s.has('src/a/b.ts')).toBe(true);
    expect(s.has('scripts/c.ts')).toBe(true);
    expect(s.has('test/d.test.ts')).toBe(true);
  });
});

describe('renderCritique', () => {
  it('pass/ fail 렌더', () => {
    expect(renderCritique({ verdict: 'pass', outOfScope: [], goodhartSuspect: false, findings: [] })).toContain('✅');
    expect(renderCritique({ verdict: 'fail', outOfScope: ['x'], goodhartSuspect: false, findings: ['범위밖 1건'] })).toContain('⛔');
  });
});

describe('R1 LLM 병합', () => {
  const clean = { planBody: 'src/a.ts 확장', changedFiles: ['src/a.ts'], diff: '' };
  it('llmReview 미주입 → 결정론만(pass)', async () => {
    expect((await critiquePhaseWithLLM(clean)).verdict).toBe('pass');
  });
  it('LLM fail → 병합 fail + [LLM] 태그', async () => {
    const r = await critiquePhaseWithLLM(clean, async () => 'VERDICT: FAIL\n- 기존 모듈 중복 재구현');
    expect(r.verdict).toBe('fail');
    expect(r.findings.join(' ')).toContain('[LLM] 기존 모듈 중복');
  });
  it('LLM throw → 결정론 폴백(무중단)', async () => {
    const r = await critiquePhaseWithLLM(clean, async () => { throw new Error('llm down'); });
    expect(r.verdict).toBe('pass');
  });
});

describe('parseLLMCritique · worseVerdict', () => {
  it('parse verdict + findings', () => {
    const p = parseLLMCritique('VERDICT: WARN\n- 지적 a\n- 지적 b\n무관 줄');
    expect(p.verdict).toBe('warn');
    expect(p.findings).toEqual(['지적 a', '지적 b']);
  });
  it('worseVerdict', () => {
    expect(worseVerdict('pass', 'fail')).toBe('fail');
    expect(worseVerdict('warn', 'pass')).toBe('warn');
    expect(worseVerdict('pass', 'pass')).toBe('pass');
  });
});

// ── 자율 PR 리뷰 계약(R0·RFC-autonomous-pr-review-agent 2026-07-20) ──────────────
describe('buildReviewPrompt — post-PR 산출물 검증(pre-PR scope-guard 아님)', () => {
  const base = { prDiff: '+ const x = 1;', phaseIntent: 'lineage 통계 helper 추가' };
  it('의도·수용기준·워킹메모리 주입 + VERDICT 계약', () => {
    const p = buildReviewPrompt({ ...base, acceptance: 'helper 는 export 되고 테스트가 있다', workingMemory: '이전 결정: sqlite-store 재사용' });
    expect(p).toContain('POST-PR review');
    expect(p).toContain('lineage 통계 helper 추가');
    expect(p).toContain('helper 는 export');
    expect(p).toContain('sqlite-store 재사용');
    expect(p).toContain('VERDICT: PASS | VERDICT: WARN | VERDICT: FAIL');
  });
  it('선택 필드 미주입 시 섹션 생략', () => {
    const p = buildReviewPrompt(base);
    expect(p).not.toContain('Acceptance criteria');
    expect(p).not.toContain('working memory');
  });
});

describe('parseReviewResult — critic Verdict/Must-fix/Should-fix 파싱', () => {
  it('FAIL + must-fix/should-fix 분해', () => {
    const r = parseReviewResult('VERDICT: FAIL\nMUST-FIX:\n- 새 helper 가 어디서도 호출 안 됨(dead)\n- 반환 타입 오류\nSHOULD-FIX:\n- 네이밍 개선');
    expect(r.verdict).toBe('fail');
    expect(r.mustFix).toEqual(['새 helper 가 어디서도 호출 안 됨(dead)', '반환 타입 오류']);
    expect(r.shouldFix).toEqual(['네이밍 개선']);
  });
  it('PASS → 블로커 없음', () => {
    const r = parseReviewResult('VERDICT: PASS\n산출물이 의도와 정합.');
    expect(r.verdict).toBe('pass');
    expect(r.mustFix).toEqual([]);
  });
  it('FAIL 인데 must-fix 미기재 → 최소 1 블로커 보장(findings 소실 방지)', () => {
    const r = parseReviewResult('VERDICT: FAIL\nSHOULD-FIX:\n- 수용기준 미달');
    expect(r.verdict).toBe('fail');
    expect(r.mustFix.length).toBeGreaterThanOrEqual(1);
  });
  it('VERDICT 부재 → pass 폴백', () => {
    expect(parseReviewResult('음 잘 모르겠음').verdict).toBe('pass');
  });
});

describe('reviewPullRequest — llmReview seam·fail-soft', () => {
  const input = { prDiff: '+x', phaseIntent: 'p' };
  it('llmReview 미주입 → pass·reviewed=false(리뷰 skip·R3 자동머지 배제)', async () => {
    const r = await reviewPullRequest(input);
    expect(r.verdict).toBe('pass');
    expect(r.reviewed).toBe(false);
  });
  it('LLM FAIL → 재작업 블로커·reviewed=true', async () => {
    const r = await reviewPullRequest(input, async () => 'VERDICT: FAIL\nMUST-FIX:\n- 미배선');
    expect(r.verdict).toBe('fail');
    expect(r.mustFix).toEqual(['미배선']);
    expect(r.reviewed).toBe(true);
  });
  it('LLM PASS → reviewed=true(실제 리뷰 통과·자동머지 대상)', async () => {
    const r = await reviewPullRequest(input, async () => 'VERDICT: PASS\n산출물 정합.');
    expect(r.verdict).toBe('pass');
    expect(r.reviewed).toBe(true);
  });
  it('LLM throw → fail-soft pass·reviewed=false(미검토·자동머지 배제)', async () => {
    const r = await reviewPullRequest(input, async () => { throw new Error('llm down'); });
    expect(r.verdict).toBe('pass');
    expect(r.reviewed).toBe(false);
  });
});

describe('review-context 파일별 예산 head/tail 절단(dogfood #4788/#4791)', () => {
  const fileDiff = (path: string, n: number) => `diff --git a/${path} b/${path}\n@@\n` + Array.from({ length: n }, (_, i) => `+line ${i} of ${path}`).join('\n') + '\n';

  it('splitDiffByFile — diff --git 경계로 파일 분할', () => {
    const d = fileDiff('a.ts', 3) + fileDiff('b.ts', 3);
    const parts = splitDiffByFile(d);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('a/a.ts');
    expect(parts[1]).toContain('a/b.ts');
  });
  it('splitDiffByFile — 비표준(diff --git 없음) → 통째 1청크', () => {
    expect(splitDiffByFile('random text no header')).toHaveLength(1);
  });

  it('budgetFileDiff — 예산 이내면 전체', () => {
    expect(budgetFileDiff('short', 100)).toBe('short');
  });
  it('budgetFileDiff — 초과면 head + tail(중간 생략·후반 hunk 보존)', () => {
    const big = fileDiff('big.ts', 200); // 크게
    const b = budgetFileDiff(big, 600);
    expect(b).toContain('omitted mid-file');
    expect(b).toContain('line 0 of big.ts');     // head(앞부분)
    expect(b).toContain('line 199 of big.ts');    // ★ tail(후반부) — head-only 절단의 맹점 해소
    expect(b.length).toBeLessThan(big.length);
  });

  it('budgetedDiff — 한도 이내 → 전체(절단 없음)', () => {
    const d = fileDiff('a.ts', 3);
    expect(budgetedDiff(d, 10000)).toMatchObject({ truncated: false, files: 1 });
  });
  it('★ budgetedDiff — 초대형 다파일 → 모든 파일 표현 + text.length ≤ limit(예산 하드 보장)', () => {
    const d = fileDiff('first.ts', 300) + fileDiff('middle.ts', 300) + fileDiff('last.ts', 300);
    const r = budgetedDiff(d, 3000);
    expect(r.truncated).toBe(true);
    expect(r.files).toBe(3);
    expect(r.text).toContain('a/first.ts');
    expect(r.text).toContain('a/last.ts');   // ★ 종전 head-only 면 숨겨졌을 마지막 파일도 보인다
    expect(r.text.length).toBeLessThanOrEqual(3000); // ★ 예산 절대 보장(dogfood #4793)
  });
  it('★ budgetedDiff — 작은 파일 多(초대형) → text.length ≤ limit 보장 + 초과 파일 수 고지', () => {
    // 200개 작은 파일 — 종전 Math.max(400,..) floor 면 400*200=80000 >> limit(무력화).
    const many = Array.from({ length: 200 }, (_, i) => fileDiff(`f${i}.ts`, 2)).join('');
    const r = budgetedDiff(many, 8000);
    expect(r.text.length).toBeLessThanOrEqual(8000);         // ★ 하드 보장(리뷰어 #4793 핵심)
    expect(r.files).toBe(200);
    expect(r.text).toContain('more changed file(s) omitted'); // 파일 과다 → 나머지 고지
  });
  it('budgetedDiff — 프리앰블은 files 카운트서 제외(diff --git 만)', () => {
    const d = 'PR preamble text\n' + fileDiff('a.ts', 2);
    expect(budgetedDiff(d, 10000).files).toBe(1); // 프리앰블은 파일 아님
  });

  it('diffSection — 한도 이내 → 전체(경고 없음)', () => {
    const s = diffSection('+small', 10000);
    expect(s[0]).toBe('## PR diff');
    expect(s.join('\n')).not.toContain('budget-truncated');
  });
  it('diffSection — 초과 → 예산 절단 + "누락 단정 금지" 경고', () => {
    const d = fileDiff('a.ts', 300) + fileDiff('b.ts', 300);
    const s = diffSection(d, 2000);
    expect(s.join('\n')).toContain('budget-truncated');
    expect(s.join('\n')).toContain('EVERY changed file is represented');
    // ⭐문구를 복제하지 않고 **같은 출처**(`DIFF_TRUNCATION_RULES`)를 참조한다. 항목으로 검사하는
    //   이유: 합본 하나만 `toContain` 하면 **상수를 비워도 통과**해 *"규율이 빠지면 깨진다"* 가
    //   성립하지 않는다. 아래 셋이 각각 다른 실패를 잡는다 —
    //   개수=항목 **삭제** · 비어있지-않음=**빈 값** · 포함=**렌더에서 누락**. 문구 다듬기는 전부 통과한다.
    //   ⚠️ 길이 하한(예: >20)을 두면 **짧게 다듬은 정당한 문구**까지 깨뜨린다 — 임의 수치 금지.
    const rules = Object.values(DIFF_TRUNCATION_RULES);
    expect(rules).toHaveLength(3);
    for (const rule of rules) {
      expect(rule.trim()).not.toBe('');
      expect(s.join('\n')).toContain(rule);
    }
  });
});

describe('reviewToPhaseFields — [CRITIQUE:*] 각인용 매핑(rebuild 경로 연결)', () => {
  it('fail → critiqueVerdict=fail + mustFix 를 findings 로(재작업 유발)', () => {
    expect(reviewToPhaseFields({ verdict: 'fail', mustFix: ['미배선', '오류'], shouldFix: [] }))
      .toEqual({ critiqueVerdict: 'fail', critiqueFindings: ['미배선', '오류'] });
  });
  it('warn → critiqueVerdict=warn + shouldFix(PR 코멘트)', () => {
    expect(reviewToPhaseFields({ verdict: 'warn', mustFix: [], shouldFix: ['네이밍'] }))
      .toEqual({ critiqueVerdict: 'warn', critiqueFindings: ['네이밍'] });
  });
  it('pass → 빈 결과(각인 없음)', () => {
    expect(reviewToPhaseFields({ verdict: 'pass', mustFix: [], shouldFix: [] })).toEqual({});
  });
  it('warn 인데 shouldFix 없음 → 빈 결과(불필요 각인 방지)', () => {
    expect(reviewToPhaseFields({ verdict: 'warn', mustFix: [], shouldFix: [] })).toEqual({});
  });
});

// ── 칸 MISSION-CRITIQUE-FAILCLOSED(REVIEW-NO-VERDICT-FAILCLOSED #25937) — «판정 없음 = 통과 아님» ──
describe('parseLLMCritique — fail-closed 판정(VERDICT 줄 없으면 pass 가 아니다)', () => {
  it('VERDICT 줄 없는 응답 → pass 가 아니다 + 사유 finding(기존 bullet 추출은 보존)', () => {
    const p = parseLLMCritique('구현이 의도와 정합해 보인다.\n- 사소한 네이밍 지적');
    expect(p.verdict).not.toBe('pass');
    expect(p.verdict).toBe('warn');
    expect(p.findings.join(' ')).toContain('VERDICT');
    expect(p.findings).toContain('사소한 네이밍 지적');
    expect(p.findings.length).toBeLessThanOrEqual(4);
  });
  it('빈 응답 → pass 가 아니다', () => {
    expect(parseLLMCritique('').verdict).not.toBe('pass');
  });
  it('본문 중간 VERDICT 는 판정으로 안 읽는다(줄 머리만 인정)', () => {
    const p = parseLLMCritique('결론을 쓰자면 VERDICT: PASS 라고 하고 싶지만 근거가 없다.\n- 지적 a');
    expect(p.verdict).not.toBe('pass');
    expect(p.verdict).toBe('warn');
  });
  it('줄 머리 VERDICT 는 그대로 읽는다(들여쓰기 허용 · PASS/WARN/FAIL)', () => {
    expect(parseLLMCritique('  VERDICT: FAIL\n- 미배선').verdict).toBe('fail');
    expect(parseLLMCritique('VERDICT: pass').verdict).toBe('pass');
    expect(parseLLMCritique('VERDICT: WARN\n- 지적').verdict).toBe('warn');
  });
  it('판정 줄 없는 LLM 응답은 병합(critiquePhaseWithLLM)에서도 pass 로 승격되지 않는다', async () => {
    const r = await critiquePhaseWithLLM(
      { planBody: 'src/a.ts 확장', changedFiles: ['src/a.ts'], diff: '' },
      async () => '판정 줄이 없는 비평 응답입니다.\n- 지적 a',
    );
    expect(r.verdict).not.toBe('pass');
    expect(r.findings.join(' ')).toContain('[LLM]');
  });
});

describe('renderReview', () => {
  it('fail 렌더 — must/should 섹션', () => {
    const md = renderReview({ verdict: 'fail', mustFix: ['미배선'], shouldFix: ['네이밍'] });
    expect(md).toContain('⛔');
    expect(md).toContain('Must-fix');
    expect(md).toContain('미배선');
  });
  it('pass 렌더 — 통과 문구', () => {
    expect(renderReview({ verdict: 'pass', mustFix: [], shouldFix: [] })).toContain('리뷰 통과');
  });
});
