import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runAppSimulation, runDeclaredAppSimulation, runRegisteredAppSimulation } from './app-simulation-runner.js';
import { discoverChromeBinary } from '../../browser-cdp/client.js';

const scenarioReceipt = (appSlug: string, outcome: 'passed' | 'failed' = 'passed') => {
  const runId = `run-${appSlug}`;
  const receiptId = `receipt-${appSlug}`;
  return {
    runId,
    events: [{ kind: 'app.sim.step' as const, appId: appSlug, runId, ts: Date.parse('2026-01-01T00:00:00Z'),
      data: { step: 'add-note', message: 'inserted', receiptId } }],
    receipts: [{ id: receiptId, appId: appSlug, runId, outcome, summary: 'scenario execution' }],
  };
};

test('app scenario runner sends the selected declaration to the executor and evaluates its expectations', async () => {
  const oneRow = ['notes'].length;
  const selected = { name: 'write-and-retry', steps: [{ rpc: 'addNote', as: 'owner' }, { inject: 'payment.declined', at: '+1m' }],
    expect: [{ table: 'notes', rows: oneRow }, { event: 'payment.retry-scheduled' }, { 'screen-text': '다시 시도' }] };
  const skipped = { name: 'skipped-scenario', steps: [{ action: 'summarize', as: 'owner' }], expect: [{ event: 'summary.done' }] };
  const calls: string[] = [];
  const result = await runAppSimulation({ appSlug: 'demo-app', scenarios: [selected, skipped], scenarioName: selected.name }, async (scenario) => {
    calls.push(scenario.name);
    expect(scenario).toEqual(selected);
    return { result: scenarioReceipt('demo-app'), evidence: {
      events: ['payment.retry-scheduled'], tableRows: { notes: oneRow }, screenText: '다시 시도할 수 있습니다',
    } };
  });

  expect(calls).toEqual([selected.name]);
  expect(result).toMatchObject({ appSlug: 'demo-app', passed: true,
    scenarios: [{ name: selected.name, passed: true, failedExpectations: [], result: { receipts: [{ outcome: 'passed' }] } }] });
});

test('app scenario runner downgrades receipts when an expectation or runtime fails', async () => {
  const oneRow = ['notes'].length;
  const noRows = [].length;
  const scenario = { name: 'missing-result', steps: [{ rpc: 'addNote' }], expect: [{ table: 'notes', rows: oneRow }] };
  const result = await runAppSimulation({ appSlug: 'demo-app', scenarios: [scenario] }, async () => ({
    result: scenarioReceipt('demo-app'), evidence: { events: [], tableRows: { notes: noRows }, screenText: '' }, runtimePassed: false,
  }));

  expect(result).toMatchObject({ passed: false, scenarios: [{ passed: false,
    failedExpectations: ['simulation runtime reported failure', 'table:notes expected 1 rows'],
    result: { receipts: [{ outcome: 'failed', summary: expect.stringContaining('Failed expectations') }] } }] });
});

test('app scenario runner preserves failed receipts and rejects malformed executor evidence', async () => {
  const scenario = { name: 'receipt-integrity', steps: [{ action: 'summarize' }], expect: [] };
  const failedReceipt = await runAppSimulation({ appSlug: 'demo-app', scenarios: [scenario] }, async () => ({
    result: scenarioReceipt('demo-app', 'failed'), evidence: { events: [], tableRows: {}, screenText: '' },
  }));
  const malformedEvidence = await runAppSimulation({ appSlug: 'demo-app', scenarios: [scenario] }, async () => ({
    result: scenarioReceipt('demo-app'),
    evidence: { events: 'expected-event-substring', tableRows: {}, screenText: '' } as unknown as { events: string[]; tableRows: Record<string, number>; screenText: string },
  }));

  expect(failedReceipt.scenarios[0]?.passed).toBe(false);
  expect(failedReceipt.scenarios[0]?.result.receipts[0]?.outcome).toBe('failed');
  expect(malformedEvidence).toMatchObject({ passed: false,
    scenarios: [{ passed: false, failedExpectations: ['executor evidence.events must be a list of non-empty strings'],
      result: { receipts: [{ outcome: 'failed' }] } }] });
});

test('app scenario runner fails closed on recorded network attempts', async () => {
  const scenario = { name: 'network-attempt', steps: [{ action: 'summarize' }], expect: [] };
  const result = await runAppSimulation({ appSlug: 'demo-app', scenarios: [scenario] }, async () => ({
    result: scenarioReceipt('demo-app'), evidence: { events: [], tableRows: {}, screenText: '' },
    externalNetworkEvents: [{ url: 'https://outside.invalid/', blocked: true }],
  }));

  expect(result).toMatchObject({ passed: false, scenarios: [{ passed: false,
    failedExpectations: ['executor recorded blocked external network attempts'],
    externalNetworkEvents: [{ blocked: true }], result: { receipts: [{ outcome: 'failed' }] } }] });
});

