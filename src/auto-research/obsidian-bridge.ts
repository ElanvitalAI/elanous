// ── PFC-S3 P1: Obsidian bridge ──
//
// Thin read/write/append/frontmatter helpers so the research-base
// primitives (budget, ledger, termination, loop-prompt) stay agnostic
// about where the vault lives. Three-tier discovery:
//   1. env ELANOUS_OBSIDIAN_VAULT    — operator override
//   2. ~/Obsidian/ElanvitalAI/10. Agentic/AgenticCommon/AutoResearch  — default
//   3. ~/Documents/Obsidian/AutoResearch — macOS iCloud fallback
//   4. simulated fallback: .elanous/research/ (works even when Obsidian
//      is not installed)
//
// All writes are atomic (tmp + rename) — follows PX-2 persistence
// pattern. Frontmatter parsing is the same stripped-down YAML that
// src/agent/loader.ts uses; we duplicate the logic here so the
// auto-research module stays free of agent-subsystem coupling.

import { assertVaultWriteAllowed } from '../obsidian/vault-write-guard.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type {
  GuardWriteArgs,
  PokaSchema,
  ValidationFailure,
} from '../cft/pokayoke.js';

export interface ObsidianVault {
  /** Absolute path to the AutoResearch root (not the Obsidian vault
   *  itself — the sub-directory where goals live). */
  root: string;
  /** true when we fell back to `.elanous/research/` because no real
   *  vault was found. Callers can surface this to the operator UI. */
  isSimulated: boolean;
  /** Human-readable label for logs/toasts. */
  label: string;
}

export interface DiscoverOpts {
  /** Cwd used for the simulated fallback. Defaults to process.cwd(). */
  cwd?: string;
  /** For tests — environment override. */
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Resolve the Obsidian AutoResearch directory using the 3-tier
 *  cascade. Auto-creates the directory if it does not yet exist so
 *  callers can write immediately. */
export function discoverObsidianVault(opts: DiscoverOpts = {}): ObsidianVault {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const override = env.ELANOUS_OBSIDIAN_VAULT?.trim();
  if (override) {
    ensureDir(override);
    return { root: override, isSimulated: false, label: 'env:ELANOUS_OBSIDIAN_VAULT' };
  }
  const primary = join(
    home,
    'Obsidian',
    'ElanvitalAI',
    '10. Agentic',
    'AgenticCommon',
    'AutoResearch',
  );
  if (existsSync(dirname(primary))) {
    ensureDir(primary);
    return { root: primary, isSimulated: false, label: '~/Obsidian/.../AutoResearch' };
  }
  const fallback = join(home, 'Documents', 'Obsidian', 'AutoResearch');
  if (existsSync(dirname(fallback))) {
    ensureDir(fallback);
    return { root: fallback, isSimulated: false, label: '~/Documents/Obsidian/AutoResearch' };
  }
  const sim = join(opts.cwd ?? process.cwd(), '.elanous', 'research');
  ensureDir(sim);
  return { root: sim, isSimulated: true, label: '.elanous/research (simulated)' };
}

// ── File helpers ───────────────────────────────────────────────────────

export function readNote(vault: ObsidianVault, relPath: string): string | null {
  const path = join(vault.root, relPath);
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

export function writeNote(
  vault: ObsidianVault,
  relPath: string,
  body: string,
  frontmatter?: Record<string, unknown>,
): void {
  const path = join(vault.root, relPath);
  assertVaultWriteAllowed(path);   // ⛔ 격리 우주는 운영 볼트에 쓰지 않는다
  ensureDir(dirname(path));
  const fmText = frontmatter ? renderFrontmatter(frontmatter) : '';
  const full = fmText + body;
  atomicWrite(path, full);
}

// ── PFC-S3.3: Poka-Yoke pre-write gate ────────────────────────────────
//
// `guardedWriteNote` combines `writeNote` with a structural validation
// pass. On failure it does NOT write the file — it returns the
// `ValidationFailure[]` so the caller can decide whether to emit an
// Andon escalation, retry with fixed content, or surface the error to
// the operator. Uni-directional import (auto-research → cft) keeps
// the CFT module free of vault knowledge.

export interface GuardedWriteOpts {
  frontmatterSchema?: PokaSchema;
  bodyContains?: readonly string[];
  minBodyLength?: number;
  /** Best-effort Andon escalation on failure. Default true. */
  escalateOnFailure?: boolean;
  /** Severity for the auto-emit (default 'MED'). */
  failureSeverity?: 'LOW' | 'MED' | 'HIGH' | 'CRITICAL';
  /** agentId for the escalation (default 'pokayoke:writeNote'). */
  failureAgentId?: string;
  /** Test seam — skip Andon emit entirely. */
  skipAndon?: boolean;
}

export type GuardedWriteResult =
  | { ok: true; path: string }
  | { ok: false; errors: ValidationFailure[]; reasonOneLine: string };

export async function guardedWriteNote(
  vault: ObsidianVault,
  relPath: string,
  content: string,
  opts: GuardedWriteOpts = {},
): Promise<GuardedWriteResult> {
  const { guardWrite } = await import('../cft/pokayoke.js');
  const fullPath = join(vault.root, relPath);
  const guardArgs: GuardWriteArgs = {
    path: fullPath,
    content,
    ...(opts.frontmatterSchema ? { frontmatterSchema: opts.frontmatterSchema } : {}),
    ...(opts.bodyContains ? { bodyContains: opts.bodyContains } : {}),
    ...(opts.minBodyLength !== undefined ? { minBodyLength: opts.minBodyLength } : {}),
  };
  const guard = guardWrite(guardArgs);
  if (!guard.ok) {
    const shouldEscalate = (opts.escalateOnFailure ?? true) && !opts.skipAndon;
    if (shouldEscalate) {
      try {
        const { emitEscalation } = await import('../cft/andon.js');
        await emitEscalation(
          {
            agentId: opts.failureAgentId ?? 'pokayoke:writeNote',
            severity: opts.failureSeverity ?? 'MED',
            reason: guard.reasonOneLine,
            context: `path=${relPath} errors=${guard.errors.length}`,
          },
          { skipObsidian: true },
        );
      } catch { /* swallow */ }
    }
    return guard;
  }
  ensureDir(dirname(fullPath));
  atomicWrite(fullPath, content);
  return { ok: true, path: fullPath };
}

export function appendNote(vault: ObsidianVault, relPath: string, body: string): void {
  const path = join(vault.root, relPath);
  ensureDir(dirname(path));
  const prior = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const sep = prior && !prior.endsWith('\n') ? '\n' : '';
  atomicWrite(path, prior + sep + body);
}

// ── Frontmatter ────────────────────────────────────────────────────────

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export function parseFrontmatter(raw: string): ParsedNote {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, body: raw };

  const body = raw.slice(match[0].length);
  const fm: Record<string, unknown> = {};
  const lines = match[1]!.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1]!;
    const val = m[2]!.trim();

