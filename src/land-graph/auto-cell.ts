/**
 * CELLLESS-PR-AUTO-CELL (0.3.38 P1 · OP 11-27): ~19 of 49 lands on 11-27 matched no cell → greens 3–6/h while lands 16/h.
 * S: the post-merge sweep (main-cell-link.ts · LAND-CELL-LINK-ALWAYS) links every merge it can match, and only mails OP a
 *    «no cell» line for the rest — a line nobody turns into a cell, so those lands never count as greens.
 * C: green stays ONE definition (판정 집사); no new gate; nothing refuses or delays a land.
 * Q: how does a cellless merge still reach a cell the butler can sign?
 * A: the sweep auto-registers one cell in the release in play — id = the «칸» id the PR named (unregistered) or a stable slug
 *    of the head branch (else the title) · title = PR title · body «대상 경로: <changed files>» · owner = author seat
 *    (body «자리:» line · branch prefix · else OP) · priority P2 · evidence #PR — and posts one OP digest line per auto-cell.
 *    Idempotent on the PR number: once the cell cites #PR every later sweep reads it as `linked`.
 * Policy values live in graphs/loop-agents/land-steward/cell-auto.yaml (YAML-SYSTEM: «정의만으로 도는 시스템»).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { ChecklistAddInput, ChecklistItem } from '../release-loop/checklist.js';
import type { PrInfo } from './land-graph.js';

export interface AutoCellPolicy {
  scope: { excludePaths: string[]; excludeBranchPrefixes: string[] };
  cell: { priority: 'P0' | 'P1' | 'P2'; dispatchKind: 'code' | 'ops' | 'measure' | 'decision' | 'umbrella'; idMinLen: number; idMaxLen: number; titleSlugBranchPrefixes: string[]; maxTargetPaths: number };
  owner: { default: string; branchPrefix: Record<string, string>; bodyLineKeys: string[] };
  digest: { to: string };
}

export const autoCellPolicyPath = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'loop-agents', 'land-steward', 'cell-auto.yaml');

const SEAT = /^[A-Z][A-Z0-9]{1,7}(?:-[0-9]{1,8})?$/u;
const strs = (v: unknown, key: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`cell-auto policy: ${key} must be a list of strings`);
  return v as string[];
};
const num = (v: unknown, key: string): number => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) throw new Error(`cell-auto policy: ${key} must be a positive number`); return v; };
const seat = (v: unknown, key: string): string => { if (typeof v !== 'string' || !SEAT.test(v)) throw new Error(`cell-auto policy: ${key} must be a seat name (e.g. OP · TC-1)`); return v; };

/** Parse + validate the policy text (pure). Unknown or malformed values throw — a broken policy is loud, never silently defaulted. */
export function parseAutoCellPolicy(text: string): AutoCellPolicy {
  const y = (parse(text) ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const sc = y.scope ?? {}, c = y.cell ?? {}, o = y.owner ?? {}, d = y.digest ?? {};
  const priority = c.priority ?? 'P2';
  if (!['P0', 'P1', 'P2'].includes(priority as string)) throw new Error('cell-auto policy: cell.priority must be P0|P1|P2');
  const dispatchKind = c.dispatch_kind ?? 'ops';
  if (!['code', 'ops', 'measure', 'decision', 'umbrella'].includes(dispatchKind as string)) throw new Error('cell-auto policy: cell.dispatch_kind must be code|ops|measure|decision|umbrella');
  const bp = (o.branch_prefix ?? {}) as Record<string, unknown>;
  const branchPrefix: Record<string, string> = {};
  for (const [k, v] of Object.entries(bp)) branchPrefix[k.toLowerCase()] = seat(v, `owner.branch_prefix.${k}`);
  const idMinLen = num(c.id_min_len ?? 6, 'cell.id_min_len'), idMaxLen = num(c.id_max_len ?? 48, 'cell.id_max_len');
  if (idMinLen > idMaxLen) throw new Error('cell-auto policy: cell.id_min_len > cell.id_max_len');
  return {
    scope: { excludePaths: strs(sc.exclude_paths, 'scope.exclude_paths'), excludeBranchPrefixes: strs(sc.exclude_branch_prefixes, 'scope.exclude_branch_prefixes').map(s => s.toLowerCase()) },
    cell: { priority: priority as AutoCellPolicy['cell']['priority'], dispatchKind: dispatchKind as AutoCellPolicy['cell']['dispatchKind'], idMinLen, idMaxLen,
      titleSlugBranchPrefixes: strs(c.title_slug_branch_prefixes, 'cell.title_slug_branch_prefixes').map(s => s.toLowerCase()), maxTargetPaths: num(c.max_target_paths ?? 30, 'cell.max_target_paths') },
    owner: { default: seat(o.default ?? 'OP', 'owner.default'), branchPrefix, bodyLineKeys: strs(o.body_line_keys, 'owner.body_line_keys') },
    digest: { to: seat(d.to ?? 'OP', 'digest.to') },
  };
}

export function loadAutoCellPolicy(path = autoCellPolicyPath()): AutoCellPolicy {
  if (!existsSync(path)) throw new Error(`cell-auto policy missing: ${path}`);
  return parseAutoCellPolicy(readFileSync(path, 'utf8'));
}

/** UPPER-KEBAB slug, cut at a word boundary to `max` (pure). */
export function slugId(text: string, max: number): string {
  const words = text.normalize('NFKD').replace(/[^A-Za-z0-9]+/gu, ' ').trim().split(/\s+/u).filter(Boolean).map(w => w.toUpperCase());
  let out = '';
  for (const w of words) { const next = out ? `${out}-${w}` : w; if (next.length > max) break; out = next; }
  return out || (words[0] ?? '').slice(0, max);
}

const branchHead = (ref: string | undefined) => (ref && ref.includes('/') ? ref.slice(0, ref.indexOf('/')).toLowerCase() : null);
const stripConventional = (title: string) => title.replace(/^\s*[a-z]+(?:\([^)]*\))?!?:\s*/iu, '');

