import { createAppLifecycleEvent } from './app-lifecycle-ledger.js';
import type { AppLifecycleStore } from './app-db.js';
import type { AppSimulationStore } from './app-simulation-db.js';

export interface AppPromoteInput {
  readonly appId: string;
  readonly fingerprint: string;
  readonly receiptId: string;
}

export interface AppPromoteDeps {
  readonly simulations: Pick<AppSimulationStore, 'snapshot'>;
  readonly lifecycle: Pick<AppLifecycleStore, 'appendEvent'>;
  /** Must return the current app-source-snapshot fingerprint for appId. */
  readonly currentFingerprint: (appId: string) => string | null;
  /** The source publication path must use the same cross-process lock. */
  readonly withSourceLock: <T>(appId: string, run: (assertHeld: () => void) => T | Promise<T>) => Promise<T>;
  readonly config?: { readonly appPromoteReceiptTtlMs?: number };
  readonly now?: () => Date;
}

export type AppPromoteResult =
  | { readonly outcome: 'promoted'; readonly appId: string; readonly fingerprint: string; readonly receiptId: string; readonly runId: string }
  | { readonly outcome: 'rejected'; readonly reason: 'app-invalid' | 'receipt-missing' | 'receipt-stale' | 'simulation-failed' | 'operation-failed' };

// Source: OP decision in this task; default is configurable through global.nexus.appPromoteReceiptTtlMs.
export const DEFAULT_APP_PROMOTE_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

function positiveTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid app promotion receipt TTL');
  return value;
}

/** Promote only the exact app source revision with a fresh, passed simulation receipt. */
export async function promoteAppToLive(input: AppPromoteInput, deps: AppPromoteDeps): Promise<AppPromoteResult> {
  if (!APP_ID.test(input.appId) || !FINGERPRINT.test(input.fingerprint) || !input.receiptId.trim()) {
    return { outcome: 'rejected', reason: 'app-invalid' };
  }
  try {
    return await deps.withSourceLock(input.appId, assertLockHeld => {
      const current = deps.currentFingerprint(input.appId);
      const ttlMs = positiveTtl(deps.config?.appPromoteReceiptTtlMs ?? DEFAULT_APP_PROMOTE_RECEIPT_TTL_MS);
      const snapshot = deps.simulations.snapshot(input.appId);
      if (!current || !FINGERPRINT.test(current) || current !== input.fingerprint) {
        return { outcome: 'rejected', reason: 'app-invalid' } as const;
      }
      const receipt = snapshot.receipts.find(row => row.id === input.receiptId && row.appId === input.appId);
      if (!receipt) return { outcome: 'rejected', reason: 'receipt-missing' } as const;
      if (receipt.outcome !== 'passed') return { outcome: 'rejected', reason: 'simulation-failed' } as const;
      if (!receipt.appFingerprint || receipt.appFingerprint !== input.fingerprint || receipt.appFingerprint !== current) {
        return { outcome: 'rejected', reason: 'receipt-stale' } as const;
      }
      const createdAt = Date.parse(receipt.createdAt);
      const now = (deps.now ?? (() => new Date()))().getTime();
      if (!Number.isFinite(createdAt) || createdAt > now || now - createdAt >= ttlMs) {
        return { outcome: 'rejected', reason: 'receipt-stale' } as const;
      }
      const evidence = snapshot.events.some(event => event.appId === input.appId && event.runId === receipt.runId && event.data.receiptId === receipt.id);
      if (!evidence) return { outcome: 'rejected', reason: 'receipt-stale' } as const;
      // There is no await between this ownership check and the synchronous lifecycle append; live lock holders
      // cannot be displaced by stale-age recovery, so source writers remain excluded through this write.
      assertLockHeld();
      deps.lifecycle.appendEvent(createAppLifecycleEvent({ appId: input.appId, action: 'promoted', environment: 'live', actor: 'user',
        appFingerprint: input.fingerprint, runId: receipt.runId, receiptId: receipt.id }));
      return { outcome: 'promoted', appId: input.appId, fingerprint: input.fingerprint, receiptId: receipt.id, runId: receipt.runId } as const;
    });
  } catch {
    return { outcome: 'rejected', reason: 'operation-failed' };
  }
}

export interface AppPromoteRouteDeps {
  readonly simulations?: Pick<AppSimulationStore, 'snapshot'>;
  readonly lifecycle?: Pick<AppLifecycleStore, 'appendEvent'>;
  readonly hasApp: (appId: string) => boolean;
  readonly authorizeOwner: (request: Request, appId: string) => boolean | Promise<boolean>;
  readonly currentFingerprint: (appId: string) => string;
  readonly withSourceLock: AppPromoteDeps['withSourceLock'];
  readonly config: () => { readonly appPromoteReceiptTtlMs?: number };
}

/** Owner-only promotion API. No other route writes the successful `promoted` lifecycle action. */
export function createAppPromoteRoute(deps: AppPromoteRouteDeps): (request: Request) => Promise<Response | undefined> {
  return async request => {
    const match = /^\/v1\/apps\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/promote$/.exec(new URL(request.url).pathname);
    if (!match) return undefined;
    const appId = match[1]!;
    if (request.method.toUpperCase() !== 'POST') return Response.json({ error: 'method-not-allowed' }, { status: 405 });
    let authorized = false;
    try { authorized = await deps.authorizeOwner(request, appId); } catch { /* fail closed */ }
    if (!authorized) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (!deps.hasApp(appId)) return Response.json({ error: 'app-not-found' }, { status: 404 });
    if (!deps.simulations || !deps.lifecycle) return Response.json({ error: 'app-promotion-unavailable' }, { status: 503 });
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: 'invalid-json' }, { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['appId', 'fingerprint', 'receiptId'].includes(key))) {
      return Response.json({ error: 'invalid-input' }, { status: 400 });
    }
    const input = body as Record<string, unknown>;
    if (input.appId !== appId || typeof input.fingerprint !== 'string' || typeof input.receiptId !== 'string') {
      return Response.json({ error: 'invalid-input' }, { status: 400 });
    }
    const result = await promoteAppToLive({ appId, fingerprint: input.fingerprint, receiptId: input.receiptId }, {
      simulations: deps.simulations, lifecycle: deps.lifecycle, currentFingerprint: deps.currentFingerprint,
      withSourceLock: deps.withSourceLock, config: deps.config(),
    });
    return result.outcome === 'promoted'
      ? Response.json({ ok: true, promotion: result }, { headers: { 'cache-control': 'no-store' } })
      : Response.json({ error: result.reason }, { status: result.reason === 'operation-failed' ? 503 : 409,
        headers: { 'cache-control': 'no-store' } });
  };
}
