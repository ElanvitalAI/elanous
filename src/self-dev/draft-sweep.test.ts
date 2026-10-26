import { describe, expect, it, spyOn, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAIM_IDLE_HOURS, PR_LABELS, STALLED_DRAFT_HOURS } from '../github/pr-labels.js';
import { DRAFT_NEEDS_OWNER_SEAT_CAP, isSeatDraftNeedsOwnerOverCap, shouldHoldSeatNewLaunch, DRAFT_SWEEP_CLOSE_CAP, DRAFT_SWEEP_CONCURRENCY, resolveDraftSweepCloseCap, collectDraftMetrics, collectOverlapMetrics, countSalvagedToday, type OverlapMetricAdapters, type OverlapPreflightRow, draftSweepDaily, newerLineageDraft, newerSameCellDraft, runDraftSweep, supersedeDraftsOnMerge, sweptReasonLabel, sweepFailureReason, validateDraftSweepApplyPlan, type DraftSweepAdapters, type DraftSweepApplyPlan, type SweepDraft, type SweepMergedPr, type SweepReviewGate } from './draft-sweep.js';
import { branchLineageKey } from '../harness/worktree-branch-prefix.js';
import { RELEASE_PATH_LABEL } from './release-path-guard.js';
import { debug } from '../debug/log.js';
import { activeClaimOwnerFromBodies, activeClaimRunIdFromBodies, githubDraftSweepAdapters, lastClaimReleaseAtFromBodies } from '../harness/harness-cli-command.js';
import type { TaskCard } from '../task-agent/task-hand.js';
import type { PrTerminalRecord } from './draft-residue.js';

const state = (name: string) => PR_LABELS.find((entry) => entry.axis === 'state' && entry.name.endsWith(name))!.name;
const running = state('running');
const stalled = state('stalled');
const superseded = state('superseded');
const approval = state('idea-approval');
const keep = PR_LABELS.find((entry) => entry.sweep.action === 'exclude')!.name;
const now = new Date('2026-09-30T00:00:00Z');
expect(new Set(['superseded-by #90', 'superseded-by #91 (all-files-landed)', 'duplicate-of-open #2', 'claim-expired (final)', 'stale-unobserved', 'harvest-expired', 'stale-ended-run', 'unexpected'].map(sweptReasonLabel))).toEqual(new Set(['superseded-by', 'duplicate-of-open', 'claim-expired', 'stale-unobserved', 'harvest-expired', 'stale-ended-run', 'other'].map((kind) => `elanous:swept:${kind}`)));
const draft = (number: number, options: Partial<SweepDraft> = {}): SweepDraft => ({
  number, title: `Goal ${number}`, branch: `self-impl/goalid-${number.toString(16)}-run`,
  labels: [running], createdAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z', runId: `run-${number}`, ...options,
});
const make = (drafts: SweepDraft[], merged: SweepMergedPr[] = []) => {
  const calls: string[] = [];
  const sweptLabels: string[] = [];
  const statuses = new Map<number, string | undefined>(drafts.map((pr) => [pr.number, 'ended-unclosed']));
  let live: ReadonlySet<string> | undefined = new Set();
  const adapters: DraftSweepAdapters = {
    listDrafts: async (page, size) => { calls.push(`drafts:${page}`); return drafts.slice((page - 1) * size, page * size); },
    listMerged: async (page, size) => { calls.push(`merged:${page}`); return merged.slice((page - 1) * size, page * size); },
    getRunStatus: async (pr) => statuses.get(pr.number),
    listLiveBranches: async () => live,
    setLabels: async (_repo, n, change) => {
      if (change.add.startsWith('elanous:swept:')) sweptLabels.push(`${n}:${change.add}`);
      else calls.push(`label:${n}:${change.remove.join(',')}=>${change.add}`);
    },
    closeDraft: async (_repo, n, ...rest) => {
      expect(rest).toHaveLength(0);
      calls.push(`close:${n}`);
    },
  };
  return { calls, sweptLabels, statuses, adapters, setLive: (value: ReadonlySet<string> | undefined) => { live = value; } };
};
const sweep = (adapters: DraftSweepAdapters, apply = false) => runDraftSweep({ repository: 'owner/repo', adapters, apply, now });

describe('runDraftSweep — frozen apply plan', () => {
  const plan: DraftSweepApplyPlan = { version: 1, closeCap: 1, closeCapSource: 'flag', entries: [
    { number: 1, action: 'close', reason: 'superseded-by #3', statusLabel: superseded, applied: false,
      headSha: 'a'.repeat(40), branch: 'self-impl/goalid-1-run', updatedAt: '2026-10-24T00:00:00Z', labels: [running] },
    { number: 2, action: 'keep', reason: 'close-cap', applied: false,
      headSha: 'b'.repeat(40), branch: 'self-impl/goalid-2-run', updatedAt: '2026-10-24T00:00:00Z', labels: [running] },
  ] };
  const fixture = (updatedAt = '2026-10-24T00:00:00Z') => {
    const writes: string[] = [];
    let snapshots = 0;
    const adapters: DraftSweepAdapters = {
      listDrafts: async () => { throw new Error('apply plan must not relist drafts'); },
      listMerged: async () => { throw new Error('apply plan must not relist merged PRs'); },
      getRunStatus: async () => { throw new Error('apply plan must not reclassify runs'); },
      listLiveBranches: async () => { throw new Error('apply plan must not inspect worktrees'); },
      getDraftSnapshot: async (_repo, number) => {
        snapshots++;
        return { number, state: 'open', draft: true, headSha: number === 1 ? 'a'.repeat(40) : 'b'.repeat(40),
          branch: `self-impl/goalid-${number}-run`, updatedAt, labels: [running] };
      },
      setLabels: async (_repo, number, change) => { writes.push(`label:${number}:${change.add}`); },
      closeDraft: async (_repo, number) => { writes.push(`close:${number}`); },
    };
    return { adapters, writes, snapshotCount: () => snapshots };
  };

  it('emits a frozen plan only from a complete dry-run classification', async () => {
    const f = make([draft(77, { headSha: 'd'.repeat(40) })]);
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: f.adapters, includeApplyPlan: true, now });
    expect(result.complete).toBe(true);
    expect(result.applyPlan?.entries).toHaveLength(result.entries.length);
    expect(result.applyPlan?.entries[0]).toMatchObject({ number: 77, headSha: 'd'.repeat(40),
      updatedAt: '2026-09-28T00:00:00Z', labels: [running] });
  });

  it('applies only the classified close set after inventory insertion/reordering, without reclassification', async () => {
    const f = fixture();
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: f.adapters, apply: true, applyPlan: plan });
    expect(result.complete).toBe(true);
    expect(f.snapshotCount()).toBe(2);
    expect(f.writes.filter((write) => write.startsWith('close:'))).toEqual(['close:1']);
    expect(f.writes.some((write) => write.includes(':2:') || write === 'close:2')).toBe(false);
  });

  it('fails closed when a keep-only row drifts, records the drift, and performs no close writes', async () => {
    const f = fixture();
    const getSnapshot = f.adapters.getDraftSnapshot!;
    f.adapters.getDraftSnapshot = async (_repo, number) => {
      if (number === 2) {
        const current = await getSnapshot(_repo, number);
        return { ...current!, headSha: 'c'.repeat(40) };
      }
      return getSnapshot(_repo, number);
    };
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: f.adapters, apply: true, applyPlan: plan });
    expect(result.complete).toBe(false);
    expect(result.error).toContain('snapshot drift at #2');
    expect(result.entries.find((entry) => entry.number === 2)).toMatchObject({
      action: 'keep', reason: 'close-cap', error: 'head SHA drift', applied: false,
    });
    expect(f.snapshotCount()).toBe(2);
    expect(f.writes).toEqual([]);
  });

  it('fails closed on PR snapshot drift before any label or close write', async () => {
    const f = fixture('2026-10-24T00:01:00Z');
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: f.adapters, apply: true, applyPlan: plan });
    expect(result.complete).toBe(false);
    expect(result.error).toContain('snapshot drift at #1');
    expect(f.writes).toEqual([]);
  });

  it('records snapshot lookup failures as drift and performs no writes', async () => {
    const f = fixture();
    f.adapters.getDraftSnapshot = async (_repo, number) => {
      if (number === 2) throw new Error('snapshot unavailable');
      return { number, state: 'open', draft: true, headSha: 'a'.repeat(40), branch: 'self-impl/goalid-1-run',
        updatedAt: '2026-10-24T00:00:00Z', labels: [running] };
    };
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: f.adapters, apply: true, applyPlan: plan });
    expect(result.complete).toBe(false);
    expect(result.entries.find((entry) => entry.number === 2)?.error).toContain('snapshot lookup failed');
    expect(f.writes).toEqual([]);
  });

  it('does not report a preflight-only successor as applied', async () => {
    const livePlan: DraftSweepApplyPlan = { version: 1, closeCap: 1, closeCapSource: 'flag', entries: [
      { number: 1, action: 'close', reason: 'duplicate-of-open #2 · stop run run-1', statusLabel: superseded,
        runId: 'run-1', stopRunRequired: true, supersedeNewer: { number: 2, branch: 'self-impl/goalid-2-run', runId: 'run-2' },
        applied: false, headSha: 'a'.repeat(40), branch: 'self-impl/goalid-1-run', updatedAt: '2026-10-24T00:00:00Z', labels: [running] },
      { number: 2, action: 'keep', reason: 'live', applied: false, runId: 'run-2',
        headSha: 'b'.repeat(40), branch: 'self-impl/goalid-2-run', updatedAt: '2026-10-24T00:00:00Z', labels: [running] },
    ] };
    const writes: string[] = [];
    const adapters: DraftSweepAdapters = {
      listDrafts: async () => { throw new Error('apply plan must not relist drafts'); },
      listMerged: async () => { throw new Error('apply plan must not relist merged PRs'); },
      getRunStatus: async () => 'running',
      listLiveBranches: async () => new Set(['self-impl/goalid-1-run', 'self-impl/goalid-2-run']),
      getDraftSnapshot: async (_repo, number) => ({ number, state: 'open', draft: true,
        headSha: number === 1 ? 'a'.repeat(40) : 'b'.repeat(40), branch: `self-impl/goalid-${number}-run`,
        updatedAt: '2026-10-24T00:00:00Z', labels: [running] }),
      supersedeRun: async () => { writes.push('stop'); },
      setLabels: async (_repo, number, change) => { writes.push(`label:${number}:${change.add}`); },
      closeDraft: async (_repo, number) => { writes.push(`close:${number}`); },
    };
    const result = await runDraftSweep({ repository: 'owner/repo', adapters, apply: true, applyPlan: livePlan });
    expect(result.complete).toBe(true);
    expect(result.entries).toMatchObject([{ number: 1, applied: true }, { number: 2, applied: false }]);
    expect(writes).toContain('stop');
  });

  it('rejects a serialized plan that attempts to write a non-state label', () => {
    const malformed = { ...plan, entries: plan.entries.map((entry, index) => index === 0 ? { ...entry, statusLabel: 'arbitrary-label' } : entry) };
    expect(() => validateDraftSweepApplyPlan(malformed)).toThrow('invalid draft sweep apply plan entry');
    const cellDuplicate = { ...plan, entries: plan.entries.map((entry, index) => index === 0
      ? { ...entry, reason: 'duplicate-of-open #3 (cell CELL-A0)' } : entry) };
    expect(validateDraftSweepApplyPlan(cellDuplicate).entries[0]?.reason).toBe('duplicate-of-open #3 (cell CELL-A0)');
    const unknownReason = { ...plan, entries: plan.entries.map((entry, index) => index === 0
      ? { ...entry, reason: 'unrecognized close reason' } : entry) };
    expect(() => validateDraftSweepApplyPlan(unknownReason)).toThrow('invalid draft sweep apply plan entry');
  });
});

