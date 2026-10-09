import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { addHarnessQueue, harnessQueuePath, listHarnessQueue } from '../../harness/harness-queue.js';
import { AuthorLedger } from './author-ledger.js';
import { authorDepth, authorDepthLines, collectAuthorDepth, runAuthorDepthShadow, type AuthorCell } from './author-depth.js';
import type { WorkItem } from './overlap.js';

const now = new Date('2026-10-04T15:00:00Z');
const cells: AuthorCell[] = [
  { id: 'CLAIMS1', title: 'Claims', owner: 'MK/sub', status: 'yellow', version: '0.2.15' },
  { id: 'CLOSED', title: 'Completed', owner: 'MK', status: 'green', version: '0.2.15' },
  { id: 'TC-A', title: 'TC work', owner: 'TC', status: 'yellow', version: '0.2.15' },
  { id: 'KNOW-FIND', title: 'Knowledge discovery', owner: 'MK', status: 'yellow', version: '0.2.16' },
  { id: 'TC-B', title: 'TC other', owner: 'TC', status: 'yellow', version: '0.2.16' },
];
const work: WorkItem[] = [{ kind: 'goal', ref: 'running', seat: 'TC', files: [], cells: ['TC-A'] }];
const input = { seats: ['MK', 'TC'] as const, caps: { MK: 6, TC: 8 }, running: { MK: 6, TC: 5 },
  queued: [{ seat: 'TC' as const, status: 'queued' as const, kind: 'say' as const, input: '0.2.15 칸 TC-QUEUED' }], cells, overlaps: work, now };

test('shadow clock marker survives restart and bounds a failed collection to once per 30 minutes', () => {
  const root = mkdtempSync(join(tmpdir(), 'author-depth-clock-'));
  const calls: string[] = [];
  const first = new Date('2026-10-05T00:00:00Z');
  const collect = (options?: { now?: Date }) => {
    calls.push(options!.now!.toISOString());
    throw Error('collector unavailable');
  };
  try {
    expect(() => runAuthorDepthShadow(root, first, collect)).toThrow('collector unavailable');
    expect(() => runAuthorDepthShadow(root, new Date(first.getTime() + 10 * 60_000), collect)).not.toThrow();
    expect(() => runAuthorDepthShadow(root, new Date(first.getTime() + 31 * 60_000), collect)).toThrow('collector unavailable');
    expect(calls).toEqual([first.toISOString(), new Date(first.getTime() + 31 * 60_000).toISOString()]);
    expect(readFileSync(join(root, 'orchestrator', 'author-depth-shadow-at'), 'utf8'))
      .toBe(new Date(first.getTime() + 31 * 60_000).toISOString());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shadow collector reads queue, release cells, and receipts from the tick root rather than the default instance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'author-depth-root-'));
  const at = new Date('2026-10-05T00:00:00Z');
  try {
    await addHarnessQueue({ seat: 'MK', say: '0.2.16 칸 BLOCKED' }, { root, log: () => {} });
    const releases = join(root, 'release');
    mkdirSync(releases, { recursive: true });
    const db = new Database(join(releases, 'features.sqlite'), { create: true });
    try {
      db.exec(`CREATE TABLE release_schedules (version TEXT PRIMARY KEY, cut_at TEXT NOT NULL, land_by TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);
        CREATE TABLE features (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT, kind TEXT, created_at TEXT NOT NULL);
        CREATE TABLE assignments (feature_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, disposition TEXT, evidence TEXT, title_override TEXT, owner TEXT, kind TEXT, priority TEXT, predecessors TEXT, deadline_version TEXT, ceo_minutes INTEGER, ceo_date TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);
        CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, by TEXT NOT NULL, feature_id TEXT NOT NULL, version TEXT NOT NULL, field TEXT NOT NULL, "from" TEXT, "to" TEXT, released TEXT NOT NULL, dev TEXT NOT NULL, reason TEXT);
        CREATE TABLE imported_versions (version TEXT PRIMARY KEY, json_hash TEXT, imported_at TEXT);
        CREATE TABLE evidence (feature_id TEXT NOT NULL, version TEXT NOT NULL, ref TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL);`);
      for (const [version, cut] of [['0.2.16', '2026-10-06T00:00:00Z'], ['0.2.17', '2026-10-07T00:00:00Z']]) {
        db.query('INSERT INTO release_schedules VALUES (?, ?, NULL, ?, ?)').run(version, cut, at.toISOString(), 'test');
      }
      for (const id of ['BLOCKED', 'SELECTED']) {
        db.query('INSERT INTO features VALUES (?, ?, ?, NULL, ?)').run(id, `사람이 ${id} 기록을 원한다`, 'MK', at.toISOString());
        db.query('INSERT INTO assignments (feature_id, version, status, evidence, owner, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, '0.2.16', 'yellow', '사용자는 자신의 기록을 볼 수 있어야 한다', 'MK', at.toISOString(), 'test');
      }
    } finally { db.close(); }
    const seen: string[] = [];
    runAuthorDepthShadow(root, at, options => collectAuthorDepth({ ...options, seats: ['MK'],
      caps: () => ({ MK: 2 }), running: () => ({ MK: 2 }), overlaps: () => [],
      log: (_category, event, data) => { if (event === 'would-author') seen.push(JSON.stringify(data)); },
    }));
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]!)).toMatchObject({ have: 1, cells: [
      { cellId: 'SELECTED', version: '0.2.16' },
    ] });
    const ledgerPath = join(root, 'orchestrator', 'author-ledger.sqlite');
    const ledger = new Database(ledgerPath, { readonly: true });
    try {
      expect(ledger.query('SELECT cellId, status FROM requests ORDER BY cellId').all()).toEqual([
        { cellId: 'SELECTED', status: 'queued-for-author' },
      ]);
    } finally { ledger.close(); }
    expect(listHarnessQueue({ root })).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('warm depth counts queued/launching only, orders current then next, and excludes running cells', () => {
  const result = authorDepth(input);
  expect(result.unreadable).toEqual([]);
  expect(result.seats).toEqual([
    { seat: 'MK', cap: 6, running: 6, queued: 0, target: 2, short: 2, wouldAuthor: [
      { cellId: 'CLAIMS1', version: '0.2.15', title: 'Claims' },
      { cellId: 'KNOW-FIND', version: '0.2.16', title: 'Knowledge discovery' },
    ] },
    { seat: 'TC', cap: 8, running: 5, queued: 1, target: 5, short: 4, wouldAuthor: [
      { cellId: 'TC-B', version: '0.2.16', title: 'TC other' },
    ] },
  ]);
  expect(authorDepthLines(result)).toEqual([
    'MK 6/6 · 대기 0 · 목표 2 · 모자람 2 → CLAIMS1, KNOW-FIND',
    'TC 5/8 · 대기 1 · 목표 5 · 모자람 4 → TC-B',
  ]);
});

