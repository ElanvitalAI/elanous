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
