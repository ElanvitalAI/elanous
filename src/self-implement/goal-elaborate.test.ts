import { describe, expect, test } from 'bun:test';
import {
  bunTestPathArgs,
  checkCardAgainstFixedLayer,
  elaborateGoalOnArrival,
  extractGoalFixedLayer,
  parseElaborationCard,
  renderElaborationCard,
  runArrivalElaboration,
  type ElaborationCallLLM,
} from './goal-elaborate.js';

// GOAL-ELABORATE-ON-ARRIVAL — E1 착수 구체화 (RFC-progressive-goal-elaboration §2 E1 · §7 간선 ①).
// LLM 은 대본(fake) 응답으로 갈음한다 — 주입 사다리 L2(실제 모듈 · 가짜 공급자).

const GOAL = [
  '대상 경로: src/self-implement/orchestrator.ts · src/self-implement/goal-elaborate.ts',
  '신설: src/self-implement/goal-elaborate.ts',
  '바꿀 것: 구현 첫 단계 전에 착수 구체화 카드를 붙인다.',
  '- 완료 경계 증거 명령: bun test src/self-implement/goal-elaborate.test.ts',
  '판정 신호: goal-elaborated 사건이 원장에 남는다.',
  '경계: 위 세 파일 · 골 KPI·판정 신호 불변 · 저작기(goal-author.ts)는 바꾸지 않는다.',
].join('\n');

const EXISTING = new Set(['src/self-implement/orchestrator.ts', 'src/self-implement/goal-elaborate.test.ts']);
const exists = (path: string) => EXISTING.has(path);

function card(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    files: ['src/self-implement/orchestrator.ts', 'src/self-implement/goal-elaborate.ts'],
    newFiles: ['src/self-implement/goal-elaborate.ts'],
    requirements: ['orchestrator 의 round0 프롬프트에 카드 블록을 붙인다'],
    firstTest: { path: 'src/self-implement/goal-elaborate.test.ts', name: 'card is appended', redReason: 'goal-elaborate.ts 가 아직 없다' },
    stage: 'unit',
    level: 'L2',
    ...over,
  });
}

/** 대본 LLM — 부른 순서대로 응답을 내고, 받은 프롬프트를 남긴다. */
function scripted(responses: string[]): ElaborationCallLLM & { prompts: string[] } {
  const prompts: string[] = [];
  const fn = (async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    const next = responses.shift();
    if (next === undefined) throw new Error('script exhausted');
    return next;
  }) as ElaborationCallLLM & { prompts: string[] };
  fn.prompts = prompts;
  return fn;
}

const CONSISTENT = JSON.stringify({ consistent: true, violations: [] });

describe('extractGoalFixedLayer', () => {
  test('KPI·불변식·보호 경로를 골 원문에서 그대로 뽑는다', () => {
    const fixed = extractGoalFixedLayer(GOAL);
    expect(fixed.kpi.some((line) => line.includes('판정 신호'))).toBe(true);
    expect(fixed.kpi.some((line) => line.includes('증거 명령'))).toBe(true);
    expect(fixed.invariants.some((line) => line.startsWith('경계:'))).toBe(true);
    expect(fixed.protectedPaths).toEqual(['goal-author.ts']);
    expect(fixed.direction.some((line) => line.startsWith('바꿀 것:'))).toBe(true);
  });
});

describe('parseElaborationCard', () => {
  test('펜스 안 JSON 을 읽고 필수 칸이 빠지면 거부한다', () => {
    const ok = parseElaborationCard('```json\n' + card() + '\n```');
    expect(ok.ok).toBe(true);
    const bad = parseElaborationCard(card({ level: 'L9' }));
    expect(bad.ok).toBe(false);
    expect(parseElaborationCard('not json').ok).toBe(false);
  });
});

describe('checkCardAgainstFixedLayer', () => {
  test('보호 경로를 건드리는 카드와 저장소에 없는 경로는 위반이다', () => {
    const fixed = extractGoalFixedLayer(GOAL);
    const parsed = parseElaborationCard(card({ files: ['src/self-implement/goal-author.ts', 'src/nowhere.ts'] }));
    if (!parsed.ok) throw new Error(parsed.error);
    const violations = checkCardAgainstFixedLayer(parsed.card, fixed, exists);
    expect(violations.some((v) => v.includes('protected') && v.includes('goal-author.ts'))).toBe(true);
    expect(violations.some((v) => v.includes('ungrounded') && v.includes('src/nowhere.ts'))).toBe(true);
  });
});

describe('checkCardAgainstFixedLayer — newFiles', () => {
  test('newFiles 에만 실은 보호 경로도 위반이다(결정론 검사 우회 차단)', () => {
    const fixed = extractGoalFixedLayer(GOAL);
    const parsed = parseElaborationCard(card({ files: ['src/self-implement/orchestrator.ts'], newFiles: ['src/self-implement/goal-author.ts'] }));
    if (!parsed.ok) throw new Error(parsed.error);
    const violations = checkCardAgainstFixedLayer(parsed.card, fixed, exists);
    expect(violations.some((v) => v.includes('protected') && v.includes('goal-author.ts'))).toBe(true);
  });
});

