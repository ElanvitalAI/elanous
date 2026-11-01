import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import type { BloomResearchQuestion } from './question-ladder-contract.js';
import * as llmModule from '../llm.js';
import * as researchBridgeModule from '../research-bridge/index.js';
import * as outputRouterModule from '../research/output-router.js';
import * as agentToolsModule from '../skills/tools/agent.js';
import * as omniSearchModule from '../skills/tools/omni-search.js';

const originalLlmModule = { ...llmModule };
const originalResearchBridgeModule = { ...researchBridgeModule };
const originalOutputRouterModule = { ...outputRouterModule };
const originalAgentToolsModule = { ...agentToolsModule };
const originalOmniSearchModule = { ...omniSearchModule };
const realRouteResearchOutput = outputRouterModule.routeResearchOutput;
let preparationCalls = 0;
let agentCalls: string[] = [];
let searchCalls = 0;

mock.module('../llm.js', () => ({
  streamLLM: async (messages: Array<{ content: string }>) => {
    const prompt = messages.map(message => message.content).join('\n');
    if (prompt.includes('single preparation call')) {
      preparationCalls += 1;
      return JSON.stringify({
        outputContract: {
          deliverable: 'Default research memo',
          format: 'Short memo',
          sections: [{ id: 'findings', title: 'Findings', purpose: 'Summarize supported findings.' }],
          completionCriteria: ['Every finding is supported or marked uncertain.'],
        },
        questions: Array.from({ length: 6 }, (_, index) => ({
          id: `default-q${index + 1}`,
          level: index + 1,
          prompt: `default question ${index + 1}`,
          searchTerms: [`default term ${index + 1}`],
          sectionId: 'findings',
        })),
      });
    }
    if (prompt.includes('Work backwards from the result')) {
      return JSON.stringify({
        deliverable: 'Default research memo',
        format: 'Short memo',
        sections: [{ id: 'findings', title: 'Findings', purpose: 'Summarize supported findings.' }],
        completionCriteria: ['Every finding is supported or marked uncertain.'],
      });
    }
    const sectionAssignment = prompt.match(/sectionId from: (.+?)\.\nUse each sectionId/);
    const sectionIds = sectionAssignment?.[1].split(', ').map((id) => id.trim());
    return JSON.stringify({ questions: Array.from({ length: 6 }, (_, index) => ({
      id: `default-q${index + 1}`,
      level: index + 1,
      prompt: `default question ${index + 1}`,
      searchTerms: [`default term ${index + 1}`],
      ...(sectionIds?.length ? { sectionId: sectionIds[index % sectionIds.length] } : {}),
    })) });
  },
}));

let axisCalls = 0;
mock.module('../research-bridge/index.js', () => ({
  invokeResearchAxes: async (questions: readonly BloomResearchQuestion[]) => {
    axisCalls += 1;
    return {
      plan: [],
        axes: questions.map((question) => ({ questionId: question.id, evidence: ['example.org', 'example.net'].map((host) => ({
          questionId: question.id,
          sourceKind: 'web-search:test',
          source: `https://${host}/${question.id}`,
          content: `source for ${question.id} from ${host}`,
          outcome: 'complete' as const,
          truncated: true,
        })) })),
    };
  },
}));

mock.module('../skills/tools/agent.js', () => ({
  dispatchAgent: async (args: Record<string, unknown>, opts: {
    hostTools?: Array<{ name: string }>;
    dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  }) => {
    const prompt = String(args.prompt ?? '');
    agentCalls.push(prompt);
    expect(opts.hostTools?.map(({ name }) => name)).toEqual(['OmniSearch']);
    const search = await opts.dispatchTool?.('OmniSearch', { query: prompt });
    if (prompt.includes('뉴스·공시')) {
      return { output: `Fabricated claim [unqueried](https://unqueried.example/fake)\n${String(search ?? '')}` };
    }
    if (prompt.includes('반대 근거')) {
      const citation = String(search ?? '').match(/\[[^\]]+\]\(https?:\/\/[^\s)]+\)/)?.[0] ?? '';
      return { output: `- Claim one ${citation}\n- Claim two ${citation}\n${String(search ?? '')}` };
    }
    return { output: `- Finding with date 2026-11-01 and denominator four. ${String(search ?? '')}` };
  },
}));

mock.module('../skills/tools/omni-search.js', () => ({
  buildOmniSearchTool: () => ({ name: 'OmniSearch' }),
  dispatchResearchOmniSearch: async (_args: Record<string, unknown>, opts?: {
    onSource?: (source: { url: string; title: string; snippet: string; engine: string }) => void;
  }) => {
    searchCalls += 1;
    const source = { url: `https://official.example/source-${searchCalls}`, title: `Official ${searchCalls}`, snippet: 'fixture', engine: 'exa' };
    opts?.onSource?.(source);
    return { output: `- [${source.title}](${source.url})`, metadata: { perEngine: {}, totalHits: 1, merge: 'interleave' } };
  },
}));

// Keep this test focused on the default LLM and native search seams; output-skill execution is external.
mock.module('../research/output-router.js', () => ({
  ...originalOutputRouterModule,
  routeResearchOutput: (input: Parameters<typeof outputRouterModule.routeResearchOutput>[0]) =>
    realRouteResearchOutput({ ...input, skills: [] }),
}));

afterAll(() => {
  mock.module('../llm.js', () => originalLlmModule);
  mock.module('../research-bridge/index.js', () => originalResearchBridgeModule);
  mock.module('../research/output-router.js', () => originalOutputRouterModule);
  mock.module('../skills/tools/agent.js', () => originalAgentToolsModule);
  mock.module('../skills/tools/omni-search.js', () => originalOmniSearchModule);
});

let runResearchQuestionLadder: typeof import('./research-turn.js').runResearchQuestionLadder;
beforeAll(async () => {
  ({ runResearchQuestionLadder } = await import('./research-turn.js'));
}, 60_000);

test('the production no-options call uses the default generator and native axis bridge', async () => {
  preparationCalls = 0;
  agentCalls = [];
  searchCalls = 0;
  const result = await runResearchQuestionLadder('a research topic');

  expect(result.ok).toBe(true);
  expect(preparationCalls).toBe(1);
  expect(axisCalls).toBe(1);
  expect(result.ladder.questions).toHaveLength(6);
  expect(result.ladder.evidence).toHaveLength(12);
  expect(result.output).toContain('https://example.org/default-q1');
  expect(agentCalls).toHaveLength(3);
  expect(agentCalls.some((prompt) => prompt.includes('1차 데이터'))).toBe(true);
  expect(agentCalls.some((prompt) => prompt.includes('뉴스·공시'))).toBe(true);
  expect(agentCalls.some((prompt) => prompt.includes('반대 근거'))).toBe(true);
  expect(searchCalls).toBe(3);
  expect(result.output).toContain('https://official.example/source-1');
  expect(result.output).toContain('https://official.example/source-3');
  expect(result.output).not.toContain('Fabricated claim');
  expect(result.output).not.toContain('Claim one');
  expect(result.output).toContain('보류(근거 부족)');
});
