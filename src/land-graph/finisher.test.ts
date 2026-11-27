import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReceipt } from '../cli/land-graph-cli.js';
import { matchCell } from './cell-link.js';
import { FINISH_CONCURRENCY, finishKindFor, readBook, stalePrs } from './finisher.js';
import { appendLedger, decide, tickLand, type Facts, type Focused, type LandDeps, type PrInfo, type Receipt } from './land-graph.js';

const ORG = join(mkdtempSync(join(tmpdir(), 'lf-org-')), 'federation.yaml');
writeFileSync(ORG, 'org:\n  duties:\n    landing: TC\n    veto: JUD\n');
const hx = (n: number, c = 'a') => `${String(n).padStart(6, '0')}${c.repeat(34)}`;
const mk = (n: number, o: Partial<PrInfo> = {}): PrInfo => ({ number: n, head: hx(n), base: 'main', draft: false, state: 'OPEN', title: `pr ${n}`, author: 'TC', files: [`src/f${n}.ts`], headRef: `b${n}`, createdAt: '2026-11-26T05:00:00Z', ...o });
const rc = (pr: number, head: string, o: Partial<Receipt> = {}): Receipt => ({ dir: `/r/${pr}-${head.slice(0, 12)}-minim5`, head, host: 'minim5', focused: [`src/f${pr}.test.ts`], rawDir: '', focusedExit: 0, ...o });

describe('BASELINE-FAIL-NONBLOCK · decide', () => {
  const pr = mk(1);
  const facts = (r: Receipt, focused: Focused): Facts => ({ org: { path: ORG }, pr, receipt: r, olderReceiptHead: null, focused, hold: null, security: [], landedBefore: false });
  test('swept exit 1 with pregate name diff new 0 → land · the why records the diff, never «N fail»', () => {
    const d = decide(facts(rc(1, pr.head, { focusedExit: 1, focusedBaseline: { mine: 3, onMain: 4, newFailures: [] } }), { swept: true, exit: 1 }));
    expect(d.action).toBe('land');
    expect(d.why).toContain('name diff new 0 · 3 also red on main (4)');
    expect(/\b[1-9]\d*\s*fail/i.test(d.why)).toBe(false);
  });
  test('raw 2 fail with name diff new 0 → land · new failures → refuse · no baseline record → refuse', () => {
    expect(decide(facts(rc(1, pr.head, { focusedBaseline: { mine: 2, onMain: 2, newFailures: [] } }), { pass: 20, fail: 2 })).action).toBe('land');
    expect(decide(facts(rc(1, pr.head, { focusedBaseline: { mine: 2, onMain: 1, newFailures: ['a > b'] } }), { pass: 20, fail: 2 })).cls).toBe('baseline-failing-focused');
    expect(decide(facts(rc(1, pr.head, { focusedExit: 1 }), { swept: true, exit: 1 })).cls).toBe('baseline-failing-focused');
  });
  test('readReceipt carries a well-formed focusedBaseline only', () => {
    const d = mkdtempSync(join(tmpdir(), 'lf-rc-'));
    writeFileSync(join(d, 'receipt.json'), JSON.stringify({ head: hx(1), focused: ['a.test.ts'], steps: [{ name: 'focused', exit: 1 }], focusedBaseline: { mine: 2, onMain: 2, newFailures: [] } }));
    expect(readReceipt(d)?.focusedBaseline).toEqual({ mine: 2, onMain: 2, newFailures: [] });
    writeFileSync(join(d, 'receipt.json'), JSON.stringify({ head: hx(1), focusedBaseline: { mine: 'x' } }));
    expect(readReceipt(d)?.focusedBaseline).toBeUndefined();
  });
});

