import { setDefaultTimeout, afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOG_WINDOWS,
  PR_LIST_LIMIT,
  decideSalvage,
  diffArgs,
  exactRemoteRefArgs,
  fetchArgs,
  parseLogEvidence,
  openHeadPrListArgs,
  parsePullRequestCandidates,
  runSalvageCli,
  salvageFetchRefspec,
  topicPrListArgs,
  type CmdResult,
  type CmdRunner,
} from './salvage-review-blocked.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const ok = (out = ''): CmdResult => ({ ok: true, rc: 0, out, err: '' });
const fail = (err: string, out = '', rc = 1): CmdResult => ({ ok: false, rc, out, err });
const base = (overrides: Partial<Parameters<typeof decideSalvage>[0]> = {}) => ({
  branch: 'self-impl/a.feature',
  logMatches: [1],
  openHeadPullRequests: [],
  exactRemoteRef: ok('abc\trefs/heads/self-impl/a.feature'),
  fetch: ok(),
  diff: ok(' scripts/x.ts | 1 +'),
  ...overrides,
});

function stubRunner(responses: Record<string, CmdResult>): { run: CmdRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CmdRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return responses[[cmd, ...args].join(' ')] ?? ok();
  };
  return { run, calls };
}

const logArgs = (runId: string, since: string) => ['elanous', 'logs', '--grep', runId, '--since', since, '--test', '--limit', '40'].join(' ');
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'salvage-review-blocked.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function failingElanousPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'salvage-cli-'));
  tempDirs.push(dir);
  const executable = join(dir, 'elanous');
  writeFileSync(executable, '#!/bin/sh\necho "logs unavailable" >&2\nexit 17\n');
  chmodSync(executable, 0o755);
  return dir;
}

describe('salvage review-blocked §6b decision', () => {
  it('0 log lines never declares absence before all prescribed windows: 60m → 6h → 24h → 7d', () => {
    expect(decideSalvage(base({ logMatches: [0] }))).toEqual({ status: 'search-logs', since: '6h' });
    expect(decideSalvage(base({ logMatches: [0, 0] }))).toEqual({ status: 'search-logs', since: '24h' });
    expect(decideSalvage(base({ logMatches: [0, 0, 0] }))).toEqual({ status: 'search-logs', since: '7d' });
    expect(decideSalvage(base({ logMatches: [0, 0, 0, 0] }))).toEqual({ status: 'search-prs', topic: '', limit: PR_LIST_LIMIT, candidates: [] });
    expect(LOG_WINDOWS).toEqual(['60m', '6h', '24h', '7d']);
  });

  it('blocks an existing open PR for the exact head before any salvage is prepared', () => {
    expect(decideSalvage(base({ openHeadPullRequests: [{ number: 73, state: 'OPEN', headRefName: 'self-impl/a.feature' }] }))).toEqual({
      status: 'blocked', reason: 'open-pr-exists', detail: 'open PR already exists for head self-impl/a.feature: #73',
    });
  });

  it('uses only exact ls-remote ref arguments and preserves rc=2 absence apart from remote query failure', () => {
    expect(exactRemoteRefArgs('feature/a.b')).toEqual(['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/feature/a.b']);
    expect(decideSalvage(base({ exactRemoteRef: fail('not found', '', 2) }))).toMatchObject({ status: 'blocked', reason: 'branch-missing' });
    expect(decideSalvage(base({ exactRemoteRef: fail('authentication failed', '', 128) }))).toEqual({ status: 'blocked', reason: 'branch-query-failed', detail: 'authentication failed' });
  });

  it('fetches the explicit tracking refspec and blocks if its command rc fails', () => {
    const branch = 'feature/a.b';
    expect(salvageFetchRefspec(branch)).toBe('+refs/heads/feature/a.b:refs/remotes/origin/feature/a.b');
    expect(fetchArgs(branch)).toEqual(['fetch', 'origin', '+refs/heads/feature/a.b:refs/remotes/origin/feature/a.b']);
    expect(decideSalvage(base({ fetch: fail('network') }))).toEqual({ status: 'blocked', reason: 'fetch-failed', detail: 'network' });
  });

  it('blocks an empty diff stat and a failed diff even if the failed command wrote output', () => {
    expect(decideSalvage(base({ diff: ok('   \n') }))).toEqual({ status: 'blocked', reason: 'empty-deliverable', detail: 'git diff --stat produced no files' });
    expect(decideSalvage(base({ diff: fail('bad revision', ' scripts/x.ts | 1 +') }))).toEqual({ status: 'blocked', reason: 'diff-failed', detail: 'bad revision' });
    expect(decideSalvage(base())).toMatchObject({ status: 'ready', branch: 'self-impl/a.feature' });
  });


  it('preserves every case-insensitive grep -iE blocked|verdict|reason match, including ordinary-text substrings', () => {
    expect(parseLogEvidence('plain output\nThe reASONing mentions a blocker\n{"event":"x","REASON":"blocked"}\nVERDICT=warn\nBlocked: true\nunblocked state\nstatus ready')).toEqual([
      'The reASONing mentions a blocker',
      '{"event":"x","REASON":"blocked"}',
      'VERDICT=warn',
      'Blocked: true',
      'unblocked state',
    ]);
  });

  it('distinguishes a valid empty PR JSON array from malformed or unexpected PR JSON', () => {
    expect(parsePullRequestCandidates('[]')).toEqual([]);
    expect(parsePullRequestCandidates('{')).toEqual({ error: 'gh pr list returned malformed JSON' });
    expect(parsePullRequestCandidates('{}')).toEqual({ error: 'gh pr list JSON must be an array' });
    expect(parsePullRequestCandidates('[{"number":"7","state":"OPEN"}]')).toEqual({ error: 'gh pr list JSON row requires positive integer number and non-empty string state' });
  });
});

