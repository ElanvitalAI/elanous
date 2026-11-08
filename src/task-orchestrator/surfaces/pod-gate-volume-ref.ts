import { chmodSync, closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const GATE_VOLUME_REF_IDENTITY_FILE = '.elanous-volume-ref.json';
export const GATE_VOLUME_REF_MOUNT_PATH = {
  'git-mirror': '/host-mirror',
  'node_modules': '/external/node_modules',
  'bun-cache': '/bun-cache',
} as const;

export type GateExternalVolumeKind = keyof typeof GATE_VOLUME_REF_MOUNT_PATH;
/** Expected digest is cut-owned data, kept outside the referenced volume. */
export interface GateExternalVolumeRef { kind: GateExternalVolumeKind; hostPath: string; contentSha256: string; identitySha256: string }
export interface GateExternalVolumeReady { kind: GateExternalVolumeKind; verifyMs: number }
export interface GateExternalVolumeRejected { kind: GateExternalVolumeKind; reason: string }

export interface GateVolumeRuntimeIdentity {
  imageDigest: string;
  bunVersion: string;
  os: 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
}

/** Read the executing Pod's runtime tuple and bind it to the cut runner's immutable image digest. */
export function currentGateVolumeRuntimeIdentity(imageDigest: string): GateVolumeRuntimeIdentity {
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageDigest)) throw new Error('image-digest-unmeasured');
  const os = process.platform;
  const arch = process.arch;
  const bunVersion = process.versions.bun;
  if ((os !== 'linux' && os !== 'darwin') || (arch !== 'x64' && arch !== 'arm64') || !bunVersion) {
    throw new Error('runtime-identity-unmeasured');
  }
  return { imageDigest, bunVersion, os, arch };
}

export interface GateExternalVolumeIdentity {
  schemaVersion: 1;
  kind: GateExternalVolumeKind;
  runtimeIdentity: GateVolumeRuntimeIdentity | null;
  lockSha256: string | null;
  sourceCommit: string | null;
  contentSha256: string | null;
}

export interface GateExternalVolumeExpectation {
  kind: GateExternalVolumeKind;
  contentSha256: string;
  identitySha256: string;
  runtimeIdentity?: GateVolumeRuntimeIdentity;
  lockSha256?: string;
  sourceCommit?: string;
}

export interface GateExternalVolumeExpectations {
  imageDigest: string;
  lockSha256: string;
  sourceCommit: string;
}

export type GateExternalVolumeVerification =
  | { ok: true; identity: GateExternalVolumeIdentity }
  | { ok: false; reason: string };

export function parseGateExternalVolumeReadyEvents(text: string): GateExternalVolumeReady[] {
  return [...text.matchAll(/^ELANOUS_GATE_VOLUME_REF_READY (git-mirror|node_modules|bun-cache) (\d+(?:\.\d+)?)$/gmu)]
    .map((match) => ({ kind: match[1] as GateExternalVolumeKind, verifyMs: Number(match[2]) }))
    .filter((event) => Number.isFinite(event.verifyMs) && event.verifyMs >= 0);
}

export function parseGateExternalVolumeRejectedEvents(text: string): GateExternalVolumeRejected[] {
  return [...text.matchAll(/^ELANOUS_GATE_VOLUME_REF_REJECTED (git-mirror|node_modules|bun-cache) ([^\r\n]+)$/gmu)]
    .map((match) => ({ kind: match[1] as GateExternalVolumeKind, reason: match[2]!.trim() }));
}

