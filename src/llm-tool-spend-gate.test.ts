// Real tool-loop dispatch and real spend gate; providers, state and clock are synthetic.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from './debug/log.js';
import { __setLiveSpendTestSeam, streamLLMWithTools, type LLMProvider } from './llm.js';
import { spendPolicyStream, SpendPolicyStopError } from './llm/spend-policy-stream.js';
import { effectiveCodexAccountName } from './oauth/codex-account-override.js';
import { createInMemoryGuardStore } from './oauth/llm-spend-guard.js';
import { createInMemoryReservationLedger } from './oauth/llm-spend-reservation.js';
import { defaultSpendPolicyDoc } from './nexus/llm-spend-policy/schema.js';
import { policyWith, exhaustAllSubscriptions } from './ux-sim/llm-provider-world/scenarios.js';
import type { LlmCallHandle, LlmCallGateResult } from './oauth/llm-call-gate.js';
import { createLlmProviderWorld } from './ux-sim/llm-provider-world/world.js';

const envNames = ['ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE', 'ELANOUS_TEST_FAKE_LLM_AS_PROVIDER', 'ELANOUS_CODEX_ACCOUNT', 'ELANOUS_STATE_DIR'] as const;
const saved = new Map(envNames.map(name => [name, process.env[name]]));
const roots: string[] = [];
beforeEach(() => { const state = mkdtempSync(join(tmpdir(), 'tool-spend-state-')); roots.push(state); process.env.ELANOUS_STATE_DIR = state; });
afterEach(() => { __setLiveSpendTestSeam(undefined); for (const name of envNames) { const value = saved.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function clearFakeEnv() { for (const name of envNames) if (name !== 'ELANOUS_STATE_DIR') delete process.env[name]; }

// The world injects synthetic windows and leases; the real gate/settle and tool loop stay intact.
test('auto tool loop gates every provider request and moves default to team across a tool call', async () => {
  clearFakeEnv();
  const root = mkdtempSync(join(tmpdir(), 'tool-spend-')); roots.push(root);
  const world = createLlmProviderWorld({ startIso: '2026-11-20T00:00:00Z', balanceUsd: 50 });
  const tags: string[] = [], accounts: (string | undefined)[] = [];
  let rounds = 0;
  const provider: LLMProvider = { name: 'openai-codex', defaultModel: 'gpt-6.2-sol', available: () => true, async *chat() {},
    async *streamChat() { accounts.push(effectiveCodexAccountName()); rounds++; if (rounds === 1) yield { type: 'tool_call', id: 'c1', name: 'Read', args: {} }; else yield { type: 'text', delta: 'done' }; },
  };
  __setLiveSpendTestSeam({ eligible: true, providerFor: () => provider, deps: { policyDir: root, lowBalanceMailer: async () => {},
    readPolicy: async () => defaultSpendPolicyDoc(), observers: [() => world.states()], now: () => world.clock.now(),
    memory: createInMemoryGuardStore(), reservations: createInMemoryReservationLedger(), recordUsageTag: tag => { tags.push(tag.row); } } });
  const output = await streamLLMWithTools([{ role: 'user', content: 'read' }], { onText() {}, async dispatchTool() {
    world.codex.default.exhaust('five-hour', '2026-11-20T05:00:00Z'); return 'read';
  } }, { provider, tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }] });
  expect(output).toBe('done'); expect(accounts).toEqual(['default', 'team']); expect(tags).toEqual(['codex-default', 'codex-team']);
  expect(process.env.ELANOUS_CODEX_ACCOUNT).toBeUndefined();
});

test('a quota signal settles the failed account and reselects another account before any tool executes', async () => {
  clearFakeEnv();
  const root = mkdtempSync(join(tmpdir(), 'tool-spend-')); roots.push(root);
  const world = createLlmProviderWorld({ startIso: '2026-11-20T00:00:00Z', balanceUsd: 50 });
  const accounts: (string | undefined)[] = [], tags: string[] = [];
  const provider: LLMProvider = { name: 'openai-codex', defaultModel: 'gpt-6.2-sol', available: () => true, async *chat() {},
    async *streamChat() { const account = effectiveCodexAccountName(); accounts.push(account); if (account === 'default') throw Object.assign(new Error('usage_limit_reached'), { status: 429 }); yield { type: 'text', delta: 'done' }; },
  };
  __setLiveSpendTestSeam({ eligible: true, providerFor: () => provider, deps: { policyDir: root, lowBalanceMailer: async () => {},
    readPolicy: async () => defaultSpendPolicyDoc(), observers: [() => world.states()], now: () => world.clock.now(),
    memory: createInMemoryGuardStore(), reservations: createInMemoryReservationLedger(),
    recordSignal: record => { if (record.row === 'codex-default') world.codex.default.exhaust('five-hour', '2026-11-20T05:00:00Z'); },
    recordUsageTag: tag => { tags.push(`${tag.row}:${tag.status}`); } } });
  expect(await streamLLMWithTools([{ role: 'user', content: 'hello' }], { onText() {}, async dispatchTool() { return 'ok'; } },
    { provider, tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }] })).toBe('done');
  expect(accounts).toEqual(['default', 'team']); expect(tags).toEqual(['codex-default:failed', 'codex-team:ok']);
});

