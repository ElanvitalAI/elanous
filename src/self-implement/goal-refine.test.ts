import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { TEST_FAKE_LLM_ENV, TEST_FAKE_LLM_RESPONSE_ENV, testFakeLlmProvider } from '../ux-sim/fake-llm.js';
import {
  EDITABLE_GOAL_LABELS,
  applyRegroundingNote,
  classifyGoalLine,
  fixedGoalLines,
  goalHash,
  parseRegroundingNote,
  refineGoalFromFirstRound,
  renderGoalChangeSection,
  runFirstRoundRefine,
  type RefineCallLLM,
  type RegroundingNote,
} from './goal-refine.js';
import { runSelfImplement } from './orchestrator.js';
import { stableMustFixId } from './reflect-mustfix.js';
import * as revertGuardModule from './revert-guard.js';
import { seams } from './test-seams.js';

// GOAL-REFINE-FROM-FIRST-IMPL — E3 첫 라운드 재그라운딩 → 골 v2 (RFC-progressive-goal-elaboration §7 ②③④).
// LLM 은 fake-llm(src/ux-sim/fake-llm.ts · 실제 LLMProvider 계약)의 고정 응답 = 대본 — 주입 사다리 L2.

const ACCEPT_V1 = '- 완료 경계 코드: 결과가 적절하다.';
const ACCEPT_V2 = '- 완료 경계 코드: sample(2) 이 4 를 돌려주고 sample(-1) 은 RangeError 를 던진다.';
const GOAL = [
  '대상 경로: src/sample.ts',
  '현재 계약: sample 은 아직 없다.',
  '바꿀 것: 샘플 기능을 더한다.',
  ACCEPT_V1,
  '- 완료 경계 실물: 적당한 무대에서 한 번 돈다.',
  '- 완료 경계 증거 명령: bun test src/sample.test.ts',
  '판정 신호: sample 사건이 원장에 남는다.',
  '경계: 위 파일만 · 저작기(goal-author.ts)는 바꾸지 않는다.',
].join('\n');

function note(over: Partial<RegroundingNote> = {}): RegroundingNote {
  return {
    productionPath: ['runSelfImplement → implement seam → src/sample.ts'],
    touchedFiles: ['src/sample.ts', 'src/sample-wire.ts'],
    divergences: ['운영은 sample 을 CLI 가 아니라 seam 으로 부른다'],
    edits: [
      { from: ACCEPT_V1, to: ACCEPT_V2, reason: '리뷰: «적절하다»가 모호해 판정할 수 없다' },
      { from: '대상 경로: src/sample.ts', to: '대상 경로: src/sample.ts · src/sample-wire.ts', reason: '실제 배선 파일이 하나 더 있다' },
    ],
    remaining: ['음수 입력 시험'],
    ...over,
  };
}

