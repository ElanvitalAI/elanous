// Version label with channel and build stamp (STATUSLINE-WIRE 추가 · 대표 11-17): one source for the status line, /status
// and `eln --version`.
//   official: `0.3.27 · official`                  (a release version from an install; no stamp)
//   dev:      `0.3.28-dev.0 · 261117_1925 · dev`   (stamp = the build commit's committer time in KST, yymmdd_hhmm)
// The stamp comes from the install metadata (recorded with the sha), else `git log -1 --format=%ct <sha>` in the
// checkout or the install source; when neither has it, it is left out — never invented.

import { fileURLToPath } from 'node:url';
import { codeRevision, gitCommitTime, installMetadataCommitTime, installMetadataSource, packageVersion, runsFromCheckout } from './code-revision.js';

// 출처: KST is UTC+9 with no daylight saving time.
const KST_OFFSET_SECONDS = 9 * 60 * 60;

/** yymmdd_hhmm in KST for an epoch-seconds instant (UTC 15:25 → the next day 00:25 KST). */
export function kstStamp(epochSeconds: number): string {
  const at = new Date((epochSeconds + KST_OFFSET_SECONDS) * 1000);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${two(at.getUTCFullYear() % 100)}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}_${two(at.getUTCHours())}${two(at.getUTCMinutes())}`;
}

export interface BuildIdentity {
  readonly version: string;
  readonly sha: string;
  readonly source: 'installed' | 'checkout' | 'unknown';
  readonly codeRoot?: string;
}

export interface VersionLabel {
  readonly channel: 'official' | 'dev';
  /** `0.3.27 · official` · `0.3.28-dev.0 · 261117_1925 · dev` (stamp left out when unknown) */
  readonly label: string;
  /** narrow (xs): `0.3.27·official` · `261117_1925·dev` (`dev` alone without a stamp) */
  readonly short: string;
  readonly stamp?: string;
}

/**
 * official = an installed build whose version is a plain release (no `-dev.N` or other pre-release part). Only a release
 * cut produces such a version (main is always `<next>-dev.N`), so this is the offline stand-in for «equal to the public
 * tag». Everything else — rail installs, checkouts, unknown builds — is dev.
 */
export function isOfficialBuild(build: Pick<BuildIdentity, 'version' | 'source'>): boolean {
  return /^\d+\.\d+\.\d+$/.test(build.version.trim()) && build.source === 'installed';
}

export function versionLabel(build: Pick<BuildIdentity, 'version' | 'source'>, commitTime?: number): VersionLabel {
  const version = build.version.trim() || '?';
  if (isOfficialBuild(build)) return { channel: 'official', label: `${version} · official`, short: `${version}·official` };
  const stamp = commitTime === undefined ? undefined : kstStamp(commitTime);
  return { channel: 'dev', label: [version, stamp, 'dev'].filter(Boolean).join(' · '), short: stamp ? `${stamp}·dev` : 'dev', ...(stamp ? { stamp } : {}) };
}

const commitTimes = new Map<string, number | undefined>();

/** The committer time of the running build's commit: install metadata → git in the code root or the install source.
 *  Looked up once per sha and process (the status line asks on every frame). */
export function buildCommitTime(build: BuildIdentity): number | undefined {
  if (!build.sha) return undefined;
  if (commitTimes.has(build.sha)) return commitTimes.get(build.sha);
  const found = lookupCommitTime(build);
  commitTimes.set(build.sha, found);
  return found;
}

// This code's own repository root (src/version → ../..), used when the caller does not name one.
const CODE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function lookupCommitTime(build: BuildIdentity): number | undefined {
  const root = build.codeRoot ?? CODE_ROOT;
  const fromMeta = installMetadataCommitTime(root, build.sha);
  if (fromMeta !== undefined) return fromMeta;
  for (const cwd of [root, root ? installMetadataSource(root) : installMetadataSource()]) {
    if (!cwd) continue;
    const seconds = gitCommitTime(cwd, build.sha);
    if (seconds !== undefined) return seconds;
  }
  return undefined;
}

/** `eln --version`: `0.3.27 <sha>` for official; `0.3.28-dev.0 261117_1925 <sha>` for dev (the sha stays the last field). */
export function cliVersionLine(build?: BuildIdentity): string {
  const sha = codeRevision() ?? 'unknown';
  const identity: BuildIdentity = build ?? { version: packageVersion(), sha: sha === 'unknown' ? '' : sha,
    source: sha === 'unknown' ? 'unknown' : runsFromCheckout() ? 'checkout' : 'installed' };
  const label = versionLabel(identity, isOfficialBuild(identity) ? undefined : buildCommitTime(identity));
  return [identity.version, label.stamp, sha].filter(Boolean).join(' ');
}
