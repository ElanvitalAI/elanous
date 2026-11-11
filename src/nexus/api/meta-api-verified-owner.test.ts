// REL9b review round 2: /v1/prompt must not turn bearer possession into a human owner identity.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promptVerifiedAppDeploymentOwner, promptVerifiedOwner } from './meta-api.js';

const req = (auth?: string) => new Request('http://x/v1/prompt', { method: 'POST', headers: auth ? { authorization: auth } : {} });

describe('promptVerifiedOwner', () => {
  test('a matching bearer token alone yields no owner', () => {
    expect(promptVerifiedOwner(req('Bearer secret'), { bearerToken: 'secret' })).toBeUndefined();
  });
  test('only the server-side verifier grants an owner', () => {
    expect(promptVerifiedOwner(req('Bearer secret'), { bearerToken: 'secret', resolveVerifiedOwner: () => ({ id: ' owner:me ' }) })).toEqual({ id: 'owner:me' });
    expect(promptVerifiedOwner(req(), { resolveVerifiedOwner: () => ({ id: '  ' }) })).toBeUndefined();
  });
  test('deployment owner is resolved for the server-selected app, with complete member-plan receipt', () => {
    const resolveVerifiedOwner = (_request: Request, appSlug = '') => ({
      id: 'member-1', appSlug, memberId: 'member-1', userSlug: 'alice', plan: 'free', entitlements: {},
    });
    const owner = promptVerifiedAppDeploymentOwner(req(), { resolveVerifiedOwner });
    expect(owner?.appSlug).toBe('lecture-scrap');
    expect(owner).toMatchObject({ id: 'member-1', memberId: 'member-1', userSlug: 'alice', plan: 'free', entitlements: {} });
    expect(promptVerifiedAppDeploymentOwner(req(), { resolveVerifiedOwner: (_request, appSlug) => ({
      id: 'member-1', appSlug: `${appSlug}-spoofed`, memberId: 'member-1', userSlug: 'alice', plan: 'free', entitlements: {},
    }) })).toBeUndefined();
  });
  test('both prompt routes take the owner from the verifier, never from the bearer match', () => {
    const src = readFileSync(join(import.meta.dir, 'meta-api.ts'), 'utf8');
    expect(src).not.toContain("verifiedOwner: { id: 'owner' }");
    expect(src.match(/promptVerifiedOwner\(req, opts\)/g)?.length).toBe(2);
  });
});
