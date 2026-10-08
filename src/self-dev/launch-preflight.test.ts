import { setDefaultTimeout, describe, expect, it, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { LogStore } from '../mss/logging/log-store.js';
import { debug } from '../debug/log.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_RECENT_CHANGE_WINDOW_DAYS,
  combineWorktreePathTouchAxes,
  decideAskPreflight as decideAskPreflightWithDefault,
  evaluateLaunchPreflight,
  interruptedRunObservationFailureCount,
  listPreexistingFailureTestFiles,
  parsePreexistingFailureTestFiles,
  MAX_LIVE_RUN_WINDOW_MINUTES,
  MAX_RECENT_CHANGE_WINDOW_DAYS,
  renderLaunchPreflight,
  renderRepeatedInterruptionReasonNotice,
  renderRunningRunsConfidenceAppendix,
  normalizePreexistingFailureObservedAt,
  observeWorktreePathTouches,
  preexistingFailureRecordsFromGateObservations,
  measurePairedTestFile,
  siblingTestPath,
  resolveRecentChangeWindowDays,
} from './launch-preflight.js';
import { queryFederatedCompletedRunLedgers, queryFederatedInterruptedRunLedgers, runLedgerDir } from '../self-implement/run-ledger.js';
import type { RunningRunsResult } from '../self-implement/running-runs.js';
import type { LaunchPreflightResult } from './launch-preflight.js';

const WINDOW = 30 * 60_000; // 30분

const confidenceRunningRuns = (
  confirmed: number,
  probable: number,
  indeterminate: {
    unknown?: number;
    ptyUnreadable?: readonly string[];
    unreadableLedgerCount?: number;
    unreadableLedgerDirectoryCount?: number;
    missingLedgerDirectoryCount?: number;
    unreadableLedgerDirectoryAccessCount?: number;
    indeterminateLedgerDirectoryCount?: number;
    notCountedRefCount?: number;
    entries?: RunningRunsResult['entries'];
  } = {},
): RunningRunsResult => ({
  entries: indeterminate.entries ?? [],
  counts: { running: confirmed, 'probable-running': probable, 'ended-unclosed': 0, unknown: indeterminate.unknown ?? 0 },
  total: confirmed + probable + (indeterminate.unknown ?? 0),
  countedStatuses: ['running', 'probable-running'],
  quantities: {
    counts: { value: { running: confirmed, 'probable-running': probable, 'ended-unclosed': 0, unknown: 0 }, population: 'all assessed runs', observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: true } },
    total: { value: confirmed + probable, population: 'all assessed runs', observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: true } },
    entries: { value: 0, population: 'all assessed runs', observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: true } },
    running: { value: confirmed + probable, population: 'assessed runs whose status is in countedStatuses', observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: true } },
  },
  observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: true },
  ledger: {
    ledgerDirectories: [],
    unreadableLedgerCount: indeterminate.unreadableLedgerCount ?? 0,
    unreadableLedgerDirectoryCount: indeterminate.unreadableLedgerDirectoryCount ?? 0,
    missingLedgerDirectoryCount: indeterminate.missingLedgerDirectoryCount ?? 0,
    unreadableLedgerDirectoryAccessCount: indeterminate.unreadableLedgerDirectoryAccessCount ?? 0,
    indeterminateLedgerDirectoryCount: indeterminate.indeterminateLedgerDirectoryCount ?? 0,
  },
  pty: {
    unreadable: [...(indeterminate.ptyUnreadable ?? [])],
    // ⛔ 이 셋은 «0 이 아니라 「안 셌음」»이 아니다 — 이 픽스처는 PTY 를 «하나도» 안 세운 판이라
    //   관측 0 · runId 없는 것 0 · 안 세어진 것 0 이 «측정된 값»이다(#13204 가 셋을 값으로 드러냈다).
    observedRefCount: 0,
    withoutRunIdCount: 0,
    notCountedRefCount: indeterminate.notCountedRefCount ?? 0,
  },
});

const notCountedPtyEntry = (runId: string, ptyUpdatedAt: number | null): RunningRunsResult['entries'][number] => ({
  runId,
  status: 'unknown',
  presence: 'pty-without-ledger-observed',
  reason: 'pty-without-unfinished-ledger',
  lifecycle: null,
  lastActivityTimestamp: null,
  ptyUpdatedAt,
  ledgerDirectories: [],
  ptyRefs: [{ instance: 'test', id: runId, kind: 'pty' }],
});

const noRunningRuns = (): RunningRunsResult => confidenceRunningRuns(0, 0);

const decideAskPreflight = (
  options: Parameters<typeof decideAskPreflightWithDefault>[0],
  deps: Parameters<typeof decideAskPreflightWithDefault>[1],
  force: Parameters<typeof decideAskPreflightWithDefault>[2],
) => decideAskPreflightWithDefault(options, {
  ...deps,
  queryRunningRuns: deps.queryRunningRuns ?? noRunningRuns,
}, force);

describe('evaluateLaunchPreflight — 발사 전 전제 검사', () => {
  test('[open-pr-warns] 같은 파일을 여는 열린 PR 은 이름·경로·제목을 보존해 경고한다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [{ number: 8100, title: '런 원장 계측', files: [{ path: 'src/index.ts' }, { path: 'other.ts' }], isDraft: false }],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ kind: 'open-pr', name: '#8100' });
    expect(result.warnings[0]!.detail).toContain('src/index.ts');
    expect(result.warnings[0]!.detail).toContain('런 원장 계측');
    expect(renderLaunchPreflight(result)).toContain('#8100 — 열린 PR 이 같은 파일을 연다: src/index.ts — 런 원장 계측');
  });

  test('[unrelated-pr-passes] 다른 파일만 여는 PR 은 안 막는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [{ number: 1, title: 'docs', files: [{ path: 'docs/a.md' }] }],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toHaveLength(0);
    expect(result.openPrs).toEqual({ state: 'checked', count: 1 });
  });

  test('[sibling-pr-warns] 같은 계보의 열린 PR 은 모든 번호·브랜치와 즉시 실행 명령을 한 경고에 담아 막지 않는다', () => {
    const command = 'bun bin/elanous.mjs gh pr view 9001';
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      plannedBranch: 'self-impl/x-1111aaaa',
      openPrs: [{
        number: 9001,
        title: '같은 골 다른 시도',
        files: [{ path: 'docs/a.md' }],
        headRefName: 'self-impl/x-2222bbbb',
      }, {
        number: 9005,
        title: '같은 골 또 다른 시도',
        files: [{ path: 'docs/b.md' }],
        headRefName: 'self-impl/x-3333cccc',
      }],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    const siblingWarning = result.warnings.find((warning) => warning.kind === 'sibling-pr');
    expect(result.blockers).toEqual([]);
    expect(result.warnings.filter((warning) => warning.kind === 'sibling-pr')).toHaveLength(1);
    expect(siblingWarning).toMatchObject({ kind: 'sibling-pr', name: '#9001 #9005' });
    expect(siblingWarning!.detail).toContain('#9001 self-impl/x-2222bbbb');
    expect(siblingWarning!.detail).toContain('#9005 self-impl/x-3333cccc');
    expect(siblingWarning!.detail).toContain('같은 골의 다른 시도가 이미 열려 있다');
    expect(siblingWarning!.detail).toContain(command);
    expect(renderLaunchPreflight(result)).toContain(command);
  });

  test('[sibling-pr-other-lineage] 다른 계보 브랜치는 형제 경고를 내지 않는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      plannedBranch: 'self-impl/x-1111aaaa',
      openPrs: [{
        number: 9002,
        title: '다른 골',
        files: [{ path: 'docs/a.md' }],
        headRefName: 'self-impl/y-3333cccc',
      }],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    expect(result.warnings.filter((warning) => warning.kind === 'sibling-pr')).toHaveLength(0);
    expect(renderLaunchPreflight(result)).not.toContain('bun bin/elanous.mjs gh');
    expect(result.blockers).toEqual([]);
  });

  test('[sibling-pr-without-planned-branch] plannedBranch 가 없으면 형제 경고를 내지 않고 기존 경고는 그대로다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [{
        number: 8100,
        title: '런 원장 계측',
        files: [{ path: 'src/index.ts' }],
        isDraft: false,
        headRefName: 'self-impl/x-2222bbbb',
      }],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings.filter((warning) => warning.kind === 'sibling-pr')).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ kind: 'open-pr', name: '#8100' });
  });

  test('[sibling-pr-and-open-pr-coexist] 형제이면서 같은 파일도 열면 두 경고를 같이 낸다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      plannedBranch: 'self-impl/x-1111aaaa',
      openPrs: [{
        number: 9003,
        title: '같은 파일 형제',
        files: [{ path: 'src/index.ts' }],
        isDraft: false,
        headRefName: 'self-impl/x-2222bbbb',
      }],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((warning) => warning.kind).sort()).toEqual(['open-pr', 'sibling-pr']);
    expect(result.warnings.find((warning) => warning.kind === 'open-pr')).toMatchObject({ name: '#9003' });
    expect(result.warnings.find((warning) => warning.kind === 'sibling-pr')?.detail).toContain('#9003');
  });

  test('[sibling-pr-without-head-ref] 옛 호출자가 headRefName 을 안 주면 예외 없이 형제 경고가 없다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      plannedBranch: 'self-impl/x-1111aaaa',
      openPrs: [{ number: 9004, title: '옛 형태', files: [{ path: 'docs/a.md' }] }],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    expect(result.warnings.filter((warning) => warning.kind === 'sibling-pr')).toHaveLength(0);
    expect(result.blockers).toEqual([]);
  });

  test('[ask-outside-path-warns-by-band-without-blocking] ask 밖 경로는 0개면 멈춤 권고 없이, 1개 이상·많음이면 구간·목록·발견 여섯째를 경고에 남긴다', () => {
    const base = { openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW };
    const zero = evaluateLaunchPreflight({ ...base, paths: ['src/ask.ts'], askTargetPaths: ['src/ask.ts'] });
    const oneOrMore = evaluateLaunchPreflight({ ...base, paths: ['src/ask.ts', 'src/outside.ts'], askTargetPaths: ['src/ask.ts'] });
    const many = evaluateLaunchPreflight({
      ...base,
      paths: ['src/ask.ts', 'src/outside-1.ts', 'src/outside-2.ts', 'src/outside-3.ts', 'src/outside-4.ts', 'src/outside-5.ts', 'src/outside-6.ts'],
      askTargetPaths: ['src/ask.ts'],
    });

    expect(zero.warnings.filter((warning) => warning.kind === 'ask-outside-path')).toHaveLength(0);
    expect(zero.blockers).toEqual([]);
    expect(renderLaunchPreflight(zero)).not.toContain('멈춰 볼지 판단');
    for (const [result, count, band] of [[oneOrMore, 1, '1개 이상'], [many, 6, '많음']] as const) {
      const warning = result.warnings.find((candidate) => candidate.kind === 'ask-outside-path');
      expect(result.blockers).toEqual([]);
      expect(warning).toMatchObject({ name: `ask 에 없던 경로 ${count}개` });
      expect(warning!.detail).toContain('대상에 들어왔다');
      expect(warning!.detail).not.toContain(`ask 에 없던 경로 ${count}개`);
      expect(warning!.detail).toContain(`현재 구간 ${band}`);
      expect(warning!.detail).toContain('docs/manual/MANUAL-goal-authoring-method-2026-08-03.md §7 「발견 여섯째」');
      expect(renderLaunchPreflight(result)).toContain(`[preflight] ⚠️ ${warning!.name} — ${warning!.detail}`);
    }
  });

  test('[declared-path-missing-count-renders-without-blocking] 선언 경로가 없으면 누락 수를 산출하지만 발사를 막지 않는다', () => {
    const missingPath = 'src/docs/stale-cli.ts';
    const result = evaluateLaunchPreflight({
      paths: [missingPath],
      openPrs: [],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    const text = renderLaunchPreflight(result);
    expect(result.missingDeclaredPathCount).toBe(1);
    expect(result.blockers).toEqual([]);
    expect(text).toContain(`[preflight] 요청문이 선언한 대상 경로 1개 · 실재하지 않음 1개: ${missingPath}`);
    expect(text).toContain('막는 것 없음');
  });

  test('[declared-path-existing-count-renders-zero-and-launches] 선언 경로가 모두 있으면 누락 수 0개를 산출하고 발사를 보존한다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/self-dev/launch-preflight.ts', 'src/self-dev/launch-preflight.test.ts'],
      openPrs: [],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    const text = renderLaunchPreflight(result);
    expect(result.missingDeclaredPathCount).toBe(0);
    expect(result.blockers).toEqual([]);
    expect(text).toContain('[preflight] 요청문이 선언한 대상 경로 2개 · 실재하지 않음 0개: src/self-dev/launch-preflight.ts, src/self-dev/launch-preflight.test.ts');
    expect(text).toContain('막는 것 없음');
  });

  test('[declared-path-root-resolves-relative-without-changing-cwd-or-absolute-paths] 대상 뿌리는 상대 선언 경로에만 적용하고 생략하면 cwd 기준을 보존한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-declared-path-root-'));
    const relativePath = 'external/only.ts';
    const absolutePath = join(root, 'absolute-only.ts');
    try {
      mkdirSync(join(root, 'external'));
      writeFileSync(join(root, relativePath), 'export {};');
      writeFileSync(absolutePath, 'export {};');
      const shared = { openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW };

      expect(evaluateLaunchPreflight({ paths: [relativePath], declaredPathsRoot: root, ...shared }).missingDeclaredPathCount).toBe(0);
      expect(evaluateLaunchPreflight({ paths: [relativePath], ...shared }).missingDeclaredPathCount).toBe(1);
      expect(evaluateLaunchPreflight({ paths: [absolutePath], declaredPathsRoot: join(root, 'unrelated-root'), ...shared }).missingDeclaredPathCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('[declared-path-root-renders-only-when-missing] 실재하지 않는 상대 경로가 있으면 렌더가 기준 트리를 문면에 넣고 발사는 막지 않는다', () => {
    const missingPath = 'src/docs/stale-cli.ts';
    const declaredPathsRoot = '/launching/tree';
    const result = evaluateLaunchPreflight({
      paths: [missingPath],
      declaredPathsRoot,
      openPrs: [],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    const text = renderLaunchPreflight(result);
    expect(result.declaredPathsRoot).toBe(declaredPathsRoot);
    expect(result.missingDeclaredPathCount).toBe(1);
    expect(result.blockers).toEqual([]);
    expect(text).toContain(`[preflight] 요청문이 선언한 대상 경로 1개 · 실재하지 않음 1개: ${missingPath} (기준 ${declaredPathsRoot})`);
    expect(text).toContain('막는 것 없음');
  });

  test('[declared-path-root-omitted-from-zero-missing-text] 실재하지 않는 경로가 없으면 기준 트리를 문면에 넣지 않고 기존 문면을 글자 그대로 보존한다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      declaredPathsRoot: process.cwd(),
      openPrs: [],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    const text = renderLaunchPreflight(result);
    expect(result.declaredPathsRoot).toBe(process.cwd());
    expect(result.missingDeclaredPathCount).toBe(0);
    expect(result.blockers).toEqual([]);
    const declaredLine = text.split('\n').find((line) => line.includes('실재하지 않음'));
    expect(declaredLine).toBe('[preflight] 요청문이 선언한 대상 경로 1개 · 실재하지 않음 0개: src/index.ts');
  });

  test('[live-run-warns] 임계 «안»의 런만 경고하며 오래된 런은 남기지 않는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'],
      openPrs: [],
      unfinishedRuns: [
        { runId: 'run-live', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 120_000 },
        { runId: 'run-dead', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 5 * 24 * 3600_000 },
      ],
      liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((warning) => warning.name)).toEqual(['run-live']);
    expect(result.warnings[0]!.detail).toContain('120초 전');
  });

  test('[live-run-ledger-location] 원장 위치가 있는 경고 런도 발사를 허용하며 자기 위치를 문면에 붙인다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'],
      openPrs: [],
      unfinishedRuns: [{
        runId: 'run-isolated',
        plannedPaths: ['src/a.ts'],
        lastActivityAgeMs: 1_000,
        ledgerDirectory: '/other-checkout/.elanous-test/self-implement/runs',
      }],
      liveRunWindowMs: WINDOW,
    });
    const text = renderLaunchPreflight(result);
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((warning) => warning.name)).toEqual(['run-isolated']);
    expect(text).toContain('run-isolated — 도는 런이 같은 파일을 만진다');
    expect(text).toContain('원장 위치 /other-checkout/.elanous-test/self-implement/runs');
  });

  test('[live-run-ledger-location-missing] 원장 위치가 없으면 부재만 말하고 경로를 지어내지 않는다', () => {
    const text = renderLaunchPreflight(evaluateLaunchPreflight({
      paths: ['src/a.ts'],
      openPrs: [],
      unfinishedRuns: [{ runId: 'run-no-ledger-location', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 1_000 }],
      liveRunWindowMs: WINDOW,
    }));
    expect(text).toContain('원장 위치 (없음)');
    expect(text).not.toContain('/other-checkout/.elanous-test/self-implement/runs');
  });

  test('[live-run-ledger-location-per-line] 둘의 경고 런은 각자 원장 위치가 자기 줄에 붙는다', () => {
    const text = renderLaunchPreflight(evaluateLaunchPreflight({
      paths: ['src/a.ts', 'src/b.ts'],
      openPrs: [],
      unfinishedRuns: [
        { runId: 'run-a', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 1_000, ledgerDirectory: '/tree-a/.elanous/run-ledger' },
        { runId: 'run-b', plannedPaths: ['src/b.ts'], lastActivityAgeMs: 1_000, ledgerDirectory: '/tree-b/.elanous-test/run-ledger' },
      ],
      liveRunWindowMs: WINDOW,
    }));
    const warningLines = text.split('\n').filter((line) => line.startsWith('[preflight] ⚠️'));
    expect(warningLines).toEqual([
      expect.stringContaining('gate preexisting 실패 기록: 못 읽음 — gate preexisting 실패 기록 조회기가 배선되지 않았다'),
      expect.stringContaining('run-a — 도는 런이 같은 파일을 만진다: src/a.ts — 마지막 활동 1초 전 · 원장 위치 /tree-a/.elanous/run-ledger'),
      expect.stringContaining('run-b — 도는 런이 같은 파일을 만진다: src/b.ts — 마지막 활동 1초 전 · 원장 위치 /tree-b/.elanous-test/run-ledger'),
    ]);
  });

  test('[unknown-paths-do-not-block] 예정 경로를 «못 읽은» 런은 위반으로 세지 않는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'],
      openPrs: [],
      unfinishedRuns: [{ runId: 'run-x', plannedPaths: 'goal-document-not-found', lastActivityAgeMs: 1000 }],
      liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toHaveLength(0);
  });

  test('[unknown-age-does-not-block] 나이를 모르면 「살아 있음」으로 치지 않는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'],
      openPrs: [],
      unfinishedRuns: [{ runId: 'run-y', plannedPaths: ['src/a.ts'], lastActivityAgeMs: null }],
      liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toHaveLength(0);
  });

  test('[query-failure-is-unknown-not-zero] 조회 실패는 «미지»이고 0 이 아니다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'],
      openPrs: null,
      unfinishedRuns: null,
      liveRunWindowMs: WINDOW,
      openPrsUnknownReason: 'gh rc=1',
      unfinishedRunsUnknownReason: '원장 읽기 실패',
    });
    expect(result.openPrs).toEqual({ state: 'unknown', reason: 'gh rc=1' });
    expect(result.liveRuns).toEqual({ state: 'unknown', reason: '원장 읽기 실패' });
    expect(result.blockers).toHaveLength(0); // ⛔ 미지를 위반으로 만들지 않는다
    const text = renderLaunchPreflight(result);
    expect(text).toContain('미지');
    expect(text).toContain('「없음」이 아니다');
  });

  test('[render-always-shows-what-was-seen] 막지 않을 때도 «무엇을 봤는지»를 낸다', () => {
    const text = renderLaunchPreflight(evaluateLaunchPreflight({
      paths: ['src/a.ts'],
      openPrs: [],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    }));
    expect(text).toContain('열린 PR: 0건 조회');
    expect(text).toContain('미완 런: 0건 조회');
    expect(text).toContain('임계 30분');   // ⛔ 임계가 숨지 않는다
    expect(text).toContain('막는 것 없음');
  });

  test('[force-hint] 막을 때는 우회 방법을 같이 말한다', () => {
    const text = renderLaunchPreflight(evaluateLaunchPreflight({
      paths: [],
      openPrs: [],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    }));
    expect(text).toContain('--force-preflight');
    expect(text).toContain('관측에 남는다');
  });

  test('[force-hint-names-receiving-command] 우회가 꺼져 있으면 --force-preflight 와 받는 명령 이름이 같은 문장에 나온다', () => {
    const text = renderLaunchPreflight(evaluateLaunchPreflight({
      paths: [],
      openPrs: [],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    }));
    const hint = text.split('\n').find((line) => line.includes('--force-preflight'));
    expect(hint).toBe('[preflight] 그래도 가려면 --force-preflight (그 우회는 관측에 남는다) — elanous dev');
    expect(hint).toContain('elanous dev');
    expect(hint).toContain('--force-preflight');
  });

  test('[force-hint-forced-branch-unchanged] 우회가 이미 켜진 안내 문장은 종전 그대로다', () => {
    const text = renderLaunchPreflight(evaluateLaunchPreflight({
      paths: [],
      openPrs: [],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    }), true);
    const hint = text.split('\n').find((line) => line.includes('--force-preflight'));
    expect(hint).toBe('[preflight] ⚠️ --force-preflight — 위 막힘을 «뚫고» 발사한다 (이 우회는 관측에 남는다)');
  });
});

describe('짝 테스트 정적 측정 — 렌더와 분리된 순수 관측', () => {
  test('[paired-test-measures-array-equality-and-symbol] 배열 비교와 심볼이 있으면 두 수를 각각 낸다', () => {
    const result = measurePairedTestFile('src/example.ts', 'marker', (path) => path === 'src/example.test.ts'
      ? "expect(marker).toEqual([1]);\nexpect(other).toEqual( [2] );\nmarker();"
      : null);
    expect(result.toEqualArrayOpenings).toEqual({ state: 'checked', count: 2 });
    expect(result.symbolOccurrences).toEqual({ state: 'checked', count: 2 });
  });

  test('[paired-test-symbol-absent-is-zero] 짝 파일에 심볼이 없으면 그 측정값은 0이다', () => {
    const result = measurePairedTestFile('src/example.ts', 'marker', () => 'expect(value).toEqual([1]);');
    expect(result.symbolOccurrences).toEqual({ state: 'checked', count: 0 });
  });

  test('[paired-test-symbol-dollar-boundaries] 달러를 포함한 JS/TS 심볼을 세고 더 긴 식별자 내부 일치는 제외한다', () => {
    const contents = '$marker(); $marker; prefix$marker; marker$(); marker$; marker$suffix;';
    expect(measurePairedTestFile('src/example.ts', '$marker', () => contents).symbolOccurrences).toEqual({ state: 'checked', count: 2 });
    expect(measurePairedTestFile('src/example.ts', 'marker$', () => contents).symbolOccurrences).toEqual({ state: 'checked', count: 2 });
  });

  test('[paired-test-missing-is-unknown] 짝 파일이 없으면 두 측정값 모두 측정 불가다', () => {
    const result = measurePairedTestFile('src/example.ts', 'marker', () => null);
    expect(result.toEqualArrayOpenings.state).toBe('unknown');
    expect(result.symbolOccurrences.state).toBe('unknown');
  });

  test('[paired-test-symbol-unspecified-is-unknown] 심볼 이름이 없으면 심볼 측정값은 측정 불가다', () => {
    const result = measurePairedTestFile('src/example.ts', undefined, () => 'expect(value).toEqual([1]);');
    expect(result.symbolOccurrences.state).toBe('unknown');
  });
});

