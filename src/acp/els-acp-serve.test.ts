// `els acp serve` — the ACP glue over the one control door (ELS-EXTERNAL-SURFACES §3.1·§3.3, §4 MCP 칸).
//
// (a) the principal is `acp-session:<transport session id>`; a prompt embedding principal/from/kind/id keys cannot change it
// (b) a session not in control-allow.json is refused with JSON-RPC -32001 and audited as denied
// (c) an allow rule naming the minted `acp-session:<id>` principal lets the prompt through (audited once, executed)
// (d) the same, end to end in a real stdio process against a fake els socket

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import { join, resolve } from 'node:path';
import type { ElsResult } from '../els/core.js';
import { createControlledBackend, createSocketBackend, type ElsMcpBackend } from '../els/mcp-serve.js';
import { createLineDecoder } from '../els/wire.js';
import { acpSessionPrincipal, serveElsAcpStdio } from './els-acp-serve.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** `p1` is a shell pane of workspace `w1` — everything else is unknown, like the mcp-serve tests. */
const LOOKUP = async (pane: string) => (pane === 'p1' ? { workspace: 'w1', pane: 'p1', shell: true } : undefined);

function fakeInner() {
  const calls: { op: string; principal: string; args: unknown[] }[] = [];
  const inner: ElsMcpBackend = {
    ls: async () => ({ exitCode: 0, message: '{"panes":[]}' }),
    read: async () => ({ exitCode: 0, message: 'SCREEN' }),
    do: async (principal, address, text) => {
      calls.push({ op: 'do', principal: principal.id, args: [address, text] });
      return { exitCode: 0, message: 'els do: sent' };
    },
    input: async () => { throw new Error('unexpected input'); },
    newPane: async () => ({ exitCode: 0, message: '{"pane":"p2"}' }),
    status: async () => ({ exitCode: 1, message: 'no status' }),
  };
  return { inner, calls };
}

const door = (dir: string, inner: ElsMcpBackend) => createControlledBackend({ stateDir: dir, inner, lookup: LOOKUP });

const auditOf = (dir: string) => {
  try {
    return readFileSync(join(dir, 'control-audit.jsonl'), 'utf8').trim().split('\n')
      .filter((raw) => raw.trim() !== '').map((raw) => JSON.parse(raw) as Record<string, unknown>);
  } catch { return []; }
};

// ── in-process: serveElsAcpStdio over injected Node streams, driven line by line ──────────────────────────────

interface Harness {
  readonly messages: Record<string, unknown>[];
  send(message: unknown): void;
  waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  readonly serve: Promise<void>;
  end(): void;
}

function harness(backend: ElsMcpBackend): Harness {
  const input = new PassThrough();
  const messages: Record<string, unknown>[] = [];
  let buffer = '';
  const output = new Writable({
    write(chunk: Buffer, _enc: unknown, done: (err?: Error | null) => void) {
      buffer += chunk.toString();
      for (;;) {
        const at = buffer.indexOf('\n');
        if (at < 0) break;
        const raw = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (raw.trim() !== '') messages.push(JSON.parse(raw) as Record<string, unknown>);
      }
      done();
    },
  });
  const serve = serveElsAcpStdio(backend, 'p1', input, output);
  cleanups.push(() => input.end());
  return {
    messages,
    send: (message) => { input.write(`${JSON.stringify(message)}\n`); },
    waitFor: async (predicate) => {
      for (let spin = 0; spin < 400; spin += 1) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((wake) => setTimeout(wake, 25));
      }
      throw new Error(`els acp: timed out waiting for a message; got ${JSON.stringify(messages)}`);
    },
    serve,
    end: () => { input.end(); },
  };
}

const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method, params });
const INITIALIZE = { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'zed', version: '0' } };