export function gateExternalVolumeMeasurements(
  expected: readonly GateExternalVolumeRef[],
  ready: readonly GateExternalVolumeReady[],
  rejected: readonly GateExternalVolumeRejected[] = [],
  snapshotPreparationMs = 0,
): { volumeRefPod: boolean; volumeRefExpectedCount: number; volumeRefReadyCount: number; volumeRefKinds: GateExternalVolumeKind[];
  volumeRefRejected: GateExternalVolumeRejected[]; volumeRefSnapshotPreparationMs: number; volumeRefVerificationMs: number; volumeRefPreparationMs: number } {
  const expectedKinds = expected.map(({ kind }) => kind).sort();
  const readyKinds = ready.map(({ kind }) => kind).sort();
  const distinctReadyKinds = new Set(readyKinds);
  const volumeRefPod = rejected.length === 0 && expectedKinds.length > 0 && expectedKinds.length === readyKinds.length
    && distinctReadyKinds.size === readyKinds.length && expectedKinds.every((kind, index) => kind === readyKinds[index]);
  return {
    volumeRefPod,
    volumeRefExpectedCount: expectedKinds.length,
    volumeRefReadyCount: readyKinds.length,
    volumeRefKinds: ready.map(({ kind }) => kind),
    volumeRefRejected: [...rejected],
    volumeRefSnapshotPreparationMs: snapshotPreparationMs,
    volumeRefVerificationMs: ready.reduce((sum, event) => sum + event.verifyMs, 0),
    volumeRefPreparationMs: snapshotPreparationMs + ready.reduce((sum, event) => sum + event.verifyMs, 0),
  };
}

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

export function parseGateExternalVolumeRefs(value: unknown): GateExternalVolumeRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('gatePodExternalVolumeRefs must be an array');
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('gate external volume ref must be an object');
    const row = item as Record<string, unknown>;
    if (typeof row.kind !== 'string' || !Object.hasOwn(GATE_VOLUME_REF_MOUNT_PATH, row.kind)) throw new Error('gate external volume ref kind is invalid');
    const kind = row.kind as GateExternalVolumeKind;
    if (seen.has(kind)) throw new Error(`gate external volume ref kind is duplicated: ${kind}`);
    seen.add(kind);
    if (typeof row.hostPath !== 'string' || !isAbsolute(row.hostPath) || resolve(row.hostPath) !== row.hostPath) {
      throw new Error(`gate external volume ref path is not canonical: ${kind}`);
    }
    if (typeof row.contentSha256 !== 'string' || !SHA256.test(row.contentSha256)) {
      throw new Error(`gate external volume ref trusted content digest is missing or invalid: ${kind}`);
    }
    if (typeof row.identitySha256 !== 'string' || !SHA256.test(row.identitySha256)) {
      throw new Error(`gate external volume ref trusted identity digest is missing or invalid: ${kind}`);
    }
    return { kind, hostPath: row.hostPath, contentSha256: row.contentSha256, identitySha256: row.identitySha256 };
  });
}

export interface GateExternalVolumeSealInput {
  kind: GateExternalVolumeKind;
  runtimeIdentity?: GateVolumeRuntimeIdentity;
  lockSha256?: string;
  sourceCommit?: string;
}

function addField(hash: ReturnType<typeof createHash>, value: Buffer | string): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Hash a volume tree using sorted paths, entry types, read/execute mode and file or symlink bytes.
 * Write bits are excluded because the node snapshot strips them before a Pod mounts it. */
export function gateExternalVolumeContentSha256(rootPath: string): string {
  const root = realpathSync(rootPath);
  if (!lstatSync(rootPath).isDirectory()) throw new Error('volume-root-not-directory');
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (full === join(root, GATE_VOLUME_REF_IDENTITY_FILE)) continue;
      const rel = relative(root, full).split(sep).join('/');
      const stat = lstatSync(full);
      entries.push(rel);
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(root);
  entries.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

  const hash = createHash('sha256');
  for (const rel of entries) {
    const full = join(root, ...rel.split('/'));
    const stat = lstatSync(full);
    addField(hash, rel);
    addField(hash, String(stat.mode & 0o555));
    if (stat.isDirectory()) {
      addField(hash, 'directory');
    } else if (stat.isFile()) {
      addField(hash, 'file');
      addField(hash, String(stat.size));
      const fd = openSync(full, 'r');
      try {
        const chunk = Buffer.allocUnsafe(128 * 1024);
        for (;;) {
          const read = readSync(fd, chunk, 0, chunk.length, null);
          if (read === 0) break;
          hash.update(chunk.subarray(0, read));
        }
      } finally { closeSync(fd); }
    } else if (stat.isSymbolicLink()) {
      const linkTarget = readlinkSync(full);
      if (isAbsolute(linkTarget) || !inside(root, resolve(dirname(full), linkTarget))) throw new Error(`volume-symlink-escapes-root:${rel}`);
      let resolvedTarget: string;
      try { resolvedTarget = realpathSync(full); } catch { throw new Error(`volume-symlink-dangling:${rel}`); }
      if (!inside(root, resolvedTarget)) throw new Error(`volume-symlink-escapes-root:${rel}`);
      addField(hash, 'symlink');
      addField(hash, linkTarget);
    } else {
      throw new Error(`volume-special-file:${rel}`);
    }
  }
  return hash.digest('hex');
}

