import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindingPhrase, bindingResource, computeVerdict, okCell, renderOverview, unmeasured, unmeasuredCells, verdictExitCode, type OverviewSnapshot } from './overview.js';
import { collectOverview, launchableCells, ownerRows, parseEtime, parseSince, summarizeParents } from './overview-collect.js';
import { lineTime, parseDispatcherCapacity, readDispatcherBeats, readDispatcherCapacity, readSeatEraHanded } from './overview-seat-era.js';
import { createOverviewCache } from './overview-cache.js';
import { utimesSync } from 'node:fs';
import type { Checklist, ChecklistItem } from '../release-loop/checklist.js';
import type { TaskCard } from '../task-agent/task-hand.js';
import { measureLandingThroughput } from '../task-agent/cover.js';
import { LogStore, logsDbPath } from '../mss/logging/log-store.js';
import { ResourceLedger, type ResourceView } from '../control-plane/ledger.js';
import { measureLoad, startMemberHeartbeat } from '../control-plane/member.js';
import { openSchedulesDb, schedulesDbPath } from '../domains/schedule-registry.js';
import { runOpsOverview } from '../cli/ops-overview-cli.js';
import { buildGridData } from '../nexus/api/grid.js';
import { measurePoolLease } from '../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool } from '../task-orchestrator/surfaces/pod-pool.js';

const AT = '2026-10-08T00:30:00.000Z';

function base(): OverviewSnapshot {
  return {
    generatedAt: AT, instanceRoot: '/x', since: '최근 1h',
    release: {
      version: okCell('0.2.21', 't', AT),
      run: okCell({ runId: 'abcdef123', status: 'done', currentNode: null, startedAt: AT, waitingOn: 'none' as const, elapsedMinutes: 3 }, 't', AT),
      schedule: okCell({ cutAt: AT, landBy: AT, publishAt: null, freezeNow: false }, 't', AT),
      checklist: okCell({ green: 1, yellow: 2, red: 0, done: 0, p0Yellow: 1 }, 't', AT),
    },
    tasks: {
      byOwner: okCell({}, 't', AT),
      done: unmeasured('t', 'not yet'),
      launchable: okCell({ count: 2, ids: ['A', 'B'], skipped: { noTargetPath: 0, predecessorOpen: 0, alreadyHanded: 0 }, interim: true as const }, 't', AT),
      capacity: okCell({ podUsed: 10, podTarget: 46, localUsed: 0, localMax: 0, free: 36 }, 't', AT),
    },
    machines: { hosts: [], pods: [], parents: okCell({ count: 3, staleOver6h: 0, oldestHours: 1 }, 't', AT) },
    landings: okCell({ count: 4, recent: [] }, 't', AT),
    loops: [],
  };
}

describe('computeVerdict — 판정 순서(RFC §A1)', () => {
  test('흐름 정상', () => {
    const v = computeVerdict(base());
    expect(v.verdict).toBe('flowing');
    expect(verdictExitCode(v.verdict)).toBe(0);
  });
  test('관측 불가 — 용량 못 잼은 0 으로 읽지 않는다(공급 부족·포화 둘 다 안 낸다)', () => {
    const s = base();
    s.tasks.capacity = unmeasured('feeder', '디스패처 로그 없음');
    s.tasks.launchable = okCell({ ...s.tasks.launchable.value!, count: 0 }, 't', AT);
    const v = computeVerdict(s);
    expect(v.verdict).toBe('unobservable');
    expect(v.reasons[0]).toContain('디스패처 로그 없음');
    expect(v.reasons.join('\n')).not.toContain('공급 부족');
    expect(verdictExitCode(v.verdict)).toBe(3);
  });
  test('막힘 — 발행 런 승인 대기가 루프 정지·포화보다 이긴다', () => {
    const s = base();
    s.release.run = okCell({ runId: 'r1', status: 'running', currentNode: 'approve-publish', startedAt: AT, waitingOn: 'approval' as const, elapsedMinutes: 14 }, 't', AT);
    s.tasks.capacity = okCell({ podUsed: 46, podTarget: 46, localUsed: 1, localMax: 0, free: 0 }, 't', AT);
    s.loops = [{ name: 'dispatcher-OP', era: 'seat-era', staleAfterSeconds: 600, beat: okCell({ lastAt: AT, ageSeconds: 10, alive: false }, 't', AT) }];
    const v = computeVerdict(s);
    expect(v.verdict).toBe('blocked');
    expect(v.reasons[0]).toContain('승인 대기 14분');
    expect(v.reasons.some((r) => r.startsWith('(+루프 정지)'))).toBe(true);
    expect(v.reasons.some((r) => r.startsWith('(+자원 포화)'))).toBe(true);
  });
  test('막힘 — 동결 창', () => {
    const s = base();
    s.release.schedule = okCell({ cutAt: AT, landBy: AT, publishAt: null, freezeNow: true }, 't', AT);
    expect(computeVerdict(s).verdict).toBe('blocked');
  });
  test('루프 정지 — 프로세스 없음 · 박동 끊김 · 주기 미상은 판정 제외', () => {
    const s = base();
    s.loops = [{ name: 'orchestrator', era: 'product', staleAfterSeconds: null, beat: okCell({ lastAt: AT, ageSeconds: 99_999, alive: null }, 't', AT) }];
    expect(computeVerdict(s).verdict).toBe('flowing');
    s.loops.push({ name: 'dispatcher-OP', era: 'seat-era', staleAfterSeconds: 660, beat: okCell({ lastAt: AT, ageSeconds: 3600, alive: true }, 't', AT) });
    const v = computeVerdict(s);
    expect(v.verdict).toBe('loop-down');
    expect(v.reasons[0]).toContain('자리 시대 원천');
  });
  test('루프 원장 못 잼은 «죽었다»가 아니다', () => {
    const s = base();
    s.loops = [{ name: 'steward', era: 'product', staleAfterSeconds: 60, beat: unmeasured('x', '원장 없음') }];
    expect(computeVerdict(s).verdict).toBe('flowing');
  });
  test('자원 포화 — 발사 가능 > 0 ∧ 빈 자리 0', () => {
    const s = base();
    s.tasks.capacity = okCell({ podUsed: 47, podTarget: 46, localUsed: 1, localMax: 0, free: 0 }, 't', AT);
    const v = computeVerdict(s);
    expect(v.verdict).toBe('saturated');
    expect(v.reasons[0]).toContain('Pod 47/46');
  });
  test('공급 부족 — 빈 자리 > 0 ∧ 발사 가능 0 · 사유 분해', () => {
    const s = base();
    s.tasks.launchable = okCell({ count: 0, ids: [], skipped: { noTargetPath: 29, predecessorOpen: 7, alreadyHanded: 5 }, interim: true as const }, 't', AT);
    const v = computeVerdict(s);
    expect(v.verdict).toBe('supply-empty');
    expect(v.reasons[0]).toContain('대상 경로 없음 29 · 선행 미완 7 · 이미 넘김 5');
  });
  test('흐름 저하 — 묵은 부모 · 기계 압박(exit 0)', () => {
    const s = base();
    s.machines.parents = okCell({ count: 68, staleOver6h: 3, oldestHours: 19 }, 't', AT);
    s.machines.hosts = [{ name: 'mbp', load: okCell({ load1: 120, load5: 100, load15: 90, cpuCount: 18, freeGb: 5, totalGb: 128, ageSeconds: 5 }, 't', AT) }];
    const v = computeVerdict(s);
    expect(v.verdict).toBe('degraded');
    expect(v.reasons).toContain('6시간 넘은 하니스 부모 3(최고 19h)');
    expect(v.reasons).toContain('mbp 부하 100/18코어(5분)');
    expect(v.reasons).toContain('구속 자원 mbp CPU — 남은 비율 최소 0% (0/54코어(압박선 3/코어))');
    expect(verdictExitCode(v.verdict)).toBe(0);
  });
});

