import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decideGraphApproval, runGraph } from '../../../../src/graph-runner/runner.js';
import { ticketDesignFromArchitectureJson } from '../../../../scripts/gcp-architect-expand/demo/design-result.js';
import { registerGcpScene5FakeProvider } from '../../../../src/ux-sim/gcp-architect-expand/scene5-fake-provider.js';

const fixturePath = join(import.meta.dir, '../../../../plugins/gcp-architect-expand/demo/fixtures/ticketing-design.json');
const originalSourcePath = join(import.meta.dir, '../../../../plugins/gcp-architect-expand/demo/fixtures/scene4-structured-design.json');
const repo = resolve(import.meta.dir, '../../../..');
const graphPath = join(repo, 'plugins/gcp-architect-expand/graph.yaml');
const samplePath = join(repo, 'plugins/gcp-architect-expand/sim/sample-output');
const pressurePath = join(repo, 'plugins/gcp-architect-expand/demo/fixtures/pressure.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  source: { kind: string; sessionId: string; sha256: string };
  runId: string;
  sourceLimit: string;
  designResult: { title: string; summary: string; requirements: Array<{ statement: string }> };
};
const EXPECTED_SCENE4_DESIGN_SHA256 = 'e469fcc57951d5cb0bf9451776ca6036a3a8ed3881f5d15c042ca613606c8b41';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('R-TICKET Scene 4 structured output becomes the GCP input with its source trace intact', () => {
  const originalScene4Bytes = readFileSync(originalSourcePath);
  const originalScene4Sha256 = createHash('sha256').update(originalScene4Bytes).digest('hex');
  expect(fixture.source.sha256).toBe(EXPECTED_SCENE4_DESIGN_SHA256);
  expect(originalScene4Sha256).toBe(EXPECTED_SCENE4_DESIGN_SHA256);
  expect(JSON.parse(originalScene4Bytes.toString('utf8'))).toEqual(fixture.designResult);
  expect(fixture.sourceLimit).toContain('not a live scene 2/3 acceptance record');

  const design = ticketDesignFromArchitectureJson(fixture);
  expect(design).toMatchObject({
    title: fixture.designResult.title,
    summary: fixture.designResult.summary,
    sourceKind: 'plugin-scene2-scene3-fixture',
    sourceSessionId: 'elanous-session-s070vh',
    sourceGraphRunId: '4d4eed28-3a83-4fa1-adcc-42a0c8397619',
  });
  expect(design.requirements).toEqual(fixture.designResult.requirements.map(item => item.statement));
  expect(design.localComponents).toContain('Booking API');
  expect(design.assumptions.every(item => item.requiresConfirmation)).toBe(true);
});

test('fake Scene 5 graph receipt preserves the Scene 4 run trace and never claims real GCP calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gcp-scene4-receipt-'));
  roots.push(root);
  const runWithInputPath = async (inputPath: string, label: string) => {
    const runRoot = join(root, label);
    const outDir = join(runRoot, 'artifacts');
    mkdirSync(outDir, { recursive: true });
    const files = [
      ['architecture.excalidraw', 'architecture.excalidraw', 'diagram-source', 'application/json', 'diagram'],
      ['architecture.png', 'architecture.png', 'diagram', 'image/png', 'diagram'],
      ['architecture-design.pdf', 'architecture.pdf', 'pdf', 'application/pdf', 'pdf'],
      ['architecture-design.html', 'architecture.html', 'html', 'text/html', 'pdf'],
    ] as const;
    const attachments = files.map(([source, name, kind, mime, producedBy]) => {
      const path = join(outDir, name);
      copyFileSync(join(samplePath, source), path);
      return { kind, title: name, url: path, mime, producedBy,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    });
    const registry = registerGcpScene5FakeProvider({ pressure: JSON.parse(readFileSync(pressurePath, 'utf8')),
      outDir, stateRoot: runRoot, designNodeId: 'design',
      deliverables: async () => ({ receipt: { status: 'verified' }, attachments }) });
    const result = await runGraph(graphPath, { input: { ticketDesignPath: inputPath }, quiet: true,
      deps: { root: runRoot, capabilityProviders: registry } });
    expect(result.status, JSON.stringify(result.nodes.map(node => ({ nodeId: node.nodeId, output: node.output })))).toBe('awaiting-approval');
    expect(result.pending?.nodeId).toBe('approve');
    const statePath = join(runRoot, 'graph-runs/gcp-architect-expand', `${result.runId}.json`);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      runId: string; nodes: Array<{ nodeId: string; output?: string }>;
    };
    const designNode = state.nodes.find(node => node.nodeId === 'design');
    const output = JSON.parse(designNode?.output ?? '{}') as {
      result?: { architectureSpec?: { inputSha256?: string; ticketDesign?: { sourceSessionId?: string; sourceGraphRunId?: string }; realGcpCalls?: number } };
    };
    expect(state.runId).toBe(result.runId);
    expect(output.result?.architectureSpec?.realGcpCalls).toBe(0);
    expect(output.result?.architectureSpec?.inputSha256).toBe(createHash('sha256').update(readFileSync(inputPath)).digest('hex'));
    const designOutput = designNode?.output;
    decideGraphApproval(result.graphId, result.runId, 'approved', 'fake-test-member', runRoot);
    const completed = await runGraph(graphPath, { resumeRunId: result.runId, resumeGraphId: result.graphId,
      quiet: true, deps: { root: runRoot, capabilityProviders: registry } });
    expect(completed.status).toBe('done');
    const finalState = JSON.parse(readFileSync(statePath, 'utf8')) as { nodes: Array<{ nodeId: string; output?: string }> };
    expect(finalState.nodes.find(node => node.nodeId === 'design')?.output).toBe(designOutput);
    return output.result?.architectureSpec;
  };
  const original = await runWithInputPath(fixturePath, 'original');
  const alternatePath = join(root, 'alternate-ticketing-design.json');
  writeFileSync(alternatePath, JSON.stringify({ ...fixture, runId: 'scene4-run-alternate',
    source: { ...fixture.source, sessionId: 'scene4-session-alternate' } }, null, 2) + '\n');
  const alternate = await runWithInputPath(alternatePath, 'alternate');
  expect(original?.ticketDesign).toMatchObject({ sourceSessionId: 'elanous-session-s070vh', sourceGraphRunId: fixture.runId });
  expect(alternate?.ticketDesign).toMatchObject({ sourceSessionId: 'scene4-session-alternate', sourceGraphRunId: 'scene4-run-alternate' });
  expect(alternate?.inputSha256).not.toBe(original?.inputSha256);
});

