// MODEL-BY-DIFFICULTY (CEO 11-27 07:3x · 12 of 19 hands on glm-5.3, 7 on terra, whatever the cell) — the model follows
// the cell: a deterministic difficulty score from facts → hard / medium / easy → terra / luna / glm, written as the
// seat's model directive when the cell is assigned or claimed. The hand's TUI applies it at its next turn start as an
// in-session provider switch (the same selection `/provider use` sets) — the same tab, no relaunch.
//
// 세 얼굴: 관측 = the directive file (seat-model/<SEAT>.json: tier · model · reasons · note) ⊕ the assignment mail line
//          «model: <tier> → <provider>/<model> (<reasons>)» ⊕ `seat.model-directive` / `seat.model-applied` log rows ·
//          인지 = facts only — target paths (hot files · count · security-4), cell id tokens (RED · TSC), prior attempts,
//          a stale base — never the title prose ·
//          수복과 인계 = an account over its cap → one tier down with a note, never a stall; glm is the floor.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { security4Hits } from '../judge-butler/done-when.js';
import { capOf } from '../kit/resource-facts/index.js';

export type DifficultyTier = 'hard' | 'medium' | 'easy';

/** Files whose changes collide and break most often (CEO 11-27 list). A path matches by suffix or by a directory segment. */
export const HOT_FILES: readonly string[] = [
  'src/attach/attach-app.ts', 'attach-app.ts', 'src/els/server.ts', 'elements/index.ts', 'src/land-graph/', 'src/tui/entry.ts',
];

// 출처: MODEL-BY-DIFFICULTY brief (coordinator 11-27 07:4x) — «hot files touched → hard»: a hot file alone reaches hard;
// security-4 · RED/tsc · prior attempts are one real risk each (medium), two of them reach hard; a wide change adds one.
export const DIFFICULTY_HARD_AT = 5;
export const DIFFICULTY_MEDIUM_AT = 2;
export const WIDE_CHANGE_FILES = 5;

export interface DifficultyFacts {
  readonly cellId: string;
  readonly paths: readonly string[];
  /** Earlier assignments of this cell that did not finish it (re-assignments). */
  readonly priorAttempts?: number;
  /** The cell's PR is behind main and needs a rebase. */
  readonly staleBase?: boolean;
}

export interface Difficulty { readonly score: number; readonly tier: DifficultyTier; readonly reasons: readonly string[] }

const isHot = (p: string) => HOT_FILES.some(h => (h.endsWith('/') ? p.includes(h) : p === h || p.endsWith(`/${h}`)));
const isEasyPath = (p: string) => p.startsWith('docs/') || p.endsWith('.md') || /\.test\.tsx?$/u.test(p) || p.startsWith('test/');

/** The difficulty of a cell from facts. Docs/tests-only cells with no other risk are easy. */
export function cellDifficulty(f: DifficultyFacts): Difficulty {
  const reasons: string[] = []; let score = 0;
  const hot = f.paths.filter(isHot);
  if (hot.length) { score += DIFFICULTY_HARD_AT + Math.min(2, hot.length - 1); reasons.push(`hot ${hot.slice(0, 3).join(',')}`); }
  const sec = security4Hits(f.paths);
  if (sec.length) { score += 3; reasons.push(`security-4 ${sec[0]}`); }
  if (f.paths.length > WIDE_CHANGE_FILES) { score += 2; reasons.push(`${f.paths.length} files`); }
  else if (f.paths.length > 2) { score += 1; reasons.push(`${f.paths.length} files`); }
  const tokens = f.cellId.toUpperCase().split(/[-_]/u);
  if (tokens.includes('RED') || tokens.includes('TSC')) { score += 3; reasons.push('RED/tsc fix'); }
  if (f.staleBase) { score += 1; reasons.push('stale base'); }
  if ((f.priorAttempts ?? 0) > 0) { score += 2 * Math.min(2, f.priorAttempts!); reasons.push(`${f.priorAttempts} prior attempt(s)`); }
  const easyOnly = f.paths.length > 0 && f.paths.every(isEasyPath);
  const tier: DifficultyTier = score >= DIFFICULTY_HARD_AT ? 'hard' : score >= DIFFICULTY_MEDIUM_AT && !(easyOnly && score < 3) ? 'medium' : 'easy';
  if (!reasons.length) reasons.push(easyOnly ? 'docs/tests only' : f.paths.length ? 'small change' : 'no target paths');
  return { score, tier, reasons };
}

export interface HandModel { readonly tier: DifficultyTier; readonly provider: string; readonly model: string }

