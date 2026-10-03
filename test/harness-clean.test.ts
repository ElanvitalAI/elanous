// harness clean — 순수 분류(planHarnessClean) 테스트. 열린 PR 보존·mode 별 remove.
import { setDefaultTimeout, describe, it, expect } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import {
  gitStdout,
  type GitRunner,
  listHarnessWorktrees,
  listHarnessWorktreeDirectories,
  listRegisteredWorktreePaths,
  harnessPrBranches,
  createGhRunner,
  parseHarnessPrBranches,
  parseRegisteredWorktreePaths,
  planHarnessClean as planHarnessCleanImpl,
  measureBranchSafety,
  execHarnessClean,
  renderHarnessCleanReport,
  parseWorktreeSnapshot,
  readWorktreeSnapshot,
  isWorktreeInUse,
  listActiveTerminalDirectories,
} from '../src/harness/harness-clean.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WORKTREE_BRANCH_PREFIX } from '../src/harness/worktree-branch-prefix.js';
import { isElanousHarnessWorktreeCommand, worktreeParentDir } from '../src/git-fs/worktree.js';
import {
  markPtyManifestClosed,
  setPtyManifestDbPathForTesting,
  upsertPtyManifest,
  type PtyManifestRow,
} from '../src/pty-shell/pty-manifest.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const wt = (branch: string) => ({ path: `/wt/${branch}`, branch });
const indexLock = "fatal: Unable to create '/repo/.git/index.lock': File exists";

type LegacyPlanInput = Omit<Parameters<typeof planHarnessCleanImpl>[0], 'unmergedCommitCounts' | 'uncommittedChanges'>
  & Partial<Pick<Parameters<typeof planHarnessCleanImpl>[0], 'unmergedCommitCounts' | 'uncommittedChanges'>>;