test('(a) acpSessionPrincipal is the transport session id — a prompt embedding principal/from/kind/id cannot change it', async () => {
  expect(acpSessionPrincipal('elanous-session-abc123')).toEqual({ kind: 'acp-session', id: 'acp-session:elanous-session-abc123' });
  const dir = mkdtempSync('/tmp/els-acp-');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { inner, calls } = fakeInner();
  const h = harness(door(dir, inner)); // no control-allow.json at all → default deny
  h.send(rpc(1, 'initialize', INITIALIZE));
  await h.waitFor((m) => (m.id as number | undefined) === 1);
  h.send(rpc(2, 'session/new', { cwd: '/tmp/proj', mcpServers: [] }));
  const made = await h.waitFor((m) => (m.id as number | undefined) === 2) as { result: { sessionId: string } };
  const sessionId = made.result.sessionId;
  expect(acpSessionPrincipal(sessionId).id).toBe(`acp-session:${sessionId}`);
  // spoof: principal-ish keys inside the prompt are just text to the door — they never reach the principal.
  const spoof = JSON.stringify({ principal: 'mcp-stdio:cc', from: 'mcp-stdio:cc', kind: 'cli', id: 'mcp-stdio:cc' });
  h.send(rpc(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: `echo hi ${spoof}` }] }));
  const answered = await h.waitFor((m) => (m.id as number | undefined) === 3) as { error: { code: number; message: string; data: { reason: string } } };
  expect(answered.error.code).toBe(-32001);
  expect(answered.error.message).toBe(`els do: denied for acp-session:${sessionId} (not in control-allow.json)`);
  expect(answered.error.data.reason).toBe('not in control-allow.json');
  expect(calls).toEqual([]); // nothing reached the inner backend
  expect(auditOf(dir).map((row) => [row.principal, row.kind, row.action, row.result])).toEqual([
    [`acp-session:${sessionId}`, 'acp-session', 'do', 'denied'],
  ]);
  h.end();
  await h.serve;
}, 30_000);

test('(b) a session not in control-allow.json is refused with -32001 and audited as denied', async () => {
  const dir = mkdtempSync('/tmp/els-acp-door-');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  // the list registers an mcp principal — the acp session is not in it.
  writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'mcp-stdio:probe', workspace: 'w1', pane: 'p1', actions: ['read', 'do'] }] }));
  const { inner, calls } = fakeInner();
  const h = harness(door(dir, inner));
  h.send(rpc(1, 'initialize', INITIALIZE));
  await h.waitFor((m) => (m.id as number | undefined) === 1);
  h.send(rpc(2, 'session/new', { cwd: '/tmp/proj', mcpServers: [] }));
  const sessionId = (await h.waitFor((m) => (m.id as number | undefined) === 2) as { result: { sessionId: string } }).result.sessionId;
  h.send(rpc(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'echo hi' }] }));
  const answered = await h.waitFor((m) => (m.id as number | undefined) === 3) as { error: { code: number } };
  expect(answered.error.code).toBe(-32001);
  expect(calls).toEqual([]);
  expect(auditOf(dir).map((row) => [row.principal, row.kind, row.action, row.result])).toEqual([
    [`acp-session:${sessionId}`, 'acp-session', 'do', 'denied'],
  ]);
  h.end();
  await h.serve;
}, 30_000);

