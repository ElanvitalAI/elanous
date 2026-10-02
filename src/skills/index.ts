// ── Skill index ──
//
// Process-wide catalog of installed skills' metadata (name, description,
// triggers, autoTrigger). Lightweight — the full SKILL.md body is NOT
// loaded into the index; parseSkillMd() is still used by the runner
// when a skill actually executes, so bodies stay lazy.
//
// Phase-2 (session 13) extends buildSkillIndex to accept MULTIPLE root
// directories. User-config's `skills.dirs` lets onboarding point at
// `~/.claude/skills` + `~/.config/opencode/skills` + `~/.codex/skills`
// etc. — one index, many sources. First-dir-wins dedup by skill name.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { LOCAL_SKILLS_DIR } from '../config.js';
import { debug } from '../debug/log.js';
import {
  CLAUDE_PACKAGE_MISSING,
  defaultClaudePluginsRoot,
  readClaudePackageLedger,
} from '../plugins/adapters/claude-package.js';
import { defaultSkillDirs, getUserConfig } from '../user-config.js';
import { listSkillNames, parseSkillMd, type SkillTier } from './runner.js';
import { extractTriggers } from './trigger-extract.js';

/** Description used when a command file has no prose paragraph after its heading. */
export const CLAUDE_PACKAGE_COMMAND_DESCRIPTION_ABSENT = '(description absent)';

export interface SkillIndexEntry {
  name: string;
  description: string;
  triggers: string[];
  extractedTriggers: string[];
  triggerSource: 'explicit' | 'extracted' | 'both' | 'none';
  autoTrigger: boolean;
  /** Minimum model tier declared in frontmatter. Session 21. When
   *  absent (legacy SKILL.md), router treats as T2. */
  minTier?: SkillTier;
  /** Composition hints — downstream skills this one delegates to.
   *  Metadata only, not a runtime dependency. Session 21. */
  composes: string[];
  /** Logical taxonomy tag (metadata, not disk layout). Session 21
   *  Option-A. Undefined for legacy SKILL.md without the field. */
  category?: string;
  /** Auto-execution safety declaration from frontmatter. Undefined is fail-safe. */
  sideEffects?: 'none' | 'write' | 'spawn';
  /** Execution cost declaration from frontmatter. Undefined is fail-safe. */
  cost?: 'light' | 'heavy';
  /** Absolute path to the skill directory itself. */
  skillDir: string;
  /** Root skills dir this entry was discovered under — lets callers
   *  label "from ~/.config/opencode/skills" in UIs. */
  rootDir: string;
}

let cache: SkillIndexEntry[] | null = null;
/** Cache key is the ordered list of baseDirs joined by \0 (not a valid
 *  path char). Swapping order OR adding a dir invalidates the cache. */
let cachedKey: string | null = null;

/** Normalize a single dir or array of dirs to a de-duped array. Empty
 *  / non-existent dirs are kept — listSkillNames handles the absent
 *  case silently (returns []). */
function normalizeBaseDirs(base: string | string[] | undefined): string[] {
  // ★ G9 P5a — 인자 생략 시 user-config(skills.activeSet/dirs)를 존중한다(기본 claudecode=~/.claude/skills·무회귀).
  const arr = base == null ? defaultSkillDirs()
            : Array.isArray(base) ? base
            : [base];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of arr) {
    if (!d) continue;
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out.length > 0 ? out : [LOCAL_SKILLS_DIR];
}

/** Distinctive skill-name forms usable as explicit triggers so an
 *  explicit invocation ("omni-crawl 로 찾아줘", "/diagram-master") routes.
 *  ⚠️ Precision guard: ONLY hyphenated slugs (omni-crawl·diagram-master·
 *  kr-flow…). Single-word names (loop·run·review·schedule·simplify·init)
 *  are common English/chat words and would false-trigger, so they're
 *  excluded — a distinctive multi-part slug is a strong intent signal,
 *  a bare word is not. Returns the raw slug + a de-hyphenated form. */
