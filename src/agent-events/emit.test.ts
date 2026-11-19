import { expect, test } from 'bun:test';
import { createAgentEventEmitter, getAgentEventEmitter } from './emit.js';

test('frames reach the transport one at a time, in emission order, even when the first is the slowest; seq only goes up', async () => {
  const seen: { kind: string; seq: number }[] = [];
  let inFlight = false;
  let overlapped = false;
  const emit = createAgentEventEmitter({ ws: 'OP', socketPath: '/x', pane: 'p1', send: async (_s, frame) => {
    if (inFlight) overlapped = true;
    inFlight = true;
    if (frame.event.kind === 'child' && frame.event.action === 'start') await new Promise((resolve) => setTimeout(resolve, 30)); // the first call is the slow one
    seen.push({ kind: frame.event.kind === 'child' ? `child.${frame.event.action}` : frame.event.kind, seq: frame.seq });
    inFlight = false;
    return { exitCode: 0, message: '' };
  } });
  emit.child.start({ id: 'a', source: 'harness', label: 'a' });
  emit.state('working');
  emit.child.progress('a', 'step');
  emit.state('idle');
  emit.child.end('a', true, 'ok');
  await emit.flush();
  expect(seen.map((row) => row.kind)).toEqual(['child.start', 'state', 'child.progress', 'state', 'child.end']);
  expect(overlapped).toBe(false);
  expect(seen.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);     // a plain counter inside one sender: it goes up by one, never by the clock
});

test('a failed frame does not stop the ones behind it, and the backlog of a hung host is bounded', async () => {
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const emit = createAgentEventEmitter({ ws: 'OP', socketPath: '/x', send: async (_s, frame) => {
    if (frame.event.kind === 'child') seen.push(`${frame.event.action}:${frame.event.id}`);
    if (seen.length === 1) { await gate; throw new Error('first one fails'); }
    return { exitCode: 0, message: '' };
  } });
  emit.child.start({ id: 'first', source: 'harness', label: 'f' });
  for (let i = 0; i < 400; i++) emit.child.progress('first', `p${i}`); // the hung head blocks everything behind it
  release();
  await emit.flush();
  expect(seen[0]).toBe('start:first');
  expect(seen.length).toBe(256); // 출처: #38499 — 256 슬롯 정확히: 1 start + 400 progress 중 255 progress만 큐잉, 나머지는 버림(1+255=256)
  // 출처: #38499 — 위 단언이 정확(≠401)이므로 이전의 부정확한 `=== 401 → false` 단언을 대체
  expect(seen).toContain('progress:first'); // ...and the failure of the first did not stop the rest
});


test('the emitter never throws into its caller: a throwing log or transport is one swallowed failure each', async () => {
  const logged: string[] = [];
  const emit = createAgentEventEmitter({ ws: 'OP', socketPath: '/x', log: (event, data) => { logged.push(`${event}:${String(data.what)}`); }, send: async () => { throw new Error('transport down'); } });
  expect(() => { emit.state('idle'); emit.child.start({ id: 'a', source: 'harness', label: 'a' }); emit.release(); }).not.toThrow();
  await emit.flush();
  const bad = createAgentEventEmitter({ ws: 'OP', socketPath: '/x', log: () => { throw new Error('log down'); }, send: async () => ({ exitCode: 0, message: '' }) });
  expect(() => bad.meta({ model: 'x' })).not.toThrow();
  expect(logged).toEqual([]);                                     // the transport failure is swallowed in the chain, not a producer-side throw
});

test('a throwing clock eats no queue slots: once the clock heals, frames flow again', async () => {
  let clockDown = false;
  const logged: string[] = [];
  const seen: string[] = [];
  const healthy = Date.now;
  const emit = createAgentEventEmitter({ ws: 'OP', socketPath: '/x', now: () => { if (clockDown) throw new Error('clock down'); return healthy(); },
    log: (event) => { logged.push(event); },
    send: async (_socketPath, frame) => { seen.push(frame.event.kind); return { exitCode: 0, message: 'kept' }; } });
  emit.meta({ title: 'before the outage' });
  clockDown = true;
  for (let i = 0; i < 300; i++) emit.meta({ title: 'during the outage' }); // 출처: #38499 - terra must 2: 300 failing frames, more than the 256-slot backlog, must not eat the queue
  expect(() => emit.meta({ title: 'still down' })).not.toThrow();
  clockDown = false;
  emit.meta({ title: 'after the outage' });
  await emit.flush();
  expect(logged.some((line) => line.startsWith('agent-event-threw'))).toBe(true); // each failure stays visible as one logged line - same as before the fix
  expect(seen).toEqual(['meta', 'meta']); // and the queue healed: frames the broken clock would have jammed out forever still go out
});

test('a swallowed throwing-clock frame leaves no seq hole: the next frames are 1 and 2, not 1 and 3', async () => {
  let clockDown = true;
  const healthy = Date.now;
  const seen: number[] = [];
  const emit = createAgentEventEmitter({ ws: 'OP', socketPath: '/x', now: () => { if (clockDown) throw new Error('clock down'); return healthy(); },
    log: () => {}, send: async (_socketPath, frame) => { seen.push(frame.seq); return { exitCode: 0, message: '' }; } });
  expect(() => emit.meta({ title: 'thrown away' })).not.toThrow(); // the first frame is swallowed — its seq must not be consumed
  clockDown = false;
  emit.meta({ title: 'one' });
  emit.meta({ title: 'two' });
  await emit.flush();
  expect(seen).toEqual([1, 2]); // 출처: #38499 — seq 는 프레임 생성 성공 뒤에만 소모: throw 로 삼킨 프레임이 구멍(1, 3)을 내지 않는다
});

test('distinct environments whose | -joined key would collide get distinct emitters', () => {
  const a = getAgentEventEmitter({ ELANOUS_EVENT_SOCKET: '/tmp/a|b', ELANOUS_EVENT_WS: 'c' });
  const b = getAgentEventEmitter({ ELANOUS_EVENT_SOCKET: '/tmp/a', ELANOUS_EVENT_WS: 'b|c' });
  expect(b).not.toBe(a); // 출처: #38499 — '|' 문자열 키 충돌: ('/tmp/a|b','c','') 와 ('/tmp/a','b|c','') 가 같은 캐시 키로 남의 emitter 를 돌려주지 않는다
});
