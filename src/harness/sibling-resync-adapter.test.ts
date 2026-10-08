import { describe, expect, test } from 'bun:test';
import { resyncMergedSiblings } from './harness-cli-command.js';

/** Injected `gh` fake: one merged PR, N open self-impl PRs, per-PR file lists. */
function ghFake(opts: { open: { number: number; branch: string; labels?: string[]; files: string[] }[]; merged: string[] }) {
  const requests: string[][] = [];
  const execute = (args: string[]): string => {
    requests.push(args);
    const path = args[1] ?? '';
    if (args[0] === 'api' && path.startsWith('repos/my/repo/pulls?state=open')) {
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1');
      const rows = opts.open.slice((page - 1) * 100, page * 100).map((pr) => ({
        number: pr.number, title: `t${pr.number}`, draft: true, state: 'open', head: { ref: pr.branch }, base: { ref: 'main' },
        labels: (pr.labels ?? []).map((name) => ({ name })), created_at: '2026-10-07T00:00:00Z', merged_at: null,
      }));
      return JSON.stringify(rows);
    }
    const files = /^repos\/my\/repo\/pulls\/(\d+)\/files\?per_page=100&page=1$/.exec(path);
    if (args[0] === 'api' && files) {
      const number = Number(files[1]);
      const list = number === 1 ? opts.merged : opts.open.find((pr) => pr.number === number)?.files ?? [];
      return JSON.stringify(list.map((filename) => ({ filename })));
    }
    if (args[0] === 'pr' && args[1] === 'edit') return '';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const git = (_cwd: string, args: string[]) => args[0] === 'config'
    ? { status: 0, stdout: 'https://github.com/my/repo.git\n', stderr: '' }
    : { status: 1, stdout: '', stderr: 'unused' };
  const fileFetches = () => requests.filter((args) => args[0] === 'api' && /\/pulls\/\d+\/files\?/.test(args[1] ?? '') && !args[1]!.includes('/pulls/1/files'));
  return { execute, git, requests, fileFetches };
}

const dead = async () => ({ alive: false as const, reason: 'run-ended-unclosed' });
const noSend = () => { throw new Error('no live run expected'); };

describe('resyncMergedSiblings (adapter, injected gh fake)', () => {
  test('fetch cap: 186 open self-impl PRs → at most maxFetch file fetches, the rest reported as fetch-capped', async () => {
    const open = Array.from({ length: 186 }, (_, i) => ({ number: 1000 + i, branch: `self-impl/goal-unrelated-${i}`, files: ['src/other.ts'] }));
    const gh = ghFake({ open, merged: ['src/f.ts'] });
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const result = await resyncMergedSiblings(1, '/tmp/launch-tree', gh.execute, gh.git,
      { resolveRun: dead, sendResync: noSend, maxFetch: 40, log: (_c, event, data) => events.push({ event, data }) });
    expect(gh.fileFetches()).toHaveLength(40);
    expect(result.filesFetched).toBe(40);
    expect(result.skippedFetchCap).toHaveLength(146);
    const summary = events.find((e) => e.event === 'summary')!.data;
    expect(summary).toMatchObject({ filesFetched: 40, skippedPrefilter: 0, skippedFetchCap: 146 });
    expect(typeof summary.durationMs).toBe('number');
  });

  test('prefilter: a PR already labelled needs-rebase is never fetched; branch path tokens are fetched first', async () => {
    const open = [
      { number: 2001, branch: 'self-impl/goal-src-cli-tasks-cli-ts-abc', files: ['src/cli/tasks-cli.ts'] },
      { number: 2002, branch: 'self-impl/goal-unrelated-thing', files: ['src/cli/tasks-cli.ts'] },
      { number: 2003, branch: 'self-impl/goal-src-cli-tasks-cli-ts-def', labels: ['elanous:needs-rebase'], files: ['src/cli/tasks-cli.ts'] },
    ];
    const gh = ghFake({ open, merged: ['src/cli/tasks-cli.ts'] });
    const result = await resyncMergedSiblings(1, '/tmp/launch-tree', gh.execute, gh.git,
      { resolveRun: dead, sendResync: noSend, maxFetch: 1, log: () => {} });
    expect(result.skippedPrefilter).toEqual([2003]);
    // Only one fetch allowed: the branch sharing «tasks» path tokens wins over the newer unrelated one.
    expect(gh.fileFetches().map((args) => args[1])).toEqual(['repos/my/repo/pulls/2001/files?per_page=100&page=1']);
    expect(result.skippedFetchCap).toEqual([2002]);
    expect(result.marked).toEqual([2001]);
    expect(gh.requests.filter((args) => args[0] === 'pr')).toEqual([
      ['pr', 'edit', '2001', '--repo', 'my/repo', '--add-label', 'elanous:needs-rebase'],
    ]);
    // QUIET-PR-COMMENTS: no comment call of any kind.
    expect(gh.requests.some((args) => args.includes('comment') || args.includes('--comment'))).toBe(false);
  });

  test('a live run gets one memo and no label', async () => {
    const gh = ghFake({ open: [{ number: 3001, branch: 'self-impl/goal-x', files: ['src/f.ts'] }], merged: ['src/f.ts'] });
    const sent: string[] = [];
    const result = await resyncMergedSiblings(1, '/tmp/launch-tree', gh.execute, gh.git, {
      resolveRun: async () => ({ alive: true, runId: 'run-3001', spaceId: 'space-3001' }),
      sendResync: ({ spaceId }) => { sent.push(spaceId); },
      log: () => {},
    });
    expect(result.requested).toEqual([3001]);
    expect(sent).toEqual(['space-3001']);
    expect(gh.requests.filter((args) => args[0] === 'pr')).toEqual([]);
  });
});