test('candidate limit, cell id order, and blank or completed cells', () => {
  const result = authorDepth({ ...input, cells: [
    { id: 'Z', title: 'later', owner: 'MK', status: 'red', version: '0.2.15' },
    { id: 'A', title: 'first', owner: 'MK', status: 'yellow', version: '0.2.15' },
    { id: 'D', title: '  ', owner: 'MK', status: 'yellow', version: '0.2.15' },
    { id: 'B', title: 'finished', owner: 'MK', status: 'done', version: '0.2.15' },
    { id: 'C', title: 'next', owner: 'MK', status: 'yellow', version: '0.2.16' },
  ] });
  expect(result.seats[0]?.wouldAuthor.map(cell => cell.cellId)).toEqual(['A', 'Z']);
});

test('the same cell in current and next releases is selected once, preferring current', () => {
  const result = authorDepth({ ...input, cells: [
    { id: 'DUP', title: 'current title', owner: 'MK', status: 'yellow', version: '0.2.15' },
    { id: 'DUP', title: 'next title', owner: 'MK', status: 'yellow', version: '0.2.16' },
    { id: 'NEXT', title: 'next available', owner: 'MK', status: 'yellow', version: '0.2.16' },
  ] });
  expect(result.seats[0]?.wouldAuthor).toEqual([
    { cellId: 'DUP', version: '0.2.15', title: 'current title' },
    { cellId: 'NEXT', version: '0.2.16', title: 'next available' },
  ]);
});