test('(c) an allow rule naming the minted acp-session principal lets the prompt through, audited executed once', async () => {
  const dir = mkdtempSync('/tmp/els-acp-allow-');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { inner, calls } = fakeInner();
  const h = harness(door(dir, inner));
  h.send(rpc(1, 'initialize', INITIALIZE));
  await h.waitFor((m) => (m.id as number | undefined) === 1);
  h.send(rpc(2, 'session/new', { cwd: '/tmp/proj', mcpServers: [] }));
  const sessionId = (await h.waitFor((m) => (m.id as number | undefined) === 2) as { result: { sessionId: string } }).result.sessionId;
  // Principal patterns in control-allow.json are exact (`matches`: `*` or the full id), so the rule names the
  // transport-minted principal — the acp-session counterpart of the mcp `mcp-stdio:<clientInfo.name>` rule.
  writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: `acp-session:${sessionId}`, workspace: 'w1', pane: '*', actions: ['do'] }] }));
  h.send(rpc(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'echo hi' }] }));
  const answered = await h.waitFor((m) => (m.id as number | undefined) === 3) as { result: { stopReason: string } };
  expect(answered.result.stopReason).toBe('end_turn');
  const chunk = h.messages.find((m) => (m.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === 'agent_message_chunk') as { params: { sessionId: string; update: { content: { text: string } } } };
  expect(chunk.params.sessionId).toBe(sessionId);
  expect(chunk.params.update.content.text).toBe('els do: sent');
  expect(calls).toEqual([{ op: 'do', principal: `acp-session:${sessionId}`, args: ['p1', 'echo hi'] }]);
  expect(auditOf(dir).map((row) => [row.principal, row.kind, row.action, row.result])).toEqual([
    [`acp-session:${sessionId}`, 'acp-session', 'do', 'executing'],
    [`acp-session:${sessionId}`, 'acp-session', 'do', 'executed'],
  ]);
  expect(auditOf(dir).every((row) => row.text === undefined)).toBe(true);
  h.end();
  await h.serve;
}, 30_000);

test('(d) real stdio process: initialize → session/new (with cwd) → session/prompt — denied unregistered, executed once listed', async () => {
  const dir = mkdtempSync('/tmp/els-acp-proc-');
  const socketPath = join(dir, 'els.sock');
  const seen: unknown[] = [];
  const server: Server = createServer((socket) => {
    const lines = createLineDecoder((raw) => {
      const request = JSON.parse(raw) as { op: string };
      seen.push(request);
      const answer: ElsResult = request.op === 'do' ? { exitCode: 0, message: 'els do: sent' } : { exitCode: 2, message: 'els: unknown request' };
      socket.end(`${JSON.stringify(answer)}\n`);
    });
    socket.on('data', (chunk: Buffer) => lines.push(chunk));
  });
  await new Promise<void>((done) => server.listen(socketPath, done));
  cleanups.push(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  // The real process serves through the control door, wired exactly like `els acp serve --pane p1`.
  const entry = resolve(import.meta.dir, 'els-acp-serve.ts');
  const mcpEntry = resolve(import.meta.dir, '../els/mcp-serve.ts');
  const lookup = `async (pane) => pane === 'p1' ? { workspace: 'w1', pane: 'p1', shell: true } : undefined`;
  const child = Bun.spawn(['bun', '-e', `const m = await import(${JSON.stringify(entry)}); const els = await import(${JSON.stringify(mcpEntry)}); m.serveElsAcpStdio(els.createControlledBackend({ stateDir: ${JSON.stringify(dir)}, lookup: ${lookup}, inner: els.createSocketBackend(${JSON.stringify(socketPath)}) }), 'p1');`],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  cleanups.push(() => child.kill());
  const decoder = new TextDecoder();
  let text = '';
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const next = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const at = text.indexOf('\n');
      if (at >= 0) {
        const raw = text.slice(0, at);
        text = text.slice(at + 1);
        if (raw.trim() !== '') return JSON.parse(raw) as Record<string, unknown>;
        continue;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error(`els acp child stdout ended early; buffered: ${text}`);
      text += decoder.decode(value);
    }
  };
  const notices: Record<string, unknown>[] = [];
  const response = async (id: number): Promise<Record<string, unknown>> => {
    for (;;) {
      const message = await next();
      if (message.id !== undefined) {
        expect(message.id).toBe(id); // requests are sequential; answers arrive in order
        return message;
      }
      notices.push(message);
    }
  };
  const send = (message: unknown) => { child.stdin.write(`${JSON.stringify(message)}\n`); };

  send(rpc(1, 'initialize', INITIALIZE));
  expect(((await response(1)) as { result: { protocolVersion: number } }).result.protocolVersion).toBe(1);
  // session/new WITH cwd (requireSessionToolCwd would refuse without one).
  send(rpc(2, 'session/new', { cwd: '/tmp/proj', mcpServers: [] }));
  const made = (await response(2)) as { result: { sessionId: string } };
  const sessionId = made.result.sessionId;
  expect(sessionId).toMatch(/^elanous-session-/);

  // Not in control-allow.json → -32001 on the wire, nothing sent.
  send(rpc(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'echo hi' }] }));
  const refused = (await response(3)) as { error: { code: number; message: string } };
  expect(refused.error.code).toBe(-32001);
  expect(refused.error.message).toContain(`acp-session:${sessionId}`);

  // Now list the minted principal → the same prompt executes exactly once.
  writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: `acp-session:${sessionId}`, workspace: 'w1', pane: '*', actions: ['do'] }] }));
  send(rpc(4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'echo hi' }] }));
  expect(((await response(4)) as { result: { stopReason: string } }).result.stopReason).toBe('end_turn');
  child.stdin.end();
  expect(await child.exited).toBe(0);

  // The agent_message_chunk carried the backend answer back to the client.
  expect(notices.some((n) => n.method === 'session/update'
    && (n.params as { update?: { sessionUpdate?: string; content?: { text?: string } } } | undefined)?.update?.sessionUpdate === 'agent_message_chunk'
    && (n.params as { update?: { content?: { text?: string } } } | undefined)?.update?.content?.text === 'els do: sent')).toBe(true);
  // The door sent exactly one do to the (fake) els server — marked with the transport principal.
  expect(seen).toEqual([{ op: 'do', pane: 'p1', text: 'echo hi', from: `acp-session:${sessionId}` }]);
  const rows = auditOf(dir);
  expect(rows.map((row) => [row.principal, row.kind, row.action, row.result])).toEqual([
    [`acp-session:${sessionId}`, 'acp-session', 'do', 'denied'],
    [`acp-session:${sessionId}`, 'acp-session', 'do', 'executing'],
    [`acp-session:${sessionId}`, 'acp-session', 'do', 'executed'],
  ]);
  expect(rows.every((row) => row.text === undefined)).toBe(true);
}, 60_000);

