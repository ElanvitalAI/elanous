import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import * as llm from '../llm.js';
import * as surfaces from '../session-runtime/index.js';
import * as deferred from '../session-runtime/tier-flip.js';
import { runCoreTurn } from './run-core-turn.js';
import { needsGroundingFirst, GROUNDING_UNAVAILABLE, GROUNDING_PARTIAL } from './grounding-first.js';

beforeEach(() => {
  spyOn(surfaces, 'resolveSessionSurfaceProfile').mockReturnValue({
    id: 'chat', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  } as unknown as ReturnType<typeof surfaces.resolveSessionSurfaceProfile>);
  spyOn(deferred, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages], tools: [...tools], stats: { activeCount: tools.length, deferredCount: 0,
      warmPreloaded: [], injected: false, deferredNames: [], unhydratableNames: [], unhydratableCount: 0 },
  } as unknown as ReturnType<typeof deferred.applyDeferredTools>));
});
afterEach(() => mock.restore());

const request = '내년(2027) 미국·한국 주식 전망은 어때?';
const evidence = { ok: true, output: 'Observed market evidence from official sources.', sourceUrls: ['https://example.org/observed'] };
const context = (text: string, signal = new AbortController().signal) => ({
  sessionId: 'grounding-first-synthetic', messages: [{ role: 'user' as const, content: text }],
  userText: text, tools: [], dispatchTool: async () => null, signal,
});

test('timely policy selects current events and market horizons without taking coding or stable knowledge', () => {
  for (const text of [request, '삼성전자 실적 발표와 양산 일정 지연을 최근 원문으로 설명해줘', '11~12월 미국·한국 주식 전망은 어때?', '젠슨황 스캔들 최근 소식은 뭐야?', 'What is the latest election news?', 'Stock market outlook next year?']) {
    expect(needsGroundingFirst(text)).toBe(true);
  }
  for (const text of ['주식이란 무엇인가?', 'compare bond yields', '최신 버전으로 앱을 만들어서 배포해줘', 'Explain binary search']) {
    expect(needsGroundingFirst(text)).toBe(false);
  }
});

test('a timely factual answer cannot stream or invoke the model before external evidence settles', async () => {
  let resolveResearch!: (result: typeof evidence) => void;
  let started!: () => void;
  const researchStarted = new Promise<void>(resolve => { started = resolve; });
  const visible: string[] = [];
  let modelCalls = 0;
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    modelCalls++;
    expect(messages.some(message => typeof message.content === 'string' && message.content.includes(evidence.output))).toBe(true);
    handlers.onText('Evidence-based outlook.', 'Evidence-based outlook.');
    return 'Evidence-based outlook.';
  });
  const pending = runCoreTurn({ ...context(request), callbacks: { onText: (_delta, full) => visible.push(full) } }, {
    runResearch: () => { started(); return new Promise(resolve => { resolveResearch = resolve; }); },
  });
  await researchStarted;
  await Promise.resolve();
  expect(modelCalls).toBe(0);
  expect(visible).toEqual([]);
  resolveResearch(evidence);
  const result = await pending;
  expect(modelCalls).toBe(1);
  expect(result.finalText).toContain(evidence.sourceUrls[0]);
  expect(result.finalText).not.toContain(GROUNDING_UNAVAILABLE);
});

for (const sample of [
  { ok: false, output: '', error: 'no search provider' },
  { ok: true, output: 'uncited model text', sourceUrls: [] },
  { ok: true, output: 'bad citation', sourceUrls: ['javascript:alert(1)'] },
]) test('missing citable evidence returns an explicit unavailable answer: ' + sample.output, async () => {
  const model = spyOn(llm, 'streamLLMWithTools').mockResolvedValue('unverified claim');
  const visible: string[] = [];
  const response = await runCoreTurn({ ...context(request), callbacks: { onText: (_delta, full) => visible.push(full) } }, {
    runResearch: async () => sample,
  });
  expect(model).not.toHaveBeenCalled();
  expect(response.finalText).toBe(GROUNDING_UNAVAILABLE);
  expect(visible).toEqual([GROUNDING_UNAVAILABLE]);
});

test('partial research with an observed source is explicitly bounded instead of silently discarded', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue('Bounded answer.');
  const result = await runCoreTurn(context(request), {
    runResearch: async () => ({ ...evidence, ok: false, error: 'some questions incomplete' }),
  });
  expect(result.finalText).toContain(GROUNDING_PARTIAL);
  expect(result.finalText).toContain(evidence.sourceUrls[0]);
});

test('parent cancellation while evidence is pending produces no provisional factual response', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const researchStarted = new Promise<void>(resolve => { started = resolve; });
  const model = spyOn(llm, 'streamLLMWithTools').mockResolvedValue('unverified claim');
  const visible: string[] = [];
  const pending = runCoreTurn({ ...context(request, controller.signal), callbacks: { onText: (_delta, full) => visible.push(full) } }, {
    runResearch: () => { started(); return new Promise(() => {}); },
  });
  await researchStarted;
  controller.abort();
  expect((await pending).stopReason).toBe('aborted');
  expect(model).not.toHaveBeenCalled();
  expect(visible).toEqual([]);
});

