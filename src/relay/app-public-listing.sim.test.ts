import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverIdFromPublicKey } from './channel.js';
import { loadRelayPublicListing, startRelayServer } from './relay-server.js';

function hostIdentity() {
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const host = generateKeyPairSync('x25519');
  const serverId = serverIdFromPublicKey(new Uint8Array(host.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
  return { publicKey, serverId };
}

test('public listing is opt in, excludes stopped apps, and reveals no credential', async () => {
  const { publicKey, serverId } = hostIdentity();
  const common = { trustedHostKeys: new Map([[serverId, publicKey]]), publicDomain: 'elanous.app' as const,
    publicServerId: serverId, publicUserId: 'alice' };
  expect(() => startRelayServer({ ...common, publicListedApps: new Set(['bad--slug']) })).toThrow('invalid public listing app id');
  const privateRelay = startRelayServer(common);
  try {
    const response = await fetch(`http://127.0.0.1:${privateRelay.port}/.well-known/elanous/apps`,
      { headers: { host: 'notes--alice.elanous.app' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apps: [] });
  } finally { privateRelay.stop(); }

  const relay = startRelayServer({ ...common, publicListedApps: new Set(['notes', 'tasks', 'hidden']),
    appKillSwitch: { isDown: (_userId, appId) => appId === 'hidden',
      applyIncident: () => { throw new Error('unexpected report'); } } });
  try {
    const address = `http://127.0.0.1:${relay.port}/.well-known/elanous/apps`;
    const response = await fetch(address, { headers: { host: 'notes--alice.elanous.app',
      authorization: 'Bearer emt_must_not_leak' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ apps: [
      'https://notes--alice.elanous.app', 'https://tasks--alice.elanous.app',
    ] });
    expect(body).not.toContain('emt_must_not_leak');
    expect((await fetch(address, { headers: { host: 'notes--bob.elanous.app' } })).status).toBe(404);
  } finally { relay.stop(); }
});

test('public listing config is an owner-only explicit app selection', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-listing-'));
  try {
    const file = join(root, 'listing.json');
    // Source: relay owner-only config contract (POSIX mode 0600).
    writeFileSync(file, JSON.stringify({ apps: ['notes'] }), { mode: 0o600 });
    expect([...loadRelayPublicListing(file)]).toEqual(['notes']);
    writeFileSync(file, JSON.stringify({ apps: ['notes', 'notes'] }));
    expect(() => loadRelayPublicListing(file)).toThrow('duplicate');
    writeFileSync(file, JSON.stringify({ apps: [{ appId: 'notes', token: 'secret' }] }));
    expect(() => loadRelayPublicListing(file)).toThrow('invalid');
    // Source: relay owner-only config contract; group-readable mode 0640 must be rejected.
    chmodSync(file, 0o640);
    expect(() => loadRelayPublicListing(file)).toThrow('owner-only');
    const link = join(root, 'listing-link.json');
    symlinkSync(file, link);
    expect(() => loadRelayPublicListing(link)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
