import { debug } from '../debug/log.js';
import type { PoolLeaseRecommendation } from '../task-orchestrator/surfaces/pod-lease.js';
import type { PredecessorState } from './dependency-state.js';

/** A release belongs to one admitted launch and is idempotent. */
export type PodLeaseRelease = () => void;

/** A goal ID or PR number that must be merged before admission. */
export type PodLeasePredecessor = string | number;

export interface PodLeaseAdmissionOptions {
  /** The same recommendation returned by pod lease status, for the launch pool. */
  status: () => PoolLeaseRecommendation | Promise<PoolLeaseRecommendation>;
  /** Predecessor state: merged admits · waiting stays queued (unknown/error too) · blocked rejects. A boolean means merged/waiting. */
  dependencyMerged?: (after: PodLeasePredecessor, signal?: AbortSignal) => PredecessorState | boolean | Promise<PredecessorState | boolean>;
  /** Recheck even when there are no local releases (another launcher may free a slot). */
  pollMs?: number;
  /** Maximum time spent waiting for a free slot; defaults to 30 minutes (predecessor waits do not count). */
  maxWaitMs?: number;
}

/** FIFO admission across launches sharing this instance. Unknown status never grants a slot. */
export class PodLeaseAdmission {
  private readonly queue: Array<{ resolve: (release: PodLeaseRelease) => void; reject: (error: Error) => void; signal?: AbortSignal; after?: PodLeasePredecessor; onAbort?: () => void; cancelCheck?: () => void; checkingDependency?: boolean; predecessorMerged?: boolean; waitReason?: string; waitStartedAt?: number }> = [];
  private active = 0;
  private limit = 0;
  private checking: Promise<void> | undefined;
  private recheckRequested = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pollMs: number;
  private readonly maxWaitMs: number;

  constructor(private readonly options: PodLeaseAdmissionOptions) {
    this.pollMs = options.pollMs ?? 15_000;
    this.maxWaitMs = options.maxWaitMs ?? 30 * 60_000;
    if (!Number.isFinite(this.pollMs) || this.pollMs <= 0) throw new Error('pod lease pollMs must be positive');
    if (!Number.isFinite(this.maxWaitMs) || this.maxWaitMs <= 0) throw new Error('pod lease maxWaitMs must be positive');
  }

  /** Queue view: each waiting item says why it waits (predecessor not merged yet, or no free slot). */
  snapshot(): { active: number; queued: number; recommended: number; waiting: Array<{ after?: PodLeasePredecessor; reason: string }> } {
    return { active: this.active, queued: this.queue.length, recommended: this.limit,
      waiting: this.queue.map((w) => ({ ...(w.after !== undefined ? { after: w.after } : {}), reason: w.waitReason ?? 'no-free-slot' })) };
  }