test('unavailable rows stop without falling through to an unapproved provider', async () => {
  clearFakeEnv();
  const root = mkdtempSync(join(tmpdir(), 'tool-spend-')); roots.push(root);
  let attempted = 0;
  const provider: LLMProvider = { name: 'openai-codex', defaultModel: 'gpt-6.2-sol', available: () => true, async *chat() {},
    async *streamChat() { attempted++; yield { type: 'text', delta: 'bad' }; } };
  __setLiveSpendTestSeam({ eligible: true, providerFor: () => provider, deps: { policyDir: root, lowBalanceMailer: async () => {},
    readPolicy: async () => defaultSpendPolicyDoc(), observers: [], now: () => new Date('2026-11-20T00:00:00Z'), memory: createInMemoryGuardStore() } });
  const log = spyOn(debug, 'log');
  try {
    await expect(streamLLMWithTools([{ role: 'user', content: 'hello' }], { onText() {}, async dispatchTool() { return 'ok'; } },
      { provider, tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }] })).rejects.toBeInstanceOf(SpendPolicyStopError);
    expect(attempted).toBe(0);
    expect(log.mock.calls.some(([category, event]) => category === 'llm.usage' && event === 'llm-usage')).toBe(false);
  } finally { log.mockRestore(); }
});

// Explicit test credit model avoids the review role's GLM deny rule.
test('review follows default → team → allowed credit → reset using the real tool-loop entry', async () => {
  clearFakeEnv();
  const root = mkdtempSync(join(tmpdir(), 'tool-spend-')); roots.push(root);
  const world = createLlmProviderWorld({ startIso: '2026-11-20T00:00:00Z', balanceUsd: 50 });
  const rows: string[] = [], called: string[] = [], spends: number[] = [];
  const mock = (name: string): LLMProvider => ({ name, defaultModel: name === 'openrouter' ? 'openrouter/moonshotai/kimi-k3' : 'gpt-6.2-sol', available: () => true,
    async *chat() {}, async *streamChat() { called.push(`${name}:${effectiveCodexAccountName() ?? '-'}`); if (name === 'openrouter') yield { type: 'usage', usage: { reportedCostUsd: 0.42 } }; yield { type: 'text', delta: 'done' }; } });
  const codex = mock('openai-codex'), credit = mock('openrouter');
  const policy = policyWith({ creditModels: ['openrouter/moonshotai/kimi-k3'] });
  __setLiveSpendTestSeam({ eligible: true, providerFor: name => name === 'openai-codex' ? codex : name === 'openrouter' ? credit : undefined, deps: { policyDir: root, lowBalanceMailer: async () => {},
    readPolicy: async () => policy, observers: [() => world.states()], now: () => world.clock.now(), memory: createInMemoryGuardStore(),
    reservations: createInMemoryReservationLedger(), recordUsageTag: tag => { rows.push(tag.row); }, recordSpend: entry => { spends.push(entry.usd); } } });
  const run = () => streamLLMWithTools([{ role: 'user', content: 'review' }], { onText() {}, async dispatchTool() { return 'ok'; } },
    { provider: codex, usageRole: 'review', tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }] });
  await run();
  world.codex.default.exhaust('five-hour', '2026-11-20T05:00:00Z'); await run();
  exhaustAllSubscriptions(world, '2026-11-20T05:00:00Z'); world.acp.setAlive(false); await run();
  world.clock.set('2026-11-20T05:00:00Z'); await run();
  expect(rows).toEqual(['codex-default', 'codex-team', 'openrouter', 'codex-default']);
  expect(called).toEqual(['openai-codex:default', 'openai-codex:team', 'openrouter:-', 'openai-codex:default']);
  expect(spends).toEqual([0.42]);
});

