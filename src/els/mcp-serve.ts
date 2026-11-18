// `els mcp serve` — a stdio MCP shell over els (ELS-EXTERNAL-SURFACES §3.2 «MCP 서버 — stdio»). Line-delimited
// JSON-RPC 2.0 in, one answer line out. Every tool and resource goes through an injected ElsMcpBackend, so the session
// stays transport only. `createControlledBackend` puts the one enforcement path (control.ts, §3.1) in front of the
// socket backend: principal `mcp-stdio:<clientInfo.name>` → authorize (default deny) → classify → execute → audit.
// A control refusal (`denied`) is JSON-RPC -32001 (§3.3), never a tool result.

import type { Readable, Writable } from 'node:stream';
import { negotiateMcpProtocolVersion, type JsonRpcRequest, type JsonRpcResponse } from '../mcp/protocol.js';
import { parseAddress } from './address.js';
import { withNewDefaults } from './cli-args.js';
import { requestEls } from './client.js';
import { createControl, type ControlAction, type ControlOutcome, type ControlTarget, type HitlAsk, type Principal } from './control.js';
import type { ElsResult } from './core.js';
import { createLineDecoder } from './wire.js';

/** Made by the transport from the initialize handshake — never taken from tool arguments. */
export interface ElsMcpPrincipal {
  readonly kind: 'mcp-stdio';
  readonly id: string;
}

export interface ElsMcpNewInput {
  readonly ws?: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly command?: readonly string[];
}

/** A backend answer. `denied` is set only by the control door when the allow list refuses the principal (→ -32001). */
export type ElsMcpResult = ElsResult & { readonly denied?: { readonly reason: string } };

// AUTHORIZATION SEAM: every call carries the principal; `createControlledBackend` puts the control.ts gate
// (allowlist · classify · HITL · audit) in front of the socket backend. The session decides nothing about who may do what.
export interface ElsMcpBackend {
  ls(principal: ElsMcpPrincipal): Promise<ElsMcpResult>;
  read(principal: ElsMcpPrincipal, address: string): Promise<ElsMcpResult>;
  do(principal: ElsMcpPrincipal, address: string, text: string): Promise<ElsMcpResult>;
  newPane(principal: ElsMcpPrincipal, input: ElsMcpNewInput): Promise<ElsMcpResult>;
  status(principal: ElsMcpPrincipal, address?: string): Promise<ElsMcpResult>;
  events?(principal: ElsMcpPrincipal, address: string): Promise<ElsMcpResult>;
}

/** JSON-RPC error for a control refusal (ELS-EXTERNAL-SURFACES §3.3: 허용 목록 밖 → MCP -32001). */
export const ELS_MCP_DENIED = -32001;

export interface ElsMcpControlDeps {
  /** `<state>/els` — control-allow.json and control-audit.jsonl. */
  readonly stateDir: string;
  /** The backend that actually talks to the els server. Called only after the door says yes. */
  readonly inner: ElsMcpBackend;
  /** Resolve a local pane ref to its workspace and whether it is a shell. Unknown = undefined. */
  readonly lookup: (pane: string) => Promise<{ readonly workspace: string; readonly pane: string; readonly shell: boolean } | undefined>;
  /** Absent over stdio (stdin is the protocol): a dangerous shell `do` is held, never sent. */
  readonly hitl?: HitlAsk;
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly now?: () => number;
}

/** Every listed pane / every workspace — only a `*`/`*` rule authorizes a question about all of them. */
const ALL: ControlTarget = { workspace: '*', pane: '*', shell: false };
/** A pane that does not exist yet: only a `*` pane pattern matches it. */
const NEW_PANE = '(new)';

const outcomeToResult = (outcome: ControlOutcome): ElsMcpResult => {
  if (outcome.ok) return { exitCode: outcome.exitCode, message: outcome.message };
  return outcome.code === 'denied'
    ? { exitCode: 1, message: outcome.message, denied: { reason: outcome.reason } }
    : { exitCode: 1, message: `${outcome.message} [${outcome.code}: ${outcome.reason}]` };
};

