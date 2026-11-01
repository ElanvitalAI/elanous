import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir } from '../elanous-config-dir.js';
import type { LLMOpts, LLMProvider } from '../llm.js';
import { BLOOM_2D_SCOPED } from '../knowledge/kgs/types.js';
import { BLOOM_EXEMPLAR_DOMAINS } from '../research/bloom-exemplars.js';
import type { ResearchQuestionLadderRunOptions } from './research-turn.js';
import type { BloomResearchQuestion } from './question-ladder-contract.js';
import type { ResearchOutputRouteDecision } from '../research/output-router.js';

// Gate shards set an isolated state root and may also provide a separate config
// root. Install that override before importing modules that read config state.
if (process.env.ELANOUS_CONFIG_DIR) setElanousConfigDir(process.env.ELANOUS_CONFIG_DIR);

const { debug } = await import('../debug/log.js');
const {
  planWorkingBackwardsCompletion,
  researchTurnForGrounding,
  runResearchQuestionLadder: runResearchQuestionLadderWithSubagents,
} = await import('./research-turn.js');
const runResearchQuestionLadder: typeof runResearchQuestionLadderWithSubagents = (request, options = {}) =>
  runResearchQuestionLadderWithSubagents(request, { ...options, enableResearchFanout: false });
const { routeResearchOutput } = await import('../research/output-router.js');

