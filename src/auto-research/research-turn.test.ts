import { expect, test } from 'bun:test';
import { setElanousConfigDir } from '../elanous-config-dir.js';
import type { ResearchQuestionLadderRunOptions } from './research-turn.js';
import type { ResearchOutputRouteDecision } from '../research/output-router.js';

// Gate shards set an isolated state root and may also provide a separate config
// root. Install that override before importing modules that read config state.
if (process.env.ELANOUS_CONFIG_DIR) setElanousConfigDir(process.env.ELANOUS_CONFIG_DIR);

const { debug } = await import('../debug/log.js');
const { researchTurnForGrounding, runResearchQuestionLadder } = await import('./research-turn.js');
const { routeResearchOutput } = await import('../research/output-router.js');

const questions = Array.from({ length: 6 }, (_, index) => ({
  id: `q${index + 1}`,
  level: index + 1,
  prompt: `Question ${index + 1}`,
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
const generateContract = async (prompt: string) => {
  expect(prompt).toContain('Work backwards from the result');
  return JSON.stringify(outputContract);
};
const noOutputSkillRoute = (input: Parameters<typeof routeResearchOutput>[0]) => routeResearchOutput({ ...input, skills: [] });

test('a research turn sends all six Bloom axes to native search and attaches source evidence by question', async () => {
  let calls: Array<{ id: string; terms: string[] }> = [];
  const result = await runResearchQuestionLadder('Why are bond yields rising?', {
    generateContract,
    routeOutput: noOutputSkillRoute,
    generate: async (prompt) => {
      expect(prompt).toContain('Why are bond yields rising?');
      expect(prompt).toContain('Working Backwards output contract');
      expect(prompt).toContain('Assign every question to exactly one output section using sectionId');
      expect(prompt).toContain('[causes] Causes: Explain the main supported causes.');
      expect(prompt).toContain('Each required section is supported by evidence');
      return JSON.stringify({ questions });
    },
    invokeAxes: async (axes) => {
      calls = axes.map(({ id, searchTerms }) => ({ id, terms: searchTerms }));
      return {
        plan: axes.flatMap((axis) => axis.searchTerms.map((query) => ({ questionId: axis.id, tool: 'OmniSearch' as const, query }))),
        axes: axes.map((axis) => ({ questionId: axis.id, evidence: [{
          questionId: axis.id, sourceKind: 'web-search:test', source: `https://example.org/${axis.id}`,
          content: `Evidence ${axis.id}`, outcome: 'complete' as const, truncated: true,
        }] })),
      };
    },
  });

  expect(result.ok).toBe(true);
  expect(calls).toHaveLength(6);
  expect(calls).toEqual(questions.map((question) => ({ id: question.id, terms: question.searchTerms })));
  expect(result.ladder.questions).toHaveLength(6);
  expect(result.ladder.evidence).toHaveLength(6);
  expect(result.ladder.evidence[0]).toMatchObject({ questionId: 'q1', sourceKind: 'web-search:test', source: 'https://example.org/q1', outcome: 'complete' });
  expect(result.outputContract).toEqual(outputContract);
  expect(result.output).toContain('## Output contract');
  expect(result.output).toContain('Evidence');
});

test('routes the synthesized evidence through the selected output skill and preserves axis evidence', async () => {
  let routedAxes: readonly string[] = [];
  let invoked: { skill: string; args: string } | undefined;
  const result = await runResearchQuestionLadder('Compare bond yield scenarios', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: [{
        questionId: axis.id, sourceKind: 'web-search:test', source: `https://example.org/${axis.id}`,
        content: `Evidence ${axis.id}`, outcome: 'complete' as const, truncated: false,
      }] })),
    }),
    routeOutput: (input) => {
      routedAxes = input.axes ?? [];
      return {
        weight: 'heavy', weightSource: 'estimated', format: 'diagram',
        skillCallPlan: { skill: 'research-diagram', args: 'format evidence' },
        observation: { resultChars: input.synthesizedResult.length, axisCount: input.axes?.length ?? 0, estimatedWeight: 'heavy', selectedSkill: 'research-diagram' },
      } as ResearchOutputRouteDecision;
    },
    invokeOutputSkill: async (skill, args) => {
      invoked = { skill, args };
      return { ok: true, output: 'Scenario diagram summary.' };
    },
  });

  expect(routedAxes).toHaveLength(6);
  expect(invoked).toEqual({ skill: 'research-diagram', args: 'format evidence' });
  expect(result.output).toContain('Evidence q1');
  expect(result.output).toContain('Scenario diagram summary.');
});

test('keeps raw Bloom evidence when the output router fails', async () => {
  const result = await runResearchQuestionLadder('Compare bond yield scenarios', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: [{
        questionId: axis.id, sourceKind: 'web-search:test', source: `https://example.org/${axis.id}`,
        content: `Evidence ${axis.id}`, outcome: 'complete' as const, truncated: false,
      }] })),
    }),
    routeOutput: () => { throw new Error('registry unavailable'); },
  });

  expect(result.ok).toBe(true);
  expect(result.ladder.evidence).toHaveLength(6);
  expect(result.output).toContain('Evidence q1');
});

