// SEAT-SELF-PULL — 계획이 비면 자기 칸에서 다음 일을 집는다.
// 결정론: 가짜 원장(재료 객체) · 가짜 시계 · 파일·우편·LLM 0. NUMGUARD: 시간·상한은 제품 상수에서 유도한다.
import { describe, expect, test } from 'bun:test';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from './internal-turn.js';
import { createSeatAutowake } from './seat-autowake.js';
import {
  createSeatSelfPull,
  isPlanEmpty,
  pickNextSelfWork,
  SELF_PULL_COOLDOWN_MS,
  SELF_PULL_WINDOW_CAP,
  selfPullPlanTask,
  type SelfPullCandidate,
  type SelfPullInput,
  type SelfPullSources,
} from './seat-self-pull.js';
import {
  createDefaultSelfPullGather,
  parseWorkQueueMarkdown,
  parseWorkQueueTsv,
  type SelfPullChecklistVersion,
} from './seat-self-pull-sources.js';

const SEAT = 'TC';
// 가짜 시계 기준점 — 값 자체는 어떤 단언에도 쓰지 않는다(경과는 제품 상수로만 더한다).
const T0 = Date.UTC(2026, 10, 17, 0, 0, 0);
// 가짜 우편 id(값은 판정에 쓰이지 않는다 — 미읽음이 «있다»는 표지).
const MAIL_ID = 1;

function cell(over: Partial<SelfPullCandidate> & { id: string }): SelfPullCandidate {
  return { source: 'checklist', title: `${over.id} 제목`, owner: SEAT, open: true, rank: null, addedAt: null,
    ordinal: 0, predecessors: [], ...over };
}

function input(over: Partial<SelfPullInput> = {}): SelfPullInput {
  return { seat: SEAT, planEmpty: true, candidates: [], hold: new Set(), handed: new Set(), isDone: () => null,
    recentPicks: [], now: T0, ...over };
}

