import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { applyDoctorFixes, applyGitInstall, applySudoFixes, planDoctorFixes, sudoFixCommands, type DoctorFixDeps } from './doctor-fix.js';
import { gitInstallPlan } from './git-install-plan.js';
import { registerDoctorCommand } from './doctor-cli.js';

function fixture(text = 'existing startup\n') {
  const files = new Map<string, { text: string; mode: number }>([
    ['/home/test/.zshrc', { text, mode: 0o644 }],
    ['/cache/one_key', { text: 'SECRET-VALUE', mode: 0o644 }],
    ['/cache/other_key', { text: 'ANOTHER-SECRET', mode: 0o600 }],
  ]);
  const writes: string[] = [];
  const reads: string[] = [];
  const deps: DoctorFixDeps = {
    home: '/home/test',
    env: { SHELL: '/bin/zsh', ELANOUS_KEY_CACHE_DIR: '/cache' },
    readdir: (path) => {
      if (path !== '/cache') throw new Error('unexpected directory');
      return [...files.keys()].filter((name) => name.startsWith('/cache/')).map((name) => name.slice('/cache/'.length));
    },
    readiness: { installPrefix: '/install/elanous', pathEntries: ['/usr/bin'] },
    exists: (path) => path === '/cache' || files.has(path),
    readFile: (path) => { reads.push(path); const entry = files.get(path); if (!entry) throw new Error('missing'); return entry.text; },
    writeFile: (path, text, mode) => { writes.push(path); files.set(path, { text, mode: mode ?? files.get(path)?.mode ?? 0o644 }); },
    appendFile: (path, text) => {
      writes.push(path);
      const entry = files.get(path);
      files.set(path, { text: (entry?.text ?? '') + text, mode: entry?.mode ?? 0o644 });
    },
    mkdir: (path) => { if (path !== '/home/test') throw new Error('unexpected directory'); },
    lstat: (path) => { if (path === '/cache') return { mode: 0o700, isFile: () => false, isSymbolicLink: () => false }; const entry = files.get(path); if (!entry) throw new Error('missing'); return { mode: entry.mode, isFile: () => true, isSymbolicLink: () => false }; },
    chmod: (path, mode) => { writes.push(path); const entry = files.get(path); if (!entry) throw new Error('missing'); entry.mode = mode; },
    temporaryPath: (backup) => `${backup}.temporary`,
    rename: (from, to) => { writes.push(to); const entry = files.get(from); if (!entry) throw new Error('missing temporary backup'); files.set(to, entry); files.delete(from); },
    remove: (path) => { files.delete(path); },
    keyNames: ['one_key'],
  };
  return { files, writes, reads, deps };
}

const block = '# >>> elanous installer PATH >>>\nexport PATH=\'/install/elanous/bin\':"$PATH"\n# <<< elanous installer PATH <<<';

describe('doctor git installation consent', () => {
  test('registered --fix without a TTY never installs; --yes installs and re-probes git', async () => {
    const calls: string[][] = [];
    let installed = false;
    const outputs: string[] = [];
    const codes: number[] = [];
    const register = async (args: string[]) => {
      const program = new Command();
      registerDoctorCommand(program, {
        repositoryRoot: '/repo', platform: 'linux', readiness: { distro: 'debian' },
        readFile: (path) => path === '/repo/.env.example' ? 'ONE_KEY=\n' : path === '/repo/catalog/external-commands.yaml' ? 'commands:\n  - name: git\n    tier: required\n' : '',
        commandExists: (name) => name === 'sudo' || name === 'apt-get' || (name === 'git' && installed),
        userConfig: { registry: { discovery: { firecrawl: {} } } } as never,
        env: {}, gitInteractive: false,
        runGitInstallCommand: (command, commandArgs) => {
          calls.push([command, ...commandArgs]);
          if (command === 'sudo') installed = true;
          return { status: 0 };
        },
        out: { log: (line) => outputs.push(line) }, setExitCode: (code) => codes.push(code),
      });
      await program.parseAsync(['doctor', ...args], { from: 'user' });
    };
    await register(['--fix', '--json']);
    expect(calls).toEqual([]);
    expect(JSON.parse(outputs.at(-1)!).gitPlan.command).toEqual(['sudo', 'apt-get', 'install', '-y', 'git']);
    expect(codes.at(-1)).toBe(1);
    await register(['--fix', '--yes', '--json']);
    expect(calls.slice(0, 2)).toEqual([['sudo', 'apt-get', 'update'], ['sudo', 'apt-get', 'install', '-y', 'git']]);
    expect(calls[2]?.[0]).toBe('git');
    expect(calls[2]?.[1]).toBe('init');
    expect(calls[2]?.[2]).toStartWith(join(tmpdir(), 'elanous-doctor-git-'));
    expect(calls).toHaveLength(3);
    expect(() => lstatSync(calls[2]![2]!)).toThrow();
    expect(JSON.parse(outputs.at(-1)!).gitInstall).toMatchObject({ ran: true, ok: true });
    expect(JSON.parse(outputs.at(-1)!).report.requiredMissing).toEqual([]);
    expect(codes.at(-1)).toBe(0);
  }, 30_000);

  const plan = gitInstallPlan({ platform: 'linux', distro: 'ubuntu', has: () => true });
  test('non-TTY --fix does not execute; --yes executes exactly once and verifies git init', async () => {
    const calls: string[][] = [];
    const run = (command: string, args: readonly string[]) => { calls.push([command, ...args]); return { status: 0 }; };
    expect(await applyGitInstall(plan, { interactive: false, run })).toMatchObject({ ran: false, ok: false });
    expect(calls).toEqual([]);
    expect(await applyGitInstall(plan, { yes: true, interactive: false, run })).toMatchObject({ ran: true, ok: true, detail: 'git init 재확인 성공' });
    expect(calls.slice(0, 2)).toEqual([['sudo', 'apt-get', 'update'], ['sudo', 'apt-get', 'install', '-y', 'git']]);
    expect(calls[2]?.[0]).toBe('git');
    expect(calls[2]?.[1]).toBe('init');
    expect(calls[2]?.[2]).toStartWith(join(tmpdir(), 'elanous-doctor-git-'));
    expect(calls).toHaveLength(3);
    expect(() => lstatSync(calls[2]![2]!)).toThrow();
  });
  test('git version alone does not count as a usable installation', async () => {
    const result = await applyGitInstall({ command: ['installer'], display: 'installer', needsSudo: false }, {
      yes: true,
      run: (command, args) => ({ status: command === 'git' && args[0] === 'init' ? 1 : 0 }),
    });
    expect(result).toMatchObject({ ran: true, ok: false, detail: 'git 설치 또는 git init 재확인 실패' });
  });
  test('post-install git smoke initializes a disposable repository and removes it', async () => {
    let work = '';
    const result = await applyGitInstall({ command: ['installer'], display: 'installer', needsSudo: false }, {
      yes: true,
      run: (command, args) => {
        if (command === 'installer') return { status: 0 };
        expect([command, args[0]]).toEqual(['git', 'init']);
        work = args[1]!;
        expect(work).toStartWith(join(tmpdir(), 'elanous-doctor-git-'));
        const check = spawnSync(command, [...args], { stdio: 'ignore' });
        expect(lstatSync(join(work, '.git')).isDirectory()).toBe(true);
        return { status: check.status };
      },
    });
    expect(result).toMatchObject({ ran: true, ok: true, detail: 'git init 재확인 성공' });
    expect(() => lstatSync(work)).toThrow();
  });

  test('TTY refusal or unknown platform cannot install; affirmative answer and failed recheck are reported', async () => {
    const calls: string[][] = [];
    const run = (command: string, args: readonly string[]) => { calls.push([command, ...args]); return { status: command === 'git' ? 1 : 0 }; };
    expect((await applyGitInstall(plan, { interactive: true, confirm: async () => false, run })).ran).toBe(false);
    expect(calls).toEqual([]);
    expect(await applyGitInstall(plan, { interactive: true, confirm: async () => true, run })).toMatchObject({ ran: true, ok: false });
    expect(calls).toHaveLength(3); // apt-get update · install · git init
    expect((await applyGitInstall({ command: null, display: 'manual', needsSudo: false }, { yes: true, run })).ran).toBe(false);
    expect(calls).toHaveLength(3); // unchanged — the manual plan runs nothing
  });
});

