import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMMessage, LLMToolSpec } from '../llm.js';
import type { ToolRuntime } from '../tool-runtime/types.js';
import * as llmModule from '../llm.js';
import * as deferredModule from './tier-flip.js';
import { buildDashboardTurnPreamble } from '../dashboard/turn-preamble.js';
import { getUserConfig } from '../user-config.js';
import {
  buildSubagentSessionRuntimeToolSpecs,
  buildSessionRuntimeTurnSystemMessages,
  createSessionPostureState,
  resolveSessionSurfaceProfile,
  resolveDynamicSessionNativeToolSpecs,
  resolveSessionTurnProfileWithHistory,
} from './index.js';
import { runCoreTurn } from '../core-turn/run-core-turn.js';

const correction = '앞서 그 스킬을 쓴 게 맞나요?';
const originalRequest = '이번 주 한국 시장 변화와 관련 뉴스를 omni-crawl, omni-market, kr-flow로 조사해 분석해줘.';
const toolSpecs: LLMToolSpec[] = [
  { name: 'elanous_skills_list', description: 'List installed skills', parameters: { type: 'object', properties: {} } },
  { name: 'skill_exec', description: 'Run an installed skill', parameters: { type: 'object', properties: {} } },
  { name: 'OmniSearch', description: 'Search current market evidence', parameters: { type: 'object', properties: {} } },
];
const signal = new AbortController().signal;

function turnProfile(surfaceId: 'research/turn' | 'research/agent') {
  const surface = resolveSessionSurfaceProfile({ preferredSurfaceId: surfaceId });
  return {
    surface,
    activeIntent: null,
    preferredSurfaceId: surfaceId,
    surfaceSelectionMode: 'fixed' as const,
    shouldInjectControlManual: false,
    inputMode: 'general' as const,
    inputSource: null,
    inputSourceKind: null,
  };
}

function guidanceFor(surfaceId: 'research/turn' | 'research/agent'): string {
  return buildSessionRuntimeTurnSystemMessages(turnProfile(surfaceId), correction)
    .map(message => String(message.content)).join('\n');
}

afterEach(() => mock.restore());

test('Agent child catalog keeps research tools and skill execution beyond the parent surface catalog', () => {
  const skillRuntime: ToolRuntime = {
    id: 'skill_exec',
    spec: { name: 'skill_exec', description: 'Run an installed skill', parameters: { type: 'object', properties: {} } },
    run: async () => ({ output: 'ok' }),
    surfaces: ['tui'],
  };
  const specs = buildSubagentSessionRuntimeToolSpecs({
    hostTools: [],
    runtimeTools: [skillRuntime],
    optionalTools: [],
    toolAvailability: { OmniSearch: true, WebFetch: true, skill_exec: true },
  });
  const names = specs.map(spec => spec.name);
  expect(names).toContain('OmniSearch');
  expect(names).toContain('WebFetch');
  expect(names).toContain('skill_exec');

  const researchSurface = resolveSessionSurfaceProfile({ preferredSurfaceId: 'research/agent' });
  const researchParentNames = resolveDynamicSessionNativeToolSpecs({
    userText: '',
    defaultFamilyIds: researchSurface.defaultNativeFamilyIds,
    surfaceId: researchSurface.id,
    toolAvailability: { WebSearch: true, OmniSearch: true, WebFetch: true },
  }).map(spec => spec.name);
  expect(researchParentNames).toContain('OmniSearch');
  expect(researchParentNames).toContain('WebFetch');
});

test('Agent child catalog falls back to the captured parent host tools when runtime tools are absent', () => {
  const parentHostTool = {
    name: 'ParentHostFallback',
    description: 'Captured TUI host tool',
    parameters: { type: 'object', properties: {} },
    handler: async () => 'ok',
  };
  const specs = buildSubagentSessionRuntimeToolSpecs({
    hostTools: [parentHostTool],
    runtimeTools: [],
    optionalTools: [],
  });
  expect(specs.map(spec => spec.name)).toContain('ParentHostFallback');
});

test('research turn and agent prompts require same-turn task reconciliation in prose', () => {
  for (const surfaceId of ['research/turn', 'research/agent'] as const) {
    const prompt = guidanceFor(surfaceId);
    expect(prompt).toContain('## Proactive Reconciliation');
    expect(prompt).toContain('continue in this same user turn');
    expect(prompt).toContain('redo the original task');
    expect(prompt).toContain('Do not stop at an apology or verification-only report');
    expect(prompt).toContain('evidence is missing, incomplete, or insufficient');
    expect(prompt.toLowerCase()).toContain('do not emit a raw json dump unless explicitly requested');
  }
  const codingPrompt = buildSessionRuntimeTurnSystemMessages({
    ...turnProfile('research/turn'),
    surface: resolveSessionSurfaceProfile({ preferredSurfaceId: 'coding/turn' }),
  }, correction).map(message => String(message.content)).join('\n');
  expect(codingPrompt).toContain('Tool-use Correction — Reconcile the Original Request This Turn');
});

test('ordinary coding follow-ups that mention checking do not trigger reconciliation guidance', () => {
  const profile = {
    ...turnProfile('research/turn'),
    surface: resolveSessionSurfaceProfile({ preferredSurfaceId: 'coding/turn' }),
  };
  for (const userText of ['빌드 다시 확인해줘', '사용하지 않는 변수 정리해줘', '재확인 부탁해요']) {
    const prompt = buildSessionRuntimeTurnSystemMessages(profile, userText)
      .map(message => String(message.content)).join('\n');
    expect(prompt).not.toContain('Tool-use Correction');
  }
});

