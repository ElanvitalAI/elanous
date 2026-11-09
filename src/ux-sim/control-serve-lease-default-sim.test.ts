import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runControlServe } from '../cli/control-cli.js';
import { ensureControlTokens } from '../control-plane/server.js';
import { debug } from '../debug/log.js';
import { fileLeaseStore, DEFAULT_TTL_SECONDS } from '../hq/lease.js';
import { readHqLease } from '../hq/hq.js';
import { readRoleLeaseAsync } from '../roles/role-lease-read.js';
import type { RoleLeaseRead } from '../roles/role-lease.js';

function gcsLeaseReader(body: string, observe: (result: RoleLeaseRead) => void = () => {}) {
  return async (bucket: string) => {
    const result = await readRoleLeaseAsync(bucket, { run: async args => args[1] === 'cat'
      ? { code: 0, stdout: body, said: '' }
      : { code: 0, stdout: '5', said: '' } });
    observe(result);
    return result;
  };
}

function currentGcsLeaseReader(renewedAt: number, observe: (result: RoleLeaseRead) => void) {
  return gcsLeaseReader(JSON.stringify({ holder: 'aws1', generation: 7, state: 'held', renewedAt }), observe);
}

function gcsReadBoundary(kind: 'absent' | 'denied', observe: (result: RoleLeaseRead) => void = () => {}) {
  return async (bucket: string) => {
    const result = await readRoleLeaseAsync(bucket, { run: async () => kind === 'absent'
      ? { code: 1, stdout: '', said: 'The following URLs matched no objects or files' }
      : { code: 1, stdout: '', said: 'Permission denied' } });
    observe(result);
    return result;
  };
}