test('static install reports failure if the installed binary fails its smoke check', () => {
  const calls: string[] = [];
  const result = applyDoctorFixes({
    readiness: { platform: 'linux', distro: 'amzn2', rgOnPath: false }, keyNames: [], arch: 'x64',
    installStaticTool: (tool) => { calls.push(`install ${tool}`); return { ok: true, detail: 'installed' }; },
    smokeCheck: (tool) => { calls.push(`smoke ${tool}`); return false; },
  }, true, new Set(['static-tools']));
  expect(calls).toEqual(['install rg', 'smoke rg']);
  expect(result.items.find((item) => item.id === 'static-tools')).toMatchObject({ result: 'failed', reason: 'installed, but smoke check failed' });
  expect(result.exitCode).toBe(1);
});

test('when a pinned static download fails, no smoke check can turn it into a success', () => {
  let checked = 0;
  const result = applyDoctorFixes({
    readiness: { platform: 'linux', distro: 'amzn2', rgOnPath: false }, keyNames: [], arch: 'x64',
    installStaticTool: () => ({ ok: false, detail: 'sha256 mismatch' }),
    smokeCheck: () => { checked++; return true; },
  }, true, new Set(['static-tools']));
  expect(checked).toBe(0);
  expect(result.items.find((item) => item.id === 'static-tools')).toMatchObject({ result: 'failed', reason: 'sha256 mismatch' });
});

test('static install verifies each tool only after its complete pinned set is installed', () => {
  const calls: string[] = [];
  const result = applyDoctorFixes({
    readiness: { platform: 'linux', distro: 'amzn2', codexOnPath: false, nodeOnPath: false }, keyNames: [], arch: 'x64',
    installStaticTool: (name) => { calls.push(`install ${name}`); return { ok: true, detail: name }; },
    smokeCheck: (name) => { calls.push(`smoke ${name}`); return true; },
  }, true, new Set(['static-tools']));
  expect(calls).toEqual(['install codex', 'install codex-code-mode-host', 'smoke codex', 'smoke codex-code-mode-host']);
  expect(result.items.find((item) => item.id === 'static-tools')?.result).toBe('fixed');
});

test('a codex whose host cannot execute is not reported as fixed even when codex --help succeeds', () => {
  const calls: string[] = [];
  const result = applyDoctorFixes({
    readiness: { platform: 'linux', distro: 'amzn2', codexOnPath: false, nodeOnPath: false }, keyNames: [], arch: 'x64',
    installStaticTool: (name) => { calls.push(`install ${name}`); return { ok: true, detail: name }; },
    smokeCheck: (name, dest) => {
      calls.push(`smoke ${name}`);
      expect(dest).toEndWith(`/${name}`);
      return name !== 'codex-code-mode-host';
    },
  }, true, new Set(['static-tools']));
  expect(calls).toEqual(['install codex', 'install codex-code-mode-host', 'smoke codex', 'smoke codex-code-mode-host']);
  expect(result.items.find((item) => item.id === 'static-tools')).toMatchObject({ result: 'failed', reason: 'installed, but smoke check failed' });
  expect(result.exitCode).toBe(1);
});

