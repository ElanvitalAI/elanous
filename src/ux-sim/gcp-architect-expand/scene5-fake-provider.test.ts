import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decideGraphApproval, runGraph } from '../../graph-runner/runner.js';
import { activeResourceLeases, readResourceLedger } from '../../resource-ledger/resource-ledger.js';
import { registerGcpScene5FakeProvider } from './scene5-fake-provider.js';

const repo = resolve(import.meta.dir, '../../..');
const graph = join(repo, 'plugins/gcp-architect-expand/graph.yaml');
const sample = join(repo, 'plugins/gcp-architect-expand/sim/sample-output');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world(failScheduleOnce = false) {
  const root = mkdtempSync(join(tmpdir(), 'gcp-scene5-'));
  dirs.push(root);
  const proposal = JSON.parse(readFileSync(join(sample, 'proposal.json'), 'utf8'));
  const outDir = join(root, 'artifacts');
  const ticketDesignPath = join(root, 'ticket-design.json');
  copyFileSync(join(repo, 'plugins/gcp-architect-expand/demo/fixtures/ticketing-design.json'), ticketDesignPath);
  mkdirSync(outDir);
  const called: string[] = [];
  const specs = [
    ['architecture.excalidraw', 'architecture.excalidraw', 'diagram-source', 'application/json', 'diagram'],
    ['architecture.png', 'architecture.png', 'diagram', 'image/png', 'diagram'],
    ['architecture-design.pdf', 'architecture.pdf', 'pdf', 'application/pdf', 'pdf'],
    ['architecture-design.html', 'architecture.html', 'html', 'text/html', 'pdf'],
  ] as const;
  const attachments = specs.map(([source, name, kind, mime, producedBy]) => {
    const localPath = join(outDir, name);
    copyFileSync(join(sample, source), localPath);
    return { kind, title: name, url: `https://demo.example.test/artifacts/${name}`, mime, producedBy,
      sha256: createHash('sha256').update(readFileSync(localPath)).digest('hex') };
  });
  const registry = () => registerGcpScene5FakeProvider({ proposal, pressure: proposal.signal,
    outDir, stateRoot: root,
    onInvoke: nodeId => { called.push(nodeId); if (nodeId === 'schedule' && failScheduleOnce) {
      failScheduleOnce = false; throw new Error('simulated process interruption');
    } },
    deliverables: async () => ({ receipt: { status: 'verified' }, attachments }),
  });
  const options = { quiet: true, deps: { root, capabilityProviders: registry() } };
  return { root, outDir, ticketDesignPath, options, registry, called };
}

test('N rejects the Scene 5 spending gate without creating a fake project', async () => {
  const w = world();
  const initial = await runGraph(graph, { ...w.options, input: { ticketDesignPath: w.ticketDesignPath } });
  expect(initial.status).toBe('awaiting-approval');
  expect(initial.pending?.nodeId).toBe('approve');
  decideGraphApproval(initial.graphId, initial.runId, 'rejected', 'fake-user', w.root);
  const denied = await runGraph(graph, { ...w.options, resumeRunId: initial.runId, resumeGraphId: initial.graphId });
  expect(denied.status).toBe('failed');
  expect(w.called).toEqual(['detect', 'design', 'deliverables']);
  expect(existsSync(join(w.outDir, 'fake-gcp-runs', initial.graphId, initial.runId, 'cost-ledger.json'))).toBe(false);
});

