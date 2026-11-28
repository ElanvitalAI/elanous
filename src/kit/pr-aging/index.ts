// Kit pr-aging — PR-ZOMBIE-AGING (0.3.40 P1 · CEO 11-29 02:3x). One shared routine for «is this open PR still supply?»:
// the land steward's tick (land-graph.tick · src/land-graph/land-graph.ts) ages zombies (draft ⊕ owner card · close
// proposal card) and the throughput controller (src/loops/throughput-controller-live.ts) counts only fresh PRs as pipeline.
// Numbers and the conflict signal names live in graphs/policies/pr-aging.yaml — this file holds none.
//
// S: 11-28 `eln pulse throughput` read «141 waiting»; most were #36xxx–#38xxx PRs untouched for over a week that no longer
//    merged onto main. C: the controller and the land graph counted them as supply. Q: which open PRs are supply, and who acts
//    on the rest? A: supply = not draft ⊕ head updated within supply.fresh_head_max_days; a PR whose head is older than
//    to_draft.head_age_days AND carries a structured «does not merge onto main» signal on that head (a PREGATE-RED receipt step
//    · a land-graph refusal class) becomes a draft with one author card; older than close_proposal.head_age_days → one close
//    proposal card (code never closes — a triage run does).
//
// 세 얼굴: 관측 = the land tick's `aging` list (last-tick.json · ledger rows event «aging») ⊕ the throughput block's
// «좀비 제외» count / 판단 근거 = the YAML ⊕ the head's commit time ⊕ RED receipt steps ⊕ land ledger classes (no text
// heuristics) / 수복과 인계 = a draft is reversible (`gh pr ready <N>`) · unknown head age = fresh (never hidden) · an
// unreadable policy = no aging and no freshness filter (the old count, marked «pr-aging policy» unmeasured).
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

export type CardRole = 'author' | 'landing-owner';
export interface PrAgingPolicy {
  readonly supply: { readonly freshHeadMaxDays: number };
  readonly conflict: { readonly pregateRedStages: readonly string[]; readonly landRefusals: readonly string[] };
  readonly toDraft: { readonly headAgeDays: number; readonly requireConflict: boolean; readonly maxPerTick: number; readonly cardTo: readonly CardRole[] };
  readonly closeProposal: { readonly headAgeDays: number; readonly requireConflict: boolean; readonly cardTo: readonly CardRole[] };
}

export const prAgingPolicyPath = (root = resolve(import.meta.dir, '../../..')): string => join(root, 'graphs', 'policies', 'pr-aging.yaml');

const ROLES: readonly CardRole[] = ['author', 'landing-owner'];

/** Parse the policy text. A missing / invalid value throws (the caller decides what an unreadable policy means). */
export function parsePrAgingPolicy(text: string): PrAgingPolicy {
  const v = parse(text) as Record<string, Record<string, unknown>> | null;
  const num = (sec: string, key: string, min = 1): number => {
    const n = v?.[sec]?.[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min) throw new Error(`pr-aging policy: invalid ${sec}.${key}`);
    return n;
  };
  const bool = (sec: string, key: string): boolean => {
    const b = v?.[sec]?.[key];
    if (typeof b !== 'boolean') throw new Error(`pr-aging policy: invalid ${sec}.${key}`);
    return b;
  };
  const names = (sec: string, key: string): string[] => {
    const a = v?.[sec]?.[key];
    if (!Array.isArray(a) || !a.every(x => typeof x === 'string' && x.length > 0)) throw new Error(`pr-aging policy: invalid ${sec}.${key}`);
    return a as string[];
  };
  const roles = (sec: string): CardRole[] => {
    const a = names(sec, 'card_to');
    if (!a.length || !a.every(r => (ROLES as readonly string[]).includes(r))) throw new Error(`pr-aging policy: invalid ${sec}.card_to`);
    return a as CardRole[];
  };
  const p: PrAgingPolicy = {
    supply: { freshHeadMaxDays: num('supply', 'fresh_head_max_days') },
    conflict: { pregateRedStages: names('conflict', 'pregate_red_stages'), landRefusals: names('conflict', 'land_refusals') },
    toDraft: { headAgeDays: num('to_draft', 'head_age_days'), requireConflict: bool('to_draft', 'require_conflict'), maxPerTick: num('to_draft', 'max_per_tick', 0), cardTo: roles('to_draft') },
    closeProposal: { headAgeDays: num('close_proposal', 'head_age_days'), requireConflict: bool('close_proposal', 'require_conflict'), cardTo: roles('close_proposal') },
  };
  if (p.closeProposal.headAgeDays < p.toDraft.headAgeDays) throw new Error('pr-aging policy: close_proposal.head_age_days < to_draft.head_age_days');
  return p;
}

