import { expect, test } from 'bun:test';
import { recommendBackendTier } from './backend-tier.js';

const GiB = 1024 ** 3;

test('unknown or insufficient memory recommends installation-free T0', () => {
  expect(recommendBackendTier({ memory: null, engines: [] }).tier).toBe('T0');
  expect(recommendBackendTier({ memory: { totalBytes: 16 * GiB, availableBytes: null }, engines: [] }).tier).toBe('T0');
  expect(recommendBackendTier({ memory: { totalBytes: 8 * GiB, availableBytes: 2 * GiB }, engines: [] }).tier).toBe('T0');
});

test('estimated RAM and available-memory thresholds recommend T1 and T2', () => {
  expect(recommendBackendTier({ memory: { totalBytes: 8 * GiB, availableBytes: 3 * GiB }, engines: [] }).tier).toBe('T1');
  expect(recommendBackendTier({ memory: { totalBytes: 16 * GiB, availableBytes: 8 * GiB }, engines: [] }).tier).toBe('T2');
});

test('detectable engines are reported without implying installation', () => {
  const result = recommendBackendTier({ memory: { totalBytes: 8 * GiB, availableBytes: 4 * GiB }, engines: ['Colima', 'podman', 'Colima'] });
  expect(result).toMatchObject({ tier: 'T1', engines: ['Colima', 'podman'], estimatedThresholds: true });
  expect(result.reasons.join(' ')).toContain('no new installation will be performed');
  const noEngine = recommendBackendTier({ memory: { totalBytes: 8 * GiB, availableBytes: 4 * GiB }, engines: [] });
  expect(noEngine.tier).toBe(result.tier);
  expect(noEngine.reasons.join(' ')).toContain('require human consent');
});


test('all backend tier advice is English and preserves thresholds and consent', () => {
  const cases = [
    { memory: null, engines: [] },
    { memory: { totalBytes: 7 * GiB, availableBytes: 4 * GiB }, engines: ['podman'] },
    { memory: { totalBytes: 8 * GiB, availableBytes: 2 * GiB }, engines: [] },
    { memory: { totalBytes: 8 * GiB, availableBytes: 3 * GiB }, engines: [] },
    { memory: { totalBytes: 16 * GiB, availableBytes: 8 * GiB }, engines: [] },
  ] as const;
  for (const input of cases) expect(recommendBackendTier(input).reasons.join(' ')).not.toMatch(/[\uac00-\ud7a3]/u);
  expect(recommendBackendTier(cases[0]).reasons.join(' ')).toContain('human consent');
  expect(recommendBackendTier(cases[4]).reasons.join(' ')).toContain('estimated thresholds');
});