/** Owner seat: a body «자리: X» line → the branch prefix map → the policy default (pure). */
export function ownerOf(pr: Pick<PrInfo, 'body' | 'headRef'>, p: AutoCellPolicy): { seat: string; from: 'body' | 'branch' | 'default' } {
  const keys = new Set(p.owner.bodyLineKeys.map(k => k.toLowerCase()));
  for (const line of (pr.body ?? '').split(/\r?\n/u)) {
    const m = /^[ \t>*-]*(?:\*\*)?([^:：*]{1,20}?)(?:\*\*)?[ \t]*[:：][ \t]*(?:\*\*)?([^\s*·,()]+)/u.exec(line);
    if (m && keys.has(m[1]!.trim().toLowerCase()) && SEAT.test(m[2]!)) return { seat: m[2]!, from: 'body' };
  }
  const head = branchHead(pr.headRef);
  if (head && p.owner.branchPrefix[head]) return { seat: p.owner.branchPrefix[head]!, from: 'branch' };
  return { seat: p.owner.default, from: 'default' };
}

export type AutoCellPlan =
  | { kind: 'register'; input: ChecklistAddInput; fallbackId: string; idFrom: 'named' | 'branch' | 'title' | 'pr'; ownerFrom: 'body' | 'branch' | 'default' }
  | { kind: 'skip'; why: string };

/**
 * The auto-cell for one cellless merged PR (pure). `named` = the first unregistered id the PR's «칸» line named.
 * An id already taken in this release → `<id>-<PR>`; `fallbackId` is what the caller retries when the ledger refuses the first
 * (e.g. the id lives in another release).
 */
export function planAutoCell(pr: PrInfo, items: readonly Pick<ChecklistItem, 'id'>[], p: AutoCellPolicy, named?: readonly string[]): AutoCellPlan {
  const head = branchHead(pr.headRef);
  if (head && p.scope.excludeBranchPrefixes.includes(head)) return { kind: 'skip', why: `branch ${head}/ is out of scope` };
  if (p.scope.excludePaths.length && pr.files.length && pr.files.every(f => p.scope.excludePaths.some(x => f.startsWith(x)))) return { kind: 'skip', why: 'every file is in scope.exclude_paths' };
  const { idMinLen: min, idMaxLen: max } = p.cell;
  let id = ''; let idFrom: 'named' | 'branch' | 'title' | 'pr' = 'pr';
  const n = (named ?? []).find(x => x.length >= min && x.length <= max);
  if (n) { id = n; idFrom = 'named'; }
  if (!id && pr.headRef && !(head && p.cell.titleSlugBranchPrefixes.includes(head))) {
    const s = slugId(head ? pr.headRef.slice(pr.headRef.indexOf('/') + 1) : pr.headRef, max);
    if (s.length >= min) { id = s; idFrom = 'branch'; }
  }
  if (!id) { const s = slugId(stripConventional(pr.title), max); if (s.length >= min) { id = s; idFrom = 'title'; } }
  if (!id) id = `PR-${pr.number}`;
  const suffixed = (base: string) => { const sfx = `-${pr.number}`; return base.endsWith(sfx) ? base : `${base.slice(0, max - sfx.length).replace(/-+$/u, '')}${sfx}`; };
  if (items.some(i => i.id === id)) id = suffixed(id);
  const owner = ownerOf(pr, p);
  const files = pr.files.slice(0, p.cell.maxTargetPaths);
  const body = [
    ...(files.length ? [`대상 경로: ${files.join(' · ')}${pr.files.length > files.length ? ` (+${pr.files.length - files.length})` : ''}`] : []),
    `Auto-registered by the land steward (CELLLESS-PR-AUTO-CELL): #${pr.number} merged to main with no cell of this release.`,
  ].join('\n');
  return {
    kind: 'register', idFrom, ownerFrom: owner.from, fallbackId: suffixed(id),
    input: { id, title: pr.title.trim() || `PR #${pr.number}`, owner: owner.seat, priority: p.cell.priority, dispatchKind: p.cell.dispatchKind, body,
      doneCriterion: `#${pr.number} merged to main · same-head receipt + focused exit 0 (판정 집사)`, source: `PR #${pr.number}` },
  };
}
