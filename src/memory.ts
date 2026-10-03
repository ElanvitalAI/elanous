// ── Memory system ──
//
// A persistent, file-based memory store — inspired by Claude Code's
// ~/.claude/projects/<name>/memory/ scheme + hermes/openclaw's
// markdown + index patterns, stripped to the dependency-lean core
// elanous actually needs.
//
// Design principles:
//   - Flat markdown files. User can open + edit them directly.
//   - One MEMORY.md index file, rebuilt on every write/delete.
//     Stays under 200 lines (truncated tail) so the always-inject
//     cost is bounded.
//   - Four types — user / feedback / project / reference — per the
//     claude-code convention the user's global ~/.claude/CLAUDE.md
//     already teaches.
//   - Search is pure-JS keyword scoring. No sqlite, no vector DB.
//     Plenty for <1k memories; if a user hits that we can add FTS5
//     behind the same API.
//   - Injection heuristic: always inject MEMORY.md; also inject the
//     top-N memories whose score clears a threshold, capped to a
//     token budget.
//
// Storage layout:
//   ~/.local/share/elanous/memory/
//     MEMORY.md                         # index, <=200 lines
//     <uuid>-<slug>.md                  # one file per memory

import {
  existsSync, readFileSync, mkdirSync, readdirSync,
  unlinkSync, renameSync, openSync, writeSync, fsyncSync, closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { debug } from './debug/log.js';
import { estimateTokens } from './tokens.js';
import { budgetModel } from './llm/model-defaults.js';
import { getAppliedGlobalTestRoot } from './cli/test-flag.js';

/**
 * 임시 파일 → fsync → rename → 폴더 fsync. rename 만으로는 «원자적»이지만 «내구적»이 아니다.
 * 🩸 09-25 GCP debian-12(ext4): `memory add` 직후 전원 차단 재부팅 → 새 기억 파일과 MEMORY.md 가 크기만 남고
 * 내용이 전부 NUL 이 됐다(같은 순간의 sqlite 넷은 무결 — sqlite 는 스스로 fsync 한다).
 */
export function writeFileDurable(path: string, data: string, fsync: (fd: number) => void = fsyncSync): void {
  const tmp = path + '.tmp';
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, data, null, 'utf-8');
    fsync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // 이름 바꾸기 자체도 폴더 항목이다 — 폴더를 fsync 해야 재부팅 뒤 새 이름이 남는다(윈도는 폴더를 못 연다 · 그땐 건너뛴다).
  try {
    const dir = openSync(join(path, '..'), 'r');
    try { fsync(dir); } finally { closeSync(dir); }
  } catch { /* 폴더 fsync 를 못 하는 플랫폼 */ }
}

// ── Types ────────────────────────────────────────────────────────────

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  id: string;                 // uuid v4
  filename: string;           // "<uuid>-<slug>.md"
  type: MemoryType;
  name: string;               // short title (from frontmatter name)
  description: string;        // one-liner used for relevance ranking
  body: string;               // markdown body (everything below frontmatter)
  createdAt: string;          // ISO
  updatedAt: string;          // ISO
  /** Keywords auto-extracted from name + description for cheap
   *  relevance scoring. Populated on write; not persisted since
   *  rebuilding is ~O(bytes) and avoids drift. */
  keywords: string[];
  /** 3rd recall lever (2026-07-19) — injection priority boost (default 0).
   *  Added to the keyword-match score so an important memory ranks HIGHER
   *  when it matches; it does NOT force injection without a match (so it
   *  can't false-recall). Set via `memory priority <id> <n>`. Mirrors the
   *  salience/importance weighting in mem0/Zep/Letta. */
  priority: number;
  /** Always-inject regardless of keyword match — bypasses the relevance
   *  gate (like Letta pinned memory blocks / claude-code MEMORY.md tier).
   *  Use for core / safety / reference-location facts that must always be
   *  in context. Costs tokens every turn, so keep pinned bodies short. */
  pinned: boolean;
  /** Optional pinned-memory freshness window; absent memories retain their original injection text. */
  staleAfterMinutes?: number;
}

