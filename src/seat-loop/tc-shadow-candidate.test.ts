import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { readTcPullRequests, runSeatLoopOnce, seatLedgerPath, tcApprovalWaitAt, type SeatDeps, type TcPullRequest } from './seat-loop.js';

const now = new Date('2026-10-03T12:00:00.000Z');
const pr = (number: number, patch: Partial<TcPullRequest>): TcPullRequest => ({ number, title: `PR ${number}`, state: 'OPEN', isDraft: false,
  createdAt: '2026-10-03T09:00:00.000Z', paths: ['release/public/docs/guide.md'], ...patch });

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-shadow-'));
  const calls: string[][] = [];
  const sources = { prs: [pr(101, { title: 'TC1 landing', state: 'MERGED', mergedAt: '2026-10-03T10:00:00Z' }),
    pr(102, { readyAt: '2026-10-03T09:59:00Z', approvalWaitAt: '2026-10-03T09:59:00Z', reviewDecision: 'REVIEW_REQUIRED' }),
    pr(103, { readyAt: '2026-10-03T10:01:00Z', approvalWaitAt: '2026-10-03T10:01:00Z', reviewDecision: 'REVIEW_REQUIRED' }),
    pr(104, { isDraft: true }), pr(105, { paths: ['src/seat-loop/seat-loop.ts'] }),
    pr(106, { readyAt: '2026-10-03T09:00:00Z', approvalWaitAt: '2026-10-03T11:30:00Z', reviewDecision: 'REVIEW_REQUIRED' }),
    pr(109, { readyAt: '2026-10-03T10:00:00Z', approvalWaitAt: '2026-10-03T10:00:00Z', reviewDecision: 'REVIEW_REQUIRED' }),
    pr(107, { state: 'CLOSED' }), pr(108, { reviewDecision: 'APPROVED' }),
    pr(110, { readyAt: '2026-10-03T09:00:00Z', approvalWaitAt: '2026-10-03T09:00:00Z', updatedAt: '2026-10-03T11:55:00Z', reviewDecision: 'REVIEW_REQUIRED' }),
    pr(111, { readyAt: '2026-10-03T11:30:00Z', approvalWaitAt: '2026-10-03T11:30:00Z', createdAt: '2026-10-02T00:00:00Z', reviewDecision: 'REVIEW_REQUIRED' })], status: 'yellow' };
  const deps: SeatDeps = { root, now: () => now, config: { mode: 'shadow', seats: ['TC'] },
    pullRequests: async () => sources.prs, schedules: () => [{ version: '0.2.11', cutAt: '2026-10-04T00:00:00Z' }],
    checklistItems: () => [{ id: 'TC1', title: '착지 뒤 검증', status: sources.status, owner: 'TC', evidence: 'PR #101 merged' }],
    versions: () => [], read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } },
    run: async (args) => { calls.push(args); throw new Error('shadow called a command'); } };
  const rows = () => readFileSync(seatLedgerPath('TC', root, now), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { root, deps, calls, sources, rows, close: () => rmSync(root, { recursive: true, force: true }) };
};

test('TC shadow records merged PR with yellow cell and ready publication PR awaiting 2h, with zero write commands', async () => {
  const f = fixture();
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const result = await runSeatLoopOnce('TC', f.deps);
    expect(result).toMatchObject({ seat: 'TC', status: 'skipped-empty' });
    expect(f.rows().filter((row) => row.candidate).map((row) => row.candidate)).toEqual([
      { kind: 'merged-pr-yellow-cell', version: '0.2.11', id: 'TC1', title: '착지 뒤 검증', pr: 101, mergedAt: '2026-10-03T10:00:00Z' },
      { kind: 'publication-pr-approval-wait', pr: 102, title: 'PR 102', readyAt: '2026-10-03T09:59:00Z', approvalWaitAt: '2026-10-03T09:59:00Z', paths: ['release/public/docs/guide.md'] },
      { kind: 'publication-pr-approval-wait', pr: 109, title: 'PR 109', readyAt: '2026-10-03T10:00:00Z', approvalWaitAt: '2026-10-03T10:00:00Z', paths: ['release/public/docs/guide.md'] },
      { kind: 'publication-pr-approval-wait', pr: 110, title: 'PR 110', readyAt: '2026-10-03T09:00:00Z', approvalWaitAt: '2026-10-03T09:00:00Z', paths: ['release/public/docs/guide.md'] },
    ]);
    expect(f.rows().filter((row) => row.candidate).every((row) => row.status === 'shadow' && row.action === undefined)).toBe(true);
    expect(log.mock.calls.filter(([category, event]) => category === 'seat.loop' && event === 'tc-shadow-candidate')).toHaveLength(4);
    await runSeatLoopOnce('TC', f.deps);
    expect(f.rows().filter((row) => row.candidate)).toHaveLength(4);
    expect(f.calls).toEqual([]);
  } finally { log.mockRestore(); f.close(); }
});