test('collector preserves current-first release order when current version number is higher', () => {
  const root = mkdtempSync(join(tmpdir(), 'author-depth-order-'));
  try {
    const result = collectAuthorDepth({ seats: ['MK'], now,
      versions: () => ['0.2.20', '0.2.19'], caps: () => ({ MK: 6 }), running: () => ({ MK: 6 }),
      queued: () => [], overlaps: () => [], log: () => {},
      ledger: new AuthorLedger({ path: join(root, 'ledger.sqlite') }),
      cells: version => version === '0.2.20' ? [
        { id: 'Z-SHARED', title: 'current', evidence: '사람은 공유를 원한다', owner: 'MK', status: 'yellow', version },
        { id: 'A-CURRENT', title: 'current first by id', evidence: '사람은 기록을 원한다', owner: 'MK', status: 'yellow', version },
      ] : [
        { id: 'Z-SHARED', title: 'next duplicate', owner: 'MK', status: 'yellow', version },
        { id: 'B-NEXT', title: 'next', owner: 'MK', status: 'yellow', version },
      ],
    });
    expect(result.unreadable).toEqual([]);
    expect(result.seats[0]?.wouldAuthor).toEqual([
      { cellId: 'A-CURRENT', version: '0.2.20', title: 'current first by id' },
      { cellId: 'Z-SHARED', version: '0.2.20', title: 'current' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('current release wins a cell shared across seats and releases', () => {
  const result = authorDepth({ ...input, seats: ['TC', 'MK'], cells: [
    { id: 'SHARED', title: 'current MK', owner: 'MK', status: 'yellow', version: '0.2.15' },
    { id: 'SHARED', title: 'next TC', owner: 'TC', status: 'yellow', version: '0.2.16' },
    { id: 'TC-ONLY', title: 'other TC', owner: 'TC', status: 'yellow', version: '0.2.16' },
  ] });
  expect(result.seats.find(row => row.seat === 'MK')?.wouldAuthor).toEqual([{ cellId: 'SHARED', version: '0.2.15', title: 'current MK' }]);
  expect(result.seats.find(row => row.seat === 'TC')?.wouldAuthor).toEqual([{ cellId: 'TC-ONLY', version: '0.2.16', title: 'other TC' }]);
});

test('invalid snapshot clock makes selection unreadable, not an empty candidate set', () => {
  const result = authorDepth({ ...input, now: new Date(NaN) });
  expect(result.seats.map(row => row.short)).toEqual([null, null]);
  expect(result.seats.every(row => row.wouldAuthor.length === 0)).toBe(true);
  expect(result.unreadable).toEqual([{ source: 'clock', reason: 'invalid observation time' }]);
});

test('queue cell references and PR work exclude candidates even without a second real work item', () => {
  const result = authorDepth({ ...input, queued: [
    { seat: 'MK', status: 'launching', kind: 'say', input: '0.2.15 칸 CLAIMS1' },
    { seat: 'MK', status: 'launched', kind: 'say', input: '0.2.16 칸 KNOW-FIND' },
    { seat: 'TC', status: 'finished' },
  ], overlaps: [{ kind: 'pr', ref: '#42', seat: 'TC', files: [], cells: ['TC-A'] }] });
  expect(result.seats[0]).toMatchObject({ queued: 1, target: 2, short: 1, wouldAuthor: [
    { cellId: 'KNOW-FIND', version: '0.2.16' },
  ] });
  expect(result.seats[1]).toMatchObject({ queued: 0, target: 5, short: 5, wouldAuthor: [
    { cellId: 'TC-B', version: '0.2.16' },
  ] });
  expect(readFileSync(new URL('./author-depth.ts', import.meta.url), 'utf8').includes('addHarnessQueue')).toBe(false);
});

test('collecting a shadow decision leaves the isolated real queue storage unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'author-depth-queue-'));
  try {
    await addHarnessQueue({ seat: 'TC', say: '0.2.15 칸 TC-QUEUED' }, { root, log: () => {} });
    const path = harnessQueuePath(root);
    const before = readFileSync(path, 'utf8');
    const result = collectAuthorDepth({ seats: input.seats, now, versions: () => ['0.2.15', '0.2.16'],
      caps: () => input.caps, running: () => input.running,
      queued: () => listHarnessQueue({ root }), cells: version => cells.filter(cell => cell.version === version)
        .map(cell => ({ ...cell, evidence: '사용자는 더 쉬운 확인을 원한다' })),
      overlaps: () => work, log: () => {}, ledger: new AuthorLedger({ path: join(root, 'author-ledger.sqlite') }),
    });
    expect(result.unreadable).toEqual([]);
    expect(result.seats[0]?.wouldAuthor.map(cell => cell.cellId)).toEqual(['CLAIMS1', 'KNOW-FIND']);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(listHarnessQueue({ root })).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('one shadow tick checks the selected cell title and text into ledger receipts without enqueueing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'author-depth-shadow-'));
  try {
    await addHarnessQueue({ seat: 'TC', say: '0.2.16 칸 EXISTING' }, { root, log: () => {} });
    const queuePath = harnessQueuePath(root);
    const before = readFileSync(queuePath, 'utf8');
    const ledger = new AuthorLedger({ path: join(root, 'author-ledger.sqlite'), now: () => now });
    const selected: AuthorCell[] = [
      { id: 'A-DIRECTED', title: 'src/foo.ts를 수정하세요', evidence: '사용자는 변경을 쉽게 확인하고 싶다', owner: 'MK', status: 'yellow', version: '0.2.16' },
      { id: 'B-DIRECTED', title: '사람 기능', evidence: 'bun test로 판정하라', owner: 'MK', status: 'yellow', version: '0.2.16' },
      { id: 'C-HUMAN', title: '사람이 요청한 기능', evidence: '사용자는 자신의 기록을 볼 수 있어야 한다', owner: 'MK', status: 'yellow', version: '0.2.16' },
      { id: 'D-UNSELECTED', title: '사람의 다른 요구', evidence: '사람은 검색을 원한다', owner: 'MK', status: 'yellow', version: '0.2.16' },
    ];
    const requestIds: string[] = [];
    const tick = () => collectAuthorDepth({ seats: ['MK'], now, versions: () => ['0.2.16', '0.2.17'],
      caps: () => ({ MK: 4 }), running: () => ({ MK: 3 }), queued: () => listHarnessQueue({ root }),
      cells: version => selected.filter(cell => cell.version === version), overlaps: () => [], log: () => {},
      ledger: { request: input => {
        const receipt = ledger.request(input);
        requestIds.push(receipt.id);
        return receipt;
      } },
    });
    const result = tick();
    expect(result.unreadable).toEqual([]);
    expect(result.seats[0]?.wouldAuthor.map(cell => cell.cellId)).toEqual(['A-DIRECTED', 'B-DIRECTED', 'C-HUMAN']);
    const [titleReceipt, textReceipt] = requestIds.slice(0, 2).map(id => ledger.get(id));
    expect(titleReceipt).toMatchObject({ status: 'held', check: { verdict: 'resubmit' }, title: selected[0]!.title, text: selected[0]!.evidence });
    expect(titleReceipt!.check.signals).toContainEqual(expect.objectContaining({ field: 'title', kind: 'path' }));
    expect(textReceipt).toMatchObject({ status: 'held', check: { verdict: 'resubmit' }, title: selected[1]!.title, text: selected[1]!.evidence });
    expect(textReceipt!.check.signals).toContainEqual(expect.objectContaining({ field: 'text', kind: 'command' }));
    const humanReceipt = ledger.get(requestIds[2]!);
    expect(humanReceipt).toMatchObject({ status: 'queued-for-author', check: { verdict: 'approved', signals: [], ratio: 0 },
      title: selected[2]!.title, text: selected[2]!.evidence });
    expect(requestIds).toHaveLength(3);
    expect(readFileSync(queuePath, 'utf8')).toBe(before);
    expect(tick().seats[0]?.wouldAuthor.map(cell => cell.cellId)).toEqual(['A-DIRECTED', 'B-DIRECTED', 'C-HUMAN']);
    for (const id of requestIds.slice(0, 3)) expect(ledger.get(id).history).toHaveLength(1);
    expect(requestIds.slice(3)).toEqual(requestIds.slice(0, 3));
    expect(readFileSync(queuePath, 'utf8')).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('selected cells without text leave held receipts including directed title signals, never queue work', () => {
  const root = mkdtempSync(join(tmpdir(), 'author-depth-missing-'));
  try {
    const ledger = new AuthorLedger({ path: join(root, 'ledger.sqlite'), now: () => now });
    const requestIds: string[] = [];
    const selected: AuthorCell[] = [
      { id: 'A-DIRECTED', title: 'src/foo.ts를 수정하세요', owner: 'MK', status: 'yellow', version: '0.2.16' },
      { id: 'B-HUMAN', title: '사람의 요청', evidence: '  ', owner: 'MK', status: 'yellow', version: '0.2.16' },
    ];
    let queueCalls = 0;
    const result = collectAuthorDepth({ seats: ['MK'], now, versions: () => ['0.2.16', '0.2.17'],
      caps: () => ({ MK: 3 }), running: () => ({ MK: 3 }), queued: () => { queueCalls++; return []; },
      cells: version => selected.filter(cell => cell.version === version), overlaps: () => [], log: () => {},
      ledger: { request: input => { const receipt = ledger.request(input); requestIds.push(receipt.id); return receipt; } },
    });
    expect(result.seats[0]?.wouldAuthor.map(cell => cell.cellId)).toEqual(['A-DIRECTED', 'B-HUMAN']);
    expect(result.unreadable).toEqual([]);
    expect(requestIds).toHaveLength(2);
    expect(ledger.get(requestIds[0]!)).toMatchObject({ status: 'held', text: '', check: { verdict: 'uncheckable', ratio: null } });
    expect(ledger.get(requestIds[0]!).check.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'title', kind: 'path', match: 'src/foo.ts' }),
      expect.objectContaining({ field: 'text', kind: 'missing', reason: 'missing cell text' }),
    ]));
    expect(ledger.get(requestIds[1]!)).toMatchObject({ status: 'held', text: '  ', check: { verdict: 'uncheckable', ratio: null } });
    expect(ledger.get(requestIds[1]!).check.signals).toContainEqual(expect.objectContaining({ field: 'text', kind: 'missing' }));
    expect(queueCalls).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ledger write failure is observable, never silently queued', () => {
  const valid: AuthorCell = { id: 'A', title: '사람의 요청', evidence: '사용자가 기록을 볼 수 있어야 한다', owner: 'MK', status: 'yellow', version: '0.2.16' };
  const result = collectAuthorDepth({ seats: ['MK'], now, versions: () => ['0.2.16', '0.2.17'],
    caps: () => ({ MK: 3 }), running: () => ({ MK: 3 }), queued: () => [],
    cells: version => version === '0.2.16' ? [valid] : [],
    overlaps: () => [], log: () => {}, ledger: { request: () => { throw new Error('ledger offline'); } },
  });
  expect(result.seats[0]?.wouldAuthor.map(cell => cell.cellId)).toEqual(['A']);
  expect(result.unreadable).toEqual([{ source: 'author-ledger', reason: '0.2.16 A: ledger offline' }]);
  expect(result.receiptFailures).toBe(1);
  expect(result.receiptCounts).toEqual({ held: 0, queuedForAuthor: 0 });
});

test('a thrown checklist source stays unreadable and every affected short is null, with would-author logs', () => {
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const result = collectAuthorDepth({ ...input, versions: () => ['0.2.15', '0.2.16'],
    caps: () => input.caps, running: () => input.running, queued: () => input.queued,
    cells: () => { throw new Error('checklist offline'); }, overlaps: () => work,
    log: (category, event, data) => { events.push({ category, event, data }); },
  });
  expect(result.unreadable).toEqual([{ source: 'checklist', reason: 'checklist offline' }]);
  expect(result.seats.map(row => row.short)).toEqual([null, null]);
  expect(result.seats.every(row => row.wouldAuthor.length === 0)).toBe(true);
  expect(events).toEqual([
    { category: 'loop.orchestrator', event: 'would-author', data: { seat: 'MK', target: 2, have: 0, short: null, cells: [] } },
    { category: 'loop.orchestrator', event: 'would-author', data: { seat: 'TC', target: 5, have: 1, short: null, cells: [] } },
  ]);
});

test('unknown queued cell blocks only its seat while an empty queue is measurable', () => {
  const result = authorDepth({ ...input, queued: [{ seat: 'TC', status: 'queued', kind: 'say', input: 'unattributed' }] });
  expect(result.seats[0]).toMatchObject({ queued: 0, short: 2 });
  expect(result.seats[1]).toMatchObject({ queued: 1, short: null, wouldAuthor: [] });
  expect(result.unreadable).toEqual([{ source: 'queue-cells', reason: 'missing TC observation' }]);
  const empty = authorDepth({ ...input, queued: [] });
  expect(empty.seats.map(row => row.short)).toEqual([2, 5]);
  expect(empty.unreadable).toEqual([]);
});

test('unreadable queue, running or overlap does not masquerade as zero shortfall', () => {
  for (const failure of ['queued', 'running', 'overlaps'] as const) {
    const result = authorDepth({ ...input, [failure]: null });
    expect(result.seats.map(row => row.short)).toEqual([null, null]);
    expect(result.unreadable.some(row => row.source === (failure === 'queued' ? 'queue' : failure === 'overlaps' ? 'overlap' : failure))).toBe(true);
  }
  expect(authorDepth({ ...input, caps: { MK: 6, TC: 8 }, running: { MK: 9, TC: 5 } }).seats[0]).toMatchObject({ target: 2, short: 2 });
});

test('10-08 tick hang: without release cells the shadow reads neither host processes nor open work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'author-depth-no-cells-'));
  try {
    const reads: string[] = [];
    const result = collectAuthorDepth({ root: dir, now: new Date('2026-10-08T10:00:00Z'), log: () => {},
      listProcesses: () => { reads.push('processes'); throw new Error('must not read host processes'); } });
    expect(reads).toEqual([]);
    expect(result.unreadable).toEqual(expect.arrayContaining([
      { source: 'running', reason: 'skipped: no release cells to compare' },
      { source: 'overlap', reason: 'skipped: no release cells to compare' }]));
    expect(result.seats.every(row => row.wouldAuthor.length === 0)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