// ── Paths ────────────────────────────────────────────────────────────

export function memoryRoot(): string {
  const base = getAppliedGlobalTestRoot() ?? (process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim()
    ? process.env.XDG_DATA_HOME
    : join(homedir(), '.local', 'share'));
  return join(base, 'elanous', 'memory');
}

export function memoryIndexPath(root: string = memoryRoot()): string {
  return join(root, 'MEMORY.md');
}

function ensureRoot(root: string): void {
  mkdirSync(root, { recursive: true });
}

// ── Frontmatter parsing ──────────────────────────────────────────────

/** Minimal YAML-ish frontmatter: `key: value` lines, no nesting.
 *  Matches the rest of elanous (SKILL.md parsing). */
function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { fm: {}, body: raw };
  const rest = raw.slice(3);
  const end = rest.indexOf('\n---');
  if (end < 0) return { fm: {}, body: raw };
  const header = rest.slice(0, end);
  const body = rest.slice(end + 4).replace(/^\n/, '');
  const fm: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, body };
}

function parseStaleAfterMinutes(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function renderFrontmatter(fm: Record<string, string>, body: string): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push('---');
  return lines.join('\n') + '\n\n' + body.trimStart();
}

// ── Keyword extraction ───────────────────────────────────────────────

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'for', 'in', 'on', 'at',
  'by', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this',
  'that', 'these', 'those', 'it', 'its', 'as', 'from', 'into', 'up', 'down',
  'over', 'under', 'again', 'not', 'no', 'so', 'if', 'can', 'will', 'would',
  'should', 'could', 'may', 'might', 'just', 'only', 'also', 'than', 'then',
]);

/** Cheap keyword extractor: lower, split on non-word, drop stopwords
 *  and 1-char tokens. Works for English + Korean (Korean tokens pass
 *  through since \w matches Unicode word chars in Bun's regex). */
export function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    const t = raw.trim();
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'memory';
}

// ── CRUD ─────────────────────────────────────────────────────────────

export interface SaveMemoryOpts {
  type: MemoryType;
  name: string;
  description: string;
  body: string;
  /** Injection priority boost (default 0 — or preserve existing on update). */
  priority?: number;
  /** Always-inject (bypass keyword gate). Default false — or preserve on update. */
  pinned?: boolean;
  /** Pinned injection warns after this many minutes; preserved on update. */
  staleAfterMinutes?: number;
  /** Override the generated id (tests). */
  id?: string;
}

export function saveMemory(opts: SaveMemoryOpts, root: string = memoryRoot()): MemoryEntry {
  ensureRoot(root);
  const now = new Date().toISOString();
  const id = opts.id ?? randomUUID();
  const slug = slugify(opts.name);
  const filename = `${id}-${slug}.md`;
  const path = join(root, filename);

  // Preserve createdAt + priority/pinned if the file already exists (update path).
  let createdAt = now;
  let existingPriority: number | undefined;
  let existingPinned: boolean | undefined;
  let existingStaleAfterMinutes: number | undefined;
  if (existsSync(path)) {
    try {
      const parsed = parseFrontmatter(readFileSync(path, 'utf-8'));
      if (parsed.fm.created) createdAt = parsed.fm.created;
      if (parsed.fm.priority) existingPriority = parseInt(parsed.fm.priority, 10) || 0;
      if (parsed.fm.pinned) existingPinned = parsed.fm.pinned === 'true';
      existingStaleAfterMinutes = parseStaleAfterMinutes(parsed.fm['stale-after-minutes']);
    } catch { /* keep new createdAt */ }
  }
  const priority = opts.priority ?? existingPriority ?? 0;
  const pinned = opts.pinned ?? existingPinned ?? false;
  const staleAfterMinutes = parseStaleAfterMinutes(opts.staleAfterMinutes) ?? existingStaleAfterMinutes;
  const frontmatter: Record<string, string> = {
    name: opts.name,
    description: opts.description,
    type: opts.type,
    created: createdAt,
    updated: now,
  };
  if (priority > 0) frontmatter.priority = String(Math.floor(priority));
  if (pinned) frontmatter.pinned = 'true';
  if (staleAfterMinutes !== undefined) frontmatter['stale-after-minutes'] = String(staleAfterMinutes);
  const raw = renderFrontmatter(frontmatter, opts.body);
  writeFileDurable(path, raw);

  // Rebuild MEMORY.md after any write.
  rebuildIndex(root);

  return {
    id,
    filename,
    type: opts.type,
    name: opts.name,
    description: opts.description,
    body: opts.body,
    createdAt,
    updatedAt: now,
    keywords: extractKeywords(`${opts.name} ${opts.description}`),
    priority,
    pinned,
    staleAfterMinutes,
  };
}

