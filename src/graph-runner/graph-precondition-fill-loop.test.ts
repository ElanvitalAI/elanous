import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGraphRun, runGraph } from './runner.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration, dispatchGraphContract } from './capabilities.js';
import { graphRunEventLedgerPath, readGraphRunEvents } from './graph-run-event-ledger.js';
import { createGraphEventBus } from './graph-events.js';
import { prepareGraphPreconditions } from './graph-precondition.js';

function fixture(contract = 'demo.precondition@1') {
  const root = mkdtempSync(join(tmpdir(), 'graph-precondition-'));
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(graph, `graph_id: graph-precondition\nversion: 1\nentry_node: task\nterminal_nodes: [done]\nnodes:\n  - node_id: task\n    kind: capability\n    recipe: none\n    requires: ${contract}\n    max_visits: 1\n    input: {}\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: task, to: done }\n`);
  return { root, graph, stateRoot: join(root, 'state'), close: () => rmSync(root, { recursive: true, force: true }) };
}

test('empty node input is filled from verified host once and dispatched with that value', async () => {
  const files = fixture();
  let calls = 0;
  let received: unknown;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object', required: ['appSlug'],
      properties: { appSlug: { type: 'string' } } }, output: { type: 'object' },
  }), { id: 'demo-provider', provides: ['demo.precondition@1'], tier: 'free',
    requires: ['appSlug'], fill: { appSlug: ['host'] },
    invoke: context => { calls++; received = context.nodeInput; return { ok: true, outcome: 'done', result: { accepted: true } }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'host-filled', verifiedAppSlug: 'verified-app',
      input: { context: { appSlug: 'caller-forged' } }, quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(run.status).toBe('done');
    expect(calls).toBe(1);
    expect(received).toEqual({ appSlug: 'verified-app' });
    const events = readGraphRunEvents(graphRunEventLedgerPath(files.stateRoot, 'graph-precondition', run.runId));
    expect(events.filter(event => event.type === 'graph.precondition.fill')).toHaveLength(1);
    expect(events.find(event => event.type === 'graph.precondition.fill')?.data).toMatchObject({
      nodeId: 'task', missingKeys: ['appSlug'], source: 'host', attempt: 1,
    });
  } finally { files.close(); }
});

test('missing trusted source fails with key name before provider invoke and cannot take failure edge', async () => {
  const files = fixture();
  let calls = 0;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object', required: ['appSlug'],
      properties: { appSlug: { type: 'string' } } }, output: { type: 'object' },
  }), { id: 'demo-provider', provides: ['demo.precondition@1'], tier: 'free',
    requires: ['appSlug'], fill: { appSlug: ['host'] },
    invoke: () => { calls++; return { ok: true, outcome: 'done', result: {} }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'missing-host', quiet: true,
      input: { context: { appSlug: 'caller-forged' } },
      deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(run.status).toBe('failed');
    expect(run.path).toEqual(['task']);
    expect(calls).toBe(0);
    expect(run.reason).toContain('appSlug');
    expect(run.preconditionBarrier).toMatchObject({ nodeId: 'task', effectStatus: 'none' });
    const events = readGraphRunEvents(graphRunEventLedgerPath(files.stateRoot, 'graph-precondition', run.runId));
    expect(events.some(event => event.type === 'graph.precondition.blocked')).toBe(true);
    await expect(runGraph(files.graph, { resumeRunId: run.runId, quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry } })).rejects.toThrow('requires --from task');
    await expect(runGraph(files.graph, { resumeRunId: run.runId, fromNodeId: 'done', quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry } })).rejects.toThrow('requires --from task');
    const repaired = await runGraph(files.graph, { resumeRunId: run.runId, fromNodeId: 'task', quiet: true,
      verifiedAppSlug: 'verified-app', deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(repaired.status).toBe('done');
    expect(repaired.preconditionBarrier).toBeUndefined();
  } finally { files.close(); }
});

