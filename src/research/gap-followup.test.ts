import { expect, test } from 'bun:test';
import type { BloomResearchQuestion, ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import type { MarketIndex } from '../plugins/install/market-fetch.js';
import { planGapFollowup, runGapFollowup } from './gap-followup.js';
import { discoverResearchPlugin } from './plugin-discovery.js';

const questions: BloomResearchQuestion[] = [
  { id: 'q4', level: 4, prompt: 'Which evidence is missing?', searchTerms: ['missing evidence'] },
  { id: 'q5', level: 5, prompt: 'Evaluate the missing evidence', searchTerms: ['evaluate evidence'] },
  { id: 'q3', level: 3, prompt: 'Explain the evidence', searchTerms: ['explain evidence'] },
];

function evidence(questionId: string, content: string, outcome: ResearchEvidenceEnvelope['outcome'] = 'complete'): ResearchEvidenceEnvelope {
  return { questionId, sourceKind: 'web-search:test', source: `https://example.test/${questionId}`, content, outcome, truncated: true };
}

test('plans at most one safe follow-up round from Bloom 4/5 gaps using registry matches', () => {
  const plan = planGapFollowup({
    request: 'Review Korean bond supply and DXY',
    questions,
    evidence: [
      evidence('q4', 'No Korean Treasury supply data was found; needs additional data.'),
      evidence('q5', 'DXY series is unavailable in this result.'),
      evidence('q3', 'No data was found for this explanation.'),
    ],
    remainingBudgetMs: 180_000,
    skills: [
      { name: 'kr-flow', description: 'Korean bond investor flow and treasury supply', triggers: ['Korean bond supply', 'Treasury supply'], extractedTriggers: [], triggerSource: 'explicit', autoTrigger: true, sideEffects: 'none', cost: 'light', composes: [], skillDir: '/skills/kr-flow', rootDir: '/skills' },
      { name: 'omni-crawl', description: 'Search public web documents and data', triggers: ['DXY series', 'web search'], extractedTriggers: [], triggerSource: 'explicit', autoTrigger: true, sideEffects: 'none', cost: 'light', composes: [], skillDir: '/skills/omni-crawl', rootDir: '/skills' },
    ],
  });

  expect(plan.rounds).toBe(1);
  expect(plan.classifications.map((item) => item.action)).toEqual(['auto-fill', 'auto-fill']);
  expect(plan.classifications.map((item) => item.skill)).toEqual(['kr-flow', 'omni-crawl']);
  expect(plan.followups).toHaveLength(2);
  expect(plan.classifications.some((item) => item.questionId === 'q3')).toBe(false);
});

test('classifies Bloom 4/5 questions with no evidence envelope as missing gaps', () => {
  const plan = planGapFollowup({
    request: 'Find the DXY series',
    questions: [{ id: 'q5', level: 5, prompt: 'DXY series', searchTerms: ['DXY'] }],
    evidence: [],
    skills: [{ name: 'omni-crawl', description: 'search web', triggers: ['DXY series'], extractedTriggers: [], triggerSource: 'explicit', autoTrigger: true, sideEffects: 'none', cost: 'light', composes: [], skillDir: '/', rootDir: '/' }],
  });

  expect(plan.rounds).toBe(1);
  expect(plan.classifications).toEqual([{
    questionId: 'q5', gap: 'DXY series', action: 'auto-fill', reason: 'auto-fill-eligible', skill: 'omni-crawl',
  }]);
});

test('keeps write-capable and unlisted skills as follow-up', () => {
  const skills = [
    { name: 'kr-flow', description: 'Korean bond supply', triggers: ['Korean bond supply'], extractedTriggers: [], triggerSource: 'explicit' as const, autoTrigger: true, sideEffects: 'write' as const, composes: [], skillDir: '/kr-flow', rootDir: '/' },
    { name: 'custom-search', description: 'DXY series', triggers: ['DXY series'], extractedTriggers: [], triggerSource: 'explicit' as const, autoTrigger: true, sideEffects: 'none' as const, cost: 'light' as const, composes: [], skillDir: '/custom-search', rootDir: '/' },
  ];
  const plan = planGapFollowup({
    request: 'Korean bond supply and DXY series',
    questions,
    evidence: [evidence('q4', 'Korean bond supply unavailable.'), evidence('q5', 'DXY series missing.')],
    remainingBudgetMs: 20_000,
    skills,
  });

  expect(plan.rounds).toBe(0);
  expect(plan.classifications).toHaveLength(2);
  expect(plan.classifications.every((item) => item.action === 'followup')).toBe(true);
  expect(plan.classifications.map((item) => item.reason)).toEqual(['skill-not-read-only', 'skill-not-allowlisted']);
  expect(plan.followups).toEqual([]);
});

test('fails closed when an allowlisted skill has no side-effect declaration', () => {
  const plan = planGapFollowup({
    request: 'Find the DXY series',
    questions: [{ id: 'q5', level: 5, prompt: 'DXY series', searchTerms: ['DXY'] }],
    evidence: [evidence('q5', 'DXY series missing.')],
    skills: [{ name: 'omni-crawl', description: 'web search', triggers: ['DXY series'], extractedTriggers: [], triggerSource: 'explicit', autoTrigger: true, composes: [], skillDir: '/', rootDir: '/' }],
  });

  expect(plan.rounds).toBe(0);
  expect(plan.followups).toEqual([]);
  expect(plan.classifications[0]?.reason).toBe('skill-not-read-only');
});

test('does not auto-fill when the one-round cap is already consumed or time is exhausted', () => {
  const exhausted = planGapFollowup({
    request: 'DXY', questions, evidence: [evidence('q5', 'DXY data missing.')],
    remainingBudgetMs: 90_000, roundsUsed: 1,
    skills: [{ name: 'omni-crawl', description: 'web search', triggers: ['DXY'], extractedTriggers: [], triggerSource: 'explicit', autoTrigger: true, sideEffects: 'none', cost: 'light', composes: [], skillDir: '/', rootDir: '/' }],
  });
  expect(exhausted.classifications[0]?.reason).toBe('round-limit');
  expect(exhausted.followups).toHaveLength(0);

  const noTime = planGapFollowup({
    request: 'DXY', questions, evidence: [evidence('q5', 'DXY data missing.')], remainingBudgetMs: 0,
    skills: [{ name: 'omni-crawl', description: 'web search', triggers: ['DXY'], extractedTriggers: [], triggerSource: 'explicit', autoTrigger: true, sideEffects: 'none', cost: 'light', composes: [], skillDir: '/', rootDir: '/' }],
  });
  expect(noTime.classifications[0]?.reason).toBe('time-budget');
});

test('executes each eligible gap once in one bounded round and returns evidence by axis', async () => {
  const called: string[] = [];
  const result = await runGapFollowup({
    request: 'Review Korean bond supply and DXY',
    questions,
    evidence: [evidence('q4', 'No Korean Treasury supply data was found.'), evidence('q5', 'DXY series unavailable.')],
    remainingBudgetMs: 120_000,
    skills: [
      { name: 'kr-flow', description: 'Korean bond flow', triggers: ['Korean Treasury supply'], extractedTriggers: [], triggerSource: 'explicit', autoTrigger: true, sideEffects: 'none', composes: [], skillDir: '/', rootDir: '/' },
      { name: 'omni-crawl', description: 'DXY series', triggers: ['DXY series'], extractedTriggers: [], triggerSource: 'explicit', autoTrigger: true, sideEffects: 'none', composes: [], skillDir: '/', rootDir: '/' },
    ],
  }, {
    runSkill: async (skill, query, signal) => {
      expect(signal.aborted).toBe(false);
      called.push(skill);
      return { ok: true, output: `Sources for ${skill}: ${query}` };
    },
  });

  expect(called.sort()).toEqual(['kr-flow', 'omni-crawl']);
  expect(result.rounds).toBe(1);
  expect(result.followupEvidence).toHaveLength(2);
  expect(result.followupEvidence.every((item) => item.outcome === 'complete')).toBe(true);
  expect(result.followupEvidence.map((item) => item.questionId).sort()).toEqual(['q4', 'q5']);
});

test('aborts an automatic follow-up at its time limit and records failed evidence', async () => {
  const result = await runGapFollowup({
    request: 'DXY', questions,
    evidence: [evidence('q5', 'DXY data missing.')], remainingBudgetMs: 10,
    skills: [{ name: 'omni-crawl', description: 'web search', triggers: ['DXY'], extractedTriggers: [], triggerSource: 'explicit', autoTrigger: true, sideEffects: 'none', composes: [], skillDir: '/', rootDir: '/' }],
  }, {
    runSkill: async (_skill, _query, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });

  expect(result.rounds).toBe(1);
  expect(result.followupEvidence[0]?.outcome).toBe('failed');
  expect(result.followupEvidence[0]?.content).toContain('time budget');
});

test('no local skill match produces a plugin discovery card for the research turn', async () => {
  const result = await runGapFollowup({
    request: 'period premium data',
    questions: [{ id: 'q5', level: 5, prompt: 'period premium data', searchTerms: ['premium'] }],
    evidence: [], skills: [],
  }, {
    discoverPlugin: async (gap) => ({ gap, candidates: [], outcome: 'create-suggestion',
      card: 'Plugin discovery · period premium data', }),
  });
  expect(result.classifications[0]?.reason).toBe('no-skill-match');
  expect(result.discoveryCards).toEqual(['Plugin discovery · period premium data']);
});

test('a trusted installed read-only plugin is queried once and contributes evidence to the same gap', async () => {
  const reruns: string[] = [];
  const result = await runGapFollowup({
    request: 'period premium data',
    questions: [{ id: 'q5', level: 5, prompt: 'period premium data', searchTerms: ['premium'] }],
    evidence: [], skills: [],
  }, {
    discoverPlugin: async (gap) => ({ gap, candidates: [], outcome: 'installed',
      installed: { name: 'premium-data', path: '/isolated/premium-data', notice: 'read-only', undo: 'eln plugin remove premium-data' },
      card: 'Installed premium-data. Undo: eln plugin remove premium-data' }),
    rerunInstalled: async (gap, _installed, signal) => {
      expect(signal.aborted).toBe(false);
      reruns.push(gap);
      return { ok: true, output: 'Period premium source and value' };
    },
  });
  expect(reruns).toEqual(['period premium data']);
  expect(result.discoveryCards?.[0]).toContain('Undo: eln plugin remove premium-data');
  expect(result.followupEvidence).toEqual([expect.objectContaining({
    questionId: 'q5', sourceKind: 'plugin:premium-data', outcome: 'complete',
    content: 'Period premium source and value',
  })]);
});

test('the research gap entrypoint installs one verified premium data package and only proposes an unverified link', async () => {
  const input = {
    request: 'period premium data',
    questions: [{ id: 'q5', level: 5 as const, prompt: 'period premium data', searchTerms: ['premium'] }],
    evidence: [], skills: [],
  };
  const market: MarketIndex = {
    market: { name: 'elanous', url: 'https://example.test/signed/' }, signature: 'ok',
    index: { name: 'elanous', interface: { displayName: 'Elanous' }, sequence: 1, plugins: [{
      name: 'premium-data', version: '1.0.0', description: 'period premium data series',
      source: { source: 'local' }, artifact: { key: 'premium.tgz', sha256: 'a'.repeat(64), bytes: 1 },
      'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } },
    }] },
    directory: '/isolated/signed-market', keyId: '12345678',
  };
  const installs: string[] = [];
  const installed = await runGapFollowup(input, {
    discoverPlugin: (gap, options) => discoverResearchPlugin(gap, {
      ...options, market: async () => market, search: async () => [],
      install: async (spec) => {
        installs.push(spec);
        return { name: 'premium-data', version: '1.0.0', market: 'elanous', path: '/isolated/premium-data', sha256: 'a'.repeat(64) };
      },
    }),
    rerunInstalled: async () => ({ ok: true, output: 'period premium data series for the requested window' }),
  });
  expect(installs).toEqual(['premium-data@elanous']);
  expect(installed.discoveryCards).toHaveLength(1);
  expect(installed.discoveryCards?.[0]).toContain('Installed premium-data');
  expect(installed.discoveryCards?.[0]).toContain('Undo: eln plugin remove premium-data');
  expect(installed.followupEvidence).toEqual([expect.objectContaining({
    questionId: 'q5', sourceKind: 'plugin:premium-data', outcome: 'complete',
    content: 'period premium data series for the requested window',
  })]);

  const unverifiedInstalls: string[] = [];
  const proposed = await runGapFollowup(input, {
    discoverPlugin: (gap, options) => discoverResearchPlugin(gap, {
      ...options, market: async () => { throw new Error('offline'); },
      search: async () => [{ url: 'https://example.test/premium', title: 'premium data',
        snippet: 'period premium data series', source: 'web' }],
      install: async (spec) => {
        unverifiedInstalls.push(spec);
        throw new Error('unverified link must not install');
      },
    }),
  });
  expect(unverifiedInstalls).toEqual([]);
  expect(proposed.discoveryCards).toHaveLength(1);
  expect(proposed.discoveryCards?.[0]).toContain('proposal only');
  expect(proposed.followupEvidence).toEqual([]);
});
