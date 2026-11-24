import { expect, test } from 'bun:test';
import { S3AgentFixture } from './s3-agent-fixture.js';

test('scripted child target releases, stops and emits failures without external state', () => {
  const f = new S3AgentFixture();
  f.start('a', 'delay', 'ready'); f.start('b', 'approval', 'approved');
  expect(f.release('a')).toBe(true); expect(f.stop('b')).toBe(true);
  expect(f.release('b')).toBe(false);
  f.start('c', 'death', ''); f.start('d', 'disconnect', '');
  expect(f.events).toEqual([
    { kind: 'started', id: 'a' }, { kind: 'started', id: 'b' }, { kind: 'approval', id: 'b' },
    { kind: 'completed', id: 'a', text: 'ready' }, { kind: 'failed', id: 'b' },
    { kind: 'started', id: 'c' }, { kind: 'failed', id: 'c' },
    { kind: 'started', id: 'd' }, { kind: 'disconnected', id: 'd' },
  ]);
});

test('fixture injects duplicate and burst events and keeps oversized results intact', () => {
  const f = new S3AgentFixture();
  f.start('a', 'duplicate', 'x'); f.burst(['b', 'c'], 'overflow');
  expect(f.events.filter(e => e.kind === 'completed')).toEqual([
    { kind: 'completed', id: 'a', text: 'x' }, { kind: 'completed', id: 'a', text: 'x' },
    { kind: 'completed', id: 'b', text: 'overflow' }, { kind: 'completed', id: 'c', text: 'overflow' },
  ]);
});
