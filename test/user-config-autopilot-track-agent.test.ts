import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  expect(parse({ trackAgent: {} })?.trackAgent).toEqual({ enabled: false, maxConcurrent: 2 });
  expect(parse({ trackAgent: { enabled: 'true', maxConcurrent: '1' } })?.trackAgent)
    .toEqual({ enabled: false, maxConcurrent: 2 });
  expect(parse({ trackAgent: { enabled: true, maxConcurrent: 1 } })?.trackAgent)
    .toEqual({ enabled: true, maxConcurrent: 1 });
});

test('trackAgent limits concurrency to two and rejects invalid counts', () => {
  for (const count of [3, 100, Number.MAX_SAFE_INTEGER]) {
    expect(parse({ trackAgent: { enabled: true, maxConcurrent: count } })?.trackAgent?.maxConcurrent).toBe(2);
  }
  for (const count of [0, -1, 1.5, null, '2']) {
    expect(parse({ trackAgent: { enabled: true, maxConcurrent: count } })?.trackAgent?.maxConcurrent).toBe(2);
  }
});

test('trackAgent parses independently of trackCourier and retains existing courier values', () => {
  expect(parse({ trackAgent: { enabled: true }, trackCourier: false }))
    .toEqual({ trackAgent: { enabled: true, maxConcurrent: 2 } });
  const config = parse({
    trackCourier: { enabled: true, channelPr: 123, handoffMinutes: 15 },
    trackAgent: { enabled: true, maxConcurrent: 1 },
  });
  expect(config).toEqual({
    trackCourier: { enabled: true, channelPr: 123, handoffMinutes: 15 },
    trackAgent: { enabled: true, maxConcurrent: 1 },
  });
  expect(parse({ trackCourier: {} })).toEqual({
    trackCourier: { enabled: false, handoffMinutes: 60 },
  });
  expect(parse({ trackAgent: null, trackCourier: null })).toBeUndefined();
  expect(parse({ trackAgent: true, trackCourier: [] })).toBeUndefined();
});

test('trackAgent and courier survive save and reload together', () => {
  parse({ trackAgent: { enabled: true, maxConcurrent: 20 }, trackCourier: { enabled: true } });
  const config = buildUserConfig(path);
  expect(config.autopilot?.trackAgent?.maxConcurrent).toBe(2);
  saveUserConfig(config, path);
  expect(buildUserConfig(path).autopilot).toEqual({
    trackAgent: { enabled: true, maxConcurrent: 2 },
    trackCourier: { enabled: true, handoffMinutes: 60 },
  });
});