const TERRA = { provider: 'openai-codex', model: 'gpt-6.1-terra' } as const;
const LUNA = { provider: 'openai-codex', model: 'gpt-6-luna' } as const;
// GLM-NAME (11-27 · verified from the live hands): the glm hands run provider `glm` (Z.ai Coding Plan direct · model
// `glm-5.3` — `models.context-window family-fallback {provider: glm, modelId: glm-5.3}` · hand titles «… · glm»).
const GLM = { provider: 'glm', model: 'glm-5.3' } as const;
// GLM-QUOTA (11-27 · status line «glm 5h 0% · week 100% ⚠»): past the Z.ai plan's cap the same model through OpenRouter
// (prepaid credits · auto top-up) — ZAI_OPENROUTER_FALLBACK_MODEL; OpenRouter out too → step UP to luna, never a stall.
const OR_GLM = { provider: 'openrouter', model: 'z-ai/glm-5.3' } as const;

/** Tier → the models to try, first that is under its cap wins (defaults in code). */
export const TIER_CHAIN: Readonly<Record<DifficultyTier, readonly { provider: string; model: string }[]>> = {
  hard: [TERRA, LUNA, GLM, OR_GLM],
  medium: [LUNA, GLM, OR_GLM, TERRA],
  easy: [GLM, OR_GLM, LUNA],
};
/** The first choice of each tier (the plan without budget pressure). */
export const TIER_MODEL: Readonly<Record<DifficultyTier, HandModel>> = {
  hard: { tier: 'hard', ...TERRA }, medium: { tier: 'medium', ...LUNA }, easy: { tier: 'easy', ...GLM },
};
// 출처: CEO 11-27 «codex team/third ~95%» — an account at or above this share used is not given new cells.
// RESOURCE-FACTS-FROM-LEDGER: the cap is a resource fact (policy file `caps.accountCap` · default in kit/resource-facts).
export const accountCap = (): number => capOf('accountCap');
const tierOf = (m: { provider: string; model: string }): DifficultyTier => (m.model === TERRA.model ? 'hard' : m.model === LUNA.model ? 'medium' : 'easy');

/**
 * The model for a tier under the account budgets: `usedShare(provider)` = the provider's used share (0..1; 1 = out of
 * credit), null = unknown (allowed). The first model of the tier's chain under accountCap() wins; a step is noted. Every
 * model over its cap → the chain's last, noted — never a stall.
 */
export function pickHandModel(tier: DifficultyTier, usedShare: (provider: string) => number | null): HandModel & { readonly note?: string } {
  const chain = TIER_CHAIN[tier];
  const skipped: string[] = [];
  const cap = accountCap();
  for (const [i, m] of chain.entries()) {
    // LLM-ACCOUNT-POLICY-YAML: a level/override `tier_down` on every routable account of the tier's first provider steps
    // one model down (the chain's next entry) before any budget check.
    if (i === 0 && chain.length > 1) {
      let down: string | null = null;
      try { down = (require('../kit/resource-facts/llm-decide.js') as typeof import('../kit/resource-facts/llm-decide.js')).decidedProviderTierDown(m.provider); } catch { down = null; }
      if (down) { skipped.push(`${m.provider}/${m.model} tier_down (${down.slice(0, 120)})`); continue; }
    }
    let used: number | null = null;
    try { used = usedShare(m.provider); } catch { used = null; }
    if (used === null || used < cap) {
      const picked = { tier: tierOf(m), provider: m.provider, model: m.model };
      return skipped.length ? { ...picked, note: `budget: ${skipped.join(' · ')} → ${m.provider}/${m.model}` } : picked;
    }
    skipped.push(`${m.provider} at ${Math.round(used * 100)}% (cap ${Math.round(cap * 100)}%)`);
  }
  const last = chain[chain.length - 1]!;
  return { tier: tierOf(last), provider: last.provider, model: last.model, note: `budget: every account over cap (${skipped.join(' · ')}) — ${last.provider}/${last.model}` };
}

// ── the seat directive (written by assign/claim · applied by the hand's TUI at turn start) ─────────────────────
export interface SeatModelDirective extends HandModel {
  readonly seat: string; readonly cell: string; readonly score: number; readonly reasons: readonly string[];
  readonly note?: string; readonly by: string; readonly at: string;
}

export const seatModelPath = (root: string, seat: string) => join(root, 'seat-model', `${seat.toUpperCase().replace(/[^A-Z0-9._-]/gu, '_')}.json`);

