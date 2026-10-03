// REL9b review round 2: /v1/prompt must not turn bearer possession into a human owner identity.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promptVerifiedOwner } from './meta-api.js';

const req = (auth?: string) => new Request('http://x/v1/prompt', { method: 'POST', headers: auth ? { authorization: auth } : {} });

describe('promptVerifiedOwner', () => {
  test('a matching bearer token alone yields no owner', () => {
    expect(promptVerifiedOwner(req('Bearer secret'), { bearerToken: 'secret' })).toBeUndefined();
  });
  test('only the server-side verifier grants an owner', () => {
    expect(promptVerifiedOwner(req('Bearer secret'), { bearerToken: 'secret', resolveVerifiedOwner: () => ({ id: ' owner:me ' }) })).toEqual({ id: 'owner:me' });
    expect(promptVerifiedOwner(req(), { resolveVerifiedOwner: () => ({ id: '  ' }) })).toBeUndefined();
  });
  test('both prompt routes take the owner from the verifier, never from the bearer match', () => {
    const src = readFileSync(join(import.meta.dir, 'meta-api.ts'), 'utf8');
    expect(src).not.toContain("verifiedOwner: { id: 'owner' }");
    expect(src.match(/promptVerifiedOwner\(req, opts\)/g)?.length).toBe(2);
  });
});
