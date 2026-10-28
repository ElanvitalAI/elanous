import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { SUPPLY_AXES, type LiveSupplySnapshot, type SupplyAxis, type SupplyEvent, type SupplyProbes, type SupplySourceState, type SupplyValues } from './snapshot.js';

export interface SupplyCollectorOptions {
  directory?: string;
  now?: () => number;
  intervalMs?: number;
  probeTimeoutMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

function readLatest(path: string): LiveSupplySnapshot | null {
  try {
    const row = JSON.parse(readFileSync(path, 'utf8')) as LiveSupplySnapshot;
    return row.version === 1 && Number.isSafeInteger(row.sequence) ? row : null;
  } catch { return null; }
}

/** A failed source retains its last value only with a stale label. Each tick commits before it publishes events. */
export class LiveSupplyCollector {
  readonly directory: string;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly setInterval: typeof globalThis.setInterval;
  private readonly clearInterval: typeof globalThis.clearInterval;
  private latest: LiveSupplySnapshot | null;
  private hasFreshTick = false;
  private pending: Promise<LiveSupplySnapshot> | null = null;
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(private readonly probes: SupplyProbes, options: SupplyCollectorOptions = {}) {
    this.directory = options.directory ?? join(getElanousConfigDir(), 'live-supply');
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 10_000;
    this.setInterval = options.setInterval ?? globalThis.setInterval;
    this.clearInterval = options.clearInterval ?? globalThis.clearInterval;
    this.latest = readLatest(join(this.directory, 'latest.json'));
  }

  /** Disk cache is diagnostic until a fresh tick; a restart never silently blesses old measurements. */
  read(): LiveSupplySnapshot | null {
    if (!this.latest) return null;
    if (this.hasFreshTick && Date.parse(this.latest.expiresAt) > this.now()) return this.latest;
    return {
      ...this.latest,
      sources: Object.fromEntries(SUPPLY_AXES.map(axis => [axis, {
        ...this.latest!.sources[axis],
        status: this.latest!.sources[axis].status === 'measured' ? 'stale' : this.latest!.sources[axis].status,
      }])) as LiveSupplySnapshot['sources'],
    };
  }

  async start(): Promise<LiveSupplySnapshot> {
    const first = await this.tick();
    if (this.timer === null) this.timer = this.setInterval(() => { void this.tick().catch(() => {}); }, this.intervalMs);
    return first;
  }

  stop(): void {
    if (this.timer !== null) this.clearInterval(this.timer);
    this.timer = null;
  }

  tick(): Promise<LiveSupplySnapshot> {
    if (this.pending) return this.pending;
    const work = this.collect();
    this.pending = work;
    void work.finally(() => { if (this.pending === work) this.pending = null; }).catch(() => {});
    return work;
  }

  private async collect(): Promise<LiveSupplySnapshot> {
    const previous = this.latest;
    const at = new Date(this.now()).toISOString();
    const sources = {} as LiveSupplySnapshot['sources'];
    const values: Partial<SupplyValues> = {};
    const results = await Promise.all(SUPPLY_AXES.map(async axis => {
      try { return { axis, value: await this.withTimeout(this.probes[axis]()), error: null }; }
      catch (error) { return { axis, value: null, error: error instanceof Error ? error.message : 'probe-failed' }; }
    }));
    for (const result of results) {
      const axis = result.axis;
      if (result.error === null && result.value !== null) {
        (values as Record<SupplyAxis, unknown>)[axis] = result.value;
        sources[axis] = { status: 'measured', observedAt: at, reason: null };
      } else {
        const oldValue = previous?.values[axis];
        if (oldValue !== undefined) (values as Record<SupplyAxis, unknown>)[axis] = oldValue;
        const oldAt = previous?.sources[axis]?.observedAt ?? null;
        sources[axis] = { status: oldValue === undefined ? 'unknown' : 'stale', observedAt: oldAt, reason: this.safeReason(result.error) };
      }
    }
    const snapshot: LiveSupplySnapshot = {
      version: 1, sequence: (previous?.sequence ?? 0) + 1, observedAt: at,
      expiresAt: new Date(this.now() + this.intervalMs).toISOString(), sources, values,
    };
    const events = this.events(previous, snapshot);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const latestPath = join(this.directory, 'latest.json');
    const tempPath = join(this.directory, `.latest.${process.pid}.${snapshot.sequence}.tmp`);
    try {
      appendFileSync(join(this.directory, 'snapshots.jsonl'), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
      writeFileSync(tempPath, JSON.stringify(snapshot), { mode: 0o600 });
      renameSync(tempPath, latestPath);
      this.latest = snapshot;
      this.hasFreshTick = true;
    } catch (error) {
      // The pointer must never claim freshness after an unsuccessful commit.
      this.latest = previous;
      throw error;
    }
    if (events.length) appendFileSync(join(this.directory, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
    return snapshot;
  }

  private withTimeout<T>(value: Promise<T> | T): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(new Error('probe-timeout')), this.probeTimeoutMs);
      Promise.resolve(value).then(
        result => { globalThis.clearTimeout(timer); resolve(result); },
        error => { globalThis.clearTimeout(timer); reject(error); },
      );
    });
  }

  private safeReason(reason: string | null): string {
    if (reason === 'probe-timeout') return reason;
    return reason === null ? 'probe-unmeasured' : 'probe-failed';
  }

  private events(previous: LiveSupplySnapshot | null, next: LiveSupplySnapshot): SupplyEvent[] {
    const rows: SupplyEvent[] = [];
    for (const axis of SUPPLY_AXES) {
      const before = previous?.sources[axis] as SupplySourceState | undefined;
      const after = next.sources[axis];
      if (after.status !== 'measured' && (before?.status !== after.status || before?.reason !== after.reason)) {
        rows.push({ kind: 'supply.unmeasured', sequence: next.sequence, axis, from: before?.status ?? 'unknown', to: after.status, reason: after.reason, observedAt: next.observedAt });
      } else if (before && (before.status !== after.status || JSON.stringify(previous?.values[axis]) !== JSON.stringify(next.values[axis]))) {
        rows.push({ kind: 'supply.changed', sequence: next.sequence, axis, from: before.status, to: after.status, reason: null, observedAt: next.observedAt });
      }
    }
    return rows;
  }
}
