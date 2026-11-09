// ── Agent definition loader ──
//
// Phase C — parses `~/.claude/agents/<name>.md` files into AgentDefinition.
// An agent file is a markdown document with YAML frontmatter:
//
//   ---
//   name: value-investor
//   model: claude-sonnet-4-6
//   tools: [omni-market, web_search]
//   skills: [omni-market]
//   description: Classic value investor persona
//   ---
//
//   You are Margaret Chen, a value investor who focuses on free cash flow…
//
// Everything after the frontmatter block is the system prompt body.
//
// Precedence: user file (~/.claude/agents/<name>.md) overrides a
// built-in of the same name. Built-in sources live under `src/agents/`
// and are shipped with the binary.
//
// Caching: loadAgents() does a fresh filesystem sweep and returns a
// Map<name, def>. resolveAgent(name) uses an in-process cache so
// repeated spawns don't re-read files; call reloadAgents() after
// editing an MD file to pick up changes.

import {
  existsSync, readFileSync, readdirSync, statSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { LOCAL_AGENTS_DIR } from '../config.js';
import type { AgentDefinition } from './types.js';
import { parseSkillMd } from '../skills/skill-manifest.js';
import type { SkillManifest } from '../skills/runner.js';
import { isAgentDisabled } from '../plugin-state/disabled.js';

// ── Frontmatter parser ──
//
// Minimal YAML subset — same shape as skill-runner's parser plus inline
// array support (`tools: [a, b, c]`). Kept local rather than shared so
// skill-runner's surface doesn't grow a public export just for agents.

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export interface ParsedFrontmatter {
  fm: Record<string, unknown>;
  body: string;
}

export function parseAgentFrontmatter(md: string): ParsedFrontmatter {
  const match = md.match(FRONTMATTER_RE);
  if (!match) return { fm: {}, body: md };

  const body = md.slice(match[0].length);
  const fm: Record<string, unknown> = {};
  const lines = match[1]!.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1]!;
    let val = m[2]!.trim();

    // Inline array: `tools: [a, b, c]`
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      fm[key] = inner ? inner.split(',').map(s => stripQuotes(s.trim())) : [];
      i++;
      continue;
    }

    // Block list (indented `- item`)
    if (val === '' && i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1]!)) {
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i]!)) {
        items.push(stripQuotes(lines[i]!.replace(/^\s+-\s+/, '').trim()));
        i++;
      }
      fm[key] = items;
      continue;
    }

    // PFC PX-1: boolean + integer literal coercion so `omitInheritedContext: true` /
    // `maxTurns: 30` parse as booleans / numbers instead of strings. Floats
    // stay strings (not a valid agent field). Existing string-typed fields
    // (name/model/description/systemPrompt) are unaffected.
    const stripped = stripQuotes(val);
    if (stripped === 'true') { fm[key] = true; i++; continue; }
    if (stripped === 'false') { fm[key] = false; i++; continue; }
    if (/^-?\d+$/.test(stripped)) { fm[key] = Number(stripped); i++; continue; }

    fm[key] = stripped;
    i++;
  }

  return { fm, body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ── Agent file parsing ──

/** Read one .md file and parse it into an AgentDefinition. Returns null
 *  when the file is missing, empty, or has no frontmatter `name` field.
 *  `fallbackName` is used when the file omits a name (taken from the
 *  filename without extension).
 *
 *  PFC PX-1: populates optional new fields (role/goal/backstory/
 *  permissionMode/effort/maxTurns/isolation/omitInheritedContext/background/
 *  color/disallowedTools) and sets `source`/`sourcePath`. Legacy
 *  callers that only read name/model/systemPrompt/tools/skills/description
 *  keep working — the extra fields are optional. */
export function parseAgentFile(
  filePath: string,
  fallbackName?: string,
  source?: AgentDefinition['source'],
): AgentDefinition | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  const { fm, body } = parseAgentFrontmatter(raw);

  const name = (fm.name as string) || fallbackName || basename(filePath, '.md');
  if (!name) return null;

  const systemPrompt = body.trim();
  if (!systemPrompt) return null;

  const def: AgentDefinition = {
    name,
    systemPrompt,
  };
  if (typeof fm.model === 'string') def.model = fm.model;
  if (Array.isArray(fm.tools)) def.tools = fm.tools as string[];
  else if (typeof fm.tools === 'string') def.tools = splitCsv(fm.tools);
  const disallowed = fm.disallowedTools ?? (fm as Record<string, unknown>)['disallowed-tools'] ?? (fm as Record<string, unknown>).disallowed;
  if (Array.isArray(disallowed)) def.disallowedTools = disallowed.map(String);
  else if (typeof disallowed === 'string') def.disallowedTools = splitCsv(disallowed);
  if (Array.isArray(fm.skills)) def.skills = fm.skills as string[];
  if (typeof fm.description === 'string') def.description = fm.description;

  // PFC PX-1 CrewAI tuple
  if (typeof fm.role === 'string') def.role = fm.role;
  if (typeof fm.goal === 'string') def.goal = fm.goal;
  if (typeof fm.backstory === 'string') def.backstory = fm.backstory;

  // PFC PX-1 operational hints — validate enums, drop on mismatch
  const pm = fm.permissionMode ?? (fm as Record<string, unknown>)['permission-mode'];
  if (typeof pm === 'string' && PERMISSION_MODES.includes(pm as PermissionMode)) {
    def.permissionMode = pm as PermissionMode;
  }
  if (typeof fm.effort === 'number' && Number.isInteger(fm.effort) && fm.effort >= 1 && fm.effort <= 5) {
    def.effort = fm.effort;
  } else if (typeof fm.effort === 'string' && EFFORT_LEVELS.includes(fm.effort as EffortLevel)) {
    def.effort = fm.effort as EffortLevel;
  }
  if (typeof fm.maxTurns === 'number' && fm.maxTurns > 0) def.maxTurns = fm.maxTurns;
  if (fm.isolation === 'worktree' || fm.isolation === 'cwd') def.isolation = fm.isolation;
  const omitInheritedContext = typeof fm.omitInheritedContext === 'boolean'
    ? fm.omitInheritedContext
    : typeof fm.omitClaudeMd === 'boolean'
      ? fm.omitClaudeMd
      : undefined;
  if (omitInheritedContext !== undefined) def.omitInheritedContext = omitInheritedContext;
  if (typeof fm.background === 'boolean') def.background = fm.background;
  if (typeof fm.color === 'string') def.color = fm.color;

  // Layer tracking — only stamped when the caller passed a source so
  // existing 2-arg callers (tests + skill-tool-agent) see unchanged shape.
  if (source) {
    def.source = source;
    def.sourcePath = filePath;
  }

  return def;
}

