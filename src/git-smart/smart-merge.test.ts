// SMART-MERGE (CEO 11-27 10:0x) — real temp git repos: squash-then-stack rebuild, main-only merge = empty range-diff,
// list-append conflicts auto-resolved, revert guard trips, LLM capsule path, head-moved / closed / fetch failure / lock.
// Expected values are literals written from the scenario, not computed by the code under test.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitWorld } from './fixture.js';
import { deltaSince, prDelta, stablePatchId } from './delta.js';
import { revertGuard } from './revert-guard.js';
import { importUnion, parseDiff3, resolveFileStructurally } from './conflict-ladder.js';
import { acquirePrLock, smartRefresh, smartRefreshSync } from './smart-refresh.js';
import { runFinisher, settle, type FinishBook, type FinishDeps } from '../land-graph/finisher.js';
import type { PrInfo } from '../land-graph/land-graph.js';

setDefaultTimeout(120_000); // real git repos: a loaded pregate host takes seconds per scenario

const worlds: GitWorld[] = [];
const world = (files?: Record<string, string>) => { const w = new GitWorld(files); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.dispose(); });

const LIST = (items: string[]) => `export const REGISTRY = [\n${items.map(i => `  '${i}',`).join('\n')}\n];\n`;

describe('conflict ladder — structural rules (pure)', () => {
  test('diff3 hunk where both sides append to a list → union, both entries kept', () => {
    const text = "export const R = [\n  'a',\n<<<<<<< ours\n  'pr',\n||||||| base\n=======\n  'main',\n>>>>>>> theirs\n];\n";
    expect(parseDiff3(text)).toHaveLength(1);
    const r = resolveFileStructurally('src/r.ts', text)!;
    expect(r.left).toHaveLength(0);
    expect(r.text).toBe("export const R = [\n  'a',\n  'main',\n  'pr',\n];\n");
  });
  test('one-line registry where both sides insert an id → both ids', () => {
    const text = "<<<<<<< ours\nexport const IDS = ['a', 'b', 'pr'] as const;\n||||||| base\nexport const IDS = ['a', 'b'] as const;\n=======\nexport const IDS = ['a', 'b', 'main'] as const;\n>>>>>>> theirs\n";
    expect(resolveFileStructurally('src/ids.ts', text)!.text).toBe("export const IDS = ['a', 'b', 'main', 'pr'] as const;\n");
  });
  test('import union merges named specifiers of one module', () => {
    expect(importUnion(["import { a, b } from './x.js';"], ["import { a, c } from './x.js';", "import { y } from './y.js';"]))
      .toEqual(["import { a, b, c } from './x.js';", "import { y } from './y.js';"]);
  });
  test('import union is three-way: a name one side removed stays removed (real 11-27 merge: DEFAULT_RETRY_HOSTS)', () => {
    expect(importUnion(["import { defaultRetryHosts, nextHost } from './r.js';"], ["import { DEFAULT_RETRY_HOSTS, nextHost, tscHostsFor } from './r.js';"], ["import { DEFAULT_RETRY_HOSTS, nextHost } from './r.js';"]))
      .toEqual(["import { defaultRetryHosts, nextHost, tscHostsFor } from './r.js';"]);
  });
  test('the same item insertion is aligned to a list boundary; equal line counts resolve line by line', () => {
    const base = "  for (const p of ['graph', 'machine', 'seat', 'supervisors', 'toolbatch']) {";
    const text = `<<<<<<< ours\n${base.replace("'supervisors'", "'smart-merge', 'supervisors'")}\nx = ['a', 'b'];\n||||||| base\n${base}\nx = ['a'];\n=======\n${base.replace("'machine'", "'llm-route', 'machine'")}\nx = ['a', 'c'];\n>>>>>>> theirs\n`;
    expect(resolveFileStructurally('src/t.test.ts', text)!.text).toBe("  for (const p of ['graph', 'llm-route', 'machine', 'seat', 'smart-merge', 'supervisors', 'toolbatch']) {\nx = ['a', 'c', 'b'];\n");
  });
  test('operator insertions never merge inline: same `!` on both sides stays one `!` (not `!!`) · different operators stay a conflict', () => {
    const same = "<<<<<<< ours\nif (!isAdmin) go();\n||||||| base\nif (isAdmin) go();\n=======\nif (!isAdmin) go();\n>>>>>>> theirs\n";
    expect(resolveFileStructurally('src/a.ts', same)!.text).toBe('if (!isAdmin) go();\n');
    const diff = "<<<<<<< ours\nif (!isAdmin) go();\n||||||| base\nif (isAdmin) go();\n=======\nif (isAdmin && ok) go();\n>>>>>>> theirs\n";
    expect(resolveFileStructurally('src/a.ts', diff)!.left).toHaveLength(1);
  });
  test('both sides rewrite the same line differently → left for the LLM step', () => {
    const text = "<<<<<<< ours\nconst t = 30;\n||||||| base\nconst t = 10;\n=======\nconst t = 20;\n>>>>>>> theirs\n";
    expect(resolveFileStructurally('src/t.ts', text)!.left).toHaveLength(1);
  });
});

