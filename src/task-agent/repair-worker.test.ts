import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscribeInsideEvent } from '../nexus/api/inside-events.js';
import { parseRepairMarker, parseRepairWorkerResult, repairFailureSignature, repairGateFailureTests, repairHarnessArgs, repairWorkerEnv, runRepairWorker, type RepairWorkerRequest } from './repair-worker.js';

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

test('only an explicit gate fingerprint or named provider mismatch becomes a repeat signature', () => {
  const fingerprint = 'a'.repeat(64);
  expect(repairFailureSignature(`childStage=gate-failed\nGATE_FAILURE_SIGNATURE=sha256:${fingerprint}\n`))
    .toBe(`gate:sha256:${fingerprint}`);
  expect(repairFailureSignature('childStage=gate-failed · reason=convergence failed')).toBeNull();
  expect(repairFailureSignature('review fallback: ambiguous or unsupported primary model "glm-5.3"'))
    .toBe('provider:ambiguous-primary:glm-5.3');
  expect(repairFailureSignature('review fallback: ambiguous or unsupported primary model "glm 5.3"')).toBeNull();
  expect(repairFailureSignature('review fallback: provider overloaded')).toBeNull();
});

test('signed gate failure carries readable test identities through the durable worker result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repair-worker-gate-receipt-'));
  const resultPath = join(dir, 'repair.json');
  const entry = join(dir, 'child.ts');
  const tests = ['src/a.test.ts > A (assertion)', 'src/b.test.ts > B (runtime-error)'];
  const signature = `sha256:${'d'.repeat(64)}`;
  writeFileSync(entry, `console.log('GATE_FAILURE_SIGNATURE=${signature}'); console.log('GATE_FAILURE_TESTS=${JSON.stringify(tests)}'); process.exit(8);`);
  try {
    expect(repairGateFailureTests(`GATE_FAILURE_TESTS=${JSON.stringify(tests)}\n`)).toEqual(tests);
    const result = await runRepairWorker({ ...request, entry, repo: dir, resultPath });
    expect(result).toMatchObject({ ok: false, failureSignature: `gate:${signature}`, gateFailureTests: tests });
    expect(parseRepairWorkerResult(readFileSync(resultPath, 'utf8'), 30, HEAD, 'run-123'))
      .toMatchObject({ failureSignature: `gate:${signature}`, gateFailureTests: tests });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TA-PARENT-ROLE-LLM: repair-run forwards a credit GLM parent policy to its own harness process', () => {
  const pin = 'audit={"provider":"openrouter","model":"openrouter/z-ai/glm-5.3"}';
  const withRole = { ...request, parentRoleLlm: [pin] };
  expect(repairHarnessArgs(withRole)).not.toContain('--role-llm'); // harness say reads the role env pin
  expect(JSON.parse(repairWorkerEnv(withRole).ELANOUS_ROLE_LLM_AUDIT!)).toEqual({ provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' });
  expect(repairWorkerEnv(request).ELANOUS_ROLE_LLM_AUDIT).toBeUndefined();
});

test('PLANNING-FOLLOWS-CHILD-LLM: repair worker reapplies the exact planning model from the card', () => {
  const planningPin = 'planning={"provider":"openai-codex","model":"gpt-6-luna"}';
  const withRole = { ...request, parentRoleLlm: [planningPin] };
  expect(repairHarnessArgs(withRole)).not.toContain('--role-llm');
  expect(JSON.parse(repairWorkerEnv(withRole).ELANOUS_ROLE_LLM_PLANNING!))
    .toEqual({ provider: 'openai-codex', model: 'gpt-6-luna' });
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
