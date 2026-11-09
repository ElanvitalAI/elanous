import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertPhonePwaSelfHealTraceMatchesResult,
  formatPhonePwaSelfHealTrace,
  simulatePhonePwaSelfHeal,
  type PhonePwaSelfHealTrace,
} from './phone-pwa-selfheal.js';

const brokenPage = join(import.meta.dir, '../../scenarios/ux-sim/fixtures/phone-pwa-selfheal-broken.html');

test('Fold PWA self-heal observes a clipped CTA, repairs its layout, and re-observes green', async () => {
  const fixture = await readFile(brokenPage, 'utf8');
  const result = simulatePhonePwaSelfHeal(fixture, { viewportWidth: 360, autoRepair: true });

  expect(result.pass).toBe(true);
  expect(result.viewport).toEqual({ width: 360, height: 800, device: 'fake-fold' });
  expect(result.before.cta.right).toBeGreaterThan(result.viewport.width);
  expect(result.before.cta).toEqual({ left: 300, right: 460 });
  expect(result.before.verdict).toBe('clipped');
  expect(result.after.cta.right).toBeLessThanOrEqual(result.viewport.width);
  expect(result.after.cta).toEqual({ left: 184, right: 344 });
  expect(result.after.verdict).toBe('visible');
  expect(result.repairedPage).toContain('.demo-content { min-width: 0; width: 100%;');
  expect(result.repairedPage).toContain('.action-row { display: flex; flex-wrap: wrap; justify-content: flex-end;');
  expect(result.graph.map((node) => [node.id, node.status])).toEqual([
    ['phone-observe', 'done'],
    ['viewport-judge', 'done'],
    ['responsive-repair', 'done'],
    ['phone-reobserve', 'done'],
  ]);
  expect(result.externalNetworkAttempts).toEqual([]);
  expect(JSON.stringify(result.recordedTrace)).toContain('cta-clipped');
  expect(JSON.stringify(result.recordedTrace)).toContain('cta-visible');
});

test('narrow viewport geometry checks both CTA edges after repair', async () => {
  const fixture = await readFile(brokenPage, 'utf8');
  const result = simulatePhonePwaSelfHeal(fixture, { viewportWidth: 160, autoRepair: true });

  expect(result.pass).toBe(true);
  expect(result.after.cta).toEqual({ left: 0, right: 144 });
  expect(result.repairedPage).toContain('width: 160px; max-width: 100%; box-sizing: border-box;');
});

test('CSS-box model refuses a fixture with an unmodeled body margin', async () => {
  const fixture = (await readFile(brokenPage, 'utf8')).replace('body { margin: 0; }', 'body { margin: 8px; }');

  expect(() => simulatePhonePwaSelfHeal(fixture, { viewportWidth: 360, autoRepair: true })).toThrow(
    'demo fixture must explicitly set body margin to zero for the CSS-box model',
  );
});

test('Fold PWA self-heal blocks a partial repair when one layout anchor is missing', async () => {
  const fixture = (await readFile(brokenPage, 'utf8')).replace(
    '.action-row { display: flex; justify-content: flex-end; gap: 12px; padding-right: 16px; }',
    '.action-row { display: flex; justify-content: flex-end; gap: 12px; }',
  );

  expect(() => simulatePhonePwaSelfHeal(fixture, { viewportWidth: 360, autoRepair: true })).toThrow(
    'demo fixture repair anchor is missing or ambiguous: action row wrapping',
  );
});

test('Fold PWA self-heal does not report green when the repair node is unavailable', async () => {
  const fixture = await readFile(brokenPage, 'utf8');
  const result = simulatePhonePwaSelfHeal(fixture, { viewportWidth: 360, autoRepair: false });

  expect(result.pass).toBe(false);
  expect(result.after.verdict).toBe('clipped');
  expect(result.graph.map((node) => node.status)).toEqual(['done', 'done', 'blocked', 'skipped']);
  expect(result.recordedTrace.at(-1)?.event).toBe('self-heal.blocked');
});

test('recorded simulation trace is a deterministic fallback and identifies itself as simulated', async () => {
  const tracePath = join(import.meta.dir, '../../scenarios/ux-sim/phone-pwa-selfheal-trace.json');
  const trace = JSON.parse(await readFile(tracePath, 'utf8')) as PhonePwaSelfHealTrace;
  const fixture = await readFile(brokenPage, 'utf8');
  const result = simulatePhonePwaSelfHeal(fixture, { viewportWidth: trace.viewport.width, autoRepair: true });
  assertPhonePwaSelfHealTraceMatchesResult(trace, result);
  const replay = formatPhonePwaSelfHealTrace(trace);

  expect(trace.source).toBe('simulator');
  expect(trace.liveDevice).toBe(false);
  expect(trace.frames.map((frame) => frame.verdict)).toEqual(['clipped', 'visible']);
  expect(replay).toContain('CTA clipped: right=460px viewport=360px');
  expect(replay).toContain('CSS-box model (not browser measured)');
  expect(replay).toContain('graph phone-observe → viewport-judge → responsive-repair → phone-reobserve: green');
  expect(replay).toContain('CTA visible: right=344px viewport=360px');
});

test('trace replay refuses inconsistent geometry and missing graph stages', async () => {
  const tracePath = join(import.meta.dir, '../../scenarios/ux-sim/phone-pwa-selfheal-trace.json');
  const trace = JSON.parse(await readFile(tracePath, 'utf8')) as PhonePwaSelfHealTrace;

  expect(() => formatPhonePwaSelfHealTrace({
    ...trace,
    frames: [trace.frames[0]!, { ...trace.frames[1]!, ctaRight: trace.viewport.width + 1 }],
  })).toThrow('trace geometry and the ordered self-heal graph');
  expect(() => formatPhonePwaSelfHealTrace({ ...trace, liveDevice: undefined as unknown as false }))
    .toThrow('trace is not a simulator recording for DEMO-1114-PHONE-PWA-SELFHEAL');
  expect(() => formatPhonePwaSelfHealTrace({
    ...trace,
    graph: ['phone-observe', 'viewport-judge', 'phone-reobserve'],
  })).toThrow('trace geometry and the ordered self-heal graph');
  const fixture = await readFile(brokenPage, 'utf8');
  const result = simulatePhonePwaSelfHeal(fixture, { viewportWidth: trace.viewport.width, autoRepair: true });
  expect(() => assertPhonePwaSelfHealTraceMatchesResult({
    ...trace,
    frames: [trace.frames[0]!, { ...trace.frames[1]!, ctaRight: trace.frames[1]!.ctaRight - 1 }],
  }, result)).toThrow('saved simulator trace does not match the current fixture simulation result');
});
