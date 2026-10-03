import { describe, expect, it, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import {
  countRecentLandings,
  countRecentLandingsByAuthor,
  formatOverlapAdvisory,
  formatRecentLandingRateAdvisory,
  LANDING_HISTORY_META_MARK,
  landingHistoryLogArgs,
  parseCommitNameLog,
} from './pr-granularity.js';
import { runPrLand, type PrLandDeps } from './pr-cli.js';
import type { CmdRunner, PrManager, UpsertPrInput } from '../autopilot/pr-manager.js';
import type { RunningRunsResult } from '../self-implement/running-runs.js';

const AUTHOR = 'me@example.com';
const OTHER = 'other@example.com';
const NOW_MS = 1_700_000_000_000;
const MIN = 60_000;

function fakeManager() {
  const calls: string[] = [];
  const upserts: UpsertPrInput[] = [];
  const manager: PrManager = {
    findPrForBranch: () => { calls.push('find-legacy'); return null; },
    findPrForBranchOutcome: () => { calls.push('find'); return { status: 'ok EMPTY', url: null }; },
    upsertPr: (input) => {
      calls.push('upsert');
      upserts.push(input);
      return { ok: true, url: 'https://github.com/example/repo/pull/42', reused: false };
    },
    closePr: () => { calls.push('close'); return true; },
    mergePr: () => { calls.push('merge'); return true; },
    mergePrOutcome: () => { calls.push('merge'); return { ok: true, kind: 'merge-exit-0' }; },
  };
  return { manager, calls, upserts };
}

function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    out: { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) },
  };
}

const statusArgs = 'status --porcelain=v1 -z --untracked-files=all';
const numstatArgs = 'diff --numstat HEAD';

const baseLookupRun = (cmd: string, args: readonly string[]) =>
  cmd === 'git' && args.join(' ') === 'remote'
    ? { ok: true, out: 'origin\n' }
    : cmd === 'git' && args.join(' ') === 'remote get-url origin'
      ? { ok: true, out: 'git@github.com:example/repo.git\n' }
      : cmd === 'git' && args.join(' ') === statusArgs
        ? { ok: true, out: '' }
        : cmd === 'git' && args.join(' ') === numstatArgs
          ? { ok: true, out: '' }
          : cmd === 'gh' && args.join(' ').includes('pr view')
            ? { ok: true, out: 'main' }
            : { ok: false, out: '' };

function landRun(opts: {
  logOut: string;
  currentFiles?: string;
  statusEntries?: string;
  email?: string | null;
}) {
  const commands: Array<{ cmd: string; args: readonly string[] }> = [];
  const run: CmdRunner = (cmd, args) => {
    commands.push({ cmd, args });
    const command = args.join(' ');
    if (cmd === 'git' && command === statusArgs) {
      return { ok: true, out: opts.statusEntries ?? ' M src/land.ts\0' };
    }
    if (cmd === 'git' && command === numstatArgs) return { ok: true, out: '' };
    if (cmd === 'git' && args[0] === 'config' && args[1] === 'user.email') {
      return { ok: true, out: opts.email ?? '' };
    }
    if (cmd === 'git' && args[0] === 'log' && args.includes('--name-only')) {
      return { ok: true, out: opts.logOut };
    }
    if (cmd === 'git' && args[0] === 'diff' && args.includes('--name-only')) {
      return { ok: true, out: opts.currentFiles ?? 'src/land.ts\n' };
    }
    return baseLookupRun(cmd, args);
  };
  return { run, commands };
}

const emptyRunningRuns = {
  entries: [],
  counts: { running: 0, 'probable-running': 0, 'ended-unclosed': 0, unknown: 0 },
  total: 0,
  countedStatuses: ['running', 'probable-running'] as const,
  observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true as const, includesTest: true },
  quantities: {
    counts: { value: { running: 0, 'probable-running': 0, 'ended-unclosed': 0, unknown: 0 }, population: 'all assessed runs' as const, observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true as const, includesTest: true } },
    total: { value: 0, population: 'all assessed runs' as const, observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true as const, includesTest: true } },
    entries: { value: 0, population: 'all assessed runs' as const, observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true as const, includesTest: true } },
    running: { value: 0, population: 'assessed runs whose status is in countedStatuses' as const, observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true as const, includesTest: true } },
  },
  ledger: { ledgerDirectories: ['/tmp/run-ledger'], unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 },
  pty: { unreadable: [], observedRefCount: 0, withoutRunIdCount: 0, notCountedRefCount: 0 },
} satisfies RunningRunsResult;

