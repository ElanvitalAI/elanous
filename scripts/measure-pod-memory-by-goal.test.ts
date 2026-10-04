import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../src/mss/logging/log-store.js';
import { goalTypeOf, measurePodMemoryByGoal, readPodMemoryMeasurement } from './measure-pod-memory-by-goal.js';

const now = Date.parse('2026-10-03T12:00:00Z');
const row = (event: string, data: object, ts_ms = now, category = 'self-implement.pod') => ({ category, event, data: JSON.stringify(data), ts_ms });

describe('read-only seven-day Pod memory measurement', () => {
  test('joins job-scoped samples and termination to the memory-limit space; excludes old and unrelated rows', () => {
    const observations = [
      row('memory-limit', { spaceId: 'test-1', memoryLimit: '16Gi' }),
      row('job-applied', { spaceId: 'test-1', job: 'job-1' }),
      row('memory-last', { job: 'job-1', sample: { at: 1, cgroupBytes: 1024 ** 3 } }),
      row('memory-limit', { spaceId: 'pwa-build-1', memoryLimit: '32Gi' }),
      row('job-applied', { spaceId: 'pwa-build-1', job: 'job-2' }),
      row('oom-evidence', { job: 'job-2', samples: [{ at: 2, cgroupBytes: 2 * 1024 ** 3 }, { at: 3, cgroupBytes: 3 * 1024 ** 3 }] }),
      row('job-finished', { job: 'job-2', state: 'failed', containerReason: 'OOMKilled' }),
      row('memory-limit', { spaceId: 'docs-1', memoryLimit: '16Gi' }),
      row('memory-limit', { spaceId: 'old-code', memoryLimit: '16Gi' }, now - 8 * 86400000),
      row('memory-limit', { spaceId: 'other', memoryLimit: '16Gi' }, now, 'release-loop.gate'),
    ];
    const result = measurePodMemoryByGoal(observations, now, 'test.db');
    expect(result.byGoalType.map(({ runs }) => runs)).toEqual([1, 0, 1, 1]);
    expect(result.byGoalType[0]!.peakMiB).toEqual({ p50: 1024, p95: 1024, max: 1024 });
    expect(result.byGoalType[2]).toMatchObject({ measured: 1, samples: 2, oomKilled: 1, terminations: 1, memoryLimits: { '32Gi': 1 }, peakMiB: { p95: 3072 } });
    expect(result.byGoalType[3]).toMatchObject({ missingPeak: 1, peakMiB: { p50: null, p95: null, max: null } });
    expect(result.sources).toEqual({ logs: 'test.db', observations: 8, samples: 3, unclassifiedRuns: 0, classification: 'goal-fields-or-space-id', peakCoverage: 'recorded-samples-only' });
  });

  test('percentiles count run peaks rather than raw samples', () => {
    const rows = Array.from({ length: 20 }, (_, index) => [
      row('memory-limit', { spaceId: `test-${index}`, memoryLimit: '16Gi' }),
      row('job-applied', { spaceId: `test-${index}`, job: `job-${index}` }),
      row('oom-evidence', { job: `job-${index}`, samples: [{ cgroupBytes: (index + 1) * 1024 ** 2 }, { cgroupBytes: 1024 ** 2 }] }),
    ]).flat();
    const result = measurePodMemoryByGoal(rows, now);
    expect(result.byGoalType[0]!.peakMiB).toEqual({ p50: 10.5, p95: 19.05, max: 20 });
  });

  test('recognizes goal categories and refuses absent cgroup samples', () => {
    expect(['tests', 'implement a CLI', 'PWA build', 'docs', '테스트 작성', '문서 작성', '문서 작성: 테스트 결과', 'misc'].map(goalTypeOf)).toEqual(['test', 'code', 'pwa-build', 'docs', 'test', 'docs', null, null]);
    const result = measurePodMemoryByGoal([
      row('memory-limit', { spaceId: 'docs-1', memoryLimit: '16Gi' }),
      row('job-applied', { spaceId: 'docs-1', job: 'docs-job' }),
      row('memory-last', { job: 'docs-job', sample: { at: 123, cgroupBytes: null } }),
    ], now);
    expect(result.byGoalType[3]!.missingPeak).toBe(1);
  });

  test('uses structured goal type before title and leaves ambiguous titles unclassified', () => {
    const result = measurePodMemoryByGoal([
      row('memory-limit', { spaceId: 'unknown-1', goalType: 'docs', goalTitle: '문서 작성: 테스트 결과', memoryLimit: '16Gi' }),
      row('memory-limit', { spaceId: 'unknown-2', goalTitle: '문서 작성: 테스트 결과', memoryLimit: '16Gi' }),
      row('memory-limit', { spaceId: 'unknown-3', goalType: 'test', goalTitle: '문서 작성', memoryLimit: '16Gi' }),
      row('memory-limit', { spaceId: 'unknown-4', goalType: 'unrecognized', goalTitle: '테스트 작성', memoryLimit: '16Gi' }),
    ], now);
    expect(result.byGoalType.map(({ runs }) => runs)).toEqual([1, 0, 0, 1]);
    expect(result.sources.unclassifiedRuns).toBe(2);
  });

  test('opens existing log store read-only and does not create missing database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-memory-measure-'));
    const path = join(dir, 'logs.db');
    try {
      expect(() => readPodMemoryMeasurement(path, now)).toThrow('log store not found');
      expect(existsSync(path)).toBe(false);
      const writer = new LogStore(path);
      writer.insertBatch([{ surface: 'nexus', rec: { ts: new Date().toISOString(), category: 'self-implement.pod', event: 'memory-limit', data: { spaceId: 'test-1', memoryLimit: '16Gi' } } }]);
      writer.close();
      const before = new Database(path, { readonly: true }).query('SELECT COUNT(*) AS count FROM logs').get();
      const result = readPodMemoryMeasurement(path);
      const command = spawnSync('bun', ['scripts/measure-pod-memory-by-goal.ts', '--json', '--logs-db', path], { encoding: 'utf8' });
      const after = new Database(path, { readonly: true }).query('SELECT COUNT(*) AS count FROM logs').get();
      expect(command.status).toBe(0);
      expect(JSON.parse(command.stdout).byGoalType[0].runs).toBe(1);
      expect(result.byGoalType[0]!.runs).toBe(1);
      expect(after).toEqual(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