test('TC uses the latest ready transition and approval request, not PR creation or comment updates', () => {
  const pending = pr(200, { reviewDecision: 'REVIEW_REQUIRED', updatedAt: '2026-10-03T11:59:00Z' });
  expect(tcApprovalWaitAt(pending, [
    { event: 'converted_to_draft', created_at: '2026-10-03T09:30:00Z' },
    { event: 'ready_for_review', created_at: '2026-10-03T09:45:00Z' },
    { event: 'review_requested', created_at: '2026-10-03T10:30:00Z' },
  ])).toEqual({ readyAt: '2026-10-03T09:45:00Z', approvalWaitAt: '2026-10-03T10:30:00Z' });
  expect(tcApprovalWaitAt(pending, [
    { event: 'converted_to_draft', created_at: '2026-10-03T10:30:00Z' },
    { event: 'ready_for_review', created_at: '2026-10-03T11:30:00Z' },
  ])).toEqual({ readyAt: '2026-10-03T11:30:00Z', approvalWaitAt: '2026-10-03T11:30:00Z' });
  expect(tcApprovalWaitAt(pending, [
    { event: 'converted_to_draft', created_at: '2026-10-03T11:30:00Z' },
  ])).toBeUndefined();
  expect(tcApprovalWaitAt(pr(201, {}), [])).toBeUndefined();
  expect(tcApprovalWaitAt(pr(202, { reviewDecision: '' }), [])).toBeUndefined();
  expect(tcApprovalWaitAt(pr(203, { reviewDecision: 'APPROVED' }), [])).toBeUndefined();
});