describe('gate preexisting 실패 관측 — 경고만 남긴다', () => {
  test('[sibling-test-path-is-pure-ts-conversion] 소스 TypeScript 경로를 디스크 접근 없이 형제 테스트 경로로 바꾼다', () => {
    expect(siblingTestPath('src/self-implement/orchestrator.ts')).toBe('src/self-implement/orchestrator.test.ts');
    expect(siblingTestPath('src/self-implement/orchestrator.test.ts')).toBeNull();
    expect(siblingTestPath('src/self-implement/orchestrator.tsx')).toBeNull();
  });

  test('[preexisting-failure-warns-with-test-name-without-blocking] 기록된 대상 테스트는 이름과 함께 경고하지만 발사를 막지 않는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/self-dev/launch-preflight.test.ts'],
      openPrs: [],
      unfinishedRuns: [],
      preexistingFailureTestFiles: parsePreexistingFailureTestFiles('[gate-baseline] introduced=0, preexisting=1, unknown=0, precondition-unmet=0\n- preexisting: src/self-dev/launch-preflight.test.ts > base red'),
      liveRunWindowMs: WINDOW,
    });
    expect(result.preexistingFailures).toMatchObject({ state: 'checked', files: ['src/self-dev/launch-preflight.test.ts'] });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ name: 'gate preexisting 실패', detail: expect.stringContaining('(직접 지목; 그 뒤 판단 불가)') }));
    expect(renderLaunchPreflight(result)).toContain('src/self-dev/launch-preflight.test.ts');
  });

  test('[preexisting-failure-warns-for-source-sibling-without-blocking] 소스 경로만 지목해도 짝 빨강 테스트와 원인 소스를 남기고 발사를 막지 않는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/self-implement/orchestrator.ts'],
      openPrs: [],
      unfinishedRuns: [],
      preexistingFailureTestFiles: ['src/self-implement/orchestrator.test.ts'],
      liveRunWindowMs: WINDOW,
    });
    expect(result.preexistingFailures).toMatchObject({ state: 'checked', files: ['src/self-implement/orchestrator.test.ts'] });
    expect(result.blockers).toEqual([]);
    expect(result.warnings.filter(({ name }) => name === 'gate preexisting 실패')).toHaveLength(1);
    expect(renderLaunchPreflight(result)).toContain('소스 짝: src/self-implement/orchestrator.ts');
  });

  test('[preexisting-failure-direct-target-renders-each-reconfirmation-state-with-command-without-changing-membership] 직접 지목 경고는 세 재확인 상태와 미재확인 확인 명령을 말해도 파일 membership과 차단 결정을 바꾸지 않는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['test/reconfirmed.test.ts', 'test/unreconfirmed.test.ts', 'test/indeterminate.test.ts'],
      openPrs: [],
      unfinishedRuns: [],
      preexistingFailures: {
        state: 'checked',
        files: ['test/reconfirmed.test.ts', 'test/unreconfirmed.test.ts', 'test/indeterminate.test.ts'],
        records: [
          { file: 'test/reconfirmed.test.ts', observedAt: '2026-08-22T00:00:00.000Z', reconfirmed: true },
          { file: 'test/unreconfirmed.test.ts', observedAt: '2026-08-21T00:00:00.000Z', reconfirmed: false },
          { file: 'test/indeterminate.test.ts', observedAt: null, reconfirmed: null },
        ],
      },
      liveRunWindowMs: WINDOW,
    });

    const warning = result.warnings.find(({ name }) => name === 'gate preexisting 실패');
    expect(result.preexistingFailures).toMatchObject({
      state: 'checked',
      files: ['test/reconfirmed.test.ts', 'test/unreconfirmed.test.ts', 'test/indeterminate.test.ts'],
    });
    expect(result.blockers).toEqual([]);
    const renderedWarning = renderLaunchPreflight(result).split('\n').find((line) => line.includes('gate가 원래부터 실패하던 것으로 기록한 대상 테스트:'));
    expect(warning?.detail).toContain('test/reconfirmed.test.ts (직접 지목; 그 뒤 재확인됨)');
    expect(warning?.detail).toContain('test/unreconfirmed.test.ts (직접 지목; 그 뒤 재확인 없음 — bun test test/unreconfirmed.test.ts 로 직접 확인하라)');
    expect(warning?.detail).toContain('test/indeterminate.test.ts (직접 지목; 그 뒤 판단 불가)');
    expect(renderedWarning).toContain('test/reconfirmed.test.ts (직접 지목; 그 뒤 재확인됨)');
    expect(renderedWarning).toContain('test/unreconfirmed.test.ts (직접 지목; 그 뒤 재확인 없음 — bun test test/unreconfirmed.test.ts 로 직접 확인하라)');
    expect(renderedWarning).toContain('test/indeterminate.test.ts (직접 지목; 그 뒤 판단 불가)');
    expect(renderLaunchPreflight(result)).toContain('재확인 없음 1개 · 재확인 판단 불가 1개');
  });

  test('[preexisting-failure-render-reports-oldest-age-and-unreconfirmed-count] renderLaunchPreflight는 가장 오래된 기록 나이와 재확인 없는 수를 동적으로 말한다', () => {
    const now = Date.now;
    Date.now = () => Date.parse('2026-08-23T00:00:00.000Z');
    try {
      const result = evaluateLaunchPreflight({
        paths: ['test/old.test.ts', 'test/reconfirmed.test.ts', 'test/unknown.test.ts'], openPrs: [], unfinishedRuns: [],
        preexistingFailures: {
          state: 'checked', files: ['test/old.test.ts', 'test/reconfirmed.test.ts', 'test/unknown.test.ts'],
          records: [
            { file: 'test/old.test.ts', observedAt: '2026-08-20T00:00:00.000Z', reconfirmed: false },
            { file: 'test/reconfirmed.test.ts', observedAt: '2026-08-22T00:00:00.000Z', reconfirmed: true },
            { file: 'test/unknown.test.ts', observedAt: null, reconfirmed: null },
          ],
        }, liveRunWindowMs: WINDOW,
      });
      expect(result.blockers).toEqual([]);
      expect(renderLaunchPreflight(result)).toContain('시각 확인 가능한 기록 중 가장 오래된 기록 3일 전 · 시각 모름 1개 · 재확인 없음 1개 · 재확인 판단 불가 1개');
    } finally {
      Date.now = now;
    }
  });

  test('[preexisting-failure-warning-includes-observed-at-from-existing-observation] 경고는 기존 gate 관측의 시점을 같이 말한다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [],
      unfinishedRuns: [],
      preexistingFailures: { state: 'checked', files: ['src/index.test.ts'], records: [{ file: 'src/index.test.ts', observedAt: '2026-08-21T23:59:00.000Z' }] },
      liveRunWindowMs: WINDOW,
    });
    const text = renderLaunchPreflight(result);
    expect(result.blockers).toEqual([]);
    expect(text).toContain('gate가 원래부터 실패하던 것으로 기록한 대상 테스트: src/index.test.ts (소스 짝: src/index.ts) · 관측 2026-08-21T23:59:00.000Z — 이 경고는 발사를 막지 않으며 사람이 읽고 판단한다');
  });

  test('[preexisting-failure-warning-says-unknown-when-observed-at-is-absent] 시점을 못 얻으면 지어내지 않고 모름으로 말한다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [],
      unfinishedRuns: [],
      preexistingFailureTestFiles: ['src/index.test.ts'],
      liveRunWindowMs: WINDOW,
    });
    const text = renderLaunchPreflight(result);
    expect(result.blockers).toEqual([]);
    expect(text).toContain('src/index.test.ts (소스 짝: src/index.ts) · 관측 모름');
    expect(text).not.toContain(new Date().getFullYear().toString());
  });

  test('[preexisting-failure-warning-says-unknown-when-observed-at-is-blank] 빈 시점은 관측값으로 렌더하지 않고 모름으로 말한다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [],
      unfinishedRuns: [],
      preexistingFailures: { state: 'checked', files: ['src/index.test.ts'], records: [{ file: 'src/index.test.ts', observedAt: '' }] },
      liveRunWindowMs: WINDOW,
    });
    const text = renderLaunchPreflight(result);
    expect(result.blockers).toEqual([]);
    expect(normalizePreexistingFailureObservedAt('')).toBeNull();
    expect(normalizePreexistingFailureObservedAt('   ')).toBeNull();
    expect(text).toContain('src/index.test.ts (소스 짝: src/index.ts) · 관측 모름');
    expect(text).not.toContain('· 관측  —');
  });

  test('[preexisting-failure-files-remain-when-records-empty] records가 빈 배열이어도 files 기준 실패 경고를 보존한다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [],
      unfinishedRuns: [],
      preexistingFailures: { state: 'checked', files: ['src/index.test.ts'], records: [] },
      liveRunWindowMs: WINDOW,
    });
    const text = renderLaunchPreflight(result);
    expect(result.preexistingFailures).toMatchObject({ state: 'checked', files: ['src/index.test.ts'], records: [{ file: 'src/index.test.ts', observedAt: null }] });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      name: 'gate preexisting 실패',
      detail: expect.stringContaining('src/index.test.ts (소스 짝: src/index.ts) · 관측 모름'),
    }));
    expect(text).toContain('gate가 원래부터 실패하던 것으로 기록한 대상 테스트: src/index.test.ts (소스 짝: src/index.ts) · 관측 모름 — 이 경고는 발사를 막지 않으며 사람이 읽고 판단한다');
  });

  test('[preexisting-failure-files-and-records-merge-observed-at] files 기준 실패 경고에 대응 record 시점을 결합한다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [],
      unfinishedRuns: [],
      preexistingFailures: {
        state: 'checked',
        files: ['src/index.test.ts'],
        records: [{ file: 'src/index.test.ts', observedAt: '2026-08-22T00:00:00.000Z' }],
      },
      liveRunWindowMs: WINDOW,
    });
    expect(result.preexistingFailures).toMatchObject({ state: 'checked', files: ['src/index.test.ts'], records: [{ file: 'src/index.test.ts', observedAt: '2026-08-22T00:00:00.000Z' }] });
    expect(renderLaunchPreflight(result)).toContain('src/index.test.ts (소스 짝: src/index.ts) · 관측 2026-08-22T00:00:00.000Z');
  });

  test('[preexisting-failure-records-not-in-files-do-not-create-warning] files에 없는 records는 새 실패 대상을 만들지 않는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['x.ts'],
      openPrs: [],
      unfinishedRuns: [],
      preexistingFailures: {
        state: 'checked',
        files: [],
        records: [{ file: 'x.test.ts', observedAt: '2026-08-22T00:00:00.000Z' }],
      },
      liveRunWindowMs: WINDOW,
    });
    expect(result.preexistingFailures).toMatchObject({ state: 'checked', files: [], records: [] });
    expect(result.blockers).toEqual([]);
    expect(result.warnings.filter(({ name }) => name === 'gate preexisting 실패')).toEqual([]);
    expect(renderLaunchPreflight(result)).not.toContain('x.test.ts');
  });

  test('[preexisting-failure-preserves-direct-and-source-sibling-reasons] 테스트와 소스를 함께 지목하면 두 원인과 소스 경로를 모두 남긴다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/self-implement/orchestrator.ts', 'src/self-implement/orchestrator.test.ts'],
      openPrs: [],
      unfinishedRuns: [],
      preexistingFailureTestFiles: ['src/self-implement/orchestrator.test.ts'],
      liveRunWindowMs: WINDOW,
    });
    const warning = result.warnings.find(({ name }) => name === 'gate preexisting 실패');
    expect(result.preexistingFailures).toMatchObject({ state: 'checked', files: ['src/self-implement/orchestrator.test.ts'] });
    expect(result.blockers).toEqual([]);
    expect(warning?.detail).toContain('직접 지목');
    expect(warning?.detail).toContain('소스 짝: src/self-implement/orchestrator.ts');
  });

  test('[no-preexisting-record-stays-quiet-but-is-recorded] 기록된 일치가 없으면 경고 없이 checked 빈 배열로 남긴다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/self-dev/launch-preflight.test.ts'], openPrs: [], unfinishedRuns: [], preexistingFailureTestFiles: [], liveRunWindowMs: WINDOW,
    });
    expect(result.preexistingFailures).toMatchObject({ state: 'checked', files: [] });
    expect(result.warnings).toEqual([]);
    const text = renderLaunchPreflight(result);
    expect(text).not.toContain('gate preexisting 실패 기록');
    expect(text).not.toContain('같은 대상 0개');
  });

  test('[unreadable-preexisting-record-is-not-no-record] 기록을 못 읽으면 기록 없음으로 뭉개지 않는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/self-dev/launch-preflight.test.ts'], openPrs: [], unfinishedRuns: [], preexistingFailureTestFiles: null, preexistingFailuresUnknownReason: 'logs.db EACCES', liveRunWindowMs: WINDOW,
    });
    expect(result.preexistingFailures).toEqual({ state: 'unreadable', reason: 'logs.db EACCES' });
    expect(result.blockers).toEqual([]);
    expect(renderLaunchPreflight(result)).toContain('못 읽음 — logs.db EACCES');
  });

  test('[gate-observation-records-preserve-observed-at-without-extra-read] 이미 읽은 gate 관측 payload의 시점을 파일과 함께 보존한다', () => {
    expect(preexistingFailureRecordsFromGateObservations([{
      observedAt: '2026-08-22T00:00:00.000Z',
      failures: [
        { attribution: 'preexisting', file: 'src/self-dev/launch-preflight.test.ts' },
        { attribution: 'introduced', file: 'src/self-dev/other.test.ts' },
      ],
    }])).toEqual([{ file: 'src/self-dev/launch-preflight.test.ts', observedAt: '2026-08-22T00:00:00.000Z', reconfirmed: false }]);
  });

  test('[gate-observation-records-keep-never-reobserved-record-distinct-from-unknown-time] 뒤 관측이 없는 기록은 재확인 없음이고 시점 결손과 다른 값이다', () => {
    const records = preexistingFailureRecordsFromGateObservations([
      { observedAt: '2026-08-20T00:00:00.000Z', failures: [{ attribution: 'preexisting', file: 'test/never-reobserved.test.ts' }], baselineFiles: [] },
      { failures: [{ attribution: 'preexisting', file: 'test/unknown-time.test.ts' }], baselineFiles: [] },
    ]);
    expect(records).toEqual([
      { file: 'test/never-reobserved.test.ts', observedAt: '2026-08-20T00:00:00.000Z', reconfirmed: false },
      { file: 'test/unknown-time.test.ts', observedAt: null, reconfirmed: null },
    ]);
  });

  test('[gate-observation-records-clear-after-later-passing-run] 옛 preexisting 실패 파일을 더 최신 gate 관측이 돌렸고 실패에 없으면 결과에서 뺀다', () => {
    expect(preexistingFailureRecordsFromGateObservations([
      {
        observedAt: '2026-08-20T00:00:00.000Z',
        failures: [{ attribution: 'preexisting', file: 'src/self-implement/orchestrator.test.ts' }],
        baselineFiles: ['src/self-implement/orchestrator.test.ts'],
        baselineStatus: 'test-fail',
      },
      {
        observedAt: '2026-08-21T00:00:00.000Z',
        failures: [{ attribution: 'introduced', file: 'src/self-dev/other.test.ts' }],
        baselineFiles: ['src/self-implement/orchestrator.test.ts', 'src/self-dev/other.test.ts'],
        baselineStatus: 'test-fail',
      },
    ])).toEqual([]);
  });

  test('[gate-observation-records-retain-reconfirmed-failure-without-changing-retained-files] 더 최신 관측이 같은 실패를 재확인해도 파일을 보존하고 재확인 값을 낸다', () => {
    const records = preexistingFailureRecordsFromGateObservations([
      {
        observedAt: '2026-08-20T00:00:00.000Z',
        failures: [{ attribution: 'preexisting', file: 'test/task-orchestrator-types.test.ts' }],
        baselineFiles: ['test/task-orchestrator-types.test.ts'],
        baselineStatus: 'test-fail',
      },
      {
        observedAt: '2026-08-21T00:00:00.000Z',
        failures: [{ attribution: 'introduced', file: 'test/task-orchestrator-types.test.ts' }],
        baselineFiles: ['test/task-orchestrator-types.test.ts'],
        baselineStatus: 'test-fail',
      },
    ]);
    expect(records.map(({ file }) => file)).toEqual(['test/task-orchestrator-types.test.ts']);
    expect(records).toEqual([{ file: 'test/task-orchestrator-types.test.ts', observedAt: '2026-08-20T00:00:00.000Z', reconfirmed: true }]);
  });

  test('[gate-observation-records-retain-latest-non-preexisting-failure] 더 최신 관측에서 같은 파일이 non-preexisting 실패면 통과로 보지 않고 결과에 남긴다', () => {
    expect(preexistingFailureRecordsFromGateObservations([
      {
        observedAt: '2026-08-20T00:00:00.000Z',
        failures: [{ attribution: 'preexisting', file: 'test/task-orchestrator-types.test.ts' }],
        baselineFiles: ['test/task-orchestrator-types.test.ts'],
        baselineStatus: 'test-fail',
      },
      {
        observedAt: '2026-08-21T00:00:00.000Z',
        failures: [{ attribution: 'introduced', file: 'test/task-orchestrator-types.test.ts' }],
        baselineFiles: ['test/task-orchestrator-types.test.ts'],
        baselineStatus: 'test-fail',
      },
    ])).toEqual([{ file: 'test/task-orchestrator-types.test.ts', observedAt: '2026-08-20T00:00:00.000Z', reconfirmed: true }]);
  });

  test('[gate-observation-records-retain-after-pass-then-introduced-failure] 옛 preexisting 실패가 더 최신 pass 뒤 다시 introduced 실패면 가장 최신 실패를 기준으로 결과에 남긴다', () => {
    expect(preexistingFailureRecordsFromGateObservations([
      {
        observedAt: '2026-08-20T00:00:00.000Z',
        failures: [{ attribution: 'preexisting', file: 'test/task-orchestrator-types.test.ts' }],
        baselineFiles: ['test/task-orchestrator-types.test.ts'],
        baselineStatus: 'test-fail',
      },
      {
        observedAt: '2026-08-21T00:00:00.000Z',
        failures: [],
        baselineFiles: ['test/task-orchestrator-types.test.ts'],
        baselineStatus: 'pass',
      },
      {
        observedAt: '2026-08-22T00:00:00.000Z',
        failures: [{ attribution: 'introduced', file: 'test/task-orchestrator-types.test.ts' }],
        baselineFiles: ['test/task-orchestrator-types.test.ts'],
        baselineStatus: 'test-fail',
      },
    ])).toEqual([{ file: 'test/task-orchestrator-types.test.ts', observedAt: '2026-08-20T00:00:00.000Z', reconfirmed: true }]);
  });

  test('[gate-observation-reader-reads-production-schema-from-log-store] 실제 gate.baseline producer 스키마를 격리 LogStore에 기록해 preexisting 파일만 복원한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-gate-baseline-'));
    const dbPath = join(root, 'logs.db');
    const store = new LogStore(dbPath);
    try {
      store.insertBatch([{ surface: 'harness:self-implement', rec: {
        ts: '2026-08-22T00:00:00.000Z', level: 'info', category: 'self-implement', event: 'gate.baseline',
        data: {
          introduced: 1, preexisting: 1, unknown: 0, preconditionUnmet: 0,
          failures: [
            { attribution: 'preexisting', file: 'src/self-dev/launch-preflight.test.ts' },
            { attribution: 'introduced', file: 'src/self-dev/other.test.ts' },
          ],
          baselineFiles: [], baselineStatus: 'test-fail',
        },
      } }]);
    } finally {
      store.close();
    }
    try {
      expect(listPreexistingFailureTestFiles([{ dbPath }])).toEqual({ state: 'checked', files: ['src/self-dev/launch-preflight.test.ts'], records: [{ file: 'src/self-dev/launch-preflight.test.ts', observedAt: '2026-08-22T00:00:00.000Z', reconfirmed: false }] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('[one-unreadable-store-keeps-the-rest] 한 우주가 못 열려도 나머지에서 읽은 것을 낸다 — 못 읽은 것은 «값»으로 남는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-unreadable-store-'));
    const good = join(root, 'logs.db');
    const store = new LogStore(good);
    try {
      store.insertBatch([{ surface: 'harness:self-implement', rec: {
        ts: '2026-09-12T00:00:00.000Z', level: 'info' as const, category: 'self-implement', event: 'gate.baseline',
        data: { failures: [{ attribution: 'preexisting', file: 'test/kept.test.ts' }], baselineFiles: [], baselineStatus: 'test-fail' },
      } }]);
    } finally {
      store.close();
    }
    // ⭐ 못 여는 «두 종류» — 실측에서 서로 다른 예외 문면이 난다.
    const corrupt = join(root, 'corrupt.db');
    writeFileSync(corrupt, 'not a database at all\n');   // file is not a database
    const empty = join(root, 'empty.db');
    writeFileSync(empty, '');                             // no such table: logs
    const absent = join(root, 'absent.db');               // 파일이 «없다» — 실패가 아니다

    try {
      for (const bad of [corrupt, empty]) {
        const result = listPreexistingFailureTestFiles([{ dbPath: good }, { dbPath: bad }]);
        if (result.state === 'unreadable') throw new Error(`읽은 것이 있으면 unreadable 이 아니어야 한다: ${bad}`);
        expect(result.files).toEqual(['test/kept.test.ts']);
        expect(result.unreadableTargets).toHaveLength(1);
        expect(result.unreadableTargets?.[0]?.dbPath).toBe(bad);
        expect(result.unreadableTargets?.[0]?.reason.length).toBeGreaterThan(0);
      }

      // ⛔ 「파일이 없다」는 실패로 «세지 않는다».
      const withAbsent = listPreexistingFailureTestFiles([{ dbPath: good }, { dbPath: absent }]);
      if (withAbsent.state === 'unreadable') throw new Error('없는 파일은 실패가 아니다');
      expect(withAbsent.files).toEqual(['test/kept.test.ts']);
      expect(withAbsent.unreadableTargets ?? []).toEqual([]);

      // ⛔ 하나도 못 읽으면 여전히 «모른다» — 「읽은 게 0건」으로 접히지 않는다.
      expect(listPreexistingFailureTestFiles([{ dbPath: corrupt }]).state).toBe('unreadable');

      // ⛔ 사람이 읽는 줄이 그 수를 낸다.
      const rendered = renderLaunchPreflight(decideAskPreflight(
        { goalFile: '', pathsOverride: ['src/self-dev/launch-preflight.ts'], liveRunWindowMinutes: 30, recentChangeWindowDays: 7 },
        {
          readGoalDocument: () => { throw new Error('저작 전에는 읽지 않아야 한다'); },
          tracedPaths: () => [],
          listOpenPrs: () => [],
          listUnfinishedRuns: () => [],
          countRecentChanges: () => ({}),
          listPreexistingFailureTestFiles: () => listPreexistingFailureTestFiles([{ dbPath: good }, { dbPath: corrupt }]),
        },
        false,
      ).result);
      expect(rendered).toContain('로그 우주 1개를 «못 읽었다»');
      expect(rendered).toContain('corrupt.db');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('[gate-observation-reader-preserves-1000-boundary] 실제 LogStore 조회는 정확히 1000행이면 checked, 1001행이면 truncated다', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-gate-baseline-limit-'));
    const dbPath = join(root, 'logs.db');
    const insert = (count: number) => {
      const store = new LogStore(dbPath);
      try {
        store.insertBatch(Array.from({ length: count }, (_, index) => ({ surface: 'harness:self-implement', rec: {
          ts: `2026-08-22T00:${String(index % 60).padStart(2, '0')}:00.000Z`, level: 'info' as const, category: 'self-implement', event: 'gate.baseline',
          data: { failures: [{ attribution: 'preexisting', file: `test/${index}.test.ts` }] },
        } })));
      } finally {
        store.close();
      }
    };
    try {
      insert(1_000);
      expect(listPreexistingFailureTestFiles([{ dbPath }])).toMatchObject({ state: 'checked' });
      insert(1);
      expect(listPreexistingFailureTestFiles([{ dbPath }])).toMatchObject({ state: 'truncated', limit: 1_000 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('[omitted-preexisting-reader-is-unreadable-not-zero] reader를 생략하면 기록 없음으로 단정하지 않는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/self-dev/launch-preflight.test.ts'], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW,
    });
    expect(result.preexistingFailures).toEqual({ state: 'unreadable', reason: 'gate preexisting 실패 기록 조회기가 배선되지 않았다' });
    expect(renderLaunchPreflight(result)).not.toContain('같은 대상 0개');
  });

  test('[ask-marker-warnings-are-observational] 산문형·소비자 경로 판정 신호는 기존 검사기 문면으로 경고하지만 정상 형식은 경고 없이 발사를 보존한다', () => {
    const deps = {
      readGoalDocument: () => { throw new Error('저작 전에는 읽지 않아야 한다'); },
      tracedPaths: () => [],
      listOpenPrs: () => [],
      listUnfinishedRuns: () => [],
      countRecentChanges: () => ({}),
      listPreexistingFailureTestFiles: () => ({ state: 'checked' as const, files: [] }),
    };
    const options = { goalFile: '', pathsOverride: ['src/self-dev/launch-preflight.ts'], liveRunWindowMinutes: 30, recentChangeWindowDays: 7 };
    const prose = decideAskPreflight({
      ...options,
      askText: '대상 경로: src/self-dev/launch-preflight.ts\n판정 신호: 산문으로만 적었다',
    }, deps, false);
    const consumerPathGap = decideAskPreflight({
      ...options,
      askText: '대상 경로: src/self-dev/launch-preflight.ts\n경계: scripts/ask-marker-check.ts 를 고치지 않는다\n판정 신호: 조건 = 소비자; 관측 = bun test src/self-dev/launch-preflight.test.ts; 기대 = 지금은 0건',
    }, deps, false);
    const valid = decideAskPreflight({
      ...options,
      askText: '대상 경로: src/self-dev/launch-preflight.ts\n경계: scripts/ask-marker-check.ts 를 고치지 않는다\n판정 신호: 조건 = 형식; 관측 = bun test scripts/ask-marker-check.ts; 기대 = 통과\n판정 신호: 조건 = 형식; 관측 = 예비 검사 표준 출력; 기대 = 경고 없음',
    }, deps, false);

    expect(prose.result.blockers).toEqual([]);
    expect(prose.shouldLaunch).toBe(true);
    expect(renderLaunchPreflight(prose.result)).toContain('ask 마커 — ⚠️ 판정 신호');
    expect(consumerPathGap.result.blockers).toEqual([]);
    expect(consumerPathGap.shouldLaunch).toBe(true);
    expect(renderLaunchPreflight(consumerPathGap.result)).toContain('ask 마커 — ⚠️ 어디까지 사나 — scripts/ask-marker-check.ts');
    expect(valid.result.warnings.filter((warning) => warning.kind === 'ask-marker' && warning.detail.includes('어디까지 사나'))).toEqual([]);
  });

  test('[ask-marker-warning-observations-follow-their-summary-without-blocking] formatAxisObservations의 경고 세부는 요약 바로 뒤에 렌더하지만 정보 세부는 싣지 않고 ask-markers 관측은 한 건으로 보존한다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const decision = decideAskPreflight({
        goalFile: '',
        pathsOverride: ['src/self-dev/launch-preflight.ts'],
        // 파일 이름은 존재하지만 선언한 경로는 틀려야 경고 요약과 실제 경로 세부가 함께 나온다.
        askText: '대상 경로: src/self-dev/launch-preflight.ts\n판정 신호: 조건 = 경로; 관측 = bun test missing/oauth/codex-account-rotation.test.ts; 기대 = 경고',
        liveRunWindowMinutes: 30,
        recentChangeWindowDays: 7,
      }, {
        readGoalDocument: () => { throw new Error('저작 전에는 읽지 않아야 한다'); },
        tracedPaths: () => [],
        listOpenPrs: () => [],
        listUnfinishedRuns: () => [],
        countRecentChanges: () => ({}),
        listPreexistingFailureTestFiles: () => ({ state: 'checked' as const, files: [] }),
      }, false);
      const lines = renderLaunchPreflight(decision.result).split('\n');
      const summaryIndex = lines.findIndex((line) => line.includes('⚠️ ask 마커 — ⚠️ 판정 신호 시험 경로 — 1개 경로가'));
      // #21466 added src/oauth/codex-account-rotation.test.ts next to test/oauth/…, so the «same file name» list now
      // holds both paths (sorted). Check membership, not which one comes right after the colon.
      const detailIndex = lines.findIndex((line) => line.includes('⚠️ ask 마커 — ⚠️ 판정 신호 시험 경로 —') && line.includes('같은 파일 이름의 실제 경로:') && line.includes('test/oauth/codex-account-rotation.test.ts'));

      expect(detailIndex).toBe(summaryIndex + 1);
      expect(lines.some((line) => line.includes('ask 마커 — ℹ️'))).toBe(false);
      expect(decision.result.blockers).toEqual([]);
      expect(decision.shouldLaunch).toBe(true);
      expect(log.mock.calls.filter((call) => call[0] === 'harness.preflight' && call[1] === 'ask-markers')).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  test('[injected-empty-reader-is-checked-not-omitted] 격리된 빈 reader는 checked 빈 배열을 남긴다', () => {
    const decision = decideAskPreflight({ goalFile: 'goal.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, {
      readGoalDocument: () => 'goal', tracedPaths: () => ['src/self-dev/launch-preflight.test.ts'], listOpenPrs: () => [], listUnfinishedRuns: () => [], countRecentChanges: () => ({}),
      listPreexistingFailureTestFiles: () => ({ state: 'checked', files: [] }),
    }, false);
    expect(decision.result.preexistingFailures).toMatchObject({ state: 'checked', files: [] });
    expect(decision.shouldLaunch).toBe(true);
  });

  test('[truncated-preexisting-record-is-nonblocking-and-distinct] 상한에 닿은 기록은 별도 상태와 경고를 남기되 발사를 막지 않는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/self-dev/launch-preflight.test.ts'], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW,
      preexistingFailures: { state: 'truncated', files: [], limit: 1_000 },
    });
    expect(result.preexistingFailures).toMatchObject({ state: 'truncated', files: [], limit: 1_000 });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ name: 'gate preexisting 실패 기록 조회 상한 1000' }));
    expect(renderLaunchPreflight(result)).toContain('상한 1000 에 «닿았다»');
  });

  test('[decide-wires-preexisting-reader-without-changing-launch-policy] decideAskPreflight가 reader 상태를 전달해 경고만 내고 발사를 허용한다', () => {
    let calls = 0;
    const decision = decideAskPreflight({ goalFile: 'goal.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, {
      readGoalDocument: () => 'goal', tracedPaths: () => ['src/self-dev/launch-preflight.test.ts'], listOpenPrs: () => [], listUnfinishedRuns: () => [], countRecentChanges: () => ({}),
      listPreexistingFailureTestFiles: () => { calls += 1; return { state: 'checked', files: ['src/self-dev/launch-preflight.test.ts'] }; },
    }, false);
    expect(calls).toBe(1);
    expect(decision.result.preexistingFailures).toMatchObject({ state: 'checked', files: ['src/self-dev/launch-preflight.test.ts'] });
    expect(decision.shouldLaunch).toBe(true);
  });
});

