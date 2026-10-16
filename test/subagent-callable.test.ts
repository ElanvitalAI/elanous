// ── createGlobalSubagentCallable · unit tests ──
//
// Phase 2 of RESEARCH-tox-surface-agnostic-boot-2026-05-13. Verifies
// the bridge between TOX's SubagentCallable contract and elanous's
// process-wide AgentRegistry. Real-LLM exercise lives in integration
// tests — here we lock in the no-LLM contract paths (resolve failure,
// id passthrough, signal chaining, model copy-on-write).

import { describe, expect, test } from 'bun:test';

import { AgentRegistry } from '../src/agent/registry.ts';
import { createGlobalSubagentCallable } from '../src/agent/subagent-callable.ts';
import type { AgentDefinition } from '../src/agent/types.ts';

function def(name = 'test-agent'): AgentDefinition {
  return { name, systemPrompt: '' };
}

describe('createGlobalSubagentCallable', () => {
  test('returns failed status when definitionName cannot be resolved', async () => {
    const registry = new AgentRegistry();
    const callable = createGlobalSubagentCallable({
      registry,
      resolveDefinition: () => undefined,
    });

    const handle = await callable({
      definitionName: 'no-such',
      prompt: 'whatever',
    });

    expect(handle.address).toContain('unknown');
    const result = await handle.done;
    expect(result.status).toBe('failed');
    expect(result.output).toContain('no-such');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('spawns through the registry and returns task.id as address', async () => {
    const registry = new AgentRegistry();
    const callable = createGlobalSubagentCallable({
      registry,
      resolveDefinition: (name) => def(name),
    });
    // Abort pre-spawn so the runner's first await unwinds without
    // touching a real LLM. The address check is the contract piece
    // we're locking in.
    const controller = new AbortController();
    controller.abort();
    const handle = await callable({
      definitionName: 'test-agent',
      prompt: 'hi',
      signal: controller.signal,
    });

    expect(handle.address).toMatch(/^[0-9a-f]{8}-/);
    expect(registry.get(handle.address)).toBeDefined();
    await handle.done;
  });

  test('pre-aborted external signal surfaces as cancelled/failed', async () => {
    const registry = new AgentRegistry();
    const callable = createGlobalSubagentCallable({
      registry,
      resolveDefinition: (name) => def(name),
    });

    const controller = new AbortController();
    controller.abort();

    const handle = await callable({
      definitionName: 'test-agent',
      prompt: 'hi',
      signal: controller.signal,
    });

    expect(registry.get(handle.address)?.controller.signal.aborted).toBe(true);
    const result = await handle.done;
    expect(result.status).toBe('cancelled');
    expect(typeof result.output).toBe('string');
    expect(typeof result.durationMs).toBe('number');
  });

  test('model override applies copy-on-write — original definition stays clean', async () => {
    const registry = new AgentRegistry();
    let observed: AgentDefinition | undefined;
    const callable = createGlobalSubagentCallable({
      registry,
      resolveDefinition: (name) => {
        observed = def(name);
        return observed;
      },
    });
    const controller = new AbortController();
    controller.abort();

    const handle = await callable({
      definitionName: 'test-agent',
      prompt: 'hi',
      model: 'haiku-fast',
      signal: controller.signal,
    });

    // Spawned task carries the overridden model
    expect(registry.get(handle.address)?.definition.model).toBe('haiku-fast');
    // Cached definition object MUST NOT be mutated
    expect(observed?.model).toBeUndefined();
    await handle.done;
  });

  test('no signal supplied: callable still returns a handle synchronously', async () => {
    const registry = new AgentRegistry();
    const callable = createGlobalSubagentCallable({
      registry,
      resolveDefinition: () => undefined, // unresolved → synthetic failure path
    });

    const handle = await callable({ definitionName: 'x', prompt: 'y' });
    expect(handle.address).toBeDefined();
    const result = await handle.done;
    expect(result.status).toBe('failed');
  });
});
