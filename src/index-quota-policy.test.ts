import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from './debug/log.js';
import { announceLaunchQuotaPolicy, withLaunchQuotaPolicy } from './index.js';

test('the Pod orchestrator announces its resolved policy and includes it in the final JSON array', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const pod = source.slice(source.indexOf("if (substrate === 'pod') {", source.indexOf(".command('orchestrate [goals...]')")),
    source.indexOf("} else if (substrate !== 'local')", source.indexOf(".command('orchestrate [goals...]')")));
  expect(pod).toContain('announceLaunchQuotaPolicy({ runId, current: resolvedQuota, universe: { kind, root }');
  expect(pod).toContain('launchQuotaPolicy = described.quotaPolicy');
  expect(pod).not.toContain('the line is advice; the launch goes on');
  expect(pod).toContain('ui.info(described.line); if (described.warning) ui.warn(described.warning)');
  expect(source).toContain('JSON.stringify(withLaunchQuotaPolicy(results, launchQuotaPolicy))');
  expect(withLaunchQuotaPolicy([{ taskId: 'local', status: 'done' }], undefined)).toEqual([{ taskId: 'local', status: 'done' }]);
});

test.each([
  { kind: 'prod' as const, current: { policy: 'credits' as const, source: 'config' as const }, root: '/operator', warning: undefined },
  { kind: 'test' as const, current: { policy: 'fallback' as const, source: 'default' as const }, root: '/isolated',
    production: { policy: 'credits' as const, source: 'config' as const },
    warning: '⚠️ 이 시험 우주의 한도 정책(fallback)이 운영(credits)과 다르다 — 운영과 같게 하려면: bun bin/elanous.mjs config sync-test' },
])('pod launch policy %s records its ledger, JSON result, observation and unchanged human line', async (sample) => {
  const state = mkdtempSync(join(tmpdir(), 'launch-quota-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  const runId = `run-${crypto.randomUUID()}`;
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  process.env.ELANOUS_STATE_DIR = state;
  try {
    const announced = await announceLaunchQuotaPolicy({ runId, current: sample.current,
      universe: { kind: sample.kind, root: sample.root }, ...('production' in sample ? { production: sample.production } : {}) });
    expect(announced.line).toBe(`[pod] codex 한도 정책 = ${sample.current.policy}(${sample.kind === 'prod' ? '크레딧까지' : '한도 안 ⊕ 자동 폴백'}) · 출처 ${sample.current.source} · 우주 ${sample.kind} ${sample.root}`);
    expect(announced.warning).toBe(sample.warning);
    const data = { policy: sample.current.policy, source: sample.current.source,
      universe: { kind: sample.kind, root: sample.root }, ...(sample.warning ? { warning: sample.warning } : {}) };
    const ledger = readFileSync(join(state, 'run-ledger', `${runId}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ runId, event: 'launch-quota-policy', data });
    expect(log).toHaveBeenCalledWith('pod.quota-policy', 'announced', data);
    const original = { taskId: 'task-a', feature: 'keep', status: 'done', stage: 'merged' };
    const json = JSON.parse(JSON.stringify(withLaunchQuotaPolicy([original], announced.quotaPolicy)));
    expect(json).toEqual([{ ...original, quotaPolicy: { policy: sample.current.policy, source: sample.current.source, universeKind: sample.kind } }]);
    expect(original).toEqual({ taskId: 'task-a', feature: 'keep', status: 'done', stage: 'merged' });
  } finally {
    log.mockRestore();
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(state, { recursive: true, force: true });
  }
});

test('a failed ledger write rejects the launch before an announced policy or successful JSON exists', async () => {
  const state = mkdtempSync(join(tmpdir(), 'launch-quota-failure-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  process.env.ELANOUS_STATE_DIR = state;
  writeFileSync(join(state, 'run-ledger'), 'not a directory');
  const input = { runId: `run-${crypto.randomUUID()}`, current: { policy: 'credits' as const, source: 'config' as const },
    universe: { kind: 'test' as const, root: state } };
  let successfulJson: string | undefined;
  try {
    try {
      const announced = await announceLaunchQuotaPolicy(input);
      successfulJson = JSON.stringify(withLaunchQuotaPolicy([{ status: 'done' }], announced.quotaPolicy));
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('pod launch quota policy ledger write failed:');
    }
    expect(successfulJson).toBeUndefined();
    expect(log).toHaveBeenCalledWith('pod.quota-policy', 'ledger-unavailable',
      expect.objectContaining({ runId: input.runId }), { level: 'warn' });
    expect(log).not.toHaveBeenCalledWith('pod.quota-policy', 'announced', expect.anything());
  } finally {
    log.mockRestore();
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(state, { recursive: true, force: true });
  }
});
