import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLockSync } from '../storage/file-lock.js';

/** Narrow receipt accepted from a trusted, later graph-memory promotion adapter. */
export type ArgTemplatePromotionReceipt =
  | { readonly resultType: 'input_required' }
  | { readonly resultType: 'complete'; readonly entry: { readonly id: string; readonly scope: 'template';
      readonly provenance: { readonly member: string; readonly universe: string; readonly template: string } } };

export interface ArgSignature { readonly nodeId: string; readonly testName: string; readonly errorSignature: string }
export interface ArgFeedbackIdentity { readonly member: string; readonly universe: 'test' | 'prod'; readonly template: string }
export type ArgFeedbackStage = 'instance' | 'candidate' | 'pack' | 'graph';
export type ArgFeedbackStatus = 'instance' | 'candidate' | 'active' | 'graduated' | 'dormant' | 'retired' | 'conflict';
export type ArgCommittedOutcome = { readonly outcome: 'verified' | 'rollback'; readonly effect: string } | 'absent' | 'unknown';
export interface ArgFeedbackPattern { readonly signature: ArgSignature; readonly effect: string; readonly stage: ArgFeedbackStage;
  readonly status: ArgFeedbackStatus; readonly hits: number; readonly successes: number; readonly rollbacks: number;
  readonly effectSuccesses: number; readonly effectRollbacks: number;
  readonly packCycleRollbacks: number; readonly consistentSuccesses: number; readonly lastSeen: string; readonly successfulRuns: readonly string[];
  readonly seenRuns: readonly string[]; readonly readyForTemplate: boolean; readonly templateEntryId?: string;
  readonly templateMrtrDecisionId?: string; readonly packMrtrDecisionIds?: readonly string[]; readonly opDecisionIds?: readonly string[];
  readonly usedMrtrDecisionIds?: readonly string[];
  readonly packId?: string; readonly graphRevision?: string; readonly mergedPr?: number; readonly conflictEffect?: string }
export interface ArgCutHygiene { readonly retired: number; readonly dormant: number; readonly graduated: number;
  readonly reactivated: number; readonly active: number; readonly candidate: number; readonly conflicts: number }

const key = (signature: ArgSignature): string => JSON.stringify([signature.nodeId, signature.testName, signature.errorSignature]);
const nonempty = (value: string): boolean => typeof value === 'string' && !!value.trim();

