import { expect, test } from 'bun:test';
import { createChildPluginRuntimeContract } from './child-plugin-runtime.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerGcpScene5FakeProvider } from '../ux-sim/gcp-architect-expand/scene5-fake-provider.js';
import { buildCliAgentTools } from './agent-cli.js';
import { registerToolRuntime, unregisterToolRuntime } from '../tool-runtime/registry.js';

test('default Scene 5 route consumes the actual paused Graph visit and records N before spending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scene5-route-graph-'));
  try {
    const designPath = join(root, 'ticket-design.json');
    const fixtureRoot = join(import.meta.dir, '..', '..', 'plugins', 'gcp-architect-expand', 'demo', 'fixtures');
    writeFileSync(designPath, readFileSync(join(fixtureRoot, 'ticketing-design.json')));
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const outDir = join(root, 'artifacts');
    mkdirSync(outDir);
    const attachments = ([
      ['diagram-source', 'architecture.excalidraw', 'application/json', 'diagram'],
      ['diagram', 'architecture.png', 'image/png', 'diagram'],
      ['pdf', 'architecture.pdf', 'application/pdf', 'pdf'],
      ['html', 'architecture.html', 'text/html', 'pdf'],
    ] as const).map(([kind, title, mime, producedBy]) => {
      const url = join(outDir, title);
      writeFileSync(url, `verified ${kind}`);
      return { kind, title, mime, producedBy, url, sha256: hash(url) };
    });
    const invoked: string[] = [];
    const registry = registerGcpScene5FakeProvider({
      pressure: JSON.parse(readFileSync(join(fixtureRoot, 'pressure.json'), 'utf8')),
      outDir, stateRoot: root, designNodeId: 'design', onInvoke: node => invoked.push(node),
      deliverables: async () => ({ attachments, receipt: { status: 'verified' } }) });
    const prompts: string[] = [];
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'member-300' },
      graphDeps: { root, capabilityProviders: registry },
      requestConfirmation: async prompt => { prompts.push(prompt); return prompts.length === 1; } });
    const response = await bridge.dispatchPluginTool('gcp_architect_expand', { ticketDesignPath: designPath });
    expect(response).toMatchObject({ ok: true, result: { graphId: 'gcp-architect-expand', status: 'failed' } });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('GCP 확장 비용 승인');
    expect(prompts[1]).toContain('검증된 첨부');
    expect(invoked).toEqual(['detect', 'design', 'deliverables']);
    const state = response.ok ? response.result as { runId: string } : null;
    const ledger = JSON.parse(readFileSync(join(root, 'graph-runs', 'gcp-architect-expand', `${state?.runId}.json`), 'utf8'));
    expect(ledger.input.context.memberId).toBe('member-300');
    expect(ledger.nodes.find((node: { nodeId: string }) => node.nodeId === 'approve')?.output).toContain('declined');
    const approvedPrompts: string[] = [];
    const approvedBridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'member-300' },
      graphDeps: { root, capabilityProviders: registry },
      requestConfirmation: async prompt => { approvedPrompts.push(prompt); return true; } });
    const approved = await approvedBridge.dispatchPluginTool('gcp_architect_expand', { ticketDesignPath: designPath });
    expect(approved).toMatchObject({ ok: true, result: { graphId: 'gcp-architect-expand', status: 'done' } });
    expect(approvedPrompts).toHaveLength(2);
    expect(invoked.slice(-6)).toEqual(['detect', 'design', 'deliverables', 'provision', 'schedule', 'idle-stop']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('next child CLI exposes route metadata and dispatches a declared graph through the shared seam', async () => {
  const calls: Array<{ pluginId: string; graphId: string; graphFile: string; owner?: string }> = [];
  const prompts: string[] = [];
  const make = (approve: boolean) => createChildPluginRuntimeContract({
    verifiedOwner: { id: 'member-next' },
    requestConfirmation: async prompt => { prompts.push(prompt); return approve; },
    dispatchGraph: async (pluginId, graphId, graphFile, _args, context) => {
      calls.push({ pluginId, graphId, graphFile, owner: context?.verifiedOwner?.id });
      return { graphId, status: 'done' };
    },
  });
  const rejected = make(false);
  const route = rejected.hostTools.find(tool => tool.name === 'suggest_accept');
  expect(route).toMatchObject({ pluginId: 'absorb', route: { requiresConfirm: true, risk: 'high' } });
  await expect(rejected.dispatchPluginTool('suggest_accept', { suggestionId: 'demo' })).resolves.toMatchObject({ ok: false });
  expect(calls).toEqual([]);

  const accepted = make(true);
  await expect(accepted.dispatchPluginTool('suggest_accept', { suggestionId: 'demo' })).resolves.toEqual({
    ok: true, result: { graphId: 'absorb-build', status: 'done' },
  });
  expect(calls).toEqual([{
    pluginId: 'absorb', graphId: 'absorb-build',
    graphFile: join(import.meta.dir, '..', '..', 'plugins', 'absorb', 'graph', 'absorb-build.yaml'),
    owner: 'member-next',
  }]);
  expect(prompts).toContain('이 제안을 격리된 앱 복사본에 적용하고 시뮬레이션을 시작할까요? (y/N)');
});

test('next child CLI graph route fails closed without a verified owner', async () => {
  const bridge = createChildPluginRuntimeContract();
  const result = await bridge.dispatchPluginTool('suggest_list', {});
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('verified owner') });
});

