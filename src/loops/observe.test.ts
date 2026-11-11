import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { readFailureInbox } from '../self-implement/heal-intake.js';
import { debug } from '../debug/log.js';
import { runStewardStage } from '../steward/triage.js';
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

test('derived loop observations inherit simulation provenance and cannot count as real', () => {
  const sim = { universe: 'sim', source: 'sim', device: 'ux-sim', scenario: 'failed-tick', clock: 'sim' } as const;
  loopEvent('steward', 'tick', { ...context, causedByProvenance: [{ universe: 'prod', source: 'real' }, sim] });
  expect(log.mock.calls[0]?.[3]).toEqual({ provenance: sim });
  log.mockClear();
  loopEvent('steward', 'tick', { ...context, provenance: { universe: 'prod', source: 'real' }, causedByProvenance: [sim] });
  expect(log.mock.calls[0]?.[2]).toMatchObject({ provenance: sim });
  expect(log.mock.calls[0]?.[3]).toEqual({ provenance: sim });
  log.mockClear();
  loopEvent('steward', 'tick', { ...context, provenance: { universe: 'prod', source: 'real' }, causedByProvenance: [null] });
  expect(log.mock.calls[0]?.[3]?.provenance).toMatchObject({ source: 'unknown' });
  log.mockClear();
  loopEvent('steward', 'tick', { ...context, provenance: { universe: 'prod', source: 'real' }, causedByProvenance: 'bad-input' });
  expect(log.mock.calls[0]?.[3]?.provenance).toMatchObject({ source: 'unknown' });
  log.mockClear();
  loopEvent('steward', 'tick', { ...context, provenance: { universe: 'prod', source: 'real' }, causedByProvenance: { universe: 'prod', source: 'real' } });
  expect(log.mock.calls[0]?.[3]?.provenance).toMatchObject({ source: 'unknown' });
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

test('approval (hitl) observation emits a one-line reason and sourceRef without mutating caller data', () => {
  const data = { runId: 'run-1', profile: 'shadow', reason: '민감 결정 —  사람\n승인 필요 ', sourceRef: 'docs/roles/TC.md' };
  loopEvent('tc-seat', 'hitl', data);
  expect(log).toHaveBeenCalledTimes(1);
  for (const [category, event, payload] of log.mock.calls) {
    const fields = payload as Record<string, unknown>;
    expect(category).toBe('loop.tc-seat');
    expect(event).toBe('hitl');
    expect(payload).toEqual({
      ...data, reason: '민감 결정 — 사람 승인 필요', sourceRef: 'docs/roles/TC.md',
      loopId: 'tc-seat', missingRequired: [],
    });
    expect(String(fields.reason)).not.toBe('');
    expect(String(fields.reason)).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(String(fields.sourceRef)).not.toBe('');
    expect(String(fields.sourceRef)).not.toMatch(/[\r\n\u2028\u2029]/);
  }
  expect(data).toEqual({ runId: 'run-1', profile: 'shadow', reason: '민감 결정 —  사람\n승인 필요 ', sourceRef: 'docs/roles/TC.md' });
});

test('approval (hitl) observation flags blank reason and sourceRef as missing without fabricating them', () => {
  const data = { runId: 'run-1', profile: 'shadow', reason: '  \n ', sourceRef: '' };
  loopEvent('tc-seat', 'hitl', data);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]).toEqual([
    'loop.tc-seat', 'hitl',
    { ...data, reason: '', sourceRef: '', loopId: 'tc-seat', missingRequired: ['reason', 'sourceRef'] },
  ]);
  expect(data).toEqual({ runId: 'run-1', profile: 'shadow', reason: '  \n ', sourceRef: '' });
});

test('only failed ticks reach the heal inbox; repeats fold by source and loop id', () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-loop-wire-'));
  setElanousConfigDir(root);
  try {
    loopEvent('steward', 'tick', { ...context, outcome: 'ok' });
    loopEvent('steward', 'exchange', { ...context, outcome: 'failed' });
    expect(readFailureInbox({}, root)).toEqual([]);
    const real = { universe: 'prod', source: 'real' } as const;
    loopEvent('steward', 'tick', { ...context, outcome: 'failed', provenance: real });
    loopEvent('steward', 'tick', { ...context, outcome: 'failed', provenance: real });
    expect(readFailureInbox({}, root)).toEqual([{
      source: 'loop-tick', kind: 'tick', ref: 'steward', summary: 'Loop steward tick failed', at: expect.any(String),
    }]);
  } finally {
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});

test('live steward failure tick carries production provenance and reaches the heal inbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-steward-production-'));
  const priorNodeEnv = process.env.NODE_ENV;
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  setElanousConfigDir(root);
  process.env.NODE_ENV = 'production';
  process.env.ELANOUS_STATE_DIR = root;
  try {
    await expect(runStewardStage('triage', { root, launchSettings: { mode: 'live' }, getSecret: async () => '' }))
      .rejects.toThrow('connector.linear.apiKey missing');
    const tick = log.mock.calls.find(([category, event, data]) => category === 'loop.steward' && event === 'tick'
      && (data as Record<string, unknown>).outcome === 'fail');
    expect(tick?.[3]).toEqual({ provenance: { universe: 'prod', source: 'real' } });
    expect(readFailureInbox({}, root)).toEqual([expect.objectContaining({ source: 'loop-tick', kind: 'tick', ref: 'steward' })]);
  } finally {
    resetElanousConfigDir();
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = priorStateDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('simulated failed ticks do not enter the production heal inbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-loop-sim-'));
  setElanousConfigDir(root);
  try {
    loopEvent('steward', 'tick', {
      ...context,
      outcome: 'failed',
      provenance: { universe: 'sim', source: 'sim', device: 'ux-sim' },
    });
    expect(readFailureInbox({}, root)).toEqual([]);
  } finally {
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});

test('production source with a simulated clock does not enter the production heal inbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-loop-sim-clock-'));
  setElanousConfigDir(root);
  try {
    loopEvent('steward', 'tick', {
      ...context,
      outcome: 'failed',
      provenance: { universe: 'prod', source: 'real', clock: 'sim' },
    });
    expect(readFailureInbox({}, root)).toEqual([]);
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
    const real = { universe: 'prod', source: 'real' } as const;
    expect(() => loopEvent('steward', 'tick', { ...context, outcome: 'failed', provenance: real })).not.toThrow();
    expect(log.mock.calls[0]).toEqual(['loop.steward', 'tick',
      { ...context, outcome: 'failed', provenance: real, loopId: 'steward', missingRequired: [] }, { provenance: real }]);
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
