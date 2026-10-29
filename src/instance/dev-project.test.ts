import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveDevProject, type DevProjectDeps } from './dev-project.js';
import { createProject } from '../project/project-store.js';
import { HARNESS_BOUNDARY_RESPONSES_ENV } from '../harness/harness-space.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

const temporaryRoots: string[] = [];

function makeTempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'dev-project-'));
  temporaryRoots.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('resolveDevProject', () => {
  test('maps clones/worktrees with the same first commit and normalized origin to one project', () => {
    const base = makeTempRoot();
    const firstRoot = join(base, 'clone');
    const secondRoot = join(base, 'worktree');
    const commonState = join(base, 'state');
    const firstRootResolved = resolve(firstRoot);
    const secondRootResolved = resolve(secondRoot);
    const git: NonNullable<DevProjectDeps['git']> = (dir, args) => {
      const root = dir === firstRootResolved ? firstRootResolved : secondRootResolved;
      if (args[0] === 'rev-parse') return `${root}\n`;
      if (args[0] === 'rev-list') return '0123456789abcdef\n';
      if (args[0] === 'remote') return dir === firstRootResolved ? 'git@github.com:Org/Repo.git\n' : 'https://github.com/Org/Repo.git\n';
      return null;
    };

    const first = resolveDevProject(firstRoot, { git, stateDir: commonState });
    const second = resolveDevProject(secondRoot, { git, stateDir: commonState });

    expect(first).toMatch(/^prj-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second).toBe(first);
  });

  test('uses the oldest root commit when git reports multiple root commits', () => {
    const base = makeTempRoot();
    const root = join(base, 'repository');
    const stateDir = join(base, 'state');
    const git: NonNullable<DevProjectDeps['git']> = (_dir, args) => {
      if (args[0] === 'rev-parse') return `${resolve(root)}\n`;
      if (args[0] === 'rev-list') return 'newer-root older-root\n';
      if (args[0] === 'show') return args[args.length - 1] === 'older-root' ? '100\n' : '200\n';
      if (args[0] === 'remote') return 'https://example.com/team/repository.git\n';
      return null;
    };

    const id = resolveDevProject(root, { git, stateDir });
    const registry = JSON.parse(readFileSync(join(stateDir, 'dev-projects.json'), 'utf8')) as { projects: Record<string, string> };

    expect(registry.projects['git:older-root:example.com/team/repository']).toBe(id);
  });

  test('reconstructs the same project from the identity registry after its cache is deleted', () => {
    const base = makeTempRoot();
    const root = join(base, 'repository');
    const stateDir = join(base, 'state');
    const git: NonNullable<DevProjectDeps['git']> = (_dir, args) => {
      if (args[0] === 'rev-parse') return `${resolve(root)}\n`;
      if (args[0] === 'rev-list') return 'fedcba9876543210\n';
      if (args[0] === 'remote') return 'https://example.com/team/repository.git\n';
      return null;
    };
    const deps = { git, stateDir };

    const original = resolveDevProject(root, deps);
    const cache = join(root, '.elanous', 'project.json');
    expect(existsSync(cache)).toBe(true);
    const cached = JSON.parse(readFileSync(cache, 'utf8')) as { identityKey: string; devProject: string };
    rmSync(cache);

    expect(resolveDevProject(root, deps)).toBe(original);
    expect(JSON.parse(readFileSync(join(stateDir, 'dev-projects.json'), 'utf8')).projects[cached.identityKey]).toBe(original);
  });

  test('uses the resolved directory SHA-256 identity when git is unavailable', () => {
    const base = makeTempRoot();
    const firstDir = join(base, 'plain-folder');
    const otherDir = join(base, 'another-folder');
    const stateDir = join(base, 'state');
    const git: NonNullable<DevProjectDeps['git']> = () => null;
    const first = resolveDevProject(firstDir, { git, stateDir });

    expect(resolveDevProject(firstDir, { git, stateDir })).toBe(first);
    expect(resolveDevProject(otherDir, { git, stateDir })).not.toBe(first);
    const registry = JSON.parse(readFileSync(join(stateDir, 'dev-projects.json'), 'utf8')) as { projects: Record<string, string> };
    const expectedKey = `path:${createHash('sha256').update(resolve(firstDir)).digest('hex')}`;
    expect(registry.projects[expectedKey]).toBe(first);
  });

  test('encodes the creation time most-significant-first so prj- ids sort by first sighting', () => {
    const base = makeTempRoot();
    const stateDir = join(base, 'state');
    const git: NonNullable<DevProjectDeps['git']> = () => null;
    try {
      setSystemTime(new Date(1));
      const early = resolveDevProject(join(base, 'early'), { git, stateDir });
      setSystemTime(new Date(32));
      const later = resolveDevProject(join(base, 'later'), { git, stateDir });
      expect(early.slice(4, 14)).toBe('0000000001');
      expect(later.slice(4, 14)).toBe('0000000010');
      expect(early < later).toBe(true);
    } finally {
      setSystemTime();
    }
  });

  test('a git repo with no commit yet falls back to the path identity instead of throwing', () => {
    const base = makeTempRoot();
    const root = join(base, 'fresh');
    const stateDir = join(base, 'state');
    const git: NonNullable<DevProjectDeps['git']> = (_dir, args) => (args[0] === 'rev-parse' ? `${resolve(root)}\n` : null);
    const id = resolveDevProject(root, { git, stateDir });
    const registry = JSON.parse(readFileSync(join(stateDir, 'dev-projects.json'), 'utf8')) as { projects: Record<string, string> };
    expect(registry.projects[`path:${createHash('sha256').update(resolve(root)).digest('hex')}`]).toBe(id);
  });

  test('scp remote host case does not split the identity (GitHub.COM == github.com)', () => {
    const base = makeTempRoot();
    const a = resolve(join(base, 'a'));
    const b = resolve(join(base, 'b'));
    const stateDir = join(base, 'state');
    const git: NonNullable<DevProjectDeps['git']> = (dir, args) => {
      if (args[0] === 'rev-parse') return `${dir}\n`;
      if (args[0] === 'rev-list') return 'abc\n';
      if (args[0] === 'remote') return dir === a ? 'git@GitHub.COM:Org/Repo.git\n' : 'https://github.com/Org/Repo\n';
      return null;
    };
    expect(resolveDevProject(a, { git, stateDir })).toBe(resolveDevProject(b, { git, stateDir }));
  });

  test('a corrupt registry throws instead of silently re-issuing ids; an unwritable cache does not', () => {
    const base = makeTempRoot();
    const stateDir = join(base, 'state');
    const git: NonNullable<DevProjectDeps['git']> = () => null;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'dev-projects.json'), '{not json');
    expect(() => resolveDevProject(join(base, 'x'), { git, stateDir })).toThrow(/corrupt/);

    rmSync(join(stateDir, 'dev-projects.json'));
    const readOnlyRoot = join(base, 'ro');
    mkdirSync(readOnlyRoot, { recursive: true });
    chmodSync(readOnlyRoot, 0o500);
    try {
      expect(resolveDevProject(readOnlyRoot, { git, stateDir })).toMatch(/^prj-/);
    } finally {
      chmodSync(readOnlyRoot, 0o700);
    }
  });

  test('TENANT-BOUNDARY: 경계 채널이 열리면 resolveDevProject 는 익명 내보내기만 회신 mailbox 에 남긴다', () => {
    const base = makeTempRoot();
    const root = join(base, 'repository');
    const stateDir = join(base, 'state');
    const configRoot = join(base, 'config');
    const responses = join(base, 'boundary', 'responses.jsonl');
    setElanousConfigDir(configRoot);
    try {
      const git: NonNullable<DevProjectDeps['git']> = (_dir, args) => {
        if (args[0] === 'rev-parse') return `${resolve(root)}\n`;
        if (args[0] === 'rev-list') return '0123456789abcdef\n';
        if (args[0] === 'remote') return 'https://github.com/Acme/SecretRepo.git\n';
        return null;
      };
      const created = createProject({ name: 'Acme Secret', primaryFolder: resolve(root) });
      const id = resolveDevProject(root, { git, stateDir, env: { [HARNESS_BOUNDARY_RESPONSES_ENV]: responses } });
      const lines = readFileSync(responses, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      expect(lines).toHaveLength(1);
      const payload = lines[0];
      expect(payload.devProject).toBe(id);
      expect(payload.project.id).toBe(created.id);
      expect(payload.project.name).toMatch(/^project-[0-9a-f]{16}$/);
      expect(payload.project.primaryFolder).toMatch(/^folder-[0-9a-f]{16}$/);
      expect(JSON.stringify(payload)).not.toContain('Acme Secret');
      expect(JSON.stringify(payload)).not.toContain('SecretRepo');
      expect(JSON.stringify(payload)).not.toContain(resolve(root));

      // 경계 채널이 없으면 아무 파일도 생기지 않는다(fail-open · 기본 동작 보존)
      resolveDevProject(join(base, 'other'), { git, stateDir });
      expect(existsSync(join(base, 'boundary-quiet'))).toBe(false);
    } finally {
      resetElanousConfigDir();
    }
  });
});
