import { expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptDaemonChannel, generateDaemonKeyPair, serverIdFromPublicKey } from '../../relay/channel.js';
import { MuxDecoder, MuxEncoder, MuxStreamState } from '../../relay/mux.js';
import { challengeMessage, startRelayServer } from '../../relay/relay-server.js';
import { createAppStorage } from './app-storage.js';
import type { AppManifest } from './app-contract.js';
import { loadNexusAppHost } from './app-host.js';
import { createAppPublishServerAdapter } from './app-publish.js';
import { publicAppAddress } from './console-address.js';

const appManifest = (slug: string, publicRead = false) => `apiVersion: elanous.app/v0
slug: ${slug}
title: ${slug}
frontend: { kind: static-export, out: out }
roles:
  owner: { via: nexus-session }
  viewer: { via: share-link }
${publicRead ? '  public: { via: public-read }\n' : ''}tables:
  items:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
rpc:
  listItems:
    sql: SELECT id, title FROM items
    allow: [owner${publicRead ? ', public' : ''}]
  addItem:
    sql: INSERT INTO items (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
`;
const authKey = 'kaist-qr-live-simulation-signing-key-at-least-256-bits';
const storageKey = 'kaist-qr-live-storage-signing-key-at-least-256-bits';

type RelayMessage = string | Uint8Array;