describe('supersedeDraftsOnMerge', () => {
  const merged = { number: 90, title: '「하니스로 구현」 DRAFT-TRIAGE', branch: 'self-impl/draft-triage-goalid-1-new',
    createdAt: '2026-09-30T00:00:00Z', mergedAt: '2026-10-01T00:00:00Z' };

  it('closes only the explicitly named old OPEN draft in the merged PR cell, in label-comment-close order', async () => {
    const successor = { ...merged, branch: 'self-impl/new-cell-run', body: '칸: CELL-A\n카드: card-a\n\nSupersedes: #7' };
    const old = draft(7, { branch: 'self-impl/old-cell-run', body: '칸: CELL-A\n카드: card-a', labels: [running] });
    const unrelated = draft(8, { branch: 'self-impl/other-cell-run', body: '칸: CELL-B', labels: [running] });
    const fixture = make([old, unrelated]);
    fixture.adapters.listIssueComments = async () => [];
    fixture.adapters.commentDraft = async (_repository, number, body) => {
      expect(body).toContain('same-cell-superseded #7 -> #90');
      fixture.calls.push(`comment:${number}`);
    };
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged: successor, adapters: fixture.adapters }))
      .toEqual({ closed: [7], kept: [8] });
    expect(fixture.calls.filter((call) => /^(label|comment|close):/.test(call)))
      .toEqual([`label:7:${running}=>${superseded}`, 'comment:7', 'close:7']);
  });

  it('the CLI-only mode never runs generic merged-goal cleanup for an unmarked other-cell draft', async () => {
    const successor = { ...merged, body: '칸: CELL-A\nSupersedes: #7' };
    const old = draft(7, { body: '칸: CELL-A', labels: [stalled] });
    const other = draft(8, { branch: 'self-impl/other-goalid-1-run', body: '칸: CELL-B', labels: [stalled] });
    const fixture = make([old, other]);
    fixture.adapters.listIssueComments = async () => [];
    fixture.adapters.commentDraft = async () => {};
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged: successor, adapters: fixture.adapters,
      onlyExplicitSameCell: true })).toEqual({ closed: [7], kept: [8] });
    expect(fixture.calls.filter((call) => call.startsWith('close:'))).toEqual(['close:7']);
  });

  it('keeps unmarked same-cell and mismatched-cell drafts open without an inferred close', async () => {
    const old = draft(7, { branch: 'self-impl/old-goalid-1-run', body: '칸: CELL-A', labels: [stalled] });
    const fixture = make([old]);
    const successor = { ...merged, body: '칸: CELL-A' };
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged: successor, adapters: fixture.adapters }))
      .toEqual({ closed: [], kept: [7] });
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged: { ...successor, body: '칸: CELL-B\nSupersedes: #7' }, adapters: fixture.adapters }))
      .toEqual({ closed: [], kept: [7] });
    expect(fixture.calls.some((call) => /^(label|close):/.test(call))).toBe(false);
  });

  it('observes comment failure and retries without duplicating a comment after close failure', async () => {
    const old = draft(7, { branch: 'self-impl/old-cell-run', body: '칸: CELL-A', labels: [running] });
    const fixture = make([old]);
    const successor = { ...merged, body: '칸: CELL-A\nSupersedes: #7' };
    const comments: string[] = [];
    let closeFails = true;
    fixture.adapters.listIssueComments = async () => comments;
    fixture.adapters.commentDraft = async (_repository, number, body) => { comments.push(body); fixture.calls.push(`comment:${number}`); };
    fixture.adapters.closeDraft = async (_repository, number) => {
      if (closeFails) throw new Error('close unavailable');
      fixture.calls.push(`close:${number}`);
    };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged: successor, adapters: fixture.adapters }))
        .toEqual({ closed: [], kept: [7] });
      expect(log).toHaveBeenCalledWith('drafts.cleanup', 'same-cell-supersede-failed', {
        merged: 90, old: 7, error: 'Error: close unavailable',
      });
      closeFails = false;
      expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged: successor, adapters: fixture.adapters }))
        .toEqual({ closed: [7], kept: [] });
      expect(fixture.calls.filter((call) => call === 'comment:7')).toHaveLength(1);
    } finally { log.mockRestore(); }
  });

  it('never closes after a failed replacement comment or when the old draft is protected', async () => {
    const successor = { ...merged, body: '칸: CELL-A\nSupersedes: #7' };
    const old = draft(7, { branch: 'self-impl/old-cell-run', body: '칸: CELL-A', labels: [running] });
    const fixture = make([old]);
    fixture.adapters.listIssueComments = async () => [];
    fixture.adapters.commentDraft = async () => { throw new Error('comment unavailable'); };
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged: successor, adapters: fixture.adapters }))
      .toEqual({ closed: [], kept: [7] });
    expect(fixture.calls.some((call) => call.startsWith('close:'))).toBe(false);
    fixture.adapters.listDrafts = async () => [{ ...old, labels: [keep] }];
    fixture.calls.length = 0;
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged: successor, adapters: fixture.adapters }))
      .toEqual({ closed: [], kept: [7] });
    expect(fixture.calls.some((call) => /^(label|close):/.test(call))).toBe(false);
  });

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
      expect(fixture.sweptLabels).toEqual(['1:elanous:swept:superseded-by']);
      expect(log).toHaveBeenCalledWith('self-dev.draft-sweep', 'closed', { pr: 1, reason: 'superseded-by #90' });
      expect(fixture.calls.filter((call) => call.startsWith('label:') || call.startsWith('close:'))).toEqual([
        `label:1:${stalled}=>${superseded}`, 'close:1',
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
      expect(github).toEqual({ open: false, labels: [superseded, 'elanous:swept:superseded-by'] });
    } finally { log.mockRestore(); }
  });

  it('leaves an open draft labelled superseded for the next sweep when closing fails', async () => {
    const fixture = make([draft(1, { title: merged.title, labels: [stalled] })]);
    const github = new Map<number, { open: boolean; labels: string[] }>([[1, { open: true, labels: [stalled] }]]);
    fixture.adapters.setLabels = async (_repo, number, change) => {
      const pr = github.get(number)!;
      pr.labels = [...new Set([...pr.labels.filter((label) => !change.remove.includes(label)), change.add])];
      fixture.calls.push(`label:${number}`);
    };
    fixture.adapters.closeDraft = async () => { throw new Error('close unavailable'); };
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters }))
      .toEqual({ closed: [], kept: [1] });
    expect(github.get(1)).toEqual({ open: true, labels: [superseded, 'elanous:swept:superseded-by'] });
    expect(fixture.calls.filter((call) => call.startsWith('label:'))).toEqual(['label:1', 'label:1']);

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
    expect(github.get(1)).toEqual({ open: false, labels: [superseded, 'elanous:swept:superseded-by'] });
    expect(fixture.calls.filter((call) => call.startsWith('close:'))).toEqual(['close:1']);
  });

  it('reuses the merged-twin branch lineage when titles differ', async () => {
    const fixture = make([draft(7, { title: 'old title', labels: [stalled], branch: 'self-impl/another-goalid-1-old' })]);
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged, adapters: fixture.adapters }))
      .toEqual({ closed: [7], kept: [] });
  });

  it('closes earlier open harness drafts matched by goal id or branch prefix while leaving unmarked same-cell drafts open', async () => {
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
      .toEqual({ closed: [21], kept: [22, 23, 24, 25, 26] });
    fixture.calls.length = 0;
    expect(await supersedeDraftsOnMerge({ repository: 'owner/repo', merged: landed, adapters: fixture.adapters }))
      .toEqual({ closed: [23], kept: [21, 22, 24, 25, 26] });
    expect(fixture.calls.filter((call) => call.startsWith('label:') || call.startsWith('close:'))).toEqual([
      `label:23:${stalled}=>${superseded}`,
      'close:23',
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

describe('seat needsOwner cap', () => {
  it('is true only when a seat exceeds the default cap of 15', () => {
    expect(DRAFT_NEEDS_OWNER_SEAT_CAP).toBe(15);
    const counts = { OP: 15, TC: 16, MK: 0 };
    expect(isSeatDraftNeedsOwnerOverCap('OP', counts)).toBe(false);
    expect(isSeatDraftNeedsOwnerOverCap('TC', counts)).toBe(true);
    expect(isSeatDraftNeedsOwnerOverCap('MK', counts)).toBe(false);
    expect(isSeatDraftNeedsOwnerOverCap('UX', counts)).toBe(false);
    expect(isSeatDraftNeedsOwnerOverCap('OP', counts, 14)).toBe(true);
    expect(isSeatDraftNeedsOwnerOverCap('TC', counts, 16)).toBe(false);
    expect(isSeatDraftNeedsOwnerOverCap('constructor', counts)).toBe(false);
  });

  it('holds a new launch only for the seat over the default cap (15 does not hold, 16 holds, missing/0 do not)', () => {
    const counts = { OP: 15, TC: 16, MK: 0 };
    expect(shouldHoldSeatNewLaunch('OP', counts)).toBe(false);
    expect(shouldHoldSeatNewLaunch('TC', counts)).toBe(true);
    expect(shouldHoldSeatNewLaunch('MK', counts)).toBe(false);
    expect(shouldHoldSeatNewLaunch('UX', counts)).toBe(false);
    expect(shouldHoldSeatNewLaunch('constructor', counts)).toBe(false);
  });
});

describe('draft metrics', () => {
  it('folds duplicate draft pages to the latest update and closed rows to the merged snapshot once', async () => {
    const older = draft(7, { createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T01:00:00Z', labels: ['elanous:seat-TC'] });
    const newer = { ...older, createdAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-29T23:00:00Z', labels: ['elanous:seat-OP'] };
    const unmerged: SweepMergedPr = { number: 8, title: 'closed', branch: 'self-impl/eight', labels: [], createdAt: '2026-09-27T00:00:00Z' };
    const merged = { ...unmerged, mergedAt: '2026-09-28T00:00:00Z' };
    const filler = Array.from({ length: 99 }, (_, i) => draft(100 + i, { branch: 'human/other', labels: [] }));
    const fixture = make([]);
    fixture.adapters.getActiveClaimOwner = async () => undefined;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      for (const [first, second, closed] of [[older, newer, [unmerged, merged]], [newer, older, [merged, unmerged]]] as const) {
        fixture.adapters.listDrafts = async (page) => page === 1 ? [first, ...filler] : page === 2 ? [second] : [];
        fixture.adapters.listRecentClosed = async () => closed;
        expect(await collectDraftMetrics('owner/repo', fixture.adapters, now)).toMatchObject({
          inventory: 1, oldestAgeHours: 48, needsOwner: 1, needsOwnerBySeat: { OP: 1 },
          cohort48h: 2, converted48h: 1, conversion48h: 0.5,
        });
      }
      expect(log.mock.calls.filter(([category, event]) => category === 'drafts.metrics' && event === 'duplicate-pr-folded')
        .map(([, , data]) => data)).toEqual([
          { repository: 'owner/repo', drafts: 1, closed: 1, folded: 2 },
          { repository: 'owner/repo', drafts: 1, closed: 1, folded: 2 },
        ]);
      const tied = { ...newer, labels: ['elanous:seat-TC'] };
      for (const rows of [[newer, tied], [tied, newer]]) {
        fixture.adapters.listDrafts = async () => rows;
        fixture.adapters.listRecentClosed = async () => [];
        expect((await collectDraftMetrics('owner/repo', fixture.adapters, now)).needsOwnerBySeat).toEqual({ TC: 1 });
      }
      fixture.adapters.listDrafts = async () => [older, newer];
      fixture.adapters.listRecentClosed = async () => [{ ...merged, number: 7 }];
      expect(collectDraftMetrics('owner/repo', fixture.adapters, now)).rejects.toThrow('Overlapping draft metric inventory');
      fixture.adapters.listDrafts = async () => [older, { ...newer, labels: [42 as unknown as string] }];
      fixture.adapters.listRecentClosed = async () => [merged];
      expect(collectDraftMetrics('owner/repo', fixture.adapters, now)).rejects.toThrow('Incomplete draft metric inventory');
    } finally { log.mockRestore(); }
  });

  it('counts open inventory, oldest age and missing claim owner; converts only merged PRs within 48h of creation', async () => {
    const rows = [draft(1, { createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T23:00:00Z' }),
      draft(2, { createdAt: '2026-09-26T00:00:00Z' }),
      draft(3, { branch: 'human/other', labels: [], createdAt: '2026-09-29T00:00:00Z' })];
    const fixture = make(rows);
    fixture.adapters.getActiveClaimOwner = async (_repo, number) => number === 1 ? 'OP' : undefined;
    fixture.adapters.listRecentClosed = async () => [
      { number: 10, title: 'converted', branch: 'self-impl/converted', draft: true, labels: [], createdAt: '2026-09-27T00:00:00Z', mergedAt: '2026-09-28T23:00:00Z' },
      { number: 11, title: 'late', branch: 'self-impl/late', draft: true, labels: [], createdAt: '2026-09-27T23:00:00Z', mergedAt: '2026-09-30T00:00:00Z' },
    ];
    expect(await collectDraftMetrics('owner/repo', fixture.adapters, now)).toEqual({
      inventory: 2, oldestAgeHours: 96, needsOwner: 1, needsOwnerBySeat: {}, claimUnobserved: 0,
      converted48h: 1, cohort48h: 3, conversion48h: 1 / 3,
    });
    expect(draftSweepDaily(rows, [], now, new Map())).toEqual({ date: '2026-09-30', over24h: 2, closable: 0, harvestable: 0, blocked: 0 });
    fixture.adapters.listRecentClosed = async () => [{ number: 12, title: 'labelled', branch: 'topic/labelled', draft: true,
      labels: ['elanous:running'], createdAt: '2026-09-27T00:00:00Z', mergedAt: '2026-09-28T00:00:00Z' }];
    expect((await collectDraftMetrics('owner/repo', fixture.adapters, now)).conversion48h).toBe(0.5);
    fixture.adapters.listRecentClosed = async () => [{ number: 13, title: 'closed without merging', branch: 'self-impl/closed', draft: true,
      labels: [], createdAt: '2026-09-27T00:00:00Z' }];
    expect(await collectDraftMetrics('owner/repo', fixture.adapters, now)).toMatchObject({
      cohort48h: 2, converted48h: 0, conversion48h: 0,
    });
    fixture.adapters.listRecentClosed = async () => [{ number: 14, title: 'bad ordering', branch: 'self-impl/invalid',
      labels: [], createdAt: '2026-09-27T00:00:00Z', mergedAt: '2026-09-26T00:00:00Z' }];
    expect((await collectDraftMetrics('owner/repo', fixture.adapters, now)).converted48h).toBe(0);
  });

  it('does not invent a conversion when no cohort exists, and fails closed on missing owner or merged source', async () => {
    const fixture = make([]);
    fixture.adapters.listRecentClosed = async () => [];
    fixture.adapters.getActiveClaimOwner = async () => undefined;
    expect(await collectDraftMetrics('owner/repo', fixture.adapters, now)).toEqual({
      inventory: 0, oldestAgeHours: null, needsOwner: 0, needsOwnerBySeat: {}, claimUnobserved: 0,
      converted48h: 0, cohort48h: 0, conversion48h: null,
    });
    fixture.adapters.listRecentClosed = undefined;
    expect(collectDraftMetrics('owner/repo', fixture.adapters, now)).rejects.toThrow('48h closed cohort unavailable');
    fixture.adapters.listRecentClosed = async () => [];
    fixture.adapters.listDrafts = async () => [draft(5)];
    fixture.adapters.getActiveClaimOwner = undefined;
    expect(collectDraftMetrics('owner/repo', fixture.adapters, now)).rejects.toThrow('Draft owner lookup unavailable');
    fixture.adapters.getActiveClaimOwner = async () => undefined;
    fixture.adapters.listRecentClosed = async () => [{ number: 5, title: 'duplicate', branch: 'self-impl/duplicate', draft: true,
      labels: [], createdAt: '2026-09-28T00:00:00Z' }];
    expect(collectDraftMetrics('owner/repo', fixture.adapters, now)).rejects.toThrow('Overlapping draft metric inventory');
  });

  it('aggregates needsOwnerBySeat (own-key, finite counts) and holds only that seat over the default cap', async () => {
    const tc = Array.from({ length: 16 }, (_, i) => draft(100 + i, { labels: ['elanous:seat-TC'], updatedAt: now.toISOString() }));
    const op = Array.from({ length: 15 }, (_, i) => draft(200 + i, { labels: ['elanous:seat-OP'], updatedAt: now.toISOString() }));
    const mk = [draft(300, { labels: ['elanous:seat-MK'], updatedAt: now.toISOString() })];
    const unattributed = [draft(400, { labels: [], updatedAt: now.toISOString() })];
    const claimed = [draft(500, { labels: [running, 'elanous:seat-UX'], updatedAt: now.toISOString() })];
    const fixture = make([...tc, ...op, ...mk, ...unattributed, ...claimed]);
    fixture.adapters.listRecentClosed = async () => [];
    fixture.adapters.getActiveClaimOwner = async (_repo, number) => number === 500 ? 'UX' : undefined;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const metrics = await collectDraftMetrics('owner/repo', fixture.adapters, now);
      expect(metrics.needsOwner).toBe(33);
      expect(metrics.needsOwnerBySeat).toEqual({ TC: 16, OP: 15, MK: 1 });
      expect(Object.hasOwn(metrics.needsOwnerBySeat ?? {}, 'UX')).toBe(false);
      expect(shouldHoldSeatNewLaunch('TC', metrics.needsOwnerBySeat ?? {})).toBe(true);
      expect(shouldHoldSeatNewLaunch('OP', metrics.needsOwnerBySeat ?? {})).toBe(false);
      expect(shouldHoldSeatNewLaunch('MK', metrics.needsOwnerBySeat ?? {})).toBe(false);
      expect(shouldHoldSeatNewLaunch('UX', metrics.needsOwnerBySeat ?? {})).toBe(false);
      const hold = log.mock.calls.find((call) => call[0] === 'self-dev.draft-metrics' && call[1] === 'seat-launch-hold');
      expect(hold?.[2]).toMatchObject({ heldSeats: ['TC'] });
    } finally { log.mockRestore(); }
  });
});

describe('automatic draft claim lifecycle', () => {
  const R = 'run-child-R';
  const card = (id: string, pr: number): TaskCard => ({ id, text: 'draft', seat: 'UX', status: 'launched',
    completion: 'code-pr', createdAt: now.toISOString(), history: [], runId: `run-parent-${id}`, runChildId: R, pr: { number: pr } });
  const fixtureFor = (rows: SweepDraft[], cards: TaskCard[]) => {
    const labels = new Map(rows.map((row) => [row.number, [...row.labels]]));
    const comments = new Map(rows.map((row) => [row.number, [] as string[]]));
    const fixture = make(rows);
    let terminals: PrTerminalRecord[] = [];
    fixture.adapters.listDrafts = async () => rows.map((row) => ({ ...row, labels: labels.get(row.number)!,
      updatedAt: comments.get(row.number)!.length ? now.toISOString() : row.updatedAt }));
    fixture.adapters.listRecentClosed = async () => [];
    fixture.adapters.listTaskCards = async () => cards;
    fixture.adapters.listPrTerminals = async () => terminals;
    fixture.adapters.getActiveClaimOwner = async (_repo, number) => activeClaimOwnerFromBodies(comments.get(number)!);
    fixture.adapters.getActiveClaimRunId = async (_repo, number) => activeClaimRunIdFromBodies(comments.get(number)!);
    fixture.adapters.getLastClaimReleaseAt = async (_repo, number) => lastClaimReleaseAtFromBodies(comments.get(number)!);
    fixture.adapters.setLabels = async (_repo, number, change) => {
      labels.set(number, [...labels.get(number)!.filter((name) => !change.remove.includes(name) && name !== change.add), change.add]);
      fixture.calls.push(`label:${number}:${change.add}`);
    };
    fixture.adapters.removeLabel = async (_repo, number, name) => { labels.set(number, labels.get(number)!.filter((label) => label !== name)); };
    fixture.adapters.commentDraft = async (_repo, number, body) => { comments.get(number)!.push(body); };
    return { ...fixture, labels, comments, setTerminals: (next: PrTerminalRecord[]) => { terminals = next; } };
  };

  it('shares freshness/expiry/unobserved decisions between metrics and sweep', async () => {
    const rows = [draft(1, { updatedAt: new Date(now.getTime() - 3_600_000).toISOString() }),
      draft(2, { updatedAt: new Date(now.getTime() - 7 * 3_600_000).toISOString() }),
      draft(3, { updatedAt: undefined })];
    const fixture = make(rows);
    fixture.adapters.listRecentClosed = async () => [];
    fixture.adapters.getActiveClaimOwner = async () => 'TC';
    expect(await collectDraftMetrics('owner/repo', fixture.adapters, now)).toMatchObject({ inventory: 3, needsOwner: 1, claimUnobserved: 1 });
    fixture.statuses.set(2, 'running');
    expect(await sweep(fixture.adapters)).toMatchObject({ claimed: 1, claimExpired: 1 });
  });

  it('claims each uniquely owned draft once and releases only after the matching immutable terminal', async () => {
    const rows = [draft(501, { labels: [], updatedAt: now.toISOString() }), draft(502, { labels: [], updatedAt: now.toISOString() })];
    const cards = [card('one', 501), card('two', 502)];
    const fixture = fixtureFor(rows, cards);
    const record: PrTerminalRecord = { childRunId: R, prNumber: 501, prUrl: 'https://github.com/owner/repo/pull/501',
      repository: 'owner/repo', headSha: null, terminalClass: 'merge-ready-not-merged', stage: null,
      owner: 'UX', ownerSource: 'seat', card: null, at: now.toISOString(), hostRegateFailure: null  };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, apply: true, now, closeCap: 1, alreadyClosed: 1 });
      expect(fixture.labels.get(501)).toContain(running);
      expect(fixture.comments.get(501)).toEqual([`🔧 처리 중 — owner UX · ${now.toISOString()} · run ${R}`]);
      expect(fixture.comments.get(502)).toHaveLength(1);
      expect((await collectDraftMetrics('owner/repo', fixture.adapters, now)).needsOwner).toBe(0);
      await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, apply: true, now, closeCap: 1, alreadyClosed: 1 });
      expect(fixture.comments.get(501)).toHaveLength(1);
      fixture.setTerminals([record]);
      const result = await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, apply: true, now, closeCap: 1, alreadyClosed: 1 });
      expect(fixture.comments.get(501)?.at(-1)).toBe(`🔧 처리 끝 — ${now.toISOString()} · run ${R} · merge-ready-not-merged`);
      expect(fixture.labels.get(501)).not.toContain(running);
      await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, apply: true, now, closeCap: 1, alreadyClosed: 1 });
      expect(fixture.comments.get(501)).toHaveLength(2);
      expect(activeClaimOwnerFromBodies(fixture.comments.get(501)!)).toBeUndefined();
      expect(record).toEqual({ childRunId: R, prNumber: 501, prUrl: 'https://github.com/owner/repo/pull/501',
        repository: 'owner/repo', headSha: null, terminalClass: 'merge-ready-not-merged', stage: null,
        owner: 'UX', ownerSource: 'seat', card: null, at: now.toISOString(), hostRegateFailure: null  });
      expect(result.closed).toBe(0);
      expect(fixture.calls.filter((call) => call.startsWith('close:'))).toHaveLength(0);
      expect(log).toHaveBeenCalledWith('draft.residue', 'claim-released', { prNumber: 501, owner: 'UX', runId: R, reason: 'merge-ready-not-merged' });
    } finally { log.mockRestore(); }
  });

  it('skips a terminal from another run of the same PR, including a parent/child mismatch', async () => {
    const row = draft(550, { labels: [running], updatedAt: now.toISOString() });
    const fixture = fixtureFor([row], [card('same-pr', 550)]);
    fixture.comments.get(550)!.push(`🔧 처리 중 — owner TC · ${now.toISOString()} · run run-unrelated`);
    fixture.setTerminals([{ childRunId: R, prNumber: 550, prUrl: null, repository: 'owner/repo', headSha: null,
      terminalClass: 'failed-with-pr', stage: null, owner: 'UX', ownerSource: 'seat', card: null, at: now.toISOString(), hostRegateFailure: null  }]);
    await sweep(fixture.adapters, true);
    expect(fixture.comments.get(550)).toHaveLength(1);
    expect(fixture.labels.get(550)).toContain(running);
  });

  it('refuses two owners and an unreadable card inventory', async () => {
    const row = draft(601, { labels: [], updatedAt: now.toISOString() });
    const fixture = fixtureFor([row], [card('one', 601), card('two', 601)]);
    await sweep(fixture.adapters, true);
    expect(fixture.comments.get(601)).toEqual([]);
    fixture.adapters.listTaskCards = async () => undefined;
    await sweep(fixture.adapters, true);
    expect(fixture.comments.get(601)).toEqual([]);
    expect(fixture.labels.get(601)).not.toContain(running);
  });

  it('resolves an opening child run without a card PR and releases a parent-run claim on the child terminal', async () => {
    const opener = { ...card('run-only', 900), pr: undefined };
    const row = draft(901, { labels: [], updatedAt: now.toISOString(), runId: R });
    const fixture = fixtureFor([row], [opener]);
    await sweep(fixture.adapters, true);
    expect(fixture.comments.get(901)).toEqual([`🔧 처리 중 — owner UX · ${now.toISOString()} · run ${R}`]);
    fixture.comments.get(901)!.push(`🔧 처리 중 — owner UX · ${now.toISOString()} · run ${opener.runId}`);
    fixture.setTerminals([{ childRunId: R, prNumber: 901, repository: 'owner/repo', prUrl: null,
      headSha: null, terminalClass: 'failed-with-pr', stage: null, owner: 'UX', ownerSource: 'seat', card: null, at: now.toISOString(), hostRegateFailure: null  }]);
    await sweep(fixture.adapters, true);
    expect(fixture.comments.get(901)?.at(-1)).toBe(`🔧 처리 끝 — ${now.toISOString()} · run ${opener.runId} · failed-with-pr`);
    expect(fixture.labels.get(901)).not.toContain(running);
  });

  it('does not re-claim a released draft whose terminal is already recorded', async () => {
    const row = draft(802, { labels: [], updatedAt: now.toISOString() });
    const fixture = fixtureFor([row], [card('one', 802)]);
    fixture.comments.get(802)!.push(`🔧 처리 중 — owner UX · ${now.toISOString()} · run ${R}`);
    fixture.comments.get(802)!.push(`🔧 처리 끝 — ${now.toISOString()} · run ${R} · failed-with-pr`);
    fixture.setTerminals([{ childRunId: R, prNumber: 802, repository: 'owner/repo', prUrl: null, headSha: null,
      terminalClass: 'failed-with-pr', stage: null, owner: 'UX', ownerSource: 'seat', card: null, at: now.toISOString(), hostRegateFailure: null  }]);
    await sweep(fixture.adapters, true);
    expect(fixture.comments.get(802)).toHaveLength(2);
    expect(fixture.labels.get(802)).not.toContain(running);
  });

  it('repairs the missing owner comment after a label-only partial claim without duplicating it', async () => {
    const row = draft(801, { labels: [], updatedAt: now.toISOString() });
    const fixture = fixtureFor([row], [card('one', 801)]);
    let failComment = true;
    let labelWrites = 0;
    fixture.adapters.setLabels = async (_repo, number, change) => {
      labelWrites++;
      fixture.labels.set(number, [change.add]);
    };
    fixture.adapters.commentDraft = async (_repo, number, body) => {
      if (failComment) throw new Error('comment denied');
      fixture.comments.get(number)!.push(body);
    };
    await sweep(fixture.adapters, true);
    expect(fixture.labels.get(801)).toEqual([running]);
    expect(fixture.comments.get(801)).toEqual([]);
    failComment = false;
    await sweep(fixture.adapters, true);
    await sweep(fixture.adapters, true);
    expect(fixture.labels.get(801)).toEqual([running]);
    expect(labelWrites).toBe(1);
    expect(fixture.comments.get(801)).toEqual([`🔧 처리 중 — owner UX · ${now.toISOString()} · run ${R}`]);
    expect(activeClaimOwnerFromBodies(fixture.comments.get(801)!)).toBe('UX');
    expect(activeClaimRunIdFromBodies(fixture.comments.get(801)!)).toBe(R);
  });

  it('reports a failed release comment after label removal and repairs it on the next sweep', async () => {
    const row = draft(803, { labels: [running], updatedAt: now.toISOString() });
    const fixture = fixtureFor([row], [card('one', 803)]);
    fixture.comments.get(803)!.push(`🔧 처리 중 — owner UX · ${now.toISOString()} · run ${R}`);
    fixture.setTerminals([{ childRunId: R, prNumber: 803, prUrl: null, repository: 'owner/repo', headSha: null,
      terminalClass: 'failed-with-pr', stage: null, owner: 'UX', ownerSource: 'seat', card: null, at: now.toISOString(), hostRegateFailure: null  }]);
    const comment = fixture.adapters.commentDraft!;
    let fail = true;
    fixture.adapters.commentDraft = async (...args) => {
      if (fail) throw new Error('release comment denied');
      await comment(...args);
    };
    const first = await sweep(fixture.adapters, true);
    expect(first.entries[0]).toMatchObject({ action: 'keep', applied: false, partialApplied: true,
      error: 'Error: release comment denied' });
    expect(first.entries[0]?.reason).not.toBe('claim-released');
    expect(fixture.labels.get(803)).not.toContain(running);
    expect(activeClaimOwnerFromBodies(fixture.comments.get(803)!)).toBe('UX');
    fail = false;
    const second = await sweep(fixture.adapters, true);
    expect(second.entries[0]).toMatchObject({ action: 'keep', reason: 'claim-released', applied: true });
    expect(fixture.comments.get(803)?.at(-1)).toBe(`🔧 처리 끝 — ${now.toISOString()} · run ${R} · failed-with-pr`);
    expect(activeClaimOwnerFromBodies(fixture.comments.get(803)!)).toBeUndefined();
    await sweep(fixture.adapters, true);
    expect(fixture.comments.get(803)).toHaveLength(2);
  });

  it('repairs a label-only claim after six hours, or holds it when ownership is ambiguous', async () => {
    const row = draft(804, { labels: [], updatedAt: now.toISOString() });
    const fixture = fixtureFor([row], [card('one', 804)]);
    const comment = fixture.adapters.commentDraft!;
    let fail = true;
    fixture.adapters.commentDraft = async (...args) => {
      if (fail) throw new Error('claim comment denied');
      await comment(...args);
    };
    await sweep(fixture.adapters, true);
    expect(fixture.labels.get(804)).toContain(running);
    expect(fixture.comments.get(804)).toHaveLength(0);
    fixture.adapters.listDrafts = async () => [{ ...row, labels: fixture.labels.get(804)!,
      updatedAt: new Date(now.getTime() - 7 * 3_600_000).toISOString() }];
    fail = false;
    const recovered = await sweep(fixture.adapters, true);
    expect(recovered.entries[0]?.action).toBe('keep');
    expect(fixture.comments.get(804)).toEqual([`🔧 처리 중 — owner UX · ${now.toISOString()} · run ${R}`]);
    expect(activeClaimOwnerFromBodies(fixture.comments.get(804)!)).toBe('UX');
    expect(fixture.labels.get(804)).toContain(running);
    expect(fixture.calls.filter((call) => call.startsWith('close:'))).toHaveLength(0);
    await sweep(fixture.adapters, true);
    expect(fixture.comments.get(804)).toHaveLength(1);

    const unknown = fixtureFor([draft(805, { labels: [running], updatedAt: new Date(now.getTime() - 7 * 3_600_000).toISOString() })],
      [card('a', 805), card('b', 805)]);
    const held = await sweep(unknown.adapters, true);
    expect(held.entries[0]).toMatchObject({ action: 'keep', applied: false });
    expect(unknown.comments.get(805)).toHaveLength(0);
    expect(unknown.calls.filter((call) => call.startsWith('close:'))).toHaveLength(0);
  });

  it('respects a manual release for the card that was running, but lets a later resume card claim again', async () => {
    const row = draft(806, { labels: [state('stalled')], updatedAt: now.toISOString() });
    const fixture = fixtureFor([row], [card('one', 806)]);
    fixture.comments.get(806)!.push(`🔧 처리 중 — owner UX · ${new Date(now.getTime() - 3_600_000).toISOString()}`);
    fixture.comments.get(806)!.push(`🔧 처리 끝 — ${now.toISOString()}`);
    expect(lastClaimReleaseAtFromBodies(fixture.comments.get(806)!)).toBe(now.toISOString());
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await sweep(fixture.adapters, true);
      await sweep(fixture.adapters, true);
      expect(fixture.comments.get(806)).toHaveLength(2);
      expect(fixture.labels.get(806)).not.toContain(running);
      expect(log).toHaveBeenCalledWith('draft.residue', 'claim-skipped', { prNumber: 806, owner: 'UX', runId: R, reason: 'release-respected' });
    } finally { log.mockRestore(); }

    const resumed = fixtureFor([draft(807, { labels: [], updatedAt: now.toISOString() })],
      [{ ...card('resume', 807), createdAt: new Date(now.getTime() + 1_000).toISOString() }]);
    resumed.comments.get(807)!.push(`🔧 처리 끝 — ${now.toISOString()}`);
    await sweep(resumed.adapters, true);
    expect(resumed.comments.get(807)?.at(-1)).toBe(`🔧 처리 중 — owner UX · ${now.toISOString()} · run ${R}`);
    expect(resumed.labels.get(807)).toContain(running);
    expect(lastClaimReleaseAtFromBodies(resumed.comments.get(807)!)).toBeUndefined();
  });

  it('keeps another seat\'s claim that names the run when the seat-attributed terminal belongs to a different owner', async () => {
    const row = draft(808, { labels: [running], updatedAt: now.toISOString() });
    const fixture = fixtureFor([row], [card('one', 808)]);
    fixture.comments.get(808)!.push(`🔧 처리 중 — owner TC · ${now.toISOString()} · run ${R}`);
    fixture.setTerminals([{ childRunId: R, prNumber: 808, prUrl: null, repository: 'owner/repo', headSha: null,
      terminalClass: 'failed-with-pr', stage: null, owner: 'UX', ownerSource: 'seat', card: null, at: now.toISOString(), hostRegateFailure: null  }]);
    await sweep(fixture.adapters, true);
    expect(fixture.comments.get(808)).toHaveLength(1);
    expect(fixture.labels.get(808)).toContain(running);
    expect(activeClaimOwnerFromBodies(fixture.comments.get(808)!)).toBe('TC');
  });

  it('keeps a label-only partial claim when the run terminal is attributed to another seat', async () => {
    const fixture = fixtureFor([draft(810, { labels: [running], updatedAt: now.toISOString() })], [card('one', 810)]);
    fixture.setTerminals([{ childRunId: R, prNumber: 810, prUrl: null, repository: 'owner/repo', headSha: null,
      terminalClass: 'failed-with-pr', stage: null, owner: 'TC', ownerSource: 'seat', card: null, at: now.toISOString(), hostRegateFailure: null  }]);
    await sweep(fixture.adapters, true);
    expect(fixture.labels.get(810)).toContain(running);
    expect(fixture.comments.get(810)).toHaveLength(0);
  });

  it('releases a label-only partial claim once its run terminal arrives', async () => {
    const row = draft(809, { labels: [], updatedAt: now.toISOString() });
    const fixture = fixtureFor([row], [card('one', 809)]);
    const comment = fixture.adapters.commentDraft!;
    let fail = true;
    fixture.adapters.commentDraft = async (...args) => {
      if (fail) throw new Error('claim comment denied');
      await comment(...args);
    };
    await sweep(fixture.adapters, true);
    expect(fixture.labels.get(809)).toContain(running);
    expect(fixture.comments.get(809)).toHaveLength(0);
    fail = false;
    fixture.setTerminals([{ childRunId: R, prNumber: 809, prUrl: null, repository: 'owner/repo', headSha: null,
      terminalClass: 'failed-with-pr', stage: null, owner: 'UX', ownerSource: 'seat', card: null, at: now.toISOString(), hostRegateFailure: null  }]);
    const released = await sweep(fixture.adapters, true);
    expect(released.entries[0]).toMatchObject({ action: 'keep', reason: 'claim-released', applied: true });
    expect(fixture.labels.get(809)).not.toContain(running);
    expect(fixture.comments.get(809)).toEqual([`🔧 처리 끝 — ${now.toISOString()} · run ${R} · failed-with-pr`]);
    await sweep(fixture.adapters, true);
    expect(fixture.comments.get(809)).toHaveLength(1);
    expect(fixture.labels.get(809)).not.toContain(running);
  });

  it('does not overwrite a different active claim or release on a foreign PR terminal', async () => {
    const row = draft(701, { labels: [running], updatedAt: now.toISOString() });
    const fixture = fixtureFor([row], [card('one', 701)]);
    fixture.comments.get(701)!.push(`🔧 처리 중 — owner TC · ${now.toISOString()} · run other-run`);
    fixture.setTerminals([{ childRunId: R, prNumber: 701, prUrl: null, repository: 'other/repo', headSha: null,
      terminalClass: 'failed-with-pr', stage: null, owner: 'UX', ownerSource: 'seat', card: null, at: now.toISOString(), hostRegateFailure: null  }]);
    await sweep(fixture.adapters, true);
    expect(fixture.comments.get(701)).toHaveLength(1);
    expect(fixture.labels.get(701)).toContain(running);
  });
});

