import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { argEffectKey, runArgSupervisorTick, type ArgMutationState, type ArgSupervisorPorts } from './arg-supervisor.js';
import { ArgFeedbackDurabilityError, readArgFeedback, type ArgFeedbackLedgerPort, type ArgFeedbackReference } from './arg-feedback-consumer.js';
import { ArgFeedbackLedger } from './arg-feedback-lifecycle.js';
import { argCandidateDirectory } from './arg-open-proposal.js';

const loopPath = resolve(import.meta.dir, '../../graphs/release/rla/loop.yaml');
const signature = { nodeId: 'gate-triage', testName: 'release-gate', errorSignature: 'unmeasured-host' };
const candidate: ArgFeedbackReference = { signature, effect: 'vocabulary', stage: 'candidate',
  status: 'candidate', templateEntryId: 'approved-template-entry' };
const pack: ArgFeedbackReference = { signature, effect: 'vocabulary', stage: 'pack',
  status: 'active', packId: 'approved-rla-pack' };
const proposal = { apiVersion: 'elanous.dev/arg-proposal/v1', verb: 'register-novel-gate-failure',
  rationale: 'Host attribution was unmeasured',
  changes: [{ kind: 'vocabulary', term: 'release.gate.failure.unmeasured-host' }],
  rollbackWhen: ['verification fails'] };
const vocabularyEffect = argEffectKey({ kind: 'vocabulary', term: 'release.gate.failure.unmeasured-host' });
const state = (): ArgMutationState => ({ graphRevision: 1, adaptiveGraphEdges: [], adaptiveGraphVocabulary: [] }); // Source: graphs/release/rla/loop.yaml

