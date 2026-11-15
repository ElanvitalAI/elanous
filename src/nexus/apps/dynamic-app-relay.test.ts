import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptDaemonChannel, generateDaemonKeyPair, serverIdFromPublicKey } from '../../relay/channel.js';
import { MuxDecoder, MuxEncoder, MuxStreamState } from '../../relay/mux.js';
import { challengeMessage, startRelayServer } from '../../relay/relay-server.js';
import { loadNexusAppHost } from './app-host.js';
import { createDynamicAppPublisher, createDynamicAppPublishRoute } from './dynamic-app-publish.js';

type RelayMessage = string | Uint8Array;

/** Test-only TLS ingress. The exact public URL stays intact; socket lookup is pinned to loopback. */
async function fetchExactHttpsViaTestEdge(relayPort: number, publicHost: string): Promise<Response> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dynamic-test-tls-')));
  const key = join(root, 'key.pem');
  const cert = join(root, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', `/CN=${publicHost}`,
    '-addext', `subjectAltName=DNS:${publicHost}`], { stdio: 'ignore' });
  const edge = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (incoming, outgoing) => {
    try {
      const upstream = await fetch(`http://127.0.0.1:${relayPort}${incoming.url ?? '/'}`, {
        headers: { host: publicHost, authorization: incoming.headers.authorization ?? '' },
      });
      outgoing.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      outgoing.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { outgoing.writeHead(502); outgoing.end(); }
  });
  try {
    await new Promise<void>(resolve => edge.listen(0, '127.0.0.1', resolve));
    const address = edge.address();
    if (!address || typeof address === 'string') throw new Error('missing test TLS port');
    const url = `https://${publicHost}/`;
    return await new Promise<Response>((resolve, reject) => {
      const client = httpsRequest(url, { hostname: '127.0.0.1', port: address.port,
        servername: publicHost, ca: readFileSync(cert),
        headers: { host: publicHost, authorization: 'Bearer emt_fake_owner' } }, response => {
        if (!(response.socket as TLSSocket).authorized) { reject(new Error('test TLS certificate not verified')); return; }
        const status = response.statusCode;
        if (status === undefined) { reject(new Error('test HTTPS response has no status')); return; }
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
          status, headers: response.headers as Record<string, string>,
        })));
        response.on('error', reject);
      });
      client.on('error', reject); client.end();
    });
  } finally {
    edge.closeAllConnections();
    edge.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function fetchMountedAppThroughRelay(
  publicHost: string,
  userSlug: string,
  appHost: Awaited<ReturnType<typeof loadNexusAppHost>>['appHost'],
  request: { readonly path?: string; readonly method?: 'GET' | 'POST'; readonly body?: string; readonly https?: boolean } = {},
): Promise<Response> {
  const signingKey = generateKeyPairSync('ed25519');
  const signingPublicKey = signingKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(39));
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const relay = startRelayServer({ trustedHostKeys: new Map([[serverId, signingPublicKey]]), publicDomain: 'elanous.app',
    publicDispatchRoutes: new Map([[userSlug, { serverId, ownerMemberId: 'member-fake' }]]), memberRequired: true,
    hostOwnerMemberIds: new Map([[serverId, 'member-fake']]),
    validateMemberToken: async token => token === 'emt_fake_owner' ? { memberId: 'member-fake' }
      : token === 'emt_fake_foreign' ? { memberId: 'member-other' } : null });
  const inbox: RelayMessage[] = [];
  const waiters: ((message: RelayMessage) => void)[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/host?serverId=${serverId}`, 'emt_fake_owner');
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', event => {
    const message = typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer);
    const waiter = waiters.shift();
    if (waiter) waiter(message); else inbox.push(message);
  });
  const next = (): Promise<RelayMessage> => inbox.length
    ? Promise.resolve(inbox.shift()!)
    : new Promise(resolve => waiters.push(resolve));
  const tagged = (clientId: number, bytes: Uint8Array): Uint8Array => {
    const result = new Uint8Array(bytes.length + 4);
    new DataView(result.buffer).setUint32(0, clientId, false);
    result.set(bytes, 4);
    return result;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('relay host connection failed')), { once: true });
    });
    const challenge = JSON.parse(await next() as string) as { nonce: string };
    socket.send(JSON.stringify({ type: 'auth', publicKey: signingPublicKey,
      signature: sign(null, challengeMessage(serverId, challenge.nonce), signingKey.privateKey).toString('base64url') }));
    expect(JSON.parse(await next() as string)).toMatchObject({ type: 'authenticated', capabilities: ['public-http-v1'] });
    socket.send(JSON.stringify({ type: 'host-public-key', publicKey: Buffer.from(daemonKeys.publicKey).toString('base64url') }));
    expect(JSON.parse(await next() as string)).toEqual({ type: 'host-public-key-accepted' });

    const foreign = await fetch(`http://127.0.0.1:${relay.port}/`, {
      headers: { host: publicHost, authorization: 'Bearer emt_fake_foreign' },
    });
    expect(foreign.status).toBe(404);
    const anonymous = await fetch(`http://127.0.0.1:${relay.port}/`, { headers: { host: publicHost } });
    expect(anonymous.status).toBe(401);

    const method = request.method ?? 'GET';
    const path = request.path ?? '/';
    const relayPort = relay.port;
    if (relayPort === undefined) throw new Error('missing test relay port');
    const responsePromise = request.https ? fetchExactHttpsViaTestEdge(relayPort, publicHost) : fetch(`http://127.0.0.1:${relayPort}${path}`, {
      method,
      headers: { host: publicHost, authorization: 'Bearer emt_fake_owner',
        ...(method === 'POST' ? { origin: `https://${publicHost}`, 'content-type': 'application/json' } : {}) },
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    const taggedPhoneKey = await next() as Uint8Array;
    const clientId = new DataView(taggedPhoneKey.buffer, taggedPhoneKey.byteOffset, 4).getUint32(0, false);
    const channel = await acceptDaemonChannel(daemonKeys, taggedPhoneKey.subarray(4));
    if (!channel.ok) throw new Error(channel.reason);
    const streams = new MuxStreamState();
    const decoder = new MuxDecoder(streams);
    const encoder = new MuxEncoder(streams);
    const requestOpen = await next() as Uint8Array;
    const opened = channel.value.open(requestOpen.subarray(4));
    if (!opened.ok) throw new Error(opened.reason);
    const openFrame = decoder.decode(opened.value);
    if (!openFrame.ok || openFrame.value.kind !== 'open' || openFrame.value.protocol !== 'http') throw new Error('expected public HTTP request');
    const requestChunks: Uint8Array[] = [];
    for (;;) {
      const requestFrame = await next() as Uint8Array;
      const openedFrame = channel.value.open(requestFrame.subarray(4));
      if (!openedFrame.ok) throw new Error(openedFrame.reason);
      const decoded = decoder.decode(openedFrame.value);
      if (!decoded.ok) throw new Error(decoded.reason);
      if (decoded.value.kind === 'end') break;
      if (decoded.value.kind !== 'data') throw new Error('expected request data or end frame');
      requestChunks.push(decoded.value.data);
    }
    const internalHost = `${openFrame.value.headers.host}`;
    expect(internalHost).toBe(publicHost.split('--')[0] + '.app.localhost');
    const requestBody = Buffer.concat(requestChunks.map(chunk => Buffer.from(chunk)));
    const appResponse = await appHost.handle(new Request(`http://${internalHost}${openFrame.value.path}`, {
      method: openFrame.value.method,
      headers: openFrame.value.headers,
      ...(requestBody.byteLength ? { body: requestBody } : {}),
    }));
    const response = appResponse ?? new Response('Not found', { status: 404 });
    const envelope = new TextEncoder().encode(JSON.stringify({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(await response.arrayBuffer()).toString('base64'),
    }));
    const dataFrame = encoder.encode({ streamId: openFrame.value.streamId, kind: 'data', data: envelope });
    if (!dataFrame.ok) throw new Error(dataFrame.reason);
    const encryptedData = channel.value.seal(dataFrame.value);
    if (!encryptedData.ok) throw new Error(encryptedData.reason);
    socket.send(tagged(clientId, encryptedData.value));
    const closeFrame = encoder.encode({ streamId: openFrame.value.streamId, kind: 'close', reason: '' });
    if (!closeFrame.ok) throw new Error(closeFrame.reason);
    const encryptedClose = channel.value.seal(closeFrame.value);
    if (!encryptedClose.ok) throw new Error(encryptedClose.reason);
    socket.send(tagged(clientId, encryptedClose.value));
    return await responsePromise;
  } finally {
    socket.close();
    relay.stop();
  }
}

