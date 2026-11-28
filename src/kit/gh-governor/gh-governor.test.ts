// GH-BUDGET-GOVERNOR — the one gh door's cooldown · budget · shared open-PR snapshot. Expected values are literals.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  activeCooldown, classifyGhCall, cooldownPath, detectRateLimit, ghGovernorPolicyPath, governGhRun, governorSeat, graphqlUsedLastHour,
  isGovernorRefusal, ledgerPath, noteRateLimit, parseGhGovernorPolicy, type GhGovernorPolicy, type GovernorDeps, type RawGhRun,
} from './index.js';
import { invalidateOpenPrSnapshot, readOpenPrSnapshot, snapshotPath, type SnapshotDeps, type SnapshotRun } from './open-pr-snapshot.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const r = mkdtempSync(join(tmpdir(), 'gh-gov-')); roots.push(r); return r; };
const policy = (): GhGovernorPolicy => parseGhGovernorPolicy(readFileSync(ghGovernorPolicyPath(), 'utf8'));
const T0 = Date.parse('2026-11-28T11:00:00.000Z');
const ok = (stdout: string): RawGhRun => ({ status: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });
const LIMIT = 'GraphQL: API rate limit already exceeded for user ID 19355785.';

describe('policy (graphs/policies/gh-governor.yaml)', () => {
  test('the shipped YAML parses with the incident numbers', () => {
    const p = policy();
    expect([p.snapshot.ttlSec, p.snapshot.staleMaxSec, p.snapshot.waitForRefresherSec, p.snapshot.listLimit, p.snapshot.filesBatch]).toEqual([60, 900, 20, 1000, 25]);
    expect([p.cooldown.defaultSec, p.cooldown.maxSec, p.cooldown.escalateFactor, p.cooldown.escalateWindowSec]).toEqual([120, 900, 2, 600]);
    expect(p.budget.graphqlPerSeatPerHour).toBe(300);
  });
  test('a missing number is refused, not defaulted', () => {
    expect(() => parseGhGovernorPolicy('open_pr_snapshot: { ttl_sec: 60 }\n')).toThrow('gh-governor policy: invalid open_pr_snapshot.stale_max_sec');
  });
});

describe('classify', () => {
  test('GraphQL vs REST · read vs write · meta', () => {
    expect(classifyGhCall(['api', 'graphql', '--paginate', '-f', 'query=query { viewer { login } }'])).toEqual({ kind: 'graphql', write: false, label: 'api graphql' });
    expect(classifyGhCall(['api', 'graphql', '-f', 'query=mutation { x }'])).toEqual({ kind: 'graphql', write: true, label: 'api graphql' });
    expect(classifyGhCall(['pr', 'view', '40001', '--json', 'number'])).toEqual({ kind: 'graphql', write: false, label: 'pr view' });
    expect(classifyGhCall(['pr', 'ready', '40001'])).toEqual({ kind: 'graphql', write: true, label: 'pr ready' });
    expect(classifyGhCall(['api', 'repos/o/n/compare/a...b'])).toEqual({ kind: 'rest', write: false, label: 'api rest' });
    expect(classifyGhCall(['api', '-X', 'POST', 'repos/o/n/issues'])).toEqual({ kind: 'rest', write: true, label: 'api rest' });
    expect(classifyGhCall(['api', 'rate_limit'])).toEqual({ kind: 'meta', write: false, label: 'api rate_limit' });
    expect(classifyGhCall(['auth', 'status'])).toEqual({ kind: 'meta', write: false, label: 'auth' });
  });
});

describe('secondary-limit detection', () => {
  test('the incident text · secondary wording · Retry-After · an ordinary failure', () => {
    expect(detectRateLimit(LIMIT)).toEqual({ secondary: false, text: LIMIT });
    expect(detectRateLimit('HTTP 403: You have exceeded a secondary rate limit. Retry-After: 90')).toEqual({ secondary: true, retryAfterSec: 90, text: 'HTTP 403: You have exceeded a secondary rate limit. Retry-After: 90' });
    expect(detectRateLimit('HTTP 404: Not Found')).toBeNull();
  });
});

