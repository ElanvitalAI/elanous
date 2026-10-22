import { describe, expect, test } from 'bun:test';
import {
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
    expect(result.violations.join('\n')).toContain('goal-author.ts');
    // 다시 쓰기 프롬프트는 앞 위반을 싣는다.
    expect(llm.prompts[1]).toContain('goal-author.ts');
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