test('next child CLI blocks an injected graph executor before confirmation without a verified owner', async () => {
  let graphCalls = 0;
  let confirmationCalls = 0;
  const bridge = createChildPluginRuntimeContract({
    dispatchGraph: async () => { graphCalls++; return { status: 'done' }; },
    requestConfirmation: async () => { confirmationCalls++; return true; },
  });
  const result = await bridge.dispatchPluginTool('suggest_accept', { suggestionId: 'demo' });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('verified owner') });
  expect(graphCalls).toBe(0);
  expect(confirmationCalls).toBe(0);
});

test('next child CLI runtime dispatch uses the registered runtime and carries its context', async () => {
  const id = 'r_hotspot_next_dispatch_probe';
  const seen: Array<{ surface: string; owner?: string; value?: unknown }> = [];
  registerToolRuntime({
    id, spec: { name: id, description: 'runtime dispatch probe', parameters: { type: 'object' } }, surfaces: ['tui'],
    run: async (args: Record<string, unknown>, context) => {
      seen.push({ surface: context.surface, owner: context.verifiedOwner?.id, value: args.value });
      return { output: 'runtime-called' };
    },
  });
  try {
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'member-next' } });
    expect(bridge.runtimeTools.map(tool => tool.id)).toContain(id);
    await expect(bridge.dispatchToolRuntime(id, { value: 'sent' })).resolves.toEqual({ output: 'runtime-called' });
    expect(seen).toEqual([{ surface: 'tui', owner: 'member-next', value: 'sent' }]);
  } finally {
    unregisterToolRuntime(id);
  }
});

test('next TUI child CLI catalog dispatches plugin graph and runtime calls through the production entry', async () => {
  const id = 'r_hotspot_next_cli_runtime_probe';
  const calls: string[] = [];
  registerToolRuntime({
    id, spec: { name: id, description: 'runtime dispatch probe', parameters: { type: 'object' } }, surfaces: ['tui'],
    run: async () => { calls.push('runtime'); return { output: 'runtime-called' }; },
  });
  try {
    const cli = buildCliAgentTools(undefined, undefined, process.cwd(), {
      verifiedOwner: { id: 'member-next' },
      dispatchGraph: async () => { calls.push('graph'); return { status: 'done' }; },
    });
    expect(cli.specs.find(spec => spec.name === 'suggest_list')).toMatchObject({ pluginId: 'absorb' });
    expect(cli.specs.map(spec => spec.name)).toContain(id);
    await expect(cli.dispatch('suggest_list', {})).resolves.toEqual({ status: 'done' });
    await expect(cli.dispatch(id, {})).resolves.toEqual({ output: 'runtime-called' });
    expect(calls).toEqual(['graph', 'runtime']);
  } finally {
    unregisterToolRuntime(id);
  }
});