describe('elaborateGoalOnArrival', () => {
  test('KPI 안 카드 → 한 번에 elaborated · 카드 해시·파일 수·층', async () => {
    const llm = scripted([card(), CONSISTENT]);
    const result = await elaborateGoalOnArrival({ goal: GOAL, fileExists: exists }, { callLLM: llm });
    expect(result.status).toBe('elaborated');
    if (result.status !== 'elaborated') return;
    expect(result.attempts).toBe(1);
    expect(result.fileCount).toBe(2);
    expect(result.level).toBe('L2');
    expect(result.cardSha).toMatch(/^[0-9a-f]{64}$/);
    // 판정기는 고정 층만 받는다 — KPI 줄이 판정 프롬프트에 그대로 실린다.
    expect(llm.prompts[1]).toContain('판정 신호: goal-elaborated 사건이 원장에 남는다.');
  });

  test('KPI 밖 카드 → 다시 쓰기 1회 → 그래도 밖이면 needs-human', async () => {
    const outside = card({ files: ['src/self-implement/goal-author.ts'] });
    const llm = scripted([outside, outside]);
    const result = await elaborateGoalOnArrival({ goal: GOAL, fileExists: exists }, { callLLM: llm });
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') return;
    expect(result.attempts).toBe(2);
    expect(result.reason).toBe('goal-elaboration-protected-path');
    expect(result.violations.join('\n')).toContain('goal-author.ts');
    // 다시 쓰기 프롬프트는 앞 위반을 싣는다.
    expect(llm.prompts[1]).toContain('goal-author.ts');
    expect(llm.prompts[1]).toContain('보호 경로를 카드에서 빼고');
  });

  test('없는 경로는 재접지를 한 번 지시하고 같은 사유 재발 시 고정 reason으로 닫는다', async () => {
    const missing = card({ files: ['src/nowhere.ts'] });
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const llm = scripted([missing, missing]);
    const step = await runArrivalElaboration({ goal: GOAL, prompt: 'ROUND0', fileExists: exists, callLLM: llm,
      observe: (event, data) => events.push({ event, data }) });
    expect(step).toMatchObject({ parked: true });
    expect(step.detail).toContain('goal-elaboration-ungrounded-path (attempts: 2)');
    expect(llm.prompts[1]).toContain('없는 경로를 다시 접지');
    expect(events.find((e) => e.event === 'goal-elaboration-self-heal')?.data).toMatchObject({ reason: 'goal-elaboration-ungrounded-path', attempt: 1 });
    expect(events.find((e) => e.event === 'goal-elaboration-needs-human')?.data).toMatchObject({ reason: 'goal-elaboration-ungrounded-path', attempts: 2 });
  });

  test('한 카드의 보호 경로와 없는 경로를 단 한 번의 재작성 지시에 모두 싣는다', async () => {
    const bad = card({ files: ['src/self-implement/goal-author.ts', 'src/nowhere.ts'] });
    const llm = scripted([bad, card(), CONSISTENT]);
    const outcome = await elaborateGoalOnArrival({ goal: GOAL, fileExists: exists }, { callLLM: llm });
    expect(outcome).toMatchObject({ status: 'elaborated', attempts: 2 });
    expect(llm.prompts[1]).toContain('보호 경로를 카드에서 빼고');
    expect(llm.prompts[1]).toContain('없는 경로를 다시 접지');
  });

  test('판정기 보호 경로 지적에서 추출된 보호 목록이 비어도 빈 보호 경로 힌트를 내지 않는다', async () => {
    const goal = '대상 경로: src/self-implement/orchestrator.ts\n완료 경계: 카드 작성';
    const llm = scripted([card(), JSON.stringify({ consistent: false, violations: ['protected path: src/other.ts'] }),
      card(), CONSISTENT]);
    const outcome = await elaborateGoalOnArrival({ goal, fileExists: () => true }, { callLLM: llm });
    expect(outcome).toMatchObject({ status: 'elaborated', attempts: 2 });
    expect(llm.prompts[2]).toContain('위반 목록의 보호 경로 지적을 확인한다');
    expect(llm.prompts[2]).not.toContain('보호 경로: ');
  });

  test('범위 확장 지적은 좁히기 한 번으로 수복하고 HITL을 내지 않는다', async () => {
    const llm = scripted([card(), JSON.stringify({ consistent: false, violations: [{ kind: 'scope', text: 'new feature outside requested scope' }] }),
      card({ requirements: ['골에 적힌 카드만 붙인다'] }), CONSISTENT]);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const step = await runArrivalElaboration({ goal: GOAL, prompt: 'ROUND0', fileExists: exists, callLLM: llm,
      observe: (event, data) => events.push({ event, data }) });
    expect(step.parked).toBe(false);
    expect(llm.prompts[2]).toContain('범위 확장을 좁힌다');
    expect(events.find((e) => e.event === 'goal-elaboration-self-heal')?.data).toMatchObject({ reason: 'goal-elaboration-scope-conflict', attempt: 1 });
    expect(events.some((e) => e.event === 'goal-elaboration-needs-human')).toBe(false);
  });

  test('판정기의 범위 확장과 KPI 위반을 한 번의 재작성 지시에 모두 싣는다', async () => {
    const llm = scripted([card(), JSON.stringify({ consistent: false, violations: [
      { kind: 'scope', text: 'new feature outside requested scope' },
      { kind: 'content', text: 'KPI weakened' },
    ] }), card(), CONSISTENT]);
    const outcome = await elaborateGoalOnArrival({ goal: GOAL, fileExists: exists }, { callLLM: llm });
    expect(outcome).toMatchObject({ status: 'elaborated', attempts: 2 });
    expect(llm.prompts[2]).toContain('범위 확장을 좁힌다');
    expect(llm.prompts[2]).toContain('KPI·불변식을 보존한다');
  });

  test('KPI 범위 약화라는 자유 문면은 scope 수복으로 오분류하지 않는다', async () => {
    const llm = scripted([card(), JSON.stringify({ consistent: false, violations: [{ kind: 'content', text: 'KPI 범위를 약화했다' }] }),
      card(), JSON.stringify({ consistent: false, violations: [{ kind: 'content', text: 'KPI 범위를 약화했다' }] })]);
    const outcome = await elaborateGoalOnArrival({ goal: GOAL, fileExists: exists }, { callLLM: llm });
    expect(outcome).toMatchObject({ status: 'needs-human', reason: 'goal-elaboration-fixed-layer-conflict', attempts: 2 });
    expect(llm.prompts[2]).toContain('KPI·불변식을 보존한다');
  });

  test('FIRST10-GATE 실물 경로: 신설 시험 파일에 대한 옛 보호 경로 문면도 버린다', async () => {
    const testPath = 'scripts/first10-gate.test.ts';
    const goal = [
      '대상 경로: scripts/first10-gate.ts · scripts/first10-gate.test.ts · scripts/install.sh · src/onboarding/first-run.ts',
      '신설: scripts/first10-gate.ts · scripts/first10-gate.test.ts',
      'Do not edit the public installer or first-run production behavior in this slice unless a proven measurement defect requires it.',
      '완료 경계 증거 명령: bun test scripts/first10-gate.test.ts',
    ].join('\n');
    const fixed = extractGoalFixedLayer(goal);
    expect(fixed.targetPaths).toContain(testPath);
    expect(fixed.protectedPaths).not.toContain(testPath);
    const first = JSON.stringify({ files: ['scripts/first10-gate.ts', testPath],
      newFiles: ['scripts/first10-gate.ts', testPath], requirements: ['측정 명령과 단위 시험'],
      firstTest: { path: testPath, name: 'isolated recorder', redReason: 'recorder missing' }, stage: 'unit', level: 'L2' });
    const judge = JSON.stringify({ consistent: false, violations: [
      `protected path: ${testPath} (goal invariant forbids changing ${testPath})`,
    ] });
    const outcome = await elaborateGoalOnArrival({ goal, fileExists: () => false }, { callLLM: scripted([first, judge]) });
    expect(outcome).toMatchObject({ status: 'elaborated', attempts: 1, judgeErrors: ['judge-target-inversion-dropped: 1'] });
    const slightVariant = JSON.stringify({ consistent: false, violations: [`protected path:  ${testPath}.`] });
    expect(await elaborateGoalOnArrival({ goal, fileExists: () => false }, { callLLM: scripted([first, slightVariant]) }))
      .toMatchObject({ status: 'elaborated', attempts: 1, judgeErrors: ['judge-target-inversion-dropped: 1'] });
    const explicitContent = JSON.stringify({ consistent: false, violations: [{ kind: 'content', path: testPath,
      text: `protected path: ${testPath} (goal invariant forbids changing ${testPath})` }] });
    const held = await elaborateGoalOnArrival({ goal, fileExists: () => false },
      { callLLM: scripted([first, explicitContent, first, explicitContent]) });
    expect(held).toMatchObject({ status: 'needs-human', reason: 'goal-elaboration-fixed-layer-conflict', attempts: 2 });
  });

  test('1회 초과 재작성 설정은 조용히 잘리지 않고 거부된다', async () => {
    await expect(elaborateGoalOnArrival({ goal: GOAL, fileExists: exists }, { callLLM: scripted([]), maxRewrites: 2 })).rejects.toThrow('maxRewrites must be 0 or 1');
  });

  test('판정기가 KPI 불일치를 말하면 다시 쓰기 → 고친 카드는 통과', async () => {
    const llm = scripted([
      card(),
      JSON.stringify({ consistent: false, violations: ['card relaxes the acceptance signal'] }),
      card({ requirements: ['카드 블록을 붙이고 판정 신호는 그대로 둔다'] }),
      CONSISTENT,
    ]);
    const result = await elaborateGoalOnArrival({ goal: GOAL, fileExists: exists }, { callLLM: llm });
    expect(result.status).toBe('elaborated');
    if (result.status === 'elaborated') expect(result.attempts).toBe(2);
    expect(llm.prompts[2]).toContain('card relaxes the acceptance signal');
  });

  test('판독 실패 1회 ⊕ 고정 층 위반 1회 → needs-human 의 위반·해시는 판독된 카드를 가리킨다', async () => {
    const outside = card({ files: ['src/self-implement/goal-author.ts'] });
    const result = await elaborateGoalOnArrival({ goal: GOAL, fileExists: exists }, { callLLM: scripted([outside, 'garbage']) });
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') return;
    expect(result.violations.join('\n')).toContain('goal-author.ts');
    expect(result.violations.join('\n')).not.toContain('card-unparseable');
    expect(result.cardSha).toMatch(/^[0-9a-f]{64}$/);
  });

  test('판정기 실패는 결정론 대조로 통과하되 실패 사실을 남긴다', async () => {
    let calls = 0;
    const llm: ElaborationCallLLM = async () => { calls++; if (calls === 2) throw new Error('judge down'); return card(); };
    const result = await elaborateGoalOnArrival({ goal: GOAL, fileExists: exists }, { callLLM: llm });
    expect(result.status).toBe('elaborated');
    if (result.status !== 'elaborated') return;
    expect(result.judge).toBe('deterministic-only');
    expect(result.judgeErrors?.[0]).toContain('judge down');
  });

  test('공급자가 죽거나 카드를 두 번 못 읽으면 skipped(런을 막지 않는다)', async () => {
    const thrown = await elaborateGoalOnArrival({ goal: GOAL, fileExists: exists }, { callLLM: scripted([]) });
    expect(thrown.status).toBe('skipped');
    const garbage = await elaborateGoalOnArrival({ goal: GOAL, fileExists: exists }, { callLLM: scripted(['nope', 'still nope']) });
    expect(garbage.status).toBe('skipped');
  });

  test('골 원문(KPI·판정 신호)은 렌더된 카드 블록에 다시 쓰이지 않는다', async () => {
    const result = await elaborateGoalOnArrival({ goal: GOAL, fileExists: exists }, { callLLM: scripted([card(), CONSISTENT]) });
    if (result.status !== 'elaborated') throw new Error(result.status);
    const block = renderElaborationCard(result.card, result.cardSha);
    expect(block).toContain('착수 구체화 카드');
    expect(block).toContain('goal-elaborate.test.ts');
    expect(block).not.toContain('판정 신호: goal-elaborated');
  });
});

