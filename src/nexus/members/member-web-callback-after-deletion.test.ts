import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';
import { routeRequest } from '../api/http-server.js';
import { createDevProxyRuntimeRef } from '../api/admin-dev-proxy.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from '../api/event-bus.js';

test('active returning member callback works; post-deletion callback cannot create a usable web session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-web-callback-delete-'));
  const now = () => Date.parse('2026-11-15T00:00:00.000Z');
  const store = createMemberStore({ path: join(root, 'members.sqlite'), now });
  try {
    const original = store.register({ sub: 'returning-subject', email: 'returning@example.test',
      emailVerified: true, name: 'Returning' }, { consents: { privacy: 'v1', terms: 'v1' } });
    let completions = 0;
    const api = createMembersApi({ store, now, google: {
      redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
      complete: async () => {
        completions++;
        return { identity: { sub: 'returning-subject', email: 'returning@example.test',
          emailVerified: true, name: 'Returning' },
          intent: { consents: { privacy: 'v1', terms: 'v1' } } };
      },
    } as never, successRedirectUri: 'https://app.example.test/member', webOrigin: 'https://app.example.test' });
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    const eventBus = new NexusEventBus();
    state.bus = eventBus;
    const opts = { state, eventBus, registry: new TabRegistry(state), membersApi: api,
      metaApi: { bearerToken: 'synthetic-operator-only', noAuth: false } };
    const server = { requestIP: () => ({ address: '127.0.0.1' }) };
    const proxyRef = createDevProxyRuntimeRef();
    const route = (request: Request) => routeRequest(request, opts, server as never, null, proxyRef);
    const callback = async (state: string) => {
      const response = await route(new Request('https://api.example.test/v1/members/oauth/google/callback?code=synthetic&state=' + state, {
        headers: { host: 'api.example.test', cookie: '__Host-elanous_member_oauth_state=synthetic-state' },
      }));
      const setCookie = response?.headers.getSetCookie?.().find((value: string) => value.startsWith('__Host-elanous_member_session='));
      const cookie = setCookie?.split(';', 1)[0] ?? null;
      return { status: response?.status, cookie };
    };
    const profile = async (cookie: string | null) => {
      const response = await route(new Request('https://api.example.test/v1/members', {
        headers: { host: 'api.example.test', ...(cookie ? { cookie } : {}) },
      }));
      return response?.status;
    };
    const active = await callback('active-state');
    const activeProfile = await profile(active.cookie);
    const deletion = await route(new Request('https://api.example.test/v1/members', {
      method: 'DELETE', headers: { host: 'api.example.test', origin: 'https://app.example.test',
        cookie: '__Host-elanous_member_session=' + original.session.token },
    }));
    const staleProfile = await profile(active.cookie);
    const afterDeletion = await callback('post-delete-state');
    const afterProfile = await profile(afterDeletion.cookie);
    const observed = { activeCallback: active.status, activeSession: Boolean(active.cookie), activeProfile,
      deletion: deletion?.status, staleProfile, postDeletionCallback: afterDeletion.status,
      postDeletionSession: Boolean(afterDeletion.cookie), postDeletionProfile: afterProfile,
      completionCalls: completions, sameMember: store.memberForGoogleSub('returning-subject')?.id === original.id };
    expect({ activeCallback: active.status, activeSession: Boolean(active.cookie), activeProfile,
      deletion: deletion?.status, staleProfile }).toEqual({ activeCallback: 303, activeSession: true,
      activeProfile: 200, deletion: 202, staleProfile: 401 });
    expect({ postDeletionSession: Boolean(afterDeletion.cookie), postDeletionProfile: afterProfile })
      .toEqual({ postDeletionSession: false, postDeletionProfile: 401 });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
