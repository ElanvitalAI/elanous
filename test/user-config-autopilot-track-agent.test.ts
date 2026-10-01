import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig, saveUserConfig } from '../src/user-config.js';

const root = mkdtempSync(join(tmpdir(), 'autopilot-track-agent-'));
const path = join(root, 'config.json');

function parse(autopilot: unknown) {
  writeFileSync(path, JSON.stringify({ autopilot }));
  return buildUserConfig(path).autopilot;
}

afterEach(() => {
  rmSync(path, { force: true });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test('trackAgent is opt-in and its default concurrency is two', () => {
  expect(parse({})?.trackAgent).toBeUndefined();
  expect(parse({ trackAgent: {} })?.trackAgent).toEqual({ enabled: false, maxConcurrent: 2, shadow: false, shadowMaxDecisionsPerDay: 20 });
  expect(parse({ trackAgent: { enabled: 'true', maxConcurrent: '1' } })?.trackAgent)
    .toEqual({ enabled: false, maxConcurrent: 2, shadow: false, shadowMaxDecisionsPerDay: 20 });
  expect(parse({ trackAgent: { enabled: true, maxConcurrent: 1 } })?.trackAgent)
    .toEqual({ enabled: true, maxConcurrent: 1, shadow: false, shadowMaxDecisionsPerDay: 20 });
});

test('trackAgent limits concurrency to two and rejects invalid counts', () => {
  for (const count of [3, 100, Number.MAX_SAFE_INTEGER]) {
    expect(parse({ trackAgent: { enabled: true, maxConcurrent: count } })?.trackAgent?.maxConcurrent).toBe(2);
  }
  for (const count of [0, -1, 1.5, null, '2']) {
    expect(parse({ trackAgent: { enabled: true, maxConcurrent: count } })?.trackAgent?.maxConcurrent).toBe(2);
  }
});

test('trackAgent shadow is opt-in and its daily cap accepts only nonnegative safe integers', () => {
  expect(parse({ trackAgent: { shadow: true, shadowMaxDecisionsPerDay: 7 } })?.trackAgent)
    .toEqual({ enabled: false, maxConcurrent: 2, shadow: true, shadowMaxDecisionsPerDay: 7 });
  expect(parse({ trackAgent: { shadow: true, shadowMaxDecisionsPerDay: 0 } })?.trackAgent?.shadowMaxDecisionsPerDay).toBe(0);
  for (const invalid of [-1, 1.5, null, '20', Number.MAX_SAFE_INTEGER + 1]) {
    expect(parse({ trackAgent: { shadow: true, shadowMaxDecisionsPerDay: invalid } })?.trackAgent?.shadowMaxDecisionsPerDay).toBe(20);
  }
  for (const invalid of ['true', 1, null]) {
    expect(parse({ trackAgent: { shadow: invalid } })?.trackAgent?.shadow).toBe(false);
  }
});

test('trackAgent parses independently of trackCourier and retains existing courier values', () => {
  expect(parse({ trackAgent: { enabled: true }, trackCourier: false }))
    .toEqual({ trackAgent: { enabled: true, maxConcurrent: 2, shadow: false, shadowMaxDecisionsPerDay: 20 } });
  const config = parse({
    trackCourier: { enabled: true, channelPr: 123, handoffMinutes: 15 },
    trackAgent: { enabled: true, maxConcurrent: 1 },
  });
  expect(config).toEqual({
    trackCourier: { enabled: true, channelPr: 123, handoffMinutes: 15 },
    trackAgent: { enabled: true, maxConcurrent: 1, shadow: false, shadowMaxDecisionsPerDay: 20 },
  });
  expect(parse({ trackCourier: {} })).toEqual({
    trackCourier: { enabled: false, handoffMinutes: 60 },
  });
  expect(parse({ trackAgent: null, trackCourier: null })).toBeUndefined();
  expect(parse({ trackAgent: true, trackCourier: [] })).toBeUndefined();
});

test('trackAgent typed shadow settings persist when absent from original raw config', () => {
  parse({});
  const config = buildUserConfig(path);
  config.autopilot = {
    trackAgent: { enabled: false, maxConcurrent: 2, shadow: true, shadowMaxDecisionsPerDay: 0 },
  };
  saveUserConfig(config, path);
  expect(buildUserConfig(path).autopilot?.trackAgent).toEqual(config.autopilot.trackAgent);
});

test('saveUserConfig preserves unknown nested autopilot keys while typed changes win', () => {
  const original = {
    autopilot: {
      futureMode: { level: 3 },
      trackAgent: { enabled: true, maxConcurrent: 1, shadow: false, futureAgent: { token: 'agent' } },
      trackCourier: { enabled: true, channelPr: 123, futureCourier: ['keep'] },
    },
  };
  writeFileSync(path, JSON.stringify(original));
  const config = buildUserConfig(path);
  config.autopilot!.trackAgent!.shadow = true;
  config.autopilot!.trackAgent!.shadowMaxDecisionsPerDay = 4;
  config.autopilot!.trackCourier!.handoffMinutes = 12;
  saveUserConfig(config, path);
  expect(JSON.parse(readFileSync(path, 'utf8')).autopilot).toEqual({
    futureMode: { level: 3 },
    trackAgent: { enabled: true, maxConcurrent: 1, shadow: true, shadowMaxDecisionsPerDay: 4, futureAgent: { token: 'agent' } },
    trackCourier: { enabled: true, channelPr: 123, handoffMinutes: 12, futureCourier: ['keep'] },
  });
  expect(buildUserConfig(path).autopilot).toEqual({
    trackAgent: { enabled: true, maxConcurrent: 1, shadow: true, shadowMaxDecisionsPerDay: 4 },
    trackCourier: { enabled: true, channelPr: 123, handoffMinutes: 12 },
  });
});

test('trackAgent and courier survive save and reload together', () => {
  parse({ trackAgent: { enabled: true, maxConcurrent: 20, shadow: true, shadowMaxDecisionsPerDay: 7 }, trackCourier: { enabled: true } });
  const config = buildUserConfig(path);
  expect(config.autopilot?.trackAgent?.maxConcurrent).toBe(2);
  saveUserConfig(config, path);
  expect(buildUserConfig(path).autopilot).toEqual({
    trackAgent: { enabled: true, maxConcurrent: 2, shadow: true, shadowMaxDecisionsPerDay: 7 },
    trackCourier: { enabled: true, handoffMinutes: 60 },
  });
});