describe('runSalvageCli §6b orchestration', () => {
  it('filters logs, expands through every prescribed window, then exposes structured fallback PR candidates', () => {
    const runId = 'run-123';
    const candidates = [{ number: 91, state: 'CLOSED', headRefName: 'feature/a', isDraft: true }];
    const { run, calls } = stubRunner({
      [logArgs(runId, '60m')]: ok('arbitrary output'),
      [logArgs(runId, '6h')]: ok('still arbitrary'),
      [logArgs(runId, '24h')]: ok(''),
      [logArgs(runId, '7d')]: ok('status=complete'),
      [['gh', ...topicPrListArgs('salvage procedure')].join(' ')]: ok(JSON.stringify(candidates)),
    });

    expect(runSalvageCli(runId, 'feature/a', 'salvage procedure', run)).toEqual({ status: 'search-prs', topic: 'salvage procedure', limit: 200, candidates });
    expect(calls).toEqual([
      ['elanous', 'logs', '--grep', runId, '--since', '60m', '--test', '--limit', '40'],
      ['elanous', 'logs', '--grep', runId, '--since', '6h', '--test', '--limit', '40'],
      ['elanous', 'logs', '--grep', runId, '--since', '24h', '--test', '--limit', '40'],
      ['elanous', 'logs', '--grep', runId, '--since', '7d', '--test', '--limit', '40'],
      ['gh', 'pr', 'list', '--state', 'all', '--search', 'salvage procedure', '--limit', '200', '--json', 'number,state,headRefName,isDraft'],
    ]);
  });

  it('uses uppercase log evidence, then passes only exact ref, fetch, and diff checks to the runner', () => {
    const runId = 'run-456';
    const branch = 'feature/a.b';
    const { run, calls } = stubRunner({
      [logArgs(runId, '60m')]: ok('noise\n{"REASON":"REVIEW-BLOCKED"}'),
      [['gh', ...openHeadPrListArgs(branch)].join(' ')]: ok('[]'),
      [['git', ...exactRemoteRefArgs(branch)].join(' ')]: ok('abc\trefs/heads/feature/a.b'),
      [['git', ...fetchArgs(branch)].join(' ')]: ok(),
      [['git', ...diffArgs(branch)].join(' ')]: ok(' scripts/x.ts | 1 +'),
    });

    expect(runSalvageCli(runId, branch, 'unused after evidence', run)).toEqual({ status: 'ready', branch, fetchRefspec: salvageFetchRefspec(branch) });
    expect(calls).toEqual([
      ['elanous', 'logs', '--grep', runId, '--since', '60m', '--test', '--limit', '40'],
      ['gh', 'pr', 'list', '--head', 'feature/a.b', '--state', 'open', '--limit', '200', '--json', 'number,state,headRefName,isDraft'],
      ['git', 'ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/feature/a.b'],
      ['git', 'fetch', 'origin', '+refs/heads/feature/a.b:refs/remotes/origin/feature/a.b'],
      ['git', 'diff', '--stat', 'origin/main...origin/feature/a.b'],
    ]);
  });

  it('fails closed when the exact-head PR query returns malformed JSON', () => {
    const runId = 'run-open-pr-malformed';
    const branch = 'feature/a';
    const { run, calls } = stubRunner({
      [logArgs(runId, '60m')]: ok('verdict: blocked'),
      [['gh', ...openHeadPrListArgs(branch)].join(' ')]: ok('{'),
    });

    expect(runSalvageCli(runId, branch, 'topic', run)).toEqual({ status: 'blocked', reason: 'pr-data-invalid', detail: 'gh pr list returned malformed JSON' });
    expect(calls).toEqual([
      ['elanous', 'logs', '--grep', runId, '--since', '60m', '--test', '--limit', '40'],
      ['gh', 'pr', 'list', '--head', 'feature/a', '--state', 'open', '--limit', '200', '--json', 'number,state,headRefName,isDraft'],
    ]);
  });

  it('blocks an existing open PR for the exact head without git calls', () => {
    const runId = 'run-open-pr';
    const branch = 'feature/a';
    const { run, calls } = stubRunner({
      [logArgs(runId, '60m')]: ok('verdict: blocked'),
      [['gh', ...openHeadPrListArgs(branch)].join(' ')]: ok('[{"number":73,"state":"OPEN","headRefName":"feature/a","isDraft":false}]'),
    });

    expect(runSalvageCli(runId, branch, 'topic', run)).toEqual({ status: 'blocked', reason: 'open-pr-exists', detail: 'open PR already exists for head feature/a: #73' });
    expect(calls).toEqual([
      ['elanous', 'logs', '--grep', runId, '--since', '60m', '--test', '--limit', '40'],
      ['gh', 'pr', 'list', '--head', 'feature/a', '--state', 'open', '--limit', '200', '--json', 'number,state,headRefName,isDraft'],
    ]);
  });

  it('returns the exact-ref query failure without fetch, diff, or PR fallback calls', () => {
    const runId = 'run-branch-query-fail';
    const branch = 'feature/a';
    const { run, calls } = stubRunner({
      [logArgs(runId, '60m')]: ok('A BLOCKED result exists'),
      [['gh', ...openHeadPrListArgs(branch)].join(' ')]: ok('[]'),
      [['git', ...exactRemoteRefArgs(branch)].join(' ')]: fail('remote authentication failed', '', 128),
    });

    expect(runSalvageCli(runId, branch, 'topic', run)).toEqual({ status: 'blocked', reason: 'branch-query-failed', detail: 'remote authentication failed' });
    expect(calls).toEqual([
      ['elanous', 'logs', '--grep', runId, '--since', '60m', '--test', '--limit', '40'],
      ['gh', 'pr', 'list', '--head', 'feature/a', '--state', 'open', '--limit', '200', '--json', 'number,state,headRefName,isDraft'],
      ['git', 'ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/feature/a'],
    ]);
  });

  it('returns the fetch failure without diff or PR fallback calls', () => {
    const runId = 'run-fetch-fail';
    const branch = 'feature/a';
    const { run, calls } = stubRunner({
      [logArgs(runId, '60m')]: ok('verdict: blocked'),
      [['gh', ...openHeadPrListArgs(branch)].join(' ')]: ok('[]'),
      [['git', ...exactRemoteRefArgs(branch)].join(' ')]: ok(),
      [['git', ...fetchArgs(branch)].join(' ')]: fail('network unavailable'),
    });

    expect(runSalvageCli(runId, branch, 'topic', run)).toEqual({ status: 'blocked', reason: 'fetch-failed', detail: 'network unavailable' });
    expect(calls).toEqual([
      ['elanous', 'logs', '--grep', runId, '--since', '60m', '--test', '--limit', '40'],
      ['gh', 'pr', 'list', '--head', 'feature/a', '--state', 'open', '--limit', '200', '--json', 'number,state,headRefName,isDraft'],
      ['git', 'ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/feature/a'],
      ['git', 'fetch', 'origin', '+refs/heads/feature/a:refs/remotes/origin/feature/a'],
    ]);
  });


  it('stops and returns a failure verdict when a log command fails', () => {
    const runId = 'run-fail';
    const { run, calls } = stubRunner({ [logArgs(runId, '60m')]: fail('logs unavailable') });
    expect(runSalvageCli(runId, 'feature/a', 'topic', run)).toEqual({ status: 'blocked', reason: 'logs-failed', detail: 'logs unavailable' });
    expect(calls).toEqual([['elanous', 'logs', '--grep', runId, '--since', '60m', '--test', '--limit', '40']]);
  });

  it('returns a failure verdict when PR fallback cannot be queried', () => {
    const runId = 'run-pr-fail';
    const { run } = stubRunner({
      [logArgs(runId, '60m')]: ok(),
      [logArgs(runId, '6h')]: ok(),
      [logArgs(runId, '24h')]: ok(),
      [logArgs(runId, '7d')]: ok(),
      [['gh', ...topicPrListArgs('topic')].join(' ')]: fail('gh unavailable'),
    });
    expect(runSalvageCli(runId, 'feature/a', 'topic', run)).toEqual({ status: 'blocked', reason: 'pr-search-failed', detail: 'gh unavailable' });
  });
});

describe('salvage review-blocked executable contract', () => {
  it('prints a elanous logs failure verdict as exactly one stdout JSON line', () => {
    const fakeBin = failingElanousPath();
    const child = Bun.spawnSync({
      cmd: [process.execPath, scriptPath, 'run-subprocess-fail', 'feature/a', 'topic'],
      env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(child.exitCode).toBe(0);
    const stdout = child.stdout.toString();
    expect(stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual({ status: 'blocked', reason: 'logs-failed', detail: 'logs unavailable' });
  });

  it('prints usage and exits 2 when required arguments are missing', () => {
    const child = Bun.spawnSync({
      cmd: [process.execPath, scriptPath, 'only-run-id'],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(child.exitCode).toBe(2);
    expect(child.stdout.toString()).toBe('');
    expect(child.stderr.toString()).toBe('usage: bun scripts/salvage-review-blocked.ts <run-id> <branch> <topic>\n');
  });
});