async function fetchMountedAppThroughRelay(
  publicHost: string,
  userSlug: string,
  appHost: Awaited<ReturnType<typeof loadNexusAppHost>>['appHost'],
  request: { readonly path?: string; readonly method?: 'GET' | 'POST'; readonly body?: string } = {},
): Promise<Response> {
  const signingKey = generateKeyPairSync('ed25519');
  const signingPublicKey = signingKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(39));
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const relay = startRelayServer({ trustedHostKeys: new Map([[serverId, signingPublicKey]]), publicDomain: 'elanous.app', publicServerId: serverId, publicUserId: userSlug });
  const inbox: RelayMessage[] = [];
  const waiters: ((message: RelayMessage) => void)[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/host?serverId=${serverId}`);
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

    const method = request.method ?? 'GET';
    const path = request.path ?? '/';
    const responsePromise = fetch(`http://127.0.0.1:${relay.port}${path}`, {
      method,
      headers: { host: publicHost, ...(method === 'POST' ? { origin: `https://${publicHost}`, 'content-type': 'application/json' } : {}) },
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
    expect(internalHost).toBe('lecture-scrap.app.localhost');
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

test('KAIST-APP-QR-LIVE routes a public QR Host through the real relay and isolates app sessions and storage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kaist-app-qr-live-'));
  const user = 'kaist-demo';
  const slugs = ['lecture-scrap', 'private-notes'] as const;
  const publicHosts = slugs.map(slug => `${slug}--${user}.elanous.app`);
  const appDir = (slug: string) => join(root, slug);
  for (const slug of slugs) {
    const out = join(appDir(slug), 'out');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(appDir(slug), 'app.yaml'), appManifest(slug, slug === 'lecture-scrap'));
    writeFileSync(join(out, 'index.html'), `<main>${slug}</main>`);
  }
  const mounted = loadNexusAppHost(root, undefined, {
    dir: join(root, 'tokens'),
    databaseDirectory: join(root, 'db'),
    key: authKey,
    now: () => Date.UTC(2026, 10, 9),
  });
  const appStorage = createAppStorage(slugs.map((slug): AppManifest => ({
    apiVersion: 'elanous.app/v0', slug, title: slug,
    storage: { prefix: `apps/${slug}/`, quotaBytes: 128, upload: { allow: ['owner'], types: ['text/plain'] } },
  })), {
    config: { provider: 'local', localDir: join(root, 'object-store'), bucket: 'private', publicBucket: '', prefix: 'apps' },
    signingKey: storageKey,
  });
  const publisher = createAppPublishServerAdapter(mounted.appHost, {
    getManifest: slug => mounted.appHost.getManifest(slug),
    authorizeOwner: (_request, slug) => slug === 'lecture-scrap',
    rootForApp: slug => join(root, 'published', slug),
    originForApp: slug => publicAppAddress({ appSlug: slug, userSlug: user }),
    now: () => Date.UTC(2026, 10, 9),
  });
  const publicAppHost = publisher.appHost;
  try {
    expect(mounted.issues).toEqual([]);
    const sessionCookies = new Map<string, string>();
    for (let index = 0; index < slugs.length; index += 1) {
      const slug = slugs[index]!;
      const publicHost = publicHosts[index]!;
      const internalHost = `${slug}.app.localhost`;
      const invite = mounted.appHost.issueInvitation(slug, 'owner', undefined, 'viewer');
      const accepted = await mounted.appHost.handle(new Request(`http://${internalHost}/__auth/accept?token=${encodeURIComponent(invite.token)}`, {
        headers: { host: internalHost },
      }));
      expect(accepted?.status).toBe(303);
      const setCookie = accepted?.headers.get('set-cookie');
      expect(setCookie).toContain('__Host-app-session=');
      expect(setCookie).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax/);
      expect(setCookie).not.toMatch(/;\s*Domain=/i);
      const cookie = setCookie?.split(';', 1)[0];
      expect(cookie).toBeString();
      sessionCookies.set(slug, cookie!);

      const opened = index === 0
        ? await fetchMountedAppThroughRelay(publicHost, user, mounted.appHost)
        : await mounted.appHost.handle(new Request(`http://${internalHost}/`, { headers: { host: internalHost, cookie: cookie! } }));
      expect(opened?.status).toBe(200);
      expect(await opened?.text()).toContain(slug);
    }

    const firstInternalHost = `${slugs[0]}.app.localhost`;
    const secondInternalHost = `${slugs[1]}.app.localhost`;
    const leakedCookieResponse = await mounted.appHost.handle(new Request(`http://${secondInternalHost}/`, {
      headers: { host: secondInternalHost, cookie: sessionCookies.get(slugs[0]!)! },
    }));
    expect(leakedCookieResponse?.status).toBe(401);

    const publicRead = await fetchMountedAppThroughRelay(publicHosts[0]!, user, mounted.appHost, {
      path: '/__rpc/listItems', method: 'POST', body: '{}',
    });
    expect(publicRead.status).toBe(200);
    expect(await publicRead.json()).toEqual({ rows: [] });
    const publicWrite = await fetchMountedAppThroughRelay(publicHosts[0]!, user, mounted.appHost, {
      path: '/__rpc/addItem', method: 'POST', body: '{"params":{"id":"public-write","title":"must be denied"}}',
    });
    expect(publicWrite.status).toBe(403);

    const privateValue = new TextEncoder().encode('lecture-scrap-only');
    expect(appStorage.upload({ appSlug: slugs[0], key: 'private-note.txt', body: privateValue, contentType: 'text/plain', role: 'owner' }).status).toBe(201);
    expect(appStorage.read({ appSlug: slugs[0], key: 'private-note.txt' }).body).toEqual(privateValue);
    expect(appStorage.read({ appSlug: slugs[1], key: 'private-note.txt' }).status).toBe(404);

    const published = await publisher.handleApiRequest(new Request('http://nexus.invalid/v1/apps/lecture-scrap/publish', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Lecture notes', markdown: 'private **lecture notes**' }),
    }));
    expect(published?.status).toBe(201);
    const result = await published!.json() as { id: string; shareUrl: string };
    expect(result.shareUrl).toMatch(/^https:\/\/lecture-scrap--kaist-demo\.elanous\.app\/share\/[A-Za-z0-9_-]{22}$/);
    const share = await publicAppHost.handle(new Request(`http://${firstInternalHost}/share/${result.id}`, {
      headers: { host: firstInternalHost },
    }));
    expect(share?.status).toBe(200);
    expect(share?.headers.get('x-app-version')).toBe(result.id);
    expect(await share?.text()).toContain('private <strong>lecture notes</strong>');
    const crossAppShare = await publicAppHost.handle(new Request(`http://${secondInternalHost}/share/${result.id}`, {
      headers: { host: secondInternalHost },
    }));
    expect(crossAppShare?.status).toBe(404);

    expect(publicAppAddress({ appSlug: slugs[0], userSlug: user })).toBe(`https://${publicHosts[0]}`);
    expect(new URL(`https://${publicHosts[0]}`).origin).not.toBe(new URL(`https://${publicHosts[1]}`).origin);
    expect(publicHosts[0]).not.toBe(publicHosts[1]);
  } finally {
    publicAppHost.close();
    appStorage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
