import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { argCandidateDirectory, parseArgOpenProposal, proposeOpenArg, recordOpenArgMemory, validateOpenArgProposal } from './arg-open-proposal.js';
import { runArgSupervisorTick, type ArgMutationState, type ArgSupervisorPorts } from './arg-supervisor.js';

const cardPath = resolve(import.meta.dir, '../../graphs/release/rla/loop.yaml');
const graphPath = resolve(import.meta.dir, '../../graphs/release/release-loop.yaml');
const parsed = parseGraphTemplateYaml(readFileSync(graphPath, 'utf8'), graphPath);
if (!parsed.template) throw new Error(parsed.errors.map(issue => issue.message).join('; '));
const context = { graph: parsed.template, cardPath, observation: { classification: 'unseen' },
  knowledgePacks: ['release-edge-vocabulary', 'macrophage-subscriber'], memory: [] };
const vocabularyProposal = { apiVersion: 'elanous.dev/arg-proposal/v1', verb: 'register-novel-gate-failure',
  rationale: 'Unseen gate signal', changes: [{ kind: 'vocabulary', term: 'release.gate.failure.unseen' }],
  rollbackWhen: ['verification fails'] } as const;

test('LLM open proposal is schema checked and low-risk vocabulary is classified after dry-run', async () => {
  let prompt = '';
  const proposal = await proposeOpenArg(context, async value => { prompt = value; return JSON.stringify(vocabularyProposal); });
  expect(prompt).toContain('Template memory');
  expect(prompt).toContain('Knowledge packs');
  expect(validateOpenArgProposal(proposal, context).disposition).toBe('auto-apply');
  expect(validateOpenArgProposal(parseArgOpenProposal({ ...vocabularyProposal,
    rollbackWhen: ['someone may look later'] }), context).disposition).toBe('rejected');
  expect(parseArgOpenProposal({ ...vocabularyProposal, command: 'rm -rf /' })).toBeNull();
  expect(validateOpenArgProposal(parseArgOpenProposal({ ...vocabularyProposal,
    changes: [{ kind: 'vocabulary', term: 'other.namespace.unseen' }] }), context).disposition).toBe('rejected');
  expect(validateOpenArgProposal(parseArgOpenProposal({ ...vocabularyProposal,
    changes: [{ kind: 'edge', from: 'gate', to: 'gate-triage', condition: 'failure' }] }), context).disposition).toBe('input_required');
  expect(validateOpenArgProposal(parseArgOpenProposal({ ...vocabularyProposal,
    changes: [{ kind: 'vocabulary', term: 'release.gate.failure.unseen' },
      { kind: 'node', node: { node_id: 'new-gate', kind: 'gate', recipe: 'none' } }] }), context).disposition).toBe('input_required');
});