type PermissionMode = NonNullable<AgentDefinition['permissionMode']>;
type EffortLevel = 'trivial' | 'low' | 'medium' | 'high' | 'expert';
const PERMISSION_MODES: readonly PermissionMode[] = ['read-only', 'default', 'plan', 'auto'];
const EFFORT_LEVELS: readonly EffortLevel[] = ['trivial', 'low', 'medium', 'high', 'expert'];

function splitCsv(s: string): string[] {
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

/** List `*.md` filenames under `dir` (non-recursive). Returns an empty
 *  array when the directory is missing. */
export function listAgentFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch { return []; }
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    if (!entry.endsWith('.md')) continue;
    out.push(entry);
  }
  return out.sort();
}

/** Sweep both built-in and user dirs and return a merged Map keyed by
 *  agent name. User files override built-ins with the same name.
 *
 *  PFC PX-1 extension: supports up to 4 layers (lowest → highest):
 *    1. `builtinDir`    — shipped src/agents/ (existing)
 *    2. `pluginAgents`  — plugins/<name>/agents/ (materialised upstream)
 *    3. `userDir`       — ~/.claude/agents/ + optional extras
 *    4. `projectDir`    — <cwd>/.elanous/agents/
 *  Higher layers override lower. Every loaded def gets its `source`
 *  field set by the loader so callers (AgentList tool, definition-
 *  registry) can show provenance.
 *
 *  All new parameters are optional — existing 2-layer callers (loader
 *  cache, skill-tool-agent) keep the same behaviour. */
