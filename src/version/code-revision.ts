/**
 * 「이 코드는 어느 커밋인가」 — `elanous --version` 과 데몬 `/v1/health` 의 `daemonSha` 가 같은 답을 내게 한 곳에 둔다.
 * 순서: 코드 자신의 위치(체크아웃이면 git HEAD) → 설치기의 `install.json` commit → 패키지에 실린 commit.
 * ⛔ 호출자 cwd 는 보지 않는다 — 2026-09-24 설치본 전환 뒤 데몬이 WorkingDirectory(pilot)의 HEAD 를
 *    `daemonSha` 로 말했다(설치본 168eb32 인데 7368f6a). src/index.ts 에서 옮겨 왔다.
 */
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname as _dirname, join as _joinPath, resolve } from 'node:path';
import { findElanousRepoRoot } from '../code-edit/system-file-guard.js';
import { runGitCommand } from '../git-fs/runner.js';

const REPOSITORY_ROOT = findElanousRepoRoot(import.meta.dir) ?? resolve(import.meta.dir, '..', '..');
const PACKAGED_REVISION_PATH = 'src/version/packed-revision.json';

/** bun pm pack prepack hook: capture HEAD into a package-owned file; never ship stale metadata. */
export function writePackagedRevision(root: string = REPOSITORY_ROOT, now: () => number = Date.now): void {
  const path = _joinPath(root, PACKAGED_REVISION_PATH);
  const revision = checkoutRevision(root);
  if (revision === 'unknown' || !/^[0-9a-f]{40}$/.test(revision)) {
    // Pack without a commit, replacing any stale identity from a previous pack.
    process.stderr.write('⚠ no valid git HEAD — packing without a commit (elanous --version will say unknown)\n');
    writeFileSync(path, JSON.stringify({ builtAt: Math.floor(now() / 1000) }) + '\n');
    return;
  }
  writeFileSync(path, JSON.stringify({ commit: revision, builtAt: Math.floor(now() / 1000) }) + '\n');
}

function packagedBuild(root: string): { commit?: string; builtAt?: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(_joinPath(root, PACKAGED_REVISION_PATH), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const { commit, builtAt } = parsed as { commit?: unknown; builtAt?: unknown };
    return {
      ...(typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit) ? { commit } : {}),
      ...(typeof builtAt === 'number' && Number.isSafeInteger(builtAt) && builtAt > 0 ? { builtAt } : {}),
    };
  } catch {
    return undefined;
  }
}

function checkoutRevision(cwd: string): string {
  // An installer-owned package must not inherit an enclosing checkout's HEAD.
  // A source package under node_modules without the installer's shim still uses rev-parse.
  if (installerOwnedMetadataPath(cwd)) return 'unknown';
  const result = runGitCommand(cwd, ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const revision = result.status === 0 ? result.stdout.trim() : '';
  return revision || 'unknown';
}

function usableInstallMetadataCommit(commit: string): string | undefined {
  const revision = commit.trim();
  // One-line `1.0.0 <revision>` forbids internal whitespace/newlines even after trim.
  if (!revision || /\s/.test(revision)) return undefined;
  return revision;
}

export function readInstallMetadataCommit(metadataPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const commit = (parsed as { readonly commit?: unknown }).commit;
    if (typeof commit !== 'string') return undefined;
    return usableInstallMetadataCommit(commit);
  } catch {
    return undefined;
  }
}

let testInstallMetadataRoot: string | undefined;
let testCodeRevisionRoot: string | undefined;

/** Point both git and package metadata reads at an isolated package folder. */
export function setCodeRevisionRootForTesting(root: string | undefined): void {
  testCodeRevisionRoot = root;
}

