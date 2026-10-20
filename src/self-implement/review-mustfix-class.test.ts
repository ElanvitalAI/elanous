import { test, expect, describe } from 'bun:test';
import { classifyMustFixRound, inferMustFixEvidence, judgeMustFixScope, mustFixTokenJaccard, proposeMustFixSplit } from './review-mustfix-class.js';

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

describe('REVIEW-MUSTFIX-CLASSIFY 범위 축 — must-fix 한 줄마다 (가) in-scope / (나) split / (다) ask-owner', () => {
  // 10-17 사례 재구성(짧게) — PR 변경 파일 ⊕ 앞 라운드 지적.
  const pr28827 = {
    prNumber: 28827,
    changedFiles: ['src/harness/fake-llm.ts', 'src/harness/fake-llm.test.ts', 'src/harness/detach.ts'],
    reviewRound: 4,
    prevItems: [{ text: 'fake LLM env 계약이 src/harness/fake-llm.ts 에서 깨진다' }],
  } as const;

  test('#28827 «child runId attestation» = split — 앞 라운드에 없던 축(r≥3) · 런타임 증거 요구', () => {
    const j = judgeMustFixScope({ text: 'Child runId attestation is missing for spawned workers' }, pr28827);
    expect(j.scope).toBe('split');
    expect(j.signals).toContain('new-axis');
  });

  test('«fake LLM env 계약 깨짐» = in-scope — PR 안 파일 언급 ⊕ 앞 라운드와 같은 축', () => {
    const j = judgeMustFixScope({ text: 'fake LLM env 계약이 src/harness/fake-llm.ts 에서 여전히 깨진다' }, pr28827);
    expect(j.scope).toBe('in-scope');
    expect(j.signals).toEqual(['path-inside']);
  });

  test('#28819 «Windows 정상 종료 실패 처리» = in-scope — PR 안 파일(파일 이름만 언급해도)', () => {
    const j = judgeMustFixScope({ text: 'detach.ts: Windows 정상 종료를 실패로 처리한다' }, {
      prNumber: 28819, changedFiles: ['src/harness/detach.ts'], reviewRound: 2,
      prevItems: [{ text: 'detach 신호 순서' }],
    });
    expect(j.scope).toBe('in-scope');
  });

  test('«detached descendant 검출» = split — PR 밖 파일 · 다른 PR 언급', () => {
    const j = judgeMustFixScope({ text: 'detached descendant 검출이 없다 — src/pty/process-tree.ts 와 #28751 이 먼저' }, {
      prNumber: 28819, changedFiles: ['src/harness/detach.ts'], reviewRound: 2,
    });
    expect(j.scope).toBe('split');
    expect(j.signals).toEqual(expect.arrayContaining(['path-outside', 'other-pr']));
    expect(j.outsidePaths).toEqual(['src/pty/process-tree.ts']);
  });

  test('설계 문서·다른 자리 결정 언급은 split', () => {
    const input = { changedFiles: ['src/a.ts'] };
    expect(judgeMustFixScope({ text: 'RFC-loop-registry 의 계약을 먼저 고쳐야 한다' }, input).signals).toContain('design-doc');
    expect(judgeMustFixScope({ text: '다른 자리 결정이 필요하다' }, input).scope).toBe('split');
    expect(judgeMustFixScope({ text: `${String.fromCodePoint(0x1f451)} 결정이 필요하다` }, input).scope).toBe('split');
  });

  test('반증 — 변경 파일을 안 쟀으면 대상 경로 밖 경로를 split 으로 단정하지 않는다(ask-owner)', () => {
    const j = judgeMustFixScope({ text: 'src/b.ts 의 null 검사' }, { targetPaths: ['src/a.ts'] });
    expect(j.scope).toBe('ask-owner');
    expect(j.signals).toContain('path-unmeasured');
    expect(j.signals).not.toContain('path-outside');
    // 변경 파일을 쟀으면 그때는 밖이다.
    expect(judgeMustFixScope({ text: 'src/b.ts 의 null 검사' }, { targetPaths: ['src/a.ts'], changedFiles: ['src/a.ts'] }).scope).toBe('split');
  });

  test('반증 — 이 PR 번호를 모르면 #번호 언급을 other-pr 로 단정하지 않는다(ask-owner)', () => {
    const j = judgeMustFixScope({ text: '#28819 의 src/a.ts null 검사' }, { changedFiles: ['src/a.ts'] });
    expect(j.scope).toBe('ask-owner');
    expect(j.signals).toContain('pr-unknown');
    expect(j.signals).not.toContain('other-pr');
  });

  test('자기 PR 번호 언급은 다른 PR 이 아니다', () => {
    const j = judgeMustFixScope({ text: '#28819 의 src/a.ts null 검사' }, { prNumber: 28819, changedFiles: ['src/a.ts'] });
    expect(j.scope).toBe('in-scope');
  });

  test('반증 — 신호가 하나도 없으면 ask-owner(«없다»를 범위 안으로 읽지 않는다)', () => {
    const j = judgeMustFixScope({ text: 'Handle the error better' }, { changedFiles: ['src/a.ts'], reviewRound: 2 });
    expect(j.scope).toBe('ask-owner');
    expect(j.signals).toEqual(['no-signal']);
  });

  test('반증 — recurring 은 split(PR 안 파일이어도)', () => {
    const text = 'src/a.ts 의 게이트를 고쳐라';
    const j = judgeMustFixScope({ text }, { changedFiles: ['src/a.ts'], recurring: [text.toLowerCase()] });
    expect(j.scope).toBe('split');
    expect(j.signals).toContain('recurring');
  });

  test('반증 — 범위 입력이 없으면 ask-owner(쪼갤 신호가 있어도 PR 이 이미 맡았는지 못 가린다)', () => {
    expect(judgeMustFixScope({ text: 'Handle the error better' }, {}).scope).toBe('ask-owner');
    const j = judgeMustFixScope({ text: 'src/x.ts 는 #28751 이 먼저' }, {});
    expect(j.scope).toBe('ask-owner');
    expect(j.signals).toContain('no-scope-input');
  });

  test('② 착지 뒤 증거 줄은 PR 안 파일을 언급해도 split — 회차 분류 ② 와 같은 갈래', () => {
    const j = judgeMustFixScope({ text: 'src/a.ts live 호출자를 대라', evidence: 'live-caller' }, { changedFiles: ['src/a.ts'] });
    expect(j.scope).toBe('split');
    expect(j.signals).toEqual(expect.arrayContaining(['path-inside', 'post-land-evidence']));
    expect(judgeMustFixScope({ text: 'live 호출자를 대라', evidence: 'live-caller' }, {}).scope).toBe('split');
  });

  test('신호가 엇갈리면 ask-owner — PR 안 파일 ⊕ 다른 PR', () => {
    const j = judgeMustFixScope({ text: 'src/a.ts 는 #28751 과 겹친다' }, { prNumber: 1, changedFiles: ['src/a.ts'] });
    expect(j.scope).toBe('ask-owner');
  });

  test('new-axis 는 r≥3 ⊕ 앞 라운드 관측이 있을 때만 — 안 쟀으면 신호를 안 낸다', () => {
    const text = 'Child runId attestation';
    expect(judgeMustFixScope({ text }, { changedFiles: [], reviewRound: 2, prevItems: [{ text: 'x y' }] }).signals).not.toContain('new-axis');
    expect(judgeMustFixScope({ text }, { changedFiles: [], reviewRound: 3 }).signals).not.toContain('new-axis');
    expect(judgeMustFixScope({ text }, { changedFiles: [], reviewRound: 3, prevItems: [{ text: 'other words' }] }).signals).toContain('new-axis');
    expect(mustFixTokenJaccard('child runId', 'child runId')).toBe(1);
  });

  test('split 제안 — 경로를 언급하지 않은 지적은 대상 경로 미상(원래 골 경로를 끌어오지 않는다)', () => {
    const j = judgeMustFixScope({ text: '#28751 이 먼저다' }, { prNumber: 1, changedFiles: ['src/a.ts'], targetPaths: ['src/a.ts'] });
    expect(j.scope).toBe('split');
    const p = proposeMustFixSplit(j);
    expect(p.linkGoal.targetPaths).toEqual([]);
    expect(p.linkGoal.verdictLine).toContain('미상');
  });

  test('split 제안 — ② 착지 뒤 증거는 시험 0 fail 이 아니라 착지 뒤 관측 판정선', () => {
    const j = judgeMustFixScope({ text: 'src/a.ts live 호출자를 대라', evidence: 'live-caller' }, { changedFiles: ['src/a.ts'] });
    const p = proposeMustFixSplit(j);
    expect(p.linkGoal.verdictLine).toContain('착지 뒤 관측');
    expect(p.linkGoal.verdictLine).toContain('live 호출자');
    expect(p.linkGoal.verdictLine).not.toContain('bun test');
  });

  test('split 제안 — intent 스코프 경계 문장(이유) ⊕ 연결 골(대상 경로 ⊕ 판정선 한 줄)', () => {
    const j = judgeMustFixScope({ text: 'src/pty/process-tree.ts 에 detached descendant 검출' }, { changedFiles: ['src/harness/detach.ts'] });
    const p = proposeMustFixSplit(j);
    expect(p.intentScopeBoundary).toContain('미완이 아니라 이 PR 의 결정');
    expect(p.intentScopeBoundary).toContain('must-fix 를 만들지 말 것');
    expect(p.linkGoal.targetPaths).toEqual(['src/pty/process-tree.ts']);
    expect(p.linkGoal.verdictLine).toBe('판정: bun test src/pty/process-tree.test.ts → «src/pty/process-tree.ts 에 detached descendant 검출» 고정 시험 ⊕ 0 fail');
  });
});
