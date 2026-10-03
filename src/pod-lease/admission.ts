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
}

/** FIFO admission across launches sharing this instance. Unknown status never grants a slot. */
export class PodLeaseAdmission {
  private readonly queue: Array<{ resolve: (release: PodLeaseRelease) => void; reject: (error: Error) => void; signal?: AbortSignal; after?: PodLeasePredecessor; onAbort?: () => void; cancelCheck?: () => void; waitReason?: string }> = [];
  private active = 0;
  private limit = 0;
  private checking: Promise<void> | undefined;
  private recheckRequested = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly pollMs: number;

  constructor(private readonly options: PodLeaseAdmissionOptions) {
    this.pollMs = options.pollMs ?? 15_000;
    if (!Number.isFinite(this.pollMs) || this.pollMs <= 0) throw new Error('pod lease pollMs must be positive');
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
      const waiter: (typeof this.queue)[number] = { resolve, reject, signal, after };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          waiter.cancelCheck?.();
          reject(new Error('pod lease admission aborted'));
          this.schedule();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
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
        // No head-of-line blocking: a waiter whose predecessor is not merged yet is skipped and later waiters may admit.
        let index = 0;
        while (this.active < this.limit && index < this.queue.length) {
          const waiter = this.queue[index]!;
          if (waiter.after !== undefined) {
            let state: PredecessorState = 'waiting';
            const controller = new AbortController();
            try {
              const check = this.options.dependencyMerged?.(waiter.after, controller.signal);
              const result = await Promise.race([
                Promise.resolve(check),
                new Promise<PredecessorState>((resolve) => { waiter.cancelCheck = () => { controller.abort(); resolve('waiting'); }; }),
              ]);
              state = result === true ? 'merged' : result === false || result === undefined ? 'waiting' : result;
            } catch {
              // An unavailable dependency state cannot grant admission.
            } finally {
              waiter.cancelCheck = undefined;
            }
            if (!this.queue.includes(waiter)) continue; // aborted while checking
            if (state === 'blocked') {
              this.queue.splice(this.queue.indexOf(waiter), 1);
              if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
              debug.log('pod-lease', 'predecessor-blocked', { after: waiter.after });
              waiter.reject(new Error(`pod lease predecessor blocked: ${String(waiter.after)} was closed without merging`));
              continue;
            }
            if (state !== 'merged') {
              waiter.waitReason = `predecessor-unmerged:${String(waiter.after)}`;
              index++;
              continue;
            }
          }
          this.queue.splice(this.queue.indexOf(waiter), 1);
          if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
          this.active++;
          let released = false;
          waiter.resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            void this.refresh();
          });
        }
        for (const waiter of this.queue.slice(index)) if (!waiter.waitReason?.startsWith('predecessor-')) waiter.waitReason = 'no-free-slot';
      } while (this.recheckRequested && this.queue.length > 0);
    } finally {
      this.checking = undefined;
      this.schedule();
    }
  }

  private schedule(): void {
    if (!this.queue.length) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, this.pollMs);
  }
}
