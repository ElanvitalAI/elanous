import type { LLMToolSpec } from '../llm/tool-spec.js';
import { afterEach, expect, mock, spyOn, test } from 'bun:test';

import * as llmModule from '../llm.js';
import { buildUniversalPreamble } from '../prompt-library/universal-preamble.js';
import { runCoreTurn } from './run-core-turn.js';
import type { CoreToolResult } from './types.js';

/**
 * Proposed source-tree destination when P11 adds this test:
 * src/core-turn/ordered-linear-research-tool-dispatch.test.ts
 *
 * The model and external side effects are deterministic fakes. The production
 * runCoreTurn entry point, its routing decisions, and its dispatch wrapper are
 * real. In particular, a RED on main is expected while this ordered mixed
 * workflow is still routed through the research-only prepass/tool allowlist.
 */
const request = '먼저 Linear에 DEMO 팀으로 2027 사업계획 리스크 점검 이슈를 만들어 줘. 그다음 연구 사다리 그래프를 시작해 근거를 모아 줘.';
const linearName = 'elanous_linear_issue';
const graphStartName = 'graph_run_start';
const signal = new AbortController().signal;

const tools: LLMToolSpec[] = [
  { name: linearName, description: 'Create an explicitly requested Linear issue', parameters: { type: 'object', properties: {} } },
  { name: graphStartName, description: 'Start a saved research ladder graph', parameters: { type: 'object', properties: {} } },
  { name: 'WebSearch', description: 'Search current web sources', parameters: { type: 'object', properties: {} } },
  { name: 'skill_exec', description: 'Execute an installed skill', parameters: { type: 'object', properties: {} } },
];

afterEach(() => mock.restore());

test('ordered Linear then research request dispatches the issue first and returns the graph runId', async () => {
  const preamble = buildUniversalPreamble({ cwd: process.cwd(), enabledTools: ['update_plan'] });
  const dispatches: Array<{ name: string; args: Record<string, unknown> }> = [];
  const results: CoreToolResult[] = [];
  let researchTurn: boolean | undefined;
  let researchPrepassCalls = 0;

  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers, options) => {
    researchTurn = options?.researchTurn;
    const offered = new Set(options?.tools?.map((tool) => tool.name) ?? []);

    // The ordered request must retain the normal tool pool so the first
    // explicit action can be dispatched before the research graph starts.
    expect(offered.has(linearName)).toBe(true);
    expect(offered.has(graphStartName)).toBe(true);
    expect(options?.firstTurnTools?.map((tool) => tool.name)).toEqual([linearName]);
    expect(options?.toolChoice).toEqual({ name: linearName });
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('use `update_plan` with those steps in the same order before starting'),
      }),
      expect.objectContaining({ role: 'user', content: request }),
    ]));

    const modelSteps = [
      {
        id: 'linear-create-1',
        name: linearName,
        args: { action: 'create', teamKey: 'DEMO', title: '2027 사업계획 리스크 점검' },
      },
      {
        id: 'research-graph-1',
        name: graphStartName,
        args: { graphId: 'research-ladder', reason: '2027 사업계획 근거 조사' },
      },
    ];

    // Mimic two successive provider tool turns. runCoreTurn itself wraps and
    // invokes the dispatch callback in order; no live Linear or graph write is made.
    for (const step of modelSteps) {
      handlers.onToolCall?.(step);
      const result = await handlers.dispatchTool(step.name, step.args, {
        callId: step.id,
        turnIndex: dispatches.length,
      });
      handlers.onToolResult?.({ id: step.id, name: step.name, result });
    }
    return 'DEMO issue created; research graph started.';
  });

  const result = await runCoreTurn({
    sessionId: 'ordered-linear-research-tool-dispatch',
    userText: request,
    messages: [...preamble, { role: 'user', content: request }],
    tools,
    signal,
    callbacks: { onToolResult: (call) => results.push(call) },
    dispatchTool: async (name, args) => {
      dispatches.push({ name, args });
      if (name === linearName) return { issueId: 'DEMO-42', teamKey: 'DEMO' };
      if (name === graphStartName) return { graphId: 'research-ladder', runId: 'run-research-ladder-42' };
      throw new Error(`unexpected tool dispatch: ${name}`);
    },
  }, {
    runResearch: async () => {
      researchPrepassCalls += 1;
      return { ok: true, output: 'unexpected research-only prepass' };
    },
  });

  expect(result.stopReason).toBe('end_turn');
  expect(researchTurn).toBe(false);
  expect(researchPrepassCalls).toBe(0);
  expect(dispatches.map(({ name }) => name)).toEqual([linearName, graphStartName]);
  expect(dispatches[0]?.args).toMatchObject({ action: 'create', teamKey: 'DEMO' });
  expect(dispatches[1]?.args).toMatchObject({ graphId: 'research-ladder' });
  expect(results.map(({ name }) => name)).toEqual([linearName, graphStartName]);
  expect(results[1]?.result).toMatchObject({ graphId: 'research-ladder', runId: 'run-research-ladder-42' });
});
