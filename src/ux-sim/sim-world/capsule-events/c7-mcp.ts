// C7 partial axis: real core turn -> registered MCP proxy; only the remote client and LLM are fake.
// This does not measure the provider-silence or harness axes, nor the capsule deadline event.
import { randomUUID } from 'node:crypto';
import { runCoreTurn } from '../../../core-turn/run-core-turn.js';
import { createMcpProxyRuntime } from '../../../mcp/proxy-runtime.js';
import { dispatchToolByName, registerToolRuntime, unregisterToolRuntime } from '../../../tool-runtime/registry.js';
import type { LLMProvider } from '../../../llm.js';
import type { SimWorldScenario } from '../types.js';

const c7: SimWorldScenario = {
  id: 'C7',
  title: 'silent MCP call is detached from the main turn',
  async run(ctx) {
    let release!: () => void;
    let entered!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const serverId = `c7_${randomUUID().replaceAll('-', '')}`;
    const proxy = createMcpProxyRuntime({ serverId, mcpTool: { name: 'silent' },
      authorizer: { isGranted: () => true },
      client: { async callTool() { entered(); await blocked; return { content: [] }; } },
    });
    registerToolRuntime(proxy);
    let calls = 0;
    const provider: LLMProvider = {
      name: 'c7-fake', defaultModel: 'c7-fake', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat() {
        if (++calls === 1) yield { type: 'tool_call', id: 'c7-call', name: proxy.id, args: {} };
        else yield { type: 'text', delta: 'main turn resumed' };
      },
    };
    const controller = new AbortController();
    const turn = runCoreTurn({ sessionId: `c7-${serverId}`, messages: [{ role: 'user', content: 'Run the probe.' }],
      tools: [proxy.spec], initialProvider: provider, signal: controller.signal,
      dispatchTool: (name, args) => dispatchToolByName(name, args, { surface: 'tui' }),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await Promise.race([called.then(() => 'called'), turn.then(() => 'ended'),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('not-called'), 5_000); })]);
      if (timer) clearTimeout(timer);
      if (first !== 'called') return { ok: false, reason: 'C7 MCP probe did not reach the proxy', diff: `probe ${first}` };
      const outcome = await Promise.race([turn.then(() => 'returned'),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('held'), 1_000); })]);
      if (timer) clearTimeout(timer);
      ctx.recorder.event('c7-mcp-main-turn', { outcome });
      if (outcome === 'held') return { ok: false, reason: 'silent MCP holds the main turn', diff: 'main turn still waiting one second after the MCP call' };
      return { ok: false, reason: 'C7 remaining axes unmeasured', diff: 'MCP turn returned; provider, harness and deadline failure event not measured' };
    } finally {
      if (timer) clearTimeout(timer);
      release();
      controller.abort();
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([turn.then(() => true, () => true),
          new Promise<boolean>(resolve => { cleanupTimer = setTimeout(() => resolve(false), 1_000); })]);
        if (!settled) throw new Error('C7 MCP turn did not settle after cleanup abort');
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer);
        unregisterToolRuntime(proxy.id);
      }
    }
  },
};
export const simWorldScenarios: readonly SimWorldScenario[] = [c7];
