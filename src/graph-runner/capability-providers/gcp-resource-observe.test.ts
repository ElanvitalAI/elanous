import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideGraphApproval, runGraph } from '../runner.js';
import { createGcpResourceObserveRegistry } from './gcp-resource-observe.js';
import { createChildPluginRuntimeContract } from '../../cli/child-plugin-runtime.js';
import { _setSystemGcloudPathsForTesting } from '../../cli/role-cli.js';
import { generateStructuredDesign } from '../architecture-output/structured-design.js';

const graph = join(import.meta.dir, '../../../plugins/gcp-architect-expand/graph.yaml');
const ticketDesignPath = join(import.meta.dir, '../../../plugins/gcp-architect-expand/demo/fixtures/ticketing-design.json');

function root() { return mkdtempSync(join(tmpdir(), 'gcp-observe-')); }

test('no cloud connection returns an explicit empty observation and continues to requirement design', async () => {
  const stateRoot = root();
  let reads = 0;
  try {
    const registry = createGcpResourceObserveRegistry({ connection: () => null, artifactRoot: () => stateRoot,
      listInstances: async () => { reads++; return []; } });
    const state = await runGraph(graph, { input: { ticketDesignPath }, quiet: true,
      deps: { root: stateRoot, capabilityProviders: registry } });
    expect(state.status).toBe('awaiting-approval');
    expect(state.path).toEqual(['detect', 'design', 'deliverables', 'connect-first']);
    const observed = JSON.parse(String(state.nodes.find(node => node.nodeId === 'detect')?.output));
    expect(observed).toMatchObject({ outcome: 'no-connection', result: {
      connection: 'none', message: '연결 없음', resources: [], resourceCount: 0,
    }, evidence: { realGcpReads: 0, realGcpWrites: 0 } });
    const designed = JSON.parse(String(state.nodes.find(node => node.nodeId === 'design')?.output));
    expect(designed).toMatchObject({ outcome: 'requirements-only', result: { architectureSpec: {
      source: 'requirements-only', cloudResources: [], fakeResources: 0, realGcpWrites: 0,
      estimate: { price: 'unpriced' },
    } } });
    expect(designed.result.architectureSpec.requirements).not.toEqual([]);
    expect(reads).toBe(0);
    const delivered = JSON.parse(String(state.nodes.find(node => node.nodeId === 'deliverables')?.output));
    expect(delivered).toMatchObject({ outcome: 'connection-needed', result: {
      connection: 'none', fakeResources: 0, realGcpWrites: 0,
    }, evidence: { status: 'verified' } });
    const files = delivered.result.attachments as Array<{ name: string; path: string; sha256: string }>;
    expect(files.map(file => file.name)).toEqual(['architecture.excalidraw', 'architecture.png', 'architecture.pdf', 'architecture.html']);
    expect(JSON.parse(readFileSync(delivered.result.verificationPath, 'utf8')).costStatus).toBe('unpriced');
    expect(readFileSync(files.find(file => file.name === 'architecture.html')!.path, 'utf8')).toContain('<td>미산정</td>');
    expect(readFileSync(files.find(file => file.name === 'architecture.pdf')!.path).subarray(0, 4).toString()).toBe('%PDF');
    expect(readFileSync(files.find(file => file.name === 'architecture.png')!.path).subarray(1, 4).toString()).toBe('PNG');
    expect(state.pending?.nodeId).toBe('connect-first');
    expect(state.pending?.message).toContain('클라우드 연결 필요 — 연결하면 이 설계로 배포 승인');
    expect(state.path.some(node => ['approve', 'provision', 'schedule', 'idle-stop'].includes(node))).toBe(false);
    decideGraphApproval(state.graphId, state.runId, 'approved', 'synthetic-owner', stateRoot);
    const acknowledged = await runGraph(graph, { resumeRunId: state.runId, input: { ticketDesignPath }, quiet: true,
      deps: { root: stateRoot, capabilityProviders: registry } });
    expect(acknowledged.path).toEqual(['detect', 'design', 'deliverables', 'connect-first', 'done']);
    expect(acknowledged.path).not.toContain('provision');
    const ledger = readFileSync(state.statePath, 'utf8');
    expect(ledger).not.toContain('fake-gcp-runs');
  } finally { rmSync(stateRoot, { recursive: true, force: true }); }
});

test('structured architecture preserves unpriced separately from a measured zero cost', () => {
  const samplePath = join(import.meta.dir, '../../../plugins/architecture-deliverables/examples/structured-ticketing-gcp.json');
  const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as { costs: Array<{ monthlyUsd: number | null }> };
  sample.costs[0]!.monthlyUsd = null;
  const unpriced = generateStructuredDesign(sample).html;
  expect(unpriced).toContain('<td>미산정</td>');
  sample.costs[0]!.monthlyUsd = 0;
  const zero = generateStructuredDesign(sample).html;
  expect(zero).toContain('<td>0</td>');
  expect(zero).not.toContain('<td>미산정</td>');
});

