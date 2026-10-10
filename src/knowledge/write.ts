// ── PFC-S4.3: KnowledgeWrite core ──
//
// Wraps Obsidian's atomic writeNote with:
//   - vault-boundary check (rel_path cannot escape via `..`/absolute)
//   - overwrite guard (default false)
//   - kind-based Poka-Yoke schema (required frontmatter fields)
//   - automatic tag / kind merge into frontmatter
//   - Poka-Yoke validation → atomic-write ONLY on pass

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { packDirDeterministic } from '../market/tgz.js';
import { verifyIndex } from '../market/signed-index.js';
import {
  writeNote,
  type ObsidianVault,
} from '../auto-research/obsidian-bridge.js';
import type { PokaSchema, ValidationFailure } from '../cft/pokayoke.js';
import { validate } from '../cft/pokayoke.js';
import { isPackSlug, isPackVersion, packIdString, type Pack, type PackId } from './kgs/pack.js';
import { isKnowledgeKind, type KnowledgeCard } from './kgs/types.js';
import { kgsStoreSingleton, type KgsSqliteStore } from './kgs/sqlite-store.js';
import type {
  KnowledgeKind,
  KnowledgeWriteInput,
  KnowledgeWriteResult,
} from './types.js';

type Kind = Exclude<KnowledgeKind, 'all'>;

/** Required-field schemas per kind. Paths shown as [`frontmatter`, key]. */
const KIND_SCHEMAS: Record<Kind, PokaSchema> = {
  incident: {
    kind: 'object',
    shape: {
      severity: { kind: 'enum', values: ['LOW', 'MED', 'HIGH', 'CRITICAL'] },
      title: { kind: 'string', min: 1 },
      resolved: { kind: 'boolean' },
    },
    required: ['severity', 'title', 'resolved'],
  },
  a3: {
    kind: 'object',
    shape: {
      problem: { kind: 'string', min: 1 },
      countermeasure: { kind: 'string', min: 1 },
      owner: { kind: 'string', min: 1 },
    },
    required: ['problem', 'countermeasure', 'owner'],
  },
  rca: {
    kind: 'object',
    shape: {
      root_cause: { kind: 'string', min: 1 },
      whys: { kind: 'array', of: { kind: 'string' }, min: 1 },
    },
    required: ['root_cause', 'whys'],
  },
  wiki: {
    kind: 'object',
    shape: {
      tool: { kind: 'string', min: 1 },
      summary: { kind: 'string', min: 1 },
    },
    required: ['tool', 'summary'],
  },
  repomap: {
    kind: 'object',
    shape: {
      repo: { kind: 'string', min: 1 },
      commit: { kind: 'string', min: 1 },
    },
    required: ['repo', 'commit'],
  },
  note: {
    kind: 'object',
    shape: {
      title: { kind: 'string', min: 1 },
    },
    required: ['title'],
  },
};

export function knowledgeWrite(
  vault: ObsidianVault,
  input: KnowledgeWriteInput,
): KnowledgeWriteResult {
  if (!input.rel_path || typeof input.rel_path !== 'string') {
    throw new Error('knowledgeWrite: rel_path is required');
  }
  if (typeof input.body !== 'string') {
    throw new Error('knowledgeWrite: body is required');
  }
  if (input.rel_path.startsWith('/')) {
    throw new Error(`knowledgeWrite: rel_path '${input.rel_path}' must be relative (no leading /)`);
  }
  const rel = input.rel_path;
  if (rel.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error(`knowledgeWrite: rel_path '${input.rel_path}' escapes vault`);
  }
  const abs = resolve(vault.root, rel);
  if (!abs.startsWith(vault.root + sep) && abs !== vault.root) {
    throw new Error(`knowledgeWrite: rel_path '${input.rel_path}' escapes vault`);
  }

  const overwrite = input.overwrite ?? false;
  if (!overwrite && existsSync(abs)) {
    throw new Error(`knowledgeWrite: file exists and overwrite=false — ${rel}`);
  }

  // Merge frontmatter
  const fm: Record<string, unknown> = {
    ...(input.frontmatter ?? {}),
  };
  if (input.kind && input.kind !== undefined) fm.kind = input.kind;
  if (input.tags) fm.tags = Array.isArray(fm.tags)
    ? [...(fm.tags as unknown[]), ...input.tags]
    : [...input.tags];

  // Schema validation
  const kind = input.kind;
  const strict = input.strict_schema ?? true;
  if (strict && kind) {
    const schema = KIND_SCHEMAS[kind];
    const result = validate(fm, schema);
    if (!result.ok) {
      const errors: ValidationFailure[] = result.errors;
      const reasonOneLine =
        `knowledgeWrite schema rejected ${rel}: ${errors.length} issue(s) — `
        + errors.slice(0, 3).map((e) => `${e.path.join('.')}:${e.code}`).join(', ')
        + (errors.length > 3 ? '…' : '');
      return {
        ok: false,
        reasonOneLine,
        errors: errors.map((e) => ({
          path: ['frontmatter', ...e.path],
          message: e.message,
          code: e.code,
        })),
      };
    }
  }

  // Atomic write via existing obsidian-bridge.
  writeNote(vault, rel, input.body, fm);
  return { ok: true, path: abs, relPath: rel };
}