describe('runArrivalElaboration (orchestrator 호출점)', () => {
  test('KPI 안: 프롬프트에 카드가 붙고 goal-elaborated 사건이 남는다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const step = await runArrivalElaboration({
      goal: GOAL, prompt: 'ROUND0', fileExists: exists, callLLM: scripted([card(), CONSISTENT]),
      observe: (event, data) => events.push({ event, data }),
    });
    expect(step.parked).toBe(false);
    expect(step.prompt.startsWith('ROUND0\n\n## 착수 구체화 카드')).toBe(true);
    const elaborated = events.find((e) => e.event === 'goal-elaborated');
    expect(elaborated?.data).toMatchObject({ fileCount: 2, level: 'L2', attempts: 1 });
    expect(String(elaborated?.data.cardSha)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('KPI 밖: 다시 쓰기 뒤 사람 — 프롬프트는 그대로이고 parked', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const outside = card({ files: ['src/self-implement/goal-author.ts'] });
    const step = await runArrivalElaboration({
      goal: GOAL, prompt: 'ROUND0', fileExists: exists, callLLM: scripted([outside, outside]),
      observe: (event, data) => events.push({ event, data }),
    });
    expect(step.parked).toBe(true);
    expect(step.prompt).toBe('ROUND0');
    expect(events.map((e) => e.event)).toContain('goal-elaboration-needs-human');
    expect(events.map((e) => e.event)).not.toContain('goal-elaborated');
  });

  test('공급자 없음: 그대로 진행하고 skipped 를 남긴다', async () => {
    const events: string[] = [];
    const step = await runArrivalElaboration({ goal: GOAL, prompt: 'ROUND0', fileExists: exists, observe: (event) => events.push(event) });
    expect(step).toMatchObject({ parked: false, prompt: 'ROUND0' });
    expect(events).toEqual(['goal-elaboration-skipped']);
  });
});

