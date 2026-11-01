import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { debug } from '../../debug/log.js';
import { failureReason } from '../../domains/repeated-failure.js';
import { McpConnectionError } from '../../mcp/client.js';
import { handleMcpRequest, type McpServerContext } from '../../mcp/server.js';
import { HARNESS_RUN_ID_ENV } from '../../harness/harness-space.js';
import { registerToolRuntime, unregisterToolRuntime } from '../../tool-runtime/registry.js';
import type { ToolRunResult, ToolRuntime } from '../../tool-runtime/types.js';
import {
  defaultAsideRoundtripLedger,
  maskInjectedValues,
  registerMcpClients,
  type AsideRoundtripEntry,
  type McpToolIndex,
  type McpToolIndexStore,
} from './register-mcp-clients.js';

const stdioServer = (id: string, handshakeTimeoutMs?: number) => ({
  id,
  transport: 'stdio' as const,
  command: ['fake'],
  ...(handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs }),
});

const successfulClient = () => ({
  start: async () => {},
  listTools: async () => [],
  callTool: async () => ({ content: [] }),
  dispose: async () => {},
});

describe('registerMcpClients handshake timeout configuration', () => {
  test('uses server override, then global value, then the unchanged 8000ms default', async () => {
    const observed: number[] = [];
    const handle = await registerMcpClients({
      servers: [stdioServer('default'), stdioServer('global'), stdioServer('server', 13)],
      handshakeTimeoutMs: 7,
      createClient: successfulClient,
      logger: { info: () => {}, warn: () => {} },
      setTimeoutFn: (callback, ms) => {
        observed.push(ms);
        return setTimeout(callback, ms);
      },
      clearTimeoutFn: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });

    expect(observed).toEqual([7, 7, 7, 7, 13, 13]);
    await handle.shutdown();

    const defaults: number[] = [];
    const defaultHandle = await registerMcpClients({
      servers: [stdioServer('default')],
      createClient: successfulClient,
      logger: { info: () => {}, warn: () => {} },
      setTimeoutFn: (callback, ms) => {
        defaults.push(ms);
        return setTimeout(callback, ms);
      },
      clearTimeoutFn: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
    expect(defaults).toEqual([8000, 8000]);
    await defaultHandle.shutdown();
  });

  test('skips a timed-out server, registers a healthy peer, and tells the user how to recover', async () => {
    const warnings: string[] = [];
    const handle = await registerMcpClients({
      servers: [stdioServer('slow', 1), stdioServer('healthy')],
      createClient: (spec) => spec.id === 'slow'
        ? {
            start: () => new Promise<void>(() => {}),
            listTools: async () => [],
            callTool: async () => ({ content: [] }),
            dispose: async () => {},
          }
        : successfulClient(),
      logger: { info: () => {}, warn: (line) => warnings.push(line) },
    });

    expect(handle.perServer.slow).toMatchObject({ status: 'failed' });
    expect(handle.perServer.healthy).toEqual({ status: 'ready', toolCount: 0 });
    expect(warnings).toContainEqual(expect.stringContaining('slow was excluded after its 1ms handshake timeout'));
    expect(warnings).toContainEqual(expect.stringContaining('raise mcp.handshakeTimeoutMs or mcp.servers[].handshakeTimeoutMs, then run elanous mcp reload'));
    await handle.shutdown();
  });
});

describe('registerMcpClients connect-failed trace', () => {
  const captured: { category: string; event: string; data?: Record<string, unknown> }[] = [];
  const originalLog = debug.log.bind(debug) as typeof debug.log;

  afterEach(() => {
    (debug as { log: typeof debug.log }).log = originalLog;
    captured.length = 0;
  });

  const failingClient = (err: Error) => ({
    start: async () => { throw err; },
    listTools: async () => [],
    callTool: async () => ({ content: [] }),
    dispose: async () => {},
  });

  test('logs auth-required and invalid-token, leaves the ready peer ready, and is countable by failureReason', async () => {
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
      captured.push({ category, event, data });
    }) as typeof debug.log;

    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const handle = await registerMcpClients({
      servers: [stdioServer('higgsfield'), stdioServer('bridge'), stdioServer('krea')],
      handshakeTimeoutMs: 0,
      createClient: (spec) => {
        if (spec.id === 'higgsfield') {
          return failingClient(new McpConnectionError('auth-required', `authentication required token=${secret}`));
        }
        if (spec.id === 'bridge') return failingClient(new Error('invalid_token'));
        return successfulClient();
      },
      logger: { info: () => {}, warn: () => {} },
    });

    const rows = captured.filter((row) => row.category === 'mcp.client.boot' && row.event === 'connect-failed');
    const byId = Object.fromEntries(rows.map((row) => [row.data?.id, row.data?.reason]));
    expect(byId).toEqual({ higgsfield: 'auth-required', bridge: 'invalid-token' });
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(handle.perServer.higgsfield).toMatchObject({ status: 'failed', reasonClass: 'auth-required' });
    expect(handle.perServer.bridge).toMatchObject({ status: 'failed', reasonClass: 'invalid-token' });
    expect(handle.perServer.krea).toEqual({ status: 'ready', toolCount: 0 });

    for (const row of rows) {
      const reason = failureReason({
        event: row.event,
        category: row.category,
        data: JSON.stringify(row.data ?? {}),
      });
      expect(reason).not.toBeNull();
    }
    await handle.shutdown();
  });
});

