// KGS P1 Pack — portable bundle of related cards.
// Unit Thinker (Y4) emits as proposals, OMF marketplace (Z15 / S22) trades.

import type {
  Bloom2D,
  BfoCategory,
  KnowledgeCard,
  KnowledgeKind,
  SchemaOrgType,
} from './types.js';

export type PackAudience =
  | 'self'           // user's own knowledge bank
  | 'team'           // shared inside an org
  | 'public'         // marketplace listing
  | 'patcher-only'
  | 'thinker-only';

export const PACK_AUDIENCES: readonly PackAudience[] = [
  'self', 'team', 'public', 'patcher-only', 'thinker-only',
];

export function isPackAudience(v: unknown): v is PackAudience {
  return typeof v === 'string'
    && (PACK_AUDIENCES as readonly string[]).includes(v);
}

export type PackKind =
  | 'mission-template'      // OMF (S22)
  | 'workflow-proposal'     // Thinker auto-gen (S19)
  | 'course-pack'
  | 'incident-bundle'       // RCA + retrospective + warnings
  | 'research-bundle'
  | 'generic';

export const PACK_KINDS: readonly PackKind[] = [
  'mission-template', 'workflow-proposal', 'course-pack',
  'incident-bundle', 'research-bundle', 'generic',
];

export function isPackKind(v: unknown): v is PackKind {
  return typeof v === 'string'
    && (PACK_KINDS as readonly string[]).includes(v);
}

/** Stable id — `pack:<slug>@<version>`. */
export interface PackId {
  slug: string;
  version: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-z0-9-]+(?:\.[a-z0-9-]+)*)?$/;

export function isPackSlug(v: unknown): v is string {
  return typeof v === 'string' && SLUG_RE.test(v);
}

export function isPackVersion(v: unknown): v is string {
  if (typeof v !== 'string' || !VERSION_RE.test(v)) return false;
  const separator = v.indexOf('-');
  const prerelease = separator < 0 ? undefined : v.slice(separator + 1);
  return prerelease === undefined || prerelease.split('.').every(id => !/^\d+$/.test(id) || id === '0' || !id.startsWith('0'));
}

export function packIdString(id: PackId): string {
  return `pack:${id.slug}@${id.version}`;
}

export function parsePackIdString(s: string): PackId | null {
  const m = /^pack:([^@]+)@(.+)$/.exec(s);
  if (!m) return null;
  const slug = m[1]!;
  const version = m[2]!;
  if (!isPackSlug(slug) || !isPackVersion(version)) return null;
  return { slug, version };
}

export interface PackMetadata {
  id: PackId;
  title: string;
  /** 1-2 sentence "why this bundle exists". */
  intent: string;
  audience: PackAudience;
  kind: PackKind;
  createdAt: string;
  updatedAt: string;
  author: string;
  tags: readonly string[];
  schema_org_type?: SchemaOrgType;
  bfo?: BfoCategory;
  bloom?: Bloom2D;
  /** Predecessor pack — set when this pack supersedes another (template iteration). */
  supersedes?: PackId;
}

export interface Pack {
  schema_version: 2;
  metadata: PackMetadata;
  /** Order matters for mission-template / course-pack / workflow-proposal (sequence semantics). */
  cards: readonly KnowledgeCard[];
}

export interface PackInit {
  id: PackId;
  title: string;
  intent: string;
  audience: PackAudience;
  kind: PackKind;
  author: string;
  cards: readonly KnowledgeCard[];
  tags?: readonly string[];
  schema_org_type?: SchemaOrgType;
  bfo?: BfoCategory;
  bloom?: Bloom2D;
  supersedes?: PackId;
  /** Test seam. */
  now?: number;
}

export const PACK_DEFAULTS = {
  titleMaxLen: 200,
  intentMaxLen: 600,
  maxCards: 200,
} as const;

export function createPack(init: PackInit): Pack {
  if (!isPackSlug(init.id.slug)) {
    throw new RangeError(`Pack.id.slug must match ${SLUG_RE.source}`);
  }
  if (!isPackVersion(init.id.version)) {
    throw new RangeError('Pack.id.version must look like 1.2.3 (semver)');
  }
  if (!init.title || init.title.length === 0) {
    throw new RangeError('Pack.title must be non-empty');
  }
  if (init.title.length > PACK_DEFAULTS.titleMaxLen) {
    throw new RangeError(`Pack.title exceeds ${PACK_DEFAULTS.titleMaxLen} chars`);
  }
  if (!init.intent || init.intent.length === 0) {
    throw new RangeError('Pack.intent must be non-empty');
  }
  if (init.intent.length > PACK_DEFAULTS.intentMaxLen) {
    throw new RangeError(`Pack.intent exceeds ${PACK_DEFAULTS.intentMaxLen} chars`);
  }
  if (init.cards.length > PACK_DEFAULTS.maxCards) {
    throw new RangeError(
      `Pack carries ${init.cards.length} cards, exceeds ${PACK_DEFAULTS.maxCards} cap`,
    );
  }
  const ts = new Date(init.now ?? Date.now()).toISOString();
  return {
    schema_version: 2,
    metadata: {
      id: { slug: init.id.slug, version: init.id.version },
      title: init.title,
      intent: init.intent,
      audience: init.audience,
      kind: init.kind,
      createdAt: ts,
      updatedAt: ts,
      author: init.author,
      tags: Object.freeze([...(init.tags ?? [])]),
      schema_org_type: init.schema_org_type,
      bfo: init.bfo,
      bloom: init.bloom,
      supersedes: init.supersedes,
    },
    cards: Object.freeze([...init.cards]),
  };
}

export function appendCardToPack(
  pack: Pack,
  card: KnowledgeCard,
  opts?: { now?: number },
): Pack {
  if (pack.cards.length + 1 > PACK_DEFAULTS.maxCards) {
    throw new RangeError(
      `Pack ${packIdString(pack.metadata.id)} card cap exceeded`,
    );
  }
  const ts = new Date(opts?.now ?? Date.now()).toISOString();
  return {
    ...pack,
    metadata: { ...pack.metadata, updatedAt: ts },
    cards: Object.freeze([...pack.cards, card]),
  };
}

export function summarizePackKinds(pack: Pack): Record<KnowledgeKind, number> {
  const out: Partial<Record<KnowledgeKind, number>> = {};
  for (const c of pack.cards) {
    out[c.kind] = (out[c.kind] ?? 0) + 1;
  }
  return out as Record<KnowledgeKind, number>;
}
