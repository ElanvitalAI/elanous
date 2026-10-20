import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import type { SpawnSyncOptions } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { Command } from 'commander';
import { debug } from '../../src/debug/log.js';
import { runLandingPodShadowJob } from '../../src/cli/pr-land-pod-shadow-job.js';
import { setGitCommandRunnerForTesting } from '../../src/git-fs/runner.js';
import { parseNumstat, parsePorcelainStatus, registerPrCommands as realRegisterPrCommands, runPrGranularity, runPrLand as realRunPrLand, decideOverlapLanding, overlapDecisionFromConfirm, publicLeakWarning, exportLeakBlock, runPrLandExportLeakCheck, docsCliWarning, publicDocPaths, OVERLAP_DECISION_PROMPT, createOverlapConfirmChannel, formatCommitMessageFallbackNotice, formatLandReasonNotice, codePointLength, branchLineageSlug, findSiblingPrs } from '../../src/cli/pr-cli.js';
import type { ConfirmOpts, ConfirmResult } from '../../src/hitl/confirm.js';
import { LANDING_HISTORY_META_MARK, TOP_PREFIX_COUNT_LIMIT } from '../../src/cli/pr-granularity.js';
import { enableLandingFreeze } from '../../src/release-loop/landing-freeze.js';
import { effectiveInstanceRoot, prodInstanceRoot, resetEffectiveInstanceRoot } from '../../src/instance/resolve.js';
import type { PrLandDeps, PrLandOpts } from '../../src/cli/pr-cli.js';
import { renderBaseline } from '../../scripts/ci-public-leak-gate.js';
import type { CmdRunner, FindPrForBranchOutcome, MergePrOutcome, PrManager, UpsertPrInput, UpsertPrOutcome } from '../../src/autopilot/pr-manager.js';
import type { FederatedUnfinishedRunLedgerEntry, FederatedUnfinishedRunLedgerQuery } from '../../src/self-implement/run-ledger.js';
import type { RunningRunsResult } from '../../src/self-implement/running-runs.js';

function fakeManager(overrides: Partial<PrManager> = {}) {
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
    ...overrides,
  };
  return { manager, calls, upserts };
}

function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, out: { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) } };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

const baseLookupRun = (cmd: string, args: readonly string[]) =>
  cmd === 'git' && args.join(' ') === 'remote'
    ? { ok: true, out: 'origin\n' }
    : cmd === 'git' && args.join(' ') === 'remote get-url origin'
      ? { ok: true, out: 'git@github.com:example/repo.git\n' }
      : cmd === 'git' && args.join(' ') === 'rev-parse --verify --quiet refs/remotes/origin/main'
        ? { ok: true, out: 'remote-sha\n' }
        : cmd === 'git' && args.join(' ') === statusArgs
        ? { ok: true, out: '' }
        : cmd === 'git' && args.join(' ') === numstatArgs
          ? { ok: true, out: '' }
          : cmd === 'gh' && args.join(' ').includes('pr view')
            ? { ok: true, out: 'main' }
            : { ok: false, out: '' };
