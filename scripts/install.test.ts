import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, symlinkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repoRoot = resolve(import.meta.dir, '..');
const installer = resolve(import.meta.dir, 'install.sh');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string; bin: Record<string, string> };
const fixtures: string[] = [];

afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }); }, 120_000);

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-install-test-'));
  fixtures.push(dir);
  return dir;
}

function setup(dir = fixture()) {
  const home = join(dir, 'home');
  const prefix = join(dir, 'prefix');
  const startup = join(home, '.bashrc');
  mkdirSync(home, { recursive: true });
  if (!existsSync(startup)) writeFileSync(startup, 'export KEEP=1\n');
  return { dir, home, prefix, startup };
}

const hostBunCache = process.env.BUN_INSTALL_CACHE_DIR ?? join(process.env.BUN_INSTALL ?? join(homedir(), '.bun'), 'install', 'cache');

/** The host PATH minus any directory that already holds an `eln` — the installer (rightly) refuses to create its own
 *  `eln` when another one is on PATH, so a developer machine with elanous installed would otherwise fail these tests. */
function hostPathWithoutEln(path = process.env.PATH ?? ''): string {
  // bun often lives next to an `eln` (`~/.bun/bin`), so dropping that directory would drop bun too — keep bun through a
  // private shim directory that holds only a link to the running bun.
  const shim = mkdtempSync(join(tmpdir(), 'elanous-install-bun-'));
  symlinkSync(process.execPath, join(shim, 'bun'));
  return [shim, ...path.split(':').filter((dir) => dir && !existsSync(join(dir, 'eln')))].join(':');
}

function run(args: string[], env: ReturnType<typeof setup> = setup(), path = hostPathWithoutEln(), cwd = repoRoot, extra: Record<string, string> = {}) {
  const result = spawnSync('/bin/bash', [installer, ...args], {
    cwd,
    encoding: 'utf8',
    // BUN_INSTALL points at the isolated home: install.sh prepends `${BUN_INSTALL}/bin`, and the host's (~/.bun) may hold an eln.
    // The package cache stays the host's — the offline install path depends on it.
    env: { ...process.env, HOME: env.home, XDG_CONFIG_HOME: join(env.home, '.config'), XDG_CACHE_HOME: join(env.home, '.cache'), BUN_INSTALL: join(env.home, '.bun'), BUN_INSTALL_CACHE_DIR: hostBunCache, ELANOUS_INSTALL_PREFIX: env.prefix, ELANOUS_SHELL_STARTUP: env.startup, PATH: path, ELANOUS_INSTALL_LANG: 'en', ...extra },
  });
  return { ...env, result };
}

function requiredFromCatalog(tier: string): string[] {
  const lines = readFileSync(join(repoRoot, 'catalog/external-commands.yaml'), 'utf8').split('\n');
  return lines.flatMap((line, index) => line.includes(`tier: ${tier}`) ? [lines[index - 1]?.match(/name:\s*(\S+)/)?.[1] ?? ''] : []).filter(Boolean).sort();
}

