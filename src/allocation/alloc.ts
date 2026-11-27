// ALLOCATION-BUDGET — the I/O face of the allocator on the lease ledger. Consumers call these; none of them throws
// (a ledger that cannot be read or written never stalls the caller — the ticket then says «unrecorded»).
//   grant()          reserve → allocator decision → grant | queue rows (one lock) — the router / TA launch / capsules ask here
//   meter()          a placement another component already made (pregate host route): reserve → grant with the allocator's
//                    own view as the reason («would: …») — metering ⊕ shadow, never a new gate
//   release()        actual usage on release (caller numbers · else the ledger's llm-proxy-call rows · else wall clock × slots)
//   reclaimExpired() the guardian (임대관) takes back leases whose TTL passed without a release
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { debug } from '../debug/log.js';
import type { AllocAmount, AllocConsumer, AllocGrantMode, AllocIdentity, AllocLedgerEvent, AllocPurpose, AllocPurposeKind, AllocResource, AllocUsage } from './alloc-events.js';
import { ALLOC_PURPOSE_KINDS } from './alloc-events.js';
import { decideAllocation } from './allocator.js';
import { foldAllocations, type AllocRow, type AllocUsageSnapshot } from './fold.js';
import { resolveCallerIdentity, resolvePurpose, type AllocEnv } from './identity.js';
import { effectivePolicy, normalizeProvider } from './policy.js';

export const DEFAULT_ALLOC_TTL_MS = 60 * 60_000;

export interface AllocDeps {
  readonly path?: string;
  readonly now?: () => Date;
  readonly snapshot?: () => AllocUsageSnapshot | null;
  readonly env?: AllocEnv;
  readonly cwd?: string;
}
export interface GrantInput {
  readonly consumer: AllocConsumer;
  readonly resource: AllocResource;
  readonly amount?: AllocAmount;
  readonly ttlMs?: number;
  readonly purpose?: AllocPurpose | AllocPurposeKind;
  /** cell id / PR / card — attached to the purpose */
  readonly ref?: string;
  /** an identity from a resolver (proxySeatIdentity · resolveCallerIdentity of a child env) — default: this process */
  readonly who?: AllocIdentity;
  /** idempotency: an existing allocation with this id is returned as is (seat-turn hour rows) */
  readonly id?: string;
}
export interface AllocTicket {
  readonly id: string; readonly status: 'granted' | 'queued' | 'closed' | 'unrecorded'; readonly mode?: AllocGrantMode; readonly resource: AllocResource;
  readonly reason: string; readonly etaAt?: string | null; readonly expiresAt?: string; readonly alerts: readonly string[];
  readonly who: AllocIdentity; readonly purpose: AllocPurpose;
}

async function ledgerMod() { return import('../resource-ledger/resource-ledger.js'); }
function ledgerSync(): typeof import('../resource-ledger/resource-ledger.js') {
  return require('../resource-ledger/resource-ledger.js') as typeof import('../resource-ledger/resource-ledger.js');
}
const pathOf = (deps: AllocDeps) => deps.path ?? ledgerSync().resourceLedgerPath();

/** <state>/status/llm-usage.json — the 연료관 snapshot (null = none / unreadable). */
export function liveUsageSnapshot(): AllocUsageSnapshot | null {
  try {
    const { llmUsageCachePath, parseLlmUsageSnapshot } = require('../statusline/sources/llm-usage.js') as typeof import('../statusline/sources/llm-usage.js');
    return parseLlmUsageSnapshot(readFileSync(llmUsageCachePath(), 'utf8'));
  } catch { return null; }
}

/** Host step-down order from the resource-facts census when the policy names none (unpaid · non-HQ · by priority). */
function censusHostOrder(): string[] {
  try {
    const { resourceFacts } = require('../kit/resource-facts/index.js') as typeof import('../kit/resource-facts/index.js');
    return resourceFacts().hosts.filter(h => !h.paid && !h.hq).sort((a, b) => a.priority - b.priority).map(h => h.host);
  } catch { return []; }
}

