import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscribeInsideEvent } from '../nexus/api/inside-events.js';
import { parseRepairMarker, parseRepairWorkerResult, repairHarnessArgs, runRepairWorker, type RepairWorkerRequest } from './repair-worker.js';

const HEAD = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const HASH = 'c'.repeat(64);
const request: RepairWorkerRequest = { card: 'ta-1', pr: 30, head: HEAD, repo: '/repo', resultPath: '/state/repair.json',
  entry: '/bin/elanous.mjs', configDir: '/state', runId: 'run-123', seat: 'TC', goal: 'fix exact must-fix',
  model: { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' } };

test('repair worker pins the source PR and head, disables queue and merge, and changes child model', () => {
  const args = repairHarnessArgs(request);
  expect(args).toContain('--repair-commit-only');
  expect(args).toEqual(expect.arrayContaining(['--source', 'pr:30', '--repair-commit-only', HEAD,
    '--no-queue', '--no-auto-merge', '--child-llm-provider', 'openrouter', '--child-llm-model', 'openrouter/z-ai/glm-5.3']));
  expect(args.at(-1)).toBe('fix exact must-fix');
  expect(args).not.toContain('--open-pr');
});

test('only exact PR/head artifact marker can become a repair result', () => {
  const marker = { job: 'si-test', artifactDir: '/artifact', pr: 30, baseHead: HEAD, runId: 'run-123', commit: COMMIT, bundleSha256: HASH };
  const text = `log\nELANOUS_POD_REPAIR_RESULT ${JSON.stringify(marker)}\n`;
  expect(parseRepairMarker(text, 30, HEAD, 'run-123')).toMatchObject({ job: 'si-test', result: { pr: 30, baseHead: HEAD, runId: 'run-123', commit: COMMIT } });
  expect(parseRepairMarker(text, 31, HEAD, 'run-123')).toBeNull();
  expect(parseRepairMarker(text, 30, COMMIT, 'run-123')).toBeNull();
  expect(parseRepairMarker(text, 30, HEAD, 'run-other')).toBeNull();
  const result = { pr: 30, head: HEAD, runId: 'run-123', ok: true, job: 'si-test', artifactDir: '/artifact',
    result: { pr: 30, baseHead: HEAD, runId: 'run-123', commit: COMMIT, bundleSha256: HASH } };
  expect(parseRepairWorkerResult(JSON.stringify(result), 30, HEAD, 'run-123')).toEqual(result);
  expect(parseRepairWorkerResult(JSON.stringify(result), 30, HEAD, 'run-other')).toBeNull();
  expect(parseRepairWorkerResult(JSON.stringify({ ...result, head: 42 }), 30, HEAD, 'run-123')).toBeNull();
});

test('worker publishes completion only after the atomic result file exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repair-worker-event-'));
  const resultPath = join(dir, 'repair.json');
  const entry = join(dir, 'child.ts');
  const marker = { job: 'si-test', artifactDir: dir, pr: 30, baseHead: HEAD, runId: 'run-123', commit: COMMIT, bundleSha256: HASH };
  writeFileSync(entry, `console.log('ELANOUS_POD_REPAIR_RESULT ' + JSON.stringify(${JSON.stringify(marker)}));`);
  const observed: Array<{ result: unknown; event: unknown }> = [];
  const stop = subscribeInsideEvent(event => {
    if (event.kind === 'ta.repair.completed') observed.push({ event, result: JSON.parse(readFileSync(resultPath, 'utf8')) });
  });
  try {
    const result = await runRepairWorker({ ...request, entry, repo: dir, resultPath });
    expect(result.ok).toBe(true);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.result).toEqual(result);
    expect(observed[0]?.event).toMatchObject({ kind: 'ta.repair.completed', schema: 1, card: 'ta-1', pr: 30, runId: 'run-123' });
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed worker also publishes its durable failure result for immediate collection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repair-worker-failed-event-'));
  const resultPath = join(dir, 'repair.json');
  const entry = join(dir, 'child.ts');
  writeFileSync(entry, 'console.error("repair failed"); process.exit(8);');
  const observed: unknown[] = [];
  const stop = subscribeInsideEvent(event => {
    if (event.kind === 'ta.repair.completed') observed.push(JSON.parse(readFileSync(resultPath, 'utf8')));
  });
  try {
    const result = await runRepairWorker({ ...request, entry, repo: dir, resultPath });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('harness exited 8');
    expect(observed).toEqual([result]);
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