export function nameTriggers(name: string): string[] {
  const n = (name ?? '').trim();
  if (!n.includes('-')) return [];
  const out = [n];
  const spaced = n.replace(/-/g, ' ');
  if (spaced !== n) out.push(spaced);
  return out;
}

/** A skill the index could not read — surfaced to the person (startup notice · repair offer), never swallowed. */
export interface SkillIndexProblem { name: string; dir: string; code: string | null; error: string }
const skillProblems = new Map<string, SkillIndexProblem>();
function recordSkillIndexProblem(problem: SkillIndexProblem): void {
  skillProblems.set(`${problem.dir}\u0000${problem.name}`, problem);
}
/** Skills skipped by the most recent index builds (deduped by dir + name). */
export function skillIndexProblems(): SkillIndexProblem[] {
  return [...skillProblems.values()];
}

function makeEntry(name: string, rootDir: string): SkillIndexEntry | null {
  let m: ReturnType<typeof parseSkillMd>;
  try {
    m = parseSkillMd(name, rootDir);
  } catch (err) {
    // listSkillNames 가 SKILL.md 존재를 본 뒤 readFileSync 가 실패하는
    // TOCTOU: 삭제(ENOENT) 또는 SKILL.md 가 디렉터리(EISDIR).
    // 권한 오류·파서 결함은 삼키지 않는다.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw err;
  }
  if (!m) return null;
  const declared = Array.isArray(m.triggers) ? m.triggers : [];
  // Prepend distinctive name forms (precision-guarded) as explicit triggers.
  const declaredLower = new Set(declared.map(s => s.toLowerCase()));
  const nameTrigs = nameTriggers(m.name).filter(t => !declaredLower.has(t.toLowerCase()));
  const explicit = [...nameTrigs, ...declared];
  const wantsExtract = m.autoExtract !== false;
  const rawExtracted = wantsExtract ? extractTriggers(m.description) : [];
  const explicitLower = new Set(explicit.map(s => s.toLowerCase()));
  const extracted = rawExtracted.filter(t => !explicitLower.has(t.toLowerCase()));

  const hasExp = explicit.length > 0;
  const hasExt = extracted.length > 0;
  const triggerSource: SkillIndexEntry['triggerSource'] =
    hasExp && hasExt ? 'both' :
    hasExp ? 'explicit' :
    hasExt ? 'extracted' : 'none';

  return {
    name: m.name,
    description: m.description,
    triggers: explicit,
    extractedTriggers: extracted,
    triggerSource,
    autoTrigger: m.autoTrigger === true,
    minTier: m.minTier,
    composes: Array.isArray(m.composes) ? m.composes : [],
    category: m.category,
    sideEffects: m.sideEffects === 'none' || m.sideEffects === 'write' || m.sideEffects === 'spawn'
      ? m.sideEffects
      : undefined,
    cost: m.cost === 'light' || m.cost === 'heavy' ? m.cost : undefined,
    skillDir: m.skillDir,
    rootDir,
  };
}

/** How many distinct skills must share an extracted trigger before we
 *  drop it as "noisy" from all of them. Chosen empirically: "요약" /
 *  "정리" / "분석" appear in 5-10 skills' descriptions in the global
 *  set, and any one of them alone shouldn't route. A token in 2 skills
 *  is still discriminating enough to leave alone. */
export const NOISY_EXTRACTED_THRESHOLD = 3;

/** Strip extracted triggers that appear across too many skills. This
 *  runs AFTER per-entry extraction so each skill's extractedTriggers
 *  already excludes its own explicit duplicates. Explicit triggers
 *  declared by the author in frontmatter are never touched — only
 *  auto-extracted prose keywords. */