describe('finishKindFor', () => {
  test('receipt gaps → pregate · stale base → refresh (same-repo only) · others → none', () => {
    expect(['no-receipt', 'stale-head'].map(c => finishKindFor(c as never, {}))).toEqual(['pregate', 'pregate']);
    expect(finishKindFor('baseline-failing-focused', { noBaselineInReceipt: true })).toBe('pregate');
    expect(finishKindFor('baseline-failing-focused', {})).toBeNull();
    expect(finishKindFor('stale-base-revert', {})).toBe('refresh');
    expect(finishKindFor('merge-conflict', { crossRepo: true })).toBeNull();
    expect(finishKindFor('tsc', {})).toBeNull();
  });
});

describe('stalePrs', () => {
  test('open > 24 h with reason, oldest first', () => {
    const now = Date.parse('2026-11-27T08:00:00Z');
    const prs = [mk(1, { createdAt: '2026-11-27T07:00:00Z' }), mk(2, { createdAt: '2026-11-25T08:00:00Z' }), mk(3, { createdAt: '2026-11-26T06:00:00Z' })];
    expect(stalePrs(prs, new Map([[2, 'wait no-receipt']]), now)).toEqual([{ pr: 2, ageH: 48, reason: 'wait no-receipt' }, { pr: 3, ageH: 26, reason: 'unknown' }]);
  });
});

/**
 * 07:3x queue replay (CEO 11-27): 37 open PRs — 4 eligible · 13 no-receipt · 3 stale-head · 4 baseline (2 with the
 * pregate name diff, 2 old receipts without it) · 3 stacked on a merged base · 4 stale-base refusals · 6 RED.
 */
/** Landable now = passed every gate and only waits for a land slot (the sim runs with slots 0). */
const landable = (r: { decisions: Array<{ why: string }> }) => r.decisions.filter(x => x.why.startsWith('slots')).length;
const seed = (s: string, q: ReturnType<typeof queue>) => { for (const p of q.refusedStale) appendLedger(s, { at: '2026-11-27T07:30:00Z', pr: p.number, head: p.head, mode: 'live', event: 'refused', cls: 'stale-base-revert', why: 'x' }); };

function queue() {
  const prs: PrInfo[] = []; const receipts = new Map<string, Receipt>(); const focused = new Map<string, Focused>();
  const older = new Map<number, string>(); const refusedStale: PrInfo[] = [];
  let n = 41000;
  const put = (pr: PrInfo, r: Receipt | null, f?: Focused) => { prs.push(pr); if (r) { receipts.set(`${pr.number}@${pr.head}`, r); focused.set(r.dir, f ?? { pass: 9, fail: 0 }); } };
  for (let i = 0; i < 4; i++) { const p = mk(n++); put(p, rc(p.number, p.head)); }
  for (let i = 0; i < 13; i++) put(mk(n++), null);
  for (let i = 0; i < 3; i++) { const p = mk(n++); put(p, null); older.set(p.number, hx(p.number, 'f')); }
  for (let i = 0; i < 2; i++) { const p = mk(n++); put(p, rc(p.number, p.head, { focusedExit: 1, focusedBaseline: { mine: 2, onMain: 2, newFailures: [] } }), { swept: true, exit: 1 }); }
  for (let i = 0; i < 2; i++) { const p = mk(n++); put(p, rc(p.number, p.head, { focusedExit: 1 }), { swept: true, exit: 1 }); }
  for (let i = 0; i < 3; i++) { const p = mk(n++, { base: `stack-${i}` }); put(p, rc(p.number, p.head)); }
  for (let i = 0; i < 4; i++) { const p = mk(n++); put(p, rc(p.number, p.head)); refusedStale.push(p); }
  for (let i = 0; i < 6; i++) { const p = mk(n++); put(p, rc(p.number, p.head, { focusedBaseline: { mine: 2, onMain: 0, newFailures: ['x > y'] } }), { pass: 8, fail: 2 }); }
  return { prs, receipts, focused, older, refusedStale };
}