describe('자원 지도 구속 조건 — 남은 비율 최소 축(RES-FLOOR-BINDING)', () => {
  const host = (name: string, load5: number, cpuCount: number, freeGb: number, totalGb: number) => ({
    name, load: okCell({ load1: load5, load5, load15: load5, cpuCount, freeGb, totalGb, ageSeconds: 5 }, 't', AT),
  });
  test('10-08 표본 형태 — node-b 메모리가 남은 비율 최소라 구속 자원으로 뽑는다', () => {
    const s = base();
    s.machines.hosts = [host('mbp', 25, 18, 90, 128), host('node-b', 8, 8, 5, 64)];
    const b = bindingResource(s);
    expect(b?.kind).toBe('memory');
    expect(b?.label).toBe('node-b 메모리');
    expect(b?.remainingRatio).toBeCloseTo(5 / 64, 5);
    expect(bindingPhrase(b)).toBe('구속 자원 node-b 메모리 — 남은 비율 최소 8% (5/64GB)');
    const text = renderOverview(s, computeVerdict(s), { elapsedMs: 12 });
    expect(text).toContain('✅ 흐름 정상 (flowing)\n   ↳ 구속 자원 node-b 메모리 — 남은 비율 최소 8% (5/64GB)');
  });
  test('10-08 node-b 포화 표본 — Pod 47/46이면 슬롯 0%가 메모리 8/512GB보다 구속적이다', () => {
    const s = base();
    s.machines.hosts = [host('node-b', 19, 32, 8, 512)]; // 계획 §S 표본 CPU 19/32코어
    s.tasks.capacity = okCell({ podUsed: 47, podTarget: 46, localUsed: 0, localMax: 0, free: 0 }, 't', AT);
    const binding = bindingResource(s);
    expect(binding).toMatchObject({ kind: 'slots', remainingRatio: 0 });
    const verdict = computeVerdict(s);
    expect(verdict.verdict).toBe('saturated');
    expect(verdict.reasons).toContain('구속 자원 슬롯 — 남은 비율 최소 0% (0/46자리)');
    expect(renderOverview(s, verdict, { elapsedMs: 12 })).toContain('자원 포화 (saturated)');
  });

  test('같은 node-b 표본에서 슬롯만 여유가 있으면 메모리 8/512GB가 구속 축이다', () => {
    const s = base();
    s.machines.hosts = [host('node-b', 19, 32, 8, 512)];
    s.tasks.capacity = okCell({ podUsed: 45, podTarget: 46, localUsed: 0, localMax: 0, free: 1 }, 't', AT);
    const binding = bindingResource(s);
    expect(binding?.kind).toBe('memory');
    expect(binding?.label).toBe('node-b 메모리');
    expect(binding?.remainingRatio).toBeCloseTo(8 / 512, 5);
    const verdict = computeVerdict(s);
    expect(verdict.verdict).toBe('flowing');
    expect(verdict.reasons).toContain('구속 자원 node-b 메모리 — 남은 비율 최소 2% (8/512GB)');
    expect(renderOverview(s, verdict, { elapsedMs: 12 })).toContain('구속 자원 node-b 메모리');
  });

  test('잘못된 축 수치는 후보에서 제외해 유효한 node-b 메모리가 구속 조건이 된다', () => {
    const s = base();
    s.machines.hosts = [
      { name: 'bad', load: okCell({ load1: 1, load5: Number.NaN, load15: 1, cpuCount: 8, freeGb: 1, totalGb: Number.POSITIVE_INFINITY, ageSeconds: 5 }, 't', AT) },
      host('node-b', 8, 8, 5, 64),
    ];
    expect(bindingResource(s)).toMatchObject({ kind: 'memory', label: 'node-b 메모리', remainingRatio: 5 / 64 });
  });
  test('CPU 남은 비율은 압박선 기준 — 압박선에 닿으면 0%', () => {
    const s = base();
    s.machines.hosts = [host('mbp', 54, 18, 90, 128)];
    const b = bindingResource(s);
    expect(b?.kind).toBe('cpu');
    expect(b?.remainingRatio).toBe(0);
    expect(bindingPhrase(b)).toBe('구속 자원 mbp CPU — 남은 비율 최소 0% (0/54코어(압박선 3/코어))');
  });
  test('소수 CPU 부하 — 양수 잔량 0.4코어를 0으로 표시하지 않는다', () => {
    const s = base();
    s.machines.hosts = [host('mbp', 53.6, 18, 90, 128)];
    const b = bindingResource(s);
    expect(b?.kind).toBe('cpu');
    expect(b?.remainingRatio).toBeCloseTo(0.4 / 54, 5);
    expect(bindingPhrase(b)).toBe('구속 자원 mbp CPU — 남은 비율 최소 1% (0.4/54코어(압박선 3/코어))');
    expect(renderOverview(s, computeVerdict(s), { elapsedMs: 12 })).toContain('구속 자원 mbp CPU — 남은 비율 최소 1% (0.4/54코어(압박선 3/코어))');
  });
  test('소수 메모리 잔량 — 양수 0.4GB를 0으로 표시하지 않는다', () => {
    const s = base();
    s.machines.hosts = [host('node-b', 8, 8, 0.4, 64)];
    const b = bindingResource(s);
    expect(b?.kind).toBe('memory');
    expect(b?.remainingRatio).toBeCloseTo(0.4 / 64, 5);
    expect(bindingPhrase(b)).toBe('구속 자원 node-b 메모리 — 남은 비율 최소 1% (0.4/64GB)');
    expect(renderOverview(s, computeVerdict(s), { elapsedMs: 12 })).toContain('구속 자원 node-b 메모리 — 남은 비율 최소 1% (0.4/64GB)');
  });
  test('CPU 압박선 초과 — 남은 비율과 표기 잔량 모두 0', () => {
    const s = base();
    s.machines.hosts = [host('mbp', 100, 18, 90, 128)];
    const b = bindingResource(s);
    expect(b?.kind).toBe('cpu');
    expect(b?.remainingRatio).toBe(0);
    expect(bindingPhrase(b)).toBe('구속 자원 mbp CPU — 남은 비율 최소 0% (0/54코어(압박선 3/코어))');
    expect(computeVerdict(s).verdict).toBe('degraded');
    expect(renderOverview(s, computeVerdict(s), { elapsedMs: 12 })).toContain('구속 자원 mbp CPU — 남은 비율 최소 0% (0/54코어(압박선 3/코어))');
  });
  test('못 잰 축은 후보에서 뺀다 — 호스트 없으면 슬롯, 용량까지 못 잼이면 null', () => {
    expect(bindingResource(base())?.kind).toBe('slots');
    const s = base();
    s.tasks.capacity = unmeasured('feeder', '디스패처 로그 없음');
    expect(bindingResource(s)).toBeNull();
    expect(bindingPhrase(bindingResource(s))).toBeNull();
  });
  test('동율은 정해진 축 순서의 첫 축이 이긴다', () => {
    const s = base();
    s.machines.hosts = [host('a', 0, 8, 32, 64), host('b', 0, 8, 32, 64)];
    expect(bindingResource(s)?.label).toBe('a 메모리');
  });
  const psiHost = (name: string, someAvg10: number, fullAvg10: number, freeGb = 60) => ({
    name,
    load: okCell({ load1: 1, load5: 1, load15: 1, cpuCount: 8, freeGb, totalGb: 64, ageSeconds: 5, ioPressure: { someAvg10, fullAvg10 } }, 't', AT),
  });
  const roomyCapacity = () => okCell({ podUsed: 1, podTarget: 10, localUsed: 0, localMax: 2, free: 11 }, 't', AT);
  test('I/O 압박 축 — 하트비트 PSI 가 남은 비율 최소면 구속 자원으로 뽑는다', () => {
    const s = base();
    s.tasks.capacity = roomyCapacity();
    s.machines.hosts = [psiHost('node-b', 96, 61)];
    const b = bindingResource(s);
    expect(b?.kind).toBe('io');
    expect(b?.label).toBe('node-b I/O');
    expect(b?.remainingRatio).toBeCloseTo(0.04, 5);
    expect(bindingPhrase(b)).toBe('구속 자원 node-b I/O — 남은 비율 최소 4% (4/100(압박 96% · full 61% · 10초 평균))');
    expect(renderOverview(s, computeVerdict(s), { elapsedMs: 12 }))
      .toContain('↳ 구속 자원 node-b I/O — 남은 비율 최소 4% (4/100(압박 96% · full 61% · 10초 평균))');
  });
  test('I/O 가 넉넉하면 축 순서상 메모리가 이긴다 — I/O 는 늘 후보지만 이기지 않는다', () => {
    const s = base();
    s.tasks.capacity = roomyCapacity();
    s.machines.hosts = [psiHost('node-b', 5, 1, 5)];
    expect(bindingResource(s)?.label).toBe('node-b 메모리');
  });
  test('못 잰 I/O(null·항목 없음)는 «넉넉»이 아니라 후보 제외 — 슬롯이 이긴다', () => {
    for (const ioPressure of [null, undefined]) {
      const s = base();
      s.tasks.capacity = roomyCapacity();
      s.machines.hosts = [{ name: 'node-b', load: okCell({ load1: 1, load5: 1, load15: 1, cpuCount: 8, freeGb: 60, totalGb: 64, ageSeconds: 5, ioPressure }, 't', AT) }];
      expect(bindingResource(s)?.label).toBe('슬롯');
    }
  });
  test('포화 띠에 구속 문구가 둘째 사유로 붙는다 — 첫 문면은 그대로', () => {
    const s = base();
    s.tasks.capacity = okCell({ podUsed: 46, podTarget: 46, localUsed: 1, localMax: 0, free: 0 }, 't', AT);
    s.machines.hosts = [host('node-b', 8, 8, 5, 64)];
    const v = computeVerdict(s);
    expect(v.verdict).toBe('saturated');
    expect(v.reasons[0]).toBe('발사 가능 칸 2 · 빈 자리 0 (Pod 46/46 · 로컬 1/0)');
    expect(v.reasons[1]).toBe('구속 자원 슬롯 — 남은 비율 최소 0% (0/46자리)');
  });
});

