import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { LOOP_EVENTS, loopCategory, loopEvent } from './observe.js';

let log: ReturnType<typeof spyOn<typeof debug, 'log'>>;
beforeEach(() => { log = spyOn(debug, 'log').mockImplementation(() => {}); });
afterEach(() => log.mockRestore());

const context = { runId: 'run-1', profile: 'shadow', reason: 'scheduled', sourceRef: 'docs/roles/TC.md' };

test('RFC event vocabulary emits only under the validated manifest category with context intact', () => {
  expect(LOOP_EVENTS).toEqual([
    'tick', 'posture-change', 'resolution-change', 'grounding', 'heartbeat',
    'absent', 'exchange', 'spawn', 'reap', 'promote', 'hitl',
  ]);
  expect(loopCategory('tc-seat')).toBe('loop.tc-seat');
  for (const event of LOOP_EVENTS) loopEvent('tc-seat', event, { ...context, tokens: 0 });
  expect(log).toHaveBeenCalledTimes(LOOP_EVENTS.length);
  for (const [index, event] of LOOP_EVENTS.entries()) {
    expect(log.mock.calls[index]).toEqual([
      'loop.tc-seat', event,
      { ...context, tokens: 0, loopId: 'tc-seat', missingRequired: [] },
    ]);
  }
});

test('valid events expose missing required context without fabricating values or changing supplied data', () => {
  const data = { runId: 'r', profile: '', reason: null, denominator: 3 };
  loopEvent('steward', 'tick', data);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]).toEqual([
    'loop.steward', 'tick',
    { ...data, loopId: 'steward', missingRequired: ['profile', 'reason', 'sourceRef'] },
  ]);
  expect(data).toEqual({ runId: 'r', profile: '', reason: null, denominator: 3 });
});

test('invalid ids, event names, data and mismatched loop identity emit rejection only', () => {
  for (const id of ['', 'A', 'a.b', 'a--b', '-bad', 'bad-', 'x/y', '__proto__', 'a\nother']) {
    loopEvent(id, 'tick', context);
    expect(() => loopCategory(id)).toThrow('invalid loop id');
  }
  for (const event of ['', 'Tick', 'rejected', 'posture_change', 'exchange/forged']) {
    loopEvent('tc-seat', event, context);
  }
  loopEvent('tc-seat', 'tick', null as unknown as Record<string, unknown>);
  loopEvent('tc-seat', 'tick', [] as unknown as Record<string, unknown>);
  loopEvent('tc-seat', 'tick', { ...context, loopId: 'op-seat' });
  expect(log).toHaveBeenCalledTimes(2 * 9 + 5 + 3);
  for (const [category, event, data] of log.mock.calls) {
    expect(category).toBe('loop.observe');
    expect(event).toBe('rejected');
    expect(data).toEqual({ reason: expect.stringMatching(/^invalid-(loop-id|event|data)$/) });
  }
});