let memo: { path: string; mtimeMs: number; policy: PrAgingPolicy | null } | null = null;
/** The live policy (re-read when the file changes) · null = unreadable / invalid. */
export function livePrAgingPolicy(path = prAgingPolicyPath()): PrAgingPolicy | null {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (memo && memo.path === path && memo.mtimeMs === mtimeMs) return memo.policy;
    let policy: PrAgingPolicy | null = null;
    try { policy = parsePrAgingPolicy(readFileSync(path, 'utf8')); } catch { policy = null; }
    memo = { path, mtimeMs, policy };
    return policy;
  } catch { return null; }
}

// ── Head age ────────────────────────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
export type HeadAtSource = 'commit' | 'pr-updated';
export interface HeadAt { readonly at: number; readonly source: HeadAtSource }

/** The head's age basis: the head commit's committer time, else the PR's updatedAt (an upper bound on the last push) · null = unknown. */
export function headAtOf(commitMs: number | undefined, updatedAt: string | undefined): HeadAt | null {
  if (typeof commitMs === 'number' && Number.isFinite(commitMs)) return { at: commitMs, source: 'commit' };
  const u = updatedAt ? Date.parse(updatedAt) : NaN;
  return Number.isFinite(u) ? { at: u, source: 'pr-updated' } : null;
}

/** Whole days since the head moved · null = unknown. */
export const headAgeDays = (h: HeadAt | null, nowMs: number): number | null => h === null ? null : Math.max(0, Math.floor((nowMs - h.at) / DAY_MS));

/** Supply: not draft and head updated within supply.fresh_head_max_days (unknown age = fresh — never hidden). */
export function isFreshPr(p: { readonly draft: boolean; readonly headAt: HeadAt | null }, policy: PrAgingPolicy, nowMs: number): boolean {
  if (p.draft) return false;
  const age = headAgeDays(p.headAt, nowMs);
  return age === null || age <= policy.supply.freshHeadMaxDays;
}

/**
 * Committer times of the heads present in the local repo — two git calls, no network: GIT_NO_LAZY_FETCH stops a partial
 * clone from fetching a missing object (a missing head is simply absent from the map). Never throws.
 */