describe('doctor --fix', () => {
  test('only executes selected catalog id and marks all other planned repairs not selected', () => {
    const f = fixture();
    f.deps.readiness = { installPrefix: null, platform: 'linux', tmpdirSameFsAsBunCache: false, distro: 'amzn2', rgOnPath: false };
    const chmod = f.deps.chmod!;
    f.deps.chmod = (path, mode) => { f.writes.push(`chmod:${path}`); chmod(path, mode); };
    f.deps.installStaticTool = () => ({ ok: true, detail: 'installed' });
    f.deps.smokeCheck = () => true;
    f.deps.configDir = '/home/test/.elanous';
    const exists = f.deps.exists!;
    const lstat = f.deps.lstat!;
    f.deps.exists = (path) => path === f.deps.configDir || exists(path);
    f.deps.lstat = (path) => path === f.deps.configDir
      ? { mode: 0o755, isFile: () => false, isSymbolicLink: () => false }
      : lstat(path);
    const readdir = f.deps.readdir!;
    f.deps.readdir = (path) => path === f.deps.configDir ? [] : readdir(path);
    const selected = new Set(['static-tools'] as const);
    const preview = applyDoctorFixes(f.deps, false, selected);
    expect(preview.items.find((item) => item.id === 'bun-tmpdir')).toMatchObject({ result: 'skipped', reason: 'not selected' });
    expect(f.writes).toEqual([]);
    const result = applyDoctorFixes(f.deps, true, selected);
    expect(result.items.find((item) => item.id === 'static-tools')?.result).toBe('fixed');
    expect(result.items.find((item) => item.id === 'bun-tmpdir')).toMatchObject({ result: 'skipped', reason: 'not selected' });
    expect(result.items.find((item) => item.id === 'private-files')).toMatchObject({ result: 'skipped', reason: 'not selected' });
    expect(result.items.find((item) => item.id === 'key-cache-permissions')).toMatchObject({ result: 'skipped', reason: 'not selected' });
    expect(f.writes).toEqual([]);
  });
  test('dry run lists exact installer block, file and permissions without writes or cache contents', () => {
    const f = fixture();
    const plan = planDoctorFixes(f.deps);
    expect(plan.items).toMatchObject([
      { id: 'install-path', path: '/home/test/.zshrc', action: block, status: 'fixable' },
      { id: 'key-cache-permissions', path: 'one_key', action: 'chmod 600', status: 'fixable' },
    ]);
    expect(f.files.get('/home/test/.zshrc')?.text).toBe('existing startup\n');
    expect(f.writes).toEqual([]);
    expect(applyDoctorFixes(f.deps).items.map((item) => item.result)).toEqual(['skipped', 'skipped']);
    expect(f.writes).toEqual([]);
    expect(f.reads).not.toContain('/cache/one_key');
    expect(f.reads).not.toContain('/cache/other_key');
    expect(JSON.stringify(plan)).not.toContain('SECRET-VALUE');
    expect(JSON.stringify(plan)).not.toContain('/cache/');
  });

  test('Windows writes the installer PowerShell block to the profile, then skips an existing marker', () => {
    const f = fixture();
    const prefix = "C:\\Users\\O'Brien\\AppData\\Local\\elanous";
    const profile = 'C:\\Users\\u\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1';
    f.deps.readiness = { platform: 'win32', installPrefix: prefix, pathEntries: [] };
    f.deps.env = { USERPROFILE: 'C:\\Users\\u', ELANOUS_KEY_CACHE_DIR: '/cache', SHELL: '/bin/bash' };
    f.deps.mkdir = (path) => { expect(path).toBe('C:\\Users\\u\\Documents\\WindowsPowerShell'); };
    const action = "# >>> elanous installer PATH >>>\n$env:PATH = 'C:\\Users\\O''Brien\\AppData\\Local\\elanous\\bin' + [IO.Path]::PathSeparator + $env:PATH\n# <<< elanous installer PATH <<<";
    expect(planDoctorFixes(f.deps).items[0]).toMatchObject({ id: 'install-path', path: profile, action, status: 'fixable' });
    expect(applyDoctorFixes(f.deps, true).items[0]).toMatchObject({ result: 'fixed' });
    expect(f.files.get(profile)?.text).toBe(`\n${action}\n`);
    expect(f.files.get(`${profile}.elanous-doctor.bak`)?.text).toBe('');
    expect(planDoctorFixes(f.deps).items[0]).toMatchObject({ status: 'skipped' });
    const writes = f.writes.length;
    expect(applyDoctorFixes(f.deps, true).items[0]?.result).toBe('skipped');
    expect(f.writes.length).toBe(writes);
    expect(f.files.has('/home/test/.bashrc')).toBe(false);
    f.deps.env.ELANOUS_POWERSHELL_PROFILE = 'C:\\custom\\profile.ps1';
    expect(planDoctorFixes(f.deps).items[0]?.path).toBe('C:\\custom\\profile.ps1');
  });

  test('application backs up original, appends installer block and rechecks permissions without reading secrets', () => {
    const f = fixture();
    const result = applyDoctorFixes(f.deps, true);
    expect(result.exitCode).toBe(0);
    expect(result.items.map((item) => item.result)).toEqual(['fixed', 'fixed']);
    expect(result.items[0]?.reason).toContain('current process readiness is fixable until a new shell loads it');
    expect(f.files.get('/home/test/.zshrc.elanous-doctor.bak')?.text).toBe('existing startup\n');
    expect(f.files.get('/home/test/.zshrc.elanous-doctor.bak')?.mode).toBe(0o644);
    expect(f.files.get('/home/test/.zshrc')?.text).toBe(`existing startup\n\n${block}\n`);
    expect(f.files.get('/cache/one_key')?.mode).toBe(0o600);
    expect(f.files.get('/cache/other_key')?.mode).toBe(0o600);
    expect(f.reads).not.toContain('/cache/one_key');
    expect(f.reads).not.toContain('/cache/other_key');
    expect(JSON.stringify(result)).not.toContain('SECRET-VALUE');
    expect(JSON.stringify(result)).not.toContain('/cache/');
  });

  test('a private startup file keeps its mode on the backup', () => {
    const f = fixture();
    f.files.get('/home/test/.zshrc')!.mode = 0o600;
    expect(applyDoctorFixes(f.deps, true).items[0]?.result).toBe('fixed');
    expect(f.files.get('/home/test/.zshrc.elanous-doctor.bak')).toEqual({ text: 'existing startup\n', mode: 0o600 });
  });

  // ⛔ 2026-09-24(리뷰 must-fix) 계약 뒤집힘 — 키 캐시 폴더(기본 `~/.cache`)엔 다른 프로그램 파일이 산다. 자격 이름만 다룬다.
  test('never touches cache files whose names are not credential names, and never reads contents', () => {
    const f = fixture();
    f.files.set('/cache/unrelated', { text: 'OTHER-SECRET', mode: 0o644 });
    // The directory listing is authoritative even if an optional existence probe is stale.
    const exists = f.deps.exists!;
    f.deps.exists = (path) => path === '/cache/unrelated' ? false : exists(path);
    const plan = planDoctorFixes(f.deps);
    expect(plan.items.find((item) => item.path === 'unrelated')).toBeUndefined();
    const result = applyDoctorFixes(f.deps, true);
    expect(result.items.find((item) => item.path === 'unrelated')).toBeUndefined();
    expect(f.files.get('/cache/unrelated')?.mode).toBe(0o644);
    expect(f.reads).not.toContain('/cache/unrelated');
    expect(JSON.stringify(plan) + JSON.stringify(result)).not.toContain('OTHER-SECRET');
  });

  test('default cache root (~/.cache) repairs only credential-named files and leaves other programs\' files alone', () => {
    const f = fixture();
    f.deps.cacheDir = undefined;
    f.deps.env = { SHELL: '/bin/zsh' };
    f.files.set('/home/test/.cache/one_key', { text: 'SECRET-VALUE', mode: 0o644 });
    f.files.set('/home/test/.cache/unrelated', { text: 'OTHER-SECRET', mode: 0o644 });
    const exists = f.deps.exists!;
    const lstat = f.deps.lstat!;
    f.deps.exists = (path) => path === '/home/test/.cache' || exists(path);
    f.deps.lstat = (path) => path === '/home/test/.cache'
      ? { mode: 0o700, isFile: () => false, isSymbolicLink: () => false }
      : lstat(path);
    f.deps.readdir = (path) => {
      expect(path).toBe('/home/test/.cache');
      return ['one_key', 'unrelated'];
    };
    expect(planDoctorFixes(f.deps).items[1]).toMatchObject({ path: 'one_key', action: 'chmod 600' });
    expect(planDoctorFixes(f.deps).items.map((item) => item.path)).not.toContain('unrelated');
    const result = applyDoctorFixes(f.deps, true);
    expect(result.items.find((item) => item.path === 'one_key')?.result).toBe('fixed');
    expect(result.items.find((item) => item.path === 'unrelated')).toBeUndefined();
    expect(f.files.get('/home/test/.cache/unrelated')?.mode).toBe(0o644);
    expect(f.files.get('/home/test/.cache/one_key')?.mode).toBe(0o600);
    expect(f.reads).not.toContain('/home/test/.cache/one_key');
    expect(f.reads).not.toContain('/home/test/.cache/unrelated');
    expect(JSON.stringify(result)).not.toContain('OTHER-SECRET');
  });

  test('conflicting prefix skips PATH write, even when cache repair is independently possible', () => {
    const original = '# >>> elanous installer PATH >>>\nexport PATH=\'/old/bin\':"$PATH"\n# <<< elanous installer PATH <<<\n';
    const f = fixture(original);
    const result = applyDoctorFixes(f.deps, true);
    expect(result.items[0]).toMatchObject({ result: 'skipped', reason: 'PATH block already points to a different installation prefix' });
    expect(result.items[1]?.result).toBe('fixed');
    expect(f.files.get('/home/test/.zshrc')?.text).toBe(original);
    expect(f.files.has('/home/test/.zshrc.elanous-doctor.bak')).toBe(false);
  });

  test('existing backup stays private until replacement; temporary contents start private', () => {
    const f = fixture();
    const backup = '/home/test/.zshrc.elanous-doctor.bak';
    const temporary = `${backup}.temporary`;
    f.files.set(backup, { text: 'PREVIOUS-BACKUP', mode: 0o600 });
    const originalWrite = f.deps.writeFile!;
    f.deps.writeFile = (path, text, mode) => {
      if (path === temporary) {
        expect(f.files.get(backup)).toEqual({ text: 'PREVIOUS-BACKUP', mode: 0o600 });
        expect(mode).toBe(0o600);
      }
      originalWrite(path, text, mode);
    };
    expect(applyDoctorFixes(f.deps, true).items[0]?.result).toBe('fixed');
    expect(f.files.get(backup)).toEqual({ text: 'existing startup\n', mode: 0o644 });
  });

  test('special permission bits are repaired and rechecked without reading key contents', () => {
    const f = fixture();
    f.files.get('/cache/one_key')!.mode = 0o4600;
    expect(planDoctorFixes(f.deps).items[1]).toMatchObject({ path: 'one_key', status: 'fixable' });
    expect(applyDoctorFixes(f.deps, true).items[1]?.result).toBe('fixed');
    expect(f.files.get('/cache/one_key')?.mode).toBe(0o600);
    expect(f.reads).not.toContain('/cache/one_key');
  });

  test('conflicting marked prefix wins over a matching unmarked PATH line', () => {
    const original = `${block.split('\n')[1]}\n# >>> elanous installer PATH >>>\nexport PATH='/old/bin':"$PATH"\n# <<< elanous installer PATH <<<\n`;
    const f = fixture(original);
    expect(applyDoctorFixes(f.deps, true).items[0]).toMatchObject({ result: 'skipped', reason: 'PATH block already points to a different installation prefix' });
    expect(f.files.get('/home/test/.zshrc')?.text).toBe(original);
    expect(f.files.has('/home/test/.zshrc.elanous-doctor.bak')).toBe(false);
  });

  test('no fixable entries yields success and no writes', () => {
    const f = fixture();
    f.deps.readiness = { installPrefix: '/install/elanous', pathEntries: ['/install/elanous/bin'] };
    f.files.get('/cache/one_key')!.mode = 0o600;
    expect(applyDoctorFixes(f.deps, true)).toMatchObject({ items: [], exitCode: 0 });
    expect(f.writes).toEqual([]);
  });

  test('failed backup prevents startup modification and returns failure', () => {
    const f = fixture();
    f.deps.writeFile = (path, text) => {
      if (path.endsWith('.elanous-doctor.bak.temporary')) throw new Error('secret-not-reported');
      f.writes.push(path);
      f.files.set(path, { text, mode: 0o644 });
    };
    const result = applyDoctorFixes(f.deps, true);
    expect(result.items[0]?.result).toBe('failed');
    expect(result.items[1]?.result).toBe('fixed');
    expect(result.exitCode).toBe(1);
    expect(f.files.get('/home/test/.zshrc')?.text).toBe('existing startup\n');
    expect(JSON.stringify(result)).not.toContain('secret-not-reported');
  });

  // 🆕 2026-09-24 — 로드맵 8번 F4: 리눅스 TMPDIR/bun 캐시 분리를 셸 시작 파일 블록으로 고친다(백업 이름은 PATH 와 따로).
  test('bun-tmpdir: dry run plans the TMPDIR block; --yes appends it with its own backup; a second run skips', () => {
    const f = fixture();
    f.deps.readiness = { installPrefix: null, pathEntries: ['/usr/bin'], platform: 'linux', tmpdirSameFsAsBunCache: false };
    const plan = planDoctorFixes(f.deps);
    const item = plan.items.find((entry) => entry.id === 'bun-tmpdir');
    expect(item).toMatchObject({ path: '/home/test/.zshrc', status: 'fixable' });
    expect(item?.action).toContain('export TMPDIR="$HOME/tmp-bun"');
    expect(f.files.get('/home/test/.zshrc')?.text).toBe('existing startup\n');
    const result = applyDoctorFixes(f.deps, true);
    expect(result.items.find((entry) => entry.id === 'bun-tmpdir')?.result).toBe('fixed');
    expect(f.files.get('/home/test/.zshrc')?.text).toContain('# >>> elanous doctor TMPDIR >>>');
    expect(f.files.get('/home/test/.zshrc.elanous-doctor-tmpdir.bak')?.text).toBe('existing startup\n');
    expect(planDoctorFixes(f.deps).items.find((entry) => entry.id === 'bun-tmpdir')).toMatchObject({ status: 'skipped' });
  });

  test('bun-tmpdir is not planned off Linux or when the filesystems already match', () => {
    const f = fixture();
    f.deps.readiness = { installPrefix: null, pathEntries: ['/usr/bin'], platform: 'darwin', tmpdirSameFsAsBunCache: false };
    expect(planDoctorFixes(f.deps).items.find((entry) => entry.id === 'bun-tmpdir')).toBeUndefined();
    f.deps.readiness = { installPrefix: null, pathEntries: ['/usr/bin'], platform: 'linux', tmpdirSameFsAsBunCache: true };
    expect(planDoctorFixes(f.deps).items.find((entry) => entry.id === 'bun-tmpdir')).toBeUndefined();
  });

  test('unknown credential names change nothing and say so', () => {
    const f = fixture();
    f.deps.keyNames = [];
    const plan = planDoctorFixes(f.deps);
    expect(plan.items.find((item) => item.id === 'key-cache-permissions')).toMatchObject({ status: 'failed', reason: 'credential names unknown — nothing changed' });
    applyDoctorFixes(f.deps, true);
    expect(f.files.get('/cache/one_key')?.mode).toBe(0o644);
  });

  test('chmod failure is per-item and gives exit code 1', () => {
    const f = fixture();
    const chmod = f.deps.chmod!;
    f.deps.chmod = (path, mode) => { if (path === '/cache/one_key') throw new Error('SECRET-VALUE'); chmod(path, mode); };
    const result = applyDoctorFixes(f.deps, true);
    expect(result.items.map((item) => item.result)).toEqual(['fixed', 'failed']);
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result)).not.toContain('SECRET-VALUE');
    expect(JSON.stringify(result)).not.toContain('/cache/');
  });

  test('missing startup is created with an empty backup under an injected home', () => {
    const f = fixture();
    f.files.delete('/home/test/.zshrc');
    const result = applyDoctorFixes(f.deps, true);
    expect(result.items[0]?.result).toBe('fixed');
    expect(f.files.get('/home/test/.zshrc.elanous-doctor.bak')?.text).toBe('');
    expect(f.files.get('/home/test/.zshrc')?.text).toBe(`\n${block}\n`);
  });

  test('already-installed marker avoids duplicate block and backup', () => {
    const f = fixture(`existing startup\n\n${block}\n`);
    const result = applyDoctorFixes(f.deps, true);
    expect(result.items[0]).toMatchObject({ id: 'install-path', result: 'skipped' });
    expect(f.writes).toEqual(['/cache/one_key']);
    expect(f.files.has('/home/test/.zshrc.elanous-doctor.bak')).toBe(false);
  });

  test('startup override and POSIX quote match installer; no changes when PATH already present', () => {
    const f = fixture();
    f.deps.env = { SHELL: '/bin/bash', ELANOUS_SHELL_STARTUP: '/override', ELANOUS_KEY_CACHE_DIR: '/empty' };
    f.deps.readiness = { installPrefix: "/prefix/it's", pathEntries: ['/usr/bin'] };
    f.deps.exists = (path) => path === '/empty';
    f.deps.readdir = (path) => { expect(path).toBe('/empty'); return []; };
    f.deps.lstat = () => ({ mode: 0o700, isFile: () => false, isSymbolicLink: () => false });
    expect(planDoctorFixes(f.deps).items[0]?.action).toContain("export PATH='/prefix/it'\"'\"'s/bin':\"$PATH\"");
    expect(planDoctorFixes(f.deps).items[0]?.path).toBe('/override');
    f.deps.readiness.pathEntries = ["/prefix/it's/bin"];
    expect(planDoctorFixes(f.deps).items).toEqual([]);
  });

  test('registered doctor --fix --yes reports a failed item and exits 1', async () => {
    const f = fixture();
    f.deps.readiness = { installPrefix: '/install/elanous', pathEntries: ['/install/elanous/bin'] };
    const logs: string[] = [];
    const codes: number[] = [];
    f.deps.chmod = (path) => { if (path === '/cache/one_key') throw new Error('SECRET-VALUE'); };
    const program = new Command();
    registerDoctorCommand(program, {
      ...f.deps,
      repositoryRoot: '/repo',
      readFile: (path) => path === '/repo/.env.example' ? 'ONE_KEY=\n' : f.deps.readFile!(path),
      getUserConfig: () => ({ registry: { discovery: { firecrawl: {} } } }) as never,
      commandExists: () => false,
      discoverChromeBinary: () => null,
      loadNativeModule: () => false,
      out: { log: (s) => logs.push(s) },
      setExitCode: (n) => codes.push(n),
    });
    await program.parseAsync(['node', 'elanous', 'doctor', '--fix', '--yes', '--json']);
    const output = JSON.parse(logs.at(-1)!);
    expect(output.results.items).toMatchObject([{ id: 'key-cache-permissions', path: 'one_key', result: 'failed', reason: 'could not chmod or recheck cache file' }]);
    expect(output.results.exitCode).toBe(1);
    expect(codes).toEqual([1]);
    expect(logs.at(-1)).not.toContain('SECRET-VALUE');
  });

  test('registered doctor --restart needs --fix --yes, and then runs the injected restart after the other repairs', async () => {
    const f = fixture();
    f.deps.readiness = { installPrefix: '/install/elanous', pathEntries: ['/install/elanous/bin'], codeRevision: 'abc123', platform: 'darwin', health: { daemonSha: 'fff' } };
    const logs: string[] = [];
    const errors: string[] = [];
    const codes: number[] = [];
    const restarts: unknown[] = [];
    const register = (args: string[]) => {
      const program = new Command();
      registerDoctorCommand(program, {
        ...f.deps,
        repositoryRoot: '/repo',
        readFile: (path) => path === '/repo/.env.example' ? 'ONE_KEY=\n' : f.deps.readFile!(path),
        getUserConfig: () => ({ registry: { discovery: { firecrawl: {} } } }) as never,
        commandExists: () => false,
        discoverChromeBinary: () => null,
        loadNativeModule: () => false,
        out: { log: (s) => logs.push(s) },
        err: { error: (s) => errors.push(s) },
        setExitCode: (n) => codes.push(n),
        applyServiceRestart: async (deps) => { restarts.push(deps.readiness.installPrefix); return { result: 'failed', reason: 'new daemon does not run this code' }; },
      });
      return program.parseAsync(['node', 'elanous', ...args]);
    };
    await register(['doctor', '--fix', '--restart']);
    expect(errors).toEqual(['--restart requires --fix --yes']);
    expect(restarts).toEqual([]);
    await register(['doctor', '--fix', '--yes', '--restart', '--json']);
    expect(restarts).toEqual(['/install/elanous']);
    expect(JSON.parse(logs.at(-1)!).restart).toEqual({ result: 'failed', reason: 'new daemon does not run this code' });
    expect(codes.at(-1)).toBe(1);
  });

  test('registered doctor command preserves ordinary output; fix dry-run and yes JSON use the engine', async () => {
    const f = fixture();
    const logs: string[] = [];
    const codes: number[] = [];
    // The CLI fixture supplies file access only; readiness must come from the real resolver.
    const { readiness: _fixtureReadiness, ...fileDeps } = f.deps;
    const probes: string[] = [];
    const register = (args: string[]) => {
      const program = new Command();
      registerDoctorCommand(program, {
        ...fileDeps,
        env: { ...fileDeps.env, PATH: '/usr/bin' },
        // git 이 없을 때의 설치 계획 항목은 플랫폼에 따라 갈린다(리눅스 = 설치 줄 · «failed» → 종료 1) — 🩸 맥에서만 1 fail 이었다(M5f).
        platform: 'linux',
        repositoryRoot: '/repo',
        readFile: (path) => path === '/repo/.env.example' ? 'ONE_KEY=\nOTHER_KEY=\n' : path === '/repo/catalog/external-commands.yaml' ? 'commands: []\n' : f.deps.readFile!(path),
        rename: f.deps.rename,
        remove: f.deps.remove,
        temporaryPath: f.deps.temporaryPath,
        getUserConfig: () => ({ registry: { discovery: { firecrawl: {} } } }) as never,
        commandExists: () => false,
        discoverChromeBinary: () => null,
        loadNativeModule: () => false,
        listAuthProviders: () => [],
        codeRevision: () => undefined,
        fetchHealth: () => null,
        readInstallPrefix: () => { probes.push('install-prefix'); return '/install/elanous'; },
        out: { log: (s) => logs.push(s) },
        err: { error: (s) => logs.push(s) },
        setExitCode: (n) => codes.push(n),
      });
      return program.parseAsync(['node', 'elanous', ...args]);
    };
    await register(['doctor', '--json']);
    const ordinary = JSON.parse(logs.at(-1)!);
    expect(ordinary.ok).toBe(true);
    expect(ordinary.plan).toBeUndefined();
    expect(codes).toEqual([]);
    await register(['doctor', '--fix', '--json']);
    expect(probes).toEqual(['install-prefix', 'install-prefix', 'install-prefix']);
    expect(JSON.parse(logs.at(-1)!).report.readiness.items.find((item: { id: string }) => item.id === 'install-path').status).toBe('fixable');
    expect(JSON.parse(logs.at(-1)!).plan.items[0]).toMatchObject({ id: 'install-path', path: '/home/test/.zshrc', action: block });
    expect(JSON.parse(logs.at(-1)!).plan.items.find((item: { id: string }) => item.id === 'key-cache-permissions').path).toBe('one_key');
    expect(logs.at(-1)).not.toContain('/cache/');
    expect(f.writes).toEqual([]);
    await register(['doctor', '--fix', '--yes', '--json']);
    expect(JSON.parse(logs.at(-1)!).results.items[0].result).toBe('fixed');
    expect(JSON.parse(logs.at(-1)!).results.items[0].reason).toContain('readiness is fixable');
    expect(JSON.parse(logs.at(-1)!).report.readiness.items.find((item: { id: string }) => item.id === 'install-path').status).toBe('fixable');
    expect(JSON.parse(logs.at(-1)!).results.items.find((item: { id: string }) => item.id === 'key-cache-permissions').path).toBe('one_key');
    expect(logs.at(-1)).not.toContain('/cache/');
    f.files.get('/cache/one_key')!.mode = 0o644;
    await register(['doctor', '--fix']);
    expect(logs.at(-1)).toContain('key-cache-permissions:');
    expect(logs.at(-1)).toContain('one_key');
    expect(logs.at(-1)).not.toContain('/cache/');
    expect(codes).toEqual([1]);
  }, 30_000);
});

