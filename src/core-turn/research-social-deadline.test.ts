import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as llm from '../llm.js';
import { runResearchQuestionLadder, researchTurnForGrounding } from '../auto-research/research-turn.js';
import type { ResearchSourceUsage } from './types.js';
import { runCoreTurn } from './run-core-turn.js';
import { createResearchAxisSearcher, fanOutAxisEvidence } from '../research/axis-fanout.js';
import type { WebSearchProvider } from '../web-search/provider.js';

afterEach(() => mock.restore());

test('deadline synthesis consumes a real native axis search result with only external providers faked', async () => {
  const question = '2027년 미국 증시와 레딧 여론을 조사해 줘.';
  const redditUrl = 'https://www.reddit.com/r/stocks/comments/2027/market_outlook/';
  const webUrl = 'https://news.example/2027-market';
  const plan = JSON.stringify({
    route: { needsFreshFacts: true, needsCitations: true, localOnly: false,
      answerableWithoutWeb: false, topic: 'general', reason: 'fresh research' },
    outputContract: { deliverable: 'cited answer', format: 'short answer',
      sections: [{ id: 'facts', title: 'Facts', purpose: 'Observed signals' }],
      completionCriteria: ['cite sources'] },
    questions: Array.from({ length: 6 }, (_, index) => ({
      id: `q${index + 1}`, level: index + 1,
      prompt: index === 0 ? '2027 Reddit market sentiment' : '2027 financial outlook',
      searchTerms: [index === 0 ? '2027 US stock Reddit sentiment' : `slow market axis ${index}`],
      sectionId: 'facts',
    })),
  });
  const calls: string[] = [];
  const grok: WebSearchProvider = { id: 'grok', displayName: 'Grok', available: () => true,
    search: async () => { calls.push('grok'); return { providerName: 'grok', durationMs: 1,
      hits: [{ url: redditUrl, title: 'Retail outlook', snippet: '' }],
      note: 'Reddit search summary: AI risks worry investors, while growth hopes remain.' }; } };
  const firecrawl: WebSearchProvider = { id: 'firecrawl', displayName: 'Firecrawl', available: () => true,
    search: async ({ query }) => { calls.push(`firecrawl:${query}`);
      if (query.startsWith('slow')) return new Promise(() => undefined);
      return { providerName: 'firecrawl', durationMs: 1,
        hits: [{ url: webUrl, title: 'Market outlook', snippet: 'Growth may slow in 2027.' }] }; } };
  const search = createResearchAxisSearcher([grok, firecrawl]);
  const clock = manualTimers();
  const prompts: string[] = [];
  let sourcesReady!: () => void;
  const ready = new Promise<void>(resolve => { sourcesReady = resolve; });
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async messages => {
    const prompt = messages.map(message => String(message.content)).join('\n'); prompts.push(prompt);
    return prompt.includes('<bloom-research>')
      ? `Grok 검색 요약상 레딧 표본은 AI 위험과 성장 기대가 공존한다(대표성 미확인). ${redditUrl} ${webUrl}`
      : '레딧 여론 미확인';
  });
  let usage: ResearchSourceUsage | undefined;
  const pending = runCoreTurn({ sessionId: 'native-axis-deadline', userText: question,
    messages: [{ role: 'user', content: question }], tools: [], dispatchTool: async () => null,
    signal: new AbortController().signal,
    callbacks: { onResearchSourceUsage: value => { usage = value; } } }, {
    timers: clock.timers, researchWallClockBudgetMs: 250, researchTurnBudgetMs: 1_000, synthesisReservationMs: 0,
    researchQuestionLadderRunner: async (request, options) => researchTurnForGrounding(await runResearchQuestionLadder(request, {
      ...options, deadlineMs: 5_000, originalQuestionSearch: false, enableResearchFanout: false,
      allowOutputSkill: false, generatePreparation: async () => plan,
      social: { search: async () => ({ hits: [] }) },
      onPartialGrounding: partial => {
        options.onPartialGrounding?.(partial);
        if (partial.sourceUrls?.includes(redditUrl) && partial.sourceUrls.includes(webUrl)) sourcesReady();
      },
      invokeAxes: async (axes, signal, admit, onAxisEvidence) => fanOutAxisEvidence(axes, {
        search, signal, admitToolCall: admit, onAxisEvidence,
        fetchPage: async url => {
          if (url === redditUrl) throw new Error('reddit 403');
          return { url, output: 'News market outlook excerpt.' };
        },
      }),
    })),
  });
  try {
    await ready;
    expect(calls).toContain('grok');
    expect(calls).toContain('firecrawl:2027 US stock Reddit sentiment');
    await clock.waitFor(250);
    clock.fire(250);
    const result = await pending;
    expect(prompts.some(prompt => prompt.includes('<bloom-research>')
      && prompt.includes('Grok search-level synthesis') && prompt.includes(redditUrl) && prompt.includes(webUrl))).toBe(true);
    expect(result.finalText).toContain('레딧 표본');
    expect(result.finalText).toContain(redditUrl);
    expect(usage?.grok).toBeGreaterThan(0);
    expect(usage?.firecrawl).toBeGreaterThan(0);
  } finally { clock.cleanup(); }
});