/** KPACK1 directory manifest. Market signatures belong to the index, not this file. */
export interface KnowledgePackManifest {
  kind: 'knowledge-pack';
  name: string;
  version: string;
  description: string;
  signature: { alg: 'ed25519'; keyId: string };
  dependencies: readonly { market: string; name: string; version: string }[];
  license: string;
  visibility: 'public' | 'internal';
  content: readonly { type: 'document' | 'glossary' | 'procedure' | 'rule' | 'qa'; path: string }[];
}

/** Verified marketplace evidence is required when installing from a market. The URL→key binding is caller-owned. */
export interface KnowledgePackMarketProof {
  marketplaceBytes: Uint8Array;
  signatureText: string;
  trustedKeys: ReadonlyArray<{ keyId: string; publicKey: string }>;
  artifactBytes: Uint8Array;
  lastSequence?: number;
}

export type KnowledgePackStore = Pick<KgsSqliteStore, 'readPack' | 'writePack' | 'deletePack' | 'replacePack'>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`KPACK1: ${field} must be a non-empty string`);
}

/** Never follow a symlink, including any ancestor of an enumerated content file. */
function safePackFile(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`KPACK1: unsafe path: ${path}`);
  }
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`KPACK1: symbolic link: ${path}`);
  }
  if (!lstatSync(current).isFile()) throw new Error(`KPACK1: not a file: ${path}`);
  return current;
}

/** Validate the manifest and all listed content before any store mutation. */
export function validateKnowledgePack(directory: string): { manifest: KnowledgePackManifest; pack: Pack } {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('KPACK1: not a directory');
  // The packer traverses the whole directory and refuses even unlisted symlinks/special files.
  packDirDeterministic(directory);
  return validatePackFiles(path => readFileSync(safePackFile(directory, path), 'utf8'));
}

/** Read the regular files of a deterministic ustar gzip archive (as produced by packDirDeterministic). */
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