describe('완료 런 경로 겹침 — 완료 사실은 값으로만 낸다', () => {
  test('[same-target-completed-runs-render-with-unreadable-and-limit-without-warning-or-blocking] 같은 경로의 과거 완료 런과 부분 조회를 한 줄로 보존한다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW,
      completedRuns: { entries: [{ runId: 'run-completed', plannedPaths: ['src/a.ts', 'src/other.ts'], ledgerDirectory: '/state/run-ledger' }], unreadableRuns: 2, limit: 1 },
    });
    expect(result.completedRunMatches).toEqual([{ runId: 'run-completed', plannedPaths: ['src/a.ts'], ledgerDirectory: '/state/run-ledger' }]);
    expect(result.completedRuns).toEqual({ state: 'unreadableRuns', count: 1, unreadableRuns: 2, truncated: true, limit: 1 });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(renderLaunchPreflight(result)).toContain('완료 런: ⚠️ 1건 조회 · 2건 원장 판독 불가 · 상한 1 에 «닿았다» · 같은 경로 1건: run-completed (/state/run-ledger)');
  });

  test('[raw-limit-survives-completed-path-extraction-failure] 원시 완료 조회가 상한에 닿으면 경로 추출 실패 뒤에도 부분 조회로 남긴다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW,
      completedRuns: { entries: [], unreadableRuns: 1, limit: 1, truncated: true },
    });
    expect(result.completedRuns).toEqual({ state: 'unreadableRuns', count: 0, unreadableRuns: 1, truncated: true, limit: 1 });
    expect(renderLaunchPreflight(result)).toContain('완료 런: ⚠️ 0건 조회 · 1건 원장 판독 불가 · 상한 1 에 «닿았다» · 같은 경로 0건');
  });

  test('완료 런 줄은 골 문서 부재 93건을 원장 판독 불가와 다른 문면으로 낸다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'],
      openPrs: [],
      unfinishedRuns: [],
      completedRuns: { entries: [], unreadableRuns: 0, missingGoalDocuments: 93 },
      liveRunWindowMs: WINDOW,
    });
    const line = renderLaunchPreflight(result);
    expect(line).toContain('93');
    expect(line).toContain('93건 골 문서 사라짐');
    expect(line).not.toContain('원장 판독 불가');
  });

  test('[completed-query-incomplete-truncation-is-unknown-not-undefined] 상한 없는 잘림 입력은 미지로 남기고 undefined를 렌더하지 않는다', () => {
    const completedRuns = { entries: [], unreadableRuns: 0, truncated: true } as unknown as NonNullable<Parameters<typeof evaluateLaunchPreflight>[0]['completedRuns']>;
    const result = evaluateLaunchPreflight({ paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], completedRuns, liveRunWindowMs: WINDOW });
    expect(result.completedRuns).toEqual({ state: 'unknown', reason: '완료 런 조회 상한 메타데이터가 불완전하다' });
    expect(renderLaunchPreflight(result)).not.toContain('undefined');
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('[completed-query-unknown-is-not-zero] 완료 원장을 못 읽으면 미지로 남기고 발사를 막지 않는다', () => {
    const result = evaluateLaunchPreflight({ paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], completedRuns: null, completedRunsUnknownReason: 'EACCES', liveRunWindowMs: WINDOW });
    expect(result.completedRuns).toEqual({ state: 'unknown', reason: 'EACCES' });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('[completed-same-path-ids-are-bounded-with-hidden-count-and-inspection-command] 상한 초과 완료 런은 대표 5개·숨긴 수·전부 보기 명령만 같은 줄에 낸다', () => {
    const entries = Array.from({ length: 7 }, (_, index) => ({
      runId: `run-completed-${index + 1}`,
      plannedPaths: ['src/a.ts'],
      ledgerDirectory: `/state/${index + 1}`,
    }));
    const text = renderLaunchPreflight(evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW,
      completedRuns: { entries, unreadableRuns: 0 },
    }));
    const line = text.split('\n').find((candidate) => candidate.includes('완료 런:'));
    expect(line).toContain('완료 런: 7건 조회 · 같은 경로 7건: run-completed-1 (/state/1), run-completed-2 (/state/2), run-completed-3 (/state/3), run-completed-4 (/state/4), run-completed-5 (/state/5) · 2건 숨김');
    expect(line).toContain('전부 보기: bun -e');
    expect(line).toContain('queryFederatedCompletedRunLedgers: completed');
    expect(line).toContain('queryFederatedInterruptedRunLedgers: interrupted');
    expect(line).toContain('limit: undefined');
    expect(line).toContain('JSON.parse(Buffer.from(process.argv.at(-1), "base64url").toString("utf8"))');
    expect(line).toContain('runIds.add(run.runId)');
    expect(line).not.toContain('run-completed-6');
    expect(line).not.toContain('run-completed-7');
  });

  test('[same-path-inspection-command-recovers-every-hidden-fixture-id-with-quoted-path] 전부 보기 명령은 상한 초과 fixture 원장의 숨긴 완료·중단 ID를 모두 복구한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'launch-preflight-inspection-'));
    const ledgerDirectory = runLedgerDir(root);
    const goalsDirectory = join(root, 'goals');
    const goalFile = join(goalsDirectory, 'target.md');
    const targetPath = "src/quoted'o.ts";
    const runId = (number: number) => `run-00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
    const completedIds = Array.from({ length: 6 }, (_, index) => runId(index + 101));
    const interruptedIds = Array.from({ length: 6 }, (_, index) => runId(index + 201));
    try {
      mkdirSync(ledgerDirectory, { recursive: true });
      mkdirSync(goalsDirectory, { recursive: true });
      writeFileSync(goalFile, `## TRACED PATHS\n- [code] ${targetPath} — target\n`, 'utf8');
      for (const completedId of completedIds) {
        writeFileSync(join(ledgerDirectory, `${completedId}.jsonl`), [
          { runId: completedId, event: 'start', data: { goalFile } },
          { runId: completedId, event: 'run-status', data: { runStatus: 'completed' } },
        ].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
      }
      for (const interruptedId of interruptedIds) {
        writeFileSync(join(ledgerDirectory, `${interruptedId}.jsonl`), [
          { runId: interruptedId, event: 'start', data: { goalFile } },
          { runId: interruptedId, event: 'rework-budget', data: { verdict: 'UNCONVERGEABLE', reason: 'fixture' } },
          { runId: interruptedId, event: 'run-status', data: { runStatus: 'failed' } },
        ].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
      }

      const targets = [{ name: 'fixture', dbPath: join(root, 'mss', 'logs.db') }];
      const completed = queryFederatedCompletedRunLedgers({ targets, path: targetPath });
      const interrupted = queryFederatedInterruptedRunLedgers({ targets, path: targetPath });
      expect(completed.entries.map((entry) => entry.runId)).toEqual(completedIds);
      expect(interrupted.entries.map((entry) => entry.runId)).toEqual(interruptedIds);
      const rendered = renderLaunchPreflight(evaluateLaunchPreflight({
        paths: [targetPath], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW,
        completedRuns: { entries: completed.entries.map((entry) => ({ ...entry, plannedPaths: [targetPath] })), unreadableRuns: 0 },
        interruptedRuns: { entries: interrupted.entries.map((entry) => ({ ...entry, plannedPaths: [targetPath] })), unreadableRuns: 0 },
      }));
      const command = rendered.match(/전부 보기: (bun -e .+)$/m)?.[1];
      const hiddenIds = [...completedIds.slice(5), ...interruptedIds.slice(5)];
      expect(command).toBeDefined();
      expect(command).not.toContain(targetPath);
      for (const hiddenId of hiddenIds) expect(rendered).not.toContain(hiddenId);
      const executed = spawnSync('sh', ['-c', command!], {
        cwd: resolve(import.meta.dir, '..', '..'),
        encoding: 'utf8',
        env: { ...process.env, ELANOUS_STATE_DIR: root },
      });
      expect(executed.status).toBe(0);
      expect(executed.stderr).toBe('');
      const recoveredIds = executed.stdout.trim().split('\n');
      expect(recoveredIds).toEqual([...completedIds, ...interruptedIds].sort());
      for (const hiddenId of hiddenIds) expect(recoveredIds).toContain(hiddenId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test('[same-path-inline-limit-documents-obs-t458] 상한 5는 중앙값 128자·75% 1,425자 관측을 근거로 남긴다', async () => {
    const source = await Bun.file(new URL('./launch-preflight.ts', import.meta.url)).text();
    expect(source).toContain('const SAME_PATH_RUN_INLINE_LIMIT = 5');
    expect(source).toContain('128자');
    expect(source).toContain('1,425자');
    expect(source).not.toContain('user-config');
  });

  test('[completed-zero-matches-preserve-existing-line] 같은 경로 0건은 기존 완료 런 줄을 글자 그대로 보존한다', () => {
    const text = renderLaunchPreflight(evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW,
      completedRuns: { entries: [], unreadableRuns: 0 },
    }));
    const line = text.split('\n').find((candidate) => candidate.includes('완료 런:'));
    expect(line).toBe('[preflight] 완료 런: 0건 조회 · 같은 경로 0건');
  });

  test('[completed-unknown-preserves-unknown-wording] 완료 런 미지는 「없음」과 구별하는 기존 문면을 보존한다', () => {
    const text = renderLaunchPreflight(evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], completedRuns: null, completedRunsUnknownReason: 'EACCES', liveRunWindowMs: WINDOW,
    }));
    const line = text.split('\n').find((candidate) => candidate.includes('완료 런:'));
    expect(line).toBe('[preflight] 완료 런: ⚠️ 미지 — EACCES (⛔ 「없음」이 아니다)');
  });

  test('[completed-same-path-ids-at-cap-preserve-byte-identical-line] 완료 런이 상한 이하면 기존 줄을 글자 그대로 보존한다', () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({
      runId: `run-completed-${index + 1}`,
      plannedPaths: ['src/a.ts'],
      ledgerDirectory: `/state/${index + 1}`,
    }));
    const text = renderLaunchPreflight(evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW,
      completedRuns: { entries, unreadableRuns: 0 },
    }));
    const line = text.split('\n').find((candidate) => candidate.includes('완료 런:'));
    expect(line).toBe('[preflight] 완료 런: 5건 조회 · 같은 경로 5건: run-completed-1 (/state/1), run-completed-2 (/state/2), run-completed-3 (/state/3), run-completed-4 (/state/4), run-completed-5 (/state/5)');
  });
});

describe('중단 런 경로 겹침 — 종료 사실은 값으로만 낸다', () => {
  const input = (interruptedRuns: Parameters<typeof evaluateLaunchPreflight>[0]['interruptedRuns']) => evaluateLaunchPreflight({
    paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], interruptedRuns, liveRunWindowMs: WINDOW,
  });

  test('[empty-is-checked-zero] 중단 런 없음은 조회됨 0건이다', () => {
    const result = input({ entries: [], unreadableRuns: 0 });
    expect(result.interruptedRuns).toEqual({ state: 'checked', count: 0 });
    expect(renderLaunchPreflight(result)).toContain('[preflight] 중단 런: 0건 조회 · 같은 경로 0건');
  });

  test('[interrupted-unknown-preserves-unknown-wording] 중단 런 미지는 「없음」과 구별하는 기존 문면을 보존한다', () => {
    const text = renderLaunchPreflight(input(null));
    const line = text.split('\n').find((candidate) => candidate.includes('중단 런:'));
    expect(line).toBe('[preflight] 중단 런: ⚠️ 미지 — 중단 런 조회 실패 (⛔ 「없음」이 아니다)');
  });

  test('[matches-structured-nonblocking] 같은 경로의 중단 런은 ID·사유·원장 위치를 값으로 내며 막지 않는다', () => {
    const result = input({ entries: [{
      runId: 'run-interrupted', plannedPaths: ['src/a.ts', 'src/other.ts'], interruptionReason: 'gate failed', ledgerDirectory: '/state/run-ledger',
    }], unreadableRuns: 0 });
    expect(result.interruptedRunMatches).toEqual([{
      runId: 'run-interrupted', plannedPaths: ['src/a.ts'], interruptionReason: 'gate failed', ledgerDirectory: '/state/run-ledger',
    }]);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('[nonmatching-is-not-a-match] 다른 경로 중단 런은 조회 수와 겹침 수를 섞지 않는다', () => {
    const result = input({ entries: [{ runId: 'run-other', plannedPaths: ['src/other.ts'], interruptionReason: null, ledgerDirectory: '/state/run-ledger' }], unreadableRuns: 0 });
    expect(result.interruptedRuns).toEqual({ state: 'checked', count: 1 });
    expect(result.interruptedRunMatches).toEqual([]);
  });

  test('[failure-truncation-unreadable-are-distinct] 실패·상한·원장 판독 불가를 서로 다른 상태로 낸다', () => {
    expect(input(null).interruptedRuns).toMatchObject({ state: 'unknown' });
    expect(input({ entries: [{ runId: 'run-limit', plannedPaths: ['src/a.ts'], interruptionReason: null, ledgerDirectory: '/state' }], unreadableRuns: 0, limit: 1 }).interruptedRuns).toEqual({ state: 'truncated', count: 1, limit: 1 });
    expect(input({ entries: [], unreadableRuns: 2 }).interruptedRuns).toEqual({ state: 'unreadableRuns', count: 0, unreadableRuns: 2 });
  });

  test('[unreadable-and-truncated-preserve-both-facts] 판독 불가와 상한 도달은 같은 결과에서 함께 보존한다', () => {
    const result = input({
      entries: [{ runId: 'run-limit', plannedPaths: ['src/a.ts'], interruptionReason: null, ledgerDirectory: '/state' }],
      unreadableRuns: 2,
      limit: 1,
    });
    expect(result.interruptedRuns).toEqual({ state: 'unreadableRuns', count: 1, unreadableRuns: 2, truncated: true, limit: 1 });
    expect(renderLaunchPreflight(result)).toContain('상한 1 에 «닿았다»');
  });

  test('[interrupted-run-observation-failures-preserve-distinct-causes-and-legacy-total] 원장·골 경로 관측의 네 실패 원인을 합계와 함께 구분해 낸다', () => {
    const observationFailures = {
      ledgerLoadThrows: 1,
      nullLedgers: 2,
      missingGoalFileNames: 3,
      unreadableOrMissingGoalDocuments: 4,
    } as const;
    const result = input({ entries: [], unreadableRuns: 10, observationFailures });

    expect(result.interruptedRuns).toEqual({
      state: 'unreadableRuns',
      count: 0,
      unreadableRuns: 10,
      missingGoalDocuments: 4,
      observationFailures,
    });
    expect(interruptedRunObservationFailureCount(observationFailures)).toBe(10);
    expect(renderLaunchPreflight(result)).toContain('중단 런: ⚠️ 0건 조회 · 10건 원장 판독 불가 (원장 로드 예외 1건 · null 원장 2건 · goalFile 이름 없음 3건 · 골 문서 사라짐 4건) · 같은 경로 0건');
    expect(result.interruptedRuns).toMatchObject({ missingGoalDocuments: 4 });
  });

  test('[interrupted-run-observation-failures-over-total-still-renders-known-causes] 비정상 원인별 합계 초과도 알려진 원인을 숨기거나 음수 잔여를 내지 않는다', () => {
    const text = renderLaunchPreflight(input({
      entries: [],
      unreadableRuns: 2,
      observationFailures: { ledgerLoadThrows: 3 },
    }));

    expect(text).toContain('2건 원장 판독 불가 (원장 로드 예외 3건) · ⚠️ 원인별 합계 3건이 전체 2건을 초과');
    expect(text).not.toContain('기타/미분류 실패 -');
  });

  // 🩸 2026-09-23 실물(#19981 직후): 판독 불가 0 · 골 문서 사라짐 80 이 「원인별 합계 80건이 전체 0건을 초과」로 찍혔다.
  test('[interrupted-run-missing-goal-documents-are-not-an-excess] 골 문서 사라짐만 있으면 «초과» 경고가 아니다', () => {
    const text = renderLaunchPreflight(input({
      entries: [],
      unreadableRuns: 0,
      observationFailures: { unreadableOrMissingGoalDocuments: 80 },
    }));
    expect(text).toContain('골 문서 사라짐 80건');
    expect(text).not.toContain('초과');
    expect(text).not.toContain('원장 판독 불가');
  });

  test('[interrupted-run-excess-still-fires-beyond-goal-documents] 골 문서 칸을 빼고도 넘치면 «초과»는 그대로 낸다', () => {
    const text = renderLaunchPreflight(input({
      entries: [],
      unreadableRuns: 1,
      observationFailures: { ledgerLoadThrows: 2, unreadableOrMissingGoalDocuments: 5 },
    }));
    expect(text).toContain('원인별 합계 2건이 전체 1건을 초과');
  });

  test('[interrupted-run-observation-failures-legacy-input-keeps-existing-rendering] 원인별 카운터 없는 구형 입력은 기존 원장 판독 불가 문면을 보존한다', () => {
    const text = renderLaunchPreflight(input({ entries: [], unreadableRuns: 2 }));
    expect(text).toContain('중단 런: ⚠️ 0건 조회 · 2건 원장 판독 불가 · 같은 경로 0건');
    expect(text).not.toContain('원장 로드 예외');
  });

  test('[unreadable-interrupted-runs-render-same-path-count-and-matches] 판독 불가 중단 런도 같은 줄에 경로 매치 수를 낸다', () => {
    const matched = input({
      entries: [{ runId: 'run-interrupted', plannedPaths: ['src/a.ts'], interruptionReason: 'gate failed', ledgerDirectory: '/state/run-ledger' }],
      unreadableRuns: 2,
      limit: 1,
    });
    const unmatched = input({
      entries: [{ runId: 'run-other', plannedPaths: ['src/other.ts'], interruptionReason: null, ledgerDirectory: '/state/run-ledger' }],
      unreadableRuns: 2,
    });

    expect(renderLaunchPreflight(matched)).toContain('중단 런: ⚠️ 1건 조회 · 2건 원장 판독 불가 · 상한 1 에 «닿았다» · 같은 경로 1건: run-interrupted (gate failed · /state/run-ledger)');
    expect(renderLaunchPreflight(unmatched)).toContain('중단 런: ⚠️ 1건 조회 · 2건 원장 판독 불가 · 같은 경로 0건');
  });

  test('[interrupted-same-path-ids-are-bounded-in-normal-and-unreadable-lines] 상한 초과 중단 런의 두 문면은 전체 수를 보존하고 대표 5개·숨긴 수·전부 보기 명령만 같은 줄에 낸다', () => {
    const entries = Array.from({ length: 7 }, (_, index) => ({
      runId: `run-interrupted-${index + 1}`,
      plannedPaths: ['src/a.ts'],
      interruptionReason: `reason-${index + 1}`,
      ledgerDirectory: `/state/${index + 1}`,
    }));
    const normal = renderLaunchPreflight(input({ entries, unreadableRuns: 0 }));
    const unreadable = renderLaunchPreflight(input({ entries, unreadableRuns: 2 }));
    const suffix = 'run-interrupted-1 (reason-1 · /state/1), run-interrupted-2 (reason-2 · /state/2), run-interrupted-3 (reason-3 · /state/3), run-interrupted-4 (reason-4 · /state/4), run-interrupted-5 (reason-5 · /state/5) · 2건 숨김';
    expect(normal).toContain(`중단 런: 7건 조회 · 같은 경로 7건: ${suffix}`);
    expect(unreadable).toContain(`중단 런: ⚠️ 7건 조회 · 2건 원장 판독 불가 · 같은 경로 7건: ${suffix}`);
    for (const text of [normal, unreadable]) {
      expect(text).toContain('전부 보기: bun -e');
      expect(text).toContain('queryFederatedCompletedRunLedgers: completed');
      expect(text).toContain('queryFederatedInterruptedRunLedgers: interrupted');
      expect(text).toContain('JSON.parse(Buffer.from(process.argv.at(-1), "base64url").toString("utf8"))');
      expect(text).toContain('runIds.add(run.runId)');
    }
    expect(normal).not.toContain('run-interrupted-6');
    expect(unreadable).not.toContain('run-interrupted-7');
  });

  test('[interrupted-same-path-ids-at-cap-preserve-byte-identical-line] 중단 런이 상한 이하면 두 문면이 기존 줄을 글자 그대로 보존한다', () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({
      runId: `run-interrupted-${index + 1}`,
      plannedPaths: ['src/a.ts'],
      interruptionReason: `reason-${index + 1}`,
      ledgerDirectory: `/state/${index + 1}`,
    }));
    const normal = renderLaunchPreflight(input({ entries, unreadableRuns: 0 }));
    const unreadable = renderLaunchPreflight(input({ entries, unreadableRuns: 2 }));
    const hits = 'run-interrupted-1 (reason-1 · /state/1), run-interrupted-2 (reason-2 · /state/2), run-interrupted-3 (reason-3 · /state/3), run-interrupted-4 (reason-4 · /state/4), run-interrupted-5 (reason-5 · /state/5)';
    expect(normal).toContain(`중단 런: 5건 조회 · 같은 경로 5건: ${hits}`);
    expect(unreadable).toContain(`중단 런: ⚠️ 5건 조회 · 2건 원장 판독 불가 · 같은 경로 5건: ${hits}`);
  });

  test('[producer-order-is-preserved] 여러 겹침은 원장 위치·runId 순서를 값에 남긴다', () => {
    const result = input({ entries: [
      { runId: 'run-z', plannedPaths: ['src/a.ts'], interruptionReason: 'z', ledgerDirectory: '/b' },
      { runId: 'run-b', plannedPaths: ['src/a.ts'], interruptionReason: 'b', ledgerDirectory: '/a' },
      { runId: 'run-a', plannedPaths: ['src/a.ts'], interruptionReason: 'a', ledgerDirectory: '/a' },
    ], unreadableRuns: 0 });
    expect(result.interruptedRunMatches.map((entry) => `${entry.ledgerDirectory}:${entry.runId}`)).toEqual(['/a:run-a', '/a:run-b', '/b:run-z']);
  });

  const match = (runId: string, interruptionReason: string | null): Parameters<typeof renderRepeatedInterruptionReasonNotice>[0][number] => ({
    runId, plannedPaths: ['src/a.ts'], interruptionReason, ledgerDirectory: '/state/run-ledger',
  });

  test('[repeated-reason-notice-output] 같은 사유 3건은 건수·짧은 사유·전체 건수를 한 줄에 낸다', () => {
    const notice = renderRepeatedInterruptionReasonNotice([
      match('run-1', 'gate failed'),
      match('run-2', 'gate failed'),
      match('run-3', 'gate failed'),
    ]);
    expect(notice).toBe('[preflight] 🔁 같은 사유 3건/3건 — gate failed');
    expect(notice!.length).toBeLessThanOrEqual(200);
  });

  test('[single-reason-is-silent] 같은 사유가 하나뿐이면 아무 말도 하지 않는다', () => {
    expect(renderRepeatedInterruptionReasonNotice([match('run-1', 'gate failed')])).toBeNull();
  });

  test('[missing-reason-is-not-grouped] 사유 없는 런은 같은 사유로 세지 않는다', () => {
    expect(renderRepeatedInterruptionReasonNotice([
      match('run-1', null),
      match('run-2', null),
      match('run-3', '   '),
      match('run-4', 'gate failed'),
    ])).toBeNull();
  });

  test('[long-reason-is-truncated] 긴 사유는 잘라 한 줄이 200자를 넘지 않는다', () => {
    const longReason = '이전 라운드에서 지적한 동일한 보존 위반이 반복되어 추가 리뷰 라운드로 수렴할 근거가 없다. '.repeat(8);
    const notice = renderRepeatedInterruptionReasonNotice([
      match('run-1', longReason),
      match('run-2', longReason),
    ]);
    expect(notice).not.toBeNull();
    expect(notice!.length).toBeLessThanOrEqual(200);
    expect(notice).toContain('같은 사유 2건/2건');
    expect(notice!.endsWith('…')).toBe(true);
    expect(notice).not.toContain(longReason);
  });

  test('[tie-and-plural-groups-are-deterministic] 복수 그룹·동률은 건수 우선·정규화 키 사전순이다', () => {
    const notice = renderRepeatedInterruptionReasonNotice([
      match('run-z', 'zeta wall'),
      match('run-z2', 'zeta wall'),
      match('run-a', 'alpha wall'),
      match('run-a2', 'alpha wall'),
      match('run-b', 'beta wall'),
    ]);
    expect(notice).toBe('[preflight] 🔁 같은 사유 2건/5건 — alpha wall');
  });

  test('[normalized-reasons-group-together] 기존 정규화가 같은 키면 한 그룹이다', () => {
    const notice = renderRepeatedInterruptionReasonNotice([
      match('run-1', 'Gate `Symbol99` failed 42'),
      match('run-2', 'GATE failed'),
    ]);
    expect(notice).toBe('[preflight] 🔁 같은 사유 2건/2건 — Gate `Symbol99` failed 42');
  });

  test('[repeated-reason-render-path] 같은 사유 3건은 기존 중단 런 줄 옆에 반복 한 줄을 낸다', () => {
    const result = input({ entries: [
      { runId: 'run-1', plannedPaths: ['src/a.ts'], interruptionReason: 'gate failed', ledgerDirectory: '/state/run-ledger' },
      { runId: 'run-2', plannedPaths: ['src/a.ts'], interruptionReason: 'gate failed', ledgerDirectory: '/state/run-ledger' },
      { runId: 'run-3', plannedPaths: ['src/a.ts'], interruptionReason: 'gate failed', ledgerDirectory: '/state/run-ledger' },
    ], unreadableRuns: 0 });
    const text = renderLaunchPreflight(result);
    const interruptedLine = '[preflight] 중단 런: 3건 조회 · 같은 경로 3건: run-1 (gate failed · /state/run-ledger), run-2 (gate failed · /state/run-ledger), run-3 (gate failed · /state/run-ledger)';
    expect(text).toContain(interruptedLine);
    const notice = '[preflight] 🔁 같은 사유 3건/3건 — gate failed';
    expect(text).toContain(notice);
    expect(notice.length).toBeLessThanOrEqual(200);
    const lines = text.split('\n');
    expect(lines.indexOf(notice)).toBe(lines.indexOf(interruptedLine) + 1);
  });

  test('[below-two-and-missing-reason-do-not-add-a-line] 2건 미만과 사유 없는 런은 새 줄을 만들지 않고 기존 줄을 글자 그대로 둔다', () => {
    const single = input({ entries: [
      { runId: 'run-interrupted', plannedPaths: ['src/a.ts'], interruptionReason: 'gate failed', ledgerDirectory: '/state/run-ledger' },
    ], unreadableRuns: 0 });
    const missing = input({ entries: [
      { runId: 'run-a', plannedPaths: ['src/a.ts'], interruptionReason: null, ledgerDirectory: '/state/run-ledger' },
      { runId: 'run-b', plannedPaths: ['src/a.ts'], interruptionReason: null, ledgerDirectory: '/state/run-ledger' },
    ], unreadableRuns: 0 });
    const singleText = renderLaunchPreflight(single);
    const missingText = renderLaunchPreflight(missing);
    expect(singleText).toContain('[preflight] 중단 런: 1건 조회 · 같은 경로 1건: run-interrupted (gate failed · /state/run-ledger)');
    expect(missingText).toContain('[preflight] 중단 런: 2건 조회 · 같은 경로 2건: run-a (사유 없음 · /state/run-ledger), run-b (사유 없음 · /state/run-ledger)');
    expect(singleText).not.toContain('같은 사유');
    expect(missingText).not.toContain('같은 사유');
    expect(singleText.split('\n').filter((line) => line.includes('[preflight] 🔁')).length).toBe(0);
    expect(missingText.split('\n').filter((line) => line.includes('[preflight] 🔁')).length).toBe(0);
  });
});