const gov = (root: string, seat: string, now: () => number, p = policy()): GovernorDeps => ({ stateRoot: root, now, seat, policy: p });

describe('global cooldown', () => {
  test('a limit answer to one seat cools every seat: no spawn, exit 75, the ledger row says cooldown', () => {
    const root = tmp(); let now = T0; let spawned = 0;
    const exec = () => { spawned++; return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(LIMIT) }; };
    expect(governGhRun(gov(root, 'HAND-A', () => now), ['pr', 'list'], exec).status).toBe(1);
    expect(spawned).toBe(1);
    expect(JSON.parse(readFileSync(cooldownPath(root), 'utf8'))).toMatchObject({ durationSec: 120, seat: 'HAND-A', label: 'pr list', hits: 1, until: T0 + 120_000 });
    now = T0 + 30_000;
    const other = governGhRun(gov(root, 'JUD', () => now), ['pr', 'ready', '40001'], exec);
    expect([other.status, other.refused, spawned]).toEqual([75, 'cooldown', 1]);
    expect(other.stderr.toString()).toContain('[gh-governor] SKIPPED pr ready · GitHub cooldown until 11:02:00Z (90s left');
    now = T0 + 121_000;
    expect(governGhRun(gov(root, 'JUD', () => now), ['pr', 'view', '1'], () => ok('{}')).status).toBe(0);
    const rows = readFileSync(ledgerPath(root, T0), 'utf8').trim().split('\n').map(l => JSON.parse(l).o);
    expect(rows).toEqual(['rate-limited', 'cooldown', 'ok']);
  });
  test('Retry-After wins · a repeat hit within the window doubles · capped at max', () => {
    const root = tmp(); let now = T0;
    const d = gov(root, 'OP', () => now);
    expect(noteRateLimit(d, { secondary: true, retryAfterSec: 45, text: 'x' }, 'pr list').durationSec).toBe(45);
    now = T0 + 46_000;
    expect(noteRateLimit(d, { secondary: true, text: 'x' }, 'pr list').durationSec).toBe(90);
    now += 91_000;
    expect(noteRateLimit(d, { secondary: true, text: 'x' }, 'pr list').durationSec).toBe(180);
    for (let i = 0; i < 4; i++) { now = activeCooldown(d)!.until + 1_000; noteRateLimit(d, { secondary: true, text: 'x' }, 'pr list'); }
    expect(activeCooldown(d)!.durationSec).toBe(900);
    now = activeCooldown(d)!.until + 601_000; // past the escalate window: back to the default
    expect(noteRateLimit(d, { secondary: true, text: 'x' }, 'pr list').durationSec).toBe(120);
  });
  test('a late limit answer during a cooldown keeps the until (no extension storm)', () => {
    const root = tmp(); let now = T0;
    const d = gov(root, 'OP', () => now);
    noteRateLimit(d, { secondary: true, text: 'x' }, 'pr list');
    now = T0 + 10_000;
    expect(noteRateLimit(d, { secondary: true, text: 'x' }, 'api graphql')).toMatchObject({ until: T0 + 120_000, hits: 2 });
  });
});