test('unavailable higher-tier providers do not fill or block the usable fallback', async () => {
  const files = fixture();
  const calls: string[] = [];
  let registry = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object' }, output: { type: 'object' },
  });
  registry = registerGraphCapabilityProviderDeclaration(registry, { id: 'missing-key',
    provides: ['demo.precondition@1'], tier: 'free', keyEnv: ['ELANOUS_PRECONDITION_TEST_KEY_ABSENT'],
    requires: ['query'], invoke: () => { calls.push('key'); return { ok: true, outcome: 'done', result: {} }; } });
  registry = registerGraphCapabilityProviderDeclaration(registry, { id: 'wrong-condition',
    provides: ['demo.precondition@1'], tier: 'free', conditions: { mode: 'other' },
    requires: ['query'], invoke: () => { calls.push('condition'); return { ok: true, outcome: 'done', result: {} }; } });
  registry = registerGraphCapabilityProviderDeclaration(registry, { id: 'usable-fallback',
    provides: ['demo.precondition@1'], tier: 'paid',
    invoke: () => { calls.push('fallback'); return { ok: true, outcome: 'done', result: {} }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'availability-fallback', quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(run.status).toBe('done');
    expect(calls).toEqual(['fallback']);
  } finally { files.close(); }
});

test('a provider latency guarantee starts after availability lookup', async () => {
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object' }, output: { type: 'object' },
    // Source: #37926 r1 mf3 — a 250 ms availability lookup precedes this 200 ms invocation budget.
    guarantees: { maxLatencyMs: 200 },
  }), { id: 'slow-lookup', provides: ['demo.precondition@1'], tier: 'free',
    available: async () => { await new Promise(resolve => setTimeout(resolve, 250)); return true; },
    invoke: () => ({ ok: true, outcome: 'done', result: {} }) });
  const result = await dispatchGraphContract('demo.precondition@1',
    { graphId: 'latency-clock', runId: 'run', nodeId: 'task', input: {}, outputs: {} }, registry);
  expect(result).toMatchObject({ ok: true, outcome: 'done' });
});

test('contract latency accumulates across failed provider invocations', async () => {
  const files = fixture();
  writeFileSync(files.graph, readFileSync(files.graph, 'utf8')
    .replace('- { from: task, to: done }', '- { from: task, on: outcome, map: { done: done } }'));
  let registry = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object' }, output: { type: 'object' },
    // Source: #37926 r2 mf1 — two 130 ms invocations must not both fit a 200 ms contract budget.
    guarantees: { maxLatencyMs: 200 },
  });
  let calls = 0;
  registry = registerGraphCapabilityProviderDeclaration(registry, { id: 'first',
    provides: ['demo.precondition@1'], tier: 'free',
    invoke: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 130));
      return { ok: false, outcome: 'failed', error: 'named-failure' }; } });
  registry = registerGraphCapabilityProviderDeclaration(registry, { id: 'second',
    provides: ['demo.precondition@1'], tier: 'paid',
    invoke: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 130));
      return { ok: true, outcome: 'done', result: {} }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'latency-cumulative', quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(calls).toBe(2);
    expect(run.status).toBe('failed');
    expect(run.path).toEqual(['task']);
    expect(run.nodes[0]?.output).toContain('latency-exceeded');
  } finally { files.close(); }
});

test('parent abort during invoke settles an otherwise unresolved effect without an invocation deadline', async () => {
  const parent = new AbortController();
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object' }, output: { type: 'object' },
  }), { id: 'effect', provides: ['demo.precondition@1'], tier: 'free',
    post: [{ when: { path: 'outcome', equals: 'pending' }, require: { path: 'outcome', equals: 'pending' } }],
    invoke: () => { parent.abort(); return new Promise(() => {}); } });
  const result = await Promise.race([
    dispatchGraphContract('demo.precondition@1',
      { graphId: 'abort-race', runId: 'run', nodeId: 'task', input: {}, outputs: {} }, registry,
      { signal: parent.signal }),
    new Promise<'unsettled'>(resolve => setTimeout(() => resolve('unsettled'), 100)),
  ]);
  expect(result).not.toBe('unsettled');
  expect(result).toMatchObject({ hardBarrier: true, effectStatus: 'unknown' });
});