/** Parse one memory file. Returns null on read/parse error. */
function parseMemoryFile(path: string): MemoryEntry | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch { return null; }
  const { fm, body } = parseFrontmatter(raw);
  if (!fm.name || !fm.type) return null;
  const basename = path.split(/[\\/]/).pop() ?? '';
  const match = basename.match(/^([0-9a-f-]{36})-(.+)\.md$/i);
  const id = match ? match[1] : createHash('sha1').update(basename).digest('hex').slice(0, 36);
  return {
    id,
    filename: basename,
    type: normalizeType(fm.type),
    name: fm.name,
    description: fm.description ?? '',
    body,
    createdAt: fm.created ?? '',
    updatedAt: fm.updated ?? fm.created ?? '',
    keywords: extractKeywords(`${fm.name} ${fm.description ?? ''}`),
    priority: fm.priority ? (parseInt(fm.priority, 10) || 0) : 0,
    pinned: fm.pinned === 'true',
    staleAfterMinutes: parseStaleAfterMinutes(fm['stale-after-minutes']),
  };
}

function normalizeType(v: string): MemoryType {
  const t = v.toLowerCase();
  if (t === 'user' || t === 'feedback' || t === 'project' || t === 'reference') return t;
  return 'user';
}

export function loadMemory(id: string, root: string = memoryRoot()): MemoryEntry | null {
  if (!existsSync(root)) return null;
  for (const name of readdirSync(root)) {
    if (name.startsWith(id) && name.endsWith('.md')) {
      return parseMemoryFile(join(root, name));
    }
  }
  return null;
}

export interface ListMemoriesOpts {
  type?: MemoryType;
  limit?: number;
}

export function listMemories(opts: ListMemoriesOpts = {}, root: string = memoryRoot()): MemoryEntry[] {
  if (!existsSync(root)) return [];
  const out: MemoryEntry[] = [];
  for (const name of readdirSync(root)) {
    if (name === 'MEMORY.md' || !name.endsWith('.md')) continue;
    const entry = parseMemoryFile(join(root, name));
    if (!entry) continue;
    if (opts.type && entry.type !== opts.type) continue;
    out.push(entry);
  }
  // Newest first (updatedAt DESC).
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return typeof opts.limit === 'number' ? out.slice(0, opts.limit) : out;
}

export function deleteMemory(id: string, root: string = memoryRoot()): boolean {
  if (!existsSync(root)) return false;
  for (const name of readdirSync(root)) {
    if (name.startsWith(id) && name.endsWith('.md')) {
      unlinkSync(join(root, name));
      rebuildIndex(root);
      return true;
    }
  }
  return false;
}

// ── Search + injection ───────────────────────────────────────────────

export interface SearchHit {
  entry: MemoryEntry;
  score: number;
}

