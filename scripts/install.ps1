[CmdletBinding()]
param(
  [string] $Prefix,
  [string] $Source,
  [switch] $NoModifyPath,
  [switch] $NoBootstrapBun,
  [switch] $Help,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $RemainingArgs
)

# Windows counterpart of scripts/install.sh - same layout:
# ASCII only: Windows PowerShell 5.1 reads a BOM-less script in the system ANSI code page, so a UTF-8 'no-entry sign' (E2 9B 94)
# becomes a cp1252 closing quote (0x94) on an English Windows and the parser fails (bare Server 2025, 2026-09-25).
#   $Prefix\versions\<version>[-<commit12>]\  one folder per build (own node_modules) - older builds stay (rollback)
#   $Prefix\current  -> versions\<...>         directory junction; switching builds = re-pointing one junction
#   $Prefix\bin\elanous.cmd -> current\...        the fixed path that goes on PATH
# The default prefix is NOT the state folder (~\.elanous) - installed files and state (auth, logs, worktrees) stay apart.

$ErrorActionPreference = 'Stop'

function Show-Usage {
  @'
Usage: powershell -File scripts/install.ps1 [-Prefix PATH] [-Source PATH.tgz|URL] [-NoModifyPath] [-NoBootstrapBun] [-Help]
       powershell -File scripts/install.ps1 [--prefix PATH] [--source PATH.tgz|URL] [--no-modify-path] [--no-bootstrap-bun] [--help]

Install elanous into a versioned layout.
  Prefix / --prefix               installation root (default: $ELANOUS_INSTALL_PREFIX or %LOCALAPPDATA%\elanous)
                                  layout: versions\<version>[-<commit12>]\ / current -> versions\... / bin\elanous.cmd
  Source / --source               install a package tarball (local path or http(s) URL; default: $ELANOUS_INSTALL_SOURCE,
                                  else pack the checkout or fetch the verified release when standalone)
  NoModifyPath / --no-modify-path do not append the elanous PATH block to the PowerShell profile
  NoBootstrapBun / --no-bootstrap-bun fail instead of installing bun when missing
  Help / --help                   show this help
'@ | Write-Output
}

function Fail([string] $Message, [int] $Code) {
  [Console]::Error.WriteLine("ERROR: $Message")
  exit $Code
}

# PowerShell 5.1 parses BOM-less scripts as ANSI. Keep translated messages ASCII in source and decode at runtime.
function Say([string] $English, [string] $Korean) {
  if ($installLang -eq 'ko') { return [regex]::Unescape($Korean) }
  return $English
}

function Get-RequiredCommands([string] $InstallerPath) {
  # A checkout follows install.sh; standalone release installs need bun but not git.
  if (-not $InstallerPath -or -not (Test-Path -LiteralPath $InstallerPath)) { return @('bun') }
  $content = Get-Content -LiteralPath $InstallerPath -Raw
  $match = [regex]::Match($content, 'REQUIRED_COMMANDS=\(([^)]*)\)')
  if (-not $match.Success) { Fail "could not read REQUIRED_COMMANDS from $InstallerPath" 1 }
  return @($match.Groups[1].Value.Trim() -split '\s+' | Where-Object { $_ })
}

# Windows PowerShell 5.1: `Get-Content -Raw` on an empty file yields $null, not '' - a freshly created profile then
# fails on `.Contains`. ReadAllText returns '' for an empty file.
function Read-Text([string] $Path) {
  return [IO.File]::ReadAllText($Path)
}

function Resolve-InstallerUserHome {
  $profileHome = $env:USERPROFILE
  if (-not $profileHome -and $env:LOCALAPPDATA) {
    $profileHome = Split-Path -Parent (Split-Path -Parent $env:LOCALAPPDATA)
  }
  if (-not $profileHome) { $profileHome = $HOME }
  return $profileHome
}

function Resolve-InstallerDataHome {
  $dataHome = $env:LOCALAPPDATA
  if (-not $dataHome) {
    $userHome = Resolve-InstallerUserHome
    if ($userHome) { $dataHome = Join-Path (Join-Path $userHome 'AppData') 'Local' }
  }
  # SYSTEM and other service accounts can have neither USERPROFILE nor LOCALAPPDATA.
  if (-not $dataHome -and $env:ProgramData) { $dataHome = $env:ProgramData }
  return $dataHome
}

