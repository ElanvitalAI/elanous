import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
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
  number, branch, body, labels, comments: [], createdAt, title: `Goal ${number}`, state: 'OPEN', isDraft: true, headSha: 'a'.repeat(40),
});
const fixture = (current = pr(25437, 'self-impl/main-goalid-abc123-new', '칸: CELL-A', [], '2026-10-09T00:00:00Z'), drafts: ResiduePr[] = []) => {
  const calls: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'draft-residue-'));
  const adapters: DraftResidueAdapters = {
    loadLedger: (id, path) => loadRunLedger(id, path),
    appendLedger: appendRunLedgerEntry,
    getPr: () => current, listOpenDrafts: () => drafts,
    getAllComments: () => current.comments,
    addLabel: (_repo, n, label) => { calls.push(`add:${n}:${label}`); },
    setLabels: (_repo, n, change) => {
      const draft = drafts.find((item) => item.number === n);
      if (draft) draft.labels = [...draft.labels.filter((label) => !change.remove.includes(label)), ...(change.add ? [change.add] : [])];
      calls.push(`set:${n}:${change.add}`);
    },
    comment: (_repo, n, body) => { calls.push(`comment:${n}:${body}`); if (n === current.number) current.comments = [...(current.comments ?? []), body]; },
    closePr: (_repo, n) => { calls.push(`close:${n}`); },
    listLiveBranches: () => new Set(), getRunStatus: () => 'failed',
  };
  return { calls, dir, adapters, current, drafts, ctx: { ledgerRunId: runId, ledgerDir: dir, adapters }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};
const enableSameCardSupersession = (f: ReturnType<typeof fixture>) => {
  f.current.body = '칸: CELL-A';
  for (const draft of f.drafts) draft.body = '칸: CELL-A';
  f.adapters.getPr = (number) => number === f.current.number ? f.current : f.drafts.find((draft) => draft.number === number);
  f.adapters.listPrChangedPaths = () => ['src/example.ts'];
};

