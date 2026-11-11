import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

const repoRoot = resolve(import.meta.dir, '..');
const installer = resolve(import.meta.dir, 'install.ps1');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
const shell = findPowerShell();
const executionTest = shell ? test : test.skip;
const nonWindowsExecutionTest = process.platform === 'win32' ? test.skip : executionTest;
const windowsExecutionTest = process.platform === 'win32' && shell ? test : test.skip;
// Source: child-process contract treats a zero exit status as success.
const successfulExitStatus = 0;
const fixtures: string[] = [];

function findPowerShell(): string | undefined {
  const candidates = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['pwsh', 'powershell'];
  for (const candidate of candidates) {
    const located = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [candidate], { encoding: 'utf8' });
    const path = located.status === 0 ? located.stdout.split(/\r?\n/).find(Boolean) : undefined;
    if (path) return realpathSync(path.trim());
  }
  return undefined;
}

afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }); });

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'elanous-install-ps1-test-'));
  fixtures.push(directory);
  return directory;
}

function requiredFromCatalog(tier: string): string[] {
  const lines = readFileSync(join(repoRoot, 'catalog/external-commands.yaml'), 'utf8').split('\n');
  return lines.flatMap((line, index) => line.includes(`tier: ${tier}`) ? [lines[index - 1]?.match(/name:\s*(\S+)/)?.[1] ?? ''] : []).filter(Boolean).sort();
}

function requiredFromBash(): string[] {
  return readFileSync(resolve(import.meta.dir, 'install.sh'), 'utf8').match(/REQUIRED_COMMANDS=\(([^)]*)\)/)?.[1].trim().split(/\s+/).sort() ?? [];
}

function run(args: string[], options: { home?: string; cwd?: string; path?: string; profile?: string; prefix?: string; script?: string; emptyProfile?: boolean; env?: Record<string, string> } = {}) {
  const home = options.home ?? fixture();
  const prefix = options.prefix ?? join(home, 'prefix');
  const profile = options.profile ?? join(home, 'profile.ps1');
  let script = options.script ?? installer;
  let scriptArgs = args;
  if (options.emptyProfile) {
    const wrapper = join(home, 'invoke-with-empty-profile.ps1');
    const scriptLiteral = script.replaceAll("'", "''");
    const argsLiteral = args.map((argument) => `'${argument.replaceAll("'", "''")}'`).join(' ');
    writeFileSync(wrapper, `$PROFILE = ''\n. '${scriptLiteral}' ${argsLiteral}\nexit $LASTEXITCODE\n`);
    script = wrapper;
    scriptArgs = [];
  }
  const result = spawnSync(shell!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...scriptArgs], {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ELANOUS_INSTALL_PREFIX: prefix, ELANOUS_POWERSHELL_PROFILE: profile, ELANOUS_INSTALL_BUN_SCRIPT: '', ELANOUS_INSTALL_NO_USER_PATH: '1', ELANOUS_INSTALL_LANG: 'en', ...(options.path ? { PATH: options.path } : {}), ...options.env },
  });
  return { home, prefix, profile, result };
}