test('appSlug cannot be filled from manifest, prior output, or ask-user without host binding', async () => {
  const provider = { id: 'app-binding', provides: ['demo.precondition@1'] as const, tier: 'free' as const,
    requires: ['appSlug'], fill: { appSlug: ['manifest', 'prior', 'ask_user'] as const },
    invoke: () => ({ ok: true, outcome: 'done', result: {} }),
  };
  const context = { graphId: 'app-binding', runId: 'run', nodeId: 'task', input: {}, nodeInput: {}, outputs: {} };
  const schema = { type: 'object', properties: { appSlug: { type: 'string' } } };
  const registered = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: schema, output: { type: 'object' },
  });
  expect(() => registerGraphCapabilityProviderDeclaration(registered, provider)).toThrow('invalid provider fill');
  let asks = 0;
  const prepared = await prepareGraphPreconditions(provider, context, schema, {
    manifestDefaults: { appSlug: 'forged' }, priorResults: [{ appSlug: 'forged' }],
    deadlineAtMs: Date.now() + 5000, askUser: async () => { asks++; return { appSlug: 'forged' }; },
  });
  expect(prepared).toMatchObject({ ok: false, missing: ['appSlug'] });
  expect(asks).toBe(0);
  const provided = await prepareGraphPreconditions({ ...provider, fill: { appSlug: ['host'] } },
    { ...context, nodeInput: { appSlug: 'forged' } }, schema,
    { appSlug: 'trusted', deadlineAtMs: Date.now() + 5000 });
  expect(provided).toMatchObject({ ok: false, reason: 'precondition-authority-binding-mismatch' });
});

test('ask-user synchronous parent abort is observed before an unresolved answer', async () => {
  const files = fixture();
  const parent = new AbortController();
  let calls = 0;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object', required: ['query'],
      properties: { query: { type: 'string' } } }, output: { type: 'object' },
  }), { id: 'ask-provider', provides: ['demo.precondition@1'], tier: 'free',
    requires: ['query'], fill: { query: ['ask_user'] },
    invoke: () => { calls++; return { ok: true, outcome: 'done', result: {} }; } });
  try {
    const run = await Promise.race([
      runGraph(files.graph, { runId: 'ask-sync-abort', quiet: true, signal: parent.signal,
        deps: { root: files.stateRoot, capabilityProviders: registry,
          askUserForPreconditions: () => { parent.abort(); return new Promise(() => {}); } } }),
      new Promise<'unsettled'>(resolve => setTimeout(() => resolve('unsettled'), 1000)),
    ]);
    expect(run).not.toBe('unsettled');
    if (run !== 'unsettled') expect(run.status).toBe('failed');
    expect(calls).toBe(0);
  } finally { parent.abort(); files.close(); }
});

test('prepopulated owner authority cannot bypass verified host binding', async () => {
  const files = fixture();
  writeFileSync(files.graph, readFileSync(files.graph, 'utf8').replace('input: {}', 'input: { ownerId: forged-owner }'));
  let calls = 0;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object', required: ['ownerId'],
      properties: { ownerId: { type: 'string' } } }, output: { type: 'object' },
  }), { id: 'owner-provider', provides: ['demo.precondition@1'], tier: 'free',
    requires: ['ownerId'], fill: { ownerId: ['host'] },
    invoke: () => { calls++; return { ok: true, outcome: 'done', result: {} }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'forged-owner', quiet: true, verifiedOwnerId: 'trusted-owner',
      deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(run.status).toBe('failed');
    expect(run.reason).toContain('precondition-authority-binding-mismatch');
    expect(calls).toBe(0);
  } finally { files.close(); }
});