// ── ELABORATION-PROTECTED-PATH-INVERSION (10-22 밤샘 parked 다수 · 0순위) ──
describe('ELABORATION-PROTECTED-PATH-INVERSION — 대상 경로를 보호 구역으로 뒤집지 않는다', () => {
  const T = 'src/self-implement/orchestrator-blocked-draft.test.ts';
  const INV_GOAL = [
    `대상 경로: src/self-implement/blocked-draft-policy.ts · ${T}`,
    `- 완료 경계 증거 명령: bun test ${T}`,
    `경계: 보존 계약 — 다른 명령·화면의 기본 동작과 원장 형식, ${T} 의 기존 단언은 바꾸지 않는다 · src/self-implement/goal-author.ts 는 건드리지 않는다.`,
    `UNVERIFIABLE(경계 형식 불일치): ${T} 수정 금지`,
  ].join('\n');

  test('반례: 대상=X.test.ts 인 골 → 보호 구역에 X.test.ts 없음 · 대상 아닌 경로 보호는 남는다', () => {
    const fixed = extractGoalFixedLayer(INV_GOAL);
    expect(fixed.targetPaths).toEqual(expect.arrayContaining(['src/self-implement/blocked-draft-policy.ts', T]));
    expect(fixed.protectedPaths).not.toContain(T);
    expect(fixed.protectedPaths).toContain('src/self-implement/goal-author.ts');
    // UNVERIFIABLE 경계 줄은 금지 불변식으로 격상되지 않는다
    expect(fixed.invariants.some((line) => line.startsWith('UNVERIFIABLE'))).toBe(false);
  });

  test('대상 시험 파일을 건드리는 카드는 결정론 위반이 아니다 · 대상 밖 보호 경로는 여전히 위반', () => {
    const fixed = extractGoalFixedLayer(INV_GOAL);
    const ok = parseElaborationCard(JSON.stringify({
      files: ['src/self-implement/blocked-draft-policy.ts', T], newFiles: [], requirements: ['정책 고침'],
      firstTest: { path: T, name: 'policy', redReason: '아직 없다' }, stage: 'unit', level: 'L2',
    }));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(checkCardAgainstFixedLayer(ok.card, fixed, () => true)).toEqual([]);
    const bad = { ...ok.card, files: [...ok.card.files, 'src/self-implement/goal-author.ts'] };
    expect(checkCardAgainstFixedLayer(bad, fixed, () => true)).toEqual(['protected path: src/self-implement/goal-author.ts (goal invariant forbids changing src/self-implement/goal-author.ts)']);
  });

  test('판정기가 «대상 경로 = 보호 구역 위반»이라 하면 그 지적은 버리고 정교화한다(needs-human 아님)', async () => {
    const goodCard = JSON.stringify({
      files: ['src/self-implement/blocked-draft-policy.ts', T], newFiles: [], requirements: ['정책 고침'],
      firstTest: { path: T, name: 'policy', redReason: '아직 없다' }, stage: 'unit', level: 'L2',
    });
    const judgeInverted = JSON.stringify({ consistent: false, violations: [{ kind: 'path', path: T, text: `card modifies ${T}, which the goal invariant forbids changing` }] });
    const llm = scripted([goodCard, judgeInverted]);
    const out = await elaborateGoalOnArrival({ goal: INV_GOAL, fileExists: () => true }, { callLLM: llm });
    expect(out.status).toBe('elaborated');
    if (out.status === 'elaborated') expect(out.judgeErrors).toEqual(['judge-target-inversion-dropped: 1']);
  });

  test('r1 반례: 현재 계약·판정 신호 줄의 «X 는 바꾸지 않는다» 경로는 대상이 아니다 — bun test 뒤 시험 파일만 대상', () => {
    const fixed = extractGoalFixedLayer([
      '대상 경로: src/self-implement/run-ttl.ts',
      '현재 계약: bun test src/self-implement/run-ttl.test.ts → 0 fail · src/self-implement/goal-author.ts 는 바꾸지 않는다',
      '경계: src/self-implement/goal-author.ts 는 바꾸지 않는다',
    ].join('\n'));
    expect(fixed.targetPaths).toEqual(expect.arrayContaining(['src/self-implement/run-ttl.ts', 'src/self-implement/run-ttl.test.ts']));
    expect(fixed.targetPaths).not.toContain('src/self-implement/goal-author.ts');
    expect(fixed.protectedPaths).toContain('src/self-implement/goal-author.ts');
  });

  test('r1 반례: 대상 시험 파일의 «기존 단언을 바꿨다» 는 내용 불변식 위반이라 버리지 않는다', async () => {
    const goodCard = JSON.stringify({
      files: ['src/self-implement/blocked-draft-policy.ts', T], newFiles: [], requirements: ['정책 고침'],
      firstTest: { path: T, name: 'policy', redReason: '아직 없다' }, stage: 'unit', level: 'L2',
    });
    const contentViolation = JSON.stringify({ consistent: false, violations: [{ kind: 'content', path: T, text: `card rewrites existing assertions in ${T}, which the goal invariant forbids changing` }] });
    const llm = scripted([goodCard, contentViolation, goodCard, contentViolation]);
    const out = await elaborateGoalOnArrival({ goal: INV_GOAL, fileExists: () => true }, { callLLM: llm, maxRewrites: 1 });
    expect(out.status).toBe('needs-human');
    if (out.status === 'needs-human') expect(out.violations[0]).toContain('existing assertions');
  });
  test('r6 반례: UNVERIFIABLE 금지 줄은 방향 대체값으로도 판정기 프롬프트에 안 들어가고 골은 elaborated', async () => {
    const goodCard = JSON.stringify({
      files: ['src/self-implement/blocked-draft-policy.ts', T], newFiles: [], requirements: ['정책 고침'],
      firstTest: { path: T, name: 'policy', redReason: '아직 없다' }, stage: 'unit', level: 'L2',
    });
    const prompts: string[] = [];
    const replies = [goodCard, JSON.stringify({ consistent: true, violations: [] })];
    const llm: ElaborationCallLLM = async (req) => { prompts.push(req.prompt); return replies[prompts.length - 1] ?? replies[1]!; };
    const fixed = extractGoalFixedLayer(INV_GOAL);
    expect(fixed.direction.some((l) => /UNVERIFIABLE/.test(l))).toBe(false);
    const out = await elaborateGoalOnArrival({ goal: INV_GOAL, fileExists: () => true }, { callLLM: llm });
    expect(out.status).toBe('elaborated');
    const judgePrompt = prompts[1]!;
    const fixedLayer = judgePrompt.split('### 카드')[0]!;
    expect(fixedLayer).not.toContain(`${T} 수정 금지`);
  });

  test('r5 반례: 대상 X ⊕ 경계 «X 는 바꾸지 않는다»(경로 자체 금지)면 금지가 이긴다 — 보호 ⊕ 대상에서 빠짐 · 판정기 path 지적도 남는다', async () => {
    const goal = [`대상 경로: src/self-implement/blocked-draft-policy.ts · ${T}`, `경계: ${T} 는 바꾸지 않는다`].join('\n');
    const fixed = extractGoalFixedLayer(goal);
    expect(fixed.protectedPaths).toContain(T);
    expect(fixed.targetPaths).not.toContain(T);
    expect(fixed.targetPaths).toContain('src/self-implement/blocked-draft-policy.ts');
    // 같은 경로에 «X 의 기존 단언은 바꾸지 않는다»(내용 한정)면 대상 예외 — 실물 사고 꼴.
    const scoped = extractGoalFixedLayer([`대상 경로: ${T}`, `경계: ${T} 의 기존 단언은 바꾸지 않는다`].join('\n'));
    expect(scoped.protectedPaths).not.toContain(T);
    expect(scoped.targetPaths).toContain(T);
  });

  test('r4 반례: 대상 줄 안의 «· Y 는 바꾸지 않는다» 금지 절의 Y 는 대상이 아니고 보호로 남는다', () => {
    const fixed = extractGoalFixedLayer([
      '대상 경로: src/self-implement/run-ttl.ts · src/self-implement/goal-author.ts 는 바꾸지 않는다',
      '경계: src/self-implement/goal-author.ts 는 바꾸지 않는다',
    ].join('\n'));
    expect(fixed.targetPaths).toContain('src/self-implement/run-ttl.ts');
    expect(fixed.targetPaths).not.toContain('src/self-implement/goal-author.ts');
    expect(fixed.protectedPaths).toContain('src/self-implement/goal-author.ts');
  });

  test('r2 반례: `bun test X · Y 는 바꾸지 않는다` — 구분자 뒤 Y 는 대상이 아니다', () => {
    const fixed = extractGoalFixedLayer([
      '대상 경로: src/self-implement/run-ttl.ts',
      '현재 계약: bun test src/self-implement/run-ttl.test.ts · src/self-implement/goal-author.ts 는 바꾸지 않는다',
      '경계: src/self-implement/goal-author.ts 는 바꾸지 않는다',
    ].join('\n'));
    expect(fixed.targetPaths).toContain('src/self-implement/run-ttl.test.ts');
    expect(fixed.targetPaths).not.toContain('src/self-implement/goal-author.ts');
    expect(fixed.protectedPaths).toContain('src/self-implement/goal-author.ts');
    expect(bunTestPathArgs('bun test a.test.ts --timeout 5 b/c.test.ts · d.ts')).toEqual(['a.test.ts', 'b/c.test.ts']);
    expect(bunTestPathArgs('bun test "src/x/a.test.ts" \'b.test.ts\' `c.test.ts` · d.ts')).toEqual(['src/x/a.test.ts', 'b.test.ts', 'c.test.ts']);
    const quoted = extractGoalFixedLayer([
      '증거 명령: bun test "src/self-implement/run-ttl.test.ts"',
      '경계: src/self-implement/run-ttl.test.ts 의 기존 단언은 바꾸지 않는다',
    ].join('\n'));
    expect(quoted.targetPaths).toContain('src/self-implement/run-ttl.test.ts');
    expect(quoted.protectedPaths).not.toContain('src/self-implement/run-ttl.test.ts');
  });

  test('r2 반례: 경로 수준처럼 읽히는 문구라도 kind 가 path 가 아니면(문자열·content) 버리지 않는다', async () => {
    const goodCard = JSON.stringify({
      files: ['src/self-implement/blocked-draft-policy.ts', T], newFiles: [], requirements: ['정책 고침'],
      firstTest: { path: T, name: 'policy', redReason: '아직 없다' }, stage: 'unit', level: 'L2',
    });
    for (const v of [`changing the expected exit code in ${T} is forbidden`, { kind: 'content', path: T, text: `changing the expected exit code in ${T} is forbidden` }]) {
      const verdict = JSON.stringify({ consistent: false, violations: [v] });
      const out = await elaborateGoalOnArrival({ goal: INV_GOAL, fileExists: () => true }, { callLLM: scripted([goodCard, verdict, goodCard, verdict]), maxRewrites: 1 });
      expect(out.status).toBe('needs-human');
      if (out.status === 'needs-human') expect(out.violations[0]).toContain('expected exit code');
    }
  });
});