test('declared app runner builds an isolated world and sends only the selected app.yaml scenario', async () => {
  const selected = { name: 'write-note', steps: [{ rpc: 'addNote', as: 'owner' }],
    expect: [{ table: 'notes', rows: ['notes'].length }, { event: 'rpc.addNote.completed' }] };
  const skipped = { name: 'other-flow', steps: [{ action: 'summarize', as: 'owner' }], expect: [{ event: 'action.summarize.completed' }] };
  const appSlug = 'demo-app';
  const appRun = scenarioReceipt(appSlug);
  const commands: string[] = [];
  let receivedScenario: Record<string, unknown> | undefined;
  const result = await runDeclaredAppSimulation({ manifest: { slug: appSlug, simulate: { scenarios: [selected, skipped] } }, scenarioName: selected.name }, async (args) => {
    commands.push(args[2]!);
    if (args[2] === 'create-yaml') {
      const world = parseYaml(readFileSync(args[3]!, 'utf8')) as { world: string };
      return { status: 0, stdout: JSON.stringify({ id: world.world }) };
    }
    if (args[2] === 'run') {
      receivedScenario = parseYaml(readFileSync(args[4]!, 'utf8')) as Record<string, unknown>;
      return { status: 0, stdout: JSON.stringify({ pass: true, devices: ['fake-clock'], appSimulation: appRun,
        appSimulationEvidence: { events: ['rpc.addNote.completed'], tableRows: { notes: ['notes'].length }, screenText: '' },
        externalNetworkEvents: [] }) };
    }
    return { status: 0, stdout: '' };
  });

  expect(commands).toEqual(['create-yaml', 'run', 'destroy']);
  expect(receivedScenario?.appSimulation).toMatchObject({ manifest: { slug: appSlug }, scenario: selected });
  expect(result).toMatchObject({ passed: true, scenarios: [{ name: selected.name, passed: true,
    result: { receipts: [{ appId: appSlug, outcome: 'passed' }] } }] });
  expect(result.networkEvidence).toEqual({ sandboxEstablished: true, externalNetworkAttempts: 0,
    blockedNetworkAttempts: 0, unmeasuredCount: 0 });
});

test.skipIf(process.platform !== 'darwin' || !discoverChromeBinary())('declared simulation uses rendered Nexus-host screen text after execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'declared-app-render-'));
  const appDirectory = join(root, 'demo-app');
  mkdirSync(join(appDirectory, 'out'), { recursive: true });
  writeFileSync(join(appDirectory, 'app.yaml'), `apiVersion: elanous.app/v0
slug: demo-app
title: Render fixture
frontend: { kind: static-export, out: out/ }
roles:
  owner: { via: nexus-session }
`);
  writeFileSync(join(appDirectory, 'out', 'index.html'), '<main><h1>Initial state</h1><p id="status">Pending</p><script>document.querySelector("#status").textContent="Done after JS";window.__ELANOUS_SIM_RENDER_READY__=true</script></main>');
  const manifest = { slug: 'demo-app', frontend: { kind: 'static-export' }, simulate: { scenarios: [
    { name: 'render', steps: [], expect: [{ 'screen-text': 'Done after JS' }] },
  ] } };
  const executeCli = async (args: string[]) => {
    if (args[2] === 'create-yaml') {
      const world = parseYaml(readFileSync(args[3]!, 'utf8')) as { world: string };
      return { status: 0, stdout: JSON.stringify({ id: world.world }) };
    }
    if (args[2] === 'run') return { status: 0, stdout: JSON.stringify({ pass: true, appSimulation: scenarioReceipt('demo-app'),
      appSimulationEvidence: { events: [], tableRows: {}, screenText: '<script>Done after JS</script>' }, externalNetworkEvents: [] }) };
    return { status: 0, stdout: '' };
  };
  try {
    const result = await runDeclaredAppSimulation({ manifest, appDirectory }, { executeCli });
    expect(result.passed).toBe(true);
    expect(result.scenarios[0]?.evidence.screenStatus).toBe('measured');
    expect(result.scenarios[0]?.evidence.screenText).toContain('Done after JS');
    expect(result.scenarios[0]?.evidence.screenText).not.toContain('<script>');

    const unavailable = await runDeclaredAppSimulation({ manifest, appDirectory }, { executeCli,
      renderScreen: async () => ({ status: 'unmeasured', reason: 'headless Chrome unavailable', blockedUrls: [], browserDeniedUrls: [] }) });
    expect(unavailable.passed).toBe(false);
    expect(unavailable.scenarios[0]?.failedExpectations).toContain('screen-text:unmeasured');
    expect(unavailable.scenarios[0]?.evidence).toMatchObject({ screenStatus: 'unmeasured', screenText: '' });

    const worker = await runDeclaredAppSimulation({ manifest, appDirectory }, { executeCli,
      renderScreen: async () => ({ status: 'unmeasured', reason: 'app worker target is outside the measured screen boundary',
        blockedUrls: ['http://127.0.0.1/worker.js'], browserDeniedUrls: [] }) });
    expect(worker.passed).toBe(false);
    expect(worker.scenarios[0]?.externalNetworkEvents).toContainEqual({ url: 'http://127.0.0.1/worker.js', blocked: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
