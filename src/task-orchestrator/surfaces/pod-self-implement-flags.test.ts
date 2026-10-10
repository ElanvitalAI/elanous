// The Pod runs `elanous self implement … <flags>`. A flag the command does not register kills the Pod
// at argument parsing (2026-09-28: the grok fallback passed --child-llm-provider and every grok Pod died with
// «unknown option»). These guards tie the flags the Pod sends to the flags the command accepts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSelfImplementDevSpec } from '../../self-dev/dev-pipeline.js';
import { podChildLlmArgs } from './self-implement-pod.js';

const src = (rel: string) => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8');

describe('Pod → self implement flag contract', () => {
  test('every flag the Pod passes to `self implement` is registered on that command', () => {
    const pod = src('task-orchestrator/surfaces/self-implement-pod.ts');
    const index = src('index.ts');
    // `[feature...]` since PROC1: the feature may come from --feature-file instead of argv.
    const start = index.indexOf(".command('implement [feature...]')");
    expect(start).toBeGreaterThan(0);
    const block = index.slice(start, index.indexOf('.action(', start));
    const argsStart = pod.indexOf('const args = [');
    expect(argsStart).toBeGreaterThan(0);
    const argsBlock = pod.slice(argsStart, pod.indexOf('\n    ];', argsStart));
    const sent = new Set([...argsBlock.matchAll(/'(--[a-z][a-z-]+)'/g)].map((m) => m[1]!));
    // Child LLM flags come from podChildLlmArgs since PODPROVIDER (10-05) — take them from the real helper.
    for (const flag of [
      ...podChildLlmArgs({ provider: 'grok' }),
      ...podChildLlmArgs({ provider: 'openai-codex', childProviderExplicit: true, childModel: 'm', childEffort: 'high' }),
    ]) if (flag.startsWith('--')) sent.add(flag);
    expect([...sent]).toContain('--child-llm-provider');
    const missing = [...sent].filter((flag) => !block.includes(`.option('${flag}`));
    expect(missing).toEqual([]);
  });

  // LAUNCH-POLICY-UNIV(#25799): the caps come from the operational launch policy, not the universe-local user config.
  test('the Pod account plan receives the per-account caps from config', () => {
    const index = src('index.ts');
    const at = index.indexOf('planPodProvider({');
    expect(at).toBeGreaterThan(0);
    const call = index.slice(at, at + 600);
    expect(call).toContain('thresholdPercentByAccount: launchPolicy.llm?.codexAccountRotationThresholdPercentByAccount');
  });

  test('--child-llm-provider/--child-llm-model reach the dev spec', () => {
    const spec = buildSelfImplementDevSpec({ feature: 'x', draft: true, childLlm: { provider: 'grok', model: 'grok-4.7', source: 'flag' } });
    expect(spec.self?.childLlm).toEqual({ provider: 'grok', model: 'grok-4.7', source: 'flag' });
    expect(buildSelfImplementDevSpec({ feature: 'x', draft: true }).self?.childLlm).toBeUndefined();
  });
});
