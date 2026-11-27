/**
 * SIM — THROUGHPUT-CONTROLLER (CEO 11-26 23:4x «착지 10 · 초록 10 · 중간 최적화»). Five seeded worlds rebuild the
 * shapes of 11-26 with varied counts, files and ages (seed → mulberry32):
 *   1 hot-file churn   ~15 els PRs on attach-app.ts · server.ts · elements/index.ts bounce on merge conflicts
 *   2 tsc OOM          a receipt whose tsc step exit is 134/137 (no verdict) while lands are short
 *   3 ready drought    land graph live, little in the pipeline, idle hands, few ready cells
 *   4 judge backlog    lands ≈ target, greens 0–1, green-triage (a) holds 5–12 signable cells
 *   5 land dead        launchd python3.9 crash: PRs ready, the graph lands 0, its last tick long ago
 * Expected decisions are literals written from the doc's lever table (not derived from the controller's LEVERS).
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveThroughputActuators, throughputLedgerPath } from './throughput-controller-live.js';
import { decideThroughput, executeThroughput, renderThroughputBlock, type ThroughputSnapshot, type TpOpenPr, type TpRefusal } from './throughput-controller.js';
import * as checklist from '../release-loop/checklist.js';
import * as versionResolver from './op-next-action-live.js';
import * as greenTriage from '../release-loop/green-triage.js';
import { landOrder, type LedgerRow, type PrInfo } from '../land-graph/land-graph.js';

const liveRoot = mkdtempSync(join(tmpdir(), 'throughput-hold-'));
afterAll(() => rmSync(liveRoot, { recursive: true, force: true }));

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const NOW = '2026-11-26T14:30:00.000Z';
const ago = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
const HOT = ['src/els/attach-app.ts', 'src/els/server.ts', 'src/els/elements/index.ts'];

/** A calm world on target — each seed bends one part of it. */
function base(r: () => number): ThroughputSnapshot {
  return {
    now: NOW, version: '0.3.38', targets: { landsPerH: 10, greensPerH: 10 },
    landsLastHour: int(r, 10, 13), graphLandsLastHour: int(r, 6, 9), greensLastHour: int(r, 10, 12), judgeReady: [], landsWithoutCell: int(r, 0, 3),
    land: { readyToLand: int(r, 0, 1), slots: 2, mode: 'live', lastTickAgeMin: int(r, 1, 8), avgTickMin: 6 },
    churn: [], openPrs: [], awaitingPregate: [], receipts: [{ pr: 40300, head: 'a'.repeat(40), host: 'minim5', at: ago(20), tscExit: 0 }],
    pregateHosts: ['node-b', 'minim5', 'mbp'], hands: { free: [], holdingIdle: [], working: 12 }, frozen: [], readyCells: 30,
  };
}

