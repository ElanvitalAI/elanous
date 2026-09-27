import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

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

function run(args: string[], env: ReturnType<typeof setup> = setup(), path = process.env.PATH ?? '', cwd = repoRoot, extra: Record<string, string> = {}) {
  const result = spawnSync('/bin/bash', [installer, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: env.home, XDG_CONFIG_HOME: join(env.home, '.config'), XDG_CACHE_HOME: join(env.home, '.cache'), ELANOUS_INSTALL_PREFIX: env.prefix, ELANOUS_SHELL_STARTUP: env.startup, PATH: path, ...extra },
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
    expect(packageJson.bin).toEqual({ elanous: './bin/elanous.mjs', eln: './bin/elanous.mjs' });
  });

  test('--help names every supported argument', () => {
    const { result } = run(['--help']);
    expect(result.status).toBe(0);
    for (const argument of ['--prefix', '--source', '--no-modify-path', '--no-bootstrap-bun', '--help']) expect(result.stdout).toContain(argument);
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
    expect(missing.stderr).toBe(`bun 을 찾을 수 없습니다: ${unavailable} — 설치기를 다시 실행하세요\n`);
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
  test('ends with state-aware next steps — login only when not logged in, never a provider-config step', () => {
    const env = setup();
    const fresh = run(['--no-modify-path'], env);
    expect(fresh.result.status, fresh.result.stderr).toBe(0);
    const next = fresh.result.stdout.slice(fresh.result.stdout.indexOf('Next:'));
    expect(next).toContain('elanous login openai-codex');
    expect(next).toContain('eln harness say');
    expect(next).toContain('elanous harness say');
    expect(next).not.toContain('llm.provider');   // auto 는 로그인만 있으면 런타임이 codex 로 고른다(#19950)
    mkdirSync(join(env.home, '.elanous'), { recursive: true });
    writeFileSync(join(env.home, '.elanous', 'auth.json'), JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: {} } } }));
    const again = run(['--no-modify-path'], env);
    expect(again.result.status, again.result.stderr).toBe(0);
    expect(again.result.stdout.slice(again.result.stdout.indexOf('Next:'))).not.toContain('elanous login');
  }, 180_000);

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
    pkg.version = `${packageJson.version}-rollbacktest`;
    writeFileSync(pkgFile, JSON.stringify(pkg));
    const second = join(work, 'second.tgz');
    expect(spawnSync('tar', ['-czf', second, '-C', unpacked, 'package']).status).toBe(0);
    const upgraded = run(['--no-modify-path', '--source', second], env);
    expect(upgraded.result.status, upgraded.result.stderr).toBe(0);
    expect(readlinkSync(join(prefix, 'current'))).toBe(`versions/${packageJson.version}-rollbacktest`);
    const switched = spawnSync(elanous, ['--version'], { encoding: 'utf8', env: { HOME: env.home, PATH: '/usr/bin:/bin' } });
    expect(switched.status, switched.stderr).toBe(0);
    expect(switched.stdout).toContain(`${packageJson.version}-rollbacktest`);
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