describe('pickNextSelfWork — 순수 선택기', () => {
  test('소유·열린 칸을 등급 → 나이 → 출처 순서로 하나 집는다', () => {
    const d = pickNextSelfWork(input({ candidates: [
      cell({ id: 'C-LOW', rank: 2, addedAt: T0 - 1, ordinal: 1 }),
      cell({ id: 'C-P0-NEW', rank: 0, addedAt: T0, ordinal: 2 }),
      cell({ id: 'C-P0-OLD', rank: 0, addedAt: T0 - 1, ordinal: 3 }),
      cell({ id: 'C-NONE', ordinal: 0 }),
    ] }));
    expect(d).toMatchObject({ outcome: 'picked', item: { id: 'C-P0-OLD' } });
  });

  test('남의 칸 · hold · handed · 선행 미완(모름 포함) · 남의 점유 · 막힘은 건너뛴다', () => {
    const d = pickNextSelfWork(input({
      candidates: [
        cell({ id: 'FOREIGN', owner: 'UX', rank: 0 }),
        cell({ id: 'HELD', rank: 0 }),
        cell({ id: 'HANDED', rank: 0 }),
        cell({ id: 'PRED-OPEN', rank: 0, predecessors: ['P1'] }),
        cell({ id: 'PRED-UNKNOWN', rank: 0, predecessors: ['P-NOWHERE'] }),
        cell({ id: 'CLAIMED', rank: 0, source: 'work-queue', claimedBy: 'seat-RES-Q05' }),
        cell({ id: 'BLOCKED', rank: 0, source: 'work-queue', blocked: true }),
        cell({ id: 'OK', rank: 1, predecessors: ['P-DONE'] }),
      ],
      hold: new Set(['HELD']),
      handed: new Set(['HANDED']),
      isDone: id => (id === 'P-DONE' ? true : id === 'P1' ? false : null),
    }));
    expect(d).toMatchObject({ outcome: 'picked', item: { id: 'OK' } });
    expect(Object.fromEntries(d.excluded.map(e => [e.id, e.why]))).toEqual({
      FOREIGN: 'foreign', HELD: 'hold', HANDED: 'handed', 'PRED-OPEN': 'predecessor', 'PRED-UNKNOWN': 'predecessor',
      CLAIMED: 'claimed', BLOCKED: 'blocked',
    });
  });

  test('비면 타입 사유: 소유 없음 · 전부 hold/handed · 전부 막힘 · 계획 있음 · 신호 정지', () => {
    expect(pickNextSelfWork(input())).toMatchObject({ outcome: 'none', reason: 'nothing-owned', cellId: null });
    expect(pickNextSelfWork(input({ candidates: [cell({ id: 'X', owner: 'UX' }), cell({ id: 'Y', open: false })] })))
      .toMatchObject({ outcome: 'none', reason: 'nothing-owned' });
    expect(pickNextSelfWork(input({ candidates: [cell({ id: 'H' }), cell({ id: 'D' })], hold: new Set(['H']), handed: new Set(['D']) })))
      .toMatchObject({ outcome: 'none', reason: 'held', cellId: 'H' });
    expect(pickNextSelfWork(input({ candidates: [cell({ id: 'H' }), cell({ id: 'B', predecessors: ['Z'] })], hold: new Set(['H']) })))
      .toMatchObject({ outcome: 'none', reason: 'all-blocked' });
    expect(pickNextSelfWork(input({ planEmpty: false, candidates: [cell({ id: 'A' })] })))
      .toMatchObject({ outcome: 'none', reason: 'plan-not-empty' });
    expect(pickNextSelfWork(input({ signalStop: 'traffic-yellow', candidates: [cell({ id: 'A' })] })))
      .toMatchObject({ outcome: 'none', reason: 'held', detail: 'traffic-yellow' });
  });

  test('쿨다운 안에 집은 일이 아직 열려 있으면 다른 칸으로 건너뛰지 않는다 · 쿨다운이 지나면 다시 집는다', () => {
    const candidates = [cell({ id: 'A', rank: 0 }), cell({ id: 'B', rank: 1 })];
    const recentPicks = [{ id: 'A', at: T0 }];
    expect(pickNextSelfWork(input({ candidates, recentPicks, now: T0 + SELF_PULL_COOLDOWN_MS - 1 })))
      .toMatchObject({ outcome: 'none', reason: 'cooldown', cellId: 'A' });
    expect(pickNextSelfWork(input({ candidates, recentPicks, now: T0 + SELF_PULL_COOLDOWN_MS })))
      .toMatchObject({ outcome: 'picked', item: { id: 'A' } });
    // 집었던 A 가 닫혔으면(후보에서 사라짐) 쿨다운 안이어도 다음 칸으로 간다.
    expect(pickNextSelfWork(input({ candidates: [candidates[1]!], recentPicks, now: T0 + 1 })))
      .toMatchObject({ outcome: 'picked', item: { id: 'B' } });
  });

  test('창 상한: 창 안 집기 수가 상한에 닿으면 cap', () => {
    const recentPicks = Array.from({ length: SELF_PULL_WINDOW_CAP }, (_, i) => ({ id: `DONE-${i}`, at: T0 + i }));
    expect(pickNextSelfWork(input({ candidates: [cell({ id: 'A' })], recentPicks, now: T0 + SELF_PULL_WINDOW_CAP })))
      .toMatchObject({ outcome: 'none', reason: 'cap' });
    expect(pickNextSelfWork(input({ candidates: [cell({ id: 'A' })], recentPicks: recentPicks.slice(1), now: T0 + SELF_PULL_WINDOW_CAP })))
      .toMatchObject({ outcome: 'picked', item: { id: 'A' } });
  });

  test('같은 id 가 체크리스트와 WORK-QUEUE 둘 다에 있으면 하나만(앞선 쪽)', () => {
    const d = pickNextSelfWork(input({ candidates: [
      cell({ id: 'SAME', source: 'work-queue', ordinal: 1 }), cell({ id: 'SAME', ordinal: 1 }),
    ] }));
    expect(d).toMatchObject({ outcome: 'picked', item: { id: 'SAME', source: 'checklist' } });
  });
});

