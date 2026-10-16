import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeMergedTaskCard, type LandedTaskPr } from './postland-card.js';
import { judgeLandedCell } from '../release-loop/landed-to-green.js';
import type { TaskCard } from './task-hand.js';
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
