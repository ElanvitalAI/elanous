import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { prodInstanceRoot } from '../instance/resolve.js';
import { inspectResearchDecisionOutput, runThinkLensDecisionChainMock, THINK_LENS_MOCK_COMMAND } from './research-decision-chain.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('THINK-LENS-T2-SECOND-ORDER mock device', () => {
  test('production research-turn decision path emits a run-linked chain; neutral control stays unchanged', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'think-lens-device-'));
    roots.push(stateRoot);
    const result = await runThinkLensDecisionChainMock(stateRoot);
    console.log(`${THINK_LENS_MOCK_COMMAND} · decisionRunId=${result.decisionRunId} · controlRunId=${result.controlRunId} · passed=${result.passed} · liveBenchmarkMeasured=${result.liveBenchmarkMeasured}`);
    expect(result.decisionRunId).toMatch(/^run-think-lens-decision-[0-9a-f-]{36}$/);
    expect(result.controlRunId).toMatch(/^run-think-lens-control-[0-9a-f-]{36}$/);
    expect(result.decisionRunId).not.toBe(result.controlRunId);
    expect(result.decision).toEqual({ ok: true, hasThreeStages: true, hasOrderedLinks: true, passed: true, appliedEvents: 1, skippedEvents: 0 });
    expect(result.control).toEqual({ ok: true, hasNoChain: true, appliedEvents: 0, skippedEvents: 1 });
    const emptyFirstOutput = result.decisionOutput.replace(/(^- 1차 결과 \(30일\):)[ \t]*[^\r\n]+$/m, '$1');
    const emptyFirstShape = inspectResearchDecisionOutput(emptyFirstOutput);
    expect(emptyFirstShape.hasThreeStages).toBe(false);
    expect(emptyFirstShape.passed).toBe(false);

    const reorderedLines = result.decisionOutput.split(/\r?\n/);
    const firstIndex = reorderedLines.findIndex((line) => line.startsWith('- 1차 결과 (30일):'));
    const thirdIndex = reorderedLines.findIndex((line) => line.startsWith('- 3차 결과 (540일):'));
    [reorderedLines[firstIndex], reorderedLines[thirdIndex]] = [reorderedLines[thirdIndex]!, reorderedLines[firstIndex]!];
    const reorderedShape = inspectResearchDecisionOutput(reorderedLines.join('\n'));
    expect(reorderedShape.hasThreeStages).toBe(true);
    expect(reorderedShape.passed).toBe(false);
    expect(result.mockOnly).toBe(true);
    expect(result.liveBenchmarkMeasured).toBe(false);
    expect(result.passed).toBe(true);
  }, 30_000);

  test('refuses a production-root path before creating it', async () => {
    const refusedRoot = join(prodInstanceRoot(), `think-lens-refused-${Date.now()}`);
    expect(existsSync(refusedRoot)).toBe(false);
    await expect(runThinkLensDecisionChainMock(refusedRoot)).rejects.toThrow('production-root');
    expect(existsSync(refusedRoot)).toBe(false);
  });

  test('isolates mock events from an already registered parent-process sink', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'think-lens-device-existing-sink-'));
    roots.push(stateRoot);
    const priorStateDir = process.env.ELANOUS_STATE_DIR;
    const priorRunId = process.env.ELANOUS_RUN_ID;
    let receivedResearchLensEvents = 0;
    const unregister = debug.registerSink({
      name: 'think-lens-device-parent-sink-probe',
      emit(record) { if (record.category === 'research.lens') receivedResearchLensEvents += 1; },
    });
    try {
      const result = await runThinkLensDecisionChainMock(stateRoot);
      expect(result.passed).toBe(true);
      expect(receivedResearchLensEvents).toBe(0);
      expect(process.env.ELANOUS_STATE_DIR).toBe(priorStateDir);
      expect(process.env.ELANOUS_RUN_ID).toBe(priorRunId);
    } finally {
      unregister();
    }
  }, 30_000);

  test('concurrent worker processes isolate process-global state and run identities', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'think-lens-device-concurrent-a-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'think-lens-device-concurrent-b-'));
    roots.push(firstRoot, secondRoot);
    const [first, second] = await Promise.all([
      runThinkLensDecisionChainMock(firstRoot),
      runThinkLensDecisionChainMock(secondRoot),
    ]);

    expect(first.passed).toBe(true);
    expect(second.passed).toBe(true);
    expect(new Set([first.decisionRunId, first.controlRunId, second.decisionRunId, second.controlRunId]).size).toBe(4);
    expect(first.stateRoot).toBe(firstRoot);
    expect(second.stateRoot).toBe(secondRoot);
  }, 60_000);
});
