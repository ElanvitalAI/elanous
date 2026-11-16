import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { openPrivateDatabase } from './app-kill-switch.js';

/** Private operator projection, separate from public-read and from member authority.
 * OP72803 / TC PUBLIC-APP-VISITOR-WRITE-0326: explicit app/path/method/rate limits. */
export interface PublicAppVisitorWritePolicy {
  readonly user: string;
  readonly app: string;
  readonly serverId: string;
  readonly paths: readonly string[];
  readonly method: 'POST';
  readonly expiresAt: string;
  readonly requestsPerMinute: number;
  readonly maxBodyBytes: number;
}

// Same startup I/O bound as the public-read projection. Bodies stay well below
// the relay mux frame limit; the 24h authority ceiling follows deployment grants.
const MAX_BYTES = 64 * 1024;
const MAX_POLICY_MS = 24 * 60 * 60 * 1000;
// Source: #73292 policy renewal must never clear replay or recent rate history.
// OP75220: replay tombstones and rolling admission capacity are independent.
// Renewal and restart must not expire replay history. Old admissions stop
// occupying per-app capacity after the rate window. OP75248 approves a fixed
// acceptedAt-based replay window equal to the existing 24h policy ceiling.
const MAX_RECEIPTS = 10_000;
const MINUTE_MS = 60_000;
const REPLAY_RETENTION_MS = MAX_POLICY_MS;
const fail = (): never => { throw new Error('invalid visitor write policy'); };
const safePath = (path: string) => path.startsWith('/api/') && path.length <= 256
  && /^\/api\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(path);

export function validateVisitorWritePolicy(value: unknown, now = Date.now()): PublicAppVisitorWritePolicy {
  if (!Number.isSafeInteger(now)) return fail();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== 'app,expiresAt,maxBodyBytes,method,paths,requestsPerMinute,serverId,user'
    || typeof row.user !== 'string' || !/^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/u.test(row.user)
    || row.user.includes('--') || typeof row.app !== 'string'
    || !/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/u.test(row.app) || row.app.includes('--')
    || typeof row.serverId !== 'string' || !/^[a-f0-9]{64}$/u.test(row.serverId)
    || row.method !== 'POST' || !Array.isArray(row.paths) || !row.paths.length
    || row.paths.some(path => typeof path !== 'string' || !safePath(path))
    || new Set(row.paths).size !== row.paths.length
    || typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))
    || Date.parse(row.expiresAt) <= now || Date.parse(row.expiresAt) > now + MAX_POLICY_MS
    || !Number.isSafeInteger(row.requestsPerMinute) || Number(row.requestsPerMinute) < 1
    || Number(row.requestsPerMinute) > MAX_RECEIPTS
    || !Number.isSafeInteger(row.maxBodyBytes) || Number(row.maxBodyBytes) < 1
    || Number(row.maxBodyBytes) > MAX_BYTES) return fail();
  return Object.freeze({ ...row, paths: Object.freeze([...row.paths]) }) as unknown as PublicAppVisitorWritePolicy;
}

export function loadPublicAppVisitorWriteConfig(path: string): readonly PublicAppVisitorWritePolicy[] {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') return fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES
      || process.getuid && stat.uid !== process.getuid()) return fail();
    const raw = Buffer.alloc(MAX_BYTES + 1); let bytes = 0;
    while (bytes < raw.length) {
      const count = readSync(fd, raw, bytes, raw.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    const after = fstatSync(fd);
    if (bytes > MAX_BYTES || bytes !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return fail();
    const value: unknown = JSON.parse(raw.subarray(0, bytes).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).join() !== 'apps' || !Array.isArray((value as { apps: unknown }).apps)) return fail();
    const policies = (value as { apps: unknown[] }).apps.map(item => validateVisitorWritePolicy(item));
    if (new Set(policies.map(row => row.user + '/' + row.app)).size !== policies.length) return fail();
    return Object.freeze(policies);
  } finally { closeSync(fd); }
}

