import { expect, test } from 'bun:test';
import { reemitPodUsage } from './self-implement-pod.js';
import { rollup } from '../../../scripts/usage-rollup.js';

test('Pod usage rollup preserves role buckets through host re-emission and dedup keys', () => {
  const raw = (tags: Record<string, unknown>, tokens: number) => JSON.stringify({ event: 'llm-usage', data: {
    site: 'agent-turn', provider: 'openai-codex', model: 'test-model', ...tags,
    inputTokens: tokens, outputTokens: 1,
  } });
  const sourceRows = rollup([raw({ role: 'implement', stage: 'code', account: 'observed-account' }, 10), raw({ role: 'review', stage: 'review', account: null }, 4)]).rows;
  const line = `ELANOUS_USAGE_ROLLUP ${JSON.stringify({ runId: 'run-1', podName: 'pod-1', rows: sourceRows })}`;
  const usage: Record<string, unknown>[] = [];
  const count = reemitPodUsage(line, 'job-1', (category, event, data) => {
    if (category === 'llm.usage' && event === 'llm-usage') usage.push(data);
  });
  expect(count).toBe(2);
  expect(usage.map((row) => [row.role, row.stage, row.account, row.inputTokens])).toEqual([
    ['implement', 'code', 'observed-account', 10], ['review', 'review', undefined, 4],
  ]);
  expect(new Set(usage.map((row) => row.podRollupKey)).size).toBe(2);
  expect('account' in usage[1]!).toBe(false);
});

test('legacy partial null and final missing tags yield the same host dedup key', () => {
  const row = { site: 'agent-turn', provider: 'openai-codex', model: 'test-model', calls: 1, inputTokens: 1, outputTokens: 1 };
  const emit = (partial: boolean) => {
    const usage: Record<string, unknown>[] = [];
    const prefix = partial ? 'ELANOUS_USAGE_ROLLUP_PARTIAL ' : 'ELANOUS_USAGE_ROLLUP ';
    const line = prefix + JSON.stringify({ runId: 'run-1', podName: 'pod-1', rows: [{ ...row, ...(partial ? { account: null, role: ' ' } : {}) }] });
    reemitPodUsage(line, 'job-1', (category, event, data) => {
      if (category === 'llm.usage' && event === 'llm-usage') usage.push(data);
    });
    return usage[0]!;
  };
  const partial = emit(true), final = emit(false);
  expect(partial.podRollupKey).toBe(final.podRollupKey);
  expect('role' in partial || 'account' in partial).toBe(false);
});
