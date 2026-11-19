import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import { join, resolve } from 'node:path';
import type { ElsResult } from './core.js';
import type { AllowRule } from './control.js';
import { createControlledBackend, createElsMcpSession, serveElsMcpStdio, type ElsMcpBackend, type ElsMcpPrincipal } from './mcp-serve.js';
import { createLineDecoder } from './wire.js';

const LISTED = JSON.stringify({ panes: [{ address: 'w1/t1/p1', title: 'shell' }] });

function fakeBackend() {
  const calls: { op: string; principal: string; args: unknown[] }[] = [];
  const record = (op: string, result: ElsResult) => async (principal: ElsMcpPrincipal, ...args: unknown[]) => {
    calls.push({ op, principal: principal.id, args });
    return result;
  };
  const backend: ElsMcpBackend = {
    ls: record('ls', { exitCode: 0, message: LISTED }),
    read: record('read', { exitCode: 0, message: 'SCREEN' }) as ElsMcpBackend['read'],
    do: record('do', { exitCode: 1, message: 'els do: unknown pane w9/t9/p9' }) as ElsMcpBackend['do'],
    input: record('input', { exitCode: 0, message: 'typed' }) as ElsMcpBackend['input'],
    newPane: record('new', { exitCode: 0, message: '{"pane":"p2"}' }) as ElsMcpBackend['newPane'],
    status: record('status', { exitCode: 1, message: 'no status' }) as ElsMcpBackend['status'],
  };
  return { backend, calls };
}

const line = (id: number, method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

test('initialize negotiates the version, advertises tools+resources and names the principal from clientInfo', async () => {
  const session = createElsMcpSession(fakeBackend().backend);
  const known = JSON.parse((await session.handleLine(line(1, 'initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code' } })))!);
  expect(known.result.protocolVersion).toBe('2024-11-05');
  expect(known.result.capabilities).toEqual({ tools: {}, resources: { subscribe: true } });
  expect(known.result.serverInfo.name).toBe('els');
  expect(session.principal()).toEqual({ kind: 'mcp-stdio', id: 'mcp-stdio:claude-code' });
  const unknown = JSON.parse((await session.handleLine(line(2, 'initialize', { protocolVersion: '1999-01-01' })))!);
  expect(unknown.result.protocolVersion).toBe('2025-11-25');
});

test('tools/list includes the els tools, each with an input schema', async () => {
  const session = createElsMcpSession(fakeBackend().backend);
  const listed = JSON.parse((await session.handleLine(line(1, 'tools/list')))!);
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['els_ls', 'els_read', 'els_do', 'els_new', 'els_status']);
  for (const tool of listed.result.tools) expect(tool.inputSchema.type).toBe('object');
});

test('direct input is not an MCP tool, even for a client claiming OP or RES-INFRA', async () => {
  for (const client of ['OP', 'RES-INFRA']) {
    const { backend, calls } = fakeBackend();
    const session = createElsMcpSession(backend);
    await session.handleLine(line(1, 'initialize', { clientInfo: { name: client } }));
    const answer = JSON.parse((await session.handleLine(line(2, 'tools/call', {
      name: 'els_input', arguments: { address: 'test-w/test-t/test-p', text: 'test-only', from: client, kind: 'cli' },
    })))!);
    expect(answer.error).toEqual({ code: -32602, message: 'unknown tool: els_input' });
    expect(calls).toEqual([]);
  }
});

test('tools/call: success passes the principal to the backend; exitCode != 0 is isError', async () => {
  const { backend, calls } = fakeBackend();
  const session = createElsMcpSession(backend);
  await session.handleLine(line(1, 'initialize', { clientInfo: { name: 'cc' } }));
  const read = JSON.parse((await session.handleLine(line(2, 'tools/call', { name: 'els_read', arguments: { address: 'w1/t1/p1' } })))!);
  expect(read.result).toEqual({ content: [{ type: 'text', text: 'SCREEN' }] });
  const done = JSON.parse((await session.handleLine(line(3, 'tools/call', { name: 'els_do', arguments: { address: 'w9/t9/p9', text: 'hi' } })))!);
  expect(done.result).toEqual({ content: [{ type: 'text', text: 'els do: unknown pane w9/t9/p9' }], isError: true });
  const missing = JSON.parse((await session.handleLine(line(4, 'tools/call', { name: 'els_do', arguments: { address: 'w1/t1/p1' } })))!);
  expect(missing.result.isError).toBe(true);
  expect(calls).toEqual([
    { op: 'read', principal: 'mcp-stdio:cc', args: ['w1/t1/p1'] },
    { op: 'do', principal: 'mcp-stdio:cc', args: ['w9/t9/p9', 'hi'] },
  ]);
  const unknownTool = JSON.parse((await session.handleLine(line(5, 'tools/call', { name: 'els_rm' })))!);
  expect(unknownTool.error.code).toBe(-32602);
});

