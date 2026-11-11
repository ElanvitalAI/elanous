// ── PFC-S4.2: KnowledgeQuery core ──
//
// Walks the Obsidian vault (or simulated fallback), parses frontmatter,
// and returns notes matching the requested filter (tags AND + optional
// regex fulltext + optional kind). MVP has no caching; every query
// re-scans. Acceptable at vault sizes <~10k notes; tag index is a
// follow-up.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseFrontmatter, type ObsidianVault } from '../auto-research/obsidian-bridge.js';
import type { KnowledgeKind, KnowledgeNote, KnowledgeQueryInput, KnowledgeQueryResult } from './types.js';
import { PACK_KINDS, parsePackIdString, packIdString } from './kgs/pack.js';
import { kgsStoreSingleton, type KgsSqliteStore } from './kgs/sqlite-store.js';

/** Search only cards belonging to a pack present in the local KGS index. No vault fallback. */
export function listInstalledPacks(store: Pick<KgsSqliteStore, 'listPacksByKind'> = kgsStoreSingleton()): Array<{ id: string; title: string }> {
  return PACK_KINDS.flatMap(kind => store.listPacksByKind(kind).map(pack => ({ id: packIdString(pack.metadata.id), title: pack.metadata.title })));
}

export interface KnowledgePackCandidate { id: string; title: string }

export type InstalledKnowledgePackDecision =
  | { kind: 'selected'; pack: KnowledgePackCandidate; priority: number; intentTags: string[] }
  | { kind: 'ambiguous'; candidates: KnowledgePackCandidate[]; priority: number; intentTags: string[] }
  | { kind: 'none' };

/** Rank installed packs by searchable metadata; equal top tag/score matches need a user choice. */
export function resolveInstalledKnowledgePack(
  question: string,
  store: Pick<KgsSqliteStore, 'listPacksByKind'> = kgsStoreSingleton(),
): InstalledKnowledgePackDecision {
  const queryTerms = searchTerms(question);
  if (queryTerms.size === 0) return { kind: 'none' };

  const ranked: Array<{ pack: KnowledgePackCandidate; priority: number; intentTags: string[] }> = [];
  for (const kind of PACK_KINDS) {
    for (const pack of store.listPacksByKind(kind)) {
      const metadataTerms = searchTerms([
        pack.metadata.id.slug,
        pack.metadata.title,
        pack.metadata.intent,
        ...pack.metadata.tags,
      ].join(' '));
      const priority = [...queryTerms].filter(term => metadataTerms.has(term)).length;
      if (priority === 0) continue;
      const intentTags = pack.metadata.tags
        .filter(tag => [...searchTerms(tag)].some(term => queryTerms.has(term)))
        .map(tag => tag.trim().toLocaleLowerCase())
        .sort((a, b) => a.localeCompare(b));
      ranked.push({ pack: { id: packIdString(pack.metadata.id), title: pack.metadata.title }, priority, intentTags });
    }
  }
  if (ranked.length === 0) return { kind: 'none' };
  ranked.sort((a, b) => b.priority - a.priority || a.pack.id.localeCompare(b.pack.id));
  const top = ranked.filter(candidate => candidate.priority === ranked[0]!.priority);
  if (top.length === 1) {
    const best = top[0]!;
    return { kind: 'selected', pack: best.pack, priority: best.priority, intentTags: best.intentTags };
  }
  const [first, second] = top;
  const sameIntentTags = !!second && first!.intentTags.length > 0
    && second.intentTags.join('\0') === first!.intentTags.join('\0');
  if (sameIntentTags) {
    return { kind: 'ambiguous', candidates: [first!.pack, second!.pack],
      priority: first!.priority, intentTags: first!.intentTags };
  }
  return { kind: 'none' };
}

/** Compatibility helper for callers that only accept a unique winner. */
export function selectInstalledKnowledgePack(
  question: string,
  store: Pick<KgsSqliteStore, 'listPacksByKind'> = kgsStoreSingleton(),
): KnowledgePackCandidate | null {
  const decision = resolveInstalledKnowledgePack(question, store);
  return decision.kind === 'selected' ? decision.pack : null;
}

function searchTerms(text: string): Set<string> {
  const ignored = new Set([
    'a', 'an', 'and', 'architecture', 'build', 'can', 'could', 'create', 'design', 'do', 'does', 'for', 'help', 'how', 'i', 'make', 'me', 'need', 'of', 'or', 'please', 'service', 'should', 'system', 'the', 'to', 'want',
    'what', 'when', 'where', 'which', 'who', 'why',
    '가정', '가정해줘', '누구', '무슨', '무엇', '뭐', '방법', '설계', '설계하', '설계해', '설계해줘', '설계해주세요', '설계하는', '설계할', '설계하기', '시스템', '사용자', '어디', '어떻게', '어느', '어떤', '언제', '왜', '핵심', '해줘', '해줘.', '동시', '제약',
  ]);
  const koreanParticles = [
    '으로부터', '에서부터', '에게서는', '한테서는', '에서는', '으로는', '으로도', '에게는', '한테는',
    '에게서', '한테서', '에서', '에게', '한테', '으로', '까지', '부터', '처럼', '보다', '께서',
    '은', '는', '이', '가', '을', '를', '와', '과', '에', '로', '의', '도', '만', '랑', '께',
  ];
  const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const candidates = new Set(tokens);
  for (const token of tokens) {
    let normalized = token;
    while (true) {
      const particle = koreanParticles.find(suffix => normalized.endsWith(suffix));
      if (!particle || normalized.length - particle.length < 2) break;
      normalized = normalized.slice(0, -particle.length);
      candidates.add(normalized);
    }
  }
  return new Set([...candidates]
    // Source: single-character Korean particles and fragments are not stable pack-topic terms.
    .filter(term => term.length > 1 && !ignored.has(term)));
}

