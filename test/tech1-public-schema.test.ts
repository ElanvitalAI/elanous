import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadExportConfig, selectExportFiles, scanLeaks, scanRuntimePaths } from '../scripts/public-export.js';

const root = resolve(import.meta.dir, '..');
const path = 'release/public/tech/tech1.json';
const read = () => JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Record<string, any>;

function validate(snapshot: Record<string, any>): void {
  expect(Object.keys(snapshot).sort()).toEqual(['commit', 'generatedAt', 'graph', 'loop-agents', 'mission-fabric', 'observability', 'pty', 'sections', 'stages', 'window'].sort());
  expect(Date.parse(snapshot.generatedAt)).not.toBeNaN();
  expect(snapshot.commit).toMatch(/^[0-9a-f]{10}$/);
  expect(Object.keys(snapshot.window).sort()).toEqual(['from', 'to']);
  expect(Date.parse(snapshot.window.from)).toBeLessThan(Date.parse(snapshot.window.to));
  expect(snapshot.stages.map((stage: any) => stage.id)).toEqual(['author', 'clarify', 'ledger', 'heal']);
  for (const stage of snapshot.stages) {
    for (const field of ['auto', 'human', 'unknown']) {
      expect(stage[field] === null || (Number.isInteger(stage[field]) && stage[field] >= 0)).toBe(true);
    }
    expect(typeof stage.basis).toBe('string');
    expect(stage.command === null || typeof stage.command === 'string').toBe(true);
  }
  const aggregates = [snapshot['loop-agents'].loops, snapshot.graph.templates, snapshot.pty.missions, snapshot['mission-fabric'].missions, snapshot.observability.events];
  for (const value of aggregates) expect(value === null || (Number.isInteger(value) && value >= 0)).toBe(true);
  expect(snapshot.sections.map((section: any) => section.id)).toEqual(['harness', 'loop-agents', 'graph', 'pty', 'mission-fabric', 'observability']);
  const items = snapshot.sections.flatMap((section: any) => section.items);
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect(typeof item.id).toBe('string');
    expect(typeof item.label).toBe('string');
    expect(item.value === null || (Number.isInteger(item.value) && item.value >= 0)).toBe(true);
    expect(typeof item.unit).toBe('string');
    expect(typeof item.basis).toBe('string');
    expect(item.command === null || (typeof item.command === 'string' && item.command.length > 0)).toBe(true);
    expect(item.doc === null || (typeof item.doc === 'string' && item.doc.startsWith('release/public/docs/'))).toBe(true);
    if (item.value !== null) expect(typeof item.command === 'string' && item.command.length > 0).toBe(true);
  }
  expect(snapshot['loop-agents'].loops).toBe(snapshot.sections.find((section: any) => section.id === 'loop-agents').items.find((item: any) => item.id === 'loops').value);
  expect(snapshot.graph.templates).toBe(snapshot.sections.find((section: any) => section.id === 'graph').items.find((item: any) => item.id === 'templates').value);
  for (const section of ['pty', 'mission-fabric', 'observability']) {
    const aggregate = section === 'pty' ? snapshot.pty.missions : section === 'mission-fabric' ? snapshot['mission-fabric'].missions : snapshot.observability.events;
    expect(aggregate).toBe(snapshot.sections.find((entry: any) => entry.id === section).items[0].value);
  }
}

describe('TECH1 public snapshot', () => {
  test('schema and measurements have explicit bases and safe commands', () => {
    const snapshot = read();
    validate(snapshot);
    const source = JSON.stringify(snapshot);
    expect(source).not.toMatch(/(?:(?<![\w/])docs\/(?!public\/)|\/(?:home|Users)\/|\u{1F451}|run-[a-f0-9]{8}|(?:account|계정))/u);
    for (const item of snapshot.sections.flatMap((section: any) => section.items)) {
      if (item.command === null) continue;
      expect(item.command).not.toMatch(/docs\/|\/home\/|\/Users\/|(?:schedule|mission|pty) (?:create|run|start)|--all|--include-test/);
      // Window-bound log measures read the measuring host's ledgers, so they cannot replay in CI;
      // they must instead carry the snapshot's exact window.
      if (item.command.includes('--since ')) {
        expect(item.command).toContain(`--since ${snapshot.window.from} --until ${snapshot.window.to}`);
        continue;
      }
      const result = Bun.spawnSync(['bash', '-c', item.command], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 15000 });
      expect(result.exitCode).toBe(0);
      // Repository counts only grow after the snapshot is taken: the snapshot must never overstate the live tree.
      expect(Number.parseInt(new TextDecoder().decode(result.stdout), 10)).toBeGreaterThanOrEqual(item.value);
    }
  });

  test('export allowlist includes snapshot and detects no release-file leaks', () => {
    const config = loadExportConfig(root);
    expect(selectExportFiles([path], config)).toContain(path);
    expect(scanLeaks(root, [path, 'scripts/tech1-public-measure.ts', 'test/tech1-public-schema.test.ts'])).toEqual([]);
    expect(scanRuntimePaths(root, [path, 'scripts/tech1-public-measure.ts', 'test/tech1-public-schema.test.ts'], [])).toEqual([]);
  });
});