/** Hashes identity fields in a fixed key order so the cut can pin metadata outside the mutable volume marker. */
export function gateExternalVolumeIdentitySha256(identity: GateExternalVolumeIdentity): string {
  const canonical = { schemaVersion: identity.schemaVersion, kind: identity.kind, runtimeIdentity: identity.runtimeIdentity,
    lockSha256: identity.lockSha256, sourceCommit: identity.sourceCommit, contentSha256: identity.contentSha256 };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function isRuntimeIdentity(value: unknown): value is GateVolumeRuntimeIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.imageDigest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(row.imageDigest)
    && typeof row.bunVersion === 'string' && row.bunVersion.length > 0
    && (row.os === 'linux' || row.os === 'darwin')
    && (row.arch === 'x64' || row.arch === 'arm64');
}

export function parseGateExternalVolumeIdentity(text: string): GateExternalVolumeIdentity {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('identity-not-object');
  const row = parsed as Record<string, unknown>;
  if (row.schemaVersion !== 1 || typeof row.kind !== 'string' || !Object.hasOwn(GATE_VOLUME_REF_MOUNT_PATH, row.kind)) throw new Error('identity-schema-or-kind-invalid');
  const kind = row.kind as GateExternalVolumeKind;
  const runtimeIdentity = row.runtimeIdentity === null ? null : isRuntimeIdentity(row.runtimeIdentity) ? row.runtimeIdentity : undefined;
  if (runtimeIdentity === undefined) throw new Error('identity-runtime-invalid');
  const lockSha256 = row.lockSha256 === null ? null : typeof row.lockSha256 === 'string' && SHA256.test(row.lockSha256) ? row.lockSha256 : undefined;
  const sourceCommit = row.sourceCommit === null ? null : typeof row.sourceCommit === 'string' && COMMIT.test(row.sourceCommit) ? row.sourceCommit : undefined;
  const contentSha256 = row.contentSha256 === null ? null : typeof row.contentSha256 === 'string' && SHA256.test(row.contentSha256) ? row.contentSha256 : undefined;
  if (lockSha256 === undefined || sourceCommit === undefined || contentSha256 === undefined) throw new Error('identity-digest-invalid');
  const validShape = kind === 'git-mirror'
    ? runtimeIdentity === null && lockSha256 === null && !!sourceCommit && !!contentSha256
    : runtimeIdentity !== null && !!lockSha256 && sourceCommit === null && !!contentSha256;
  if (!validShape) throw new Error('identity-fields-do-not-match-kind');
  return { schemaVersion: 1, kind, runtimeIdentity, lockSha256, sourceCommit, contentSha256 };
}

