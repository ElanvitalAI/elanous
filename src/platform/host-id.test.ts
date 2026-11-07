import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setIdentityFileForTests } from '../mss/identity-store.js';
import { ensureHostId, resolveHostId } from './host-id.js';

const dir = mkdtempSync(join(tmpdir(), 'elanous-host-id-'));
const identityFile = join(dir, 'identity.json');
afterEach(() => { __setIdentityFileForTests(null); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

test('missing host env uses the installed ULID and ensures inherited identity', () => {
  __setIdentityFileForTests(identityFile);
  const env: NodeJS.ProcessEnv = {};
  const id = resolveHostId(env);
  expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(JSON.parse(readFileSync(identityFile, 'utf8')).elanous_id).toBe(id);
  expect(ensureHostId(env)).toBe(id);
  expect(env.ELANOUS_HOST_ID).toBe(id);
});

test('inherited nonempty host ID wins and is not overwritten', () => {
  const env: NodeJS.ProcessEnv = { ELANOUS_HOST_ID: '01HOSTTEST' };
  expect(resolveHostId(env)).toBe('01HOSTTEST');
  expect(ensureHostId(env)).toBe('01HOSTTEST');
  expect(env.ELANOUS_HOST_ID).toBe('01HOSTTEST');
});
