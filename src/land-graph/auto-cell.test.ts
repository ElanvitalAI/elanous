// CELLLESS-PR-AUTO-CELL sims — seeds 1–5 replay 11-27 cellless merges through the post-merge sweep with fake ports.
// Expectations are literals (rule 11): ids, owners and lines are written out, never rebuilt from the product.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChecklistAddInput, ChecklistItem } from '../release-loop/checklist.js';
import { loadAutoCellPolicy, ownerOf, parseAutoCellPolicy, planAutoCell, slugId } from './auto-cell.js';
import { sweepMainCellLinks, type MergedPr, type SweepDeps } from './main-cell-link.js';

const NOW = new Date('2026-11-27T08:00:00Z');
const POLICY = loadAutoCellPolicy(); // the shipped graphs/loop-agents/land-steward/cell-auto.yaml
const cell = (id: string, status: 'yellow' | 'green' = 'yellow', o: Partial<ChecklistItem> = {}): ChecklistItem =>
  ({ id, title: id, status, owner: 'TC', evidence: '', updatedAt: '2026-11-27T00:00:00Z', updatedBy: 'OP', ...o } as ChecklistItem);
const pr = (number: number, mergedAt: string, o: Partial<MergedPr> = {}): MergedPr =>
  ({ number, head: `${number}`.padEnd(40, 'a'), base: 'main', draft: false, state: 'MERGED', title: `pr ${number}`, author: 'ElanvitalAI', files: [`src/f${number}.ts`], body: '', mergedAt, ...o });

interface World { items: ChecklistItem[]; merged: MergedPr[]; posts: string[]; attached: string[]; registered: ChecklistAddInput[]; refuse?: Set<string>; others?: Set<string> }
function deps(s: string, w: World, o: Partial<SweepDeps> = {}): SweepDeps {
  return {
    now: () => NOW, stateRoot: s, lookbackMin: 600,
    listMerged: since => w.merged.filter(p => p.mergedAt >= since),
    checklist: () => ({ version: '0.3.38', items: w.items }),
    attach: (_v, id, n) => {
      w.attached.push(`${id} #${n}`);
      w.items = w.items.map(i => (i.id === id ? { ...i, evidence: `${i.evidence ?? ''}\n#${n}` } : i));
    },
    doneWhen: () => ({ kind: 'sign' }),
    post: (to, b) => { w.posts.push(`${to} ${b}`); },
    register: (_v, input) => {
      if (w.items.some(i => i.id === input.id)) throw new Error(`이미 있는 칸: ${input.id}`);
      if (w.others?.has(input.id)) throw new Error(`다른 판에 이미 있는 칸: ${input.id}`);
      w.registered.push(input);
      w.items = [...w.items, { ...input, status: 'yellow', updatedAt: NOW.toISOString(), updatedBy: 'land-graph' } as ChecklistItem];
    },
    autoCellPolicy: () => POLICY,
    ...o,
  };
}
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
// the sweep skips an empty release (no checklist) — every world carries one unrelated green cell.
const world = (o: Partial<World> = {}): World => ({ items: [cell('BASE-GREEN-CELL', 'green')], merged: [], posts: [], attached: [], registered: [], ...o });

describe('seed 1 — cellless merges get a cell, evidence and one OP digest line each', () => {
  test('branch slug · owner from branch prefix · P2 · ops · 대상 경로 = changed files', async () => {
    const s = tmp('ac-1-');
    const w = world({
      items: [cell('THROTTLE-AUDIT', 'green', { evidence: '#40426' })],
      merged: [
        pr(40424, '2026-11-27T02:10:00Z', { headRef: 'op/op-pulse-beat-kind', title: 'fix(msg): accept kind beat — op-pulse beat mails were refused', files: ['src/msg/msg-store.ts', 'src/msg/msg-store.test.ts'] }),
        pr(40397, '2026-11-27T01:00:00Z', { headRef: 'tc/cc2-stale-pr-reap-190480', title: 'fix(land): reap stale PRs' }),
      ],
    });
    const r = await sweepMainCellLinks(deps(s, w));
    expect(r.counts).toEqual({ 'auto-cell': 2 });
    expect(w.registered.map(i => [i.id, i.owner, i.priority, i.dispatchKind, i.source])).toEqual([
      ['CC2-STALE-PR-REAP-190480', 'TC', 'P2', 'ops', 'PR #40397'],
      ['OP-PULSE-BEAT-KIND', 'OP', 'P2', 'ops', 'PR #40424'],
    ]);
    expect(w.registered[1]!.title).toBe('fix(msg): accept kind beat — op-pulse beat mails were refused');
    expect(w.registered[1]!.body!.split('\n')[0]).toBe('대상 경로: src/msg/msg-store.ts · src/msg/msg-store.test.ts');
    expect(w.attached).toEqual(['CC2-STALE-PR-REAP-190480 #40397', 'OP-PULSE-BEAT-KIND #40424']);
    expect(w.posts).toEqual([
      'OP [land-graph · auto-cell] #40397 «fix(land): reap stale PRs» had no 0.3.38 cell → registered CC2-STALE-PR-REAP-190480 (owner TC · P2 · evidence #40397) — 판정 집사 signs it on its next wake',
      'OP [land-graph · auto-cell] #40424 «fix(msg): accept kind beat — op-pulse beat mails were refused» had no 0.3.38 cell → registered OP-PULSE-BEAT-KIND (owner OP · P2 · evidence #40424) — 판정 집사 signs it on its next wake',
    ]);
    expect(w.posts.some(p => p.includes('no cell'))).toBe(false);
  });
});

