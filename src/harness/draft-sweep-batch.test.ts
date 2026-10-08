import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubDraftSweepAdapters } from './harness-cli-command.js';
import { mapBounded, runDraftSweep } from '../self-dev/draft-sweep.js';

// DRAFT-SWEEP-SLOW (10-08): the batched GraphQL evidence path must classify exactly like the per-PR REST path.

type Fixture = {
  number: number; draft: boolean; title: string; branch: string; body?: string; labels?: string[];
  created: string; updated: string; merged?: string; mergeSha?: string; mergeMessage?: string;
  files: string[]; comments: string[]; head: string;
  commits?: Array<{ sha: string; date: string; files: string[] }>;
};

const OPEN: Fixture[] = [
  { number: 10, draft: true, title: 'A goal', branch: 'self-impl/goalid-aa-r1', created: '2026-10-01T00:00:00Z', updated: '2026-10-01T00:00:00Z',
    files: ['src/a.ts'], comments: [], head: 'h10' },
  { number: 11, draft: true, title: 'x draft', branch: 'self-impl/feat-11111111-rabc', body: '칸: X', created: '2026-10-01T00:00:00Z',
    updated: '2026-10-01T00:00:00Z', files: ['src/x.ts'], comments: [], head: 'h11',
    commits: [{ sha: 'c11', date: '2026-10-02T00:00:00Z', files: ['src/x.ts'] }] },
  { number: 12, draft: true, title: 'z draft', branch: 'self-impl/zz-12', created: '2026-10-01T00:00:00Z', updated: '2026-10-01T00:00:00Z',
    files: ['src/z.ts'], comments: [], head: 'h12' },
  { number: 13, draft: true, title: 'y draft', branch: 'self-impl/yy-13', created: '2026-10-01T00:00:00Z', updated: '2026-10-01T00:00:00Z',
    files: ['src/y.ts'], comments: [], head: 'h13' },
  { number: 14, draft: true, title: 'kept', branch: 'self-impl/kept-14', labels: ['elanous:keep'], created: '2026-10-01T00:00:00Z',
    updated: '2026-10-01T00:00:00Z', files: [], comments: [], head: 'h14' },
  { number: 15, draft: true, title: 'old', branch: 'self-impl/old-15', created: '2026-09-20T00:00:00Z', updated: '2026-09-20T00:00:00Z',
    files: ['src/old.ts'], comments: ['VERDICT: PASS'], head: 'h15' },
  { number: 16, draft: true, title: 'huge', branch: 'self-impl/huge-16', created: '2026-10-01T00:00:00Z', updated: '2026-10-01T00:00:00Z',
    files: Array.from({ length: 150 }, (_, i) => `src/huge/${i}.ts`), comments: ['must-fix: 2'], head: 'h16' },
  { number: 17, draft: true, title: 'fresh', branch: 'self-impl/fresh-17', created: '2026-10-04T23:00:00Z', updated: '2026-10-04T23:00:00Z',
    files: ['src/f.ts'], comments: [], head: 'h17' },
  { number: 18, draft: false, title: 'ready human', branch: 'human/ready', created: '2026-10-01T00:00:00Z', updated: '2026-10-01T00:00:00Z',
    files: [], comments: [], head: 'h18' },
];
const MERGED: Fixture[] = [
  { number: 20, draft: false, title: 'A landed', branch: 'self-impl/goalid-aa-r2', created: '2026-10-02T00:00:00Z', updated: '2026-10-03T00:00:00Z',
    merged: '2026-10-03T00:00:00Z', mergeSha: 'm20', mergeMessage: 'A landed', files: ['src/a.ts'], comments: [], head: 'h20' },
  { number: 21, draft: false, title: 'x landed', branch: 'other', body: '칸: X', created: '2026-10-02T00:00:00Z', updated: '2026-10-03T00:00:00Z',
    merged: '2026-10-03T00:00:00Z', mergeSha: 'm21', mergeMessage: 'x landed', files: ['src/x.ts'], comments: [], head: 'h21' },
  { number: 22, draft: false, title: 'z landed', branch: 'human/z', created: '2026-10-02T00:00:00Z', updated: '2026-10-03T00:00:00Z',
    merged: '2026-10-03T00:00:00Z', mergeSha: 'm22', mergeMessage: 'Ship it (수확 #12)', files: ['src/z.ts'], comments: [], head: 'h22' },
  // 150 comments: the batch cannot prove completeness, so the REST pager supplies them.
  { number: 23, draft: false, title: 'y landed', branch: 'human/y', created: '2026-10-02T00:00:00Z', updated: '2026-10-03T00:00:00Z',
    merged: '2026-10-03T00:00:00Z', mergeSha: 'm23', mergeMessage: 'y landed', files: ['src/y.ts'], head: 'h23',
    comments: [...Array.from({ length: 149 }, (_, i) => `noise ${i}`), 'landing-verified: draft #13'] },
];

