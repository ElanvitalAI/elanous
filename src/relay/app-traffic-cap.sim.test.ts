import { expect, test } from 'bun:test';
import { createRelayTrafficMeter, loadRelayTrafficCap } from './relay-server.js';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { acceptDaemonChannel, challengeMessage, generateDaemonKeyPair, serverIdFromPublicKey } from './channel.js';
import { MuxDecoder, MuxStreamState } from './mux.js';
import { startRelayServer } from './relay-server.js';
import { createRelayTrafficLedger } from './relay-traffic-ledger.js';

function socket(url: string, token: string) {
  const ws = new WebSocket(url, [token]);
  ws.binaryType = 'arraybuffer';
  const messages: Array<string | Uint8Array> = [];
  let waiter: ((value: string | Uint8Array) => void) | undefined;
  ws.addEventListener('message', event => {
    const value = typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer);
    if (waiter) { const resolve = waiter; waiter = undefined; resolve(value); } else messages.push(value);
  });
  return {
    ws,
    opened: new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket refused')), { once: true });
    }),
    next: () => messages.length ? Promise.resolve(messages.shift()!) : new Promise<string | Uint8Array>(resolve => { waiter = resolve; }),
    closed: () => new Promise<CloseEvent>(resolve => ws.addEventListener('close', event => resolve(event), { once: true })),
  };
}

