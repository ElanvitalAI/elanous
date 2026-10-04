import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../mss/logging/log-store.js';
import { measurePodMemoryByGoal } from '../../scripts/measure-pod-memory-by-goal.js';
import { advisePodMemory } from './pod-memory-advice.js';
import { registerPodCommands } from './pod-cli.js';
import { broadPodTestWarning, podMemoryLimitFor, podSelfImplementSpawn } from '../task-orchestrator/surfaces/self-implement-pod.js';

const now = Date.parse('2026-10-04T12:00:00Z');
const row = (event: string, data: object) => ({ ts_ms: now, category: 'self-implement.pod', event, data: JSON.stringify(data) });

describe('read-only Pod memory advice', () => {
  test('fake measurement rows choose each goal type from p50/p95 and OOM, without changing launch defaults', () => {
    const rows = [
      row('memory-limit', { spaceId: 'test-1', goalType: 'test', memoryLimit: '16Gi' }),
      row('job-applied', { spaceId: 'test-1', job: 't' }),
      row('oom-evidence', { job: 't', samples: [{ cgroupBytes: 15 * 1024 ** 3 }] }),
      row('job-finished', { job: 't', containerReason: 'OOMKilled' }),
      row('memory-limit', { spaceId: 'code-1', goalType: 'code', memoryLimit: '16Gi' }),
      row('job-applied', { spaceId: 'code-1', job: 'c' }),
      row('memory-last', { job: 'c', sample: { cgroupBytes: 3 * 1024 ** 3 } }),
      row('memory-limit', { spaceId: 'pwa-1', goalType: 'pwa-build', memoryLimit: '32Gi' }),
      row('job-applied', { spaceId: 'pwa-1', job: 'p' }),
      row('memory-last', { job: 'p', sample: { cgroupBytes: 18 * 1024 ** 3 } }),
      row('memory-limit', { spaceId: 'docs-1', goalType: 'docs', memoryLimit: '16Gi' }),
    ];
    const advice = advisePodMemory(measurePodMemoryByGoal(rows, now, 'fixture.db'));
    expect(advice.byGoalType.map(({ goalType, recommended, limit }) => [goalType, recommended, limit])).toEqual([
      ['test', 'high', '32Gi'], ['code', 'standard', '16Gi'], ['pwa-build', 'high', '32Gi'], ['docs', 'standard', '16Gi'],
    ]);
    expect(advice.byGoalType[0]).toMatchObject({ evidence: { oomKilled: 1, peakMiB: { p50: 15360, p95: 15360 } }, reason: expect.stringContaining('OOMKilled') });
    expect(advice.byGoalType[1]?.reason).toContain('p95=3072 MiB');
    expect(advice.byGoalType[3]?.reason).toContain('provisional');
    expect(podMemoryLimitFor('test-1', {})).toEqual({ limit: '16Gi', tier: 'standard', source: 'default' });
  });

  test('CLI JSON reads existing log store without changing rows; missing DB is not created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-memory-advise-'));
    const path = join(dir, 'logs.db');
    const run = async () => {
      const lines: string[] = []; const errors: string[] = []; let exit: number | null = null;
      const command = new Command(); command.exitOverride();
      registerPodCommands(command, { io: { log: (line) => { lines.push(line); }, error: (line) => { errors.push(line); }, exit: (code) => { exit = code; } } });
      await command.parseAsync(['pod', 'memory', 'advise', '--json', '--logs-db', path], { from: 'user' });
      return { lines, errors, exit };
    };
    try {
      expect((await run()).errors[0]).toContain('log store not found');
      expect(existsSync(path)).toBe(false);
      const writer = new LogStore(path);
      writer.insertBatch([{ surface: 'nexus', rec: { ts: new Date().toISOString(), category: 'self-implement.pod', event: 'memory-limit', data: { spaceId: 'test-1', goalType: 'test', memoryLimit: '16Gi' } } }]);
      writer.close();
      const before = new Database(path, { readonly: true });
      const count = before.query('SELECT COUNT(*) AS n FROM logs').get(); before.close();
      const result = await run();
      expect(Number(result.exit)).toBe(0);
      expect(result.lines).toHaveLength(1);
      expect(JSON.parse(result.lines[0]!).byGoalType[0]).toMatchObject({ recommended: 'standard', evidence: { runs: 1, missingPeak: 1 } });
      const after = new Database(path, { readonly: true });
      expect(after.query('SELECT COUNT(*) AS n FROM logs').get()).toEqual(count); after.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('launch warns once for broad test wording and directory bun test, not focused tests', async () => {
    expect(broadPodTestWarning('전체 시험을 돌린다')).toContain('W10b 32Gi OOM');
    expect(broadPodTestWarning('bun test src/cli/')).toContain('16GB+');
    expect(broadPodTestWarning('bun test src/cli')).toContain('16GB+');
    expect(broadPodTestWarning('bun test src/cli/pod-memory-advice.test.ts')).toBeNull();
    expect(broadPodTestWarning('bun test')).toContain('W10b 32Gi OOM');
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (text: string) => { warnings.push(text); };
    try {
      const spawned = podSelfImplementSpawn({ env: {}, kubectl: () => ({ status: 1, stdout: '', stderr: '' }) })({ spaceId: 'test-1', feature: '전체 시험: bun test src/cli/' });
      await spawned.done;
    } finally { console.warn = original; }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('W10b 32Gi OOM');
  });
});