const questions: BloomResearchQuestion[] = Array.from({ length: 6 }, (_, index) => ({
  id: `q${index + 1}`,
  level: (index + 1) as BloomResearchQuestion['level'],
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

test('research generation inherits the active turn provider and only permits Grok fallback for X intent', async () => {
  const calls: Array<{ usageSite?: string; skipProviders?: readonly string[] }> = [];
  const codexProvider: LLMProvider = {
    name: 'openai-codex',
    defaultModel: 'gpt-6.1-codex',
    available: () => true,
    async *chat(_messages, options) {
      const routed = options as LLMOpts & { skipProviders?: readonly string[] } | undefined;
      calls.push({ usageSite: options?.usageSite, skipProviders: routed?.skipProviders });
      yield JSON.stringify({ outputContract, questions });
    },
  };
  const invokeAxes: NonNullable<ResearchQuestionLadderRunOptions['invokeAxes']> = async (axes) => ({
    plan: axes.flatMap((axis) => axis.searchTerms.map((query) => ({ questionId: axis.id, tool: 'OmniSearch' as const, query }))),
    axes: axes.map((axis) => ({ questionId: axis.id, evidence: ['example.org', 'example.net'].map((host) => ({
      questionId: axis.id, sourceKind: 'web-search:test', source: `https://${host}/${axis.id}`,
      content: `Evidence ${axis.id} from ${host}`, outcome: 'complete' as const, truncated: false,
    })) })),
  });
  const common = {
    initialProvider: codexProvider,
    skipProviders: ['anthropic'],
    routeOutput: noOutputSkillRoute,
    invokeAxes,
  };

  const ordinary = await runResearchQuestionLadder('Why are bond yields rising?', common);
  const xIntent = await runResearchQuestionLadder('X에서 최근 기업 발표 게시물을 찾아줘', common);
  const mathematicalX = await runResearchQuestionLadder('X의 극값을 찾고 X로 표현하면 어떤 의미인가?', common);
  const xUrl = await runResearchQuestionLadder('https://x.com', common);
  const linuxUrl = await runResearchQuestionLadder('https://linux.com', common);
  const netflixUrl = await runResearchQuestionLadder('https://netflix.com', common);
  const dropboxUrl = await runResearchQuestionLadder('https://dropbox.com', common);

  expect(ordinary.ok).toBe(true);
  expect(xIntent.ok).toBe(true);
  expect(mathematicalX.ok).toBe(true);
  expect(xUrl.ok).toBe(true);
  expect(linuxUrl.ok).toBe(true);
  expect(netflixUrl.ok).toBe(true);
  expect(dropboxUrl.ok).toBe(true);
  expect(calls).toHaveLength(7);
  expect(calls.map((call) => call.skipProviders)).toEqual([
    ['anthropic', 'grok'], ['anthropic'], ['anthropic', 'grok'], ['anthropic'],
    ['anthropic', 'grok'], ['anthropic', 'grok'], ['anthropic', 'grok'],
  ]);
  expect(calls.every((call) => call.usageSite === 'research-turn-preparation')).toBe(true);
  // The debug ring buffer is capped at 500 events and can already be full in
  // the release node-c shard. Select the last events emitted by this scenario
  // instead of using the buffer length as a cursor.
  const providerEvents = debug.events(500).filter((event) =>
    event.category === 'research.turn' && event.event === 'provider-resolved');
  expect(providerEvents.slice(-7)).toHaveLength(7);
  expect(providerEvents.slice(-7).map((event) => (event.data as { provider?: string }).provider))
    .toEqual(Array(7).fill('openai-codex'));
  expect(providerEvents.slice(-7).map((event) => (event.data as { xIntent?: boolean }).xIntent))
    .toEqual([false, true, false, true, false, false, false]);
});

test('a research turn sends all six Bloom axes to native search and attaches source evidence by question', async () => {
  let calls: Array<{ id: string; terms: string[] }> = [];
  const result = await runResearchQuestionLadder('Why are bond yields rising?', {
    generateContract,
    routeOutput: noOutputSkillRoute,
    generate: async (prompt) => {
      expect(prompt).toContain('Why are bond yields rising?');
      expect(prompt).toContain('Bloom exemplar examples');
      expect(prompt).toContain('L4 analyze/conceptual');
      expect(prompt).toContain('L5 evaluate/metacognitive');
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
        axes: axes.map((axis) => ({ questionId: axis.id, evidence: ['example.org', 'example.net'].map(host => ({
          questionId: axis.id, sourceKind: 'web-search:test', source: `https://${host}/${axis.id}`,
          content: `Evidence ${axis.id} from ${host}`, outcome: 'complete' as const, truncated: true,
        })) })),
      };
    },
  });

  expect(result.ok).toBe(true);
  expect(calls).toHaveLength(6);
  expect(calls).toEqual(questions.map((question) => ({ id: question.id, terms: question.searchTerms })));
  expect(result.ladder.questions).toHaveLength(6);
  expect(result.ladder.evidence).toHaveLength(12);
  expect(result.ladder.evidence[0]).toMatchObject({ questionId: 'q1', sourceKind: 'web-search:test', source: 'https://example.org/q1', outcome: 'complete' });
  expect(result.outputContract).toEqual(outputContract);
  expect(result.output).toContain('## Output contract');
  expect(result.output).toContain('Evidence');
});

test('a research wall-clock stop preserves collected axis evidence and skips output skills', async () => {
  const controller = new AbortController();
  let outputSkillCalls = 0;
  let generateCalls = 0;
  const result = await runResearchQuestionLadder('Why are bond yields rising?', {
    signal: controller.signal,
    allowPartialOnAbort: true,
    allowOutputSkill: false,
    generateContract,
    generate: async (_prompt, signal) => {
      generateCalls += 1;
      if (signal?.aborted) throw signal.reason;
      return JSON.stringify({ questions });
    },
    invokeAxes: async (axes) => {
      const partial = {
        plan: [],
        axes: axes.map((axis, index) => ({ questionId: axis.id, evidence: index === 0 ? [{
          questionId: axis.id, sourceKind: 'web-search:test', source: 'https://example.org/partial',
          content: 'Partial deadline evidence', outcome: 'complete' as const, truncated: false,
        }] : [] })),
      };
      controller.abort(new Error('budget reached'));
      return partial;
    },
    routeOutput: () => ({
      weight: 'heavy', weightSource: 'estimated', format: 'diagram',
      skillCallPlan: { skill: 'research-diagram', args: 'format evidence' },
      observation: { resultChars: 1, axisCount: 1, estimatedWeight: 'heavy', selectedSkill: 'research-diagram' },
    } as ResearchOutputRouteDecision),
    invokeOutputSkill: async () => { outputSkillCalls += 1; return { ok: true, output: 'should not run' }; },
  });

  expect(result.ok).toBe(false);
  expect(result.output).toContain('Partial deadline evidence');
  expect(result.ladder.evidence.filter(item => item.outcome === 'complete')).toHaveLength(1);
  expect(result.error).toBe('research stopped by its deadline');
  expect(generateCalls).toBe(1);
  expect(outputSkillCalls).toBe(0);
});

test('the default research deadline returns partial native evidence with the active runId', async () => {
  const runId = 'ux-research-deadline-test-run';
  const previousRunId = process.env.ELANOUS_RUN_ID;
  process.env.ELANOUS_RUN_ID = runId;
  const baseline = debug.events(500).length;
  try {
    const result = await runResearchQuestionLadder('Q2v2 HBM4 research question', {
      deadlineMs: 20,
      generateContract,
      routeOutput: noOutputSkillRoute,
      generate: async () => JSON.stringify({ questions }),
      invokeAxes: async (axes, signal) => new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve({
          plan: [],
          axes: axes.map((axis, index) => ({ questionId: axis.id, evidence: index === 0 ? [{
            questionId: axis.id,
            sourceKind: 'web-search:test',
            source: 'https://example.org/q2v2',
            content: 'Partial Q2v2 source evidence.',
            outcome: 'complete' as const,
            truncated: false,
          }] : [] })),
        }), { once: true });
      }),
    });
    const saved = debug.events(500).slice(baseline).find((event) =>
      event.category === 'research.turn' && event.event === 'retro-record-saved');

    expect(result.error).toBe('research stopped by its deadline');
    expect(result.output).toContain('Partial Q2v2 source evidence.');
    expect(result.ladder.evidence.filter((item) => item.outcome === 'complete')).toHaveLength(1);
    expect(result.ladder.evidence).toHaveLength(6);
    expect(saved?.data).toMatchObject({ runId });
  } finally {
    if (previousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
    else process.env.ELANOUS_RUN_ID = previousRunId;
  }
});