test('same-kind ARG effects retain distinct stable identities and create a ledger conflict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-feedback-effect-identity-'));
  const identity = { member: 'release-member', universe: 'test', template: 'release-loop' } as const;
  const ledger = new ArgFeedbackLedger(root, identity);
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
  try {
    const firstEffect = { kind: 'vocabulary' as const, term: 'release.gate.failure.first' };
    const secondEffect = { kind: 'vocabulary' as const, term: 'release.gate.failure.second' };
    expect(argEffectKey(firstEffect)).not.toBe(argEffectKey(secondEffect));
    expect(argEffectKey({ term: firstEffect.term, kind: 'vocabulary' })).toBe(argEffectKey(firstEffect));
    const run = (runId: string, effect: typeof firstEffect) => runArgSupervisorTick({
      loopPath, root, targetGraphId: 'release-loop', targetRunId: runId, gateEventId: runId,
      graphRevision: 1, operation: 'reroute', mutableState: state(),
      ports: { observe: ok, propose: () => ({ ...ok(), effect }), validate: ok, verify: ok },
      feedback: { ledger, signature, readCommitted: id =>
        new ArgFeedbackLedger(root, identity).readCommittedOutcome(id, signature) },
    });
    await run('first', firstEffect);
    await run('second', secondEffect);
    expect(ledger.get(signature)).toMatchObject({ status: 'conflict', effect: argEffectKey(firstEffect),
      conflictEffect: argEffectKey(secondEffect), hits: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RLA awaits approved matching candidates and active packs before proposing', async () => {
  const other = { nodeId: 'other-gate', testName: 'release-gate', errorSignature: 'unmeasured-host' };
  const ledger: ArgFeedbackLedgerPort = {
    templateCandidates: async () => [candidate, { ...candidate, templateEntryId: undefined },
      { ...candidate, signature: other }],
    activePack: async () => [pack, { ...pack, packId: undefined }, { ...pack, signature: other }],
    record: () => undefined,
  };
  expect(await readArgFeedback(ledger, signature)).toEqual({ candidates: [candidate], packs: [pack] });
});

test('RLA proposal consumes approved feedback and returns verified and rollback outcomes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-feedback-consumer-'));
  const outcomes: { runId: string; outcome: string; effect: string }[] = [];
  const ledger: ArgFeedbackLedgerPort = {
    templateCandidates: () => [candidate], activePack: () => [pack],
    record: input => { outcomes.push({ runId: input.runId, outcome: input.outcome, effect: input.effect }); },
  };
  const prompts: string[] = [];
  const run = (runId: string, verify: boolean) => {
    const mutableState = state();
    const ports: ArgSupervisorPorts = {
      observe: () => ({ outcome: 'novel', evidence: 'unmeasured gate result' }),
      propose: ({ proposal: proposed }) => ({ outcome: proposed ? 'ok' : 'fail', evidence: 'proposal inspected',
        effect: { kind: 'vocabulary', term: 'release.gate.failure.unmeasured-host' } }),
      validate: () => ({ outcome: 'ok', evidence: 'policy dry-run passed' }),
      verify: () => ({ outcome: verify ? 'ok' : 'fail', evidence: 'simulated graph verification' }),
    };
    return runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop', targetRunId: runId,
      gateEventId: runId, graphRevision: 1, operation: 'reroute', mutableState, ports,
      openProposal: { observation: { classification: 'unmeasured' }, memory: [],
        callLLM: async prompt => { prompts.push(prompt); return JSON.stringify(proposal); } },
      feedback: { ledger, signature, at: () => '2026-11-10T13:00:00Z',
        readCommitted: runId => {
          const found = outcomes.find(item => item.runId === runId);
          return found ? { outcome: found.outcome as 'verified' | 'rollback', effect: found.effect } : 'absent';
        } },
    }).then(result => ({ result, mutableState }));
  };
  try {
    const first = await run('verified-run', true);
    expect(first.result.graphRun.path.at(-1)).toBe('done');
    expect(first.mutableState.graphRevision).toBe(2);
    const second = await run('rollback-run', false);
    expect(second.result.graphRun.path).toContain('rollback');
    expect(second.mutableState.graphRevision).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(prompts.every(prompt => prompt.includes('approved-template-entry') &&
      prompt.includes('approved-rla-pack'))).toBe(true);
    expect(outcomes).toEqual([
      { runId: 'verified-run', outcome: 'verified', effect: vocabularyEffect },
      { runId: 'rollback-run', outcome: 'rollback', effect: vocabularyEffect },
    ]);
    const actions = readFileSync(join(root, 'graph-supervisors/actions.jsonl'), 'utf8');
    expect(actions).toContain('"verb":"verify"');
    expect(actions).toContain('"verb":"rollback"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('feedback write failure restores an otherwise verified graph mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-feedback-fail-'));
  const mutableState = state();
  const ledger: ArgFeedbackLedgerPort = { templateCandidates: () => [], activePack: () => [],
    record: async () => { throw new Error('async feedback storage unavailable'); } };
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
  try {
    await expect(runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop', targetRunId: 'failed-record',
      gateEventId: 'failed-record', graphRevision: 1, operation: 'reroute', mutableState,
      ports: { observe: ok, propose: () => ({ ...ok(), effect: { kind: 'retry-edge', from: 'gate-triage',
        to: 'gate', triggerEvent: 'release.gate.failed', rationale: 'retry' } }), validate: ok, verify: ok },
      feedback: { ledger, signature, readCommitted: () => 'absent' },
    })).rejects.toThrow('feedback outcome could not be recorded');
    expect(mutableState.graphRevision).toBe(1);
    expect(mutableState.adaptiveGraphEdges).toEqual([]);
    const actions = readFileSync(join(root, 'graph-supervisors/actions.jsonl'), 'utf8');
    expect(actions).toContain('"verb":"rollback"');
    expect(actions).toContain('"beforeRevision":2,"graphRevision":1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a durability-class writer error is read back before choosing rollback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-feedback-durability-writer-'));
  const mutableState = state();
  const ledger: ArgFeedbackLedgerPort = { templateCandidates: () => [], activePack: () => [],
    record: () => { throw new ArgFeedbackDurabilityError('writer could not confirm commit'); } };
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
  let reads = 0;
  try {
    await expect(runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop',
      targetRunId: 'durability-writer', gateEventId: 'durability-writer', graphRevision: 1,
      operation: 'reroute', mutableState,
      ports: { observe: ok, propose: () => ({ ...ok(), effect: { kind: 'retry-edge',
        from: 'gate-triage', to: 'gate', triggerEvent: 'release.gate.failed', rationale: 'retry' } }),
        validate: ok, verify: ok },
      feedback: { ledger, signature, readCommitted: () => { reads++; return 'absent'; } },
    })).rejects.toThrow('feedback outcome could not be recorded');
    expect(reads).toBe(1);
    expect(mutableState.graphRevision).toBe(1);
    expect(mutableState.adaptiveGraphEdges).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('feedback failure never leaves a verified open-proposal memory candidate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-feedback-memory-order-'));
  const mutableState = state();
  const ledger: ArgFeedbackLedgerPort = { templateCandidates: () => [], activePack: () => [],
    record: () => { throw new Error('feedback storage unavailable'); } };
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
  try {
    await expect(runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop', targetRunId: 'feedback-failed',
      gateEventId: 'feedback-failed', graphRevision: 1, operation: 'reroute', mutableState,
      ports: { observe: () => ({ outcome: 'novel', evidence: 'unmeasured gate' }),
        propose: () => ({ ...ok(), effect: { kind: 'vocabulary', term: 'release.gate.failure.unmeasured-host' } }),
        validate: ok, verify: ok },
      openProposal: { observation: { classification: 'unmeasured' }, memory: [],
        callLLM: async () => JSON.stringify(proposal) },
      feedback: { ledger, signature, readCommitted: () => 'absent' },
    })).rejects.toThrow('feedback outcome could not be recorded');
    expect(mutableState.graphRevision).toBe(1);
    expect(existsSync(argCandidateDirectory(root, 'feedback-failed'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('feedback failure plus failed restore does not write a successful rollback receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-feedback-restore-fail-'));
  const mutableState = state();
  let persists = 0;
  const ledger: ArgFeedbackLedgerPort = { templateCandidates: () => [], activePack: () => [],
    record: () => { throw new Error('feedback storage unavailable'); } };
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
  try {
    await expect(runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop', targetRunId: 'restore-failed',
      gateEventId: 'restore-failed', graphRevision: 1, operation: 'reroute', mutableState,
      ports: { observe: ok, propose: () => ({ ...ok(), effect: { kind: 'retry-edge', from: 'gate-triage',
        to: 'gate', triggerEvent: 'release.gate.failed', rationale: 'retry' } }), validate: ok, verify: ok,
        persist: () => { if (++persists > 1) throw new Error('durable state unavailable'); } },
      feedback: { ledger, signature, readCommitted: () => 'absent' },
    })).rejects.toThrow('rollback durability is unknown');
    const actions = readFileSync(join(root, 'graph-supervisors/actions.jsonl'), 'utf8');
    expect(actions).not.toContain('"verb":"rollback"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real feedback ledger advances candidate to active pack through RLA proposal results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-feedback-ledger-'));
  const identity = { member: 'release-member', universe: 'test', template: 'release-loop' } as const;
  const ledger = new ArgFeedbackLedger(root, identity);
  const seed = (runId: string) => ledger.record({ runId, signature, effect: vocabularyEffect,
    outcome: 'verified', at: '2026-11-10T13:00:00Z' });
  try {
    seed('seed-one'); seed('seed-two');
    ledger.markTemplateCandidate(signature, { promotion: { resultType: 'complete', entry: {
      id: 'approved-template-entry', scope: 'template', provenance: identity,
    } }, mrtrDecisionId: 'mrtr-template' });
    const prompts: string[] = [];
    const run = (runId: string, verify: boolean) => {
      const mutableState = state();
      const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
      return runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop', targetRunId: runId,
        gateEventId: runId, graphRevision: 1, operation: 'reroute', mutableState,
        ports: { observe: () => ({ outcome: 'novel', evidence: 'unknown gate result' }),
          propose: () => ({ ...ok(), effect: { kind: 'vocabulary', term: 'release.gate.failure.unmeasured-host' } }),
          validate: ok, verify: () => ({ outcome: verify ? 'ok' : 'fail', evidence: 'simulated verification' }) },
        openProposal: { observation: { classification: 'unmeasured' }, memory: [],
          callLLM: async prompt => { prompts.push(prompt); return JSON.stringify(proposal); } },
        feedback: { ledger, signature, at: () => '2026-11-10T13:05:00Z',
          readCommitted: runId => {
            return new ArgFeedbackLedger(root, identity).readCommittedOutcome(runId, signature);
          } },
      });
    };
    await run('candidate-verified', true);
    expect(prompts[0]).toContain('approved-template-entry');
    expect(ledger.get(signature)?.successes).toBe(3);
    ledger.activatePack(signature, { packId: 'approved-rla-pack', verified: true, mrtrDecisionId: 'mrtr-pack' });
    const rollback = await run('pack-rollback', false);
    expect(rollback.graphRun.path).toContain('rollback');
    expect(prompts[1]).toContain('approved-rla-pack');
    expect(ledger.get(signature)).toMatchObject({ stage: 'pack', status: 'active', rollbacks: 1 });
    expect(new ArgFeedbackLedger(root, identity).get(signature)?.seenRuns).toContain('pack-rollback');
    const events = readFileSync(ledger.eventsPath, 'utf8');
    expect(events).toContain('"outcome":"verified"');
    expect(events).toContain('"outcome":"rollback"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RLA does not record candidate memory for a different applied vocabulary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-feedback-effect-'));
  const mutableState = state();
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
  try {
    const result = await runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop',
      targetRunId: 'different-effect', gateEventId: 'different-effect', graphRevision: 1,
      operation: 'reroute', mutableState,
      ports: { observe: () => ({ outcome: 'novel', evidence: 'unknown gate result' }),
        propose: () => ({ ...ok(), effect: { kind: 'vocabulary', term: 'release.gate.failure.actual' } }),
        validate: ok, verify: ok },
      openProposal: { observation: { classification: 'unmeasured' }, memory: [],
        callLLM: async () => JSON.stringify(proposal) },
    });
    expect(result.graphRun.path.at(-1)).toBe('done');
    expect(mutableState.adaptiveGraphVocabulary).toContain('release.gate.failure.actual');
    expect(existsSync(argCandidateDirectory(root, 'different-effect'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('committed-then-rejected feedback is reconciled without rolling back the graph', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-feedback-committed-'));
  const identity = { member: 'release-member', universe: 'test', template: 'release-loop' } as const;
  const durable = new ArgFeedbackLedger(root, identity);
  const mutableState = state();
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
  const ledger: ArgFeedbackLedgerPort = { templateCandidates: () => [], activePack: () => [],
    record: async input => { durable.record(input); throw new Error('event append failed after commit'); } };
  try {
    const result = await runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop',
      targetRunId: 'committed-run', gateEventId: 'committed-run', graphRevision: 1,
      operation: 'reroute', mutableState,
      ports: { observe: ok, propose: () => ({ ...ok(), effect: { kind: 'retry-edge',
        from: 'gate-triage', to: 'gate', triggerEvent: 'release.gate.failed', rationale: 'retry' } }),
        validate: ok, verify: ok },
      feedback: { ledger, signature, readCommitted: runId => {
        return new ArgFeedbackLedger(root, identity).readCommittedOutcome(runId, signature);
      } },
    });
    expect(result.graphRun.path.at(-1)).toBe('done');
    expect(mutableState.graphRevision).toBe(2);
    expect(new ArgFeedbackLedger(root, identity).get(signature)?.successfulRuns).toContain('committed-run');
    const actions = readFileSync(join(root, 'graph-supervisors/actions.jsonl'), 'utf8');
    expect(actions).toContain('"verb":"feedback-reconciled"');
    expect(actions).not.toContain('"verb":"rollback"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a post-commit snapshot error preserves the applied graph revision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-feedback-snapshot-fail-'));
  const identity = { member: 'release-member', universe: 'test', template: 'release-loop' } as const;
  const ledger = new ArgFeedbackLedger(root, identity);
  const mutableState = state();
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
  try {
    await expect(runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop',
      targetRunId: 'snapshot-failed', gateEventId: 'snapshot-failed', graphRevision: 1,
      operation: 'reroute', mutableState,
      ports: { observe: ok, propose: () => ({ ...ok(), effect: { kind: 'retry-edge',
        from: 'gate-triage', to: 'gate', triggerEvent: 'release.gate.failed', rationale: 'retry' } }),
        validate: ok, verify: ok },
      feedback: { ledger, signature, readCommitted: runId =>
        new ArgFeedbackLedger(root, identity).readCommittedOutcome(runId, signature),
        onCommitted: () => { throw new Error('snapshot unavailable'); } },
    })).rejects.toThrow('ARG feedback committed but snapshot failed');
    expect(mutableState.graphRevision).toBe(2);
    expect(mutableState.adaptiveGraphEdges).toHaveLength(1);
    expect(new ArgFeedbackLedger(root, identity).get(signature)?.successfulRuns).toContain('snapshot-failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same run and outcome with a different durable effect cannot reconcile a rejected feedback write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-feedback-effect-mismatch-'));
  const identity = { member: 'release-member', universe: 'test', template: 'release-loop' } as const;
  const durable = new ArgFeedbackLedger(root, identity);
  const mutableState = state();
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
  const ledger: ArgFeedbackLedgerPort = { templateCandidates: () => [], activePack: () => [],
    record: async input => {
      durable.record({ ...input, effect: 'different-effect' });
      throw new Error('writer rejected after a different effect was committed');
    } };
  try {
    await expect(runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop',
      targetRunId: 'effect-mismatch', gateEventId: 'effect-mismatch', graphRevision: 1,
      operation: 'reroute', mutableState,
      ports: { observe: ok, propose: () => ({ ...ok(), effect: { kind: 'retry-edge',
        from: 'gate-triage', to: 'gate', triggerEvent: 'release.gate.failed', rationale: 'retry' } }),
        validate: ok, verify: ok },
      feedback: { ledger, signature, readCommitted: runId =>
        new ArgFeedbackLedger(root, identity).readCommittedOutcome(runId, signature) },
    })).rejects.toThrow('ARG feedback outcome durability is unknown');
    expect(mutableState.graphRevision).toBe(2);
    expect(new ArgFeedbackLedger(root, identity).readCommittedOutcome('effect-mismatch', signature))
      .toEqual({ outcome: 'verified', effect: 'different-effect' });
    const actions = readFileSync(join(root, 'graph-supervisors/actions.jsonl'), 'utf8');
    expect(actions).not.toContain('"verb":"feedback-reconciled"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('uncertain feedback write leaves the graph revision intact and does not mint candidate memory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-feedback-unknown-'));
  const mutableState = state();
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
  const ledger: ArgFeedbackLedgerPort = { templateCandidates: () => [], activePack: () => [],
    record: async () => { throw new Error('writer outcome unknown'); } };
  try {
    await expect(runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop',
      targetRunId: 'unknown-write', gateEventId: 'unknown-write', graphRevision: 1,
      operation: 'reroute', mutableState,
      ports: { observe: () => ({ outcome: 'novel', evidence: 'unknown gate result' }),
        propose: () => ({ ...ok(), effect: { kind: 'vocabulary', term: 'release.gate.failure.unmeasured-host' } }),
        validate: ok, verify: ok },
      openProposal: { observation: { classification: 'unmeasured' }, memory: [],
        callLLM: async () => JSON.stringify(proposal) },
      feedback: { ledger, signature, readCommitted: () => 'unknown' },
    })).rejects.toThrow('ARG feedback outcome durability is unknown');
    expect(mutableState.graphRevision).toBe(2);
    expect(existsSync(argCandidateDirectory(root, 'unknown-write'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