test('explicit provider remains untouched when automatic spend policy is not selected', async () => {
  clearFakeEnv();
  let called = 0;
  const provider: LLMProvider = { name: 'fixed-provider', defaultModel: 'fixed-model', available: () => true, async *chat() {},
    async *streamChat() { called++; yield { type: 'text', delta: 'fixed' }; } };
  expect(await streamLLMWithTools([{ role: 'user', content: 'hello' }], { onText() {}, async dispatchTool() { return 'ok'; } },
    { provider, tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }] })).toBe('fixed');
  expect(called).toBe(1);
});

test('cancelling while gate selection is pending releases the reservation and never calls the provider', async () => {
  let resolve!: (result: LlmCallGateResult) => void;
  const pending = new Promise<LlmCallGateResult>(done => { resolve = done; });
  const outcomes: string[] = []; let called = 0;
  const provider: LLMProvider = { name: 'openai-codex', defaultModel: 'model', available: () => true, async *chat() {},
    async *streamChat() { called++; yield { type: 'text', delta: 'unused' }; } };
  const handle = {} as LlmCallHandle;
  const stream = spendPolicyStream({ messages: [], opts: {}, original: provider, select: () => pending,
    settle: async (_handle, outcome) => { outcomes.push(outcome.status); }, signalFromError: () => undefined,
    accountForRow: () => 'team', providerForName: () => provider, onSelected: () => {} });
  const next = stream.next();
  await stream.return!();
  resolve({ outcome: 'go', row: 'codex-team', provider: 'openai-codex', model: 'model', reservation: null, ledgerLines: [], skipped: [], handle });
  await next;
  expect(called).toBe(0); expect(outcomes).toEqual(['not-called']);
});

test('policy absence leaves the original provider and output unchanged', async () => {
  clearFakeEnv();
  const root = mkdtempSync(join(tmpdir(), 'tool-spend-')); roots.push(root);
  let calls = 0;
  const provider: LLMProvider = { name: 'custom-provider', defaultModel: 'custom-model', available: () => true, async *chat() {},
    async *streamChat() { calls++; yield { type: 'text', delta: 'unchanged' }; } };
  __setLiveSpendTestSeam({ eligible: true, deps: { policyDir: root, lowBalanceMailer: async () => {}, readPolicy: async () => null,
    observers: [], now: () => new Date('2026-11-20T00:00:00Z'), memory: createInMemoryGuardStore() } });
  expect(await streamLLMWithTools([{ role: 'user', content: 'hello' }], { onText() {}, async dispatchTool() { return 'ok'; } },
    { provider, tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }] })).toBe('unchanged');
  expect(calls).toBe(1);
});

test('stale quota observations stop after a bounded number of retries', async () => {
  clearFakeEnv();
  const root = mkdtempSync(join(tmpdir(), 'tool-spend-')); roots.push(root);
  const world = createLlmProviderWorld({ startIso: '2026-11-20T00:00:00Z', balanceUsd: 50 });
  let calls = 0;
  const provider: LLMProvider = { name: 'openai-codex', defaultModel: 'gpt-6.2-sol', available: () => true, async *chat() {},
    async *streamChat() { calls++; throw Object.assign(new Error('usage_limit_reached'), { status: 429 }); } };
  __setLiveSpendTestSeam({ eligible: true, providerFor: () => provider, deps: { policyDir: root, lowBalanceMailer: async () => {},
    readPolicy: async () => defaultSpendPolicyDoc(), observers: [() => world.states()], now: () => world.clock.now(),
    memory: createInMemoryGuardStore(), recordSignal: () => {} } });
  await expect(streamLLMWithTools([{ role: 'user', content: 'hello' }], { onText() {}, async dispatchTool() { return 'ok'; } },
    { provider, tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }] })).rejects.toBeInstanceOf(SpendPolicyStopError);
  // The policy loop allows eight retries after the first failed attempt (MAX_POLICY_QUOTA_RETRIES).
  expect(calls).toBe(9);
});

test('a policy-selected account cannot silently differ from an explicit Codex account', async () => {
  clearFakeEnv(); process.env.ELANOUS_CODEX_ACCOUNT = 'default';
  const root = mkdtempSync(join(tmpdir(), 'tool-spend-')); roots.push(root);
  const world = createLlmProviderWorld({ startIso: '2026-11-20T00:00:00Z', balanceUsd: 50 });
  world.codex.default.exhaust('five-hour', '2026-11-20T05:00:00Z');
  let calls = 0;
  const provider: LLMProvider = { name: 'openai-codex', defaultModel: 'gpt-6.2-sol', available: () => true, async *chat() {},
    async *streamChat() { calls++; yield { type: 'text', delta: 'unexpected' }; } };
  __setLiveSpendTestSeam({ eligible: true, providerFor: () => provider, deps: { policyDir: root, lowBalanceMailer: async () => {},
    readPolicy: async () => defaultSpendPolicyDoc(), observers: [() => world.states()], now: () => world.clock.now(), memory: createInMemoryGuardStore() } });
  await expect(streamLLMWithTools([{ role: 'user', content: 'hello' }], { onText() {}, async dispatchTool() { return 'ok'; } },
    { provider, tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }] })).rejects.toBeInstanceOf(SpendPolicyStopError);
  expect(calls).toBe(0);
});