test('TC does not create approval wait candidates when ready or approval status is unverified', async () => {
  const f = fixture();
  try {
    f.sources.prs = [pr(201, { createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-03T11:00:00Z', reviewDecision: 'REVIEW_REQUIRED' }),
      pr(202, { readyAt: '2026-10-02T00:00:00Z', approvalWaitAt: '2026-10-02T00:00:00Z' }),
      pr(203, { readyAt: '2026-10-02T00:00:00Z', approvalWaitAt: '2026-10-02T00:00:00Z', reviewDecision: '' })];
    await runSeatLoopOnce('TC', f.deps);
    expect(f.rows().filter((row) => row.candidate)).toEqual([]);
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});

const tcListing = (number: number, state: 'open' | 'closed' = 'open', mergedAt: string | null = null) => ({
  number, title: `PR ${number}`, state, draft: false, created_at: '2026-10-03T07:00:00Z', merged_at: mergedAt,
});

test('TC PR reader fetches current review status and paginated timeline instead of update timestamps', async () => {
  const calls: string[][] = [];
  const row = (number: number, reviewDecision: string | null) => ({ number, title: `PR ${number}`, body: '', state: 'OPEN',
    isDraft: false, createdAt: '2026-10-03T07:00:00Z', updatedAt: '2026-10-03T11:59:00Z', mergedAt: null,
    files: [{ path: 'release/public/docs/guide.md' }], reviewDecision });
  const query = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === 'api' && args.at(-1)?.includes('/pulls?')) return JSON.stringify([[301, 302, 303].map((number) => ({ number, title: `PR ${number}`, created_at: '2026-10-03T07:00:00Z', draft: false, state: 'open', merged_at: null }))]);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(row(Number(args[2]), Number(args[2]) === 301 ? 'REVIEW_REQUIRED' : Number(args[2]) === 303 ? 'APPROVED' : null));
    if (args.at(-1)?.endsWith('/301/timeline')) return JSON.stringify([[
      { event: 'converted_to_draft', created_at: '2026-10-03T09:00:00Z' },
      { event: 'ready_for_review', created_at: '2026-10-03T09:30:00Z' },
      { event: 'reviewed', submitted_at: '2026-10-03T09:45:00Z', review: { state: 'commented' } },
      { event: 'committed', commit: { author: { date: '2026-10-03T09:50:00Z' }, committer: { date: '2026-10-03T09:55:00Z' } } },
    ], [{ event: 'review_requested', created_at: '2026-10-03T10:30:00Z' }]]);
    throw new Error(`unexpected query: ${args.join(' ')}`);
  };
  const prs = await readTcPullRequests(query);
  expect(prs.map(({ number, readyAt, approvalWaitAt, reviewDecision }) => ({ number, readyAt, approvalWaitAt, reviewDecision }))).toEqual([
    { number: 301, readyAt: '2026-10-03T09:30:00Z', approvalWaitAt: '2026-10-03T10:30:00Z', reviewDecision: 'REVIEW_REQUIRED' },
    { number: 302, readyAt: undefined, approvalWaitAt: undefined, reviewDecision: undefined },
    { number: 303, readyAt: undefined, approvalWaitAt: undefined, reviewDecision: 'APPROVED' },
  ]);
  expect(calls).toHaveLength(5);
  expect(calls[0]).toEqual(['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/pulls?state=all&per_page=100']);
  expect(calls.some((args) => args.join(' ') === 'api --paginate --slurp repos/{owner}/{repo}/issues/301/timeline')).toBe(true);
});

test('TC keeps the publication candidate when reviews and commits lack created_at', async () => {
  const f = fixture();
  try {
    const prs = await readTcPullRequests(async (args) => {
      if (args.at(-1)?.includes('/pulls?')) return JSON.stringify([[tcListing(306)]]);
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: 306, title: 'publish', body: '', state: 'OPEN', isDraft: false,
        createdAt: '2026-10-03T07:00:00Z', mergedAt: null, reviewDecision: 'REVIEW_REQUIRED',
        files: [{ path: 'release/public/docs/guide.md' }] });
      if (args[0] === 'api') return JSON.stringify([[
        { event: 'ready_for_review', created_at: '2026-10-03T09:00:00Z' },
        { event: 'reviewed', submitted_at: '2026-10-03T09:10:00Z' },
        { event: 'committed', commit: { author: { date: '2026-10-03T09:15:00Z' }, committer: { date: '2026-10-03T09:20:00Z' } } },
        { event: 'review_requested', created_at: '2026-10-03T09:45:00Z' },
      ]]);
      throw new Error(`unexpected query: ${args.join(' ')}`);
    });
    await runSeatLoopOnce('TC', { ...f.deps, pullRequests: async () => prs });
    expect(f.rows().filter((row) => row.candidate).map((row) => row.candidate)).toEqual([
      { kind: 'publication-pr-approval-wait', pr: 306, title: 'publish', readyAt: '2026-10-03T09:00:00Z',
        approvalWaitAt: '2026-10-03T09:45:00Z', paths: ['release/public/docs/guide.md'] },
    ]);
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});

test('TC leaves the ready time unknown when a required transition lacks its date', async () => {
  const prs = await readTcPullRequests(async (args) => {
    if (args.at(-1)?.includes('/pulls?')) return JSON.stringify([[tcListing(305)]]);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: 305, title: 'publish', body: '', state: 'OPEN', isDraft: false,
      createdAt: '2026-10-03T07:00:00Z', mergedAt: null, reviewDecision: 'REVIEW_REQUIRED',
      files: [{ path: 'release/public/docs/guide.md' }] });
    if (args[0] === 'api') return JSON.stringify([[{ event: 'ready_for_review', created_at: '2026-10-03T09:00:00Z' },
      { event: 'review_requested' }, { event: 'reviewed', submitted_at: '2026-10-03T09:30:00Z' }]]);
    throw new Error(`unexpected query: ${args.join(' ')}`);
  });
  expect(prs[0]?.readyAt).toBeUndefined();
  expect(prs[0]?.approvalWaitAt).toBeUndefined();
});