describe('표기 — 못 잼은 0 이 아니다', () => {
  test('사람 표기에 못 잼(사유) · unmeasuredCells 가 이름을 낸다', () => {
    const s = base();
    s.machines.hosts = [{ name: 'node-c', load: unmeasured('ledger', '하트비트 없음') }];
    const text = renderOverview(s, computeVerdict(s), { elapsedMs: 12 });
    expect(text).toContain('node-c 못 잼(하트비트 없음)');
    expect(text).toContain('끝 못 잼(not yet)');
    expect(text).not.toContain('스케줄(최근 1시간)');
    expect(unmeasuredCells(s)).toEqual(['tasks.done: not yet', 'machines.node-c: 하트비트 없음']);
    expect(text.split('\n')[0]).toBe('✅ 흐름 정상 (flowing)');
    expect(text).not.toContain('처리량(');
  });

  test('optional throughput adds one line and unmeasured throughput remains explicit', () => {
    const s = base();
    s.throughput = okCell(measureLandingThroughput({
      taskAgentActions: [], liveLandMoves: [], allLands: [], launched: 327, cardPrs: 10, pendingLandingAgeSeconds: [],
    }), 'daily launch/PR/TASK-AGENT sources', AT);
    const rendered = renderOverview(s, computeVerdict(s), { elapsedMs: 12 });
    expect(rendered).toContain('처리량(1d) 발사 327 → 카드 PR 10 → TA 착지 0');
    expect(rendered.match(/처리량\(/g)).toHaveLength(1);

    s.throughput = unmeasured('daily throughput', 'launch source unavailable');
    const unknown = renderOverview(s, computeVerdict(s), { elapsedMs: 12 });
    expect(unknown).toContain('못 잼(launch source unavailable) [daily throughput]');
    expect(unmeasuredCells(s)).toContain('throughput: launch source unavailable');
  });
});

describe('수집 조각', () => {
  const item = (id: string, status: ChecklistItem['status'], title: string, predecessors?: string[]): ChecklistItem =>
    ({ id, status, title, updatedAt: AT, updatedBy: 't', ...(predecessors ? { predecessors } : {}) });
  test('발사 가능 임시 술어', () => {
    const cl: Checklist = { version: '0.2.21', released: '', dev: '', history: [], items: [
      item('A', 'yellow', '대상 경로: src/a.ts'), item('B', 'yellow', '경로 없음'), item('C', 'yellow', '대상 경로: x', ['D']),
      item('D', 'yellow', '대상 경로: y'), item('E', 'yellow', '대상 경로: z'), item('F', 'green', '대상 경로: q'),
    ] };
    const r = launchableCells([cl], new Set(['E']));
    expect(r.ids).toEqual(['A', 'D']);
    expect(r.skipped).toEqual({ noTargetPath: 1, predecessorOpen: 1, alreadyHanded: 1 });
  });
  test('owner 행 — 오늘 이후 · 상태별 · owner 거르기', () => {
    const card = (id: string, seat: TaskCard['seat'], status: TaskCard['status'], createdAt: string, pr = false): TaskCard =>
      ({ id, text: '', seat, status, createdAt, history: pr ? [{ at: createdAt, event: 'pr-bound' }] : [] } as TaskCard);
    const cards = [card('1', 'TC', 'launched', AT, true), card('2', 'TC', 'failed', AT), card('3', 'OP', 'handed', AT), card('4', 'TC', 'launched', '2026-10-01T00:00:00Z')];
    expect(ownerRows(cards, '2026-10-07T15:00:00.000Z')).toEqual({
      'seat:TC': { handed: 0, launched: 1, prBound: 1, failed: 1, launchFailed: 0 },
      'seat:OP': { handed: 1, launched: 0, prBound: 0, failed: 0, launchFailed: 0 },
    });
    expect(Object.keys(ownerRows(cards, '2026-10-07T15:00:00.000Z', 'TC'))).toEqual(['seat:TC']);
  });
  test('etime · 하니스 부모 요약', () => {
    expect(parseEtime('01:02')).toBe(62);
    expect(parseEtime('1-02:00:00')).toBe(93600);
    const ps = [' 19:00:01 bun /x/current/bin/elanous.mjs harness say do it', '    05:00 bun bin/elanous.mjs harness ask docs/goals/G.md',
      '    01:00 bun bin/elanous.mjs harness worktrees', '    02:00 grep elanous'].join('\n');
    expect(summarizeParents(ps)).toEqual({ count: 2, staleOver6h: 1, oldestHours: 19 });
  });
  test('디스패처 로그의 마지막 용량 줄', () => {
    const text = '08:48:30 [OP] 여유 없음 — Pod 46/46 · 로컬 1/0 · 부하 156\nrequeue X\n09:26:01 [OP] 여유 없음 — Pod 47/46 · 로컬 1/0 · 부하 34\nrequeue Y\n';
    expect(parseDispatcherCapacity(text)).toEqual({ hhmmss: '09:26:01', podUsed: 47, podTarget: 46, localUsed: 1, localMax: 0 });
    expect(parseDispatcherCapacity('09:00:00 [OP] 넘길 칸 없음 · Pod 3 · 로컬 0')).toBeNull();
  });
  test('용량 줄의 시각은 줄 머리 — 뒤에 다른 줄이 붙어도 낡은 값은 낡음', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovw-cap-'));
    writeFileSync(join(dir, 'dispatcher-OP.out'), '07:00:00 [OP] 여유 없음 — Pod 46/46 · 로컬 1/0\n09:30:00 [OP] 발사 X\n');
    const mtime = Date.parse('2026-10-08T00:30:00Z'); // 09:30 KST
    utimesSync(join(dir, 'dispatcher-OP.out'), mtime / 1000, mtime / 1000);
    const r = readDispatcherCapacity(dir, mtime);
    expect('error' in r).toBe(false);
    if (!('error' in r)) { expect(r.at).toBe('2026-10-07T22:00:00.000Z'); expect(r.ageSeconds).toBe(9000); }
    // 자정 넘김: 23:59 줄 · 00:10 mtime → 전날
    expect(new Date(lineTime('23:59:00', Date.parse('2026-10-07T15:10:00Z'))).toISOString()).toBe('2026-10-07T14:59:00.000Z');
  });
  test('handed.txt — 없음은 빈 집합 · 못 읽음은 던진다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovw-h-'));
    expect(readSeatEraHanded(dir).size).toBe(0);
    mkdirSync(join(dir, 'handed.txt'));
    expect(() => readSeatEraHanded(dir)).toThrow('handed.txt 못 읽음');
  });
  test('디스패처 박동 — pid 생존', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovw-'));
    writeFileSync(join(dir, 'dispatcher-OP.pid'), '123\n');
    writeFileSync(join(dir, 'dispatcher-TC.pid'), '456\n');
    const beats = readDispatcherBeats(dir, Date.now(), (pid) => pid === 123);
    expect(beats.map((b) => [b.seat, b.alive])).toEqual([['OP', true], ['TC', false]]);
  });
  test('parseSince', () => {
    expect(parseSince(undefined).ms).toBe(3_600_000);
    expect(parseSince('30m').ms).toBe(1_800_000);
    expect(() => parseSince('abc')).toThrow();
  });
});