test('ordinary stable questions retain the normal single model turn', async () => {
  const model = spyOn(llm, 'streamLLMWithTools').mockResolvedValue('Stable explanation.');
  let researchCalls = 0;
  const result = await runCoreTurn(context('Explain binary search'), {
    runResearch: async () => { researchCalls++; return evidence; },
  });
  expect(result.finalText).toBe('Stable explanation.');
  expect(model).toHaveBeenCalledTimes(1);
  expect(researchCalls).toBe(0);
});


test.each([
  '현재 디렉터리가 어디야?', '현재 디렉토리를 알려줘', '오늘 일정은 어때?', '현재 git 가지를 알려줘',
  '최근 커밋을 알려줘', 'What is the current directory?', 'What is the current git branch?', 'Explain recent commits',
])('local state stays on its original tools and first model response: %s', async request => {
  let researchCalls = 0;
  let supplied: string[] = [];
  const model = spyOn(llm, 'streamLLMWithTools').mockImplementation(async (_messages, _handlers, options) => {
    supplied = options?.tools?.map(tool => tool.name) ?? [];
    return 'local tool response';
  });
  const result = await runCoreTurn({ ...context(request), tools: [{ name: 'Read', description: 'Read local files', parameters: { type: 'object', properties: {} } }] }, {
    runResearch: async () => { researchCalls++; return evidence; },
  });
  expect(needsGroundingFirst(request)).toBe(false);
  expect(researchCalls).toBe(0);
  expect(model).toHaveBeenCalledTimes(1);
  expect(supplied).toContain('Read');
  expect(result.finalText).toBe('local tool response');
});

test('forward-looking public questions (forecast, dated month, weather/venue announcements) need grounding first', () => {
  for (const text of [
    '2026년 11월 용평 지역의 기상 전망과 리조트 제설·개장 발표 일정의 제약을 날짜와 URL 로 알려줘',
    '이번 겨울 용평 기상 전망과 제설·개장 발표 일정은 어때?',
    '이번 겨울 스키장 개장 예보는 어때?',
    'What is the snowfall forecast for next week at the resort?',
  ]) expect(needsGroundingFirst(text)).toBe(true);
  for (const text of ['앞으로 이 함수 구조는 어떻게 바꿀까?', '이번 주 내 일정은 어때?', '다음 달 커밋 계획을 설명해줘']) {
    expect(needsGroundingFirst(text)).toBe(false);
  }
});

test('an ordinary answer keeps only this turn\'s fetched URLs; unfetched URLs never reach the screen', async () => {
  const question = '용평 리조트 공식 안내 링크는 어디야?';
  const visible: string[] = [];
  const replaced: string[] = [];
  let committed: string | undefined;
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    handlers.onToolResult?.({ id: 'fetch-1', name: 'WebFetch', result: { url: 'https://www.yongpyong.co.kr/kor/notice' } });
    const text = '공지: https://www.yongpyong.co.kr/kor/notice. 기상: [기상청](https://www.weather.go.kr/w/index.do) 참고';
    let full = '';
    for (const piece of text.match(/.{1,4}/gsu) ?? []) { full += piece; handlers.onText(piece, full); }
    handlers.onTurnComplete?.([{ role: 'assistant', content: text, phase: 'final_answer' }]);
    return text;
  });
  const result = await runCoreTurn({
    ...context(question),
    callbacks: {
      onText: (_delta, full) => visible.push(full),
      onReplaceText: full => replaced.push(full),
      onTurnComplete: messages => { committed = String(messages.at(-1)?.content); },
    },
  }, { runResearch: async () => evidence });
  for (const shown of visible) expect(shown).not.toContain('weather.go.kr');
  expect(result.finalText).toContain('https://www.yongpyong.co.kr/kor/notice');
  expect(result.finalText).not.toContain('weather.go.kr');
  expect(result.finalText).toContain('기상청');
  expect(result.finalText).toContain('검색 안 함');
  expect(replaced).toEqual([result.finalText]);
  expect(committed).toBe(result.finalText);
});

test('research synthesis keeps evidence URLs and drops a URL the evidence never fetched', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue(`전망 요약 (${evidence.sourceUrls[0]}) · 추가 https://invented.example/forecast`);
  const result = await runCoreTurn(context(request), { runResearch: async () => evidence });
  expect(result.finalText).toContain(evidence.sourceUrls[0]);
  expect(result.finalText).not.toContain('invented.example');
  expect(result.finalText).toContain('검색 안 함');
});

test('a user-typed URL that only gets the user-provided mark is committed with the same marked text', async () => {
  const question = '이 링크 https://user.example/page 내용이 뭐야?';
  let committed: string | undefined;
  const replaced: string[] = [];
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    const text = '사용자가 준 https://user.example/page 를 아직 열지 않았습니다.';
    handlers.onText(text, text);
    handlers.onTurnComplete?.([{ role: 'assistant', content: text, phase: 'final_answer' }]);
    return text;
  });
  const result = await runCoreTurn({
    ...context(question),
    callbacks: {
      onText: () => {},
      onReplaceText: full => replaced.push(full),
      onTurnComplete: messages => { committed = String(messages.at(-1)?.content); },
    },
  }, { runResearch: async () => evidence });
  expect(result.finalText).toContain('사용자 제공 링크');
  expect(committed).toBe(result.finalText);
});
