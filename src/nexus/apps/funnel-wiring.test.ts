import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from '../api/event-bus.js';
import { startNexusHttpServer } from '../api/http-server.js';
import { createAppActions, handleAppActionRequest, type AppActionDeclaration } from './app-actions.js';
import { parseAppManifest } from './app-contract.js';
import { loadNexusAppHost } from './app-host.js';
import { createNexusFunnelRuntime, hashNexusFunnelIdentity, type NexusFunnelEvent } from './funnel-observe.js';
import { createAppStorageRoute } from './app-storage-route.js';
import { createAppStorage } from './app-storage.js';
import type { StorageConfig } from '../../storage/object-store.js';

const APP_AUTH_KEY = 'nexus-funnel-wiring-test-signing-key-at-least-256-bits';
const STORAGE_SIGNING_KEY = 'nexus-funnel-wiring-storage-signing-key-at-least-256-bits';
const APP_YAML = `apiVersion: elanous.app/v0
slug: voice-note
title: Voice notes
frontend: { kind: static-export, out: out }
roles: { owner: { via: nexus-session }, viewer: { via: share-link } }
actions:
  summarize:
    builtin: summarize
    input: { text: text }
    output: { text: text }
    uses: [cred:openai.api_key]
storage:
  prefix: apps/voice-note/
  quotaBytes: 5
  upload:
    allow: [owner]
    types: [audio/wav]
    maxBytes: 512
`;

function uniquePort(): number { return 43_000 + Math.floor(Math.random() * 2_000); }

function storageConfig(root: string): StorageConfig {
  return { provider: 'local', localDir: join(root, 'objects'), bucket: 'private', publicBucket: '', prefix: 'apps' };
}

test('Nexus HTTP entry points emit only the four wired funnel events with hashed install identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-funnel-wire-'));
  const appsDir = join(root, 'apps');
  const appDir = join(appsDir, 'voice-note');
  const outDir = join(appDir, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(appDir, 'app.yaml'), APP_YAML);
  writeFileSync(join(outDir, 'index.html'), '<main>voice notes</main>');
  const parsed = parseAppManifest(APP_YAML);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));

  const events: NexusFunnelEvent[] = [];
  const funnel = createNexusFunnelRuntime('test-nexus-installation-id', event => { events.push(event); });
  const { appHost } = loadNexusAppHost(appsDir, undefined, {
    dir: join(root, 'auth-tokens'), databaseDirectory: join(root, 'databases'), key: APP_AUTH_KEY, funnel,
  });
  const storage = createAppStorage([parsed.manifest], {
    config: storageConfig(root), signingKey: STORAGE_SIGNING_KEY, funnel,
  });
  const actions = createAppActions({
    secrets: { async resolve() { return 'wire-test-secret'; } },
    summarize: async ({ text }) => `summary: ${text}`,
    funnel,
  });
  const appActionRoute = (request: Request) => handleAppActionRequest(request, {
    authorize: candidate => candidate.headers.get('authorization') === 'Bearer nexus-test-token',
    getDeclaration: (_appSlug, name): AppActionDeclaration | undefined => name === 'summarize'
      ? { builtin: 'summarize', uses: ['cred:openai.api_key'] }
      : undefined,
    run: input => actions.run(input),
  });
  const appStorageRoute = createAppStorageRoute({
    storage,
    getManifest: slug => slug === parsed.manifest.slug ? parsed.manifest : undefined,
    authorize: request => request.headers.get('authorization') === 'Bearer nexus-test-token',
  });
  const state = createNexusState({ nexusVersion: 'funnel-test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const server = startNexusHttpServer({
    state, eventBus, registry: new TabRegistry(state), startPort: uniquePort(),
    metaApi: { bearerToken: 'nexus-test-token', noAuth: false },
    appHost, appRoutes: [appActionRoute, appStorageRoute],
  });

  try {
    const authorization = { authorization: 'Bearer nexus-test-token' };
    const invitationResponse = await fetch(`${server.url}/v1/nexus/apps/voice-note/invitations`, {
      method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ invitedBy: 'raw-owner-id-must-not-be-logged' }),
    });
    expect(invitationResponse.status).toBe(201);
    const invitation = await invitationResponse.json() as { invitation: { token: string } };

    const accepted = await fetch(`${server.url}/__auth/accept?token=${encodeURIComponent(invitation.invitation.token)}`, {
      headers: { host: 'voice-note.app.localhost' }, redirect: 'manual',
    });
    expect(accepted.status).toBe(303);
    const sessionCookie = accepted.headers.get('set-cookie');
    expect(sessionCookie).toContain('__Host-app-session=');
    const appOpen = await fetch(server.url, { headers: { host: 'voice-note.app.localhost', cookie: sessionCookie! } });
    expect(appOpen.status).toBe(200);

    const actionResponse = await fetch(`${server.url}/v1/apps/voice-note/actions/summarize`, {
      method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'first successful app action' }),
    });
    expect(actionResponse.status).toBe(200);
    expect(await actionResponse.json()).toMatchObject({ ok: true, text: 'summary: first successful app action' });
    const subsequentActionResponse = await fetch(`${server.url}/v1/apps/voice-note/actions/summarize`, {
      method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'a later successful app action' }),
    });
    expect(subsequentActionResponse.status).toBe(200);

    const signUpload = async (key: string) => {
      const response = await fetch(`${server.url}/v1/apps/voice-note/storage/uploads`, {
        method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ key, expiresInMs: 60_000, role: 'owner' }),
      });
      expect(response.status).toBe(200);
      return (await response.json() as { url: string }).url;
    };
    const firstUpload = await fetch(await signUpload('audio/first.wav'), {
      method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([1, 2, 3, 4, 5]),
    });
    expect(firstUpload.status).toBe(201);
    const overQuotaUpload = await fetch(await signUpload('audio/over-quota.wav'), {
      method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([6]),
    });
    expect(overQuotaUpload.status).toBe(413);

    expect(events.map(event => event.type)).toEqual(['invite-sent', 'app-open', 'first-success', 'limit-reached']);
    expect(events.every(event => event.accountHash === hashNexusFunnelIdentity('account', 'test-nexus-installation-id'))).toBe(true);
    expect(events.find(event => event.type === 'app-open')).toMatchObject({ appHash: hashNexusFunnelIdentity('app', 'voice-note') });
    expect(events.find(event => event.type === 'first-success')).toMatchObject({ appHash: hashNexusFunnelIdentity('app', 'voice-note') });
    expect(events.find(event => event.type === 'limit-reached')).toMatchObject({ appHash: hashNexusFunnelIdentity('app', 'voice-note') });
    expect(JSON.stringify(events)).not.toContain('raw-owner-id-must-not-be-logged');
    expect(events.some(event => event.type === 'signup' || event.type === 'paid-convert')).toBe(false);
  } finally {
    server.stop();
    appHost.close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
