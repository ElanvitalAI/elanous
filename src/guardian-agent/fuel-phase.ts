// LLM-PHASE-BY-GUARDIAN — the 연료관 judges trigger levels and the phase; consumers only read its ONE ledger fact.
// S: CEO 11-27 16:2x «국면 전환이 필요할 때 누가 컨트롤하고 어떻게 리스닝?» · 16:3x «트리거 레벨(워터마크·히스테리시스·
//    최소 체류) → 행동 · 사용자 개입과 자동 둘 다 · 자동 오버라이드는 수호자 몫 · 충돌은 일지».
// C: every consumer used to evaluate «is this account full» on its own numbers at its own time; nobody owned the phase,
//    nothing kept a level from flapping around a watermark, and money-increasing moves had no stop.
// Q: who evaluates levels and phases, when, and how do consumers learn the result?
// A: the guardian 연료관 — on every pulse tick the body runs `planFuelPhase` (pure, LLM 0) over the usage snapshot ⊕ credit
//    balances ⊕ maintenance window ⊕ the previous `llm-state`; a change is a world event (`fuel-level`) that spawns the
//    연료관, which writes ONE `llm-state` fact (levels with since · phase with since · pending phase), sets/clears its own
//    auto overrides (credit balance ≤ floor → credits_deny), raises a 대표 money card for a phase no YAML budget bounds
//    (never automatic), and journals transitions and override conflicts (→ OP's 30-min digest line).
//    Faces: observe = `eln policy explain llm-accounts` (levels · phase · pending) · journal `guardian` rows (level ·
//    phase · auto-override · conflict · stale-consumer) · judge = `nextLevel` (hysteresis ⊕ dwell) · `pickPhase` ·
//    heal = levels return on their own as usage resets; guardian overrides clear themselves when the balance recovers;
//    user/OP/CEO overrides are never touched before they expire.
import type { LlmStateEvent } from '../resource-ledger/llm-policy-events.js';
import { levelRank, LEVELS, type Condition, type Level, type LlmAccountPack, type PhaseRule } from '../kit/resource-facts/llm-accounts.js';
import type { UsageAccount } from './fuel.js';

/** Prepaid balances the usage snapshot already carries (`leftUsd` — OpenRouter) as `<provider>:<account>` → balance. */
export function prepaidBalances(usage: readonly UsageAccount[] | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of usage ?? []) if (u.status === 'ok' && typeof u.leftUsd === 'number' && Number.isFinite(u.leftUsd)) out[`${packProvider(u.provider)}:${u.account}`] = u.leftUsd;
  return out;
}

/** Usage-snapshot provider names → pack provider names (the snapshot says `codex`). */
export const USAGE_TO_PACK_PROVIDER: Readonly<Record<string, string>> = { codex: 'openai-codex' };
const packProvider = (p: string): string => USAGE_TO_PACK_PROVIDER[p] ?? p;

type LevelRow = LlmStateEvent['levels'][string];

/** Pure: one resource's next level — enter at the watermark, leave only past exit_at (hysteresis), and stay at least
 *  `dwellMs` in a level before moving again — except into L3 (exhausted is a fact, not a trend). Unknown = unchanged. */
export function nextLevel(prev: LevelRow | undefined, remaining: number | null, exhausted: boolean, wm: LlmAccountPack['levels']['watermarks'], dwellMs: number, now: Date): LevelRow {
  const at = now.toISOString();
  const cur: Level = prev?.level ?? 'L0';
  if (remaining === null && !exhausted) return prev ?? { level: 'L0', since: at, remainingPercent: null };
  const r = remaining ?? 0;
  let target: Level;
  if (exhausted || r <= 0) target = 'L3';
  else {
    const enter: Level = r < wm.L2.below! ? 'L2' : r < wm.L1.below! ? 'L1' : 'L0';
    if (levelRank(enter) > levelRank(cur)) target = enter;
    else {
      let t = cur;
      while (t !== 'L0' && levelRank(t) > levelRank(enter) && r >= wm[t as 'L1' | 'L2' | 'L3'].exitAt) t = LEVELS[levelRank(t) - 1]!;
      target = t;
    }
  }
  const remainingPercent = remaining === null ? null : Math.round(r * 10) / 10;
  if (target === cur) return { level: cur, since: prev?.since ?? at, remainingPercent };
  const dwelt = prev ? now.getTime() - Date.parse(prev.since) : Number.POSITIVE_INFINITY;
  if (target !== 'L3' && dwelt < dwellMs) return { level: cur, since: prev!.since, remainingPercent };
  return { level: target, since: at, remainingPercent };
}

