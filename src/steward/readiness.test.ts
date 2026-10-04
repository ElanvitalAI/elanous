import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStewardStage, type ScheduledDecision } from './triage.js';
import { debug } from '../debug/log.js';
import { formatStewardReadiness, parseReadinessSince, recordShadowTick, runStewardReadinessCli, stewardReadiness } from './readiness.js';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const row = (issue: string, rung: 4 | 'hitl' | 2, disposition: 'now' | 'hitl' | 'wait'): ScheduledDecision =>
  ({ issue, rung, disposition, priority: 1, dependsOn: [], why: 'test' });
const issue = (identifier: string) => ({ identifier, ref: identifier, title: identifier, body: '' });

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) visit(path);
      else files[path.slice(root.length)] = readFileSync(path).toString('hex');
    }
  };
  visit(root);
  return files;
}

test('one day of shadow decision lines gives tick, judgment, distribution, actions, budget and HITL gates with zero reader writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-readiness-'));
  try {
    mkdirSync(join(root, 'steward'));
    const rows = [row('ELA-1', 4, 'now'), row('ELA-2', 'hitl', 'hitl'), row('ELA-3', 2, 'wait')];
    recordShadowTick(root, rows, {
      launches: [{ issue: issue('ELA-1'), row: rows[0]!, command: 'would run', source: 'cli' }],
      hitl: [{ issue: issue('ELA-2'), row: rows[1]! }],
    }, new Date('2026-10-03T12:00:00.000Z'));
    recordShadowTick(root, [row('ELA-4', 4, 'now')], {
      launches: [{ issue: issue('ELA-4'), row: row('ELA-4', 4, 'now'), command: 'would run', source: 'cli' }], hitl: [],
    }, new Date('2026-10-04T11:59:59.000Z'));
    recordShadowTick(root, [row('OLD', 4, 'now')], { launches: [], hitl: [] }, new Date('2026-10-03T11:59:59.000Z'));
    const before = snapshot(root);
    const report = stewardReadiness(root, 24, NOW);
    expect(report.ticks).toBe(2);
    expect(report.judgments).toBe(4);
    expect(report.distribution).toEqual({ 'now / rung 4': 2, 'hitl / rung hitl': 1, 'wait / rung 2': 1 });
    expect(report.actions.map(({ issue, kind }) => [issue, kind])).toEqual([['ELA-1', 'launch'], ['ELA-2', 'hitl'], ['ELA-4', 'launch']]);
    expect(report.budgetGate).toMatchObject({ estimatedLlmUsd: 4, estimatedPodUsd: 2, estimatedTotalUsd: 6, verdict: 'estimate-only' });
    expect(report.hitlGate.requiringHuman).toBe(1);
    expect(report.source.logs).toContain('logs --category steward.readiness --event shadow-tick');
    expect(formatStewardReadiness(report)).toContain('HITL gate | 1 human confirmations');
    const output: string[] = [];
    const original = console.log;
    try {
      console.log = (text: string) => { output.push(text); };
      expect(runStewardReadinessCli({ since: '24h', json: true }, root)).toBe(0);
      expect(runStewardReadinessCli({ since: '24h' }, root)).toBe(0);
    } finally { console.log = original; }
    expect(JSON.parse(output[0]!).source.decisions).toBe(join(root, 'steward', 'readiness.jsonl'));
    expect(output[1]).toContain('Budget gate | LLM');
    expect(snapshot(root)).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shadow schedule writes the selected action evidence to the shadow decision line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-readiness-schedule-'));
  const dir = join(root, 'steward');
  mkdirSync(dir);
  writeFileSync(join(dir, 'issues.json'), JSON.stringify([issue('ELA-1'), issue('ELA-2')]));
  writeFileSync(join(dir, 'triage.json'), JSON.stringify([row('ELA-1', 4, 'now'), row('ELA-2', 'hitl', 'hitl')]));
  const events: unknown[] = [];
  const unregister = debug.registerSink({ name: 'steward-readiness-test', emit: record => {
    if (record.category === 'steward.readiness' && record.event === 'shadow-tick') events.push(record.data);
  } });
  try {
    await runStewardStage('schedule', { root, getSecret: async () => 'fake', now: () => NOW, launchSettings: { mode: 'shadow' } });
    const report = stewardReadiness(root, 24, NOW);
    expect(report).toMatchObject({ ticks: 1, judgments: 2, hitlGate: { requiringHuman: 1 } });
    expect(report.actions.map(a => a.kind)).toEqual(['launch', 'hitl']);
    expect(readFileSync(join(dir, 'readiness.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(JSON.parse(readFileSync(join(dir, 'readiness.jsonl'), 'utf8')));
  } finally { unregister(); rmSync(root, { recursive: true, force: true }); }
});

test('invalid window and damaged decision line fail closed without writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-readiness-invalid-'));
  try {
    expect(() => parseReadinessSince('0h')).toThrow('--since');
    expect(() => parseReadinessSince('3d')).toThrow('--since');
    expect(stewardReadiness(root, 24, NOW).ticks).toBe(0);
    mkdirSync(join(root, 'steward'));
    writeFileSync(join(root, 'steward', 'readiness.jsonl'), '{broken\n');
    const before = snapshot(root);
    expect(() => stewardReadiness(root, 24, NOW)).toThrow('Invalid steward shadow decision line 1');
    writeFileSync(join(root, 'steward', 'readiness.jsonl'), JSON.stringify({ at: NOW.toISOString(), decisions: [], actions: [{ kind: 'launch', issue: 'ELA-1', llmUsd: -1, podUsd: 1 }] }) + '\n');
    expect(() => stewardReadiness(root, 24, NOW)).toThrow('Invalid steward shadow decision line 1');
    writeFileSync(join(root, 'steward', 'readiness.jsonl'), '{broken\n');
    expect(snapshot(root)).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