describe('overlap metrics', () => {
  // Shaped like the real 2026-10-07 rows: Pod-forwarded, payload as a JSON string, axis summaries not lists.
  const payload = (runId: string | null, warnings: Array<{ kind: string; name: string }>, extra: Record<string, unknown> = {}) => ({
    inputSource: 'say', goalFile: '/home/ubuntu/repo/docs/goals/GOAL-src-a-ts-ed9934a2-2026-09-29.md', paths: ['src/a.ts'],
    invokerBehindDefaultBranch: false, blockers: [], warnings, plannedBranchStatus: 'resolved',
    siblingPrCount: warnings.filter((w) => w.kind === 'sibling-pr').length,
    openPrs: { state: 'checked', count: 41 }, liveRuns: { state: 'checked', count: 0 }, unreadableRuns: 0, liveRunWindowMs: 1_800_000,
    forceRequested: false, bypassed: false, ...(runId ? { runId } : {}), ...extra,
  });
  const pod = (ts: string, data: Record<string, unknown> | string): OverlapPreflightRow =>
    ({ ts, data: { origin: 'pod', podJob: 'si-task-02a19f3aba1d-67b8d2dd', originalData: typeof data === 'string' ? data : JSON.stringify(data) } });
  const capped = { kind: 'open-pr', name: '(열린 PR 조회 상한 200)' };
  const truncated = { openPrs: { state: 'truncated', count: 200, limit: 200 } };
  const overlapAdapters = (rows: readonly OverlapPreflightRow[] | null, prs: SweepMergedPr[], drafts: SweepDraft[] = [],
    salvaged: readonly OverlapPreflightRow[] | null = []): OverlapMetricAdapters => ({
    listPreflightRows: async () => rows,
    listSalvagedRows: async () => salvaged,
    listDrafts: async (page) => page === 1 ? drafts : [],
    listRecentClosed: async () => prs.filter((pr) => pr.number >= 100),
    getPr: async (_repo, number) => prs.find((pr) => pr.number === number),
  });
  const first = (number: number, slug: string): SweepMergedPr => ({ number, title: slug, branch: `self-impl/${slug}-1111aaaa`, labels: [], createdAt: '2026-09-29T00:00:00Z' });
  const none = { linked: null, autoLanded: null, autoRate: null, secondSiblingMedianHours: null, salvaged: null, salvageUnmeasured: null };

  it('reads Pod-forwarded string payloads, counts named overlaps once per run, and keeps capped scans unmeasured', async () => {
    const a = pod('2026-09-29T02:00:00Z', payload('run-aaaaaa11-1111', [{ kind: 'open-pr', name: '#1' }, { kind: 'recent-change', name: 'src/a.ts' }]));
    const rows = [
      a,
      { ...a },   // the same prod file reached through a second registered name — one launch
      // Capped scan that still named an overlapping PR: proven.
      pod('2026-09-29T04:00:00Z', payload('run-bbbbbb22-2222', [capped, { kind: 'open-pr', name: '#2' }], truncated)),
      // Capped scan with no named PR: blind, not «no overlap».
      pod('2026-09-29T05:00:00Z', payload('run-dddddd44-4444', [capped], truncated)),
      // Fully checked, only a recent-change warning: measured clean.
      pod('2026-09-29T06:00:00Z', payload('run-eeeeee55-5555', [{ kind: 'recent-change', name: 'src/a.ts' }])),
      // Local (not forwarded) row with a named sibling and no runId: linked through the sibling's lineage.
      { ts: '2026-09-29T09:00:00Z', data: payload(null, [{ kind: 'sibling-pr', name: '#5' }]) },
      // Forced past a live-run blocker: proven overlap, but no PR of its own yet.
      pod('2026-09-29T10:00:00Z', payload('run-cccccc33-3333', [], { blockers: [{ kind: 'live-run', name: 'run-x' }], forceRequested: true, bypassed: true })),
      // Not counted: blocked, or outside the window.
      pod('2026-09-29T11:00:00Z', payload('run-ffffff66-6666', [{ kind: 'open-pr', name: '#9' }], { blockers: [{ kind: 'no-target-paths', name: '(대상 경로 0)' }] })),
      pod('2026-09-28T23:00:00Z', payload('run-gggggg77-7777', [{ kind: 'open-pr', name: '#9' }])),
    ];
    const prs = [first(1, 'x'), first(2, 'y'), first(5, 'd'),
      { number: 100, title: 'a', branch: 'self-impl/goalid-aa-src-a-ts-1234abcd-raaaaaa', labels: [], createdAt: '2026-09-29T02:30:00Z', mergedAt: '2026-09-29T05:00:00Z' },
      { number: 101, title: 'b', branch: 'self-impl/goalid-bb-src-a-ts-2345bcde-rbbbbbb', labels: ['elanous:idea-approval'], createdAt: '2026-09-29T04:30:00Z', mergedAt: '2026-09-29T08:00:00Z' },
      { number: 103, title: 'd', branch: 'self-impl/d-5555eeee', labels: [], createdAt: '2026-09-29T09:30:00Z', mergedAt: '2026-09-29T10:30:00Z' }];
    expect(await collectOverlapMetrics('owner/repo', overlapAdapters(rows, prs), now)).toEqual({
      launches24h: 4, launched: 6, unmeasured: 1, sourceIncomplete: false,
      linked: 3, autoLanded: 2, autoRate: 2 / 3, secondSiblingMedianHours: 3, salvaged: 0, salvageUnmeasured: 0,
    });
  });

  it('says «source incomplete» instead of zero for unreadable, empty or unparsable sources', async () => {
    const incomplete = { launches24h: null, launched: null, unmeasured: null, sourceIncomplete: true, ...none };
    expect(await collectOverlapMetrics('owner/repo', overlapAdapters(null, []), now)).toEqual(incomplete);
    expect(await collectOverlapMetrics('owner/repo', overlapAdapters([], []), now)).toEqual(incomplete);
    const good = pod('2026-09-29T02:00:00Z', payload('run-aaaaaa11', [{ kind: 'open-pr', name: '#1' }]));
    for (const bad of [pod('2026-09-29T03:00:00Z', '{"warnings": ['), { ts: 'not a time', data: payload('run-b', []) },
      pod('2026-09-29T03:00:00Z', { runId: 'run-no-arrays' })]) {
      expect(await collectOverlapMetrics('owner/repo', overlapAdapters([good, bad], []), now)).toEqual(incomplete);
    }
  });

  it('keeps counts but leaves landing unmeasured when nothing links or GitHub fails', async () => {
    const clean = [pod('2026-09-29T08:00:00Z', payload('run-aaaaaa11', [{ kind: 'recent-change', name: 'src/a.ts' }]))];
    expect(await collectOverlapMetrics('owner/repo', overlapAdapters(clean, []), now)).toEqual({
      launches24h: 0, launched: 1, unmeasured: 0, sourceIncomplete: false, linked: 0, autoLanded: 0, autoRate: null, secondSiblingMedianHours: null,
      salvaged: 0, salvageUnmeasured: 0,
    });
    const liveOnly = [{ ts: '2026-09-29T08:00:00Z', data: payload(null, [{ kind: 'live-run', name: 'run-x' }]) }];
    expect(await collectOverlapMetrics('owner/repo', overlapAdapters(liveOnly, []), now)).toEqual({ launches24h: 1, launched: 1, unmeasured: 0, sourceIncomplete: false, ...none });
    const named = [pod('2026-09-29T08:00:00Z', payload('run-aaaaaa11', [{ kind: 'open-pr', name: '#7' }]))];
    const failing = { ...overlapAdapters(named, [first(7, 'e')]), listRecentClosed: async () => { throw new Error('GitHub 502'); } };
    expect(await collectOverlapMetrics('owner/repo', failing, now)).toEqual({ launches24h: 1, launched: 1, unmeasured: 0, sourceIncomplete: false, ...none });
  });
});