/** Pure: credit level of `<id>:credits` — balance ≤ floor → L3 · spent today ≥ daily budget → L2 · else L0 (no dwell:
 *  these are the YAML safety stops). Unknown balance = unchanged. */
export function creditLevel(prev: LevelRow | undefined, balance: number | null, spentToday: number | null, floor: number | null, budget: number | null, now: Date): LevelRow {
  const at = now.toISOString();
  if (balance === null) return prev ?? { level: 'L0', since: at, remainingPercent: null };
  const target: Level = floor !== null && balance <= floor ? 'L3' : budget !== null && spentToday !== null && spentToday >= budget ? 'L2' : 'L0';
  return target === prev?.level ? prev : { level: target, since: at, remainingPercent: null };
}

/** Pure: does a condition hold over the levels? */
export function conditionHolds(c: Condition, levels: Readonly<Record<string, LevelRow>>, maintenance: boolean): boolean {
  if (c.kind === 'flag') return maintenance;
  const l = levels[c.resource]?.level ?? 'L0';
  const a = levelRank(l); const b = levelRank(c.level);
  return c.op === '>=' ? a >= b : c.op === '<=' ? a <= b : a === b;
}

/** A phase spends money no YAML budget bounds: marked requires_ceo, or it turns credits on for an account with no daily budget. */
export function phaseNeedsCeo(rule: PhaseRule, pack: LlmAccountPack): string | null {
  if (rule.requiresCeo) return `phase ${rule.name} is marked requires_ceo`;
  for (const [id, on] of Object.entries(rule.set.credits ?? {})) {
    if (!on) continue;
    const [p, a] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    if (pack.providers[p]?.accounts[a]?.dailyCreditBudget == null) return `phase ${rule.name} turns credits on for ${id}, which has no daily_credit_budget`;
  }
  return null;
}

export interface PhasePick { readonly phase: string; readonly since: string; readonly pending: string | null; readonly why: string }

/** Pure: the phase — first rule (top → bottom) whose conditions all hold; a phase needing 대표 without a CEO `mode:` approval
 *  is held as `pending` and the next matching one is taken; moving to a LESS severe phase waits out dwell_min. */
export function pickPhase(pack: LlmAccountPack, levels: Readonly<Record<string, LevelRow>>, maintenance: boolean, prev: { phase: string; since: string } | null, ceoApproved: readonly string[], now: Date): PhasePick {
  const at = now.toISOString();
  const severity = (name: string) => { const i = pack.phases.findIndex(p => p.name === name); return i < 0 ? pack.phases.length : i; };
  let pending: string | null = null;
  let target = 'normal'; let why = 'no phase condition holds';
  for (const rule of pack.phases) {
    if (!rule.when.every(c => conditionHolds(c, levels, maintenance))) continue;
    const ceo = phaseNeedsCeo(rule, pack);
    if (ceo && !ceoApproved.includes(rule.name)) { pending ??= rule.name; continue; }
    target = rule.name; why = `${rule.when.map(c => c.text).join(' ∧ ')}${rule.why ? ` — ${rule.why}` : ''}`;
    break;
  }
  if (!prev) return { phase: target, since: at, pending, why };
  if (target === prev.phase) return { phase: prev.phase, since: prev.since, pending, why };
  const relaxing = severity(target) > severity(prev.phase);
  // A phase that NOW needs the CEO (a policy edit removed its budget) and has no CEO approval is left at once — the
  // dwell never keeps unbudgeted spending going.
  const prevRule = pack.phases.find(p => p.name === prev.phase);
  const prevGated = !!prevRule && !!phaseNeedsCeo(prevRule, pack) && !ceoApproved.includes(prev.phase);
  if (relaxing && !prevGated && now.getTime() - Date.parse(prev.since) < pack.levels.dwellMin * 60_000) {
    return { phase: prev.phase, since: prev.since, pending, why: `wants ${target} (${why}) — holds ${prev.phase} for dwell ${pack.levels.dwellMin}m` };
  }
  return { phase: target, since: at, pending, why };
}