test('RESEARCH-NATIVE-NO-PREP-DEADLINE: Q2v2 completes with one preparation, native fake search, and a runId before 480s', async () => {
  const runId = 'ux-research-native-acceptance-run';
  const previousRunId = process.env.ELANOUS_RUN_ID;
  process.env.ELANOUS_RUN_ID = runId;
  let preparationCalls = 0;
  let nativeSearchCalls = 0;
  const startedAt = performance.now();
  try {
    const result = await runResearchQuestionLadder('Q2v2 HBM4 research question', {
      generatePreparation: async (prompt) => {
        preparationCalls++;
        expect(prompt).toContain('Q2v2 HBM4 research question');
        return JSON.stringify({ outputContract, questions });
      },
      invokeAxes: async (axes) => {
        nativeSearchCalls++;
        expect(axes.length).toBeGreaterThanOrEqual(3);
        return {
          plan: axes.flatMap((axis) => axis.searchTerms.map((query) => ({ questionId: axis.id, tool: 'OmniSearch' as const, query }))),
          axes: axes.map((axis) => ({ questionId: axis.id, evidence: ['example.org', 'example.net'].map((host) => ({
            questionId: axis.id,
            sourceKind: 'web-search:test',
            source: `https://${host}/${axis.id}`,
            content: `Q2v2 evidence for ${axis.id}`,
            outcome: 'complete' as const,
            truncated: false,
          })) })),
        };
      },
      routeOutput: noOutputSkillRoute,
      allowOutputSkill: false,
    });
    const elapsedMs = performance.now() - startedAt;
    const saved = debug.events(500).find((event) => event.category === 'research.turn'
      && event.event === 'retro-record-saved'
      && (event.data as { runId?: string } | undefined)?.runId === runId);

    expect(result.ok).toBe(true);
    expect(result.output.trim().length).toBeGreaterThan(0);
    expect(preparationCalls).toBe(1);
    expect(nativeSearchCalls).toBe(1);
    expect(result.ladder.evidence.every((item) => item.sourceKind === 'web-search:test')).toBe(true);
    expect(elapsedMs).toBeLessThan(480_000);
    expect(saved?.data).toMatchObject({ runId });
  } finally {
    if (previousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
    else process.env.ELANOUS_RUN_ID = previousRunId;
  }
}, 30_000);

test('a configured complete pro bank injects finance Bloom 4/5 examples into a bond-rate ladder prompt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-turn-bloom-pack-'));
  const packPath = join(directory, 'bloom-exemplars.json');
  const exemplars = BLOOM_EXEMPLAR_DOMAINS.flatMap((domain) => [1, 2, 3, 4, 5, 6].flatMap((level) => {
    const cognitive = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'][level - 1];
    const bloom = BLOOM_2D_SCOPED.find(cell => cell.cognitive === cognitive)!;
    return Array.from({ length: 5 }, (_, index) => ({
      domain, level, bloom,
      question: domain === 'finance' && level === 4
        ? `Pro finance analysis exemplar ${index + 1}`
        : domain === 'finance' && level === 5
          ? `Pro finance evaluation exemplar ${index + 1}`
          : `Fixture ${domain} level ${level} example ${index + 1}`,
    }));
  }));
  writeFileSync(packPath, JSON.stringify({ version: 1, exemplars }));
  try {
    const result = await runResearchQuestionLadder('bond yields', {
      generateContract,
      routeOutput: noOutputSkillRoute,
      bloomExemplarPackPath: packPath,
      generate: async (prompt) => {
        expect(prompt).toContain('Pro finance analysis exemplar 1');
        expect(prompt).toContain('Pro finance evaluation exemplar 1');
        expect(prompt).toContain('L4 analyze/conceptual');
        expect(prompt).toContain('L5 evaluate/metacognitive');
        return JSON.stringify({ questions });
      },
      invokeAxes: async (axes) => ({
        plan: [],
        axes: axes.map(axis => ({ questionId: axis.id, evidence: ['example.org', 'example.net'].map(host => ({
          questionId: axis.id, sourceKind: 'web-search:test', source: `https://${host}/${axis.id}`, content: 'evidence',
          outcome: 'complete' as const, truncated: false,
        })) })),
      }),
    });
    expect(result.ok).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('routes the synthesized evidence through the selected output skill and preserves axis evidence', async () => {
  let routedAxes: readonly string[] = [];
  let invoked: { skill: string; args: string } | undefined;
  const result = await runResearchQuestionLadder('Compare bond yield scenarios', {
    generateContract,
    allowOutputSkill: true,
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: ['example.org', 'example.net'].map(host => ({
        questionId: axis.id, sourceKind: 'web-search:test', source: `https://${host}/${axis.id}`,
        content: `Evidence ${axis.id} from ${host}`, outcome: 'complete' as const, truncated: false,
      })) })),
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

test('skips paid output formatting when every research axis failed', async () => {
  const startedAt = new Date().toISOString();
  let outputSkillCalls = 0;
  const result = await runResearchQuestionLadder('Analyze the latest company results', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, error: 'provider unavailable', evidence: [{
        questionId: axis.id, sourceKind: 'search-query', source: axis.searchTerms[0]!,
        content: 'provider unavailable', outcome: 'failed' as const, truncated: false,
      }] })),
    }),
    gapFollowup: async () => ({ rounds: 0, timeBudgetMs: 0, classifications: [], followups: [], followupEvidence: [] }),
    routeOutput: () => ({
      weight: 'heavy', weightSource: 'estimated', format: 'diagram',
      skillCallPlan: { skill: 'diagram-master', args: 'format failed searches' },
      observation: { resultChars: 1, axisCount: 6, estimatedWeight: 'heavy', selectedSkill: 'diagram-master' },
    }),
    invokeOutputSkill: async () => { outputSkillCalls += 1; return { ok: true, output: 'diagram' }; },
  });

  expect(result.ok).toBe(false);
  expect(result.output).toContain('provider unavailable');
  expect(result.output).not.toContain('Routed diagram output');
  expect(outputSkillCalls).toBe(0);
  expect(debug.events(500).some((event) => event.ts >= startedAt
    && event.category === 'research.turn'
    && event.event === 'output-skill-skipped'
    && (event.data as { skill?: string; reason?: string } | undefined)?.skill === 'diagram-master'
    && (event.data as { skill?: string; reason?: string } | undefined)?.reason === 'no-complete-evidence'))
    .toBe(true);
});

