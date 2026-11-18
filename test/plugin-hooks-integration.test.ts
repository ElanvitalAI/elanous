// ── PX-3 P5: 5 injection points end-to-end ──
//
// Each test registers a hook, exercises the injection site, and
// asserts the hook saw the event. We don't boot the full skill-runner
// (pulls massive fixture surface) — we verify:
//   • SubagentSpawn: dispatched inside dispatchAgent before registry.spawn
//   • Empty-chain paths: when no hooks are registered, the flow runs
//     untouched (no regression)
//   • StateRestore: dispatched once per plugin-host activate()

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalHookDispatcher } from '../src/plugin-hooks/dispatcher';
import { dispatchAgent } from '../src/skills/tools/agent';
import { globalAgentRegistry } from '../src/agent/registry';
import { PluginHost, type HostHooks } from '../src/plugins/core/host';
import { FsPluginStatePersistence } from '../src/plugin-state/persistence';
import type { AgentDefinition } from '../src/agent/types';
import type { LLMProvider, LLMStreamEvent } from '../src/llm';

function fakeProvider(turns: LLMStreamEvent[][]): LLMProvider {
  let call = 0;
  const p: LLMProvider = {
    name: 'fake', defaultModel: 'fake', available: () => true,
    async *streamChat() {
      const events = turns[call++] ?? [];
      for (const ev of events) yield ev;
    },
    async *chat(msgs, opts) {
      for await (const ev of p.streamChat!(msgs, opts)) {
        if (ev.type === 'text') yield ev.delta;
      }
    },
  };
  return p;
}

function simpleDef(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return { name: 'px3-test', systemPrompt: 'You are px3-test.', ...over };
}

describe('SubagentSpawn hook', () => {
  beforeEach(() => {
    globalHookDispatcher.clear();
    globalAgentRegistry.clear();
  });

  test('hook sees subagent_type + definition + prompt', async () => {
    const seen: any[] = [];
    globalHookDispatcher.register({
      id: 'test:spawn-observer', event: 'SubagentSpawn', priority: 50,
      invoke: (input) => { seen.push(input); return {}; },
    });
    const def = simpleDef();
    const provider = fakeProvider([[{ type: 'text', delta: 'done' }]]);
    await dispatchAgent(
      { description: 'scout', prompt: 'find X', subagent_type: 'px3-test' },
      { resolveAgentDef: (n) => (n === 'px3-test' ? def : undefined), provider },
    );
    expect(seen.length).toBe(1);
    expect(seen[0].subagentType).toBe('px3-test');
    expect(seen[0].prompt).toBe('find X');
    expect(seen[0].definition.name).toBe('px3-test');
  });

  test('overrideDefinition rewrites the spawned agent', async () => {
    globalHookDispatcher.register({
      id: 'test:spawn-upgrader', event: 'SubagentSpawn', priority: 50,
      invoke: () => ({ overrideDefinition: { model: 'claude-opus-4-7' } }),
    });
    const def = simpleDef();
    const provider = fakeProvider([[{ type: 'text', delta: 'done' }]]);
    const result = await dispatchAgent(
      { description: 'x', prompt: 'y', subagent_type: 'px3-test' },
      { resolveAgentDef: (n) => (n === 'px3-test' ? def : undefined), provider },
    );
    const task = globalAgentRegistry.get(result.taskId);
    expect(task?.definition.model).toBe('claude-opus-4-7');
  });

  test('abort directive stops the spawn', async () => {
    globalHookDispatcher.register({
      id: 'test:spawn-denier', event: 'SubagentSpawn', priority: 50,
      invoke: () => ({ abort: { reason: 'budget-check-failed' } }),
    });
    const def = simpleDef();
    const provider = fakeProvider([]);
    await expect(
      dispatchAgent(
        { description: 'x', prompt: 'y', subagent_type: 'px3-test' },
        { resolveAgentDef: (n) => (n === 'px3-test' ? def : undefined), provider },
      ),
    ).rejects.toThrow(/budget-check-failed/);
  });

  test('no hooks registered → zero overhead, original flow', async () => {
    // No registrations at all.
    const def = simpleDef();
    const provider = fakeProvider([[{ type: 'text', delta: 'done' }]]);
    // #38772: Agent calls run in the background by default; this test is about
    // the hook-free flow, so it asks for the blocking call explicitly.
    const result = await dispatchAgent(
      { description: 'x', prompt: 'y', subagent_type: 'px3-test', run_in_background: false },
      { resolveAgentDef: (n) => (n === 'px3-test' ? def : undefined), provider },
    );
    expect(result.output).toBe('done');
  });
});

describe('StateRestore hook', () => {
  let root: string;
  let builtinDir: string;
  let userRoot: string;

  function makeHostHooks(): HostHooks & { logs: string[] } {
    const logs: string[] = [];
    return { logs, log: (l) => logs.push(l), hudSet: () => {}, requestRender: () => {}, focusPane: () => {} };
  }

  beforeEach(() => {
    globalHookDispatcher.clear();
    root = mkdtempSync(join(tmpdir(), 'px3-sr-'));
    builtinDir = join(root, 'plugins');
    userRoot = join(root, 'state');
    mkdirSync(builtinDir);
    // Write a minimal plugin the host can activate.
    const dir = join(builtinDir, 'px3sr');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'plugin.ts'),
      `export default {
        name: 'px3sr', version: '0.1', description: 't',
        initialState: () => ({}), panes: {},
      };`,
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    globalHookDispatcher.clear();
  });

  test('StateRestore fires once per activate', async () => {
    const seen: any[] = [];
    globalHookDispatcher.register({
      id: 'test:sr', event: 'StateRestore', priority: 50,
      invoke: (input) => { seen.push(input); },
    });
    const host = new PluginHost(makeHostHooks(), null, {
      statePersistence: new FsPluginStatePersistence({ userRoot, warn: () => {} }),
    });
    (host as any).scanOverride = { builtin: builtinDir, user: '/none' };
    await (host as any).scanDir(builtinDir, 'builtin');
    await host.activate('px3sr');
    expect(seen.length).toBe(1);
    expect(seen[0].pluginId).toBe('px3sr');
  });

  test('no handlers → activate flow unchanged', async () => {
    const host = new PluginHost(makeHostHooks(), null, {
      statePersistence: new FsPluginStatePersistence({ userRoot, warn: () => {} }),
    });
    (host as any).scanOverride = { builtin: builtinDir, user: '/none' };
    await (host as any).scanDir(builtinDir, 'builtin');
    await host.activate('px3sr');
    expect(host.isActive('px3sr')).toBe(true);
  });
});
