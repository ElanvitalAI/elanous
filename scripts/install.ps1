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
function Set-Junction([string] $Link, [string] $Target) {
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
if (-not $Prefix) {
  $dataHome = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
  $Prefix = if ($env:ELANOUS_INSTALL_PREFIX) { $env:ELANOUS_INSTALL_PREFIX } else { Join-Path $dataHome 'elanous' }
}
if (-not $Source -and $env:ELANOUS_INSTALL_SOURCE) { $Source = $env:ELANOUS_INSTALL_SOURCE }

$scriptDir = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { $null }
$repoRoot = if ($scriptDir) { [IO.Path]::GetFullPath((Join-Path $scriptDir '..')) } else { $null }
$installerPath = if ($scriptDir) { Join-Path $scriptDir 'install.sh' } else { $null }
$requiredCommands = Get-RequiredCommands $installerPath
$missingGit = -not (Get-Command git -ErrorAction SilentlyContinue)
$bootstrappedBun = $false
$bunBin = Join-Path $HOME '.bun\bin'
if (-not (Get-Command bun -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath (Join-Path $bunBin 'bun.exe') -PathType Leaf)) {
  $env:PATH = $bunBin + [IO.Path]::PathSeparator + $env:PATH
}
# Preserve checkout required-command enforcement, including git, before changing any installation files.
foreach ($command in $requiredCommands) {
  if ($command -eq 'bun') { continue }
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { Fail "required command missing: $command" 127 }
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  $bunCommand = 'irm https://bun.sh/install.ps1 | iex'
  if ($NoBootstrapBun) { Fail "$(Say 'bun is missing; run:' 'bun \uc774 \uc5c6\uc2b5\ub2c8\ub2e4. \uba3c\uc800 \uc2e4\ud589\ud558\uc138\uc694:') $bunCommand" 127 }
  # Bun's official install.ps1 resets the session PATH to the user PATH only (System32 and tar vanish) - keep ours.
  $pathBeforeBun = $env:PATH
  try {
    $bootstrapScript = if ($env:ELANOUS_INSTALL_BUN_SCRIPT) {
      Read-Text $env:ELANOUS_INSTALL_BUN_SCRIPT
    } else {
      (Invoke-WebRequest -UseBasicParsing -Uri 'https://bun.sh/install.ps1').Content
    }
    if (-not $bootstrapScript) { throw 'empty installer response' }
    & ([scriptblock]::Create([string]$bootstrapScript))
    if (-not $?) { throw 'installer returned failure' }
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "installer exited with code $LASTEXITCODE" }
  } catch { Fail "$(Say 'bun bootstrap failed:' 'bun \uc124\uce58 \uc2e4\ud328:') $($_.Exception.Message)" 1 }
  $env:PATH = $bunBin + [IO.Path]::PathSeparator + $pathBeforeBun
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Fail (Say 'bun bootstrap failed: bun not found after installation' 'bun \uc124\uce58 \uc2e4\ud328: \uc124\uce58 \ub4a4\uc5d0\ub3c4 bun \uc744 \ucc3e\uc744 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4') 1
  }
  $bootstrappedBun = $true
}
$bunPath = (Get-Command bun).Source

# A standalone installer fetches a verified release; explicit sources and checkouts keep their existing paths.
$isCheckout = $false
if ($installerPath -and (Test-Path -LiteralPath $installerPath) -and $repoRoot -and (Test-Path -LiteralPath (Join-Path $repoRoot 'package.json'))) {
  $isCheckout = (Read-Text (Join-Path $repoRoot 'package.json')) -match '"name":\s*"elanous"'
}
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
  $profilePath = if ($env:ELANOUS_POWERSHELL_PROFILE) { $env:ELANOUS_POWERSHELL_PROFILE } else { $PROFILE }
  $profileDirectory = Split-Path -Parent $profilePath
  New-Item -ItemType Directory -Force -Path $profileDirectory | Out-Null
  if (-not (Test-Path -LiteralPath $profilePath)) { New-Item -ItemType File -Path $profilePath | Out-Null }
  $profileContent = Read-Text $profilePath
  if ($profileContent.Contains($markerStart) -and -not $profileContent.Contains($pathLine)) {
    Fail 'PATH block already points to a different installation prefix' 1
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
    try {
      if ($packageUrl -match '^file://') { Copy-Item -LiteralPath ([uri]$packageUrl).LocalPath -Destination $installTarball }
      else { Invoke-WebRequest -UseBasicParsing -Uri $packageUrl -OutFile $installTarball }
    } catch { Fail "download failed: $packageUrl" 1 }
    try {
      if ($checksumUrl -match '^file://') { Copy-Item -LiteralPath ([uri]$checksumUrl).LocalPath -Destination $checksumFile }
      else { Invoke-WebRequest -UseBasicParsing -Uri $checksumUrl -OutFile $checksumFile }
    } catch { Fail "download failed: $checksumUrl" 1 }
    $checksumLine = [regex]::Match((Read-Text $checksumFile), '(?m)^([0-9a-fA-F]{64})[ \t]+elanous\.tgz\s*$')
    if (-not $checksumLine.Success) { Fail "checksum missing for elanous.tgz: $checksumUrl" 1 }
    $expected = $checksumLine.Groups[1].Value
    $actual = (Get-FileHash -LiteralPath $installTarball -Algorithm SHA256).Hash
    if ($expected -ine $actual) { Fail "checksum mismatch for $packageUrl`: expected $expected actual $actual" 1 }
    $metadataSource = $packageUrl
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
  $pathEln = Get-Command eln -ErrorAction SilentlyContinue
  if (($pathEln -and $pathEln.Source -ne $elnShim) -or
      ((Test-Path -LiteralPath $elnShim) -and ((Get-Item -LiteralPath $elnShim -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or
        (Read-Text $elnShim) -notmatch '(?m)^rem elanous-wrapper\r?$'))) {
    Write-Output 'WARNING eln: another command already exists; use elanous instead'
  } else {
    Set-Content -LiteralPath $elnShim -Value $shimContent -NoNewline -Encoding ascii
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

  if (-not $NoModifyPath -and -not (Read-Text $profilePath).Contains($markerStart)) {
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
  $bootstrapped = if ($bootstrappedBun) { 'bun' } else { 'none' }
  $missing = if ($missingGit -and -not $isCheckout) { 'git(next step)' } else { 'none' }
  Write-Output "$(Say 'Install summary' '\uc124\uce58 \uc694\uc57d'): bootstrapped: $bootstrapped; missing: $missing"
  Write-Output (Say 'Next:' '\ub2e4\uc74c:')
  if (-not $NoModifyPath) { Write-Output (Say '  Open a new PowerShell window to use elanous on PATH.' '  elanous \uc744 PATH \uc5d0\uc11c \uc4f0\ub824\uba74 \uc0c8 PowerShell \ucc3d\uc744 \uc5ec\uc138\uc694.') }
  else { Write-Output "$(Say '  Run:' '  \uc2e4\ud589:') $shimPath" }
  if ($missing -ne 'none') {
    Write-Output "  winget install --id Git.Git -e  # $(Say 'the harness uses git' '\ud558\ub2c8\uc2a4\uac00 git \uc744 \uc0ac\uc6a9\ud569\ub2c8\ub2e4')"
  }
} finally {
  Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
