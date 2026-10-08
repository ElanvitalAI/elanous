import { describe, expect, test } from 'bun:test';
import type { ControlMemoPayload } from '../harness/control-inbox.js';
import { RUN_TTL_CATEGORY, RUN_TTL_MARKER_LABEL, runRunTtlSweep, type RunTtlAdapters, type RunTtlCandidate } from './run-ttl.js';
import type { SiblingRunTarget } from './sibling-resync.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

interface FakePr { number: number; createdHoursAgo: number; commitHoursAgo?: number; alive?: boolean; labels?: string[]; branch?: string }

function fake(prs: FakePr[], options: { sent?: Set<string>; failSend?: boolean } = {}) {
  const memos: Array<{ runId: string; spaceId: string; memo: ControlMemoPayload }> = [];
  const labels: Array<[number, string]> = [];
  const commitCalls: number[] = [];
  const sent = options.sent ?? new Set<string>();
  let inFlight = 0;
  let maxInFlight = 0;
  const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const adapters: RunTtlAdapters = {
    listOpenPrs: async () => prs.map((pr): RunTtlCandidate => ({
      number: pr.number, branch: pr.branch ?? `self-impl/goal-${pr.number}`, labels: pr.labels ?? [],
      createdAt: hoursAgo(pr.createdHoursAgo), headSha: `sha${pr.number}`,
    })),
    lastCommitAt: async (pr) => {
      commitCalls.push(pr.number);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      const hours = byNumber.get(pr.number)!.commitHoursAgo;
      return hours === undefined ? undefined : hoursAgo(hours);
    },
    resolveRun: async (pr): Promise<SiblingRunTarget> => byNumber.get(pr.number)!.alive
      ? { alive: true, runId: `run-${pr.number}`, spaceId: `space-${pr.number}` }
      : { alive: false, reason: 'owner-run-unknown' },
    sendMemo: (target, memo) => {
      if (options.failSend) throw new Error('inbox down');
      memos.push({ ...target, memo });
    },
    addLabel: (number, label) => { labels.push([number, label]); },
    memoSent: (key) => sent.has(key),
    recordMemoSent: (key) => { sent.add(key); },
  };
  return { adapters, memos, labels, commitCalls, sent, maxInFlight: () => maxInFlight };
}

const quiet = () => {
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  return { events, log: (category: string, event: string, data: Record<string, unknown>) => { events.push({ category, event, data }); } };
};