// ── TA-REMOTE-MIRROR-BIND 10-22 (ta-20261022-53b9f6 · Pod 둘 연속 rc2 · «protected path src/task-agent/parent-host.test.ts») ──
//   저작 골(salvage 0d53d5199a)의 «분해 권고» 인용 한 줄에 «…Pod 부재를 단정하지 않는다» 가 있어 `하지 않는다` 금지로 읽혔고,
//   같은 절의 대상 둘 ⊕ 증거 시험 파일이 보호로 뒤집혔다(r5 규칙이 대상에서도 뺐다). 불변식 어디에도 그 파일 이름은 없다.
describe('TA-REMOTE-MIRROR-BIND 10-22 — 대상·증거 시험 파일은 어떤 경로로도 보호 구역 아님', () => {
  const CE = 'src/task-agent/card-evidence.ts';
  const PH = 'src/task-agent/parent-host.ts';
  const RP = 'src/task-agent/card-evidence-remote-parent.test.ts';
  const PHT = 'src/task-agent/parent-host.test.ts';
  const AUTHORED = [
    `대상 경로: ${CE} · ${PH} · ${RP}`,
    '## 발사 전 분해 권고',
    `  "먼저 ${RP}의 존재를 확인하고, 기존 격리 원격 부모 fixture에 부모 runId·자식 runId·Pod 신원 및 미러 공백의 ‘미관측’ 판정을 검증하는 테스트를 추가해 RED를 기록한다. 이어 기존 ${CE}:refreshCardRunBinding 호출 경로와 ${PH}의 원격 원장 미러링을 필요한 범위에서 수정해 GREEN으로 만든다. 같은 카드의 doctor 증거에서 두 runId를 구분하고 미러 공백만으로 Pod 부재를 단정하지 않는다. usage rollup runId 대조는 제외한다. \`bun test ${RP} ${PHT}\` 및 기존 card-evidence·task-hand 회귀 테스트를 실행하고, 변경된 생산 코드의 호출 경로를 제시한다.\\n대상 경로: ${CE} · ${PH} · ${RP}"`,
    '- 완료 경계 코드: 원격 부모 runId와 자식 runId가 같은 카드의 증거에서 분리되어 보이고, 원격 미러 공백만으로 Pod 부재를 단정하지 않는다.',
    `- 완료 경계 증거 명령: bun test ${RP} ${PHT}`,
    '- UNVERIFIABLE: Ask contains a boundary marker, but at least one entry did not match the required boundary format. source="경계 증거 명령: bun test …"',
  ].join('\n');

  test('실물 저작 문면 → 대상 셋 ⊕ 증거 시험 파일 어느 것도 보호 구역에 없다', () => {
    const fixed = extractGoalFixedLayer(AUTHORED);
    for (const path of [CE, PH, RP, PHT]) expect(fixed.protectedPaths).not.toContain(path);
    expect(fixed.targetPaths).toEqual(expect.arrayContaining([CE, PH, RP, PHT]));
  });

  test('증거 시험 파일을 건드리는 카드 → 결정론 위반 없음 · elaborated', async () => {
    const card = JSON.stringify({
      files: [CE, PH, RP, PHT], newFiles: [], requirements: ['부모·자식 runId 분리 · 미러 공백 = 미관측'],
      firstTest: { path: PHT, name: 'mirror gap', redReason: '아직 미관측 표시가 없다' }, stage: 'unit', level: 'L1',
    });
    const llm = scripted([card, JSON.stringify({ consistent: true, violations: [] })]);
    const out = await elaborateGoalOnArrival({ goal: AUTHORED, fileExists: () => true }, { callLLM: llm });
    expect(out.status).toBe('elaborated');
  });

  test('경계: 줄 밖의 맨 «X 는 바꾸지 않는다» 는 대상을 보호하지 못한다 · 경계: 줄이어도 증거 시험 파일은 보호 안 됨 · 대상 밖 경로 보호는 남는다', () => {
    const fixed = extractGoalFixedLayer([
      `대상 경로: ${PH}`,
      `- 완료 경계 증거 명령: bun test ${PHT}`,
      `- 기존 시험 ${PHT} 는 바꾸지 않는다`,
      `- ⛔ ${PH} 는 바꾸지 않는다`,
      `경계: ${PHT} 는 바꾸지 않는다 · src/self-implement/goal-author.ts 는 건드리지 않는다`,
    ].join('\n'));
    expect(fixed.protectedPaths).not.toContain(PH);
    expect(fixed.protectedPaths).not.toContain(PHT);
    expect(fixed.targetPaths).toEqual(expect.arrayContaining([PH, PHT]));
    expect(fixed.protectedPaths).toContain('src/self-implement/goal-author.ts');
  });

  test('r1 반례: 경계: 줄이라도 «X 를 수정하되 기존 단언은 바꾸지 않는다» 는 경로 자체 금지가 아니다 — 대상으로 남는다', () => {
    const fixed = extractGoalFixedLayer([`대상 경로: ${PH}`, `경계: ${PH} 를 수정하되 기존 단언은 바꾸지 않는다`].join('\n'));
    expect(fixed.protectedPaths).not.toContain(PH);
    expect(fixed.targetPaths).toContain(PH);
  });
});

