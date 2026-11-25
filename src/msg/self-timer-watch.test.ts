// ── 셀프 타이머·감시 시험 — 가짜 시계·가짜 gh·가짜 우편 (ELN-SELF-TIMER-WATCH · I3) ──
// 발화·만료(시끄럽게)·중복 합침·원장 묶임 필수·지평·백오프·틱·탐침 오류. 벽시계 단언 0 · 숫자는 모듈 상수로(NUMGUARD).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommitmentLedger } from '../commitment/ledger.js';
import {
  SELF_TIMER_BACKOFF_FACTOR, SELF_TIMER_EVENTS, SELF_TIMER_MAX_HORIZON_MS, SELF_TIMER_POLL_MAX_MS, SELF_TIMER_POLL_MIN_MS,
  armWaker, evaluateWaker, formatWaitCondition, listWakers, nextBackoff, parseDuration, parseWaitCondition,
  reviewResultFileArrived, tickWakers, watchWaker, parentAliveProbe, WakerBindingError, WakerHorizonError, type SelfTimerDeps, type WaitProbes,
} from './self-timer-watch.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const BASE = Date.parse('2026-11-17T09:00:00.000Z');

function harness(probeOverrides: Partial<WaitProbes> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'self-timer-'));
  roots.push(root);
  let nowMs = BASE;
  let wid = 0;
  let cid = 0;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const notices: { seat: string; body: string }[] = [];
  const sleeps: number[] = [];
  const calls: string[] = [];
  const now = () => new Date(nowMs);
  const emit = (_c: string, event: string, data: Record<string, unknown>) => { events.push({ event, data }); };
  const ledger = new CommitmentLedger({ root: join(root, 'ledger'), now, newId: () => `c-${++cid}`, emit });
  const probes: WaitProbes = {
    prMerged: async (pr) => { calls.push(`pr:${pr}`); return false; },
    reviewArrived: async (pr) => { calls.push(`review:${pr}`); return false; },
    mailReplied: async (m) => { calls.push(`mail:${m}`); return false; },
    fileExists: async (p) => { calls.push(`file:${p}`); return false; },
    ...probeOverrides,
  };
  const deps: SelfTimerDeps = {
    root: join(root, 'wakers'), ledger, now, emit, probes,
    newId: () => `w-${++wid}`,
    sleep: async (ms) => { sleeps.push(ms); nowMs += ms; },
    postNotice: async (seat, body) => { notices.push({ seat, body }); return notices.length; },
    pid: 4242,
    isPidAlive: () => false,
  };
  const entry = ledger.add({ seat: 'TC', sessionId: 's1', text: '#38049 착지 확인 후 보고', evidence: '다음 스텝: #38049 착지 확인 후 보고.' }).entry;
  return { root, deps, ledger, entry, events, notices, sleeps, calls, advance: (ms: number) => { nowMs += ms; }, nowMs: () => nowMs };
}

describe('조건 문법', () => {
  test('다섯 꼴 해석 ⊕ 정규형', () => {
    expect(formatWaitCondition(parseWaitCondition('time:30m'))).toBe('time:30m');
    expect(formatWaitCondition(parseWaitCondition('time:2h'))).toBe('time:2h');
    expect(parseWaitCondition('pr-merged:#38049')).toEqual({ kind: 'pr-merged', pr: 38049 });
    expect(parseWaitCondition('review:38050')).toEqual({ kind: 'review', pr: 38050 });
    expect(parseWaitCondition('mail-reply:4123')).toEqual({ kind: 'mail-reply', message: 4123 });
    expect(parseWaitCondition('file:out/receipt.json', '/w')).toEqual({ kind: 'file', path: '/w/out/receipt.json' });
  });
  test('틀린 꼴은 거부', () => {
    for (const bad of ['30m', 'time:', 'time:0m', 'time:soon', 'pr-merged:abc', 'nope:1', 'file:']) expect(() => parseWaitCondition(bad)).toThrow();
    expect(() => parseDuration('-5m')).toThrow();
  });
});