const pull = (pr: Fixture) => ({
  number: pr.number, draft: pr.draft, state: pr.merged ? 'closed' : 'open', title: pr.title, body: pr.body ?? null,
  head: { ref: pr.branch, sha: pr.head }, base: { ref: 'main' }, labels: (pr.labels ?? []).map((name) => ({ name })),
  created_at: pr.created, updated_at: pr.updated, merged_at: pr.merged ?? null, merge_commit_sha: pr.mergeSha ?? null,
});
const page = <T>(rows: T[], index: number) => rows.slice((index - 1) * 100, index * 100);
const connection = <T>(rows: T[]) => ({ totalCount: rows.length, nodes: rows.slice(0, 100), pageInfo: { hasNextPage: rows.length > 100 } });

function fakeGh(graphql: boolean, calls: string[]) {
  const all = [...OPEN, ...MERGED];
  const byNumber = new Map(all.map((pr) => [pr.number, pr]));
  const byHead = new Map(all.map((pr) => [pr.head, pr]));
  return (args: string[]): string => {
    calls.push(args.join(' '));
    if (args[0] !== 'api') throw new Error(`unexpected gh ${args.join(' ')}`);
    if (args[1] === 'graphql') {
      if (!graphql) throw new Error('GraphQL unavailable');
      const query = args[3]!;
      const repository: Record<string, unknown> = {};
      for (const match of query.matchAll(/p(\d+): pullRequest/g)) {
        const pr = byNumber.get(Number(match[1]))!;
        repository[`p${pr.number}`] = { number: pr.number, headRefOid: pr.head,
          files: connection(pr.files.map((path) => ({ path }))), comments: connection(pr.comments.map((body) => ({ body }))),
          reviews: connection([]), mergeCommit: pr.mergeSha ? { oid: pr.mergeSha, message: pr.mergeMessage } : null };
      }
      return JSON.stringify({ data: { repository } });
    }
    const endpoint = args[1]!;
    let match: RegExpExecArray | null;
    if ((match = /pulls\?state=open.*&page=(\d+)$/.exec(endpoint))) return JSON.stringify(page(OPEN.map(pull), Number(match[1])));
    if ((match = /pulls\?state=closed.*&page=(\d+)$/.exec(endpoint))) return JSON.stringify(page(MERGED.map(pull), Number(match[1])));
    if ((match = /\/pulls\/(\d+)\/files\?per_page=100&page=(\d+)$/.exec(endpoint)))
      return JSON.stringify(page(byNumber.get(Number(match[1]))!.files.map((filename) => ({ filename })), Number(match[2])));
    if ((match = /\/issues\/(\d+)\/comments\?per_page=100&page=(\d+)$/.exec(endpoint)))
      return JSON.stringify(page(byNumber.get(Number(match[1]))!.comments.map((body) => ({ body })), Number(match[2])));
    if ((match = /\/pulls\/(\d+)\/commits\?per_page=100&page=1$/.exec(endpoint)))
      return JSON.stringify((byNumber.get(Number(match[1]))!.commits ?? []).map((commit) => ({ sha: commit.sha, commit: { committer: { date: commit.date } } })));
    if ((match = /\/pulls\/(\d+)\/reviews\?per_page=100$/.exec(endpoint))) return '[]';
    if ((match = /\/pulls\/(\d+)$/.exec(endpoint))) return JSON.stringify({ head: { sha: byNumber.get(Number(match[1]))!.head } });
    if ((match = /\/commits\/(\w+)\/status$/.exec(endpoint))) return JSON.stringify({ state: 'success' });
    if ((match = /\/commits\/(\w+)\/check-runs\?per_page=100$/.exec(endpoint)))
      return JSON.stringify({ check_runs: byHead.get(match[1]!)?.number === 16 ? [{ conclusion: 'failure' }] : [{ conclusion: 'success' }] });
    if ((match = /\/commits\/(\w+)\?per_page=100$/.exec(endpoint))) {
      const commit = OPEN.flatMap((pr) => pr.commits ?? []).find((entry) => entry.sha === match![1]);
      return JSON.stringify({ files: (commit?.files ?? []).map((filename) => ({ filename })) });
    }
    if ((match = /\/commits\/(\w+)$/.exec(endpoint))) {
      const merged = MERGED.find((pr) => pr.mergeSha === match![1]);
      return JSON.stringify({ commit: { message: merged?.mergeMessage ?? '' } });
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
}

const git = (_cwd: string, args: string[]) => ({ status: 0, stderr: '',
  stdout: args[0] === 'config' ? 'https://github.com/my/repo.git\n' : 'worktree /tmp/main\nbranch refs/heads/main\n' });

let stateDir = '';
let previous: string | undefined;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'draft-sweep-batch-'));
  previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = stateDir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous;
  rmSync(stateDir, { recursive: true, force: true });
});