// ── 리뷰 must-fix 로 붙은 시험들 (2026-08-11 · #8153 리뷰) ──────────────────────
import {
  ASK_PROSE_TITLE_SEARCH_LINE_LIMIT,
  parseAskProseTitle,
  parseAskTargetPathHints,
  parseAskTargetPathHintsResult,
  parseBlockedChoice,
  planBlockedPrompt,
  countRepeatedBlocks,
  renderBlockedInspection,
  renderRepeatedBlockNotice,
  resolveInterruptedRunsLimit,
  resolveLiveRunWindowMinutes,
} from './launch-preflight.js';
import { buildAskPreflightDeps } from './ask-launch-io.js';
describe('buildAskPreflightDeps — 중단 런 원장 변환의 판독 불가 보존', () => {
  const interruptedRun = { runId: 'run-interrupted', interruptionReason: 'repeat', terminal: { timestamp: '2026-08-31T00:00:00.000Z' }, ledgerDirectory: '/state/ledger' };
  const lookup = () => ({ entries: [interruptedRun], unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0 });

  test('[missing-ledger-is-unreadable-not-checked-zero] 원장이 없으면 정상 무결과로 축약하지 않는다', async () => {
    const deps = await buildAskPreflightDeps({ interruptedRunLookup: lookup, loadRunLedger: () => null });
    expect(deps.listInterruptedRuns!(200)).toEqual({ entries: [], unreadableRuns: 1, observationFailures: { ledgerLoadThrows: 0, nullLedgers: 1, missingGoalFileNames: 0, unreadableOrMissingGoalDocuments: 0 } });
  });

  test('[missing-goal-file-is-unreadable-not-checked-zero] start/goalFile이 없으면 정상 무결과로 축약하지 않는다', async () => {
    const deps = await buildAskPreflightDeps({ interruptedRunLookup: lookup, loadRunLedger: () => [{ event: 'start', data: {} }] });
    expect(deps.listInterruptedRuns!(200)).toEqual({ entries: [], unreadableRuns: 1, observationFailures: { ledgerLoadThrows: 0, nullLedgers: 0, missingGoalFileNames: 1, unreadableOrMissingGoalDocuments: 0 } });
  });

  test('[goal-read-failure-is-unreadable-not-checked-zero] 목표 파일 읽기 실패는 판독 불가로 전달된다', async () => {
    const deps = await buildAskPreflightDeps({
      interruptedRunLookup: lookup,
      loadRunLedger: () => [{ event: 'start', data: { goalFile: '/goals/interrupted.md' } }],
      readGoalDocument: () => { throw new Error('EACCES'); },
    });
    expect(deps.listInterruptedRuns!(200)).toEqual({ entries: [], unreadableRuns: 1, observationFailures: { ledgerLoadThrows: 0, nullLedgers: 0, missingGoalFileNames: 0, unreadableOrMissingGoalDocuments: 1 } });
  });

  test('[goal-parse-failure-is-unreadable-not-checked-zero] 목표 파일 파싱 실패는 판독 불가로 전달된다', async () => {
    const deps = await buildAskPreflightDeps({
      interruptedRunLookup: lookup,
      loadRunLedger: () => [{ event: 'start', data: { goalFile: '/goals/interrupted.md' } }],
      readGoalDocument: () => 'goal',
      tracedPaths: () => { throw new Error('malformed goal'); },
    });
    expect(deps.listInterruptedRuns!(200)).toEqual({ entries: [], unreadableRuns: 1, observationFailures: { ledgerLoadThrows: 0, nullLedgers: 0, missingGoalFileNames: 0, unreadableOrMissingGoalDocuments: 1 } });
  });

  test('[converted-entry-reaches-nonblocking-preflight] 변환 성공 값은 preflight에 도달하고 중단 런은 발사를 막지 않는다', async () => {
    const deps = await buildAskPreflightDeps({
      interruptedRunLookup: lookup,
      loadRunLedger: () => [{ event: 'start', data: { goalFile: '/goals/interrupted.md' } }],
      readGoalDocument: () => 'goal',
      tracedPaths: () => ['src/a.ts'],
    });
    const result = evaluateLaunchPreflight({ paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], interruptedRuns: deps.listInterruptedRuns!(200), liveRunWindowMs: WINDOW, nowMs: Date.parse('2026-09-01T00:00:00.000Z') });
    expect(result.interruptedRunMatches).toEqual([{ runId: 'run-interrupted', plannedPaths: ['src/a.ts'], interruptionReason: 'repeat', terminatedAtMs: Date.parse('2026-08-31T00:00:00.000Z'), ledgerDirectory: '/state/ledger' }]);
    expect(result.priorIncompleteRuns).toEqual({ state: 'checked', count: 1 });
    expect(result.blockers).toEqual([]);
  });

  test('[default-lookup-real-ledger-terminal-timestamp-reaches-prior-incomplete-observation] 기본 lookup이 등록된 격리 원장의 종료 시각·대상 경로를 읽어 최근 미완주 관측으로 내며 발사를 막지 않는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-prior-incomplete-default-lookup-'));
    const stateRoot = join(root, 'test-state');
    const ledgerDirectory = join(stateRoot, 'run-ledger');
    const goalFile = join(root, 'interrupted-goal.md');
    const targetPath = 'src/a.ts';
    const otherPath = 'src/other.ts';
    const nowMs = Date.parse('2026-09-01T00:00:00.000Z');
    const terminalTimestamp = '2026-08-31T00:00:00.000Z';
    const runId = 'run-00000000-0000-4000-8000-000000000031';
    mkdirSync(ledgerDirectory, { recursive: true });
    mkdirSync(join(stateRoot, 'logs'), { recursive: true });
    mkdirSync(join(root, '.elanous', 'logs'), { recursive: true });
    writeFileSync(join(stateRoot, 'logs', 'logs.db'), 'fixture', 'utf8');
    writeFileSync(join(root, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [{ name: 'test:fixture', stateDir: stateRoot, kind: 'test', pid: process.pid, startedAt: terminalTimestamp }] }), 'utf8');
    writeFileSync(goalFile, `## TRACED PATHS\n- [code] ${targetPath} — target\n- [code] ${otherPath} — other\n`, 'utf8');
    writeFileSync(join(ledgerDirectory, `${runId}.jsonl`), [
      { timestamp: terminalTimestamp, runId, event: 'start', data: { goalFile } },
      { timestamp: terminalTimestamp, runId, event: 'rework-budget', data: { verdict: 'UNCONVERGEABLE', reason: 'fixture' } },
      { timestamp: terminalTimestamp, runId, event: 'run-status', data: { runStatus: 'failed' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
    const script = `
      const { buildAskPreflightDeps } = await import('./src/self-dev/ask-launch-io.ts');
      const { evaluateLaunchPreflight } = await import('./src/self-dev/launch-preflight.ts');
      const deps = await buildAskPreflightDeps();
      const interruptedRuns = deps.listInterruptedRuns(200);
      const input = { openPrs: [], unfinishedRuns: [], interruptedRuns, liveRunWindowMs: ${WINDOW}, nowMs: ${nowMs} };
      const matching = evaluateLaunchPreflight({ ...input, paths: [${JSON.stringify(targetPath)}] });
      const different = evaluateLaunchPreflight({ ...input, paths: ['src/unmatched.ts'] });
      console.log(JSON.stringify({ interruptedRuns, matching: { priorIncompleteRuns: matching.priorIncompleteRuns, blockers: matching.blockers }, different: different.priorIncompleteRuns }));
    `;
    try {
      const executed = spawnSync(process.execPath, ['-e', script], {
        cwd: resolve(import.meta.dir, '..', '..'),
        encoding: 'utf8',
        // 부모 셸의 config 위치가 자식 관측에 경고를 더하지 않도록 설정 축도 fixture 아래로 격리한다.
        env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'xdg-config'), ELANOUS_STATE_DIR: stateRoot },
      });
      // 종료 상태와 구조화된 결과가 기본 lookup의 기능 계약이다. 환경 경고의 문면은 계약이 아니다.
      expect(executed.status).toBe(0);
      expect(JSON.parse(executed.stdout)).toEqual({
        interruptedRuns: {
          entries: [{ runId, plannedPaths: [targetPath, otherPath], interruptionReason: 'fixture', terminatedAtMs: Date.parse(terminalTimestamp), ledgerDirectory }],
          unreadableRuns: 0,
          limit: 200,
        },
        matching: { priorIncompleteRuns: { state: 'checked', count: 1 }, blockers: [] },
        different: { state: 'checked', count: 0 },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('[federated-limit-rejects-invalid-boundaries] 연합 원장 생산자는 0·음수·소수 상한을 거부한다', () => {
    for (const limit of [0, -1, 1.5]) {
      expect(() => queryFederatedInterruptedRunLedgers({ targets: [], limit })).toThrow('positive safe integer');
    }
  });

  test('[federated-limit-reaches-decide] 실제 federated 상한은 어댑터를 거쳐 decideAskPreflight의 truncated 상태가 된다', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'preflight-interrupted-limit-'));
    const ledgerDirectory = join(stateRoot, 'run-ledger');
    const goalFile = join(stateRoot, 'interrupted-goal.md');
    mkdirSync(ledgerDirectory);
    writeFileSync(goalFile, 'goal');
    for (const suffix of ['001', '002']) {
      const runId = `run-00000000-0000-4000-8000-000000000${suffix}`;
      writeFileSync(join(ledgerDirectory, `${runId}.jsonl`), [
        JSON.stringify({ runId, event: 'start', data: { goalFile } }),
        JSON.stringify({ runId, event: 'rework-budget', data: { verdict: 'UNCONVERGEABLE', reason: `reason-${suffix}` } }),
        JSON.stringify({ runId, event: 'run-status', data: { runStatus: 'failed' } }),
      ].join('\n'));
    }
    try {
      const runtimeDeps = await buildAskPreflightDeps({
        interruptedRunLookup: (limit) => queryFederatedInterruptedRunLedgers({
          targets: [{ name: 'local', dbPath: join(stateRoot, 'mss', 'logs.db') }], limit,
        }),
        readGoalDocument: () => 'goal',
        tracedPaths: () => ['src/a.ts'],
      });
      const d = decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, interruptedRunsLimit: 1 }, {
        ...runtimeDeps,
        readGoalDocument: () => 'goal',
        tracedPaths: () => ['src/a.ts'],
        listOpenPrs: () => [],
        listUnfinishedRuns: () => [],
        listPreexistingFailureTestFiles: () => ({ state: 'checked', files: [] }),
      }, false);
      expect(d.result.interruptedRuns).toEqual({ state: 'truncated', count: 1, limit: 1 });
      expect(d.result.interruptedRunMatches).toEqual([expect.objectContaining({ interruptionReason: 'reason-001', ledgerDirectory })]);
      expect(d.shouldLaunch).toBe(true);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe('미완 런 전체 활동 집계 — 경로 충돌 판정과 분리', () => {
  test('[all-unfinished-runs-are-split-without-blocking] 비겹침 런도 나이로 1·1·1 분류하되 차단하지 않는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/target.ts'],
      openPrs: [],
      unfinishedRuns: [
        { runId: 'run-active', plannedPaths: ['src/unrelated-a.ts'], lastActivityAgeMs: WINDOW - 1 },
        { runId: 'run-inactive', plannedPaths: ['src/unrelated-b.ts'], lastActivityAgeMs: WINDOW },
        { runId: 'run-unreadable', plannedPaths: ['src/unrelated-c.ts'], lastActivityAgeMs: null },
      ],
      liveRunWindowMs: WINDOW,
    });

    expect(result.activeUnfinishedRuns).toEqual({ state: 'checked', count: 1 });
    expect(result.inactiveUnfinishedRuns).toEqual({ state: 'checked', count: 1 });
    expect(result.unreadableUnfinishedRunAges).toEqual({ state: 'checked', count: 1 });
    expect(result.blockers).toEqual([]);
    expect(result.liveRuns).toEqual({ state: 'checked', count: 3 });

    const text = renderLaunchPreflight(result);
    expect(text).toContain('그중 지금 도는 것 1건');
    expect(text).toContain('나이 판독 불가 1건');
  });

  test('[age-boundaries-classify-without-changing-blockers] 음수는 활성, 정확한 임계는 비활성, 비유한·누락은 판독 불가다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/target.ts'],
      openPrs: [],
      unfinishedRuns: [
        { runId: 'run-negative-active', plannedPaths: ['src/unrelated-a.ts'], lastActivityAgeMs: -1 },
        { runId: 'run-at-boundary-inactive', plannedPaths: ['src/unrelated-b.ts'], lastActivityAgeMs: WINDOW },
        { runId: 'run-infinite-unreadable', plannedPaths: ['src/unrelated-c.ts'], lastActivityAgeMs: Infinity },
        { runId: 'run-missing-unreadable', plannedPaths: ['src/unrelated-d.ts'] },
      ],
      liveRunWindowMs: WINDOW,
    });

    expect(result.activeUnfinishedRuns).toEqual({ state: 'checked', count: 1 });
    expect(result.inactiveUnfinishedRuns).toEqual({ state: 'checked', count: 1 });
    expect(result.unreadableUnfinishedRunAges).toEqual({ state: 'checked', count: 2 });
    expect(result.liveRuns).toEqual({ state: 'checked', count: 4 });
    expect(result.blockers).toEqual([]);
  });

  test('[unreadable-age-query-is-unknown-not-zero] 원장 조회 실패는 새 집계에도 0이 아닌 못 셌음으로 보인다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/target.ts'],
      openPrs: [],
      unfinishedRuns: null,
      unfinishedRunsUnknownReason: '원장 읽기 실패',
      liveRunWindowMs: WINDOW,
    });

    expect(result.activeUnfinishedRuns).toEqual({ state: 'unknown', reason: '원장 읽기 실패' });
    expect(result.inactiveUnfinishedRuns).toEqual({ state: 'unknown', reason: '원장 읽기 실패' });
    expect(result.unreadableUnfinishedRunAges).toEqual({ state: 'unknown', reason: '원장 읽기 실패' });
    expect(renderLaunchPreflight(result)).toContain('나이 판독 불가 ⚠️ 못 셌음 — 원장 읽기 실패');
  });
});

describe('evaluateLaunchPreflight — 「잴 것이 없었다」와 「부분 검사」', () => {
  test('[no-paths-blocks] 대상 경로가 0이면 그 자체가 막는 사유다 (METHOD v32)', () => {
    const result = evaluateLaunchPreflight({
      paths: [], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW,
    });
    expect(result.blockers.map((b) => b.kind)).toEqual(['no-target-paths']);
    expect(renderLaunchPreflight(result)).toContain('「검사했다」가 아니다');
  });

  // ⛔ 2026-09-23 — 라벨이 «있는데» 조각이 거부된 경우를 「라벨을 넣어라」로 뭉개지 않는다.
  test('[no-paths-rejected-fragments] 라벨은 있는데 거부됐으면 조각과 이유를 댄다 · 대조군: 거부 없으면 종전 문면', () => {
    const rejected = evaluateLaunchPreflight({
      paths: [], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW,
      askTargetPathRejections: [{ fragment: 'README.md — 설명이 같은 줄에 있다', reason: 'has-whitespace' }],
    });
    const detail = rejected.blockers.find((b) => b.kind === 'no-target-paths')?.detail ?? '';
    expect(detail).toContain('라벨은 있는데 조각 1개가 거부됐다');
    expect(detail).toContain('has-whitespace');
    expect(detail).toContain('«경로만»');
    expect(detail).not.toContain('넣어라');
    const plain = evaluateLaunchPreflight({ paths: [], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW });
    expect(plain.blockers.find((b) => b.kind === 'no-target-paths')?.detail).toContain('넣어라');
  });

  test('[no-paths-names-inspect-command] 대상 경로 0 안내가 발사 전 재는 명령을 같은 문장에서 댄다', () => {
    const result = evaluateLaunchPreflight({
      paths: [], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW,
    });
    const detail = result.blockers.find((blocker) => blocker.kind === 'no-target-paths')?.detail;
    expect(detail).toBe('골에서 대상 경로를 하나도 못 뽑았다 — ask 첫 줄에 「대상 경로: <파일> · <파일>」을 넣어라 — 이 상태의 「위반 0」은 「검사했다」가 아니다 — elanous self author --inspect-target-paths "<문면>"');
    expect(detail).toContain('elanous self author --inspect-target-paths "<문면>"');
    expect(detail).toContain('「위반 0」은 「검사했다」가 아니다');
    expect(detail).toContain('ask 첫 줄에 「대상 경로: <파일> · <파일>」');
    expect(result.blockers.find((blocker) => blocker.kind === 'no-target-paths')).toMatchObject({
      kind: 'no-target-paths', name: '(대상 경로 0)',
    });
  });

  test('[extracted-paths-omit-no-target-item] 대상 경로를 정상으로 뽑으면 그 항목이 막힌 목록에 없다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW,
    });
    expect(result.blockers.map((blocker) => blocker.kind)).not.toContain('no-target-paths');
    expect(renderLaunchPreflight(result)).not.toContain('elanous self author --inspect-target-paths "<문면>"');
  });

  test('[truncated-warns-not-blocks] 조회가 상한에 닿으면 미조회 사실과 상태를 보존해 경고한다', () => {
    const prs = Array.from({ length: 5 }, (_, i) => ({ number: i, title: 't', files: [{ path: 'x.ts' }] }));
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: prs, openPrsLimit: 5, unfinishedRuns: [], liveRunWindowMs: WINDOW,
    });
    expect(result.openPrs).toEqual({ state: 'truncated', count: 5, limit: 5 });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      kind: 'open-pr',
      name: '(열린 PR 조회 상한 5)',
      detail: expect.stringContaining('그 뒤를 «못 봤다»'),
    }));
    expect(renderLaunchPreflight(result)).toContain('「전부」가 아니다');
  });

  test('[unreadable-runs-counted] 못 읽은 런을 «조용히» 넘기지 않고 센다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'],
      openPrs: [],
      unfinishedRuns: [
        { runId: 'r1', plannedPaths: 'goal-document-not-found', lastActivityAgeMs: 10 },
        { runId: 'r2', plannedPaths: ['src/a.ts'], lastActivityAgeMs: null },
        { runId: 'r3', plannedPaths: ['src/b.ts'], lastActivityAgeMs: 10 },
      ],
      liveRunWindowMs: WINDOW,
    });
    expect(result.unreadableRuns).toBe(2);
    expect(result.blockers).toHaveLength(0);
    expect(renderLaunchPreflight(result)).toContain('이 검사는 «부분»이다');
  });
});

