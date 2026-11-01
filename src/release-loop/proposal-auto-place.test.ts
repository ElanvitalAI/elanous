import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFunnelCandidates, type FunnelOptions } from '../intake-plane/requirement-funnel.js';
import type { IntakeItem } from '../intake-plane/items.js';
import { ConsensusEngine } from '../loops/consensus.js';
import type { Checklist } from './checklist.js';
import type { ReleaseSchedule } from './release-schedule.js';
import { planAgreedProposalPlacement } from './proposal-auto-place.js';

test('proposal auto-placement waits for both roots, then produces a rubric-ranked dry-run without moving a cell', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'proposal-auto-place-'));
  const now = new Date('2026-11-01T01:00:00.000Z');
  const rawText = 'Add a private fixture for release candidate planning.\n루브릭: A1 E1 R1 D0 M1 B0 S1 X1';
  const intake: IntakeItem = {
    id: 'proposal-fixture-1', source: 'note', sources: ['note'], kind: 'note', title: rawText,
    text: rawText, observedAt: now.toISOString(), lastSeenAt: now.toISOString(), signals: {}, privacy: 'public',
    status: 'new', outputs: [],
  };
  const [rubricCandidate] = collectFunnelCandidates({ directives: [], intakeItems: [intake], cards: [] });
  expect(rubricCandidate).toMatchObject({ id: intake.id, score: 6, grade: 'P3' });

  const schedules: ReleaseSchedule[] = [
    { version: '0.2.44', cutAt: '2026-11-02T00:00:00.000Z', landBy: '2026-11-02T00:00:00.000Z', updatedAt: now.toISOString(), updatedBy: 'fixture' },
    { version: '0.2.45', cutAt: '2026-11-04T00:00:00.000Z', landBy: '2026-11-04T00:00:00.000Z', updatedAt: now.toISOString(), updatedBy: 'fixture' },
    { version: '0.2.46', cutAt: '2026-11-06T00:00:00.000Z', landBy: '2026-11-06T00:00:00.000Z', updatedAt: now.toISOString(), updatedBy: 'fixture' },
  ];
  const snapshots: Checklist[] = schedules.map(({ version }) => ({ version, released: '0.2.43', dev: '0.2.45-dev.0', items: [], history: [] }));
  const before = structuredClone(snapshots);
  const funnel: Omit<FunnelOptions, 'ledger' | 'adopt' | 'mode' | 'placement'> = {
    sources: { coordination: [{ id: intake.id, text: rawText, link: `intake:${intake.id}`, receivedAt: now.toISOString(),
      priority: 'P2', risk: 0.1, cost: 0, security: 0, license: 'MIT', patentPrivatePath: false, owner: 'TC' }] },
    cells: [], now, allowedLicenses: ['MIT'], dailyCap: 5,
  };
  const placement = {
    now, schedules, released: '0.2.43', merged24h: 50, seatCap: { TC: 100 }, ceoDailyCap: 30, dryRun: true,
    checklist: (version: string) => snapshots.find(snapshot => snapshot.version === version)
      ?? { version, released: '0.2.43', dev: '0.2.45-dev.0', items: [], history: [] },
  };

  try {
    const consensus = new ConsensusEngine({ stateDir, now: () => now, resolveVersion: () => ({ released: null, dev: null, codename: null }) });
    const proposal = consensus.propose({ by: 'coordinator', category: 'period-budget', title: rawText.split('\n')[0]!, factId: intake.id,
      cost: '0 · mock placement only', undo: 'dry-run has no checklist writes' });
    const args = { funnel, rubricCandidate: rubricCandidate!, consensus, consensusProposalId: proposal.id, placement };

    expect(planAgreedProposalPlacement({ ...args, rubricCandidate: { ...rubricCandidate!, score: null, grade: null } }))
      .toMatchObject({ status: 'not-eligible', reason: 'candidate has no explicit rubric' });
    expect(planAgreedProposalPlacement({ ...args, rubricCandidate: { ...rubricCandidate!, title: 'different claim' } }))
      .toMatchObject({ status: 'not-eligible', reason: 'rubric candidate title does not match funnel source' });
    expect(planAgreedProposalPlacement({ ...args, rubricCandidate: { ...rubricCandidate!, score: 5, grade: 'P3' } }))
      .toMatchObject({ status: 'not-eligible', reason: 'rubric score or grade does not match funnel source' });
    expect(planAgreedProposalPlacement({ ...args, funnel: { ...funnel, sources: { coordination: [] } } }))
      .toMatchObject({ status: 'not-eligible', reason: `funnel candidate not found: ${intake.id}` });
    expect(planAgreedProposalPlacement({ ...args, funnel: { ...funnel, sources: { coordination: [{
      id: intake.id, text: rawText, link: `intake:${intake.id}`, receivedAt: now.toISOString(),
      priority: 'P2', risk: 1.1, cost: 0, security: 0, license: 'MIT', patentPrivatePath: false, owner: 'TC',
    }] } } })).toMatchObject({ status: 'not-eligible', decision: { status: 'proposal' } });
    const noOwnerFunnel = { ...funnel, sources: { coordination: [{
      id: intake.id, text: rawText, link: `intake:${intake.id}`, receivedAt: now.toISOString(),
      priority: 'P2' as const, risk: 0.1, cost: 0, security: 0, license: 'MIT', patentPrivatePath: false,
    }] } };
    expect(planAgreedProposalPlacement({ ...args, consensusProposalId: 'missing' }))
      .toMatchObject({ status: 'awaiting-consensus', consensusProposalId: 'missing' });
    expect(planAgreedProposalPlacement(args)).toMatchObject({ status: 'awaiting-consensus', consensusProposalId: proposal.id });
    consensus.agree(proposal.id, { by: 'guardian', claim: 'rubric and capacity fit the planned release' });
    expect(planAgreedProposalPlacement({ ...args, rubricCandidate: { ...rubricCandidate!, score: 0, grade: 'P4' } }))
      .toMatchObject({ status: 'not-eligible', reason: 'rubric score or grade does not match funnel source' });
    expect(planAgreedProposalPlacement({ ...args, funnel: noOwnerFunnel }))
      .toMatchObject({ status: 'not-eligible', reason: 'funnel candidate owner is missing' });
    const result = planAgreedProposalPlacement(args);

    expect(result).toMatchObject({
      status: 'planned', rubric: { score: 6, grade: 'P3' },
      consensus: { id: proposal.id, status: 'agreed', proposedBy: 'coordinator', agreedBy: 'guardian' },
      decision: { status: 'would-adopt', candidate: { id: intake.id } },
      placement: { id: intake.id, version: '0.2.46', from: null },
    });
    expect(snapshots).toEqual(before);

    const selfAgreedConsensus = { show: () => ({ ...consensus.show(proposal.id), reviews: [
      { by: 'coordinator' as const, verdict: 'agree' as const, at: now.toISOString(), roundTrip: 1, claim: 'self approval' },
    ] }) };
    expect(planAgreedProposalPlacement({ ...args, consensus: selfAgreedConsensus }))
      .toMatchObject({ status: 'awaiting-consensus', consensusProposalId: proposal.id });
    const thresholdConsensus = { show: () => ({ ...consensus.show(proposal.id), thresholds: ['money' as const] }) };
    expect(planAgreedProposalPlacement({ ...args, consensus: thresholdConsensus }))
      .toMatchObject({ status: 'awaiting-consensus', consensusProposalId: proposal.id });
    const categoryMismatchConsensus = { show: () => ({ ...consensus.show(proposal.id), category: 'shadow-live-promotion' as const }) };
    expect(planAgreedProposalPlacement({ ...args, consensus: categoryMismatchConsensus }))
      .toMatchObject({ status: 'awaiting-consensus', consensusProposalId: proposal.id });
    const factMismatchConsensus = { show: () => ({ ...consensus.show(proposal.id), factId: 'other-candidate' }) };
    expect(planAgreedProposalPlacement({ ...args, consensus: factMismatchConsensus }))
      .toMatchObject({ status: 'awaiting-consensus', consensusProposalId: proposal.id });
    const titleMismatchConsensus = { show: () => ({ ...consensus.show(proposal.id), title: 'other title' }) };
    expect(planAgreedProposalPlacement({ ...args, consensus: titleMismatchConsensus }))
      .toMatchObject({ status: 'awaiting-consensus', consensusProposalId: proposal.id });
    appendFileSync(consensus.ledgerPath, '{invalid event}\n');
    expect(() => planAgreedProposalPlacement(args)).toThrow('invalid consensus ledger event');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