test('one registered provider keeps interleaved Scene 4 run proposals isolated through approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gcp-scene4-interleaved-'));
  roots.push(root);
  const outDir = join(root, 'artifacts');
  mkdirSync(outDir, { recursive: true });
  const pressure = JSON.parse(readFileSync(pressurePath, 'utf8')) as unknown;
  const attachmentRows = [
    ['architecture.excalidraw', 'architecture.excalidraw', 'diagram-source', 'application/json', 'diagram'],
    ['architecture.png', 'architecture.png', 'diagram', 'image/png', 'diagram'],
    ['architecture-design.pdf', 'architecture.pdf', 'pdf', 'application/pdf', 'pdf'],
    ['architecture-design.html', 'architecture.html', 'html', 'text/html', 'pdf'],
  ] as const;
  const attachments = attachmentRows.map(([source, name, kind, mime, producedBy]) => {
    const path = join(outDir, name);
    copyFileSync(join(samplePath, source), path);
    return { kind, title: name, url: path, mime, producedBy, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  });
  const registry = registerGcpScene5FakeProvider({ pressure, outDir, stateRoot: root, designNodeId: 'design',
    deliverables: async () => ({ receipt: { status: 'verified' }, attachments }) });
  const alternatePath = join(root, 'alternate-ticketing-design.json');
  writeFileSync(alternatePath, JSON.stringify({ ...fixture, runId: 'scene4-run-interleaved',
    source: { ...fixture.source, sessionId: 'scene4-session-interleaved' } }, null, 2) + '\n');
  const start = (ticketDesignPath: string) => runGraph(graphPath, { input: { ticketDesignPath }, quiet: true,
    deps: { root, capabilityProviders: registry } });
  const first = await start(fixturePath);
  const second = await start(alternatePath);
  expect(first.status).toBe('awaiting-approval');
  expect(second.status).toBe('awaiting-approval');
  for (const pending of [first, second]) decideGraphApproval(pending.graphId, pending.runId, 'approved', 'fake-test-member', root);
  const firstDone = await runGraph(graphPath, { resumeRunId: first.runId, resumeGraphId: first.graphId,
    quiet: true, deps: { root, capabilityProviders: registry } });
  const secondDone = await runGraph(graphPath, { resumeRunId: second.runId, resumeGraphId: second.graphId,
    quiet: true, deps: { root, capabilityProviders: registry } });
  expect(firstDone.status).toBe('done');
  expect(secondDone.status).toBe('done');
  const designOf = (runId: string) => {
    const path = join(root, 'graph-runs/gcp-architect-expand', `${runId}.json`);
    const state = JSON.parse(readFileSync(path, 'utf8')) as { nodes: Array<{ nodeId: string; output?: string }> };
    return JSON.parse(state.nodes.find(node => node.nodeId === 'design')?.output ?? '{}').result.architectureSpec;
  };
  expect(designOf(first.runId).ticketDesign).toMatchObject({ sourceSessionId: 'elanous-session-s070vh', sourceGraphRunId: fixture.runId });
  expect(designOf(second.runId).ticketDesign).toMatchObject({ sourceSessionId: 'scene4-session-interleaved', sourceGraphRunId: 'scene4-run-interleaved' });
  expect(designOf(first.runId).inputSha256).not.toBe(designOf(second.runId).inputSha256);
});