test('reserved source reaches real encrypted relay, local service, and exact test handle HTTPS 200', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dynamic-relay-')));
  for (const name of ['apps', 'sources', 'seals', 'runtime']) mkdirSync(join(root, name), { mode: 0o700 });
  const { appHost } = loadNexusAppHost(join(root, 'apps'), undefined,
    { key: randomBytes(32).toString('hex'), dir: join(root, 'sessions') });
  const owner = { memberId: 'member-fake', userSlug: 'fake-slot' };
  const publisher = createDynamicAppPublisher({ sourceRoot: join(root, 'sources'), sealRoot: join(root, 'seals'),
    runtimeRoot: join(root, 'runtime'), appHost, testMemberId: owner.memberId, testHandle: owner.userSlug,
    testApprovalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    issuerSourceHead: 'a'.repeat(40),
    approveArtifact: () => true,
    verifyPublic: async url => {
      const response = await appHost.handle(new Request(url, { headers: { host: new URL(url).host } }));
      return { status: response?.status ?? 404, marker: response?.headers.get('x-elanous-dynamic-route') ?? null };
    } });
  const route = createDynamicAppPublishRoute(publisher, async request =>
    request.headers.get('authorization') === 'Bearer aps_fake_owner' ? owner : null);
  const call = async (action: string, deploymentId?: string) => {
    const response = await route(new Request('http://localhost/v1/apps/demo-app/dynamic-deployment', {
      method: 'POST', headers: { authorization: 'Bearer aps_fake_owner', 'content-type': 'application/json' },
      body: JSON.stringify({ action, runId: 'run-relay', ...(deploymentId ? { deploymentId } : {}) }),
    }));
    if (response?.status !== 200) throw new Error('dynamic product route refused');
    return await response.json() as Record<string, string>;
  };
  try {
    const { sourceRoot } = await call('reserve');
    mkdirSync(sourceRoot, { mode: 0o700 });
    mkdirSync(join(sourceRoot, 'backend'), { mode: 0o700 });
    mkdirSync(join(sourceRoot, 'frontend'), { mode: 0o700 });
    const backend = 'let stored = "relay api"; export default { async fetch(request: Request) { const path = new URL(request.url).pathname; if (path === "/health") return new Response("healthy"); if (!path.startsWith("/api/")) return new Response("Not found", { status: 404 }); if (request.method === "POST" && path === "/api/items") { stored = await request.text(); return new Response(stored); } return new Response(stored); } };\n';
    const frontend = '<html><body>relay front</body></html>\n';
    const stylesheet = 'body { color: blue; }\n';
    const namedAsset = 'normal spaced asset\n';
    const architecture = '# synthetic relay\n';
    writeFileSync(join(sourceRoot, 'backend/server.ts'), backend, { mode: 0o600 });
    writeFileSync(join(sourceRoot, 'frontend/index.html'), frontend, { mode: 0o600 });
    writeFileSync(join(sourceRoot, 'frontend/main.css'), stylesheet, { mode: 0o600 });
    writeFileSync(join(sourceRoot, 'frontend/my file.txt'), namedAsset, { mode: 0o600 });
    writeFileSync(join(sourceRoot, 'ARCHITECTURE.md'), architecture, { mode: 0o600 });
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    writeFileSync(join(sourceRoot, 'source-artifact.json'), JSON.stringify({ schemaVersion: 'source-artifact@1', root: sourceRoot,
      files: { 'ARCHITECTURE.md': sha(architecture), 'backend/server.ts': sha(backend),
        'frontend/index.html': sha(frontend), 'frontend/main.css': sha(stylesheet),
        'frontend/my file.txt': sha(namedAsset) },
      metadata: { runtime: { startCommand: ['bun', 'backend/server.ts'], healthPath: '/health' },
        frontendRoot: 'frontend', apiPrefix: '/api' },
      executed: false, published: false }), { mode: 0o600 });
    const published = await call('publish');
    expect(published.publicUrl).toBe('https://demo-app--fake-slot.elanous.app');
    const response = await fetchMountedAppThroughRelay('demo-app--fake-slot.elanous.app', owner.userSlug, appHost, { https: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-elanous-dynamic-route')).toMatch(/^[0-9a-f]{48}$/);
    expect(await response.text()).toBe(frontend);
    console.log(JSON.stringify({ testUniverse: true, publicUrl: published.publicUrl, httpsStatus: response.status,
      tlsIngress: 'loopback-only', relayRoute: 'fake-slot', servicePort: published.port }));
    const asset = await fetchMountedAppThroughRelay('demo-app--fake-slot.elanous.app', owner.userSlug, appHost,
      { path: '/main.css' });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await asset.text()).toBe(stylesheet);
    const spaced = await fetchMountedAppThroughRelay('demo-app--fake-slot.elanous.app', owner.userSlug, appHost,
      { path: '/my%20file.txt' });
    expect(spaced.status).toBe(200);
    expect(await spaced.text()).toBe(namedAsset);
    const encodedSlash = await appHost.handle(new Request('http://demo-app.app.localhost/api%2fitems',
      { headers: { host: 'demo-app.app.localhost' } }));
    expect(encodedSlash?.status).toBe(404);
    const saved = await fetchMountedAppThroughRelay('demo-app--fake-slot.elanous.app', owner.userSlug, appHost,
      { path: '/api/items', method: 'POST', body: 'fake-seat-A1' });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toBe('fake-seat-A1');
    const loaded = await fetchMountedAppThroughRelay('demo-app--fake-slot.elanous.app', owner.userSlug, appHost,
      { path: '/api/items' });
    expect(loaded.status).toBe(200);
    expect(await loaded.text()).toBe('fake-seat-A1');
    const crossOrigin = await appHost.handle(new Request('http://demo-app.app.localhost/api/items', {
      method: 'POST', headers: { host: 'demo-app.app.localhost', origin: 'https://foreign.example',
        'content-type': 'text/plain' }, body: 'bad' }));
    expect(crossOrigin?.status).toBe(403);
    expect((await call('undo', published.deploymentId)).status).toBe('undone');
  } finally {
    await publisher.close(); appHost.close(); rmSync(root, { recursive: true, force: true });
  }
});
