// The Pod runs `elanous self implement … <flags>`. A flag the command does not register kills the Pod
// at argument parsing (2026-09-28: the grok fallback passed --child-llm-provider and every grok Pod died with
// «unknown option»). These guards tie the flags the Pod sends to the flags the command accepts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSelfImplementDevSpec } from '../../self-dev/dev-pipeline.js';

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
    expect([...sent]).toContain('--child-llm-provider');
    const missing = [...sent].filter((flag) => !block.includes(`.option('${flag}`));
    expect(missing).toEqual([]);
  });

  test('the Pod account plan receives the per-account caps from config', () => {
    const index = src('index.ts');
    const call = index.slice(index.indexOf('const plan = planPodProvider({'), index.indexOf('const plan = planPodProvider({') + 600);
    expect(call).toContain('thresholdPercentByAccount: getUserConfig().llm?.codexAccountRotationThresholdPercentByAccount');
  });

  test('--child-llm-provider/--child-llm-model reach the dev spec', () => {
    const spec = buildSelfImplementDevSpec({ feature: 'x', draft: true, childLlm: { provider: 'grok', model: 'grok-4.7', source: 'flag' } });
    expect(spec.self?.childLlm).toEqual({ provider: 'grok', model: 'grok-4.7', source: 'flag' });
    expect(buildSelfImplementDevSpec({ feature: 'x', draft: true }).self?.childLlm).toBeUndefined();
  });
});