function manualTimers() {
  const entries: Array<{ delay: number; callback: () => void; handle: ReturnType<typeof setTimeout>; cleared: boolean }> = [];
  const waiters = new Map<number, Array<() => void>>();
  return {
    timers: {
      setTimeout(callback: () => void, delay: number) {
        const entry = { delay, callback, handle: setTimeout(() => {}, 60_000), cleared: false };
        entries.push(entry);
        for (const resolve of waiters.get(delay) ?? []) resolve();
        waiters.delete(delay);
        return entry.handle;
      },
      clearTimeout(handle: ReturnType<typeof setTimeout>) {
        const entry = entries.find(item => item.handle === handle);
        if (entry) entry.cleared = true;
        clearTimeout(handle);
      },
    },
    waitFor(delay: number) {
      if (entries.some(item => item.delay === delay && !item.cleared)) return Promise.resolve();
      return new Promise<void>(resolve => waiters.set(delay, [...(waiters.get(delay) ?? []), resolve]));
    },
    has(delay: number) { return entries.some(item => item.delay === delay && !item.cleared); },
    fire(delay: number) {
      const entry = entries.find(item => item.delay === delay && !item.cleared);
      if (!entry) throw new Error(`no active ${delay}ms timer`);
      entry.callback();
    },
    size() { return entries.length; },
    async fireAfter(delay: number, priorCount: number) {
      while (true) {
        const entry = entries.find((item, index) => index >= priorCount && item.delay === delay && !item.cleared);
        if (entry) { entry.callback(); return; }
        await new Promise<void>(resolve => waiters.set(delay, [...(waiters.get(delay) ?? []), resolve]));
      }
    },
    cleanup() { for (const entry of entries) clearTimeout(entry.handle); },
  };
}