/**
 * The MCP stdio surface through the one control door (§3.1). The principal is the transport's (`mcp-stdio`, id from
 * clientInfo.name); no tool argument reaches it. `ls` (and resources/list) is not a control action, so it walks the
 * door as `status` over every pane (`*`/`*`). The `events` resource walks it as `read`.
 */
export function createControlledBackend(deps: ElsMcpControlDeps): ElsMcpBackend {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const toPrincipal = (principal: ElsMcpPrincipal): Principal => ({ id: principal.id, kind: principal.kind });
  /** A door-front refusal reason (e.g. the els_new allowlist): the door audits `denied` and answers -32001;
   *  the executor never runs. */
  const through = async (principal: ElsMcpPrincipal, action: ControlAction, target: ControlTarget, call: () => Promise<ElsResult>, text?: string, violation?: string): Promise<ElsMcpResult> => {
    // One door per call: its executor is exactly this call, run at most once and only after authorize (+ HITL).
    let ran: (() => Promise<ElsResult>) | undefined = call;
    const door = createControl({
      stateDir: deps.stateDir,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.hitl ? { hitl: deps.hitl } : {}),
      ...(violation !== undefined ? { guard: () => violation } : {}),
      execute: async () => { const once = ran; ran = undefined; return once ? once() : { exitCode: 2, message: 'els mcp: executor ran twice' }; },
    });
    return outcomeToResult(await door.run({ principal: toPrincipal(principal), action, target, ...(text !== undefined ? { text } : {}) }));
  };
  // Unknown panes and remote addresses still walk the door — the caller's right to ask is checked (and audited)
  // before any existence answer. `shell: true` keeps classification fail-closed for the not-yet-known pane.
  const pane = async (address: string, tool: string): Promise<{ target: ControlTarget; limitation?: ElsResult }> => {
    const parsed = parseAddress(address);
    if (parsed?.host) return {
      target: { workspace: parsed.ws, pane: parsed.pane, shell: true },
      limitation: { exitCode: 1, message: `els mcp: remote address ${address} is not served over stdio yet (local panes only)` },
    };
    const target = await deps.lookup(parsed ? parsed.pane : address);
    if (target) return { target };
    return {
      target: { workspace: parsed?.ws ?? '*', pane: '*', shell: true },
      limitation: { exitCode: 1, message: `${tool}: unknown pane ${address}` },
    };
  };
  const limit = (limitation: ElsResult | undefined, call: () => Promise<ElsResult>) => limitation ? Promise.resolve(limitation) : call();
  return {
    ls: (principal) => through(principal, 'list', ALL, () => deps.inner.ls(principal)),
    read: async (principal, address) => {
      const { target, limitation } = await pane(address, 'els read');
      return through(principal, 'read', target, () => limit(limitation, () => deps.inner.read(principal, address)));
    },
    do: async (principal, address, text) => {
      const { target, limitation } = await pane(address, 'els do');
      return through(principal, 'do', target, () => limit(limitation, () => deps.inner.do(principal, address, text)), text);
    },
    newPane: (principal, input) => {
      const args = withNewDefaults({ ws: input.ws, cwd: input.cwd, title: input.title, command: input.command ?? [] }, env, cwd);
      const defaulted: ElsMcpNewInput = { ws: args.ws, cwd: args.cwd, command: args.command, ...(args.title ? { title: args.title } : {}) };
      // HOLD-THE-LINE: until the shared shell-argv policy lands, els_new runs exact allowlist matches only —
      // no argv inspection, no danger classification, no HITL. A refusal is a door-front denial (OP 87743):
      // audited `denied`, JSON-RPC -32001, and the executor never runs.
      const violation = elsNewViolation(args.command, env);
      return through(principal, 'new', { workspace: args.ws, pane: NEW_PANE, shell: false }, () => deps.inner.newPane(principal, defaulted), args.command.join(' '), violation);
    },
    status: async (principal, address) => {
      if (address === undefined) return through(principal, 'status', ALL, () => deps.inner.status(principal));
      const { target, limitation } = await pane(address, 'els status');
      return through(principal, 'status', target, () => limit(limitation, () => deps.inner.status(principal, address)));
    },
    ...(deps.inner.events ? {
      events: async (principal: ElsMcpPrincipal, address: string) => {
        const { target, limitation } = await pane(address, 'els events');
        return through(principal, 'read', target, () => limit(limitation, () => deps.inner.events!(principal, address)));
      },
    } : {}),
  };
}