test('concurrent gated streams keep their selected Codex accounts in separate async scopes', async () => {
  clearFakeEnv();
  const observed: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  const provider: LLMProvider = { name: 'openai-codex', defaultModel: 'model', available: () => true, async *chat() {},
    async *streamChat() { const first = effectiveCodexAccountName(); started++; if (started === 2) release(); await barrier;
      observed.push(`${first}:${effectiveCodexAccountName()}`); yield { type: 'text', delta: 'done' }; } };
  const make = (account: string) => {
    const handle = {} as LlmCallHandle;
    const selection: LlmCallGateResult = { outcome: 'go', row: `codex-${account}`, provider: 'openai-codex', model: 'model', reservation: null, ledgerLines: [], skipped: [], handle };
    return spendPolicyStream({ messages: [], opts: {}, original: provider, select: async () => selection, settle: async () => {},
      signalFromError: () => undefined, accountForRow: row => row.slice('codex-'.length), providerForName: () => provider, onSelected: () => {} });
  };
  const a = make('default'), b = make('team');
  await Promise.all([a.next(), b.next()]);
  await Promise.all([a.next(), b.next()]);
  expect(observed.sort()).toEqual(['default:default', 'team:team']);
  expect(process.env.ELANOUS_CODEX_ACCOUNT).toBeUndefined();
});

test('a gate-selected provider unavailable at dispatch releases its reservation and never falls back', async () => {
  clearFakeEnv();
  const root = mkdtempSync(join(tmpdir(), 'tool-spend-')); roots.push(root);
  const world = createLlmProviderWorld({ startIso: '2026-11-20T00:00:00Z', balanceUsd: 50 });
  const tags: string[] = []; let calls = 0;
  const provider: LLMProvider = { name: 'openai-codex', defaultModel: 'gpt-6.2-sol', available: () => true, async *chat() {},
    async *streamChat() { calls++; yield { type: 'text', delta: 'unexpected' }; } };
  __setLiveSpendTestSeam({ eligible: true, providerFor: () => undefined, deps: { policyDir: root, lowBalanceMailer: async () => {},
    readPolicy: async () => defaultSpendPolicyDoc(), observers: [() => world.states()], now: () => world.clock.now(),
    memory: createInMemoryGuardStore(), recordUsageTag: tag => { tags.push(`${tag.row}:${tag.status}`); } } });
  await expect(streamLLMWithTools([{ role: 'user', content: 'hello' }], { onText() {}, async dispatchTool() { return 'ok'; } },
    { provider, tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }] })).rejects.toBeInstanceOf(SpendPolicyStopError);
  expect(calls).toBe(0); expect(tags).toEqual(['codex-default:not-called']);
});

test('policy absence preserves the original quota failure behavior', async () => {
  clearFakeEnv();
  const root = mkdtempSync(join(tmpdir(), 'tool-spend-')); roots.push(root);
  let calls = 0;
  const provider: LLMProvider = { name: 'openai-codex', defaultModel: 'gpt-6.2-sol', available: () => true, async *chat() {},
    async *streamChat() { calls++; throw Object.assign(new Error('usage_limit_reached'), { status: 429 }); } };
  const run = async () => { try { await streamLLMWithTools([{ role: 'user', content: 'hello' }], { onText() {}, async dispatchTool() { return 'ok'; } },
    { provider, tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }] }); return 'success';
  } catch (error) { return error instanceof Error ? error.name : 'non-error'; } };
  __setLiveSpendTestSeam({ eligible: false });
  const baseline = await run(), baselineCalls = calls; calls = 0;
  __setLiveSpendTestSeam({ eligible: true, deps: { policyDir: root, lowBalanceMailer: async () => {}, readPolicy: async () => null,
    observers: [], now: () => new Date('2026-11-20T00:00:00Z'), memory: createInMemoryGuardStore() } });
  expect(await run()).toBe(baseline); expect(calls).toBe(baselineCalls);
});