function deps(q: ReturnType<typeof queue>, stateRoot: string, o: { finisher: boolean; live: boolean }) {
  const launched: number[] = []; const pending: Array<{ pr: PrInfo; due: number }> = []; let tickNo = 0;
  const retargeted: number[] = []; const pushed: number[] = []; const posts: string[] = [];
  const d: LandDeps = {
    now: () => new Date('2026-11-27T07:40:00Z'), stateRoot, mode: o.live ? 'live' : 'shadow', slots: 0, org: { path: ORG },
    listPrs: async () => q.prs.map(p => ({ ...p })), prNow: async n => q.prs.find(p => p.number === n) ?? null,
    receipt: (pr, head) => q.receipts.get(`${pr}@${head}`) ?? null,
    olderReceiptHead: pr => q.older.get(pr) ?? null,
    focused: r => q.focused.get(r.dir) ?? 'unreadable', security: () => [],
    land: async () => ({ rc: 99, text: 'never' }), post: (to, b) => { posts.push(`${to} ${b}`); }, record: () => {},
    baseMerged: pr => pr.base.startsWith('stack-'),
    retargetToMain: pr => { retargeted.push(pr.number); const p = q.prs.find(x => x.number === pr.number)!; p.base = 'main'; return { ok: true }; },
    ...(o.finisher ? { finisher: {
      // A pregate light run lands its green receipt one tick later (with the A244 name diff).
      launchPregate: (pr: PrInfo) => { launched.push(pr.number); pending.push({ pr, due: tickNo }); return { ok: true, pid: 100000 + pr.number }; },
      alive: () => false,
      refresh: (pr: PrInfo) => {
        pushed.push(pr.number); const p = q.prs.find(x => x.number === pr.number)!; p.head = hx(pr.number, 'e');
        return { result: 'merged' as const, newHead: p.head };
      },
    } } : {}),
  };
  const tick = async () => {
    for (const j of pending.filter(x => x.due <= tickNo)) {
      const cur = q.prs.find(p => p.number === j.pr.number)!;
      if (cur.head === j.pr.head) { const r = rc(cur.number, cur.head, { focusedBaseline: { mine: 0, onMain: 0, newFailures: [] } }); q.receipts.set(`${cur.number}@${cur.head}`, r); q.focused.set(r.dir, { pass: 7, fail: 0 }); }
    }
    tickNo++;
    return tickLand(d);
  };
  return { d, tick, launched, retargeted, pushed, posts };
}

