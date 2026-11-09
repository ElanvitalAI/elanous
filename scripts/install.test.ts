import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, symlinkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setDefaultTimeout, afterEach, describe, expect, test as bunTest } from 'bun:test';
import { isUnprivilegedGitRepairOnlyFailure } from './install-doctor-result';
import { INSTALL_DETERMINISTIC_SMOKE_TESTS, shouldRunInstallTest } from './lib/install-test-tier.js';
import { runReleaseInstaller, type Runner } from '../src/cli/release-cli.js';
import { createFakeBins } from '../src/ux-sim/fake-bin.js';
import { simCli } from '../src/ux-sim/in-process-cli.js';
import { packageFixture as createPackageFixture, packageVersionFromSource } from './lib/install-test-package.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);
const registeredInstallTestNames = new Set<string>();

const test = (name: string, fn: () => void | Promise<void>, timeout?: number): void => {
  registeredInstallTestNames.add(name);
  const tier = process.env.ELANOUS_INSTALL_TEST_TIER === 'deterministic' ? 'deterministic' : 'nightly';
  if (shouldRunInstallTest(name, tier)) bunTest(name, fn, timeout);
  else bunTest.skip(name, fn, timeout);
};

const repoRoot = resolve(import.meta.dir, '..');
const installer = resolve(import.meta.dir, 'install.sh');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string; bin: Record<string, string> };
const fixtures: string[] = [];

function packageFixture(destination: string, version = packageJson.version): string {
  return createPackageFixture(destination, version);
}

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

function checkoutVersionName(path: string): string {
  const env = { ...process.env, PATH: path };
  const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', env }).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) return packageJson.version;
  const dirty = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', env }).stdout.trim();
  return `${packageJson.version}-${head.slice(0, 12)}${dirty ? '-dirty' : ''}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fakeBunBin(dir: string, archive: string, installDir: string, options: { relativeExecPath?: boolean } = {}) {
  const binDir = join(dir, 'fake-bun-bin');
  mkdirSync(binDir, { recursive: true });
  const calls = join(dir, 'fake-bun-calls');
  const envCalls = join(dir, 'fake-bun-env-calls');
  writeFileSync(calls, '');
  writeFileSync(envCalls, '');
  const realBun = process.execPath;
  const fakeBins = createFakeBins({
    bunAddContract: {
      whenArgsStartWith: ['add', '--no-save', '--ignore-scripts'],
      otherwise: realBun,
    },
  });
  fixtures.push(resolve(fakeBins.dir, '..'));
  const bin = join(binDir, 'bun');
  writeFileSync(bin, [
    '#!/bin/sh',
    `{ printf '%s\\0' "$PWD" "$@"; printf '\\036'; } >> '${calls}'`,
    `{ printf '%s\\0' "${'${TMPDIR:-}'}"; } >> '${envCalls}'`,
    'case "$1 $2" in',
    '  "pm pack")',
    '    [ "$3" = "--destination" ] && [ -d "$4" ] || exit 64',
    '    package_archive="${ELANOUS_INSTALL_TEST_PACKAGE_TGZ:-}"',
    `    [ -n "$package_archive" ] || package_archive=${shellQuote(archive)}`,
    '    command -p cp "$package_archive" "$4/package.tgz"',
    '    exit $? ;;',
    '  "add --no-save")',
    '    [ "$3" = "--ignore-scripts" ] || exit 64',
    '    case "$4" in --offline) [ "$#" -eq 5 ] || exit 64; package="$5" ;; *) [ "$#" -eq 4 ] || exit 64; package="$4" ;; esac',
    '    [ "$PWD" = "$ELANOUS_INSTALL_TEST_EXPECTED_CWD" ] || exit 65',
    '    case "$PWD" in "$ELANOUS_INSTALL_PREFIX"/versions/*) ;; *) exit 65 ;; esac',
    '    [ -f "$package" ] || exit 66',
    `    ${shellQuote(fakeBins.bin('bunAddContract'))} "$@" || exit $?`,
    '    command -p rm -rf "$PWD/node_modules/elanous"',
    '    command -p mkdir -p "$PWD/node_modules" || exit 67',
    '    command -p tar -xzf "$package" -C "$PWD/node_modules" || exit 67',
    '    [ -f "$PWD/node_modules/package/package.json" ] || exit 68',
    '    command -p mv "$PWD/node_modules/package" "$PWD/node_modules/elanous" || exit 69',
    '    exit 0 ;;',
    'esac',
    ...(options.relativeExecPath ? [
      'if [ "$1" = "-e" ] && [ "$2" = "process.stdout.write(process.execPath)" ]; then printf relative-bun; exit 0; fi',
    ] : []),
    `exec '${realBun}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { bin: binDir, calls, envCalls, fakeBins, cleanup: fakeBins.cleanup };
}

function parsedFakeBunCalls(file: string): string[][] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\x1e').slice(0, -1).map((line) => line.split('\0').slice(0, -1));
}

function realBunFromPath(path: string): string | undefined {
  for (const dir of path.split(':').filter(Boolean)) {
    const candidate = join(dir, 'bun');
    if (!existsSync(candidate)) continue;
    // 출처: .rules/30-harness/testing-gates.md — Accept the Bun executable only when its resolved path is this runtime.
    try { if (realpathSync(candidate) === process.execPath) return process.execPath; } catch { /* stale PATH entry */ }
  }
  return undefined;
}

/** The host PATH minus any directory that already holds an `eln` — the installer (rightly) refuses to create its own
 *  `eln` when another one is on PATH, so a developer machine with elanous installed would otherwise fail these tests. */
function hostPathWithoutEln(path = process.env.PATH ?? ''): string {
  // bun often lives next to an `eln` (`~/.bun/bin`), so dropping that directory would drop bun too — keep bun through a
  // private shim directory that holds only a link to the running bun.
  const shim = mkdtempSync(join(tmpdir(), 'elanous-install-bun-'));
  symlinkSync(process.execPath, join(shim, 'bun'));
  return [shim, ...path.split(':').filter((dir) => dir && !existsSync(join(dir, 'eln')))].join(':');
}

function pathWithoutCommand(command: string, path = hostPathWithoutEln()): string {
  const filteredDirs = path.split(':').filter(Boolean).map((dir) => {
    if (!existsSync(join(dir, command))) return dir;
    const filtered = mkdtempSync(join(tmpdir(), `elanous-path-without-${command}-`));
    fixtures.push(filtered);
    for (const name of readdirSync(dir)) {
      if (name === command) continue;
      try { symlinkSync(join(dir, name), join(filtered, name)); } catch { /* first path entry wins */ }
    }
    return filtered;
  });
  return filteredDirs.join(':');
}

function pathWithoutCommands(commands: string[], path = hostPathWithoutEln()): string {
  return commands.reduce((current, command) => pathWithoutCommand(command, current), path);
}

function expectCommandsMissing(commands: string[], path: string): void {
  for (const command of commands) {
    const lookup = spawnSync('/bin/bash', ['-c', 'command -v "$1" >/dev/null 2>&1', '--', command], {
      encoding: 'utf8', env: { ...process.env, PATH: path },
    });
    expect(lookup.status, `${command} unexpectedly remains available in the filtered PATH`).not.toBe(0);
  }
}

function isolatedDoctorBin(env: ReturnType<typeof setup>): string {
  const bin = join(env.dir, 'doctor-test-bin');
  mkdirSync(bin, { recursive: true });
  if (!existsSync(join(bin, 'git'))) symlinkSync('/usr/bin/git', join(bin, 'git'));
  if (!existsSync(join(bin, 'bun'))) symlinkSync(process.execPath, join(bin, 'bun'));
  for (const [name, output] of [['gh', 'gh version 2.0.0'], ['rg', 'ripgrep 14.0.0'], ['codex', 'codex 1.0.0']] as const) {
    const path = join(bin, name);
    if (existsSync(path)) continue;
    writeFileSync(path, `#!/bin/sh\nif [ "$1" = auth ] && [ "$2" = status ]; then exit 1; fi\necho '${output}'\n`, { mode: 0o755 });
  }
  return bin;
}