/** Create and atomically write a read-only identity marker after measuring the exact input tree. */
export function sealGateExternalVolume(root: string, input: GateExternalVolumeSealInput): GateExternalVolumeIdentity {
  if (!isAbsolute(root) || !lstatSync(root).isDirectory()) throw new Error('path-not-absolute-directory');
  let identity: GateExternalVolumeIdentity;
  if (input.kind === 'git-mirror') {
    if (!input.sourceCommit || !COMMIT.test(input.sourceCommit)) throw new Error('source-commit-invalid');
    if (existsSync(join(root, 'objects', 'info', 'alternates'))) throw new Error('git-mirror-external-alternates-forbidden');
    const contentSha256 = gateExternalVolumeContentSha256(root);
    execFileSync('git', ['-c', `safe.directory=${root}`, '--git-dir', root, 'cat-file', '-e', `${input.sourceCommit}^{commit}`], {
      stdio: 'ignore', env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' },
    });
    identity = { schemaVersion: 1, kind: input.kind, runtimeIdentity: null, lockSha256: null,
      sourceCommit: input.sourceCommit, contentSha256 };
  } else {
    if (!input.runtimeIdentity || !isRuntimeIdentity(input.runtimeIdentity)) throw new Error('runtime-identity-invalid');
    if (!input.lockSha256 || !SHA256.test(input.lockSha256)) throw new Error('lock-hash-invalid');
    identity = { schemaVersion: 1, kind: input.kind, runtimeIdentity: input.runtimeIdentity,
      lockSha256: input.lockSha256, sourceCommit: null, contentSha256: gateExternalVolumeContentSha256(root) };
  }
  const temp = join(root, `.volume-ref-${randomUUID()}.tmp`);
  const marker = join(root, GATE_VOLUME_REF_IDENTITY_FILE);
  try {
    writeFileSync(temp, `${JSON.stringify(identity)}\n`, { mode: 0o444, flag: 'wx' });
    chmodSync(temp, 0o444);
    renameSync(temp, marker);
    chmodSync(marker, 0o444);
  } finally {
    // rename consumes the temp name; a failed seal leaves no misleading marker behind.
    try { unlinkSync(temp); } catch { /* already renamed or absent */ }
  }
  return identity;
}

export function verifyGateExternalVolumeRef(root: string, expected: GateExternalVolumeExpectation): GateExternalVolumeVerification {
  try {
    if (!isAbsolute(root)) return { ok: false, reason: 'path-not-absolute' };
    realpathSync(root);
    if (!lstatSync(root).isDirectory()) return { ok: false, reason: 'path-not-directory-or-symlink' };
    const marker = join(root, GATE_VOLUME_REF_IDENTITY_FILE);
    let markerStat;
    try { markerStat = lstatSync(marker); } catch { return { ok: false, reason: 'identity-file-missing' }; }
    if (!markerStat.isFile()) return { ok: false, reason: 'identity-file-not-regular-file' };
    const identity = parseGateExternalVolumeIdentity(readFileSync(marker, 'utf8'));
    if (identity.kind !== expected.kind) return { ok: false, reason: 'kind-mismatch' };
    if (!SHA256.test(expected.contentSha256) || identity.contentSha256 !== expected.contentSha256) {
      return { ok: false, reason: 'trusted-content-hash-mismatch' };
    }
    if (!SHA256.test(expected.identitySha256) || gateExternalVolumeIdentitySha256(identity) !== expected.identitySha256) {
      return { ok: false, reason: 'trusted-identity-hash-mismatch' };
    }
    if (expected.kind === 'git-mirror') {
      if (!expected.sourceCommit || !COMMIT.test(expected.sourceCommit) || identity.sourceCommit !== expected.sourceCommit) return { ok: false, reason: 'source-commit-mismatch' };
      if (existsSync(join(root, 'objects', 'info', 'alternates'))) return { ok: false, reason: 'git-mirror-external-alternates-forbidden' };
      if (gateExternalVolumeContentSha256(root) !== expected.contentSha256) return { ok: false, reason: 'content-hash-mismatch' };
      execFileSync('git', ['-c', `safe.directory=${root}`, '--git-dir', root, 'cat-file', '-e', `${expected.sourceCommit}^{commit}`], {
        stdio: 'ignore', env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' },
      });
    } else {
      if (!expected.runtimeIdentity || !expected.lockSha256 || !SHA256.test(expected.lockSha256)) return { ok: false, reason: 'expected-identity-incomplete' };
      const actualRuntime = identity.runtimeIdentity!;
      const expectedRuntime = expected.runtimeIdentity;
      if (actualRuntime.imageDigest !== expectedRuntime.imageDigest || actualRuntime.bunVersion !== expectedRuntime.bunVersion
        || actualRuntime.os !== expectedRuntime.os || actualRuntime.arch !== expectedRuntime.arch) return { ok: false, reason: 'runtime-identity-mismatch' };
      if (identity.lockSha256 !== expected.lockSha256) return { ok: false, reason: 'lock-hash-mismatch' };
      const actualContent = gateExternalVolumeContentSha256(root);
      if (actualContent !== identity.contentSha256) return { ok: false, reason: 'content-hash-mismatch' };
    }
    return { ok: true, identity };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