function seedWorld(seed: number): ThroughputSnapshot {
  const r = rng(seed * 7919);
  const w = base(r);
  switch (seed) {
    case 1: {
      const n = int(r, 6, 15);
      const prs: TpOpenPr[] = Array.from({ length: n }, (_, i) => ({ pr: 40280 + i, head: `${i}`.padEnd(40, 'c'), author: `TC-H-CX-${(i % 4) + 1}`, draft: false,
        files: [HOT[i % HOT.length]!, ...(r() < 0.5 ? [HOT[(i + 1) % HOT.length]!] : []), `src/els/elements/piece-${i}.ts`] }));
      const churn: TpRefusal[] = prs.flatMap((p, i) => Array.from({ length: i === 0 ? int(r, 2, 5) : int(r, 0, 1) }, () => ({ pr: p.pr, cls: r() < 0.6 ? 'stale-base-revert' : 'merge-conflict', at: ago(int(r, 5, 110)), files: p.files })));
      return { ...w, landsLastHour: int(r, 3, 7), graphLandsLastHour: int(r, 1, 4), churn, openPrs: prs, land: { ...w.land!, readyToLand: int(r, 1, 3) } };
    }
    case 2: {
      const pr = int(r, 40300, 40320);
      return { ...w, landsLastHour: int(r, 2, 6), receipts: [...w.receipts!, { pr, head: 'd'.repeat(40), host: 'minim5', at: ago(int(r, 5, 60)), tscExit: r() < 0.5 ? 134 : 137, author: 'TC-H-CC-2' }] };
    }
    case 3:
      return { ...w, landsLastHour: int(r, 1, 4), graphLandsLastHour: int(r, 1, 3), land: { ...w.land!, readyToLand: int(r, 0, 2) }, awaitingPregate: [{ pr: 40310, sinceMin: 4 }],
        hands: { free: Array.from({ length: int(r, 6, 18) }, (_, i) => `TC-H-POOL-${i + 1}`), holdingIdle: [], working: int(r, 0, 3) }, readyCells: int(r, 0, 3) };
    case 4: {
      const k = int(r, 5, 12);
      return { ...w, greensLastHour: int(r, 0, 1), judgeReady: Array.from({ length: k }, (_, i) => ({ cell: `CELL-${i + 1}`, prs: [40270 + i] })) };
    }
    case 5:
      return { ...w, landsLastHour: int(r, 0, 2), graphLandsLastHour: 0, land: { readyToLand: int(r, 3, 30), slots: 1, mode: 'live', lastTickAgeMin: int(r, 45, 400), avgTickMin: null } };
    default: return w;
  }
}

