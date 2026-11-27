import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReceipt, redReceipts, retryHosts } from '../cli/land-graph-cli.js';
import { readBook } from './finisher.js';
import { appendLedger, classifyLandExit, decide, readLedger, tickLand, type BaselineDiff, type Facts, type Focused, type LandDeps, type PrInfo, type Receipt } from './land-graph.js';
import { guardErrorClass, legacyGuardError, nextHost, redVerdict, tscHostsFor } from './red-receipt.js';

const ORG = join(mkdtempSync(join(tmpdir(), 'rr-org-')), 'federation.yaml');
writeFileSync(ORG, 'org:\n  duties:\n    landing: TC\n    veto: JUD\n');
const hx = (n: number, c = 'a') => `${String(n).padStart(6, '0')}${c.repeat(34)}`;
const mk = (n: number, o: Partial<PrInfo> = {}): PrInfo => ({ number: n, head: hx(n), base: 'main', draft: false, state: 'OPEN', title: `pr ${n}`, author: 'UX', files: [`src/f${n}.ts`], headRef: `b${n}`, createdAt: '2026-11-27T05:00:00Z', ...o });
const rc = (pr: number, head: string, o: Partial<Receipt> = {}): Receipt => ({ dir: `/r/${pr}-${head.slice(0, 12)}-minim5`, head, host: 'minim5', focused: [`src/f${pr}.test.ts`], rawDir: '', focusedExit: 0, ...o });
const step = (name: string, exit: number) => ({ name, exit });
const ND: BaselineDiff = { receipt: '/e/nd/namediff.json', command: 'bun test x', headPass: 40, headFail: 2 };

describe('redVerdict', () => {
  test('focused (+ baseline) only · tsc timeout · other step · no step recorded = other (fail closed)', () => {
    expect(redVerdict({ red: { failed: [step('focused', 1), step('baseline-focused', 1)] } })?.kind).toBe('focused-only');
    expect(redVerdict({ red: { failed: [step('changed-tsc', 124)] } })).toEqual({ kind: 'tsc-timeout', tscTimeout: true, focusedRed: false, other: [] });
    expect(redVerdict({ red: { failed: [step('changed-tsc', 1)] } })?.kind).toBe('other');
    expect(redVerdict({ red: { failed: [step('focused', 1), step('rules-and-ratchets', 1)] } })?.other).toEqual(['rules-and-ratchets=1']);
    expect(redVerdict({ red: { failed: [], failure: 'X' } })?.other).toEqual(['no failed step recorded (X)']);
    expect(redVerdict({})).toBeNull();
  });
});

describe('guard error / host rotation', () => {
  test('merge-tree exit with empty stderr → merge-conflict · fetch / fatal → gh-error · real revert → null', () => {
    expect(guardErrorClass('guard error: Error: git merge-tree --write-tree 3987897937c6 1d73fd7a6c68 failed: ')).toBe('merge-conflict');
    expect(guardErrorClass("fetch failed: error: cannot lock ref 'refs/remotes/origin/main'")).toBe('gh-error');
    expect(guardErrorClass('guard error: Error: git merge-tree --write-tree a b failed: fatal: bad object b')).toBe('gh-error');
    expect(guardErrorClass('src/a.ts←79f1f2f709')).toBeNull();
    expect(legacyGuardError('stale-base-revert', 'gate refused this head: guard error: Error: git merge-tree')).toBe(true);
    expect(legacyGuardError('stale-base-revert', 'src/a.ts←79f1f2f709')).toBe(false);
  });
  test('nextHost skips the timed-out host · tsc hosts rotate per attempt · config list validated', () => {
    expect(nextHost('node-b')).toBe('minim5');
    expect(nextHost('minim5')).toBe('node-b');
    expect(tscHostsFor(0, ['minim5', 'node-b', 'mbp'])).toBe('minim5 node-b mbp');
    expect(tscHostsFor(1, ['minim5', 'node-b', 'mbp'])).toBe('node-b mbp minim5');
    expect(retryHosts({}, 'minim5')).toEqual(['minim5', 'node-b', 'mbp']);
    expect(retryHosts({ retryHosts: ['a;rm', 'b'] })).toEqual(['node-b', 'minim5', 'mbp']);
    expect(classifyLandExit(10, 'STOP tsc-preflight rc=2 (land-enqueue …)')).toBe('tsc-timeout');
    expect(classifyLandExit(10, 'STOP tsc-preflight rc=1 (land-enqueue …)')).toBe('tsc');
  });
});

