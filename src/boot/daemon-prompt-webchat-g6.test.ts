import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as llm from '../llm.js';
import * as researchTurn from '../auto-research/research-turn.js';
import { createEodhdDeclarations } from '../graph-runner/capability-providers/market-data/eodhd.js';
import { marketDataRegistry } from '../graph-runner/capability-providers/market-data/registry.js';
import { DaemonSessionHistory } from './daemon-runtime.js';
import type { DaemonToolSurface } from './daemon-tools/types.js';
import { handlePromptStreamPost } from '../nexus/api/meta-api.js';
import { DaemonClient } from '../../apps/pwa/src/lib/daemon-client.js';
import { runChatTurnStreaming } from '../../apps/pwa/src/lib/chat-runtime.js';
import { classifyShortQuestion } from '../core-turn/short-question.js';

const QUESTIONS = [
  '2027년 국내 증시 전망은?',
  '내일 한국 반도체 장을 미국 쪽에서 미리 볼 신호는?',
  '한국 반도체 섹터와 미국 ETF 연결 근거는?',
];
const outputContract = { deliverable: 'sourced signals', format: 'short answer',
  sections: [{ id: 'facts', title: 'Facts', purpose: 'Supported signals' }],
  completionCriteria: ['Only cite observed evidence'] };
const questions = Array.from({ length: 6 }, (_, index) => ({ id: `q${index + 1}`, level: index + 1,
  prompt: `Question ${index + 1}`, searchTerms: [`market term ${index + 1}`], sectionId: 'facts' }));
const plan = JSON.stringify({ route: { needsFreshFacts: true, needsCitations: true, localOnly: false,
  answerableWithoutWeb: false, topic: 'market', symbols: ['069500', '005930', '000660', 'SPY', 'SOXX'],
  reason: 'market signal' }, outputContract, questions });

const toolSurface: DaemonToolSurface = { kind: 'chat', specs: [
  { name: 'WebSearch', description: 'search', parameters: { type: 'object', properties: {} } },
], dispatch: async () => ({ ok: true }) };

afterEach(() => { mock.restore(); });

test('short market and simple questions share the existing short classifier; web capability keeps the planner reachable', () => {
  for (const question of QUESTIONS) expect(classifyShortQuestion(question).fast).toBe(true);
  expect(classifyShortQuestion('내일은 무슨 요일?').fast).toBe(true);
  expect(classifyShortQuestion('ETF 뜻은?').fast).toBe(true);
});

