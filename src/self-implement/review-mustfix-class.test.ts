import { test, expect, describe } from 'bun:test';
import { classifyMustFixRound, inferMustFixEvidence } from './review-mustfix-class.js';

describe('REVIEW-MUSTFIX-CLASSIFY — must-fix 를 «수의 추이»가 아니라 «회차 짝»으로 가른다', () => {
  test('① new-defect — 앞 회차에 없던 새 지적은 그대로 수렴 간다', () => {
    const c = classifyMustFixRound(
      { items: [{ text: 'Add A.' }] },
      { items: [{ text: 'Fix B.' }] },
    );
    expect(c.class).toBe('new-defect');
    expect(c.split).toBeUndefined();
    expect(c.crossReview).toBeUndefined();
  });

  test('① 첫 관측(prev 없음)도 새 지적이다 — 짝이 없으면 «두 번»을 기다리지 않는다', () => {
    expect(classifyMustFixRound(undefined, { items: [{ text: 'First.' }] }).class).toBe('new-defect');
    // 앞 회차가 0건(관측했지만 must-fix 없음)이어도 이번 지적은 새 지적이다.
    expect(classifyMustFixRound({ items: [] }, { items: [{ text: 'New.' }] }).class).toBe('new-defect');
  });

  test('② post-land-evidence — 착지 뒤에만 낼 수 있는 증거면 같은 런 재수리 0 · 쪼개기 결정 1', () => {
    const c = classifyMustFixRound(
      { items: [{ text: 'Add A.' }] },
      { items: [
        { text: '운영 소비를 보여라.', evidence: 'ops-consumption' },
        { text: '실물이 착지했는지 보여라.', evidence: 'artifact-landing' },
        { text: 'live 호출자를 대라.', evidence: 'live-caller' },
      ] },
    );
    expect(c.class).toBe('post-land-evidence');
    expect(c.evidence).toEqual(['ops-consumption', 'artifact-landing', 'live-caller']);
    expect(c.split).toBe('shadow-land → observe → live');
    expect(c.crossReview).toBeUndefined();
  });

  test('② 는 모든 지적이 착지 뒤 증거일 때만 — 실결함이 섞이면 ① 로 같은 런 수리를 유지한다', () => {
    const c = classifyMustFixRound(undefined, { items: [
      { text: 'live 호출자를 대라.', evidence: 'live-caller' },
      { text: 'Fix the null check.' },
    ] });
    expect(c.class).toBe('new-defect');
  });

  test('③ recurring — 수리 뒤 같은 지적이 다시 나오면 교차 리뷰 제안 ⊕ intent 경계 명시', () => {
    const c = classifyMustFixRound(
      { items: [{ text: '  Fix   THE Gate. ', taskId: 't' }, { text: 'other', taskId: 't' }] },
      { items: [{ text: 'fix the gate.', taskId: 't' }] },
    );
    expect(c.class).toBe('recurring');
    expect(c.crossReview).toBe(true);
    expect(c.recurring).toEqual(['fix the gate.']);
    expect(c.reason).toContain('intent');
    expect(c.reason).toContain('교차 리뷰');
    expect(c.split).toBeUndefined();
  });

  test('③ recurring 가 ② 보다 먼저다 — 같은 지적이 반복됐으면 증거 요구와 섞여도 같은 전략 재수리는 금지', () => {
    const c = classifyMustFixRound(
      { items: [{ text: 'live 호출자를 대라.', taskId: 't' }] },
      { items: [{ text: 'live 호출자를 대라.', evidence: 'live-caller', taskId: 't' }] },
    );
    expect(c.class).toBe('recurring');
    expect(c.crossReview).toBe(true);
  });

  test('③ 출처 불명은 짝이 아니다 — 한쪽이라도 taskId 가 없으면 같은 문면이어도 ①', () => {
    expect(classifyMustFixRound({ items: [{ text: 'fix gate' }] }, { items: [{ text: 'fix gate', taskId: 'b' }] }).class).toBe('new-defect');
    expect(classifyMustFixRound({ items: [{ text: 'fix gate', taskId: 'a' }] }, { items: [{ text: 'fix gate' }] }).class).toBe('new-defect');
    expect(classifyMustFixRound({ items: [{ text: 'fix gate' }] }, { items: [{ text: 'fix gate' }] }).class).toBe('new-defect');
  });

  test('③ 짝은 조각을 넘지 않는다 — 다른 조각의 같은 문면은 첫 지적(①)이다', () => {
    expect(classifyMustFixRound(
      { items: [{ text: 'fix gate', taskId: 'a' }] },
      { items: [{ text: 'fix gate', taskId: 'b' }] },
    ).class).toBe('new-defect');
    expect(classifyMustFixRound(
      { items: [{ text: 'fix gate', taskId: 'a' }] },
      { items: [{ text: 'fix gate', taskId: 'a' }] },
    ).class).toBe('recurring');
  });

  test('unmeasured — 이 회차 must-fix 를 안 쟀으면 분류 불가(지금 동작 그대로)', () => {
    expect(classifyMustFixRound({ items: [{ text: 'a' }] }, {}).class).toBe('unmeasured');
    expect(classifyMustFixRound({ items: [{ text: 'a' }] }, { items: [] }).class).toBe('unmeasured');
    expect(classifyMustFixRound(undefined, {}).class).toBe('unmeasured');
  });

  test('⛔ 임의 임계 금지 — 짝은 «정규화 문면이 같다»는 사실 하나로 맞는다(«두 번» 같은 수를 세지 않는다)', () => {
    // 앞 회차 지적 2건 중 1건이 다시 나왔다 — «두 번째 반복»이 아니라 «짝이 한 번 맞았다»로 판정한다.
    const c = classifyMustFixRound(
      { items: [{ text: 'one', taskId: 't' }, { text: 'two', taskId: 't' }] },
      { items: [{ text: 'two', taskId: 't' }, { text: 'three', taskId: 't' }] },
    );
    expect(c.class).toBe('recurring');
    expect(c.recurring).toEqual(['two']);
  });

  test('inferMustFixEvidence — 문장 전체가 허용 꼴일 때만 ② · 그 밖은 전부 ①(의심스러우면 ① = 안전한 기본)', () => {
    // 순수 증거 요구 꼴만 ②.
    expect(inferMustFixEvidence('live 호출자를 못 봤다')).toBe('live-caller');
    expect(inferMustFixEvidence('live 호출자 증거를 보여라.')).toBe('live-caller');
    expect(inferMustFixEvidence('운영 소비 증거가 없다')).toBe('ops-consumption');
    expect(inferMustFixEvidence('실물 착지를 보여라')).toBe('artifact-landing');
    expect(inferMustFixEvidence('Show the live caller evidence.')).toBe('live-caller');
    // 마침표 · 쉼표 · «그리고» · 결함 낱말 혼합 꼴은 모두 ①.
    expect(inferMustFixEvidence('live 호출자 증거를 보여라. 권한 검사가 빠졌다')).toBeUndefined();
    expect(inferMustFixEvidence('live 호출자 증거를 보여라, 권한 검사가 빠졌다')).toBeUndefined();
    expect(inferMustFixEvidence('live 호출자 증거를 보여라 그리고 권한 검사를 넣어라')).toBeUndefined();
    expect(inferMustFixEvidence('live 호출자에서 null 참조 오류를 고쳐라')).toBeUndefined();
    expect(inferMustFixEvidence('live 호출자를 못 봤다 — 권한 검사도 빠졌다')).toBeUndefined();
    // 구현 부재(«없다» · 추가하라) · 다른 동사도 ①.
    expect(inferMustFixEvidence('live 호출자가 없다')).toBeUndefined();
    expect(inferMustFixEvidence('live 호출자가 없다. 호출 경로를 추가하라')).toBeUndefined();
    expect(inferMustFixEvidence('live 호출자 경로를 정리하라')).toBeUndefined();
    expect(inferMustFixEvidence('Fix the gate.')).toBeUndefined();
  });
});