export function loadAgents(opts: {
  builtinDir?: string;
  userDir?: string;
  projectDir?: string;
  extraUserDirs?: string[];
  pluginAgents?: AgentDefinition[];
  /** PX-2 P3: optional disabled-check override. Defaults to the
   *  global isAgentDisabled(name) which reads ~/.elanous/disabled.json
   *  + <cwd>/.elanous/disabled.json. Tests inject a stub predicate so
   *  they don't pollute the user's actual disabled file. */
  isDisabled?: (name: string) => boolean;
} = {}): Map<string, AgentDefinition> {
  const out = new Map<string, AgentDefinition>();
  const builtinDir = opts.builtinDir ?? DEFAULT_BUILTIN_DIR;
  const userDir = opts.userDir ?? LOCAL_AGENTS_DIR;

  // Layer 1: shipped builtin
  for (const entry of listAgentFiles(builtinDir)) {
    const def = parseAgentFile(join(builtinDir, entry), undefined, 'builtin');
    if (def) out.set(def.name, def);
  }

  // Layer 2: plugin-contributed
  if (opts.pluginAgents) {
    for (const def of opts.pluginAgents) {
      out.set(def.name, { ...def, source: def.source ?? 'plugin-builtin' });
    }
  }

  // Layer 3: user (~/.claude/agents/ + extras)
  for (const entry of listAgentFiles(userDir)) {
    const def = parseAgentFile(join(userDir, entry), undefined, 'user');
    if (def) out.set(def.name, def);
  }
  if (opts.extraUserDirs) {
    for (const extra of opts.extraUserDirs) {
      for (const entry of listAgentFiles(extra)) {
        const def = parseAgentFile(join(extra, entry), undefined, 'user');
        if (def) out.set(def.name, def);
      }
    }
  }

  // Layer 4: project (<cwd>/.elanous/agents/)
  if (opts.projectDir) {
    for (const entry of listAgentFiles(opts.projectDir)) {
      const def = parseAgentFile(join(opts.projectDir, entry), undefined, 'project');
      if (def) out.set(def.name, def);
    }
  }

  // PX-2 P3: apply ~/.elanous/disabled.json + <cwd>/.elanous/disabled.json
  // toggle. Disabled agents are dropped from the returned map so
  // resolveAgent (and resolveAgentLayered) return undefined for them,
  // which falls back to general-purpose in dispatchAgent. Cached
  // silently — users edit disabled.json, call reloadDisabled() or
  // restart to pick up changes (PX-7 wires fs.watch).
  const isDisabled = opts.isDisabled ?? ((name: string) => isAgentDisabled(name));
  for (const name of Array.from(out.keys())) {
    if (isDisabled(name)) out.delete(name);
  }

  return out;
}

const DEFAULT_BUILTIN_DIR = join(import.meta.dir, '..', 'agents');

// ── Resolve cache ──

let cache: Map<string, AgentDefinition> | null = null;

export function resolveAgent(
  name: string,
  opts: { builtinDir?: string; userDir?: string } = {},
): AgentDefinition | undefined {
  if (!cache) cache = loadAgents(opts);
  return cache.get(name);
}

export function listResolvedAgents(
  opts: { builtinDir?: string; userDir?: string } = {},
): AgentDefinition[] {
  if (!cache) cache = loadAgents(opts);
  return [...cache.values()];
}

export function reloadAgents(
  opts: { builtinDir?: string; userDir?: string } = {},
): number {
  cache = loadAgents(opts);
  return cache.size;
}

/** Drop the in-process cache without reloading (tests). */
export function resetAgentCache(): void {
  cache = null;
}

