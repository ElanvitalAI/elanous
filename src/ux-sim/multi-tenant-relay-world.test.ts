import { afterEach, describe, expect, it } from 'bun:test';
import { createMultiTenantRelayWorld, MULTI_TENANT_INVENTORY_SCENARIOS, type MultiTenantRelayWorld } from './multi-tenant-relay-world.js';

const TENANTS = [
  { id: 'alice', apps: ['notes', 'tasks'], trafficLimitBytes: 12, storageLimitBytes: 64, capacity: 1, region: 'west' },
  { id: 'bob', apps: ['notes', 'tasks'], trafficLimitBytes: 32, storageLimitBytes: 128, capacity: 2, region: 'east' },
] as const;

let worlds: MultiTenantRelayWorld[] = [];
afterEach(() => { for (const world of worlds.splice(0)) world.close(); });

async function world(now?: () => number): Promise<MultiTenantRelayWorld> {
  const result = await createMultiTenantRelayWorld(TENANTS, now ? { now } : {});
  worlds.push(result);
  return result;
}

describe('SIM-MULTI-TENANT-GOOGLE-RELAY', () => {
  it('tracks the six MULTI-TENANT-INVENTORY scenario IDs', () => {
    expect(MULTI_TENANT_INVENTORY_SCENARIOS.map(({ id, incidents }) => ({ id, incidents }))).toEqual([
      { id: 'routing', incidents: ['certificate-expired', 'dns-failure', 'relay-disconnected', 'user-machine-down', 'region-outage'] },
      { id: 'app-data-storage', incidents: ['quota-exceeded', 'data-deletion-request'] },
      { id: 'oauth-token-lifecycle', incidents: ['token-expired', 'token-revoked', 'account-suspended'] },
      { id: 'term', incidents: ['user-machine-down', 'region-outage'] },
      { id: 'relay-burst', incidents: ['quota-exceeded', 'cost-spike', 'abuse-reported-and-takedown'] },
      { id: 'receipt-funnel', incidents: ['account-suspended', 'abuse-reported-and-takedown', 'data-deletion-request'] },
    ]);
  });

  it('creates isolated Google OAuth, DNS/certificate, app, relay, storage, drive, quota, capacity and receipt resources', async () => {
    const subject = await world();
    const alice = subject.user('alice')!;
    const bob = subject.user('bob')!;

    expect(subject.externalGoogleCalls).toBe(0);
    expect(subject.externalNetworkCalls).toBe(0);
    expect(alice.homeHost).toBe('alice.elanous.app');
    expect(alice.dnsNames).toContain('alice.elanous.app');
    expect(alice.dnsNames).toContain('notes--alice.elanous.app');
    expect(bob.dnsNames).toContain('notes--bob.elanous.app');
    expect(alice.appHosts.notes).toBe('notes--alice.elanous.app');
    expect(bob.appHosts.notes).toBe('notes--bob.elanous.app');
    expect(alice.limits).toEqual({ trafficBytes: 12, storageBytes: 64, capacity: 1, costMicros: 1_000_000 });
    expect(bob.limits).toEqual({ trafficBytes: 32, storageBytes: 128, capacity: 2, costMicros: 1_000_000 });
    expect(alice.token).not.toBe(bob.token);
    expect(alice.fakeGoogleSubject).not.toBe(bob.fakeGoogleSubject);
    expect(alice.sessionId).not.toBe(bob.sessionId);
    expect(alice.certificateExpiresAt).toBeGreaterThan(Date.now());
    expect(alice.certificateValid).toBe(true);
    expect(subject.dispatch(alice.homeHost)).toEqual({ status: 200, userId: 'alice' });
    expect(subject.dispatch(bob.homeHost)).toEqual({ status: 200, userId: 'bob' });
    expect(subject.dispatch(alice.appHosts.notes!)).toEqual({ status: 200, userId: 'alice', app: 'notes' });
    expect(subject.dispatch(bob.appHosts.notes!)).toEqual({ status: 200, userId: 'bob', app: 'notes' });
    expect(subject.dispatch('unknown.elanous.app').status).toBe(404);
    expect(subject.dispatch('notes--unknown.elanous.app').status).toBe(404);
  });

  it('keeps app database, app storage, drive, OAuth identity, and traffic quota tenant-local', async () => {
    const subject = await world();
    subject.appDataPut('alice', 'notes', 'same-key', 'alice-private-row');
    subject.appDataPut('bob', 'notes', 'same-key', 'bob-private-row');
    expect(subject.appDataGet('alice', 'notes', 'same-key')).toBe('alice-private-row');
    expect(subject.appDataGet('bob', 'notes', 'same-key')).toBe('bob-private-row');
    expect(subject.write('alice', 'notes', 'same.json', 'alice-file')).toBe(201);
    expect(subject.write('bob', 'notes', 'same.json', 'bob-file')).toBe(201);
    expect(subject.read('alice', 'notes', 'same.json')).toBe('alice-file');
    expect(subject.read('bob', 'notes', 'same.json')).toBe('bob-file');
    expect(subject.write('alice', 'notes', 'over-quota.json', 'x'.repeat(65))).toBe(413);
    expect(subject.write('bob', 'notes', 'within-quota.json', 'x'.repeat(65))).toBe(201);
    subject.drivePut('alice', 'same.doc', 'alice-drive');
    subject.drivePut('bob', 'same.doc', 'bob-drive');
    expect(subject.driveGet('alice', 'same.doc')).toBe('alice-drive');
    expect(subject.driveGet('bob', 'same.doc')).toBe('bob-drive');

    expect(subject.spendTraffic('alice', 13)).toBe(429);
    expect(subject.dispatch(subject.user('alice')!.appHosts.notes!, 1).status).toBe(429);
    expect(subject.dispatch(subject.user('bob')!.appHosts.notes!, 1).status).toBe(200);
    expect(subject.receipts().every((row) => !('token' in row) && !('body' in row))).toBe(true);
  });

  it('contains certificate expiry, quota exhaustion, and token revocation to one tenant and proves recovery', async () => {
    const subject = await world();
    const aliceHost = subject.user('alice')!.appHosts.notes!;
    const bobHost = subject.user('bob')!.appHosts.notes!;

    subject.inject('alice', 'certificate-expired');
    expect(subject.user('alice')!.certificateValid).toBe(false);
    expect(subject.dispatch(aliceHost).status).toBe(503);
    expect(subject.dispatch(bobHost).status).toBe(200);
    const expiredAt = subject.user('alice')!.certificateExpiresAt;
    expect(await subject.recover('alice', 'certificate-expired')).toBe(true);
    expect(subject.user('alice')!.certificateValid).toBe(true);
    expect(subject.user('alice')!.certificateExpiresAt).toBeGreaterThan(expiredAt);
    expect(subject.dispatch(aliceHost).status).toBe(200);

    subject.inject('alice', 'quota-exceeded');
    expect(subject.dispatch(aliceHost).status).toBe(429);
    expect(subject.dispatch(bobHost).status).toBe(200);
    expect(await subject.recover('alice', 'quota-exceeded')).toBe(true);
    expect(subject.dispatch(aliceHost).status).toBe(200);

    subject.inject('alice', 'token-revoked');
    const aliceRevokedToken = subject.user('alice')!.token;
    const bobToken = subject.user('bob')!.token;
    expect(subject.dispatch(aliceHost).status).toBe(401);
    expect(subject.user('alice')!.relayConnected).toBe(false);
    expect(subject.dispatch(bobHost).status).toBe(200);
    expect(await subject.recover('alice', 'token-revoked')).toBe(true);
    expect(subject.user('alice')!.relayConnected).toBe(true);
    expect(subject.user('alice')!.token).not.toBe(aliceRevokedToken);
    expect(subject.user('bob')!.token).toBe(bobToken);
    expect(subject.dispatch(aliceHost).status).toBe(200);

    expect(subject.incidents().map(({ incident, userId, isolated, recovered }) => ({ incident, userId, isolated, recovered }))).toEqual([
      { incident: 'certificate-expired', userId: 'alice', isolated: true, recovered: true },
      { incident: 'quota-exceeded', userId: 'alice', isolated: true, recovered: true },
      { incident: 'token-revoked', userId: 'alice', isolated: true, recovered: true },
    ]);
    expect(subject.incidents().map((row) => row.affectedUserIds)).toEqual([['alice'], ['alice'], ['alice']]);
  });

  it('lowers only one tenant storage quota without writing and restores it with all user data intact', async () => {
    const subject = await world();
    expect(subject.write('alice', 'notes', 'existing.json', 'alice-data')).toBe(201);
    const existingData = subject.read('alice', 'notes', 'existing.json');
    const originalQuota = subject.user('alice')!.limits.storageBytes;
    const incident = subject.inject('alice', 'quota-exceeded', 'storage');
    expect(incident).toMatchObject({ resource: 'storage', previousQuotaLimitBytes: 64, affectedUserIds: ['alice'], isolated: true });
    expect(subject.user('alice')!.limits.storageBytes).toBe(9);
    expect(Buffer.byteLength(existingData ?? '')).toBeGreaterThan(subject.user('alice')!.limits.storageBytes);
    expect(subject.user('bob')!.limits.storageBytes).toBe(128);
    expect(subject.write('alice', 'notes', 'blocked.json', 'x')).toBe(413);
    expect(subject.write('bob', 'notes', 'still-open.json', 'ok')).toBe(201);

    expect(await subject.recover('alice', 'quota-exceeded', 'storage')).toBe(true);
    expect(subject.user('alice')!.limits.storageBytes).toBe(originalQuota);
    expect(subject.read('alice', 'notes', 'existing.json')).toBe(existingData);
    expect(subject.read('bob', 'notes', 'still-open.json')).toBe('ok');
    expect(subject.write('alice', 'notes', 'after-recovery.json', 'x')).toBe(201);
    expect(subject.incidents()[0]).toMatchObject({ resource: 'storage', recovered: true, affectedUserIds: ['alice'] });
  });

  it('isolates every configured incident to the affected tenant and provides a working recovery path', async () => {
    const subject = await world();
    const cases = [
      ['dns-failure', 503], ['relay-disconnected', 503], ['user-machine-down', 503],
      ['token-expired', 401], ['account-suspended', 403], ['abuse-reported-and-takedown', 404],
      ['region-outage', 503], ['cost-spike', 429],
    ] as const;
    for (const [incident, blockedStatus] of cases) {
      const aliceBefore = subject.user('alice')!;
      const bobBefore = subject.user('bob')!;
      const incidentRow = subject.inject('alice', incident);
      expect(incidentRow).toMatchObject({ affectedUserIds: ['alice'], isolated: true, recovered: false });
      expect(subject.dispatch(aliceBefore.appHosts.notes!).status).toBe(blockedStatus);
      expect(subject.dispatch(bobBefore.appHosts.notes!).status).toBe(200);
      expect(await subject.recover('alice', incident)).toBe(true);
      expect(subject.dispatch(aliceBefore.appHosts.notes!).status).toBe(200);
      expect(subject.user('bob')).toMatchObject({ token: bobBefore.token, relayConnected: true, region: 'east' });
      expect(subject.incidents().at(-1)).toMatchObject({ recovered: true, affectedUserIds: ['alice'] });
    }
    expect(subject.externalGoogleCalls).toBe(0);
    expect(subject.externalNetworkCalls).toBe(0);
  });

  it('keeps a pending deletion request reversible without deleting data or blocking another tenant', async () => {
    const subject = await world();
    expect(subject.write('alice', 'notes', 'preserve.json', 'keep-me')).toBe(201);
    const before = subject.read('alice', 'notes', 'preserve.json');
    subject.inject('alice', 'data-deletion-request');
    expect(subject.user('alice')!.dataDeletionRequested).toBe(true);
    expect(subject.write('alice', 'notes', 'blocked.json', 'new')).toBe(423);
    expect(subject.write('bob', 'notes', 'ok.json', 'bob-ok')).toBe(201);
    expect(subject.read('alice', 'notes', 'preserve.json')).toBe(before);
    expect(await subject.recover('alice', 'data-deletion-request')).toBe(true);
    expect(subject.user('alice')!.dataDeletionRequested).toBe(false);
    expect(subject.read('alice', 'notes', 'preserve.json')).toBe(before);
    expect(subject.write('alice', 'notes', 'after.json', 'ok')).toBe(201);
    expect(subject.read('bob', 'notes', 'ok.json')).toBe('bob-ok');
  });

  it('marks a region outage shared by tenants in that region instead of claiming false isolation', async () => {
    const subject = await createMultiTenantRelayWorld([
      TENANTS[0], { ...TENANTS[1], region: 'west' },
    ]);
    worlds.push(subject);
    const incident = subject.inject('alice', 'region-outage');
    expect(incident).toMatchObject({ affectedUserIds: ['alice', 'bob'], isolated: false });
    expect(subject.dispatch(subject.user('bob')!.homeHost).status).toBe(503);
    expect(await subject.recover('alice', 'region-outage')).toBe(true);
    expect(subject.dispatch(subject.user('bob')!.homeHost).status).toBe(200);
  });

  it('keeps relay disconnected until every overlapping tenant incident is recovered', async () => {
    const subject = await world();
    const aliceHost = subject.user('alice')!.homeHost;
    subject.inject('alice', 'relay-disconnected');
    subject.inject('alice', 'user-machine-down');
    expect(subject.dispatch(aliceHost).status).toBe(503);
    expect(await subject.recover('alice', 'user-machine-down')).toBe(true);
    expect(subject.user('alice')!.machineOnline).toBe(true);
    expect(subject.user('alice')!.relayConnected).toBe(false);
    expect(subject.dispatch(aliceHost).status).toBe(503);
    expect(await subject.recover('alice', 'relay-disconnected')).toBe(true);
    expect(subject.user('alice')!.relayConnected).toBe(true);
    expect(subject.dispatch(aliceHost).status).toBe(200);
  });

  it('keeps authentication blocked until every overlapping token incident is recovered', async () => {
    const subject = await world();
    const aliceHost = subject.user('alice')!.homeHost;
    subject.inject('alice', 'token-expired');
    subject.inject('alice', 'token-revoked');
    expect(subject.dispatch(aliceHost).status).toBe(401);
    expect(await subject.recover('alice', 'token-revoked')).toBe(true);
    expect(subject.dispatch(aliceHost).status).toBe(401);
    expect(subject.incidents().find((row) => row.incident === 'token-expired')).toMatchObject({ recovered: false });
    expect(await subject.recover('alice', 'token-expired')).toBe(true);
    expect(subject.dispatch(aliceHost).status).toBe(200);
  });

  it('includes a naturally expired tenant when recording token-expiry impact', async () => {
    let nowMs = 0;
    const subject = await createMultiTenantRelayWorld([
      { ...TENANTS[0], tokenTtlMs: 1_000 },
      { ...TENANTS[1], tokenTtlMs: 10 },
    ], { now: () => nowMs });
    worlds.push(subject);
    nowMs = 20;
    const incident = subject.inject('alice', 'token-expired');
    expect(incident.affectedUserIds).toEqual(['alice', 'bob']);
    expect(incident.isolated).toBe(false);
    expect(subject.dispatch(subject.user('bob')!.homeHost).status).toBe(401);
  });

  it('retains a shared regional outage until every active regional incident is recovered', async () => {
    const subject = await createMultiTenantRelayWorld([
      TENANTS[0], { ...TENANTS[1], region: 'west' },
    ]);
    worlds.push(subject);
    subject.inject('alice', 'region-outage');
    subject.inject('bob', 'region-outage');
    expect(await subject.recover('alice', 'region-outage')).toBe(true);
    expect(subject.dispatch(subject.user('alice')!.homeHost).status).toBe(503);
    expect(subject.dispatch(subject.user('bob')!.homeHost).status).toBe(503);
    expect(subject.user('alice')!.relayConnected).toBe(false);
    expect(subject.user('bob')!.relayConnected).toBe(false);
    expect(await subject.recover('bob', 'region-outage')).toBe(true);
    expect(subject.dispatch(subject.user('alice')!.homeHost).status).toBe(200);
    expect(subject.dispatch(subject.user('bob')!.homeHost).status).toBe(200);
  });

  it('rejects ambiguous IDs and quota or capacity settings that are not explicit positive values', async () => {
    await expect(createMultiTenantRelayWorld([{ id: 'bad--id', apps: ['notes'], trafficLimitBytes: 10, storageLimitBytes: 10, capacity: 1 }])).rejects.toThrow('invalid tenant id');
    await expect(createMultiTenantRelayWorld([{ id: 'alice', apps: ['bad--app'], trafficLimitBytes: 10, storageLimitBytes: 10, capacity: 1 }])).rejects.toThrow('invalid app slug');
    await expect(createMultiTenantRelayWorld([{ id: 'alice', apps: ['notes'], trafficLimitBytes: 0, storageLimitBytes: 10, capacity: 1 }])).rejects.toThrow('trafficLimitBytes');
    await expect(createMultiTenantRelayWorld([{ id: 'alice', apps: ['notes'], trafficLimitBytes: 10, storageLimitBytes: 10, capacity: 0 }])).rejects.toThrow('capacity');
  });

  it('reports non-isolation when the same incident is observable in another tenant', async () => {
    const subject = await world();
    subject.inject('bob', 'token-revoked');
    const aliceIncident = subject.inject('alice', 'token-revoked');
    expect(aliceIncident.affectedUserIds).toEqual(['alice', 'bob']);
    expect(aliceIncident.isolated).toBe(false);
  });

  it('rejects duplicate active incidents and allows exactly one token recovery', async () => {
    const subject = await world();
    const originalToken = subject.user('alice')!.token;
    subject.inject('alice', 'token-revoked');
    expect(() => subject.inject('alice', 'token-revoked')).toThrow('already has an active token-revoked incident');
    expect(subject.incidents()).toHaveLength(1);
    expect(await subject.recover('alice', 'token-revoked')).toBe(true);

    const recoveredToken = subject.user('alice')!.token;
    expect(recoveredToken).not.toBe(originalToken);
    expect(await subject.recover('alice', 'token-revoked')).toBe(false);
    expect(subject.user('alice')!.token).toBe(recoveredToken);
    expect(subject.dispatch(subject.user('alice')!.homeHost).status).toBe(200);
  });

  it('reserves a certificate recovery before awaiting renewal so concurrent calls complete once', async () => {
    const subject = await world();
    subject.inject('alice', 'certificate-expired');
    const outcomes = await Promise.all([
      subject.recover('alice', 'certificate-expired'),
      subject.recover('alice', 'certificate-expired'),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(subject.incidents()[0]).toMatchObject({ recovering: false, recovered: true });
    expect(subject.receipts().filter((row) => row.kind === 'recover:certificate-expired')).toHaveLength(1);
    expect(subject.dispatch(subject.user('alice')!.homeHost).status).toBe(200);
  });
});
