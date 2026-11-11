import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_SIMULATION_DEVICES, validateAppSimulation } from '../nexus/apps/app-simulate.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { registerSimCommands } from '../cli/sim-cli.js';
import { TEST_FAKE_LLM_ENV, TEST_FAKE_LLM_RESPONSE_ENV, testFakeLlmProvider } from './fake-llm.js';
import { proposeNaturalLanguageScenario } from './nl-scenario.js';

const paymentApp = { connectors: { payment: { fake: 'payment' } } };

test('fixed LLM response turns “결제 실패하면?” into a declared payment scenario', async () => {
  const calls: Array<{ request: string; allowedEvents: readonly string[] }> = [];
  const result = await proposeNaturalLanguageScenario({ request: '결제 실패하면?', simulate: paymentApp,
    chooseEvent: async (input) => { calls.push(input); return 'payment.declined'; } });
  expect(calls).toEqual([{ request: '결제 실패하면?', allowedEvents: ['payment.declined', 'payment.webhook-duplicate'] }]);
  expect(result).toEqual({ status: 'proposed', scenario: { name: 'nl-payment-declined',
    steps: [{ inject: 'payment.declined' }], expect: [{ event: 'payment.declined' }] } });
  if (result.status === 'proposed')
    expect(validateAppSimulation({ ...paymentApp, scenarios: [result.scenario] })).toEqual([]);
});

test('the existing fixed-response LLM device selects only an attached declared event', async () => {
  const previousEnabled = process.env[TEST_FAKE_LLM_ENV];
  const previousResponse = process.env[TEST_FAKE_LLM_RESPONSE_ENV];
  try {
    process.env[TEST_FAKE_LLM_ENV] = '1';
    process.env[TEST_FAKE_LLM_RESPONSE_ENV] = 'payment.declined';
    expect(testFakeLlmProvider.available()).toBe(true);
    const chooseEvent = async (input: { request: string; allowedEvents: readonly string[] }): Promise<string> => {
      const chunks: string[] = [];
      for await (const chunk of testFakeLlmProvider.chat([{ role: 'user', content: JSON.stringify(input) }])) chunks.push(chunk);
      return chunks.join('');
    };
    const result = await proposeNaturalLanguageScenario({ request: '결제 실패하면?', simulate: paymentApp, chooseEvent });
    expect(result.status).toBe('proposed');
    process.env[TEST_FAKE_LLM_RESPONSE_ENV] = 'payment.chargeback';
    expect(await proposeNaturalLanguageScenario({ request: '결제 실패하면?', simulate: paymentApp, chooseEvent }))
      .toEqual({ status: 'no-proposal', reason: 'unrecognized-event' });
  } finally {
    if (previousEnabled === undefined) delete process.env[TEST_FAKE_LLM_ENV];
    else process.env[TEST_FAKE_LLM_ENV] = previousEnabled;
    if (previousResponse === undefined) delete process.env[TEST_FAKE_LLM_RESPONSE_ENV];
    else process.env[TEST_FAKE_LLM_RESPONSE_ENV] = previousResponse;
  }
});

test('undeclared or unattached events never become suggestions', async () => {
  for (const response of ['payment.chargeback', 'object-store.failed', 'payment.declined.extra', 'constructor',
    { event: 'payment.declined', steps: [{ inject: 'payment.chargeback' }] }]) {
    const result = await proposeNaturalLanguageScenario({ request: '결제 실패하면?', simulate: paymentApp,
      chooseEvent: async () => response });
    expect(result).toEqual({ status: 'no-proposal', reason: 'unrecognized-event' });
  }
  expect(APP_SIMULATION_DEVICES['object-store']?.events).toContain('failed');
});

test('unknown or internal connector declarations fail before the LLM is called', async () => {
  let calls = 0;
  for (const simulate of [{ connectors: { payment: { fake: 'fake-land-queue' } } },
    { connectors: { shell: { fake: 'payment' } } }, { connectors: {} }]) {
    const result = await proposeNaturalLanguageScenario({ request: '결제 실패하면?', simulate,
      chooseEvent: async () => { calls++; return 'payment.declined'; } });
    expect(result.status).toBe('no-proposal');
  }
  expect(calls).toBe(0);
});

