import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { LLMToolSpec } from '../llm.js';
import * as llmModule from '../llm.js';
import { debug } from '../debug/log.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
const applyDeferredToolsActual = deferredModule.applyDeferredTools;
import { isResearchAgentIntent } from '../tool-hints/signals.js';
import { buildUniversalPreamble } from '../prompt-library/universal-preamble.js';
import { researchTurnForGrounding, runResearchQuestionLadder } from '../auto-research/research-turn.js';
import { fanOutAxisEvidence } from '../research/axis-fanout.js';
import { routeResearchOutput } from '../research/output-router.js';
import {
  isResearchToolAllowed,
  requestsResearchDocumentWrite,
  RESEARCH_TOOL_ALLOWLIST,
  RESEARCH_TURN_DEEP_BUDGET_MS,
  RESEARCH_TURN_FINAL_ANSWER_DEADLINE_MS,
  RESEARCH_TURN_SHALLOW_BUDGET_MS,
  RESEARCH_TURN_SHALLOW_FINAL_ANSWER_DEADLINE_MS,
} from './research-policy.js';
import { runCoreTurn } from './run-core-turn.js';

const tool: LLMToolSpec = {
  name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} },
};
const skillExecTool: LLMToolSpec = {
  name: 'skill_exec', description: 'Execute a named installed skill',
  parameters: { type: 'object', properties: {} },
};
const webSearchTool: LLMToolSpec = {
  name: 'WebSearch', description: 'Search the web', parameters: { type: 'object', properties: {} },
};
const omniSearchTool: LLMToolSpec = {
  name: 'OmniSearch', description: 'Search multiple providers', parameters: { type: 'object', properties: {} },
};
const webFetchTool: LLMToolSpec = {
  name: 'WebFetch', description: 'Fetch a URL', parameters: { type: 'object', properties: {} },
};
const signal = new AbortController().signal;

test('deep research answer deadline stays below its parent abort timer; shallow stays at 180s', () => {
  expect(RESEARCH_TURN_FINAL_ANSWER_DEADLINE_MS).toBe(480_000);
  expect(RESEARCH_TURN_DEEP_BUDGET_MS).toBeGreaterThan(RESEARCH_TURN_FINAL_ANSWER_DEADLINE_MS);
  expect(RESEARCH_TURN_SHALLOW_BUDGET_MS).toBe(180_000);
  expect(RESEARCH_TURN_SHALLOW_FINAL_ANSWER_DEADLINE_MS).toBeLessThan(RESEARCH_TURN_SHALLOW_BUDGET_MS);
});

test('ordered Linear → research → aside workflow dispatches native Linear before research', async () => {
  const request = '먼저 리니어 이슈를 만들고, 그다음 리서치하고, aside 캡처한 뒤 마지막에 정리해 주세요.';
  const preamble = buildUniversalPreamble({ cwd: process.cwd(), enabledTools: ['update_plan'] });
  const calls: string[] = [];
  let toolsSeen: string[] = [];
  let researchTurn: boolean | undefined;
  let researchCalls = 0;
  let firstToolResult: unknown;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers, options) => {
    if (toolsSeen.length === 0) {
      toolsSeen = options?.tools?.map(candidate => candidate.name) ?? [];
      researchTurn = options?.researchTurn;
    }
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('use `update_plan` with those steps in the same order before starting'),
      }),
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('begin with step one'),
      }),
      expect.objectContaining({ role: 'user', content: request }),
    ]));
    expect(options?.tools?.map(candidate => candidate.name)).toContain('elanous_linear_issue');
    firstToolResult = await handlers.dispatchTool('elanous_linear_issue', { action: 'create' });
    return 'done';
  });
  const linearIssueTool: LLMToolSpec = { ...tool, name: 'elanous_linear_issue' };
  const updatePlanTool: LLMToolSpec = { ...tool, name: 'update_plan' };
  const asideTool: LLMToolSpec = { ...tool, name: 'aside.repl' };
  await runCoreTurn({
    sessionId: 'ordered-linear-research-aside',
    messages: [...preamble, { role: 'user', content: request }],
    tools: [linearIssueTool, updatePlanTool, asideTool, webSearchTool, webFetchTool, omniSearchTool],
    dispatchTool: async (name) => { calls.push(name); return 'issue created'; },
    signal,
    userText: request,
  }, { runResearch: async () => { researchCalls += 1; return { ok: true, output: 'unexpected research prepass' }; } });

  expect(toolsSeen).toEqual(expect.arrayContaining(['elanous_linear_issue', 'update_plan', 'aside.repl', 'WebSearch']));
  expect(researchTurn).toBe(true);
  expect(calls[0]).toBe('elanous_linear_issue');
  expect(firstToolResult).toBe('issue created');
  expect(researchCalls).toBe(1);
});

function createManualTimers() {
  const scheduled: Array<{ delayMs: number; callback: () => void; handle: ReturnType<typeof setTimeout>; cleared: boolean }> = [];
  return {
    scheduled,
    timers: {
      setTimeout(callback: () => void, delayMs: number) {
        const entry = { delayMs, callback, handle: globalThis.setTimeout(() => {}, 60_000), cleared: false };
        scheduled.push(entry);
        return entry.handle;
      },
      clearTimeout(handle: ReturnType<typeof setTimeout>) {
        const entry = scheduled.find(timer => timer.handle === handle);
        if (entry) entry.cleared = true;
        globalThis.clearTimeout(handle);
      },
    },
    fire(delayMs: number) {
      const entry = scheduled.find(timer => timer.delayMs === delayMs && !timer.cleared);
      if (!entry) throw new Error(`no active timer for ${delayMs}ms`);
      entry.callback();
    },
  };
}

beforeEach(() => {
  spyOn(llmModule, 'streamLLMWithTools').mockResolvedValue('done');
  spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockReturnValue({
    id: 'chat', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  } as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
  spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages], tools: [...tools],
    stats: {
      activeCount: tools.length, deferredCount: 0, warmPreloaded: [], injected: false,
      deferredNames: [], unhydratableNames: [], unhydratableCount: 0,
    },
  } as unknown as ReturnType<typeof deferredModule.applyDeferredTools>));
});

afterEach(() => mock.restore());