function archiveFiles(archive: Uint8Array): Map<string, string> {
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('KPACK1: archive too large');
  let tar: Buffer;
  // Bound the inflated size so a small compressed bomb cannot exhaust memory.
  try { tar = gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_BYTES }); }
  catch (error) { throw new Error(`KPACK1: archive unreadable or larger than ${MAX_ARCHIVE_BYTES} bytes: ${String(error)}`); }
  const files = new Map<string, string>();
  const field = (header: Buffer, offset: number, width: number) => {
    const raw = header.subarray(offset, offset + width);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? width : end).toString('utf8');
  };
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const type = field(header, 156, 1);
    if (type !== '0' && type !== '') throw new Error('KPACK1: archive contains a non-regular entry');
    const size = Number.parseInt(field(header, 124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('KPACK1: malformed archive');
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    if (files.has(path)) throw new Error(`KPACK1: duplicate archive entry: ${path}`);
    files.set(path, tar.subarray(offset + 512, offset + 512 + size).toString('utf8'));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Validate from verified archive bytes, so what is stored is exactly what the signature covered. */
export function validateKnowledgePackArchive(archive: Uint8Array): { manifest: KnowledgePackManifest; pack: Pack } {
  const files = archiveFiles(archive);
  return validatePackFiles((path) => {
    const content = files.get(path);
    if (content === undefined) throw new Error(`KPACK1: missing from archive: ${path}`);
    return content;
  });
}

function validatePackFiles(read: (path: string) => string): { manifest: KnowledgePackManifest; pack: Pack } {
  const value: unknown = JSON.parse(read('knowledge-pack.json'));
  if (!object(value) || value.kind !== 'knowledge-pack') throw new Error('KPACK1: invalid kind');
  if (!isPackSlug(value.name) || !isPackVersion(value.version)) throw new Error('KPACK1: invalid name or version');
  requiredString(value.description, 'description');
  requiredString(value.license, 'license');
  if (!object(value.signature) || value.signature.alg !== 'ed25519' || typeof value.signature.keyId !== 'string' || !/^[a-fA-F0-9]{8}$/.test(value.signature.keyId)) throw new Error('KPACK1: invalid signature declaration');
  if (value.visibility !== 'public' && value.visibility !== 'internal') throw new Error('KPACK1: invalid visibility');
  if (!Array.isArray(value.dependencies) || !Array.isArray(value.content) || value.content.length === 0 || value.content.length > 200) throw new Error('KPACK1: invalid dependencies or content');
  for (const dep of value.dependencies) {
    if (!object(dep) || typeof dep.market !== 'string' || !/^https:\/\//.test(dep.market) || !isPackSlug(dep.name) || typeof dep.version !== 'string' || !dep.version.trim()) throw new Error('KPACK1: invalid dependency');
  }
  // No dependency resolver is available in standalone storage; never silently install an incomplete pack.
  if (value.dependencies.length) throw new Error('KPACK1: dependencies require a verified resolver');
  const seen = new Set<string>();
  const cards: KnowledgeCard[] = [];
  for (const entry of value.content) {
    if (!object(entry) || !['document', 'glossary', 'procedure', 'rule', 'qa'].includes(entry.type as string) || typeof entry.path !== 'string' || !entry.path.startsWith('content/') || !entry.path.endsWith('.json')) throw new Error('KPACK1: invalid content entry');
    if (seen.has(entry.path)) throw new Error(`KPACK1: duplicate content: ${entry.path}`);
    seen.add(entry.path);
    const item: unknown = JSON.parse(read(entry.path));
    if (!object(item) || item.type !== entry.type) throw new Error(`KPACK1: invalid content: ${entry.path}`);
    requiredString(item.title, `${entry.path}.title`);
    requiredString(item.source, `${entry.path}.source`);
    if (item.kind !== undefined && !isKnowledgeKind(item.kind)) throw new Error(`KPACK1: invalid content kind: ${entry.path}`);
    const fields: Record<string, readonly string[]> = {
      document: ['body'], glossary: ['term', 'definition'], procedure: ['preconditions'],
      rule: ['scope', 'basis'], qa: ['question', 'answer'],
    };
    for (const field of fields[entry.type as string]!) requiredString(item[field], `${entry.path}.${field}`);
    if (entry.type === 'procedure' && (!Array.isArray(item.steps) || !item.steps.length || !item.steps.every((step: unknown) => typeof step === 'string' && step.trim()))) throw new Error(`KPACK1: ${entry.path}.steps must be non-empty strings`);
    const body = entry.type === 'document' ? item.body as string : entry.type === 'procedure'
      ? `${item.preconditions}\n${(item.steps as string[]).join('\n')}`
      : fields[entry.type as string]!.map(field => item[field]).join('\n');
    const id = `card:${createHash('sha256').update(entry.path).digest('hex').slice(0, 16)}`;
    const timestamp = '1970-01-01T00:00:00.000Z';
    cards.push({ schema_version: 2, id, title: item.title, body, kind: isKnowledgeKind(item.kind) ? item.kind : 'card',
      nature: 'fact', reliability: 'self-reported', author: value.name,
      createdAt: timestamp, updatedAt: timestamp, source: { kind: 'external', url: item.source }, tags: [] });
  }
  const manifest = value as unknown as KnowledgePackManifest;
  return { manifest, pack: {
    schema_version: 2,
    metadata: { id: { slug: manifest.name, version: manifest.version }, title: manifest.name,
      intent: manifest.description, audience: manifest.visibility === 'public' ? 'public' : 'team',
      kind: 'generic', createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z',
      author: manifest.name, tags: [] }, cards,
  } };
}

/**
 * Market path: verify the signed index and artifact first, then build the pack
 * from those verified bytes (never from a second read of the directory).
 */
function verifiedMarketPack(directory: string, proof: KnowledgePackMarketProof): { manifest: KnowledgePackManifest; pack: Pack } {
  const verified = verifyIndex(proof);
  if (!verified.ok) throw new Error(`KPACK1: index ${verified.reason}: ${verified.detail}`);
  const artifact = Buffer.from(proof.artifactBytes);
  const sha256 = createHash('sha256').update(artifact).digest('hex');
  const listed = verified.index.knowledgePacks?.filter(pack => pack.artifact.bytes === artifact.byteLength && pack.artifact.sha256.toLowerCase() === sha256) ?? [];
  if (!listed.length) throw new Error('KPACK1: artifact hash or size mismatch');
  const result = validateKnowledgePackArchive(artifact);
  const { manifest } = result;
  if (verified.keyId !== manifest.signature.keyId) throw new Error('KPACK1: manifest keyId differs from signed index');
  const entry = listed.find(pack => pack.name === manifest.name && pack.version === manifest.version);
  if (!entry || entry.visibility !== manifest.visibility || (entry.visibility === 'internal' && !entry.enterpriseId)) throw new Error('KPACK1: pack absent from signed index');
  // The local directory must still be the extraction of this artifact.
  validateKnowledgePack(directory);
  if (Buffer.compare(Buffer.from(packDirDeterministic(directory)), artifact) !== 0) throw new Error('KPACK1: extracted directory differs from verified artifact');
  return result;
}

/** Local-path installs validate content; market installs additionally require signed-index and archive proof. */
export function installKnowledgePack(directory: string, store: KnowledgePackStore = kgsStoreSingleton(), proof?: KnowledgePackMarketProof): string {
  const { manifest, pack } = proof ? verifiedMarketPack(directory, proof) : validateKnowledgePack(directory);
  if (store.readPack(manifest.name, manifest.version)) throw new Error(`KPACK1: already installed: ${packIdString(pack.metadata.id)}`);
  store.writePack(pack);
  return packIdString(pack.metadata.id);
}

export function removeKnowledgePack(id: PackId, store: KnowledgePackStore = kgsStoreSingleton()): boolean {
  if (!isPackSlug(id.slug) || !isPackVersion(id.version)) throw new Error('KPACK1: invalid pack id');
  return store.deletePack(id.slug, id.version);
}

function comparePackVersions(next: string, previous: string): number {
  if (!isPackVersion(next) || !isPackVersion(previous)) throw new Error('KPACK1: invalid pack version');
  const nextSeparator = next.indexOf('-');
  const previousSeparator = previous.indexOf('-');
  const nextCore = nextSeparator < 0 ? next : next.slice(0, nextSeparator);
  const previousCore = previousSeparator < 0 ? previous : previous.slice(0, previousSeparator);
  const nextPre = nextSeparator < 0 ? undefined : next.slice(nextSeparator + 1);
  const previousPre = previousSeparator < 0 ? undefined : previous.slice(previousSeparator + 1);
  const left = nextCore.split('.').map(BigInt);
  const right = previousCore.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
  }
  if (nextPre === previousPre) return 0;
  if (!nextPre) return 1;
  if (!previousPre) return -1;
  const nextIdentifiers = nextPre.split('.');
  const previousIdentifiers = previousPre.split('.');
  for (let i = 0; i < Math.min(nextIdentifiers.length, previousIdentifiers.length); i++) {
    const nextIdentifier = nextIdentifiers[i]!;
    const previousIdentifier = previousIdentifiers[i]!;
    if (nextIdentifier === previousIdentifier) continue;
    const nextNumeric = /^\d+$/.test(nextIdentifier);
    const previousNumeric = /^\d+$/.test(previousIdentifier);
    if (nextNumeric && previousNumeric) {
      return BigInt(nextIdentifier) > BigInt(previousIdentifier) ? 1 : -1;
    }
    if (nextNumeric) return -1;
    if (previousNumeric) return 1;
    return nextIdentifier > previousIdentifier ? 1 : -1;
  }
  return Math.sign(nextIdentifiers.length - previousIdentifiers.length);
}

/** Atomically switch one installed version after the replacement has passed validation. */
export function upgradeKnowledgePack(previous: PackId, directory: string, store: KnowledgePackStore = kgsStoreSingleton(), proof?: KnowledgePackMarketProof): string {
  if (!isPackSlug(previous.slug) || !isPackVersion(previous.version)) throw new Error('KPACK1: invalid previous pack id');
  const { manifest, pack } = proof ? verifiedMarketPack(directory, proof) : validateKnowledgePack(directory);
  if (manifest.name !== previous.slug || comparePackVersions(manifest.version, previous.version) <= 0) throw new Error('KPACK1: upgrade requires a newer version of the same pack');
  store.replacePack(previous, pack);
  return packIdString(pack.metadata.id);
}

/** Test helper — size of the KIND_SCHEMAS dict for assertion. */
export function _kindSchemaCountForTest(): number {
  return Object.keys(KIND_SCHEMAS).length;
}
