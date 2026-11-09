import { expect, test } from 'bun:test';
import { runRegisteredAppSimulation } from './app-simulation-runner.js';

test('registered app runner creates, runs, parses and destroys its isolated world', async () => {
  const runId = 'registered-run-1';
  const receiptId = 'registered-receipt-1';
  const calls: Array<{ args: string[]; allowedStatus?: readonly number[] }> = [];
  const executeCli = async (args: string[], allowedStatus?: readonly number[]) => {
    calls.push({ args, allowedStatus });
    if (args[2] === 'create-yaml') return { status: 0, stdout: JSON.stringify({ id: 'app-demo-1114' }) };
    if (args[2] === 'run') return { status: 0, stdout: JSON.stringify({ pass: true, appSimulation: {
      runId,
      events: [{ kind: 'app.sim.step', appId: 'voice-notes', runId, ts: 1,
        data: { step: 'recording-and-transcription', message: '녹음과 받아쓰기 확인', receiptId } }],
      receipts: [{ id: receiptId, appId: 'voice-notes', runId, outcome: 'passed', summary: 'SIM-CHAIN-APP 완료' }],
    } }) };
    if (args[2] === 'destroy') return { status: 0, stdout: '' };
    throw new Error(`unexpected simulation CLI call: ${args.join(' ')}`);
  };

  const result = await runRegisteredAppSimulation('voice-notes', executeCli);
  expect(result.runId).toBe(runId);
  expect(result.events).toHaveLength(1);
  expect(result.receipts).toHaveLength(1);
  expect(calls.map(({ args }) => args.slice(0, 3))).toEqual([
    ['sim', 'world', 'create-yaml'], ['sim', 'world', 'run'], ['sim', 'world', 'destroy'],
  ]);
  expect(calls[0]?.args[3]).toBe('scenarios/ux-sim/app-demo-1114.yaml');
  expect(calls[1]?.args[3]).toBe('app-demo-1114');
  expect(calls[1]?.allowedStatus).toEqual([0, 1]);
  expect(calls[2]?.args[3]).toBe('app-demo-1114');
});

test('registered app runner rejects unknown apps without invoking the CLI', async () => {
  let calls = 0;
  await expect(runRegisteredAppSimulation('unknown-app', async () => {
    calls++;
    return { status: 0, stdout: '' };
  })).rejects.toThrow('app simulation is not registered');
  expect(calls).toBe(0);
});
