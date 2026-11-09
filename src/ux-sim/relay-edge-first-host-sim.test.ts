import { generateKeyPairSync } from 'node:crypto';
import { expect, test } from 'bun:test';
import { generateDaemonKeyPair, serverIdFromPublicKey } from '../relay/channel.js';
import { connectRelayHost } from '../relay/host-connector.js';
import { startRelayServer } from '../relay/relay-server.js';

const PUBLIC_HOST = 'notes--alice.elanous.app';

/** The fake TLS edge forwards the original app host to a loopback-only relay listener. */
function edgeFetch(port: number, host: string, path = '/healthz?from=edge'): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { host, origin: `https://${host}`, 'x-forwarded-proto': 'https' },
  });
}

test('RELAY-EDGE-CONNECT-FIRST-HOST · trusted host reaches app domain through the simulated edge', async () => {
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(41));
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const signing = generateKeyPairSync('ed25519');
  const signingPublicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const relay = startRelayServer({ port: 0, hostname: '127.0.0.1',
    trustedHostKeys: new Map([[serverId, signingPublicKey]]), publicDomain: 'elanous.app',
    publicServerId: serverId, publicUserId: 'alice' });
  const port = relay.port;
  if (typeof port !== 'number') throw new Error('relay listener did not bind a port');
  let host: Awaited<ReturnType<typeof connectRelayHost>> | undefined;
  let observed: { url: string; host: string | null; origin: string | null } | undefined;

  try {
    host = await connectRelayHost({
      relayUrl: `ws://127.0.0.1:${port}/host`, daemonKeys, hostSigningKey: signing.privateKey,
      async handleRequest(request) {
        observed = { url: request.url, host: request.headers.get('host'), origin: request.headers.get('origin') };
        return new Response('first host ready', { status: 200, headers: {
          'content-type': 'text/plain', 'x-nexus-app-origin': 'http://notes.app.localhost',
          'x-nexus-app-host': 'notes.app.localhost', 'location': 'http://notes.app.localhost/ready',
        } });
      },
    });

    const response = await edgeFetch(port, PUBLIC_HOST);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('first host ready');
    expect(observed).toEqual({ url: 'http://notes.app.localhost/healthz?from=edge',
      host: 'notes.app.localhost', origin: 'http://notes.app.localhost' });
    expect(response.headers.get('x-nexus-app-origin')).toBe(`https://${PUBLIC_HOST}`);
    expect(response.headers.get('x-nexus-app-host')).toBe(PUBLIC_HOST);
    expect(response.headers.get('location')).toBe(`https://${PUBLIC_HOST}/ready`);
    expect(relay.stats(serverId).host).toBe(true);
  } finally {
    host?.close();
    relay.server.stop(true);
  }
});

test('RELAY-EDGE-CONNECT-FIRST-HOST · bad app hosts and missing trusted server fail closed', async () => {
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(42));
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const signing = generateKeyPairSync('ed25519');
  const signingPublicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const relay = startRelayServer({ port: 0, hostname: '127.0.0.1',
    trustedHostKeys: new Map([[serverId, signingPublicKey]]), publicDomain: 'elanous.app',
    publicServerId: serverId, publicUserId: 'alice' });
  const port = relay.port;
  if (typeof port !== 'number') throw new Error('relay listener did not bind a port');
  let host: Awaited<ReturnType<typeof connectRelayHost>> | undefined;
  let handled = 0;
  try {
    expect(() => startRelayServer({ trustedHostKeys: new Map([[serverId, signingPublicKey]]), publicDomain: 'elanous.app',
      publicServerId: 'f'.repeat(64), publicUserId: 'alice' })).toThrow('public relay requires a pinned publicServerId');
    expect((await edgeFetch(port, 'notes--bob.elanous.app')).status).toBe(404);
    expect((await edgeFetch(port, 'invalid.elanous.app')).status).toBe(404);
    expect((await edgeFetch(port, PUBLIC_HOST)).status).toBe(503);

    const impostor = generateKeyPairSync('ed25519');
    await expect(connectRelayHost({ relayUrl: `ws://127.0.0.1:${port}/host`, daemonKeys,
      hostSigningKey: impostor.privateKey, handleRequest: () => { handled += 1; return new Response('must not run'); } })).rejects.toThrow();
    expect(relay.stats(serverId).host).toBe(false);
    expect((await edgeFetch(port, PUBLIC_HOST)).status).toBe(503);
    expect(handled).toBe(0);
    host = await connectRelayHost({ relayUrl: `ws://127.0.0.1:${port}/host`, daemonKeys,
      hostSigningKey: signing.privateKey, handleRequest: () => { handled += 1; return new Response('app reached'); } });
    expect((await edgeFetch(port, 'notes--bob.elanous.app')).status).toBe(404);
    expect((await edgeFetch(port, 'invalid.elanous.app')).status).toBe(404);
    expect(handled).toBe(0);
    expect((await edgeFetch(port, PUBLIC_HOST)).status).toBe(200);
    expect(handled).toBe(1);
  } finally {
    host?.close();
    relay.server.stop(true);
  }
});
