// LAND-CELL-LINK-ALWAYS sims — seeds 1–5 replay the 11-27 morning merges (bodies as hands wrote them). Fake ports only.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChecklistItem } from '../release-loop/checklist.js';
import { cellRefs, matchCell, matchMerged } from './cell-link.js';
import { readSweepRows, sweepMainCellLinks, type DoneWhen, type MergedPr, type SweepDeps } from './main-cell-link.js';

const NOW = new Date('2026-11-27T02:30:00Z'); // 11:30 KST
const cell = (id: string, status: 'yellow' | 'green' | 'red' = 'yellow', o: Partial<ChecklistItem> = {}): ChecklistItem =>
  ({ id, title: id, status, owner: 'TC', evidence: '', updatedAt: '2026-11-27T00:00:00Z', updatedBy: 'OP', ...o } as ChecklistItem);
const pr = (number: number, mergedAt: string, o: Partial<MergedPr> = {}): MergedPr =>
  ({ number, head: `${number}`.padEnd(40, 'a'), base: 'main', draft: false, state: 'MERGED', title: `pr ${number}`, author: 'x', files: [`src/f${number}.ts`], body: '', mergedAt, ...o });

interface World { items: ChecklistItem[]; merged: MergedPr[]; posts: string[]; attached: string[]; done?: Record<string, DoneWhen> }
function deps(s: string, w: World, o: Partial<SweepDeps> = {}): SweepDeps {
  return {
    now: () => NOW, stateRoot: s, lookbackMin: 180,
    listMerged: since => w.merged.filter(p => p.mergedAt >= since),
    checklist: () => ({ version: '0.3.38', items: w.items }),
    attach: (_v, id, n) => {
      w.attached.push(`${id} #${n}`);
      w.items = w.items.map(i => (i.id === id ? { ...i, evidence: `${i.evidence}\n#${n}` } : i));
    },
    doneWhen: (_v, id) => w.done?.[id] ?? { kind: 'sign' },
    post: (to, b) => { w.posts.push(`${to} ${b}`); },
    ...o,
  };
}
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('seed 1 — lands via three paths all get linked (path-blind: the sweep reads main)', () => {
  test('land-graph · op-direct-land-v2 · pr land merges → evidence on their cells · butler-ready cells get no line', async () => {
    const s = tmp('mcl-1-');
    const w: World = {
      items: [cell('HARNESS-PROGRESS-SEAT-TURN-FILTER'), cell('LAND-STEWARD-LOOP-AGENT', 'yellow', { evidence: '#40367 #40380' }), cell('BUTLER-TICK-CADENCE', 'green'), cell('COMPACT-NEVER-STALLS'), cell('ELS-WATCH-UNBUFFERED')],
      merged: [
        // land-graph tick (#40383 shape): «칸: 닫음: ID (…)» — the old whole-line matcher missed it
        pr(40383, '2026-11-27T00:55:00Z', { body: 'S…\n\n칸: 닫음: HARNESS-PROGRESS-SEAT-TURN-FILTER (0.3.38 · TA 스프린트 11-27 · t5-progress)\n' }),
        // op-direct-land-v2 (#40386 shape): id prefix on the 칸 line
        pr(40386, '2026-11-27T01:26:00Z', { body: '칸: LAND-STEWARD (착지 집사 · CEO 11-27 10:1x) — PR 2/3 · 몸 = #40367(착지됨)' }),
        // pr land by hand (#40392 shape): id in the title only
        pr(40392, '2026-11-27T00:56:00Z', { title: 'fix(llm): COMPACT-NEVER-STALLS — session compaction never stalls' }),
        // TA (#40399 shape): id in the branch only
        pr(40399, '2026-11-27T01:34:00Z', { headRef: 'op/els-watch-unbuffered', title: 'fix(els): els watch writes each line unbuffered' }),
      ],
      posts: [], attached: [],
    };
    const r = await sweepMainCellLinks(deps(s, w));
    expect(w.attached.sort()).toEqual(['COMPACT-NEVER-STALLS #40392', 'ELS-WATCH-UNBUFFERED #40399', 'HARNESS-PROGRESS-SEAT-TURN-FILTER #40383', 'LAND-STEWARD-LOOP-AGENT #40386']);
    expect(r.counts).toEqual({ attach: 4 });
    expect(r.rows.map(x => [x.pr, x.basis])).toEqual([[40383, 'cell-ref'], [40392, 'title'], [40386, 'cell-ref'], [40399, 'branch']]);
    expect(w.posts).toEqual([]); // every cell's done-when is met → 판정 집사 signs, nobody is mailed
    expect(readSweepRows(s)).toHaveLength(4);
  });
});