test('novel observation applies vocabulary and keeps repeated evidence quarantined as a candidate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-open-sim-'));
  let mutableState: ArgMutationState = { graphRevision: 1, adaptiveGraphEdges: [], adaptiveGraphVocabulary: [] }; // Source: RLA-SUPERVISOR-ARG-GRAPH initial revision contract.
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
  const ports: ArgSupervisorPorts = {
    observe: () => ({ outcome: 'novel', evidence: 'unknown gate failure' }),
    propose: ({ proposal }) => ({ outcome: proposal?.verb === vocabularyProposal.verb ? 'ok' : 'fail', evidence: 'proposal received',
      effect: { kind: 'vocabulary', term: 'release.gate.failure.unseen' } }),
    validate: ({ decision }) => ({ outcome: decision?.disposition === 'auto-apply' ? 'ok' : 'fail', evidence: 'validated' }),
    verify: () => ({ outcome: mutableState.adaptiveGraphVocabulary?.includes('release.gate.failure.unseen') ? 'ok' : 'fail', evidence: 'vocabulary registered' }) };
  try {
    for (const runId of ['first', 'second']) {
      mutableState = { graphRevision: 1, adaptiveGraphEdges: [], adaptiveGraphVocabulary: [] }; // Source: RLA-SUPERVISOR-ARG-GRAPH run-local revision contract.
      const result = await runArgSupervisorTick({ loopPath: cardPath, root, targetGraphId: 'release-loop',
        targetRunId: runId, gateEventId: runId, graphRevision: mutableState.graphRevision!, operation: 'reroute', mutableState, ports,
        openProposal: { observation: context.observation, memory: [], callLLM: async () => JSON.stringify(vocabularyProposal) } });
      expect(result.graphRun.path).toEqual(['observe', 'reason', 'propose', 'validate', 'apply', 'verify', 'done']);
      expect(result.graphRevision).toBe(mutableState.graphRevision!);
    }
    recordOpenArgMemory(root, cardPath, 'first', 'release.gate.failure.unseen', 'repeat observation', true);
    const entries = (runId: string) => readdirSync(argCandidateDirectory(root, runId))
      .map(file => JSON.parse(readFileSync(join(argCandidateDirectory(root, runId), file), 'utf8')));
    expect(entries('first')).toHaveLength(2);
    expect(entries('second')).toHaveLength(1);
    expect(entries('first').every(item => item.targetRunId === 'first' && item.status === 'candidate')).toBe(true);
    expect(entries('first').reduce((uses, item) => uses + item.verifiedUses, 0)).toBe(2); // Source: R-MEMORY #36579 candidate evidence count; no automatic promotion.
    const ledger = readFileSync(join(root, 'graph-supervisors/actions.jsonl'), 'utf8');
    expect(ledger).toContain('"verb":"reason"');
    expect(ledger).toContain('"verb":"memory-candidate"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('repeated unknown failure reuses its run-local vocabulary without a new revision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-open-reuse-'));
  const mutableState: ArgMutationState = { graphRevision: 1, adaptiveGraphEdges: [], adaptiveGraphVocabulary: [] }; // Source: RLA-SUPERVISOR-ARG-GRAPH initial revision contract.
  const ports: ArgSupervisorPorts = {
    observe: () => ({ outcome: 'novel', evidence: 'same unmeasured gate cause' }),
    propose: () => ({ outcome: 'ok', evidence: 'vocabulary proposal',
      effect: { kind: 'vocabulary', term: 'release.gate.failure.unseen' } }),
    validate: () => ({ outcome: 'ok', evidence: 'dry-run passed' }),
    verify: () => ({ outcome: 'ok', evidence: 'vocabulary present' }),
  };
  try {
    const run = (gateEventId: string) => runArgSupervisorTick({ loopPath: cardPath, root,
      targetGraphId: 'release-loop', targetRunId: 'same-run', gateEventId,
      graphRevision: mutableState.graphRevision!, operation: 'reroute', mutableState, ports,
      openProposal: { observation: context.observation, memory: [], callLLM: async () => JSON.stringify(vocabularyProposal) },
    });
    const first = await run('gate-first');
    expect(first.graphRun.path).toContain('apply');
    expect(mutableState.graphRevision).toBe(2);
    const repeated = await run('gate-repeat');
    expect(repeated.graphRun.path).toEqual(['observe', 'reason', 'propose', 'validate', 'done']);
    expect(mutableState.graphRevision).toBe(2);
    expect(mutableState.adaptiveGraphVocabulary).toEqual(['release.gate.failure.unseen']);
    const actions = readFileSync(join(root, 'graph-supervisors/actions.jsonl'), 'utf8');
    expect(actions).toContain('existing run-local vocabulary reused');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mixed vocabulary and new node proposal preserves both changes for MRTR without applying', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-open-hitl-'));
  const mutableState: ArgMutationState = { graphRevision: 1, adaptiveGraphEdges: [], adaptiveGraphVocabulary: [] }; // Source: RLA-SUPERVISOR-ARG-GRAPH initial revision contract.
  const proposal = { ...vocabularyProposal, changes: [
    { kind: 'vocabulary', term: 'release.gate.failure.unseen' },
    { kind: 'node', node: { node_id: 'new-gate', kind: 'gate', recipe: 'none' } }] };
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
  try {
    const result = await runArgSupervisorTick({ loopPath: cardPath, root, targetGraphId: 'release-loop',
      targetRunId: 'hitl', gateEventId: 'hitl', graphRevision: 1, operation: 'add-node', mutableState,
      openProposal: { observation: context.observation, memory: [], callLLM: async () => JSON.stringify(proposal) },
      ports: { observe: () => ({ outcome: 'novel', evidence: 'new action' }),
        propose: ok, validate: ok, verify: ok } });
    expect(result.resultType).toBe('input_required');
    expect(mutableState.graphRevision).toBe(1);
    expect(result.requestState?.proposal).toContain('release.gate.failure.unseen');
    expect(result.requestState?.proposal).toContain('new-gate');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid open proposal records a rejected reason before the supervisor stops', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-open-reject-'));
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
  try {
    const result = await runArgSupervisorTick({ loopPath: cardPath, root, targetGraphId: 'release-loop',
      targetRunId: 'reject', gateEventId: 'reject', graphRevision: 1, operation: 'reroute', // Source: RLA-SUPERVISOR-ARG-GRAPH initial revision contract.
      mutableState: { graphRevision: 1, adaptiveGraphEdges: [], adaptiveGraphVocabulary: [] }, // Source: RLA-SUPERVISOR-ARG-GRAPH initial revision contract.
      openProposal: { observation: context.observation, memory: [], callLLM: async () => '{"unknown":true}' },
      ports: { observe: () => ({ outcome: 'novel', evidence: 'unknown gate' }),
        propose: ok, validate: ok, verify: ok } });
    expect(result.graphRun.path).toEqual(['observe', 'reason', 'failed']);
    const ledger = readFileSync(join(root, 'graph-supervisors/actions.jsonl'), 'utf8');
    expect(ledger).toContain('"verb":"reason"');
    expect(ledger).toContain('"outcome":"rejected"');
    expect(ledger).toContain('proposal schema invalid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