describe('원장 묶임 필수', () => {
  test('없는 원장 항목 = 거부', () => {
    const h = harness();
    expect(() => armWaker({ seat: 'TC', commitmentId: 'c-none', condition: 'time:10m' }, h.deps)).toThrow(WakerBindingError);
    expect(listWakers('TC', h.deps)).toEqual([]);
  });
  test('닫힌(done) 항목 = 거부', () => {
    const h = harness();
    h.ledger.markDone('TC', h.entry.id, 'receipt');
    expect(() => armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'time:10m' }, h.deps)).toThrow(WakerBindingError);
  });
  test('걸면 원장 항목에 깨우개 참조가 붙는다', () => {
    const h = harness();
    const { waker, merged } = armWaker({ seat: 'tc', commitmentId: h.entry.id, condition: 'pr-merged:38049' }, h.deps);
    expect(merged).toBe(false);
    expect(h.ledger.get('TC', h.entry.id)!.wakers.map(w => [w.wakerId, w.condition])).toEqual([[waker.id, 'pr-merged:38049']]);
    expect(h.events.map(e => e.event)).toContain(SELF_TIMER_EVENTS.armed);
  });
});

describe('최대 지평', () => {
  test('기본 지평 = 최대 지평', () => {
    const h = harness();
    const { waker } = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'pr-merged:1' }, h.deps);
    expect(Date.parse(waker.deadlineAt) - Date.parse(waker.armedAt)).toBe(SELF_TIMER_MAX_HORIZON_MS);
  });
  test('--within 이 최대 지평보다 길면 거부 · time 이 지평 밖이면 거부', () => {
    const h = harness();
    expect(() => armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'pr-merged:1', withinMs: SELF_TIMER_MAX_HORIZON_MS + 1 }, h.deps)).toThrow(WakerHorizonError);
    expect(() => armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: `time:${SELF_TIMER_MAX_HORIZON_MS / 60_000 + 1}m` }, h.deps)).toThrow(WakerHorizonError);
  });
});

describe('중복 합침', () => {
  test('같은 항목·같은 조건 = 하나 · 다른 조건 = 따로', () => {
    const h = harness();
    const a = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'pr-merged:38049' }, h.deps);
    const b = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'pr-merged:#38049' }, h.deps);
    expect(b.merged).toBe(true);
    expect(b.waker.id).toBe(a.waker.id);
    expect(h.events.map(e => e.event)).toContain(SELF_TIMER_EVENTS.merged);
    const c = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'review:38049' }, h.deps);
    expect(c.waker.id).not.toBe(a.waker.id);
    expect(listWakers('TC', h.deps)).toHaveLength(2);
    expect(h.ledger.get('TC', h.entry.id)!.wakers).toHaveLength(2);
  });
  test('다른 살아 있는 프로세스가 지켜보는 깨우개는 두 번째 루프를 안 돈다', async () => {
    const h = harness();
    const { waker } = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'pr-merged:7' }, h.deps);
    await watchWaker('TC', waker.id, { ...h.deps, probes: { ...h.deps.probes!, prMerged: async () => { throw new Error('stop-first-loop'); } }, sleep: async () => { throw new Error('halt'); } }).catch(() => undefined);
    const second = await watchWaker('TC', waker.id, { ...h.deps, pid: 9999, isPidAlive: (pid) => pid === 4242 });
    expect(second.outcome).toBe('watched-elsewhere');
    expect(h.notices).toEqual([]);
  });
});

