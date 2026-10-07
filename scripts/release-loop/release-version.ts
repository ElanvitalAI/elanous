// Release version shapes for the release loop: a stable x.y.z or a prerelease x.y.z-(rc|alpha|beta).N.
// RELEASE-BRANCH ⊕ RELEASE-REHEARSAL-RC (10-06): prerelease runs publish to npm `next` and skip the
// post-publish nodes that touch main or the operating hosts.

export const PRERELEASE_KINDS = ['rc', 'alpha', 'beta'] as const;
export type PrereleaseKind = (typeof PRERELEASE_KINDS)[number];

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(rc|alpha|beta)\.(0|[1-9]\d*))?$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isStableVersion(version: string): boolean { return STABLE_VERSION.test(version); }

export function isReleaseVersion(version: string): boolean { return RELEASE_VERSION.test(version); }

/** `0.2.18-rc.0` → `0.2.18`; a stable version is returned as is. Throws on anything else. */
export function baseVersion(version: string): string {
  const match = RELEASE_VERSION.exec(version);
  if (!match) throw new Error(`invalid release version: ${version}`);
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** The prerelease kind of `0.2.18-rc.0` (`rc`), or null for a stable version. */
export function prereleaseKind(version: string): PrereleaseKind | null {
  const match = RELEASE_VERSION.exec(version);
  if (!match) throw new Error(`invalid release version: ${version}`);
  return (match[4] as PrereleaseKind | undefined) ?? null;
}

export function isPrereleaseKind(value: unknown): value is PrereleaseKind {
  return typeof value === 'string' && (PRERELEASE_KINDS as readonly string[]).includes(value);
}

/**
 * The next free prerelease number for `base` and `kind`, given the names already taken
 * (release branches `release/<v>` and tags `v<v>`, with or without those prefixes).
 */
export function nextPrereleaseVersion(base: string, kind: PrereleaseKind, taken: readonly string[]): string {
  if (!STABLE_VERSION.test(base)) throw new Error(`prerelease base must be x.y.z: ${base}`);
  const prefix = `${base}-${kind}.`;
  let next = 0;
  for (const raw of taken) {
    const name = raw.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '').replace(/^release\//, '').replace(/^v(?=\d)/, '').replace(/\^\{\}$/, '');
    if (!name.startsWith(prefix)) continue;
    const n = name.slice(prefix.length);
    if (/^(0|[1-9]\d*)$/.test(n)) next = Math.max(next, Number(n) + 1);
  }
  return `${prefix}${next}`;
}