describe('overlap metrics — DRAFT-NOT-ARCHIVE salvage siblings', () => {
  const payload = (runId: string | null, warnings: Array<{ kind: string; name: string }>) => ({
    goalFile: 'docs/goals/GOAL-src-a-ts.md', paths: ['src/a.ts'], blockers: [], warnings,
    openPrs: { state: 'checked', count: 41 }, liveRuns: { state: 'checked', count: 0 }, bypassed: false, ...(runId ? { runId } : {}),
  });
  // Shaped like orchestrator `observe('salvaged', { ...stopCard, salvageBranch }, { category: 'self-implement.draft-not-archive' })`.
  const salvagedEvent = (runId: string, branch: string, salvageBranch: string) => ({
    stage: 'abandoned', mode: 'needs-owner-only', stopClass: 'harvestable', classification: 'implementation-deficit',
    reason: 'gate red', nextMove: '수확 가지에서 이어 받는다', branch, salvageBranch, prBodyArtifactPath: '/tmp/body.md', runId,
  });
  const pod = (ts: string, data: Record<string, unknown>): OverlapPreflightRow =>
    ({ ts, data: { origin: 'pod', podJob: 'si-task-02a19f3aba1d-67b8d2dd', originalData: JSON.stringify(data) } });
  const adapters = (salvaged: readonly OverlapPreflightRow[] | null, prs: SweepMergedPr[]): OverlapMetricAdapters => ({
    listPreflightRows: async () => [
      // A: own run, no PR of its own — only a salvage branch.
      pod('2026-09-29T02:00:00Z', payload('run-aaaaaa11-1111', [{ kind: 'open-pr', name: '#1' }])),
      // B: sibling lineage `d`; its salvage branch later landed through a PR.
      { ts: '2026-09-29T04:00:00Z', data: payload(null, [{ kind: 'sibling-pr', name: '#5' }]) },
      // C: its only salvage event predates the launch — not its sibling.
      pod('2026-09-29T06:00:00Z', payload('run-cccccc33-3333', [{ kind: 'open-pr', name: '#1' }])),
    ],
    listSalvagedRows: async () => salvaged,
    listDrafts: async () => [],
    listRecentClosed: async () => prs.filter((pr) => pr.number >= 100),
    getPr: async (_repo, number) => prs.find((pr) => pr.number === number),
  });
  const firsts: SweepMergedPr[] = [
    { number: 1, title: 'x', branch: 'self-impl/x-1111aaaa', labels: [], createdAt: '2026-09-28T00:00:00Z' },
    { number: 5, title: 'd', branch: 'self-impl/d-1111aaaa', labels: [], createdAt: '2026-09-28T00:00:00Z' },
  ];
  const rowsA = pod('2026-09-29T03:00:00Z', salvagedEvent('run-aaaaaa11-1111', 'self-impl/goalid-aa-src-a-ts-1234abcd-raaaaaa',
    'salvage/run-aaaaaa/self-impl-goalid-aa-src-a-ts-1234abcd-raaaaaa'));
  const rowsB = { ts: '2026-09-29T05:00:00Z', data: salvagedEvent('run-123456ab', 'self-impl/d-9999ffff-r123456', 'salvage/run-123456/self-impl-d-9999ffff-r123456') };
  const rowsC = pod('2026-09-29T05:30:00Z', salvagedEvent('run-cccccc33-3333', 'self-impl/c-2222bbbb-rcccccc', 'salvage/run-cccccc/self-impl-c-2222bbbb-rcccccc'));
  const landedB: SweepMergedPr = { number: 104, title: 'd', branch: 'salvage/run-123456/self-impl-d-9999ffff-r123456', labels: [],
    createdAt: '2026-09-29T06:00:00Z', mergedAt: '2026-09-29T07:00:00Z' };

  it('links a salvage-only sibling as «salvaged — not landed», and a later PR from that branch through its merge', async () => {
    expect(await collectOverlapMetrics('owner/repo', adapters([rowsA, rowsB, rowsC], [...firsts, landedB]), now)).toEqual({
      launches24h: 3, launched: 3, unmeasured: 0, sourceIncomplete: false,
      linked: 2, autoLanded: 1, autoRate: 0.5, secondSiblingMedianHours: 3, salvaged: 1, salvageUnmeasured: 0,
    });
    // Before B's salvage branch got a PR: both siblings salvaged, neither auto-landed.
    expect(await collectOverlapMetrics('owner/repo', adapters([rowsA, rowsB, rowsC], firsts), now)).toMatchObject({
      linked: 2, autoLanded: 0, autoRate: 0, secondSiblingMedianHours: null, salvaged: 2, salvageUnmeasured: 0,
    });
  });

  it('counts launches with no PR sibling as unmeasured when the salvage source is unreadable, absent or unparsable', async () => {
    const unmeasured = { linked: 0, autoLanded: 0, autoRate: null, salvaged: null, salvageUnmeasured: 3 };
    expect(await collectOverlapMetrics('owner/repo', adapters(null, firsts), now)).toMatchObject(unmeasured);
    const { listSalvagedRows: _drop, ...absent } = adapters([], firsts);
    expect(await collectOverlapMetrics('owner/repo', absent, now)).toMatchObject(unmeasured);
    const throwing = { ...adapters([], firsts), listSalvagedRows: async () => { throw new Error('logs.db locked'); } };
    expect(await collectOverlapMetrics('owner/repo', throwing, now)).toMatchObject(unmeasured);
    const broken = pod('2026-09-29T03:00:00Z', { stage: 'abandoned', runId: 'run-aaaaaa11' });
    expect(await collectOverlapMetrics('owner/repo', adapters([rowsA, broken], firsts), now)).toMatchObject(unmeasured);
    // A PR-found sibling never needs the salvage source.
    expect(await collectOverlapMetrics('owner/repo', adapters(null, [...firsts, { ...landedB, branch: 'self-impl/d-9999ffff-r123456' }]), now))
      .toMatchObject({ linked: 1, autoLanded: 1, salvaged: null, salvageUnmeasured: 2 });
  });

  it('countSalvagedToday: distinct salvage branches since the day start; unreadable or unparsable gives null, not 0', () => {
    const dayStart = new Date('2026-09-29T03:00:00Z');
    expect(countSalvagedToday([rowsA, { ...rowsA }, rowsB, rowsC, pod('2026-09-29T02:59:59Z', salvagedEvent('run-dddddd', 'b', 'salvage/run-dddddd/b'))], dayStart, now)).toBe(3);
    expect(countSalvagedToday([], dayStart, now)).toBe(0);
    expect(countSalvagedToday(null, dayStart, now)).toBeNull();
    expect(countSalvagedToday([rowsA, { ts: 'not a time', data: rowsA.data }], dayStart, now)).toBeNull();
    expect(countSalvagedToday([{ ts: '2026-09-29T04:00:00Z', data: { origin: 'pod', originalData: '{"salvageBranch": ' } }], dayStart, now)).toBeNull();
  });
});