test('resources: list from ls, templates, read screen; events without a backend is an error, unknown uri too', async () => {
  const session = createElsMcpSession(fakeBackend().backend);
  const listed = JSON.parse((await session.handleLine(line(1, 'resources/list')))!);
  expect(listed.result.resources.map((r: { uri: string }) => r.uri)).toEqual(['els://pane/w1/t1/p1/screen']);
  const templates = JSON.parse((await session.handleLine(line(2, 'resources/templates/list')))!);
  expect(templates.result.resourceTemplates.map((t: { uriTemplate: string }) => t.uriTemplate)).toEqual(['els://pane/{address}/screen', 'els://pane/{address}/events']);
  const screen = JSON.parse((await session.handleLine(line(3, 'resources/read', { uri: 'els://pane/w1/t1/p1/screen' })))!);
  expect(screen.result.contents).toEqual([{ uri: 'els://pane/w1/t1/p1/screen', mimeType: 'text/plain', text: 'SCREEN' }]);
  const events = JSON.parse((await session.handleLine(line(4, 'resources/read', { uri: 'els://pane/w1/t1/p1/events' })))!);
  expect(events.error.code).toBe(-32603);
  const bad = JSON.parse((await session.handleLine(line(5, 'resources/read', { uri: 'file:///etc/passwd' })))!);
  expect(bad.error.code).toBe(-32602);
});

