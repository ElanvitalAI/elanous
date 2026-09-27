[CmdletBinding()]
param(
  [string] $Prefix,
  [string] $Source,
  [switch] $NoModifyPath,
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
Usage: powershell -File scripts/install.ps1 [-Prefix PATH] [-Source PATH.tgz|URL] [-NoModifyPath] [-Help]
       powershell -File scripts/install.ps1 [--prefix PATH] [--source PATH.tgz|URL] [--no-modify-path] [--help]

Install elanous into a versioned layout.
  Prefix / --prefix               installation root (default: $ELANOUS_INSTALL_PREFIX or %LOCALAPPDATA%\elanous)
                                  layout: versions\<version>[-<commit12>]\ / current -> versions\... / bin\elanous.cmd
  Source / --source               install a package tarball (local path or http(s) URL; default: $ELANOUS_INSTALL_SOURCE,
                                  else pack the checkout or fetch the verified release when standalone)
  NoModifyPath / --no-modify-path do not append the elanous PATH block to the PowerShell profile
  Help / --help                   show this help
'@ | Write-Output
}

function Fail([string] $Message, [int] $Code) {
  [Console]::Error.WriteLine("ERROR: $Message")
  exit $Code
}

function Get-RequiredCommands([string] $InstallerPath) {
  # install.sh is the single source of the required-command list; a non-checkout run (e.g. `irm ... | iex`) has no
  # install.sh beside it and falls back to the same two names.
  $fallbackCommands = 'git', 'bun'
  if (-not $InstallerPath -or -not (Test-Path -LiteralPath $InstallerPath)) { return $fallbackCommands }
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
    default { Fail "unknown argument: $($RemainingArgs[$index])" 2 }
  }
}

if ($Help) { Show-Usage; exit 0 }
if (-not $Prefix) {
  $dataHome = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
  $Prefix = if ($env:ELANOUS_INSTALL_PREFIX) { $env:ELANOUS_INSTALL_PREFIX } else { Join-Path $dataHome 'elanous' }
}
if (-not $Source -and $env:ELANOUS_INSTALL_SOURCE) { $Source = $env:ELANOUS_INSTALL_SOURCE }

$scriptDir = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { $null }
$repoRoot = if ($scriptDir) { [IO.Path]::GetFullPath((Join-Path $scriptDir '..')) } else { $null }
$requiredCommands = Get-RequiredCommands $(if ($scriptDir) { Join-Path $scriptDir 'install.sh' } else { $null })
foreach ($command in $requiredCommands) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { Fail "required command missing: $command" 127 }
}
$bunPath = (Get-Command bun).Source

# A standalone installer fetches a verified release; explicit sources and checkouts keep their existing paths.
$isCheckout = $false
if ($repoRoot -and (Test-Path -LiteralPath (Join-Path $repoRoot 'package.json'))) {
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
  Write-Output "Installed elanous $version at $shimPath"
} finally {
  Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
