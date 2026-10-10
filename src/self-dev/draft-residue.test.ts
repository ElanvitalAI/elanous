import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { installHarnessCliCommand } from '../harness/harness-cli-command.js';
import { debug } from '../debug/log.js';
import { appendRunLedgerEntry, loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';
import { podSelfImplementSpawn, type Kubectl, type PodSpawnOptions } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { runDraftSweep, type DraftSweepAdapters, type SweepDraft } from './draft-sweep.js';
import { applyPodTerminal, classifyPodTerminal, defaultAdapters, replayPodTerminals, terminalRunStatus, type DraftResidueAdapters, type ResiduePr, type ResidueRunStatusSources } from './draft-residue.js';

const runId = 'run-12345678-1234-1234-1234-123456789abc';
const input = { childRunId: runId, state: 'complete' as const, disposition: {
  stage: 'host-regate-failed', ok: false, merged: false, prNumber: 25437,
  prUrl: 'https://github.com/ElanvitalAI/elanous/pull/25437', checkedHeadCommit: 'a'.repeat(40),
}, env: { ELANOUS_HARNESS_SEAT: 'TC' }, at: '2026-10-09T12:00:00Z' };
const pr = (number: number, branch: string, body = '', labels: string[] = [], createdAt = '2026-10-08T00:00:00Z'): ResiduePr => ({
  number, branch, body, labels, createdAt, title: `Goal ${number}`,
});
const fixture = (current = pr(25437, 'self-impl/main-goalid-abc123-new', '칸: CELL-A', [], '2026-10-09T00:00:00Z'), drafts: ResiduePr[] = []) => {
  const calls: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'draft-residue-'));
  const adapters: DraftResidueAdapters = {
    loadLedger: (id, path) => loadRunLedger(id, path),
    appendLedger: appendRunLedgerEntry,
    getPr: () => current, listOpenDrafts: () => drafts,
    addLabel: (_repo, n, label) => { calls.push(`add:${n}:${label}`); },
    setLabels: (_repo, n, change) => { calls.push(`set:${n}:${change.add}`); },
    comment: (_repo, n, body) => { calls.push(`comment:${n}:${body}`); },
    closePr: (_repo, n) => { calls.push(`close:${n}`); },
    listLiveBranches: () => new Set(), getRunStatus: () => 'failed',
  };
  return { calls, dir, adapters, ctx: { ledgerRunId: runId, ledgerDir: dir, adapters }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

describe('Pod terminal residue', () => {
  test('records the failed PR once, marks it harvestable with its owner, and skips a second call', async () => {
    const f = fixture();
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'draft-residue-once-test', emit: (row) => {
      if (row.category === 'draft.residue') events.push({ event: row.event, data: row.data as Record<string, unknown> });
    } });
    try {
      const record = classifyPodTerminal(input);
      expect(record).toMatchObject({ terminalClass: 'failed-with-pr', prNumber: 25437, repository: 'ElanvitalAI/elanous', headSha: 'a'.repeat(40), owner: 'TC', ownerSource: 'seat' });
      expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'recorded' });
      expect(loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ ...record }) }),
      ]);
      expect(f.calls).toEqual([`add:25437:elanous:harvestable`, expect.stringContaining('comment:25437:Draft residue: failed-with-pr · owner=TC(seat)')]);
      const count = f.calls.length;
      expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'skipped', reason: 'already-recorded' });
      expect(f.calls).toHaveLength(count);
      expect(loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal')).toHaveLength(1);
      expect(events.filter((row) => row.event === 'skipped' && row.data.reason === 'already-recorded')).toHaveLength(1);
    } finally { off(); f.cleanup(); }
  });

  test('distinguishes landed, open, no PR and unobserved result; seat, card and unknown owners', async () => {
    const merged = classifyPodTerminal({ ...input, disposition: { ...input.disposition, merged: true } });
    const opened = classifyPodTerminal({ ...input, disposition: { ...input.disposition, stage: 'pr-opened', ok: true } });
    const noPr = classifyPodTerminal({ ...input, disposition: { stage: 'abandoned', ok: false } });
    const unobserved = classifyPodTerminal({ childRunId: runId, state: 'failed' });
    expect([merged.terminalClass, opened.terminalClass, noPr.terminalClass, unobserved.terminalClass]).toEqual([
      'landed', 'merge-ready-not-merged', 'failed-no-pr', 'failed-pr-unobserved',
    ]);
    expect(classifyPodTerminal({ ...input, env: {}, prBody: '칸: TA-LIVE-LAND' })).toMatchObject({ owner: 'TA-LIVE-LAND', ownerSource: 'card' });
    expect(classifyPodTerminal({ ...input, env: {} })).toMatchObject({ owner: 'unknown', ownerSource: 'unknown' });
    for (const record of [merged, noPr, unobserved]) {
      const f = fixture();
      try { await applyPodTerminal(record, f.ctx); expect(f.calls.some((call) => call.includes('harvestable'))).toBe(false); }
      finally { f.cleanup(); }
    }
  });

  test('supersedes only older verified same-goal drafts, labels before closing, and respects protected, unrelated and card-only PRs', async () => {
    const current = pr(200, 'self-impl/new-goalid-abc123-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const f = fixture(current, [
      pr(100, 'self-impl/x-goalid-abc123-old'), pr(101, 'self-impl/y-goalid-beef12-old'),
      pr(102, 'self-impl/z-goalid-abc123-old', '', ['elanous:keep']),
      pr(103, 'self-impl/other-old', '칸: CELL-A'),
    ]);
    try {
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('recorded');
      expect(f.calls.filter((call) => /^(set|close):/.test(call))).toEqual([
        'set:100:elanous:superseded', 'close:100',
      ]);
      expect(f.calls.filter((call) => call.includes('superseded-by #200'))).toHaveLength(1);
      // review must-fix: a shared «칸:» value (#103 has no goal id) is not the same goal — it must not be closed.
      expect(f.calls.some((call) => /:(101|102|103)(:|$)/.test(call))).toBe(false);
    } finally { f.cleanup(); }
  });

  test('protected PR is left untouched (no label, no comment); unreadable draft inventory never closes a PR', async () => {
    const f = fixture(pr(25437, 'self-impl/main-goalid-abc123-new', '', ['elanous:keep'], '2026-10-09T00:00:00Z'));
    try {
      // review r4 policy: a protected PR belongs to a human — the terminal records `protected`, not a harvest.
      expect(await applyPodTerminal(classifyPodTerminal(input), f.ctx)).toEqual({ status: 'skipped', reason: 'protected' });
      expect(f.calls).toEqual([]);
      const second = fixture();
      try {
        second.adapters.listOpenDrafts = () => undefined;
        expect(await applyPodTerminal(classifyPodTerminal(input), second.ctx)).toMatchObject({ status: 'failed', step: 'list-open-drafts' });
        expect(second.calls.filter((call) => call.startsWith('close:'))).toHaveLength(0);
      } finally { second.cleanup(); }
    } finally { f.cleanup(); }
  });

  test('default adapter records a foreign PR without contacting GitHub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'draft-residue-foreign-'));
    try {
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
        prUrl: 'https://github.com/o/r/pull/25437' } });
      expect(await applyPodTerminal(record, { ledgerRunId: runId, ledgerDir: dir })).toEqual({ status: 'skipped', reason: 'foreign-repository' });
      expect(loadRunLedger(runId, dir)?.filter((row) => row.event === 'pr-terminal')).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a landed newer PR still supersedes an older same-goal draft without harvestable marking', async () => {
    const current = pr(200, 'self-impl/new-goalid-abc123-run', '', [], '2026-10-09T00:00:00Z');
    const f = fixture(current, [pr(100, 'self-impl/old-goalid-abc123-run')]);
    try {
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition, merged: true,
        prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('recorded');
      expect(f.calls.filter((call) => /^(set|close):/.test(call))).toEqual(['set:100:elanous:superseded', 'close:100']);
      expect(f.calls.some((call) => call.includes('harvestable'))).toBe(false);
    } finally { f.cleanup(); }
  });

  test('ledger write or PR lookup failure fails closed without GitHub writes', async () => {
    const f = fixture();
    try {
      f.adapters.appendLedger = () => { throw new Error('disk full'); };
      expect(await applyPodTerminal(classifyPodTerminal(input), f.ctx)).toMatchObject({ status: 'failed', step: 'ledger' });
      expect(f.calls).toHaveLength(0);
      f.adapters.appendLedger = appendRunLedgerEntry;
      f.adapters.getPr = () => undefined;
      expect(await applyPodTerminal(classifyPodTerminal(input), f.ctx)).toMatchObject({ status: 'failed', step: 'get-pr' });
      expect(f.calls).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test('resumes after a partial GitHub failure without duplicating successful effects or the terminal fact', async () => {
    const f = fixture(pr(200, 'self-impl/new-goalid-abc123-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z'),
      [pr(100, 'self-impl/old-goalid-abc123-run')]);
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      const close = f.adapters.closePr;
      f.adapters.closePr = () => { throw new Error('transient close'); };
      expect(await applyPodTerminal(record, f.ctx)).toMatchObject({ status: 'failed', step: 'close-pr' });
      expect(f.calls.filter((call) => call.startsWith('set:100:'))).toHaveLength(1);
      f.adapters.closePr = close;
      expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'recorded' });
      expect(f.calls.filter((call) => call.startsWith('add:200:'))).toHaveLength(1);
      expect(f.calls.filter((call) => call.startsWith('comment:200:'))).toHaveLength(1);
      expect(f.calls.filter((call) => call.startsWith('set:100:'))).toHaveLength(1);
      expect(f.calls.filter((call) => call.startsWith('comment:100:'))).toHaveLength(1);
      expect(f.calls.filter((call) => call.startsWith('close:100'))).toHaveLength(1);
      expect(loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal')).toHaveLength(1);
      expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'skipped', reason: 'already-recorded' });
    } finally { f.cleanup(); }
  });

  test('previous draft label and comment failures resume in order without repeating successful writes', async () => {
    for (const failure of ['setLabels', 'comment'] as const) {
      const current = pr(200, 'self-impl/new-goalid-abc123-run', '', [], '2026-10-09T00:00:00Z');
      const f = fixture(current, [pr(100, 'self-impl/old-goalid-abc123-run')]);
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
        prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      try {
        f.adapters.getPr = (number) => number === 200 ? current : pr(100, 'self-impl/old-goalid-abc123-run');
        const original = f.adapters[failure];
        if (failure === 'comment') {
          const comment = f.adapters.comment;
          f.adapters.comment = (repo, number, body) => {
            if (number === 100) throw new Error('transient prior comment');
            return comment(repo, number, body);
          };
        } else {
          f.adapters.setLabels = () => { throw new Error('transient prior label'); };
        }
        expect((await applyPodTerminal(record, f.ctx)).status).toBe('failed');
        (f.adapters as unknown as Record<string, unknown>)[failure] = original;
        expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'recorded' });
        expect(f.calls.filter((call) => call.startsWith('add:200:'))).toHaveLength(1);
        expect(f.calls.filter((call) => call.startsWith('comment:200:'))).toHaveLength(1);
        expect(f.calls.filter((call) => call.startsWith('set:100:'))).toHaveLength(1);
        expect(f.calls.filter((call) => call.startsWith('comment:100:'))).toHaveLength(1);
        expect(f.calls.filter((call) => call.startsWith('close:100'))).toHaveLength(1);
      } finally { f.cleanup(); }
    }
  });

  test('a failed progress acknowledgement observes the already applied GitHub label before retrying', async () => {
    const f = fixture();
    const record = classifyPodTerminal(input);
    let failed = false;
    try {
      f.adapters.appendLedger = (entry, dir) => {
        if (!failed && entry.event === 'pr-terminal-effect' && entry.data.effect === 'harvestable') {
          failed = true;
          throw new Error('progress write failed');
        }
        appendRunLedgerEntry(entry, dir);
      };
      expect(await applyPodTerminal(record, f.ctx)).toMatchObject({ status: 'failed', step: 'ledger' });
      f.adapters.getPr = () => pr(25437, 'self-impl/main-goalid-abc123-new', '', ['elanous:harvestable'], '2026-10-09T00:00:00Z');
      expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'recorded' });
      expect(f.calls.filter((call) => call.startsWith('add:25437:'))).toHaveLength(1);
      expect(f.calls.filter((call) => call.startsWith('comment:25437:'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('lookup, label, owner comment and inventory failures each resume with only unfinished effects', async () => {
    for (const failure of ['getPr', 'addLabel', 'comment', 'listOpenDrafts'] as const) {
      const f = fixture();
      const record = classifyPodTerminal(input);
      const original = f.adapters[failure];
      try {
        (f.adapters as unknown as Record<string, unknown>)[failure] = () => { throw new Error(`transient ${failure}`); };
        expect((await applyPodTerminal(record, f.ctx)).status).toBe('failed');
        (f.adapters as unknown as Record<string, unknown>)[failure] = original;
        expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'recorded' });
        expect(f.calls.filter((call) => call.startsWith('add:25437:'))).toHaveLength(1);
        expect(f.calls.filter((call) => call.startsWith('comment:25437:'))).toHaveLength(1);
        expect(loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal')).toHaveLength(1);
      } finally { f.cleanup(); }
    }
  });

  test('does not strip a running draft or close it when liveness or run status cannot be verified', async () => {
    const f = fixture(pr(200, 'self-impl/new-goalid-abc123-run', '', [], '2026-10-09T00:00:00Z'),
      [pr(100, 'self-impl/old-goalid-abc123-run', '', ['elanous:running'])]);
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      f.adapters.listLiveBranches = () => new Set(['self-impl/old-goalid-abc123-run']);
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('skipped');
      f.adapters.listLiveBranches = () => undefined;
      expect(await applyPodTerminal(record, f.ctx)).toMatchObject({ status: 'failed', step: 'list-live-branches' });
      f.adapters.listLiveBranches = () => new Set();
      f.adapters.getRunStatus = () => 'running';
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('skipped');
      f.adapters.getRunStatus = () => undefined;
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('skipped');
      f.adapters.getRunStatus = () => { throw new Error('run observation unavailable'); };
      expect(await applyPodTerminal(record, f.ctx)).toMatchObject({ status: 'failed', step: 'get-run-status' });
      expect(f.calls.filter((call) => /^(set|close):100/.test(call))).toHaveLength(0);
      f.adapters.getRunStatus = () => 'failed';
      expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'recorded' });
      expect(f.calls.filter((call) => /^(set|close):100/.test(call))).toEqual(['set:100:elanous:superseded', 'close:100']);
    } finally { f.cleanup(); }
  });

  test('sweep consumes the label without counting it as unobserved, retaining old unlabelled behavior', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const drafts: SweepDraft[] = [2, 30, 2].map((idle, i) => ({ ...pr(i + 1, `self-impl/goal-${i}`), title: `Goal ${i}`,
      labels: i < 2 ? ['elanous:harvestable'] : [], updatedAt: new Date(now.getTime() - idle * 3600_000).toISOString() }));
    const closed: string[] = [];
    const adapters: DraftSweepAdapters = {
      listDrafts: async (page) => page === 1 ? drafts : [], listMerged: async () => [],
      listLiveBranches: async () => new Set(), getRunStatus: async () => undefined,
      setLabels: async (_repo, number, change) => { closed.push(`label:${number}:${change.add}`); },
      closeDraft: async (_repo, number, comment) => { closed.push(`close:${number}:${comment}`); },
    };
    const result = await runDraftSweep({ repository: 'o/r', adapters, apply: true, now });
    expect(result.entries.map(({ action, reason }) => ({ action, reason }))).toEqual([
      { action: 'keep', reason: 'harvestable' }, { action: 'close', reason: 'harvest-expired' }, { action: 'keep', reason: 'unobserved' },
    ]);
    expect(result.unobserved).toBe(1);
    expect(closed).toEqual([expect.stringContaining('label:2:'), expect.stringContaining('close:2:Draft sweep: harvest-expired')]);
  });

  test('supersede close cap leaves remaining drafts pending for the next replay without closing twice', async () => {
    const current = pr(200, 'self-impl/new-goalid-abc123-run', '', [], '2026-10-09T00:00:00Z');
    const drafts = Array.from({ length: 12 }, (_, i) => pr(i + 1, `self-impl/old-goalid-abc123-${i}`));
    const f = fixture(current, drafts);
    try {
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'skipped', reason: 'close-cap' });
      expect(f.calls.filter((call) => call.startsWith('close:'))).toHaveLength(10);
      expect(loadRunLedger(runId, f.dir)?.some((entry) => entry.event === 'pr-terminal-effect' && entry.data.effect === 'complete')).toBe(false);
      const closePr = f.adapters.closePr;
      f.adapters.closePr = () => { throw new Error('retry later'); };
      expect(await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous' })).toEqual({ attempted: 1, recovered: 0, pending: 1, unresolved: 0, closed: 0 });
      f.adapters.closePr = closePr;
      expect(await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous' })).toEqual({ attempted: 1, recovered: 1, pending: 0, unresolved: 0, closed: 2 });
      expect(f.calls.filter((call) => call.startsWith('close:'))).toEqual(Array.from({ length: 12 }, (_, i) => `close:${i + 1}`));
      expect(f.calls.filter((call) => call.startsWith('set:'))).toHaveLength(12);
      expect(loadRunLedger(runId, f.dir)?.filter((entry) => entry.event === 'pr-terminal-effect' && entry.data.effect === 'complete')).toHaveLength(1);
      expect(await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous' })).toEqual({ attempted: 0, recovered: 0, pending: 0, unresolved: 0, closed: 0 });
    } finally { f.cleanup(); }
  });

  test('replay closes share one tick budget: closeCap bounds the total and reports what it closed (review must-fix)', async () => {
    const current = pr(200, 'self-impl/new-goalid-abc123-run', '', [], '2026-10-09T00:00:00Z');
    const drafts = Array.from({ length: 3 }, (_, i) => pr(i + 1, `self-impl/old-goalid-abc123-${i}`));
    const f = fixture(current, drafts);
    try {
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      appendRunLedgerEntry({ runId, event: 'pr-terminal', data: { ...record } }, f.dir);
      const first = await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous', closeCap: 1 });
      expect(first).toEqual({ attempted: 1, recovered: 0, pending: 1, unresolved: 0, closed: 1 });
      expect(f.calls.filter((call) => call.startsWith('close:'))).toHaveLength(1);
      const zero = await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous', closeCap: 0 });
      expect(zero.closed).toBe(0);
      expect(f.calls.filter((call) => call.startsWith('close:'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('a URL-less terminal settles once as unresolved (never complete, never retried) and a later pending terminal recovers (review r7)', async () => {
    const f = fixture();
    const noUrl = classifyPodTerminal({ ...input, childRunId: 'run-no-url', disposition: { ...input.disposition, prUrl: undefined } });
    const pending = classifyPodTerminal(input);
    try {
      expect(noUrl).toMatchObject({ prNumber: 25437, prUrl: null, repository: null });
      expect(await applyPodTerminal(noUrl, f.ctx)).toEqual({ status: 'skipped', reason: 'repository-unobserved' });
      f.adapters.addLabel = () => { throw new Error('transient label failure'); };
      expect(await applyPodTerminal(pending, f.ctx)).toMatchObject({ status: 'failed', step: 'add-label' });
      f.adapters.addLabel = (_repo, number, label) => { f.calls.push(`add:${number}:${label}`); };
      // The record cannot learn its repository later: it is settled as unresolved, not retried, and never `complete`.
      expect(await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous' })).toEqual({ attempted: 1, recovered: 1, pending: 0, unresolved: 1, closed: 0 });
      expect(await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous' })).toEqual({ attempted: 0, recovered: 0, pending: 0, unresolved: 1, closed: 0 });
      const effects = loadRunLedger(runId, f.dir)?.filter((entry) => entry.event === 'pr-terminal-effect' && entry.data.childRunId === 'run-no-url').map((entry) => entry.data.effect);
      expect(effects).toEqual(['unresolved-repository']);
      expect(f.calls.filter((call) => call.startsWith('add:'))).toEqual(['add:25437:elanous:harvestable']);
      expect(loadRunLedger(runId, f.dir)?.filter((entry) => entry.event === 'pr-terminal')).toHaveLength(2);
    } finally { f.cleanup(); }
  });

  test('sweep logs a known child run ID separately from the PR number, or null when unknown', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const drafts: SweepDraft[] = [pr(101, 'self-impl/one'), pr(102, 'self-impl/two')].map((row, i) => ({
      ...row, title: `Goal ${row.number}`, runId: i === 0 ? 'run-child-101' : undefined, updatedAt: now.toISOString(),
    }));
    const rows: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'draft-residue-sweep-id-test', emit: (row) => {
      if (row.category === 'draft.residue' && row.event === 'sweep-decided') rows.push(row.data as Record<string, unknown>);
    } });
    try {
      const adapters: DraftSweepAdapters = {
        listDrafts: async () => drafts, listMerged: async () => [], listLiveBranches: async () => new Set(),
        getRunStatus: async () => undefined, setLabels: async () => {}, closeDraft: async () => {},
      };
      expect((await runDraftSweep({ repository: 'o/r', adapters, now })).complete).toBe(true);
      expect(rows.map(({ childRunId, prNumber }) => ({ childRunId, prNumber }))).toEqual([
        { childRunId: 'run-child-101', prNumber: 101 }, { childRunId: null, prNumber: 102 },
      ]);
    } finally { off(); }
  });

  test('harvestable draft cannot override live or protected decisions', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const old = new Date(now.getTime() - 30 * 3600_000).toISOString();
    const drafts: SweepDraft[] = [
      { ...pr(1, 'self-impl/a-goalid-abc123-old', '', ['elanous:harvestable', 'elanous:keep']), title: 'same', updatedAt: old },
      { ...pr(2, 'self-impl/b-goalid-abc123-old', '', ['elanous:harvestable']), title: 'same', updatedAt: old },
      { ...pr(3, 'self-impl/live-goalid-ff0123-old', '', ['elanous:harvestable']), title: 'live', updatedAt: old },
    ];
    const adapters: DraftSweepAdapters = {
      listDrafts: async () => drafts, listMerged: async () => [], getRunStatus: async () => undefined,
      listLiveBranches: async () => new Set([drafts[2]!.branch]), setLabels: async () => {}, closeDraft: async () => {},
    };
    const result = await runDraftSweep({ repository: 'o/r', adapters, now });
    expect(result.entries.slice(0, 3).map((entry) => entry.reason)).toEqual([
      'label:elanous:keep', 'harvest-expired', 'branch-finality-unobserved',
    ]);
  });

  test('harvestable label respects close cap and remains outside unobserved count', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const rows: SweepDraft[] = [1, 2].map((n) => ({ ...pr(n, `self-impl/old-${n}`, '', ['elanous:harvestable']),
      title: `old-${n}`, updatedAt: '2026-10-08T00:00:00Z' }));
    const adapters: DraftSweepAdapters = {
      listDrafts: async () => rows, listMerged: async () => [], getRunStatus: async () => undefined,
      listLiveBranches: async () => new Set(), setLabels: async () => {}, closeDraft: async () => {},
    };
    const result = await runDraftSweep({ repository: 'o/r', adapters, apply: true, now, closeCap: 1 });
    expect(result.entries.map((entry) => [entry.action, entry.reason])).toEqual([['close', 'harvest-expired'], ['keep', 'close-cap']]);
    expect(result.unobserved).toBe(0);
  });

  test('terminal harvestable label on a running draft overrides claim expiration, not liveness', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const row: SweepDraft = { ...pr(1, 'self-impl/old-goalid-abc123-run', '', ['elanous:running', 'elanous:harvestable']),
      title: 'old', updatedAt: '2026-10-08T00:00:00Z' };
    const adapters: DraftSweepAdapters = {
      listDrafts: async () => [row], listMerged: async () => [], getRunStatus: async () => undefined,
      listLiveBranches: async () => new Set(), setLabels: async () => {}, closeDraft: async () => {},
    };
    const result = await runDraftSweep({ repository: 'o/r', adapters, now });
    expect(result.entries[0]?.reason).toBe('harvest-expired');
  });

  test('harvestable label leaves the superseded-by merge decision first', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const draft: SweepDraft = { ...pr(1, 'self-impl/old-goalid-abc123-run', '', ['elanous:harvestable']), title: 'old',
      updatedAt: '2026-10-08T00:00:00Z' };
    const adapters: DraftSweepAdapters = {
      listDrafts: async () => [draft], listMerged: async () => [{ ...pr(200, 'self-impl/new-goalid-abc123-run'), title: 'new' }],
      getRunStatus: async () => undefined, listLiveBranches: async () => new Set(),
      setLabels: async () => {}, closeDraft: async () => {},
    };
    const result = await runDraftSweep({ repository: 'o/r', adapters, now });
    expect(result.entries[0]?.reason).toBe('superseded-by #200');
  });

  test('harness drafts sweep --apply replays the failed Pod hook from the host ledger after GitHub recovery', async () => {
    const f = fixture();
    const record = classifyPodTerminal(input);
    const writes: string[] = [];
    const command = new Command();
    const sweepAdapters: DraftSweepAdapters = {
      listDrafts: async () => [], listMerged: async () => [], getRunStatus: async () => undefined,
      listLiveBranches: async () => new Set(), setLabels: async () => {}, closeDraft: async () => {},
    };
    installHarnessCliCommand(command, { registerSink: async () => {}, resolveSurface: async () => 'test', draftSweep: {
      adapters: sweepAdapters, repository: () => 'ElanvitalAI/elanous', write: (line) => writes.push(line),
      residueReplay: { ledgerDir: f.dir, adapters: f.adapters },
    } });
    const tick = async () => command.parseAsync(['harness', 'drafts', 'sweep', '--apply', '--repo', 'ElanvitalAI/elanous', '--json'], { from: 'user' });
    try {
      const add = f.adapters.addLabel;
      f.adapters.addLabel = () => { throw new Error('transient GitHub outage'); };
      const kubectl: Kubectl = (args) => {
        if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
        if (args.some((arg) => arg.includes('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
        if (args.includes('logs')) return { status: 0, stdout: `${JSON.stringify(input.disposition)}\n`, stderr: '' };
        if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      const pod = await podSelfImplementSpawn({ kubectl, env: { ELANOUS_HARNESS_SEAT: 'TC' },
        credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'test' }), sleep: async () => {},
        draftResidue: async (terminal) => { expect(await applyPodTerminal(terminal, f.ctx)).toMatchObject({ status: 'failed', step: 'add-label' }); },
      })({ feature: 'x', spaceId: 'residue-replay-pod', autoMerge: false }).done;
      expect(pod).toMatchObject({ disposition: { prNumber: record.prNumber } });
      await tick();
      expect(f.calls).toHaveLength(0);
      expect(loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal')).toHaveLength(1);
      f.adapters.addLabel = add;
      await tick();
      expect(f.calls).toEqual([`add:25437:elanous:harvestable`, expect.stringContaining('comment:25437:Draft residue:')]);
      await tick();
      expect(f.calls).toHaveLength(2);
      expect(loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal')).toHaveLength(1);
      expect(writes).toHaveLength(3);
    } finally { f.cleanup(); process.exitCode = 0; }
  });

  test('harness sweep rechecks prior-run termination on each retry, then supersedes once', async () => {
    const current = pr(200, 'self-impl/new-goalid-abc123-run', '', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-goalid-abc123-run');
    const f = fixture(current, [old]);
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    let status: string | undefined;
    let probes = 0;
    let hookCalls = 0;
    f.adapters.getRunStatus = () => { probes++; return status; };
    const command = new Command();
    installHarnessCliCommand(command, { registerSink: async () => {}, resolveSurface: async () => 'test', draftSweep: {
      repository: () => 'ElanvitalAI/elanous', write: () => {},
      adapters: { listDrafts: async () => [], listMerged: async () => [], getRunStatus: async () => undefined,
        listLiveBranches: async () => new Set(), setLabels: async () => {}, closeDraft: async () => {} },
      residueReplay: { ledgerDir: f.dir, adapters: f.adapters },
    } });
    const tick = async () => command.parseAsync(['harness', 'drafts', 'sweep', '--apply', '--repo', 'ElanvitalAI/elanous', '--json'], { from: 'user' });
    try {
      const kubectl: Kubectl = (args) => {
        if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
        if (args.some((arg) => arg.includes('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
        if (args.includes('logs')) return { status: 0, stdout: `${JSON.stringify({ ...record, ...input.disposition, prNumber: 200,
          prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' })}\n`, stderr: '' };
        if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      await podSelfImplementSpawn({ kubectl, env: {},
        credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'test' }), sleep: async () => {},
        draftResidue: async (terminal) => { hookCalls++; expect(await applyPodTerminal(terminal, f.ctx)).toMatchObject({ status: 'skipped', reason: 'previous-run-unverified' }); },
      })({ feature: 'x', spaceId: 'residue-replay-prior', autoMerge: false }).done;
      expect(hookCalls).toBe(1);
      expect(loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal')).toHaveLength(1);
      await tick();
      expect(f.calls.filter((call) => /^(set|close):100/.test(call))).toHaveLength(0);
      status = 'failed';
      await tick();
      expect(f.calls.filter((call) => /^(set|close):100/.test(call))).toEqual(['set:100:elanous:superseded', 'close:100']);
      const after = probes;
      await tick();
      expect(probes).toBe(after);
      expect(loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal')).toHaveLength(1);
    } finally { f.cleanup(); process.exitCode = 0; }
  });

  test('archived unfinished terminal effects restore through the existing ledger writer before replay', async () => {
    const f = fixture();
    try {
      const record = classifyPodTerminal(input);
      f.adapters.addLabel = () => { throw new Error('GitHub unavailable'); };
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('failed');
      const archive = join(f.dir, 'archive');
      const month = join(archive, '2026-10');
      mkdirSync(month, { recursive: true });
      const archived = join(month, `${runId}.jsonl.gz`);
      writeFileSync(archived, gzipSync(readFileSync(join(f.dir, `${runId}.jsonl`))));
      writeFileSync(join(archive, `.archived-${runId}`), archived);
      rmSync(join(f.dir, `${runId}.jsonl`));
      f.adapters.addLabel = (_repo, number, label) => { f.calls.push(`add:${number}:${label}`); };
      const replay = await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous' });
      expect(replay).toEqual({ attempted: 1, recovered: 1, pending: 0, unresolved: 0, closed: 0 });
      expect(f.calls.filter((call) => call.startsWith('add:'))).toHaveLength(1);
      expect(existsSync(join(f.dir, `${runId}.jsonl`))).toBe(true);
      expect(await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous' })).toEqual({ attempted: 0, recovered: 0, pending: 0, unresolved: 0, closed: 0 });
    } finally { f.cleanup(); }
  });

  test('archived terminal whose first replay fails midway is still retried — the ledger writer restores the archive on first append (review r3 scenario)', async () => {
    const f = fixture();
    try {
      const record = classifyPodTerminal(input);
      f.adapters.addLabel = () => { throw new Error('GitHub unavailable'); };
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('failed');
      const archive = join(f.dir, 'archive');
      const month = join(archive, '2026-10');
      mkdirSync(month, { recursive: true });
      const archived = join(month, `${runId}.jsonl.gz`);
      writeFileSync(archived, gzipSync(readFileSync(join(f.dir, `${runId}.jsonl`))));
      writeFileSync(join(archive, `.archived-${runId}`), archived);
      rmSync(join(f.dir, `${runId}.jsonl`));
      // First replay: the label lands (its effect is written to a NEW active ledger), then the comment fails.
      f.adapters.addLabel = (_repo, number, label) => { f.calls.push(`add:${number}:${label}`); };
      const comment = f.adapters.comment;
      f.adapters.comment = () => { throw new Error('comment failed'); };
      expect(await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous' })).toEqual({ attempted: 1, recovered: 0, pending: 1, unresolved: 0, closed: 0 });
      expect(existsSync(join(f.dir, `${runId}.jsonl`))).toBe(true);
      // Second replay must still see the archived pr-terminal (archive ⊕ active), finish once, and not re-label.
      f.adapters.comment = comment;
      expect(await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous' })).toEqual({ attempted: 1, recovered: 1, pending: 0, unresolved: 0, closed: 0 });
      expect(f.calls.filter((call) => call.startsWith('add:'))).toHaveLength(1);
      expect(await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous' })).toEqual({ attempted: 0, recovered: 0, pending: 0, unresolved: 0, closed: 0 });
    } finally { f.cleanup(); }
  });

  test('a protected PR is left to its human: no label, no comment, no supersede, and a distinct protected effect (review r4)', async () => {
    const current = pr(200, 'self-impl/new-goalid-abc123-run', '', ['elanous:keep'], '2026-10-09T00:00:00Z');
    const f = fixture(current, [pr(100, 'self-impl/x-goalid-abc123-old')]);
    try {
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'skipped', reason: 'protected' });
      expect(f.calls.filter((call) => /^(add|set|close|comment):/.test(call))).toEqual([]);
      const effects = loadRunLedger(runId, f.dir)?.filter((entry) => entry.event === 'pr-terminal-effect').map((entry) => entry.data.effect);
      expect(effects).toContain('protected');
      expect(effects).not.toContain('complete');
      expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'skipped', reason: 'already-recorded' });
    } finally { f.cleanup(); }
  });

  test('Pod terminal → host ledger → replay closes the older Pod draft: its own pr-terminal proves its run ended (review r5)', async () => {
    const current = pr(200, 'self-impl/new-goalid-abc123-run', '', [], '2026-10-09T00:00:00Z');
    const f = fixture(current, [pr(100, 'self-impl/old-goalid-abc123-run')]);
    try {
      // The older Pod run left only a pr-terminal on the host (no pr-opened) — the realistic Pod shape.
      const older = classifyPodTerminal({ ...input, childRunId: 'run-older', disposition: { ...input.disposition, prNumber: 100, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/100' } });
      appendRunLedgerEntry({ runId: 'run-aaaaaaaa-1111-2222-3333-444444444444', event: 'pr-terminal', data: { ...older } }, f.dir);
      const ledgers = () => ['run-aaaaaaaa-1111-2222-3333-444444444444', runId].map((id) => ({ entries: loadRunLedger(id, f.dir) ?? [] }));
      expect(terminalRunStatus(100, 'ElanvitalAI/elanous', ledgers())).toBe('failed');
      expect(terminalRunStatus(100, 'someone/else', ledgers())).toBeUndefined();
      // The production getRunStatus (defaultAdapters) reads these ledgers itself — only its sources are pointed at disk.
      const ids = ['run-aaaaaaaa-1111-2222-3333-444444444444', runId];
      const sources: ResidueRunStatusSources = {
        ledgers: () => ids.map((id) => ({ runId: id, entries: loadRunLedger(id, f.dir) ?? [] })),
        running: () => ({ completeness: 'complete', entries: [] }),
      };
      f.adapters.getRunStatus = defaultAdapters(sources).getRunStatus;
      const newer = classifyPodTerminal({ ...input, disposition: { ...input.disposition, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      appendRunLedgerEntry({ runId, event: 'pr-terminal', data: { ...newer } }, f.dir);
      await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous' });
      expect(f.calls).toContain('close:100');
    } finally { f.cleanup(); }
  });

  test('an earlier run\'s pr-terminal does not settle a PR a later run is still reworking (review r6)', () => {
    const older = { runId: 'run-old', entries: [{ ts: '2026-10-09T00:00:00Z', runId: 'run-old', event: 'pr-terminal', data: { prNumber: 100, repository: 'ElanvitalAI/elanous', terminalClass: 'failed-with-pr' } }] } as never;
    const later = { runId: 'run-new', entries: [{ ts: '2026-10-09T01:00:00Z', runId: 'run-new', event: 'pr-opened', data: { number: 100, repository: 'ElanvitalAI/elanous' } }] } as never;
    const status = (running: ResidueRunStatusSources['running'], ledgers = [older, later]) =>
      defaultAdapters({ ledgers: () => ledgers, running }).getRunStatus(pr(100, 'self-impl/old-goalid-abc123-run'), 'ElanvitalAI/elanous');
    expect(status(() => ({ completeness: 'complete', entries: [{ runId: 'run-new', status: 'running' }] }))).toBe('running');
    expect(status(() => ({ completeness: 'partial', entries: [] }))).toBeUndefined();
    // The later run is in no running snapshot and has no terminal of its own → unconfirmed (review r9).
    expect(status(() => ({ completeness: 'complete', entries: [] }))).toBeUndefined();
    expect(status(() => ({ completeness: 'complete', entries: [] }), [])).toBeUndefined();
    // review r9: the later run's status is unconfirmed (no status, no own terminal) → the earlier terminal does not settle it.
    expect(status(() => ({ completeness: 'complete', entries: [{ runId: 'run-new' }] }))).toBeUndefined();
    expect(status(() => ({ completeness: 'complete', entries: [{ runId: 'run-new', status: 'completed' }] }))).toBe('failed');
  });

  test('a failed terminal whose PR merged or closed since writes nothing to GitHub and settles once (review r8)', async () => {
    for (const state of ['MERGED', 'CLOSED'] as const) {
      const f = fixture();
      try {
        const getPr = f.adapters.getPr;
        f.adapters.getPr = async (number) => { const found = await getPr(number); return found ? { ...found, state } : found; };
        const record = classifyPodTerminal(input);
        expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'skipped', reason: `pr-${state.toLowerCase()}` });
        expect(f.calls.filter((call) => /^(add|set|comment|close):/.test(call))).toEqual([]);
        expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'skipped', reason: 'already-recorded' });
      } finally { f.cleanup(); }
    }
  });

  test('production wiring: without an injected hook the Pod terminal writes one pr-terminal to the host ledger (review must-fix)', async () => {
    const state = mkdtempSync(join(tmpdir(), 'residue-wiring-'));
    const kubectl: Kubectl = (args) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((arg) => arg.includes('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      // A foreign repository (o/r): the default adapters settle it as foreign without any gh call.
      if (args.includes('logs')) return { status: 0, stdout: `${JSON.stringify({ stage: 'merge-ready', ok: true, prNumber: 9, prUrl: 'https://github.com/o/r/pull/9', checkedHeadCommit: 'c'.repeat(40) })}\n`, stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, env: { ELANOUS_STATE_DIR: state }, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'test' }), sleep: async () => {},
        hostRegate: async () => ({ passed: false, failures: [{ step: 'gate', detail: 'test failure' }], os: process.platform }), ghComment: () => {} })({ feature: 'x', spaceId: 'residue-wiring', autoMerge: true }).done;
      const dir = runLedgerDir(state);
      const terminals = readdirSync(dir).filter((file) => file.endsWith('.jsonl'))
        .flatMap((file) => loadRunLedger(file.slice(0, -'.jsonl'.length), dir) ?? []).filter((entry) => entry.event === 'pr-terminal');
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.data).toMatchObject({ prNumber: 9, repository: 'o/r', terminalClass: 'failed-with-pr' });
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  test('Pod host regate reaches the terminal hook exactly once and a throwing hook cannot change its result', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'draft-residue-pod-test', emit: (row) => {
      if (row.category === 'draft.residue') events.push({ event: row.event, data: row.data as Record<string, unknown> });
    } });
    const records: ReturnType<typeof classifyPodTerminal>[] = [];
    const kubectl: Kubectl = (args) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((arg) => arg.includes('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('logs')) return { status: 0, stdout: `${JSON.stringify({ stage: 'merge-ready', ok: true, prNumber: 9, prUrl: 'https://github.com/o/r/pull/9', checkedHeadCommit: 'b'.repeat(40) })}\n`, stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const base: PodSpawnOptions = { kubectl, env: {}, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'test' }), sleep: async () => {},
      hostRegate: async () => ({ passed: false, failures: [{ step: 'gate', detail: 'test failure' }], os: process.platform }), ghComment: () => {} };
    try {
      const good = await podSelfImplementSpawn({ ...base, draftResidue: (record) => { records.push(record); } })({ feature: 'x', spaceId: 'residue-pod-1', autoMerge: true }).done;
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ terminalClass: 'failed-with-pr', prNumber: 9 });
      expect(good).toMatchObject({ exitCode: 1, disposition: { stage: 'host-regate-failed' } });
      const failed = await podSelfImplementSpawn({ ...base, draftResidue: () => { throw new Error('test hook failed'); } })({ feature: 'x', spaceId: 'residue-pod-2', autoMerge: true }).done;
      expect(failed.exitCode).toBe(good.exitCode);
      expect(failed.disposition?.stage).toBe(good.disposition?.stage);
      expect(events.filter((row) => row.event === 'failed' && row.data.reason === 'test hook failed')).toHaveLength(1);
    } finally { off(); }
  });
});