test('requireOwner is filled as the verified owner ID and rejects a forged owner', async () => {
  const files = fixture();
  let calls = 0;
  let received: unknown;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object', required: ['requireOwner'],
      properties: { requireOwner: { type: 'string' } } }, output: { type: 'object' },
  }), { id: 'owner-provider', provides: ['demo.precondition@1'], tier: 'free',
    requires: ['requireOwner'], fill: { requireOwner: ['host'] },
    invoke: context => { calls++; received = context.nodeInput; return { ok: true, outcome: 'done', result: {} }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'required-owner', quiet: true, verifiedOwnerId: 'trusted-owner',
      deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(run.status).toBe('done');
    expect(received).toEqual({ requireOwner: 'trusted-owner' });
    writeFileSync(files.graph, readFileSync(files.graph, 'utf8').replace('input: {}', 'input: { requireOwner: forged-owner }'));
    const forged = await runGraph(files.graph, { runId: 'forged-required-owner', quiet: true,
      verifiedOwnerId: 'trusted-owner', deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(forged.status).toBe('failed');
    expect(forged.reason).toContain('precondition-authority-binding-mismatch');
    expect(calls).toBe(1);
  } finally { files.close(); }
});

test('optional ownerId input is rejected before provider invoke when it disagrees with host', async () => {
  const files = fixture();
  writeFileSync(files.graph, readFileSync(files.graph, 'utf8').replace('input: {}',
    'input: { appSlug: verified-app, ownerId: forged-owner }'));
  let calls = 0;
  let received: unknown;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object', required: ['appSlug'],
      properties: { appSlug: { type: 'string' }, ownerId: { type: 'string' } } }, output: { type: 'object' },
  }), { id: 'owner-provider', provides: ['demo.precondition@1'], tier: 'free',
    requires: ['appSlug'], fill: { appSlug: ['host'] },
    invoke: context => { calls++; received = context.nodeInput; return { ok: true, outcome: 'done', result: {} }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'forged-optional-owner', quiet: true,
      verifiedOwnerId: 'trusted-owner', verifiedAppSlug: 'verified-app',
      deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(run.status).toBe('failed');
    expect(run.reason).toContain('precondition-authority-binding-mismatch');
    expect(calls).toBe(0);
    const events = readGraphRunEvents(graphRunEventLedgerPath(files.stateRoot, 'graph-precondition', run.runId));
    expect(JSON.stringify(events)).not.toContain('forged-owner');
    const absent = await runGraph(files.graph, { runId: 'absent-optional-owner', quiet: true,
      verifiedAppSlug: 'verified-app', deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(absent.status).toBe('failed');
    expect(absent.reason).toContain('precondition-authority-binding-mismatch');
    expect(calls).toBe(0);
    writeFileSync(files.graph, readFileSync(files.graph, 'utf8').replace('ownerId: forged-owner', 'ownerId: trusted-owner'));
    const bound = await runGraph(files.graph, { runId: 'bound-optional-owner', quiet: true,
      verifiedOwnerId: 'trusted-owner', verifiedAppSlug: 'verified-app',
      deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(bound.status).toBe('done');
    expect(calls).toBe(1);
    expect(received).toEqual({ appSlug: 'verified-app', ownerId: 'trusted-owner' });
  } finally { files.close(); }
});

test('optional ownerId is checked even when an effect provider declares no required fields', async () => {
  const files = fixture();
  writeFileSync(files.graph, readFileSync(files.graph, 'utf8').replace('input: {}',
    'input: { ownerId: forged-owner }'));
  let calls = 0;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object', properties: {
      ownerId: { type: 'string' }, appSlug: { type: 'string' } } },
    output: { type: 'object' },
  }), { id: 'owner-effect', provides: ['demo.precondition@1'], tier: 'free',
    post: [{ when: { path: 'outcome', equals: 'pending' }, forbidNext: ['done'] }],
    invoke: () => { calls++; return { ok: true, outcome: 'done', result: {} }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'optional-no-requires', quiet: true,
      verifiedOwnerId: 'trusted-owner', deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(run.status).toBe('failed');
    expect(run.reason).toContain('precondition-authority-binding-mismatch');
    expect(calls).toBe(0);
    const events = readGraphRunEvents(graphRunEventLedgerPath(files.stateRoot, 'graph-precondition', run.runId));
    expect(JSON.stringify(events)).not.toContain('forged-owner');
    let plainCalls = 0;
    const plainRegistry = registerGraphCapabilityProviderDeclaration(
      registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
        id: 'demo.precondition@1', input: { type: 'object', properties: {
          ownerId: { type: 'string' }, appSlug: { type: 'string' } } }, output: { type: 'object' },
      }), { id: 'plain-provider', provides: ['demo.precondition@1'], tier: 'free',
        invoke: () => { plainCalls++; return { ok: true, outcome: 'done', result: {} }; } }),
      { id: 'other-declared-provider', provides: ['demo.precondition@1'], tier: 'paid',
        requires: ['appSlug'], fill: { appSlug: ['host'] },
        invoke: () => { plainCalls++; return { ok: true, outcome: 'done', result: {} }; } });
    const plain = await runGraph(files.graph, { runId: 'optional-other-declaration', quiet: true,
      verifiedOwnerId: 'trusted-owner', deps: { root: files.stateRoot, capabilityProviders: plainRegistry } });
    expect(plain.status).toBe('failed');
    expect(plain.reason).toContain('precondition-authority-binding-mismatch');
    expect(plainCalls).toBe(0);
  } finally { files.close(); }
});