test('keeps raw Bloom evidence when the output router fails', async () => {
  const result = await runResearchQuestionLadder('Compare bond yield scenarios', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: ['example.org', 'example.net'].map(host => ({
        questionId: axis.id, sourceKind: 'web-search:test', source: `https://${host}/${axis.id}`,
        content: `Evidence ${axis.id} from ${host}`, outcome: 'complete' as const, truncated: false,
      })) })),
    }),
    routeOutput: () => { throw new Error('registry unavailable'); },
  });

  expect(result.ok).toBe(true);
  expect(result.ladder.evidence).toHaveLength(12);
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
      }] : ['example.org', 'example.net'].map(host => ({
        questionId: axis.id, sourceKind: 'web-search:test', source: `https://${host}/${axis.id}`,
        content: `Evidence ${axis.id} from ${host}`, outcome: 'complete' as const, truncated: false,
      })) })),
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
  expect(followupInput?.evidence).toHaveLength(11);
  expect(result.ok).toBe(false); // The skill follow-up is useful output, not a second independent publisher.
  expect(result.ladder.evidence).toHaveLength(12);
  expect(result.ladder.evidence.at(-1)).toMatchObject({ sourceKind: 'skill:omni-crawl', questionId: 'q5', outcome: 'complete' });
  expect(result.output).toContain('Bounded research gap follow-up');
  expect(result.output).toContain('Counterevidence found at a primary source.');
  expect(result.output).toContain('Plugin discovery · undo: eln plugin remove premium-data');
  expect(routedText).toContain('Counterevidence found at a primary source.');
  expect(result.output).toContain('— blank');
});

