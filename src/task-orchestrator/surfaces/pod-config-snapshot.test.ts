import { expect, test } from 'bun:test';
import type { UserConfig } from '../../user-config.js';
import { buildPodConfigSnapshot } from './pod-config-snapshot.js';

test('effective Pod config snapshot carries allowlisted settings with sources and excludes credentials', () => {
  const host = {
    llm: { fallbackChain: ['grok'], zaiCodingPlan: { overage: 'balance' }, apiKey: 'leak-1', openrouterKey: 'leak-7', cookie: 'leak-8' },
    roleLlm: { planning: { provider: 'openrouter', model: 'model-a' }, authToken: 'leak-2' },
    harness: { worktreeAddTimeoutSec: 900, nested: { maxVisits: 3, password: 'leak-3' }, bearer: 'leak-9' },
    tools: { selfImplement: { podChildDefault: { provider: 'grok' }, secret: 'leak-4' }, other: { enabled: true } },
    loops: { orchestrator: { enabled: true, apiKey: 'leak-5', webhook: 'leak-10' }, unrelated: { enabled: true } },
    token: 'leak-6',
  } as unknown as UserConfig;
  const result = buildPodConfigSnapshot(host, { steps: ['codex-rotate', 'grok'], overage: 'stop', worktreeAddTimeoutSec: 1200 });
  const reverse = buildPodConfigSnapshot({
    loops: (host as any).loops, tools: (host as any).tools, harness: (host as any).harness,
    roleLlm: (host as any).roleLlm, llm: (host as any).llm,
  } as UserConfig, { steps: ['codex-rotate', 'grok'], overage: 'stop', worktreeAddTimeoutSec: 1200 });
  expect(result).toEqual(reverse);
  expect(result.version).toBe(1);
  expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  const keys = JSON.parse(result.configJson);
  expect(keys.llm.fallbackChain).toEqual(['codex-rotate', 'grok']);
  expect(keys.harness.worktreeAddTimeoutSec).toBe(1200);
  expect(keys.roleLlm.planning.provider).toBe('openrouter');
  expect(keys.tools.selfImplement.podChildDefault.provider).toBe('grok');
  expect(keys.loops.orchestrator.enabled).toBe(true);
  expect(keys.tools.other).toBeUndefined();
  expect(keys.loops.unrelated).toBeUndefined();
  expect(result.sources['llm.fallbackChain']).toBe('runtime');
  expect(result.sources['harness.worktreeAddTimeoutSec']).toBe('runtime');
  expect(result.sources['roleLlm.planning.provider']).toBe('host-effective');
  expect(result.envelopeJson).not.toMatch(/leak-|apiKey|authToken|password|secret|token|cookie|bearer|webhook/i);
  expect(keys).toEqual(result.keys);
});

test('invalid blank Pod child provider is not carried into the snapshot', () => {
  const result = buildPodConfigSnapshot({ tools: { selfImplement: { podChildDefault: { provider: '   ', model: 'x' } } } } as UserConfig,
    { steps: [], overage: 'stop', worktreeAddTimeoutSec: 1200 });
  expect(result.keys.tools).toBeUndefined();
  expect(result.keys.loops).toBeUndefined();
  expect(result.keys.roleLlm).toBeUndefined();
});

test('runtime overrides produce one canonical snapshot regardless of host key placement', () => {
  const runtime = { steps: ['codex-rotate'], overage: 'stop' as const, worktreeAddTimeoutSec: 1200 };
  const withoutRuntimeKeys = buildPodConfigSnapshot({ llm: { provider: 'codex' }, harness: { authorGrade: 'lite' } } as UserConfig, runtime);
  const withRuntimeKeys = buildPodConfigSnapshot({
    llm: { fallbackChain: ['grok'], zaiCodingPlan: { overage: 'balance' }, provider: 'codex' },
    harness: { worktreeAddTimeoutSec: 900, authorGrade: 'lite' },
  } as UserConfig, runtime);
  expect(withoutRuntimeKeys.configJson).toBe(withRuntimeKeys.configJson);
  expect(withoutRuntimeKeys.envelopeJson).toBe(withRuntimeKeys.envelopeJson);
  expect(withoutRuntimeKeys.hash).toBe(withRuntimeKeys.hash);
});
