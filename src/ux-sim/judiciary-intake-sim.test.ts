import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { decideGraphApproval, runGraph } from '../graph-runner/runner.js';

const graph = resolve(import.meta.dir, '../../graphs/ops/judiciary-intake.yaml');
const pack = resolve(import.meta.dir, '../../docs/conductor/FEDERATION-OPERATIONS.md');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Kind = 'LAND-REQ' | 'CAP-REQ' | 'WAIVER-REQ';
type Request = { id: string; kind: Kind; head: string; evidence: string; approvedBy?: string };

function world(failExecuteOnceFor?: string) {
  const root = mkdtempSync(join(tmpdir(), 'judiciary-intake-sim-'));
  roots.push(root);
  const decisionLedger = join(root, 'decisions.jsonl');
  const effects: string[] = [];
  const executeAttempts: string[] = [];
  const hints = readFileSync(pack, 'utf8');
  expect(hints).toContain('[LAND-REQ]');
  expect(hints).toContain('waiver');
  const handlers = {
    'judiciary-judge': async ({ input, outputs }: { input: unknown; outputs: Readonly<Record<string, unknown>> }) => {
      const request = (input as { request: Request }).request;
      const verdict = (outputs.classify as { verdict?: string } | undefined)?.verdict;
      const supported = verdict === request.kind && request.head.length > 0 && request.evidence.length > 0;
      const authorized = request.kind !== 'WAIVER-REQ' || !!request.approvedBy;
      return { ok: true, outcome: supported && authorized ? 'ready' : 'unknown', result: { verdict, supported, authorized } };
    },
    'judiciary-execute': async ({ input }: { input: unknown }) => {
      const request = (input as { request: Request }).request;
      executeAttempts.push(request.id);
      if (request.id === failExecuteOnceFor && executeAttempts.filter(id => id === request.id).length === 1)
        return { ok: false, outcome: 'fail', result: { reason: 'transient execution failure' } };
      effects.push(request.id);
      return { ok: true, outcome: 'done', result: { action: request.kind, requestId: request.id } };
    },
    'judiciary-record': async ({ input, outputs, runId }: { input: unknown; outputs: Readonly<Record<string, unknown>>; runId: string }) => {
      const request = (input as { request: Request }).request;
      const execution = (outputs.execute as { result?: { action?: string } } | undefined)?.result;
      appendFileSync(decisionLedger, JSON.stringify({ runId, requestId: request.id, type: request.kind,
        action: execution?.action, ruleId: 'federation-operations-judiciary' }) + '\n');
      return { ok: true, outcome: 'recorded', result: { requestId: request.id } };
    },
  };
  async function submit(request: Request, llmAnswer: string = request.kind) {
    return runGraph(graph, { runId: request.id, input: { request, arguments: JSON.stringify(request),
      classify: { input: '$ARGUMENTS', classes: ['LAND-REQ', 'CAP-REQ', 'WAIVER-REQ'], hint: hints } },
    deps: { root, inProcessHandlers: handlers, callLLM: async (prompt) => {
      expect(prompt).toContain('판정국');
      return llmAnswer;
    } } });
  }
  async function resume(runId: string) {
    return runGraph(graph, { resumeRunId: runId, quiet: true, deps: { root, inProcessHandlers: handlers } });
  }
  return { root, effects, executeAttempts, decisionLedger, submit, resume };
}

test('KINGDOM-INTAKE-GRAPH: three fake request kinds each produce one classified, judged, executed and recorded run', async () => {
  const source = readFileSync(graph, 'utf8');
  const parsed = parseGraphTemplateYaml(source, graph);
  expect(parsed.errors).toEqual([]);
  expect(parsed.template?.loop?.trigger?.events).toEqual(['LAND-REQ', 'CAP-REQ', 'WAIVER-REQ']);
  expect(parsed.template?.nodes.find(node => node.nodeId === 'classify')?.kind).toBe('classify');
  expect(parsed.template?.nodes.find(node => node.nodeId === 'needs-human')?.kind).toBe('hitl');
  const sim = world();
  const requests: Request[] = [
    { id: 'land-1', kind: 'LAND-REQ', head: 'a'.repeat(40), evidence: 'Terra PASS receipt' },
    { id: 'cap-1', kind: 'CAP-REQ', head: 'b'.repeat(40), evidence: 'review cap reason' },
    { id: 'waiver-1', kind: 'WAIVER-REQ', head: 'c'.repeat(40), evidence: 'measured regression', approvedBy: 'OPC' },
  ];
  const runs = [];
  for (const request of requests) runs.push(await sim.submit(request));
  expect(runs.map(run => [run.runId, run.status, run.path])).toEqual(requests.map(request =>
    [request.id, 'done', ['classify', 'judge', 'execute', 'record', 'done']]));
  expect(sim.effects).toEqual(requests.map(request => request.id));
  const rows = readFileSync(sim.decisionLedger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows.map(row => [row.runId, row.requestId, row.type, row.action])).toEqual(requests.map(request =>
    [request.id, request.id, request.kind, request.kind]));
  await expect(sim.submit(requests[0]!)).rejects.toThrow('run id already exists');
  expect(sim.effects).toHaveLength(requests.length);
});

test('KINGDOM-INTAKE-GRAPH: missing authority parks at HITL before any action or decision entry', async () => {
  const sim = world();
  const run = await sim.submit({ id: 'waiver-unknown', kind: 'WAIVER-REQ', head: 'd'.repeat(40),
    evidence: 'measured regression' });
  expect(run.status).toBe('awaiting-approval');
  expect(run.path).toEqual(['classify', 'judge', 'needs-human']);
  expect(run.pending?.nodeId).toBe('needs-human');
  const unclassified = await sim.submit({ id: 'land-unknown', kind: 'LAND-REQ', head: 'e'.repeat(40),
    evidence: 'Terra PASS receipt' }, 'unknown');
  expect(unclassified.status).toBe('awaiting-approval');
  expect(unclassified.path).toEqual(['classify', 'judge', 'needs-human']);
  expect(sim.effects).toEqual([]);
  expect(() => readFileSync(sim.decisionLedger, 'utf8')).toThrow();
});

test('KINGDOM-INTAKE-GRAPH: failed execution resumes after HITL approval and records one successful action', async () => {
  const sim = world('land-retry');
  const request: Request = { id: 'land-retry', kind: 'LAND-REQ', head: 'f'.repeat(40),
    evidence: 'Terra PASS receipt' };
  const pending = await sim.submit(request);
  expect(pending.status).toBe('awaiting-approval');
  expect(pending.path).toEqual(['classify', 'judge', 'execute', 'needs-human']);
  expect(pending.pending?.nodeId).toBe('needs-human');
  expect(sim.executeAttempts).toEqual([request.id]);
  expect(sim.effects).toEqual([]);
  expect(() => readFileSync(sim.decisionLedger, 'utf8')).toThrow();

  decideGraphApproval(pending.graphId, pending.runId, 'approved', 'OPC', sim.root);
  const resumed = await sim.resume(pending.runId);
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['classify', 'judge', 'execute', 'needs-human', 'execute', 'record', 'done']);
  expect(sim.executeAttempts).toEqual([request.id, request.id]);
  expect(sim.effects).toEqual([request.id]);
  const rows = readFileSync(sim.decisionLedger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows).toEqual([{ runId: request.id, requestId: request.id, type: request.kind, action: request.kind,
    ruleId: 'federation-operations-judiciary' }]);
});
