import { describe, it, expect } from 'bun:test';
import {
  compactQueryTimings,
  execHarnessClean,
  HARNESS_CLEAN_QUERY_TIMING_KEYS,
  HARNESS_CLEAN_REPORT_LIST_LIMIT,
  harnessPrBranches,
  measureBranchSafety,
  parseWorktreeSnapshot,
  planHarnessClean,
  renderHarnessCleanReport,
  slowestQueryTiming,
  type GitRunner,
  type HarnessCleanPlan,
  type HarnessCleanQueryStatus,
} from './harness-clean.js';

const BATCH_ARGS = ['for-each-ref', '--format=%(refname:short) %(ahead-behind:origin/main)', 'refs/heads'] as const;

describe('parseWorktreeSnapshot — prunable registrations', () => {
  it('3개 블록 중 prunable 블록 2개를 등록 총수와 별도로 센다', () => {
    const snapshot = parseWorktreeSnapshot([
      'worktree /wt/a',
      'branch refs/heads/self-impl/a',
      'prunable',
      '',
      'worktree /wt/b',
      'branch refs/heads/self-impl/b',
      '',
      'worktree /wt/c',
      'branch refs/heads/self-impl/c',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n'), 'self-impl/');

    expect(snapshot.registered).toBe(3);
    expect(snapshot.prunable).toBe(2);
    expect(snapshot.entries).toHaveLength(3);
  });

  it('다음 worktree 블록에서 prunable 상태를 초기화한다', () => {
    const snapshot = parseWorktreeSnapshot([
      'worktree /wt/a',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree /wt/b',
      '',
      'worktree /wt/c',
      '',
    ].join('\n'), 'self-impl/');

    expect(snapshot.registered).toBe(3);
    expect(snapshot.prunable).toBe(1);
  });
});

describe('planHarnessClean — unowned merged-clean opt-in', () => {
  const branch = 'dev/unowned-merged-clean';
  const worktrees = [{ path: '/wt/dev/unowned-merged-clean', branch }];
  const base = {
    worktrees,
    branches: [branch],
    openPr: new Set<string>(),
    mergedPr: new Set([branch]),
    mode: 'merged' as const,
    activeDirectories: [] as string[],
    unmergedCommitCounts: new Map([[branch, 0]]),
    uncommittedChanges: new Map([[branch, false]]),
    changedFileCounts: new Map([[branch, 0]]),
    branchContents: new Map([[branch, 'already-contained' as const]]),
    assessWorktree: (input: Parameters<NonNullable<Parameters<typeof planHarnessClean>[0]['assessWorktree']>>[0]) => ({
      ...input,
      disposition: input.dirty ? 'do-not-touch' as const : 'reclaim-safe' as const,
      reason: input.dirty ? 'dirty-worktree' : 'merged-clean',
      hasOutput: false,
    }),
    readWorktreeProvenance: () => ({ owner: 'not-recorded', command: 'not-recorded', createdAt: 'not-recorded' }),
  };

  it('기본은 보존하고 opt-in 때만 merged·clean·열린 PR 없음·미사용 워크트리를 제거한다', () => {
    const defaults = planHarnessClean(base);
    expect(defaults.remove).toEqual([]);
    expect(defaults.preserve).toHaveLength(1);
    expect(defaults.preserve[0]?.reason).toContain('ownership=not-recorded:');

    const allMode = planHarnessClean({ ...base, mode: 'all', includeUnownedMergedClean: true });
    expect(allMode.remove).toEqual([]);
    expect(allMode.preserve).toHaveLength(1);

    const optedIn = planHarnessClean({ ...base, includeUnownedMergedClean: true });
    expect(optedIn.remove).toEqual([expect.objectContaining({ branch, path: worktrees[0]!.path })]);
    expect(optedIn.remove[0]?.reason).toContain('assessment=reclaim-safe:merged-clean');
    expect(optedIn.remove[0]?.reason).toContain('ownership=not-recorded:');
    expect(optedIn.preserve).toEqual([]);

    const open = planHarnessClean({ ...base, includeUnownedMergedClean: true, openPr: new Set([branch]) });
    expect(open.remove).toEqual([]);
    expect(open.preserve[0]?.reason).toContain('ownership=not-recorded:');
    const active = planHarnessClean({ ...base, includeUnownedMergedClean: true, activeDirectories: ['/wt/dev/unowned-merged-clean/src'] });
    expect(active.remove).toEqual([]);
    expect(active.preserve[0]?.reason).toBe('currently-in-use');
    const dirty = planHarnessClean({ ...base, includeUnownedMergedClean: true, uncommittedChanges: new Map([[branch, true]]) });
    expect(dirty.remove).toEqual([]);
  });
});

describe('planHarnessClean — branch content assessment axis', () => {
  // ⛔⭐ 종전 이 시험은 `changedFileCounts` 에서 branchContent 를 «파생»하는 설계를 못 박고 있었다.
  //   그 파생은 `origin/main...HEAD`(merge-base) 기준이라 ***squash merge 를 못 본다*** —
  //   내용이 완전히 착지한 브랜치도 계속 「changed」로 나왔다. 그것이 275건을 붙들던 결함이다.
  //   ⇒ 이제 `branchContents` 가 «따로 잰» 값으로 들어오고, 이 시험은 그 전달만 문다.
  it('전달: branchContents 의 세 값이 assessWorktree 에 그대로 간다', () => {
    const seen: Record<string, string | undefined> = {};
    const worktrees = [
      { path: '/wt/dev/differs', branch: 'dev/differs' },
      { path: '/wt/dev/contained', branch: 'dev/contained' },
      { path: '/wt/dev/unavailable', branch: 'dev/unavailable' },
    ];
    planHarnessClean({
      worktrees,
      branches: worktrees.map((worktree) => worktree.branch),
      openPr: new Set(),
      mergedPr: new Set(),
      mode: 'all',
      activeDirectories: [],
      unmergedCommitCounts: new Map(worktrees.map((worktree) => [worktree.branch, 0])),
      uncommittedChanges: new Map(worktrees.map((worktree) => [worktree.branch, false])),
      changedFileCounts: new Map([
        ['dev/differs', 1],
        ['dev/contained', 1],
        ['dev/unavailable', undefined],
      ]),
      // ⭐ 「내용이 base 에 있나」는 «파일 수»와 다른 질문이다 — 그래서 별도 축으로 준다.
      //   `dev/contained` 가 파일 수 1인데 `already-contained` 인 것이 그 차이의 실물이다.
      branchContents: new Map([
        ['dev/differs', 'differs' as const],
        ['dev/contained', 'already-contained' as const],
        ['dev/unavailable', 'unavailable' as const],
      ]),
      assessWorktree: (input) => {
        seen[input.branch ?? ''] = input.branchContent;
        return { ...input, disposition: 'reclaim-safe', reason: 'test', hasOutput: false };
      },
      readWorktreeProvenance: () => ({ owner: 'harness', command: 'dev', createdAt: 'now' }),
      run: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    expect(seen).toEqual({
      'dev/differs': 'differs',
      'dev/contained': 'already-contained',
      'dev/unavailable': 'unavailable',
    });
  });
});

function planFromSafety(
  branches: string[],
  safety: ReturnType<typeof measureBranchSafety>,
) {
  return planHarnessClean({
    worktrees: [],
    branches,
    openPr: new Set(),
    mergedPr: new Set(),
    mode: 'all',
    activeDirectories: [],
    ...safety,
  });
}

describe('measureBranchSafety — worktree-less batch ahead-behind', () => {
  it('여러 워크트리 없는 브랜치의 미머지 수를 for-each-ref 한 번으로 얻는다', () => {
    const seen: string[][] = [];
    const run: GitRunner = (args) => {
      seen.push([...args]);
      return { status: 0, stdout: 'dev/a 2 0\ndev/b 0 1\ndev/c 5 3\n', stderr: '' };
    };
    const safety = measureBranchSafety([], ['dev/a', 'dev/b', 'dev/c'], run);
    const lookups = seen.filter((args) => args[0] === 'for-each-ref' || args.includes('rev-list'));
    expect(lookups).toEqual([ [...BATCH_ARGS] ]);
    expect(safety.unmergedCommitCounts.get('dev/a')).toBe(2);
    expect(safety.unmergedCommitCounts.get('dev/b')).toBe(0);
    expect(safety.unmergedCommitCounts.get('dev/c')).toBe(5);
    expect(safety.uncommittedChanges.get('dev/a')).toBe(false);
    expect(safety.changedFileCounts.get('dev/a')).toBeUndefined();
  });

  it('배치가 어떤 브랜치의 값을 못 내면 그 브랜치는 모른다 — 0 으로 접히지 않는다', () => {
    const run: GitRunner = () => ({ status: 0, stdout: 'dev/a 2 0\n', stderr: '' });
    const safety = measureBranchSafety([], ['dev/a', 'dev/missing'], run);
    expect(safety.unmergedCommitCounts.get('dev/a')).toBe(2);
    expect(safety.unmergedCommitCounts.has('dev/missing')).toBe(true);
    expect(safety.unmergedCommitCounts.get('dev/missing')).toBeUndefined();
    const plan = planFromSafety(['dev/a', 'dev/missing'], safety);
    expect(plan.remove).toEqual([]);
    expect(plan.preserve.some((item) => item.branch === 'dev/missing')).toBe(true);
  });

  it('배치 조회 실패는 전체를 모른다로 남기고 지우지 않는다', () => {
    let calls = 0;
    const run: GitRunner = (args) => {
      if (args[0] === 'for-each-ref') calls += 1;
      if (args.includes('--merged')) return { status: 0, stdout: '', stderr: '' };
      return { status: 128, stdout: '', stderr: 'fatal: malformed object name origin/main' };
    };
    const safety = measureBranchSafety([], ['dev/a', 'dev/b'], run);
    expect(calls).toBe(1);
    expect(safety.unmergedCommitCounts.get('dev/a')).toBeUndefined();
    expect(safety.unmergedCommitCounts.get('dev/b')).toBeUndefined();
    expect(safety.uncommittedChanges.get('dev/a')).toBe(false);
    const plan = planFromSafety(['dev/a', 'dev/b'], safety);
    expect(plan.remove).toEqual([]);
    expect(plan.preserve.map((item) => item.branch).sort()).toEqual(['dev/a', 'dev/b']);
    expect(plan.preserve.every((item) => item.reason.includes('unjudgeable:worktree-unavailable'))).toBe(true);
    expect(plan.preserve.every((item) => !item.reason.includes('merge-check=failed'))).toBe(true);
  });

  it('비숫자 ahead 행은 그 브랜치만 모른다 — 옆 브랜치 0 으로 접히지 않는다', () => {
    const run: GitRunner = () => ({ status: 0, stdout: 'dev/a 2garbage 0\ndev/b 1 0\n', stderr: '' });
    const safety = measureBranchSafety([], ['dev/a', 'dev/b'], run);
    expect(safety.unmergedCommitCounts.get('dev/a')).toBeUndefined();
    expect(safety.unmergedCommitCounts.get('dev/b')).toBe(1);
  });

  it('워크트리가 있는 브랜치는 기존처럼 -C 경로에서 재고, 워크트리 없는 쪽만 배치한다', () => {
    const seen: string[][] = [];
    const run: GitRunner = (args) => {
      seen.push([...args]);
      if (args[0] === 'for-each-ref') return { status: 0, stdout: 'dev/orphan 4 0\n', stderr: '' };
      if (args.includes('rev-list')) return { status: 0, stdout: '3\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const safety = measureBranchSafety(
      [{ path: '/wt/dev/x', branch: 'dev/x' }],
      ['dev/x', 'dev/orphan'],
      run,
    );
    expect(seen.filter((args) => args[0] === 'for-each-ref')).toEqual([ [...BATCH_ARGS] ]);
    expect(seen).toContainEqual(['-C', '/wt/dev/x', 'rev-list', '--count', 'origin/main..HEAD']);
    expect(seen.some((args) => args.includes('origin/main..dev/orphan'))).toBe(false);
    expect(safety.unmergedCommitCounts.get('dev/x')).toBe(3);
    expect(safety.unmergedCommitCounts.get('dev/orphan')).toBe(4);
  });

  it('워크트리 없는 MERGED PR 브랜치는 reclaim-safe:merged-no-worktree 로 판정하고 제거 계획에 넣는다', () => {
    const safety = measureBranchSafety([], ['dev/merged'], () => ({ status: 0, stdout: 'dev/merged 0 0\n', stderr: '' }));
    const plan = planHarnessClean({
      worktrees: [], branches: ['dev/merged'], openPr: new Set(), mergedPr: new Set(['dev/merged']),
      mode: 'all', activeDirectories: [], ...safety,
    });
    expect(plan.preserve).toEqual([]);
    expect(plan.remove).toHaveLength(1);
    expect(plan.remove[0]?.reason).toBe('merged; assessment=reclaim-safe:merged-no-worktree; ownership=not-recorded; branch-only');
    expect(plan.remove[0]?.path).toBeUndefined();
  });

  it('⛔ 열린 PR 이 있으면 워크트리가 없어도 «보존»한다', () => {
    const run: GitRunner = () => ({ status: 0, stdout: 'dev/merged 0 0\n', stderr: '' });
    const safety = measureBranchSafety([], ['dev/merged'], run);
    const plan = planHarnessClean({
      worktrees: [], branches: ['dev/merged'], openPr: new Set(['dev/merged']), mergedPr: new Set(),
      mode: 'all', activeDirectories: [], ...safety,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toContain('open-pr');
  });

  it('⛔ abandoned 모드는 이 칸을 «안 담는다» — 모드가 판정을 가른다', () => {
    const safety = measureBranchSafety([], ['dev/merged'], () => ({ status: 0, stdout: 'dev/merged 0 0\n', stderr: '' }));
    const plan = planHarnessClean({
      worktrees: [], branches: ['dev/merged'], openPr: new Set(), mergedPr: new Set(['dev/merged']),
      mode: 'abandoned', activeDirectories: [], ...safety,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toContain('not-in-mode');
  });

  it('워크트리 없고 PR 이 없는 브랜치는 기존 unjudgeable:worktree-unavailable 이다', () => {
    const run: GitRunner = () => ({ status: 0, stdout: 'dev/live 3 0\n', stderr: '' });
    const safety = measureBranchSafety([], ['dev/live'], run);
    const plan = planFromSafety(['dev/live'], safety);
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toBe('assessment=unjudgeable:worktree-unavailable; ownership=not-recorded');
    expect(plan.preserve[0]?.reason).not.toContain('merged-no-worktree');
    expect(plan.preserve[0]?.reason).not.toContain('merge-check=failed');
  });

  it('기존 워크트리 시나리오의 판정 결과는 바뀌지 않는다', () => {
    const run: GitRunner = (args) => {
      if (args.includes('rev-list')) return { status: 0, stdout: '2\n', stderr: '' };
      if (args.includes('--porcelain') && args.includes('status')) return { status: 0, stdout: ' M src/a.ts\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const worktrees = [{ path: '/wt/dev/a', branch: 'dev/a' }];
    const safety = measureBranchSafety(worktrees, ['dev/a'], run);
    const plan = planHarnessClean({
      worktrees,
      branches: ['dev/a'],
      openPr: new Set(),
      mergedPr: new Set(),
      mode: 'all',
      activeDirectories: [],
      ...safety,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toContain('assessment=do-not-touch:dirty-worktree');
  });
});

const QUERY_STATUS_BOOLEAN_KEYS = [
  'worktrees',
  'branches',
  'pullRequests',
  'directories',
  'registeredWorktrees',
  'activeDirectories',
] as const satisfies ReadonlyArray<keyof HarnessCleanQueryStatus>;

describe('planHarnessClean — query timings', () => {
  const emptySafety = {
    unmergedCommitCounts: new Map<string, number | undefined>(),
    uncommittedChanges: new Map<string, boolean | undefined>(),
  };

  it('시간 칸 이름은 queryStatus 조회 칸과 같고 새 어휘를 만들지 않는다', () => {
    expect([...HARNESS_CLEAN_QUERY_TIMING_KEYS]).toEqual([...QUERY_STATUS_BOOLEAN_KEYS]);
    const plan = planHarnessClean({
      worktrees: [],
      branches: [],
      openPr: new Set(),
      mergedPr: new Set(),
      mode: 'all',
      activeDirectories: [],
      queryStatus: {
        worktrees: true,
        branches: true,
        pullRequests: true,
        directories: true,
        registeredWorktrees: true,
        activeDirectories: true,
      },
      queryTimings: {
        worktrees: 11,
        branches: 22,
        pullRequests: 33,
        directories: 44,
        registeredWorktrees: 55,
        activeDirectories: 66,
      },
      ...emptySafety,
    });
    expect(Object.keys(plan.queryTimings ?? {}).sort()).toEqual([...HARNESS_CLEAN_QUERY_TIMING_KEYS].sort());
    expect(plan.queryTimings).toEqual({
      worktrees: 11,
      branches: 22,
      pullRequests: 33,
      directories: 44,
      registeredWorktrees: 55,
      activeDirectories: 66,
    });
  });

  it('못 잰 칸은 빠지고 0 으로 채우지 않는다', () => {
    const plan = planHarnessClean({
      worktrees: [],
      branches: [],
      openPr: new Set(),
      mergedPr: new Set(),
      mode: 'all',
      activeDirectories: [],
      queryTimings: { worktrees: 12, branches: Number.NaN, pullRequests: -1 },
      ...emptySafety,
    });
    expect(plan.queryTimings).toEqual({ worktrees: 12 });
    expect(plan.queryTimings).not.toHaveProperty('branches');
    expect(plan.queryTimings).not.toHaveProperty('pullRequests');
    expect(plan.queryTimings).not.toHaveProperty('directories');
    expect(Object.values(plan.queryTimings ?? {}).includes(0)).toBe(false);
  });

  it('측정값 0 은 「빨랐다」이므로 남기고, 입력이 없으면 queryTimings 칸 자체가 없다', () => {
    const withZero = planHarnessClean({
      worktrees: [],
      branches: [],
      openPr: new Set(),
      mergedPr: new Set(),
      mode: 'all',
      activeDirectories: [],
      queryTimings: { worktrees: 0 },
      ...emptySafety,
    });
    expect(withZero.queryTimings).toEqual({ worktrees: 0 });
    const omitted = planHarnessClean({
      worktrees: [],
      branches: [],
      openPr: new Set(),
      mergedPr: new Set(),
      mode: 'all',
      activeDirectories: [],
      ...emptySafety,
    });
    expect(omitted.queryTimings).toBeUndefined();
  });

  it('scope 와 queryStatus 칸은 그대로 두고 시간만 더한다', () => {
    const queryStatus = {
      worktrees: true,
      branches: false,
      pullRequests: true,
      directories: true,
      registeredWorktrees: true,
      activeDirectories: true,
    };
    const plan = planHarnessClean({
      worktrees: [],
      branches: ['dev/a'],
      openPr: new Set(),
      mergedPr: new Set(),
      mode: 'all',
      activeDirectories: [],
      queryStatus,
      queryTimings: { branches: 90 },
      ...emptySafety,
    });
    expect(plan.scope).toBeUndefined();
    expect(plan.queryStatus).toMatchObject(queryStatus);
    expect(plan.queryStatus?.worktrees).toBe(true);
    expect(plan.queryStatus?.branches).toBe(false);
    expect(plan.queryStatus?.pullRequests).toBe(true);
    expect(plan.queryTimings).toEqual({ branches: 90 });
    expect(plan.remove).toEqual([]);
    expect(plan.preserve.map((item) => item.branch)).toEqual(['dev/a']);
    expect(plan.preserve[0]?.reason).toContain('query-failed:branches');
  });

  it('사람이 읽는 화면에 가장 오래 걸린 조회 이름이 한 줄로 보인다', () => {
    const plan = planHarnessClean({
      worktrees: [],
      branches: [],
      openPr: new Set(),
      mergedPr: new Set(),
      mode: 'all',
      activeDirectories: [],
      queryTimings: { worktrees: 4, pullRequests: 91, branches: 12 },
      ...emptySafety,
    });
    const lines = renderHarnessCleanReport({ plan, removed: [], failed: [], dryRun: true }, 'all');
    expect(lines.some((line) => line.includes('가장 오래 걸린 조회') && line.includes('pullRequests'))).toBe(true);
    expect(slowestQueryTiming(plan.queryTimings)).toEqual({ key: 'pullRequests', ms: 91 });
  });

  it('compactQueryTimings 는 못 잰 칸을 0 으로 접지 않는다', () => {
    expect(compactQueryTimings({ worktrees: 3, branches: undefined })).toEqual({ worktrees: 3 });
    expect(compactQueryTimings({})).toBeUndefined();
  });
});

describe('planHarnessClean — closedPr 상태 매핑', () => {
  const recorded = { owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' };

  function planClosed(over: {
    branch: string;
    openPr?: ReadonlySet<string>;
    mergedPr?: ReadonlySet<string>;
    closedPr?: ReadonlySet<string>;
    omitClosedPr?: boolean;
    queryStatus?: HarnessCleanQueryStatus;
  }) {
    const seen: string[] = [];
    const branch = over.branch;
    const plan = planHarnessClean({
      worktrees: [{ path: `/wt/${branch}`, branch }],
      branches: [branch],
      openPr: over.openPr ?? new Set(),
      mergedPr: over.mergedPr ?? new Set(),
      ...(over.omitClosedPr ? {} : { closedPr: over.closedPr ?? new Set() }),
      mode: 'all',
      activeDirectories: [],
      unmergedCommitCounts: new Map([[branch, 0]]),
      uncommittedChanges: new Map([[branch, false]]),
      changedFileCounts: new Map([[branch, 0]]),
      ...(over.queryStatus ? { queryStatus: over.queryStatus } : {}),
      assessWorktree: (input) => {
        seen.push(input.pr);
        return {
          ...input,
          disposition: input.pr === 'merged' || input.pr === 'none' ? 'reclaim-safe' : 'needs-human',
          reason: input.pr === 'closed' ? 'pr-closed' : input.pr === 'open' ? 'open-pr' : input.pr === 'merged' ? 'merged-clean' : 'no-pr-and-no-output',
          hasOutput: (input.uniqueCommitCount ?? 0) > 0,
        };
      },
      readWorktreeProvenance: () => recorded,
    });
    return { plan, pr: seen[0] };
  }

  it('closedPr 에만 있는 브랜치는 assess 에 closed 를 넘기고 제거하지 않는다', () => {
    const { plan, pr } = planClosed({
      branch: 'dev/closed-only',
      closedPr: new Set(['dev/closed-only']),
    });
    expect(pr).toBe('closed');
    expect(pr).not.toBe('none');
    expect(plan.remove.map((item) => item.branch)).not.toContain('dev/closed-only');
    expect(plan.preserve.map((item) => item.branch)).toContain('dev/closed-only');
    expect(plan.preserve.find((item) => item.branch === 'dev/closed-only')?.reason).toContain('assessment=needs-human:pr-closed');
  });

  it('closedPr 와 mergedPr 에 둘 다 있으면 merged 가 앞선다', () => {
    const { plan, pr } = planClosed({
      branch: 'dev/closed-and-merged',
      closedPr: new Set(['dev/closed-and-merged']),
      mergedPr: new Set(['dev/closed-and-merged']),
    });
    expect(pr).toBe('merged');
    expect(plan.remove.map((item) => item.branch)).toContain('dev/closed-and-merged');
    expect(plan.preserve.map((item) => item.branch)).not.toContain('dev/closed-and-merged');
  });

  it('closedPr 와 openPr 에 둘 다 있고 force 가 아니면 open 이 가장 앞선다', () => {
    const { plan, pr } = planClosed({
      branch: 'dev/closed-and-open',
      closedPr: new Set(['dev/closed-and-open']),
      openPr: new Set(['dev/closed-and-open']),
    });
    expect(pr).toBe('open');
    expect(plan.remove).toEqual([]);
    expect(plan.preserve.find((item) => item.branch === 'dev/closed-and-open')?.reason).toContain('open-pr');
  });

  it('closedPr 를 빈 집합으로 주거나 생략하면 기존 호출과 같은 remove·preserve 다', () => {
    const empty = planClosed({ branch: 'dev/no-pr', closedPr: new Set() });
    const omitted = planClosed({ branch: 'dev/no-pr', omitClosedPr: true });
    expect(empty.pr).toBe('none');
    expect(omitted.pr).toBe('none');
    expect(empty.plan.remove).toEqual(omitted.plan.remove);
    expect(empty.plan.preserve).toEqual(omitted.plan.preserve);
    expect(empty.plan.remove.map((item) => item.branch)).toEqual(['dev/no-pr']);
    expect(empty.plan.preserve).toEqual([]);
  });

  it('머지 조회가 절단돼도 closedPr 에 있는 브랜치는 절단 미확인이 아니다', () => {
    const { plan, pr } = planClosed({
      branch: 'dev/closed-seen',
      closedPr: new Set(['dev/closed-seen']),
      queryStatus: {
        worktrees: true,
        branches: true,
        pullRequests: true,
        pullRequestsTruncated: { open: false, merged: true },
      },
    });
    expect(pr).toBe('closed');
    expect(plan.preserve.find((item) => item.branch === 'dev/closed-seen')?.reason)
      .not.toContain('pullRequests-truncated:merged; branch-not-in-partial-list');
    expect(plan.preserve.map((item) => item.branch)).toContain('dev/closed-seen');
    expect(plan.remove).toEqual([]);
  });

  it('머지 조회가 절단됐고 어느 집합에도 없으면 절단 미확인으로 보존한다', () => {
    const { plan, pr } = planClosed({
      branch: 'dev/unseen',
      closedPr: new Set(),
      queryStatus: {
        worktrees: true,
        branches: true,
        pullRequests: true,
        pullRequestsTruncated: { open: false, merged: true },
      },
    });
    expect(pr).toBeUndefined();
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toContain('pullRequests-truncated:merged; branch-not-in-partial-list');
  });
});

describe('execHarnessClean — query timings on the dry-run path', () => {
  const run: GitRunner = (args) => {
    const a = args.join(' ');
    if (a.includes('worktree list')) {
      return { status: 0, stdout: 'worktree /wt/a\nbranch refs/heads/self-impl/a\n', stderr: '' };
    }
    if (a.includes('branch --list')) return { status: 0, stdout: 'self-impl/a\n', stderr: '' };
    if (a.includes('rev-list')) return { status: 0, stdout: '7\n', stderr: '' };
    if (a.includes('--porcelain')) return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  it('dry-run 계획은 조회별 밀리초를 싣고 기본 dry-run·queryStatus·정리·PR 보존은 그대로다', () => {
    const res = execHarnessClean({
      mode: 'abandoned',
      dryRun: true,
      branchPrefix: 'self-impl/',
      run,
      runGh: () => ({ status: 0, stdout: JSON.stringify({ data: { repository: { b0: { nodes: [] } } } }) }),
      readWorktreeProvenance: () => ({ owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' }),
    });
    expect(res.dryRun).toBe(true);
    expect(res.removed).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(res.plan.remove).toEqual([]);
    expect(res.plan.preserve.some((item) => item.reason.includes('open-pr'))).toBe(false);
    expect(res.plan.queryStatus?.worktrees).toBe(true);
    expect(res.plan.queryStatus?.branches).toBe(true);
    expect(res.plan.queryStatus?.pullRequests).toBe(true);
    expect(res.plan.queryStatus?.directories).toBeDefined();
    expect(res.plan.queryStatus?.registeredWorktrees).toBe(true);
    expect(res.plan.scope).toMatchObject({ registeredWorktrees: 1, prunableWorktrees: 0 });
    expect(JSON.parse(JSON.stringify(res)).plan.scope).toMatchObject({ registeredWorktrees: 1, prunableWorktrees: 0 });
    expect(res.plan.queryStatus?.activeDirectories).toBeDefined();
    const timings = res.plan.queryTimings ?? {};
    for (const key of HARNESS_CLEAN_QUERY_TIMING_KEYS) {
      expect(typeof timings[key]).toBe('number');
      expect(Number.isFinite(timings[key])).toBe(true);
      expect(timings[key]!).toBeGreaterThanOrEqual(0);
    }
    expect(Object.keys(timings).sort()).toEqual([...HARNESS_CLEAN_QUERY_TIMING_KEYS].sort());
    const report = renderHarnessCleanReport(res, 'abandoned').join('\n');
    expect(report).toContain('DRY-RUN');
    expect(report).toMatch(/가장 오래 걸린 조회: (worktrees|branches|pullRequests|directories|registeredWorktrees|activeDirectories) \(\d+ms\)/);
  });

  it('워크트리 없는 GraphQL MERGED PR은 merged 모드에서 회수하고 PR 없는 브랜치는 보존한다', () => {
    const branch = 'self-impl/merged-without-worktree';
    const runWithoutWorktree: GitRunner = (args) => {
      const command = args.join(' ');
      if (command.includes('worktree list')) return { status: 0, stdout: '', stderr: '' };
      if (command.includes('branch --list')) return { status: 0, stdout: `${branch}\n`, stderr: '' };
      if (args[0] === 'for-each-ref') return { status: 0, stdout: `${branch} 2 0\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const runGhWith = (state: 'MERGED' | 'NONE') => () => ({
      status: 0,
      stdout: JSON.stringify({ data: { repository: { b0: { nodes: state === 'MERGED' ? [{ state, mergedAt: '2026-09-13T00:00:00Z' }] : [] } } } }),
    });

    const merged = execHarnessClean({ mode: 'merged', dryRun: true, branchPrefix: 'self-impl/', run: runWithoutWorktree, runGh: runGhWith('MERGED') });
    const noPr = execHarnessClean({ mode: 'merged', dryRun: true, branchPrefix: 'self-impl/', run: runWithoutWorktree, runGh: runGhWith('NONE') });

    expect(merged.plan.remove).toEqual([expect.objectContaining({ branch, reason: 'merged; assessment=reclaim-safe:merged-no-worktree; ownership=not-recorded; branch-only' })]);
    expect(merged.plan.preserve).toEqual([]);
    expect(noPr.plan.remove).toEqual([]);
    expect(noPr.plan.preserve).toEqual([expect.objectContaining({ branch, reason: 'assessment=unjudgeable:worktree-unavailable; ownership=not-recorded' })]);
  });

  it('열린 PR 브랜치는 시간이 실려도 보존되고 dry-run 은 지우지 않는다', () => {
    const res = execHarnessClean({
      mode: 'all',
      dryRun: true,
      branchPrefix: 'self-impl/',
      run,
      runGh: () => ({
        status: 0,
        stdout: JSON.stringify({ data: { repository: { b0: { nodes: [{ state: 'OPEN', mergedAt: null }] } } } }),
      }),
      readWorktreeProvenance: () => ({ owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' }),
    });
    expect(res.dryRun).toBe(true);
    expect(res.removed).toEqual([]);
    expect(res.plan.remove).toEqual([]);
    expect(res.plan.preserve.some((item) => item.branch === 'self-impl/a')).toBe(true);
    expect(typeof res.plan.queryTimings?.pullRequests).toBe('number');
  });

  it('GraphQL 조회 실패는 제거 계획을 비우고 각 브랜치를 query-failed:pullRequests 로 보존한다', () => {
    const res = execHarnessClean({
      mode: 'all',
      dryRun: true,
      branchPrefix: 'self-impl/',
      run,
      runGh: () => ({ status: 1, stdout: '', stderr: 'offline' }),
      readWorktreeProvenance: () => ({ owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' }),
    });
    expect(res.plan.remove).toEqual([]);
    expect(res.plan.queryStatus?.pullRequests).toBe(false);
    expect(res.plan.preserve).toEqual(expect.arrayContaining([
      expect.objectContaining({ branch: 'self-impl/a', reason: 'query-failed:pullRequests' }),
    ]));
  });
});

describe('harnessPrBranches — branch-targeted GraphQL batching', () => {
  // ⛔⭐⭐ 이 시험은 «지어낸» 모양이 아니라 2026-09-13 에 이 저장소에서 실제로 받은 응답을
  //   글자 그대로 쓴다. 앞선 착지(#18056)는 별칭 밑에 `pullRequests` 층이 하나 더 있다고
  //   가정했고, 그 «가정을 픽스처가 복제»해서 단위 시험·게이트·리뷰가 전부 초록인 채
  //   운영에서는 261/261 이 parse:invalid-pr-graphql 로 떨어졌다.
  it('reads the real gh api graphql alias shape — nodes sit directly under the alias', () => {
    const REAL_RESPONSE = JSON.stringify({
      data: {
        repository: {
          b0: { nodes: [{ state: 'CLOSED', mergedAt: null }] },
          b1: { nodes: [] },
        },
      },
    });
    const res = harnessPrBranches(
      ['self-impl/closed-one', 'self-impl/no-pr'],
      'ElanvitalAI/elanous',
      () => ({ status: 0, stdout: REAL_RESPONSE }),
    );
    expect(res.ok).toBe(true);
    // CLOSED 이고 mergedAt 이 없으면 병합이 «아니다» — 어느 집합에도 안 들어간다.
    expect([...res.value.open]).toEqual([]);
    expect([...res.value.merged]).toEqual([]);
  });

  it('a response carrying the invented pullRequests level is rejected, not silently empty', () => {
    const INVENTED = JSON.stringify({
      data: { repository: { b0: { pullRequests: { nodes: [{ state: 'OPEN' }] } } } },
    });
    const res = harnessPrBranches(['self-impl/a'], 'ElanvitalAI/elanous', () => ({ status: 0, stdout: INVENTED }));
    expect(res.ok).toBe(false);
  });

  const graphqlResult = (aliases: readonly string[]) => ({
    // ⛔ 별칭은 필드 이름을 «대체»한다 — 아래는 2026-09-13 실제 gh api graphql 응답에서 옮긴 모양이다.
    //   지어낸 중간 층(`pullRequests`)을 넣으면 픽스처가 운영 결함을 «복제»한다(실제로 그랬다).
    data: { repository: Object.fromEntries(aliases.map((alias) => [alias, { nodes: [] }])) },
  });

  it('one and 120 branches make 1 and 3 injected gh calls, independent of repository PR history', () => {
    const callsFor = (branches: string[]) => {
      const calls: string[][] = [];
      const runGh = (args: string[]) => {
        calls.push(args);
        const aliases = [...args.join(' ').matchAll(/\b(b\d+): pullRequests/g)].map((match) => match[1]!);
        return { status: 0, stdout: JSON.stringify(graphqlResult(aliases)) };
      };
      return { calls, result: harnessPrBranches(branches, 'owner/name', runGh) };
    };
    const one = callsFor(['self-impl/one']);
    const many = callsFor(Array.from({ length: 120 }, (_, index) => `self-impl/${index}`));

    expect(one.result).toEqual({ ok: true, value: { open: new Set(), merged: new Set(), truncated: { open: false, merged: false } } });
    expect(many.result).toEqual(one.result);
    expect(one.calls).toHaveLength(1);
    expect(many.calls).toHaveLength(3);
    expect(many.calls.every((args) => args.slice(0, 2).join(':') === 'api:graphql' && !args.includes('--paginate'))).toBe(true);
  });

  it('open and merged branches are classified while a failed batch preserves every branch', () => {
    const branches = ['self-impl/open', 'self-impl/merged', 'self-impl/none'];
    const result = harnessPrBranches(branches, 'owner/name', () => ({
      status: 0,
      stdout: JSON.stringify({ data: { repository: {
        b0: { nodes: [{ state: 'OPEN', mergedAt: null }] },
        b1: { nodes: [{ state: 'MERGED', mergedAt: '2026-09-13T00:00:00Z' }] },
        b2: { nodes: [] },
      } } }),
    }));
    expect(result).toEqual({ ok: true, value: { open: new Set(['self-impl/open']), merged: new Set(['self-impl/merged']), truncated: { open: false, merged: false } } });
    expect(harnessPrBranches(branches, 'owner/name', () => ({ status: 1, stdout: '', stderr: 'offline' })).ok).toBe(false);
  });
});

function syntheticCleanResult(over: Partial<HarnessCleanPlan> = {}) {
  return {
    plan: {
      remove: [] as HarnessCleanPlan['remove'],
      preserve: [] as HarnessCleanPlan['preserve'],
      orphanedWorktrees: [] as string[],
      orphanedWorktreeSafety: [] as HarnessCleanPlan['orphanedWorktreeSafety'],
      orphanScan: 'not-requested' as const,
      unavailable: false,
      ...over,
    },
    removed: [],
    failed: [],
    dryRun: true,
  };
}

function listedItemLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith('  - '));
}

describe('renderHarnessCleanReport — 사람 화면 규모 요약', () => {
  it('끊어진 등록은 0일 때 숨기고 비0일 때 총수 줄에 표시한다', () => {
    const withoutPrunable = renderHarnessCleanReport(syntheticCleanResult({
      scope: { branchPrefix: 'self-impl/', matchedWorktrees: 0, matchedBranches: 0, registeredWorktrees: 3, branchlessWorktrees: 0, prunableWorktrees: 0 },
    }), 'abandoned').find((line) => line.startsWith('등록 워크트리 '));
    const withPrunable = renderHarnessCleanReport(syntheticCleanResult({
      scope: { branchPrefix: 'self-impl/', matchedWorktrees: 0, matchedBranches: 0, registeredWorktrees: 3, branchlessWorktrees: 0, prunableWorktrees: 2 },
    }), 'abandoned').find((line) => line.startsWith('등록 워크트리 '));

    expect(withoutPrunable).not.toContain('끊어진 등록');
    expect(withPrunable).toContain('· 끊어진 등록 2');
  });

  it('끊어진 등록 하위 줄은 양수일 때만 나오고 총수 줄은 그대로다', () => {
    const lines = renderHarnessCleanReport(syntheticCleanResult({
      scope: { branchPrefix: 'self-impl/', matchedWorktrees: 287, matchedBranches: 287, registeredWorktrees: 363, branchlessWorktrees: 0, prunableWorktrees: 44 },
    }), 'abandoned');
    expect(lines.find((line) => line.startsWith('등록 워크트리 '))).toContain('· 끊어진 등록 44');
    expect(lines.some((line) => line.includes('그중 44 은 gitdir 이 사라져(끊어진 등록)'))).toBe(true);
    expect(lines.some((line) => line.includes('git worktree prune'))).toBe(true);
    expect(lines.some((line) => line.includes('겹침'))).toBe(false);
  });

  it('prunableWorktrees=0 이면 끊어진 등록 하위 줄이 없다', () => {
    const lines = renderHarnessCleanReport(syntheticCleanResult({
      scope: { branchPrefix: 'self-impl/', matchedWorktrees: 1, matchedBranches: 1, registeredWorktrees: 3, branchlessWorktrees: 0, prunableWorktrees: 0 },
    }), 'abandoned');
    expect(lines.some((line) => line.includes('gitdir 이 사라져'))).toBe(false);
    expect(lines.find((line) => line.startsWith('등록 워크트리 '))).not.toContain('끊어진 등록');
  });

  it('끊어진 등록 하위 줄은 unseen 보다 크면 Math.min 으로 자른다', () => {
    const lines = renderHarnessCleanReport(syntheticCleanResult({
      scope: { branchPrefix: 'self-impl/', matchedWorktrees: 8, matchedBranches: 8, registeredWorktrees: 10, branchlessWorktrees: 0, prunableWorktrees: 5 },
    }), 'abandoned');
    expect(lines.some((line) => line.includes('그중 2 은 gitdir 이 사라져(끊어진 등록)'))).toBe(true);
    expect(lines.some((line) => line.includes('그중 5 은 gitdir'))).toBe(false);
    expect(lines.find((line) => line.startsWith('등록 워크트리 '))).toContain('· 끊어진 등록 5');
  });

  it('branchless 와 prunable 이 둘 다 있으면 겹침을 0으로 가정하지 않고 --prefix 안내는 reachable 그대로다', () => {
    const lines = renderHarnessCleanReport(syntheticCleanResult({
      scope: { branchPrefix: 'self-impl/', matchedWorktrees: 287, matchedBranches: 287, registeredWorktrees: 363, branchlessWorktrees: 40, prunableWorktrees: 44 },
    }), 'abandoned');
    const joined = lines.join('\n');
    expect(joined).toContain('그중 40 은 branch 가 없어');
    expect(joined).toContain('그중 44 은 gitdir 이 사라져(끊어진 등록)');
    expect(joined).toContain('겹침');
    expect(joined).toContain('합쳐서 빼지 마라');
    expect(joined).toContain('--prefix <p>');
    expect(lines.find((line) => line.startsWith('등록 워크트리 '))).toContain('· 끊어진 등록 44');
  });

  it('보존이 화면 한도보다 많으면 분모와 찍은 수와 생략 사실을 같이 말한다', () => {
    const preserveTotal = HARNESS_CLEAN_REPORT_LIST_LIMIT + 5;
    const removeTotal = 3;
    const planSnapshot = {
      remove: Array.from({ length: removeTotal }, (_, i) => ({ branch: `dev/rm-${i}`, reason: 'merged' })),
      preserve: Array.from({ length: preserveTotal }, (_, i) => ({ branch: `dev/keep-${i}`, reason: 'currently-in-use' })),
    };
    const res = syntheticCleanResult(planSnapshot);
    const before = structuredClone(res.plan);
    const lines = renderHarnessCleanReport(res, 'abandoned');
    const summary = lines.find((line) => line.startsWith('규모 '));
    const preserveItemLines = listedItemLines(lines).filter((line) => line.includes('dev/keep-'));
    const removeItemLines = listedItemLines(lines).filter((line) => line.includes('dev/rm-'));
    const displayed = removeItemLines.length + preserveItemLines.length;
    const omitted = preserveTotal - preserveItemLines.length;

    expect(summary).toBeDefined();
    expect(summary).toContain(`매칭 ${removeTotal + preserveTotal}`);
    expect(summary).toContain(`제거 계획 ${removeTotal}`);
    expect(summary).toContain(`보존 ${preserveTotal}`);
    expect(summary).toContain(`화면 ${displayed}`);
    expect(summary).toContain(`보존 ${omitted}개는 생략`);
    expect(preserveItemLines).toHaveLength(HARNESS_CLEAN_REPORT_LIST_LIMIT);
    expect(preserveItemLines.length).toBeLessThan(preserveTotal);
    expect(lines.some((line) => line.includes(`dev/keep-${HARNESS_CLEAN_REPORT_LIST_LIMIT}`))).toBe(false);
    expect(res.plan.remove).toEqual(before.remove);
    expect(res.plan.preserve).toEqual(before.preserve);
  });

  it('보존이 한도 안이면 생략 말 없이 전부가 화면에 나온다', () => {
    const preserve = [
      { branch: 'dev/keep-a', reason: 'currently-in-use' },
      { branch: 'dev/keep-b', reason: 'currently-in-use' },
    ];
    const remove = [{ branch: 'dev/rm-a', reason: 'merged' }];
    const res = syntheticCleanResult({ remove, preserve });
    const lines = renderHarnessCleanReport(res, 'abandoned');
    const summary = lines.find((line) => line.startsWith('규모 '));
    const itemLines = listedItemLines(lines);

    expect(summary).toBeDefined();
    expect(summary).toContain(`매칭 ${remove.length + preserve.length}`);
    expect(summary).toContain(`제거 계획 ${remove.length}`);
    expect(summary).toContain(`보존 ${preserve.length}`);
    expect(summary).toContain(`화면 ${itemLines.length}`);
    expect(summary).not.toContain('생략');
    expect(itemLines).toHaveLength(remove.length + preserve.length);
    expect(lines.join('\n')).toContain('dev/keep-a');
    expect(lines.join('\n')).toContain('dev/keep-b');
    expect(lines.join('\n')).toContain('dev/rm-a');
  });

  it('제거가 화면 한도를 넘어도 삭제 계획은 전부 찍히고 제거 생략 안내는 없다', () => {
    const removeTotal = HARNESS_CLEAN_REPORT_LIST_LIMIT + 4;
    const preserve = [{ branch: 'dev/keep-a', reason: 'currently-in-use' }];
    const remove = Array.from({ length: removeTotal }, (_, i) => ({ branch: `dev/rm-${i}`, reason: 'merged' }));
    const res = syntheticCleanResult({ remove, preserve });
    const before = structuredClone(res.plan);
    const lines = renderHarnessCleanReport(res, 'abandoned');
    const summary = lines.find((line) => line.startsWith('규모 '));
    const removeItemLines = listedItemLines(lines).filter((line) => line.includes('dev/rm-'));
    const preserveItemLines = listedItemLines(lines).filter((line) => line.includes('dev/keep-'));
    const displayed = removeItemLines.length + preserveItemLines.length;

    expect(summary).toBeDefined();
    expect(summary).toContain(`매칭 ${removeTotal + preserve.length}`);
    expect(summary).toContain(`제거 계획 ${removeTotal}`);
    expect(summary).toContain(`보존 ${preserve.length}`);
    expect(summary).toContain(`화면 ${displayed}`);
    expect(summary).not.toContain('생략');
    expect(removeItemLines).toHaveLength(removeTotal);
    expect(removeItemLines.length).toBeGreaterThan(HARNESS_CLEAN_REPORT_LIST_LIMIT);
    expect(lines.some((line) => line.includes(`dev/rm-${HARNESS_CLEAN_REPORT_LIST_LIMIT}`))).toBe(true);
    expect(lines.some((line) => line.includes('… 제거') && line.includes('개는 생략'))).toBe(false);
    expect(res.plan.remove).toEqual(before.remove);
    expect(res.plan.preserve).toEqual(before.preserve);
  });

  it('보존은 한도와 생략 안내가 적용되고 제거는 입력 개수와 같게 전부 표시된다', () => {
    const preserveTotal = HARNESS_CLEAN_REPORT_LIST_LIMIT + 7;
    const removeTotal = HARNESS_CLEAN_REPORT_LIST_LIMIT + 3;
    const preserve = Array.from({ length: preserveTotal }, (_, i) => ({ branch: `dev/keep-${i}`, reason: 'currently-in-use' }));
    const remove = Array.from({ length: removeTotal }, (_, i) => ({ branch: `dev/rm-${i}`, reason: 'merged' }));
    const res = syntheticCleanResult({ remove, preserve });
    const before = structuredClone(res.plan);
    const lines = renderHarnessCleanReport(res, 'abandoned');
    const summary = lines.find((line) => line.startsWith('규모 '));
    const preserveItemLines = listedItemLines(lines).filter((line) => line.includes('dev/keep-'));
    const removeItemLines = listedItemLines(lines).filter((line) => line.includes('dev/rm-'));
    const omittedPreserve = preserveTotal - preserveItemLines.length;
    const displayed = removeItemLines.length + preserveItemLines.length;

    expect(summary).toBeDefined();
    expect(summary).toContain(`매칭 ${removeTotal + preserveTotal}`);
    expect(summary).toContain(`제거 계획 ${removeTotal}`);
    expect(summary).toContain(`보존 ${preserveTotal}`);
    expect(summary).toContain(`화면 ${displayed}`);
    expect(summary).toContain(`보존 ${omittedPreserve}개는 생략`);
    expect(preserveItemLines).toHaveLength(HARNESS_CLEAN_REPORT_LIST_LIMIT);
    expect(preserveItemLines.length).toBeLessThan(preserveTotal);
    expect(removeItemLines).toHaveLength(removeTotal);
    expect(removeItemLines.length).toBe(remove.length);
    expect(lines.some((line) => line.includes('… 제거') && line.includes('개는 생략'))).toBe(false);
    expect(res.plan.remove).toEqual(before.remove);
    expect(res.plan.preserve).toEqual(before.preserve);
  });

  it('워크트리 없는 병합 브랜치가 셋이면 요약 줄에 그 개수 3 이 있고 제거 계획은 그대로다', () => {
    const preserve = [
      { branch: 'dev/m1', reason: 'assessment=reclaim-safe:merged-no-worktree; ownership=not-recorded' },
      { branch: 'dev/m2', reason: 'assessment=reclaim-safe:merged-no-worktree; ownership=not-recorded' },
      { branch: 'dev/m3', reason: 'assessment=reclaim-safe:merged-no-worktree; ownership=not-recorded' },
      { branch: 'dev/keep', reason: 'currently-in-use' },
    ];
    const remove = [{ branch: 'dev/rm-a', reason: 'merged' }];
    const res = syntheticCleanResult({ remove, preserve });
    const before = structuredClone(res.plan);
    const lines = renderHarnessCleanReport(res, 'abandoned');
    const summary = lines.find((line) => line.startsWith('규모 '));
    expect(summary).toBeDefined();
    expect(summary).toContain('브랜치만 회수 0');
    expect(summary).toContain('워크트리 없이 안전 3');
    expect(res.plan.remove).toEqual(before.remove);
    expect(res.plan.remove).toHaveLength(1);
  });

  it('branch-only 제거 계획은 보존 안전 수와 별도로 브랜치만 회수 수를 낸다', () => {
    const preserve = [
      { branch: 'dev/m1', reason: 'assessment=reclaim-safe:merged-no-worktree; ownership=not-recorded' },
      { branch: 'dev/m2', reason: 'assessment=reclaim-safe:merged-no-worktree; ownership=not-recorded' },
      { branch: 'dev/m3', reason: 'assessment=reclaim-safe:merged-no-worktree; ownership=not-recorded' },
    ];
    const remove = [
      { branch: 'dev/rm-branch-only-a', reason: 'merged; branch-only' },
      { branch: 'dev/rm-worktree', reason: 'merged' },
      { branch: 'dev/rm-branch-only-b', reason: 'abandoned; branch-only' },
    ];
    const res = syntheticCleanResult({ remove, preserve });
    const before = structuredClone(res.plan);
    const summary = renderHarnessCleanReport(res, 'merged').find((line) => line.startsWith('규모 '));

    expect(summary).toContain('브랜치만 회수 2');
    expect(summary).toContain('워크트리 없이 안전 3');
    expect(res.plan).toEqual(before);
  });
});

describe('execHarnessClean — unowned merged-clean opt-in wiring', () => {
  const clean = 'self-impl/unowned-merged-clean';
  const dirty = 'self-impl/unowned-merged-dirty';
  const unowned = () => ({ owner: 'not-recorded', command: 'not-recorded', createdAt: 'not-recorded' });
  const runWith = (removal: 'none' | 'success' | 'fail'): GitRunner => (args) => {
    const command = args.join(' ');
    if (command.includes('worktree list')) return { status: 0, stdout: [
      `worktree /wt/${clean}`, `branch refs/heads/${clean}`, '',
      `worktree /wt/${dirty}`, `branch refs/heads/${dirty}`, '',
    ].join('\n'), stderr: '' };
    if (command.includes('branch --list')) return { status: 0, stdout: `${clean}\n${dirty}\n`, stderr: '' };
    if (args[0] === 'for-each-ref') return { status: 0, stdout: `${clean} 0 0\n${dirty} 0 0\n`, stderr: '' };
    if (args.includes('rev-list')) return { status: 0, stdout: '0\n', stderr: '' };
    if (args.includes('status') && args.includes('--porcelain')) return {
      status: 0, stdout: args.includes(`/wt/${dirty}`) ? ' M dirty.txt\n' : '', stderr: '',
    };
    if (args.includes('diff')) return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'remove') return {
      status: removal === 'fail' ? 1 : 0, stdout: removal === 'fail' ? 'remove denied' : '', stderr: '',
    };
    return { status: 0, stdout: '', stderr: '' };
  };
  const mergedPr = () => ({ status: 0, stdout: JSON.stringify({ data: { repository: {
    b0: { nodes: [{ state: 'MERGED', mergedAt: '2026-09-13T00:00:00Z' }] },
    b1: { nodes: [{ state: 'MERGED', mergedAt: '2026-09-13T00:00:00Z' }] },
  } } }) });

  it('실제 assessWorktree로 미소유 merged-clean만 계획하고 dirty는 보존한다', () => {
    const result = execHarnessClean({
      mode: 'merged', dryRun: true, includeUnownedMergedClean: true, branchPrefix: 'self-impl/',
      run: runWith('none'), runGh: mergedPr, readWorktreeProvenance: unowned,
      activeDirectoryProvider: () => ({ ok: true, value: [] }),
    });
    expect(result.plan.remove).toEqual([expect.objectContaining({ branch: clean, path: `/wt/${clean}`,
      reason: expect.stringContaining('assessment=reclaim-safe:merged-clean') })]);
    expect(result.plan.preserve).toEqual([expect.objectContaining({ branch: dirty,
      reason: expect.stringContaining('assessment=needs-human:merged-but-dirty') })]);
    expect(result.removed).toEqual([]);
    const summary = renderHarnessCleanReport(result, 'merged').find((line) => line.startsWith('규모 '));
    expect(summary).toContain('미소유 merged-clean 제거 예정 1');
    expect(summary).not.toContain('미소유 merged-clean 회수');
  });

  it('실제 제거 성공만 회수 수로 세고 제거 실패는 0으로 남긴다', () => {
    for (const removal of ['success', 'fail'] as const) {
      const result = execHarnessClean({
        mode: 'merged', dryRun: false, includeUnownedMergedClean: true, branchPrefix: 'self-impl/',
        run: runWith(removal), runGh: mergedPr, readWorktreeProvenance: unowned,
        activeDirectoryProvider: () => ({ ok: true, value: [] }),
      });
      expect(result.plan.remove.map((item) => item.branch)).toEqual([clean]);
      expect(result.plan.preserve.map((item) => item.branch)).toEqual([dirty]);
      expect(result.removed).toHaveLength(removal === 'success' ? 1 : 0);
      expect(result.failed).toHaveLength(removal === 'fail' ? 1 : 0);
      const summary = renderHarnessCleanReport(result, 'merged').find((line) => line.startsWith('규모 '));
      if (removal === 'success') expect(summary).toContain('미소유 merged-clean 회수 1');
      else expect(summary).toContain('미소유 merged-clean 회수 0');
    }
  });

  it('옵트인 없음은 미소유 merged-clean을 기본 보존한다', () => {
    const run: GitRunner = (args) => {
      const command = args.join(' ');
      if (command.includes('worktree list')) return { status: 0, stdout: `worktree /wt/${clean}\nbranch refs/heads/${clean}\n`, stderr: '' };
      if (command.includes('branch --list')) return { status: 0, stdout: `${clean}\n`, stderr: '' };
      if (args[0] === 'for-each-ref') return { status: 0, stdout: `${clean} 0 0\n`, stderr: '' };
      if (command.includes('rev-list')) return { status: 0, stdout: '0\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = execHarnessClean({
      mode: 'merged', dryRun: true, branchPrefix: 'self-impl/', run,
      runGh: () => ({ status: 0, stdout: JSON.stringify({ data: { repository: { b0: { nodes: [{ state: 'MERGED', mergedAt: '2026-09-13T00:00:00Z' }] } } } }) }),
      readWorktreeProvenance: unowned,
      assessWorktree: (input) => ({ ...input, disposition: 'reclaim-safe', reason: 'merged-clean', hasOutput: false }),
      activeDirectoryProvider: () => ({ ok: true, value: [] }),
    });
    expect(result.plan.remove).toEqual([]);
    expect(result.plan.preserve.map((item) => item.branch)).toEqual([clean]);
    const summary = renderHarnessCleanReport(result, 'merged').find((line) => line.startsWith('규모 '));
    expect(summary).not.toContain('미소유 merged-clean');
  });
});

describe('execHarnessClean — merged-no-worktree wiring', () => {
  it('execHarnessClean 이 planHarnessClean 에 배치 병합 조회를 넘긴다', () => {
    const run: GitRunner = (args) => {
      const a = args.join(' ');
      if (a.includes('worktree list')) return { status: 0, stdout: '', stderr: '' };
      if (a.includes('branch --list')) return { status: 0, stdout: 'self-impl/merged\n', stderr: '' };
      if (args.includes('--merged')) return { status: 0, stdout: 'self-impl/merged\n', stderr: '' };
      if (args[0] === 'for-each-ref') return { status: 0, stdout: 'self-impl/merged 0 0\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const res = execHarnessClean({
      mode: 'all',
      dryRun: true,
      branchPrefix: 'self-impl/',
      run,
      runGh: () => ({ status: 0, stdout: JSON.stringify({ data: { repository: { b0: { nodes: [{ state: 'MERGED', mergedAt: '2026-09-13T00:00:00Z' }] } } } }) }),
    });
    // 🩹 2026-09-08: 배치 조회 «결과»가 이제 회수까지 간다(옛 계약은 판정만 하고 멈췄다).
    expect(res.plan.preserve.some((item) => item.branch === 'self-impl/merged')).toBe(false);
    expect(res.plan.remove.some((item) =>
      item.branch === 'self-impl/merged'
      && item.reason === 'merged; assessment=reclaim-safe:merged-no-worktree; ownership=not-recorded; branch-only',
    )).toBe(true);
  });
});