test('re-registered provider rejects a changed Scene 4 design after approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gcp-scene4-restart-'));
  roots.push(root);
  const outDir = join(root, 'artifacts');
  mkdirSync(outDir, { recursive: true });
  const inputPath = join(root, 'ticketing-design.json');
  copyFileSync(fixturePath, inputPath);
  const attachmentRows = [
    ['architecture.excalidraw', 'architecture.excalidraw', 'diagram-source', 'application/json', 'diagram'],
    ['architecture.png', 'architecture.png', 'diagram', 'image/png', 'diagram'],
    ['architecture-design.pdf', 'architecture.pdf', 'pdf', 'application/pdf', 'pdf'],
    ['architecture-design.html', 'architecture.html', 'html', 'text/html', 'pdf'],
  ] as const;
  const attachments = attachmentRows.map(([source, name, kind, mime, producedBy]) => {
    const path = join(outDir, name);
    copyFileSync(join(samplePath, source), path);
    return { kind, title: name, url: path, mime, producedBy, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  });
  const registry = () => registerGcpScene5FakeProvider({ pressure: JSON.parse(readFileSync(pressurePath, 'utf8')),
    outDir, stateRoot: root, designNodeId: 'design', deliverables: async () => ({ receipt: { status: 'verified' }, attachments }) });
  const initial = await runGraph(graphPath, { input: { ticketDesignPath: inputPath }, quiet: true,
    deps: { root, capabilityProviders: registry() } });
  expect(initial.status).toBe('awaiting-approval');
  decideGraphApproval(initial.graphId, initial.runId, 'approved', 'fake-test-member', root);
  writeFileSync(inputPath, JSON.stringify({ ...fixture, runId: 'scene4-run-after-restart',
    source: { ...fixture.source, sessionId: 'scene4-session-after-restart' } }, null, 2) + '\n');
  const resumed = await runGraph(graphPath, { resumeRunId: initial.runId, resumeGraphId: initial.graphId,
    quiet: true, deps: { root, capabilityProviders: registry() } });
  expect(resumed.status).toBe('failed');
  expect(JSON.stringify(resumed.nodes)).toContain('Scene 4 design input changed after approval');
  expect(existsSync(join(outDir, 'fake-gcp-runs', initial.graphId, initial.runId, 'cost-ledger.json'))).toBe(false);
});

test('re-registered provider rejects a changed pressure proposal after approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gcp-scene4-pressure-restart-'));
  roots.push(root);
  const outDir = join(root, 'artifacts');
  mkdirSync(outDir, { recursive: true });
  const attachmentRows = [
    ['architecture.excalidraw', 'architecture.excalidraw', 'diagram-source', 'application/json', 'diagram'],
    ['architecture.png', 'architecture.png', 'diagram', 'image/png', 'diagram'],
    ['architecture-design.pdf', 'architecture.pdf', 'pdf', 'application/pdf', 'pdf'],
    ['architecture-design.html', 'architecture.html', 'html', 'text/html', 'pdf'],
  ] as const;
  const attachments = attachmentRows.map(([source, name, kind, mime, producedBy]) => {
    const path = join(outDir, name);
    copyFileSync(join(samplePath, source), path);
    return { kind, title: name, url: path, mime, producedBy, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  });
  const originalPressure = JSON.parse(readFileSync(pressurePath, 'utf8')) as Record<string, unknown>;
  const registry = (pressure: unknown) => registerGcpScene5FakeProvider({ pressure, outDir, stateRoot: root, designNodeId: 'design',
    deliverables: async () => ({ receipt: { status: 'verified' }, attachments }) });
  const initial = await runGraph(graphPath, { input: { ticketDesignPath: fixturePath }, quiet: true,
    deps: { root, capabilityProviders: registry(originalPressure) } });
  expect(initial.status).toBe('awaiting-approval');
  decideGraphApproval(initial.graphId, initial.runId, 'approved', 'fake-test-member', root);
  const changedPressure = { ...originalPressure, observedAt: '2026-11-11T00:00:00.000Z', cpuUsed: 0.12 };
  const resumed = await runGraph(graphPath, { resumeRunId: initial.runId, resumeGraphId: initial.graphId,
    quiet: true, deps: { root, capabilityProviders: registry(changedPressure) } });
  expect(resumed.status).toBe('failed');
  expect(JSON.stringify(resumed.nodes)).toContain('Scene 4 design input changed after approval');
  expect(existsSync(join(outDir, 'fake-gcp-runs', initial.graphId, initial.runId, 'cost-ledger.json'))).toBe(false);
});
