import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseNumstat,
  branchMatchesRun,
  decideRunSalvage,
  findRunSalvageBranches,
  prStateFromLedger,
  runSuffixKey,
  type SalvageGitResult,
  type SalvageGitRunner,
} from './salvage-branches.js';
import { installHarnessSalvageCommand, runHarnessSalvage } from '../harness/harness-salvage-cli.js';
import { installHarnessCliCommand } from '../harness/harness-cli-command.js';

const RUN = 'run-bfe2b5c1-1234-4abc-8def-000000000000';
const JOB = 'salvage/si-task-faa976af1ac4-220d3a79-k6gzw';
const WORK = `${JOB}/self-impl-goalid-abc-src-self-implement-heal-intake-ts-814dfa46-rbfe2b5`;
const REPO = `${JOB}/repo`;
const OTHER = 'salvage/si-task-0000aaaa1111-22223333-zzzzz/self-impl-goalid-def-src-x-11112222-r999999';
const SHA_WORK = 'a'.repeat(40);
const SHA_REPO = 'b'.repeat(40);
const SHA_OTHER = 'c'.repeat(40);

const ok = (stdout = ''): SalvageGitResult => ({ status: 0, stdout, stderr: '' });

function fakeGit(opts: { lsRemote?: SalvageGitResult; numstat?: Record<string, string>; fetch?: SalvageGitResult } = {}): SalvageGitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const listing = [`${SHA_WORK}\trefs/heads/${WORK}`, `${SHA_REPO}\trefs/heads/${REPO}`, `${SHA_OTHER}\trefs/heads/${OTHER}`].join('\n');
  const numstat = opts.numstat ?? {
    [SHA_WORK]: '120\t4\tsrc/self-implement/heal-intake.ts\n300\t0\tsrc/self-implement/heal-intake.test.ts\n',
    [SHA_REPO]: '1\t0\t.gitignore\n40\t0\tdocs/goals/ASK-x.md\n',
  };
  const run = ((args: string[]) => {
    calls.push(args);
    if (args[0] === 'ls-remote') return opts.lsRemote ?? ok(listing);
    if (args[0] === 'fetch') return opts.fetch ?? ok();
    if (args[0] === 'diff') {
      const sha = args.at(-1)!.split('...')[1]!;
      // real git is called with -z: records end in NUL, paths unquoted
      return ok((numstat[sha] ?? '').split('\n').filter(Boolean).map((r) => `${r}\0`).join(''));
    }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  }) as SalvageGitRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