function Resolve-InstallerProfilePath {
  if ($env:ELANOUS_POWERSHELL_PROFILE) { return $env:ELANOUS_POWERSHELL_PROFILE }
  if ($PROFILE) { return $PROFILE }
  $profileHome = Resolve-InstallerUserHome
  if (-not $profileHome) { return $null }
  $profileDirectory = Join-Path (Join-Path $profileHome 'Documents') 'WindowsPowerShell'
  return Join-Path $profileDirectory 'Microsoft.PowerShell_profile.ps1'
}

# Windows PowerShell 5.1 turns a native command's stderr into a terminating NativeCommandError under
# ErrorActionPreference=Stop - even with 2>$null. A git probe that is allowed to fail must run outside that mode.
function Invoke-Quiet([scriptblock] $Block) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = & $Block 2>$null; return @{ ok = ($LASTEXITCODE -eq 0); out = [string]($output -join "`n") } }
  catch { return @{ ok = $false; out = '' } }
  finally { $ErrorActionPreference = $previous }
}

# A junction is removed with rmdir so the target folder's contents are never touched.
function Invoke-DownloadWithRetry([string] $Uri, [string] $Destination) {
  $delaySeconds = 1
  if ($env:ELANOUS_INSTALL_RETRY_DELAY_SECONDS -match '^\d+$') { $delaySeconds = [Math]::Min(10, [int]$env:ELANOUS_INSTALL_RETRY_DELAY_SECONDS) }
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
      if (Test-Path -LiteralPath $Destination -PathType Leaf) { return $true }
      throw 'download returned without creating a file'
    } catch {
      Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
      if ($attempt -lt 3) { Start-Sleep -Seconds ($delaySeconds * $attempt) }
    }
  }
  return $false
}

function Test-Sha512Integrity([string] $Path, [string] $Integrity) {
  if ($Integrity -notmatch '^sha512-[A-Za-z0-9+/]+={0,2}$') { return $false }
  $sha512 = [Security.Cryptography.SHA512]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { $actual = 'sha512-' + [Convert]::ToBase64String($sha512.ComputeHash($stream)) }
  finally { $stream.Dispose(); $sha512.Dispose() }
  return $actual -ceq $Integrity
}

function Set-Junction([string] $Link, [string] $Target) {
  if ($env:OS -ne 'Windows_NT') {
    if (Test-Path -LiteralPath $Link) {
      $item = Get-Item -LiteralPath $Link -Force
      if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail "$Link exists and is not a symbolic link - refusing to replace it" 1 }
      Remove-Item -LiteralPath $Link -Force
    }
    New-Item -ItemType SymbolicLink -Path $Link -Target $Target | Out-Null
    return
  }
  if (Test-Path -LiteralPath $Link) {
    $item = Get-Item -LiteralPath $Link -Force
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail "$Link exists and is not a junction - refusing to replace it" 1 }
    & cmd.exe /d /c rmdir "$Link" | Out-Null
  }
  New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
}

for ($index = 0; $index -lt $RemainingArgs.Count; $index++) {
  switch ($RemainingArgs[$index]) {
    '--help' { $Help = $true }
    '--prefix' {
      if ($index + 1 -ge $RemainingArgs.Count) { Fail '--prefix needs a path' 2 }
      $Prefix = $RemainingArgs[++$index]
    }
    '--source' {
      if ($index + 1 -ge $RemainingArgs.Count) { Fail '--source needs a .tgz path or URL' 2 }
      $Source = $RemainingArgs[++$index]
    }
    '--no-modify-path' { $NoModifyPath = $true }
    '--no-bootstrap-bun' { $NoBootstrapBun = $true }
    default { Fail "unknown argument: $($RemainingArgs[$index])" 2 }
  }
}

if ($Help) { Show-Usage; exit 0 }
$installLang = if ($env:ELANOUS_INSTALL_LANG) { $env:ELANOUS_INSTALL_LANG } else { [Globalization.CultureInfo]::CurrentUICulture.Name }
$installLang = if ($installLang -match '^ko(?:-|$)') { 'ko' } else { 'en' }

