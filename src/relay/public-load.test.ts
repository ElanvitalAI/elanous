import { generateKeyPairSync } from 'node:crypto';
import { expect, test } from 'bun:test';
import { generateDaemonKeyPair, serverIdFromPublicKey } from './channel.js';
import { connectRelayHost } from './host-connector.js';
import { startRelayServer } from './relay-server.js';

test('public relay admits 50 simultaneous app requests while private WebSocket capacity stays separate', async () => {
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(50));
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const signing = generateKeyPairSync('ed25519');
  const signingPublicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const relay = startRelayServer({ trustedHostKeys: new Map([[serverId, signingPublicKey]]),
    publicDomain: 'elanous.app', publicServerId: serverId, publicUserId: 'alice' });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let host: Awaited<ReturnType<typeof connectRelayHost>> | undefined;
  const privateClients: WebSocket[] = [];
  try {
    host = await connectRelayHost({ relayUrl: `ws://127.0.0.1:${relay.port}/host`, daemonKeys,
      hostSigningKey: signing.privateKey,
      async handleRequest() { await held; return new Response('lecture-scrap page'); },
    });
    const requests = Array.from({ length: 50 }, () => fetch(`http://127.0.0.1:${relay.port}/`, {
      headers: { host: 'lecture-scrap--alice.elanous.app' },
    }));
    const deadline = Date.now() + 2_000;
    while (relay.stats(serverId).publicSlots < 50 && Date.now() < deadline) await Bun.sleep(10);
    const peakSlots = relay.stats(serverId).publicSlots;
    const dialPrivate = () => new Promise<{ ws: WebSocket; kind: 'connected' | 'closed'; code?: number }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/client?serverId=${serverId}`);
      privateClients.push(ws);
      ws.addEventListener('message', event => {
        const message = JSON.parse(String(event.data)) as { type?: string };
        resolve({ ws, kind: message.type === 'connected' ? 'connected' : 'closed' });
      }, { once: true });
      ws.addEventListener('close', event => resolve({ ws, kind: 'closed', code: event.code }), { once: true });
      ws.addEventListener('error', () => reject(new Error('private client connection failed')), { once: true });
    });
    const acceptedPrivate = await Promise.all(Array.from({ length: 8 }, dialPrivate));
    const deniedPrivate = await dialPrivate();
    release();
    const responses = await Promise.all(requests);
    const statuses = responses.map(response => response.status);
    await Promise.all(responses.map(response => response.arrayBuffer()));
    expect(peakSlots).toBe(50);
    expect(acceptedPrivate.map(client => client.kind)).toEqual(Array(8).fill('connected'));
    expect(deniedPrivate).toMatchObject({ kind: 'closed', code: 1008 });
    expect(relay.stats(serverId).clients).toBe(8);
    expect(statuses).toEqual(Array(50).fill(200));
    expect(relay.stats(serverId).publicSlots).toBe(0);
  } finally {
    release();
    for (const client of privateClients) client.close();
    host?.close();
    relay.server.stop(true);
  }
}, 10_000);
