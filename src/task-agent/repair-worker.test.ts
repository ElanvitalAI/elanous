import { expect, test } from 'bun:test';
import { parseRepairMarker, parseRepairWorkerResult, repairHarnessArgs, type RepairWorkerRequest } from './repair-worker.js';

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