describe('runDraftSweep', () => {
  it('reports three evidence-backed actions from an isolated fake gh inventory as JSON rows and action counts', async () => {
    const body = '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-abcd12';
    const rows = [
      draft(801, { labels: ['elanous:from-ux', 'elanous:harvestable'], body, latestCommitAt: '2026-09-28T00:00:00Z' }),
      draft(802, { labels: ['elanous:from-ux'], body, latestCommitAt: '2026-09-28T00:00:00Z' }),
      draft(803, { labels: [], body: '', latestCommitAt: undefined }),
    ];
    const fakeGh = make(rows, [{ number: 900, title: 'replacement', branch: 'replacement/900',
      body: `${body}\nSupersedes: #802`, mergedAt: '2026-09-29T00:00:00Z' }]);
    fakeGh.statuses.set(801, 'completed');
    fakeGh.statuses.set(802, 'completed');
    fakeGh.adapters.getReviewGate = async (pr) => pr.number === 801
      ? { gate: 'pass', review: 'pass', triageReview: 'approved' } : undefined;
    fakeGh.adapters.listPrTerminals = async () => [{ childRunId: 'run-802', prNumber: 802,
      prUrl: null, repository: 'owner/repo', headSha: null, terminalClass: 'failed-with-pr',
      stage: 'review-blocked', owner: 'UX', ownerSource: 'seat', card: 'DRAFT-TRIAGE-ANYTIME',
      at: '2026-09-29T12:00:00Z', hostRegateFailure: null },
    { childRunId: 'run-802-later', prNumber: 802, prUrl: null, repository: 'owner/repo', headSha: null,
      terminalClass: 'merge-ready-not-merged', stage: 'gate-passed', owner: 'UX', ownerSource: 'seat',
      card: 'DRAFT-TRIAGE-ANYTIME', at: '2026-09-29T13:00:00Z', hostRegateFailure: null }];
    const json = JSON.parse(JSON.stringify(await runDraftSweep({ repository: 'owner/repo', adapters: fakeGh.adapters,
      now, includeTriage: true, apply: false })));
    expect(json.complete).toBe(true);
    expect(json.triage.counts).toEqual({ harvest: 1, 'close-b': 1, human: 1 });
    const [harvest, close, unknown] = json.triage.entries.map((entry: { assessment: unknown }) => entry.assessment);
    expect(harvest).toMatchObject({ origin: 'elanous:from-ux', cellId: 'DRAFT-TRIAGE-ANYTIME',
      gate: 'pass', review: 'approved', nextAction: 'harvest' });
    expect(harvest.evidence).toEqual(expect.arrayContaining([expect.stringContaining('gate=pass'), expect.stringContaining('latest exact-head review=approved')]));
    expect(close).toMatchObject({ nextAction: 'close-b', lastFailureTail: 'review-blocked',
      checks: { 'replacement-landed': { state: 'yes' } } });
    expect(close.evidence).toEqual(expect.arrayContaining([expect.stringContaining('Supersedes: #802'), 'last failure: review-blocked']));
    expect(close.evidence).not.toContain('last failure: gate-passed');
    expect(harvest.lastFailureTail).toBeNull();
    expect(unknown).toMatchObject({ origin: null, cellStatus: 'unknown', nextAction: 'human' });
    expect(unknown.missingEvidence).toContain('provenance');
    expect(fakeGh.calls.filter((call) => /^(close|label):/.test(call))).toEqual([]);
  });
  it('keeps the release-path hold across three draft JSON rows, later nonfailure terminal and apply writes', async () => {
    const body = '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-abcd12';
    const rows = [
      draft(801, { labels: ['elanous:from-ux', 'elanous:harvestable'], body,
        updatedAt: '2026-09-29T23:00:00Z', latestCommitAt: '2026-09-28T00:00:00Z' }),
      draft(802, { labels: ['elanous:from-ux', RELEASE_PATH_LABEL], body,
        latestCommitAt: '2026-09-28T00:00:00Z' }),
      draft(803, { labels: [keep], body: '', latestCommitAt: undefined }),
    ];
    const fakeGh = make(rows, [{ number: 900, title: 'replacement', branch: 'replacement/900',
      body: `${body}\nSupersedes: #802`, mergedAt: '2026-09-29T00:00:00Z' }]);
    fakeGh.statuses.set(801, 'completed');
    fakeGh.statuses.set(802, 'completed');
    fakeGh.adapters.listTaskCards = async () => [{ id: 'ta-20261021-abcd12', text: 'draft', seat: 'UX',
      status: 'launched', completion: 'code-pr', createdAt: now.toISOString(), history: [],
      runId: 'run-protected', pr: { number: 802 } }];
    fakeGh.adapters.commentDraft = async (_repo, number) => { fakeGh.calls.push(`comment:${number}`); };
    fakeGh.adapters.getActiveClaimOwner = async () => undefined;
    fakeGh.adapters.getActiveClaimRunId = async () => undefined;
    fakeGh.adapters.getLastClaimReleaseAt = async () => undefined;
    fakeGh.adapters.getReviewGate = async (pr) => pr.number === 801
      ? { gate: 'pass', review: 'pass', triageReview: 'approved' } : undefined;
    fakeGh.adapters.listPrTerminals = async () => [
      { childRunId: 'run-802', prNumber: 802, prUrl: null, repository: 'owner/repo', headSha: null,
        terminalClass: 'failed-with-pr', stage: 'review-blocked', owner: 'UX', ownerSource: 'seat',
        card: 'DRAFT-TRIAGE-ANYTIME', at: '2026-09-29T12:00:00Z', hostRegateFailure: null },
      { childRunId: 'run-802-later', prNumber: 802, prUrl: null, repository: 'owner/repo', headSha: null,
        terminalClass: 'merge-ready-not-merged', stage: 'gate-passed', owner: 'UX', ownerSource: 'seat',
        card: 'DRAFT-TRIAGE-ANYTIME', at: '2026-09-29T13:00:00Z', hostRegateFailure: null },
    ];
    const json = JSON.parse(JSON.stringify(await runDraftSweep({ repository: 'owner/repo', adapters: fakeGh.adapters,
      now, includeTriage: true, apply: true })));
    const rowsJson = json.triage.entries.map(({ number, assessment }: { number: number; assessment: {
      origin: string | null; lastFailureTail: string | null; cellStatus: string;
      nextAction: string; missingEvidence: string[];
    } }) => ({ number, origin: assessment.origin, lastFailureTail: assessment.lastFailureTail,
      cellStatus: assessment.cellStatus, nextAction: assessment.nextAction, missingEvidence: assessment.missingEvidence }));
    expect(rowsJson).toEqual([
      { number: 801, origin: 'elanous:from-ux', lastFailureTail: null, cellStatus: 'unknown',
        nextAction: 'harvest', missingEvidence: ['cell-complete', 'cell-status-repository-bound', 'replacement-landed'] },
      { number: 802, origin: 'elanous:from-ux', lastFailureTail: 'review-blocked', cellStatus: 'unknown',
        nextAction: 'human', missingEvidence: ['gate', 'review', 'cell-complete', 'cell-status-repository-bound'] },
      { number: 803, origin: null, lastFailureTail: null, cellStatus: 'unknown',
        nextAction: 'human', missingEvidence: ['provenance', 'gate', 'review', 'cell-complete', 'cell-status-repository-bound', 'replacement-landed', 'newer-same-card', 'idle-48h', 'recent-commit', 'running'] },
    ]);
    expect(json.triage.entries[1].assessment.evidence).toContain('last failure: review-blocked');
    expect(json.triage.entries[1].assessment.checks['replacement-landed'].state).toBe('yes');
    expect(json.triage.entries[1].assessment.checks.protected).toEqual({ state: 'yes', evidence: `보호 표지=${RELEASE_PATH_LABEL}` });
    expect(json.triage.counts).toEqual({ harvest: 1, human: 2 });
    expect(fakeGh.calls.filter((call) => /^(close|label):/.test(call))).toEqual([`label:801:=>${stalled}`]);
    expect(fakeGh.calls.filter((call) => call.startsWith('close:') || call.startsWith('comment:'))).toEqual([]);
    expect(json.entries.find((entry: { number: number }) => entry.number === 802)).toMatchObject({
      action: 'keep', reason: `label:${RELEASE_PATH_LABEL}`, applied: false,
    });
  });

  it('uses the most recent failure for the exact PR, ignoring newer nonfailure and unrelated PR records', async () => {
    const row = draft(804, { labels: ['elanous:from-ux'], body: '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-abcd12' });
    const fixture = make([row]);
    const terminal = (prNumber: number, terminalClass: PrTerminalRecord['terminalClass'], stage: string, at: string): PrTerminalRecord => ({
      childRunId: `run-${prNumber}-${stage}`, prNumber, prUrl: null, repository: 'owner/repo', headSha: null,
      terminalClass, stage, at, owner: 'UX', ownerSource: 'seat', card: null, hostRegateFailure: null,
    });
    fixture.adapters.listPrTerminals = async () => [
      terminal(804, 'failed-with-pr', 'older-failure', '2026-09-28T09:00:00Z'),
      terminal(804, 'failed-with-pr', 'latest-failure', '2026-09-29T09:00:00Z'),
      terminal(805, 'failed-with-pr', 'other-pr-failure', '2026-09-29T11:00:00Z'),
      terminal(804, 'landed', 'later-success', '2026-09-29T12:00:00Z'),
    ];
    const assessment = (await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, now,
      includeTriage: true })).triage?.entries[0]?.assessment;
    expect(assessment?.lastFailureTail).toBe('latest-failure');
    expect(assessment?.evidence).toContain('last failure: latest-failure');
    fixture.adapters.listPrTerminals = async () => [
      { ...terminal(804, 'failed-with-pr', 'regate', '2026-09-29T10:00:00Z'),
        hostRegateFailure: { step: 'typecheck', detail: 'typecheck failed', os: 'linux' } },
      terminal(804, 'merge-ready-not-merged', 'only-success', '2026-09-29T12:00:00Z'),
    ];
    const regate = (await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, now,
      includeTriage: true })).triage?.entries[0]?.assessment;
    expect(regate?.lastFailureTail).toBe('typecheck failed');
    fixture.adapters.listPrTerminals = async () => [terminal(804, 'merge-ready-not-merged', 'only-success', '2026-09-29T12:00:00Z')];
    const noFailure = (await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, now,
      includeTriage: true })).triage?.entries[0]?.assessment;
    expect(noFailure?.lastFailureTail).toBeNull();
    expect(noFailure?.evidence.some((item) => item.startsWith('last failure:'))).toBe(false);
  });

  it('returns partial dry-run decisions with an explicit inventory-cap reason and never applies a capped inventory', async () => {
    const fixture = make([draft(590), draft(591)]);
    const boundedAdapters = fixture.adapters as DraftSweepAdapters & {
      inventoryStatus: () => Promise<{ complete: boolean; reason?: string }>;
    };
    boundedAdapters.inventoryStatus = async () => ({ complete: false, reason: 'draft inventory capped at 1 page' });

    const preview = await runDraftSweep({ repository: 'owner/repo', adapters: boundedAdapters, now });
    expect(preview.complete).toBe(false);
    expect(preview.error).toBe('draft inventory capped at 1 page');
    expect(preview.entries.map((entry) => entry.number)).toEqual([590, 591]);

    fixture.calls.length = 0;
    const applied = await runDraftSweep({ repository: 'owner/repo', adapters: boundedAdapters, now, apply: true });
    expect(applied.complete).toBe(false);
    expect(applied.error).toBe('draft inventory capped at 1 page');
    expect(fixture.calls.some((call) => call.startsWith('label:') || call.startsWith('close:'))).toBe(false);
  });

  it('bounds active-claim owner lookups during explicit triage', async () => {
    const rows = Array.from({ length: DRAFT_SWEEP_CONCURRENCY * 2 }, (_, index) => draft(600 + index));
    const fixture = make(rows);
    fixture.adapters.listTaskCards = async () => [];
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    fixture.adapters.getActiveClaimOwner = async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return undefined;
    };
    await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, now, includeTriage: true });
    expect(calls).toBe(rows.length);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(DRAFT_SWEEP_CONCURRENCY);
  });

  it('reports newer same-card evidence without recommending close-b', async () => {
    const provenance = { labels: ['elanous:from-ux'], body: '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-abcd12',
      latestCommitAt: '2026-09-28T00:00:00Z' };
    const harvestPosture = draft(501, { ...provenance, body: '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-zzzz99' });
    const oldTwin = draft(502, provenance);
    const newerTwin = draft(503, { ...provenance, createdAt: '2026-09-29T00:00:00Z' });
    const noEvidence = draft(504, { labels: [], body: '' });
    const fixture = make([harvestPosture, oldTwin, newerTwin, noEvidence]);
    const writes: string[] = [];
    fixture.statuses.set(502, 'completed');
    fixture.adapters.getReviewGate = async () => ({ gate: 'pass', review: 'pass', triageReview: 'approved' });
    fixture.adapters.listTaskCards = async () => [];
    fixture.adapters.setLabels = async (_repo, number) => { writes.push(`label:${number}`); };
    fixture.adapters.closeDraft = async (_repo, number) => { writes.push(`close:${number}`); };
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, now,
      includeTriage: true, apply: false });
    expect(result.triage?.entries.map(({ number, assessment }) => [number, assessment.nextAction])).toEqual([
      [501, 'human'], [502, 'human'], [503, 'human'], [504, 'human'],
    ]);
    expect(result.triage?.counts).toEqual({ human: 4 });
    expect(result.triage?.entries[0]?.assessment).toMatchObject({ gate: 'pass', review: 'approved' });
    expect(result.triage?.entries.find(({ number }) => number === 502)?.assessment.checks['newer-same-card'].state).toBe('yes');
    expect(result.triage?.entries.find(({ number }) => number === 504)?.assessment.checks.provenance.state).toBe('unknown');
    expect(writes).toEqual([]);
  });

  it('keeps newer same-card unknown when a newer candidate lacks provenance', async () => {
    const known = { labels: ['elanous:from-ux'], body: '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-abcd12',
      latestCommitAt: '2026-09-28T00:00:00Z', createdAt: '2026-09-28T00:00:00Z' };
    const target = draft(510, known);
    const missingProvenance = draft(511, { labels: [], body: '', createdAt: '2026-09-29T00:00:00Z' });
    const fixture = make([target, missingProvenance]);
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, now, includeTriage: true });
    const assessment = result.triage?.entries.find(({ number }) => number === 510)?.assessment;
    expect(assessment?.checks['newer-same-card'].state).toBe('unknown');
  });

  it('allows close-c for self-implement.result final through the full sweep path', async () => {
    const target = draft(513, { labels: ['elanous:from-ux'], body: '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-abcd12',
      createdAt: '2026-09-28T00:00:00Z', latestCommitAt: '2026-09-28T00:00:00Z' });
    const fixture = make([target]);
    fixture.statuses.set(513, 'self-implement.result final');
    fixture.adapters.listTaskCards = async () => [{ id: 'ta-20261021-abcd12', text: 'draft', seat: 'UX', status: 'launched',
      completion: 'code-pr', createdAt: now.toISOString(), history: [], runId: 'run-513', pr: { number: 513 } }];
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, now, includeTriage: true });
    expect(result.triage?.entries[0]?.assessment).toMatchObject({ nextAction: 'close-c', checks: { running: { state: 'no' } } });
  });

  it('fetches missing head timestamps only for explicit triage', async () => {
    const target = draft(509, { labels: ['elanous:from-ux'], body: '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-abcd12' });
    const fixture = make([target]);
    let headTimeCalls = 0;
    fixture.adapters.getHeadCommitTime = async () => { headTimeCalls++; return '2026-10-18T00:00:00Z'; };
    await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, now });
    expect(headTimeCalls).toBe(0);
    await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, now, includeTriage: true });
    expect(headTimeCalls).toBe(1);
  });

  it('keeps gate and review observable while harvest stays out of recommendation scope', async () => {
    const target = draft(507, { labels: ['elanous:from-ux'], body: '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-abcd12',
      latestCommitAt: '2026-09-28T00:00:00Z' });
    const fixture = make([target]);
    fixture.adapters.getReviewGate = async () => ({ gate: 'pass', review: 'pass', triageReview: 'dismissed' });
    fixture.adapters.listTaskCards = async () => [];
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, now, includeTriage: true });
    expect(result.triage?.entries[0]?.assessment).toMatchObject({ nextAction: 'human', gate: 'pass', review: 'dismissed' });
  });

  it('keeps cell state unknown without repository-bound evidence and does not infer relaunch from draft observations', async () => {
    const row = draft(505, { labels: ['elanous:from-ux'], body: '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-abcd12',
      changedFiles: [], latestCommitAt: '2026-09-28T00:00:00Z' });
    const terminalOnly = draft(506, { labels: ['elanous:from-ux'], body: '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-efgh34',
      changedFiles: [], latestCommitAt: '2026-09-28T00:00:00Z' });
    const fixture = make([row, terminalOnly]);
    fixture.adapters.listTaskCards = async () => [{ id: 'ta-20261021-abcd12', text: 'draft', seat: 'UX', status: 'failed',
      createdAt: now.toISOString(), history: [{ at: now.toISOString(), event: 'failed', runId: 'run-fail', detail: 'UNCONVERGEABLE' }] }];
    fixture.adapters.listPrTerminals = async () => [{ childRunId: 'run-terminal-fail', prNumber: 506,
      prUrl: 'https://github.com/owner/repo/pull/506', repository: 'owner/repo', headSha: null, terminalClass: 'failed-with-pr',
      stage: 'goal-revision-required', owner: 'UX', ownerSource: 'seat', card: 'DRAFT-TRIAGE-ANYTIME', at: now.toISOString(),
      hostRegateFailure: null }];
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, now, includeTriage: true });
    const assessment = result.triage?.entries.find((entry) => entry.number === 505)?.assessment;
    expect(assessment?.nextAction).toBe('human');
    expect(assessment?.cellStatus).toBe('unknown');
    expect(assessment?.checks['cell-complete'].state).toBe('unknown');
    expect(assessment?.nextAction).toBe('human');
    expect(assessment?.evidence).toContain('PrTerminalRecord: cell=DRAFT-TRIAGE-ANYTIME matched=0');
    const terminalAssessment = result.triage?.entries.find((entry) => entry.number === 506)?.assessment;
    expect(terminalAssessment?.nextAction).toBe('human');
    expect(terminalAssessment?.checks['owner-confirmed'].state).toBe('unknown');
    expect(terminalAssessment?.evidence).toContain('PrTerminalRecord: cell=DRAFT-TRIAGE-ANYTIME matched=1');
    expect(fixture.calls.filter((call) => call.startsWith('close:') || call.startsWith('label:'))).toEqual([]);
  });

  it('does not apply another PR terminal in the same cell to this draft', async () => {
    const row = draft(508, { labels: ['elanous:from-ux'], body: '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-abcd12',
      latestCommitAt: '2026-09-28T00:00:00Z' });
    const fixture = make([row]);
    fixture.adapters.listTaskCards = async () => [];
    fixture.adapters.listPrTerminals = async () => [
      { childRunId: 'run-cross-repo-same-pr', prNumber: 508, prUrl: 'https://github.com/other/repo/pull/508',
        repository: 'other/repo', headSha: null, terminalClass: 'failed-with-pr', stage: 'goal-revision-required',
        owner: 'UX', ownerSource: 'seat', card: 'DRAFT-TRIAGE-ANYTIME', at: now.toISOString(), hostRegateFailure: null },
      { childRunId: 'run-other-pr-failed', prNumber: 509, prUrl: 'https://github.com/owner/repo/pull/509',
        repository: 'owner/repo', headSha: null, terminalClass: 'failed-with-pr', stage: 'goal-revision-required',
        owner: 'UX', ownerSource: 'seat', card: 'DRAFT-TRIAGE-ANYTIME', at: now.toISOString(), hostRegateFailure: null },
    ];
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, now, includeTriage: true });
    expect(result.triage?.entries[0]?.assessment.nextAction).not.toBe('reauthor');
    expect(result.triage?.entries[0]?.assessment.evidence).toContain('PrTerminalRecord: cell=DRAFT-TRIAGE-ANYTIME matched=0');
  });

  it('triage owner lookup survives an unreadable card inventory instead of rejecting the sweep', async () => {
    const row = draft(512, { labels: ['elanous:from-ux'], body: '칸: DRAFT-TRIAGE-ANYTIME', latestCommitAt: '2026-09-28T00:00:00Z' });
    const fixture = make([row]);
    fixture.adapters.listTaskCards = async () => undefined;
    const looked: number[] = [];
    fixture.adapters.getActiveClaimOwner = async (_repo, number) => { looked.push(number); return undefined; };
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, now, includeTriage: true });
    expect(result.triage?.entries.map(({ number }) => number)).toContain(512);
    expect(looked).toEqual([512]);
  });

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
        `label:1:${stalled}=>${superseded}`, 'close:1',
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
      `label:1:${running}=>${superseded}`, 'close:1',
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
      'close:1',
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
      `label:1:${running}=>${stalled}`, expect.stringContaining('close:1'),
      `label:2:${stalled}=>${superseded}`, 'close:2',
    ]);
  });

  it('leaves a bench arm draft (elanous:bench) alone: no stalled close, no label write', async () => {
    const bench = 'elanous:bench';
    const old = new Date(now.getTime() - (STALLED_DRAFT_HOURS + 1) * 3_600_000).toISOString();
    const fixture = make([draft(1, { labels: [stalled], createdAt: old }),
      draft(2, { labels: [stalled, bench], branch: 'bench/x/glm-abc123', createdAt: old })]);
    const result = await sweep(fixture.adapters, true);
    expect(result.entries.map(({ number, action }) => [number, action])).toEqual([[1, 'close'], [2, 'keep']]);
    expect(fixture.calls.some((call) => call.startsWith('label:2:') || call.startsWith('close:2:'))).toBe(false);
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
        applied: false, partialApplied: true, error: 'Error: close denied #2' },
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
    expect(fixture.sweptLabels).toContain('1:elanous:swept:stale-unobserved');
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
      expect.stringContaining('close:12'),
    ]);
    expect(fixture.sweptLabels).toContain('12:elanous:swept:claim-expired');
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
      `label:41:${running}=>${superseded}`, 'close:41',
      `label:42:${running}=>${superseded}`, 'close:42',
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
    expect(fixture.calls.filter((call) => call.startsWith('close:'))).toEqual(['close:36']);
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
  it('closes already made by the pod-terminal replay count against the same tick cap (review must-fix)', async () => {
    const drafts = Array.from({ length: 5 }, (_, i) => draft(300 + i, { updatedAt: idle(72) }));
    const fixture = make(drafts);
    for (const pr of drafts) fixture.statuses.set(pr.number, undefined);
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, apply: true, now, closeCap: 3, closeCapSource: 'flag', alreadyClosed: 2 });
    expect(fixture.calls.filter((call) => call.startsWith('close:'))).toHaveLength(1);
    expect(result.closed).toBe(1);
  });

  it('close cap: default stays 10; config 30 lets 30 closes through in one tick; flag overrides config; invalid falls back to 10', async () => {
    expect(DRAFT_SWEEP_CLOSE_CAP).toBe(10);
    expect(resolveDraftSweepCloseCap({})).toEqual({ closeCap: 10, closeCapSource: 'default', warnings: [] });
    const fromConfig = resolveDraftSweepCloseCap({ config: 30 });
    expect(fromConfig).toEqual({ closeCap: 30, closeCapSource: 'config', warnings: [] });
    expect(resolveDraftSweepCloseCap({ flag: '7', config: 30 })).toEqual({ closeCap: 7, closeCapSource: 'flag', warnings: [] });
    for (const bad of [0, 101, 2.5, -3, 'thirty', '']) {
      const resolved = resolveDraftSweepCloseCap({ config: bad });
      expect(resolved).toMatchObject({ closeCap: 10, closeCapSource: 'default' });
      expect(resolved.warnings).toHaveLength(1);
    }
    // An invalid flag is rejected with a warning and falls through to config.
    expect(resolveDraftSweepCloseCap({ flag: '0', config: 30 })).toMatchObject({ closeCap: 30, closeCapSource: 'config' });

    const drafts = Array.from({ length: 35 }, (_, i) => draft(400 + i, { updatedAt: idle(72) }));
    const fixture = make(drafts);
    for (const pr of drafts) fixture.statuses.set(pr.number, undefined);
    const logs: unknown[][] = [];
    const spy = spyOn(debug, 'log').mockImplementation((...args: unknown[]) => { logs.push(args); });
    try {
      const result = await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, apply: true, now, ...fromConfig });
      expect(result.closed).toBe(30);
      expect(fixture.calls.filter((call) => call.startsWith('close:'))).toHaveLength(30);
      expect(result.entries.filter((entry) => entry.reason === 'close-cap')).toHaveLength(5);
      expect(result).toMatchObject({ closeCap: 30, closeCapSource: 'config' });
      expect(logs).toContainEqual(['self-dev.draft-sweep', 'timing', expect.objectContaining({ phase: 'total', closeCap: 30, closeCapSource: 'config' })]);
    } finally { spy.mockRestore(); }
    // A cap that bypassed the resolver is still bounded: invalid ⇒ default 10.
    const again = make(drafts);
    for (const pr of drafts) again.statuses.set(pr.number, undefined);
    const fallback = await runDraftSweep({ repository: 'owner/repo', adapters: again.adapters, apply: true, now, closeCap: 1000, closeCapSource: 'config' });
    expect(fallback).toMatchObject({ closed: 10, closeCap: 10, closeCapSource: 'default' });
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