function suppressNoisyExtracted(entries: SkillIndexEntry[]): SkillIndexEntry[] {
  const freq = new Map<string, number>();
  for (const e of entries) {
    const seen = new Set<string>();
    for (const t of e.extractedTriggers) {
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }
  const noisy = new Set<string>();
  for (const [k, n] of freq) {
    if (n >= NOISY_EXTRACTED_THRESHOLD) noisy.add(k);
  }
  if (noisy.size === 0) return entries;
  return entries.map(e => {
    const filtered = e.extractedTriggers.filter(t => !noisy.has(t.toLowerCase()));
    if (filtered.length === e.extractedTriggers.length) return e;
    const hasExp = e.triggers.length > 0;
    const hasExt = filtered.length > 0;
    const triggerSource: SkillIndexEntry['triggerSource'] =
      hasExp && hasExt ? 'both' :
      hasExp ? 'explicit' :
      hasExt ? 'extracted' : 'none';
    return { ...e, extractedTriggers: filtered, triggerSource };
  });
}

export interface ClaudePackageCommandMarkdown {
  name: string;
  description: string;
}

export interface CollectClaudePackageCommandOptions {
  pluginsRoot?: string;
  /** Test seam: inject a ledger reader that can throw. Production omits this. */
  readLedger?: typeof readClaudePackageLedger;
}

export interface BuildSkillIndexOptions {
  pluginsRoot?: string;
}

const ATX_HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^(```|~~~)/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/;
const YAML_META = /^[A-Za-z_][\w-]*\s*:(\s|$)/;
const BLOCKQUOTE = /^>/;
const THEMATIC_BREAK = /^(?:[-*_]){3,}$/;

function stripYamlFrontmatter(raw: string): string {
  const text = (raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = text.match(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/);
  if (!match) return text;
  return text.slice(match[0].length);
}

function firstProseParagraph(lines: string[], start: number): string | undefined {
  let inFence = false;
  let inList = false;
  let inYaml = false;
  const para: string[] = [];
  const flush = (): string | undefined => {
    const text = para.join(' ').trim();
    para.length = 0;
    return text || undefined;
  };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (inFence) {
      if (FENCE.test(trimmed)) inFence = false;
      continue;
    }
    if (FENCE.test(trimmed)) {
      const hit = flush();
      if (hit) return hit;
      inFence = true;
      inList = false;
      inYaml = false;
      continue;
    }

    if (!trimmed) {
      const hit = flush();
      if (hit) return hit;
      inList = false;
      inYaml = false;
      continue;
    }

    if (ATX_HEADING.test(trimmed)) {
      const hit = flush();
      if (hit) return hit;
      inList = false;
      inYaml = false;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const hit = flush();
      if (hit) return hit;
      inList = true;
      inYaml = false;
      continue;
    }

    if (inList && /^\s/.test(line)) continue;

    if (/^(?: {4,}|\t)/.test(line)) {
      const hit = flush();
      if (hit) return hit;
      continue;
    }

    if (YAML_META.test(trimmed) || BLOCKQUOTE.test(trimmed) || THEMATIC_BREAK.test(trimmed)) {
      const hit = flush();
      if (hit) return hit;
      inList = false;
      inYaml = YAML_META.test(trimmed);
      continue;
    }

    if (inYaml && /^\s/.test(line)) continue;

    inList = false;
    inYaml = false;
    para.push(trimmed);
  }
  return flush();
}

/**
 * Convert a frontmatter-less Claude command markdown file into a name +
 * description. Name is the first ATX heading, or `fileStem` when none
 * exists. Description is the first prose paragraph after that heading
 * (or from the top when there is no heading). YAML keys, list items and
 * their indented continuations, fences, and headings are not prose.
 */
export function parseClaudePackageCommandMarkdown(
  raw: string,
  fileStem: string,
): ClaudePackageCommandMarkdown {
  const stem = (fileStem ?? '').trim() || 'command';
  const body = stripYamlFrontmatter(raw ?? '');
  const lines = body.replace(/\r\n/g, '\n').split('\n');

  let name: string | undefined;
  let headingLine = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (inFence) {
      if (FENCE.test(trimmed)) inFence = false;
      continue;
    }
    if (FENCE.test(trimmed)) {
      inFence = true;
      continue;
    }
    const heading = ATX_HEADING.exec(trimmed);
    if (heading) {
      const text = heading[2].replace(/\s+#+\s*$/, '').trim();
      if (text) name = text;
      headingLine = i;
      break;
    }
  }

  const start = headingLine >= 0 ? headingLine + 1 : 0;
  const description = firstProseParagraph(lines, start)
    ?? CLAUDE_PACKAGE_COMMAND_DESCRIPTION_ABSENT;

  return {
    name: name && name.length > 0 ? name : stem,
    description: description.length > 0 ? description : CLAUDE_PACKAGE_COMMAND_DESCRIPTION_ABSENT,
  };
}

export function listClaudePackageCommandFiles(commandsDir: string): string[] {
  try {
    const names = readdirSync(commandsDir);
    const out: string[] = [];
    for (const name of names) {
      if (name.startsWith('.') || name.startsWith('_')) continue;
      if (!name.endsWith('.md')) continue;
      const full = join(commandsDir, name);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      out.push(full);
    }
    out.sort();
    return out;
  } catch {
    return [];
  }
}

export function claudePackageCommandToIndexEntry(filePath: string): SkillIndexEntry | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const stem = basename(filePath, extname(filePath));
  const parsed = parseClaudePackageCommandMarkdown(raw, stem);
  if (!parsed.name) return null;
  const commandsDir = dirname(filePath);
  const explicit = nameTriggers(parsed.name);
  return {
    name: parsed.name,
    description: parsed.description,
    triggers: explicit,
    extractedTriggers: [],
    triggerSource: explicit.length > 0 ? 'explicit' : 'none',
    autoTrigger: false,
    composes: [],
    skillDir: commandsDir,
    rootDir: commandsDir,
  };
}

function logClaudePackageCommandCollection(
  event: string,
  data: Record<string, unknown>,
  opts?: { level: 'error' },
): void {
  try {
    if (opts) debug.log('skills.claude-package', event, data, opts);
    else debug.log('skills.claude-package', event, data);
  } catch {
    // Observation must not change the SkillIndexEntry[] contract or throw.
  }
}

export function collectClaudePackageCommandEntries(
  opts?: CollectClaudePackageCommandOptions,
): SkillIndexEntry[] {
  try {
    const readLedger = opts?.readLedger ?? readClaudePackageLedger;
    const ledger = readLedger({
      pluginsRoot: opts?.pluginsRoot ?? defaultClaudePluginsRoot(),
    });
    if (ledger.status !== 'ok') {
      logClaudePackageCommandCollection('ledger-unreadable', {
        reason: ledger.status,
        unseenCount: 'unknown',
      });
      return [];
    }
    const out: SkillIndexEntry[] = [];
    const seen = new Set<string>();
    for (const pkg of ledger.packages) {
      if (!pkg.installPath || pkg.installPath === CLAUDE_PACKAGE_MISSING) continue;
      const files = listClaudePackageCommandFiles(join(pkg.installPath, 'commands'));
      for (const file of files) {
        const entry = claudePackageCommandToIndexEntry(file);
        if (!entry) continue;
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        out.push(entry);
      }
    }
    if (out.length === 0) {
      logClaudePackageCommandCollection('empty', { count: 0 });
    } else {
      logClaudePackageCommandCollection('collected', { count: out.length });
    }
    return out;
  } catch (err) {
    logClaudePackageCommandCollection('read-error', {
      reason: err instanceof Error ? err.message : String(err),
      unseenCount: 'unknown',
    }, { level: 'error' });
    return [];
  }
}

function includeClaudePackageCommandsEnabled(): boolean {
  try {
    return getUserConfig().skills.includeClaudePackageCommands === true;
  } catch {
    return false;
  }
}

/** Build the index fresh from disk. Accepts a single baseDir or an
 *  array for multi-root scanning. Skill names that collide across
 *  dirs: first dir in the input list wins (stable, predictable). */
export function buildSkillIndex(
  baseDir?: string | string[],
  opts?: BuildSkillIndexOptions,
): SkillIndexEntry[] {
  const dirs = normalizeBaseDirs(baseDir);
  const out: SkillIndexEntry[] = [];
  const seenNames = new Set<string>();
  for (const dir of dirs) {
    // Problems reflect the latest build of each dir — a repaired skill must drop off the list (SK2).
    for (const key of [...skillProblems.keys()]) if (key.startsWith(`${dir}\u0000`)) skillProblems.delete(key);
    const names = listSkillNames(dir);
    for (const name of names) {
      // One malformed third-party skill must not take down the index (and with it the first screen).
      let entry: SkillIndexEntry | null;
      try {
        entry = makeEntry(name, dir);
      } catch (err) {
        // 대표 10-01: a broken skill must never crash the product — and must never vanish silently either (G9 P5a).
        // It is skipped, recorded in skillIndexProblems() (a startup notice offers to repair it), and logged.
        const problem: SkillIndexProblem = {
          name, dir,
          code: (err as NodeJS.ErrnoException)?.code ?? null,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        };
        recordSkillIndexProblem(problem);
        debug.log('skills.index', 'skill-skipped', { ...problem }, { level: 'warn' });
        continue;
      }
      if (!entry) continue;
      if (seenNames.has(entry.name)) continue; // first-wins dedup
      seenNames.add(entry.name);
      out.push(entry);
    }
  }
  if (includeClaudePackageCommandsEnabled()) {
    for (const entry of collectClaudePackageCommandEntries({ pluginsRoot: opts?.pluginsRoot })) {
      if (seenNames.has(entry.name)) continue;
      seenNames.add(entry.name);
      out.push(entry);
    }
  }
  return suppressNoisyExtracted(out);
}

function keyFor(dirs: string[]): string {
  const flag = includeClaudePackageCommandsEnabled() ? '1' : '0';
  return flag + '\0' + dirs.join('\0');
}

export function getSkillIndex(
  baseDir?: string | string[],
): SkillIndexEntry[] {
  const dirs = normalizeBaseDirs(baseDir);
  const k = keyFor(dirs);
  if (cache && cachedKey === k) return cache;
  cache = buildSkillIndex(dirs);
  cachedKey = k;
  return cache;
}

export function reloadSkillIndex(
  baseDir?: string | string[],
): number {
  const dirs = normalizeBaseDirs(baseDir);
  cache = buildSkillIndex(dirs);
  cachedKey = keyFor(dirs);
  return cache.length;
}

export function resetSkillIndex(): void {
  cache = null;
  cachedKey = null;
}

// ── Allow/deny filter ────────────────────────────────────────────────
//
// Session 21 — opt-in skill scoping. Users with a shared global skill
// folder (e.g. `~/.claude/skills`) often want a project to route among
// a curated subset without having to move directories. `allow` pins
// the visible set; `deny` subtracts specific names. Applied as a post-
// filter on top of `getSkillIndex()` so the underlying cache is still
// shared across callers with different filter configurations.

export interface SkillFilter {
  allow?: string[];
  deny?: string[];
}

/** Return a filtered copy of the index. Rules:
 *   - If `deny` contains a skill name (case-insensitive), drop it.
 *   - If `allow` is non-empty, keep only names in `allow`.
 *   - If both are empty/absent, return the input unchanged.
 *  Matching is exact name, case-insensitive. Trimmed. Empty strings
 *  in either list are ignored (config tolerance). */
export function applySkillFilter(
  entries: SkillIndexEntry[],
  filter: SkillFilter | undefined,
): SkillIndexEntry[] {
  if (!filter) return entries;
  const normalize = (xs: string[] | undefined) =>
    new Set((xs ?? []).map(s => s.trim().toLowerCase()).filter(Boolean));
  const allow = normalize(filter.allow);
  const deny = normalize(filter.deny);
  if (allow.size === 0 && deny.size === 0) return entries;
  return entries.filter(e => {
    const k = e.name.toLowerCase();
    if (deny.has(k)) return false;
    if (allow.size > 0 && !allow.has(k)) return false;
    return true;
  });
}