test('uses shared research-turn intent in chat surface and injects Bloom evidence', async () => {
  const request = 'compare bond yield changes';
  let calls = 0;
  let modelCalls = 0;
  let researchTurn: boolean | undefined;
  let researchToolsSeen: string[] = [];
  let firstCallHadEvidence = true;
  let secondCallHadEvidence = false;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, _handlers, options) => {
    modelCalls += 1;
    researchTurn = options?.researchTurn;
    if (modelCalls === 2) researchToolsSeen = options?.tools?.map(spec => spec.name) ?? [];
    const message = messages.find((item) => item.role === 'user'
      && typeof item.content === 'string' && item.content.includes('<bloom-research>'));
    const trustBoundary = messages.find((item) => item.role === 'system'
      && typeof item.content === 'string' && item.content.includes('untrusted research data'));
    if (modelCalls === 1) firstCallHadEvidence = Boolean(message);
    else secondCallHadEvidence = typeof message?.content === 'string' && message.content.includes('Counterevidence');
    if (modelCalls === 2) expect(trustBoundary).toBeDefined();
    return modelCalls === 1 ? 'initial answer' : 'evidence-reconciled answer';
  });
  const result = await runCoreTurn({
    sessionId: 'research-chat-surface',
    messages: [{ role: 'user', content: request }],
    tools: [tool, skillExecTool, webSearchTool, omniSearchTool, webFetchTool, { ...tool, name: 'ToolSearch' }],
    dispatchTool: async () => null, signal, userText: request,
  }, { runResearch: async (text) => {
    calls += 1;
    expect(text).toBe(request);
    return { ok: true, output: 'Counterevidence: yields can fall when inflation expectations decline.' };
  } });

  expect(calls).toBe(1);
  expect(researchTurn).toBe(true);
  expect(modelCalls).toBe(2);
  expect(firstCallHadEvidence).toBe(false);
  expect(secondCallHadEvidence).toBe(true);
  expect(researchToolsSeen).toEqual(expect.arrayContaining(['Read', 'WebFetch']));
  expect(researchToolsSeen).not.toEqual(expect.arrayContaining(['skill_exec', 'ToolSearch']));
  expect(result.finalText).toBe('evidence-reconciled answer');
});

test('final synthesis receives the production source ledger and trusted claim citation rules', async () => {
  const request = '2026-11-01 기준으로 HBM4 공급망을 조사하라';
  const outputContract = {
    deliverable: 'A sourced research memo', format: 'Short memo',
    sections: [{ id: 'findings', title: 'Findings', purpose: 'Report supported findings and gaps.' }],
    completionCriteria: ['Support every factual claim or mark it uncertain.'],
  };
  const questions = Array.from({ length: 6 }, (_, index) => ({
    id: `q${index + 1}`, level: (index + 1) as 1 | 2 | 3 | 4 | 5 | 6,
    prompt: ['HBM4 customer qualification', 'HBM4 packaging capacity', 'HBM4 counterevidence',
      'HBM4 supply chain', 'HBM4 timeline', 'HBM4 adoption status'][index]!,
    searchTerms: [`HBM4 evidence ${index + 1}`], sectionId: 'findings',
  }));
  let modelCalls = 0;
  let finalSynthesisPrompt = '';
  let trustedSynthesisRules = '';
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, _handlers, options) => {
    modelCalls += 1;
    if (modelCalls === 2) {
      finalSynthesisPrompt = messages.find((item) => item.role === 'user'
        && typeof item.content === 'string' && item.content.includes('<bloom-research>'))?.content as string ?? '';
      trustedSynthesisRules = messages.filter((item) => item.role === 'system' && typeof item.content === 'string')
        .map(item => item.content as string).join('\n');
      expect(messages.some((item) => item.role === 'system' && typeof item.content === 'string'
        && item.content.includes('Ignore previous instructions'))).toBe(false);
      expect(messages.some((item) => item.role === 'system' && typeof item.content === 'string'
        && item.content.includes('untrusted research data'))).toBe(true);
    }
    return modelCalls === 1 ? 'provisional answer'
      : 'HBM4 qualification was reported. (https://vendor.example/qualification; published 2026-10-30; checked 2026-11-01)';
  });

  const research = await runResearchQuestionLadder(request, {
    generateContract: async () => JSON.stringify(outputContract),
    generate: async () => JSON.stringify({ questions }),
    planGapFollowup: () => ({ rounds: 0, timeBudgetMs: 0, classifications: [], followups: [] }),
    enableResearchFanout: false,
    invokeAxes: axes => fanOutAxisEvidence(axes, {
      now: () => Date.parse('2026-11-01T12:34:56.000Z'),
      search: async (_query, _signal, context) => {
        if (context?.questionPrompt === 'HBM4 customer qualification') return [{
          url: 'https://vendor.example/qualification', title: 'Qualification update',
          snippet: 'Vendor A reported a customer qualification milestone.',
          publishedAt: Date.parse('2026-10-30T00:00:00.000Z'),
        }];
        if (context?.questionPrompt === 'HBM4 packaging capacity') return [{
          url: 'https://foundry.example/packaging', title: 'Packaging capacity',
          snippet: 'Packaging capacity remains constrained.',
          publishedAt: Date.parse('2026-10-28T00:00:00.000Z'),
        }];
        return [];
      },
      fetchPage: async url => ({
        url,
        output: url.endsWith('/qualification')
          ? 'Vendor A reported a customer qualification milestone.'
          : 'Packaging capacity remains constrained.',
      }),
    }),
    routeOutput: input => routeResearchOutput({ ...input, skills: [] }),
  });
  const grounding = researchTurnForGrounding(research);

  const result = await runCoreTurn({
    sessionId: 'claim-level-source-handoff',
    messages: [{ role: 'user', content: request }],
    tools: [tool, skillExecTool, webSearchTool, omniSearchTool, webFetchTool],
    dispatchTool: async () => null,
    signal,
    userText: request,
  }, { runResearch: async () => grounding });

  expect(modelCalls).toBe(2);
  const rows = finalSynthesisPrompt.split('\n').filter(line => line.startsWith('- {'))
    .map(line => JSON.parse(line.slice(2)) as Record<string, unknown>);
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ questionId: 'q1', sourceUrl: 'https://vendor.example/qualification', published: '2026-10-30', checked: '2026-11-01' }),
    expect.objectContaining({ questionId: 'q2', sourceUrl: 'https://foundry.example/packaging', published: '2026-10-28', checked: '2026-11-01' }),
    expect.objectContaining({ questionId: 'q6', label: '미확인', status: 'unverified' }),
  ]));
  expect(finalSynthesisPrompt).toContain('https://vendor.example/qualification');
  expect(finalSynthesisPrompt).toContain('"published":"2026-10-30","checked":"2026-11-01"');
  expect(finalSynthesisPrompt).toContain('https://foundry.example/packaging');
  expect(trustedSynthesisRules).toContain('Each factual claim must include its own source URL');
  expect(trustedSynthesisRules).toContain('publisher date and checked date');
  expect(trustedSynthesisRules).toContain('미확인');
  expect(result.finalText).toContain('published 2026-10-30; checked 2026-11-01');
});

