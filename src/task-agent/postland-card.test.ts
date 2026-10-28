import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeMergedTaskCard, reconcileHandMergedCard, type LandedTaskPr } from './postland-card.js';
import { syncMergedPrChecklistWithFeedback } from '../release-loop/merged-pr-checklist.js';
import { selectRelevantAuthoringLessons } from '../self-implement/knowhow-pack.js';
import { recordFollowUpOnMerge, type FollowUpDraftRecord } from '../self-implement/follow-up-goals.js';
import { executeLiveLand } from './live-moves.js';
import { judgeLandedCell } from '../release-loop/landed-to-green.js';
import { updateTaskCard, type TaskCard } from './task-hand.js';
import type { Checklist, ChecklistItem } from '../release-loop/checklist.js';

const head = 'a'.repeat(40);
const pr: LandedTaskPr = { number: 79, url: 'https://github.com/example/repo/pull/79', headRefOid: head, state: 'MERGED', baseRefName: 'main', mergedAt: '2026-10-13T00:00:00Z', files: [{ path: 'src/feature.ts' }] };

function fixture(title: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ta-postland-'));
  const statePath = join(dir, 'task-agent-actions.json');
  const card: TaskCard = { id: 'ta-79', text: 'implement', createdAt: '2026-10-12T00:00:00Z', status: 'launched', history: [], checklistId: 'CELL', pr: { number: 79, url: pr.url }, taLand: true,
    landAttempts: [{ pr: 79, head, at: '2026-10-13T00:00:00Z' }] };
  writeFileSync(statePath, JSON.stringify({ tasks: { [card.id]: card } }));
  const item: ChecklistItem = { id: 'CELL', title, status: 'yellow', evidence: 'prior proof', updatedAt: '', updatedBy: '' };
  const snapshot: Checklist = { version: '0.2.28', released: '0.2.27', dev: '0.2.27-dev.0', items: [item], history: [] };
  const writes: Array<{ status?: string; evidence?: string; expectedTitle?: string }> = [];
  const deps = { statePath, versions: ['0.2.28'], checklist: () => snapshot,
    setStatus: (_version: string, _id: string, patch: { status?: string; evidence?: string }, _by: string, expected: Pick<ChecklistItem, 'title' | 'status' | 'evidence'>) => {
      if (expected.title !== item.title || expected.status !== item.status || expected.evidence !== item.evidence) throw new Error('cell changed during judgment');
      writes.push({ ...patch, expectedTitle: expected.title }); item.evidence = patch.evidence; if (patch.status) item.status = patch.status as ChecklistItem['status'];
      return snapshot;
    },
    log: () => {},
  };
  return { dir, statePath, card, item, writes, deps, read: () => JSON.parse(readFileSync(statePath, 'utf8')).tasks['ta-79'] };
}

