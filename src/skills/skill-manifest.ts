import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_SKILLS_DIR } from '../config.js';
import type { SkillTier } from './skill-tier.js';
import type { SkillManifest } from './runner.js';

function parseTier(raw: unknown): SkillTier | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toUpperCase();
  if (v === 'T1' || v === 'T2' || v === 'T3') return v;
  return undefined;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/** A frontmatter value as one line of text. Third-party SKILL.md files (~/.codex/skills, ~/.claude/skills …)
 *  sometimes write `description:` as a YAML list; the parser then returns an array, and a 0.2.6 beta tester's
 *  first screen crashed on `description.trim is not a function`. Lists are joined; anything else non-string is dropped. */
export function frontmatterText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string').join(' ').trim();
  return '';
}

function parseFrontmatter(md: string): { fm: Record<string, any>; body: string } {
  const match = md.match(FRONTMATTER_RE);
  if (!match) return { fm: {}, body: md };

  const raw = match[1]!;
  const body = md.slice(match[0].length);
  const fm: Record<string, any> = {};

  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }

    const key = m[1]!;
    let val = m[2]!.trim();

    // Block scalar ( > or | followed by indented lines)
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const fold = val.startsWith('>');
      const chomp = val.endsWith('-');
      const collected: string[] = [];
      i++;
      while (i < lines.length && (lines[i]!.startsWith('  ') || lines[i]!.trim() === '')) {
        collected.push(lines[i]!.replace(/^ {2}/, ''));
        i++;
      }
      let text = collected.join('\n');
      if (fold) text = text.replace(/\n(?!\n)/g, ' ').replace(/\n\n/g, '\n');
      if (chomp) text = text.replace(/\n+$/, '');
      fm[key] = text.trim();
      continue;
    }

    // List on following indented lines (- item)
    if (val === '' && i + 1 < lines.length && lines[i + 1]!.match(/^\s+-\s+/)) {
      const items: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.match(/^\s+-\s+/)) {
        items.push(lines[i]!.replace(/^\s+-\s+/, '').trim());
        i++;
      }
      fm[key] = items;
      continue;
    }

    // Flow-style array: `key: [a, b, c]` (session 21). Parsed into a
    // string[] so consumers see the same shape as the block-list path.
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      fm[key] = inner
        ? inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
        : [];
      i++;
      continue;
    }

    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    fm[key] = val;
    i++;
  }

  return { fm, body };
}

function resolveSkillDir(skillName: string, baseDir: string): string | null {
  const flat = join(baseDir, skillName);
  if (existsSync(join(flat, 'SKILL.md'))) return flat;
  if (!existsSync(baseDir)) return null;
  for (const name of readdirSync(baseDir)) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const catDir = join(baseDir, name);
    try {
      if (!statSync(catDir).isDirectory()) continue;
      const cand = join(catDir, skillName);
      if (existsSync(join(cand, 'SKILL.md'))) return cand;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Parse a single SKILL.md file into a manifest.
 * Returns null if the skill directory or file doesn't exist.
 */
export function parseSkillMd(skillName: string, baseDir: string = LOCAL_SKILLS_DIR): SkillManifest | null {
  const skillDir = resolveSkillDir(skillName, baseDir);
  if (!skillDir) return null;
  const skillPath = join(skillDir, 'SKILL.md');

  const raw = readFileSync(skillPath, 'utf-8');
  const { fm, body } = parseFrontmatter(raw);

  let allowedTools: string[] | undefined;
  const at = fm['allowed-tools'] ?? fm['allowedTools'];
  if (Array.isArray(at)) allowedTools = at;
  else if (typeof at === 'string' && at.trim()) {
    allowedTools = at.split(/[,\s]+/).filter(Boolean);
  }

  // Archon-port T1.1: deniedTools companion. Same parse shape as
  // allowedTools (array or comma/whitespace string). Applied via
  // applyToolPolicy in executeSkill — deny wins over allow.
  let deniedTools: string[] | undefined;
  const dt = fm['denied-tools'] ?? fm['deniedTools'];
  if (Array.isArray(dt)) deniedTools = dt;
  else if (typeof dt === 'string' && dt.trim()) {
    deniedTools = dt.split(/[,\s]+/).filter(Boolean);
  }

  let triggers: string[] | undefined;
  const tr = fm['triggers'] ?? fm['trigger'];
  if (Array.isArray(tr)) triggers = tr.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  else if (typeof tr === 'string' && tr.trim()) {
    triggers = tr.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  }

  // `autoTrigger: true` / `autoTrigger: yes` / `autoTrigger: 1` — all accepted.
  // Missing field defaults to false; the router treats absent/false as
  // "suggest only, don't auto-route".
  const autoTrigger = parseBool(fm['autoTrigger'] ?? fm['auto-trigger']);
  const autoExtract = parseBool(fm['autoExtract'] ?? fm['auto-extract']);

  const shell = typeof fm['shell'] === 'string' ? fm['shell'].trim() : undefined;
  let bashTimeoutMs: number | undefined;
  const bt = fm['bashTimeoutMs'] ?? fm['bash-timeout-ms'];
  if (typeof bt === 'number' && Number.isFinite(bt)) bashTimeoutMs = bt;
  else if (typeof bt === 'string' && bt.trim()) {
    const n = Number(bt);
    if (Number.isFinite(n)) bashTimeoutMs = n;
  }

  const minTier = parseTier(fm['minTier'] ?? fm['min-tier']);
  let composes: string[] | undefined;
  const comp = fm['composes'];
  if (Array.isArray(comp)) {
    composes = comp.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  } else if (typeof comp === 'string' && comp.trim()) {
    composes = comp.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  }

  const category = typeof fm['category'] === 'string' && fm['category'].trim()
    ? fm['category'].trim()
    : undefined;
  const rawSideEffects = fm['sideEffects'];
  const sideEffects = rawSideEffects === 'none' || rawSideEffects === 'write' || rawSideEffects === 'spawn'
    ? rawSideEffects
    : undefined;
  const rawCost = fm['cost'];
  const cost = rawCost === 'light' || rawCost === 'heavy' ? rawCost : undefined;

  return {
    name: frontmatterText(fm['name']) || skillName,
    description: frontmatterText(fm['description']),
    model: fm['model'] || undefined,
    allowedTools,
    deniedTools,
    triggers,
    autoTrigger,
    autoExtract,
    shell,
    bashTimeoutMs,
    minTier,
    composes,
    category,
    sideEffects,
    cost,
    content: body,
    skillDir,
  };
}

function parseBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0') return false;
  }
  return undefined;
}