describe('seed 2 — idempotent on the PR number', () => {
  test('a second sweep and a --since backfill register nothing new · an attach failure retries onto the same cell', async () => {
    const s = tmp('ac-2-');
    const w = world({ merged: [pr(40400, '2026-11-27T03:00:00Z', { headRef: 'ta/goal-policy-followup', title: 'feat(goal): policy follow-up' })] });
    await sweepMainCellLinks(deps(s, w));
    await sweepMainCellLinks(deps(s, w, { now: () => new Date(NOW.getTime() + 5 * 60_000) }));
    const bf = await sweepMainCellLinks(deps(s, w, { since: '2026-11-27T00:00:00Z' }));
    expect(w.registered.map(i => i.id)).toEqual(['GOAL-POLICY-FOLLOWUP']);
    expect(bf.rows.map(x => [x.pr, x.action])).toEqual([[40400, 'linked']]);
    expect(w.posts).toHaveLength(1);
    // attach fails once after the register → next sweep reuses the registered cell (source «PR #N»), never a twin
    const s2 = tmp('ac-2b-');
    const w2 = world({ merged: [pr(40401, '2026-11-27T03:00:00Z', { headRef: 'self-impl/goalid-1f2e', title: 'fix(llm): spend no lease fallback' })] });
    let fail = true;
    const flaky = deps(s2, w2);
    const r1 = await sweepMainCellLinks({ ...flaky, attach: (v, id, n) => { if (fail) { fail = false; throw new Error('ledger busy'); } flaky.attach(v, id, n); } });
    expect(r1.rows[0]).toMatchObject({ action: 'attach-failed' });
    const r2 = await sweepMainCellLinks(deps(s2, w2, { now: () => new Date(NOW.getTime() + 5 * 60_000) }));
    expect(r2.rows[0]).toMatchObject({ action: 'auto-cell', cells: ['SPEND-NO-LEASE-FALLBACK'] });
    expect([w2.registered.length, w2.attached]).toEqual([1, ['SPEND-NO-LEASE-FALLBACK #40401']]);
  });
});

describe('seed 3 — id sources: named «칸» id · title for machine branches · collisions', () => {
  test('unregistered «칸» id is registered as written · self-impl → title slug · taken id → -<PR> · other release refuses → fallback', async () => {
    const s = tmp('ac-3-');
    const w = world({
      items: [cell('REROUTE-NEVER-SENDER', 'green')],
      others: new Set(['LAND-OWNS-RECEIPT']),
      merged: [
        pr(40395, '2026-11-27T01:06:00Z', { headRef: 'self-impl/goalid-611c66db2ddab070-src-loops-orchestrator-finish-rate-ts-sr-d1b4662f-r6cc6d0', body: '칸: 닫음: FINISH-RATE-GH-CWD (0.3.38 · TA 스프린트 11-27)' }),
        pr(40383, '2026-11-27T01:07:00Z', { headRef: 'self-impl/goalid-99c2d795b32ff3d0-src-self-implement', title: 'src/self-implement: running-runs header shows excluded seat turns' }),
        pr(40422, '2026-11-27T01:08:00Z', { headRef: 'fix/reroute-never-sender', title: 'fix(msg): a dormant reroute never lands back' }),
        pr(40350, '2026-11-27T01:09:00Z', { headRef: 'land-owns-receipt', title: 'land owns receipt' }),
      ],
    });
    const r = await sweepMainCellLinks(deps(s, w));
    expect(r.rows.map(x => [x.pr, x.action, x.cells[0], x.basis])).toEqual([
      [40395, 'auto-cell', 'FINISH-RATE-GH-CWD', 'named,owner:default'],
      [40383, 'auto-cell', 'SRC-SELF-IMPLEMENT-RUNNING-RUNS-HEADER-SHOWS', 'title,owner:default'],
      [40422, 'auto-cell', 'REROUTE-NEVER-SENDER-40422', 'branch,owner:default'],
      [40350, 'auto-cell', 'LAND-OWNS-RECEIPT-40350', 'branch,owner:default'],
    ]);
    expect(w.registered.every(i => i.owner === 'OP')).toBe(true);
  });
});

