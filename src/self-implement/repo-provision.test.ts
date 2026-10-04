import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { SENSITIVE_GLOBS } from '../boot/daemon-tools/path-guard.js';
import { ELANOUS_RUNTIME_ARTIFACT_DIRS, ELANOUS_RUNTIME_ARTIFACT_PATHS } from './gate-scope.js';

// ⛔ 기대치를 «수로» 박지 않는다 — 관리 항목이 하나 늘 때마다 깨지고,
//    그때 깨지는 것은 결함이 아니라 «정상적인 증가»다.
//    📏 2026-09-21: 종전엔 관리 항목 수를 민감 글로브 수에 «둘»을 더해 박아 둌고,
//       그 박힌 수가 「판별 함수가 아는 다섯 중 둘만 쓴다」는 사실을 «계약으로» 굳히고 있었다.
const MANAGED_ELANOUS_ENTRIES = ['.elanous/', '.elanous-test/', ...ELANOUS_RUNTIME_ARTIFACT_DIRS, ...ELANOUS_RUNTIME_ARTIFACT_PATHS]
  .filter((entry, index, all) => all.indexOf(entry) === index);
const DEFAULT_PROJECT_ENTRIES = ['node_modules/', '.env*', 'dist/', '.DS_Store'];
const MANAGED_ENTRY_COUNT = new Set([...SENSITIVE_GLOBS, ...DEFAULT_PROJECT_ENTRIES, ...MANAGED_ELANOUS_ENTRIES]).size;
import { resolveHarnessTarget, type HarnessTargetResolution } from './harness-target-options.js';
import { makeRepositoryPublic, preflightRepositoryPublish, preflightRepositoryVisibility, provisionRepository, publishRepository } from './repo-provision.js';
import { runDevPipeline, type DevPipelineSpec } from '../self-dev/dev-pipeline.js';
import { buildDevCliSpec } from '../self-dev/dev-cli.js';
import type { SelfImplementSeams } from './orchestrator.js';
import { runRepositoryPublic, runRepositoryPublish } from '../cli/repo-cli.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const directories: string[] = [];
const createHomeDirectory = (prefix: string) => {
  const home = resolveHarnessTarget(tmpdir()).canonicalHome;
  if (!home) throw new Error('expected resolved target home');
  const directory = mkdtempSync(join(home, prefix));
  directories.push(directory);
  return directory;
};
const createDirectory = (prefix = 'repo-provision-') => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};
const gitTestEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  return env;
};
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: gitTestEnv(), encoding: 'utf8' }).trim();
const resolution = (target: string) => resolveHarnessTarget(target, { home: tmpdir() });
const availableRepositoryGh = (args: string[], ok: { ok: boolean; exitCode: number; stdout: Buffer; stderr: Buffer; maybeTruncated: boolean }) => {
  if (args[0] !== 'api') return ok;
  if (args[1] === 'user') return { ...ok, stdout: Buffer.from('elanous-test\n') };
  return { ...ok, ok: false, exitCode: 1, stderr: Buffer.from('HTTP 404 Not Found') };
};

interface TreeEntrySnapshot {
  type: 'directory' | 'file' | 'symlink' | 'other';
  mode: number;
  mtimeNs?: string;
  nlink: number;
  inode?: string;
  contents?: string;
  target?: string;
}

