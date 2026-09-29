import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogStoreRow } from '../mss/logging/log-store.js';
import { LogStore } from '../mss/logging/log-store.js';
import {
  ABANDONED_DRAFT_PRS_LIMITATION,
  applyCurrentStatus,
  classifyMergedGoalLookup,
  extractAbandonedDraftPrGoalId,
  findAbandonedDraftPrs,
  isExpectedStoreReadError,
  listMergedPrHeads,
  MERGED_PR_LIST_LIMIT,
  MERGED_PR_LIST_MAX_LIMIT,
  mergedSinceFromAbandoned,
  QUERY_EVENTS,
  queryAbandonedDraftPrs,
  parseMergedPrHeads,
  renderAbandonedDraftPrs,
  runLogsAbandonedDraftPrs,
  salvageMatchesOpen,
  type AbandonedDraftPr,
  type LookupCurrentDraftPrStatus,
  type LogsAbandonedDraftPrsDeps,
  type MergedPrHead,
  type SpawnGhResult, repoSlugFromPrUrl, lookupCurrentPrStatus, lookupOpenDraftPrs,
} from './logs-abandoned-draft-prs.js';

let nextId = 1;
function row(event: string, data: Record<string, unknown>, tsMs = nextId): LogStoreRow {
  const id = nextId++;
  return {
    id, ts: new Date(tsMs).toISOString(), ts_ms: tsMs, level: 'info',
    instance: 'prod', surface: 'harness', category: 'self-implement', event,
    session_id: null, trace_id: null, data: JSON.stringify(data),
  };
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function createStore(name: string, records: Array<{ event: string; data: Record<string, unknown>; ts?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'logs-abandoned-draft-prs-'));
  dirs.push(dir);
  const path = join(dir, `${name}.db`);
  const store = new LogStore(path);
  store.insertBatch(records.map((record, index) => ({
    rec: {
      ts: record.ts ?? new Date(index + 1).toISOString(),
      category: 'self-implement',
      event: record.event,
      data: record.data,
    },
    surface: 'test',
  })));
  store.close();
  return path;
}

function depsFor(paths: Array<{ name: string; dbPath: string }>, output: string[], errors: string[]): LogsAbandonedDraftPrsDeps {
  return {
    exists: existsSync,
    openReadOnly: LogStore.openReadOnly,
    resolveTargets: () => ({ targets: paths }),
    write: (line) => output.push(line),
    writeError: (line) => errors.push(line),
  };
}

function depsForLookup(
  paths: Array<{ name: string; dbPath: string }>,
  output: string[],
  errors: string[],
  lookupMerged: (goalId: string) => readonly MergedPrHead[],
  now = () => '2026-09-04T12:00:00.000Z',
): LogsAbandonedDraftPrsDeps {
  return { ...depsFor(paths, output, errors), lookupMerged, now };
}

const TWO_VERSION_GOAL = {
  event: 'rework-blocked-draft-pr' as const,
  older: {
    branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-f886d69f',
    number: 101, url: 'https://pr/101', stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
  },
  newer: {
    branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea',
    number: 102, url: 'https://pr/102', stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
  },
};

function createTwoVersionGoalStore(): string {
  return createStore('live', [
    { event: TWO_VERSION_GOAL.event, data: TWO_VERSION_GOAL.older, ts: '2026-09-01T00:00:01.000Z' },
    { event: TWO_VERSION_GOAL.event, data: TWO_VERSION_GOAL.newer, ts: '2026-09-01T00:00:02.000Z' },
  ]);
}

function mergedHeadFiller(count: number, start = 1000): MergedPrHead[] {
  return Array.from({ length: count }, (_, i) => ({
    number: start + i,
    headRefName: `self-impl/other-goalid-aaaaaaaaaaaaaaaa-root-${start + i}`,
  }));
}

function ghLimit(args: readonly string[]): number {
  return Number(args[args.indexOf('--limit') + 1]);
}

test('queryAbandonedDraftPrs deduplicates the same run and PR across stores while retaining distinct runs', () => {
  const now = new Date().toISOString();
  const first = createStore('first', [
    { event: 'rework-blocked-draft-pr', data: { number: 12, url: 'https://pr/12', branch: 'self-impl/a', runId: 'run-a' }, ts: now },
  ]);
  const second = createStore('second', [
    { event: 'rework-blocked-draft-pr', data: { number: 12, url: 'https://pr/12', branch: 'self-impl/a', runId: 'run-a' }, ts: now },
    { event: 'rework-blocked-draft-pr', data: { number: 13, url: 'https://pr/13', branch: 'self-impl/b', runId: 'run-b' }, ts: now },
  ]);
  const result = queryAbandonedDraftPrs({ all: true, includeTest: true, since: '7d' }, {
    exists: existsSync,
    openReadOnly: LogStore.openReadOnly,
    resolveTargets: () => ({ targets: [{ name: 'first', dbPath: first }, { name: 'second', dbPath: second }] }),
  });
  expect(result.map(({ runId, number }) => ({ runId, number }))).toEqual([{ runId: 'run-b', number: 13 }, { runId: 'run-a', number: 12 }]);
});

describe('current draft PR status', () => {
  test('known merged, closed, open, and failed lookups remain separate and review now counts only open', () => {
    const abandoned: AbandonedDraftPr[] = [19291, 19305, 19308, 19400, 19401].map((number) => ({
      store: 'test', number, url: null, branch: 'self-impl/test', openedAt: '2026-09-21T00:00:00.000Z',
      openedAtMs: 1, stage: null, verdict: null, runId: null,
    }));
    const statuses = new Map<number, 'merged' | 'closed' | 'open'>([[19291, 'merged'], [19305, 'closed'], [19308, 'closed'], [19400, 'open']]);
    const frozen = abandoned.map((pr) => Object.freeze(pr));
    const result = applyCurrentStatus(frozen, (candidate) => {
      if (candidate.number === 19401) throw new Error('network down');
      return statuses.get(candidate.number)!;
    });

    expect(abandoned.every((pr) => !('currentStatus' in pr))).toBe(true);
    expect(result.statuses).toEqual(['merged', 'closed', 'closed', 'open', 'lookupFailed']);
    expect(result.statuses).toHaveLength(abandoned.length);
    expect(result.distribution).toEqual({ merged: 1, closed: 2, open: 1, notLookedUp: 0, lookupFailed: 1, reviewNow: 1 });
    expect(result.distribution.merged + result.distribution.closed + result.distribution.open + result.distribution.notLookedUp + result.distribution.lookupFailed).toBe(abandoned.length);
  });

  test('omitted lookup remains notLookedUp without lookup failures', () => {
    const abandoned = [{
      store: 'test', number: 19402, url: null, branch: 'self-impl/test', openedAt: '2026-09-21T00:00:00.000Z',
      openedAtMs: 1, stage: null, verdict: null, runId: null,
    }] as AbandonedDraftPr[];

    expect(applyCurrentStatus(abandoned)).toEqual({
      distribution: { merged: 0, closed: 0, open: 0, notLookedUp: 1, lookupFailed: 0, reviewNow: 0 },
      statuses: ['notLookedUp'],
    });
    expect(abandoned[0]!.currentStatus).toBeUndefined();
  });
});

describe('findAbandonedDraftPrs', () => {
  test('판정이 붙은 브랜치는 미판정 목록에서 빠지고 launched/parked 로 따로 센다', () => {
    const rows = [
      row('rework-blocked-draft-pr', { branch: 'self-impl/a', number: 10, url: 'https://pr/10', stage: 'review-blocked', verdict: 'UNCONVERGEABLE' }, 1),
      row('rework-salvage', { branch: 'self-impl/a', action: 'launched' }, 2),
      row('rework-blocked-draft-pr', { branch: 'self-impl/b', number: 11, url: 'https://pr/11', stage: 'gate-failed', verdict: 'UNCONVERGEABLE' }, 3),
      row('rework-salvage', { branch: 'self-impl/b', action: 'parked' }, 4),
      row('rework-blocked-draft-pr', { branch: 'self-impl/c', number: 12, url: 'https://pr/12', stage: 'review-blocked', verdict: 'UNCONVERGEABLE' }, 5),
    ];

    expect(findAbandonedDraftPrs(rows, 'live')).toEqual({
      abandoned: [{
        store: 'live',
        number: 12, url: 'https://pr/12', branch: 'self-impl/c',
        openedAt: new Date(5).toISOString(), openedAtMs: 5,
        stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
      }],
      abandonedCount: 1,
      judged: { launched: 1, parked: 1, total: 2 },
      skipped: 0,
      goalGroups: [{ goalId: null, prNumbers: [12] }],
      goalCount: 1,
    });
  });

  test('사건의 runId를 방치 draft에 보존한다', () => {
    const report = findAbandonedDraftPrs([
      row('rework-blocked-draft-pr', { branch: 'self-impl/run', number: 13, runId: 'run-a' }, 1),
    ]);
    expect(report.abandoned[0]!.runId).toBe('run-a');
  });

  test('skipped 행은 목록에 없고 따로 센다', () => {
    const rows = [
      row('rework-blocked-draft-pr', { branch: 'self-impl/skip', skipped: 'no-changes', stage: 'gate-failed', verdict: null }, 1),
      row('rework-blocked-draft-pr', { branch: 'self-impl/open', number: 21, url: 'https://pr/21', stage: 'aborted', verdict: null }, 2),
    ];

    const report = findAbandonedDraftPrs(rows);
    expect(report.abandoned.map((pr) => pr.number)).toEqual([21]);
    expect(report.abandoned.some((pr) => pr.branch === 'self-impl/skip')).toBe(false);
    expect(report.skipped).toBe(1);
    expect(report.abandonedCount).toBe(1);
  });

  test('OPEN #71 → OPEN #72 → SALVAGE 는 마지막 개설만 소비하고 이전 PR 은 남긴다', () => {
    const rows = [
      row('rework-blocked-draft-pr', { branch: 'self-impl/same', number: 71, url: 'https://pr/71', stage: 'review-blocked', verdict: 'UNCONVERGEABLE' }, 1),
      row('rework-blocked-draft-pr', { branch: 'self-impl/same', number: 72, url: 'https://pr/72', stage: 'review-blocked', verdict: 'UNCONVERGEABLE' }, 2),
      row('rework-salvage', { branch: 'self-impl/same', action: 'parked' }, 3),
    ];

    const report = findAbandonedDraftPrs(rows);
    expect(report.abandoned.map((pr) => pr.number)).toEqual([71]);
    expect(report.judged).toEqual({ launched: 0, parked: 1, total: 1 });
  });

  test('브랜치가 다른 salvage 는 미판정 PR 을 소비하지 않는다', () => {
    const rows = [
      row('rework-blocked-draft-pr', { branch: 'self-impl/keep', number: 31, url: 'https://pr/31', stage: 'review-blocked', verdict: 'UNCONVERGEABLE' }, 1),
      row('rework-salvage', { branch: 'self-impl/other', action: 'launched' }, 2),
    ];

    expect(salvageMatchesOpen('self-impl/other', 'self-impl/keep')).toBe(false);
    const report = findAbandonedDraftPrs(rows);
    expect(report.abandoned.map((pr) => pr.number)).toEqual([31]);
    expect(report.judged.total).toBe(0);
  });

  test('launching 은 최종 판정이 아니라 목록에서 빼지 않는다', () => {
    const rows = [
      row('rework-blocked-draft-pr', { branch: 'self-impl/launching', number: 41, url: 'https://pr/41', stage: 'gate-failed', verdict: null }, 1),
      row('rework-salvage', { branch: 'self-impl/launching', action: 'launching' }, 2),
    ];

    expect(findAbandonedDraftPrs(rows).abandoned.map((pr) => pr.number)).toEqual([41]);
  });

  test('번호 없는 개설 실패는 분모가 아니다', () => {
    const rows = [
      row('rework-blocked-draft-pr', { branch: 'self-impl/fail', error: 'open failed', stage: 'aborted' }, 1),
    ];
    expect(findAbandonedDraftPrs(rows)).toMatchObject({ abandonedCount: 0, skipped: 0, judged: { total: 0 } });
  });
});

