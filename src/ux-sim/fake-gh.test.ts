import { expect, spyOn, test } from 'bun:test';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { registerReleaseCommands } from '../cli/release-cli.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { createFakeGh, type FakeGhPr } from './fake-gh.js';
import { githubDraftSweepAdapters } from '../harness/harness-cli-command.js';
import { runDraftSweep } from '../self-dev/draft-sweep.js';
import { registerTasksCommands } from '../cli/tasks-cli.js';
import { fetchMergedChecklistPrs, landedButYellow } from '../release-loop/landed-but-yellow.js';
import type { Checklist } from '../release-loop/checklist.js';

const NOW = new Date('2026-10-24T12:00:00Z');
const SHA = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const draft: FakeGhPr = { number: 10, title: 'draft', branch: 'self-impl/example-10', draft: true,
  createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', head: 'abc' };
const merged: FakeGhPr = { number: 123, title: 'CELL landed', branch: 'self-impl/cell-123',
  createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
  mergedAt: '2026-10-23T00:00:00Z', mergeSha: SHA, body: '칸: CELL' };
const git = (_cwd: string, args: string[]) => ({ status: 0, stderr: '', stdout: args[0] === 'config' ? 'https://github.com/example/repo.git\n' : 'worktree /tmp/main\nbranch refs/heads/main\n' });
const fakeGh = (input: Parameters<typeof createFakeGh>[0]) => createFakeGh({ ...input, now: () => NOW });
const isolatedDraftRunState = { runLedgerMatches: () => [], runningRunStatuses: () => new Map<string, string>() };
const sweep = (gh: ReturnType<typeof createFakeGh>, apply = false) => runDraftSweep({ repository: 'example/repo', now: NOW,
  apply, adapters: githubDraftSweepAdapters(gh.api, git, '/tmp/main', undefined, undefined, isolatedDraftRunState) });

const item = { id: 'CELL', title: 'CELL', status: 'yellow' as const, evidence: `PR #123 merged ${SHA}\n판정: green`,
  updatedAt: '2026-10-22T00:00:00Z', updatedBy: 'test' };

async function greenSweep(gh: ReturnType<typeof createFakeGh>, mergeSha = SHA) {
  const root = mkdtempSync(join(tmpdir(), 'fake-gh-green-'));
  const lines: string[] = [];
  const checklist: Checklist = { version: '0.2.30', released: '0.2.29', dev: '0.2.30', history: [], items: [
    { ...item, evidence: `PR #123 merged ${mergeSha}\n판정: green` },
  ] };
  try {
    const traffic = join(root, 'traffic.json');
    writeFileSync(traffic, JSON.stringify({ hold: [] }));
    const program = new Command();
    registerTasksCommands(program, { taskStatePath: join(root, 'cards.json'), output: (line) => lines.push(line), greenSweepChecklist: () => checklist,
      greenSweepRun: (command, args) => {
        if (command === 'gh') return gh.run(command, args);
        const key = args.join(' ');
        if (key === 'remote get-url origin') return { status: 0, stdout: 'git@github.com:example/repo.git\n' };
        if (key === 'rev-parse origin/main') return { status: 0, stdout: `${MAIN}\n` };
        if (key === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${MAIN}\trefs/heads/main\n` };
        if (key === `merge-base --is-ancestor ${mergeSha} origin/main`) return { status: 0, stdout: '' };
        throw new Error(`unexpected git ${key}`);
      } });
    await program.parseAsync(['tasks', 'green-sweep', '--version', '0.2.30', '--traffic', traffic, '--json'], { from: 'user' });
    return JSON.parse(lines.at(-1)!) as { decisions: Array<{ verdict: string; reason: string }>; counts: { green: number } };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function landed(gh: ReturnType<typeof createFakeGh>) {
  const fetch = await fetchMergedChecklistPrs('2026-10-22', NOW, gh.runAsync, '/tmp/fake-gh');
  return { fetch, rows: landedButYellow([item], fetch.prs) };
}

async function landedCli(gh: ReturnType<typeof createFakeGh>) {
  const root = mkdtempSync(join(tmpdir(), 'fake-gh-landed-'));
  const output: string[] = [];
  const errors: string[] = [];
  const previousExit = process.exitCode;
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    output.push(String(chunk).trim());
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  const error = spyOn(console, 'error').mockImplementation((line: unknown) => { errors.push(String(line)); });
  try {
    setElanousConfigDir(root);
    process.exitCode = 0;
    const program = new Command();
    const checklist: Checklist = { version: '0.2.30', dev: '0.2.30', released: '', history: [], items: [item] };
    registerReleaseCommands(program, {}, { checklist: () => checklist, now: () => NOW, runAsync: gh.runAsync });
    await program.parseAsync(['release', 'checklist', '--version', '0.2.30', '--json', 'landed-but-yellow'], { from: 'user' });
    return { output, errors, exitCode: process.exitCode };
  } finally {
    error.mockRestore();
    write.mockRestore();
    resetElanousConfigDir();
    process.exitCode = previousExit ?? 0;
    rmSync(root, { recursive: true, force: true });
  }
}

test('MOCK-FAKE-GH: draft sweep uses the fake gh boundary for normal PR lists and label/close operations', async () => {
  const gh = fakeGh({ prs: [{ ...draft, files: ['src/release.ts'], comments: ['claim comment'] }], repository: 'example/repo' });
  const result = await sweep(gh);
  expect(result.complete).toBe(true);
  expect(result.entries.map((entry) => entry.number)).toEqual([10]);
  expect(gh.calls.some((args) => args[0] === 'api' && args[1]?.includes('pulls?state=open'))).toBe(true);
  const adapters = githubDraftSweepAdapters(gh.api, git, '/tmp/main', undefined, undefined, isolatedDraftRunState);
  const drafts = await adapters.listDrafts(1, 100, 'example/repo');
  expect(drafts[0]?.changedFiles).toEqual(['src/release.ts']);
  expect(await adapters.listIssueComments?.('example/repo', 10)).toEqual(['claim comment']);
  expect(gh.calls.some((args) => args[0] === 'api' && args[1]?.includes('/pulls/10/files?'))).toBe(false);
  gh.api(['pr', 'edit', '10', '--repo', 'example/repo', '--add-label', 'elanous:stalled']);
  expect(gh.prs[0]?.labels).toContain('elanous:stalled');
  gh.api(['pr', 'close', '10', '--repo', 'example/repo']);
  expect(gh.calls.at(-1)?.slice(0, 3)).toEqual(['pr', 'close', '10']);
  gh.api(['pr', 'merge', '10', '--repo', 'example/repo']);
  expect(gh.prs[0]?.mergedAt).toBeDefined();
  const viewed = JSON.parse(gh.api(['pr', 'view', '10', '--repo', 'example/repo', '--json', 'state,mergeCommit'])) as { mergeCommit: { oid: string } };
  const pulled = JSON.parse(gh.api(['api', 'repos/example/repo/pulls/10'])) as { merge_commit_sha: string };
  expect(viewed.mergeCommit.oid).toBe(gh.prs[0]!.mergeSha!);
  expect(pulled.merge_commit_sha).toBe(viewed.mergeCommit.oid);
});

test('fake merge flows through pr view and green-sweep merge-base verification', async () => {
  const gh = fakeGh({ prs: [{ ...merged, mergedAt: undefined, mergeSha: undefined }] });
  gh.api(['pr', 'merge', '123', '--repo', 'example/repo']);
  const mergeSha = gh.prs[0]?.mergeSha;
  expect(mergeSha).toMatch(/^[0-9a-f]{40}$/);
  expect((await greenSweep(gh, mergeSha)).decisions[0]).toMatchObject({ verdict: 'green', reason: 'explicit-cell-completion-evidence' });
});

test('fake gh honors default pr-list limit, requested GraphQL connection sizes, and injected time', () => {
  const prs = Array.from({ length: 31 }, (_, index): FakeGhPr => ({ ...merged, number: index + 1,
    mergedAt: '2026-10-23T00:00:00Z' }));
  const gh = fakeGh({ prs: [{ ...draft, files: ['a', 'b', 'c'], comments: ['one', 'two'] }, ...prs] });
  const listed = JSON.parse(gh.api(['pr', 'list', '--search', 'merged:>=2026-10-01'])) as unknown[];
  expect(listed).toHaveLength(30);
  type Connection = { nodes: unknown[]; pageInfo: { hasNextPage: boolean } };
  const graphql = JSON.parse(gh.api(['api', 'graphql', '-f', 'query { p10: pullRequest(number: 10) { files(first: 2) { totalCount nodes { path } pageInfo { hasNextPage } } comments(first: 1) { totalCount nodes { body } pageInfo { hasNextPage } } } }'])) as {
    data: { repository: Record<string, { files: Connection; comments: Connection }> };
  };
  expect(graphql.data.repository.p10.files.nodes).toHaveLength(2);
  expect(graphql.data.repository.p10.files.pageInfo.hasNextPage).toBe(true);
  expect(graphql.data.repository.p10.comments.nodes).toHaveLength(1);
  expect(graphql.data.repository.p10.comments.pageInfo.hasNextPage).toBe(true);
  const comments = JSON.parse(gh.api(['api', 'repos/example/repo/issues/10/comments'])) as Array<{ created_at: string }>;
  expect(comments[0]?.created_at).toBe(NOW.toISOString());
});

test('fake REST honors per_page boundaries and paginates slurped issue comments', () => {
  const prs = Array.from({ length: 31 }, (_, index): FakeGhPr => ({ ...draft, number: index + 1 }));
  const gh = fakeGh({ prs: [{ ...draft, comments: ['one', 'two', 'three', 'four', 'five'] }, ...prs] });
  const defaultPulls = JSON.parse(gh.api(['api', 'repos/example/repo/pulls?state=open'])) as unknown[];
  expect(defaultPulls).toHaveLength(30);
  const pageTwo = JSON.parse(gh.api(['api', 'repos/example/repo/pulls?state=open&per_page=2&page=2'])) as unknown[];
  expect(pageTwo).toHaveLength(2);
  const comments = JSON.parse(gh.api(['api', '--paginate', '--slurp', 'repos/example/repo/issues/10/comments?per_page=2'])) as Array<Array<{ body: string }>>;
  expect(comments.map((page) => page.length)).toEqual([2, 2, 1]);
  expect(comments.flat().map((comment) => comment.body)).toEqual(['one', 'two', 'three', 'four', 'five']);
});

test('rate-limit process results use gh exit code 1 and retain the API message in stderr', () => {
  const gh = fakeGh({ prs: [merged], faults: [{ kind: 'rate-limit', match: /pr list/, times: 1 }] });
  const failed = gh.run('gh', ['pr', 'list']);
  expect(failed).toMatchObject({ status: 1, stderr: 'API rate limit exceeded' });
  expect(gh.run('gh', ['pr', 'list'])).toMatchObject({ status: 0 });
});

test('global fault patterns consume the configured failure count on consecutive matching calls', () => {
  const gh = fakeGh({ prs: [merged], faults: [{ kind: 'rate-limit', match: /pr list/g, times: 2 }] });
  expect(gh.run('gh', ['pr', 'list'])).toMatchObject({ status: 1, stderr: 'API rate limit exceeded' });
  expect(gh.run('gh', ['pr', 'list'])).toMatchObject({ status: 1, stderr: 'API rate limit exceeded' });
  expect(gh.run('gh', ['pr', 'list'])).toMatchObject({ status: 0 });
});

test('draft sweep apply performs label and close through the injected gh execution boundary', async () => {
  const old = { ...draft, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
  const gh = fakeGh({ prs: [old] });
  const result = await sweep(gh, true);
  expect(result.complete).toBe(true);
  expect(result.entries[0]?.action).toBe('close');
  expect(gh.calls.some((args) => args[0] === 'pr' && args[1] === 'edit' && args[2] === '10')).toBe(true);
  expect(gh.calls.some((args) => args[0] === 'pr' && args[1] === 'close' && args[2] === '10')).toBe(true);
  expect(gh.prs[0]?.closed).toBe(true);
});

test('draft inventory unexpected EOF is incomplete and cannot apply; rate limit is retryable on a new sweep', async () => {
  const eof = fakeGh({ prs: [draft], faults: [{ kind: 'unexpected-eof', match: /pulls\?state=open/, times: 1 }] });
  const incomplete = await sweep(eof, true);
  expect(incomplete.complete).toBe(false);
  expect(incomplete.error).toContain('unexpected EOF');
  expect(eof.calls.some((args) => args[0] === 'pr' && args[1] === 'close')).toBe(false);
  const rate = fakeGh({ prs: [draft], faults: [{ kind: 'rate-limit', match: /pulls\?state=open/, times: 1 }] });
  expect((await sweep(rate)).complete).toBe(false);
  expect((await sweep(rate)).complete).toBe(true);
  expect(rate.calls.filter((args) => args[1]?.includes('pulls?state=open'))).toHaveLength(2);
});

test('200 open PRs at the inventory boundary are not a complete listing when the next page fails', async () => {
  const prs = Array.from({ length: 200 }, (_, index): FakeGhPr => ({ ...draft, number: index + 1,
    branch: `self-impl/example-${index + 1}`, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }));
  const gh = fakeGh({ prs, faults: [{ kind: 'rate-limit', match: /pulls\?state=open.*page=3$/, times: 1 }] });
  const result = await sweep(gh, true);
  expect(result.complete).toBe(false);
  expect(result.entries).toEqual([]);
  expect(result.error).toContain('rate limit');
  expect(gh.calls.filter((args) => args[1]?.includes('pulls?state=open'))).toHaveLength(3);
  expect(gh.calls.some((args) => args[0] === 'pr' && args[1] === 'close')).toBe(false);
});

test('draft GraphQL unexpected EOF falls back to REST without claiming the failed batch was complete', async () => {
  const gh = fakeGh({ prs: [draft], faults: [{ kind: 'unexpected-eof', match: /api graphql/, times: 1 }] });
  const result = await sweep(gh);
  expect(result.complete).toBe(true);
  expect(gh.calls.some((args) => args[1]?.includes('/pulls/10/files?'))).toBe(true);
});

test('green-sweep uses the real CLI decision: normal merge, EOF fail-closed, rate-limit retry', async () => {
  const gh = fakeGh({ prs: [merged], repository: 'example/repo' });
  expect((await greenSweep(gh)).decisions[0]).toMatchObject({ verdict: 'green', reason: 'explicit-cell-completion-evidence' });
  const eof = fakeGh({ prs: [merged], repository: 'example/repo', faults: [{ kind: 'unexpected-eof', match: /pr view 123/, times: 1 }] });
  expect((await greenSweep(eof)).decisions[0]).toMatchObject({ verdict: 'skip', reason: 'pr-unreadable' });
  const rate = fakeGh({ prs: [merged], repository: 'example/repo', faults: [{ kind: 'rate-limit', match: /pr view 123/, times: 1 }] });
  expect((await greenSweep(rate)).counts.green).toBe(0);
  expect((await greenSweep(rate)).counts.green).toBe(1);
  expect(rate.calls.filter((args) => args[0] === 'pr' && args[1] === 'view')).toHaveLength(2);
});

test('landed-but-yellow CLI keeps failed gh reads out of results and retries on a later invocation', async () => {
  const gh = fakeGh({ prs: [merged] });
  const normal = await landedCli(gh);
  expect(normal.exitCode).toBe(0);
  expect(JSON.parse(normal.output.at(-1)!)[0]?.prs[0]?.number).toBe(123);
  const eof = fakeGh({ prs: [merged], faults: [{ kind: 'unexpected-eof', match: /pr list/, times: 1 }] });
  const incomplete = await landedCli(eof);
  expect(incomplete.exitCode).toBe(1);
  expect(incomplete.output).toEqual([]);
  expect(incomplete.errors.some((line) => line.includes('unexpected EOF'))).toBe(true);
  const rate = fakeGh({ prs: [merged], faults: [{ kind: 'rate-limit', match: /pr list/, times: 1 }] });
  expect((await landedCli(rate)).exitCode).toBe(1);
  const retried = await landedCli(rate);
  expect(retried.exitCode).toBe(0);
  expect(JSON.parse(retried.output.at(-1)!)[0]?.prs[0]?.number).toBe(123);
  expect(rate.calls.filter((args) => args[0] === 'pr' && args[1] === 'list')).toHaveLength(2);
});

test('landed-but-yellow real fetch and match: normal list, EOF incomplete, rate-limit retry', async () => {
  const gh = fakeGh({ prs: [merged] });
  const normal = await landed(gh);
  expect(normal.fetch.stopReason).toBeUndefined();
  expect(normal.rows[0]?.prs[0]).toMatchObject({ number: 123, basis: 'cell-line' });
  const eof = fakeGh({ prs: [merged], faults: [{ kind: 'unexpected-eof', match: /pr list/, times: 1 }] });
  await expect(landed(eof)).rejects.toThrow('unexpected EOF');
  const rate = fakeGh({ prs: [merged], faults: [{ kind: 'rate-limit', match: /pr list/, times: 1 }] });
  await expect(landed(rate)).rejects.toThrow('rate limit');
  expect((await landed(rate)).rows[0]?.prs[0]?.number).toBe(123);
  expect(rate.calls.filter((args) => args[0] === 'pr' && args[1] === 'list')).toHaveLength(2);
});
