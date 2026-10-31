import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { DecisionEntry } from '../decisions/decision-ledger.js';
import type { Checklist, ChecklistHistory } from '../release-loop/checklist.js';
import { buildLinearDailyProgressSummaries, syncLinearDailyProgress } from './linear-daily-progress.js';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(): { checklist: Checklist; history: (id: string) => ChecklistHistory[]; decisions: DecisionEntry[] } {
  const checklist: Checklist = { version: '0.2.43', released: '0.2.42', dev: '0.2.42-dev.0', history: [], items: [
    { id: 'CELL-A', title: '진행 변경 ELA-53', status: 'green', owner: 'OPT', evidence: 'PR #42', updatedAt: NOW.toISOString(), updatedBy: 'OPT' },
    { id: 'CELL-B', title: '후속 작업', status: 'yellow', owner: 'OPT', evidence: 'ELA-53 · private mechanism must not appear', updatedAt: NOW.toISOString(), updatedBy: 'OPT' },
  ] };
  const events: Record<string, ChecklistHistory[]> = {
    'CELL-A': [
      { at: '2026-10-30T02:00:00.000Z', by: 'OPT', id: 'CELL-A', field: 'status', from: 'yellow', to: 'green', released: '0.2.42', dev: '0.2.42-dev.0' },
      { at: '2026-10-30T03:00:00.000Z', by: 'OPT', id: 'CELL-A', field: 'evidence', from: null, to: 'merged PR #42', released: '0.2.42', dev: '0.2.42-dev.0' },
    ],
    'CELL-B': [],
  };
  const decision: DecisionEntry = {
    id: 'D-20261030-1', title: 'ELA-53 공개 진행 요약 범위', category: 'scope',
    scqa: { s: 'source', c: 'context' }, options: [], recommendation: { skipped: true, reason: 'not part of public summary' },
    raisedBy: { agent: 'OPT' }, refs: ['ELA-53'], status: 'open', pendingQuestion: 'private credential and internal mechanism',
    history: [{ type: 'raised', at: '2026-10-30T04:00:00.000Z', by: 'OPT' }],
  };
  return { checklist, history: id => events[id] ?? [], decisions: [decision] };
}