describe('throughput controller — HOLD-aware live snapshot', () => {
  const now = new Date('2026-11-27T00:00:00.000Z');
  const candidates = [
    { id: 'CELL-A', mergedPrs: [40301] }, { id: 'CELL-B', mergedPrs: [40302] },
    { id: 'CELL-C', mergedPrs: [40303] }, { id: 'CELL-D', mergedPrs: [40304] },
  ];
  const mockSnapshotInputs = () => {
    const checklistSpy = spyOn(checklist, 'listChecklist').mockReturnValue({ items: [] } as unknown as ReturnType<typeof checklist.listChecklist>);
    const versionSpy = spyOn(versionResolver, 'versionInPlay').mockResolvedValue('0.3.38');
    const triageSpy = spyOn(greenTriage, 'triageGreen').mockReturnValue({ rows: { judge: candidates } } as ReturnType<typeof greenTriage.triageGreen>);
    return () => { checklistSpy.mockRestore(); versionSpy.mockRestore(); triageSpy.mockRestore(); };
  };

  test('THROUGHPUT-VETO-AWARE: liveThroughputSnapshot excludes actively held names and preserves uncovered candidates', async () => {
    const restoreSnapshotInputs = mockSnapshotInputs();
    const stateRoot = join(liveRoot, 'active');
    const eventsPath = join(stateRoot, 'hold-ledger', 'events.jsonl');
    mkdirSync(join(stateRoot, 'hold-ledger'), { recursive: true });
    const add = (id: string, cell: string, expiresAt: string) => ({ at: now.toISOString(), by: 'TC', op: 'add', id, owner: 'TC', cells: [cell], reason: 'test', unlock: 'done', expiresAt });
    writeFileSync(eventsPath, [
      add('active-a', 'CELL-A', '2026-11-27T01:00:00.000Z'),
      add('wildcard', '*', '2026-11-27T01:00:00.000Z'),
      add('expired-c', 'CELL-C', '2026-11-26T23:00:00.000Z'),
      add('lifted-d', 'CELL-D', '2026-11-27T01:00:00.000Z'),
      { at: now.toISOString(), by: 'TC', op: 'lift', id: 'lifted-d', reason: 'resolved' },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    try {
      const { liveThroughputSnapshot } = await import('./throughput-controller-live.js');
      const snapshot = await liveThroughputSnapshot({ stateRoot, seatState: join(stateRoot, 'seat-state') }, now);
      expect(snapshot.judgeReady).toEqual([
        { cell: 'CELL-B', prs: [40302] }, { cell: 'CELL-C', prs: [40303] }, { cell: 'CELL-D', prs: [40304] },
      ]);
    } finally { restoreSnapshotInputs(); }
  }, 30_000);

  test('THROUGHPUT-VETO-AWARE: a HOLD ledger read failure preserves candidates and marks holds unmeasured', async () => {
    const restoreSnapshotInputs = mockSnapshotInputs();
    const stateRoot = join(liveRoot, 'unreadable');
    mkdirSync(join(stateRoot, 'hold-ledger', 'events.jsonl'), { recursive: true });
    try {
      const { liveThroughputSnapshot } = await import('./throughput-controller-live.js');
      const snapshot = await liveThroughputSnapshot({ stateRoot, seatState: join(stateRoot, 'seat-state') }, now);
      expect(snapshot.judgeReady).toEqual(candidates.map(row => ({ cell: row.id, prs: row.mergedPrs })));
      expect(snapshot.unmeasured).toContain('holds');
      expect(snapshot.unmeasured).toContain('land.graph.slots');
    } finally { restoreSnapshotInputs(); }
  }, 30_000);

  test('a missing HOLD ledger is a measured empty ledger', async () => {
    const restoreSnapshotInputs = mockSnapshotInputs();
    const stateRoot = join(liveRoot, 'missing');
    try {
      const { liveThroughputSnapshot } = await import('./throughput-controller-live.js');
      const snapshot = await liveThroughputSnapshot({ stateRoot, seatState: join(stateRoot, 'seat-state') }, now);
      expect(snapshot.judgeReady).toEqual(candidates.map(row => ({ cell: row.id, prs: row.mergedPrs })));
      expect(snapshot.unmeasured).not.toContain('holds');
    } finally { restoreSnapshotInputs(); }
  }, 30_000);
});

describe('throughput controller — seeded 11-26 worlds', () => {
  test('a calm world on target pulls no lever', () => {
    const v = decideThroughput(base(rng(1)));
    expect(v.binding.kind).toBe('on-target');
    expect(v.lever.actions).toEqual([]);
  });

  test('seed 1 hot-file churn → hot lane lever: merge-main request to every open non-draft PR in the lane, deduped by head', async () => {
    const v = decideThroughput(seedWorld(1));
    expect(v.chain).toBe('land');
    expect(v.binding.kind).toBe('hot-file-churn');
    expect(v.lever.id).toBe('L-HOT-LANE');
    expect(v.hotFiles.map(h => h.file)).toContain('src/els/attach-app.ts');
    expect(v.lever.actions.length).toBeGreaterThan(0);
    expect(v.lever.actions.length).toBeLessThanOrEqual(8);
    for (const a of v.lever.actions) { expect(a.do).toBe('merge-main-request'); expect(a.body).toContain('Merge origin/main'); }
    const posted: string[] = [];
    const sent = new Set([v.lever.actions[0]!.key]);
    const did = await executeThroughput(v, { card: (to) => { posted.push(to); return String(posted.length); }, sentKeys: () => sent, record: () => {} }, 'live');
    expect(did[0]!.status).toBe('skip');
    expect(did.filter(d => d.status === 'did').length).toBe(v.lever.actions.length - 1);
  });

  test('seed 2 tsc OOM → the receipt gets a re-run card on another host even when tsc-blind is not the binding constraint', async () => {
    const v = decideThroughput(seedWorld(2));
    expect(v.active.map(a => a.kind)).toContain('pregate-blind');
    expect(v.safety).toHaveLength(1);
    expect(v.safety[0]!.body).toContain('--host node-b');
    expect(v.safety[0]!.to).toEqual(['TC-H-CC-2', 'RES']);
    const did = await executeThroughput(v, null, 'manual');
    expect(did.map(d => d.status)).toEqual(['would']);
  });

  test('seed 3 ready drought → supply lever for OP (pipeline < target, idle hands, few ready cells)', () => {
    const v = decideThroughput(seedWorld(3));
    expect(v.binding.kind).toBe('ready-drought');
    expect(v.lever.actor).toBe('op');
    expect(v.lever.id).toBe('L-SUPPLY');
  });

  test('seed 4 judge backlog → green chain first: one JUD batch card listing the signable cells', () => {
    const v = decideThroughput(seedWorld(4));
    expect(v.chain).toBe('green');
    expect(v.binding.kind).toBe('green-judge');
    expect(v.lever.actions).toHaveLength(1);
    expect(v.lever.actions[0]!.to).toEqual(['JUD']);
    expect(v.lever.actions[0]!.body).toContain('CELL-1(#40270)');
  });

  test('seed 5 land dead → land tick lever, ahead of the slot ceiling', () => {
    const v = decideThroughput(seedWorld(5));
    expect(v.binding.kind).toBe('land-dead');
    expect(v.lever.commands[0]).toBe('eln land graph tick --json');
    expect(v.active.map(a => a.kind)).toContain('land-slots');
  });

  test('an unmeasured probe is «?», never a reason to act', () => {
    const w = { ...base(rng(9)), landsLastHour: null, greensLastHour: null, churn: null, receipts: null };
    const v = decideThroughput(w);
    expect(v.binding.kind).toBe('on-target');
    expect(v.unmeasured).toEqual(expect.arrayContaining(['churn', 'receipts']));
    expect(renderThroughputBlock(v)).toContain('착지 ?/10');
  });
});

describe('THROUGHPUT-LEVER-MEMORY', () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-ledger-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('six-hour sentKeys excludes a seven-hour-old send', () => {
    const stateRoot = join(root, 'first-send');
    const ledger = throughputLedgerPath(stateRoot);
    mkdirSync(join(stateRoot, 'loops'), { recursive: true });
    const key = 'merge-main:40280:head00000000';
    const early = new Date(Date.parse(NOW) - 7 * 60 * 60_000).toISOString();
    const late = new Date(Date.parse(NOW) - 30 * 60_000).toISOString();
    appendFileSync(ledger, [
      { at: late, key: 'merge-main:40283:head33333333', mail: ['later'] },
      { at: late, key: 'pregate-route:40281:head11111111', mail: ['other'] },
      { at: late, key: 'merge-main:40282:head22222222', outcome: 'no-effect-skip' },
      { at: early, key, mail: ['first'] },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    expect(liveThroughputActuators({ stateRoot, seatState: join(root, 'first-send-seat') }, Date.parse(NOW)).sentKeys()).not.toContain(key);
  });

  test('a stale ledger key skips sending and records no-effect-skip', async () => {
    const stateRoot = join(root, 'state');
    const ledger = throughputLedgerPath(stateRoot);
    mkdirSync(join(stateRoot, 'loops'), { recursive: true });
    const verdict = decideThroughput(seedWorld(1));
    const oldAction = verdict.lever.actions[0]!;
    const staleAt = new Date(Date.parse(NOW) - 7 * 60 * 60_000).toISOString();
    appendFileSync(ledger, `${JSON.stringify({ at: staleAt, key: oldAction.key, do: oldAction.do, to: oldAction.to, mail: ['old-mail'] })}\n`);
    appendFileSync(ledger, JSON.stringify({ at: staleAt, key: 'merge-main:40299:skip-only', outcome: 'no-effect-skip' }) + String.fromCharCode(10));
    const live = liveThroughputActuators({ stateRoot, seatState: join(root, 'seat') }, Date.parse(NOW));
    const posted: string[] = [];
    const staleVerdict = { ...verdict, safety: [], lever: { ...verdict.lever, actions: [oldAction] } };
    const did = await executeThroughput(staleVerdict, { ...live, card: async () => { posted.push(oldAction.key); return 'unexpected-mail'; } }, 'live');
    expect(posted).toEqual([]);
    expect(did).toEqual([{ key: oldAction.key, status: 'skip', evidence: 'no effect after 6 h' }]);
    const rows = readFileSync(ledger, 'utf8').trim().split(String.fromCharCode(10)).map(line => JSON.parse(line) as { key: string; outcome?: string });
    expect(rows.filter(row => row.key === oldAction.key && row.outcome === 'no-effect-skip')).toEqual([{ key: oldAction.key, outcome: 'no-effect-skip' }]);
    expect(live.sentKeys()).not.toContain(oldAction.key);
    expect(live.staleKeys?.()).toContain(oldAction.key);
    expect(live.staleKeys?.()).not.toContain('merge-main:40299:skip-only');
  });

  test('a changed PR head receives a new merge-main card immediately', async () => {
    const original = seedWorld(1);
    const originalAction = decideThroughput(original).lever.actions.find(action => action.key.startsWith('merge-main:40280:'))!;
    const stateRoot = join(root, 'changed-head');
    const ledger = throughputLedgerPath(stateRoot);
    mkdirSync(join(stateRoot, 'loops'), { recursive: true });
    const previousSend = { at: ago(30), key: originalAction.key, do: originalAction.do, to: originalAction.to, mail: ['previous-head-mail'] };
    appendFileSync(ledger, `${JSON.stringify(previousSend)}\n`);
    const changedSnapshot = { ...original, openPrs: original.openPrs!.map((pr, index) => index === 0 ? { ...pr, head: 'f'.repeat(40) } : pr) };
    const changedVerdict = decideThroughput(changedSnapshot);
    const changedAction = changedVerdict.lever.actions.find(action => action.key.startsWith('merge-main:40280:'))!;
    const changedOnlyVerdict = { ...changedVerdict, safety: [], lever: { ...changedVerdict.lever, actions: [changedAction] } };
    const live = liveThroughputActuators({ stateRoot, seatState: join(root, 'changed-head-seat') }, Date.parse(NOW));
    const posted: string[] = [];
    const changedDid = await executeThroughput(changedOnlyVerdict, { ...live, card: async () => { posted.push(changedAction.key); return 'changed-head-mail'; } }, 'live');
    const rows = readFileSync(ledger, 'utf8').trim().split(String.fromCharCode(10)).map(line => JSON.parse(line) as { key: string; mail?: string[] });
    expect(originalAction.key).not.toBe(changedAction.key);
    expect(changedAction.key).toContain('f'.repeat(12));
    expect(changedDid).toHaveLength(1);
    expect(changedDid[0]).toMatchObject({ key: changedAction.key, status: 'did' });
    expect(posted).toEqual([changedAction.key]);
    expect(rows).toContainEqual(previousSend);
    expect(rows).toContainEqual(expect.objectContaining({ key: changedAction.key, mail: ['changed-head-mail'] }));
  });
});

describe('land order — churn victims first', () => {
  const pr = (n: number, head: string, files: string[]): PrInfo => ({ number: n, head, base: 'main', draft: false, state: 'OPEN', title: `t${n}`, author: 'a', files });
  const row = (prN: number, head: string, at: string, cls: LedgerRow['cls']): LedgerRow => ({ at, pr: prN, head, mode: 'live', event: 'refused', cls });
  test('a PR refused for churn on an older head lands before lane-mates; one refused on its current head does not jump', () => {
    const prs = [pr(40281, 'h1', ['src/els/attach-app.ts']), pr(40285, 'new5', ['src/els/attach-app.ts']), pr(40290, 'h9', ['src/x.ts'])];
    const rows = [row(40285, 'old5', ago(30), 'stale-base-revert'), row(40285, 'old4', ago(60), 'merge-conflict'), row(40290, 'h9', ago(10), 'merge-conflict')];
    expect(landOrder(prs, rows, Date.parse(NOW)).map(p => p.number)).toEqual([40285, 40281, 40290]);
  });
  test('refusals older than 2 h and other classes keep number order', () => {
    const prs = [pr(2, 'b', ['f']), pr(1, 'a', ['f'])];
    expect(landOrder(prs, [row(2, 'old', ago(200), 'stale-base-revert'), row(2, 'old', ago(10), 'tsc')], Date.parse(NOW)).map(p => p.number)).toEqual([1, 2]);
  });
});
