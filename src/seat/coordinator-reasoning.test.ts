import { describe, expect, test } from 'bun:test';
import { coordinatorReasoningConfig } from './coordinator-reasoning.js';
import { seatRole } from './seat-role.js';
import { getProviderForConfig } from '../llm.js';
import { withRealProviderFakeFetchDevice } from '../ux-sim/fake-fetch.js';
import type { UserConfig } from '../user-config/types.js';

const config = (level?: 'off' | 'low' | 'medium' | 'high' | 'xhigh'): UserConfig =>
  ({ llm: { provider: 'openrouter', model: 'openrouter/qwen/qwen3.6-flash', apiKey: 'test-key', reasoningLevel: level } }) as UserConfig;

async function wire(cfg: UserConfig): Promise<any> {
  let body = '';
  await withRealProviderFakeFetchDevice([{ url: '/api/v1/chat/completions', method: 'POST', response: req => {
    body = req.body ?? ''; return new Response('data: [DONE]\n\n', { status: 200 });
  } }], async () => {
    for await (const _ of getProviderForConfig(cfg).streamChat!([{ role: 'user', content: 'hello' }])) { /* consume */ }
  });
  return JSON.parse(body);
}

describe('coordinator turn reasoning default', () => {
  test('registry role selects high on the wire; hand retains medium', async () => {
    const registry = [{ id: 'OPS', title: 'ops', role: 'coordinator' as const }, { id: 'HAND', title: 'hand' }];
    expect((await wire(coordinatorReasoningConfig(config(), seatRole('OPS', registry) === 'coordinator'))).reasoning).toEqual({ effort: 'high' });
    expect((await wire(coordinatorReasoningConfig(config(), seatRole('HAND', registry) === 'coordinator'))).reasoning).toEqual({ effort: 'medium' });
  });
  test('explicit levels and codex override survive without mutating configuration', async () => {
    for (const level of ['off', 'low', 'medium', 'high', 'xhigh'] as const) {
      const cfg = config(level);
      expect(coordinatorReasoningConfig(cfg, true)).toBe(cfg);
    }
    const cfg = config();
    expect(coordinatorReasoningConfig(cfg, true).llm.reasoningLevel).toBe('high');
    expect(cfg.llm.reasoningLevel).toBeUndefined();
    const codex = { ...cfg, llm: { ...cfg.llm, codexReasoning: { effort: 'low' as const } } };
    expect(coordinatorReasoningConfig(codex, true)).toBe(codex);
    expect((await wire(coordinatorReasoningConfig(config('low'), true))).reasoning).toEqual({ effort: 'low' });
    expect((await wire(coordinatorReasoningConfig(config('off'), true))).reasoning).toBeUndefined();
  });
});