describe('doctor --fix — service file (T2 · 2026-09-24)', () => {
  const plist = (path: string) => `<plist><dict><key>ProgramArguments</key><array><string>/usr/bin/bun</string><string>${path}</string><string>nexus</string><string>run</string></array></dict></plist>`;
  const versioned = '/i/elanous/versions/1.0.0-abc/node_modules/elanous/bin/elanous.mjs';
  const stable = '/i/elanous/current/node_modules/elanous/bin/elanous.mjs';

  test('a service file pinned to a version folder is fixable and rewritten to current, with a backup and no restart', () => {
    const f = fixture();
    f.files.set('/la/com.elanous.nexus.plist', { text: plist(versioned), mode: 0o644 });
    const exists = f.deps.exists!;
    f.deps.exists = (path) => path === '/i/elanous/current/node_modules/elanous/' || exists(path);
    f.deps.readiness = { ...f.deps.readiness, serviceFile: { path: '/la/com.elanous.nexus.plist', text: plist(versioned) } };
    const plan = planDoctorFixes(f.deps);
    expect(plan.items.find((item) => item.id === 'service-file')).toMatchObject({ status: 'fixable', path: '/la/com.elanous.nexus.plist' });
    const result = applyDoctorFixes(f.deps, true).items.find((item) => item.id === 'service-file');
    expect(result).toMatchObject({ result: 'fixed' });
    expect(result?.reason).toContain('nothing was restarted');
    expect(f.files.get('/la/com.elanous.nexus.plist')?.text).toBe(plist(stable));
    expect(f.files.get('/la/com.elanous.nexus.plist.elanous-doctor.bak')?.text).toBe(plist(versioned));
  });

  test('without an existing current path the service item is skipped, never half-rewritten', () => {
    const f = fixture();
    f.files.set('/la/com.elanous.nexus.plist', { text: plist(versioned), mode: 0o644 });
    f.deps.readiness = { ...f.deps.readiness, serviceFile: { path: '/la/com.elanous.nexus.plist', text: plist(versioned) } };
    expect(planDoctorFixes(f.deps).items.find((item) => item.id === 'service-file')).toMatchObject({ status: 'skipped' });
    applyDoctorFixes(f.deps, true);
    expect(f.files.get('/la/com.elanous.nexus.plist')?.text).toBe(plist(versioned));
  });

  test('a stable service file yields no service item', () => {
    const f = fixture();
    f.deps.readiness = { ...f.deps.readiness, serviceFile: { path: '/la/com.elanous.nexus.plist', text: plist(stable) } };
    expect(planDoctorFixes(f.deps).items.find((item) => item.id === 'service-file')).toBeUndefined();
  });
});