describe('RUN-TTL sweep step', () => {
  test('old PR + alive run → one resync memo (live), once per head sha', async () => {
    const f = fake([{ number: 1, createdHoursAgo: 72, commitHoursAgo: 48, alive: true }]);
    const { log, events } = quiet();
    const out = await runRunTtlSweep({ adapters: f.adapters, mode: 'live', now: () => NOW, log });
    expect(out.memo).toEqual([1]);
    expect(out.label).toEqual([]);
    expect(f.memos).toHaveLength(1);
    expect(f.memos[0]).toMatchObject({ runId: 'run-1', spaceId: 'space-1', memo: { kind: 'run-ttl-resync', urgency: 'normal' } });
    expect(f.memos[0]!.memo.body).toContain('rebase this branch onto origin/main');
    expect(f.labels).toEqual([]);
    const summary = events.find((event) => event.event === 'summary')!;
    expect(summary.category).toBe(RUN_TTL_CATEGORY);
    expect(summary.data).toMatchObject({ mode: 'live', memo: 1, label: 0, stale: 1 });
    const again = await runRunTtlSweep({ adapters: f.adapters, mode: 'live', now: () => NOW, log });
    expect(again.memo).toEqual([]);
    expect(again.alreadyMemoed).toEqual([1]);
    expect(f.memos).toHaveLength(1);
  });

  test('old PR + dead run → needs-rebase label once, never re-fetched after', async () => {
    const f = fake([{ number: 2, createdHoursAgo: 72, commitHoursAgo: 30 }]);
    const out = await runRunTtlSweep({ adapters: f.adapters, mode: 'live', now: () => NOW, log: quiet().log });
    expect(out.label).toEqual([2]);
    expect(f.labels).toEqual([[2, RUN_TTL_MARKER_LABEL]]);
    expect(f.memos).toEqual([]);
    const marked = fake([{ number: 2, createdHoursAgo: 72, commitHoursAgo: 30, labels: [RUN_TTL_MARKER_LABEL] }]);
    const second = await runRunTtlSweep({ adapters: marked.adapters, mode: 'live', now: () => NOW, log: quiet().log });
    expect(second.alreadyMarked).toEqual([2]);
    expect(second.label).toEqual([]);
    expect(marked.labels).toEqual([]);
    expect(marked.commitCalls).toEqual([]);
  });

  test('fresh PRs → nothing (created inside TTL is never fetched; recent commit is fresh)', async () => {
    const f = fake([
      { number: 3, createdHoursAgo: 2, commitHoursAgo: 1, alive: true },
      { number: 4, createdHoursAgo: 72, commitHoursAgo: 3 },
      { number: 5, createdHoursAgo: 72, commitHoursAgo: 48, branch: 'feature/human' },
      { number: 6, createdHoursAgo: 72, commitHoursAgo: 48, labels: ['elanous:keep'] },
      { number: 7, createdHoursAgo: 72 },
    ]);
    const out = await runRunTtlSweep({ adapters: f.adapters, mode: 'live', now: () => NOW, log: quiet().log });
    expect(out).toMatchObject({ considered: 3, freshByCreation: 1, fresh: 1, unknown: [7], stale: [], memo: [], label: [] });
    expect(f.commitCalls.sort()).toEqual([4, 7]);
    expect(f.memos).toEqual([]);
    expect(f.labels).toEqual([]);
  });

  test('shadow (default) → reports what it would do and writes nothing', async () => {
    const f = fake([
      { number: 8, createdHoursAgo: 72, commitHoursAgo: 48, alive: true },
      { number: 9, createdHoursAgo: 72, commitHoursAgo: 48 },
    ]);
    const { log, events } = quiet();
    const out = await runRunTtlSweep({ adapters: f.adapters, now: () => NOW, log });
    expect(out.mode).toBe('shadow');
    expect(out.memo).toEqual([8]);
    expect(out.label).toEqual([9]);
    expect(f.memos).toEqual([]);
    expect(f.labels).toEqual([]);
    expect(f.sent.size).toBe(0);
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(['would-memo', 'would-label', 'summary']));
  });

  test('cap respected (oldest commit first) and fetches stay bounded', async () => {
    const prs = Array.from({ length: 12 }, (_, index) => ({ number: 100 + index, createdHoursAgo: 200, commitHoursAgo: 30 + index }));
    const f = fake(prs);
    const out = await runRunTtlSweep({ adapters: f.adapters, mode: 'live', cap: 3, maxFetch: 10, concurrency: 2, now: () => NOW, log: quiet().log });
    expect(out.label).toEqual([109, 108, 107]);
    expect(f.labels).toHaveLength(3);
    expect(out.skippedOverCap).toHaveLength(7);
    expect(out.skippedFetchCap).toEqual([110, 111]);
    expect(out.fetched).toBe(10);
    expect(f.maxInFlight()).toBeLessThanOrEqual(2);
  });

  test('memo delivery failure falls back to the quiet marker', async () => {
    const f = fake([{ number: 10, createdHoursAgo: 72, commitHoursAgo: 48, alive: true }], { failSend: true });
    const out = await runRunTtlSweep({ adapters: f.adapters, mode: 'live', now: () => NOW, log: quiet().log });
    expect(out.memo).toEqual([]);
    expect(out.label).toEqual([10]);
    expect(f.labels).toEqual([[10, RUN_TTL_MARKER_LABEL]]);
  });

  test('a failed run lookup is not a dead run — no label, no memo, no fetch', async () => {
    const f = fake([{ number: 11, createdHoursAgo: 72, commitHoursAgo: 48 }]);
    const out = await runRunTtlSweep({ adapters: { ...f.adapters, resolveRun: async () => { throw new Error('ledger unreadable'); } },
      mode: 'live', now: () => NOW, log: quiet().log });
    expect(out.unresolved).toEqual([11]);
    expect(out.label).toEqual([]);
    expect(f.labels).toEqual([]);
    expect(f.commitCalls).toEqual([]);
  });

  test('memo journal failure (write or read) sends nothing, so «once» holds', async () => {
    const write = fake([{ number: 12, createdHoursAgo: 72, commitHoursAgo: 48, alive: true }]);
    const out = await runRunTtlSweep({ adapters: { ...write.adapters, recordMemoSent: () => { throw new Error('EROFS'); } },
      mode: 'live', now: () => NOW, log: quiet().log });
    expect(out.failed).toEqual([12]);
    expect(out.memo).toEqual([]);
    expect(write.memos).toEqual([]);
    expect(write.labels).toEqual([]);
    const read = fake([{ number: 13, createdHoursAgo: 72, commitHoursAgo: 48, alive: true }]);
    const second = await runRunTtlSweep({ adapters: { ...read.adapters, memoSent: () => { throw new Error('EACCES'); } },
      mode: 'live', now: () => NOW, log: quiet().log });
    expect(second.failed).toEqual([13]);
    expect(read.memos).toEqual([]);
  });

  test('inventory failure is reported, not mistaken for an empty repository', async () => {
    const f = fake([]);
    const out = await runRunTtlSweep({ adapters: { ...f.adapters, listOpenPrs: async () => { throw new Error('gh down'); } }, now: () => NOW, log: quiet().log });
    expect(out.reason).toBe('inventory-failed');
  });
});