test('CEO challenge wording is detected and restores the prior research surface', () => {
  const challenge = '스킬을 제대로 찾으라고 이야기했음에도 확인 후 결말을 조정하지 않았습니다.';
  const chatModeState = createSessionPostureState();
  const profile = resolveSessionTurnProfileWithHistory({
    userText: challenge,
    priorUserTexts: [originalRequest],
    chatModeState,
  });
  expect(profile.surface.id).toBe('research/agent');
  const prompt = buildSessionRuntimeTurnSystemMessages(profile, challenge)
    .map(message => String(message.content)).join('\n');
  expect(prompt).toContain('## Proactive Reconciliation');
  expect(prompt).toContain('continue in this same user turn');
});

test('tool correction wording prompts a rerun and corrected answer instead of a verification-only report', () => {
  const profile = turnProfile('research/agent');
  const prompt = buildSessionRuntimeTurnSystemMessages(
    profile,
    '스킬을 제대로 찾았는지 다시 확인하고 실제 분석을 해주세요.',
  ).map(message => String(message.content)).join('\n');

  expect(prompt).toContain('Tool-use Correction — Reconcile the Original Request This Turn');
  expect(prompt).toContain('Treat the original task as still open');
  expect(prompt).toContain('answer the original task with the corrected, evidence-grounded result');
  expect(prompt).toContain('Do not stop at an apology or verification-only report');
});

test('a short evidence challenge inherits the most recent research surface only for reconciliation', () => {
  const chatModeState = createSessionPostureState();
  const followUp = resolveSessionTurnProfileWithHistory({
    userText: correction,
    priorUserTexts: [originalRequest],
    chatModeState,
  });
  expect(followUp.surface.id).toBe('research/agent');
  const ordinaryToolFollowUp = resolveSessionTurnProfileWithHistory({
    userText: '그 도구로 확인해줘',
    priorUserTexts: [originalRequest],
    chatModeState,
  });
  expect(ordinaryToolFollowUp.surface.id).toBe('coding/turn');
  const ordinary = resolveSessionTurnProfileWithHistory({
    userText: '고마워요.',
    priorUserTexts: [originalRequest],
    chatModeState,
  });
  expect(ordinary.surface.id).toBe('coding/turn');
});

test('classic mock replay verifies tools, uses their results to redo the prior task, and answers in-turn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'classic-proactive-reconcile-'));
  const chatModeState = createSessionPostureState();
  const profile = resolveSessionTurnProfileWithHistory({
    userText: correction,
    priorUserTexts: [originalRequest],
    chatModeState,
  });
  const preamble = buildDashboardTurnPreamble({
    userText: correction,
    cwd,
    userConfig: getUserConfig(),
    memory: false,
    turnProfile: profile,
    enabledTools: toolSpecs.map(tool => tool.name),
  });
  const deferredSpy = spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages], tools: [...tools],
    stats: {
      activeCount: tools.length, deferredCount: 0, warmPreloaded: [], injected: false,
      deferredNames: [], unhydratableNames: [], unhydratableCount: 0,
    },
  } as unknown as ReturnType<typeof deferredModule.applyDeferredTools>));
  const calls: string[] = [];
  let replayResults: unknown[] = [];
  let modelCalls = 0;
  let finalAnswer = '';
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    modelCalls += 1;
    expect(messages.some(message => message.role === 'system'
      && String(message.content).includes('## Proactive Reconciliation'))).toBe(true);
    expect(messages.filter(message => message.role === 'user')).toHaveLength(2);
    expect(messages.some(message => message.role === 'user' && message.content === originalRequest)).toBe(true);
    expect(messages.some(message => message.role === 'user' && message.content === correction)).toBe(true);
    expect(messages.some(message => message.role === 'assistant'
      && String(message.content).includes('"skill_status"'))).toBe(true);
    for (const [index, name, args] of [
      [0, 'elanous_skills_list', { query: 'omni market flow' }],
      [1, 'skill_exec', { name: 'omni-crawl' }],
      [2, 'skill_exec', { name: 'omni-market' }],
      [3, 'skill_exec', { name: 'kr-flow' }],
      [4, 'OmniSearch', { query: '이번 주 한국 시장 변화' }],
    ] as const) {
      calls.push(name);
      replayResults.push(await handlers.dispatchTool(name, args, { callId: `recheck-${index}` }));
    }
    const evidence = replayResults.map(result => String((result as { evidence?: string }).evidence ?? '')).join(' · ');
    expect(evidence).toContain('verified:skill_exec:omni-crawl');
    finalAnswer = `재확인한 도구 결과(${evidence})를 반영해 원래 이번 주 한국 시장 분석을 다시 수행했습니다.`;
    handlers.onText(finalAnswer, finalAnswer);
    handlers.onTurnComplete?.([{ role: 'assistant', content: finalAnswer, phase: 'final_answer' }]);
    return finalAnswer;
  });

  try {
    const messages: LLMMessage[] = [
      ...preamble,
      { role: 'user', content: originalRequest },
      { role: 'assistant', content: '{"summary":{"결론":"스킬 사용을 확인할 수 없습니다."},"skill_status":{}}' },
      { role: 'user', content: correction },
    ];
    const result = await runCoreTurn({
      sessionId: 'proactive-reconcile-classic-mock',
      messages,
      userText: correction,
      tools: toolSpecs,
      dispatchTool: async (name, args) => ({
        ok: true, name, evidence: `verified:${name}:${String(args.name ?? args.query ?? '')}`,
      }),
      signal,
    });
    expect(deferredSpy).toHaveBeenCalledTimes(1);
    expect(modelCalls).toBe(1);
    expect(calls).toEqual(['elanous_skills_list', 'skill_exec', 'skill_exec', 'skill_exec', 'OmniSearch']);
    expect(replayResults).toHaveLength(5);
    expect(result.finalText).toBe(finalAnswer);
    expect(result.finalText.startsWith('{')).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
