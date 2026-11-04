import { ResourceLedger, type ResourceRecord, type ResourceView } from '../control-plane/ledger.js';
import { debug } from '../debug/log.js';

export type InventoryRole = 'ta-parent' | 'train' | 'gate' | 'control' | 'map-reduce' | 'implementation';
export interface InventoryResourceInput {
  id: string; machine: string; name: string; provider: 'local' | 'aws' | 'gcp' | 'azure' | 'oci' | 'container' | 'orbstack';
  purpose?: string; ownerSeat: string; role: InventoryRole; account?: string; region?: string; instanceType?: string;
  hourlyCost?: number; startSignedAt: number; firstWorkAt?: number; expiresAt?: number; lastActivityAt?: number;
  state?: Record<string, unknown>; releaseConditions?: { expiresAt?: number; idleMinutes?: number };
}
export interface DiscoveredInventoryResource { id: string; machine: string; provider: string; name?: string }
export interface InventoryAlert { id: string; reason: 'unregistered' | 'expired' | 'missing-purpose' | 'idle-over-7-days'; message: string }
export interface InventorySnapshot { resources: ResourceView[]; alerts: InventoryAlert[]; estimatedCostToday: number; estimatedCumulativeCost: number; unpricedResources: number }
const NEVER_EXPIRES_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function inventoryAttrs(input: InventoryResourceInput): Record<string, unknown> {
  if (!input.id.trim() || !input.machine.trim() || !input.name.trim() || !input.ownerSeat.trim()) throw new Error('inventory id, machine, name, ownerSeat are required');
  if (!Number.isFinite(input.startSignedAt) || (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt))) throw new Error('inventory timestamps must be finite');
  const hourlyCost = input.hourlyCost ?? 0;
  if (!Number.isFinite(hourlyCost) || hourlyCost < 0) throw new Error('hourlyCost must be a nonnegative finite number');
  const expiryAt = [input.expiresAt, input.releaseConditions?.expiresAt]
    .filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0];
  return {
    inventory: true, provider: input.provider, purpose: input.purpose?.trim() || '', ownerSeat: input.ownerSeat,
    role: input.role, ...(input.account ? { account: input.account } : {}), ...(input.region ? { region: input.region } : {}),
    ...(input.instanceType ? { instanceType: input.instanceType } : {}), hourlyCost: input.hourlyCost === undefined ? null : hourlyCost, startSignedAt: input.startSignedAt,
    ...(input.firstWorkAt === undefined ? {} : { firstWorkAt: input.firstWorkAt }),
    ...(input.lastActivityAt === undefined ? {} : { lastActivityAt: input.lastActivityAt }),
    ...(expiryAt === undefined ? {} : { expiresAt: expiryAt }),
    state: input.state ?? {}, releaseConditions: { ...(expiryAt === undefined ? {} : { expiresAt: expiryAt }), ...(input.releaseConditions?.idleMinutes === undefined ? {} : { idleMinutes: input.releaseConditions.idleMinutes }) },
  };
}
export function registerInventoryResource(input: InventoryResourceInput, ledger = new ResourceLedger(), now = Date.now()): ResourceRecord {
  const attrs = inventoryAttrs(input);
  const expiryAt = typeof attrs.expiresAt === 'number' ? attrs.expiresAt : undefined;
  const ttlMs = expiryAt === undefined ? NEVER_EXPIRES_MS : Math.max(0, expiryAt - now);
  const row = ledger.register({ id: 'fleet:' + input.id, kind: 'fleet-resource', machine: input.machine, name: input.name,
    owner: input.ownerSeat, attrs, observedAt: now, ttlMs }, input.ownerSeat);
  debug.log('fleet.inventory', 'registered', { id: input.id, provider: input.provider, role: input.role });
  return row;
}
/** Create first, then persist to the Nexus ledger; registration failure invokes a safe stop cleanup. */
export async function createRegisteredInventoryResource<T>(
  input: InventoryResourceInput,
  create: () => Promise<T>,
  stopOnRegistrationFailure: () => Promise<void>,
  ledger = new ResourceLedger(),
  now = Date.now(),
): Promise<{ resource: T; record: ResourceRecord }> {
  const resource = await create();
  try {
    return { resource, record: registerInventoryResource(input, ledger, now) };
  } catch (error) {
    try { await stopOnRegistrationFailure(); }
    catch (cleanupError) {
      debug.log('fleet.inventory', 'registration-cleanup-failed', {
        id: input.id, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    throw error;
  }
}

export function unregisterInventoryResource(id: string, ownerSeat: string, ledger = new ResourceLedger(), stoppedAt = Date.now()): void {
  archiveInventoryResource(id, ownerSeat, ledger, stoppedAt);
  debug.log('fleet.inventory', 'unregistered', { id });
}
export function archiveInventoryResource(id: string, ownerSeat: string, ledger = new ResourceLedger(), stoppedAt = Date.now()): ResourceRecord {
  const recordId = id.startsWith('fleet:') ? id : 'fleet:' + id;
  const row = [...ledger.list({ kind: 'fleet-resource' }), ...ledger.list({ kind: 'machine' })]
    .find(candidate => candidate.id === recordId && (candidate.attrs.inventory === true || candidate.attrs.inventory === 'archived'));
  if (!row) throw new Error('inventory resource not found: ' + recordId);
  const hourlyCost = row.attrs.hourlyCost;
  const start = Number(row.attrs.startSignedAt) || row.observedAt;
  const cumulativeCost = typeof hourlyCost === 'number' && Number.isFinite(hourlyCost)
    ? Math.max(0, stoppedAt - start) / 3_600_000 * hourlyCost : null;
  return ledger.heartbeat(recordId, ownerSeat, { inventory: 'archived', stoppedAt, cumulativeCost });
}

export function inspectInventory(ledger = new ResourceLedger(), discovered: readonly DiscoveredInventoryResource[] = [], now = Date.now()): InventorySnapshot {
  const ledgerRows = [
    ...ledger.list({ kind: 'fleet-resource' }, now),
    ...ledger.list({ kind: 'machine' }, now).filter(row => row.attrs.inventory === true || row.attrs.inventory === 'archived'),
  ];
  const resources = ledgerRows.filter(row => row.attrs.inventory === true);
  const costRows = ledgerRows.filter(row => row.attrs.inventory === true || row.attrs.inventory === 'archived');
  const unpricedResources = costRows.filter(row => typeof row.attrs.hourlyCost !== 'number' || !Number.isFinite(row.attrs.hourlyCost)).length;
  const registered = new Set(resources.map(row => row.id.slice('fleet:'.length)));
  const alerts: InventoryAlert[] = [];
  for (const row of resources) {
    const id = row.id.slice('fleet:'.length);
    if (row.expired) alerts.push({ id, reason: 'expired', message: id + ' release deadline passed' });
    if (typeof row.attrs.purpose !== 'string' || !row.attrs.purpose.trim()) alerts.push({ id, reason: 'missing-purpose', message: id + ' has no purpose' });
    const lastActivityAt = typeof row.attrs.lastActivityAt === 'number' ? row.attrs.lastActivityAt : row.observedAt;
    if (now - lastActivityAt > 7 * DAY_MS) alerts.push({ id, reason: 'idle-over-7-days', message: id + ' idle for more than 7 days' });
  }
  for (const item of discovered) if (!registered.has(item.id)) alerts.push({ id: item.id, reason: 'unregistered', message: item.provider + ' resource ' + item.id + ' is outside the inventory' });
  const estimatedCumulativeCost = costRows.reduce((sum, row) => {
    if (row.attrs.inventory === 'archived') {
      const stoppedAt = Number(row.attrs.stoppedAt) || now;
      if (stoppedAt <= now) return sum + (Number(row.attrs.cumulativeCost) || 0);
      const rate = typeof row.attrs.hourlyCost === 'number' ? row.attrs.hourlyCost : 0;
      const start = Number(row.attrs.startSignedAt) || row.observedAt;
      return sum + Math.max(0, now - start) / 3_600_000 * rate;
    }
    const rate = typeof row.attrs.hourlyCost === 'number' ? row.attrs.hourlyCost : 0;
    const start = Number(row.attrs.startSignedAt) || row.observedAt;
    return sum + Math.max(0, now - start) / 3_600_000 * rate;
  }, 0);
  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const estimatedCostToday = costRows.reduce((sum, row) => {
    const rate = typeof row.attrs.hourlyCost === 'number' ? row.attrs.hourlyCost : undefined;
    if (rate === undefined) return sum;
    const from = Math.max(todayStart.getTime(), Number(row.attrs.startSignedAt) || row.observedAt);
    const end = row.attrs.inventory === 'archived' ? Math.min(Number(row.attrs.stoppedAt) || now, now) : now;
    return sum + Math.max(0, end - from) / 3_600_000 * rate;
  }, 0);
  debug.log('fleet.inventory', 'inspected', { resources: resources.length, alerts: alerts.length, estimatedCostToday });
  return { resources, alerts, estimatedCostToday, estimatedCumulativeCost, unpricedResources };
}

/** Stop adapter is injected so tests use fake-cloud-vm and production providers can be added independently. */
export async function stopReleasedInventoryResources(
  snapshot: InventorySnapshot,
  stop: (resource: ResourceRecord) => Promise<void>,
  notifyOwner: (message: string) => Promise<void>,
  now = Date.now(),
  ledger = new ResourceLedger(),
  clock: () => number = Date.now,
): Promise<string[]> {
  const stopped: string[] = [];
  for (const row of snapshot.resources) {
    const conditions = row.attrs.releaseConditions as { expiresAt?: number; idleMinutes?: number };
    const lastActivityAt = Number(row.attrs.lastActivityAt) || row.observedAt;
    const storedExpiry = typeof row.attrs.expiresAt === 'number' ? row.attrs.expiresAt : undefined;
    const expiryAt = [conditions.expiresAt, storedExpiry].filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0];
    const releaseDue = (expiryAt !== undefined && now >= expiryAt)
      || (conditions.idleMinutes !== undefined && now - lastActivityAt >= conditions.idleMinutes * 60_000);
    if (!releaseDue || row.attrs.provider === 'local' || row.attrs.provider === 'container' || row.attrs.provider === 'orbstack') continue;
    try {
      await stop(row);
      const stoppedAt = Math.max(now, clock());
      archiveInventoryResource(row.id, String(row.attrs.ownerSeat || row.owner), ledger, stoppedAt);
      stopped.push(row.id); debug.log('fleet.inventory', 'stopped', { id: row.id, action: 'stop' });
    } catch (error) {
      const message = 'fleet inventory stop failed for ' + row.id + ': ' + (error instanceof Error ? error.message : String(error));
      debug.log('fleet.inventory', 'stop-failed', { id: row.id, message });
      await notifyOwner(message);
    }
  }
  return stopped;
}

