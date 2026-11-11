import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from './runner.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { lowerGraphV2 } from '../graph-v2/lower.js';
import { createGraphEventBus } from './graph-events.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration } from './capabilities.js';

const source = `graph_id: secret-binding-sim
version: 1
entry_node: action
terminal_nodes: [done, failed]
nodes:
  - node_id: action
    kind: agent
    recipe: cmd:action
    max_visits: 1
    secrets: { API_TOKEN: demo.api }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: action, on: outcome, map: { ok: done, fail: failed } }
`;

test('simulation: graph binds a declared secret name for one node and never persists its value', async () => {
  const parsed = parseGraphTemplateYaml(source, 'secret-binding-sim');
  expect(parsed.errors).toEqual([]);
  expect(parsed.template?.nodes.find(node => node.nodeId === 'action')?.secrets)
    .toEqual({ API_TOKEN: 'demo.api' });

  const dir = mkdtempSync(join(tmpdir(), 'graph-secret-binding-sim-'));
  try {
    const graphPath = join(dir, 'graph.yaml');
    const stateRoot = join(dir, 'state');
    writeFileSync(graphPath, source);
    writeFileSync(join(dir, 'recipes.yaml'), 'action:\n  command: "printf safe"\n');
    const secret = 'quote"line\nslash\\value-DO-NOT-PERSIST';
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const options = {
      runId: 'secret-binding-run',
      deps: {
        root: stateRoot,
        resolveGraphSecret: async (name: string) => name === 'demo.api' ? secret : undefined,
        runBash: async (_command: string, opts: { env?: NodeJS.ProcessEnv }) => {
          receivedEnv = opts.env;
          return { stdout: JSON.stringify({ outcome: 'ok', echoed: secret }), stderr: '', exitCode: 0 };
        },
      },
    } as unknown as NonNullable<Parameters<typeof runGraph>[1]>;

    const result = await runGraph(graphPath, options);
    const stateText = readFileSync(result.statePath, 'utf8');
    const state = JSON.parse(stateText) as { nodes: Array<{ nodeId: string; output?: unknown }> };
    const actionOutput = JSON.parse(String(state.nodes.find(node => node.nodeId === 'action')?.output)) as Record<string, unknown>;
    expect(result.status).toBe('done');
    expect(receivedEnv?.API_TOKEN).toBe(secret);
    expect(stateText).not.toContain(secret);
    expect(actionOutput).toMatchObject({ echoed: '[REDACTED]', outcome: 'ok' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simulation: command JSON redaction preserves structure and unmasked outcome routing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-secret-json-quote-sim-'));
  try {
    const graphPath = join(dir, 'graph.yaml');
    writeFileSync(graphPath, source);
    writeFileSync(join(dir, 'recipes.yaml'), 'action:\n  command: "printf safe"\n');
    for (const [index, secret] of ['"', 'ok', 'REDACTED', 'foo\nbar'].entries()) {
      let receivedSecret: string | undefined;
      const result = await runGraph(graphPath, { runId: `secret-json-quote-run-${index}`, deps: {
        root: join(dir, `state-${index}`),
        resolveGraphSecret: async () => secret,
        runBash: async (_command, options) => {
          receivedSecret = options.env?.API_TOKEN;
          return { stdout: `command log ${secret}\n${JSON.stringify({ outcome: 'ok', echoed: secret })}\n`, stderr: '', exitCode: 0 };
        },
      } });
      const stateText = readFileSync(result.statePath, 'utf8');
      const state = JSON.parse(stateText) as { status: string; path: string[]; nodes: Array<{ nodeId: string; output?: unknown; resumeNextNode?: string; commandNextNode?: string }> };
      const actionText = String(state.nodes.find(node => node.nodeId === 'action')?.output);
      const actionJson = actionText.split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? '';
      const actionOutput = JSON.parse(actionJson) as Record<string, unknown>;
      expect(result.status).toBe('done');
      expect(receivedSecret).toBe(secret);
      expect(actionOutput.echoed).not.toBe(secret);
      expect(actionOutput.outcome).not.toBe(secret);
      if (secret !== '"') expect(JSON.stringify(actionOutput)).not.toContain(secret);

      if (secret === 'ok') {
        expect(state.nodes.find(node => node.nodeId === 'action')?.resumeNextNode).toBe('done');
        state.status = 'running';
        state.path = ['action'];
        state.nodes = state.nodes.filter(node => node.nodeId === 'action');
        if (state.nodes[0]) {
          delete state.nodes[0].resumeNextNode;
          state.nodes[0].commandNextNode = 'done';
        }
        writeFileSync(result.statePath, `${JSON.stringify(state, null, 2)}\n`);
        const legacyFieldResume = await runGraph(graphPath, { resumeRunId: result.runId, deps: {
          root: join(dir, `state-${index}`), resolveGraphSecret: async () => 'rotated-secret',
          runBash: async () => { throw new Error('completed command must not be dispatched again'); },
        } });
        expect(legacyFieldResume.status).toBe('done');

        const interrupted = JSON.parse(readFileSync(result.statePath, 'utf8')) as typeof state;
        interrupted.status = 'running';
        interrupted.path = ['action'];
        interrupted.nodes = interrupted.nodes.filter(node => node.nodeId === 'action');
        if (interrupted.nodes[0]) {
          delete interrupted.nodes[0].resumeNextNode;
          delete interrupted.nodes[0].commandNextNode;
        }
        writeFileSync(result.statePath, `${JSON.stringify(interrupted, null, 2)}\n`);
        const recoveredLegacy = await runGraph(graphPath, { resumeRunId: result.runId, deps: {
          root: join(dir, `state-${index}`), resolveGraphSecret: async () => secret,
          runBash: async () => { throw new Error('completed command must not be dispatched again'); },
        } });
        expect(recoveredLegacy.status).toBe('done');
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simulation: graph.yaml v2 lowering preserves declared secret-name bindings', () => {
  const lowered = lowerGraphV2(`apiVersion: elanous.dev/graph/v2
graph: { id: secret-binding-v2-sim, version: 1.0.0, layer: flow, purpose: Bind a declared credential }
entry: read
nodes:
  - { id: read, type: store, requires: store.read@1, secrets: { API_TOKEN: demo.api } }
edges:
  - { from: read, to: done }
terminal: [done]
`, { label: 'secret-binding-v2-sim' });
  expect(lowered.errors).toEqual([]);
  expect(lowered.template?.nodes.find(node => node.nodeId === 'read')?.secrets).toEqual({ API_TOKEN: 'demo.api' });
});

test('simulation: capability provider receives a declared secret binding and its result is redacted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-secret-capability-sim-'));
  try {
    const graphPath = join(dir, 'graph.yaml');
    writeFileSync(graphPath, `graph_id: secret-capability-sim
version: 1
entry_node: read
terminal_nodes: [done, failed]
nodes:
  - node_id: read
    kind: capability
    recipe: none
    requires: store.read@1
    input: {}
    max_visits: 1
    secrets: { API_TOKEN: demo.api }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: read, on: outcome, map: { ok: done, fail: failed } }
`);
    writeFileSync(join(dir, 'recipes.yaml'), '{}\n');
    const secret = 'capability-secret-"quoted"\nslash\\value';
    let receivedSecret: string | undefined;
    const contract = { id: 'store.read@1', input: { type: 'object' }, output: { type: 'object' } } as const;
    const capabilityProviders = registerGraphCapabilityProviderDeclaration(
      registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), contract), {
        id: 'fake-store', provides: ['store.read@1'], tier: 'free',
        invoke: ({ secrets }) => {
          receivedSecret = secrets?.API_TOKEN;
          return { ok: true, outcome: 'ok', result: { echoed: secret } };
        },
      });
    const result = await runGraph(graphPath, { runId: 'secret-capability-run', deps: {
      root: join(dir, 'state'), resolveGraphSecret: async () => secret, capabilityProviders,
    } });
    const stateText = readFileSync(result.statePath, 'utf8');
    const state = JSON.parse(stateText) as { nodes: Array<{ nodeId: string; output?: unknown }> };
    const readOutput = JSON.parse(String(state.nodes.find(node => node.nodeId === 'read')?.output)) as Record<string, unknown>;
    expect(result.status).toBe('done');
    expect(receivedSecret).toBe(secret);
    expect(stateText).not.toContain(secret);
    expect(readOutput).toMatchObject({ result: { echoed: '[REDACTED]' }, outcome: 'ok' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simulation: unresolved declared secret fails closed before node dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-secret-binding-missing-sim-'));
  try {
    const graphPath = join(dir, 'graph.yaml');
    writeFileSync(graphPath, source);
    writeFileSync(join(dir, 'recipes.yaml'), 'action:\n  command: "printf safe"\n');
    let dispatched = false;
    const options = {
      runId: 'missing-secret-run',
      deps: {
        root: join(dir, 'state'),
        resolveGraphSecret: async () => undefined,
        runBash: async () => { dispatched = true; return { stdout: '', stderr: '', exitCode: 0 }; },
      },
    } as unknown as NonNullable<Parameters<typeof runGraph>[1]>;

    const result = await runGraph(graphPath, options);
    expect(result.status).toBe('failed');
    expect(dispatched).toBe(false);
    expect(JSON.stringify(result)).not.toContain('demo.api');

    writeFileSync(join(dir, 'recipes.yaml'), 'action:\n  command: "printf production"\n  dry_run_command: "printf preview"\n');
    dispatched = false;
    const dryRun = await runGraph(graphPath, {
      runId: 'missing-dry-run-secret-run',
      dryRun: true,
      deps: {
        root: join(dir, 'dry-run-state'),
        resolveGraphSecret: async () => undefined,
        runBash: async () => { dispatched = true; return { stdout: '', stderr: '', exitCode: 0 }; },
      },
    });
    expect(dryRun.status).toBe('failed');
    expect(dispatched).toBe(false);
    expect(JSON.stringify(dryRun)).not.toContain('demo.api');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simulation: secret names cannot replace runner control environment variables', () => {
  const parsed = parseGraphTemplateYaml(source.replace('API_TOKEN: demo.api', 'PATH: demo.api'), 'reserved-secret-env-sim');
  expect(parsed.errors.some(error => error.message.includes('유효한 환경 변수 이름'))).toBe(true);
});

test('simulation: unsupported node kinds cannot silently ignore secret declarations', () => {
  const parsed = parseGraphTemplateYaml(source.replace('kind: agent', 'kind: gate').replace('recipe: cmd:action', 'recipe: none'),
    'unsupported-secret-node-sim');
  expect(parsed.errors.some(error => error.message.includes('cmd·handler·capability'))).toBe(true);
});

test('simulation: in-process graph handlers receive node-scoped secrets and redact returned values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-secret-handler-sim-'));
  try {
    const graphPath = join(dir, 'graph.yaml');
    writeFileSync(graphPath, source.replace('recipe: cmd:action', 'recipe: handler:action')
      .replace('secrets: { API_TOKEN: demo.api }', 'secrets: { API_TOKEN: demo.api }\n    emits: [secret.binding]'));
    writeFileSync(join(dir, 'recipes.yaml'), '{}\n');
    const secret = 'handler"quoted\nslash\\secret-NEVER-STORE';
    let receivedSecret: string | undefined;
    const events: Array<{ type?: string; data?: Record<string, unknown> }> = [];
    const eventBus = createGraphEventBus();
    eventBus.registerType('secret.binding');
    eventBus.subscribe(event => { events.push(event); });
    const options = {
      runId: 'secret-handler-run',
      eventBus,
      deps: {
        root: join(dir, 'state'),
        resolveGraphSecret: async () => secret,
        inProcessHandlers: { action: async (context: {
          secrets?: Readonly<Record<string, string>>;
          emitEvent?: (type: string, data?: Readonly<Record<string, unknown>>) => Promise<unknown>;
        }) => {
          receivedSecret = context.secrets?.API_TOKEN;
          await context.emitEvent?.('secret.binding', { secret });
          return { ok: true, outcome: 'ok', result: { echoed: secret, serialized: {
            toJSON: () => ({ echoed: secret, at: new Date('2026-11-10T00:00:00.000Z') }),
          } } };
        } },
      },
    } as unknown as NonNullable<Parameters<typeof runGraph>[1]>;
    const result = await runGraph(graphPath, options);
    const stateText = readFileSync(result.statePath, 'utf8');
    const state = JSON.parse(stateText) as { nodes: Array<{ nodeId: string; output?: unknown }> };
    const actionOutput = JSON.parse(String(state.nodes.find(node => node.nodeId === 'action')?.output)) as Record<string, unknown>;
    expect(result.status).toBe('done');
    expect(receivedSecret).toBe(secret);
    expect(stateText).not.toContain(secret);
    expect(actionOutput).toMatchObject({ result: { echoed: '[REDACTED]', serialized: {
      echoed: '[REDACTED]', at: '2026-11-10T00:00:00.000Z',
    } }, outcome: 'ok' });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events.find(event => event.type === 'secret.binding')?.data).toMatchObject({ secret: '[REDACTED]' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simulation: handler outcome secret routes with the raw value while public result stays redacted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-secret-outcome-route-sim-'));
  try {
    const graphPath = join(dir, 'graph.yaml');
    writeFileSync(graphPath, source.replace('recipe: cmd:action', 'recipe: handler:action'));
    writeFileSync(join(dir, 'recipes.yaml'), '{}\n');
    const result = await runGraph(graphPath, { runId: 'secret-outcome-route', deps: {
      root: join(dir, 'state'), resolveGraphSecret: async () => 'ok',
      inProcessHandlers: { action: async () => ({ ok: true, outcome: 'ok', result: { safe: true } }) },
    } });
    const stateText = readFileSync(result.statePath, 'utf8');
    const state = JSON.parse(stateText) as { status: string; path: string[]; nodes: Array<{ nodeId: string; output?: unknown; resumeNextNode?: string }> };
    const action = state.nodes.find(node => node.nodeId === 'action');
    expect(result.status).toBe('done');
    expect(result.path).toEqual(['action', 'done']);
    expect(String(action?.output)).toContain('[REDACTED]');
    expect(action?.resumeNextNode).toBe('done');
    expect(stateText).not.toContain('"outcome":"ok"');
    state.status = 'running';
    state.path = ['action'];
    state.nodes = state.nodes.filter(node => node.nodeId === 'action');
    if (state.nodes[0]) delete state.nodes[0].resumeNextNode;
    writeFileSync(result.statePath, `${JSON.stringify(state, null, 2)}\n`);
    const resumedLegacyHandler = await runGraph(graphPath, { resumeRunId: result.runId, deps: {
      root: join(dir, 'state'), resolveGraphSecret: async () => 'ok',
      inProcessHandlers: { action: async () => { throw new Error('completed handler must not be dispatched again'); } },
    } });
    expect(resumedLegacyHandler.status).toBe('done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simulation: legacy capability resume routes using a recovered secret outcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-secret-capability-resume-sim-'));
  try {
    const graphPath = join(dir, 'graph.yaml');
    writeFileSync(graphPath, `graph_id: secret-capability-resume-sim
version: 1
entry_node: read
terminal_nodes: [done, failed]
nodes:
  - node_id: read
    kind: capability
    recipe: none
    requires: store.read@1
    input: {}
    max_visits: 1
    secrets: { API_TOKEN: demo.api }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: read, on: outcome, map: { ok: done, fail: failed } }
`);
    writeFileSync(join(dir, 'recipes.yaml'), '{}\n');
    const contract = { id: 'store.read@1', input: { type: 'object' }, output: { type: 'object' } } as const;
    const capabilityProviders = registerGraphCapabilityProviderDeclaration(
      registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), contract), {
        id: 'fake-store', provides: ['store.read@1'], tier: 'free',
        invoke: () => ({ ok: true, outcome: 'ok', result: { safe: true } }),
      });
    const result = await runGraph(graphPath, { runId: 'secret-capability-resume', deps: {
      root: join(dir, 'state'), resolveGraphSecret: async () => 'ok', capabilityProviders,
    } });
    expect(result.status).toBe('done');
    const state = JSON.parse(readFileSync(result.statePath, 'utf8')) as {
      status: string; path: string[]; nodes: Array<{ nodeId: string; resumeNextNode?: string }>;
    };
    expect(state.nodes.find(node => node.nodeId === 'read')?.resumeNextNode).toBe('done');
    state.status = 'running';
    state.path = ['read'];
    state.nodes = state.nodes.filter(node => node.nodeId === 'read');
    if (state.nodes[0]) delete state.nodes[0].resumeNextNode;
    writeFileSync(result.statePath, `${JSON.stringify(state, null, 2)}\n`);
    const resumed = await runGraph(graphPath, { resumeRunId: result.runId, deps: {
      root: join(dir, 'state'), resolveGraphSecret: async () => 'ok',
      capabilityProviders: registerGraphCapabilityProviderDeclaration(
        registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), contract), {
          id: 'fake-store', provides: ['store.read@1'], tier: 'free',
          invoke: () => { throw new Error('completed capability must not be invoked again'); },
        }),
    } });
    expect(resumed.status).toBe('done');
    expect(resumed.path).toEqual(['read', 'done']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simulation: legacy partial-secret outcome recovers its declared route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-secret-partial-route-sim-'));
  try {
    const graphPath = join(dir, 'graph.yaml');
    writeFileSync(graphPath, source.replace('map: { ok: done, fail: failed }', 'map: { token-ok: done, fail: failed }'));
    writeFileSync(join(dir, 'recipes.yaml'), 'action:\n  command: "printf safe"\n');
    const first = await runGraph(graphPath, { runId: 'secret-partial-route', deps: {
      root: join(dir, 'state'), resolveGraphSecret: async () => 'ok',
      runBash: async () => ({ stdout: '{"outcome":"token-ok"}\n', stderr: '', exitCode: 0 }),
    } });
    expect(first.status).toBe('done');
    expect(first.path).toEqual(['action', 'done']);
    const state = JSON.parse(readFileSync(first.statePath, 'utf8')) as {
      status: string; path: string[]; nodes: Array<{ nodeId: string; resumeNextNode?: string; commandNextNode?: string }>;
    };
    state.status = 'running';
    state.path = ['action'];
    state.nodes = state.nodes.filter(node => node.nodeId === 'action');
    if (state.nodes[0]) {
      delete state.nodes[0].resumeNextNode;
      delete state.nodes[0].commandNextNode;
    }
    writeFileSync(first.statePath, `${JSON.stringify(state, null, 2)}\n`);
    const resumed = await runGraph(graphPath, { resumeRunId: first.runId, deps: {
      root: join(dir, 'state'), resolveGraphSecret: async () => 'ok',
      runBash: async () => { throw new Error('completed command must not be dispatched again'); },
    } });
    expect(resumed.status).toBe('done');
    expect(resumed.path).toEqual(['action', 'done']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simulation: ambiguous redacted legacy outcome fails closed on resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-secret-ambiguous-route-sim-'));
  try {
    const graphPath = join(dir, 'graph.yaml');
    const graph = source.replace('secrets: { API_TOKEN: demo.api }', 'secrets: { API_TOKEN: demo.api, OTHER_TOKEN: demo.other }')
      .replace('map: { ok: done, fail: failed }', 'map: { ok: done, re: failed }');
    writeFileSync(graphPath, graph);
    writeFileSync(join(dir, 'recipes.yaml'), 'action:\n  command: "printf safe"\n');
    const first = await runGraph(graphPath, { runId: 'secret-ambiguous-route', deps: {
      root: join(dir, 'state'), resolveGraphSecret: async name => name === 'demo.api' ? 'ok' : 're',
      runBash: async () => ({ stdout: '{"outcome":"ok"}\n', stderr: '', exitCode: 0 }),
    } });
    const state = JSON.parse(readFileSync(first.statePath, 'utf8')) as {
      status: string; path: string[]; nodes: Array<{ nodeId: string; resumeNextNode?: string; commandNextNode?: string }>;
    };
    state.status = 'running';
    state.path = ['action'];
    state.nodes = state.nodes.filter(node => node.nodeId === 'action');
    if (state.nodes[0]) {
      delete state.nodes[0].resumeNextNode;
      delete state.nodes[0].commandNextNode;
    }
    writeFileSync(first.statePath, `${JSON.stringify(state, null, 2)}\n`);
    await expect(runGraph(graphPath, { resumeRunId: first.runId, deps: {
      root: join(dir, 'state'), resolveGraphSecret: async name => name === 'demo.api' ? 'ok' : 're',
      runBash: async () => { throw new Error('completed command must not be dispatched again'); },
    } })).rejects.toThrow('secret-redacted outcome cannot be safely recovered for resume routing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simulation: legacy marker literals stay valid and unmasked outcomes do not re-resolve secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-secret-marker-compat-sim-'));
  try {
    const graphPath = join(dir, 'graph.yaml');
    const graph = source.replace('secrets: { API_TOKEN: demo.api }', '')
      .replace('map: { ok: done, fail: failed }', "map: { '[REDACTED]': done, fail: failed }");
    writeFileSync(graphPath, graph);
    writeFileSync(join(dir, 'recipes.yaml'), 'action:\n  command: "printf safe"\n');
    const first = await runGraph(graphPath, { runId: 'literal-redaction-route', deps: {
      root: join(dir, 'state'),
      runBash: async () => ({ stdout: '{"outcome":"[REDACTED]"}\n', stderr: '', exitCode: 0 }),
    } });
    expect(first.status).toBe('done');
    const state = JSON.parse(readFileSync(first.statePath, 'utf8')) as {
      status: string; path: string[]; nodes: Array<{ nodeId: string; resumeNextNode?: string; commandNextNode?: string }>;
    };
    state.status = 'running';
    state.path = ['action'];
    state.nodes = state.nodes.filter(node => node.nodeId === 'action');
    if (state.nodes[0]) {
      delete state.nodes[0].resumeNextNode;
      delete state.nodes[0].commandNextNode;
    }
    writeFileSync(first.statePath, `${JSON.stringify(state, null, 2)}\n`);
    const resumed = await runGraph(graphPath, { resumeRunId: first.runId, deps: {
      root: join(dir, 'state'), resolveGraphSecret: async () => { throw new Error('secret-free legacy route must not query credentials'); },
      runBash: async () => { throw new Error('completed command must not be dispatched again'); },
    } });
    expect(resumed.status).toBe('done');
    expect(resumed.path).toEqual(['action', 'done']);

    const unmaskedGraphPath = join(dir, 'unmasked-graph.yaml');
    writeFileSync(unmaskedGraphPath, source);
    writeFileSync(join(dir, 'recipes.yaml'), 'action:\n  command: "printf safe"\n');
    const unmasked = await runGraph(unmaskedGraphPath, { runId: 'unmasked-legacy-route', deps: {
      root: join(dir, 'state'), resolveGraphSecret: async () => 'unrelated-token',
      runBash: async () => ({ stdout: '{"outcome":"ok"}\n', stderr: '', exitCode: 0 }),
    } });
    const unmaskedState = JSON.parse(readFileSync(unmasked.statePath, 'utf8')) as typeof state;
    unmaskedState.status = 'running';
    unmaskedState.path = ['action'];
    unmaskedState.nodes = unmaskedState.nodes.filter(node => node.nodeId === 'action');
    if (unmaskedState.nodes[0]) {
      delete unmaskedState.nodes[0].resumeNextNode;
      delete unmaskedState.nodes[0].commandNextNode;
    }
    writeFileSync(unmasked.statePath, `${JSON.stringify(unmaskedState, null, 2)}\n`);
    const unmaskedResume = await runGraph(unmaskedGraphPath, { resumeRunId: unmasked.runId, deps: {
      root: join(dir, 'state'), resolveGraphSecret: async () => { throw new Error('unmasked outcome must not re-resolve credentials'); },
      runBash: async () => { throw new Error('completed command must not be dispatched again'); },
    } });
    expect(unmaskedResume.status).toBe('done');
    expect(unmaskedResume.path).toEqual(['action', 'done']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simulation: marker-valued route is ambiguous with a redacted secret route and fails closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-secret-marker-ambiguity-sim-'));
  try {
    const graphPath = join(dir, 'graph.yaml');
    writeFileSync(graphPath, source.replace('map: { ok: done, fail: failed }', "map: { '[REDACTED]': done, ok: failed }"));
    writeFileSync(join(dir, 'recipes.yaml'), 'action:\n  command: "printf safe"\n');
    const first = await runGraph(graphPath, { runId: 'marker-ambiguous-route', deps: {
      root: join(dir, 'state'), resolveGraphSecret: async () => 'ok',
      runBash: async () => ({ stdout: '{"outcome":"[REDACTED]"}\n', stderr: '', exitCode: 0 }),
    } });
    const state = JSON.parse(readFileSync(first.statePath, 'utf8')) as {
      status: string; path: string[]; nodes: Array<{ nodeId: string; resumeNextNode?: string; commandNextNode?: string }>;
    };
    state.status = 'running';
    state.path = ['action'];
    state.nodes = state.nodes.filter(node => node.nodeId === 'action');
    if (state.nodes[0]) {
      delete state.nodes[0].resumeNextNode;
      delete state.nodes[0].commandNextNode;
    }
    writeFileSync(first.statePath, `${JSON.stringify(state, null, 2)}\n`);
    await expect(runGraph(graphPath, { resumeRunId: first.runId, deps: {
      root: join(dir, 'state'), resolveGraphSecret: async () => 'ok',
      runBash: async () => { throw new Error('completed command must not be dispatched again'); },
    } })).rejects.toThrow('secret-redacted outcome cannot be safely recovered for resume routing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simulation: secret command outcomes never enter persistent graph growth state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-secret-growth-outcome-sim-'));
  try {
    const graphPath = join(dir, 'graph.yaml');
    writeFileSync(graphPath, `grow: on\n${source}`);
    writeFileSync(join(dir, 'recipes.yaml'), 'action:\n  command: "printf safe"\n');
    const secret = 'not-a-declared-route';
    const result = await runGraph(graphPath, { runId: 'secret-growth-outcome', deps: {
      root: join(dir, 'state'), growthScope: 'task-agent',
      resolveGraphSecret: async () => secret,
      runBash: async () => ({ stdout: JSON.stringify({ outcome: secret }), stderr: '', exitCode: 0 }),
      growthProposer: () => { throw new Error('secret outcome must not reach the growth proposer'); },
    } });
    const stateText = readFileSync(result.statePath, 'utf8');
    expect(stateText).not.toContain(secret);
    expect(stateText).not.toContain('not-a-declared-route');
    expect(JSON.parse(stateText).growthEvents).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
