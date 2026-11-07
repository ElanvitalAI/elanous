import { describe, expect, test } from 'bun:test';
import { AdapterRegistry } from '../src/agent/adapter-registry.js';
import { registerDefaultClaudePtyAdapter } from '../src/agent/adapters/claude-pty.js';
import { registerDefaultCodexPtyAdapter } from '../src/agent/adapters/codex-pty.js';
import { registerDefaultElanousAsChildAdapter } from '../src/agent/adapters/elanous-as-child.js';
import { registerDefaultGeminiPtyAdapter } from '../src/agent/adapters/gemini-pty.js';
import { registerDefaultLocalLlmPtyAdapter } from '../src/agent/adapters/local-llm-pty.js';
import { registerDefaultLocalLlmSshPtyAdapter } from '../src/agent/adapters/local-llm-ssh-pty.js';

function assertRegistration(
  register: (registry: AdapterRegistry) => () => void,
  expectedId: string,
): void {
  const registry = new AdapterRegistry();
  const dispose = register(registry);

  expect(registry.list().map(({ id }) => id)).toEqual([expectedId]);
  dispose();
  expect(registry.list()).toEqual([]);
}

describe('default adapter registration contract', () => {
  test('Claude registration returns a disposer for claude-pty', () => assertRegistration(registerDefaultClaudePtyAdapter, 'claude-pty'));
  test('Codex registration returns a disposer for codex-pty', () => assertRegistration(registerDefaultCodexPtyAdapter, 'codex-pty'));
  test('Elanous child registration returns a disposer for elanous-as-child', () => assertRegistration(registerDefaultElanousAsChildAdapter, 'elanous-as-child'));
  test('Gemini registration returns a disposer for gemini-pty', () => assertRegistration(registerDefaultGeminiPtyAdapter, 'gemini-pty'));
  test('local LLM registration returns a disposer for local-llm-pty', () => assertRegistration(registerDefaultLocalLlmPtyAdapter, 'local-llm-pty'));
  test('local LLM SSH registration returns a disposer for local-llm-ssh-pty', () => assertRegistration(registerDefaultLocalLlmSshPtyAdapter, 'local-llm-ssh-pty'));
});