export function queryInstalledPack(packId: string, question: string, store: Pick<KgsSqliteStore, 'readPack'> = kgsStoreSingleton()): Array<{ id: string; title: string; body: string; ref: string; updatedAt: string }> {
  const id = parsePackIdString(packId);
  if (!id) throw new Error(`invalid pack id: ${packId}`);
  const pack = store.readPack(id.slug, id.version);
  if (!pack) throw new Error(`pack not installed: ${packId}`);
  const words = [...searchTerms(question)];
  if (question.trim() && words.length === 0) return [];
  return pack.cards.map(card => ({ card, score: words.filter(word => `${card.title} ${card.body}`.toLocaleLowerCase().includes(word)).length }))
    .filter(hit => hit.score > 0 || words.length === 0)
    .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id))
    .map(({ card }) => ({ id: card.id, title: card.title, body: card.body,
      ref: `${packIdString(pack.metadata.id)}#${card.id}`, updatedAt: card.updatedAt }));
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const EXCERPT_HEAD_CHARS = 300;
const EXCERPT_CONTEXT_CHARS = 200;

const KIND_DIR_HINTS: Record<Exclude<KnowledgeKind, 'all'>, readonly string[]> = {
  rca: ['RCA'],
  a3: ['A3'],
  incident: ['Incidents'],
  wiki: ['OSToolWiki', 'Knowledge'],
  repomap: ['RepoMaps'],
  note: [],   // any dir
};

export function knowledgeQuery(
  vault: ObsidianVault,
  input: KnowledgeQueryInput = {},
): KnowledgeQueryResult {
  const limit = clamp(Math.floor(input.limit ?? DEFAULT_LIMIT), 1, MAX_LIMIT);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const includeBody = input.include_body ?? false;

  let regex: RegExp | null = null;
  if (input.fulltext) {
    try { regex = new RegExp(input.fulltext, 'i'); }
    catch (err) {
      throw new Error(`knowledgeQuery: invalid fulltext regex — ${(err as Error).message}`);
    }
  }

  const kind: KnowledgeKind = input.kind ?? 'all';
  const tagsRequired = input.tags ?? [];

  const all: KnowledgeNote[] = [];
  walkMarkdown(vault.root, (absPath) => {
    let raw: string;
    try { raw = readFileSync(absPath, 'utf-8'); }
    catch { return; }
    const parsed = parseFrontmatter(raw);
    const fm = parsed.frontmatter;

    // kind filter
    if (kind !== 'all') {
      const hinted = KIND_DIR_HINTS[kind];
      const rel = relative(vault.root, absPath);
      const relPosix = rel.split(sep).join('/');
      const dirMatch = hinted.length === 0 || hinted.some((d) => relPosix.startsWith(`${d}/`));
      const fmMatch = (fm.kind as string | undefined) === kind;
      if (!dirMatch && !fmMatch) return;
    }

    // tags AND
    if (tagsRequired.length > 0) {
      const fmTags = fm.tags;
      if (!Array.isArray(fmTags)) return;
      const have = new Set((fmTags as unknown[]).filter((t): t is string => typeof t === 'string'));
      for (const required of tagsRequired) if (!have.has(required)) return;
    }

    // fulltext
    let excerpt = parsed.body.slice(0, EXCERPT_HEAD_CHARS);
    if (regex) {
      const m = regex.exec(parsed.body);
      if (!m) return;
      const s = Math.max(0, (m.index ?? 0) - EXCERPT_CONTEXT_CHARS);
      const e = Math.min(parsed.body.length, (m.index ?? 0) + m[0].length + EXCERPT_CONTEXT_CHARS);
      excerpt = parsed.body.slice(s, e);
    }

    const note: KnowledgeNote = {
      path: absPath,
      relPath: relative(vault.root, absPath).split(sep).join('/'),
      frontmatter: fm,
      excerpt,
      ...(includeBody ? { body: parsed.body } : {}),
    };
    all.push(note);
  });

  // Deterministic ordering: most recently modified first (falls back to path).
  all.sort((a, b) => {
    const amt = safeMtime(a.path);
    const bmt = safeMtime(b.path);
    if (amt !== bmt) return bmt - amt;
    return a.path.localeCompare(b.path);
  });

  const sliced = all.slice(offset, offset + limit);
  return {
    results: sliced,
    total: all.length,
    truncated: all.length > offset + limit,
  };
}

function safeMtime(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

function walkMarkdown(dir: string, visit: (path: string) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) walkMarkdown(full, visit);
      else if (entry.endsWith('.md')) visit(full);
    } catch { /* ignore broken entries */ }
  }
}
