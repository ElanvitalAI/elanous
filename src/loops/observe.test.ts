import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { readFailureInbox } from '../self-implement/heal-intake.js';
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

test('only failed ticks reach the heal inbox; repeats fold by source and loop id', () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-loop-wire-'));
  setElanousConfigDir(root);
  try {
    loopEvent('steward', 'tick', { ...context, outcome: 'ok' });
    loopEvent('steward', 'exchange', { ...context, outcome: 'failed' });
    expect(readFailureInbox({}, root)).toEqual([]);
    loopEvent('steward', 'tick', { ...context, outcome: 'failed' });
    loopEvent('steward', 'tick', { ...context, outcome: 'failed' });
    expect(readFailureInbox({}, root)).toEqual([{
      source: 'loop-tick', kind: 'tick', ref: 'steward', summary: 'Loop steward tick failed', at: expect.any(String),
    }]);
  } finally {
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});

test('heal inbox write failure leaves the original loop event unchanged and reports the error', () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-loop-write-fails-'));
  setElanousConfigDir(root);
  writeFileSync(join(root, 'heal'), 'not a directory');
  try {
    expect(() => loopEvent('steward', 'tick', { ...context, outcome: 'failed' })).not.toThrow();
    expect(log.mock.calls[0]).toEqual(['loop.steward', 'tick',
      { ...context, outcome: 'failed', loopId: 'steward', missingRequired: [] }]);
    expect(log.mock.calls[1]).toEqual(['heal.intake', 'record-failed',
      expect.objectContaining({ source: 'loop-tick', kind: 'tick', ref: 'steward' }), { level: 'error' }]);
  } finally {
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
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
