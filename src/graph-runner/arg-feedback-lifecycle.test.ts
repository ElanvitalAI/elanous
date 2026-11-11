import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ArgFeedbackLedger } from './arg-feedback-lifecycle.js';
import type { ArgTemplatePromotionReceipt } from './arg-feedback-lifecycle.js';

const identity = { member: 'member-a', universe: 'test', template: 'release-loop' } as const;
const main = { nodeId: 'gate', testName: 'release-gate.test.ts', errorSignature: 'pod-host-attribution' };
const emergency = { nodeId: 'emergency-release', testName: 'emergency.test.ts', errorSignature: 'cutover-blocked' };
const obsolete = { nodeId: 'old-gate', testName: 'old-gate.test.ts', errorSignature: 'old-error' };
const promotion = (id: string): ArgTemplatePromotionReceipt => ({ resultType: 'complete', entry: {
  id, scope: 'template',
  provenance: { member: identity.member, universe: identity.universe, template: identity.template },
} });

test('ten fake ARG runs advance instance → candidate → pack → graph, preserve dormant and retire only unreachable signatures', () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-feedback-10-runs-'));
  try {
    const ledger = new ArgFeedbackLedger(root, identity);
    const event = (run: number, signature: typeof main, outcome: 'verified' | 'rollback' = 'verified') =>
      ledger.record({ runId: `run-${run}`, signature, effect: 'retry-edge', outcome,
        at: `2026-11-${String(run).padStart(2, '0')}T00:00:00.000Z` });
    event(1, main); event(2, main);
    expect(ledger.get(main)?.stage).toBe('instance');
    expect(ledger.get(main)?.readyForTemplate).toBe(true);
    ledger.markTemplateCandidate(main, { promotion: promotion('template-entry-1'), mrtrDecisionId: 'decision-1' });
    expect(ledger.get(main)).toMatchObject({ stage: 'candidate', status: 'candidate', successes: 2 });
    expect(ledger.templateCandidates()).toHaveLength(1);
    event(3, main);
    ledger.activatePack(main, { packId: 'rla-retry-pack', verified: true, mrtrDecisionId: 'decision-2' });
    event(4, main);
    event(5, emergency);
    event(6, obsolete);
    const hygiene = ledger.auditCut({ reachable: [main, emergency], observed: [main], graphRevisions: [] });
    expect(hygiene).toMatchObject({ retired: 1, dormant: 1, graduated: 0 });
    expect(ledger.get(emergency)?.status).toBe('dormant');
    expect(ledger.get(obsolete)?.status).toBe('retired');
    event(7, main, 'rollback'); event(8, main, 'rollback');
    expect(ledger.get(main)).toMatchObject({ stage: 'candidate', status: 'candidate', rollbacks: 2 });
    event(9, main); event(10, main);
    ledger.activatePack(main, { packId: 'rla-retry-pack', verified: true, mrtrDecisionId: 'decision-3' });
    ledger.graduate(main, { graphRevision: 'rev-42', mergedPr: 36699, deterministic: true, minConsistentSuccesses: 2 }); // Source: #36641 ARG graph receipt shape; 36699 is a fake merged PR in this simulation.
    expect(ledger.activePack()).toEqual([]);
    expect(ledger.get(main)).toMatchObject({ stage: 'graph', status: 'graduated', graphRevision: 'rev-42' });
    expect(ledger.auditCut({ reachable: [main, emergency], graphRevisions: ['rev-42'] }).graduated).toBe(1);
    expect(ledger.auditCut({ reachable: [main, emergency], observed: [main], graphRevisions: [] }).reactivated).toBe(1);
    expect(ledger.get(main)).toMatchObject({ stage: 'pack', status: 'active' });
    expect(new ArgFeedbackLedger(root, identity).get(main)?.hits).toBe(8);
    const transitions = readFileSync(ledger.eventsPath, 'utf8');
    expect(transitions).toContain('"type":"graduated"');
    expect(transitions).toContain('"type":"retired"');
    expect(transitions).toContain('"type":"reactivated"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ARG lifecycle rejects unapproved pack activation, mixed identity and contradictory evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-feedback-boundary-'));
  try {
    const ledger = new ArgFeedbackLedger(root, identity);
    ledger.record({ runId: 'one', signature: main, effect: 'retry-edge', outcome: 'verified', at: '2026-11-01T00:00:00Z' });
    ledger.record({ runId: 'two', signature: main, effect: 'retry-edge', outcome: 'verified', at: '2026-11-02T00:00:00Z' });
    expect(() => ledger.markTemplateCandidate(main, { promotion: { resultType: 'input_required' }, mrtrDecisionId: 'decision' })).toThrow();
    ledger.markTemplateCandidate(main, { promotion: promotion('x'), mrtrDecisionId: 'decision' });
    expect(() => ledger.activatePack(main, { packId: 'pack', verified: true, mrtrDecisionId: '' })).toThrow();
    ledger.record({ runId: 'three', signature: main, effect: 'skip-gate', outcome: 'verified', at: '2026-11-03T00:00:00Z' });
    expect(ledger.get(main)?.status).toBe('conflict');
    expect(() => ledger.activatePack(main, { packId: 'pack', verified: true, mrtrDecisionId: 'decision-2' })).toThrow();
    expect(new ArgFeedbackLedger(root, { ...identity, universe: 'prod' }).get(main)).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conflicted instance and retired candidate cannot be promoted or activated', () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-feedback-reject-'));
  try {
    const ledger = new ArgFeedbackLedger(root, identity);
    ledger.record({ runId: 'one', signature: main, effect: 'retry-edge', outcome: 'verified', at: '2026-11-01T00:00:00Z' });
    ledger.record({ runId: 'two', signature: main, effect: 'retry-edge', outcome: 'verified', at: '2026-11-02T00:00:00Z' });
    ledger.record({ runId: 'three', signature: main, effect: 'skip-gate', outcome: 'verified', at: '2026-11-03T00:00:00Z' });
    expect(() => ledger.markTemplateCandidate(main, { promotion: promotion('x'), mrtrDecisionId: 'decision' })).toThrow();
    expect(ledger.get(main)?.status).toBe('conflict');
    const other = { nodeId: 'other-gate', testName: 'other.test.ts', errorSignature: 'other-error' };
    ledger.record({ runId: 'four', signature: other, effect: 'retry-edge', outcome: 'verified', at: '2026-11-04T00:00:00Z' });
    ledger.record({ runId: 'five', signature: other, effect: 'retry-edge', outcome: 'verified', at: '2026-11-05T00:00:00Z' });
    ledger.markTemplateCandidate(other, { promotion: promotion('y'), mrtrDecisionId: 'decision-2' });
    ledger.auditCut({ reachable: [main], graphRevisions: [] });
    expect(ledger.get(other)?.status).toBe('retired');
    expect(() => ledger.activatePack(other, { packId: 'pack', verified: true, mrtrDecisionId: 'decision-3' })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pack rollbacks count within the current activation cycle and graph rollback immediately restores the active pack', () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-feedback-cycle-'));
  try {
    const ledger = new ArgFeedbackLedger(root, identity);
    const hit = (runId: string, outcome: 'verified' | 'rollback') => ledger.record({ runId, signature: main, effect: 'retry-edge', outcome,
      at: '2026-11-10T00:00:00Z' });
    hit('one', 'verified'); hit('two', 'verified');
    ledger.markTemplateCandidate(main, { promotion: promotion('x'), mrtrDecisionId: 'decision' });
    ledger.activatePack(main, { packId: 'pack', verified: true, mrtrDecisionId: 'decision-2' });
    hit('three', 'rollback'); hit('four', 'rollback');
    expect(ledger.get(main)?.stage).toBe('candidate');
    hit('five', 'verified'); hit('six', 'verified');
    ledger.activatePack(main, { packId: 'pack', verified: true, mrtrDecisionId: 'decision-3' });
    hit('seven', 'verified');
    expect(ledger.get(main)?.stage).toBe('pack');
    ledger.graduate(main, { graphRevision: 'rev-2', mergedPr: 36699, deterministic: true, minConsistentSuccesses: 2 }); // Source: #36641 fake merged graph receipt.
    ledger.auditCut({ reachable: [main], graphRevisions: [] });
    expect(ledger.activePack()).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('two ledger instances on one partition preserve both writers and refresh readers', () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-feedback-writers-'));
  try {
    const first = new ArgFeedbackLedger(root, identity);
    const second = new ArgFeedbackLedger(root, identity);
    first.record({ runId: 'one', signature: main, effect: 'retry-edge', outcome: 'verified', at: '2026-11-01T00:00:00Z' });
    second.record({ runId: 'two', signature: main, effect: 'retry-edge', outcome: 'verified', at: '2026-11-02T00:00:00Z' });
    expect(first.get(main)).toMatchObject({ hits: 2, successes: 2, readyForTemplate: true });
    expect(second.get(main)?.seenRuns).toEqual(['one', 'two']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pack activation needs a distinct MRTR decision from template promotion and each earlier activation', () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-feedback-decisions-'));
  try {
    const ledger = new ArgFeedbackLedger(root, identity);
    const hit = (runId: string, outcome: 'verified' | 'rollback') => ledger.record({ runId, signature: main,
      effect: 'retry-edge', outcome, at: '2026-11-10T00:00:00Z' });
    hit('one', 'verified'); hit('two', 'verified');
    ledger.markTemplateCandidate(main, { promotion: promotion('entry'), mrtrDecisionId: 'mrtr-template' });
    expect(() => ledger.activatePack(main, { packId: 'pack', verified: true, mrtrDecisionId: 'mrtr-template' })).toThrow('distinct MRTR');
    ledger.activatePack(main, { packId: 'pack', verified: true, mrtrDecisionId: 'mrtr-pack-1' });
    hit('three', 'rollback'); hit('four', 'rollback');
    hit('five', 'verified'); hit('six', 'verified');
    expect(() => ledger.activatePack(main, { packId: 'pack', verified: true, mrtrDecisionId: 'mrtr-pack-1' })).toThrow('distinct MRTR');
    ledger.activatePack(main, { packId: 'pack', verified: true, mrtrDecisionId: 'mrtr-pack-2' });
    expect(new ArgFeedbackLedger(root, identity).get(main)?.packMrtrDecisionIds).toEqual(['mrtr-pack-1', 'mrtr-pack-2']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verified OP conflict decision chooses an effect and resumes evidence collection', () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-feedback-conflict-resolution-'));
  try {
    const ledger = new ArgFeedbackLedger(root, identity);
    const hit = (runId: string, effect: string) => ledger.record({ runId, signature: main, effect, outcome: 'verified', at: '2026-11-10T00:00:00Z' });
    hit('one', 'retry-edge'); hit('two', 'retry-edge'); hit('three', 'skip-gate');
    expect(ledger.get(main)?.status).toBe('conflict');
    expect(() => ledger.resolveConflict(main, { decisionId: 'op-1', approvedBy: 'OP', verified: false, choice: 'proposed' })).toThrow();
    ledger.resolveConflict(main, { decisionId: 'op-1', approvedBy: 'OP', verified: true, choice: 'proposed' });
    expect(ledger.get(main)).toMatchObject({ status: 'instance', stage: 'instance', effect: 'skip-gate', readyForTemplate: false });
    hit('four', 'skip-gate'); hit('five', 'skip-gate');
    expect(ledger.get(main)?.readyForTemplate).toBe(true);
    expect(readFileSync(ledger.eventsPath, 'utf8')).toContain('"type":"conflict-resolved"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retired signature is restored when graph/code inventory makes it reachable again', () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-feedback-restored-'));
  try {
    const ledger = new ArgFeedbackLedger(root, identity);
    for (const runId of ['one', 'two']) ledger.record({ runId, signature: main, effect: 'retry-edge', outcome: 'verified', at: '2026-11-10T00:00:00Z' });
    ledger.markTemplateCandidate(main, { promotion: promotion('entry'), mrtrDecisionId: 'mrtr-template' });
    ledger.auditCut({ reachable: [], graphRevisions: [] });
    expect(ledger.get(main)?.status).toBe('retired');
    ledger.auditCut({ reachable: [main], observed: [main], graphRevisions: [] });
    expect(ledger.get(main)?.status).toBe('candidate');
    ledger.record({ runId: 'three', signature: main, effect: 'retry-edge', outcome: 'verified', at: '2026-11-10T00:00:00Z' });
    ledger.activatePack(main, { packId: 'pack', verified: true, mrtrDecisionId: 'mrtr-pack' });
    expect(ledger.activePack()).toHaveLength(1);
    expect(readFileSync(ledger.eventsPath, 'utf8')).toContain('"type":"restored"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed audit append leaves a recoverable pending commit and never exposes unreceipted state', () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-feedback-journal-'));
  try {
    const ledger = new ArgFeedbackLedger(root, identity);
    mkdirSync(ledger.eventsPath, { recursive: true });
    expect(() => ledger.record({ runId: 'one', signature: main, effect: 'retry-edge', outcome: 'verified',
      at: '2026-11-10T00:00:00Z' })).toThrow();
    expect(existsSync(join(dirname(ledger.eventsPath), 'patterns.json'))).toBe(false);
    rmSync(ledger.eventsPath, { recursive: true, force: true });
    const pending = JSON.parse(readFileSync(join(dirname(ledger.eventsPath), 'pending.json'), 'utf8')) as { event: string };
    writeFileSync(ledger.eventsPath, pending.event.slice(0, 24));
    const recovered = new ArgFeedbackLedger(root, identity);
    expect(recovered.get(main)?.hits).toBe(1);
    expect(readFileSync(ledger.eventsPath, 'utf8').split('\n').filter(line => line.includes('"type":"outcome"'))).toHaveLength(1);
    expect(new ArgFeedbackLedger(root, identity).get(main)?.hits).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('snapshot replacement failure replays one committed audit event without duplication', () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-feedback-snapshot-recovery-'));
  try {
    const ledger = new ArgFeedbackLedger(root, identity, { beforeSnapshotReplace: () => { throw new Error('injected snapshot failure'); } });
    expect(() => ledger.record({ runId: 'one', signature: main, effect: 'retry-edge', outcome: 'verified',
      at: '2026-11-10T00:00:00Z' })).toThrow('injected snapshot failure');
    expect(readFileSync(ledger.eventsPath, 'utf8').split('\n').filter(line => line.includes('"type":"outcome"'))).toHaveLength(1);
    const recovered = new ArgFeedbackLedger(root, identity);
    expect(recovered.get(main)?.hits).toBe(1);
    expect(readFileSync(ledger.eventsPath, 'utf8').split('\n').filter(line => line.includes('"type":"outcome"'))).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OP keeping the original effect preserves the current pack rollback count', () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-feedback-conflict-pack-cycle-'));
  try {
    const ledger = new ArgFeedbackLedger(root, identity);
    const hit = (runId: string, effect: string, outcome: 'verified' | 'rollback') => ledger.record({
      runId, signature: main, effect, outcome, at: '2026-11-10T00:00:00Z' });
    hit('one', 'retry-edge', 'verified'); hit('two', 'retry-edge', 'verified');
    ledger.markTemplateCandidate(main, { promotion: promotion('entry'), mrtrDecisionId: 'mrtr-template' });
    ledger.activatePack(main, { packId: 'pack', verified: true, mrtrDecisionId: 'mrtr-pack' });
    hit('three', 'retry-edge', 'rollback');
    hit('four', 'skip-gate', 'verified');
    expect(ledger.get(main)).toMatchObject({ status: 'conflict', hits: 4, successes: 3, rollbacks: 1, packCycleRollbacks: 1 });
    ledger.resolveConflict(main, { decisionId: 'op-keep', approvedBy: 'OP', verified: true, choice: 'original' });
    expect(ledger.get(main)?.packCycleRollbacks).toBe(1);
    hit('five', 'retry-edge', 'rollback');
    expect(ledger.get(main)).toMatchObject({ stage: 'candidate', rollbacks: 2 });
    expect(() => hit('four', 'retry-edge', 'verified')).toThrow('already counted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OP keeping original effect demotes a pack after conflicting rollback reaches two in its cycle', () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-feedback-conflict-demote-'));
  try {
    const ledger = new ArgFeedbackLedger(root, identity);
    const hit = (runId: string, effect: string, outcome: 'verified' | 'rollback') => ledger.record({
      runId, signature: main, effect, outcome, at: '2026-11-10T00:00:00Z' });
    hit('one', 'retry-edge', 'verified'); hit('two', 'retry-edge', 'verified');
    ledger.markTemplateCandidate(main, { promotion: promotion('entry'), mrtrDecisionId: 'mrtr-template' });
    ledger.activatePack(main, { packId: 'pack', verified: true, mrtrDecisionId: 'mrtr-pack' });
    hit('three', 'retry-edge', 'rollback');
    hit('four', 'skip-gate', 'rollback');
    expect(ledger.get(main)).toMatchObject({ stage: 'pack', status: 'conflict', packCycleRollbacks: 2 });
    ledger.resolveConflict(main, { decisionId: 'op-keep', approvedBy: 'OP', verified: true, choice: 'original' });
    expect(ledger.get(main)).toMatchObject({ stage: 'candidate', status: 'candidate', packCycleRollbacks: 2 });
    expect(ledger.activePack()).toHaveLength(0);
    expect(ledger.readCommittedOutcome('four', main)).toEqual({ outcome: 'rollback', effect: 'skip-gate' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conflict resolution keeps every used MRTR decision while a new effect earns fresh promotion', () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-feedback-decision-history-'));
  try {
    const ledger = new ArgFeedbackLedger(root, identity);
    const hit = (runId: string, effect: string) => ledger.record({ runId, signature: main, effect,
      outcome: 'verified', at: '2026-11-10T00:00:00Z' });
    hit('one', 'retry-edge'); hit('two', 'retry-edge');
    ledger.markTemplateCandidate(main, { promotion: promotion('old-entry'), mrtrDecisionId: 'mrtr-old-template' });
    hit('three', 'skip-gate');
    ledger.resolveConflict(main, { decisionId: 'op-new', approvedBy: 'OP', verified: true, choice: 'proposed' });
    expect(ledger.get(main)).toMatchObject({ hits: 3, successes: 3, effectSuccesses: 0 });
    hit('four', 'skip-gate'); hit('five', 'skip-gate');
    ledger.markTemplateCandidate(main, { promotion: promotion('new-entry'), mrtrDecisionId: 'mrtr-new-template' });
    expect(() => ledger.activatePack(main, { packId: 'pack', verified: true, mrtrDecisionId: 'mrtr-old-template' })).toThrow('distinct MRTR');
    ledger.activatePack(main, { packId: 'pack', verified: true, mrtrDecisionId: 'mrtr-new-pack' });
    expect(ledger.get(main)?.usedMrtrDecisionIds).toEqual(['mrtr-old-template', 'op-new', 'mrtr-new-template', 'mrtr-new-pack']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