# WIN-ARM64-VM-TRIAL (0.2.40): Windows on ARM reports ARM64 via PROCESSOR_ARCHITECTURE (ARM64-native
# host) or PROCESSOR_ARCHITEW6432 (32-bit host on 64-bit Windows). bun, the required runtime, publishes
# no Windows ARM64 build (its installer fetches bun-windows-x64), so refuse before touching the prefix
# or the profile. Exit 78 (EX_CONFIG) keeps this distinct from 127 (required command missing) and 1.
# Third tier (re-issued fragment): a host that spawns PowerShell with a scrubbed environment block still
# reports its architecture through the .NET runtime (RuntimeInformation, in .NET since 4.7.1, the floor
# under PowerShell 5.1), so fall back to it only when both environment variables are absent. Guarded to
# Windows_NT: elsewhere the host architecture says nothing about Windows installability and the gate must
# keep its pre-fallback behavior. Uppercased: the enum prints Arm64, the check below reads ARM64.
$osArchitecture = $env:PROCESSOR_ARCHITEW6432
if (-not $osArchitecture) { $osArchitecture = $env:PROCESSOR_ARCHITECTURE }
if (-not $osArchitecture -and $env:OS -eq 'Windows_NT') {
  try { $osArchitecture = ([string][System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture).ToUpperInvariant() } catch { $osArchitecture = $null }
}
if ($osArchitecture -eq 'ARM64') {
  Fail (Say 'Windows on ARM (ARM64) is not supported yet: bun, the required runtime, has no Windows ARM64 build, so nothing was installed. Use x64 Windows for now (WIN-ARM64-VM-TRIAL tracks the first live measurement).' '\uc708\ub3c4\uc6b0 ARM(ARM64)\uc740 \uc544\uc9c1 \uc9c0\uc6d0\ud558\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4: \ud544\uc218 \ub7f0\ud0c0\uc784 bun \uc5d0 \uc708\ub3c4\uc6b0 ARM64 \ube4c\ub4dc\uac00 \uc5c6\uc5b4 \uc544\ubb34\uac83\ub3c4 \uc124\uce58\ud558\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4. \ub2f9\ubd84\uac04 x64 \uc708\ub3c4\uc6b0\ub97c \uc0ac\uc6a9\ud558\uc138\uc694(WIN-ARM64-VM-TRIAL \uce78\uc774 \uccab \uc2e4\uce21\uc744 \ucd94\uc801\ud569\ub2c8\ub2e4).') 78
}

if (-not $Prefix) {
  if ($env:ELANOUS_INSTALL_PREFIX) {
    $Prefix = $env:ELANOUS_INSTALL_PREFIX
  } else {
    $dataHome = Resolve-InstallerDataHome
    if (-not $dataHome) { Fail 'could not resolve an installation data directory' 1 }
    $Prefix = Join-Path $dataHome 'elanous'
  }
}
if (-not $Source -and $env:ELANOUS_INSTALL_SOURCE) { $Source = $env:ELANOUS_INSTALL_SOURCE }

$scriptDir = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { $null }
$repoRoot = if ($scriptDir) { [IO.Path]::GetFullPath((Join-Path $scriptDir '..')) } else { $null }
$installerPath = if ($scriptDir) { Join-Path $scriptDir 'install.sh' } else { $null }
$requiredCommands = Get-RequiredCommands $installerPath
$missingGit = -not (Get-Command git -ErrorAction SilentlyContinue)
$bootstrappedBun = $false
$installerUserHome = Resolve-InstallerUserHome
$bunUserBin = if ($installerUserHome) { Join-Path (Join-Path $installerUserHome '.bun') 'bin' } else { $null }
if (-not (Get-Command bun -ErrorAction SilentlyContinue) -and $bunUserBin -and (Test-Path -LiteralPath (Join-Path $bunUserBin 'bun.exe') -PathType Leaf)) {
  $env:PATH = $bunUserBin + [IO.Path]::PathSeparator + $env:PATH
}
# Preserve checkout required-command enforcement, including git, before changing any installation files.
foreach ($command in $requiredCommands) {
  if ($command -eq 'bun') { continue }
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { Fail "required command missing: $command" 127 }
}
$isCheckout = $false
if ($installerPath -and (Test-Path -LiteralPath $installerPath) -and $repoRoot -and (Test-Path -LiteralPath (Join-Path $repoRoot 'package.json'))) {
  $isCheckout = (Read-Text (Join-Path $repoRoot 'package.json')) -match '"name":\s*"elanous"'
}
if ($isCheckout -and $missingGit) { Fail 'required command missing: git' 127 }
$bunVersion = '__ELANOUS_BUN_VERSION__'
if ($isCheckout -and (Test-Path -LiteralPath (Join-Path $repoRoot '.bun-version'))) {
  $bunVersion = (Read-Text (Join-Path $repoRoot '.bun-version')).Trim()
} elseif ($bunVersion -eq ('__ELANOUS_' + 'BUN_VERSION__') -and (Get-Command bun -ErrorAction SilentlyContinue)) {
  # An unbuilt standalone script has no release-embedded pin; use the already-installed Bun rather than reject -Source.
  $availableBunVersion = Invoke-Quiet { & bun --version }
  if ($availableBunVersion.ok -and $availableBunVersion.out.Trim() -match '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    $bunVersion = $availableBunVersion.out.Trim()
  }
}
if ($bunVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  Fail 'pinned Bun version is missing or invalid' 1
}
$pinnedBunAvailable = $false
if (Get-Command bun -ErrorAction SilentlyContinue) {
  try {
    $installedBunVersion = (& bun --version 2>$null | Select-Object -Last 1).Trim()
    $pinnedBunAvailable = ($LASTEXITCODE -eq 0 -and $installedBunVersion -eq $bunVersion)
  } catch { $pinnedBunAvailable = $false }
}
if (-not $pinnedBunAvailable) {
  if ($NoBootstrapBun) { Fail "$(Say 'install pinned Bun version:' '\uc9c0\uc815\ub41c Bun \ubc84\uc804\uc744 \uc124\uce58\ud558\uc138\uc694:') $bunVersion" 127 }
  # Keep the installer-pinned runtime isolated; never replace a user's shared ~/.bun/bin/bun.exe.
  $runtimeDataHome = Resolve-InstallerDataHome
  if (-not $runtimeDataHome) { Fail 'could not resolve a Bun runtime directory' 1 }
  $bunBin = Join-Path (Join-Path (Join-Path $runtimeDataHome 'Elanous') 'runtime') 'bun'
  $bunBin = Join-Path $bunBin $bunVersion
  $pathBeforeBun = $env:PATH
  $bunTemp = Join-Path ([IO.Path]::GetTempPath()) ("elanous-bun-" + [guid]::NewGuid().ToString('N'))
  try {
    New-Item -ItemType Directory -Force -Path $bunTemp | Out-Null
    $githubArchive = Join-Path $bunTemp 'bun-windows-x64.zip'
    $githubUrl = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-windows-x64.zip"
    $githubChecksumUrl = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/SHASUMS256.txt"
    $githubChecksumFile = Join-Path $bunTemp 'SHASUMS256.txt'
    $bunExecutable = $null
    if ((Invoke-DownloadWithRetry $githubUrl $githubArchive) -and (Invoke-DownloadWithRetry $githubChecksumUrl $githubChecksumFile)) {
      try {
        $checksumLine = [regex]::Match((Read-Text $githubChecksumFile), '(?m)^([0-9a-fA-F]{64})[ \t]+(?:\*)?bun-windows-x64\.zip\s*$')
        if ($checksumLine.Success) {
          $expected = $checksumLine.Groups[1].Value
          $actual = (Get-FileHash -LiteralPath $githubArchive -Algorithm SHA256).Hash
          if ($expected -ieq $actual) {
            $githubExtract = Join-Path $bunTemp 'github'
            Expand-Archive -LiteralPath $githubArchive -DestinationPath $githubExtract -Force
            $bunExecutable = Get-ChildItem -LiteralPath $githubExtract -Filter 'bun.exe' -File -Recurse | Select-Object -First 1 -ExpandProperty FullName
          }
        }
      } catch { $bunExecutable = $null }
    }
    if ($bunExecutable) {
      $githubBunVersion = Invoke-Quiet { & $bunExecutable --version }
      if (-not $githubBunVersion.ok -or $githubBunVersion.out.Trim() -ne $bunVersion) { $bunExecutable = $null }
    }
    if (-not $bunExecutable) {
      $npmMetadataUrl = "https://registry.npmjs.org/@oven%2fbun-windows-x64/$bunVersion"
      $npmMetadataFile = Join-Path $bunTemp 'bun-npm-metadata.json'
      if (-not (Invoke-DownloadWithRetry $npmMetadataUrl $npmMetadataFile)) { Fail "bun $bunVersion metadata download failed from npm registry" 1 }
      try { $npmMetadata = Read-Text $npmMetadataFile | ConvertFrom-Json } catch { Fail "bun $bunVersion npm metadata is invalid" 1 }
      $npmUrl = [string]$npmMetadata.dist.tarball
      $npmIntegrity = [string]$npmMetadata.dist.integrity
      $trustedNpmUrl = '^https://registry\.npmjs\.org/@oven/bun-windows-x64/-/bun-windows-x64-' + [regex]::Escape($bunVersion) + '\.tgz$'
      if ($npmUrl -notmatch $trustedNpmUrl -or -not $npmIntegrity) { Fail "bun $bunVersion npm metadata has no trusted tarball URL or SHA512 integrity" 1 }
      $npmArchive = Join-Path $bunTemp 'bun-npm.tgz'
      if (-not (Invoke-DownloadWithRetry $npmUrl $npmArchive)) { Fail "bun $bunVersion npm tarball download failed" 1 }
      if (-not (Test-Sha512Integrity $npmArchive $npmIntegrity)) { Fail "bun $bunVersion npm tarball SHA512 integrity mismatch" 1 }
      $npmExtract = Join-Path $bunTemp 'npm'
      New-Item -ItemType Directory -Force -Path $npmExtract | Out-Null
      $tarCommand = if ($env:OS -eq 'Windows_NT') { 'tar.exe' } else { 'tar' }
      & $tarCommand -xzf $npmArchive -C $npmExtract 'package/bin/bun.exe'
      if ($LASTEXITCODE -ne 0) { Fail "bun $bunVersion npm package extraction failed" 1 }
      $bunExecutable = Join-Path $npmExtract 'package/bin/bun.exe'
      if (-not (Test-Path -LiteralPath $bunExecutable -PathType Leaf)) { Fail "bun $bunVersion npm package has no bun.exe" 1 }
    }
    $downloadedBunVersion = (& $bunExecutable --version 2>$null | Select-Object -Last 1).Trim()
    if ($LASTEXITCODE -ne 0 -or $downloadedBunVersion -ne $bunVersion) { Fail "downloaded bun version mismatch: expected $bunVersion actual $downloadedBunVersion" 1 }
    New-Item -ItemType Directory -Force -Path $bunBin | Out-Null
    Copy-Item -LiteralPath $bunExecutable -Destination (Join-Path $bunBin 'bun.exe') -Force
    # Keep the test universe executable on Unix PowerShell; Windows resolves bun.exe as bun.
    if ($env:OS -ne 'Windows_NT') {
      Copy-Item -LiteralPath (Join-Path $bunBin 'bun.exe') -Destination (Join-Path $bunBin 'bun') -Force
      & chmod +x (Join-Path $bunBin 'bun')
    }
  } catch { Fail "$(Say 'bun bootstrap failed:' 'bun \uc124\uce58 \uc2e4\ud328:') $($_.Exception.Message)" 1 }
  finally { Remove-Item -LiteralPath $bunTemp -Recurse -Force -ErrorAction SilentlyContinue }
  $env:PATH = $bunBin + [IO.Path]::PathSeparator + $pathBeforeBun
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Fail (Say 'bun bootstrap failed: bun not found after installation' 'bun \uc124\uce58 \uc2e4\ud328: \uc124\uce58 \ub4a4\uc5d0\ub3c4 bun \uc744 \ucc3e\uc744 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4') 1
  }
  $bootstrappedBun = $true
}
$bunPath = (Get-Command bun).Source