const baseDeps: PrLandDeps = {
  currentBranch: () => 'feat/land',
  resolveBase: () => 'origin/main',
  listUnfinishedRuns: () => [],
  queryRunningRuns: () => emptyRunningRuns,
  runTypecheckGate: () => true,
  runIsolationGate: () => true,
  runExportLeakCheck: () => ({ measured: true, hits: [] }),
  isInteractive: () => false,
  // Every real gate and lookup is stubbed: unstubbed, they scanned the real repository and called gh, taking ~3 s per
  // landing test and timing out under gate-pod load (0.2.9 cut · introduced, 13/1 intermittently).
  runMockModuleRestoreGate: () => true,
  runModelHardcodeGate: () => true,
  runDaemonPortGate: () => true,
  runPublicLeakGate: () => 0,
  runDocsCliCheck: () => [],
  runTestInterferenceGate: async () => 0,
  runAndroidGate: () => true,
  runPwaGate: () => true,
  runIosGate: () => true,
  listOpenPrs: () => [],
  sleep: async () => undefined,
  now: () => NOW_MS,
};

function unixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function landingLine(hash: string, email: string, committedAtMs: number, subject: string, file: string): string {
  return [`commit ${hash}${LANDING_HISTORY_META_MARK}${email} ${unixSeconds(committedAtMs)} ${subject}`, file, ''].join('\n');
}

const fourCommits = [
  { authorEmail: AUTHOR, committedAtMs: NOW_MS - 10 * MIN },
  { authorEmail: AUTHOR, committedAtMs: NOW_MS - 90 * MIN },
  { authorEmail: OTHER, committedAtMs: NOW_MS - 10 * MIN },
  { authorEmail: AUTHOR, committedAtMs: NOW_MS + 5 * MIN },
] as const;

function recentLandingSteps(logged: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return logged.mock.calls
    .filter((call) => call[0] === 'pr.land' && call[1] === 'step' && (call[2] as { step?: string } | undefined)?.step === 'recent-landing-rate')
    .map((call) => call[2] as Record<string, unknown>);
}

describe('formatRecentLandingRateAdvisory', () => {
  it('returns the hold advisory for three landings in a 30-minute window', () => {
    const line = formatRecentLandingRateAdvisory({ recentCount: 3, windowMinutes: 30 });
    expect(line).toBe('⚠ recent-landings: 최근 30분에 이 저장소에 들어온 착지가 3건입니다 (저자 식별자가 하나뿐이라 세션별로 가르지 못합니다) — 같은 주제면 커밋하지 말고 다음 것과 함께 내십시오. 리뷰를 먼저 받아야 하면 pr land --hold.');
    expect(line?.startsWith('⚠ recent-landings:')).toBe(true);
    expect(line).toContain('이 저장소에 들어온');
    expect(line).not.toContain('당신이');
    expect(line).toContain('세션별로 가르지 못합니다');
    expect(line).toContain('커밋하지 말고');
    expect(line).toContain('3건');
    expect(line).toContain('30분');
    expect(line).toContain('--hold');
    expect(line!.indexOf('커밋하지 말고')).toBeLessThan(line!.indexOf('--hold'));
  });

  it('suppresses the first landing: 0 and 1 both return null', () => {
    expect(formatRecentLandingRateAdvisory({ recentCount: 0, windowMinutes: 30 })).toBeNull();
    expect(formatRecentLandingRateAdvisory({ recentCount: 1, windowMinutes: 30 })).toBeNull();
  });
});

describe('countRecentLandingsByAuthor', () => {
  it('counts only same-author commits inside the window and drops future ones', () => {
    expect(countRecentLandingsByAuthor(fourCommits, {
      authorEmail: AUTHOR,
      nowMs: NOW_MS,
      windowMinutes: 30,
    })).toBe(1);
  });

  it('matches countRecentLandings for the same arguments', () => {
    const opts = { authorEmail: AUTHOR, nowMs: NOW_MS, windowMinutes: 30 };
    expect(countRecentLandings(fourCommits, opts)).toBe(countRecentLandingsByAuthor(fourCommits, opts));
  });

  it('matches author email case-insensitively', () => {
    expect(countRecentLandingsByAuthor(
      [{ authorEmail: 'Me@Example.COM', committedAtMs: NOW_MS - 10 * MIN }],
      { authorEmail: AUTHOR, nowMs: NOW_MS, windowMinutes: 30 },
    )).toBe(1);
  });

  it('fails this check if author filtering is dropped and every commit is counted', () => {
    const counted = countRecentLandingsByAuthor(fourCommits, {
      authorEmail: AUTHOR,
      nowMs: NOW_MS,
      windowMinutes: 30,
    });
    const authorIgnored = fourCommits.filter((commit) =>
      commit.committedAtMs <= NOW_MS && NOW_MS - commit.committedAtMs <= 30 * MIN,
    ).length;
    expect(authorIgnored).toBeGreaterThan(1);
    expect(counted).toBe(1);
    expect(counted).not.toBe(authorIgnored);
  });
});