describe('decide on RED receipts (11-27 stopgap cases)', () => {
  const pr = mk(39891);
  const facts = (r: Receipt, focused: Focused, nd: BaselineDiff | null = null): Facts => ({ org: { path: ORG }, pr, receipt: r, olderReceiptHead: null, focused, hold: null, security: [], landedBefore: false, ...(nd ? { baselineDiff: nd } : {}) });
  const red = (failed: Array<{ name: string; exit: number }>, o: Partial<Receipt> = {}) => rc(39891, pr.head, { focusedExit: failed.find(s => s.name === 'focused')?.exit ?? 0, red: { failed }, ...o });
  test('#39891: focused-only RED + OP name diff introduced 0 → land', () => {
    const d = decide(facts(red([step('focused', 1), step('baseline-focused', 1)], { focusedBaseline: { mine: 2, onMain: 1, newFailures: ['(fail) x'] } }), { swept: true, exit: 1 }, ND));
    expect(d.action).toBe('land');
    expect(d.why).toContain('baseline-name-diff introduced 0');
  });
  test('focused-only RED with a new failure and no name diff → refuse baseline-failing-focused', () => {
    expect(decide(facts(red([step('focused', 1)], { focusedBaseline: { mine: 2, onMain: 1, newFailures: ['(fail) x'] } }), { swept: true, exit: 1 })).cls).toBe('baseline-failing-focused');
  });
  test('#40355: changed-tsc 124 with focused 0 → wait tsc-timeout (RES card)', () => {
    const d = decide(facts(red([step('changed-tsc', 124)]), { swept: true, exit: 0 }));
    expect([d.action, d.cls]).toEqual(['wait', 'tsc-timeout']);
    expect(d.card?.to).toEqual(['TC']);
  });
  test('other red step → refuse pregate-red to the author', () => {
    const d = decide(facts(red([step('rules-and-ratchets', 1)]), { swept: true, exit: 0 }));
    expect([d.action, d.cls]).toEqual(['refuse', 'pregate-red']);
    expect(d.card?.to).toEqual(['UX', 'TC']);
  });
});

describe('readReceipt / redReceipts', () => {
  test('a PREGATE-RED dir reads its failed steps; dirs without receipt.json are skipped', () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-red-'));
    const head = hx(40355);
    const a = join(root, `40355-${head.slice(0, 12)}-minim5`); mkdirSync(a);
    writeFileSync(join(a, 'receipt.json'), JSON.stringify({ head, host: 'minim5', focused: ['a.test.ts'], steps: [{ name: 'focused', exit: 0 }, { name: 'changed-tsc', exit: 124 }], failure: 'changed-tsc_RED' }));
    mkdirSync(join(root, `40355-${head.slice(0, 12)}-minim5-084403`));
    const rs = redReceipts([a, join(root, `40355-${head.slice(0, 12)}-minim5-084403`)], head);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.red).toEqual({ failed: [{ name: 'changed-tsc', exit: 124 }], failure: 'changed-tsc_RED' });
    expect(readReceipt(a)?.red).toBeUndefined(); // a green-dir read never marks red
  });
});

const base = (s: string, prs: PrInfo[], o: Partial<LandDeps> = {}): LandDeps => ({
  now: () => new Date('2026-11-27T09:00:00Z'), stateRoot: s, mode: 'live', slots: 2, org: { path: ORG },
  listPrs: async () => prs, prNow: async n => prs.find(p => p.number === n) ?? null,
  receipt: (n, h) => rc(n, h), olderReceiptHead: () => null, focused: () => ({ pass: 3, fail: 0 }), security: () => [],
  land: async () => ({ rc: 0, text: '' }), post: () => {}, record: () => {}, ...o,
});

describe('tick: TSC-TIMEOUT pregate retry', () => {
  test('retry launches once on another host; a second timeout → one tsc-timeout card to RES', async () => {
    const s = mkdtempSync(join(tmpdir(), 'rr-t1-'));
    const p = mk(40355); const posts: string[] = []; const launched: Array<{ pr: number; avoid?: string }> = [];
    const r = rc(40355, p.head, { red: { failed: [step('changed-tsc', 124)] } });
    const d = base(s, [p], {
      receipt: () => r, focused: () => ({ swept: true, exit: 0 }), post: (to, b) => { posts.push(`${to} ${b}`); },
      finisher: { launchPregate: (pr, o) => { launched.push({ pr: pr.number, ...(o?.avoidHost ? { avoid: o.avoidHost } : {}) }); return { ok: true, pid: 7 }; }, alive: () => false, refresh: () => ({ result: 'error' }) },
    });
    const t1 = await tickLand(d);
    expect(t1.decisions[0]).toMatchObject({ action: 'wait', cls: 'tsc-timeout', next: { owner: 'land-graph', action: 'finisher pregate-retry' } });
    expect(launched).toEqual([{ pr: 40355, avoid: 'minim5' }]);
    expect(posts).toEqual([]);
    await tickLand(d); await tickLand(d);
    expect(launched).toHaveLength(1);
    expect(readBook(s).jobs[`40355@${p.head}#retry`]?.state).toBe('failed');
    expect(posts.filter(x => x.includes('tsc-timeout'))).toHaveLength(1);
    expect(posts[0]!.startsWith('TC ')).toBe(true); // RES-owned fix → the landing owner seat in this org map
  });
});