test('Aside exec carries the current run join key and correlates request/result traces', async () => {
  const previousRunId = process.env[HARNESS_RUN_ID_ENV];
  process.env[HARNESS_RUN_ID_ENV] = 'run-aside-roundtrip-test';
  const originalLog = debug.log.bind(debug) as typeof debug.log;
  const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
    events.push({ category, event, data });
  }) as typeof debug.log;
  const runtimes: ToolRuntime[] = [];
  let forwarded: Record<string, unknown> | undefined;
  let handle: Awaited<ReturnType<typeof registerMcpClients>> | undefined;
  try {
    handle = await registerMcpClients({
      servers: [{ ...stdioServer('aside'), authorizedTools: ['exec'] }],
      createClient: () => ({
        start: async () => {},
        listTools: async () => [{
          name: 'exec', description: 'run an Aside browser task',
          inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, reason: { type: 'string' } } },
        }],
        callTool: async (_name, args) => {
          forwarded = args;
          return { content: [{ type: 'text', text: 'release page checked' }] };
        },
        dispose: async () => {},
      }),
      asideLedger: { append: () => undefined, list: () => [] },
      registerRuntime: (runtime) => { runtimes.push(runtime); },
      unregisterRuntime: (_id: string) => undefined,
      logger: { info: () => {}, warn: () => {} },
    });
    const asideExec = runtimes.find((runtime) => runtime.id === 'aside.exec');
    expect(asideExec).toBeDefined();
    const result = await asideExec!.run({ prompt: 'Check the signed-in release page.', reason: 'verify release readiness' }, { surface: 'tui' });

    expect(forwarded?.prompt).toContain('elanous 런 run-aside-roundtrip-test · 결과는 elanous 도구로 돌려라.');
    expect(forwarded?.prompt).toContain('Delegation reason: verify release readiness');
    expect(forwarded?.prompt).toContain('TaskGet');
    expect(forwarded?.prompt).toContain('same runId');
    expect(forwarded?.prompt).toContain('Check the signed-in release page.');
    expect(result.output).toBe('release page checked');
    expect(events.filter((row) => row.category === 'mcp-client.aside').map((row) => [row.event, row.data?.runId, row.data?.reason])).toEqual([
      ['exec-request', 'run-aside-roundtrip-test', 'verify release readiness'],
      ['exec-result', 'run-aside-roundtrip-test', 'verify release readiness'],
    ]);
  } finally {
    await handle?.shutdown();
    (debug as { log: typeof debug.log }).log = originalLog;
    if (previousRunId === undefined) delete process.env[HARNESS_RUN_ID_ENV];
    else process.env[HARNESS_RUN_ID_ENV] = previousRunId;
  }
});