test('default gap completion searches natively instead of invoking the shell-backed omni-crawl skill', async () => {
  const axisCalls: Array<Array<{ id: string; searchTerms: string[] }>> = [];
  const result = await runResearchQuestionLadder('Why are bond yields rising?', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    allowOutputSkill: false,
    invokeAxes: async (axes) => {
      axisCalls.push(axes.map(({ id, searchTerms }) => ({ id, searchTerms })));
      const followup = axes.length === 1 && axes[0]?.id === 'q5';
      return {
        plan: [],
        axes: axes.map((axis) => {
          const complete = followup || axis.id !== 'q5';
          const publishers = complete ? ['example.org', 'example.net'] : ['example.org'];
          return {
            questionId: axis.id,
            evidence: publishers.map((publisher) => ({
              questionId: axis.id,
              sourceKind: 'web-search:test',
              source: `https://${publisher}/${axis.id}${followup ? '/followup' : ''}`,
              content: followup ? 'Counterevidence from a primary source.' : `Evidence ${axis.id}`,
              outcome: complete ? 'complete' as const : 'partial' as const,
              truncated: false,
            })),
          };
        }),
      };
    },
    planGapFollowup: () => ({
      rounds: 1,
      timeBudgetMs: 120_000,
      classifications: [{ questionId: 'q5', gap: 'missing counterevidence', action: 'auto-fill', reason: 'auto-fill-eligible', skill: 'omni-crawl' }],
      followups: [{ questionId: 'q5', skill: 'omni-crawl', query: 'bond yields counterevidence' }],
    }),
  });

  expect(axisCalls).toHaveLength(2);
  expect(axisCalls[1]).toEqual([{ id: 'q5', searchTerms: ['bond yields counterevidence'] }]);
  expect(result.ok).toBe(true);
  expect(result.ladder.evidence.find((item) => item.questionId === 'q5' && item.source.endsWith('/followup')))
    .toMatchObject({ sourceKind: 'web-search:test', outcome: 'complete' });
  expect(result.ladder.evidence.some((item) => item.sourceKind === 'skill:omni-crawl')).toBe(false);
});

test('native gap completion aborts its axis call at the plan time budget', async () => {
  let gapSignalAborted = false;
  const result = await runResearchQuestionLadder('Why are bond yields rising?', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    allowOutputSkill: false,
    invokeAxes: async (axes, signal) => {
      const followup = axes.length === 1 && axes[0]?.id === 'q5';
      if (followup) {
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
        gapSignalAborted = Boolean(signal?.aborted);
      }
      return {
        plan: [],
        axes: axes.map((axis) => ({ questionId: axis.id, evidence: [{
          questionId: axis.id,
          sourceKind: 'web-search:test',
          source: `https://example.org/${axis.id}`,
          content: `Evidence ${axis.id}`,
          outcome: followup || axis.id !== 'q5' ? 'complete' as const : 'partial' as const,
          truncated: false,
        }] })),
      };
    },
    planGapFollowup: () => ({
      rounds: 1,
      timeBudgetMs: 10,
      classifications: [{ questionId: 'q5', gap: 'missing counterevidence', action: 'auto-fill', reason: 'auto-fill-eligible', skill: 'omni-crawl' }],
      followups: [{ questionId: 'q5', skill: 'omni-crawl', query: 'bond yields counterevidence' }],
    }),
  });

  expect(gapSignalAborted).toBe(true);
  expect(result.ladder.evidence).toHaveLength(7);
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

test('skips gap discovery when its plan has no runnable auto-fill call', async () => {
  const startedAt = new Date().toISOString();
  let followupRunnerCalls = 0;
  const result = await runResearchQuestionLadder('synthetic research request', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((question) => ({ questionId: question.id, evidence: [{
        questionId: question.id, sourceKind: 'search-query', source: question.searchTerms[0]!,
        content: 'provider unavailable', outcome: 'failed' as const, truncated: false,
      }] })),
    }),
    planGapFollowup: () => ({
      rounds: 0, timeBudgetMs: 120_000,
      classifications: [{ questionId: 'q4', gap: 'no match', action: 'followup', reason: 'no-skill-match' }],
      followups: [],
    }),
    gapFollowup: async () => {
      followupRunnerCalls += 1;
      return { rounds: 0, timeBudgetMs: 120_000, classifications: [], followups: [], followupEvidence: [] };
    },
    routeOutput: noOutputSkillRoute,
  });

  expect(result.ok).toBe(false);
  expect(result.output).toContain('provider unavailable');
  expect(result.output).toContain('[followup/no-skill-match]: no match');
  expect(followupRunnerCalls).toBe(0);
  expect(debug.events(500).some((event) => event.ts >= startedAt
    && event.category === 'research.turn'
    && event.event === 'gap-followup-skipped'
    && (event.data as { reason?: string } | undefined)?.reason === 'no-runnable-followup-calls'))
    .toBe(true);
});