test('2027 social and web hits collected before the deadline reach answer synthesis and usage', async () => {
  const question = '2027년 국내 증시 전망과 레딧 여론은?';
  const firecrawlUrl = 'https://news.example/market-2027';
  const grokUrl = 'https://x.com/market/post/27';
  const redditUrl = 'https://www.reddit.com/r/stocks/comments/2027/market_outlook/';
  const evidence = [
    { questionId: 'q1', sourceKind: 'web-search:firecrawl', source: firecrawlUrl,
      content: '시장 전망 근거', outcome: 'complete' as const, truncated: false },
    { questionId: 'q1', sourceKind: 'web-search:grok', source: grokUrl,
      content: '시장 선행 신호', outcome: 'complete' as const, truncated: false },
  ];
  const plan = JSON.stringify({
    route: { needsFreshFacts: true, needsCitations: true, localOnly: false,
      answerableWithoutWeb: false, topic: 'general', socialQuery: '2027 Korea market Reddit X sentiment', reason: 'fresh market opinion' },
    outputContract: { deliverable: 'cited outlook', format: 'short answer',
      sections: [{ id: 'facts', title: 'Facts', purpose: 'Observed signals' }],
      completionCriteria: ['cite observed signals'] },
    questions: Array.from({ length: 6 }, (_, index) => ({
      id: `q${index + 1}`, level: index + 1, prompt: 'Market outlook and community sentiment',
      searchTerms: [`2027 Korea market outlook ${index + 1}`], sectionId: 'facts',
    })),
  });
  const prompts: string[] = [];
  const clock = manualTimers();
  let observedSources!: () => void;
  const sourcesReady = new Promise<void>(resolve => { observedSources = resolve; });
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages) => {
    const prompt = messages.map(message => String(message.content)).join('\n');
    prompts.push(prompt);
    if (prompt.includes('<bloom-research>') && prompt.includes(redditUrl)
      && prompt.includes(firecrawlUrl) && prompt.includes(grokUrl)) {
      return `레딧 표본은 조심스러운 전망이 우세하나 대표성은 미확인이다. ${redditUrl} ${firecrawlUrl} ${grokUrl}`;
    }
    return '레딧 여론 미확인';
  });
  let usage: ResearchSourceUsage | undefined;
  const pending = runCoreTurn({
    sessionId: 'social-deadline-2027', userText: question,
    messages: [{ role: 'user', content: question }],
    tools: [{ name: 'WebSearch', description: 'search', parameters: { type: 'object', properties: {} } }],
    dispatchTool: async () => null, signal: new AbortController().signal,
    callbacks: { onResearchSourceUsage: value => { usage = value; } },
  }, {
    timers: clock.timers, researchWallClockBudgetMs: 250, researchTurnBudgetMs: 1_000, synthesisReservationMs: 0,
    researchQuestionLadderRunner: async (request, options) => researchTurnForGrounding(await runResearchQuestionLadder(request, {
      ...options, deadlineMs: 5_000, generatePreparation: async () => plan,
      onPartialGrounding: partial => {
        options.onPartialGrounding?.(partial);
        if ([firecrawlUrl, grokUrl, redditUrl].every(url => partial.sourceUrls?.includes(url))) observedSources();
      },
      originalQuestionSearch: false, enableResearchFanout: false, allowOutputSkill: false,
      invokeAxes: async (_axes, signal, _admit, onAxisEvidence) => {
        onAxisEvidence?.('q1', evidence);
        // A native collector has already reported hits, but ignores cancellation during teardown.
        await new Promise<never>(() => {});
        throw new Error('unreachable');
      },
      social: { search: async ({ allow_domains }) => {
        if (allow_domains[0] !== 'reddit.com') await new Promise<never>(() => {});
        return { hits: [{
          url: redditUrl,
          title: 'community view', snippet: 'Reddit investors are cautious about 2027', engine: 'grok',
        }] };
      } },
    })),
  });
  try {
    await sourcesReady;
    await clock.waitFor(250);
    const scheduledBeforeAbort = clock.size();
    clock.fire(250);
    await clock.fireAfter(50, scheduledBeforeAbort);
    await clock.fireAfter(50, clock.size());
    const result = await pending;
  expect(prompts.some(prompt => prompt.includes('<bloom-research>') && prompt.includes(redditUrl))).toBe(true);
  expect(result.finalText).toContain('레딧 표본은 조심스러운 전망');
  expect(result.finalText).toContain(redditUrl);
  expect(usage?.firecrawl).toBeGreaterThan(0);
  expect(usage?.grok).toBeGreaterThan(0);
  } finally { clock.cleanup(); }
});