describe('줄 분류 — 방향·KPI 는 고정, 예상 구역·수용선·검증 무대만 편집 가능', () => {
  test('저작 문법의 줄 머리로 가른다', () => {
    expect(classifyGoalLine('바꿀 것: x')).toBe('direction');
    expect(classifyGoalLine('현재 계약: x')).toBe('direction');
    expect(classifyGoalLine('- 완료 경계 증거 명령: bun test a.test.ts')).toBe('kpi');
    expect(classifyGoalLine('판정 신호: x')).toBe('kpi');
    expect(classifyGoalLine('KPI: 착지 3건')).toBe('kpi');
    expect(classifyGoalLine('- 완료 경계 코드: x')).toBe('acceptance');
    expect(classifyGoalLine('- 완료 경계 실물: x')).toBe('acceptance');
    expect(classifyGoalLine('대상 경로: a.ts')).toBe('zone');
    expect(classifyGoalLine('신설: a.ts')).toBe('zone');
    expect(classifyGoalLine('검증 무대: L2')).toBe('stage');
    expect(classifyGoalLine('경계: 위 파일만')).toBe('other');
    expect(classifyGoalLine('- Checkable requested criterion: x')).toBe('acceptance');
    expect(classifyGoalLine('- Checkable preservation criterion: x')).toBe('other');
    // 라벨 없는 줄도 KPI 낱말을 품으면 고정(보수 쪽).
    expect(classifyGoalLine('이 런의 KPI 는 착지 수다')).toBe('kpi');
  });

  test('라벨 우선 — 라벨 있는 수용선 줄은 KPI 낱말을 품어도 acceptance (폴백은 라벨 없는 줄만)', () => {
    expect(classifyGoalLine('- 완료 경계 코드: goal-refined 사건이 남고 방향·KPI 줄은 바뀌지 않는다.')).toBe('acceptance');
    expect(classifyGoalLine('- 완료 경계 실물: 판정 신호 사건이 원장에 1건.')).toBe('acceptance');
    expect(classifyGoalLine('수용선: KPI 판정 신호가 남는다')).toBe('acceptance');
    expect(classifyGoalLine('그 판정 신호는 원장에 남는다')).toBe('kpi');
  });

  test('fixedGoalLines = 방향·KPI 줄만 원문 순서대로', () => {
    expect(fixedGoalLines(GOAL)).toEqual([
      '현재 계약: sample 은 아직 없다.',
      '바꿀 것: 샘플 기능을 더한다.',
      '- 완료 경계 증거 명령: bun test src/sample.test.ts',
      '판정 신호: sample 사건이 원장에 남는다.',
    ]);
  });
});

describe('applyRegroundingNote — v1 → v2', () => {
  test('수용선·예상 구역만 바뀌고 방향·KPI 줄은 그대로 · 해시·바뀐 줄·이유', () => {
    const r = applyRegroundingNote(GOAL, note());
    expect(r.outcome).toBe('refined');
    if (r.outcome !== 'refined') throw new Error('unreachable');
    expect(r.v1Hash).toBe(goalHash(GOAL));
    expect(r.v2Hash).toBe(goalHash(r.v2));
    expect(r.v2Hash).not.toBe(r.v1Hash);
    expect(fixedGoalLines(r.v2.split('\n## 재그라운딩 노트')[0]!)).toEqual(fixedGoalLines(GOAL));
    expect(r.v2).toContain(ACCEPT_V2);
    expect(r.v2.split('\n')).not.toContain(ACCEPT_V1);
    expect(r.changedLines).toEqual([
      { index: 3, zone: 'acceptance', before: ACCEPT_V1, after: ACCEPT_V2, reason: '리뷰: «적절하다»가 모호해 판정할 수 없다' },
      { index: 0, zone: 'zone', before: '대상 경로: src/sample.ts', after: '대상 경로: src/sample.ts · src/sample-wire.ts', reason: '실제 배선 파일이 하나 더 있다' },
    ]);
    expect(r.reasons).toHaveLength(2);
    // 노트(생산 경로·운영 차이·남은 일)는 v2 끝에 «참고» 절로 붙는다.
    expect(r.v2).toContain('### 운영이 골 가정과 다른 점');
    expect(r.v2).toContain('- 음수 입력 시험');
  });

  test('⛔ KPI 줄(증거 명령)을 바꾸려 들면 v2 를 버리고 v1 유지 ⊕ 사유', () => {
    const r = applyRegroundingNote(GOAL, note({ edits: [
      { from: ACCEPT_V1, to: ACCEPT_V2, reason: 'ok' },
      { from: '- 완료 경계 증거 명령: bun test src/sample.test.ts', to: '- 완료 경계 증거 명령: bun test src/other.test.ts', reason: '시험 파일이 다르다' },
    ] }));
    expect(r).toMatchObject({ outcome: 'kept', kept: 'fixed-layer-edit', v2Hash: goalHash(GOAL), detail: '시험 파일이 다르다' });
    expect(r.rejectedEdits.at(-1)).toContain('kpi: - 완료 경계 증거 명령');
  });

  test('⛔ 방향 줄(바꿀 것)을 바꾸려 들어도 v1 유지', () => {
    const r = applyRegroundingNote(GOAL, note({ edits: [{ from: '바꿀 것: 샘플 기능을 더한다.', to: '바꿀 것: 다른 기능.', reason: 'x' }] }));
    expect(r).toMatchObject({ outcome: 'kept', kept: 'fixed-layer-edit' });
  });

  test('칸 밖·없는 줄·라벨 바꾸기는 그 편집만 버린다 — 남는 편집이 없으면 v1 유지', () => {
    const r = applyRegroundingNote(GOAL, note({ edits: [
      { from: '경계: 위 파일만 · 저작기(goal-author.ts)는 바꾸지 않는다.', to: '경계: 아무거나.', reason: 'x' },
      { from: '없는 줄', to: '대상 경로: x', reason: 'x' },
      { from: ACCEPT_V1, to: '판정 신호: 바꿔치기', reason: 'x' },
    ] }));
    expect(r).toMatchObject({ outcome: 'kept', kept: 'no-applicable-edits' });
    expect(r.rejectedEdits.map((e) => e.split(':')[0])).toEqual(['out-of-zone(other)', 'not-in-goal', 'label-changed']);
  });

  test('빈 노트 → v1 유지(empty-note)', () => {
    expect(applyRegroundingNote(GOAL, { productionPath: [], touchedFiles: [], divergences: [], edits: [], remaining: [] }))
      .toMatchObject({ outcome: 'kept', kept: 'empty-note' });
  });
});