test('falls back to bounded gap execution when planning throws', async () => {
  let followupRunnerCalls = 0;
  const result = await runResearchQuestionLadder('synthetic research request', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((question) => ({ questionId: question.id, evidence: [{
        questionId: question.id, sourceKind: 'search-query', source: question.searchTerms[0]!,
        content: 'provider unavailable', outcome: 'failed' as const, truncated: false,
      }] })),
    }),
    planGapFollowup: () => { throw new Error('planner unavailable'); },
    gapFollowup: async () => {
      followupRunnerCalls += 1;
      return { rounds: 0, timeBudgetMs: 120_000, classifications: [], followups: [], followupEvidence: [] };
    },
    routeOutput: noOutputSkillRoute,
  });

  expect(result.ok).toBe(false);
  expect(result.output).toContain('provider unavailable');
  expect(followupRunnerCalls).toBe(1);
});

test('THINK-LENS-T1-WORKING-BACKWARDS: 원문이 대상 경로로 지목한 src/auto-research/research-turn.ts에 완료 경계 코드 행을 붙인다 — 다 차면 stop(debug.log)하고 갭 후속을 건너뛴다', async () => {
  let followupCalls = 0;
  const result = await runResearchQuestionLadder('Why are bond yields rising?', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: ['example.org', 'example.net'].map(host => ({
        questionId: axis.id, sourceKind: 'web-search:test', source: `https://${host}/${axis.id}`,
        content: `Evidence ${axis.id} from ${host}`, outcome: 'complete' as const, truncated: false,
      })) })),
    }),
    gapFollowup: async () => {
      followupCalls += 1;
      return { rounds: 0, timeBudgetMs: 120_000, classifications: [], followups: [], followupEvidence: [] };
    },
    routeOutput: noOutputSkillRoute,
  });

  expect(followupCalls).toBe(0);
  expect(result.ok).toBe(true);
  expect(result.ladder.evidence).toHaveLength(12);
  expect(result.output).toContain('## Answer skeleton (Working Backwards output contract)');
  expect(result.output).toContain('- [causes] Causes — Explain the main supported causes. — filled');
  expect(result.output).toContain('- [uncertainty] Uncertainty — State what remains unsupported. — filled');
  expect(result.output).toContain('Completion boundary: stopped — every output-contract section slot is filled.');
  const stops = debug.events(500).filter((event) => event.category === 'research.turn' && event.event === 'completion-boundary-stop');
  expect(stops.some((event) => (event.data as { stage?: string } | undefined)?.stage === 'axis-fanout')).toBe(true);
});

