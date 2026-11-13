import { expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { generateDaemonKeyPair, serverIdFromPublicKey } from './channel.js';
import { challengeMessage, startRelayServer } from './relay-server.js';
import { connectRelayHost } from './host-connector.js';

function hostIdentity() {
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const host = generateKeyPairSync('x25519');
  const serverId = serverIdFromPublicKey(new Uint8Array(host.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
  return { serverId, publicKey, signing, hostPublicKey: host.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32) };
}

function nextMessage(ws: WebSocket): Promise<string | Uint8Array> {
  return new Promise(resolve => ws.addEventListener('message', event =>
    resolve(typeof event.data === 'string' ? event.data : new Uint8Array(event.data)), { once: true }));
}

test('public app dispatch uses the owner pin for each member and isolates unknown users', async () => {
  const alice = hostIdentity();
  const bob = hostIdentity();
  const relay = startRelayServer({
    trustedHostKeys: new Map([[alice.serverId, alice.publicKey], [bob.serverId, bob.publicKey]]),
    publicDomain: 'elanous.app', memberRequired: true,
    hostOwnerMemberIds: new Map([[alice.serverId, 'member-a'], [bob.serverId, 'member-b']]),
    publicDispatchRoutes: new Map([
      ['alice', { serverId: alice.serverId, ownerMemberId: 'member-a' }],
      ['bob', { serverId: bob.serverId, ownerMemberId: 'member-b' }],
    ]),
    validateMemberToken: async (token, serverId) => {
      if (token === 'emt_alice' && serverId === alice.serverId) return { memberId: 'member-a' };
      if (token === 'emt_bob' && serverId === bob.serverId) return { memberId: 'member-b' };
      return null;
    },
  });
  try {
    const request = (user: string, token?: string, signal?: AbortSignal) => fetch(`http://127.0.0.1:${relay.port}/`, {
      signal,
      headers: { host: `notes--${user}.elanous.app`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    expect((await request('alice', 'emt_alice')).status).toBe(503);
    expect((await request('bob', 'emt_bob')).status).toBe(503);
    expect((await request('alice', 'emt_bob')).status).toBe(401);
    expect((await request('bob', 'emt_alice')).status).toBe(401);
    expect((await request('unknown', 'emt_alice')).status).toBe(404);
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/host?serverId=${alice.serverId}`, ['emt_alice']);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('alice host connection failed')), { once: true });
      });
      const challenge = JSON.parse(await nextMessage(socket) as string) as { nonce: string };
      socket.send(JSON.stringify({ type: 'auth', publicKey: alice.publicKey,
        signature: sign(null, challengeMessage(alice.serverId, challenge.nonce), alice.signing.privateKey).toString('base64url') }));
      expect(JSON.parse(await nextMessage(socket) as string).type).toBe('authenticated');
      socket.send(JSON.stringify({ type: 'host-public-key', publicKey: alice.hostPublicKey.toString('base64url') }));
      expect(JSON.parse(await nextMessage(socket) as string).type).toBe('host-public-key-accepted');
      const abort = new AbortController();
      const pending = request('alice', 'emt_alice', abort.signal);
      const frame = await nextMessage(socket);
      expect(frame).toBeInstanceOf(Uint8Array);
      expect((await request('bob', 'emt_bob')).status).toBe(503);
      abort.abort();
      await pending.catch(() => {});
    } finally { socket.close(); }
  } finally { relay.stop(); }
});

test('member-gated Nexus connector serves one public app without exposing its token to the app', async () => {
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(42));
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const signing = generateKeyPairSync('ed25519');
  const signingPublicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const relay = startRelayServer({
    trustedHostKeys: new Map([[serverId, signingPublicKey]]),
    publicDomain: 'elanous.app', memberRequired: true,
    hostOwnerMemberIds: new Map([[serverId, 'member-a']]),
    publicDispatchRoutes: new Map([['alice', { serverId, ownerMemberId: 'member-a' }]]),
    validateMemberToken: async (token, audience) =>
      token === 'emt_alice' && audience === serverId ? { memberId: 'member-a' } : null,
  });
  let host: Awaited<ReturnType<typeof connectRelayHost>> | undefined;
  try {
    host = await connectRelayHost({ relayUrl: `ws://127.0.0.1:${relay.port}/host`, daemonKeys,
      hostSigningKey: signing.privateKey, getMemberToken: audience => {
        expect(audience).toBe(serverId);
        return 'emt_alice';
      },
      handleRequest(request) {
        expect(request.headers.get('authorization')).toBeNull();
        expect(new URL(request.url).host).toBe('notes.app.localhost');
        return new Response('alice-app', { status: 200 });
      },
    });
    const app = await fetch(`http://127.0.0.1:${relay.port}/`, {
      headers: { host: 'notes--alice.elanous.app', authorization: 'Bearer emt_alice' },
    });
    expect(app.status).toBe(200);
    expect(await app.text()).toBe('alice-app');
    expect((await fetch(`http://127.0.0.1:${relay.port}/`, { headers: { host: 'notes--bob.elanous.app' } })).status).toBe(404);
  } finally { host?.close(); relay.stop(); }
});