describe('refineGoalFromFirstRound — 실패는 v1 유지 ⊕ 사유(보수 쪽)', () => {
  const ev = { implSummary: 'impl', findings: '- 수용선 «적절하다»가 모호하다', changedFiles: ['src/sample.ts'] };
  test('공급자 없음·실패·판독 실패·상한 초과', async () => {
    expect(await refineGoalFromFirstRound({ v1: GOAL, evidence: ev, visit: 1 }, {})).toMatchObject({ outcome: 'kept', kept: 'no-provider' });
    expect(await refineGoalFromFirstRound({ v1: GOAL, evidence: ev, visit: 1 }, { callLLM: async () => { throw new Error('boom'); } }))
      .toMatchObject({ outcome: 'kept', kept: 'provider-failed', detail: 'boom' });
    expect(await refineGoalFromFirstRound({ v1: GOAL, evidence: ev, visit: 1 }, { callLLM: async () => 'no json here' }))
      .toMatchObject({ outcome: 'kept', kept: 'note-unparseable' });
    let called = false;
    expect(await refineGoalFromFirstRound({ v1: GOAL, evidence: ev, visit: 2 }, { callLLM: async () => { called = true; return '{}'; } }))
      .toMatchObject({ outcome: 'kept', kept: 'max-visits' });
    expect(called).toBe(false);
  });

  test('프롬프트에 고정 층·첫 라운드 지적·건드린 파일이 실린다', async () => {
    const prompts: string[] = [];
    const callLLM: RefineCallLLM = async ({ prompt }) => { prompts.push(prompt); return `\`\`\`json\n${JSON.stringify(note())}\n\`\`\``; };
    const r = await refineGoalFromFirstRound({ v1: GOAL, evidence: ev, visit: 1 }, { callLLM });
    expect(r.outcome).toBe('refined');
    expect(prompts[0]).toContain('- 판정 신호: sample 사건이 원장에 남는다.');
    expect(prompts[0]).toContain('수용선 «적절하다»가 모호하다');
    expect(prompts[0]).toContain('건드린 파일: src/sample.ts');
    // 프롬프트의 «고쳐도 되는 칸»은 분류기와 같은 상수에서 나온다 — 칸 이름이 빠짐없이 실리고, 분류기도 그 칸으로 본다.
    for (const [zone, labels] of Object.entries(EDITABLE_GOAL_LABELS)) {
      for (const label of labels) {
        expect(prompts[0]).toContain(`\`${label}:\``);
        expect(classifyGoalLine(`- ${label}: x`)).toBe(zone as never);
      }
    }
  });

  test('parseRegroundingNote 는 펜스·앞뒤 산문을 견디고 형식 밖 편집을 거른다', () => {
    const parsed = parseRegroundingNote(`앞말\n\`\`\`json\n${JSON.stringify({ edits: [{ from: 'a', to: 'b' }, { from: 1 }], remaining: ['r', 2] })}\n\`\`\``);
    expect(parsed).toEqual({ ok: true, note: { productionPath: [], touchedFiles: [], divergences: [], edits: [{ from: 'a', to: 'b', reason: '(이유 없음)' }], remaining: ['r'] } });
  });
});

