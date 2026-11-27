// LLM-ACCOUNT-POLICY-YAML — the ONE policy pack for LLM accounts (graphs/policies/llm-accounts.yaml ⊕ live overlay).
// S: CEO 11-27 16:2x «크레딧 허용 여부 등도 정책 YAML 로 한 번에 되게 — 고정값이 아니니까» · 16:3x «트리거 레벨이 행동을 정한다».
// C: the account policy was scattered over llm.codexQuotaPolicy · llm.codexCreditAccounts · llm.codexAccountRotation-
//    ThresholdPercentByAccount · llm.grokWeeklyCapPct · llm.openrouter.fallbackModel · llm.fallbackChain · resource facts —
//    a phase change (subscriptions full → credits → OpenRouter) needed edits in several places and a restart.
// Q: where does every consumer read the account policy, and how does a change reach a running process?
// A: this loader — repo pack (versioned) ⊕ live overlay `<state>/resource-facts/llm-accounts.yaml` (same shape, partial),
//    linted, hashed (= revision) and cached by the files' stat signature: an edit is seen on the very next read (PULL),
//    no restart. A new revision posts one `policy.changed` status on the OP context bus (the PUSH is only that signal).
//    Decisions (pack ⊕ phase/levels ⊕ overrides) are computed in llm-decide.ts — the one function every consumer calls.
//    Faces: observe = `eln policy show llm-accounts` (each value's layer · revision · warnings) · judge = `lintPack`
//    (unknown key / bad value = error, never a silent default) · heal = an invalid overlay is ignored (repo pack holds),
//    an invalid/missing pack falls back to the legacy config keys (consumers keep their old behavior).
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { debug } from '../../debug/log.js';

export const PACK_NAME = 'llm-accounts';
export const LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
export type Level = typeof LEVELS[number];
export const levelRank = (l: Level): number => LEVELS.indexOf(l);

/** Closed action vocabulary of levels, phases and overrides. */
export const PLAIN_ACTIONS = ['demote', 'skip', 'tier_down', 'credits_deny', 'credits_allow'] as const;
export type PlainAction = typeof PLAIN_ACTIONS[number];
export type LevelAction = PlainAction | `fallback:${number}` | `mode:${string}`;
export function isLevelAction(v: unknown, phases?: readonly string[]): v is LevelAction {
  if (typeof v !== 'string') return false;
  if ((PLAIN_ACTIONS as readonly string[]).includes(v)) return true;
  if (/^fallback:\d+$/u.test(v)) return true;
  const m = /^mode:([a-z0-9-]+)$/u.exec(v);
  return !!m && (!phases || phases.includes(m[1]!) || m[1] === 'normal');
}

/** May this account go on with paid credits once its subscription window is full? `until_reset` = yes, but only while
 *  its subscription stays exhausted (level L3) — the moment the window resets it is back to subscription only. */
export type CreditsRule = boolean | 'until_reset';
/** In which order accounts allowed to spend credits are used: the most credit left first, or the pack's account order. */
export const CREDIT_ORDERS = ['by_balance_desc', 'listed'] as const;
export type CreditOrder = typeof CREDIT_ORDERS[number];

/** What an account may serve. Absent = every use; `{ review: false }` = never for review (CEO: no GLM review). */
export const LLM_USES = ['implementation', 'review', 'judge', 'chat'] as const;
export type LlmUse = typeof LLM_USES[number];

export interface AccountPolicy {
  /** Rotate away at this used % of the subscription window; null = no subscription window (prepaid only, e.g. OpenRouter). */
  readonly capPercent: number | null;
  readonly uses: Readonly<Record<LlmUse, boolean>>;
  readonly credits: CreditsRule;
  readonly dailyCreditBudget: number | null;
  readonly creditFloor: number | null;
}
export interface ProviderPolicy {
  readonly order: readonly string[];
  readonly accounts: Readonly<Record<string, AccountPolicy>>;
  readonly weeklyCapPercent: number | null;
  readonly fallbackModel: string | null;
  readonly creditOrder: CreditOrder;
}
export interface Watermark { readonly below: number | null; readonly exitAt: number }
/** `<resource><op><level>` (resource = `<provider>:<account>` or `<provider>:<account>:credits`) or a named flag. */
export type Condition =
  | { readonly kind: 'level'; readonly resource: string; readonly op: '>=' | '<=' | '='; readonly level: Level; readonly text: string }
  | { readonly kind: 'flag'; readonly flag: 'maintenance_window'; readonly text: string };
