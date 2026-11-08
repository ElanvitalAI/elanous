import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  createFakeGoogleDriveWorld,
  GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
  type FakeDriveFile,
} from './fake-google-drive-world.js';

const scenarioPath = 'scenarios/ux-sim/google-drive-files-list-readonly.yaml';
const scenario = parseYaml(readFileSync(scenarioPath, 'utf8')) as {
  id: string;
  scope: string;
  pageSize: number;
  files: FakeDriveFile[];
  expected: { firstPageCount: number; secondPageCount: number; writeStatus: number; mutations: number };
};

test('Google Drive readonly files.list scenario paginates metadata and refuses writes without external calls', async () => {
  expect(scenario.id).toBe('GOOGLE-DRIVE-LIST-READONLY');
  expect(scenario.scope).toBe(GOOGLE_DRIVE_METADATA_READONLY_SCOPE);
  const world = createFakeGoogleDriveWorld({ files: scenario.files });
  const token = world.accessToken;
  expect(token).toBeTruthy();

  const fields = 'files(id,name,mimeType,modifiedTime),nextPageToken';
  const first = await world.fetch(`https://www.googleapis.com/drive/v3/files?pageSize=${scenario.pageSize}&fields=${encodeURIComponent(fields)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const firstBody = await first.json() as { files: Array<Record<string, unknown>>; nextPageToken?: string };
  expect(first.status).toBe(200);
  expect(firstBody.files).toHaveLength(scenario.expected.firstPageCount);
  expect(firstBody.files.map((file) => file.id)).toEqual(scenario.files.slice(0, scenario.pageSize).map((file) => file.id));
  expect(firstBody.files.every((file) => Object.keys(file).sort().join(',') === 'id,mimeType,modifiedTime,name')).toBe(true);
  expect(firstBody.nextPageToken).toBeTruthy();

  const second = await world.fetch(`https://www.googleapis.com/drive/v3/files?pageSize=${scenario.pageSize}&pageToken=${firstBody.nextPageToken}&fields=${encodeURIComponent(fields)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const secondBody = await second.json() as { files: Array<Record<string, unknown>>; nextPageToken?: string };
  expect(second.status).toBe(200);
  expect(secondBody.files).toHaveLength(scenario.expected.secondPageCount);
  expect(secondBody.files.map((file) => file.id)).toEqual(scenario.files.slice(scenario.pageSize).map((file) => file.id));
  expect(secondBody.nextPageToken).toBeUndefined();

  const write = await world.fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'must-not-be-created' }),
  });
  expect(write.status).toBe(scenario.expected.writeStatus);
  expect(world.mutations).toBe(scenario.expected.mutations);
  expect(world.requests).toHaveLength(3);
  expect(JSON.stringify(world.requests)).not.toContain(token!);
});

test('fake Drive world denies missing auth, insufficient readonly scope, and unsupported endpoints', async () => {
  const world = createFakeGoogleDriveWorld({ files: [], grantedScopes: ['openid'] });
  expect(world.accessToken).toBeTruthy();
  expect((await world.fetch('https://www.googleapis.com/drive/v3/files')).status).toBe(401);
  const authorization = { headers: { authorization: `Bearer ${world.accessToken}` } };
  expect((await world.fetch('https://www.googleapis.com/drive/v3/files', authorization)).status).toBe(403);
  expect((await world.fetch('https://example.invalid/drive/v3/files', authorization)).status).toBe(404);
});

test('fake Drive world requires the fixed metadata fields selector', async () => {
  const world = createFakeGoogleDriveWorld({ files: [] });
  const headers = { headers: { authorization: `Bearer ${world.accessToken}` } };
  const missing = await world.fetch('https://www.googleapis.com/drive/v3/files', headers);
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: { code: 400, message: 'unsupported fields selector' } });

  const invalid = await world.fetch('https://www.googleapis.com/drive/v3/files?fields=files%28id%2Cname%29', headers);
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: { code: 400, message: 'unsupported fields selector' } });
});