describe('runFirstRoundRefine — goal-refined 사건 ⊕ PR «골 변경» 절', () => {
  test('refined: 사건에 v1·v2 해시·바뀐 줄·이유 · 범주 self-implement.goal-refine', async () => {
    const events: Array<{ event: string; data: Record<string, unknown>; opt?: Record<string, unknown> }> = [];
    const out = await runFirstRoundRefine({ goal: GOAL, round: 1, visit: 1, evidence: {}, callLLM: async () => JSON.stringify(note()),
      observe: (event, data, opt) => { events.push({ event, data, ...(opt ? { opt } : {}) }); } });
    expect(out.goal).toContain(ACCEPT_V2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'goal-refined', opt: { category: 'self-implement.goal-refine' },
      data: { outcome: 'refined', round: 1, v1Hash: goalHash(GOAL), v2Hash: goalHash(out.goal), reasons: ['리뷰: «적절하다»가 모호해 판정할 수 없다', '실제 배선 파일이 하나 더 있다'] } });
    expect((events[0]!.data.changedLines as unknown[]).length).toBe(2);
    const section = renderGoalChangeSection(out.refinement);
    expect(section.split('\n')[0]).toBe('## 골 변경');
    expect(section).toContain(`\`${ACCEPT_V1}\``);
    expect(section).toContain(`→ \`${ACCEPT_V2}\``);
  });

  test('seam 부재(no-provider)도 warn 으로 남는다 — 조용히 꺼지지 않는다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown>; opt?: Record<string, unknown> }> = [];
    await runFirstRoundRefine({ goal: GOAL, round: 1, visit: 1, evidence: {}, observe: (event, data, opt) => { events.push({ event, data, ...(opt ? { opt } : {}) }); } });
    expect(events).toEqual([expect.objectContaining({ event: 'goal-refined', opt: { category: 'self-implement.goal-refine', level: 'warn' }, data: expect.objectContaining({ outcome: 'kept', kept: 'no-provider' }) })]);
  });

  test('kept: 같은 사건에 kept 사유 · 경고 수준 · 골은 v1 그대로', async () => {
    const events: Array<{ event: string; data: Record<string, unknown>; opt?: Record<string, unknown> }> = [];
    const out = await runFirstRoundRefine({ goal: GOAL, round: 1, visit: 1, evidence: {}, callLLM: async () => { throw new Error('down'); },
      observe: (event, data, opt) => { events.push({ event, data, ...(opt ? { opt } : {}) }); } });
    expect(out.goal).toBe(GOAL);
    expect(events[0]).toMatchObject({ event: 'goal-refined', opt: { level: 'warn' }, data: { outcome: 'kept', kept: 'provider-failed', v1Hash: goalHash(GOAL), v2Hash: goalHash(GOAL), changedLines: [] } });
    expect(renderGoalChangeSection(out.refinement)).toContain('- 시도 · v1 유지 · 사유 provider-failed (down)');
  });
});

