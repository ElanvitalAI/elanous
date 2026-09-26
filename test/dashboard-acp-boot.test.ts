// U3c Phase 2 — dashboard-acp-boot composer test.
//
// Covers the contract the research doc locked in
// (내부 문서 `RESEARCH-u3c-dashboard-turn-event-fanout` §5):
//
//   1. No remote target → DashboardSession.create boots the in-process
//      ACP pair with getter-driven DashboardSessionOptions.
//   2. Remote target → WebSocket attach, without in-process fallback.
//   3. Getters fire fresh per call — the composer must NOT snapshot
//      chat history / tool catalog at boot time; every turn rebuilds
//      via the live dashboard state.
//
// The real DashboardSession.create boots an in-process ACP server +
// client pair. Tests mock it so we can observe the options passed
// without paying the handshake cost, and so the getter-freshness
// check can drive `buildTurnMessages` with mutating inputs.

import { describe, expect, test, mock, spyOn, beforeEach, afterEach } from 'bun:test';

import type { ChatMessage } from '../src/chat/index.js';
import { resumeInProcessDashboardSession } from '../src/dashboard/index.js';
import { filterDashboardArgs } from '../src/index.js';
import type { LLMMessage, LLMToolSpec } from '../src/llm.js';
import { debug } from '../src/debug/log.js';
import {
  DashboardSession,
  type DashboardSessionOptions,
  type RequestPermissionRequest,
} from '../src/tui-client/dashboard-session.js';

type CreateCall = { opts: DashboardSessionOptions };
const createCalls: CreateCall[] = [];
// Mocked session shape — id + close + send + setRequestPermissionHandler.
// The composer's tests only inspect arguments to DashboardSession.create
// (captured via createCalls); the returned session is just held by the
// boot result and never exercised here.
const mockSessionStub = {
  id: 'mock-session-id',
  close: async () => { /* noop */ },
  send: async (req: { userText: string; onText?: (d: string) => void }) => {
    if (req.onText) req.onText(`echo: ${req.userText}`);
    return { stopReason: 'end_turn' as const };
  },
  setRequestPermissionHandler: () => { /* noop */ },
} as unknown as DashboardSession;
let createImpl: (opts: DashboardSessionOptions) => Promise<DashboardSession> =
  async () => mockSessionStub;

const {
  bootDashboardAcpSession,
  createDefaultRequestPermissionHandler,
} = await import('../src/dashboard/acp-boot.js');

beforeEach(() => {
  createCalls.length = 0;
  createImpl = async () => mockSessionStub;
  // BACKLOG #5 — replace the static methods on the real class via
  // `spyOn`. `mock.restore()` in afterEach reverts; this used to be
  // `mock.module()` which leaks process-wide and broke downstream
  // test files in combined `bun test` runs. spyOn is per-file scoped.
  spyOn(DashboardSession, 'create').mockImplementation(
    async (opts: DashboardSessionOptions) => {
      createCalls.push({ opts });
      return createImpl(opts);
    },
  );
  spyOn(DashboardSession, 'attach').mockImplementation(async () => mockSessionStub);
  spyOn(DashboardSession, 'attachExisting').mockImplementation(async () => mockSessionStub);
});

afterEach(() => {
  createCalls.length = 0;
  // BACKLOG #5 — restore real DashboardSession.{create,attach,
  // attachExisting} so this file's spies don't leak to the next
  // test file in a combined run.
  mock.restore();
});

function makeMinimalDeps(overrides: Partial<Parameters<typeof bootDashboardAcpSession>[0]> = {}) {
  return {
    getCwd: () => '/tmp',
    getChatHistory: () => [] as readonly ChatMessage[],
    getPreamble: () => [] as readonly LLMMessage[],
    getTools: () => [] as readonly LLMToolSpec[],
    getActiveModel: () => 'claude-sonnet-4-6',
    dispatchTool: async () => null,
    pushTurnToolHistory: () => { /* noop */ },
    ...overrides,
  };
}