/** Tokenize + expand compound tokens (split on -/_) so a sub-word like
 *  "typescript" matches the compound "prefers-typescript", WITHOUT
 *  reintroducing substring bleed — an atomic word like "reference" stays
 *  one token, so the query "ref" never matches it. This is the crux of the
 *  2026-07-19 false-recall fix. */
function matchTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of extractKeywords(text)) {
    out.add(t);
    if (t.includes('-') || t.includes('_')) {
      for (const part of t.split(/[-_]+/)) if (part.length >= 2) out.add(part);
    }
  }
  return out;
}

/** Score memories by keyword overlap with the query, weighted by
 *  where the match was found (name > description > body). Pure JS,
 *  no FTS dependency — linear in #memories × query keywords, which
 *  is fine for the <1k range this file store targets. */
export function searchMemories(
  query: string,
  opts: { type?: MemoryType; limit?: number } = {},
  root: string = memoryRoot(),
): SearchHit[] {
  const queryKw = [...matchTokens(query)];
  if (queryKw.length === 0) return [];
  // 제1원칙 관측 — 큐레이션 파일메모리 회상. kind='memory-file'.
  try { debug.log('agent.source', 'recall', { kind: 'memory-file', query, keywords: queryKw.length }); } catch { /* fail-open */ }
  const entries = listMemories({ type: opts.type }, root);
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    // 정확-토큰 매칭(2026-07-19) — 이전 substring `includes(kw)` 는 "ref"가 "reference"·
    // "prefer" 안에까지 걸려 오차용(false-recall)을 냈다(openclaw tool-search.ts 이식:
    // tokenize→Set.has 전체토큰 동등). name/description 은 토큰집합 정확매칭, body 는
    // 긴 토큰(>=4)만 substring 허용(짧은 토큰 substring 은 노이즈). matchTokens 가 복합어
    // (prefers-typescript)를 분할해 서브워드는 살리되(→typescript 매칭), 원자어(reference)엔
    // 서브스트링을 안 뚫는다(→"ref" 여전히 안 걸림).
    const nameTokens = matchTokens(entry.name);
    const descTokens = matchTokens(entry.description);
    const bodyLower = entry.body.toLowerCase();
    let score = 0;
    for (const kw of queryKw) {
      if (nameTokens.has(kw)) score += 3;
      if (descTokens.has(kw)) score += 2;
      else if (kw.length >= 4 && bodyLower.includes(kw)) score += 1;
      if (entry.keywords.includes(kw)) score += 1;
    }
    // priority 부스트 — **진짜 매칭(base>=2: name/desc 토큰 히트)** 에만 승격. body-only 약한
    // 매칭(+1)엔 안 붙인다(안 그러면 "codex" body 스침 +1 에 부스트가 붙어 오차 주입). 순위용.
    if (score >= 2 && entry.priority > 0) score += entry.priority * 2;
    if (score > 0) hits.push({ entry, score });
  }
  hits.sort((a, b) => b.score - a.score);
  const result = typeof opts.limit === 'number' ? hits.slice(0, opts.limit) : hits;
  // ⛔⭐⭐ **「불렀다」가 아니라 「무엇을 얻었다」를 남긴다**(2026-08-19 · `OBS-T116`).
  //   🚨 종전엔 질의만 남아서 ***「부를 곳이 비었다」와 「불러서 찾았다」를 못 갈랐다***(`F42`).
  //   ⭐ `entries`(찾을 대상 수)를 «같이» 남긴다 — 0건의 이유가 「없어서」인지 「안 맞아서」인지 갈린다.
  try {
    debug.log('agent.source', 'recall-result', {
      kind: 'memory-file', hits: result.length, candidates: entries.length, keywords: queryKw.length,
    });
  } catch { /* fail-open */ }
  return result;
}

// ── MEMORY.md index ──────────────────────────────────────────────────

const INDEX_MAX_LINES = 200;