function run(args: string[], env: ReturnType<typeof setup> = setup(), path = hostPathWithoutEln(), cwd = repoRoot, extra: Record<string, string> = {}, shellCommand?: string) {
  // Existing installer behavior tests consent to the install explicitly; refusal is covered separately.
  const refusingConsent = extra.ELANOUS_INSTALL_ANSWER?.toLowerCase() === 'n';
  const effectiveArgs = args.includes('--help') || refusingConsent ? args : ['--yes', ...args];
  const doctorBin = isolatedDoctorBin(env);
  const testRealInstaller = extra.ELANOUS_INSTALL_TEST_REAL === '1';
  const testCustomBun = extra.ELANOUS_INSTALL_TEST_CUSTOM_BUN === '1';
  const runtimeExtra = { ...extra };
  delete runtimeExtra.ELANOUS_INSTALL_TEST_REAL;
  delete runtimeExtra.ELANOUS_INSTALL_TEST_CUSTOM_BUN;
  const source = args.includes('--source') ? args[args.indexOf('--source') + 1] : undefined;
  const version = packageVersionFromSource(source, packageJson.version);
  const fakeMode = shellCommand === undefined && !testRealInstaller && !refusingConsent && !args.includes('--help')
    && (testCustomBun || realBunFromPath(path) !== undefined);
  let versionDir: string | undefined;
  let installPrefix: string | undefined;
  let installDir: string | undefined;
  let packageArchive: string | undefined;
  let bunShim: ReturnType<typeof fakeBunBin> | undefined;
  if (fakeMode) {
    versionDir = source ? version : checkoutVersionName(path);
    const prefixArg = args.indexOf('--prefix');
    installPrefix = prefixArg >= 0 ? resolve(cwd, args[prefixArg + 1] ?? env.prefix) : env.prefix;
    installDir = join(installPrefix, 'versions', versionDir);
    packageArchive = runtimeExtra.ELANOUS_INSTALL_TEST_PACKAGE_TGZ ?? packageFixture(fixture(), version);
    runtimeExtra.ELANOUS_INSTALL_TEST_EXPECTED_CWD = installDir;
    if (!testCustomBun) {
      bunShim = fakeBunBin(env.dir, packageArchive, installDir);
      path = `${bunShim.bin}:${path}`;
    } else {
      runtimeExtra.ELANOUS_INSTALL_TEST_PACKAGE_TGZ = packageArchive;
    }
  }
  const result = spawnSync('/bin/bash', shellCommand === undefined ? [installer, ...effectiveArgs] : ['-c', shellCommand], {
    cwd,
    encoding: 'utf8',
    // BUN_INSTALL points at the isolated home: install.sh prepends `${BUN_INSTALL}/bin`, and the host's (~/.bun) may hold an eln.
    // The package cache stays the host's — the offline install path depends on it.
    env: { ...process.env, HOME: env.home, XDG_CONFIG_HOME: join(env.home, '.config'), XDG_CACHE_HOME: join(env.home, '.cache'), BUN_INSTALL: join(env.home, '.bun'), BUN_INSTALL_CACHE_DIR: hostBunCache, ELANOUS_INSTALL_PREFIX: installPrefix ?? env.prefix, ELANOUS_SHELL_STARTUP: env.startup, PATH: path, ELANOUS_INSTALL_LANG: 'en', ...runtimeExtra, NODE_ENV: 'test', ELANOUS_TEST_BIN_PATH_CANDIDATES: doctorBin },
  });
  const fakeBunCalls = bunShim ? parsedFakeBunCalls(bunShim.calls) : [];
  const fakeBunEnvCalls = bunShim && existsSync(bunShim.envCalls)
    ? readFileSync(bunShim.envCalls, 'utf8').split('\0').filter(Boolean)
    : [];
  const fakeBinCalls = bunShim?.fakeBins.calls() ?? [];
  if (bunShim && result.status === 0 && !args.includes('--help')) {
    const addCall = fakeBunCalls.find((call) => call[1] === 'add');
    const contractCall = fakeBinCalls.find((call) => call.name === 'bunAddContract');
    expect(addCall).toBeDefined();
    expect(addCall?.[0]).toBe(installDir!);
    expect(addCall?.slice(1, 4)).toEqual(['add', '--no-save', '--ignore-scripts']);
    expect(contractCall?.argv).toEqual(addCall?.slice(1));
    expect(existsSync(join(installDir!, 'node_modules', 'elanous', 'package.json'))).toBe(true);
    expect(readlinkSync(join(installPrefix!, 'current'))).toBe(`versions/${versionDir}`);
    expect(readFileSync(join(installPrefix!, 'bin', 'elanous'), 'utf8')).toContain(join(installPrefix!, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs'));
  }
  bunShim?.cleanup();
  return { ...env, result, fakeBunCalls, fakeBunEnvCalls, fakeBinCalls };
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
function pack(destination: string): string {
  return packageFixture(destination);
}

function packReal(destination: string): string {
  const packed = spawnSync('bun', ['pm', 'pack', '--destination', destination], { cwd: repoRoot, encoding: 'utf8' });
  expect(packed.status).toBe(0);
  return join(destination, readdirSync(destination).find(file => file.endsWith('.tgz'))!);
}

describe('scripts/install.sh', () => {
  test('fake bun add refuses a wrong working directory before recording or installing the package', () => {
    const env = setup();
    const versionDir = packageJson.version;
    const installDir = join(env.prefix, 'versions', versionDir);
    const archive = packageFixture(fixture(), versionDir);
    const bunShim = fakeBunBin(env.dir, archive, installDir);
    const wrongCwd = fixture();
    const command = [join(bunShim.bin, 'bun'), 'add', '--no-save', '--ignore-scripts', '--offline', archive].map(shellQuote).join(' ');
    const result = run([], env, process.env.PATH ?? '', wrongCwd,
      { ELANOUS_INSTALL_PREFIX: env.prefix, ELANOUS_INSTALL_TEST_EXPECTED_CWD: installDir }, command).result;
    expect(result.status).toBe(65);
    expect(bunShim.fakeBins.calls()).toEqual([]);
    expect(existsSync(join(installDir, 'node_modules', 'elanous', 'package.json'))).toBe(false);
    bunShim.cleanup();
  });

  test('fake bun add installs the exact tarball operand', () => {
    const env = setup();
    const installDir = join(env.prefix, 'versions', 'selected');
    const selected = packageFixture(fixture(), '1.2.3-selected');
    const decoy = packageFixture(fixture(), '9.8.7-decoy');
    mkdirSync(installDir, { recursive: true });
    const bunShim = fakeBunBin(env.dir, decoy, installDir);
    const command = [join(bunShim.bin, 'bun'), 'add', '--no-save', '--ignore-scripts', '--offline', selected].map(shellQuote).join(' ');
    const result = run([], env, process.env.PATH ?? '', installDir,
      { ELANOUS_INSTALL_PREFIX: env.prefix, ELANOUS_INSTALL_TEST_EXPECTED_CWD: installDir }, command).result;
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(installDir, 'node_modules', 'elanous', 'package.json'), 'utf8')).version)
      .toBe('1.2.3-selected');
    expect(bunShim.fakeBins.calls().find(call => call.name === 'bunAddContract')?.argv)
      .toEqual(['add', '--no-save', '--ignore-scripts', '--offline', selected]);
    bunShim.cleanup();
  });

  test('documented one-line installer validates the download and keeps curl failures non-zero', () => {
    const docs = readFileSync(join(repoRoot, 'release/public/docs/install.md'), 'utf8');
    const commandBlock = docs.match(/## One line\s+```bash\n([\s\S]*?)\n```/);
    expect(commandBlock, 'one-line install command is documented').not.toBeNull();
    const command = commandBlock?.[1];
    expect(command).toContain('curl -fsSL');
    expect(command).toContain('test -s "$tmp"');
    expect(command).toContain('bash -n "$tmp"');
    expect(command).toContain('bash "$tmp" --yes');

    const env = setup();
    const fakeBin = join(env.dir, 'fake-bin');
    const bashCalls = join(env.dir, 'bash-calls.log');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'curl'), `#!/bin/sh
out=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then out="$2"; shift 2; else shift; fi
done
if [ "$CURL_MODE" = 'fail' ]; then exit 22; fi
if [ "$CURL_MODE" = 'invalid' ]; then printf '%s\\n' 'if then' > "$out"; exit 0; fi
if [ "$CURL_MODE" = 'installer-fail' ]; then printf '%s\\n' '#!/bin/bash' 'exit 7' > "$out"; else printf '%s\\n' '#!/bin/bash' 'exit 0' > "$out"; fi
`, { mode: 0o755 });
    writeFileSync(join(fakeBin, 'bash'), `#!/bin/sh
if [ "$1" = '-n' ]; then exec /bin/bash "$@"; fi
printf '%s\\n' "$*" >> "$BASH_CALL_LOG"
exec /bin/bash "$@"
`, { mode: 0o755 });

    const path = [fakeBin, hostPathWithoutEln()].join(':');
    const runCommand = (mode: string) => run([], env, path, repoRoot, { CURL_MODE: mode, BASH_CALL_LOG: bashCalls }, command!).result;
    const failedDownload = runCommand('fail');
    expect(failedDownload.status).toBe(22);
    expect(existsSync(bashCalls)).toBe(false);

    const invalidScript = runCommand('invalid');
    expect(invalidScript.status).toBe(2);
    expect(existsSync(bashCalls)).toBe(false);

    const successfulDownload = runCommand('success');
    expect(successfulDownload.status).toBe(0);
    const calls = readFileSync(bashCalls, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^\/.* --yes$/);

    rmSync(bashCalls);
    const installerFailure = runCommand('installer-fail');
    expect(installerFailure.status).toBe(7);
    expect(readFileSync(bashCalls, 'utf8')).toMatch(/--yes\n$/);
  });

  test('only an otherwise-healthy report with explicit sudo denial for git install is non-blocking', () => {
    const healthyGitDenied = { report: { ok: true }, gitInstall: { ran: true, ok: false, permissionDenied: true } };
    expect(isUnprivilegedGitRepairOnlyFailure(healthyGitDenied)).toBe(true);
    expect(isUnprivilegedGitRepairOnlyFailure({ report: { ok: true }, gitInstall: { ran: true, ok: false, permissionDenied: false } })).toBe(false);
    expect(isUnprivilegedGitRepairOnlyFailure({ report: { ok: false }, gitInstall: { ran: true, ok: false, permissionDenied: true } })).toBe(false);
    expect(isUnprivilegedGitRepairOnlyFailure({ report: { ok: true }, gitInstall: { ran: false, ok: false, permissionDenied: true } })).toBe(false);
    expect(isUnprivilegedGitRepairOnlyFailure({ report: { ok: true }, gitInstall: { ran: true, ok: true, permissionDenied: true } })).toBe(false);
    // Aggregate doctor stderr must never turn another repair's permission error into a git exception.
    expect(isUnprivilegedGitRepairOnlyFailure({ report: { ok: true }, gitInstall: { ran: true, ok: false } })).toBe(false);
  });

  test('release installer uses the first-run bootstrap command', () => {
    const packed = packReal(fixture());
    const listing = spawnSync('tar', ['-tzf', packed], { encoding: 'utf8' });
    expect(listing.status, listing.stderr).toBe(0);
    expect(readFileSync(installer, 'utf8')).toContain('"$PREFIX/bin/elanous" bootstrap');
  }, 120_000);

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
    const { prefix, result } = run(['--no-modify-path'], env, undefined, undefined, { ELANOUS_INSTALL_TEST_REAL: '1' });
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
    expect(result.stdout).toContain('Setup: prerequisite repairs completed.');
    expect(result.stdout).toContain('Next:');
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
    expect(installed.result.stdout).toContain('Setup: prerequisite repairs completed.');
    expect(installed.result.stdout).toContain('Next:');
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
    const installed = run(['--no-modify-path'], env, `${pathDir}:${process.env.PATH ?? ''}`, repoRoot, { ELANOUS_INSTALL_TEST_REAL: '1' });
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(installed.result.stdout.match(/⚠ eln:/g)).toHaveLength(1);
    expect(installed.result.stdout).toContain('Setup: prerequisite repairs completed.');
    expect(installed.result.stdout).toContain('Next:');
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

  test('bashrc PATH block runs before the default non-interactive early return and installed CLI uses simCli', async () => {
    const env = setup();
    writeFileSync(env.startup, '# user settings\ncase $- in\n  *i*) ;;\n  *) return;;\nesac\nexport KEEP=1\n');
    const installed = run([], env, process.env.PATH ?? '', repoRoot, { ELANOUS_SHELL_STARTUP: '', SHELL: '/bin/bash' });
    expect(installed.result.status, installed.result.stderr).toBe(0);
    const bashrc = readFileSync(env.startup, 'utf8');
    expect(bashrc.indexOf('# >>> elanous installer PATH >>>')).toBeLessThan(bashrc.indexOf('case $- in'));
    const remote = await simCli(['help'], {
      mode: 'spawn',
      entrypoint: join(env.prefix, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs'),
      allowPaths: [['help']],
      cwd: repoRoot,
      stateRoot: join(env.dir, 'cli-state'),
      configRoot: join(env.home, '.elanous'),
      injectTestFlag: false,
      env: { HOME: env.home, PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: join(env.home, '.config'), XDG_CACHE_HOME: join(env.home, '.cache') },
    });
    expect(remote.exitCode, remote.stderr).toBe(0);
  }, 120_000);

  test('failed PATH block validation leaves the existing startup file and permissions intact', () => {
    const env = setup();
    const original = '# user settings\n# >>> elanous installer PATH >>>\nexport KEEP=1\n';
    writeFileSync(env.startup, original, { mode: 0o640 });
    chmodSync(env.startup, 0o640);
    const installed = run([], env, hostPathWithoutEln(), repoRoot, { ELANOUS_SHELL_STARTUP: '', SHELL: '/bin/bash' });
    expect(installed.result.status).not.toBe(0);
    expect(installed.result.stderr).toContain('PATH block');
    expect(readFileSync(env.startup, 'utf8')).toBe(original);
    expect(statSync(env.startup).mode & 0o777).toBe(0o640);
  }, 120_000);

  test('refuses a symlinked shell startup file without replacing its link or target', () => {
    const env = setup();
    const target = join(env.dir, 'dotfiles-bashrc');
    const original = '# managed by dotfiles\nexport KEEP=1\n';
    rmSync(env.startup);
    writeFileSync(target, original, { mode: 0o640 });
    chmodSync(target, 0o640);
    symlinkSync(target, env.startup);

    const installed = run([], env, hostPathWithoutEln(), repoRoot, { ELANOUS_SHELL_STARTUP: '', SHELL: '/bin/bash' });
    expect(installed.result.status).not.toBe(0);
    expect(installed.result.stderr).toContain('refusing to update PATH in symlinked shell startup file');
    expect(readlinkSync(env.startup)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(statSync(target).mode & 0o777).toBe(0o640);
  }, 120_000);

  test('split TMPDIR is moved beside the Bun cache before installer temp files are created', () => {
    const env = setup();
    const fakeBin = join(env.dir, 'fake-stat-bin');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'stat'), `#!/bin/sh
if [ "$1" = '-c' ] && [ "$2" = '%d' ]; then
  case "$3" in
    "$TMPDIR") printf '101\\n'; exit 0 ;;
    */install/cache|*/install/cache/elanous-tmp) printf '202\\n'; exit 0 ;;
  esac
fi
exec /usr/bin/stat "$@"
`, { mode: 0o755 });
    const cache = hostBunCache;
    const tempAlongsideCache = join(cache, 'elanous-tmp');
    const path = `${fakeBin}:${hostPathWithoutEln()}`;
    const installed = run(['--no-modify-path'], env, path, repoRoot, { TMPDIR: env.dir });
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(installed.result.stderr).toContain('Adjusted installer temp directory to match the Bun cache filesystem.');
    expect(existsSync(tempAlongsideCache)).toBe(true);
    expect(installed.fakeBunEnvCalls).toContain(tempAlongsideCache);
  }, 120_000);

  test('a non-interactive SSH bash command finds the installed binary after repeat install without changing other startup files', () => {
    const env = setup();
    const bashProfile = join(env.home, '.bash_profile');
    writeFileSync(bashProfile, 'export KEEP_BASH_PROFILE=1\n');
    writeFileSync(join(env.home, '.bashrc'), 'export KEEP=1\nexport KEEP_BASH=2\n');
    writeFileSync(join(env.home, '.profile'), 'export KEEP_PROFILE=1\nexport PROFILE_MARKER=2\n');
    const shell = { ELANOUS_SHELL_STARTUP: '', SHELL: '/bin/bash' };
    const first = run([], env, hostPathWithoutEln(), repoRoot, shell);
    expect(first.result.status, first.result.stderr).toBe(0);
    const second = run([], env, hostPathWithoutEln(), repoRoot, shell);
    expect(second.result.status, second.result.stderr).toBe(0);

    const remote = spawnSync('/bin/bash', ['-c', 'command -v elanous && command -v bun'], {
      encoding: 'utf8',
      env: { HOME: env.home, PATH: '/usr/bin:/bin', SSH_CLIENT: '127.0.0.1 22 12345' },
    });
    expect(remote.status, remote.stderr).toBe(0);
    expect(remote.stdout.trim().split('\n')).toEqual([
      realpathSync(join(env.prefix, 'bin', 'elanous')),
      join(realpathSync(join(env.prefix, 'bin')), 'bun'),
    ]);

    const bashrc = readFileSync(join(env.home, '.bashrc'), 'utf8');
    const profile = readFileSync(join(env.home, '.profile'), 'utf8');
    expect(bashrc.indexOf('# >>> elanous installer PATH >>>')).toBeLessThan(bashrc.indexOf('export KEEP=1'));
    expect(bashrc).toContain('export KEEP=1\nexport KEEP_BASH=2\n');
    expect(profile).toStartWith('export KEEP_PROFILE=1\nexport PROFILE_MARKER=2\n');
    expect(readFileSync(bashProfile, 'utf8')).toBe('export KEEP_BASH_PROFILE=1\n');
    expect(bashrc.match(/^# >>> elanous installer PATH >>>$/gm)).toHaveLength(1);
    expect(bashrc.match(/^# <<< elanous installer PATH <<<$/gm)).toHaveLength(1);
    expect(profile.match(/^# >>> elanous installer PATH >>>$/gm)).toHaveLength(1);
    expect(profile.match(/^# <<< elanous installer PATH <<<$/gm)).toHaveLength(1);
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
    const pathWithGit = `${path}:/usr/bin:/bin`;
    const versionDir = checkoutVersionName(pathWithGit);
    const archive = packageFixture(fixture());
    const bunShim = fakeBunBin(env.dir, archive, join(env.prefix, 'versions', versionDir), { relativeExecPath: true });
    const { result } = run(['--no-modify-path', '--no-bootstrap-bun'], env, `${bunShim.bin}:${pathWithGit}`, repoRoot, {
      ELANOUS_INSTALL_TEST_CUSTOM_BUN: '1', ELANOUS_INSTALL_TEST_PACKAGE_TGZ: archive, BUN_INSTALL: join(env.home, '.bun'),
    });
    // 폴백(`command -v bun`)이 절대 경로를 준다 ⇒ «절대 경로 없음»으로 거부하지 않는다(옛 동작 · BUN_INSTALL 재사용 시험과 같은 축).
    expect(result.stderr).not.toContain('bun executable absolute path is unavailable');
    expect(result.status).toBe(0);
    const addCall = parsedFakeBunCalls(bunShim.calls).find((call) => call[1] === 'add');
    expect(addCall?.[0]).toBe(join(env.prefix, 'versions', versionDir));
    expect(bunShim.fakeBins.calls().find((call) => call.name === 'bunAddContract')?.argv).toEqual(addCall?.slice(1));
    const current = readlinkSync(join(env.prefix, 'current'));
    expect(current.startsWith('versions/')).toBe(true);
    expect(existsSync(join(env.prefix, current, 'node_modules', 'elanous', 'package.json'))).toBe(true);
    const wrapper = join(env.prefix, 'bin', 'elanous');
    if (existsSync(wrapper)) {
      const text = readFileSync(wrapper, 'utf8');
      expect(text).toContain(join(bunShim.bin, 'bun'));
      expect(text).not.toContain('relative-bun');
    }
    bunShim.cleanup();
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
    const first = run([], env, undefined, undefined, { ELANOUS_INSTALL_TEST_REAL: '1' });
    const second = run([], env, undefined, undefined, { ELANOUS_INSTALL_TEST_REAL: '1' });
    expect(first.result.status, `${first.result.stderr}\n${first.result.stdout}`).toBe(0);
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
    expect(loaded.stdout.trim().split('\n').at(-1)).toBe(join(realpathSync(env.prefix), 'bin', 'elanous'));
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
      { release: 'ID=ubuntu\n', platform: 'Linux', missing: 'bun', expected: 'curl -fsSL https://bun.sh/install | bash' },
      { release: 'ID=amzn\nVERSION_ID=2\n', platform: 'Linux', missing: 'bun', expected: 'curl -fsSL https://bun.sh/install | bash' },
      { release: 'ID=alpine\n', platform: 'Linux', missing: 'bun', expected: "(install the 'bun' package with your package manager)" },
    ];
    for (const { release, platform, missing, expected } of cases) {
      const env = setup();
      const path = join(env.dir, 'path');
      mkdirSync(path);
      const osRelease = join(env.dir, 'os-release');
      writeFileSync(osRelease, release);
      for (const [name, body] of [
        ['uname', `#!/bin/sh\nprintf '%s\\n' '${platform}'\n`],
        ['git', '#!/bin/sh\nexit 0\n'],
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
  test('Ubuntu 24.04 bare machine gets every missing prerequisite in one line, and root gets no sudo', () => {
    for (const root of [false, true]) {
      const env = setup();
      const path = join(env.dir, 'path');
      mkdirSync(path);
      const osRelease = join(env.dir, 'os-release');
      writeFileSync(osRelease, 'ID=ubuntu\nVERSION_ID="24.04"\n');
      const stubs: Array<[string, string]> = [['uname', "#!/bin/sh\nprintf 'Linux\\n'\n"]];
      if (root) stubs.push(['id', '#!/bin/sh\necho 0\n']);
      for (const [name, body] of stubs) {
        const file = join(path, name);
        writeFileSync(file, body);
        chmodSync(file, 0o755);
      }
      // bun·curl·unzip·git 이 전부 없다 — Bun bootstrap needs curl+unzip; Git does not block core install.
      const { result } = run(['--no-modify-path'], env, path, repoRoot,
        { BUN_INSTALL: join(env.home, '.bun'), ELANOUS_INSTALL_OS_RELEASE_FILE: osRelease });
      expect(result.status, result.stderr).toBe(127);
      expect(result.stderr).toContain('required command missing: curl unzip');
      expect(result.stderr).toContain(`   ${root ? '' : 'sudo '}apt-get install -y curl unzip`);
      expect(result.stderr.match(/required command missing/g)?.length).toBe(1);
      if (root) expect(result.stderr).not.toContain('sudo ');
    }
  });

  test('npm-pack installer succeeds without Git or native build tools, then non-interactive setup works', async () => {
    // Use the package that ships to users so `setup` exercises the installed CLI entry point,
    // not the fake CLI used by the installer-only fixture tests.
    const packed = packReal(fixture());
    const env = setup();
    const missingTools = ['git', 'python', 'python3', 'make', 'g++', 'gcc', 'cc'];
    const path = pathWithoutCommands(missingTools);
    expectCommandsMissing(missingTools, path);
    const installed = run(['--source', packed, '--no-modify-path', '--no-setup'], env, path, repoRoot,
      { ELANOUS_INSTALL_INTERACTIVE: '0', ELANOUS_INSTALL_TEST_REAL: '1' });
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(installed.result.stdout).toContain('Installed elanous');
    expect(installed.result.stderr).not.toContain('required command missing: git');
    expect(installed.result.stderr).toContain('The Bun TUI needs no system Node.js, Python, or compiler.');
    // The npm-pack install must not run optional native build scripts or require Git/compiler tools for the core TUI.

    const setupReport = await simCli(['setup', '--non-interactive'], {
      mode: 'spawn',
      entrypoint: join(env.prefix, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs'),
      allowPaths: [['setup']],
      cwd: repoRoot,
      stateRoot: join(env.dir, 'setup-state'),
      configRoot: join(env.home, '.elanous'),
      injectTestFlag: false,
      env: { HOME: env.home, PATH: path, NODE_ENV: 'test' },
    });
    expect(setupReport.exitCode, setupReport.stderr).toBe(0);
    expect(setupReport.stdout).toContain('Setup: external command check');
    expect(setupReport.stdout).toContain('Setup: LLM credential steps');
    expect(setupReport.stdout).toContain('Non-interactive: no questions were asked and no configuration was written.');
    expect(setupReport.stdout).toContain('External commands:');
    expect(setupReport.stdout).toContain('build-toolchain: manual');
    expect(existsSync(join(env.home, '.elanous', 'config.json'))).toBe(false);
  }, 180_000);

  test('Bun global install of an npm-pack tarball starts the core setup', () => {
    const packed = packReal(fixture());
    const env = setup();
    const bunInstall = join(env.home, '.bun');
    const missingTools = ['git', 'python', 'python3', 'make', 'g++', 'gcc', 'cc'];
    const path = pathWithoutCommands(missingTools);
    expectCommandsMissing(missingTools, path);
    const added = spawnSync('bun', ['add', '--global', '--ignore-scripts', packed], {
      cwd: env.dir, encoding: 'utf8', timeout: 180_000,
      env: { ...process.env, HOME: env.home, BUN_INSTALL: bunInstall, PATH: path },
    });
    expect(added.status, added.stderr).toBe(0);
    const globalModules = join(bunInstall, 'install', 'global', 'node_modules');
    expect(existsSync(join(globalModules, 'elanous'))).toBe(true);
    const elanous = join(bunInstall, 'bin', 'elanous');
    const sharpCheck = spawnSync('bun', ['-e', "import sharp from 'sharp'; const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer(); console.log(png.length > 0 ? 'sharp-prebuilt-ok' : 'sharp-prebuilt-missing')"], {
      cwd: join(globalModules, 'elanous'), encoding: 'utf8', env: { ...process.env, HOME: env.home, BUN_INSTALL: bunInstall, PATH: path },
    });
    expect(sharpCheck.status, sharpCheck.stderr).toBe(0);
    expect(sharpCheck.stdout).toContain('sharp-prebuilt-ok');
    const version = spawnSync(elanous, ['--version'], { encoding: 'utf8', env: { ...process.env, HOME: env.home, PATH: path } });
    expect(version.status, version.stderr).toBe(0);
    const setupReport = spawnSync(elanous, ['setup', '--non-interactive'], {
      encoding: 'utf8', env: { ...process.env, HOME: env.home, PATH: path, ELANOUS_CONFIG_DIR: join(env.home, '.elanous'), ELANOUS_STATE_DIR: join(env.home, '.elanous') },
    });
    expect(setupReport.status, setupReport.stderr).toBe(0);
    expect(setupReport.stdout).toContain('Setup: external command check');
  }, 240_000);

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

  test('Ubuntu 24.04 root apt installs the missing set once, rechecks it, and advances past the prerequisite gate', () => {
    const { env, path, calls, extra } = aptPrerequisiteFixture(0, 'ID=ubuntu\nVERSION_ID="24.04"\n');
    const { result } = run(['--no-modify-path'], env, path, repoRoot, extra);
    // Fresh images have empty package lists: one update, then one non-interactive install.
    expect(readFileSync(calls, 'utf8')).toBe('update -qq\ninstall -y -qq curl unzip\n');
    expect(result.stderr).toContain('installed: curl unzip');
    // Past the prerequisite gate: later steps may still stop (the fake PATH has no real bun/bash).
    expect(result.stderr).not.toMatch(/required command missing: [^\n]*\b(?:curl|unzip)\b/);
  });

  test('Ubuntu 24.04 non-root gets the exact prerequisite command without invoking apt', () => {
    const { env, path, calls, extra } = aptPrerequisiteFixture(1000, 'ID=ubuntu\nVERSION_ID="24.04"\n');
    const { result } = run([], env, path, repoRoot, extra);
    expect(existsSync(calls)).toBe(false);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('   sudo apt-get install -y curl unzip');
  });

  test('consented Ubuntu install uses sudo apt to prepare bun bootstrap prerequisites', () => {
    const { env, path, calls, extra } = aptPrerequisiteFixture(1000, 'ID=ubuntu\nVERSION_ID="24.04"\n');
    writeFileSync(join(path, 'sudo'), '#!/bin/sh\nif [ "$1" = -n ] && [ "$2" = -l ]; then exit 0; fi\nexec "$@"\n', { mode: 0o755 });
    const { result } = run(['--no-modify-path'], env, path, repoRoot, extra);
    expect(readFileSync(calls, 'utf8')).toBe('update -qq\ninstall -y -qq curl unzip\n');
    expect(result.stderr).toContain('installed: curl unzip');
    expect(result.stderr).not.toMatch(/required command missing: [^\n]*\b(?:curl|unzip)\b/);
  });

  test('interactive Ubuntu install verifies sudo privilege before attempting apt', () => {
    const { env, path, calls, extra } = aptPrerequisiteFixture(1000, 'ID=ubuntu\nVERSION_ID="24.04"\n');
    const sudoCalls = join(env.dir, 'sudo-calls');
    writeFileSync(join(path, 'sudo'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sudoCalls}'\nexit 1\n`, { mode: 0o755 });
    const script = spawnSync('/bin/bash', ['-c', 'command -v script'], { encoding: 'utf8' }).stdout.trim();
    if (!script) throw new Error('script(1) is required to exercise the installer TTY path');
    const command = ['/bin/bash', installer, '--yes', '--no-modify-path'].join(' ');
    const args = process.platform === 'darwin' ? ['-q', '/dev/null', '/bin/bash', installer, '--yes', '--no-modify-path'] : ['-qec', command, '/dev/null'];
    const result = spawnSync(script, args, {
      cwd: repoRoot, encoding: 'utf8',
      env: { ...process.env, HOME: env.home, PATH: path,
        ELANOUS_SHELL_STARTUP: env.startup, ELANOUS_INSTALL_INTERACTIVE: '1', CI: '', ...extra },
    });
    expect(readFileSync(sudoCalls, 'utf8').trim().split('\n')).toEqual(['-n -l apt-get', '-l apt-get']);
    expect(existsSync(calls)).toBe(false);
    expect(result.status).not.toBe(0);
  });

  test('does not probe sudo when apt is disabled or Bun and unzip are already present', () => {
    const disabled = aptPrerequisiteFixture(1000, 'ID=ubuntu\nVERSION_ID="24.04"\n');
    const disabledCalls = join(disabled.env.dir, 'sudo-calls');
    writeFileSync(join(disabled.path, 'sudo'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${disabledCalls}'\nexit 1\n`, { mode: 0o755 });
    run(['--no-install-deps'], disabled.env, disabled.path, repoRoot, disabled.extra);
    expect(existsSync(disabledCalls)).toBe(false);

    const ready = aptPrerequisiteFixture(1000, 'ID=ubuntu\nVERSION_ID="24.04"\n');
    const readyCalls = join(ready.env.dir, 'sudo-calls');
    writeFileSync(join(ready.path, 'sudo'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${readyCalls}'\nexit 1\n`, { mode: 0o755 });
    for (const name of ['bun', 'unzip']) writeFileSync(join(ready.path, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    run(['--no-bootstrap-bun'], ready.env, ready.path, repoRoot, ready.extra);
    expect(existsSync(readyCalls)).toBe(false);
  });

  test('non-root Ubuntu without sudo privileges uses Python extraction and retains Bun after shim cleanup', () => {
    const { env, path, calls, extra } = aptPrerequisiteFixture(1000, 'ID=ubuntu\nVERSION_ID="24.04"\n');
    // The binary exists, but this account cannot run sudo without a password or a terminal.
    writeFileSync(join(path, 'sudo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const python3 = spawnSync('/usr/bin/env', ['python3', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
    if (!python3) throw new Error('Python 3 is required for the unzip fallback test');
    symlinkSync(python3, join(path, 'python3'));
    const marker = join(env.home, 'extracted-bun-called');
    const archive = join(env.home, 'bun-test.zip');
    const bunStub = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\n`;
    const zipped = spawnSync(python3, ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1], "w"); z.writestr("bin/bun", sys.argv[2]); z.close()', archive, bunStub], { encoding: 'utf8' });
    if (zipped.status !== 0) throw new Error(`could not create the Bun test archive: ${zipped.stderr}`);
    writeFileSync(join(path, 'curl'), [
      '#!/bin/bash',
      "cat <<'INSTALLER'",
      '#!/bin/bash',
      'command -v unzip >/dev/null || exit 61',
      'unzip -oqd "${BUN_INSTALL:-$HOME/.bun}" "$HOME/bun-test.zip" || exit 62',
      'chmod +x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" || exit 63',
      '"${BUN_INSTALL:-$HOME/.bun}/bin/bun" bootstrap || exit 64',
      'INSTALLER',
      '',
    ].join('\n'), { mode: 0o755 });
    for (const command of ['bash', 'cat', 'mktemp', 'mkdir', 'rm']) {
      const resolved = spawnSync('/bin/bash', ['-c', 'command -v "$1"', '--', command], { encoding: 'utf8' }).stdout.trim();
      if (resolved) symlinkSync(resolved, join(path, command));
    }
    const invalidTarball = join(env.dir, 'invalid.tgz');
    writeFileSync(invalidTarball, 'not a tarball');
    const { result } = run(['--source', invalidTarball, '--no-modify-path'], env, path, repoRoot, { ...extra, TMPDIR: env.dir });
    expect(existsSync(calls)).toBe(false);
    expect(result.stderr).toContain('using Python zip extraction for Bun bootstrap');
    expect(readFileSync(marker, 'utf8')).toContain('bootstrap');
    expect(readFileSync(marker, 'utf8')).toContain('-e');
    expect(result.stderr).not.toContain('required command missing: unzip');
    expect(result.stderr).not.toContain('required command missing: bun');
    expect(readdirSync(env.dir).some(name => name.startsWith('elanous-unzip-shim.'))).toBe(false);
  });

  test('--no-install-deps disables apt for root without changing the existing hint', () => {
    const { env, path, calls, extra } = aptPrerequisiteFixture(0);
    const { result } = run(['--no-install-deps'], env, path, repoRoot, extra);
    expect(existsSync(calls)).toBe(false);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('   apt-get install -y curl unzip');
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
    expect(result.stderr).toContain("(install the 'curl unzip' package with your package manager)");
  });

  test('Ubuntu 24.04 apt failure stays rc 127 and names manual recovery with the existing hint', () => {
    const { env, path, calls, extra } = aptPrerequisiteFixture(0, 'ID=ubuntu\nVERSION_ID="24.04"\n', true);
    const { result } = run([], env, path, repoRoot, extra);
    // The failing stub fails at update, so install is never attempted.
    expect(readFileSync(calls, 'utf8')).toBe('update -qq\n');
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('자동 설치 실패 — 아래를 직접 실행하라');
    expect(result.stderr).toContain('   apt-get install -y curl unzip');
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

  test('the installer command set exactly matches the catalog runtime-required entries', () => {
    const installerRequired = readFileSync(installer, 'utf8').match(/REQUIRED_COMMANDS=\(([^)]*)\)/)?.[1].trim().split(/\s+/).sort();
    expect(installerRequired).toEqual(requiredFromCatalog('required'));
    expect(installerRequired).toEqual(['bun']);
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; elanousOptionalIntegrations?: Record<string, string> };
    expect(manifest.optionalDependencies).not.toHaveProperty('node-pty');
    expect(manifest.peerDependencies).not.toHaveProperty('node-pty');
    expect(manifest.peerDependencies).not.toHaveProperty('telegram');
    expect(manifest.optionalDependencies).toMatchObject({ telegram: '^2.26.22' });
    expect(manifest.elanousOptionalIntegrations).toMatchObject({ 'node-pty': '^1.1.0' });
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
    expect(loaded.stdout.trim().split('\n').at(-1)?.split(':')[0]).toBe(join(expectedPrefix, 'bin'));
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

  test('reports automatic setup and keeps the remaining Next steps', () => {
    const env = setup();
    const fresh = run(['--no-modify-path'], env);
    expect(fresh.result.status, fresh.result.stderr).toBe(0);
    expect(fresh.result.stdout.match(/Setup: prerequisite repairs completed\./g)).toHaveLength(1);
    expect(fresh.result.stdout).toContain('Next:');
    expect(fresh.result.stdout).toContain('check anytime: elanous setup --non-interactive');
    expect(fresh.result.stdout).not.toContain('harness command missing');
  }, 180_000);

  test('automatic setup output preserves the remaining next-step guidance', () => {
    const env = setup();
    const result = run(['--no-modify-path', '--no-setup'], env).result;
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Setup: prerequisite repairs completed.');
    expect(result.stdout).toContain('Next:');
    expect(result.stdout).toContain('check anytime: elanous setup --non-interactive');
    expect(result.stdout).not.toContain('harness command missing');
    expect(result.stdout).not.toContain('build-essential');
    expect(result.stdout).not.toContain('rebuild node-pty');
  }, 180_000);

  test('Next guidance recognizes gh installed into the selected prefix', () => {
    const env = setup();
    const first = run(['--no-modify-path', '--no-setup'], env);
    expect(first.result.status, first.result.stderr).toBe(0);
    const gh = join(env.prefix, 'bin', 'gh');
    mkdirSync(join(env.prefix, 'bin'), { recursive: true });
    writeFileSync(gh, '#!/bin/sh\nif [ "$1" = auth ] && [ "$2" = status ]; then exit 1; fi\necho gh version 2.0.0\n', { mode: 0o755 });
    const retry = run(['--no-modify-path', '--no-setup'], env);
    expect(retry.result.status, retry.result.stderr).toBe(0);
    expect(retry.result.stdout).toContain('gh auth login');
    expect(retry.result.stdout).not.toContain('install gh');
  }, 180_000);

  test('installed macOS CLI repairs missing prerequisites through isolated brew and re-probes them', () => {
    if (process.platform !== 'darwin') return; // Linux static-tool install and re-probe are covered by the injected production-path doctor CLI test.
    const env = setup();
    const installed = run(['--no-modify-path', '--no-setup'], env);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    const mockBin = join(env.dir, 'doctor-mock-bin');
    mkdirSync(mockBin);
    const record = join(env.dir, 'doctor-brew-calls');
    writeFileSync(join(mockBin, 'brew'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${record}'\ncase "$*" in\n  *gh*) tool=gh ;;\n  *ripgrep*) tool=rg ;;\n  *codex*) tool=codex ;;\n  *) exit 2 ;;\nesac\ncat > '${mockBin}'/"$tool" <<'TOOL'\n#!/bin/sh\ncase "$0" in *gh) [ "$1" = auth ] && exit 1; echo 'gh version 2.0.0' ;; *rg) echo 'ripgrep 14.0.0' ;; *codex) echo 'codex 1.0.0' ;; esac\nTOOL\nchmod +x '${mockBin}'/"$tool"\n`, { mode: 0o755 });
    symlinkSync('/usr/bin/git', join(mockBin, 'git'));
    symlinkSync(process.execPath, join(mockBin, 'bun'));
    const path = pathWithoutCommands(['gh', 'rg', 'codex'], `${mockBin}:/usr/bin:/bin`);
    expectCommandsMissing(['gh', 'rg', 'codex'], path);
    const entry = join(env.prefix, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs');
    const doctorEnv = { HOME: env.home, XDG_CONFIG_HOME: join(env.home, '.config'), XDG_CACHE_HOME: join(env.home, '.cache'), ELANOUS_INSTALL_PREFIX: env.prefix, ELANOUS_FAST_ROUTER: '0', NODE_ENV: 'test', ELANOUS_TEST_BIN_PATH_CANDIDATES: mockBin, PATH: path, TMPDIR: env.dir, LANG: 'C' };
    const before = spawnSync('/usr/bin/env', ['-i', ...Object.entries(doctorEnv).map(([name, value]) => `${name}=${value}`), process.execPath, entry, 'doctor', '--json'], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
    const beforeReport = JSON.parse(before.stdout) as { externalCommands: Array<{ name: string; status: string }> };
    expect(beforeReport.externalCommands.filter((command) => ['gh', 'rg', 'codex'].includes(command.name)).map(({ name, status }) => ({ name, status }))).toEqual(['gh', 'rg', 'codex'].map((name) => ({ name, status: 'missing' })));
    const doctor = spawnSync('/usr/bin/env', ['-i', ...Object.entries(doctorEnv).map(([name, value]) => `${name}=${value}`), process.execPath, entry, 'doctor', '--fix', '--yes', '--setup-tools', '--json'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 120_000,
    });
    expect(doctor.status, doctor.stderr).toBe(0);
    const result = JSON.parse(doctor.stdout) as { report: { externalCommands: Array<{ name: string; status: string }> } };
    expect(['gh', 'rg', 'codex'].every((name) => result.report.externalCommands.find((command) => command.name === name)?.status === 'found')).toBe(true);
    expect(existsSync(record), `doctor did not invoke isolated brew: ${JSON.stringify(result.report.externalCommands)}`).toBe(true);
    expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual(['install gh', 'install ripgrep', 'install --cask codex']);
    expect(existsSync(join(mockBin, 'gh')) && existsSync(join(mockBin, 'rg')) && existsSync(join(mockBin, 'codex'))).toBe(true);
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
    const firstDir = checkoutVersionName(hostPathWithoutEln());
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

  test('--source URL downloads the tarball and records the URL as source', async () => {
    const env = setup();
    const served = fixture();
    const tgz = pack(served);
    const server = Bun.spawn([process.execPath, '-e', [
      `const file = ${JSON.stringify(tgz)};`,
      'const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(Bun.file(file)) });',
      'console.log(server.port);',
    ].join('\n')], { stdout: 'pipe', stderr: 'pipe' });
    try {
      const ready = await Promise.race([
        server.stdout.getReader().read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('local HTTP fixture did not start')), 5_000)),
      ]);
      const port = Number(new TextDecoder().decode(ready.value).trim());
      expect(Number.isInteger(port) && port > 0).toBe(true);
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
    const archive = packageFixture(fixture());
    const installDir = join(env.prefix, 'versions', packageJson.version);
    const bunShim = fakeBunBin(env.dir, archive, installDir);
    const doctorBin = isolatedDoctorBin(env);
    const result = spawnSync('/bin/bash', [copied, '--yes', '--no-modify-path'], {
      cwd: lonely, encoding: 'utf8',
      env: { ...process.env, HOME: env.home, PATH: `${bunShim.bin}:${process.env.PATH ?? ''}`, ELANOUS_INSTALL_PREFIX: env.prefix, ELANOUS_INSTALL_TEST_EXPECTED_CWD: installDir, ELANOUS_SHELL_STARTUP: env.startup, ELANOUS_INSTALL_SOURCE: '', ELANOUS_RELEASE_BASE: `file://${release}`, ELANOUS_VERSION: '', ...extra, NODE_ENV: 'test', ELANOUS_TEST_BIN_PATH_CANDIDATES: doctorBin },
    });
    bunShim.cleanup();
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
    const r = spawnSync('/bin/bash', [installer, '--yes', '--no-modify-path', '--no-bootstrap-bun', '--prefix', join(home, 'prefix')], {
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
    const doctorBin = isolatedDoctorBin(env);
    const command = ['/bin/bash', installer, '--yes', '--no-modify-path'];
    const argv = process.platform === 'darwin' ? ['-q', '/dev/null', ...command] : ['-qec', command.join(' '), '/dev/null'];
    const result = spawnSync('script', argv, {
      cwd: repoRoot, encoding: 'utf8',
      env: { ...process.env, HOME: env.home, XDG_CONFIG_HOME: join(env.home, '.config'), XDG_CACHE_HOME: join(env.home, '.cache'), ELANOUS_INSTALL_PREFIX: env.prefix, ELANOUS_SHELL_STARTUP: env.startup, ELANOUS_INSTALL_INTERACTIVE: '1', ELANOUS_INSTALL_SETUP_EXEC: exec, ELANOUS_INSTALL_LANG: 'en', CI: '', NODE_ENV: 'test', ELANOUS_TEST_BIN_PATH_CANDIDATES: doctorBin },
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

  test('INST4: same-window setup starts in Korean and keeps the remaining Next steps', () => {
    const env = setup();
    const { exec } = fakeSetup(env.dir);
    const { result } = run([], env, process.env.PATH ?? '', repoRoot, { ELANOUS_INSTALL_INTERACTIVE: '1', ELANOUS_INSTALL_SETUP_EXEC: exec, CI: '', ELANOUS_INSTALL_LANG: 'ko' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('설정: 필수 환경 복구를 완료했습니다.');
    expect(result.stdout).toContain('다음:');
    expect(result.stdout).not.toMatch(/install gh|install Node|the harness|rebuild node-pty|install ripgrep/);
    expect(result.stderr).not.toContain('harness command missing');
  }, 180_000);

  test('headless fresh install starts web first-run without requiring /dev/tty', () => {
    const env = setup();
    const { exec, record } = fakeSetup(env.dir);
    const { prefix, result } = run(['--no-modify-path'], env, process.env.PATH ?? '', repoRoot, { ELANOUS_INSTALL_INTERACTIVE: '0', ELANOUS_INSTALL_SETUP_EXEC: exec, CI: '' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(record, 'utf8').trim()).toBe(join(realpathSync(prefix), 'bin', 'elanous'));
    expect(result.stdout).toContain('Setup: prerequisite repairs completed.');
    expect(result.stdout).toContain('Next:');
    expect(result.stdout).toContain('Starting first-time setup');
  }, 180_000);

  test('headless setup handoff marks the installer opt-in and does not fabricate a terminal', () => {
    const env = setup();
    const record = join(env.dir, 'setup-env');
    const exec = join(env.dir, 'fake-setup-env');
    writeFileSync(exec, `#!/bin/sh\nprintf '%s|%s|%s' "$1" "$ELANOUS_INSTALL_FIRST_RUN" "\${ELANOUS_INSTALL_SETUP_TTY-unset}" > '${record}'\n`, { mode: 0o755 });
    const { prefix, result } = run(['--no-modify-path'], env, process.env.PATH ?? '', repoRoot, { ELANOUS_INSTALL_INTERACTIVE: '0', ELANOUS_INSTALL_SETUP_EXEC: exec, CI: '' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(record, 'utf8')).toBe(`${join(realpathSync(prefix), 'bin', 'elanous')}|1|unset`);
  }, 180_000);

  test('release prepare installer helper runs the real installer with no setup in an interactive session', () => {
    const packed = pack(fixture());
    const env = setup();
    const { exec, record } = fakeSetup(env.dir);
    const path = hostPathWithoutEln();
    const doctorBin = isolatedDoctorBin(env);
    const installEnv: NodeJS.ProcessEnv = {
      ...process.env, NODE_ENV: 'test', HOME: env.home, XDG_CONFIG_HOME: join(env.home, '.config'),
      XDG_CACHE_HOME: join(env.home, '.cache'), BUN_INSTALL: join(env.home, '.bun'), BUN_INSTALL_CACHE_DIR: hostBunCache,
      ELANOUS_INSTALL_PREFIX: env.prefix, ELANOUS_INSTALL_SOURCE: packed, ELANOUS_SHELL_STARTUP: env.startup,
      ELANOUS_INSTALL_LANG: 'en', ELANOUS_INSTALL_INTERACTIVE: '1', ELANOUS_INSTALL_SETUP_EXEC: exec,
      ELANOUS_TEST_BIN_PATH_CANDIDATES: doctorBin, PATH: path, CI: '',
    };
    const runner: Runner = (command, args, cwd, options) => {
      const result = spawnSync(command, [...args], { cwd, encoding: 'utf8', env: options?.env ?? installEnv, input: options?.input });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    const result = runReleaseInstaller(readFileSync(installer, 'utf8'), env.home, installEnv, runner);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(record)).toBe(false);
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

  test('--no-setup: a fresh headless install does not start setup', () => {
    const env = setup();
    const { exec, record } = fakeSetup(env.dir);
    const { result } = run(['--no-modify-path', '--no-setup'], env, process.env.PATH ?? '', repoRoot, { ELANOUS_INSTALL_INTERACTIVE: '0', ELANOUS_INSTALL_SETUP_EXEC: exec, CI: '' });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(record)).toBe(false);
    expect(result.stdout).not.toContain('Starting first-time setup');
  }, 180_000);

  test('the registry fallback keeps bun noise («Blocked N postinstalls») off the screen when it succeeds', () => {
    const env = setup();
    const realBun = spawnSync('/bin/bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout.trim();
    const shim = join(env.dir, 'shim');
    mkdirSync(shim);
    const archive = packageFixture(fixture());
    // offline add fails (cache miss) · registry add prints the noise and then really installs.
    const calls = join(env.dir, 'bun-add-calls');
    writeFileSync(join(shim, 'bun'), [
      '#!/bin/sh',
      `printf '%s\\n' "$PWD|$*" >> '${calls}'`,
      'case "$1 $2" in',
      '  "pm pack") command -p cp "$ELANOUS_INSTALL_TEST_PACKAGE_TGZ" "$4/package.tgz"; exit $? ;;',
      '  "add --no-save")',
      '    [ "$3" = "--ignore-scripts" ] || exit 64',
      '    [ "$4" = "--offline" ] && exit 1',
      '    package="$4"',
      '    case "$PWD" in "$ELANOUS_INSTALL_PREFIX"/versions/*) ;; *) exit 65 ;; esac',
      '    [ -f "$package" ] || exit 66',
      '    mkdir -p "$PWD/node_modules" || exit 67',
      '    command -p rm -rf "$PWD/node_modules/package" "$PWD/node_modules/elanous"',
      '    command -p tar -xzf "$package" -C "$PWD/node_modules" || exit $?',
      '    [ -f "$PWD/node_modules/package/package.json" ] || exit 68',
      '    command -p mv "$PWD/node_modules/package" "$PWD/node_modules/elanous" || exit $?',
      '    echo "Blocked 3 postinstalls. Run `bun pm untrusted` for details."',
      '    exit 0 ;;',
      'esac',
      `exec '${realBun}' "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    const { result } = run(['--no-modify-path', '--no-setup'], env, `${shim}:${process.env.PATH ?? ''}`, repoRoot, { ELANOUS_INSTALL_INTERACTIVE: '0', ELANOUS_INSTALL_TEST_CUSTOM_BUN: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('fetching them from the npm registry');
    expect(`${result.stdout}${result.stderr}`).not.toContain('Blocked 3 postinstalls');
    const addCalls = readFileSync(calls, 'utf8');
    expect(addCalls).toContain('add --no-save --ignore-scripts --offline');
    expect(addCalls).toContain('add --no-save --ignore-scripts ');
    expect(addCalls).toContain(`${join(env.prefix, 'versions', checkoutVersionName(hostPathWithoutEln()))}|add --no-save --ignore-scripts `);
    expect(existsSync(join(env.prefix, 'versions', checkoutVersionName(hostPathWithoutEln()), 'node_modules', 'elanous', 'package.json'))).toBe(true);
    expect(readlinkSync(join(env.prefix, 'current'))).toBe(`versions/${checkoutVersionName(hostPathWithoutEln())}`);
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
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('consent required');
    expect(existsSync(join(env.prefix, 'bin', 'elanous'))).toBe(false);
  }, 180_000);

  test('a Korean locale gets the whole normal path in Korean (polite form), English otherwise', () => {
    const env = setup();
    const ko = run(['--no-modify-path', '--no-setup'], env, process.env.PATH ?? '', repoRoot, { ELANOUS_INSTALL_LANG: 'ko' });
    expect(ko.result.status, ko.result.stderr).toBe(0);
    expect(ko.result.stdout).toContain('설치했습니다');
    expect(ko.result.stdout).toContain('설정: 필수 환경 복구를 완료했습니다.');
    expect(ko.result.stdout).toContain('다음:');
    expect(ko.result.stdout).not.toContain('Next:');
    expect(ko.result.stdout).not.toMatch(/쓰십시오|않았다 —/);
  }, 180_000);
});

bunTest('deterministic install smoke tests remain registered', () => {
  expect(INSTALL_DETERMINISTIC_SMOKE_TESTS.filter((name) => !registeredInstallTestNames.has(name))).toEqual([]);
});