test('an explicit connection performs one read-only list and never reaches a spending node', async () => {
  const stateRoot = root();
  const projects: string[] = [];
  try {
    const registry = createGcpResourceObserveRegistry({ connection: () => ({ projectId: 'member-cloud-123' }), artifactRoot: () => stateRoot,
      listInstances: async project => { projects.push(project); return [{ id: '123', name: 'owned-vm', status: 'RUNNING',
        zone: 'projects/member-cloud-123/zones/asia-northeast3-a' }]; } });
    const state = await runGraph(graph, { input: { ticketDesignPath }, quiet: true,
      deps: { root: stateRoot, capabilityProviders: registry } });
    expect(state.status).toBe('done');
    expect(state.path).toEqual(['detect', 'design', 'done']);
    expect(projects).toEqual(['member-cloud-123']);
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'detect')?.output))).toMatchObject({
      outcome: 'observed', result: { connection: 'connected', projectId: 'member-cloud-123',
        resourceCount: 1, resources: [{ id: '123', name: 'owned-vm', status: 'RUNNING', zone: 'asia-northeast3-a' }] },
      evidence: { realGcpReads: 1, realGcpWrites: 0 },
    });
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'design')?.output)).outcome).toBe('observed-design');
    expect(JSON.stringify(state.nodes)).not.toContain('unconnected-design-only');
    expect(state.path).not.toContain('approve');
    expect(state.path).not.toContain('connect-first');
    expect(state.path).not.toContain('provision');
  } finally { rmSync(stateRoot, { recursive: true, force: true }); }
});

test('configured GCP observation invokes only the read-only list command', async () => {
  const stateRoot = root();
  const script = join(stateRoot, 'gcloud');
  const argsPath = join(stateRoot, 'argv');
  const oldProject = process.env.ELANOUS_GCP_OBSERVE_PROJECT;
  const oldArgv = process.env.MVP_B_GCLOUD_TEST_ARGV;
  try {
    writeFileSync(script, '#!/bin/sh\nprintf "%s\\n" "$@" > "$MVP_B_GCLOUD_TEST_ARGV"\nprintf "[]\\n"\n');
    chmodSync(script, 0o755);
    _setSystemGcloudPathsForTesting([script]);
    process.env.ELANOUS_GCP_OBSERVE_PROJECT = 'member-cloud-123';
    process.env.MVP_B_GCLOUD_TEST_ARGV = argsPath;
    const state = await runGraph(graph, { input: { ticketDesignPath }, quiet: true,
      deps: { root: stateRoot, capabilityProviders: createGcpResourceObserveRegistry({ artifactRoot: () => stateRoot }) } });
    expect(state.status).toBe('done');
    expect(readFileSync(argsPath, 'utf8').trim().split('\n')).toEqual([
      'compute', 'instances', 'list', '--project=member-cloud-123', '--format=json',
    ]);
  } finally {
    _setSystemGcloudPathsForTesting(null);
    if (oldProject === undefined) delete process.env.ELANOUS_GCP_OBSERVE_PROJECT;
    else process.env.ELANOUS_GCP_OBSERVE_PROJECT = oldProject;
    if (oldArgv === undefined) delete process.env.MVP_B_GCLOUD_TEST_ARGV;
    else process.env.MVP_B_GCLOUD_TEST_ARGV = oldArgv;
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('a configured but unreadable connection fails as unknown, without claiming no connection', async () => {
  const stateRoot = root();
  try {
    const registry = createGcpResourceObserveRegistry({ connection: () => ({ projectId: 'member-cloud-123' }),
      listInstances: async () => { throw new Error('offline'); } });
    const state = await runGraph(graph, { input: { ticketDesignPath }, quiet: true,
      deps: { root: stateRoot, capabilityProviders: registry } });
    expect(state.status).toBe('failed');
    expect(state.path).toEqual(['detect', 'failed']);
    expect(state.nodes.find(node => node.nodeId === 'detect')?.error).toBe('contract-exhausted');
    expect(JSON.stringify(state.nodes)).not.toContain('연결 없음');
  } finally { rmSync(stateRoot, { recursive: true, force: true }); }
});

test('declared plugin route loads the operating provider with no connection and no fake resources', async () => {
  const stateRoot = root();
  const old = process.env.ELANOUS_GCP_OBSERVE_PROJECT;
  const oldStateDir = process.env.ELANOUS_STATE_DIR;
  try {
    delete process.env.ELANOUS_GCP_OBSERVE_PROJECT;
    process.env.ELANOUS_STATE_DIR = stateRoot;
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'member-observe' }, graphDeps: { root: stateRoot },
      requestConfirmation: async () => true });
    const result = await bridge.dispatchPluginTool('gcp_architect_expand', { ticketDesignPath });
    if (!result.ok) throw new Error(result.error);
    expect(result.ok).toBe(true);
    const state = result.ok ? result.result as { status: string; path: string[]; nodes: Array<{ nodeId: string; output?: string }> } : null;
    expect(state?.status).toBe('awaiting-approval');
    expect(state?.path).toEqual(['detect', 'design', 'deliverables', 'connect-first']);
    expect(JSON.parse(String(state?.nodes.find(node => node.nodeId === 'detect')?.output)).result.message).toBe('연결 없음');
  } finally {
    if (old === undefined) delete process.env.ELANOUS_GCP_OBSERVE_PROJECT;
    else process.env.ELANOUS_GCP_OBSERVE_PROJECT = old;
    if (oldStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = oldStateDir;
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
