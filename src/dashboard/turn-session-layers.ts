// TUI-SEAT-MEMORY-SCOPE (RFC-tui-self-awareness L2 ①③) — the TUI turn preamble's session layers.
//
// ① File memory: until now only chat.ts (telegram · discord · repl · a2a) injected buildMemoryInjection;
//    the TUI preamble had no memory layer at all. Here it does, scoped to global ⊕ this seat/project:
//    a context card tagged with another seat (or another project) is left out — index line included.
// ③ Injection cadence: the preamble is rebuilt every turn, but these layers are not. They are built once
//    per session and rebuilt only when their source changed (file signature for memory, a short TTL
//    plus content hash for self ambient). Unchanged layers come back byte-identical, which keeps the
//    provider's prompt-cache prefix and skips the per-turn store reads.
//
// Both layers are fail-soft: an error drops the layer (observed), it never blocks the turn.

import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import { buildMemoryInjection, memoryRoot, type MemoryEntry } from '../memory.js';
import { cachedSelfAmbientBaseParts } from '../agent/self-ambient-cache.js';

/** Token budget for the TUI memory layer — the same default chat.ts gives buildMemoryInjection. */
export const TUI_MEMORY_BUDGET_TOKENS = 1500;
/** How long cached self ambient is trusted before the stores are read again. */
export const SELF_AMBIENT_TTL_MS = 60_000;
/** Sessions remembered per cache; the least recently used one is dropped beyond this. */
export const SESSION_LAYER_CACHE_MAX = 32;

export interface MemoryScope {
  seat?: string;
  project?: string;
}

/** This session's seat: `/seats/<seat>` in the cwd first, then COORD_ID. Project comes only from
 *  ELANOUS_PROJECT — a path guess would silently drop cards whose project string does not match it. */
