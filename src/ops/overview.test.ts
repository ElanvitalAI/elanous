import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeVerdict, okCell, renderOverview, unmeasured, unmeasuredCells, verdictExitCode, type OverviewSnapshot } from './overview.js';
import { collectOverview, launchableCells, ownerRows, parseEtime, parseSince, summarizeParents } from './overview-collect.js';
import { lineTime, parseDispatcherCapacity, readDispatcherBeats, readDispatcherCapacity, readSeatEraHanded } from './overview-seat-era.js';
import { mkdirSync, utimesSync } from 'node:fs';
import type { Checklist, ChecklistItem } from '../release-loop/checklist.js';
import type { TaskCard } from '../task-agent/task-hand.js';

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
    expect(v.reasons.length).toBe(2);
    expect(verdictExitCode(v.verdict)).toBe(0);
  });
});

describe('표기 — 못 잼은 0 이 아니다', () => {
  test('사람 표기에 못 잼(사유) · unmeasuredCells 가 이름을 낸다', () => {
    const s = base();
    s.machines.hosts = [{ name: 'node-c', load: unmeasured('ledger', '하트비트 없음') }];
    const text = renderOverview(s, computeVerdict(s), { elapsedMs: 12 });
    expect(text).toContain('node-c 못 잼(하트비트 없음)');
    expect(text).toContain('끝 못 잼(not yet)');
    expect(unmeasuredCells(s)).toEqual(['tasks.done: not yet', 'machines.node-c: 하트비트 없음']);
    expect(text.split('\n')[0]).toBe('✅ 흐름 정상 (flowing)');
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

describe('collectOverview — 주입 원천으로 끝까지', () => {
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
});