export interface PhaseSet {
  readonly credits?: Readonly<Record<string, boolean>>;
  readonly skip?: readonly string[];
  readonly fallbackIndex?: number;
  readonly implementation?: 'normal' | 'throttled';
}
export interface PhaseRule { readonly name: string; readonly when: readonly Condition[]; readonly set: PhaseSet; readonly requiresCeo: boolean; readonly why: string | null }
export interface LlmAccountPack {
  readonly version: 1;
  readonly providers: Readonly<Record<string, ProviderPolicy>>;
  readonly fallback: readonly string[];
  readonly levels: {
    readonly dwellMin: number;
    readonly watermarks: Readonly<Record<'L1' | 'L2' | 'L3', Watermark>>;
    readonly actions: Readonly<Partial<Record<Level, readonly LevelAction[]>>>;
    readonly creditActions: Readonly<Partial<Record<Level, readonly LevelAction[]>>>;
  };
  readonly phases: readonly PhaseRule[];
  readonly overrides: { readonly defaultHours: number };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const pct = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const nonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);
const FALLBACK_STEP_NAMES = ['codex-rotate', 'grok', 'zai', 'claude-pty', 'openrouter', 'codex-credits']; // = oauth/fallback-chain FALLBACK_STEPS
const RESOURCE_RE = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*(?::credits)?$/u;
export const isResourceId = (v: unknown): v is string => typeof v === 'string' && RESOURCE_RE.test(v);

function unknownKeys(node: Obj, allowed: readonly string[], path: string, errors: string[]): void {
  for (const k of Object.keys(node)) if (!allowed.includes(k)) errors.push(`unknown field ${path}.${k}`);
}

export function parseCondition(text: unknown): Condition | null {
  if (text === 'maintenance_window') return { kind: 'flag', flag: 'maintenance_window', text };
  if (typeof text !== 'string') return null;
  const m = /^([a-z0-9][a-z0-9._:-]*?)(>=|<=|=)(L[0-3])$/u.exec(text.trim());
  if (!m || !isResourceId(m[1])) return null;
  return { kind: 'level', resource: m[1]!, op: m[2] as '>=' | '<=' | '=', level: m[3] as Level, text: text.trim() };
}