describe('salvage branches — run → PR | 수확 가지 | 없음 | 모름', () => {
  test('run suffix key follows plannedSelfImplBranch -r rule', () => {
    expect(runSuffixKey(RUN)).toBe('bfe2b5');
    expect(runSuffixKey('run-ab')).toBeNull();
    expect(runSuffixKey('run-zzzzzz-1')).toBeNull();
    expect(runSuffixKey('run-ab-cdef')).toBeNull();
    expect(findRunSalvageBranches('run-bf-e2b5', fakeGit()).status).toBe('unknown');
    expect(branchMatchesRun(WORK, 'bfe2b5')).toBe(true);
    expect(branchMatchesRun(`${WORK}-early`, 'bfe2b5')).toBe(true);
    expect(branchMatchesRun(REPO, 'bfe2b5')).toBe(false);
    expect(branchMatchesRun(OTHER, 'bfe2b5')).toBe(false);
  });

  test('a run with a salvage branch → 수확 가지 with diffstat; /repo goal-doc sibling is skipped', () => {
    const git = fakeGit();
    const lookup = findRunSalvageBranches(RUN, git);
    expect(lookup).toEqual({ status: 'found', branches: [{ branch: WORK, sha: SHA_WORK, diffstat: { files: 2, insertions: 420, deletions: 4 } }] });
    const verdict = decideRunSalvage(RUN, { status: 'none' }, lookup);
    expect(verdict.outcome).toBe('salvage');
    expect(verdict.line).toBe(`${RUN}  수확 가지 ${WORK} (+420/-4 · 2 files)`);
    // the unrelated job is never fetched
    expect(git.calls.find((args) => args[0] === 'fetch')!.some((arg) => arg.includes('0000aaaa1111'))).toBe(false);
  });

  test('a run whose only branches carry goal docs / .gitignore → 없음', () => {
    const git = fakeGit({ numstat: { [SHA_WORK]: '3\t0\tdocs/goals/ASK-y.md\n', [SHA_REPO]: '1\t0\t.gitignore\n' } });
    const lookup = findRunSalvageBranches(RUN, git);
    expect(lookup).toEqual({ status: 'none', trivialSkipped: 2 });
    const verdict = decideRunSalvage(RUN, { status: 'none' }, lookup);
    expect(verdict.outcome).toBe('none');
    expect(verdict.line).toStartWith(`${RUN}  없음`);
  });

  test('a run with no matching branch at all → 없음', () => {
    const lookup = findRunSalvageBranches('run-12345678-0000', fakeGit());
    expect(lookup).toEqual({ status: 'none', trivialSkipped: 0 });
  });

  test('ls-remote failure → 모름, never 없음', () => {
    const git = fakeGit({ lsRemote: { status: 128, stdout: '', stderr: 'fatal: could not read from remote repository' } });
    const lookup = findRunSalvageBranches(RUN, git);
    expect(lookup.status).toBe('unknown');
    const verdict = decideRunSalvage(RUN, { status: 'none' }, lookup);
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.line).toContain('모름(ls-remote rc=128');
  });

  test('fetch failure → 모름', () => {
    expect(findRunSalvageBranches(RUN, fakeGit({ fetch: { status: 1, stdout: '', stderr: 'boom' } })).status).toBe('unknown');
  });

  test('rc=0 but unreadable ls-remote / numstat output → 모름, not 없음', () => {
    const garbledList = fakeGit({ lsRemote: ok('warning: something odd\nnot a ref line\n') });
    const a = findRunSalvageBranches(RUN, garbledList);
    expect(a.status).toBe('unknown');
    expect(a.status === 'unknown' && a.reason).toContain('ls-remote 출력 2줄');
    const garbledDiff = fakeGit({ numstat: { [SHA_WORK]: 'Binary files differ somehow\n', [SHA_REPO]: '1\t0\t.gitignore\n' } });
    const b = findRunSalvageBranches(RUN, garbledDiff);
    expect(b.status).toBe('unknown');
  });

  test('truncated (no trailing NUL) or blank -z numstat records → 모름', () => {
    const base = fakeGit();
    const truncated: SalvageGitRunner = (args) => (args[0] === 'diff' ? ok('1\t0\tdocs/goals/a.md') : base(args));
    expect(findRunSalvageBranches(RUN, truncated).status).toBe('unknown');
    const blank: SalvageGitRunner = (args) => (args[0] === 'diff' ? ok('1\t0\tdocs/goals/a.md\0   \0') : base(args));
    expect(findRunSalvageBranches(RUN, blank).status).toBe('unknown');
    const empty: SalvageGitRunner = (args) => (args[0] === 'diff' ? ok('') : base(args));
    expect(findRunSalvageBranches(RUN, empty)).toEqual({ status: 'none', trivialSkipped: 2 });
  });

  test('diff failure → 모름', () => {
    const git = fakeGit();
    const failing: SalvageGitRunner = (args) => (args[0] === 'diff' ? { status: 128, stdout: '', stderr: 'fatal: bad object' } : git(args));
    const lookup = findRunSalvageBranches(RUN, failing);
    expect(lookup.status).toBe('unknown');
    expect(lookup.status === 'unknown' && lookup.reason).toContain('diff ');
  });

  test('a runner that throws (ls-remote / fetch / diff) → 모름, never a crash', () => {
    for (const step of ['ls-remote', 'fetch', 'diff']) {
      const git = fakeGit();
      const throwing: SalvageGitRunner = (args) => {
        if (args[0] === step) throw new Error(`spawn ${step} ENOENT`);
        return git(args);
      };
      const lookup = findRunSalvageBranches(RUN, throwing);
      expect(lookup.status).toBe('unknown');
      expect(lookup.status === 'unknown' && lookup.reason).toContain('threw: spawn');
    }
  });

  test('a goal doc with a Korean name (unquoted under -z) is still trivial; diff is asked with -z', () => {
    const git = fakeGit({ numstat: { [SHA_WORK]: '12\t0\tdocs/goals/ASK-수확-가지.md\n', [SHA_REPO]: '1\t0\t.gitignore\n' } });
    expect(findRunSalvageBranches(RUN, git)).toEqual({ status: 'none', trivialSkipped: 2 });
    expect(git.calls.find((args) => args[0] === 'diff')).toContain('-z');
  });

  test('rc=0 with whitespace-only ls-remote lines → 모름; truly empty listing → 없음', () => {
    expect(findRunSalvageBranches(RUN, fakeGit({ lsRemote: ok('   \n') })).status).toBe('unknown');
    expect(findRunSalvageBranches(RUN, fakeGit({ lsRemote: ok('') }))).toEqual({ status: 'none', trivialSkipped: 0 });
  });

  test('a short-sha or space-separated ls-remote line elsewhere in the listing → 모름', () => {
    const listing = [`${SHA_WORK}\trefs/heads/${WORK}`, `abcdef1\trefs/heads/salvage/si-task-x/repo`].join('\n');
    expect(findRunSalvageBranches('run-12345678-0000', fakeGit({ lsRemote: ok(listing) })).status).toBe('unknown');
  });

  test('a path that only looks like .gitignore after trimming is real work', () => {
    const git = fakeGit({ numstat: { [SHA_WORK]: '1\t0\t .gitignore\n', [SHA_REPO]: '1\t0\t.gitignore\n' } });
    expect(findRunSalvageBranches(RUN, git).status).toBe('found');
  });

  test('only the root .gitignore is trivial; a nested .gitignore change is real work', () => {
    const git = fakeGit({ numstat: { [SHA_WORK]: '2\t0\tapps/pwa/.gitignore\n', [SHA_REPO]: '1\t0\t.gitignore\n' } });
    const lookup = findRunSalvageBranches(RUN, git);
    expect(lookup.status).toBe('found');
  });

  test('unreadable PR ledger + no salvage branch → 모름, not 없음', () => {
    const verdict = decideRunSalvage(RUN, { status: 'unknown', reason: '호스트 원장 없음' }, { status: 'none', trivialSkipped: 0 });
    expect(verdict.outcome).toBe('unknown');
  });

  test('PR wins over a salvage branch and git is never called', () => {
    const git = fakeGit();
    const lines: string[] = [];
    const verdicts = runHarnessSalvage([RUN], { git, readPr: () => ({ status: 'pr', number: 24660 }), print: (l) => lines.push(l) });
    expect(verdicts[0]!.outcome).toBe('pr');
    expect(verdicts[0]!.line).toBe(`${RUN}  PR #24660`);
    expect(git.calls).toEqual([]);
    expect(verdicts[0]!.salvage).toEqual({ status: 'not-checked' });
  });

  test('CLI --json for a PR run reports salvage as not-checked, never none', async () => {
    const program = new Command();
    const harness = program.command('harness');
    const lines: string[] = [];
    const git = fakeGit();
    installHarnessSalvageCommand(harness, { git, readPr: () => ({ status: 'pr', number: 5 }), print: (l) => lines.push(l) });
    await program.parseAsync(['node', 'x', 'harness', 'salvage', RUN, '--json']);
    expect(JSON.parse(lines[0]!)).toEqual([{ runId: RUN, outcome: 'pr', pr: { status: 'pr', number: 5 }, salvage: { status: 'not-checked' } }]);
    expect(git.calls).toEqual([]);
  });

  test('several runs share one ls-remote listing', () => {
    const git = fakeGit();
    const verdicts = runHarnessSalvage([RUN, 'run-12345678-0000'], { git, readPr: () => ({ status: 'none' }) });
    expect(verdicts.map((v) => v.outcome)).toEqual(['salvage', 'none']);
    expect(git.calls.filter((args) => args[0] === 'ls-remote')).toHaveLength(1);
  });

  test('ledger projection: last pr-opened number, else run-rollup prNumber, null ledger → unknown', () => {
    expect(prStateFromLedger(null).status).toBe('unknown');
    expect(prStateFromLedger([]).status).toBe('unknown');
    expect(prStateFromLedger([{ event: 'start', data: {} }]).status).toBe('unknown');
    expect(prStateFromLedger([{ event: 'run-status', data: { stage: 'gate-failed' } }])).toEqual({ status: 'none' });
    expect(prStateFromLedger([{ event: 'run-status', data: { stage: 'pr-opened' } }]).status).toBe('unknown');
    expect(prStateFromLedger([{ event: 'run-status', data: { stage: 'merge-conflict' } }]).status).toBe('unknown');
    expect(prStateFromLedger([{ event: 'run-status', data: { stage: 'implementing' } }]).status).toBe('unknown');
    expect(prStateFromLedger([{ event: 'run-status', data: { stage: 'timed-out' } }])).toEqual({ status: 'none' });
    expect(prStateFromLedger([{ event: 'pr-opened', data: {} }]).status).toBe('unknown');
    expect(prStateFromLedger([{ event: 'pr-opened', data: { number: 7 } }, { event: 'pr-opened', data: {} }])).toEqual({ status: 'pr', number: 7 });
    expect(prStateFromLedger([{ event: 'pr-opened', data: { prUrl: 'https://github.com/o/r/pull/42' } }])).toEqual({ status: 'pr', number: 42 });
    expect(prStateFromLedger([{ event: 'pr-opened', data: { number: 7 } }, { event: 'pr-opened', data: { number: 9 } }])).toEqual({ status: 'pr', number: 9 });
    expect(prStateFromLedger([{ event: 'run-rollup', data: { prNumber: 11 } }])).toEqual({ status: 'pr', number: 11 });
  });

  test('CLI `harness salvage --json` prints structured verdicts', async () => {
    const program = new Command();
    program.exitOverride();
    const harness = program.command('harness');
    const lines: string[] = [];
    installHarnessSalvageCommand(harness, { git: fakeGit(), readPr: () => ({ status: 'none' }), print: (l) => lines.push(l) });
    await program.parseAsync(['node', 'x', 'harness', 'salvage', RUN, '--json']);
    const parsed = JSON.parse(lines[0]!) as Array<{ runId: string; outcome: string }>;
    expect(parsed).toEqual([expect.objectContaining({ runId: RUN, outcome: 'salvage' })]);
  });

  test('production harness CLI wires `harness salvage`', () => {
    const program = new Command();
    const harness = installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', ask: async () => {} });
    const salvage = harness.commands.find((cmd) => cmd.name() === 'salvage');
    expect(salvage).toBeDefined();
    expect(salvage!.options.map((option) => option.long)).toContain('--json');
  });

  test('real `git diff --numstat -z --no-renames` output (temp repo, no network) parses with unquoted Korean paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'salvage-numstat-'));
    try {
      const git = (...args: string[]) => {
        const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
        expect(r.status).toBe(0);
        return r.stdout;
      };
      git('init', '-q');
      writeFileSync(join(dir, 'a.ts'), 'x\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      mkdirSync(join(dir, 'docs/goals'), { recursive: true });
      writeFileSync(join(dir, 'docs/goals/ASK-수확 가지.md'), 'a\nb\n');
      writeFileSync(join(dir, 'a.ts'), 'y\nz\n');
      git('add', '.');
      git('commit', '-q', '-m', 'work');
      const parsed = parseNumstat(git('diff', '--numstat', '-z', '--no-renames', 'HEAD~1...HEAD'));
      expect(parsed.unparsed).toBe(0);
      expect(parsed.paths.sort()).toEqual(['a.ts', 'docs/goals/ASK-수확 가지.md']);
      expect(parsed.diffstat).toEqual({ files: 2, insertions: 4, deletions: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