describe('LAND-OWNS-RECEIPT · 07:3x queue replay', () => {
  test.each([0, 1])('synthetic no-author-receipt: focused exit %i controls fake landing on same PR/head', async (exit) => {
    const root = mkdtempSync(join(tmpdir(), 'land-own-sim-'));
    const p = mk(42001);
    let receipt: Receipt | null = null;
    const launched: Array<{ pr: number; head: string }> = [];
    let fakeLands = 0;
    let merged = false;
    const d: LandDeps = {
      now: () => new Date('2026-11-27T07:40:00Z'), stateRoot: root, mode: 'live', slots: 1, org: { path: ORG },
      listPrs: async () => [p], prNow: async () => ({ ...p, state: merged ? 'MERGED' : 'OPEN' }),
      receipt: (n, h) => n === p.number && h === p.head ? receipt : null,
      olderReceiptHead: () => null, focused: () => ({ swept: true, exit }), security: () => [],
      land: async (pr, r) => { expect([pr.number, pr.head, r.head]).toEqual([p.number, p.head, p.head]); fakeLands++; merged = true; return { rc: 0, text: '' }; },
      post: () => {}, record: () => {},
      finisher: { launchPregate: pr => { launched.push({ pr: pr.number, head: pr.head }); return { ok: true, pid: 1 }; }, alive: () => false, refresh: () => ({ result: 'error' }) },
    };
    await tickLand(d);
    expect(launched).toEqual([{ pr: p.number, head: p.head }]);
    expect(fakeLands).toBe(0);
    receipt = rc(p.number, p.head, { focusedExit: exit });
    await tickLand(d);
    expect(fakeLands).toBe(exit === 0 ? 1 : 0);
  });
  test('without the finisher only 4 of 37 are ready', async () => {
    const q = queue(); const s = mkdtempSync(join(tmpdir(), 'lf-q0-'));
    seed(s, q);
    const { d } = deps(q, s, { finisher: false, live: true });
    const res = await tickLand({ ...d, baseMerged: undefined, dry: true });
    expect([res.decisions.length, landable(res)]).toEqual([37, 4 + 2]); // baseline name diff already lifts the 2 with a pregate record
  });

  test('plan (dry) shows retarget + the first 3 pregates as would-run, rest busy, and launches nothing', async () => {
    const q = queue(); const s = mkdtempSync(join(tmpdir(), 'lf-q1-'));
    seed(s, q);
    const { d, launched, retargeted } = deps(q, s, { finisher: true, live: true });
    const res = await tickLand({ ...d, dry: true });
    expect(landable(res)).toBe(4 + 2 + 3);
    expect(res.finisher!.filter(f => f.kind === 'refresh').map(f => f.state)).toEqual(['would-run', 'would-run', 'would-run', 'busy']);
    expect(res.finisher!.filter(f => f.kind === 'retarget').map(f => f.state)).toEqual(['would-run', 'would-run', 'would-run']);
    expect(res.finisher!.filter(f => f.kind === 'pregate' && f.state === 'would-run')).toHaveLength(FINISH_CONCURRENCY);
    expect([launched.length, retargeted.length]).toEqual([0, 0]);
  });

  test('live ticks: bounded launches, dedupe per head, refresh → re-pregate, ready rises to 31 (6 RED stay)', async () => {
    const q = queue(); const s = mkdtempSync(join(tmpdir(), 'lf-q2-'));
    seed(s, q);
    const { tick, launched, retargeted, pushed, posts } = deps(q, s, { finisher: true, live: true });
    const first = await tick();
    expect(retargeted).toHaveLength(3);
    expect(pushed).toHaveLength(FINISH_CONCURRENCY); // refresh cap per tick — the 4th goes next tick
    expect(launched).toHaveLength(FINISH_CONCURRENCY);
    expect(Object.values(readBook(s).jobs).filter(j => j.state === 'running')).toHaveLength(FINISH_CONCURRENCY);
    expect(landable(first)).toBe(4 + 2 + 3);
    const readyByTick = [landable(first)];
    for (let i = 0; i < 12; i++) readyByTick.push(landable(await tick()));
    expect(pushed).toHaveLength(4);
    expect(readyByTick[readyByTick.length - 1]).toBe(37 - 6);
    for (let i = 1; i < readyByTick.length; i++) expect(readyByTick[i]!).toBeGreaterThanOrEqual(readyByTick[i - 1]!);
    expect(new Set(launched).size).toBe(launched.length); // one job per (PR, head) — every PR head pregated once
    expect(launched).toHaveLength(13 + 3 + 2 + 4);
    expect(posts.filter(p => /no-receipt|stale-head/.test(p))).toEqual([]); // the graph owns these — no author card
  });

  test('a pregate that exits without a green receipt → needs-finisher card once, no relaunch', async () => {
    const s = mkdtempSync(join(tmpdir(), 'lf-q3-')); mkdirSync(join(s, 'land-graph'), { recursive: true });
    const p = mk(42000, { author: 'MK' }); const posts: string[] = []; const launched: number[] = [];
    const d: LandDeps = {
      now: () => new Date('2026-11-27T07:40:00Z'), stateRoot: s, mode: 'live', slots: 0, org: { path: ORG },
      listPrs: async () => [p], prNow: async () => p, receipt: () => null, olderReceiptHead: () => null, focused: () => 'unreadable', security: () => [],
      land: async () => ({ rc: 99, text: '' }), post: (to, b) => { posts.push(`${to} ${b}`); }, record: () => {},
      finisher: { launchPregate: pr => { launched.push(pr.number); return { ok: true, pid: 1 }; }, alive: () => false, refresh: () => ({ result: 'error' }) },
    };
    await tickLand(d); await tickLand(d); await tickLand(d);
    expect(launched).toEqual([42000]);
    expect(posts.filter(x => x.includes('needs-finisher'))).toHaveLength(2); // author + landing owner, once
  });

  test('refresh conflict → needs-finisher card with the conflicted files', async () => {
    const s = mkdtempSync(join(tmpdir(), 'lf-q4-'));
    const p = mk(42100); const posts: string[] = [];
    appendLedger(s, { at: '2026-11-27T07:30:00Z', pr: p.number, head: p.head, mode: 'live', event: 'refused', cls: 'merge-conflict', why: 'x' });
    const d: LandDeps = {
      now: () => new Date('2026-11-27T07:40:00Z'), stateRoot: s, mode: 'live', slots: 0, org: { path: ORG },
      listPrs: async () => [p], prNow: async () => p, receipt: (n, h) => rc(n, h), olderReceiptHead: () => null, focused: () => ({ pass: 3, fail: 0 }), security: () => [],
      land: async () => ({ rc: 99, text: '' }), post: (to, b) => { posts.push(`${to} ${b}`); }, record: () => {},
      finisher: { launchPregate: () => ({ ok: false }), alive: () => false, refresh: () => ({ result: 'conflict', why: 'src/a.ts' }) },
    };
    const res = await tickLand(d);
    expect(res.finisher?.[0]).toMatchObject({ kind: 'refresh', state: 'conflict' });
    expect(posts.some(x => x.includes('needs-finisher') && x.includes('src/a.ts'))).toBe(true);
  });
});