test('model errors and duplicate scenario names fail closed without returning model text', async () => {
  const modelError = await proposeNaturalLanguageScenario({ request: '결제 실패하면?', simulate: paymentApp,
    chooseEvent: async () => { throw new Error('private-model-response'); } });
  expect(modelError).toEqual({ status: 'no-proposal', reason: 'model-unavailable' });
  expect(JSON.stringify(modelError)).not.toContain('private-model-response');
  const existing = { ...paymentApp, scenarios: [{ name: 'nl-payment-declined', steps: [{ inject: 'payment.declined' }],
    expect: [{ event: 'payment.declined' }] }] };
  const duplicate = await proposeNaturalLanguageScenario({ request: '결제 실패하면?', simulate: existing,
    chooseEvent: async () => 'payment.declined' });
  expect(duplicate).toEqual({ status: 'no-proposal', reason: 'invalid-scenario' });
});

test('registered sim suggest CLI consumes app.yaml and rejects a fixed undeclared model answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-nl-scenario-'));
  const appFile = join(root, 'app.yaml');
  writeFileSync(appFile, `apiVersion: elanous.app/v0\nslug: payment-demo\ntitle: Payment demo\nfrontend: { kind: static-export }\nroles: { owner: {} }\nsimulate:\n  connectors:\n    payment: { fake: payment }\n`);
  const previousRoot = getTestStateRoot();
  const previousEnabled = process.env[TEST_FAKE_LLM_ENV];
  const previousResponse = process.env[TEST_FAKE_LLM_RESPONSE_ENV];
  const previousLog = console.log;
  const previousError = console.error;
  const previousExitCode = process.exitCode;
  const output: string[] = [];
  const errors: string[] = [];
  try {
    setTestStateRoot(root);
    process.env[TEST_FAKE_LLM_ENV] = '1';
    console.log = (value: unknown) => { output.push(String(value)); };
    console.error = (value: unknown) => { errors.push(String(value)); };
    const program = new Command();
    registerSimCommands(program);
    process.env[TEST_FAKE_LLM_RESPONSE_ENV] = 'payment.declined';
    process.exitCode = 0;
    await program.parseAsync(['node', 'test', 'sim', 'suggest', appFile, '결제 실패하면?']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ status: 'proposed', scenario: { steps: [{ inject: 'payment.declined' }] } });
    expect(process.exitCode).toBe(0);
    process.env[TEST_FAKE_LLM_RESPONSE_ENV] = 'payment.chargeback';
    process.exitCode = 0;
    await program.parseAsync(['node', 'test', 'sim', 'suggest', appFile, '결제 실패하면?']);
    expect(JSON.parse(output.pop()!)).toEqual({ status: 'no-proposal', reason: 'unrecognized-event' });
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    setTestStateRoot(previousRoot ?? null);
    if (previousEnabled === undefined) delete process.env[TEST_FAKE_LLM_ENV];
    else process.env[TEST_FAKE_LLM_ENV] = previousEnabled;
    if (previousResponse === undefined) delete process.env[TEST_FAKE_LLM_RESPONSE_ENV];
    else process.env[TEST_FAKE_LLM_RESPONSE_ENV] = previousResponse;
    console.log = previousLog;
    console.error = previousError;
    process.exitCode = previousExitCode ?? 0;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a changing declaration cannot alter the in-flight suggestion snapshot', async () => {
  const simulate = { connectors: { payment: { fake: 'payment' } } };
  const result = await proposeNaturalLanguageScenario({ request: '결제 실패하면?', simulate,
    chooseEvent: async () => { (simulate as { connectors: Record<string, unknown> }).connectors = {}; return 'payment.declined'; } });
  expect(result.status).toBe('proposed');
});