  /** A launch stays queued until an admitted slot can be reserved. */
  acquire(signal?: AbortSignal, after?: PodLeasePredecessor): Promise<PodLeaseRelease> {
    if (signal?.aborted) return Promise.reject(new Error('pod lease admission aborted'));
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.queue)[number] = { resolve, reject, signal, after,
        ...(after === undefined ? { waitStartedAt: Date.now(), waitReason: 'no-free-slot' }
          : { waitReason: `predecessor-unmerged:${String(after)}` }) };
      if (signal) {
        waiter.onAbort = () => {
          if (!this.removeWaiter(waiter)) return;
          reject(new Error('pod lease admission aborted'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.scheduleExpiry();
      void this.refresh();
    });
  }

  /** Re-evaluate the measured recommended N; never use accountSlots as an admission bound. */
  refresh(): Promise<void> {
    if (this.checking) {
      if (this.queue.length) this.recheckRequested = true;
      return this.checking;
    }
    if (!this.queue.length) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.checking = this.checkUntilCurrent();
    return this.checking;
  }

  private async checkUntilCurrent(): Promise<void> {
    try {
      do {
        this.recheckRequested = false;
        try {
          const status = await this.options.status();
          this.limit = status.recommended !== null && Number.isSafeInteger(status.recommended) && status.recommended >= 0
            ? status.recommended : 0;
        } catch {
          this.limit = 0;
        }
        // Start independent predecessor checks before admitting eligible waiters in queue order.
        // A slow predecessor cannot reserve a slot or delay a follower's admission decision.
        this.expireWaiters();
        const checks = this.queue.filter((waiter) => waiter.after !== undefined && !waiter.checkingDependency && !waiter.predecessorMerged)
          .map((waiter) => this.checkPredecessor(waiter));
        if (checks.length) {
          // Let ready states settle, but do not hold a free slot for an unanswered dependency check.
          await Promise.race([Promise.all(checks), new Promise<void>((resolve) => { setTimeout(resolve, 0); })]);
        }
        this.expireWaiters();
        let index = 0;
        while (index < this.queue.length) {
          const waiter = this.queue[index]!;
          if (waiter.after !== undefined && !waiter.predecessorMerged) {
            index++;
            continue;
          }
          if (this.active >= this.limit) {
            waiter.waitReason = 'no-free-slot';
            index++;
            continue;
          }
          this.removeWaiter(waiter);
          this.active++;
          let released = false;
          waiter.resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            void this.refresh();
          });
        }
      } while (this.recheckRequested && this.queue.length > 0);
    } finally {
      this.checking = undefined;
      this.scheduleExpiry();
      this.schedule();
    }
  }

  private async checkPredecessor(waiter: (typeof this.queue)[number]): Promise<void> {
    waiter.checkingDependency = true;
    const controller = new AbortController();
    let state: PredecessorState = 'waiting';
    try {
      const check = this.options.dependencyMerged?.(waiter.after!, controller.signal);
      const result = await Promise.race([
        Promise.resolve(check),
        new Promise<PredecessorState>((resolve) => { waiter.cancelCheck = () => { controller.abort(); resolve('waiting'); }; }),
      ]);
      state = result === true ? 'merged' : result === false || result === undefined ? 'waiting' : result;
    } catch {
      // An unavailable dependency state cannot grant admission.
    } finally {
      waiter.cancelCheck = undefined;
      waiter.checkingDependency = false;
    }
    if (!this.queue.includes(waiter)) return;
    if (state === 'blocked') {
      this.removeWaiter(waiter);
      debug.log('pod-lease', 'predecessor-blocked', { after: waiter.after });
      waiter.reject(new Error(`pod lease predecessor blocked: ${String(waiter.after)} was closed without merging`));
    } else if (state === 'merged') {
      waiter.predecessorMerged = true;
      waiter.waitStartedAt = Date.now();
      waiter.waitReason = 'no-free-slot';
      this.scheduleExpiry();
      void this.refresh();
    } else {
      waiter.waitReason = `predecessor-unmerged:${String(waiter.after)}`;
      waiter.waitStartedAt = undefined;
    }
  }

  private expireWaiters(): void {
    const now = Date.now();
    for (let index = 0; index < this.queue.length;) {
      const waiter = this.queue[index]!;
      if (waiter.waitReason !== 'no-free-slot' || waiter.waitStartedAt === undefined ||
          now - waiter.waitStartedAt <= this.maxWaitMs) {
        index++;
        continue;
      }
      this.removeWaiter(waiter);
      const waitedMs = now - waiter.waitStartedAt;
      const reason = waiter.waitReason;
      debug.log('pod-lease', 'admit-starved', { waitedMs, reason, after: waiter.after });
      waiter.reject(new Error(`pod lease admit-starved: waited ${Math.round(waitedMs / 60_000)}m · reason ${reason}`));
    }
    this.scheduleExpiry();
  }

  /** Every queue exit also updates both timers; an empty queue must retain no timer. */
  private removeWaiter(waiter: (typeof this.queue)[number]): boolean {
    const index = this.queue.indexOf(waiter);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.cancelCheck?.();
    this.scheduleExpiry();
    if (!this.checking || this.queue.length === 0) this.schedule();
    return true;
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const now = Date.now();
    let delay = Infinity;
    for (const waiter of this.queue) {
      if (waiter.waitReason === 'no-free-slot' && waiter.waitStartedAt !== undefined) {
        delay = Math.min(delay, Math.max(1, waiter.waitStartedAt + this.maxWaitMs - now + 1));
      }
    }
    if (Number.isFinite(delay)) {
      this.expiryTimer = setTimeout(() => {
        this.expiryTimer = undefined;
        this.expireWaiters();
      }, delay);
    }
  }

  private schedule(): void {
    if (!this.queue.length) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, this.pollMs);
  }
}