// ── Skill preload ──
//
// Per PLAN §11.3: don't embed full SKILL.md bodies — each persona paying
// the full-skill token cost explodes N×skills. Emit a compact summary:
// frontmatter name/description + first `SKILL_SNIPPET_BYTES` chars of
// the body. Agents that need the full skill can read it via the
// `skill.read(name)` tool (Phase C follow-up / D).

/** Max body bytes included per skill — kept small so 3–5 skills stay
 *  under ~3 KB total in the system prompt. */
export const SKILL_SNIPPET_BYTES = 500;

/** Build the injected system-prompt section for a set of skills. Missing
 *  skills are skipped with a single WARN line so the agent at least
 *  knows the skill was configured but unavailable. */
export function buildSkillInjection(
  skillNames: string[],
  opts: { load?: (name: string) => SkillManifest | null; snippetBytes?: number } = {},
): string {
  if (skillNames.length === 0) return '';
  const load = opts.load ?? parseSkillMd;
  const snippetBytes = opts.snippetBytes ?? SKILL_SNIPPET_BYTES;

  const sections: string[] = [];
  for (const name of skillNames) {
    const m = load(name);
    if (!m) {
      sections.push(`<skill name="${name}" missing="true" />`);
      continue;
    }
    const snippet = (m.content ?? '').slice(0, snippetBytes).trimEnd();
    sections.push(
      `<skill name="${m.name}">\n` +
      (m.description ? `${m.description}\n\n` : '') +
      snippet +
      (m.content && m.content.length > snippetBytes ? '\n…[truncated]' : '') +
      `\n</skill>`,
    );
  }
  return sections.join('\n\n');
}

/** Fold skill content into an AgentDefinition's systemPrompt. Returns a
 *  NEW definition — the original is not mutated, so the cache stays
 *  consistent across calls. */
export function applySkillsToDefinition(
  def: AgentDefinition,
  opts: { load?: (name: string) => SkillManifest | null; snippetBytes?: number } = {},
): AgentDefinition {
  if (!def.skills || def.skills.length === 0) return def;
  const injection = buildSkillInjection(def.skills, opts);
  if (!injection) return def;
  return {
    ...def,
    systemPrompt: `${def.systemPrompt}\n\n## Skills\n\n${injection}`,
  };
}

// ── PFC PX-1: system-prompt composer ─────────────────────────────────────
//
// CrewAI role/goal/backstory prepend → body → late-bound memoryPrompt.
// When a definition has no role/goal/backstory the output is just
// `systemPrompt` (no leading header, no separator). This keeps the
// composer a no-op for the existing 3 builtins (general-purpose /
// data-collector / aggregator) which rely on plain prose prompts.

export interface ComposeSystemPromptCtx {
  memoryPrompt?: string;
  /** PFC-S1 P5: when true, the memoryPrompt is dropped even if set.
   *  Used by runner.buildAgentMessages for agents that declare
   *  `omitInheritedContext: true` — slim sub-agents do not inherit the
   *  parent's persistent context. Body + CrewAI header are still rendered. */
  omitMemoryPrompt?: boolean;
}

export function composeSystemPrompt(
  def: AgentDefinition,
  ctx: ComposeSystemPromptCtx = {},
): string {
  const header: string[] = [];
  if (def.role) header.push(`[ROLE] ${def.role}`);
  if (def.goal) header.push(`[GOAL] ${def.goal}`);
  if (def.backstory) header.push(`[BACKSTORY] ${def.backstory}`);

  const parts: string[] = [];
  if (header.length) {
    parts.push(header.join('\n'));
    parts.push('---');
  }
  const body = def.systemPrompt.trim();
  if (body) parts.push(body);
  if (!ctx.omitMemoryPrompt && ctx.memoryPrompt && ctx.memoryPrompt.trim()) {
    parts.push(ctx.memoryPrompt.trim());
  }

  return parts.join('\n\n');
}
