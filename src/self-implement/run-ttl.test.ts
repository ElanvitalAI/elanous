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

  test('shadow does not call requestRegate and records exactly one would-regate', async () => {
    const f = fake([
      { number: 20, createdHoursAgo: 72, commitHoursAgo: 48 },
      { number: 21, createdHoursAgo: 80, commitHoursAgo: 60 },
    ]);
    const requested: number[] = [];
    const { log, events } = quiet();
    const out = await runRunTtlSweep({
      adapters: f.adapters, now: () => NOW, log,
      requestRegate: (pr) => { requested.push(pr.number); },
    });
    expect(out.mode).toBe('shadow');
    expect(requested).toEqual([]);
    expect(out.regate).toHaveLength(1);
    expect([...out.label].sort()).toEqual([20, 21]);
    expect(f.labels).toEqual([]);
    expect(events.filter((event) => event.event === 'would-regate')).toHaveLength(1);
    expect(events.some((event) => event.event === 'regate-requested')).toBe(false);
  });

  test('a follow-up sweep still skips already-marked PRs before fetch, even with a re-gate adapter', async () => {
    // First live sweep: both stale, dead-run PRs get the label; only the stalest is re-gated.
    const first = fake([
      { number: 40, createdHoursAgo: 72, commitHoursAgo: 48 },
      { number: 41, createdHoursAgo: 80, commitHoursAgo: 60 },
    ]);
    const requestedFirst: number[] = [];
    await runRunTtlSweep({
      adapters: first.adapters, mode: 'live', now: () => NOW, log: quiet().log,
      requestRegate: (pr) => { requestedFirst.push(pr.number); },
    });
    expect(first.labels.map(([n]) => n).sort()).toEqual([40, 41]);
    expect(requestedFirst).toHaveLength(1);
    // Follow-up sweep: both PRs now carry the marker and still have no live run — the marker's
    // «once» holds regardless of the adapter: skipped before any fetch (no maxFetch spend), never
    // re-gated, never re-labelled. A per-PR re-gate history is a separate piece, not this one.
    const second = fake([
      { number: 40, createdHoursAgo: 72, commitHoursAgo: 48, labels: [RUN_TTL_MARKER_LABEL] },
      { number: 41, createdHoursAgo: 80, commitHoursAgo: 60, labels: [RUN_TTL_MARKER_LABEL] },
    ]);
    const requestedSecond: number[] = [];
    const out = await runRunTtlSweep({
      adapters: second.adapters, mode: 'live', now: () => NOW, log: quiet().log,
      requestRegate: (pr) => { requestedSecond.push(pr.number); },
    });
    expect(requestedSecond).toEqual([]);
    expect(out.regate).toEqual([]);
    expect(out.label).toEqual([]);
    expect(second.labels).toEqual([]);
    expect(second.commitCalls).toEqual([]);
    expect(out.alreadyMarked).toEqual([40, 41]);
  });

  test('live calls requestRegate on exactly one of two stale PRs', async () => {
    const f = fake([
      { number: 30, createdHoursAgo: 72, commitHoursAgo: 48 },
      { number: 31, createdHoursAgo: 80, commitHoursAgo: 60 },
    ]);
    const requested: number[] = [];
    const { log, events } = quiet();
    const out = await runRunTtlSweep({
      adapters: f.adapters, mode: 'live', now: () => NOW, log,
      requestRegate: (pr) => { requested.push(pr.number); },
    });
    expect(requested).toHaveLength(1);
    expect(out.regate).toEqual(requested);
    expect([...out.stale].sort()).toEqual([30, 31]);
    expect([...out.label].sort()).toEqual([30, 31]);
    expect(f.labels).toHaveLength(2);
    expect(events.filter((event) => event.event === 'regate-requested')).toHaveLength(1);
    expect(events.some((event) => event.event === 'would-regate')).toBe(false);
  });

  describe('one action budget shared by memo, marker and re-gate', () => {
    // Two isolated stale candidates with no live run; #51 is the staler one, so it is picked first.
    const two = () => fake([
      { number: 50, createdHoursAgo: 72, commitHoursAgo: 48 },
      { number: 51, createdHoursAgo: 80, commitHoursAgo: 60 },
    ]);

    test('shadow, cap 1 → one would-regate, no requestRegate call, no marker', async () => {
      const f = two();
      const requested: number[] = [];
      const { log, events } = quiet();
      const out = await runRunTtlSweep({
        adapters: f.adapters, cap: 1, now: () => NOW, log,
        requestRegate: (pr) => { requested.push(pr.number); },
      });
      expect(requested).toEqual([]);
      expect(out.regate).toEqual([51]);
      expect(out.label).toEqual([]);
      expect(f.labels).toEqual([]);
      expect(events.filter((event) => event.event === 'would-regate')).toHaveLength(1);
      expect(events.some((event) => event.event === 'would-label')).toBe(false);
    });

    test('live, cap 1 → exactly one re-gate request, no marker action at all', async () => {
      const f = two();
      const requested: number[] = [];
      const { log, events } = quiet();
      const out = await runRunTtlSweep({
        adapters: f.adapters, mode: 'live', cap: 1, now: () => NOW, log,
        requestRegate: (pr) => { requested.push(pr.number); },
      });
      expect(requested).toEqual([51]);
      expect(out.regate).toEqual([51]);
      expect(out.label).toEqual([]);
      expect(f.labels).toEqual([]);
      expect(out.skippedOverCap).toEqual([50]);
      expect(events.filter((event) => event.event === 'regate-requested')).toHaveLength(1);
      // The sweep record still carries the existing summary shape, now with the re-gate number.
      const summary = events.find((event) => event.event === 'summary')!;
      expect(summary.data).toMatchObject({ mode: 'live', memo: 0, label: 0, regate: 1, regatePrs: [51] });
    });

    test('live, cap 1, no re-gate adapter → the marker keeps the only budget slot', async () => {
      const f = two();
      const out = await runRunTtlSweep({ adapters: f.adapters, mode: 'live', cap: 1, now: () => NOW, log: quiet().log });
      expect(out.regate).toEqual([]);
      expect(out.label).toEqual([51]);
      expect(f.labels).toEqual([[51, RUN_TTL_MARKER_LABEL]]);
      expect(out.skippedOverCap).toEqual([50]);
    });

    test('live, cap 2 → one re-gate plus one marker, never more than the cap', async () => {
      const f = two();
      const requested: number[] = [];
      const out = await runRunTtlSweep({
        adapters: f.adapters, mode: 'live', cap: 2, now: () => NOW, log: quiet().log,
        requestRegate: (pr) => { requested.push(pr.number); },
      });
      expect(requested).toEqual([51]);
      expect(out.regate).toEqual([51]);
      expect(out.label).toEqual([51]);
      expect(f.labels).toEqual([[51, RUN_TTL_MARKER_LABEL]]);
      expect(out.skippedOverCap).toEqual([50]);
      expect(requested.length + out.label.length + out.memo.length).toBe(2);
    });

    test('a memo spends the slot too — a dead-run PR in the same cap-1 sweep gets nothing', async () => {
      const f = fake([
        { number: 60, createdHoursAgo: 90, commitHoursAgo: 60, alive: true },
        { number: 61, createdHoursAgo: 72, commitHoursAgo: 40 },
      ]);
      const requested: number[] = [];
      const out = await runRunTtlSweep({
        adapters: f.adapters, mode: 'live', cap: 1, now: () => NOW, log: quiet().log,
        requestRegate: (pr) => { requested.push(pr.number); },
      });
      expect(out.memo).toEqual([60]);
      expect(out.label).toEqual([]);
      expect(requested).toEqual([]);
      expect(f.labels).toEqual([]);
      expect(out.skippedOverCap).toEqual([61]);
    });
  });
});