describe('overview cache — 10 s snapshot and 60 s background Pod measurement', () => {
  test('memo expires at 10 seconds without changing verdict rules', async () => {
    let clock = Date.parse(AT);
    let collects = 0;
    const cache = createOverviewCache({ now: () => clock, collect: async () => { collects++; return base(); }, measurePods: async () => [],
      schedule: () => ({ unref() {} }) as ReturnType<typeof setInterval> });
    try {
      expect((await cache.get()).verdict).toBe('flowing');
      clock += 9_999;
      expect((await cache.get()).cacheAgeMs).toBe(9_999);
      expect(collects).toBe(1);
      clock++;
      expect((await cache.get()).cacheAgeMs).toBe(0);
      expect(collects).toBe(2);
    } finally { cache.stop(); }
  });
  test('a slow collection reports its age from collection start, and distinct keys are bounded', async () => {
    let clock = Date.parse(AT);
    let collects = 0;
    const cache = createOverviewCache({ now: () => clock,
      collect: async () => { collects++; clock += 4_000; return base(); },
      measurePods: async () => [], schedule: () => ({ unref() {} }) as ReturnType<typeof setInterval> });
    try {
      expect((await cache.get()).cacheAgeMs).toBe(4_000);
      clock += 5_999;
      expect((await cache.get()).cacheAgeMs).toBe(9_999);
      expect(collects).toBe(1);
      for (let i = 0; i < 40; i++) await cache.get({ owner: `owner-${i}` });
      expect(cache.memoSize()).toBeLessThanOrEqual(32);
      // A full memo of fresh keys: re-reading existing keys within 10 s never evicts or re-collects them.
      const fresh = createOverviewCache({ now: () => clock, collect: async () => { collects++; return base(); },
        measurePods: async () => [], schedule: () => ({ unref() {} }) as ReturnType<typeof setInterval> });
      try {
        for (let i = 0; i < 32; i++) await fresh.get({ owner: `k-${i}` });
        const before = collects;
        for (let round = 0; round < 2; round++) for (let i = 0; i < 32; i++) await fresh.get({ owner: `k-${i}` });
        expect(collects).toBe(before);
        expect(fresh.memoSize()).toBe(32);
      } finally { fresh.stop(); }
    } finally { cache.stop(); }
  });
  test('a failed refresh keeps the true collection age, says so, and delays the retry by the memo window', async () => {
    let clock = Date.parse(AT);
    let collects = 0;
    let fail = false;
    const cache = createOverviewCache({ now: () => clock,
      collect: async () => { collects++; if (fail) throw new Error('ledger unreadable'); return base(); },
      measurePods: async () => [], schedule: () => ({ unref() {} }) as ReturnType<typeof setInterval> });
    try {
      expect((await cache.get()).refreshFailed).toBeNull();
      fail = true;
      clock += 10_000;
      const failed = await cache.get();
      expect(collects).toBe(2);
      expect(failed.cacheAgeMs).toBe(10_000);
      expect(failed.refreshFailed).toBe('ledger unreadable');
      clock += 5_000;
      const held = await cache.get();
      expect(collects).toBe(2);
      expect(held.cacheAgeMs).toBe(15_000);
      fail = false;
      clock += 5_000;
      const recovered = await cache.get();
      expect(collects).toBe(3);
      expect(recovered).toMatchObject({ cacheAgeMs: 0, refreshFailed: null });
    } finally { cache.stop(); }
  });
  test('a Pod failure or 120 s staleness shows on a memo hit, not after the memo expires', async () => {
    let clock = Date.parse(AT);
    let tick = () => {};
    let fail = false;
    let collects = 0;
    const cache = createOverviewCache({ now: () => clock,
      collect: async () => { collects++; const s = base(); s.machines.pods = [{ context: 'pool-a', capacity: 2, occupied: unmeasured('pool', 'awaiting') }]; return s; },
      measurePods: async () => { if (fail) throw new Error('kubectl down'); return [{ context: 'pool-a', occupied: 1, reason: null, observedAt: clock }]; },
      schedule: (fn) => { tick = fn; return ({ unref() {} }) as ReturnType<typeof setInterval>; } });
    try {
      await cache.get();
      tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock += 10_000;
      expect((await cache.get()).machines.pods[0]?.occupied.value).toBe(1);
      expect(collects).toBe(2);
      // Within the 10 s memo: the measurement fails.
      fail = true;
      tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock += 1_000;
      const failed = await cache.get();
      expect(collects).toBe(2);
      expect(failed.cacheAgeMs).toBe(1_000);
      expect(failed.machines.pods[0]?.occupied).toMatchObject({ value: null, status: 'unmeasured', reason: 'kubectl down' });
      // A good reading, then it ages past 120 s while a fresh memo is served.
      fail = false;
      tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock += 119_000;
      expect((await cache.get()).machines.pods[0]?.occupied.value).toBe(1);
      const collectsAtMemo = collects;
      clock += 1_000;
      const stale = await cache.get();
      expect(collects).toBe(collectsAtMemo);
      expect(stale.machines.pods[0]?.occupied).toMatchObject({ value: null, status: 'unmeasured', reason: '낡음(120초)' });
    } finally { cache.stop(); }
  });
  test('Pod measurement only runs on background tick; failures and stale values remain unmeasured', async () => {
    let clock = Date.parse(AT);
    let tick = () => {};
    let interval = 0;
    let calls = 0;
    const cache = createOverviewCache({ now: () => clock,
      collect: async () => { const s = base(); s.machines.pods = [{ context: 'pool-a', capacity: 2, occupied: unmeasured('pool', 'awaiting') }]; return s; },
      measurePods: async () => { calls++; return [{ context: 'pool-a', occupied: calls === 1 ? 1 : null, reason: 'unavailable', observedAt: clock }]; },
      schedule: (fn, ms) => { tick = fn; interval = ms; return ({ unref() {} }) as ReturnType<typeof setInterval>; } });
    try {
      expect((await cache.get()).machines.pods[0]?.occupied.value).toBeNull();
      expect(calls).toBe(0);
      expect(interval).toBe(60_000);
      tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock += 10_000;
      expect((await cache.get()).machines.pods[0]?.occupied.value).toBe(1);
      clock += 120_000;
      expect((await cache.get()).machines.pods[0]?.occupied).toMatchObject({ value: null, status: 'unmeasured', reason: '낡음(120초)' });
      tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock += 10_000;
      expect((await cache.get()).machines.pods[0]?.occupied).toMatchObject({ value: null, status: 'unmeasured', reason: 'unavailable' });
    } finally { cache.stop(); }
  });
});

