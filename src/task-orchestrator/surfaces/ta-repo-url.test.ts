import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig } from '../../user-config.js';
import { taskAgentPodRepoOptions } from './ta-repo-url.js';
import { podJobManifest } from './self-implement-pod.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('real config parser carries the explicit private repository to the production Pod source script', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-repo-contract-')); roots.push(root);
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify({ taskAgent: { repoUrl: 'https://github.com/ElanvitalAI/elanous.git', liveMoves: ['propose-land'] } }));
  const config = buildUserConfig(path);
  const options = taskAgentPodRepoOptions(config);
  expect(options.repoUrl).toBe('https://github.com/ElanvitalAI/elanous');
  expect(config.taskAgent?.liveMoves).toEqual(['propose-land']);
  const manifest = podJobManifest({ ...options, name: 'dry-only', namespace: 'test', image: 'fixture:local', args: [], passEnv: [], deadlineSeconds: 60 });
  const text = JSON.stringify(manifest);
  expect(text).toContain('https://github.com/ElanvitalAI/elanous');
  expect(text).not.toContain('https://github.com/ElanvitalAI/elanous');
});

test('missing or malformed configuration refuses instead of falling back to a public repository', () => {
  for (const repoUrl of [undefined, '', ' ', 'not-a-url', 'http://github.com/ElanvitalAI/elanous', 'https://github.com/ElanvitalAI',
    'https://github.com/ElanvitalAI/elanous?token=fake', 'https://fake:secret@github.com/ElanvitalAI/elanous', 'https://example.test/owner/repo']) {
    expect(() => taskAgentPodRepoOptions({ taskAgent: { repoUrl } })).toThrow();
  }
  expect(() => taskAgentPodRepoOptions({})).toThrow('required');
});

test('explicit public distribution URL is rejected including case and .git forms', () => {
  for (const repoUrl of ['https://github.com/ElanvitalAI/elanous', 'https://github.com/elanvitalai/ELANOUS.git/']) {
    expect(() => taskAgentPodRepoOptions({ taskAgent: { repoUrl } })).toThrow('public distribution');
  }
});

test('CLI Pod assembly passes validated repository options and validates before pool work', () => {
  const source = readFileSync(join(import.meta.dir, '../../index.ts'), 'utf8');
  expect(source).toContain('const podBase = { ...repoOptions, hostSupervised:');
  const block = source.slice(source.indexOf("      if (substrate === 'pod') {"));
  expect(block.indexOf('taskAgentPodRepoOptions(getUserConfig())')).toBeLessThan(block.indexOf("import('./task-orchestrator/surfaces/pod-pool.js')"));
});