/** Isolates install.json lookup for tests — never the caller cwd. */
export function setInstallMetadataRootForTesting(root: string | undefined): void {
  testInstallMetadataRoot = root;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sameResolvedPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

const PACKAGE_ENTRY_PATTERN = /elanous[/\\]bin[/\\]elanous\.mjs/;

/** Unix installer: `$PREFIX/bin/elanous` → `node_modules/.bin/elanous` → this package's `bin/elanous.mjs`. */
function unixInstallerShimConnectsToPackage(
  shimPath: string,
  nodeModulesDir: string,
  packageEntry: string,
): boolean {
  try {
    if (!lstatSync(shimPath).isSymbolicLink()) return false;
    const linkTarget = readlinkSync(shimPath, 'utf8').replace(/\\/g, '/');
    if (linkTarget !== '../node_modules/.bin/elanous') return false;
    const bunBinShim = _joinPath(nodeModulesDir, '.bin', 'elanous');
    const resolvedLink = resolve(_dirname(shimPath), linkTarget);
    if (resolvedLink !== bunBinShim && !sameResolvedPath(resolvedLink, bunBinShim)) return false;
    if (sameResolvedPath(bunBinShim, packageEntry)) return true;
    return isFile(bunBinShim) && PACKAGE_ENTRY_PATTERN.test(readFileSync(bunBinShim, 'utf8'));
  } catch {
    return false;
  }
}

/** Windows installer: `$PREFIX/bin/elanous.cmd` names this package's `bin/elanous.mjs`. */
function windowsInstallerShimConnectsToPackage(shimPath: string, packageEntry: string): boolean {
  try {
    const st = lstatSync(shimPath);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    if (!isFile(packageEntry)) return false;
    return /%~dp0\.\.[\\/]node_modules[\\/]elanous[\\/]bin[\\/]elanous\.mjs/.test(readFileSync(shimPath, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * 판 폴더 레이아웃(`scripts/install.sh` 2026-09-24~): `$ROOT/versions/<판>/node_modules/elanous` ·
 * `$ROOT/bin/elanous → ../current/node_modules/.bin/elanous`. 판 폴더마다 자기 `install.json` 이 있다 —
 * 루트의 것은 «마지막 설치»라 롤백한 판의 커밋이 아닐 수 있다.
 */
function versionedInstallerMetadataPath(versionDir: string, packageEntry: string): string | undefined {
  const versionsDir = resolve(versionDir, '..');
  if (basename(versionsDir) !== 'versions') return undefined;
  const root = resolve(versionsDir, '..');
  try {
    const windowsShim = _joinPath(root, 'bin', 'elanous.cmd');
    if (isFile(windowsShim) && isFile(packageEntry)) {
      const text = readFileSync(windowsShim, 'utf8');
      if (/^rem elanous-wrapper\r?$/m.test(text) && /%~dp0\.\.[\\/]current[\\/]node_modules[\\/]elanous[\\/]bin[\\/]elanous\.mjs/.test(text)) {
        return _joinPath(versionDir, 'install.json');
      }
    }
    const shim = _joinPath(root, 'bin', 'elanous');
    const shimStat = lstatSync(shim);
    if (shimStat.isSymbolicLink()) {
      if (readlinkSync(shim, 'utf8').replace(/\\/g, '/') !== '../current/node_modules/.bin/elanous') return undefined;
      const bunBinShim = _joinPath(versionDir, 'node_modules', '.bin', 'elanous');
      if (!sameResolvedPath(bunBinShim, packageEntry)
        && !(isFile(bunBinShim) && PACKAGE_ENTRY_PATTERN.test(readFileSync(bunBinShim, 'utf8')))) return undefined;
    } else if (shimStat.isFile()) {
      // #21004 뒤 설치기는 bin/elanous 를 «bun 절대 경로 래퍼»(2번째 줄 `# elanous-wrapper`)로 쓴다 — 링크가 아니다.
      //   래퍼가 이 설치 뿌리의 current 엔트리를 부를 때만 설치기 소유로 본다.
      const text = readFileSync(shim, 'utf8');
      if (text.split('\n')[1] !== '# elanous-wrapper') return undefined;
      if (!text.includes(_joinPath(root, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs'))) return undefined;
    } else return undefined;
  } catch {
    return undefined;
  }
  return _joinPath(versionDir, 'install.json');
}

/** Prefix `install.json` is installer-owned only when a bin shim resolves to this package. */
function installerOwnedMetadataPath(packageRoot: string): string | undefined {
  if (basename(packageRoot) !== 'elanous') return undefined;
  const nodeModulesDir = resolve(packageRoot, '..');
  if (basename(nodeModulesDir) !== 'node_modules') return undefined;
  const prefix = resolve(nodeModulesDir, '..');
  const packageEntry = _joinPath(packageRoot, 'bin', 'elanous.mjs');
  if (!isFile(packageEntry)) return undefined;
  const versioned = versionedInstallerMetadataPath(prefix, packageEntry);
  if (versioned) return versioned;
  if (
    !unixInstallerShimConnectsToPackage(_joinPath(prefix, 'bin', 'elanous'), nodeModulesDir, packageEntry)
    && !windowsInstallerShimConnectsToPackage(_joinPath(prefix, 'bin', 'elanous.cmd'), packageEntry)
  ) return undefined;
  return _joinPath(prefix, 'install.json');
}

function installMetadataCandidates(root: string): string[] {
  const metadataRoot = testInstallMetadataRoot ?? root;
  const candidates = [_joinPath(metadataRoot, 'install.json')];
  const owned = installerOwnedMetadataPath(metadataRoot);
  if (owned && owned !== candidates[0]) candidates.push(owned);
  return candidates;
}

/** git 이 실패했을 때만 install.json 의 commit 을 본다. caller cwd 는 쓰지 않는다. */
function installMetadataCommit(root: string): string | undefined {
  for (const metadataPath of installMetadataCandidates(root)) {
    const commit = readInstallMetadataCommit(metadataPath);
    if (commit) return commit;
  }
  return undefined;
}

export type BuildChannel = 'official' | 'dev';
export interface InstalledBuildMetadata {
  readonly commit?: string;
  readonly channel: BuildChannel;
  readonly builtAt?: number;
}

function releaseMetadataSource(source: unknown): boolean {
  if (typeof source !== 'string') return false;
  return /^https:\/\/github\.com\/ElanvitalAI\/elanous\/releases\/download\/v\d+\.\d+\.\d+\/elanous\.tgz$/i.test(source)
    || /^https:\/\/registry\.npmjs\.org\/elanous\/-\/elanous-\d+\.\d+\.\d+\.tgz$/i.test(source);
}

/** Use metadata from this code's own install directory. A legacy release can lack a commit in install.json. */
export function installedBuildMetadata(root: string = testCodeRevisionRoot ?? REPOSITORY_ROOT): InstalledBuildMetadata | undefined {
  for (const path of installMetadataCandidates(root)) {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const packed = packagedBuild(root);
      const commit = typeof value.commit === 'string' ? usableInstallMetadataCommit(value.commit) ?? packed?.commit : packed?.commit;
      const channel = value.channel === 'official' || value.channel === 'dev'
        ? value.channel : releaseMetadataSource(value.source) ? 'official' : 'dev';
      const builtAt = typeof value.builtAt === 'number' && Number.isSafeInteger(value.builtAt) && value.builtAt > 0
        ? value.builtAt : packed?.commit === commit ? packed?.builtAt : undefined;
      return { commit, channel, builtAt };
    } catch { /* Try the next candidate. */ }
  }
  return undefined;
}

export function packagedBuildTime(root: string, sha: string): number | undefined {
  const packed = packagedBuild(root);
  return packed?.commit === sha ? packed.builtAt : undefined;
}

/** Return the install.json source only when it names an existing directory. */
export function installMetadataSource(root: string = REPOSITORY_ROOT): string | undefined {
  for (const metadataPath of installMetadataCandidates(root)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const source = (parsed as { readonly source?: unknown }).source;
      if (typeof source === 'string' && statSync(source).isDirectory()) return source;
    } catch { /* Try the next candidate. */ }
  }
  return undefined;
}

/**
 * The commit time (epoch seconds) a rail install recorded next to its commit (`commitTime` seconds · `committedAt`
 * ISO) — only when that record's commit is `sha` (another commit's time is never borrowed).
 */
export function installMetadataCommitTime(root: string = REPOSITORY_ROOT, sha?: string): number | undefined {
  for (const metadataPath of installMetadataCandidates(root)) {
    try {
      const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as { commit?: unknown; commitTime?: unknown; committedAt?: unknown };
      if (sha !== undefined && (typeof parsed.commit !== 'string' || parsed.commit.trim() !== sha)) continue;
      if (typeof parsed.commitTime === 'number' && Number.isFinite(parsed.commitTime)) return parsed.commitTime;
      if (typeof parsed.committedAt === 'string') {
        const at = Date.parse(parsed.committedAt);
        if (Number.isFinite(at)) return Math.floor(at / 1000);
      }
    } catch { /* Try the next candidate. */ }
  }
  return undefined;
}

/** Does this code run from a source checkout (git HEAD at the code root) rather than an installed copy? */
export function runsFromCheckout(): boolean {
  return checkoutRevision(testCodeRevisionRoot ?? REPOSITORY_ROOT) !== 'unknown';
}

/** `git log -1 --format=%ct <sha>` in `cwd` — undefined when that repository does not have the commit. */
export function gitCommitTime(cwd: string, sha: string): number | undefined {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return undefined;
  const result = runGitCommand(cwd, ['log', '-1', '--format=%ct', sha], { encoding: 'utf8' });
  const seconds = result.status === 0 ? Number(result.stdout.trim()) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export function cliVersion(): string {
  return `${packageVersion()} ${codeRevision() ?? 'unknown'}`;
}

let cachedPackageVersion: string | undefined;
/** 실행 중인 코드의 `package.json` `version` — ⭐ 버전 원천은 그 한 칸이다(MANUAL-versioning-and-release · SemVer 0.1.0~).
 *  🩸 2026-09-25: 여기 `1.0.0` 이 박혀 있어 0.1.0 으로 올려도 `elanous --version` 이 옛 값을 말했다(설치 시험이 잡았다).
 *  못 읽으면 `unknown` — 지어낸 값을 내지 않는다. */
export function packageVersion(root: string = REPOSITORY_ROOT): string {
  if (root === REPOSITORY_ROOT && cachedPackageVersion !== undefined) return cachedPackageVersion;
  let version = 'unknown';
  try {
    const parsed = JSON.parse(readFileSync(_joinPath(root, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) version = parsed.version.trim();
  } catch { /* unknown */ }
  if (root === REPOSITORY_ROOT) cachedPackageVersion = version;
  return version;
}

/** 코드의 커밋(40자) — 모르면 `undefined`. */
export function codeRevision(): string | undefined {
  const root = testCodeRevisionRoot ?? REPOSITORY_ROOT;
  // checkoutRevision checks installer ownership before consulting an enclosing git checkout.
  const revision = checkoutRevision(root);
  if (revision !== 'unknown') return revision;
  return installMetadataCommit(root) ?? packagedBuild(root)?.commit;
}