describe('collectOverview — 주입 원천으로 끝까지', () => {
  test('collectOverview fills throughput from task-agent ledger cards', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ovw-root-'));
    const seat = mkdtempSync(join(tmpdir(), 'ovw-seat-'));
    const now = Date.parse(AT);
    const cards = [
      { id: 'launched-pr', text: '', status: 'launched', createdAt: AT, pr: 42, landAttempts: [
        { pr: 42, head: 'a', at: AT, ok: true, detail: 'merged' },
      ] },
      { id: 'launched-no-pr', text: '', status: 'launched', createdAt: AT, landAttempts: [
        { pr: 43, head: 'b', at: AT, ok: false, reason: 'conflict' },
      ] },
      { id: 'old-launch', text: '', status: 'launched', createdAt: '2026-10-07T14:59:59.999Z', pr: 44 },
      { id: 'not-launched', text: '', status: 'failed', createdAt: AT, pr: 45 },
    ] as TaskCard[];
    const deps = {
      listSchedules: () => [{ version: '0.2.21', cutAt: '2026-10-08T09:00:00Z', landBy: null, updatedAt: AT, updatedBy: 't' }],
      listChecklist: () => ({ version: '0.2.21', released: '', dev: '', history: [], items: [] }),
      readRuns: () => [], readCards: () => cards, ledger: () => [], poolSpec: () => null, ps: () => '',
      gitLog: () => ({ lines: [], observedAt: AT }),
    };
    const snapshot = await collectOverview({ sinceMs: 3_600_000, sinceLabel: '최근 1h', now, root, seatEraDir: seat }, deps);
    expect(snapshot.throughput).toMatchObject({
      status: 'ok', source: 'task-agent ledger(오늘 KST · landAttempts)', observedAt: AT,
      value: {
        launched: 2, cardPrs: 1, taskAgentLandings: null,
        failureReasons: { conflict: 1 }, pendingLandings: null, oldestPendingAgeSeconds: null,
      },
    });

    const failed = await collectOverview({ sinceMs: 3_600_000, sinceLabel: '최근 1h', now, root, seatEraDir: seat }, {
      ...deps, readCards: () => { throw new Error('cards unavailable'); },
    });
    expect(failed.throughput).toMatchObject({
      status: 'unmeasured', value: null, source: 'task-agent ledger', reason: 'cards unavailable',
    });
  });

  test('원천이 비거나 실패하면 그 칸만 못 잼', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ovw-root-'));
    const seat = mkdtempSync(join(tmpdir(), 'ovw-seat-'));
    const now = Date.parse(AT);
    const s = await collectOverview({ sinceMs: 3_600_000, sinceLabel: '최근 1h', now, root, seatEraDir: seat }, {
      listSchedules: () => [{ version: '0.2.21', cutAt: '2026-10-08T09:00:00Z', landBy: null, updatedAt: AT, updatedBy: 't' }],
      listChecklist: () => ({ version: '0.2.21', released: '', dev: '', history: [], items: [{ id: 'A', status: 'yellow', title: '대상 경로: a', priority: 'P0', updatedAt: AT, updatedBy: 't' }] }),
      readRuns: () => [],
      readCards: () => [],
      ledger: () => [{ id: 'm', kind: 'machine', machine: 'mbp', name: 'mbp', owner: 'x', attrs: { load: { loadAvg: [1, 2, 3], observedAt: now } }, observedAt: now, ttlMs: 1, ageMs: 0, expired: false }],
      poolSpec: () => 'pool-node-b@node-b:40',
      ps: () => { throw new Error('ps boom'); },
      gitLog: () => { throw new Error('no repo'); },
    });
    expect(s.release.version.value).toBe('0.2.21');
    expect(s.release.checklist.value?.p0Yellow).toBe(1);
    expect(s.tasks.launchable.value?.count).toBe(1);
    expect(s.tasks.capacity.status).toBe('unmeasured');
    expect(s.machines.parents.value).toBeNull();
    expect(s.machines.hosts.map((h) => [h.name, h.load.value, h.load.reason])).toEqual([
      ['mbp', null, '하트비트 항목 빠짐(loadAvg·cpuCount·freeMem·totalMem)'], ['node-b', null, '하트비트 없음']]);
    expect(s.machines.pods[0]!.occupied.value).toBeNull();
    expect(s.landings.reason).toBe('no repo');
    expect(computeVerdict(s).verdict).toBe('unobservable');
  });

  test('10-08 node-b heartbeat가 생산 수집·판정·렌더 경로에서 구속 메모리와 판정 띠로 보인다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ovw-node-b-root-'));
    const seat = mkdtempSync(join(tmpdir(), 'ovw-node-b-seat-'));
    try {
      const now = Date.parse(AT);
      const snapshot = await collectOverview({ sinceMs: 3_600_000, sinceLabel: '최근 1h', now, root, seatEraDir: seat }, {
        listSchedules: () => [], listChecklist: () => ({ version: '', released: '', dev: '', history: [], items: [] }),
        readRuns: () => [], readCards: () => [], poolSpec: () => null, ps: () => '',
        ledger: () => [{
          id: 'machine:node-b', kind: 'machine', machine: 'node-b', name: 'node-b', owner: 'test',
          attrs: { load: { loadAvg: [8, 8, 8], cpuCount: 8, freeMem: 5 * 1024 ** 3, totalMem: 64 * 1024 ** 3, observedAt: now } },
          observedAt: now, ttlMs: 600_000, ageMs: 0, expired: false,
        } as ResourceView],
        gitLog: () => ({ lines: [], observedAt: AT }),
      });
      const verdict = computeVerdict(snapshot);
      expect(bindingResource(snapshot)).toMatchObject({ kind: 'memory', label: 'node-b 메모리' });
      expect(verdict.reasons).toContain('구속 자원 node-b 메모리 — 남은 비율 최소 8% (5/64GB)');
      expect(renderOverview(snapshot, verdict, { elapsedMs: 1 }))
        .toContain('↳ 구속 자원 node-b 메모리 — 남은 비율 최소 8% (5/64GB)');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(seat, { recursive: true, force: true });
    }
  });

  test('비유한 heartbeat 측정값은 구속 후보에서 빠지고 유효한 node-b 메모리가 판정 띠를 결정한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ovw-nonfinite-root-'));
    const seat = mkdtempSync(join(tmpdir(), 'ovw-nonfinite-seat-'));
    try {
      const now = Date.parse(AT);
      const snapshot = await collectOverview({ sinceMs: 3_600_000, sinceLabel: '최근 1h', now, root, seatEraDir: seat }, {
        listSchedules: () => [], listChecklist: () => ({ version: '', released: '', dev: '', history: [], items: [] }),
        readRuns: () => [], readCards: () => [], poolSpec: () => null, ps: () => '',
        ledger: () => [
          { id: 'machine:bad', kind: 'machine', machine: 'bad', name: 'bad', owner: 'test',
            attrs: { load: { loadAvg: [1, Number.NaN, 1], cpuCount: 8, freeMem: 5 * 1024 ** 3, totalMem: 64 * 1024 ** 3, observedAt: now } },
            observedAt: now, ttlMs: 600_000, ageMs: 0, expired: false } as ResourceView,
          { id: 'machine:node-b', kind: 'machine', machine: 'node-b', name: 'node-b', owner: 'test',
            attrs: { load: { loadAvg: [8, 8, 8], cpuCount: 8, freeMem: 5 * 1024 ** 3, totalMem: 64 * 1024 ** 3, observedAt: now } },
            observedAt: now, ttlMs: 600_000, ageMs: 0, expired: false } as ResourceView,
        ],
        gitLog: () => ({ lines: [], observedAt: AT }),
      });
      expect(snapshot.machines.hosts.find((host) => host.name === 'bad')?.load).toMatchObject({ value: null, status: 'unmeasured' });
      const verdict = computeVerdict(snapshot);
      expect(bindingResource(snapshot)).toMatchObject({ kind: 'memory', label: 'node-b 메모리' });
      expect(verdict.reasons).toContain('구속 자원 node-b 메모리 — 남은 비율 최소 8% (5/64GB)');
      expect(renderOverview(snapshot, verdict, { elapsedMs: 1 })).toContain('구속 자원 node-b 메모리 — 남은 비율 최소 8% (5/64GB)');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(seat, { recursive: true, force: true });
    }
  });

  test('하트비트 diskIo.io(PSI)가 스냅샷 → 구속 자원 판정까지 생산 수집 경로로 흐른다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ovw-io-root-'));
    const seat = mkdtempSync(join(tmpdir(), 'ovw-io-seat-'));
    try {
      const now = Date.parse(AT);
      const heartbeat = (diskIo: unknown): ResourceView => ({
        id: 'm', kind: 'machine', machine: 'mbp', name: 'mbp', owner: 'x',
        attrs: { load: { loadAvg: [1, 1, 1], cpuCount: 8, freeMem: 60 * 1024 ** 3, totalMem: 64 * 1024 ** 3, observedAt: now, diskIo } },
        observedAt: now, ttlMs: 600_000, ageMs: 0, expired: false,
      });
      const collect = (diskIo: unknown) => collectOverview({ sinceMs: 3_600_000, sinceLabel: '최근 1h', now, root, seatEraDir: seat }, {
        listSchedules: () => [], listChecklist: () => ({ version: '', released: '', dev: '', history: [], items: [] }),
        readRuns: () => [], readCards: () => [], ledger: () => [heartbeat(diskIo)], poolSpec: () => null, ps: () => '',
        gitLog: () => ({ lines: [], observedAt: AT }),
      });

      const pressured = await collect({ io: { status: 'ok', value: { someAvg10: 96, fullAvg10: 61 } } });
      expect(pressured.machines.hosts[0]!.load.value?.ioPressure).toEqual({ someAvg10: 96, fullAvg10: 61 });
      expect(computeVerdict(pressured).reasons)
        .toContain('구속 자원 mbp I/O — 남은 비율 최소 4% (4/100(압박 96% · full 61% · 10초 평균))');
      expect(renderOverview(pressured, computeVerdict(pressured), { elapsedMs: 1 })).toContain('I/O 압박 96% · full 61%');

      const blind = await collect({ io: { status: 'unmeasured', reason: '/proc/pressure/io 없음' } });
      expect(blind.machines.hosts[0]!.load.value?.ioPressure).toBeNull();
      expect(computeVerdict(blind).reasons.join(' ')).not.toContain('mbp I/O');
      expect(renderOverview(blind, computeVerdict(blind), { elapsedMs: 1 })).not.toContain('I/O 압박');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(seat, { recursive: true, force: true });
    }
  });

  test('real heartbeat diskIo reaches the persistent ledger and production overview binding/output path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ovw-heartbeat-io-root-'));
    const seat = mkdtempSync(join(tmpdir(), 'ovw-heartbeat-io-seat-'));
    const ledger = new ResourceLedger(root);
    let onMachineRegistered!: () => void;
    const machineRegistered = new Promise<void>((resolve) => { onMachineRegistered = resolve; });
    const fetch: typeof globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        id?: string; kind?: string; machine?: string; owner?: string; attrs?: Record<string, unknown>; ttlMs?: number;
      };
      const url = new URL(String(input));
      if (url.pathname.endsWith('/register')) {
        ledger.register({ id: body.id!, kind: body.kind!, name: '', machine: body.machine!, owner: body.owner!,
          attrs: body.attrs, observedAt: Date.now(), ttlMs: body.ttlMs! } as never, 'member-a');
        if (body.kind === 'machine') onMachineRegistered();
      } else {
        const id = decodeURIComponent(url.pathname.split('/').at(-2)!);
        ledger.heartbeat(id, 'member-a', body.attrs, Date.now() + 60_000);
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    let stop: (() => void) | undefined;
    try {
      stop = startMemberHeartbeat({
        coordinatorUrl: 'http://127.0.0.1:1', token: 'a'.repeat(64),
        machine: { id: 'machine:local', name: 'local' },
        instance: { id: 'instance:local', name: 'nexus', endpoint: 'http://127.0.0.1:43210' },
        intervalMs: 60_000, fetch,
        // Inject a deterministic measured PSI sample at the heartbeat's documented probe seam.
        // The heartbeat, persistent ledger, collector, verdict, and renderer below are production code.
        measure: async (now, baseline) => {
          const measured = await measureLoad(now, baseline);
          const observedAt = now();
          return { ...measured, loadAvg: [0.1, 0.1, 0.1], cpuCount: 8, freeMem: 60 * 1024 ** 3, totalMem: 64 * 1024 ** 3,
            diskIo: { ...measured.diskIo, io: { status: 'ok', source: 'test:deterministic-PSI', observedAt,
              value: { someAvg10: 100, fullAvg10: 50 } } } };
        },
      });
      await machineRegistered;
      const stored = ledger.list({ kind: 'machine' })[0] as ResourceView;
      expect((stored.attrs as { load?: { diskIo?: { io?: unknown } } }).load?.diskIo?.io)
        .toMatchObject({ status: 'ok', value: { someAvg10: 100, fullAvg10: 50 } });

      const now = Date.now();
      const snapshot = await collectOverview({ sinceMs: 3_600_000, sinceLabel: '최근 1h', now, root, seatEraDir: seat }, {
        listSchedules: () => [], readSchedulerRuns: () => [], listChecklist: () => ({ version: '', released: '', dev: '', history: [], items: [] }),
        readRuns: () => [], readCards: () => [], ledger: () => ledger.list({ kind: 'machine' }), poolSpec: () => null, ps: () => '',
        gitLog: () => ({ lines: [], observedAt: new Date(now).toISOString() }),
      });
      const host = snapshot.machines.hosts.find((row) => row.name === 'local');
      expect(host?.load.value?.ioPressure).toEqual({ someAvg10: 100, fullAvg10: 50 });
      const verdict = computeVerdict(snapshot);
      expect(bindingResource(snapshot)).toMatchObject({ kind: 'io', label: 'local I/O', remainingRatio: 0 });
      expect(verdict.reasons).toContain('구속 자원 local I/O — 남은 비율 최소 0% (0/100(압박 100% · full 50% · 10초 평균))');
      const rendered = renderOverview(snapshot, verdict, { elapsedMs: 1 });
      expect(rendered).toContain('I/O 압박 100% · full 50%');
      expect(rendered).toContain('구속 자원 local I/O — 남은 비율 최소 0%');
    } finally {
      stop?.();
      rmSync(root, { recursive: true, force: true });
      rmSync(seat, { recursive: true, force: true });
    }
  });

  test('cron-run production records flow through the persistent log, overview collector, cache, and renderer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ovw-scheduler-root-'));
    const seat = mkdtempSync(join(tmpdir(), 'ovw-scheduler-seat-'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    mkdirSync(join(root, 'logs'), { recursive: true });
    let store: LogStore | undefined;
    let stopCache: (() => void) | undefined;
    try {
      const schedules = openSchedulesDb(schedulesDbPath());
      schedules.run(`INSERT INTO schedule_registry (id, name, source, category, enabled, run_via)
        VALUES ('overview-integration', 'overview-fixture', 'crontab', 'maintenance', 1, 'crontab')`);
      schedules.close();
      store = new LogStore(logsDbPath(), { instance: 'overview-scheduler-test' });
      const target = join(root, 'overview-fixture.ts');
      writeFileSync(target, 'process.exit(0);\n');
      const producer = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, '../../scripts/cron-run.ts'), '--schedule-id', 'overview-integration', target],
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, NODE_ENV: 'production', ELANOUS_STATE_DIR: root, ELANOUS_CONFIG_DIR: root },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [producerExit, producerStderr] = await Promise.all([producer.exited, new Response(producer.stderr).text()]);
      expect(producerExit).toBe(0);
      expect(producerStderr).not.toContain('cron-run observation');
      const now = Date.now();
      const collect = () => collectOverview({ sinceMs: 3_600_000, sinceLabel: '최근 1h', now, root, seatEraDir: seat }, {
        listSchedules: () => [], listChecklist: () => ({ version: '', released: '', dev: '', history: [], items: [] }),
        readRuns: () => [], readCards: () => [], ledger: () => [], poolSpec: () => null, ps: () => '',
        gitLog: () => ({ lines: [], observedAt: new Date(now).toISOString() }),
        readSchedulerRuns: (sinceMs, untilMs) => store!.queryAll({ exactCategories: ['schedule.run'], sinceMs, untilMs })
          .map(({ ts_ms, data }) => ({ ts_ms, data })),
      });
      const cache = createOverviewCache({ collect, measurePods: async () => [],
        schedule: () => ({ unref() {} }) as ReturnType<typeof setInterval> });
      stopCache = () => cache.stop();
      const snapshot = await cache.get();
      expect(snapshot.schedulerMetrics?.value?.scheduleRuns).toBe(1);
      expect(snapshot.schedulerMetrics).toMatchObject({
        status: 'ok', source: expect.stringContaining('전체 Bun 기동 아님'),
        value: { scheduleRuns: 1, bunLaunches: 1, bunLaunchesLast24h: 1 },
      });
      const rendered = renderOverview(snapshot, computeVerdict(snapshot), { elapsedMs: 12 });
      expect(rendered).toContain('스케줄 로그 기록(최근 1시간)');
      expect(rendered).toContain('schedule.run 1건 · crontab 경유 기록 1건');
      expect(rendered).toContain('최근 24h crontab 경유 기록 1건');
      const cliLines: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => { cliLines.push(args.map(String).join(' ')); };
      try { await runOpsOverview({}); } finally { console.log = originalLog; }
      expect(cliLines.join('\n')).toContain('스케줄 로그 기록(최근 1시간)');
      expect(cliLines.join('\n')).toContain('schedule.run 1건 · crontab 경유 기록 1건');
    } finally {
      stopCache?.();
      store?.close();
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(root, { recursive: true, force: true });
      rmSync(seat, { recursive: true, force: true });
    }
  });
});

