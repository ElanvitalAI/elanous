import { describe, expect, test } from 'bun:test';
import { clearApprovalsReadCache, handleMergeApprovals, IDEA_APPROVAL_LABEL, type MergeApprovalsDeps } from './merge-approvals';

// The approvals page took 15s+: gh ran through spawnSync (the daemon stalled), card details were fetched
// one after another, and the page fired the list twice. These pin the three fixes.
const base = 'http://localhost/v1/approvals/merges';
const pr = (number: number) => ({
  number, title: `Idea ${number}`, url: `https://github.com/o/r/pull/${number}`, headRefOid: 'aaa',
  baseRefName: 'main', baseRefOid: 'c'.repeat(40), isDraft: false, mergeable: 'MERGEABLE', additions: 1, deletions: 0,
  changedFiles: 1, files: [{ path: 'src/a.ts' }], body: '', createdAt: '2026-09-27T00:00:00Z', state: 'OPEN',
  labels: [{ name: IDEA_APPROVAL_LABEL }], statusCheckRollup: [],
});

function slowFixture(opts: { readCacheMs?: number; delayMs?: number } = {}) {
  const rows = [pr(1), pr(2), pr(3), pr(4)];
  const calls: string[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let now = 0;
  const deps: MergeApprovalsDeps = {
    repo: () => 'o/r', authorize: () => true,
    gate: { start: () => ({ status: 'running', failures: [] }), get: () => ({ status: 'none', failures: [] }) },
    baseTip: async () => 'c'.repeat(40),
    now: () => new Date(now),
    ...(opts.readCacheMs === undefined ? {} : { readCacheMs: opts.readCacheMs }),
    gh: async (args) => {
      calls.push(args);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 20));
      inFlight--;
      if (args[1] === 'list') return { ok: true, stdout: JSON.stringify(rows), stderr: '', code: 0 };
      return { ok: true, stdout: JSON.stringify(rows[Number(args[2]) - 1]), stderr: '', code: 0 };
    },
  };
  return {
    deps, calls, get maxInFlight() { return maxInFlight; },
    advance: (ms: number) => { now += ms; },
    list: () => handleMergeApprovals(new Request(base), deps),
    check: (n: number) => handleMergeApprovals(new Request(`${base}/${n}/check`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ headSha: 'aaa' }),
    }), deps),
  };
}

describe('approvals page speed', () => {
  test('card details are fetched in parallel, not one after another', async () => {
    const f = slowFixture({ readCacheMs: 0, delayMs: 30 });
    const started = performance.now();
    const response = await f.list();
    expect(response.status).toBe(200);
    expect((await response.json()).items).toHaveLength(4);
    expect(f.maxInFlight).toBe(4);
    // list + one parallel round of views ≈ 2 × delay; serial would be 5 × delay.
    expect(performance.now() - started).toBeLessThan(30 * 4);
  });

  test('two list requests inside the cache window share one gh list and one view per card', async () => {
    clearApprovalsReadCache();
    const f = slowFixture({ readCacheMs: 15_000 });
    const [a, b] = await Promise.all([f.list(), f.list()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(f.calls.filter((args) => args[1] === 'list')).toHaveLength(1);
    expect(f.calls.filter((args) => args[1] === 'view')).toHaveLength(4);
    f.advance(16_000);
    await f.list();
    expect(f.calls.filter((args) => args[1] === 'list')).toHaveLength(2);
  });

  test('a check (or merge) drops the shared reads so the next card is fresh', async () => {
    clearApprovalsReadCache();
    const f = slowFixture({ readCacheMs: 15_000 });
    await f.list();
    await f.check(1);
    await f.list();
    expect(f.calls.filter((args) => args[1] === 'list')).toHaveLength(2);
  });

  test('a failed read is shared inside the cache window too, then retried after it', async () => {
    clearApprovalsReadCache();
    const f = slowFixture({ readCacheMs: 15_000 });
    const failing: MergeApprovalsDeps = {
      ...f.deps,
      gh: async (args) => { f.calls.push(args); return { ok: false, stdout: '', stderr: 'API rate limit exceeded', code: 1 }; },
    };
    const list = () => handleMergeApprovals(new Request(base), failing);
    await list();
    await list();
    expect(f.calls.filter((args) => args[1] === 'list')).toHaveLength(1);
    f.advance(16_000);
    await list();
    expect(f.calls.filter((args) => args[1] === 'list')).toHaveLength(2);
  });
});