test('working-backwards keeps an angle open until two distinct web publishers support it', () => {
  const onePublisher = planWorkingBackwardsCompletion(outputContract, questions, [
    { questionId: 'q1', sourceKind: 'web-search:exa', source: 'https://example.org/a', content: 'a', outcome: 'complete', truncated: true },
    { questionId: 'q1', sourceKind: 'web-search:firecrawl', source: 'https://www.example.org/b', content: 'b', outcome: 'complete', truncated: true },
  ]);
  expect(onePublisher.complete).toBe(false);
  expect(onePublisher.nodePlan.some(node => node.nodeId === 'q1')).toBe(true);

  const twoPublishers = planWorkingBackwardsCompletion(outputContract, questions, [
    { questionId: 'q1', sourceKind: 'web-search:exa', source: 'https://example.org/a', content: 'a', outcome: 'complete', truncated: true },
    { questionId: 'q1', sourceKind: 'web-search:firecrawl', source: 'https://independent.example.net/b', content: 'b', outcome: 'complete', truncated: true },
  ]);
  expect(twoPublishers.nodePlan.some(node => node.nodeId === 'q1')).toBe(false);
  expect(twoPublishers.blankSlots.some(slot => slot.id === 'causes')).toBe(true);
});

test('RESEARCH-RETRO-LOOP-HOOK: 조사 런 종료 시 회고 레코드 1건 저장 ⊕ 다음 조사 턴에서 같은 주제 레코드가 1단 근거로 주입(debug.log)', async () => {
  const topic = 'Why are long-term bond yields steepening against forecasts?';
  const startedAt = new Date().toISOString();
  const eventsSince = () => debug.events(500).filter((event) => event.ts >= startedAt);
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

test('THINK-LENS-T2-SECOND-ORDER: production research turn adds a verified result chain for a decision question', async () => {
  const result = await runResearchQuestionLadder('우리 팀이 다음 분기에 세일즈포스로 전환해야 할까?', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    planGapFollowup: () => ({ rounds: 0, timeBudgetMs: 0, classifications: [], followups: [] }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: ['example.org', 'example.net'].map((host) => ({
        questionId: axis.id,
        sourceKind: 'web-search:test',
        source: `https://${host}/${axis.id}`,
        content: `Evidence for ${axis.id} from ${host}`,
        outcome: 'complete' as const,
        truncated: false,
      })) })),
    }),
    routeOutput: noOutputSkillRoute,
  });

  expect(result.ok).toBe(true);
  expect(result.ladder.evidence).toHaveLength(12);
  expect(result.output).toContain('## THINK-LENS-T2-SECOND-ORDER');
  expect(result.output).toContain('Trigger: decision');
  expect(result.output).toContain('1차 결과 (30일):');
  expect(result.output).toContain('2차 결과 (180일):');
  expect(result.output).toContain('3차 결과 (540일):');
  expect(result.output).toContain('제안된 결과 가설이며 입증된 인과가 아니다.');
});

test('THINK-LENS-T2-SECOND-ORDER: production research turn skips the result chain for an explanatory question', async () => {
  const result = await runResearchQuestionLadder('왜 장기 국채 금리가 오르고 있나?', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    planGapFollowup: () => ({ rounds: 0, timeBudgetMs: 0, classifications: [], followups: [] }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: ['example.org', 'example.net'].map((host) => ({
        questionId: axis.id,
        sourceKind: 'web-search:test',
        source: `https://${host}/${axis.id}`,
        content: `Evidence for ${axis.id} from ${host}`,
        outcome: 'complete' as const,
        truncated: false,
      })) })),
    }),
    routeOutput: noOutputSkillRoute,
  });

  expect(result.ok).toBe(true);
  expect(result.output).not.toContain('THINK-LENS-T2-SECOND-ORDER');
});

test('THINK-LENS-T2-SECOND-ORDER: production research turn accepts a host trigger classifier', async () => {
  const result = await runResearchQuestionLadder('Why are bond yields rising?', {
    generateContract,
    generate: async () => JSON.stringify({ questions }),
    planGapFollowup: () => ({ rounds: 0, timeBudgetMs: 0, classifications: [], followups: [] }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: ['example.org', 'example.net'].map((host) => ({
        questionId: axis.id,
        sourceKind: 'web-search:test',
        source: `https://${host}/${axis.id}`,
        content: `Evidence for ${axis.id} from ${host}`,
        outcome: 'complete' as const,
        truncated: false,
      })) })),
    }),
    routeOutput: noOutputSkillRoute,
    secondOrderTriggerClassifier: () => ({
      triggered: true,
      kind: 'decision',
      score: 1,
      matchedSignals: ['host-calibrated'],
      reason: 'host classifier',
    }),
  });

  expect(result.output).toContain('## THINK-LENS-T2-SECOND-ORDER');
  expect(result.output).toContain('matched: host-calibrated');
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