describe('extractAbandonedDraftPrGoalId', () => {
  test('긴 goalId 두 판과 짧은 id, 접두 직후, 접두 없는 형태, 옛 형식을 가른다', () => {
    expect(extractAbandonedDraftPrGoalId('self-impl/plugin-rich-goalid-5245a3ea5a684476-root-f886d69f'))
      .toBe('5245a3ea5a684476');
    expect(extractAbandonedDraftPrGoalId('self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea'))
      .toBe('5245a3ea5a684476');
    expect(extractAbandonedDraftPrGoalId('self-impl/claude-plugin-package-elanous-goalid-b629a-a13b091f'))
      .toBe('b629a');
    expect(extractAbandonedDraftPrGoalId('self-impl/goalid-0af1dc4d84d1615d-rootintent-scrip-f3b1782a'))
      .toBe('0af1dc4d84d1615d');
    expect(extractAbandonedDraftPrGoalId('goalid-0af1dc4d84d1615d-rootintent-scrip-f3b1782a'))
      .toBe('0af1dc4d84d1615d');
    expect(extractAbandonedDraftPrGoalId('self-impl/src-autopilot-discovery-preexisting-red-8933df0a'))
      .toBeNull();
    expect(extractAbandonedDraftPrGoalId('self-impl/src-cli-mygoalid-foo-c8cbedac')).toBeNull();
  });
});

describe('findAbandonedDraftPrs — goal grouping', () => {
  test('같은 긴 goalId 두 판은 골 묶음 하나에 PR 번호 둘을 싣는다', () => {
    const rows = [
      row('rework-blocked-draft-pr', {
        branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-f886d69f',
        number: 101, url: 'https://pr/101', stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
      }, 1),
      row('rework-blocked-draft-pr', {
        branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea',
        number: 102, url: 'https://pr/102', stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
      }, 2),
    ];
    const report = findAbandonedDraftPrs(rows);
    expect(report.abandonedCount).toBe(2);
    expect(report.abandoned.map((pr) => pr.number)).toEqual([102, 101]);
    expect(report.goalCount).toBe(1);
    expect(report.goalGroups).toEqual([{
      goalId: '5245a3ea5a684476',
      prNumbers: [102, 101],
    }]);
  });

  test('서로 다른 goalId 두 PR 은 골 묶음 둘로 남는다', () => {
    const rows = [
      row('rework-blocked-draft-pr', {
        branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-f886d69f',
        number: 101, url: 'https://pr/101', stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
      }, 1),
      row('rework-blocked-draft-pr', {
        branch: 'self-impl/claude-plugin-package-elanous-goalid-b629a-a13b091f',
        number: 102, url: 'https://pr/102', stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
      }, 2),
    ];
    const report = findAbandonedDraftPrs(rows);
    expect(report.abandonedCount).toBe(2);
    expect(report.goalCount).toBe(2);
    expect(report.goalGroups).toEqual([
      { goalId: 'b629a', prNumbers: [102] },
      { goalId: '5245a3ea5a684476', prNumbers: [101] },
    ]);
  });

  test('goalId 없는 옛 형식 하나면 골 수는 0이 아니라 1이다', () => {
    const rows = [
      row('rework-blocked-draft-pr', {
        branch: 'self-impl/src-autopilot-discovery-preexisting-red-8933df0a',
        number: 103, url: 'https://pr/103', stage: 'aborted', verdict: null,
      }, 1),
    ];
    const report = findAbandonedDraftPrs(rows);
    expect(report.abandonedCount).toBe(1);
    expect(report.goalCount).toBe(1);
    expect(report.goalGroups).toEqual([{ goalId: null, prNumbers: [103] }]);
  });

  test('goalId 없는 옛 형식 둘은 각자 단독 묶음이다', () => {
    const rows = [
      row('rework-blocked-draft-pr', {
        branch: 'self-impl/src-autopilot-discovery-preexisting-red-8933df0a',
        number: 103, url: 'https://pr/103', stage: 'aborted', verdict: null,
      }, 1),
      row('rework-blocked-draft-pr', {
        branch: 'self-impl/src-cli-pr-cli-ts-test-cli-pr-cli-test-t-c8cbedac',
        number: 104, url: 'https://pr/104', stage: 'aborted', verdict: null,
      }, 2),
    ];
    const report = findAbandonedDraftPrs(rows);
    expect(report.abandonedCount).toBe(2);
    expect(report.goalCount).toBe(2);
    expect(report.goalGroups).toEqual([
      { goalId: null, prNumbers: [104] },
      { goalId: null, prNumbers: [103] },
    ]);
  });
});

