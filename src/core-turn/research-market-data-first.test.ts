import type { LLMToolSpec } from '../llm/tool-spec.js';
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';

import * as llmModule from '../llm.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
import { isResearchToolAllowed, buildMarketDataInstruction, marketDataToolNames } from './research-policy.js';
import { runCoreTurn } from './run-core-turn.js';

const spec = (name: string): LLMToolSpec => ({ name, description: name, parameters: { type: 'object', properties: {} } });
const signal = new AbortController().signal;
const request = '2027 반도체 전망을 조사해서 종목 시세와 외국인 수급까지 분석해줘 research';

/** `deferred` names are removed from the tiered (active) set, as the catalog tier split does for MarketQuote/KrFlowSnapshot. */
function mockTierSplit(deferred: readonly string[] = []): void {
  spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockReturnValue({
    id: 'chat', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  } as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
  spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages], tools: tools.filter((t) => !deferred.includes(t.name)),
    stats: { activeCount: tools.length, deferredCount: deferred.length, warmPreloaded: 0, injected: false,
      deferredNames: [...deferred], unhydratableNames: [], unhydratableCount: 0 },
  } as unknown as ReturnType<typeof deferredModule.applyDeferredTools>));
}

beforeEach(() => { spyOn(llmModule, 'streamLLMWithTools').mockResolvedValue('done'); });
afterEach(() => mock.restore());

async function runTurn(tools: LLMToolSpec[]) {
  let firstTools: string[] = [];
  let guidance = '';
  let dispatched: Record<string, unknown> = {};
  const ran: string[] = [];
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers, options) => {
    if (firstTools.length === 0) {
      firstTools = options?.tools?.map((t) => t.name) ?? [];
      guidance = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      for (const name of ['finance_quote', 'finance_kr_flow', 'Bash']) {
        if (firstTools.includes(name) || name === 'Bash') dispatched[name] = await handlers.dispatchTool(name, { symbol: '005930' });
      }
    }
    return 'answer';
  });
  await runCoreTurn({
    sessionId: 'market-data-first', messages: [{ role: 'user', content: request }], tools,
    dispatchTool: async (name) => { ran.push(name); return `${name} result`; }, signal, userText: request,
  }, { runResearch: async () => ({ ok: true, output: 'web evidence' }) });
  return { firstTools, guidance, dispatched, ran };
}

test('policy: market-data tools are research-allowed; instruction only when a tool is in the pool', () => {
  for (const name of ['finance_quote', 'finance_kr_flow', 'MarketQuote', 'KrFlowSnapshot']) expect(isResearchToolAllowed(name)).toBe(true);
  expect(isResearchToolAllowed('finance_trade')).toBe(false);
  expect(isResearchToolAllowed('Bash')).toBe(false);
  expect(marketDataToolNames([spec('WebSearch'), spec('finance_quote')])).toEqual(['finance_quote']);
  expect(buildMarketDataInstruction([])).toBeUndefined();
  expect(buildMarketDataInstruction(['finance_quote'])).toContain('먼저 호출');
});

test('research turn keeps finance tools, tells the model to call them first and quote only their numbers', async () => {
  mockTierSplit();
  const out = await runTurn(['WebSearch', 'OmniSearch', 'WebFetch', 'Read', 'finance_quote', 'finance_kr_flow', 'finance_trade'].map(spec));
  expect(out.firstTools).toEqual(expect.arrayContaining(['finance_quote', 'finance_kr_flow', 'WebSearch']));
  expect(out.firstTools).not.toContain('finance_trade');
  expect(out.guidance).toContain('시장데이터 도구(finance_quote, finance_kr_flow)를 먼저 호출한다');
  expect(out.guidance).toContain('조회 불가');
  expect(out.ran).toEqual(expect.arrayContaining(['finance_quote', 'finance_kr_flow']));
  expect(out.dispatched.Bash).toEqual({ error: 'This research turn may only use the research tool allowlist.' });
});

test('a catalog-deferred market-data tool is still exposed to the research turn (ToolSearch is not on the allowlist)', async () => {
  mockTierSplit(['finance_quote']);
  const out = await runTurn(['WebSearch', 'OmniSearch', 'Read', 'finance_quote'].map(spec));
  expect(out.firstTools).toContain('finance_quote');
});

test('no finance tool in the pool (not enabled / credential probe hid it): no claim, no market-data instruction', async () => {
  mockTierSplit();
  const out = await runTurn(['WebSearch', 'OmniSearch', 'Read'].map(spec));
  expect(out.firstTools.some((n) => n.startsWith('finance_'))).toBe(false);
  expect(out.guidance).not.toContain('시장데이터 도구');
});