/** One `ls` pane row — `status` answers pane questions from this real server path. */
type PaneStatusRow = { pane: string; workspace: string; tab: string; address: string; [field: string]: unknown };

/**
 * Commands `els_new` may run — exact argv matches only. Until the shared shell-argv policy lands,
 * `els_new` does no argv inspection, no danger classification and no HITL: anything not exactly on
 * this list is refused at the door (OP 87743). The list then collapses into that policy.
 */
export interface ElsNewAllowEntry {
  /** `new-pane` opens the workspace pane; `spawn` runs a command in it. */
  readonly pane: 'new-pane' | 'spawn';
  /** The argv words before the string argument — exact, in order. */
  readonly argv: readonly string[];
  /** `spawn` entries: the single string argument must be exactly one of these. */
  readonly strings?: readonly string[];
}

/** Strings `bash -c '<text>'`-style entries may run — exact matches only. Default fail-closed:
 *  just the known-safe handoff pattern. Operators extend the set with ELS_MCP_NEW_SPAWN_STRINGS. */
export const ELS_MCP_NEW_SPAWN_STRINGS: readonly string[] = ['exec new-pane'];

/** The operator extension point: ELS_MCP_NEW_SPAWN_STRINGS env (JSON array of strings) widens the string set. */
const spawnStrings = (env: Record<string, string | undefined>): readonly string[] => {
  const raw = env.ELS_MCP_NEW_SPAWN_STRINGS;
  if (raw === undefined || raw.trim() === '') return ELS_MCP_NEW_SPAWN_STRINGS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((word) => typeof word === 'string')) return parsed;
  } catch { /* fail closed: fall through to the default set */ }
  return ELS_MCP_NEW_SPAWN_STRINGS;
};

/** The entries `els_new` may run, given the env. Until the shared shell-argv policy lands, this list
 *  IS the policy: no argv inspection, no danger classification, no HITL. Anything else is refused. */
export const elsNewAllowlist = (env: Record<string, string | undefined>): readonly ElsNewAllowEntry[] => {
  const strings = spawnStrings(env);
  return [
    { pane: 'new-pane', argv: ['new-pane'] },
    { pane: 'spawn', argv: ['bash', '-c'], strings },
    { pane: 'spawn', argv: ['zsh', '-c'], strings },
    { pane: 'spawn', argv: ['sh', '-c'], strings },
    ...['bash', 'zsh', 'sh', '/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/sh', 'node', 'python3', 'nvim', 'vim', 'claude', 'codex']
      .map((argv) => ({ pane: 'spawn' as const, argv: [argv] })),
  ];
};

/** The door-front refusal reason when `command` matches no entry, or undefined when it matches one. */
export const elsNewViolation = (command: readonly string[], env: Record<string, string | undefined>): string | undefined => {
  for (const entry of elsNewAllowlist(env)) {
    if (!entry.argv.every((word, i) => word === command[i])) continue;
    if (entry.strings === undefined) {
      if (command.length === entry.argv.length) return undefined;
      continue;
    }
    if (command.length === entry.argv.length + 1 && entry.strings.includes(command[entry.argv.length]!)) return undefined;
  }
  // The rejected command itself never enters the reason: reasons land in the audit log in
  // plain text, and command arguments can carry secrets (OP 87743 must-fix).
  return 'command not on the allowlist (exact match only until the shared shell-argv policy lands)';
};