describe('bootDashboardAcpSession — always boots (post-Phase-5c-2)', () => {
  test('calls DashboardSession.create with cwd + agent info', async () => {
    const result = await bootDashboardAcpSession(makeMinimalDeps({
      getCwd: () => '/Users/dev/repo',
      agentName: 'elanous',
      agentVersion: '0.0.0-test',
    }));
    expect(result).not.toBeNull();
    expect(createCalls).toHaveLength(1);
    const opts = createCalls[0]!.opts;
    expect(opts.cwd).toBe('/Users/dev/repo');
    expect(opts.agentName).toBe('elanous');
    expect(opts.agentVersion).toBe('0.0.0-test');
  });

  test('omits agentName/Version opts when unset', async () => {
    await bootDashboardAcpSession(makeMinimalDeps());
    const opts = createCalls[0]!.opts as unknown as Record<string, unknown>;
    expect('agentName' in opts).toBe(false);
    expect('agentVersion' in opts).toBe(false);
  });

  test('boots a real in-process ACP session with no daemon target', async () => {
    mock.restore();
    const result = await bootDashboardAcpSession(makeMinimalDeps());
    try {
      expect(result.mode).toBe('in-process');
      expect(typeof result.session.id).toBe('string');
      expect(result.session.id.length).toBeGreaterThan(0);
    } finally {
      await result.session.close();
    }
  });
});

describe('bootDashboardAcpSession — remote attach', () => {
  test('remote target uses WebSocket rather than falling back to in-process', async () => {
    await expect(bootDashboardAcpSession(makeMinimalDeps({
      remote: { url: 'not-a-valid-ws-url' },
    }))).rejects.toThrow();
    expect(createCalls).toHaveLength(0);
  });
});

describe('bootDashboardAcpSession — boot observability', () => {
  test('records the selected branch and every successful boot outcome', async () => {
    const records: Array<{ category: string; event: string; data: unknown }> = [];
    const off = debug.registerSink({
      name: 'dashboard-acp-boot-branch-test',
      emit: (record) => records.push({
        category: record.category,
        event: record.event,
        data: record.data,
      }),
    });

    try {
      await bootDashboardAcpSession(makeMinimalDeps({
        remote: { url: 'ws://daemon.invalid/acp' },
      })).catch(() => undefined);
      await bootDashboardAcpSession(makeMinimalDeps());
    } finally {
      off?.();
    }

    expect(records).toMatchObject([
      {
        category: 'dashboard.acp',
        event: 'boot-branch-selected',
        data: { branch: 'remote-daemon', dispatcherAttached: false },
      },
      {
        category: 'dashboard.acp',
        event: 'boot-branch-selected',
        data: { branch: 'in-process', dispatcherAttached: true },
      },
      {
        category: 'dashboard.acp',
        event: 'boot-session-established',
        data: { mode: 'in-process', sessionIdPresent: true },
      },
    ]);
  });

  test('keeps session detail behind the diagnostic gate', async () => {
    const records: Array<{ event: string; data: unknown }> = [];
    const priorDiag = debug.isDiagEnabled();
    const off = debug.registerSink({
      name: 'dashboard-acp-boot-detail-test',
      emit: (record) => records.push({ event: record.event, data: record.data }),
    });

    try {
      debug.setDiagEnabled(false);
      await bootDashboardAcpSession(makeMinimalDeps());
      expect(records.filter((record) => record.event === 'boot-session-established')).toHaveLength(1);
      expect(records.filter((record) => record.event === 'boot-session-detail')).toHaveLength(0);

      debug.setDiagEnabled(true);
      await bootDashboardAcpSession(makeMinimalDeps());
      expect(records.filter((record) => record.event === 'boot-session-established')).toHaveLength(2);
      expect(records.filter((record) => record.event === 'boot-session-detail')).toMatchObject([{
        event: 'boot-session-detail',
        data: {
          mode: 'in-process',
          sessionId: 'mock-session-id',
          resumedFromSession: false,
          resumeFallback: false,
        },
      }]);
    } finally {
      debug.setDiagEnabled(priorDiag);
      off();
    }
  });

  test('preserves the boot result when observability throws', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {
      throw new Error('sink failure');
    });

    try {
      const result = await bootDashboardAcpSession(makeMinimalDeps());
      expect(result).toEqual({ session: mockSessionStub, mode: 'in-process' });
    } finally {
      log.mockRestore();
    }
  });
});