test('plist provider keys migrate only on cache match or absence; backup, mode, output and unrelated env remain safe', () => {
  const f = fixture();
  const openai = 'unique-openai-plain-value';
  const xai = 'unique-xai-plain-value';
  const path = '/la/com.elanous.nexus.plist';
  const original = `<plist><dict><key>EnvironmentVariables</key><dict>\n<key>OPENAI_API_KEY</key><string>${openai}</string>\n<key>XAI_API_KEY</key><string>${xai}</string>\n<key>ELANOUS_PWA_STATIC_DIR</key><string>/public</string>\n</dict></dict></plist>`;
  f.files.set(path, { text: original, mode: 0o644 });
  f.files.set('/cache/xai_api_key', { text: 'other-value\n', mode: 0o600 });
  f.deps.readiness = { serviceFile: { path, text: original } };
  f.deps.mkdir = (dir) => { expect(dir).toBe('/cache'); };
  const planned = planDoctorFixes(f.deps);
  expect(planned.items.find((item) => item.id === 'service-secrets')).toMatchObject({ status: 'fixable' });
  expect(JSON.stringify(planned)).not.toContain(openai);
  expect(JSON.stringify(planned)).not.toContain(xai);
  expect(f.files.has('/cache/openai_api_key')).toBe(false);
  const result = applyDoctorFixes(f.deps, true);
  const item = result.items.find((entry) => entry.id === 'service-secrets');
  expect(item).toMatchObject({ result: 'fixed' });
  expect(item?.reason).toContain('XAI_API_KEY');
  expect(item?.reason).toContain('next service restart');
  expect(f.files.get('/cache/openai_api_key')).toEqual({ text: `${openai}\n`, mode: 0o600 });
  expect(f.files.get('/cache/xai_api_key')?.text).toBe('other-value\n');
  expect(f.files.get(path)?.text).not.toContain('OPENAI_API_KEY');
  expect(f.files.get(path)?.text).toContain(`<key>XAI_API_KEY</key><string>${xai}</string>`);
  expect(f.files.get(path)?.text).toContain('ELANOUS_PWA_STATIC_DIR');
  expect(f.files.get(`${path}.elanous-doctor.bak`)?.text).toBe(original);
  expect(JSON.stringify(result)).not.toContain(openai);
  expect(JSON.stringify(result)).not.toContain(xai);
  expect(f.files.get(path)?.mode).toBe(0o644);
  expect(f.files.get(`${path}.elanous-doctor.bak`)?.mode).toBe(0o600);
  expect(f.writes).not.toContain('/cache/xai_api_key');
});