/** The inner backend: one request per call to the local els server socket. Serve it only behind createControlledBackend. */
export function createSocketBackend(socketPath: string, env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): ElsMcpBackend {
  const local = (address: string): { pane: string; at?: { ws: string; tab: string } } | ElsResult => {
    const parsed = parseAddress(address);
    if (!parsed) return { pane: address };
    if (parsed.host) return { exitCode: 1, message: `els mcp: remote address ${address} is not served over stdio yet (local panes only)` };
    return { pane: parsed.pane, at: { ws: parsed.ws, tab: parsed.tab } };
  };
  return {
    ls: () => requestEls(socketPath, { op: 'ls' }),
    read: async (_principal, address) => {
      const target = local(address);
      return 'exitCode' in target ? target : requestEls(socketPath, { op: 'read', ...target });
    },
    do: async (principal, address, text) => {
      const target = local(address);
      return 'exitCode' in target ? target : requestEls(socketPath, { op: 'do', ...target, text, from: principal.id });
    },
    newPane: (_principal, input) => {
      const args = withNewDefaults({ ws: input.ws, cwd: input.cwd, title: input.title, command: input.command ?? [] }, env, cwd);
      return requestEls(socketPath, { op: 'new', ws: args.ws, cwd: args.cwd, command: args.command, ...(args.title ? { title: args.title } : {}) });
    },
    // The els server has no dedicated status op — status questions ride the real `ls` path and pick out the pane's row.
    status: async (_principal, address) => {
      const listed = await requestEls(socketPath, { op: 'ls' });
      if (listed.exitCode !== 0) return listed;
      if (address === undefined) return listed;
      const parsed = parseAddress(address);
      if (parsed?.host) return { exitCode: 1, message: `els mcp: remote address ${address} is not served over stdio yet (local panes only)` };
      const body = JSON.parse(listed.message) as { panes: PaneStatusRow[] };
      const wanted = parsed ? parsed.pane : address;
      const row = body.panes.find((p) => p.pane === wanted && (!parsed || (p.workspace === parsed.ws && p.tab === parsed.tab)));
      return row ? { exitCode: 0, message: JSON.stringify(row) } : { exitCode: 1, message: `els status: unknown pane ${address}` };
    },
  };
}

const str = { type: 'string' } as const;
const ADDRESS = { type: 'string', description: 'pane: local pane id or ws/tab/pane' } as const;
export const ELS_MCP_TOOLS = [
  { name: 'els_ls', description: 'List els workspaces, tabs and panes (JSON).', inputSchema: { type: 'object', properties: {} } },
  { name: 'els_read', description: 'Read a pane\'s screen as text.', inputSchema: { type: 'object', properties: { address: ADDRESS }, required: ['address'] } },
  { name: 'els_do', description: 'Type a line into a pane (marked with the sender, queued while the pane is busy).',
    inputSchema: { type: 'object', properties: { address: ADDRESS, text: str }, required: ['address', 'text'] } },
  { name: 'els_new', description: 'Open a pane (defaults: $SHELL, the server\'s folder, workspace = folder name).',
    inputSchema: { type: 'object', properties: { ws: str, cwd: str, title: str, command: { type: 'array', items: str } } } },
  { name: 'els_status', description: 'Pane status.', inputSchema: { type: 'object', properties: { address: ADDRESS } } },
] as const;

const RESOURCE_URI = /^els:\/\/pane\/(.+)\/(screen|events)$/;

type Handled = JsonRpcResponse | undefined;

export interface ElsMcpSession {
  readonly principal: () => ElsMcpPrincipal;
  handle(request: JsonRpcRequest): Promise<Handled>;
  /** One raw input line → the answer line (without newline), or undefined for a notification. */
  handleLine(line: string): Promise<string | undefined>;
}

