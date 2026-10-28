import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import * as podChildDefault from './pod-child-default.js';
import { buildPodConfigSnapshot } from './pod-config-snapshot.js';
const { POD_CHILD_DEFAULT, resolvePodChildDefault } = podChildDefault;
import type { UserConfig } from '../../user-config.js';
import { podChildLlmArgs, podNamedChildProvider } from './self-implement-pod.js';

// SUBSCRIPTION-EXHAUST-REROUTE (0.2.24 · P0) — a Pod launch with no child model no longer falls to codex.
const base = { flags: {}, benchArms: false, config: undefined, openrouterKeyPresent: () => true };

describe('resolvePodChildDefault — Pod child default model off codex', () => {
  test('no flag ⇒ openrouter/z-ai/glm-5.3 (default) ⇒ the same Pod args a named openrouter launch carries', () => {
    const d = resolvePodChildDefault(base);
    expect(d).toEqual({ apply: true, provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', source: 'default' });
    if (!d.apply) throw new Error('unreachable');
    expect(podNamedChildProvider(d.provider, { grokSubscription: false, grokApiKey: false, openrouterKey: true }, d.model)).toEqual({ provider: 'openrouter' });
    expect(podChildLlmArgs({ provider: 'openrouter', childModel: d.model, childProviderExplicit: true }))
      .toEqual(['--child-llm-provider', 'openrouter', '--child-llm-model', 'openrouter/z-ai/glm-5.3']);
  });

  test('snapshot child preference uses the same parsed provider/model as resolvePodChildDefault', () => {
    for (const config of [undefined, { provider: 'grok', model: ' custom ' }, 'off', false, { provider: 'openrouter', model: 'm', secret: 'never' }]) {
      const decision = resolvePodChildDefault({ ...base, config });
      const snapshot = JSON.parse(buildPodConfigSnapshot({ llm: {}, tools: { selfImplement: { podChildDefault: config } } } as unknown as UserConfig,
        { steps: ['codex-rotate'], overage: 'stop', worktreeAddTimeoutSec: 1200 }).configJson);
      if (config === undefined) expect(snapshot.tools).toBeUndefined();
      else if (decision.apply) expect(snapshot.tools.selfImplement.podChildDefault).toEqual({ provider: decision.provider, ...(decision.model ? { model: decision.model } : {}) });
      else expect(snapshot.tools.selfImplement.podChildDefault).toBe('off');
      expect(JSON.stringify(snapshot)).not.toContain('never');
    }
  });

  test('explicit --child-llm-* always wins (provider, model or effort alone)', () => {
    for (const flags of [{ provider: 'openai-codex' }, { provider: 'grok' }, { model: 'm' }, { effort: 'high' }]) {
      expect(resolvePodChildDefault({ ...base, flags })).toEqual({ apply: false, reason: 'flag' });
    }
  });

  test('bench arms and --pod-account keep their own model choice', () => {
    expect(resolvePodChildDefault({ ...base, benchArms: true })).toEqual({ apply: false, reason: 'bench-arms' });
    expect(resolvePodChildDefault({ ...base, explicitPodAccount: 'team' })).toEqual({ apply: false, reason: 'pod-account' });
  });

  test('config tools.selfImplement.podChildDefault: object wins · off = old codex default · invalid = default with evidence', () => {
    expect(resolvePodChildDefault({ ...base, config: { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3-flash' } }))
      .toEqual({ apply: true, provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3-flash', source: 'config' });
    expect(resolvePodChildDefault({ ...base, config: { provider: 'grok' } })).toEqual({ apply: true, provider: 'grok', source: 'config' });
    expect(resolvePodChildDefault({ ...base, config: 'off' })).toEqual({ apply: false, reason: 'config-off', source: 'config' });
    expect(resolvePodChildDefault({ ...base, config: false })).toEqual({ apply: false, reason: 'config-off', source: 'config' });
    expect(resolvePodChildDefault({ ...base, config: 42 })).toMatchObject({ apply: true, ...POD_CHILD_DEFAULT, source: 'default', invalidConfig: 42 });
  });

  test('no OpenRouter key on the host ⇒ skip the default (old codex path), never refuse the launch', () => {
    expect(resolvePodChildDefault({ ...base, openrouterKeyPresent: () => false }))
      .toEqual({ apply: false, reason: 'no-openrouter-key', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', source: 'default' });
    let asked = 0;
    expect(resolvePodChildDefault({ ...base, config: { provider: 'grok' }, openrouterKeyPresent: () => { asked++; return false; } }).apply).toBe(true);
    expect(asked).toBe(0);
  });
});

// Runtime wiring (the real `self orchestrate --substrate pod` action) is locked in harness-substrate-default.test.ts.

describe('config — tools.selfImplement.podChildDefault survives buildUserConfig', () => {
  test('the raw value reaches the launch policy (absent stays absent)', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { buildUserConfig } = await import('../../user-config.js');
    const dir = mkdtempSync(join(tmpdir(), 'pod-child-default-'));
    const withValue = join(dir, 'a.json');
    writeFileSync(withValue, JSON.stringify({ tools: { selfImplement: { podChildDefault: { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3-flash' } } } }));
    expect((buildUserConfig(withValue).tools.selfImplement as { podChildDefault?: unknown }).podChildDefault)
      .toEqual({ provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3-flash' });
    const without = join(dir, 'b.json');
    writeFileSync(without, JSON.stringify({ tools: { selfImplement: {} } }));
    expect(buildUserConfig(without).tools.selfImplement).not.toHaveProperty('podChildDefault');
  });
});