describe('Linear daily progress summaries', () => {
  test('groups by ELA reference, uses latest status, includes landed PR and public-safe decision titles', () => {
    const input = fixture();
    input.history = id => id === 'CELL-A' ? [
      { at: '2026-10-30T02:00:00.000Z', by: 'OPT', id, field: 'status', from: 'yellow', to: 'green', released: '0.2.42', dev: '0.2.42-dev.0' },
      { at: '2026-10-30T02:30:00.000Z', by: 'OPT', id, field: 'status', from: 'green', to: 'done', released: '0.2.42', dev: '0.2.42-dev.0' },
      { at: '2026-10-30T03:00:00.000Z', by: 'OPT', id, field: 'evidence', from: null, to: 'merged PR #42', released: '0.2.42', dev: '0.2.42-dev.0' },
    ] : [];
    const summaries = buildLinearDailyProgressSummaries({ ...input, now: NOW });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ identifier: 'ELA-53', day: '2026-10-30' });
    expect(summaries[0]!.body).toContain('green → done');
    expect(summaries[0]!.body).toContain('착지 PR: PR #42');
    expect(summaries[0]!.body).toContain('ELA-53 공개 진행 요약 범위 · open');
    expect(summaries[0]!.body).toContain('CELL-B: 후속 작업');
    expect(summaries[0]!.body).not.toContain('private mechanism');
    expect(summaries[0]!.body).not.toContain('private credential');
  });

  test('keeps move-only events distinct from evidence updates and excludes history outside the UTC day', () => {
    const input = fixture();
    input.history = id => id === 'CELL-A' ? [
      { at: '2026-10-29T23:59:59.000Z', by: 'OPT', id, field: 'status', from: 'yellow', to: 'green', released: '0.2.42', dev: '0.2.42-dev.0' },
      { at: '2026-10-30T04:00:00.000Z', by: 'OPT', id, field: 'move', from: '0.2.42', to: '0.2.43', released: '0.2.42', dev: '0.2.42-dev.0' },
    ] : [];
    const body = buildLinearDailyProgressSummaries({ ...input, now: NOW })[0]!.body;
    expect(body).toContain('칸 이동');
    expect(body).not.toContain('근거 갱신');
    expect(body).not.toContain('착지 PR');
  });

  test('previews without a key or network request', async () => {
    const input = fixture();
    let networkCalls = 0;
    const result = await syncLinearDailyProgress({ ...input, now: NOW, dryRun: true,
      getSecret: async () => { throw new Error('must not read key'); }, fetch: (async () => { networkCalls++; throw new Error('must not fetch'); }) as unknown as typeof fetch });
    expect(result).toMatchObject({ dryRun: true, posted: 0, skipped: 0, failed: 0 });
    expect(result.plan).toHaveLength(1);
    expect(result.plan[0]!.body).toContain('ELA-53');
    expect(networkCalls).toBe(0);
  });

  test('posts once and recognizes the per-day marker on retry', async () => {
    const input = fixture();
    const stateDir = mkdtempSync(join(tmpdir(), 'linear-daily-progress-'));
    roots.push(stateDir);
    let postedBody = '';
    let mutations = 0;
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      if (payload.query.includes('DailyProgressIssue')) return Response.json({ data: { issue: { id: 'linear-uuid', comments: {
        nodes: postedBody ? [{ body: postedBody }] : [], pageInfo: { hasNextPage: false, endCursor: null },
      } } } });
      if (payload.query.includes('DecisionComment')) {
        mutations++;
        postedBody = String((payload.variables.input as { body: string }).body);
        return Response.json({ data: { commentCreate: { success: true, comment: { id: 'comment-1' } } } });
      }
      throw new Error('unexpected request');
    }) as typeof globalThis.fetch;
    const deps = { ...input, now: NOW, apiKey: 'fake-key', fetch, stateDir, dryRun: false };
    expect(await syncLinearDailyProgress(deps)).toMatchObject({ posted: 1, skipped: 0, failed: 0 });
    expect(await syncLinearDailyProgress(deps)).toMatchObject({ posted: 0, skipped: 1, failed: 0 });
    expect(mutations).toBe(1);
    expect(postedBody).toContain('<!-- elanous-daily-progress:2026-10-30 -->');
  });

  test('rejects a missing or repeated comment cursor and releases the lock after failure', async () => {
    for (const endCursor of [null, 'cursor-1'] as const) {
      const input = fixture();
      const stateDir = mkdtempSync(join(tmpdir(), 'linear-daily-progress-cursor-'));
      roots.push(stateDir);
      let calls = 0;
      const fetch = (async () => {
        calls++;
        return Response.json({ data: { issue: { id: 'linear-uuid', comments: { nodes: [],
          pageInfo: { hasNextPage: true, endCursor } } } } });
      }) as unknown as typeof globalThis.fetch;
      const result = await syncLinearDailyProgress({ ...input, now: NOW, apiKey: 'fake-key', fetch, stateDir, dryRun: false });
      expect(result).toMatchObject({ posted: 0, skipped: 0, failed: 1 });
      expect(calls).toBe(endCursor ? 2 : 1);
      expect(existsSync(join(stateDir, 'linear-daily-progress', 'send.lock'))).toBe(false);
    }
  });

  test('records a bounded HTTP failure reason and releases the lock', async () => {
    const input = fixture();
    const stateDir = mkdtempSync(join(tmpdir(), 'linear-daily-progress-failure-'));
    roots.push(stateDir);
    const logRows: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const fetch = (async () => new Response('private body must not be logged', { status: 503 })) as unknown as typeof globalThis.fetch;
    const result = await syncLinearDailyProgress({ ...input, now: NOW, apiKey: 'fake-key', fetch, stateDir, dryRun: false,
      log: (_category, event, fields) => logRows.push({ event, fields: fields as Record<string, unknown> }) });
    expect(result).toMatchObject({ posted: 0, skipped: 0, failed: 1 });
    expect(logRows).toEqual([{ event: 'failed', fields: expect.objectContaining({ reason: 'linear-http-503' }) }]);
    expect(JSON.stringify(logRows)).not.toContain('private body');
    expect(existsSync(join(stateDir, 'linear-daily-progress', 'send.lock'))).toBe(false);
  });
});