test('real relay closes an over-cap connection and resumes after the minute resets', async () => {
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const hostKey = generateKeyPairSync('x25519');
  const serverId = serverIdFromPublicKey(new Uint8Array(hostKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
  let now = Date.parse('2026-11-10T00:00:00.000Z');
  const root = mkdtempSync(join(tmpdir(), 'relay-real-cap-'));
  const trafficStore = createRelayTrafficLedger(join(root, 'usage.sqlite'), root);
  // Source: 내부 문서 `nexus-backend-in-a-box` APP-TRAFFIC-CAP; fixture-only caps.
  const relay = startRelayServer({ trustedHostKeys: new Map([[serverId, publicKey]]), memberRequired: true,
    hostOwnerMemberIds: new Map([[serverId, 'member-a']]), validateMemberToken: async token => token === 'emt_valid' ? { memberId: 'member-a' } : null,
    trafficCap: { free: { memberBytesPerMinute: 10, connectionBytesPerMinute: 6 } }, trafficStore, trafficNowForTesting: () => now });
  const host = socket(`ws://127.0.0.1:${relay.port}/host?serverId=${serverId}`, 'emt_valid');
  try {
    await host.opened;
    const challenge = JSON.parse(await host.next() as string) as { nonce: string };
    host.ws.send(JSON.stringify({ type: 'auth', publicKey,
      signature: sign(null, challengeMessage(serverId, challenge.nonce), signing.privateKey).toString('base64url') }));
    expect(JSON.parse(await host.next() as string)).toEqual({ type: 'authenticated' });
    const client = socket(`ws://127.0.0.1:${relay.port}/client?serverId=${serverId}`, 'emt_valid');
    await client.opened;
    await client.next();
    await host.next();
    client.ws.send(new Uint8Array(4));
    expect(await host.next()).toBeInstanceOf(Uint8Array);
    const limited = client.closed();
    client.ws.send(new Uint8Array(3));
    expect((await limited).code).toBe(1008);
    now += 60_000;
    const resumed = socket(`ws://127.0.0.1:${relay.port}/client?serverId=${serverId}`, 'emt_valid');
    await resumed.opened;
    const resumedId = (JSON.parse(await resumed.next() as string) as { clientId: number }).clientId;
    resumed.ws.send(new Uint8Array(6));
    let forwarded: string | Uint8Array;
    do { forwarded = await host.next(); } while (typeof forwarded === 'string');
    expect(forwarded).toBeInstanceOf(Uint8Array);
    const other = socket(`ws://127.0.0.1:${relay.port}/client?serverId=${serverId}`, 'emt_valid');
    await other.opened;
    const otherId = (JSON.parse(await other.next() as string) as { clientId: number }).clientId;
    const hostFrame = (clientId: number, size: number) => {
      const bytes = new Uint8Array(size + 4);
      new DataView(bytes.buffer).setUint32(0, clientId, false);
      return bytes;
    };
    host.ws.send(hostFrame(otherId, 4));
    expect(await other.next()).toBeInstanceOf(Uint8Array);
    expect(relay.trafficUsage('member-a')).toEqual({ minute: Math.floor(now / 60_000), ingressBytes: 6, egressBytes: 4 });
    const resumedClosed = resumed.closed();
    host.ws.send(hostFrame(resumedId, 1));
    expect((await resumedClosed).code).toBe(1008);
    expect(relay.trafficUsage('member-a')).toEqual({ minute: Math.floor(now / 60_000), ingressBytes: 6, egressBytes: 4 });
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
    now += 60_000;
    host.ws.send(hostFrame(otherId, 4));
    expect(await other.next()).toBeInstanceOf(Uint8Array);
    other.ws.close();
    const nonmember = await fetch(`http://127.0.0.1:${relay.port}/client?serverId=${serverId}`);
    expect(nonmember.status).toBe(401);
  } finally { host.ws.close(); relay.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('a direct relay start refuses a capped member server without a durable ledger', () => {
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const hostKey = generateKeyPairSync('x25519');
  const serverId = serverIdFromPublicKey(new Uint8Array(hostKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
  expect(() => startRelayServer({ trustedHostKeys: new Map([[serverId, publicKey]]), memberRequired: true,
    hostOwnerMemberIds: new Map([[serverId, 'member-a']]), validateMemberToken: async () => ({ memberId: 'member-a' }),
    trafficCap: { free: { memberBytesPerMinute: 10, connectionBytesPerMinute: 10 } } }))
    .toThrow('requires a durable traffic ledger');
});

test('member-required public relay removes its token but forwards the app bearer', async () => {
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(21));
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const relay = startRelayServer({ trustedHostKeys: new Map([[serverId, publicKey]]), memberRequired: true,
    hostOwnerMemberIds: new Map([[serverId, 'member-a']]), validateMemberToken: async token => token === 'emt_valid' ? { memberId: 'member-a' } : null,
    publicDomain: 'elanous.app', publicServerId: serverId, publicUserId: 'alice' });
  const host = socket(`ws://127.0.0.1:${relay.port}/host?serverId=${serverId}`, 'emt_valid');
  const abort = new AbortController();
  try {
    await host.opened;
    const challenge = JSON.parse(await host.next() as string) as { nonce: string };
    host.ws.send(JSON.stringify({ type: 'auth', publicKey,
      signature: sign(null, challengeMessage(serverId, challenge.nonce), signing.privateKey).toString('base64url') }));
    await host.next();
    host.ws.send(JSON.stringify({ type: 'host-public-key', publicKey: Buffer.from(daemonKeys.publicKey).toString('base64url') }));
    await host.next();
    const pending = fetch(`http://127.0.0.1:${relay.port}/hello`, { method: 'GET', signal: abort.signal,
      headers: { host: 'notes--alice.elanous.app', authorization: 'Bearer emt_app', 'sec-websocket-protocol': 'emt_valid' } }).catch(() => undefined);
    const taggedPhoneKey = await host.next() as Uint8Array;
    const channel = await acceptDaemonChannel(daemonKeys, taggedPhoneKey.subarray(4));
    if (!channel.ok) throw new Error(channel.reason);
    const taggedOpen = await host.next() as Uint8Array;
    const opened = channel.value.open(taggedOpen.subarray(4));
    if (!opened.ok) throw new Error(opened.reason);
    const decoded = new MuxDecoder(new MuxStreamState()).decode(opened.value);
    if (!decoded.ok || decoded.value.kind !== 'open') throw new Error('expected public request');
    expect(decoded.value.headers.authorization).toBe('Bearer emt_app');
    expect(decoded.value.headers['sec-websocket-protocol']).toBeUndefined();
    abort.abort();
    await pending;
    const abortAppProtocol = new AbortController();
    const appProtocolPending = fetch(`http://127.0.0.1:${relay.port}/hello`, { method: 'GET', signal: abortAppProtocol.signal,
      headers: { host: 'notes--alice.elanous.app', authorization: 'Bearer emt_valid', 'sec-websocket-protocol': 'emt_app' } }).catch(() => undefined);
    const nextBinary = async (): Promise<Uint8Array> => {
      let value: string | Uint8Array;
      do { value = await host.next(); } while (typeof value === 'string');
      return value;
    };
    let secondPhoneKey: Uint8Array;
    do { secondPhoneKey = await nextBinary(); } while (secondPhoneKey.byteLength !== 36);
    const secondChannel = await acceptDaemonChannel(daemonKeys, secondPhoneKey.subarray(4));
    if (!secondChannel.ok) throw new Error(secondChannel.reason);
    const secondOpen = secondChannel.value.open((await nextBinary()).subarray(4));
    if (!secondOpen.ok) throw new Error(secondOpen.reason);
    const secondDecoded = new MuxDecoder(new MuxStreamState()).decode(secondOpen.value);
    if (!secondDecoded.ok || secondDecoded.value.kind !== 'open') throw new Error('expected second public request');
    expect(secondDecoded.value.headers.authorization).toBeUndefined();
    expect(secondDecoded.value.headers['sec-websocket-protocol']).toBe('emt_app');
    abortAppProtocol.abort();
    await appProtocolPending;
  } finally { host.ws.close(); relay.stop(); }
});

test('fake minute caps member and connection bytes, resets at the next minute, and rejects nonmembers', () => {
  let now = Date.parse('2026-11-10T00:00:00.000Z');
  // Source: 내부 문서 `nexus-backend-in-a-box` APP-TRAFFIC-CAP; fixture-only small caps exercise both limits.
  const meter = createRelayTrafficMeter({ free: { memberBytesPerMinute: 10, connectionBytesPerMinute: 6 } }, () => now);
  expect(meter.charge(null, 'connection-a', 1)).toBe('member-required');
  expect(meter.charge('member-a', 'connection-a', 4)).toBe('allowed');
  expect(meter.charge('member-a', 'connection-a', 3)).toBe('limited');
  expect(meter.charge('member-a', 'connection-b', 6)).toBe('allowed');
  expect(meter.charge('member-a', 'connection-c', 1)).toBe('limited');
  expect(meter.charge('member-b', 'connection-c', 1)).toBe('allowed');
  now += 60_000;
  expect(meter.charge('member-a', 'connection-a', 6)).toBe('allowed');
  expect(meter.charge('member-a', 'connection-b', 4)).toBe('allowed');
});

test('directional usage stays isolated by member and only records accepted bytes', () => {
  let now = Date.parse('2026-11-10T00:00:00.000Z');
  const meter = createRelayTrafficMeter({ free: { memberBytesPerMinute: 10, connectionBytesPerMinute: 8 } },
    () => now);
  expect(meter.charge('member-a', 'a-connection', 4, 'ingress')).toBe('allowed');
  expect(meter.charge('member-a', 'a-connection', 3, 'egress')).toBe('allowed');
  expect(meter.charge('member-a', 'a-connection', 2, 'egress')).toBe('limited');
  expect(meter.charge('member-b', 'b-connection', 5, 'egress')).toBe('allowed');
  expect(meter.usage('member-a')).toEqual({ minute: Math.floor(now / 60_000), ingressBytes: 4, egressBytes: 3 });
  expect(meter.usage('member-b')).toEqual({ minute: Math.floor(now / 60_000), ingressBytes: 0, egressBytes: 5 });
  now += 60_000;
  expect(meter.usage('member-a')).toEqual({ minute: Math.floor(now / 60_000), ingressBytes: 0, egressBytes: 0 });
});

test('failed ledger write rejects bytes without charging the member', () => {
  let fail = true;
  let ingressBytes = 0;
  const now = Date.parse('2026-11-10T00:01:00.000Z');
  const meter = createRelayTrafficMeter({ free: { memberBytesPerMinute: 10, connectionBytesPerMinute: 10 } },
    () => now, { read: () => ({ ingressBytes, egressBytes: 0 }),
      charge: event => {
        if (fail) throw new Error('disk unavailable');
        ingressBytes += event.bytes;
        return { status: 'allowed', usage: { ingressBytes, egressBytes: 0 } };
      } });
  expect(meter.charge('member-a', 'connection-a', 6)).toBe('ledger-unavailable');
  expect(meter.usage('member-a')).toEqual({ minute: Math.floor(now / 60_000), ingressBytes: 0, egressBytes: 0 });
  fail = false;
  expect(meter.charge('member-a', 'connection-a', 6)).toBe('allowed');
  expect(meter.charge('member-a', 'connection-a', 5)).toBe('limited');
});

test('failed atomic ledger charge refuses a restarted member window', () => {
  const meter = createRelayTrafficMeter({ free: { memberBytesPerMinute: 10, connectionBytesPerMinute: 10 } },
    () => 60_000, { read: () => { throw new Error('disk unavailable'); }, charge: () => { throw new Error('disk unavailable'); } });
  expect(meter.charge('member-a', 'connection-a', 1)).toBe('ledger-unavailable');
});

test('two relay meters sharing one ledger cannot jointly exceed the member cap', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-traffic-race-'));
  const path = join(root, 'relay', 'usage.sqlite');
  const config = { free: { memberBytesPerMinute: 10, connectionBytesPerMinute: 10 } };
  const now = () => Date.parse('2026-11-10T00:00:00.000Z');
  const firstStore = createRelayTrafficLedger(path, root);
  const secondStore = createRelayTrafficLedger(path, root);
  try {
    const first = createRelayTrafficMeter(config, now, firstStore);
    const second = createRelayTrafficMeter(config, now, secondStore);
    expect(first.charge('member-a', 'first-connection', 6)).toBe('allowed');
    expect(second.charge('member-a', 'second-connection', 5)).toBe('limited');
    expect(second.charge('member-a', 'second-connection', 4, 'egress')).toBe('allowed');
    expect(first.charge('member-a', 'first-connection', 1)).toBe('limited');
    expect(first.usage('member-a')).toEqual({ minute: Math.floor(now() / 60_000), ingressBytes: 6, egressBytes: 4 });
    expect(second.usage('member-a')).toEqual(first.usage('member-a'));
  } finally { firstStore.close(); secondStore.close(); rmSync(root, { recursive: true, force: true }); }
});

test('private ledger persists member limits and directional totals across relay restarts', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-traffic-ledger-'));
  const path = join(root, 'relay', 'usage.sqlite');
  const config = { free: { memberBytesPerMinute: 10, connectionBytesPerMinute: 10 } };
  const now = () => Date.parse('2026-11-10T00:00:00.000Z');
  try {
    const firstStore = createRelayTrafficLedger(path, root);
    const first = createRelayTrafficMeter(config, now, firstStore);
    expect(first.charge('member-a', 'connection-a', 4, 'ingress')).toBe('allowed');
    expect(first.charge('member-a', 'connection-a', 3, 'egress')).toBe('allowed');
    expect(first.charge('member-b', 'connection-b', 6, 'egress')).toBe('allowed');
    firstStore.close();
    const secondStore = createRelayTrafficLedger(path, root);
    try {
      const second = createRelayTrafficMeter(config, now, secondStore);
      expect(second.charge('member-a', 'new-connection', 4)).toBe('limited');
      expect(second.charge('member-a', 'new-connection', 3)).toBe('allowed');
      expect(second.usage('member-a')).toEqual({ minute: Math.floor(now() / 60_000), ingressBytes: 7, egressBytes: 3 });
      expect(secondStore.monthUsage('member-a', 2026, 11)).toEqual({
        minute: Date.UTC(2026, 10, 1) / 60_000, ingressBytes: 7, egressBytes: 3,
      });
      expect(secondStore.monthUsage('member-b', 2026, 11).egressBytes).toBe(6);
    } finally { secondStore.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('measure-only pilot records isolated bytes across restarts without imposing a threshold', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-traffic-measure-'));
  const path = join(root, 'relay', 'usage.sqlite');
  const config = { mode: 'measure-only' as const };
  const now = () => Date.parse('2026-11-10T00:00:00.000Z');
  expect(() => createRelayTrafficMeter(config, now)).toThrow('requires a ledger');
  try {
    const firstStore = createRelayTrafficLedger(path, root);
    const first = createRelayTrafficMeter(config, now, firstStore);
    expect(first.charge('member-a', 'connection-a', 20, 'ingress')).toBe('allowed');
    expect(first.charge('member-a', 'connection-a', 30, 'egress')).toBe('allowed');
    expect(first.charge('member-b', 'connection-b', 7, 'ingress')).toBe('allowed');
    firstStore.close();
    const secondStore = createRelayTrafficLedger(path, root);
    try {
      const second = createRelayTrafficMeter(config, now, secondStore);
      expect(second.charge('member-a', 'connection-a', 50, 'ingress')).toBe('allowed');
      expect(second.charge('member-a', 'connection-b', 8, 'egress')).toBe('allowed');
      expect(second.usage('member-a')).toEqual({ minute: Math.floor(now() / 60_000), ingressBytes: 70, egressBytes: 38 });
      expect(second.usage('member-b').ingressBytes).toBe(7);
      expect(secondStore.connectionUsage('member-a', 'connection-a', Math.floor(now() / 60_000))).toEqual({
        minute: Math.floor(now() / 60_000), ingressBytes: 70, egressBytes: 30,
      });
      expect(secondStore.connectionUsage('member-a', 'connection-b', Math.floor(now() / 60_000)).egressBytes).toBe(8);
      expect(secondStore.connectionUsage('member-b', 'connection-b', Math.floor(now() / 60_000)).ingressBytes).toBe(7);
      expect(secondStore.monthUsage('member-a', 2026, 11).egressBytes).toBe(38);
    } finally { secondStore.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real relay closes a connection with a server error when usage recording fails', async () => {
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const hostKey = generateKeyPairSync('x25519');
  const serverId = serverIdFromPublicKey(new Uint8Array(hostKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
  const relay = startRelayServer({ trustedHostKeys: new Map([[serverId, publicKey]]), memberRequired: true,
    hostOwnerMemberIds: new Map([[serverId, 'member-a']]), validateMemberToken: async token => token === 'emt_valid' ? { memberId: 'member-a' } : null,
    trafficCap: { free: { memberBytesPerMinute: 10, connectionBytesPerMinute: 10 } },
    trafficStore: { read: () => ({ ingressBytes: 0, egressBytes: 0 }),
      charge: () => { throw new Error('disk unavailable'); } } });
  const host = socket(`ws://127.0.0.1:${relay.port}/host?serverId=${serverId}`, 'emt_valid');
  try {
    await host.opened;
    const challenge = JSON.parse(await host.next() as string) as { nonce: string };
    host.ws.send(JSON.stringify({ type: 'auth', publicKey,
      signature: sign(null, challengeMessage(serverId, challenge.nonce), signing.privateKey).toString('base64url') }));
    await host.next();
    const client = socket(`ws://127.0.0.1:${relay.port}/client?serverId=${serverId}`, 'emt_valid');
    await client.opened;
    await client.next();
    await host.next();
    const closed = client.closed();
    client.ws.send(new Uint8Array(4));
    expect((await closed).code).toBe(1011);
    expect(relay.stats(serverId).failures['traffic-ledger']).toBe(1);
    expect(relay.trafficUsage('member-a')?.ingressBytes).toBe(0);
  } finally { host.ws.close(); relay.stop(); }
});

test('operator cap config stays in an owner-only file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cap-'));
  const path = join(dir, 'cap.json');
  // Source: 내부 문서 `nexus-backend-in-a-box` APP-TRAFFIC-CAP; fixture-only values.
  const config = { free: { memberBytesPerMinute: 10, connectionBytesPerMinute: 6 } };
  try {
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    expect(loadRelayTrafficCap(path)).toEqual(config);
    writeFileSync(path, JSON.stringify({ mode: 'measure-only' }));
    expect(loadRelayTrafficCap(path)).toEqual({ mode: 'measure-only' });
    chmodSync(path, 0o644);
    expect(() => loadRelayTrafficCap(path)).toThrow('owner-only');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