test('registered doctor emits neither provider value in JSON or human output', async () => {
  const f = fixture();
  const path = '/la/com.elanous.nexus.plist';
  const openai = 'private-openai-for-cli';
  const xai = 'private-xai-for-cli';
  const original = `<plist><dict><key>EnvironmentVariables</key><dict><key>OPENAI_API_KEY</key><string>${openai}</string><key>XAI_API_KEY</key><string>${xai}</string></dict></dict></plist>`;
  f.files.set(path, { text: original, mode: 0o644 });
  f.files.set('/cache/xai_api_key', { text: 'different-cache-value\n', mode: 0o600 });
  f.deps.readiness = { serviceFile: { path, text: original } };
  f.deps.mkdir = (dir) => { expect(dir).toBe('/cache'); };
  const logs: string[] = [];
  for (const args of [['--json'], ['--fix', '--json'], ['--fix', '--yes', '--json'], ['--fix']]) {
    const program = new Command();
    registerDoctorCommand(program, {
      ...f.deps,
      repositoryRoot: '/repo',
      readFile: (file) => file === '/repo/.env.example' ? 'OPENAI_API_KEY=\nXAI_API_KEY=\n' : f.deps.readFile!(file),
      getUserConfig: () => ({ registry: { discovery: { firecrawl: {} } } }) as never,
      commandExists: () => false,
      discoverChromeBinary: () => null,
      loadNativeModule: () => false,
      out: { log: (line) => logs.push(line) },
      setExitCode: () => {},
    });
    await program.parseAsync(['node', 'elanous', 'doctor', ...args]);
  }
  expect(logs.join('\n')).not.toContain(openai);
  expect(logs.join('\n')).not.toContain(xai);
  expect(logs.join('\n')).not.toContain('different-cache-value');
  expect(logs.join('\n')).toContain('XAI_API_KEY');
});

test('plist XML entities are decoded for the cache without exposing or rewriting unrelated keys', () => {
  const f = fixture();
  const path = '/la/com.elanous.nexus.plist';
  const original = '<plist><dict><key>EnvironmentVariables</key><dict><key>OPENAI_API_KEY</key><string>abc&amp;def</string><key>ELANOUS_PWA_STATIC_DIR</key><string>/public</string></dict></dict></plist>';
  f.files.set(path, { text: original, mode: 0o644 });
  f.deps.readiness = { serviceFile: { path, text: original } };
  f.deps.mkdir = (dir) => { expect(dir).toBe('/cache'); };
  const result = applyDoctorFixes(f.deps, true);
  expect(result.items.find((item) => item.id === 'service-secrets')?.result).toBe('fixed');
  expect(f.files.get('/cache/openai_api_key')?.text).toBe('abc&def\n');
  expect(f.files.get(path)?.text).toContain('<key>ELANOUS_PWA_STATIC_DIR</key><string>/public</string>');
  expect(JSON.stringify(result)).not.toContain('abc&def');
  expect(JSON.stringify(result)).not.toContain('abc&amp;def');
});

test('an existing empty cache receives a key in mode 600 before its service entry is removed', () => {
  const f = fixture();
  const path = '/unit/elanous-nexus.service';
  const original = '[Service]\nEnvironment="OPENAI_API_KEY=private-empty-cache-value"\n';
  f.files.set(path, { text: original, mode: 0o644 });
  f.files.set('/cache/openai_api_key', { text: '', mode: 0o644 });
  f.deps.readiness = { serviceFile: { path, text: original } };
  f.deps.mkdir = (dir) => { expect(dir).toBe('/cache'); };
  const result = applyDoctorFixes(f.deps, true);
  expect(result.items.find((item) => item.id === 'service-secrets')?.result).toBe('fixed');
  expect(f.files.get('/cache/openai_api_key')).toEqual({ text: 'private-empty-cache-value\n', mode: 0o600 });
  expect(f.files.get(path)?.text).toBe('[Service]\n');
  expect(JSON.stringify(result)).not.toContain('private-empty-cache-value');
});