test('unknown method -32601 and the session keeps answering; malformed JSON -32700; notifications get no answer', async () => {
  const session = createElsMcpSession(fakeBackend().backend);
  expect(JSON.parse((await session.handleLine(line(1, 'resources/refresh')))!).error.code).toBe(-32601);
  // resources/subscribe with no uri is malformed params, not unknown method
  expect(JSON.parse((await session.handleLine(line(2, 'resources/subscribe')))!).error.code).toBe(-32602);
  expect(JSON.parse((await session.handleLine('{not json'))!)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  expect(await session.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeUndefined();
  expect(JSON.parse((await session.handleLine(line(2, 'ping')))!).result).toEqual({});
});

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

test('real stdio process: initialize → tools/list → tools/call → resources/read against a fake els socket', async () => {
  const dir = mkdtempSync('/tmp/els-mcp-');
  const socketPath = join(dir, 'els.sock');
  const seen: unknown[] = [];
  const server: Server = createServer((socket) => {
    const lines = createLineDecoder((raw) => {
      const request = JSON.parse(raw) as { op: string };
      seen.push(request);
      const answer: ElsResult = request.op === 'ls' ? { exitCode: 0, message: LISTED }
        : request.op === 'read' ? { exitCode: 0, message: 'hello from p1' }
        : request.op === 'do' ? { exitCode: 0, message: 'els do: sent' } : { exitCode: 2, message: 'els: unknown request' };
      socket.end(`${JSON.stringify(answer)}\n`);
    });
    socket.on('data', (chunk: Buffer) => lines.push(chunk));
  });
  await new Promise<void>((done) => server.listen(socketPath, done));
  cleanups.push(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  // The real process serves through the control door: probe may read/do on w1 panes; nothing else is allowed.
  writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'mcp-stdio:probe', workspace: 'w1', pane: '*', actions: ['read', 'do'] }] }));
  const entry = resolve(import.meta.dir, 'mcp-serve.ts');
  const lookup = `async (pane) => pane === 'p1' ? { workspace: 'w1', pane: 'p1', shell: true } : undefined`;
  const child = Bun.spawn(['bun', '-e', `const m = await import(${JSON.stringify(entry)}); await m.serveElsMcpStdio(m.createControlledBackend({ stateDir: ${JSON.stringify(dir)}, lookup: ${lookup}, inner: m.createSocketBackend(${JSON.stringify(socketPath)}) })); process.exit(0);`],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  cleanups.push(() => child.kill());
  child.stdin.write([
    line(1, 'initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'probe' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    line(2, 'tools/list'),
    line(3, 'tools/call', { name: 'els_do', arguments: { address: 'w1/t1/p1', text: 'echo hi' } }),
    line(4, 'resources/read', { uri: 'els://pane/w1/t1/p1/screen' }),
    line(5, 'nope/nope'),
    line(6, 'tools/call', { name: 'els_status', arguments: {} }),
  ].join('\n') + '\n');
  child.stdin.end();
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  const answers = out.trim().split('\n').map((raw) => JSON.parse(raw));
  expect(answers.map((a) => a.id)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(answers[0].result.protocolVersion).toBe('2025-11-25');
  expect(answers[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual(['els_ls', 'els_read', 'els_do', 'els_new', 'els_status']);
  expect(answers[2].result).toEqual({ content: [{ type: 'text', text: 'els do: sent' }] });
  expect(answers[3].result.contents[0].text).toBe('hello from p1');
  expect(answers[4].error.code).toBe(-32601);
  // status over every pane is not in the allow list → -32001, audited, never reaches the socket.
  expect(answers[5].error.code).toBe(-32001);
  expect(seen).toEqual([
    { op: 'do', pane: 'p1', at: { ws: 'w1', tab: 't1' }, text: 'echo hi', from: 'mcp-stdio:probe' },
    { op: 'read', pane: 'p1', at: { ws: 'w1', tab: 't1' } },
  ]);
  const audit = readFileSync(join(dir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map((raw) => JSON.parse(raw) as { principal: string; kind: string; action: string; result: string; text?: string });
  expect(audit.map((row) => [row.principal, row.kind, row.action, row.result])).toEqual([
    ['mcp-stdio:probe', 'mcp-stdio', 'do', 'executing'],
    ['mcp-stdio:probe', 'mcp-stdio', 'do', 'executed'],
    ['mcp-stdio:probe', 'mcp-stdio', 'read', 'executing'],
    ['mcp-stdio:probe', 'mcp-stdio', 'read', 'executed'],
    ['mcp-stdio:probe', 'mcp-stdio', 'status', 'denied'],
  ]);
  expect(audit.every((row) => row.text === undefined)).toBe(true);
});

// ── the control door (ELS-EXTERNAL-SURFACES §3.1 · §3.3) ─────────────────────────────────────────────────────────

function doorSession(rules: readonly AllowRule[] | undefined, client: string, envOverride: Record<string, string> = {}) {
  const dir = mkdtempSync('/tmp/els-mcp-door-');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  if (rules) writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules }));
  const { backend: inner, calls } = fakeBackend();
  const sentDo: ElsMcpBackend['do'] = async (principal, address, text) => { calls.push({ op: 'do', principal: principal.id, args: [address, text] }); return { exitCode: 0, message: 'els do: sent' }; };
  const backend = createControlledBackend({
    stateDir: dir,
    inner: { ...inner, do: sentDo },
    lookup: async (pane) => (pane === 'p1' ? { workspace: 'w1', pane: 'p1', shell: true } : undefined),
    env: { SHELL: '/bin/zsh', ...envOverride }, cwd: '/tmp/proj', now: () => 1_700_000_000_000,
  });
  const session = createElsMcpSession(backend);
  const audit = () => {
    try { return readFileSync(join(dir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map((raw) => JSON.parse(raw) as Record<string, unknown>); }
    catch { return []; }
  };
  return { session, calls, audit, init: () => session.handleLine(line(1, 'initialize', { clientInfo: { name: client } })) };
}

const ALLOW_LISTER: AllowRule[] = [
  { principal: 'mcp-stdio:lister', workspace: '*', pane: '*', actions: ['list'] },
];

const ALLOW_CC: AllowRule[] = [
  { principal: 'mcp-stdio:cc', workspace: 'w1', pane: '*', actions: ['read', 'do'] },
  { principal: 'mcp-stdio:cc', workspace: 'proj', pane: '*', actions: ['new'] },
];

test('door: an allow-listed mcp-stdio principal reads, does and opens through control.ts — every action audited as intent + result', async () => {
  const { session, calls, audit, init } = doorSession(ALLOW_LISTER, 'lister');
  await init();
  const listed = JSON.parse((await session.handleLine(line(2, 'tools/call', { name: 'els_ls', arguments: {} })))!);
  expect(listed.result).toEqual({ content: [{ type: 'text', text: LISTED }] });
  const read = JSON.parse((await session.handleLine(line(3, 'tools/call', { name: 'els_read', arguments: { address: 'p1' } })))!);
  expect(read.error.code).toBe(-32001);
  const panes = JSON.parse((await session.handleLine(line(4, 'resources/list')))!);
  expect(panes.result.resources.map((r: { uri: string }) => r.uri)).toEqual(['els://pane/w1/t1/p1/screen']);
  expect(calls).toEqual([
    { op: 'ls', principal: 'mcp-stdio:lister', args: [] },
    { op: 'ls', principal: 'mcp-stdio:lister', args: [] },
  ]);
  expect(audit().map((row) => [row.principal, row.kind, row.action, row.result])).toEqual([
    ['mcp-stdio:lister', 'mcp-stdio', 'list', 'executing'],
    ['mcp-stdio:lister', 'mcp-stdio', 'list', 'executed'],
    ['mcp-stdio:lister', 'mcp-stdio', 'read', 'denied'],
    ['mcp-stdio:lister', 'mcp-stdio', 'list', 'executing'],
    ['mcp-stdio:lister', 'mcp-stdio', 'list', 'executed'],
  ]);
  expect(audit().every((row) => row.text === undefined)).toBe(true);
});

test('door: an allow-listed mcp-stdio principal reads, does and opens through control.ts, each audited once', async () => {
  const { session, calls, audit, init } = doorSession(ALLOW_CC, 'cc');
  await init();
  const done = JSON.parse((await session.handleLine(line(2, 'tools/call', { name: 'els_do', arguments: { address: 'w1/t1/p1', text: 'echo hi' } })))!);
  expect(done.result).toEqual({ content: [{ type: 'text', text: 'els do: sent' }] });
  const read = JSON.parse((await session.handleLine(line(3, 'tools/call', { name: 'els_read', arguments: { address: 'p1' } })))!);
  expect(read.result).toEqual({ content: [{ type: 'text', text: 'SCREEN' }] });
  const screen = JSON.parse((await session.handleLine(line(4, 'resources/read', { uri: 'els://pane/w1/t1/p1/screen' })))!);
  expect(screen.result.contents[0].text).toBe('SCREEN');
  const opened = JSON.parse((await session.handleLine(line(5, 'tools/call', { name: 'els_new', arguments: {} })))!);
  expect(opened.result).toEqual({ content: [{ type: 'text', text: '{"pane":"p2"}' }] });
  expect(calls).toEqual([
    { op: 'do', principal: 'mcp-stdio:cc', args: ['w1/t1/p1', 'echo hi'] },
    { op: 'read', principal: 'mcp-stdio:cc', args: ['p1'] },
    { op: 'read', principal: 'mcp-stdio:cc', args: ['w1/t1/p1'] },
    { op: 'new', principal: 'mcp-stdio:cc', args: [{ ws: 'proj', cwd: '/tmp/proj', command: ['/bin/zsh'] }] },
  ]);
  expect(audit().map((row) => [row.principal, row.kind, row.action, row.result, row.danger])).toEqual([
    ['mcp-stdio:cc', 'mcp-stdio', 'do', 'executing', 'safe'],
    ['mcp-stdio:cc', 'mcp-stdio', 'do', 'executed', 'safe'],
    ['mcp-stdio:cc', 'mcp-stdio', 'read', 'executing', 'safe'],
    ['mcp-stdio:cc', 'mcp-stdio', 'read', 'executed', 'safe'],
    ['mcp-stdio:cc', 'mcp-stdio', 'read', 'executing', 'safe'],
    ['mcp-stdio:cc', 'mcp-stdio', 'read', 'executed', 'safe'],
    ['mcp-stdio:cc', 'mcp-stdio', 'new', 'executing', 'safe'],
    ['mcp-stdio:cc', 'mcp-stdio', 'new', 'executed', 'safe'],
  ]);
  expect(audit().every((row) => row.text === undefined)).toBe(true);
});

test('door: a principal not in control-allow.json is denied with -32001, audited, and nothing reaches the backend', async () => {
  const { session, calls, audit, init } = doorSession(ALLOW_CC, 'intruder');
  await init();
  const done = JSON.parse((await session.handleLine(line(2, 'tools/call', { name: 'els_do', arguments: { address: 'w1/t1/p1', text: 'echo hi' } })))!);
  expect(done.error).toEqual({ code: -32001, message: 'els do: denied for mcp-stdio:intruder (not in control-allow.json)', data: { reason: 'not in control-allow.json' } });
  expect(JSON.parse((await session.handleLine(line(3, 'tools/call', { name: 'els_read', arguments: { address: 'p1' } })))!).error.code).toBe(-32001);
  expect(JSON.parse((await session.handleLine(line(4, 'tools/call', { name: 'els_new', arguments: { ws: 'proj' } })))!).error.code).toBe(-32001);
  expect(JSON.parse((await session.handleLine(line(5, 'tools/call', { name: 'els_ls', arguments: {} })))!).error.code).toBe(-32001);
  expect(JSON.parse((await session.handleLine(line(6, 'tools/call', { name: 'els_status', arguments: {} })))!).error.code).toBe(-32001);
  expect(JSON.parse((await session.handleLine(line(7, 'resources/list')))!).error.code).toBe(-32001);
  expect(JSON.parse((await session.handleLine(line(8, 'resources/read', { uri: 'els://pane/p1/screen' })))!).error.code).toBe(-32001);
  expect(calls).toEqual([]);
  expect(audit().map((row) => [row.principal, row.action, row.result])).toEqual([
    ['mcp-stdio:intruder', 'do', 'denied'], ['mcp-stdio:intruder', 'read', 'denied'], ['mcp-stdio:intruder', 'new', 'denied'],
    ['mcp-stdio:intruder', 'list', 'denied'], ['mcp-stdio:intruder', 'status', 'denied'], ['mcp-stdio:intruder', 'list', 'denied'],
    ['mcp-stdio:intruder', 'read', 'denied'],
  ]);
});

test('door: default deny — no allow list at all refuses even a well-known client', async () => {
  const { session, calls, audit, init } = doorSession(undefined, 'claude-code');
  await init();
  const done = JSON.parse((await session.handleLine(line(2, 'tools/call', { name: 'els_do', arguments: { address: 'p1', text: 'echo hi' } })))!);
  expect(done.error.code).toBe(-32001);
  expect(calls).toEqual([]);
  expect(audit().map((row) => row.result)).toEqual(['denied']);
});

test('door: the principal cannot be spoofed through tool arguments', async () => {
  const { session, calls, audit, init } = doorSession(ALLOW_CC, 'intruder');
  await init();
  const spoof = { address: 'w1/t1/p1', text: 'echo hi', principal: 'mcp-stdio:cc', from: 'mcp-stdio:cc', kind: 'cli', id: 'mcp-stdio:cc', clientInfo: { name: 'cc' } };
  const done = JSON.parse((await session.handleLine(line(2, 'tools/call', { name: 'els_do', arguments: spoof, principal: 'mcp-stdio:cc' })))!);
  expect(done.error.code).toBe(-32001);
  expect(done.error.message).toContain('mcp-stdio:intruder');
  expect(session.principal()).toEqual({ kind: 'mcp-stdio', id: 'mcp-stdio:intruder' });
  expect(calls).toEqual([]);
  expect(audit().map((row) => [row.principal, row.kind])).toEqual([['mcp-stdio:intruder', 'mcp-stdio']]);
});

test('door: a dangerous shell do is held (no person over stdio) — a tool error with the reason, not sent, not -32001', async () => {
  const { session, calls, audit, init } = doorSession(ALLOW_CC, 'cc');
  await init();
  const held = JSON.parse((await session.handleLine(line(2, 'tools/call', { name: 'els_do', arguments: { address: 'p1', text: 'sudo rm -rf /' } })))!);
  expect(held.error).toBeUndefined();
  expect(held.result.isError).toBe(true);
  expect(held.result.content[0].text).toContain('held, not sent');
  // An unknown pane still walks the door first (authorize+audit) before the existence answer — no info leak.
  const unknown = JSON.parse((await session.handleLine(line(3, 'tools/call', { name: 'els_do', arguments: { address: 'w1/t1/p9', text: 'echo hi' } })))!);
  expect(unknown.result).toEqual({ content: [{ type: 'text', text: 'els do: unknown pane w1/t1/p9' }], isError: true });
  expect(calls).toEqual([]);
  expect(audit().map((row) => row.result)).toEqual(['held', 'executing', 'executor-refused']);
});

test('malformed params are rejected without touching the backend: bad percent-encoding in a resource uri, non-array els_new command', async () => {
  const { backend, calls } = fakeBackend();
  const session = createElsMcpSession(backend);

  const malformed = JSON.parse((await session.handleLine(line(1, 'resources/read', { uri: 'els://pane/w1%zzt1/screen' })))!);
  expect(malformed.error.code).toBe(-32602);
  expect(malformed.error.message).toContain('malformed resource uri');

  const stringCommand = JSON.parse((await session.handleLine(line(2, 'tools/call', { name: 'els_new', arguments: { command: 'echo hi' } })))!);
  expect(stringCommand.result.isError).toBe(true);
  expect(stringCommand.result.content[0].text).toBe('els_new: command must be an array of strings');

  const mixedCommand = JSON.parse((await session.handleLine(line(3, 'tools/call', { name: 'els_new', arguments: { command: ['echo', 5] } })))!);
  expect(mixedCommand.result.isError).toBe(true);
  expect(mixedCommand.result.content[0].text).toBe('els_new: command must be an array of strings');

  expect(calls).toEqual([]);
});

test('door: els_new runs exact allowlist matches only — refusals are door-front denials, audited `denied`, nothing spawned (OP 87743)', async () => {
  const { session, calls, audit, init } = doorSession(ALLOW_CC, 'cc');
  await init();
  const allowed = JSON.parse((await session.handleLine(line(2, 'tools/call', { name: 'els_new', arguments: { command: ['zsh'] } })))!);
  expect(allowed.result).toEqual({ content: [{ type: 'text', text: '{"pane":"p2"}' }] });
  const refused = JSON.parse((await session.handleLine(line(3, 'tools/call', { name: 'els_new', arguments: { command: ['bash', '-c', 'rm -rf /'] } })))!);
  expect(refused.error.code).toBe(-32001);
  expect(refused.error.data.reason).toContain('not on the allowlist');
  const unlisted = JSON.parse((await session.handleLine(line(4, 'tools/call', { name: 'els_new', arguments: { command: ['claude', '--dangerously-skip-permissions', 'do', 'evil'] } })))!);
  expect(unlisted.error.code).toBe(-32001);
  const unlistedArgv = JSON.parse(await session.handleLine(line(5, 'tools/call', { name: 'els_new', arguments: { command: ['bash', '-c', 'exec new-pane'] } })) as string);
  expect(unlistedArgv.result).toEqual({ content: [{ type: 'text', text: '{"pane":"p2"}' }] });
  expect(calls).toEqual([
    { op: 'new', principal: 'mcp-stdio:cc', args: [{ ws: 'proj', cwd: '/tmp/proj', command: ['zsh'] }] },
    { op: 'new', principal: 'mcp-stdio:cc', args: [{ ws: 'proj', cwd: '/tmp/proj', command: ['bash', '-c', 'exec new-pane'] }] },
  ]);
  expect(audit().map((row) => [row.action, row.result])).toEqual([['new', 'executing'], ['new', 'executed'], ['new', 'denied'], ['new', 'denied'], ['new', 'executing'], ['new', 'executed']]);
});

test('door: els_new spawn entries run exactly the listed -c strings — operators extend the set via ELS_MCP_NEW_SPAWN_STRINGS, wrong strings are denied', async () => {
  const { session, calls, audit, init } = doorSession(ALLOW_CC, 'cc', { ELS_MCP_NEW_SPAWN_STRINGS: '["echo hi"]' });
  await init();
  const custom = JSON.parse((await session.handleLine(line(2, 'tools/call', { name: 'els_new', arguments: { command: ['bash', '-c', 'echo hi'] } })))!);
  expect(custom.result).toEqual({ content: [{ type: 'text', text: '{"pane":"p2"}' }] });
  const wrongString = JSON.parse((await session.handleLine(line(3, 'tools/call', { name: 'els_new', arguments: { command: ['bash', '-c', 'rm -rf /'] } })))!);
  expect(wrongString.error.code).toBe(-32001);
  const wrongShell = JSON.parse(await session.handleLine(line(4, 'tools/call', { name: 'els_new', arguments: { command: ['bash', '-c'] } })) as string);
  expect(wrongShell.error.code).toBe(-32001);
  const twoArgs = JSON.parse(await session.handleLine(line(5, 'tools/call', { name: 'els_new', arguments: { command: ['bash', '-c', 'echo hi', 'extra'] } })) as string);
  expect(twoArgs.error.code).toBe(-32001);
  const malformed = JSON.parse(await session.handleLine(line(6, 'tools/call', { name: 'els_new', arguments: { ws: 'proj', command: ['bash', '-c', 'not json {'] } })) as string);
  expect(malformed.error.code).toBe(-32001);
  expect(calls).toEqual([
    { op: 'new', principal: 'mcp-stdio:cc', args: [{ ws: 'proj', cwd: '/tmp/proj', command: ['bash', '-c', 'echo hi'] }] },
  ]);
  expect(audit().map((row) => row.result)).toEqual(['executing', 'executed', 'denied', 'denied', 'denied', 'denied']);
});

test('stdio: every answer is flushed to the OS before the server promise resolves', async () => {
  const { backend } = fakeBackend();
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (chunk) => { chunks.push(String(chunk)); });
  const served = serveElsMcpStdio(backend, input, output);
  input.write(line(1, 'tools/list') + '\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  input.end();
  await served;
  const answer = JSON.parse(chunks.join(''));
  expect(answer.id).toBe(1);
  expect(answer.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['els_ls', 'els_read', 'els_do', 'els_new', 'els_status']);
});

test('stdio: an output with fsync-style flush() is flushed before the promise resolves, and write errors reject', async () => {
  const { backend } = fakeBackend();
  // A writable whose flush() is a recorded spy: serveElsMcpStdio must call it (file-like outputs fsync).
  const flushes: number[] = [];
  let writeError: Error | undefined;
  const written: string[] = [];
  const output = new Writable({
    write(chunk, _enc, callback) { written.push(String(chunk)); callback(null); },
  }) as Writable & { flush: (cb: (error?: Error | null) => void) => void };
  output.flush = (callback) => { flushes.push(Date.now()); callback(null); };
  const input = new PassThrough();
  const served = serveElsMcpStdio(backend, input, output);
  input.write(line(1, 'tools/list') + '\n');
  input.end();
  await served;
  expect(flushes.length).toBe(1);
  expect(written.join('')).toContain('els_ls');

  // A write error on a flush-capable output propagates to the caller instead of dying silently.
  const failing = new Writable({
    write(_chunk, _enc, callback) { callback(new Error('pipe broken')); },
  }) as Writable & { flush: (cb: (error?: Error | null) => void) => void };
  failing.flush = (callback) => { callback(new Error('flush failed')); };
  failing.on('error', () => { /* the stream re-emits the write error; the promise rejection is the one we assert */ });
  const failingInput = new PassThrough();
  const failingServed = serveElsMcpStdio(backend, failingInput, failing);
  failingInput.write(line(1, 'tools/list') + '\n');
  failingInput.end();
  writeError = await failingServed.then(() => undefined, (error: Error) => error);
  expect((writeError as Error).message).toMatch(/pipe broken|flush failed/);
});

test('door: the bare new-pane entry runs through the real control path; argumented near-misses are denied', async () => {
  const { session, calls, audit, init } = doorSession(ALLOW_CC, 'cc');
  await init();
  const bare = JSON.parse((await session.handleLine(line(2, 'tools/call', { name: 'els_new', arguments: { command: ['new-pane'] } })))!);
  expect(bare.result).toEqual({ content: [{ type: 'text', text: '{"pane":"p2"}' }] });
  const extraArg = JSON.parse((await session.handleLine(line(3, 'tools/call', { name: 'els_new', arguments: { command: ['new-pane', 'evil'] } })))!);
  expect(extraArg.error.code).toBe(-32001);
  const prefixed = JSON.parse((await session.handleLine(line(4, 'tools/call', { name: 'els_new', arguments: { command: ['bash', '-c', 'new-pane'] } })))!);
  expect(prefixed.error.code).toBe(-32001);
  expect(calls).toEqual([{ op: 'new', principal: 'mcp-stdio:cc', args: [{ ws: 'proj', cwd: '/tmp/proj', command: ['new-pane'] }] }]);
  expect(audit().map((row) => [row.action, row.result])).toEqual([['new', 'executing'], ['new', 'executed'], ['new', 'denied'], ['new', 'denied']]);
  // The denial reason never embeds the rejected command: reasons land in the audit log as plain text.
  const deniedReason = String((audit().at(-1) as { reason?: string }).reason);
  expect(deniedReason).toContain('not on the allowlist');
  expect(deniedReason).not.toContain('new-pane');
  expect(JSON.stringify(audit())).not.toContain('evil');
});

test('stdio: a deferred flush() is awaited — the promise resolves only after the flush callback fires', async () => {
  const { backend } = fakeBackend();
  const order: string[] = [];
  const output = new Writable({ write(chunk, _enc, callback) { order.push('write'); callback(null); } }) as Writable & { flush: (cb: (error?: Error | null) => void) => void };
  output.flush = (callback) => {
    order.push('flush-start');
    setTimeout(() => { order.push('flush-done'); callback(null); }, 15);
  };
  const input = new PassThrough();
  const served = serveElsMcpStdio(backend, input, output);
  input.write(line(1, 'tools/list') + '\n');
  input.end();
  await served;
  // If the flush were not awaited, `order` would still be ['write', 'flush-start'] here —
  // the deferred callback fires 15 ms later, after the promise already resolved.
  expect(order).toEqual(['write', 'flush-start', 'flush-done']);
});

test('stdio: the first failure stops the queue — later lines are dropped, never answered, the promise rejects', async () => {
  const { backend, calls } = fakeBackend();
  const output = new Writable({
    write(_chunk, _enc, callback) { callback(new Error('pipe broken')); },
  }) as Writable & { flush: (cb: (error?: Error | null) => void) => void };
  output.flush = (callback) => { callback(null); };
  output.on('error', () => { /* the stream re-emits the write error; the promise rejection is the one we assert */ });
  const input = new PassThrough();
  const served = serveElsMcpStdio(backend, input, output);
  input.write(line(1, 'tools/call', { name: 'els_read', arguments: { address: 'w1/t1/p1' } }) + '\n');
  input.write(line(2, 'tools/call', { name: 'els_do', arguments: { address: 'w9/t9/p9', text: 'hi' } }) + '\n');
  input.end();
  const failure = await served.then(() => undefined, (error: Error) => error);
  expect((failure as Error).message).toBe('pipe broken');
  // Line 1 reached the backend (read); line 2 was dropped after the write failure — never processed.
  expect(calls).toEqual([{ op: 'read', principal: 'mcp-stdio:unknown', args: ['w1/t1/p1'] }]);
});

test('resources/subscribe+poll: a screen change pushes notifications/resources/updated, no change stays silent, unsubscribe stops', async () => {
  let screen = 'SCREEN-A';
  const calls: string[] = [];
  const backend: ElsMcpBackend = {
    ls: async () => ({ exitCode: 0, message: LISTED }),
    read: async (_p, _a) => { calls.push('read'); return { exitCode: 0, message: screen }; },
    do: async () => ({ exitCode: 1 as const, message: 'no' }),
    input: async () => { throw new Error('unexpected input'); },
    newPane: async () => ({ exitCode: 0 as const, message: '{"pane":"p2"}' }),
    status: async () => ({ exitCode: 1 as const, message: 'no status' }),
  };
  const session = createElsMcpSession(backend);
  const sub = JSON.parse((await session.handleLine(line(1, 'resources/subscribe', { uri: 'els://pane/w1%2Ft1%2Fp1/screen' })))!);
  expect(sub.result).toEqual({});
  expect(await session.poll()).toEqual([]);            // unchanged → silent
  screen = 'SCREEN-B';
  const [first] = await session.poll();
  expect(JSON.parse(first!).method).toBe('notifications/resources/updated');
  expect(JSON.parse(first!).params.uri).toBe('els://pane/w1%2Ft1%2Fp1/screen');
  expect(await session.poll()).toEqual([]);            // new baseline → silent
  screen = 'SCREEN-C';
  expect(JSON.parse((await session.handleLine(line(2, 'resources/unsubscribe', { uri: 'els://pane/w1%2Ft1%2Fp1/screen' })))!).result).toEqual({});
  expect(await session.poll()).toEqual([]);            // unsubscribed → silent even on change
  expect(calls.length).toBe(4);                           // every poll walked the read door (subscribe snapshot + 3 polls)
});