describe('per-seat GraphQL budget', () => {
  test('reads over the hourly cap are refused once each with the git alternative · writes and other seats pass', () => {
    const root = tmp(); const now = () => T0;
    const p = parseGhGovernorPolicy(readFileSync(ghGovernorPolicyPath(), 'utf8').replace('graphql_per_seat_per_hour: 300', 'graphql_per_seat_per_hour: 3'));
    const seat = gov(root, 'HAND-A', now, p);
    for (let i = 0; i < 3; i++) expect(governGhRun(seat, ['pr', 'view', String(i)], () => ok('{}')).status).toBe(0);
    const refused = governGhRun(seat, ['pr', 'view', '9'], () => ok('{}'));
    expect([refused.status, refused.refused]).toEqual([75, 'budget']);
    expect(refused.stderr.toString()).toContain('[gh-governor] REFUSED pr view · seat HAND-A GraphQL budget 3/3 per hour');
    expect(refused.stderr.toString()).toContain('git ls-remote origin refs/pull/<N>/head');
    expect(governGhRun(seat, ['pr', 'ready', '9'], () => ok('')).status).toBe(0);
    expect(governGhRun(seat, ['api', 'repos/o/n/pulls/9'], () => ok('{}')).status).toBe(0); // REST is not the GraphQL budget
    expect(governGhRun(gov(root, 'JUD', now, p), ['pr', 'view', '9'], () => ok('{}')).status).toBe(0);
    expect(graphqlUsedLastHour(seat, 'HAND-A')).toBe(4);
    const daemon = gov(root, 'unattributed', now, p); // metered, never refused
    for (let i = 0; i < 5; i++) expect(governGhRun(daemon, ['pr', 'view', String(i)], () => ok('{}')).status).toBe(0);
    expect(graphqlUsedLastHour(daemon, 'unattributed')).toBe(5);
  });
  test('the budget key is the seat of the process', () => {
    expect(governorSeat({ ELANOUS_TRACK: 'op' }, '/x')).toBe('OP');
    expect(governorSeat({}, '/h/hq/seats/HAND-B/.claude/wt/a')).toBe('HAND-B');
    expect(governorSeat({}, '/tmp')).toBe('unattributed');
  });
});

// ── Shared snapshot ─────────────────────────────────────────────────────────────────────────────────────────────────

const listRow = (n: number, head: string) => ({ number: n, headRefOid: head, headRefName: `b${n}`, baseRefName: 'main', isDraft: false, state: 'OPEN', title: `t${n}`, author: { login: 'tc' }, body: `칸: C${n}`, labels: [] });
function fakeGitHub(rows: () => Array<{ number: number; headRefOid: string }>, filesOf: (n: number) => string[]) {
  const calls: string[] = [];
  let fail: string | null = null;
  const run = (args: string[]): SnapshotRun => {
    calls.push(args[0] === 'api' ? 'api graphql' : `${args[0]} ${args[1]}`);
    if (fail) return { ok: false, exitCode: 1, stdout: '', stderr: fail };
    if (args[0] === 'pr') return { ok: true, exitCode: 0, stdout: JSON.stringify(rows().map(r => listRow(r.number, r.headRefOid))), stderr: '' };
    const q = args.find(a => a.startsWith('query='))!;
    const repo: Record<string, unknown> = {};
    for (const m of q.matchAll(/p(\d+): pullRequest\(number: (\d+)\)/g)) {
      const n = Number(m[2]);
      repo[`p${n}`] = { headRefOid: rows().find(r => r.number === n)!.headRefOid, files: { nodes: filesOf(n).map(path => ({ path })), pageInfo: { hasNextPage: false } } };
    }
    return { ok: true, exitCode: 0, stdout: JSON.stringify({ data: { repository: repo } }), stderr: '' };
  };
  return { calls, run, setFail: (f: string | null) => { fail = f; } };
}
const snapDeps = (root: string, now: () => number, run: SnapshotDeps['run'], extra: Partial<SnapshotDeps> = {}): SnapshotDeps =>
  ({ stateRoot: root, now, policy: policy(), run, sleep: () => {}, ...extra });
const T = { slug: 'acme/widget' };