describe('PR-own delta', () => {
  test('stable patch-id passes the measured diff and fails closed on git error', () => {
    const diff = 'measured diff\n';
    const sha = 'a'.repeat(40);
    let seen: unknown;
    expect(stablePatchId((args, opts) => {
      seen = { args, input: opts?.input };
      return { status: 0, stdout: `${sha} 0000000000000000000000000000000000000000\n`, stderr: '' };
    }, diff)).toBe(sha);
    expect(seen).toEqual({ args: ['patch-id', '--stable'], input: diff });
    expect(stablePatchId(() => ({ status: 1, stdout: `${sha} ignored`, stderr: 'failure' }), diff)).toBeNull();
  });
  test('a head that only merged main has an empty range-diff · an author edit does not', () => {
    const w = world({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    const h1 = w.onBranch('pr', { 'a.ts': 'export const a = 2;\n' }, 'pr edit', 'main');
    w.onMain({ 'b.ts': 'export const b = 2;\n' });
    const h2 = w.mergeMainInto('pr');
    const h3 = w.onBranch('pr', { 'a.ts': 'export const a = 3;\n' }, 'author edit');
    w.l(['fetch', '-q', 'origin']);
    const same = deltaSince(w.landRun, h1, h2);
    expect(same).toMatchObject({ same: true, rangeDiff: '', chars: 0 });
    const moved = deltaSince(w.landRun, h1, h3);
    expect('error' in moved ? moved.error : moved.same).toBe(false);
    expect('error' in moved ? '' : moved.rangeDiff).toContain('export const a = 3;');
    // whitespace-only change (indentation can carry meaning) is not «same»
    const h4 = w.onBranch('pr', { 'a.ts': '  export const a = 3;\n' }, 'indent only');
    w.l(['fetch', '-q', 'origin']);
    const ws = deltaSince(w.landRun, h3, h4);
    expect('error' in ws ? 'error' : ws.same).toBe(false);
    const d = prDelta(w.landRun, h2);
    expect('error' in d ? [] : d.files).toEqual(['a.ts']);
  });
});

describe('stack rebuild after squash', () => {
  test('child of a squash-landed parent → own commit rebuilt onto main, fast-forward push, PR diff = child files only', () => {
    const w = world({ 'a.ts': 'line1\nline2\n', 'b.ts': 'b1\n' });
    const parent = w.onBranch('parent', { 'a.ts': 'line1\nline2\nparent-added\n' }, 'parent', 'main');
    const child = w.onBranch('child', { 'b.ts': 'b1\nchild-added\n' }, 'child', 'parent');
    w.squashLand('parent');
    // main edits next to the parent's line after the squash — a plain «merge main into child» conflicts on a.ts.
    w.onMain({ 'a.ts': 'line1\nline2-edited\nparent-added\n' }, 'follow-up');
    const r = smartRefreshSync({ repo: w.land, pr: 2, head: child, branch: 'child', parentHeads: [parent], lockDir: w.lockDir });
    expect(r.result).toBe('rebuilt');
    const nh = w.remoteHead('child');
    expect(nh).toBe('newHead' in r ? r.newHead : '');
    expect(w.l(['rev-parse', `${nh}^1`])).toBe(child); // fast-forward of the old head — no force push
    // The published merge has the old child and main as parents; the rebuilt
    // cherry-pick tree is published directly, not as a separate parent commit.
    expect(w.l(['rev-parse', `${nh}^2`])).toBe(w.remoteHead('main'));
    expect(w.l(['show', '-s', '--format=%P', nh]).split(' ')).toEqual([child, w.remoteHead('main')]);
    expect(w.changed('main', nh)).toEqual(['b.ts']);
    expect(w.show(nh, 'a.ts')).toBe('line1\nline2-edited\nparent-added');
    expect(w.show(nh, 'b.ts')).toBe('b1\nchild-added');
  });

  test('four-layer stack survives successive squash lands and rebuilds', () => {
    const w = world({ 'base.ts': 'base\n' });
    const a = w.onBranch('a', { 'a.ts': 'a\n' }, 'a', 'main');
    w.onBranch('b', { 'b.ts': 'b1\n' }, 'b1', 'a');
    const b = w.onBranch('b', { 'b.ts': 'b1\nb2\n' }, 'b2');
    const c = w.onBranch('c', { 'c.ts': 'c\n' }, 'c', 'b');
    const d = w.onBranch('d', { 'd.ts': 'd\n' }, 'd', 'c');

    w.squashLand('a');
    const rebuild = (pr: number, branch: string, head: string, parentHeads: string[], file: string) => {
      const main = w.remoteHead('main');
      const r = smartRefreshSync({ repo: w.land, pr, head, branch, parentHeads, lockDir: w.lockDir });
      expect(r.result).toBe('rebuilt');
      expect('pushed' in r && r.pushed).toBe(true);
      const rebuilt = w.remoteHead(branch);
      expect(rebuilt).toBe('newHead' in r ? r.newHead : '');
      expect(w.l(['show', '-s', '--format=%P', rebuilt]).split(' ')).toEqual([head, main]);
      expect(w.changed('main', rebuilt)).toEqual([file]);
      return rebuilt;
    };
    const rb = rebuild(2, 'b', b, [a], 'b.ts');
    expect(w.show(rb, 'a.ts')).toBe('a');
    expect(w.show(rb, 'b.ts')).toBe('b1\nb2');
    w.squashLand('b');
    const rc = rebuild(3, 'c', c, [a, rb], 'c.ts');
    expect(w.show(rc, 'a.ts')).toBe('a');
    expect(w.show(rc, 'b.ts')).toBe('b1\nb2');
    expect(w.show(rc, 'c.ts')).toBe('c');
    w.squashLand('c');
    const rd = rebuild(4, 'd', d, [a, rb, rc], 'd.ts');
    expect(w.show(rd, 'a.ts')).toBe('a');
    expect(w.show(rd, 'b.ts')).toBe('b1\nb2');
    expect(w.show(rd, 'c.ts')).toBe('c');
    expect(w.show(rd, 'd.ts')).toBe('d');
  });

  test('without the parent head the same child goes through merge and the ladder', () => {
    const w = world({ 'a.ts': 'line1\nline2\n', 'b.ts': 'b1\n' });
    w.onBranch('parent', { 'a.ts': 'line1\nline2\nparent-added\n' }, 'parent', 'main');
    const child = w.onBranch('child', { 'b.ts': 'b1\nchild-added\n' }, 'child', 'parent');
    w.squashLand('parent');
    w.onMain({ 'a.ts': 'line1\nline2-edited\nparent-added\n' }, 'follow-up');
    const r = smartRefreshSync({ repo: w.land, pr: 2, head: child, branch: 'child', lockDir: w.lockDir });
    expect(r.result).toBe('needs-llm');
    expect(w.remoteHead('child')).toBe(child);
  });
});

describe('merge main with conflicts', () => {
  test('list-append conflict auto-resolved, both entries kept, pushed', () => {
    const w = world({ 'src/registry.ts': LIST(['a', 'b']) });
    const h = w.onBranch('pr', { 'src/registry.ts': LIST(['a', 'b', 'pr-entry']) }, 'pr', 'main');
    w.onMain({ 'src/registry.ts': LIST(['a', 'b', 'main-entry']) });
    const r = smartRefreshSync({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir });
    expect(r.result).toBe('merged');
    expect('resolved' in r ? r.resolved : []).toEqual([{ path: 'src/registry.ts', rule: 'append-union' }]);
    expect(w.show('pr', 'src/registry.ts')).toBe("export const REGISTRY = [\n  'a',\n  'b',\n  'main-entry',\n  'pr-entry',\n];");
  });

  test('semantic conflict → needs-llm in tick · capsule with a fake LLM resolves and pushes · markers → card', async () => {
    const w = world({ 'src/t.ts': 'export const t = 10;\n' });
    const h = w.onBranch('pr', { 'src/t.ts': 'export const t = 30;\n' }, 'pr', 'main');
    w.onMain({ 'src/t.ts': 'export const t = 20;\n' });
    expect(smartRefreshSync({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir })).toMatchObject({ result: 'needs-llm', files: ['src/t.ts'] });
    const bad = await smartRefresh({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir, llm: async (_p, t) => t });
    expect(bad.result).toBe('conflict');
    const good = await smartRefresh({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir, llm: async () => 'export const t = 50;\n' });
    expect(good.result).toBe('merged');
    expect(w.show('pr', 'src/t.ts')).toBe('export const t = 50;');
  });
});

describe('rerere', () => {
  test('a hand resolution recorded in the shared repository is replayed (rung a) · our own resolutions are never recorded', async () => {
    const w = world({ 'src/t.ts': 'export const t = 10;\n' });
    const h = w.onBranch('pr', { 'src/t.ts': 'export const t = 30;\n' }, 'pr', 'main');
    w.onMain({ 'src/t.ts': 'export const t = 20;\n' });
    // our LLM resolution in a dry run must not be replayed later
    const dry = await smartRefresh({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir, push: false, llm: async () => 'export const t = 99;\n' });
    expect(dry.result).toBe('merged');
    expect(smartRefreshSync({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir }).result).toBe('needs-llm');
    // a hand resolves the same conflict in the land repository with rerere on (records it), then throws the merge away
    w.l(['fetch', '-q', 'origin']);
    w.l(['checkout', '-q', '-B', 'hand', h]);
    w.landRun(['-c', 'rerere.enabled=true', '-c', 'user.name=h', '-c', 'user.email=h@h', 'merge', '--no-edit', 'origin/main']);
    writeFileSync(join(w.land, 'src/t.ts'), 'export const t = 77;\n');
    w.l(['add', 'src/t.ts']);
    w.l(['-c', 'rerere.enabled=true', '-c', 'user.name=h', '-c', 'user.email=h@h', 'commit', '-q', '--no-edit']);
    w.l(['checkout', '-q', 'main']);
    const r = smartRefreshSync({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir });
    expect(r.result).toBe('merged');
    expect('resolved' in r ? r.resolved : []).toEqual([{ path: 'src/t.ts', rule: 'rerere' }]);
    expect(w.show('pr', 'src/t.ts')).toBe('export const t = 77;');
  });
});

describe('revert guard', () => {
  test('a result that drops other PRs\' lines trips · the PR\'s own removal does not', () => {
    const w = world({ 'x.ts': 'keep1\nkeep2\nmid1\nmid2\nmid3\n' });
    const head = w.onBranch('pr', { 'x.ts': 'keep1\nmid1\nmid2\nmid3\n' }, 'pr drops keep2', 'main');
    const lines = Array.from({ length: 20 }, (_, i) => `other-pr-line-${i}`).join('\n');
    w.onMain({ 'x.ts': `keep1\nkeep2\nmid1\nmid2\nmid3\n${lines}\n` }, 'other PR');
    w.l(['fetch', '-q', 'origin']);
    const main = w.l(['rev-parse', 'origin/main']);
    const mb = w.l(['merge-base', main, head]);
    // A bad automatic result: the stale copy (the PR's own x.ts) — wipes main's 20 lines.
    const stale = w.l(['commit-tree', `${head}^{tree}`, '-p', main, '-m', 'stale']);
    const g = revertGuard(w.landRun, { mainRef: main, result: stale, ownBase: mb, ownHead: head });
    expect(g.ok).toBe(false);
    expect(g.foreign).toEqual([{ file: 'x.ts', lines: 20, sample: ['other-pr-line-0', 'other-pr-line-1', 'other-pr-line-2'] }]);
    // The right merge keeps main's lines and drops only keep2 (the PR's own change).
    const goodTree = w.l(['merge-tree', '--write-tree', main, head]);
    const good = w.l(['commit-tree', goodTree, '-p', main, '-m', 'good']);
    expect(revertGuard(w.landRun, { mainRef: main, result: good, ownBase: mb, ownHead: head }).ok).toBe(true);
  });
});

describe('revert guard — short lines and hand-resolved merges', () => {
  test('three short lines of another PR removed → trips', () => {
    const w = world({ 'y.ts': 'a\n' });
    const head = w.onBranch('pr', { 'y.ts': 'a\n' }, 'pr noop', 'main');
    w.onMain({ 'y.ts': 'a\n}\n)\n;\n' }, 'other PR short lines');
    w.l(['fetch', '-q', 'origin']);
    const main = w.l(['rev-parse', 'origin/main']);
    const mb = w.l(['merge-base', main, head]);
    const stale = w.l(['commit-tree', `${head}^{tree}`, '-p', main, '-m', 'stale']);
    expect(revertGuard(w.landRun, { mainRef: main, result: stale, ownBase: mb, ownHead: head }).foreign).toEqual([{ file: 'y.ts', lines: 3, sample: ['}', ')', ';'] }]);
  });
  test('a stack child with a hand-resolved merge commit is merged, not rebuilt (the resolution is kept)', () => {
    const w = world({ 'a.ts': 'one\ntwo\n', 'k.ts': 'k0\n' });
    const parent = w.onBranch('parent', { 'a.ts': 'one\ntwo\nparent\n' }, 'parent', 'main');
    w.onBranch('child', { 'k.ts': 'k-child\n' }, 'child', 'parent');
    w.onMain({ 'k.ts': 'k-main\n' }, 'main edits k');
    // the hand merges main and resolves k.ts to a third value
    w.a(['fetch', '-q', 'origin']); w.checkout('child');
    w.authorRun(['merge', '--no-edit', 'origin/main']);
    w.write({ 'k.ts': 'k-resolved\n' }); w.a(['add', 'k.ts']); w.a(['commit', '-q', '--no-edit']); w.a(['push', '-q', 'origin', 'child']);
    w.squashLand('parent');
    const r = smartRefreshSync({ repo: w.land, pr: 2, head: w.remoteHead('child'), branch: 'child', parentHeads: [parent], lockDir: w.lockDir });
    expect(r.result).toBe('merged');
    expect(w.show('child', 'k.ts')).toBe('k-resolved');
  });
});

describe('safety', () => {
  test('expected head ≠ remote branch (force-pushed upstream) → head-moved, nothing pushed', () => {
    const w = world({ 'a.ts': '1\n' });
    const h = w.onBranch('pr', { 'a.ts': '2\n' }, 'pr', 'main');
    w.onMain({ 'b.ts': 'b\n' });
    const r = smartRefreshSync({ repo: w.land, pr: 1, head: 'f'.repeat(40), branch: 'pr', lockDir: w.lockDir });
    expect(r.result).toBe('head-moved');
    expect(w.remoteHead('pr')).toBe(h);
  });
  test('PR closed mid-way → closed, nothing pushed', () => {
    const w = world({ 'a.ts': '1\n' });
    const h = w.onBranch('pr', { 'a.ts': '2\n' }, 'pr', 'main');
    w.onMain({ 'b.ts': 'b\n' });
    const r = smartRefreshSync({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir, stillOpen: () => false });
    expect(r.result).toBe('closed');
    expect(w.remoteHead('pr')).toBe(h);
  });
  test('fetch failure → error, nothing pushed', () => {
    const w = world({ 'a.ts': '1\n' });
    const h = w.onBranch('pr', { 'a.ts': '2\n' }, 'pr', 'main');
    w.onMain({ 'b.ts': 'b\n' });
    const r = smartRefreshSync({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir,
      gitFor: (cwd) => { const g = w.landRun; return cwd === w.land ? (args, o) => (args[0] === 'fetch' ? { status: 128, stdout: '', stderr: 'network down' } : g(args, o)) : g; } });
    expect(r.result).toBe('error');
    expect(w.remoteHead('pr')).toBe(h);
  });
  test('two finishers on one PR → the second is busy (lock)', () => {
    const w = world();
    const release = acquirePrLock(w.lockDir, 7);
    expect(release).not.toBeNull();
    expect(acquirePrLock(w.lockDir, 7)).toBeNull();
    expect(smartRefreshSync({ repo: w.land, pr: 7, head: 'a'.repeat(40), branch: 'x', lockDir: w.lockDir }).result).toBe('busy');
    release!();
    expect(acquirePrLock(w.lockDir, 7)).not.toBeNull();
  });
});

describe('finisher wiring', () => {
  const pr: PrInfo = { number: 9, head: 'a'.repeat(40), base: 'main', draft: false, state: 'OPEN', title: 't', author: 'TC', files: [], headRef: 'b' };
  test('needs-llm → LLM capsule launched (resolving) → new head = refreshed; same head = failed', () => {
    const book: FinishBook = { jobs: {} };
    let alive = true;
    const d: FinishDeps = { now: () => new Date('2026-11-27T10:00:00Z'), launchPregate: () => ({ ok: false }), alive: () => alive, hasReceipt: () => null,
      refresh: () => ({ result: 'needs-llm', why: 'src/t.ts' }), launchResolve: () => ({ ok: true, pid: 4242 }) };
    expect(runFinisher(book, [{ pr, kind: 'refresh', parentHeads: ['b'.repeat(40)] }], d, true).map(o => o.state)).toEqual(['resolving']);
    expect(settle(book, { ...d, headNow: () => pr.head })).toHaveLength(0); // capsule still alive
    alive = false;
    expect(settle(book, { ...d, headNow: () => 'c'.repeat(40) }).map(j => j.state)).toEqual(['refreshed']);
    const book2: FinishBook = { jobs: {} };
    runFinisher(book2, [{ pr, kind: 'refresh' }], d, true);
    expect(settle(book2, { ...d, headNow: () => pr.head }).map(j => j.state)).toEqual(['failed']);
  });
  test('a green pregate on the same head does not shadow the refresh · pre-smart conflict rows retry · smart conflicts retry after 60 min', () => {
    const now = Date.parse('2026-11-27T15:00:00Z');
    let calls = 0;
    const d: FinishDeps = { now: () => new Date(now), launchPregate: () => ({ ok: false }), alive: () => false, hasReceipt: () => null,
      refresh: () => { calls++; return { result: 'merged', newHead: 'd'.repeat(40) }; } };
    const pass = { pr: 9, head: pr.head, kind: 'pregate' as const, state: 'pass' as const, at: '2026-11-27T14:00:00Z' };
    expect(runFinisher({ jobs: { [`9@${pr.head}`]: pass } }, [{ pr, kind: 'refresh' }], d, true).map(o => o.state)).toEqual(['refreshed']);
    const legacy = { pr: 9, head: pr.head, kind: 'refresh' as const, state: 'conflict' as const, at: '2026-11-27T14:50:00Z' };
    expect(runFinisher({ jobs: { [`9@${pr.head}`]: legacy } }, [{ pr, kind: 'refresh' }], d, true).map(o => o.state)).toEqual(['refreshed']);
    const recent = { ...legacy, smart: true };
    expect(runFinisher({ jobs: { [`9@${pr.head}#refresh`]: recent } }, [{ pr, kind: 'refresh' }], d, true).map(o => o.state)).toEqual(['conflict']);
    const old = { ...legacy, smart: true, at: '2026-11-27T13:30:00Z' };
    expect(runFinisher({ jobs: { [`9@${pr.head}#refresh`]: old } }, [{ pr, kind: 'refresh' }], d, true).map(o => o.state)).toEqual(['refreshed']);
    expect(calls).toBe(3);
  });
  test('rebuild already on main = pass (no card) · guard = conflict (card)', () => {
    const mk = (result: 'up-to-date' | 'guard'): FinishDeps => ({ now: () => new Date(), launchPregate: () => ({ ok: false }), alive: () => false, hasReceipt: () => null, refresh: () => ({ result, why: 'x' }) });
    expect(runFinisher({ jobs: {} }, [{ pr, kind: 'rebuild' }], mk('up-to-date'), true)[0]!.state).toBe('pass');
    expect(runFinisher({ jobs: {} }, [{ pr, kind: 'refresh' }], mk('guard'), true)[0]!.state).toBe('conflict');
  });
});