# A standalone installer fetches a verified release; explicit sources and checkouts keep their existing paths.
$releaseDirectory = $null
if (-not $Source -and -not $isCheckout) {
  $releaseBase = if ($env:ELANOUS_RELEASE_BASE) { $env:ELANOUS_RELEASE_BASE } else { 'https://github.com/ElanvitalAI/elanous/releases' }
  $releaseDirectory = $releaseBase.TrimEnd('/') + $(if ($env:ELANOUS_VERSION) { '/download/v' + $env:ELANOUS_VERSION + '/' } else { '/latest/download/' })
}

$profilePath = $null
$markerStart = '# >>> elanous installer PATH >>>'
$markerEnd = '# <<< elanous installer PATH <<<'
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
$Prefix = (Resolve-Path -LiteralPath $Prefix).Path
$pathLiteral = (Join-Path $Prefix 'bin').Replace("'", "''")
$pathLine = '$env:PATH = ''' + $pathLiteral + ''' + [IO.Path]::PathSeparator + $env:PATH'
if (-not $NoModifyPath) {
  $profilePath = Resolve-InstallerProfilePath
  if ($profilePath) {
    $profileDirectory = Split-Path -Parent $profilePath
    New-Item -ItemType Directory -Force -Path $profileDirectory | Out-Null
    if (-not (Test-Path -LiteralPath $profilePath)) { New-Item -ItemType File -Path $profilePath | Out-Null }
    $profileContent = Read-Text $profilePath
    if ($profileContent.Contains($markerStart) -and -not $profileContent.Contains($pathLine)) {
      Fail 'PATH block already points to a different installation prefix' 1
    }
  }
}

$tempDirectory = Join-Path ([IO.Path]::GetTempPath()) ("elanous-install-" + [guid]::NewGuid().ToString('N'))
$metadataCommit = $null
$versionSuffix = ''
try {
  New-Item -ItemType Directory -Force -Path $tempDirectory | Out-Null
  $installTarball = Join-Path $tempDirectory 'package.tgz'
  if ($releaseDirectory) {
    $packageUrl = $releaseDirectory + 'elanous.tgz'
    $checksumUrl = $releaseDirectory + 'SHA256SUMS'
    $checksumFile = Join-Path $tempDirectory 'SHA256SUMS'
    $releaseVerified = $false
    try {
      if ($packageUrl -match '^file://') { Copy-Item -LiteralPath ([uri]$packageUrl).LocalPath -Destination $installTarball; $packageDownloaded = $true }
      else { $packageDownloaded = Invoke-DownloadWithRetry $packageUrl $installTarball }
      if ($packageDownloaded) {
        if ($checksumUrl -match '^file://') { Copy-Item -LiteralPath ([uri]$checksumUrl).LocalPath -Destination $checksumFile; $checksumDownloaded = $true }
        else { $checksumDownloaded = Invoke-DownloadWithRetry $checksumUrl $checksumFile }
      } else { $checksumDownloaded = $false }
      if ($packageDownloaded -and $checksumDownloaded) {
        $checksumLine = [regex]::Match((Read-Text $checksumFile), '(?m)^([0-9a-fA-F]{64})[ \t]+elanous\.tgz\s*$')
        if ($checksumLine.Success) {
          $expected = $checksumLine.Groups[1].Value
          $actual = (Get-FileHash -LiteralPath $installTarball -Algorithm SHA256).Hash
          if ($expected -ieq $actual) {
            $packageManifestResult = Invoke-Quiet { tar -xzOf $installTarball package/package.json }
            if ($packageManifestResult.ok) {
              try {
                $packageManifest = $packageManifestResult.out | ConvertFrom-Json
                $manifestVersion = [string]$packageManifest.version
                $releaseVerified = ($packageManifest.name -eq 'elanous' -and $manifestVersion -and $manifestVersion -notmatch '[\\/]|\.\.')
              } catch { $releaseVerified = $false }
            }
          }
        }
      }
    } catch { $releaseVerified = $false }
    if ($releaseVerified) {
      $metadataSource = $packageUrl
    } else {
      if ($env:ELANOUS_RELEASE_BASE) { Fail "custom ELANOUS_RELEASE_BASE download or checksum verification failed: $packageUrl" 1 }
      Remove-Item -LiteralPath $installTarball,$checksumFile -Force -ErrorAction SilentlyContinue
      $registryVersion = if ($env:ELANOUS_VERSION) { '/' + $env:ELANOUS_VERSION.TrimStart('v') } else { '/latest' }
      $registryMetadataUrl = 'https://registry.npmjs.org/elanous' + $registryVersion
      $registryMetadataFile = Join-Path $tempDirectory 'elanous-npm-metadata.json'
      if (-not (Invoke-DownloadWithRetry $registryMetadataUrl $registryMetadataFile)) { Fail 'elanous release download failed from GitHub and npm registry' 1 }
      try { $registryMetadata = Read-Text $registryMetadataFile | ConvertFrom-Json } catch { Fail 'invalid elanous npm registry metadata' 1 }
      $registryPackageUrl = [string]$registryMetadata.dist.tarball
      $registryIntegrity = [string]$registryMetadata.dist.integrity
      if ($registryPackageUrl -notmatch '^https://registry\.npmjs\.org/elanous/' -or -not $registryIntegrity) {
        Fail 'elanous npm registry metadata is missing a trusted tarball URL or integrity' 1
      }
      if (-not (Invoke-DownloadWithRetry $registryPackageUrl $installTarball)) { Fail 'elanous npm registry tarball download failed' 1 }
      if (-not (Test-Sha512Integrity $installTarball $registryIntegrity)) { Fail 'elanous npm registry tarball SHA512 integrity mismatch' 1 }
      $metadataSource = $registryPackageUrl
    }
  } elseif ($Source -match '^https?://') {
    try { Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $installTarball } catch { Fail "download failed: $Source" 1 }
    $metadataSource = $Source
  } elseif ($Source) {
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { Fail "source tarball missing: $Source" 2 }
    Copy-Item -LiteralPath $Source -Destination $installTarball
    $metadataSource = (Resolve-Path -LiteralPath $Source).Path
  } else {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'apps\pwa\out\index.html'))) {
      [Console]::Error.WriteLine('WARNING: PWA build not found (apps/pwa/out/index.html) - the installed copy will have no web UI. Build it first: bun bin/elanous.mjs nexus build')
    }
    Push-Location $repoRoot
    try {
      & bun pm pack --destination $tempDirectory | Out-Null
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally { Pop-Location }
    $packed = Get-ChildItem -LiteralPath $tempDirectory -Filter '*.tgz' | Where-Object { $_.Name -ne 'package.tgz' } | Select-Object -First 1 -ExpandProperty FullName
    if (-not $packed) { Fail 'package tarball was not created' 1 }
    Move-Item -LiteralPath $packed -Destination $installTarball
    $metadataSource = $repoRoot
    # Only a checkout install is this repo. A missing git or a failed rev-parse stays empty - the install does not die.
    $head = Invoke-Quiet { git -C $repoRoot rev-parse HEAD }
    if ($head.ok -and $head.out.Trim()) {
      $metadataCommit = $head.out.Trim()
      # A checkout always carries the same package.json version - name the folder by version + short commit so a
      # reinstall never overwrites the previous build. Tracked changes that differ from the commit add `-dirty`.
      $versionSuffix = '-' + $metadataCommit.Substring(0, [Math]::Min(12, $metadataCommit.Length))
      $dirty = Invoke-Quiet { git -C $repoRoot status --porcelain --untracked-files=no }
      if ($dirty.ok -and $dirty.out.Trim()) { $versionSuffix += '-dirty' }
    }
  }

  # Read the version from the tarball "before" installing, so the build goes straight into versions\<name>.
  $packageText = Invoke-Quiet { tar -xzOf $installTarball package/package.json }
  $packageVersion = if ($packageText.ok) { try { [string](($packageText.out | ConvertFrom-Json).version) } catch { '' } } else { '' }
  if (-not $packageVersion) { Fail "package version missing in tarball: $installTarball" 1 }
  if ($packageVersion -match '[\\/]|\.\.') { Fail "unsafe package version: $packageVersion" 1 }
  $versionName = "$packageVersion$versionSuffix"
  $versionDirectory = Join-Path $Prefix "versions\$versionName"
  New-Item -ItemType Directory -Force -Path $versionDirectory | Out-Null
  $packagePath = Join-Path $versionDirectory 'package.json'
  if (-not (Test-Path -LiteralPath $packagePath)) { Set-Content -LiteralPath $packagePath -Value '{"private":true}' -NoNewline }

  # The bun cache is empty on a fresh machine, so `--offline` alone fails there - cache first, then the registry.
  Push-Location $versionDirectory
  try {
    $offline = Invoke-Quiet { bun add --no-save --offline $installTarball }
    if (-not $offline.ok) {
      [Console]::Error.WriteLine('dependencies not in the local bun cache - fetching them from the npm registry')
      & bun add --no-save $installTarball
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
  } finally { Pop-Location }

  $installedEntrypoint = Join-Path $versionDirectory 'node_modules\elanous\bin\elanous.mjs'
  if (-not (Test-Path -LiteralPath $installedEntrypoint -PathType Leaf)) { Fail "installed elanous entrypoint missing: $installedEntrypoint" 1 }
  Set-Junction (Join-Path $Prefix 'current') $versionDirectory

  $binDirectory = Join-Path $Prefix 'bin'
  New-Item -ItemType Directory -Force -Path $binDirectory | Out-Null
  $shimPath = Join-Path $binDirectory 'elanous.cmd'
  # The shim names bun by its absolute path so `elanous` works in a shell whose PATH lacks ~\.bun\bin.
  $shimContent = "@echo off`r`nrem elanous-wrapper`r`n`"$bunPath`" `"%~dp0..\current\node_modules\elanous\bin\elanous.mjs`" %*`r`n"
  Set-Content -LiteralPath $shimPath -Value $shimContent -NoNewline -Encoding ascii
  $elnShim = Join-Path $binDirectory 'eln.cmd'
  if ((Test-Path -LiteralPath $elnShim) -and ((Get-Item -LiteralPath $elnShim -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or
      (Read-Text $elnShim) -notmatch '(?m)^rem elanous-wrapper\r?$')) {
    Fail "eln shim exists and is not installer-owned; refusing to overwrite or claim it: $elnShim" 1
  }
  Set-Content -LiteralPath $elnShim -Value $shimContent -NoNewline -Encoding ascii

  $processPathEntries = @(($env:PATH -split [regex]::Escape([string][IO.Path]::PathSeparator)) | Where-Object {
    $_ -and -not [string]::Equals([string]$_, $binDirectory, [StringComparison]::OrdinalIgnoreCase)
  })
  $env:PATH = (@($binDirectory) + $processPathEntries) -join [IO.Path]::PathSeparator
  $elnOnPath = $true
  if ($env:OS -eq 'Windows_NT') {
    $resolvedElnPaths = @(& where.exe eln 2>$null)
    $resolvedPath = if ($resolvedElnPaths.Count -gt 0) { [string]$resolvedElnPaths[0] } else { '<not found>' }
    if (-not [string]::Equals([IO.Path]::GetFullPath($resolvedPath), [IO.Path]::GetFullPath($elnShim), [StringComparison]::OrdinalIgnoreCase)) {
      Fail "installed eln shim is not first on the current PATH: expected $elnShim, resolved $resolvedPath" 1
    }
  }

  $installedPackage = Join-Path $Prefix 'current\node_modules\elanous\package.json'
  if (-not (Test-Path -LiteralPath $installedPackage)) { Fail "package version missing: $installedPackage" 1 }
  $version = (Read-Text $installedPackage | ConvertFrom-Json).version
  if (-not $version) { Fail "package version missing: $installedPackage" 1 }
  $metadata = [ordered]@{ version = $version; versionDir = "versions/$versionName"; source = $metadataSource; installedAt = [DateTime]::UtcNow.ToString('o') }
  if ($metadataCommit) { $metadata.commit = $metadataCommit }
  $metadataJson = $metadata | ConvertTo-Json -Compress
  $metadataJson | Set-Content -LiteralPath (Join-Path $Prefix 'install.json') -NoNewline
  # The build folder keeps its own copy - `elanous --version` reads its own build's metadata after a rollback.
  $metadataJson | Set-Content -LiteralPath (Join-Path $versionDirectory 'install.json') -NoNewline

  if (-not $NoModifyPath -and $profilePath -and -not (Read-Text $profilePath).Contains($markerStart)) {
    Add-Content -LiteralPath $profilePath -Value ("`r`n$markerStart`r`n$pathLine`r`n$markerEnd")
  }
  # The default execution policy (Restricted) skips $PROFILE in a new window - the user PATH is what a fresh shell sees.
  if (-not $NoModifyPath -and -not $env:ELANOUS_INSTALL_NO_USER_PATH) {
    $binDirectory = Join-Path $Prefix 'bin'
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $userEntries = @(($userPath -split ';') | Where-Object { $_ })
    if ($userEntries -notcontains $binDirectory) {
      [Environment]::SetEnvironmentVariable('Path', (@($binDirectory) + $userEntries) -join ';', 'User')
    }
  }
  $installedMessage = Say 'Installed elanous {0} at {1}' 'elanous {0} \uc744(\ub97c) \uc124\uce58\ud588\uc2b5\ub2c8\ub2e4: {1}'
  Write-Output ($installedMessage -f $version, $shimPath)
  Write-Output ("ELN command: {0}" -f $elnShim)
  Write-Output ("ELN available on current PATH: {0}" -f $elnOnPath)
  $bootstrapped = if ($bootstrappedBun) { 'bun' } else { 'none' }
  $missing = if ($missingGit -and -not $isCheckout) { 'git(next step)' } else { 'none' }
  Write-Output "$(Say 'Install summary' '\uc124\uce58 \uc694\uc57d'): bootstrapped: $bootstrapped; missing: $missing"
  Write-Output (Say 'Next:' '\ub2e4\uc74c:')
  if (-not $NoModifyPath) { Write-Output (Say '  Open a new PowerShell window to use elanous on PATH.' '  elanous \uc744 PATH \uc5d0\uc11c \uc4f0\ub824\uba74 \uc0c8 PowerShell \ucc3d\uc744 \uc5ec\uc138\uc694.') }
  else { Write-Output "$(Say '  Run:' '  \uc2e4\ud589:') $shimPath" }
  if ($missing -ne 'none') {
    Write-Output '  Install Git for Windows from https://git-scm.com/download/win, then reopen PowerShell and run: git --version'
  }
} finally {
  Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