describe('createSeatSelfPull — 넘김 · 우편 중복 억제 · 관측', () => {
  function rig(over: { sources?: () => SelfPullSources; accept?: () => StartTurnIfIdleResult; enabled?: boolean } = {}) {
    const clock = { now: T0 };
    const mails: string[] = [];
    const handed: string[] = [];
    const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    let gathers = 0;
    let sources: SelfPullSources = { candidates: [cell({ id: 'A', rank: 0 }), cell({ id: 'B', rank: 1 })],
      hold: new Set(), handed: new Set(), isDone: () => null };
    const sp = createSeatSelfPull({
      isEnabled: () => over.enabled ?? true,
      gather: () => { gathers++; return over.sources ? over.sources() : sources; },
      handOff: (picked) => {
        const r = over.accept ? over.accept() : { opened: true as const, turnId: 't' };
        if (r.opened) handed.push(picked.item.id);
        return r.opened ? { accepted: true } : { accepted: false, detail: r.reason };
      },
      postToOp: (_seat, line) => { mails.push(line); },
      now: () => clock.now,
      log: (category, event, data) => { logs.push({ category, event, data }); },
    });
    return { sp, clock, mails, handed, logs, gathers: () => gathers, setSources: (s: SelfPullSources) => { sources = s; } };
  }
  const ctx = { seat: SEAT, unread: 0, queue: 0 };

  test('집으면 넘기고 OP 에 한 줄 · seat.self-pull picked 관측', () => {
    const r = rig();
    expect(r.sp.onNoWorkLeft(ctx)).toMatchObject({ outcome: 'picked', item: { id: 'A' }, handedOff: true, mailed: true });
    expect(r.handed).toEqual(['A']);
    expect(r.mails).toHaveLength(1);
    expect(r.mails[0]).toContain('A');
    expect(r.logs.at(-1)).toMatchObject({ category: 'seat.self-pull', event: 'decided',
      data: { outcome: 'picked', cellId: 'A', seat: SEAT } });
  });

  test('쿨다운 안: 같은 칸 재공지 0 · 같은 none 은 관측도 한 줄 · 쿨다운 뒤 다시 집으면 다시 알린다', () => {
    const r = rig();
    r.sp.onNoWorkLeft(ctx);
    r.clock.now += 1;
    expect(r.sp.onNoWorkLeft(ctx)).toMatchObject({ outcome: 'none', reason: 'cooldown', cellId: 'A' });
    r.clock.now += 1;
    r.sp.onNoWorkLeft(ctx);
    expect(r.mails).toHaveLength(1);
    expect(r.logs.filter(l => l.data.reason === 'cooldown')).toHaveLength(1);
    r.clock.now = T0 + SELF_PULL_COOLDOWN_MS;
    expect(r.sp.onNoWorkLeft(ctx)).toMatchObject({ outcome: 'picked', item: { id: 'A' }, mailed: true });
    expect(r.mails).toHaveLength(2);
  });

  test('집은 칸이 닫히면 쿨다운 안이어도 다음 칸을 집고 그 칸은 새로 알린다', () => {
    const r = rig();
    r.sp.onNoWorkLeft(ctx);
    r.setSources({ candidates: [cell({ id: 'A', rank: 0, open: false }), cell({ id: 'B', rank: 1 })],
      hold: new Set(), handed: new Set(), isDone: () => null });
    r.clock.now += 1;
    expect(r.sp.onNoWorkLeft(ctx)).toMatchObject({ outcome: 'picked', item: { id: 'B' }, mailed: true });
    expect(r.handed).toEqual(['A', 'B']);
  });

  test('넘김이 거절되면(H2 NotIdle 등) 집은 것이 아니다 — 쿨다운·우편 0, 다음에 다시 잰다', () => {
    let accept: StartTurnIfIdleResult = { opened: false, reason: 'NotIdle' };
    const r = rig({ accept: () => accept });
    expect(r.sp.onNoWorkLeft(ctx)).toMatchObject({ outcome: 'picked', handedOff: false, mailed: false });
    expect(r.mails).toHaveLength(0);
    accept = { opened: true, turnId: 't2' };
    expect(r.sp.onNoWorkLeft(ctx)).toMatchObject({ outcome: 'picked', item: { id: 'A' }, handedOff: true, mailed: true });
  });

  test('opt-in 아님 → 재료를 읽지 않고 관측도 0 · 우편 원장 모름 → work-unknown', () => {
    const off = rig({ enabled: false });
    expect(off.sp.onNoWorkLeft(ctx)).toMatchObject({ outcome: 'none', reason: 'disabled' });
    expect(off.gathers()).toBe(0);
    expect(off.logs).toHaveLength(0);
    const on = rig();
    expect(on.sp.onNoWorkLeft({ ...ctx, unread: null })).toMatchObject({ outcome: 'none', reason: 'work-unknown' });
    expect(on.gathers()).toBe(0);
  });

  test('재료 읽기 실패 → source-unreadable(던지지 않는다)', () => {
    const r = rig({ sources: () => { throw new Error('handed ledger EACCES'); } });
    expect(r.sp.onNoWorkLeft(ctx)).toMatchObject({ outcome: 'none', reason: 'source-unreadable' });
  });
});

