import { describe, expect, it, spyOn } from 'bun:test';
import { CLAIM_IDLE_HOURS, PR_LABELS, STALLED_DRAFT_HOURS } from '../github/pr-labels.js';
import { DRAFT_SWEEP_CLOSE_CAP, draftSweepDaily, runDraftSweep, supersedeDraftsOnMerge, sweepFailureReason, type DraftSweepAdapters, type SweepDraft, type SweepMergedPr, type SweepReviewGate } from './draft-sweep.js';
import { RELEASE_PATH_LABEL } from './release-path-guard.js';
import { debug } from '../debug/log.js';

const state = (name: string) => PR_LABELS.find((entry) => entry.axis === 'state' && entry.name.endsWith(name))!.name;
const running = state('running');
const stalled = state('stalled');
const superseded = state('superseded');
const approval = state('idea-approval');
const keep = PR_LABELS.find((entry) => entry.sweep.action === 'exclude')!.name;
const now = new Date('2026-09-30T00:00:00Z');
const draft = (number: number, options: Partial<SweepDraft> = {}): SweepDraft => ({
  number, title: `Goal ${number}`, branch: `self-impl/goalid-${number.toString(16)}-run`,
  labels: [running], createdAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z', runId: `run-${number}`, ...options,
});
const make = (drafts: SweepDraft[], merged: SweepMergedPr[] = []) => {
  const calls: string[] = [];
  const statuses = new Map<number, string | undefined>(drafts.map((pr) => [pr.number, 'ended-unclosed']));
  let live: ReadonlySet<string> | undefined = new Set();
  const adapters: DraftSweepAdapters = {
    listDrafts: async (page, size) => { calls.push(`drafts:${page}`); return drafts.slice((page - 1) * size, page * size); },
    listMerged: async (page, size) => { calls.push(`merged:${page}`); return merged.slice((page - 1) * size, page * size); },
    getRunStatus: async (pr) => statuses.get(pr.number),
    listLiveBranches: async () => live,
    setLabels: async (_repo, n, change) => { calls.push(`label:${n}:${change.remove.join(',')}=>${change.add}`); },
    closeDraft: async (_repo, n, comment) => { calls.push(`close:${n}:${comment}`); },
  };
  return { calls, statuses, adapters, setLive: (value: ReadonlySet<string> | undefined) => { live = value; } };
};
const sweep = (adapters: DraftSweepAdapters, apply = false) => runDraftSweep({ repository: 'owner/repo', adapters, apply, now });

