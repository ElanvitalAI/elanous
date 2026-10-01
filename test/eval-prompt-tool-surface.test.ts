import { afterEach, describe, expect, test } from 'bun:test';
import { nativeToolCatalog } from '../src/native-tool-catalog.js';
import { splitDeferredToolSpecs } from '../src/session-runtime/tier-flip.js';
import type { UserConfig } from '../src/user-config.js';
import {
  EVAL_PROMPT_TOOL_SURFACES,
  buildEvalPromptToolSurface,
  isEvalPromptToolSurface,
  rejectAssertionsOutsideToolSurface,
  runEvalPrompt,
} from '../src/eval-prompt-cli.js';

const cfg = {
  chat: { toolDeny: [] },
  finance: { enabled: false },
} as unknown as UserConfig;

const LEGACY_CLI_TOOLS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Grep',
  'Glob',
  'ListDir',
  'AstGrep',
  'Lsp',
  'WebFetch',
  'WebSearch',
];

const originalCodexToolset = process.env.ELANOUS_CODEX_TOOLSET;
const originalTuiTools = process.env.ELANOUS_EVAL_INCLUDE_TUI_TOOLS;

afterEach(() => {
  if (originalCodexToolset === undefined) delete process.env.ELANOUS_CODEX_TOOLSET;
  else process.env.ELANOUS_CODEX_TOOLSET = originalCodexToolset;
  if (originalTuiTools === undefined) delete process.env.ELANOUS_EVAL_INCLUDE_TUI_TOOLS;
  else process.env.ELANOUS_EVAL_INCLUDE_TUI_TOOLS = originalTuiTools;
});

