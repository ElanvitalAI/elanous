import { evaluateHostLeasePolicy, HOST_LEASE_ALTERNATIVE_HOSTS } from './host-lease-policy.js';

export type HostLeaseState = 'active' | 'released' | 'expired';
export type HostLeaseReason = 'invalid-request' | 'request-id-conflict' | 'exclusive-lease-conflict' | 'host-purpose-restricted' | 'lease-not-active' | 'lease-owner-mismatch';
export type HostLeaseEventType = 'lease.requested' | 'lease.granted' | 'lease.denied' | 'lease.released' | 'lease.expired' | 'lease.violation';

export interface HostLeaseRequest {
  requestId: string;
  runId: string;
  requestedBy: string;
  consumer: string;
  purpose: string;
  host: string;
  priority: string;
  expiresAt: string;
  /** Required for the cut-gate-only node-b host. */
  releaseVersion?: string;
}

export interface HostLease {
  leaseId: string;
  request: HostLeaseRequest;
  state: HostLeaseState;
  grantedAt: string;
  expiresAt: string;
  exclusive: boolean;
  releasedAt?: string;
  expiredAt?: string;
}

export interface HostLeaseEvent {
  type: HostLeaseEventType;
  at: string;
  requestId?: string;
  leaseId?: string;
  host: string;
  runId?: string;
  consumer?: string;
  reason?: HostLeaseReason;
  alternatives?: string[];
}

export interface CoordinatorNotice {
  recipient: 'coordinator';
  eventType: HostLeaseEventType;
  at: string;
  requestId?: string;
  leaseId?: string;
  host: string;
  runId?: string;
  reason?: HostLeaseReason;
  alternatives?: string[];
}

export type HostLeaseDecision =
  | { state: 'granted'; lease: HostLease; alternatives: [] }
  | { state: 'released' | 'expired'; lease: HostLease; alternatives: [] }
  | { state: 'denied'; requestId: string; reason: HostLeaseReason; alternatives: string[] };

export interface HostLeaseSimulationOptions { now?: () => Date }


/**
 * In-memory Guardian lease device. It exercises allocation and admission rules without
 * touching a real host, cloud API, Pod pool, or persistent ledger.
 */
export class HostLeaseSimulator {
  private readonly now: () => Date;
  private readonly leases = new Map<string, HostLease>();
  private readonly decisions = new Map<string, HostLeaseDecision>();
  private readonly requests = new Map<string, HostLeaseRequest>();
  private readonly events: HostLeaseEvent[] = [];
  private readonly notices: CoordinatorNotice[] = [];