describe('bootDashboardAcpSession — getter injection (fresh reads)', () => {
  test('getMessages pulls current history snapshot each turn', async () => {
    const history: ChatMessage[] = [];
    await bootDashboardAcpSession(makeMinimalDeps({
      getChatHistory: () => history,
    }));
    const opts = createCalls[0]!.opts;

    // Turn 1 — history empty; composer appends user.
    const m1 = await opts.getMessages({ sessionId: 's1', userText: 'hi' });
    expect(m1).toEqual([{ role: 'user', content: 'hi' }]);

    // Turn 2 — dashboard pushed an assistant reply + next user msg.
    history.push({ role: 'assistant', content: 'yo' } as ChatMessage);
    history.push({ role: 'user', content: 'again' } as ChatMessage);
    const m2 = await opts.getMessages({ sessionId: 's1', userText: 'again' });
    // The trailing user IS the current userText → no re-append.
    expect(m2).toHaveLength(2);
    expect(m2[0]).toEqual({ role: 'assistant', content: 'yo' });
    expect((m2[1] as LLMMessage).role).toBe('user');
  });

  test('getTools returns a fresh array per call (no closure capture)', async () => {
    const tools: LLMToolSpec[] = [];
    await bootDashboardAcpSession(makeMinimalDeps({
      getTools: () => tools,
    }));
    const opts = createCalls[0]!.opts;

    expect(await opts.getTools({ sessionId: 's', userText: 'probe' })).toEqual([]);

    tools.push({ name: 'Echo', description: '', parameters: { type: 'object' } });
    const out = await opts.getTools({ sessionId: 's', userText: 'probe' });
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('Echo');
  });

  test('getTools forwards userText to the caller getter (Phase 5a turnCtx)', async () => {
    const seen: string[] = [];
    await bootDashboardAcpSession(makeMinimalDeps({
      getTools: ({ userText }) => {
        seen.push(userText);
        return [];
      },
    }));
    const opts = createCalls[0]!.opts;
    await opts.getTools({ sessionId: 'first-turn', userText: 'search for foo' });
    await opts.getTools({ sessionId: 'second-turn', userText: 'edit bar.ts' });
    expect(seen).toEqual(['search for foo', 'edit bar.ts']);
  });

  test('getTools records the complete TUI catalog at the assembly boundary', async () => {
    const records: Array<{ category: string; event: string; data: unknown }> = [];
    const off = debug.registerSink({
      name: 'dashboard-acp-tool-catalog-test',
      emit: (record) => records.push({
        category: record.category,
        event: record.event,
        data: record.data,
      }),
    });
    const names = ['Read', 'Grep', 'Glob', 'ListDir', 'Edit', 'Write', 'SelfImplement', 'ToolSearch'];

    try {
      await bootDashboardAcpSession(makeMinimalDeps({
        getTools: () => names.map((name) => ({ name, description: '', parameters: { type: 'object' } })),
      }));
      const opts = createCalls[0]!.opts;
      await opts.getTools({ sessionId: 'tui-session-42', userText: 'implement this' });
    } finally {
      off?.();
    }

    expect(records.filter((record) => record.event === 'tool-catalog-assembled')).toMatchObject([{
      category: 'capability.resolve',
      event: 'tool-catalog-assembled',
      data: {
        sessionId: 'tui-session-42',
        surface: 'tui-dashboard',
        assembler: 'buildSessionRuntimeToolSpecs',
        toolCount: 8,
        tools: names,
      },
    }]);
  });

  test('getMessages forwards the current session ID and user text to getPreamble without reuse', async () => {
    const seen: Array<{ sessionId: string; userText: string }> = [];
    await bootDashboardAcpSession(makeMinimalDeps({
      getPreamble: ({ sessionId, userText }) => {
        seen.push({ sessionId, userText });
        return [];
      },
    }));
    const opts = createCalls[0]!.opts;
    await opts.getMessages({ sessionId: 'dashboard-first', userText: 'pilot-1' });
    await opts.getMessages({ sessionId: 'dashboard-second', userText: 'pilot-2' });
    expect(seen).toEqual([
      { sessionId: 'dashboard-first', userText: 'pilot-1' },
      { sessionId: 'dashboard-second', userText: 'pilot-2' },
    ]);
  });

  test('resolveModel reads getActiveModel fresh; returns undefined for null', async () => {
    let model: string | null = 'claude-sonnet-4-6';
    const seen: string[] = [];
    await bootDashboardAcpSession(makeMinimalDeps({
      getActiveModel: ({ userText }) => { seen.push(userText); return model; },
    }));
    const opts = createCalls[0]!.opts;
    expect(opts.resolveModel!({ sessionId: 's', userText: 'build it' })).toBe('claude-sonnet-4-6');

    model = null;
    expect(opts.resolveModel!({ sessionId: 's', userText: 'review it' })).toBeUndefined();

    model = 'claude-opus-4-7';
    expect(opts.resolveModel!({ sessionId: 's', userText: 'plan it' })).toBe('claude-opus-4-7');
    expect(seen).toEqual(['build it', 'review it', 'plan it']);
  });

  test('onTurnComplete forwards new messages to pushTurnToolHistory', async () => {
    const captured: LLMMessage[][] = [];
    await bootDashboardAcpSession(makeMinimalDeps({
      pushTurnToolHistory: (msgs) => captured.push([...msgs]),
    }));
    const opts = createCalls[0]!.opts;
    await opts.onTurnComplete!({
      sessionId: 's',
      newMessages: [{ role: 'assistant', content: 'ack' }],
    });
    expect(captured).toEqual([[{ role: 'assistant', content: 'ack' }]]);
  });

  test('dispatchTool passthrough preserves args + ctx', async () => {
    const seen: Array<{ name: string; args: Record<string, unknown>; callId: string | undefined }> = [];
    await bootDashboardAcpSession(makeMinimalDeps({
      dispatchTool: async (name, args, ctx) => {
        seen.push({ name, args, callId: ctx?.callId });
        return { ok: true };
      },
    }));
    const opts = createCalls[0]!.opts;
    const result = await opts.dispatchTool('Echo', { x: 1 }, { callId: 'c-7' });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ name: 'Echo', args: { x: 1 }, callId: 'c-7' }]);
  });
});