describe('landing history metadata', () => {
  it('asks git log for author email and commit time without dropping hash/subject/files', () => {
    expect(landingHistoryLogArgs('1 day ago', 'origin/main')).toEqual([
      'log',
      '--since=1 day ago',
      '--pretty=format:commit %H%x1e%ae %ct %s',
      '--name-only',
      '--no-merges',
      '--no-renames',
      'origin/main',
    ]);
  });

  it('parses authorEmail and committedAtMs while keeping hash, subject, and files', () => {
    const log = [
      `commit aaa111bbb222ccc333ddd444eee555fff666aaa${LANDING_HISTORY_META_MARK}me@example.com 1700000000 docs(cli): land`,
      'src/cli/pr-cli.ts',
      'src/cli/pr-granularity.ts',
      '',
    ].join('\n');
    const commits = parseCommitNameLog(log);
    expect(commits).toEqual([{
      hash: 'aaa111bbb222ccc333ddd444eee555fff666aaa',
      subject: 'docs(cli): land',
      files: ['src/cli/pr-cli.ts', 'src/cli/pr-granularity.ts'],
      authorEmail: 'me@example.com',
      committedAtMs: 1_700_000_000_000,
    }]);
  });

  it('keeps hash/subject/files when the log has no author metadata', () => {
    const log = [
      'commit aaa111bbb222ccc333ddd444eee555fff666aaa docs(cli): land',
      'src/cli/pr-cli.ts',
    ].join('\n');
    const [commit] = parseCommitNameLog(log);
    expect(commit?.hash).toBe('aaa111bbb222ccc333ddd444eee555fff666aaa');
    expect(commit?.subject).toBe('docs(cli): land');
    expect(commit?.files).toEqual(['src/cli/pr-cli.ts']);
    expect(commit?.authorEmail).toBe('');
    expect(commit?.committedAtMs).toBe(0);
  });

  it('does not treat a legacy subject that starts with email digits as metadata', () => {
    const log = [
      'commit aaa111bbb222ccc333ddd444eee555fff666aaa me@example.com 1700000000 docs(cli): land',
      'src/cli/pr-cli.ts',
    ].join('\n');
    const [commit] = parseCommitNameLog(log);
    expect(commit?.hash).toBe('aaa111bbb222ccc333ddd444eee555fff666aaa');
    expect(commit?.subject).toBe('me@example.com 1700000000 docs(cli): land');
    expect(commit?.files).toEqual(['src/cli/pr-cli.ts']);
    expect(commit?.authorEmail).toBe('');
    expect(commit?.committedAtMs).toBe(0);
  });
});

describe('formatOverlapAdvisory preservation', () => {
  it('keeps the overlap advisory wording unchanged', () => {
    expect(formatOverlapAdvisory([{ path: 'src/land.ts', recentLandingCount: 2 }])).toBe(
      '⚠ overlap: src/land.ts (2회) — 같은 파일을 최근 착지가 건드렸습니다. 쌓아 두려면 pr land --hold 를 쓰십시오.',
    );
  });
});