describe('STALE-PR-24H reap', () => {
  const base = (s: string, prs: PrInfo[], closed: number[]): LandDeps => ({
    now: () => new Date('2026-11-27T08:00:00Z'), stateRoot: s, mode: 'shadow', slots: 1, org: { path: ORG },
    listPrs: async () => prs, prNow: async () => null, receipt: () => null, olderReceiptHead: () => null, focused: () => 'unreadable', security: () => [],
    land: async () => ({ rc: 99, text: '' }), post: () => {}, record: () => {},
    superseded: p => p.number === 2, closePr: p => { closed.push(p.number); return { ok: true }; },
  });
  test('dry lists only provably superseded stale PRs · apply closes them', async () => {
    const prs = [mk(1, { createdAt: '2026-11-25T08:00:00Z' }), mk(2, { createdAt: '2026-11-25T08:00:00Z' }), mk(3, { createdAt: '2026-11-27T07:00:00Z' })];
    const closed: number[] = [];
    const dry = await tickLand({ ...base(mkdtempSync(join(tmpdir(), 'lf-r-')), prs, closed), dry: true, reap: 'dry' });
    expect(dry.stale!.map(x => x.pr)).toEqual([1, 2]);
    expect(dry.reaped).toEqual([{ pr: 2, action: 'would-close', why: 'open 48h · its whole diff is already in main (superseded)' }]);
    expect(closed).toEqual([]);
    const app = await tickLand({ ...base(mkdtempSync(join(tmpdir(), 'lf-r-')), prs, closed), dry: true, reap: 'apply' });
    expect([app.reaped![0]!.action, closed]).toEqual(['closed', [2]]);
  });
});

