import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const githubUrl = 'https://github.com/ElanvitalAI/elanous';
const mirrorUrl = 'git://ref-mirror.elanous-test.svc.cluster.local:9418/elanous-agent.git';
const manifest = parse(readFileSync(resolve(import.meta.dir, '../docker/harness/job.yaml'), 'utf8'));
const jobScript: string = manifest.spec.template.spec.containers.find((container: { name: string }) => container.name === 'harness').args[0];
const extractedCloneScript = jobScript.match(/^GITHUB_REPO=.*\n[\s\S]*?(?=echo "\[L2b\] harness start)/m)?.[0];
if (!extractedCloneScript) throw new Error('Job clone command not found');
const cloneScript: string = extractedCloneScript;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(mode: 'mirror' | 'missing' | 'broken') {
  const root = mkdtempSync(join(tmpdir(), 'harness-job-clone-'));
  roots.push(root);
  const upstream = join(root, 'upstream.git');
  const mirror = join(root, 'mirror.git');
  git(root, 'init', '--quiet', '--bare', upstream);
  mkdirSync(join(root, 'seed'));
  git(join(root, 'seed'), 'init', '--quiet');
  git(join(root, 'seed'), 'config', 'user.name', 'Test');
  git(join(root, 'seed'), 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'seed', 'source.txt'), 'source from mirror\n');
  git(join(root, 'seed'), 'add', '.');
  git(join(root, 'seed'), 'commit', '-m', 'seed');
  git(join(root, 'seed'), 'remote', 'add', 'origin', upstream);
  git(join(root, 'seed'), 'push', '--quiet', 'origin', 'HEAD');
  git(root, '--git-dir', upstream, 'symbolic-ref', 'HEAD', `refs/heads/${git(join(root, 'seed'), 'branch', '--show-current')}`);
  git(root, 'clone', '--quiet', '--mirror', upstream, mirror);

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/bash
if [[ "$1" == clone ]]; then
  args=("$@")
  if [[ "${'$'}{args[4]}" == "$MIRROR_URL" ]]; then
    echo mirror >> "$CLONE_LOG"
    if [[ "$MIRROR_MODE" == broken ]]; then
      mkdir -p repo
      echo incomplete > repo/partial
      exit 1
    fi
    if [[ "$MIRROR_MODE" == missing ]]; then exit 1; fi
    args[4]="file://$MIRROR_PATH"
  elif [[ "${'$'}{args[4]}" == "$GITHUB_URL" ]]; then
    echo github >> "$CLONE_LOG"
    args[4]="file://$UPSTREAM_PATH"
    "$REAL_GIT" "${'$'}{args[@]}" || exit $?
    exec "$REAL_GIT" -C repo remote set-url origin "$GITHUB_URL"
  fi
  exec "$REAL_GIT" "${'$'}{args[@]}"
fi
exec "$REAL_GIT" "$@"
`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    REAL_GIT: execFileSync('which', ['git'], { encoding: 'utf8' }).trim(),
    MIRROR_URL: mirrorUrl,
    GITHUB_URL: githubUrl,
    MIRROR_PATH: mirror,
    UPSTREAM_PATH: upstream,
    MIRROR_MODE: mode,
    CLONE_LOG: join(root, 'clones.log'),
  };
  const result = Bun.spawnSync(['bash', '-c', cloneScript], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  expect(new TextDecoder().decode(result.stderr)).not.toContain('fatal: destination path');
  expect(result.exitCode).toBe(0);
  return { root, upstream, mirror };
}

test('mirror is preferred, is not modified, and origin points to GitHub', () => {
  const { root, upstream, mirror } = fixture('mirror');
  expect(readFileSync(join(root, 'clones.log'), 'utf8').trim()).toBe('mirror');
  expect(readFileSync(join(root, 'repo', 'source.txt'), 'utf8')).toBe('source from mirror\n');
  expect(git(join(root, 'repo'), 'remote', 'get-url', 'origin')).toBe(githubUrl);
  expect(git(root, '--git-dir', mirror, 'rev-parse', 'HEAD')).toBe(git(root, '--git-dir', upstream, 'rev-parse', 'HEAD'));
  expect(git(root, '--git-dir', mirror, 'remote', 'get-url', 'origin')).toBe(upstream);
});

test.each(['missing', 'broken'] as const)('GitHub clone fallback after %s mirror', (mode) => {
  const { root } = fixture(mode);
  expect(readFileSync(join(root, 'clones.log'), 'utf8').trim().split('\n')).toEqual(['mirror', 'github']);
  expect(readFileSync(join(root, 'repo', 'source.txt'), 'utf8')).toBe('source from mirror\n');
  expect(git(join(root, 'repo'), 'remote', 'get-url', 'origin')).toBe(githubUrl);
});