export function writeSeatModelDirective(root: string, d: SeatModelDirective): void {
  const path = seatModelPath(root, d.seat);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(d)}\n`);
  renameSync(`${path}.tmp`, path);
}

export function readSeatModelDirective(root: string, seat: string): SeatModelDirective | null {
  try {
    const d = JSON.parse(readFileSync(seatModelPath(root, seat), 'utf8')) as SeatModelDirective;
    return typeof d.provider === 'string' && typeof d.model === 'string' && typeof d.at === 'string' ? d : null;
  } catch { return null; }
}

/** Compute and describe the directive for a seat taking a cell. */
export function directiveFor(input: { seat: string; cell: string; facts: DifficultyFacts; usedShare: (provider: string) => number | null; by: string; now: Date }): SeatModelDirective {
  const d = cellDifficulty(input.facts);
  const m = pickHandModel(d.tier, input.usedShare);
  return { seat: input.seat.toUpperCase(), cell: input.cell, tier: m.tier, provider: m.provider, model: m.model, score: d.score, reasons: d.reasons,
    ...(m.note ? { note: m.note } : {}), by: input.by, at: input.now.toISOString() };
}

export function directiveLine(d: Pick<SeatModelDirective, 'tier' | 'provider' | 'model' | 'reasons' | 'note'>): string {
  return `model: ${d.tier} → ${d.provider}/${d.model} (${d.reasons.join(' · ')})${d.note ? ` · ${d.note}` : ''} — your tab switches at its next turn`;
}

/**
 * The hand side: a directive newer than the last one applied → the session's provider selection (the in-session switch
 * `/provider use` makes). Returns the applied directive or null. `select` = setSessionProvider.
 */
export function applySeatModelDirective(input: { root: string; seat: string; sessionId: string; lastAppliedAt: string | null;
  select: (sessionId: string, selection: { provider: string; model: string }) => void }): SeatModelDirective | null {
  const d = readSeatModelDirective(input.root, input.seat);
  if (!d || (input.lastAppliedAt && Date.parse(d.at) <= Date.parse(input.lastAppliedAt))) return null;
  input.select(input.sessionId, { provider: d.provider, model: d.model });
  return d;
}

/** Used share per provider from the status line's LLM usage snapshot (<state>/status/llm-usage.json):
 *  codex = the best account's · glm (zai) = its fullest window (5h · week) · openrouter = 1 when the balance is gone or the
 *  read failed, else 0. Unknown / no snapshot → null (allowed); codex falls back to the account-window snapshot. */
export function usedShareFromSnapshot(snapshot: { readonly accounts: readonly { readonly provider: string; readonly usedPercent: number | null; readonly leftUsd?: number; readonly status: string }[] } | null, provider: string): number | null {
  const rows = (snapshot?.accounts ?? []).filter(a => a.provider === (provider === 'openai-codex' ? 'codex' : provider === 'glm' ? 'zai' : provider));
  if (!rows.length) return null;
  if (provider === 'openrouter') {
    const ok = rows.filter(r => r.status === 'ok');
    if (!ok.length) return rows.some(r => r.status === 'error') ? 1 : null;
    return ok.some(r => (r.leftUsd ?? 1) > 0) ? 0 : 1;
  }
  const used = rows.filter(r => r.status === 'ok' && typeof r.usedPercent === 'number').map(r => r.usedPercent! / 100);
  if (!used.length) return null;
  return provider === 'glm' ? Math.max(...used) : Math.min(...used);
}

export function liveUsedShare(provider: string): number | null {
  try {
    const { llmUsageCachePath, parseLlmUsageSnapshot } = require('../statusline/sources/llm-usage.js') as typeof import('../statusline/sources/llm-usage.js');
    const share = usedShareFromSnapshot(parseLlmUsageSnapshot(readFileSync(llmUsageCachePath(), 'utf8')), provider);
    if (share !== null || provider !== 'openai-codex') return share;
  } catch { if (provider !== 'openai-codex') return null; }
  return codexWindowShare();
}

/** The best codex account's used share from the account-window snapshot (null = unknown). */
function codexWindowShare(): number | null {
  try {
    const { readAccountWindowSnapshot } = require('../model-tier/account-window-snapshot.js') as typeof import('../model-tier/account-window-snapshot.js');
    const state = readAccountWindowSnapshot('openai-codex');
    const remaining = (state?.candidates ?? []).map(c => c.window?.remaining).filter((r): r is number => typeof r === 'number');
    return remaining.length ? 1 - Math.max(...remaining) : null;
  } catch { return null; }
}