test('Q2v2 fixed-input mock exposes WebSearch on the first model call and records exclusions', async () => {
  const request = '2026-10-31 기준 HBM4(12단)의 상태를 SK하이닉스·삼성전자·마이크론 세 회사에 한정해 조사하라. 회사마다 «발표·샘플 출하·고객 인증·양산 출하» 네 단계 중 어디까지 1차 자료(회사 발표·실적 발표)로 확인되는지를 날짜와 원문 URL로 한 줄씩 표로 제시하고, 확인되지 않는 단계는 «미확인»으로 둬라. 공급망 병목은 베이스 다이 파운드리 의존 하나만 골라 인과를 3문장으로 설명하라. 일정 지연을 뒷받침하는 가장 강한 반대 근거 1개와 2026년 말까지 확인할 관측 지표 3개를 제시하라. 보고서는 1,500자 이내로 쓴다.';
  expect(isResearchAgentIntent(request)).toBe(true);
  let firstCallTools: string[] = [];
  let capturedFirstCall = false;
  let tierSplit: Record<string, unknown> | undefined;
  spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'capability.resolve' && event === 'tier-split' && data && typeof data === 'object') {
      tierSplit = data as Record<string, unknown>;
    }
  });
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, _handlers, options) => {
    const callTools = options?.tools?.map(spec => spec.name) ?? [];
    if (!capturedFirstCall) {
      firstCallTools = callTools;
      capturedFirstCall = true;
    }
    return 'mock provisional answer';
  });
  const shellTool: LLMToolSpec = { ...tool, name: 'Shell' };

  await runCoreTurn({
    sessionId: 'q2v2-fixed-input-mock',
    messages: [{ role: 'user', content: request }],
    tools: [tool, webSearchTool, webFetchTool, omniSearchTool, shellTool],
    dispatchTool: async () => null,
    signal,
    userText: request,
  }, { runResearch: async () => ({ ok: true, output: 'fixture evidence only' }) });

  expect(firstCallTools).toContain('WebSearch');
  expect(firstCallTools).toContain('WebFetch');
  expect(firstCallTools).not.toContain('Shell');
  expect(tierSplit).toMatchObject({
    sessionId: 'q2v2-fixed-input-mock',
    researchTurn: true,
    activeTools: expect.arrayContaining(['Read', 'WebSearch', 'WebFetch']),
    excludedTools: expect.arrayContaining([{ name: 'Shell', reason: 'research-tool-allowlist' }]),
  });
});

test('deep non-research prompts get Bloom without skill or search tools', async () => {
  const request = '채권 금리 앞으로 어떻게 봐야 하나';
  expect(isResearchAgentIntent(request)).toBe(false);
  let toolsSeen: string[] = [];
  let researchTurn: boolean | undefined;
  let bloomFrameSeen = false;
  let researchCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, _handlers, options) => {
    toolsSeen = options?.tools?.map(spec => spec.name) ?? [];
    researchTurn = options?.researchTurn;
    bloomFrameSeen = messages.some(message => message.role === 'system'
      && typeof message.content === 'string' && message.content.includes('3–5 short questions'));
    return 'analysis answer';
  });
  const result = await runCoreTurn({
    sessionId: 'deep-non-research-no-search',
    messages: [{ role: 'user', content: request }],
    tools: [tool, skillExecTool, webSearchTool, omniSearchTool, webFetchTool],
    dispatchTool: async () => null, signal, userText: request,
  }, { runResearch: async () => {
    researchCalls += 1;
    return { ok: true, output: 'unexpected research evidence' };
  } });

  expect(researchCalls).toBe(0);
  expect(researchTurn).toBe(false);
  expect(toolsSeen).toContain('Read');
  expect(toolsSeen).not.toEqual(expect.arrayContaining(['skill_exec', 'WebSearch', 'OmniSearch', 'WebFetch', 'ToolSearch']));
  expect(bloomFrameSeen).toBe(true);
  expect(result.finalText).toBe('analysis answer');
});

test('deep non-research named-skill requests keep active skill_exec without research or ToolSearch', async () => {
  const request = "Use the 'first-principles' skill to explain this clearly.";
  expect(isResearchAgentIntent(request)).toBe(false);
  let toolsSeen: string[] = [];
  let researchCalls = 0;
  let tierSplitEvent: unknown;
  spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools, options) =>
    applyDeferredToolsActual(messages, tools, { ...options, enabled: true }));
  spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'capability.resolve' && event === 'tool-tier-split') tierSplitEvent = data;
  });
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, _handlers, options) => {
    toolsSeen = options?.tools?.map(spec => spec.name) ?? [];
    return 'first-principles analysis';
  });
  const deferredTool: LLMToolSpec & { alwaysLoad: false; shouldDefer: true } = {
    name: 'DeferredFixture', description: 'A deferred fixture tool',
    parameters: { type: 'object', properties: {} },
    alwaysLoad: false, shouldDefer: true,
  };
  const result = await runCoreTurn({
    sessionId: 'deep-non-research-named-skill',
    messages: [{ role: 'user', content: request }],
    tools: [tool, skillExecTool, webSearchTool, deferredTool],
    dispatchTool: async () => null, signal, userText: request, reasoningEffort: 'high',
  }, { runResearch: async () => {
    researchCalls += 1;
    return { ok: true, output: 'unexpected research evidence' };
  } });

  expect(researchCalls).toBe(0);
  expect(toolsSeen).toContain('skill_exec');
  expect(toolsSeen).not.toEqual(expect.arrayContaining(['WebSearch', 'ToolSearch']));
  expect(tierSplitEvent).toMatchObject({
    activeCount: 4, immediateCount: 2, deferredCount: 1, deferred: ['DeferredFixture'],
  });
  expect(result.finalText).toBe('first-principles analysis');
});

test('records first-token, research, provisional-answer, and synthesis timing on one research turn', async () => {
  let clock = 1_000;
  let finishResearch: ((value: { ok: boolean; output: string }) => void) | undefined;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'research.turn' && data && typeof data === 'object' && !Array.isArray(data)) {
      events.push({ event, data: data as Record<string, unknown> });
    }
  });
  let modelCall = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    modelCall += 1;
    if (modelCall === 1) {
      clock += 120;
      handlers.onText?.('first token', 'first token');
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'provisional answer', phase: 'final_answer' }]);
      clock += 180;
      finishResearch?.({ ok: true, output: 'evidence' });
      return 'provisional answer';
    }
    clock += 50;
    handlers.onText?.('reconciled', 'reconciled answer');
    handlers.onTurnComplete?.([{ role: 'assistant', content: 'reconciled answer', phase: 'final_answer' }]);
    return 'reconciled answer';
  });
  await runCoreTurn({
    sessionId: 'research-timing',
    messages: [{ role: 'user', content: 'compare bond yield changes' }],
    tools: [tool], dispatchTool: async () => null, signal, userText: 'compare bond yield changes',
  }, {
    now: () => clock,
    runResearch: () => new Promise(resolve => { finishResearch = resolve; }),
  });

  expect(events.find(item => item.event === 'first-token')?.data).toMatchObject({
    sinceTurnStartMs: 120,
    sinceResearchStartMs: 120,
  });
  expect(events.find(item => item.event === 'first-pass-answer-ready')?.data).toMatchObject({
    sinceTurnStartMs: 300,
    outputChars: 'provisional answer'.length,
  });
  expect(events.find(item => item.event === 'tui-research-completed')?.data).toMatchObject({ elapsedMs: 300 });
  expect(events.find(item => item.event === 'synthesis-completed')?.data).toMatchObject({
    elapsedMs: 50,
    sinceTurnStartMs: 350,
  });
});