function treeSnapshot(
  path: string,
  includeFileMtime = false,
  prefix = '',
  inodeGroups = new Map<string, string>(),
): Record<string, TreeEntrySnapshot> {
  const entries: Record<string, TreeEntrySnapshot> = {};
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    const absolute = join(path, entry.name);
    const stats = lstatSync(absolute);
    if (stats.isDirectory()) {
      entries[relative] = { type: 'directory', mode: stats.mode, nlink: stats.nlink };
      Object.assign(entries, treeSnapshot(absolute, includeFileMtime, `${relative}/`, inodeGroups));
    } else if (stats.isSymbolicLink()) {
      entries[relative] = { type: 'symlink', mode: stats.mode, nlink: stats.nlink, target: readlinkSync(absolute) };
    } else if (stats.isFile()) {
      const inode = `${stats.dev}:${stats.ino}`;
      const group = inodeGroups.get(inode) ?? `file-${inodeGroups.size + 1}`;
      inodeGroups.set(inode, group);
      entries[relative] = {
        type: 'file', mode: stats.mode, ...(includeFileMtime ? { mtimeNs: String(stats.mtimeMs) } : {}), nlink: stats.nlink, inode: group,
        contents: readFileSync(absolute).toString('base64'),
      };
    } else {
      entries[relative] = { type: 'other', mode: stats.mode, nlink: stats.nlink };
    }
  }
  return entries;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('provisionRepository', () => {
  test('creates .gitignore before the initial commit and excludes default project artifacts', async () => {
    const { debug } = await import('../debug/log.js');
    const ignoreSteps: Record<string, unknown>[] = [];
    const off = debug.registerSink({
      name: 'repo-provision-new-ignore-capture',
      emit: (record) => {
        const data = record.data as Record<string, unknown> | undefined;
        if (record.category === 'repo-provision' && record.event === 'step' && data?.step === 'ignore') ignoreSteps.push(data);
      },
    });
    try {
      const directory = createDirectory();
      writeFileSync(join(directory, 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(directory, '.env.local'), 'secret\n');
      writeFileSync(join(directory, '.DS_Store'), 'metadata');
      mkdirSync(join(directory, 'node_modules'));
      writeFileSync(join(directory, 'node_modules', 'dependency.js'), 'dependency');
      mkdirSync(join(directory, 'dist'));
      writeFileSync(join(directory, 'dist', 'a.js'), 'compiled');

      const result = provisionRepository(resolution(directory));
      expect(result).toMatchObject({ status: 'provisioned', ignoreFile: { created: true, preserved: 0 } });
      expect(readFileSync(join(directory, '.gitignore'), 'utf8').split(/\r?\n/)).toEqual(expect.arrayContaining(DEFAULT_PROJECT_ENTRIES));
      expect(git(directory, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n')).toEqual(['.gitignore', 'a.ts']);
      expect(Number(git(directory, ['rev-list', '--count', 'HEAD']))).toBe(1);
      expect(ignoreSteps).toEqual([expect.objectContaining({ ok: true, created: true })]);
    } finally {
      off();
    }
  });

  test('preserves an existing .gitignore and reports it was not created', () => {
    const directory = createDirectory();
    writeFileSync(join(directory, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(directory, '.gitignore'), 'custom/\n');
    expect(provisionRepository(resolution(directory))).toMatchObject({
      status: 'provisioned', ignoreFile: { created: false, preserved: 1 },
    });
    expect(readFileSync(join(directory, '.gitignore'), 'utf8')).toContain('custom/\n');
    expect(git(directory, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n')).toEqual(['.gitignore', 'a.ts']);
  });

  test('promotes a non-git directory with an initial commit and ignores sensitive plus elanous work and test files', () => {
    const directory = createDirectory();
    writeFileSync(join(directory, 'app.ts'), 'export const app = true;\n');
    writeFileSync(join(directory, '.env'), 'secret');
    writeFileSync(join(directory, '.elanous-log'), 'not ignored');
    const elanousDir = join(directory, '.elanous');
    mkdirSync(elanousDir);
    writeFileSync(join(elanousDir, 'debug.log'), 'internal');

    const result = provisionRepository(resolution(directory));

    expect(result.status).toBe('provisioned');
    expect(git(directory, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
    expect(Number(git(directory, ['rev-list', '--count', 'HEAD']))).toBe(1);
    expect(git(directory, ['show', '--format=', '--name-only', 'HEAD']).split('\n')).toEqual(expect.arrayContaining(['app.ts', '.gitignore']));
    expect(git(directory, ['show', '--format=', '--name-only', 'HEAD'])).not.toContain('.env');
    expect(git(directory, ['show', '--format=', '--name-only', 'HEAD'])).not.toContain('.elanous/debug.log');
    const ignored = readFileSync(join(directory, '.gitignore'), 'utf8').split('\n');
    expect(ignored).toEqual(expect.arrayContaining([...SENSITIVE_GLOBS, ...MANAGED_ELANOUS_ENTRIES]));
  });

  test('creates an allow-empty root commit and a second call creates no commit', () => {
    const directory = createDirectory();
    expect(provisionRepository(resolution(directory))).toMatchObject({
      status: 'provisioned',
      ignoreFile: { added: MANAGED_ENTRY_COUNT, preserved: 0 },
    });
    expect(Number(git(directory, ['rev-list', '--count', 'HEAD']))).toBe(1);
    expect(provisionRepository(resolution(directory)).status).toBe('already-git');
    expect(Number(git(directory, ['rev-list', '--count', 'HEAD']))).toBe(1);
  });

  test('updates an existing repository ignore file without changing its commit and observes additions', async () => {
    const { debug } = await import('../debug/log.js');
    const steps: Record<string, unknown>[] = [];
    const off = debug.registerSink({
      name: 'repo-provision-existing-git-capture',
      emit: (record) => {
        const data = record.data as Record<string, unknown> | undefined;
        if (record.category === 'repo-provision' && record.event === 'step' && data?.step === 'ignore') {
          steps.push(data);
        }
      },
    });
    try {
      const directory = createDirectory();
      git(directory, ['init']);
      git(directory, ['config', 'user.email', 'test@example.invalid']);
      git(directory, ['config', 'user.name', 'test']);
      writeFileSync(join(directory, 'existing.txt'), 'existing');
      writeFileSync(join(directory, '.gitignore'), 'human-rule/\n');
      git(directory, ['add', 'existing.txt', '.gitignore']);
      git(directory, ['commit', '-m', 'existing']);
      const before = git(directory, ['rev-parse', 'HEAD']);

      expect(provisionRepository(resolution(directory))).toMatchObject({
        status: 'already-git',
        ignoreFile: { added: MANAGED_ENTRY_COUNT, preserved: 1 },
      });
      expect(git(directory, ['rev-parse', 'HEAD'])).toBe(before);
      const ignored = readFileSync(join(directory, '.gitignore'), 'utf8').split('\n');
      expect(ignored).toEqual(expect.arrayContaining(['human-rule/', ...SENSITIVE_GLOBS, ...MANAGED_ELANOUS_ENTRIES]));
      expect(steps.at(0)).toMatchObject({ ok: true, added: MANAGED_ENTRY_COUNT, preserved: 1 });
      expect(provisionRepository(resolution(directory))).toMatchObject({
        status: 'already-git',
        ignoreFile: { added: 0, preserved: 1 },
      });
      const ignoredOnRetry = readFileSync(join(directory, '.gitignore'), 'utf8').split('\n');
      expect(ignoredOnRetry.filter((line) => line === '.elanous/')).toHaveLength(1);
      expect(ignoredOnRetry.filter((line) => line === '.elanous-test/')).toHaveLength(1);
      expect(steps.at(1)).toMatchObject({ ok: true, added: 0, preserved: 1 });
    } finally {
      off();
    }
  });

  test('refuses a symbolic-link .gitignore without changing its outside target', () => {
    const directory = createDirectory();
    const outside = createDirectory('repo-provision-outside-');
    const outsideIgnore = join(outside, 'outside-ignore');
    writeFileSync(outsideIgnore, 'outside\n');
    symlinkSync(outsideIgnore, join(directory, '.gitignore'));

    expect(() => provisionRepository(resolution(directory))).toThrow('non-regular .gitignore');
    expect(readFileSync(outsideIgnore, 'utf8')).toBe('outside\n');
    expect(existsSync(join(directory, '.git'))).toBe(false);
  });

  test('replaces a hard-linked .gitignore without changing its outside inode', () => {
    const directory = createDirectory();
    const outside = createDirectory('repo-provision-outside-');
    const outsideIgnore = join(outside, 'outside-ignore');
    writeFileSync(outsideIgnore, 'outside\n');
    linkSync(outsideIgnore, join(directory, '.gitignore'));

    expect(provisionRepository(resolution(directory))).toMatchObject({ status: 'provisioned' });
    expect(readFileSync(outsideIgnore, 'utf8')).toBe('outside\n');
    expect(readFileSync(join(directory, '.gitignore'), 'utf8')).toContain('.elanous/');
  });

  test('rolls back a hard-linked .gitignore by restoring its complete original structure', () => {
    const directory = createDirectory();
    const outside = createDirectory('repo-provision-outside-');
    const outsideIgnore = join(outside, 'outside-ignore');
    writeFileSync(outsideIgnore, 'outside\n');
    linkSync(outsideIgnore, join(directory, '.gitignore'));
    const beforeTarget = treeSnapshot(directory, true);
    const beforeOutside = treeSnapshot(outside, true);

    expect(() => provisionRepository(resolution(directory), {
      runGit: (_cwd, args) => args[0] === 'commit'
        ? { status: 1, stdout: '', stderr: 'commit rejected' }
        : { status: 0, stdout: '', stderr: '' },
    })).toThrow('commit rejected');
    expect(treeSnapshot(directory, true)).toEqual(beforeTarget);
    expect(treeSnapshot(outside, true)).toEqual(beforeOutside);
    expect(lstatSync(join(directory, '.gitignore')).ino).toBe(lstatSync(outsideIgnore).ino);
    expect(existsSync(join(directory, '.git'))).toBe(false);
  });

  test('rolls back partial Git and ignore changes after a commit failure so retry provisions a root commit', () => {
    const directory = createDirectory();
    writeFileSync(join(directory, '.gitignore'), 'existing-ignore\n');
    expect(() => provisionRepository(resolution(directory), {
      runGit: (_cwd, args) => args[0] === 'commit'
        ? { status: 1, stdout: '', stderr: 'commit rejected' }
        : { status: 0, stdout: '', stderr: '' },
    })).toThrow('commit rejected');

    expect(existsSync(join(directory, '.git'))).toBe(false);
    expect(readFileSync(join(directory, '.gitignore'), 'utf8')).toBe('existing-ignore\n');
    expect(provisionRepository(resolution(directory))).toMatchObject({ status: 'provisioned' });
    expect(Number(git(directory, ['rev-list', '--count', 'HEAD']))).toBe(1);
  });

  test('restores a pre-existing incomplete .git tree structurally after a real init then commit failure', () => {
    const directory = createDirectory();
    const gitDir = join(directory, '.git');
    mkdirSync(join(gitDir, 'nested', 'empty'), { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/unfinished\n');
    writeFileSync(join(gitDir, 'nested', 'metadata'), Buffer.from([0, 255, 4, 9]), { mode: 0o640 });
    writeFileSync(join(directory, '.gitignore'), 'preserved-ignore\n');
    const beforeGit = treeSnapshot(gitDir);
    const incompleteGitResolution: HarnessTargetResolution = {
      status: 'non-git-dir', kind: 'non-git-dir', target: directory, canonicalTarget: directory,
    };

    expect(() => provisionRepository(incompleteGitResolution, {
      runGit: (cwd, args) => {
        if (args[0] === 'commit') return { status: 1, stdout: '', stderr: 'commit rejected' };
        const result = spawnSync('git', args, { cwd, env: gitTestEnv(), encoding: 'utf8' });
        return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
      },
    })).toThrow('commit rejected');

    expect(treeSnapshot(gitDir)).toEqual(beforeGit);
    expect(readFileSync(join(directory, '.gitignore'), 'utf8')).toBe('preserved-ignore\n');
  });

  test('refuses a symbolic-link .git entry before any Git command changes its outside target', () => {
    const directory = createDirectory();
    const outside = createDirectory('repo-provision-outside-');
    const gitDir = join(directory, '.git');
    const outsideHead = join(outside, 'HEAD');
    mkdirSync(gitDir);
    writeFileSync(outsideHead, 'outside-head\n');
    symlinkSync(outsideHead, join(gitDir, 'HEAD'));
    const beforeGit = treeSnapshot(gitDir);
    let called = false;

    expect(() => provisionRepository({ status: 'non-git-dir', kind: 'non-git-dir', target: directory, canonicalTarget: directory }, {
      runGit: () => { called = true; return { status: 0, stdout: '', stderr: '' }; },
    })).toThrow('linked .git entry');
    expect(called).toBe(false);
    expect(treeSnapshot(gitDir)).toEqual(beforeGit);
    expect(readFileSync(outsideHead, 'utf8')).toBe('outside-head\n');
  });

  test('refuses a hard-linked .git file before any Git command changes its outside inode', () => {
    const directory = createDirectory();
    const outside = createDirectory('repo-provision-outside-');
    const gitDir = join(directory, '.git');
    const outsideHead = join(outside, 'HEAD');
    mkdirSync(gitDir);
    writeFileSync(outsideHead, 'outside-head\n');
    linkSync(outsideHead, join(gitDir, 'HEAD'));
    const beforeGit = treeSnapshot(gitDir);
    let called = false;

    expect(() => provisionRepository({ status: 'non-git-dir', kind: 'non-git-dir', target: directory, canonicalTarget: directory }, {
      runGit: () => { called = true; return { status: 0, stdout: '', stderr: '' }; },
    })).toThrow('hard-linked .git file');
    expect(called).toBe(false);
    expect(treeSnapshot(gitDir)).toEqual(beforeGit);
    expect(readFileSync(outsideHead, 'utf8')).toBe('outside-head\n');
  });

  test('rolls back a real init failure and allows the next invocation to provision', () => {
    const directory = createDirectory();
    expect(() => provisionRepository(resolution(directory), {
      runGit: (cwd, args) => {
        if (args[0] === 'add') return { status: 1, stdout: '', stderr: 'add rejected' };
        const result = spawnSync('git', args, { cwd, env: gitTestEnv(), encoding: 'utf8' });
        return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
      },
    })).toThrow('add rejected');
    expect(existsSync(join(directory, '.git'))).toBe(false);
    expect(existsSync(join(directory, '.gitignore'))).toBe(false);
    expect(provisionRepository(resolution(directory))).toMatchObject({ status: 'provisioned' });
  });
});

describe('runDevPipeline repository provision wiring', () => {
  const spec = (target: string): DevPipelineSpec => ({ input: { text: 'implement feature' }, target, humanReadableOutput: false });

  test('interactive consent initializes and commits only non-ignored files', async () => {
    const directory = createHomeDirectory('dev-repo-consent-');
    writeFileSync(join(directory, '.env'), 'secret');
    writeFileSync(join(directory, 'a.ts'), 'export {};');
    const prompts: string[] = [];
    await runDevPipeline(spec(directory), {
      nonGitInteractive: true,
      askNonGitInit: async (prompt) => { prompts.push(prompt); return 'y'; },
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => ({ ok: true } as never),
    });
    expect(prompts).toHaveLength(1);
    expect(readFileSync(join(directory, '.gitignore'), 'utf8')).toContain('.env*');
    expect(git(directory, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n')).toEqual(['.gitignore', 'a.ts']);
  });

  test.each([
    { answer: 'y\n', initialized: true },
    { answer: 'n\n', initialized: false },
  ])('real CLI asks on TTY stdin with piped JSON stdout ($answer)', ({ answer, initialized }) => {
    const directory = createHomeDirectory('dev-repo-json-consent-');
    writeFileSync(join(directory, '.env'), 'secret');
    writeFileSync(join(directory, 'a.ts'), 'export {};');
    // The CLI exits after the repository gate: an explicit remote-dependent completion needs a remote.
    // This keeps the real entry point under test without launching an implementation child.
    const ptyCli = `
import json, os, pty, select, subprocess, sys, time, tty
master, slave = pty.openpty()
tty.setraw(slave)
child = subprocess.Popen(['bun', 'bin/elanous.mjs', '--test', 'dev', 'implement feature', '--target', sys.argv[1], '--no-auto-merge', '--json'], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=os.getcwd(), env={**os.environ, 'NODE_ENV': 'test'})
os.close(slave)
seen = b''
try:
    deadline = time.monotonic() + 30
    while b'[y/N]' not in seen and child.poll() is None and time.monotonic() < deadline:
        if select.select([child.stderr], [], [], 0.1)[0]:
            seen += os.read(child.stderr.fileno(), 4096)
    if b'[y/N]' in seen:
        os.write(master, sys.argv[2].encode())
    out, err = child.communicate(timeout=30)
    print(json.dumps({'exitCode': child.returncode, 'stdout': out.decode(), 'stderr': (seen + err).decode()}))
finally:
    if child.poll() is None:
        child.kill()
        child.communicate()
    os.close(master)
`;
    const child = spawnSync('python3', ['-c', ptyCli, directory, answer], { cwd: process.cwd(), encoding: 'utf8', timeout: 100_000 });
    expect(child.status, `${child.stderr}\n${child.stdout}`).toBe(0);
    const observed = JSON.parse(child.stdout) as { exitCode: number; stdout: string; stderr: string };
    expect(observed.stderr).toContain(`${directory} 는 git 저장소가 아닙니다.`);
    const output = JSON.parse(observed.stdout) as { error?: string };
    expect(output.error).toContain(initialized ? 'target has no git remote' : 'git 저장소가 필요합니다');
    expect(observed.exitCode).toBe(initialized ? 1 : 2);
    expect(existsSync(join(directory, '.git'))).toBe(initialized);
    if (initialized) {
      expect(git(directory, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n')).toEqual(['.gitignore', 'a.ts']);
    }
  }, 120_000);

  test('passes the revalidated non-git resolution to provision after consent', async () => {
    const directory = createHomeDirectory('dev-repo-revalidated-');
    let given: HarnessTargetResolution | undefined;
    await runDevPipeline({ ...spec(directory), assumeYes: true }, {
      provisionRepository: (target) => { given = target; return provisionRepository(target); },
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => ({ ok: true } as never),
    });
    expect(given?.status).toBe('non-git-dir');
    expect(given?.canonicalTarget).toBe(directory);
    expect(existsSync(join(directory, '.git'))).toBe(true);
  });

  test('declined and non-interactive launches do not create .git or call provision', async () => {
    for (const interactive of [true, false]) {
      const directory = createHomeDirectory('dev-repo-refusal-');
      let asked = 0;
      let provisioned = false;
      await expect(runDevPipeline(spec(directory), {
        nonGitInteractive: interactive,
        askNonGitInit: async () => { asked++; return 'n'; },
        provisionRepository: () => { provisioned = true; throw new Error('must not provision'); },
      })).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('git 저장소가 필요합니다') });
      expect(asked).toBe(interactive ? 1 : 0);
      expect(provisioned).toBe(false);
      expect(existsSync(join(directory, '.git'))).toBe(false);
    }
  });

  test('an existing git target does not ask or change its HEAD', async () => {
    const directory = createHomeDirectory('dev-repo-existing-');
    git(directory, ['init']);
    git(directory, ['config', 'user.email', 'test@example.invalid']);
    git(directory, ['config', 'user.name', 'test']);
    writeFileSync(join(directory, 'a.ts'), 'export {};');
    git(directory, ['add', 'a.ts']);
    git(directory, ['commit', '-m', 'existing']);
    const before = git(directory, ['rev-parse', 'HEAD']);
    await runDevPipeline(spec(directory), {
      nonGitInteractive: true,
      askNonGitInit: async () => { throw new Error('must not ask an existing repository'); },
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => ({ ok: true } as never),
    });
    expect(git(directory, ['rev-parse', 'HEAD'])).toBe(before);
  });

  test('--yes flows through the CLI spec into a non-interactive target launch', async () => {
    const directory = createHomeDirectory('dev-repo-yes-');
    const cliSpec = buildDevCliSpec({ text: 'implement feature' }, { kind: 'self' }, { target: directory, yes: true });
    expect(cliSpec.assumeYes).toBe(true);
    await runDevPipeline({ ...cliSpec, humanReadableOutput: false }, {
      nonGitInteractive: false,
      askNonGitInit: async () => { throw new Error('must not ask'); },
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => ({ ok: true } as never),
    });
    expect(existsSync(join(directory, '.git'))).toBe(true);
  });

  test('without --target, non-git working directory uses the same consent gate', async () => {
    const directory = createHomeDirectory('dev-repo-cwd-');
    await expect(runDevPipeline({ input: { text: 'implement feature' }, humanReadableOutput: false }, {
      cwd: directory, nonGitInteractive: false,
    })).rejects.toMatchObject({ exitCode: 2 });
    expect(existsSync(join(directory, '.git'))).toBe(false);
    await runDevPipeline({ input: { text: 'implement feature' }, humanReadableOutput: false, assumeYes: true }, {
      cwd: directory,
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => ({ ok: true } as never),
    });
    expect(existsSync(join(directory, '.git'))).toBe(true);
  });

  test('provisions before building seams and child execution while preserving the resolved target contract', async () => {
    const directory = createHomeDirectory('dev-repo-provision-');
    const order: string[] = [];
    let seamTarget: string | undefined;
    await runDevPipeline({ ...spec(directory), assumeYes: true }, {
      provisionRepository: (target) => {
        order.push('provision');
        const result = provisionRepository(target);
        return result;
      },
      buildSelfImplementSeams: (plan) => {
        order.push('seams');
        seamTarget = plan.target?.status;
        return {} as SelfImplementSeams;
      },
      runSelfImplement: async () => {
        order.push('run');
        return { ok: true } as never;
      },
    });
    expect(order).toEqual(['provision', 'seams', 'run']);
    expect(seamTarget).toBe('git-repo');
  });

  test('does not build seams or run the child when provision fails', async () => {
    const directory = createHomeDirectory('dev-repo-provision-');
    let downstream = false;
    await expect(runDevPipeline({ ...spec(directory), assumeYes: true }, {
      provisionRepository: () => { throw new Error('provision failed'); },
      buildSelfImplementSeams: () => { downstream = true; return {} as SelfImplementSeams; },
      runSelfImplement: async () => { downstream = true; return { ok: true } as never; },
    })).rejects.toThrow('provision failed');
    expect(downstream).toBe(false);
  });

  test('prints one readable status for promoted and existing-git targets', async () => {
    const promoted = createHomeDirectory('repo-provision-readable-');
    const existing = createHomeDirectory('repo-provision-readable-');
    git(existing, ['init']);
    const output: string[] = [];
    const original = console.log;
    console.log = ((line: unknown) => { output.push(String(line)); }) as typeof console.log;
    try {
      for (const directory of [promoted, existing]) {
        await runDevPipeline({ ...spec(directory), humanReadableOutput: true, assumeYes: true }, {
          buildSelfImplementSeams: () => ({} as SelfImplementSeams),
          runSelfImplement: async () => ({ ok: true } as never),
        });
      }
    } finally {
      console.log = original;
    }
    expect(output.filter((line) => line.startsWith('[repo-provision]'))).toEqual([
      `[repo-provision] promoted ${promoted}`,
      `[repo-provision] .gitignore created ${promoted}`,
      `[repo-provision] already-git ${existing}`,
    ]);
  });
});

describe('repository publication', () => {
  const ok = { ok: true, exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), maybeTruncated: false };

  test('blocks .elanous/auth.json in a non-git directory before any GitHub call and tells the user how to resolve it', async () => {
    const directory = createDirectory('repo-publish-sensitive-');
    mkdirSync(join(directory, '.elanous'));
    writeFileSync(join(directory, '.elanous', 'auth.json'), '{"token":"secret"}');
    const ghCalls: string[][] = [];
    const output: string[] = [];
    const errors: string[] = [];

    const code = await runRepositoryPublish(directory, {
      runGh: (args) => { ghCalls.push(args); return ok; },
      out: { log: (line) => output.push(line), error: (line) => errors.push(line) },
    });

    expect(code).toBe(1);
    expect(ghCalls).toEqual([]);
    expect(output.join('\n')).toContain('.elanous/auth.json');
    expect(errors.join('\n')).toContain('remove the listed credential files');
  });

  test('explains an invalid directory name with a manual valid-name suggestion without changing the report repository', () => {
    const parent = createDirectory('repo-publish-invalid-parent-');
    const directory = join(parent, 'invalid name');
    mkdirSync(directory);
    const report = preflightRepositoryPublish(directory);

    expect(report.repository).toBe('invalid name');
    expect(report.repositoryNameSuggestion).toBe('invalid-name');
    expect(report.remoteAvailability.status).toBe('unknown');
    expect(report.blockers.join('\n')).toContain('rename it to a name using letters, numbers');
    expect(report.blockers.join('\n')).toContain('invalid-name');
  });

  test('records existing, available, and unknown GitHub name availability before confirmation', () => {
    const directory = createDirectory('repo-publish-availability-');
    git(directory, ['init']);
    git(directory, ['config', 'user.email', 'test@example.invalid']);
    git(directory, ['config', 'user.name', 'test']);
    writeFileSync(join(directory, 'app.ts'), 'export {};'); git(directory, ['add', '.']); git(directory, ['commit', '-m', 'initial']);
    const calls: string[][] = [];
    const gh = (lookup: 'exists' | 'available' | 'unknown') => (args: string[]) => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'user') return { ...ok, stdout: Buffer.from('elanous-test\n') };
      if (lookup === 'exists') return { ...ok, stdout: Buffer.from('{}') };
      return { ...ok, ok: false, exitCode: lookup === 'available' ? 1 : 2, stderr: Buffer.from(lookup === 'available' ? 'HTTP 404 Not Found' : 'network unavailable') };
    };

    const existing = preflightRepositoryPublish(directory, { runGh: gh('exists') });
    expect(existing.remoteAvailability).toEqual({ status: 'exists', repository: `elanous-test/${basename(directory)}` });
    expect(existing.blockers.join('\n')).toContain(`GitHub repository elanous-test/${basename(directory)} already exists`);
    const available = preflightRepositoryPublish(directory, { runGh: gh('available') });
    expect(available.remoteAvailability).toEqual({ status: 'available', repository: `elanous-test/${basename(directory)}` });
    expect(available.blockers).not.toContain(expect.stringContaining('availability could not be confirmed'));
    const unknown = preflightRepositoryPublish(directory, { runGh: gh('unknown') });
    expect(unknown.remoteAvailability.status).toBe('unknown');
    expect(unknown.blockers.join('\n')).toContain('availability could not be confirmed');
    expect(calls).toContainEqual(['api', 'user', '--jq', '.login']);
  });

  test('blocks publication when availability changes after confirmation before creating a remote', () => {
    const directory = createDirectory('repo-publish-availability-changed-');
    git(directory, ['init']);
    git(directory, ['config', 'user.email', 'test@example.invalid']);
    git(directory, ['config', 'user.name', 'test']);
    writeFileSync(join(directory, 'app.ts'), 'export {};'); git(directory, ['add', '.']); git(directory, ['commit', '-m', 'initial']);
    let lookup = 'available';
    const calls: string[][] = [];
    const runGh = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'user') return { ...ok, stdout: Buffer.from('elanous-test\n') };
      if (args[0] === 'api') return lookup === 'available'
        ? { ...ok, ok: false, exitCode: 1, stderr: Buffer.from('HTTP 404 Not Found') }
        : { ...ok, stdout: Buffer.from('{}') };
      return ok;
    };
    const confirmed = preflightRepositoryPublish(directory, { runGh });
    lookup = 'exists';
    const result = publishRepository(directory, { runGh, runGit: (cwd, args) => spawnSync('git', args, { cwd, env: gitTestEnv(), encoding: 'utf8' }) as never }, confirmed);

    expect(result.status).toBe('blocked');
    expect(calls.some((args) => args[0] === 'repo' && args[1] === 'create')).toBe(false);
    if (result.status === 'blocked') expect(result.report.blockers.join('\n')).toContain('already exists');
  });

  test('blocks when reachable history scanning fails rather than treating the scan as empty', () => {
    const directory = createDirectory('repo-publish-scan-fail-');
    git(directory, ['init']);
    git(directory, ['config', 'user.email', 'test@example.invalid']);
    git(directory, ['config', 'user.name', 'test']);
    writeFileSync(join(directory, 'app.ts'), 'export {};'); git(directory, ['add', '.']); git(directory, ['commit', '-m', 'initial']);
    const report = preflightRepositoryPublish(directory, {
      runGit: (cwd, args) => args[0] === 'rev-list'
        ? { status: 1, stdout: '', stderr: 'scan denied' }
        : spawnSync('git', args, { cwd, env: gitTestEnv(), encoding: 'utf8' }) as never,
    });
    expect(report.committed).toEqual([]);
    expect(report.blockers).toContain('could not scan reachable repository history (git rev-list --all failed)');
  });

  test('reports reachable historical sensitive paths even after their removal from the current tree', () => {
    const directory = createDirectory('repo-publish-history-');
    git(directory, ['init']);
    git(directory, ['config', 'user.email', 'test@example.invalid']);
    git(directory, ['config', 'user.name', 'test']);
    mkdirSync(join(directory, '.elanous'));
    writeFileSync(join(directory, '.elanous', 'auth.json'), 'secret');
    git(directory, ['add', '-f', '.elanous/auth.json']); git(directory, ['commit', '-m', 'secret']);
    rmSync(join(directory, '.elanous', 'auth.json')); git(directory, ['add', '-A']); git(directory, ['commit', '-m', 'remove']);
    const report = preflightRepositoryPublish(directory);
    expect(report.credentialCandidates).toContain('.elanous/auth.json');
    expect(report.blockers.join('\n')).toContain('credential candidates');
  });

  test('decline and EOF make no GitHub call after a clean local promotion', async () => {
    for (const answer of ['n', undefined]) {
      const directory = createDirectory('repo-publish-decline-');
      writeFileSync(join(directory, 'app.ts'), 'export {};');
      const ghCalls: string[][] = [];
      const output: string[] = [];
      const code = await runRepositoryPublish(directory, {
        confirm: async () => answer,
        runGh: (args) => { ghCalls.push(args); return availableRepositoryGh(args, ok); },
        out: { log: (line) => output.push(line), error: () => {} },
      });
      expect(code).toBe(0);
      expect(ghCalls).toEqual([['api', 'user', '--jq', '.login'], ['api', `repos/elanous-test/${basename(directory)}`]]);
      expect(output).toContain('Repository publication declined; no remote was created and local repository changes remain.');
      expect(existsSync(join(directory, '.git'))).toBe(true);
    }
  });

  test('creates a private remote and pushes the confirmed SHA only after affirmative confirmation', async () => {
    const directory = createDirectory('repo-publish-create-');
    writeFileSync(join(directory, 'app.ts'), 'export {};');
    const ghCalls: string[][] = [];
    const pushes: string[][] = [];
    const errors: string[] = [];
    let confirmed = false;
    const code = await runRepositoryPublish(directory, {
      confirm: async () => { expect(pushes).toEqual([]); confirmed = true; return 'y'; },
      runGh: (args) => { if (args[0] === 'api') return availableRepositoryGh(args, ok); expect(confirmed).toBe(true); ghCalls.push(args); return ok; },
      runGit: (cwd, args) => {
        if (args[0] === 'push') { pushes.push(args); return { status: 0, stdout: '', stderr: '' }; }
        return spawnSync('git', args, { cwd, env: gitTestEnv(), encoding: 'utf8' }) as never;
      },
      out: { log: () => {}, error: (line) => errors.push(line) },
    });
    expect(errors).toEqual([]);
    const head = git(directory, ['rev-parse', 'HEAD']);
    const branch = git(directory, ['symbolic-ref', '--short', 'HEAD']);
    expect(code).toBe(0);
    const publishedTarget = resolveHarnessTarget(directory, { home: dirname(directory) }).canonicalTarget;
    if (!publishedTarget) throw new Error('expected canonical target');
    expect(ghCalls).toEqual([
      ['auth', 'status', '--hostname', 'github.com'],
      ['repo', 'create', basename(directory), '--private', '--source', publishedTarget, '--remote', 'origin'],
    ]);
    expect(pushes).toEqual([['push', '-u', 'origin', `${head}:refs/heads/${branch}`]]);
  });

  test('blocks an unconfirmed direct publish before any GitHub call', () => {
    const directory = createDirectory('repo-publish-unconfirmed-');
    git(directory, ['init']);
    git(directory, ['config', 'user.email', 'test@example.invalid']);
    git(directory, ['config', 'user.name', 'test']);
    writeFileSync(join(directory, 'app.ts'), 'export {};'); git(directory, ['add', '.']); git(directory, ['commit', '-m', 'initial']);
    const ghCalls: string[][] = [];

    const result = publishRepository(directory, {
      runGh: (args) => { ghCalls.push(args); return availableRepositoryGh(args, ok); },
      runGit: (cwd, args) => spawnSync('git', args, { cwd, env: gitTestEnv(), encoding: 'utf8' }) as never,
    }, undefined as unknown as ReturnType<typeof preflightRepositoryPublish>);

    expect(result.status).toBe('blocked');
    expect(ghCalls).toEqual([['api', 'user', '--jq', '.login'], ['api', `repos/elanous-test/${basename(directory)}`]]);
    if (result.status === 'blocked') expect(result.guidance).toContain('explicitly confirm');
  });

  test('pushes the rechecked SHA when the branch moves after GitHub creation', () => {
    const directory = createDirectory('repo-publish-branch-move-');
    git(directory, ['init']);
    git(directory, ['config', 'user.email', 'test@example.invalid']);
    git(directory, ['config', 'user.name', 'test']);
    writeFileSync(join(directory, 'app.ts'), 'export {};'); git(directory, ['add', '.']); git(directory, ['commit', '-m', 'initial']);
    const gh = (args: string[]) => availableRepositoryGh(args, ok);
    const confirmed = preflightRepositoryPublish(directory, { runGh: gh });
    const pushed: string[][] = [];
    const result = publishRepository(directory, {
      runGh: (args) => {
        if (args[0] === 'api') return gh(args);
        if (args[0] === 'repo') {
          writeFileSync(join(directory, 'later.ts'), 'export {};');
          git(directory, ['add', '.']); git(directory, ['commit', '-m', 'later']);
        }
        return ok;
      },
      runGit: (cwd, args) => {
        if (args[0] === 'push') { pushed.push(args); return { status: 0, stdout: '', stderr: '' }; }
        return spawnSync('git', args, { cwd, env: gitTestEnv(), encoding: 'utf8' }) as never;
      },
    }, confirmed);
    expect(result.status).toBe('created');
    expect(pushed).toEqual([['push', '-u', 'origin', `${confirmed.head}:refs/heads/${confirmed.branch}`]]);
    expect(git(directory, ['rev-parse', 'HEAD'])).not.toBe(confirmed.head);
  });

  test('reports GitHub creation failure without attempting a push', () => {
    const directory = createDirectory('repo-publish-create-fail-');
    git(directory, ['init']);
    git(directory, ['config', 'user.email', 'test@example.invalid']);
    git(directory, ['config', 'user.name', 'test']);
    writeFileSync(join(directory, 'app.ts'), 'export {};'); git(directory, ['add', '.']); git(directory, ['commit', '-m', 'initial']);
    const ghCalls: string[][] = [];
    let pushed = false;
    const gh = (args: string[]) => availableRepositoryGh(args, ok);
    const confirmed = preflightRepositoryPublish(directory, { runGh: gh });
    const result = publishRepository(directory, {
      runGh: (args) => {
        if (args[0] === 'api') return gh(args);
        ghCalls.push(args);
        return args[0] === 'repo' ? { ...ok, ok: false, exitCode: 1 } : ok;
      },
      runGit: (_cwd, args) => {
        if (args[0] === 'push') pushed = true;
        return spawnSync('git', args, { cwd: directory, env: gitTestEnv(), encoding: 'utf8' }) as never;
      },
    }, confirmed);
    expect(result.status).toBe('blocked');
    expect(ghCalls).toHaveLength(2);
    expect(pushed).toBe(false);
  });

  test('reports recoverable remote when creation succeeds but push fails', () => {
    const directory = createDirectory('repo-publish-push-fail-');
    git(directory, ['init']);
    git(directory, ['config', 'user.email', 'test@example.invalid']);
    git(directory, ['config', 'user.name', 'test']);
    writeFileSync(join(directory, 'app.ts'), 'export {};'); git(directory, ['add', '.']); git(directory, ['commit', '-m', 'initial']);
    const gh = (args: string[]) => availableRepositoryGh(args, ok);
    const confirmed = preflightRepositoryPublish(directory, { runGh: gh });
    const result = publishRepository(directory, {
      runGh: gh,
      runGit: (_cwd, args) => args[0] === 'push'
        ? { status: 1, stdout: '', stderr: 'push failed' }
        : spawnSync('git', args, { cwd: directory, env: gitTestEnv(), encoding: 'utf8' }) as never,
    }, confirmed);
    expect(result.status).toBe('push-failed');
    if (result.status === 'push-failed') expect(result.guidance).toContain('was created');
  });
});

test('git test helper keeps bare init in its target when GIT_DIR points at a linked worktree shared config', () => {
  const source = createDirectory('repo-bare-source-');
  const shared = createDirectory('repo-bare-shared-');
  const worktree = createDirectory('repo-bare-worktree-');
  const remote = createDirectory('repo-bare-origin-');
  git(source, ['init']);
  writeFileSync(join(source, 'initial'), 'initial');
  git(source, ['add', 'initial']);
  git(source, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'initial']);
  git(shared, ['clone', source, '.']);
  git(shared, ['worktree', 'add', '-b', 'probe', worktree]);
  const sharedConfig = join(shared, '.git', 'config');
  const readBare = () => execFileSync('git', ['config', '--file', sharedConfig, '--get', 'core.bare'], { encoding: 'utf8' }).trim();
  expect(readBare()).toBe('false');
  const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_COMMON_DIR: process.env.GIT_COMMON_DIR };
  try {
    process.env.GIT_DIR = join(shared, '.git');
    git(remote, ['init', '--bare']);
    expect(readBare()).toBe('false');
    expect(git(remote, ['rev-parse', '--is-bare-repository'])).toBe('true');
  } finally {
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    if (readBare() !== 'false') execFileSync('git', ['config', '--file', sharedConfig, 'core.bare', 'false']);
  }
});

describe('repository public transition', () => {
  const ok = { ok: true, exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), maybeTruncated: false };

  const synchronizedGit = (cwd: string, args: string[]) => args[0] === 'fetch'
    ? { status: 0, stdout: '', stderr: '' }
    : spawnSync('git', args, { cwd, env: gitTestEnv(), encoding: 'utf8' }) as never;

  function privateRepository(directory: string): void {
    git(directory, ['init']);
    git(directory, ['config', 'user.email', 'test@example.invalid']);
    git(directory, ['config', 'user.name', 'test']);
    writeFileSync(join(directory, 'app.ts'), 'export {};'); git(directory, ['add', '.']); git(directory, ['commit', '-m', 'initial']);
    git(directory, ['remote', 'add', 'origin', 'git@github.com:elanous-test/private-repository.git']);
  }

  test('makes a clean private repository public after displaying named scope and confirmation', async () => {
    const directory = createDirectory('repo-public-success-');
    privateRepository(directory);
    const calls: string[][] = [];
    const output: string[] = [];
    const code = await runRepositoryPublic(directory, {
      isTerminal: () => true,
      runGit: synchronizedGit,
      confirm: async () => 'y',
      runGh: (args) => {
        calls.push(args);
        return args[1] === 'view' ? { ...ok, stdout: Buffer.from('{"isPrivate":true}') } : ok;
      },
      out: { log: (line) => output.push(line), error: () => {} },
    });
    expect(code).toBe(0);
    expect(output.join('\n')).toContain('app.ts');
    expect(output.join('\n')).toContain('.elanous/');
    expect(calls).toEqual([
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
      ['repo', 'edit', 'elanous-test/private-repository', '--visibility', 'public', '--accept-visibility-change-consequences'],
    ]);
  });

  test('blocks credential candidates with their names and remediation before GitHub visibility calls', async () => {
    const directory = createDirectory('repo-public-sensitive-');
    privateRepository(directory);
    mkdirSync(join(directory, '.elanous'));
    writeFileSync(join(directory, '.elanous', 'auth.json'), 'secret');
    const calls: string[][] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const code = await runRepositoryPublic(directory, {
      isTerminal: () => true,
      runGit: synchronizedGit,
      runGh: (args) => { calls.push(args); return args[1] === 'view' ? { ...ok, stdout: Buffer.from('{"isPrivate":true}') } : ok; },
      out: { log: (line) => output.push(line), error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(calls).toEqual([
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
    ]);
    expect(output.join('\n')).toContain('.elanous/auth.json');
    expect(errors.join('\n')).toContain('every reachable ref and the working tree');
  });

  test('resolves a nested target to the repository root before scanning public scope', async () => {
    const directory = createDirectory('repo-public-root-scan-');
    privateRepository(directory);
    const nested = join(directory, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(directory, '.elanous'));
    writeFileSync(join(directory, '.elanous', 'auth.json'), 'secret');

    for (const target of [directory, nested]) {
      const calls: string[][] = [];
      const output: string[] = [];
      const errors: string[] = [];
      const code = await runRepositoryPublic(target, {
        isTerminal: () => true,
        runGit: synchronizedGit,
        runGh: (args) => { calls.push(args); return args[1] === 'view' ? { ...ok, stdout: Buffer.from('{"isPrivate":true}') } : ok; },
        out: { log: (line) => output.push(line), error: (line) => errors.push(line) },
      });
      expect(code).toBe(1);
      expect(output.join('\n')).toContain('.elanous/auth.json');
      expect(errors.join('\n')).toContain('every reachable ref and the working tree');
      expect(calls).toEqual([
        ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
        ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
      ]);
    }
  });

  test('non-interactive confirmation makes no GitHub call', async () => {
    const directory = createDirectory('repo-public-noninteractive-');
    privateRepository(directory);
    const calls: string[][] = [];
    expect(await runRepositoryPublic(directory, {
      isTerminal: () => false,
      confirm: async () => { throw new Error('confirmation must not run'); },
      runGh: (args) => { calls.push(args); return ok; },
      out: { log: () => {}, error: () => {} },
    })).toBe(0);
    expect(calls).toEqual([]);
  });

  test('rechecks every displayed scope list after confirmation before changing visibility', async () => {
    const directory = createDirectory('repo-public-stale-');
    privateRepository(directory);
    const calls: string[][] = [];
    const errors: string[] = [];
    const code = await runRepositoryPublic(directory, {
      isTerminal: () => true,
      runGit: synchronizedGit,
      confirm: async () => {
        writeFileSync(join(directory, 'later.txt'), 'new committed scope');
        git(directory, ['add', 'later.txt']);
        git(directory, ['commit', '-m', 'later scope']);
        return 'y';
      },
      runGh: (args) => { calls.push(args); return args[1] === 'view' ? { ...ok, stdout: Buffer.from('{"isPrivate":true}') } : ok; },
      out: { log: () => {}, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(calls).toEqual([
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
    ]);
    expect(errors.join('\n')).toContain('Review the current repository state');
  });

  test('already-public is a no-op and remains idempotent', async () => {
    const directory = createDirectory('repo-public-already-');
    privateRepository(directory);
    const calls: string[][] = [];
    const output: string[] = [];
    const gitCalls: string[][] = [];
    const overrides = {
      isTerminal: () => true,
      runGit: (cwd: string, args: string[]) => {
        gitCalls.push(args);
        return spawnSync('git', args, { cwd, env: gitTestEnv(), encoding: 'utf8' }) as never;
      },
      confirm: async () => 'y',
      runGh: (args: string[]) => { calls.push(args); return { ...ok, stdout: Buffer.from('{"isPrivate":false}') }; },
      out: { log: (line: string) => output.push(line), error: () => {} },
    };
    expect(await runRepositoryPublic(directory, overrides)).toBe(0);
    expect(await runRepositoryPublic(directory, overrides)).toBe(0);
    expect(calls.every((args) => args[1] === 'view')).toBe(true);
    expect(calls).toEqual([
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
    ]);
    expect(gitCalls.some((args) => args[0] === 'fetch')).toBe(false);
    expect(output.join('\n')).not.toContain('(private)');
    expect(output.join('\n')).toContain('already public; no visibility change was made');
  });

  test('blocks an invalid GitHub visibility response before confirmation or mutation', async () => {
    const directory = createDirectory('repo-public-invalid-visibility-');
    privateRepository(directory);
    const calls: string[][] = [];
    const errors: string[] = [];
    const code = await runRepositoryPublic(directory, {
      isTerminal: () => true,
      runGit: synchronizedGit,
      confirm: async () => { throw new Error('confirmation must not run'); },
      runGh: (args) => { calls.push(args); return { ...ok, stdout: Buffer.from('{}') }; },
      out: { log: () => {}, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(calls).toEqual([['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate']]);
    expect(errors.join('\n')).toContain('unreadable visibility response');
  });

  test('rejects lookalike GitHub remote hosts before GitHub visibility access', async () => {
    const directory = createDirectory('repo-public-lookalike-');
    privateRepository(directory);
    git(directory, ['remote', 'set-url', 'origin', 'git@evilgithub.com:elanous-test/private-repository.git']);
    const calls: string[][] = [];
    const code = await runRepositoryPublic(directory, {
      isTerminal: () => true,
      runGit: synchronizedGit,
      runGh: (args) => { calls.push(args); return ok; },
      out: { log: () => {}, error: () => {} },
    });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  test('scans advertised origin refs in an isolated bare repository without changing the target fetch state', async () => {
    const directory = createDirectory('repo-public-sync-');
    privateRepository(directory);
    const remote = createDirectory('repo-public-sync-origin-');
    git(remote, ['init', '--bare']);
    git(directory, ['push', remote, 'HEAD:refs/heads/main']);
    const fetchHead = join(directory, '.git', 'FETCH_HEAD');
    const before = existsSync(fetchHead) ? readFileSync(fetchHead, 'utf8') : undefined;
    const code = await runRepositoryPublic(directory, {
      isTerminal: () => true,
      confirm: async () => 'y',
      runGit: (cwd, args) => {
        const command = args[0] === 'fetch' ? ['fetch', ...args.slice(1, 2), remote, ...args.slice(3)] : args;
        return spawnSync('git', command, { cwd, env: gitTestEnv(), encoding: 'utf8' }) as never;
      },
      runGh: (args) => args[1] === 'view' ? { ...ok, stdout: Buffer.from('{"isPrivate":true}') } : ok,
      out: { log: () => {}, error: () => {} },
    });
    expect(code).toBe(0);
    expect(existsSync(fetchHead) ? readFileSync(fetchHead, 'utf8') : undefined).toBe(before);
    expect(git(directory, ['for-each-ref', '--format=%(refname)', 'refs/elanous-internal/'])).toBe('');
  });

  test('blocks a credential reachable only through a fetched pull ref without retaining it in the target object database', async () => {
    const directory = createDirectory('repo-public-pull-ref-');
    privateRepository(directory);
    const remote = createDirectory('repo-public-pull-origin-');
    git(remote, ['init', '--bare']);
    git(directory, ['push', remote, 'HEAD:refs/heads/main']);
    const pullSource = createDirectory('repo-public-pull-source-');
    git(pullSource, ['clone', remote, '.']);
    git(pullSource, ['config', 'user.email', 'test@example.invalid']);
    git(pullSource, ['config', 'user.name', 'test']);
    mkdirSync(join(pullSource, '.elanous'));
    writeFileSync(join(pullSource, '.elanous', 'auth.json'), 'secret');
    git(pullSource, ['add', '-f', '.elanous/auth.json']);
    git(pullSource, ['commit', '-m', 'pull-only credential']);
    const pullCommit = git(pullSource, ['rev-parse', 'HEAD']);
    git(pullSource, ['push', 'origin', `${pullCommit}:refs/pull/1/head`]);
    const localRefs = git(directory, ['rev-list', '--all']);
    expect(localRefs).not.toContain(pullCommit);
    const gitCalls: string[][] = [];
    const calls: string[][] = [];
    const errors: string[] = [];
    const code = await runRepositoryPublic(directory, {
      isTerminal: () => true,
      runGit: (cwd, args) => {
        gitCalls.push(args);
        const command = args[0] === 'fetch' ? ['fetch', ...args.slice(1, 2), remote, ...args.slice(3)] : args;
        return spawnSync('git', command, { cwd, env: gitTestEnv(), encoding: 'utf8' }) as never;
      },
      runGh: (args) => { calls.push(args); return { ...ok, stdout: Buffer.from('{"isPrivate":true}') }; },
      out: { log: () => {}, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(calls).toEqual([
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
      ['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate'],
    ]);
    const fetch = gitCalls.find((args) => args[0] === 'fetch');
    expect(fetch).toEqual(['fetch', '--no-write-fetch-head', 'git@github.com:elanous-test/private-repository.git', '+refs/*:refs/remotes/public-scan/*']);
    expect(spawnSync('git', ['cat-file', '-e', `${pullCommit}^{commit}`], { cwd: directory, env: gitTestEnv(), encoding: 'utf8' }).status).not.toBe(0);
    expect(errors.join('\n')).toContain('.elanous/auth.json');
  });

  test('already-public bypasses credential blockers after visibility is verified', async () => {
    const directory = createDirectory('repo-public-visible-first-');
    privateRepository(directory);
    mkdirSync(join(directory, '.elanous'));
    writeFileSync(join(directory, '.elanous', 'auth.json'), 'secret');
    const calls: string[][] = [];
    const output: string[] = [];
    const code = await runRepositoryPublic(directory, {
      isTerminal: () => true,
      runGit: synchronizedGit,
      confirm: async () => { throw new Error('confirmation must not run'); },
      runGh: (args) => { calls.push(args); return { ...ok, stdout: Buffer.from('{"isPrivate":false}') }; },
      out: { log: (line) => output.push(line), error: () => {} },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([['repo', 'view', 'elanous-test/private-repository', '--json', 'isPrivate']]);
    expect(output.join('\n')).toContain('already public; no visibility change was made');
  });

  test('records the irreversible private-to-public transition with target, scope, and time', async () => {
    const { debug } = await import('../debug/log.js');
    const rows: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({
      name: 'repo-public-observation-capture',
      emit: (row: { category?: string; event?: string; data?: unknown }) => {
        if (row.category === 'repo-provision') rows.push({ event: String(row.event), data: (row.data ?? {}) as Record<string, unknown> });
      },
    } as never);
    try {
      const directory = createDirectory('repo-public-observation-');
      privateRepository(directory);
      await runRepositoryPublic(directory, {
        isTerminal: () => true,
      runGit: synchronizedGit,
      confirm: async () => 'y',
        runGh: (args) => args[1] === 'view' ? { ...ok, stdout: Buffer.from('{"isPrivate":true}') } : ok,
        out: { log: () => {}, error: () => {} },
      });
      const record = rows.find((row) => row.event === 'made-public');
      expect(record?.data).toMatchObject({ from: 'private', to: 'public', committed: ['app.ts'] });
      expect(String(record?.data.target)).toContain(basename(directory));
      expect(typeof record?.data.at).toBe('string');
    } finally { off(); }
  });
});

// ⛔ 무인 리뷰 must-fix(2026-08-18 `#10120`)를 «주장이 아니라 회귀»로 닫는다.
//   지적: "`.gitignore`가 외부 파일의 하드링크이면 정규 파일 검사를 통과한 뒤 writeFileSync 가
//          외부 inode 를 수정한다"
//   📏 실측: 지금 구현은 원본을 «먼저» 백업 이름으로 rename 하고 «새 inode»를 임시 파일로 만들어
//      원자적 rename 으로 얹는다. 그래서 하드링크가 가리키는 «바깥 파일»은 안 바뀐다.
//   ⇒ 그 사실을 여기서 «값으로» 못 박는다. 구현이 그 순서를 잃으면 이 테스트가 깨진다.
describe('provisionRepository — 하드링크 .gitignore 가 «바깥 파일»을 안 건드린다', () => {
  test('바깥 파일 내용과 inode 가 승격 뒤에도 그대로다', () => {
    const outside = createDirectory('repo-provision-outside-');
    const outsidePath = join(outside, 'shared-ignore');
    writeFileSync(outsidePath, 'outside-original\n');
    const outsideBefore = lstatSync(outsidePath);

    const target = createDirectory();
    writeFileSync(join(target, 'a.txt'), 'hello\n');
    // .gitignore 를 «바깥 파일의 하드링크»로 만든다 — 정규 파일 검사는 통과한다.
    linkSync(outsidePath, join(target, '.gitignore'));
    expect(lstatSync(join(target, '.gitignore')).nlink).toBeGreaterThan(1);

    const result = provisionRepository(resolution(target));
    expect(result.status).toBe('provisioned');

    // ⭐ 핵심 단언 — «바깥» 파일이 안 바뀌었다.
    expect(readFileSync(outsidePath, 'utf8')).toBe('outside-original\n');
    expect(String(lstatSync(outsidePath).ino)).toBe(String(outsideBefore.ino));

    // 그리고 대상 안의 .gitignore 는 «새 inode»이며 무시 목록을 담았다.
    const written = readFileSync(join(target, '.gitignore'), 'utf8');
    expect(written).toContain('outside-original');  // 하드링크 원본 내용도 «보존»된다
    expect(written).toContain('.elanous/');
    expect(String(lstatSync(join(target, '.gitignore')).ino)).not.toBe(String(outsideBefore.ino));
  });
});

// 🚨 사람이 쓴 무시 규칙이 «조용히» 사라지던 자리를 못 박는다.
//   📏 실측(2026-08-18 · 이 PR 인수 중): prepareIgnoreSnapshot 이 backupPath 를 반환 객체에
//      «안 담아» ensureIgnoreFile 이 원본을 빈 문자열로 읽었다. 그래서 기존 .gitignore 가 통째로
//      새 목록으로 «대체»됐다. 자식 테스트 14개가 이 갈래를 «한 건도» 안 덮었다.
//   ⛔ 이 회귀는 「추가됐나」가 아니라 ***「기존 것이 살아 있나」***를 묻는다 — 그 둘은 다른 값이다.
describe('provisionRepository — 기존 .gitignore 규칙을 «보존»한다', () => {
  test('사람이 쓴 규칙이 살아 있고 무시 목록이 «덧붙는다»', () => {
    const target = createDirectory('repo-provision-keep-ignore-');
    writeFileSync(join(target, 'a.txt'), 'hello\n');
    writeFileSync(join(target, '.gitignore'), 'my-secret-rule/\nbuild/\n');

    expect(provisionRepository(resolution(target)).status).toBe('provisioned');

    const written = readFileSync(join(target, '.gitignore'), 'utf8');
    expect(written).toContain('my-secret-rule/');
    expect(written).toContain('build/');
    expect(written).toContain('.elanous/');
    for (const glob of SENSITIVE_GLOBS) expect(written).toContain(glob);
  });

  test('이미 담긴 규칙을 «두 번» 넣지 않는다', () => {
    const target = createDirectory('repo-provision-dedupe-ignore-');
    writeFileSync(join(target, 'a.txt'), 'hello\n');
    writeFileSync(join(target, '.gitignore'), `.env\n.elanous/\nkeep-me/\n`);

    expect(provisionRepository(resolution(target)).status).toBe('provisioned');

    const lines = readFileSync(join(target, '.gitignore'), 'utf8').split(/\r?\n/).filter(Boolean);
    expect(lines).toContain('keep-me/');
    expect(lines.filter((line) => line === '.env')).toHaveLength(1);
    expect(lines.filter((line) => line === '.elanous/')).toHaveLength(1);
  });
});

// ⛔ 무인 리뷰 must-fix(2026-08-18 `#10120` 2R): "관측이 classified/promoting/failed/provisioned 정도만
//   기록하며, init·ignore 갱신·add·commit 등 «실제 승격 단계별» 한 줄 로그라는 수용 기준을 충족하지 않는다"
//   ⇒ 단계 관측을 «값으로» 못 박는다. 「승격했다」만 남기면 «어느 단계에서 멎었는지»를 사후에 못 센다.
describe('provisionRepository — 승격 «단계»가 관측에 남는다', () => {
  test('init·config·ignore·add·commit 이 각각 한 줄로 남고 ignore 는 수를 싣는다', async () => {
    const { debug } = await import('../debug/log.js');
    const seen: { event: string; data: Record<string, unknown> }[] = [];
    // ⭐ 선례 그대로 — src/debug/render-mute.test.ts 의 captureSink 형태(LogSink 객체를 넘긴다).
    const off = debug.registerSink({
      name: 'repo-provision-capture',
      emit: (rec) => {
        if (rec.category === 'repo-provision') {
          seen.push({ event: String(rec.event), data: (rec.data ?? {}) as Record<string, unknown> });
        }
      },
    });
    try {
      const target = createDirectory('repo-provision-steps-');
      writeFileSync(join(target, 'a.txt'), 'hello\n');
      writeFileSync(join(target, '.gitignore'), 'keep-me/\n');
      expect(provisionRepository(resolution(target)).status).toBe('provisioned');

      const steps = seen.filter((row) => row.event === 'step').map((row) => String(row.data.step));
      for (const step of ['init', 'config-email', 'config-name', 'ignore', 'add', 'commit']) {
        expect(steps).toContain(step);
      }
      const ignoreRow = seen.find((row) => row.event === 'step' && row.data.step === 'ignore');
      // ⭐ 「더했다」와 「살렸다」를 «둘 다» 센다 — 그 둘은 다른 값이다.
      expect(Number(ignoreRow?.data.added)).toBeGreaterThan(0);
      expect(Number(ignoreRow?.data.preserved)).toBe(1);
    } finally {
      off();
    }
  });
});

// ⛔ 무인 리뷰 must-fix(2026-08-18 `#10120` 3R): "ensureIgnoreFile 이 실패하면 step=ignore 관측을
//   «안 남겨» 실패한 단계마다 한 줄이라는 수용 기준을 못 채운다; 성공·실패 «둘 다» 기록하고
//   그 실패 경로를 테스트하라" — 옳다. 침묵이 정상과 구별 안 되면 그 자는 거짓을 생산한다.
describe('provisionRepository — «실패»도 한 줄로 남는다', () => {
  function captureProvision(): { sink: { name: string; emit: (rec: { category?: string; event?: string; data?: unknown }) => void }; rows: { event: string; data: Record<string, unknown> }[] } {
    const rows: { event: string; data: Record<string, unknown> }[] = [];
    return {
      rows,
      sink: {
        name: 'repo-provision-failure-capture',
        emit: (rec) => {
          if (rec.category === 'repo-provision') rows.push({ event: String(rec.event), data: (rec.data ?? {}) as Record<string, unknown> });
        },
      },
    };
  }

  test('ignore 단계가 실패하면 그 단계가 ok=false 로 남고 롤백 결과도 값으로 남는다', async () => {
    const { debug } = await import('../debug/log.js');
    const { rows, sink } = captureProvision();
    const off = debug.registerSink(sink as never);
    try {
      const target = createDirectory('repo-provision-ignore-fail-');
      writeFileSync(join(target, 'a.txt'), 'hello\n');
      // .gitignore 를 «디렉터리»로 둔다 — 정규 파일이 아니므로 스냅샷 준비가 거부한다.
      mkdirSync(join(target, '.gitignore'));

      expect(() => provisionRepository(resolution(target))).toThrow();

      // ⭐ 실패해도 「어디서 멎었나」가 값으로 남는다.
      const failed = rows.find((row) => row.event === 'failed');
      expect(failed).toBeDefined();
      expect(String(failed?.data.reason)).toContain('non-regular');
      // 롤백이 돌았는지도 «값»이다 — 「안 했다」와 「했는데 실패했다」를 가른다.
      expect(typeof failed?.data.rolledBack).toBe('boolean');
      // 그리고 대상은 저장소가 «안 됐다».
      expect(existsSync(join(target, '.git'))).toBe(false);
    } finally {
      off();
    }
  });

  test('git 단계가 실패하면 그 단계가 ok=false 로 남는다', async () => {
    const { debug } = await import('../debug/log.js');
    const { rows, sink } = captureProvision();
    const off = debug.registerSink(sink as never);
    try {
      const target = createDirectory('repo-provision-git-fail-');
      writeFileSync(join(target, 'a.txt'), 'hello\n');

      expect(() => provisionRepository(resolution(target), {
        // add 단계에서만 실패시킨다 — 그 앞 단계들은 정상으로 남아야 한다.
        runGit: (_cwd, args) => (args[0] === 'add'
          ? { status: 1, stdout: '', stderr: 'injected add failure' }
          : { status: 0, stdout: '', stderr: '' }),
      })).toThrow();

      const steps = rows.filter((row) => row.event === 'step');
      expect(steps.find((row) => row.data.step === 'init')?.data.ok).toBe(true);
      const addStep = steps.find((row) => row.data.step === 'add');
      expect(addStep?.data.ok).toBe(false);
      expect(rows.find((row) => row.event === 'failed')).toBeDefined();
    } finally {
      off();
    }
  });
});


// ⛔ 2026-09-23 — untracked .gitignore 는 «별도 워크트리»에 없다. info/exclude 는 모든 워크트리에 먹는다.
test('ensureInfoExclude — 별도 워크트리에서도 elanous 실행 산출물이 무시된다 · 두 번 불러도 한 번만 쓴다', async () => {
  const { ensureInfoExclude } = await import('./repo-provision.js');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'info-exclude-')));
  const repo = join(root, 'repo'); const wt = join(root, 'wt');
  try {
    const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { env: gitTestEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['init', '-q', repo], { env: gitTestEnv() }); writeFileSync(join(repo, 'README.md'), 'x\n');
    g(repo, 'add', '.'); g(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    const first = ensureInfoExclude(repo);
    expect(first?.added).toBeGreaterThan(0);
    expect(ensureInfoExclude(repo)?.added).toBe(0);
    g(repo, 'worktree', 'add', '-q', wt);
    expect(g(wt, 'check-ignore', '.elanous/debug/chat-1.log').trim()).toBe('.elanous/debug/chat-1.log');
    expect(g(wt, 'check-ignore', '.elanous-child-liveness.hb').trim()).toBe('.elanous-child-liveness.hb');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.elanous/');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