describe('발화', () => {
  test('PR 머지 — 세 번째 점검에 발화 · notice 1통 · 원장은 열린 채(자동 닫기 0)', async () => {
    let n = 0;
    const h = harness({ prMerged: async () => ++n >= 3 });
    const { waker } = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'pr-merged:38049' }, h.deps);
    const result = await watchWaker('TC', waker.id, h.deps);
    expect(result.outcome).toBe('fired');
    expect(result.waker).toMatchObject({ status: 'fired', checks: 3, noticeMessageId: 1 });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.seat).toBe('TC');
    expect(h.notices[0]!.body).toContain('pr-merged:38049');
    expect(h.notices[0]!.body).toContain(h.entry.text);
    expect(h.ledger.get('TC', h.entry.id)!.status).toBe('open');
    expect(h.events.map(e => e.event)).toContain(SELF_TIMER_EVENTS.fired);
  });

  test('시간 — 탐침 없이 발화 시각에 발화 · 백오프가 발화 시각을 넘지 않는다', async () => {
    const h = harness();
    const { waker } = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'time:10m' }, h.deps);
    const result = await watchWaker('TC', waker.id, h.deps);
    expect(result.outcome).toBe('fired');
    expect(h.nowMs()).toBe(Date.parse(waker.fireAt!));
    expect(h.calls).toEqual([]);
  });

  test('우편 회신 — 가짜 우편 저장소', async () => {
    const replies = new Map<number, number>([[4123, 0]]);
    const fakeStore = { listReplies: (id: number) => Array.from({ length: replies.get(id) ?? 0 }) };
    const h = harness({ mailReplied: async (id) => fakeStore.listReplies(id).length > 0 });
    const { waker } = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'mail-reply:4123' }, h.deps);
    expect((await evaluateWaker('TC', waker.id, h.deps)).outcome).toBe('pending');
    replies.set(4123, 1);
    expect((await evaluateWaker('TC', waker.id, h.deps)).outcome).toBe('fired');
  });

  test('파일 생성 — 실제 파일 시스템', async () => {
    const h = harness({ fileExists: async (p) => (await import('node:fs')).existsSync(p) });
    const target = join(h.root, 'receipt.json');
    const { waker } = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: `file:${target}` }, h.deps);
    expect((await evaluateWaker('TC', waker.id, h.deps)).outcome).toBe('pending');
    writeFileSync(target, '{}');
    expect((await evaluateWaker('TC', waker.id, h.deps)).outcome).toBe('fired');
  });

  test('닫힌 깨우개는 다시 재도 아무것도 안 한다', async () => {
    const h = harness({ prMerged: async () => true });
    const { waker } = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'pr-merged:1' }, h.deps);
    await evaluateWaker('TC', waker.id, h.deps);
    expect((await evaluateWaker('TC', waker.id, h.deps)).outcome).toBe('closed');
    expect(h.notices).toHaveLength(1);
  });
});

describe('만료는 시끄럽게', () => {
  test('지평 안에 안 차면 expired notice · 루프는 지평에서 끝난다', async () => {
    const h = harness();
    const { waker } = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'review:38050', withinMs: parseDuration('30m') }, h.deps);
    const result = await watchWaker('TC', waker.id, h.deps);
    expect(result.outcome).toBe('expired');
    expect(h.nowMs()).toBe(Date.parse(waker.deadlineAt));
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.body).toContain('expired');
    expect(h.notices[0]!.body).toContain('review:38050');
    expect(h.events.map(e => e.event)).toContain(SELF_TIMER_EVENTS.expired);
    expect(h.ledger.get('TC', h.entry.id)!.status).toBe('open');
  });

  test('탐침 오류는 probe-error 로 남고 «아직»으로 본다', async () => {
    const h = harness({ prMerged: async () => { throw new Error('gh: network'); } });
    const { waker } = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'pr-merged:1' }, h.deps);
    expect((await evaluateWaker('TC', waker.id, h.deps)).outcome).toBe('pending');
    expect(h.events.map(e => e.event)).toContain(SELF_TIMER_EVENTS.probeError);
  });
});