describe('실제 도는 런 확신 부록 — 나이 기반 기존 집계와 분리', () => {
  test('[optional-result-appendix-preserves-legacy-object-literals] 기존 결과 객체는 확신 부록 없이도 생성·렌더링된다', () => {
    const result: LaunchPreflightResult = {
      paths: [], missingDeclaredPathCount: 0, blockers: [], warnings: [], openPrs: { state: 'checked', count: 0 }, liveRuns: { state: 'checked', count: 0 },
      completedRuns: { state: 'checked', count: 0 }, completedRunMatches: [], interruptedRuns: { state: 'checked', count: 0 }, interruptedRunMatches: [], activeUnfinishedRuns: { state: 'checked', count: 0 },
      inactiveUnfinishedRuns: { state: 'checked', count: 0 }, unreadableUnfinishedRunAges: { state: 'checked', count: 0 },
      recentChanges: { state: 'checked', count: 0 }, preexistingFailures: { state: 'checked', files: [] }, recentChangeWindowDays: 7, unreadableRuns: 0, liveRunWindowMs: WINDOW,
    };
    expect(renderLaunchPreflight(result)).not.toContain('실제 도는 런 확신 판정');
  });

  const legacySuccess = '[preflight] 실제 도는 런 확신 판정: 확정 1건 · 추정 2건 (테스트 우주 포함) — 위 「그중 지금 도는 것」은 미완 런의 마지막 활동 나이 모집단, 이 줄은 PTY·원장을 교차한 판정 모집단이라 수가 달라도 정상이다';

  test('[all-zero-preserves-exact-legacy-success] 세 불능 축이 모두 0이면 옛 성공 문면을 글자 그대로 유지한다', () => {
    const calls: unknown[] = [];
    const appendix = renderRunningRunsConfidenceAppendix((options) => {
      calls.push(options);
      return confidenceRunningRuns(1, 2);
    });
    expect(calls).toEqual([{ includeTest: true }]);
    expect(appendix).toBe(legacySuccess);
  });

  test('[not-counted-live-pty-positive-is-separate] 살아 있는데 안 세어진 PTY 양수는 기존 항목 뒤에 별도로 표시한다', () => {
    const appendix = renderRunningRunsConfidenceAppendix(() => confidenceRunningRuns(1, 2, { notCountedRefCount: 2 }));
    expect(appendix).toBe('[preflight] 실제 도는 런 확신 판정: 판정된 것 중 확정 1건 · 추정 2건 · 살아 있는데 안 세어진 PTY 2개 (테스트 우주 포함) — 위 「그중 지금 도는 것」은 미완 런의 마지막 활동 나이 모집단, 이 줄은 PTY·원장을 교차한 판정 모집단이라 수가 달라도 정상이다');
    expect(appendix).not.toContain('\n');
  });

  test('[not-counted-live-pty-age-range] 고정 현재 시각에서 가장 최근과 가장 오래된 PTY 갱신의 경과 일수 범위를 함께 낸다', () => {
    const nowMs = 10 * 86_400_000;
    const appendix = renderRunningRunsConfidenceAppendix(() => confidenceRunningRuns(1, 2, {
      notCountedRefCount: 2,
      entries: [notCountedPtyEntry('recent', nowMs - 86_400_000), notCountedPtyEntry('oldest', nowMs - 5 * 86_400_000)],
    }), nowMs);
    expect(appendix).toContain('살아 있는데 안 세어진 PTY 2개 · 마지막 갱신 최근 1일 전~오래 5일 전');
    expect(appendix).not.toContain('\n');
  });

  test('[not-counted-live-pty-single-age] PTY 갱신 시각이 하나면 최근과 오래 경과 일수가 같다', () => {
    const nowMs = 10 * 86_400_000;
    const appendix = renderRunningRunsConfidenceAppendix(() => confidenceRunningRuns(1, 2, {
      notCountedRefCount: 1,
      entries: [notCountedPtyEntry('only', nowMs - 3 * 86_400_000)],
    }), nowMs);
    expect(appendix).toContain('마지막 갱신 최근 3일 전~오래 3일 전');
  });

  test('[not-counted-live-pty-null-age-preserves-count] 갱신 시각을 전혀 못 얻으면 기존 수량 문면만 유지한다', () => {
    const appendix = renderRunningRunsConfidenceAppendix(() => confidenceRunningRuns(1, 2, {
      notCountedRefCount: 2,
      entries: [notCountedPtyEntry('first', null), notCountedPtyEntry('second', null)],
    }), 10 * 86_400_000);
    expect(appendix).toContain('살아 있는데 안 세어진 PTY 2개');
    expect(appendix).not.toContain('마지막 갱신');
    expect(appendix).not.toContain('시각 알 수 없음');
  });

  test('[not-counted-live-pty-mixed-age-and-null] null 시각을 0일로 접지 않고 범위와 알 수 없음 수를 분리한다', () => {
    const nowMs = 10 * 86_400_000;
    const appendix = renderRunningRunsConfidenceAppendix(() => confidenceRunningRuns(1, 2, {
      notCountedRefCount: 2,
      entries: [notCountedPtyEntry('dated', nowMs - 2 * 86_400_000), notCountedPtyEntry('unknown-date', null)],
    }), nowMs);
    expect(appendix).toContain('마지막 갱신 최근 2일 전~오래 2일 전 · 시각 알 수 없음 1개');
    expect(appendix).not.toContain('최근 0일 전');
  });

  test('[not-counted-live-pty-zero-preserves-legacy-output] 살아 있는데 안 세어진 PTY가 0이면 기존 문면을 그대로 유지한다', () => {
    expect(renderRunningRunsConfidenceAppendix(() => confidenceRunningRuns(1, 2, { notCountedRefCount: 0 }))).toBe(legacySuccess);
  });

  test('[not-counted-live-pty-and-unknown-stay-separate] 살아 있는데 안 세어진 PTY와 판정 불능 런은 합치지 않고 각각 표시한다', () => {
    const appendix = renderRunningRunsConfidenceAppendix(() => confidenceRunningRuns(1, 2, { unknown: 5, notCountedRefCount: 3 }));
    expect(appendix).toContain('판정 불능 런 5건 · 살아 있는데 안 세어진 PTY 3개');
    expect(appendix).not.toContain('판정 불능 런 8건');
  });

  test.each([
    ['unknown-runs', confidenceRunningRuns(1, 2, { unknown: 3 }), '판정 불능 런 3건'],
    ['unreadable-pty-slots', confidenceRunningRuns(1, 2, { ptyUnreadable: ['/state/pty-a', '/state/pty-b'] }), 'PTY 판독 불가 2곳'],
  ])('[indeterminate-%s-preserves-judged-counts] 한 축의 부분 판정 불능도 판정된 확정·추정 수 뒤에 이름과 함께 낸다', (_name, running, axis) => {
    const appendix = renderRunningRunsConfidenceAppendix(() => running);
    expect(appendix).toContain('판정된 것 중 확정 1건 · 추정 2건');
    expect(appendix).toContain(axis);
    expect(appendix).not.toContain('확신 판정을 얻지 못했다');
  });

  test.each([
    ['unreadable-only', { unreadableLedgerCount: 2 }, '[preflight] 실제 도는 런 확신 판정: 판정된 것 중 확정 1건 · 추정 2건 · 원장 판정 불능 2건 (테스트 우주 포함) — 위 「그중 지금 도는 것」은 미완 런의 마지막 활동 나이 모집단, 이 줄은 PTY·원장을 교차한 판정 모집단이라 수가 달라도 정상이다', '원장을 가진 적 없는 우주'],
    ['missing-only', { missingLedgerDirectoryCount: 3 }, '[preflight] 실제 도는 런 확신 판정: 판정된 것 중 확정 1건 · 추정 2건 · 원장을 가진 적 없는 우주 3곳 (테스트 우주 포함) — 위 「그중 지금 도는 것」은 미완 런의 마지막 활동 나이 모집단, 이 줄은 PTY·원장을 교차한 판정 모집단이라 수가 달라도 정상이다', '원장 판정 불능'],
    ['both-nonzero', { unreadableLedgerCount: 2, missingLedgerDirectoryCount: 3 }, '[preflight] 실제 도는 런 확신 판정: 판정된 것 중 확정 1건 · 추정 2건 · 원장 판정 불능 2건 · 원장을 가진 적 없는 우주 3곳 (테스트 우주 포함) — 위 「그중 지금 도는 것」은 미완 런의 마지막 활동 나이 모집단, 이 줄은 PTY·원장을 교차한 판정 모집단이라 수가 달라도 정상이다', '원장 판독 불가 또는 불확정'],
    ['both-zero', {}, legacySuccess, '원장 판정 불능'],
  ] as const)('[indeterminate-ledger-%s-separates-unreadable-from-never-ledger-universes] 원장 판독 불능과 원장을 가진 적 없는 우주를 한 문장에서 분리하고 0 축은 생략한다', (_name, indeterminate, expected, absent) => {
    const appendix = renderRunningRunsConfidenceAppendix(() => confidenceRunningRuns(1, 2, indeterminate));
    expect(appendix).toBe(expected);
    expect(appendix).not.toContain(absent);
    expect(appendix).not.toContain('원장 판독 불가 또는 불확정');
  });

  test('[indeterminate-ledger-directory-rollup-is-not-double-counted] 원장 디렉터리 롤업과 구성요소는 새 두 축에 다시 더하지 않는다', () => {
    const appendix = renderRunningRunsConfidenceAppendix(() => confidenceRunningRuns(1, 2, {
      unreadableLedgerCount: 1,
      missingLedgerDirectoryCount: 3,
      unreadableLedgerDirectoryCount: 12,
      unreadableLedgerDirectoryAccessCount: 4,
      indeterminateLedgerDirectoryCount: 5,
    }));
    expect(appendix).toContain('원장 판정 불능 1건 · 원장을 가진 적 없는 우주 3곳');
    expect(appendix).not.toContain('원장 판정 불능 13건');
    expect(appendix).not.toContain('원장을 가진 적 없는 우주 15곳');
  });

  test('[indeterminate-ledger-directory-rollup-components-do-not-overflow] 디렉터리 롤업과 포함 구성요소는 합계 검증에서 다시 더하지 않는다', () => {
    const appendix = renderRunningRunsConfidenceAppendix(() => confidenceRunningRuns(1, 2, {
      unreadableLedgerDirectoryCount: Number.MAX_SAFE_INTEGER,
      missingLedgerDirectoryCount: 1,
      unreadableLedgerDirectoryAccessCount: 1,
      indeterminateLedgerDirectoryCount: 1,
    }));
    expect(appendix).toBe('[preflight] 실제 도는 런 확신 판정: 판정된 것 중 확정 1건 · 추정 2건 · 원장을 가진 적 없는 우주 1곳 (테스트 우주 포함) — 위 「그중 지금 도는 것」은 미완 런의 마지막 활동 나이 모집단, 이 줄은 PTY·원장을 교차한 판정 모집단이라 수가 달라도 정상이다');
    expect(appendix).not.toContain('확신 판정을 얻지 못했다');
  });

  test('[indeterminate-combined-axes-stay-separate] 복수 축은 단위를 합치지 않고 모두 별도 표시한다', () => {
    const appendix = renderRunningRunsConfidenceAppendix(() => confidenceRunningRuns(1, 2, {
      unknown: 3,
      ptyUnreadable: ['/state/pty-a', '/state/pty-b'],
      unreadableLedgerCount: 4,
    }));
    expect(appendix).toContain('판정된 것 중 확정 1건 · 추정 2건');
    expect(appendix).toContain('판정 불능 런 3건');
    expect(appendix).toContain('PTY 판독 불가 2곳');
    expect(appendix).toContain('원장 판정 불능 4건');
    expect(appendix).not.toContain('판정 불능 9건');
    expect(appendix).not.toContain('원장 판정 불능 4곳');
  });

  test.each([
    ['query throws', () => { throw new Error('pty unavailable'); }, 'pty unavailable'],
    ['invalid confirmed count', () => confidenceRunningRuns(-1, 2), '확신 판정 수가 유효하지 않다'],
    ['invalid probable count', () => confidenceRunningRuns(1, Number.NaN), '확신 판정 수가 유효하지 않다'],
  ])('[failure-%s-preserves-existing-warning] 질의 throw 또는 유효하지 않은 수의 진짜 실패는 기존 경고 문면을 유지한다', (_name, query, detail) => {
    const appendix = renderRunningRunsConfidenceAppendix(query);
    expect(appendix).toBe(`[preflight] ⚠️ 실제 도는 런 확신 판정을 얻지 못했다 (${detail}) — 위 나이 기반 집계는 그대로이며 이 경고는 발사를 막지 않는다`);
    expect(appendix).not.toContain('판정된 것 중');
  });

  const invalidCounts: readonly [string, (invalid: number) => RunningRunsResult, string][] = [
    ['unknown runs', (invalid) => confidenceRunningRuns(1, 2, { unknown: invalid }), '판정 불능 런'],
    ['unreadable ledger count', (invalid) => confidenceRunningRuns(1, 2, { unreadableLedgerCount: invalid }), 'unreadableLedgerCount'],
    ['unreadable ledger directory count', (invalid) => confidenceRunningRuns(1, 2, { unreadableLedgerDirectoryCount: invalid }), 'unreadableLedgerDirectoryCount'],
    ['missing ledger directory count', (invalid) => confidenceRunningRuns(1, 2, { missingLedgerDirectoryCount: invalid }), 'missingLedgerDirectoryCount'],
    ['unreadable ledger directory access count', (invalid) => confidenceRunningRuns(1, 2, { unreadableLedgerDirectoryAccessCount: invalid }), 'unreadableLedgerDirectoryAccessCount'],
    ['indeterminate ledger directory count', (invalid) => confidenceRunningRuns(1, 2, { indeterminateLedgerDirectoryCount: invalid }), 'indeterminateLedgerDirectoryCount'],
  ];

  test.each(invalidCounts.flatMap(([axis, running, detail]) => [
    [`${axis} negative`, running(-1), detail],
    [`${axis} NaN`, running(Number.NaN), detail],
    [`${axis} Infinity`, running(Number.POSITIVE_INFINITY), detail],
    [`${axis} fraction`, running(1.5), detail],
  ]))('[failure-invalid-indeterminate-%s-preserves-warning] 불능 축의 음수·NaN·Infinity·소수는 성공 문면으로 숨기지 않는다', (_name, running, detail) => {
    const appendix = renderRunningRunsConfidenceAppendix(() => running);
    expect(appendix).toContain(`확신 판정 수가 유효하지 않다 (${detail}:`);
    expect(appendix).not.toContain('판정된 것 중');
    expect(appendix).not.toBe(legacySuccess);
  });

  test('[failure-invalid-indeterminate-ledger-sum-overflow-preserves-warning] 원장 축 합계 safe-integer overflow는 성공 문면으로 숨기지 않는다', () => {
    const appendix = renderRunningRunsConfidenceAppendix(() => confidenceRunningRuns(1, 2, {
      unreadableLedgerCount: Number.MAX_SAFE_INTEGER,
      unreadableLedgerDirectoryCount: 1,
    }));
    expect(appendix).toContain('확신 판정 수가 유효하지 않다 (원장 판독 불가 또는 불확정 합계:');
    expect(appendix).not.toContain('판정된 것 중');
    expect(appendix).not.toBe(legacySuccess);
  });

  test('[failure-invalid-indeterminate-ledger-negative-cannot-cancel-positive] 음수 원장 값은 양수 원장 값과 상쇄해 성공 문면으로 숨기지 않는다', () => {
    const appendix = renderRunningRunsConfidenceAppendix(() => confidenceRunningRuns(1, 2, {
      unreadableLedgerCount: 1,
      unreadableLedgerDirectoryCount: -1,
    }));
    expect(appendix).toContain('확신 판정 수가 유효하지 않다 (unreadableLedgerDirectoryCount: -1)');
    expect(appendix).not.toBe(legacySuccess);
  });
});

describe('decideAskPreflight — CLI 배선', () => {
  const deps = (over: Partial<Parameters<typeof decideAskPreflight>[1]> = {}) => ({
    readGoalDocument: () => 'doc',
    tracedPaths: () => ['src/a.ts'],
    listOpenPrs: () => [],
    listUnfinishedRuns: () => [],
    listPreexistingFailureTestFiles: () => ({ state: 'checked' as const, files: [] }),
    ...over,
  });

  test('[confidence-wiring-decideAskPreflight-calls-renderRunningRunsConfidenceAppendix] ask-launch-flow가 호출하는 decideAskPreflight는 renderRunningRunsConfidenceAppendix를 통해 기존 나이 줄을 글자 그대로 보존하고 비차단 확신 부록을 바로 뒤에 잇는다', () => {
    const d = decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, deps({
      listUnfinishedRuns: () => [{ runId: 'legacy-active', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 1_000 }],
      queryRunningRuns: (options) => {
        expect(options).toEqual({ includeTest: true });
        return confidenceRunningRuns(0, 2);
      },
    }), false);
    const lines = renderLaunchPreflight(d.result).split('\n');
    expect(lines[2]).toBe('[preflight] 미완 런: 1건 조회 · 그중 지금 도는 것 1건 · 나이 판독 불가 0건 · 「도는 중」 임계 30분');
    expect(lines[3]).toContain('확정 0건 · 추정 2건');
    expect(d.shouldLaunch).toBe(true);
  });

  test.each([
    ['absent', undefined, 'absent', 0],
    ['clean', '대상 경로: src/self-dev/launch-preflight.ts\n불변식: src/self-dev/launch-preflight.ts 를 계속 쓴다.\n경계: 다른 파일은 대상이 아니다.\n판정 신호: 조건 = 단위; 관측 = bun test src/self-dev/launch-preflight.test.ts; 기대 = 통과\n판정 신호: 조건 = 실물; 관측 = rg -c evaluateLaunchPreflight src/self-dev/launch-preflight.ts; 기대 = 확인', 'present', 0],
    ['warning', '대상 경로: src/a.ts\n판정 신호: 산문으로만 적었다', 'present', 1],
  ] as const)('[ask-marker-observation-decide-render-%s] decideAskPreflight의 실제 ask 판정을 renderLaunchPreflight까지 전달해 한 건으로 남긴다', (_name, askText, askTextState, warningCount) => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const decision = decideAskPreflight({
        goalFile: 'g.md', askText, liveRunWindowMinutes: 30, recentChangeWindowDays: 7,
      }, deps(), false);
      const expected = decision.result.askMarkerObservation;
      expect(expected).toBeDefined();
      expect(expected).toMatchObject({ askText: askTextState });
      if (warningCount === 0) expect(expected!.warnings).toHaveLength(0);
      else expect(expected!.warnings.length).toBeGreaterThan(0);
      const rendered = renderLaunchPreflight(decision.result);
      const observations = log.mock.calls.filter((call) => call[0] === 'harness.preflight' && call[1] === 'ask-markers');
      expect(observations).toHaveLength(1);
      expect(observations[0]![2]).toEqual(expected);
      expect(decision.result.blockers).toEqual([]);
      expect(decision.shouldLaunch).toBe(true);
      if (warningCount > 0) expect(rendered).toContain('[preflight] ⚠️ ask 마커 — ⚠️ 판정 신호');
    } finally {
      log.mockRestore();
    }
  });

  test('[ask-marker-observation-distinguishes-actual-absent-from-clean] 실제 ask 부재와 실제 경고 없는 ask는 decideAskPreflight·renderLaunchPreflight 경로에서 다른 payload로 남는다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const absent = decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, deps(), false);
      renderLaunchPreflight(absent.result);
      const absentObservation = log.mock.calls.find((call) => call[0] === 'harness.preflight' && call[1] === 'ask-markers')?.[2];
      log.mockClear();
      const clean = decideAskPreflight({
        goalFile: 'g.md', askText: '대상 경로: src/self-dev/launch-preflight.ts\n불변식: src/self-dev/launch-preflight.ts 를 계속 쓴다.\n경계: 다른 파일은 대상이 아니다.\n판정 신호: 조건 = 단위; 관측 = bun test src/self-dev/launch-preflight.test.ts; 기대 = 통과\n판정 신호: 조건 = 실물; 관측 = rg -c evaluateLaunchPreflight src/self-dev/launch-preflight.ts; 기대 = 확인', liveRunWindowMinutes: 30, recentChangeWindowDays: 7,
      }, deps(), false);
      renderLaunchPreflight(clean.result);
      const cleanObservation = log.mock.calls.find((call) => call[0] === 'harness.preflight' && call[1] === 'ask-markers')?.[2];
      expect(absentObservation).toMatchObject({ askText: 'absent', warnings: [] });
      expect(cleanObservation).toMatchObject({ askText: 'present', warnings: [] });
      expect(cleanObservation).not.toEqual(absentObservation);
    } finally {
      log.mockRestore();
    }
  });

  test('[ask-marker-inspection-root-wiring] declaredPathsRoot가 있으면 두 ask-marker 축이 그 임시 대상 트리만 보고, 없으면 기존 저장소 래퍼로 폴백하며 어느 뿌리인지 산출에 남긴다', () => {
    const presentRoot = mkdtempSync(join(tmpdir(), 'preflight-ask-marker-present-'));
    const absentRoot = mkdtempSync(join(tmpdir(), 'preflight-ask-marker-absent-'));
    const askText = '대상 경로: src/new-value.ts\n불변식: src/new-value.ts 를 계속 쓴다.\n경계: src/ 를 고치지 않는다.\n판정 신호: 조건 = 소비자; 관측 = bun test src/new-value.ts; 기대 = 지금은 0건';
    try {
      mkdirSync(join(presentRoot, 'src'));
      mkdirSync(join(absentRoot, 'src'));
      writeFileSync(join(presentRoot, 'src/new-value.ts'), 'export {};');
      const options = { goalFile: 'g.md', askText, liveRunWindowMinutes: 30, recentChangeWindowDays: 7 };
      const present = decideAskPreflight({ ...options, declaredPathsRoot: presentRoot }, deps(), false);
      const absent = decideAskPreflight({ ...options, declaredPathsRoot: absentRoot }, deps(), false);
      const fallback = decideAskPreflight(options, deps(), false);

      expect(present.result.askMarkerObservation).toMatchObject({ inspectionRoot: presentRoot });
      expect(absent.result.askMarkerObservation).toMatchObject({ inspectionRoot: absentRoot });
      expect(present.result.askMarkerObservation!.warnings.some((warning) => warning.includes('판정 신호 시험 경로') || warning.includes('어디까지 사나'))).toBe(false);
      expect(absent.result.askMarkerObservation!.warnings).toContainEqual(expect.stringContaining('판정 신호 시험 경로'));
      expect(absent.result.askMarkerObservation!.warnings).toContainEqual(expect.stringContaining('어디까지 사나'));
      expect(renderLaunchPreflight(present.result)).toContain(`[preflight] ask 마커 검사 뿌리: ${presentRoot}`);
      expect(renderLaunchPreflight(absent.result)).toContain(`[preflight] ask 마커 검사 뿌리: ${absentRoot}`);
      expect(fallback.result.askMarkerObservation!.inspectionRoot).toBe(process.cwd());
      expect(fallback.result.askMarkerObservation!.warnings).toContainEqual(expect.stringContaining('판정 신호 시험 경로'));
      expect(fallback.result.askMarkerObservation!.warnings).toContainEqual(expect.stringContaining('어디까지 사나'));
      expect(fallback.result.askMarkerObservation!.warnings).not.toEqual(present.result.askMarkerObservation!.warnings);
      expect(renderLaunchPreflight(fallback.result)).toContain(`[preflight] ask 마커 검사 뿌리: ${process.cwd()}`);
      expect(present.result.blockers).toEqual([]);
      expect(absent.result.blockers).toEqual([]);
      expect(present.shouldLaunch).toBe(true);
      expect(absent.shouldLaunch).toBe(true);
    } finally {
      rmSync(presentRoot, { recursive: true, force: true });
      rmSync(absentRoot, { recursive: true, force: true });
    }
  });

  test('[unpressed-decision-signals-warn-without-blocking] 안 눌릴 신호는 inspectionRoot 유무와 무관하게 경고로 남고 발사를 막지 않으며 기존 ask-marker 경고를 잃지 않는다', () => {
    const askText = [
      '대상 경로: src/self-dev/launch-preflight.ts',
      '판정 신호: 조건 = 경로; 관측 = bun test missing/oauth/codex-account-rotation.test.ts; 기대 = 경고',
      '판정 신호: 조건 = 기판; 관측 = 그 기판으로 자식을 하나 돌려 main-tree-reject 0 을 보여라; 기대 = 0',
    ].join('\n');
    const options = { goalFile: 'g.md', askText, liveRunWindowMinutes: 30, recentChangeWindowDays: 7 };
    const withoutRoot = decideAskPreflight(options, deps(), false);
    const withRoot = decideAskPreflight({ ...options, declaredPathsRoot: process.cwd() }, deps(), false);

    for (const decision of [withoutRoot, withRoot]) {
      const unpressed = decision.result.askMarkerObservation!.warnings.filter((warning) => warning.includes('안 눌릴 신호'));
      expect(unpressed.length).toBeGreaterThan(0);
      expect(unpressed.some((warning) => warning.startsWith('⚠️') || warning.startsWith('❌'))).toBe(true);
      expect(decision.result.askMarkerObservation!.warnings.some((warning) => warning.includes('판정 신호 시험 경로'))).toBe(true);
      expect(decision.result.warnings.filter((warning) => warning.kind === 'ask-marker').map((warning) => warning.detail)).toEqual(
        [...decision.result.askMarkerObservation!.warnings],
      );
      expect(decision.result.blockers).toEqual([]);
      expect(decision.shouldLaunch).toBe(true);
      expect(renderLaunchPreflight(decision.result)).toContain('안 눌릴 신호');
    }
  });

  test('[unpressed-decision-signal-inspection-failure-is-a-warning-not-silence] 안 눌릴 신호 검사가 던져도 전제 검사는 끝까지 나고 실패 경고가 「경고 없음」으로 접히지 않으며 기존 경고와 발사를 보존한다', () => {
    const decision = decideAskPreflight({
      goalFile: 'g.md',
      askText: '대상 경로: src/a.ts\n판정 신호: 산문으로만 적었다',
      liveRunWindowMinutes: 30,
      recentChangeWindowDays: 7,
    }, deps({
      inspectUnpressedDecisionSignals: () => { throw new Error('first line\nsecond line'); },
    }), false);
    const failure = decision.result.askMarkerObservation!.warnings.find((warning) => warning.includes('검사 실패'));

    expect(failure).toBe('⚠️ ask 마커 — 안 눌릴 신호 검사 실패: first line');
    expect(failure).not.toContain('second line');
    expect(decision.result.askMarkerObservation!.warnings.some((warning) => warning.includes('판정 신호'))).toBe(true);
    expect(decision.result.warnings.filter((warning) => warning.kind === 'ask-marker').map((warning) => warning.detail)).toEqual(
      [...decision.result.askMarkerObservation!.warnings],
    );
    expect(decision.result.blockers).toEqual([]);
    expect(decision.shouldLaunch).toBe(true);
    expect(renderLaunchPreflight(decision.result)).toContain('안 눌릴 신호 검사 실패: first line');
  });

  test('[unpressed-decision-signal-non-error-multiline-failure-uses-first-line] 문자 예외도 첫 줄만 경고에 넣고 둘째 줄은 제외하며 나머지 전제 검사와 발사를 보존한다', () => {
    const decision = decideAskPreflight({
      goalFile: 'g.md',
      askText: '대상 경로: src/a.ts\n판정 신호: 산문으로만 적었다',
      liveRunWindowMinutes: 30,
      recentChangeWindowDays: 7,
    }, deps({
      inspectUnpressedDecisionSignals: () => { throw 'first line\nsecond line'; },
    }), false);
    const failure = decision.result.askMarkerObservation!.warnings.find((warning) => warning.includes('검사 실패'));

    expect(failure).toBe('⚠️ ask 마커 — 안 눌릴 신호 검사 실패: first line');
    expect(failure).not.toContain('second line');
    expect(decision.result.askMarkerObservation!.warnings.some((warning) => warning.includes('판정 신호'))).toBe(true);
    expect(decision.result.warnings.filter((warning) => warning.kind === 'ask-marker').map((warning) => warning.detail)).toEqual(
      [...decision.result.askMarkerObservation!.warnings],
    );
    expect(decision.result.blockers).toEqual([]);
    expect(decision.shouldLaunch).toBe(true);
    expect(renderLaunchPreflight(decision.result)).toContain('안 눌릴 신호 검사 실패: first line');
    expect(renderLaunchPreflight(decision.result)).not.toContain('second line');
  });

  test('[ask-marker-logger-failure-is-nonblocking] ask 마커 관측 logger가 던져도 evaluate·render 실행 경로와 사람이 읽는 경고는 끝까지 보존된다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => { throw new Error('logger unavailable'); });
    try {
      const evaluated = evaluateLaunchPreflight({
        paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW,
        askMarkerObservation: { askText: 'present', axes: [], warnings: ['⚠️ 판정 신호 — 산문으로만 적었다'] },
      });
      expect(evaluated.blockers).toEqual([]);
      const d = decideAskPreflight({
        goalFile: 'g.md', askText: `대상 경로: src/a.ts
판정 신호: 산문으로만 적었다`, liveRunWindowMinutes: 30, recentChangeWindowDays: 7,
      }, deps(), false);
      expect(renderLaunchPreflight(d.result)).toContain('[preflight] ⚠️ ask 마커 — ⚠️ 판정 신호');
      expect(d.result.blockers).toEqual([]);
      expect(d.shouldLaunch).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test('[confidence-observation-persists-counts-with-cross-assessment-population] 확정·추정·판정 불능 수와 PTY·원장 교차 모집단을 구조화 관측으로 남기면서 화면과 발사 판정을 보존한다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const d = decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, deps({
        queryRunningRuns: () => confidenceRunningRuns(2, 4, { unknown: 184 }),
      }), false);
      expect(log).toHaveBeenCalledWith('harness.preflight', 'running-runs-confidence', {
        assessment: 'available',
        confirmedCount: 2,
        probableCount: 4,
        unknownCount: 184,
        population: 'PTY and ledger cross-assessed runs',
        crossAssessment: 'PTY·ledger',
        includesTest: true,
        appendix: expect.stringContaining('확정 2건 · 추정 4건 · 판정 불능 런 184건'),
      });
      expect(renderLaunchPreflight(d.result)).toContain('확정 2건 · 추정 4건 · 판정 불능 런 184건');
      expect(d.result.blockers).toEqual([]);
      expect(d.shouldLaunch).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test('[confidence-unavailable-observation-does-not-substitute-zero-or-block] 확신 판정 실패는 unavailable 관측을 남기고 0으로 접지 않으며 기존 경고 문면과 발사 판정을 보존한다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const d = decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, deps({
        queryRunningRuns: () => { throw new Error('ledger unavailable'); },
      }), false);
      expect(log).toHaveBeenCalledWith('harness.preflight', 'running-runs-confidence', {
        assessment: 'unavailable',
        failure: 'ledger unavailable',
        population: 'PTY and ledger cross-assessed runs',
        crossAssessment: 'PTY·ledger',
        includesTest: true,
        appendix: expect.stringContaining('얻지 못했다 (ledger unavailable)'),
      });
      const lines = renderLaunchPreflight(d.result).split('\n');
      expect(lines.filter((line) => line.includes('확신 판정')).length).toBe(1);
      expect(lines.find((line) => line.includes('확신 판정'))).toContain('얻지 못했다 (ledger unavailable)');
      expect(d.result.blockers).toEqual([]);
      expect(d.shouldLaunch).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test.each([
    ['string', 'first\nsecond'],
    ['object', { toString: () => 'first\u2028second\u2029third\rfourth\u0085fifth' }],
    ['throwing toString', { toString: () => { throw new Error('nested failure'); } }],
  ])('[confidence-non-error-failure-is-one-line-and-nonblocking] %s 예외도 한 줄 fallback만 내고 발사를 막지 않는다', (_name, thrown) => {
    const d = decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, deps({
      queryRunningRuns: () => { throw thrown; },
    }), false);
    const rendered = renderLaunchPreflight(d.result);
    const appendix = d.result.runningRunsConfidenceAppendix;
    expect(appendix).toBeDefined();
    if (appendix === undefined) throw new Error('확신 부록이 없다');
    expect(appendix).not.toMatch(/[\r\n\u0085\u2028\u2029]/u);
    expect(rendered.split('\n')).toHaveLength(11);
    expect(rendered.split('\n').filter((line) => line.includes('확신 판정'))).toEqual([appendix]);
    expect(appendix).not.toContain('확정 ');
    expect(d.result.blockers).toEqual([]);
    expect(d.shouldLaunch).toBe(true);
  });

  test('[open-pr-warns-and-launches] 열린 PR 겹침은 경고로 남기고 발사한다', () => {
    const d = decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, deps({
      listOpenPrs: () => [{ number: 9, title: 't', files: [{ path: 'src/a.ts' }] }],
    }), false);
    expect(d.result.blockers).toEqual([]);
    expect(d.result.warnings.map((warning) => warning.name)).toEqual(['#9']);
    expect(d.shouldLaunch).toBe(true);
  });

  test('[force-bypasses] 강제하면 대상 경로 0 막힘에서도 발사한다', () => {
    const d = decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, deps({
      tracedPaths: () => [],
    }), true);
    expect(d.result.blockers.map((blocker) => blocker.kind)).toEqual(['no-target-paths']);
    expect(d.shouldLaunch).toBe(true);
  });

  test('[default-queryRunningRuns-path-is-used] queryRunningRuns를 주입하지 않으면 격리 상태에서 기본 구현을 호출해 확신 부록을 만든다', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-default-running-runs-'));
    const script = `
      const { decideAskPreflight } = await import('./src/self-dev/launch-preflight.ts');
      const decision = decideAskPreflight(
        { goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 },
        { readGoalDocument: () => 'doc', tracedPaths: () => ['src/a.ts'], listOpenPrs: () => [], listUnfinishedRuns: () => [] },
        false,
      );
      console.log(JSON.stringify({ shouldLaunch: decision.shouldLaunch, appendix: decision.result.runningRunsConfidenceAppendix }));
    `;
    try {
      const executed = spawnSync('bun', ['-e', script], {
        cwd: resolve(import.meta.dir, '..', '..'),
        encoding: 'utf8',
        env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'xdg-config'), ELANOUS_STATE_DIR: join(root, 'state') },
      });
      expect(executed.status).toBe(0);
      const result = JSON.parse(executed.stdout) as { shouldLaunch: boolean; appendix: string | undefined };
      expect(result.shouldLaunch).toBe(true);
      expect(result.appendix).toMatch(/^\[preflight\] (?:실제 도는 런 확신 판정:|⚠️ 실제 도는 런 확신 판정을 얻지 못했다)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('[interrupted-query-wires-through] 주입된 종료 중단 런 조회는 경로 겹침 값으로 도달하고 발사를 막지 않는다', () => {
    const d = decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, deps({
      listInterruptedRuns: () => ({ entries: [{ runId: 'run-interrupted', plannedPaths: ['src/a.ts'], interruptionReason: 'repeat', ledgerDirectory: '/state/run-ledger' }], unreadableRuns: 0 }),
    }), false);
    expect(d.result.interruptedRunMatches).toEqual([{ runId: 'run-interrupted', plannedPaths: ['src/a.ts'], interruptionReason: 'repeat', ledgerDirectory: '/state/run-ledger' }]);
    expect(d.shouldLaunch).toBe(true);
  });

  test('[interrupted-cause-counters-reach-runtime-render] 채워진 원장·goalFile·골 문서 원인 계수는 decideAskPreflight 런타임 경로의 중단 런 줄에서 구분된다', () => {
    const d = decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, deps({
      listInterruptedRuns: () => ({
        entries: [],
        unreadableRuns: 6,
        observationFailures: {
          ledgerLoadThrows: 1,
          nullLedgers: 2,
          missingGoalFileNames: 1,
          unreadableOrMissingGoalDocuments: 2,
        },
      }),
    }), false);
    const line = renderLaunchPreflight(d.result).split('\n').find((candidate) => candidate.includes('중단 런:'));

    expect(d.result.interruptedRuns).toEqual({
      state: 'unreadableRuns',
      count: 0,
      unreadableRuns: 6,
      missingGoalDocuments: 2,
      observationFailures: {
        ledgerLoadThrows: 1,
        nullLedgers: 2,
        missingGoalFileNames: 1,
        unreadableOrMissingGoalDocuments: 2,
      },
    });
    expect(line).toBe('[preflight] 중단 런: ⚠️ 0건 조회 · 6건 원장 판독 불가 (원장 로드 예외 1건 · null 원장 2건 · goalFile 이름 없음 1건 · 골 문서 사라짐 2건) · 같은 경로 0건');
    expect(d.result.interruptedRuns).toMatchObject({ missingGoalDocuments: 2 });
    expect(d.shouldLaunch).toBe(true);
  });

  test('[query-throw-is-unknown] 조회가 던지면 «미지»이고 발사를 막지 않는다', () => {
    const d = decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, deps({
      listOpenPrs: () => { throw new Error('gh rc=1'); },
    }), false);
    expect(d.result.openPrs.state).toBe('unknown');
    expect(d.shouldLaunch).toBe(true);
  });

  test('[no-paths-stops-even-when-clean] 경로 0이면 조회가 깨끗해도 안 쏜다', () => {
    const d = decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, deps({
      tracedPaths: () => [],
    }), false);
    expect(d.shouldLaunch).toBe(false);
  });

  test('[post-authoring-union-warns-and-preserves-roles] 선언 전용 대상 겹침도 경고로 통과하고 기존 대상·근거 표식을 유지한다', () => {
    const d = decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }, deps({
      tracedPaths: () => ['src/evidence.ts', 'src/shared.ts'],
      askTargetPaths: () => ['src/declared.ts', 'src/shared.ts'],
      listUnfinishedRuns: () => [{
        runId: 'run-overlap',
        plannedPaths: ['src/declared.ts', 'src/evidence.ts', 'src/shared.ts'],
        lastActivityAgeMs: 1,
      }],
    }), false);
    expect(d.result.paths).toEqual(['src/evidence.ts', 'src/shared.ts', 'src/declared.ts']);
    expect(d.result.blockers).toHaveLength(0);
    const liveRunWarning = d.result.warnings.find((warning) => warning.kind === 'live-run');
    expect(d.shouldLaunch).toBe(true);
    expect(liveRunWarning!.overlapPaths).toEqual([
      { path: 'src/declared.ts', role: 'target', worktreeTouch: { state: 'worktree-unknown', uncommitted: null, committed: null } },
      { path: 'src/evidence.ts', role: 'evidence', worktreeTouch: { state: 'worktree-unknown', uncommitted: null, committed: null } },
      { path: 'src/shared.ts', role: 'target', worktreeTouch: { state: 'worktree-unknown', uncommitted: null, committed: null } },
    ]);
    expect(liveRunWarning!.detail).toContain('src/declared.ts(대상 · 실제 worktree-unknown)');
    expect(liveRunWarning!.detail).toContain('src/evidence.ts(근거 · 실제 worktree-unknown)');
    expect(liveRunWarning!.detail).toContain('src/shared.ts(대상 · 실제 worktree-unknown)');
  });
});

