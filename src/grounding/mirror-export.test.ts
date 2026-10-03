import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportMirrorManifest } from './mirror-export.js';
import type { GroundingSource } from './sources.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const REPO = join(import.meta.dir, '../..');
const DEPLOY = join(REPO, 'docker/ref-mirror/deploy.sh');
const MANIFEST = join(REPO, 'docker/ref-mirror/ref-mirror.yaml');

function git(repo: string, args: string[]): void {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function initRepo(root: string, name: string, origin?: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README'), `${name}\n`);
  git(dir, ['add', 'README']);
  git(dir, ['commit', '-m', 'init']);
  if (origin) git(dir, ['remote', 'add', 'origin', origin]);
  return dir;
}

function source(id: string, path: string, mirror?: boolean): GroundingSource {
  return {
    id,
    kind: 'local-repo',
    path,
    sync: 'manual',
    ...(mirror ? { mirror: true } : {}),
  };
}

describe('exportMirrorManifest — registry to mirror list', () => {
  test('decision signal: real git origin, local-only opt-in, credential URL refused', () => {
    const home = mkdtempSync(join(tmpdir(), 'mirror-export-'));
    try {
      const hono = initRepo(home, 'hono', 'https://github.com/honojs/hono');
      const bare = initRepo(home, 'bare');
      const cred = initRepo(home, 'cred', 'https://user:tok@github.com/a/b');
      const docs = join(home, 'docs');
      mkdirSync(docs);
      const exported = exportMirrorManifest([
        source('hono', hono),
        source('bare', bare),
        source('cred', cred),
        { id: 'notes', kind: 'local-docs', path: docs, sync: 'manual' },
      ]);
      expect(exported.list).toBe('hono https://github.com/honojs/hono');
      expect(exported.refused.find((row) => row.id === 'bare')?.reason).toBe('local-only-not-opted-in');
      expect(exported.refused.find((row) => row.id === 'cred')?.reason).toBe('credential-url');
      expect(exported.refused.find((row) => row.id === 'notes')).toBeUndefined();
      expect(exported.accepted.map((row) => row.id)).toEqual(['hono']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a local-only repo is listed only when the source sets mirror: true', () => {
    const home = mkdtempSync(join(tmpdir(), 'mirror-export-opt-'));
    try {
      const opted = initRepo(home, 'opted');
      const skipped = initRepo(home, 'skipped');
      const exported = exportMirrorManifest([
        source('opted', opted, true),
        source('skipped', skipped),
      ]);
      expect(exported.list).toBe('opted local');
      expect(exported.accepted).toEqual([{ id: 'opted', localOnly: true }]);
      expect(exported.refused).toEqual([{ id: 'skipped', reason: 'local-only-not-opted-in' }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('kinds other than local-repo are not exported', () => {
    const exported = exportMirrorManifest([
      { id: 'web', kind: 'web', url: 'https://example.com', sync: 'manual' },
      { id: 'docs', kind: 'local-docs', path: '/tmp/docs', sync: 'manual', mirror: true },
    ]);
    expect(exported.list).toBe('');
    expect(exported.accepted).toEqual([]);
    expect(exported.refused).toEqual([]);
  });
});

describe('docker/ref-mirror/deploy.sh — dry-run records kubectl', () => {
  test('decision signal: fake kubectl sees --dry-run=client and ref-mirror.yaml, last line ok', () => {
    const root = mkdtempSync(join(tmpdir(), 'mirror-deploy-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'kubectl.log');
    const kubectl = join(bin, 'kubectl');
    writeFileSync(kubectl, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = "create" ]; then
  printf '%s\\n' 'apiVersion: v1' 'kind: ConfigMap'
fi
exit 0
`);
    chmodSync(kubectl, 0o755);
    const list = join(root, 'mirrors.txt');
    writeFileSync(list, 'hono https://github.com/honojs/hono\n# comment\n\n');
    try {
      const result = spawnSync('sh', [DEPLOY, list, '--context', 'node-b', '--dry-run'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      expect(result.status).toBe(0);
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      expect(calls.some((line) => line.includes('--dry-run=client') && line.includes('create') && line.includes('configmap'))).toBe(true);
      expect(calls.some((line) => line.includes('--dry-run=client') && line.includes('apply') && line.includes(MANIFEST))).toBe(true);
      expect(calls.some((line) => line.includes('rollout'))).toBe(false);
      const last = (result.stdout.trim().split('\n').at(-1) ?? '');
      expect(JSON.parse(last)).toEqual({ ok: true, context: 'node-b', entries: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('grounding sources export --mirror-manifest', () => {
  const entry = resolve(import.meta.dir, '../../bin/elanous.mjs');

  function run(args: string[], configDir: string, home: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync('bun', [entry, '--config-dir', configDir, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, HOME: home },
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  test('--discover adds candidates without replacing a registered source of the same id', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mirror-export-cli-cfg-'));
    const home = mkdtempSync(join(tmpdir(), 'mirror-export-cli-home-'));
    try {
      const registeredPath = initRepo(home, 'registered-repo', 'https://github.com/elanous/registered');
      mkdirSync(join(home, 'source', 'ref'), { recursive: true });
      const discoveredPath = initRepo(join(home, 'source/ref'), 'discovered', 'https://github.com/elanous/discovered');
      const sameIdPath = initRepo(join(home, 'source/ref'), 'registered-repo');
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        grounding: {
          sources: [
            { id: 'registered-repo', kind: 'local-repo', path: registeredPath, sync: 'manual' },
          ],
        },
      }));
      const plain = run(['grounding', 'sources', 'export', '--mirror-manifest'], configDir, home);
      expect(plain.status).toBe(0);
      expect(plain.stderr).toContain('accepted registered-repo');
      expect(plain.stdout.trim()).toBe('registered-repo https://github.com/elanous/registered');
      expect(plain.stdout).not.toContain('discovered');

      const wide = run(['grounding', 'sources', 'export', '--mirror-manifest', '--discover', '--json', '--home', home], configDir, home);
      expect(wide.status).toBe(0);
      const body = JSON.parse(wide.stdout) as {
        accepted: Array<{ id: string; upstream?: string }>;
        refused: Array<{ id: string; reason: string }>;
      };
      const registered = body.accepted.find((row) => row.id === 'registered-repo');
      expect(registered?.upstream).toBe('https://github.com/elanous/registered');
      expect(body.accepted.find((row) => row.id === 'discovered')?.upstream).toBe('https://github.com/elanous/discovered');
      expect(body.accepted.filter((row) => row.id === 'registered-repo')).toHaveLength(1);
      expect(body.refused.find((row) => row.id === 'registered-repo')).toBeUndefined();
      expect(sameIdPath).toContain('registered-repo');
      expect(wide.stderr.length).toBeGreaterThan(0);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('mirror id lowercase (2026-09-27 실배치)', () => {
  test('대문자 디렉터리 이름은 소문자 id 로 싣고, 소문자로 겹치면 둘 다 거부한다', () => {
    const result = exportMirrorManifest([
      { id: 'AppCUI-rs', kind: 'local-repo', path: '/x/AppCUI-rs', sync: 'manual' },
      { id: 'crewAI', kind: 'local-repo', path: '/x/crewAI', sync: 'manual' },
      { id: 'CrewAI', kind: 'local-repo', path: '/x/CrewAI', sync: 'manual' },
    ] as never, { readOrigin: (path) => `https://github.com/o/${path.split('/').pop()}` });
    expect(result.list.trim().split('\n')).toEqual(['appcui-rs https://github.com/o/AppCUI-rs']);
    expect(result.refused.map((r) => `${r.id}:${r.reason}`).sort()).toEqual([
      'CrewAI:id-collision-after-lowercase',
      'crewAI:id-collision-after-lowercase',
    ]);
  });
});

