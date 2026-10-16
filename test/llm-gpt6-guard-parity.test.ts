// TUI-GPT6-GUARD-PARITY (2026-10-16 · tui-op-issues #61) — codex 계열 «모델 행동» 도구 루프 가드가
// gpt-6 세대(운영 기본 gpt-6-sol · gpt-6-luna)에서도 켜진다. 판정 단일 원천 = models/prompts.ts
// `usesCodexBehaviorGuards`. 프롬프트 계열(getModelFamily → 'gpt')은 그대로 — gpt6 addendum 을 잃지 않는다.
// 반증: llm.ts 의 `codexBehaviorGuards` 를 `modelFamily === 'codex'` 로 되돌리면 gpt-6 칸이 fail 한다.

import { afterEach, describe, expect, test } from 'bun:test';
import { streamLLMWithTools } from '../src/llm';
import type { LLMProvider, LLMStreamEvent } from '../src/llm';
import { getModelFamily, isGpt6GenerationModel, usesCodexBehaviorGuards } from '../src/models/prompts';
import { __resetSnapshotStore, __resetTurnState } from '../src/undo-turn/index.js';
import { resetPlanModeState } from '../src/plan-mode/index.js';
import { setUserConfigOverlay } from '../src/user-config.js';

afterEach(() => {
  __resetSnapshotStore();
  __resetTurnState();
  resetPlanModeState();
  setUserConfigOverlay(null);
});

function scriptedProvider(turns: LLMStreamEvent[][], chatText: string | null = null): LLMProvider {
  let call = 0;
  return {
    name: 'scripted',
    defaultModel: 'd',
    available: () => true,
    async *streamChat() {
      const events = turns[call++] ?? [];
      for (const ev of events) yield ev;
    },
    async *chat() {
      if (chatText !== null) yield chatText;
    },
  };
}

const GPT6_IDS = ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'GPT-6-Sol', 'openrouter/openai/gpt-6-sol'];
const OLD_CODEX_IDS = ['gpt-5.4', 'gpt-5.6-terra', 'gpt-5.3-codex', 'codex-mini-latest'];
const NON_GUARDED_IDS = [
  undefined, '', 'claude-opus-4-6', 'grok-4', 'gemini-2.5-pro', 'gpt-4.1', 'o3-mini',
  'openrouter/z-ai/glm-5.3', 'openrouter/moonshotai/kimi-k2', 'local:qwen3', 'openai/gpt-6-sol', 'd',
];

describe('usesCodexBehaviorGuards — 단일 원천 판정', () => {
  test('gpt-6 세대(직결 · OpenRouter 게이트웨이)는 true', () => {
    for (const id of GPT6_IDS) {
      expect(isGpt6GenerationModel(id)).toBe(true);
      expect(usesCodexBehaviorGuards(id)).toBe(true);
    }
  });
  test('옛 codex 계열은 그대로 true', () => {
    for (const id of OLD_CODEX_IDS) {
      expect(getModelFamily(id)).toBe('codex');
      expect(usesCodexBehaviorGuards(id)).toBe(true);
    }
  });
  test('비 OpenAI·gpt-6 아닌 OpenAI·맨 openai/ id 는 false', () => {
    for (const id of NON_GUARDED_IDS) expect(usesCodexBehaviorGuards(id)).toBe(false);
  });
  test('프롬프트 계열은 안 바뀐다 — gpt-6 은 여전히 gpt (gpt6 addendum · GPT 변형 유지)', () => {
    expect(getModelFamily('gpt-6-sol')).toBe('gpt');
    expect(getModelFamily('gpt-6-luna')).toBe('gpt');
    expect(getModelFamily('openrouter/openai/gpt-6-sol')).toBe('gpt');
  });
});

async function runAnchorGrep(model: string): Promise<string> {
  let toolResultText: unknown = null;
  const provider = scriptedProvider([
    [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', glob: 'AGENTS.md', output_mode: 'content' } }],
    [],
  ]);
  await streamLLMWithTools(
    [{ role: 'user', content: 'q' }],
    {
      onText: () => {},
      onToolResult: (r) => { toolResultText = r.result; },
      dispatchTool: async () => 'ACTUAL_DISPATCH_HAPPENED',
    },
    { provider, model, tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }] },
  );
  return String(toolResultText);
}