test('three market question shapes with missing planner socialQuery reach PWA through core-turn, daemon and nexus', async () => {
  const previousFetch = globalThis.fetch;
  const actualResearch = researchTurn.runResearchQuestionLadder;
  const socialCalls: string[] = [];
  const packCalls: string[] = [];
  const marketCalls: string[] = [];
  let axisCalls = 0;
  let ladderResult: Awaited<ReturnType<typeof actualResearch>> | undefined;
  const researchSpy = spyOn(researchTurn, 'runResearchQuestionLadder').mockImplementation(async (request, options) => {
    ladderResult = await actualResearch(request, {
    ...options,
    originalQuestionSearch: false,
    generatePreparation: async () => request.includes('요일') ? JSON.stringify({
      ...JSON.parse(plan), route: { needsFreshFacts: false, needsCitations: false, localOnly: false,
        answerableWithoutWeb: true, reason: 'clock' },
    }) : plan,
    invokeAxes: async (axes) => {
      axisCalls += 1;
      return {
      plan: axes.flatMap((axis) => axis.searchTerms.map((query) => ({ questionId: axis.id, tool: 'OmniSearch' as const, query }))),
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: ['news.example', 'second.example'].map((host) => ({ questionId: axis.id,
        sourceKind: 'web-search:firecrawl', source: `https://${host}/${axis.id}`,
        content: 'Korean market context', outcome: 'complete' as const, truncated: false })) })),
      };
    },
    marketData: { registry: marketDataRegistry(createEodhdDeclarations({
      lookupSecret: async () => 'fixture-key',
      fetcher: async (url) => {
        marketCalls.push(url);
        if (new URL(url).pathname.includes('/real-time/')) return { ok: true, json: async () => ({
          code: decodeURIComponent(new URL(url).pathname.split('/').pop()!), timestamp: 1_795_243_000, close: 251.4,
        }) };
        return { ok: true, json: async () => [{ date: '2026-11-20', open: 250, high: 252, low: 249, close: 251.4, volume: 1234 }] };
      },
    })), now: () => Date.UTC(2026, 10, 21, 6, 41, 0) },
    social: {
      search: async ({ allow_domains }) => {
        socialCalls.push(allow_domains[0]!);
        return { hits: [{ url: `https://${allow_domains[0]}/post/1`, title: 'overnight signal',
          snippet: allow_domains[0] === 'reddit.com' ? '레딧 투자자 표본은 신중한 전망' : 'search excerpt', engine: 'grok' }] };
      },
      fetchPost: async (url) => ({ url, body: 'Full X post body about overnight semiconductor signals.' }),
    },
    knowledgePack: { query: async ({ pack_id }) => {
      packCalls.push(pack_id);
      return { pack_hits: [{ id: 'sector', title: 'Korea US sector map', body: 'SOXX links to Korean semiconductors',
        ref: `${pack_id}#sector` }] };
    } },
    enableResearchFanout: false,
    allowOutputSkill: false,
    });
    return ladderResult;
  });
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages) => {
    const context = messages.map((message) => String(message.content)).join('\n');
    if (context.includes('Full X post body about overnight semiconductor signals.')
      && context.includes('eodhd:market.quote@1:SPY')
      && context.includes('pack:conatus-solution@0.1.0#sector')) {
      if (context.includes(QUESTIONS[0]) && context.includes('레딧 투자자 표본은 신중한 전망')
        && context.includes('https://news.example/q1')) {
        return '2027년 레딧 표본은 신중한 전망이며 대표성은 미확인이다. '
          + 'https://reddit.com/post/1 https://news.example/q1 https://x.com/post/1 eodhd:market.quote@1:SPY';
      }
      return '미국 선행 신호: eodhd:market.quote@1:SPY 및 SOXX 시세, 코나투스 섹터 지도, X 게시물 본문. https://x.com/post/1';
    }
    return '연구 근거 대기';
  });
  let nexusRequests = 0;
  globalThis.fetch = (async (input, init) => {
    nexusRequests += 1;
    return handlePromptStreamPost(new Request(String(input), init), {
      noAuth: true, history: new DaemonSessionHistory(), toolSurface, toolCwd: process.cwd(),
    });
  }) as typeof fetch;
  try {
    const client = new DaemonClient({ baseUrl: 'http://localhost:31415', token: 'fixture', provider: 'anthropic' });
    for (const [index, question] of QUESTIONS.entries()) {
      const { message } = await runChatTurnStreaming(question, {
        client, sessionId: `webchat-g6-${index}`, provider: 'anthropic', setSessionId: () => {},
      });
      expect(researchSpy).toHaveBeenCalledTimes(index + 1);
      expect(socialCalls.slice(index * 2)).toEqual(['x.com', 'reddit.com']);
      expect(packCalls[index]).toBe('pack:conatus-solution@0.1.0');
      expect(marketCalls.length).toBeGreaterThan(0);
      expect(ladderResult?.error).toBeUndefined();
      expect(ladderResult?.output).toContain('Full X post body about overnight semiconductor signals.');
      expect(ladderResult?.ladder.evidence.filter((item) => item.sourceKind.startsWith('market-data:')).map((item) => item.source))
        .toContain('eodhd:market.quote@1:SPY');
      expect(ladderResult?.output).toContain('pack:conatus-solution@0.1.0#sector');
      expect(message.text).toContain('https://x.com/post/1');
      expect(message.text).toContain('SPY');
      if (index === 0) {
        expect(message.text).toContain('레딧 표본은 신중한 전망');
        expect(message.text).toContain('https://reddit.com/post/1');
        expect(message.sourceUsage?.grok).toBe(2);
        expect(message.sourceUsage?.firecrawl).toBeGreaterThan(0);
      } else {
        // Reddit was collected, but this answer cited only X.
        expect(message.sourceUsage?.grok).toBe(1);
        expect(message.sourceUsage?.firecrawl ?? 0).toBe(0);
      }
      expect(message.sourceUsage?.market).toBeGreaterThan(0);
      expect(nexusRequests).toBe(index + 1);
    }
    const marketCallCount = marketCalls.length;
    await runChatTurnStreaming('내일은 무슨 요일?', {
      client, sessionId: 'webchat-g6-clock', provider: 'anthropic', setSessionId: () => {},
    });
    expect(researchSpy).toHaveBeenCalledTimes(4);
    expect(axisCalls).toBe(3);
    expect(socialCalls).toHaveLength(6);
    expect(packCalls).toHaveLength(3);
    expect(marketCalls).toHaveLength(marketCallCount);
    expect(nexusRequests).toBe(4);
  } finally { globalThis.fetch = previousFetch; }
});