describe('runDraftSweep — lineage key (forceRequeue duplicates)', () => {
  const fresh = '2026-09-29T23:30:00Z';
  const older = (options: Partial<SweepDraft> = {}) => draft(1, {
    title: 'old attempt', branch: 'self-impl/goalid-abc-foo-11111111-raaaaaa', createdAt: '2026-09-29T22:00:00Z', updatedAt: fresh, ...options,
  });
  const newer = (options: Partial<SweepDraft> = {}) => draft(2, {
    title: 'requeued attempt', branch: 'self-impl/goalid-abc-bar-22222222-rbbbbbb', createdAt: '2026-09-29T23:00:00Z', updatedAt: fresh, ...options,
  });
  const mutations = (calls: string[]) => calls.filter((call) => /^(label|close|stop):/.test(call));

  it('forceRequeue duplicate run is superseded by lineage key', async () => {
    const fixture = make([older(), newer()]);
    fixture.statuses.set(1, 'running');
    fixture.setLive(new Set([older().branch, newer().branch]));
    fixture.adapters.supersedeRun = async (pr, _repo, by) => { fixture.calls.push(`stop:${pr.number}:${by.number}`); };
    const result = await sweep(fixture.adapters, true);
    expect(result.entries[0]).toMatchObject({ number: 1, action: 'close', reason: 'duplicate-of-open #2 (lineage goalid:abc) · stop run run-1', statusLabel: superseded, applied: true });
    expect(result.entries[1]).toMatchObject({ number: 2, action: 'keep' });
    expect(mutations(fixture.calls)).toEqual([
      'stop:1:2', `label:1:${running}=>${superseded}`,
      'close:1',
    ]);
  });

  it('freezes the exact successor identity required to stop a live duplicate run', async () => {
    const fixture = make([older({ headSha: 'a'.repeat(40) }), newer({ headSha: 'b'.repeat(40) })]);
    fixture.statuses.set(1, 'running');
    fixture.statuses.set(2, 'running');
    fixture.setLive(new Set([older().branch, newer().branch]));
    fixture.adapters.supersedeRun = async () => {};
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, includeApplyPlan: true, now });
    expect(result.applyPlan?.entries[0]).toMatchObject({ number: 1, runId: 'run-1', stopRunRequired: true,
      supersedeNewer: { number: 2, branch: newer().branch, runId: 'run-2' } });
  });

  it('never stops a live run when the newer same-lineage run is not live itself — the existing rules decide', async () => {
    const onlyOlderLive = (fixture: ReturnType<typeof make>) => { fixture.statuses.set(1, 'running'); fixture.setLive(new Set([older().branch])); };
    const baseline = await withoutLineage(onlyOlderLive);
    const fixture = make([older(), newer()]);
    onlyOlderLive(fixture);
    fixture.adapters.supersedeRun = async () => { fixture.calls.push('stop'); };
    const result = await sweep(fixture.adapters, true);
    expect(result.entries[0]).toEqual(baseline);
    expect(fixture.calls).not.toContain('stop');
  });

  // What the existing rules decide for the same older draft when no same-lineage rerun exists (the newer draft is another goal).
  const withoutLineage = async (configure: (fixture: ReturnType<typeof make>) => void) => {
    const plain = make([older(), newer({ branch: 'self-impl/goalid-other-bar-22222222-rbbbbbb' })]);
    configure(plain);
    return (await sweep(plain.adapters, true)).entries[0];
  };

  it('falls through to the existing rules when nothing can stop the live run, or when stopping fails (no lineage close, no cap spent)', async () => {
    const liveRun = (fixture: ReturnType<typeof make>) => { fixture.statuses.set(1, 'running'); fixture.setLive(new Set([older().branch, newer().branch])); };
    const baseline = await withoutLineage(liveRun);
    const live = make([older(), newer()]);
    liveRun(live);
    const kept = await sweep(live.adapters, true);
    expect(kept.entries[0]).toEqual(baseline);
    expect(kept.entries[0]?.reason).not.toContain('lineage');

    const failing = make([older(), newer()]);
    liveRun(failing);
    failing.adapters.supersedeRun = async () => { throw new Error('stop refused'); };
    const failed = await sweep(failing.adapters, true);
    expect(failed.entries[0]).toEqual(baseline);
    expect(failed.closed ?? 0).toBe(0);
  });

  it('closes an ended older draft without stopping anything, and previews without writing', async () => {
    const fixture = make([older(), newer()]);
    fixture.adapters.supersedeRun = async () => { fixture.calls.push('stop'); };
    const preview = await sweep(fixture.adapters);
    expect(preview.entries[0]).toMatchObject({ number: 1, action: 'close', applied: false });
    expect(mutations(fixture.calls)).toEqual([]);
    const applied = await sweep(fixture.adapters, true);
    expect(applied.entries[0]).toMatchObject({ number: 1, action: 'close', applied: true });
    expect(fixture.calls).not.toContain('stop');
  });

  it('fails the sweep before any close write when exact-head gate inventory is incomplete', async () => {
    const fixture = make([older(), newer()]);
    fixture.adapters.getReviewGate = async () => { throw new Error('check-run inventory incomplete: HTTP 403'); };
    const result = await runDraftSweep({ repository: 'owner/repo', adapters: fixture.adapters, apply: true, includeTriage: true, now });
    expect(result.error).toContain('check-run inventory incomplete');
    expect(mutations(fixture.calls)).toEqual([]);
  });

  it('leaves held drafts, other goals and branches without a goal id alone', async () => {
    const held = make([older({ labels: [keep] }), newer()]);
    expect((await sweep(held.adapters, true)).entries[0]).toMatchObject({ number: 1, action: 'keep', reason: `label:${keep}` });
    const other = make([older(), newer({ branch: 'self-impl/goalid-def-bar-22222222-rbbbbbb' })]);
    expect((await sweep(other.adapters)).entries[0]?.reason).not.toContain('lineage');
    const legacy = make([older({ branch: 'self-impl/foo-11111111-raaaaaa' }), newer({ branch: 'self-impl/foo-22222222-rbbbbbb' })]);
    expect((await sweep(legacy.adapters)).entries[0]?.reason).not.toContain('lineage');
    expect(mutations(held.calls)).toEqual([]);
  });

  // DRAFT-SWEEP-LINEAGE-HARVESTABLE (10-12): the lineage rule used to skip every harvestable draft.
  describe('harvestable drafts', () => {
    const harvestable = PR_LABELS.find((entry) => entry.name === 'elanous:harvestable')!.name;
    // Closes and superseded labels only — the pre-existing stalled marking of an ended run is not this rule's business.
    const supersedes = (calls: string[]) => calls.filter((call) => call.startsWith('close:') || call.endsWith(`=>${superseded}`));
    const withReviews = (postures: Record<number, SweepReviewGate | undefined>) => {
      const fixture = make([older({ labels: [harvestable] }), newer({ labels: [harvestable] })]);
      fixture.statuses.set(1, 'self-implement.result final');
      fixture.adapters.getReviewGate = async (pr) => postures[pr.number];
      return fixture;
    };

    it('a harvestable draft with a newer same-lineage PR is classified duplicate-of-open', async () => {
      const fixture = withReviews({ 1: {}, 2: {} });
      const log = spyOn(debug, 'log').mockImplementation(() => {});
      try {
        const result = await sweep(fixture.adapters, true);
        expect(result.entries[0]).toMatchObject({ number: 1, action: 'close', reason: 'duplicate-of-open #2 (lineage goalid:abc)', statusLabel: superseded, applied: true });
        expect(supersedes(fixture.calls)).toEqual([
          `label:1:=>${superseded}`,
          'close:1',
        ]);
        expect(result.lineage).toEqual({ closed: 1, harvestableClosed: 1, fallThrough: {} });
        expect(log).toHaveBeenCalledWith('self-dev.draft-sweep', 'lineage-summary', { closed: 1, harvestableClosed: 1, fallThrough: {}, apply: true });
      } finally { log.mockRestore(); }
    });

    it('closes an older review-pass draft when the newer one passed review too', async () => {
      const result = await sweep(withReviews({ 1: { review: 'pass', gate: 'pass' }, 2: { review: 'pass' } }).adapters);
      expect(result.entries[0]).toMatchObject({ number: 1, action: 'close', reason: 'duplicate-of-open #2 (lineage goalid:abc)' });
    });

    it('protects an older review-pass draft whose newer rerun has not passed review (falls through to the harvestable rule)', async () => {
      for (const newerPosture of [undefined, {}, { review: 'fail' as const }, { review: 'pass' as const, mustFix: true }]) {
        const fixture = withReviews({ 1: { review: 'pass', gate: 'pass' }, 2: newerPosture });
        const result = await sweep(fixture.adapters, true);
        expect(result.entries[0]).toMatchObject({ number: 1, action: 'keep', reason: 'harvestable' });
        expect(result.lineage).toEqual({ closed: 0, harvestableClosed: 0, fallThrough: { 'lineage-harvestable-review-pass-protected': 1 } });
        expect(supersedes(fixture.calls)).toEqual([]);
      }
    });

    it('keeps a harvestable draft whose review posture cannot be observed (fail-closed)', async () => {
      const absent = make([older({ labels: [harvestable] }), newer({ labels: [harvestable] })]);
      absent.statuses.set(1, 'self-implement.result final');
      const noAdapter = await sweep(absent.adapters, true);
      expect(noAdapter.entries[0]).toMatchObject({ number: 1, action: 'keep', reason: 'harvestable' });
      expect(noAdapter.lineage?.fallThrough).toEqual({ 'lineage-harvestable-review-unobserved': 1 });
      const unread = await sweep(withReviews({ 2: { review: 'pass' } }).adapters, true);
      expect(unread.entries[0]).toMatchObject({ number: 1, action: 'keep', reason: 'harvestable' });
      const throwing = withReviews({});
      throwing.adapters.getReviewGate = async () => { throw new Error('gh down'); };
      expect((await sweep(throwing.adapters, true)).entries[0]).toMatchObject({ number: 1, action: 'keep', reason: 'harvestable' });
    });

    it('still leaves held, bench and other-goal harvestable drafts alone, and spends the close cap', async () => {
      const bench = PR_LABELS.find((entry) => entry.name === 'elanous:bench')!.name;
      for (const extra of [keep, bench, RELEASE_PATH_LABEL]) {
        const held = make([older({ labels: [harvestable, extra] }), newer()]);
        held.adapters.getReviewGate = async () => ({});
        expect((await sweep(held.adapters, true)).entries[0]?.reason).toBe(`label:${extra}`);
        expect(supersedes(held.calls)).toEqual([]);
      }
      const other = withReviews({ 1: {}, 2: {} });
      const otherGoal = make([older({ labels: [harvestable] }), newer({ branch: 'self-impl/goalid-def-bar-22222222-rbbbbbb' })]);
      otherGoal.adapters.getReviewGate = other.adapters.getReviewGate;
      expect((await sweep(otherGoal.adapters)).entries[0]?.reason).not.toContain('lineage');
      const capped = await runDraftSweep({ repository: 'owner/repo', adapters: withReviews({ 1: {}, 2: {} }).adapters, now, closeCap: 1, alreadyClosed: 1 });
      expect(capped.entries[0]).toMatchObject({ number: 1, action: 'keep', reason: 'close-cap' });
    });
  });

  it('derives one stable lineage key across run suffixes and reworded features', () => {
    expect(branchLineageKey('self-impl/goalid-ABC-foo-11111111-raaaaaa')).toBe('goalid:abc');
    expect(branchLineageKey('self-impl/goalid-abc-other-words-99999999')).toBe('goalid:abc');
    expect(branchLineageKey('self-impl/foo-11111111-raaaaaa')).toBeNull();
    expect(branchLineageKey('feat/goalid-abc-x')).toBeNull();
    expect(newerLineageDraft(older(), [older(), newer(), draft(3, { createdAt: '2026-09-29T23:10:00Z', branch: 'self-impl/goalid-abc-z-33333333' })])?.number).toBe(3);
    expect(newerLineageDraft(newer(), [older(), newer()])).toBeUndefined();
  });
});