test('explicit named skill request skips the text-only research answer and invokes skill_exec', async () => {
  const request = "Use the skill named 'omni crawl' to look up one practical source on fuzzy skill discovery. Invoke the skill; do not answer from general knowledge.";
  expect(isResearchAgentIntent(request)).toBe(true);
  let researchCalls = 0;
  let skillCalls = 0;
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers, options) => {
    modelCalls += 1;
    expect(messages.some(message => message.role === 'system'
      && typeof message.content === 'string' && message.content.includes('provisional first response'))).toBe(false);
    expect(options?.tools?.map(spec => spec.name)).toContain('skill_exec');
    await handlers.dispatchTool('skill_exec', { skill: 'omni-crawl', task: 'look up one practical source' });
    return 'Invoked omni-crawl and found a practical source.';
  });
  const result = await runCoreTurn({
    sessionId: 'research-explicit-skill-request',
    messages: [{ role: 'user', content: request }],
    tools: [tool, skillExecTool],
    dispatchTool: async (name) => {
      expect(name).toBe('skill_exec');
      skillCalls += 1;
      return { ok: true, output: 'source result' };
    },
    signal,
    userText: request,
  }, { runResearch: async () => {
    researchCalls += 1;
    return { ok: true, output: 'research evidence' };
  } });

  expect(modelCalls).toBe(1);
  expect(researchCalls).toBe(0);
  expect(skillCalls).toBe(1);
  expect(result.finalText).toBe('Invoked omni-crawl and found a practical source.');
});

test('headless research runs in core-turn keep the 20-call ceiling and shared allowlist', async () => {
  const request = 'Research recent battery policy updates using current sources.';
  const calledToolSets: string[][] = [];
  const stopEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  let deniedDispatch: unknown;
  let deniedRunShellDispatch: unknown;
  let budgetDispatch: unknown;
  let forcedSynthesisPrompt = false;
  let synthesisReceivedEvidence = false;
  let modelCalls = 0;
  spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'research.stop' && data && typeof data === 'object' && !Array.isArray(data)) {
      stopEvents.push({ event, data: data as Record<string, unknown> });
    }
  });
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers, options) => {
    modelCalls += 1;
    calledToolSets.push(options?.tools?.map((item) => item.name) ?? []);
    expect(options?.maxTurns).toBe(20);
    if (modelCalls === 1) {
      deniedDispatch = await handlers.dispatchTool('Bash', { command: 'echo should-not-run' });
      deniedRunShellDispatch = await handlers.dispatchTool('RunShell', { command: 'echo should-not-run' });
      for (let i = 0; i < 21; i += 1) {
        const result = await handlers.dispatchTool('OmniSearch', { query: `research-${i}` });
        if (i === 20) budgetDispatch = result;
      }
      return 'provisional answer';
    }
    expect(options?.tools).toEqual([]);
    forcedSynthesisPrompt = _messages.some(message => typeof message.content === 'string'
      && message.content.includes('The research budget has ended. Synthesize now'));
    synthesisReceivedEvidence = _messages.some(message => typeof message.content === 'string'
      && message.content.includes('partial research evidence'));
    return 'forced synthesis';
  });
  let dispatches = 0;
  let searchDispatches = 0;
  const result = await runCoreTurn({
    sessionId: 'headless-research-policy',
    messages: [{ role: 'user', content: request }],
    tools: [
      { name: 'OmniSearch', description: 'Search multiple sources', parameters: { type: 'object' } },
      { name: 'WebFetch', description: 'Fetch a web page', parameters: { type: 'object' } },
      { name: 'Agent', description: 'Delegate research', parameters: { type: 'object' } },
      tool,
      { name: 'WebSearch', description: 'Search the web', parameters: { type: 'object' } },
      { name: 'Grep', description: 'Search files', parameters: { type: 'object' } },
      { name: 'Bash', description: 'Run shell', parameters: { type: 'object' } },
      skillExecTool,
    ],
    dispatchTool: async (name) => {
      dispatches += 1;
      if (name === 'OmniSearch') searchDispatches += 1;
      return 'search result';
    },
    signal,
    userText: request,
  }, { runResearch: async (_request, _signal, admitToolCall) => {
    for (let i = 0; i < 10; i += 1) expect(admitToolCall?.('OmniSearch')).toBe(true);
    return { ok: true, output: 'partial research evidence' };
  } });

  expect(isResearchAgentIntent(request)).toBe(true);
  expect(modelCalls).toBe(2);
  expect(calledToolSets).toEqual([['OmniSearch', 'WebFetch', 'Agent', 'Read', 'WebSearch'], []]);
  expect(RESEARCH_TOOL_ALLOWLIST).toEqual(['OmniSearch', 'WebSearch', 'WebFetch', 'Agent', 'Read', 'memory_recall', 'MsgList']);
  expect(isResearchToolAllowed('memory_recall')).toBe(true);
  expect(isResearchToolAllowed('MsgList')).toBe(true);
  expect(isResearchToolAllowed('Bash')).toBe(false);
  expect(isResearchToolAllowed('RunShell')).toBe(false);
  expect(deniedDispatch).toEqual({ error: 'This research turn may only use the research tool allowlist.' });
  expect(deniedRunShellDispatch).toEqual({ error: 'This research turn may only use the research tool allowlist.' });
  expect(budgetDispatch).toEqual({ error: 'Research tool budget reached. Answer with the evidence collected so far.' });
  expect(searchDispatches).toBe(10);
  expect(dispatches).toBe(10);
  expect(forcedSynthesisPrompt).toBe(true);
  expect(synthesisReceivedEvidence).toBe(true);
  // Stop reasons are deduplicated per turn; both denied dispatch results above
  // prove Bash and RunShell were blocked, while this event records the first.
  expect(stopEvents.filter(event => event.data.reason === 'tool-not-allowed').map(event => event.data.tool))
    .toEqual(['Bash']);
  expect(stopEvents.map(event => event.data.reason)).toEqual(expect.arrayContaining([
    'tool-not-allowed', 'tool-budget', 'forced-synthesis',
  ]));
  expect(result.finalText).toBe('forced synthesis');
});