describe('pr land recent-landing-rate wiring', () => {
  it('emits the recent-landings line beside overlap, records observation, and does not block landing', async () => {
    const nowSec = unixSeconds(NOW_MS);
    const logOut = [
      landingLine('aaa111bbb222ccc333ddd444eee555fff666aaa', AUTHOR, nowSec * 1000 - 10 * MIN, 'docs(cli): one', 'src/land.ts'),
      landingLine('bbb222ccc333ddd444eee555fff666aaa111bbb', AUTHOR, nowSec * 1000 - 12 * MIN, 'docs(cli): two', 'src/land.ts'),
    ].join('\n');
    const { run, commands } = landRun({ logOut, email: AUTHOR });
    const sink = output();
    const { manager, calls } = fakeManager();
    let asked = 0;
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const code = await runPrLand({ hold: true }, {
        ...baseDeps,
        run,
        manager,
        out: sink.out,
        decideOverlapLanding: () => {
          asked += 1;
          return { outcome: 'user-merge', channel: 'terminal', interactive: true };
        },
      });
      expect(code).toBe(0);
      expect(asked).toBe(0);
      expect(calls).toEqual(['find', 'upsert']);
      const baseIndex = sink.logs.findIndex((line) => line.startsWith('✓ base:'));
      const overlapIndex = sink.logs.findIndex((line) => line.startsWith('⚠ overlap:'));
      const recentIndex = sink.logs.findIndex((line) => line.startsWith('⚠ recent-landings:'));
      const typecheckIndex = sink.logs.findIndex((line) => line.startsWith('✓ typecheck:'));
      expect(overlapIndex).toBeGreaterThanOrEqual(0);
      expect(recentIndex).toBeGreaterThan(baseIndex);
      expect(recentIndex).toBeLessThan(typecheckIndex);
      expect(recentIndex).toBeLessThan(overlapIndex);
      expect(sink.logs[recentIndex]).toContain('2건');
      expect(sink.logs[recentIndex]).toContain('30분');
      expect(sink.logs[recentIndex]).toContain('이 저장소에 들어온');
      expect(sink.logs[recentIndex]).not.toContain('당신이');
      expect(sink.logs[recentIndex]).toContain('커밋하지 말고');
      expect(sink.logs[recentIndex]).toContain('--hold');
      expect(sink.logs[recentIndex]!.indexOf('커밋하지 말고')).toBeLessThan(sink.logs[recentIndex]!.indexOf('--hold'));
      expect(recentLandingSteps(logged)).toEqual([
        expect.objectContaining({
          step: 'recent-landing-rate',
          ok: true,
          recentCount: 2,
          windowMinutes: 30,
          emitted: true,
          scope: 'repository',
          hasPrevious: true,
        }),
      ]);
      expect(commands.some(({ cmd, args }) => cmd === 'git' && args[0] === 'config' && args[1] === 'user.email')).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });

  it('stays quiet and non-fatal when git config user.email is empty', async () => {
    const nowSec = unixSeconds(NOW_MS);
    const logOut = [
      landingLine('aaa111bbb222ccc333ddd444eee555fff666aaa', AUTHOR, nowSec * 1000 - 10 * MIN, 'docs(cli): one', 'src/land.ts'),
      landingLine('bbb222ccc333ddd444eee555fff666aaa111bbb', AUTHOR, nowSec * 1000 - 12 * MIN, 'docs(cli): two', 'src/land.ts'),
    ].join('\n');
    const { run } = landRun({ logOut, email: '' });
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({ hold: true }, {
        ...baseDeps,
        run,
        manager: fakeManager().manager,
        out: sink.out,
      })).toBe(0);
      expect(sink.logs.some((line) => line.includes('recent-landings'))).toBe(false);
      expect(sink.errors.some((line) => line.includes('recent-landings'))).toBe(false);
      expect(recentLandingSteps(logged)).toEqual([
        expect.objectContaining({
          step: 'recent-landing-rate',
          ok: true,
          recentCount: 0,
          windowMinutes: 30,
          emitted: false,
          scope: 'repository',
          hasPrevious: true,
        }),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('does not mix recent-landings into the overlap HITL path when only the rate fires', async () => {
    const nowSec = unixSeconds(NOW_MS);
    const logOut = [
      landingLine('aaa111bbb222ccc333ddd444eee555fff666aaa', AUTHOR, nowSec * 1000 - 10 * MIN, 'docs(cli): one', 'docs/other.md'),
      landingLine('bbb222ccc333ddd444eee555fff666aaa111bbb', AUTHOR, nowSec * 1000 - 12 * MIN, 'docs(cli): two', 'docs/other.md'),
    ].join('\n');
    const { run } = landRun({ logOut, email: AUTHOR });
    const sink = output();
    const { manager, calls } = fakeManager();
    let asked = 0;
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({}, {
        ...baseDeps,
        run,
        manager,
        out: sink.out,
        decideOverlapLanding: () => {
          asked += 1;
          return { outcome: 'user-hold', channel: 'terminal', interactive: true };
        },
      })).toBe(0);
      expect(asked).toBe(0);
      expect(calls).toEqual(['find', 'upsert', 'merge']);
      expect(sink.logs.some((line) => line.includes('overlap'))).toBe(false);
      expect(sink.logs.some((line) => line.startsWith('⚠ recent-landings:'))).toBe(true);
      expect(recentLandingSteps(logged)[0]).toEqual(expect.objectContaining({
        step: 'recent-landing-rate',
        ok: true,
        recentCount: 2,
        windowMinutes: 30,
        emitted: true,
        scope: 'repository',
        hasPrevious: true,
      }));
    } finally {
      logged.mockRestore();
    }
  });
});