describe('resolveInterruptedRunsLimit — 중단 런 조회 상한', () => {
  test('[default-and-valid-boundary] 생략은 기본값, 양의 안전 정수는 그대로 쓴다', () => {
    expect(resolveInterruptedRunsLimit(undefined)).toBe(200);
    expect(resolveInterruptedRunsLimit(1)).toBe(1);
  });

  for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    test(`[rejects-${String(bad)}] 0·음수·소수·안전 범위 밖 값은 거부한다`, () => {
      expect(() => resolveInterruptedRunsLimit(bad)).toThrow('interruptedRunsLimit');
    });
  }

  test('[decision-rejects-before-query] 발사 경계는 잘못된 상한으로 원장 조회를 시작하지 않는다', () => {
    let queried = false;
    expect(() => decideAskPreflight({ goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, interruptedRunsLimit: 0 }, {
      readGoalDocument: () => 'doc', tracedPaths: () => ['src/a.ts'], listOpenPrs: () => [], listUnfinishedRuns: () => [],
      listInterruptedRuns: () => { queried = true; return { entries: [], unreadableRuns: 0 }; },
    }, false)).toThrow('interruptedRunsLimit');
    expect(queried).toBe(false);
  });
});

describe('resolveLiveRunWindowMinutes — 잘못된 값은 «조용히» 안 고친다', () => {
  test('[default-when-absent] 안 주면 기본값', () => {
    expect(resolveLiveRunWindowMinutes(undefined)).toBe(30);
  });
  test('[valid-passes] 양의 정수는 그대로', () => {
    expect(resolveLiveRunWindowMinutes(5)).toBe(5);
  });
  for (const bad of [0, -1, 1.5, 'abc', Number.NaN]) {
    test(`[rejects-${String(bad)}] 잘못된 값은 거부한다`, () => {
      expect(() => resolveLiveRunWindowMinutes(bad)).toThrow('--live-run-window');
    });
  }
});

// ── 둘째 라운드 must-fix (2026-08-11 · #8153 리뷰) ────────────────────────────
// ⛔ 핵심: 검증기가 «실행 경로»에 있는가. Commander 변환기가 값을 먼저 깎으면 검증은 무효다.


// ── 셋째 라운드 must-fix (2026-08-11 · #8153 리뷰) ────────────────────────────
describe('resolveLiveRunWindowMinutes — 공백과 «안전 정수»', () => {
  test('[no-silent-trim] 공백이 붙은 값을 조용히 받지 않는다', () => {
    for (const raw of [' 5', '5 ', ' 5 ', '\t5']) {
      expect(() => resolveLiveRunWindowMinutes(raw)).toThrow('--live-run-window');
    }
  });

  test('[safe-integer-only] 안전 정수를 넘는 큰 값을 거부한다', () => {
    expect(() => resolveLiveRunWindowMinutes('99999999999999999999')).toThrow('--live-run-window');
    expect(() => resolveLiveRunWindowMinutes(Number.MAX_SAFE_INTEGER + 2)).toThrow('--live-run-window');
    // ⛔ 안전 정수여도 «상한(7일)»을 넘으면 거부한다 — 다섯째 라운드에서 상한이 생겼다.
    expect(() => resolveLiveRunWindowMinutes(String(Number.MAX_SAFE_INTEGER))).toThrow();
  });
});


// ── 넷째 라운드 must-fix (2026-08-11 · #8153 리뷰) ────────────────────────────
import { prepareAskLaunch, toPreflightUnfinishedRun } from './launch-preflight.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

// ⭐ 73차 — 충돌 문면이 경로마다 「대상」인지 「근거」인지를 «말한다».
//   📏 왜: `## TRACED PATHS` 는 「바꿀 파일」과 「근거로 읽은 파일」을 섞는다(한 골이 TRACED 8 · 변경 3).
//     ⇒ `[T]` 가 「근거로만 언급한」 경로 때문에 막혔고, 문면만으로는 그것을 알 수 없었다.
//   ⛔ 판정은 «안 바꾼다» — 놓치는 것보다 낫다. 문면만 는다.
describe('충돌 문면이 「대상/근거」를 말한다', () => {
  const base = {
    paths: ['src/a.ts', 'src/b.ts'],
    openPrs: [] as never[],
    unfinishedRuns: [{ runId: 'run-x', plannedPaths: ['src/a.ts', 'src/b.ts'], lastActivityAgeMs: 1000 }],
    liveRunWindowMs: 60_000,
  };

  test('askTargetPaths 를 주면 경고 문면에 경로마다 표시가 붙는다', () => {
    const result = evaluateLaunchPreflight({ ...base, askTargetPaths: ['src/a.ts'] } as never);
    const detail = result.warnings.map((warning) => warning.detail).join(' ');
    expect(result.blockers).toEqual([]);
    expect(detail).toContain('src/a.ts(대상)');
    expect(detail).toContain('src/b.ts(근거)');
  });

  test('역할을 가를 입력이 없으면 경고로 통과하고 표시는 지어내지 않는다', () => {
    const result = evaluateLaunchPreflight(base as never);
    const detail = result.warnings.map((warning) => warning.detail).join(' ');
    expect(result.blockers).toEqual([]);
    expect(detail).toContain('src/a.ts, src/b.ts');
    expect(detail).not.toContain('(대상)');
    expect(detail).not.toContain('(근거)');
    expect(result.warnings[0]!.overlapPaths).toBeUndefined();
    expect(result.warnings[0]!.allOverlapPathsAreEvidence).toBeUndefined();
  });

  test('대상으로 겹쳐도 경고로 통과하고 관측은 대상 역할과 근거만 아님을 낸다', () => {
    const result = evaluateLaunchPreflight({ ...base, askTargetPaths: ['src/a.ts', 'src/b.ts'] } as never);
    expect(result.blockers).toEqual([]);
    expect(result.warnings[0]!.overlapPaths).toEqual([
      { path: 'src/a.ts', role: 'target' },
      { path: 'src/b.ts', role: 'target' },
    ]);
    expect(result.warnings[0]!.allOverlapPathsAreEvidence).toBe(false);
  });

  test('근거로만 겹치면 막지 않고 경고·문면에 런과 경로를 남긴다', () => {
    const result = evaluateLaunchPreflight({ ...base, askTargetPaths: ['src/other.ts'] } as never);
    expect(result.blockers).toHaveLength(0);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      kind: 'live-run',
      name: 'run-x',
      overlapPaths: [
        { path: 'src/a.ts', role: 'evidence' },
        { path: 'src/b.ts', role: 'evidence' },
      ],
      allOverlapPathsAreEvidence: true,
    }));
    const text = renderLaunchPreflight(result);
    expect(text).toContain('run-x — 도는 런이 같은 파일을 만진다: src/a.ts(근거), src/b.ts(근거)');
    expect(text).toContain('막는 것 없음');
  });

  test('대상과 근거가 섞여도 경고로 통과하고 관측은 두 역할과 근거만 아님을 낸다', () => {
    const result = evaluateLaunchPreflight({ ...base, askTargetPaths: ['src/a.ts'] } as never);
    const liveRunWarning = result.warnings.find((warning) => warning.kind === 'live-run');
    expect(result.blockers).toEqual([]);
    expect(liveRunWarning!.overlapPaths).toEqual([
      { path: 'src/a.ts', role: 'target' },
      { path: 'src/b.ts', role: 'evidence' },
    ]);
    expect(liveRunWarning!.allOverlapPathsAreEvidence).toBe(false);
  });
});

describe('toPreflightUnfinishedRun — 원장 엔트리 «형태»를 숨기지 않는다', () => {
  test('[real-shape-array] 실제 엔트리 대표값(경로 배열)이 그대로 매핑된다', () => {
    const mapped = toPreflightUnfinishedRun({
      runId: 'run-1f9a6b78-62a2-4197-849d-7d1e8f2302e3',
      branch: 'self-impl/x',
      status: 'terminal-status-missing',
      plannedPaths: ['src/index.ts', 'src/index.test.ts'],
      lastActivityAgeMs: 20846744,
      lifecycle: 'human-stopped',
      ledgerDirectory: '/Users/x/.elanous-test/run-ledger',
    });
    expect(mapped).not.toBeNull();
    expect(mapped!.plannedPaths).toEqual(['src/index.ts', 'src/index.test.ts']);
    expect(mapped!.lastActivityAgeMs).toBe(20846744);
    expect(mapped!.lifecycle).toBe('human-stopped');
    expect(mapped!.ledgerDirectory).toBe('/Users/x/.elanous-test/run-ledger');
  });

  test('[real-shape-reason] 경로를 못 읽은 엔트리는 사유 문자열로 남는다', () => {
    const mapped = toPreflightUnfinishedRun({ runId: 'run-x', plannedPaths: 'goal-document-not-found' });
    expect(mapped!.plannedPaths).toBe('goal-document-not-found');
    expect(mapped!.lastActivityAgeMs).toBeNull();
  });

  test('[garbage-dropped] runId 없는 것은 버린다(형태 불일치를 조용히 통과시키지 않는다)', () => {
    expect(toPreflightUnfinishedRun({ plannedPaths: ['a'] })).toBeNull();
    expect(toPreflightUnfinishedRun(null)).toBeNull();
    expect(toPreflightUnfinishedRun('x')).toBeNull();
  });

  test('[mapped-entry-warns] 매핑된 실제 형태로 경고까지 간다', () => {
    const mapped = toPreflightUnfinishedRun({
      runId: 'run-live', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 60_000,
    })!;
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [mapped], liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((warning) => warning.name)).toEqual(['run-live']);
  });

  test('[terminal-lifecycles-do-not-block] 종료 수명주기는 젊은 겹침이어도 나이 판정 전에 제외한다', () => {
    const terminatedRuns = (['human-stopped', 'terminal-other-vocabulary', 'terminal-run-status-superseded'] as const).map((lifecycle) =>
      toPreflightUnfinishedRun({
        runId: `run-${lifecycle}`,
        plannedPaths: ['src/a.ts'],
        lastActivityAgeMs: lifecycle === 'terminal-run-status-superseded' ? 395_000 : 60_000,
        lifecycle,
      })!,
    );
    const liveRun = toPreflightUnfinishedRun({
      runId: 'run-live', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 60_000, lifecycle: 'live',
    })!;
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [...terminatedRuns, liveRun], liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toHaveLength(0);
    expect(result.activeUnfinishedRuns).toEqual({ state: 'checked', count: 1 });
    expect(result.warnings.map((warning) => warning.name)).toEqual(['run-live']);
    expect(result.warnings.map((warning) => warning.kind)).toEqual(['live-run']);
  });

  test('[terminal-lifecycle-pairs-only-lifecycle-changes-live-run-warning] 같은 runId·경로·나이에서 수명주기만 바꾸면 live만 live-run 경고를 낸다', () => {
    const base = {
      runId: 'run-lifecycle-pair',
      plannedPaths: ['src/a.ts'],
      lastActivityAgeMs: 395_000,
    };
    const evaluate = (lifecycle: 'live' | 'human-stopped' | 'terminal-other-vocabulary' | 'terminal-run-status-superseded') =>
      evaluateLaunchPreflight({
        paths: ['src/a.ts'],
        openPrs: [],
        unfinishedRuns: [toPreflightUnfinishedRun({ ...base, lifecycle })!],
        liveRunWindowMs: WINDOW,
      });

    expect(evaluate('live').warnings.filter((warning) => warning.kind === 'live-run')).toHaveLength(1);
    for (const lifecycle of ['human-stopped', 'terminal-other-vocabulary', 'terminal-run-status-superseded'] as const) {
      expect(evaluate(lifecycle).warnings.filter((warning) => warning.kind === 'live-run')).toHaveLength(0);
    }
  });

  test('[lifecycle-less-young-overlap-warns] 수명주기가 없으면 젊은 겹침을 경고로 남긴다', () => {
    const mapped = toPreflightUnfinishedRun({
      runId: 'run-lifecycle-less', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 60_000,
    })!;
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [mapped], liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((warning) => warning.name)).toEqual(['run-lifecycle-less']);
  });
});

describe('prepareAskLaunch — 선택된 입력의 종속 인자를 «행동»으로 시험한다', () => {
  test('[rejects-without-author-input] 선택된 입력 없이 종속 인자를 주면 던진다', () => {
    expect(() => prepareAskLaunch(undefined, { forcePreflight: true })).toThrow('--ask 또는 --say 와 함께만');
    expect(() => prepareAskLaunch(undefined, { liveRunWindow: '30' })).toThrow('--ask 또는 --say 와 함께만');
  });
  test('[allows-with-selected-input] ask 또는 say로 이미 선택됐으면 검증된 임계를 돌려준다', () => {
    expect(prepareAskLaunch({ kind: 'ask', value: 'ask.md' }, { liveRunWindow: '45' })).toEqual({ liveRunWindowMinutes: 45, recentChangeWindowDays: 7 });
    expect(prepareAskLaunch({ kind: 'ask', value: 'ask.md' }, {})).toEqual({ liveRunWindowMinutes: 30, recentChangeWindowDays: 7 });
    expect(prepareAskLaunch({ kind: 'say', value: 'seed' }, { liveRunWindow: '45' })).toEqual({ liveRunWindowMinutes: 45, recentChangeWindowDays: 7 });
  });
  test('[validates-through] 잘못된 임계는 여기서도 거부된다', () => {
    expect(() => prepareAskLaunch({ kind: 'ask', value: 'ask.md' }, { liveRunWindow: '1.5' })).toThrow('--live-run-window');
  });
  test('[bare-selected-input-ok] 종속 인자 없이 선택된 입력이면 통과한다', () => {
    expect(() => prepareAskLaunch({ kind: 'ask', value: 'ask.md' }, {})).not.toThrow();
  });
});

describe('나이가 «성한 수»가 아니면 살아 있음으로 안 친다', () => {
  for (const [label, age] of [['NaN', Number.NaN], ['음수', -5], ['무한대', Number.POSITIVE_INFINITY]] as const) {
    test(`[bad-age-${label}] ${label} 은 unreadable 로 센다`, () => {
      const result = evaluateLaunchPreflight({
        paths: ['src/a.ts'],
        openPrs: [],
        unfinishedRuns: [{ runId: 'r', plannedPaths: ['src/a.ts'], lastActivityAgeMs: age }],
        liveRunWindowMs: WINDOW,
      });
      expect(result.blockers).toHaveLength(0);
      expect(result.unreadableRuns).toBe(1);
    });
  }
});

// ── 다섯째 라운드 (2026-08-11 · #8153 리뷰) ───────────────────────────────────
describe('다섯째 라운드 — 계약 표면·상한·혼합 배열', () => {
  test('[no-unused-fallback-arg] 기본값은 내부 상수이고 인자로 안 받는다', () => {
    expect(resolveLiveRunWindowMinutes.length).toBe(1);
    expect(resolveLiveRunWindowMinutes(undefined)).toBe(30);
  });

  test('[window-upper-bound] 비현실적으로 큰 임계는 거부한다(ms 변환이 안전 정수를 넘지 않게)', () => {
    expect(() => resolveLiveRunWindowMinutes(String(Number.MAX_SAFE_INTEGER))).toThrow('--live-run-window');
    expect(resolveLiveRunWindowMinutes('10080')).toBe(10080); // 7일 = 상한
    expect(() => resolveLiveRunWindowMinutes('10081')).toThrow('--live-run-window');
  });

  test('[malformed-array-is-unreadable] 문자열이 아닌 원소가 섞이면 «못 읽은 것»이 된다', () => {
    const mapped = toPreflightUnfinishedRun({ runId: 'r', plannedPaths: ['a.ts', 42], lastActivityAgeMs: 10 })!;
    expect(mapped.plannedPaths).toBe('planned-paths-malformed');
    const result = evaluateLaunchPreflight({
      paths: ['a.ts'], openPrs: [], unfinishedRuns: [mapped], liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toHaveLength(0);
    expect(result.unreadableRuns).toBe(1);
  });

  test('[truncated-warns] 조회가 잘리면 미조회 사실을 경고로 남기고 통과시킨다', () => {
    const prs = Array.from({ length: 3 }, (_, i) => ({ number: i, title: 't', files: [{ path: 'zzz.ts' }] }));
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: prs, openPrsLimit: 3, unfinishedRuns: [], liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((warning) => warning.name)).toEqual(['(열린 PR 조회 상한 3)']);
    expect(renderLaunchPreflight(result)).toContain('검사 결과가 아니다');
  });
});

// ── 🅣 리뷰 §3 수용 (2026-08-11) — 「범위」와 「임계」가 «한 쌍»임을 코드가 말하게 한다 ──────────
// ⛔ 🅣 실측: `--all --include-test` 는 후보를 «넷 우주»로 늘리지만(orchestrator.ts 기준 6~8건)
//    그 전부가 2.2~6.7일 된 죽은 런이라 30분 임계가 걸러 냈다.
//    ⇒ 📌 ***범위를 안전하게 만드는 것은 includeTest 가 아니라 «임계»다.***
//      그래서 임계가 사라지거나 커지면 includeTest 가 «즉시» 위험해진다 — 그 결합을 시험이 문다.
describe('범위(includeTest)와 임계는 «한 쌍»이다', () => {
  const deadRuns = [
    { runId: 'run-prod', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 186_450_792 },   // 2.2일
    { runId: 'run-axon-test', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 575_209_007 }, // 6.7일
  ];

  test('[threshold-filters-federated-scope] 연합 범위를 켜도 «죽은 런»은 임계가 거른다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: [], unfinishedRuns: deadRuns, liveRunWindowMs: 30 * 60_000,
    });
    expect(result.liveRuns).toEqual({ state: 'checked', count: 2 }); // 후보는 «늘어난다»
    expect(result.blockers).toHaveLength(0);                          // 그러나 «안 막는다»
  });

  test('[threshold-removal-surfaces-scope] 임계를 키우면 같은 범위가 «즉시» 경고로 드러난다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/a.ts'], openPrs: [], unfinishedRuns: deadRuns, liveRunWindowMs: 7 * 24 * 3600_000,
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((warning) => warning.name).sort()).toEqual(['run-axon-test', 'run-prod']);
  });

  test('[window-bound-caps-the-risk] 그래서 임계에 상한이 있다 — 무한정 키울 수 없다', () => {
    expect(resolveLiveRunWindowMinutes(String(MAX_LIVE_RUN_WINDOW_MINUTES))).toBe(MAX_LIVE_RUN_WINDOW_MINUTES);
    expect(() => resolveLiveRunWindowMinutes(String(MAX_LIVE_RUN_WINDOW_MINUTES + 1))).toThrow('--live-run-window');
  });
});