test('pending receipt reported as done is blocked after invoke and cannot enter the next node', async () => {
  const files = fixture();
  let calls = 0;
  let fallbackCalls = 0;
  const first = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object' }, output: { type: 'object',
      properties: { status: { type: 'string' } } },
  }), { id: 'demo-effect', provides: ['demo.precondition@1'], tier: 'free',
    post: [{ when: { path: 'result.status', equals: 'pending' }, require: { path: 'outcome', equals: 'pending' } }],
    invoke: () => { calls++; return { ok: true, outcome: 'done', result: { status: 'pending' } }; } });
  const registry = registerGraphCapabilityProviderDeclaration(first, { id: 'fallback-provider',
    provides: ['demo.precondition@1'], tier: 'paid',
    invoke: () => { fallbackCalls++; return { ok: true, outcome: 'done', result: { status: 'approved' } }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'pending-blocked', quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(calls).toBe(1);
    expect(fallbackCalls).toBe(0);
    expect(run.status).toBe('failed');
    expect(run.path).toEqual(['task']);
    expect(run.reason).toContain('postcondition-violation');
    const events = readGraphRunEvents(graphRunEventLedgerPath(files.stateRoot, 'graph-precondition', run.runId));
    expect(events.some(event => event.type === 'graph.precondition.blocked')).toBe(true);
  } finally { files.close(); }
});

test('pending outcome cannot take a graph edge into done without approval', async () => {
  const files = fixture();
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object' }, output: { type: 'object',
      properties: { status: { type: 'string' } } },
  }), { id: 'demo-effect', provides: ['demo.precondition@1'], tier: 'free',
    post: [{ when: { path: 'outcome', equals: 'pending' }, forbidNext: ['done'] }],
    invoke: () => ({ ok: true, outcome: 'pending', result: { status: 'pending' } }) });
  try {
    const run = await runGraph(files.graph, { runId: 'pending-route-blocked', quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(run.status).toBe('failed');
    expect(run.path).toEqual(['task']);
    expect(run.reason).toContain('postcondition-forbidden-next: done');
    expect(run.preconditionBarrier).toMatchObject({ nodeId: 'task', effectStatus: 'unknown' });
    await expect(runGraph(files.graph, { resumeRunId: run.runId, quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry } })).rejects.toThrow('effect reconciliation required');
    await expect(runGraph(files.graph, { resumeRunId: run.runId, fromNodeId: 'task', quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry } })).rejects.toThrow('effect reconciliation required');
  } finally { files.close(); }
});

test('unknown effect barrier is durable before node-end observer finishes', async () => {
  const files = fixture();
  const bus = createGraphEventBus();
  let release = () => {};
  let reached = () => {};
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  bus.subscribe(async event => {
    if (event.source.nodeId === 'task') { reached(); await held; }
  }, { type: 'node-end' });
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object' }, output: { type: 'object' },
  }), { id: 'effect', provides: ['demo.precondition@1'], tier: 'free',
    post: [{ when: { path: 'outcome', equals: 'pending' }, forbidNext: ['done'] }],
    invoke: () => ({ ok: true, outcome: 'pending', result: {} }) });
  const running = runGraph(files.graph, { runId: 'durable-before-observer', eventBus: bus, quiet: true,
    deps: { root: files.stateRoot, capabilityProviders: registry } });
  try {
    await Promise.race([waiting, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('node-end observer not reached')), 2000))]);
    const saved = readGraphRun('graph-precondition', 'durable-before-observer', files.stateRoot);
    expect(saved.preconditionBarrier).toMatchObject({ nodeId: 'task', effectStatus: 'unknown' });
  } finally {
    release();
    const run = await running;
    expect(run.status).toBe('failed');
    files.close();
  }
});