function spawnHelper(prefix: string): string {
  return join(prefix, 'current', 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper');
}

function plantSpawnHelper(prefix: string, mode: number): string {
  const helper = spawnHelper(prefix);
  mkdirSync(join(helper, '..'), { recursive: true });
  writeFileSync(helper, '');
  chmodSync(helper, mode);
  return helper;
}

// git 을 흉내 내는 PATH 심: rev-parse HEAD 는 sha 를, status 는 porcelain 을 낸다.
function stubGit(dir: string, name: string, sha: string, porcelain = ''): string {
  const stubPath = join(dir, `git-${name}`);
  mkdirSync(stubPath, { recursive: true });
  const git = join(stubPath, 'git');
  writeFileSync(git, `#!/bin/sh\ncase "$*" in\n  *rev-parse*) echo ${sha} ;;\n  *status*) printf '%s' '${porcelain}' ;;\nesac\nexit 0\n`);
  chmodSync(git, 0o755);
  return stubPath;
}

// 이 체크아웃을 깔 때 설치기가 지을 폴더 이름(버전 ⊕ 커밋 12자 ⊕ 필요하면 -dirty).
function checkoutVersionName(): string {
  const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout.trim();
  return `${packageJson.version}-${head.slice(0, 12)}${dirty ? '-dirty' : ''}`;
}

function pack(destination: string): string {
  const packed = spawnSync('bun', ['pm', 'pack', '--destination', destination], { cwd: repoRoot, encoding: 'utf8' });
  expect(packed.status).toBe(0);
  return join(destination, readdirSync(destination).find(file => file.endsWith('.tgz'))!);
}

describe('scripts/install.sh', () => {
  test('package bin exposes elanous and eln through the same entrypoint, without mda', () => {
    expect(packageJson.bin).toEqual({ elanous: './bin/elanous.cjs', eln: './bin/elanous.cjs' });
  });

  test('--help names every supported argument', () => {
    const { result } = run(['--help']);
    expect(result.status).toBe(0);
    for (const argument of ['--prefix', '--source', '--no-modify-path', '--no-bootstrap-bun', '--no-install-deps', '--help']) expect(result.stdout).toContain(argument);
  });

  test('installs a working elanous and records nonempty metadata without leaving its isolated home', () => {
    const env = setup();
    const { prefix, result } = run(['--no-modify-path'], env);
    expect(result.status, result.stderr).toBe(0);
    const elanous = join(prefix, 'bin', 'elanous');
    expect(existsSync(elanous)).toBe(true);
    const version = spawnSync(elanous, ['--version'], { encoding: 'utf8', env: { ...process.env, HOME: env.home, XDG_CONFIG_HOME: join(env.home, '.config'), XDG_CACHE_HOME: join(env.home, '.cache') } });
    expect(version.status).toBe(0);
    expect(version.stdout).toContain(packageJson.version);
    const eln = join(prefix, 'bin', 'eln');
    expect(readFileSync(eln, 'utf8')).toBe(readFileSync(elanous, 'utf8'));
    const shortVersion = spawnSync(eln, ['--version'], { encoding: 'utf8', env: { ...process.env, HOME: env.home, XDG_CONFIG_HOME: join(env.home, '.config'), XDG_CACHE_HOME: join(env.home, '.cache') } });
    expect(shortVersion.status, shortVersion.stderr).toBe(0);
    expect(shortVersion.stdout).toBe(version.stdout);
    expect(result.stdout).toContain('eln harness say');
    const metadata = JSON.parse(readFileSync(join(prefix, 'install.json'), 'utf8')) as Record<string, string>;
    expect(metadata.version).toBe(packageJson.version);
    expect(metadata.source).toBe(realpathSync(repoRoot));
    expect(metadata.installedAt).toBeTruthy();
    expect(metadata.commit).toMatch(/^[0-9a-f]{40}$/);
  }, 120_000);

  test('does not replace a foreign eln in the prefix, and warns once', () => {
    const env = setup();
    mkdirSync(join(env.prefix, 'bin'), { recursive: true });
    const eln = join(env.prefix, 'bin', 'eln');
    writeFileSync(eln, '#!/bin/sh\necho other\n');
    chmodSync(eln, 0o755);
    const installed = run(['--no-modify-path'], env);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(installed.result.stdout.match(/⚠ eln:/g)).toHaveLength(1);
    expect(installed.result.stdout).toContain('elanous harness say');
    expect(installed.result.stdout).not.toContain('eln harness say');
    expect(readFileSync(eln, 'utf8')).toBe('#!/bin/sh\necho other\n');
    expect(spawnSync(eln, [], { encoding: 'utf8' }).stdout).toBe('other\n');
  }, 120_000);

  test('does not shadow a foreign eln earlier on PATH', () => {
    const env = setup();
    const pathDir = join(env.dir, 'foreign-path');
    mkdirSync(pathDir);
    const foreign = join(pathDir, 'eln');
    writeFileSync(foreign, '#!/bin/sh\necho other\n');
    chmodSync(foreign, 0o755);
    const installed = run(['--no-modify-path'], env, `${pathDir}:${process.env.PATH ?? ''}`);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(installed.result.stdout.match(/⚠ eln:/g)).toHaveLength(1);
    expect(installed.result.stdout).toContain('elanous harness say');
    expect(installed.result.stdout).not.toContain('eln harness say');
    expect(existsSync(join(env.prefix, 'bin', 'eln'))).toBe(false);
    expect(spawnSync(foreign, [], { encoding: 'utf8' }).stdout).toBe('other\n');
  }, 120_000);

  // 🩸 2026-09-25 빈 debian:12: ~/.bashrc 는 비대화형이면 맨 앞에서 return 한다 ⇒ `bash -lc elanous`(ssh 원격 명령)가 못 찾았다.
  test('a bash user without an override gets the PATH block in ~/.profile too (login shells)', () => {
    const { home, result } = run([], setup(), process.env.PATH ?? '', repoRoot, { ELANOUS_SHELL_STARTUP: '', SHELL: '/bin/bash' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toContain('# >>> elanous installer PATH >>>');
    expect(readFileSync(join(home, '.profile'), 'utf8')).toContain('# >>> elanous installer PATH >>>');
  }, 120_000);

  // 🩸 2026-09-28 node-b: zsh 도 ~/.zshrc 는 대화형만 읽는다 ⇒ `ssh host elanous`(비대화형)가 못 찾았다.
  test('a zsh user without an override gets the PATH block in ~/.zshenv too (non-interactive ssh)', () => {
    const { home, result } = run([], setup(), process.env.PATH ?? '', repoRoot, { ELANOUS_SHELL_STARTUP: '', SHELL: '/bin/zsh' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toContain('# >>> elanous installer PATH >>>');
    expect(readFileSync(join(home, '.zshenv'), 'utf8')).toContain('# >>> elanous installer PATH >>>');
  }, 120_000);

  test('the installed sh wrapper uses the resolved bun without PATH and follows current for version and installed universe', () => {
    const env = setup();
    const { prefix, result } = run(['--no-modify-path'], env);
    expect(result.status, result.stderr).toBe(0);
    const elanous = join(prefix, 'bin', 'elanous');
    const bunLink = join(prefix, 'bin', 'bun');
    const bunExec = realpathSync(bunLink);
    expect(lstatSync(elanous).isFile()).toBe(true);
    expect(readFileSync(elanous, 'utf8')).toStartWith('#!/bin/sh\n');
    expect(readFileSync(elanous, 'utf8')).toContain(bunExec);
    expect(readlinkSync(bunLink)).toBe(bunExec);
    const restricted = { HOME: env.home, PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: join(env.home, '.config'), XDG_CACHE_HOME: join(env.home, '.cache') };
    const control = spawnSync('/usr/bin/env', ['bun', '--version'], { encoding: 'utf8', env: restricted });
    expect(control.status).not.toBe(0);
    expect(control.stderr).toContain('bun');
    const version = spawnSync(elanous, ['--version'], { encoding: 'utf8', env: restricted });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout).toContain(packageJson.version);
    const where = spawnSync(elanous, ['where', '--json'], { encoding: 'utf8', env: restricted });
    expect(where.status, where.stderr).toBe(0);
    const universe = JSON.parse(where.stdout) as { kind: string; layer: string };
    expect(universe.kind).toBe('prod');
    expect(universe.layer).toBe('installed');
    const entry = join(prefix, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs');
    expect(realpathSync(entry)).toContain('/node_modules/elanous/bin/elanous.mjs');
    expect(readFileSync(elanous, 'utf8')).toContain(entry);
    // The installer writes bin/elanous; executing that wrapper must pass the installed entry to Bun, not the checkout entry.
    writeFileSync(entry, 'console.log(JSON.stringify({ entry: process.argv[1], args: process.argv.slice(2) }))\n');
    const forwarded = spawnSync(elanous, ['argv-probe', 'argument with spaces'], { encoding: 'utf8', env: restricted });
    expect(forwarded.status, forwarded.stderr).toBe(0);
    expect(JSON.parse(forwarded.stdout)).toEqual({ entry: realpathSync(entry), args: ['argv-probe', 'argument with spaces'] });
  }, 120_000);

  test('a bun that cannot print its execPath is pinned by its absolute PATH location — never by a bare name', () => {
    const env = setup();
    const path = join(env.dir, 'path');
    mkdirSync(path);
    const git = join(path, 'git');
    writeFileSync(git, '#!/bin/sh\nexit 0\n');
    chmodSync(git, 0o755);
    const bun = join(path, 'bun');
    writeFileSync(bun, '#!/bin/sh\nprintf relative-bun\n');
    chmodSync(bun, 0o755);
    const { result } = run(['--no-modify-path', '--no-bootstrap-bun'], env, `${path}:/usr/bin:/bin`);
    // 폴백(`command -v bun`)이 절대 경로를 준다 ⇒ «절대 경로 없음»으로 거부하지 않는다(옛 동작 · BUN_INSTALL 재사용 시험과 같은 축).
    expect(result.stderr).not.toContain('bun executable absolute path is unavailable');
    const wrapper = join(env.prefix, 'bin', 'elanous');
    if (existsSync(wrapper)) {
      const text = readFileSync(wrapper, 'utf8');
      expect(text).toContain(bun);
      expect(text).not.toContain('relative-bun');
    }
  });

  test('the installed wrapper reports one line when its pinned bun is missing', () => {
    const packed = pack(fixture());
    const env = setup();
    const { result } = run(['--source', packed, '--no-modify-path'], env);
    expect(result.status, result.stderr).toBe(0);
    const elanous = join(env.prefix, 'bin', 'elanous');
    const bun = realpathSync(join(env.prefix, 'bin', 'bun'));
    const wrapper = readFileSync(elanous, 'utf8');
    const unavailable = join(env.dir, 'bun-not-found');
    writeFileSync(elanous, wrapper.replaceAll(bun, unavailable));
    const missing = spawnSync(elanous, ['--version'], { encoding: 'utf8', env: { HOME: env.home, PATH: '/usr/bin:/bin' } });
    expect(missing.status).toBe(127);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toBe(`bun not found: ${unavailable} — run the installer again\n`);
  }, 120_000);

  test('preserves the first installation startup file across a real reinstallation', () => {
    const env = setup();
    const first = run([], env);
    const second = run([], env);
    expect(first.result.status).toBe(0);
    expect(second.result.status).toBe(0);
    const startup = readFileSync(env.startup, 'utf8');
    expect(startup.match(/^# >>> elanous installer PATH >>>$/gm)).toHaveLength(1);
    expect(startup.match(/^# <<< elanous installer PATH <<<$/gm)).toHaveLength(1);
    expect(startup).toContain('export KEEP=1');
  }, 120_000);

  test('rejects a different prefix without changing the existing PATH block', () => {
    const env = setup();
    const first = run([], env);
    expect(first.result.status, first.result.stderr).toBe(0);
    const before = readFileSync(env.startup, 'utf8');
    const replacementPrefix = join(env.dir, 'replacement-prefix');
    const second = run(['--prefix', replacementPrefix], env);
    expect(second.result.status).not.toBe(0);
    expect(`${second.result.stdout}${second.result.stderr}`).toContain('different installation prefix');
    expect(readFileSync(env.startup, 'utf8')).toBe(before);
    const loaded = spawnSync('/bin/bash', ['--noprofile', '--rcfile', env.startup, '-i', '-c', 'command -v elanous'], {
      encoding: 'utf8', env: { ...process.env, HOME: env.home, PATH: process.env.PATH ?? '' },
    });
    expect(loaded.status).toBe(0);
    expect(loaded.stdout.trim()).toBe(join(realpathSync(env.prefix), 'bin', 'elanous'));
  }, 120_000);

  test('--no-modify-path preserves the startup file byte-for-byte', () => {
    const env = setup();
    const { result } = run(['--no-modify-path'], env);
    expect(result.status).toBe(0);
    expect(readFileSync(env.startup, 'utf8')).toBe('export KEEP=1\n');
  }, 120_000);

  test('names bun and fails nonzero when bun is absent', () => {
    const stubPath = join(fixture(), 'path');
    mkdirSync(stubPath);
    const git = join(stubPath, 'git');
    writeFileSync(git, '#!/bin/sh\nexit 0\n');
    chmodSync(git, 0o755);
    const env = setup();
    // 설치기는 이제 표준 위치(${BUN_INSTALL:-$HOME/.bun}/bin/bun)의 bun 도 찾는다 — 시험 셸의 BUN_INSTALL 을 물려받지 않게 가짜 HOME 쪽으로.
    const { result } = run(['--no-modify-path', '--no-bootstrap-bun'], env, stubPath, repoRoot, { BUN_INSTALL: join(env.home, '.bun') });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('bun');
  });

  test('missing required commands give distro-specific install hints and retain rc 127', () => {
    const cases = [
      { release: 'ID=amzn\nVERSION_ID=2\n', platform: 'Linux', missing: 'git', expected: 'sudo yum install -y git' },
      { release: 'ID="amzn"\nVERSION_ID="2"\n', platform: 'Linux', missing: 'git', expected: 'sudo yum install -y git' },
      { release: 'ID=amzn\nVERSION_ID=2023\n', platform: 'Linux', missing: 'git', expected: 'sudo dnf install -y git' },
      { release: 'ID=ubuntu\n', platform: 'Linux', missing: 'bun', expected: 'curl -fsSL https://bun.sh/install | bash' },
      { release: 'ID=amzn\nVERSION_ID=2\n', platform: 'Linux', missing: 'bun', expected: 'curl -fsSL https://bun.sh/install | bash' },
      { release: 'ID=alpine\n', platform: 'Linux', missing: 'bun', expected: "(install the 'bun' package with your package manager)" },
      { release: 'ID=linuxmint\nID_LIKE="ubuntu debian"\n', platform: 'Linux', missing: 'git', expected: 'sudo apt-get install -y git' },
      { release: 'ID=alpine\n', platform: 'Linux', missing: 'git', expected: "(install the 'git' package with your package manager)" },
      { release: 'ID=amzn\nVERSION_ID=2\n', platform: 'Darwin', missing: 'git', expected: 'brew install git' },
    ];
    for (const { release, platform, missing, expected } of cases) {
      const env = setup();
      const path = join(env.dir, 'path');
      mkdirSync(path);
      const osRelease = join(env.dir, 'os-release');
      writeFileSync(osRelease, release);
      for (const [name, body] of [
        ['uname', `#!/bin/sh\nprintf '%s\\n' '${platform}'\n`],
        [missing === 'git' ? 'bun' : 'git', '#!/bin/sh\nexit 0\n'],
      ]) {
        const file = join(path, name);
        writeFileSync(file, body);
        chmodSync(file, 0o755);
      }
      const { result } = run(['--no-modify-path', '--no-bootstrap-bun'], env, path, repoRoot,
        { BUN_INSTALL: join(env.home, '.bun'), ELANOUS_INSTALL_OS_RELEASE_FILE: osRelease });
      expect(result.status, `${missing}: ${result.stderr}`).toBe(127);
      expect(result.stderr).toContain(`required command missing: ${missing}`);
      expect(result.stderr).toContain(expected);
      if (platform === 'Linux' && release.includes('VERSION_ID=2\n')) expect(result.stderr).not.toContain('sudo dnf install');
      if (release.includes('ID=alpine')) expect(result.stderr).not.toMatch(/sudo |brew install|bun\.sh\/install/);
      if (missing === 'bun') expect(result.stderr).not.toMatch(/(?:apt-get|dnf|yum|brew) install (?:-y )?bun/);
    }
  });

  // 📏 09-25 베어 ubuntu:24.04(root · sudo 없음): unzip → 깔고 다시 → git 으로 또 멈췄고(세 판), 안내 줄마다 sudo 가 붙어 그대로 치면 실패했다.
  test('a bare machine gets every missing prerequisite in one line, and root gets no sudo', () => {
    for (const root of [false, true]) {
      const env = setup();
      const path = join(env.dir, 'path');
      mkdirSync(path);
      const osRelease = join(env.dir, 'os-release');
      writeFileSync(osRelease, 'ID=ubuntu\n');
      const stubs: Array<[string, string]> = [['uname', "#!/bin/sh\nprintf 'Linux\\n'\n"]];
      if (root) stubs.push(['id', '#!/bin/sh\necho 0\n']);
      for (const [name, body] of stubs) {
        const file = join(path, name);
        writeFileSync(file, body);
        chmodSync(file, 0o755);
      }
      // bun·curl·unzip·git 이 전부 없다 — bun 은 설치기가 깔 것이므로 세지 않고, 그 설치에 드는 curl·unzip 을 센다.
      const { result } = run(['--no-modify-path'], env, path, repoRoot,
        { BUN_INSTALL: join(env.home, '.bun'), ELANOUS_INSTALL_OS_RELEASE_FILE: osRelease });
      expect(result.status, result.stderr).toBe(127);
      expect(result.stderr).toContain('required command missing: curl unzip git');
      expect(result.stderr).toContain(`   ${root ? '' : 'sudo '}apt-get install -y curl unzip git`);
      expect(result.stderr.match(/required command missing/g)?.length).toBe(1);
      if (root) expect(result.stderr).not.toContain('sudo ');
    }
  });

  // The fake PATH contains no host apt/curl/unzip/git: only the stub can make prerequisites appear.
  function aptPrerequisiteFixture(uid: number, release = 'ID=ubuntu\n', fail = false) {
    const env = setup();
    const path = join(env.dir, 'path');
    mkdirSync(path);
    const osRelease = join(env.dir, 'os-release');
    writeFileSync(osRelease, release);
    const calls = join(env.dir, 'apt-calls');
    for (const [name, body] of [
      ['uname', '#!/bin/sh\nprintf "Linux\\n"\n'],
      ['id', `#!/bin/sh\nprintf '${uid}\\n'\n`],
      ['apt-get', `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n${fail ? 'exit 100' : `for package in "$@"; do\n  case "$package" in curl|unzip|git) printf '#!/bin/sh\\nexit 0\\n' > '${path}/'"$package"; chmod +x '${path}/'"$package" ;; esac\ndone\n`}\n`],
    ] as Array<[string, string]>) {
      writeFileSync(join(path, name), body, { mode: 0o755 });
    }
    // A successful apt stub must be able to chmod newly created commands in the same PATH.
    symlinkSync('/bin/chmod', join(path, 'chmod'));
    const extra = { BUN_INSTALL: join(env.home, '.bun'), ELANOUS_INSTALL_OS_RELEASE_FILE: osRelease };
    return { env, path, calls, extra };
  }

  test('root Debian apt installs the missing set once, rechecks it, and advances past the prerequisite gate', () => {
    const { env, path, calls, extra } = aptPrerequisiteFixture(0);
    const { result } = run(['--no-modify-path'], env, path, repoRoot, extra);
    // Fresh images have empty package lists: one update, then one non-interactive install.
    expect(readFileSync(calls, 'utf8')).toBe('update -qq\ninstall -y -qq curl unzip git\n');
    expect(result.stderr).toContain('installed: curl unzip git');
    // Past the prerequisite gate: later steps may still stop (the fake PATH has no real bun/bash), but never on curl/unzip/git.
    expect(result.stderr).not.toMatch(/required command missing: [^\n]*\b(?:curl|unzip|git)\b/);
  });

  test('a non-root user never invokes apt even when it is present', () => {
    const { env, path, calls, extra } = aptPrerequisiteFixture(1000);
    const { result } = run([], env, path, repoRoot, extra);
    expect(existsSync(calls)).toBe(false);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('   sudo apt-get install -y curl unzip git');
  });

  test('--no-install-deps disables apt for root without changing the existing hint', () => {
    const { env, path, calls, extra } = aptPrerequisiteFixture(0);
    const { result } = run(['--no-install-deps'], env, path, repoRoot, extra);
    expect(existsSync(calls)).toBe(false);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('   apt-get install -y curl unzip git');
  });

  test('root with all prerequisites present does not invoke apt', () => {
    const { env, path, calls, extra } = aptPrerequisiteFixture(0);
    for (const name of ['bun', 'git']) writeFileSync(join(path, name), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    const { result } = run(['--no-bootstrap-bun'], env, path, repoRoot, extra);
    expect(existsSync(calls)).toBe(false);
    expect(result.stderr).not.toContain('required command missing: git');
  });

  test('apt is not invoked for root on a non-Debian distribution', () => {
    const { env, path, calls, extra } = aptPrerequisiteFixture(0, 'ID=alpine\n');
    const { result } = run([], env, path, repoRoot, extra);
    expect(existsSync(calls)).toBe(false);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("(install the 'curl unzip git' package with your package manager)");
  });

  test('apt failure stays rc 127 and names manual recovery with the existing hint', () => {
    const { env, path, calls, extra } = aptPrerequisiteFixture(0, 'ID=ubuntu\n', true);
    const { result } = run([], env, path, repoRoot, extra);
    // The failing stub fails at update, so install is never attempted.
    expect(readFileSync(calls, 'utf8')).toBe('update -qq\n');
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('자동 설치 실패 — 아래를 직접 실행하라');
    expect(result.stderr).toContain('   apt-get install -y curl unzip git');
  });

  test('bun bootstrap is pinned to the repository bun version (.bun-version)', () => {
    const pin = readFileSync(join(repoRoot, '.bun-version'), 'utf8').trim();
    expect(readFileSync(installer, 'utf8')).toContain(`BUN_PIN="\${ELANOUS_BUN_VERSION:-${pin}}"`);
    // Pod 이미지 — build.sh 가 .bun-version 을 넘기지만, 인자 없이 빌드해도 같은 판이게 기본값도 맞춘다.
    // docker/ 는 공개본에 안 실린다 — 있을 때만 대조한다(공개 저장소에서 «없는 파일»로 깨지지 않게).
    const podDir = ['docker', 'harness'].join('/');
    if (existsSync(join(repoRoot, podDir, 'Dockerfile'))) {
      expect(readFileSync(join(repoRoot, podDir, 'Dockerfile'), 'utf8')).toContain(`ARG BUN_VERSION=${pin}`);
      expect(readFileSync(join(repoRoot, podDir, 'build.sh'), 'utf8')).toContain('.bun-version');
    }
  });

  // 🩸 09-25 GCP debian-12: 로그인 셸은 $PREFIX/bin 이 PATH 맨 앞 — 재설치 때 `command -v bun` 이 우리 링크 자신을 집어
  //    `bin/bun -> bin/bun` 고리를 만들었다(설치 rc 127 · 이후 elanous 전부 죽음). 업데이트 경로 전부가 여기를 지난다.
  test('reinstalling with $PREFIX/bin first on PATH links bun to the real executable, and heals an existing loop', () => {
    const packed = pack(fixture());
    const env = setup();
    const first = run(['--source', packed, '--no-modify-path'], env);
    expect(first.result.status, first.result.stderr).toBe(0);
    const bunLink = join(env.prefix, 'bin', 'bun');
    const realBun = realpathSync(spawnSync('bun', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).stdout);
    const loginPath = `${join(env.prefix, 'bin')}:${process.env.PATH ?? ''}`;
    const again = run(['--source', packed, '--no-modify-path'], env, loginPath);
    expect(again.result.status, again.result.stderr).toBe(0);
    expect(realpathSync(bunLink)).toBe(realBun);
    // 0.1.0 이 이미 만든 고리 — 새 설치기가 걷고 다시 잇는다.
    rmSync(bunLink);
    spawnSync('ln', ['-s', bunLink, bunLink]);
    expect(() => realpathSync(bunLink)).toThrow();
    const healed = run(['--source', packed, '--no-modify-path'], env, loginPath);
    expect(healed.result.status, healed.result.stderr).toBe(0);
    expect(healed.result.stderr).toContain('removing a broken bun link');
    expect(realpathSync(bunLink)).toBe(realBun);
  }, 300_000);

  test('portable mktemp ratchet catches a violating fixture and permits the installer', () => {
    const portable = (source: string) => !source.includes('mktemp -t');
    expect(portable(readFileSync(installer, 'utf8'))).toBe(true);
    expect(portable('#!/bin/sh\nmktemp -t elanous\n')).toBe(false);
  });

  test('the required command set exactly matches the catalog and remains two entries', () => {
    const installerRequired = readFileSync(installer, 'utf8').match(/REQUIRED_COMMANDS=\(([^)]*)\)/)?.[1].trim().split(/\s+/).sort();
    expect(installerRequired).toEqual(requiredFromCatalog('required'));
    expect(installerRequired).toEqual(['bun', 'git']);
  });

  test('--source reads version from the installed tarball and JSON-encodes a quoted source path', () => {
    const packed = pack(fixture());
    // ⛔ 경로에 «백슬래시»가 들어가면 Bun 의 realpathSync 가 ENOENT 를 던진다 — existsSync 는 true 인데도 그렇다.
    //    📏 2026-09-21 실측(bun 1.3.12 · macOS): existsSync(f)=true 인데 realpathSync(f) 가 ENOENT.
    //    ⇒ 그래서 «백슬래시가 없는 뿌리»만 해석하고 나머지 칸은 join 으로 붙인다.
    //    ⛔ 그리고 플랫폼 이름으로 접두를 짐작하지 않는다 — macOS 의 mktemp 는 /tmp 가 아니라
    //       /var/folders/… 를 주고 /var 도 /private/var 심링크라 '/tmp/' 로 가드하면 빗나간다.
    //       (그 가드가 이 시험을 macOS 에서만 실패시켰고 하니스는 그것을 「환경 결손」으로 분류했다.)
    const sourceRoot = fixture();
    const quotedSegment = 'quoted "source" \\ path';
    const sourceDir = join(sourceRoot, quotedSegment);
    mkdirSync(sourceDir, { recursive: true });
    const source = join(sourceDir, 'elanous.tgz');
    copyFileSync(packed, source);
    const expectedSource = join(realpathSync(sourceRoot), quotedSegment, 'elanous.tgz');
    const env = setup();
    const installed = run(['--source', source, '--no-modify-path'], env);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    const metadata = JSON.parse(readFileSync(join(env.prefix, 'install.json'), 'utf8')) as Record<string, string>;
    expect(metadata.source).toBe(expectedSource);
    expect(metadata.version).toBe(packageJson.version);
    expect(installed.result.stdout).toContain(`Installed elanous ${metadata.version}`);
  }, 120_000);

  test('normalizes and safely quotes a special-character relative prefix in PATH startup code', () => {
    const env = setup();
    const workdir = fixture();
    const relative = 'relative $prefix `not-run` "quoted"';
    const installed = run(['--prefix', relative], env, process.env.PATH ?? '', workdir);
    expect(installed.result.status).toBe(0);
    const expectedPrefix = realpathSync(resolve(workdir, relative));
    const loaded = spawnSync('/bin/bash', ['--noprofile', '--rcfile', env.startup, '-i', '-c', 'printf %s "$PATH"'], {
      cwd: workdir, encoding: 'utf8', env: { ...process.env, HOME: env.home, PATH: process.env.PATH ?? '' },
    });
    expect(loaded.status).toBe(0);
    expect(loaded.stdout.split(':')[0]).toBe(join(expectedPrefix, 'bin'));
    expect(readFileSync(env.startup, 'utf8')).not.toContain('not-run\n');
  }, 120_000);

  test('install.sh handles spawn-helper and a real isolated install leaves it executable', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('spawn-helper');
    expect(source.indexOf('mv -f "$WRAPPER" "$PREFIX/bin/elanous"')).toBeLessThan(source.indexOf('spawn-helper'));
    expect(source.indexOf('> "$PREFIX/install.json"')).toBeLessThan(source.indexOf('spawn-helper'));
    const env = setup();
    const installed = run(['--no-modify-path'], env);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(installed.result.stdout).toContain('Installed elanous');
    const helper = plantSpawnHelper(env.prefix, 0o666);
    const again = run(['--no-modify-path'], env);
    expect(again.result.status, again.result.stderr).toBe(0);
    expect(again.result.stdout).toContain('Installed elanous');
    expect((statSync(helper).mode & 0o111) !== 0).toBe(process.platform === 'darwin');
  }, 120_000);

  // 결정 2026-09-23 — Phase 3 「사람 손」: 설치가 끝나면 «지금 상태로 계산한» 다음 걸음을 말한다.
  test('ends with next steps in order — new shell → elanous first setup → harness say · no separate login · never a provider-config step (INST1)', () => {
    const env = setup();
    const fresh = run(['--no-modify-path'], env);
    expect(fresh.result.status, fresh.result.stderr).toBe(0);
    const next = fresh.result.stdout.slice(fresh.result.stdout.indexOf('Next:'));
    const shell = next.indexOf('to PATH');
    const firstSetup = next.indexOf('# first-time setup');
    const say = next.indexOf('harness say');
    expect(shell).toBeGreaterThan(-1);
    expect(firstSetup).toBeGreaterThan(shell);
    expect(say).toBeGreaterThan(firstSetup);
    expect(next).not.toContain('elanous login');   // first-time setup signs in
    expect(next).not.toContain('llm.provider');   // auto 는 로그인만 있으면 런타임이 codex 로 고른다(#19950)
  }, 180_000);

  test('Next suggests build tools then node-pty rebuild and ripgrep only when missing on Debian PATH', () => {
    const packed = pack(fixture());
    const env = setup();
    const pathDir = join(env.dir, 'path');
    mkdirSync(pathDir);
    const release = join(env.dir, 'os-release');
    writeFileSync(release, 'ID=debian\nVERSION_ID="12"\n');
    for (const name of ['git', 'bun', 'make', 'c++', 'rg']) {
      const real = spawnSync('/bin/bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
      if (real) writeFileSync(join(pathDir, name), `#!/bin/sh\nexec ${real} "$@"\n`, { mode: 0o755 });
    }
    const extra = { ELANOUS_INSTALL_OS_RELEASE_FILE: release };
    const install = (path: string) => run(['--source', packed, '--no-modify-path'], env, path, repoRoot, extra);
    // Keep system utilities but hide only the three commands under test.
    const missingDir = join(env.dir, 'missing');
    mkdirSync(missingDir);
    for (const name of ['git', 'bun']) copyFileSync(join(pathDir, name), join(missingDir, name));
    // The Debian branch is chosen by `uname -s`; report Linux so this also runs on a Mac.
    writeFileSync(join(missingDir, 'uname'), '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else exec /usr/bin/uname "$@"; fi\n', { mode: 0o755 });
    const hidden = join(env.dir, 'hidden');
    mkdirSync(hidden);
    const systemPath = process.env.PATH ?? '';
    for (const dir of systemPath.split(':')) {
      if (!dir || !existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (['make', 'c++', 'rg'].includes(name)) continue;
        // The first directory on PATH wins; a dangling link already made for an earlier directory reads as absent to existsSync.
        try { symlinkSync(join(dir, name), join(hidden, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
    }
    const missing = install(`${missingDir}:${hidden}`);
    expect(missing.result.status, missing.result.stderr).toBe(0);
    const next = missing.result.stdout.slice(missing.result.stdout.indexOf('Next:'));
    expect(next).toContain('sudo apt-get install -y build-essential');
    expect(next).toContain('elanous doctor --fix --yes');
    expect(next.indexOf('build-essential')).toBeLessThan(next.indexOf('doctor --fix --yes'));
    expect(next).toContain('sudo apt-get install -y ripgrep');
    for (const name of ['make', 'c++', 'rg']) writeFileSync(join(missingDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const present = install(`${missingDir}:${hidden}`);
    expect(present.result.status, present.result.stderr).toBe(0);
    const already = present.result.stdout.slice(present.result.stdout.indexOf('Next:'));
    expect(already).not.toContain('build-essential');
    expect(already).not.toContain('doctor --fix --yes');
    expect(already).not.toContain('install -y ripgrep');
  }, 240_000);

  test('nexus boot banner has no internal phase or PR markers and keeps exit and service help', () => {
    const source = readFileSync(join(repoRoot, 'src/nexus/index.ts'), 'utf8');
    const banner = source.slice(source.indexOf('function printBootBanner('), source.indexOf('const NEXUS_STATUS_HEALTH_TIMEOUT_MS'));
    expect(banner).toContain('Ctrl-C to release lock and exit.');
    expect(banner).toContain('elanous nexus install --launchd');
    expect(banner).toContain('--systemd-user');
    expect(banner).not.toMatch(/Phase N-|PR χ|PR ψ|runtime\.phase/);
  });

  test('non-Darwin skips the spawn-helper step', () => {
    const source = readFileSync(installer, 'utf8');
    const step = source.slice(source.indexOf('if [ "$(uname -s)" = "Darwin" ]'), source.indexOf('if [ "$MODIFY_PATH" -eq 1 ] && ! grep -Fqx "$MARKER_START" "$STARTUP"'));
    expect(step).toContain('chmod +x "$PREFIX"/current/node_modules/node-pty/prebuilds/*/spawn-helper');
    const env = setup();
    const installed = run(['--no-modify-path'], env);
    expect(installed.result.status).toBe(0);
    const helper = plantSpawnHelper(env.prefix, 0o666);
    const again = run(['--no-modify-path'], env);
    expect(again.result.status).toBe(0);
    if (process.platform !== 'darwin') expect((statSync(helper).mode & 0o111) !== 0).toBe(false);
  }, 120_000);

  test('a forced chmod failure still yields rc=0 and the Installed elanous line', () => {
    const env = setup();
    const failing = join(env.dir, 'failing-chmod');
    writeFileSync(failing, '#!/bin/sh\nexit 1\n');
    chmodSync(failing, 0o755);
    const installed = run(['--no-modify-path'], env, process.env.PATH ?? '', repoRoot, { ELANOUS_INSTALL_SPAWN_HELPER_CHMOD: failing });
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(installed.result.stdout).toContain('Installed elanous');
  }, 120_000);

  test('--source omits commit while keeping version, source, installedAt, and the Installed elanous line', () => {
    const packed = pack(fixture());
    const env = setup();
    const installed = run(['--source', packed, '--no-modify-path'], env);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(installed.result.stdout).toContain('Installed elanous');
    const metadata = JSON.parse(readFileSync(join(env.prefix, 'install.json'), 'utf8')) as Record<string, string>;
    expect(Object.prototype.hasOwnProperty.call(metadata, 'commit')).toBe(false);
    expect(metadata.version).toBe(packageJson.version);
    expect(metadata.source).toBe(realpathSync(packed));
    expect(metadata.installedAt).toBeTruthy();
    expect(JSON.stringify(metadata)).not.toContain('unknown');
  }, 120_000);

  test('a checkout install writes repo HEAD as commit', () => {
    const env = setup();
    const installed = run(['--no-modify-path'], env);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    expect(head.status).toBe(0);
    const metadata = JSON.parse(readFileSync(join(env.prefix, 'install.json'), 'utf8')) as Record<string, string>;
    expect(metadata.commit).toBe(head.stdout.trim());
    expect(metadata.version).toBe(packageJson.version);
    expect(metadata.source).toBe(realpathSync(repoRoot));
    expect(metadata.installedAt).toBeTruthy();
  }, 120_000);

  test('a failed git rev-parse leaves commit empty and the install alive', () => {
    const env = setup();
    const stubPath = join(env.dir, 'path');
    mkdirSync(stubPath);
    const git = join(stubPath, 'git');
    writeFileSync(git, '#!/bin/sh\nexit 1\n');
    chmodSync(git, 0o755);
    const installed = run(['--no-modify-path'], env, `${stubPath}:${process.env.PATH ?? ''}`);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(installed.result.stdout).toContain('Installed elanous');
    const metadata = JSON.parse(readFileSync(join(env.prefix, 'install.json'), 'utf8')) as Record<string, string>;
    expect(Object.prototype.hasOwnProperty.call(metadata, 'commit')).toBe(false);
    expect(metadata.version).toBe(packageJson.version);
    expect(metadata.source).toBe(realpathSync(repoRoot));
    expect(metadata.installedAt).toBeTruthy();
  }, 120_000);

  test('missing node-pty still yields rc=0', () => {
    const env = setup();
    const installed = run(['--no-modify-path'], env);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(installed.result.stdout).toContain('Installed elanous');
    const helper = spawnHelper(env.prefix);
    if (existsSync(helper)) rmSync(helper);
    const again = run(['--no-modify-path'], env);
    expect(again.result.status, again.result.stderr).toBe(0);
    expect(again.result.stdout).toContain('Installed elanous');
  }, 120_000);

  // 🆕 2026-09-24 — claude·grok 네이티브 설치기와 같은 모양: versions/<v> · current · bin/elanous
  test('installs into versions/<version> behind a current symlink, and a second version keeps the first for rollback', () => {
    const env = setup();
    const first = run(['--no-modify-path'], env);
    expect(first.result.status, first.result.stderr).toBe(0);
    const prefix = realpathSync(env.prefix);
    const firstDir = checkoutVersionName();
    expect(readlinkSync(join(prefix, 'current'))).toBe(`versions/${firstDir}`);
    const elanous = join(prefix, 'bin', 'elanous');
    expect(lstatSync(elanous).isFile()).toBe(true);
    expect(readFileSync(elanous, 'utf8')).toContain(join(prefix, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs'));
    expect(existsSync(join(prefix, 'versions', firstDir, 'node_modules', 'elanous', 'package.json'))).toBe(true);
    // 둘째 버전: 같은 소스를 다른 버전 번호로 다시 싸서 깐다
    const work = fixture();
    const unpacked = join(work, 'pkg');
    mkdirSync(unpacked);
    const tgz = pack(work);
    expect(spawnSync('tar', ['-xzf', tgz, '-C', unpacked]).status).toBe(0);
    const pkgFile = join(unpacked, 'package', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, unknown>;
    pkg.version = `${packageJson.version}+rollbacktest`;
    writeFileSync(pkgFile, JSON.stringify(pkg));
    const second = join(work, 'second.tgz');
    expect(spawnSync('tar', ['-czf', second, '-C', unpacked, 'package']).status).toBe(0);
    const upgraded = run(['--no-modify-path', '--source', second], env);
    expect(upgraded.result.status, upgraded.result.stderr).toBe(0);
    expect(readlinkSync(join(prefix, 'current'))).toBe(`versions/${packageJson.version}+rollbacktest`);
    const switched = spawnSync(elanous, ['--version'], { encoding: 'utf8', env: { HOME: env.home, PATH: '/usr/bin:/bin' } });
    expect(switched.status, switched.stderr).toBe(0);
    expect(switched.stdout).toContain(`${packageJson.version}+rollbacktest`);
    expect(existsSync(join(prefix, 'versions', firstDir, 'node_modules', 'elanous'))).toBe(true);   // 옛 버전은 남는다
  }, 240_000);

  // 🆕 2026-09-24 (RFC 설치본 전환 0a) — 체크아웃 설치는 package.json 버전이 늘 같다.
  //   종전엔 두 커밋의 설치가 같은 versions/<version> 을 덮어 롤백이 안 됐다.
  test('checkout installs from two commits land in two folders, and install.json names commit and folder', () => {
    const env = setup();
    const shaA = 'a'.repeat(40);
    const shaB = 'b'.repeat(40);
    const first = run(['--no-modify-path'], env, `${stubGit(env.dir, 'a', shaA)}:${process.env.PATH ?? ''}`);
    expect(first.result.status, first.result.stderr).toBe(0);
    const second = run(['--no-modify-path'], env, `${stubGit(env.dir, 'b', shaB)}:${process.env.PATH ?? ''}`);
    expect(second.result.status, second.result.stderr).toBe(0);
    const prefix = realpathSync(env.prefix);
    const dirA = `${packageJson.version}-${shaA.slice(0, 12)}`;
    const dirB = `${packageJson.version}-${shaB.slice(0, 12)}`;
    expect(readlinkSync(join(prefix, 'current'))).toBe(`versions/${dirB}`);
    expect(existsSync(join(prefix, 'versions', dirA, 'node_modules', 'elanous', 'package.json'))).toBe(true);   // 앞 판이 남는다
    const metadata = JSON.parse(readFileSync(join(prefix, 'install.json'), 'utf8')) as Record<string, string>;
    expect(metadata.commit).toBe(shaB);
    expect(metadata.versionDir).toBe(`versions/${dirB}`);
  }, 240_000);

  test('a checkout with modified tracked files is marked -dirty so it never poses as the clean commit', () => {
    const env = setup();
    const sha = 'c'.repeat(40);
    const installed = run(['--no-modify-path'], env, `${stubGit(env.dir, 'c', sha, ' M src/x.ts')}:${process.env.PATH ?? ''}`);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(readlinkSync(join(realpathSync(env.prefix), 'current'))).toBe(`versions/${packageJson.version}-${sha.slice(0, 12)}-dirty`);
  }, 120_000);

  test('--source URL downloads the tarball and records the URL as source', () => {
    const env = setup();
    const served = fixture();
    const tgz = pack(served);
    const server = Bun.spawn(['python3', '-m', 'http.server', '0', '--bind', '127.0.0.1', '--directory', served], { stdout: 'pipe', stderr: 'pipe' });
    try {
      const port = (() => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const probe = spawnSync('lsof', ['-a', '-p', String(server.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
          const m = probe.stdout.match(/:(\d+)\s*$/m);
          if (m) return m[1];
          spawnSync('sleep', ['0.2']);
        }
        throw new Error('http.server did not listen');
      })();
      const url = `http://127.0.0.1:${port}/${basename(tgz)}`;
      const installed = run(['--no-modify-path', '--source', url], env);
      expect(installed.result.status, installed.result.stderr).toBe(0);
      const metadata = JSON.parse(readFileSync(join(env.prefix, 'install.json'), 'utf8')) as Record<string, string>;
      expect(metadata.source).toBe(url);
      expect(metadata.commit).toBeUndefined();
    } finally {
      server.kill();
    }
  }, 240_000);

  function standalone(release: string, extra: Record<string, string> = {}) {
    const lonely = fixture();
    const copied = join(lonely, 'install.sh');
    copyFileSync(installer, copied);
    const env = setup();
    const result = spawnSync('/bin/bash', [copied, '--no-modify-path'], {
      cwd: lonely, encoding: 'utf8',
      env: { ...process.env, HOME: env.home, ELANOUS_INSTALL_PREFIX: env.prefix, ELANOUS_SHELL_STARTUP: env.startup, ELANOUS_INSTALL_SOURCE: '', ELANOUS_RELEASE_BASE: `file://${release}`, ELANOUS_VERSION: '', ...extra },
    });
    return { ...env, result };
  }

  test('standalone installer verifies and installs the latest file:// release with URL metadata', () => {
    const release = fixture();
    const assets = join(release, 'latest', 'download');
    mkdirSync(assets, { recursive: true });
    const tarball = join(assets, 'elanous.tgz');
    copyFileSync(pack(fixture()), tarball);
    const hash = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    writeFileSync(join(assets, 'SHA256SUMS'), `${hash}  elanous.tgz\n`);
    const installed = standalone(release);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(installed.prefix, 'install.json'), 'utf8')).source).toBe(`file://${release}/latest/download/elanous.tgz`);
    expect(readlinkSync(join(installed.prefix, 'current'))).toBe(`versions/${packageJson.version}`);
  }, 120_000);

  test('standalone installer rejects a checksum mismatch before creating current and reports both hashes', () => {
    const release = fixture();
    const assets = join(release, 'latest', 'download');
    mkdirSync(assets, { recursive: true });
    const tarball = join(assets, 'elanous.tgz');
    copyFileSync(pack(fixture()), tarball);
    const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    const expected = `${actual[0] === 'a' ? 'b' : 'a'}${actual.slice(1)}`;
    writeFileSync(join(assets, 'SHA256SUMS'), `${expected}  elanous.tgz\n`);
    const installed = standalone(release);
    expect(installed.result.status).toBe(1);
    expect(existsSync(join(installed.prefix, 'current'))).toBe(false);
    expect(installed.result.stderr).toContain(expected);
    expect(installed.result.stderr).toContain(actual);
  }, 120_000);

  test('standalone versioned release download failure names the attempted tarball URL', () => {
    const release = fixture();
    const installed = standalone(release, { ELANOUS_VERSION: '9.9.9' });
    expect(installed.result.status).not.toBe(0);
    expect(installed.result.stderr).toContain(`file://${release}/download/v9.9.9/elanous.tgz`);
  });

  test('default prefix is the XDG data dir, not the ~/.elanous state dir', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('PREFIX="${ELANOUS_INSTALL_PREFIX:-${XDG_DATA_HOME:-${HOME:?HOME is required}/.local/share}/elanous}"');
    expect(source).not.toMatch(/PREFIX="\$\{ELANOUS_INSTALL_PREFIX:-\$\{HOME[^}]*\}\/\.elanous\}"/);
  });
});

// Runtime caller/wiring: each test invokes scripts/install.sh via run() -> spawnSync('/bin/bash', [installer, ...args]).

// 🆕 2026-09-24 — 비대화 셸에서 표준 위치의 bun 을 재사용한다(빈 VM 에서 bun 을 두 번 깔던 것).
test('reuses bun from ${BUN_INSTALL}/bin when bun is not on PATH', () => {
  const home = mkdtempSync(join(tmpdir(), 'elanous-install-bunreuse-'));
  try {
    const bunDir = join(home, '.bun', 'bin');
    mkdirSync(bunDir, { recursive: true });
    writeFileSync(join(bunDir, 'bun'), '#!/bin/sh\necho REUSED-BUN "$@" >&2\nexit 42\n');
    chmodSync(join(bunDir, 'bun'), 0o755);
    const stub = join(home, 'path'); mkdirSync(stub);
    for (const c of ['git', 'dirname', 'mkdir', 'mktemp', 'find', 'tar', 'rm', 'cp', 'ln', 'chmod', 'cat', 'uname', 'grep', 'sed', 'head', 'tr']) {
      const real = spawnSync('/bin/sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();
      if (real) spawnSync('/bin/ln', ['-s', real, join(stub, c)]);
    }
    const r = spawnSync('/bin/bash', [installer, '--no-modify-path', '--no-bootstrap-bun', '--prefix', join(home, 'prefix')], {
      cwd: repoRoot, encoding: 'utf8', env: { HOME: home, PATH: stub, BUN_INSTALL: join(home, '.bun') },
    });
    expect(`${r.stdout}${r.stderr}`).toContain('REUSED-BUN');
    expect(`${r.stdout}${r.stderr}`).not.toContain('installing bun');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

describe('INST2 — finish in the same window', () => {
  function fakeSetup(dir: string): { exec: string; record: string } {
    const record = join(dir, 'setup-called');
    const exec = join(dir, 'fake-setup');
    writeFileSync(exec, `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`, { mode: 0o755 });
    return { exec, record };
  }

  test('interactive: starts first-time setup with the absolute wrapper after the Next list', () => {
    const env = setup();
    const { exec, record } = fakeSetup(env.dir);
    const { prefix, result } = run(['--no-modify-path'], env, process.env.PATH ?? '', repoRoot, { ELANOUS_INSTALL_INTERACTIVE: '1', ELANOUS_INSTALL_SETUP_EXEC: exec, CI: '' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Starting first-time setup');
    expect(result.stdout).not.toContain('Run: ');
    expect(readFileSync(record, 'utf8').trim()).toBe(join(realpathSync(prefix), 'bin', 'elanous'));
  }, 180_000);

  test('INST3: inside a real terminal the wizard gets the terminal device itself, not a fresh /dev/tty', () => {
    const env = setup();
    const record = join(env.dir, 'setup-tty');
    const exec = join(env.dir, 'fake-setup-tty');
    writeFileSync(exec, `#!/bin/sh\nprintf '%s' "$ELANOUS_INSTALL_SETUP_TTY" > '${record}'\n`, { mode: 0o755 });
    const command = ['/bin/bash', installer, '--no-modify-path'];
    const argv = process.platform === 'darwin' ? ['-q', '/dev/null', ...command] : ['-qec', command.join(' '), '/dev/null'];
    const result = spawnSync('script', argv, {
      cwd: repoRoot, encoding: 'utf8',
      env: { ...process.env, HOME: env.home, XDG_CONFIG_HOME: join(env.home, '.config'), XDG_CACHE_HOME: join(env.home, '.cache'), ELANOUS_INSTALL_PREFIX: env.prefix, ELANOUS_SHELL_STARTUP: env.startup, ELANOUS_INSTALL_INTERACTIVE: '1', ELANOUS_INSTALL_SETUP_EXEC: exec, ELANOUS_INSTALL_LANG: 'en', CI: '' },
    });
    expect(result.status, result.stderr).toBe(0);
    const tty = readFileSync(record, 'utf8');
    expect(tty).toMatch(/^\/dev\/(ttys?\d+|pts\/\d+)$/);
    expect(tty).not.toBe('/dev/tty');
  }, 180_000);

  test('INST3: without a terminal the wizard falls back to /dev/tty', () => {
    const env = setup();
    const record = join(env.dir, 'setup-tty');
    const exec = join(env.dir, 'fake-setup-tty');
    writeFileSync(exec, `#!/bin/sh\nprintf '%s' "$ELANOUS_INSTALL_SETUP_TTY" > '${record}'\n`, { mode: 0o755 });
    const { result } = run(['--no-modify-path'], env, process.env.PATH ?? '', repoRoot, { ELANOUS_INSTALL_INTERACTIVE: '1', ELANOUS_INSTALL_SETUP_EXEC: exec, CI: '' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(record, 'utf8')).toBe('/dev/tty');
  }, 180_000);

  test('INST4: same-window setup drops the «new shell» step (numbering starts at 1) and Korean has no English lines of ours', () => {
    const env = setup();
    const { exec } = fakeSetup(env.dir);
    const { result } = run([], env, process.env.PATH ?? '', repoRoot, { ELANOUS_INSTALL_INTERACTIVE: '1', ELANOUS_INSTALL_SETUP_EXEC: exec, CI: '', ELANOUS_INSTALL_LANG: 'ko' });
    expect(result.status, result.stderr).toBe(0);
    const next = result.stdout.slice(result.stdout.indexOf('다음:'), result.stdout.indexOf('첫 설정을 시작합니다'));
    expect(next).not.toContain('새 셸을 여세요');
    expect(next).toMatch(/\n {2}1\) /);
    expect(next).not.toMatch(/install gh|install Node|the harness|rebuild node-pty|install ripgrep/);
    expect(result.stderr).not.toContain('harness command missing');
  }, 180_000);

  test('non-interactive: never starts setup and the first Next line is the absolute Run command', () => {
    const env = setup();
    const { exec, record } = fakeSetup(env.dir);
    const { prefix, result } = run(['--no-modify-path'], env, process.env.PATH ?? '', repoRoot, { ELANOUS_INSTALL_INTERACTIVE: '0', ELANOUS_INSTALL_SETUP_EXEC: exec });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(record)).toBe(false);
    const next = result.stdout.slice(result.stdout.indexOf('Next:')).split('\n');
    expect(next.find((line) => line.includes('Run: '))).toContain(`Run: ${join(realpathSync(prefix), 'bin', 'elanous')}`);
    expect(result.stdout).not.toContain('Starting first-time setup');
  }, 180_000);

  test('--no-setup: an interactive terminal still does not start setup', () => {
    const env = setup();
    const { exec, record } = fakeSetup(env.dir);
    const { result } = run(['--no-modify-path', '--no-setup'], env, process.env.PATH ?? '', repoRoot, { ELANOUS_INSTALL_INTERACTIVE: '1', ELANOUS_INSTALL_SETUP_EXEC: exec, CI: '' });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(record)).toBe(false);
    expect(result.stdout).not.toContain('Starting first-time setup');
  }, 180_000);

  test('the registry fallback keeps bun noise («Blocked N postinstalls») off the screen when it succeeds', () => {
    const env = setup();
    const realBun = spawnSync('/bin/bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout.trim();
    const shim = join(env.dir, 'shim');
    mkdirSync(shim);
    // offline add fails (cache miss) · registry add prints the noise and then really installs.
    writeFileSync(join(shim, 'bun'), `#!/bin/sh\ncase "$*" in\n  *"add --no-save --offline"*) exit 1 ;;\n  *"add --no-save"*) echo "Blocked 3 postinstalls. Run \\\`bun pm untrusted\\\` for details."; exec '${realBun}' "$@" --offline ;;\nesac\nexec '${realBun}' "$@"\n`, { mode: 0o755 });
    const { result } = run(['--no-modify-path', '--no-setup'], env, `${shim}:${process.env.PATH ?? ''}`, repoRoot, { ELANOUS_INSTALL_INTERACTIVE: '0' });
    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('fetching them from the npm registry');
    expect(`${result.stdout}${result.stderr}`).not.toContain('Blocked 3 postinstalls');
  }, 180_000);
});

describe('INST1 — one language · no silent downgrade · ask before updating', () => {
  function plantInstalled(prefix: string, version: string): void {
    mkdirSync(prefix, { recursive: true });
    writeFileSync(join(prefix, 'install.json'), JSON.stringify({ version, versionDir: `versions/${version}`, source: 'test', installedAt: '2026-10-01T00:00:00Z' }));
  }

  test('an older package than the installed one changes nothing and says how to go back on purpose', () => {
    const env = setup();
    plantInstalled(env.prefix, '99.0.0');
    const { result } = run(['--no-modify-path', '--no-setup'], env);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('--allow-downgrade');
    expect(existsSync(join(env.prefix, 'current'))).toBe(false);
    expect(existsSync(join(env.prefix, 'bin', 'elanous'))).toBe(false);
  }, 180_000);

  test('--allow-downgrade installs the older package', () => {
    const env = setup();
    plantInstalled(env.prefix, '99.0.0');
    const { result } = run(['--no-modify-path', '--no-setup', '--allow-downgrade'], env);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(env.prefix, 'bin', 'elanous'))).toBe(true);
  }, 180_000);

  test('an interactive re-run asks before updating — «n» leaves the installation as it is', () => {
    const env = setup();
    plantInstalled(env.prefix, '0.0.1');
    const { result } = run(['--no-modify-path', '--no-setup'], env, process.env.PATH ?? '', repoRoot, { ELANOUS_INSTALL_INTERACTIVE: '1', ELANOUS_INSTALL_ANSWER: 'n', CI: '' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Update to');
    expect(result.stdout).toContain('Left elanous 0.0.1 as it is.');
    expect(existsSync(join(env.prefix, 'bin', 'elanous'))).toBe(false);
  }, 180_000);

  test('a Korean locale gets the whole normal path in Korean (polite form), English otherwise', () => {
    const env = setup();
    const ko = run(['--no-modify-path', '--no-setup'], env, process.env.PATH ?? '', repoRoot, { ELANOUS_INSTALL_LANG: 'ko' });
    expect(ko.result.status, ko.result.stderr).toBe(0);
    expect(ko.result.stdout).toContain('설치했습니다');
    expect(ko.result.stdout).toContain('다음:');
    expect(ko.result.stdout).toContain('첫 설정');
    expect(ko.result.stdout).not.toContain('Next:');
    expect(ko.result.stdout).not.toMatch(/쓰십시오|않았다 —/);
  }, 180_000);
});