test('Aside exec records zero text length when MCP content is omitted', async () => {
  const runId = 'run-aside-content-omitted';
  const previousRunId = process.env[HARNESS_RUN_ID_ENV];
  process.env[HARNESS_RUN_ID_ENV] = runId;
  const originalLog = debug.log.bind(debug) as typeof debug.log;
  const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
    events.push({ category, event, data });
  }) as typeof debug.log;
  const entries: AsideRoundtripEntry[] = [];
  const runtimes: ToolRuntime[] = [];
  let handle: Awaited<ReturnType<typeof registerMcpClients>> | undefined;
  try {
    handle = await registerMcpClients({
      servers: [{ ...stdioServer('aside'), authorizedTools: ['exec'] }],
      createClient: () => ({
        start: async () => {},
        listTools: async () => [{ name: 'exec', description: 'run an Aside browser task', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } }],
        callTool: async () => ({}),
        dispose: async () => {},
      }),
      asideLedger: { append: (entry) => { entries.push(entry); }, list: () => [] },
      registerRuntime: (runtime) => { runtimes.push(runtime); },
      unregisterRuntime: (_id: string) => undefined,
      logger: { info: () => {}, warn: () => {} },
    });
    const asideExec = runtimes.find((runtime) => runtime.id === 'aside.exec');
    expect(asideExec).toBeDefined();
    await asideExec!.run({ prompt: 'Check the page.' }, { surface: 'tui' });
    expect(entries.find((entry) => entry.phase === 'result')).toMatchObject({ runId, ok: true, outputLength: 0 });
    expect(events.find((event) => event.event === 'exec-result')?.data).toMatchObject({ runId, ok: true, outputLength: 0 });
  } finally {
    await handle?.shutdown();
    (debug as { log: typeof debug.log }).log = originalLog;
    if (previousRunId === undefined) delete process.env[HARNESS_RUN_ID_ENV];
    else process.env[HARNESS_RUN_ID_ENV] = previousRunId;
  }
});

