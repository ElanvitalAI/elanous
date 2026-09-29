import { describe, expect, spyOn, test } from 'bun:test';
import * as llm from '../llm.js';
import * as tierFlip from '../session-runtime/tier-flip.js';
import { globalDualRoleManager } from '../acp/dual-role-manager.js';
import { startA2AServer } from './server.js';

const cwd = import.meta.dir;
const token = 'test-only-a2a-secret';

function rpcRequest(url: string, authorization?: string, method = 'message/send'): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 9, method,
      params: { message: { kind: 'message', role: 'user', messageId: 'msg-1', parts: [{ kind: 'text', text: 'hello' }] } },
    }),
  });
}

describe('A2A server', () => {
  test('fails closed before binding without token or explicit working directory', () => {
    expect(() => startA2AServer({ toolCwd: cwd, bearerToken: '' })).toThrow('bearer token');
    expect(() => startA2AServer({ toolCwd: '', bearerToken: token })).toThrow('--tool-cwd');
    expect(() => startA2AServer({ toolCwd: 'relative', bearerToken: token })).toThrow('--tool-cwd');
    expect(() => startA2AServer({ toolCwd: '/definitely/not/a/working/directory', bearerToken: token })).toThrow('--tool-cwd');
  });

  test('wildcard bind requires a separately configured reachable public RPC URL before binding', () => {
    for (const host of ['0.0.0.0', '::']) {
      expect(() => startA2AServer({ host, port: 0, toolCwd: cwd, bearerToken: token })).toThrow('publicUrl');
      for (const publicUrl of [
        '', 'not-a-url', 'ftp://agent.example.com/a2a', 'https://agent.example.com/other',
        'https://0.0.0.0/a2a', 'http://[::]/a2a', 'https://localhost/a2a',
        'https://127.0.0.1/a2a', 'https://agent.example.com/a2a?token=oops',
        'https://user:password@agent.example.com/a2a',
      ]) {
        expect(() => startA2AServer({ host, port: 0, toolCwd: cwd, bearerToken: token, publicUrl })).toThrow('publicUrl');
      }
    }
  });

  test('card advertises explicit reachable URL independent of wildcard bind while RPC remains protected', async () => {
    const calls: string[] = [];
    const publicUrl = 'https://agent.example.com/delegation/a2a';
    const server = startA2AServer({
      host: '0.0.0.0', port: 0, toolCwd: cwd, bearerToken: token, publicUrl,
      runTurn: async ({ text }) => { calls.push(text); return `answered ${text}`; },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${base}/.well-known/agent-card.json`);
      expect(response.status).toBe(200);
      const card = await response.json();
      expect(card.url).toBe(publicUrl);
      expect(card.security).toEqual([{ bearerAuth: [] }]);
      expect(JSON.stringify(card)).not.toContain(token);
      expect((await rpcRequest(`${base}/a2a`)).status).toBe(401);
      expect(calls).toHaveLength(0);
      const result = await (await rpcRequest(`${base}/a2a`, `Bearer ${token}`)).json();
      expect(result.result.parts).toEqual([{ kind: 'text', text: 'answered hello' }]);
      expect(calls).toEqual(['hello']);
    } finally {
      server.stop(true);
    }
  });

  test('default runTurn carries trusted A2A source into the daemon turn', async () => {
    let seenSource: unknown;
    const server = startA2AServer({
      port: 0, toolCwd: cwd, bearerToken: token,
      runDaemonTurn: async ({ request, toolSurface }) => {
        seenSource = request.source;
        expect(toolSurface!.kind).toBe('chat');
        return { text: 'ok', sessionId: request.sessionId, stopReason: 'end_turn' };
      },
    });
    try {
      const response = await rpcRequest(`http://127.0.0.1:${server.port}/a2a`, `Bearer ${token}`);
      expect(response.status).toBe(200);
      expect(seenSource).toEqual({ kind: 'daemon-api', route: '/a2a' });
    } finally {
      server.stop(true);
    }
  });

  test('default A2A turn dispatch reaches ACP with external-agent origin and keeps the turn alive', async () => {
    const start = spyOn(globalDualRoleManager(), 'clientSessionCreate').mockImplementation(async () => {
      throw new Error('test ACP connection must not start');
    });
    let modelRounds = 0;
    const results: unknown[] = [];
    const tier = spyOn(tierFlip, 'applyDeferredTools').mockImplementation((messages, tools) => ({
      messages: [...messages], tools: [...tools],
      stats: { activeCount: tools.length, deferredCount: 0, warmPreloaded: 0, injected: false, toolSearchInjected: false,
        deferredNames: [], unhydratableNames: [], unhydratableCount: 0 },
    }));
    const provider = spyOn(llm, 'resolveDefaultProvider').mockImplementation(() => ({
      name: 'local', defaultModel: 'test-model', available: () => true,
      async *chat() { yield 'continued after refusal'; },
      async *streamChat(_messages, opts) {
        modelRounds += 1;
        expect(opts?.tools?.map((spec) => spec.name)).toContain('AcpSessionCreate');
        if (modelRounds === 1) {
          yield { type: 'tool_call' as const, id: 'call-claude', name: 'AcpSessionCreate', args: { brand: 'claude' } };
        } else {
          results.push(_messages.filter((message) => message.role === 'user').at(-1)?.content);
          yield { type: 'text' as const, delta: 'continued after refusal' };
        }
      },
    }));
    const server = startA2AServer({ port: 0, toolCwd: cwd, bearerToken: token });
    try {
      const response = await rpcRequest(`http://127.0.0.1:${server.port}/a2a`, `Bearer ${token}`);
      expect(response.status).toBe(200);
      const reply = await response.json();
      expect(reply.result.parts).toEqual([{ kind: 'text', text: 'continued after refusal' }]);
      expect(modelRounds).toBe(2);
      expect(JSON.stringify(results)).toContain('소유자의 Claude 구독');
      expect(start).not.toHaveBeenCalled();
    } finally {
      server.stop(true);
      provider.mockRestore();
      tier.mockRestore();
      start.mockRestore();
    }
  });

  test('public card, protected SDK message/send, non-send methods denied', async () => {
    const turns: { text: string; contextId: string; toolCwd: string }[] = [];
    const server = startA2AServer({
      port: 0, toolCwd: cwd, bearerToken: token,
      runTurn: async (input) => { turns.push(input); return `answered ${input.text}`; },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const cardResponse = await fetch(`${base}/.well-known/agent-card.json`);
      const card = await cardResponse.json();
      expect(cardResponse.status).toBe(200);
      expect(card.url).toBe(`${base}/a2a`);
      expect(card.security).toEqual([{ bearerAuth: [] }]);
      expect(JSON.stringify(card)).not.toContain(token);
      expect((await rpcRequest(`${base}/a2a`)).status).toBe(401);
      expect((await rpcRequest(`${base}/a2a`, 'Bearer wrong')).status).toBe(401);
      expect(turns).toHaveLength(0);
      const response = await rpcRequest(`${base}/a2a`, `Bearer ${token}`);
      const result = await response.json();
      expect(response.status).toBe(200);
      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe(9);
      expect(result.result.kind).toBe('message');
      expect(result.result.parts).toEqual([{ kind: 'text', text: 'answered hello' }]);
      expect(turns).toEqual([{ text: 'hello', contextId: result.result.contextId, toolCwd: cwd }]);
      const unsupported = await rpcRequest(`${base}/a2a`, `Bearer ${token}`, 'message/stream');
      expect((await unsupported.json()).error.code).toBe(-32601);
      expect(turns).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });
});