/** Pure: raw (merged) YAML object → pack, or the list of errors. Unknown fields and bad values are errors. */
export function lintPack(raw: unknown): { pack: LlmAccountPack | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw)) return { pack: null, errors: ['pack must be a mapping'], warnings };
  unknownKeys(raw, ['version', 'providers', 'fallback', 'levels', 'phases', 'overrides'], 'pack', errors);
  if (raw.version !== 1) errors.push('pack.version must be 1');
  const providers: Record<string, ProviderPolicy> = {};
  if (!isObj(raw.providers)) errors.push('pack.providers must be a mapping');
  else for (const [p, node] of Object.entries(raw.providers)) {
    const path = `providers.${p}`;
    if (!isObj(node)) { errors.push(`${path} must be a mapping`); continue; }
    unknownKeys(node, ['order', 'accounts', 'weekly_cap_percent', 'fallback_model', 'credit_order'], path, errors);
    if (node.credit_order !== undefined && !(CREDIT_ORDERS as readonly unknown[]).includes(node.credit_order)) errors.push(`${path}.credit_order must be ${CREDIT_ORDERS.join('|')}`);
    const accounts: Record<string, AccountPolicy> = {};
    if (node.accounts !== undefined && !isObj(node.accounts)) errors.push(`${path}.accounts must be a mapping`);
    for (const [a, row] of Object.entries(isObj(node.accounts) ? node.accounts : {})) {
      const ap = `${path}.accounts.${a}`;
      if (!isObj(row)) { errors.push(`${ap} must be a mapping`); continue; }
      unknownKeys(row, ['subscription_cap_percent', 'credits', 'daily_credit_budget', 'credit_floor', 'uses'], ap, errors);
      if (row.subscription_cap_percent !== undefined && row.subscription_cap_percent !== null && !pct(row.subscription_cap_percent)) errors.push(`${ap}.subscription_cap_percent must be 0..100 (or null = no subscription window)`);
      const uses: Record<LlmUse, boolean> = { implementation: true, review: true, judge: true, chat: true };
      if (row.uses !== undefined) {
        if (!isObj(row.uses)) errors.push(`${ap}.uses must map ${LLM_USES.join('|')} → true|false`);
        else for (const [u, v] of Object.entries(row.uses)) {
          if (!(LLM_USES as readonly string[]).includes(u)) errors.push(`unknown field ${ap}.uses.${u} (${LLM_USES.join('|')})`);
          else if (typeof v !== 'boolean') errors.push(`${ap}.uses.${u} must be true|false`);
          else uses[u as LlmUse] = v;
        }
      }
      if (row.credits !== undefined && typeof row.credits !== 'boolean' && row.credits !== 'until_reset') errors.push(`${ap}.credits must be true|false|until_reset`);
      for (const k of ['daily_credit_budget', 'credit_floor'] as const) if (row[k] !== undefined && row[k] !== null && !nonNeg(row[k])) errors.push(`${ap}.${k} must be a number ≥ 0`);
      if ((row.credits === true || row.credits === 'until_reset') && (row.daily_credit_budget === undefined || row.daily_credit_budget === null)) warnings.push(`${ap} spends credits with no daily_credit_budget — no safety stop but the balance`);
      accounts[a] = {
        capPercent: row.subscription_cap_percent === null ? null : pct(row.subscription_cap_percent) ? row.subscription_cap_percent : 100,
        uses,
        credits: row.credits === 'until_reset' ? 'until_reset' : row.credits === true,
        dailyCreditBudget: nonNeg(row.daily_credit_budget) ? row.daily_credit_budget : null,
        creditFloor: nonNeg(row.credit_floor) ? row.credit_floor : null,
      };
    }
    const order = node.order === undefined ? Object.keys(accounts) : strList(node.order) ? node.order : (errors.push(`${path}.order must be a list of account names`), []);
    if (new Set(order).size !== order.length) errors.push(`${path}.order has duplicates`);
    for (const a of order) if (!accounts[a]) errors.push(`${path}.order names ${a}, which has no accounts.${a} row`);
    if (node.weekly_cap_percent !== undefined && !pct(node.weekly_cap_percent)) errors.push(`${path}.weekly_cap_percent must be 0..100`);
    if (node.fallback_model !== undefined && !str(node.fallback_model)) errors.push(`${path}.fallback_model must be a model id`);
    providers[p] = { order, accounts, weeklyCapPercent: pct(node.weekly_cap_percent) ? node.weekly_cap_percent : null, fallbackModel: str(node.fallback_model) ? node.fallback_model : null,
      creditOrder: node.credit_order === 'listed' ? 'listed' : 'by_balance_desc' };
  }
  const fallback = raw.fallback === undefined ? [] : strList(raw.fallback) ? raw.fallback : (errors.push('pack.fallback must be a list of fallback steps'), []);
  for (const s of fallback) if (!FALLBACK_STEP_NAMES.includes(s)) errors.push(`pack.fallback step ${s} is unknown (${FALLBACK_STEP_NAMES.join('|')})`);
  if (new Set(fallback).size !== fallback.length) errors.push('pack.fallback has duplicates');

  const phaseNames = Array.isArray(raw.phases) ? raw.phases.map(p => (isObj(p) && str(p.name) ? p.name : '')).filter(Boolean) : [];
  const lv = isObj(raw.levels) ? raw.levels : (raw.levels === undefined ? {} : (errors.push('pack.levels must be a mapping'), {}));
  unknownKeys(lv, ['dwell_min', 'watermarks', 'actions', 'credit_actions'], 'levels', errors);
  if (lv.dwell_min !== undefined && !nonNeg(lv.dwell_min)) errors.push('levels.dwell_min must be a number ≥ 0');
  const wm: Record<string, Watermark> = { L1: { below: 30, exitAt: 35 }, L2: { below: 10, exitAt: 15 }, L3: { below: null, exitAt: 5 } };
  if (lv.watermarks !== undefined) {
    if (!isObj(lv.watermarks)) errors.push('levels.watermarks must be a mapping');
    else for (const [l, w] of Object.entries(lv.watermarks)) {
      const path = `levels.watermarks.${l}`;
      if (!['L1', 'L2', 'L3'].includes(l)) { errors.push(`unknown field ${path}`); continue; }
      if (!isObj(w)) { errors.push(`${path} must be a mapping`); continue; }
      unknownKeys(w, l === 'L3' ? ['exit_at'] : ['below', 'exit_at'], path, errors);
      if (l !== 'L3' && !pct(w.below)) errors.push(`${path}.below must be 0..100`);
      if (!pct(w.exit_at)) errors.push(`${path}.exit_at must be 0..100`);
      if (l !== 'L3' && pct(w.below) && pct(w.exit_at) && w.exit_at < w.below) errors.push(`${path}.exit_at must be ≥ below (hysteresis)`);
      wm[l] = { below: l === 'L3' ? null : pct(w.below) ? w.below : wm[l]!.below, exitAt: pct(w.exit_at) ? w.exit_at : wm[l]!.exitAt };
    }
    if (wm.L1!.below! < wm.L2!.below!) errors.push('levels.watermarks: L1.below must be ≥ L2.below');
    if (wm.L1!.exitAt < wm.L2!.exitAt || wm.L2!.exitAt < wm.L3!.exitAt) errors.push('levels.watermarks: exit_at must not rise with the level (L1.exit_at ≥ L2.exit_at ≥ L3.exit_at)');
  }
  const actionMap = (node: unknown, path: string): Partial<Record<Level, LevelAction[]>> => {
    const out: Partial<Record<Level, LevelAction[]>> = {};
    if (node === undefined) return out;
    if (!isObj(node)) { errors.push(`${path} must be a mapping`); return out; }
    for (const [l, list] of Object.entries(node)) {
      if (!(LEVELS as readonly string[]).includes(l)) { errors.push(`unknown field ${path}.${l}`); continue; }
      if (!Array.isArray(list) || !list.every(a => isLevelAction(a, phaseNames))) { errors.push(`${path}.${l} must be a list of actions (${PLAIN_ACTIONS.join('|')}|fallback:<n>|mode:<phase>)`); continue; }
      out[l as Level] = list as LevelAction[];
    }
    return out;
  };
  const actions = actionMap(lv.actions, 'levels.actions');
  const creditActions = actionMap(lv.credit_actions, 'levels.credit_actions');

  const phases: PhaseRule[] = [];
  if (raw.phases !== undefined && !Array.isArray(raw.phases)) errors.push('pack.phases must be a list');
  for (const [i, ph] of (Array.isArray(raw.phases) ? raw.phases : []).entries()) {
    const path = `phases[${i}]`;
    if (!isObj(ph)) { errors.push(`${path} must be a mapping`); continue; }
    unknownKeys(ph, ['name', 'when', 'set', 'requires_ceo', 'why'], path, errors);
    if (!str(ph.name) || !/^[a-z0-9-]+$/u.test(ph.name) || ph.name === 'normal') { errors.push(`${path}.name must be a lower-case name other than normal`); continue; }
    const when: Condition[] = [];
    if (!Array.isArray(ph.when) || !ph.when.length) errors.push(`${path}.when must be a non-empty list of conditions`);
    for (const c of Array.isArray(ph.when) ? ph.when : []) { const pc = parseCondition(c); if (pc) when.push(pc); else errors.push(`${path}.when ${JSON.stringify(c)} is not <provider>:<account>[:credits](>=|<=|=)L0..L3 or maintenance_window`); }
    const set: { -readonly [K in keyof PhaseSet]: PhaseSet[K] } = {};
    const s = ph.set === undefined ? {} : isObj(ph.set) ? ph.set : (errors.push(`${path}.set must be a mapping`), {});
    unknownKeys(s, ['credits', 'skip', 'fallback_index', 'implementation'], `${path}.set`, errors);
    if (s.credits !== undefined) {
      if (!isObj(s.credits) || !Object.entries(s.credits).every(([k, v]) => isResourceId(k) && typeof v === 'boolean')) errors.push(`${path}.set.credits must map <provider>:<account> → true|false`);
      else set.credits = s.credits as Record<string, boolean>;
    }
    if (s.skip !== undefined) { if (strList(s.skip) && s.skip.every(isResourceId)) set.skip = s.skip; else errors.push(`${path}.set.skip must be a list of <provider>:<account>`); }
    if (s.fallback_index !== undefined) { if (Number.isSafeInteger(s.fallback_index) && (s.fallback_index as number) >= 0) set.fallbackIndex = s.fallback_index as number; else errors.push(`${path}.set.fallback_index must be an integer ≥ 0`); }
    if (s.implementation !== undefined) { if (s.implementation === 'normal' || s.implementation === 'throttled') set.implementation = s.implementation; else errors.push(`${path}.set.implementation must be normal|throttled`); }
    if (ph.requires_ceo !== undefined && typeof ph.requires_ceo !== 'boolean') errors.push(`${path}.requires_ceo must be true|false`);
    phases.push({ name: ph.name, when, set, requiresCeo: ph.requires_ceo === true, why: str(ph.why) ? ph.why : null });
  }
  if (new Set(phases.map(p => p.name)).size !== phases.length) errors.push('pack.phases has duplicate names');
  const ov = raw.overrides === undefined ? {} : isObj(raw.overrides) ? raw.overrides : (errors.push('pack.overrides must be a mapping'), {});
  unknownKeys(ov, ['default_hours'], 'overrides', errors);
  if (ov.default_hours !== undefined && !(nonNeg(ov.default_hours) && (ov.default_hours as number) > 0)) errors.push('overrides.default_hours must be > 0');
  if (errors.length) return { pack: null, errors, warnings };
  return {
    pack: {
      version: 1, providers, fallback,
      levels: { dwellMin: nonNeg(lv.dwell_min) ? lv.dwell_min : 15, watermarks: wm as LlmAccountPack['levels']['watermarks'], actions, creditActions },
      phases, overrides: { defaultHours: nonNeg(ov.default_hours) && (ov.default_hours as number) > 0 ? ov.default_hours as number : 24 },
    },
    errors, warnings,
  };
}