test('a real empty cache is populated without changing the service until cache verification succeeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-doctor-service-'));
  try {
    const path = join(dir, 'elanous-nexus.service');
    const cached = join(dir, 'openai_api_key');
    const original = '[Service]\nEnvironment="OPENAI_API_KEY=private-real-file-value"\n';
    writeFileSync(path, original, { mode: 0o644 });
    writeFileSync(cached, '', { mode: 0o644 });
    const result = applyDoctorFixes({ cacheDir: dir, keyNames: ['openai_api_key'], readiness: { serviceFile: { path, text: original } } }, true);
    expect(result.items.find((item) => item.id === 'service-secrets')?.result).toBe('fixed');
    expect(readFileSync(cached, 'utf8')).toBe('private-real-file-value\n');
    expect(lstatSync(cached).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe('[Service]\n');
    expect(JSON.stringify(result)).not.toContain('private-real-file-value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a conflicting cache leaves the only service key and does not create a backup', () => {
  const f = fixture();
  const path = '/unit/elanous-nexus.service';
  const original = '[Service]\nEnvironment="XAI_API_KEY=private-xai-value"\n';
  f.files.set(path, { text: original, mode: 0o644 });
  f.files.set('/cache/xai_api_key', { text: 'different-cache-value\n', mode: 0o600 });
  f.deps.readiness = { serviceFile: { path, text: original } };
  const result = applyDoctorFixes(f.deps, true);
  expect(result.items.find((item) => item.id === 'service-secrets')).toMatchObject({ result: 'skipped' });
  expect(f.files.get(path)?.text).toBe(original);
  expect(f.files.has(`${path}.elanous-doctor.bak`)).toBe(false);
  expect(JSON.stringify(result)).not.toContain('private-xai-value');
  expect(JSON.stringify(result)).not.toContain('different-cache-value');
});

test('a cache symlink is never followed and the service keeps its only key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-doctor-symlink-'));
  try {
    const path = join(dir, 'elanous-nexus.service');
    const outside = join(dir, 'outside');
    const original = '[Service]\nEnvironment="OPENAI_API_KEY=private-symlink-value"\n';
    writeFileSync(path, original, { mode: 0o644 });
    writeFileSync(outside, 'unrelated-secret\n', { mode: 0o600 });
    symlinkSync(outside, join(dir, 'openai_api_key'));
    const result = applyDoctorFixes({ cacheDir: dir, keyNames: ['openai_api_key'], readiness: { serviceFile: { path, text: original } } }, true);
    expect(result.items.find((item) => item.id === 'service-secrets')?.result).toBe('skipped');
    expect(readFileSync(outside, 'utf8')).toBe('unrelated-secret\n');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(JSON.stringify(result)).not.toContain('private-symlink-value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('systemd migrated Environment line is removed and existing backup is not overwritten', () => {
  const f = fixture();
  const path = '/unit/elanous-nexus.service';
  const original = '[Service]\nEnvironment="OPENAI_API_KEY=unit-private-value"\nEnvironment="ELANOUS_PWA_STATIC_DIR=/public"\n';
  f.files.set(path, { text: original, mode: 0o644 });
  f.files.set(`${path}.elanous-doctor.bak`, { text: 'previous', mode: 0o600 });
  f.deps.readiness = { serviceFile: { path, text: original } };
  f.deps.mkdir = (dir) => { expect(dir).toBe('/cache'); };
  expect(applyDoctorFixes(f.deps, true).items.find((item) => item.id === 'service-secrets')?.result).toBe('fixed');
  expect(f.files.get(path)?.text).toBe('[Service]\nEnvironment="ELANOUS_PWA_STATIC_DIR=/public"\n');
  expect(f.files.get(`${path}.elanous-doctor.bak`)?.text).toBe('previous');
  expect([...f.files.keys()].some((name) => name.startsWith(`${path}.elanous-doctor.bak.`))).toBe(true);
});

describe('doctor --fix — node-pty rebuild (RFC #20265 P2)', () => {
  const base = (distro: 'debian' | 'amzn2') => ({
    readiness: { installPrefix: '/i/elanous', nodePty: 'missing' as const, buildToolchain: { make: true, cxx20: true }, distro },
    realpath: (path: string) => path === '/i/elanous/current' ? '/i/elanous/versions/1.0.0-abc' : path,
    readFile: (path: string) => {
      if (path === '/i/elanous/versions/1.0.0-abc/node_modules/elanous/package.json') return JSON.stringify({ optionalDependencies: { 'node-pty': '^1.1.0' } });
      throw new Error('missing');
    },
  });

  test('plans a rebuild in the installed version folder with the pinned spec, and amzn2 adds the compiler env', () => {
    expect(planDoctorFixes(base('debian')).items.find((item) => item.id === 'node-pty-rebuild'))
      .toMatchObject({ status: 'fixable', path: '/i/elanous/versions/1.0.0-abc', action: 'bun add node-pty@^1.1.0 (in /i/elanous/versions/1.0.0-abc) — then require(\'node-pty\')' });
    expect(planDoctorFixes(base('amzn2')).items.find((item) => item.id === 'node-pty-rebuild')?.action)
      .toContain('CC=gcc10-gcc CXX=gcc10-g++ PYTHON=python3.8 bun add');
  });

  test('--yes runs bun add in that folder and verifies the module loads; a failed build is reported, not folded into success', () => {
    const calls: Array<{ command: string; args: readonly string[]; cwd: string; cc?: string }> = [];
    const ok = applyDoctorFixes({ ...base('amzn2'), runCommand: (command, args, opts) => { calls.push({ command, args, cwd: opts.cwd, cc: opts.env.CC }); return { status: 0, stderr: '' }; }, verifyNodePty: () => true }, true);
    expect(ok.items.find((item) => item.id === 'node-pty-rebuild')).toMatchObject({ result: 'fixed' });
    expect(calls).toEqual([{ command: 'bun', args: ['add', 'node-pty@^1.1.0'], cwd: '/i/elanous/versions/1.0.0-abc', cc: 'gcc10-gcc' }]);
    const failed = applyDoctorFixes({ ...base('debian'), runCommand: () => ({ status: 1, stderr: 'gyp ERR! build error' }), verifyNodePty: () => true }, true);
    expect(failed.items.find((item) => item.id === 'node-pty-rebuild')).toMatchObject({ result: 'failed', reason: 'bun add failed: gyp ERR! build error' });
    expect(failed.exitCode).toBe(1);
  });

  test('from a checkout (no install prefix) there is no rebuild item', () => {
    expect(planDoctorFixes({ readiness: { installPrefix: null, nodePty: 'missing', buildToolchain: { make: true, cxx20: true } } }).items.find((item) => item.id === 'node-pty-rebuild')).toBeUndefined();
  });
});

// 🆕 2026-09-24 — doctor --fix 가 python-env 를 elanous venv 셋업으로 고친다.
describe('doctor --fix python-env', () => {
  const readiness = { pythonEnv: { status: 'fixable' as const, evidence: 'elanous venv missing' } };
  test('plans python-env only when fixable; applies setup and rechecks', () => {
    const { planDoctorFixes: plan, applyDoctorFixes: apply } = require('./doctor-fix.js') as typeof import('./doctor-fix.js');
    expect(plan({ readiness: { pythonEnv: { status: 'ok', evidence: 'ok' } }, keyNames: [] }).items.some((i) => i.id === 'python-env')).toBe(false);
    expect(plan({ readiness, keyNames: [] }).items.find((i) => i.id === 'python-env')).toMatchObject({ status: 'fixable' });
    let ran = 0;
    const ok = apply({ readiness, keyNames: [], pythonSetup: () => { ran++; return 0; }, recheckPythonEnv: () => 'ok' }, true);
    expect(ran).toBe(1);
    expect(ok.items.find((i) => i.id === 'python-env')).toMatchObject({ result: 'fixed' });
    const bad = apply({ readiness, keyNames: [], pythonSetup: () => 1, recheckPythonEnv: () => 'fixable' }, true);
    expect(bad.items.find((i) => i.id === 'python-env')).toMatchObject({ result: 'failed' });
    const dry = apply({ readiness, keyNames: [], pythonSetup: () => { ran++; return 0; } }, false);
    expect(ran).toBe(1);
    expect(dry.items.find((i) => i.id === 'python-env')).toMatchObject({ result: 'skipped' });
  });
});

describe('doctor --fix --yes --sudo (RFC #20265 P5)', () => {
  const manual = [
    { id: 'build-toolchain', status: 'manual' as const, evidence: 'x', remedy: 'sudo dnf install -y gcc-c++ make' },
    { id: 'node-pty', status: 'manual' as const, evidence: 'x', remedy: 'sudo dnf install -y gcc-c++ make' },
    { id: 'provider-decision', status: 'manual' as const, evidence: 'x', remedy: 'elanous login openai-codex' },
  ];

  test('only our sudo install lines, once each', () => {
    expect(sudoFixCommands(manual)).toEqual(['sudo dnf install -y gcc-c++ make']);
  });

  test('a remedy that needs pyenv is not run by --sudo (2026-09-25 amazonlinux:2023)', () => {
    const py = [{ id: 'python-env', status: 'manual' as const, evidence: 'x', remedy: 'sudo dnf install -y gcc make && pyenv install 3.12.12 (build deps per distro: RFC A2) · then: elanous python setup --yes' }];
    expect(sudoFixCommands(py)).toEqual([]);
  });

  test('a remedy that continues into prose is not run as a command (2026-09-25 container)', () => {
    const prose = [{ id: 'python-env', status: 'manual' as const, evidence: 'x', remedy: 'sudo apt-get install -y libssl-dev && install Python 3.12.12+ (pyenv install 3.12.12) — see RFC A2' }];
    expect(sudoFixCommands(prose)).toEqual([]);
  });

  test('a machine that needs a sudo password gets nothing run', () => {
    const calls: string[] = [];
    const result = applySudoFixes(manual, { run: (command, args) => { calls.push([command, ...args].join(' ')); return { status: 1, stderr: 'a password is required' }; } });
    expect(result).toMatchObject({ sudoAvailable: false, runs: [], exitCode: 1 });
    expect(calls).toEqual(['sudo -n true']);
  });

  test('with passwordless sudo the lines run through sh, and a failed line is reported without stopping the others', () => {
    const calls: string[] = [];
    const lines = [...manual, { id: 'gh-auth', status: 'manual' as const, evidence: 'x', remedy: 'sudo apt-get install -y gh' }];
    const result = applySudoFixes(lines, { run: (command, args) => {
      calls.push([command, ...args].join(' '));
      if (command === 'sh' && args[0] === '-c' && args.join(' ').includes('gh')) return { status: 100, stderr: 'E: Unable to locate package gh' };
      return { status: 0, stderr: '' };
    } });
    expect(calls).toEqual(['sudo -n true', 'sh -n -c sudo dnf install -y gcc-c++ make', 'sh -c sudo dnf install -y gcc-c++ make', 'sh -n -c sudo apt-get install -y gh', 'sh -c sudo apt-get install -y gh']);
    expect(result.runs).toEqual([
      { command: 'sudo dnf install -y gcc-c++ make', result: 'ran' },
      { command: 'sudo apt-get install -y gh', result: 'failed', detail: 'E: Unable to locate package gh' },
    ]);
    expect(result.exitCode).toBe(1);
  });
});

// 🩸 09-25 GCP debian-12 — 설명문이 붙은 처방이 문자열 가드를 빠져나가 `sh` 에서 문법 오류로 죽고 rc 1 을 냈다.
describe('applySudoFixes — 셸이 «명령이 아니다»라고 하면 치지 않는다', () => {
  test('a remedy with prose is skipped by the sh -n check, never executed, and does not fail the run', () => {
    const prose = 'sudo apt-get install -y build-essential libssl-dev && reinstall elanous (the package must ship requirements-python.txt)';
    const calls: string[] = [];
    const result = applySudoFixes([{ id: 'python-env', status: 'manual', evidence: 'x', remedy: prose }], { run: (command, args) => {
      calls.push([command, ...args].join(' '));
      // 실물 sh 로 문법만 잰다 — 가짜가 아니라 진짜 판정.
      if (command === 'sh' && args[0] === '-n') { const r = spawnSync('sh', [...args], { encoding: 'utf8' }); return { status: r.status, stderr: r.stderr ?? '' }; }
      return { status: 0, stderr: '' };
    } });
    expect(calls).not.toContain(`sh -c ${prose}`);
    expect(result.runs).toEqual([{ command: prose, result: 'skipped', detail: 'not a shell command — read it and run the parts by hand' }]);
    expect(result.exitCode).toBe(0);
  });
});

// 🆕 2026-09-24 — 재빌드는 잘못 빌드된 node-pty 를 먼저 지우고, 심(node=bun · node-gyp=최신)으로 빌드한다.
describe('node-pty rebuild uses the native build shim', () => {
  test('removes the old module and prepends the shim dir to PATH', () => {
    const { applyDoctorFixes: apply } = require('./doctor-fix.js') as typeof import('./doctor-fix.js');
    const removed: string[] = [];
    let seenPath = '';
    const result = apply({
      keyNames: [],
      readiness: { installPrefix: '/opt/elanous', nodePty: 'missing', buildToolchain: { make: true, cxx20: true }, distro: 'debian' },
      realpath: () => '/opt/elanous/versions/1.0.0',
      readFile: () => JSON.stringify({ optionalDependencies: { 'node-pty': '^1.1.0' } }),
      exists: () => false,
      shimDir: () => '/tmp/shim-x',
      removeTree: (p) => { removed.push(p); },
      runCommand: (_c, _a, opts) => { seenPath = String(opts.env.PATH); return { status: 0, stderr: '' }; },
      verifyNodePty: () => true,
    }, true);
    expect(result.items.find((i) => i.id === 'node-pty-rebuild')).toMatchObject({ result: 'fixed' });
    expect(removed).toEqual(['/opt/elanous/versions/1.0.0/node_modules/node-pty']);
    expect(seenPath.startsWith('/tmp/shim-x')).toBe(true);
  });
});

describe('applyGitInstall — pre-commands and waiting for the macOS installer', () => {
  test('runs apt-get update before install, and stops if the update fails', async () => {
    const { applyGitInstall } = await import('./doctor-fix.js');
    const calls: string[] = [];
    const ok = await applyGitInstall({ command: ['apt-get', 'install', '-y', 'git'], preCommands: [['apt-get', 'update']], display: 'x', needsSudo: false },
      { yes: true, run: (c, a) => { calls.push([c, ...a].join(' ')); return { status: 0 }; } });
    expect(calls.slice(0, 2)).toEqual(['apt-get update', 'apt-get install -y git']);
    expect(calls[2]).toStartWith(`git init ${join(tmpdir(), 'elanous-doctor-git-')}`);
    expect(ok.ok).toBe(true);
    expect(() => lstatSync(calls[2]!.slice('git init '.length))).toThrow();
    const calls2: string[] = [];
    const bad = await applyGitInstall({ command: ['apt-get', 'install', '-y', 'git'], preCommands: [['apt-get', 'update']], display: 'x', needsSudo: false },
      { yes: true, run: (c, a) => { calls2.push([c, ...a].join(' ')); return { status: c === 'apt-get' && a[0] === 'update' ? 100 : 0 }; } });
    expect(calls2).toEqual(['apt-get update']);
    expect(bad.ok).toBe(false);
  });
  test('xcode-select waits until git answers, then reports success', async () => {
    const { applyGitInstall } = await import('./doctor-fix.js');
    let gitCalls = 0; let t = 0;
    const result = await applyGitInstall({ command: ['xcode-select', '--install'], display: 'x', needsSudo: false, waitForGit: true },
      { yes: true, now: () => t, sleep: async (ms) => { t += ms; }, pollMs: 10_000, waitForGitMs: 60_000,
        run: (c) => { if (c === 'git') { gitCalls += 1; return { status: gitCalls >= 3 ? 0 : 1 }; } return { status: 0 }; } });
    expect(result.ok).toBe(true);
    expect(gitCalls).toBe(3);
  });
});