/** Rebuild ~/.local/share/elanous/memory/MEMORY.md. Format mirrors the
 *  user's global ~/.claude/projects/<proj>/memory/MEMORY.md so the
 *  always-inject pattern stays consistent across tools:
 *    - One line per memory: `- [Title](file.md) — one-line hook`
 *    - Grouped by type, newest first within group
 *    - Capped at INDEX_MAX_LINES after the header
 */
export function rebuildIndex(root: string = memoryRoot()): void {
  ensureRoot(root);
  const entries = listMemories({}, root);
  const byType: Record<MemoryType, MemoryEntry[]> = {
    user: [], feedback: [], project: [], reference: [],
  };
  for (const e of entries) byType[e.type].push(e);

  const lines: string[] = [];
  lines.push('# elanous memory index');
  lines.push('');
  lines.push(`<!-- auto-generated by elanous — edit individual .md files instead -->`);
  lines.push('');
  let remaining = INDEX_MAX_LINES;
  for (const t of ['user', 'feedback', 'project', 'reference'] as MemoryType[]) {
    const list = byType[t];
    if (list.length === 0) continue;
    lines.push(`## ${t}`);
    lines.push('');
    for (const e of list) {
      if (remaining-- <= 0) { lines.push('- … (truncated — see files directly)'); break; }
      const desc = (e.description || '').slice(0, 120);
      lines.push(`- [${e.name}](${e.filename}) — ${desc}`);
    }
    lines.push('');
  }
  writeFileDurable(memoryIndexPath(root), lines.join('\n'));
}

/** Read the MEMORY.md index verbatim. Returns '' when missing (e.g.
 *  a fresh install with zero memories — in that case the caller
 *  should skip injection). */
export function readIndex(root: string = memoryRoot()): string {
  const p = memoryIndexPath(root);
  if (!existsSync(p)) return '';
  try { return readFileSync(p, 'utf-8'); } catch { return ''; }
}

// ── Injection heuristic ──────────────────────────────────────────────

function pinnedChunk(e: MemoryEntry): string {
  const header = `### 📌 [${e.type}] ${e.name}\n\n`;
  const body = (e.body || '').trim() || e.description;
  const updated = Date.parse(e.updatedAt);
  if (e.staleAfterMinutes === undefined || !Number.isFinite(updated)) return header + body;
  const ageMinutes = (Date.now() - updated) / 60_000;
  if (ageMinutes <= e.staleAfterMinutes) return header + body;
  const hours = Math.floor(ageMinutes / 60);
  return header + `⚠️ 이 기억은 ${hours}시간 전 것이다 — 답하기 전에 원장 도구 release_status(판 일정·칸) · decisions_pending(미결 결정) · ops_seats(자리 현황)로 다시 확인하고, 확인 전에는 «확인 중»이라고 말한다.\n${body}`;
}

export interface InjectionResult {
  /** Markdown block to prepend to the system prompt (or '' when empty). */
  block: string;
  /** How many tokens the injected block costs (rough estimate). */
  tokens: number;
  /** Which memory IDs were injected — useful for access tracking in
   *  the future. Caller can log / audit. */
  injectedIds: string[];
}

export interface InjectOpts {
  /** Max tokens the injection is allowed to consume. Default 1500. */
  maxTokens?: number;
  /** Max individual memories (after index). Default 5. */
  maxHits?: number;
  /** Min keyword-match score to include a memory. Default 1. */
  minScore?: number;
  /** Always include the MEMORY.md index even if no keyword hits. */
  alwaysIncludeIndex?: boolean;
}

/** Build the memory-injection block for a user turn. Always prepends
 *  MEMORY.md (cheap, orienting) then appends the top-K keyword-matched
 *  memories until the token budget is hit.
 *
 *  Returns an empty block when there are no memories at all — the
 *  caller just skips the injection in that case. */
