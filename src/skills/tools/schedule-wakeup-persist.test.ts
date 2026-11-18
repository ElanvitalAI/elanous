import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFileWakeupPersistence,
  createSessionWakeupBinder,
  sessionWakeupPersistence,
  buildScheduleWakeupHostTool,
  createWakeupScheduler,
  type WakeupEntry,
  type WakeupPersistence,
  type WakeupSchedulerDeps,
} from './schedule-wakeup.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../../chat/internal-turn-contract.js';

/** 가짜 시계 — 실시간 대기 0. */
function fakeClock(start = new Date(2026, 9, 17, 9, 0, 0, 0).getTime()) {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    /** ms<=0 이면 즉시 동기 발화(실제 setTimeout(fn,0) 의 다음 틱에 해당). */
    setTimer: (fn: () => void, ms: number) => {
      if (ms <= 0) { fn(); return -1; }
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    /** ms 만큼 흘리며 도래한 타이머를 시각 순으로 돌린다. */
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
  };
}

type Call = { input: string; opts: Record<string, unknown> };

/** persist 리그 — 파일 하나를 두 스케줄러(재기동 전·후)가 공유한다. */
function rig(opts: { filePath: string; start?: number; persist?: (real: WakeupPersistence) => WakeupPersistence }) {
  const clock = fakeClock(opts.start);
  const calls: Call[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const results: StartTurnIfIdleResult[] = [];
  const sink = (c: string, event: string, data: Record<string, unknown>) => {
    expect(c).toBe('tui.wakeup');
    logs.push({ event, data });
  };
  const notices: string[] = [];
  const deps = (): WakeupSchedulerDeps => ({
    startTurnIfIdle: (input: string, opts: StartTurnIfIdleOptions) => {
      calls.push({ input, opts: opts as unknown as Record<string, unknown> });
      const shifted = results.shift();
      return shifted ?? ({ opened: true, turnId: `auto-${calls.length}` } as const);
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    notify: line => { notices.push(line); },
    log: sink,
    persist: opts.persist ? opts.persist(createFileWakeupPersistence(opts.filePath)) : createFileWakeupPersistence(opts.filePath),
  });
  const s1 = createWakeupScheduler(deps());
  return { clock, calls, logs, notices, s1, deps, events: () => logs.map(l => `${l.event}:${String(l.data.reason ?? l.data.id ?? '')}`) };
}

/** 재기동 — 같은 시계/로그로 새 스케줄러를 만들어 복원시킨다. */
function reboot(r: ReturnType<typeof rig>) {
  r.s1.dispose();
  r.calls.length = 0;
  r.logs.length = 0;
  const s2 = createWakeupScheduler(r.deps());
  return { s2, calls: r.calls, logs: r.logs, events: r.events };
}

describe('ScheduleWakeup 재기동 영속화(OP O2) — 파일 저장 → 시작 복원', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'wakeup-'));

  test('(a) schedule → 재기동 → list() 복원', () => {
    const dir = tmp();
    const r = rig({ filePath: join(dir, 'w.json') });
    expect(r.s1.schedule({ delaySeconds: 120, reason: 'PR 리뷰' }).ok).toBe(true);
    const dueAt = r.s1.list()[0]!.dueAt;
    const rb = reboot(r); // 즉시 재기동(시계 진행 0)
    expect(rb.s2.list().map(e => e.id)).toEqual(['w1']);
    expect(rb.s2.list()[0]!.dueAt).toBe(dueAt);
    rb.s2.dispose();
  });

  test('(b) 과거 dueAt 일회성 → 복원 시 폐기(발화하지 않음)', () => {
    const dir = tmp();
    const start = new Date(2026, 9, 17, 9, 0, 0, 0).getTime();
    writeFileSync(join(dir, 'w.json'), JSON.stringify([
      { id: 'w7', reason: '지난 예약', dueAt: start - 60_000, fireCount: 0, retried: false },
    ]));
    const r = rig({ filePath: join(dir, 'w.json'), start });
    expect(r.calls).toHaveLength(0);
    expect(r.s1.list()).toHaveLength(0);
    expect(r.events()).toContain('restored-discarded:one-shot-past-due');
    const onDisk = JSON.parse(readFileSync(join(dir, 'w.json'), 'utf8')) as Array<{ id: string }>;
    expect(onDisk.map(e => e.id)).toEqual([]);
    r.s1.dispose();
  });

  test('(b′) 반복 예약 → 재기동 → 다음 회차에 그대로 발화·재무장', () => {
    const dir = tmp();
    const r = rig({ filePath: join(dir, 'w.json') });
    expect(r.s1.schedule({ repeatMinutes: 1, reason: '매분 점검' }).ok).toBe(true);
    r.calls.length = 0;
    const rb = reboot(r); // 타이머 발화 전 죽었다가 재기동한 시나리오
    expect(rb.s2.list().map(e => e.id)).toEqual(['w1']);
    r.s1.dispose(); // 재기동 전 타이머를 멈춘다 — s1 이 살아 있으면 복원 무장 없이도 발화가 통과한다
    rb.calls.length = 0;
    r.clock.advance(90_000); // s2 만 시계를 진행
    expect(rb.calls).toHaveLength(1);
    expect(r.events().some(e => e.startsWith('fired'))).toBe(true);
    expect(rb.s2.list()).toHaveLength(1); // 발화 뒤 다음 회차로 재무장
    rb.s2.dispose();
  });

  test('(c) expiresAt 지난 반복 → 복원 시 drop + restored-expired 로그', () => {
    const dir = tmp();
    const start = new Date(2026, 9, 17, 9, 0, 0, 0).getTime();
    writeFileSync(join(dir, 'w.json'), JSON.stringify([
      { id: 'w3', reason: '만료된 반복', dueAt: start - 5_000, repeatMs: 60_000, expiresAt: start - 1_000, fireCount: 3, retried: false },
    ]));
    const r = rig({ filePath: join(dir, 'w.json'), start });
    expect(r.s1.list()).toHaveLength(0);
    expect(r.events()).toContain('restored-expired:w3');
    r.s1.dispose();
  });

  test('(c′) id 시퀀스 — 복원 최대 이후로 이어감(w7 복원 뒤 신규는 w8)', () => {
    const dir = tmp();
    const start = new Date(2026, 9, 17, 9, 0, 0, 0).getTime();
    writeFileSync(join(dir, 'w.json'), JSON.stringify([
      { id: 'w7', reason: '남은 예약', dueAt: start + 300_000, fireCount: 0, retried: false },
    ]));
    const r = rig({ filePath: join(dir, 'w.json'), start });
    expect(r.s1.list().map(e => e.id)).toEqual(['w7']);
    const sched = r.s1.schedule({ delaySeconds: 60, reason: '신규' });
    expect(sched.ok && sched.entry.id).toBe('w8');
    r.s1.dispose();
  });

  test('(d) 깨진 JSON → 기동 정상·화면 알림, 예약·취소는 거부, 원본 보존', () => {
    const dir = tmp();
    const broken = '{"broken":';
    writeFileSync(join(dir, 'w.json'), broken);
    const r = rig({ filePath: join(dir, 'w.json') });
    expect(r.s1.list()).toEqual([]);
    expect(r.events()).toContain('persist-load-failed:');
    expect(r.notices.join('\n')).toContain('손상');
    expect(r.s1.schedule({ delaySeconds: 120, reason: '덮으면 안 됨' }).ok).toBe(false);
    expect(r.s1.persists()).toBe(false);
    expect(r.s1.hasFile()).toBe(true);
    expect(readFileSync(join(dir, 'w.json'), 'utf8')).toBe(broken);
    r.s1.dispose();
  });

  test('(d′) 배열 안 일부 항목만 깨져도 통째로 거부하고 원본을 그대로 둔다', () => {
    const dir = tmp();
    const filePath = join(dir, 'w.json');
    const original = JSON.stringify([
      { id: 'w1', reason: '정상', dueAt: Date.now() + 300_000, fireCount: 0, retried: false },
      { id: 'w2', reason: '깨짐', dueAt: 'soon' },
    ]);
    writeFileSync(filePath, original);
    const r = rig({ filePath });
    expect(r.s1.list()).toEqual([]);
    expect(r.s1.schedule({ delaySeconds: 120, reason: '새 예약' }).ok).toBe(false);
    expect(r.s1.tryCancel('w1').ok).toBe(false);
    r.clock.advance(400_000);
    expect(r.calls).toEqual([]);
    expect(readFileSync(filePath, 'utf8')).toBe(original);
    const tool = buildScheduleWakeupHostTool(r.s1);
    expect(tool.description).toContain('damaged');
    expect(tool.description).not.toContain('read-only');
    r.s1.dispose();
  });

  test('(g) 예약 저장 실패 → 오류를 내고 그 예약은 남지 않는다(타이머도 없다)', () => {
    const dir = tmp();
    const r = rig({ filePath: join(dir, 'w.json'), persist: real => ({
      load: () => real.load(), save: () => { throw new Error('disk full'); } }) });
    const res = r.s1.schedule({ delaySeconds: 120, reason: '저장 실패' });
    expect(res.ok).toBe(false);
    expect(r.s1.list()).toEqual([]);
    r.clock.advance(400_000);
    expect(r.calls).toEqual([]);
    expect(r.events()).toContain('persist-save-failed:w1');
    r.s1.dispose();
  });

  test('(g′) 취소 저장 실패 → 취소하지 않고 예약과 타이머가 그대로 산다', () => {
    const dir = tmp();
    let failing = false;
    const r = rig({ filePath: join(dir, 'w.json'), persist: real => ({
      load: () => real.load(),
      save: (entries: WakeupEntry[]) => { if (failing) throw new Error('disk full'); real.save(entries); } }) });
    expect(r.s1.schedule({ delaySeconds: 120, reason: '유지돼야 함' }).ok).toBe(true);
    failing = true;
    expect(r.s1.tryCancel('w1').ok).toBe(false);
    expect(r.s1.list().map(e => e.id)).toEqual(['w1']);
    r.clock.advance(130_000);
    expect(r.calls.map(c => c.input).join('\n')).toContain('유지돼야 함');
    r.s1.dispose();
  });

  test('(h) 발화·다음 회차 저장 실패 → 로그만 남기고 반복은 계속 발화한다', () => {
    const dir = tmp();
    let failing = false;
    const r = rig({ filePath: join(dir, 'w.json'), persist: real => ({
      load: () => real.load(),
      save: (entries: WakeupEntry[]) => { if (failing) throw new Error('disk full'); real.save(entries); } }) });
    expect(r.s1.schedule({ delaySeconds: 120, repeatMinutes: 2, reason: '반복' }).ok).toBe(true);
    failing = true;
    r.clock.advance(125_000);
    const afterFirst = r.calls.length;
    r.clock.advance(120_000);
    expect(r.calls.length).toBeGreaterThan(afterFirst);
    expect(r.events().filter(e => e.startsWith('persist-save-failed'))).not.toEqual([]);
    expect(r.s1.list().map(e => e.id)).toEqual(['w1']);
    r.s1.dispose();
  });

  test('(i) 복원 중 만료 정리 저장 실패 → 기동은 계속되고 만료 항목은 메모리에서 빠진다', () => {
    const dir = tmp();
    const filePath = join(dir, 'w.json');
    const t = new Date(2026, 9, 17, 9, 0, 0, 0).getTime();
    const original = JSON.stringify([
      { id: 'w1', reason: '만료', dueAt: t - 1_000, repeatMs: 60_000, expiresAt: t - 500, fireCount: 3, retried: false },
    ]);
    writeFileSync(filePath, original);
    const r = rig({ filePath, start: t, persist: real => ({
      load: () => real.load(), save: () => { throw new Error('disk full'); } }) });
    expect(r.s1.list()).toEqual([]);
    expect(r.events()).toContain('persist-save-failed:');
    expect(readFileSync(filePath, 'utf8')).toBe(original);
    r.s1.dispose();
  });

  test('(j) 실제 쓰기 실패(임시 경로가 막힘 · 권한과 무관) → 원본 보존', () => {
    const dir = tmp();
    const filePath = join(dir, 'w.json');
    const original = JSON.stringify([]);
    writeFileSync(filePath, original);
    mkdirSync(`${filePath}.${process.pid}.tmp`); // a directory where the temp file must go
    const persistence = createFileWakeupPersistence(filePath);
    expect(() => persistence.save([])).toThrow();
    expect(readFileSync(filePath, 'utf8')).toBe(original);
  });

  test('(j′) 옮기기(rename) 실패 → 원본 보존·임시 파일 삭제', () => {
    const dir = tmp();
    const filePath = join(dir, 'w.json');
    mkdirSync(join(filePath, 'keep'), { recursive: true }); // the target is a non-empty directory: rename must fail
    const persistence = createFileWakeupPersistence(filePath);
    expect(() => persistence.save([])).toThrow();
    expect(readdirSync(dir)).toEqual(['w.json']);
    expect(readdirSync(filePath)).toEqual(['keep']);
  });

  test('(d″) 간격이 0 이하이거나 id 가 겹치는 파일은 손상으로 거부한다(복원이 멈추거나 항목을 잃지 않게)', () => {
    const t = new Date(2026, 9, 17, 9, 0, 0, 0).getTime();
    const base = { reason: 'x', dueAt: t - 1_000, fireCount: 0, retried: false };
    const bad: unknown[][] = [
      [{ ...base, id: 'w1', repeatMs: -60_000 }],
      [{ ...base, id: 'w1', repeatMs: 0 }],
      [{ ...base, id: 'w1' }, { ...base, id: 'w1', dueAt: t + 120_000 }],
    ];
    for (const entries of bad) {
      const dir = tmp();
      const filePath = join(dir, 'w.json');
      const original = JSON.stringify(entries);
      writeFileSync(filePath, original);
      const r = rig({ filePath, start: t });
      expect(r.s1.list()).toEqual([]);
      expect(r.s1.schedule({ delaySeconds: 120, reason: '거부' }).ok).toBe(false);
      expect(readFileSync(filePath, 'utf8')).toBe(original);
      r.s1.dispose();
    }
  });

  test('(k) 만들기는 던지지 않는다 — 저장 위치를 만들 수 없어도 TUI 기동은 계속된다', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'blocker'), 'file');
    const filePath = join(dir, 'blocker', 'w.json');
    const r = rig({ filePath });
    expect(r.s1.list()).toEqual([]);
    expect(r.s1.schedule({ delaySeconds: 120, reason: '저장 불가' }).ok).toBe(false);
    r.s1.dispose();
  });

  test('(l) 같은 세션 파일을 두 스케줄러가 쓰면 마지막 쓰기가 남는다(지원하지 않는 사용 · 파일은 항상 유효)', () => {
    const dir = tmp();
    const filePath = join(dir, 'w.json');
    const a = rig({ filePath });
    const b = rig({ filePath });
    expect(a.s1.schedule({ delaySeconds: 120, reason: 'A' }).ok).toBe(true);
    expect(b.s1.schedule({ delaySeconds: 180, reason: 'B' }).ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as Array<{ reason: string }>;
    expect(onDisk.map(e => e.reason)).toEqual(['B']);
    a.s1.dispose(); b.s1.dispose();
  });

  test('(m) 정상 세션의 도구 문면은 잠금·읽기 전용을 말하지 않고 단일 소유 한계를 말한다', () => {
    const dir = tmp();
    const r = rig({ filePath: join(dir, 'w.json') });
    const tool = buildScheduleWakeupHostTool(r.s1);
    expect(tool.description).toContain('not supported');
    expect(tool.description).not.toContain('lock');
    expect(tool.description).not.toContain('read-only');
    r.s1.dispose();
  });

  test('(e) schedule → cancel → 파일 재독기에 해당 id 부재', () => {
    const dir = tmp();
    const r = rig({ filePath: join(dir, 'w.json') });
    const res = r.s1.schedule({ delaySeconds: 120, reason: '취소 예정' });
    expect(res.ok).toBe(true);
    const onDisk = (): Array<{ id: string }> => JSON.parse(readFileSync(join(dir, 'w.json'), 'utf8'));
    expect(onDisk().map(e => e.id)).toEqual(['w1']);
    expect(r.s1.cancel('w1')).toBe(true);
    expect(onDisk().map(e => e.id)).toEqual([]);
    r.s1.dispose();
  });

  // ── 세션이 늦게 붙는 TUI(classic 대시보드는 스케줄러를 만들 때 세션 id 를 모른다) ──
  const sessionRig = (hq: string, env: NodeJS.ProcessEnv = {}) => {
    const clock = fakeClock();
    const scheduler = createWakeupScheduler({
      startTurnIfIdle: () => ({ opened: true, turnId: 'auto-1' }),
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, notify: () => {}, log: () => {},
    });
    const bind = createSessionWakeupBinder(scheduler, 'TESTSEAT', env, hq);
    const file = (session: string) => join(hq, 'seat-state', 'TESTSEAT', 'wakeups', `${session}.json`);
    return { clock, scheduler, bind, file };
  };

  test('(n) 세션이 붙은 뒤 예약하면 저장소에 기록되고, 재기동한 새 스케줄러가 같은 세션에 붙으면 복원된다', () => {
    const hq = tmp();
    const first = sessionRig(hq);
    first.bind(null);
    expect(first.scheduler.persists()).toBe(false);
    first.bind('sess-1');
    expect(first.scheduler.persists()).toBe(true);
    expect(first.scheduler.schedule({ delaySeconds: 120, repeatMinutes: 5, reason: '세션 뒤 예약' }).ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(first.file('sess-1'), 'utf8')) as Array<{ reason: string }>;
    expect(onDisk.map(e => e.reason)).toEqual(['세션 뒤 예약']);
    first.scheduler.dispose();

    const second = sessionRig(hq);
    expect(second.scheduler.list()).toEqual([]);
    second.bind('sess-1');
    expect(second.scheduler.list().map(e => e.reason)).toEqual(['세션 뒤 예약']);
    second.scheduler.dispose();
  });

  test('(n′) 붙기 전에 이미 걸린 예약은 새 파일의 예약과 id 가 겹치지 않게 이어지고 한 번 저장된다', () => {
    const hq = tmp();
    const seed = sessionRig(hq);
    seed.bind('sess-1');
    seed.scheduler.schedule({ delaySeconds: 120, reason: '파일 쪽' });
    seed.scheduler.dispose();

    const r = sessionRig(hq);
    expect(r.scheduler.schedule({ delaySeconds: 180, reason: '붙기 전' }).ok).toBe(true);
    r.bind('sess-1');
    const reasons = r.scheduler.list().map(e => e.reason).sort();
    expect(reasons).toEqual(['붙기 전', '파일 쪽']);
    const ids = r.scheduler.list().map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const onDisk = JSON.parse(readFileSync(r.file('sess-1'), 'utf8')) as Array<{ id: string }>;
    expect(onDisk.map(e => e.id).sort()).toEqual([...ids].sort());
    r.scheduler.dispose();
  });

  test('(n″) 같은 세션 id 를 다시 알려도 예약이 복제되지 않는다', () => {
    const hq = tmp();
    const r = sessionRig(hq);
    r.bind('sess-1');
    r.scheduler.schedule({ delaySeconds: 120, reason: '한 번만' });
    const before = r.scheduler.list().map(e => e.id);
    r.bind('sess-1');
    r.bind('sess-1');
    expect(r.scheduler.list().map(e => e.id)).toEqual(before);
    r.scheduler.dispose();
  });

  test('(o) 예약은 만든 세션에 귀속한다: sess-1 → 2 → 1 왕복 뒤에도 발화는 1회, 옮겨지지 않는다', () => {
    const hq = tmp();
    const clock = fakeClock();
    const opened: string[] = [];
    const scheduler = createWakeupScheduler({
      startTurnIfIdle: (input) => { opened.push(input); return { opened: true, turnId: `auto-${opened.length}` }; },
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, notify: () => {}, log: () => {},
    });
    const bind = createSessionWakeupBinder(scheduler, 'TESTSEAT', {}, hq);
    const file = (session: string) => join(hq, 'seat-state', 'TESTSEAT', 'wakeups', `${session}.json`);
    bind('sess-1');
    scheduler.schedule({ delaySeconds: 120, reason: '귀속' });
    bind('sess-2');
    // The entry belongs to sess-1: not carried into sess-2's memory or file.
    expect(scheduler.list()).toEqual([]);
    expect(existsSync(file('sess-2'))).toBe(false);
    bind('sess-1');
    expect(scheduler.list().map(e => e.reason)).toEqual(['귀속']);
    clock.advance(130_000);
    expect(opened.filter(text => text.includes('귀속'))).toHaveLength(opened.length);
    expect(opened.map(() => 'fired')).toEqual(['fired']);
    // Gone from sess-1's file after it fired; a later round trip fires nothing more.
    bind('sess-2');
    bind('sess-1');
    clock.advance(130_000);
    expect(opened.map(() => 'fired')).toEqual(['fired']);
    scheduler.dispose();
  });

  test('(o′) 세션 2 에서 건 예약은 세션 2 에 남고 세션 1 로 돌아가도 섞이지 않는다', () => {
    const hq = tmp();
    const r = sessionRig(hq);
    r.bind('sess-1');
    r.scheduler.schedule({ delaySeconds: 120, reason: '하나' });
    r.bind('sess-2');
    r.scheduler.schedule({ delaySeconds: 180, reason: '둘' });
    r.bind('sess-1');
    expect(r.scheduler.list().map(e => e.reason)).toEqual(['하나']);
    r.bind('sess-2');
    expect(r.scheduler.list().map(e => e.reason)).toEqual(['둘']);
    r.scheduler.dispose();
  });

  test('(s) 도구는 저장 여부를 설명(생성 시점)이 아니라 결과(호출 시점)로 말한다 — 늦게 묶여도 거짓이 아니다', async () => {
    const hq = tmp();
    const r = sessionRig(hq);
    const tool = buildScheduleWakeupHostTool(r.scheduler); // built before any session is attached
    expect(tool.description).not.toContain('no wakeup file');
    const call = (delaySeconds: number) => tool.handler({ action: 'schedule', delaySeconds, reason: '늦은 묶음' } as never, {} as never) as Promise<{ saved: boolean }>;
    expect((await call(120)).saved).toBe(false);
    r.bind('sess-1');
    expect((await call(180)).saved).toBe(true);
    r.scheduler.dispose();
  });

  test('(p) 하니스 자식이거나 자리가 아니면 묶지 않는다(메모리만)', () => {
    const hq = tmp();
    const child = sessionRig(hq, { ELANOUS_HARNESS_ROLE: 'child' });
    child.bind('sess-1');
    expect(child.scheduler.persists()).toBe(false);
    expect(existsSync(child.file('sess-1'))).toBe(false);
    expect(sessionWakeupPersistence(null, 'sess-1', {}, hq)).toBeNull();
    expect(sessionWakeupPersistence('TESTSEAT', 'bad/session', {}, hq)).toBeNull();
    child.scheduler.dispose();
  });

  test('(q) 새 세션 파일이 손상이면 지금 예약은 메모리에서 계속 돌고 원본은 그대로다', () => {
    const hq = tmp();
    const r = sessionRig(hq);
    r.scheduler.schedule({ delaySeconds: 120, reason: '메모리 예약' });
    mkdirSync(join(hq, 'seat-state', 'TESTSEAT', 'wakeups'), { recursive: true });
    writeFileSync(r.file('sess-9'), '{"broken":');
    r.bind('sess-9');
    expect(r.scheduler.list().map(e => e.reason)).toEqual(['메모리 예약']);
    expect(r.scheduler.persists()).toBe(false);
    expect(readFileSync(r.file('sess-9'), 'utf8')).toBe('{"broken":');
    r.scheduler.dispose();
  });

  test('(r) 배선: 세션 id 를 바꾸는 모든 자리가 저장 위치를 다시 묶는다(classic 대시보드·next TUI)', () => {
    const read = (path: string) => readFileSync(join(import.meta.dir, path), 'utf8');
    const dashboard = read('../../dashboard/index.ts');
    const assigned = dashboard.match(/(?<!let )attachedSessionId = [^;]+;/g) ?? [];
    const boundAfter = dashboard.match(/(?<!let )attachedSessionId = [^;]+;\s*bindAttachedWakeupSession\(\);/g) ?? [];
    expect(assigned).not.toEqual([]);
    expect(boundAfter.length).toBe(assigned.length);
    expect(dashboard).not.toMatch(/persist: createFileWakeupPersistence/);
    const entry = read('../../tui/entry.ts');
    const reassign = "id = (?:targetId|next\\.id|createSession\\(\\{ source: 'tui' \\}\\)\\.id);";
    const changed = entry.match(new RegExp(`\\n\\s+${reassign}`, 'g')) ?? [];
    const rebound = entry.match(new RegExp(`\\n\\s+${reassign}\\s*bindWakeupSession\\?\\.\\(id\\);`, 'g')) ?? [];
    expect(changed).not.toEqual([]);
    expect(rebound.length).toBe(changed.length);
  });
});