/** Atomic durable replay/rate admission. No credentials or request bodies are stored. */
export function createVisitorWriteLedger(path: string, stateRoot: string) {
  const opened = openPrivateDatabase(path, stateRoot);
  const { db } = opened;
  try {
    db.exec('PRAGMA synchronous = FULL');
    db.exec(`CREATE TABLE IF NOT EXISTS visitor_write_receipt (
      app TEXT NOT NULL, request_hash TEXT NOT NULL, accepted_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, PRIMARY KEY(app, request_hash))`);
    db.exec('CREATE INDEX IF NOT EXISTS visitor_write_app_time ON visitor_write_receipt(app, accepted_at)');
    db.exec('CREATE INDEX IF NOT EXISTS visitor_write_time ON visitor_write_receipt(accepted_at)');
  } catch (error) {
    db.close(); closeSync(opened.descriptor); closeSync(opened.parentDescriptor); throw error;
  }
  let closed = false;
  return {
    retainPolicy(policy: PublicAppVisitorWritePolicy, now: number) {
      if (closed || !Number.isSafeInteger(now) || now >= Date.parse(policy.expiresAt)) throw new Error('visitor ledger unavailable');
      // Validate installation without rewriting tombstone lifetime. The service
      // may have been offline when this policy was renewed.
    },
    admit(policy: PublicAppVisitorWritePolicy, key: string, now: number): 'allowed' | 'replay' | 'limited' | 'unavailable' {
      if (closed || !Number.isSafeInteger(now) || now >= Date.parse(policy.expiresAt)) return 'unavailable';
      const app = policy.user + '/' + policy.app;
      // The key is app-wide so changing a path/body cannot replay the same intent.
      const hash = createHash('sha256').update(key).digest('hex');
      try {
        db.exec('BEGIN IMMEDIATE');
        let result: 'allowed' | 'replay' | 'limited' | 'unavailable' = 'allowed';
        const latest = db.query('SELECT MAX(accepted_at) AS at FROM visitor_write_receipt').get() as { at: number | null };
        if (!Number.isSafeInteger(now) || latest.at !== null && now < latest.at) result = 'unavailable';
        else {
          // Policy expiry/renewal is unrelated to replay retention, including
          // renewal while the relay was offline. Reclaim only outside the fixed window.
          db.query('DELETE FROM visitor_write_receipt WHERE app = ? AND accepted_at <= ?')
            .run(app, now - REPLAY_RETENTION_MS);
          if (db.query('SELECT 1 FROM visitor_write_receipt WHERE app = ? AND request_hash = ?').get(app, hash)) result = 'replay';
          else {
            const count = db.query('SELECT COUNT(*) AS n FROM visitor_write_receipt WHERE app = ? AND accepted_at > ?')
              .get(app, now - MINUTE_MS) as { n: number };
            if (count.n >= Math.min(policy.requestsPerMinute, MAX_RECEIPTS)) result = 'limited';
            else db.query('INSERT INTO visitor_write_receipt VALUES (?, ?, ?, ?)')
              .run(app, hash, now, Date.parse(policy.expiresAt));
          }
        }
        db.exec('COMMIT');
        return result;
      } catch {
        try { db.exec('ROLLBACK'); } catch { /* Preserve refusal, never reset the ledger. */ }
        return 'unavailable';
      }
    },
    close() {
      if (closed) return;
      closed = true;
      db.close(); closeSync(opened.descriptor); closeSync(opened.parentDescriptor);
    },
  };
}
export type VisitorWriteLedger = ReturnType<typeof createVisitorWriteLedger>;

export type VisitorWriteDecision = { readonly status: 'not-applicable' }
  | { readonly status: 'refused'; readonly response: Response }
  | { readonly status: 'allowed'; readonly body: Uint8Array };

/** Called only after public hostname→tenant→pinned server dispatch resolves.
 * Application business permissions and booking uniqueness remain app-owned. */
export function createPublicAppVisitorWriteGate(policies: readonly PublicAppVisitorWritePolicy[], ledger: VisitorWriteLedger,
  now: () => number = Date.now) {
  const byApp = new Map<string, PublicAppVisitorWritePolicy>();
  for (const value of policies) {
    const policy = validateVisitorWritePolicy(value, now());
    const key = policy.user + '/' + policy.app;
    if (byApp.has(key)) return fail();
    ledger.retainPolicy(policy, now());
    byApp.set(key, policy);
  }
  const refused = (status: number, reason: string): VisitorWriteDecision => ({ status: 'refused',
    response: Response.json({ error: reason }, { status, headers: { 'cache-control': 'no-store' } }) });
  return async (request: Request, user: string, app: string, serverId: string,
    expectedOrigin: string): Promise<VisitorWriteDecision> => {
    const policy = byApp.get(user + '/' + app);
    const url = new URL(request.url);
    if (!policy || request.method !== policy.method || !policy.paths.includes(url.pathname)) return { status: 'not-applicable' };
    if (policy.serverId !== serverId || now() >= Date.parse(policy.expiresAt)) return refused(403, 'visitor-policy-expired-or-mismatched');
    if (url.search || !safePath(url.pathname) || request.headers.has('upgrade')
      || !expectedOrigin.startsWith('https://') || request.headers.get('origin') !== expectedOrigin
      || request.headers.get('sec-fetch-site') !== 'same-origin'
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get('content-type') ?? '')) {
      return refused(403, 'visitor-origin-or-request-refused');
    }
    const key = request.headers.get('idempotency-key') ?? '';
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(key)) return refused(400, 'visitor-idempotency-required');
    const length = request.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > policy.maxBodyBytes)) return refused(413, 'visitor-body-too-large');
    const reader = request.body?.getReader();
    if (!reader) return refused(400, 'visitor-json-required');
    const chunks: Uint8Array[] = []; let size = 0;
    // Same five-second I/O deadline as the deployment grant HTTP adapter.
    const timeout = AbortSignal.timeout(5_000);
    const cancel = () => { void reader.cancel().catch(() => {}); };
    timeout.addEventListener('abort', cancel, { once: true });
    request.signal.addEventListener('abort', cancel, { once: true });
    try {
      while (!timeout.aborted && !request.signal.aborted) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > policy.maxBodyBytes) { await reader.cancel(); return refused(413, 'visitor-body-too-large'); }
        chunks.push(part.value);
      }
      if (timeout.aborted || request.signal.aborted) return refused(408, 'visitor-body-timeout');
      const body = Buffer.concat(chunks);
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return refused(400, 'visitor-json-required');
      if (now() >= Date.parse(policy.expiresAt)) return refused(403, 'visitor-policy-expired-or-mismatched');
      const admission = ledger.admit(policy, key, now());
      if (admission !== 'allowed') return refused(admission === 'replay' ? 409 : admission === 'limited' ? 429 : 503,
        'visitor-' + admission);
      return { status: 'allowed', body };
    } catch { return refused(400, 'visitor-json-required'); }
    finally {
      timeout.removeEventListener('abort', cancel); request.signal.removeEventListener('abort', cancel); reader.releaseLock();
    }
  };
}