test('effect intent is durable before invoke can finish and resume cannot duplicate it', async () => {
  const files = fixture();
  const parent = new AbortController();
  let started = () => {};
  const invoked = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object' }, output: { type: 'object' },
  }), { id: 'effect', provides: ['demo.precondition@1'], tier: 'free',
    post: [{ when: { path: 'outcome', equals: 'pending' }, forbidNext: ['done'] }],
    invoke: () => { calls++; started(); return new Promise(() => {}); } });
  const running = runGraph(files.graph, { runId: 'intent-before-invoke', quiet: true, signal: parent.signal,
    deps: { root: files.stateRoot, capabilityProviders: registry } });
  try {
    await Promise.race([invoked, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('provider was not invoked')), 2000))]);
    const saved = readGraphRun('graph-precondition', 'intent-before-invoke', files.stateRoot);
    expect(saved.preconditionBarrier).toMatchObject({ nodeId: 'task', reason: 'effect-invocation-unresolved', effectStatus: 'unknown' });
    await expect(runGraph(files.graph, { resumeRunId: saved.runId, fromNodeId: 'task', quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry } })).rejects.toThrow('effect reconciliation required');
    expect(calls).toBe(1);
  } finally {
    parent.abort();
    const run = await running;
    expect(run.status).toBe('failed');
    files.close();
  }
});

test('post route names must bind to declared graph nodes before an effect runs', async () => {
  const files = fixture();
  let calls = 0;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object' }, output: { type: 'object' },
  }), { id: 'demo-effect', provides: ['demo.precondition@1'], tier: 'free',
    post: [{ when: { path: 'outcome', equals: 'pending' }, forbidNext: ['ghost'] }],
    invoke: () => { calls++; return { ok: true, outcome: 'pending', result: {} }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'unbound-post', quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(run.status).toBe('failed');
    expect(run.path).toEqual(['task']);
    expect(run.reason).toContain('postcondition-unknown-node');
    expect(calls).toBe(0);
  } finally { files.close(); }
});

test('pending approval can continue to poll and reaches done only after approved result', async () => {
  const files = fixture();
  writeFileSync(files.graph, `graph_id: graph-precondition\nversion: 1\nentry_node: start\nterminal_nodes: [done]\nnodes:\n  - { node_id: start, kind: capability, recipe: none, requires: demo.precondition@1, max_visits: 1, input: {} }\n  - { node_id: poll, kind: capability, recipe: none, requires: demo.precondition@1, max_visits: 1, input: {} }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: start, on: outcome, map: { pending: poll, done: done } }\n  - { from: poll, to: done }\n`);
  let calls = 0;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object' }, output: { type: 'object',
      properties: { status: { type: 'string' } } },
  }), { id: 'demo-effect', provides: ['demo.precondition@1'], tier: 'free',
    post: [
      { when: { path: 'result.status', equals: 'pending' }, require: { path: 'outcome', equals: 'pending' } },
      { when: { path: 'outcome', equals: 'pending' }, forbidNext: ['done'] },
    ], invoke: context => { calls++; return context.nodeId === 'start'
      ? { ok: true, outcome: 'pending', result: { status: 'pending' } }
      : { ok: true, outcome: 'done', result: { status: 'approved' } }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'pending-poll-approved', quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(run.status).toBe('done');
    expect(run.path).toEqual(['start', 'poll', 'done']);
    expect(calls).toBe(2);
    expect(run.preconditionBarrier).toBeUndefined();
  } finally { files.close(); }
});

