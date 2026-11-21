import { expect, test } from 'bun:test';
import { createAgentEventBridge } from './agent-event-bridge.js';

const rec = () => { const log: string[] = []; return { log, sink: {
  state: (s: string) => { log.push(`state:${s}`); }, turn: (p: string, id: string) => { log.push(`turn:${p}:${id}`); },
  notice: (l: string, t: string) => { log.push(`notice:${l}:${t}`); } } }; };

test('a fake turn emits start/working then end/idle with one turnId; repeated flips are ignored', () => {
  const { log, sink } = rec(); let n = 0;
  const b = createAgentEventBridge(sink, () => `t${++n}`);
  b.busy(true); b.busy(true); b.attention('waiting-input'); b.attention(null); b.notice('info', 'hi'); b.busy(false); b.busy(false);
  expect(log).toEqual(['turn:start:t1', 'state:working', 'state:waiting-input', 'state:working', 'notice:info:hi', 'turn:end:t1', 'state:idle']);
});

test('no sink or a throwing sink never reaches the turn', () => {
  createAgentEventBridge(undefined).busy(true);
  const b = createAgentEventBridge({ state: () => { throw new Error('x'); }, turn: () => { throw new Error('x'); }, notice: () => { throw new Error('x'); } });
  expect(() => { b.busy(true); b.busy(false); }).not.toThrow();
});
