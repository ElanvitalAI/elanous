import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AgentCard, Message } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import { createAgentCard } from './agent-card.js';

export interface A2AServerOptions {
  host?: string;
  port?: number;
  /** Externally reachable RPC URL advertised in the card (e.g. https://agent.example.com/a2a). */
  publicUrl?: string;
  /** Explicit working directory for all tools; never inferred from the HTTP client or process cwd. */
  toolCwd: string;
  /** Defaults to ELANOUS_A2A_TOKEN. Never included in the public agent card. */
  bearerToken?: string;
  /** Test seam; the default runs the real elanous daemon turn with the chat tool surface. */
  runTurn?: (input: { text: string; contextId: string; toolCwd: string }) => Promise<string>;
  /** Test seam for the default turn; no daemon or LLM needed to inspect its request. */
  runDaemonTurn?: typeof import('../boot/daemon-prompt-turn.js').runDaemonPromptTurn;
}

const CARD_PATH = '/.well-known/agent-card.json';
const RPC_PATH = '/a2a';

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export function advertisedRpcUrl(publicUrl: string | undefined, host: string, boundPort: number): string {
  const wildcard = host === '0.0.0.0' || host === '::' || host === '[::]';
  if (publicUrl !== undefined && !publicUrl) {
    throw new Error('A2A publicUrl must be an absolute HTTP(S) RPC URL');
  }
  if (!publicUrl && wildcard) {
    throw new Error('A2A wildcard bind requires an explicit externally reachable publicUrl');
  }
  const value = publicUrl ?? `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${boundPort}${RPC_PATH}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('A2A publicUrl must be an absolute HTTP(S) RPC URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname ||
      url.username || url.password || url.search || url.hash || !url.pathname.endsWith(RPC_PATH) ||
      url.port === '0' || ['0.0.0.0', '[::]', '::'].includes(url.hostname) ||
      (wildcard && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'))) {
    throw new Error('A2A publicUrl must be an externally reachable HTTP(S) RPC URL ending in /a2a');
  }
  return url.href;
}

function tokenMatches(header: string | null, expectedDigest: Buffer): boolean {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  const actual = createHash('sha256').update(match?.[1] ?? '').digest();
  return match !== null && timingSafeEqual(actual, expectedDigest);
}

/** Bind a standalone A2A JSON-RPC v0.3 endpoint. Discovery is public; RPC is bearer-only. */
export function startA2AServer(opts: A2AServerOptions): Bun.Server<undefined> {
  const token = opts.bearerToken ?? process.env.ELANOUS_A2A_TOKEN;
  if (!token || !token.trim() || /\s/.test(token)) {
    throw new Error('A2A requires a configured bearer token (ELANOUS_A2A_TOKEN)');
  }
  if (!opts.toolCwd || !isAbsolute(opts.toolCwd) || !statSync(opts.toolCwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('A2A requires an explicit, existing absolute --tool-cwd directory');
  }
  const expectedDigest = createHash('sha256').update(token).digest();
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 4123;
  // Reject invalid advertised endpoints before binding the listener.
  const publicUrl = opts.publicUrl !== undefined || host === '0.0.0.0' || host === '::' || host === '[::]'
    ? advertisedRpcUrl(opts.publicUrl, host, port)
    : undefined;
  let history: import('../boot/daemon-runtime.js').DaemonSessionHistory | undefined;
  const runTurn = opts.runTurn ?? (async ({ text, contextId, toolCwd }) => {
    const [{ runDaemonPromptTurn }, { toolSurface }, { DaemonSessionHistory }] = await Promise.all([
      import('../boot/daemon-prompt-turn.js'),
      import('../boot/daemon-tools/index.js'),
      import('../boot/daemon-runtime.js'),
      // toolSurface() require()s shared-app-tools, an async module. The CLI entry has already evaluated
      // it, but a process that has not (tests, embedders) gets a throw on every default turn. Evaluate it here.
      import('../agent/shared-app-tools.js'),
    ]);
    history ??= new DaemonSessionHistory();
    const result = await (opts.runDaemonTurn ?? runDaemonPromptTurn)({
      history,
      request: {
        sessionId: contextId,
        userText: text,
        userContent: null,
        source: { kind: 'daemon-api', route: '/a2a' },
        effectiveSystemPrompt: undefined,
        tools: null,
      },
      toolSurface: toolSurface('chat'),
      toolCwd,
      dispatchToolErrorMessage: 'A2A tool surface unavailable',
    });
    return result.text;
  });
  const executor: AgentExecutor = {
    async execute(context, eventBus) {
      try {
        const parts = context.userMessage.parts;
        if (!parts.length || parts.some((part) => part.kind !== 'text' || typeof part.text !== 'string')) {
          eventBus.publish({ kind: 'message', messageId: randomUUID(), role: 'agent',
            contextId: context.contextId, parts: [{ kind: 'text', text: 'A2A message/send requires text parts' }] });
          return;
        }
        const text = parts.map((part) => (part as { text: string }).text).join('\n');
        const reply = await runTurn({ text, contextId: context.contextId, toolCwd: opts.toolCwd });
        const message: Message = {
          kind: 'message',
          messageId: randomUUID(),
          role: 'agent',
          contextId: context.contextId,
          parts: [{ kind: 'text', text: reply }],
        };
        eventBus.publish(message);
      } catch {
        // The SDK converts executor exceptions into failed tasks; never echo internal errors or secrets.
        throw new Error('A2A turn failed');
      } finally {
        eventBus.finished();
      }
    },
    async cancelTask() {},
  };

  let server: Bun.Server<undefined>;
  const card = (): AgentCard => createAgentCard(publicUrl ?? advertisedRpcUrl(undefined, host, server.port ?? port)) as AgentCard;
  // SDK 0.3 owns JSON-RPC validation, method dispatch and response envelopes.
  let transport: JsonRpcTransportHandler | undefined;
  server = Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === CARD_PATH && request.method === 'GET') return json(card());
      if (url.pathname !== RPC_PATH) return new Response('Not found', { status: 404 });
      if (!tokenMatches(request.headers.get('authorization'), expectedDigest)) {
        return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
      }
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      // The card declares synchronous text-only service. Do not expose streaming or task operations.
      if (!body || typeof body !== 'object' || (body as { method?: unknown }).method !== 'message/send') {
        return json({ jsonrpc: '2.0', id: (body as { id?: unknown } | null)?.id ?? null,
          error: { code: -32601, message: 'Method not found' } });
      }
      transport ??= new JsonRpcTransportHandler(new DefaultRequestHandler(card(), new InMemoryTaskStore(), executor));
      const result = await transport.handle(body);
      if (Symbol.asyncIterator in Object(result)) {
        return json({ jsonrpc: '2.0', id: (body as { id?: unknown }).id ?? null,
          error: { code: -32601, message: 'Method not found' } });
      }
      return json(result);
    },
  });
  return server;
}