describe('newerSameCellDraft — 칸 keyed duplicates across goal ids', () => {
  // Same 칸 marker as the PR creation guard reads (`cellIdFromBody`), one goal id per PR number in the default branch.
  const cell = (number: number, options: Partial<SweepDraft> = {}) => draft(number, {
    body: '칸: CELL-A0\n\n대상 경로: src/x.ts', createdAt: `2026-09-29T2${number}:00:00Z`, ...options,
  });

  it('matches a newer draft of the same 칸 under a different goal id', () => {
    expect(newerSameCellDraft(cell(1), [cell(1), cell(2)])?.number).toBe(2);
  });

  it('never matches a same-칸 draft of the same goal — the lineage rule owns that pair', () => {
    const same = { branch: 'self-impl/goalid-1-other-words-22222222-rbbbbbb', createdAt: '2026-09-29T23:00:00Z' };
    expect(newerSameCellDraft(cell(1), [cell(1), cell(2, same)])).toBeUndefined();
    expect(newerLineageDraft(cell(1), [cell(1), cell(2, same)])?.number).toBe(2);
  });

  it('does not infer a different goal when either branch lineage is unknown', () => {
    const unknownOlder = cell(1, { branch: 'work/legacy-old' });
    const unknownNewer = cell(2, { branch: 'work/legacy-new' });
    expect(branchLineageKey(unknownOlder.branch)).toBeNull();
    expect(branchLineageKey(unknownNewer.branch)).toBeNull();
    expect(newerSameCellDraft(unknownOlder, [unknownOlder, cell(2)])).toBeUndefined();
    expect(newerSameCellDraft(cell(1), [cell(1), unknownNewer])).toBeUndefined();
  });

  it('never matches a draft with no 칸 line, or a different 칸, on either side', () => {
    expect(newerSameCellDraft(cell(1), [cell(1), cell(2, { body: undefined })])).toBeUndefined();
    expect(newerSameCellDraft(cell(1, { body: undefined }), [cell(1, { body: undefined }), cell(2)])).toBeUndefined();
    expect(newerSameCellDraft(cell(1), [cell(1), cell(2, { body: '칸: CELL-B0' })])).toBeUndefined();
  });

  it('needs a strictly newer creation and picks the newest match', () => {
    expect(newerSameCellDraft(cell(1), [cell(1), cell(2, { createdAt: '2026-09-28T00:00:00Z' })])).toBeUndefined();
    expect(newerSameCellDraft(cell(1), [cell(1), cell(2), cell(3, { createdAt: '2026-09-29T23:10:00Z' })])?.number).toBe(3);
  });
});