describe('open-PR snapshot', () => {
  test('five readers within the TTL → one list read · files only for unseen heads · rows keep files = [{ path }]', () => {
    const root = tmp(); let now = T0;
    const prs = [{ number: 1, headRefOid: 'a'.repeat(40) }, { number: 2, headRefOid: 'b'.repeat(40) }];
    const gh = fakeGitHub(() => prs, n => [`src/f${n}.ts`]);
    const reads = [0, 1, 2, 3, 4].map(() => readOpenPrSnapshot(T, snapDeps(root, () => now, gh.run)));
    expect(reads.map(r => r.source)).toEqual(['fresh', 'cache', 'cache', 'cache', 'cache']);
    expect(gh.calls).toEqual(['pr list', 'api graphql']);
    expect(reads[4]!.prs.map(p => [p.number, p.body, p.files])).toEqual([[1, '칸: C1', [{ path: 'src/f1.ts' }]], [2, '칸: C2', [{ path: 'src/f2.ts' }]]]);
    // TTL passed, same heads: the list only (files cache by number@head).
    now = T0 + 61_000;
    expect(readOpenPrSnapshot(T, snapDeps(root, () => now, gh.run)).source).toBe('fresh');
    expect(gh.calls).toEqual(['pr list', 'api graphql', 'pr list']);
    // A new head on #2: one files read for it.
    prs[1] = { number: 2, headRefOid: 'c'.repeat(40) };
    now = T0 + 122_000;
    readOpenPrSnapshot(T, snapDeps(root, () => now, gh.run));
    expect(gh.calls).toEqual(['pr list', 'api graphql', 'pr list', 'pr list', 'api graphql']);
  });
  test('a reader that lost the lock waits for the refresher\'s file — never a second GitHub read', () => {
    const root = tmp(); const now = T0;
    const gh = fakeGitHub(() => [{ number: 7, headRefOid: 'd'.repeat(40) }], () => ['a.md']);
    mkdirSync(join(root, 'gh-governor'), { recursive: true });
    writeFileSync(`${snapshotPath(root, T)}.lock`, `424242 ${now}`); // a live refresher in another process
    let waits = 0;
    const r = readOpenPrSnapshot(T, snapDeps(root, () => now, gh.run, {
      alive: () => true,
      sleep: () => { if (++waits === 3) writeFileSync(snapshotPath(root, T), JSON.stringify({ v: 1, slug: T.slug, fetchedAt: now, prs: [{ number: 7, headRefOid: 'd'.repeat(40), files: [{ path: 'a.md' }] }] })); },
    }));
    expect([r.source, r.prs.length, waits, gh.calls.length]).toEqual(['cache', 1, 3, 0]);
  });
  test('cooldown: the last snapshot is served (≤ stale max) · none → GhGovernorRefusal · no GitHub read', () => {
    const root = tmp(); let now = T0;
    const gh = fakeGitHub(() => [{ number: 1, headRefOid: 'a'.repeat(40) }], () => ['x.ts']);
    readOpenPrSnapshot(T, snapDeps(root, () => now, gh.run));
    now = T0 + 120_000;
    noteRateLimit(gov(root, 'OP', () => now), { secondary: true, text: LIMIT }, 'pr list');
    expect(readOpenPrSnapshot(T, snapDeps(root, () => now, gh.run)).source).toBe('stale');
    invalidateOpenPrSnapshot(root, T);
    let err: unknown = null;
    try { readOpenPrSnapshot(T, snapDeps(root, () => now, gh.run)); } catch (e) { err = e; }
    expect(isGovernorRefusal(err)).toBe(true);
    expect(gh.calls).toEqual(['pr list', 'api graphql']);
  });
  test('a head that moves between the list and the files read: that PR alone is left out (meta skipped) · next refresh has it', () => {
    const root = tmp(); let now = T0;
    const prs = [{ number: 1, headRefOid: 'a'.repeat(40) }, { number: 2, headRefOid: 'b'.repeat(40) }, { number: 3, headRefOid: 'c'.repeat(40) }];
    const gh = fakeGitHub(() => prs, n => [`src/f${n}.ts`]);
    // #2 is pushed while the list answer is in flight: the files read sees its new head.
    const moving: SnapshotDeps['run'] = (args) => { const r = gh.run(args); if (args[0] === 'pr') prs[1] = { number: 2, headRefOid: 'd'.repeat(40) }; return r; };
    const r1 = readOpenPrSnapshot(T, snapDeps(root, () => now, moving));
    expect([r1.source, r1.prs.map(p => p.number), r1.skipped]).toEqual(['fresh', [1, 3], [{ number: 2, head: 'b'.repeat(40), why: 'head-moved' }]]);
    expect(readOpenPrSnapshot(T, snapDeps(root, () => now, gh.run))).toMatchObject({ source: 'cache', skipped: [{ number: 2, why: 'head-moved' }] });
    now = T0 + 61_000;
    const r2 = readOpenPrSnapshot(T, snapDeps(root, () => now, gh.run));
    expect([r2.source, r2.prs.map(p => [p.number, p.headRefOid.slice(0, 1)]), r2.skipped]).toEqual(['fresh', [[1, 'a'], [2, 'd'], [3, 'c']], undefined]);
    expect(gh.calls).toEqual(['pr list', 'api graphql', 'pr list', 'api graphql']); // the second files read = #2 only
  });
  test('partial GraphQL errors isolate only the errored alias, even on nonzero exit', () => {
    const root = tmp(); let now = T0;
    const prs = [1, 2, 3].map(n => ({ number: n, headRefOid: String(n).repeat(40) }));
    const gh = fakeGitHub(() => prs, n => [`src/f${n}.ts`]);
    const partial: SnapshotDeps['run'] = args => {
      const r = gh.run(args); if (args[0] !== 'api') return r;
      const body = JSON.parse(String(r.stdout));
      body.errors = [{ message: 'files unavailable', path: ['repository', 'p2', 'files'] }];
      return { ...r, ok: false, exitCode: 1, stdout: JSON.stringify(body), stderr: 'GraphQL: files unavailable' };
    };
    const first = readOpenPrSnapshot(T, snapDeps(root, () => now, partial));
    expect(first.prs.map(p => p.number)).toEqual([1, 3]);
    expect(first.skipped).toEqual([{ number: 2, head: '2'.repeat(40), why: 'files-unreadable' }]);
    now += 61_000;
    expect(readOpenPrSnapshot(T, snapDeps(root, () => now, gh.run)).prs.map(p => p.number)).toEqual([1, 2, 3]);
  });
  test('invalid listed OID is explicitly excluded, preserving valid PRs', () => {
    const root = tmp();
    const gh = fakeGitHub(() => [{ number: 1, headRefOid: 'a'.repeat(40) }, { number: 2, headRefOid: 'not-an-oid' }], n => [`src/f${n}.ts`]);
    const result = readOpenPrSnapshot(T, snapDeps(root, () => T0, gh.run));
    expect(result.prs.map(p => p.number)).toEqual([1]);
    expect(result.skipped).toEqual([{ number: 2, head: 'not-an-oid', why: 'invalid-head' }]);
  });
  test('a failed files request (GitHub error) keeps the old snapshot (no PR with an unknown file set)', () => {
    const root = tmp(); let now = T0;
    const prs = [{ number: 1, headRefOid: 'a'.repeat(40) }];
    const gh = fakeGitHub(() => prs, () => ['x.ts']);
    readOpenPrSnapshot(T, snapDeps(root, () => now, gh.run));
    prs.push({ number: 2, headRefOid: 'b'.repeat(40) });
    now = T0 + 61_000;
    const failing: SnapshotDeps['run'] = (args) => (args[0] === 'api' ? { ok: false, exitCode: 1, stdout: '', stderr: 'HTTP 502' } : gh.run(args));
    const r = readOpenPrSnapshot(T, snapDeps(root, () => now, failing));
    expect([r.source, r.prs.map(p => p.number)]).toEqual(['stale', [1]]);
    expect(existsSync(`${snapshotPath(root, T)}.lock`)).toBe(false);
  });
});

describe('ratchet: heavy readers go through the one door', () => {
  const repo = resolve(import.meta.dir, '../../..');
  for (const file of ['src/kit/work-pull/open-pr-pages.ts', 'src/cli/land-graph-cli.ts']) {
    test(`${file} spawns no gh of its own`, () => {
      const src = readFileSync(join(repo, file), 'utf8');
      expect(src.match(/spawnSync\(\s*(gh\(\)|'gh'|"gh")/g)).toBeNull();
      expect(src.includes('--paginate')).toBe(false);
    });
  }
});