describe('fixture 런 — 첫 라운드 리뷰가 수용선 모호를 지적 → 둘째 라운드 프롬프트가 골 v2', () => {
  const saved = { on: process.env[TEST_FAKE_LLM_ENV], res: process.env[TEST_FAKE_LLM_RESPONSE_ENV] };
  afterEach(() => {
    if (saved.on === undefined) delete process.env[TEST_FAKE_LLM_ENV]; else process.env[TEST_FAKE_LLM_ENV] = saved.on;
    if (saved.res === undefined) delete process.env[TEST_FAKE_LLM_RESPONSE_ENV]; else process.env[TEST_FAKE_LLM_RESPONSE_ENV] = saved.res;
  });

  test('runSelfImplement: goal-refined 원장 원문 ⊕ round1 프롬프트에 v2 · round0 엔 v1', async () => {
    process.env[TEST_FAKE_LLM_ENV] = '1';
    process.env[TEST_FAKE_LLM_RESPONSE_ENV] = JSON.stringify(note({ edits: [note().edits[0]!] }));
    /** fake-llm(실제 LLMProvider 계약)으로 재그라운딩 노트만 답한다 — E1 카드 요청은 대본 밖이라 실패(E1 skipped). */
    const prompts: string[] = [];
    const callLLM: RefineCallLLM = async ({ prompt }) => {
      prompts.push(prompt);
      if (!prompt.includes('재그라운딩 노트(E3')) throw new Error('not scripted');
      let text = '';
      for await (const chunk of testFakeLlmProvider.chat([{ role: 'user', content: prompt }])) text += chunk;
      return text;
    };
    const features: string[] = [];
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const reviewGoals: string[] = [];
    let reviews = 0;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = await runSelfImplement({
        runId: 'goal-refine-fixture', feature: GOAL, completion: 'worktree-only', memory: false, maxReworkRounds: 1,
        seams: seams({
          features,
          elaborateCallLLM: callLLM,
          writeRunLedger: ((entry: { event: string; data: Record<string, unknown> }) => { ledger.push(entry); }) as never,
          reviewDiff: async (_cwd, context) => (reviewGoals.push(String((context as { goal?: unknown }).goal)), ++reviews === 1
            ? { verdict: 'fail', mustFix: ['수용선 «결과가 적절하다»가 모호하다 — 무엇이 적절한지 판정할 수 없다'], shouldFix: [], summary: 'ambiguous', reviewed: true, diffTruncated: false }
            : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true, diffTruncated: false }),
        }),
      });
      expect(result.ok).toBe(true);
      expect(features).toHaveLength(2);
      // round0 = v1 · round1 = v2(수용선 문구만 바뀜 · 방향·KPI 줄 그대로)
      expect(features[0]).toContain(ACCEPT_V1);
      expect(features[1]).toContain(ACCEPT_V2);
      expect(features[1]!.split('\n')).not.toContain(ACCEPT_V1);
      for (const line of fixedGoalLines(GOAL)) expect(features[1]).toContain(line);
      expect(features[1]).toContain('## 재그라운딩 노트');
      // 리뷰 r1 must-fix — refine 뒤 라운드의 리뷰 intent 는 «현재 골»(v2)로 판정한다.
      expect(reviewGoals).toHaveLength(2);
      expect(reviewGoals[0]).toContain(ACCEPT_V1);
      expect(reviewGoals[1]).toContain(ACCEPT_V2);
      expect(reviewGoals[1]!.split('\n')).not.toContain(ACCEPT_V1);
      // 노트 프롬프트는 첫 라운드 리뷰 지적을 실었다.
      expect(prompts.find((p) => p.includes('재그라운딩 노트(E3'))).toContain('수용선 «결과가 적절하다»가 모호하다');
      const refined = ledger.filter((entry) => entry.event === 'goal-refined');
      expect(refined).toHaveLength(1);
      expect(refined[0]!.data).toMatchObject({ outcome: 'refined', round: 1, v1Hash: goalHash(GOAL),
        changedLines: [{ zone: 'acceptance', before: ACCEPT_V1, after: ACCEPT_V2 }], reasons: ['리뷰: «적절하다»가 모호해 판정할 수 없다'] });
      expect(refined[0]!.data.v2Hash).not.toBe(goalHash(GOAL));
      expect(log.mock.calls.some(([category, event]) => category === 'self-implement.goal-refine' && event === 'goal-refined')).toBe(true);
      // 원문 — PR 본문에 옮겨 적을 증거(시험 출력으로 남긴다).
      console.log(`[fixture goal-refined] ${JSON.stringify(refined[0])}`);
    } finally {
      log.mockRestore();
    }
  });
});