export interface FuelPhaseInput {
  readonly pack: LlmAccountPack;
  readonly revision: string | null;
  readonly prev: LlmStateEvent | null;
  /** The usage snapshot rows (`<state>/status/llm-usage.json`) — null = none. */
  readonly usage: readonly UsageAccount[] | null;
  /** Measured credit balances `<provider>:<account>` → balance (null/absent = unknown). */
  readonly credits: Readonly<Record<string, number | null>>;
  /** Accounts whose provider said quota reached (counts as exhausted). */
  readonly reached?: ReadonlySet<string>;
  readonly maintenance: boolean;
  /** Phases a CEO `mode:<phase>` override currently approves. */
  readonly ceoApproved: readonly string[];
  readonly now: Date;
  /** The operator's day of `now` (credit budgets are per day). */
  readonly day: string;
}
export interface Transition { readonly kind: 'level' | 'phase' | 'pending'; readonly target: string; readonly from: string; readonly to: string; readonly why: string }
export interface FuelPhasePlan {
  readonly state: LlmStateEvent;
  /** Something a consumer would decide differently on (a level, the phase, pending) — or the state is due a refresh. */
  readonly changed: boolean;
  readonly transitions: readonly Transition[];
  /** Credit resources at L3 (balance ≤ floor) — the guardian holds a credits_deny override on each. */
  readonly floorBreached: ReadonlyArray<{ readonly resource: string; readonly why: string }>;
  /** Subscription accounts with no usage fact this pass — their level holds the last known value (warned, never invented). */
  readonly noFact: readonly string[];
}

/** The state is rewritten at least this often even when nothing moved (consumers see a fresh `stateAt`). */
export const STATE_REFRESH_MS = 30 * 60_000;