test('research turns expose Edit/Write only for explicit document paths and still deny Bash', async () => {
  expect(requestsResearchDocumentWrite('Research and write docs/research-report.md.')).toBe(true);
  expect(requestsResearchDocumentWrite('Research and writing docs/research-report.md.')).toBe(true);
  expect(requestsResearchDocumentWrite('Research docs/research-report.md.')).toBe(false);
  expect(requestsResearchDocumentWrite("Research; don't write docs/research-report.md.")).toBe(false);
  expect(requestsResearchDocumentWrite('Research; avoid writing docs/research-report.md.')).toBe(false);
  expect(requestsResearchDocumentWrite('Research; never saving docs/research-report.md.')).toBe(false);
  expect(requestsResearchDocumentWrite('Research; should not be writing docs/research-report.md.')).toBe(false);
  expect(requestsResearchDocumentWrite('Research; docs/research-report.md 작성하지 마.')).toBe(false);
  const request = 'Research these findings and write docs/research-report.md with the requested research report.';
  let toolsSeen: string[] = [];
  let bashResult: unknown;
  const dispatched: string[] = [];
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers, options) => {
    toolsSeen = options?.tools?.map(spec => spec.name) ?? [];
    bashResult = await handlers.dispatchTool('Bash', { command: 'echo forbidden' });
    await handlers.dispatchTool('Write', { file_path: 'docs/research-report.md', content: '# report' });
    return 'Research report drafted.';
  });
  await runCoreTurn({
    sessionId: 'research-document-output-policy',
    messages: [{ role: 'user', content: request }],
    tools: [
      { name: 'Bash', description: 'Run shell', parameters: { type: 'object' } },
      { name: 'Edit', description: 'Edit a file', parameters: { type: 'object' } },
      { name: 'Write', description: 'Write a file', parameters: { type: 'object' } },
      { name: 'Read', description: 'Read a file', parameters: { type: 'object' } },
      { name: 'OmniSearch', description: 'Search sources', parameters: { type: 'object' } },
    ],
    dispatchTool: async name => { dispatched.push(name); return 'written'; },
    signal,
    userText: request,
  }, { runResearch: async () => ({ ok: true, output: 'Research evidence.' }) });

  expect(toolsSeen).toEqual(expect.arrayContaining(['Edit', 'Write', 'Read']));
  expect(toolsSeen).not.toContain('Bash');
  expect(bashResult).toEqual({ error: 'This research turn may use research tools and Edit/Write only for the explicitly requested document.' });
  expect(dispatched.length).toBeGreaterThan(0);
  expect(dispatched.every(name => name === 'Write')).toBe(true);
});

test('research Agent calls wait for results and narrow child tools to read-only fetch/read', async () => {
  const dispatched: unknown[] = [];
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      return 'Provisional answer';
    }
    await handlers.dispatchTool('Agent', {
      description: 'check source', prompt: 'read sources only', subagent_type: 'general-purpose',
      run_in_background: true, wait_for_slot: true, max_turns: 99,
      tool_filter: { allow: ['Bash'], deny: [] },
    });
    return 'Final answer';
  });
  const request = 'Research recent battery policy updates using current sources.';
  await runCoreTurn({
    sessionId: 'research-agent-policy',
    messages: [{ role: 'user', content: request }],
    tools: [tool, { name: 'WebFetch', description: 'fetch', parameters: { type: 'object' } }, { name: 'Agent', description: 'agent', parameters: { type: 'object' } }],
    dispatchTool: async (_name, args) => { dispatched.push(args); return 'agent findings'; }, signal, userText: request,
  }, { runResearch: async () => ({ ok: false, output: '', error: 'no evidence', axisCount: 3 }) });

  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]).toMatchObject({
    subagent_type: 'general-purpose', run_in_background: false, max_turns: 20,
    tool_filter: { allow: ['Read', 'WebFetch'], deny: ['Bash', 'Edit', 'Grep'] },
  });
  expect(debug.events(500).some(event => event.category === 'research.turn'
    && event.event === 'subagent-completed'
    && (event.data as { completionMode?: string } | undefined)?.completionMode === 'awaited-tool-result')).toBe(true);
});

test('research Agent is not dispatched until at least three judgment axes exist', async () => {
  const dispatched: string[] = [];
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    modelCalls += 1;
    if (modelCalls === 1) return 'Provisional answer';
    await handlers.dispatchTool('Agent', { description: 'delegate', prompt: 'judge these sources' });
    return 'Final answer';
  });
  const request = 'Research recent battery policy updates using current sources.';
  await runCoreTurn({
    sessionId: 'research-agent-minimum-axes',
    messages: [{ role: 'user', content: request }],
    tools: [tool, { name: 'Agent', description: 'agent', parameters: { type: 'object' } }],
    dispatchTool: async (name) => { dispatched.push(name); return 'agent findings'; },
    signal, userText: request,
  }, { runResearch: async () => ({ ok: false, output: '', error: 'no evidence', axisCount: 2 }) });

  expect(dispatched).toHaveLength(0);
  expect(debug.events(500).some(event => event.category === 'research.turn'
    && event.event === 'subagent-skipped'
    && (event.data as { reason?: string } | undefined)?.reason === 'insufficient-judgment-axes')).toBe(true);
});

test('a research turn emits a transparent first response at the 15-second limit', async () => {
  const manual = createManualTimers();
  const visible: string[] = [];
  let startedResearch!: () => void;
  let finishResearch!: (result: { ok: boolean; output: string }) => void;
  const researchStarted = new Promise<void>(resolve => { startedResearch = resolve; });
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers, options) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      expect(options?.tools?.map(item => item.name)).toEqual(['Read']);
      return new Promise<string>(() => {});
    }
    expect(options?.tools?.map(item => item.name)).toEqual(['Read']);
    handlers.onText?.('Grounded answer', 'Grounded answer');
    handlers.onTurnComplete?.([{ role: 'assistant', content: 'Grounded answer', phase: 'final_answer' }]);
    return 'Grounded answer';
  });
  const request = 'Research recent battery policy updates using current sources.';
  const pending = runCoreTurn({
    sessionId: 'research-first-reply-deadline',
    messages: [{ role: 'user', content: request }],
    tools: [tool], dispatchTool: async () => null, signal, userText: request,
    callbacks: { onText: (_delta, full) => visible.push(full) },
  }, {
    timers: manual.timers,
    firstReplyBudgetMs: 15,
    runResearch: () => { startedResearch(); return new Promise(resolve => { finishResearch = resolve; }); },
  });
  await researchStarted;
  await Promise.resolve();
  manual.fire(15);
  await Promise.resolve();
  finishResearch({ ok: true, output: 'A recent public source.' });
  const result = await pending;

  expect(modelCalls).toBe(2);
  expect(visible[0]).toContain('질문을 확인하고 있습니다');
  expect(result.finalText).toBe('Grounded answer');
});