    // Inline array
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      fm[key] = inner ? inner.split(',').map(s => stripQuotes(s.trim())) : [];
      i++;
      continue;
    }

    // Block list
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

    const stripped = stripQuotes(val);
    if (stripped === 'true') { fm[key] = true; i++; continue; }
    if (stripped === 'false') { fm[key] = false; i++; continue; }
    if (/^-?\d+$/.test(stripped)) { fm[key] = Number(stripped); i++; continue; }
    if (/^-?\d+\.\d+$/.test(stripped)) { fm[key] = Number(stripped); i++; continue; }
    fm[key] = stripped;
    i++;
  }
  return { frontmatter: fm, body };
}

function renderFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map(item => JSON.stringify(item)).join(', ')}]`);
    } else if (typeof v === 'string') {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

// ── Tag index ──────────────────────────────────────────────────────────

export function listNotesByTag(vault: ObsidianVault, tag: string): string[] {
  const matches: string[] = [];
  walkMarkdown(vault.root, (path) => {
    try {
      const raw = readFileSync(path, 'utf-8');
      const { frontmatter } = parseFrontmatter(raw);
      const tags = frontmatter.tags;
      if (Array.isArray(tags) && tags.includes(tag)) {
        matches.push(path);
      }
    } catch {
      // ignore unreadable files
    }
  });
  return matches.sort();
}

function walkMarkdown(dir: string, visit: (path: string) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) walkMarkdown(path, visit);
      else if (entry.endsWith('.md')) visit(path);
    } catch {
      // ignore broken entries
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function ensureDir(path: string): void {
  if (existsSync(path)) return;
  mkdirSync(path, { recursive: true });
}

function atomicWrite(path: string, content: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
