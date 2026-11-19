import { expect, test } from 'bun:test';
import { parseEventFrame } from './protocol.js';

test('parseEventFrame: a valid frame is normalised; malformed is refused; a newer version or an unknown kind is skipped, not an error', () => {
  const base = { op: 'event', v: 1, ws: 'OP', pane: 'p1', sid: 'sender-1', seq: 5, at: 1 };
  expect(parseEventFrame({ ...base, event: { kind: 'state', state: 'working', message: 'x'.repeat(500) } })).toEqual({ ok: true,
    frame: { op: 'event', v: 1, ws: 'OP', pane: 'p1', sid: 'sender-1', seq: 5, at: 1, event: { kind: 'state', state: 'working', message: 'x'.repeat(200) } } });
  expect(parseEventFrame({ ...base, event: { kind: 'state', state: 'sleeping' } })).toEqual({ ok: false, ignore: false, reason: 'state: unknown state' });
  expect(parseEventFrame({ ...base, seq: -1, event: { kind: 'release' } })).toEqual({ ok: false, ignore: false, reason: 'frame needs ws, sid, seq and at' });
  expect(parseEventFrame({ ...base, sid: undefined, event: { kind: 'release' } })).toEqual({ ok: false, ignore: false, reason: 'frame needs ws, sid, seq and at' });
  expect(parseEventFrame({ ...base, v: 2, event: { kind: 'release' } })).toEqual({ ok: false, ignore: true, reason: 'unknown protocol version 2' });
  expect(parseEventFrame({ ...base, event: { kind: 'telepathy' } })).toEqual({ ok: false, ignore: true, reason: 'unknown event kind telepathy' });
  for (const junk of [null, 7, 'x', [], { op: 'ls' }]) expect(parseEventFrame(junk).ok).toBe(false);
});

test('a hostile v never makes parsing throw - it lands in ignore like any unknown version', () => {
  // terra must 1 (#38499): JSON can deliver {"v": {"toString": null}}, where String(v) itself throws - the reason must not become a crash.
  const hostile = JSON.parse('{"op":"event","v":{"toString":null},"ws":"OP","sid":"sender-1","seq":1,"at":1,"event":{"kind":"release"}}');
  expect(parseEventFrame(hostile)).toEqual({ ok: false, ignore: true, reason: 'unknown protocol version unprintable' });
  const throwing = { op: 'event', v: { toString: () => { throw new Error('boom'); } }, ws: 'OP', sid: 'sender-1', seq: 2, at: 1, event: { kind: 'release' } }; // 출처: #38499 - terra must 1
  expect(parseEventFrame(throwing)).toEqual({ ok: false, ignore: true, reason: 'unknown protocol version unprintable' });
});

test('seq starts at 1 - zero is refused, one is accepted (v1 wire contract)', () => {
  const base = { op: 'event', v: 1, ws: 'OP', pane: 'p1', sid: 'sender-1', seq: 5, at: 1 };
  // 출처: #38499 — v1 계약: seq 는 1부터(protocol.ts:39 계약 주석), 0은 거부
  expect(parseEventFrame({ ...base, seq: 0, event: { kind: 'release' } })).toEqual({ ok: false, ignore: false, reason: 'frame needs ws, sid, seq and at' });
  expect(parseEventFrame({ ...base, seq: 1, event: { kind: 'release' } })).toEqual({ ok: true, frame: { op: 'event', v: 1, ws: 'OP', pane: 'p1', sid: 'sender-1', seq: 1, at: 1, event: { kind: 'release' } } }); // 출처: #38499 — seq:1 은 정상 프레임
});

test('turn without an id is refused - empty core is gone (terra must-3)', () => {
  const base = { op: 'event', v: 1, ws: 'OP', pane: 'p1', sid: 'sender-1', seq: 5, at: 1 };
  // 출처: #38499 — turn.id 필수(80자 상한), 코어시 폐지(terra must-3)
  expect(parseEventFrame({ ...base, event: { kind: 'turn', phase: 'start', id: '' } })).toEqual({ ok: false, ignore: false, reason: 'turn: needs id' });
  expect(parseEventFrame({ ...base, event: { kind: 'turn', phase: 'end', id: 'x'.repeat(500) } })).toEqual({ ok: true,
    frame: { op: 'event', v: 1, ws: 'OP', pane: 'p1', sid: 'sender-1', seq: 5, at: 1, event: { kind: 'turn', phase: 'end', id: 'x'.repeat(80) } } }); // 출처: #38499 — 80자 상한 그대로
});