/** Pure: deep merge (objects merge key by key, lists and scalars replace). */
export function mergeRaw(base: unknown, overlay: unknown): unknown {
  if (!isObj(base) || !isObj(overlay)) return overlay === undefined ? base : structuredClone(overlay);
  const out: Obj = structuredClone(base);
  for (const [k, v] of Object.entries(overlay)) out[k] = mergeRaw(out[k], v);
  return out;
}

const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
  : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
/** The revision id of a pack = sha256 of its canonical merged form (12 hex). */
export const packRevision = (raw: unknown): string => createHash('sha256').update(JSON.stringify(canonical(raw))).digest('hex').slice(0, 12);

// ── files ──

/** Repo pack (versioned). Env LLM_ACCOUNT_POLICY_PACK overrides the path (tests and sims point it at a temp file). */
export function packPath(): string {
  return process.env.LLM_ACCOUNT_POLICY_PACK?.trim() || join(resolve(import.meta.dir, '../../..'), 'graphs', 'policies', 'llm-accounts.yaml');
}
/** Live overlay under state — OP · RES · the guardian edit it (same shape, partial). */
export function overlayPath(): string {
  return process.env.LLM_ACCOUNT_POLICY_OVERLAY?.trim() || join(elanousStateRoot(), 'resource-facts', 'llm-accounts.yaml');
}