/** Pure: the whole evaluation. */
export function planFuelPhase(input: FuelPhaseInput): FuelPhasePlan {
  const { pack, prev, now } = input;
  const at = now.toISOString();
  const dwellMs = pack.levels.dwellMin * 60_000;
  const creditStep = (cid: string): number => {
    const [p, a] = cid.replace(/:credits$/u, '').split(':') as [string, string];
    return Math.max(1, (pack.providers[p]?.accounts[a]?.dailyCreditBudget ?? 0) / 100);
  };
  const usageOf = (provider: string, account: string) => (input.usage ?? []).find(u => packProvider(u.provider) === provider && u.account === account && u.status === 'ok');
  const levels: Record<string, LevelRow> = {};
  const credits: NonNullable<LlmStateEvent['credits']> = {};
  const floorBreached: Array<{ resource: string; why: string }> = [];
  const noFact: string[] = [];
  for (const [provider, pp] of Object.entries(pack.providers)) {
    for (const [account, ap] of Object.entries(pp.accounts)) {
      const id = `${provider}:${account}`;
      const u = usageOf(provider, account);
      const used = typeof u?.usedPercent === 'number' ? u.usedPercent : null;
      if (ap.capPercent === null) {
        // No subscription window (prepaid only): the level is the credit level below; the subscription level stays L0.
        levels[id] = prev?.levels[id] ?? { level: 'L0', since: at, remainingPercent: null };
      } else {
        // No usage fact for a subscription account → the level holds its last known value and the pass warns.
        if (used === null) noFact.push(id);
        levels[id] = nextLevel(prev?.levels[id], used === null ? null : ap.capPercent - used, input.reached?.has(id) ?? false, pack.levels.watermarks, dwellMs, now);
      }
      if (!ap.credits && ap.dailyCreditBudget === null && ap.creditFloor === null) continue;
      const cid = `${id}:credits`;
      const bal = input.credits[id] ?? null;
      const before = prev?.credits?.[cid];
      let spent: number | null = null;
      if (bal !== null) {
        // The day's spend = the sum of every drop between samples (conservative: a rise — a top-up or noise — never
        // reduces it, so 30 000 → 29 900 → 30 000 counts 100). A new day starts at 0. `startBalance` is informational:
        // it moves up by a rise larger than the 1 % step (a real top-up).
        if (before && before.day === input.day) {
          const prevSpent = typeof before.spent === 'number' ? before.spent : Math.max(0, before.startBalance - before.balance);
          const drop = before.balance - bal;
          spent = prevSpent + Math.max(0, drop);
          const start = before.startBalance + (-drop > creditStep(cid) ? -drop : 0);
          credits[cid] = { day: input.day, startBalance: start, balance: bal, spent };
        } else {
          spent = 0;
          credits[cid] = { day: input.day, startBalance: bal, balance: bal, spent: 0 };
        }
      } else if (before) credits[cid] = before;
      levels[cid] = creditLevel(prev?.levels[cid], bal, spent, ap.creditFloor, ap.dailyCreditBudget, now);
      if (levels[cid]!.level === 'L3') floorBreached.push({ resource: cid, why: `credit balance ${bal ?? '?'} ≤ floor ${ap.creditFloor}` });
    }
  }
  const ph = pickPhase(pack, levels, input.maintenance, prev ? { phase: prev.phase, since: prev.phaseSince } : null, input.ceoApproved, now);
  const transitions: Transition[] = [];
  for (const [id, row] of Object.entries(levels)) {
    const was = prev?.levels[id]?.level ?? 'L0';
    if (row.level !== was) transitions.push({ kind: 'level', target: id, from: was, to: row.level, why: id.endsWith(':credits')
      ? `credit balance ${credits[id]?.balance ?? '?'} (spent today ${credits[id]?.spent ?? '?'})`
      : `remaining ${row.remainingPercent ?? '?'}% of the subscription window` });
  }
  if ((prev?.phase ?? 'normal') !== ph.phase) transitions.push({ kind: 'phase', target: 'llm-accounts', from: prev?.phase ?? 'normal', to: ph.phase, why: ph.why });
  // A pending phase appearing AND clearing are both state changes (a stale pending must not stay in the ledger).
  if ((prev?.pendingPhase ?? null) !== ph.pending) transitions.push({ kind: 'pending', target: 'llm-accounts', from: prev?.pendingPhase ?? '-', to: ph.pending ?? '-',
    why: ph.pending ? 'needs the CEO — spends money no YAML budget bounds' : 'no longer pending (approved, or the rules no longer want it)' });
  const state: LlmStateEvent = { event: 'llm-state', at, by: 'GUARDIAN', revision: input.revision, phase: ph.phase, phaseSince: ph.since,
    pendingPhase: ph.pending, levels, maintenance: input.maintenance, ...(Object.keys(credits).length ? { credits } : {}) };
  // The day's start balance must be kept (spent = start − now), so a new day / first sighting / top-up is a change too.
  // Every balance change is kept (the next sample's drop is measured against it — no spend may slip between samples).
  const dayMoved = Object.entries(credits).some(([k, c]) => prev?.credits?.[k]?.day !== c.day || prev.credits[k]!.balance !== c.balance);
  const stale = !prev || now.getTime() - Date.parse(prev.at) >= STATE_REFRESH_MS || prev.revision !== input.revision || dayMoved;
  return { state, changed: transitions.length > 0 || stale, transitions, floorBreached, noFact };
}
