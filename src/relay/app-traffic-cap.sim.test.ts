import { expect, test } from 'bun:test';
import { createRelayTrafficMeter, loadRelayTrafficCap } from './relay-server.js';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { acceptDaemonChannel, challengeMessage, generateDaemonKeyPair, serverIdFromPublicKey } from './channel.js';
import { MuxDecoder, MuxStreamState } from './mux.js';
import { startRelayServer } from './relay-server.js';

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
  // Source: 내부 문서 `nexus-backend-in-a-box` APP-TRAFFIC-CAP; fixture-only caps.
  const relay = startRelayServer({ trustedHostKeys: new Map([[serverId, publicKey]]), memberRequired: true,
    hostOwnerMemberIds: new Map([[serverId, 'member-a']]), validateMemberToken: async token => token === 'emt_valid' ? { memberId: 'member-a' } : null,
    trafficCap: { free: { memberBytesPerMinute: 10, connectionBytesPerMinute: 6 } }, trafficNowForTesting: () => now });
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
    const resumedClosed = resumed.closed();
    host.ws.send(hostFrame(resumedId, 1));
    expect((await resumedClosed).code).toBe(1008);
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
    now += 60_000;
    host.ws.send(hostFrame(otherId, 4));
    expect(await other.next()).toBeInstanceOf(Uint8Array);
    other.ws.close();
    const nonmember = await fetch(`http://127.0.0.1:${relay.port}/client?serverId=${serverId}`);
    expect(nonmember.status).toBe(401);
  } finally { host.ws.close(); relay.stop(); }
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

test('operator cap config stays in an owner-only file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cap-'));
  const path = join(dir, 'cap.json');
  // Source: 내부 문서 `nexus-backend-in-a-box` APP-TRAFFIC-CAP; fixture-only values.
  const config = { free: { memberBytesPerMinute: 10, connectionBytesPerMinute: 6 } };
  try {
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    expect(loadRelayTrafficCap(path)).toEqual(config);
    chmodSync(path, 0o644);
    expect(() => loadRelayTrafficCap(path)).toThrow('owner-only');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
