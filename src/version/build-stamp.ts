import { fileURLToPath } from 'node:url';
import { codeRevision, gitCommitTime, installMetadataCommitTime, installMetadataSource, installedBuildMetadata, packagedBuildTime, packageVersion, runsFromCheckout, type BuildChannel } from './code-revision.js';

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
  readonly channel?: BuildChannel;
  readonly builtAt?: number;
}

export interface VersionLabel {
  readonly channel: 'official' | 'dev';
  /** `0.3.27 · official · 261117_1925` (stamp omitted when unknown) */
  readonly label: string;
  /** narrow (xs): `0.3.27·official` · `261117_1925·dev` (`dev` alone without a stamp) */
  readonly short: string;
  readonly stamp?: string;
}

/** The publishing path owns the channel. A source checkout always runs as dev. */
export function versionLabel(build: Pick<BuildIdentity, 'version' | 'source' | 'channel' | 'builtAt'>, commitTime?: number): VersionLabel {
  const version = build.version.trim() || '?';
  const channel = build.source === 'installed' && build.channel === 'official' ? 'official' : 'dev';
  const builtAt = build.builtAt ?? commitTime;
  const stamp = builtAt === undefined ? undefined : kstStamp(builtAt);
  return { channel, label: [version, channel, stamp].filter(Boolean).join(' · '),
    short: stamp ? `${stamp}·${channel}` : channel === 'official' ? `${version}·official` : 'dev',
    ...(stamp ? { stamp } : {}) };
}

const commitTimes = new Map<string, number | undefined>();

/** The packed build time, with legacy commit-time fallback.
 *  Looked up once per sha and process (the status line asks on every frame). */
export function buildCommitTime(build: BuildIdentity): number | undefined {
  if (build.builtAt !== undefined) return build.builtAt;
  if (!build.sha) return undefined;
  const key = `${build.codeRoot ?? CODE_ROOT}:${build.sha}`;
  if (commitTimes.has(key)) return commitTimes.get(key);
  const found = lookupCommitTime(build);
  commitTimes.set(key, found);
  return found;
}

// This code's own repository root (src/version → ../..), used when the caller does not name one.
const CODE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function lookupCommitTime(build: BuildIdentity): number | undefined {
  const root = build.codeRoot ?? CODE_ROOT;
  const metadata = installedBuildMetadata(root);
  if (metadata?.commit === build.sha && metadata.builtAt !== undefined) return metadata.builtAt;
  const fromMeta = packagedBuildTime(root, build.sha) ?? installMetadataCommitTime(root, build.sha);
  if (fromMeta !== undefined) return fromMeta;
  for (const cwd of [root, root ? installMetadataSource(root) : installMetadataSource()]) {
    if (!cwd) continue;
    const seconds = gitCommitTime(cwd, build.sha);
    if (seconds !== undefined) return seconds;
  }
  return undefined;
}

export function cliBuildIdentity(): BuildIdentity {
  const sha = codeRevision() ?? '';
  const metadata = installedBuildMetadata();
  if (metadata) return { version: packageVersion(), sha, source: 'installed', channel: metadata.channel, builtAt: metadata.builtAt };
  return { version: packageVersion(), sha, source: sha ? runsFromCheckout() ? 'checkout' : 'installed' : 'unknown' };
}

/** The revision remains the last field for callers that parse it. */
export function cliVersionLine(build: BuildIdentity = cliBuildIdentity()): string {
  const label = versionLabel(build, buildCommitTime(build));
  return [build.version, label.stamp, build.sha || 'unknown'].filter(Boolean).join(' ');
}