describe('tick: GUARD-ERROR classification', () => {
  test('merge-tree failure → merge-conflict + refresh · fetch failure → transient · legacy sticky rows ignored', async () => {
    const s = mkdtempSync(join(tmpdir(), 'rr-t2-'));
    const a = mk(39794); const b = mk(40085); const c = mk(39858);
    appendLedger(s, { at: '2026-11-26T22:30:00Z', pr: c.number, head: c.head, mode: 'live', event: 'refused', cls: 'stale-base-revert', why: 'guard error: Error: git merge-tree --write-tree 39878 ffef6 fai' });
    const refreshed: number[] = []; const landed: number[] = [];
    const d = base(s, [a, b, c], {
      slots: 3,
      staleRevert: pr => {
        if (pr.number === a.number) throw new Error(`git merge-tree --write-tree ${'3'.repeat(40)} ${pr.head} failed: `);
        if (pr.number === b.number) return { ok: false, why: "fetch failed: error: cannot lock ref 'refs/remotes/origin/main'" };
        return { ok: true };
      },
      land: async pr => { landed.push(pr.number); return { rc: 0, text: '' }; },
      prNow: async n => ({ ...[a, b, c].find(p => p.number === n)!, state: landed.includes(n) ? 'MERGED' : 'OPEN' }),
      finisher: { launchPregate: () => ({ ok: false }), alive: () => false, refresh: pr => { refreshed.push(pr.number); return { result: 'conflict', why: 'src/x.ts' }; } },
    });
    const t = await tickLand(d);
    expect(t.landed).toEqual([39858]); // the legacy guard-error row no longer sticks
    const refused = readLedger(s).filter(r => r.event === 'refused' && r.at.startsWith('2026-11-27'));
    expect(refused.map(r => [r.pr, r.cls])).toEqual([[39794, 'merge-conflict'], [40085, 'gh-error']]);
    expect(refreshed).toEqual([39794]);
    const t2 = await tickLand({ ...d, staleRevert: () => ({ ok: true }) });
    expect(t2.landed).toContain(40085); // gh-error is transient
    expect(t2.decisions.find(x => x.pr === 39794)).toMatchObject({ action: 'refuse', cls: 'merge-conflict' });
  });
});

describe('tick: land-time tsc unmeasured', () => {
  test('first unmeasured → no card, next attempt rotates · second → card and the refusal sticks', async () => {
    const s = mkdtempSync(join(tmpdir(), 'rr-t3-'));
    const p = mk(39960); const posts: string[] = []; const attempts: number[] = [];
    const d = base(s, [p], {
      land: async (_pr, _r, _w, ctx) => { attempts.push(ctx?.tscAttempt ?? -1); return { rc: 10, text: 'STOP tsc-preflight rc=2 (land-enqueue …)' }; },
      post: (to, b) => { posts.push(`${to} ${b}`); },
    });
    await tickLand(d);
    expect(posts).toEqual([]);
    await tickLand(d);
    expect(attempts).toEqual([0, 1]);
    expect(posts.filter(x => x.includes('tsc-timeout'))).toHaveLength(1);
    const t3 = await tickLand(d);
    expect(attempts).toHaveLength(2);
    expect(t3.decisions[0]).toMatchObject({ action: 'refuse', cls: 'tsc-timeout' });
  });
});

describe('NEXT-ACTION', () => {
  test('every non-land decision carries an owner', async () => {
    const s = mkdtempSync(join(tmpdir(), 'rr-t4-'));
    const prs = [mk(1), mk(2, { base: 'other' }), mk(3), mk(4)];
    const t = await tickLand(base(s, prs, {
      slots: 1, mode: 'shadow',
      receipt: (n, h) => (n === 3 ? null : rc(n, h, n === 4 ? { focusedExit: 1 } : {})),
      focused: r => (r.dir.includes('/4-') ? { swept: true, exit: 1 } : { pass: 3, fail: 0 }),
    }));
    const nonLand = t.decisions.filter(x => x.action !== 'land');
    expect(nonLand.length).toBe(3);
    for (const x of nonLand) expect(x.next?.owner).toBeTruthy();
    expect(t.decisions.find(x => x.pr === 4)?.next).toEqual({ owner: 'UX', action: 'baseline-failing-focused' });
  });
});
