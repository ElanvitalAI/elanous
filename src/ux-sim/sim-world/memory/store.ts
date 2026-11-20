// D17 sim-memory — the deterministic in-process memory store of the memory sim world (SIM-WORLD-MEMORY · S0).
// Source: seat-state/OP/evidence/20261118/SIM-WORLD-TA-AND-SUPERVISORS-1118.md §1 D17 · port proposal
// seat-state/TC/MEMORY-STORE-PORT.md (to agree with the GRAPH-MEMORY-SCOPES owner) · ideas from draft PR #36722.
//
// Guarantees (each one has a test cell in store.test.ts):
//   G1 three layers: instance is visible to its own run, template to runs of its graph, global to every graph of the tenant.
//   G2 a write always lands in instance; template/global only through promote, and promote needs an approval (who).
//   G3 tenant isolation: nothing crosses tenants, not even key collisions.
//   G4 writes and promotes are serialized in call order; seq and writtenAt come from the injected clock (D7), not Date.now.
//   G5 a writer that dies mid-write leaves no record (all or nothing) and leaves an event.
//   G6 template/global keys are claimed once; a second promote of a live key is refused, never silently merged or lost.
//   G7 expiry follows the injected clock; every row has a scope TTL (instance 1d · template 30d · global 90d, as #36722);
//      ttlMs may only shorten it; expired rows are tombstoned (kept, flagged), never deleted.
//   G8 every refusal and every fault emits an event; an injected store fault is listed by faults() for infra-error verdicts.
//   G9 never more lenient than the real store (#36722 GraphMemoryStore): same id shape rules, secret-looking text refused,
//      1000 rows / 1 MB per scope bucket, read returns at most 10 rows, an identical write is idempotent (same row back).
//   G10 replay: the same call script on the same clock gives a byte-identical snapshot() (no randomness, no wall clock).
// Stricter than #36722 on purpose: template promote also needs an approver, and a live template/global key is claimed
// once (#36722 would insert both). Non-guarantees: no persistence across processes · no ranking/search (visible rows in
// scope then seq order) · no multi-process locking.
// Kernel device contract (SIM-KERNEL-API §4.3): none yet. A contract fixture must be redacted REAL output, and no graph
// memory store ships today (#36722 is a draft); the first landed store adds its fixture and D17 registers against it.
import { createHash } from 'node:crypto';

export type MemoryScope = 'instance' | 'template' | 'global';
export type MemoryErrorCode = 'approval-required' | 'tenant-mismatch' | 'not-found' | 'key-claimed' | 'writer-died' | 'store-fault'
  | 'invalid' | 'sensitive' | 'capacity-exceeded';

/** D7: anything with now() in epoch ms (fake-clock SimClock or the logical clock below). */
export interface MemoryClock { now(): number }

export interface MemoryRecord {
  readonly id: string; readonly seq: number; readonly tenant: string; readonly scope: MemoryScope;
  readonly graphId: string; readonly runId: string; readonly nodeId: string; readonly key: string; readonly text: string;
  readonly writtenAt: string; readonly expiresAt: string | null;
  readonly promotedFrom?: string; readonly approvedBy?: string;
  /** Seat template key space (`seat:<SEAT>`): set only on a template row promoted with a templateKey; visible to that seat only. */
  readonly templateSeat?: string;
}
export interface MemoryWriteInput { tenant: string; graphId: string; runId: string; nodeId: string; key: string; text: string; ttlMs?: number }
export interface MemoryPromoteInput {
  tenant: string; graphId: string; runId: string; nodeId: string; sourceId: string; to: 'template' | 'global';
  approval?: { by: string }; templateKey?: SeatTemplateKey;
}
export interface SeatTemplateKey { readonly namespace: 'seat'; readonly id: string }
export interface MemoryReadInput { tenant: string; graphId: string; runId: string; scopes: readonly MemoryScope[]; templateKey?: SeatTemplateKey }
export interface MemoryEvent { readonly type: string; readonly seq: number; readonly at: string; readonly data: Readonly<Record<string, unknown>> }

/** The storage port the graph runner calls (proposal — MEMORY-STORE-PORT.md). D17 is its sim implementation. */
export interface GraphMemoryStorePort {
  read(input: MemoryReadInput): Promise<readonly MemoryRecord[]>;
  write(input: MemoryWriteInput): Promise<MemoryRecord>;
  promote(input: MemoryPromoteInput): Promise<MemoryRecord>;
  expire(): Promise<number>;
}

export class MemoryStoreError extends Error {
  constructor(readonly code: MemoryErrorCode, message: string) { super(message); this.name = 'MemoryStoreError'; }
}

export function createLogicalClock(startIso: string): MemoryClock & { advance(ms: number): void } {
  let now = Date.parse(startIso);
  if (!Number.isFinite(now)) throw new Error(`logical clock start is not a date: ${startIso}`);
  return { now: () => now, advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('logical clock advance must be a nonnegative finite number');
    now += ms;
  } };
}