describe('Pod terminal residue', () => {
  test('new code PR supersedes an ended same-card draft after checking both PR bodies', async () => {
    const current = pr(200, 'self-impl/new-goalid-def456-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-goalid-abc123-run', '칸: CELL-A');
    const f = fixture(current, [old]);
    f.adapters.getPr = (number) => number === 200 ? current : old;
    f.adapters.listPrChangedPaths = () => ['docs/goals/GOAL.md', 'src/example.ts'];
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      expect(await applyPodTerminal(record, f.ctx)).toMatchObject({ status: 'recorded' });
      expect(f.calls.filter((call) => /^(set|close):100/.test(call))).toEqual(['close:100', 'set:100:elanous:superseded']);
      expect(f.calls.some((call) => call.includes('old goalid=abc123; new goalid=def456'))).toBe(true);
      expect(await applyPodTerminal(record, f.ctx)).toMatchObject({ status: 'skipped', reason: 'already-recorded' });
      expect(f.calls.filter((call) => call === 'close:100')).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('without goalid branches, the supersession comment preserves both observed 골 ID lines', async () => {
    const current = pr(200, 'self-impl/new-run', '칸: CELL-A\n골 ID: NEW-2', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-run', '칸: CELL-A\n골 ID: OLD-1');
    const f = fixture(current, [old]);
    f.adapters.getPr = (number) => number === 200 ? current : old;
    f.adapters.listPrChangedPaths = () => ['src/example.ts'];
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('recorded');
      expect(f.calls.some((call) => call.includes('old goalid=OLD-1; new goalid=NEW-2'))).toBe(true);
    } finally { f.cleanup(); }
  });

  test('blank or duplicate card markers on either PR never identify a same-card draft', async () => {
    for (const malformed of ['칸:\nCELL-A', '칸: CELL-A\n칸: OTHER-CARD', '칸: CELL-A\n칸: CELL-A']) {
      for (const side of ['new', 'old'] as const) {
        const current = pr(200, 'self-impl/new-run', side === 'new' ? malformed : '칸: CELL-A', [], '2026-10-09T00:00:00Z');
        const old = pr(100, 'self-impl/old-run', side === 'old' ? malformed : '칸: CELL-A');
        const f = fixture(current, [old]);
        f.adapters.getPr = (number) => number === 200 ? current : old;
        f.adapters.listPrChangedPaths = () => ['src/example.ts'];
        const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
          stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
        try {
          await applyPodTerminal(record, f.ctx);
          expect(f.calls).not.toContain('close:100');
          expect(f.calls.some((call) => call.startsWith('set:100:'))).toBe(false);
        } finally { f.cleanup(); }
      }
    }
  });

  test('a Dockerfile-only PR is code-bearing for same-card draft supersession', async () => {
    const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
    const f = fixture(current, [old]);
    f.adapters.getPr = (number) => number === 200 ? current : old;
    f.adapters.listPrChangedPaths = () => ['docker/harness/Dockerfile'];
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('recorded');
      expect(f.calls).toContain('close:100');
    } finally { f.cleanup(); }
  });

  test('extensionless files do not supersede a draft without executable evidence', async () => {
    for (const [path, closes] of [['scripts/deploy', false], ['scripts/notes', false], ['scripts/deploy.sh', true]] as const) {
      const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
      const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
      const f = fixture(current, [old]);
      f.adapters.getPr = (number) => number === 200 ? current : old;
      f.adapters.listPrChangedPaths = () => [path];
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
        stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      try {
        await applyPodTerminal(record, f.ctx);
        expect(f.calls.includes('close:100')).toBe(closes);
      } finally { f.cleanup(); }
    }
  });

  test('same card alone cannot supersede a live, claimed, or goal-only draft', async () => {
    for (const [oldBranch, labels, files, runStatus] of [
      ['self-impl/old-run', [], ['src/example.ts'], 'running'],
      ['self-impl/old-run', ['elanous:running'], ['src/example.ts'], 'failed'],
      ['self-impl/old-run', ['elanous:swept:harvest-claimed'], ['src/example.ts'], 'failed'],
      ['self-impl/old-run', [], ['docs/goals/GOAL.md'], 'failed'],
      ['self-impl/old-run', [], ['.gitignore', 'assets/logo.png'], 'failed'],
    ] as const) {
      const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
      const old = pr(100, oldBranch, '칸: CELL-A', [...labels]);
      const f = fixture(current, [old]);
      f.adapters.getPr = (number) => number === 200 ? current : old;
      f.adapters.listPrChangedPaths = () => files;
      f.adapters.getRunStatus = () => runStatus;
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
        stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      try {
        await applyPodTerminal(record, f.ctx);
        expect(f.calls.some((call) => /^(set|close):100/.test(call))).toBe(false);
      } finally { f.cleanup(); }
    }
  });

  test('a prior run resumed before effects is never labelled or closed', async () => {
    const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
    const f = fixture(current, [old]);
    f.adapters.getPr = (number) => number === 200 ? current : old;
    f.adapters.listPrChangedPaths = () => ['src/example.ts'];
    let reads = 0;
    f.adapters.getRunStatus = () => ++reads === 1 ? 'failed' : 'running';
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('skipped');
      expect(f.calls.some((call) => /^(set|close):100/.test(call))).toBe(false);
    } finally { f.cleanup(); }
  });

  test('a changed previous PR head before close preserves its branch and draft', async () => {
    const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
    const f = fixture(current, [old]);
    let oldReads = 0;
    f.adapters.getPr = (number) => number === 200 ? current : (++oldReads >= 2 ? { ...old, headSha: 'b'.repeat(40) } : old);
    f.adapters.listPrChangedPaths = () => ['src/example.ts'];
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('skipped');
      expect(f.calls.some((call) => call === 'close:100')).toBe(false);
      expect(oldReads).toBeGreaterThanOrEqual(2);
    } finally { f.cleanup(); }
  });

  test('a head race leaves no supersession marker and a later code PR can retry', async () => {
    const first = pr(200, 'self-impl/first-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const second = pr(201, 'self-impl/second-run', '칸: CELL-A', [], '2026-10-10T00:00:00Z');
    const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
    const f = fixture(first, [old]);
    let oldReads = 0;
    f.adapters.getPr = (number) => {
      if (number === 100) return ++oldReads >= 2 ? { ...old, headSha: 'b'.repeat(40) } : old;
      return number === 200 ? first : second;
    };
    f.adapters.listPrChangedPaths = () => ['src/example.ts'];
    f.adapters.setLabels = (_repo, number, change) => {
      old.labels = [...old.labels.filter((label) => !change.remove.includes(label)), change.add];
      f.calls.push(`set:${number}:${change.add}`);
    };
    const terminal = (number: number, childRunId: string) => classifyPodTerminal({ ...input, childRunId,
      disposition: { ...input.disposition, stage: 'pr-opened', ok: true, prNumber: number,
        prUrl: `https://github.com/ElanvitalAI/elanous/pull/${number}` } });
    try {
      expect((await applyPodTerminal(terminal(200, runId), f.ctx)).status).toBe('skipped');
      expect(old.labels).not.toContain('elanous:superseded');
      expect(f.calls.some((call) => call.startsWith('comment:100:'))).toBe(false);
      expect(f.calls).not.toContain('close:100');
      old.headSha = 'b'.repeat(40);
      expect((await applyPodTerminal(terminal(201, 'run-22222222-2222-2222-2222-222222222222'), f.ctx)).status).toBe('recorded');
      expect(f.calls).toContain('close:100');
    } finally { f.cleanup(); }
  });

  test('a close failure leaves no new supersession label, then retries and labels the closed draft', async () => {
    const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
    const f = fixture(current, [old]);
    f.adapters.getPr = (number) => number === 200 ? current : old;
    f.adapters.listPrChangedPaths = () => ['src/example.ts'];
    f.adapters.setLabels = (_repo, number, change) => {
      old.labels = [...old.labels.filter((label) => !change.remove.includes(label)), ...(change.add ? [change.add] : [])];
      f.calls.push(`set:${number}:${change.add}`);
    };
    let closes = 0;
    f.adapters.closePr = (_repo, number) => {
      f.calls.push(`close:${number}`);
      if (++closes === 1) throw new Error('temporary close failure');
    };
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('failed');
      expect(f.calls.some((call) => call.startsWith('set:100:'))).toBe(false);
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('recorded');
      expect(f.calls.filter((call) => call === 'close:100')).toHaveLength(2);
      expect(f.calls.filter((call) => call === 'set:100:elanous:superseded')).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('a state label replaced by another run at close is not removed by supersession', async () => {
    const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-run', '칸: CELL-A', ['elanous:stalled']);
    const f = fixture(current, [old]);
    f.adapters.getPr = (number) => number === 200 ? current : old;
    f.adapters.listPrChangedPaths = () => ['src/example.ts'];
    f.adapters.closePr = (_repo, number) => {
      f.calls.push(`close:${number}`);
      old.state = 'CLOSED';
      old.labels = ['elanous:stalled']; // another writer set the same label after the pre-close read
    };
    f.adapters.setLabels = (_repo, number, change) => {
      expect(old.state).toBe('CLOSED');
      expect(change.remove).toEqual([]);
      old.labels = [...old.labels.filter((label) => !change.remove.includes(label)), change.add];
      f.calls.push(`set:${number}:${change.add}`);
    };
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('recorded');
      expect(old.labels).toEqual(['elanous:stalled', 'elanous:superseded']);
      expect(f.calls).toContain('close:100');
    } finally { f.cleanup(); }
  });

  test('a new head or harvest claim during the supersession comment restores the label and leaves the draft open', async () => {
    for (const change of ['head', 'claim'] as const) {
      const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
      const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
      const f = fixture(current, [old]);
      f.adapters.listOpenDrafts = () => [{ ...old, labels: [...old.labels] }];
      f.adapters.getPr = (number) => number === 200 ? current : old;
      f.adapters.listPrChangedPaths = () => ['src/example.ts'];
      f.adapters.setLabels = (_repo, number, update) => {
        old.labels = [...old.labels.filter((label) => !update.remove.includes(label)), ...(update.add ? [update.add] : [])];
        f.calls.push(`set:${number}:${update.add}`);
      };
      f.adapters.comment = (_repo, number, body) => {
        f.calls.push(`comment:${number}:${body}`);
        if (number === 100 && body.includes('superseded-by')) {
          if (change === 'head') old.headSha = 'b'.repeat(40);
          else old.labels = [...old.labels, 'elanous:swept:harvest-claimed'];
        }
      };
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
        stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      try {
        expect((await applyPodTerminal(record, f.ctx)).status).toBe('skipped');
        expect(f.calls).not.toContain('close:100');
        expect(old.labels).not.toContain('elanous:superseded');
        expect(f.calls.some((call) => call.includes('supersession by #200 deferred'))).toBe(true);
      } finally { f.cleanup(); }
    }
  });

  test('a pre-existing superseded label from another run survives this run losing its close race', async () => {
    const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-run', '칸: CELL-A', ['elanous:superseded']);
    const f = fixture(current, [old]);
    f.adapters.listOpenDrafts = () => [{ ...old, labels: [...old.labels] }];
    f.adapters.getPr = (number) => number === 200 ? current : old;
    f.adapters.listPrChangedPaths = () => ['src/example.ts'];
    f.adapters.comment = (_repo, number, body) => {
      f.calls.push(`comment:${number}:${body}`);
      if (number === 100 && body.includes('superseded-by')) old.headSha = 'b'.repeat(40);
    };
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      // A previous attempt can have recorded this effect, compensated it, then another run
      // added the same label. The effect row cannot prove ownership in this attempt.
      appendRunLedgerEntry({ runId, event: 'pr-terminal-effect', data: {
        childRunId: record.childRunId, effect: 'superseded-label', number: 100 } }, f.dir);
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('skipped');
      expect(f.calls).not.toContain('close:100');
      expect(f.calls.some((call) => call.startsWith('set:100:'))).toBe(false);
      expect(old.labels).toContain('elanous:superseded');
    } finally { f.cleanup(); }
  });

  test('a label added after the draft inventory is not claimed or restored by this run', async () => {
    for (const added of ['elanous:superseded', 'elanous:swept:harvest-claimed']) {
      const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
      const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
      const f = fixture(current, [old]);
      let oldReads = 0;
      f.adapters.listOpenDrafts = () => [{ ...old, labels: [] }];
      f.adapters.getPr = (number) => {
        if (number === 200) return current;
        if (++oldReads === 3) old.labels = [...old.labels, added];
        return old;
      };
      f.adapters.listPrChangedPaths = () => ['src/example.ts'];
      f.adapters.comment = (_repo, number, body) => {
        f.calls.push(`comment:${number}:${body}`);
        if (number === 100 && body.includes('superseded-by')) old.headSha = 'b'.repeat(40);
      };
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
        stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      try {
        expect((await applyPodTerminal(record, f.ctx)).status).toBe('skipped');
        expect(f.calls).not.toContain('close:100');
        expect(f.calls.some((call) => call.startsWith('set:100:'))).toBe(false);
        expect(old.labels).toContain(added);
      } finally { f.cleanup(); }
    }
  });

  test('a competing superseded label during the post-close write is never removed on write failure', async () => {
    const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
    const f = fixture(current, [old]);
    enableSameCardSupersession(f);
    f.adapters.setLabels = (_repo, number) => {
      old.labels = [...old.labels, 'elanous:superseded'];
      f.calls.push(`set:${number}:failed`);
      throw new Error('concurrent label write');
    };
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('recorded');
      expect(f.calls.filter((call) => call.startsWith('set:100:'))).toEqual(['set:100:failed']);
      expect(f.calls).toContain('close:100');
      expect(old.labels).toContain('elanous:superseded');
      expect((await applyPodTerminal(record, f.ctx)).reason).toBe('already-recorded');
    } finally { f.cleanup(); }
  });

  test('a new PR head moving during the final post-effect diff read leaves the old draft open', async () => {
    const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
    const f = fixture(current, [old]);
    let moved = false;
    let diffReads = 0;
    f.adapters.getPr = (number) => number === 100 ? old : moved ? { ...current, headSha: 'b'.repeat(40) } : current;
    f.adapters.listPrChangedPaths = () => { if (++diffReads === 3) moved = true; return ['src/example.ts']; };
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('skipped');
      expect(diffReads).toBe(3);
      expect(f.calls).not.toContain('close:100');
      expect(old.labels).not.toContain('elanous:superseded');
    } finally { f.cleanup(); }
  });

  test('a lookup error after the supersession comment compensates its label and retries', async () => {
    const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
    const f = fixture(current, [old]);
    let interrupted = false;
    f.adapters.getPr = (number) => {
      if (number === 200) return current;
      if (!interrupted && f.calls.some((call) => call.startsWith('comment:100:Draft residue: superseded-by'))) {
        interrupted = true;
        throw new Error('temporary GitHub lookup failure');
      }
      return old;
    };
    f.adapters.listPrChangedPaths = () => ['src/example.ts'];
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('failed');
      expect(f.calls).not.toContain('close:100');
      expect(old.labels).not.toContain('elanous:superseded');
      expect(f.calls.some((call) => call.includes('supersession by #200 deferred after an interrupted check'))).toBe(true);
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('recorded');
      expect(f.calls).toContain('close:100');
    } finally { f.cleanup(); }
  });

  test('an unobserved previous PR head never receives a supersede label or close', async () => {
    const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = { ...pr(100, 'self-impl/old-run', '칸: CELL-A'), headSha: undefined };
    const f = fixture(current, [old]);
    f.adapters.getPr = (number) => number === 200 ? current : old;
    f.adapters.listPrChangedPaths = () => ['src/example.ts'];
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      await applyPodTerminal(record, f.ctx);
      expect(f.calls.some((call) => /^(set|close):100/.test(call))).toBe(false);
    } finally { f.cleanup(); }
  });

  test('a new PR head change before, after, or after measuring files never closes the prior draft', async () => {
    for (const changeAt of [2, 3, 4]) {
      const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
      const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
      const f = fixture(current, [old]);
      let currentReads = 0;
      f.adapters.getPr = (number) => number === 100 ? old
        : (++currentReads >= changeAt ? { ...current, headSha: 'b'.repeat(40) } : current);
      f.adapters.listPrChangedPaths = () => ['src/example.ts'];
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
        stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      try {
        expect((await applyPodTerminal(record, f.ctx)).status).toBe('skipped');
        expect(f.calls).not.toContain('close:100');
      } finally { f.cleanup(); }
    }
  });

  test('a moved base that removes code from the new PR diff preserves the previous draft', async () => {
    const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
    const f = fixture(current, [old]);
    f.adapters.getPr = (number) => number === 200 ? current : old;
    let diffReads = 0;
    f.adapters.listPrChangedPaths = () => ++diffReads === 1 ? ['src/example.ts', 'docs/goals/GOAL.md'] : ['docs/goals/GOAL.md'];
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('skipped');
      expect(diffReads).toBe(2);
      expect(f.calls).not.toContain('close:100');
    } finally { f.cleanup(); }
  });

  test('a new PR head moving during the final diff read cannot close the previous draft', async () => {
    const current = pr(200, 'self-impl/new-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-run', '칸: CELL-A');
    const f = fixture(current, [old]);
    let moved = false;
    f.adapters.getPr = (number) => number === 200 && moved ? { ...current, headSha: 'b'.repeat(40) } : number === 200 ? current : old;
    let diffReads = 0;
    f.adapters.listPrChangedPaths = () => { if (++diffReads === 2) moved = true; return ['src/example.ts']; };
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('skipped');
      expect(diffReads).toBe(2);
      expect(f.calls).not.toContain('close:100');
    } finally { f.cleanup(); }
  });

  test('a new PR without a card line cannot supersede by matching goal ID alone', async () => {
    const current = pr(200, 'self-impl/new-goalid-abc123-run', '', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-goalid-abc123-run', '칸: CELL-A');
    const f = fixture(current, [old]);
    f.adapters.getPr = (number) => number === 200 ? current : old;
    f.adapters.listPrChangedPaths = () => ['src/example.ts'];
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      stage: 'pr-opened', ok: true, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('recorded');
      expect(f.calls).not.toContain('close:100');
    } finally { f.cleanup(); }
  });

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
      expect(f.calls).toEqual([`add:25437:elanous:harvestable`, expect.stringContaining('comment:25437:Draft residue: failed-with-pr · owner=TC(seat)'),
        expect.stringContaining('comment:25437:Draft residue: failed-run recovery')]);
      expect(f.calls.some((call) => call === 'close:25437')).toBe(false);
      const count = f.calls.length;
      expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'skipped', reason: 'already-recorded' });
      expect(f.calls).toHaveLength(count);
      expect(loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal')).toHaveLength(1);
      expect(events.filter((row) => row.event === 'skipped' && row.data.reason === 'already-recorded')).toHaveLength(1);
    } finally { off(); f.cleanup(); }
  });

  test('a changed head, missing branch, failed lookup or landing claim leaves the restoration pointer pending', async () => {
    for (const change of ['head', 'claim', 'ready', 'empty-branch', 'lookup-error'] as const) {
      const current = pr(25437, 'self-impl/main-goalid-abc123-new', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
      const f = fixture(current);
      try {
        let reads = 0;
        if (change === 'claim') current.comments = ['landing-verified: #25437'];
        f.adapters.getPr = () => {
          reads++;
          if (reads === 1 || change === 'claim') return current;
          if (change === 'lookup-error') throw new Error('transient GitHub lookup');
          if (change === 'head') return { ...current, headSha: 'b'.repeat(40) };
          if (change === 'empty-branch') return { ...current, branch: '' };
          return { ...current, isDraft: false };
        };
        expect(await applyPodTerminal(classifyPodTerminal(input), f.ctx)).toEqual({ status: 'skipped', reason: 'restore-unverified' });
        expect(reads).toBeGreaterThanOrEqual(2);
        expect(f.calls.some((call) => call.includes('failed-run recovery'))).toBe(false);
        expect(f.calls.some((call) => call === 'close:25437')).toBe(false);
        expect(loadRunLedger(runId, f.dir)?.some((entry) => entry.event === 'pr-terminal-effect' && entry.data.effect === 'complete')).toBe(false);
        expect(await replayPodTerminals({ ledgerDir: f.dir, adapters: f.adapters, repository: 'ElanvitalAI/elanous' }))
          .toEqual({ attempted: 1, recovered: 0, pending: 1, unresolved: 0, closed: 0 });
      } finally { f.cleanup(); }
    }
  });

  test('an incomplete comment inventory cannot prove a landing claim is absent', async () => {
    const f = fixture();
    try {
      f.adapters.getAllComments = () => undefined;
      expect(await applyPodTerminal(classifyPodTerminal(input), f.ctx)).toEqual({ status: 'skipped', reason: 'restore-unverified' });
      expect(f.calls.some((call) => call.includes('failed-run recovery'))).toBe(false);
    } finally { f.cleanup(); }
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
    expect(classifyPodTerminal({ ...input, disposition: { ...input.disposition, branch: 'self-impl/with-pr' } }).branch).toBe('self-impl/with-pr');
    for (const record of [merged, noPr, unobserved]) {
      const f = fixture();
      try { await applyPodTerminal(record, f.ctx); expect(f.calls.some((call) => call.includes('harvestable'))).toBe(false); }
      finally { f.cleanup(); }
    }
  });

  test('timed-out stage with a branch and no PR classifies as timed-out-harvestable and carries branch (AUT-TIMEOUT-NO-HARVEST)', async () => {
    const timedOut = classifyPodTerminal({
      childRunId: runId, state: 'failed',
      disposition: { stage: 'timed-out', ok: false, branch: 'self-impl/timeout-goalid-abc123-run' },
      env: { ELANOUS_HARNESS_SEAT: 'TC' }, at: '2026-10-09T12:00:00Z',
    });
    expect(timedOut).toMatchObject({
      terminalClass: 'timed-out-harvestable',
      branch: 'self-impl/timeout-goalid-abc123-run',
      prNumber: null,
      stage: 'timed-out',
    });
    expect(classifyPodTerminal({ ...input, disposition: { stage: 'abandoned', ok: false } }).terminalClass).toBe('failed-no-pr');
    expect(classifyPodTerminal(input).terminalClass).toBe('failed-with-pr');
    expect(classifyPodTerminal({ ...input, disposition: { ...input.disposition, merged: true } }).terminalClass).toBe('landed');
    expect(classifyPodTerminal({ childRunId: runId, state: 'failed', disposition: { stage: 'timed-out', ok: false } }).terminalClass).toBe('failed-no-pr');
    expect(classifyPodTerminal({
      childRunId: runId, state: 'failed',
      disposition: { ...input.disposition, stage: 'timed-out', ok: false, branch: 'self-impl/with-pr' },
    }).terminalClass).toBe('failed-with-pr');
    const f = fixture();
    try {
      // 첫 조각은 분류만 — apply 는 PR 이 없으니 지금처럼 건너뛰고 gh 효과 0.
      expect(await applyPodTerminal(timedOut, f.ctx)).toMatchObject({ status: 'skipped' });
      expect(f.calls.some((call) => call.includes('harvestable'))).toBe(false);
      expect(loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ terminalClass: 'timed-out-harvestable', branch: 'self-impl/timeout-goalid-abc123-run' }) }),
      ]);
    } finally { f.cleanup(); }
  });

  test('host-regate failure reason survives classification and the pr-terminal ledger row (AUT-HOST-REGATE-REASON-LOST)', async () => {
    const rawDetail = `error\n  TS2345:   Argument of type 'string' is not assignable to parameter of type 'number'. ${'noise '.repeat(120)}`;
    const folded = rawDetail.split(/\s+/).filter(Boolean).join(' ');
    const failed = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      hostRegate: { passed: false, failures: [{ step: 'typecheck', detail: rawDetail }], os: 'ubuntu-24.04' } } });
    expect(failed.hostRegateFailure).toEqual({ step: 'typecheck', detail: folded, os: 'ubuntu-24.04' });
    // HOST-REGATE-REASON-LOST (2nd): the ~800-char detail is no longer cut at 300 — the whole folded text survives.
    expect(failed.hostRegateFailure?.detail.length).toBeGreaterThan(300);
    // A merge failure keeps its tail (the GraphQL reason), the heads and the kind; a long detail stays bounded.
    const reason = 'GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)';
    const merge = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      hostRegate: { passed: false, os: 'darwin', failures: [{ step: 'merge', detail: `Error: ${'x'.repeat(9000)} ${reason}`,
        expectedHead: 'a'.repeat(40), actualHead: 'a'.repeat(40), mergeFailureKind: 'base-modified' }] } } });
    expect(merge.hostRegateFailure).toMatchObject({ step: 'merge', expectedHead: 'a'.repeat(40), actualHead: 'a'.repeat(40), mergeFailureKind: 'base-modified', os: 'darwin' });
    expect(merge.hostRegateFailure?.detail.endsWith(reason)).toBe(true);
    expect(merge.hostRegateFailure?.detail.length).toBeLessThanOrEqual(4096);
    const conflict = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      hostRegate: { passed: false, os: 'darwin', failures: [{ step: 'merge-conflict', detail: 'CONFLICT', conflictFiles: ['src/a.ts', 'src/b.ts'], actualHead: 'not-a-sha' }] } } });
    expect(conflict.hostRegateFailure).toEqual({ step: 'merge-conflict', detail: 'CONFLICT', conflictFiles: ['src/a.ts', 'src/b.ts'], os: 'darwin' });
    const empty = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      hostRegate: { passed: false, failures: [], os: 'ubuntu-24.04' } } });
    expect(empty.hostRegateFailure).toEqual({ step: 'unknown', detail: 'failures empty', os: 'ubuntu-24.04' });
    const others = [
      classifyPodTerminal({ ...input, disposition: { ...input.disposition, stage: 'landed', merged: true, ok: true,
        hostRegate: { passed: false, failures: [{ step: 'typecheck', detail: rawDetail }], os: 'ubuntu-24.04' } } }),
      classifyPodTerminal({ ...input, disposition: { ...input.disposition, stage: 'gate-failed', ok: false,
        hostRegate: { passed: false, failures: [{ step: 'isolation-gate', detail: rawDetail }], os: 'ubuntu-24.04' } } }),
      classifyPodTerminal({ ...input, disposition: { ...input.disposition } }),
      classifyPodTerminal({ ...input, disposition: { ...input.disposition,
        hostRegate: { passed: true, failures: [], os: 'ubuntu-24.04' } } }),
    ];
    expect(others.map((record) => record.hostRegateFailure)).toEqual([null, null, null, null]);
    const f = fixture();
    try {
      expect(await applyPodTerminal(failed, f.ctx)).toEqual({ status: 'recorded' });
      const terminals = loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal');
      expect(terminals).toEqual([expect.objectContaining({ data: expect.objectContaining({
        childRunId: runId, hostRegateFailure: { step: 'typecheck', detail: folded, os: 'ubuntu-24.04' } }) })]);
    } finally { f.cleanup(); }
  });

  test('a card-marked new PR leaves old drafts without that exact card marker untouched', async () => {
    const current = pr(200, 'self-impl/new-goalid-abc123-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const f = fixture(current, [
      pr(100, 'self-impl/x-goalid-abc123-old'), pr(101, 'self-impl/y-goalid-beef12-old'),
      pr(102, 'self-impl/z-goalid-abc123-old', '', ['elanous:keep']),
      pr(103, 'self-impl/other-old', '칸: CELL-A'),
    ]);
    try {
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition, prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('skipped');
      expect(f.calls.filter((call) => /^(set|close):/.test(call))).toEqual([]);
      // Old #100 has a matching goal ID but no card marker; #103 has the card marker but no measured code diff.
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

  test('a landed newer code PR still supersedes an ended same-card draft without harvestable marking', async () => {
    const current = pr(200, 'self-impl/new-goalid-abc123-run', '', [], '2026-10-09T00:00:00Z');
    const f = fixture(current, [pr(100, 'self-impl/old-goalid-abc123-run')]);
    enableSameCardSupersession(f);
    try {
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition, merged: true,
        prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      expect((await applyPodTerminal(record, f.ctx)).status).toBe('recorded');
      expect(f.calls.filter((call) => /^(set|close):/.test(call))).toEqual(['close:100', 'set:100:elanous:superseded']);
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

  test('compensates a partial GitHub failure and resumes without duplicating the terminal fact', async () => {
    const current = pr(200, 'self-impl/new-goalid-abc123-run', '칸: CELL-A', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-goalid-abc123-run', '칸: CELL-A');
    const f = fixture(current, [old]);
    const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
      prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
    try {
      f.adapters.getPr = (number) => number === 200 ? current : old;
      f.adapters.listPrChangedPaths = () => ['src/example.ts'];
      const close = f.adapters.closePr;
      f.adapters.closePr = () => { throw new Error('transient close'); };
      expect(await applyPodTerminal(record, f.ctx)).toMatchObject({ status: 'failed', step: 'close-pr' });
      expect(f.calls.filter((call) => call.startsWith('set:100:'))).toHaveLength(0);
      f.adapters.closePr = close;
      expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'recorded' });
      expect(f.calls.filter((call) => call.startsWith('add:200:'))).toHaveLength(1);
      expect(f.calls.filter((call) => call.startsWith('comment:200:'))).toHaveLength(2);
      expect(f.calls.filter((call) => call.startsWith('set:100:'))).toHaveLength(1);
      expect(f.calls.filter((call) => call.startsWith('comment:100:'))).toHaveLength(2);
      expect(old.labels).toContain('elanous:superseded');
      expect(f.calls.filter((call) => call.startsWith('close:100'))).toHaveLength(1);
      expect(loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal')).toHaveLength(1);
      expect(await applyPodTerminal(record, f.ctx)).toEqual({ status: 'skipped', reason: 'already-recorded' });
    } finally { f.cleanup(); }
  });

  test('prior comment retries, while post-close label failure leaves the draft closed without removing a label', async () => {
    for (const failure of ['setLabels', 'comment'] as const) {
      const current = pr(200, 'self-impl/new-goalid-abc123-run', '', [], '2026-10-09T00:00:00Z');
      const f = fixture(current, [pr(100, 'self-impl/old-goalid-abc123-run')]);
      enableSameCardSupersession(f);
      const record = classifyPodTerminal({ ...input, disposition: { ...input.disposition,
        prNumber: 200, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/200' } });
      try {
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
        expect((await applyPodTerminal(record, f.ctx)).status).toBe(failure === 'comment' ? 'failed' : 'recorded');
        (f.adapters as unknown as Record<string, unknown>)[failure] = original;
        expect(await applyPodTerminal(record, f.ctx)).toEqual(failure === 'comment'
          ? { status: 'recorded' } : { status: 'skipped', reason: 'already-recorded' });
        expect(f.calls.filter((call) => call.startsWith('add:200:'))).toHaveLength(1);
        expect(f.calls.filter((call) => call.startsWith('comment:200:'))).toHaveLength(2);
        expect(f.drafts[0]!.labels.includes('elanous:superseded')).toBe(failure === 'comment');
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
      expect(f.calls.filter((call) => call.startsWith('comment:25437:'))).toHaveLength(2);
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
        expect(f.calls.filter((call) => call.startsWith('comment:25437:'))).toHaveLength(2);
        expect(loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal')).toHaveLength(1);
      } finally { f.cleanup(); }
    }
  });

  test('does not strip a running draft or close it when liveness or run status cannot be verified', async () => {
    const f = fixture(pr(200, 'self-impl/new-goalid-abc123-run', '', [], '2026-10-09T00:00:00Z'),
      [pr(100, 'self-impl/old-goalid-abc123-run')]);
    enableSameCardSupersession(f);
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
      expect(f.calls.filter((call) => /^(set|close):100/.test(call))).toEqual(['close:100', 'set:100:elanous:superseded']);
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
      closeDraft: async (...args) => {
        expect(args).toHaveLength(2);
        closed.push(`close:${args[1]}`);
      },
    };
    const result = await runDraftSweep({ repository: 'o/r', adapters, apply: true, now });
    expect(result.entries.map(({ action, reason }) => ({ action, reason }))).toEqual([
      { action: 'keep', reason: 'harvestable' }, { action: 'close', reason: 'harvest-expired' }, { action: 'keep', reason: 'unobserved' },
    ]);
    expect(result.unobserved).toBe(1);
    expect(closed).toEqual([
      'label:2:elanous:stalled',
      'label:2:elanous:swept:harvest-expired',
      'close:2',
    ]);
  });

  test('supersede close cap leaves remaining drafts pending for the next replay without closing twice', async () => {
    const current = pr(200, 'self-impl/new-goalid-abc123-run', '', [], '2026-10-09T00:00:00Z');
    const drafts = Array.from({ length: 12 }, (_, i) => pr(i + 1, `self-impl/old-goalid-abc123-${i}`));
    const f = fixture(current, drafts);
    enableSameCardSupersession(f);
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
    enableSameCardSupersession(f);
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
      expect(f.calls).toEqual([`add:25437:elanous:harvestable`, expect.stringContaining('comment:25437:Draft residue:'),
        expect.stringContaining('comment:25437:Draft residue: failed-run recovery')]);
      await tick();
      expect(f.calls).toHaveLength(3);
      expect(loadRunLedger(runId, f.dir)?.filter((row) => row.event === 'pr-terminal')).toHaveLength(1);
      expect(writes).toHaveLength(3);
    } finally { f.cleanup(); process.exitCode = 0; }
  });

  test('harness sweep rechecks prior-run termination on each retry, then supersedes once', async () => {
    const current = pr(200, 'self-impl/new-goalid-abc123-run', '', [], '2026-10-09T00:00:00Z');
    const old = pr(100, 'self-impl/old-goalid-abc123-run');
    const f = fixture(current, [old]);
    enableSameCardSupersession(f);
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
      expect(f.calls.filter((call) => /^(set|close):100/.test(call))).toEqual(['close:100', 'set:100:elanous:superseded']);
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
    enableSameCardSupersession(f);
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

  test('default comment reader requires complete paginated issue comments', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'draft-residue-gh-comments-'));
    writeFileSync(join(binDir, 'gh'), [
      `#!${process.execPath}`,
      `if (!process.argv.includes('--paginate') || !process.argv.includes('--slurp')) process.exit(4);`,
      `process.stdout.write(JSON.stringify([[{ body: 'owner' }], [{ body: 'landing-verified: #25437' }]]));`,
    ].join('\n'));
    chmodSync(join(binDir, 'gh'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${previousPath ? `:${previousPath}` : ''}`;
    try {
      expect(await defaultAdapters().getAllComments?.('ElanvitalAI/elanous', 25437))
        .toEqual(['owner', 'landing-verified: #25437']);
    } finally {
      process.env.PATH = previousPath;
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test('default adapter lists hundreds of open drafts carrying large bodies across paginated gh pages — no spawnSync ENOBUFS (DRAFT-RESIDUE-ENOBUFS)', async () => {
    // 350 open PRs × 24 KiB bodies → each 100-item REST page is ~2.4 MiB, far past the 1 MiB spawnSync default
    // that produced the daily `spawnSync gh ENOBUFS`. The listing must still come back whole (DRAFT-RESIDUE-ENOBUFS).
    const binDir = mkdtempSync(join(tmpdir(), 'draft-residue-gh-pages-'));
    writeFileSync(join(binDir, 'gh'), [
      `#!${process.execPath}`,
      `const arg = process.argv.find((a) => a.startsWith('repos/')) || '';`,
      `const page = Number(new URLSearchParams(arg.split('?')[1] || '').get('page') || '1');`,
      `const rows = [];`,
      `for (let i = (page - 1) * 100; i < page * 100 && i < 350; i++) {`,
      `  rows.push({ number: i + 1, title: 'Goal ' + (i + 1), headRefName: 'self-impl/br-' + (i + 1), createdAt: '2026-10-14T00:00:00Z',`,
      `    body: 'b'.repeat(24576), labels: [{ name: 'elanous:harvestable' }], draft: true });`,
      `}`,
      `// page 1 also carries a non-draft PR — it must never surface in the open-draft inventory`,
      `if (page === 1) rows.push({ number: 900001, title: 'human PR', headRefName: 'main', createdAt: '2026-10-14T00:00:00Z', body: '', labels: [], draft: false });`,
      `process.stdout.write(JSON.stringify(rows));`,
    ].join('\n'));
    chmodSync(join(binDir, 'gh'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${previousPath ? `:${previousPath}` : ''}`;
    try {
      const drafts = await defaultAdapters().listOpenDrafts('ElanvitalAI/elanous');
      expect(drafts).toHaveLength(350);
      expect(drafts?.every((draft) => draft.number >= 1 && draft.number <= 350)).toBe(true);
      expect(drafts?.every((draft) => (draft.body ?? '').length === 24576)).toBe(true);
      expect(drafts?.[0]).toMatchObject({ number: 1, branch: 'self-impl/br-1', labels: ['elanous:harvestable'] });
    } finally {
      process.env.PATH = previousPath;
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test('a failed open-draft listing is «못 셍음» — undefined with an unobserved event, never a disguised zero (DRAFT-RESIDUE-ENOBUFS)', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'draft-residue-gh-fail-'));
    writeFileSync(join(binDir, 'gh'), [
      `#!${process.execPath}`,
      `process.stderr.write('gh: API rate limit exceeded\\n');`,
      `process.exitCode = 1;`,
    ].join('\n'));
    chmodSync(join(binDir, 'gh'), 0o755);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'draft-residue-unobserved-test', emit: (row) => {
      if (row.category === 'draft.residue' && row.event === 'list-open-drafts-unobserved') events.push({ event: row.event, data: row.data as Record<string, unknown> });
    } });
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${previousPath ? `:${previousPath}` : ''}`;
    try {
      const drafts = await defaultAdapters().listOpenDrafts('ElanvitalAI/elanous');
      // Unmeasurable, not zero: no array, no count — nothing downstream may read a failed listing as "0 open drafts".
      expect(drafts).toBeUndefined();
      expect(Array.isArray(drafts)).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0]?.data).toMatchObject({ repository: 'ElanvitalAI/elanous' });
      expect(String(events[0]?.data.reason)).toContain('gh: API rate limit exceeded');
    } finally {
      off();
      process.env.PATH = previousPath;
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