test('WARM-LEASE-PRIMARY-WIRE · production control serve admits valid leases and fences invalid states', async () => {
  const previousRoot = process.env.ELANOUS_STATE_DIR;
  const previousBucket = process.env.ELANOUS_BACKUP_BUCKET;
  const startup: string[] = [];
  const warnings: string[] = [];
  const events: unknown[][] = [];
  let admittedRenewedAt = 0;
  let parsedGcsLease: RoleLeaseRead | undefined;
  const log = spyOn(console, 'log').mockImplementation(line => { startup.push(String(line)); });
  const warn = spyOn(console, 'error').mockImplementation(line => { warnings.push(String(line)); });
  const debugLog = spyOn(debug, 'log').mockImplementation((...args) => { events.push(args); });

  let observedHqResult: ReturnType<typeof readHqLease> | undefined;
  const cases: Array<{ name: string; bucket: boolean; known: boolean; status: number; hq?: boolean; start: (signal: AbortSignal, stateRoot: string) => Promise<void> }> = [
    { name: 'present', bucket: true, known: true, status: 200,
      start: signal => {
        // RoleLeaseDoc producers use Date.now(), so renewedAt is epoch milliseconds.
        admittedRenewedAt = Date.now();
        return runControlServe({ port: '0', machine: 'aws1', read: currentGcsLeaseReader(admittedRenewedAt, result => { parsedGcsLease = result; }), signal });
      } },
    { name: 'absent', bucket: true, known: false, status: 409,
      start: signal => runControlServe({ port: '0', machine: 'aws1', read: gcsReadBoundary('absent'), signal }) },
    { name: 'read failure', bucket: true, known: false, status: 409,
      start: signal => runControlServe({ port: '0', machine: 'aws1', read: gcsReadBoundary('denied'), signal }) },
    { name: 'GCS client expiry metadata', bucket: true, known: false, status: 409,
      start: signal => runControlServe({ port: '0', machine: 'aws1', read: gcsLeaseReader(JSON.stringify({
        holder: 'aws1', generation: 8, state: 'held', renewedAt: Date.now(), expiresAt: Date.now() + 60_000,
      })), signal }) },
    { name: 'malformed GCS lease document', bucket: true, known: false, status: 409,
      start: signal => runControlServe({ port: '0', machine: 'aws1', read: gcsLeaseReader('{not-json'), signal }) },
    { name: 'absent HQ lease', bucket: false, known: false, status: 409, hq: true,
      start: signal => runControlServe({ port: '0', machine: 'aws1', followHqLease: true, hqHostName: 'mbp',
        readHq: () => {
          observedHqResult = readHqLease({ store: { read: () => ({ now: 2_000_000_000, raw: null }), cas: () => false },
            hostPath: join(tmpdir(), 'unused-hq-host'), config: { hostName: 'mbp' } });
          return observedHqResult;
        }, signal }) },
    { name: 'denied HQ lease read', bucket: false, known: false, status: 409, hq: true,
      start: signal => runControlServe({ port: '0', machine: 'aws1', followHqLease: true, hqHostName: 'mbp',
        readHq: () => { throw new Error('Permission denied'); }, signal }) },
    { name: 'malformed HQ lease document', bucket: false, known: false, status: 409, hq: true,
      start: signal => runControlServe({ port: '0', machine: 'aws1', followHqLease: true, hqHostName: 'mbp',
        readHq: () => readHqLease({ store: { read: () => ({ now: 2_000_000_000, raw: '{not-json' }), cas: () => false },
          hostPath: join(tmpdir(), 'unused-hq-host'), config: { hostName: 'mbp' } }), signal }) },
    { name: 'HQ expiresAt metadata does not override TTL', bucket: false, known: true, status: 200, hq: true,
      start: signal => runControlServe({ port: '0', machine: 'aws1', followHqLease: true, hqHostName: 'mbp',
        readHq: () => {
          observedHqResult = readHqLease({ store: { read: () => ({ now: 2_000_000_000, raw: JSON.stringify({
            holder: 'mbp', generation: 7, acquiredAt: 1_999_999_900, renewedAt: 1_999_999_999,
            ttlSeconds: DEFAULT_TTL_SECONDS, expiresAt: 1_900_000_000,
          }) }), cas: () => false }, hostPath: join(tmpdir(), 'unused-hq-host'), config: { hostName: 'mbp' } });
          return observedHqResult;
        }, signal }) },
    { name: 'expired HQ lease', bucket: false, known: false, status: 409, hq: true,
      start: (signal, stateRoot) => {
        // Source: deterministic fake clock and DEFAULT_TTL_SECONDS define the expired-lease boundary.
        const nowSeconds = 2_000_000_000;
        const renewedAt = nowSeconds - DEFAULT_TTL_SECONDS - 1;
        const leasePath = join(stateRoot, 'hq-lease.json');
        writeFileSync(leasePath, JSON.stringify({ holder: 'mbp', generation: 7, acquiredAt: renewedAt, renewedAt, ttlSeconds: DEFAULT_TTL_SECONDS }));
        const read = () => {
          observedHqResult = readHqLease({ store: fileLeaseStore(leasePath, () => nowSeconds),
            hostPath: join(stateRoot, 'hq-host'), config: { hostName: 'mbp' } });
          return observedHqResult;
        };
        return runControlServe({ port: '0', machine: 'aws1', followHqLease: true, hqHostName: 'mbp', readHq: read, signal });
      } },
  ];

  try {
    for (const scenario of cases) {
      const stateRoot = mkdtempSync(join(tmpdir(), 'control-serve-lease-sim-'));
      process.env.ELANOUS_STATE_DIR = stateRoot;
      if (scenario.bucket) process.env.ELANOUS_BACKUP_BUCKET = 'gs://simulated-role-lease';
      else delete process.env.ELANOUS_BACKUP_BUCKET;
      const controller = new AbortController();
      const active = scenario.start(controller.signal, stateRoot);
      try {
        const line = startup.shift()!;
        expect(line, scenario.name).toContain('관제부 127.0.0.1:');
        const port = line.match(/관제부 127\.0\.0\.1:(\d+)/)![1]!;
        const primary = await fetch(`http://127.0.0.1:${port}/v1/primary`);
        expect(await primary.json(), scenario.name).toMatchObject({ known: scenario.known });
        const registration = await fetch(`http://127.0.0.1:${port}/v1/resources/register`, {
          method: 'POST',
          headers: { authorization: `Bearer ${ensureControlTokens(stateRoot).member}`, 'content-type': 'application/json' },
          body: JSON.stringify({ id: scenario.name, kind: 'instance', machine: 'aws1', name: scenario.name, attrs: {}, ttlMs: 30_000 }),
        });
        expect(registration.status, scenario.name).toBe(scenario.status);
        if (scenario.name === 'present') {
          // Source: #36090 RoleLeaseDoc.renewedAt is epoch milliseconds from Date.now().
          expect(admittedRenewedAt).toBeGreaterThan(1_000_000_000_000);
          expect(admittedRenewedAt).toBeLessThanOrEqual(Date.now());
          expect(parsedGcsLease).toEqual({ kind: 'present', doc: {
            holder: 'aws1', generation: 7, state: 'held', renewedAt: admittedRenewedAt,
          } });
        }
        if (scenario.hq && scenario.name === 'absent HQ lease') {
          expect(observedHqResult).toMatchObject({ record: null, ageSeconds: null, expired: null });
        }
        if (scenario.hq && scenario.name === 'HQ expiresAt metadata does not override TTL') {
          expect(observedHqResult).toMatchObject({ ageSeconds: 1, expired: false });
        }
        if (scenario.name === 'expired HQ lease') {
          expect(observedHqResult).toMatchObject({ ageSeconds: DEFAULT_TTL_SECONDS + 1, expired: true });
        }
      } finally {
        controller.abort();
        try { await active; }
        finally { rmSync(stateRoot, { recursive: true, force: true }); }
      }
    }
    expect(warnings).toContain('관제부 primary 임대 미측정: Permission denied');
    expect(warnings).toContain('관제부 primary 임대 미측정: client-side expiration is not supported');
    expect(warnings).toContain('관제부 primary 임대 미측정: invalid lease JSON');
    expect(warnings).toContain('관제부 primary 임대 미측정: HQ lease missing or expired');
    expect(warnings).toContain('관제부 primary 임대 미측정: Permission denied');
    expect(events).toContainEqual(['control.primary', 'lease-observed', expect.objectContaining({ source: 'gcs', kind: 'unmeasured', reason: 'Permission denied' })]);
    expect(events).toContainEqual(['control.primary', 'lease-observed', expect.objectContaining({ source: 'gcs', kind: 'unmeasured', reason: 'client-side expiration is not supported' })]);
    expect(events).toContainEqual(['control.primary', 'lease-observed', expect.objectContaining({ source: 'gcs', kind: 'unmeasured', reason: 'invalid lease JSON' })]);
    expect(events).toContainEqual(['control.primary', 'lease-observed', expect.objectContaining({ source: 'hq', kind: 'unmeasured', reason: 'HQ lease missing or expired' })]);
    expect(startup).toEqual([]);
  } finally {
    debugLog.mockRestore();
    warn.mockRestore();
    log.mockRestore();
    if (previousRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousRoot;
    if (previousBucket === undefined) delete process.env.ELANOUS_BACKUP_BUCKET;
    else process.env.ELANOUS_BACKUP_BUCKET = previousBucket;
  }
}, 30_000);
