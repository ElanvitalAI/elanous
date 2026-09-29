import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_REPO_REFUSAL, registerShadowCommand, type ShadowCliDeps } from './shadow-cli.js';
import type { ShadowGit } from '../self-implement/shadow-repo.js';

function realGit(): ShadowGit {
  return (args, opts) => {
    const result = spawnSync('git', args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.env ?? {}) },
      encoding: 'utf8',
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
}

async function run(argv: string[], deps: ShadowCliDeps): Promise<{ code: number; out: string[]; err: string[] }> {
  const { Command } = await import('commander');
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerShadowCommand(program, {
    ...deps,
    out: { log: (line) => out.push(line), error: (line) => err.push(line) },
    setExitCode: (next) => { code = next; },
  });
  await program.parseAsync(argv, { from: 'user' });
  return { code, out, err };
}

describe('shadow cli', () => {
  test('git 저장소 폴더의 shadow snapshot 은 한 줄 거부 · exit 2 · shadow-repos 비어 있음', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shadow-cli-git-'));
    const target = join(root, 'repo');
    const instanceRoot = join(root, 'instance');
    mkdirSync(target, { recursive: true });
    const git = realGit();
    const init = git(['init', target]);
    expect(init.status).toBe(0);
    git(['-C', target, 'config', 'user.email', 'elanous@localhost']);
    git(['-C', target, 'config', 'user.name', 'elanous']);
    writeFileSync(join(target, 'a.txt'), 'x\n');
    git(['-C', target, 'add', '-A']);
    git(['-C', target, 'commit', '-m', 'init']);

    const result = await run(['shadow', 'snapshot', target], {
      cwd: () => target,
      instanceRoot: () => instanceRoot,
      git,
    });

    expect(result.err).toEqual([GIT_REPO_REFUSAL]);
    expect(result.err.join('\n')).toContain('git 저장소입니다');
    expect(result.code).toBe(2);
    expect(existsSync(join(instanceRoot, 'shadow-repos'))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test('git 아닌 폴더는 snapshot -m 으로 그림자 커밋을 남기고 대상에 .git 을 만들지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shadow-cli-plain-'));
    const target = join(root, 'folder');
    const instanceRoot = join(root, 'instance');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'a.txt'), 'x\n');
    const git = realGit();

    const snap = await run(['shadow', 'snapshot', target, '-m', 'first'], {
      cwd: () => target,
      instanceRoot: () => instanceRoot,
      git,
    });
    expect(snap.code).toBe(0);
    expect(snap.out[0]).toMatch(/^git [0-9a-f]+ changed=/);
    expect(existsSync(join(target, '.git'))).toBe(false);

    const logged = await run(['shadow', 'log', target, '--json'], {
      cwd: () => target,
      instanceRoot: () => instanceRoot,
      git,
    });
    expect(logged.code).toBe(0);
    const rows = JSON.parse(logged.out.join('\n')) as Array<{ message: string }>;
    expect(rows[0]?.message).toBe('first');

    const repos = readdirSync(join(instanceRoot, 'shadow-repos'));
    expect(repos.length).toBe(1);

    rmSync(root, { recursive: true, force: true });
  });
});

describe('shadow cli — target guard', () => {
  test('a missing folder (e.g. restore arguments swapped) is refused before any shadow repository is created', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shadow-cli-missing-'));
    const instanceRoot = join(root, 'instance');
    try {
      const commit = 'bd5c59a4705eea3548d172568c6986297e5c627d';
      const result = await run(['shadow', 'restore', join(root, 'folder'), join(root, commit)], {
        git: realGit(), instanceRoot: () => instanceRoot, cwd: () => root,
      });
      expect(result.code).toBe(2);
      expect(result.err.join('\n')).toContain('폴더가 아닙니다');
      expect(result.err.join('\n')).toContain('shadow restore <커밋> [폴더]');
      expect(existsSync(join(instanceRoot, 'shadow-repos'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
