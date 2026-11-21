import { expect, test } from 'bun:test';
import { createAgentEventEmitter } from '../agent-events/emit.js';
import type { AgentEventFrame } from '../agent-events/protocol.js';
import { decodeEventLine, encodeEventFrame } from './agent-events.js';

const frame = (event: AgentEventFrame['event']): AgentEventFrame => ({ op: 'event', v: 1, ws: 'OP', sid: 's1', seq: 1, at: 1, event });

test('round trip: every state incl. waiting-input, turn start/end, notice', () => {
  for (const event of [
    ...(['idle', 'working', 'blocked', 'waiting-input'] as const).map((state) => ({ kind: 'state', state }) as const),
    { kind: 'turn', phase: 'start', id: 't1' }, { kind: 'turn', phase: 'end', id: 't1' },
    { kind: 'notice', level: 'warn', text: 'build red' },
  ] as const) expect(decodeEventLine(encodeEventFrame(frame(event)))).toEqual({ ok: true, frame: frame(event) });
});

test('validator rejects bad json, bad state, missing turn id and secret-shaped text', () => {
  const bad = (s: string) => expect(decodeEventLine(s).ok).toBe(false);
  bad('{');
  bad(encodeEventFrame(frame({ kind: 'state', state: 'sleeping' } as never)));
  bad(encodeEventFrame(frame({ kind: 'turn', phase: 'start', id: '' })));
  bad(encodeEventFrame(frame({ kind: 'notice', level: 'info', text: 'key sk-abcdefghijklmnop1234' })));
  bad(encodeEventFrame(frame({ kind: 'state', state: 'blocked', message: 'Bearer abcdefgh12345678' })));
});

test('the real emitter frames decode on the els side', async () => {
  const lines: string[] = [];
  const emitter = createAgentEventEmitter({ ws: 'OP', socketPath: 'x', send: async (_p, f) => { lines.push(encodeEventFrame(f)); return { exitCode: 0, message: '' }; } });
  emitter.turn('start', 't9'); emitter.state('working'); await emitter.flush();
  expect(lines.map((l) => decodeEventLine(l).ok)).toEqual([true, true]);
});