describe('LAND-CELL-LINK', () => {
  const item = (id: string, o: Record<string, unknown> = {}) => ({ id, title: `${id} title`, status: 'yellow', updatedAt: '2026-11-27T00:00:00Z', ...o }) as never;
  const items = [item('LAND-OWNS-RECEIPT'), item('GRAPH-RUNNER-X', { evidence: 'src/graph/runner.ts · #39000' }), item('A1'), item('DONE-1', { status: 'green', evidence: '#41555' })];
  test('already cited · body cell line · title start · branch · files · none', () => {
    expect(matchCell(mk(41555), items)).toEqual({ id: 'DONE-1', basis: 'already' });
    expect(matchCell(mk(1, { body: 'S…\n칸: A1\n' }), items)).toEqual({ id: 'A1', basis: 'cell-line' });
    expect(matchCell(mk(2, { title: 'LAND-OWNS-RECEIPT finisher' }), items)).toEqual({ id: 'LAND-OWNS-RECEIPT', basis: 'title-strong' });
    expect(matchCell(mk(3, { headRef: 'op/land-owns-receipt' }), items)).toEqual({ id: 'LAND-OWNS-RECEIPT', basis: 'branch' });
    expect(matchCell(mk(4, { files: ['src/graph/runner.ts', 'src/graph/runner.test.ts'] }), items)).toEqual({ id: 'GRAPH-RUNNER-X', basis: 'files' });
    expect(matchCell(mk(5, { files: ['src/graph/runner.test.ts'] }), items)).toBeNull();
  });
  test('tick: plan says would-attach / landed-no-cell · live attaches before the merge', async () => {
    const s = mkdtempSync(join(tmpdir(), 'lf-c-'));
    const a = mk(43001, { body: '칸: A1' }); const b = mk(43002);
    const attached: string[] = []; const order: string[] = [];
    const d: LandDeps = {
      now: () => new Date('2026-11-27T07:40:00Z'), stateRoot: s, mode: 'live', slots: 2, org: { path: ORG },
      listPrs: async () => [a, b], prNow: async n => ({ ...(n === a.number ? a : b), state: order.includes(`land ${n}`) ? 'MERGED' : 'OPEN' }),
      receipt: (n, h) => rc(n, h), olderReceiptHead: () => null, focused: () => ({ pass: 3, fail: 0 }), security: () => [],
      land: async p => { order.push(`land ${p.number}`); return { rc: 0, text: '' }; }, post: () => {}, record: () => {},
      cellLink: p => matchCell(p, items), attachCell: (cell, p) => { attached.push(`${cell} #${p.number}`); order.push(`attach ${p.number}`); return { ok: true }; },
    };
    const plan = await tickLand({ ...d, dry: true });
    expect(plan.cells).toEqual([{ pr: 43001, cell: 'A1', basis: 'cell-line', action: 'would-attach' }, { pr: 43002, cell: null, action: 'landed-no-cell' }]);
    expect(attached).toEqual([]);
    const live = await tickLand(d);
    expect(live.landed).toEqual([43001, 43002]);
    expect(order).toEqual(['attach 43001', 'land 43001', 'land 43002']);
    expect(live.cells?.[0]?.action).toBe('attached');
  });
});

describe('SMART-MERGE · retarget then rebuild', () => {
  test('a stacked PR whose base merged is retargeted and rebuilt — never landed on its old head the same tick', async () => {
    const q = queue(); const s = mkdtempSync(join(tmpdir(), 'lf-sm-'));
    const { d } = deps(q, s, { finisher: true, live: true });
    const res = await tickLand({ ...d, dry: true, smartMerge: { mergedHeads: () => [], mergedBaseHead: () => 'c'.repeat(40) } });
    const stacked = q.prs.filter(p => p.base.startsWith('stack-')).map(p => p.number);
    expect(stacked).toHaveLength(3);
    for (const n of stacked) {
      expect(res.decisions.filter(x => x.pr === n).map(x => [x.action, x.why])).toEqual([['wait', 'rebuild onto main after retarget']]);
    }
    expect(res.finisher!.filter(f => f.kind === 'rebuild').map(f => f.pr)).toEqual(stacked);
  });
});