let prodFreezeRoot: string;
let isolatedStateDir: string;
let savedStateDir: string | undefined;
// Both freeze authorities are isolated: the operational root (injected) and the local universe (ELANOUS_STATE_DIR).
beforeEach(() => {
  prodFreezeRoot = mkdtempSync(join(tmpdir(), 'pr-cli-freeze-'));
  isolatedStateDir = mkdtempSync(join(tmpdir(), 'pr-cli-state-'));
  savedStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = isolatedStateDir;
  resetEffectiveInstanceRoot();
  expect(effectiveInstanceRoot()).not.toBe(prodInstanceRoot());
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = savedStateDir;
  resetEffectiveInstanceRoot();
  rmSync(prodFreezeRoot, { recursive: true, force: true });
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

const runPrLand = (opts: PrLandOpts = {}, deps: PrLandDeps = {}) => realRunPrLand(opts, { ...deps, prodFreezeRoot });
const registerPrCommands = (program: Command, deps: PrLandDeps = {}) => realRegisterPrCommands(program, { ...deps, prodFreezeRoot });

const baseDeps = {
  get prodFreezeRoot() { return prodFreezeRoot; },
  currentBranch: () => 'feat/land', resolveBase: () => 'origin/main', run: baseLookupRun, listUnfinishedRuns: () => [] as const,
  queryRunningRuns: () => runningRuns([]), runTypecheckGate: () => true, runIsolationGate: () => true, runMockModuleRestoreGate: () => true, runModelHardcodeGate: () => true, runDaemonPortGate: () => true,
  runPublicLeakGate: () => 0,
  runExportLeakCheck: () => ({ measured: true, hits: [] }),
  runExportImportCheck: () => ({ measured: true, hits: [], unseen: 0 }),
  // The PWA gate builds for real when a change reaches the bundle — scripts/ci-pwa-build-gate.test.ts owns its behaviour.
  runPwaGate: () => true,
  isInteractive: () => false,
};

function unfinishedRun(runId: string, plannedPaths: readonly string[], goalDocumentPath: string | null = null): FederatedUnfinishedRunLedgerEntry {
  return {
    runId, plannedPaths, branch: 'se/test', status: 'terminal-status-missing',
    plannedPathStatus: 'found-ledger-goal-file', declaredPaths: [], declaredPathStatus: 'no-declared-paths',
    pathMatchReasons: {}, goalDocumentPath, goalDocumentSearchDirectory: null,
    lastActivityTimestamp: null, lastActivityAgeMs: null, lastActivityStatus: 'timestamp-missing',
    lifecycle: 'live', ledgerDirectory: '/tmp/run-ledger',
  };
}

function runningRuns(entries: RunningRunsResult['entries'], overrides: Partial<Pick<RunningRunsResult, 'countedStatuses' | 'ledger' | 'pty'>> = {}): RunningRunsResult {
  const counts: RunningRunsResult['counts'] = { running: 0, 'probable-running': 0, 'ended-unclosed': 0, unknown: 0 };
  const observation = { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: true } as const;
  const countedStatuses = ['running', 'probable-running'] as const;
  for (const entry of entries) counts[entry.status] += 1;
  const total = entries.length;
  return {
    entries, counts, total, countedStatuses, observation,
    quantities: {
      counts: { value: counts, population: 'all assessed runs', observation },
      total: { value: total, population: 'all assessed runs', observation },
      entries: { value: total, population: 'all assessed runs', observation },
      running: { value: counts.running + counts['probable-running'], population: 'assessed runs whose status is in countedStatuses', observation },
    },
    ledger: { ledgerDirectories: ['/tmp/run-ledger'], unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 },
    pty: { unreadable: [], observedRefCount: 0, withoutRunIdCount: 0, notCountedRefCount: 0 },
    ...overrides,
  };
}

function unfinishedRunQuery(entries: readonly FederatedUnfinishedRunLedgerEntry[], failures: Partial<Pick<FederatedUnfinishedRunLedgerQuery, 'unreadableLedgerDirectoryCount' | 'missingLedgerDirectoryCount' | 'unreadableLedgerDirectoryAccessCount' | 'indeterminateLedgerDirectoryCount' | 'unreadableLedgerCount'>> = {}): FederatedUnfinishedRunLedgerQuery {
  const missingLedgerDirectoryCount = failures.missingLedgerDirectoryCount ?? 0;
  const unreadableLedgerDirectoryAccessCount = failures.unreadableLedgerDirectoryAccessCount ?? 0;
  const indeterminateLedgerDirectoryCount = failures.indeterminateLedgerDirectoryCount ?? 0;
  return {
    entries, ledgerDirectories: ['/tmp/run-ledger'], goalsDirectory: '/tmp/goals',
    unreadableLedgerCount: failures.unreadableLedgerCount ?? 0,
    unreadableLedgerDirectoryCount: failures.unreadableLedgerDirectoryCount ?? missingLedgerDirectoryCount + unreadableLedgerDirectoryAccessCount + indeterminateLedgerDirectoryCount,
    missingLedgerDirectoryCount, unreadableLedgerDirectoryAccessCount, indeterminateLedgerDirectoryCount,
    reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'test',
  };
}

const statusArgs = 'status --porcelain=v1 -z --untracked-files=all';
const numstatArgs = 'diff --numstat HEAD';

function statusRun(entries: string, includeUntracked = false): typeof baseLookupRun {
  const statusEntries = includeUntracked ? entries : entries.replaceAll('?? ', ' M ');
  return (cmd, args) => cmd === 'git' && args.join(' ') === statusArgs
    ? { ok: true, out: statusEntries }
    : baseLookupRun(cmd, args);
}

function numstatRun(numstat: string, statusEntries = ' M src/land.ts\0', includeUntracked = false): typeof baseLookupRun {
  const status = includeUntracked ? statusEntries : statusEntries.replaceAll('?? ', ' M ');
  return (cmd, args) => {
    const command = args.join(' ');
    if (cmd === 'git' && command === statusArgs) return { ok: true, out: status };
    if (cmd === 'git' && command === numstatArgs) return { ok: true, out: numstat };
    return baseLookupRun(cmd, args);
  };
}

describe('porcelain v1 -z status parsing', () => {
  it('preserves primary XY records, accepts only ?? as untracked, and consumes rename/copy continuations', async () => {
    const records = parsePorcelainStatus(
      '?? local config.toml\0?? folder/space name\nline.ts\0 A staged.ts\0!! ignored.log\0 R renamed.ts\0old-name.ts\0 C copied.ts\0source.ts\0',
    );
    expect(records).toEqual([
      { xy: '??', path: 'local config.toml' },
      { xy: '??', path: 'folder/space name\nline.ts' },
      { xy: ' A', path: 'staged.ts' },
      { xy: '!!', path: 'ignored.log' },
      { xy: ' R', path: 'renamed.ts', originalPath: 'old-name.ts' },
      { xy: ' C', path: 'copied.ts', originalPath: 'source.ts' },
    ]);
    expect(records.filter(({ xy }) => xy === '??').map(({ path }) => path)).toEqual([
      'local config.toml',
      'folder/space name\nline.ts',
    ]);
  });
});

describe('git diff --numstat parsing', () => {
  it('reads added/deleted/path columns and skips binary dash rows', async () => {
    expect(parseNumstat('3\t40\tsrc/self-implement/goal-author.ts\n-\t-\timage.png\n40\t3\tsrc/keep.ts\n')).toEqual([
      { added: 3, deleted: 40, path: 'src/self-implement/goal-author.ts' },
      { added: 40, deleted: 3, path: 'src/keep.ts' },
    ]);
  });
});

describe('formatCommitMessageFallbackNotice', () => {
  it('returns the warning with the unchanged chore: land fallback when a title is present', () => {
    const line = formatCommitMessageFallbackNotice({ branch: 'x-y', hasTitle: true });
    expect(line).toBe(
      '⚠ commit-message: --title 은 PR 제목에만 쓰입니다. 커밋 메시지는 "chore: land x-y" 가 됩니다 — 같은 문면을 남기려면 --commit-message 를 함께 주십시오.',
    );
    expect(line?.startsWith('⚠ commit-message:')).toBe(true);
    expect(line).toContain('chore: land x-y');
    expect(line).toContain('--commit-message');
  });

  it('returns null when hasTitle is false', () => {
    expect(formatCommitMessageFallbackNotice({ branch: 'x-y', hasTitle: false })).toBeNull();
  });
});

describe('codePointLength', () => {
  it('counts emoji-containing sample as 14 code points, not UTF-16 length 16', () => {
    const sample = '🅣 세 트랙 공동 실측 🎯';
    expect(sample.length).toBe(16);
    expect(codePointLength(sample)).toBe(14);
  });

  it('returns 0 for the empty string', () => {
    expect(codePointLength('')).toBe(0);
  });
});

describe('formatLandReasonNotice', () => {
  it('returns the missing-reason warning when an advisory was shown without a reason', () => {
    const line = formatLandReasonNotice({ advisoryShown: true });
    expect(line).toBe('⚠ land-reason: 권고가 떴는데 이유가 없습니다 — 지금 내야 한다면 --land-reason 으로 한 줄 남기십시오.');
    expect(line?.startsWith('⚠ land-reason:')).toBe(true);
    expect(line).toContain('--land-reason');
  });

  it('returns the success notice with the given reason', () => {
    expect(formatLandReasonNotice({ advisoryShown: true, reason: '채널이 기다림' })).toBe('✓ land-reason: 채널이 기다림');
  });

  it('returns null when no advisory was shown even if a reason is given', () => {
    expect(formatLandReasonNotice({ advisoryShown: false, reason: 'x' })).toBeNull();
  });

  it('truncates a reason longer than 160 characters to 157 characters plus ...', () => {
    const reason = 'x'.repeat(200);
    const line = formatLandReasonNotice({ advisoryShown: true, reason });
    expect(line).toBe(`✓ land-reason: ${'x'.repeat(157)}...`);
    expect(line).not.toContain(reason);
  });
});

describe('branchLineageSlug', () => {
  it('strips the self-impl prefix and a trailing 8-hex hash', () => {
    expect(branchLineageSlug('self-impl/src-a-ts-src-b-9bbc6568')).toBe('src-a-ts-src-b');
  });

  it('returns null for a non-self-impl branch', () => {
    expect(branchLineageSlug('feat/land')).toBeNull();
  });

  it('keeps a hashless self-impl slug', () => {
    expect(branchLineageSlug('self-impl/src-a-ts')).toBe('src-a-ts');
  });
});

describe('findSiblingPrs', () => {
  it('keeps same-slug open PRs and drops a different slug', () => {
    expect(findSiblingPrs('self-impl/x-1111aaaa', [
      { number: 101, headRefName: 'self-impl/x-2222bbbb' },
      { number: 102, headRefName: 'self-impl/y-3333cccc' },
    ])).toEqual([{ number: 101, headRefName: 'self-impl/x-2222bbbb' }]);
  });

  it('excludes the current branch from siblings', () => {
    expect(findSiblingPrs('self-impl/x-1111aaaa', [
      { number: 101, headRefName: 'self-impl/x-1111aaaa' },
      { number: 102, headRefName: 'self-impl/x-2222bbbb' },
    ])).toEqual([{ number: 102, headRefName: 'self-impl/x-2222bbbb' }]);
  });

  it('returns an empty list when the current branch has no lineage slug', () => {
    expect(findSiblingPrs('feat/land', [
      { number: 101, headRefName: 'self-impl/x-2222bbbb' },
    ])).toEqual([]);
  });
});

describe('elanous pr land', () => {
  it('defers a frozen landing and queues its head; a reasoned --force-freeze merges once and emits the force event', async () => {
    const { manager, calls } = fakeManager();
    const sink = output();
    const state = mkdtempSync(join(tmpdir(), 'pr-cli-queue-'));
    const before = process.env.ELANOUS_STATE_DIR;
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      process.env.ELANOUS_STATE_DIR = state;
      enableLandingFreeze({ reason: 'cut', by: 'OP' }, prodFreezeRoot);
      const run = (cmd: string, args: readonly string[]) => cmd === 'git' && args.join(' ') === 'rev-parse HEAD'
        ? { ok: true, out: 'a'.repeat(40) } : baseLookupRun(cmd, args);
      const deps = { ...baseDeps, manager, run, out: sink.out };
      expect(await runPrLand({}, deps)).toBe(0);
      expect(calls).toEqual(['find', 'upsert']);
      expect(JSON.parse(readFileSync(join(state, 'landing-freeze-pending.json'), 'utf8'))).toMatchObject([{ prNumber: 42, headCommit: 'a'.repeat(40) }]);
      expect(await runPrLand({ forceFreeze: '  version bump  ' }, deps)).toBe(0);
      expect(calls).toEqual(['find', 'upsert', 'find', 'upsert', 'merge']);
      expect(JSON.parse(readFileSync(join(state, 'landing-freeze-pending.json'), 'utf8'))).toEqual([]);
      expect(logged.mock.calls.filter((call) => call[0] === 'release-loop.freeze' && call[1] === 'force-merge')).toEqual([
        ['release-loop.freeze', 'force-merge', { pr: 42, reason: 'version bump' }],
      ]);
    } finally {
      logged.mockRestore();
      if (before === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = before;
      rmSync(state, { recursive: true, force: true });
    }
  });

  it('rejects --force-freeze without a nonblank reason before creating a PR', async () => {
    const { manager, calls } = fakeManager();
    const sink = output();
    expect(await runPrLand({ forceFreeze: '   ' }, { ...baseDeps, manager, out: sink.out })).toBe(1);
    expect(calls).toEqual([]);
    expect(sink.errors.join('\n')).toContain('--force-freeze');
  });

  it('uses an injected temporary operational root, not the real operational root', async () => {
    expect(prodFreezeRoot).not.toBe(prodInstanceRoot());
    const liveRoot = prodInstanceRoot();
    const originalRead = fs.readFileSync;
    const read = spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (typeof path === 'string' && path.startsWith(`${liveRoot}/`)) throw new Error('operational-root access');
      return (originalRead as (...args: unknown[]) => unknown)(path, ...args);
    }) as typeof fs.readFileSync);
    const originalWrite = fs.writeFileSync;
    const write = spyOn(fs, 'writeFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (typeof path === 'string' && path.startsWith(`${liveRoot}/`)) throw new Error('operational-root access');
      return (originalWrite as (...args: unknown[]) => unknown)(path, ...args);
    }) as typeof fs.writeFileSync);
    const originalMkdir = fs.mkdirSync;
    const mkdir = spyOn(fs, 'mkdirSync').mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (typeof path === 'string' && (path === liveRoot || path.startsWith(`${liveRoot}/`))) throw new Error('operational-root access');
      return (originalMkdir as (...args: unknown[]) => unknown)(path, ...args);
    }) as typeof fs.mkdirSync);
    enableLandingFreeze({ reason: 'isolated', by: 'OP' }, prodFreezeRoot);
    const { manager, calls } = fakeManager();
    const sink = output();
    const root = mkdtempSync(join(tmpdir(), 'pr-cli-child-state-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    try {
      process.env.ELANOUS_STATE_DIR = root;
      const run = (cmd: string, args: readonly string[]) => cmd === 'git' && args.join(' ') === 'rev-parse HEAD'
        ? { ok: true, out: 'a'.repeat(40) } : baseLookupRun(cmd, args);
      expect(await runPrLand({}, { ...baseDeps, run, manager, out: sink.out })).toBe(0);
      expect(calls).toEqual(['find', 'upsert']);
      expect(sink.logs.join('\n')).toContain('동결 중 · isolated');
      expect(JSON.parse(readFileSync(join(root, 'landing-freeze-pending.json'), 'utf8'))).toMatchObject([{ prNumber: 42 }]);
      expect(() => readFileSync(join(liveRoot, 'landing-freeze.json'), 'utf8')).toThrow('operational-root access');
    } finally {
      mkdir.mockRestore();
      write.mockRestore();
      read.mockRestore();
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds, upserts ready with its resolved base and head, and squash merges in order', async () => {
    const { manager, calls, upserts } = fakeManager();
    const sink = output();
    const viewCalls: string[][] = [];
    const run = (cmd: string, args: readonly string[]) => {
      if (cmd === 'git' && args.join(' ') === 'remote') return { ok: true, out: 'origin\n' };
      if (cmd === 'git' && args.join(' ') === 'remote get-url origin') return { ok: true, out: 'https://github.com/example/repo.git\n' };
      if (cmd === 'git' && args.join(' ') === 'rev-parse --verify --quiet refs/remotes/origin/main') return { ok: true, out: 'remote-sha\n' };
      if (cmd === 'git' && args.join(' ') === 'rev-list --left-right --count main...refs/remotes/origin/main') return { ok: true, out: '0\t0\n' };
      if (cmd === 'gh' && args.join(' ').includes('pr view')) viewCalls.push([...args]);
      return { ok: false, out: '' };
    };
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({}, { ...baseDeps, run, manager, out: sink.out })).toBe(0);
      expect(calls).toEqual(['find', 'upsert', 'merge']);
      expect(viewCalls).toEqual([]);
      expect(upserts).toEqual([expect.objectContaining({
        branch: 'feat/land', worktreePath: process.cwd(), base: 'origin/main', draft: false,
      })]);
      expect(sink.logs).toEqual([
        '✓ branch: feat/land',
        '✓ base: origin/main',
        '✓ typecheck: scripts/ci-typecheck-changed.ts PASS — changed files have no new type errors.',
        '✓ isolation-gate: scripts/ci-isolation-hardcode-gate.ts PASS — no new homedir+.elanous hardcoding.',
        '✓ mock-module-restore-gate: scripts/ci-mock-module-restore-gate.ts PASS — no new un-restored mock.module.',
        '✓ model-hardcode-gate: scripts/ci-model-hardcode-gate.ts PASS — no new hardcoded model id.',
        '✓ daemon-port-gate: scripts/ci-daemon-port-gate.ts PASS — no new daemon port literals.',
        '[test-interference-gate] 해당 없음 — 변경 시험 파일 0개 (간섭 검사는 2개 이상 필요).',
        expect.stringMatching(/^\[land-global-checks\] 해당 없음 — 바뀐 파일 0개가 전역 검사 표\(\d+줄\)의 꼴에 안 걸린다\.$/),
        // ⭐ 안드로이드를 안 만진 착지라 게이트가 «깨어나지 않았다»고 «말한다».
        //    ⛔ 그 자리에 「PASS — 실제로 돌았다」가 오면 안 된다 — 안 돌았기 때문이다.
        '[android-gate] 해당 없음 — 변경 0개 중 apps/android/ 아래 파일 0개.',
        // 🍎 iOS 축도 같은 규율 — 안 만졌으면 «깨어나지 않았다»고 말한다.
        //    ⛔ 순서가 android → ios 다(pr-cli 의 호출 순서). 뒤집으면 이 시험이 잡는다.
        '[ios-gate] 해당 없음 — 변경 0개 중 apps/ios/ 아래 파일 0개.',
        '✓ find: ok EMPTY',
        '✓ upsert-ready: https://github.com/example/repo/pull/42 (새 PR)',
        '✓ merge: squash https://github.com/example/repo/pull/42 → origin/main',
        '⚠ local HEAD does not contain the landed result; create a new branch directly from remote origin with: git branch <new-branch> origin/main',
      ]);
      expect(logged).toHaveBeenCalledWith('pr.land', 'step', expect.objectContaining({ step: 'merge', ok: true }));
      const guidance = sink.logs.at(-1)!;
      expect(guidance).not.toContain('git fetch');
      expect(guidance).not.toContain('git pull');
      expect(guidance).not.toContain('git checkout');
    } finally {
      logged.mockRestore();
    }
  });

  for (const [label, gate, detail] of [
    ['fails', () => false, 'PWA 빌드 실패'],
    ['cannot measure', () => { throw new Error('apps/pwa/node_modules incomplete'); }, '못 쟀다'],
  ] as const) {
    it(`blocks the landing when the PWA build gate ${label} (GATE-PWA · fail-closed)`, async () => {
      const { manager, calls } = fakeManager();
      const sink = output();
      const run = (cmd: string, args: readonly string[]) => {
        if (cmd === 'git' && args.join(' ') === 'remote') return { ok: true, out: 'origin\n' };
        if (cmd === 'git' && args.join(' ') === 'remote get-url origin') return { ok: true, out: 'https://github.com/example/repo.git\n' };
        if (cmd === 'git' && args.join(' ') === 'rev-parse --verify --quiet refs/remotes/origin/main') return { ok: true, out: 'remote-sha\n' };
        if (cmd === 'git' && args.join(' ') === 'rev-list --left-right --count main...refs/remotes/origin/main') return { ok: true, out: '0\t0\n' };
        return { ok: false, out: '' };
      };
      expect(await runPrLand({}, { ...baseDeps, run, manager, out: sink.out, runPwaGate: gate })).toBe(1);
      expect(sink.errors.join('\n')).toContain('pwa-gate');
      expect(sink.errors.join('\n')).toContain(detail);
      expect(calls.some((c) => c.startsWith('merge'))).toBe(false);
    });
  }

  it('forwards current changed paths to the interference gate, preserves its warning, and continues through merge without writing the repository', async () => {
    const { manager, calls } = fakeManager();
    const sink = output();
    const received: string[][] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'pr-land-interference-'));
    try {
      const code = await runPrLand({ cwd }, {
        ...baseDeps,
        manager,
        out: sink.out,
        run: statusRun(' M test/one.test.ts\0 M test/two.test.ts\0'),
        runTestInterferenceGate: async (gateOut, changedFiles) => {
          received.push([...changedFiles]);
          gateOut.log('[test-interference-gate] 경고: 간섭 감지 — 차이 1.');
          return 0;
        },
      });

      expect(code).toBe(0);
      expect(calls).toEqual(['find', 'upsert', 'merge']);
      expect(received).toEqual([['test/one.test.ts', 'test/two.test.ts']]);
      expect(sink.logs).toContain('[test-interference-gate] 경고: 간섭 감지 — 차이 1.');
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('LAND-GLOBAL-CHECKS: forwards changed paths to the global-checks gate and blocks landing before find when a pulled test fails', async () => {
    const { manager, calls } = fakeManager();
    const sink = output();
    const received: string[][] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'pr-land-global-checks-'));
    try {
      const code = await runPrLand({ cwd }, {
        ...baseDeps,
        manager,
        out: sink.out,
        run: statusRun(' M apps/pwa/src/app/page.tsx\0 M release/next.md\0'),
        runTestInterferenceGate: async () => 0,
        runLandGlobalChecks: (_gateOut, changedFiles) => { received.push([...changedFiles]); return false; },
      });

      expect(code).toBe(1);
      expect(calls).toEqual([]);
      expect(received).toEqual([['apps/pwa/src/app/page.tsx', 'release/next.md']]);
      expect(sink.errors.join('\n')).toContain('✗ land-global-checks: scripts/land-global-checks.ts blocked pr land');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('LAND-GLOBAL-CHECKS: a passing pulled test lets landing continue and says which tests ran', async () => {
    const { manager, calls } = fakeManager();
    const sink = output();
    const code = await runPrLand({ dryRun: true }, {
      ...baseDeps,
      manager,
      out: sink.out,
      run: statusRun(' M docs/ops/machines.yaml\0'),
      runTestInterferenceGate: async () => 0,
      runLandGlobalChecks: () => true,
    });

    expect(code).toBe(0);
    expect(calls).toEqual(['find']);
    expect(sink.logs).toContain('✓ land-global-checks: scripts/land-global-checks.ts PASS — 끌려온 전역 시험 test/machines-ledger-data.test.ts 실패 0.');
  });

  it('LAND-GLOBAL-CHECKS: non-remote measurement error keeps its warning contract', async () => {
    const { manager, calls } = fakeManager();
    const sink = output();
    const code = await runPrLand({ dryRun: true }, {
      ...baseDeps, manager, out: sink.out,
      runTestInterferenceGate: async () => 0,
      runLandGlobalChecks: () => { throw new Error('runner unavailable'); },
    });
    expect(code).toBe(0);
    expect(calls).toEqual(['find']);
    expect(sink.errors.join('\n')).toContain('land-global-checks: 게이트가 «못 쟀다»');
  });

  it('records an unmeasured throwing interference gate under its own label and continues dry-run landing', async () => {
    const { manager, calls } = fakeManager();
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const code = await runPrLand({ dryRun: true }, {
        ...baseDeps,
        manager,
        out: sink.out,
        runTestInterferenceGate: async () => { throw new Error('판정기를 못 읽었다'); },
      });

      expect(code).toBe(0);
      expect(calls).toEqual(['find']);
      expect(sink.errors.join('\n')).toContain('test-interference-gate: 게이트가 «못 쟀다»');
      expect(sink.errors.join('\n')).toContain('판정기를 못 읽었다');
      expect(sink.errors.join('\n')).not.toContain('isolation-gate: 게이트가 «못 쟀다»');
      expect(logged).toHaveBeenCalledWith('pr.land', 'step', {
        step: 'test-interference-gate', ok: true, measured: false,
      });
    } finally {
      logged.mockRestore();
    }
  });

  it('blocks landing when the injected mock-module restoration gate finds a violation before find', async () => {
    const { manager, calls } = fakeManager();
    const sink = output();
    const code = await runPrLand({}, {
      ...baseDeps,
      manager,
      out: sink.out,
      runMockModuleRestoreGate: gateOut => {
        gateOut.error('[mock-module-restore-gate] FAIL — test/new-leak.test.ts');
        return false;
      },
    });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(sink.errors.join('\n')).toContain('test/new-leak.test.ts');
    expect(sink.errors.join('\n')).toContain('blocked pr land');
  });

  // ⛔ 게이트가 «던지면» 그 경고는 «그 게이트 이름»을 대야 한다.
  //   📏 실측(2026-09-05): mock-module 게이트가 던져도 「isolation-gate」라고 말했다 —
  //     읽는 사람이 «멀쩡한 게이트»를 고치러 간다.
  it('names the throwing gate itself, not isolation, when the mock-module gate cannot measure', async () => {
    const { manager } = fakeManager();
    const sink = output();
    const code = await runPrLand({ dryRun: true }, {
      ...baseDeps,
      manager,
      out: sink.out,
      runMockModuleRestoreGate: () => { throw new Error('보모듈을 못 읽었다'); },
    });
    const errors = sink.errors.join('\n');

    // 못 쟀을 뿐이므로 착지는 막지 않는다(기존 정책) — 다만 «이름»은 맞아야 한다.
    expect(code).toBe(0);
    expect(errors).toContain('mock-module-restore-gate: 게이트가 «못 쟀다»');
    expect(errors).toContain('보모듈을 못 읽었다');
    expect(errors).not.toContain('isolation-gate: 게이트가 «못 쟀다»');
  });

  // ⛔ typecheck 게이트는 불리언만 돌려주므로 `pr land` 는 «왜» 막혔는지 모른다 — 단정하지 않는다.
  it('does not assert a cause it cannot know when the typecheck gate blocks', async () => {
    const { manager, calls } = fakeManager();
    const sink = output();
    const code = await runPrLand({}, {
      ...baseDeps,
      manager,
      out: sink.out,
      runTypecheckGate: gateOut => {
        gateOut.error('[tsc-gate] ⛔ 변경 파일 수집 실패:');
        return false;
      },
    });
    const errors = sink.errors.join('\n');

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    // ⭐ «새 문면 자체»를 문다 — 옛 문면의 부재만 보면 다른 지어낸 사유로 바꿔도 통과한다(무인 리뷰 지적).
    expect(errors).toContain('✗ typecheck: scripts/ci-typecheck-changed.ts blocked pr land.');
    // ⛔ 그리고 «어떤» 사유도 단정하지 않는다 — `because …` 절이 붙으면 그것이 곧 단정이다.
    const typecheckLine = sink.errors.find((line) => line.includes('✗ typecheck:'))!;
    expect(typecheckLine).not.toMatch(/because|때문|사유는/);
    // 게이트 자신이 낸 출력은 그대로 흐른다.
    expect(errors).toContain('[tsc-gate] ⛔ 변경 파일 수집 실패:');
  });

  it('warns once for a deletion-dominant file during dry-run and continues the landing plan', async () => {
    const { manager, calls, upserts } = fakeManager();
    const sink = output();
    expect(await runPrLand({ dryRun: true }, {
      ...baseDeps,
      run: numstatRun('3\t40\tsrc/self-implement/goal-author.ts\n'),
      manager,
      out: sink.out,
    })).toBe(0);
    expect(calls).toEqual(['find']);
    expect(upserts).toEqual([]);
    expect(sink.errors).toEqual([
      '⚠ deletion-dominant-files: 삭제가 추가보다 많은 파일 1개 — src/self-implement/goal-author.ts (+3/-40).',
    ]);
    expect(sink.logs.at(-1)).toBe('[dry-run] 머리 고정 없는 일반 착지: PR을 생성하고 ready 상태를 보장한 뒤 squash merge 합니다.');
    expect(sink.logs.join('\n')).not.toContain('local HEAD does not contain the landed result');
  });

  it('names sibling PR numbers and branches without changing the exit code', async () => {
    const { manager, calls } = fakeManager();
    const withSiblings = output();
    const withoutSiblings = output();
    const siblingCode = await runPrLand({}, {
      ...baseDeps,
      currentBranch: () => 'self-impl/x-1111aaaa',
      listOpenPrs: () => [
        { number: 101, headRefName: 'self-impl/x-2222bbbb' },
        { number: 102, headRefName: 'self-impl/x-3333cccc' },
        { number: 103, headRefName: 'self-impl/y-3333cccc' },
        { number: 104, headRefName: 'self-impl/x-1111aaaa' },
      ],
      manager,
      out: withSiblings.out,
    });
    const noneCode = await runPrLand({}, {
      ...baseDeps,
      currentBranch: () => 'self-impl/x-1111aaaa',
      listOpenPrs: () => [
        { number: 103, headRefName: 'self-impl/y-3333cccc' },
        { number: 104, headRefName: 'self-impl/x-1111aaaa' },
      ],
      manager,
      out: withoutSiblings.out,
    });
    expect(siblingCode).toBe(0);
    expect(noneCode).toBe(0);
    expect(siblingCode).toBe(noneCode);
    expect(calls).toEqual(['find', 'upsert', 'merge', 'find', 'upsert', 'merge']);
    const line = withSiblings.logs.find((message) => message.includes('sibling-prs'));
    expect(line).toBeDefined();
    expect(line).toContain('#101');
    expect(line).toContain('#102');
    expect(line).toContain('self-impl/x-2222bbbb');
    expect(line).toContain('self-impl/x-3333cccc');
    expect(line).toContain('이어 붙일지 이것을 살릴지 고르십시오');
    expect(line).not.toContain('#103');
    expect(line).not.toContain('#104');
    expect(withoutSiblings.logs.join('\n')).not.toContain('sibling-prs');
  });

  it('does not emit a sibling advisory when no other open PR shares the slug', async () => {
    const { manager, calls } = fakeManager();
    const sink = output();
    expect(await runPrLand({}, {
      ...baseDeps,
      currentBranch: () => 'self-impl/x-1111aaaa',
      listOpenPrs: () => [
        { number: 103, headRefName: 'self-impl/y-3333cccc' },
        { number: 104, headRefName: 'self-impl/x-1111aaaa' },
      ],
      manager,
      out: sink.out,
    })).toBe(0);
    expect(calls).toEqual(['find', 'upsert', 'merge']);
    expect(sink.logs.join('\n')).not.toContain('sibling-prs');
  });

  it('emits the sibling advisory during dry-run without landing', async () => {
    const { manager, calls, upserts } = fakeManager();
    const sink = output();
    expect(await runPrLand({ dryRun: true }, {
      ...baseDeps,
      currentBranch: () => 'self-impl/x-1111aaaa',
      listOpenPrs: () => [
        { number: 101, headRefName: 'self-impl/x-2222bbbb' },
        { number: 102, headRefName: 'self-impl/x-3333cccc' },
      ],
      manager,
      out: sink.out,
    })).toBe(0);
    expect(calls).toEqual(['find']);
    expect(upserts).toEqual([]);
    const line = sink.logs.find((message) => message.includes('sibling-prs'));
    expect(line).toContain('#101');
    expect(line).toContain('#102');
    expect(line).toContain('이어 붙일지 이것을 살릴지 고르십시오');
    expect(sink.logs.at(-1)).toBe('[dry-run] 머리 고정 없는 일반 착지: PR을 생성하고 ready 상태를 보장한 뒤 squash merge 합니다.');
  });

  it('continues landing without a sibling advisory when open-PR lookup fails', async () => {
    const recorded: unknown[] = [];
    const logged = spyOn(debug, 'log').mockImplementation((_category, _event, data) => { recorded.push(data); });
    try {
      const { manager, calls } = fakeManager();
      const sink = output();
      expect(await runPrLand({}, {
        ...baseDeps,
        currentBranch: () => 'self-impl/x-1111aaaa',
        listOpenPrs: () => null,
        manager,
        out: sink.out,
      })).toBe(0);
      expect(calls).toEqual(['find', 'upsert', 'merge']);
      expect(sink.logs.join('\n')).not.toContain('sibling-prs');
      expect(recorded).toContainEqual(expect.objectContaining({
        step: 'sibling-prs',
        ok: false,
        outcome: 'lookup-failed',
      }));
    } finally {
      logged.mockRestore();
    }
  });

  it('uses the gh-backed open-PR lookup when listOpenPrs is not injected', async () => {
    const { manager } = fakeManager();
    const sink = output();
    const run = (cmd: string, args: readonly string[]) => {
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list' && args.includes('open')) {
        return {
          ok: true,
          out: JSON.stringify([{ number: 201, headRefName: 'self-impl/x-2222bbbb' }]),
        };
      }
      return baseLookupRun(cmd, args);
    };
    expect(await runPrLand({}, {
      ...baseDeps,
      currentBranch: () => 'self-impl/x-1111aaaa',
      run,
      manager,
      out: sink.out,
    })).toBe(0);
    const line = sink.logs.find((message) => message.includes('sibling-prs'));
    expect(line).toContain('#201');
    expect(line).toContain('self-impl/x-2222bbbb');
  });

  it('public leak warning reads the main baseline and PR tree in that order, even when the PR updated its baseline', async () => {
    for (const [mainCount, prCount] of [[2, 0], [0, 2]] as const) {
      const cwd = mkdtempSync(join(tmpdir(), 'pr-land-leak-direction-'));
      try {
        git(cwd, 'init', '-q', '-b', 'main');
        git(cwd, 'config', 'user.email', 'test@example.com');
        git(cwd, 'config', 'user.name', 'Test');
        git(cwd, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
        mkdirSync(join(cwd, 'scripts'));
        mkdirSync(join(cwd, 'release'));
        writeFileSync(join(cwd, 'release/public-export.yaml'), 'include: ["scripts/x.sh"]\nexclude: []\nreplace: {}\n');
        const baseline = (count: number) => renderBaseline(new Map(count ? [['ceo-mark\tscripts/x.sh', count]] : []));
        writeFileSync(join(cwd, 'scripts/x.sh'), Array.from({ length: mainCount }, () => 'echo "\u{1F451}"').join('\n') + '\n');
        writeFileSync(join(cwd, 'scripts/public-leak-baseline.txt'), baseline(mainCount));
        git(cwd, 'add', '.');
        git(cwd, 'commit', '-qm', 'main baseline');
        git(cwd, 'update-ref', 'refs/remotes/origin/main', git(cwd, 'rev-parse', 'HEAD'));
        git(cwd, 'checkout', '-qb', 'feat/land');
        writeFileSync(join(cwd, 'scripts/x.sh'), Array.from({ length: prCount }, () => 'echo "\u{1F451}"').join('\n') + '\n');
        writeFileSync(join(cwd, 'scripts/public-leak-baseline.txt'), baseline(prCount));
        const sink = output();
        const run: CmdRunner = (cmd, args, options) => {
          const result = spawnSync(cmd, args, { ...options, encoding: 'utf8' });
          return { ok: result.status === 0, out: result.stdout ?? '' };
        };
        expect(git(cwd, 'show', 'main:scripts/public-leak-baseline.txt')).toContain(`# total=${mainCount}`);
        expect(readFileSync(join(cwd, 'scripts/public-leak-baseline.txt'), 'utf8')).toContain(`# total=${prCount}`);
        expect(await runPrLand({ cwd, dryRun: true }, {
          ...baseDeps, runPublicLeakGate: undefined, run, manager: fakeManager().manager, out: sink.out,
        })).toBe(0);
        const lines = sink.logs.filter((line) => line.includes('public-leak-gate') || line.includes('scripts/x.sh  ceo-mark'));
        if (mainCount > prCount) {
          expect(lines).toContain('✓ public-leak-gate(경고 전용): 공개 유출이 줄었다 · 기준선 --update 권장 — scripts/x.sh  ceo-mark  2 → 0');
          expect(lines.filter((line) => line.startsWith('⚠ public-leak-gate'))).toHaveLength(0);
        } else {
          expect(lines).toContain('⚠ public-leak-gate(경고 전용 · 착지는 막지 않는다): 공개 유출이 늘었다 —');
          expect(lines).toContain('   scripts/x.sh  ceo-mark  0 → 2');
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  // 🆕 2026-09-24 — 공개 유출 래칫은 «경고 전용»: 늘었어도 막지 않고 늘어난 줄을 보여 준다 · 못 쟀으면 그렇게 말한다.
  it('public leak warning: grew → warns with the grown lines; pass → one ok line; throws → «못 쟀다»; no files → silent', () => {
    const logs: string[] = [];
    const out = { log: (m: string) => logs.push(m), error: (m: string) => logs.push(`ERR ${m}`) };
    publicLeakWarning(['src/a.ts'], (_f, o) => { o.error('  src/a.ts  ceo-mark  0 → 1'); return 1; }, out);
    expect(logs.join('\n')).toContain('경고 전용 · 착지는 막지 않는다');
    expect(logs.join('\n')).toContain('src/a.ts  ceo-mark  0 → 1');
    expect(logs.some((l) => l.startsWith('ERR'))).toBe(false);
    logs.length = 0;
    publicLeakWarning(['src/a.ts'], () => 0, out);
    expect(logs).toEqual(['✓ public-leak-gate(경고 전용): 공개 유출이 늘지 않았다.']);
    logs.length = 0;
    publicLeakWarning(['src/a.ts'], () => { throw new Error('boom'); }, out);
    expect(logs[0]).toContain('못 쟀다');
    logs.length = 0;
    publicLeakWarning([], () => 1, out);
    expect(logs).toEqual([]);
  });

  // 🆕 2026-09-26 — 공개 문서 ↔ 실제 CLI 대조도 «경고 전용»이고, 바뀐 «공개 문서»만 본다(전수는 38초라 착지마다 안 돈다).
  it('docs-cli warning: only changed public docs are checked; mismatch warns with file:line; none → silent; throws → «못 쟀다»', () => {
    const exists = (f: string) => f !== 'release/public/docs/gone.md';
    expect(publicDocPaths(['src/a.ts', 'README.md', 'release/public/docs/install.md', 'release/public/docs/gone.md', 'docs/x.md', 'README.md'], exists))
      .toEqual(['README.md', 'release/public/docs/install.md']);
    expect(publicDocPaths(undefined, exists)).toEqual([]);

    const logs: string[] = [];
    const out = { log: (m: string) => logs.push(m) };
    const seen: string[][] = [];
    docsCliWarning(['README.md'], (files) => {
      seen.push([...files]);
      return [{ kind: 'unknown-flag', ref: { file: 'README.md', line: 7, text: 'elanous doctor --nope', cmd: 'doctor', flags: ['--nope'] }, detail: '--nope (elanous doctor)' }];
    }, out);
    expect(seen).toEqual([['README.md']]);
    expect(logs.join('\n')).toContain('경고 전용 · 착지는 막지 않는다');
    expect(logs.join('\n')).toContain('unknown-flag  README.md:7  --nope (elanous doctor)');
    logs.length = 0;
    docsCliWarning(['README.md'], () => [], out);
    expect(logs).toEqual(['✓ docs-cli-check(경고 전용): 바뀐 공개 문서 1개의 elanous 호출이 실제 CLI 와 맞는다.']);
    logs.length = 0;
    docsCliWarning(['README.md'], () => { throw new Error('boom'); }, out);
    expect(logs[0]).toContain('못 쟀다');
    logs.length = 0;
    let called = false;
    docsCliWarning([], () => { called = true; return []; }, out);
    expect(called).toBe(false);
    expect(logs).toEqual([]);
  });

  // LAND-BASE-MAIN-GUARD 뒤: 기본 가지가 아닌 재사용 PR base 는 «명시 --base» 일 때만 착지한다.
  it('uses origin and preserves a slash-containing reused PR base when no remote has that name', async () => {
    const { manager } = fakeManager({
      upsertPr: () => ({ ok: true, url: 'https://github.com/example/repo/pull/42', reused: true }),
    });
    const sink = output();
    const viewCalls: Array<{ cmd: string; args: readonly string[] }> = [];
    const run = (cmd: string, args: readonly string[]) => {
      const command = args.join(' ');
      if (cmd === 'gh' && command.includes('pr view')) viewCalls.push({ cmd, args });
      if (cmd === 'git' && command === 'remote') return { ok: true, out: 'origin\n' };
      if (cmd === 'git' && command === 'remote get-url origin') return { ok: true, out: 'https://github.com/example/repo.git\n' };
      return cmd === 'gh' && command.includes('pr view')
        ? { ok: true, out: 'release/2026' }
        : { ok: false, out: '' };
    };

    expect(await runPrLand({ base: 'release/2026' }, { ...baseDeps, run, manager, out: sink.out })).toBe(0);
    expect(sink.logs).toContain('✓ merge: squash https://github.com/example/repo/pull/42 → release/2026');
    expect(sink.logs.at(-1)).toBe('⚠ local HEAD does not contain the landed result; create a new branch directly from remote origin with: git branch <new-branch> origin/release/2026');
    expect(sink.logs.join('\n')).not.toContain('git fetch');
    expect(sink.logs.join('\n')).not.toContain('git pull');
    expect(sink.logs.join('\n')).not.toContain('git checkout');
    // BENCH-ISOLATED-ARMS: the reused PR's labels are read once before the merge (bench-guard), then the base once after it.
    expect(viewCalls).toEqual([{
      cmd: 'gh',
      args: ['pr', 'view', 'https://github.com/example/repo/pull/42', '--json', 'labels', '--jq', '.labels[].name'],
    }, {
      cmd: 'gh',
      args: ['pr', 'view', 'https://github.com/example/repo/pull/42', '--json', 'baseRefName', '--jq', '.baseRefName'],
    }]);
  });

  it('marks a reused PR base as unavailable without changing successful merge status when its lookup fails', async () => {
    const { manager } = fakeManager({
      upsertPr: () => ({ ok: true, url: 'https://github.com/example/repo/pull/42', reused: true }),
    });
    const sink = output();

    expect(await runPrLand({}, {
      ...baseDeps,
      run: () => ({ ok: false, out: '' }),
      manager,
      out: sink.out,
    })).toBe(0);
    expect(sink.logs).toContain('✓ merge: squash https://github.com/example/repo/pull/42 → <base unavailable>');
    expect(sink.logs.at(-1)).toBe('⚠ local HEAD does not contain the landed result; the landed base is unavailable, so no branch command can be provided.');
    expect(sink.logs.join('\n')).not.toContain('git branch');
  });

  // GIT-S14 — 미완료(OPEN) ⊕ mergeable=UNKNOWN 이면 기다렸다 다시 병합한다(표본 셋 모두 재시도에 병합).
  it('retries the merge while GitHub still reports mergeable=UNKNOWN and lands on the retry', async () => {
    const outcomes: MergePrOutcome[] = [{ ok: false, kind: 'not-merged', state: 'OPEN' }, { ok: true, kind: 'merge-exit-0' }];
    const { manager } = fakeManager({ mergePrOutcome: () => outcomes.shift()! });
    const sink = output();
    const slept: number[] = [];
    const run: CmdRunner = (cmd, args) => (cmd === 'gh' && args.includes('mergeable') ? { ok: true, out: 'UNKNOWN\n' } : { ok: false, out: '' });
    expect(await runPrLand({}, { ...baseDeps, run, manager, out: sink.out, sleep: async (ms) => { slept.push(ms); } })).toBe(0);
    expect(slept).toEqual([5_000]);
    expect(sink.logs.join('\n')).toContain('mergeable=UNKNOWN');
    expect(sink.logs.join('\n')).toContain('✓ merge: squash');
    expect(sink.errors.filter((line) => line.startsWith('✗ merge'))).toEqual([]);
  });

  it('gives up after the retry budget when mergeable stays UNKNOWN, and never retries other mergeable values', async () => {
    const unknown = fakeManager({ mergePrOutcome: () => ({ ok: false, kind: 'not-merged', state: 'OPEN' }) });
    const slept: number[] = [];
    const sink = output();
    const runUnknown: CmdRunner = (cmd, args) => (cmd === 'gh' && args.includes('mergeable') ? { ok: true, out: 'UNKNOWN' } : { ok: false, out: '' });
    expect(await runPrLand({}, { ...baseDeps, run: runUnknown, manager: unknown.manager, out: sink.out, sleep: async (ms) => { slept.push(ms); } })).toBe(1);
    expect(slept).toHaveLength(3);
    expect(sink.errors.filter((line) => line.startsWith('✗ merge'))).toEqual(['✗ merge: squash merge 미완료 (state: OPEN)']);

    const conflicting = fakeManager({ mergePrOutcome: () => ({ ok: false, kind: 'not-merged', state: 'OPEN' }) });
    const noSleep: number[] = [];
    const runConflicting: CmdRunner = (cmd, args) => (cmd === 'gh' && args.includes('mergeable') ? { ok: true, out: 'CONFLICTING' } : { ok: false, out: '' });
    expect(await runPrLand({}, { ...baseDeps, run: runConflicting, manager: conflicting.manager, out: output().out, sleep: async (ms) => { noSleep.push(ms); } })).toBe(1);
    expect(noSleep).toEqual([]);
  });

  // GIT-S76 — 미완료(OPEN)이면 GitHub 의 병합 가능 상태를 실패 줄에 싣고, 충돌이면 푸는 길을 한 줄 더 낸다.
  it('names the GitHub merge state on an OPEN failure and gives the rebase path only for a conflict', async () => {
    const conflict = fakeManager({ mergePrOutcome: () => ({ ok: false, kind: 'not-merged', state: 'OPEN' }) });
    const sink = output();
    const run: CmdRunner = (cmd, args) => (cmd === 'gh' && args.includes('mergeable,mergeStateStatus')
      ? { ok: true, out: 'CONFLICTING DIRTY\n' }
      : cmd === 'gh' && args.includes('mergeable') ? { ok: true, out: 'CONFLICTING' } : { ok: false, out: '' });
    expect(await runPrLand({}, { ...baseDeps, run, manager: conflict.manager, out: sink.out, sleep: async () => {} })).toBe(1);
    const mergeLines = sink.errors.filter((line) => line.startsWith('✗ merge') || line.startsWith('  ↳'));
    expect(mergeLines[0]).toBe('✗ merge: squash merge 미완료 (state: OPEN · mergeable=CONFLICTING · mergeState=DIRTY)');
    expect(mergeLines[1]).toContain('git rebase origin/');

    const blocked = fakeManager({ mergePrOutcome: () => ({ ok: false, kind: 'not-merged', state: 'OPEN' }) });
    const blockedSink = output();
    const runBlocked: CmdRunner = (cmd, args) => (cmd === 'gh' && args.includes('mergeable,mergeStateStatus')
      ? { ok: true, out: 'MERGEABLE BLOCKED' }
      : cmd === 'gh' && args.includes('mergeable') ? { ok: true, out: 'MERGEABLE' } : { ok: false, out: '' });
    expect(await runPrLand({}, { ...baseDeps, run: runBlocked, manager: blocked.manager, out: blockedSink.out, sleep: async () => {} })).toBe(1);
    expect(blockedSink.errors.filter((line) => line.startsWith('✗ merge') || line.startsWith('  ↳'))).toEqual(['✗ merge: squash merge 미완료 (state: OPEN · mergeable=MERGEABLE · mergeState=BLOCKED)']);
  });

  it('records distinct merge outcomes for exit 0, confirmed MERGED after a nonzero exit, and an unmerged PR', async () => {
    const cases: Array<{ outcome: MergePrOutcome; code: number; errors: string[] }> = [
      { outcome: { ok: true, kind: 'merge-exit-0' }, code: 0, errors: [] },
      { outcome: { ok: true, kind: 'merged-after-nonzero' }, code: 0, errors: [] },
      { outcome: { ok: false, kind: 'not-merged', state: 'OPEN' }, code: 1, errors: ['✗ merge: squash merge 미완료 (state: OPEN)'] },
    ];
    const recorded: unknown[] = [];
    const logged = spyOn(debug, 'log').mockImplementation((_category, _event, data) => { recorded.push(data); });
    try {
      for (const item of cases) {
        const { manager } = fakeManager({ mergePrOutcome: () => item.outcome });
        const sink = output();
        expect(await runPrLand({}, { ...baseDeps, manager, out: sink.out })).toBe(item.code);
        expect(sink.errors).toEqual(item.errors);
        if (!item.outcome.ok) {
          expect(sink.logs.join('\n')).not.toContain('local HEAD does not contain the landed result');
        }
      }
      const mergeResults = recorded
        .filter((data): data is { step: string; result: string } => typeof data === 'object' && data !== null && 'step' in data && (data as { step: string }).step === 'merge')
        .map((data) => data.result);
      expect(mergeResults).toEqual(['merge-exit-0', 'merged-after-nonzero', 'not-merged']);
    } finally {
      logged.mockRestore();
    }
  });

  it('reports remote branch deletion failure without failing a confirmed merge', async () => {
    const { manager } = fakeManager({
      mergePrOutcome: () => ({
        ok: true,
        kind: 'merge-exit-0',
        remoteBranchDeletion: { detail: 'forbidden' },
      }),
    });
    const sink = output();
    const recorded: unknown[] = [];
    const logged = spyOn(debug, 'log').mockImplementation((_category, _event, data) => { recorded.push(data); });
    try {
      expect(await runPrLand({}, { ...baseDeps, manager, out: sink.out })).toBe(0);
      expect(sink.errors).toEqual([]);
      expect(sink.logs).toContain('⚠ remote branch deletion: forbidden');
      expect(recorded).toContainEqual(expect.objectContaining({ step: 'merge', ok: true, remoteBranchDeletion: 'forbidden' }));
    } finally {
      logged.mockRestore();
    }
  });

  it('uses the retry gateway with preserved arguments, and keeps failed, empty, and populated branch results distinct', async () => {
    const failedResult = { status: 128, stdout: 'must-not-be-used\n', stderr: 'fatal: index.lock busy' } as const;
    const results = [
      ...Array.from({ length: 6 }, () => failedResult),
      { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: 'feat/from-gateway\n', stderr: '' },
    ] as const;
    const gatewayCalls: Array<{ cwd: string; args: string[]; options: SpawnSyncOptions }> = [];
    let next = 0;
    setGitCommandRunnerForTesting((cwd, args, options) => {
      gatewayCalls.push({ cwd, args: [...args], options });
      return results[next++]!;
    });
    try {
      const failed = output();
      const empty = output();
      const populated = output();
      const failedManager = fakeManager();
      const emptyManager = fakeManager();
      const populatedManager = fakeManager();

      expect(await runPrLand({}, { resolveBase: () => 'origin/main', manager: failedManager.manager, out: failed.out })).toBe(1);
      expect(await runPrLand({}, { resolveBase: () => 'origin/main', manager: emptyManager.manager, out: empty.out })).toBe(1);
      expect(await runPrLand({ dryRun: true }, {
        resolveBase: () => 'origin/main',
        manager: populatedManager.manager,
        out: populated.out,
        run: baseLookupRun,
        listUnfinishedRuns: () => [],
        queryRunningRuns: () => runningRuns([]),
        runTypecheckGate: () => true,
        runIsolationGate: () => true,
        runMockModuleRestoreGate: () => true,
      })).toBe(0);

      expect(failedManager.calls).toEqual([]);
      expect(emptyManager.calls).toEqual([]);
      expect(populatedManager.calls).toEqual(['find']);
      expect(failed.errors).toEqual(['✗ branch: 현재 브랜치를 해석하지 못했습니다.']);
      expect(empty.errors).toEqual(['✗ branch: 현재 브랜치를 해석하지 못했습니다.']);
      expect(populated.logs).toContain('✓ branch: feat/from-gateway');
      expect(gatewayCalls).toEqual(results.map(() => ({
        cwd: process.cwd(),
        args: ['branch', '--show-current'],
        options: { encoding: 'utf-8' },
      })));
    } finally {
      setGitCommandRunnerForTesting(undefined);
    }
  });

  // ⛔ 📏 2026-08-27 🅣 (`GIT-T70`) — 이 경로에 시험이 «0건»이었고, 그래서 실제 사고가 났다:
  //   `--exclude-active-run-files` 가 골 문서가 «아니라» 내 소스를 빼서 시험만 착지하고 main 이 빨강이 됐다.
  //   도구는 ⚠ 경고를 냈지만 «멈추지 않았고», 나는 그 줄을 착지 «뒤»에 읽었다.
  //   ⇒ 🔑 처방은 「경고를 더 다는 것」이 아니라 ***경고를 «관문»으로 올리는 것***이다.
  //   ⚠️ 그러나 «정상 용도»(골 문서만 빠지는 경우)는 막으면 안 된다 — 아래 셋째 시험이 그 과탐을 문다.
  describe('--exclude-active-run-files 가 골 문서가 «아닌» 파일을 뺄 때', () => {
    const stagedStatus = (paths: readonly string[]) => paths.map((path) => `M  ${path}`).join('\0') + '\0';
    const landRun = (paths: readonly string[]) => (cmd: string, args: readonly string[]) => {
      if (cmd === 'git' && args[0] === 'status') return { ok: true, out: stagedStatus(paths) };
      return baseLookupRun(cmd, args);
    };

    it('소스가 빠지면 아무것도 커밋하지 않고 exit 1 이다', async () => {
      const { manager, calls } = fakeManager();
      const sink = output();
      const code = await runPrLand({ excludeActiveRunFiles: true }, {
        ...baseDeps,
        manager,
        out: sink.out,
        run: landRun(['src/self-implement/gate-baseline.ts']),
        listUnfinishedRuns: () => [unfinishedRun('run-abc', ['src/self-implement/gate-baseline.ts'])],
      });
      expect(code).toBe(1);
      // ⭐ PR 을 «만들지도 병합하지도» 않는다 — 경고와 다른 점이 바로 이것이다.
      //   ⚠️ find(읽기 전용 조회)는 이 지점보다 «앞»에서 이미 일어난다. 그것은 아무것도 안 바꾼다.
      //   ⇒ 그러니 단정은 「호출이 하나도 없다」가 아니라 ***「쓰는 호출이 없다」***여야 한다.
      expect(calls).not.toContain('upsert');
      expect(calls).not.toContain('merge');
    });

    it('멈추는 문면이 빠지는 파일 이름과 뚫는 플래그를 «둘 다» 말한다', async () => {
      const { manager } = fakeManager();
      const sink = output();
      await runPrLand({ excludeActiveRunFiles: true }, {
        ...baseDeps,
        manager,
        out: sink.out,
        run: landRun(['src/self-implement/gate-baseline.ts']),
        listUnfinishedRuns: () => [unfinishedRun('run-abc', ['src/self-implement/gate-baseline.ts'])],
      });
      const stop = sink.errors.find((line) => line.includes('✗ active-run-files'));
      expect(stop).toBeDefined();
      // 사람이 산출«만» 보고 다음 수를 알 수 있어야 한다.
      expect(stop).toContain('src/self-implement/gate-baseline.ts');
      expect(stop).toContain('--exclude-active-run-sources');
    });

    it('--exclude-active-run-sources 를 주면 뚫린다', async () => {
      const { manager, calls } = fakeManager();
      const sink = output();
      const code = await runPrLand({ excludeActiveRunFiles: true, excludeActiveRunSources: true }, {
        ...baseDeps,
        manager,
        out: sink.out,
        run: landRun(['src/self-implement/gate-baseline.ts']),
        listUnfinishedRuns: () => [unfinishedRun('run-abc', ['src/self-implement/gate-baseline.ts'])],
      });
      expect(code).toBe(0);
      expect(calls).toContain('upsert');
    });

    // ⛔ 과탐 반증 — 골 문서만 빠지는 것은 이 플래그의 «정상 용도»다. 막으면 안 된다.
    it('골 문서만 빠지면 멈추지 «않는다»', async () => {
      const { manager, calls } = fakeManager();
      const sink = output();
      const goalDoc = 'docs/goals/GOAL-src-cli-pr-cli-ts-2026-08-27.md';
      const code = await runPrLand({ excludeActiveRunFiles: true }, {
        ...baseDeps,
        manager,
        out: sink.out,
        run: landRun([goalDoc]),
        listUnfinishedRuns: () => [unfinishedRun('run-abc', [], goalDoc)],
      });
      expect(code).toBe(0);
      expect(calls).toContain('upsert');
      expect(sink.errors.find((line) => line.includes('✗ active-run-files'))).toBeUndefined();
    });
  });

  const overlapLog = [
    'commit aaa111bbb222ccc333ddd444eee555fff666aaa',
    'src/land.ts',
    '',
    'commit bbb222ccc333ddd444eee555fff666aaa111bbb',
    'src/land.ts',
  ].join('\n');
  const otherLog = [
    'commit aaa111bbb222ccc333ddd444eee555fff666aaa',
    'docs/other.md',
  ].join('\n');

  function landRun(
    logOut: string,
    currentFiles = 'src/land.ts\n',
    statusEntries = ' M src/land.ts\0',
    opts: { logOk?: boolean; email?: string } = {},
  ) {
    const commands: Array<{ cmd: string; args: readonly string[] }> = [];
    const run = (cmd: string, args: readonly string[]) => {
      commands.push({ cmd, args });
      const command = args.join(' ');
      if (cmd === 'git' && command === statusArgs) return { ok: true, out: statusEntries };
      if (cmd === 'git' && command === numstatArgs) return { ok: true, out: '' };
      if (cmd === 'git' && args[0] === 'config' && args[1] === 'user.email') {
        if (opts.email !== undefined) return { ok: true, out: opts.email };
        return baseLookupRun(cmd, args);
      }
      if (cmd === 'git' && args[0] === 'log' && args.includes('--name-only')) {
        return { ok: opts.logOk ?? true, out: logOut };
      }
      if (cmd === 'git' && args[0] === 'diff' && args.includes('--name-only')) return { ok: true, out: currentFiles };
      return baseLookupRun(cmd, args);
    };
    return { run, commands };
  }

  describe('TA-LAND-OVERLAP — pinned non-interactive overlap needs verified evidence', () => {
    const HEAD = 'a'.repeat(40);
    const TIP = 'b'.repeat(40);
    const URL = 'https://github.com/example/repo/pull/51';
    const LANDINGS = ['aaa111bbb222ccc333ddd444eee555fff666aaa', 'bbb222ccc333ddd444eee555fff666aaa111bbb'];
    const GATE_BASE = 'c'.repeat(40);
    const WINDOW_A = 'e'.repeat(40);
    const WINDOW_B = 'f'.repeat(40);
    const FORK = '9'.repeat(40);
    type WindowOpts = { gateBaseInHead?: boolean; gateBaseInTip?: boolean; tipLocal?: boolean; windowLog?: string; windowLogOk?: boolean };
    function pinnedRun(opts: { ancestor?: boolean; landingAncestors?: readonly string[]; window?: WindowOpts; baseRefName?: () => string } = {}) {
      const inner = landRun(overlapLog, 'src/land.ts\n', '');
      const commands: Array<{ cmd: string; args: readonly string[] }> = [];
      const run = (cmd: string, args: readonly string[]) => {
        commands.push({ cmd, args });
        const command = args.join(' ');
        const override = opts.baseRefName;
        if (override && cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('baseRefName,url')) {
          return { ok: true, out: JSON.stringify({ baseRefName: override(), url: URL }) };
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('baseRefName,url')) {
          return { ok: true, out: JSON.stringify({ baseRefName: 'main', url: URL }) };
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid,headRefName,baseRefName,state,isDraft,url')) {
          return { ok: true, out: JSON.stringify({ headRefOid: HEAD, headRefName: 'feat/land', baseRefName: 'main', state: 'OPEN', isDraft: false, url: URL }) };
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid,state,isDraft,baseRefName')) {
          return { ok: true, out: JSON.stringify({ headRefOid: HEAD, state: 'OPEN', isDraft: false, baseRefName: 'main' }) };
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid,state,isDraft')) {
          return { ok: true, out: JSON.stringify({ headRefOid: HEAD, state: 'OPEN', isDraft: false }) };
        }
        if (cmd === 'git' && command === 'rev-parse HEAD') return { ok: true, out: `${HEAD}\n` };
        if (cmd === 'git' && command === 'status --porcelain') return { ok: true, out: '' };
        if (cmd === 'git' && command === 'fetch --quiet origin main') return { ok: true, out: '' };
        if (cmd === 'git' && command === 'rev-parse --verify origin/main') return { ok: true, out: `${TIP}\n` };
        if (cmd === 'git' && command === 'rev-parse --verify refs/remotes/origin/main') return { ok: true, out: `${TIP}\n` };
        if (cmd === 'git' && command === 'ls-remote origin refs/heads/main') return { ok: true, out: `${TIP}\trefs/heads/main\n` };
        if (cmd === 'git' && command === `merge-base --is-ancestor ${TIP} ${HEAD}`) return { ok: opts.ancestor ?? true, out: '' };
        const w = opts.window;
        if (w && cmd === 'git') {
          if (command === `merge-base --is-ancestor ${GATE_BASE} ${HEAD}`) return { ok: w.gateBaseInHead ?? true, out: '' };
          if (command === `merge-base --is-ancestor ${GATE_BASE} ${TIP}`) return { ok: w.gateBaseInTip ?? true, out: '' };
          if (command === `cat-file -e ${TIP}^{commit}`) return { ok: w.tipLocal ?? true, out: '' };
          if (command === `merge-base ${TIP} ${HEAD}`) return { ok: true, out: `${FORK}\n` };
          if (args[0] === 'log' && args.includes('--first-parent') && args.at(-1) === `${GATE_BASE}..${TIP}`) {
            return { ok: w.windowLogOk ?? true, out: w.windowLog ?? `\u0001${WINDOW_A}\n\nsrc/other.ts\n\u0001${WINDOW_B}\n\ndocs/x.md\n` };
          }
        }
        if (cmd === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[3] === HEAD) return { ok: (opts.landingAncestors ?? []).includes(args[2]!), out: '' };
        return inner.run(cmd, args);
      };
      return { run, commands };
    }
    function evidenceFiles(overrides: { gateBase?: string; review?: Record<string, unknown>; noGate?: boolean; reviewDir?: string; card?: string } = {}) {
      const dir = mkdtempSync(join(tmpdir(), 'pr-land-overlap-evidence-'));
      const reviewDir = overrides.reviewDir ?? 'review-results';
      const reviewResult = join(dir, reviewDir, `${overrides.card ?? 'TA-1'}-51-${HEAD.slice(0, 12)}.json`);
      mkdirSync(join(dir, reviewDir));
      writeFileSync(reviewResult, `noise\n${JSON.stringify({ pr: 51, verdict: 'pass', reviewed: true, mustFix: [], headCommit: HEAD, ...overrides.review })}\n`);
      const evidence = join(dir, 'evidence.json');
      writeFileSync(evidence, JSON.stringify({ pr: 51, head: HEAD, ...(overrides.noGate ? {} : { gate: { head: HEAD, baseCommit: overrides.gateBase ?? TIP, passed: true } }), reviewResult }));
      return { dir, evidence };
    }
    const pinnedManager = () => fakeManager({ findPrForBranchOutcome: () => ({ status: 'ok OUTPUT', url: URL }) });

    it('without --overlap-evidence the pinned refusal is unchanged', async () => {
      const { run } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      let localTypecheckCalls = 0;
      expect(await runPrLand({ pr: '51', expectedHead: HEAD }, {
        ...baseDeps, run, manager, out: sink.out,
        runTypecheckGate: () => { localTypecheckCalls += 1; return true; },
      })).toBe(1);
      expect(localTypecheckCalls).toBe(0);
      expect(sink.errors).toContain('✗ expected-head: overlap merge approval unavailable for the reviewed head');
      expect(sink.errors.join('\n')).not.toContain('overlap-evidence');
      expect(calls).not.toContain('merge');
    });

    it('marks an ancestor-auto-not-ancestor refusal for cross-host resync', async () => {
      const { run, commands } = pinnedRun({ landingAncestors: [LANDINGS[0]!] });
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir } = evidenceFiles();
      let heavyCalls = 0;
      let localTypecheckCalls = 0;
      const preflightCommands: string[] = [];
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, heavyRemote: true }, {
          ...baseDeps, manager, out: sink.out, reviewResultsDir: join(dir, 'review-results'),
          run: (cmd, args) => {
            const command = `${cmd} ${args.join(' ')}`;
            preflightCommands.push(command);
            if (command === 'git fetch --quiet origin main') return { ok: true, out: '' };
            if (command === 'git rev-parse --verify origin/main') return { ok: true, out: `${TIP}\n` };
            return run(cmd, args);
          },
          runHeavyRemote: () => { heavyCalls += 1; return { ok: true, source: 'remote', elapsedMs: 1, evidencePath: '/tmp/unused.json' }; },
          runTypecheckGate: () => { localTypecheckCalls += 1; return true; },
        })).toBe(1);
        expect(sink.errors.join('\n')).toContain('ancestor-auto-not-ancestor:');
        expect(commands).toContainEqual({ cmd: 'gh', args: ['pr', 'edit', '51', '--add-label', 'elanous:needs-rebase'] });
        const fetchIndex = preflightCommands.findIndex((command) => command === 'git fetch --quiet origin main');
        const overlapLookupIndex = preflightCommands.map((command) => command.startsWith('git log ') && command.includes('--name-only')).lastIndexOf(true);
        expect(fetchIndex).toBeGreaterThanOrEqual(0);
        expect(overlapLookupIndex).toBeGreaterThan(fetchIndex);
        expect(heavyCalls).toBe(0);
        expect(localTypecheckCalls).toBe(0);
        expect(calls).not.toContain('merge');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30_000);

    it('rechecks overlap after main advances during the remote gate and refuses the new non-ancestor landing', async () => {
      const { run: inner } = pinnedRun({ landingAncestors: LANDINGS });
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir } = evidenceFiles();
      let mainReads = 0;
      let heavyCalls = 0;
      const newLanding = `commit ${WINDOW_B}\nsrc/land.ts\n`;
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, heavyRemote: true }, {
          ...baseDeps, manager, out: sink.out, reviewResultsDir: join(dir, 'review-results'),
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main'
            ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main'
            ? { ok: true, out: `${mainReads++ === 0 ? TIP : WINDOW_A}\n` }
            : cmd === 'git' && args[0] === 'log' && args.includes('--name-only') && heavyCalls >= 1
            ? { ok: true, out: `${overlapLog}\n${newLanding}` }
            : inner(cmd, args),
          runHeavyRemote: () => { heavyCalls += 1; return { ok: true, source: 'remote', elapsedMs: 1, evidencePath: '/tmp/unused.json' }; },
        })).toBe(1);
        expect(heavyCalls).toBe(1);
        expect(sink.errors.join('\n')).toContain('ancestor-auto-not-ancestor:');
        expect(calls).not.toContain('merge');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30_000);

    it('rechecks overlap after main advances during a local pinned gate', async () => {
      const { run: inner } = pinnedRun({ landingAncestors: LANDINGS });
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir } = evidenceFiles();
      let localTypecheckCalls = 0;
      const newLanding = `commit ${WINDOW_B}\nsrc/land.ts\n`;
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD }, {
          ...baseDeps, manager, out: sink.out, reviewResultsDir: join(dir, 'review-results'),
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main'
            ? { ok: true, out: `${localTypecheckCalls === 0 ? TIP : WINDOW_A}\n` }
            : cmd === 'git' && args[0] === 'log' && args.includes('--name-only') && localTypecheckCalls > 0
            ? { ok: true, out: `${overlapLog}\n${newLanding}` }
            : inner(cmd, args),
          runTypecheckGate: () => { localTypecheckCalls += 1; return true; },
        })).toBe(1);
        expect(localTypecheckCalls).toBe(1);
        expect(sink.errors.join('\n')).toContain('ancestor-auto-not-ancestor:');
        expect(calls).not.toContain('merge');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30_000);

    it('pinned dry-run checks overlap and refuses without marking a PR for resync', async () => {
      const { run, commands } = pinnedRun({ landingAncestors: [LANDINGS[0]!] });
      const sink = output();
      expect(await runPrLand({ pr: '51', expectedHead: HEAD, dryRun: true }, {
        ...baseDeps, run, manager: pinnedManager().manager, out: sink.out,
      })).toBe(1);
      expect(sink.logs.join('\n')).toContain('✓ preflight');
      expect(sink.errors).toContain('✗ expected-head: overlap merge approval unavailable for the reviewed head');
      expect(commands.some(({ cmd, args }) => cmd === 'gh' && args.includes('--add-label'))).toBe(false);
      expect(commands.some(({ cmd, args }) => cmd === 'git' && args[0] === 'fetch')).toBe(false);
      expect(commands.some(({ cmd, args }) => cmd === 'git' && args[0] === 'diff' && args.at(-1) === 'refs/remotes/origin/main...HEAD')).toBe(true);
      expect(commands.some(({ cmd, args }) => cmd === 'git' && args[0] === 'log' && args.includes('refs/remotes/origin/main'))).toBe(true);
    });

    it('pinned dry-run refuses a stale tracking ref before measuring overlap or writing refs', async () => {
      const { run, commands } = pinnedRun();
      const sink = output();
      expect(await runPrLand({ pr: '51', expectedHead: HEAD, dryRun: true }, {
        ...baseDeps, run: (cmd, args) => args[0] === 'ls-remote'
          ? { ok: true, out: `${'c'.repeat(40)}\trefs/heads/main\n` }
          : run(cmd, args),
        manager: pinnedManager().manager, out: sink.out,
      })).toBe(1);
      expect(sink.errors.some((line) => line.startsWith('✗ overlap-preflight:'))).toBe(true);
      expect(commands.some(({ cmd, args }) => cmd === 'git' && (args[0] === 'log' || args[0] === 'diff' || args[0] === 'fetch'))).toBe(false);
      expect(commands.some(({ cmd, args }) => cmd === 'gh' && args[1] === 'edit')).toBe(false);
    });

    it('pinned dry-run checks the full tracking ref when a local branch shadows origin/main', async () => {
      const root = mkdtempSync(join(tmpdir(), 'land-preview-ref-collision-'));
      const repo = join(root, 'repo');
      const remote = join(root, 'remote.git');
      try {
        git(root, 'init', '--bare', remote);
        git(root, 'init', '-b', 'main', repo);
        git(repo, 'config', 'user.name', 'Preview Test');
        git(repo, 'config', 'user.email', 'preview@example.test');
        writeFileSync(join(repo, 'base.txt'), 'old\n');
        git(repo, 'add', 'base.txt');
        git(repo, 'commit', '-m', 'old base');
        const oldTip = git(repo, 'rev-parse', 'HEAD');
        git(repo, 'remote', 'add', 'origin', remote);
        git(repo, 'push', '-u', 'origin', 'main');
        git(repo, 'switch', '-c', 'feat/land');
        writeFileSync(join(repo, 'feature.txt'), 'feature\n');
        git(repo, 'add', 'feature.txt');
        git(repo, 'commit', '-m', 'feature');
        const head = git(repo, 'rev-parse', 'HEAD');
        git(repo, 'switch', 'main');
        writeFileSync(join(repo, 'base.txt'), 'new\n');
        git(repo, 'add', 'base.txt');
        git(repo, 'commit', '-m', 'new base');
        const newTip = git(repo, 'rev-parse', 'HEAD');
        git(repo, 'push', 'origin', 'main');
        git(repo, 'update-ref', 'refs/remotes/origin/main', oldTip);
        git(repo, 'branch', 'origin/main', newTip);
        git(repo, 'switch', 'feat/land');
        const fetchHead = join(repo, '.git', 'FETCH_HEAD');
        writeFileSync(fetchHead, 'sentinel\n');
        const sink = output();
        const run: CmdRunner = (cmd, args, options) => {
          if (cmd === 'gh') return { ok: true, out: JSON.stringify({ headRefOid: head, headRefName: 'feat/land', baseRefName: 'main', state: 'OPEN', isDraft: false, url: URL }) };
          const result = spawnSync(cmd, [...args], { cwd: options?.cwd ?? repo, encoding: 'utf8' });
          return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' };
        };
        expect(await runPrLand({ pr: '51', expectedHead: head, dryRun: true, cwd: repo, base: 'main' }, {
          ...baseDeps, run, resolveBase: () => 'main', manager: pinnedManager().manager, out: sink.out,
        })).toBe(1);
        expect(sink.errors.some((line) => line.startsWith('✗ overlap-preflight:'))).toBe(true);
        expect(git(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(oldTip);
        expect(git(repo, 'rev-parse', 'refs/heads/origin/main')).toBe(newTip);
        expect(readFileSync(fetchHead, 'utf8')).toBe('sentinel\n');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('pinned dry-run accepts verified overlap evidence without a write or heavy gate', async () => {
      const { run, commands } = pinnedRun();
      const { dir, evidence } = evidenceFiles();
      const { manager, calls } = pinnedManager();
      const sink = output();
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, dryRun: true, overlapEvidence: evidence }, {
          ...baseDeps, run, manager, out: sink.out, reviewResultsDir: join(dir, 'review-results'),
          runTypecheckGate: () => { throw new Error('dry-run must not typecheck'); },
          runHeavyRemote: () => { throw new Error('dry-run must not launch heavy gate'); },
        })).toBe(0);
        expect(sink.logs.some((line) => line.startsWith('✓ overlap-evidence:'))).toBe(true);
        expect(calls).toEqual([]);
        expect(commands.some(({ cmd, args }) => cmd === 'git' && args[0] === 'fetch')).toBe(false);
        expect(commands.some(({ cmd, args }) => cmd === 'gh' && args[1] === 'edit')).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('pinned dry-run accepts a reviewed virtual rebase with unchanged Git state', async () => {
      const root = mkdtempSync(join(tmpdir(), 'land-virtual-preview-'));
      const repo = join(root, 'repo');
      const remote = join(root, 'remote.git');
      try {
        git(root, 'init', '--bare', remote);
        git(root, 'init', '-b', 'main', repo);
        git(repo, 'config', 'user.name', 'Virtual Preview');
        git(repo, 'config', 'user.email', 'preview@example.test');
        mkdirSync(join(repo, 'src'));
        const file = join(repo, 'src', 'land.ts');
        const lines = Array.from({ length: 30 }, (_, index) => `line ${index}\n`);
        writeFileSync(file, lines.join(''));
        git(repo, 'add', '.');
        git(repo, 'commit', '-m', 'base');
        git(repo, 'remote', 'add', 'origin', remote);
        git(repo, 'push', '-u', 'origin', 'main');
        git(repo, 'switch', '-c', 'feat/land');
        lines[25] = 'feature line\n';
        writeFileSync(file, lines.join(''));
        git(repo, 'commit', '-am', 'feature');
        const head = git(repo, 'rev-parse', 'HEAD');
        git(repo, 'switch', 'main');
        lines[25] = 'line 25\n';
        lines[2] = 'main line\n';
        writeFileSync(file, lines.join(''));
        git(repo, 'commit', '-am', 'chore: land another PR');
        git(repo, 'push', 'origin', 'main');
        git(repo, 'switch', 'feat/land');
        const reviewDir = join(root, 'review-results');
        mkdirSync(reviewDir);
        writeFileSync(join(reviewDir, `VIRTUAL-51-${head.slice(0, 12)}.json`),
          `${JSON.stringify({ pr: 51, verdict: 'pass', reviewed: true, mustFix: [], headCommit: head })}\n`);
        const fetchHead = join(repo, '.git', 'FETCH_HEAD');
        writeFileSync(fetchHead, 'sentinel\n');
        const refs = git(repo, 'show-ref');
        const objects = git(repo, 'count-objects', '-v');
        const sink = output();
        const run: CmdRunner = (command, args, options) => {
          if (command === 'gh') return { ok: true, out: JSON.stringify({ headRefOid: head, headRefName: 'feat/land', baseRefName: 'main', state: 'OPEN', isDraft: false, url: URL }) };
          if (command === 'git' && args.join(' ') === 'remote get-url origin') return { ok: true, out: 'git@github.com:example/repo.git\n' };
          const result = spawnSync(command, [...args], { cwd: options?.cwd ?? repo, encoding: 'utf8' });
          return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' };
        };
        expect(await runPrLand({ pr: '51', expectedHead: head, dryRun: true, cwd: repo, base: 'main' }, {
          ...baseDeps, run, resolveBase: () => 'main', reviewResultsDir: reviewDir,
          manager: pinnedManager().manager, out: sink.out,
        })).toBe(0);
        expect(sink.logs.join('\n')).toContain('virtual-rebase');
        expect(git(repo, 'show-ref')).toBe(refs);
        expect(git(repo, 'count-objects', '-v')).toBe(objects);
        expect(readFileSync(fetchHead, 'utf8')).toBe('sentinel\n');
        const landing = pinnedManager();
        const landingOutput = output();
        const landingCode = await runPrLand({ pr: '51', expectedHead: head, cwd: repo, base: 'main' }, {
          ...baseDeps, run, resolveBase: () => 'main', reviewResultsDir: reviewDir,
          manager: landing.manager, out: landingOutput.out,
          decideOverlapLanding: () => ({ outcome: 'unavailable', channel: 'all-failed', interactive: false }),
        });
        if (landingCode !== 0) throw new Error(`landing refused: ${landingOutput.errors.join(' | ')} / ${landingOutput.logs.join(' | ')}`);
        expect(landingOutput.logs.join('\n')).toContain('virtual-rebase');
        expect(landing.calls).toContain('merge');
        writeFileSync(fetchHead, 'sentinel\n');
        const refsAfterLanding = git(repo, 'show-ref');
        const objectsAfterLanding = git(repo, 'count-objects', '-v');
        writeFileSync(join(reviewDir, `VIRTUAL-FAIL-51-${head.slice(0, 12)}.json`),
          `${JSON.stringify({ pr: 51, verdict: 'fail', reviewed: true, mustFix: ['blocked'], headCommit: head })}\n`);
        const refused = output();
        expect(await runPrLand({ pr: '51', expectedHead: head, dryRun: true, cwd: repo, base: 'main' }, {
          ...baseDeps, run, resolveBase: () => 'main', reviewResultsDir: reviewDir,
          manager: pinnedManager().manager, out: refused.out,
        })).toBe(1);
        expect(refused.errors.join('\n')).toContain('review-verdict-fail');
        expect(git(repo, 'show-ref')).toBe(refsAfterLanding);
        expect(git(repo, 'count-objects', '-v')).toBe(objectsAfterLanding);
        expect(readFileSync(fetchHead, 'utf8')).toBe('sentinel\n');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('rechecks reviewed virtual rebase through runPrLand after main moves during the heavy gate', async () => {
      const root = mkdtempSync(join(tmpdir(), 'land-virtual-late-'));
      const repo = join(root, 'repo');
      const remote = join(root, 'remote.git');
      const logged = spyOn(debug, 'log').mockImplementation(() => {});
      try {
        git(root, 'init', '--bare', remote);
        git(root, 'init', '-b', 'main', repo);
        git(repo, 'config', 'user.name', 'Virtual Late');
        git(repo, 'config', 'user.email', 'late@example.test');
        mkdirSync(join(repo, 'src'));
        const file = join(repo, 'src', 'land.ts');
        const lines = Array.from({ length: 30 }, (_, index) => `line ${index}\n`);
        writeFileSync(file, lines.join(''));
        git(repo, 'add', '.');
        git(repo, 'commit', '-m', 'base');
        const gateBase = git(repo, 'rev-parse', 'HEAD');
        git(repo, 'remote', 'add', 'origin', remote);
        git(repo, 'push', '-u', 'origin', 'main');
        git(repo, 'switch', '-c', 'feat/land');
        lines[25] = 'feature line\n';
        writeFileSync(file, lines.join(''));
        git(repo, 'commit', '-am', 'feature');
        const head = git(repo, 'rev-parse', 'HEAD');
        git(repo, 'switch', 'main');
        lines[25] = 'line 25\n';
        lines[2] = 'main line\n';
        writeFileSync(file, lines.join(''));
        git(repo, 'commit', '-am', 'chore: land another PR');
        const firstMain = git(repo, 'rev-parse', 'HEAD');
        git(repo, 'push', 'origin', 'main');
        lines[1] = 'later main line\n';
        writeFileSync(file, lines.join(''));
        git(repo, 'commit', '-am', 'chore: land later PR');
        const laterMain = git(repo, 'rev-parse', 'HEAD');
        git(repo, 'switch', 'feat/land');
        const reviewDir = join(root, 'review-results');
        mkdirSync(reviewDir);
        const reviewResult = join(reviewDir, `VIRTUAL-51-${head.slice(0, 12)}.json`);
        writeFileSync(reviewResult, `${JSON.stringify({ pr: 51, verdict: 'pass', reviewed: true, mustFix: [], headCommit: head })}\n`);
        const evidence = join(root, 'evidence.json');
        writeFileSync(evidence, JSON.stringify({ pr: 51, head, gate: { passed: true, head, baseCommit: gateBase }, reviewResult }));
        const sink = output();
        const landing = pinnedManager();
        const gatedBases: string[] = [];
        const run: CmdRunner = (command, args, options) => {
          if (command === 'gh' && args[1] === 'view' && args.includes('mergeCommit,state')) {
            return { ok: true, out: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'd'.repeat(40) } }) };
          }
          if (command === 'gh') return { ok: true, out: JSON.stringify({ headRefOid: head, headRefName: 'feat/land', baseRefName: 'main', state: 'OPEN', isDraft: false, url: URL }) };
          if (command === 'git' && args.join(' ') === 'remote get-url origin') return { ok: true, out: 'git@github.com:example/repo.git\n' };
          if (command === 'git' && args.join(' ') === `fetch --quiet origin ${'d'.repeat(40)}`) return { ok: true, out: '' };
          if (command === 'git' && args.join(' ') === `rev-parse --verify ${'d'.repeat(40)}^1`) return { ok: true, out: `${laterMain}\n` };
          const result = spawnSync(command, [...args], { cwd: options?.cwd ?? repo, encoding: 'utf8' });
          return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' };
        };
        const code = await runPrLand({ pr: '51', expectedHead: head, cwd: repo, base: 'main', overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, run, resolveBase: () => 'main', reviewResultsDir: reviewDir,
          manager: landing.manager, out: sink.out,
          decideOverlapLanding: () => ({ outcome: 'unavailable', channel: 'all-failed', interactive: false }),
          runHeavyRemote: ({ main }) => {
            gatedBases.push(main);
            if (main === firstMain) {
              git(repo, 'push', 'origin', `${laterMain}:refs/heads/main`);
              git(repo, 'update-ref', 'refs/remotes/origin/main', laterMain);
            }
            return { ok: true, host: 'node-b', source: 'remote', elapsedMs: 1, evidencePath: '/tmp/virtual-late-heavy.json' };
          },
        });
        if (code !== 0) throw new Error(`landing refused: ${sink.errors.join(' | ')} / ${sink.logs.join(' | ')}`);
        expect(gatedBases).toEqual([firstMain, laterMain]);
        expect(sink.logs.filter((line) => line.startsWith('✓ overlap-evidence: virtual-rebase'))).toHaveLength(2);
        expect(landing.calls).toContain('merge');
      } finally {
        logged.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);

    it('verified evidence (rebased · gated on that base · review pass must-fix 0) lands the pinned head', async () => {
      const { run, commands } = pinnedRun();
      const { manager, calls } = fakeManager({ findPrForBranchOutcome: () => { calls.push('find'); return { status: 'ok OUTPUT', url: URL }; } });
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      const logged = spyOn(debug, 'log').mockImplementation(() => {});
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence }, { ...baseDeps, reviewResultsDir: join(dir, 'review-results'), run, manager, out: sink.out })).toBe(0);
        expect(calls).toEqual(['find', 'merge']);
        expect(sink.logs.some((line) => line.startsWith('✓ overlap-evidence:'))).toBe(true);
        expect(commands.some(({ cmd, args }) => cmd === 'git' && args[0] === 'ls-remote')).toBe(true);
        expect(commands.filter(({ cmd, args }) => cmd === 'git' && args[0] === 'fetch').every(({ args }) => args.join(' ') === 'fetch --quiet origin main')).toBe(true);
        const fetchIndex = commands.findIndex(({ cmd, args }) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main');
        const landingLogIndexes = commands.flatMap(({ cmd, args }, index) => cmd === 'git' && args[0] === 'log'
          && args.includes('--since=1 day ago') && args.includes('--name-only') && args.includes('--no-merges') && args.includes('origin/main') ? [index] : []);
        expect(fetchIndex).toBeGreaterThanOrEqual(0);
        expect(landingLogIndexes.some((index) => index < fetchIndex)).toBe(true);
        expect(landingLogIndexes.some((index) => index > fetchIndex)).toBe(true);
        const seen = logged.mock.calls.filter((call) => call[0] === 'pr.land' && call[1] === 'overlap-evidence').map((call) => call[2]);
        expect(seen).toEqual([expect.objectContaining({ decision: 'accepted', pr: 51, head: HEAD, baseTip: TIP })]);
      } finally {
        logged.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('real review files refuse an old FAIL until a later PASS explicitly supersedes it with an OPEN follow-up', async () => {
      const { run: pinned } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const { dir, evidence } = evidenceFiles({ card: 'TA-R1' });
      const reviewDir = join(dir, 'review-results');
      const selected = join(reviewDir, `TA-R1-51-${HEAD.slice(0, 12)}.json`);
      const failed = join(reviewDir, `TA-R0-51-${HEAD.slice(0, 12)}.json`);
      const logged = spyOn(debug, 'log').mockImplementation(() => {});
      writeFileSync(failed, JSON.stringify({ pr: 51, headCommit: HEAD, reviewed: true, verdict: 'fail', mustFix: ['open issue'] }));
      fs.utimesSync(failed, new Date(1_000), new Date(1_000));
      fs.utimesSync(selected, new Date(2_000), new Date(2_000));
      const run: CmdRunner = (cmd, args) => cmd === 'gh' && args.join(' ') === 'pr view 52 --json state'
        ? { ok: true, out: JSON.stringify({ state: 'OPEN' }), err: '' }
        : pinned(cmd, args);
      try {
        const refused = output();
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence }, {
          ...baseDeps, reviewResultsDir: reviewDir, run, manager, out: refused.out,
        })).toBe(1);
        expect(refused.errors.join('\n')).toContain('review-attempt-not-superseded');
        expect(calls).not.toContain('merge');

        const outside = join(dir, 'outside-review.json');
        writeFileSync(outside, readFileSync(selected));
        rmSync(selected);
        fs.symlinkSync(outside, selected);
        const linked = output();
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence }, {
          ...baseDeps, reviewResultsDir: reviewDir, run, manager, out: linked.out,
        })).toBe(1);
        expect(linked.errors.join('\n')).toContain('review-file-outside-standard-dir');
        expect(calls).not.toContain('merge');
        rmSync(selected);
        writeFileSync(selected, readFileSync(outside));
        fs.utimesSync(selected, new Date(2_000), new Date(2_000));

        const outsideFailure = join(dir, 'outside-failure.json');
        writeFileSync(outsideFailure, readFileSync(failed));
        rmSync(failed);
        fs.symlinkSync(outsideFailure, failed);
        const linkedFailure = output();
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence }, {
          ...baseDeps, reviewResultsDir: reviewDir, run, manager, out: linkedFailure.out,
        })).toBe(1);
        expect(linkedFailure.errors.join('\n')).toContain('review-file-outside-standard-dir');
        expect(calls).not.toContain('merge');
        rmSync(failed);
        writeFileSync(failed, readFileSync(outsideFailure));
        fs.utimesSync(failed, new Date(1_000), new Date(1_000));

        const movedReviewDir = join(dir, 'moved-reviews');
        fs.renameSync(reviewDir, movedReviewDir);
        fs.symlinkSync(movedReviewDir, reviewDir);
        const linkedDirectory = output();
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence }, {
          ...baseDeps, reviewResultsDir: reviewDir, run, manager, out: linkedDirectory.out,
        })).toBe(1);
        expect(linkedDirectory.errors.join('\n')).toContain('review-standard-dir-symlink');
        expect(calls).not.toContain('merge');
        rmSync(reviewDir);
        fs.renameSync(movedReviewDir, reviewDir);

        writeFileSync(evidence, JSON.stringify({
          pr: 51, head: HEAD, gate: { head: HEAD, baseCommit: TIP, passed: true }, reviewResult: selected,
          supersedes: [{ reviewResult: failed, reason: 'review-verdict-fail' }], followupPr: 52,
        }));
        const accepted = output();
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence }, {
          ...baseDeps, reviewResultsDir: reviewDir, run, manager, out: accepted.out,
        })).toBe(0);
        expect(calls).toContain('merge');
        expect(fs.existsSync(selected)).toBe(true);
        expect(fs.existsSync(failed)).toBe(true);
        expect(logged.mock.calls).toContainEqual(['pr.land', 'review-attempt-selection', expect.objectContaining({
          pr: 51, selected, superseded: [{ reviewResult: failed, reason: 'review-verdict-fail' }], followupPr: 52,
        })]);
      } finally { logged.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
    });

    it('heavy remote pins head and current main, reruns after main moves, and skips local tsc/PWA', async () => {
      const { run: inner } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      let mainReads = 0;
      const pairs: Array<{ head: string; main: string }> = [];
      const shadowPairs: Array<{ head: string; main: string }> = [];
      const loads: unknown[] = [];
      const logged = spyOn(debug, 'log').mockImplementation((...call: unknown[]) => { loads.push(call); });
      const samples = [[1.25, 0.5, 0.25], [1.5, 0.75, 0.3], [2.25, 1.1, 0.4], [2.5, 1.2, 0.45]] as const;
      let sample = 0;
      try {
        const code = await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true, heavyOnPodShadow: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          loadavg: () => samples[Math.min(sample++, samples.length - 1)]!,
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main'
            ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main'
            ? { ok: true, out: `${mainReads++ === 0 ? TIP : WINDOW_A}\n` }
            : cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('mergeCommit,state')
            ? { ok: true, out: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'd'.repeat(40) } }) }
            : cmd === 'git' && args.join(' ') === `fetch --quiet origin ${'d'.repeat(40)}`
            ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === `rev-parse --verify ${'d'.repeat(40)}^1`
            ? { ok: true, out: `${WINDOW_A}\n` }
            : inner(cmd, args),
          runHeavyRemote: ({ head, main }) => {
            pairs.push({ head, main });
            return { ok: true, host: 'node-c', source: 'remote', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json', interferenceMeasured: false,
              rootPlan: { mode: 'affected', roots: 4, promoted: false, reason: null } };
          },
          runLandingPodShadow: async ({ head, main }) => {
            shadowPairs.push({ head, main });
            return runLandingPodShadowJob({ head, main }, {
              runPod: async (options) => {
                expect(options.source).toEqual({ kind: 'commit', sha: head });
                expect(options.command[2]).toContain(`self gate --changed --base '${main}'`);
                return { exitCode: 0, artifactsDir: '/tmp/shadow-test', job: 'shadow-pod' };
              },
              readLog: () => `ELANOUS_PRLAND_SHADOW_TSC_PLAN {"mode":"affected","roots":4,"promoted":false,"reason":null}\nELANOUS_PRLAND_SHADOW head=${head} main=${main} tsc=0 gate=1\n`,
            });
          },
          runTypecheckGate: () => { throw new Error('local tsc ran'); },
          runPwaGate: () => { throw new Error('local PWA build ran'); },
          runLandGlobalChecks: () => { throw new Error('local global checks ran'); },
          runTestInterferenceGate: async () => { throw new Error('local interference gate ran'); },
        });
        expect(code).toBe(0);
        // initial read, moved read, post-gate confirm that WINDOW_A is still main
        expect(mainReads).toBe(3);
        expect(pairs).toEqual([{ head: HEAD, main: TIP }, { head: HEAD, main: WINDOW_A }]);
        expect(shadowPairs).toEqual([{ head: HEAD, main: TIP }]);
        expect(loads.some((call) => Array.isArray(call) && call[0] === 'pr.land' && call[1] === 'heavy-on-pod-shadow'
          && (call[2] as { agree?: boolean; pod?: { job?: string } }).agree === false
          && (call[2] as { pod?: { job?: string } }).pod?.job === 'shadow-pod')).toBe(true);
        expect(calls).toContain('merge');
        expect(sink.errors.join('\n')).toContain('node-c 검사 미측정');
        expect(sink.logs.join('\n')).toContain('heavy-remote: host=node-c');
        expect(loads.some((call) => Array.isArray(call) && call[0] === 'pr.land' && call[1] === 'step'
          && (call[2] as { step?: string; measured?: boolean }).step === 'test-interference-gate'
          && (call[2] as { measured?: boolean }).measured === false)).toBe(true);
        const observed = loads.filter((call) => Array.isArray(call) && call[0] === 'pr.land' && call[1] === 'heavy-remote-load').map((call) => (call as unknown[])[2]);
        expect(observed).toEqual([
          expect.objectContaining({ phase: 'initial', main: TIP, host: 'node-c', mbpLoad1Before: 1.25, mbpLoad5Before: 0.5, mbpLoad1After: 1.5, mbpLoad5After: 0.75, ok: true }),
          expect.objectContaining({ phase: 'late-recheck', main: WINDOW_A, host: 'node-c', mbpLoad1Before: 2.25, mbpLoad5Before: 1.1, mbpLoad1After: 2.5, mbpLoad5After: 1.2, ok: true }),
        ]);
        expect(observed.every((row) => typeof (row as { elapsedMs?: unknown }).elapsedMs === 'number')).toBe(true);
        const timings = loads.filter((call) => Array.isArray(call) && call[0] === 'pr.land' && call[1] === 'stage-timing')
          .map((call) => (call as unknown[])[2] as { stage: string; startedAt: string; endedAt: string; elapsedMs: number });
        for (const name of ['heavy-remote-initial', 'heavy-remote-late-recheck', 'pre-merge-base-check', 'merge']) {
          const timing = timings.find(({ stage }) => stage === name);
          expect(timing).toBeDefined();
          expect(Number.isNaN(Date.parse(timing!.startedAt))).toBe(false);
          expect(Number.isNaN(Date.parse(timing!.endedAt))).toBe(false);
          expect(timing!.elapsedMs).toBeGreaterThanOrEqual(0);
        }
      } finally {
        logged.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('refuses the merge when main moves at the merge boundary and the late gate fails', async () => {
      const { run: inner } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      const phases: string[] = [];
      const loads: unknown[] = [];
      const logged = spyOn(debug, 'log').mockImplementation((...call: unknown[]) => { loads.push(call); });
      const samples = [[0.2, 0.1, 0.05], [0.3, 0.15, 0.08], [4, 2, 1], [4.5, 2.2, 1.1]] as const;
      let sample = 0;
      let heavyCalls = 0;
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          loadavg: () => samples[Math.min(sample++, samples.length - 1)]!,
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main' ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main'
            ? { ok: true, out: `${heavyCalls === 0 ? TIP : WINDOW_A}\n` }
            : inner(cmd, args),
          runHeavyRemote: ({ main }) => {
            heavyCalls += 1;
            phases.push(main);
            return main === TIP
              ? { ok: true, host: 'node-b', source: 'remote', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' }
              : { ok: false, source: 'unmeasured', reason: 'ssh-down', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' };
          },
          runTypecheckGate: () => { throw new Error('local tsc ran'); },
          runPwaGate: () => { throw new Error('local PWA build ran'); },
        })).toBe(1);
        expect(phases).toEqual([TIP, WINDOW_A]);
        expect(heavyCalls).toBe(2);
        expect(calls).not.toContain('merge');
        expect(sink.errors.join('\n')).toContain('병합 직전');
        expect(sink.errors.join('\n')).toContain('node-b 검사 상태 미상');
        expect(loads.some((call) => Array.isArray(call) && call[0] === 'pr.land' && call[1] === 'step'
          && (call[2] as { step?: string; measured?: boolean | null }).step === 'test-interference-gate'
          && (call[2] as { measured?: boolean | null }).measured === null)).toBe(true);
        const observed = loads.filter((call) => Array.isArray(call) && call[0] === 'pr.land' && call[1] === 'heavy-remote-load').map((call) => (call as unknown[])[2]);
        expect(observed).toEqual([
          expect.objectContaining({ phase: 'initial', main: TIP, mbpLoad1Before: 0.2, mbpLoad5Before: 0.1, mbpLoad1After: 0.3, mbpLoad5After: 0.15 }),
          expect.objectContaining({ phase: 'late-recheck', main: WINDOW_A, ok: false, mbpLoad1Before: 4, mbpLoad5Before: 2, mbpLoad1After: 4.5, mbpLoad5After: 2.2 }),
        ]);
      } finally {
        logged.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not revert when the squash first parent is not the verified base, and starts a post-merge gate', async () => {
      const { run: inner } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      const raced = 'c'.repeat(40);
      const squash = 'd'.repeat(40);
      const pairs: string[] = [];
      const loads: unknown[] = [];
      const logged = spyOn(debug, 'log').mockImplementation((...call: unknown[]) => { loads.push(call); });
      const samples = [[1, 0.4, 0.2], [1.1, 0.45, 0.22], [3, 1.5, 0.7], [3.2, 1.6, 0.8]] as const;
      let sample = 0;
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          loadavg: () => samples[Math.min(sample++, samples.length - 1)]!,
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main' ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main' ? { ok: true, out: `${TIP}\n` }
            : cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('mergeCommit,state')
            ? { ok: true, out: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: squash } }) }
            : cmd === 'git' && args.join(' ') === `fetch --quiet origin ${squash}` ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === `rev-parse --verify ${squash}^1` ? { ok: true, out: `${raced}\n` }
            : inner(cmd, args),
          runHeavyRemote: ({ main }) => {
            pairs.push(main);
            return { ok: true, host: 'node-b', source: 'remote', elapsedMs: 7, evidencePath: '/tmp/injected-heavy.json' };
          },
          runTypecheckGate: () => { throw new Error('local tsc ran'); },
          runPwaGate: () => { throw new Error('local PWA build ran'); },
        })).toBe(0);
        expect(calls).toContain('merge');
        expect(pairs).toEqual([TIP, raced]);
        expect(sink.logs.join('\n')).toContain(`post-merge gate required: verified=${TIP.slice(0, 12)} mergedOnto=${raced.slice(0, 12)} (merged-base-mismatch)`);
        expect(sink.logs.join('\n')).toContain('✓ merge: squash');
        const required = loads.filter((call) => Array.isArray(call) && call[0] === 'pr.land' && call[1] === 'post-merge-gate-required').map((call) => (call as unknown[])[2]);
        expect(required).toEqual([expect.objectContaining({ verifiedBase: TIP, mergedOnto: raced, mergeCommit: squash, verifiedHost: 'node-b', reason: 'merged-base-mismatch' })]);
        const observed = loads.filter((call) => Array.isArray(call) && call[0] === 'pr.land' && call[1] === 'heavy-remote-load').map((call) => (call as unknown[])[2]);
        expect(observed).toEqual([
          expect.objectContaining({ phase: 'initial', main: TIP, mbpLoad1Before: 1, mbpLoad5Before: 0.4, mbpLoad1After: 1.1, mbpLoad5After: 0.45 }),
          expect.objectContaining({ phase: 'post-merge', main: raced, mbpLoad1Before: 3, mbpLoad5Before: 1.5, mbpLoad1After: 3.2, mbpLoad5After: 1.6, ok: true }),
        ]);
      } finally {
        logged.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not merge when main moves again during the late gate and the next remote gate fails', async () => {
      const { run: inner } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      const moved = '9'.repeat(40);
      const phases: string[] = [];
      let mainReads = 0;
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main' ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main'
            ? { ok: true, out: `${[TIP, WINDOW_A, moved][mainReads++] ?? moved}\n` }
            : inner(cmd, args),
          runHeavyRemote: ({ main }) => {
            phases.push(main);
            return main === moved
              ? { ok: false, source: 'unmeasured', reason: 'ssh-down', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' }
              : { ok: true, host: 'node-b', source: 'remote', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' };
          },
          runTypecheckGate: () => { throw new Error('local tsc ran'); },
          runPwaGate: () => { throw new Error('local PWA build ran'); },
        })).toBe(1);
        expect(phases).toEqual([TIP, WINDOW_A, moved]);
        expect(calls).not.toContain('merge');
        expect(sink.errors.join('\n')).toContain('ssh-down');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it('does not merge when the PR is retargeted during a late remote regate', async () => {
      let baseViews = 0;
      const { run: inner } = pinnedRun({ baseRefName: () => (baseViews++ === 0 ? 'main' : 'release') });
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      let mainReads = 0;
      let heavy = 0;
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main' ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main'
            ? { ok: true, out: `${mainReads++ === 0 ? TIP : WINDOW_A}\n` }
            : inner(cmd, args),
          runHeavyRemote: () => {
            heavy += 1;
            return { ok: true, host: 'node-b', source: 'remote', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' };
          },
          runTypecheckGate: () => { throw new Error('local tsc ran'); },
          runPwaGate: () => { throw new Error('local PWA build ran'); },
        })).toBe(1);
        expect(heavy).toBe(2);
        expect(baseViews).toBe(2);
        expect(calls).not.toContain('merge');
        expect(sink.errors.join('\n')).toContain('base=release');
        expect(sink.errors.join('\n')).not.toContain('squash merge');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });


    it('refuses a heavy-remote landing when the pinned PR base is not main', async () => {
      const { run: inner } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      let heavy = 0;
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          run: (cmd, args) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid,headRefName,baseRefName,state,isDraft,url')
            ? { ok: true, out: JSON.stringify({ headRefOid: HEAD, headRefName: 'feat/land', baseRefName: 'release', state: 'OPEN', isDraft: false, url: URL }) }
            : inner(cmd, args),
          runHeavyRemote: () => { heavy += 1; return { ok: true, host: 'node-b', source: 'remote', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' }; },
        })).toBe(1);
        expect(heavy).toBe(0);
        expect(calls).not.toContain('merge');
        expect(sink.errors.join('\\n')).toContain('base is release, not main');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('refuses a heavy-remote landing when the pinned PR base is unreadable', async () => {
      const { run: inner } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          run: (cmd, args) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid,headRefName,baseRefName,state,isDraft,url')
            ? { ok: false, out: '' }
            : inner(cmd, args),
          runHeavyRemote: () => { throw new Error('remote gate must not run'); },
        })).toBe(1);
        expect(calls).not.toContain('merge');
        expect(sink.errors.join('\\n')).toContain('PR base is unavailable');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('does not retry merge when the PR is retargeted during the UNKNOWN wait', async () => {
      let premergeViews = 0;
      const { run: inner } = pinnedRun({ baseRefName: () => (premergeViews++ < 2 ? 'main' : 'release') });
      const merges: string[] = [];
      const manager = fakeManager({
        findPrForBranchOutcome: () => ({ status: 'ok OUTPUT', url: URL }),
        mergePrOutcome: () => { merges.push('merge'); return { ok: false, kind: 'not-merged', state: 'OPEN' }; },
      }).manager;
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      let slept = 0;
      const timings: Array<{ stage: string; attempt?: number; elapsedMs: number }> = [];
      const logged = spyOn(debug, 'log').mockImplementation((scope, event, data) => {
        if (scope === 'pr.land' && event === 'stage-timing') timings.push(data as { stage: string; attempt?: number; elapsedMs: number });
      });
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          sleep: async () => { slept += 1; },
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main' ? (sink.logs.push('FETCH-HIT'), { ok: true, out: '' })
            : cmd === 'git' && args[0] === 'fetch' ? (sink.logs.push(`FETCH-MISS ${JSON.stringify(args)}`), { ok: false, out: '' })
            : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main' ? (sink.logs.push('REV-HIT'), { ok: true, out: `${TIP}\n` })
            : cmd === 'git' && args[0] === 'rev-parse' && args.includes('origin/main') ? (sink.logs.push(`REV-MISS ${JSON.stringify(args)}`), { ok: false, out: '' })
            : cmd === 'gh' && args.includes('mergeable') ? { ok: true, out: 'UNKNOWN\n' }
            : inner(cmd, args),
          runHeavyRemote: () => ({ ok: true, host: 'node-b', source: 'remote', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' }),
        })).toBe(1);
        expect(slept).toBe(1);
        expect(merges).toEqual(['merge']);
        expect(sink.errors.join('\n')).toContain('base=release');
        expect(sink.errors.join('\n')).not.toContain('squash merge');
        expect(timings.map(({ stage }) => stage)).toContain('merge-retry-wait');
        expect(timings).toContainEqual(expect.objectContaining({ stage: 'pre-merge-base-check', attempt: 1, elapsedMs: expect.any(Number) }));
        expect(timings.filter(({ stage }) => stage === 'merge')).toHaveLength(1);
      } finally { logged.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
    });

    it('does not retry merge when main moves during the UNKNOWN wait and the remote regate fails', async () => {
      const { run: inner } = pinnedRun();
      const merges: string[] = [];
      const manager = fakeManager({
        findPrForBranchOutcome: () => ({ status: 'ok OUTPUT', url: URL }),
        mergePrOutcome: () => { merges.push('merge'); return { ok: false, kind: 'not-merged', state: 'OPEN' }; },
      }).manager;
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      const moved = '9'.repeat(40);
      const phases: string[] = [];
      let mainReads = 0;
      let slept = 0;
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          sleep: async () => { slept += 1; },
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main' ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main'
            // initial, pre-merge confirm, then the read after the UNKNOWN wait
            ? { ok: true, out: `${mainReads++ < 2 ? TIP : moved}\n` }
            : cmd === 'gh' && args.includes('mergeable') ? { ok: true, out: 'UNKNOWN\n' }
            : inner(cmd, args),
          runHeavyRemote: ({ main }) => {
            phases.push(main);
            return main === TIP
              ? { ok: true, host: 'node-b', source: 'remote', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' }
              : { ok: false, source: 'unmeasured', reason: 'ssh-down', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' };
          },
          runTypecheckGate: () => { throw new Error('local tsc ran'); },
          runPwaGate: () => { throw new Error('local PWA build ran'); },
        })).toBe(1);
        expect(slept).toBe(1);
        expect(phases).toEqual([TIP, moved]);
        expect(merges).toEqual(['merge']);
        expect(sink.logs.join('\n')).toContain('mergeable=UNKNOWN');
        expect(sink.errors.join('\n')).toContain('ssh-down');
        expect(sink.errors.join('\n')).not.toContain('squash merge');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('refuses a new overlap before remote regate during the UNKNOWN retry', async () => {
      const { run: inner } = pinnedRun({ landingAncestors: LANDINGS });
      const merges: string[] = [];
      const manager = fakeManager({
        findPrForBranchOutcome: () => ({ status: 'ok OUTPUT', url: URL }),
        mergePrOutcome: () => { merges.push('merge'); return { ok: false, kind: 'not-merged', state: 'OPEN' }; },
      }).manager;
      const sink = output();
      const { dir } = evidenceFiles();
      let mainReads = 0;
      let slept = 0;
      let heavyCalls = 0;
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, heavyRemote: true }, {
          ...baseDeps, manager, out: sink.out, reviewResultsDir: join(dir, 'review-results'),
          sleep: async () => { slept += 1; },
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main'
            ? { ok: true, out: `${mainReads++ < 2 ? TIP : WINDOW_A}\n` }
            : cmd === 'git' && args[0] === 'log' && args.includes('--name-only') && slept > 0
            ? { ok: true, out: `${overlapLog}\ncommit ${WINDOW_B}\nsrc/land.ts\n` }
            : cmd === 'gh' && args.includes('mergeable') ? { ok: true, out: 'UNKNOWN\n' }
            : inner(cmd, args),
          runHeavyRemote: () => { heavyCalls += 1; return { ok: true, source: 'remote', elapsedMs: 1, evidencePath: '/tmp/unused.json' }; },
        })).toBe(1);
        expect(slept).toBe(1);
        expect(merges).toEqual(['merge']);
        expect(heavyCalls).toBe(1);
        expect(sink.errors.join('\n')).toContain('ancestor-auto-not-ancestor:');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30_000);

    it('fails closed without merging when origin/main keeps moving past the stability bound', async () => {
      const { run: inner } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      const tips = [TIP, WINDOW_A, WINDOW_B, '9'.repeat(40), '8'.repeat(40)];
      let mainReads = 0;
      const phases: string[] = [];
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main' ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main'
            ? { ok: true, out: `${tips[Math.min(mainReads++, tips.length - 1)]}\n` }
            : inner(cmd, args),
          runHeavyRemote: ({ main }) => {
            phases.push(main);
            return { ok: true, host: 'node-b', source: 'remote', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' };
          },
          runTypecheckGate: () => { throw new Error('local tsc ran'); },
          runPwaGate: () => { throw new Error('local PWA build ran'); },
        })).toBe(1);
        expect(phases).toEqual([TIP, WINDOW_A, WINDOW_B, '9'.repeat(40)]);
        expect(mainReads).toBe(5);
        expect(calls).not.toContain('merge');
        expect(sink.errors.join('\n')).toContain('계속 움직여');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('returns nonzero without a stale post-merge gate when the squash first parent is unreadable', async () => {
      const { run: inner } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      const pairs: string[] = [];
      const loads: unknown[] = [];
      const logged = spyOn(debug, 'log').mockImplementation((...call: unknown[]) => { loads.push(call); });
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main' ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main' ? { ok: true, out: `${TIP}\n` }
            : cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('mergeCommit,state')
            ? { ok: false, out: '' }
            : inner(cmd, args),
          runHeavyRemote: ({ main }) => {
            pairs.push(main);
            return { ok: true, host: 'node-b', source: 'remote', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' };
          },
        })).toBe(1);
        expect(calls).toContain('merge');
        expect(pairs).toEqual([TIP]);
        expect(sink.logs.join('\n')).toContain('post-merge gate required:');
        expect(sink.logs.join('\n')).toContain('(merge-state-unconfirmed)');
        expect(sink.logs.join('\n')).toContain('unreadable');
        expect(sink.errors.join('\n')).toContain('unmeasured');
        expect(sink.errors.join('\n')).toContain('되돌리지 않는다');
        expect(sink.logs.join('\n')).toContain('✓ merge: squash');
        const required = loads.filter((call) => Array.isArray(call) && call[0] === 'pr.land' && call[1] === 'post-merge-gate-required');
        expect(required).toHaveLength(1);
        const observed = loads.filter((call) => Array.isArray(call) && call[0] === 'pr.land' && call[1] === 'heavy-remote-load').map((call) => (call as unknown[])[2]);
        expect(observed.every((row) => (row as { phase?: string }).phase !== 'post-merge')).toBe(true);
      } finally {
        logged.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns nonzero when the post-merge gate of the known first parent fails, and keeps the required ledger', async () => {
      const { run: inner } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      const raced = 'c'.repeat(40);
      const squash = 'd'.repeat(40);
      const loads: unknown[] = [];
      const logged = spyOn(debug, 'log').mockImplementation((...call: unknown[]) => { loads.push(call); });
      const samples = [[1, 0.4, 0.2], [1.1, 0.45, 0.22], [5, 2.5, 1], [5.4, 2.7, 1.1]] as const;
      let sample = 0;
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          loadavg: () => samples[Math.min(sample++, samples.length - 1)]!,
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main' ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main' ? { ok: true, out: `${TIP}\n` }
            : cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('mergeCommit,state')
            ? { ok: true, out: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: squash } }) }
            : cmd === 'git' && args.join(' ') === `fetch --quiet origin ${squash}` ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === `rev-parse --verify ${squash}^1` ? { ok: true, out: `${raced}\n` }
            : inner(cmd, args),
          runHeavyRemote: ({ main }) => main === TIP
            ? { ok: true, host: 'node-b', source: 'remote', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' }
            : { ok: false, source: 'unmeasured', reason: 'ssh-down', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' },
        })).toBe(1);
        expect(calls).toContain('merge');
        expect(sink.logs.join('\n')).toContain(`post-merge gate required: verified=${TIP.slice(0, 12)} mergedOnto=${raced.slice(0, 12)} (merged-base-mismatch)`);
        expect(sink.errors.join('\n')).toContain('ssh-down');
        expect(sink.errors.join('\n')).toContain('되돌리지 않는다');
        expect(sink.logs.join('\n')).toContain('✓ merge: squash');
        const required = loads.filter((call) => Array.isArray(call) && call[0] === 'pr.land' && call[1] === 'post-merge-gate-required').map((call) => (call as unknown[])[2]);
        expect(required).toEqual([expect.objectContaining({ verifiedBase: TIP, mergedOnto: raced, reason: 'merged-base-mismatch' })]);
        const observed = loads.filter((call) => Array.isArray(call) && call[0] === 'pr.land' && call[1] === 'heavy-remote-load').map((call) => (call as unknown[])[2]);
        expect(observed).toEqual([
          expect.objectContaining({ phase: 'initial', main: TIP }),
          expect.objectContaining({ phase: 'post-merge', main: raced, ok: false, mbpLoad1Before: 5, mbpLoad5Before: 2.5, mbpLoad1After: 5.4, mbpLoad5After: 2.7 }),
        ]);
      } finally {
        logged.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('heavy remote failure blocks the merge without running local gates', async () => {
      const { run: inner } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main' ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main' ? { ok: true, out: `${TIP}\n` } : inner(cmd, args),
          runHeavyRemote: () => ({ ok: false, source: 'unmeasured', reason: 'ssh-down', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' }),
          runTypecheckGate: () => { throw new Error('local tsc ran'); },
        })).toBe(1);
        expect(sink.errors.join('\n')).toContain('ssh-down');
        expect(calls).not.toContain('merge');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('records busy and merge-conflict refusal edges from runPrLand without merging', async () => {
      const { run: inner } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const { dir, evidence } = evidenceFiles();
      const edges: unknown[] = [];
      const off = debug.registerSink({ name: 'pr-land-busy-refusal-test', emit: (row) => {
        if (row.event === 'graph-edge-taken') edges.push(row.data);
      } });
      try {
        const cases = [
          ['gate-host-busy', 'gate-host-busy', 'next-move'],
          ['gate-rc-1 · remote: stdout: CONFLICT (content): Merge conflict in scripts/test-deterministic.ts', 'gate-merge-conflict', 'main-sync'],
        ] as const;
        for (const [reason, label, destination] of cases) {
          const sink = output();
          expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
            ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
            run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main' ? { ok: true, out: '' }
              : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main' ? { ok: true, out: `${TIP}\n` } : inner(cmd, args),
            runHeavyRemote: () => ({ ok: false, source: 'unmeasured', reason, elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' }),
            runTypecheckGate: () => { throw new Error('local tsc ran'); },
          })).toBe(1);
          expect(sink.errors).toContain(`✗ heavy-remote: 원격 게이트 ${reason} — 로컬 게이트로 폴백하지 않는다.`);
          expect(edges).toContainEqual(expect.objectContaining({
            from: 'merge', on: 'refusal', label, to: destination,
            taken: destination, reason: 'pr-land-refused; recovery-execution=none',
          }));
        }
        expect(calls).not.toContain('merge');
        expect(edges).toHaveLength(cases.length);
      } finally { off(); rmSync(dir, { recursive: true, force: true }); }
    });

    it('heavy remote fails closed if main moves and the second remote gate cannot run', async () => {
      const { run: inner } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      let mainReads = 0;
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), manager, out: sink.out,
          run: (cmd, args) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main' ? { ok: true, out: '' }
            : cmd === 'git' && args.join(' ') === 'rev-parse --verify origin/main'
            ? { ok: true, out: `${mainReads++ === 0 ? TIP : WINDOW_A}\n` } : inner(cmd, args),
          runHeavyRemote: ({ main }) => main === TIP
            ? { ok: true, host: 'node-b', source: 'remote', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' }
            : { ok: false, source: 'unmeasured', reason: 'ssh-down', elapsedMs: 1, evidencePath: '/tmp/injected-heavy.json' },
          runTypecheckGate: () => { throw new Error('local tsc ran'); },
          runPwaGate: () => { throw new Error('local PWA build ran'); },
        })).toBe(1);
        expect(mainReads).toBe(2);
        expect(sink.errors.join('\n')).toContain('ssh-down');
        expect(calls).not.toContain('merge');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it.each([
      ['not rebased onto the current base tip', { ancestor: false }, {}, 'not-rebased'],
      ['gate ran on a stale base', {}, { gateBase: 'c'.repeat(40) }, 'gate-base-stale'],
      ['review carries a must-fix', {}, { review: { mustFix: ['fix it'] } }, 'review-must-fix-1'],
      ['review is for another head', {}, { review: { headCommit: 'd'.repeat(40) } }, 'review-head-mismatch'],
      ['review verdict is fail', {}, { review: { verdict: 'fail' } }, 'review-verdict-fail'],
      ['review verdict is warn but must-fix count is unknown', {}, { review: { verdict: 'warn', mustFix: [1] } }, 'review-must-fix-unknown'],
      ['review verdict is warn with a must-fix', {}, { review: { verdict: 'warn', mustFix: ['x'] } }, 'review-must-fix-1'],
      ['review is warn but not reviewed', {}, { review: { verdict: 'warn', reviewed: false } }, 'review-not-reviewed'],
      ['base advanced and a window commit touches a PR file', { ancestor: false, window: { windowLog: `\u0001${WINDOW_A}\n\nsrc/land.ts\n\u0001${WINDOW_B}\n\ndocs/x.md\n` } }, { gateBase: GATE_BASE }, 'base-stale-overlap'],
      ['base advanced but the gate base is not in the head', { ancestor: false, window: { gateBaseInHead: false } }, { gateBase: GATE_BASE }, 'not-rebased'],
      ['gate base is not in the current base tip', { window: { gateBaseInTip: false } }, { gateBase: GATE_BASE }, 'gate-base-stale'],
      ['the base window cannot be listed', { ancestor: false, window: { windowLogOk: false } }, { gateBase: GATE_BASE }, 'base-window-unmeasured'],
      ['the base tip cannot be fetched', { ancestor: false, window: { tipLocal: false } }, { gateBase: GATE_BASE }, 'base-window-unmeasured'],
      ['base advanced disjoint but review is warn with unknown must-fix', { ancestor: false, window: {} }, { gateBase: GATE_BASE, review: { verdict: 'warn', mustFix: [1] } }, 'review-must-fix-unknown'],
      ['review file is outside a review-results directory', {}, { reviewDir: 'elsewhere' }, 'review-path-not-for-this-pr-head'],
      ['review file name has no card part', {}, { card: '' }, 'review-path-not-for-this-pr-head'],
    ] as const)('rejects when %s and keeps the old refusal', async (_label, runOpts, files, reason) => {
      const { run } = pinnedRun(runOpts);
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles(files);
      const logged = spyOn(debug, 'log').mockImplementation(() => {});
      let typecheckCalls = 0;
      let isolationCalls = 0;
      let heavyCalls = 0;
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote: true }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), run, manager, out: sink.out,
          runTypecheckGate: () => { typecheckCalls += 1; return true; },
          runIsolationGate: () => { isolationCalls += 1; return true; },
          runHeavyRemote: () => { heavyCalls += 1; return { ok: true, source: 'remote', elapsedMs: 1, evidencePath: '/tmp/unused.json' }; },
        })).toBe(1);
        expect(typecheckCalls).toBe(0);
        expect(isolationCalls).toBe(0);
        expect(heavyCalls).toBe(0);
        expect(sink.errors.some((line) => line.startsWith(`✗ overlap-evidence: ${reason}`))).toBe(true);
        expect(sink.errors).toContain('✗ expected-head: overlap merge approval unavailable for the reviewed head');
        expect(calls).not.toContain('merge');
        const seen = logged.mock.calls.filter((call) => call[0] === 'pr.land' && call[1] === 'overlap-evidence').map((call) => call[2]);
        expect(seen).toEqual([expect.objectContaining({ decision: 'rejected', reason: expect.stringContaining(reason) })]);
      } finally {
        logged.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([
      ['review missing', {}, 'review-unreadable', true],
      ['review head mismatch', { review: { headCommit: 'd'.repeat(40) } }, 'review-head-mismatch', false],
      ['base window overlaps a PR file', { gateBase: GATE_BASE }, 'base-stale-overlap', false],
    ] as const)('rejects %s before local gates', async (_label, files, reason, removeReview) => {
      const { run } = pinnedRun({
        ...(reason === 'base-stale-overlap'
          ? { ancestor: false, window: { windowLog: `\u0001${WINDOW_A}\n\nsrc/land.ts\n` } }
          : {}),
      });
      const { dir, evidence } = evidenceFiles(files);
      const { manager, calls } = pinnedManager();
      if (removeReview) {
        const record = JSON.parse(readFileSync(evidence, 'utf8')) as { reviewResult: string };
        rmSync(record.reviewResult);
      }
      try {
        for (const heavyRemote of [false, true]) {
          const sink = output();
          const gateCalls: string[] = [];
          expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence, heavyRemote }, {
            ...baseDeps, run, manager, out: sink.out, reviewResultsDir: join(dir, 'review-results'),
            runTypecheckGate: () => { gateCalls.push('typecheck'); return true; },
            runIsolationGate: () => { gateCalls.push('isolation'); return true; },
            runHeavyRemote: () => { gateCalls.push('heavy-remote'); return { ok: true, source: 'remote', elapsedMs: 1, evidencePath: '/tmp/unused.json' }; },
          })).toBe(1);
          expect(sink.errors.join('\n')).toContain(`✗ overlap-evidence: ${reason}`);
          expect(gateCalls).toEqual([]);
          expect(calls).not.toContain('merge');
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('fails closed before any gate when the pinned changed-file diff is unreadable', async () => {
      const { run: inner } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const gateCalls: string[] = [];
      expect(await runPrLand({ pr: '51', expectedHead: HEAD, heavyRemote: true }, {
        ...baseDeps, manager, out: sink.out,
        run: (cmd, args) => cmd === 'git' && args[0] === 'diff' && args.includes('--name-only')
          ? { ok: false, out: '', err: 'unreadable' }
          : inner(cmd, args),
        runTypecheckGate: () => { gateCalls.push('typecheck'); return true; },
        runIsolationGate: () => { gateCalls.push('isolation'); return true; },
        runHeavyRemote: () => { gateCalls.push('heavy-remote'); return { ok: true, source: 'remote', elapsedMs: 1, evidencePath: '/tmp/unused.json' }; },
      })).toBe(1);
      expect(sink.errors.join('\n')).toContain('✗ overlap-preflight: PR 변경 파일을 읽지 못했다');
      expect(gateCalls).toEqual([]);
      expect(calls).not.toContain('merge');
    });

    it('review verdict warn with zero must-fix lands the pinned head (same rule as canAuto)', async () => {
      const { run } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles({ review: { verdict: 'warn' } });
      const gateCalls: string[] = [];
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), run, manager, out: sink.out,
          runTypecheckGate: () => { gateCalls.push('typecheck'); return true; },
          runIsolationGate: () => { gateCalls.push('isolation'); return true; },
        })).toBe(0);
        expect(gateCalls).toEqual(['typecheck', 'isolation']);
        expect(logIndex(sink.logs, (line) => line.startsWith('✓ overlap-evidence:')))
          .toBeLessThan(logIndex(sink.logs, (line) => line.startsWith('✓ typecheck:')));
        expect(calls).toContain('merge');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([
      ['the head is not rebased onto the advanced tip', false],
      ['the head already contains the advanced tip', true],
    ] as const)('base-advanced-disjoint: gate base is in the head and no window commit touches a PR file → lands (%s)', async (_label, ancestor) => {
      const { run, commands } = pinnedRun({ ancestor, window: {} });
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles({ gateBase: GATE_BASE, review: { verdict: 'warn' } });
      const logged = spyOn(debug, 'log').mockImplementation(() => {});
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence }, { ...baseDeps, reviewResultsDir: join(dir, 'review-results'), run, manager, out: sink.out })).toBe(0);
        expect(calls).toContain('merge');
        expect(sink.logs.some((line) => line.startsWith('✓ overlap-evidence: base-advanced-disjoint'))).toBe(true);
        expect(commands.filter(({ cmd, args }) => cmd === 'git' && args[0] === 'fetch').every(({ args }) => args.join(' ') === 'fetch --quiet origin main')).toBe(true);
        const fetchIndex = commands.findIndex(({ cmd, args }) => cmd === 'git' && args.join(' ') === 'fetch --quiet origin main');
        const windowLogIndex = commands.findIndex(({ cmd, args }) => cmd === 'git' && args[0] === 'log' && args.includes('--first-parent') && args.includes('--name-only'));
        expect(fetchIndex).toBeGreaterThanOrEqual(0);
        expect(windowLogIndex).toBeGreaterThan(fetchIndex);
        expect(commands.some(({ cmd, args }) => cmd === 'git' && args.join(' ') === `diff --name-only --no-renames ${FORK} ${HEAD}`)).toBe(true);
        const seen = logged.mock.calls.filter((call) => call[0] === 'pr.land' && call[1] === 'overlap-evidence').map((call) => call[2]);
        expect(seen).toEqual([expect.objectContaining({ decision: 'accepted', reason: 'base-advanced-disjoint', baseTip: TIP, gateBase: GATE_BASE, windowCommits: 2 })]);
      } finally {
        logged.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('base-advanced-disjoint fetches the tip without writing refs when it is not local', async () => {
      let fetched = false;
      const { run: inner } = pinnedRun({ ancestor: false, window: {} });
      const run = (cmd: string, args: readonly string[]) => {
        if (cmd === 'git' && args[0] === 'fetch') {
          if (args.includes('--no-write-fetch-head')) fetched = true;
          return { ok: true, out: '' };
        }
        if (cmd === 'git' && args.join(' ') === `cat-file -e ${TIP}^{commit}`) return { ok: fetched, out: '' };
        return inner(cmd, args);
      };
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles({ gateBase: GATE_BASE });
      const seenArgs: string[][] = [];
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), run: (cmd, args) => { if (cmd === 'git' && args[0] === 'fetch') seenArgs.push([...args]); return run(cmd, args); }, manager, out: sink.out,
        })).toBe(0);
        expect(calls).toContain('merge');
        expect(seenArgs).toEqual([
          ['fetch', '--quiet', 'origin', 'main'],
          ['fetch', '--quiet', '--no-write-fetch-head', '--refmap=', 'origin', 'refs/heads/main'],
          ['fetch', '--quiet', 'origin', 'main'],
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('already-ancestor: every overlapping landing is inside the head → review pass alone lands (no rebase/gate check)', async () => {
      const { run, commands } = pinnedRun({ landingAncestors: LANDINGS });
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles({ noGate: true });
      const logged = spyOn(debug, 'log').mockImplementation(() => {});
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence }, { ...baseDeps, reviewResultsDir: join(dir, 'review-results'), run, manager, out: sink.out })).toBe(0);
        expect(calls).toContain('merge');
        expect(sink.logs.some((line) => line.startsWith('✓ overlap-evidence: already-ancestor'))).toBe(true);
        expect(commands.filter(({ cmd, args }) => cmd === 'git' && args[0] === 'merge-base' && args[3] === HEAD).map(({ args }) => args[2])).toEqual(LANDINGS);
        expect(commands.some(({ cmd, args }) => cmd === 'git' && args[0] === 'ls-remote')).toBe(false);
        const seen = logged.mock.calls.filter((call) => call[0] === 'pr.land' && call[1] === 'overlap-evidence').map((call) => call[2]);
        expect(seen).toEqual([expect.objectContaining({ decision: 'accepted', reason: 'already-ancestor', overlappingLandings: LANDINGS })]);
      } finally {
        logged.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([
      ['one overlapping landing is not an ancestor and no gate record', { landingAncestors: [LANDINGS[0]!] }, { noGate: true }, 'gate-missing'],
      ['all ancestors but the review carries a must-fix', { landingAncestors: LANDINGS }, { noGate: true, review: { mustFix: ['x'] } }, 'review-must-fix-1'],
    ] as const)('already-ancestor rejects when %s', async (_label, runOpts, files, reason) => {
      const { run } = pinnedRun(runOpts);
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles(files);
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence }, { ...baseDeps, reviewResultsDir: join(dir, 'review-results'), run, manager, out: sink.out })).toBe(1);
        expect(sink.errors.some((line) => line.startsWith(`✗ overlap-evidence: ${reason}`))).toBe(true);
        expect(sink.errors).toContain('✗ expected-head: overlap merge approval unavailable for the reviewed head');
        expect(calls).not.toContain('merge');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not let evidence override a human hold', async () => {
      const { run } = pinnedRun();
      const { manager, calls } = pinnedManager();
      const sink = output();
      const { dir, evidence } = evidenceFiles();
      try {
        expect(await runPrLand({ pr: '51', expectedHead: HEAD, overlapEvidence: evidence }, {
          ...baseDeps, reviewResultsDir: join(dir, 'review-results'), run, manager, out: sink.out,
          decideOverlapLanding: () => ({ outcome: 'user-hold', channel: 'terminal', interactive: true }),
        })).toBe(1);
        expect(sink.errors).toContain('✗ expected-head: overlap merge approval unavailable for the reviewed head');
        expect(calls).not.toContain('merge');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects --overlap-evidence on an unpinned landing before any command', async () => {
      const sink = output();
      expect(await runPrLand({ overlapEvidence: 'evidence.json' }, { ...baseDeps, run: () => { throw new Error('no command'); }, out: sink.out })).toBe(1);
      expect(sink.errors[0]).toContain('overlap-evidence');
    });
  });

  describe('changed-file base selection', () => {
    async function landWithBaseRefs(input: { remoteExists: boolean; localFiles: string; remoteFiles: string; behind?: number }) {
      const { manager } = fakeManager();
      const sink = output();
      const diffCalls: string[] = [];
      const run = (cmd: string, args: readonly string[]) => {
        const command = args.join(' ');
        if (cmd === 'git' && command === statusArgs) return { ok: true, out: '' };
        if (cmd === 'git' && command === numstatArgs) return { ok: true, out: '' };
        if (cmd === 'git' && command === 'rev-parse --verify --quiet refs/remotes/origin/main') return { ok: input.remoteExists, out: input.remoteExists ? 'remote-sha\n' : '' };
        if (cmd === 'git' && command === 'rev-list --left-right --count main...refs/remotes/origin/main') return { ok: true, out: `0\t${input.behind ?? 0}\n` };
        if (cmd === 'git' && args[0] === 'diff' && args.includes('--name-only')) {
          diffCalls.push(args.at(-1)!);
          return { ok: true, out: args.at(-1) === 'refs/remotes/origin/main...HEAD' ? input.remoteFiles : input.localFiles };
        }
        return baseLookupRun(cmd, args);
      };
      const code = await runPrLand({ dryRun: true }, {
        ...baseDeps,
        resolveBase: () => 'main',
        run,
        manager,
        out: sink.out,
      });
      return { code, sink, diffCalls };
    }

    it('uses a locally available remote-tracking ref after a real 200-commit divergence and passes only this landing’s files to both gates', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'pr-cli-base-'));
      try {
        git(cwd, 'init', '--initial-branch=main');
        git(cwd, 'config', 'user.email', 'test@example.com');
        git(cwd, 'config', 'user.name', 'Test User');
        git(cwd, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
        writeFileSync(join(cwd, 'seed.ts'), 'export const seed = 1;\n');
        git(cwd, 'add', 'seed.ts');
        git(cwd, 'commit', '-m', 'seed');
        const localBaseTip = git(cwd, 'rev-parse', 'HEAD');
        for (let commit = 1; commit <= 200; commit += 1) {
          const path = `foreign-${String(commit).padStart(3, '0')}.ts`;
          writeFileSync(join(cwd, path), `export const foreign${commit} = ${commit};\n`);
          git(cwd, 'add', path);
          git(cwd, 'commit', '-m', `foreign ${commit}`);
        }
        const remoteTip = git(cwd, 'rev-parse', 'HEAD');
        git(cwd, 'update-ref', 'refs/remotes/origin/main', remoteTip);
        git(cwd, 'reset', '--hard', localBaseTip);
        git(cwd, 'checkout', '-b', 'feat/land', remoteTip);
        mkdirSync(join(cwd, 'apps/android'), { recursive: true });
        mkdirSync(join(cwd, 'apps/ios'), { recursive: true });
        writeFileSync(join(cwd, 'apps/android/Landing.kt'), 'class Landing\n');
        writeFileSync(join(cwd, 'apps/ios/Landing.swift'), 'struct Landing {}\n');
        git(cwd, 'add', 'apps/android/Landing.kt', 'apps/ios/Landing.swift');
        git(cwd, 'commit', '-m', 'landing changes');

        const receivedAndroid: string[][] = [];
        const receivedIos: string[][] = [];
        const sink = output();
        const run = (cmd: string, args: readonly string[], options: SpawnSyncOptions = {}) => {
          const result = spawnSync(cmd, args, { ...options, encoding: 'utf8' });
          return { ok: result.status === 0, out: result.stdout ?? '' };
        };
        const code = await runPrLand({ cwd, dryRun: true }, {
          ...baseDeps,
          run,
          currentBranch: () => 'feat/land',
          resolveBase: () => 'main',
          manager: fakeManager().manager,
          out: sink.out,
          runAndroidGate: (_out, changedFiles) => { receivedAndroid.push([...changedFiles]); return true; },
          runPwaGate: () => true,
          runIosGate: (_out, changedFiles) => { receivedIos.push([...changedFiles]); return true; },
        });

        expect(code).toBe(0);
        expect(git(cwd, 'rev-list', '--count', 'main..origin/main')).toBe('200');
        const actualFiles = ['apps/android/Landing.kt', 'apps/ios/Landing.swift'];
        expect(receivedAndroid).toEqual([actualFiles]);
        expect(receivedIos).toEqual([actualFiles]);
        expect(sink.logs).toContain('⚠ changed-files: 로컬 main와 원격 origin/main가 갈립니다 (로컬 뒤처짐=200커밋) — origin/main...HEAD 기준으로 계산합니다.');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }, 30_000);

    it('ignores a local origin/main branch when no remote-tracking ref exists', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'pr-cli-local-origin-'));
      try {
        git(cwd, 'init', '--initial-branch=main');
        git(cwd, 'config', 'user.email', 'test@example.com');
        git(cwd, 'config', 'user.name', 'Test User');
        git(cwd, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
        writeFileSync(join(cwd, 'base.ts'), 'export const base = 1;\n');
        git(cwd, 'add', 'base.ts');
        git(cwd, 'commit', '-m', 'base');
        git(cwd, 'branch', 'origin/main');
        writeFileSync(join(cwd, 'local.ts'), 'export const local = 1;\n');
        git(cwd, 'add', 'local.ts');
        git(cwd, 'commit', '-m', 'local base');
        git(cwd, 'checkout', '-b', 'feat/land');
        writeFileSync(join(cwd, 'landing.ts'), 'export const landing = 1;\n');
        git(cwd, 'add', 'landing.ts');
        git(cwd, 'commit', '-m', 'landing');

        const receivedAndroid: string[][] = [];
        const sink = output();
        const run = (cmd: string, args: readonly string[], options: SpawnSyncOptions = {}) => {
          const result = spawnSync(cmd, args, { ...options, encoding: 'utf8' });
          return { ok: result.status === 0, out: result.stdout ?? '' };
        };
        const code = await runPrLand({ cwd, dryRun: true }, {
          ...baseDeps,
          run,
          currentBranch: () => 'feat/land',
          resolveBase: () => 'main',
          manager: fakeManager().manager,
          out: sink.out,
          runAndroidGate: (_out, changedFiles) => { receivedAndroid.push([...changedFiles]); return true; },
          runPwaGate: () => true,
        });

        expect(code).toBe(0);
        expect(git(cwd, 'rev-parse', '--verify', 'refs/heads/origin/main')).not.toBe(git(cwd, 'rev-parse', 'main'));
        expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd, encoding: 'utf8' }).status).not.toBe(0);
        expect(receivedAndroid).toEqual([['landing.ts']]);
        expect(sink.logs).toContain('⚠ changed-files: 원격 추적 ref origin/main 없음 — 로컬 main 기준으로 계산합니다.');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it('reports an unselected base distinctly from remote-ref fallback', async () => {
      const sink = output();
      const code = await runPrLand({ dryRun: true }, {
        ...baseDeps,
        resolveBase: () => undefined,
        manager: fakeManager().manager,
        out: sink.out,
      });
      expect(code).toBe(1);
      expect(sink.errors).toContain('✗ base: 비교 base를 선택하지 못했습니다.');
      expect(sink.logs.join('\n')).not.toContain('원격 추적 ref');
    });

    it('keeps the remote-tracking comparison when local and remote refs match', async () => {
      const result = await landWithBaseRefs({ remoteExists: true, localFiles: 'src/same.ts\n', remoteFiles: 'src/same.ts\n' });
      expect(result.code).toBe(0);
      expect(result.diffCalls).toEqual(['refs/remotes/origin/main...HEAD']);
      expect(result.sink.logs.some((line) => line.startsWith('⚠ changed-files:'))).toBe(false);
    });

    it('falls back to the local base and says so when the remote-tracking ref is absent', async () => {
      const result = await landWithBaseRefs({ remoteExists: false, localFiles: 'src/local-only.ts\n', remoteFiles: '' });
      expect(result.code).toBe(0);
      expect(result.diffCalls).toEqual(['main...HEAD']);
      expect(result.sink.logs).toContain('⚠ changed-files: 원격 추적 ref origin/main 없음 — 로컬 main 기준으로 계산합니다.');
    });
  });

  const RECENT_AUTHOR = 'me@example.com';
  const RECENT_MIN = 60_000;

  function landingLine(hash: string, email: string, committedAtMs: number, subject: string, file: string): string {
    return [`commit ${hash}${LANDING_HISTORY_META_MARK}${email} ${Math.floor(committedAtMs / 1000)} ${subject}`, file, ''].join('\n');
  }

  function twoRecentLandingLog(file = 'src/land.ts'): string {
    const nowMs = Date.now();
    return [
      landingLine('aaa111bbb222ccc333ddd444eee555fff666aaa', RECENT_AUTHOR, nowMs - 10 * RECENT_MIN, 'docs(cli): one', file),
      landingLine('bbb222ccc333ddd444eee555fff666aaa111bbb', RECENT_AUTHOR, nowMs - 12 * RECENT_MIN, 'docs(cli): two', file),
    ].join('\n');
  }

  function oneRecentLandingLog(file = 'src/land.ts'): string {
    return landingLine('aaa111bbb222ccc333ddd444eee555fff666aaa', RECENT_AUTHOR, Date.now() - 10 * RECENT_MIN, 'docs(cli): one', file);
  }

  function recentLandingSteps(logged: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return logged.mock.calls
      .filter((call) => call[0] === 'pr.land' && call[1] === 'step' && (call[2] as { step?: string } | undefined)?.step === 'recent-landing-rate')
      .map((call) => call[2] as Record<string, unknown>);
  }

  function commitMessageFallbackSteps(logged: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return logged.mock.calls
      .filter((call) => call[0] === 'pr.land' && call[1] === 'step' && (call[2] as { step?: string } | undefined)?.step === 'commit-message-fallback')
      .map((call) => call[2] as Record<string, unknown>);
  }

  function logIndex(logs: readonly string[], predicate: (line: string) => boolean): number {
    return logs.findIndex(predicate);
  }

  function overlapSteps(logged: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return logged.mock.calls
      .filter((call) => call[0] === 'pr.land' && call[1] === 'step' && (call[2] as { step?: string } | undefined)?.step === 'overlap')
      .map((call) => call[2] as Record<string, unknown>);
  }

  function overlapDecisionSteps(logged: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return logged.mock.calls
      .filter((call) => call[0] === 'pr.land' && call[1] === 'step' && (call[2] as { step?: string } | undefined)?.step === 'overlap-decision')
      .map((call) => call[2] as Record<string, unknown>);
  }

  function landReasonSteps(logged: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return logged.mock.calls
      .filter((call) => call[0] === 'pr.land' && call[1] === 'step' && (call[2] as { step?: string } | undefined)?.step === 'land-reason')
      .map((call) => call[2] as Record<string, unknown>);
  }

  it('명시된 --commit-message 는 «이미 있는 커밋 제목»을 이긴다', async () => {
    // 🚨 2026-08-28: 워크트리에서 자식 뼈대를 이어받아 `git commit -m wip` 한 뒤 착지했더니
    //   `git log -1 base..HEAD` 가 «먼저» 돌아 제목이 `wip` 이 됐고 --commit-message 가 «통째로» 무시됐다.
    //   그 결과 소스 3파일을 바꾼 착지가 `wip (#13841)` 로 main 에 들어갔다.
    const { manager, upserts } = fakeManager();
    const sink = output();
    const run = (cmd: string, args: readonly string[]) => {
      if (cmd === 'git' && args.join(' ') === 'remote') return { ok: true, out: 'origin\n' };
      if (cmd === 'git' && args.join(' ') === 'remote get-url origin') {
        return { ok: true, out: 'https://github.com/example/repo.git\n' };
      }
      // ⭐ 브랜치에 «이미» 작업 커밋이 있다 — 이것이 옛 동작에서 제목을 가져갔다.
      if (cmd === 'git' && args.includes('--format=%s')) return { ok: true, out: 'wip\n' };
      return { ok: false, out: '' };
    };
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const code = await runPrLand(
        { commitMessage: 'fix(pr-cli 🅣): 제목이 이겨야 한다' },
        { ...baseDeps, run, manager, out: sink.out },
      );
      expect(code).toBe(0);
      expect(upserts[0]?.title).toBe('fix(pr-cli 🅣): 제목이 이겨야 한다');
      expect(upserts[0]?.title).not.toBe('wip');
    } finally {
      logged.mockRestore();
    }
  });

  it('warns once about overlapping recent landings without changing the return value, including during dry-run', async () => {
    const overlapping = landRun(overlapLog);
    const disjoint = landRun(otherLog);
    const overlapSink = output();
    const disjointSink = output();
    const overlapManager = fakeManager();
    const disjointManager = fakeManager();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const overlapCode = await runPrLand({}, { ...baseDeps, run: overlapping.run, manager: overlapManager.manager, out: overlapSink.out });
      const disjointCode = await runPrLand({}, { ...baseDeps, run: disjoint.run, manager: disjointManager.manager, out: disjointSink.out });
      expect(overlapCode).toBe(disjointCode);
      expect(overlapCode).toBe(0);
      const overlapLine = overlapSink.logs.find((line) => line.includes('overlap'));
      expect(overlapLine).toBeDefined();
      expect(overlapLine).toContain('src/land.ts');
      expect(overlapLine).toContain('2회');
      expect(overlapLine).toContain('--hold');
      expect(overlapLine?.includes('\n')).toBe(false);
      expect(overlapLine).toBe('⚠ overlap: src/land.ts (2회) — 같은 파일을 최근 착지가 건드렸습니다. 쌓아 두려면 pr land --hold 를 쓰십시오.');
      expect(disjointSink.logs.some((line) => line.includes('overlap'))).toBe(false);
      expect(disjointSink.errors.some((line) => line.includes('overlap'))).toBe(false);
      expect(overlapManager.calls).toEqual(['find', 'upsert', 'merge']);
      expect(disjointManager.calls).toEqual(['find', 'upsert', 'merge']);
      const overlapLogCall = overlapping.commands.find(({ cmd, args }) => cmd === 'git' && args[0] === 'log');
      expect(overlapLogCall).toBeDefined();
      expect(overlapping.commands.filter(({ cmd, args }) => cmd === 'gh' && args[0] === 'log')).toEqual([]);
      expect(overlapping.commands.some(({ cmd, args }) => cmd === 'git' && args[0] === 'log' && args.some((arg) => arg.startsWith('--since=')))).toBe(true);
      expect(overlapSteps(logged)).toEqual([
        expect.objectContaining({ step: 'overlap', ok: true, outcome: 'found', overlappingFileCount: 1, comparedLandingCount: 2 }),
        expect.objectContaining({ step: 'overlap', ok: true, outcome: 'none' }),
      ]);

      const dry = landRun(overlapLog);
      const drySink = output();
      const dryManager = fakeManager();
      expect(await runPrLand({ dryRun: true }, { ...baseDeps, run: dry.run, manager: dryManager.manager, out: drySink.out })).toBe(0);
      expect(drySink.logs.find((line) => line.includes('overlap'))).toContain('src/land.ts');
      expect(dryManager.calls).toEqual(['find']);
      expect(dryManager.upserts).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  it('does not emit an overlap line when current files miss the recent landing set', async () => {
    const { run } = landRun(otherLog, 'src/land.ts\n');
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({}, { ...baseDeps, run, manager: fakeManager().manager, out: sink.out })).toBe(0);
      expect(sink.logs.join('\n')).not.toContain('overlap');
      expect(sink.errors.join('\n')).not.toContain('overlap');
      expect(overlapSteps(logged)).toEqual([
        expect.objectContaining({ step: 'overlap', ok: true, outcome: 'none' }),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('records four distinct overlap outcomes and treats lookup failure as unsuccessful', async () => {
    const twoFileLog = [
      'commit aaa111bbb222ccc333ddd444eee555fff666aaa',
      'src/land.ts',
      '',
      'commit bbb222ccc333ddd444eee555fff666aaa111bbb',
      'src/other.ts',
    ].join('\n');
    const empty = landRun('', '', '');
    const failed = landRun(overlapLog, 'src/land.ts\n', ' M src/land.ts\0', { logOk: false });
    const none = landRun(otherLog);
    const found = landRun(twoFileLog, 'src/land.ts\nsrc/other.ts\n', ' M src/land.ts\0 M src/other.ts\0');
    const emptySink = output();
    const failedSink = output();
    const noneSink = output();
    const foundSink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const emptyCode = await runPrLand({}, { ...baseDeps, run: empty.run, manager: fakeManager().manager, out: emptySink.out });
      const failedCode = await runPrLand({}, { ...baseDeps, run: failed.run, manager: fakeManager().manager, out: failedSink.out });
      const noneCode = await runPrLand({}, { ...baseDeps, run: none.run, manager: fakeManager().manager, out: noneSink.out });
      const foundCode = await runPrLand({}, { ...baseDeps, run: found.run, manager: fakeManager().manager, out: foundSink.out });
      expect([emptyCode, failedCode, noneCode, foundCode]).toEqual([0, 0, 0, 0]);
      const steps = overlapSteps(logged);
      expect(steps.map((step) => step.outcome)).toEqual(['no-changed-files', 'lookup-failed', 'none', 'found']);
      expect(new Set(steps.map((step) => step.outcome)).size).toBe(4);
      expect(steps[0]).toEqual(expect.objectContaining({ step: 'overlap', ok: true, outcome: 'no-changed-files' }));
      expect(steps[1]).toEqual(expect.objectContaining({ step: 'overlap', ok: false, outcome: 'lookup-failed' }));
      expect(steps[2]).toEqual(expect.objectContaining({ step: 'overlap', ok: true, outcome: 'none' }));
      expect(steps[3]).toEqual(expect.objectContaining({
        step: 'overlap',
        ok: true,
        outcome: 'found',
        overlappingFileCount: 2,
        comparedLandingCount: 2,
      }));
      expect(steps[1]?.ok).not.toBe(steps[2]?.ok);
      expect(steps[1]?.outcome).not.toBe(steps[2]?.outcome);
      expect(emptySink.logs.some((line) => line.includes('overlap'))).toBe(false);
      expect(failedSink.logs.some((line) => line.includes('overlap'))).toBe(false);
      expect(noneSink.logs.some((line) => line.includes('overlap'))).toBe(false);
      expect(foundSink.logs.find((line) => line.includes('overlap'))).toBe(
        '⚠ overlap: src/land.ts (1회), src/other.ts (1회) — 같은 파일을 최근 착지가 건드렸습니다. 쌓아 두려면 pr land --hold 를 쓰십시오.',
      );
      expect(failed.commands.filter(({ cmd, args }) => cmd === 'gh' && args[0] === 'log')).toEqual([]);
      expect(found.commands.some(({ cmd, args }) => cmd === 'git' && args[0] === 'log')).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });

  it('prints recent-landings after base and before tsc-gate and overlap, recording the rate once', async () => {
    const { run } = landRun(twoRecentLandingLog(), 'src/land.ts\n', ' M src/land.ts\0', { email: RECENT_AUTHOR });
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const code = await runPrLand({ dryRun: true }, {
        ...baseDeps,
        run,
        manager: fakeManager().manager,
        out: sink.out,
        runTypecheckGate: (gateOut) => {
          gateOut.log('[tsc-gate] PASS — 변경 파일에 신규 타입 에러 없음.');
          return true;
        },
      });
      expect(code).toBe(0);
      const baseIdx = logIndex(sink.logs, (line) => line.startsWith('✓ base:'));
      const recentIdx = logIndex(sink.logs, (line) => line.startsWith('⚠ recent-landings:'));
      const tscIdx = logIndex(sink.logs, (line) => line.includes('[tsc-gate]'));
      const overlapIdx = logIndex(sink.logs, (line) => line.startsWith('⚠ overlap:'));
      expect(baseIdx).toBeGreaterThanOrEqual(0);
      expect(recentIdx).toBeGreaterThan(baseIdx);
      expect(tscIdx).toBeGreaterThan(recentIdx);
      expect(overlapIdx).toBeGreaterThan(tscIdx);
      expect(sink.logs.filter((line) => line.startsWith('⚠ recent-landings:'))).toHaveLength(1);
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
    } finally {
      logged.mockRestore();
    }
  });

  it('omits the recent-landings line and records recentCount 0 when landing history lookup fails, without changing the exit code', async () => {
    const failed = landRun(twoRecentLandingLog(), 'src/land.ts\n', ' M src/land.ts\0', { logOk: false, email: RECENT_AUTHOR });
    const succeeded = landRun(twoRecentLandingLog(), 'src/land.ts\n', ' M src/land.ts\0', { email: RECENT_AUTHOR });
    const failedSink = output();
    const succeededSink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const failedCode = await runPrLand({ dryRun: true }, { ...baseDeps, run: failed.run, manager: fakeManager().manager, out: failedSink.out });
      const succeededCode = await runPrLand({ dryRun: true }, { ...baseDeps, run: succeeded.run, manager: fakeManager().manager, out: succeededSink.out });
      expect(failedCode).toBe(succeededCode);
      expect(failedCode).toBe(0);
      expect(failedSink.logs.some((line) => line.includes('recent-landings'))).toBe(false);
      expect(succeededSink.logs.some((line) => line.startsWith('⚠ recent-landings:'))).toBe(true);
      const failedRate = recentLandingSteps(logged).filter((step) => step.recentCount === 0);
      expect(failedRate).toEqual([
        expect.objectContaining({
          step: 'recent-landing-rate',
          ok: true,
          recentCount: 0,
          windowMinutes: 30,
          emitted: false,
          scope: 'repository',
          hasPrevious: false,
        }),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps the overlap advisory after isolation-gate and before find, with unchanged wording', async () => {
    const { run } = landRun(twoRecentLandingLog(), 'src/land.ts\n', ' M src/land.ts\0', { email: RECENT_AUTHOR });
    const sink = output();
    expect(await runPrLand({ dryRun: true }, { ...baseDeps, run, manager: fakeManager().manager, out: sink.out })).toBe(0);
    const isolationIdx = logIndex(sink.logs, (line) => line.startsWith('✓ isolation-gate:'));
    const overlapIdx = logIndex(sink.logs, (line) => line.startsWith('⚠ overlap:'));
    const findIdx = logIndex(sink.logs, (line) => line.startsWith('✓ find:'));
    expect(isolationIdx).toBeGreaterThanOrEqual(0);
    expect(overlapIdx).toBeGreaterThan(isolationIdx);
    expect(findIdx).toBeGreaterThan(overlapIdx);
    expect(sink.logs[overlapIdx]).toBe('⚠ overlap: src/land.ts (2회) — 같은 파일을 최근 착지가 건드렸습니다. 쌓아 두려면 pr land --hold 를 쓰십시오.');
    const recentIdx = logIndex(sink.logs, (line) => line.startsWith('⚠ recent-landings:'));
    expect(recentIdx).toBeGreaterThanOrEqual(0);
    expect(recentIdx).toBeLessThan(overlapIdx);
  });

  it('prints land-reason after both advisories, records observation fields, and keeps dry-run exit codes equal with or without a reason', async () => {
    const missing = landRun(twoRecentLandingLog(), 'src/land.ts\n', ' M src/land.ts\0', { email: RECENT_AUTHOR });
    const given = landRun(twoRecentLandingLog(), 'src/land.ts\n', ' M src/land.ts\0', { email: RECENT_AUTHOR });
    const missingSink = output();
    const givenSink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const missingCode = await runPrLand({ dryRun: true }, {
        ...baseDeps, run: missing.run, manager: fakeManager().manager, out: missingSink.out,
      });
      const givenCode = await runPrLand({ dryRun: true, landReason: '채널이 기다림' }, {
        ...baseDeps, run: given.run, manager: fakeManager().manager, out: givenSink.out,
      });
      expect(missingCode).toBe(givenCode);
      expect(missingCode).toBe(0);

      const recentIdx = logIndex(missingSink.logs, (line) => line.startsWith('⚠ recent-landings:'));
      const overlapIdx = logIndex(missingSink.logs, (line) => line.startsWith('⚠ overlap:'));
      const reasonIdx = logIndex(missingSink.logs, (line) => line.startsWith('⚠ land-reason:'));
      const findIdx = logIndex(missingSink.logs, (line) => line.startsWith('✓ find:'));
      expect(recentIdx).toBeGreaterThanOrEqual(0);
      expect(overlapIdx).toBeGreaterThan(recentIdx);
      expect(reasonIdx).toBeGreaterThan(overlapIdx);
      expect(findIdx).toBeGreaterThan(reasonIdx);
      expect(missingSink.logs[recentIdx]?.startsWith('⚠ recent-landings:')).toBe(true);
      expect(missingSink.logs[overlapIdx]).toBe('⚠ overlap: src/land.ts (2회) — 같은 파일을 최근 착지가 건드렸습니다. 쌓아 두려면 pr land --hold 를 쓰십시오.');
      expect(missingSink.logs[reasonIdx]).toBe('⚠ land-reason: 권고가 떴는데 이유가 없습니다 — 지금 내야 한다면 --land-reason 으로 한 줄 남기십시오.');

      const givenRecentIdx = logIndex(givenSink.logs, (line) => line.startsWith('⚠ recent-landings:'));
      const givenOverlapIdx = logIndex(givenSink.logs, (line) => line.startsWith('⚠ overlap:'));
      const givenReasonIdx = logIndex(givenSink.logs, (line) => line.startsWith('✓ land-reason:'));
      expect(givenOverlapIdx).toBeGreaterThan(givenRecentIdx);
      expect(givenReasonIdx).toBeGreaterThan(givenOverlapIdx);
      expect(givenSink.logs[givenOverlapIdx]).toBe('⚠ overlap: src/land.ts (2회) — 같은 파일을 최근 착지가 건드렸습니다. 쌓아 두려면 pr land --hold 를 쓰십시오.');
      expect(givenSink.logs[givenReasonIdx]).toBe('✓ land-reason: 채널이 기다림');

      expect(landReasonSteps(logged)).toEqual([
        expect.objectContaining({ step: 'land-reason', ok: true, advisoryShown: true, hasReason: false, reasonLength: 0, reasonLengthUnit: 'codepoint' }),
        expect.objectContaining({ step: 'land-reason', ok: true, advisoryShown: true, hasReason: true, reasonLength: codePointLength('채널이 기다림'), reasonLengthUnit: 'codepoint' }),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('does not print land-reason when no advisory was shown even if a reason is given', async () => {
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({ dryRun: true, landReason: 'x' }, {
        ...baseDeps, manager: fakeManager().manager, out: sink.out,
      })).toBe(0);
      expect(sink.logs.some((line) => line.includes('land-reason'))).toBe(false);
      expect(landReasonSteps(logged)).toEqual([
        expect.objectContaining({ step: 'land-reason', ok: true, advisoryShown: false, hasReason: true, reasonLength: 1, reasonLengthUnit: 'codepoint' }),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('truncates a long --land-reason through the command path without embedding the original 200 characters', async () => {
    const reason = 'x'.repeat(200);
    const { run } = landRun(overlapLog);
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({ dryRun: true, landReason: reason }, {
        ...baseDeps, run, manager: fakeManager().manager, out: sink.out,
      })).toBe(0);
      const line = sink.logs.find((entry) => entry.startsWith('✓ land-reason:'));
      expect(line).toBe(`✓ land-reason: ${'x'.repeat(157)}...`);
      expect(line).not.toContain(reason);
      expect(landReasonSteps(logged)).toEqual([
        expect.objectContaining({ step: 'land-reason', ok: true, advisoryShown: true, hasReason: true, reasonLength: 200, reasonLengthUnit: 'codepoint' }),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('records emoji land-reason length in code points, not UTF-16 units', async () => {
    const reason = '🅣 세 트랙 공동 실측 🎯';
    expect(reason.length).toBe(16);
    expect(codePointLength(reason)).toBe(14);
    const { run } = landRun(overlapLog);
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({ dryRun: true, landReason: reason }, {
        ...baseDeps, run, manager: fakeManager().manager, out: sink.out,
      })).toBe(0);
      expect(landReasonSteps(logged)).toEqual([
        expect.objectContaining({
          step: 'land-reason',
          ok: true,
          advisoryShown: true,
          hasReason: true,
          reasonLength: 14,
          reasonLengthUnit: 'codepoint',
        }),
      ]);
      expect(landReasonSteps(logged)[0]?.reasonLength).not.toBe(reason.length);
    } finally {
      logged.mockRestore();
    }
  });

  it('prints the previous landing subject after the recent-landings count', async () => {
    const { run } = landRun(twoRecentLandingLog(), 'src/land.ts\n', ' M src/land.ts\0', { email: RECENT_AUTHOR });
    const sink = output();
    expect(await runPrLand({ dryRun: true }, { ...baseDeps, run, manager: fakeManager().manager, out: sink.out })).toBe(0);
    const recent = sink.logs.find((line) => line.startsWith('⚠ recent-landings:'));
    expect(recent).toBeDefined();
    expect(recent?.split('\n')[1]).toMatch(/^   직전 착지: "docs\(cli\): one" \(\d+분 전\)$/);
  });

  it('emits the commit-message fallback after base and before tsc-gate when only --title is given', async () => {
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({
        title: 'docs(cli): land',
        dryRun: true,
      }, {
        ...baseDeps,
        manager: fakeManager().manager,
        out: sink.out,
        runTypecheckGate: (gateOut) => {
          gateOut.log('[tsc-gate] PASS — 변경 파일에 신규 타입 에러 없음.');
          return true;
        },
      })).toBe(0);
      const baseIdx = logIndex(sink.logs, (line) => line.startsWith('✓ base:'));
      const noticeIdx = logIndex(sink.logs, (line) => line.startsWith('⚠ commit-message:'));
      const tscIdx = logIndex(sink.logs, (line) => line.includes('[tsc-gate]'));
      expect(baseIdx).toBeGreaterThanOrEqual(0);
      expect(noticeIdx).toBeGreaterThan(baseIdx);
      expect(tscIdx).toBeGreaterThan(noticeIdx);
      expect(sink.logs[noticeIdx]).toBe(
        '⚠ commit-message: --title 은 PR 제목에만 쓰입니다. 커밋 메시지는 "chore: land feat/land" 가 됩니다 — 같은 문면을 남기려면 --commit-message 를 함께 주십시오.',
      );
      expect(commitMessageFallbackSteps(logged)).toEqual([
        expect.objectContaining({
          step: 'commit-message-fallback',
          ok: true,
          branch: 'feat/land',
          hadTitle: true,
          emitted: true,
        }),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('suppresses the commit-message fallback when --title and --commit-message are both given', async () => {
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({
        title: 'docs(cli): land',
        commitMessage: 'docs(cli): land',
        dryRun: true,
      }, { ...baseDeps, manager: fakeManager().manager, out: sink.out })).toBe(0);
      expect(sink.logs.some((line) => line.startsWith('⚠ commit-message:'))).toBe(false);
      expect(commitMessageFallbackSteps(logged)).toEqual([
        expect.objectContaining({
          step: 'commit-message-fallback',
          ok: true,
          branch: 'feat/land',
          hadTitle: true,
          emitted: false,
        }),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('suppresses the commit-message fallback when --commit-message-file is given and still records emitted false', async () => {
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({
        title: 'docs(cli): land',
        commitMessageFile: '/tmp/commit-message.txt',
        dryRun: true,
      }, {
        ...baseDeps,
        manager: fakeManager().manager,
        out: sink.out,
        readFile: () => 'docs(cli): from-file',
      })).toBe(0);
      expect(sink.logs.some((line) => line.startsWith('⚠ commit-message:'))).toBe(false);
      expect(commitMessageFallbackSteps(logged)).toEqual([
        expect.objectContaining({
          step: 'commit-message-fallback',
          ok: true,
          branch: 'feat/land',
          hadTitle: true,
          emitted: false,
        }),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps the default landing commit message as chore: land ${branch}', async () => {
    const { manager, upserts } = fakeManager();
    const sink = output();
    expect(await runPrLand({ title: 'docs(cli): land' }, { ...baseDeps, manager, out: sink.out })).toBe(0);
    expect(upserts[0]?.commitMessage).toBe('chore: land feat/land');
    expect(upserts[0]?.title).toBe('docs(cli): land');
  });

  it('does not emit recent-landings when there is only one recent landing', async () => {
    const { run } = landRun(oneRecentLandingLog(), 'src/land.ts\n', ' M src/land.ts\0', { email: RECENT_AUTHOR });
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({ dryRun: true }, { ...baseDeps, run, manager: fakeManager().manager, out: sink.out })).toBe(0);
      expect(sink.logs.some((line) => line.includes('recent-landings'))).toBe(false);
      expect(recentLandingSteps(logged)).toEqual([
        expect.objectContaining({
          step: 'recent-landing-rate',
          ok: true,
          recentCount: 1,
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

  it('holds a new or reused PR after upsert and never calls merge, while non-hold still merges', async () => {
    const heldNew = fakeManager();
    const heldNewSink = output();
    expect(await runPrLand({ hold: true }, { ...baseDeps, manager: heldNew.manager, out: heldNewSink.out })).toBe(0);
    expect(heldNew.calls).toEqual(['find', 'upsert']);
    expect(heldNew.upserts).toEqual([expect.objectContaining({ draft: true, branch: 'feat/land' })]);
    expect(heldNewSink.logs.some((line) => line.includes('hold'))).toBe(true);
    expect(heldNewSink.logs.join('\n')).not.toContain('✓ merge:');

    const heldReusedBox = fakeManager();
    const heldReusedManager: PrManager = {
      ...heldReusedBox.manager,
      findPrForBranchOutcome: () => {
        heldReusedBox.calls.push('find');
        return { status: 'ok OUTPUT', url: 'https://github.com/example/repo/pull/7' };
      },
      upsertPr: (input) => {
        heldReusedBox.calls.push('upsert');
        heldReusedBox.upserts.push(input);
        return { ok: true, url: 'https://github.com/example/repo/pull/7', reused: true };
      },
    };
    const heldReusedSink = output();
    expect(await runPrLand({ hold: true }, { ...baseDeps, manager: heldReusedManager, out: heldReusedSink.out })).toBe(0);
    expect(heldReusedBox.calls).toEqual(['find', 'upsert']);
    expect(heldReusedBox.upserts[0]?.draft).toBe(true);
    expect(heldReusedSink.logs).toContain('✓ upsert-ready: https://github.com/example/repo/pull/7 (기존 PR)');

    const merged = fakeManager();
    expect(await runPrLand({}, { ...baseDeps, manager: merged.manager, out: output().out })).toBe(0);
    expect(merged.calls).toEqual(['find', 'upsert', 'merge']);
    expect(merged.upserts[0]?.draft).toBe(false);
  });

  it('dry-run --hold plans to stop before merge and still prints overlap', async () => {
    const { run } = landRun(overlapLog);
    const { manager, calls, upserts } = fakeManager();
    const sink = output();
    expect(await runPrLand({ dryRun: true, hold: true }, { ...baseDeps, run, manager, out: sink.out })).toBe(0);
    expect(calls).toEqual(['find']);
    expect(upserts).toEqual([]);
    expect(sink.logs.find((line) => line.includes('overlap'))).toContain('src/land.ts');
    expect(sink.logs.at(-1)).toBe('[dry-run] PR을 생성하고 --hold 로 병합하지 않고 멈춥니다.');
  });

  it('maps HITL confirm results to three observably distinct overlap landing outcomes', () => {
    const userMerge = overlapDecisionFromConfirm({ answer: true, channel: 'terminal', elapsedMs: 0 });
    const userHold = overlapDecisionFromConfirm({ answer: false, channel: 'terminal', elapsedMs: 0 });
    const unavailable = overlapDecisionFromConfirm({ answer: true, channel: 'all-failed', elapsedMs: 0 });
    const timedOut = overlapDecisionFromConfirm({ answer: true, channel: 'timeout', elapsedMs: 0 });
    expect(userMerge.outcome).toBe('user-merge');
    expect(userHold.outcome).toBe('user-hold');
    expect(unavailable.outcome).toBe('unavailable');
    expect(timedOut.outcome).toBe('unavailable');
    expect(new Set([userMerge.outcome, userHold.outcome, unavailable.outcome]).size).toBe(3);
    expect(unavailable.outcome).not.toBe(userMerge.outcome);
    const collapsed = (result: ConfirmResult) => result.answer ? 'user-merge' : 'user-hold';
    expect(collapsed({ answer: true, channel: 'all-failed', elapsedMs: 0 })).toBe(collapsed({ answer: true, channel: 'terminal', elapsedMs: 0 }));
    expect(unavailable.outcome).not.toBe(collapsed({ answer: true, channel: 'all-failed', elapsedMs: 0 }));
  });

  it('asks through requestConfirmation only when interactive and preserves no-channel as unavailable', async () => {
    const seen: ConfirmOpts[] = [];
    const unavailable = await decideOverlapLanding({
      isInteractive: () => false,
      requestConfirmation: async (opts) => {
        seen.push(opts);
        return { answer: true, channel: 'all-failed', elapsedMs: 0 };
      },
    });
    expect(unavailable).toEqual({ outcome: 'unavailable', channel: 'all-failed', interactive: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe(OVERLAP_DECISION_PROMPT);
    expect(seen[0]?.channels).toEqual([]);
    expect(seen[0]?.yesLabel).toBe('그대로 병합');
    expect(seen[0]?.noLabel).toBe('쌓아 두기');

    seen.length = 0;
    const held = await decideOverlapLanding({
      isInteractive: () => true,
      requestConfirmation: async (opts) => {
        seen.push(opts);
        return { answer: false, channel: 'terminal', elapsedMs: 1 };
      },
    });
    expect(held).toEqual({ outcome: 'user-hold', channel: 'terminal', interactive: true });
    expect(seen[0]?.channels?.length).toBe(1);
  });

  it('stops before merge when overlap is found and the user chooses hold', async () => {
    const { run } = landRun(overlapLog);
    const { manager, calls, upserts } = fakeManager();
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({}, {
        ...baseDeps,
        run,
        manager,
        out: sink.out,
        isInteractive: () => true,
        decideOverlapLanding: () => ({ outcome: 'user-hold', channel: 'terminal', interactive: true }),
      })).toBe(0);
      expect(calls).toEqual(['find', 'upsert']);
      expect(upserts[0]?.draft).toBe(true);
      expect(sink.logs.some((line) => line.includes('hold'))).toBe(true);
      expect(sink.logs.join('\n')).not.toContain('✓ merge:');
      expect(overlapDecisionSteps(logged)).toEqual([
        expect.objectContaining({ step: 'overlap-decision', outcome: 'user-hold', channel: 'terminal', interactive: true }),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('merges when overlap is found and the user chooses to continue', async () => {
    const { run } = landRun(overlapLog);
    const { manager, calls } = fakeManager();
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({}, {
        ...baseDeps,
        run,
        manager,
        out: sink.out,
        isInteractive: () => true,
        decideOverlapLanding: () => ({ outcome: 'user-merge', channel: 'terminal', interactive: true }),
      })).toBe(0);
      expect(calls).toEqual(['find', 'upsert', 'merge']);
      expect(overlapDecisionSteps(logged)).toEqual([
        expect.objectContaining({ step: 'overlap-decision', outcome: 'user-merge', channel: 'terminal', interactive: true }),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('merges when overlap is found but confirmation is unavailable, distinct from a user merge choice', async () => {
    const { run } = landRun(overlapLog);
    const { manager, calls } = fakeManager();
    const sink = output();
    const confirmCalls: ConfirmOpts[] = [];
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({}, {
        ...baseDeps,
        run,
        manager,
        out: sink.out,
        isInteractive: () => false,
        requestConfirmation: async (opts) => {
          confirmCalls.push(opts);
          return { answer: true, channel: 'all-failed', elapsedMs: 0 };
        },
      })).toBe(0);
      expect(calls).toEqual(['find', 'upsert', 'merge']);
      expect(confirmCalls).toHaveLength(1);
      expect(confirmCalls[0]?.channels).toEqual([]);
      expect(overlapDecisionSteps(logged)).toEqual([
        expect.objectContaining({ step: 'overlap-decision', outcome: 'unavailable', channel: 'all-failed', interactive: false }),
      ]);
      expect(overlapDecisionSteps(logged)[0]?.outcome).not.toBe('user-merge');
    } finally {
      logged.mockRestore();
    }
  });

  it('does not ask on a no-overlap landing and still merges', async () => {
    const { run } = landRun(otherLog);
    const { manager, calls } = fakeManager();
    const sink = output();
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
      expect(overlapDecisionSteps(logged)).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  it('closes readline when the real overlap confirm channel is cancelled', async () => {
    const input = new PassThrough();
    const capturedOut = new PassThrough();
    capturedOut.resume();
    const channel = createOverlapConfirmChannel({ input, output: capturedOut });
    const pending = channel.request({ prompt: 'x', yesLabel: '그대로 병합', noLabel: '쌓아 두기' });
    expect(input.listenerCount('data') + input.listenerCount('keypress') + input.listenerCount('end')).toBeGreaterThan(0);
    await channel.cancel();
    expect(await pending).toBeNull();
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('keypress')).toBe(0);
    input.destroy();
    capturedOut.destroy();
  });

  it('uses real requestConfirmation with no channels when not interactive', async () => {
    const decision = await decideOverlapLanding({ isInteractive: () => false });
    expect(decision).toEqual({ outcome: 'unavailable', channel: 'all-failed', interactive: false });
    expect(decision.outcome).not.toBe('user-merge');
  });

  it('uses real requestConfirmation so a timed-out overlap channel is unavailable, not user-merge, and closes readline', async () => {
    const input = new PassThrough();
    const capturedOut = new PassThrough();
    capturedOut.resume();
    const channel = createOverlapConfirmChannel({ input, output: capturedOut });
    try {
      const decision = await decideOverlapLanding({
        isInteractive: () => true,
        channels: [channel],
        timeoutMs: 25,
      });
      expect(decision.outcome).toBe('unavailable');
      expect(decision.channel).toBe('timeout');
      expect(decision.interactive).toBe(true);
      expect(decision.outcome).not.toBe('user-merge');
      expect(input.listenerCount('data')).toBe(0);
      expect(input.listenerCount('keypress')).toBe(0);
    } finally {
      input.destroy();
      capturedOut.destroy();
    }
  });

  it('merges immediately through real requestConfirmation when there is no confirm channel', async () => {
    const { run } = landRun(overlapLog);
    const { manager, calls } = fakeManager();
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({}, {
        ...baseDeps,
        run,
        manager,
        out: sink.out,
        isInteractive: () => false,
      })).toBe(0);
      expect(calls).toEqual(['find', 'upsert', 'merge']);
      expect(overlapDecisionSteps(logged)).toEqual([
        expect.objectContaining({ step: 'overlap-decision', outcome: 'unavailable', channel: 'all-failed', interactive: false }),
      ]);
      expect(overlapDecisionSteps(logged)[0]?.outcome).not.toBe('user-merge');
    } finally {
      logged.mockRestore();
    }
  });

  it('times out the real overlap confirm channel via requestConfirmation, closes readline, and still merges', async () => {
    const input = new PassThrough();
    const capturedOut = new PassThrough();
    capturedOut.resume();
    const channel = createOverlapConfirmChannel({ input, output: capturedOut });
    const { run } = landRun(overlapLog);
    const { manager, calls } = fakeManager();
    const sink = output();
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({}, {
        ...baseDeps,
        run,
        manager,
        out: sink.out,
        isInteractive: () => true,
        overlapConfirmChannels: [channel],
        overlapConfirmTimeoutMs: 25,
      })).toBe(0);
      expect(calls).toEqual(['find', 'upsert', 'merge']);
      expect(overlapDecisionSteps(logged)).toEqual([
        expect.objectContaining({ step: 'overlap-decision', outcome: 'unavailable', channel: 'timeout', interactive: true }),
      ]);
      expect(overlapDecisionSteps(logged)[0]?.outcome).not.toBe('user-merge');
      expect(input.listenerCount('data')).toBe(0);
      expect(input.listenerCount('keypress')).toBe(0);
    } finally {
      logged.mockRestore();
      input.destroy();
      capturedOut.destroy();
    }
  });

  it('fails this check if unavailable confirmation is recorded as a user merge choice', () => {
    const unavailable = overlapDecisionFromConfirm({ answer: true, channel: 'all-failed', elapsedMs: 0 });
    const timedOut = overlapDecisionFromConfirm({ answer: true, channel: 'timeout', elapsedMs: 0 });
    const userMerge = overlapDecisionFromConfirm({ answer: true, channel: 'terminal', elapsedMs: 0 });
    const collapsed = (result: ConfirmResult) => (result.answer ? 'user-merge' : 'user-hold');
    expect(collapsed({ answer: true, channel: 'all-failed', elapsedMs: 0 })).toBe('user-merge');
    expect(unavailable.outcome).not.toBe(collapsed({ answer: true, channel: 'all-failed', elapsedMs: 0 }));
    expect(timedOut.outcome).not.toBe(userMerge.outcome);
    expect(unavailable.channel).toBe('all-failed');
    expect(timedOut.channel).toBe('timeout');
  });

  it('does not ask when --hold is already set even if overlap is found', async () => {
    const { run } = landRun(overlapLog);
    const { manager, calls, upserts } = fakeManager();
    const sink = output();
    let asked = 0;
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(await runPrLand({ hold: true }, {
        ...baseDeps,
        run,
        manager,
        out: sink.out,
        decideOverlapLanding: () => {
          asked += 1;
          return { outcome: 'user-merge', channel: 'terminal', interactive: true };
        },
      })).toBe(0);
      expect(asked).toBe(0);
      expect(calls).toEqual(['find', 'upsert']);
      expect(upserts[0]?.draft).toBe(true);
      expect(sink.logs.find((line) => line.includes('overlap'))).toBe('⚠ overlap: src/land.ts (2회) — 같은 파일을 최근 착지가 건드렸습니다. 쌓아 두려면 pr land --hold 를 쓰십시오.');
      expect(overlapDecisionSteps(logged)).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  it('registers pr land --hold so the runtime caller reaches runPrLand without merging', async () => {
    const { manager, calls, upserts } = fakeManager();
    const sink = output();
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, manager, out: sink.out });
    await program.parseAsync(['pr', 'land', '--hold'], { from: 'user' });
    expect(calls).toEqual(['find', 'upsert']);
    expect(upserts[0]?.draft).toBe(true);
    expect(sink.logs.some((line) => line.includes('hold'))).toBe(true);
  });

  it('registers --force-freeze with a required reason through the command path', async () => {
    const program = new Command();
    program.exitOverride();
    const sink = output();
    const { manager, calls } = fakeManager();
    const exitCodes: number[] = [];
    registerPrCommands(program, { ...baseDeps, manager, out: sink.out, setExitCode: (code) => exitCodes.push(code) });
    const land = program.commands.find((command) => command.name() === 'pr')?.commands.find((command) => command.name() === 'land');
    expect(land?.helpInformation()).toContain('--force-freeze <reason>');
    expect(land?.options.find((option) => option.long === '--force-freeze')?.flags).toContain('<reason>');
    expect(calls).toEqual([]);
    await program.parseAsync(['pr', 'land', '--force-freeze', ' '], { from: 'user' });
    expect(calls).toEqual([]);
    expect(sink.errors.join('\n')).toContain('--force-freeze');
    expect(exitCodes).toEqual([1]);
  });

  it('registers pr land --land-reason in help and passes the reason into runPrLand', async () => {
    const { manager, calls } = fakeManager();
    const sink = output();
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, manager, out: sink.out });
    const land = program.commands.find((command) => command.name() === 'pr')
      ?.commands.find((command) => command.name() === 'land');
    expect(land?.options.some((option) => option.long === '--land-reason')).toBe(true);
    expect(land?.helpInformation()).toContain('--land-reason');
    expect(land?.helpInformation()).toContain('권고를 보고도 지금 내는 이유(예: 남이 기다리는 차단 해제)');
    const { run } = landRun(overlapLog);
    const wired = new Command();
    wired.exitOverride();
    registerPrCommands(wired, { ...baseDeps, run, manager, out: sink.out });
    await wired.parseAsync(['pr', 'land', '--dry-run', '--land-reason', '남이 기다리는 차단 해제'], { from: 'user' });
    expect(calls).toEqual(['find']);
    expect(sink.logs.find((line) => line.startsWith('✓ land-reason:'))).toBe('✓ land-reason: 남이 기다리는 차단 해제');
  });

  it('keeps pr land --dry-run without --pr on the existing branch preview path', async () => {
    const { manager, calls } = fakeManager();
    const sink = output();
    const { run, commands } = landRun(overlapLog);
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, manager, out: sink.out });

    await program.parseAsync(['pr', 'land', '--dry-run'], { from: 'user' });

    expect(sink.errors).toEqual([]);
    expect(sink.logs).toContain('✓ branch: feat/land');
    expect(sink.logs.at(-1)).toBe('[dry-run] 머리 고정 없는 일반 착지: PR을 생성하고 ready 상태를 보장한 뒤 squash merge 합니다.');
    expect(calls).toEqual(['find']);
    expect(commands.some(({ cmd, args }) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'view')).toBe(false);
  });
});

describe('elanous pr granularity', () => {
  it('registers the command and reports an empty window as unmeasurable without gh or network', async () => {
    const sink = output();
    const commands: Array<{ cmd: string; args: readonly string[] }> = [];
    const run = (cmd: string, args: readonly string[]) => {
      commands.push({ cmd, args });
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: '' };
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity', '--since', '1 day ago'], { from: 'user' });
    expect(commands.every(({ cmd }) => cmd !== 'gh')).toBe(true);
    expect(commands.some(({ cmd, args }) => cmd === 'git' && args[0] === 'log' && args.includes('--since=1 day ago') && args.includes('origin/main'))).toBe(true);
    expect(commands.some(({ cmd, args }) => cmd === 'git' && args[0] === 'log' && args.includes('HEAD'))).toBe(false);
    expect(sink.logs).toContain('착지 수: 0');
    expect(sink.logs).toContain('단일 파일 착지 비율: 측정할 수 없음 — 이 창에 착지가 없습니다.');
    expect(sink.logs.join('\n')).not.toMatch(/단일 파일 착지: 0/);
    expect(sink.logs.join('\n')).not.toContain('앞머리 미추출');
    expect(sink.logs.join('\n')).not.toContain('착지 앞머리');
    expect(sink.logs.join('\n')).not.toContain('같은 파일을 여러 착지가 건드린 상위');
  });

  it('prints landing counts and repeated-file ranks from local git log through the registered command', async () => {
    const sink = output();
    const log = [
      'commit aaa111bbb222ccc333ddd444eee555fff666aaa docs(🅢): first',
      'docs/topic.md',
      '',
      'commit bbb222ccc333ddd444eee555fff666aaa111bbb docs(🅢): second',
      'docs/topic.md',
    ].join('\n');
    const run = (cmd: string, args: readonly string[]) => {
      if (cmd === 'gh') return { ok: false, out: 'must-not-call-gh' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: log };
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity'], { from: 'user' });
    expect(sink.logs).toContain('착지 수: 2');
    expect(sink.logs).toContain('단일 파일 착지: 2 (100.0%)');
    expect(sink.logs).toContain('착지 앞머리: docs(🅢) 2');
    expect(sink.logs.join('\n')).toContain('docs/topic.md  2  docs(🅢) 2');
    expect(runPrGranularity({ since: '1 day ago' }, { ...baseDeps, run, out: sink.out })).toBe(0);
  });

  it('prints two prefixes as 2 then 1 on a selected repeated-file row from mocked git history', async () => {
    const sink = output();
    const log = [
      'commit aaa111bbb222ccc333ddd444eee555fff666aaa docs(🅢): first',
      'docs/topic.md',
      '',
      'commit bbb222ccc333ddd444eee555fff666aaa111bbb feat(cli): once',
      'docs/topic.md',
      '',
      'commit ccc333ddd444eee555fff666aaa111bbb222ccc docs(🅢): third',
      'docs/topic.md',
      '',
      'commit ddd444eee555fff666aaa111bbb222ccc333ddd feat(cli): singleton',
      'src/once.ts',
    ].join('\n');
    const commands: Array<{ cmd: string; args: readonly string[] }> = [];
    const run = (cmd: string, args: readonly string[]) => {
      commands.push({ cmd, args });
      if (cmd === 'gh') return { ok: false, out: 'must-not-call-gh' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: log };
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity'], { from: 'user' });
    const report = sink.logs.join('\n');
    expect(sink.logs).toContain('착지 수: 4');
    expect(sink.logs).toContain('착지 앞머리: docs(🅢) 2, feat(cli) 2');
    expect(report).toContain('docs/topic.md  3  docs(🅢) 2, feat(cli) 1');
    expect(report.indexOf('docs(🅢) 2')).toBeLessThan(report.indexOf('feat(cli) 1'));
    expect(report).not.toContain('src/once.ts');
    expect(commands.every(({ cmd }) => cmd !== 'gh')).toBe(true);
  });

  it('prints an explicit unextractable marker instead of 해당 없음, 0, or empty', async () => {
    const sink = output();
    const log = [
      'commit aaa111bbb222ccc333ddd444eee555fff666aaa plain landing',
      'docs/topic.md',
      '',
      'commit bbb222ccc333ddd444eee555fff666aaa111bbb another prose title',
      'docs/topic.md',
    ].join('\n');
    const run = (cmd: string, args: readonly string[]) => {
      if (cmd === 'gh') return { ok: false, out: 'must-not-call-gh' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: log };
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity'], { from: 'user' });
    const report = sink.logs.join('\n');
    expect(sink.logs).toContain('착지 앞머리: 앞머리 미추출 2');
    expect(report).toContain('docs/topic.md  2  앞머리 미추출 2');
    expect(report).not.toContain('해당 없음');
    expect(report).not.toMatch(/docs\/topic\.md  2\s*$/m);
    expect(report).not.toMatch(/docs\/topic\.md  2  0/);
  });

  it('extracts unscoped 타입: through the CLI and keeps scoped 타입(범위) and prose distinct', async () => {
    const sink = output();
    const log = [
      'commit aaa111bbb222ccc333ddd444eee555fff666aaa docs(🅢): first',
      'docs/topic.md',
      '',
      'commit bbb222ccc333ddd444eee555fff666aaa111bbb test: elanous-config-dir.test.ts (#13663)',
      'docs/topic.md',
      '',
      'commit ccc333ddd444eee555fff666aaa111bbb222ccc tsc 게이트가 「변경 파일」만 봐서 눈이 멀었다 (#13746)',
      'docs/topic.md',
    ].join('\n');
    const run = (cmd: string, args: readonly string[]) => {
      if (cmd === 'gh') return { ok: false, out: 'must-not-call-gh' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: log };
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity'], { from: 'user' });
    const report = sink.logs.join('\n');
    expect(sink.logs).toContain('착지 앞머리: docs(🅢) 1, test 1, 앞머리 미추출 1');
    expect(report).toContain('docs/topic.md  3  docs(🅢) 1, test 1, 앞머리 미추출 1');
    expect(report).not.toContain('착지 앞머리: 앞머리 미추출 3');
    expect(report).not.toContain('test: elanous-config-dir.test.ts');
    expect(runPrGranularity({ since: '1 day ago' }, { ...baseDeps, run, out: sink.out })).toBe(0);
  });

  it('truncates a long prefix list to the code-level limit and names shown of total on that row', async () => {
    const sink = output();
    const kinds = Array.from({ length: TOP_PREFIX_COUNT_LIMIT + 2 }, (_, index) => `docs(kind${index})`);
    const subjects = kinds.flatMap((kind, index) => Array.from({ length: kinds.length - index }, () => `${kind}: landing`));
    const log = subjects.map((subject, index) => {
      const hash = `${(index + 10).toString(16).padStart(2, '0')}`.repeat(20);
      return [`commit ${hash} ${subject}`, 'docs/topic.md', ''].join('\n');
    }).join('\n');
    const commands: Array<{ cmd: string; args: readonly string[] }> = [];
    const run = (cmd: string, args: readonly string[]) => {
      commands.push({ cmd, args });
      if (cmd === 'gh') return { ok: false, out: 'must-not-call-gh' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: log };
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity'], { from: 'user' });
    const row = sink.logs.find((line) => line.includes('docs/topic.md')) ?? '';
    expect(row).toContain(`showing ${TOP_PREFIX_COUNT_LIMIT} of ${kinds.length}`);
    for (const kind of kinds.slice(0, TOP_PREFIX_COUNT_LIMIT)) expect(row).toContain(`${kind} `);
    for (const kind of kinds.slice(TOP_PREFIX_COUNT_LIMIT)) expect(row).not.toContain(kind);
    const summary = sink.logs.find((line) => line.startsWith('착지 앞머리:')) ?? '';
    expect(summary).toContain(`showing ${TOP_PREFIX_COUNT_LIMIT} of ${kinds.length}`);
    expect(commands.every(({ cmd }) => cmd !== 'gh')).toBe(true);
    expect(commands.some(({ cmd, args }) => cmd === 'git' && args[0] === 'log')).toBe(true);
  });

  it('does not append showing N of M on a non-truncated prefix row', async () => {
    const sink = output();
    const kinds = Array.from({ length: TOP_PREFIX_COUNT_LIMIT }, (_, index) => `docs(kind${index})`);
    const log = kinds.map((kind, index) => {
      const hash = `${(index + 10).toString(16).padStart(2, '0')}`.repeat(20);
      return [`commit ${hash} ${kind}: landing`, 'docs/topic.md', ''].join('\n');
    }).join('\n');
    const run = (cmd: string, args: readonly string[]) => {
      if (cmd === 'gh') return { ok: false, out: 'must-not-call-gh' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: log };
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity'], { from: 'user' });
    const row = sink.logs.find((line) => line.includes('docs/topic.md')) ?? '';
    expect(row).toContain(kinds.map((kind) => `${kind} 1`).join(', '));
    expect(row).not.toContain('showing ');
    expect(row).not.toMatch(/ of \d+/);
    const summary = sink.logs.find((line) => line.startsWith('착지 앞머리:')) ?? '';
    expect(summary).toContain(kinds.map((kind) => `${kind} 1`).join(', '));
    expect(summary).not.toContain('showing ');
  });

  it('fails this check if truncation drops the total kind count from showing N of M', async () => {
    const sink = output();
    const kinds = Array.from({ length: TOP_PREFIX_COUNT_LIMIT + 3 }, (_, index) => `feat(scope${index})`);
    const subjects = kinds.flatMap((kind, index) => Array.from({ length: kinds.length - index }, () => `${kind}: landing`));
    const log = subjects.map((subject, index) => {
      const hash = `${(index + 10).toString(16).padStart(2, '0')}`.repeat(20);
      return [`commit ${hash} ${subject}`, 'src/cli/pr-cli.ts', ''].join('\n');
    }).join('\n');
    const run = (cmd: string, args: readonly string[]) => {
      if (cmd === 'gh') return { ok: false, out: 'must-not-call-gh' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: log };
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity'], { from: 'user' });
    const row = sink.logs.find((line) => line.includes('src/cli/pr-cli.ts')) ?? '';
    const shownOfTotal = `, showing ${TOP_PREFIX_COUNT_LIMIT} of ${kinds.length}`;
    const restoredWithoutTotal = row.replace(shownOfTotal, `, showing ${TOP_PREFIX_COUNT_LIMIT}`);
    expect(row).toContain(shownOfTotal);
    expect(row).not.toBe(restoredWithoutTotal);
    expect(restoredWithoutTotal).not.toContain(` of ${kinds.length}`);
    const summary = sink.logs.find((line) => line.startsWith('착지 앞머리:')) ?? '';
    expect(summary).toContain(shownOfTotal);
  });

  it('prints whole-window prefixes as 3 then 2 then 1 from mocked git history', async () => {
    const sink = output();
    const log = [
      'commit aaa111bbb222ccc333ddd444eee555fff666aaa docs(🅢): a',
      'docs/a.md',
      '',
      'commit bbb222ccc333ddd444eee555fff666aaa111bbb docs(🅢): b',
      'docs/b.md',
      '',
      'commit ccc333ddd444eee555fff666aaa111bbb222ccc docs(🅢): c',
      'docs/c.md',
      '',
      'commit ddd444eee555fff666aaa111bbb222ccc333ddd feat(cli): d',
      'src/d.ts',
      '',
      'commit eee555fff666aaa111bbb222ccc333ddd444eee feat(cli): e',
      'src/e.ts',
      '',
      'commit fff666aaa111bbb222ccc333ddd444eee555fff fix(cli): f',
      'src/f.ts',
    ].join('\n');
    const commands: Array<{ cmd: string; args: readonly string[] }> = [];
    const run = (cmd: string, args: readonly string[]) => {
      commands.push({ cmd, args });
      if (cmd === 'gh') return { ok: false, out: 'must-not-call-gh' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: log };
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity'], { from: 'user' });
    const summary = sink.logs.find((line) => line.startsWith('착지 앞머리:')) ?? '';
    expect(summary).toBe('착지 앞머리: docs(🅢) 3, feat(cli) 2, fix(cli) 1');
    expect(summary.indexOf('docs(🅢) 3')).toBeLessThan(summary.indexOf('feat(cli) 2'));
    expect(summary.indexOf('feat(cli) 2')).toBeLessThan(summary.indexOf('fix(cli) 1'));
    expect(sink.logs).toContain('착지 수: 6');
    expect(sink.logs).toContain('단일 파일 착지: 6 (100.0%)');
    expect(sink.logs.join('\n')).not.toContain('같은 파일을 여러 착지가 건드린 상위');
    expect(commands.every(({ cmd }) => cmd !== 'gh')).toBe(true);
    expect(commands.some(({ cmd, args }) => cmd === 'git' && args[0] === 'log')).toBe(true);
  });

  it('truncates the whole-window prefix summary to the code-level limit and names shown of total', async () => {
    const sink = output();
    const kinds = Array.from({ length: TOP_PREFIX_COUNT_LIMIT + 2 }, (_, index) => `docs(kind${index})`);
    const subjects = kinds.flatMap((kind, index) => Array.from({ length: kinds.length - index }, () => `${kind}: landing`));
    const log = subjects.map((subject, index) => {
      const hash = `${(index + 10).toString(16).padStart(2, '0')}`.repeat(20);
      return [`commit ${hash} ${subject}`, `docs/file-${index}.md`, ''].join('\n');
    }).join('\n');
    const commands: Array<{ cmd: string; args: readonly string[] }> = [];
    const run = (cmd: string, args: readonly string[]) => {
      commands.push({ cmd, args });
      if (cmd === 'gh') return { ok: false, out: 'must-not-call-gh' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: log };
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity'], { from: 'user' });
    const summary = sink.logs.find((line) => line.startsWith('착지 앞머리:')) ?? '';
    expect(summary).toContain(`showing ${TOP_PREFIX_COUNT_LIMIT} of ${kinds.length}`);
    for (const kind of kinds.slice(0, TOP_PREFIX_COUNT_LIMIT)) expect(summary).toContain(`${kind} `);
    for (const kind of kinds.slice(TOP_PREFIX_COUNT_LIMIT)) expect(summary).not.toContain(kind);
    expect(commands.every(({ cmd }) => cmd !== 'gh')).toBe(true);
  });

  it('prints two unextractable titles as one window-summary item distinct from 해당 없음', async () => {
    const sink = output();
    const log = [
      'commit aaa111bbb222ccc333ddd444eee555fff666aaa plain landing',
      'docs/a.md',
      '',
      'commit bbb222ccc333ddd444eee555fff666aaa111bbb another prose title',
      'src/b.ts',
    ].join('\n');
    const run = (cmd: string, args: readonly string[]) => {
      if (cmd === 'gh') return { ok: false, out: 'must-not-call-gh' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: log };
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity'], { from: 'user' });
    const summary = sink.logs.find((line) => line.startsWith('착지 앞머리:')) ?? '';
    expect(summary).toBe('착지 앞머리: 앞머리 미추출 2');
    expect(summary).not.toContain('해당 없음');
    expect(sink.logs.join('\n')).not.toContain('같은 파일을 여러 착지가 건드린 상위');
  });

  it('omits the unextractable item from the window summary when every title extracts', async () => {
    const sink = output();
    const log = [
      'commit aaa111bbb222ccc333ddd444eee555fff666aaa docs(🅢): a',
      'docs/a.md',
      '',
      'commit bbb222ccc333ddd444eee555fff666aaa111bbb feat(cli): b',
      'src/b.ts',
    ].join('\n');
    const run = (cmd: string, args: readonly string[]) => {
      if (cmd === 'gh') return { ok: false, out: 'must-not-call-gh' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: log };
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity'], { from: 'user' });
    const summary = sink.logs.find((line) => line.startsWith('착지 앞머리:')) ?? '';
    expect(summary).toBe('착지 앞머리: docs(🅢) 1, feat(cli) 1');
    expect(summary).not.toContain('앞머리 미추출');
    expect(sink.logs.join('\n')).not.toContain('앞머리 미추출');
  });

  it('fails this check if the window prefix summary is dropped from CLI output', async () => {
    const sink = output();
    const log = [
      'commit aaa111bbb222ccc333ddd444eee555fff666aaa docs(🅢): a',
      'docs/a.md',
      '',
      'commit bbb222ccc333ddd444eee555fff666aaa111bbb docs(🅢): b',
      'docs/b.md',
      '',
      'commit ccc333ddd444eee555fff666aaa111bbb222ccc docs(🅢): c',
      'docs/c.md',
      '',
      'commit ddd444eee555fff666aaa111bbb222ccc333ddd feat(cli): d',
      'src/d.ts',
      '',
      'commit eee555fff666aaa111bbb222ccc333ddd444eee feat(cli): e',
      'src/e.ts',
      '',
      'commit fff666aaa111bbb222ccc333ddd444eee555fff fix(cli): f',
      'src/f.ts',
    ].join('\n');
    const run = (cmd: string, args: readonly string[]) => {
      if (cmd === 'gh') return { ok: false, out: 'must-not-call-gh' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: log };
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity'], { from: 'user' });
    expect(sink.logs).toContain('착지 앞머리: docs(🅢) 3, feat(cli) 2, fix(cli) 1');
  });

  it('derives --with-source merged-PR --limit from PR-numbered landings and omits MAYBE_TRUNCATED below the cap', async () => {
    const sink = output();
    const log = [
      'commit aaa111bbb222ccc333ddd444eee555fff666aaa feat: a (#11)',
      'src/cli/pr-cli.ts',
      '',
      'commit bbb222ccc333ddd444eee555fff666aaa111bbb feat: b (#12)',
      'src/cli/pr-cli.ts',
    ].join('\n');
    const ghCalls: Array<readonly string[]> = [];
    const run = (cmd: string, args: readonly string[]) => {
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: log };
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list' && args.includes('merged')) {
        ghCalls.push(args);
        return {
          ok: true,
          out: JSON.stringify([
            { number: 11, headRefName: 'self-impl/x-1111aaaa' },
            { number: 12, headRefName: 'self-impl/x-2222bbbb' },
          ]),
        };
      }
      return baseLookupRun(cmd, args);
    };
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, run, out: sink.out });
    await program.parseAsync(['pr', 'granularity', '--since', '3 hours ago', '--with-source'], { from: 'user' });
    expect(ghCalls).toEqual([
      ['pr', 'list', '--state', 'merged', '--limit', '2', '--json', 'number,headRefName'],
    ]);
    expect(sink.logs.some((line) => line.includes('MAYBE_TRUNCATED'))).toBe(false);
    expect(sink.logs.some((line) => line.includes('조회 창 밖'))).toBe(false);
    expect(sink.logs.some((line) => line.startsWith('같은 골이 낸 착지(계보):'))).toBe(true);
  });

  it('counts only base-branch landings when HEAD has unlanded feature commits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-granularity-base-'));
    try {
      git(dir, 'init', '-b', 'main');
      git(dir, 'config', 'user.email', 'granularity@example.com');
      git(dir, 'config', 'user.name', 'Granularity Test');
      writeFileSync(join(dir, 'landed.md'), 'one\n');
      git(dir, 'add', 'landed.md');
      git(dir, 'commit', '-m', 'base landing 1');
      writeFileSync(join(dir, 'landed.md'), 'two\n');
      git(dir, 'add', 'landed.md');
      git(dir, 'commit', '-m', 'base landing 2');
      git(dir, 'checkout', '-b', 'feat/unlanded');
      writeFileSync(join(dir, 'feature.ts'), 'unlanded\n');
      git(dir, 'add', 'feature.ts');
      git(dir, 'commit', '-m', 'feature-only commit');
      writeFileSync(join(dir, 'landed.md'), 'feature rewrite\n');
      git(dir, 'add', 'landed.md');
      git(dir, 'commit', '-m', 'unlanded rewrite of a landed file');

      const sink = output();
      const program = new Command();
      program.exitOverride();
      registerPrCommands(program, { resolveBase: () => 'main', out: sink.out });
      await program.parseAsync(['pr', 'granularity', '--since', '1 day ago', '--cwd', dir], { from: 'user' });
      expect(sink.logs).toContain('착지 수: 2');
      expect(sink.logs).toContain('단일 파일 착지: 2 (100.0%)');
      expect(sink.logs.join('\n')).toContain('landed.md  2');
      expect(sink.logs.join('\n')).not.toContain('feature.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ⛔⭐⭐ **배선 회귀** — 무인 리뷰(#15932 1차)가 잡은 칸:
//   *「새 경고의 «실제 배선»에 대한 테스트가 없다」*.
//   🩸 그 앞에 `#15905` 가 판별 함수를 «정의만» 하고 호출부 0으로 착지했다
//     ⇒ ***정의는 초록이고 배선은 «아무도 안 봤다».***
describe('pr land — ungrounded-plan-artifacts 경고 배선', () => {
  const UNGROUNDED_BODY = [
    '# RFC — 계획',
    '',
    '## 0. 왜(근거)',
    '',
    '현재 제공된 골은 `write a plan`뿐이며, 계획의 대상·저장소·완료 조건에 관한 grounding 재료는 제공되지 않았다.',
    '',
  ].join('\n');

  it('--dry-run 에서도 그 문서를 «이름 대어» 말한다', async () => {
    const sink = output();
    const code = await runPrLand({ dryRun: true }, {
      ...baseDeps,
      run: statusRun('?? docs/RFC-write-plan-2026-09-07.md\u0000', true),
      manager: fakeManager().manager,
      out: sink.out,
      readFile: () => UNGROUNDED_BODY,
    });
    const said = [...sink.logs, ...sink.errors].join('\n');
    expect(said).toContain('ungrounded-plan-artifacts');
    expect(said).toContain('docs/RFC-write-plan-2026-09-07.md');
    // ⛔ 막지 «않는다» — 기존 untracked-files 경고와 같은 성질이다.
    expect(code).toBe(0);
  });

  it('⛔ 읽기가 실패해도 착지를 «막지 않는다» — 경고만 빠진다', async () => {
    const sink = output();
    const code = await runPrLand({ dryRun: true }, {
      ...baseDeps,
      run: statusRun('?? docs/RFC-write-plan-2026-09-07.md\u0000', true),
      manager: fakeManager().manager,
      out: sink.out,
      readFile: () => { throw new Error('EACCES'); },
    });
    const said = [...sink.logs, ...sink.errors].join('\n');
    expect(said).not.toContain('ungrounded-plan-artifacts');
    // ⭐ 그런데 «기존» untracked 경고는 그대로 나온다 — 이 검사가 그것을 삼키지 않는다.
    expect(said).toContain('untracked-files');
    expect(code).toBe(0);
  });

  // ⛔⭐ **`--cwd` 회귀** — 무인 리뷰 2차가 잡았다:
  //   *「readFile 스텁이 인자를 무시하므로 readFile(path) 로 되돌려도 모두 통과한다」*.
  //   🩸 실측으로 확인했다 — 되돌리니 86 pass · 0 fail 이었다.
  //   ⇒ ***내가 오늘 여러 번 쓴 「대조군으로 눌러라」를 그 수리에는 안 했다.***
  //   🔑 `git status` 는 `{ cwd }` 로 돌아 «그 트리 기준 상대 경로»를 낸다 ⇒ 읽기도 거기 결박돼야 한다.
  it('⛔ 대상 워크트리에 결박해 읽는다 — 프로세스 CWD 가 아니다', async () => {
    const sink = output();
    const seen: string[] = [];
    const otherTree = '/tmp/some-other-worktree';
    await runPrLand({ dryRun: true, cwd: otherTree }, {
      ...baseDeps,
      run: statusRun('?? docs/RFC-write-plan-2026-09-07.md\u0000', true),
      manager: fakeManager().manager,
      out: sink.out,
      readFile: (path: string) => { seen.push(path); return UNGROUNDED_BODY; },
    });
    // ⭐ `readFile(path)` 로 되돌리면 이 단언이 «깨진다» — 그때는 상대 경로가 그대로 온다.
    expect(seen).toContain(`${otherTree}/docs/RFC-write-plan-2026-09-07.md`);
  });

  it('정당한 문서만 담기면 그 줄이 «없다»', async () => {
    const sink = output();
    await runPrLand({ dryRun: true }, {
      ...baseDeps,
      run: statusRun('?? docs/RFC-legitimate-2026-09-07.md\u0000', true),
      manager: fakeManager().manager,
      out: sink.out,
      readFile: () => '# RFC — 정당한 문서\n\n이 문서는 근거를 갖고 쓰였다.\n',
    });
    const said = [...sink.logs, ...sink.errors].join('\n');
    expect(said).not.toContain('ungrounded-plan-artifacts');
    expect(said).toContain('untracked-files');
  });
});

describe('public-export-leak at landing (LEAK1)', () => {
  const io = () => { const log: string[] = []; const error: string[] = []; return { log, error, out: { log: (m: string) => log.push(m), error: (m: string) => error.push(m) } }; };
  const hit = { file: 'src/a.test.ts', line: 3, marker: 'ceo-mark' };

  it('a changed file that would leak after the export transforms stops the landing', () => {
    const o = io();
    const observed: string[] = [];
    expect(exportLeakBlock(['src/a.test.ts'], () => ({ measured: true, hits: [hit] }), false, o.out, process.cwd(), (line) => observed.push(line))).toBe(false);
    expect(observed).toEqual([o.error[0]!]);
    expect(o.error.join('\n')).toContain('src/a.test.ts:3 · ceo-mark');
    expect(o.error.join('\n')).toContain('--allow-public-leak');
  });

  it('--allow-public-leak with a reason warns; clean files land; unmeasured public files block', () => {
    const allowed = io();
    expect(exportLeakBlock(['src/a.test.ts'], () => ({ measured: true, hits: [hit] }), true, allowed.out)).toBe(true);
    expect(allowed.error).toEqual([]);
    expect(allowed.log.join('\n')).toContain('src/a.test.ts:3 · ceo-mark');
    const clean = io();
    expect(exportLeakBlock(['src/a.ts'], () => ({ measured: true, hits: [] }), false, clean.out)).toBe(true);
    expect(clean.log[0]).toContain('✓ public-export-leak');
    const unmeasured = io();
    expect(exportLeakBlock(['src/a.ts'], () => { throw new Error('boom'); }, false, unmeasured.out)).toBe(false);
    expect(unmeasured.error[0]).toContain('못 쟀다 — 막는다');
    expect(unmeasured.error[0]).toContain('bun scripts/public-export.ts --leak-check --json --all --files');
    const timeout = io();
    expect(exportLeakBlock(['scripts/x.sh'], () => ({ measured: false, hits: [], detail: 'timeout' }), false, timeout.out)).toBe(false);
    expect(timeout.error[0]).toContain('못 쟀다 — 막는다');
    const none = io();
    expect(exportLeakBlock([], () => { throw new Error('must not run'); }, false, none.out)).toBe(true);
  });

  it('allows only a documented hit line or its preceding comment, and logs paths/rules without source text', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pr-leak-allow-'));
    const logged = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      mkdirSync(join(cwd, 'scripts'));
      mkdirSync(join(cwd, 'release'));
      writeFileSync(join(cwd, 'release/public-export.yaml'), 'include: ["scripts/**"]\nexclude: ["scripts/hidden.sh"]\nreplace: {}\n');
      writeFileSync(join(cwd, 'scripts/x.sh'), '# public-export-allow: 시험 픽스처 — 공개본에 실려도 무해\necho secret\n');
      const o = io();
      const marker = { file: 'scripts/x.sh', line: 2, marker: 'ceo-mark' };
      expect(exportLeakBlock(['scripts/x.sh'], () => ({ measured: true, hits: [marker] }), false, o.out, cwd)).toBe(true);
      expect(logged).toHaveBeenCalledWith('pr.land', 'leak-gate', { blocked: false, hits: [{ file: 'scripts/x.sh', marker: 'ceo-mark' }], measured: true, allowed: 1 });
      expect(JSON.stringify(logged.mock.calls)).not.toContain('시험 픽스처');
      writeFileSync(join(cwd, 'scripts/x.sh'), '# public-export-allow: \necho secret\n');
      const empty = io();
      expect(exportLeakBlock(['scripts/x.sh'], () => ({ measured: true, hits: [marker] }), false, empty.out, cwd)).toBe(false);
      expect(empty.error.join('\n')).toContain('scripts/x.sh:2 · ceo-mark · 사유 없음');
      writeFileSync(join(cwd, 'scripts/x.sh'), 'echo secret # public-export-allow: harmless fixture\n');
      expect(exportLeakBlock(['scripts/x.sh'], () => ({ measured: true, hits: [{ ...marker, line: 1 }] }), false, io().out, cwd)).toBe(true);
      const unmeasured = io();
      expect(exportLeakBlock(['scripts/hidden.sh'], () => ({ measured: false, hits: [], detail: 'timeout' }), false, unmeasured.out, cwd)).toBe(true);
      expect(unmeasured.log.join('\n')).toContain('공개 대상 변경 없음');
      const skill = io();
      expect(exportLeakBlock(['skills/new/SKILL.md'], () => ({ measured: true, hits: [{ file: 'skills/new/SKILL.md', line: 1, marker: 'skill-boundary' }] }), false, skill.out, cwd)).toBe(false);
      expect(skill.error.join('\n')).toContain('skills/new/SKILL.md:1 · skill-boundary');
      const oldBoundary = io();
      expect(exportLeakBlock(['scripts/x.sh'], () => ({ measured: true, hits: [{ file: 'skills/old/SKILL.md', line: 1, marker: 'skill-boundary' }] }), false, oldBoundary.out, cwd)).toBe(true);
      const oldLeak = io();
      expect(exportLeakBlock(['scripts/x.sh'], () => ({ measured: true, hits: [] }), false, oldLeak.out, cwd)).toBe(true);
    } finally { logged.mockRestore(); rmSync(cwd, { recursive: true, force: true }); }
  });

  it('requires --land-reason for the whole-PR override before any landing side effects', async () => {
    const o = io();
    const manager = fakeManager();
    expect(await runPrLand({ allowPublicLeak: true }, { ...baseDeps, out: o.out, manager: manager.manager })).toBe(1);
    expect(o.error.join('\n')).toContain('--land-reason');
    expect(manager.calls).toEqual([]);
    const valid = io();
    expect(await runPrLand({ allowPublicLeak: true, landReason: 'known fixture', dryRun: true }, { ...baseDeps, out: valid.out, manager: manager.manager })).toBe(0);
  });

  it('runPrLand returns 1 before upsert when the check finds a leak', async () => {
    const { manager, calls } = fakeManager();
    const o = io();
    const edges: unknown[] = [];
    const off = debug.registerSink({ name: 'pr-land-export-refusal-test', emit: (row) => {
      if (row.event === 'graph-edge-taken') edges.push(row.data);
    } });
    let code: number;
    try {
      code = await runPrLand({ title: 't', body: 'b' }, {
        ...baseDeps, manager, out: o.out,
        run: (cmd: string, args: readonly string[]) => (cmd === 'git' && args[0] === 'diff' ? { ok: true, out: 'src/a.test.ts\n' } : baseLookupRun(cmd, args)),
        runExportLeakCheck: () => ({ measured: true, hits: [hit] }),
      } as never);
    } finally { off(); }
    expect(code).toBe(1);
    expect(o.error.join('\n')).toContain('✗ public-export-leak');
    expect(edges).toContainEqual(expect.objectContaining({
      from: 'merge', on: 'refusal', label: 'public-export-leak', to: 'next-move',
      taken: 'next-move', reason: 'pr-land-refused; recovery-execution=none',
    }));
    expect(calls).not.toContain('upsert');
    expect(calls).not.toContain('merge');
  });

  it('real exporter and landing gate detect a changed public leak even with a pre-existing skill boundary', async () => {
    const cwd = mkdtempSync(join(process.cwd(), '.pr-land-real-export-'));
    try {
      for (const dir of ['scripts', 'release', 'skills/old', 'catalog', 'src/video-pipeline', 'src/util', 'src/cli']) mkdirSync(join(cwd, dir), { recursive: true });
      for (const file of ['scripts/public-export.ts', 'scripts/skill-boundary.ts', 'scripts/open-core-boundary.ts', 'src/util/spawn-sync-output.ts', 'src/cli/stdout-json.ts']) {
        copyFileSync(join(process.cwd(), file), join(cwd, file));
      }
      writeFileSync(join(cwd, 'release/public-export.yaml'), 'include: ["scripts/**", "skills/**"]\nexclude: []\nreplace: {}\nskills: core\n');
      writeFileSync(join(cwd, 'catalog/resources.yaml'), 'resources: []\n');
      writeFileSync(join(cwd, 'src/video-pipeline/capabilities.ts'), 'export const capabilities = [];\n');
      writeFileSync(join(cwd, 'skills/old/SKILL.md'), '---\nname: old\n---\n');
      writeFileSync(join(cwd, 'scripts/x.sh'), 'echo "clean"\n');
      git(cwd, 'init', '-q');
      git(cwd, 'config', 'user.email', 'test@example.com');
      git(cwd, 'config', 'user.name', 'Test');
      git(cwd, 'add', '.');
      git(cwd, 'commit', '-qm', 'baseline boundary');
      writeFileSync(join(cwd, 'scripts/x.sh'), 'echo "\u{1F451}"\n');
      const changed = git(cwd, 'diff', '--name-only', 'HEAD').split('\n');
      expect(changed).toEqual(['scripts/x.sh']);
      const check = runPrLandExportLeakCheck(changed, cwd);
      expect(check).toMatchObject({ measured: true });
      expect(check.hits).toContainEqual(expect.objectContaining({ file: 'skills/old/SKILL.md', line: 1, marker: 'skill-boundary' }));
      expect(check.hits).toContainEqual(expect.objectContaining({ file: 'scripts/x.sh', line: 1, marker: 'ceo-mark' }));
      const sink = io();
      expect(exportLeakBlock(changed, () => check, false, sink.out, cwd)).toBe(false);
      expect(sink.error.join('\n')).toContain('scripts/x.sh:1 · ceo-mark');
      const manager = fakeManager();
      const landing = io();
      expect(await runPrLand({ cwd }, {
        ...baseDeps,
        manager: manager.manager,
        out: landing.out,
        run: (cmd, args, options) => {
          if (cmd === 'git' && args.join(' ') === statusArgs) return { ok: true, out: ' M scripts/x.sh\0' };
          if (cmd === 'git' && args[0] === 'diff' && args.includes('--name-only')) return { ok: true, out: 'scripts/x.sh\n' };
          return baseLookupRun(cmd, args);
        },
        runExportLeakCheck: runPrLandExportLeakCheck,
      })).toBe(1);
      expect(landing.error.join('\n')).toContain('scripts/x.sh:1 · ceo-mark');
      expect(manager.calls).not.toContain('upsert');
      expect(manager.calls).not.toContain('merge');
      writeFileSync(join(cwd, 'scripts/x.sh'), 'echo "clean"\n');
      const clean = runPrLandExportLeakCheck(['scripts/x.sh'], cwd);
      expect(clean.measured).toBe(true);
      expect(clean.hits.every((hit) => hit.marker === 'skill-boundary')).toBe(true);
      expect(exportLeakBlock(['scripts/x.sh'], () => clean, false, io().out, cwd)).toBe(true);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 180_000);
});

describe('pinned PR landing preview', () => {
  it.each([
    ['ready', false, 'a'.repeat(40), '', 0, '✓ preflight'],
    ['draft', true, 'a'.repeat(40), '', 1, 'PR is draft'],
    ['head mismatch', false, 'b'.repeat(40), '', 1, 'PR head differs'],
    ['dirty worktree', false, 'a'.repeat(40), ' M src/x.ts\n', 1, 'local worktree is dirty'],
  ] as const)('pinned dry-run %s shares the real identity guard and stays read-only', async (_case, isDraft, prHead, status, expectedCode, signal) => {
    const head = 'a'.repeat(40);
    const pr = '26563';
    const calls: string[] = [];
    const sink = output();
    const { manager, calls: mutations } = fakeManager();
    const run = (cmd: string, args: readonly string[]) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'gh') return { ok: true, out: JSON.stringify({ headRefOid: prHead, headRefName: 'feat/land', state: 'OPEN', isDraft, url: `https://github.com/example/repo/pull/${pr}` }) };
      if (args.join(' ') === 'rev-parse HEAD') return { ok: true, out: head };
      if (args.join(' ') === 'status --porcelain') return { ok: true, out: status };
      if (cmd === 'git' && args.join(' ') === 'remote') return { ok: true, out: 'origin\n' };
      if (cmd === 'git' && args[0] === 'ls-remote') return { ok: true, out: `${'b'.repeat(40)}\trefs/heads/main\n` };
      if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('origin/main')) return { ok: true, out: `${'b'.repeat(40)}\n` };
      if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main')) return { ok: true, out: `${'b'.repeat(40)}\n` };
      if (cmd === 'git' && args[0] === 'status' && args.includes('--porcelain=v1')) return { ok: true, out: '' };
      if (cmd === 'git' && args[0] === 'diff' && args.includes('--name-only')) return { ok: true, out: 'src/x.ts\n' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: '' };
      if (cmd === 'git' && args[0] === 'rev-list') return { ok: true, out: '0 0\n' };
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    };
    const code = await runPrLand({ pr, expectedHead: head, dryRun: true }, { ...baseDeps, manager, out: sink.out, run });
    expect(code).toBe(expectedCode);
    expect(sink.logs.join('\n')).toContain(signal);
    if (isDraft) expect(sink.logs).toContain(`[dry-run] 선행: eln gh pr ready ${pr}`);
    expect(mutations).toEqual([]);
    expect(calls.slice(0, 3)).toEqual([
      `gh pr view ${pr} --json headRefOid,headRefName,baseRefName,state,isDraft,url`,
      'git rev-parse HEAD',
      'git status --porcelain',
    ]);
    if (expectedCode === 0) {
      expect(calls.some((call) => call.startsWith('git ls-remote origin refs/heads/main'))).toBe(true);
      expect(calls.every((call) => !/^git (fetch|push|merge|commit|checkout)\b|^gh pr (edit|ready|merge)\b/u.test(call))).toBe(true);
    } else expect(calls).toHaveLength(3);
    if (expectedCode === 1) {
      const actual = output();
      const edges: { event: string; data?: unknown }[] = [];
      const recoverShadows: { event: string; data?: unknown }[] = [];
      const off = debug.registerSink({ name: 'pinned-refusal-route-test', emit: (row) => {
        if (row.event === 'graph-edge-taken' && (row.data as { from?: string })?.from === 'merge') edges.push(row);
        if (row.event === 'recover-shadow') recoverShadows.push(row);
      } });
      let actualCode: number;
      try { actualCode = await runPrLand({ pr, expectedHead: head }, { ...baseDeps, manager, out: actual.out, run }); }
      finally { off(); }
      expect(actualCode).toBe(1);
      expect(actual.errors).toContain('✗ expected-head: PR OPEN non-draft, matching local HEAD and clean worktree required');
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({ data: { on: 'refusal', label: isDraft ? 'draft' : 'other',
        to: isDraft ? 'ready' : 'next-move', reason: 'pr-land-refused; recovery-execution=none' } });
      expect(recoverShadows).toHaveLength(1);
      expect(recoverShadows[0]).toMatchObject({ data: {
        pr: Number(pr), head, label: isDraft ? 'draft' : 'other',
        outcome: 'needs-human', action: 'needs-human', execution: 'none',
      } });
    }
  });

  it('routes the paired --pr/--expected-head --dry-run through the CLI without a mutation', async () => {
    const head = 'a'.repeat(40);
    const pr = '26563';
    const { manager, calls: mutations } = fakeManager();
    const sink = output();
    const commands: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, manager, out: sink.out, run: (cmd, args) => {
      commands.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'gh') return { ok: true, out: JSON.stringify({ headRefOid: head, headRefName: 'feat/land', state: 'OPEN', isDraft: false, url: `https://github.com/example/repo/pull/${pr}` }) };
      if (args.join(' ') === 'rev-parse HEAD') return { ok: true, out: head };
      if (args.join(' ') === 'status --porcelain') return { ok: true, out: '' };
      if (cmd === 'git' && args.join(' ') === 'remote') return { ok: true, out: 'origin\n' };
      if (cmd === 'git' && args[0] === 'ls-remote') return { ok: true, out: `${'b'.repeat(40)}\trefs/heads/main\n` };
      if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('origin/main')) return { ok: true, out: `${'b'.repeat(40)}\n` };
      if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main')) return { ok: true, out: `${'b'.repeat(40)}\n` };
      if (cmd === 'git' && args[0] === 'status' && args.includes('--porcelain=v1')) return { ok: true, out: '' };
      if (cmd === 'git' && args[0] === 'diff' && args.includes('--name-only')) return { ok: true, out: 'src/x.ts\n' };
      if (cmd === 'git' && args[0] === 'log') return { ok: true, out: '' };
      if (cmd === 'git' && args[0] === 'rev-list') return { ok: true, out: '0 0\n' };
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    } });
    await program.parseAsync(['pr', 'land', '--pr', pr, '--expected-head', head, '--dry-run'], { from: 'user' });
    expect(sink.errors).toEqual([]);
    expect(sink.logs.join('\n')).toContain('✓ preflight');
    expect(mutations).toEqual([]);
    expect(commands.slice(0, 3)).toEqual([`gh pr view ${pr} --json headRefOid,headRefName,baseRefName,state,isDraft,url`, 'git rev-parse HEAD', 'git status --porcelain']);
    expect(commands.some((call) => call.startsWith('git ls-remote origin refs/heads/main'))).toBe(true);
  });

  it('fails closed when a pinned PR lookup returns a non-object', async () => {
    const sink = output();
    const code = await runPrLand({ pr: '26563', expectedHead: 'a'.repeat(40), dryRun: true }, {
      ...baseDeps, out: sink.out, run: (cmd, args) => cmd === 'gh'
        ? { ok: true, out: 'null' }
        : args.join(' ') === 'rev-parse HEAD' ? { ok: true, out: 'a'.repeat(40) } : { ok: true, out: '' },
    });
    expect(code).toBe(1);
    expect(sink.logs.join('\n')).toContain('PR is not OPEN');
  });

  it.each([
    ['branch mismatch', 'other-branch', 'a'.repeat(40), 'OPEN', 'current branch differs', '✗ branch: PR head branch와 현재 브랜치가 다릅니다.'],
    ['local HEAD mismatch', 'feat/land', 'b'.repeat(40), 'OPEN', 'local HEAD differs', '✗ expected-head: PR OPEN non-draft, matching local HEAD and clean worktree required'],
    ['closed PR', 'feat/land', 'a'.repeat(40), 'CLOSED', 'PR is not OPEN', '✗ expected-head: PR OPEN non-draft, matching local HEAD and clean worktree required'],
  ] as const)('pinned %s is rejected by preview and real guard', async (_case, prBranch, localHead, state, reason, realError) => {
    const head = 'a'.repeat(40);
    const { manager, calls: mutations } = fakeManager();
    const run = (cmd: string, args: readonly string[]) => cmd === 'gh'
      ? { ok: true, out: JSON.stringify({ headRefOid: head, headRefName: prBranch, state, isDraft: false, url: 'https://github.com/example/repo/pull/26563' }) }
      : args.join(' ') === 'rev-parse HEAD' ? { ok: true, out: localHead } : { ok: true, out: '' };
    const preview = output();
    expect(await runPrLand({ pr: '26563', expectedHead: head, dryRun: true }, { ...baseDeps, manager, out: preview.out, run })).toBe(1);
    expect(preview.logs.join('\n')).toContain(reason);
    const actual = output();
    expect(await runPrLand({ pr: '26563', expectedHead: head }, { ...baseDeps, manager, out: actual.out, run })).toBe(1);
    expect(actual.errors).toContain(realError);
    expect(mutations).toEqual([]);
  });

  it('rejects pinned --dry-run with --hold before any lookup', async () => {
    const sink = output();
    expect(await runPrLand({ pr: '26563', expectedHead: 'a'.repeat(40), dryRun: true, hold: true }, {
      ...baseDeps, out: sink.out, run: () => { throw new Error('unexpected lookup'); },
    })).toBe(1);
    expect(sink.errors.join('\n')).toContain('--hold 는 머리 고정 읽기 전용 예행과 함께');
  });

  it('prints the current PR head and read-only plan without running mutations', async () => {
    const calls: string[] = [];
    const log: string[] = [];
    const error: string[] = [];
    const head = 'a'.repeat(40);
    const code = await runPrLand({ pr: '26563', expectedHead: undefined, dryRun: true }, {
      ...baseDeps,
      out: { log: (line: string) => log.push(line), error: (line: string) => error.push(line) },
      run: (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') return { ok: true, out: JSON.stringify({ headRefOid: head, state: 'OPEN', headRefName: 'feat/landing', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }) };
        throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
      },
    });
    expect(code).toBe(0);
    expect(error).toEqual([]);
    expect(log.join('\\n')).toContain(`PR #26563 · head ${head} · state OPEN`);
    expect(log.join('\\n')).toContain('Landing plan (read-only preview)');
    expect(log.join('\\n')).toContain('Mergeability: GitHub reports MERGEABLE');
    expect(log.join('\\n')).toContain('UNMEASURED');
    expect(log.join('\\n')).toContain('Mutations (ready/edit/create/merge, git commit/push, worktree): NOT RUN');
    expect(calls).toEqual(['gh pr view 26563 --json headRefOid,state,headRefName,isDraft,mergeable,mergeStateStatus,url']);
  });

  it('blocks draft PR landing even when GitHub reports a clean, mergeable state', async () => {
    const head = 'c'.repeat(40);
    const log: string[] = [];
    const calls: string[] = [];
    const code = await runPrLand({ pr: '26563', dryRun: true }, {
      ...baseDeps,
      out: { log: (line: string) => log.push(line), error: (line: string) => { throw new Error(line); } },
      run: (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        return { ok: true, out: JSON.stringify({ headRefOid: head, state: 'OPEN', headRefName: 'feat/draft-clean', isDraft: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }) };
      },
    });

    const report = log.join('\n');
    expect(code).toBe(0);
    expect(report).toContain(`PR #26563 · head ${head} · state OPEN`);
    expect(report).toContain('Draft status: GitHub reports DRAFT; landing eligibility UNMEASURED.');
    expect(report).toContain('Mergeability: GitHub reports MERGEABLE');
    expect(report).not.toContain('conflicts');
    expect(report).not.toContain('DIRTY');
    expect(report).toContain('Local HEAD/worktree, branch/base, and same-branch guard: UNMEASURED');
    expect(report).toContain('Typecheck, isolation, mock-module restore, model-hardcode, daemon-port, test-interference, and global checks: UNMEASURED');
    expect(report).toContain('Android, iOS, and PWA gates: CONDITIONAL / UNMEASURED');
    expect(report).toContain('Freeze, PR base/bench guards, sibling PRs, recent landings, overlap, and approval: UNMEASURED');
    expect(report).toContain('Mutations (ready/edit/create/merge, git commit/push, worktree): NOT RUN');
    expect(calls).toEqual(['gh pr view 26563 --json headRefOid,state,headRefName,isDraft,mergeable,mergeStateStatus,url']);
  });

  it('rejects absent or invalid numbers, nonexistent PRs, and closed PRs', async () => {
    for (const pr of ['', '0', 'not-a-number']) {
      const errors: string[] = [];
      const code = await runPrLand({ pr, dryRun: true }, { ...baseDeps, out: { log: () => {}, error: (line: string) => errors.push(line) }, run: () => { throw new Error('lookup must not run'); } });
      expect(code).toBe(1);
      expect(errors.join('\n')).toContain('dry-run');
    }
    for (const response of [
      { ok: false, out: '' },
      { ok: true, out: JSON.stringify({ headRefOid: 'b'.repeat(40), state: 'CLOSED' }) },
    ]) {
      const errors: string[] = [];
      const code = await runPrLand({ pr: '8', dryRun: true }, {
        ...baseDeps,
        out: { log: () => {}, error: (line: string) => errors.push(line) },
        run: () => response,
      });
      expect(code).toBe(1);
      expect(errors.join('\n')).toContain(response.ok ? '열려 있지 않거나' : '존재하지 않거나');
    }
  });

  it('routes --pr N --dry-run through the registered CLI with one read-only PR lookup', async () => {
    const { manager, calls: mutations } = fakeManager();
    const sink = output();
    const commands: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { ...baseDeps, manager, out: sink.out, run: (cmd, args) => {
      commands.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return { ok: true, out: JSON.stringify({ headRefOid: 'd'.repeat(40), state: 'OPEN', headRefName: 'feat/landing', isDraft: false }) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    } });

    await program.parseAsync(['pr', 'land', '--pr', '26563', '--dry-run'], { from: 'user' });

    expect(sink.errors).toEqual([]);
    expect(sink.logs.join('\n')).toContain(`PR #26563 · head ${'d'.repeat(40)}`);
    expect(sink.logs.join('\n')).toContain('Freeze, PR base/bench guards, sibling PRs, recent landings, overlap, and approval: UNMEASURED');
    expect(mutations).toEqual([]);
    expect(commands).toEqual(['gh pr view 26563 --json headRefOid,state,headRefName,isDraft,mergeable,mergeStateStatus,url']);
  });

  it('rejects landing-only overlap evidence in a numbered preview before lookup', async () => {
    const sink = output();
    const code = await runPrLand({ pr: '26563', dryRun: true, overlapEvidence: '/tmp/evidence.json' }, {
      ...baseDeps, out: sink.out, run: () => { throw new Error('lookup must not run'); },
    });
    expect(code).toBe(1);
    expect(sink.errors.join('\n')).toContain('--overlap-evidence');
  });

  it('rejects non-object and invalid-head PR lookup responses without throwing', async () => {
    for (const raw of ['null', '[]', '{}', JSON.stringify({ state: 'OPEN', headRefOid: 'short' })]) {
      const sink = output();
      const code = await runPrLand({ pr: '26563', dryRun: true }, {
        ...baseDeps, out: sink.out, run: () => ({ ok: true, out: raw }),
      });
      expect(code).toBe(1);
      expect(sink.errors.length).toBe(1);
    }
  });
});