  constructor(options: HostLeaseSimulationOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  request(request: HostLeaseRequest): HostLeaseDecision {
    this.expireDue();
    const prior = this.decisions.get(request.requestId);
    if (prior) {
      const originalRequest = this.requests.get(request.requestId);
      if (originalRequest && !this.sameRequest(originalRequest, request)) {
        const at = this.now().toISOString();
        this.append({ type: 'lease.denied', at, requestId: request.requestId, host: request.host, runId: request.runId,
          consumer: request.consumer, reason: 'request-id-conflict', alternatives: [] });
        return { state: 'denied', requestId: request.requestId, reason: 'request-id-conflict', alternatives: [] };
      }
      if (prior.state === 'granted') {
        const current = this.leases.get(prior.lease.leaseId);
        if (current) return this.lifecycleDecision(current);
      }
      return this.copyDecision(prior);
    }

    this.requests.set(request.requestId, { ...request });
    const instant = this.now();
    const at = instant.toISOString();
    this.append({ type: 'lease.requested', at, requestId: request.requestId, host: request.host, runId: request.runId, consumer: request.consumer });
    const valid = [request.requestId, request.runId, request.requestedBy, request.consumer, request.purpose, request.host, request.priority]
      .every((value) => typeof value === 'string' && value.trim().length > 0) &&
      typeof request.expiresAt === 'string' && Number.isFinite(Date.parse(request.expiresAt)) && Date.parse(request.expiresAt) > instant.getTime();
    if (!valid) return this.deny(request, 'invalid-request', [], at);

    const policy = evaluateHostLeasePolicy(request);
    if (!policy.allowed) {
      return this.deny(request, policy.reason!, policy.alternatives, at);
    }

    const conflict = [...this.leases.values()].find((lease) => lease.state === 'active' && lease.request.host === request.host &&
      (lease.exclusive || policy.exclusive) && (lease.request.consumer !== request.consumer || lease.request.runId !== request.runId));
    if (conflict) {
      const alternatives = [...HOST_LEASE_ALTERNATIVE_HOSTS].filter((host) => host !== request.host);
      return this.deny(request, 'exclusive-lease-conflict', alternatives, at);
    }

    const lease: HostLease = {
      leaseId: `lease:${request.requestId}`,
      request: { ...request },
      state: 'active',
      grantedAt: at,
      expiresAt: request.expiresAt,
      exclusive: policy.exclusive,
    };
    this.leases.set(lease.leaseId, lease);
    this.append({ type: 'lease.granted', at, requestId: request.requestId, leaseId: lease.leaseId, host: request.host,
      runId: request.runId, consumer: request.consumer });
    const decision: HostLeaseDecision = { state: 'granted', lease: { ...lease, request: { ...lease.request } }, alternatives: [] };
    this.decisions.set(request.requestId, decision);
    return this.copyDecision(decision);
  }

  /** A valid current owner may continue; mismatched or unleased work is recorded as a violation. */
  admit(input: { host: string; leaseId: string; runId: string; consumer: string }): { admitted: boolean; reason?: HostLeaseReason } {
    this.expireDue();
    const lease = this.leases.get(input.leaseId);
    if (lease?.state === 'active' && lease.request.host === input.host && lease.request.runId === input.runId && lease.request.consumer === input.consumer) {
      return { admitted: true };
    }
    const reason: HostLeaseReason = lease?.state === 'active' ? 'lease-owner-mismatch' : 'lease-not-active';
    const at = this.now().toISOString();
    this.append({ type: 'lease.violation', at, leaseId: input.leaseId, host: input.host, runId: input.runId, consumer: input.consumer, reason });
    return { admitted: false, reason };
  }

  release(leaseId: string): boolean {
    this.expireDue();
    const lease = this.leases.get(leaseId);
    if (!lease || lease.state !== 'active') return false;
    const at = this.now().toISOString();
    lease.state = 'released';
    lease.releasedAt = at;
    this.append({ type: 'lease.released', at, requestId: lease.request.requestId, leaseId, host: lease.request.host,
      runId: lease.request.runId, consumer: lease.request.consumer });
    return true;
  }

  /** Expire due leases explicitly; expiry never silently extends a lease. The simulator processes expiry
   * when this method or another stateful/read operation is called; it has no background timer. */
  expireDue(): string[] {
    const now = this.now();
    const expired: string[] = [];
    for (const lease of this.leases.values()) {
      if (lease.state !== 'active' || Date.parse(lease.expiresAt) > now.getTime()) continue;
      lease.state = 'expired';
      lease.expiredAt = now.toISOString();
      expired.push(lease.leaseId);
      this.append({ type: 'lease.expired', at: lease.expiredAt, requestId: lease.request.requestId, leaseId: lease.leaseId,
        host: lease.request.host, runId: lease.request.runId, consumer: lease.request.consumer });
    }
    return expired;
  }

  ledger(): HostLease[] {
    this.expireDue();
    return [...this.leases.values()].map((lease) => ({ ...lease, request: { ...lease.request } }));
  }

  eventLog(): HostLeaseEvent[] { return this.events.map((event) => ({ ...event, alternatives: event.alternatives ? [...event.alternatives] : undefined })); }
  coordinatorNotices(): CoordinatorNotice[] { return this.notices.map((notice) => ({ ...notice, alternatives: notice.alternatives ? [...notice.alternatives] : undefined })); }

  private deny(request: HostLeaseRequest, reason: HostLeaseReason, alternatives: string[], at: string): HostLeaseDecision {
    this.append({ type: 'lease.denied', at, requestId: request.requestId, host: request.host, runId: request.runId,
      consumer: request.consumer, reason, alternatives });
    const decision: HostLeaseDecision = { state: 'denied', requestId: request.requestId, reason, alternatives: [...alternatives] };
    this.decisions.set(request.requestId, decision);
    return this.copyDecision(decision);
  }

  private append(event: HostLeaseEvent): void {
    this.events.push({ ...event, alternatives: event.alternatives ? [...event.alternatives] : undefined });
    if (event.type === 'lease.requested') return;
    this.notices.push({ recipient: 'coordinator', eventType: event.type, at: event.at, requestId: event.requestId,
      leaseId: event.leaseId, host: event.host, runId: event.runId, reason: event.reason,
      alternatives: event.alternatives ? [...event.alternatives] : undefined });
  }

  private copyDecision(decision: HostLeaseDecision): HostLeaseDecision {
    return decision.state === 'denied'
      ? { ...decision, alternatives: [...decision.alternatives] }
      : { ...decision, lease: { ...decision.lease, request: { ...decision.lease.request } }, alternatives: [] };
  }

  private lifecycleDecision(lease: HostLease): HostLeaseDecision {
    const state = lease.state === 'active' ? 'granted' : lease.state;
    return { state, lease: { ...lease, request: { ...lease.request } }, alternatives: [] };
  }

  private sameRequest(a: HostLeaseRequest, b: HostLeaseRequest): boolean {
    return a.requestId === b.requestId && a.runId === b.runId && a.requestedBy === b.requestedBy &&
      a.consumer === b.consumer && a.purpose === b.purpose && a.host === b.host && a.priority === b.priority &&
      a.expiresAt === b.expiresAt && a.releaseVersion === b.releaseVersion;
  }
}

export function createHostLeaseSimulator(options: HostLeaseSimulationOptions = {}): HostLeaseSimulator {
  return new HostLeaseSimulator(options);
}
