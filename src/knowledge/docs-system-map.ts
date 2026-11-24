/**
 * Internal docs system: deterministic layer map, currentness metadata and self-find.
 * docs-index.jsonl is generated from document headers/path/git metadata; never hand edited.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runGitCommand } from '../git-fs/runner.js';

export const DOCS_LAYERS = ['L0', 'L1', 'L1.5', 'L2', 'L3', 'L4', 'L5'] as const;
export type DocsLayer = typeof DOCS_LAYERS[number];
export type DocsStatus = 'current' | 'superseded' | 'draft';
export type DocsAudience = 'internal' | 'public';
// 출처: #39970 ELN-INTERNAL-DOCS-SYSTEM-1124 §3·판정식 — L0~L3 요약 합계 ≤4KB.
export const DOCS_ALWAYS_CARRY_MAX_BYTES = 4 * 1024;
// 출처: #39970 ELN-INTERNAL-DOCS-SYSTEM-1124 §7 — 설계·매뉴얼 90일 미검증 시 stale.
export const DOCS_STALE_AFTER_DAYS = 90;
// 출처: #39970 ELN-INTERNAL-DOCS-SYSTEM-1124 §3 — self find current 상위 5.
export const DOCS_FIND_TOP_N = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const DOCS_FILE = /\.(md|mdx|txt)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '_archive', 'vendor']);

export interface DocsIndexEntry {
  path: string;
  layer: DocsLayer;
  title: string;
  oneLine: string;
  status: DocsStatus;
  supersededBy: string | null;
  umbrellaSection: string | null;
  owner: string | null;
  lastVerified: string | null;
  verifiedAt: string | null;
  refs: string[];
  size: number;
  audience: DocsAudience;
  sections: string[];
  modifiedAt: string | null;
}
export interface BuildDocsIndexOptions {
  roots: readonly string[];
  currentPlan?: string;
  /** Existing docs engine corpus augmentation boundary for future callers. */
  now?: Date;
  gitLastModified?: (file: string) => string | null;
}
export interface DocsCurrencyAlarm { path: string; reason: 'umbrella-missing' | 'superseded-target-missing'; }
export interface DocsCurrencyReport { alarms: DocsCurrencyAlarm[]; stale: Array<{ path: string; days: number }>; unclassified: number; superseded: number; }
export interface DocsFindHit { entry: DocsIndexEntry; badge: '[내부]' | '[공개]'; score: number; section: string | null; }
export interface DocsManifest {
  total: number; current: number; superseded: number; draft: number; unclassified: number; stale: number;
  layerBytes: Record<DocsLayer, number>;
}