function readYaml(path: string): { present: boolean; raw: unknown; error: string | null } {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { present: false, raw: undefined, error: null } : { present: true, raw: undefined, error: `${path} unreadable (${code ?? String(e).slice(0, 60)})` };
  }
  try {
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length) return { present: true, raw: undefined, error: `${path}: ${doc.errors.map(x => x.message).join('; ').slice(0, 200)}` };
    return { present: true, raw: doc.toJS() ?? {}, error: null };
  } catch (e) { return { present: true, raw: undefined, error: `${path}: ${String(e).slice(0, 200)}` }; }
}

export interface LoadedPack {
  /** null = no usable pack (missing / invalid) → consumers use the legacy config keys. */
  readonly pack: LlmAccountPack | null;
  readonly revision: string | null;
  readonly packPath: string;
  readonly overlayPath: string;
  readonly overlayApplied: boolean;
  /** Which layer stated each leaf of the merged pack (`pack` | `overlay`). */
  readonly leafSources: Readonly<Record<string, 'pack' | 'overlay'>>;
  /** Latest mtime of the files that answered (the revision's «changed at»). */
  readonly changedAtMs: number;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

function leaves(v: unknown, prefix = ''): string[] {
  if (!isObj(v) || !Object.keys(v).length) return prefix ? [prefix] : [];
  return Object.entries(v).flatMap(([k, x]) => leaves(x, prefix ? `${prefix}.${k}` : k));
}

/** Pure: repo pack text ⊕ overlay → loaded pack. An invalid overlay is dropped (the repo pack holds); an invalid pack = none. */
export function buildLoaded(input: { packRaw: { present: boolean; raw: unknown; error: string | null }; overlayRaw: { present: boolean; raw: unknown; error: string | null }; packPath: string; overlayPath: string; changedAtMs: number }): LoadedPack {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { packRaw, overlayRaw } = input;
  const none = (more: string[], warn: string[] = []): LoadedPack => ({ pack: null, revision: null, packPath: input.packPath, overlayPath: input.overlayPath, overlayApplied: false, leafSources: {}, changedAtMs: input.changedAtMs, errors: [...errors, ...more], warnings: [...warnings, ...warn] });
  // The repo pack is the base: missing, unreadable or invalid → NO policy (legacy config keys), whatever the overlay says —
  // an overlay is a partial edit of a valid pack, never a pack of its own (money: no half-policy).
  if (!packRaw.present) return none([], [`repo pack missing (${input.packPath}) — consumers on the legacy config keys${overlayRaw.present ? ' · overlay not applied' : ''}`]);
  if (packRaw.error) return none([packRaw.error], overlayRaw.present ? ['overlay not applied (no valid repo pack)'] : []);
  const base = packRaw.raw;
  const baseLint = lintPack(base);
  if (!baseLint.pack) return none(baseLint.errors.map(e => `repo pack: ${e}`), overlayRaw.present ? ['overlay not applied (no valid repo pack)'] : []);
  const leafSources: Record<string, 'pack' | 'overlay'> = Object.fromEntries(leaves(base).map(l => [l, 'pack' as const]));
  let merged = base;
  let overlayApplied = false;
  if (overlayRaw.present) {
    if (overlayRaw.error) warnings.push(`overlay ignored — ${overlayRaw.error}`);
    else if (overlayRaw.raw !== null && !isObj(overlayRaw.raw)) warnings.push('overlay ignored — not a mapping');
    else {
      const candidate = mergeRaw(base, overlayRaw.raw ?? {});
      const lint = lintPack(candidate);
      if (lint.pack) { merged = candidate; overlayApplied = true; for (const l of leaves(overlayRaw.raw)) leafSources[l] = 'overlay'; }
      else warnings.push(`overlay ignored — ${lint.errors.slice(0, 3).join(' · ')}`);
    }
  }
  const lint = lintPack(merged);
  warnings.push(...lint.warnings);
  if (!lint.pack) return none(lint.errors);
  return { pack: lint.pack, revision: packRevision(merged), packPath: input.packPath, overlayPath: input.overlayPath, overlayApplied, leafSources, changedAtMs: input.changedAtMs, errors, warnings };
}

const sig = (p: string): string => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return '-'; } };
const mtime = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return 0; } };
let cache: { key: string; loaded: LoadedPack } | null = null;

