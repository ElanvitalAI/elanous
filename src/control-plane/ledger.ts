import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';

export const RESOURCE_KINDS = ['machine', 'instance', 'port-lease', 'exposure', 'universe', 'setup-status', 'image', 'slot-lease'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export interface ResourceRecord {
  id: string;
  kind: ResourceKind;
  machine: string;
  name: string;
  owner: string;
  endpoint?: string;
  attrs: Record<string, unknown>;
  observedAt: number;
  ttlMs: number;
}
export type ResourceView = ResourceRecord & { ageMs: number; expired: boolean };

export class ResourceLedgerError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export class ResourceLedger {
  readonly path: string;

  constructor(root: string = effectiveInstanceRoot()) {
    this.path = join(root, 'control', 'ledger.json');
  }

  private read(): ResourceRecord[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('invalid resource ledger');
      return parsed as ResourceRecord[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private write(rows: ResourceRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, this.path);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* no temporary file */ }
      throw err;
    }
  }

  list(filter: { kind?: string; machine?: string; name?: string } = {}, now = Date.now()): ResourceView[] {
    return this.read().filter(row =>
      (!filter.kind || row.kind === filter.kind) &&
      (!filter.machine || row.machine === filter.machine) &&
      (!filter.name || row.name === filter.name),
    ).map(row => {
      const ageMs = Math.max(0, now - row.observedAt);
      return { ...row, ageMs, expired: ageMs >= row.ttlMs };
    });
  }

  register(record: ResourceRecord, owner: string): ResourceRecord {
    const rows = this.read();
    const index = rows.findIndex(row => row.id === record.id);
    if (index >= 0 && rows[index]!.owner !== owner) throw new ResourceLedgerError(403, 'not-owner');
    const next = { ...record, owner };
    if (index < 0) rows.push(next);
    else rows[index] = next;
    this.write(rows);
    return next;
  }

  /** Select and persist the lowest available lease in a single ledger operation. */
  leaseTestPort(
    request: { machine: string; purpose: string; ttlMs: number; owner: string },
    band: { start: number; end: number },
    now = Date.now(),
    excluded: readonly number[] = [],
  ): ResourceRecord {
    const rows = this.read();
    for (let port = band.start; port <= band.end; port++) {
      if (excluded.includes(port)) continue;
      const id = `port-lease:${port}`;
      const index = rows.findIndex(row => row.id === id);
      const previous = index >= 0 ? rows[index]! : undefined;
      if (previous && (previous.kind !== 'port-lease' || Math.max(0, now - previous.observedAt) < previous.ttlMs)) continue;
      const next: ResourceRecord = {
        id, kind: 'port-lease', machine: request.machine, name: request.purpose, owner: request.owner,
        attrs: { port, purpose: request.purpose, leaseId: randomUUID() }, observedAt: now, ttlMs: request.ttlMs,
      };
      if (index >= 0) rows[index] = next;
      else rows.push(next);
      this.write(rows);
      return next;
    }
    throw new ResourceLedgerError(409, 'no-port');
  }

  renewTestPort(port: number, owner: string, leaseId: string, now = Date.now()): ResourceRecord {
    const id = `port-lease:${port}`;
    const rows = this.read();
    const index = rows.findIndex(row => row.id === id && row.kind === 'port-lease');
    if (index < 0) throw new ResourceLedgerError(404, 'not-found');
    const row = rows[index]!;
    if (row.owner !== owner || !leaseId || row.attrs.leaseId !== leaseId) throw new ResourceLedgerError(403, 'not-owner');
    if (Math.max(0, now - row.observedAt) >= row.ttlMs) throw new ResourceLedgerError(409, 'lease-expired');
    const next = { ...row, observedAt: now };
    rows[index] = next;
    this.write(rows);
    return next;
  }

  deleteTestPort(port: number, owner: string, leaseId: string): void {
    const rows = this.read();
    const index = rows.findIndex(row => row.id === `port-lease:${port}` && row.kind === 'port-lease');
    if (index < 0) throw new ResourceLedgerError(404, 'not-found');
    if (rows[index]!.owner !== owner || !leaseId || rows[index]!.attrs.leaseId !== leaseId) throw new ResourceLedgerError(403, 'not-owner');
    rows.splice(index, 1);
    this.write(rows);
  }

  heartbeat(id: string, owner: string, attrs?: Record<string, unknown>, now = Date.now()): ResourceRecord {
    const rows = this.read();
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) throw new ResourceLedgerError(404, 'not-found');
    const row = rows[index]!;
    if (row.owner !== owner) throw new ResourceLedgerError(403, 'not-owner');
    const next = { ...row, observedAt: now, ...(attrs ? { attrs: { ...row.attrs, ...attrs } } : {}) };
    rows[index] = next;
    this.write(rows);
    return next;
  }

  delete(id: string, owner: string): void {
    const rows = this.read();
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) throw new ResourceLedgerError(404, 'not-found');
    if (rows[index]!.owner !== owner) throw new ResourceLedgerError(403, 'not-owner');
    rows.splice(index, 1);
    this.write(rows);
  }
}