test('Aside roundtrip returns the same-run Elanous tool result and records a runId-only receipt', async () => {
  const runId = 'run-aside-same-run-ledger';
  const previousRunId = process.env[HARNESS_RUN_ID_ENV];
  process.env[HARNESS_RUN_ID_ENV] = runId;
  const logs: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
  const originalLog = debug.log.bind(debug) as typeof debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
    logs.push({ category, event, data });
  }) as typeof debug.log;
  const entries: Array<Record<string, unknown>> = [];
  const ledger = {
    append: (entry: Record<string, unknown>) => { entries.push(entry); },
    list: (requestedRunId: string) => entries.filter((entry) => entry.runId === requestedRunId),
  };
  const runtimes: RegisteredRuntime[] = [];
  let asidePrompt = '';
  let asideCallMetaRunId = '';
  let taskGetRunId = '';
  let handle: Awaited<ReturnType<typeof registerMcpClients>> | undefined;
  try {
    const asideServerContext: McpServerContext = {};
    await handleMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'aside' } },
    }, asideServerContext);
    const opts = {
      servers: [
        { ...stdioServer('elanous'), authorizedTools: ['task_get'] },
        { ...stdioServer('aside'), authorizedTools: ['exec'] },
      ],
      createClient: (spec: { id: string }) => spec.id === 'elanous'
        ? {
            start: async () => {},
            listTools: async () => [{ name: 'task_get', description: 'read run context', inputSchema: { type: 'object', properties: { run: { type: 'string' } } } }],
            callTool: async (_name: string, args: Record<string, unknown>, meta?: { elanousRunId?: string }) => {
              taskGetRunId = String(args.run ?? '');
              return {
                content: [{ type: 'text', text: `context for ${taskGetRunId}` }],
                ...(args.fail === true ? { isError: true } : {}),
              };
            },
            dispose: async () => {},
          }
        : {
            start: async () => {},
            listTools: async () => [{ name: 'exec', description: 'run browser task', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, reason: { type: 'string' } } } }],
            callTool: async (_name: string, args: Record<string, unknown>, meta?: { elanousRunId?: string }) => {
              asidePrompt = String(args.prompt ?? '');
              asideCallMetaRunId = String(meta?.elanousRunId ?? '');
              const callRunId = /elanous 런 ([A-Za-z0-9_-]+) · 결과는 elanous 도구로 돌려라\./.exec(asidePrompt)?.[1] ?? '';
              const returned = await handleMcpRequest({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                  name: 'elanous.task_get',
                  arguments: { run: callRunId },
                  _meta: { elanousRunId: callRunId },
                },
              }, asideServerContext);
              if (returned.error) throw new Error(returned.error.message);
              const content = (returned.result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
              return { content: [{ type: 'text', text: `aside returned ${content.map((block) => block.text ?? '').join('\n')}` }] };
            },
            dispose: async () => {},
          },
      asideLedger: ledger,
      registerRuntime: (runtime: { id: string }) => {
        captureRuntime(runtimes)(runtime);
        registerToolRuntime(runtime as unknown as ToolRuntime<never, ToolRunResult>);
      },
      unregisterRuntime: (id: string) => { unregisterToolRuntime(id); },
      logger: { info: () => {}, warn: () => {} },
    } as unknown as Parameters<typeof registerMcpClients>[0];
    handle = await registerMcpClients(opts);

    const asideExec = runtimes.find((runtime) => runtime.id === 'aside.exec');
    expect(asideExec).toBeDefined();
    const returnedToParent = await asideExec!.run({ prompt: 'Inspect the signed-in release page.', reason: 'verify release readiness' }, {});

    expect(asidePrompt).toContain(`elanous 런 ${runId} · 결과는 elanous 도구로 돌려라.`);
    expect(asidePrompt).toContain('Delegation reason: verify release readiness');
    expect(asidePrompt).toContain('TaskGet');
    expect(asidePrompt).toContain('same runId');
    expect(taskGetRunId).toBe(runId);
    expect(asideCallMetaRunId).toBe(runId);
    expect(resultText(returnedToParent)).toContain(`context for ${runId}`);
    expect(ledger.list(runId)).toHaveLength(2);
    expect(ledger.list(runId).map((entry) => entry.phase)).toEqual(['call', 'result']);
    expect(ledger.list(runId)[1]).toMatchObject({ runId, toolName: 'exec', reason: 'verify release readiness', ok: true });
    expect(JSON.stringify(ledger.list(runId))).not.toContain('context for');
    expect(logs.filter((row) => row.category === 'mcp-client.aside').map((row) => [row.event, row.data?.runId])).toEqual([
      ['exec-request', runId], ['exec-result', runId],
    ]);
    expect(logs.filter((row) => row.category === 'mcp-server.aside').map((row) => [row.event, row.data?.runId, row.data?.ok])).toEqual([
      ['elanous-tool-call', runId, undefined], ['elanous-tool-result', runId, null],
    ]);

    await asideExec!.run({ prompt: 'Inspect the release date only.' }, {});
    expect(asidePrompt).toContain(`elanous 런 ${runId} · 결과는 elanous 도구로 돌려라.`);
    expect(asidePrompt).not.toContain('Delegation reason:');
    expect(ledger.list(runId)).toHaveLength(4);
    expect(ledger.list(runId)[2]).toMatchObject({ runId, phase: 'call', reason: null });
    expect(ledger.list(runId)[3]).toMatchObject({ runId, phase: 'result', reason: null, ok: true });

    await handleMcpRequest({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'elanous.task_get', arguments: { run: runId, fail: true }, _meta: { elanousRunId: runId } },
    }, asideServerContext);
    expect(logs.filter((row) => row.category === 'mcp-server.aside').slice(-2).map((row) => [row.event, row.data?.runId, row.data?.ok])).toEqual([
      ['elanous-tool-call', runId, undefined], ['elanous-tool-result', runId, false],
    ]);

    await handleMcpRequest({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'elanous.not_exposed', arguments: {}, _meta: { elanousRunId: runId } },
    }, asideServerContext);
    expect(logs.filter((row) => row.category === 'mcp-server.aside').slice(-2).map((row) => [row.event, row.data?.runId, row.data?.ok, row.data?.errorClass])).toEqual([
      ['elanous-tool-call', runId, undefined, undefined],
      ['elanous-tool-result', runId, false, 'unknown_tool'],
    ]);

    await handleMcpRequest({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'elanous.not_exposed', arguments: {}, _meta: { elanousRunId: 'run with spaces' } },
    }, asideServerContext);
    expect(logs.at(-1)).toMatchObject({
      category: 'mcp-server.aside', event: 'elanous-tool-call-run-id-dropped',
      data: { toolName: 'elanous.not_exposed', reason: 'invalid-format' },
    });
  } finally {
    await handle?.shutdown();
    (debug as { log: typeof debug.log }).log = originalLog;
    if (previousRunId === undefined) delete process.env[HARNESS_RUN_ID_ENV];
    else process.env[HARNESS_RUN_ID_ENV] = previousRunId;
  }
});