test('expired parent deadline stops ask-user and provider before dispatch', async () => {
  const files = fixture();
  let asks = 0;
  let calls = 0;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object', required: ['query'],
      properties: { query: { type: 'string' } } }, output: { type: 'object' },
  }), { id: 'demo-provider', provides: ['demo.precondition@1'], tier: 'free',
    requires: ['query'], fill: { query: ['ask_user'] },
    invoke: () => { calls++; return { ok: true, outcome: 'done', result: {} }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'expired-parent', quiet: true,
      preconditionDeadlineAtMs: Date.now() - 1,
      deps: { root: files.stateRoot, capabilityProviders: registry,
        askUserForPreconditions: async () => { asks++; return { query: 'unauthorized-late-answer' }; } } });
    expect(run.status).toBe('failed');
    expect(run.path).toEqual(['task']);
    expect(asks).toBe(0);
    expect(calls).toBe(0);
  } finally { files.close(); }
});

test('ask-user supplies only a typed data key through the real graph dispatch', async () => {
  const files = fixture();
  let received: unknown;
  let asks = 0;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object', required: ['query'],
      properties: { query: { type: 'string' } } }, output: { type: 'object' },
  }), { id: 'demo-provider', provides: ['demo.precondition@1'], tier: 'free',
    requires: ['query'], fill: { query: ['ask_user'] },
    invoke: context => { received = context.nodeInput; return { ok: true, outcome: 'done', result: {} }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'ask-data', quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry,
        askUserForPreconditions: async ({ missingKeys }) => {
          asks++; expect(missingKeys).toEqual(['query']); return { query: 'verified-response' };
        } } });
    expect(run.status).toBe('done');
    expect(asks).toBe(1);
    expect(received).toEqual({ query: 'verified-response' });
  } finally { files.close(); }
});

test('ask-user failure is explicit and cannot invoke a provider', async () => {
  const files = fixture();
  let calls = 0;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object', required: ['query'],
      properties: { query: { type: 'string' } } }, output: { type: 'object' },
  }), { id: 'demo-provider', provides: ['demo.precondition@1'], tier: 'free',
    requires: ['query'], fill: { query: ['ask_user'] },
    invoke: () => { calls++; return { ok: true, outcome: 'done', result: {} }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'ask-failed', quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry,
        askUserForPreconditions: async () => { throw new Error('host UI unavailable'); } } });
    expect(run.status).toBe('failed');
    expect(run.reason).toContain('precondition-ask-failed');
    expect(calls).toBe(0);
  } finally { files.close(); }
});

test('provider availability failure is explicit before any effect', async () => {
  const files = fixture();
  let calls = 0;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object' }, output: { type: 'object' },
  }), { id: 'demo-provider', provides: ['demo.precondition@1'], tier: 'free',
    requires: ['query'], available: async () => { throw new Error('owner lookup failed'); },
    invoke: () => { calls++; return { ok: true, outcome: 'done', result: {} }; } });
  try {
    const run = await runGraph(files.graph, { runId: 'availability-failed', quiet: true,
      deps: { root: files.stateRoot, capabilityProviders: registry } });
    expect(run.status).toBe('failed');
    expect(run.reason).toContain('precondition-availability-failed');
    expect(calls).toBe(0);
  } finally { files.close(); }
});

test('validated manifest default wins before prior result and ask-user', async () => {
  let asks = 0;
  const provider = { id: 'demo-provider', provides: ['demo.precondition@1'] as const, tier: 'free' as const,
    requires: ['query'], fill: { query: ['manifest', 'prior', 'ask_user'] as const },
    invoke: () => ({ ok: true, outcome: 'done', result: {} }),
  };
  const prepared = await prepareGraphPreconditions(provider,
    { graphId: 'graph-precondition', runId: 'source-order', nodeId: 'task', input: {}, nodeInput: {}, outputs: {} },
    { type: 'object', properties: { query: { type: 'string' } } }, {
      manifestDefaults: { query: 'manifest-value' }, priorResults: [{ query: 'prior-value' }],
      deadlineAtMs: Date.now() + 5000,
      askUser: async () => { asks++; return { query: 'ask-value' }; },
    });
  expect(prepared.ok).toBe(true);
  if (prepared.ok) expect(prepared.context.nodeInput).toEqual({ query: 'manifest-value' });
  expect(asks).toBe(0);
});

