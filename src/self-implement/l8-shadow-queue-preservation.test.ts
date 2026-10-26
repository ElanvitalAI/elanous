import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runL8ShadowQueue, type L8ShadowQueueDeps, type L8ShadowVerdict } from './l8-merge-queue.js';

const sha = (seed: string): string => createHash('sha256').update(seed).digest('hex').slice(0, 40);
const MAIN = sha('main');
const FORK = sha('fork');
const HEADS: Record<number, string> = { 101: sha('pr-101'), 202: sha('pr-202'), 303: sha('pr-303') };

type View = { headRefOid: string; baseRefName: string; state: string; isDraft: boolean; isCrossRepository: boolean };
const readyView = (number: number): View => ({ headRefOid: HEADS[number], baseRefName: 'main', state: 'OPEN', isDraft: false, isCrossRepository: false });
type SeamResult = { status: number | null; stdout: string; stderr: string };

/** Deterministic gh/git/bun seam: no network, no real repository — only real temp directories. */
function makeSeam(home: string, views: Record<number, View>, failWorktreeFor: ReadonlySet<string>) {
  let fetchHead = MAIN;
  const treeCommit = new Map<string, string>();
  const ok = (stdout = ''): SeamResult => ({ status: 0, stdout, stderr: '' });
  const seam = (bin: string, args: readonly string[], cwd: string): SeamResult => {
    if (bin === 'git') {
      const sub = args[0];
      if (sub === 'rev-parse') {
        if (args.includes('--git-common-dir')) return ok(home);
        if (args[1] === 'FETCH_HEAD') return ok(fetchHead);
        if (args[1] === 'HEAD') return ok(treeCommit.get(cwd) ?? fetchHead);
      }
      if (sub === 'fetch') {
        const ref = args[2] ?? '';
        if (ref === 'refs/heads/main') { fetchHead = MAIN; return ok(); }
        const number = Number(/^refs\/pull\/(\d+)\/head$/.exec(ref)?.[1] ?? Number.NaN);
        if (Number.isInteger(number) && views[number]) { fetchHead = views[number].headRefOid; return ok(); }
        return { status: 1, stdout: '', stderr: `unknown ref ${ref}` };
      }
      if (sub === 'worktree' && args[1] === 'add') {
        const tree = args[3] ?? '';
        const commitish = args[4] ?? '';
        if (failWorktreeFor.has(commitish)) return { status: 1, stdout: '', stderr: `worktree add failed for ${commitish}` };
        treeCommit.set(tree, commitish);
        if (commitish === MAIN) {
          mkdirSync(join(tree, 'src'), { recursive: true });
          writeFileSync(join(tree, 'src/a.ts'), 'export {};\n');
          writeFileSync(join(tree, 'src/a.test.ts'), 'import { it } from "bun:test";\n');
        }
        return ok();
      }
      if (sub === 'worktree' && args[1] === 'remove') { rmSync(args[3] ?? '', { recursive: true, force: true }); return ok(); }
      if (sub === 'cat-file') return ok();
      if (sub === 'merge-base') return ok(FORK);
      if (sub === 'diff') {
        if (args.includes('--diff-filter=U')) return ok('');
        return ok('src/a.ts\0src/a.test.ts\0');
      }
      if (sub === '-c') {
        if (args.includes('merge')) return ok('merged');
        if (args.includes('commit')) return ok('committed');
      }
    }
    if (bin === 'gh' && args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify(views[Number(args[2])] ?? {}));
    if (bin === 'bun') {
      if (args[0] === 'install') return ok();
      if (args[0] === 'run' && args[1] === 'test:deterministic') return ok('\n 1 pass\n 0 fail\nRan 1 tests across 1 files\n');
    }
    return { status: 1, stdout: '', stderr: `unexpected command: ${bin} ${args.join(' ')}` };
  };
  return { seam };
}

type Ledger = {
  pending: { number: number }[];
  verdicts: { number: number; verdict: string }[];
  deferred?: { number: number; head: string; reason: string; at: string }[];
};

describe('runL8ShadowQueue reach-failure preservation', () => {
  let home: string;
  beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'elanous-l8-preserve-')); });
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  function writeLedger(numbers: number[]): void {
    const pending = numbers.map((number) => ({
      number,
      head: HEADS[number],
      files: number === 101 ? ['src/a.ts', 'src/a.test.ts'] : [`src/pr-${number}.ts`],
      overlapsWith: [],
      overlapsUnknownWith: [],
    }));
    writeFileSync(join(home, 'elanous-l8-shadow-queue.json'), JSON.stringify({ pending, verdicts: [] }, null, 2));
  }

  it('evaluates pending[0] on the single-PR path when later queued PRs are stale or fail their reach worktree', async () => {
    writeLedger([101, 202, 303]);
    const views: Record<number, View> = {
      101: readyView(101),
      202: { ...readyView(202), state: 'CLOSED' },
      303: readyView(303),
    };
    const { seam } = makeSeam(home, views, new Set([HEADS[303]]));
    const observed: L8ShadowVerdict[] = [];
    const deps: L8ShadowQueueDeps = {
      command: seam,
      acquire: async () => () => {},
      observe: (entry) => { observed.push(entry); },
    };
    const verdict = await runL8ShadowQueue(home, deps);
    expect(verdict?.number).toBe(101);
    expect(verdict?.verdict).toBe('pass');
    expect(verdict?.base).toBe(MAIN);
    expect(observed.map((entry) => [entry.number, entry.verdict])).toEqual([[101, 'pass']]);
    const ledger = JSON.parse(readFileSync(join(home, 'elanous-l8-shadow-queue.json'), 'utf8')) as Ledger;
    expect(ledger.pending.map((p) => p.number)).toEqual([202, 303]);
    expect(ledger.verdicts.map((v) => [v.number, v.verdict])).toEqual([[101, 'pass']]);
    const deferred = [...(ledger.deferred ?? [])].sort((a, b) => a.number - b.number);
    expect(deferred.map((d) => d.number)).toEqual([202, 303]);
    expect(deferred.find((d) => d.number === 202)?.reason).toContain('queued PR #202 changed or is not ready');
    expect(deferred.find((d) => d.number === 303)?.reason).toContain('worktree add failed');
  });

  it('fails closed on the head PR itself when the queue head is no longer ready', async () => {
    writeLedger([101, 202]);
    const views: Record<number, View> = { 101: { ...readyView(101), state: 'CLOSED' }, 202: readyView(202) };
    const { seam } = makeSeam(home, views, new Set());
    await expect(runL8ShadowQueue(home, { command: seam, acquire: async () => () => {} }))
      .rejects.toThrow(/queued PR #101 changed or is not ready/);
  });
});
