// WORKER-UNIFY (0.3.35) — 테스트 우주 시나리오 1건: 작업자 4종(eln·shell·pod·mission) fake 등록 →
// els 탭 한 목록 → stop 한 문 → 완료 이벤트 한 형식. 완료 경계 코드 = 내부 문서 `WORKER-UNIFY` (§4-2·§4-7·§4-8).
import { describe, expect, test } from 'bun:test';
import {
  createUnifiedWorkerRegistry,
  WORKER_COMPLETION_OUTCOMES,
  WORKER_SOURCE_KINDS,
  type UnifiedWorker,
  type WorkerCompletionEvent,
  type WorkerCompletionOutcome,
  type WorkerSourceKind,
} from './worker-registry.js';

const FIXED = new Date('2026-11-24T00:00:00.000Z');

/** 4종 fake — 장치별 어댑터 자리(els 원장·ShellRegistry·Pod Job·agent-mission)를 대신한다. */
const makeFake = (kind: WorkerSourceKind, suffix = ''): {
  worker: UnifiedWorker;
  stops: string[];
  complete: (outcome: WorkerCompletionOutcome, reason?: string | null) => void;
} => {
  const stops: string[] = [];
  let emit: ((outcome: WorkerCompletionOutcome, reason: string | null) => void) | undefined;
  const worker: UnifiedWorker = {
    id: `${kind}-f${suffix || 1}`,
    kind,
    title: `${kind} fake`,
    host: kind === 'pod' || kind === 'mission' ? 'node-c' : null,
    ...(kind === 'pod' ? { place: { runtime: 'pod' as const } } : {}),
    state: 'working',
    stop: (reason?: string) => { stops.push(reason ?? ''); },
    onCompletion: (cb) => {
      emit = cb;
      return { dispose: () => { emit = undefined; } };
    },
  };
  return { worker, stops, complete: (outcome, reason = null) => emit?.(outcome, reason) };
};

describe('WORKER-UNIFY 0.3.35 — 한 레지스트리 (eln·shell·pod·mission)', () => {
  test('어휘: 장치 4종 + 완료 결과 3종', () => {
    expect(WORKER_SOURCE_KINDS).toEqual(['eln', 'shell', 'pod', 'mission']);
    expect(WORKER_COMPLETION_OUTCOMES).toEqual(['done', 'failed', 'stopped']);
  });

  test('한 목록: 4종 fake 등록 → list() 한 배열 (els 탭)', () => {
    const reg = createUnifiedWorkerRegistry({ now: () => FIXED });
    for (const kind of WORKER_SOURCE_KINDS) reg.register(makeFake(kind).worker);
    const rows = reg.list();
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.kind)).toEqual(['eln', 'shell', 'pod', 'mission']);
    expect(rows.map((row) => row.id)).toEqual(['eln-f1', 'shell-f1', 'pod-f1', 'mission-f1']);
    expect(rows[2]).toEqual({ id: 'pod-f1', kind: 'pod', title: 'pod fake', host: 'node-c', place: { runtime: 'pod' }, state: 'working' });
    expect(reg.size()).toBe(4);
  });

  test('등록 계약: 빈 id·어휘 밖 kind·같은 id 재등록 거부 (fail closed)', () => {
    const reg = createUnifiedWorkerRegistry();
    const shell = makeFake('shell');
    expect(() => reg.register({ ...shell.worker, id: '' })).toThrow();
    reg.register(shell.worker);
    expect(() => reg.register(makeFake('shell', '2').worker)).not.toThrow();
    expect(() => reg.register(makeFake('pod', '3').worker)).not.toThrow();
    expect(() => reg.register({ ...shell.worker, id: 'again', kind: 'daemon' as WorkerSourceKind })).toThrow();
    expect(() => reg.register({ ...shell.worker, id: shell.worker.id })).toThrow();
  });

  test('stop 한 문: 4종 어느 것이든 같은 stop(id, reason) 문으로', () => {
    const reg = createUnifiedWorkerRegistry({ now: () => FIXED });
    const fakes = WORKER_SOURCE_KINDS.map((kind) => makeFake(kind));
    for (const fake of fakes) reg.register(fake.worker);
    const events: WorkerCompletionEvent[] = [];
    reg.onCompletion((event) => events.push(event));
    expect(reg.stop('shell-f1', 'OP 지시')).toBe(true);
    expect(reg.stop('pod-f1', '예산 초과')).toBe(true);
    expect(fakes[1]!.stops).toEqual(['OP 지시']);
    expect(fakes[2]!.stops).toEqual(['예산 초과']);
    expect(fakes[0]!.stops).toEqual([]);
    expect(reg.stop('없는-아이디')).toBe(false);
    expect(events.map((event) => [event.workerId, event.outcome, event.reason])).toEqual([
      ['shell-f1', 'stopped', 'OP 지시'],
      ['pod-f1', 'stopped', '예산 초과'],
    ]);
  });

  test('완료 이벤트 한 형식: eln done · mission failed · stop stopped 모두 같은 꼴', () => {
    const reg = createUnifiedWorkerRegistry({ now: () => FIXED });
    const fakes = WORKER_SOURCE_KINDS.map((kind) => makeFake(kind));
    for (const fake of fakes) reg.register(fake.worker);
    const events: WorkerCompletionEvent[] = [];
    const unsub = reg.onCompletion((event) => events.push(event));
    fakes[0]!.complete('done');
    fakes[3]!.complete('failed', 'engine fault');
    reg.stop('shell-f1', 'OP 멈춤');
    fakes[2]!.complete('stopped');
    const keysOf = (event: WorkerCompletionEvent) => Object.keys(event).sort().join(',');
    expect(new Set(events.map(keysOf))).toEqual(new Set([['at', 'kind', 'outcome', 'reason', 'workerId'].join(',')]));
    expect(events).toEqual([
      { workerId: 'eln-f1', kind: 'eln', outcome: 'done', reason: null, at: FIXED.toISOString() },
      { workerId: 'mission-f1', kind: 'mission', outcome: 'failed', reason: 'engine fault', at: FIXED.toISOString() },
      { workerId: 'shell-f1', kind: 'shell', outcome: 'stopped', reason: 'OP 멈춤', at: FIXED.toISOString() },
      { workerId: 'pod-f1', kind: 'pod', outcome: 'stopped', reason: null, at: FIXED.toISOString() },
    ]);
    unsub.dispose();
    fakes[0]!.complete('done');
    expect(events).toHaveLength(4);
  });

  test('dispose: 정리 뒤 목록 비움 · stop 거짓', () => {
    const reg = createUnifiedWorkerRegistry();
    const fake = makeFake('mission');
    reg.register(fake.worker);
    reg.dispose();
    expect(reg.list()).toEqual([]);
    expect(reg.size()).toBe(0);
    expect(reg.stop('mission-f1')).toBe(false);
    expect(fake.stops).toEqual([]);
  });
});