// ── 대표 지시 (2026-08-11) — draft 는 «차단»이 아니라 «경고» ────────────────────
// 📏 🅣 실측 근거: 이 검사가 막은 5건이 «전부» draft 였고, 열린 33건 중 ready 는 셋뿐이었다.
//    ⇒ 「사람 판단 대기」 더미가 «능동 차단기»로 바뀌어 있었다.
describe('도는 런의 작업 트리 실제 변경 관측 — decideAskPreflight 외부 진입', () => {
  const touch = (state: 'touched' | 'untouched' | 'unreadable' | 'worktree-unknown', uncommitted: 'touched' | 'untouched' | 'unreadable' | null, committed: 'touched' | 'untouched' | 'unreadable' | null) => ({ state, uncommitted, committed } as const);
  const entry = { runId: 'run-live', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 1, worktreePath: '/run/worktree' };
  const decision = (observation: ReturnType<typeof touch>, worktreePath = entry.worktreePath) => decideAskPreflight(
    { goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 },
    {
      readGoalDocument: () => 'doc', tracedPaths: () => ['src/a.ts'], askTargetPaths: () => ['src/a.ts'],
      listOpenPrs: () => [], listUnfinishedRuns: () => [{ ...entry, ...(worktreePath === undefined ? { worktreePath: undefined } : { worktreePath }) }],
      observeWorktreePathTouches: () => ({ 'src/a.ts': observation }),
    }, false,
  );

  test('[uncommitted-touched-through-outer-entry] 미커밋 변경은 실제 touched 경고로 남기고 발사를 허용한다', () => {
    const d = decision(touch('touched', 'touched', 'untouched'));
    expect(d.result.blockers).toHaveLength(0);
    expect(d.result.warnings).toHaveLength(1);
    expect(d.shouldLaunch).toBe(true);
    expect(d.result.warnings[0]!.overlapPaths![0]!.worktreeTouch).toEqual(touch('touched', 'touched', 'untouched'));
    expect(d.result.warnings[0]!.detail).toContain('실제 touched');
  });

  test('[committed-touched-through-outer-entry] 깨끗한 작업 트리여도 merge-base 이후 커밋은 touched 경고로 말한다', () => {
    const d = decision(touch('touched', 'untouched', 'touched'));
    expect(combineWorktreePathTouchAxes('untouched', 'touched')).toBe('touched');
    expect(d.result.warnings[0]!.overlapPaths![0]!.worktreeTouch).toEqual(touch('touched', 'untouched', 'touched'));
  });

  test('[both-untouched-through-outer-entry] 어느 축도 안 건드린 경고 값은 unreadable과 구별된다', () => {
    const d = decision(touch('untouched', 'untouched', 'untouched'));
    expect(d.result.warnings[0]!.overlapPaths![0]!.worktreeTouch).toEqual(touch('untouched', 'untouched', 'untouched'));
    expect(d.result.warnings[0]!.detail).toContain('실제 untouched');
    expect(d.result.warnings[0]!.detail).not.toContain('실제 unreadable');
  });

  test('[git-unreadable-through-outer-entry] Git 읽기 실패 경고는 untouched로 접지 않는다', () => {
    const d = decision(touch('unreadable', 'unreadable', 'unreadable'));
    expect(d.result.warnings[0]!.overlapPaths![0]!.worktreeTouch).toEqual(touch('unreadable', 'unreadable', 'unreadable'));
    expect(d.result.warnings[0]!.detail).toContain('실제 unreadable');
    expect(d.result.warnings[0]!.detail).not.toContain('실제 untouched');
  });

  test('[unknown-worktree-through-outer-entry] 작업 트리 경로 부재는 경고에 별도 값으로 남긴다', () => {
    const d = decision(touch('worktree-unknown', null, null), undefined);
    expect(d.result.warnings[0]!.overlapPaths![0]!.worktreeTouch).toEqual(touch('worktree-unknown', null, null));
    expect(d.result.warnings[0]!.detail).toContain('실제 worktree-unknown');
  });

  test('[default-git-read-failure-through-outer-entry] 기본 읽기 전용 Git 관측기 실패는 양 축 unreadable로 남긴다', () => {
    const d = decideAskPreflight(
      { goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 },
      {
        readGoalDocument: () => 'doc', tracedPaths: () => ['src/a.ts'], askTargetPaths: () => ['src/a.ts'],
        listOpenPrs: () => [], listUnfinishedRuns: () => [{ ...entry, worktreePath: '/definitely/unreadable/worktree' }],
      }, false,
    );
    expect(d.result.warnings[0]!.overlapPaths![0]!.worktreeTouch).toEqual(touch('unreadable', 'unreadable', 'unreadable'));
    expect(d.result.warnings[0]!.detail).toContain('실제 unreadable');
  });

  test('[ledger-worktree-event-observes-both-git-axes-and-keeps-warning-nonblocking] 결과 기록이 없어도 원장 worktree 이벤트 경로에서 미커밋·커밋 축과 경고 문면을 관측한다', () => {
    const state = mkdtempSync(join(tmpdir(), 'preflight-ledger-state-'));
    const repo = mkdtempSync(join(tmpdir(), 'preflight-ledger-worktree-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    try {
      git('init', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      writeFileSync(join(repo, 'committed.ts'), 'base\n');
      writeFileSync(join(repo, 'uncommitted.ts'), 'base\n');
      git('add', '.'); git('commit', '-m', 'base');
      git('switch', '-c', 'run');
      writeFileSync(join(repo, 'committed.ts'), 'changed\n');
      git('add', 'committed.ts'); git('commit', '-m', 'change committed');
      writeFileSync(join(repo, 'uncommitted.ts'), 'changed\n');
      const ledgerDirectory = join(state, 'run-ledger');
      mkdirSync(ledgerDirectory);
      writeFileSync(join(ledgerDirectory, 'run-ledger-event.jsonl'), `${JSON.stringify({ runId: 'run-ledger-event', event: 'worktree', data: { path: repo } })}\n`);
      const mapped = toPreflightUnfinishedRun({
        runId: 'run-ledger-event', plannedPaths: ['committed.ts', 'uncommitted.ts'], lastActivityAgeMs: 1, ledgerDirectory,
      })!;
      expect(mapped.worktreePath).toBe(repo);
      const result = evaluateLaunchPreflight({
        paths: ['committed.ts', 'uncommitted.ts'], askTargetPaths: ['committed.ts', 'uncommitted.ts'], openPrs: [],
        unfinishedRuns: [{ ...mapped, worktreePathTouches: observeWorktreePathTouches(mapped, ['committed.ts', 'uncommitted.ts']) }], liveRunWindowMs: WINDOW,
      });
      expect(result.blockers).toHaveLength(0);
      expect(result.warnings[0]!.overlapPaths).toEqual([
        { path: 'committed.ts', role: 'target', worktreeTouch: touch('touched', 'untouched', 'touched') },
        { path: 'uncommitted.ts', role: 'target', worktreeTouch: touch('touched', 'touched', 'untouched') },
      ]);
      expect(result.warnings[0]!.detail).toContain('committed.ts(대상 · 실제 touched)');
      expect(result.warnings[0]!.detail).toContain('uncommitted.ts(대상 · 실제 touched)');
    } finally {
      rmSync(state, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('[ledger-worktree-event-missing-keeps-unknown] 원장에도 경로가 없으면 미상을 untouched로 접지 않는다', () => {
    const state = mkdtempSync(join(tmpdir(), 'preflight-ledger-state-'));
    try {
      const ledgerDirectory = join(state, 'run-ledger');
      mkdirSync(ledgerDirectory);
      writeFileSync(join(ledgerDirectory, 'run-missing-worktree.jsonl'), `${JSON.stringify({ runId: 'run-missing-worktree', event: 'worktree', data: {} })}\n`);
      const mapped = toPreflightUnfinishedRun({
        runId: 'run-missing-worktree', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 1, ledgerDirectory,
      })!;
      expect(mapped.worktreePath).toBeUndefined();
      expect(observeWorktreePathTouches(mapped, ['src/a.ts'])['src/a.ts']).toEqual(touch('worktree-unknown', null, null));
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  test('[persisted-worktree-matches-ledger-goal-id] 연합 원장 goalId와 같은 결과의 작업 트리만 보강한다', () => {
    const state = mkdtempSync(join(tmpdir(), 'preflight-state-'));
    try {
      const runId = 'run-persisted';
      const checkpointDir = join(state, 'self-dev-runs');
      mkdirSync(checkpointDir);
      writeFileSync(join(checkpointDir, `${runId}.json`), JSON.stringify({
        runId, createdAt: 0, updatedAt: 0, results: [
          { feature: 'other-goal', status: 'running', worktreePath: '/persisted/other-worktree' },
          { feature: 'goal-a', status: 'running', worktreePath: '/persisted/goal-a-worktree' },
        ],
      }));
      expect(toPreflightUnfinishedRun({
        runId, goalId: 'goal-a', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 1, ledgerDirectory: join(state, 'run-ledger'),
      })!.worktreePath).toBe('/persisted/goal-a-worktree');
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  test('[persisted-worktree-ambiguous-without-goal-id-is-unknown] 여러 결과에 골 식별자가 없으면 첫 작업 트리를 추측하지 않는다', () => {
    const state = mkdtempSync(join(tmpdir(), 'preflight-state-'));
    try {
      const runId = 'run-ambiguous';
      const checkpointDir = join(state, 'self-dev-runs');
      mkdirSync(checkpointDir);
      writeFileSync(join(checkpointDir, `${runId}.json`), JSON.stringify({
        runId, createdAt: 0, updatedAt: 0, results: [
          { feature: 'goal-a', status: 'running', worktreePath: '/persisted/goal-a-worktree' },
          { feature: 'goal-b', status: 'running', worktreePath: '/persisted/goal-b-worktree' },
        ],
      }));
      expect(toPreflightUnfinishedRun({
        runId, plannedPaths: ['src/a.ts'], lastActivityAgeMs: 1, ledgerDirectory: join(state, 'run-ledger'),
      })!.worktreePath).toBeUndefined();
      expect(toPreflightUnfinishedRun({
        runId, goalId: 'missing-goal', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 1, ledgerDirectory: join(state, 'run-ledger'),
      })!.worktreePath).toBeUndefined();
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  test('[persisted-worktree-single-nonmatching-goal-is-unknown] 단일 결과라도 다른 goalId의 작업 트리로 폴백하지 않는다', () => {
    const state = mkdtempSync(join(tmpdir(), 'preflight-state-'));
    try {
      const runId = 'run-nonmatching';
      const checkpointDir = join(state, 'self-dev-runs');
      mkdirSync(checkpointDir);
      writeFileSync(join(checkpointDir, `${runId}.json`), JSON.stringify({
        runId, createdAt: 0, updatedAt: 0, results: [
          { feature: 'other-goal', status: 'running', worktreePath: '/persisted/other-worktree' },
        ],
      }));
      expect(toPreflightUnfinishedRun({
        runId, goalId: 'goal-a', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 1, ledgerDirectory: join(state, 'run-ledger'),
      })!.worktreePath).toBeUndefined();
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  test('[default-unknown-worktree-through-outer-entry] 주입 observer 없이도 경로 부재를 worktree-unknown으로 남긴다', () => {
    const d = decideAskPreflight(
      { goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 },
      {
        readGoalDocument: () => 'doc', tracedPaths: () => ['src/a.ts'], askTargetPaths: () => ['src/a.ts'],
        listOpenPrs: () => [], listUnfinishedRuns: () => [{ runId: 'run-without-worktree', plannedPaths: ['src/a.ts'], lastActivityAgeMs: 1 }],
      }, false,
    );
    expect(d.result.warnings[0]!.overlapPaths![0]!.worktreeTouch).toEqual(touch('worktree-unknown', null, null));
    expect(d.result.warnings[0]!.detail).toContain('실제 worktree-unknown');
  });

  test('[default-git-axes-through-outer-entry] 실제 Git observer는 미커밋·커밋·무변경을 각 축으로 보존한다', () => {
    const repo = mkdtempSync(join(tmpdir(), 'launch-preflight-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    try {
      git('init', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      writeFileSync(join(repo, 'a.ts'), 'base\n');
      writeFileSync(join(repo, 'b.ts'), 'base\n');
      git('add', '.'); git('commit', '-m', 'base');
      git('switch', '-c', 'run');
      writeFileSync(join(repo, 'a.ts'), 'committed\n');
      git('add', 'a.ts'); git('commit', '-m', 'change a');
      writeFileSync(join(repo, 'b.ts'), 'uncommitted\n');
      const d = decideAskPreflight(
        { goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 },
        {
          readGoalDocument: () => 'doc', tracedPaths: () => ['a.ts', 'b.ts', 'untouched.ts'], askTargetPaths: () => ['a.ts', 'b.ts', 'untouched.ts'],
          listOpenPrs: () => [], listUnfinishedRuns: () => [{ runId: 'git-run', plannedPaths: ['a.ts', 'b.ts', 'untouched.ts'], lastActivityAgeMs: 1, worktreePath: repo }],
        }, false,
      );
      expect(d.result.warnings[0]!.overlapPaths).toEqual([
        { path: 'a.ts', role: 'target', worktreeTouch: touch('touched', 'untouched', 'touched') },
        { path: 'b.ts', role: 'target', worktreeTouch: touch('touched', 'touched', 'untouched') },
        { path: 'untouched.ts', role: 'target', worktreeTouch: touch('untouched', 'untouched', 'untouched') },
      ]);
      expect(d.shouldLaunch).toBe(true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('[successful-rename-or-typechange-output-is-touched-through-outer-entry] 경로 한정 Git 출력이 비어 있지 않으면 rename·typechange 형식도 touched다', () => {
    const repo = mkdtempSync(join(tmpdir(), 'launch-preflight-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    const decide = () => decideAskPreflight(
      { goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 },
      {
        readGoalDocument: () => 'doc', tracedPaths: () => ['a.ts'], askTargetPaths: () => ['a.ts'],
        listOpenPrs: () => [], listUnfinishedRuns: () => [{ runId: 'git-run', plannedPaths: ['a.ts'], lastActivityAgeMs: 1, worktreePath: repo }],
      }, false,
    );
    try {
      git('init', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      writeFileSync(join(repo, 'a.ts'), 'base\n');
      git('add', 'a.ts'); git('commit', '-m', 'base');
      git('switch', '-c', 'run');
      renameSync(join(repo, 'a.ts'), join(repo, 'renamed.ts'));
      expect(decide().result.warnings[0]!.overlapPaths![0]!.worktreeTouch).toEqual(touch('touched', 'touched', 'untouched'));
      git('add', '-A'); git('commit', '-m', 'rename a');
      expect(decide().result.warnings[0]!.overlapPaths![0]!.worktreeTouch).toEqual(touch('touched', 'untouched', 'touched'));
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('[empty-ask-target-paths-use-unknown-role] 빈 대상 경로는 역할 미상과 실제 손댐 경고를 보존하고 발사를 허용한다', () => {
    const d = decideAskPreflight(
      { goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 },
      {
        readGoalDocument: () => 'doc', tracedPaths: () => ['src/a.ts'], askTargetPaths: () => [],
        listOpenPrs: () => [], listUnfinishedRuns: () => [entry],
        observeWorktreePathTouches: () => ({ 'src/a.ts': touch('touched', 'touched', 'untouched') }),
      }, false,
    );
    expect(d.shouldLaunch).toBe(true);
    expect(d.result.warnings[0]!.overlapPaths).toEqual([
      { path: 'src/a.ts', role: 'unknown', worktreeTouch: touch('touched', 'touched', 'untouched') },
    ]);
    expect(d.result.warnings[0]!.allOverlapPathsAreEvidence).toBeUndefined();
    expect(d.result.warnings[0]!.detail).toContain('역할 미상 · 실제 touched');
  });

  test('[missing-ask-target-paths-use-unknown-role] 대상 경로 판별기를 누락해도 역할 미상과 실제 손댐 경고를 보존하고 발사를 허용한다', () => {
    const d = decideAskPreflight(
      { goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 },
      {
        readGoalDocument: () => 'doc', tracedPaths: () => ['src/a.ts'],
        listOpenPrs: () => [], listUnfinishedRuns: () => [entry],
        observeWorktreePathTouches: () => ({ 'src/a.ts': touch('untouched', 'untouched', 'untouched') }),
      }, false,
    );
    expect(d.shouldLaunch).toBe(true);
    expect(d.result.warnings[0]!.overlapPaths).toEqual([
      { path: 'src/a.ts', role: 'unknown', worktreeTouch: touch('untouched', 'untouched', 'untouched') },
    ]);
    expect(d.result.warnings[0]!.allOverlapPathsAreEvidence).toBeUndefined();
    expect(d.result.warnings[0]!.detail).toContain('역할 미상 · 실제 untouched');
  });

  test('[evidence-only-warning-is-preserved] 근거 경로만 겹치면 새 관측이 있어도 경고로 남는다', () => {
    const d = decideAskPreflight(
      { goalFile: 'g.md', liveRunWindowMinutes: 30, recentChangeWindowDays: 7 },
      {
        readGoalDocument: () => 'doc', tracedPaths: () => ['src/a.ts'], askTargetPaths: () => ['src/other.ts'],
        listOpenPrs: () => [], listUnfinishedRuns: () => [entry],
        observeWorktreePathTouches: () => ({ 'src/a.ts': touch('touched', 'touched', 'untouched') }),
      }, false,
    );
    expect(d.result.blockers).toHaveLength(0);
    expect(d.result.warnings.filter((warning) => warning.kind === 'live-run')).toHaveLength(1);
    expect(d.shouldLaunch).toBe(true);
  });
});

describe('열린 PR 은 통과시키되 «경고»로 남긴다', () => {
  const files = [{ path: 'src/index.ts' }];

  test('[draft-warns-not-blocks] draft 충돌은 막지 않고 경고가 된다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [{ number: 8100, title: '정지된 draft', files, isDraft: true }],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toHaveLength(0);
    expect(result.warnings.map((w) => w.name)).toEqual(['#8100']);
    const text = renderLaunchPreflight(result);
    expect(text).toContain('[preflight] 요청문이 선언한 대상 경로 1개 · 실재하지 않음 0개: src/index.ts');
    expect(text).toContain('#8100 — draft PR 이 같은 파일을 연다');
    expect(text).not.toContain('gh pr view 8100 --json body');
    expect(text).toContain('막는 것 없음');
    expect(text).toContain('경고 1건은 위에 있다'); // ⛔ 「지나갔다」와 「없었다」가 다른 값
  });

  test('[preliminary-and-final-conclusions-are-distinct] 예비 판은 재검사를 알리고 확정 판만 위의 경고를 가리킨다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [{ number: 8100, title: '정지된 draft', files, isDraft: true }],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    const preliminary = renderLaunchPreflight(result, false, 'before-authoring');
    const final = renderLaunchPreflight(result, false, 'before-launch');
    const preliminaryConclusion = preliminary.split('\n').at(-1);
    const finalConclusion = final.split('\n').at(-1);

    expect(preliminaryConclusion).toBe('[preflight] ✅ 막는 것 없음 — 예비 검사 완료; 저작 뒤 확정 재검사가 한 번 더 온다');
    expect(preliminaryConclusion).toContain('재검사');
    expect(preliminaryConclusion).not.toContain('위에 있다');
    expect(finalConclusion).toBe('[preflight] ✅ 막는 것 없음 — 확정 검사 완료; 발사로 간다 (경고 1건은 위에 있다)');
    expect(finalConclusion).toContain('위에 있다');
    expect(preliminaryConclusion).not.toBe(finalConclusion);
  });

  test('[same-path-drafts-summarize-nonblocking] 같은 경로의 draft 둘은 번호·본문 명령을 요약하지만 막지 않는다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [
        { number: 8100, title: '첫 실패', files, isDraft: true },
        { number: 8101, title: '둘째 실패', files, isDraft: true },
        { number: 8102, title: '다른 경로', files: [{ path: 'src/other.ts' }], isDraft: true },
      ],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toHaveLength(0);
    expect(result.warnings.map((warning) => warning.name)).toEqual(['#8100', '#8101']);
    const text = renderLaunchPreflight(result);
    expect(text).toContain('src/index.ts 을 여는 draft PR 2건: #8100 #8101 — 확인 명령:');
    expect(text).not.toContain('실패 이유:');
    expect(text).toContain('gh pr view 8100 --json body');
    expect(text).toContain('gh pr view 8101 --json body');
    expect(text).not.toContain('gh pr view 8102 --json body');
    expect(text).toContain('막는 것 없음');
  });

  test('[ready-warns-not-blocks] ready(비-draft) 충돌도 제목과 경로를 보존해 경고한다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [{ number: 7333, title: '진행 중', files, isDraft: false }],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      name: '#7333',
      detail: '열린 PR 이 같은 파일을 연다: src/index.ts — 진행 중',
    }));
  });

  test('[mixed] draft와 ready 모두 경고로 «둘 다» 보인다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [
        { number: 8100, title: 'draft', files, isDraft: true },
        { number: 7333, title: 'ready', files, isDraft: false },
      ],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((w) => w.name)).toEqual(['#8100', '#7333']);
    const text = renderLaunchPreflight(result);
    expect(text).toContain('#8100 — draft PR 이 같은 파일을 연다');
    expect(text).toContain('#7333 — 열린 PR 이 같은 파일을 연다');
  });

  test('[unknown-draft-flag-warns] isDraft 를 «모르면» 열린 PR로 경고한다', () => {
    const result = evaluateLaunchPreflight({
      paths: ['src/index.ts'],
      openPrs: [{ number: 1, title: '플래그 없음', files }],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

// ⛔⭐⭐⭐ 셋째 축 — 「이 골이 원한 것이 이미 있을 수 있다」를 기계가 말한다(2026-08-11).
//   📏 왜 생겼나: 같은 날 두 트랙이 「원한 능력이 지금 main 에 있나」를 각각 다른 방식으로 틀렸다
//     (한쪽은 «잘못된 자»로 쟀고, 한쪽은 «아예 안 쟀다») ⇒ 이미 머지된 능력을 다시 만들려 했다.
//   ⛔ 이 시험들이 없으면 그 축은 「형태만 있고 실행 경로엔 없는」 것이 된다(엘라누스 리뷰 must-fix ④).
describe('최근 머지 검사 — 막지 않고 «경고»로만', () => {
  const base = { openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW } as const;

  test('[recent-change-warns-not-blocks] 최근 변경이 있으면 경고가 나고 막는 것은 «안 는다»', () => {
    const result = evaluateLaunchPreflight({
      ...base,
      paths: ['src/index.ts'],
      recentChanges: { 'src/index.ts': 3 },
      recentChangeWindowDays: 14,
    });
    expect(result.blockers).toHaveLength(0);
    expect(result.warnings.map((warning) => warning.kind)).toContain('recent-change');
    const text = renderLaunchPreflight(result);
    expect(text).toContain('최근 변경');
    expect(text).toContain('14');           // ⭐ 임계가 산출에 실린다 — 「어느 자로 쟀나」
  });

  test('[zero-is-not-a-warning] 최근 변경이 0이면 경고를 만들지 않는다', () => {
    const result = evaluateLaunchPreflight({
      ...base,
      paths: ['src/index.ts'],
      recentChanges: { 'src/index.ts': 0 },
    });
    expect(result.warnings.filter((warning) => warning.kind === 'recent-change')).toHaveLength(0);
    expect(result.recentChanges).toMatchObject({ state: 'checked' });
  });

  test('[unknown-is-not-zero] 조회 실패는 «변경 없음»이 아니라 unknown 이다', () => {
    const result = evaluateLaunchPreflight({
      ...base,
      paths: ['src/index.ts'],
      recentChanges: null,
      recentChangesUnknownReason: '최근 변경 조회 실패: git not found',
    });
    // ⛔ 이 저장소의 「0」과 「못 셈」 규율 — 둘이 같은 값이면 이 축은 거짓을 생산한다.
    expect(result.recentChanges.state).toBe('unknown');
    expect(result.warnings.filter((warning) => warning.kind === 'recent-change')).toHaveLength(0);
    expect(result.blockers).toHaveLength(0);   // ⛔ 못 쟀다고 «막지» 않는다
  });

  test('[window-is-carried] 임계를 안 주면 기본값이 산출에 실린다', () => {
    const result = evaluateLaunchPreflight({ ...base, paths: ['src/index.ts'], recentChanges: {} });
    expect(result.recentChangeWindowDays).toBe(DEFAULT_RECENT_CHANGE_WINDOW_DAYS);
  });
});

describe('최근 머지 임계 해석 — resolveRecentChangeWindowDays', () => {
  test('[default] 안 주면 기본값', () => {
    expect(resolveRecentChangeWindowDays(undefined)).toBe(DEFAULT_RECENT_CHANGE_WINDOW_DAYS);
  });

  test('[decimal-string-only] 십진 정수 표기만 받는다 — 공백·지수·소수는 거부', () => {
    expect(resolveRecentChangeWindowDays('14')).toBe(14);
    // ⛔ trim 하지 «않는다» — ' 5' 를 조용히 5 로 만들면 사람이 친 문면과 도구가 쓴 값이 갈린다.
    for (const bad of [' 5', '1e2', '1.5', '-3', '0', 'abc', '']) {
      if (bad === '') { expect(resolveRecentChangeWindowDays(bad)).toBe(DEFAULT_RECENT_CHANGE_WINDOW_DAYS); continue; }
      expect(() => resolveRecentChangeWindowDays(bad)).toThrow();
    }
  });

  test('[upper-bound] 「최근」이라 부를 수 없는 값은 거부한다', () => {
    expect(() => resolveRecentChangeWindowDays(String(MAX_RECENT_CHANGE_WINDOW_DAYS + 1))).toThrow();
    expect(resolveRecentChangeWindowDays(MAX_RECENT_CHANGE_WINDOW_DAYS)).toBe(MAX_RECENT_CHANGE_WINDOW_DAYS);
  });
});

// ⛔⭐⭐⭐ 실물 진입점 시험 — 「테스트가 코드를 무는가」가 아니라 ***「그 코드가 실행 경로에 있는가」***.
//   📏 2026-08-11: 이 축의 첫 판본이 `launch-preflight.ts` 만 고치고 `src/index.ts` 를 «안 고쳐서»
//     엘라누스 리뷰가 must-fix 5 를 냈다(*"새 축은 런타임에서 항상 unknown 으로 남을 가능성이 크다"*).
//   ⇒ in-process import 로는 원리상 못 잡는다. 그래서 «실물 CLI 를 spawn» 한다.
describe('셋째 축이 «실행 경로»에 있다 — 실물 진입점', () => {
  const CLI = resolve(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
  let cached: string | undefined;
  function devHelp(): string {
    if (cached !== undefined) return cached;
    const r = spawnSync('bun', [CLI, 'dev', '--help-all'], { encoding: 'utf8', timeout: 60_000 });
    if (r.error) throw new Error(`spawn 실패(결함 아님): ${r.error.message}`);
    if (r.signal) throw new Error(`시그널 종료(타임아웃 의심): ${r.signal}`);
    cached = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    return cached;
  }

  it('[flag-reaches-the-entrypoint] 최근-변경 경고가 실물 dev 에서 «기본»으로 돈다', () => {
    const out = devHelp();
    // ⛔ 모집단 확인 — 산출이 비면 「없다」가 아니라 「못 잼」이다.
    expect(out.length).toBeGreaterThan(0);
    // ⛔ 2026-09-02: `--recent-change-window` 는 «은퇴»했다(대표 지시 · #15264).
    //   이 시험이 지키던 것은 «플래그»가 아니라 ***「막지 않고 경고만 낸다」가 사람에게 보이는 것***이다.
    //   ⇒ 플래그가 아니라 그 «동작»을 문다. 은퇴 안내는 옵션을 주었을 때 별도로 난다.
    expect(out).not.toContain('--recent-change-window');
    // ⭐ 그 동작이 «사람에게 보이는 자리»는 이제 도움말이 아니라 «은퇴 안내»다.
    //   ⛔ 그러니 그것을 «실물로» 눌러서 확인한다 — 문면만 보면 「사라졌다」로 읽힌다.
    const r = spawnSync('bun', [CLI, 'dev', '--recent-change-window', '14'], { encoding: 'utf8', timeout: 60_000 });
    if (r.error) throw new Error(`spawn 실패(결함 아님): ${r.error.message}`);
    const pressed = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\s+/g, ' ');
    expect(pressed.length).toBeGreaterThan(0);
    expect(pressed).toContain('--recent-change-window 은퇴');
    expect(pressed).toContain('적용 기본값');   // ⭐ 「무엇이 기본이 됐나」가 사람에게 보이는 자리
  });

  it('[dependent-flag-rejected-without-ask] --ask/--say 없이 주면 이름을 대고 거부한다', () => {
    const r = spawnSync('bun', [CLI, 'dev', '--recent-change-window', '14'], { encoding: 'utf8', timeout: 60_000 });
    if (r.error) throw new Error(`spawn 실패(결함 아님): ${r.error.message}`);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out.length).toBeGreaterThan(0);
    // ⛔ 종속 인자를 «조용히» 무시하면 사람이 준 것이 아무 일도 안 한 채 지나간다.
    expect(out).toContain('--recent-change-window');
    expect(r.status).not.toBe(0);
  });
});

// ⛔⭐⭐⭐ 「맹점 창」 — 저작 100~110초 동안 그 런은 «아무 원장에도 없다» ⇒ 두 창이 서로를 못 본다.
//   📏 2026-08-11: 그래서 두 트랙이 같은 파일을 겨눴고 «사람이» 채널로 막았다(검사가 아니라).
//   ⇒ ask 첫 줄의 「대상 경로」로 ***저작 전에*** 예비 판정한다. ⛔ 이것은 «추정»이고 정본은 TRACED PATHS 다.
describe('parseAskTargetPathHints — 저작 «전»에 쓸 경로 힌트', () => {
  test('[first-line-only] 첫 줄의 「대상 경로:」만 읽는다', () => {
    const ask = '대상 경로: src/a.ts · src/b.ts\n\nSituation: 본문에 src/never.ts 가 나와도 안 뽑는다';
    expect(parseAskTargetPathHints(ask)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('[no-hint-is-not-no-conflict] 힌트를 못 뽑으면 «빈 배열» — 호출자가 「충돌 없음」으로 읽으면 안 된다', () => {
    expect(parseAskTargetPathHints('그냥 문장으로 시작하는 ask')).toEqual([]);
    expect(parseAskTargetPathHints('')).toEqual([]);
  });

  test('[structured-result] 라벨 부재와 버린 원문·사유를 구조화해 보존하고 기존 래퍼는 경로 배열만 돌려준다', () => {
    expect(parseAskTargetPathHintsResult('라벨 없는 ask')).toEqual({
      paths: [], rejected: [], labelMissing: true,
    });
    const ask = '대상 경로: src/a.ts · path with space.ts · 설명 ·   ';
    expect(parseAskTargetPathHintsResult(ask)).toEqual({
      paths: ['src/a.ts'],
      rejected: [
        { fragment: ' path with space.ts ', reason: 'has-whitespace' },
        { fragment: ' 설명 ', reason: 'not-path-like' },
        { fragment: '   ', reason: 'empty' },
      ],
      labelMissing: false,
    });
    expect(parseAskTargetPathHints(ask)).toEqual(['src/a.ts']);
  });

  test('[shape-filter] 경로처럼 생긴 것만 남긴다 — 산문 조각을 경로로 만들지 않는다', () => {
    expect(parseAskTargetPathHints('대상 경로: src/a.ts · 그리고 어떤 설명 · docs/b.md'))
      .toEqual(['src/a.ts', 'docs/b.md']);
  });

  test('[backticks-and-english] 백틱과 영어 표기도 받는다', () => {
    expect(parseAskTargetPathHints('target paths: `src/a.ts`, `src/c.ts`')).toEqual(['src/a.ts', 'src/c.ts']);
  });
});

describe('parseAskProseTitle — 경로 헤더 뒤 선택적 산문 제목', () => {
  test('[title-after-header-preserves-path-hints] 제목은 헤더 뒤에서 읽되 첫 줄 경로 힌트 규칙은 바꾸지 않는다', () => {
    const ask = '대상 경로: src/a.ts · src/b.ts\n제목: 산문 PR 제목';
    expect(parseAskTargetPathHints(ask)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(parseAskProseTitle(ask)).toBe('산문 PR 제목');
  });

  test('[missing-and-whitespace-title] 제목 라벨이 없거나 값이 비면 제목 없음이다', () => {
    expect(parseAskProseTitle('대상 경로: src/a.ts\n구현한다')).toBeUndefined();
    expect(parseAskProseTitle('대상 경로: src/a.ts\n제목:   ')).toBeUndefined();
  });

  test('[bounded-search] 헤더 뒤 처음 여덟 물리 줄만 찾아 본문 제목 오탐을 막는다', () => {
    const inRange = ['대상 경로: src/a.ts', ...Array.from({ length: ASK_PROSE_TITLE_SEARCH_LINE_LIMIT - 1 }, () => ''), '제목: 범위 안'];
    const beyondRange = ['대상 경로: src/a.ts', ...Array.from({ length: ASK_PROSE_TITLE_SEARCH_LINE_LIMIT }, () => ''), '제목: 범위 밖'];
    expect(parseAskProseTitle(inRange.join('\n'))).toBe('범위 안');
    expect(parseAskProseTitle(beyondRange.join('\n'))).toBeUndefined();
  });
});

describe('decideAskPreflight — 저작 «전» 예비 검사(pathsOverride)', () => {
  const deps = (over: Partial<Parameters<typeof decideAskPreflight>[1]> = {}) => ({
    readGoalDocument: () => { throw new Error('골 문서를 읽으면 안 된다 — 아직 «없다»'); },
    tracedPaths: () => { throw new Error('저작 전에는 TRACED PATHS 가 «없다»'); },
    listOpenPrs: () => [],
    listUnfinishedRuns: () => [],
    ...over,
  });

  test('[override-skips-goal-document] 힌트를 주면 골 문서를 «안 읽는다»', () => {
    // ⛔ 이 시험의 값: 없는 파일을 읽으려 하면 저작 «자체»가 막힌다. deps 가 던지도록 두고 통과를 본다.
    const d = decideAskPreflight(
      { goalFile: '', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, pathsOverride: ['src/a.ts'] },
      deps(), false,
    );
    expect(d.result.paths).toEqual(['src/a.ts']);
    expect(d.shouldLaunch).toBe(true);
  });

  test('[override-open-pr-warns] 힌트 경로가 열린 PR 과 겹치면 «저작 전»에도 경고로 남긴다', () => {
    const d = decideAskPreflight(
      { goalFile: '', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, pathsOverride: ['src/a.ts'] },
      deps({ listOpenPrs: () => [{ number: 9, title: 't', files: [{ path: 'src/a.ts' }], isDraft: false }] }),
      false,
    );
    expect(d.result.blockers).toEqual([]);
    expect(d.result.warnings.map((warning) => warning.name)).toEqual(['#9']);
    expect(d.shouldLaunch).toBe(true);
  });

  test('[planned-branch-reaches-evaluate] decideAskPreflight 가 plannedBranch 를 넘기면 형제 경고가 난다', () => {
    const d = decideAskPreflight(
      {
        goalFile: '',
        liveRunWindowMinutes: 30,
        recentChangeWindowDays: 7,
        pathsOverride: ['src/a.ts'],
        plannedBranch: 'self-impl/x-1111aaaa',
      },
      deps({
        listOpenPrs: () => [{
          number: 9,
          title: 't',
          files: [{ path: 'docs/a.md' }],
          isDraft: false,
          headRefName: 'self-impl/x-2222bbbb',
        }],
      }),
      false,
    );
    expect(d.result.blockers).toEqual([]);
    expect(d.result.warnings.filter((warning) => warning.kind === 'sibling-pr')).toHaveLength(1);
    expect(d.result.warnings[0]?.detail).toContain('#9');
    expect(d.shouldLaunch).toBe(true);
  });

  test('[derived-planned-branch-starts-with-self-impl] opts.plannedBranch 가 없으면 하니스 규칙으로 self-impl/ 브랜치를 넘긴다', () => {
    const d = decideAskPreflight(
      { goalFile: '', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, pathsOverride: ['src/a.ts'] },
      deps(),
      false,
    );
    expect(d.plannedBranchResolution!.status).toBe('derived');
    expect(d.plannedBranchResolution!.status === 'derived' ? d.plannedBranchResolution!.plannedBranch : undefined).toMatch(/^self-impl\//);
    expect(d.shouldLaunch).toBe(true);
  });

  test('[derived-planned-branch-sibling-pr-warns] 같은 슬러그의 다른 브랜치가 열려 있으면 sibling-pr 경고가 하나 난다', () => {
    const baseline = decideAskPreflight(
      { goalFile: '', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, pathsOverride: ['src/a.ts'] },
      deps(),
      false,
    );
    expect(baseline.plannedBranchResolution!.status).toBe('derived');
    const planned = baseline.plannedBranchResolution!.status === 'derived' ? baseline.plannedBranchResolution!.plannedBranch : '';
    const sibling = `${planned.replace(/-[0-9a-f]{8}$/i, '')}-ffffffff`;
    const d = decideAskPreflight(
      { goalFile: '', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, pathsOverride: ['src/a.ts'] },
      deps({
        listOpenPrs: () => [{
          number: 11,
          title: 'sibling',
          files: [{ path: 'docs/a.md' }],
          isDraft: false,
          headRefName: sibling,
        }],
      }),
      false,
    );
    expect(d.result.blockers).toEqual([]);
    expect(d.result.warnings.filter((warning) => warning.kind === 'sibling-pr')).toHaveLength(1);
    expect(d.shouldLaunch).toBe(true);
  });

  test('[same-branch-is-not-a-sibling] 열린 PR 이 자기 자신과 같은 브랜치면 sibling-pr 이 안 난다', () => {
    const baseline = decideAskPreflight(
      { goalFile: '', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, pathsOverride: ['src/a.ts'] },
      deps(),
      false,
    );
    const planned = baseline.plannedBranchResolution!.status === 'derived' ? baseline.plannedBranchResolution!.plannedBranch : '';
    const d = decideAskPreflight(
      { goalFile: '', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, pathsOverride: ['src/a.ts'] },
      deps({
        listOpenPrs: () => [{
          number: 12,
          title: 'self',
          files: [{ path: 'docs/a.md' }],
          isDraft: false,
          headRefName: planned,
        }],
      }),
      false,
    );
    expect(d.result.warnings.filter((warning) => warning.kind === 'sibling-pr')).toHaveLength(0);
    expect(d.shouldLaunch).toBe(true);
  });

  test('[derive-throw-is-swallowed] 브랜치 계산이 던져도 발사는 살고 sibling-pr 은 없다', () => {
    expect(() => decideAskPreflight(
      { goalFile: '', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, pathsOverride: ['src/a.ts'] },
      deps({
        derivePlannedBranch: () => { throw new Error('hash failed'); },
        listOpenPrs: () => [{
          number: 13,
          title: 't',
          files: [{ path: 'docs/a.md' }],
          isDraft: false,
          headRefName: 'self-impl/src-a-ts-ffffffff',
        }],
      }),
      false,
    )).not.toThrow();
    const d = decideAskPreflight(
      { goalFile: '', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, pathsOverride: ['src/a.ts'] },
      deps({
        derivePlannedBranch: () => { throw new Error('hash failed'); },
        listOpenPrs: () => [{
          number: 13,
          title: 't',
          files: [{ path: 'docs/a.md' }],
          isDraft: false,
          headRefName: 'self-impl/src-a-ts-ffffffff',
        }],
      }),
      false,
    );
    expect(d.plannedBranchResolution!).toEqual({ status: 'unresolved', reason: 'hash failed' });
    expect(d.result.warnings.filter((warning) => warning.kind === 'sibling-pr')).toHaveLength(0);
    expect(d.shouldLaunch).toBe(true);
  });

  test('[unresolved-differs-from-zero-siblings] 브랜치를 못 구한 관측은 형제 0 과 다른 값이다', () => {
    const unresolved = decideAskPreflight(
      { goalFile: '', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, pathsOverride: ['src/a.ts'] },
      deps({ derivePlannedBranch: () => { throw new Error('no-hash'); } }),
      false,
    );
    const zeroSiblings = decideAskPreflight(
      { goalFile: '', liveRunWindowMinutes: 30, recentChangeWindowDays: 7, pathsOverride: ['src/a.ts'] },
      deps(),
      false,
    );
    expect(unresolved.plannedBranchResolution!.status).toBe('unresolved');
    expect(zeroSiblings.plannedBranchResolution!.status).toBe('derived');
    expect(unresolved.plannedBranchResolution!).not.toEqual(zeroSiblings.plannedBranchResolution!);
    expect(unresolved.result.warnings.filter((warning) => warning.kind === 'sibling-pr')).toHaveLength(0);
    expect(zeroSiblings.result.warnings.filter((warning) => warning.kind === 'sibling-pr')).toHaveLength(0);
  });

  test('[explicit-planned-branch-wins] opts.plannedBranch 를 주면 스스로 구한 값이 덮지 않는다', () => {
    const explicit = 'self-impl/explicit-1111aaaa';
    const d = decideAskPreflight(
      {
        goalFile: '',
        liveRunWindowMinutes: 30,
        recentChangeWindowDays: 7,
        pathsOverride: ['src/a.ts'],
        plannedBranch: explicit,
      },
      deps({
        derivePlannedBranch: () => 'self-impl/derived-should-not-win-9999bbbb',
        listOpenPrs: () => [{
          number: 14,
          title: 't',
          files: [{ path: 'docs/a.md' }],
          isDraft: false,
          headRefName: 'self-impl/explicit-2222bbbb',
        }],
      }),
      false,
    );
    expect(d.plannedBranchResolution!).toEqual({ status: 'explicit', plannedBranch: explicit });
    expect(d.result.warnings.filter((warning) => warning.kind === 'sibling-pr')).toHaveLength(1);
    expect(d.result.warnings[0]?.detail).toContain('#14');
    expect(d.result.warnings[0]?.detail).toContain('self-impl/explicit-2222bbbb');
    expect(d.result.warnings[0]?.detail).not.toContain('derived-should-not-win');
  });

  test('[declared-paths-root-reaches-evaluate-and-render] decideAskPreflight가 declaredPathsRoot를 evaluate까지 넘기고 누락 문면에 기준이 보인다', () => {
    const declaredPathsRoot = '/launching/tree';
    const d = decideAskPreflight(
      {
        goalFile: '',
        liveRunWindowMinutes: 30,
        recentChangeWindowDays: 7,
        pathsOverride: ['src/missing-relative.ts'],
        declaredPathsRoot,
      },
      deps(),
      false,
    );
    expect(d.result.declaredPathsRoot).toBe(declaredPathsRoot);
    expect(d.result.missingDeclaredPathCount).toBe(1);
    expect(d.result.blockers).toEqual([]);
    expect(d.shouldLaunch).toBe(true);
    expect(renderLaunchPreflight(d.result)).toContain(`실재하지 않음 1개: src/missing-relative.ts (기준 ${declaredPathsRoot})`);
  });
});

// ⛔⭐⭐⭐ 막혔을 때 «묻는다» — 대표 2026-08-11 지적으로 생겼다.
//   🔎 그전까지 막히면 exit 1 이었고 「기다릴까 뚫을까」는 사람이 «100% 스스로» 판단했다.
//   ⛔ 이 판은 「묻기」만 넣는다 — 자동 판정도 임의 임계도 «없다»(임계는 선택이 쌓인 뒤 수로 정한다).
describe('planBlockedPrompt / parseBlockedChoice — 막혔을 때의 물음', () => {
  const blocked = (): Parameters<typeof planBlockedPrompt>[0] => evaluateLaunchPreflight({
    paths: [],
    openPrs: [],
    unfinishedRuns: [],
    liveRunWindowMs: WINDOW,
  });

  test('[not-blocked] 막는 것이 없으면 묻지 않는다', () => {
    const clean = evaluateLaunchPreflight({ paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW });
    expect(planBlockedPrompt(clean, true)).toBe('not-blocked');
  });

  test('[ask] 대화형이고 막혔으면 «묻는다»', () => {
    expect(planBlockedPrompt(blocked(), true)).toBe('ask');
  });

  test('[abort-noninteractive] 비대화형이면 종전대로 막고 끝낸다 — 무인 계약', () => {
    expect(planBlockedPrompt(blocked(), false)).toBe('abort-noninteractive');
  });

  test('[empty-is-abort] ⛔ 빈 줄은 «그만두기»다 — 되돌리기 어려운 쪽을 기본값으로 두지 않는다', () => {
    expect(parseBlockedChoice('')).toBe('abort');
    expect(parseBlockedChoice('   ')).toBe('abort');
    expect(parseBlockedChoice('아무거나')).toBe('abort');
  });

  test('[choices] f/i 와 한국어 표기를 받는다', () => {
    for (const yes of ['f', 'F', 'force', '뚫']) expect(parseBlockedChoice(yes)).toBe('force');
    for (const look of ['i', 'inspect', '보기']) expect(parseBlockedChoice(look)).toBe('inspect');
  });

  test('[inspection-names-the-command] 막은 것마다 «어떻게 보는지»를 준다', () => {
    const text = renderBlockedInspection(evaluateLaunchPreflight({
      paths: [],
      openPrs: [],
      unfinishedRuns: [],
      liveRunWindowMs: WINDOW,
    }));
    expect(text).toContain('대상 경로');
  });
});

// ⛔⭐⭐⭐ 「이것이 N번째입니다」 — 🅣 전수(2026-08-11)가 물음 자체를 정정한 자리.
//   📏 막힘 37건 중 사람이 「기다릴까·뚫을까」를 «막힌 뒤에» 고른 표본은 0건.
//     관측된 행동은 «같은 것을 다시 쳤다»(같은 경로가 7회 연속 · 65분 · force 0).
describe('priorIncompleteRuns — 최근 종료된 같은 대상의 미완주 이력', () => {
  const nowMs = Date.parse('2026-09-01T00:00:00.000Z');
  const base = { paths: ['src/a.ts'], openPrs: [], unfinishedRuns: [], liveRunWindowMs: WINDOW, nowMs } as const;
  const interruptedRuns = {
    entries: [
      { runId: 'recent-a', plannedPaths: ['src/a.ts'], interruptionReason: 'stopped', terminatedAtMs: nowMs - 2 * 24 * 60 * 60_000, ledgerDirectory: '/ledger' },
      { runId: 'old-a', plannedPaths: ['src/a.ts'], interruptionReason: 'stopped', terminatedAtMs: nowMs - 31 * 24 * 60 * 60_000, ledgerDirectory: '/ledger' },
      { runId: 'recent-other', plannedPaths: ['src/other.ts'], interruptionReason: 'stopped', terminatedAtMs: nowMs - 2 * 24 * 60 * 60_000, ledgerDirectory: '/ledger' },
    ],
    unreadableRuns: 0,
  } as const;

  test('[same-path-recent-count-and-nonblocking] 최근 30일 같은 경로의 중단 런만 세고 큰 수도 발사를 막지 않는다', () => {
    const result = evaluateLaunchPreflight({ ...base, interruptedRuns: { ...interruptedRuns, entries: Array.from({ length: 40 }, (_, index) => ({ ...interruptedRuns.entries[0], runId: `recent-${index}` })) } });
    expect(result.priorIncompleteRuns).toEqual({ state: 'checked', count: 40 });
    expect(result.priorIncompleteRunWindowDays).toBe(30);
    expect(result.blockers).toEqual([]);
  });

  test('[truncated-applies-the-same-window] 잘린 조회에서도 «옛 런»과 «종료 시각 없는 런»은 최근 수에 안 들어간다', () => {
    // 🩸 회귀(2026-09-01 리뷰): truncated 분기가 창을 «안 걸고» 전부 세어,
    //    「최근 30일」이라 말하면서 전 기간을 냈다. checked 와 «같은 창»을 써야 한다.
    const nowMs = Date.parse('2026-09-01T00:00:00Z');
    const day = 24 * 60 * 60_000;
    const entry = interruptedRuns.entries[0]!;
    const mixed = {
      ...interruptedRuns,
      // ⛔ truncated 는 «플래그»가 아니라 ***entries.length >= limit*** 으로 정해진다(실물 계약).
      limit: 3,
      entries: [
        { ...entry, runId: 'recent', terminatedAtMs: nowMs - 3 * day },     // ✅ 창 «안»
        { ...entry, runId: 'old', terminatedAtMs: nowMs - 200 * day },      // ⛔ 창 «밖»
        { ...entry, runId: 'undated', terminatedAtMs: undefined },          // ⛔ 종료 시각 «모름»
      ],
    };
    const result = evaluateLaunchPreflight({ ...base, nowMs, interruptedRuns: mixed });
    expect(result.priorIncompleteRuns).toEqual({ state: 'truncated', count: 1, limit: 3 });
    expect(result.blockers).toEqual([]);   // ⭐ 잘려도 «막지 않는다»
  });

  test('[truncated-bad-clock-is-unknown-not-zero] 잘린 조회 ⊕ 못 읽는 시계면 «0» 이 아니라 unknown 이다', () => {
    // 🩸 회귀(리뷰 2R): nowMs 가 NaN 이면 모든 항목이 창 밖으로 떨어져 count:0 이 «사실처럼» 나온다.
    const entry = interruptedRuns.entries[0]!;
    // ⛔ limit 을 entries 수와 «같게» 줘야 truncated 가 된다(플래그가 아니다)
    const truncated = { ...interruptedRuns, limit: 1, entries: [{ ...entry, terminatedAtMs: Date.now() }] };
    const result = evaluateLaunchPreflight({ ...base, nowMs: Number.NaN, interruptedRuns: truncated });
    expect(result.priorIncompleteRuns).toEqual({ state: 'unknown', reason: '관측 시각 판독 불가' });
    expect(result.priorIncompleteRuns).not.toEqual({ state: 'truncated', count: 0, limit: 3 });
    expect(result.blockers).toEqual([]);
  });

  test('[bad-clock-and-bad-record-are-distinct] 시계 오류와 종료시각 오류가 «다른 사유»로 나온다', () => {
    // 🩸 리뷰 3R: 둘을 한 이름에 접으면 「어디를 고쳐야 하나」를 못 가른다.
    const entry = interruptedRuns.entries[0]!;
    const good = { ...interruptedRuns, entries: [{ ...entry, terminatedAtMs: Date.now() }] };
    const undated = { ...interruptedRuns, entries: [{ ...entry, terminatedAtMs: undefined }] };
    expect(evaluateLaunchPreflight({ ...base, nowMs: Number.NaN, interruptedRuns: good }).priorIncompleteRuns)
      .toEqual({ state: 'unknown', reason: '관측 시각 판독 불가' });
    expect(evaluateLaunchPreflight({ ...base, interruptedRuns: undated }).priorIncompleteRuns)
      .toEqual({ state: 'unknown', reason: '중단 런 종료 시각 판독 불가' });
  });

  test('[different-path-and-unreadable-are-distinct] 다른 대상은 빼고 원장 판독 불가는 0이 아닌 unknown으로 남긴다', () => {
    expect(evaluateLaunchPreflight({ ...base, paths: ['src/other.ts'], interruptedRuns }).priorIncompleteRuns).toEqual({ state: 'checked', count: 1 });
    const unreadable = evaluateLaunchPreflight({ ...base, interruptedRuns: { entries: [], unreadableRuns: 1 } });
    expect(unreadable.priorIncompleteRuns).toEqual({ state: 'unknown', reason: '1건 원장 판독 불가' });
    expect(unreadable.priorIncompleteRuns).not.toEqual({ state: 'checked', count: 0 });
  });

  test('[missing-terminal-time-is-unknown] 종료 시각을 못 읽으면 0으로 만들지 않는다', () => {
    const result = evaluateLaunchPreflight({ ...base, interruptedRuns: { entries: [{ runId: 'missing-time', plannedPaths: ['src/a.ts'], interruptionReason: 'stopped', ledgerDirectory: '/ledger' }], unreadableRuns: 0 } });
    expect(result.priorIncompleteRuns).toEqual({ state: 'unknown', reason: '중단 런 종료 시각 판독 불가' });
  });
});

describe('countRepeatedBlocks — 같은 경로가 같은 이유로 몇 번 막혔나', () => {
  const prior = [
    { paths: ['src/a.ts', 'src/b.ts'], blockerKinds: ['open-pr'] },
    { paths: ['src/b.ts', 'src/a.ts'], blockerKinds: ['open-pr'] },   // 순서만 다르다 = 같은 집합
    { paths: ['src/a.ts'], blockerKinds: ['open-pr'] },               // 다른 집합
    { paths: ['src/a.ts', 'src/b.ts'], blockerKinds: ['live-run'] },  // 같은 집합 · 다른 이유
  ];

  test('[set-not-order] 경로 «집합»이 같으면 순서는 무관하다', () => {
    expect(countRepeatedBlocks(prior, ['src/a.ts', 'src/b.ts'], ['open-pr'])).toBe(2);
  });

  test('[kind-must-overlap] 이유가 안 겹치면 안 센다', () => {
    expect(countRepeatedBlocks(prior, ['src/a.ts', 'src/b.ts'], ['no-target-paths'])).toBe(0);
  });

  test('[different-set] 부분집합은 «같은 것»이 아니다', () => {
    expect(countRepeatedBlocks(prior, ['src/b.ts'], ['open-pr'])).toBe(0);
  });

  test('[empty-inputs] 경로나 이유가 비면 0 — ⛔ 호출자가 표본을 못 얻으면 아예 부르지 않는다', () => {
    expect(countRepeatedBlocks(prior, [], ['open-pr'])).toBe(0);
    expect(countRepeatedBlocks(prior, ['src/a.ts'], [])).toBe(0);
  });

  test('[zero-says-nothing] 0 이면 «아무 말도 안 한다» — 「0번째입니다」는 소음이다', () => {
    expect(renderRepeatedBlockNotice(0)).toBeNull();
    expect(renderRepeatedBlockNotice(-1)).toBeNull();
    expect(renderRepeatedBlockNotice(3)).toContain('3번');
  });
});