test('an invalid generated ladder fails closed without launching research calls', async () => {
  let calls = 0;
  const result = await runResearchQuestionLadder('bond yields', {
    generateContract,
    routeOutput: noOutputSkillRoute,
    generate: async () => JSON.stringify({ questions: questions.slice(0, 5) }),
    invokeAxes: async () => { calls += 1; return { plan: [], axes: [] }; },
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('exactly six questions');
  expect(calls).toBe(0);
});

test('search failures remain attached to their question while other questions finish', async () => {
  const result = await runResearchQuestionLadder('bond yields', {
    generateContract,
    routeOutput: noOutputSkillRoute,
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((question) => ({ questionId: question.id, evidence: question.id === 'q3' ? [{
        questionId: question.id, sourceKind: 'search-query', source: question.searchTerms[0]!,
        content: 'provider unavailable', outcome: 'failed' as const, truncated: false,
      }] : [{
        questionId: question.id, sourceKind: 'web-search:test', source: `https://example.org/${question.id}`,
        content: 'evidence', outcome: 'complete' as const, truncated: true,
      }] })),
    }),
  });
  expect(result.ok).toBe(false);
  expect(result.ladder.evidence).toHaveLength(6);
  expect(result.ladder.evidence.find((item) => item.questionId === 'q3')).toMatchObject({ outcome: 'failed' });
  expect(result.ladder.evidence.find((item) => item.questionId === 'q2')).toMatchObject({ outcome: 'complete' });
  const grounding = researchTurnForGrounding(result);
  expect(grounding.ok).toBe(true);
  expect(grounding.output).toContain('[failed]');
});

test('executes one bounded Bloom 4/5 gap follow-up and attaches returned evidence before output routing', async () => {
  let followupInput: Parameters<NonNullable<ResearchQuestionLadderRunOptions['gapFollowup']>>[0] | undefined;
  let routedText = '';
  const result = await runResearchQuestionLadder('Why are bond yields rising?', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: axis.id === 'q5' ? [{
        questionId: axis.id, sourceKind: 'web-search:test', source: `https://example.org/${axis.id}`,
        content: `Evidence ${axis.id}`, outcome: 'partial' as const, truncated: false,
      }] : [{
        questionId: axis.id, sourceKind: 'web-search:test', source: `https://example.org/${axis.id}`,
        content: `Evidence ${axis.id}`, outcome: 'complete' as const, truncated: false,
      }] })),
    }),
    gapFollowup: async (input) => {
      followupInput = { request: input.request, questions: input.questions, evidence: input.evidence };
      return {
        rounds: 1, timeBudgetMs: 120_000,
        classifications: [{ questionId: 'q5', gap: 'missing counterevidence', action: 'auto-fill', reason: 'auto-fill-eligible', skill: 'omni-crawl' }],
        followups: [{ questionId: 'q5', skill: 'omni-crawl', query: 'Why are bond yields rising? missing counterevidence' }],
        followupEvidence: [{ questionId: 'q5', sourceKind: 'skill:omni-crawl', source: 'omni-crawl',
          observedAt: '2026-10-26T00:00:00.000Z', content: 'Counterevidence found at a primary source.', outcome: 'complete', truncated: false }],
        discoveryCards: ['Plugin discovery · undo: eln plugin remove premium-data'],
      };
    },
    routeOutput: (input) => { routedText = input.synthesizedResult; return noOutputSkillRoute(input); },
  });

  expect(followupInput?.request).toBe('Why are bond yields rising?');
  expect(followupInput?.questions.map((question) => question.level)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(followupInput?.evidence).toHaveLength(6);
  expect(result.ok).toBe(true);
  expect(result.ladder.evidence).toHaveLength(7);
  expect(result.ladder.evidence.at(-1)).toMatchObject({ sourceKind: 'skill:omni-crawl', questionId: 'q5', outcome: 'complete' });
  expect(result.output).toContain('Bounded research gap follow-up');
  expect(result.output).toContain('Counterevidence found at a primary source.');
  expect(result.output).toContain('Plugin discovery · undo: eln plugin remove premium-data');
  expect(routedText).toContain('Counterevidence found at a primary source.');
  expect(result.output).toContain('Completion boundary: stopped — every output-contract section slot is filled.');
});

test('a follow-up runner failure preserves the already collected research evidence', async () => {
  const result = await runResearchQuestionLadder('bond yields', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({ plan: [], axes: axes.map((axis) => ({ questionId: axis.id, evidence: axis.id === 'q3' ? [{
      questionId: axis.id, sourceKind: 'web-search:test', source: `https://example.org/${axis.id}`,
      content: `Evidence ${axis.id}`, outcome: 'partial' as const, truncated: false,
    }] : [{
      questionId: axis.id, sourceKind: 'web-search:test', source: `https://example.org/${axis.id}`,
      content: `Evidence ${axis.id}`, outcome: 'complete' as const, truncated: false,
    }] })) }),
    gapFollowup: async () => { throw new Error('follow-up service unavailable'); },
    routeOutput: noOutputSkillRoute,
  });
  expect(result.ok).toBe(false);
  expect(result.ladder.evidence).toHaveLength(6);
  expect(result.output).toContain('Evidence q1');
});