/** The pack now. Cached by the files' stat signature — an edit is seen on the next read (no TTL wait, no restart). Never throws. */
export function loadLlmAccountPack(): LoadedPack {
  const pp = packPath();
  const op = overlayPath();
  // A Pod child decides with the host's EFFECTIVE values carried in its spawn snapshot (config-snapshot.json · quota env),
  // never with its image's copy of the repo pack (that copy knows no overlay, no overrides, no phase).
  if (podChild() && !process.env.LLM_ACCOUNT_POLICY_PACK?.trim()) {
    return { pack: null, revision: null, packPath: pp, overlayPath: op, overlayApplied: false, leafSources: {}, changedAtMs: 0, errors: [], warnings: ['pod child: the host decided — values come from the spawn snapshot'] };
  }
  const key = `${pp}|${sig(pp)}|${op}|${sig(op)}`;
  if (cache?.key === key) {
    // A policy.changed that could not be posted is retried on the next read (the marker was not moved).
    if (cache.loaded.revision && unannounced === cache.loaded.revision && Date.now() - lastNoticeAttempt >= NOTICE_RETRY_MS) noticeRevision(cache.loaded);
    return cache.loaded;
  }
  let loaded: LoadedPack;
  try {
    loaded = buildLoaded({ packRaw: readYaml(pp), overlayRaw: readYaml(op), packPath: pp, overlayPath: op, changedAtMs: Math.max(mtime(pp), mtime(op)) });
  } catch (e) {
    loaded = { pack: null, revision: null, packPath: pp, overlayPath: op, overlayApplied: false, leafSources: {}, changedAtMs: 0, errors: [`loader failed (${String(e).slice(0, 80)})`], warnings: [] };
  }
  const prev = cache?.loaded.revision;
  cache = { key, loaded };
  for (const msg of [...loaded.errors, ...loaded.warnings]) {
    try { debug.log('llm-policy', 'pack-warning', { pack: PACK_NAME, msg: msg.slice(0, 200) }, { level: 'warn' }); } catch { /* observation only */ }
  }
  if (loaded.revision && loaded.revision !== prev) { unannounced = loaded.revision; noticeRevision(loaded); }
  return loaded;
}