test('y records fake-only project, work and idle stop after approval', async () => {
  const w = world();
  const initial = await runGraph(graph, { ...w.options, input: { ticketDesignPath: w.ticketDesignPath } });
  expect(initial.status).toBe('awaiting-approval');
  const costPath = join(w.outDir, 'fake-gcp-runs', initial.graphId, initial.runId, 'cost-ledger.json');
  expect(existsSync(costPath)).toBe(false);
  decideGraphApproval(initial.graphId, initial.runId, 'approved', 'fake-user', w.root);
  const approved = await runGraph(graph, { ...w.options, resumeRunId: initial.runId, resumeGraphId: initial.graphId });
  expect(approved.status).toBe('done');
  expect(w.called).toEqual(['detect', 'design', 'deliverables', 'provision', 'schedule', 'idle-stop']);
  const ledger = JSON.parse(readFileSync(costPath, 'utf8'));
  expect(ledger.realGcpCalls).toBe(0);
  expect(ledger.project.state).toBe('stopped');
  expect(ledger.events.map((event: { event: string }) => event.event)).toEqual(['project-created', 'work-scheduled', 'idle-stopped']);
  expect(Date.parse(ledger.events[2].at) - Date.parse(ledger.events[1].at)).toBe(proposalIdleTtl());
  expect(activeResourceLeases(readResourceLedger(ledger.resourceLedgerPath))).toEqual([]);
  const second = await runGraph(graph, { ...w.options, input: { ticketDesignPath: w.ticketDesignPath } });
  decideGraphApproval(second.graphId, second.runId, 'approved', 'fake-user', w.root);
  const secondDone = await runGraph(graph, { ...w.options, resumeRunId: second.runId, resumeGraphId: second.graphId });
  expect(secondDone.status).toBe('done');
  const secondLedger = JSON.parse(readFileSync(join(w.outDir, 'fake-gcp-runs', second.graphId, second.runId, 'cost-ledger.json'), 'utf8'));
  expect(secondLedger.project.id).not.toBe(ledger.project.id);
  expect(secondLedger.leaseId).not.toBe(ledger.leaseId);
});

test('different Scene 4 bytes fail before design output or fake spending', async () => {
  const w = world();
  writeFileSync(w.ticketDesignPath, readFileSync(w.ticketDesignPath, 'utf8') + ' ');
  const result = await runGraph(graph, { ...w.options, input: { ticketDesignPath: w.ticketDesignPath } });
  expect(result.status).toBe('failed');
  expect(w.called).toEqual(['detect', 'design']);
  expect(existsSync(join(w.outDir, 'fake-gcp-runs', result.graphId, result.runId, 'cost-ledger.json'))).toBe(false);
});

test('a fresh provider resumes a run after fake provisioning interrupted at schedule', async () => {
  const w = world(true);
  const initial = await runGraph(graph, { ...w.options, input: { ticketDesignPath: w.ticketDesignPath } });
  decideGraphApproval(initial.graphId, initial.runId, 'approved', 'fake-user', w.root);
  const interrupted = await runGraph(graph, { ...w.options, resumeRunId: initial.runId, resumeGraphId: initial.graphId });
  expect(interrupted.status).toBe('failed');
  const path = join(w.outDir, 'fake-gcp-runs', initial.graphId, initial.runId, 'cost-ledger.json');
  const before = JSON.parse(readFileSync(path, 'utf8'));
  expect(before.project.state).toBe('created');
  expect(before.events.map((item: { event: string }) => item.event)).toEqual(['project-created']);
  const resumed = await runGraph(graph, { resumeRunId: initial.runId, resumeGraphId: initial.graphId,
    fromNodeId: 'schedule', quiet: true, deps: { root: w.root, capabilityProviders: w.registry() } });
  expect(resumed.status).toBe('done');
  expect(resumed.nodes.some(node => node.nodeId === 'idle-stop' && node.ok)).toBe(true);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  expect(after.project.state).toBe('stopped');
  expect(after.events.map((item: { event: string }) => item.event)).toEqual(['project-created', 'work-scheduled', 'idle-stopped']);
  expect(activeResourceLeases(readResourceLedger(after.resourceLedgerPath))).toEqual([]);
});

function proposalIdleTtl(): number {
  return JSON.parse(readFileSync(join(sample, 'proposal.json'), 'utf8')).idleTtlMs;
}
