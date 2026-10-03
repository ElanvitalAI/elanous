import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

const repoRoot = resolve(import.meta.dir, '..');
const installer = resolve(import.meta.dir, 'install.ps1');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
const shell = findPowerShell();
const executionTest = shell ? test : test.skip;
const windowsExecutionTest = process.platform === 'win32' && shell ? test : test.skip;
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

function run(args: string[], options: { home?: string; cwd?: string; path?: string; profile?: string; prefix?: string; script?: string; env?: Record<string, string> } = {}) {
  const home = options.home ?? fixture();
  const prefix = options.prefix ?? join(home, 'prefix');
  const profile = options.profile ?? join(home, 'profile.ps1');
  const result = spawnSync(shell!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', options.script ?? installer, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ELANOUS_INSTALL_PREFIX: prefix, ELANOUS_POWERSHELL_PROFILE: profile, ELANOUS_INSTALL_BUN_SCRIPT: '', ELANOUS_INSTALL_NO_USER_PATH: '1', ELANOUS_INSTALL_LANG: 'en', ...(options.path ? { PATH: options.path } : {}), ...options.env },
  });
  return { home, prefix, profile, result };
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
  test('uses the Bash installer required-command data and it matches the catalog', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain("Join-Path $scriptDir 'install.sh'");
    expect(source).toContain('Get-RequiredCommands $installerPath');
    expect(source).not.toMatch(/\$requiredCommands\s*=\s*@\(/);
    expect(source).toContain("return @('bun')");
    expect(requiredFromBash()).toEqual(requiredFromCatalog('required'));
    expect(requiredFromBash()).toEqual(['bun', 'git']);
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
    expect(source).toContain('checksum mismatch');
    expect(source).toContain('$metadataSource = $packageUrl');
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
    expect(source).toContain('Get-Command eln -ErrorAction SilentlyContinue');
    expect(source).toContain('Set-Content -LiteralPath $elnShim -Value $shimContent');
  });

  windowsExecutionTest('Windows execution: eln.cmd calls the same entrypoint and leaves an existing foreign shim untouched', () => {
    const home = fixture();
    const prefix = join(home, 'prefix');
    const first = run(['-NoModifyPath'], { home, prefix });
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
    const again = run(['-NoModifyPath'], { home, prefix });
    expect(again.result.status, again.result.stderr).toBe(0);
    expect(again.result.stdout).toContain('WARNING eln:');
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
    expect(source).toContain("(Invoke-WebRequest -UseBasicParsing -Uri 'https://bun.sh/install.ps1').Content");
    expect(source).toContain('ELANOUS_INSTALL_BUN_SCRIPT');
    expect(source).toContain("$env:PATH = $bunBin + [IO.Path]::PathSeparator + $env:PATH");
    expect(source).toContain("if ($NoBootstrapBun)");
    expect(source).toContain('$env:PATH = $bunBin + [IO.Path]::PathSeparator + $pathBeforeBun');
    expect(source).toContain("Fail \"required command missing: $command\" 127");
    expect(source).toContain("if ($installLang -eq 'ko')");
    expect(source).toContain("winget install --id Git.Git -e");
    expect(source).toContain("$missing = if ($missingGit -and -not $isCheckout) { 'git(next step)' }");
    expect(source).toContain('bootstrapped: $bootstrapped; missing: $missing');
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

  executionTest('PowerShell execution: empty profile is created for a normal install, while -NoModifyPath leaves a new profile absent', () => {
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
});

// Runtime caller/wiring: Bun executes scripts/install-ps1.test.ts; run() invokes scripts/install.ps1 through spawnSync(shell, ['-File', installer, ...args]).