test('default Aside ledger creates its JSONL file only on append and indexes by runId', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-aside-ledger-'));
  const path = join(root, 'aside-run-roundtrip.jsonl');
  const ledger = defaultAsideRoundtripLedger(root);
  expect(existsSync(path)).toBe(false);
  ledger.append({ runId: 'run-one', phase: 'call', toolName: 'exec', reason: null, at: '2026-10-31T00:00:00.000Z' });
  ledger.append({ runId: 'run-two', phase: 'call', toolName: 'exec', reason: 'verify', at: '2026-10-31T00:00:01.000Z' });
  expect(existsSync(path)).toBe(true);
  expect(ledger.list('run-one')).toEqual([{ runId: 'run-one', phase: 'call', toolName: 'exec', reason: null, at: '2026-10-31T00:00:00.000Z' }]);
});

test('Aside server errors record classification without retaining response text', async () => {
  const runId = 'run-aside-server-error';
  const logs: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
  const originalLog = debug.log.bind(debug) as typeof debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
    logs.push({ category, event, data });
  }) as typeof debug.log;
  const entries: Array<Record<string, unknown>> = [];
  const ledger = { append: (entry: Record<string, unknown>) => { entries.push(entry); }, list: (id: string) => entries.filter((entry) => entry.runId === id) };
  const runtimes: RegisteredRuntime[] = [];
  const previousRunId = process.env[HARNESS_RUN_ID_ENV];
  process.env[HARNESS_RUN_ID_ENV] = runId;
  let handle: Awaited<ReturnType<typeof registerMcpClients>> | undefined;
  try {
    const opts = {
      servers: [{ ...stdioServer('aside'), authorizedTools: ['exec'] }],
      createClient: () => ({
        start: async () => {},
        listTools: async () => [{ name: 'exec', description: 'run browser task', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } }],
        callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'private page response body' }] }),
        dispose: async () => {},
      }),
      asideLedger: ledger,
      registerRuntime: captureRuntime(runtimes),
      unregisterRuntime: () => undefined,
      logger: { info: () => {}, warn: () => {} },
    } as unknown as Parameters<typeof registerMcpClients>[0];
    handle = await registerMcpClients(opts);
    const result = await runtimes.find((runtime) => runtime.id === 'aside.exec')!.run({ prompt: 'check page' }, {});
    expect((result as { classification?: string }).classification).toBe('mcp-server-error');
    expect(ledger.list(runId)).toHaveLength(2);
    expect(ledger.list(runId)[1]).toMatchObject({ runId, phase: 'result', ok: false, classification: 'mcp-server-error' });
    expect(JSON.stringify(ledger.list(runId))).not.toContain('private page response body');
    expect(logs.find((row) => row.event === 'exec-result')?.data).toMatchObject({ runId, ok: false, classification: 'mcp-server-error' });
    expect(JSON.stringify(logs)).not.toContain('private page response body');
  } finally {
    await handle?.shutdown();
    (debug as { log: typeof debug.log }).log = originalLog;
    if (previousRunId === undefined) delete process.env[HARNESS_RUN_ID_ENV];
    else process.env[HARNESS_RUN_ID_ENV] = previousRunId;
  }
});