export function buildMemoryInjection(
  userText: string,
  opts: InjectOpts = {},
  root: string = memoryRoot(),
): InjectionResult {
  const maxTokens = opts.maxTokens ?? 1500;
  const maxHits = opts.maxHits ?? 5;
  // minScore 기본 1→2 상향(2026-07-19) — 단일 약한 매칭(+1)만으로는 주입 안 함(오차용 억제).
  const minScore = opts.minScore ?? 2;
  const alwaysIdx = opts.alwaysIncludeIndex !== false;

  const index = readIndex(root);
  if (!index) return { block: '', tokens: 0, injectedIds: [] };

  const parts: string[] = [];
  const injected: string[] = [];
  let usedTokens = 0;

  if (alwaysIdx) {
    const idxTok = estimateTokens(index);
    if (idxTok <= maxTokens) {
      parts.push('## Memory index\n\n' + index.trim());
      usedTokens += idxTok;
    }
  }

  // 📌 pinned 기억 — 키워드 무관 항상 주입(relevance gate bypass · Letta pinned block /
  //    claude-code MEMORY.md tier 동형). priority 높은 순. core/safety/ref-location 사실용.
  const pinnedMems = listMemories({}, root).filter(m => m.pinned).sort((a, b) => b.priority - a.priority);
  const pinnedParts: string[] = [];
  for (const e of pinnedMems) {
    const chunk = pinnedChunk(e);
    const tok = estimateTokens(chunk);
    if (usedTokens + tok > maxTokens) break;
    pinnedParts.push(chunk);
    injected.push(e.id);
    usedTokens += tok;
  }
  if (pinnedParts.length > 0) parts.push('## Pinned memories\n\n' + pinnedParts.join('\n\n'));

  // low-context guard(claude-code attachments.ts:2378 이식) — 토큰 1개 이하 쿼리(bare "ref" 등)는
  //    의도 판정 불가라 키워드 recall 을 아예 스킵(오차용 방지). pinned + index 만 남는다.
  const lowContext = extractKeywords(userText).length < 2;
  const hits = lowContext
    ? []
    : searchMemories(userText, { limit: maxHits + pinnedParts.length }, root)
        .filter(h => h.score >= minScore && !injected.includes(h.entry.id))
        .slice(0, maxHits);
  const bodyParts: string[] = [];
  for (const hit of hits) {
    const e = hit.entry;
    const body = (e.body || '').trim();
    const chunk = `### [${e.type}] ${e.name} (relevance ${hit.score})\n\n${body || e.description}`;
    const tok = estimateTokens(chunk);
    if (usedTokens + tok > maxTokens) break;
    bodyParts.push(chunk);
    injected.push(e.id);
    usedTokens += tok;
  }

  if (bodyParts.length > 0) {
    parts.push('## Retrieved memories\n\n' + bodyParts.join('\n\n'));
  }

  if (parts.length === 0) return { block: '', tokens: 0, injectedIds: [] };
  return {
    block: '## Memory\n\n' + parts.join('\n\n'),
    tokens: usedTokens,
    injectedIds: injected,
  };
}

// ── LLM-judge recall (2026-07-19) ──────────────────────────────────────
//
// 정확-토큰 매칭도 못 가르는 **동음(WSD)** — "git ref"(git) vs "레퍼런스 리포"(reference)는
// 둘 다 토큰 "ref" 를 공유 → 키워드로는 구분 불가 — 을 **의미로 판정**하는 완결 해법.
// claude-code-fork `findRelevantMemories.ts` 이식: name+description 매니페스트를 경량 LLM 이
// 판정해 "확실히 유용한 것만" 고른다(고정밀·불확실하면 제외·빈 배열 허용). 실패 시 keyword fallback.
// config-armed(기본 OFF·`llm.memoryJudge.enabled`) — per-turn LLM 콜이라 안전하게 옵트인.

