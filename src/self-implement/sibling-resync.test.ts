import { describe, expect, test } from 'bun:test';
import type { ControlMemoPayload } from '../harness/control-inbox.js';
import {
  SIBLING_RESYNC_CATEGORY,
  SIBLING_RESYNC_MARKER_LABEL,
  overlappingFiles,
  requestSiblingResync,
  type SiblingResyncAdapters,
  type SiblingResyncPr,
  type SiblingRunTarget,
} from './sibling-resync.js';

function harness(opts: {
  merged?: readonly string[] | undefined;
  open: readonly SiblingResyncPr[];
  runs?: Record<number, SiblingRunTarget>;
  sendThrows?: boolean;
}) {
  const sent: { spaceId: string; runId: string; memo: ControlMemoPayload }[] = [];
  const markers: { number: number; label: string }[] = [];
  const logs: { category: string; event: string; data: Record<string, unknown> }[] = [];
  const adapters: SiblingResyncAdapters = {
    mergedFiles: async () => ('merged' in opts ? opts.merged : ['src/f.ts']),
    listOpenPrs: async () => opts.open.map(({ files: _files, ...candidate }) => candidate),
    prFiles: async (number) => opts.open.find((candidate) => candidate.number === number)?.files,
    resolveRun: async (pr) => opts.runs?.[pr.number] ?? { alive: false, reason: 'owner-run-unknown' },
    sendResync: (target, memo) => {
      if (opts.sendThrows) throw new Error('inbox unwritable');
      sent.push({ ...target, memo });
    },
    addMarker: (number, label) => { markers.push({ number, label }); },
  };
  const log = (category: string, event: string, data: Record<string, unknown>) => { logs.push({ category, event, data }); };
  return { adapters, sent, markers, logs, log };
}

const pr = (number: number, files: readonly string[] | undefined, extra: Partial<SiblingResyncPr> = {}): SiblingResyncPr =>
  ({ number, branch: `self-impl/goal-${number}`, labels: [], files, ...extra });

describe('requestSiblingResync', () => {
  test('merged PR touching F → open sibling touching F with a live run gets exactly one resync request', async () => {
    const h = harness({
      open: [pr(2, ['src/f.ts', 'src/g.ts'])],
      runs: { 2: { alive: true, runId: 'run-2', spaceId: 'space-2' } },
    });
    const result = await requestSiblingResync({ merged: { number: 1 }, adapters: h.adapters, log: h.log });
    expect(result.requested).toEqual([2]);
    expect(result.marked).toEqual([]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ spaceId: 'space-2', runId: 'run-2', memo: { version: 1, kind: 'sibling-resync', urgency: 'normal' } });
    expect(h.sent[0]!.memo.body).toContain('#1');
    expect(h.sent[0]!.memo.body).toContain('src/f.ts');
    expect(h.sent[0]!.memo.body).not.toContain('\n');
    expect(h.markers).toEqual([]);
    expect(h.logs.find((l) => l.event === 'requested')).toMatchObject({ category: SIBLING_RESYNC_CATEGORY, data: { merged: 1, sibling: 2, overlap: ['src/f.ts'] } });
  });

  test('sibling not touching F → no request and no marker', async () => {
    const h = harness({
      open: [pr(3, ['src/other.ts'])],
      runs: { 3: { alive: true, runId: 'run-3', spaceId: 'space-3' } },
    });
    const result = await requestSiblingResync({ merged: { number: 1 }, adapters: h.adapters, log: h.log });
    expect(result).toMatchObject({ requested: [], marked: [] });
    expect(h.sent).toEqual([]);
    expect(h.markers).toEqual([]);
  });

  test('dead run → quiet label marker only, never a memo', async () => {
    const h = harness({
      open: [pr(4, ['src/f.ts'])],
      runs: { 4: { alive: false, runId: 'run-4', reason: 'run-ended-unclosed' } },
    });
    const result = await requestSiblingResync({ merged: { number: 1 }, adapters: h.adapters, log: h.log });
    expect(result.marked).toEqual([4]);
    expect(result.requested).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.markers).toEqual([{ number: 4, label: SIBLING_RESYNC_MARKER_LABEL }]);
  });

  test('marker already present → prefiltered before any file fetch, not re-applied', async () => {
    const h = harness({ open: [pr(5, ['src/f.ts'], { labels: [SIBLING_RESYNC_MARKER_LABEL] })] });
    const result = await requestSiblingResync({ merged: { number: 1 }, adapters: h.adapters, log: h.log });
    expect(result).toMatchObject({ marked: [], skippedPrefilter: [5], filesFetched: 0 });
    expect(h.markers).toEqual([]);
  });

  test('file fetches run with bounded concurrency', async () => {
    const open = Array.from({ length: 20 }, (_, i) => pr(200 + i, ['src/other.ts']));
    const h = harness({ open });
    let inFlight = 0;
    let peak = 0;
    const adapters: SiblingResyncAdapters = {
      ...h.adapters,
      prFiles: async () => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return ['src/other.ts'];
      },
    };
    const result = await requestSiblingResync({ merged: { number: 1 }, adapters, fetchConcurrency: 6, log: h.log });
    expect(result.filesFetched).toBe(20);
    expect(peak).toBe(6);
  });

  test('live run whose inbox cannot be written falls back to the marker', async () => {
    const h = harness({
      open: [pr(6, ['src/f.ts'])],
      runs: { 6: { alive: true, runId: 'run-6', spaceId: 'space-6' } },
      sendThrows: true,
    });
    const result = await requestSiblingResync({ merged: { number: 1 }, adapters: h.adapters, log: h.log });
    expect(result).toMatchObject({ requested: [], marked: [6] });
    expect(h.logs.some((l) => l.event === 'send-failed')).toBe(true);
  });

  test('non-harness branches, the merged PR itself and unknown file lists are never siblings', async () => {
    const h = harness({
      open: [pr(1, ['src/f.ts']), pr(7, ['src/f.ts'], { branch: 'feature/human' }), pr(8, undefined)],
    });
    const result = await requestSiblingResync({ merged: { number: 1 }, adapters: h.adapters, log: h.log });
    expect(result).toMatchObject({ requested: [], marked: [] });
    expect(h.markers).toEqual([]);
  });

  test('unknown merged files sends nothing', async () => {
    const h = harness({ merged: undefined, open: [pr(9, ['src/f.ts'])] });
    const result = await requestSiblingResync({ merged: { number: 1 }, adapters: h.adapters, log: h.log });
    expect(result.reason).toBe('merged-files-unknown');
    expect(h.markers).toEqual([]);
  });

  test('bounded: at most cap siblings per merge, the rest are reported as skipped', async () => {
    const open = Array.from({ length: 12 }, (_, i) => pr(100 + i, ['src/f.ts']));
    const h = harness({ open });
    const result = await requestSiblingResync({ merged: { number: 1 }, adapters: h.adapters, log: h.log });
    expect(result.marked).toHaveLength(10);
    expect(result.skippedOverCap).toEqual([110, 111]);
    const small = harness({ open });
    expect((await requestSiblingResync({ merged: { number: 1 }, adapters: small.adapters, cap: 2, log: small.log })).marked).toEqual([100, 101]);
  });
});

test('overlappingFiles is an exact, de-duplicated intersection', () => {
  expect(overlappingFiles(['a', 'b'], ['b', 'b', 'c'])).toEqual(['b']);
  expect(overlappingFiles(['a'], undefined)).toEqual([]);
});