describe('bootDashboardAcpSession — F1 approvalGateway wiring', () => {
  test('without approvalGateway leaves onRequestPermission unset', async () => {
    await bootDashboardAcpSession(makeMinimalDeps());
    const opts = createCalls[0]!.opts as unknown as Record<string, unknown>;
    expect('onRequestPermission' in opts).toBe(false);
  });

  test('with approvalGateway attaches a handler that delegates to the gateway', async () => {
    const gatewayCalls: Array<{ toolName: string; toolArgs: Record<string, unknown> }> = [];
    await bootDashboardAcpSession(makeMinimalDeps({
      approvalGateway: async (ctx) => {
        gatewayCalls.push(ctx);
        return true;
      },
    }));
    const opts = createCalls[0]!.opts;
    expect(opts.onRequestPermission).toBeDefined();

    const resp = await opts.onRequestPermission!({
      sessionId: 's',
      toolCall: { toolCallId: 'c1', title: 'Edit', rawInput: { file_path: '/x' } },
      options: [
        { optionId: 'c1-allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'c1-reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    expect(gatewayCalls).toEqual([{ toolName: 'Edit', toolArgs: { file_path: '/x' } }]);
    if (resp.outcome.outcome === 'selected') {
      expect(resp.outcome.optionId).toBe('c1-allow-once');
    } else {
      throw new Error('expected selected outcome');
    }
  });
});

describe('createDefaultRequestPermissionHandler — outcome mapping', () => {
  const options = [
    { optionId: 'c1-allow-once', name: 'Allow', kind: 'allow_once' as const },
    { optionId: 'c1-allow-always', name: 'Allow always', kind: 'allow_always' as const },
    { optionId: 'c1-reject-once', name: 'Reject', kind: 'reject_once' as const },
  ];
  const baseReq = {
    sessionId: 's',
    toolCall: { toolCallId: 'c1', title: 'Edit', rawInput: { file_path: '/x' } },
    options,
  };

  test('gateway true → picks allow_once option', async () => {
    const handler = createDefaultRequestPermissionHandler(async () => true);
    const resp = await handler(baseReq);
    if (resp.outcome.outcome !== 'selected') throw new Error('expected selected');
    expect(resp.outcome.optionId).toBe('c1-allow-once');
  });

  test('gateway false → picks reject_once option', async () => {
    const handler = createDefaultRequestPermissionHandler(async () => false);
    const resp = await handler(baseReq);
    if (resp.outcome.outcome !== 'selected') throw new Error('expected selected');
    expect(resp.outcome.optionId).toBe('c1-reject-once');
  });

  test('gateway throws → safe default rejects', async () => {
    const handler = createDefaultRequestPermissionHandler(async () => {
      throw new Error('kaboom');
    });
    const resp = await handler(baseReq);
    if (resp.outcome.outcome !== 'selected') throw new Error('expected selected');
    expect(resp.outcome.optionId).toBe('c1-reject-once');
  });

  test('no matching kind in options → falls back to first option', async () => {
    const handler = createDefaultRequestPermissionHandler(async () => true);
    const resp = await handler({
      ...baseReq,
      options: [{ optionId: 'only', name: 'Only', kind: 'reject_always' }],
    });
    if (resp.outcome.outcome !== 'selected') throw new Error('expected selected');
    expect(resp.outcome.optionId).toBe('only');
  });

  test('empty options list → cancelled', async () => {
    const handler = createDefaultRequestPermissionHandler(async () => true);
    const resp = await handler({ ...baseReq, options: [] });
    expect(resp.outcome.outcome).toBe('cancelled');
  });

  test('missing rawInput → gateway receives empty object', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const handler = createDefaultRequestPermissionHandler(async (ctx) => {
      seen.push(ctx.toolArgs);
      return false;
    });
    await handler({
      ...baseReq,
      toolCall: { toolCallId: 'c1', title: 'Edit' },
    });
    expect(seen).toEqual([{}]);
  });

  test('non-string title → passes empty toolName to gateway', async () => {
    const seen: string[] = [];
    const handler = createDefaultRequestPermissionHandler(async (ctx) => {
      seen.push(ctx.toolName);
      return false;
    });
    await handler({
      ...baseReq,
      toolCall: { toolCallId: 'c1' } as RequestPermissionRequest['toolCall'],
    });
    expect(seen).toEqual(['']);
  });
});

describe('in-process dashboard resume bridge', () => {
  test('restores a prefix-matched local session and keeps the dashboard system prompt', () => {
    const chatHistory: ChatMessage[] = [
      { role: 'system', content: 'dashboard prompt' },
      { role: 'user', content: 'fresh draft' },
    ];
    let attached: string | undefined;
    let active: string | undefined;
    const result = resumeInProcessDashboardSession('known-pre', {
      resolveSessionId: (prefix) => prefix === 'known-pre' ? 'known-prefix-session-id' : null,
      historyFromSession: (id) => id === 'known-prefix-session-id'
        ? { history: [{ role: 'user', content: 'previous question' }, { role: 'assistant', content: 'previous answer' }] }
        : null,
      chatHistory,
      setAttachedSessionId: (id) => { attached = id; },
      setActiveSessionId: (id) => { active = id; },
    });

    expect(result).toEqual({ resumed: true, sessionId: 'known-prefix-session-id', turns: 2 });
    expect(attached).toBe('known-prefix-session-id');
    expect(active).toBe('known-prefix-session-id');
    expect(chatHistory).toEqual([
      { role: 'system', content: 'dashboard prompt' },
      { role: 'user', content: 'previous question' },
      { role: 'assistant', content: 'previous answer' },
    ]);
  });

  test('keeps a fresh in-process session when the requested prefix is unknown', () => {
    const chatHistory: ChatMessage[] = [{ role: 'system', content: 'dashboard prompt' }];
    const result = resumeInProcessDashboardSession('missing', {
      resolveSessionId: () => null,
      historyFromSession: () => null,
      chatHistory,
      setAttachedSessionId: () => { throw new Error('must not attach'); },
      setActiveSessionId: () => { throw new Error('must not persist'); },
    });

    expect(result).toEqual({ resumed: false, reason: 'missing' });
    expect(chatHistory).toEqual([{ role: 'system', content: 'dashboard prompt' }]);
  });
});

describe('root dashboard resume arguments', () => {
  test('strips the root resume flag while preserving remote -r and subcommand arguments', () => {
    expect(filterDashboardArgs(['--resume', 'prefix', '--debug'])).toEqual([]);
    expect(filterDashboardArgs(['-r', 'prefix', '--debug'])).toEqual(['-r', 'prefix']);
    expect(filterDashboardArgs(['agent', '-r', 'relationship'])).toEqual(['agent', '-r', 'relationship']);
  });
});

describe('bootDashboardAcpSession — preamble + history merge', () => {
  test('preamble prepends every message list', async () => {
    const preamble: LLMMessage[] = [{ role: 'system', content: 'you are elanous' }];
    await bootDashboardAcpSession(makeMinimalDeps({
      getPreamble: () => preamble,
    }));
    const opts = createCalls[0]!.opts;
    const m = await opts.getMessages({ sessionId: 's', userText: 'hi' });
    expect(m[0]).toEqual({ role: 'system', content: 'you are elanous' });
    expect(m[m.length - 1]).toEqual({ role: 'user', content: 'hi' });
  });
});