describe('게이트 예약 축 — 자원 지도 다섯째 축(RES-FLOOR-BINDING)', () => {
  // GATE-RESERVE-AUTO 표본: 발행 게이트 샤드 Job(`gate-*`·kind=command)과 그 Pod.
  const gateJob = (cpu: string) => ({
    metadata: { name: 'gate-shard', labels: { 'elanous.substrate': 'pod', 'elanous.kind': 'command' } },
    spec: { template: { spec: { containers: [{ resources: { requests: { cpu, memory: '1Gi' }, limits: { memory: '2Gi' } } }] } } },
    status: { active: 1 },
  });
  const gatePod = (cpu: string, nodeName: string | null = 'node-1') => ({
    metadata: { namespace: 'elanous-test', name: 'gate-pod', labels: { 'elanous.job': 'gate-shard', 'elanous.kind': 'command' } },
    status: { phase: nodeName === null ? 'Pending' : 'Running' },
    spec: { ...(nodeName === null ? {} : { nodeName }),
      containers: [{ resources: { requests: { cpu, memory: '1Gi' }, limits: { memory: '2Gi' } } }] },
  });
  const nodes = (cpus: string[]) => ({ items: cpus.map((cpu, i) => ({ metadata: { name: i === 0 ? 'node-1' : `node-${i + 1}` },
    status: { allocatable: { memory: '128Gi', cpu }, conditions: [{ type: 'Ready', status: 'True' }] } })) });
  /** 생산 grid 경로(buildGridData → measurePoolLease)에 mock kubectl 무대만 끼운다 — 축을 고르는 코드는 그대로 돈다. */
  const gridFor = (jobs: unknown[], pods: unknown[], cpus: string[] = ['4']) => buildGridData({
    readHq: () => ({ record: null, ageSeconds: null, expired: null }), poolSpec: () => 'node-b:4',
    measure: () => measurePoolLease(parsePodPool('node-b:4'), { dns: () => 'ready', kubectl: (args) => {
      if (args.includes('nodes')) return { status: 0, stdout: JSON.stringify(nodes(cpus)), stderr: '' };
      if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: jobs }), stderr: '' };
      return { status: 0, stdout: JSON.stringify({ items: pods }), stderr: '' };
    } }),
  });
  /** 스냅숏 씨앗 — 기계 node-b(메모리 60/64GB · CPU 1/8코어) 과 풀 멤버 node-b 한 자리. */
  const seed = (): OverviewSnapshot => {
    const s = base();
    s.tasks.capacity = okCell({ podUsed: 1, podTarget: 10, localUsed: 0, localMax: 2, free: 11 }, 't', AT);
    s.machines.hosts = [{ name: 'node-b', load: okCell({ load1: 1, load5: 1, load15: 1, cpuCount: 8, freeGb: 60, totalGb: 64, ageSeconds: 5 }, 't', AT) }];
    s.machines.pods = [{ context: 'node-b', capacity: 4, occupied: unmeasured('pod pool', '측정 대기') }];
    return s;
  };
  /**
   * 생산 데몬 경로 그대로 — 캐시의 백그라운드 Pod 측정기(OVW-API · overview-cache 워커가 부르는 grid 읽기)와
   * 응답 시점 겹치기·판정 계산을 지난다. 측정기 반환 꼴은 워커가 실제로 보내는 행과 같다.
   */
  const serveThrough = async (read: () => ReturnType<typeof gridFor>, snapshot: OverviewSnapshot) => {
    let clock = Date.parse(AT);
    let tick = (): void => {};
    const cache = createOverviewCache({ now: () => clock, collect: async () => snapshot,
      measurePods: async () => {
        const grid = read();
        return grid.members.map((m) => ({ context: m.context, occupied: m.occupied, reason: m.reason, observedAt: clock, gate: m.gate }));
      },
      schedule: (fn) => { tick = fn; return { unref() {} } as ReturnType<typeof setInterval> } });
    try {
      await cache.get();                         // 첫 읽기가 백그라운드 Pod 측정 타이머를 건다
      tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock += 10_000;
      return await cache.get();
    } finally { cache.stop(); }
  };

  test('게이트가 쥔 몫이 남은 비율 최소면 구속 자원은 게이트 예약 — 판정 띠까지', async () => {
    // 게이트 2/4코어 예약(남은 50%) < 슬롯 11/12(92%) < 메모리 60/64(94%) < CPU 23/24(96%).
    const snap = await serveThrough(() => gridFor([gateJob('2')], [gatePod('2')]), seed());
    expect(bindingResource(snap)).toMatchObject({ kind: 'gate', label: 'node-b 게이트 예약', remainingRatio: 0.5 });
    expect(bindingPhrase(bindingResource(snap))).toBe('구속 자원 node-b 게이트 예약 — 남은 비율 최소 50% (2000/4000밀리코어(게이트 샤드 1 · 예약 2000))');
    const verdict = computeVerdict(snap);
    expect(verdict.reasons).toContain('구속 자원 node-b 게이트 예약 — 남은 비율 최소 50% (2000/4000밀리코어(게이트 샤드 1 · 예약 2000))');
    expect(renderOverview(snap, verdict, { elapsedMs: 1 })).toContain('↳ 구속 자원 node-b 게이트 예약 — 남은 비율 최소 50% (2000/4000밀리코어(게이트 샤드 1 · 예약 2000))');
  });

  test('샤드가 아직 노드에 안 붙었으면 게이트가 CPU 를 먼저 쥔다 — 남은 비율 0%(fail-closed)', async () => {
    for (const pods of [[], [gatePod('2', null)]]) {
      const snap = await serveThrough(() => gridFor([gateJob('2')], pods, ['2', '2']), seed());
      expect(bindingResource(snap)).toMatchObject({ kind: 'gate', label: 'node-b 게이트 예약', remainingRatio: 0 });
      expect(bindingPhrase(bindingResource(snap)))
        .toBe('구속 자원 node-b 게이트 예약 — 남은 비율 최소 0% (0/4000밀리코어(게이트 샤드 1 · 예약 2000 · 미배치 1))');
    }
  });

  test('게이트가 안 도는 멤버는 «축 아님» — 다른 축이 그대로 이긴다(기존 판정 보존)', async () => {
    const snap = await serveThrough(() => gridFor([], []), seed());
    expect(snap.machines.pods[0]!.gate).toMatchObject({ status: 'ok', value: 'none' });
    expect(bindingResource(snap)?.kind).not.toBe('gate');
    expect(computeVerdict(snap).reasons.join('\n')).not.toContain('게이트 예약');
  });

  test('게이트 CPU 를 못 재면 후보에서 뺀다 — «0»도 «넉넉»도 아니고 못 잼으로 이름을 남긴다', async () => {
    const blind = await serveThrough(() => { throw new Error('kubectl down'); }, seed());
    expect(blind.machines.pods[0]!.gate).toMatchObject({ value: null, status: 'unmeasured', reason: 'kubectl down' });
    expect(bindingResource(blind)?.kind).not.toBe('gate');
    expect(unmeasuredCells(blind)).toContain('pods.node-b.gate: kubectl down');
  });

  test('fake-bin kubectl → 생산 백그라운드 측정기(워커) → 판정 띠 — 주입 없이 게이트 예약 축이 실물로 흐른다', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'ovw-gate-bin-'));
    const kubectl = join(binDir, 'kubectl');
    writeFileSync(kubectl, `#!/bin/sh\ncase " $* " in\n  *" nodes "*) printf '%s' '${JSON.stringify(nodes(['4']))}' ;;\n  *" jobs "*) printf '%s' '${JSON.stringify({ items: [gateJob('2')] })}' ;;\n  *) printf '%s' '${JSON.stringify({ items: [gatePod('2')] })}' ;;\nesac\n`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    const previousPool = process.env.ELANOUS_POD_POOL;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.env.ELANOUS_POD_POOL = 'node-b:4';
    let clock = Date.parse(AT);
    let tick = (): void => {};
    // 측정기 주입 없음 — 캐시 기본값이 워커를 띄우고, 워커가 buildGridData() 로 실제 kubectl(=fake-bin)을 부른다.
    const cache = createOverviewCache({ now: () => clock, collect: async () => seed(),
      schedule: (fn) => { tick = fn; return { unref() {} } as ReturnType<typeof setInterval> } });
    try {
      await cache.get();
      tick();
      let snapshot = await cache.get();
      for (let i = 0; i < 100 && !snapshot.machines.pods[0]!.gate?.value; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        clock += 10_000;
        snapshot = await cache.get();
      }
      expect(snapshot.machines.pods[0]!.gate).toMatchObject({
        status: 'ok', value: { jobs: 1, unbound: 0, reservedMillicores: 2000, schedulableMillicores: 4000 },
      });
      expect(bindingResource(snapshot)).toMatchObject({ kind: 'gate', label: 'node-b 게이트 예약' });
      expect(computeVerdict(snapshot).reasons)
        .toContain('구속 자원 node-b 게이트 예약 — 남은 비율 최소 50% (2000/4000밀리코어(게이트 샤드 1 · 예약 2000))');
    } finally {
      cache.stop();
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousPool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previousPool;
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