function gitModified(file: string): string | null {
  try {
    const r = runGitCommand(resolve(file, '..'), ['log', '-1', '--format=%cI', '--', file], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch { return null; }
}
function readDoc(file: string): string {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}
function normalizePath(value: string): string { return value.split(sep).join('/'); }
function layerFor(path: string, title: string): DocsLayer {
  const p = path.toLowerCase();
  if (/docs\/conductor\/conductor\.md$/.test(p) || /conductor/.test(p) && /umbrella/i.test(title)) return 'L0';
  if (/seat-state\/op\/plans\/plan-[^/]+\.md$/i.test(path) || /plan-0\.3\.\d+/i.test(path)) return 'L1.5';
  if (/ops-rules\.md$/i.test(path) || /seat-state\/ops\//i.test(path)) return 'L2';
  if (/self-capability-map|features?\//i.test(path) || /기능 카드/.test(title)) return 'L3';
  if (/docs\/manual\/|runbook|manual/i.test(path)) return 'L4';
  if (/first-principles|principles\//i.test(path)) return 'L1';
  if (/^docs\/(?:public\/)?/.test(path) || /^seat-state\//i.test(path)) return 'L5';
  return 'L5';
}
function parseHeader(path: string, file: string, text: string, size: number, modifiedAt: string | null): DocsIndexEntry {
  const lines = text.split(/\r?\n/);
  const title = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, '').trim() || path.split('/').at(-1) || path;
  const paragraph = lines.find((line) => line.trim() && !/^\s*#/.test(line) && !/^\s*[-*]\s/.test(line));
  const oneLine = (paragraph ?? title).replace(/\s+/g, ' ').slice(0, 280);
  const umbrella = text.match(/🔗\s*우산\s*[—-]\s*([^\n]+)/i)?.[1]?.trim() ?? null;
  const supersession = text.match(/\(대체됨\s*→\s*([^)]*)\)/)?.[1]?.trim() ?? null;
  const sectionHeadings = lines.filter((line) => /^#{2,6}\s+/.test(line)).map((line) => line.replace(/^#{2,6}\s+/, '').trim());
  const refs = [...text.matchAll(/^\s*(?:refs|참조):\s*(.+)$/gim)].flatMap((m) => m[1]!.split(/[`,，,]/).map((v) => v.trim()).filter(Boolean));
  const verifiedAt = text.match(/^\s*verified:\s*([^\s]+)\s*$/im)?.[1] ?? null;
  const lastVerified = text.match(/^\s*lastVerified:\s*([^\s]+)\s*$/im)?.[1]
    ?? text.match(/^\s*마지막\s*확인일:\s*([^\s]+)\s*$/im)?.[1]
    ?? verifiedAt;
  const audience: DocsAudience = /^docs\/public\//i.test(path)
    ? 'public'
    : (/^\s*audience:\s*public\s*$/im.test(text) ? 'public' : 'internal');
  let status: DocsStatus = /^\s*status:\s*draft\s*$/im.test(text) ? 'draft' : (supersession ? 'superseded' : 'current');
  if (/^seat-state\/OP\/plans\/PLAN-[^/]+\.md$/i.test(path)) {
    // plan currentness is assigned in buildDocsIndex after parsing; every plan starts superseded.
    status = 'superseded';
  }
  const layer = layerFor(path, title);
  return {
    path, layer, title, oneLine, status, supersededBy: supersession,
    umbrellaSection: umbrella, owner: text.match(/^\s*owner:\s*(.+)$/im)?.[1]?.trim() ?? null,
    lastVerified, verifiedAt, refs, size, audience, sections: sectionHeadings, modifiedAt,
  };
}
function enumerateFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const file = resolve(dir, name);
      let st;
      try { st = statSync(file); } catch { continue; }
      if (st.isDirectory()) walk(file);
      else if (st.isFile() && DOCS_FILE.test(name)) out.push(file);
    }
  };
  walk(root);
  return out;
}
function relativeDocPath(root: string, file: string): string {
  const normRoot = normalizePath(resolve(root));
  const rel = normalizePath(relative(root, file));
  const prefix = /(?:^|\/)docs$/i.test(normRoot) ? 'docs'
    : /(?:^|\/)seat-state$/i.test(normRoot) ? 'seat-state' : '';
  return prefix ? `${prefix}/${rel}` : rel;
}

/** Derive a deterministic machine index from document content and tracked metadata. */
export function buildDocsIndex(options: BuildDocsIndexOptions): DocsIndexEntry[] {
  const entries: DocsIndexEntry[] = [];
  const seen = new Set<string>();
  for (const root of options.roots) {
    for (const file of enumerateFiles(resolve(root))) {
      const path = relativeDocPath(resolve(root), file);
      if (seen.has(path)) continue;
      seen.add(path);
      const text = readDoc(file);
      let size = 0;
      try { size = statSync(file).size; } catch { /* unreadable file is omitted below */ }
      if (!text) continue;
      const modifiedAt = (options.gitLastModified ?? gitModified)(file);
      entries.push(parseHeader(path, file, text, size, modifiedAt));
    }
  }
  const plans = entries.filter((e) => /^seat-state\/OP\/plans\/PLAN-[^/]+\.md$/i.test(e.path));
  const requested = options.currentPlan ? plans.find((e) => e.path.endsWith(options.currentPlan!)) : undefined;
  const selected = requested ?? plans.sort((a, b) => b.path.localeCompare(a.path))[0];
  for (const plan of plans) plan.status = plan === selected ? 'current' : 'superseded';
  // Superseded marker without an explicit target is still a historical record, but remains discoverable in index only.
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function renderDocsIndexJsonl(entries: readonly DocsIndexEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

export function docsCurrencyReport(entries: readonly DocsIndexEntry[], options: { now?: Date } = {}): DocsCurrencyReport {
  const now = (options.now ?? new Date()).getTime();
  const alarms: DocsCurrencyAlarm[] = [];
  const stale: Array<{ path: string; days: number }> = [];
  for (const entry of entries) {
    if (entry.status !== 'current') continue;
    if (!entry.umbrellaSection && !['L0', 'L1', 'L1.5', 'L2'].includes(entry.layer) && entry.audience !== 'public') alarms.push({ path: entry.path, reason: 'umbrella-missing' });
    if (entry.supersededBy && !entries.some((e) => e.path === entry.supersededBy)) alarms.push({ path: entry.path, reason: 'superseded-target-missing' });
    if (!entry.lastVerified) continue;
    const time = Date.parse(entry.lastVerified);
    if (!Number.isFinite(time)) continue;
    const days = Math.floor((now - time) / DAY_MS);
    if (days > DOCS_STALE_AFTER_DAYS) stale.push({ path: entry.path, days });
  }
  const superseded = entries.filter((e) => e.status === 'superseded').length;
  return { alarms, stale: stale.sort((a, b) => a.path.localeCompare(b.path)), unclassified: alarms.filter((a) => a.reason === 'umbrella-missing').length, superseded };
}

/** Deterministic lexical grounding over current index entries; excludes historical/superseded records. */
export function docsFind(entries: readonly DocsIndexEntry[], query: string, options: { audience?: DocsAudience; limit?: number } = {}): DocsFindHit[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  return entries.filter((e) => e.status === 'current' && (!options.audience || e.audience === options.audience))
    .map((entry) => {
      const sectionsText = entry.sections.join(' ').toLocaleLowerCase();
      const searchable = `${entry.title} ${entry.oneLine} ${entry.sections.join(' ')}`.toLocaleLowerCase();
      const phrase = searchable.includes(q);
      const overlap = tokens.reduce((n, t) => n + (searchable.includes(t) ? 1 : 0), 0);
      const section = entry.sections.find((s) => s.toLocaleLowerCase().includes(q)
        || tokens.filter((t) => s.toLocaleLowerCase().includes(t)).length >= Math.max(1, Math.ceil(tokens.length * 0.7))) ?? null;
      const score = (phrase ? 100 : 0) + overlap * 10 + (section ? 40 : 0) + (entry.layer === 'L2' ? 2 : 0);
      return { entry, badge: entry.audience === 'public' ? '[공개]' as const : '[내부]' as const, score, section };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    .slice(0, options.limit ?? DOCS_FIND_TOP_N);
}

/** L0–L3 compact must-carry summary plus current plan pointer; clipped by UTF-8 byte budget. */
export function docsSystemAlwaysCarry(entries: readonly DocsIndexEntry[]): { text: string; bytes: number } {
  const selected = entries.filter((e) => e.status === 'current' && ['L0', 'L1', 'L1.5', 'L2', 'L3'].includes(e.layer));
  const plan = selected.find((e) => e.layer === 'L1.5');
  const rows = selected.filter((e) => e.layer !== 'L1.5').map((e) => `${e.layer} ${e.title} — ${e.oneLine} (${e.path})`);
  const opsSections = selected.filter((e) => e.layer === 'L2').flatMap((e) => e.sections.map((s) => `L2 §${s}`));
  const text = [rows.join('\n'), opsSections.join('\n'), plan ? `현행 판 계획: ${plan.title} (${plan.path})` : ''].filter(Boolean).join('\n');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= DOCS_ALWAYS_CARRY_MAX_BYTES) return { text, bytes };
  let clipped = '';
  for (const char of text) {
    if (Buffer.byteLength(clipped + char, 'utf8') > DOCS_ALWAYS_CARRY_MAX_BYTES) break;
    clipped += char;
  }
  return { text: clipped, bytes: Buffer.byteLength(clipped, 'utf8') };
}

export function docsSystemManifest(entries: readonly DocsIndexEntry[], report: DocsCurrencyReport): DocsManifest {
  const layerBytes = Object.fromEntries(DOCS_LAYERS.map((layer) => [layer, entries.filter((e) => e.layer === layer).reduce((n, e) => n + e.size, 0)])) as Record<DocsLayer, number>;
  return {
    total: entries.length,
    current: entries.filter((e) => e.status === 'current').length,
    superseded: entries.filter((e) => e.status === 'superseded').length,
    draft: entries.filter((e) => e.status === 'draft').length,
    unclassified: report.unclassified,
    stale: report.stale.length,
    layerBytes,
  };
}

/** Default docs + seat-state roots, honoring isolated state before the operator home. */
export function defaultDocsSystemRoots(options: { cwd?: string; env?: NodeJS.ProcessEnv; seatStateRoot?: string } = {}): string[] {
  const env = options.env ?? process.env;
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const docs = resolve(options.cwd ?? packageRoot, 'docs');
  const stateRoot = options.seatStateRoot
    ?? (env.ELANOUS_STATE_DIR?.trim() ? join(env.ELANOUS_STATE_DIR.trim(), 'seat-state') : join(homedir(), 'elanous-hq', 'seat-state'));
  return [docs, resolve(stateRoot)];
}