describe('seed 2 — unmatched merge → one line to the OP digest, once', () => {
  test('no cell / unregistered id → one OP line each · the next sweep (cursor overlap) repeats nothing', async () => {
    const s = tmp('mcl-2-');
    const w: World = {
      items: [cell('THROTTLE-AUDIT', 'green', { evidence: '#40426' })],
      merged: [
        pr(40395, '2026-11-27T01:06:00Z', { body: '칸: 닫음: FINISH-RATE-GH-CWD (0.3.38 · TA 스프린트 11-27)' }),
        pr(40396, '2026-11-27T01:07:00Z', { title: 'fix(llm): SPEND-NO-LEASE-FALLBACK-X a stop' , files: ['src/llm/x.ts'] }),
        pr(40426, '2026-11-27T02:05:00Z', { title: 'fix(msg): back-pressure', body: '' }),
      ],
      posts: [], attached: [],
    };
    const r1 = await sweepMainCellLinks(deps(s, w));
    expect(r1.counts).toEqual({ unregistered: 1, unmatched: 1, linked: 1 });
    expect(w.posts).toHaveLength(2);
    expect(w.posts[0]).toMatch(/^OP \[land-graph · no cell\] #40395 .* names FINISH-RATE-GH-CWD — not a 0\.3\.38 cell/u);
    expect(w.posts[1]).toMatch(/^OP \[land-graph · no cell\] #40396 .*evidence add <ID> --version 0\.3\.38 '#40396'/u);
    const r2 = await sweepMainCellLinks(deps(s, w, { now: () => new Date(NOW.getTime() + 5 * 60_000) }));
    expect([r2.rows.length, w.posts.length]).toEqual([0, 2]);
    // a new merge after the cursor is seen by the next sweep
    w.merged.push(pr(40430, '2026-11-27T02:40:00Z'));
    const r3 = await sweepMainCellLinks(deps(s, w, { now: () => new Date(NOW.getTime() + 15 * 60_000) }));
    expect(r3.rows.map(x => x.pr)).toEqual([40430]);
    expect(w.posts).toHaveLength(3);
  });
});

describe('seed 3 — done-when not met → the cell owner gets one line', () => {
  test('missing receipt → owner line names it · security → no line (butler escalates) · green cell → no attach', async () => {
    const s = tmp('mcl-3-');
    const w: World = {
      items: [cell('POLICY-AWARE-GOAL-AUTHORING', 'yellow', { owner: 'UX' }), cell('AUTH-SPLIT', 'yellow', { owner: 'RES' }), cell('DOORS-NON-HARNESS-EXCLUDE', 'green')],
      merged: [
        pr(40390, '2026-11-27T00:52:00Z', { body: '칸: 닫음: POLICY-AWARE-GOAL-AUTHORING (0.3.38 · CEO 11-27 12:2x)' }),
        pr(40500, '2026-11-27T00:53:00Z', { body: '칸: AUTH-SPLIT' }),
        pr(40377, '2026-11-27T00:31:00Z', { body: '칸: DOORS-NON-HARNESS-EXCLUDE (0.3.38 · 후속 — #40360 착지 직후)' }),
      ],
      posts: [], attached: [],
      done: { 'POLICY-AWARE-GOAL-AUTHORING': { kind: 'missing', missing: ['#40390 same-head receipt (pregate --light on 40390aaaaaaa)'] }, 'AUTH-SPLIT': { kind: 'security' } },
    };
    const r = await sweepMainCellLinks(deps(s, w));
    expect(w.attached).toEqual(['POLICY-AWARE-GOAL-AUTHORING #40390', 'AUTH-SPLIT #40500']);
    expect(r.rows.find(x => x.pr === 40377)).toMatchObject({ action: 'already-green', cells: ['DOORS-NON-HARNESS-EXCLUDE'] });
    expect(w.posts).toEqual(['UX [land-graph · cell] #40390 merged → POLICY-AWARE-GOAL-AUTHORING cites it · not green yet: #40390 same-head receipt (pregate --light on 40390aaaaaaa) — fill it and 판정 집사 signs on its next wake']);
  });
});

describe('seed 4 — matcher: several cells on one 칸 line · a body mention is not a link', () => {
  const items = [cell('POLICY-AWARE-GOAL-AUTHORING'), cell('GOAL-PRECHECK-BEFORE-IMPL', 'green'), cell('GOAL-REVISE-AFTER-FIRST-IMPL'), cell('CLAUDE-OP-PROXY-BUS'), cell('SPLIT-TO-GREEN'), cell('BUTLER-TICK-CADENCE')];
  test('«A · B · C 후속 (…)» attaches every open one · «**ID** 후속» reads · mention-only (#40355) → unmatched', () => {
    const multi = matchMerged(pr(40400, 'x', { body: '칸: POLICY-AWARE-GOAL-AUTHORING · GOAL-PRECHECK-BEFORE-IMPL · GOAL-REVISE-AFTER-FIRST-IMPL 후속 (0.3.38 · #40390·#40391 착지 뒤)' }), items);
    expect(multi).toMatchObject({ action: 'attach', green: ['GOAL-PRECHECK-BEFORE-IMPL'] });
    expect(multi.attach.map(a => a.id)).toEqual(['POLICY-AWARE-GOAL-AUTHORING', 'GOAL-REVISE-AFTER-FIRST-IMPL']);
    expect(cellRefs({ title: 't', body: '칸: **BUTLER-TICK-CADENCE** 후속 · 시뮬 #40379 LA-B1 이 잡은 결함.' }, items).found).toEqual([{ id: 'BUTLER-TICK-CADENCE', basis: 'cell-ref' }]);
    const mention = matchMerged(pr(40355, 'x', { body: 'S: CLAUDE-OP-PROXY-BUS and SPLIT-TO-GREEN both assumed the seat goal …', files: ['src/autopilot/x.ts'] }), items);
    expect(mention.action).toBe('unmatched');
  });
  test('the land-graph tick matcher (matchCell) reads the same 칸 forms', () => {
    expect(matchCell(pr(40390, 'x', { body: '칸: 닫음: POLICY-AWARE-GOAL-AUTHORING (0.3.38)' }), items)).toEqual({ id: 'POLICY-AWARE-GOAL-AUTHORING', basis: 'cell-ref' });
    expect(matchCell(pr(40391, 'x', { title: 'feat(harness): SPLIT-TO-GREEN — x' }), items)).toEqual({ id: 'SPLIT-TO-GREEN', basis: 'title' });
  });
});

describe('seed 5 — backfill and dry run', () => {
  test('--dry plans without evidence / mail / cursor · --since backfill links what the cursor already passed, never re-posts', async () => {
    const s = tmp('mcl-5-');
    const w: World = { items: [cell('LAND-CELL-LINK-ALWAYS', 'yellow', { owner: 'OP' })], merged: [pr(40440, '2026-11-27T00:10:00Z', { body: '칸: LAND-CELL-LINK-ALWAYS' }), pr(40441, '2026-11-27T00:20:00Z')], posts: [], attached: [] };
    const dry = await sweepMainCellLinks(deps(s, w, { dry: true, since: '2026-11-27T00:00:00Z' }));
    expect([dry.counts, w.attached, w.posts.length, readSweepRows(s).length]).toEqual([{ attach: 1, unmatched: 1 }, [], 0, 0]);
    expect(dry.posted).toHaveLength(1); // the line it would post
    // the cursor (first run = 60 min back) misses 00:10/00:20 …
    const tick = await sweepMainCellLinks(deps(s, w, { lookbackMin: 60 }));
    expect(tick.rows).toEqual([]);
    // … the backfill window catches them
    const bf = await sweepMainCellLinks(deps(s, w, { since: '2026-11-27T00:00:00Z' }));
    expect(w.attached).toEqual(['LAND-CELL-LINK-ALWAYS #40440']);
    expect(w.posts.filter(p => p.startsWith('OP [land-graph · no cell] #40441'))).toHaveLength(1);
    const again = await sweepMainCellLinks(deps(s, w, { since: '2026-11-27T00:00:00Z' }));
    expect(again.rows.find(x => x.pr === 40440)?.action).toBe('linked');
    expect(w.posts).toHaveLength(bf.posted.length); // backfill twice → no repeat line
  });
});