describe('fixture 런 — refine 뒤 REFUTE 는 v2 수용선 인용을 무효로 보지 않는다', () => {
  test('round1 자식이 v2 `Checkable requested criterion` 줄을 인용 → refute-submitted (refute-rejected 없음)', async () => {
    const REQ_V1 = '- Checkable requested criterion: 결과가 적절하다.';
    const REQ_V2 = '- Checkable requested criterion: sample(2) 이 4 를 돌려준다.';
    const goal = ['대상 경로: src/sample.ts', '바꿀 것: 샘플 기능을 더한다.', REQ_V1, '- 완료 경계 증거 명령: bun test src/sample.test.ts'].join('\n');
    const mustFix = '수용선 «결과가 적절하다»가 모호하다';
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    let impls = 0;
    let reviews = 0;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await runSelfImplement({
        runId: 'goal-refine-refute-fixture', feature: goal, completion: 'worktree-only', memory: false, maxReworkRounds: 2,
        seams: seams({
          elaborateCallLLM: async ({ prompt }) => {
            if (!prompt.includes('재그라운딩 노트(E3')) throw new Error('not scripted');
            return JSON.stringify({ edits: [{ from: REQ_V1, to: REQ_V2, reason: '모호' }] });
          },
          writeRunLedger: ((entry: { event: string; data: Record<string, unknown> }) => { ledger.push(entry); }) as never,
          implement: async () => (++impls === 2
            ? { ok: true, summary: `REFUTE [${stableMustFixId(mustFix)}] ${JSON.stringify(REQ_V2)} — v2 수용선이 이미 이 지적을 해소한다` }
            : { ok: true, summary: 'impl' }),
          reviewDiff: async () => (++reviews <= 2
            ? { verdict: 'fail', mustFix: [mustFix], shouldFix: [], summary: 'ambiguous', reviewed: true, diffTruncated: false }
            : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true, diffTruncated: false }),
        }),
      });
      expect(ledger.find((entry) => entry.event === 'goal-refined')?.data).toMatchObject({ outcome: 'refined', round: 1 });
      expect(ledger.filter((entry) => entry.event === 'refute-rejected')).toEqual([]);
      expect(ledger.find((entry) => entry.event === 'refute-submitted')?.data).toMatchObject({ round: 1, submittedCount: 1,
        refutations: [expect.objectContaining({ quote: REQ_V2 })] });
    } finally {
      log.mockRestore();
    }
  });
});

describe('fixture 런 — v2 «대상 경로»는 되돌림 방지가 소비한다', () => {
  test('main-sync 의 revert guard 대상에 v2 로 더한 경로가 들어간다', async () => {
    const goal = ['대상 경로: src/sample.ts', '바꿀 것: 샘플 기능을 더한다.', ACCEPT_V1, '- 완료 경계 증거 명령: bun test src/sample.test.ts'].join('\n');
    const targets: string[][] = [];
    const guard = spyOn(revertGuardModule, 'dropStaleReverts').mockImplementation((_cwd, t) => { targets.push([...t]); return { reverted: [], protected: [] }; });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let reviews = 0;
    try {
      await runSelfImplement({
        runId: 'goal-refine-revert-guard-fixture', feature: goal, memory: false, maxReworkRounds: 1,
        seams: seams({
          commitWork: () => {},
          elaborateCallLLM: async ({ prompt }) => {
            if (!prompt.includes('재그라운딩 노트(E3')) throw new Error('not scripted');
            return JSON.stringify({ edits: [{ from: '대상 경로: src/sample.ts', to: '대상 경로: src/sample.ts · src/sample-wire.ts', reason: '배선 파일' }] });
          },
          reviewDiff: async () => (++reviews === 1
            ? { verdict: 'fail', mustFix: ['배선 파일이 대상 경로에 없다'], shouldFix: [], summary: 'x', reviewed: true, diffTruncated: false }
            : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true, diffTruncated: false }),
        }),
      });
      expect(targets.length).toBeGreaterThan(0);
      expect(targets.at(-1)).toContain('src/sample-wire.ts');
    } finally {
      guard.mockRestore();
      log.mockRestore();
    }
  });
});