test('a rejected Aside call records only the transport error class in its same-run receipt', async () => {
  const runId = 'run-aside-call-rejected';
  const logs: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
  const originalLog = debug.log.bind(debug) as typeof debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
    logs.push({ category, event, data });
  }) as typeof debug.log;
  const entries: Array<Record<string, unknown>> = [];
  const ledger = { append: (entry: Record<string, unknown>) => { entries.push(entry); }, list: (id: string) => entries.filter((entry) => entry.runId === id) };
  const runtimes: RegisteredRuntime[] = [];
  const previousRunId = process.env[HARNESS_RUN_ID_ENV];
  process.env[HARNESS_RUN_ID_ENV] = runId;
  let handle: Awaited<ReturnType<typeof registerMcpClients>> | undefined;
  try {
    const opts = {
      servers: [{ ...stdioServer('aside'), authorizedTools: ['exec'] }],
      createClient: () => ({
        start: async () => {},
        listTools: async () => [{ name: 'exec', description: 'run browser task', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } }],
        callTool: async () => { throw new Error('private transport detail'); },
        dispose: async () => {},
      }),
      asideLedger: ledger,
      registerRuntime: captureRuntime(runtimes),
      unregisterRuntime: () => undefined,
      logger: { info: () => {}, warn: () => {} },
    } as unknown as Parameters<typeof registerMcpClients>[0];
    handle = await registerMcpClients(opts);
    const result = await runtimes.find((runtime) => runtime.id === 'aside.exec')!.run({ prompt: 'check page' }, {});
    expect((result as { classification?: string }).classification).toBe('mcp-transport-error');
    expect(ledger.list(runId)).toHaveLength(2);
    expect(ledger.list(runId)[1]).toMatchObject({ runId, phase: 'result', ok: false, classification: 'mcp-transport-error', errorClass: 'Error' });
    expect(JSON.stringify(ledger.list(runId))).not.toContain('private transport detail');
    expect(logs.find((row) => row.event === 'exec-error')?.data).toMatchObject({ runId, callToolRejected: true, errorClass: 'Error' });
    expect(JSON.stringify(logs)).not.toContain('private transport detail');
  } finally {
    await handle?.shutdown();
    (debug as { log: typeof debug.log }).log = originalLog;
    if (previousRunId === undefined) delete process.env[HARNESS_RUN_ID_ENV];
    else process.env[HARNESS_RUN_ID_ENV] = previousRunId;
  }
});

test('non-Aside and non-stdio MCP proxies keep their input and skip Aside bookkeeping', async () => {
  const runId = 'run-aside-negative-controls';
  const logs: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
  const originalLog = debug.log.bind(debug) as typeof debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
    logs.push({ category, event, data });
  }) as typeof debug.log;
  const entries: Array<Record<string, unknown>> = [];
  const ledger = { append: (entry: Record<string, unknown>) => { entries.push(entry); }, list: () => entries };
  const previousRunId = process.env[HARNESS_RUN_ID_ENV];
  process.env[HARNESS_RUN_ID_ENV] = runId;
  let handle: Awaited<ReturnType<typeof registerMcpClients>> | undefined;
  try {
    for (const spec of [stdioServer('demo'), { id: 'aside', transport: 'http', url: 'https://aside.invalid/mcp', authorizedTools: ['exec'] }]) {
      const runtimes: RegisteredRuntime[] = [];
      let forwardedPrompt = '';
      const opts = {
        servers: [{ ...spec, authorizedTools: ['exec'] }],
        createClient: () => ({
          start: async () => {},
          listTools: async () => [{ name: 'exec', description: 'run task', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } }],
          callTool: async (_name: string, args: Record<string, unknown>) => {
            forwardedPrompt = String(args.prompt ?? '');
            return { content: [{ type: 'text', text: 'unchanged response' }] };
          },
          dispose: async () => {},
        }),
        asideLedger: ledger,
        registerRuntime: captureRuntime(runtimes),
        unregisterRuntime: () => undefined,
        logger: { info: () => {}, warn: () => {} },
      } as unknown as Parameters<typeof registerMcpClients>[0];
      handle = await registerMcpClients(opts);
      await runtimes.find((runtime) => runtime.id === `${spec.id}.exec`)!.run({ prompt: 'unchanged prompt', reason: 'unchanged reason' }, {});
      expect(forwardedPrompt).toBe('unchanged prompt');
      await handle.shutdown();
      handle = undefined;
    }
    expect(entries).toHaveLength(0);
    expect(logs.filter((row) => row.category === 'mcp-client.aside')).toHaveLength(0);
  } finally {
    await handle?.shutdown();
    (debug as { log: typeof debug.log }).log = originalLog;
    if (previousRunId === undefined) delete process.env[HARNESS_RUN_ID_ENV];
    else process.env[HARNESS_RUN_ID_ENV] = previousRunId;
  }
});