/** Running as a Pod child (the launcher sets these — pod-command-job / self-implement-pod). */
export const podChild = (env: NodeJS.ProcessEnv = process.env): boolean => env.ELANOUS_SUBSTRATE === 'pod' || !!env.ELANOUS_POD_NAME?.trim();

/** Tests / sims: forget the cached pack. */
export function resetLlmAccountPackCache(): void { cache = null; unannounced = null; lastNoticeAttempt = 0; }

/** The revision this process saw but has not announced yet (null = nothing owed). */
let unannounced: string | null = null;
/** A claim older than this belongs to a process that died mid-post — it is broken and the post retried. */
export const CLAIM_STALE_MS = 60_000;

/** `policy.changed` — the one PUSH: the first process to see a revision the state has not announced yet takes the one
 *  announcement claim (O_EXCL — concurrent readers never double-post; announcements of different revisions serialize),
 *  re-checks that revision is still the one on disk, posts one status line to the OP context bus, and only
 *  then moves the marker (tmp+rename). A failed post releases the claim and is retried on the next read. The first
 *  revision a state ever sees is adoption (marker only, no bus line). The values themselves are always PULLed. */
const NOTICE_RETRY_MS = 30_000;
let lastNoticeAttempt = 0;
function noticeRevision(loaded: LoadedPack): void {
  const rev = loaded.revision!;
  lastNoticeAttempt = Date.now();
  let claim: string | null = null;
  try {
    const dir = join(elanousStateRoot(), 'resource-facts');
    const marker = join(dir, `${PACK_NAME}.revision`);
    const last = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '';
    if (last === rev) { unannounced = null; return; }
    mkdirSync(dir, { recursive: true });
    // ONE claim for every revision: announcements are serialized, so an older revision finishing late can never move the
    // marker back or post a stale policy.changed.
    claim = join(dir, `${PACK_NAME}.notice.claim`);
    try { const fd = openSync(claim, 'wx'); closeSync(fd); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Someone else is posting this revision — unless its claim is stale (that process died): break it and retry next read.
      try { if (Date.now() - statSync(claim).mtimeMs > CLAIM_STALE_MS) rmSync(claim, { force: true }); } catch { /* */ }
      claim = null;
      return;
    }
    const latest = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '';
    if (latest === rev) { unannounced = null; return; } // announced between our read and our claim
    // Still the revision on disk? (a newer edit landed meanwhile → that one is announced by whoever reads it)
    const onDisk = buildLoaded({ packRaw: readYaml(packPath()), overlayRaw: readYaml(overlayPath()), packPath: packPath(), overlayPath: overlayPath(), changedAtMs: 0 }).revision;
    if (onDisk !== rev) { unannounced = null; return; }
    if (latest) {
      const { busPost } = require('../../op-context-bus/bus.js') as typeof import('../../op-context-bus/bus.js');
      busPost(elanousStateRoot(), {
        type: 'status', from: 'GUARDIAN', source: 'policy',
        body: `policy.changed ${PACK_NAME} rev ${rev} (was ${latest})${loaded.overlayApplied ? ' · live overlay applied' : ''} — consumers re-read on their next decision; \`eln policy show ${PACK_NAME}\``,
        refs: [`policy:${PACK_NAME}`, `rev:${rev}`],
      });
    }
    const tmp = `${marker}.${process.pid}.tmp`;
    writeFileSync(tmp, `${rev}\n`);
    renameSync(tmp, marker);
    unannounced = null;
    debug.log('llm-policy', 'policy.changed', { pack: PACK_NAME, revision: rev, from: latest || null, overlay: loaded.overlayApplied, posted: !!latest });
  } catch (e) {
    try { debug.log('llm-policy', 'policy.changed-post-failed', { revision: rev, error: String(e).slice(0, 160) }, { level: 'warn' }); } catch { /* */ }
  } finally {
    if (claim) { try { rmSync(claim, { force: true }); } catch { /* */ } }
  }
}