// ── 같은 변종 둘째 표본 (10-22 15:14Z · pod · run-832b75e0 · «protected path: src/cli/pr-land-overlap-evidence.test.ts») ──
//   부모 원장(run-3e6fd5d9)의 칸 문면 579자는 실물이다. Pod 가 받은 983자(수리 접미 포함)는 원장·로그에 120자로 잘려 남지 않았다 —
//   마지막 줄은 «재구성»이다: 앞 PR 수리 맥락이 대상 시험 파일과 «금지»(리뷰 금지 해제)를 한 절에 실었다.
describe('PRLAND-ACP-CLAUDE-ALLOW 10-22 — 대상·증거 시험 파일은 수리 맥락의 «금지» 낱말로 보호되지 않는다', () => {
  const ET = 'src/cli/pr-land-overlap-evidence.test.ts';
  const GOAL = [
    `대상 경로: src/cli/pr-land-overlap-evidence.ts · ${ET}`,
    'PRLAND-ACP-CLAUDE-ALLOW: 착지기가 review.model=acp:claude를 무조건 거부하던 임시 금지를 해제하고, 같은 head의 금지 리뷰는 새 GLM pass 리뷰가 superseded할 수 있게 한다.',
    '- 완료 경계 코드: PR 착지 evidence 생산 경로에서 허용된 acp:claude pass를 받으며, PR/head/verdict/must-fix 검증과 금지 리뷰의 superseded 검사는 보존한다.',
    '- 완료 경계 실물: 생산 evidence 선택 경로에서 Claude pass, 금지 리뷰 뒤 GLM pass, stale head, must-fix 잔존을 실행해 허용·거부를 확인한다.',
    `- 완료 경계 증거 명령: bun test ${ET}`,
    '- 기존 PR #30427의 의미 있는 hunk를 기준으로 수리하고, 차단 gate와 내부 리뷰의 남은 쟁점을 이 셀 범위에서 해결한다.',
    // 재구성(수리 접미):
    `- 앞 시도 PR #30427: ${ET} 에 acp:claude 금지 해제 단언을 더했다 — 같은 head 의 금지 리뷰 검사는 지우지 않는다`,
  ].join('\n');

  test('대상·증거 시험 파일이 보호 구역에 없고 그 파일을 고치는 카드는 elaborated', async () => {
    const fixed = extractGoalFixedLayer(GOAL);
    expect(fixed.protectedPaths).not.toContain(ET);
    expect(fixed.targetPaths).toContain(ET);
    const card = JSON.stringify({
      files: ['src/cli/pr-land-overlap-evidence.ts', ET], newFiles: [], requirements: ['acp:claude pass 허용'],
      firstTest: { path: ET, name: 'acp claude pass', redReason: '아직 거부한다' }, stage: 'unit', level: 'L1',
    });
    const out = await elaborateGoalOnArrival({ goal: GOAL, fileExists: () => true }, { callLLM: scripted([card, JSON.stringify({ consistent: true, violations: [] })]) });
    expect(out.status).toBe('elaborated');
  });
});

