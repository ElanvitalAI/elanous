import { expect, test } from 'bun:test';
import { githubDraftSweepAdapters } from './harness-cli-command.js';

test('draft metric closed inventory pages beyond sweep twins without altering the sweep list', async () => {
  const requests: string[] = [];
  const first = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, draft: false,
    title: `merged ${i}`, head: { ref: `self-impl/${i}` }, base: { ref: 'main' }, labels: [],
    created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', merged_at: '2026-09-29T00:00:00Z' }));
  const adapters = githubDraftSweepAdapters((args) => {
    requests.push(args[1] ?? '');
    return JSON.stringify(args[1]?.endsWith('&page=1') ? first : [{ ...first[0], number: 101,
      created_at: '2026-09-27T00:00:00Z', updated_at: '2026-09-27T00:00:00Z' }]);
  });
  const rows = await adapters.listRecentClosed!('my/repo', new Date('2026-09-28T00:00:00Z'));
  expect(rows).toHaveLength(101);
  expect(rows[0]).toMatchObject({ number: 1, createdAt: '2026-09-28T00:00:00Z' });
  expect(rows[100]).toMatchObject({ number: 101, createdAt: '2026-09-27T00:00:00Z' });
  expect(requests).toEqual([
    'repos/my/repo/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1',
    'repos/my/repo/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=2',
  ]);
});

test('draft metric closed inventory excludes unrelated PRs while retaining labelled branches', async () => {
  const adapters = githubDraftSweepAdapters(() => JSON.stringify([
    { number: 1, title: 'unrelated', head: { ref: 'human/one' }, base: { ref: 'main' }, labels: [],
      created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', merged_at: null },
    { number: 2, title: 'labelled', head: { ref: 'human/two' }, base: { ref: 'main' }, labels: [{ name: 'elanous:running' }],
      created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', merged_at: null },
  ]));
  expect((await adapters.listRecentClosed!('my/repo', new Date('2026-09-27T00:00:00Z'))).map((pr) => pr.number)).toEqual([2]);
});

test('draft metric distinguishes an active claim from a later owner release without changing sweep owner lookup', async () => {
  const adapters = githubDraftSweepAdapters((args) => {
    expect(args).toEqual(['api', '--paginate', '--slurp', 'repos/my/repo/issues/22/comments?per_page=100']);
    return JSON.stringify([[{ body: '🔧 처리 끝 — 2026-09-29T00:00:00Z', created_at: '2026-09-29T00:00:00Z' },
      { body: '🔧 처리 중 — owner OP · 2026-09-28T00:00:00Z', created_at: '2026-09-28T00:00:00Z' }]]);
  });
  expect(await adapters.getClaimOwner!('my/repo', 22)).toBe('OP');
  expect(await adapters.getActiveClaimOwner!('my/repo', 22)).toBeUndefined();
});

test('draft metric closed inventory rejects truncated and malformed pages', async () => {
  const incomplete = githubDraftSweepAdapters(() => JSON.stringify([{ number: 1, draft: true,
    title: 'truncated', head: { ref: 'self-impl/one' }, base: { ref: 'main' }, labels: [],
    created_at: '2026-09-27T00:00:00Z' }]));
  await expect(incomplete.listRecentClosed!('my/repo', new Date('2026-09-26T00:00:00Z')))
    .rejects.toThrow('Incomplete closed metric inventory');
});

test('DRAFT-METRIC: needs-owner reads the batched GraphQL comments — no per-draft gh comments call', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { collectDraftMetrics } = await import('../self-dev/draft-sweep.js');
  const stateDir = mkdtempSync(join(tmpdir(), 'draft-metric-batch-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = stateDir;
  try {
    // DRAFT-CLAIM-AUTO (#25838): a claim is live only with the running label ⊕ a fresh update (draftClaimState),
    // so drafts 1–2 carry both and the batched comments decide the owner.
    const drafts = Array.from({ length: 95 }, (_, i) => ({ number: i + 1, draft: true, title: `d${i}`, body: null,
      head: { ref: `self-impl/d-${i}`, sha: `h${i}` }, base: { ref: 'main' },
      labels: i < 2 ? [{ name: 'elanous:running' }] : [],
      created_at: '2026-10-07T00:00:00Z', updated_at: i < 2 ? '2026-10-07T23:00:00Z' : '2026-10-07T00:00:00Z', merged_at: null }));
    // Draft 1: claimed then released ⇒ no owner. Draft 2: claimed ⇒ owner. The rest: no claim ⇒ needs owner.
    const comments = (number: number) => number === 1
      ? ['🔧 처리 중 — owner OP · 2026-10-07T01:00:00Z', '🔧 처리 끝 — 2026-10-07T02:00:00Z']
      : number === 2 ? ['noise', '🔧 처리 중 — owner UX · 2026-10-07T01:00:00Z'] : [];
    const calls: string[] = [];
    const adapters = githubDraftSweepAdapters((args) => {
      calls.push(args[1] === 'graphql' ? 'graphql' : args.join(' '));
      if (args[1] === 'graphql') {
        const repository: Record<string, unknown> = {};
        for (const match of args[3]!.matchAll(/p(\d+): pullRequest/g)) {
          const number = Number(match[1]);
          const nodes = (rows: unknown[]) => ({ totalCount: rows.length, nodes: rows, pageInfo: { hasNextPage: false } });
          repository[`p${number}`] = { number, headRefOid: `h${number}`, files: nodes([{ path: 'src/a.ts' }]),
            comments: nodes(comments(number).map((body) => ({ body }))), reviews: nodes([]), mergeCommit: null };
        }
        return JSON.stringify({ data: { repository } });
      }
      if (args[1]?.includes('state=open')) return JSON.stringify(args[1].endsWith('&page=1') ? drafts : []);
      if (args[1]?.includes('state=closed')) return '[]';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    const metrics = await collectDraftMetrics('my/repo', adapters, new Date('2026-10-08T00:00:00Z'));
    expect(metrics).toMatchObject({ inventory: 95, needsOwner: 94, oldestAgeHours: 24 });
    expect(calls.filter((call) => call.includes('/comments'))).toEqual([]);
    // One open page ⊕ ceil(95/40)=3 GraphQL batches ⊕ one closed page — bounded by batches, not by drafts.
    expect(calls.filter((call) => call === 'graphql')).toHaveLength(3);
    expect(calls.length).toBeLessThanOrEqual(5);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