const planHarnessClean = (input: LegacyPlanInput) => {
  const branches = [...new Set([...input.branches, ...input.worktrees.map((worktree) => worktree.branch)])];
  return planHarnessCleanImpl({
    ...input,
    unmergedCommitCounts: input.unmergedCommitCounts ?? new Map(branches.map((branch) => [branch, 0])),
    uncommittedChanges: input.uncommittedChanges ?? new Map(branches.map((branch) => [branch, false])),
    changedFileCounts: input.changedFileCounts ?? new Map(branches.map((branch) => [branch, 0])),
    branchContents: input.branchContents ?? new Map(branches.filter((branch) => input.worktrees.some((wt) => wt.branch === branch)).map((branch) => [branch, (input.unmergedCommitCounts?.get(branch) ?? 0) > 0 ? 'differs' as const : 'already-contained' as const])),
    readWorktreeProvenance: input.readWorktreeProvenance ?? (() => ({ owner: 'dev:test-harness', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' })),
  });
};

describe('listHarnessWorktrees — git() transient Git retry', () => {
  const successfulWorktree = 'worktree /repo.worktrees/dev-retry\nHEAD deadbeef\nbranch refs/heads/dev/retry\n';

  it('index.lock 뒤 성공하면 실제 git() 경로가 두 번 호출되어 worktree를 반환한다', () => {
    let calls = 0;
    const result = listHarnessWorktrees('dev/', () => {
      calls += 1;
      return calls === 1
        ? { status: 128, stdout: '', stderr: indexLock }
        : { status: 0, stdout: successfulWorktree, stderr: '' };
    });
    expect(result).toEqual({ ok: true, value: [{ path: '/repo.worktrees/dev-retry', branch: 'dev/retry' }] });
    expect(calls).toBe(2);
  });

  it('일시적이지 않은 실패는 실제 git() 경로에서 한 번만 호출한다', () => {
    let calls = 0;
    const result = listHarnessWorktrees('dev/', () => {
      calls += 1;
      return { status: 128, stdout: '', stderr: 'fatal: invalid reference: bad-ref' };
    });
    expect(result).toEqual({ ok: false, value: [] });
    expect(calls).toBe(1);
  });

  it('계속된 index.lock은 실제 git() 경로에서 상한 후 실패를 반환한다', () => {
    let calls = 0;
    const result = listHarnessWorktrees('dev/', () => {
      calls += 1;
      return { status: 128, stdout: '', stderr: indexLock };
    });
    expect(result).toEqual({ ok: false, value: [] });
    expect(calls).toBe(6);
  });
});

describe('gitStdout — transient Git retry', () => {
  it('index.lock 뒤 성공하면 stdout 반환 형태를 보존하고 두 번 호출한다', () => {
    let calls = 0;
    const result = gitStdout(['rev-parse', '--show-toplevel'], () => {
      calls += 1;
      return calls === 1
        ? { status: 128, stdout: '', stderr: indexLock }
        : { status: 0, stdout: '/repo\n', stderr: '' };
    });
    expect(result).toEqual({ ok: true, value: '/repo' });
    expect(calls).toBe(2);
  });

  it('일시적이지 않은 실패는 한 번만 호출하고 즉시 실패를 반환한다', () => {
    let calls = 0;
    const result = gitStdout(['rev-parse', 'bad-ref'], () => {
      calls += 1;
      return { status: 128, stdout: '', stderr: 'fatal: invalid reference: bad-ref' };
    });
    expect(result).toEqual({ ok: false, value: '' });
    expect(calls).toBe(1);
  });

  it('계속된 index.lock은 상한에서 멈추고 실패를 반환한다', () => {
    let calls = 0;
    const result = gitStdout(['worktree', 'list'], () => {
      calls += 1;
      return { status: 128, stdout: '', stderr: indexLock };
    });
    expect(result).toEqual({ ok: false, value: '' });
    expect(calls).toBe(6);
  });
});

describe('planHarnessClean — assessment and harness ownership domain', () => {
  const safeAssessment = (input: any) => ({ ...input, disposition: 'reclaim-safe' as const, reason: 'merged-clean', hasOutput: false });

  it('prefix가 맞아도 needs-human 사다리 판정이면 소유 상태와 함께 보존한다', () => {
    const plan = planHarnessCleanImpl({ activeDirectories: [],
      worktrees: [wt('self-impl/needs-human')], branches: ['self-impl/needs-human'], openPr: new Set(), mergedPr: new Set(), mode: 'all',
      unmergedCommitCounts: new Map([['self-impl/needs-human', 0]]), uncommittedChanges: new Map([['self-impl/needs-human', false]]), changedFileCounts: new Map([['self-impl/needs-human', 0]]),
      assessWorktree: (input) => ({ ...input, disposition: 'needs-human', reason: 'no-pr-with-output', hasOutput: true }),
      readWorktreeProvenance: () => ({ owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' }),
    });
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toContain('assessment=needs-human:no-pr-with-output');
    expect(plan.preserve[0]?.reason).toContain('ownership=recorded:owner=dev:run;command=elanous dev;createdAt=2026-08-05T00:00:00.000Z');
  });

  it('reclaim-safe여도 harness 소유가 없으면 사다리 reason과 함께 보존한다', () => {
    const plan = planHarnessCleanImpl({ activeDirectories: [],
      worktrees: [wt('self-impl/unowned')], branches: ['self-impl/unowned'], openPr: new Set(), mergedPr: new Set(), mode: 'all',
      unmergedCommitCounts: new Map([['self-impl/unowned', 0]]), uncommittedChanges: new Map([['self-impl/unowned', false]]), changedFileCounts: new Map([['self-impl/unowned', 0]]),
      assessWorktree: safeAssessment,
      readWorktreeProvenance: () => ({ owner: 'not-recorded', command: 'not-recorded', createdAt: 'not-recorded' }),
    });
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toContain('assessment=reclaim-safe:merged-clean');
    expect(plan.preserve[0]?.reason).toContain('ownership=not-recorded');
  });

  it.each([
    ['임의 owner', { owner: 'someone-else', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' }],
    ['빈 owner', { owner: '', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' }],
    ['명령 누락', { owner: 'dev:run', command: 'not-recorded', createdAt: '2026-08-05T00:00:00.000Z' }],
    ['빈 명령', { owner: 'dev:run', command: '', createdAt: '2026-08-05T00:00:00.000Z' }],
    ['비정상 명령', { owner: 'dev:run', command: 'test', createdAt: '2026-08-05T00:00:00.000Z' }],
    ['생성 시각 누락', { owner: 'dev:run', command: 'elanous dev', createdAt: 'not-recorded' }],
    ['빈 생성 시각', { owner: 'dev:run', command: 'elanous dev', createdAt: '' }],
    ['비정상 생성 시각', { owner: 'dev:run', command: 'elanous dev', createdAt: 'not-a-date' }],
    ['존재하지 않는 날짜', { owner: 'dev:run', command: 'elanous dev', createdAt: '2026-02-30T00:00:00.000Z' }],
    ['시간대 없는 생성 시각', { owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000' }],
    ['오프셋 생성 시각', { owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T09:00:00.000+09:00' }],
    ['밀리초 없는 생성 시각', { owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T00:00:00Z' }],
    ['조회 오류', { owner: 'read-error: config unavailable', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' }],
  ])('%s provenance는 reclaim-safe여도 fail-closed 보존하고 세 필드를 산출한다', (_label, provenance) => {
    const plan = planHarnessCleanImpl({ activeDirectories: [],
      worktrees: [wt('self-impl/invalid-provenance')], branches: ['self-impl/invalid-provenance'], openPr: new Set(), mergedPr: new Set(), mode: 'all',
      unmergedCommitCounts: new Map([['self-impl/invalid-provenance', 0]]), uncommittedChanges: new Map([['self-impl/invalid-provenance', false]]), changedFileCounts: new Map([['self-impl/invalid-provenance', 0]]),
      assessWorktree: safeAssessment,
      readWorktreeProvenance: () => provenance,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toContain('assessment=reclaim-safe:merged-clean');
    expect(plan.preserve[0]?.reason).toContain(`owner=${provenance.owner}`);
    expect(plan.preserve[0]?.reason).toContain(`command=${provenance.command}`);
    expect(plan.preserve[0]?.reason).toContain(`createdAt=${provenance.createdAt}`);
  });

  it('reclaim-safe와 완전한 harness provenance와 mode이 모두 맞는 등록 worktree만 후보가 된다', () => {
    const plan = planHarnessCleanImpl({ activeDirectories: [],
      worktrees: [wt('self-impl/reclaim')], branches: ['self-impl/reclaim'], openPr: new Set(), mergedPr: new Set(), mode: 'all',
      unmergedCommitCounts: new Map([['self-impl/reclaim', 0]]), uncommittedChanges: new Map([['self-impl/reclaim', false]]), changedFileCounts: new Map([['self-impl/reclaim', 0]]),
      assessWorktree: safeAssessment,
      readWorktreeProvenance: () => ({ owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' }),
    });
    expect(plan.remove.map((item) => item.branch)).toEqual(['self-impl/reclaim']);
  });

  it.each([
    ['writer dev short form', { owner: 'dev:run', command: 'dev', createdAt: '2026-08-05T00:00:00.000Z' }],
    ['writer drive short form', { owner: 'dev:run', command: 'drive', createdAt: '2026-08-05T00:00:00.000Z' }],
    ['enter_worktree 런타임 문면', { owner: 'agent:40302', command: 'elanous enter_worktree', createdAt: '2026-08-05T00:00:00.000Z' }],
    ['기존 unattributed/add 문면', { owner: 'harness:unattributed', command: 'harness worktree add', createdAt: '2026-08-05T00:00:00.000Z' }],
    ['기존 dev/elanous dev 문면', { owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' }],
    ['기존 agent-mission 문면', { owner: 'agent:40302', command: 'elanous agent-mission', createdAt: '2026-08-05T00:00:00.000Z' }],
  ])('%s은 reclaim-safe이면 recorded 소유로 제거 후보가 된다', (_label, provenance) => {
    const plan = planHarnessCleanImpl({ activeDirectories: [],
      worktrees: [wt('self-impl/recorded')], branches: ['self-impl/recorded'], openPr: new Set(), mergedPr: new Set(), mode: 'all',
      unmergedCommitCounts: new Map([['self-impl/recorded', 0]]), uncommittedChanges: new Map([['self-impl/recorded', false]]), changedFileCounts: new Map([['self-impl/recorded', 0]]),
      assessWorktree: safeAssessment,
      readWorktreeProvenance: () => provenance,
    });
    expect(plan.remove).toHaveLength(1);
    expect(plan.remove[0]?.reason).toContain(`ownership=recorded:owner=${provenance.owner};command=${provenance.command};createdAt=${provenance.createdAt}`);
  });

  it('canonical command predicate accepts writer short forms and every preserved long form only', () => {
    for (const command of ['dev', 'drive', 'harness worktree add', 'elanous dev', 'elanous enter_worktree', 'elanous agent-mission']) {
      expect(isElanousHarnessWorktreeCommand(command)).toBe(true);
    }
    expect(isElanousHarnessWorktreeCommand('foreign command')).toBe(false);
  });

  it.each([
    'agent:',
    'agent:space identifier',
    'agent:one:two',
    'agent:40302\n',
  ])('식별자가 유효하지 않은 %s owner는 fail-closed 보존한다', (owner) => {
    const plan = planHarnessCleanImpl({ activeDirectories: [],
      worktrees: [wt('self-impl/invalid-agent')], branches: ['self-impl/invalid-agent'], openPr: new Set(), mergedPr: new Set(), mode: 'all',
      unmergedCommitCounts: new Map([['self-impl/invalid-agent', 0]]), uncommittedChanges: new Map([['self-impl/invalid-agent', false]]), changedFileCounts: new Map([['self-impl/invalid-agent', 0]]),
      assessWorktree: safeAssessment,
      readWorktreeProvenance: () => ({ owner, command: 'elanous enter_worktree', createdAt: '2026-08-05T00:00:00.000Z' }),
    });
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toContain(`ownership=invalid:owner=${owner};command=elanous enter_worktree;createdAt=2026-08-05T00:00:00.000Z`);
  });

  it('사다리와 소유 조회가 실패하면 각각 측정 불가 사유를 남기고 후보에서 뺀다', () => {
    const base = {
      activeDirectories: [],
      worktrees: [wt('self-impl/assessment-fail'), wt('self-impl/ownership-fail')],
      branches: ['self-impl/assessment-fail', 'self-impl/ownership-fail'], openPr: new Set<string>(), mergedPr: new Set<string>(), mode: 'all' as const,
      unmergedCommitCounts: new Map([['self-impl/assessment-fail', 0], ['self-impl/ownership-fail', 0]]),
      uncommittedChanges: new Map([['self-impl/assessment-fail', false], ['self-impl/ownership-fail', false]]),
      changedFileCounts: new Map([['self-impl/assessment-fail', 0], ['self-impl/ownership-fail', 0]]),
      assessWorktree: (input: any) => {
        if (input.branch === 'self-impl/assessment-fail') throw new Error('assessment unavailable');
        return { ...input, disposition: 'reclaim-safe' as const, reason: 'merged-clean', hasOutput: false };
      },
      readWorktreeProvenance: (path: string) => {
        if (path.endsWith('ownership-fail')) throw new Error('ownership unavailable');
        return { owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' };
      },
    };
    const plan = planHarnessCleanImpl(base);
    expect(plan.remove).toEqual([]);
    expect(plan.preserve.find((item) => item.branch === 'self-impl/assessment-fail')?.reason).toContain('assessment=unavailable:assessment unavailable; ownership=unmeasured');
    expect(plan.preserve.find((item) => item.branch === 'self-impl/ownership-fail')?.reason).toContain('assessment=reclaim-safe:merged-clean; ownership=unavailable:ownership unavailable');
  });

  it('입력 누락은 안전한 기본값으로 합성하지 않고 등록 worktree를 unjudgeable로 보존한다', () => {
    const plan = planHarnessCleanImpl({ activeDirectories: [],
      worktrees: [wt('self-impl/missing')], branches: ['self-impl/missing'], openPr: new Set(), mergedPr: new Set(), mode: 'all',
      unmergedCommitCounts: new Map([['self-impl/missing', 0]]), uncommittedChanges: new Map([['self-impl/missing', false]]),
      readWorktreeProvenance: () => ({ owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' }),
    });
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toContain('assessment=unjudgeable:measurement-unavailable');
  });
});

describe('planHarnessClean — 열린 PR 보존', () => {
  it('열린 PR 브랜치는 어느 mode 든 보존(force 아니면)', () => {
    for (const mode of ['abandoned', 'merged', 'all'] as const) {
      const p = planHarnessClean({ activeDirectories: [],
        worktrees: [wt('dev/a')], branches: ['dev/a'],
        openPr: new Set(['dev/a']), mergedPr: new Set(), mode,
      });
      expect(p.remove).toHaveLength(0);
      expect(p.preserve.find((x) => x.branch === 'dev/a')?.reason).toContain('assessment=do-not-touch:open-pr');
    }
  });
  it('--force 면 열린 PR 도 제거(위험)', () => {
    const p = planHarnessClean({ activeDirectories: [],
      worktrees: [wt('dev/a')], branches: ['dev/a'], openPr: new Set(['dev/a']), mergedPr: new Set(), mode: 'all', force: true,
    });
    expect(p.remove.map((x) => x.branch)).toContain('dev/a');
  });
});

describe('planHarnessClean — 조회 신뢰 상태', () => {
  const emptyPrState = { openPr: new Set<string>(), mergedPr: new Set<string>() };

  it('조회 실패면 어떤 mode·force에서도 remove 없이 보존한다 — 3 mode × force 2 × 실패축 3 전수', () => {
    const modes: Array<'abandoned' | 'merged' | 'all'> = ['abandoned', 'merged', 'all'];
    const failures = [
      { worktrees: false, branches: true, pullRequests: true },
      { worktrees: true, branches: false, pullRequests: true },
      { worktrees: true, branches: true, pullRequests: false },
    ];
    for (const mode of modes) {
      for (const force of [false, true]) {
        for (const queryStatus of failures) {
          const p = planHarnessClean({ activeDirectories: [],
            worktrees: [wt('dev/unverified')], branches: ['dev/unverified'], ...emptyPrState,
            mode, queryStatus, ...(force ? { force: true } : {}),
          });
          expect(p.remove).toHaveLength(0);
          expect(p.preserve).toEqual([expect.objectContaining({
            branch: 'dev/unverified',
            path: '/wt/dev/unverified',
            reason: `query-failed:${Object.entries(queryStatus).filter(([, ok]) => !ok).map(([name]) => name).join(',')}`,
          })]);
          // ⭐ 후보가 0개인 경우와 구별되는 신호가 계획에 남는다(리뷰 should-fix)
          expect(p.unavailable).toBe(true);
        }
      }
    }
  });

  it('실패한 PR 질의와 복수 질의 축을 보존 사유에 이름으로 싣는다', () => {
    const planFrom = (queryStatus: { worktrees: boolean; branches: boolean; pullRequests: boolean; directories?: boolean }) => planHarnessClean({ activeDirectories: [],
      worktrees: [wt('dev/unverified')], branches: ['dev/unverified'], ...emptyPrState,
      mode: 'abandoned', queryStatus,
    });

    expect(planFrom({ worktrees: true, branches: true, pullRequests: false }).preserve[0]?.reason)
      .toBe('query-failed:pullRequests');
    expect(planFrom({ worktrees: false, branches: true, pullRequests: true, directories: false }).preserve[0]?.reason)
      .toBe('query-failed:worktrees,directories');
  });

  it('모든 질의가 성공하면 query-failed 사유 없이 기존 분류를 유지한다', () => {
    const plan = planHarnessClean({ activeDirectories: [],
      worktrees: [wt('dev/abandoned')], branches: ['dev/abandoned'], ...emptyPrState,
      mode: 'abandoned', queryStatus: { worktrees: true, branches: true, pullRequests: true, directories: true, registeredWorktrees: true },
    });
    expect(plan.remove.map((item) => item.branch)).toEqual(['dev/abandoned']);
    expect(plan.preserve).toEqual([]);
  });

  it('조회 실패면 후보가 0개여도 계획이 그 사실을 남긴다', () => {
    const p = planHarnessClean({ activeDirectories: [],
      worktrees: [], branches: [], ...emptyPrState,
      mode: 'abandoned', queryStatus: { worktrees: true, branches: true, pullRequests: false },
    });
    expect(p.remove).toEqual([]);
    expect(p.preserve).toEqual([]);
    expect(p.unavailable).toBe(true);          // ⭐ 「지울 게 없었다」와 갈린다
    expect(p.queryStatus?.pullRequests).toBe(false);
  });

  it('조회 성공이면 후보 0개는 unavailable 이 아니다', () => {
    const p = planHarnessClean({ activeDirectories: [],
      worktrees: [], branches: [], ...emptyPrState,
      mode: 'abandoned', queryStatus: { worktrees: true, branches: true, pullRequests: true },
    });
    expect(p.unavailable).toBe(false);

  });

  it('성공한 실제 빈 조회는 기존처럼 abandoned 브랜치를 제거한다', () => {
    const p = planHarnessClean({ activeDirectories: [],
      worktrees: [wt('dev/abandoned')], branches: ['dev/abandoned'], ...emptyPrState,
      mode: 'abandoned', queryStatus: { worktrees: true, branches: true, pullRequests: true },
    });
    expect(p.remove).toEqual([expect.objectContaining({ branch: 'dev/abandoned', path: '/wt/dev/abandoned', reason: expect.stringContaining('abandoned; assessment=reclaim-safe') })]);
    expect(p.preserve).toEqual([]);
  });
});

describe('planHarnessClean — currently in use worktree preservation', () => {
  const emptyPrState = { openPr: new Set<string>(), mergedPr: new Set<string>() };

  it('active root and descendant cwd preserve otherwise removable worktrees without sibling-prefix false positives', () => {
    expect(isWorktreeInUse('/wt/task', ['/wt/task'])).toBe(true);
    expect(isWorktreeInUse('/wt/task', ['/wt/task/src'])).toBe(true);
    expect(isWorktreeInUse('/wt/task', ['/wt/task/..cache'])).toBe(true);
    expect(isWorktreeInUse('/wt/task', ['/wt'])).toBe(false);
    expect(isWorktreeInUse('/wt/task', ['/wt/task-sibling'])).toBe(false);

    const preserved = planHarnessClean({
      worktrees: [wt('dev/active')], branches: ['dev/active'], ...emptyPrState, mode: 'all',
      activeDirectories: ['/wt/dev/active/src'],
    });
    expect(preserved.remove).toEqual([]);
    expect(preserved.preserve).toEqual([expect.objectContaining({ branch: 'dev/active', reason: 'currently-in-use' })]);
  });

  it('a successful empty active-directory lookup preserves previous removal behavior', () => {
    const plan = planHarnessClean({
      worktrees: [wt('dev/empty')], branches: ['dev/empty'], ...emptyPrState, mode: 'abandoned',
      activeDirectories: [],
      queryStatus: { worktrees: true, branches: true, pullRequests: true, activeDirectories: true },
    });
    expect(plan.remove).toEqual([expect.objectContaining({ branch: 'dev/empty' })]);
  });

  it('an unavailable active-directory lookup fail-closes and exposes its completeness state', () => {
    const plan = planHarnessCleanImpl({ activeDirectories: [],
      worktrees: [wt('dev/unknown-use')], branches: ['dev/unknown-use'], ...emptyPrState, mode: 'all',
      queryStatus: { worktrees: true, branches: true, pullRequests: true, activeDirectories: false },
      unmergedCommitCounts: new Map([['dev/unknown-use', 0]]),
      uncommittedChanges: new Map([['dev/unknown-use', false]]),
    });
    expect(plan.remove).toEqual([]);
    expect(plan.unavailable).toBe(true);
    expect(plan.queryStatus?.activeDirectories).toBe(false);
    expect(plan.preserve).toEqual([expect.objectContaining({ reason: 'query-failed:activeDirectories' })]);
  });

  it('omitting both active directories and query status fails closed rather than assuming an empty lookup', () => {
    const plan = planHarnessCleanImpl({
      worktrees: [wt('dev/unknown-use')], branches: ['dev/unknown-use'], ...emptyPrState, mode: 'all',
      unmergedCommitCounts: new Map([['dev/unknown-use', 0]]),
      uncommittedChanges: new Map([['dev/unknown-use', false]]),
      changedFileCounts: new Map([['dev/unknown-use', 0]]),
      readWorktreeProvenance: () => ({ owner: 'dev:test-harness', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' }),
    });
    expect(plan.remove).toEqual([]);
    expect(plan.unavailable).toBe(true);
    expect(plan.queryStatus).toEqual({ worktrees: true, branches: true, pullRequests: true, activeDirectories: false });
    expect(plan.preserve).toEqual([expect.objectContaining({ reason: 'query-failed:activeDirectories' })]);
  });

  it('currently-in-use wins even when another query failed and is counted in the human report', () => {
    const plan = planHarnessClean({
      worktrees: [wt('dev/priority')], branches: ['dev/priority'], ...emptyPrState, mode: 'all',
      activeDirectories: ['/wt/dev/priority'],
      queryStatus: { worktrees: false, branches: true, pullRequests: true, activeDirectories: true },
    });
    expect(plan.remove).toEqual([]);
    expect(plan.unavailable).toBe(true);
    expect(plan.preserve).toEqual([expect.objectContaining({ reason: 'currently-in-use' })]);
    expect(renderHarnessCleanReport({ plan, removed: [], failed: [], dryRun: true }, 'all').join('\n'))
      .toContain('보존(현재 사용 중) 1:');
  });

  it('currently-in-use wins over the existing open-PR and dirty preservation classifications', () => {
    const plan = planHarnessClean({
      worktrees: [wt('dev/priority')], branches: ['dev/priority'], openPr: new Set(['dev/priority']), mergedPr: new Set(), mode: 'all',
      activeDirectories: ['/wt/dev/priority'],
      uncommittedChanges: new Map([['dev/priority', true]]),
    });
    expect(plan.preserve).toEqual([expect.objectContaining({ reason: 'currently-in-use' })]);
  });
});

describe('planHarnessClean — orphaned worktree observation', () => {
  const base = {
    activeDirectories: [],
    worktrees: [wt('dev/registered')],
    branches: ['dev/registered'],
    openPr: new Set<string>(),
    mergedPr: new Set<string>(),
    mode: 'abandoned' as const,
  };

  it('등록 경로와 미등록 물리 디렉터리를 구분하고 고아를 remove에 넣지 않는다', () => {
    const plan = planHarnessClean({
      ...base,
      worktreeDirectories: ['/wt/dev/registered', '/wt/dev/orphaned'],
      registeredWorktreePaths: ['/wt/dev/registered'],
    });
    expect(plan.orphanedWorktrees).toEqual(['/wt/dev/orphaned']);
    expect(plan.remove).toEqual([expect.objectContaining({ branch: 'dev/registered', path: '/wt/dev/registered', reason: expect.stringContaining('abandoned; assessment=reclaim-safe') })]);
  });

  it('브랜치가 없고 log 하나뿐인 고아는 safe다', () => {
    const plan = planHarnessClean({
      ...base,
      worktreeDirectories: ['/wt/dev/registered', '/wt/orphaned'],
      registeredWorktreePaths: ['/wt/dev/registered'],
      orphanBranchQueryOk: true,
      orphanBranches: new Set(),
      orphanDirectoryEntries: new Map([['/wt/orphaned', ['log']]]),
    });
    expect(plan.orphanedWorktreeSafety).toEqual([{ path: '/wt/orphaned', safety: 'safe' }]);
  });

  it('대응 브랜치가 있는 고아는 unsafe다', () => {
    const plan = planHarnessClean({
      ...base,
      // ⛔ 픽스처를 **실물 형태**로 바꿨다 — worktree 디렉터리 이름은 worktreeDirName() 이
      //   브랜치를 평탄화한 것이다(`dev/orphaned` → `dev-orphaned`). 종전 픽스처(`/wt/orphaned`)는
      //   평탄화되지 않은 짝이라 **옛 규칙에서만** 맞았고 그래서 실버그를 못 잡았다(F3).
      worktreeDirectories: ['/wt/dev/registered', '/wt/dev-orphaned'],
      registeredWorktreePaths: ['/wt/dev/registered'],
      orphanBranchQueryOk: true,
      orphanBranches: new Set(['origin/dev/orphaned']),
      orphanDirectoryEntries: new Map([['/wt/dev-orphaned', ['log']]]),
    });
    expect(plan.orphanedWorktreeSafety).toEqual([{ path: '/wt/dev-orphaned', safety: 'unsafe' }]);
  });

  it('브랜치 조회 실패면 모든 고아는 unknown이다', () => {
    const plan = planHarnessClean({
      ...base,
      worktreeDirectories: ['/wt/dev/registered', '/wt/orphan-a', '/wt/orphan-b'],
      registeredWorktreePaths: ['/wt/dev/registered'],
      orphanBranchQueryOk: false,
      orphanBranches: new Set(),
      orphanDirectoryEntries: new Map([
        ['/wt/orphan-a', ['log']],
        ['/wt/orphan-b', ['log']],
      ]),
    });
    expect(plan.orphanedWorktreeSafety).toEqual([
      { path: '/wt/orphan-a', safety: 'unknown' },
      { path: '/wt/orphan-b', safety: 'unknown' },
    ]);
  });

  it('물리 디렉터리 목록을 생략하면 고아 목록은 비고 기존 분류는 같다', () => {
    const plan = planHarnessClean(base);
    expect(plan.orphanedWorktrees).toEqual([]);
    expect(plan.remove).toEqual([expect.objectContaining({ branch: 'dev/registered', path: '/wt/dev/registered', reason: expect.stringContaining('abandoned; assessment=reclaim-safe') })]);
    expect(plan.preserve).toEqual([]);
    expect(plan.unavailable).toBe(false);
  });

  it('고아 조회가 실패하면 unavailable이며 고아 판정을 하지 않는다', () => {
    const plan = planHarnessClean({
      ...base,
      worktreeDirectories: ['/wt/dev/registered', '/wt/dev/orphaned'],
      registeredWorktreePaths: ['/wt/dev/registered'],
      queryStatus: { worktrees: true, branches: true, pullRequests: true, directories: false, registeredWorktrees: true },
    });
    expect(plan.unavailable).toBe(true);
    expect(plan.orphanedWorktrees).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('PR 조회 실패에도 성공적으로 판정한 고아 관측을 보존하고 remove에 넣지 않는다', () => {
    const plan = planHarnessClean({
      ...base,
      worktreeDirectories: ['/wt/dev/registered', '/wt/dev/orphaned'],
      registeredWorktreePaths: ['/wt/dev/registered'],
      queryStatus: { worktrees: true, branches: true, pullRequests: false, directories: true, registeredWorktrees: true },
    });
    expect(plan.unavailable).toBe(true);
    expect(plan.orphanedWorktrees).toEqual(['/wt/dev/orphaned']);
    expect(plan.remove).toEqual([]);
  });
});

describe('registered worktree path and directory queries', () => {
  it('NUL porcelain preserves whitespace and newline paths as registered', () => {
    const registered = '/tmp/monad-agent.worktrees/dev/registered \n';
    expect(parseRegisteredWorktreePaths(`worktree ${registered}\0HEAD deadbeef\0\0`)).toEqual([registered]);
    const plan = planHarnessClean({ activeDirectories: [],
      worktrees: [], branches: [], openPr: new Set(), mergedPr: new Set(), mode: 'abandoned',
      worktreeDirectories: [registered],
      registeredWorktreePaths: [registered],
    });
    expect(plan.orphanedWorktrees).toEqual([]);
  });

  it('a missing worktree root is a successful empty directory query and preserves existing removal planning', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-clean-'));
    const repoRoot = join(root, 'monad-agent');
    try {
      const worktreeRoot = join(root, 'worktrees');
      const directories = listHarnessWorktreeDirectories(repoRoot, undefined, worktreeRoot);
      expect(existsSync(worktreeParentDir(repoRoot, worktreeRoot))).toBe(false);
      expect(directories).toEqual({ ok: true, value: [] });
      const plan = planHarnessClean({ activeDirectories: [],
        worktrees: [wt('dev/abandoned')], branches: ['dev/abandoned'],
        openPr: new Set(), mergedPr: new Set(), mode: 'abandoned',
        worktreeDirectories: directories.value,
        queryStatus: { worktrees: true, branches: true, pullRequests: true, directories: directories.ok },
      });
      expect(plan.unavailable).toBe(false);
      expect(plan.remove).toEqual([expect.objectContaining({ branch: 'dev/abandoned', path: '/wt/dev/abandoned', reason: expect.stringContaining('abandoned; assessment=reclaim-safe') })]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ⛔⭐ 2026-09-13 — 여기 있던 describe('harnessPrBranches — compact gh api JSONL') 224줄을 지웠다.
//   #18056 이 «닫힌 PR 전수 페이지네이션 ⊕ 그 커서 캐시» 서브시스템을 통째로 걷어냈고
//   (harnessClosedPrCachePath · writeHarnessClosedPrCache · HARNESS_CLOSED_PR_PAGINATION_TIMEOUT_MS),
//   그 블록은 «사라진 계약»만 시험하고 있었다. 지워진 API 를 부르는 자리는 저장소 전체에서
//   이 파일 하나뿐이었다(전수 확인). 새 계약(브랜치별 배치 GraphQL)은
//   src/harness/harness-clean.test.ts 가 39건으로 문다 — 실제 gh 응답 모양을 옮긴 시험 포함.


describe('parseHarnessPrBranches — PR 조회 신뢰 상태', () => {
  const planFrom = (query = parseHarnessPrBranches('[{"headRefName":"dev/a","state":"OPEN"}]')) => planHarnessClean({ activeDirectories: [],
    worktrees: [wt('dev/a')], branches: ['dev/a'], openPr: query.value.open, mergedPr: query.value.merged,
    mode: 'abandoned', queryStatus: { worktrees: true, branches: true, pullRequests: query.ok },
  });

  it('유효한 빈 응답은 성공이며 기존 abandoned 제거를 유지한다', () => {
    const query = parseHarnessPrBranches('[]');
    expect(query.ok).toBe(true);
    expect(planFrom(query).remove.map((item) => item.branch)).toEqual(['dev/a']);
  });

  it.each([
    ['open', 'OPEN'],
    ['merged', 'MERGED'],
  ] as const)('기존 단일 목록 파서는 한계 도달 %s 입력을 truncated로 유지한다', (state, prState) => {
    const stdout = JSON.stringify(Array.from({ length: 200 }, (_, index) => ({ headRefName: `self-impl/${index}`, state: prState })));
    const query = parseHarnessPrBranches(stdout, state);
    expect(query.ok).toBe(true);
    expect(query.value.truncated).toEqual({ open: state === 'open', merged: state === 'merged' });
  });

  it.each([
    ['open', 'OPEN'],
    ['merged', 'MERGED'],
  ] as const)('기존 단일 목록 파서는 한계 미만 %s 입력을 complete로 유지한다', (state, prState) => {
    const query = parseHarnessPrBranches(JSON.stringify([{ headRefName: 'self-impl/one', state: prState }]), state);
    expect(query.ok).toBe(true);
    expect(query.value.truncated).toEqual({ open: false, merged: false });
  });

  it.each([
    ['JSON 구문 오류', '{'],
    ['알 수 없는 상태', '[{"headRefName":"dev/a","state":"BROKEN"}]'],
    ['빈 브랜치명', '[{"headRefName":"","state":"OPEN"}]'],
  ])('%s 응답은 fail-closed로 remove를 막는다', (_label, stdout) => {
    const query = parseHarnessPrBranches(stdout);
    expect(query.ok).toBe(false);
    const plan = planFrom(query);
    expect(plan.remove).toEqual([]);
    expect(plan.preserve).toEqual([{ branch: 'dev/a', path: '/wt/dev/a', reason: 'query-failed:pullRequests' }]);
  });

  it('열린 PR은 force 없이 open-pr로 보존한다', () => {
    const plan = planFrom();
    expect(plan.remove).toEqual([]);
    expect(plan.preserve).toEqual([expect.objectContaining({ branch: 'dev/a', path: '/wt/dev/a', reason: expect.stringContaining('assessment=do-not-touch:open-pr') })]);
  });
});

describe('planHarnessClean — 미머지 커밋·미커밋 변경 보존', () => {
  const base = {
    activeDirectories: [],
    worktrees: [wt('dev/clean'), wt('dev/commits'), wt('dev/changes'), wt('dev/commit-query-failed'), wt('dev/change-query-failed'), wt('dev/open')],
    branches: ['dev/clean', 'dev/commits', 'dev/changes', 'dev/commit-query-failed', 'dev/change-query-failed', 'dev/open'],
    openPr: new Set(['dev/open']),
    mergedPr: new Set<string>(),
    mode: 'all' as const,
    unmergedCommitCounts: new Map<string, number | undefined>([
      ['dev/clean', 0], ['dev/commits', 2], ['dev/changes', 0], ['dev/commit-query-failed', undefined], ['dev/change-query-failed', 0], ['dev/open', 1],
    ]),
    uncommittedChanges: new Map<string, boolean | undefined>([
      ['dev/clean', false], ['dev/commits', false], ['dev/changes', true], ['dev/commit-query-failed', false], ['dev/change-query-failed', undefined], ['dev/open', true],
    ]),
  };

  it('미머지 커밋·미커밋 변경·각 측정 실패를 서로 다른 이유로 fail-closed 보존한다', () => {
    const plan = planHarnessClean(base);
    expect(plan.remove.map((item) => item.branch)).toEqual(['dev/clean']);
    const preserved = new Map(plan.preserve.map((item) => [item.branch, item.reason]));
    expect(preserved.get('dev/commits')).toContain('assessment=needs-human:no-pr-content-differs');
    expect(preserved.get('dev/changes')).toContain('assessment=do-not-touch:dirty-worktree');
    expect(preserved.get('dev/commit-query-failed')).toContain('assessment=unjudgeable:measurement-unavailable');
    expect(preserved.get('dev/change-query-failed')).toContain('assessment=unjudgeable:measurement-unavailable');
    expect(preserved.get('dev/open')).toContain('assessment=do-not-touch:open-pr');
  });

  it('열린 PR은 새 측정보다 먼저 open-pr로 보존한다', () => {
    const plan = planHarnessClean(base);
    expect(plan.preserve.find((item) => item.branch === 'dev/open')?.reason).toContain('assessment=do-not-touch:open-pr');
  });

  it('모든 새 측정이 성공하고 깨끗하면 종전 all 판정처럼 제거한다', () => {
    const before = planHarnessClean({ activeDirectories: [],
      worktrees: [wt('dev/clean')], branches: ['dev/clean'], openPr: new Set(), mergedPr: new Set(), mode: 'all',
    });
    const after = planHarnessClean({ activeDirectories: [],
      worktrees: [wt('dev/clean')], branches: ['dev/clean'], openPr: new Set(), mergedPr: new Set(), mode: 'all',
      unmergedCommitCounts: new Map([['dev/clean', 0]]), uncommittedChanges: new Map([['dev/clean', false]]),
    });
    expect(after.remove).toEqual(before.remove);
  });

  it('보고 화면은 각 보존 이유와 보존 대상을 구분해 말한다', () => {
    const plan = planHarnessClean(base);
    const lines = renderHarnessCleanReport({ plan, removed: [], failed: [], dryRun: true }, 'all').join('\n');
    expect(lines).toContain('assessment=needs-human:no-pr-content-differs');
    expect(lines).toContain('assessment=do-not-touch:dirty-worktree');
    expect(lines).toContain('assessment=unjudgeable:measurement-unavailable');
    expect(lines).toContain('assessment=do-not-touch:open-pr');
    expect(lines).toContain('ownership=recorded:owner=dev:test-harness;command=elanous dev;createdAt=2026-08-05T00:00:00.000Z');
  });
});

describe('harness clean branch safety measurement — worktree HEAD and fail-closed wiring', () => {
  const worktrees = [wt('dev/a')];

  it('각 worktree에서 HEAD 기준 rev-list와 porcelain을 실행해 planner 입력을 만든다', () => {
    const calls: string[][] = [];
    const safety = measureBranchSafety(worktrees, ['dev/a'], (args) => {
      calls.push(args);
      if (args.includes('rev-list')) return { status: 0, stdout: '2\n', stderr: '' };
      if (args.includes('status')) return { status: 0, stdout: ' M src/a.ts\n', stderr: '' };
      return { status: 0, stdout: 'src/a.ts\0', stderr: '' };
    });
    expect(calls).toEqual([
      ['-C', '/wt/dev/a', 'rev-list', '--count', 'origin/main..HEAD'],
      ['-C', '/wt/dev/a', 'status', '--porcelain'],
      ['-C', '/wt/dev/a', 'diff', '--name-only', '-z', 'origin/main...HEAD'],
      ['-C', '/wt/dev/a', 'diff', '--name-only', '-z', 'origin/main', 'HEAD', '--', 'src/a.ts'],
    ]);
    expect(safety.unmergedCommitCounts.get('dev/a')).toBe(2);
    expect(safety.uncommittedChanges.get('dev/a')).toBe(true);
    expect(planHarnessCleanImpl({ activeDirectories: [], worktrees, branches: ['dev/a'], openPr: new Set(), mergedPr: new Set(), mode: 'all', ...safety }).preserve[0]?.reason).toContain('assessment=do-not-touch:dirty-worktree');
  });

  it('비정상 count·명령 실패·등록 worktree 없는 브랜치를 unknown으로 남겨 제거하지 않는다', () => {
    const malformed = measureBranchSafety(worktrees, ['dev/a'], (args) => args.includes('rev-list')
      ? { status: 0, stdout: '2garbage\n', stderr: '' }
      : { status: 0, stdout: '', stderr: '' });
    const failed = measureBranchSafety(worktrees, ['dev/a'], () => ({ status: 1, stdout: '', stderr: 'failure' }));
    const absent = measureBranchSafety([], ['dev/branch-only'], () => ({ status: 0, stdout: '', stderr: '' }));
    for (const safety of [malformed, failed, absent]) {
      const branch = safety === absent ? 'dev/branch-only' : 'dev/a';
      const plan = planHarnessCleanImpl({ activeDirectories: [], worktrees: branch === 'dev/a' ? worktrees : [], branches: [branch], openPr: new Set(), mergedPr: new Set(), mode: 'all', ...safety });
      expect(plan.remove).toEqual([]);
      expect(plan.preserve[0]?.reason).toContain(branch === 'dev/branch-only' ? 'assessment=unjudgeable:worktree-unavailable' : 'assessment=unjudgeable:measurement-unavailable');
    }
  });

  it('planner 측정 맵 자체가 누락되어도 TypeScript 우회 호출은 unknown으로 보존한다', () => {
    const plan = planHarnessCleanImpl({ activeDirectories: [],
      worktrees, branches: ['dev/a'], openPr: new Set(), mergedPr: new Set(), mode: 'all',
    } as unknown as Parameters<typeof planHarnessCleanImpl>[0]);
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toContain('assessment=unjudgeable:measurement-unavailable');
  });
});

describe('planHarnessClean — mode 분류', () => {
  const setup = {
    worktrees: [wt('dev/abandoned'), wt('dev/merged'), wt('dev/open')],
    branches: ['dev/abandoned', 'dev/merged', 'dev/open', 'dev/branch-only'],
    openPr: new Set(['dev/open']),
    mergedPr: new Set(['dev/merged']),
  };
  it('abandoned — PR 이력 없는 것만(open·merged 제외)', () => {
    const p = planHarnessClean({ activeDirectories: [], ...setup, mode: 'abandoned' });
    const rm = p.remove.map((x) => x.branch).sort();
    expect(rm).toEqual(['dev/abandoned']);
  });
  it('merged — 머지된 것만', () => {
    const p = planHarnessClean({ activeDirectories: [], ...setup, mode: 'merged' });
    expect(p.remove.map((x) => x.branch)).toEqual(['dev/merged']);
  });
  it('all — 열린 PR 외 전부', () => {
    const p = planHarnessClean({ activeDirectories: [], ...setup, mode: 'all' });
    const rm = p.remove.map((x) => x.branch).sort();
    expect(rm).toEqual(['dev/abandoned', 'dev/merged']);
    expect(p.remove.every((x) => x.branch !== 'dev/open')).toBe(true);
  });
  it('worktree 경로는 remove item 에 실린다(worktree remove 대상)', () => {
    const p = planHarnessClean({ activeDirectories: [], ...setup, mode: 'abandoned' });
    expect(p.remove.find((x) => x.branch === 'dev/abandoned')?.path).toBe('/wt/dev/abandoned');
    expect(p.remove.find((x) => x.branch === 'dev/branch-only')?.path).toBeUndefined();
  });
});

describe('planHarnessClean — 고아 판정 입력 완결성 (리뷰 must-fix)', () => {
  const emptyPr = { openPr: new Set<string>(), mergedPr: new Set<string>() };
  const ok = { worktrees: true, branches: true, pullRequests: true, directories: true, registeredWorktrees: true };

  it('registeredWorktreePaths 를 생략하면 고아 판정을 하지 않는다', () => {
    // ⛔ 대용하면 prefix 밖 정상 등록 worktree 가 고아로 오판된다.
    const p = planHarnessClean({ activeDirectories: [],
      worktrees: [wt('dev/a')], branches: ['dev/a'], ...emptyPr, mode: 'abandoned',
      queryStatus: ok, worktreeDirectories: ['/wt/other-prefix', '/wt/dev/a'],
    });
    expect(p.orphanedWorktrees).toEqual([]);
  });

  it('두 입력이 다 있으면 등록 안 된 것만 고아이고 remove 는 안 늘어난다', () => {
    const before = planHarnessClean({ activeDirectories: [],
      worktrees: [wt('dev/a')], branches: ['dev/a'], ...emptyPr, mode: 'abandoned', queryStatus: ok,
    });
    const p = planHarnessClean({ activeDirectories: [],
      worktrees: [wt('dev/a')], branches: ['dev/a'], ...emptyPr, mode: 'abandoned', queryStatus: ok,
      worktreeDirectories: ['/wt/dev/a', '/wt/orphan-b', '/wt/orphan-a'],
      registeredWorktreePaths: ['/wt/dev/a', '/wt/other-prefix'],
    });
    expect(p.orphanedWorktrees).toEqual(['/wt/orphan-a', '/wt/orphan-b']);  // ⭐ 정렬 고정
    expect(p.remove).toEqual(before.remove);                                 // ⭐ remove 무영향
  });

  it('prefix 밖으로 등록된 worktree 는 고아가 아니다', () => {
    const p = planHarnessClean({ activeDirectories: [],
      worktrees: [wt('dev/a')], branches: ['dev/a'], ...emptyPr, mode: 'abandoned', queryStatus: ok,
      worktreeDirectories: ['/wt/other-prefix'],
      registeredWorktreePaths: ['/wt/dev/a', '/wt/other-prefix'],
    });
    expect(p.orphanedWorktrees).toEqual([]);
  });

  it('디렉터리 조회가 실패하면 고아 판정을 하지 않고 unavailable 이다', () => {
    const p = planHarnessClean({ activeDirectories: [],
      worktrees: [wt('dev/a')], branches: ['dev/a'], ...emptyPr, mode: 'abandoned',
      queryStatus: { ...ok, directories: false },
      worktreeDirectories: [], registeredWorktreePaths: ['/wt/dev/a'],
    });
    expect(p.orphanedWorktrees).toEqual([]);
    expect(p.unavailable).toBe(true);
  });
});

describe('listHarnessWorktreeDirectories — 뿌리 확정·정렬 (실제 fixture · 리뷰 must-fix)', () => {
  it('⭐ 실제 sibling(.worktrees)을 골라 정렬해 돌려준다 — 빈 목록으로 통과할 수 없다', () => {
    const base = mkdtempSync(join(tmpdir(), 'hc-root-'));
    try {
      const repo = join(base, 'repo');
      const root = join(base, 'worktrees');
      const parent = worktreeParentDir(join(base, 'repo'), root);
      mkdirSync(join(parent, 'zeta'), { recursive: true });
      mkdirSync(join(parent, 'alpha'), { recursive: true });
      mkdirSync(join(parent, 'mid'), { recursive: true });
      writeFileSync(join(parent, 'not-a-dir.txt'), 'x');       // 파일은 제외돼야 한다
      const r = listHarnessWorktreeDirectories(repo, undefined, root);
      expect(r.ok).toBe(true);
      expect(r.value).toEqual([join(parent, 'alpha'), join(parent, 'mid'), join(parent, 'zeta')]);  // ⭐ 정렬 ⊕ 비어 있지 않다
      expect(r.value).toHaveLength(3);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('뿌리가 확정된 뒤 .worktrees 가 없으면 성공·빈 목록이다', () => {
    const base = mkdtempSync(join(tmpdir(), 'hc-root-'));
    try {
      const r = listHarnessWorktreeDirectories(join(base, 'repo'), undefined, join(base, 'worktrees'));
      expect(r.ok).toBe(true);
      expect(r.value).toEqual([]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('⭐⭐ 연결된 worktree 안에서 실행해도 **주 저장소**의 sibling 을 본다 (리뷰 must-fix)', () => {
    const base = mkdtempSync(join(tmpdir(), 'hc-root-'));
    try {
      const main = join(base, 'repo');
      const root = join(base, 'worktrees');
      mkdirSync(join(worktreeParentDir(join(base, 'repo'), root), 'orphan-x'), { recursive: true });
      // ⛔ 연결된 worktree 안이라 --show-toplevel 은 그쪽을 답한다. --git-common-dir 만 주 저장소를 준다.
      const linked = (args: string[]) => {
        expect(args).toEqual(['rev-parse', '--path-format=absolute', '--git-common-dir']);
        return { status: 0, stdout: `${join(main, '.git')}\n`, stderr: '' };
      };
      const r = listHarnessWorktreeDirectories(undefined, linked, root);
      expect(r.ok).toBe(true);
      expect(r.value).toEqual([join(worktreeParentDir(join(base, 'repo'), root), 'orphan-x')]);   // ⭐ 고아를 놓치지 않는다
      expect(r.value).toHaveLength(1);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('common-dir 이 .git 이 아니면 「못 셌다」로 둔다', () => {
    const weird = () => ({ status: 0, stdout: '/some/bare-repo\n', stderr: '' });
    expect(listHarnessWorktreeDirectories(undefined, weird).ok).toBe(false);
  });

  it('⭐ 반증 입력 — rev-parse 의 stderr 가 「그럴듯한 경로」여도 루트가 안 바뀐다', () => {
    const base = mkdtempSync(join(tmpdir(), 'hc-root-'));
    try {
      const repo = join(base, 'repo');
      const root = join(base, 'worktrees');
      mkdirSync(join(worktreeParentDir(join(base, 'repo'), root), 'only'), { recursive: true });
      const noisy = (args: string[]) => {
        expect(args).toEqual(['rev-parse', '--path-format=absolute', '--git-common-dir']);
        // ⛔ stderr 도 경로 모양이다 — 결합 구현이면 루트가 이쪽으로 오염된다(반증 입력).
        return { status: 0, stdout: `${join(repo, '.git')}\n`, stderr: `${join(base, 'wrong-root', '.git')}\n` };
      };
      const r = listHarnessWorktreeDirectories(undefined, noisy, root);
      expect(r.ok).toBe(true);
      expect(r.value).toEqual([join(worktreeParentDir(join(base, 'repo'), root), 'only')]);   // ⭐ 경고가 경로에 안 섞였다
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('rev-parse 가 실패하면 「못 셌다」로 둔다', () => {
    const failing = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository\n' });
    const r = listHarnessWorktreeDirectories(undefined, failing);
    expect(r.ok).toBe(false);
    expect(r.value).toEqual([]);
  });
});

describe('listRegisteredWorktreePaths — stdout 전용 (실행 경로 검증 · 리뷰 must-fix)', () => {
  it('⭐ 반증 입력 — stderr 의 「구조화된 미끼」가 경로로 승격되지 않는다', () => {
    // ⛔ `warning:` 같은 문면은 파서가 어차피 버리므로 결합 구현이어도 통과한다(리뷰 must-fix).
    //    stderr 에 **파서가 받아들일 모양**(`worktree …`)을 넣어야 stdout-only 를 증명한다.
    const poisoned = (args: string[]) => {
      expect(args).toEqual(['worktree', 'list', '--porcelain', '-z']);
      return {
        status: 0,
        stdout: 'worktree /a\0HEAD deadbeef\0\0worktree /b\0',
        stderr: 'worktree /stderr-poison\0worktree /stderr-poison-2\0',
      };
    };
    const got = listRegisteredWorktreePaths(poisoned).value;
    expect(got).toEqual([resolve('/a'), resolve('/b')]);
    expect(got).not.toContain(resolve('/stderr-poison'));     // ⭐ 결합 구현이면 여기서 깨진다
    expect(got).toHaveLength(2);
  });

  it('실패하면 「못 셌다」로 둔다', () => {
    const r = listRegisteredWorktreePaths(() => ({ status: 1, stdout: '', stderr: 'boom' }));
    expect(r.ok).toBe(false);
    expect(r.value).toEqual([]);
  });
});

describe('parseRegisteredWorktreePaths — stderr 오염 방지 (리뷰 파생)', () => {
  it('worktree 레코드만 경로로 받는다', () => {
    const out = ['worktree /a', 'HEAD abc', 'branch refs/heads/x', 'worktree /b', ''].join('\0');
    expect(parseRegisteredWorktreePaths(out)).toEqual([resolve('/a'), resolve('/b')]);
  });

  it('경고 문자열이 섞여 들어와도 경로로 승격되지 않는다', () => {
    const out = ['warning: something', 'worktree /a', 'error: other'].join('\0');
    expect(parseRegisteredWorktreePaths(out)).toEqual([resolve('/a')]);
  });
});

describe('classifyOrphanWorktree — 브랜치 이름 평탄화 (사후 리뷰가 잡은 실버그)', () => {
  const emptyPr = { openPr: new Set<string>(), mergedPr: new Set<string>() };
  const ok = { worktrees: true, branches: true, pullRequests: true, directories: true, registeredWorktrees: true };
  const dir = (p: string) => `/wt/${p}`;

  const plan = (orphanDir: string, branches: string[], entries: string[]) => planHarnessClean({ activeDirectories: [],
    worktrees: [], branches: [], ...emptyPr, mode: 'abandoned', queryStatus: ok,
    worktreeDirectories: [dir(orphanDir)], registeredWorktreePaths: [],
    orphanBranchQueryOk: true,
    orphanBranches: new Set(branches),
    orphanDirectoryEntries: new Map([[dir(orphanDir), entries]]),
  });

  it('⭐ 반증 입력 — 슬래시 브랜치가 평탄화된 디렉터리와 짝이면 unsafe 다', () => {
    // ⛔ 평탄화 없이 비교하면 이 짝이 안 맞아 safe 로 떨어진다(원래 버그).
    const p = plan('dev-src-scratch-plan-smoke', ['dev/src-scratch-plan-smoke'], ['log']);
    expect(p.orphanedWorktreeSafety).toEqual([{ path: dir('dev-src-scratch-plan-smoke'), safety: 'unsafe' }]);
  });

  it('self-impl/ 접두도 같다', () => {
    const p = plan('self-impl-nl-2-6-t-0-scripts', ['self-impl/nl-2-6-t-0-scripts'], ['log']);
    expect(p.orphanedWorktreeSafety[0]?.safety).toBe('unsafe');
  });

  it('브랜치가 없고 log 하나뿐이면 safe 다', () => {
    const p = plan('dev-gone', [], ['log']);
    expect(p.orphanedWorktreeSafety[0]?.safety).toBe('safe');
  });

  it('log 외 항목이 있으면 safe 가 아니다', () => {
    const p = plan('dev-gone', [], ['log', 'src']);
    expect(p.orphanedWorktreeSafety[0]?.safety).toBe('unknown');
  });

  it('브랜치 조회가 실패하면 전부 unknown 이다', () => {
    const p = planHarnessClean({ activeDirectories: [],
      worktrees: [], branches: [], ...emptyPr, mode: 'abandoned', queryStatus: ok,
      worktreeDirectories: [dir('dev-gone')], registeredWorktreePaths: [],
      orphanBranchQueryOk: false,
      orphanBranches: new Set(['dev/gone']),
      orphanDirectoryEntries: new Map([[dir('dev-gone'), ['log']]]),
    });
    expect(p.orphanedWorktreeSafety[0]?.safety).toBe('unknown');
  });
});

describe('classifyOrphanWorktree — 로컬 슬래시 브랜치를 원격으로 오인하지 않는다 (리뷰 must-fix)', () => {
  const emptyPr = { openPr: new Set<string>(), mergedPr: new Set<string>() };
  const ok = { worktrees: true, branches: true, pullRequests: true, directories: true, registeredWorktrees: true };

  it('⭐ 반증 입력 — 로컬 `dev/x` 가 있어도 무관한 `/wt/x` 는 unsafe 가 아니다', () => {
    // ⛔ 첫 세그먼트를 무조건 벗기면 dev/x → x 가 되어 /wt/x 를 잘못 unsafe 로 만든다.
    const p = planHarnessClean({ activeDirectories: [],
      worktrees: [], branches: [], ...emptyPr, mode: 'abandoned', queryStatus: ok,
      worktreeDirectories: ['/wt/x'], registeredWorktreePaths: [],
      orphanBranchQueryOk: true,
      orphanBranches: new Set(['dev/x']),
      orphanDirectoryEntries: new Map([['/wt/x', ['log']]]),
    });
    expect(p.orphanedWorktreeSafety[0]?.safety).toBe('safe');
  });

  it('원격 `origin/dev/x` 는 평탄화 디렉터리 `dev-x` 와 짝이면 unsafe 다', () => {
    const p = planHarnessClean({ activeDirectories: [],
      worktrees: [], branches: [], ...emptyPr, mode: 'abandoned', queryStatus: ok,
      worktreeDirectories: ['/wt/dev-x'], registeredWorktreePaths: [],
      orphanBranchQueryOk: true,
      orphanBranches: new Set(['origin/dev/x']),
      orphanDirectoryEntries: new Map([['/wt/dev-x', ['log']]]),
    });
    expect(p.orphanedWorktreeSafety[0]?.safety).toBe('unsafe');
  });
});

describe('git 재시도 — 일시 판정의 현재 경계 (리뷰 should-fix · 사실을 못 박는다)', () => {
  const run = (results: Array<{ status: number; stderr: string }>) => {
    let n = 0;
    const fn = (_args: string[]) => { const r = results[Math.min(n, results.length - 1)]!; n += 1; return { status: r.status, stdout: '', stderr: r.stderr }; };
    return { fn, calls: () => n };
  };

  it('⚠️ `lock` 이 든 **영구** 오류도 지금은 재시도된다 — 문면이 넓다는 사실을 고정한다', () => {
    // ⛔ 이것은 바람직해서가 아니라 worktree.ts 의 실전 정규식과 같기 때문이다.
    //    좁히려면 두 자리를 함께 바꿔야 하므로 별도 골이다.
    const r = run([{ status: 128, stderr: "fatal: could not lock config file .git/config: Permission denied" }]);
    listHarnessWorktrees('dev/', r.fn);
    expect(r.calls()).toBe(6);       // ⭐ 상한까지 돈다
  });

  it('키워드가 없는 영구 오류는 정확히 한 번만 시도한다', () => {
    const r = run([{ status: 128, stderr: 'fatal: invalid reference: nope' }]);
    listHarnessWorktrees('dev/', r.fn);
    expect(r.calls()).toBe(1);
  });
});

// ⭐⭐⭐ 관측 — **이 실행이 무엇을 봤나** (대표 2026-08-03 "관측 문제는 우선순위")
//
// ⛔ 왜 이 테스트가 있나: 실측(2026-08-03) 결과 기본 `branchPrefix='dev/'` 에 걸리는 워크트리가
//   **0개**였고 실제 워크트리는 `self-impl/` **156개**였다. 그런데 사람 화면은 `remove.length === 0`
//   만 보고 *"정리 대상 없음"* 을 찍었다.
//   ⇒ ***도구가 아무것도 안 보는데 화면은 「깨끗하다」고 말했다.***
//   「없다」와 「이 스코프가 안 본다」가 같은 문장이 되면 그 도구는 관측 도구가 아니다.
//   ⇒ 계획이 **스코프를 들고 다니게** 해서 화면이 둘을 갈라 말할 수 있게 한다.
describe('harness clean — 스코프를 산출에 싣는다 (0건과 「안 봤다」를 가른다)', () => {
  it('기본 prefix는 생성 측과 공유하는 상수이며 --prefix 없이 그 worktree를 스코프에 넣는다', () => {
    const branch = `${WORKTREE_BRANCH_PREFIX}default-scope`;
    const run = (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list' && !args.includes('-z')) {
        return { status: 0, stdout: `worktree /wt/default-scope\nHEAD deadbeef\nbranch refs/heads/${branch}\n`, stderr: '' };
      }
      if (args[0] === 'branch') return { status: 0, stdout: `${branch}\n`, stderr: '' };
      if (args.includes('rev-list')) return { status: 0, stdout: '0\n', stderr: '' };
      if (args.includes('status')) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const res = execHarnessClean({ mode: 'abandoned', dryRun: true, run, runGh: () => ({ status: 0, stdout: '' }) });
    expect(res.plan.scope).toBeDefined();
    expect(res.plan.scope!.branchPrefix).toBe(WORKTREE_BRANCH_PREFIX);
    expect(res.plan.scope!.matchedWorktrees).toBe(1);
    expect(res.plan.scope!.matchedBranches).toBe(1);
  });

  /**
   * ⛔⭐⭐⭐ **값이 같은지가 아니라 «같은 상수를 참조하는지»를 문다**(무인 리뷰 must-fix).
   *   위 단언은 «값»만 본다 ⇒ 생성 측이나 정리 측을 리터럴 `'self-impl/'` 로 되돌려도 통과한다.
   *   ***그러면 「두 곳이 갈리면 실패한다」는 이 골의 요구를 못 채운다.***
   *   ⇒ 소스에서 그 리터럴이 «상수 모듈 밖»에 있는지를 센다. 되돌리는 순간 여기가 운다.
   */
  it('접두가 «상수 밖»에서 다시 생기지 않는다 — 되돌리면 이 회귀가 운다', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    // ⛔ 리터럴을 «조각»으로 — 통째로 두면 이 파일 자신이 걸린다.
    const bare = 'self-' + 'impl/';
    const quoted = "'" + bare + "'";

    // ⓐ 생성 측·CLI 는 접두 리터럴을 복제하지 않는다. 생성은 공유 팩토리를 호출한다.
    for (const rel of ['src/self-implement/orchestrator.ts', 'src/index.ts']) {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(`${rel}: ${src.includes(bare) ? '접두 재출현' : '(없음)'}`).toBe(`${rel}: (없음)`);
    }

    // ⓑ 정리 측은 «맨 문자열»을 정당하게 갖는다 — 주석 둘 ⊕ 사용자 안내 하나(--prefix 예시).
    //    ⇒ 여기서는 「기본값 자리에 리터럴이 돌아왔나」만 문다.
    const clean = readFileSync(join(root, 'src/harness/harness-clean.ts'), 'utf8');
    expect(clean.includes('?? ' + quoted)).toBe(false);

    // ⭐ 그리고 상수 모듈에는 «있어야» 한다 — 없으면 값이 어디서도 안 나온다.
    expect(readFileSync(join(root, 'src/harness/worktree-branch-prefix.ts'), 'utf8')).toContain(quoted);

    // ⭐⭐⭐ 「사용 지점」 — 각 파일이 «그 식으로» 쓰는가. 다른 상수로 바꾸면 여기가 운다.
    // ⭐ [파일, 식, «기대 개수»] — 개수를 박아 「하나만 남기기」를 막는다.
    const useSites: Array<[string, string, number]> = [
      ['src/harness/harness-clean.ts', 'opts.branchPrefix ?? WORKTREE_BRANCH_PREFIX', 1],
      ['src/self-implement/orchestrator.ts', 'plannedSelfImplBranch(opts.feature, opts.goalId, runId)', 2],
      // ⛔ index.ts 는 «조합된 식»을 문다 — 식별자만 보면 import 줄로도 통과한다.
      ['src/index.ts', '기본 ${WORKTREE_BRANCH_PREFIX_HELP}', 1],
    ];
    for (const [rel, expr, times] of useSites) {
      const src = readFileSync(join(root, rel), 'utf8');
      // ⛔⭐ 「하나라도 있나」로는 부족하다 — orchestrator 는 계산식이 «둘»이고,
      //   하나만 남겨도 includes 가 통과한다(무인 리뷰가 짚었다). ⇒ «개수»를 문다.
      const n = src.split(expr).length - 1;
      expect(`${rel}: ${n}`).toBe(`${rel}: ${times}`);
    }
    // ⛔⭐⭐⭐ `src/index.ts` 는 «소스 문자열»로 못 잡는다 — `WORKTREE_BRANCH_PREFIX_HELP` 가
    //   «import 줄»에만 있어도 통과한다(무인 리뷰가 짚었다). 도움말을 별도 상수로 바꾸고
    //   import 를 미사용으로 남기면 그대로 빠져나간다.
    //   ⇒ ***렌더된 help 를 «실물»로 본다.*** 이건 포맷·이름과 무관하게 «결과»를 잰다.
    const help = spawnSync('bun', [join(root, 'bin', 'elanous.mjs'), 'harness', 'clean', '--help'],
      { cwd: root, encoding: 'utf8', timeout: 60_000 });
    const prefixLine = (help.stdout ?? '').split('\n').find((l) => l.includes('--prefix')) ?? '';
    expect(prefixLine).toContain(WORKTREE_BRANCH_PREFIX);

    // ⛔⭐⭐⭐ 「접두가 없다」만으로는 «별도 상수 복제»를 못 잡는다(무인 리뷰 must-fix).
    //   ⇒ 양쪽이 «그 모듈에서» 가져오는지를 «직접» 문다. 다른 상수를 만들면 여기가 운다.
    const importer = 'worktree-branch-prefix';
    for (const rel of ['src/harness/harness-clean.ts', 'src/index.ts']) {
      const src = readFileSync(join(root, rel), 'utf8');
      // ⛔⭐⭐⭐ 「바인딩이 있나」로도 부족하다 — «미사용 import + 다른 이름의 별도 상수»가 빠져나간다
      //   (무인 리뷰가 두 번 짚었다: `const CLEAN_PREFIX = '…'` 을 기본값으로 쓰면 통과했다).
      //   ⇒ ***「사용 지점」을 직접 못 박는다.*** 아래 표현이 사라지면 여기가 운다.
      const bound = new RegExp(`import\\s*\\{[^}]*WORKTREE_BRANCH_PREFIX[^}]*\\}\\s*from\\s*['"][^'"]*${importer}`).test(src);
      expect(`${rel}: bound=${bound}`).toBe(`${rel}: bound=true`);
    }
    const branchFactory = readFileSync(join(root, 'src/harness/worktree-branch-prefix.ts'), 'utf8');
    expect(branchFactory).toContain('return `${WORKTREE_BRANCH_PREFIX}${slug}${runSuffix}`');
    expect(branchFactory).toContain('return `${WORKTREE_BRANCH_PREFIX}goalid-${id}-${readable}-${digest}${runSuffix}`');
    expect(readFileSync(join(root, 'src/self-implement/orchestrator.ts'), 'utf8')).toContain("from '../harness/worktree-branch-prefix.js'");
  });

  it('--prefix는 공유 기본값을 덮고, «실제 조회 필터»가 그 값을 쓴다', () => {
    // ⛔⭐⭐⭐ 초판은 `plan.scope.branchPrefix` 라는 «메타데이터»만 봤다(무인 리뷰 must-fix).
    //   ⇒ 값이 전달됐는지만 알 뿐 ***그 값으로 「걸렀는지」는 안 본다.***
    //   ⇒ 그래서 override 브랜치는 «포함»되고 기본 접두 브랜치는 «제외»되는지를 결과로 문다.
    const overrideBranch = 'override/kept';
    const defaultBranch = `${WORKTREE_BRANCH_PREFIX}dropped`;
    const run = (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list' && !args.includes('-z')) {
        return {
          status: 0,
          stdout:
            `worktree /wt/kept\nHEAD deadbeef\nbranch refs/heads/${overrideBranch}\n\n` +
            `worktree /wt/dropped\nHEAD cafebabe\nbranch refs/heads/${defaultBranch}\n`,
          stderr: '',
        };
      }
      if (args[0] === 'branch') {
        // ⛔ 스텁이 `--list <패턴>` 을 «무시하면» 이 테스트가 제품이 아니라 «스텁»을 잰다.
        //   실측으로 그것을 밟았다(matchedBranches 가 2 로 나왔다) ⇒ git 처럼 거른다.
        const pattern = args.find((a) => a.endsWith('*'))?.slice(0, -1) ?? '';
        const all = [overrideBranch, defaultBranch].filter((b) => b.startsWith(pattern));
        return { status: 0, stdout: all.length ? `${all.join('\n')}\n` : '', stderr: '' };
      }
      if (args.includes('rev-list')) return { status: 0, stdout: '0\n', stderr: '' };
      if (args.includes('status')) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const res = execHarnessClean({ mode: 'abandoned', dryRun: true, branchPrefix: 'override/', run, runGh: () => ({ status: 0, stdout: '' }) });
    expect(res.plan.scope!.branchPrefix).toBe('override/');
    // ⭐ 행동: override 하나만 걸리고 기본 접두는 «안» 걸린다.
    expect(res.plan.scope!.matchedWorktrees).toBe(1);
    expect(res.plan.scope!.matchedBranches).toBe(1);
    expect(JSON.stringify(res.plan)).toContain(overrideBranch);
    expect(JSON.stringify(res.plan)).not.toContain(defaultBranch);
  });

  it('명시 prefix 가 scope 에 그대로 반영된다 (무엇을 봤는지 나중에 로그로 잴 수 있어야 한다)', () => {
    const res = execHarnessClean({
      mode: 'abandoned',
      dryRun: true,
      branchPrefix: 'no-such-prefix-xyz/',
      runGh: () => ({ status: 0, stdout: '' }),
    });
    expect(res.plan.scope!.branchPrefix).toBe('no-such-prefix-xyz/');
    // ⛔⭐⭐⭐ 여기서 **0 의 뜻을 먼저 가른다**(무인 리뷰 must-fix — 이 PR 의 명제를 이 테스트가 안 물었다).
    //   git 질의가 통째로 실패해도 값은 빈 배열이 되어 `matchedWorktrees === 0` 이 **거짓 통과**한다.
    //   ⇒ 「없다」로 읽기 전에 「쟀다」를 먼저 단언한다. 이 PR 이 화면에 요구한 것과 같은 규율이다.
    expect(res.plan.queryStatus?.worktrees).toBe(true);
    expect(res.plan.queryStatus?.branches).toBe(true);
    expect(res.plan.unavailable).toBe(false);
    // ⭐ 그 위에서만 0 을 「이 prefix 에 없다」로 읽는다.
    expect(res.plan.scope!.matchedWorktrees).toBe(0);
    expect(res.plan.scope!.matchedBranches).toBe(0);
    expect(res.plan.remove).toHaveLength(0);
  });

  it('⛔ dryRun 은 아무것도 지우지 않는다 (관측 추가가 파괴를 부르지 않았다)', () => {
    const res = execHarnessClean({ mode: 'abandoned', dryRun: true, run: () => ({ status: 0, stdout: '', stderr: '' }), runGh: () => ({ status: 0, stdout: '' }) });
    expect(res.dryRun).toBe(true);
    expect(res.removed).toHaveLength(0);
    expect(res.failed).toHaveLength(0);
  });
});

// ⭐⭐⭐ 화면 — **아는 것을 숨기지 않는다** (무인 리뷰 must-fix: index.ts 변경을 테스트가 못 쟀다)
//
// ⛔ 이 PR 의 본체는 화면이다. 그런데 조립이 CLI action 안에 있어 *"index.ts 변경을 전부 지워도
//   테스트가 통과"* 했다. ⇒ 순수 함수로 빼고 여기서 **문장 단위로** 문다.
describe('renderHarnessCleanReport — 스코프·고아·질의실패를 화면이 말한다', () => {
  const emptyPlan = (over: Partial<import('../src/harness/harness-clean.js').HarnessCleanPlan> = {}) => ({
    remove: [], preserve: [], orphanedWorktrees: [], orphanedWorktreeSafety: [],
    unavailable: false,
    queryStatus: { worktrees: true, branches: true, pullRequests: true, directories: true, registeredWorktrees: true },
    ...over,
  });
  const result = (over: Partial<import('../src/harness/harness-clean.js').HarnessCleanPlan> = {}, res: Partial<{ removed: never[]; failed: never[]; dryRun: boolean }> = {}) =>
    ({ plan: emptyPlan(over), removed: [], failed: [], dryRun: true, ...res }) as never;

  it('currently-in-use preservation count is human-readable', () => {
    const out = renderHarnessCleanReport(result({
      preserve: [
        { branch: 'dev/active-a', reason: 'currently-in-use' },
        { branch: 'dev/active-b', reason: 'currently-in-use' },
      ],
    }), 'abandoned').join('\n');
    expect(out).toContain('보존(현재 사용 중) 2');
  });

  it('PR 조회 실패 원인을 query-failed 보존과 함께 말한다', () => {
    const out = renderHarnessCleanReport(result({
      queryStatus: { worktrees: true, branches: true, pullRequests: false, pullRequestsFailure: 'spawnSync gh ENOBUFS' },
      preserve: [{ branch: 'self-impl/candidate', reason: 'query-failed:pullRequests' }],
      unavailable: true,
    }), 'abandoned').join('\n');
    expect(out).toContain('질의 실패: pullRequests');
    expect(out).toContain('PR 조회 실패 원인: spawnSync gh ENOBUFS');
    expect(out).toContain('기존 질의 실패 (pullRequests)');
  });

  it('스코프를 remove 목록보다 **먼저** 말한다', () => {
    const out = renderHarnessCleanReport(result({ scope: { branchPrefix: 'dev/', matchedWorktrees: 3, matchedBranches: 5 } }), 'abandoned');
    const scopeAt = out.findIndex((l) => l.includes('스코프 prefix=dev/'));
    const emptyAt = out.findIndex((l) => l.includes('정리 대상 없음'));
    expect(scopeAt).toBeGreaterThan(-1);
    expect(out[scopeAt]).toContain('worktree 3');
    expect(out[scopeAt]).toContain('브랜치 5');
    expect(scopeAt).toBeLessThan(emptyAt);
  });

  it('⛔ 0/0 이면 「깨끗함이 아닐 수 있다」와 --prefix 길을 같이 준다 (금지가 아니라 길)', () => {
    const out = renderHarnessCleanReport(result({ scope: { branchPrefix: 'dev/', matchedWorktrees: 0, matchedBranches: 0 } }), 'abandoned').join('\n');
    expect(out).toContain('이 스코프가 아무것도 안 본다');
    expect(out).toContain('--prefix');
    expect(out).toContain('self-impl/');
  });

  it('0/0 이 아니면 그 경고를 안 낸다 (소음 금지)', () => {
    const out = renderHarnessCleanReport(result({ scope: { branchPrefix: 'dev/', matchedWorktrees: 1, matchedBranches: 0 } }), 'abandoned').join('\n');
    expect(out).not.toContain('이 스코프가 아무것도 안 본다');
  });

  // ⭐ 실측(2026-08-05): `걸린 worktree 37` 인데 등록은 42 였고, 그 차이의 워크트리는 기본 명령에
  //   **존재조차 안 보였다**. 화면이 「본 것」만 말하면 사람이 그것을 「잔재 없음」으로 읽는다.
  it('⛔ 등록이 걸린 것보다 많으면 「안 본 수」와 그것을 보는 길을 같이 준다', () => {
    const out = renderHarnessCleanReport(
      result({ scope: { branchPrefix: 'self-impl/', matchedWorktrees: 37, matchedBranches: 39, registeredWorktrees: 42 } }),
      'abandoned',
    ).join('\n');
    expect(out).toContain('등록 워크트리 42');
    expect(out).toContain('5');                    // 42 - 37 = 안 본 수
    expect(out).toContain('안 봤다');
    expect(out).toContain('--prefix');             // 원인만 주지 않고 길을 준다
  });

  // ⛔⭐⭐ 무인 리뷰(`#7146` 1R)가 잡은 결함의 회귀 방어 — 초판은 두 경고를 `else if` 로 묶어
  //   ***「0개를 보는데 등록은 42」라는 «가장 중요한» 경우에 안 본 수가 침묵했다.***
  it('⛔ 0/0 이면서 등록이 더 많으면 «두 경고를 다» 내고 길은 한 번만 준다', () => {
    const out = renderHarnessCleanReport(
      result({ scope: { branchPrefix: 'dev/', matchedWorktrees: 0, matchedBranches: 0, registeredWorktrees: 42 } }),
      'abandoned',
    );
    const joined = out.join('\n');
    expect(joined).toContain('이 스코프가 아무것도 안 본다');   // 0/0 경고
    // ⛔ 「등록 42」만 단언하면 «안 본 수»가 안 물린다(무인 리뷰 2R should-fix) — 문구째로 못 박는다.
    //   0/0 이므로 안 본 수 = 42 - 0 = 42 다.
    expect(joined).toContain('등록 워크트리 42(primary 포함) 중 42 은');
    expect(out.filter((l) => l.includes('--prefix'))).toHaveLength(1);   // 길은 한 번만(소음 금지)
  });

  // ⛔⭐⭐⭐ `[T]` 리뷰 `M1` — detached 는 «어떤 --prefix 에도 원리상» 안 걸린다
  //   (`listHarnessWorktrees` 는 `branch ` 줄이 있어야 센다). 그것까지 묶어 「--prefix 로 보라」고
  //   말하면 ***갈 수 없는 길***이 된다. ⚠️ 이 창의 트리는 detached 0 이라 «내 자로는 안 보였다».
  it('⛔ detached 는 「어떤 --prefix 로도 못 본다」고 «따로» 말한다', () => {
    const out = renderHarnessCleanReport(
      result({ scope: { branchPrefix: 'self-impl/', matchedWorktrees: 37, matchedBranches: 39, registeredWorktrees: 42, branchlessWorktrees: 3 } }),
      'abandoned',
    ).join('\n');
    expect(out).toContain('등록 워크트리 42(primary 포함) 중 5 은');
    expect(out).toContain('그중 3 은');
    expect(out).toContain('어떤 --prefix 로도');
    expect(out).toContain('harness worktrees');   // detached 에게 주는 «가능한» 길
    expect(out).toContain('--prefix <p>');        // 나머지 2 는 접두로 갈 수 있다
  });

  it('⛔ 안 본 것이 «전부» detached 면 --prefix 길을 «주지 않는다» (불가능한 길 금지)', () => {
    const out = renderHarnessCleanReport(
      result({ scope: { branchPrefix: 'self-impl/', matchedWorktrees: 37, matchedBranches: 39, registeredWorktrees: 40, branchlessWorktrees: 3 } }),
      'abandoned',
    ).join('\n');
    expect(out).toContain('그중 3 은');
    expect(out).toContain('어떤 --prefix 로도');
    expect(out).not.toContain('--prefix <p>');    // 갈 수 없는 길은 안 준다
  });

  // ⭐ `[T]` 리뷰 `S1` — 두 수가 «다른 스냅샷»이면 안 본 수가 음수가 되어 조용히 사라졌다.
  it('⛔ 등록 < 걸린 이면 «못 셌다»고 말한다 (조용히 넘어가지 않는다)', () => {
    const out = renderHarnessCleanReport(
      result({ scope: { branchPrefix: 'self-impl/', matchedWorktrees: 5, matchedBranches: 5, registeredWorktrees: 3 } }),
      'abandoned',
    ).join('\n');
    expect(out).toContain('스코프 수가 어긋난다');
    expect(out).toContain('못 셌다');
    expect(out).not.toContain('안 봤다');         // 없는 수를 지어내지 않는다
    expect(out).not.toContain('--prefix <p>');
  });

  // ⛔⭐⭐ 무인 리뷰 3R — 「불가능한 길 금지」를 한 가지에만 적용해서, `0/0` 가지에는 그대로 살아 있었다.
  it('⛔ 0/0 이면서 등록이 «전부 detached» 면 --prefix 길을 주지 않는다', () => {
    const out = renderHarnessCleanReport(
      result({ scope: { branchPrefix: 'dev/', matchedWorktrees: 0, matchedBranches: 0, registeredWorktrees: 3, branchlessWorktrees: 3 } }),
      'abandoned',
    ).join('\n');
    expect(out).toContain('이 스코프가 아무것도 안 본다');
    expect(out).toContain('어떤 --prefix 로도');
    expect(out).not.toContain('--prefix <p>');
  });

  it('못 쟀으면(등록 미상) 0/0 안내는 «그대로» 준다 — 그때는 그것이 최선이다', () => {
    const out = renderHarnessCleanReport(
      result({ scope: { branchPrefix: 'dev/', matchedWorktrees: 0, matchedBranches: 0 } }),
      'abandoned',
    ).join('\n');
    expect(out).toContain('--prefix <p>');
  });

  // ⛔⭐⭐ 무인 리뷰 5R — bare 도 branch 가 없어 «어떤 --prefix 로도» 못 본다.
  //   「명시적 detached 만」 빼면 bare 만 안 본 경우에 불가능한 길이 다시 나온다.
  it('⛔ 안 본 것이 «전부 bare» 여도 --prefix 길을 주지 않는다', () => {
    const out = renderHarnessCleanReport(
      result({ scope: { branchPrefix: 'self-impl/', matchedWorktrees: 0, matchedBranches: 0, registeredWorktrees: 2, branchlessWorktrees: 2 } }),
      'abandoned',
    ).join('\n');
    expect(out).toContain('어떤 --prefix 로도');
    expect(out).toContain('detached·bare');
    expect(out).not.toContain('--prefix <p>');
  });

  // ⛔⭐ `[T]` 리뷰 `M2`·`S2` — primary 가 «접두에 걸리면» primary 는 matched 쪽이라 unseen 에 «없다».
  //   종전 문면은 `(primary 포함)` 을 안 본 수 뒤에 붙여 「안 본 수 안에 primary 가 있다」로 읽혔고,
  //   그 수를 해석하는 사람이 1을 잘못 뺐다. ⇒ 괄호는 «총수»에만 붙는다.
  it('⛔ (primary 포함) 은 «총수»에 붙는다 — 안 본 수에 붙지 않는다', () => {
    const out = renderHarnessCleanReport(
      result({ scope: { branchPrefix: 'self-impl/', matchedWorktrees: 1, matchedBranches: 1, registeredWorktrees: 3, branchlessWorktrees: 0 } }),
      'abandoned',
    ).join('\n');
    expect(out).toContain('등록 워크트리 3(primary 포함) 중 2 은');
    expect(out).not.toContain('2 은 이 prefix 「밖」이라 이 실행이 안 봤다(primary');   // 안 본 수 쪽엔 안 붙는다
  });

  it('등록과 걸린 수가 같으면 그 줄을 안 낸다 (소음 금지)', () => {
    const out = renderHarnessCleanReport(
      result({ scope: { branchPrefix: 'self-impl/', matchedWorktrees: 3, matchedBranches: 3, registeredWorktrees: 3 } }),
      'abandoned',
    ).join('\n');
    expect(out).not.toContain('안 봤다');
  });

  // ⛔ 「접두 밖 0」과 「못 셌음」을 같은 값으로 두지 않는다 — 못 셌으면 수를 «아예 안 낸다».
  //   실패 자체는 기존 「질의 실패」 줄이 말한다(그래서 여기서 두 번 말하지 않는다).
  it('등록 열거가 실패하면 안 본 수를 «꾸며내지 않는다»', () => {
    const out = renderHarnessCleanReport(
      result({
        scope: { branchPrefix: 'self-impl/', matchedWorktrees: 3, matchedBranches: 3 },
        queryStatus: { worktrees: false, branches: true, pullRequests: true, directories: true, registeredWorktrees: true },
      }),
      'abandoned',
    ).join('\n');
    expect(out).not.toContain('안 봤다');
    expect(out).not.toContain('등록 워크트리');
    expect(out).toContain('질의 실패');            // 못 셌다는 사실은 기존 줄이 말한다
  });

  it('고아를 safety 분류와 함께 보고하고 「지우지 않는다」를 명시한다', () => {
    const out = renderHarnessCleanReport(result({
      orphanedWorktrees: ['/w/a', '/w/b'],
      orphanedWorktreeSafety: [
        { path: '/w/a', safety: 'safe' } as never,
        { path: '/w/b', safety: 'unknown' } as never,
      ],
    }), 'abandoned').join('\n');
    expect(out).toContain('고아 worktree 2');
    expect(out).toContain('safe 1');
    expect(out).toContain('unknown 1');
    expect(out).toContain('/w/a');
    expect(out).toContain('지우지 않는다');
  });

  it('⛔ 질의가 실패했으면 「부분집합」이라고 말한다 (0 을 전수로 읽지 않게)', () => {
    const out = renderHarnessCleanReport(result({
      queryStatus: { worktrees: true, branches: false, pullRequests: true, directories: false, registeredWorktrees: true },
    }), 'abandoned').join('\n');
    expect(out).toContain('질의 실패');
    expect(out).toContain('branches');
    expect(out).toContain('directories');
    expect(out).toContain('부분집합');
  });

  it('질의가 전부 성공이면 그 경고를 안 낸다', () => {
    const out = renderHarnessCleanReport(result(), 'abandoned').join('\n');
    expect(out).not.toContain('질의 실패');
  });

  it('⛔ 터미널 출력에 마크다운 강조를 남기지 않는다 (무인 리뷰 should-fix)', () => {
    const out = renderHarnessCleanReport(result({
      scope: { branchPrefix: 'dev/', matchedWorktrees: 0, matchedBranches: 0 },
      orphanedWorktrees: ['/w/a'],
      orphanedWorktreeSafety: [{ path: '/w/a', safety: 'safe' } as never],
      queryStatus: { worktrees: false, branches: true, pullRequests: true, directories: true, registeredWorktrees: true },
    }), 'abandoned').join('\n');
    expect(out).not.toMatch(/\*\*/);
  });
});

// ⭐⭐⭐ **배선을 잰다** — exec → measurement → planner 가 실제로 이어졌는가
//
// ⛔ 무인 리뷰가 1차 런을 여기서 막았고 **그 지적이 옳았다**: 위 테스트들은 전부 `planHarnessClean` 에
//   Map 을 **손으로 넣어** 판정만 잰다. 그러면 *"측정이 실제로 그 Map 을 채우는가"* 와
//   *"exec 가 그것을 planner 에 넘기는가"* 가 **한 번도 검증되지 않는다.**
//   ⇒ 2026-08-03 `#6733` 에서 같은 형태가 실물로 났다(테스트는 `debug.log` 호출을 단언했는데
//     sink 미등록이라 스토어에 안 닿았다). ***호출을 재는 것과 도착을 재는 것은 다른 축이다.***
// ⭐ 잴 수 있는 길은 이미 있다 — `measureBranchSafety(worktrees, branches, run)` 가 **실행기를 받는다.**
describe('harness clean — shared active-terminal manifest reader', () => {
  const manifestRow = (overrides: Partial<PtyManifestRow> = {}): PtyManifestRow => ({
    id: 'pty', kind: 'shell', cmd: 'bun', ownerPid: process.pid, ptyPid: process.pid, instance: 'test',
    startedAt: 0, alive: true, exitCode: null, snapshot: '', snapshotAt: 0, outputBytesTotal: 0,
    updatedAt: 0, frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '',
    parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    ...overrides,
  });

  it('reads live workdirs from the shared manifest, excluding dead and workdir-less rows', () => {
    const query = listActiveTerminalDirectories(() => [
      manifestRow({ id: 'live', workdir: '/wt/shared-live' }),
      manifestRow({ id: 'dead', alive: false, workdir: '/wt/dead' }),
      manifestRow({ id: 'missing' }),
      manifestRow({ id: 'empty', workdir: '' }),
    ]);
    expect(query).toEqual({ ok: true, value: ['/wt/shared-live'] });
  });

  it('uses the default shared manifest across the process-local registry boundary', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'harness-clean-manifest-'));
    setPtyManifestDbPathForTesting(join(stateRoot, 'pty', 'manifest.db'));
    try {
      const now = Date.now();
      upsertPtyManifest({ id: 'shared-live', kind: 'shell', cmd: 'bun', workdir: '/wt/default-shared', startedAt: now, now, ptyPid: process.pid });
      upsertPtyManifest({ id: 'shared-dead', kind: 'shell', cmd: 'bun', workdir: '/wt/default-dead', startedAt: now, now, ptyPid: process.pid });
      markPtyManifestClosed('shared-dead', 0, now);
      expect(listActiveTerminalDirectories()).toEqual({ ok: true, value: ['/wt/default-shared'] });
    } finally {
      setPtyManifestDbPathForTesting(null);
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('maps a shared-manifest read exception to an unavailable active-directory query', () => {
    expect(listActiveTerminalDirectories(() => { throw new Error('manifest unavailable'); }))
      .toEqual({ ok: false, value: [] });
  });

  it('preserves a shared-manifest live worktree through the existing planner classification', () => {
    const query = listActiveTerminalDirectories(() => [manifestRow({ workdir: '/wt/dev/shared-live/src' })]);
    const plan = planHarnessClean({
      worktrees: [wt('dev/shared-live')], branches: ['dev/shared-live'], openPr: new Set(), mergedPr: new Set(), mode: 'all',
      activeDirectories: query.value,
      queryStatus: { worktrees: true, branches: true, pullRequests: true, activeDirectories: query.ok },
    });
    expect(plan.remove).toEqual([]);
    expect(plan.preserve).toEqual([expect.objectContaining({ branch: 'dev/shared-live', reason: 'currently-in-use' })]);
  });
});

describe('harness clean — active-directory provider wiring', () => {
  it('execHarnessClean passes an injected active-directory result to the planner', () => {
    const branch = 'dev/active-provider';
    const run = (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list' && !args.includes('-z')) return { status: 0, stdout: `worktree /wt/active-provider\nHEAD deadbeef\nbranch refs/heads/${branch}\n`, stderr: '' };
      if (args[0] === 'branch') return { status: 0, stdout: `${branch}\n`, stderr: '' };
      if (args.includes('rev-list')) return { status: 0, stdout: '0\n', stderr: '' };
      if (args.includes('status')) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = execHarnessClean({
      mode: 'all', dryRun: true, branchPrefix: 'dev/', run, runGh: () => ({ status: 0, stdout: '' }),
      activeDirectoryProvider: () => ({ ok: true, value: ['/wt/active-provider/src'] }),
    });
    expect(result.plan.remove).toEqual([]);
    expect(result.plan.preserve).toEqual([expect.objectContaining({ branch, reason: 'currently-in-use' })]);
    expect(result.plan.queryStatus?.activeDirectories).toBe(true);
  });

  it('execHarnessClean does not delete when the injected active-directory lookup is unavailable', () => {
    const branch = 'dev/unavailable-provider';
    const run = (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list' && !args.includes('-z')) return { status: 0, stdout: `worktree /wt/unavailable-provider\nHEAD deadbeef\nbranch refs/heads/${branch}\n`, stderr: '' };
      if (args[0] === 'branch') return { status: 0, stdout: `${branch}\n`, stderr: '' };
      if (args.includes('rev-list')) return { status: 0, stdout: '0\n', stderr: '' };
      if (args.includes('status')) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = execHarnessClean({
      mode: 'all', dryRun: false, branchPrefix: 'dev/', run, runGh: () => ({ status: 0, stdout: '' }),
      activeDirectoryProvider: () => ({ ok: false, value: [] }),
    });
    expect(result.plan.remove).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.plan.queryStatus?.activeDirectories).toBe(false);
  });
});

describe('harness clean — 측정 배선 (exec → measurement → planner)', () => {
  const wt = (branch: string) => ({ path: `/wt/${branch}`, branch });

  it('measureBranchSafety 가 rev-list 와 status --porcelain 을 그 워크트리에서 부른다', () => {
    const seen: string[][] = [];
    const run: GitRunner = (args) => {
      seen.push([...args]);
      if (args.includes('rev-list')) return { status: 0, stdout: '3\n', stderr: '' };
      if (args.includes('--porcelain')) return { status: 0, stdout: ' M a.ts\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = measureBranchSafety([wt('dev/x')], ['dev/x'], run);
    // ⭐ argv 를 정확히 문다 — 다른 트리를 재면 판정이 통째로 틀린다.
    expect(seen).toContainEqual(['-C', '/wt/dev/x', 'rev-list', '--count', 'origin/main..HEAD']);
    expect(seen).toContainEqual(['-C', '/wt/dev/x', 'status', '--porcelain']);
    expect(r.unmergedCommitCounts.get('dev/x')).toBe(3);
    expect(r.uncommittedChanges.get('dev/x')).toBe(true);
  });

  it('⛔ 측정 명령이 실패하면 undefined 다 (0 으로 단정하지 않는다)', () => {
    const run: GitRunner = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' });
    const r = measureBranchSafety([wt('dev/x')], ['dev/x'], run);
    expect(r.unmergedCommitCounts.get('dev/x')).toBeUndefined();
    expect(r.uncommittedChanges.get('dev/x')).toBeUndefined();
  });

  it('⭐ 워크트리가 없어도 브랜치 ref 로 잰다 (「없다」를 「못 잰다」로 만들지 않는다)', () => {
    // ⛔ 초판은 둘 다 undefined 로 고정해 **워크트리 없는 브랜치를 영영 못 지우게** 만들었다
    //   (무인 리뷰 must-fix · 실측 unknown 35건이 그 형태였다).
    const seen: string[][] = [];
    const run: GitRunner = (args) => {
      seen.push([...args]);
      return { status: 0, stdout: 'dev/orphan 2 0\n', stderr: '' };
    };
    const r = measureBranchSafety([], ['dev/orphan'], run);
    expect(seen).toContainEqual(['for-each-ref', '--format=%(refname:short) %(ahead-behind:origin/main)', 'refs/heads']);
    expect(r.unmergedCommitCounts.get('dev/orphan')).toBe(2);
    // ⭐ 워크트리가 없으면 작업 트리도 없으므로 미커밋 변경은 **없다**(false) — 「모른다」가 아니다.
    expect(r.uncommittedChanges.get('dev/orphan')).toBe(false);
  });

  it('⭐ 워크트리 없는 브랜치도 미머지 0 이면 정리 대상이 된다 (영구 비활성화 회귀 방어)', () => {
    const run: GitRunner = () => ({ status: 0, stdout: 'dev/stale 0 0\n', stderr: '' });
    const measured = measureBranchSafety([], ['dev/stale'], run);
    const plan = planHarnessClean({ activeDirectories: [],
      worktrees: [], branches: ['dev/stale'],
      worktreeDirectories: [], registeredWorktreePaths: [],
      orphanBranchQueryOk: true, orphanBranches: new Set<string>(),
      openPr: new Set<string>(), mergedPr: new Set<string>(),
      mode: 'abandoned',
      unmergedCommitCounts: measured.unmergedCommitCounts,
      uncommittedChanges: measured.uncommittedChanges,
    } as never);
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toContain('assessment=unjudgeable:worktree-unavailable');
  });

  it('워크트리 없는 병합 브랜치는 reclaim-safe:merged-no-worktree 이고 «제거 후보에 오른다» (워크트리가 없어도 브랜치는 남는다)', () => {
    const run: GitRunner = (args) => {
      if (args[0] === 'for-each-ref') return { status: 0, stdout: 'dev/merged-gone 0 0\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const measured = measureBranchSafety([], ['dev/merged-gone'], run);
    const plan = planHarnessCleanImpl({
      activeDirectories: [],
      worktrees: [],
      branches: ['dev/merged-gone'],
      openPr: new Set(),
      mergedPr: new Set(['dev/merged-gone']),
      mode: 'all',
      ...measured,
    });
    // 🩹 2026-09-08: 판정을 «회수»에 이었다 — 옛 계약(#13626)의 "do not change plan.remove" 는
    //   그 골이 스스로 적은 범위 경계였고 안전 판단이 아니었다.
    expect(plan.preserve).toEqual([]);
    expect(plan.remove[0]?.reason).toBe('merged; assessment=reclaim-safe:merged-no-worktree; ownership=not-recorded; branch-only');
  });

  it('워크트리 없고 병합되지 않은 브랜치는 기존 unjudgeable:worktree-unavailable 이다', () => {
    const run: GitRunner = (args) => {
      if (args.includes('--merged')) return { status: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'for-each-ref') return { status: 0, stdout: 'dev/live 4 0\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const measured = measureBranchSafety([], ['dev/live'], run);
    const plan = planHarnessCleanImpl({
      activeDirectories: [],
      worktrees: [],
      branches: ['dev/live'],
      openPr: new Set(),
      mergedPr: new Set(),
      mode: 'all',
      ...measured,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toBe('assessment=unjudgeable:worktree-unavailable; ownership=not-recorded');
  });

  it('워크트리가 있는 브랜치의 판정은 병합 조회와 무관하게 그대로다', () => {
    const run: GitRunner = (args) => {
      if (args.includes('--merged')) return { status: 0, stdout: 'dev/x\n', stderr: '' };
      if (args.includes('rev-list')) return { status: 0, stdout: '2\n', stderr: '' };
      if (args.includes('--porcelain') && args.includes('status')) return { status: 0, stdout: ' M src/a.ts\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const measured = measureBranchSafety([wt('dev/x')], ['dev/x'], run);
    const plan = planHarnessClean({
      activeDirectories: [],
      worktrees: [wt('dev/x')],
      branches: ['dev/x'],
      worktreeDirectories: [],
      registeredWorktreePaths: [],
      orphanBranchQueryOk: true,
      orphanBranches: new Set<string>(),
      openPr: new Set<string>(),
      mergedPr: new Set<string>(),
      mode: 'abandoned',
      unmergedCommitCounts: measured.unmergedCommitCounts,
      uncommittedChanges: measured.uncommittedChanges,
    } as never);
    expect(plan.remove).toEqual([]);
    expect(plan.preserve[0]?.reason).toContain('assessment=do-not-touch:dirty-worktree');
    expect(plan.preserve[0]?.reason).not.toContain('merged-no-worktree');
  });

  it('⭐ 그 측정값이 planner 판정으로 이어진다 (배선 왕복)', () => {
    const run: GitRunner = (args) => {
      if (args.includes('rev-list')) return { status: 0, stdout: '2\n', stderr: '' };
      if (args.includes('--porcelain')) return { status: 0, stdout: '', stderr: '' };
      if (args.includes('origin/main...HEAD')) return { status: 0, stdout: 'src/a.ts\0', stderr: '' };
      if (args.includes('origin/main') && args.includes('HEAD')) return { status: 0, stdout: 'src/a.ts\0', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const measured = measureBranchSafety([wt('dev/x')], ['dev/x'], run);
    const plan = planHarnessClean({ activeDirectories: [],
      worktrees: [wt('dev/x')], branches: ['dev/x'],
      worktreeDirectories: [], registeredWorktreePaths: [],
      orphanBranchQueryOk: true, orphanBranches: new Set<string>(),
      openPr: new Set<string>(), mergedPr: new Set<string>(),
      mode: 'abandoned',
      unmergedCommitCounts: measured.unmergedCommitCounts,
      uncommittedChanges: measured.uncommittedChanges,
    } as never);
    // ⛔ 손으로 넣은 Map 이 아니라 **측정이 낸 Map** 으로 판정한 결과다.
    expect(plan.remove).toHaveLength(0);
    expect(plan.preserve.some((p) => p.reason.includes('assessment=needs-human:no-pr-content-differs'))).toBe(true);
  });

  it('⭐⭐⭐ execHarnessClean → measurement → planner 가 **결정적으로** 이어진다 (환경 무관)', () => {
    // ⛔ 초판은 실제 리포에 self-impl/ 브랜치가 있어야만 유효했다 — CI·detached checkout 에서는
    //   스코프 0이 되어 아무것도 못 잰다(무인 리뷰 must-fix). ⇒ **조회까지 같은 실행기로 몰아**
    //   환경과 무관하게 결정적으로 만든다.
    const run: GitRunner = (args) => {
      const a = args.join(' ');
      if (a.includes('worktree list')) {
        return { status: 0, stdout: 'worktree /wt/a\nbranch refs/heads/self-impl/a\n', stderr: '' };
      }
      if (a.includes('branch --list')) return { status: 0, stdout: 'self-impl/a\n', stderr: '' };
      if (a.includes('rev-list')) return { status: 0, stdout: '7\n', stderr: '' };
      if (a.includes('--porcelain')) return { status: 0, stdout: '', stderr: '' };
      if (a.includes('origin/main...HEAD')) return { status: 0, stdout: 'src/a.ts\0', stderr: '' };
      if (a.includes('origin/main HEAD --')) return { status: 0, stdout: 'src/a.ts\0', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    // ⭐ `gh` 도 주입한다 — 안 하면 실제 조회 실패 시 `query-failed` 가 먼저 걸려
    //   새 보존 이유를 한 번도 안 재고 통과한다(무인 리뷰 must-fix).
    const runGh = () => ({ status: 0, stdout: JSON.stringify({ data: { repository: { b0: { nodes: [] } } } }) });
    const res = execHarnessClean({ mode: 'abandoned', dryRun: true, branchPrefix: 'self-impl/', run, runGh, readWorktreeProvenance: () => ({ owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' }) });
    // ⭐ 우리가 준 7 이 planner 를 통과해 이 이유로 나왔다면 배선이 살아 있다.
    // ⛔ 조회 주입이 **둘 다** 걸렸는지 문다 — worktree 쪽을 안 물면 실제 저장소가 답해도 통과한다
    //   (초판 반증이 안 물었던 이유다).
    expect(res.plan.scope?.matchedBranches).toBe(1);
    expect(res.plan.scope?.matchedWorktrees).toBe(1);
    expect(res.plan.preserve).toEqual([expect.objectContaining({ branch: 'self-impl/a', reason: expect.stringContaining('assessment=needs-human:no-pr-content-differs') })]);
    expect(res.plan.remove).toHaveLength(0);
  }, 120_000);
});


// ⛔⭐⭐⭐ **안전** — **쓰기 경로는 전부 주입을 탄다** (무인 리뷰 must-fix)
//
// 조회·측정만 주입받고 **삭제는 기본 실행기**로 두면, 가짜를 주입한 호출이 `dryRun:false` 일 때
// ***가짜 계획으로 진짜 저장소를 지운다.*** 이 테스트가 그 구멍을 막는다.
// ⚠️ 범위를 정확히 적는다: 비파괴 조회 하나(`listAllHarnessBranches`)는 **아직 기본 실행기**를 쓴다.
//   지우지 않으므로 안전 문제가 아니고 배선 결정성에도 영향이 없다(고아 **브랜치** 판정에만 쓰인다).
//   ⛔ 설명이 코드보다 넓으면 그것도 거짓 계약이다 — 오늘 `drive --help` 가 같은 형태였다.
describe('harness clean — 주입한 실행기가 삭제까지 간다', () => {
  it('⛔ dryRun:false 에서도 삭제 명령이 주입된 실행기로 간다 (실제 git 이 아니다)', () => {
    const seen: string[][] = [];
    const run: GitRunner = (args) => {
      seen.push([...args]);
      const a = args.join(' ');
      if (a.includes('worktree list')) {
        return { status: 0, stdout: 'worktree /wt/a\nbranch refs/heads/self-impl/a\n', stderr: '' };
      }
      if (a.includes('branch --list')) return { status: 0, stdout: 'self-impl/a\n', stderr: '' };
      if (a.includes('rev-list')) return { status: 0, stdout: '0\n', stderr: '' };   // 미머지 0 ⇒ 정리 대상
      if (a.includes('--porcelain')) return { status: 0, stdout: '', stderr: '' };
      if (a.includes('origin/main...HEAD')) return { status: 0, stdout: 'src/a.ts\0', stderr: '' };
      if (a.includes('origin/main HEAD --')) return { status: 0, stdout: '', stderr: '' }; // 내용은 main 에 이미 착지
      return { status: 0, stdout: '', stderr: '' };
    };
    const res = execHarnessClean({
      mode: 'abandoned', dryRun: false, branchPrefix: 'self-impl/',
      run, runGh: () => ({ status: 0, stdout: JSON.stringify({ data: { repository: { b0: { nodes: [] } } } }) }),
      readWorktreeProvenance: () => ({ owner: 'dev:run', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' }),
    });
    // ⭐ 삭제가 실제로 일어났고, 그 명령이 **우리 실행기**를 통과했다.
    expect(res.plan.preserve).toEqual([]);
    expect(res.removed.length).toBeGreaterThan(0);
    // ⭐ **두 삭제 명령의 정확한 argv** 를 각각 문다(무인 리뷰 must-fix) —
    //   부분 문자열 하나만 보면 `worktree remove` 쪽 배선이 빠져도 통과한다.
    expect(seen).toContainEqual(['worktree', 'remove', '--force', '/wt/a']);
    expect(seen).toContainEqual(['branch', '-D', 'self-impl/a']);
  }, 60_000);
});

// ⛔⭐⭐ 무인 리뷰 3R·4R — 스코프 «스냅샷 경로»가 테스트되지 않았다.
//   렌더 테스트는 필드를 «주입»할 뿐이라, 실제로 세는 자리와 실패 시 생략을 못 문다.
//   ⭐ 파서를 «순수»로 갈라 놓아서 러너 주입 없이 bare·detached·접두 매칭을 직접 문다.
describe('parseWorktreeSnapshot — 한 산출에서 걸린 것·총수·detached 를 뽑는다', () => {
  it('branch 줄이 없는 것은 «전부» branchless 다 (bare 도 포함)', () => {
    const out = parseWorktreeSnapshot([
      'worktree /repo', 'HEAD abc', 'bare', '',
      'worktree /repo.worktrees/a', 'HEAD def', 'branch refs/heads/self-impl/a', '',
      'worktree /repo.worktrees/d', 'HEAD 999', 'detached', '',
    ].join('\n'), 'self-impl/');
    expect(out.registered).toBe(3);
    expect(out.branchless).toBe(2);            // ⭐ bare 도 branch 가 없어 «도달 불가»다
    expect(out.entries.map((e) => e.branch)).toEqual(['self-impl/a']);
  });

  it('접두에 안 걸리는 브랜치는 entries 에서 빠지되 총수에는 남는다', () => {
    const out = parseWorktreeSnapshot([
      'worktree /repo', 'branch refs/heads/main', '',
      'worktree /repo.worktrees/x', 'branch refs/heads/other/x', '',
    ].join('\n'), 'self-impl/');
    expect(out.registered).toBe(2);
    expect(out.entries).toEqual([]);
    expect(out.branchless).toBe(0);
  });
});

describe('readWorktreeSnapshot — git 실패는 0 이 아니다', () => {
  it('git 이 실패하면 ok:false 이고 수를 지어내지 않는다', () => {
    const out = readWorktreeSnapshot('self-impl/', () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' }));
    expect(out.ok).toBe(false);
    expect(out.value).toEqual({ entries: [], registered: 0, branchless: 0, prunable: 0 });
  });
});

// ⛔⭐⭐⭐ 4R must-fix — 「실패하면 스코프 수를 안 싣는다」는 «배선»을 실제 경로에서 문다.
describe('execHarnessClean — 스냅샷 실패 시 스코프 수를 «안 싣는다»', () => {
  it('worktree 조회가 실패하면 registeredWorktrees 가 없고 화면이 「질의 실패」를 말한다', () => {
    const res = execHarnessClean({
      mode: 'abandoned',
      dryRun: true,
      run: (args: string[]) => (args[0] === 'worktree' && args[1] === 'list'
        ? { status: 128, stdout: '', stderr: 'boom' }
        : { status: 0, stdout: '', stderr: '' }),
      runGh: () => ({ status: 0, stdout: '' }),
    });
    expect(res.plan.scope?.registeredWorktrees).toBeUndefined();
    expect(res.plan.scope?.branchlessWorktrees).toBeUndefined();
    expect(res.plan.queryStatus?.worktrees).toBe(false);
    const out = renderHarnessCleanReport(res, 'abandoned').join('\n');
    expect(out).toContain('질의 실패');
    expect(out).not.toContain('등록 워크트리');      // 없는 수를 지어내지 않는다
  });
});