// ── 같은 변종 셋째 표본 (UX FIRST10-GATE · ta-20261022-be5cfe · run-0ba94fbb · salvage c40070f1e7 저작 골 발췌 5줄 그대로) ──
//   분해 인용 줄의 «… must not claim the full card green … Evidence commands: `bun test scripts/first10-gate.test.ts`» 가 한 절로 금지가 됐다.
describe('FIRST10-GATE 10-22 — 대상 ⊕ 신설 ⊕ 증거 시험 파일은 영어 «must not» 절로 보호되지 않는다', () => {
  const GT = 'scripts/first10-gate.test.ts';
  const AUTHORED = [
    "대상 경로: scripts/first10-gate.ts · scripts/first10-gate.test.ts · scripts/install.sh · src/onboarding/first-run.ts",
    "  \"FIRST10-GATE 0.2.36 first measurable slice: create scripts/first10-gate.ts and scripts/first10-gate.test.ts (new files only; do NOT edit scripts/install.sh or src/onboarding/first-run.ts). Implement a local recorder CLI (`bun scripts/first10-gate.ts`) that: starts a monotonic stopwatch BEFORE invoking the real public installer scripts/install.sh with `--prefix`/`--source` (ELANOUS_INSTALL_LANG selects ko/en); captures per-phase (install, first-run) rc/stdout/stderr, elapsed monotonic time, locale, source URL or tarball SHA-256 hash, CLI version, and an evidence reference for the first usable answer; writes exactly one JSON record containing per-phase timings, error count, a 600s decision field, and any missing fields. The command MUST validate that HOME/PREFIX/ELANOUS_STATE_DIR are isolated paths and REFUSE to run against operating default paths. Secrets and raw auth tokens must never be written into artifacts. A run without a real useful result must record `usefulResult: \\\"unmeasured\\\"` (or `failed`) — never `pass`; ko and en runs are recorded separately and fixture/mock output must never be conflated with a real useful result. Parser/format tests may use a fixture only for code shape and must not claim the full card green. Provide `--help` and a Linux dry-rehearsal mode proving safe path selection and emitting a record with `usefulResult: unmeasured` (do not claim macOS 10-minute success). Evidence commands: `bun test scripts/first10-gate.test.ts`, the recorder `--help`, and the dry-rehearsal command. Return as a draft PR for UX harvest; no autonomous land.\\n대상 경로: scripts/first10-gate.ts · scripts/first10-gate.test.ts · scripts/install.sh · src/onboarding/first-run.ts\"",
    "신설: scripts/first10-gate.ts · scripts/first10-gate.test.ts",
    "Evidence commands: `bun test scripts/first10-gate.test.ts` and the actual recorder `--help` and dry rehearsal command.",
    "완료 경계 증거 명령: bun test scripts/first10-gate.test.ts",
  ].join('\n');

  test('실물 저작 문면 → 신설 시험 파일이 보호 구역에 없고 대상으로 남는다', async () => {
    const fixed = extractGoalFixedLayer(AUTHORED);
    expect(fixed.protectedPaths).not.toContain(GT);
    expect(fixed.targetPaths).toEqual(expect.arrayContaining(['scripts/first10-gate.ts', GT]));
    const card = JSON.stringify({
      files: ['scripts/first10-gate.ts', GT], newFiles: ['scripts/first10-gate.ts', GT], requirements: ['recorder'],
      firstTest: { path: GT, name: 'recorder', redReason: '아직 없다' }, stage: 'unit', level: 'L1',
    });
    const out = await elaborateGoalOnArrival({ goal: AUTHORED, fileExists: () => false }, { callLLM: scripted([card, JSON.stringify({ consistent: true, violations: [] })]) });
    expect(out.status).toBe('elaborated');
  });
});
