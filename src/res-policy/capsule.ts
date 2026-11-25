// RES-POLICY-GUARDIAN — «resource judgment capsule»: when the RES tab is dormant, judgment is a short subagent spawned on
// demand with the policy and the lease ledger injected (LOOP-AGENTS §1a: spawn → answer → end; nothing resident).
import type { ResourceLedgerEvent } from '../resource-ledger/resource-ledger.js';
import { activeResourceLeases, slotLeaseRecords } from '../resource-ledger/resource-ledger.js';
import type { PatrolHost } from './patrol.js';
import type { ResPolicy } from './policy.js';
import { shadowRows } from './shadow.js';

export interface CapsuleInput {
  readonly question: string;
  readonly policy: ResPolicy;
  readonly events: readonly ResourceLedgerEvent[];
  readonly hosts: readonly PatrolHost[];
  readonly pregateInflight: Readonly<Record<string, number>>;
  readonly now: Date;
}

/** The capsule brief: question first, then the facts it may use. Pure (tests read it as text). */
export function buildResCapsuleBrief(input: CapsuleInput): string {
  const slots = slotLeaseRecords(input.events).filter((record) => record.state === 'active' || record.state === 'queued')
    .map((record) => ({ leaseId: record.leaseId, kind: record.kind, host: record.host, consumer: record.consumer, state: record.state, expiresAt: record.expiresAt }));
  const leases = activeResourceLeases(input.events).map((lease) => ({ id: lease.id, host: lease.host, lane: lease.lane, ttlMs: lease.ttlMs, heartbeatAt: lease.heartbeatAt }));
  const recent = shadowRows(input.events).slice(-20);
  return [
    '# RES resource judgment capsule',
    '',
    `Asked at ${input.now.toISOString()}. You stand in for the dormant RES seat for ONE question, then finish.`,
    '',
    '## Question',
    input.question.trim(),
    '',
    '## How to answer',
    '- Decide from the policy below first. If the policy already answers, say which rule and stop.',
    '- Otherwise give one verdict: allow | deny | ask(👑), the reason in one line, and the policy change RES should make (if any).',
    '- Money above the daily VM cap and security changes are 👑 decisions: answer «ask».',
    '- Record your verdict: `eln res shadow record --action <action> --host <host> --decision <allow|deny|ask> --ref capsule`.',
    '',
    '## Policy (single source · `eln res policy show`)',
    '```json', JSON.stringify(input.policy, null, 2), '```',
    '',
    '## Hosts (latest heartbeat ≤ 15 min)',
    '```json', JSON.stringify(input.hosts, null, 2), '```',
    '',
    '## Pregate runs in flight',
    '```json', JSON.stringify(input.pregateInflight), '```',
    '',
    '## Lease ledger — active slot leases',
    '```json', JSON.stringify(slots, null, 2), '```',
    '',
    '## Lease ledger — active resource leases',
    '```json', JSON.stringify(leases, null, 2), '```',
    '',
    '## Recent RES decisions (guardian ⊕ RES tab)',
    '```json', JSON.stringify(recent, null, 2), '```',
    '',
  ].join('\n');
}