// Source: draft #36722 src/graph-runner/graph-memory.ts (the real store's limits; this fake must not be looser).
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TTL_MS: Readonly<Record<MemoryScope, number>> = { instance: 86_400_000, template: 2_592_000_000, global: 7_776_000_000 };
const MAX_ROWS = 1000;
const MAX_BYTES = 1_000_000;
const READ_LIMIT = 10;
const SCOPE_ORDER: readonly MemoryScope[] = ['instance', 'template', 'global'];
const SENSITIVE = /(?:\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|Bearer\s+\S+)|["']?(?:api[_-]?key|password|secret|token|authorization)["']?\s*[:=])/i;
interface Row { record: MemoryRecord; expired: boolean }

export class SimMemoryStore implements GraphMemoryStorePort {
  private rows: Row[] = [];
  private eventLog: MemoryEvent[] = [];
  private faultLog: string[] = [];
  private seq = 0;
  private eventSeq = 0;
  private lock: Promise<void> = Promise.resolve();
  private dieNext = false;
  private failNext = false;

  constructor(private readonly clock: MemoryClock) {}

  /** Scripted condition: the next write dies after staging and before commit. */
  armDeathMidWrite(): void { this.dieNext = true; }
  /** Infra fault: the next write or promote fails as a broken store would. */
  injectStoreFault(): void { this.failNext = true; }
  events(): readonly MemoryEvent[] { return [...this.eventLog]; }
  faults(): readonly string[] { return [...this.faultLog]; }
  /** Every row including tombstones, in commit order. */
  all(): readonly (MemoryRecord & { expired: boolean })[] { return this.rows.map(row => ({ ...row.record, expired: row.expired })); }

  /** Canonical bytes of every row and event: same script + same clock ⇒ identical string (record/replay check). */
  snapshot(): string { return JSON.stringify({ rows: this.all(), events: this.eventLog, faults: this.faultLog }); }
  /** sha256 of one run's live instance rows (M08 resume comparison). */
  instanceDigest(tenant: string, graphId: string, runId: string): string {
    const live = this.rows.filter(row => !row.expired && row.record.scope === 'instance' && row.record.tenant === tenant &&
      row.record.graphId === graphId && row.record.runId === runId).map(row => row.record);
    return createHash('sha256').update(JSON.stringify(live)).digest('hex');
  }

  async read(input: MemoryReadInput): Promise<readonly MemoryRecord[]> {
    this.requireIds('read', [input.tenant, input.graphId, input.runId]);
    const now = this.clock.now();
    if (input.scopes.length === 0 || input.scopes.some(scope => !SCOPE_ORDER.includes(scope)))
      throw this.refuse('invalid', 'memory read refused: invalid', {});
    return this.rows.filter(row => !row.expired && !isPast(row.record.expiresAt, now) && row.record.tenant === input.tenant &&
      input.scopes.includes(row.record.scope) && visible(row.record, input.graphId, input.runId, input.templateKey?.id)).map(row => row.record)
      .sort((a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) || a.seq - b.seq).slice(0, READ_LIMIT);
  }

  write(input: MemoryWriteInput): Promise<MemoryRecord> {
    return this.serialized(async () => {
      this.requireIds('write', [input.tenant, input.graphId, input.runId, input.nodeId, input.key]);
      if (!input.text.trim() || (input.ttlMs !== undefined && !(input.ttlMs > 0 && input.ttlMs <= TTL_MS.instance)))
        throw this.refuse('invalid', 'memory write refused: invalid', { key: input.key });
      if (SENSITIVE.test(input.text) || SENSITIVE.test(input.key)) throw this.refuse('sensitive', 'memory write refused: sensitive', { key: input.key });
      const now = this.clock.now();
      const same = this.rows.find(row => !row.expired && !isPast(row.record.expiresAt, now) && row.record.scope === 'instance' &&
        row.record.tenant === input.tenant && row.record.graphId === input.graphId && row.record.runId === input.runId &&
        row.record.nodeId === input.nodeId && row.record.key === input.key && row.record.text === input.text)?.record;
      if (same) { this.emit('memory.write-deduped', { id: same.id }); return same; }
      this.faultCheck('write', input.key);
      const staged: MemoryRecord = { id: `mem-${this.seq + 1}`, seq: this.seq + 1, tenant: input.tenant, scope: 'instance',
        graphId: input.graphId, runId: input.runId, nodeId: input.nodeId, key: input.key, text: input.text,
        writtenAt: iso(now), expiresAt: iso(now + (input.ttlMs ?? TTL_MS.instance)) };
      this.capacityCheck(staged);
      await Promise.resolve(); // the write is in flight here: staged, not yet committed
      if (this.dieNext) {
        this.dieNext = false;
        this.emit('memory.writer-died', { key: input.key, runId: input.runId });
        throw new MemoryStoreError('writer-died', 'memory write lost: writer died mid-write');
      }
      return this.commit(staged, 'memory.written');
    });
  }

  promote(input: MemoryPromoteInput): Promise<MemoryRecord> {
    return this.serialized(async () => {
      this.requireIds('promote', [input.tenant, input.graphId, input.runId, input.nodeId, input.sourceId]);
      const source = this.rows.find(row => row.record.id === input.sourceId && !row.expired &&
        !isPast(row.record.expiresAt, this.clock.now()))?.record;
      if (!source) throw this.refuse('not-found', 'memory promote refused: not-found', { sourceId: input.sourceId });
      if (source.tenant !== input.tenant) throw this.refuse('tenant-mismatch', 'memory promote refused: tenant-mismatch', { sourceId: input.sourceId });
      if (source.scope !== 'instance' || source.graphId !== input.graphId || source.runId !== input.runId)
        throw this.refuse('not-found', 'memory promote refused: not-found', { sourceId: input.sourceId });
      if (!input.approval || !ID.test(input.approval.by))
        throw this.refuse('approval-required', 'memory promote refused: approval-required', { sourceId: input.sourceId, to: input.to });
      const holder = this.rows.find(row => !row.expired && !isPast(row.record.expiresAt, this.clock.now()) && row.record.scope === input.to && row.record.tenant === input.tenant &&
        row.record.key === source.key && (input.to === 'global' || row.record.graphId === input.graphId) &&
        row.record.templateSeat === (input.to === 'template' ? input.templateKey?.id : undefined))?.record;
      if (holder) throw this.refuse('key-claimed', 'memory promote refused: key-claimed', { key: source.key, holder: holder.id });
      this.faultCheck('promote', source.key);
      const now = this.clock.now();
      const record: MemoryRecord = { ...source, id: `mem-${this.seq + 1}`, seq: this.seq + 1, scope: input.to, nodeId: input.nodeId,
        writtenAt: iso(now), expiresAt: iso(now + TTL_MS[input.to]), promotedFrom: source.id, approvedBy: input.approval.by,
        ...(input.to === 'template' && input.templateKey ? { templateSeat: input.templateKey.id } : {}) };
      this.capacityCheck(record);
      return this.commit(record, 'memory.promoted');
    });
  }

  expire(): Promise<number> {
    return this.serialized(async () => {
      const now = this.clock.now();
      let count = 0;
      for (const row of this.rows) if (!row.expired && isPast(row.record.expiresAt, now)) {
        row.expired = true;
        count++;
        this.emit('memory.expired', { id: row.record.id, key: row.record.key });
      }
      return count;
    });
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lock.then(work);
    this.lock = result.then(() => undefined, () => undefined);
    return result;
  }
  private commit(record: MemoryRecord, type: string): MemoryRecord {
    this.seq = record.seq;
    this.rows.push({ record, expired: false });
    this.emit(type, { id: record.id, scope: record.scope, key: record.key });
    return record;
  }
  private capacityCheck(record: MemoryRecord): void {
    const bucket = this.rows.filter(row => !row.expired && row.record.tenant === record.tenant && row.record.scope === record.scope &&
      (record.scope === 'global' || row.record.graphId === record.graphId) && (record.scope !== 'instance' || row.record.runId === record.runId));
    const bytes = bucket.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row.record)), 0) + Buffer.byteLength(JSON.stringify(record));
    if (bucket.length >= MAX_ROWS || bytes > MAX_BYTES)
      throw this.refuse('capacity-exceeded', 'memory write refused: capacity-exceeded', { scope: record.scope, rows: bucket.length });
  }
  private faultCheck(op: string, key: string): void {
    if (!this.failNext) return;
    this.failNext = false;
    const message = `memory ${op} failed (injected)`;
    this.faultLog.push(message);
    this.emit('memory.fault', { op, key });
    throw new MemoryStoreError('store-fault', message);
  }
  private requireIds(op: string, values: readonly string[]): void {
    if (values.some(value => !ID.test(value))) throw this.refuse('invalid', `memory ${op} refused: invalid`, {});
  }
  private refuse(code: MemoryErrorCode, message: string, data: Record<string, unknown>): MemoryStoreError {
    this.emit('memory.refused', { code, ...data });
    return new MemoryStoreError(code, message);
  }
  private emit(type: string, data: Record<string, unknown>): void {
    this.eventLog.push({ type, seq: ++this.eventSeq, at: iso(this.clock.now()), data });
  }
}

function visible(record: MemoryRecord, graphId: string, runId: string, seat?: string): boolean {
  if (record.scope === 'global') return true;
  if (record.scope === 'template') return record.templateSeat === undefined ? record.graphId === graphId : record.templateSeat === seat;
  return record.graphId === graphId && record.runId === runId;
}
function isPast(expiresAt: string | null, now: number): boolean { return expiresAt !== null && Date.parse(expiresAt) <= now; }
function iso(ms: number): string { return new Date(ms).toISOString(); }