test('the configured research wall-clock deadline aborts tools and forces a no-tools synthesis from partial evidence', async () => {
  const manual = createManualTimers();
  const stopEvents: Array<Record<string, unknown>> = [];
  spyOn(debug, 'log').mockImplementation((category, _event, data) => {
    if (category === 'research.stop' && data && typeof data === 'object' && !Array.isArray(data)) {
      stopEvents.push(data as Record<string, unknown>);
    }
  });
  let startedResearch!: () => void;
  const researchStarted = new Promise<void>(resolve => { startedResearch = resolve; });
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers, options) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      handlers.onText?.('Provisional answer', 'Provisional answer');
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'Provisional answer', phase: 'final_answer' }]);
      return 'Provisional answer';
    }
    expect(options?.tools).toEqual([]);
    expect(messages.some(message => message.role === 'user' && typeof message.content === 'string'
      && message.content.includes('partial source evidence'))).toBe(true);
    expect(messages.some(message => message.role === 'system' && typeof message.content === 'string'
      && /untrusted (?:partial )?research data/.test(message.content))).toBe(true);
    expect(messages.some(message => message.role === 'system' && typeof message.content === 'string'
      && message.content.includes('Each factual claim must include its own source URL'))).toBe(true);
    handlers.onText?.('Forced synthesis', 'Forced synthesis');
    handlers.onTurnComplete?.([{ role: 'assistant', content: 'Forced synthesis', phase: 'final_answer' }]);
    return 'Forced synthesis';
  });
  const request = 'Research recent battery policy updates using current sources.';
  const pending = runCoreTurn({
    sessionId: 'research-wallclock-deadline',
    messages: [{ role: 'user', content: request }],
    tools: [tool], dispatchTool: async () => null, signal, userText: request,
  }, {
    timers: manual.timers,
    researchWallClockBudgetMs: 30,
    runResearch: (_request, researchSignal) => {
      startedResearch();
      return new Promise(resolve => researchSignal.addEventListener('abort', () => resolve({
        ok: false, output: 'partial source evidence', error: 'research stopped by its deadline',
      }), { once: true }));
    },
  });
  await researchStarted;
  await Promise.resolve();
  manual.fire(30);
  const result = await pending;

  expect(modelCalls).toBe(2);
  expect(result.finalText).toBe('Forced synthesis');
  expect(stopEvents.map(event => event.reason)).toContain('wall-clock-budget');
  expect(stopEvents.map(event => event.reason)).toContain('forced-synthesis');
});

test('empty research output keeps claim source rules during forced synthesis', async () => {
  const manual = createManualTimers();
  let startedResearch!: () => void;
  const researchStarted = new Promise<void>(resolve => { startedResearch = resolve; });
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers, options) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      handlers.onText?.('Provisional answer', 'Provisional answer');
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'Provisional answer', phase: 'final_answer' }]);
      return 'Provisional answer';
    }
    expect(options?.tools).toEqual([]);
    const rule = messages.find(message => message.role === 'system' && typeof message.content === 'string'
      && message.content.includes('Each factual claim must include its own source URL'))?.content;
    expect(rule).toContain('publisher date and checked date');
    expect(rule).toContain('미확인');
    handlers.onText?.('Uncertain answer', 'Uncertain answer');
    handlers.onTurnComplete?.([{ role: 'assistant', content: 'Uncertain answer', phase: 'final_answer' }]);
    return 'Uncertain answer';
  });
  const request = 'Research recent battery policy updates using current sources.';
  const pending = runCoreTurn({
    sessionId: 'research-wallclock-empty-output',
    messages: [{ role: 'user', content: request }],
    tools: [tool], dispatchTool: async () => null, signal, userText: request,
  }, {
    timers: manual.timers,
    researchWallClockBudgetMs: 30,
    runResearch: (_request, researchSignal) => {
      startedResearch();
      return new Promise(resolve => researchSignal.addEventListener('abort', () => resolve({
        ok: false, output: '', error: 'research stopped by its deadline',
      }), { once: true }));
    },
  });
  await researchStarted;
  await Promise.resolve();
  manual.fire(30);
  const result = await pending;

  expect(modelCalls).toBe(2);
  expect(result.finalText).toBe('Uncertain answer');
});

test('the research deadline synthesizes when a cancelled native tool never settles', async () => {
  const manual = createManualTimers();
  let startedResearch!: () => void;
  const researchStarted = new Promise<void>(resolve => { startedResearch = resolve; });
  let researchSignal: AbortSignal | undefined;
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers, options) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      handlers.onText?.('Provisional answer', 'Provisional answer');
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'Provisional answer', phase: 'final_answer' }]);
      return 'Provisional answer';
    }
    expect(options?.tools).toEqual([]);
    handlers.onText?.('Deadline answer', 'Deadline answer');
    handlers.onTurnComplete?.([{ role: 'assistant', content: 'Deadline answer', phase: 'final_answer' }]);
    return 'Deadline answer';
  });
  const request = 'Research recent battery policy updates using current sources.';
  const pending = runCoreTurn({
    sessionId: 'research-deadline-unsettled-tool',
    messages: [{ role: 'user', content: request }],
    tools: [tool], dispatchTool: async () => null, signal, userText: request,
  }, {
    timers: manual.timers,
    researchWallClockBudgetMs: 30,
    runResearch: (_request, signal) => {
      researchSignal = signal;
      startedResearch();
      // Models a native search/fetch adapter that doesn't honor AbortSignal.
      return new Promise(() => {});
    },
  });
  await researchStarted;
  await Promise.resolve();
  manual.fire(30);
  const result = await pending;

  expect(researchSignal?.aborted).toBe(true);
  expect(modelCalls).toBe(2);
  expect(result.finalText).toBe('Deadline answer');
});

test('unnamed English and Korean skill mentions keep the research evidence prepass', async () => {
  const requests = [
    'Use a skill to research one practical source on fuzzy skill discovery.',
    '스킬을 사용해서 fuzzy skill discovery를 깊게 조사해줘.',
  ];
  for (const request of requests) expect(isResearchAgentIntent(request)).toBe(true);
  let researchCalls = 0;
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, _handlers, options) => {
    modelCalls += 1;
    if (modelCalls % 2 === 1) {
      expect(options?.tools?.map(spec => spec.name)).toEqual(['Read']);
      expect(messages.some(message => message.role === 'system'
        && typeof message.content === 'string' && /later evidence-reconciliation phase can use tools/i.test(message.content))).toBe(true);
      return 'provisional answer';
    }
    expect(options?.tools?.map(spec => spec.name)).toEqual(['Read']);
    return 'evidence-reconciled answer';
  });
  let resultText = '';
  for (const [index, request] of requests.entries()) {
    const result = await runCoreTurn({
      sessionId: `research-unnamed-skill-mention-${index}`,
      messages: [{ role: 'user', content: request }],
      tools: [tool, skillExecTool], dispatchTool: async () => null, signal, userText: request,
    }, { runResearch: async () => {
      researchCalls += 1;
      return { ok: true, output: 'research evidence' };
    } });
    resultText = result.finalText;
  }

  expect(researchCalls).toBe(2);
  expect(modelCalls).toBe(4);
  expect(resultText).toBe('evidence-reconciled answer');
});