export const newAllocId = (consumer: AllocConsumer, now: Date): string => `al-${consumer}-${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
const asPurpose = (p: GrantInput['purpose'], ref?: string): AllocPurpose | undefined =>
  p === undefined ? undefined : typeof p === 'string' ? ((ALLOC_PURPOSE_KINDS as readonly string[]).includes(p) ? { kind: p as AllocPurposeKind, ...(ref ? { ref } : {}) } : undefined) : p;

function ticketOf(row: AllocRow): AllocTicket {
  // A released / reclaimed allocation is never handed back as a live grant.
  const status = row.state === 'queued' ? 'queued' : row.state === 'released' || row.state === 'reclaimed' ? 'closed' : 'granted';
  return { id: row.id, status, ...(row.mode ? { mode: row.mode } : {}), resource: row.resource, reason: row.reason ?? row.state, ...(row.etaAt !== undefined ? { etaAt: row.etaAt } : {}),
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}), alerts: row.alerts, who: row.who, purpose: row.purpose };
}

function request(input: GrantInput, deps: AllocDeps, now: Date) {
  const who = input.who ?? resolveCallerIdentity(deps.env ?? process.env, deps.cwd ?? process.cwd());
  const purpose = resolvePurpose({ explicit: asPurpose(input.purpose, input.ref), consumer: input.consumer, who, ...(input.ref ? { ref: input.ref } : {}) });
  const ttlMs = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : DEFAULT_ALLOC_TTL_MS;
  const id = input.id ?? newAllocId(input.consumer, now);
  return { id, who, purpose, ttlMs, amount: (input.amount ?? {}) as AllocAmount, resource: input.resource };
}

function run(input: GrantInput, deps: AllocDeps, metered: boolean): AllocTicket {
  const now = (deps.now ?? (() => new Date()))();
  const req = request(input, deps, now);
  const unrecorded = (reason: string): AllocTicket => ({ id: req.id, status: 'unrecorded', resource: req.resource, reason, alerts: [], who: req.who, purpose: req.purpose });
  try {
    const path = pathOf(deps);
    const snap = (deps.snapshot ?? liveUsageSnapshot)();
    let ticket: AllocTicket | null = null;
    ledgerSync().recordAllocEventsWith(path, events => {
      const rows = foldAllocations(events, now);
      const existing = rows.find(r => r.id === req.id);
      if (existing) { ticket = ticketOf(existing); return []; }
      const base = effectivePolicy(events);
      const policy = base.hostOrder.length ? base : { ...base, hostOrder: censusHostOrder() };
      // A paid request without its own $ estimate reserves the provider's estUsdPerGrant (settled on release) — never unbounded.
      const conf = req.resource.type === 'llm' ? policy.providers[normalizeProvider(req.resource.provider)] : undefined;
      if (req.resource.type === 'llm' && req.amount.usd === undefined && conf?.paid && conf.estUsdPerGrant !== undefined) req.amount = { ...req.amount, usd: conf.estUsdPerGrant };
      const d = decideAllocation(req, rows, policy, snap, now);
      const at = now.toISOString();
      const reserve: AllocLedgerEvent = { event: 'alloc.reserve', at, id: req.id, who: req.who, purpose: req.purpose, resource: req.resource, amount: req.amount, ttlMs: req.ttlMs, consumer: input.consumer };
      const expiresAt = new Date(now.getTime() + req.ttlMs).toISOString();
      if (metered) {
        const would = d.status === 'granted' ? `${d.mode}${d.mode !== 'granted' ? ` (${d.reason})` : ''}` : `queue (${d.reason})`;
        ticket = { id: req.id, status: 'granted', mode: 'granted', resource: req.resource, reason: `metered · allocator would: ${would}`, expiresAt, alerts: d.alerts, who: req.who, purpose: req.purpose };
        return [reserve, { event: 'alloc.grant', at, id: req.id, resource: req.resource, expiresAt, mode: 'granted', reason: ticket.reason.slice(0, 500), alerts: d.alerts }];
      }
      if (d.status === 'granted') {
        ticket = { id: req.id, status: 'granted', mode: d.mode, resource: d.resource, reason: d.reason, expiresAt, alerts: d.alerts, who: req.who, purpose: req.purpose };
        return [reserve, { event: 'alloc.grant', at, id: req.id, resource: d.resource, expiresAt, mode: d.mode, reason: d.reason.slice(0, 500), alerts: d.alerts }];
      }
      ticket = { id: req.id, status: 'queued', resource: req.resource, reason: d.reason, etaAt: d.etaAt, alerts: d.alerts, who: req.who, purpose: req.purpose };
      return [reserve, { event: 'alloc.queue', at, id: req.id, etaAt: d.etaAt, reason: d.reason.slice(0, 500) }];
    });
    const t = ticket as AllocTicket | null;
    if (!t) return unrecorded('ledger write skipped');
    debug.log('alloc', metered ? 'meter' : 'grant', { id: t.id, status: t.status, mode: t.mode, who: `${t.who.kind}:${t.who.id}`, purpose: t.purpose.kind, consumer: input.consumer, reason: t.reason });
    return t;
  } catch (error) {
    const reason = `ledger unavailable: ${error instanceof Error ? error.message : String(error)}`;
    debug.log('alloc', 'unrecorded', { id: req.id, consumer: input.consumer, reason }, { level: 'warn' });
    return unrecorded(reason);
  }
}

/** Ask the allocator (grant · step down · queue · override for P0/cut). Never throws. */
export function grant(input: GrantInput, deps: AllocDeps = {}): AllocTicket { return run(input, deps, false); }
/** Record a placement another component already made (metering ⊕ the allocator's view in shadow). Never throws. */
export function meter(input: GrantInput, deps: AllocDeps = {}): AllocTicket { return run(input, deps, true); }

/** Usage from the ledger's llm-proxy-call rows of the principal seat inside the allocation window. */
function proxyUsage(events: readonly { event: string }[], row: AllocRow, endMs: number): AllocUsage | null {
  const seat = row.who.chain.find(l => l.kind === 'seat')?.id;
  if (!seat || row.resource.type !== 'llm') return null;
  // A call belongs to one allocation only: the window starts after the latest release of this seat that already took
  // proxy calls of the same provider family (overlapping allocations never count a call twice).
  const family = (p: string) => (normalizeProvider(p) === 'openrouter' ? 'routed' : 'direct');
  const mine = family(row.resource.provider);
  const settled = foldAllocations(events, new Date(endMs)).filter(r => r.id !== row.id && r.usage?.basis === 'llm-proxy-call' && r.releasedAt
    && r.resource.type === 'llm' && family(r.resource.provider) === mine && r.who.chain.find(l => l.kind === 'seat')?.id === seat)
    .map(r => Date.parse(r.releasedAt!));
  const startMs = Math.max(Date.parse(row.grantedAt ?? row.reservedAt), ...settled.map(t => t + 1));
  // The proxy names OpenRouter models «vendor/model»; a direct provider's model has no slash.
  const callFamily = (model: string) => (model.includes('/') ? 'routed' : 'direct');
  const calls = events.filter((e): e is { event: 'llm-proxy-call'; at: string; seat: string; model: string; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; costBasis: string } & { event: string } =>
    e.event === 'llm-proxy-call').filter(e => e.seat.toUpperCase() === seat && callFamily(e.model) === mine && Date.parse(e.at) >= startMs && Date.parse(e.at) <= endMs);
  if (!calls.length) return null;
  const sum = (k: 'inputTokens' | 'outputTokens' | 'costUsd') => calls.reduce((s, c) => s + (c[k] ?? 0), 0);
  const billing = calls.every(c => c.costBasis === 'subscription') ? 'subscription' : calls.some(c => c.costBasis === 'reported') ? 'paid' : 'unknown';
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), usd: Math.round(sum('costUsd') * 1e6) / 1e6, billing, basis: 'llm-proxy-call' };
}

/** Release with actual usage. Returns false when the id is unknown or already closed. Never throws. */
export function release(id: string, usage: Omit<AllocUsage, 'basis'> | null = null, deps: AllocDeps & { by?: string } = {}): boolean {
  const now = (deps.now ?? (() => new Date()))();
  try {
    const appended = ledgerSync().recordAllocEventsWith(pathOf(deps), events => {
      const row = foldAllocations(events, now).find(r => r.id === id);
      if (!row || row.state === 'released' || row.state === 'reclaimed') return [];
      const durMin = Math.max(0, now.getTime() - Date.parse(row.grantedAt ?? row.reservedAt)) / 60_000;
      const u: AllocUsage = usage && Object.keys(usage).length ? { ...usage, basis: 'caller' }
        : proxyUsage(events, row, now.getTime())
          ?? (row.resource.type === 'host' ? { cpuMin: Math.round(durMin * row.resource.cpuSlots * 100) / 100, host: row.resource.host, basis: 'wall-clock' } : { basis: 'none' });
      const by = deps.by ?? resolveCallerIdentity(deps.env ?? process.env, deps.cwd ?? process.cwd()).id;
      return [{ event: 'alloc.release', at: now.toISOString(), id, by, usage: u }];
    });
    return appended.length > 0;
  } catch (error) {
    debug.log('alloc', 'release-unrecorded', { id, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    return false;
  }
}

/** The guardian's reclaim: every active allocation past its TTL gets one alloc.reclaim row. Returns the ids. */
export function reclaimExpired(deps: AllocDeps & { by?: string } = {}): string[] {
  const now = (deps.now ?? (() => new Date()))();
  try {
    return ledgerSync().recordAllocEventsWith(pathOf(deps), events => foldAllocations(events, now).filter(r => r.state === 'expired')
      .map((r): AllocLedgerEvent => ({ event: 'alloc.reclaim', at: now.toISOString(), id: r.id, by: deps.by ?? 'loop:guardian', reason: 'ttl-expired' })))
      .map(e => (e as { id: string }).id);
  } catch (error) {
    debug.log('alloc', 'reclaim-failed', { error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    return [];
  }
}

/** Current rows ⊕ effective policy ⊕ usage snapshot (for reports). */
export async function allocView(deps: AllocDeps = {}): Promise<{ events: { event: string }[]; rows: AllocRow[]; policy: ReturnType<typeof effectivePolicy>; snap: AllocUsageSnapshot | null; now: Date }> {
  const r = await ledgerMod();
  const now = (deps.now ?? (() => new Date()))();
  const events = r.readResourceLedger(deps.path ?? r.resourceLedgerPath());
  return { events, rows: foldAllocations(events, now), policy: effectivePolicy(events), snap: (deps.snapshot ?? liveUsageSnapshot)(), now };
}

// ── Adapters for the main consumers (call sites stay one line) ─────────────────────────────────────────────────────

/** LLM router hook (`eln route llm` — built separately): ask before handing a provider/model to a session. */
export function grantLlm(input: { provider: string; model?: string; account?: string; purpose?: AllocPurpose | AllocPurposeKind; ref?: string; estTokens?: number; estUsd?: number; ttlMs?: number; who?: AllocIdentity; consumer?: AllocConsumer }, deps: AllocDeps = {}): AllocTicket {
  return grant({ consumer: input.consumer ?? 'route-llm', resource: { type: 'llm', provider: input.provider, ...(input.model ? { model: input.model } : {}), ...(input.account ? { account: input.account } : {}) },
    amount: { ...(input.estTokens !== undefined ? { tokens: input.estTokens } : {}), ...(input.estUsd !== undefined ? { usd: input.estUsd } : {}) },
    ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}), ...(input.purpose ? { purpose: input.purpose } : {}), ...(input.ref ? { ref: input.ref } : {}), ...(input.who ? { who: input.who } : {}) }, deps);
}

/** Host placement hook (pregate · `eln route host` · TA launch): meter the placement that was made. */
export function meterHost(input: { host: string; cpuSlots?: number; consumer: AllocConsumer; purpose?: AllocPurpose | AllocPurposeKind; ref?: string; estCpuMin?: number; ttlMs?: number; who?: AllocIdentity }, deps: AllocDeps = {}): AllocTicket {
  return meter({ consumer: input.consumer, resource: { type: 'host', host: input.host, cpuSlots: input.cpuSlots ?? 1 },
    amount: input.estCpuMin !== undefined ? { cpuMin: input.estCpuMin } : {}, ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}), ...(input.ref ? { ref: input.ref } : {}), ...(input.who ? { who: input.who } : {}) }, deps);
}