export function resolveMemoryScope(cwd: string, env: NodeJS.ProcessEnv = process.env): MemoryScope {
  const fromCwd = /(?:^|\/)seats\/([^/]+)/.exec(cwd)?.[1]?.trim();
  const seat = fromCwd || env.COORD_ID?.trim() || undefined;
  const project = env.ELANOUS_PROJECT?.trim() || undefined;
  return { ...(seat ? { seat } : {}), ...(project ? { project } : {}) };
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Global memories (no context card, or a card with an empty seat) stay. A card tagged with a seat
 *  stays only for that seat; a card tagged with a project is dropped only when the scope names another one. */
export function memoryInScope(entry: MemoryEntry, scope: MemoryScope): boolean {
  const card = entry.contextCard;
  if (!card) return true;
  if (card.seat.trim() && !(scope.seat && same(card.seat, scope.seat))) return false;
  if (card.project.trim() && scope.project && !same(card.project, scope.project)) return false;
  return true;
}

/** This seat's own cards are injected in full, like pinned memories. */
export function isSeatCard(entry: MemoryEntry, scope: MemoryScope): boolean {
  const seat = entry.contextCard?.seat.trim();
  return Boolean(seat && scope.seat && same(seat, scope.seat));
}

/** Cheap change signal for the file store: names, sizes and mtimes of its markdown files. */
export function memoryStoreSignature(root: string): string {
  let names: string[];
  try { names = readdirSync(root).filter(name => name.endsWith('.md')).sort(); }
  catch { return 'missing'; }
  const hash = createHash('sha256');
  for (const name of names) {
    try {
      const st = statSync(join(root, name));
      hash.update(`${name}\0${st.size}\0${st.mtimeMs}\n`);
    } catch { hash.update(`${name}\0gone\n`); }
  }
  return hash.digest('hex').slice(0, 16);
}

const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

interface MemoryCacheEntry { key: string; messages: LLMMessage[]; hash: string }
interface AmbientCacheEntry { parts: string[]; hash: string; at: number }

const memoryCache = new Map<string, MemoryCacheEntry>();
const ambientCache = new Map<string, AmbientCacheEntry>();

/** Map insertion order doubles as recency: re-insert on use, drop the oldest beyond the cap. */
function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > SESSION_LAYER_CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

/** Test seam — forget every session's cached layers. */
export function resetTurnSessionLayers(): void {
  memoryCache.clear();
  ambientCache.clear();
}

export interface SessionMemoryLayerOpts {
  sessionKey: string;
  cwd: string;
  root?: string;
  env?: NodeJS.ProcessEnv;
  maxTokens?: number;
}

/** The file-memory system message for this session. Rebuilt only when the store or the scope changed. */
export function sessionMemoryLayer(opts: SessionMemoryLayerOpts): LLMMessage[] {
  try {
    const root = opts.root ?? memoryRoot();
    const scope = resolveMemoryScope(opts.cwd, opts.env);
    const maxTokens = opts.maxTokens ?? TUI_MEMORY_BUDGET_TOKENS;
    const key = JSON.stringify([root, scope.seat ?? '', scope.project ?? '', maxTokens, memoryStoreSignature(root)]);
    const cached = memoryCache.get(opts.sessionKey);
    if (cached && cached.key === key) {
      remember(memoryCache, opts.sessionKey, cached);
      debug.log('chat.memory-layer', 'reused', { session: opts.sessionKey, seat: scope.seat ?? null, hash: cached.hash });
      return cached.messages;
    }
    // Empty user text on purpose: keyword hits would change with every prompt and break the cached prefix.
    // Per-prompt recall is the memory_recall tool's job (it is on every TUI route).
    const inj = buildMemoryInjection('', {
      maxTokens,
      filter: entry => memoryInScope(entry, scope),
      alwaysInject: entry => isSeatCard(entry, scope),
    }, root);
    const messages: LLMMessage[] = inj.block ? [{ role: 'system', content: inj.block }] : [];
    const hash = contentHash(inj.block);
    debug.log('chat.memory-layer', cached ? 'changed' : 'built', {
      session: opts.sessionKey, seat: scope.seat ?? null, project: scope.project ?? null,
      injected: inj.injectedIds.length, tokens: inj.tokens, hash,
      ...(cached ? { previousHash: cached.hash, sameContent: cached.hash === hash } : {}),
    });
    // Same content (e.g. an unrelated file touched) keeps the previous array — byte-identical prefix.
    const kept = cached && cached.hash === hash ? cached.messages : messages;
    remember(memoryCache, opts.sessionKey, { key, hash, messages: kept });
    return kept;
  } catch (error) {
    // The layer is dropped for this turn and rebuilt on the next one.
    memoryCache.delete(opts.sessionKey);
    debug.log('chat.memory-layer', 'failed', { session: opts.sessionKey, error: String(error) });
    return [];
  }
}

export interface SessionSelfAmbientOpts {
  now?: number;
  ttlMs?: number;
  build?: () => string[];
}

/** The task-independent self ambient (recent changes · autonomy · ops health · mission incident),
 *  read at most once per TTL per session. The task-dependent investigation recall stays per turn. */
export function sessionSelfAmbientParts(sessionKey: string, opts: SessionSelfAmbientOpts = {}): string[] {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? SELF_AMBIENT_TTL_MS;
  const cached = ambientCache.get(sessionKey);
  if (cached && now - cached.at < ttl) {
    remember(ambientCache, sessionKey, cached);
    return cached.parts;
  }
  try {
    // TUI-TYPING-LAG — the stores are scanned by a worker (self-ambient-cache.ts); expiry here must
    // not bring a synchronous `ps`/crontab/sqlite scan back onto the TUI turn path.
    const parts = (opts.build ?? (() => cachedSelfAmbientBaseParts()))();
    const hash = contentHash(parts.join('\0'));
    if (cached && cached.hash === hash) {
      remember(ambientCache, sessionKey, { ...cached, at: now });
      debug.log('chat.self-ambient', 'unchanged', { session: sessionKey, hash });
      return cached.parts;
    }
    remember(ambientCache, sessionKey, { parts, hash, at: now });
    debug.log('chat.self-ambient', cached ? 'changed' : 'built', { session: sessionKey, parts: parts.length, hash });
    return parts;
  } catch (error) {
    // Fail-soft means the layer is left out, not replayed stale; the next turn reads again.
    ambientCache.delete(sessionKey);
    debug.log('chat.self-ambient', 'failed', { session: sessionKey, error: String(error) });
    return [];
  }
}