export interface MemoryJudgeOpts extends InjectOpts {
  /** DI seam — (prompt) => Promise<완성텍스트>. 기본 = 경량 LLM 1-shot(dynamic import). */
  judge?: (prompt: string) => Promise<string>;
  /** 최대 선택 수(claude-code 5). */
  maxSelect?: number;
  /** 판정 후보 매니페스트 최대. 기본 60. */
  maxCandidates?: number;
  /** 활성 도구/도메인 힌트 — 이미 쓰는 도구의 reference 기억 억제(claude-code recentTools). */
  recentTools?: string[];
  /** 기본 judge 모델 override(config `llm.memoryJudge.model`). 미지정 = env / luna(경량). */
  model?: string;
}

/** 후보 매니페스트 — 판정용 한 줄 요약(id8·type·name·description). 본문은 안 보낸다(토큰절약). */
export function formatMemoryManifest(entries: readonly MemoryEntry[]): string {
  return entries
    .map((e) => `- ${e.id.slice(0, 8)} [${e.type}] ${e.name} — ${(e.description || '').slice(0, 160)}`)
    .join('\n');
}

/** 판정 프롬프트 — 고정밀 선택(확실할 때만·불확실 제외·빈 배열 허용) + WSD 명시 지시. */
export function buildMemoryJudgePrompt(userText: string, manifest: string, recentTools?: readonly string[]): string {
  const toolNote = recentTools && recentTools.length > 0
    ? `\n- 사용자가 지금 사용 중인 도구: ${recentTools.join(', ')}. 그 도구의 사용법/API reference 기억은 고르지 마라(이미 쓰는 중). 단 그 도구의 warning/gotcha 기억은 골라라.`
    : '';
  return [
    '너는 어시스턴트가 **현재 사용자 메시지**에 답하는 데 유용할 기억을 고르는 선택기다.',
    '아래 후보 중 **확실히 유용한 것들의 id(앞 8자)만** JSON 배열로 반환하라.',
    '- 이 메시지에 **확실히** 관련될 때만 포함(name+description 근거). 불확실하면 넣지 마라. 선별적으로.',
    '- 확실히 유용한 게 없으면 빈 배열 `[]` 을 반환하라.',
    '- `reference` 타입(외부 시스템/레포 포인터)은 **사용자가 실제로 그 외부 시스템을 묻거나 참고하려 할 때만** 골라라. 단어가 우연히 겹친다고 고르지 마라 — 예: "git ref"·"React ref"·"변수 ref" 는 레퍼런스-레포 기억과 무관하니 고르지 마라.',
    toolNote,
    '',
    '## 현재 사용자 메시지',
    userText.slice(0, 1200),
    '',
    '## 후보 기억',
    manifest,
    '',
    '유용한 기억 id(앞 8자)의 JSON 배열만 출력(설명 금지):',
  ].join('\n');
}