describe('supersedeDraftsOnMerge', () => {
  const merged = { number: 90, title: '「하니스로 구현」 DRAFT-TRIAGE', branch: 'self-impl/draft-triage-goalid-1-new',
    createdAt: '2026-09-30T00:00:00Z', mergedAt: '2026-10-01T00:00:00Z' };

  it('closes only an older same-goal draft, protecting release, keep, approval, live and other goals', async () => {
    const rows = [
      draft(1, { title: merged.title, labels: [stalled] }),
      draft(2, { title: merged.title, labels: [stalled, RELEASE_PATH_LABEL] }),
      draft(3, { title: 'another goal', labels: [stalled] }),
      draft(4, { title: merged.title, labels: [keep] }),
      draft(5, { title: merged.title, labels: [approval] }),
      draft(6, { title: merged.title, labels: [stalled] }),
      draft(9, { title: merged.title, labels: [stalled], createdAt: '2026-10-02T00:00:00Z' }),
    ];
    const fixture = make(rows);
    fixture.setLive(new Set([rows[5]!.branch]));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters });
      expect(result).toEqual({ closed: [1], kept: [2, 3, 4, 5, 6, 9] });
      expect(fixture.calls.filter((call) => call.startsWith('label:') || call.startsWith('close:'))).toEqual([
        `label:1:${stalled}=>${superseded}`, 'close:1:Draft sweep: superseded-by #90 (https://github.com/owner/repo/pull/90). Branch preserved.',
      ]);
      expect(log).toHaveBeenCalledWith('drafts.cleanup', 'superseded-on-merge', { merged: 90, closed: [1], kept: [2, 3, 4, 5, 6, 9] });
    } finally { log.mockRestore(); }
  });

  it('records a failed close as kept without hiding later successful closes', async () => {
    const fixture = make([draft(1, { title: merged.title, labels: [stalled] }), draft(2, { title: merged.title, labels: [stalled], branch: 'self-impl/second-goalid-1-run' })]);
    fixture.adapters.closeDraft = async (_repo, number) => {
      if (number === 1) throw new Error('close unavailable');
      fixture.calls.push(`close:${number}`);
    };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters }))
        .toEqual({ closed: [2], kept: [1] });
      expect(log).toHaveBeenCalledWith('drafts.cleanup', 'superseded-on-merge', {
        merged: 90, closed: [2], kept: [1], failed: [1], error: 'Error: close unavailable',
      });
    } finally { log.mockRestore(); }
  });

  it('keeps a draft open when the superseded label write fails, so an open-draft sweep can retry', async () => {
    const row = draft(1, { title: merged.title, labels: [stalled] });
    const fixture = make([row]);
    const github: { open: boolean; labels: string[] } = { open: true, labels: [stalled] };
    let failLabels = true;
    fixture.adapters.listDrafts = async () => github.open ? [{ ...row, labels: [...github.labels] }] : [];
    fixture.adapters.setLabels = async (_repo, number, change) => {
      if (failLabels) throw new Error('label unavailable');
      github.labels = [...github.labels.filter((label) => !change.remove.includes(label)), change.add];
      fixture.calls.push(`label:${number}`);
    };
    fixture.adapters.closeDraft = async (_repo, number) => {
      github.open = false;
      fixture.calls.push(`close:${number}`);
    };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters }))
        .toEqual({ closed: [], kept: [1] });
      expect(github).toEqual({ open: true, labels: [stalled] });
      expect(fixture.calls.filter((call) => call.startsWith('close:'))).toEqual([]);
      expect(log).toHaveBeenCalledWith('drafts.cleanup', 'superseded-on-merge', {
        merged: 90, closed: [], kept: [1], failed: [1], error: 'Error: label unavailable',
      });
      failLabels = false;
      expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters }))
        .toEqual({ closed: [1], kept: [] });
      expect(github).toEqual({ open: false, labels: [superseded] });
    } finally { log.mockRestore(); }
  });

  it('leaves an open draft labelled superseded for the next sweep when closing fails', async () => {
    const fixture = make([draft(1, { title: merged.title, labels: [stalled] })]);
    const github = new Map<number, { open: boolean; labels: string[] }>([[1, { open: true, labels: [stalled] }]]);
    fixture.adapters.setLabels = async (_repo, number, change) => {
      const pr = github.get(number)!;
      pr.labels = [...pr.labels.filter((label) => !change.remove.includes(label)), change.add];
      fixture.calls.push(`label:${number}`);
    };
    fixture.adapters.closeDraft = async () => { throw new Error('close unavailable'); };
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters }))
      .toEqual({ closed: [], kept: [1] });
    expect(github.get(1)).toEqual({ open: true, labels: [superseded] });
    expect(fixture.calls.filter((call) => call.startsWith('label:'))).toEqual(['label:1']);

    // Review must-fix (GOODHART): the claimed retry is the periodic sweep itself — clear the fault and run the real
    // runDraftSweep against the same GitHub state; the draft must end closed and still labelled superseded.
    const row = draft(1, { title: merged.title, labels: [stalled] });
    fixture.adapters.listDrafts = async (page, size) => {
      const pr = github.get(1)!;
      return (pr.open ? [{ ...row, labels: [...pr.labels] }] : []).slice((page - 1) * size, page * size);
    };
    fixture.adapters.listMerged = async (page, size) => [merged].slice((page - 1) * size, page * size);
    fixture.adapters.closeDraft = async (_repo, number) => {
      github.get(number)!.open = false;
      fixture.calls.push(`close:${number}`);
    };
    const swept = await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, apply: true,
      now: new Date('2026-10-02T00:00:00Z') });
    expect(swept.complete).toBe(true);
    expect(swept.entries.find((entry) => entry.number === 1)?.action).toBe('close');
    expect(github.get(1)).toEqual({ open: false, labels: [superseded] });
    expect(fixture.calls.filter((call) => call.startsWith('close:'))).toEqual(['close:1']);
  });

  it('reuses the merged-twin branch lineage when titles differ', async () => {
    const fixture = make([draft(7, { title: 'old title', labels: [stalled], branch: 'self-impl/another-goalid-1-old' })]);
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters }))
      .toEqual({ closed: [7], kept: [] });
  });

  it('closes earlier open harness drafts matched by goal id, slot id or branch prefix, linking the merged PR', async () => {
    const landed = { ...merged, title: 'new title', body: '칸: TC-17',
      branch: 'self-impl/shared-aaaaaaaa-r9' };
    const rows = [
      draft(21, { title: 'old goal', branch: 'self-impl/other-goalid-deadbeef-old', labels: [stalled] }),
      draft(22, { title: 'old slot', branch: 'self-impl/slot-only', body: '칸: TC-17', labels: [stalled],
        changedFiles: ['src/a.ts'] }),
      draft(23, { title: 'old branch', branch: 'self-impl/shared-bbbbbbbb-r2', labels: [stalled],
        changedFiles: ['src/a.ts'] }),
      draft(24, { title: 'different', branch: 'self-impl/shared-cccccccc-r1', body: '칸: TC-18', labels: [stalled],
        changedFiles: ['src/a.ts'] }),
      draft(25, { title: 'new title', branch: 'external/shared-dddddddd-r1', body: '칸: TC-17', labels: [stalled] }),
      draft(26, { title: 'different', branch: 'self-impl/shared-goalid-beef-eeeeeeee-r1', body: '칸: TC-17',
        labels: [stalled], changedFiles: ['src/b.ts'] }),
    ];
    const fixture = make(rows);
    fixture.adapters.getPrFiles = async () => ['src/a.ts'];
    fixture.adapters.getLatestFileChanges = async () => ({ 'src/a.ts': '2026-09-29T12:00:00Z' });
    const goalLanded = { ...landed, branch: 'self-impl/new-goalid-deadbeef-run' };
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged: goalLanded, adapters: fixture.adapters }))
      .toEqual({ closed: [21, 22], kept: [23, 24, 25, 26] });
    fixture.calls.length = 0;
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged: landed, adapters: fixture.adapters }))
      .toEqual({ closed: [22, 23], kept: [21, 24, 25, 26] });
    expect(fixture.calls.filter((call) => call.startsWith('label:') || call.startsWith('close:'))).toEqual([
      `label:22:${stalled}=>${superseded}`,
      'close:22:Draft sweep: superseded-by #90 (https://github.com/owner/repo/pull/90). Branch preserved.',
      `label:23:${stalled}=>${superseded}`,
      'close:23:Draft sweep: superseded-by #90 (https://github.com/owner/repo/pull/90). Branch preserved.',
    ]);
  });

  it('closes a same-goal draft opened after the merged PR but before its landing', async () => {
    const fixture = make([draft(8, { title: merged.title, labels: [stalled], branch: 'self-impl/newer-goalid-1-run', createdAt: '2026-09-30T12:00:00Z' })]);
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters }))
      .toEqual({ closed: [8], kept: [] });
  });

  it('reuses the all-files-landed same-slot path only with verified latest changes', async () => {
    const old = draft(11, { title: 'old slot', branch: 'self-impl/old', labels: [stalled],
      body: '칸: UX 10-04', changedFiles: ['docs/goal.md'] });
    const landed = { ...merged, title: 'new slot', branch: 'self-impl/new', body: '칸: UX 10-04' };
    const fixture = make([old]);
    fixture.adapters.getPrFiles = async () => ['docs/goal.md'];
    fixture.adapters.getLatestFileChanges = async () => ({ 'docs/goal.md': '2026-09-29T00:00:00Z' });
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged: landed, adapters: fixture.adapters }))
      .toEqual({ closed: [11], kept: [] });
    fixture.calls.length = 0;
    fixture.adapters.getLatestFileChanges = async () => undefined;
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged: landed, adapters: fixture.adapters }))
      .toEqual({ closed: [], kept: [11] });
    expect(fixture.calls.some((call) => call.startsWith('close:'))).toBe(false);
  });

  it('fails closed on a failed draft listing or missing liveness and respects the close cap', async () => {
    const rows = Array.from({ length: DRAFT_SWEEP_CLOSE_CAP + 2 }, (_, i) => draft(i + 10, { title: merged.title, labels: [stalled],
      branch: `self-impl/attempt-${i}-goalid-1-run` }));
    const fixture = make(rows);
    fixture.adapters.listDrafts = async () => { throw new Error('GitHub unavailable'); };
    expect((await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters })).closed).toEqual([]);
    fixture.adapters.listDrafts = async (page, size) => rows.slice((page - 1) * size, page * size);
    fixture.setLive(undefined);
    expect((await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters })).closed).toEqual([]);
    fixture.setLive(new Set());
    fixture.adapters.getPrFiles = async () => { throw new Error('file inventory failed'); };
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters }))
      .toEqual({ closed: [], kept: rows.map((row) => row.number) });
    fixture.adapters.getPrFiles = undefined;
    fixture.adapters.getRunStatus = async () => { throw new Error('run lookup failed'); };
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters }))
      .toEqual({ closed: [], kept: rows.map((row) => row.number) });
    fixture.adapters.getRunStatus = async () => undefined;
    const result = await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters });
    expect(result.closed).toHaveLength(DRAFT_SWEEP_CLOSE_CAP);
    expect(result.kept).toHaveLength(2);
    const failures = make(rows);
    failures.adapters.closeDraft = async () => { throw new Error('close unavailable'); };
    const failedResult = await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: failures.adapters });
    expect(failedResult.closed).toEqual([]);
    expect(failures.calls.filter((call) => call.startsWith('label:'))).toHaveLength(DRAFT_SWEEP_CLOSE_CAP);
    expect(failedResult.kept).toHaveLength(rows.length);
  });
});

