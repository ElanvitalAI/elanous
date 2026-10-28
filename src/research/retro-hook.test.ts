import { expect, test } from 'bun:test';
import { setElanousConfigDir } from '../elanous-config-dir.js';
import type { ResearchQuestionLadderRunOptions } from '../auto-research/research-turn.js';

// The gate may provide a temporary config directory while state-dir points at
// its isolated state root. This test only observes debug events, so explicitly
// use the harness config directory instead of triggering the legacy-env warning.
if (process.env.ELANOUS_CONFIG_DIR) setElanousConfigDir(process.env.ELANOUS_CONFIG_DIR);

const { debug } = await import('../debug/log.js');
const { runResearchQuestionLadder } = await import('../auto-research/research-turn.js');
const { routeResearchOutput } = await import('./output-router.js');

const questions = Array.from({ length: 6 }, (_, index) => ({
  id: `q${index + 1}`,
  level: index + 1,
  prompt: index === 4 ? 'How does the term premium affect bond yields?' : `Question ${index + 1}`,
  searchTerms: [`term-${index + 1}-a`, `term-${index + 1}-b`],
  sectionId: index % 2 === 0 ? 'causes' : 'uncertainty',
}));
const outputContract = {
  deliverable: 'A sourced research memo',
  format: 'Short memo with two sections',
  sections: [
    { id: 'causes', title: 'Causes', purpose: 'Explain the main supported causes.' },
    { id: 'uncertainty', title: 'Uncertainty', purpose: 'State what remains unsupported.' },
  ],
  completionCriteria: ['Each required section is supported by evidence or explicitly marked uncertain.'],
};
const generateContract = async () => JSON.stringify(outputContract);
const noOutputSkillRoute = (input: Parameters<typeof routeResearchOutput>[0]) =>
  routeResearchOutput({ ...input, skills: [] });

function makeRunOptions(
  _topic: string,
  gapQuestionId: 'q5' | null,
  promptCapture: { value: string },
): ResearchQuestionLadderRunOptions {
  return {
    generateContract,
    routeOutput: noOutputSkillRoute,
    generate: async (prompt: string) => {
      promptCapture.value = prompt;
      return JSON.stringify({ questions });
    },
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((axis) => ({
        questionId: axis.id,
        evidence: [{
          questionId: axis.id,
          sourceKind: 'web-search:test',
          source: `https://example.org/${axis.id}`,
          content: `Evidence ${axis.id}`,
          outcome: (gapQuestionId && axis.id === gapQuestionId ? 'partial' : 'complete') as 'partial' | 'complete',
          truncated: false,
        }],
      })),
    }),
    gapFollowup: async () => ({ rounds: 0, timeBudgetMs: 120_000, classifications: [], followups: [], followupEvidence: [] }),
  };
}

function retroEventsSince(baseline: number, event: string, topic: string) {
  return debug.events(500).slice(baseline).filter((e) =>
    e.category === 'research.turn' && e.event === event
    && ((e.data as { topic?: string } | undefined)?.topic === topic));
}

test('RESEARCH-RETRO-LOOP-HOOK: 조사 런 종료 시 회고 레코드 1건 저장 ⊕ 다음 조사 턴에서 같은 주제 레코드가 1단 근거로 주입(debug.log)', async () => {
  const topic = 'Retro hook persistence across research turns';
  const baseline = debug.events(500).length;
  const promptCapture = { value: '' };
  await runResearchQuestionLadder(topic, makeRunOptions(topic, null, promptCapture));

  const saved = retroEventsSince(baseline, 'retro-record-saved', topic);
  expect(saved).toHaveLength(1);
  const record = saved[0]!.data as Record<string, string>;
  expect(record.topic).toBe(topic);
  expect(record.observedGap).toBeTruthy();
  expect(record.orchestrationId).toBeTruthy();
  expect(record.observedAt).toBeTruthy();

  const secondPrompt = { value: '' };
  await runResearchQuestionLadder(topic, makeRunOptions(topic, null, secondPrompt));
  const injected = retroEventsSince(baseline, 'retro-grounding-injected', topic);
  expect(injected).toHaveLength(1);
  expect((injected[0]!.data as Record<string, string>).observedGap).toBe(record.observedGap);
  expect(secondPrompt.value).toContain('Fill this gap first');
  expect(secondPrompt.value).toContain('지난번 대비 달라진 것');
});

test('RESEARCH-RETRO-LOOP-HOOK: 격리 우주 채권 금리 질문 2회 — 두 번째 입력이 첫 회고의 공백(기간 프리미엄)을 먼저 채운다', async () => {
  const topic = 'Retro hook bond yield two-run scenario';
  const baseline = debug.events(500).length;
  const firstPrompt = { value: '' };
  await runResearchQuestionLadder(topic, makeRunOptions(topic, 'q5', firstPrompt));
  const firstRecord = retroEventsSince(baseline, 'retro-record-saved', topic)[0]!.data as Record<string, string>;
  expect(firstRecord.observedGap).toContain('term premium');

  const secondPrompt = { value: '' };
  await runResearchQuestionLadder(topic, makeRunOptions(topic, null, secondPrompt));
  expect(retroEventsSince(baseline, 'retro-grounding-injected', topic)).toHaveLength(1);
  expect(secondPrompt.value).toContain('term premium');
  expect(secondPrompt.value).toContain('지난번 대비 달라진 것');
});

test('RESEARCH-RETRO-LOOP-HOOK: 회고 레코드에 비밀·자격 문자열이 일절 기록되지 않는다', async () => {
  const secret = 'sk-or-v1-abcdefghijklmnop1234567890abcdef';
  const topic = `bond yields with key ${secret}`;
  const promptCapture = { value: '' };
  await runResearchQuestionLadder(topic, makeRunOptions(topic, null, promptCapture));
  const rawLog = debug.events(500)
    .filter((e) => e.category === 'research.turn' && e.event === 'retro-record-saved')
    .map((e) => JSON.stringify(e.data ?? {}));
  expect(rawLog.length).toBeGreaterThan(0);
  expect(rawLog.some((line) => line.includes(secret))).toBe(false);
});