describe('seed 4 — owner and scope come from the YAML policy', () => {
  test('body «자리: UX» beats the branch · unknown prefix → OP · exclude_paths / exclude_branch_prefixes skip → plain OP line', async () => {
    expect(ownerOf({ body: 'S…\n\n자리: UX\n칸: X', headRef: 'op/x' }, POLICY)).toEqual({ seat: 'UX', from: 'body' });
    expect(ownerOf({ body: 'Seat: TC-1', headRef: 'feat/x' }, POLICY)).toEqual({ seat: 'TC-1', from: 'body' });
    expect(ownerOf({ body: '', headRef: 'hand-tui-d/new-tab-widget-191677' }, POLICY)).toEqual({ seat: 'OP', from: 'default' });
    const scoped = parseAutoCellPolicy('scope:\n  exclude_paths: [docs/]\n  exclude_branch_prefixes: [release]\nowner:\n  default: TC\n');
    expect(planAutoCell(pr(1, 'x', { files: ['docs/a.md', 'docs/b.md'] }), [], scoped)).toEqual({ kind: 'skip', why: 'every file is in scope.exclude_paths' });
    expect(planAutoCell(pr(2, 'x', { headRef: 'release/0.3.38' }), [], scoped)).toEqual({ kind: 'skip', why: 'branch release/ is out of scope' });
    const s = tmp('ac-4-');
    const w = world({ merged: [pr(40436, '2026-11-27T02:26:00Z', { headRef: 'op/yaml-definable-system', files: ['docs/conductor/YAML-SYSTEM.md'] })] });
    const r = await sweepMainCellLinks(deps(s, w, { autoCellPolicy: () => scoped }));
    expect(r.rows[0]).toMatchObject({ action: 'unmatched', why: 'auto-cell skipped: every file is in scope.exclude_paths' });
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]).toMatch(/^OP \[land-graph · no cell\] #40436 /u);
    expect(() => parseAutoCellPolicy('cell:\n  priority: P9\n')).toThrow('cell.priority must be P0|P1|P2');
    expect(() => parseAutoCellPolicy('owner:\n  default: nobody\n')).toThrow('owner.default must be a seat name');
  });
});

describe('seed 5 — dry run · broken policy · matched merges untouched', () => {
  test('--dry plans the line, writes nothing · a broken policy falls back to the no-cell line · a 칸-linked merge never auto-cells', async () => {
    const s = tmp('ac-5-');
    const w = world({
      items: [cell('LAND-CELL-LINK-ALWAYS')],
      merged: [pr(40437, '2026-11-27T02:40:00Z', { body: '칸: LAND-CELL-LINK-ALWAYS' }), pr(40439, '2026-11-27T02:41:00Z', { headRef: 'hand-tui-d/new-tab-widget-191677', title: 'test(els): capture new-tab widget frames' })],
    });
    const dry = await sweepMainCellLinks(deps(s, w, { dry: true }));
    expect(dry.counts).toEqual({ attach: 1, 'auto-cell': 1 });
    expect([w.registered.length, w.attached.length, w.posts.length]).toEqual([0, 0, 0]);
    expect(dry.posted).toEqual(['OP [land-graph · auto-cell] #40439 «test(els): capture new-tab widget frames» had no 0.3.38 cell → registered NEW-TAB-WIDGET-191677 (owner OP · P2 · evidence #40439) — 판정 집사 signs it on its next wake']);
    const s2 = tmp('ac-5b-');
    const r = await sweepMainCellLinks(deps(s2, w, { autoCellPolicy: () => { throw new Error('cell-auto policy: cell.priority must be P0|P1|P2'); } }));
    expect(r.rows.map(x => [x.pr, x.action])).toEqual([[40437, 'attach'], [40439, 'unmatched']]);
    expect(r.rows[1]!.why).toBe('auto-cell policy: cell-auto policy: cell.priority must be P0|P1|P2');
    expect(w.registered).toEqual([]);
    expect(w.posts.filter(p => p.startsWith('OP [land-graph · no cell] #40439'))).toHaveLength(1);
  });
  test('slug is stable and word-bounded', () => {
    expect(slugId('land-cell-link-always', 48)).toBe('LAND-CELL-LINK-ALWAYS');
    expect(slugId('a-very-long-branch-name-that-keeps-going-past-the-limit-of-ids', 20)).toBe('A-VERY-LONG-BRANCH');
    expect(slugId('윈도 수정 Fix', 48)).toBe('FIX');
  });
});