test('MCP results mask injected credential values in object keys as well as values', () => {
  const secret = 'plugin-secret-value-0123456789';
  const masked = maskInjectedValues({ structuredContent: { [secret]: 'ok', nested: [{ [`x-${secret}`]: secret }] } }, [secret]);
  expect(JSON.stringify(masked)).not.toContain(secret);
});

// ── CLASSIC-IDLE-MCP-LAZY ──────────────────────────────────────────────────
// 계약: classic TUI 는 기동 때 MCP 자식을 «하나도» 띄우지 않는다. 툴 목록은
// 지난 부팅의 인덱스 그대로 알리고, 자식은 «첫 도구 호출» 때 한 번만 뜬다.
// 종료는 자식에게 SIGTERM 을 먼저 보내 3초 안에 끝난다.

const echoTool = { name: 'echo', description: 'echo args', inputSchema: { type: 'object', properties: {} } };

const memoryToolIndexStore = (initial: McpToolIndex = {}) => {
  let current: McpToolIndex = structuredClone(initial);
  const writes: McpToolIndex[] = [];
  const store: McpToolIndexStore = {
    read: () => structuredClone(current),
    write: (index) => {
      current = structuredClone(index);
      writes.push(structuredClone(index));
    },
  };
  return { store, writes, current: () => current };
};