/** Durable, identity-partitioned ARG pattern ledger. The caller owns the trusted promotion and MRTR ports. */
export class ArgFeedbackLedger {
  private readonly path: string;
  readonly eventsPath: string;
  private readonly records = new Map<string, ArgFeedbackPattern>();
  private inTransaction = false;
  constructor(root: string, readonly identity: ArgFeedbackIdentity,
    private readonly testHooks?: { readonly beforeSnapshotReplace?: () => void }) {
    if (!nonempty(identity.member) || !nonempty(identity.template) || !['test', 'prod'].includes(identity.universe))
      throw new Error('ARG feedback identity invalid');
    this.path = join(root, 'arg-feedback', createHash('sha256').update(JSON.stringify([identity.universe, identity.member, identity.template])).digest('hex'));
    this.eventsPath = join(this.path, 'events.jsonl');
    this.readCurrent();
  }
  private readCurrent(): void {
    mkdirSync(this.path, { recursive: true, mode: 0o700 });
    withFileLockSync(join(this.path, 'patterns.lock'), () => this.reload());
  }
  private recoverPending(): void {
    const pendingPath = join(this.path, 'pending.json');
    if (!existsSync(pendingPath)) return;
    const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as { eventId: string; event: string; snapshot: string;
      identity: ArgFeedbackIdentity };
    if (!pending.eventId || !pending.event.includes(`"eventId":"${pending.eventId}"`) ||
        pending.identity?.member !== this.identity.member || pending.identity.universe !== this.identity.universe ||
        pending.identity.template !== this.identity.template) throw new Error('ARG feedback pending commit invalid');
    let events = Buffer.alloc(0);
    try { events = readFileSync(this.eventsPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const lastNewline = events.lastIndexOf(10);
    if (events.length && lastNewline !== events.length - 1) {
      const tail = events.subarray(lastNewline + 1);
      if (!Buffer.from(pending.event).subarray(0, tail.length).equals(tail)) throw new Error('ARG feedback audit log has an unrelated incomplete event');
      truncateSync(this.eventsPath, lastNewline + 1);
      events = events.subarray(0, lastNewline + 1);
    }
    if (!events.toString('utf8').split('\n').includes(pending.event.trimEnd()))
      appendFileSync(this.eventsPath, pending.event, { mode: 0o600 });
    const snapshotTemp = join(this.path, `${randomUUID()}.tmp`);
    writeFileSync(snapshotTemp, pending.snapshot, { mode: 0o600, flag: 'wx' });
    this.testHooks?.beforeSnapshotReplace?.();
    renameSync(snapshotTemp, join(this.path, 'patterns.json'));
    unlinkSync(pendingPath);
  }
  private reload(): void {
    this.recoverPending();
    this.records.clear();
    try {
      const saved = JSON.parse(readFileSync(join(this.path, 'patterns.json'), 'utf8')) as { identity: ArgFeedbackIdentity; records: ArgFeedbackPattern[] };
      if (!saved.identity || saved.identity.member !== this.identity.member || saved.identity.universe !== this.identity.universe ||
          saved.identity.template !== this.identity.template || !Array.isArray(saved.records)) throw new Error('ARG feedback partition mismatch');
      for (const record of saved.records) this.records.set(key(record.signature), record);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private transaction<T>(work: () => T): T {
    mkdirSync(this.path, { recursive: true, mode: 0o700 });
    return withFileLockSync(join(this.path, 'patterns.lock'), () => {
      this.reload();
      this.inTransaction = true;
      try { return work(); }
      finally { this.inTransaction = false; }
    });
  }
  private persist(type: string, record?: ArgFeedbackPattern, details: Record<string, unknown> = {}): void {
    const eventId = randomUUID();
    const snapshot = JSON.stringify({ identity: this.identity, records: [...this.records.values()] }) + '\n';
    const event = JSON.stringify({ eventId, type, identity: this.identity, signature: record?.signature,
      status: record?.status, stage: record?.stage, ...details }) + '\n';
    const pendingPath = join(this.path, 'pending.json');
    const pendingTemp = join(this.path, `${randomUUID()}.tmp`);
    writeFileSync(pendingTemp, JSON.stringify({ identity: this.identity, eventId, event, snapshot }), { mode: 0o600, flag: 'wx' });
    renameSync(pendingTemp, pendingPath);
    // The pending journal is authoritative until both the event and snapshot are durable.
    appendFileSync(this.eventsPath, event, { mode: 0o600 });
    const snapshotTemp = join(this.path, `${randomUUID()}.tmp`);
    writeFileSync(snapshotTemp, snapshot, { mode: 0o600, flag: 'wx' });
    this.testHooks?.beforeSnapshotReplace?.();
    renameSync(snapshotTemp, join(this.path, 'patterns.json'));
    unlinkSync(pendingPath);
  }
  get(signature: ArgSignature): ArgFeedbackPattern | undefined { if (!this.inTransaction) this.readCurrent(); return this.records.get(key(signature)); }
  readCommittedOutcome(runId: string, signature: ArgSignature): ArgCommittedOutcome {
    this.readCurrent();
    if (!nonempty(runId)) return 'unknown';
    let events: string;
    try { events = readFileSync(this.eventsPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; throw error; }
    let found: ArgCommittedOutcome = 'absent';
    for (const line of events.split('\n')) {
      if (!line) continue;
      const event = JSON.parse(line) as { type?: string; signature?: ArgSignature; runId?: string;
        outcome?: string; effect?: string };
      if (!['outcome', 'conflict', 'demoted'].includes(event.type ?? '') || event.runId !== runId) continue;
      if (!event.signature) return 'unknown';
      if (key(event.signature) !== key(signature)) continue;
      if (found !== 'absent' || !['verified', 'rollback'].includes(event.outcome ?? '') || !nonempty(event.effect ?? ''))
        return 'unknown';
      found = { outcome: event.outcome as 'verified' | 'rollback', effect: event.effect! };
    }
    return found;
  }
  templateCandidates(): ArgFeedbackPattern[] { if (!this.inTransaction) this.readCurrent(); return [...this.records.values()].filter(record => record.stage === 'candidate' && record.status === 'candidate'); }
  activePack(): ArgFeedbackPattern[] { if (!this.inTransaction) this.readCurrent(); return [...this.records.values()].filter(record => record.stage === 'pack' && record.status === 'active'); }
  private decisionUsed(decisionId: string): boolean {
    return [...this.records.values()].some(record => record.usedMrtrDecisionIds?.includes(decisionId) ||
      record.templateMrtrDecisionId === decisionId ||
      record.packMrtrDecisionIds?.includes(decisionId) || record.opDecisionIds?.includes(decisionId));
  }
  record(input: { readonly runId: string; readonly signature: ArgSignature; readonly effect: string;
    readonly outcome: 'verified' | 'rollback'; readonly at: string }): ArgFeedbackPattern {
    return this.transaction(() => {
    if (!nonempty(input.runId) || !nonempty(input.effect) || Object.values(input.signature).some(value => !nonempty(value)) ||
      !Number.isFinite(Date.parse(input.at))) throw new Error('ARG feedback event invalid');
    const previous = this.get(input.signature);
    if (previous?.seenRuns.includes(input.runId)) throw new Error('ARG feedback run already counted');
    if (previous?.status === 'retired' || previous?.status === 'graduated') throw new Error('ARG feedback pattern is not active');
    if (previous?.status === 'conflict') throw new Error('ARG feedback conflict requires OP decision');
    if (previous && previous.effect !== input.effect) {
      const verified = input.outcome === 'verified';
      const conflict: ArgFeedbackPattern = { ...previous, status: 'conflict', conflictEffect: input.effect,
        hits: previous.hits + 1, successes: previous.successes + (verified ? 1 : 0),
        rollbacks: previous.rollbacks + (verified ? 0 : 1),
        packCycleRollbacks: previous.stage === 'pack' ? previous.packCycleRollbacks + (verified ? 0 : 1) : previous.packCycleRollbacks,
        consistentSuccesses: 0, readyForTemplate: false, lastSeen: input.at,
        successfulRuns: [...previous.successfulRuns, ...(verified ? [input.runId] : [])],
        seenRuns: [...previous.seenRuns, input.runId] };
      this.records.set(key(input.signature), conflict);
      this.persist('conflict', conflict, { runId: input.runId, outcome: input.outcome, effect: input.effect,
        contradictoryEffect: input.effect });
      return conflict;
    }
    const verified = input.outcome === 'verified';
    const record: ArgFeedbackPattern = { signature: input.signature, effect: input.effect,
      stage: previous?.stage ?? 'instance', status: previous?.status === 'dormant' ? (previous.stage === 'pack' ? 'active' : previous.stage === 'candidate' ? 'candidate' : 'instance') : previous?.status ?? 'instance',
      hits: (previous?.hits ?? 0) + 1, successes: (previous?.successes ?? 0) + (verified ? 1 : 0),
      rollbacks: (previous?.rollbacks ?? 0) + (verified ? 0 : 1),
      effectSuccesses: (previous?.effectSuccesses ?? previous?.successes ?? 0) + (verified ? 1 : 0),
      effectRollbacks: (previous?.effectRollbacks ?? previous?.rollbacks ?? 0) + (verified ? 0 : 1),
      packCycleRollbacks: previous?.stage === 'pack' ? (previous.packCycleRollbacks ?? 0) + (verified ? 0 : 1) : 0,
      consistentSuccesses: verified ? (previous?.consistentSuccesses ?? 0) + 1 : 0,
      lastSeen: input.at, successfulRuns: [...(previous?.successfulRuns ?? []), ...(verified ? [input.runId] : [])],
      seenRuns: [...(previous?.seenRuns ?? []), input.runId],
      readyForTemplate: !previous?.templateEntryId && verified &&
        (previous?.effectSuccesses ?? previous?.successes ?? 0) + 1 >= 2 && (previous?.effectRollbacks ?? previous?.rollbacks ?? 0) === 0,
      ...(previous?.templateEntryId ? { templateEntryId: previous.templateEntryId } : {}),
      ...(previous?.templateMrtrDecisionId ? { templateMrtrDecisionId: previous.templateMrtrDecisionId } : {}),
      packMrtrDecisionIds: previous?.packMrtrDecisionIds ?? [],
      opDecisionIds: previous?.opDecisionIds ?? [],
      usedMrtrDecisionIds: previous?.usedMrtrDecisionIds ?? [],
      ...(previous?.packId ? { packId: previous.packId } : {}),
    };
    if (record.stage === 'pack' && record.packCycleRollbacks >= 2) { (record as { stage: ArgFeedbackStage }).stage = 'candidate';
      (record as { status: ArgFeedbackStatus }).status = 'candidate'; }
    this.records.set(key(input.signature), record);
    this.persist(record.stage === 'candidate' && previous?.stage === 'pack' ? 'demoted' : 'outcome', record,
      { runId: input.runId, outcome: input.outcome, effect: input.effect });
    return record;
    });
  }
  markTemplateCandidate(signature: ArgSignature, proof: { readonly promotion: ArgTemplatePromotionReceipt;
    readonly mrtrDecisionId: string }): ArgFeedbackPattern {
    return this.transaction(() => {
    const previous = this.get(signature);
    const promoted = proof.promotion.resultType === 'complete' ? proof.promotion.entry : undefined;
    if (!previous || !previous.readyForTemplate || previous.effectRollbacks !== 0 || previous.stage !== 'instance' ||
      !['instance', 'dormant'].includes(previous.status) ||
      !promoted || promoted.scope !== 'template' || !nonempty(promoted.id) ||
      promoted.provenance.member !== this.identity.member || promoted.provenance.universe !== this.identity.universe ||
      promoted.provenance.template !== this.identity.template || !nonempty(proof.mrtrDecisionId) ||
      this.decisionUsed(proof.mrtrDecisionId))
      throw new Error('ARG template candidate requires two verified runs and MRTR-approved memory promotion');
    const record: ArgFeedbackPattern = { ...previous, stage: 'candidate', status: 'candidate', readyForTemplate: false,
      templateEntryId: promoted.id, templateMrtrDecisionId: proof.mrtrDecisionId,
      usedMrtrDecisionIds: [...(previous.usedMrtrDecisionIds ?? []), proof.mrtrDecisionId] };
    this.records.set(key(signature), record); this.persist('template-candidate', record, { mrtrDecisionId: proof.mrtrDecisionId });
    return record;
    });
  }
  activatePack(signature: ArgSignature, proof: { readonly packId: string; readonly verified: boolean;
    readonly mrtrDecisionId: string }): ArgFeedbackPattern {
    return this.transaction(() => {
    const previous = this.get(signature);
    if (!previous || previous.stage !== 'candidate' || previous.status !== 'candidate' || !previous.templateEntryId ||
      previous.consistentSuccesses < 2 || !proof.verified || !nonempty(proof.packId) || !nonempty(proof.mrtrDecisionId))
      throw new Error('ARG pack activation requires candidate, two consistent successes and MRTR approval');
    if (this.decisionUsed(proof.mrtrDecisionId)) throw new Error('ARG pack activation needs a distinct MRTR decision');
    const record: ArgFeedbackPattern = { ...previous, stage: 'pack', status: 'active', packId: proof.packId, packCycleRollbacks: 0,
      packMrtrDecisionIds: [...(previous.packMrtrDecisionIds ?? []), proof.mrtrDecisionId],
      usedMrtrDecisionIds: [...(previous.usedMrtrDecisionIds ?? []), proof.mrtrDecisionId] };
    this.records.set(key(signature), record); this.persist('pack-active', record, { mrtrDecisionId: proof.mrtrDecisionId });
    return record;
    });
  }
  resolveConflict(signature: ArgSignature, proof: { readonly decisionId: string; readonly approvedBy: 'OP';
    readonly verified: boolean; readonly choice: 'original' | 'proposed' }): ArgFeedbackPattern {
    return this.transaction(() => {
      const previous = this.get(signature);
      if (!previous || previous.status !== 'conflict' || !nonempty(previous.conflictEffect ?? '') ||
          !proof.verified || proof.approvedBy !== 'OP' || !nonempty(proof.decisionId) || this.decisionUsed(proof.decisionId))
        throw new Error('ARG conflict requires a fresh verified OP decision');
      const proposed = proof.choice === 'proposed';
      if (!proposed && proof.choice !== 'original') throw new Error('ARG conflict decision choice invalid');
      const demotePack = !proposed && previous.stage === 'pack' && previous.packCycleRollbacks >= 2;
      const record: ArgFeedbackPattern = { ...previous, effect: proposed ? previous.conflictEffect! : previous.effect,
        stage: proposed ? 'instance' : demotePack ? 'candidate' : previous.stage,
        status: proposed ? 'instance' : demotePack ? 'candidate' : previous.stage === 'pack' ? 'active' : previous.stage === 'candidate' ? 'candidate' : 'instance',
        conflictEffect: undefined, readyForTemplate: proposed ? false : previous.readyForTemplate,
        effectSuccesses: proposed ? 0 : previous.effectSuccesses,
        effectRollbacks: proposed ? 0 : previous.effectRollbacks,
        consistentSuccesses: proposed ? 0 : previous.consistentSuccesses,
        packCycleRollbacks: proposed ? 0 : previous.packCycleRollbacks,
        templateEntryId: proposed ? undefined : previous.templateEntryId,
        templateMrtrDecisionId: previous.templateMrtrDecisionId,
        packId: proposed ? undefined : previous.packId,
        packMrtrDecisionIds: previous.packMrtrDecisionIds ?? [],
        opDecisionIds: [...(previous.opDecisionIds ?? []), proof.decisionId],
        usedMrtrDecisionIds: [...(previous.usedMrtrDecisionIds ?? []), proof.decisionId] };
      this.records.set(key(signature), record);
      this.persist('conflict-resolved', record, { decisionId: proof.decisionId, approvedBy: proof.approvedBy, choice: proof.choice });
      return record;
    });
  }
  graduate(signature: ArgSignature, proof: { readonly graphRevision: string; readonly mergedPr: number;
    readonly deterministic: boolean; readonly minConsistentSuccesses: number }): ArgFeedbackPattern {
    return this.transaction(() => {
    const previous = this.get(signature);
    if (!previous || previous.stage !== 'pack' || previous.status !== 'active' || !proof.deterministic ||
      !nonempty(proof.graphRevision) || !Number.isSafeInteger(proof.mergedPr) || proof.mergedPr <= 0 ||
      !Number.isSafeInteger(proof.minConsistentSuccesses) || proof.minConsistentSuccesses < 2 ||
      previous.consistentSuccesses < proof.minConsistentSuccesses)
      throw new Error('ARG graduation requires deterministic merged graph and consistent successes');
    const record: ArgFeedbackPattern = { ...previous, stage: 'graph', status: 'graduated', graphRevision: proof.graphRevision,
      mergedPr: proof.mergedPr };
    this.records.set(key(signature), record); this.persist('graduated', record, { graphRevision: proof.graphRevision, mergedPr: proof.mergedPr });
    return record;
    });
  }
  auditCut(input: { readonly reachable: readonly ArgSignature[]; readonly observed?: readonly ArgSignature[];
    readonly graphRevisions: readonly string[] }): ArgCutHygiene {
    return this.transaction(() => {
    const reachable = new Set(input.reachable.map(key));
    const observed = new Set((input.observed ?? []).map(key));
    let reactivated = 0;
    const reactivatedIds = new Set<string>();
    for (const [id, previous] of this.records) {
      let record = previous;
      if (record.status === 'retired' && reachable.has(id)) {
        const graphStillCurrent = record.stage === 'graph' && record.graphRevision && input.graphRevisions.includes(record.graphRevision);
        const graphRolledBack = record.stage === 'graph' && !graphStillCurrent;
        const stage: ArgFeedbackStage = graphRolledBack ? 'pack' : record.stage;
        const status: ArgFeedbackStatus = record.conflictEffect ? 'conflict' : graphStillCurrent ? 'graduated'
          : graphRolledBack ? 'active' : observed.has(id)
            ? stage === 'pack' ? 'active' : stage === 'candidate' ? 'candidate' : 'instance'
            : 'dormant';
        record = { ...record, stage, status,
          ...(graphRolledBack ? { graphRevision: undefined, mergedPr: undefined, packCycleRollbacks: 0 } : {}) };
        if (graphRolledBack) reactivated++;
        reactivatedIds.add(id);
        this.records.set(id, record); this.persist('restored', record, { reason: 'signature reachable again' });
        continue;
      }
      if (record.status === 'graduated' && record.graphRevision && !input.graphRevisions.includes(record.graphRevision)) {
        record = { ...record, stage: 'pack', status: 'active', graphRevision: undefined, mergedPr: undefined,
          packCycleRollbacks: 0 };
        reactivated++; reactivatedIds.add(id); this.records.set(id, record); this.persist('reactivated', record);
      }
      if (!reachable.has(id) && record.status !== 'retired') {
        record = { ...record, status: 'retired' }; this.records.set(id, record); this.persist('retired', record, { reason: 'signature unreachable' });
      } else if (reachable.has(id) && !reactivatedIds.has(id) && record.status !== 'graduated' && record.status !== 'retired' && record.status !== 'conflict') {
        const status: ArgFeedbackStatus = observed.has(id) ? (record.stage === 'pack' ? 'active' : record.stage === 'candidate' ? 'candidate' : 'instance') : 'dormant';
        if (record.status !== status) { record = { ...record, status }; this.records.set(id, record); this.persist(status, record); }
      }
    }
    const values = [...this.records.values()];
    const count = (status: ArgFeedbackStatus) => values.filter(record => record.status === status).length;
    const report = { retired: count('retired'), dormant: count('dormant'), graduated: count('graduated'),
      reactivated, active: count('active'), candidate: count('candidate'), conflicts: count('conflict') };
    this.persist('pack-hygiene', undefined, report);
    return report;
    });
  }
}