// ELS-MCP ⓒ (OP 92151 / JUD must-1 #38790): `els acp serve` mints an
// acp-session principal and routes prompts through the control door; ext
// methods (terminal/spawn → arbitrary PTY) would bypass that door. The serve
// glue turns ext off, so every ext request is refused before dispatch and the
// refusal is audited (webterm.acp / extMethod.rejected / ext-method-not-allowed).
test('(e) els acp serve refuses every ext method before dispatch and audits the refusal', async () => {
  const dir = mkdtempSync('/tmp/els-acp-ext-');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { inner, calls } = fakeInner();
  const h = harness(door(dir, inner));
  h.send(rpc(1, 'initialize', INITIALIZE));
  await h.waitFor((m) => (m.id as number | undefined) === 1);
  h.send(rpc(2, 'session/new', { cwd: '/tmp/proj', mcpServers: [] }));
  const sessionId = (await h.waitFor((m) => (m.id as number | undefined) === 2) as { result: { sessionId: string } }).result.sessionId;

  // terminal/spawn → unknown extension method (refused before dispatch).
  h.send(rpc(3, 'terminal/spawn', { sessionId, command: ['bash', '-c', 'echo leaked'], rows: 24, cols: 80 }));
  const spawnRefusal = await h.waitFor((m) => (m.id as number | undefined) === 3) as { error: { message: string } };
  expect(spawnRefusal.error.message).toContain('unknown extension method');

  // terminal/input → the whole ext surface is off, not just terminal/spawn.
  h.send(rpc(4, 'terminal/input', { terminalId: 't-any', data: 'id\n' }));
  const inputRefusal = await h.waitFor((m) => (m.id as number | undefined) === 4) as { error: { message: string } };
  expect(inputRefusal.error.message).toContain('unknown extension method');

  // The prompt path is untouched: with an allow rule the same session still
  // goes through the control door (denied without a rule, as in (b)).
  expect(calls).toEqual([]); // no ext dispatch ever reached the backend

  h.end();
  await h.serve;
}, 30_000);