const FAKE_MCP_SERVER_SOURCE = `
import { writeFileSync } from 'node:fs';

const [pidFile, mode] = process.argv.slice(2);
if (pidFile) writeFileSync(pidFile, String(process.pid));
if (mode === 'ignore-sigterm') { process.on('SIGTERM', () => {}); }

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\\n');
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === 'initialize') {
      reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-echo', version: '0.0.0' },
      });
    } else if (message.method === 'tools/list') {
      reply(message.id, { tools: [${JSON.stringify(echoTool)}] });
    } else if (message.method === 'tools/call') {
      reply(message.id, { content: [{ type: 'text', text: JSON.stringify(message.params?.arguments ?? {}) }] });
    } else {
      reply(message.id, {});
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

type RegisteredRuntime = {
  id: string;
  run: (req: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;
};

const captureRuntime = (sink: RegisteredRuntime[]) => (runtime: { id: string }) => {
  sink.push(runtime as unknown as RegisteredRuntime);
};

const resultText = (result: unknown): string => {
  const output = (result as { output?: unknown }).output;
  return typeof output === 'string' ? output : JSON.stringify(result);
};

const waitForExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

const writeFakeMcpServer = (): { script: string; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-lazy-mcp-'));
  const script = join(dir, 'fake-mcp-server.mjs');
  writeFileSync(script, FAKE_MCP_SERVER_SOURCE, 'utf8');
  return { script, dir };
};

describe('registerMcpClients lazy boot (CLASSIC-IDLE-MCP-LAZY)', () => {
  const logs: { category: string; event: string; data?: Record<string, unknown> }[] = [];
  const originalLog = debug.log.bind(debug) as typeof debug.log;

  afterEach(() => {
    (debug as { log: typeof debug.log }).log = originalLog;
    logs.length = 0;
  });

  const spyLogs = () => {
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
  };
  const lazyBootReasons = () =>
    logs
      .filter((row) => row.category === 'mcp.client' && row.event === 'lazy-boot')
      .map((row) => row.data?.reason);

  test('boot spawns no child, announces the indexed tools, then spawns exactly once on the first call', async () => {
    spyLogs();
    const { store } = memoryToolIndexStore({ demo: [echoTool] });
    const runtimes: RegisteredRuntime[] = [];
    let started = 0;
    const handle = await registerMcpClients({
      servers: [{ id: 'demo', transport: 'stdio', command: ['fake'], authorizedTools: ['echo'] }],
      lazy: true,
      toolIndexStore: store,
      createClient: () => ({
        start: async () => { started += 1; },
        listTools: async () => [echoTool],
        callTool: async (name, args) => ({ content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] }),
        dispose: async () => {},
      }),
      registerRuntime: captureRuntime(runtimes),
      unregisterRuntime: () => undefined,
      logger: { info: () => {}, warn: () => {} },
    });

    expect(started).toBe(0);
    expect(handle.perServer.demo).toEqual({ status: 'ready', toolCount: 1, deferred: true });
    expect(runtimes.map((runtime) => runtime.id)).toEqual(['demo.echo']);
    expect(lazyBootReasons()).toEqual(['deferred']);

    const first = await runtimes[0]!.run({ ping: 1 }, {});
    const second = await runtimes[0]!.run({ ping: 2 }, {});
    expect(started).toBe(1);
    expect(resultText(first)).toContain('"ping":1');
    expect(resultText(second)).toContain('"ping":2');
    expect(lazyBootReasons()).toEqual(['deferred', 'first-call']);

    await handle.shutdown();
  });

  test('shutdown while the child was never spawned still disposes it and revokes its tools', async () => {
    spyLogs();
    const { store } = memoryToolIndexStore({ demo: [echoTool] });
    const unregistered: string[] = [];
    let disposed = 0;
    const handle = await registerMcpClients({
      servers: [{ id: 'demo', transport: 'stdio', command: ['fake'], authorizedTools: ['echo'] }],
      lazy: true,
      toolIndexStore: store,
      createClient: () => ({
        start: async () => {},
        listTools: async () => [echoTool],
        callTool: async () => ({ content: [] }),
        dispose: async () => { disposed += 1; },
      }),
      registerRuntime: () => {},
      unregisterRuntime: (id: string) => { unregistered.push(id); return undefined; },
      logger: { info: () => {}, warn: () => {} },
    });

    // 아직 «한 번도» 안 불렀다 — 자식은 없다. 그래도 정리는 자식 누수 없이 끝난다.
    expect(disposed).toBe(0);
    await handle.shutdown();
    expect(disposed).toBe(1);
    expect(unregistered).toEqual(['demo.echo']);
    expect(handle.registered).toBe(1);
  });

  test('a lazy boot with no tool index falls back to one eager handshake and records the index', async () => {
    spyLogs();
    const { store, writes } = memoryToolIndexStore();
    let started = 0;
    const handle = await registerMcpClients({
      servers: [{ id: 'demo', transport: 'stdio', command: ['fake'], authorizedTools: ['echo'] }],
      lazy: true,
      toolIndexStore: store,
      createClient: () => ({
        start: async () => { started += 1; },
        listTools: async () => [echoTool],
        callTool: async () => ({ content: [] }),
        dispose: async () => {},
      }),
      registerRuntime: () => {},
      unregisterRuntime: () => undefined,
      logger: { info: () => {}, warn: () => {} },
    });

    expect(started).toBe(1);
    expect(handle.perServer.demo).toEqual({ status: 'ready', toolCount: 1 });
    expect(writes.at(-1)?.demo?.map((tool) => tool.name)).toEqual(['echo']);
    expect(lazyBootReasons()).toEqual(['no-index']);
    await handle.shutdown();
  });

  test('real child: zero processes after boot, one after the first tool call, gone within 3s of shutdown', async () => {
    spyLogs();
    const { script, dir } = writeFakeMcpServer();
    const pidFile = join(dir, 'child.pid');
    const { store } = memoryToolIndexStore({ demo: [echoTool] });
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = dir;
    const runtimes: RegisteredRuntime[] = [];
    try {
      const handle = await registerMcpClients({
        servers: [{
          id: 'demo',
          transport: 'stdio',
          command: [process.execPath, script, pidFile, 'ignore-sigterm'],
          authorizedTools: ['echo'],
        }],
        lazy: true,
        toolIndexStore: store,
        registerRuntime: captureRuntime(runtimes),
        unregisterRuntime: () => undefined,
        logger: { info: () => {}, warn: () => {} },
      });

      expect(existsSync(pidFile)).toBe(false);
      expect(handle.perServer.demo).toEqual({ status: 'ready', toolCount: 1, deferred: true });

      const result = await runtimes[0]!.run({ ping: 'real' }, {});
      expect(JSON.stringify(result)).toContain('real');
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow();

      const startedAt = Date.now();
      await handle.shutdown();
      const gone = await waitForExit(pid, 3000 - (Date.now() - startedAt));
      const elapsed = Date.now() - startedAt;
      expect(gone).toBe(true);
      expect(elapsed).toBeLessThan(3000);
      expect(lazyBootReasons()).toEqual(['deferred', 'first-call']);
    } finally {
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
    }
  }, 20000);
});