describe('W4-anchor — gpt-6 에서도 앵커 Grep 차단', () => {
  test('gpt-6-sol', async () => {
    expect(await runAnchorGrep('gpt-6-sol')).toContain('ANCHOR GREP BLOCKED');
  });
  test('openrouter/openai/gpt-6-luna', async () => {
    expect(await runAnchorGrep('openrouter/openai/gpt-6-luna')).toContain('ANCHOR GREP BLOCKED');
  });
  test('옛 codex(gpt-5.4) 불변', async () => {
    expect(await runAnchorGrep('gpt-5.4')).toContain('ANCHOR GREP BLOCKED');
  });
  test('비 codex·비 gpt-6(gpt-4.1 · claude) 는 그대로 디스패치', async () => {
    expect(await runAnchorGrep('gpt-4.1')).toBe('ACTUAL_DISPATCH_HAPPENED');
    expect(await runAnchorGrep('claude-opus-4-6')).toBe('ACTUAL_DISPATCH_HAPPENED');
  });
});

describe('W5-A — gpt-6 에서도 리터럴 경로 Glob 차단', () => {
  test('gpt-6-luna', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Glob', args: { pattern: 'src/debug-log.ts', path: '.' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      { onText: () => {}, onToolResult: (r) => { toolResultText = r.result; }, dispatchTool: async () => 'ACTUAL' },
      { provider, model: 'gpt-6-luna', tools: [{ name: 'Glob', description: 'd', parameters: { type: 'object' } }] },
    );
    expect(String(toolResultText)).toContain('LITERAL-PATH GLOB BLOCKED');
  });
});

describe('W4-A — gpt-6 에서도 Read 3회 뒤 넓은 탐색 차단(Read 계수 포함)', () => {
  test('gpt-6-sol', async () => {
    const stubs: string[] = [];
    const dispatched: string[] = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'r1', name: 'Read', args: { file_path: '/tmp/a.ts' } }],
      [{ type: 'tool_call', id: 'b1', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'r2', name: 'Read', args: { file_path: '/tmp/b.ts' } }],
      [{ type: 'tool_call', id: 'b2', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'r3', name: 'Read', args: { file_path: '/tmp/c.ts' } }],
      [{ type: 'tool_call', id: 'b3', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'g1', name: 'Glob', args: { pattern: 'src/**/*.ts' } }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => {
          if (typeof r.result === 'string' && r.result.includes('POST-READ BROAD SEARCH BLOCKED')) stubs.push(r.result);
        },
        dispatchTool: async (name) => { dispatched.push(name); return 'r'; },
      },
      {
        provider,
        model: 'gpt-6-sol',
        tools: [
          { name: 'Read', description: 'd', parameters: { type: 'object' } },
          { name: 'Glob', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 10,
      },
    );
    expect(dispatched).not.toContain('Glob');
    expect(stubs.length).toBeGreaterThanOrEqual(1);
    expect(stubs[0]).toContain('inspected 3 file(s)');
  });
});

describe('W5-E/F — gpt-6 도 hard-stop·예산 소진 때 도구 없는 강제 종합을 한 번 받는다', () => {
  const readTurn = (id: string): LLMStreamEvent[] => [
    { type: 'tool_call', id, name: 'Read', args: { file_path: `/tmp/${id}.ts` } },
  ];
  const SYNTH = 'Here is the synthesis: the project has 3 modules wired through the central dispatcher.';
  async function run(model: string): Promise<string> {
    const provider = scriptedProvider(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(readTurn),
      SYNTH,
    );
    return streamLLMWithTools(
      [{ role: 'user', content: 'analyze' }],
      { onText: () => {}, dispatchTool: async () => 'tool-out' },
      { provider, model, tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }], maxTurns: 8 },
    );
  }
  test('gpt-6-sol — 종합 텍스트가 폴백 안내를 대신한다', async () => {
    const result = await run('gpt-6-sol');
    expect(result).toContain('the project has 3 modules');
  });
  test('gpt-4.1(비 대상) — 강제 종합이 새지 않는다', async () => {
    const result = await run('gpt-4.1');
    expect(result).not.toContain('the project has 3 modules');
  });
});