const ok = (id: JsonRpcResponse['id'], result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const fail = (id: JsonRpcResponse['id'], code: number, message: string, data?: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
/** A control refusal is a JSON-RPC error, not a tool result. The audit line was already written by control.ts. */
const denied = (id: JsonRpcResponse['id'], result: ElsMcpResult): JsonRpcResponse => fail(id, ELS_MCP_DENIED, result.message, { reason: result.denied!.reason });
const toolResult = (result: ElsResult) => ({ content: [{ type: 'text', text: result.message }], ...(result.exitCode !== 0 ? { isError: true } : {}) });
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

export function createElsMcpSession(backend: ElsMcpBackend): ElsMcpSession {
  let principal: ElsMcpPrincipal = { kind: 'mcp-stdio', id: 'mcp-stdio:unknown' };

  const callTool = async (name: unknown, args: Record<string, unknown>): Promise<ElsMcpResult | undefined> => {
    switch (name) {
      case 'els_ls': return backend.ls(principal);
      case 'els_read': {
        const address = text(args.address);
        return address ? backend.read(principal, address) : { exitCode: 2, message: 'els_read: address is required' };
      }
      case 'els_do': {
        const address = text(args.address);
        if (!address || typeof args.text !== 'string') return { exitCode: 2, message: 'els_do: address and text are required' };
        return backend.do(principal, address, args.text);
      }
      case 'els_new': {
        if (args.command !== undefined && (!Array.isArray(args.command) || !args.command.every((word) => typeof word === 'string')))
          return { exitCode: 2, message: 'els_new: command must be an array of strings' };
        const command = args.command as string[] | undefined;
        const input: ElsMcpNewInput = { ...(text(args.ws) ? { ws: args.ws as string } : {}), ...(text(args.cwd) ? { cwd: args.cwd as string } : {}),
          ...(text(args.title) ? { title: args.title as string } : {}), ...(command ? { command } : {}) };
        return backend.newPane(principal, input);
      }
      case 'els_status': return backend.status(principal, text(args.address));
      default: return undefined;
    }
  };

  const listResources = async (): Promise<{ resources: unknown[] } | ElsMcpResult> => {
    const listed = await backend.ls(principal);
    if (listed.denied) return listed;
    if (listed.exitCode !== 0) return { resources: [] };
    try {
      const panes = (JSON.parse(listed.message) as { panes?: { address?: unknown; title?: unknown }[] }).panes ?? [];
      return { resources: panes.flatMap((pane) => typeof pane.address === 'string'
        ? [{ uri: `els://pane/${pane.address}/screen`, name: `${pane.address} screen`, ...(typeof pane.title === 'string' ? { description: pane.title } : {}), mimeType: 'text/plain' }]
        : []) };
    } catch { return { resources: [] }; }
  };

  const handle = async (request: JsonRpcRequest): Promise<Handled> => {
    const id = request.id ?? null;
    const params = request.params ?? {};
    if (request.id === undefined || request.method.startsWith('notifications/')) return undefined;
    switch (request.method) {
      case 'initialize': {
        const client = params.clientInfo as { name?: unknown } | undefined;
        principal = { kind: 'mcp-stdio', id: `mcp-stdio:${text(client?.name) ?? 'unknown'}` };
        return ok(id, {
          protocolVersion: negotiateMcpProtocolVersion(params.protocolVersion),
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'els', version: '1' },
        });
      }
      case 'ping': return ok(id, {});
      case 'tools/list': return ok(id, { tools: ELS_MCP_TOOLS });
      case 'tools/call': {
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
        const result = await callTool(params.name, args);
        if (!result) return fail(id, -32602, `unknown tool: ${String(params.name)}`);
        return result.denied ? denied(id, result) : ok(id, toolResult(result));
      }
      case 'resources/list': {
        const listed = await listResources();
        return 'resources' in listed ? ok(id, listed) : denied(id, listed);
      }
      case 'resources/templates/list': return ok(id, { resourceTemplates: [
        { uriTemplate: 'els://pane/{address}/screen', name: 'pane screen', mimeType: 'text/plain' },
        { uriTemplate: 'els://pane/{address}/events', name: 'pane events', mimeType: 'application/json' },
      ] });
      case 'resources/read': {
        const uri = typeof params.uri === 'string' ? params.uri : '';
        const match = RESOURCE_URI.exec(uri);
        if (!match) return fail(id, -32602, `unknown resource: ${uri}`);
        let address: string;
        try { address = decodeURIComponent(match[1]!); }
        catch { return fail(id, -32602, `malformed resource uri (bad percent-encoding): ${uri}`); }
        const result = match[2] === 'screen' ? await backend.read(principal, address)
          : backend.events ? await backend.events(principal, address)
          : { exitCode: 1 as const, message: 'els events: not available yet — no event request on the els server' };
        if (result.denied) return denied(id, result);
        if (result.exitCode !== 0) return fail(id, -32603, result.message);
        return ok(id, { contents: [{ uri, mimeType: match[2] === 'screen' ? 'text/plain' : 'application/json', text: result.message }] });
      }
      default: return fail(id, -32601, `method not found: ${request.method}`);
    }
  };

  return {
    principal: () => principal,
    handle,
    async handleLine(line) {
      if (line.trim() === '') return undefined;
      let request: JsonRpcRequest;
      try { request = JSON.parse(line) as JsonRpcRequest; } catch { return JSON.stringify(fail(null, -32700, 'parse error')); }
      if (typeof request !== 'object' || request === null || typeof request.method !== 'string') {
        return JSON.stringify(fail((request as { id?: JsonRpcResponse['id'] } | null)?.id ?? null, -32600, 'invalid request'));
      }
      try {
        const response = await handle(request);
        return response ? JSON.stringify(response) : undefined;
      } catch (error) {
        return JSON.stringify(fail(request.id ?? null, -32603, error instanceof Error ? error.message : String(error)));
      }
    },
  };
}

/** Pump stdin → session → stdout, answers in request order. Resolves when the input ends AND every
 *  answer is flushed to the OS: each write's callback is awaited, then `output.flush()` (when the stream
 *  has one — fsync for file outputs) completes before the returned promise settles. Write/input errors
 *  propagate to the caller. */
export function serveElsMcpStdio(backend: ElsMcpBackend, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const session = createElsMcpSession(backend);
  // stdout on a pipe is asynchronous — await each write's callback so every answer is handed to
  // the OS before the promise settles (no truncated JSON-RPC frames).
  const writeAll = (data: string) => new Promise<void>((resolve, reject) => output.write(data, (error) => (error ? reject(error) : resolve())));
  // The first failure (session or write) is captured here and re-thrown at `end`, so a broken
  // pipe rejects the caller's promise instead of dying as an unhandled rejection mid-stream.
  let failure: unknown;
  let queue: Promise<void> = Promise.resolve();
  const lines = createLineDecoder((line) => {
    queue = (queue.then(async () => {
      // The first failure stops the pump: later lines are dropped, never answered, and the
      // failure re-throws at `end`. Processing past a failure would answer from a broken pipe.
      if (failure !== undefined) return;
      const answer = await session.handleLine(line);
      if (answer !== undefined) await writeAll(`${answer}\n`);
    }).catch((error: unknown) => { failure ??= error; }) as Promise<void>);
  });
  // fs-style outputs expose flush(callback); sockets and in-memory streams do not — for those the
  // awaited write callbacks are the flush.
  const flushOutput = () => new Promise<void>((resolve, reject) => {
    const stream = output as Writable & { flush?: (callback: (error?: Error | null) => void) => void };
    if (typeof stream.flush === 'function') { stream.flush.call(output, (error) => (error ? reject(error) : resolve())); return; }
    resolve();
  });
  return new Promise((resolve, reject) => {
    input.on('error', reject);
    input.on('data', (chunk: Buffer | string) => lines.push(chunk));
    input.on('end', () => { void queue.then(() => { if (failure !== undefined) throw failure; return flushOutput(); }).then(() => resolve(), reject); });
  });
}