test('a plan aborted by the research budget still synthesizes completed original-question hits', async () => {
  const question = '2027년 미국 증시 전망과 레딧 여론을 출처와 함께 알려 주세요.';
  const firecrawlUrl = 'https://news.example/market-2027';
  const secondWebUrl = 'https://finance.example/market-2027';
  const grokUrl = 'https://x.com/market/post/27';
  const redditUrl = 'https://www.reddit.com/r/stocks/comments/2027/market_outlook/';
  const clock = manualTimers();
  let observedSources!: () => void;
  const sourcesReady = new Promise<void>(resolve => { observedSources = resolve; });
  const prompts: string[] = [];
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages) => {
    const prompt = messages.map(message => String(message.content)).join('\n');
    prompts.push(prompt);
    return prompt.includes('<bloom-research>') && prompt.includes(redditUrl)
      ? `레딧 투자자들은 변동성을 예상합니다. ${redditUrl} 웹 전망 ${firecrawlUrl} ${grokUrl}`
      : `레딧 여론 미확인. ${firecrawlUrl}`;
  });
  let usage: ResearchSourceUsage | undefined;
  const pending = runCoreTurn({
    sessionId: 'social-plan-aborted-2027', userText: question,
    messages: [{ role: 'user', content: question }],
    tools: [{ name: 'WebSearch', description: 'search', parameters: { type: 'object', properties: {} } }],
    dispatchTool: async () => null, signal: new AbortController().signal,
    callbacks: { onResearchSourceUsage: value => { usage = value; } },
  }, {
    timers: clock.timers, researchWallClockBudgetMs: 250, researchTurnBudgetMs: 1_000, synthesisReservationMs: 0,
    researchQuestionLadderRunner: async (request, options) => researchTurnForGrounding(await runResearchQuestionLadder(request, {
      ...options, deadlineMs: 5_000, originalQuestionSearch: true,
      enableResearchFanout: false, allowOutputSkill: false,
      onPartialGrounding: partial => {
        options.onPartialGrounding?.(partial);
        if ([firecrawlUrl, grokUrl, redditUrl].every(url => partial.sourceUrls?.includes(url))) observedSources();
      },
      generatePreparation: async (_prompt, signal) => new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) reject(new Error('research budget reached'));
        else signal?.addEventListener('abort', () => reject(new Error('research budget reached')), { once: true });
      }),
      invokeAxes: async (axes, signal, _admit, onAxisEvidence) => {
        const questionId = axes[0]!.id;
        onAxisEvidence?.(questionId, [
          { questionId, sourceKind: 'web-search:firecrawl', source: firecrawlUrl,
            content: '2027 market outlook', outcome: 'complete', truncated: false },
          { questionId, sourceKind: 'web-search:firecrawl', source: secondWebUrl,
            content: '2027 market risk', outcome: 'complete', truncated: false },
          { questionId, sourceKind: 'web-search:grok', source: grokUrl,
            content: '2027 market signal', outcome: 'complete', truncated: false },
          { questionId, sourceKind: 'social-search:reddit:grok', source: redditUrl,
            content: 'Reddit investors expect volatility', outcome: 'complete', truncated: false },
        ]);
        await new Promise<never>((_resolve, reject) => {
          if (signal?.aborted) reject(new Error('research budget reached'));
          else signal?.addEventListener('abort', () => reject(new Error('research budget reached')), { once: true });
        });
        throw new Error('unreachable');
      },
    })),
  });
  try {
    await sourcesReady;
    await clock.waitFor(250);
    clock.fire(250);
    // The plan returns its incomplete result during the abort grace window, as in the measured turn.
    for (let index = 0; index < 5; index += 1) await new Promise<void>(resolve => setImmediate(resolve));
    if (clock.has(50)) clock.fire(50);
    const result = await pending;
    expect(prompts.some(prompt => prompt.includes('<bloom-research>') && prompt.includes(redditUrl))).toBe(true);
    const synthesisPrompt = prompts.find(prompt => prompt.includes('<bloom-research>'));
    expect(synthesisPrompt).toContain('Reddit sample summary');
    expect(synthesisPrompt).toContain('at least 3');
    expect(synthesisPrompt).toContain('social-search-snippets');
    expect(synthesisPrompt).toContain('Reddit investors expect volatility');
    expect(result.finalText).toContain('레딧 투자자들은 변동성을 예상');
    expect(result.finalText).toContain(redditUrl);
    expect(usage?.firecrawl).toBeGreaterThan(0);
    expect(usage?.grok).toBeGreaterThan(0);
  } finally { clock.cleanup(); }
});