describe('elanous repro tool surface selection', () => {
  test('cli default preserves the legacy non-codex tool-name array', () => {
    delete process.env.ELANOUS_CODEX_TOOLSET;
    delete process.env.ELANOUS_EVAL_INCLUDE_TUI_TOOLS;
    expect(buildEvalPromptToolSurface('cli', 'claude', cfg).specs.map((tool) => tool.name))
      .toEqual(LEGACY_CLI_TOOLS);
  });

  test('chat selects daemon chat specs and dispatcher', async () => {
    const selected = buildEvalPromptToolSurface('chat', 'claude', cfg);
    expect(selected.specs.map((tool) => tool.name)).toContain('schedule_manage');
    expect(selected.specs.map((tool) => tool.name)).toContain('SelfImplement');
    expect(selected.daemon?.kind).toBe('chat');
    const result = await selected.daemon?.dispatch(
      'ToolSearch',
      { query: 'select:Read' },
      { cwd: process.cwd(), signal: new AbortController().signal },
    );
    expect((result as { matched?: string[] }).matched).toContain('Read');
  });

  test('webterm derives deferred daemon specs from catalog metadata and injects ToolSearch', () => {
    const selected = buildEvalPromptToolSurface('webterm', 'claude', cfg);
    const expectedDeferred = selected.specs.flatMap((spec) => {
      const catalogEntry = nativeToolCatalog.find((tool) => tool.displayName === spec.name);
      return catalogEntry?.alwaysLoad === false && catalogEntry.shouldDefer === true
        ? [spec.name]
        : [];
    });
    const split = splitDeferredToolSpecs(selected.specs);
    const deferred = split.deferred.map((tool) => tool.name);

    expect(deferred).toEqual(expectedDeferred);
    expect(split.active.map((tool) => tool.name)).toContain('SelfImplement');
    expect(split.active.map((tool) => tool.name)).toContain('ToolSearch');
  });

  test('surface validator explicitly rejects unsupported values', () => {
    expect(isEvalPromptToolSurface('cli')).toBe(true);
    expect(isEvalPromptToolSurface('chat')).toBe(true);
    expect(isEvalPromptToolSurface('webterm')).toBe(true);
    expect(isEvalPromptToolSurface('nope')).toBe(false);
  });

  // must-fix(리뷰 #5465): 타입 union 과 런타임 가드가 값을 각각 나열하면 서피스가 늘 때
  // 조용히 어긋난다 → const tuple 단일 출처에서 파생됨을 못박는다.
  test('타입·가드·에러문구가 단일 출처(const tuple)에서 파생된다', () => {
    for (const kind of EVAL_PROMPT_TOOL_SURFACES) {
      expect(isEvalPromptToolSurface(kind)).toBe(true);
      // 각 값이 실제로 서피스를 만든다 — 목록에만 있고 미배선인 값 차단.
      expect(() => buildEvalPromptToolSurface(kind, 'claude', cfg)).not.toThrow();
    }
  });

  // ⭐ must-fix(리뷰 #5465): **핵심 배선 회귀**. 라이브에서 발견한 버그(서피스만 바꾸고
  //   tier-flip 을 안 태워 67툴이 raw 로 나가던 것)를 **어떤 테스트도 잡지 못했다.**
  //   runEvalPrompt 가 (a) tier-flip 결과를 프로바이더에 넘기고 (b) daemon dispatcher 를
  //   고르는지 경계에서 확인한다(provider 주입 seam 으로 실 LLM 없이).
  test('★ runEvalPrompt 가 tier-flip 결과를 프로바이더에 넘기고 daemon dispatcher 를 쓴다', async () => {
    let sawTools: string[] = [];
    const provider = {
      name: 'scripted',
      defaultModel: 'gpt-5.5',
      available: () => true,
      async *streamChat(_h: unknown, o?: { tools?: { name: string }[] }) {
        sawTools = (o?.tools ?? []).map((t) => t.name);
        // deferred 도구를 소환한다 → daemon dispatcher 경유가 결과로 드러난다.
        yield { type: 'tool_call', id: 't1', name: 'ToolSearch', args: { query: 'select:SolveMission' } };
      },
      async *chat() {},
    };

    const r = await runEvalPrompt({
      prompt: 'probe',
      tools: 'webterm',
      silent: true,
      maxTurns: 1,
      provider: provider as never,
    });

    // (a) deferred 는 빠지고 소환기가 실린다 — raw 전량이 아니다.
    expect(sawTools).toContain('ToolSearch');
    expect(sawTools).toContain('SelfImplement');
    // (b) ⚠️ 호출 **횟수**만 보면 host dispatcher 가 에러를 돌려줘도 통과한다(Goodhart).
    //     daemon 경유의 고유 증거인 **하이드레이션 이벤트**로 단언한다 — 이건 소환이
    //     실제 서피스 풀에서 스키마를 찾아 tier-flip 에 흡수됐을 때만 발생한다.
    expect(r.eventCounts['tool-hydrated'] ?? 0).toBeGreaterThanOrEqual(1);
  }, 20000);

  test('min/max assertions reject unavailable surface tools before measurement', async () => {
    const chatTools = buildEvalPromptToolSurface('chat', 'claude', cfg).specs.map((tool) => tool.name);
    const message =
      `tool assertion references unavailable tool(s) for surface "chat": "NoSuchTool"; ` +
      `surface has ${chatTools.length} tool(s): ${chatTools.join(', ')}`;

    expect(() => rejectAssertionsOutsideToolSurface(
      { SelfImplement: 1 },
      { NoSuchTool: 0 },
      'chat',
      chatTools,
    )).toThrow(message);
    expect(() => rejectAssertionsOutsideToolSurface(
      { SelfImplement: 1 },
      undefined,
      'chat',
      chatTools,
    )).not.toThrow();

    const provider = {
      name: 'scripted',
      defaultModel: 'gpt-5.5',
      available: () => true,
      async *streamChat() {},
      async *chat() {},
    };
    await expect(runEvalPrompt({
      prompt: 'probe',
      tools: 'chat',
      silent: true,
      provider: provider as never,
      assertToolMin: { SelfImplement: 1 },
      assertToolMax: { NoSuchTool: 0 },
    })).rejects.toThrow(
      'tool assertion references unavailable tool(s) for surface "chat": "NoSuchTool"; surface has',
    );
  });

  test('denied tools are rejected by min/max assertions before measurement', async () => {
    const provider = {
      name: 'scripted',
      defaultModel: 'gpt-5.5',
      available: () => true,
      async *streamChat() {},
      async *chat() {},
    };

    const finalNames = buildEvalPromptToolSurface('cli', 'codex', cfg).specs
      .map((tool) => tool.name)
      .filter((name) => name !== 'Read');
    const message =
      `tool assertion references unavailable tool(s) for surface "cli": "Read"; ` +
      `surface has ${finalNames.length} tool(s): ${finalNames.join(', ')}`;

    for (const assertions of [
      { assertToolMin: { Read: 1 } },
      { assertToolMax: { Read: 0 } },
    ]) {
      await expect(runEvalPrompt({
        prompt: 'probe',
        tools: 'cli',
        silent: true,
        provider: provider as never,
        toolDeny: ['Read'],
        ...assertions,
      })).rejects.toThrow(message);
    }
  });

  test('JSON result exposes the final provided surface catalog and its count', async () => {
    const provider = {
      name: 'scripted',
      defaultModel: 'gpt-5.5',
      available: () => true,
      async *streamChat() {},
      async *chat() {},
    };
    const expected = buildEvalPromptToolSurface('cli', 'codex', cfg).specs
      .map((tool) => tool.name)
      .filter((name) => name !== 'Read');

    const result = await runEvalPrompt({
      prompt: 'probe',
      tools: 'cli',
      silent: true,
      maxTurns: 1,
      provider: provider as never,
      toolDeny: ['Read'],
    });

    expect(result.toolSurface).toBe('cli');
    expect(result.surfaceToolNames).toEqual(expected);
    expect(result.surfaceToolNames).not.toContain('Read');
    expect(result.surfaceToolCount).toBe(expected.length);
  });
});
