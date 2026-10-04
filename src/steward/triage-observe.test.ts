import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { runStewardStage } from './triage.js';

test('one steward loop tick closes each stage with graph run, outcome, source and resolved mode; existing decisions remain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-ticks-'));
  const context = join(root, 'context.json');
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  const records: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const off = debug.registerSink({ name: 'steward-tick-stage-test', emit: record => {
    if (record.category === 'loop.steward' || record.category === 'steward.triage' || record.category === 'steward.schedule') {
      records.push({ category: record.category, event: record.event, data: record.data as Record<string, unknown> });
    }
  } });
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    if (query.includes('commentCreate(')) return Response.json({ data: { commentCreate: { success: true } } });
    return Response.json({ data: { issues: { nodes: [{ id: 'ref-1', identifier: 'ELA-1', title: 'Build', description: '', url: '', priority: 1,
      updatedAt: '2026-10-04T00:00:00Z', state: { type: 'started' } }], pageInfo: { hasNextPage: false, endCursor: null } } } });
  }) as typeof fetch;
  try {
    writeFileSync(context, JSON.stringify({ graphId: 'steward', runId: 'steward-graph-1' }));
    process.env.ELANOUS_GRAPH_CONTEXT = context;
    const deps = { root, fetch: fetchFn, getSecret: async () => 'key', launchSettings: { mode: 'shadow' as const },
      judge: async () => ({ rung: 0, dependsOn: [], priority: 1, why: 'wait' }), decide: () => true,
      sendDigest: async () => {}, now: () => new Date('2026-10-04T00:00:00Z') };
    for (const stage of ['sync', 'triage', 'schedule', 'report'] as const) await runStewardStage(stage, deps);
    const ticks = records.filter(record => record.category === 'loop.steward');
    expect(ticks.map(record => record.event)).toEqual(['tick', 'tick', 'tick', 'tick']);
    expect(ticks.map(record => record.data.stage)).toEqual(['sync', 'triage', 'schedule', 'report']);
    for (const tick of ticks) expect(tick.data).toMatchObject({ loopId: 'steward', runId: 'steward-graph-1', outcome: 'ok',
      reason: 'ok', profile: 'shadow', sourceRef: 'graphs/steward/steward.yaml', missingRequired: [] });
    expect(records.filter(record => record.category === 'steward.triage' && record.event === 'decision')).toHaveLength(1);
    expect(records.filter(record => record.category === 'steward.schedule' && record.event === 'decision')).toHaveLength(1);
  } finally {
    off();
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed stage has one failed tick, while an off stage does not execute or emit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-tick-fail-'));
  const records: Array<{ event: string; data: Record<string, unknown> }> = [];
  const off = debug.registerSink({ name: 'steward-tick-failure-test', emit: record => {
    if (record.category === 'loop.steward') records.push({ event: record.event, data: record.data as Record<string, unknown> });
  } });
  try {
    await expect(runStewardStage('triage', { root, getSecret: async () => undefined,
      launchSettings: { mode: 'live' } })).rejects.toThrow('connector.linear.apiKey missing');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: 'tick', data: { stage: 'triage', outcome: 'fail', reason: 'fail',
      profile: 'live', sourceRef: 'graphs/steward/steward.yaml', missingRequired: [], runId: expect.any(String) } });
    await runStewardStage('sync', { root, launchSettings: { mode: 'off' } });
    expect(records).toHaveLength(1);
  } finally { off(); rmSync(root, { recursive: true, force: true }); }
});
