import { expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from '../nexus/members/member-store.js';
import { issueToPrivateFile } from './member-key-token-cli.js';

test('key rotation commits only after durable private-file delivery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-key-cli-'));
  const store = createMemberStore({ path: ':memory:' });
  try {
    const member = store.register({ sub: 'cli-test', email: 'cli@example.test', emailVerified: true, name: 'CLI' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    const old = member.initialKey!;
    const failedPath = join(dir, 'failed.key');
    expect(() => issueToPrivateFile(failedPath,
      deliver => store.rotateMemberKey(member.id, old.id, undefined, deliver),
      () => { throw new Error('directory sync failed'); })).toThrow('directory sync failed');
    expect(existsSync(failedPath)).toBe(false);
    expect(store.memberForKey(old.key)).toMatchObject({ keyId: old.id });
    const path = join(dir, 'rotated.key');
    const issued = issueToPrivateFile(path, deliver => store.rotateMemberKey(member.id, old.id, undefined, deliver));
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8').trim()).toBe(issued.key);
    expect(store.memberForKey(old.key)).toBeNull();
    expect(store.memberForKey(issued.key)).toMatchObject({ keyId: issued.id });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