describe('runDraftSweep — 칸 (cell) key: different goal, same 칸 is duplicate-of-open', () => {
  const fresh = '2026-09-29T23:30:00Z';
  const older = (options: Partial<SweepDraft> = {}) => draft(1, {
    title: 'old attempt', branch: 'self-impl/goalid-abc-foo-11111111-raaaaaa', body: '칸: CELL-A0\n\n대상 경로: src/x.ts',
    createdAt: '2026-09-29T22:00:00Z', updatedAt: fresh, ...options,
  });
  const newer = (options: Partial<SweepDraft> = {}) => draft(2, {
    title: 'another goal, same cell', branch: 'self-impl/goalid-def-bar-22222222-rbbbbbb', body: '칸: CELL-A0\n\n대상 경로: src/x.ts',
    createdAt: '2026-09-29T23:00:00Z', updatedAt: fresh, ...options,
  });
  const mutations = (calls: string[]) => calls.filter((call) => /^(label|close):/.test(call));
  // Closes and superseded labels only — the pre-existing stalled marking of an ended run is not this rule's business.
  const supersedes = (calls: string[]) => calls.filter((call) => call.startsWith('close:') || call.endsWith(`=>${superseded}`));

  it('classifies a different-goal same-칸 draft as duplicate-of-open and closes it', async () => {
    const fixture = make([older(), newer()]);
    const preview = await sweep(fixture.adapters);
    expect(preview.entries[0]).toMatchObject({ number: 1, action: 'close', reason: 'duplicate-of-open #2 (cell CELL-A0)', applied: false });
    expect(preview.counts['duplicate-of-open #2 (cell CELL-A0)']).toBe(1);
    expect(preview.lineage).toEqual({ closed: 1, harvestableClosed: 0, fallThrough: {}, cellClosed: 1 });
    expect(mutations(fixture.calls)).toEqual([]);
    const applied = await sweep(fixture.adapters, true);
    expect(applied.entries[0]).toMatchObject({ number: 1, action: 'close', statusLabel: superseded, applied: true });
    expect(mutations(fixture.calls)).toEqual([`label:1:${running}=>${superseded}`, 'close:1']);
    // The label taxonomy is the existing one — no new swept kind for the 칸 path.
    expect(fixture.sweptLabels).toEqual(['1:elanous:swept:duplicate-of-open']);
    expect(sweptReasonLabel('duplicate-of-open #2 (cell CELL-A0)')).toBe('elanous:swept:duplicate-of-open');
  });

  it('leaves a same-칸 same-goal pair to the lineage key — the reason names the lineage, not the 칸', async () => {
    const sameGoal = newer({ branch: 'self-impl/goalid-abc-bar-22222222-rbbbbbb' });
    const fixture = make([older(), sameGoal]);
    const result = await sweep(fixture.adapters, true);
    expect(result.entries[0]).toMatchObject({ number: 1, action: 'close', reason: 'duplicate-of-open #2 (lineage goalid:abc)' });
    expect(result.lineage).toEqual({ closed: 1, harvestableClosed: 0, fallThrough: {} });
  });

  it('keeps a draft whose 칸 is unknown on exactly the rules it had before this rule existed', async () => {
    const noCell = { body: undefined };
    const control = make([older(noCell), newer({ body: '칸: CELL-B0' })]);
    const baseline = (await sweep(control.adapters, true)).entries[0];
    const fixture = make([older(noCell), newer()]);
    const result = await sweep(fixture.adapters, true);
    expect(result.entries[0]).toEqual(baseline);
    expect(result.entries[0]?.reason).not.toContain('(cell ');
    expect(result.lineage).toEqual({ closed: 0, harvestableClosed: 0, fallThrough: {} });
    expect(mutations(fixture.calls)).toEqual(mutations(control.calls));
  });

  it('does not close a same-칸 draft through the sweep when either branch lineage is unknown', async () => {
    const unknownOlder = older({ branch: 'work/legacy-old' });
    const unknownNewer = newer({ branch: 'work/legacy-new' });
    const olderUnknown = await sweep(make([unknownOlder, newer()]).adapters, true);
    const newerUnknown = await sweep(make([older(), unknownNewer]).adapters, true);
    for (const result of [olderUnknown, newerUnknown]) {
      expect(result.entries.find((entry) => entry.number === 1)?.reason).not.toContain('(cell ');
      expect(result.lineage?.cellClosed).toBeUndefined();
    }
  });

  it('keeps a review-pass harvestable draft when the newer same-칸 draft has not passed review (fail-closed)', async () => {
    const harvestable = PR_LABELS.find((entry) => entry.name === 'elanous:harvestable')!.name;
    const fixture = make([older({ labels: [harvestable] }), newer({ labels: [harvestable] })]);
    fixture.statuses.set(1, 'self-implement.result final');
    fixture.adapters.getReviewGate = async (pr) => pr.number === 1 ? { review: 'pass', gate: 'pass' } : {};
    const result = await sweep(fixture.adapters, true);
    expect(result.entries[0]).toMatchObject({ number: 1, action: 'keep', reason: 'harvestable' });
    expect(result.lineage).toEqual({ closed: 0, harvestableClosed: 0, fallThrough: { 'lineage-harvestable-review-pass-protected': 1 } });
    expect(supersedes(fixture.calls)).toEqual([]);
  });

  it('never stops another goal\'s live run — a live 칸 duplicate falls through to the existing rules', async () => {
    const live = (fixture: ReturnType<typeof make>) => {
      fixture.statuses.set(1, 'running');
      fixture.setLive(new Set([older().branch]));
      fixture.adapters.supersedeRun = async () => { fixture.calls.push('stop'); };
    };
    const control = make([older(), newer({ body: '칸: CELL-B0' })]);
    live(control);
    const baseline = (await sweep(control.adapters, true)).entries[0];
    const fixture = make([older(), newer()]);
    live(fixture);
    const result = await sweep(fixture.adapters, true);
    expect(fixture.calls).not.toContain('stop');
    expect(result.entries[0]).toEqual(baseline);
    expect(result.entries[0]?.reason).not.toContain('(cell ');
    expect(result.lineage?.fallThrough).toEqual({ 'cell-duplicate-run-live': 1 });
    expect(result.lineage?.cellClosed).toBeUndefined();
    expect(mutations(fixture.calls)).toEqual(mutations(control.calls));
  });
});

// The production entry `elanous harness drafts sweep` reads its drafts through `githubDraftSweepAdapters`, whose
// `listDrafts` maps each PR's `body` into `SweepDraft.body`. That body is what carries the `칸:` marker, so the 칸 rule
// is exercised here through the real adapter and the real `runDraftSweep` (gh/git injected, no network, no writes).
describe('runDraftSweep — 칸 duplicate through the production GitHub adapter', () => {
  const OLD = { number: 30, branch: 'self-impl/goalid-abc123-first-words-11111111-raaaaaa', created: '2026-10-04T20:00:00Z', head: 'h30' };
  const NEW = { number: 31, branch: 'self-impl/goalid-def456-other-words-22222222-rbbbbbb', created: '2026-10-04T22:00:00Z', head: 'h31' };
  const pull = (pr: typeof OLD) => ({
    number: pr.number, draft: true, state: 'open', title: `attempt ${pr.number}`,
    body: '칸: CELL-A0\n\n대상 경로: src/x.ts', head: { ref: pr.branch, sha: pr.head }, base: { ref: 'main' }, labels: [],
    created_at: pr.created, updated_at: '2026-10-04T23:30:00Z', merged_at: null, merge_commit_sha: null,
  });
  const fakeGh = (calls: string[], threeDrafts = false) => (args: string[]): string => {
    calls.push(args.join(' '));
    if (args[0] === 'pr' || (args[0] === 'label' && args[1] === 'create')) return '';
    if (args[0] !== 'api') throw new Error(`unexpected gh ${args.join(' ')}`);
    if (args[1] === 'graphql') throw new Error('GraphQL unavailable');
    if (threeDrafts && args[1] === '--paginate' && args[2] === '--slurp'
      && /\/issues\/\d+\/comments\?per_page=100$/.test(args[3] ?? '')) return '[[]]';
    const endpoint = args[1]!;
    if (/pulls\?state=open.*&page=1$/.test(endpoint)) return JSON.stringify(threeDrafts ? [
      { ...pull(OLD), body: '칸: CELL-A0\n카드: ta-20261021-abcd12',
        labels: [{ name: 'elanous:from-ux' }, { name: 'elanous:harvestable' }] },
      { ...pull(NEW), body: '칸: CELL-B0\n카드: ta-20261021-efgh34',
        labels: [{ name: 'elanous:from-ux' }, { name: RELEASE_PATH_LABEL }] },
      { ...pull({ number: 32, branch: 'self-impl/goalid-eee777-last-33333333-rcccccc', created: '2026-10-04T23:00:00Z', head: 'h32' }),
        body: '', labels: [{ name: keep }] },
    ] : [pull(OLD), pull(NEW)]);
    if (/pulls\?state=(open|closed).*&page=\d+$/.test(endpoint)) return '[]';
    if (/\/pulls\/\d+\/files\?per_page=100&page=1$/.test(endpoint)) return JSON.stringify([{ filename: 'src/x.ts' }]);
    if (/\/issues\/\d+\/comments\?per_page=100&page=1$/.test(endpoint)) return '[]';
    if (/\/pulls\/\d+\/reviews\?per_page=100&page=\d+$/.test(endpoint)) return '[]';
    if (/\/pulls\/\d+\/commits\?per_page=100&page=1$/.test(endpoint)) return '[]';
    const single = /\/pulls\/(\d+)$/.exec(endpoint);
    if (single) return JSON.stringify({ head: { sha: `h${single[1]}` } });
    if (/\/commits\/\w+\/status$/.test(endpoint)) return JSON.stringify({ state: 'success' });
    if (/\/commits\/\w+\/check-runs\?per_page=100&page=\d+$/.test(endpoint)) return JSON.stringify({ total_count: 0, check_runs: [] });
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  // No worktree carries either branch (= neither run is live) and the repository matches the sweep target.
  const git = (_cwd: string, args: string[]) => ({ status: 0, stderr: '',
    stdout: args[0] === 'config' ? 'https://github.com/my/repo.git\n' : ['worktree /tmp/main', 'branch refs/heads/main'].join('\n') + '\n' });

  let stateDir = '';
  let previous: string | undefined;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'draft-sweep-cell-'));
    previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = stateDir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(stateDir, { recursive: true, force: true });
  });

  const run = async (apply: boolean) => {
    const calls: string[] = [];
    const logged: Array<{ event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'self-dev.draft-sweep') logged.push({ event, data });
    });
    try {
      const result = await runDraftSweep({ repository: 'my/repo', apply, now: new Date('2026-10-05T00:00:00Z'),
        adapters: githubDraftSweepAdapters(fakeGh(calls), git, '/tmp/main') });
      return { result, writes: calls.filter((call) => call.startsWith('pr ') || call.startsWith('label create ')), logged };
    } finally { log.mockRestore(); }
  };

  it('preserves three fake gh draft JSON rows and terminal failure order through the production adapter', async () => {
    const calls: string[] = [];
    const adapters = githubDraftSweepAdapters(fakeGh(calls, true), git, '/tmp/main');
    adapters.getRunStatus = async () => 'completed';
    adapters.listPrTerminals = async () => [
      { childRunId: 'run-31-failed', prNumber: 31, prUrl: null, repository: 'my/repo', headSha: null,
        terminalClass: 'failed-with-pr', stage: 'review-blocked', owner: 'UX', ownerSource: 'seat', card: null,
        at: '2026-10-04T21:00:00Z', hostRegateFailure: null },
      { childRunId: 'run-31-ready', prNumber: 31, prUrl: null, repository: 'my/repo', headSha: null,
        terminalClass: 'merge-ready-not-merged', stage: 'gate-passed', owner: 'UX', ownerSource: 'seat', card: null,
        at: '2026-10-04T23:00:00Z', hostRegateFailure: null },
    ];
    const json = JSON.parse(JSON.stringify(await runDraftSweep({ repository: 'my/repo', adapters,
      apply: true, includeTriage: true, now: new Date('2026-10-05T00:00:00Z') })));
    const rows = json.triage.entries.map(({ number, assessment }: { number: number; assessment: {
      origin: string | null; lastFailureTail: string | null; cellStatus: string; nextAction: string; missingEvidence: string[];
    } }) => ({ number, origin: assessment.origin, lastFailureTail: assessment.lastFailureTail,
      cellStatus: assessment.cellStatus, nextAction: assessment.nextAction, missingEvidence: assessment.missingEvidence }));
    const missing = ['gate', 'review', 'cell-complete', 'cell-status-repository-bound',
      'replacement-landed', 'newer-same-card', 'idle-48h', 'recent-commit'];
    expect(JSON.stringify({ rows, counts: json.triage.counts,
      closeCalls: calls.filter((call) => call.startsWith('pr close ')) })).toBe(JSON.stringify({
      rows: [
        { number: 30, origin: 'elanous:from-ux', lastFailureTail: null, cellStatus: 'unknown',
          nextAction: 'human', missingEvidence: missing },
        { number: 31, origin: 'elanous:from-ux', lastFailureTail: 'review-blocked', cellStatus: 'unknown',
          nextAction: 'human', missingEvidence: missing },
        { number: 32, origin: null, lastFailureTail: null, cellStatus: 'unknown',
          nextAction: 'human', missingEvidence: ['provenance', ...missing] },
      ], counts: { human: 3 }, closeCalls: [],
    }));
    expect(json.triage.entries[1].assessment.evidence).toContain('last failure: review-blocked');
    expect(json.triage.entries[1].assessment.checks.protected).toEqual({ state: 'yes', evidence: `보호 표지=${RELEASE_PATH_LABEL}` });
    expect(calls.filter((call) => call.startsWith('pr close '))).toEqual([]);
    expect(calls.filter((call) => call.startsWith('pr edit '))).toEqual(['pr edit 30 --repo my/repo --add-label elanous:stalled']);
    expect(json.entries.find((entry: { number: number }) => entry.number === 31)).toMatchObject({
      action: 'keep', reason: `label:${RELEASE_PATH_LABEL}`, applied: false,
    });
  }, 60_000);

  it('closes a different-goal same-칸 draft through the real adapter', async () => {
    const dry = await run(false);
    expect(dry.result.entries.find((entry) => entry.number === OLD.number)).toMatchObject({ action: 'close', applied: false,
      reason: 'duplicate-of-open #31 (cell CELL-A0)' });
    expect(dry.writes).toEqual([]);
    const applied = await run(true);
    expect(applied.result.entries.find((entry) => entry.number === OLD.number)).toMatchObject({ action: 'close', applied: true,
      statusLabel: superseded });
    expect(applied.result.entries.find((entry) => entry.number === NEW.number)?.action).toBe('keep');
    expect(applied.result.lineage).toMatchObject({ closed: 1, cellClosed: 1 });
    expect(applied.writes).toEqual([
      expect.stringMatching(/^pr edit 30 --repo my\/repo --add-label elanous:superseded/),
      expect.stringMatching(/^label create elanous:swept:duplicate-of-open --repo my\/repo /),
      'pr edit 30 --repo my/repo --add-label elanous:swept:duplicate-of-open',
      'pr close 30 --repo my/repo',
    ]);
    expect(applied.logged.filter((entry) => entry.event === 'lineage-summary'))
      .toEqual([{ event: 'lineage-summary', data: { closed: 1, harvestableClosed: 0, fallThrough: {}, apply: true, cellClosed: 1 } }]);
  }, 60_000);
});