test('streams the first answer before awaiting a pending research prepass', async () => {
  let resolveResearch!: (result: { ok: boolean; output: string }) => void;
  let modelCalls = 0;
  let researchStarted = false;
  const statuses: string[] = [];
  const visible: string[] = [];
  let resolveFirstStream!: () => void;
  const firstStreamStarted = new Promise<void>(resolve => { resolveFirstStream = resolve; });
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      expect(messages.some(message => message.role === 'system'
        && typeof message.content === 'string' && /later evidence-reconciliation phase can use tools/i.test(message.content))).toBe(true);
      handlers.onText('first answer', 'first answer');
      resolveFirstStream();
    }
    return modelCalls === 1 ? 'first answer' : 'revised answer';
  });
  const pendingTurn = runCoreTurn({
    sessionId: 'research-prepass-nonblocking',
    messages: [{ role: 'user', content: 'compare bond yields' }],
    tools: [tool], dispatchTool: async () => null, signal,
    userText: 'compare bond yields', callbacks: {
      onStatus: line => statuses.push(line),
      onText: (_delta, full) => visible.push(full),
    },
  }, { runResearch: () => {
    researchStarted = true;
    return new Promise(resolve => { resolveResearch = resolve; });
  } });

  await firstStreamStarted;
  expect(researchStarted).toBe(true);
  expect(modelCalls).toBe(1);
  expect(statuses[0]).toContain('Read로 질문에 나온 주제와 요구 조건의 근거를 찾습니다.');
  expect(statuses[0]).toContain('출처의 주장과 제약을 비교해 확인된 사실을 가립니다.');
  expect(statuses[0]).toContain('확인한 결론과 짧은 근거로 답합니다.');
  expect(statuses).not.toContain('먼저 답변을 시작하고 근거를 확인합니다.');
  expect(visible).toContain('first answer');

  resolveResearch({ ok: true, output: 'counterevidence' });
  const result = await pendingTurn;
  expect(modelCalls).toBe(2);
  expect(statuses).toContain('근거를 반영해 답변을 보강합니다.');
  expect(result.finalText).toBe('revised answer');
});

test('commits only the evidence-reconciled answer and replaces the provisional stream', async () => {
  const completions: unknown[][] = [];
  const visibleDeltas: string[] = [];
  const replacements: string[] = [];
  const callbackOrder: string[] = [];
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers, options) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      expect(options?.tools?.map(spec => spec.name)).toEqual(['Read']);
      handlers.onText('draft', 'draft');
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'provisional', phase: 'final_answer' }]);
      return 'provisional';
    }
    expect(messages.some(message => typeof message.content === 'string' && message.content.includes('<bloom-research>'))).toBe(true);
    expect(options?.tools?.map(spec => spec.name)).toEqual(['Read']);
    handlers.onText('grounded', 'grounded');
    handlers.onTurnComplete?.([{ role: 'assistant', content: 'grounded answer', phase: 'final_answer' }]);
    return 'grounded answer';
  });
  const result = await runCoreTurn({
    sessionId: 'research-single-commit',
    messages: [{ role: 'user', content: 'compare bond yields' }],
    tools: [tool], dispatchTool: async () => null, signal,
    userText: 'compare bond yields',
    callbacks: {
      onText: delta => visibleDeltas.push(delta),
      onReplaceText: full => { callbackOrder.push('replace'); replacements.push(full); },
      onTurnComplete: messages => { callbackOrder.push('complete'); completions.push(messages); },
    },
  }, { runResearch: async () => ({ ok: true, output: 'counterevidence' }) });

  expect(result.finalText).toBe('grounded answer');
  expect(completions).toHaveLength(1);
  expect(completions[0]).toEqual([{ role: 'assistant', content: 'grounded answer', phase: 'final_answer' }]);
  expect(visibleDeltas).toEqual(['draft']);
  expect(replacements).toEqual(['grounded answer']);
  expect(callbackOrder).toEqual(['replace', 'complete']);
});

test('a synthesis stream without a completion frame still replaces the provisional answer once', async () => {
  const completions: unknown[][] = [];
  const replacements: string[] = [];
  const callbackOrder: string[] = [];
  const toolHistory = [
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'read-1', name: 'Read', input: { path: 'notes.md' } }] },
    { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'read-1', content: 'market notes' }] },
  ];
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      handlers.onText('draft', 'draft');
      handlers.onTurnComplete?.(toolHistory);
      return 'provisional answer';
    }
    handlers.onText?.('final answer', 'final answer');
    return 'final answer';
  });
  const result = await runCoreTurn({
    sessionId: 'research-no-synthesis-completion-frame',
    messages: [{ role: 'user', content: 'compare bond yields' }],
    tools: [tool], dispatchTool: async () => null, signal, userText: 'compare bond yields',
    callbacks: {
      onReplaceText: text => { callbackOrder.push('replace'); replacements.push(text); },
      onTurnComplete: messages => { callbackOrder.push('complete'); completions.push(messages); },
    },
  }, { runResearch: async () => ({ ok: true, output: 'evidence' }) });

  expect(result.finalText).toBe('final answer');
  expect(replacements).toEqual(['final answer']);
  expect(completions).toEqual([[
    ...toolHistory,
    { role: 'assistant', content: 'final answer', phase: 'final_answer' },
  ]]);
  expect(callbackOrder).toEqual(['replace', 'complete']);
});

test('aborting while research is pending returns the provisional turn and signals research', async () => {
  const controller = new AbortController();
  let researchSignal: AbortSignal | undefined;
  let resolveFirstStream!: () => void;
  const firstStreamStarted = new Promise<void>(resolve => { resolveFirstStream = resolve; });
  const completions: unknown[][] = [];
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    handlers.onText('provisional answer', 'provisional answer');
    handlers.onTurnComplete?.([{ role: 'assistant', content: 'provisional answer', phase: 'final_answer' }]);
    resolveFirstStream();
    return 'provisional answer';
  });
  const pendingTurn = runCoreTurn({
    sessionId: 'research-abort-pending',
    messages: [{ role: 'user', content: 'compare bond yields' }],
    tools: [tool], dispatchTool: async () => null, signal: controller.signal,
    userText: 'compare bond yields', callbacks: { onTurnComplete: messages => completions.push(messages) },
  }, { runResearch: (_request, signal) => {
    researchSignal = signal;
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ ok: false, output: '' }), { once: true }));
  } });

  await firstStreamStarted;
  controller.abort();
  const result = await pendingTurn;
  expect(researchSignal?.aborted).toBe(true);
  expect(result).toMatchObject({ stopReason: 'aborted', finalText: 'provisional answer' });
  expect(completions).toHaveLength(1);
  expect(completions[0]).toEqual([{ role: 'assistant', content: 'provisional answer', phase: 'final_answer' }]);
});