test('grounding rejects the research result when all six axes fail', async () => {
  const result = await runResearchQuestionLadder('bond yields', {
    generateContract,
    routeOutput: noOutputSkillRoute,
    gapFollowup: async () => ({ rounds: 0, timeBudgetMs: 0, classifications: [], followups: [], followupEvidence: [] }),
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((question) => ({ questionId: question.id, evidence: [{
        questionId: question.id,
        sourceKind: 'search-query',
        source: question.searchTerms[0]!,
        content: 'provider unavailable',
        outcome: 'failed' as const,
        truncated: false,
      }] })),
    }),
  });

  expect(result.ok).toBe(false);
  expect(researchTurnForGrounding(result).ok).toBe(false);
  expect(researchTurnForGrounding(result).output).toContain('[failed]');
});

test('THINK-LENS-T1-WORKING-BACKWARDS: 원문이 대상 경로로 지목한 src/auto-research/research-turn.ts에 완료 경계 코드 행을 붙인다 — 다 차면 stop(debug.log)하고 갭 후속을 건너뛴다', async () => {
  let followupCalls = 0;
  const result = await runResearchQuestionLadder('Why are bond yields rising?', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: [{
        questionId: axis.id, sourceKind: 'web-search:test', source: `https://example.org/${axis.id}`,
        content: `Evidence ${axis.id}`, outcome: 'complete' as const, truncated: false,
      }] })),
    }),
    gapFollowup: async () => {
      followupCalls += 1;
      return { rounds: 0, timeBudgetMs: 120_000, classifications: [], followups: [], followupEvidence: [] };
    },
    routeOutput: noOutputSkillRoute,
  });

  expect(followupCalls).toBe(0);
  expect(result.ok).toBe(true);
  expect(result.ladder.evidence).toHaveLength(6);
  expect(result.output).toContain('## Answer skeleton (Working Backwards output contract)');
  expect(result.output).toContain('- [causes] Causes — Explain the main supported causes. — filled');
  expect(result.output).toContain('- [uncertainty] Uncertainty — State what remains unsupported. — filled');
  expect(result.output).toContain('Completion boundary: stopped — every output-contract section slot is filled.');
  const stops = debug.events(500).filter((event) => event.category === 'research.turn' && event.event === 'completion-boundary-stop');
  expect(stops.some((event) => (event.data as { stage?: string } | undefined)?.stage === 'axis-fanout')).toBe(true);
});

test('RESEARCH-RETRO-LOOP-HOOK: 조사 런 종료 시 회고 레코드 1건 저장 ⊕ 다음 조사 턴에서 같은 주제 레코드가 1단 근거로 주입(debug.log)', async () => {
  const topic = 'Why are long-term bond yields steepening against forecasts?';
  const baseline = debug.events(500).length;
  const eventsSince = () => debug.events(500).slice(baseline);
  let secondPrompt = '';
  const options: ResearchQuestionLadderRunOptions = {
    generateContract,
    routeOutput: noOutputSkillRoute,
    generate: async (prompt: string) => { secondPrompt = prompt; return JSON.stringify({ questions }); },
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: [{
        questionId: axis.id, sourceKind: 'web-search:test', source: `https://example.org/${axis.id}`,
        content: `Evidence ${axis.id}`, outcome: 'complete' as const, truncated: false,
      }] })),
    }),
  };
  await runResearchQuestionLadder(topic, options);
  await runResearchQuestionLadder(topic, options);
  const saved = eventsSince().filter((event) =>
    event.category === 'research.turn' && event.event === 'retro-record-saved'
    && (event.data as { topic?: string } | undefined)?.topic === topic);
  const injected = eventsSince().filter((event) =>
    event.category === 'research.turn' && event.event === 'retro-grounding-injected'
    && (event.data as { topic?: string } | undefined)?.topic === topic);
  expect(saved).toHaveLength(2);
  const savedIds = saved.map((event) => (event.data as { orchestrationId?: string }).orchestrationId);
  expect(new Set(savedIds).size).toBe(2);
  expect(injected).toHaveLength(1);
  expect(secondPrompt).toContain('Fill this gap first');
  expect(secondPrompt).toContain('지난번 대비 달라진 것');
});

test('invalid output contract fails before Bloom generation or axis searches', async () => {
  let calls = 0;
  const result = await runResearchQuestionLadder('bond yields', {
    generateContract: async () => JSON.stringify({ deliverable: 'Memo', format: 'Text', sections: [], completionCriteria: ['Done'] }),
    generate: async () => { calls += 1; return JSON.stringify({ questions }); },
    invokeAxes: async () => { calls += 1; return { plan: [], axes: [] }; },
  });
  expect(result.ok).toBe(false);
  expect(result.error).toBe('at least one output section is required');
  expect(calls).toBe(0);
});