describe('runLogsAbandonedDraftPrs — read-only storage path', () => {
  test('합성 스토어에서 skipped 와 판정 브랜치를 제외하고 메타데이터를 JSON 으로 낸다', () => {
    const path = createStore('live', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/skip', skipped: 'no-changes', stage: 'gate-failed' }, ts: '2026-09-01T00:00:00.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/judged', number: 50, url: 'https://pr/50', stage: 'review-blocked', verdict: 'UNCONVERGEABLE' }, ts: '2026-09-01T00:00:01.000Z' },
      { event: 'rework-salvage', data: { branch: 'self-impl/judged', action: 'launched' }, ts: '2026-09-01T00:00:02.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/open', number: 51, url: 'https://pr/51', stage: 'review-blocked', verdict: 'UNCONVERGEABLE' }, ts: '2026-09-01T00:00:03.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];

    expect(runLogsAbandonedDraftPrs(
      { json: true, all: true, includeTest: true },
      depsFor([{ name: 'live', dbPath: path }], output, errors),
    )).toBe(0);
    expect(errors).toEqual([]);
    const report = JSON.parse(output[0]!);
    expect(report.abandoned.map((pr: { number: number }) => pr.number)).toEqual([51]);
    expect(report.abandoned.some((pr: { number: number }) => pr.number === 50)).toBe(false);
    expect(report.skipped).toBe(1);
    expect(report.judged).toEqual({ launched: 1, parked: 0, total: 1 });
    expect(report.stores).toEqual({ count: 1, names: ['live'], truncated: false, rowsCollected: 4, unreadable: 0 });
    expect(report.abandoned[0]).toMatchObject({
      store: 'live',
      number: 51, url: 'https://pr/51', branch: 'self-impl/open',
      stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
    });
    expect(report.goalCount).toBe(1);
    expect(report.goalGroups).toEqual([{ goalId: null, prNumbers: [51] }]);
    expect(report.populationEvents).toEqual(QUERY_EVENTS);
    expect(report.limitation).toBe(ABANDONED_DRAFT_PRS_LIMITATION);
    expect(report.limitation).not.toBe('');
  });

  test('0건 JSON에도 조회 이벤트 모집단과 열린 draft 한계를 남긴다', () => {
    const output: string[] = [];
    const errors: string[] = [];

    expect(runLogsAbandonedDraftPrs(
      { json: true, all: true, includeTest: true },
      depsFor([], output, errors),
    )).toBe(0);

    const report = JSON.parse(output[0]!);
    expect(errors).toEqual([]);
    expect(report.abandonedCount).toBe(0);
    expect(report.populationEvents).toEqual(QUERY_EVENTS);
    expect(report.limitation).toBe(ABANDONED_DRAFT_PRS_LIMITATION);
    expect(report.limitation).not.toBe('');
  });

  test('사람 출력에도 조회 이벤트 모집단과 열린 draft 한계를 보인다', () => {
    const output: string[] = [];
    const errors: string[] = [];

    expect(runLogsAbandonedDraftPrs(
      { all: true, includeTest: true },
      depsFor([], output, errors),
    )).toBe(0);

    expect(errors).toEqual([]);
    expect(output[0]).toContain(`population events: ${QUERY_EVENTS.join(', ')}`);
    expect(output[0]).toContain(`limitation: ${ABANDONED_DRAFT_PRS_LIMITATION}`);
  });

  test('같은 긴 goalId 두 판은 JSON 골 묶음 하나에 PR 번호 둘을 싣는다', () => {
    const path = createStore('live', [
      {
        event: 'rework-blocked-draft-pr',
        data: {
          branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-f886d69f',
          number: 101, url: 'https://pr/101', stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
        },
        ts: '2026-09-01T00:00:01.000Z',
      },
      {
        event: 'rework-blocked-draft-pr',
        data: {
          branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea',
          number: 102, url: 'https://pr/102', stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
        },
        ts: '2026-09-01T00:00:02.000Z',
      },
    ]);
    const output: string[] = [];
    const errors: string[] = [];

    expect(runLogsAbandonedDraftPrs(
      { json: true, all: true, includeTest: true },
      depsFor([{ name: 'live', dbPath: path }], output, errors),
    )).toBe(0);
    expect(errors).toEqual([]);
    const report = JSON.parse(output[0]!);
    expect(report.abandonedCount).toBe(2);
    expect(report.goalCount).toBe(1);
    expect(report.goalGroups).toEqual([{
      goalId: '5245a3ea5a684476',
      prNumbers: [102, 101],
    }]);
    expect(report.abandoned.map((pr: { number: number }) => pr.number)).toEqual([102, 101]);
    expect(report.judged).toEqual({ launched: 0, parked: 0, total: 0 });
    expect(report.skipped).toBe(0);
    expect(report.stores).toEqual({ count: 1, names: ['live'], truncated: false, rowsCollected: 2, unreadable: 0 });
  });

  test('조회 상한에 닿으면 truncated 를 값으로 남기고 스토어 이름을 센다', () => {
    const path = createStore('capped', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/one', number: 61, url: 'https://pr/61', stage: 'aborted' } },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/two', number: 62, url: 'https://pr/62', stage: 'aborted' } },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/three', number: 63, url: 'https://pr/63', stage: 'aborted' } },
    ]);
    const output: string[] = [];
    const errors: string[] = [];

    expect(runLogsAbandonedDraftPrs(
      { json: true, limit: '2' },
      depsFor([{ name: 'capped', dbPath: path }], output, errors),
    )).toBe(0);
    expect(errors).toEqual([]);
    const report = JSON.parse(output[0]!);
    expect(report.stores).toEqual({ count: 1, names: ['capped'], truncated: true, rowsCollected: 2, unreadable: 0 });
    expect(typeof report.stores.count).toBe('number');
    expect(typeof report.stores.truncated).toBe('boolean');
  });

  test('두 스토어의 같은 번호·브랜치는 한쪽 salvage 가 다른 스토어 PR 을 소비하지 않는다', () => {
    const judged = createStore('repo-a', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/same', number: 80, url: 'https://a/80', stage: 'review-blocked', verdict: 'UNCONVERGEABLE' }, ts: '2026-09-01T00:00:00.000Z' },
      { event: 'rework-salvage', data: { branch: 'self-impl/same', action: 'parked' }, ts: '2026-09-01T00:00:01.000Z' },
    ]);
    const open = createStore('repo-b', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/same', number: 80, url: 'https://b/80', stage: 'review-blocked', verdict: 'UNCONVERGEABLE' }, ts: '2026-09-01T00:00:02.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];

    expect(runLogsAbandonedDraftPrs(
      { json: true, all: true },
      depsFor([{ name: 'repo-a', dbPath: judged }, { name: 'repo-b', dbPath: open }], output, errors),
    )).toBe(0);
    expect(errors).toEqual([]);
    const report = JSON.parse(output[0]!);
    expect(report.abandoned).toEqual([expect.objectContaining({
      store: 'repo-b', number: 80, url: 'https://b/80', branch: 'self-impl/same',
    })]);
    expect(report.abandoned.some((pr: { store: string }) => pr.store === 'repo-a')).toBe(false);
    expect(report.judged).toEqual({ launched: 0, parked: 1, total: 1 });
    expect(report.abandonedCount).toBe(1);
  });

  test('다른 스토어의 salvage 만으로는 이 스토어 개설을 소비하지 않는다', () => {
    const open = createStore('repo-a', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/same', number: 90, url: 'https://a/90', stage: 'review-blocked', verdict: 'UNCONVERGEABLE' }, ts: '2026-09-01T00:00:01.000Z' },
    ]);
    const salvageOnly = createStore('repo-b', [
      { event: 'rework-salvage', data: { branch: 'self-impl/same', action: 'launched' }, ts: '2026-09-01T00:00:02.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];

    expect(runLogsAbandonedDraftPrs(
      { json: true, all: true },
      depsFor([{ name: 'repo-a', dbPath: open }, { name: 'repo-b', dbPath: salvageOnly }], output, errors),
    )).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report.abandoned.map((pr: { number: number; store: string }) => `${pr.store}#${pr.number}`)).toEqual(['repo-a#90']);
    expect(report.judged).toEqual({ launched: 0, parked: 0, total: 0 });
  });

  test('다중 스토어에서 --limit 은 스토어 합산 전역 상한이다', () => {
    const first = createStore('store-a', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/a1', number: 1, url: 'https://pr/1', stage: 'aborted' }, ts: '2026-09-01T00:00:01.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/a2', number: 2, url: 'https://pr/2', stage: 'aborted' }, ts: '2026-09-01T00:00:02.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/a3', number: 3, url: 'https://pr/3', stage: 'aborted' }, ts: '2026-09-01T00:00:03.000Z' },
    ]);
    const second = createStore('store-b', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/b1', number: 4, url: 'https://pr/4', stage: 'aborted' }, ts: '2026-09-01T00:00:04.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/b2', number: 5, url: 'https://pr/5', stage: 'aborted' }, ts: '2026-09-01T00:00:05.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/b3', number: 6, url: 'https://pr/6', stage: 'aborted' }, ts: '2026-09-01T00:00:06.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];

    expect(runLogsAbandonedDraftPrs(
      { json: true, limit: '2', all: true },
      depsFor([{ name: 'store-a', dbPath: first }, { name: 'store-b', dbPath: second }], output, errors),
    )).toBe(0);
    expect(errors).toEqual([]);
    const report = JSON.parse(output[0]!);
    expect(report.stores.rowsCollected).toBe(2);
    expect(report.stores.rowsCollected).toBeLessThanOrEqual(2);
    expect(report.stores.truncated).toBe(true);
    expect(report.stores.names).toEqual(['store-a', 'store-b']);
    expect(report.stores.count).toBe(2);
    expect(report.stores.unreadable).toBe(0);
    expect(report.abandonedCount).toBeLessThanOrEqual(2);
    expect(report.abandonedCount).toBe(2);
  });

  test('--include-test 전달은 생략과 명시를 구분한다', () => {
    const output: string[] = [];
    const errors: string[] = [];
    const selected: Array<{ test?: boolean; instance?: string; all?: boolean; includeTest?: boolean }> = [];
    const deps = depsFor([], output, errors);
    deps.resolveTargets = (opts) => {
      selected.push(opts);
      return { targets: [] };
    };

    expect(runLogsAbandonedDraftPrs({ all: true, json: true }, deps)).toBe(0);
    expect(runLogsAbandonedDraftPrs({ all: true, includeTest: true, json: true }, deps)).toBe(0);
    expect(selected).toEqual([
      { test: undefined, instance: undefined, all: true, includeTest: undefined },
      { test: undefined, instance: undefined, all: true, includeTest: true },
    ]);
  });

  test('사람 출력에도 건수·스토어·상한이 있고 GitHub 쓰기 심볼이 모듈에 없다', () => {
    const source = readFileSync(new URL('./logs-abandoned-draft-prs.ts', import.meta.url), 'utf8');
    // The `logs` subcommands moved from src/index.ts to src/cli/logs-cli.ts in the D4c split.
    const indexSource = readFileSync(new URL('./logs-cli.ts', import.meta.url), 'utf8');
    expect(indexSource).toContain("logsCmd.command('abandoned-draft-prs')");
    expect(indexSource).toContain("const { runLogsAbandonedDraftPrs } = await import('./logs-abandoned-draft-prs.js');");
    expect(indexSource).toContain('process.exit(runLogsAbandonedDraftPrs(merged));');
    expect(indexSource).toContain(".option('--store-names'");
    expect(indexSource).toContain(".option('--lookup-merged'");
    expect(indexSource).toContain(".option('--count-domain-gap'");
    expect(indexSource).toContain(".option('--run-lineage'");
    expect(source).not.toContain('openPr');
    expect(source).not.toContain('postPrComment');
    expect(source).not.toContain('octokit');
    expect(source).not.toMatch(/pr close/);
    expect(source).not.toMatch(/pr edit/);
    expect(source).not.toContain('--add-label');
    expect(source).toContain("'pr', 'list'");
    expect(source).not.toContain('head:goalid-');
    expect(source).toContain('--search');
    expect(source).toContain('merged:>=');
    const rendered = renderAbandonedDraftPrs({
      abandoned: [{
        store: 'prod',
        number: 9, url: 'https://pr/9', branch: 'self-impl/x',
        openedAt: '2026-09-02T00:00:00.000Z', openedAtMs: 1,
        stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
      }],
      abandonedCount: 1,
      judged: { launched: 0, parked: 2, total: 2 },
      skipped: 3,
      stores: { count: 2, names: ['prod', 'test:repo'], truncated: false, rowsCollected: 6, unreadable: 0 },
      goalGroups: [{ goalId: null, prNumbers: [9] }],
      goalCount: 1,
    });
    expect(rendered).toContain('abandoned draft PRs: 1  goals: 1  judged: launched=0 parked=2  skipped=3');
    expect(rendered).toContain('stores: 2  truncated: no  unreadable=0  rows=6');
    expect(rendered).not.toContain('store names:');
    expect(rendered).not.toContain('(prod, test:repo)');
    expect(rendered).toContain('#9  prod  self-impl/x');
    expect(rendered).not.toContain('goal (none):');
  });

  test('한 골에 PR 이 둘이면 머리줄에 골 수를 쓰고 번호들을 함께 낸다', () => {
    const rendered = renderAbandonedDraftPrs({
      abandoned: [
        {
          store: 'prod',
          number: 102, url: 'https://pr/102',
          branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea',
          openedAt: '2026-09-02T00:00:02.000Z', openedAtMs: 2,
          stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
        },
        {
          store: 'prod',
          number: 101, url: 'https://pr/101',
          branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-f886d69f',
          openedAt: '2026-09-02T00:00:01.000Z', openedAtMs: 1,
          stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
        },
      ],
      abandonedCount: 2,
      judged: { launched: 0, parked: 0, total: 0 },
      skipped: 0,
      stores: { count: 1, names: ['prod'], truncated: false, rowsCollected: 2, unreadable: 0 },
      goalGroups: [{ goalId: '5245a3ea5a684476', prNumbers: [102, 101] }],
      goalCount: 1,
    });
    expect(rendered).toContain('abandoned draft PRs: 2  goals: 1  judged: launched=0 parked=0  skipped=0');
    expect(rendered).toContain('goal 5245a3ea5a684476: #102 #101');
  });

  test('골 필드를 생략한 기존 호출도 abandoned 로부터 골 수를 계산한다', () => {
    const rendered = renderAbandonedDraftPrs({
      abandoned: [
        {
          store: 'prod',
          number: 102, url: 'https://pr/102',
          branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea',
          openedAt: '2026-09-02T00:00:02.000Z', openedAtMs: 2,
          stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
        },
        {
          store: 'prod',
          number: 101, url: 'https://pr/101',
          branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-f886d69f',
          openedAt: '2026-09-02T00:00:01.000Z', openedAtMs: 1,
          stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
        },
      ],
      abandonedCount: 2,
      judged: { launched: 0, parked: 0, total: 0 },
      skipped: 0,
      stores: { count: 1, names: ['prod'], truncated: false, rowsCollected: 2, unreadable: 0 },
    });
    const header = rendered.match(/abandoned draft PRs: (\d+)  goals: (\d+)/);
    expect(header).not.toBeNull();
    const prCount = Number(header![1]);
    const goalCount = Number(header![2]);
    expect(prCount).toBe(2);
    expect(goalCount).toBeGreaterThan(0);
    expect(goalCount).toBeLessThanOrEqual(prCount);
    expect(rendered).toContain('abandoned draft PRs: 2  goals: 1  judged: launched=0 parked=0  skipped=0');
    expect(rendered).not.toContain('goals: 0');
    expect(rendered).toContain('goal 5245a3ea5a684476: #102 #101');
  });

  test('골 필드 생략 + 옛 형식 PR 은 골 수가 0이 아니다', () => {
    const rendered = renderAbandonedDraftPrs({
      abandoned: [{
        store: 'prod',
        number: 103, url: 'https://pr/103',
        branch: 'self-impl/src-autopilot-discovery-preexisting-red-8933df0a',
        openedAt: '2026-09-02T00:00:01.000Z', openedAtMs: 1,
        stage: 'aborted', verdict: null, runId: null,
      }],
      abandonedCount: 1,
      judged: { launched: 0, parked: 0, total: 0 },
      skipped: 0,
      stores: { count: 1, names: ['prod'], truncated: false, rowsCollected: 1, unreadable: 0 },
    });
    const header = rendered.match(/abandoned draft PRs: (\d+)  goals: (\d+)/);
    expect(header).not.toBeNull();
    const prCount = Number(header![1]);
    const goalCount = Number(header![2]);
    expect(prCount).toBe(1);
    expect(goalCount).toBeGreaterThan(0);
    expect(goalCount).toBeLessThanOrEqual(prCount);
    expect(rendered).toContain('abandoned draft PRs: 1  goals: 1');
    expect(rendered).not.toContain('goals: 0');
  });

  test('기본 사람 산출은 스토어 이름 나열 없이 수·상한·못 읽은 수를 남긴다', () => {
    const path = createStore('live', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/open', number: 51, url: 'https://pr/51', stage: 'review-blocked', verdict: 'UNCONVERGEABLE' }, ts: '2026-09-01T00:00:03.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];

    expect(runLogsAbandonedDraftPrs(
      {},
      depsFor([{ name: 'live', dbPath: path }], output, errors),
    )).toBe(0);
    expect(errors).toEqual([]);
    const text = output[0]!;
    const [summary, stores] = text.split('\n');
    expect(summary).toBe('abandoned draft PRs: 1  goals: 1  judged: launched=0 parked=0  skipped=0');
    expect(stores).toBe('stores: 1  truncated: no  unreadable=0  rows=1');
    expect(text).not.toContain('store names:');
    expect(text).not.toMatch(/stores: \d+ \(/);
    expect(text).toContain('#51  live  self-impl/open');
  });

  test('--store-names 는 사람 산출에 본 스토어 이름을 전부 낸다', () => {
    const first = createStore('store-a', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/a1', number: 1, url: 'https://pr/1', stage: 'aborted' }, ts: '2026-09-01T00:00:01.000Z' },
    ]);
    const second = createStore('store-b', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/b1', number: 2, url: 'https://pr/2', stage: 'aborted' }, ts: '2026-09-01T00:00:02.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];

    expect(runLogsAbandonedDraftPrs(
      { storeNames: true, all: true },
      depsFor([{ name: 'store-a', dbPath: first }, { name: 'store-b', dbPath: second }], output, errors),
    )).toBe(0);
    expect(errors).toEqual([]);
    const text = output[0]!;
    expect(text).toContain('stores: 2  truncated: no  unreadable=0  rows=2');
    expect(text).toContain('store names: store-a, store-b');
    expect(text).toContain('#2  store-b  self-impl/b1');
  });

  test('기본 사람 산출은 상한 도달 표시를 남긴다', () => {
    const path = createStore('capped', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/one', number: 61, url: 'https://pr/61', stage: 'aborted' } },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/two', number: 62, url: 'https://pr/62', stage: 'aborted' } },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/three', number: 63, url: 'https://pr/63', stage: 'aborted' } },
    ]);
    const output: string[] = [];
    const errors: string[] = [];

    expect(runLogsAbandonedDraftPrs(
      { limit: '2' },
      depsFor([{ name: 'capped', dbPath: path }], output, errors),
    )).toBe(0);
    expect(errors).toEqual([]);
    const text = output[0]!;
    expect(text).toContain('truncated: yes (limit reached)');
    expect(text).not.toContain('store names:');
    expect(text).toContain('stores: 1  truncated: yes (limit reached)  unreadable=0  rows=2');
  });

  test('앞 스토어에서 상한에 닿아도 JSON 과 --store-names 는 뒤 스토어 이름을 남긴다', () => {
    const first = createStore('store-a', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/a1', number: 1, url: 'https://pr/1', stage: 'aborted' }, ts: '2026-09-01T00:00:01.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/a2', number: 2, url: 'https://pr/2', stage: 'aborted' }, ts: '2026-09-01T00:00:02.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/a3', number: 3, url: 'https://pr/3', stage: 'aborted' }, ts: '2026-09-01T00:00:03.000Z' },
    ]);
    const second = createStore('store-b', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/b1', number: 4, url: 'https://pr/4', stage: 'aborted' }, ts: '2026-09-01T00:00:04.000Z' },
    ]);
    const jsonOut: string[] = [];
    const humanOut: string[] = [];
    const errors: string[] = [];
    const targets = [{ name: 'store-a', dbPath: first }, { name: 'store-b', dbPath: second }];

    expect(runLogsAbandonedDraftPrs({ json: true, limit: '2', all: true }, depsFor(targets, jsonOut, errors))).toBe(0);
    expect(runLogsAbandonedDraftPrs({ storeNames: true, limit: '2', all: true }, depsFor(targets, humanOut, errors))).toBe(0);
    expect(errors).toEqual([]);
    const report = JSON.parse(jsonOut[0]!);
    expect(report.stores.names).toEqual(['store-a', 'store-b']);
    expect(report.stores.count).toBe(2);
    expect(report.stores.truncated).toBe(true);
    expect(report.stores.names.length).toBe(report.stores.count);
    expect(humanOut[0]).toContain('store names: store-a, store-b');
    expect(humanOut[0]).toContain('truncated: yes (limit reached)');
  });

  test('못 읽은 스토어는 unreadable 로 세고 JSON 이름에는 남긴다', () => {
    const readable = createStore('ok', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/open', number: 51, url: 'https://pr/51', stage: 'aborted' }, ts: '2026-09-01T00:00:01.000Z' },
    ]);
    const broken = createStore('broken', []);
    const output: string[] = [];
    const errors: string[] = [];
    const deps = depsFor([{ name: 'ok', dbPath: readable }, { name: 'broken', dbPath: broken }], output, errors);
    const originalOpen = deps.openReadOnly;
    deps.openReadOnly = (path) => {
      if (path === broken) {
        throw Object.assign(new Error('unable to open database file'), { name: 'SQLiteError', code: 'SQLITE_CANTOPEN' });
      }
      return originalOpen(path);
    };

    expect(runLogsAbandonedDraftPrs({ json: true, all: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    const report = JSON.parse(output[0]!);
    expect(report.stores.names).toEqual(['ok', 'broken']);
    expect(report.stores.count).toBe(2);
    expect(report.stores.unreadable).toBe(1);
    expect(report.abandoned.map((pr: { number: number }) => pr.number)).toEqual([51]);
    expect(report.skipped).toBe(0);
    expect(report.judged).toEqual({ launched: 0, parked: 0, total: 0 });
  });

  test('예상 open/read 오류만 unreadable 로 세고 분석 sentinel 은 전파한다', () => {
    const readable = createStore('ok', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/open', number: 51, url: 'https://pr/51', stage: 'aborted' }, ts: '2026-09-01T00:00:01.000Z' },
    ]);
    const broken = createStore('broken', []);
    const output: string[] = [];
    const errors: string[] = [];
    const ioError = Object.assign(new Error('unable to open database file'), { name: 'SQLiteError', code: 'SQLITE_CANTOPEN' });
    expect(isExpectedStoreReadError(ioError)).toBe(true);
    expect(isExpectedStoreReadError(new Error('analysis-sentinel'))).toBe(false);

    const ioDeps = depsFor([{ name: 'ok', dbPath: readable }, { name: 'broken', dbPath: broken }], output, errors);
    const originalOpen = ioDeps.openReadOnly;
    ioDeps.openReadOnly = (path) => {
      if (path === broken) throw ioError;
      return originalOpen(path);
    };
    expect(runLogsAbandonedDraftPrs({ json: true, all: true }, ioDeps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report.stores.unreadable).toBe(1);
    expect(report.abandoned.map((pr: { number: number }) => pr.number)).toEqual([51]);

    const queryOut: string[] = [];
    const queryErr: string[] = [];
    const queryDeps = depsFor([{ name: 'ok', dbPath: readable }], queryOut, queryErr);
    const opened = queryDeps.openReadOnly(readable);
    queryDeps.openReadOnly = () => ({
      query: () => {
        throw Object.assign(new Error('file is not a database'), { name: 'SQLiteError', code: 'SQLITE_NOTADB' });
      },
      close: () => opened.close(),
    } as unknown as ReturnType<LogsAbandonedDraftPrsDeps['openReadOnly']>);
    expect(runLogsAbandonedDraftPrs({ json: true }, queryDeps)).toBe(0);
    expect(JSON.parse(queryOut[0]!).stores.unreadable).toBe(1);

    const analysisOut: string[] = [];
    const analysisErr: string[] = [];
    const analysisDeps = depsFor([{ name: 'ok', dbPath: readable }], analysisOut, analysisErr);
    analysisDeps.analyze = () => {
      throw new Error('analysis-sentinel');
    };
    expect(() => runLogsAbandonedDraftPrs({ json: true }, analysisDeps)).toThrow('analysis-sentinel');
    expect(analysisOut).toEqual([]);
  });
});

describe('runLogsAbandonedDraftPrs — run-lineage', () => {
  test('주입 없는 기본 원장 읽기는 «읽은 로그 스토어»의 우주에서 원장을 찾는다 — test 우주 draft 도 읽힌다', () => {
    const root = mkdtempSync(join(tmpdir(), 'logs-abandoned-run-lineage-universe-'));
    dirs.push(root);
    mkdirSync(join(root, 'logs'), { recursive: true });
    mkdirSync(join(root, 'run-ledger'), { recursive: true });
    const dbPath = join(root, 'logs', 'logs.db');
    const store = new LogStore(dbPath);
    store.insertBatch([{
      rec: { ts: '2026-09-01T00:00:01.000Z', category: 'self-implement', event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/a', number: 10, runId: 'run-0a0a0a0a-0000-4000-8000-000000000001' } },
      surface: 'test',
    }]);
    store.close();
    writeFileSync(join(root, 'run-ledger', 'run-0a0a0a0a-0000-4000-8000-000000000001.jsonl'), [
      { runId: 'run-0a0a0a0a-0000-4000-8000-000000000001', event: 'run-rollup', timestamp: '2026-09-01T00:00:02.000Z', data: { stage: 'merged', prNumber: 12 } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const output: string[] = [];
    const errors: string[] = [];

    expect(runLogsAbandonedDraftPrs({ json: true, runLineage: true }, depsFor([{ name: 'test:universe', dbPath }], output, errors))).toBe(0);
    expect(errors).toEqual([]);
    const report = JSON.parse(output[0]!);
    expect(report.abandoned[0].laterMergedInSameRun).toEqual([12]);
    expect(report.runLineage).toEqual({ withLaterMerge: 1, withoutLaterMerge: 0, unreadable: 0 });
  });

  test('같은 런의 이후 merged만 오름차순 중복 없이 싣고 사람·JSON 요약을 낸다', () => {
    const path = createStore('live', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/a', number: 10, runId: 'run-a' }, ts: '2026-09-01T00:00:01.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    let calls = 0;
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      loadRunLedger: (runId) => {
        calls += 1;
        expect(runId).toBe('run-a');
        return [
          { runId, event: 'run-rollup', timestamp: '2026-09-01T00:00:00.000Z', data: { stage: 'merged', prNumber: 8 } },
          { runId, event: 'run-rollup', timestamp: '2026-09-01T00:00:02.000Z', data: { stage: 'merged', prNumber: 12 } },
          { runId, event: 'run-rollup', timestamp: '2026-09-01T00:00:03.000Z', data: { stage: 'merged', prNumber: 11 } },
          { runId, event: 'run-rollup', timestamp: '2026-09-01T00:00:04.000Z', data: { stage: 'gate-failed', prNumber: 13 } },
          { runId, event: 'run-rollup', timestamp: '2026-09-01T00:00:05.000Z', data: { stage: 'merged', prNumber: 10 } },
          { runId, event: 'run-rollup', timestamp: '2026-09-01T00:00:06.000Z', data: { stage: 'merged', prNumber: 11 } },
          { runId, event: 'run-rollup', timestamp: 'invalid', data: { stage: 'merged', prNumber: 14 } },
        ];
      },
    };

    expect(runLogsAbandonedDraftPrs({ json: true, runLineage: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(calls).toBe(1);
    const report = JSON.parse(output[0]!);
    expect(report.abandoned[0].laterMergedInSameRun).toEqual([11, 12]);
    expect(report.abandoned[0].runLineage).toBeUndefined();
    expect(report.runLineage).toEqual({ withLaterMerge: 1, withoutLaterMerge: 0, unreadable: 0 });

    const human: string[] = [];
    expect(runLogsAbandonedDraftPrs({ runLineage: true }, { ...deps, write: (line) => human.push(line) })).toBe(0);
    expect(human[0]).toContain('같은 런 나중 병합 있음 1 · 없음 0 · 원장 못 읽음 0');
    expect(human[0]).toContain('같은 런 나중 병합: #11 #12');
  });

  test('원장을 못 읽으면 빈 목록 대신 unreadable로 구분한다', () => {
    const path = createStore('live', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/b', number: 20, runId: 'run-b' }, ts: '2026-09-01T00:00:01.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      loadRunLedger: () => null,
    };

    expect(runLogsAbandonedDraftPrs({ json: true, runLineage: true }, deps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report.abandoned[0].runLineage).toBe('unreadable');
    expect(report.abandoned[0].laterMergedInSameRun).toBeUndefined();
    expect(report.runLineage).toEqual({ withLaterMerge: 0, withoutLaterMerge: 0, unreadable: 1 });
  });

  test('같은 runId는 원장을 한 번만 읽고 옵션이 없으면 읽지 않는다', () => {
    const path = createStore('live', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/a', number: 30, runId: 'run-c' }, ts: '2026-09-01T00:00:01.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/b', number: 31, runId: 'run-c' }, ts: '2026-09-01T00:00:02.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    let calls = 0;
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      loadRunLedger: () => { calls += 1; return []; },
    };

    expect(runLogsAbandonedDraftPrs({ runLineage: true }, deps)).toBe(0);
    expect(calls).toBe(1);
    expect(runLogsAbandonedDraftPrs({}, deps)).toBe(0);
    expect(calls).toBe(1);
    expect(output[1]).not.toContain('같은 런');
  });

  test('--lookup-merged와 함께도 각 결과를 보존한다', () => {
    const path = createStore('live', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/a-goalid-abc-root', number: 40, runId: 'run-d' }, ts: '2026-09-01T00:00:01.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      loadRunLedger: () => [{ runId: 'run-d', event: 'run-rollup', timestamp: '2026-09-01T00:00:02.000Z', data: { stage: 'merged', prNumber: 41 } }],
      lookupMerged: () => [],
      now: () => '2026-09-04T12:00:00.000Z',
    };

    expect(runLogsAbandonedDraftPrs({ json: true, runLineage: true, lookupMerged: true }, deps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report.abandoned[0].laterMergedInSameRun).toEqual([41]);
    expect(report.goalGroups[0].lookup).toEqual({ state: 'none', mergedPrNumbers: [], supersededPrNumbers: [] });
  });
});

describe('runLogsAbandonedDraftPrs — lookup-merged', () => {
  test('옵션 없이 부르면 조회를 부르지 않고 산출에 lookup 문구가 없다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    let lookupCalls = 0;
    const deps = depsForLookup(
      [{ name: 'live', dbPath: path }],
      output,
      errors,
      () => {
        lookupCalls += 1;
        throw new Error('lookup must not run by default');
      },
    );

    expect(runLogsAbandonedDraftPrs({}, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(lookupCalls).toBe(0);
    const text = output[0]!;
    expect(text).toContain('abandoned draft PRs: 2  goals: 1');
    expect(text).toContain('goal 5245a3ea5a684476: #102 #101');
    expect(text).not.toContain('superseded');
    expect(text).not.toContain('looked up at:');
    expect(text).not.toContain('lookup:');
    expect(text).not.toContain('merged:');
  });

  test('current status lookup is explicit, visible in JSON and human output, and failures remain lookupFailed', () => {
    const path = createStore('live', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/a', number: 19291, url: 'https://pr/19291' }, ts: '2026-09-01T00:00:01.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/b', number: 19305, url: 'https://pr/19305' }, ts: '2026-09-01T00:00:02.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/c', number: 19308, url: 'https://pr/19308' }, ts: '2026-09-01T00:00:03.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/d', number: 19400, url: 'https://pr/19400' }, ts: '2026-09-01T00:00:04.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/e', number: 19401, url: 'https://pr/19401' }, ts: '2026-09-01T00:00:05.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    let calls = 0;
    const lookupCurrentStatus: NonNullable<LogsAbandonedDraftPrsDeps['lookupCurrentStatus']> = (candidate) => {
      calls += 1;
      if (candidate.number === 19401) throw new Error('network down');
      return candidate.number === 19291 ? 'merged' : candidate.number === 19400 ? 'open' : 'closed';
    };
    const deps = { ...depsFor([{ name: 'live', dbPath: path }], output, errors), lookupCurrentStatus };

    expect(runLogsAbandonedDraftPrs({ json: true }, deps)).toBe(0);
    expect(calls).toBe(0);
    const offline = JSON.parse(output[0]!);
    expect(offline.currentStatus).toEqual({ merged: 0, closed: 0, open: 0, notLookedUp: 5, lookupFailed: 0, reviewNow: 0 });
    expect(offline.abandoned.every((pr: { currentStatus: string }) => pr.currentStatus === 'notLookedUp')).toBe(true);
    output.length = 0;
    expect(runLogsAbandonedDraftPrs({}, deps)).toBe(0);
    expect(output[0]).toContain('현재 상태 병합됨 0 · 닫힘 0 · 열림 0 · 안 물어봤다 5 · 못 쟀다 0 · 지금 볼 것 0');
    expect(output[0]).not.toContain('⚠️ 조회 실패');
    output.length = 0;
    expect(runLogsAbandonedDraftPrs({ json: true, lookupCurrentStatus: true }, deps)).toBe(0);
    expect(calls).toBe(5);
    const report = JSON.parse(output[0]!);
    expect(report.currentStatus).toEqual({ merged: 1, closed: 2, open: 1, notLookedUp: 0, lookupFailed: 1, reviewNow: 1 });
    expect(report.abandoned.map((pr: { number: number; currentStatus: string }) => [pr.number, pr.currentStatus])).toEqual([
      [19401, 'lookupFailed'], [19400, 'open'], [19308, 'closed'], [19305, 'closed'], [19291, 'merged'],
    ]);
    output.length = 0;
    expect(runLogsAbandonedDraftPrs({ lookupCurrentStatus: true }, deps)).toBe(0);
    expect(output[0]).toContain('현재 상태 병합됨 1 · 닫힘 2 · 열림 1 · 안 물어봤다 0 · 못 쟀다 1 · 지금 볼 것 1');
    expect(output[0]).toContain('⚠️ 조회 실패 1건 — 「깨끗하다」가 아니라 「못 쟀다」다 (gh 인증·네트워크·저장소 접근을 확인하라)');
    expect(output[0]).toContain('#19401');
    expect(output[0]).toContain('현재 상태=lookupFailed');
    expect(output[0]).toContain('#19400');
    expect(output[0]).toContain('현재 상태=open');
    expect(output[0]).toContain(`limitation: ${ABANDONED_DRAFT_PRS_LIMITATION}`);
  });

  test('한 PR 이 병합되면 superseded 와 병합본 번호가 보인다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    const deps = depsForLookup(
      [{ name: 'live', dbPath: path }],
      output,
      errors,
      (goalId) => [{
        number: 102,
        headRefName: `self-impl/plugin-rich-goalid-${goalId}-root-92346dea`,
      }],
    );

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    const text = output[0]!;
    expect(text).toContain('goal 5245a3ea5a684476: #102 #101  superseded  old: #101  merged: #102');
    expect(text).toContain('looked up at: 2026-09-04T12:00:00.000Z');
  });

  test('어느 PR 도 병합 안 되면 superseded 로 표시되지 않는다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    const deps = depsForLookup(
      [{ name: 'live', dbPath: path }],
      output,
      errors,
      () => [],
    );

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    const text = output[0]!;
    expect(text).toContain('goal 5245a3ea5a684476: #102 #101  lookup: none');
    expect(text).not.toContain('superseded');
    expect(text).toContain('looked up at: 2026-09-04T12:00:00.000Z');
  });

  test('조회가 오류를 던져도 명령은 죽지 않고 unavailable 을 값으로 남긴다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    const deps = depsForLookup(
      [{ name: 'live', dbPath: path }],
      output,
      errors,
      () => {
        throw new Error('network down');
      },
    );

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    const text = output[0]!;
    expect(text).toContain('goal 5245a3ea5a684476: #102 #101  lookup: unavailable');
    expect(text).not.toContain('superseded');
    expect(text).not.toContain('lookup: none');
  });

  test('조회 시각은 비어 있지 않다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    const deps = depsForLookup(
      [{ name: 'live', dbPath: path }],
      output,
      errors,
      () => [],
      () => '2026-09-04T15:22:11.000Z',
    );

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    const text = output[0]!;
    const stamp = text.match(/^looked up at: (.+)$/m)?.[1];
    expect(stamp).toBeTruthy();
    expect(stamp!.length).toBeGreaterThan(0);
    expect(stamp).toBe('2026-09-04T15:22:11.000Z');
  });

  test('JSON 은 병합·없음·실패를 서로 다른 값으로 싣는다', () => {
    const path = createTwoVersionGoalStore();
    const mergedOut: string[] = [];
    const noneOut: string[] = [];
    const failOut: string[] = [];
    const errors: string[] = [];
    const targets = [{ name: 'live', dbPath: path }];

    expect(runLogsAbandonedDraftPrs(
      { json: true, lookupMerged: true },
      depsForLookup(targets, mergedOut, errors, (goalId) => [{
        number: 102,
        headRefName: `self-impl/plugin-rich-goalid-${goalId}-root-92346dea`,
      }]),
    )).toBe(0);
    expect(runLogsAbandonedDraftPrs(
      { json: true, lookupMerged: true },
      depsForLookup(targets, noneOut, errors, () => []),
    )).toBe(0);
    expect(runLogsAbandonedDraftPrs(
      { json: true, lookupMerged: true },
      depsForLookup(targets, failOut, errors, () => {
        throw new Error('gh missing');
      }),
    )).toBe(0);

    const merged = JSON.parse(mergedOut[0]!);
    const none = JSON.parse(noneOut[0]!);
    const fail = JSON.parse(failOut[0]!);
    expect(merged.lookedUpAt).toBe('2026-09-04T12:00:00.000Z');
    expect(merged.goalGroups[0].lookup).toEqual({
      state: 'merged',
      mergedPrNumbers: [102],
      supersededPrNumbers: [101],
    });
    expect(none.goalGroups[0].lookup).toEqual({
      state: 'none',
      mergedPrNumbers: [],
      supersededPrNumbers: [],
    });
    expect(fail.goalGroups[0].lookup).toEqual({
      state: 'unavailable',
      mergedPrNumbers: [],
      supersededPrNumbers: [],
    });
    expect(merged.goalGroups[0].lookup.state).not.toBe(none.goalGroups[0].lookup.state);
    expect(none.goalGroups[0].lookup.state).not.toBe(fail.goalGroups[0].lookup.state);
  });

  test('goalId 없는 묶음은 none 이 아니라 incomplete 이다', () => {
    const path = createStore('live', [
      {
        event: 'rework-blocked-draft-pr',
        data: {
          branch: 'self-impl/src-autopilot-discovery-preexisting-red-8933df0a',
          number: 103, url: 'https://pr/103', stage: 'aborted', verdict: null,
        },
        ts: '2026-09-01T00:00:01.000Z',
      },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    let lookupCalls = 0;
    const deps = depsForLookup(
      [{ name: 'live', dbPath: path }],
      output,
      errors,
      () => {
        lookupCalls += 1;
        return [];
      },
    );

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(lookupCalls).toBe(0);
    expect(output[0]).toContain('goal (none): #103  lookup: incomplete');
    expect(output[0]).not.toContain('lookup: none');
    expect(output[0]).not.toContain('superseded');
  });

  test('실제 self-impl/…-goalid-<id>-… head 브랜치의 병합 PR 번호가 merged: 에 보인다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    const spawned: string[][] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      now: () => '2026-09-04T12:00:00.000Z',
      spawnGh: (args) => {
        spawned.push([...args]);
        expect(args.join(' ')).not.toContain('head:goalid-');
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              number: 102,
              headRefName: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea',
            },
            {
              number: 200,
              headRefName: 'self-impl/other-goalid-aaaaaaaaaaaaaaaa-root-deadbeef',
            },
          ]),
        };
      },
    };

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(spawned).toEqual([[
      'pr', 'list', '--state', 'merged', '--limit', '100', '--json', 'number,headRefName',
      '--search', 'merged:>=2026-09-01T00:00:01Z',
    ]]);
    expect(output[0]).toContain('goal 5245a3ea5a684476: #102 #101  superseded  old: #101  merged: #102');
    expect(output[0]).toMatch(/merged: #102/);
    expect(output[0]).not.toContain('lookup: incomplete');
  });

  test('같은 목이 그 골의 PR 을 하나도 안 내면 none 이고 incomplete 가 없다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    const spawned: string[][] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      now: () => '2026-09-04T12:00:00.000Z',
      spawnGh: (args) => {
        spawned.push([...args]);
        return {
          status: 0,
          stdout: JSON.stringify([{
            number: 200,
            headRefName: 'self-impl/other-goalid-aaaaaaaaaaaaaaaa-root-deadbeef',
          }]),
        };
      },
    };

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(spawned).toEqual([[
      'pr', 'list', '--state', 'merged', '--limit', '100', '--json', 'number,headRefName',
      '--search', 'merged:>=2026-09-01T00:00:01Z',
    ]]);
    expect(output[0]).toContain('goal 5245a3ea5a684476: #102 #101  lookup: none');
    expect(output[0]).toContain('#102');
    expect(output[0]).toContain('#101');
    expect(output[0]).not.toContain('lookup: incomplete');
    expect(output[0]).not.toContain('lookup: unavailable');
    expect(output[0]).not.toContain('superseded');
  });

  test('골마다 그 골의 개설일 창으로 좁히고 전역 목록 argv 는 쓰지 않는다', () => {
    const path = createStore('live', [
      {
        event: 'rework-blocked-draft-pr',
        data: {
          branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea',
          number: 102, url: 'https://pr/102', stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
        },
        ts: '2026-09-01T00:00:02.000Z',
      },
      {
        event: 'rework-blocked-draft-pr',
        data: {
          branch: 'self-impl/claude-plugin-package-elanous-goalid-b629a-a13b091f',
          number: 201, url: 'https://pr/201', stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
        },
        ts: '2026-09-04T08:00:00.000Z',
      },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    const spawned: string[][] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      now: () => '2026-09-04T12:00:00.000Z',
      spawnGh: (args) => {
        spawned.push([...args]);
        const search = args[args.indexOf('--search') + 1];
        const heads = search === 'merged:>=2026-09-04T08:00:00Z'
          ? [{ number: 201, headRefName: 'self-impl/claude-plugin-package-elanous-goalid-b629a-a13b091f' }]
          : [];
        return { status: 0, stdout: JSON.stringify(heads) };
      },
    };

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(spawned).toEqual([
      ['pr', 'list', '--state', 'merged', '--limit', '100', '--json', 'number,headRefName', '--search', 'merged:>=2026-09-04T08:00:00Z'],
      ['pr', 'list', '--state', 'merged', '--limit', '100', '--json', 'number,headRefName', '--search', 'merged:>=2026-09-01T00:00:02Z'],
    ]);
    expect(output[0]).toContain('goal b629a: #201  merged: #201');
    expect(output[0]).toContain('goal 5245a3ea5a684476: #102  lookup: none');
    expect(output[0]).not.toContain('lookup: incomplete');
  });

  test('좁힌 뒤에도 상한에 닿으면 lookup: incomplete 이다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      now: () => '2026-09-04T12:00:00.000Z',
      spawnGh: (args) => ({
        status: 0,
        stdout: JSON.stringify(mergedHeadFiller(ghLimit(args))),
      }),
    };

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(output[0]).toContain('goal 5245a3ea5a684476: #102 #101  lookup: incomplete');
    expect(output[0]).not.toContain('lookup: none');
  });

  test('첫 응답이 상한만큼 차고 뒤 응답에만 병합본이 있으면 superseded 가 보인다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    const spawned: string[][] = [];
    const mergedHead = {
      number: 102,
      headRefName: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea',
    };
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      now: () => '2026-09-04T12:00:00.000Z',
      spawnGh: (args) => {
        spawned.push([...args]);
        const limit = ghLimit(args);
        if (spawned.length === 1) {
          expect(limit).toBe(MERGED_PR_LIST_LIMIT);
          return { status: 0, stdout: JSON.stringify(mergedHeadFiller(MERGED_PR_LIST_LIMIT)) };
        }
        expect(limit).toBe(MERGED_PR_LIST_MAX_LIMIT);
        return {
          status: 0,
          stdout: JSON.stringify([...mergedHeadFiller(MERGED_PR_LIST_LIMIT), mergedHead]),
        };
      },
    };

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(spawned).toHaveLength(2);
    expect(output[0]).toContain('goal 5245a3ea5a684476: #102 #101  superseded  old: #101  merged: #102');
    expect(output[0]).not.toContain('lookup: incomplete');
  });

  test('모든 응답에 병합본이 없으면 골 id 와 PR 번호는 남고 superseded/incomplete 는 없다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    const spawned: string[][] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      now: () => '2026-09-04T12:00:00.000Z',
      spawnGh: (args) => {
        spawned.push([...args]);
        if (spawned.length === 1) {
          return { status: 0, stdout: JSON.stringify(mergedHeadFiller(MERGED_PR_LIST_LIMIT)) };
        }
        return { status: 0, stdout: JSON.stringify(mergedHeadFiller(MERGED_PR_LIST_LIMIT + 1)) };
      },
    };

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(spawned).toHaveLength(2);
    expect(output[0]).toContain('goal 5245a3ea5a684476: #102 #101');
    expect(output[0]).toContain('#102');
    expect(output[0]).toContain('#101');
    expect(output[0]).not.toContain('superseded');
    expect(output[0]).not.toContain('lookup: incomplete');
    expect(output[0]).not.toContain('lookup: unavailable');
  });

  test('끝까지 수집해도 상한에 닿으면 lookup: incomplete 이다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    const spawned: string[][] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      now: () => '2026-09-04T12:00:00.000Z',
      spawnGh: (args) => {
        spawned.push([...args]);
        return { status: 0, stdout: JSON.stringify(mergedHeadFiller(ghLimit(args))) };
      },
    };

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(spawned.map((args) => ghLimit(args))).toEqual([
      MERGED_PR_LIST_LIMIT,
      MERGED_PR_LIST_MAX_LIMIT,
    ]);
    expect(output[0]).toContain('goal 5245a3ea5a684476: #102 #101  lookup: incomplete');
    expect(output[0]).not.toContain('lookup: none');
  });

  test('옵션 없이 부르면 spawnGh 도 부르지 않는다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    let spawnCalls = 0;
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      spawnGh: () => {
        spawnCalls += 1;
        throw new Error('gh must not run by default');
      },
    };

    expect(runLogsAbandonedDraftPrs({}, deps)).toBe(0);
    expect(spawnCalls).toBe(0);
    expect(output[0]).not.toContain('looked up at:');
    expect(output[0]).not.toContain('merged:');
  });

  test('다른 골의 병합 PR 은 이 골을 superseded 로 만들지 않는다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    const deps = depsForLookup(
      [{ name: 'live', dbPath: path }],
      output,
      errors,
      () => [{
        number: 999,
        headRefName: 'self-impl/other-goalid-aaaaaaaaaaaaaaaa-root-deadbeef',
      }],
    );

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(output[0]).toContain('goal 5245a3ea5a684476: #102 #101  lookup: none');
    expect(output[0]).not.toContain('superseded');
  });

  test('superseded 판정은 병합 결과가 있을 때만 참이다', () => {
    const none = classifyMergedGoalLookup(
      { goalId: '5245a3ea5a684476', prNumbers: [102, 101] },
      [],
    );
    const merged = classifyMergedGoalLookup(
      { goalId: '5245a3ea5a684476', prNumbers: [102, 101] },
      [{ number: 102, headRefName: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea' }],
    );
    expect(none.state).toBe('none');
    expect(merged.state).toBe('merged');
    expect(merged.mergedPrNumbers).toEqual([102]);
    expect(merged.supersededPrNumbers).toEqual([101]);
    expect(none.state).not.toBe(merged.state);
  });

  test('병합만 있고 옛 판이 없으면 superseded 라고 쓰지 않는다', () => {
    const lookup = classifyMergedGoalLookup(
      { goalId: '5245a3ea5a684476', prNumbers: [102] },
      [{ number: 102, headRefName: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea' }],
    );
    expect(lookup).toEqual({
      state: 'merged',
      mergedPrNumbers: [102],
      supersededPrNumbers: [],
    });
    const rendered = renderAbandonedDraftPrs({
      abandoned: [{
        store: 'prod',
        number: 102, url: 'https://pr/102',
        branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea',
        openedAt: '2026-09-02T00:00:02.000Z', openedAtMs: 2,
        stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
      }],
      abandonedCount: 1,
      judged: { launched: 0, parked: 0, total: 0 },
      skipped: 0,
      stores: { count: 1, names: ['prod'], truncated: false, rowsCollected: 1, unreadable: 0 },
      goalGroups: [{ goalId: '5245a3ea5a684476', prNumbers: [102], lookup }],
      goalCount: 1,
      lookedUpAt: '2026-09-04T12:00:00.000Z',
    });
    expect(rendered).toContain('goal 5245a3ea5a684476: #102  merged: #102');
    expect(rendered).not.toContain('superseded');
  });
});

describe('parseMergedPrHeads', () => {
  test('잘못된 행은 incomplete 로 보존하고 none 이나 완전한 merged 로 단정하지 않는다', () => {
    const parsed = parseMergedPrHeads(JSON.stringify([
      { number: 102, headRefName: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea' },
      { number: 'bad' },
      { number: 103 },
    ]));
    expect(parsed).not.toBeNull();
    expect(parsed!.incomplete).toBe(true);
    expect(parsed!.heads).toEqual([{
      number: 102,
      headRefName: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea',
    }]);

    const classified = classifyMergedGoalLookup(
      { goalId: '5245a3ea5a684476', prNumbers: [102, 101] },
      parsed!.heads,
      { incomplete: parsed!.incomplete },
    );
    expect(classified.state).toBe('incomplete');
    expect(classified.state).not.toBe('none');
    expect(classified.state).not.toBe('merged');
  });

  test('잘린 목록에서 매칭이 없으면 none 이 아니라 incomplete 이다', () => {
    const heads: MergedPrHead[] = Array.from({ length: 100 }, (_, i) => ({
      number: 1000 + i,
      headRefName: `self-impl/other-goalid-aaaaaaaaaaaaaaaa-root-${i}`,
    }));
    const classified = classifyMergedGoalLookup(
      { goalId: '5245a3ea5a684476', prNumbers: [102, 101] },
      heads,
      { truncated: true },
    );
    expect(classified.state).toBe('incomplete');
    expect(classified.state).not.toBe('none');
  });

  test('listMergedPrHeads 는 headRefName 을 그대로 돌려 실제 브랜치 형식을 가른다', () => {
    const listed = listMergedPrHeads(() => ({
      status: 0,
      stdout: JSON.stringify([
        { number: 15444, headRefName: 'self-impl/logs-cli-goalid-c8ba2b8364ae16b7-root-abc' },
      ]),
    } satisfies SpawnGhResult));
    expect(listed.incomplete).toBeFalsy();
    expect(listed.heads).toEqual([
      { number: 15444, headRefName: 'self-impl/logs-cli-goalid-c8ba2b8364ae16b7-root-abc' },
    ]);
    expect(extractAbandonedDraftPrGoalId(listed.heads[0]!.headRefName)).toBe('c8ba2b8364ae16b7');
  });

  test('mergedSince 가 있으면 gh argv 에 날짜 창이 붙고 head 접두는 없다', () => {
    const seen: string[][] = [];
    listMergedPrHeads((args) => {
      seen.push([...args]);
      return { status: 0, stdout: '[]' };
    }, { mergedSince: '2026-09-01' });
    expect(seen).toEqual([[
      'pr', 'list', '--state', 'merged', '--limit', String(MERGED_PR_LIST_LIMIT),
      '--json', 'number,headRefName', '--search', 'merged:>=2026-09-01',
    ]]);
    expect(seen[0]!.join(' ')).not.toContain('head:goalid-');
  });

  test('첫 페이지가 차면 같은 창을 이어 묻고 뒤 페이지 행을 합친다', () => {
    const seen: string[][] = [];
    const later = {
      number: 15444,
      headRefName: 'self-impl/logs-cli-goalid-c8ba2b8364ae16b7-root-abc',
    };
    const listed = listMergedPrHeads((args) => {
      seen.push([...args]);
      if (seen.length === 1) {
        return { status: 0, stdout: JSON.stringify(mergedHeadFiller(MERGED_PR_LIST_LIMIT)) };
      }
      return {
        status: 0,
        stdout: JSON.stringify([...mergedHeadFiller(MERGED_PR_LIST_LIMIT), later]),
      };
    }, { mergedSince: '2026-09-01' });
    expect(seen).toEqual([
      ['pr', 'list', '--state', 'merged', '--limit', String(MERGED_PR_LIST_LIMIT),
        '--json', 'number,headRefName', '--search', 'merged:>=2026-09-01'],
      ['pr', 'list', '--state', 'merged', '--limit', String(MERGED_PR_LIST_MAX_LIMIT),
        '--json', 'number,headRefName', '--search', 'merged:>=2026-09-01'],
    ]);
    expect(seen.join(' ')).not.toContain('head:goalid-');
    expect(listed.truncated).toBeFalsy();
    expect(listed.incomplete).toBeFalsy();
    expect(listed.heads).toContainEqual(later);
  });

  test('최대 상한에 닿으면 truncated 이다', () => {
    const seen: string[][] = [];
    const listed = listMergedPrHeads((args) => {
      seen.push([...args]);
      return { status: 0, stdout: JSON.stringify(mergedHeadFiller(ghLimit(args))) };
    });
    expect(seen.map((args) => ghLimit(args))).toEqual([
      MERGED_PR_LIST_LIMIT,
      MERGED_PR_LIST_MAX_LIMIT,
    ]);
    expect(listed.truncated).toBe(true);
    expect(listed.heads.length).toBe(MERGED_PR_LIST_MAX_LIMIT);
  });

  test('mergedSinceFromAbandoned 는 가장 오래된 개설 시각의 UTC ISO 다', () => {
    expect(mergedSinceFromAbandoned([])).toBeUndefined();
    expect(mergedSinceFromAbandoned([
      { openedAtMs: Date.parse('2026-09-03T11:00:00.000Z') },
      { openedAtMs: Date.parse('2026-09-01T22:31:00.000Z') },
      { openedAtMs: Date.parse('2026-09-02T08:00:00.000Z') },
    ])).toBe('2026-09-01T22:31:00Z');
  });

  test('명령 경로에서 불완전 응답은 lookup: incomplete 로 보인다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      now: () => '2026-09-04T12:00:00.000Z',
      spawnGh: () => ({
        status: 0,
        stdout: JSON.stringify([
          { number: 102, headRefName: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea' },
          { number: 103 },
        ]),
      }),
    };

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(output[0]).toContain('goal 5245a3ea5a684476: #102 #101  lookup: incomplete');
    expect(output[0]).not.toContain('lookup: none');
    expect(output[0]).not.toContain('superseded');
  });

  test('spawnGh 실패는 명령을 죽이지 않고 unavailable 을 값으로 남긴다', () => {
    const path = createTwoVersionGoalStore();
    const output: string[] = [];
    const errors: string[] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      now: () => '2026-09-04T12:00:00.000Z',
      spawnGh: () => ({ status: 1, stdout: '', stderr: 'gh: not authenticated' }),
    };

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(output[0]).toContain('goal 5245a3ea5a684476: #102 #101  lookup: unavailable');
    expect(output[0]).not.toContain('lookup: none');
    expect(output[0]).not.toContain('superseded');
  });

  test('병합만 있는 골은 명령 산출에 superseded 가 없다', () => {
    const path = createStore('live', [
      {
        event: 'rework-blocked-draft-pr',
        data: {
          branch: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea',
          number: 102, url: 'https://pr/102', stage: 'review-blocked', verdict: 'UNCONVERGEABLE', runId: null,
        },
        ts: '2026-09-01T00:00:02.000Z',
      },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      now: () => '2026-09-04T12:00:00.000Z',
      spawnGh: () => ({
        status: 0,
        stdout: JSON.stringify([{
          number: 102,
          headRefName: 'self-impl/plugin-rich-goalid-5245a3ea5a684476-root-92346dea',
        }]),
      }),
    };

    expect(runLogsAbandonedDraftPrs({ lookupMerged: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(output[0]).toContain('goal 5245a3ea5a684476: #102  merged: #102');
    expect(output[0]).not.toContain('superseded');
  });
});


describe('runLogsAbandonedDraftPrs — count-domain-gap', () => {
  test('옵션 없이 기존 산출을 그대로 내고 열린 draft 조회를 부르지 않는다', () => {
    const path = createStore('live', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/open', number: 10 }, ts: '2026-09-01T00:00:01.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    let calls = 0;
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      lookupOpenDraftPrs: () => { calls += 1; throw new Error('must remain offline'); },
    };

    expect(runLogsAbandonedDraftPrs({}, deps)).toBe(0);
    expect(calls).toBe(0);
    expect(errors).toEqual([]);
    expect(output[0]).toBe([
      'abandoned draft PRs: 1  goals: 1  judged: launched=0 parked=0  skipped=0',
      'stores: 1  truncated: no  unreadable=0  rows=1',
      `population events: ${QUERY_EVENTS.join(', ')}`,
      `limitation: ${ABANDONED_DRAFT_PRS_LIMITATION}`,
      '현재 상태 병합됨 0 · 닫힘 0 · 열림 0 · 안 물어봤다 1 · 못 쟀다 0 · 지금 볼 것 0',
      '#10  live  self-impl/open  2026-09-01T00:00:01.000Z  stage=(none)  verdict=(none) · 현재 상태=notLookedUp',
    ].join('\n'));
    expect(output[0]).not.toContain('정의역');
  });

  test('열린 draft 넷 중 후보 하나만 이으면 못 이은 셋과 번호만 낸다', () => {
    const path = createStore('live', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/open', number: 10, url: 'https://github.com/acme/repo/pull/10' }, ts: '2026-09-01T00:00:01.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      lookupOpenDraftPrs: () => [10, 11, 12, 13].map((number) => ({ number, url: `https://github.com/acme/repo/pull/${number}` })),
    };

    expect(runLogsAbandonedDraftPrs({ countDomainGap: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(output[0]).toContain('정의역 — 현재 저장소의 열린 draft 전체 4 · 이 자가 이은 것 1 · 못 이은 것 3');
    const unmatchedLine = output[0]!.split('\n').find((line) => line.startsWith('못 이은 PR:'));
    expect(unmatchedLine).toBe('못 이은 PR: #11 #12 #13');
    expect(unmatchedLine).not.toContain('self-impl');
  });

  test('못 이은 것이 없으면 목록 줄을 생략하고 현재 open 상태 후보도 잇는다', () => {
    const path = createStore('live', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/open', number: 10, url: 'https://github.com/acme/repo/pull/10' }, ts: '2026-09-01T00:00:01.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'live', dbPath: path }], output, errors),
      lookupCurrentStatus: () => 'open',
      lookupOpenDraftPrs: () => [{ number: 10, url: 'https://github.com/acme/repo/pull/10' }],
    };

    expect(runLogsAbandonedDraftPrs({ countDomainGap: true, lookupCurrentStatus: true }, deps)).toBe(0);
    expect(output[0]).toContain('정의역 — 현재 저장소의 열린 draft 전체 1 · 이 자가 이은 것 1 · 못 이은 것 0');
    expect(output[0]).not.toContain('못 이은 PR:');

    output.length = 0;
    expect(runLogsAbandonedDraftPrs(
      { countDomainGap: true, lookupCurrentStatus: true },
      { ...deps, lookupCurrentStatus: () => 'closed' },
    )).toBe(0);
    expect(output[0]).toContain('정의역 — 현재 저장소의 열린 draft 전체 1 · 이 자가 이은 것 1 · 못 이은 것 0');
    expect(output[0]).not.toContain('못 이은 PR:');

    output.length = 0;
    expect(runLogsAbandonedDraftPrs(
      { countDomainGap: true, lookupCurrentStatus: true },
      { ...deps, lookupCurrentStatus: () => 'merged' },
    )).toBe(0);
    expect(output[0]).toContain('정의역 — 현재 저장소의 열린 draft 전체 1 · 이 자가 이은 것 1 · 못 이은 것 0');
    expect(output[0]).not.toContain('못 이은 PR:');
  });

  test('역사 후보의 다른 저장소 동번호는 현재 저장소 draft와 이어지지 않는다', () => {
    const path = createStore('history', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/old', number: 10, url: 'https://github.com/acme/history/pull/10' }, ts: '2026-09-01T00:00:01.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'history', dbPath: path }], output, errors),
      lookupOpenDraftPrs: () => [{ number: 10, url: 'https://github.com/acme/current/pull/10' }],
    };

    expect(runLogsAbandonedDraftPrs({ countDomainGap: true }, deps)).toBe(0);
    expect(output[0]).toContain('정의역 — 현재 저장소의 열린 draft 전체 1 · 이 자가 이은 것 0 · 못 이은 것 1');
    expect(output[0]).toContain('못 이은 PR: #10');
  });

  test('url 없는 후보는 번호로 잇되 명시적 다른 저장소 후보는 잇지 않는다', () => {
    const path = createStore('history', [
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/no-url', number: 10 }, ts: '2026-09-01T00:00:01.000Z' },
      { event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/other-repo', number: 11, url: 'https://github.com/acme/history/pull/11' }, ts: '2026-09-01T00:00:02.000Z' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([{ name: 'history', dbPath: path }], output, errors),
      lookupOpenDraftPrs: () => [
        { number: 10, url: 'https://github.com/acme/current/pull/10' },
        { number: 11, url: 'https://github.com/acme/current/pull/11' },
      ],
    };

    expect(runLogsAbandonedDraftPrs({ countDomainGap: true }, deps)).toBe(0);
    expect(output[0]).toContain('정의역 — 현재 저장소의 열린 draft 전체 2 · 이 자가 이은 것 1 · 못 이은 것 1');
    expect(output[0]).toContain('못 이은 PR: #11');
  });

  test('전체 페이지 API 조회기는 1000개를 넘어도 열린 draft를 모두 읽는다', () => {
    const drafts = lookupOpenDraftPrs((args) => {
      expect(args).toEqual(['api', '--paginate', '--slurp', '/repos/{owner}/{repo}/pulls?state=open&per_page=100', '-H', 'Accept: application/vnd.github+json']);
      return {
        status: 0,
        stdout: JSON.stringify([Array.from({ length: 1000 }, (_, index) => ({
          number: index + 1,
          html_url: `https://github.com/acme/repo/pull/${index + 1}`,
          draft: true,
        })), [{
          number: 1001,
          html_url: 'https://github.com/acme/repo/pull/1001',
          draft: true,
        }]]),
        stderr: '',
      };
    });
    expect(drafts).toHaveLength(1001);
    expect(drafts.at(-1)).toEqual({ number: 1001, url: 'https://github.com/acme/repo/pull/1001' });
  });

  test('조회 오류는 0이 아니라 한 줄 사유와 함께 못 쟀다로 낸다', () => {
    const output: string[] = [];
    const errors: string[] = [];
    const deps: LogsAbandonedDraftPrsDeps = {
      ...depsFor([], output, errors),
      lookupOpenDraftPrs: () => { throw new Error('gh unavailable\nretry later'); },
    };

    expect(runLogsAbandonedDraftPrs({ countDomainGap: true }, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(output[0]).toContain('정의역 — 못 쟀다 (gh 조회 실패: gh unavailable)');
    expect(output[0]).not.toContain('못 이은 것 0');
  });
});

describe('repoSlugFromPrUrl — 저장소는 PR 자신의 url 에서 온다', () => {
  test('url 에서 owner/repo 를 뽑는다', () => {
    expect(repoSlugFromPrUrl('https://github.com/ElanvitalAI/elanous-harness-e2e/pull/3')).toBe('ElanvitalAI/elanous-harness-e2e');
    expect(repoSlugFromPrUrl('https://github.com/ElanvitalAI/elanous/pull/19323')).toBe('ElanvitalAI/elanous');
  });
  test('없거나 모양이 아니면 null 이다 — ⛔ 「기본 저장소」로 접지 않는다', () => {
    expect(repoSlugFromPrUrl(null)).toBeNull();
    expect(repoSlugFromPrUrl(undefined)).toBeNull();
    expect(repoSlugFromPrUrl('')).toBeNull();
    expect(repoSlugFromPrUrl('not a url')).toBeNull();
    expect(repoSlugFromPrUrl('https://github.com/ElanvitalAI/elanous/issues/3')).toBeNull();
  });
  test('조회기는 후보 url 에서 각각의 저장소를 유도한다', () => {
    const seen: string[][] = [];
    const spawnGh = (args: readonly string[]) => {
      seen.push([...args]);
      return { status: 0, stdout: JSON.stringify({ state: 'OPEN', mergedAt: null }), stderr: '' } as never;
    };
    const candidates = [
      { number: 3, url: 'https://github.com/ElanvitalAI/elanous-harness-e2e/pull/3' },
      { number: 19323, url: 'https://github.com/ElanvitalAI/elanous/pull/19323' },
    ] as Parameters<LookupCurrentDraftPrStatus>[0][];
    for (const candidate of candidates) expect(lookupCurrentPrStatus(candidate, spawnGh)).toBe('open');
    expect(seen).toEqual([
      ['pr', 'view', '3', '--repo', 'ElanvitalAI/elanous-harness-e2e', '--json', 'state,mergedAt'],
      ['pr', 'view', '19323', '--repo', 'ElanvitalAI/elanous', '--json', 'state,mergedAt'],
    ]);
  });
  test('lookupCurrentPrStatus accepts lowercase and uppercase states while mergedAt remains first', () => {
    const candidate = { number: 9, url: null } as AbandonedDraftPr;
    const response = (state: string, mergedAt: string | null) => () => ({
      status: 0, stdout: JSON.stringify({ state, mergedAt }), stderr: '',
    }) as never;

    expect(lookupCurrentPrStatus(candidate, response('open', null))).toBe('open');
    expect(lookupCurrentPrStatus(candidate, response('OPEN', null))).toBe('open');
    expect(lookupCurrentPrStatus(candidate, response('MERGED', null))).toBe('merged');
    expect(lookupCurrentPrStatus(candidate, response('OPEN', '2026-09-21T00:00:00.000Z'))).toBe('merged');
  });

  test('url 이 없으면 --repo 를 «안» 붙인다 (종전 동작 보존)', () => {
    const seen: string[][] = [];
    const spawnGh = (args: readonly string[]) => {
      seen.push([...args]);
      return { status: 0, stdout: JSON.stringify({ state: 'CLOSED', mergedAt: null }), stderr: '' } as never;
    };
    expect(lookupCurrentPrStatus({ number: 9, url: null } as AbandonedDraftPr, spawnGh)).toBe('closed');
    expect(seen[0]).toEqual(['pr', 'view', '9', '--json', 'state,mergedAt']);
  });
  test('applyCurrentStatus 는 후보 전체를 lookup 에 넘기고 caller repository 인자가 남지 않는다', () => {
    const calls: Array<Pick<AbandonedDraftPr, 'number' | 'url'>> = [];
    const prs = [
      { number: 3, url: 'https://github.com/ElanvitalAI/elanous-harness-e2e/pull/3' },
      { number: 19323, url: 'https://github.com/ElanvitalAI/elanous/pull/19323' },
      { number: 7, url: null },
    ] as never as Parameters<typeof applyCurrentStatus>[0];
    applyCurrentStatus(prs, (candidate) => { calls.push({ number: candidate.number, url: candidate.url }); return 'open'; });
    expect(calls).toEqual([
      { number: 3, url: 'https://github.com/ElanvitalAI/elanous-harness-e2e/pull/3' },
      { number: 19323, url: 'https://github.com/ElanvitalAI/elanous/pull/19323' },
      { number: 7, url: null },
    ]);
    const source = readFileSync(new URL('./logs-abandoned-draft-prs.ts', import.meta.url), 'utf8');
    expect(source).toContain('export type LookupCurrentDraftPrStatus =');
    expect(source).not.toContain('lookupCurrentStatus(pr.number,');
    expect(source).not.toContain('lookupCurrentPrStatus(number, deps.spawnGh, repo)');
  });
});
