import { afterEach, expect, spyOn, test } from 'bun:test';
import * as llm from '../llm.js';
import { debug } from '../debug/log.js';
import * as coreTurnModule from './run-core-turn.js';
import { runCoreTurn } from './run-core-turn.js';
import { DaemonSessionHistory } from '../boot/daemon-runtime.js';
import { runDaemonPromptTurn } from '../boot/daemon-prompt-turn.js';

// WEBCHAT-ORDINARY-SKIP-GROUNDING (OP 11-26) — the member web chat (`researchEntry: 'on-request'`) answers an ordinary
// line without the research/grounding fan-out (no question-plan call before the first token); a sourced-fact request
// still reaches research, and the web tools stay in the pool for the model's own search calls.
const spec = (name: string) => ({ name, description: name, parameters: { type: 'object' } });
const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => { while (restores.length) restores.pop()!.mockRestore(); });

type Run = { researchCalls: number; researchBeforeFirstToken: boolean; modelTools: string[][]; routeEvents: string[] };

async function runTurn(userText: string, researchEntry?: 'default' | 'on-request'): Promise<Run> {
  let researchCalls = 0;
  let firstTokenSeen = false;
  let researchBeforeFirstToken = false;
  const modelTools: string[][] = [];
  const routeEvents: string[] = [];
  restores.push(spyOn(llm, 'streamLLMWithTools').mockImplementation((async (_messages: unknown, handlers: { onText(delta: string, full: string): void }, opts: { tools?: Array<{ name: string }> }) => {
    modelTools.push((opts?.tools ?? []).map((tool) => tool.name));
    handlers.onText('안녕하세요', '안녕하세요');
    return '안녕하세요';
  }) as unknown as typeof llm.streamLLMWithTools));
  const original = debug.log.bind(debug);
  restores.push(spyOn(debug, 'log').mockImplementation(((category: string, event: string, fields?: unknown, opts?: unknown) => {
    if (category === 'research') routeEvents.push(event);
    return (original as (...args: unknown[]) => unknown)(category, event, fields, opts);
  }) as typeof debug.log));
  await runCoreTurn({
    sessionId: 'webchat-on-request-test', messages: [{ role: 'user', content: userText }], userText,
    tools: [spec('WebSearch'), spec('WebFetch'), spec('memory_recall')], dispatchTool: async () => 'ok',
    signal: new AbortController().signal,
    ...(researchEntry ? { researchEntry } : {}),
    callbacks: { onText: () => { firstTokenSeen = true; } },
  }, {
    runResearch: async () => {
      researchCalls += 1;
      if (!firstTokenSeen) researchBeforeFirstToken = true;
      return { ok: true, output: 'evidence https://example.com/a', sourceUrls: ['https://example.com/a'] };
    },
    stallSeat: null,
    stallMailer: async () => {},
  });
  return { researchCalls, researchBeforeFirstToken, modelTools, routeEvents };
}

test('member web chat: an ordinary line starts no research fan-out before the first token', async () => {
  const run = await runTurn('안녕! 오늘 기분 좋네. 너는 뭘 도와줄 수 있어?', 'on-request');
  expect(run.researchCalls).toBe(0);
  expect(run.researchBeforeFirstToken).toBe(false);
  expect(run.routeEvents).toContain('default-entry-off');
  expect(run.routeEvents).not.toContain('route');
  // The web tools stay with the model, so it can still search on its own.
  expect(run.modelTools.length).toBe(1);
  expect(run.modelTools[0]).toContain('WebSearch');
  expect(run.modelTools[0]).toContain('WebFetch');
});

test('member web chat: a sourced-fact request still reaches research (grounding available)', async () => {
  const run = await runTurn('오늘 한국 증시 뉴스 어때? 출처도 알려줘', 'on-request');
  expect(run.researchCalls).toBe(1);
});

test('other surfaces keep the default structured entry: the same ordinary line still enters research first', async () => {
  const run = await runTurn('안녕! 오늘 기분 좋네. 너는 뭘 도와줄 수 있어?');
  expect(run.researchCalls).toBe(1);
  expect(run.researchBeforeFirstToken).toBe(true);
  expect(run.routeEvents).not.toContain('default-entry-off');
});

test('runDaemonPromptTurn forwards researchEntry to the core turn only when the caller (member web chat) sets it', async () => {
  const seen: Array<string | undefined> = [];
  restores.push(spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
    seen.push(ctx.researchEntry);
    return { stopReason: 'end_turn', finalText: 'ok' };
  }));
  const request = { sessionId: 'webchat-forward', userText: '안녕', userContent: null,
    source: { kind: 'daemon-api' as const, route: '/v1/prompt/stream' }, effectiveSystemPrompt: undefined, tools: null };
  await runDaemonPromptTurn({ history: new DaemonSessionHistory(), request, researchEntry: 'on-request', dispatchToolErrorMessage: 'unused' });
  await runDaemonPromptTurn({ history: new DaemonSessionHistory(), request: { ...request, sessionId: 'pwa-forward' }, dispatchToolErrorMessage: 'unused' });
  expect(seen).toEqual(['on-request', undefined]);
});
