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
  expect(result.reasons.join(' ')).toContain('새 설치는 하지 않습니다');
  const noEngine = recommendBackendTier({ memory: { totalBytes: 8 * GiB, availableBytes: 4 * GiB }, engines: [] });
  expect(noEngine.tier).toBe(result.tier);
  expect(noEngine.reasons.join(' ')).toContain('사람의 설치 동의가 필요');
});