describe('autowake 이음매 — «남은 일 없음»에서만 부른다', () => {
  const HOME = '/h';
  function autowakeRig() {
    const state = { unread: { count: 0, maxId: null as number | null } };
    const hooks: Array<{ seat: string; unread: number | null; queue: number | null }> = [];
    const calls: Array<{ input: string; opts: StartTurnIfIdleOptions }> = [];
    const files = new Set([`${HOME}/elanous-hq/seat-state/TC/autowake`]);
    const aw = createSeatAutowake({
      startTurnIfIdle: (text, opts) => { calls.push({ input: text, opts }); return { opened: true, turnId: 'auto' }; },
      getCwd: () => `${HOME}/elanous-hq/seats/TC`,
      home: HOME,
      detectSeat: () => ({ seat: 'TC', source: 'cwd' }),
      isRegularFile: path => files.has(path),
      readText: () => null,
      readUnread: () => state.unread,
      lastHumanKeyAt: () => 0,
      now: () => T0,
      defer: () => {},
      log: () => {},
      onNoWorkLeft: c => { hooks.push(c); },
    });
    return { aw, state, hooks, calls, files };
  }

  test('턴 끝 ∧ 우편 0 ∧ 큐 없음 → 한 번 부른다', () => {
    const r = autowakeRig();
    r.aw.noteTurnEnded();
    expect(r.aw.check()).toMatchObject({ action: 'skip', reason: 'nothing-pending' });
    expect(r.hooks).toEqual([{ seat: 'TC', unread: 0, queue: null }]);
  });

  test('남은 일이 있으면(우편) 부르지 않고 autowake 가 연다 · 턴 끝이 아니면 부르지 않는다 · autowake 꺼짐이면 부르지 않는다', () => {
    const r = autowakeRig();
    r.state.unread = { count: 1, maxId: MAIL_ID };
    r.aw.noteTurnEnded();
    expect(r.aw.check()).toMatchObject({ action: 'start-turn', opened: true });
    r.state.unread = { count: 0, maxId: null };
    expect(r.aw.check()).toMatchObject({ action: 'skip', reason: 'not-turn-end' });
    r.files.clear();
    r.aw.noteTurnEnded();
    expect(r.aw.check()).toMatchObject({ action: 'skip', reason: 'disabled' });
    expect(r.hooks).toHaveLength(0);
  });
});

describe('계획 층 이음매(PLAN-WIRE-SEAT)', () => {
  test('isPlanEmpty = 종결 아닌 항목 0 · selfPullPlanTask = queued 새 항목 하나(대상 = 칸)', () => {
    expect(isPlanEmpty([])).toBe(true);
    expect(isPlanEmpty([{ status: 'done' }, { status: 'cancelled' }, { status: 'superseded' }])).toBe(true);
    expect(isPlanEmpty([{ status: 'done' }, { status: 'queued' }])).toBe(false);
    const task = selfPullPlanTask(SEAT, cell({ id: 'C1', rank: 0 }), '근거', 7);
    expect(task).toMatchObject({ id: 'self-pull:C1', seq: 7, status: 'queued', priority: 'p0', targets: ['C1'], deps: [] });
    expect(task.sourceText).toContain('C1');
  });
});

