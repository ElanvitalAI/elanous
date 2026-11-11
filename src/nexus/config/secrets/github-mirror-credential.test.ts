import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../../elanous-config-dir.js';
import { getSecretAsync, readGithubMirrorCredentialAsync, registerGithubMirrorCredentialAsync,
  revokeGithubMirrorCredentialAsync, useBackend } from './index.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'github-mirror-credential-')); setElanousConfigDir(root); useBackend('file'); });
afterEach(() => { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); });

test('a GitHub mirror token is stored through the app secret ledger and bound to one repository', async () => {
  const token = 'github_pat_fixture_token_1234567890';
  await registerGithubMirrorCredentialAsync('notes', { repository: 'Owner/Notes', token });
  expect(await readGithubMirrorCredentialAsync('notes')).toEqual({ repository: 'owner/notes', token });
  expect(await getSecretAsync('app/notes/GITHUB_MIRROR_TOKEN')).toContain('owner/notes');
  await expect(registerGithubMirrorCredentialAsync('notes', { repository: 'owner/other', token }))
    .rejects.toThrow('app secret already exists');
  expect(await readGithubMirrorCredentialAsync('other')).toBeUndefined();
  expect(await revokeGithubMirrorCredentialAsync('notes')).toBe(true);
  expect(await readGithubMirrorCredentialAsync('notes')).toBeUndefined();
});

test('repository and app identity validation happens before storing a token', async () => {
  for (const repository of ['owner/repo/extra', 'https://github.com/owner/repo', '../repo', 'owner/.']) {
    await expect(registerGithubMirrorCredentialAsync('notes', { repository, token: 'fixture-token' }))
      .rejects.toThrow('ELANOUS_GITHUB_MIRROR_REPOSITORY_INVALID');
  }
  await expect(registerGithubMirrorCredentialAsync('../escape', { repository: 'owner/repo', token: 'fixture-token' }))
    .rejects.toThrow('invalid app slug');
  expect(await readGithubMirrorCredentialAsync('notes')).toBeUndefined();
});
