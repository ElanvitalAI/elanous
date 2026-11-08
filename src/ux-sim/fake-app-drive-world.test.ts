import { describe, expect, test } from 'bun:test';
import {
  DriveReadContractError,
  GOOGLE_DRIVE_FILES_LIST_FIELDS,
  GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
  type DriveTenantAccess,
} from '../nexus/apps/drive-contract.js';
import { createFakeAppDriveWorld } from './fake-app-drive-world.js';

const file = (id: string, name = 'same-name.txt') => ({
  id,
  name,
  mimeType: 'text/plain',
  modifiedTime: '2026-11-07T00:00:00.000Z',
});

const identity = (subject: string) => ({ issuer: 'https://accounts.example.test', subject });

describe('APP-WEB-DRIVE-TENANT fake world', () => {
  test('binds identical file names and opaque page tokens to separate issuer/subject tenants', async () => {
    const world = createFakeAppDriveWorld();
    try {
      const a = world.createAccount({ identity: identity('subject-a'), files: [file('a-1'), file('a-2')] });
      const b = world.createAccount({ identity: identity('subject-b'), files: [file('b-1'), file('b-2')] });

      const aFirst = await world.port.listFiles({ auth: a.auth, pageSize: 1 });
      const bFirst = await world.port.listFiles({ auth: b.auth, pageSize: 1 });
      expect(a.tenantKey).not.toBe(b.tenantKey);
      expect(aFirst.files.map(item => item.id)).toEqual(['a-1']);
      expect(bFirst.files.map(item => item.id)).toEqual(['b-1']);
      expect(aFirst.files[0]?.name).toBe(bFirst.files[0]?.name);
      expect(aFirst.nextPageToken).toBeDefined();
      expect(bFirst.nextPageToken).toBeDefined();

      await expect(world.port.listFiles({ auth: b.auth, pageSize: 1, pageToken: aFirst.nextPageToken }))
        .rejects.toMatchObject({ code: 'invalid-page-token' });
      const aSecond = await world.port.listFiles({ auth: a.auth, pageSize: 1, pageToken: aFirst.nextPageToken });
      expect(aSecond.files.map(item => item.id)).toEqual(['a-2']);
      expect(aSecond.nextPageToken).toBeUndefined();

      const counterfeit: DriveTenantAccess = { tenantKey: b.tenantKey, getAccessToken: a.auth.getAccessToken };
      await expect(world.port.listFiles({ auth: counterfeit })).rejects.toBeInstanceOf(DriveReadContractError);
      await expect(world.port.listFiles({ auth: counterfeit })).rejects.toMatchObject({ code: 'tenant-mismatch' });
      expect(Object.keys(world.port)).toEqual(['listFiles']);
      expect(GOOGLE_DRIVE_FILES_LIST_FIELDS).toBe('files(id,name,mimeType,modifiedTime),nextPageToken');
    } finally { world.close(); }
  });

  test('refresh rotates only A credentials; expiry blocks A until refresh and B remains usable', async () => {
    let clock = 1_000;
    const world = createFakeAppDriveWorld({ now: () => clock, accessTokenTtlMs: 100 });
    try {
      const a = world.createAccount({ identity: identity('subject-a'), files: [file('a-1')] });
      const b = world.createAccount({ identity: identity('subject-b'), files: [file('b-1')] });
      const aOldToken = await a.auth.getAccessToken(GOOGLE_DRIVE_METADATA_READONLY_SCOPE);
      const bTokenBefore = await b.auth.getAccessToken(GOOGLE_DRIVE_METADATA_READONLY_SCOPE);

      a.expireAccessToken();
      await expect(world.port.listFiles({ auth: a.auth })).rejects.toMatchObject({ code: 'unauthenticated' });
      expect((await world.port.listFiles({ auth: b.auth })).files.map(item => item.id)).toEqual(['b-1']);

      a.refresh();
      const aNewToken = await a.auth.getAccessToken(GOOGLE_DRIVE_METADATA_READONLY_SCOPE);
      const bTokenAfter = await b.auth.getAccessToken(GOOGLE_DRIVE_METADATA_READONLY_SCOPE);
      expect(aNewToken).not.toBe(aOldToken);
      expect(bTokenAfter).toBe(bTokenBefore);
      expect((await world.port.listFiles({ auth: a.auth })).files.map(item => item.id)).toEqual(['a-1']);
      expect((await world.port.listFiles({ auth: b.auth })).files.map(item => item.id)).toEqual(['b-1']);
      expect(world.observations().refreshes).toBe(1);
    } finally { world.close(); }
  });

  test('logout, provider revoke, and missing scope affect only the selected tenant', async () => {
    const world = createFakeAppDriveWorld();
    try {
      const missingScope = world.createAccount({ identity: identity('subject-missing-scope'), files: [file('d-1')], grantedScopes: [] });
      const a = world.createAccount({ identity: identity('subject-a'), files: [file('a-1')] });
      const b = world.createAccount({ identity: identity('subject-b'), files: [file('b-1')] });
      const revoked = world.createAccount({ identity: identity('subject-revoked'), files: [file('c-1')] });

      const forgedNoScope: DriveTenantAccess = {
        tenantKey: missingScope.tenantKey,
        async getAccessToken() { return 'synthetic-access-1'; },
      };
      await expect(world.port.listFiles({ auth: forgedNoScope })).rejects.toMatchObject({ code: 'scope-denied' });

      a.logout();
      await expect(world.port.listFiles({ auth: a.auth })).rejects.toMatchObject({ code: 'unauthenticated' });
      expect((await world.port.listFiles({ auth: b.auth })).files.map(item => item.id)).toEqual(['b-1']);
      revoked.revoke();
      await expect(world.port.listFiles({ auth: revoked.auth })).rejects.toMatchObject({ code: 'unauthenticated' });
      await expect(world.port.listFiles({ auth: b.auth })).resolves.toMatchObject({ files: [{ id: 'b-1' }] });

      await expect(world.port.listFiles({ auth: missingScope.auth })).rejects.toMatchObject({ code: 'scope-denied' });
      expect(world.capabilities()).toEqual({ externalGoogleApi: 'absent', credentialPersistence: 'absent' });
    } finally { world.close(); }
  });

  test('enforces page size and returns only the contracted metadata projection', async () => {
    const world = createFakeAppDriveWorld();
    try {
      const a = world.createAccount({ identity: identity('subject-a'), files: [file('a-1')] });
      await expect(world.port.listFiles({ auth: a.auth, pageSize: 101 })).rejects.toMatchObject({ code: 'invalid-page-size' });
      const page = await world.port.listFiles({ auth: a.auth });
      expect(page.files[0]).toEqual(file('a-1'));
      expect(Object.keys(page.files[0] ?? {}).sort()).toEqual(['id', 'mimeType', 'modifiedTime', 'name']);
      expect(page.nextPageToken).toBeUndefined();
      expect(world.observations()).toMatchObject({ simulatedListCalls: 1 });
      expect(world.capabilities()).toEqual({ externalGoogleApi: 'absent', credentialPersistence: 'absent' });
    } finally { world.close(); }
  });
});