test('TC leaves the ready time unknown when the timeline cannot be read', async () => {
  const prs = await readTcPullRequests(async (args) => {
    if (args.at(-1)?.includes('/pulls?')) return JSON.stringify([[tcListing(304)]]);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: 304, title: 'publish', body: '', state: 'OPEN', isDraft: false,
      createdAt: '2026-10-03T07:00:00Z', mergedAt: null, reviewDecision: 'REVIEW_REQUIRED',
      files: [{ path: 'release/public/docs/guide.md' }] });
    throw new Error('timeline unavailable');
  });
  expect(prs[0]).toMatchObject({ reviewDecision: 'REVIEW_REQUIRED' });
  expect(prs[0]?.readyAt).toBeUndefined();
  expect(prs[0]?.approvalWaitAt).toBeUndefined();
});

test('TC records the 101st open and merged PR across paginated read-only listings', async () => {
  const f = fixture();
  const calls: string[][] = [];
  const listing = [
    ...Array.from({ length: 101 }, (_, i) => tcListing(1000 + i)),
    ...Array.from({ length: 101 }, (_, i) => ({ ...tcListing(2000 + i, 'closed', '2026-10-03T10:00:00Z'),
      title: i === 100 ? 'TC1 landing' : `PR ${i}` })),
  ];
  try {
    const prs = await readTcPullRequests(async (args) => {
      calls.push(args);
      if (args.at(-1)?.includes('/pulls?')) return JSON.stringify([listing.slice(0, 100), listing.slice(100, 200), listing.slice(200)]);
      if (args[0] === 'pr' && args[1] === 'view') {
        const number = Number(args[2]);
        return JSON.stringify({ number, title: `PR ${number}`, body: '', state: 'OPEN', isDraft: false,
          createdAt: '2026-10-03T07:00:00Z', mergedAt: null,
          reviewDecision: number === 1100 ? 'REVIEW_REQUIRED' : 'APPROVED',
          files: [{ path: number === 1100 ? 'release/public/docs/guide.md' : 'src/other.ts' }] });
      }
      if (args.at(-1)?.endsWith('/1100/timeline')) return JSON.stringify([[
        { event: 'ready_for_review', created_at: '2026-10-03T09:00:00Z' },
      ]]);
      throw new Error(`unexpected query: ${args.join(' ')}`);
    });
    await runSeatLoopOnce('TC', { ...f.deps, pullRequests: async () => prs });
    expect(f.rows().filter((row) => row.candidate).map((row) => [row.candidate.kind, row.candidate.pr])).toEqual([
      ['merged-pr-yellow-cell', 2100], ['publication-pr-approval-wait', 1100],
    ]);
    expect(calls[0]).toEqual(['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/pulls?state=all&per_page=100']);
    expect(calls.every((args) => args[0] === 'api' || args[0] === 'pr' && args[1] === 'view')).toBe(true);
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});

test('TC reads the release SQLite assignments for merged-PR shadow candidates', async () => {
  const f = fixture();
  try {
    const release = join(f.root, 'release');
    mkdirSync(release);
    const path = join(release, 'features.sqlite');
    const db = new Database(path, { create: true });
    try {
      db.exec(`CREATE TABLE features (id TEXT PRIMARY KEY, title TEXT);
        CREATE TABLE assignments (feature_id TEXT, version TEXT, title_override TEXT, status TEXT, owner TEXT);`);
      db.query('INSERT INTO features VALUES (?, ?)').run('TC1', '착지 뒤 검증');
      db.query('INSERT INTO assignments VALUES (?, ?, ?, ?, ?)').run('TC1', '0.2.11', null, 'yellow', 'TC');
    } finally { db.close(); }
    await runSeatLoopOnce('TC', { ...f.deps, schedules: undefined, checklistItems: undefined });
    expect(f.rows().filter((row) => row.candidate).map((row) => row.candidate?.kind)).toEqual([
      'merged-pr-yellow-cell', 'publication-pr-approval-wait', 'publication-pr-approval-wait', 'publication-pr-approval-wait',
    ]);
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});

test('TC does not mistake green cell, draft, closed, approved, non-publication or under-2h PR for a candidate', async () => {
  const f = fixture();
  try {
    f.sources.status = 'green';
    f.sources.prs = f.sources.prs.filter((row) => row.number !== 102 && row.number !== 109 && row.number !== 110);
    await runSeatLoopOnce('TC', f.deps);
    expect(f.rows().filter((row) => row.candidate)).toEqual([]);
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});