test('failed synthesis resolves with the visible provisional answer and commits it once', async () => {
  const completions: unknown[][] = [];
  const visible: string[] = [];
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      handlers.onText('provisional', 'provisional');
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'provisional', phase: 'final_answer' }]);
      return 'provisional';
    }
    handlers.onText('partial grounded text', 'partial grounded text');
    throw new Error('synthesis failed');
  });
  const pendingTurn = runCoreTurn({
    sessionId: 'research-synthesis-failure',
    messages: [{ role: 'user', content: 'compare bond yields' }],
    tools: [tool], dispatchTool: async () => null, signal, userText: 'compare bond yields',
    callbacks: {
      onText: (_delta, full) => visible.push(full),
      onTurnComplete: messages => completions.push(messages),
    },
  }, { runResearch: async () => ({ ok: true, output: 'evidence' }) });

  await expect(pendingTurn).resolves.toMatchObject({ stopReason: 'end_turn', finalText: 'provisional' });
  expect(visible).toEqual(['provisional']);
  expect(completions).toHaveLength(1);
  expect(completions[0]).toEqual([{ role: 'assistant', content: 'provisional', phase: 'final_answer' }]);
});

test('aborting synthesis keeps the provisional answer visible and committed', async () => {
  const controller = new AbortController();
  const completions: unknown[][] = [];
  const statuses: string[] = [];
  let secondPassStarted!: () => void;
  let modelCalls = 0;
  const synthesisStarted = new Promise<void>(resolve => { secondPassStarted = resolve; });
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'provisional', phase: 'final_answer' }]);
      return 'provisional';
    }
    secondPassStarted();
    handlers.onText('partial synthesis', 'partial synthesis');
    return new Promise((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  const pendingTurn = runCoreTurn({
    sessionId: 'research-synthesis-abort',
    messages: [{ role: 'user', content: 'compare bond yields' }],
    tools: [tool], dispatchTool: async () => null, signal: controller.signal,
    userText: 'compare bond yields',
    callbacks: {
      onTurnComplete: messages => completions.push(messages),
      onStatus: line => statuses.push(line),
    },
  }, { runResearch: async () => ({ ok: true, output: 'evidence' }) });

  await synthesisStarted;
  controller.abort();
  await expect(pendingTurn).resolves.toMatchObject({ stopReason: 'aborted', finalText: 'provisional' });
  expect(completions).toEqual([[{ role: 'assistant', content: 'provisional', phase: 'final_answer' }]]);
  expect(statuses).not.toContain('근거 반영에 실패해 첫 답변을 유지합니다.');
});

test('synthesis authentication failure preserves the auth-rejected stop reason', async () => {
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'provisional', phase: 'final_answer' }]);
      return 'provisional';
    }
    throw new Error('authentication required');
  });
  const result = await runCoreTurn({
    sessionId: 'research-synthesis-auth-rejected',
    messages: [{ role: 'user', content: 'compare bond yields' }],
    tools: [tool], dispatchTool: async () => null, signal, userText: 'compare bond yields',
  }, { runResearch: async () => ({ ok: true, output: 'evidence' }) });

  expect(result).toMatchObject({
    stopReason: 'auth_rejected', finalText: 'provisional', errorMessage: 'authentication required',
  });
});

test('keeps successful synthesis tool history even when the final text matches the provisional answer', async () => {
  const completions: unknown[][] = [];
  const replacements: string[] = [];
  const toolHistory = [
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'read-1', name: 'Read', input: { path: 'notes.md' } }] },
    { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'read-1', content: 'market notes' }] },
    { role: 'assistant' as const, content: 'provisional', phase: 'final_answer' as const },
  ];
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'provisional', phase: 'final_answer' }]);
      return 'provisional';
    }
    await handlers.dispatchTool('Read', { path: 'notes.md' });
    handlers.onTurnComplete?.(toolHistory);
    return 'provisional';
  });
  await runCoreTurn({
    sessionId: 'research-same-text-tool-history',
    messages: [{ role: 'user', content: 'compare bond yields from my notes' }],
    tools: [tool], dispatchTool: async () => 'market notes',
    signal, userText: 'compare bond yields from my notes',
    callbacks: {
      onTurnComplete: messages => completions.push(messages),
      onReplaceText: text => replacements.push(text),
    },
  }, { runResearch: async () => ({ ok: true, output: 'evidence' }) });

  expect(completions).toEqual([toolHistory]);
  expect(replacements).toEqual([]);
});

test('failed research fallback retains non-search tool coverage', async () => {
  let modelCalls = 0;
  let dispatches = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers, options) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      expect(options?.tools?.map(spec => spec.name)).toEqual(['Read']);
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'provisional', phase: 'final_answer' }]);
      return 'provisional';
    }
    expect(options?.tools?.map(spec => spec.name)).toEqual(['Read']);
    await handlers.dispatchTool('Read', {});
    handlers.onTurnComplete?.([{ role: 'assistant', content: 'tool-informed answer', phase: 'final_answer' }]);
    return 'tool-informed answer';
  });
  const result = await runCoreTurn({
    sessionId: 'research-failure-tool-fallback',
    messages: [{ role: 'user', content: 'compare bond yield changes from my notes' }],
    tools: [tool], dispatchTool: async () => { dispatches += 1; return 'note content'; },
    signal, userText: 'compare bond yield changes from my notes',
  }, { runResearch: async () => ({ ok: false, output: '', error: 'search failed' }) });

  expect(modelCalls).toBe(2);
  expect(dispatches).toBe(1);
  expect(result.finalText).toBe('tool-informed answer');
});

test('does not invoke the Bloom research pipeline for a non-research TUI turn', async () => {
  let calls = 0;
  await runCoreTurn({
    sessionId: 'ordinary-chat-turn',
    messages: [{ role: 'user', content: 'Say hello.' }],
    tools: [tool], dispatchTool: async () => null, signal, userText: 'Say hello.',
  }, { runResearch: async () => {
    calls += 1;
    return { ok: true, output: 'unexpected evidence' };
  } });
  expect(calls).toBe(0);
});
