import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePluginsCredentialsGet, handlePluginsCredentialsPut } from './plugins-credentials-api.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-credentials-api-'));
  dirs.push(root);
  const path = join(root, 'plugins', 'local', 'sample-test', '1.0.0');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'plugin.ts'), 'export default {}');
  writeFileSync(join(path, 'plugin.json'), JSON.stringify({ id: 'sample-test', version: '1.0.0', main: './plugin.ts',
    contributes: { connectors: [{ id: 'service', fields: [{ name: 'API_KEY', env: 'SERVICE_KEY', secret: true }] }] } }));
  return root;
}

const url = 'http://localhost/v1/plugins/sample-test/credentials';
const opts = { bearerToken: 'owner-token' };
const auth = { authorization: 'Bearer owner-token' };

test('credentials API uses owner auth and returns metadata only for PUT and GET', async () => {
  const root = fixture();
  const put = (body: unknown, headers: Record<string, string> = auth) => handlePluginsCredentialsPut(new Request(url, {
    method: 'PUT', headers, body: JSON.stringify(body),
  }), 'sample-test', opts, root);
  const get = (headers: Record<string, string> = auth) => handlePluginsCredentialsGet(new Request(url, { headers }), 'sample-test', opts, root);
  expect((await put({ fields: { API_KEY: 'private-value' } }, {})).status).toBe(401);
  expect(get({}).status).toBe(401);
  expect(handlePluginsCredentialsGet(new Request(url, { headers: auth }), 'absent-plugin', opts, root).status).toBe(404);
  expect((await handlePluginsCredentialsPut(new Request(url, { method: 'PUT', headers: auth,
    body: JSON.stringify({ fields: { API_KEY: 'private-value' } }) }), 'absent-plugin', opts, root)).status).toBe(404);
  expect((await put({ fields: { UNKNOWN: 'other-secret' } })).status).toBe(400);
  expect((await put({ fields: { API_KEY: 123 } })).status).toBe(400);
  const response = await put({ fields: { API_KEY: 'private-value' } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ set: ['API_KEY'], reloaded: false });
  const status = get();
  const statusText = await status.text();
  expect(JSON.parse(statusText)).toEqual({ fields: [{ name: 'API_KEY', env: 'SERVICE_KEY', set: true }] });
  expect(statusText).not.toContain('private-value');
  const unset = await put({ fields: { API_KEY: null } });
  expect(await unset.json()).toEqual({ set: [], reloaded: false });
  expect((await get().json() as { fields: Array<{ set: boolean }> }).fields[0]?.set).toBe(false);
});

test('a credential write reloads the daemon MCP clients so a running plugin server gets the new value', async () => {
  const root = fixture();
  let reloads = 0;
  const put = (reload: () => Promise<unknown>) => handlePluginsCredentialsPut(new Request(url, {
    method: 'PUT', headers: auth, body: JSON.stringify({ fields: { API_KEY: 'next-value' } }),
  }), 'sample-test', opts, root, reload);
  expect(await (await put(async () => { reloads++; })).json()).toEqual({ set: ['API_KEY'], reloaded: true });
  expect(reloads).toBe(1);
  // A failed reload does not undo or fail the write.
  const failed = await put(async () => { throw new Error('reload failed'); });
  expect(failed.status).toBe(200);
  expect(await failed.json()).toEqual({ set: ['API_KEY'], reloaded: false });
});

test('HTTP router mounts credential GET and PUT next to plugin routes', async () => {
  const root = fixture();
  const server = { requestIP: () => null };
  const options = { metaApi: opts, pluginStateRoot: root } as NexusHttpServerOpts;
  const route = (method: string, body?: unknown, headers: Record<string, string> = auth) => routeRequest(
    new Request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    options, server as unknown as Parameters<typeof routeRequest>[2], null, { get: () => null } as Parameters<typeof routeRequest>[4],
  );
  expect((await route('GET', undefined, {}))?.status).toBe(401);
  expect((await route('PUT', { fields: { API_KEY: 'private-value' } }, {}))?.status).toBe(401);
  expect((await route('PUT', { fields: { API_KEY: 'private-value' } }))?.status).toBe(200);
  const response = await route('GET');
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ fields: [{ name: 'API_KEY', env: 'SERVICE_KEY', set: true }] });
});