describe('runDraftSweep', () => {
  it('reuses paged open drafts to supersede an older matching attempt and logs the existing reason', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => draft(i + 100, { labels: [stalled], createdAt: '2026-09-29T23:00:00Z' }));
    const older = draft(1, { labels: [stalled], title: 'T', branch: 'self-impl/x-aaaaaaaa-r1', createdAt: '2026-09-29T22:00:00Z' });
    const newer = draft(2, { labels: [stalled], title: 'T', branch: 'self-impl/x-bbbbbbbb-r2', createdAt: '2026-09-29T23:00:00Z' });
    const fixture = make([older, ...rows, newer]);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = await sweep(fixture.adapters, true);
      expect(result.entries[0]).toMatchObject({ number: 1, action: 'close', reason: 'duplicate-of-open #2', statusLabel: superseded, applied: true });
      expect(result.entries.at(-1)).toMatchObject({ number: 2, action: 'keep', reason: 'recent' });
      expect(fixture.calls).toContain('drafts:2');
      expect(fixture.calls.filter((call) => call.startsWith('drafts:'))).toEqual(['drafts:1', 'drafts:2']);
      expect(fixture.calls.filter((call) => call.startsWith('label:') || call.startsWith('close:'))).toEqual([
        `label:1:${stalled}=>${superseded}`, 'close:1:Draft sweep: duplicate-of-open #2. Branch preserved.',
      ]);
      expect(log).toHaveBeenCalledWith('drafts.cleanup', 'decided', { number: 1, action: 'close', reason: 'duplicate-of-open #2' });
    } finally { log.mockRestore(); }
  });

  it('allows a newer open attempt to supersede a fresh running claim without an update timestamp', async () => {
    const older = draft(1, { title: 'T', branch: 'self-impl/x-aaaaaaaa-r1', createdAt: '2026-09-29T22:00:00Z', updatedAt: undefined });
    const newer = draft(2, { labels: [stalled], title: 'T', branch: 'self-impl/x-bbbbbbbb-r2', createdAt: '2026-09-29T23:00:00Z' });
    const fixture = make([older, newer]);
    const result = await sweep(fixture.adapters, true);
    expect(result.entries[0]).toMatchObject({ action: 'close', reason: 'duplicate-of-open #2', statusLabel: superseded, applied: true });
    expect(fixture.calls.filter((call) => call.startsWith('label:') || call.startsWith('close:'))).toEqual([
      `label:1:${running}=>${superseded}`, 'close:1:Draft sweep: duplicate-of-open #2. Branch preserved.',
    ]);
  });

  it('paginates both drafts and merged PRs and recognizes a twin on a later page', async () => {
    const drafts = Array.from({ length: 101 }, (_, i) => draft(i + 1, { labels: [stalled], createdAt: '2026-09-29T23:00:00Z' }));
    const merged = Array.from({ length: 100 }, (_, i) => ({ number: i + 500, title: `unrelated ${i}`, branch: `elsewhere/${i}` }));
    merged.push({ number: 900, title: drafts[100]!.title, branch: `self-impl/last-goalid-${(101).toString(16)}-new` });
    const fixture = make(drafts, merged);
    const result = await sweep(fixture.adapters);
    expect(result.complete).toBe(true);
    expect(result.entries).toHaveLength(101);
    expect(result.entries.at(-1)).toMatchObject({ number: 101, action: 'close', reason: 'superseded-by #900', statusLabel: superseded });
    expect(fixture.calls).toContain('drafts:2');
    expect(fixture.calls).toContain('merged:2');
    expect(fixture.calls.some((call) => call.startsWith('close:'))).toBe(false);
  });

  it('protects live runs and branches before considering merged twins or aging', async () => {
    const one = draft(1);
    const fixture = make([one, draft(2)], [{ number: 77, title: one.title, branch: 'elsewhere' }]);
    fixture.statuses.set(1, 'running');
    fixture.setLive(new Set([draft(2).branch]));
    fixture.adapters.hasFinalRunResult = async () => false;
    const result = await sweep(fixture.adapters, true);
    expect(result.entries.map((entry) => [entry.action, entry.reason])).toEqual([
      ['keep', 'claim-expired-but-live'], ['keep', 'claim-expired-but-live'],
    ]);
    expect(fixture.calls.some((call) => call.startsWith('close:') || call.startsWith('label:'))).toBe(false);
  });

  it('cards the three DRAFT3 close reasons and keeps protected drafts', async () => {
    const first = draft(1, { labels: [stalled], createdAt: '2026-09-29T23:00:00Z' });
    const second = draft(2, { labels: [stalled], createdAt: '2026-09-29T23:00:00Z', body: '칸: UX 10-03', changedFiles: ['a.ts', 'b.ts'] });
    const third = draft(3, { labels: [stalled] });
    const protectedDraft = draft(4, { labels: [keep], createdAt: '2026-09-29T23:00:00Z' });
    const fixture = make([first, second, third, protectedDraft], [
      { number: 9, title: 'Other title', branch: 'other', body: 'Implemented (수확 #1) and (수확 #4)' },
      { number: 10, title: 'Another title', branch: 'elsewhere', body: '칸: UX 10-03',
        mergedAt: '2026-09-30T01:00:00Z', changedFiles: ['a.ts', 'b.ts'] },
    ]);
    fixture.setLive(new Set([third.branch]));
    fixture.adapters.getLatestFileChanges = async (pr) => pr.number === 2 ? {
      'a.ts': '2026-09-29T23:30:00Z', 'b.ts': '2026-09-29T23:30:00Z',
    } : undefined;
    fixture.adapters.hasFinalRunResult = async (pr) => pr.number === 3;
    const result = await sweep(fixture.adapters);
    expect(result.entries.map(({ action, reason, statusLabel }) => [action, reason, statusLabel])).toEqual([
      ['close', 'superseded-by #9 (harvest #1)', superseded],
      ['close', 'superseded-by #10 (all-files-landed)', superseded],
      ['close', 'stale-ended-run (self-implement.result final; worktree is not live)', stalled],
      ['keep', `label:${keep}`, undefined],
    ]);
  });

  it('keeps branch finality unknown when an adapter omits the final-result lookup', async () => {
    const pr = draft(15, { labels: [stalled] });
    const fixture = make([pr]);
    fixture.setLive(new Set([pr.branch]));
    const result = await sweep(fixture.adapters, true);
    expect(result.entries[0]).toEqual({ number: 15, action: 'keep', reason: 'branch-finality-unobserved', applied: false });
    expect(fixture.calls.some((call) => call.startsWith('close:') || call.startsWith('label:'))).toBe(false);
    fixture.adapters.hasFinalRunResult = async () => false;
    expect((await sweep(fixture.adapters)).entries[0]).toMatchObject({ action: 'keep', reason: 'live' });
  });

  it('retains a merged replacement for an unknown-finality branch without claiming it is live', async () => {
    const pr = draft(16, { labels: [stalled] });
    const fixture = make([pr], [{ number: 116, title: pr.title, branch: 'merged/16' }]);
    fixture.setLive(new Set([pr.branch]));
    expect((await sweep(fixture.adapters, true)).entries[0]).toMatchObject({
      action: 'keep', reason: 'branch-finality-unobserved', applied: false,
    });
    expect(fixture.calls.some((call) => call.startsWith('close:') || call.startsWith('label:'))).toBe(false);
  });

  it('keeps an active rerun of a previously final draft even if the old run has a final result', async () => {
    const rerun = draft(13, { createdAt: '2026-09-28T00:00:00Z' });
    const fixture = make([rerun]);
    fixture.setLive(new Set([rerun.branch]));
    fixture.adapters.getRunStatus = async () => 'running';
    fixture.adapters.hasFinalRunResult = async () => true;
    expect((await sweep(fixture.adapters, true)).entries[0]).toMatchObject({
      action: 'keep', reason: 'claim-expired-but-live',
    });
    expect(fixture.calls.some((call) => call.startsWith('close:') || call.startsWith('label:'))).toBe(false);
  });

  it('does not let a retained branch override an observed final result when a claim expires', async () => {
    const stale = draft(12, { createdAt: '2026-09-28T00:00:00Z' });
    const fixture = make([stale]);
    fixture.setLive(new Set([stale.branch]));
    fixture.adapters.hasFinalRunResult = async () => true;
    expect((await sweep(fixture.adapters)).entries[0]).toMatchObject({
      action: 'close', reason: 'claim-expired (self-implement.result final; worktree is not live)', statusLabel: stalled,
    });
  });

  it('recognizes merged goal lineage when titles differ, including recent ended drafts', async () => {
    const fixture = make([draft(10, { createdAt: '2026-09-29T23:00:00Z' })], [
      { number: 99, title: 'Other title', branch: 'self-impl/other-goalid-a-new' },
    ]);
    expect((await sweep(fixture.adapters)).entries[0]).toMatchObject({ action: 'close', reason: 'superseded-by #99' });
  });

  it('periodic live sweep links the merged PR when it supersedes an earlier draft', async () => {
    const fixture = make([draft(1, { title: 'old', labels: [stalled], body: '칸: TC-17',
      createdAt: '2026-09-29T23:00:00Z', changedFiles: ['src/a.ts'] })], [
      { number: 90, title: 'new', branch: 'other', body: '칸: TC-17',
        mergedAt: '2026-09-30T00:00:00Z', changedFiles: ['src/a.ts'] },
    ]);
    fixture.adapters.getLatestFileChanges = async () => ({ 'src/a.ts': '2026-09-29T23:30:00Z' });
    const result = await sweep(fixture.adapters, true);
    expect(result.entries[0]).toMatchObject({ action: 'close', reason: 'superseded-by #90 (all-files-landed)',
      statusLabel: superseded, applied: true });
    expect(fixture.calls.filter((call) => call.startsWith('label:') || call.startsWith('close:'))).toEqual([
      `label:1:${stalled}=>${superseded}`,
      'close:1:Draft sweep: superseded-by #90 (all-files-landed) (https://github.com/owner/repo/pull/90). Branch preserved.',
    ]);
  });

  it('transitions exactly one state label before closing, leaving origin and branch untouched', async () => {
    const origin = PR_LABELS.find((entry) => entry.axis === 'origin')!.name;
    const fixture = make([draft(1, { labels: [running, origin] }), draft(2, { labels: [stalled] })], [
      { number: 10, title: 'Goal 2', branch: 'self-impl/other-goalid-2-new' },
    ]);
    const result = await sweep(fixture.adapters, true);
    expect(result.entries).toEqual([
      { number: 1, action: 'close', reason: 'claim-expired', statusLabel: stalled, applied: true },
      { number: 2, action: 'close', reason: 'superseded-by #10', statusLabel: superseded, applied: true },
    ]);
    expect(fixture.calls.filter((call) => call.startsWith('label:') || call.startsWith('close:'))).toEqual([
      `label:1:${running}=>${stalled}`, expect.stringContaining('close:1:Draft sweep: 처리 중 표식이 6시간 갱신 없음'),
      `label:2:${stalled}=>${superseded}`, 'close:2:Draft sweep: superseded-by #10 (https://github.com/owner/repo/pull/10). Branch preserved.',
    ]);
  });

  it('observes the aging boundary and only marks a recent ended run stalled without closing it', async () => {
    const fixture = make([draft(1, { labels: [stalled], createdAt: new Date(now.getTime() - STALLED_DRAFT_HOURS * 3_600_000).toISOString() }),
      draft(2, { labels: [], createdAt: new Date(now.getTime() - (STALLED_DRAFT_HOURS - 1) * 3_600_000).toISOString() })]);
    const result = await sweep(fixture.adapters, true);
    expect(result.entries.map((entry) => [entry.action, entry.statusLabel])).toEqual([['close', stalled], ['keep', stalled]]);
    expect(fixture.calls.filter((call) => call.startsWith('close:'))).toHaveLength(1);
  });

  it('reports contradictory draft approval and multiple state labels; preserves human holds and other branches', async () => {
    const fixture = make([draft(1, { labels: [approval] }), draft(2, { labels: [running, stalled] }),
      draft(3, { labels: [keep, stalled] }), draft(4, { labels: [], branch: 'external/manual' })]);
    const result = await sweep(fixture.adapters, true);
    expect(result.entries.map(({ action, reason }) => [action, reason])).toEqual([
      ['report', 'approval-label-on-draft'], ['report', 'conflicting-state-labels'], ['keep', `label:${keep}`], ['keep', 'outside-harness'],
    ]);
    expect(fixture.calls.some((call) => call.startsWith('label:') || call.startsWith('close:'))).toBe(false);
  });

  it('does not assign a target or mutate labels for reported drafts even with an ended run in apply mode', async () => {
    const fixture = make([draft(1, { labels: [running, stalled] }), draft(2, { labels: [approval] })]);
    const result = await sweep(fixture.adapters, true);
    expect(result.entries).toEqual([
      { number: 1, action: 'report', reason: 'conflicting-state-labels', applied: false },
      { number: 2, action: 'report', reason: 'approval-label-on-draft', applied: false },
    ]);
    expect(fixture.calls.filter((call) => call.startsWith('label:') || call.startsWith('close:'))).toEqual([]);
    expect(result.counts).toEqual({ 'conflicting-state-labels': 1, 'approval-label-on-draft': 1 });
  });

  it('reports partial application when labels succeed but closing fails', async () => {
    const fixture = make([draft(1, { labels: [] }), draft(2, { labels: [stalled] })]);
    fixture.adapters.closeDraft = async (_repo, number) => { throw new Error(`close denied #${number}`); };
    const result = await sweep(fixture.adapters, true);
    expect(result.entries).toEqual([
      { number: 1, action: 'close', reason: 'stale-ended-run', statusLabel: stalled,
        applied: false, partialApplied: true, error: 'Error: close denied #1' },
      { number: 2, action: 'close', reason: 'stale-ended-run', statusLabel: stalled,
        applied: false, error: 'Error: close denied #2' },
    ]);
    expect(fixture.calls.filter((call) => call.startsWith('label:'))).toEqual([`label:1:=>${stalled}`]);
  });

  it('fails closed on incomplete pages, missing liveness or run assessments, and failed mutation', async () => {
    // Recently updated: an unobserved run is kept unless idle 24h (the idle rule has its own tests).
    const fixture = make([draft(1, { updatedAt: '2026-09-29T23:00:00Z' })]);
    fixture.adapters.listMerged = async () => { throw new Error('page 2 unavailable'); };
    expect((await sweep(fixture.adapters, true)).complete).toBe(false);
    expect(fixture.calls.some((call) => call.startsWith('close:'))).toBe(false);
    fixture.adapters.listMerged = async () => [];
    fixture.setLive(undefined);
    expect((await sweep(fixture.adapters, true)).complete).toBe(false);
    fixture.setLive(new Set());
    fixture.statuses.set(1, undefined);
    expect((await sweep(fixture.adapters, true)).entries[0]).toMatchObject({ action: 'keep' });
    fixture.adapters.getRunStatus = async () => { throw new Error('run lookup denied'); };
    const unavailable = await sweep(fixture.adapters, true);
    expect(unavailable).toMatchObject({ complete: false, entries: [], counts: {}, error: 'run lookup denied' });
    fixture.adapters.getRunStatus = async (pr) => fixture.statuses.get(pr.number);
    fixture.statuses.set(1, 'ended-unclosed');
    // Check the pre-existing failed-mutation path on a non-claim draft.
    fixture.adapters.listDrafts = async () => [draft(1, { labels: [] })];
    fixture.adapters.setLabels = async () => { throw new Error('label denied'); };
    const result = await sweep(fixture.adapters, true);
    expect(result.entries[0]).toEqual({
      number: 1, action: 'close', reason: 'stale-ended-run', statusLabel: stalled,
      applied: false, error: 'Error: label denied',
    });
    expect(fixture.calls.some((call) => call.startsWith('close:'))).toBe(false);
  });
});

