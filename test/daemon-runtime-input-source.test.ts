import { afterEach, beforeEach, describe, expect, test, spyOn, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';

import '../src/nexus/index.js';
import type { AcpTurnContext } from '../src/acp/server.js';
import * as llmModule from '../src/llm.js';
import type { LLMMessage, StreamWithToolsHandlers } from '../src/llm.js';
import * as daemonToolsModule from '../src/boot/daemon-tools/index.js';
import type { DaemonToolDispatchCtx } from '../src/boot/daemon-tools/types.js';
import * as coreTurnModule from '../src/core-turn/index.js';
import type { CoreTurnContext, CoreTurnResult } from '../src/core-turn/index.js';
import { debug } from '../src/debug/log.js';
import {
  buildDaemonInputSourceLine,
  composeDaemonSystemPrompt,
  createDaemonRunTurn,
  createDaemonRuntime,
  DaemonSessionHistory,
} from '../src/boot/daemon-runtime.js';
import { writeInputSourceMeta } from '../src/acp/input-source-meta.js';

type StreamCall = {
  messages: LLMMessage[];
  handlers: StreamWithToolsHandlers;
};
const REPO_ROOT = joinPath(import.meta.dir, '..');
const streamCalls: StreamCall[] = [];
const coreTurnCalls: CoreTurnContext[] = [];
let streamImpl: (call: StreamCall) => Promise<string> = async () => '';

beforeEach(() => {
  streamCalls.length = 0;
  coreTurnCalls.length = 0;
  streamImpl = async () => '';
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(
    (async (messages: LLMMessage[], handlers: StreamWithToolsHandlers): Promise<string> => {
      const call = { messages, handlers };
      streamCalls.push(call);
      return streamImpl(call);
    }) as typeof llmModule.streamLLMWithTools,
  );
});

afterEach(() => {
  streamCalls.length = 0;
  mock.restore();
});

function makeTurnCtx(over: Partial<AcpTurnContext> = {}): AcpTurnContext {
  const userText = over.userText ?? 'hello';
  return {
    sessionId: over.sessionId ?? 'sess-1',
    cwd: over.cwd ?? '/tmp',
    userText,
    promptBlocks: over.promptBlocks ?? [{ type: 'text', text: userText }],
    promptMeta: over.promptMeta,
    isAborted: over.isAborted ?? (() => false),
    push: over.push ?? (async () => {}),
    pushWithMeta: over.pushWithMeta ?? (async () => {}),
    pushSessionUpdate: over.pushSessionUpdate ?? (async () => {}),
    pushToolCall: over.pushToolCall ?? (async () => {}),
    pushToolResult: over.pushToolResult ?? (async () => {}),
    pushUsage: over.pushUsage ?? (async () => {}),
    requestApproval: over.requestApproval ?? (async () => 'deny-once'),
  };
}

describe('daemon runtime input source helpers', () => {
  test('production nexus entrypoint makes the daemon lazy composer require resolvable', () => {
    expect(() => createDaemonRuntime({ tools: 'none' })).not.toThrow();
  });

  test('buildDaemonInputSourceLine formats concise source detail', () => {
    expect(buildDaemonInputSourceLine(writeInputSourceMeta({
      kind: 'voice',
      channel: 'discord',
      mode: 'voice-channel',
    }))).toBe('Input source kind: voice (channel=discord, mode=voice-channel)');
  });

  test('buildDaemonInputSourceLine formats embodied surface provider and capabilities', () => {
    expect(buildDaemonInputSourceLine(writeInputSourceMeta({
      kind: 'browser',
      provider: 'cdp',
      capabilities: ['observe', 'verify'],
    }))).toBe('Input source kind: browser (provider=cdp, capabilities=observe+verify)');
    expect(buildDaemonInputSourceLine(writeInputSourceMeta({
      kind: 'terminal',
      provider: 'tui',
      capabilities: ['act', 'render'],
    }))).toBe('Input source kind: terminal (provider=tui, capabilities=act+render)');
  });

  test('composeDaemonSystemPrompt includes source, self-awareness, and only the current session ID', () => {
    const first = composeDaemonSystemPrompt(
      'Base system prompt',
      writeInputSourceMeta({ kind: 'discord', entry: 'text' }),
      'sess-first',
    );
    const second = composeDaemonSystemPrompt(
      'Base system prompt',
      writeInputSourceMeta({ kind: 'discord', entry: 'text' }),
      'sess-second',
    );
    for (const prompt of [first, second]) {
      expect(prompt).toContain('Input source kind: discord (entry=text)');
      expect(prompt).toContain('[elanous 자기접근 규율]');
      expect(prompt).toContain('logs_query');
      expect(prompt).toContain('debug.log');
      expect(prompt).toContain('elanous self implement');
      expect(prompt).toContain('harness run');
      expect(prompt).toContain('auto-review');
    }
    expect(first).toContain('현재 요청의 session ID: sess-first');
    expect(first).not.toContain('sess-second');
    expect(second).toContain('현재 요청의 session ID: sess-second');
    expect(second).not.toContain('sess-first');
  });
});

describe('createDaemonRunTurn — prompt meta awareness', () => {
  test('threads input source detail into the turn system prompt', async () => {
    const history = new DaemonSessionHistory();
    const runTurn = createDaemonRunTurn(history, {
      systemPrompt: 'daemon base',
    });

    await runTurn(makeTurnCtx({
      sessionId: 'sess-meta',
      userText: 'hello',
      promptMeta: writeInputSourceMeta({
        kind: 'discord',
        channelId: 'chan-1',
        entry: 'text',
      }),
    }));

    expect(streamCalls).toHaveLength(1);
    const system = streamCalls[0]!.messages.find((message) =>
      message.role === 'system' && typeof message.content === 'string'
      && message.content.includes('daemon base'));
    expect(system).toBeDefined();
    expect(String(system!.content)).toContain('Input source kind: discord (entry=text)');
    expect(String(system!.content)).toContain('현재 요청의 session ID: sess-meta');
    expect(String(system!.content)).toContain('logs_query');
    expect(String(system!.content)).toContain('elanous self implement');
  });
});

describe('createDaemonRunTurn — dispatch context userText', () => {
  let dispatchContexts: DaemonToolDispatchCtx[];

  beforeEach(() => {
    dispatchContexts = [];
    spyOn(daemonToolsModule, 'toolSurface').mockReturnValue({
      kind: 'readonly',
      specs: [{ name: 'CaptureCtx', description: '', parameters: { type: 'object' } }],
      dispatch: async (_name, _args, ctx) => {
        dispatchContexts.push(ctx);
        return { ok: true };
      },
    });
  });

  async function dispatchFromTurn(turnCtx: AcpTurnContext): Promise<DaemonToolDispatchCtx> {
    streamImpl = async ({ handlers }) => {
      await handlers.dispatchTool('CaptureCtx', {}, { callId: 'call-1' });
      return '';
    };
    const runTurn = createDaemonRunTurn(new DaemonSessionHistory(), { tools: 'readonly', toolCwd: '/tool-cwd' });
    await runTurn(turnCtx);
    return dispatchContexts.at(-1)!;
  }

  test('ACP tool dispatch uses each session cwd instead of the boot default', async () => {
    streamImpl = async ({ handlers }) => {
      await handlers.dispatchTool('CaptureCtx', {}, { callId: 'call-1' });
      return '';
    };
    const runTurn = createDaemonRunTurn(new DaemonSessionHistory(), {
      tools: 'readonly', toolCwd: '/tmp/boot', acpSessionCwd: true,
    });
    await runTurn(makeTurnCtx({ sessionId: 'a', cwd: '/tmp/a' }));
    await runTurn(makeTurnCtx({ sessionId: 'b', cwd: '/tmp/b' }));
    expect(dispatchContexts.map((ctx) => ctx.cwd)).toEqual(['/tmp/a', '/tmp/b']);
    expect(dispatchContexts.map((ctx) => ctx.resolveWriteCwd!())).toEqual(['/tmp/a', '/tmp/b']);
  });

  test('concurrent ACP turns keep their own cwd across asynchronous tool calls', async () => {
    streamImpl = async ({ handlers }) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await handlers.dispatchTool('CaptureCtx', {}, { callId: 'call-1' });
      return '';
    };
    const runTurn = createDaemonRunTurn(new DaemonSessionHistory(), {
      tools: 'readonly', toolCwd: '/tmp/boot', acpSessionCwd: true,
    });
    await Promise.all([
      runTurn(makeTurnCtx({ sessionId: 'a', cwd: '/tmp/a' })),
      runTurn(makeTurnCtx({ sessionId: 'b', cwd: '/tmp/b' })),
    ]);
    expect(new Set(dispatchContexts.map((ctx) => ctx.cwd))).toEqual(new Set(['/tmp/a', '/tmp/b']));
  });

  test('forwards multi-line human source text while preserving dispatch fields', async () => {
    const userText = '첫 번째 줄\n둘 번째 줄';
    const dispatchCtx = await dispatchFromTurn(makeTurnCtx({ sessionId: 'sess-user-text', userText }));

    expect(dispatchCtx).toMatchObject({
      cwd: '/tool-cwd',
      entry: 'elanous-apparatus',
      sessionId: 'sess-user-text',
      userText,
    });
    expect(dispatchCtx.signal).toBeInstanceOf(AbortSignal);
  });

  test('omits userText when the incoming human source text is absent', async () => {
    const dispatchCtx = await dispatchFromTurn(makeTurnCtx({ userText: '' }));

    expect('userText' in dispatchCtx).toBe(false);
    expect(dispatchCtx).toMatchObject({ cwd: '/tool-cwd', entry: 'elanous-apparatus', sessionId: 'sess-1' });
  });

  test('captures the environment tool cwd during runtime construction before dispatch', async () => {
    const prior = process.env.ELANOUS_TOOL_CWD;
    try {
      process.env.ELANOUS_TOOL_CWD = '/configured-tool-cwd';
      streamImpl = async ({ handlers }) => {
        await handlers.dispatchTool('CaptureCtx', {}, { callId: 'call-1' });
        return '';
      };
      const runTurn = createDaemonRunTurn(new DaemonSessionHistory(), { tools: 'readonly' });
      process.env.ELANOUS_TOOL_CWD = '/changed-after-construction';

      await runTurn(makeTurnCtx());

      expect(dispatchContexts.at(-1)!.cwd).toBe('/configured-tool-cwd');
    } finally {
      if (prior === undefined) delete process.env.ELANOUS_TOOL_CWD;
      else process.env.ELANOUS_TOOL_CWD = prior;
    }
  });

  test('runtime composer shares one cwd resolution with the legacy dispatch path', async () => {
    const decisions: unknown[] = [];
    spyOn(debug, 'log').mockImplementation(
      ((category: string, _event: string, data?: unknown) => {
        if (category === 'tool-cwd.resolve') decisions.push(data);
      }) as typeof debug.log,
    );
    streamImpl = async ({ handlers }) => {
      await handlers.dispatchTool('CaptureCtx', {}, { callId: 'call-1' });
      return '';
    };

    const runtime = createDaemonRuntime({ tools: 'readonly', toolCwd: '/shared-tool-cwd' });
    await runtime.runTurn(makeTurnCtx());

    expect(dispatchContexts.at(-1)!.cwd).toBe('/shared-tool-cwd');
    expect(decisions).toEqual([{ isolated: true, source: 'explicit-flag' }]);
  });

  test('ACP boot composition root injects the real non-detached PTY killer', () => {
    const source = readFileSync(joinPath(REPO_ROOT, 'src/index.ts'), 'utf8');
    expect(source).toContain("const { killNonDetached: killNonDetachedPty } = await import('./pty-shell/registry.js');");
    expect(source).toContain('createDaemonRuntime({\n      acpSessionCwd: true,\n      killNonDetachedPty,');
  });

  test('Nexus preload lets createDaemonRuntime resolve its lazy composer and fan multi-LLM targets out', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(
      async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
        coreTurnCalls.push(ctx);
        return { stopReason: 'end_turn', finalText: '' };
      },
    );
    const targetMeta: unknown[] = [];
    const runtime = createDaemonRuntime({ tools: 'none' });
    await runtime.runTurn(makeTurnCtx({
      sessionId: 'sess-nexus-preload',
      promptMeta: {
        elanous: {
          multiLlm: {
            targets: [
              { id: 'panel-one', provider: 'codex' },
              { id: 'panel-two', provider: 'grok' },
            ],
          },
        },
      },
      pushWithMeta: async (_chunk, meta) => { targetMeta.push(meta); },
    }));

    expect(streamCalls).toHaveLength(0);
    expect(coreTurnCalls).toHaveLength(2);
    expect(coreTurnCalls.map((call) => call.messages.at(-1))).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'hello' },
    ]);
    expect(targetMeta).toEqual(expect.arrayContaining([
      { elanous: { modelId: 'panel-one', provider: 'openai', stopReason: 'end_turn' } },
      { elanous: { modelId: 'panel-two', provider: 'grok', stopReason: 'end_turn' } },
    ]));
  });

  test('PtyShell surface requires an injected non-detached PTY killer', () => {
    spyOn(daemonToolsModule, 'toolSurface').mockReturnValue({
      kind: 'webterm',
      specs: [{ name: 'PtyShellSnapshot', description: '', parameters: { type: 'object' } }],
      dispatch: async () => ({ ok: true }),
    });

    expect(() => createDaemonRuntime({
      tools: 'webterm',
      toolCwd: '/shared-tool-cwd',
    })).toThrow('createDaemonRunTurn requires killNonDetachedPty when the selected tool surface exposes PtyShell');
  });

  test('PtyShell surface wires cancel to the injected non-detached PTY killer', async () => {
    let kills = 0;
    let aborted = false;
    spyOn(daemonToolsModule, 'toolSurface').mockReturnValue({
      kind: 'webterm',
      specs: [{ name: 'PtyShellSnapshot', description: '', parameters: { type: 'object' } }],
      dispatch: async (_name, _args, ctx) => {
        dispatchContexts.push(ctx);
        aborted = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { ok: true };
      },
    });
    streamImpl = async ({ handlers }) => {
      await handlers.dispatchTool('PtyShellSnapshot', {}, { callId: 'call-1' });
      return '';
    };

    const runtime = createDaemonRuntime({
      tools: 'webterm',
      toolCwd: '/shared-tool-cwd',
      killNonDetachedPty: () => { kills += 1; },
    });
    await runtime.runTurn(makeTurnCtx({ isAborted: () => aborted }));

    expect(kills).toBe(1);
    expect(dispatchContexts.at(-1)!.signal.aborted).toBe(true);
  });
});