describe('TA postland cell and card closure', () => {
  test('bound merged PR body reaches the postland feedback ledger', async () => {
    const f = fixture('판정 신호: 조건=focused; 관측=bun test feature.test.ts; 기대=0 fail');
    const prior = process.env.ELANOUS_STATE_DIR;
    const runId = 'run-0123456789abcdef0123456789abcdef';
    process.env.ELANOUS_STATE_DIR = f.dir;
    try {
      f.card.runId = runId;
      f.card.goalId = 'CELL';
      f.card.text = 'implement src/feature.ts';
      writeFileSync(f.statePath, JSON.stringify({ tasks: { [f.card.id]: f.card } }));
      const mergedPr = { ...pr, body: '칸: CELL\n\n## 구현이 밝힌 요구사항\n- preserve the feature boundary\n\n## 새 범위\n- src/feature.ts\n\n## 남은 것\n- add the follow-up test\n' };
      const followUpDrafts: FollowUpDraftRecord[] = [];
      const sync = () => syncMergedPrChecklistWithFeedback(79, f.dir, undefined, {
        readPr: () => ({ ...mergedPr, title: 'feature merge', mergedAt: pr.mergedAt }),
        versions: () => ['0.2.28'], checklist: f.deps.checklist,
        setStatus: f.deps.setStatus,
        candidateTaskCells: () => ['CELL'], boundTaskCells: () => ['CELL'],
        closeTaskCard: (merged, cwd, options) => closeMergedTaskCard(merged, cwd, {
          ...options, statePath: f.statePath, checklist: f.deps.checklist, setStatus: f.deps.setStatus, judge: () => 'proposed', log: () => {},
        }),
        feedbackStatePath: f.statePath,
        feedbackFollowUp: (input) => recordFollowUpOnMerge(input, {
          stateRoot: f.dir, mode: 'shadow', readDrafts: () => followUpDrafts,
          appendDraft: (row) => { followUpDrafts.push(row); },
        }),
      });
      const first = await sync();
      const second = await sync();
      const entries = readFileSync(join(f.dir, 'run-ledger', `${runId}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const feedback = entries.filter((entry) => entry.event === 'impl-findings-feedback');
      expect(feedback).toHaveLength(1);
      expect(feedback[0].data.requirements).toContain('preserve the feature boundary');
      expect(feedback[0].data.paths).toContain('src/feature.ts');
      expect(first?.appended).toBe(true);
      expect(second?.appended).toBe(false);
      expect(first?.authoringInjection).toContain('preserve the feature boundary');
      expect(first?.followUp?.queued).toBe(false);
      expect(first?.followUp?.draft).toContain('add the follow-up test');
      expect(followUpDrafts).toHaveLength(1);
      expect(f.read().postLand.outcome).toBe('complete');
      expect(entries.find((entry) => entry.event === 'impl-findings-feedback')?.data.requirements).toContain('preserve the feature boundary');
      expect(selectRelevantAuthoringLessons(f.dir, 'next task src/feature.ts', f.dir).prompt).toContain('preserve the feature boundary');
    } finally {
      if (prior === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prior;
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('goal-only merged PR cannot make the TA card or release cell green', () => {
    const f = fixture('판정 신호: 조건=focused; 관측=bun test feature.test.ts; 기대=0 fail');
    try {
      const result = closeMergedTaskCard({ ...pr, files: [{ path: 'docs/goals/GOAL-feature.md' }] }, f.dir,
        { ...f.deps, judge: () => { throw new Error('goal-only must not reach judge'); } });
      expect(result).toBeNull();
      expect(f.writes).toHaveLength(0);
      expect(f.item.status).toBe('yellow');
      expect(f.read().status).toBe('launched');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
  test('green only on a passed explicit judge signal; repeat merge is idempotent', () => {
    const f = fixture('판정 신호: 조건=focused; 관측=bun test feature.test.ts; 기대=0 fail');
    try {
      const deps = { ...f.deps, judge: (cell: Parameters<typeof judgeLandedCell>[0], options: Parameters<typeof judgeLandedCell>[1]) =>
        judgeLandedCell(cell, { ...options, ledgerRoot: f.dir, run: () => 0 }) };
      closeMergedTaskCard(pr, f.dir, deps);
      closeMergedTaskCard(pr, f.dir, deps);
      expect(f.writes).toHaveLength(1);
      expect(f.item.status).toBe('green');
      expect(f.item.evidence).toContain('bun test feature.test.ts → exit 0');
      expect(f.read().postLand).toMatchObject({ outcome: 'complete', pr: 79, head });
      expect(f.read().prTerminal).toMatchObject({ state: 'MERGED', pr: 79 });
      expect(f.read().status).toBe('done');
      expect(f.read().history).toHaveLength(1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('unmeasured natural-language criterion stays yellow, records filled and remaining with retitle candidate', () => {
    const f = fixture('대상 경로: src/feature.ts\n판정: live sample 1 and focused 0 fail');
    try {
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: (cell, options) => judgeLandedCell(cell, { ...options, ledgerRoot: f.dir, run: () => 0 }) });
      expect(String(f.item.status)).toBe('yellow');
      expect(f.item.evidence).toContain('이 조각이 채운 것: PR #79 merged');
      expect(f.item.evidence).toContain('남은 것: 판정: live sample 1');
      expect(f.item.evidence).toContain('다음 조각 retitle 후보:');
      expect(f.read().postLand).toMatchObject({ outcome: 'partial', remaining: ['판정: live sample 1 and focused 0 fail'] });
      expect(f.read().status).toBe('done');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a real judge signal whose focused test fails remains yellow', () => {
    const f = fixture('판정 신호: 조건=focused; 관측=bun test feature.test.ts; 기대=0 fail');
    try {
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: (cell, options) => judgeLandedCell(cell, { ...options, ledgerRoot: f.dir, run: () => 1 }) });
      expect(f.item.status).toBe('yellow');
      expect(f.read().postLand.outcome).toBe('partial');
      expect(f.read().status).toBe('done');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a release done cell does not bypass its measured criterion', () => {
    const f = fixture('판정 신호: 조건=focused; 관측=bun test feature.test.ts; 기대=0 fail');
    f.item.status = 'done';
    try {
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: (cell, options) => judgeLandedCell(cell, { ...options, ledgerRoot: f.dir, run: () => 1 }) });
      expect(String(f.item.status)).toBe('yellow');
      expect(f.read().postLand.outcome).toBe('partial');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('an unpassed criterion preserves an existing red block', () => {
    const f = fixture('판정 신호: 조건=focused; 관측=bun test feature.test.ts; 기대=0 fail');
    f.item.status = 'red';
    try {
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: () => 'not-passed' });
      expect(f.item.status).toBe('red');
      expect(f.read().postLand.outcome).toBe('partial');
      expect(f.item.evidence).toContain('남은 것:');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('unbound or ambiguous PR never changes card or cell', () => {
    const f = fixture('판정 신호: 조건=x; 관측=bun test x.test.ts; 기대=0 fail');
    try {
      closeMergedTaskCard({ ...pr, url: 'https://github.com/other/repo/pull/79' }, f.dir, { ...f.deps, judge: () => 'proposed' });
      expect(f.writes).toHaveLength(0);
      expect(f.read().postLand).toBeUndefined();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a different land head on the bound card cannot close the release cell', () => {
    const f = fixture('판정 신호: 조건=x; 관측=bun test x.test.ts; 기대=0 fail');
    try {
      expect(closeMergedTaskCard({ ...pr, headRefOid: 'b'.repeat(40) }, f.dir, { ...f.deps, judge: () => 'proposed' })).toBeNull();
      expect(f.writes).toHaveLength(0);
      expect(f.read().status).toBe('launched');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('measured empty changed paths do not close an exact-bound card', () => {
    const f = fixture('판정 신호: 조건=x; 관측=bun test x.test.ts; 기대=0 fail');
    try {
      expect(closeMergedTaskCard({ ...pr, files: [] }, f.dir, { ...f.deps, judge: () => 'proposed' })).toBeNull();
      expect(f.item.status).toBe('yellow');
      expect(f.read().status).toBe('launched');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a judge execution error records partial while a ledger write error leaves the card launched', () => {
    const f = fixture('판정 신호: 조건=x; 관측=bun test x.test.ts; 기대=0 fail');
    try {
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: () => { throw new Error('runner unavailable'); } });
      expect(f.item.status).toBe('yellow');
      expect(f.item.evidence).toContain('판정 실행 오류: Error: runner unavailable');
      expect(f.read().postLand.outcome).toBe('partial');
      expect(f.read().status).toBe('done');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
    const g = fixture('판정 신호: 조건=x; 관측=bun test x.test.ts; 기대=0 fail');
    try {
      expect(() => closeMergedTaskCard(pr, g.dir, { ...g.deps, judge: () => 'proposed', setStatus: () => { throw new Error('ledger unavailable'); } })).toThrow('ledger unavailable');
      expect(g.read().status).toBe('launched');
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });

  test('a second checklist version appearing during judgment prevents closure', () => {
    const f = fixture('판정 신호: 조건=x; 관측=bun test x.test.ts; 기대=0 fail');
    let duplicate = false;
    try {
      closeMergedTaskCard(pr, f.dir, { ...f.deps, versions: ['0.2.28', '0.2.29'],
        checklist: (version) => version === '0.2.28' || duplicate
          ? { version, items: [f.item], history: [], released: '', dev: '' }
          : { version, items: [], history: [], released: '', dev: '' },
        judge: () => { duplicate = true; return 'proposed'; },
      });
      expect(f.writes).toHaveLength(0);
      expect(f.read().status).toBe('launched');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('an adopted card pinned to a version closes that cell when an older version has the same id', () => {
    const f = fixture('판정 신호: 조건=x; 관측=bun test x.test.ts; 기대=0 fail');
    try {
      const disk = JSON.parse(readFileSync(f.statePath, 'utf8'));
      disk.tasks['ta-79'].checklistVersion = '0.2.28';
      writeFileSync(f.statePath, JSON.stringify(disk));
      const closed = closeMergedTaskCard(pr, f.dir, { ...f.deps, versions: ['0.2.27'],
        checklist: (version) => ({ version, items: [f.item], history: [], released: '', dev: '' }),
        setStatus: (version, id, patch, by, expected) => {
          expect(version).toBe('0.2.28');
          return f.deps.setStatus(version, id, patch, by, expected);
        },
        judge: () => 'proposed' });
      expect(closed).toBe('CELL');
      expect(f.writes).toHaveLength(1);
      expect(f.read().postLand.outcome).toBe('complete');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('already green cell closes without claiming a new measurement', () => {
    const f = fixture('판정: prior green');
    f.item.status = 'green';
    try {
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: () => { throw new Error('should not run'); } });
      expect(f.item.evidence).toContain('기존 green 상태 확인(새 측정 0)');
      expect(f.item.evidence).toContain('기존 green 유지');
      expect(f.read().postLand.outcome).toBe('complete');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a changed land head before the guarded ledger write leaves both records untouched', () => {
    const f = fixture('판정: live sample 1');
    const events: string[] = [];
    try {
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: () => {
          const disk = JSON.parse(readFileSync(f.statePath, 'utf8'));
          disk.tasks['ta-79'].landAttempts[0].head = 'b'.repeat(40);
          writeFileSync(f.statePath, JSON.stringify(disk));
          return 'unmeasurable';
        },
        log: (_category, event) => { events.push(event); },
      });
      expect(events).toContain('postland-card-pending');
      expect(events).not.toContain('postland-card-closed');
      expect(f.read().postLand).toBeUndefined();
      expect(f.writes).toHaveLength(0);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a second bound card arriving during judgment prevents either card or cell closure', () => {
    const f = fixture('판정 신호: 조건=focused; 관측=bun test feature.test.ts; 기대=0 fail');
    try {
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: () => {
        const disk = JSON.parse(readFileSync(f.statePath, 'utf8'));
        disk.tasks['ta-79-duplicate'] = { ...disk.tasks['ta-79'], id: 'ta-79-duplicate' };
        writeFileSync(f.statePath, JSON.stringify(disk));
        return 'proposed';
      } });
      expect(f.writes).toHaveLength(0);
      expect(f.read().status).toBe('launched');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a criterion edit during the judge cannot write green or complete the card', () => {
    const f = fixture('판정 신호: 조건=focused; 관측=bun test old.test.ts; 기대=0 fail');
    try {
      expect(() => closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: () => {
        f.item.title = '판정 신호: 조건=focused; 관측=bun test new.test.ts; 기대=0 fail';
        return 'proposed';
      } })).toThrow('cell changed during judgment');
      expect(f.writes).toHaveLength(0);
      expect(f.item.status).toBe('yellow');
      expect(f.read().status).toBe('launched');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a green cell downgraded during closure is not restored without a fresh measurement', () => {
    const f = fixture('판정: prior green');
    f.item.status = 'green';
    try {
      expect(() => closeMergedTaskCard(pr, f.dir, { ...f.deps,
        setStatus: (version, id, patch, by, expected) => {
          f.item.status = 'yellow';
          return f.deps.setStatus(version, id, patch, by, expected);
        },
        judge: () => { throw new Error('should not judge green snapshot'); },
      })).toThrow('cell changed during judgment');
      expect(f.writes).toHaveLength(0);
      expect(f.read().status).toBe('launched');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('retry replaces stale yellow evidence when the same head later passes', () => {
    const f = fixture('판정 신호: 조건=focused; 관측=bun test feature.test.ts; 기대=0 fail');
    let verdict: 'not-passed' | 'proposed' = 'not-passed';
    try {
      const deps = { ...f.deps, judge: () => verdict };
      closeMergedTaskCard(pr, f.dir, deps);
      expect(f.item.evidence).toContain('남은 것:');
      expect(f.read().postLand.outcome).toBe('partial');
      verdict = 'proposed';
      closeMergedTaskCard(pr, f.dir, deps);
      expect(f.item.status).toBe('green');
      expect(f.item.evidence).toContain('판정 신호 통과 → green');
      expect(f.item.evidence).not.toContain('남은 것:');
      expect(f.item.evidence?.match(/TA postland #79\//g)).toHaveLength(1);
      expect(f.read().postLand.outcome).toBe('complete');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('repeating a partial verdict does not append another card event or ledger write', () => {
    const f = fixture('판정: live sample pending');
    try {
      const deps = { ...f.deps, judge: () => 'unmeasurable' as const };
      closeMergedTaskCard(pr, f.dir, deps);
      closeMergedTaskCard(pr, f.dir, deps);
      expect(f.writes).toHaveLength(1);
      expect(f.read().history).toHaveLength(1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a partial card upgrades when its cell is subsequently green', () => {
    const f = fixture('판정: live sample pending');
    try {
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: () => 'unmeasurable' });
      expect(f.read().postLand.outcome).toBe('partial');
      f.item.status = 'green';
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: () => { throw new Error('already green requires no new judge'); } });
      expect(f.read().postLand.outcome).toBe('complete');
      expect(f.item.evidence).toContain('기존 green 유지');
      expect(f.item.evidence).not.toContain('남은 것:');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a previously complete card is rejudged if its cell becomes yellow', () => {
    const f = fixture('판정 신호: 조건=focused; 관측=bun test feature.test.ts; 기대=0 fail');
    let verdict: 'proposed' | 'not-passed' = 'proposed';
    try {
      const deps = { ...f.deps, judge: () => verdict };
      closeMergedTaskCard(pr, f.dir, deps);
      expect(f.read().postLand.outcome).toBe('complete');
      f.item.status = 'yellow';
      verdict = 'not-passed';
      closeMergedTaskCard(pr, f.dir, deps);
      expect(f.item.status).toBe('yellow');
      expect(f.read().postLand.outcome).toBe('partial');
      expect(f.read().history).toHaveLength(2);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a complete card repairs erased evidence without another history event', () => {
    const f = fixture('판정 신호: 조건=focused; 관측=bun test feature.test.ts; 기대=0 fail');
    try {
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: () => 'proposed' });
      f.item.evidence = 'replaced by another writer';
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: () => { throw new Error('already green'); } });
      expect(f.item.evidence).toContain('TA postland #79/');
      expect(f.item.evidence).toContain('replaced by another writer');
      expect(f.read().history).toHaveLength(1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a complete card recovers its missing terminal marker on repeat', () => {
    const f = fixture('판정 신호: 조건=focused; 관측=bun test feature.test.ts; 기대=0 fail');
    try {
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: () => 'proposed' });
      const disk = JSON.parse(readFileSync(f.statePath, 'utf8'));
      disk.tasks['ta-79'].status = 'launched';
      delete disk.tasks['ta-79'].prTerminal;
      writeFileSync(f.statePath, JSON.stringify(disk));
      closeMergedTaskCard(pr, f.dir, { ...f.deps, judge: () => { throw new Error('already green'); } });
      expect(f.read().status).toBe('done');
      expect(f.read().prTerminal).toMatchObject({ pr: 79, head });
      expect(f.read().history).toHaveLength(1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a partial card recovers its missing terminal marker on repeat', () => {
    const f = fixture('판정: live sample pending');
    try {
      const deps = { ...f.deps, judge: () => 'unmeasurable' as const };
      closeMergedTaskCard(pr, f.dir, deps);
      const disk = JSON.parse(readFileSync(f.statePath, 'utf8'));
      disk.tasks['ta-79'].status = 'launched';
      delete disk.tasks['ta-79'].prTerminal;
      writeFileSync(f.statePath, JSON.stringify(disk));
      closeMergedTaskCard(pr, f.dir, deps);
      expect(f.read().status).toBe('done');
      expect(f.read().prTerminal).toMatchObject({ pr: 79, head });
      expect(f.item.status).toBe('yellow');
      expect(f.read().history).toHaveLength(1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('TA hand-merge reconcile', () => {
  const mergeSha = 'c'.repeat(40);
  const ancestorGit = { git: (_cwd: string, args: string[]) => (args.includes('--is-ancestor') ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: '' }) };
  const handDeps = (statePath: string) => ({ statePath, log: () => {}, ...ancestorGit });

  function handFixture(number = 79, reason = 'failed/needs-owner — run died without a PR') {
    const dir = mkdtempSync(join(tmpdir(), 'ta-postland-hand-'));
    const statePath = join(dir, 'task-agent-actions.json');
    const card: TaskCard = { id: `ta-${number}`, text: 'implement', createdAt: '2026-10-12T00:00:00Z', status: 'failed',
      history: [{ at: '2026-10-12T01:00:00Z', event: 'judge', detail: reason }], checklistId: 'CELL',
      pr: { number, url: `https://github.com/example/repo/pull/${number}` }, taLand: true,
      landAttempts: [{ pr: number, head, at: '2026-10-13T00:00:00Z' }] };
    writeFileSync(statePath, JSON.stringify({ tasks: { [card.id]: card } }));
    return { dir, statePath, reason, read: () => JSON.parse(readFileSync(statePath, 'utf8')).tasks[`ta-${number}`] };
  }

  test('merged PR whose merge SHA is a main ancestor settles the failed card as landed-by-hand', () => {
    const f = handFixture();
    try {
      const out = reconcileHandMergedCard({ ...pr, mergeCommit: mergeSha }, f.dir, handDeps(f.statePath));
      expect(out).toMatchObject({ outcome: 'reconciled', card: 'ta-79', status: 'landed-by-hand', pr: 79, mergeSha });
      expect(f.read().status).toBe('landed-by-hand');
      expect(f.read().history).toHaveLength(2);
      expect(f.read().history[1].event).toBe('hand-move');
      expect(f.read().history[1].pr).toBe(79);
      expect(f.read().history[1].head).toBe(mergeSha);
      expect(f.read().history[1].detail).toContain('이전 status: failed');
      expect(f.read().history[1].detail).toContain(`이전 사유: ${f.reason}`);
      expect(f.read().history[0].detail).toBe(f.reason);
      expect(f.read().landAttempts).toEqual([{ pr: 79, head, at: '2026-10-13T00:00:00Z' }]);
      expect(f.read().prTerminal).toMatchObject({ pr: 79, head: mergeSha, state: 'MERGED' });
      expect(f.read().postLand).toBeUndefined();
      const again = reconcileHandMergedCard({ ...pr, mergeCommit: mergeSha }, f.dir, handDeps(f.statePath));
      expect(again).toMatchObject({ outcome: 'not-reconciled', reason: 'card-not-failed' });
      expect(f.read().history).toHaveLength(2);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a merge SHA matching a recorded land attempt head settles as landed, keeping the prior reason', () => {
    const f = handFixture();
    try {
      const out = reconcileHandMergedCard({ ...pr, mergeCommit: head }, f.dir, handDeps(f.statePath));
      expect(out).toMatchObject({ outcome: 'reconciled', status: 'landed', mergeSha: head });
      expect(f.read().status).toBe('landed');
      expect(f.read().history).toHaveLength(2);
      expect(f.read().history[1].event).toBe('hand-move');
      expect(f.read().history[1].detail).toContain('land attempt head와 일치');
      expect(f.read().history[1].detail).toContain('이전 status: failed');
      expect(f.read().history[1].detail).toContain(`이전 사유: ${f.reason}`);
      expect(f.read().history[0].detail).toBe(f.reason);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('an OPEN PR leaves the failed card unchanged', () => {
    const f = handFixture();
    try {
      const out = reconcileHandMergedCard({ ...pr, state: 'OPEN' }, f.dir, handDeps(f.statePath));
      expect(out).toMatchObject({ outcome: 'not-reconciled', reason: 'pr-not-merged' });
      expect(f.read().status).toBe('failed');
      expect(f.read().history).toHaveLength(1);
      expect(f.read().prTerminal).toBeUndefined();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a MERGED PR whose merge SHA is not an ancestor of main leaves the card unchanged', () => {
    const f = handFixture();
    try {
      const out = reconcileHandMergedCard({ ...pr, mergeCommit: mergeSha }, f.dir, { statePath: f.statePath, log: () => {}, git: () => ({ status: 1, stdout: '', stderr: '' }) });
      expect(out).toMatchObject({ outcome: 'not-reconciled', reason: 'not-ancestor-of-main' });
      expect(f.read().status).toBe('failed');
      expect(f.read().history).toHaveLength(1);
      expect(f.read().prTerminal).toBeUndefined();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a MERGED PR without a usable merge commit is skipped', () => {
    const f = handFixture();
    try {
      const out = reconcileHandMergedCard({ ...pr, mergeCommit: 'not-a-sha' }, f.dir, handDeps(f.statePath));
      expect(out).toMatchObject({ outcome: 'not-reconciled', reason: 'no-merge-sha' });
      expect(f.read().status).toBe('failed');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a card another path already closed is not reconciled', () => {
    const f = handFixture();
    try {
      const disk = JSON.parse(readFileSync(f.statePath, 'utf8'));
      disk.tasks['ta-79'].status = 'done';
      writeFileSync(f.statePath, JSON.stringify(disk));
      const out = reconcileHandMergedCard({ ...pr, mergeCommit: mergeSha }, f.dir, handDeps(f.statePath));
      expect(out).toMatchObject({ outcome: 'not-reconciled', reason: 'card-not-failed' });
      expect(f.read().status).toBe('done');
      expect(f.read().history).toHaveLength(1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a PR no card is bound to is skipped, and two bound cards are ambiguous', () => {
    const unbound = handFixture(80);
    const ambiguous = handFixture();
    try {
      expect(reconcileHandMergedCard({ ...pr, mergeCommit: mergeSha }, unbound.dir, handDeps(unbound.statePath)))
        .toMatchObject({ outcome: 'not-reconciled', reason: 'no-bound-card' });
      expect(unbound.read().status).toBe('failed');
      const disk = JSON.parse(readFileSync(ambiguous.statePath, 'utf8'));
      disk.tasks['ta-79b'] = { ...disk.tasks['ta-79'], id: 'ta-79b' };
      writeFileSync(ambiguous.statePath, JSON.stringify(disk));
      expect(reconcileHandMergedCard({ ...pr, mergeCommit: mergeSha }, ambiguous.dir, handDeps(ambiguous.statePath)))
        .toMatchObject({ outcome: 'not-reconciled', reason: 'ambiguous-card' });
      expect(ambiguous.read().status).toBe('failed');
      expect(ambiguous.read().history).toHaveLength(1);
    } finally { rmSync(unbound.dir, { recursive: true, force: true }); rmSync(ambiguous.dir, { recursive: true, force: true }); }
  });

  test('a card that flips off failed before the guarded write is left for its owning path', () => {
    const f = handFixture();
    try {
      const updateCard: typeof updateTaskCard = (_path, id, mutate) => {
        const disk = JSON.parse(readFileSync(f.statePath, 'utf8'));
        disk.tasks[id].status = 'done';
        writeFileSync(f.statePath, JSON.stringify(disk));
        return updateTaskCard(f.statePath, id, mutate);
      };
      const out = reconcileHandMergedCard({ ...pr, mergeCommit: mergeSha }, f.dir, { statePath: f.statePath, log: () => {}, updateCard, ...ancestorGit });
      expect(out).toMatchObject({ outcome: 'not-reconciled', reason: 'card-binding-changed-before-write' });
      expect(f.read().status).toBe('done');
      expect(f.read().history).toHaveLength(1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('real git ancestry: only a merge commit on main settles the card', () => {
    const gitEnv: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    delete gitEnv.GIT_CONFIG_COUNT;
    delete gitEnv.GIT_CONFIG_PARAMETERS;
    delete gitEnv.GIT_TEMPLATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'ta-postland-git-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv }).trim();
    const commit = (message: string) => git('-c', 'user.name=ta', '-c', 'user.email=ta@example.invalid', 'commit', '--allow-empty', '-m', message);
    git('init', '-b', 'main');
    commit('base');
    git('checkout', '-b', 'feature');
    commit('feature');
    git('checkout', 'main');
    git('-c', 'user.name=ta', '-c', 'user.email=ta@example.invalid', 'merge', '--no-ff', '-m', 'merge feature', 'feature');
    const mergeCommit = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'dangling', 'main~1');
    commit('not on main');
    const dangling = git('rev-parse', 'HEAD');
    const settled = handFixture();
    const offMain = handFixture();
    try {
      const out = reconcileHandMergedCard({ ...pr, mergeCommit }, dir, { statePath: settled.statePath, mainRef: 'main', log: () => {} });
      expect(out).toMatchObject({ outcome: 'reconciled', status: 'landed-by-hand', mergeSha: mergeCommit });
      expect(settled.read().status).toBe('landed-by-hand');
      expect(settled.read().history[1].event).toBe('hand-move');
      const offMainOut = reconcileHandMergedCard({ ...pr, mergeCommit: dangling }, dir, { statePath: offMain.statePath, mainRef: 'main', log: () => {} });
      expect(offMainOut).toMatchObject({ outcome: 'not-reconciled', reason: 'not-ancestor-of-main' });
      expect(offMain.read().status).toBe('failed');
      expect(offMain.read().history).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(settled.dir, { recursive: true, force: true }); rmSync(offMain.dir, { recursive: true, force: true }); }
  });

  test('the ancestry gate asks git about the merge SHA against origin/main by default', () => {
    const f = handFixture();
    const calls: Array<{ cwd: string; args: string[] }> = [];
    try {
      const out = reconcileHandMergedCard({ ...pr, mergeCommit: mergeSha }, f.dir, { statePath: f.statePath, log: () => {},
        git: (cwd: string, args: string[]) => { calls.push({ cwd, args }); return { status: 0, stdout: '', stderr: '' }; } });
      expect(out).toMatchObject({ outcome: 'reconciled', status: 'landed-by-hand', mergeSha });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cwd).toBe(f.dir);
      expect(calls[0]!.args[0]).toBe('merge-base');
      expect(calls[0]!.args).toContain('--is-ancestor');
      expect(calls[0]!.args).toContain(mergeSha);
      expect(calls[0]!.args.at(-1)).toBe('origin/main');
      expect(f.read().status).toBe('landed-by-hand');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('a same-number card on another url or without taLand is not the bound card', () => {
    const otherUrl = handFixture();
    const noLand = handFixture();
    try {
      const disk = JSON.parse(readFileSync(otherUrl.statePath, 'utf8'));
      disk.tasks['ta-79'].pr.url = 'https://github.com/example/repo/pull/79/files';
      writeFileSync(otherUrl.statePath, JSON.stringify(disk));
      expect(reconcileHandMergedCard({ ...pr, mergeCommit: mergeSha }, otherUrl.dir, handDeps(otherUrl.statePath)))
        .toMatchObject({ outcome: 'not-reconciled', reason: 'no-bound-card' });
      expect(otherUrl.read().status).toBe('failed');
      expect(otherUrl.read().history).toHaveLength(1);
      const land = JSON.parse(readFileSync(noLand.statePath, 'utf8'));
      delete land.tasks['ta-79'].taLand;
      writeFileSync(noLand.statePath, JSON.stringify(land));
      expect(reconcileHandMergedCard({ ...pr, mergeCommit: mergeSha }, noLand.dir, handDeps(noLand.statePath)))
        .toMatchObject({ outcome: 'not-reconciled', reason: 'no-bound-card' });
      expect(noLand.read().status).toBe('failed');
      expect(noLand.read().history).toHaveLength(1);
      expect(noLand.read().prTerminal).toBeUndefined();
    } finally { rmSync(otherUrl.dir, { recursive: true, force: true }); rmSync(noLand.dir, { recursive: true, force: true }); }
  });

  test('a failed card with no recorded history still settles and keeps the prior status in the hand-move line', () => {
    const f = handFixture();
    try {
      const disk = JSON.parse(readFileSync(f.statePath, 'utf8'));
      disk.tasks['ta-79'].history = [];
      writeFileSync(f.statePath, JSON.stringify(disk));
      const out = reconcileHandMergedCard({ ...pr, mergeCommit: mergeSha }, f.dir, handDeps(f.statePath));
      expect(out).toMatchObject({ outcome: 'reconciled', status: 'landed-by-hand' });
      expect(f.read().status).toBe('landed-by-hand');
      expect(f.read().history).toHaveLength(1);
      expect(f.read().history[0].event).toBe('hand-move');
      expect(f.read().history[0].detail).toContain('이전 status: failed');
      expect(f.read().history[0].detail).toContain('이전 사유:');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('real git ancestry survives main advancing past the hand merge', () => {
    const gitEnv: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    delete gitEnv.GIT_CONFIG_COUNT;
    delete gitEnv.GIT_CONFIG_PARAMETERS;
    delete gitEnv.GIT_TEMPLATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'ta-postland-git-advance-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv }).trim();
    const commit = (message: string) => git('-c', 'user.name=ta', '-c', 'user.email=ta@example.invalid', 'commit', '--allow-empty', '-m', message);
    git('init', '-b', 'main');
    commit('base');
    git('checkout', '-b', 'feature');
    commit('feature');
    git('checkout', 'main');
    git('-c', 'user.name=ta', '-c', 'user.email=ta@example.invalid', 'merge', '--no-ff', '-m', 'hand merge feature', 'feature');
    const mergeCommit = git('rev-parse', 'HEAD');
    commit('later work on main');
    const f = handFixture();
    try {
      const out = reconcileHandMergedCard({ ...pr, mergeCommit }, dir, { statePath: f.statePath, mainRef: 'main', log: () => {} });
      expect(out).toMatchObject({ outcome: 'reconciled', status: 'landed-by-hand', mergeSha: mergeCommit });
      expect(f.read().status).toBe('landed-by-hand');
      expect(f.read().history[1].event).toBe('hand-move');
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(f.dir, { recursive: true, force: true }); }
  });

  for (const number of [26668, 27043, 27032, 26945]) {
    test(`hand-landed card #${number}: merged+main-ancestor reconciles to landed-by-hand with prior status and reason preserved`, () => {
      const reason = `failed/needs-owner — run died; 손수리 PR #${number} 병합됨`;
      const f = handFixture(number, reason);
      try {
        const out = reconcileHandMergedCard({ number, url: `https://github.com/example/repo/pull/${number}`, headRefOid: head, state: 'MERGED', baseRefName: 'main', mergedAt: '2026-10-14T00:00:00Z', files: [{ path: 'src/task-agent/postland-card.ts' }], mergeCommit: mergeSha }, f.dir, handDeps(f.statePath));
        expect(out).toMatchObject({ outcome: 'reconciled', card: `ta-${number}`, status: 'landed-by-hand', pr: number });
        const card = f.read();
        expect(card.status).toBe('landed-by-hand');
        expect(card.history[0].detail).toBe(reason);
        expect(card.history[1].event).toBe('hand-move');
        expect(card.history[1].detail).toContain('이전 status: failed');
        expect(card.history[1].detail).toContain(`이전 사유: ${reason}`);
        expect(card.prTerminal).toMatchObject({ pr: number, head: mergeSha, state: 'MERGED' });
        expect(card.landAttempts).toEqual([{ pr: number, head, at: '2026-10-13T00:00:00Z' }]);
      } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });
  }

  test('the production entry executeLiveLand reaches reconcileHandMergedCard and settles the failed card', async () => {
    const gitEnv: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    delete gitEnv.GIT_CONFIG_COUNT;
    delete gitEnv.GIT_CONFIG_PARAMETERS;
    delete gitEnv.GIT_TEMPLATE_DIR;
    const repo = mkdtempSync(join(tmpdir(), 'ta-postland-entry-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv }).trim();
    const commit = (message: string) => git('-c', 'user.name=ta', '-c', 'user.email=ta@example.invalid', 'commit', '--allow-empty', '-m', message);
    git('init', '-b', 'main');
    commit('base');
    git('checkout', '-b', 'feature');
    commit('feature');
    git('checkout', 'main');
    git('-c', 'user.name=ta', '-c', 'user.email=ta@example.invalid', 'merge', '--no-ff', '-m', 'hand merge feature', 'feature');
    const mergeCommit = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', mergeCommit);
    const stateDir = mkdtempSync(join(tmpdir(), 'ta-postland-entry-state-'));
    const statePath = join(stateDir, 'task-agent-actions.json');
    const reason = 'failed/needs-owner — run died';
    const card: TaskCard = { id: 'ta-79', text: 'implement', createdAt: '2026-10-12T00:00:00Z', status: 'failed',
      history: [{ event: 'judge', detail: reason, at: '2026-10-13T00:00:00Z' }], pr: { number: 79, url: pr.url }, taLand: true,
      landAttempts: [{ pr: 79, head, at: '2026-10-13T00:00:00Z' }] };
    writeFileSync(statePath, JSON.stringify({ tasks: { [card.id]: card } }));
    try {
      const out = await executeLiveLand(card, 79, { cwd: repo }, { statePath, log: () => {},
        landPrHead: async () => ({ head, state: 'MERGED', isDraft: false, url: pr.url }),
        handMergePr: async () => ({ state: 'MERGED', url: pr.url, baseRefName: 'main', mergedAt: '2026-10-14T00:00:00Z', mergeCommit }) });
      expect(out).toMatchObject({ kind: 'land', card: 'ta-79', ok: true, executed: true });
      expect(out.detail).toContain('landed-by-hand');
      const settled = JSON.parse(readFileSync(statePath, 'utf8')).tasks['ta-79'];
      expect(settled.status).toBe('landed-by-hand');
      expect(settled.history[0]).toMatchObject({ event: 'judge', detail: reason });
      expect(settled.history[1].event).toBe('hand-move');
      expect(settled.history[1].detail).toContain('이전 status: failed');
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }); }
  });
});