export function headCommitTimes(repo: string, heads: readonly string[], timeoutMs = 30_000): Map<string, number> {
  const out = new Map<string, number>();
  const want = [...new Set(heads.filter(h => /^[0-9a-f]{40}$/.test(h)))];
  if (!repo || !want.length) return out;
  const env = { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
  try {
    const check = spawnSync('git', ['-C', repo, 'cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${want.join('\n')}\n`, encoding: 'utf8', env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    if (check.status !== 0) return out;
    const present = check.stdout.split('\n').map(l => l.split(' ')).filter(([sha, type]) => type === 'commit' && sha).map(([sha]) => sha!);
    if (!present.length) return out;
    const log = spawnSync('git', ['-C', repo, 'log', '--no-walk=unsorted', '--format=%H %ct', ...present], { encoding: 'utf8', env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    if (log.status !== 0) return out;
    for (const line of log.stdout.split('\n')) {
      const [sha, ct] = line.split(' ');
      const s = Number(ct);
      if (sha && Number.isFinite(s) && s > 0) out.set(sha, s * 1000);
    }
  } catch { /* unknown age = fresh */ }
  return out;
}

// ── The zombie judgment ─────────────────────────────────────────────────────────────────────────────────────────────

/** What one open PR's head carries, read from structured sources only. */
export interface ConflictFacts {
  /** names of the failed steps (exit ≠ 0) of this head's PREGATE-RED receipts */
  readonly redFailedSteps: readonly string[];
  /** refusal classes of this head's land-graph ledger `refused` rows */
  readonly landRefusals: readonly string[];
}

/** The «does not merge onto main» evidence of one head · null = none. */
export function conflictEvidence(f: ConflictFacts, policy: PrAgingPolicy): string | null {
  const stage = f.redFailedSteps.find(s => policy.conflict.pregateRedStages.includes(s));
  if (stage) return `pregate RED ${stage}`;
  const cls = f.landRefusals.find(c => policy.conflict.landRefusals.includes(c));
  return cls ? `land refused ${cls}` : null;
}

export type AgingStage = 'to-draft' | 'close-proposal';
export interface AgingInput {
  readonly pr: number; readonly head: string; readonly draft: boolean; readonly author: string;
  readonly headAt: HeadAt | null; readonly conflict: string | null;
}
export interface AgingVerdict {
  readonly pr: number; readonly head: string; readonly stage: AgingStage; readonly ageDays: number;
  readonly basis: HeadAtSource; readonly conflict: string | null; readonly author: string; readonly why: string;
}

/** One verdict per aged PR (the later stage wins), oldest head first. A PR of unknown age is never aged. */
export function judgePrAging(prs: readonly AgingInput[], policy: PrAgingPolicy, nowMs: number): AgingVerdict[] {
  const out: AgingVerdict[] = [];
  for (const p of prs) {
    const age = headAgeDays(p.headAt, nowMs);
    if (age === null || p.headAt === null) continue;
    const base = { pr: p.pr, head: p.head, ageDays: age, basis: p.headAt.source, conflict: p.conflict, author: p.author };
    const c = policy.closeProposal;
    if (age >= c.headAgeDays && (p.conflict || !c.requireConflict)) {
      out.push({ ...base, stage: 'close-proposal', why: `head unchanged ${age}d ≥ ${c.headAgeDays}d${p.conflict ? ` · ${p.conflict}` : ''}` });
      continue;
    }
    const t = policy.toDraft;
    if (!p.draft && age >= t.headAgeDays && (p.conflict || !t.requireConflict)) {
      out.push({ ...base, stage: 'to-draft', why: `head unchanged ${age}d ≥ ${t.headAgeDays}d${p.conflict ? ` · ${p.conflict}` : ''}` });
    }
  }
  return out.sort((a, b) => b.ageDays - a.ageDays || a.pr - b.pr);
}

/** The card text of one verdict (the author / the landing owner read it). */
export function agingCard(v: AgingVerdict, title: string): string {
  const head = v.head.slice(0, 12);
  return v.stage === 'to-draft'
    ? `[착지 집사 · PR 노화] #${v.pr} «${title.slice(0, 80)}» @${head} → draft 로 돌림 — ${v.why}. 이어 갈 거면: git fetch && git merge origin/main → push → pregate → gh pr ready ${v.pr} · 버릴 거면 gh pr close ${v.pr}`
    : `[착지 집사 · PR 노화 · 닫기 제안] #${v.pr} «${title.slice(0, 80)}» @${head} — ${v.why}. 코드는 닫지 않는다: 트리아지가 닫는다(gh pr close ${v.pr}) · 살릴 거면 작성자가 main 병합 → push → pregate → gh pr ready ${v.pr}`;
}

// ── Supply ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SupplyPr { readonly pr: number; readonly head: string; readonly draft: boolean; readonly updatedAt?: string }
/** Fresh supply heads (pr → head) ⊕ the non-draft PRs left out as stale (oldest numbers first). No policy = every non-draft PR. */
export function splitSupply(prs: readonly SupplyPr[], commitTimes: ReadonlyMap<string, number>, policy: PrAgingPolicy | null, nowMs: number): { heads: Map<number, string>; stale: number[] } {
  const heads = new Map<number, string>(); const stale: number[] = [];
  for (const p of prs) {
    if (p.draft) continue;
    if (!policy || isFreshPr({ draft: p.draft, headAt: headAtOf(commitTimes.get(p.head), p.updatedAt) }, policy, nowMs)) heads.set(p.pr, p.head);
    else stale.push(p.pr);
  }
  return { heads, stale: stale.sort((a, b) => a - b) };
}