/** judge 응답에서 id 문자열 배열 추출(모델 잡담 허용 — 첫 [...] 블록 파싱). */
function parseJudgeIds(raw: string): string[] {
  const m = raw.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/** 경량 LLM 1-shot judge 팩토리. 우선순위: 인자 model > env > 활성 provider budget tier. */
export function makeMemoryJudge(model?: string): (prompt: string) => Promise<string> {
  const m = model || process.env.ELANOUS_MEMORY_JUDGE_MODEL || budgetModel();
  return async (prompt: string) => {
    const { streamLLM } = await import('./llm.js');
    return streamLLM([{ role: 'user', content: prompt }], () => {}, {
      model: m,
      reasoningEffort: 'low',
    });
  };
}

/** LLM 판정으로 관련 기억 선택 — 매니페스트→judge→JSON id→실제 id셋 post-filter→cap.
 *  hallucinated id 는 실제 후보에 없으므로 자동 탈락(claude-code 이식). */
export async function selectJudgedMemories(
  userText: string,
  entries: readonly MemoryEntry[],
  opts: MemoryJudgeOpts = {},
): Promise<MemoryEntry[]> {
  const judge = opts.judge ?? makeMemoryJudge(opts.model);
  const cand = entries.slice(0, opts.maxCandidates ?? 60);
  if (cand.length === 0) return [];
  const prompt = buildMemoryJudgePrompt(userText, formatMemoryManifest(cand), opts.recentTools);
  const raw = await judge(prompt);
  const ids = parseJudgeIds(raw);
  const out: MemoryEntry[] = [];
  for (const id of ids) {
    const e = cand.find((c) => c.id.slice(0, 8) === id.slice(0, 8) || c.id.startsWith(id));
    if (e && !out.includes(e)) out.push(e);
  }
  return out.slice(0, opts.maxSelect ?? 5);
}

/** buildMemoryInjection 의 LLM-judge 버전(async). index+pinned 는 동일하게 항상, 그 다음은
 *  키워드 대신 **LLM 의미판정**으로 후보 선택(WSD 해결). judge 실패 시 keyword fallback(fail-soft).
 *  low-context(토큰<2) 는 판정 스킵(pinned+index 만). */
export async function buildMemoryInjectionLLM(
  userText: string,
  opts: MemoryJudgeOpts = {},
  root: string = memoryRoot(),
): Promise<InjectionResult> {
  const maxTokens = opts.maxTokens ?? 1500;
  const maxSelect = opts.maxSelect ?? 5;
  const alwaysIdx = opts.alwaysIncludeIndex !== false;

  const index = readIndex(root);
  if (!index) return { block: '', tokens: 0, injectedIds: [] };

  const parts: string[] = [];
  const injected: string[] = [];
  let usedTokens = 0;

  if (alwaysIdx) {
    const idxTok = estimateTokens(index);
    if (idxTok <= maxTokens) { parts.push('## Memory index\n\n' + index.trim()); usedTokens += idxTok; }
  }

  // pinned 항상주입(키워드/판정 무관).
  const pinnedMems = listMemories({}, root).filter((m) => m.pinned).sort((a, b) => b.priority - a.priority);
  const pinnedParts: string[] = [];
  for (const e of pinnedMems) {
    const chunk = pinnedChunk(e);
    const tok = estimateTokens(chunk);
    if (usedTokens + tok > maxTokens) break;
    pinnedParts.push(chunk); injected.push(e.id); usedTokens += tok;
  }
  if (pinnedParts.length > 0) parts.push('## Pinned memories\n\n' + pinnedParts.join('\n\n'));

  // low-context guard + LLM 판정(실패 시 keyword fallback).
  const lowContext = extractKeywords(userText).length < 2;
  let judged: MemoryEntry[] = [];
  if (!lowContext) {
    const candidates = listMemories({}, root)
      .filter((m) => !m.pinned && !injected.includes(m.id))
      .slice(0, opts.maxCandidates ?? 60);
    if (candidates.length > 0) {
      try {
        judged = await selectJudgedMemories(userText, candidates, opts);
      } catch {
        judged = searchMemories(userText, { limit: maxSelect }, root)
          .map((h) => h.entry).filter((e) => !injected.includes(e.id));
      }
    }
  }

  const bodyParts: string[] = [];
  for (const e of judged.slice(0, maxSelect)) {
    const chunk = `### [${e.type}] ${e.name}\n\n${(e.body || '').trim() || e.description}`;
    const tok = estimateTokens(chunk);
    if (usedTokens + tok > maxTokens) break;
    bodyParts.push(chunk); injected.push(e.id); usedTokens += tok;
  }
  if (bodyParts.length > 0) parts.push('## Retrieved memories (LLM-judged)\n\n' + bodyParts.join('\n\n'));

  if (parts.length === 0) return { block: '', tokens: 0, injectedIds: [] };
  return { block: '## Memory\n\n' + parts.join('\n\n'), tokens: usedTokens, injectedIds: injected };
}