describe('백오프 · 틱', () => {
  test('간격은 최소에서 두 배씩 · 상한에서 멈춘다', async () => {
    const h = harness();
    const { waker } = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'pr-merged:1' }, h.deps);
    await watchWaker('TC', waker.id, h.deps);
    expect(h.sleeps[0]).toBe(SELF_TIMER_POLL_MIN_MS);
    expect(h.sleeps[1]).toBe(SELF_TIMER_POLL_MIN_MS * SELF_TIMER_BACKOFF_FACTOR);
    expect(Math.max(...h.sleeps)).toBe(SELF_TIMER_POLL_MAX_MS);
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(SELF_TIMER_MAX_HORIZON_MS);
    expect(nextBackoff(SELF_TIMER_POLL_MAX_MS)).toBe(SELF_TIMER_POLL_MAX_MS);
  });

  test('tick = armed 만 한 번씩 · 루프 없음', async () => {
    const h = harness({ prMerged: async (pr) => pr === 2 });
    armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'pr-merged:1' }, h.deps);
    armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'pr-merged:2' }, h.deps);
    const first = await tickWakers('TC', h.deps);
    expect(first.map(t => t.outcome)).toEqual(['pending', 'fired']);
    expect(h.sleeps).toEqual([]);
    const all = await tickWakers(undefined, h.deps);
    expect(all.map(t => t.outcome)).toEqual(['pending']);
  });
});

describe('리뷰 결과 파일 저장소', () => {
  test('since 뒤 · 그 PR 번호 파일만 도착으로 본다', () => {
    const h = harness();
    const dir = join(h.root, 'review-results');
    mkdirSync(dir, { recursive: true });
    const since = new Date(BASE).toISOString();
    const parse = (text: string) => JSON.parse(text) as { pr?: number };
    const old = join(dir, 'card-38050-aaaaaaaaaaaa.json');
    writeFileSync(old, JSON.stringify({ pr: 38050 }));
    utimesSync(old, new Date(BASE - 1000), new Date(BASE - 1000));
    expect(reviewResultFileArrived(dir, 38050, since, parse)).toBe(false);
    const other = join(dir, 'card-38051-bbbbbbbbbbbb.json');
    writeFileSync(other, JSON.stringify({ pr: 38051 }));
    utimesSync(other, new Date(BASE + 1000), new Date(BASE + 1000));
    expect(reviewResultFileArrived(dir, 38050, since, parse)).toBe(false);
    const fresh = join(dir, 'card-38050-cccccccccccc.json');
    writeFileSync(fresh, JSON.stringify({ pr: 38050 }));
    utimesSync(fresh, new Date(BASE + 1000), new Date(BASE + 1000));
    expect(reviewResultFileArrived(dir, 38050, since, parse)).toBe(true);
  });
});

describe('RAIL30 ⑥ — a blocking watch follows its parent', () => {
  test('parent gone after the second slice → orphaned · the waker stays armed without a watcher pid', async () => {
    const h = harness();
    const { waker } = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'pr-merged:38049' }, h.deps);
    let checks = 0;
    const result = await watchWaker('TC', waker.id, { ...h.deps, parentAlive: () => ++checks <= 2 });
    expect(result.outcome).toBe('orphaned');
    expect(result.waker.status).toBe('armed');
    expect(result.waker.watcherPid).toBeUndefined();
    expect(h.sleeps).toEqual([30_000, 30_000]);
    expect(h.events.map((e) => e.event)).toContain('self-timer.orphaned');
  });

  test('parent alive → slices of 30 s until the condition holds (fires as before)', async () => {
    let n = 0;
    const h = harness({ prMerged: async () => ++n >= 2 });
    const { waker } = armWaker({ seat: 'TC', commitmentId: h.entry.id, condition: 'pr-merged:38049' }, h.deps);
    const result = await watchWaker('TC', waker.id, { ...h.deps, parentAlive: () => true });
    expect(result.outcome).toBe('fired');
    expect(h.sleeps.every((ms) => ms <= 30_000)).toBe(true);
  });

  test('production probe: started under pid 1 = no probe · re-parented to 1 = gone', () => {
    expect(parentAliveProbe(1, () => 1)).toBeUndefined();
    let ppid = 7068;
    const probe = parentAliveProbe(7068, () => ppid)!;
    expect(probe()).toBe(true);
    ppid = 1;
    expect(probe()).toBe(false);
  });
});