function writeFakeBun(path: string, version: string): void {
  writeFileSync(path, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\n' '${version}'; exit 0; fi
if [ "$1" = "add" ]; then
  for argument in "$@"; do case "$argument" in *.tgz) archive="$argument" ;; esac; done
  [ -n "$archive" ] || exit 2
  mkdir -p node_modules/elanous
  tar -xzf "$archive" -C node_modules/elanous --strip-components=1
  exit $?
fi
exit 0
`);
  chmodSync(path, 0o755);
}

function commandStub(directory: string, name: string): void {
  if (process.platform === 'win32') {
    writeFileSync(join(directory, `${name}.cmd`), '@echo off\r\nexit /b 0\r\n');
    return;
  }
  const path = join(directory, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
}

function standalonePackage(home: string): string {
  const packageDir = join(home, 'staging', 'package');
  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'elanous', version: '1.0.0', bin: { elanous: 'bin/elanous.mjs' } }));
  writeFileSync(join(packageDir, 'bin', 'elanous.mjs'), 'console.log("1.0.0");\n');
  const archive = join(home, 'elanous.tgz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', join(home, 'staging'), 'package'], { encoding: 'utf8' });
  expect(packed.status, packed.stderr).toBe(0);
  return archive;
}

describe('scripts/install.ps1', () => {
  test('keeps exactly one Bun version placeholder for release substitution', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source.match(/__ELANOUS_BUN_VERSION__/g)).toHaveLength(1);
    expect(source).toContain("$bunVersion -eq ('__ELANOUS_' + 'BUN_VERSION__')");
  });

  test('uses the Bash installer required-command data and it matches the catalog', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain("Join-Path $scriptDir 'install.sh'");
    expect(source).toContain('Get-RequiredCommands $installerPath');
    expect(source).not.toMatch(/\$requiredCommands\s*=\s*@\(/);
    expect(source).toContain("return @('bun')");
    // The external-command catalog is the source of truth; Git is a capability, not a boot requirement.
    expect(requiredFromBash()).toEqual(requiredFromCatalog('required'));
    // Pin the boot contract as well as cross-platform parity; update this when that policy changes.
    expect(requiredFromBash()).toEqual(['bun']);
  });

  test('declares the four named installer parameters and append-only marker PATH contract', () => {
    const source = readFileSync(installer, 'utf8');
    for (const parameter of ['$Prefix', '$Source', '$NoModifyPath', '$Help']) expect(source).toContain(parameter);
    expect(source).toContain("$markerStart = '# >>> elanous installer PATH >>>'");
    expect(source).toContain("$markerEnd = '# <<< elanous installer PATH <<<'");
    expect(source).toContain('Add-Content -LiteralPath $profilePath');
    expect(source).toContain('if (-not $NoModifyPath)');
    expect(source).toContain("[Environment]::SetEnvironmentVariable('Path'");
    expect(source).toContain('ELANOUS_INSTALL_PREFIX');
    expect(source).toContain('Push-Location $repoRoot');
    expect(source).toContain(".Replace(\"'\", \"''\")");
    expect(source).toContain("node_modules\\elanous\\bin\\elanous.mjs");
    expect(source).not.toContain('node_modules\\.bin\\elanous.cmd');
    expect(source).toContain('installed elanous entrypoint missing');
  });

  // T7 — install.sh 와 같은 판 구조 · Windows PowerShell 5.1 함정 둘 (09-25 실물 Windows 11 · 5.1.26100 ⊕ 7.6.6 에서 잰 것).
  test('mirrors the install.sh versioned layout: versions folder, current junction, bin shim through current, non-state default prefix', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('Join-Path $Prefix "versions\\$versionName"');
    expect(source).toContain('New-Item -ItemType Junction');
    expect(source).toContain("if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail \"$Link exists and is not a symbolic link - refusing to replace it\" 1 }");
    expect(source).not.toContain('Remove-Item -LiteralPath $Link -Force -Recurse');
    expect(source).toContain('current\\node_modules\\elanous\\bin\\elanous.mjs');
    expect(source).toContain('$env:LOCALAPPDATA');
    expect(source).not.toMatch(/Join-Path \$HOME '\.elanous'/);
    expect(source).toContain('versionDir = "versions/$versionName"');
    // cache-first then registry — a fresh machine has an empty bun cache.
    expect(source).toContain('bun add --no-save --offline $installTarball');
    expect(source).toMatch(/& bun add --no-save \$installTarball/);
  });

  // Bare English Windows Server 2025 (2026-09-25): PowerShell 5.1 reads a BOM-less script in the ANSI code page — the
  // UTF-8 bytes of a non-ASCII sign include 0x94, a cp1252 closing quote, and the whole script failed to parse.
  test('standalone release download uses the selected URL and verifies SHA256SUMS before installing', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('$env:ELANOUS_RELEASE_BASE');
    expect(source).toContain('$env:ELANOUS_VERSION');
    expect(source).toContain("'/latest/download/'");
    expect(source).toContain("'/download/v'");
    expect(source).toContain("$packageUrl = $releaseDirectory + 'elanous.tgz'");
    expect(source).toContain("$checksumUrl = $releaseDirectory + 'SHA256SUMS'");
    expect(source).toContain('Get-FileHash -LiteralPath $installTarball -Algorithm SHA256');
    expect(source).toContain('if ($expected -ieq $actual) {');
    expect(source).toContain('Invoke-Quiet { tar -xzOf $installTarball package/package.json }');
    expect(source).toContain("$releaseVerified = ($packageManifest.name -eq 'elanous' -and $manifestVersion");
    expect(source).toContain('if ($releaseVerified)');
    expect(source).toContain('$metadataSource = $packageUrl');
    expect(source).toContain('elanous release download failed from GitHub and npm registry');
    expect(source).toContain('$registryMetadata.dist.integrity');
  });

  test('is pure ASCII so Windows PowerShell 5.1 parses it under any system code page', () => {
    const bytes = readFileSync(installer);
    const offenders = [...bytes.entries()].filter(([, byte]) => byte > 0x7f).map(([index]) => index);
    expect(offenders).toEqual([]);
  });

  test('guards the two Windows PowerShell 5.1 traps: native stderr under Stop, and $null from an empty file', () => {
    const source = readFileSync(installer, 'utf8');
    // 5.1 turned `git rev-parse` stderr (not a git repo) into a terminating error — every -Source install died there.
    expect(source).toContain('Invoke-Quiet { git -C $repoRoot rev-parse HEAD }');
    expect(source).not.toMatch(/\(& git -C \$repoRoot rev-parse HEAD 2>\$null\)\.Trim\(\)/);
    // 5.1 `Get-Content -Raw` of a freshly created empty profile is $null — `.Contains` then threw.
    expect(source).toContain('[IO.File]::ReadAllText($Path)');
  });

  test('marks the Windows shim and checks ownership before writing the short command', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('rem elanous-wrapper');
    expect(source).toContain("Join-Path $binDirectory 'eln.cmd'");
    expect(source).toContain('not installer-owned; refusing to overwrite or claim it');
    expect(source).toContain('[StringComparison]::OrdinalIgnoreCase');
    expect(source).toContain('Set-Content -LiteralPath $elnShim -Value $shimContent');
  });

  windowsExecutionTest('Windows execution: eln.cmd calls the same entrypoint and leaves an existing foreign shim untouched', () => {
    const home = fixture();
    const prefix = join(home, 'prefix');
    const source = standalonePackage(home);
    const first = run(['-NoModifyPath', '-Source', source], { home, prefix });
    expect(first.result.status, first.result.stderr).toBe(0);
    const bin = join(prefix, 'bin');
    const eln = join(bin, 'eln.cmd');
    const elanous = join(bin, 'elanous.cmd');
    expect(readFileSync(eln, 'utf8')).toBe(readFileSync(elanous, 'utf8'));
    const short = spawnSync(eln, ['--version'], { shell: true, encoding: 'utf8' });
    const full = spawnSync(elanous, ['--version'], { shell: true, encoding: 'utf8' });
    expect(short.status, short.stderr).toBe(0);
    expect(short.stdout).toBe(full.stdout);
    writeFileSync(eln, '@echo off\r\necho other\r\n');
    const again = run(['-NoModifyPath', '-Source', source], { home, prefix });
    expect(again.result.status).not.toBe(successfulExitStatus);
    expect(again.result.stderr).toContain('not installer-owned; refusing to overwrite or claim it');
    expect(readFileSync(eln, 'utf8')).toBe('@echo off\r\necho other\r\n');
  }, 120_000);

  executionTest('PowerShell execution (skipped when pwsh or powershell is unavailable): --Help exits successfully and names every supported argument', () => {
    const { result } = run(['--Help']);
    expect(result.status, result.stderr).toBe(0);
    for (const argument of ['Prefix', 'Source', 'NoModifyPath', 'Help']) expect(result.stdout).toContain(argument);
  });

  test('decodes the Korean success template before formatting a Windows path', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain("$installedMessage = Say 'Installed elanous {0} at {1}'");
    expect(source).toContain('Write-Output ($installedMessage -f $version, $shimPath)');
    expect(source).not.toMatch(/Say[^\r\n)]*\$shimPath/);
  });

  test('Bun bootstrap, opt-out, git next step and locale have explicit runtime paths', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('$githubUrl = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-windows-x64.zip"');
    expect(source).toContain('https://registry.npmjs.org/@oven%2fbun-windows-x64/$bunVersion');
    expect(source).toContain('Test-Sha512Integrity $npmArchive $npmIntegrity');
    expect(source).toContain('downloaded bun version mismatch');
    expect(source).toContain("$bunUserBin = if ($installerUserHome) { Join-Path (Join-Path $installerUserHome '.bun') 'bin' } else { $null }");
    expect(source).toContain('$runtimeDataHome = Resolve-InstallerDataHome');
    expect(source).toContain('function Resolve-InstallerProfilePath');
    expect(source).toContain('Join-Path $bunBin $bunVersion');
    expect(source).toContain('custom ELANOUS_RELEASE_BASE download or checksum verification failed');
    expect(source).toContain("$registryMetadataUrl = 'https://registry.npmjs.org/elanous' + $registryVersion");
    expect(source).toContain('Test-Sha512Integrity $installTarball $registryIntegrity');
    expect(source).toContain('Invoke-DownloadWithRetry $githubUrl $githubArchive');
    expect(source).toContain('Invoke-DownloadWithRetry $npmUrl $npmArchive');
    expect(source).toContain('Get-FileHash -LiteralPath $githubArchive -Algorithm SHA256');
    expect(source).toContain('SHASUMS256.txt');
    expect(source).toContain("$bunVersion = '__ELANOUS_BUN_VERSION__'");
    expect(source).toContain("Join-Path $repoRoot '.bun-version'");
    expect(source).toContain("$env:PATH = $bunUserBin + [IO.Path]::PathSeparator + $env:PATH");
    expect(source).toContain("if ($NoBootstrapBun)");
    expect(source).toContain('$env:PATH = $bunBin + [IO.Path]::PathSeparator + $pathBeforeBun');
    expect(source).toContain("Fail \"required command missing: $command\" 127");
    expect(source).toContain("if ($installLang -eq 'ko')");
    expect(source).toContain('https://git-scm.com/download/win');
    expect(source).not.toContain('winget install');
    expect(source).toContain("$missing = if ($missingGit -and -not $isCheckout) { 'git(next step)' }");
    expect(source).toContain('bootstrapped: $bootstrapped; missing: $missing');
  });

  test('refuses Windows on ARM64 before touching the prefix or the profile (WIN-ARM64-VM-TRIAL)', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('$env:PROCESSOR_ARCHITEW6432');
    expect(source).toContain("$osArchitecture -eq 'ARM64'");
    expect(source).toContain("Fail (Say 'Windows on ARM (ARM64) is not supported yet");
    expect(source).toContain("') 78");
    expect(source).toContain('no Windows ARM64 build');
    expect(source).toContain('WIN-ARM64-VM-TRIAL');
    // the gate needs the language setup above it (Say reads $installLang) and must stay above the
    // first filesystem write so a refused host never leaves a prefix or profile behind.
    const gate = source.indexOf("$osArchitecture -eq 'ARM64'");
    expect(gate).toBeGreaterThan(source.indexOf('$installLang = if ($installLang -match'));
    expect(gate).toBeLessThan(source.indexOf('New-Item -ItemType Directory -Force -Path $Prefix'));
  });

  test('resolves a scrubbed environment block through RuntimeInformation before the ARM64 refusal (WIN-ARM64-VM-TRIAL)', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain("if (-not $osArchitecture -and $env:OS -eq 'Windows_NT')");
    expect(source).toContain('[System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture');
    expect(source).toContain('.ToUpperInvariant()');
    // a type-resolution failure on pre-4.7.1 .NET must leave the gate exactly as before, not add a failure mode
    expect(source).toContain('} catch { $osArchitecture = $null }');
    // the environment variables stay authoritative: the fallback sits after them and before the ARM64 refusal
    const fallback = source.indexOf('[System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture');
    expect(fallback).toBeGreaterThan(source.indexOf('if (-not $osArchitecture) { $osArchitecture = $env:PROCESSOR_ARCHITECTURE }'));
    expect(fallback).toBeLessThan(source.indexOf("$osArchitecture -eq 'ARM64'"));
  });

  executionTest('PowerShell execution: checkout still requires git before modifying the prefix or profile', () => {
    const home = fixture();
    const commandPath = join(home, 'commands');
    mkdirSync(commandPath);
    commandStub(commandPath, 'bun');
    const profile = join(home, 'new-profile.ps1');
    const { prefix, result } = run(['-NoModifyPath'], { home, profile, path: commandPath });
    expect(result.status, result.stderr).toBe(127);
    expect(result.stderr).toContain('required command missing: git');
    expect(existsSync(prefix)).toBe(false);
    expect(existsSync(profile)).toBe(false);
  });


  nonWindowsExecutionTest('standalone source uses an installed Bun when the release version placeholder is not embedded', () => {
    const home = fixture();
    const commands = join(home, 'commands');
    mkdirSync(commands);
    const bun = join(commands, 'bun');
    writeFakeBun(bun, '1.4.2');
    const source = standalonePackage(home);
    const standaloneInstaller = join(home, 'install.ps1');
    writeFileSync(standaloneInstaller, readFileSync(installer, 'utf8'));
    const { prefix, result } = run(['-Source', source, '-NoModifyPath'], {
      home,
      script: standaloneInstaller,
      path: `${commands}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('pinned Bun version is missing or invalid');
    expect(result.stdout).toContain('Installed elanous 1.0.0');
    expect(existsSync(join(prefix, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs'))).toBe(true);
  });

  nonWindowsExecutionTest('PowerShell simulation: retries 504, rejects a wrong-version Bun and invalid GitHub app archive, then falls back to npm', () => {
    const home = fixture();
    const source = standalonePackage(home);
    const standaloneInstaller = join(home, 'install.ps1');
    writeFileSync(standaloneInstaller, readFileSync(installer, 'utf8').replace('__ELANOUS_BUN_VERSION__', '1.4.2'));
    const npmFixture = join(home, 'bun-npm.tgz');
    const githubBunArchive = join(home, 'bun-github.zip');
    const githubBun = join(home, 'bun-github.exe');
    writeFileSync(githubBunArchive, 'mock GitHub Bun zip');
    writeFakeBun(githubBun, '9.9.9');
    const githubAppArchive = join(home, 'elanous-github.tgz');
    writeFileSync(githubAppArchive, 'not a tarball');
    const githubAppChecksums = join(home, 'elanous-SHA256SUMS');
    writeFileSync(githubAppChecksums, `${createHash('sha256').update(readFileSync(githubAppArchive)).digest('hex')}  elanous.tgz\n`);
    const userBun = join(home, '.bun', 'bin', 'bun.exe');
    mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
    writeFakeBun(userBun, '9.9.9');
    const originalUserBun = readFileSync(userBun, 'utf8');
    const bunChecksumFixture = join(home, 'bun-SHASUMS256.txt');
    writeFileSync(bunChecksumFixture, `${createHash('sha256').update(readFileSync(githubBunArchive)).digest('hex')}  bun-windows-x64.zip\n`);
    const registryMetadata = join(home, 'elanous-npm-metadata.json');
    const registryTarballUrl = 'https://registry.npmjs.org/elanous/-/elanous-1.0.0.tgz';
    writeFileSync(registryMetadata, JSON.stringify({ dist: { tarball: registryTarballUrl, integrity: `sha512-${createHash('sha512').update(readFileSync(source)).digest('base64')}` } }));
    const npmRoot = join(home, 'npm', 'package', 'bin');
    mkdirSync(npmRoot, { recursive: true });
    const fakeBun = join(npmRoot, 'bun.exe');
    writeFakeBun(fakeBun, '1.4.2');
    const packed = spawnSync('tar', ['-czf', npmFixture, '-C', join(home, 'npm'), 'package'], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    writeFileSync(join(home, 'bun-npm-metadata.json'), JSON.stringify({ dist: { tarball: 'https://registry.npmjs.org/@oven/bun-windows-x64/-/bun-windows-x64-1.4.2.tgz', integrity: `sha512-${createHash('sha512').update(readFileSync(npmFixture)).digest('base64')}` } }));
    const wrapper = join(home, 'simulate.ps1');
    const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    writeFileSync(wrapper, [
      '$global:bunGithubAttempts = 0',
      '$global:appGithubAttempts = 0',
      '$global:registryFallbacks = 0',
      'function Invoke-WebRequest { param([string] $Uri, [string] $OutFile, [switch] $UseBasicParsing)',
      "function Expand-Archive { param([string] $LiteralPath, [string] $DestinationPath, [switch] $Force); New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null; $fakeBun = Join-Path $DestinationPath 'bun.exe'; Copy-Item -LiteralPath $env:ELANOUS_TEST_GITHUB_BUN -Destination $fakeBun; if ($env:OS -ne 'Windows_NT') { & chmod +x $fakeBun } }",
      "  if ($Uri -like 'https://github.com/oven-sh/bun/*/SHASUMS256.txt') { Copy-Item -LiteralPath $env:ELANOUS_TEST_BUN_CHECKSUMS -Destination $OutFile; return }",
      "  if ($Uri -like 'https://github.com/oven-sh/bun/*/bun-windows-x64.zip') { $global:bunGithubAttempts++; if ($global:bunGithubAttempts -le 2) { throw 'HTTP 504 Gateway Timeout' }; Copy-Item -LiteralPath $env:ELANOUS_TEST_BUN_GITHUB_ARCHIVE -Destination $OutFile; return }",
      "  if ($Uri -like 'https://github.com/ElanvitalAI/elanous/releases/*/SHA256SUMS') { Copy-Item -LiteralPath $env:ELANOUS_TEST_APP_CHECKSUMS -Destination $OutFile; return }",
      "  if ($Uri -like 'https://github.com/ElanvitalAI/elanous/releases/*/elanous.tgz') { $global:appGithubAttempts++; if ($global:appGithubAttempts -le 2) { throw 'HTTP 504 Gateway Timeout' }; Copy-Item -LiteralPath $env:ELANOUS_TEST_APP_GITHUB_ARCHIVE -Destination $OutFile; return }",
      "  if ($Uri -eq 'https://registry.npmjs.org/@oven%2fbun-windows-x64/1.4.2') { $global:registryFallbacks++; Copy-Item -LiteralPath $env:ELANOUS_TEST_BUN_METADATA -Destination $OutFile; return }",
      "  if ($Uri -like 'https://registry.npmjs.org/@oven/bun-windows-x64/*') { $global:registryFallbacks++; Copy-Item -LiteralPath $env:ELANOUS_TEST_NPM_TARBALL -Destination $OutFile; return }",
      "  if ($Uri -eq 'https://registry.npmjs.org/elanous/latest') { $global:registryFallbacks++; Copy-Item -LiteralPath $env:ELANOUS_TEST_ELANOUS_METADATA -Destination $OutFile; return }",
      "  if ($Uri -eq 'https://registry.npmjs.org/elanous/-/elanous-1.0.0.tgz') { $global:registryFallbacks++; Copy-Item -LiteralPath $env:ELANOUS_TEST_ELANOUS_TARBALL -Destination $OutFile; return }",
      '  throw "unexpected URL: $Uri"',
      '}',
      '& ' + quote(standaloneInstaller) + ' -Prefix ' + quote(join(home, 'prefix')) + ' -NoModifyPath',
      'Write-Output "SIM_BUN_GITHUB_ATTEMPTS=$global:bunGithubAttempts"',
      'Write-Output "SIM_APP_GITHUB_ATTEMPTS=$global:appGithubAttempts"',
      'Write-Output "SIM_REGISTRY_FALLBACKS=$global:registryFallbacks"',
    ].join('\n'));
    const result = spawnSync(shell!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32` : '/usr/bin:/bin', ELANOUS_TEST_NPM_TARBALL: npmFixture, ELANOUS_TEST_BUN_GITHUB_ARCHIVE: githubBunArchive, ELANOUS_TEST_GITHUB_BUN: githubBun, ELANOUS_TEST_APP_GITHUB_ARCHIVE: githubAppArchive, ELANOUS_TEST_APP_CHECKSUMS: githubAppChecksums, LOCALAPPDATA: join(home, 'local-app-data'), ELANOUS_TEST_BUN_CHECKSUMS: bunChecksumFixture, ELANOUS_TEST_BUN_METADATA: join(home, 'bun-npm-metadata.json'), ELANOUS_TEST_ELANOUS_METADATA: registryMetadata, ELANOUS_TEST_ELANOUS_TARBALL: source, ELANOUS_INSTALL_RETRY_DELAY_SECONDS: '0', ELANOUS_INSTALL_NO_USER_PATH: '1', ELANOUS_INSTALL_LANG: 'en' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('SIM_BUN_GITHUB_ATTEMPTS=3');
    expect(result.stdout).toContain('SIM_APP_GITHUB_ATTEMPTS=3');
    expect(result.stdout).toContain('SIM_REGISTRY_FALLBACKS=4');
    expect(result.stdout + result.stderr).not.toContain('GitHub and npm registry');
    expect(existsSync(join(home, 'prefix', 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs'))).toBe(true);
    const installedShim = readFileSync(join(home, 'prefix', 'bin', 'elanous.cmd'), 'utf8');
    expect(installedShim).toContain(join(home, 'local-app-data', 'Elanous', 'runtime', 'bun', '1.4.2', 'bun'));
    expect(readFileSync(userBun, 'utf8')).toBe(originalUserBun);

    writeFileSync(registryMetadata, JSON.stringify({ dist: { tarball: registryTarballUrl, integrity: 'sha512-AAAA' } }));
    const rejectedPrefix = join(home, 'rejected-app-prefix');
    const rejectedWrapper = join(home, 'simulate-bad-app-integrity.ps1');
    writeFileSync(rejectedWrapper, readFileSync(wrapper, 'utf8').replace(quote(join(home, 'prefix')), quote(rejectedPrefix)));
    const rejected = spawnSync(shell!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', rejectedWrapper], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32` : '/usr/bin:/bin', ELANOUS_TEST_NPM_TARBALL: npmFixture, ELANOUS_TEST_BUN_GITHUB_ARCHIVE: githubBunArchive, ELANOUS_TEST_GITHUB_BUN: githubBun, ELANOUS_TEST_APP_GITHUB_ARCHIVE: githubAppArchive, ELANOUS_TEST_APP_CHECKSUMS: githubAppChecksums, LOCALAPPDATA: join(home, 'local-app-data'), ELANOUS_TEST_BUN_CHECKSUMS: bunChecksumFixture, ELANOUS_TEST_BUN_METADATA: join(home, 'bun-npm-metadata.json'), ELANOUS_TEST_ELANOUS_METADATA: registryMetadata, ELANOUS_TEST_ELANOUS_TARBALL: source, ELANOUS_INSTALL_RETRY_DELAY_SECONDS: '0', ELANOUS_INSTALL_NO_USER_PATH: '1', ELANOUS_INSTALL_LANG: 'en' },
    });
    expect(rejected.stderr).toContain('elanous npm registry tarball SHA512 integrity mismatch');
    expect(existsSync(join(rejectedPrefix, 'current'))).toBe(false);
    expect(existsSync(join(rejectedPrefix, 'versions'))).toBe(false);

    writeFileSync(registryMetadata, JSON.stringify({ dist: { tarball: registryTarballUrl, integrity: `sha512-${createHash('sha512').update(readFileSync(source)).digest('base64')}` } }));
    const customPrefix = join(home, 'custom-release-prefix');
    const customWrapper = join(home, 'simulate-custom-release.ps1');
    writeFileSync(customWrapper, readFileSync(wrapper, 'utf8').replace(quote(join(home, 'prefix')), quote(customPrefix)));
    const custom = spawnSync(shell!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', customWrapper], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'local-app-data'), PATH: process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32` : '/usr/bin:/bin', ELANOUS_TEST_NPM_TARBALL: npmFixture, ELANOUS_TEST_BUN_CHECKSUMS: bunChecksumFixture, ELANOUS_TEST_BUN_METADATA: join(home, 'bun-npm-metadata.json'), ELANOUS_TEST_ELANOUS_METADATA: registryMetadata, ELANOUS_TEST_ELANOUS_TARBALL: source, ELANOUS_INSTALL_RETRY_DELAY_SECONDS: '0', ELANOUS_INSTALL_NO_USER_PATH: '1', ELANOUS_INSTALL_LANG: 'en', ELANOUS_RELEASE_BASE: 'https://mirror.example/releases' },
    });
    expect(custom.stderr).toContain('custom ELANOUS_RELEASE_BASE download or checksum verification failed');
    expect(existsSync(join(customPrefix, 'current'))).toBe(false);
    expect(existsSync(join(customPrefix, 'versions'))).toBe(false);
  }, 120_000);

  nonWindowsExecutionTest('PowerShell rejects mismatched GitHub and npm Bun checksums before archive extraction', () => {
    const home = fixture();
    const standaloneInstaller = join(home, 'install.ps1');
    writeFileSync(standaloneInstaller, readFileSync(installer, 'utf8').replace('__ELANOUS_BUN_VERSION__', '1.4.2'));
    const npmRoot = join(home, 'npm', 'package', 'bin');
    mkdirSync(npmRoot, { recursive: true });
    writeFakeBun(join(npmRoot, 'bun.exe'), '1.4.2');
    const npmTarball = join(home, 'bun.tgz');
    const packed = spawnSync('tar', ['-czf', npmTarball, '-C', join(home, 'npm'), 'package'], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    const metadata = join(home, 'bun-metadata.json');
    writeFileSync(metadata, JSON.stringify({ dist: { tarball: 'https://registry.npmjs.org/@oven/bun-windows-x64/-/bun-windows-x64-1.4.2.tgz', integrity: 'sha512-AAAA' } }));
    const checksums = join(home, 'bad-SHASUMS256.txt');
    writeFileSync(checksums, `${'0'.repeat(64)}  bun-windows-x64.zip\n`);
    const wrapper = join(home, 'simulate-bad-bun-integrity.ps1');
    const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    writeFileSync(wrapper, [
      '$global:expandCalls = 0',
      'function Expand-Archive { $global:expandCalls++; throw "archive must not be expanded" }',
      'function Invoke-WebRequest { param([string] $Uri, [string] $OutFile, [switch] $UseBasicParsing)',
      "  if ($Uri -like 'https://github.com/oven-sh/bun/*/SHASUMS256.txt') { Copy-Item -LiteralPath $env:ELANOUS_TEST_BUN_CHECKSUMS -Destination $OutFile; return }",
      "  if ($Uri -like 'https://github.com/oven-sh/bun/*/bun-windows-x64.zip') { [IO.File]::WriteAllText($OutFile, 'untrusted archive'); return }",
      "  if ($Uri -eq 'https://registry.npmjs.org/@oven%2fbun-windows-x64/1.4.2') { Copy-Item -LiteralPath $env:ELANOUS_TEST_BUN_METADATA -Destination $OutFile; return }",
      "  if ($Uri -eq 'https://registry.npmjs.org/@oven/bun-windows-x64/-/bun-windows-x64-1.4.2.tgz') { Copy-Item -LiteralPath $env:ELANOUS_TEST_BUN_TARBALL -Destination $OutFile; return }",
      '  throw "unexpected URL: $Uri"',
      '}',
      '& ' + quote(standaloneInstaller) + ' -Prefix ' + quote(join(home, 'prefix')) + ' -NoModifyPath',
      'Write-Output "SIM_EXPAND_CALLS=$global:expandCalls"',
    ].join('\n'));
    const result = spawnSync(shell!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32` : '/usr/bin:/bin', ELANOUS_TEST_BUN_CHECKSUMS: checksums, ELANOUS_TEST_BUN_METADATA: metadata, ELANOUS_TEST_BUN_TARBALL: npmTarball, ELANOUS_INSTALL_RETRY_DELAY_SECONDS: '0', ELANOUS_INSTALL_NO_USER_PATH: '1', ELANOUS_INSTALL_LANG: 'en' },
    });
    expect(result.stderr).toContain('bun 1.4.2 npm tarball SHA512 integrity mismatch');
    expect(result.stdout).toContain('SIM_EXPAND_CALLS=0');
    expect(existsSync(join(home, 'prefix'))).toBe(false);
  }, 120_000);

  nonWindowsExecutionTest('PowerShell rejects a checksum-valid npm Bun binary with the wrong pinned version', () => {
    const home = fixture();
    const requestedVersion = '0.0.0-test';
    const standaloneInstaller = join(home, 'install.ps1');
    writeFileSync(standaloneInstaller, readFileSync(installer, 'utf8').replace('__ELANOUS_BUN_VERSION__', requestedVersion));
    const npmRoot = join(home, 'npm', 'package', 'bin');
    mkdirSync(npmRoot, { recursive: true });
    const npmExecutable = join(npmRoot, 'bun.exe');
    writeFakeBun(npmExecutable, '1.4.2');
    const npmTarball = join(home, 'bun.tgz');
    const packed = spawnSync('tar', ['-czf', npmTarball, '-C', join(home, 'npm'), 'package'], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    const metadata = join(home, 'bun-metadata.json');
    writeFileSync(metadata, JSON.stringify({ dist: { tarball: `https://registry.npmjs.org/@oven/bun-windows-x64/-/bun-windows-x64-${requestedVersion}.tgz`, integrity: `sha512-${createHash('sha512').update(readFileSync(npmTarball)).digest('base64')}` } }));
    const wrapper = join(home, 'simulate-wrong-version.ps1');
    const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    writeFileSync(wrapper, [
      'function Invoke-WebRequest { param([string] $Uri, [string] $OutFile, [switch] $UseBasicParsing)',
      "  if ($Uri -like 'https://github.com/oven-sh/bun/*') { throw 'HTTP 504 Gateway Timeout' }",
      "  if ($Uri -eq 'https://registry.npmjs.org/@oven%2fbun-windows-x64/0.0.0-test') { Copy-Item -LiteralPath $env:ELANOUS_TEST_BUN_METADATA -Destination $OutFile; return }",
      "  if ($Uri -eq 'https://registry.npmjs.org/@oven/bun-windows-x64/-/bun-windows-x64-0.0.0-test.tgz') { Copy-Item -LiteralPath $env:ELANOUS_TEST_BUN_TARBALL -Destination $OutFile; return }",
      '  throw "unexpected URL: $Uri"',
      '}',
      '& ' + quote(standaloneInstaller) + ' -Prefix ' + quote(join(home, 'prefix')) + ' -NoModifyPath',
    ].join('\n'));
    const result = spawnSync(shell!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32` : '/usr/bin:/bin', ELANOUS_TEST_BUN_METADATA: metadata, ELANOUS_TEST_BUN_TARBALL: npmTarball, ELANOUS_INSTALL_RETRY_DELAY_SECONDS: '0', ELANOUS_INSTALL_NO_USER_PATH: '1', ELANOUS_INSTALL_LANG: 'en' },
    });
    expect(result.stderr).toContain(`downloaded bun version mismatch: expected ${requestedVersion}`);
    expect(existsSync(join(home, 'prefix'))).toBe(false);
  }, 120_000);

  executionTest('PowerShell refuses to replace an ordinary current directory and preserves its contents', () => {
    const home = fixture();
    const prefix = join(home, 'prefix');
    const testBin = process.platform === 'win32' ? undefined : join(home, 'test-bin');
    if (testBin) {
      mkdirSync(testBin, { recursive: true });
      writeFakeBun(join(testBin, 'bun'), readFileSync(join(repoRoot, '.bun-version'), 'utf8').trim());
    }
    const current = join(prefix, 'current');
    mkdirSync(current, { recursive: true });
    const sentinel = join(current, 'keep.txt');
    writeFileSync(sentinel, 'preserve me');
    const source = standalonePackage(home);
    const { result } = run(['-NoModifyPath', '-Source', source], {
      home, prefix,
      ...(testBin ? { path: [testBin, process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':') } : {}),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to replace it');
    expect(readFileSync(sentinel, 'utf8')).toBe('preserve me');
  }, 120_000);

  executionTest('PowerShell execution: an ARM64 host is refused with exit 78 before any file is written', () => {
    const architectures: Record<string, string>[] = [
      { PROCESSOR_ARCHITECTURE: 'ARM64' },
      { PROCESSOR_ARCHITECTURE: 'x86', PROCESSOR_ARCHITEW6432: 'ARM64' },
    ];
    for (const architecture of architectures) {
      const home = fixture();
      const prefix = join(home, 'prefix');
      const profile = join(home, 'profile.ps1');
      const { result } = run([], { home, prefix, profile, env: architecture });
      expect(result.status, result.stderr).toBe(78);
      expect(result.stderr).toContain('not supported yet');
      expect(result.stderr).toContain('no Windows ARM64 build');
      expect(existsSync(prefix)).toBe(false);
      expect(existsSync(profile)).toBe(false);
    }
  });

  executionTest('PowerShell execution: an x64 host still passes the ARM64 gate unchanged', () => {
    const architectures: Record<string, string>[] = [
      { PROCESSOR_ARCHITECTURE: 'AMD64' },
      { PROCESSOR_ARCHITECTURE: 'x86', PROCESSOR_ARCHITEW6432: 'AMD64' },
    ];
    for (const architecture of architectures) {
      const home = fixture();
      const commandPath = join(home, 'commands');
      mkdirSync(commandPath);
      commandStub(commandPath, 'bun');
      const profile = join(home, 'new-profile.ps1');
      const { result } = run(['-NoModifyPath'], { home, profile, path: commandPath, env: architecture });
      expect(result.status, result.stderr).toBe(127);
      expect(result.stderr).toContain('required command missing: git');
    }
  });

  executionTest('PowerShell execution: an empty architecture environment falls back to RuntimeInformation on Windows and keeps the pre-fallback gate elsewhere (WIN-ARM64-VM-TRIAL)', () => {
    // Both PROCESSOR_* variables empty exercises the third tier: on Windows RuntimeInformation resolves
    // the real architecture (an ARM64 PowerShell is refused with 78); elsewhere the Windows_NT guard
    // skips the fallback and the gate keeps its pre-fallback behavior, so the git preflight stops the run.
    const probe = spawnSync(shell!, ['-NoProfile', '-Command', '[System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture'], { encoding: 'utf8' });
    const refused = process.platform === 'win32' && probe.status === 0 && probe.stdout.trim() === 'Arm64';
    const home = fixture();
    const commandPath = join(home, 'commands');
    mkdirSync(commandPath);
    commandStub(commandPath, 'bun');
    const { prefix, result } = run(['-NoModifyPath'], { home, prefix: join(home, 'scrubbed-prefix'), profile: join(home, 'scrubbed.ps1'), path: commandPath, env: { PROCESSOR_ARCHITECTURE: '', PROCESSOR_ARCHITEW6432: '' } });
    expect(result.status, result.stderr).toBe(refused ? 78 : 127);
    expect(result.stderr).toContain(refused ? 'not supported yet' : 'required command missing: git');
    expect(existsSync(prefix)).toBe(false);
  });

  windowsExecutionTest('standalone with no git or Bun bootstraps once and installs with a Korean path intact', () => {
    const home = fixture();
    const isolated = join(home, 'standalone');
    mkdirSync(isolated);
    copyFileSync(installer, join(isolated, 'install.ps1'));
    const source = standalonePackage(home);
    const bootstrap = join(home, 'bootstrap.ps1');
    const calls = join(home, 'bootstrap-calls');
    writeFileSync(bootstrap, `Add-Content -LiteralPath '${calls.replaceAll("'", "''")}' -Value 'called'\nNew-Item -ItemType Directory -Force -Path (Join-Path $HOME '.bun/bin') | Out-Null\nCopy-Item -LiteralPath '${process.execPath.replaceAll("'", "''")}' -Destination (Join-Path $HOME '.bun/bin/bun.exe')\n$env:PATH = Join-Path $HOME 'user-path-only'\n`); // like bun's install.ps1: session PATH reset to the user PATH (WIN2 bare VM 10-02)
    const prefix = join(home, 'Users', 'new-install');
    const options = { home, prefix, script: join(isolated, 'install.ps1'), path: join(process.env.SystemRoot!, 'System32'), env: { ELANOUS_INSTALL_BUN_SCRIPT: bootstrap, ELANOUS_INSTALL_LANG: 'ko' } };
    const first = run(['-NoModifyPath', '-Source', source], options);
    expect(first.result.status, first.result.stderr).toBe(0);
    const successLine = first.result.stdout.split(/\r?\n/).find(line => line.includes('elanous 1.0.0'));
    expect(successLine).toContain(join(prefix, 'bin', 'elanous.cmd'));
    expect(first.result.stdout).toContain('bootstrapped: bun; missing: git(next step)');
    expect(first.result.stdout).toContain('winget install --id Git.Git -e');
    const shim = join(prefix, 'bin', 'elanous.cmd');
    expect(existsSync(shim)).toBe(true);
    const version = spawnSync(shim, ['--version'], { shell: true, encoding: 'utf8' });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout).toContain('1.0.0');
    expect(readFileSync(calls, 'utf8').trim().split(/\r?\n/)).toHaveLength(1);
    const second = run(['-NoModifyPath', '-Source', source], options);
    expect(second.result.status, second.result.stderr).toBe(0);
    expect(second.result.stdout).toContain('bootstrapped: none; missing: git(next step)');
    expect(readFileSync(calls, 'utf8').trim().split(/\r?\n/)).toHaveLength(1);
  }, 120_000);

  windowsExecutionTest('standalone with Bun and no git completes without bootstrapping', () => {
    const home = fixture();
    const standalone = join(home, 'standalone');
    mkdirSync(standalone);
    copyFileSync(installer, join(standalone, 'install.ps1'));
    const source = standalonePackage(home);
    const bootstrap = join(home, 'bootstrap.ps1');
    const calls = join(home, 'bootstrap-calls');
    writeFileSync(bootstrap, `Set-Content -LiteralPath '${calls.replaceAll("'", "''")}' -Value 'called'\n`);
    const bunBin = join(home, '.bun', 'bin');
    mkdirSync(bunBin, { recursive: true });
    copyFileSync(process.execPath, join(bunBin, 'bun.exe'));
    const { prefix, result } = run(['-NoModifyPath', '-Source', source], {
      home, script: join(standalone, 'install.ps1'), path: join(process.env.SystemRoot!, 'System32'), env: { ELANOUS_INSTALL_BUN_SCRIPT: bootstrap },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('bootstrapped: none; missing: git(next step)');
    expect(result.stdout).toContain('winget install --id Git.Git -e');
    expect(existsSync(join(prefix, 'bin', 'elanous.cmd'))).toBe(true);
    expect(existsSync(calls)).toBe(false);
  }, 120_000);

  windowsExecutionTest('standalone opt-out and failing Bun bootstrap leave the install untouched', () => {
    const home = fixture();
    const standalone = join(home, 'standalone');
    mkdirSync(standalone);
    copyFileSync(installer, join(standalone, 'install.ps1'));
    const bootstrap = join(home, 'bootstrap.ps1');
    writeFileSync(bootstrap, "throw 'injected bootstrap failure'\n");
    const options = { home, script: join(standalone, 'install.ps1'), path: join(process.env.SystemRoot!, 'System32'), env: { ELANOUS_INSTALL_BUN_SCRIPT: bootstrap } };
    for (const args of [['-NoBootstrapBun'], ['--no-bootstrap-bun'], []]) {
      const { prefix, profile, result } = run(args, options);
      expect(result.status, result.stderr).toBe(args.length ? 127 : 1);
      expect(result.stderr).toContain(args.length ? 'irm https://bun.sh/install.ps1 | iex' : 'bun bootstrap failed: injected bootstrap failure');
      expect(existsSync(prefix)).toBe(false);
      expect(existsSync(profile)).toBe(false);
    }
  });

  windowsExecutionTest('Windows PowerShell execution: default packaging from outside the repository installs a callable elanous.cmd and appends a PATH block without replacing existing profile content', () => {
    const home = fixture();
    const profile = join(home, 'profiles', 'profile.ps1');
    const prefix = join(home, "prefix $safe 'quoted'");
    const outside = fixture();
    mkdirSync(join(home, 'profiles'), { recursive: true });
    writeFileSync(profile, '$env:KEEP = 1\r\n');
    const installed = run(['-Prefix', prefix], { home, profile, cwd: outside });
    expect(installed.result.status, installed.result.stderr).toBe(0);
    const elanous = join(prefix, 'bin', 'elanous.cmd');
    expect(existsSync(elanous)).toBe(true);
    expect(readFileSync(elanous, 'utf8')).toContain('node_modules\\elanous\\bin\\elanous.mjs');
    const help = spawnSync(elanous, ['--help'], { cwd: outside, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('elanous');
    const metadata = JSON.parse(readFileSync(join(prefix, 'install.json'), 'utf8')) as Record<string, string>;
    expect(metadata.version).toBe(packageJson.version);
    expect(metadata.source).toBe(realpathSync(repoRoot));
    expect(metadata.installedAt).toBeTruthy();
    const startup = readFileSync(profile, 'utf8');
    expect(startup).toContain('$env:KEEP = 1');
    expect(startup).toContain('# >>> elanous installer PATH >>>');
    expect(startup).toContain('# <<< elanous installer PATH <<<');
    expect(startup).toContain("''quoted''");
    expect(startup).toContain('$safe');
    expect(startup.match(/^# >>> elanous installer PATH >>>$/gm)).toHaveLength(1);
  }, 120_000);

  windowsExecutionTest('PowerShell execution: empty profile is created for a normal install, while -NoModifyPath leaves a new profile absent', () => {
    const home = fixture();
    const profile = join(home, 'empty', 'profile.ps1');
    const normal = run([], { home, profile });
    expect(normal.result.status, normal.result.stderr).toBe(0);
    expect(existsSync(profile)).toBe(true);
    const startup = readFileSync(profile, 'utf8');
    expect(startup).toContain('# >>> elanous installer PATH >>>');
    expect(startup).toContain('# <<< elanous installer PATH <<<');

    const noModifyProfile = join(home, 'no-modify', 'profile.ps1');
    const noModify = run(['-NoModifyPath'], { home, profile: noModifyProfile, prefix: join(home, 'no-modify-prefix') });
    expect(noModify.result.status, noModify.result.stderr).toBe(0);
    expect(existsSync(noModifyProfile)).toBe(false);
  }, 120_000);

  executionTest('PowerShell simulation: empty USERPROFILE and $PROFILE use the LOCALAPPDATA fallback and expose the installed eln shim', () => {
    const home = fixture();
    const systemProfileHome = join(home, 'system-profile');
    const prefix = join(home, 'system-prefix');
    const earlierBin = join(home, 'earlier-bin');
    const testBin = process.platform === 'win32' ? undefined : join(home, 'test-bin');
    mkdirSync(earlierBin, { recursive: true });
    writeFileSync(join(earlierBin, 'eln.cmd'), '@echo off\r\necho older eln\r\n');
    if (testBin) {
      mkdirSync(testBin, { recursive: true });
      writeFakeBun(join(testBin, 'bun'), readFileSync(join(repoRoot, '.bun-version'), 'utf8').trim());
    }
    const localAppData = join(systemProfileHome, 'AppData', 'Local');
    const fallbackProfile = join(systemProfileHome, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
    const source = standalonePackage(home);
    const installed = run([], {
      home,
      prefix,
      profile: '',
      emptyProfile: true,
      path: [earlierBin, join(prefix, 'bin'), testBin, process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      env: { USERPROFILE: '', LOCALAPPDATA: localAppData, ELANOUS_POWERSHELL_PROFILE: '', ELANOUS_INSTALL_SOURCE: source },
    });
    const elnShim = join(prefix, 'bin', 'eln.cmd');
    expect(installed.result.status, installed.result.stderr).toBe(successfulExitStatus);
    expect(existsSync(fallbackProfile), installed.result.stdout).toBe(true);
    expect(readFileSync(fallbackProfile, 'utf8')).toContain('# >>> elanous installer PATH >>>');
    expect(existsSync(elnShim)).toBe(true);
    expect(installed.result.stdout).toContain(`ELN command: ${elnShim}`);
    expect(installed.result.stdout).toContain('ELN available on current PATH: True');
  });

  executionTest('PowerShell simulation: SYSTEM without USERPROFILE or LOCALAPPDATA installs under ProgramData and prints the eln shim path', () => {
    const home = fixture();
    const programData = join(home, 'ProgramData');
    const prefix = join(programData, 'elanous');
    const source = standalonePackage(home);
    const requestedVersion = readFileSync(join(repoRoot, '.bun-version'), 'utf8').trim();
    const bunArchive = join(home, 'bun-github.zip');
    const fakeBun = join(home, 'bun-github.exe');
    const checksums = join(home, 'bun-SHASUMS256.txt');
    writeFileSync(bunArchive, 'mock Bun archive');
    writeFakeBun(fakeBun, requestedVersion);
    writeFileSync(checksums, `${createHash('sha256').update(readFileSync(bunArchive)).digest('hex')}  bun-windows-x64.zip\n`);
    const wrapper = join(home, 'simulate-system-profile.ps1');
    const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    writeFileSync(wrapper, [
      'function Invoke-WebRequest { param([string] $Uri, [string] $OutFile, [switch] $UseBasicParsing)',
      "  if ($Uri -like 'https://github.com/oven-sh/bun/*/SHASUMS256.txt') { Copy-Item -LiteralPath $env:ELANOUS_TEST_BUN_CHECKSUMS -Destination $OutFile; return }",
      "  if ($Uri -like 'https://github.com/oven-sh/bun/*/bun-windows-x64.zip') { Copy-Item -LiteralPath $env:ELANOUS_TEST_BUN_GITHUB_ARCHIVE -Destination $OutFile; return }",
      '  throw "unexpected URL: $Uri"',
      '}',
      "function Expand-Archive { param([string] $LiteralPath, [string] $DestinationPath, [switch] $Force); New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null; $fakeBun = Join-Path $DestinationPath 'bun.exe'; Copy-Item -LiteralPath $env:ELANOUS_TEST_GITHUB_BUN -Destination $fakeBun; if ($env:OS -ne 'Windows_NT') { & chmod +x $fakeBun } }",
      '& ' + quote(installer) + ' -NoModifyPath',
    ].join('\n'));
    const installed = run([], {
      home,
      profile: '',
      emptyProfile: true,
      script: wrapper,
      path: process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32` : '/usr/bin:/bin',
      env: {
        HOME: '',
        USERPROFILE: '',
        LOCALAPPDATA: '',
        ProgramData: programData,
        ELANOUS_POWERSHELL_PROFILE: '',
        ELANOUS_INSTALL_PREFIX: '',
        ELANOUS_INSTALL_SOURCE: source,
        ELANOUS_TEST_BUN_GITHUB_ARCHIVE: bunArchive,
        ELANOUS_TEST_GITHUB_BUN: fakeBun,
        ELANOUS_TEST_BUN_CHECKSUMS: checksums,
      },
    });
    const elnShim = join(prefix, 'bin', 'eln.cmd');
    const installedBun = join(programData, 'Elanous', 'runtime', 'bun', requestedVersion, 'bun.exe');
    expect(installed.result.status, installed.result.stderr).toBe(successfulExitStatus);
    expect(existsSync(elnShim)).toBe(true);
    expect(existsSync(installedBun)).toBe(true);
    expect(installed.result.stdout).toContain(`ELN command: ${elnShim}`);
    expect(installed.result.stdout).toContain('ELN available on current PATH: True');
    expect(installed.result.stdout).toContain('bootstrapped: bun');
  });
});

// Runtime caller/wiring: Bun executes scripts/install-ps1.test.ts; run() invokes scripts/install.ps1 through spawnSync(shell, ['-File', installer, ...args]).