describe('runDraftSweep — unobserved runs (🅢 lead decision 2026-09-28)', () => {
  const idle = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

  it('closes an unobserved draft only when no live branch holds it and last update is at least 24h old', async () => {
    const fixture = make([
      draft(1, { labels: [stalled], updatedAt: idle(50) }),
      draft(2, { labels: [stalled], updatedAt: idle(10), createdAt: idle(60) }),
      draft(3, { labels: [stalled], updatedAt: idle(50) }),
    ]);
    for (const n of [1, 2, 3]) fixture.statuses.set(n, undefined);
    fixture.setLive(new Set([draft(3).branch]));
    fixture.adapters.hasFinalRunResult = async () => false;
    const result = await sweep(fixture.adapters, true);
    expect(result.entries.map((entry) => [entry.number, entry.action, entry.reason])).toEqual([
      [1, 'close', 'stale-unobserved'], [2, 'keep', 'unobserved'], [3, 'keep', 'live'],
    ]);
    expect(result.entries[0]!.statusLabel).toBe(stalled);
    expect(fixture.calls.find((call) => call.startsWith('close:1:'))).toContain('run unobserved');
    expect(fixture.calls.some((call) => call.startsWith('close:2') || call.startsWith('close:3'))).toBe(false);
    expect(result).toMatchObject({ unobserved: 2, closed: 1 });
  });

  it('keeps a 2h running claim, closes a 7h unobserved claim with owner, and keeps a 7h live branch and a 100h human hold', async () => {
    const fixture = make([
      draft(11, { updatedAt: idle(2) }),
      draft(12, { updatedAt: idle(7) }),
      draft(13, { updatedAt: idle(7) }),
      draft(14, { labels: [running, keep], updatedAt: idle(100) }),
    ]);
    for (const n of [11, 12, 13, 14]) fixture.statuses.set(n, undefined);
    fixture.setLive(new Set([draft(13).branch]));
    fixture.adapters.hasFinalRunResult = async () => false;
    fixture.adapters.getClaimOwner = async () => 'T';
    const result = await sweep(fixture.adapters, true);
    expect(CLAIM_IDLE_HOURS).toBe(6);
    expect(result.entries.map(({ action, reason }) => [action, reason])).toEqual([
      ['keep', 'label:running(<6h)'], ['close', 'claim-expired'],
      ['keep', 'claim-expired-but-live'], ['keep', `label:${keep}`],
    ]);
    expect(result).toMatchObject({ claimed: 1, claimExpired: 2, closed: 1 });
    expect(fixture.calls.filter((call) => call.startsWith('label:') || call.startsWith('close:'))).toEqual([
      `label:12:${running}=>${stalled}`,
      expect.stringContaining('close:12:Draft sweep: 처리 중 표식이 6시간 갱신 없음 — 런·워크트리 없음 · 주인 T'),
    ]);
    expect(fixture.calls.find((call) => call.startsWith('close:12:'))).toContain('Branch preserved');
  });

  it('closes already merged running drafts as superseded regardless of claim age, but retains live and human holds', async () => {
    const twins = [draft(41, { updatedAt: idle(2) }), draft(42, { updatedAt: idle(7) }),
      draft(43, { updatedAt: idle(2) }), draft(44, { labels: [running, keep], updatedAt: idle(7) }),
      draft(45, { updatedAt: idle(7) })];
    const fixture = make(twins, twins.map((pr) => ({ number: pr.number + 100, title: pr.title, branch: `self-impl/merged-goalid-${pr.number.toString(16)}-new` })));
    for (const pr of twins) fixture.statuses.set(pr.number, undefined);
    fixture.statuses.set(43, 'running');
    fixture.setLive(new Set([twins[4]!.branch]));
    fixture.adapters.hasFinalRunResult = async () => false;
    const result = await sweep(fixture.adapters, true);
    expect(result.entries.map(({ action, reason, statusLabel }) => [action, reason, statusLabel])).toEqual([
      ['close', 'superseded-by #141', superseded], ['close', 'superseded-by #142', superseded],
      ['keep', 'label:running(<6h)', undefined], ['keep', `label:${keep}`, undefined],
      ['keep', 'claim-expired-but-live', undefined],
    ]);
    expect(result).toMatchObject({ claimed: 1, claimExpired: 1, closed: 2 });
    expect(fixture.calls.filter((call) => call.startsWith('label:') || call.startsWith('close:'))).toEqual([
      `label:41:${running}=>${superseded}`, 'close:41:Draft sweep: superseded-by #141 (https://github.com/owner/repo/pull/141). Branch preserved.',
      `label:42:${running}=>${superseded}`, 'close:42:Draft sweep: superseded-by #142 (https://github.com/owner/repo/pull/142). Branch preserved.',
    ]);
  });

  it('uses the six-hour boundary and keeps missing or malformed claim timestamps from authorizing a close', async () => {
    const fixture = make([
      draft(31, { updatedAt: idle(6) }),
      draft(32, { updatedAt: 'not-a-time' }),
      draft(33, { updatedAt: idle(5.99) }),
    ]);
    for (const n of [31, 32, 33]) fixture.statuses.set(n, undefined);
    const result = await sweep(fixture.adapters, true);
    expect(result.entries.map(({ action, reason }) => [action, reason])).toEqual([
      ['close', 'claim-expired'], ['keep', 'claim-update-unobserved'], ['keep', 'label:running(<6h)'],
    ]);
    expect(fixture.calls.filter((call) => call.startsWith('close:'))).toHaveLength(1);
  });

  it('classifies unobserved same-goal and same-title twins before stale drafts and records decisions and counts', async () => {
    const rows = [
      draft(61, { labels: [stalled], updatedAt: idle(3), branch: 'self-impl/one-goalid-aabb-run' }),
      draft(62, { labels: [stalled], updatedAt: idle(3) }),
      draft(63, { labels: [stalled], updatedAt: idle(25) }),
      draft(64, { labels: [stalled], updatedAt: idle(3) }),
      draft(65, { labels: [keep], updatedAt: idle(25) }),
      draft(66, { labels: [stalled], updatedAt: idle(25) }),
    ];
    const fixture = make(rows, [
      { number: 161, title: 'different', branch: 'self-impl/two-goalid-aabb-run' },
      { number: 162, title: rows[1]!.title, branch: `self-impl/title-goalid-${(62).toString(16)}-new` },
      { number: 165, title: rows[4]!.title, branch: `self-impl/held-goalid-${(65).toString(16)}-new` },
      { number: 166, title: rows[5]!.title, branch: `self-impl/live-goalid-${(66).toString(16)}-new` },
    ]);
    for (const row of rows) fixture.statuses.set(row.number, undefined);
    fixture.setLive(new Set([rows[5]!.branch]));
    fixture.adapters.hasFinalRunResult = async () => false;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = await sweep(fixture.adapters);
      expect(result.entries.map(({ action, reason }) => [action, reason])).toEqual([
        ['close', 'superseded-by #161'], ['close', 'superseded-by #162'],
        ['close', 'stale-unobserved'], ['keep', 'unobserved'], ['keep', `label:${keep}`], ['keep', 'live'],
      ]);
      expect(result.counts).toEqual({ 'superseded-by #161': 1, 'superseded-by #162': 1,
        'stale-unobserved': 1, unobserved: 1, [`label:${keep}`]: 1, live: 1 });
      expect(log.mock.calls.filter(([category, event]) => category === 'drafts.cleanup' && event === 'decided')
        .map(([, , data]) => data)).toEqual(result.entries.map(({ number, action, reason }) => ({ number, action, reason })));
      expect(log).toHaveBeenCalledWith('drafts.cleanup', 'summary', result.counts);
      expect(fixture.calls.some((call) => call.startsWith('label:') || call.startsWith('close:'))).toBe(false);
    } finally { log.mockRestore(); }
  });

  it('closes a 25h unobserved non-claim draft only in apply mode via injected adapters', async () => {
    const fixture = make([draft(67, { labels: [stalled], updatedAt: idle(25) })]);
    fixture.statuses.set(67, undefined);
    const shadow = await sweep(fixture.adapters);
    expect(shadow.entries[0]).toMatchObject({ action: 'close', reason: 'stale-unobserved', applied: false });
    expect(fixture.calls.some((call) => call.startsWith('close:'))).toBe(false);
    const live = await sweep(fixture.adapters, true);
    expect(live.entries[0]).toMatchObject({ action: 'close', reason: 'stale-unobserved', applied: true });
    expect(fixture.calls.filter((call) => call.startsWith('close:'))).toHaveLength(1);
  });

  it('preserves a missing last-update timestamp despite an old creation time', async () => {
    const fixture = make([draft(68, { labels: [stalled], createdAt: idle(100), updatedAt: undefined })]);
    fixture.statuses.set(68, undefined);
    const result = await sweep(fixture.adapters, true);
    expect(result.entries[0]).toMatchObject({ action: 'keep', reason: 'unobserved', applied: false });
    expect(fixture.calls.some((call) => call.startsWith('close:'))).toBe(false);
  });

  it('closes a running draft without updatedAt as superseded when a merged twin exists (superseded outranks the unobserved claim)', async () => {
    const pr = draft(36, { updatedAt: undefined, createdAt: idle(100) });
    const fixture = make([pr], [{ number: 136, title: pr.title, branch: `self-impl/m-goalid-${(36).toString(16)}-new` }]);
    fixture.statuses.set(36, undefined);
    const result = await sweep(fixture.adapters, true);
    expect(result.entries.map(({ action, reason }) => [action, reason])).toEqual([['close', 'superseded-by #136']]);
    expect(fixture.calls.filter((call) => call.startsWith('close:'))).toEqual(['close:36:Draft sweep: superseded-by #136 (https://github.com/owner/repo/pull/136). Branch preserved.']);
  });

  it('keeps an old running draft with updatedAt undefined and no observable run untouched in apply mode', async () => {
    const fixture = make([draft(35, { updatedAt: undefined, createdAt: idle(100) })]);
    fixture.statuses.set(35, undefined);
    const result = await sweep(fixture.adapters, true);
    expect(result.entries).toEqual([{ number: 35, action: 'keep', reason: 'claim-update-unobserved', applied: false }]);
    expect(result.closed).toBe(0);
    expect(fixture.calls.filter((call) => call.startsWith('label:') || call.startsWith('close:'))).toEqual([]);
  });

  it('does not close an expired claim if owner lookup fails before any write', async () => {
    const fixture = make([draft(34, { updatedAt: idle(7) })]);
    fixture.statuses.set(34, undefined);
    fixture.adapters.getClaimOwner = async () => { throw new Error('comments unavailable'); };
    const result = await sweep(fixture.adapters, true);
    expect(result.entries[0]).toMatchObject({ action: 'close', applied: false, error: 'Error: comments unavailable' });
    expect(fixture.calls.filter((call) => call.startsWith('label:') || call.startsWith('close:'))).toEqual([]);
  });

  it('keeps an expired running claim when the ledger is running and shares the close cap with other drafts', async () => {
    const drafts = Array.from({ length: DRAFT_SWEEP_CLOSE_CAP + 2 }, (_, i) => draft(200 + i, {
      labels: i % 2 === 0 ? [running] : [stalled], updatedAt: idle(50),
    }));
    const fixture = make(drafts);
    for (const pr of drafts) fixture.statuses.set(pr.number, undefined);
    fixture.statuses.set(200, 'running');
    const result = await sweep(fixture.adapters, true);
    expect(result.entries[0]).toMatchObject({ action: 'keep', reason: 'claim-expired-but-live' });
    expect(result.closed).toBe(DRAFT_SWEEP_CLOSE_CAP);
    expect(fixture.calls.filter((call) => call.startsWith('close:'))).toHaveLength(DRAFT_SWEEP_CLOSE_CAP);
  });

  it('never closes a keep-, approval- or release-hold-labelled draft, however idle and unobserved', async () => {
    const hold = PR_LABELS.find((entry) => entry.axis === 'addon' && entry.sweep.action === 'none')!.name;
    const fixture = make([draft(4, { labels: [keep], updatedAt: idle(500) }), draft(5, { labels: [approval], updatedAt: idle(500) }),
      draft(6, { labels: [hold, stalled], updatedAt: idle(500) }),
      draft(7, { labels: [hold, approval], updatedAt: idle(500) })], [
      { number: 107, title: 'Goal 7', branch: 'merged/seven' },
    ]);
    for (const n of [4, 5, 6, 7]) fixture.statuses.set(n, undefined);
    const result = await sweep(fixture.adapters, true);
    expect(result.entries[2]).toMatchObject({ action: 'keep', reason: `label:${hold}` });
    expect(result.entries[3]).toMatchObject({ action: 'keep', reason: `label:${hold}` });
    expect(fixture.calls.some((call) => call.startsWith('close:'))).toBe(false);
  });

  it(`closes at most ${DRAFT_SWEEP_CLOSE_CAP} per tick and keeps the rest as close-cap`, async () => {
    const drafts = Array.from({ length: DRAFT_SWEEP_CLOSE_CAP + 2 }, (_, i) => draft(100 + i, { updatedAt: idle(72) }));
    const fixture = make(drafts);
    for (const pr of drafts) fixture.statuses.set(pr.number, undefined);
    const result = await sweep(fixture.adapters, true);
    expect(fixture.calls.filter((call) => call.startsWith('close:'))).toHaveLength(DRAFT_SWEEP_CLOSE_CAP);
    expect(result.entries.filter((entry) => entry.reason === 'close-cap')).toHaveLength(2);
    expect(result.closed).toBe(DRAFT_SWEEP_CLOSE_CAP);
  });

  it('records a daily count of 25h harness drafts: one same-goal landing, one review PASS with a green gate, one must-fix', async () => {
    const old = '2026-09-28T23:00:00Z';
    const fresh = '2026-09-29T12:00:00Z';
    const rows = [
      draft(1, { title: 'landed goal', branch: 'self-impl/landed-goalid-aaa1-r1', createdAt: old, labels: [] }),
      draft(2, { title: 'waiting harvest', branch: 'self-impl/harvest-goalid-bbb2-r1', createdAt: old, labels: [] }),
      draft(3, { title: 'still blocked', branch: 'self-impl/blocked-goalid-ccc3-r1', createdAt: old, labels: [] }),
      draft(4, { title: 'too new', branch: 'self-impl/fresh-goalid-ddd4-r1', createdAt: fresh, labels: [] }),
      draft(5, { title: 'not a harness draft', branch: 'feature/human', createdAt: old, labels: [] }),
    ];
    const merged: SweepMergedPr[] = [{ number: 90, title: 'other title', branch: 'self-impl/landed-goalid-aaa1-r9' }];
    const posture = new Map<number, SweepReviewGate>([
      [2, { review: 'pass', gate: 'pass' }],
      [3, { review: 'fail', mustFix: true, gate: 'fail' }],
    ]);
    expect(draftSweepDaily(rows, merged, now, posture)).toEqual({
      date: '2026-09-30', over24h: 3, closable: 1, harvestable: 1, blocked: 1,
    });
    const fixture = make(rows, merged);
    fixture.adapters.getReviewGate = async (pr) => posture.get(pr.number);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = await sweep(fixture.adapters);
      expect(result.daily).toEqual({ date: '2026-09-30', over24h: 3, closable: 1, harvestable: 1, blocked: 1 });
      expect(log).toHaveBeenCalledWith('harness.drafts', 'daily', result.daily);
      expect(log).toHaveBeenCalledWith('drafts.cleanup', 'summary', result.counts);
    } finally { log.mockRestore(); }
  });

  it('names the first gh error as one line with no stack and still exits the sweep incomplete', async () => {
    const fixture = make([draft(1)]);
    const failure = new Error('gh: Command failed\n    at ChildProcess.exithandler (node:child_process:1:1)');
    fixture.adapters.listDrafts = async () => { throw failure; };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = await sweep(fixture.adapters);
      expect(result.complete).toBe(false);
      expect(result.error).toBe('gh: Command failed');
      expect(result.error).not.toContain('at ChildProcess');
      expect(sweepFailureReason(failure)).toBe('gh: Command failed');
      expect(log).toHaveBeenCalledWith('drafts.cleanup', 'failed', { reason: 'gh: Command failed' });
    } finally { log.mockRestore(); }
  });
});