const sweep = async (graphql: boolean) => {
  const calls: string[] = [];
  const result = await runDraftSweep({ repository: 'my/repo', now: new Date('2026-10-05T00:00:00Z'),
    adapters: githubDraftSweepAdapters(fakeGh(graphql, calls), git, '/tmp/main') });
  return { result, calls };
};

test('batched GraphQL evidence classifies a fixture set exactly like the per-PR REST path', async () => {
  const logged: Array<{ category: string; event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { logged.push({ category, event, data }); });
  let batched: Awaited<ReturnType<typeof sweep>>;
  try { batched = await sweep(true); } finally { log.mockRestore(); }
  // Field-level REST fallbacks are observed: #16 files (150) and #23 comments (150) were not complete in the batch.
  const fallbacks = logged.filter((entry) => entry.category === 'self-dev.draft-sweep' && entry.event === 'graphql-fallback');
  expect(fallbacks.map((entry) => (entry.data as { incompleteFields: Record<string, number> }).incompleteFields))
    .toEqual(expect.arrayContaining([{ files: 1, comments: 0, reviews: 0 }, { files: 0, comments: 1, reviews: 0 }]));
  expect(logged.filter((entry) => entry.event === 'timing').map((entry) => (entry.data as { phase: string }).phase))
    .toEqual(['inventory', 'run-status', 'review-gate', 'decide', 'total']);
  const rest = await sweep(false);
  expect(batched.result.complete).toBe(true);
  expect(rest.result.complete).toBe(true);
  expect(batched.result.entries).toEqual(rest.result.entries);
  expect(batched.result.counts).toEqual(rest.result.counts);
  expect(batched.result.daily).toEqual(rest.result.daily);
  expect(Object.fromEntries(batched.result.entries.map((entry) => [entry.number, entry.reason]))).toEqual({
    10: 'superseded-by #20',
    11: 'superseded-by #21 (all-files-landed)',
    12: 'superseded-by #22 (harvest #12)',
    13: 'superseded-by #23 (harvest #13)',
    14: 'label:elanous:keep',
    15: 'stale-unobserved',
    16: 'stale-unobserved',
    17: 'unobserved',
  });
  expect(batched.result.daily).toMatchObject({ over24h: 7, closable: 1, harvestable: 1, blocked: 1 });
  // The batch replaces per-PR files / comments / merge-commit reads; only incomplete connections fall back to REST.
  const perPr = (calls: string[]) => calls.filter((call) => /\/(?:files|comments)\?|\/commits\/m\d+$/.test(call)).length;
  expect(perPr(batched.calls)).toBeLessThan(perPr(rest.calls));
  expect(batched.calls.filter((call) => call.includes('/pulls/16/files?'))).toHaveLength(2);
  expect(batched.calls.filter((call) => call.includes('/issues/23/comments?'))).toHaveLength(2);
  expect(batched.calls.filter((call) => /\/(?:files|comments)\?/.test(call) && !/\/(?:16|23)\//.test(call))).toEqual([]);
  // Per-file history is read only for drafts with a later same-lineage merge (#10 goal id · #11 slot), not for every draft.
  expect(batched.calls.filter((call) => /\/pulls\/\d+\/commits\?/.test(call))).toEqual([
    'api repos/my/repo/pulls/10/commits?per_page=100&page=1', 'api repos/my/repo/pulls/11/commits?per_page=100&page=1']);
  // Review/gate posture is read only for the daily census (harness drafts older than 24h) — never for #17 or #18.
  expect(batched.calls.some((call) => /\/commits\/h1[78]\//.test(call))).toBe(false);
});

test('mapBounded keeps result order and never exceeds its in-flight limit', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapBounded(Array.from({ length: 20 }, (_, i) => i), 6, async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, (20 - value) % 5));
    inFlight -= 1;
    return value * 2;
  });
  expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
  expect(peak).toBeLessThanOrEqual(6);
  await expect(mapBounded([1, 2, 3], 2, async (value) => { if (value === 2) throw new Error('boom'); return value; }))
    .rejects.toThrow('boom');
});