test('expired parent deadline is inherited by a child unit before its provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-precondition-unit-'));
  const unitDir = join(root, 'units'); mkdirSync(unitDir);
  const graph = join(root, 'graph.yaml');
  const stateRoot = join(root, 'state');
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(join(unitDir, 'recipes.yaml'), '{}\n');
  writeFileSync(graph, `graph_id: precondition-parent\nversion: 1\nentry_node: invoke\nterminal_nodes: [done, failed]\nnodes:\n  - node_id: invoke\n    kind: subgraph\n    recipe: none\n    max_visits: 1\n    call: worker@1\n    budget: { inner_steps: 4 }\n    contract: { inputs: [request], tools: read-only, outputs: [answer] }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: invoke, on: outcome, map: { done: done, failed: failed } }\n`);
  writeFileSync(join(unitDir, 'worker.yaml'), `graph_id: worker\nversion: 1\nunit: { inputs: [request], outputs: [answer], exits: [done, failed] }\nentry_node: task\nterminal_nodes: [done, failed]\nnodes:\n  - node_id: task\n    kind: capability\n    recipe: none\n    requires: demo.precondition@1\n    max_visits: 1\n    input: {}\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: task, to: done }\n`);
  let calls = 0;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object', required: ['appSlug'],
      properties: { appSlug: { type: 'string' } } }, output: { type: 'object' },
  }), { id: 'demo-provider', provides: ['demo.precondition@1'], tier: 'free',
    requires: ['appSlug'], fill: { appSlug: ['host'] },
    invoke: () => { calls++; return { ok: true, outcome: 'done', result: { answer: 'ok' } }; } });
  try {
    const parent = await runGraph(graph, { runId: 'expired-unit', input: { request: 'go' }, quiet: true,
      verifiedAppSlug: 'verified-app', preconditionDeadlineAtMs: Date.now() - 1,
      deps: { root: stateRoot, capabilityProviders: registry } });
    expect(calls).toBe(0);
    const childId = parent.unitCalls?.[0]?.childRunId;
    expect(childId).toBeTruthy();
    const child = readGraphRun('worker', childId!, stateRoot);
    expect(child.status).toBe('failed');
    expect(child.reason).toContain('precondition-deadline');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('expired parent deadline is inherited by both fan-out branch runs', async () => {
  const files = fixture();
  writeFileSync(files.graph, `graph_id: graph-precondition\nversion: 1\nentry_node: start\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: start, kind: agent, recipe: 'handler:start', max_visits: 1 }\n  - { node_id: a, kind: capability, recipe: none, requires: demo.precondition@1, max_visits: 1, input: {}, needs: [start] }\n  - { node_id: b, kind: capability, recipe: none, requires: demo.precondition@1, max_visits: 1, input: {}, needs: [start] }\n  - { node_id: joined, kind: gate, recipe: none, max_visits: 1, needs: [a, b] }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: start, on: outcome, branches: { ok: [a, b] }, join: joined }\n  - { from: joined, on: outcome, map: { ok: done, fail: failed } }\n`);
  let calls = 0;
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object', required: ['appSlug'],
      properties: { appSlug: { type: 'string' } } }, output: { type: 'object' },
  }), { id: 'demo-provider', provides: ['demo.precondition@1'], tier: 'free',
    requires: ['appSlug'], fill: { appSlug: ['host'] },
    invoke: () => { calls++; return { ok: true, outcome: 'done', result: {} }; } });
  try {
    const parent = await runGraph(files.graph, { runId: 'expired-fanout', quiet: true,
      verifiedAppSlug: 'verified-app', preconditionDeadlineAtMs: Date.now() - 1,
      deps: { root: files.stateRoot, capabilityProviders: registry,
        inProcessHandlers: { start: () => ({ ok: true, outcome: 'ok' }) } } });
    expect(calls).toBe(0);
    const branches = Object.values(parent.fanOuts ?? {}).flatMap(fanout => Object.values(fanout.branches));
    expect(branches).toHaveLength(2);
    expect(branches.every(branch => branch.status === 'failed')).toBe(true);
    for (const branch of branches) {
      const child = readGraphRun('graph-precondition', branch.runId, files.stateRoot);
      expect(child.status).toBe('failed');
      expect(child.reason).toContain('precondition-deadline');
    }
  } finally { files.close(); }
});
