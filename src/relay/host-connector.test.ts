import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { createPhoneChannel, generateDaemonKeyPair, serverIdFromPublicKey } from './channel.js';
import { connectRelayHost, loadOrCreateRelayHostIdentity } from './host-connector.js';
import { MuxDecoder, MuxEncoder, MuxStreamState } from './mux.js';
import { startRelayServer } from './relay-server.js';

function waitForMessage(socket: WebSocket, accept: (event: MessageEvent) => boolean): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for relay frame')), 3000);
    const onMessage = (event: MessageEvent) => {
      if (!accept(event)) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      resolve(event);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('phone relay socket error'));
    }, { once: true });
  });
}

test('relay host connector authenticates outbound and serves an encrypted HTTP mux request', async () => {
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(7));
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const signingKeys = generateKeyPairSync('ed25519');
  const publicDer = signingKeys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = publicDer.subarray(-32).toString('base64url');
  const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', trustedHostKeys: new Map([[serverId, publicKey]]) });
  let handled = 0;
  let slowStarted = 0;
  let slowAborted = 0;
  let host: Awaited<ReturnType<typeof connectRelayHost>> | undefined;
  let phone: WebSocket | undefined;

  try {
    host = await connectRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}/host`,
      daemonKeys,
      hostSigningKey: signingKeys.privateKey,
      async handleRequest(request) {
        handled += 1;
        if (new URL(request.url).pathname === '/slow') {
          slowStarted += 1;
          return await new Promise<Response>(resolve => {
            request.signal.addEventListener('abort', () => {
              slowAborted += 1;
              resolve(new Response('cancelled', { status: 499 }));
            }, { once: true });
          });
        }
        expect(request.url).toBe('http://app--alice.elanous.app/health');
        expect(request.method).toBe('POST');
        expect(await request.text()).toBe('relay request body');
        return new Response(new Uint8Array([0, 1, 255]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      },
    });
    expect(host.serverId).toBe(serverId);
    expect(relay.stats(serverId).host).toBe(true);

    const phoneSocket = new WebSocket(`ws://127.0.0.1:${relay.port}/client?serverId=${serverId}`);
    phone = phoneSocket;
    phone.binaryType = 'arraybuffer';
    const connected = await waitForMessage(phoneSocket, event => typeof event.data === 'string' && JSON.parse(event.data).type === 'connected');
    const clientId = JSON.parse(connected.data as string).clientId as number;
    const phoneResult = await createPhoneChannel(daemonKeys.publicKey, daemonKeys.publicKey, new Uint8Array(32).fill(8));
    if (!phoneResult.ok) throw new Error(phoneResult.reason);
    const phoneChannel = phoneResult.value;
    const streams = new MuxStreamState();
    const encoder = new MuxEncoder(streams);
    const decoder = new MuxDecoder(streams);
    const sendMuxFrame = (frame: Parameters<typeof encoder.encode>[0]) => {
      const encoded = encoder.encode(frame);
      if (!encoded.ok) throw new Error(encoded.reason);
      const sealed = phoneChannel.channel.seal(encoded.value);
      if (!sealed.ok) throw new Error(sealed.reason);
      phoneSocket.send(sealed.value);
    };
    phoneSocket.send(phoneChannel.phonePublicKey);
    const open = encoder.encode({
      streamId: 9,
      kind: 'open',
      protocol: 'http',
      method: 'POST',
      path: '/health',
      headers: { host: 'app--alice.elanous.app', authorization: 'Bearer private-test-token', 'content-length': '18' },
    });
    if (!open.ok) throw new Error(open.reason);
    const encrypted = phoneChannel.channel.seal(open.value);
    if (!encrypted.ok) throw new Error(encrypted.reason);
    phoneSocket.send(encrypted.value);

    const body = encoder.encode({ streamId: 9, kind: 'data', data: new TextEncoder().encode('relay request body') });
    if (!body.ok) throw new Error(body.reason);
    const encryptedBody = phoneChannel.channel.seal(body.value);
    if (!encryptedBody.ok) throw new Error(encryptedBody.reason);
    phoneSocket.send(encryptedBody.value);
    const close = encoder.encode({ streamId: 9, kind: 'end' });
    if (!close.ok) throw new Error(close.reason);
    const encryptedClose = phoneChannel.channel.seal(close.value);
    if (!encryptedClose.ok) throw new Error(encryptedClose.reason);
    phoneSocket.send(encryptedClose.value);

    const frame = await waitForMessage(phoneSocket, event => typeof event.data !== 'string');
    const decrypted = phoneChannel.channel.open(new Uint8Array(frame.data as ArrayBuffer));
    if (!decrypted.ok) throw new Error(decrypted.reason);
    const muxed = decoder.decode(decrypted.value);
    if (!muxed.ok || muxed.value.kind !== 'data') throw new Error(muxed.ok ? 'expected data frame' : muxed.reason);
    const response = JSON.parse(new TextDecoder().decode(muxed.value.data)) as { status: number; headers: Record<string, string>; body: string };

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.from(response.body, 'base64')).toEqual(Buffer.from([0, 1, 255]));
    expect(handled).toBe(1);
    expect(clientId).toBeGreaterThan(0);
    const responseCloseFrame = await waitForMessage(phoneSocket, event => typeof event.data !== 'string');
    const responseClose = phoneChannel.channel.open(new Uint8Array(responseCloseFrame.data as ArrayBuffer));
    if (!responseClose.ok) throw new Error(responseClose.reason);
    const decodedClose = decoder.decode(responseClose.value);
    expect(decodedClose).toEqual({ ok: true, value: { streamId: 9, kind: 'close', reason: '' } });

    const cancelledOpen = encoder.encode({ streamId: 10, kind: 'open', protocol: 'http', method: 'POST', path: '/cancel',
      headers: { host: 'app--alice.elanous.app', 'content-length': '10' } });
    if (!cancelledOpen.ok) throw new Error(cancelledOpen.reason);
    const sealedCancelledOpen = phoneChannel.channel.seal(cancelledOpen.value);
    if (!sealedCancelledOpen.ok) throw new Error(sealedCancelledOpen.reason);
    phoneSocket.send(sealedCancelledOpen.value);
    const cancelledClose = encoder.encode({ streamId: 10, kind: 'close', reason: 'cancelled' });
    if (!cancelledClose.ok) throw new Error(cancelledClose.reason);
    const sealedCancelledClose = phoneChannel.channel.seal(cancelledClose.value);
    if (!sealedCancelledClose.ok) throw new Error(sealedCancelledClose.reason);
    phoneSocket.send(sealedCancelledClose.value);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(handled).toBe(1);

    for (let streamId = 100; streamId < 132; streamId += 1) {
      sendMuxFrame({ streamId, kind: 'open', protocol: 'http', method: 'GET', path: '/slow', headers: { host: 'app--alice.elanous.app' } });
      sendMuxFrame({ streamId, kind: 'end' });
    }
    for (let attempt = 0; attempt < 200 && slowStarted < 32; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(slowStarted).toBe(32);
    const capacityResponse = waitForMessage(phoneSocket, event => typeof event.data !== 'string');
    sendMuxFrame({ streamId: 132, kind: 'open', protocol: 'http', method: 'GET', path: '/over-capacity', headers: { host: 'app--alice.elanous.app' } });
    const capacityFrame = await capacityResponse;
    const capacityPlaintext = phoneChannel.channel.open(new Uint8Array(capacityFrame.data as ArrayBuffer));
    if (!capacityPlaintext.ok) throw new Error(capacityPlaintext.reason);
    const capacityDecoded = decoder.decode(capacityPlaintext.value);
    if (!capacityDecoded.ok || capacityDecoded.value.kind !== 'data') throw new Error('expected pending-capacity response');
    expect(JSON.parse(new TextDecoder().decode(capacityDecoded.value.data)).status).toBe(429);
    sendMuxFrame({ streamId: 100, kind: 'close', reason: 'cancel slow request' });
    for (let attempt = 0; attempt < 200 && slowAborted < 1; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(slowAborted).toBe(1);
    for (let streamId = 101; streamId < 132; streamId += 1) sendMuxFrame({ streamId, kind: 'close', reason: 'cancel slow request' });
    for (let attempt = 0; attempt < 200 && slowAborted < 32; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(slowAborted).toBe(32);
  } finally {
    phone?.close();
    host?.close();
    relay.stop();
  }
});

test('relay host connector rejects non-loopback plaintext transport before connecting', async () => {
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(9));
  const signingKeys = generateKeyPairSync('ed25519');
  let connected = false;
  await expect(connectRelayHost({
    relayUrl: 'ws://relay.example.test/host',
    daemonKeys,
    hostSigningKey: signingKeys.privateKey,
    handleRequest: () => new Response('unused'),
    webSocketFactory() { connected = true; throw new Error('must not connect'); },
  })).rejects.toThrow('non-loopback relay connections require wss://');
  expect(connected).toBe(false);
});

test('relay host identity stays inside the config root and rejects symlink parents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-identity-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'relay-identity-outside-'));
  setElanousConfigDir(root);
  try {
    await expect(loadOrCreateRelayHostIdentity(join(outside, 'identity.json')))
      .rejects.toThrow('must stay inside');
    symlinkSync(outside, join(root, 'linked'));
    await expect(loadOrCreateRelayHostIdentity(join(root, 'linked', 'identity.json')))
      .rejects.toThrow('must not use symlinks');
  } finally {
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