describe('재료 — WORK-QUEUE 파서 · 기본 gather(가짜 원장)', () => {
  test('TSV: 머리줄 칸 이름으로 읽는다 · 상태 → open/done/claimed/hold/blocked', () => {
    const tsv = [
      'priority\ttask_id\tkind\towner\tstatus\tclaim_tab\tnote',
      '0\tT-OPEN\tx\tTC\tready\t\t열린 일',
      '1\tT-DONE\tx\tTC\tdone\ttab\t끝',
      '0\tT-CLAIMED\tx\tTC\tclaimed\tseat-RES-Q05\t남이 잡음',
      '2\tT-OTHER\tx\tUX\tready\t\t남의 일',
    ].join('\n');
    expect(parseWorkQueueTsv(tsv).map(e => [e.id, e.owner, e.state, e.rank, e.claim])).toEqual([
      ['T-OPEN', 'TC', 'open', 0, null], ['T-DONE', 'TC', 'done', 1, 'tab'],
      ['T-CLAIMED', 'TC', 'claimed', 0, 'seat-RES-Q05'], ['T-OTHER', 'UX', 'open', 2, null],
    ]);
    expect(parseWorkQueueTsv('a\tb\n1\t2')).toEqual([]);
  });

  test('표 꼴: 이 자리 줄의 칸 id 를 사슬 순서로 · 칸 꼴 아닌 토막은 버린다', () => {
    const md = '| 자리 | 순서대로 |\n|---|---|\n| TC | (#37970 마무리) → CELL-A → CELL-B |\n| UX | CELL-Z |';
    expect(parseWorkQueueMarkdown(md, 'TC').map(e => [e.id, e.predecessors])).toEqual([['CELL-A', []], ['CELL-B', ['CELL-A']]]);
  });

  test('기본 gather: 체크리스트 칸 ⊕ 사슬 큐 — 앞 칸이 열려 있으면 뒤 칸은 선행 막힘 · 신호 정지면 held', () => {
    const versions: SelfPullChecklistVersion[] = [{ version: '0.3.28', items: [
      { id: 'CELL-A', title: 'A 칸', status: 'yellow', owner: 'TC', priority: 'P1' },
      { id: 'CELL-B', title: 'B 칸', status: 'yellow', owner: 'TC' },
      { id: 'CELL-UX', title: '남의 칸', status: 'red', owner: 'UX', priority: 'P0' },
    ] }];
    const md = '| TC | CELL-B → CELL-A |';
    const files = new Map([['/h/elanous-hq/seat-state/TC/WORK-QUEUE-1.md', md]]);
    const deps = {
      home: '/h',
      readText: (p: string) => files.get(p) ?? null,
      listDir: (p: string) => (p === '/h/elanous-hq/seat-state/TC' ? ['WORK-QUEUE-1.md', 'notes.md'] : []),
      readChecklists: () => versions,
      readHanded: () => new Set<string>(),
    };
    const sources = createDefaultSelfPullGather({ ...deps, readSignal: () => ({ stop: null, hold: [] }) })(SEAT, T0);
    // 체크리스트 등급으로는 P1 인 CELL-A 가 먼저지만, 큐 사슬은 CELL-B 다음 CELL-A — 한 출처라도 막으면 집지 않는다.
    const d = pickNextSelfWork(input({ ...sources }));
    expect(d).toMatchObject({ outcome: 'picked', item: { id: 'CELL-B' } });
    // 남의 체크리스트 칸은 리더가 후보로도 올리지 않는다(선택기의 foreign 가드는 두 번째 그물).
    expect(sources.candidates.map(c => c.id)).not.toContain('CELL-UX');
    expect(d.excluded).toContainEqual({ id: 'CELL-A', why: 'predecessor' });
    const stopped = createDefaultSelfPullGather({ ...deps, readSignal: () => ({ stop: 'traffic-yellow', hold: [] }) })(SEAT, T0);
    expect(pickNextSelfWork(input({ ...stopped }))).toMatchObject({ outcome: 'none', reason: 'held', detail: 'traffic-yellow' });
  });
});
