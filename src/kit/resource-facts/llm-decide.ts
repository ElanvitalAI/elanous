// LLM-ACCOUNT-POLICY — the ONE decision every consumer uses: policy pack ⊕ level/phase (guardian ledger fact) ⊕ overrides.
// S: CEO 11-27 16:3x «정책 ⊕ 레벨/국면 ⊕ 오버라이드를 한 함수로 · 모든 소비자가 같은 함수 · explain 으로 사슬을 보여 달라».
// C: the router, codex rotation, credit allow list, Pod snapshot and budget gate each read their own switch; a CEO «no credits»
//    or a guardian «balance under floor» had no place to live that all of them would honor, nor an expiry.
// Q: how are policy, live levels and human/automatic interventions combined, and how does anyone see why?
// A: `decideLlmAccounts` (pure) builds, per knob (credits · skip · demote · tier_down per account; phase · fallback index ·
//    implementation globally), a list of CLAIMS from every layer and takes the highest rank — CEO 60 > safety 50 (YAML hard
//    stops: credit budget/floor levels, deny only) > OP/RES 40 > GUARDIAN auto 30 > phase 20 > level action 10 > pack 0;
//    equal rank → newest. The losing claims stay in the chain (`explainLines`) and disagreeing interventions are reported
//    as conflicts (the guardian journals them). Every override expires (until · or until_event «reset:<resources>»).
//    Faces: observe = `eln policy explain llm-accounts [--account x]` · applied-revision reports (`applied/<consumer>.json`)
//    · judge = this function + `staleConsumers` · heal = an expired override drops out on the next read (back to policy).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { debug } from '../../debug/log.js';
import type { LlmOverrideSet, LlmPolicyLedgerEvent, LlmStateEvent, OverrideActor } from '../../resource-ledger/llm-policy-events.js';
import { loadLlmAccountPack, PACK_NAME, type Level, type LevelAction, type LlmAccountPack, type LoadedPack } from './llm-accounts.js';

export type ClaimLayer = 'CEO' | 'safety' | 'OP' | 'RES' | 'GUARDIAN' | 'phase' | 'level' | 'pack';
export const LAYER_RANK: Readonly<Record<ClaimLayer, number>> = { CEO: 60, safety: 50, OP: 40, RES: 40, GUARDIAN: 30, phase: 20, level: 10, pack: 0 };
export interface Claim<V> { readonly value: V; readonly layer: ClaimLayer; readonly why: string; readonly at?: string; readonly overrideId?: string; readonly until?: string }
export interface Knob<V> { readonly value: V; readonly winner: Claim<V> | null; readonly claims: readonly Claim<V>[] }

export interface AccountDecision {
  readonly id: string;
  readonly provider: string;
  readonly account: string;
  readonly capPercent: number | null;
  /** The uses this account may serve (pack `uses` · absent = all). */
  readonly uses: Readonly<Record<string, boolean>>;
  readonly level: Level;
  readonly creditLevel: Level;
  readonly credits: Knob<boolean>;
  readonly skip: Knob<boolean>;
  readonly demote: Knob<boolean>;
  readonly tierDown: Knob<boolean>;
  /** Routable at all: subscription not skipped, or credits allowed. */
  readonly routable: boolean;
  /** Its SUBSCRIPTION may be routed (not skipped). A skipped account with credits allowed goes on the credits path only. */
  readonly subscriptionRoutable: boolean;
  /** Effective rotate-away threshold: cap, or 0 when skipped without credits. */
  readonly rotateAtPercent: number;
}
export interface Conflict { readonly knob: string; readonly scope: string; readonly winner: string; readonly loser: string }
export interface LlmAccountDecision {
  readonly pack: string;
  /** null = no usable pack — consumers fall back to their legacy config keys. */
  readonly revision: string | null;
  readonly phase: Knob<string> & { readonly since: string | null; readonly pending: string | null };
  readonly fallbackIndex: Knob<number>;
  readonly implementation: Knob<'normal' | 'throttled'>;
  readonly accounts: readonly AccountDecision[];
  /** Effective route order per provider (demoted accounts later; unroutable ones dropped). */
  readonly route: Readonly<Record<string, readonly string[]>>;
  /** LLM-POLICY-CREDIT-MIX-YAML — per provider, the accounts that may spend credits now, in the pack's credit_order
   *  (by_balance_desc = most credit left first, from the guardian's last balance sample · listed = the pack order). */
  readonly creditRoute: Readonly<Record<string, { readonly order: string; readonly accounts: readonly string[] }>>;
  readonly fallback: readonly string[];
  readonly grokWeeklyCapPercent: number | null;
  readonly fallbackModel: string | null;
  readonly overrides: { readonly active: readonly LlmOverrideSet[]; readonly expired: readonly { readonly o: LlmOverrideSet; readonly why: string }[] };
  readonly conflicts: readonly Conflict[];
  readonly stateAt: string | null;
  readonly decidedAt: string;
  /** When the ledger (overrides · guardian state) was last read — another process's intervention shows within LEDGER_TTL_MS. */
  readonly ledgerReadAt: string | null;
  readonly warnings: readonly string[];
}

// ── overrides ──

/** Pure: fold the ledger's override events → active ⊕ expired (cleared, past until, until_event seen). */
export function foldOverrides(events: readonly LlmPolicyLedgerEvent[], state: LlmStateEvent | null, now: Date): { active: LlmOverrideSet[]; expired: Array<{ o: LlmOverrideSet; why: string }> } {
  const sets = new Map<string, LlmOverrideSet>();
  const cleared = new Map<string, { by: OverrideActor; at: string; why: string }>();
  for (const e of events) {
    if (e.event !== 'llm-override') continue;
    if (e.op === 'set') { sets.set(e.id, e); cleared.delete(e.id); } else cleared.set(e.id, { by: e.by, at: e.at, why: e.why });
  }
  const active: LlmOverrideSet[] = [];
  const expired: Array<{ o: LlmOverrideSet; why: string }> = [];
  for (const o of sets.values()) {
    const c = cleared.get(o.id);
    if (c) { expired.push({ o, why: `cleared by ${c.by} ${c.at} (${c.why})` }); continue; }
    if (Date.parse(o.until) <= now.getTime()) { expired.push({ o, why: `until ${o.until} passed` }); continue; }
    if (o.untilEvent) {
      // Once seen, gone for good: ANY guardian state after the override in which every named resource was back at L0
      // (since after the override) expires it — a level rising again later does not revive it.
      const ids = o.untilEvent.slice('reset:'.length).split(',');
      const seenIn = (st: LlmStateEvent) => ids.every(r => { const l = st.levels[r]; return !!l && l.level === 'L0' && Date.parse(l.since) > Date.parse(o.at); });
      const history = events.filter((e): e is LlmStateEvent => e.event === 'llm-state' && Date.parse(e.at) > Date.parse(o.at));
      const hit = history.find(seenIn) ?? (state && Date.parse(state.at) > Date.parse(o.at) && seenIn(state) ? state : null);
      if (hit) { expired.push({ o, why: `${o.untilEvent} seen at ${hit.at} (all back at L0)` }); continue; }
    }
    active.push(o);
  }
  return { active, expired };
}

/** Does an override's scope reach account `id` for this knob? `<provider>:<account>:credits` reaches the credits knob only —
 *  never the account's subscription routing (skip · demote · tier_down). */
const scopeMatches = (scope: string, id: string, knob: 'credits' | 'routing'): boolean => {
  if (scope === '*') return true;
  if (scope === id || scope === id.split(':')[0]) return true;
  return knob === 'credits' && scope === `${id}:credits`;
};

function pick<V>(claims: Claim<V>[], fallback: V): Knob<V> {
  if (!claims.length) return { value: fallback, winner: null, claims: [] };
  const sorted = [...claims].sort((a, b) => LAYER_RANK[b.layer] - LAYER_RANK[a.layer] || (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0));
  return { value: sorted[0]!.value, winner: sorted[0]!, claims: sorted };
}

const overrideClaim = <V>(o: LlmOverrideSet, value: V): Claim<V> => ({
  value, layer: o.by, why: `override by ${o.by} until ${o.until}${o.untilEvent ? ` or ${o.untilEvent}` : ''} («${o.why}»)`, at: o.at, overrideId: o.id, until: o.until,
});

export interface DecideInput {
  readonly loaded: LoadedPack;
  readonly state: LlmStateEvent | null;
  readonly events: readonly LlmPolicyLedgerEvent[];
  readonly now: Date;
  readonly ledgerReadAt?: string;
}

/** Pure: THE decision. */
export function decideLlmAccounts(input: DecideInput): LlmAccountDecision {
  const { loaded, state, now } = input;
  const warnings: string[] = [...loaded.errors, ...loaded.warnings];
  const { active, expired } = foldOverrides(input.events, state, now);
  const pack: LlmAccountPack | null = loaded.pack;
  const levelOf = (id: string): Level => state?.levels[id]?.level ?? 'L0';
  const conflicts: Conflict[] = [];
  const noteConflict = <V>(knob: string, scope: string, k: Knob<V>): void => {
    const people = k.claims.filter(c => c.overrideId);
    const w = k.winner;
    for (const c of people) if (w && c !== w && c.value !== w.value) conflicts.push({ knob, scope, winner: `${w.layer}=${String(w.value)}`, loser: `${c.layer}=${String(c.value)} (${c.overrideId})` });
  };

  // ── phase (guardian state ⊕ mode overrides) ──
  const phaseNames = new Set(['normal', ...(pack?.phases.map(p => p.name) ?? [])]);
  const phaseClaims: Claim<string>[] = [];
  if (state && phaseNames.has(state.phase)) phaseClaims.push({ value: state.phase, layer: 'GUARDIAN', why: `guardian 연료관 evaluated ${state.phase} since ${state.phaseSince}`, at: state.at });
  else if (state) warnings.push(`guardian phase ${state.phase} is not in the pack — normal`);
  for (const o of active) {
    const m = /^mode:(.+)$/u.exec(o.action);
    if (m && phaseNames.has(m[1]!)) phaseClaims.push(overrideClaim(o, m[1]!));
  }
  // A level action `mode:<phase>` is a phase claim too (rank level — the guardian's evaluated phase and people win).
  for (const [provider, pp] of Object.entries(pack?.providers ?? {})) for (const account of Object.keys(pp.accounts)) {
    for (const res of [`${provider}:${account}`, `${provider}:${account}:credits`]) {
      const lv = levelOf(res);
      const acts = res.endsWith(':credits') ? pack!.levels.creditActions[lv] : pack!.levels.actions[lv];
      for (const a of acts ?? []) {
        const m = /^mode:(.+)$/u.exec(a);
        if (m && phaseNames.has(m[1]!)) phaseClaims.push({ value: m[1]!, layer: 'level', why: `level ${lv} on ${res} → ${a}` });
      }
    }
  }
  const phaseKnob = pick(phaseClaims, 'normal');
  noteConflict('phase', '*', phaseKnob);
  const phaseRule = pack?.phases.find(p => p.name === phaseKnob.value) ?? null;
  const phaseWhy = (what: string) => `phase ${phaseKnob.value}${phaseRule?.why ? ` (${phaseRule.why})` : ''} ${what}`;

  // ── accounts ──
  const accounts: AccountDecision[] = [];
  const route: Record<string, string[]> = {};
  const creditRoute: Record<string, { order: string; accounts: string[] }> = {};
  for (const [provider, pp] of Object.entries(pack?.providers ?? {})) {
    const rows: AccountDecision[] = [];
    for (const account of pp.order.length ? pp.order : Object.keys(pp.accounts)) {
      const ap = pp.accounts[account]!;
      const id = `${provider}:${account}`;
      const level = levelOf(id);
      const creditLevel = levelOf(`${id}:credits`);
      const levelActs = pack!.levels.actions[level] ?? [];
      const creditActs = pack!.levels.creditActions[creditLevel] ?? [];
      const lvlWhy = (a: string) => `level ${level} on ${id}${state?.levels[id]?.remainingPercent != null ? ` (remaining ${state.levels[id]!.remainingPercent}%)` : ''} → ${a}`;
      // credits
      // The layer that stated it ([pack] product default · [overlay] this HQ's choice) is named in the chain.
      const credSrc = loaded.leafSources[`providers.${provider}.accounts.${account}.credits`] ?? 'pack';
      const baseCredits = ap.credits === 'until_reset' ? level === 'L3' : ap.credits;
      const untilWhy = ap.credits !== 'until_reset' ? '' : level === 'L3'
        ? ' — subscription exhausted (L3): credits ON until it resets' : ` — subscription not exhausted (${level}): subscription only`;
      const cc: Claim<boolean>[] = [{ value: baseCredits, layer: 'pack', why: `[${credSrc}] providers.${provider}.accounts.${account}.credits=${ap.credits}${untilWhy}` }];
      if (phaseRule?.set.credits && id in phaseRule.set.credits) cc.push({ value: phaseRule.set.credits[id]!, layer: 'phase', why: phaseWhy(`sets credits ${phaseRule.set.credits[id] ? 'ON' : 'OFF'}`) });
      for (const a of levelActs) if (a === 'credits_deny' || a === 'credits_allow') cc.push({ value: a === 'credits_allow', layer: 'level', why: lvlWhy(a) });
      for (const a of creditActs) {
        if (a === 'credits_deny') cc.push({ value: false, layer: 'safety', why: `safety: credit level ${creditLevel} on ${id}:credits (${creditLevel === 'L3' ? `balance ≤ floor ${ap.creditFloor ?? '-'}` : `today ≥ daily budget ${ap.dailyCreditBudget ?? '-'}`}) → credits_deny` });
        else if (a === 'credits_allow') cc.push({ value: true, layer: 'level', why: `credit level ${creditLevel} on ${id}:credits → credits_allow` });
      }
      for (const o of active) if ((o.action === 'credits_deny' || o.action === 'credits_allow') && scopeMatches(o.scope, id, 'credits')) cc.push(overrideClaim(o, o.action === 'credits_allow'));
      const credits = pick(cc, false);
      noteConflict('credits', id, credits);
      // skip · demote · tier_down
      const flag = (act: 'skip' | 'demote' | 'tier_down'): Knob<boolean> => {
        const c: Claim<boolean>[] = [];
        if (levelActs.includes(act)) c.push({ value: true, layer: 'level', why: lvlWhy(act) });
        if (act === 'skip' && phaseRule?.set.skip?.includes(id)) c.push({ value: true, layer: 'phase', why: phaseWhy('skips it') });
        for (const o of active) if (o.action === act && scopeMatches(o.scope, id, 'routing')) c.push(overrideClaim(o, true));
        return pick(c, false);
      };
      const skip = flag('skip');
      const demote = flag('demote');
      const tierDown = flag('tier_down');
      const routable = !skip.value || credits.value;
      // Skipped = its subscription window is off: rotate away at once (0 %); credits, when allowed, are the only path left.
      rows.push({ id, provider, account, capPercent: ap.capPercent, level, creditLevel, credits, skip, demote, tierDown, routable, subscriptionRoutable: !skip.value, rotateAtPercent: skip.value ? 0 : ap.capPercent ?? 100, uses: ap.uses });
    }
    if (!rows.length) continue;
    const LR = (l: Level) => ['L0', 'L1', 'L2', 'L3'].indexOf(l);
    // Demoted accounts go after every non-demoted one (whatever their level), and among themselves by level.
    route[provider] = rows.map((r, i) => ({ r, i, key: r.demote.value ? 1 + LR(r.level) : 0 }))
      .sort((a, b) => a.key - b.key || a.i - b.i).filter(x => x.r.routable).map(x => x.r.account);
    const balanceOf = (id: string): number | null => state?.credits?.[`${id}:credits`]?.balance ?? null;
    const spenders = rows.map((r, i) => ({ r, i, b: balanceOf(r.id) })).filter(x => x.r.credits.value && x.r.routable);
    if (pp.creditOrder === 'by_balance_desc') spenders.sort((x, y) => (y.b ?? -1) - (x.b ?? -1) || x.i - y.i);
    creditRoute[provider] = { order: pp.creditOrder, accounts: spenders.map(x => x.r.account) };
    accounts.push(...rows);
  }

  // ── fallback index · implementation ──
  const fc: Claim<number>[] = [{ value: 0, layer: 'pack', why: 'pack fallback chain from its first step' }];
  if (phaseRule?.set.fallbackIndex !== undefined) fc.push({ value: phaseRule.set.fallbackIndex, layer: 'phase', why: phaseWhy(`starts the fallback chain at step ${phaseRule.set.fallbackIndex}`) });
  for (const a of accounts) for (const act of pack!.levels.actions[a.level] ?? []) {
    const m = /^fallback:(\d+)$/u.exec(act); if (m) fc.push({ value: Number(m[1]), layer: 'level', why: `level ${a.level} on ${a.id} → ${act}` });
  }
  for (const o of active) { const m = /^fallback:(\d+)$/u.exec(o.action); if (m) fc.push(overrideClaim(o, Number(m[1]))); }
  const fallbackIndex = pick(fc, 0);
  noteConflict('fallbackIndex', '*', fallbackIndex);
  const ic: Claim<'normal' | 'throttled'>[] = [{ value: 'normal', layer: 'pack', why: 'pack: implementation normal' }];
  if (phaseRule?.set.implementation) ic.push({ value: phaseRule.set.implementation, layer: 'phase', why: phaseWhy(`implementation ${phaseRule.set.implementation}`) });
  const implementation = pick(ic, 'normal');
  const steps = pack?.fallback ?? [];
  const chain = steps.slice(Math.min(fallbackIndex.value, Math.max(0, steps.length - 1)));
  // The YAML states the order (and the index where a phase starts it) — nothing is inserted. The codex-credits step is
  // dropped only while no codex account may spend credits (then it could never run).
  const anyCredits = accounts.some(a => a.provider === 'openai-codex' && a.credits.value && a.routable);
  const fallback = anyCredits ? chain : chain.filter(s => s !== 'codex-credits');

  return {
    pack: PACK_NAME, revision: loaded.revision,
    // since = when the WINNING claim started: the guardian's phaseSince, or the override's time when a person's mode won.
    phase: { ...phaseKnob, since: phaseKnob.winner?.layer === 'GUARDIAN' ? state?.phaseSince ?? null : phaseKnob.winner?.at ?? null, pending: state?.pendingPhase ?? null },
    fallbackIndex, implementation, accounts, route, creditRoute, fallback,
    grokWeeklyCapPercent: pack?.providers.grok?.weeklyCapPercent ?? null,
    fallbackModel: pack?.providers.openrouter?.fallbackModel ?? null,
    overrides: { active, expired }, conflicts,
    stateAt: state?.at ?? null, decidedAt: now.toISOString(), ledgerReadAt: input.ledgerReadAt ?? null, warnings,
  };
}

// ── explain ──

const onOff = (v: unknown) => (typeof v === 'boolean' ? (v ? 'ON' : 'OFF') : String(v));
function knobLine<V>(name: string, k: Knob<V>): string {
  if (!k.winner) return `${name} ${onOff(k.value)} (no rule)`;
  const losers = k.claims.slice(1).map(c => `✗ ${c.layer} ${onOff(c.value)}: ${c.why}`);
  return `${name} ${onOff(k.value)} because ${k.winner.why}${losers.length ? `\n      ${losers.join('\n      ')}` : ''}`;
}

/** Human chain — «credits OFF because override by 대표 until 06:00 · level L2 on team». */
export function explainLines(d: LlmAccountDecision, account?: string): string[] {
  const L: string[] = [];
  L.push(`${d.pack} rev ${d.revision ?? '(no pack — legacy config keys)'} · decided ${d.decidedAt}${d.stateAt ? ` · guardian state ${d.stateAt}` : ' · no guardian state yet (all L0 · normal)'}${d.ledgerReadAt ? ` · overrides as of ${d.ledgerReadAt} (another process's change shows within ${LEDGER_TTL_MS / 1000}s)` : ''}`);
  L.push(knobLine('phase', d.phase) + (d.phase.pending ? `\n      ⏳ ${d.phase.pending} wanted by the rules — waits for the CEO (requires_ceo)` : ''));
  L.push(knobLine('fallback index', d.fallbackIndex) + ` → chain ${d.fallback.join(' → ') || '-'}`);
  L.push(knobLine('implementation', d.implementation));
  for (const a of d.accounts) {
    if (account && a.account !== account && a.id !== account) continue;
    const denied = Object.entries(a.uses).filter(([, v]) => !v).map(([u]) => u);
    L.push(`${a.id} · level ${a.level} · credit level ${a.creditLevel} · ${a.capPercent === null ? 'no subscription window (prepaid)' : `cap ${a.capPercent}% → rotate at ${a.rotateAtPercent}%`} · ${a.subscriptionRoutable ? 'subscription routable' : a.routable ? 'credits path only' : 'NOT routable'}${denied.length ? ` · never for ${denied.join(', ')}` : ''}`);
    for (const [n, k] of [['credits', a.credits], ['skip', a.skip], ['demote', a.demote], ['tier down', a.tierDown]] as const) if (n === 'credits' || k.winner) L.push(`  ${knobLine(n, k)}`);
  }
  for (const [p, r] of Object.entries(d.route)) L.push(`route ${p}: ${r.join(' → ') || '(none — fallback chain)'}`);
  for (const [p, c] of Object.entries(d.creditRoute)) L.push(`credit route ${p} (${c.order}): ${c.accounts.join(' → ') || '(no account may spend credits now)'}`);
  for (const o of d.overrides.active) L.push(`override ${o.id} ${o.by} ${o.scope} ${o.action} until ${o.until}${o.untilEvent ? ` | ${o.untilEvent}` : ''} — ${o.why}`);
  for (const c of d.conflicts) L.push(`⚠ conflict ${c.knob} ${c.scope}: ${c.winner} beats ${c.loser}`);
  for (const w of d.warnings) L.push(`⚠ ${w}`);
  return L;
}

// ── live reads ──

export const LEDGER_TTL_MS = 30_000;
let ledgerCache: { path: string; at: number; events: LlmPolicyLedgerEvent[] } | null = null;
let ledgerReadAt: string | null = null;

/** The ledger's LLM policy events (cached 30 s; a write by this process drops the cache). Never throws. */
export function readLlmPolicyEvents(now = Date.now()): { events: LlmPolicyLedgerEvent[]; warning: string | null } {
  try {
    const r = require('../../resource-ledger/resource-ledger.js') as typeof import('../../resource-ledger/resource-ledger.js');
    const path = process.env.RESOURCE_FACTS_LEDGER?.trim() || r.resourceLedgerPath();
    if (ledgerCache?.path === path && now - ledgerCache.at < LEDGER_TTL_MS && now >= ledgerCache.at) return { events: ledgerCache.events, warning: null };
    if (!existsSync(path)) {
      // Never there = nothing set. Gone after a good read = a fault: keep the last good overrides (a CEO deny must not vanish).
      if (ledgerCache?.path === path && ledgerCache.events.length) return { events: ledgerCache.events, warning: `ledger ${path} disappeared — overrides/levels from the last good read` };
      ledgerCache = { path, at: now, events: [] }; ledgerReadAt = new Date(now).toISOString();
      return { events: [], warning: null };
    }
    const events = r.readResourceLedger(path).filter((e): e is LlmPolicyLedgerEvent => e.event === 'llm-override' || e.event === 'llm-state');
    ledgerCache = { path, at: now, events }; ledgerReadAt = new Date(now).toISOString();
    return { events, warning: null };
  } catch (e) {
    return { events: ledgerCache?.events ?? [], warning: `ledger unreadable (${String(e).slice(0, 80)}) — overrides/levels from the last good read` };
  }
}
export function resetLlmDecisionCache(): void { ledgerCache = null; }

export const latestState = (events: readonly LlmPolicyLedgerEvent[]): LlmStateEvent | null =>
  [...events].reverse().find((e): e is LlmStateEvent => e.event === 'llm-state') ?? null;

/** The decision now (live pack ⊕ ledger). `consumer` records which revision that consumer applied. Never throws. */
export function llmAccountDecision(consumer?: string, now = new Date()): LlmAccountDecision {
  const loaded = loadLlmAccountPack();
  const { events, warning } = readLlmPolicyEvents(now.getTime());
  const d = decideLlmAccounts({ loaded, state: latestState(events), events, now, ...(ledgerReadAt ? { ledgerReadAt } : {}) });
  const out = warning ? { ...d, warnings: [...d.warnings, warning] } : d;
  if (consumer) reportApplied(consumer, out.revision, out.phase.value, now, loaded.changedAtMs);
  return out;
}

// ── applied revisions (heartbeat per consumer) · stale consumers ──

export interface AppliedReport { readonly consumer: string; readonly revision: string | null; readonly phase: string; readonly at: string; readonly host: string; readonly pid: number }
export const appliedDir = (): string => join(elanousStateRoot(), 'resource-facts', 'applied');
const APPLIED_BEAT_MS = 5 * 60_000;
const lastBeat = new Map<string, { revision: string | null; phase: string; at: number }>();

/** Record that `consumer` decided with `revision` (written when the revision/phase changes, else at most every 5 min). */
export function reportApplied(consumer: string, revision: string | null, phase: string, now = new Date(), changedAtMs = 0): void {
  const prev = lastBeat.get(consumer);
  // Dedupe — except right after a change on disk: the first decision after it is written at once, so a consumer still
  // deciding with an old revision shows as stale within the grace, not 5 min later.
  if (prev && prev.revision === revision && prev.phase === phase && now.getTime() - prev.at < APPLIED_BEAT_MS && changedAtMs <= prev.at) return;
  try {
    const dir = appliedDir();
    mkdirSync(dir, { recursive: true });
    // One file per consumer PER PROCESS (host · pid): two processes of one consumer never overwrite each other's report.
    const safeName = (v: string) => v.replace(/[^a-z0-9._-]/giu, '_');
    const file = join(dir, `${safeName(consumer)}@${safeName(hostname())}-${process.pid}.json`);
    if (!pruned) { pruned = true; pruneApplied(dir, now.getTime()); }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ consumer, revision, phase, at: now.toISOString(), host: hostname(), pid: process.pid } satisfies AppliedReport));
    renameSync(tmp, file);
    lastBeat.set(consumer, { revision, phase, at: now.getTime() }); // only after the write — a failed write retries next decision
  } catch (e) { try { debug.log('llm-policy', 'applied-report-failed', { consumer, error: String(e).slice(0, 120) }, { level: 'warn' }); } catch { /* */ } }
}
export function resetAppliedBeats(): void { lastBeat.clear(); pruned = false; }
let pruned = false;
/** Reports older than a day belong to processes long gone — dropped once per process, on its first write. */
export const APPLIED_KEEP_MS = 24 * 3_600_000;
function pruneApplied(dir: string, nowMs: number): void {
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try { if (nowMs - statSync(join(dir, f)).mtimeMs > APPLIED_KEEP_MS) rmSync(join(dir, f), { force: true }); } catch { /* */ }
    }
  } catch { /* */ }
}

export function readAppliedReports(dir = appliedDir()): AppliedReport[] {
  try {
    return readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(f => {
      try { const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as AppliedReport; return typeof j.consumer === 'string' && typeof j.at === 'string' ? [j] : []; } catch { return []; }
    });
  } catch { return []; }
}

export interface ConsumerVerdict { readonly consumer: string; readonly status: 'current' | 'idle' | 'stale'; readonly why: string; readonly report: AppliedReport }
/** Pure: stale = reported an OLD revision after the new one was on disk for longer than the read TTL (it decided from a
 *  copy); idle = last reported before the change (it has not decided since — it will read the new one next time). */
export function judgeConsumers(reports: readonly AppliedReport[], current: { revision: string | null; changedAtMs: number }, graceMs = LEDGER_TTL_MS): ConsumerVerdict[] {
  return reports.map(r => {
    if (r.revision === current.revision) return { consumer: r.consumer, status: 'current', why: `rev ${r.revision} at ${r.at}`, report: r };
    const at = Date.parse(r.at);
    if (at > current.changedAtMs + graceMs) return { consumer: r.consumer, status: 'stale', why: `decided with rev ${r.revision} at ${r.at}, ${Math.round((at - current.changedAtMs) / 1000)}s after rev ${current.revision} was on disk (${r.host} pid ${r.pid})`, report: r };
    return { consumer: r.consumer, status: 'idle', why: `last decided ${r.at} (rev ${r.revision}) — before the change; picks rev ${current.revision} on its next decision`, report: r };
  });
}
export function staleConsumers(): ConsumerVerdict[] {
  const loaded = loadLlmAccountPack();
  return judgeConsumers(readAppliedReports(), { revision: loaded.revision, changedAtMs: loaded.changedAtMs }).filter(v => v.status === 'stale');
}

// ── consumer accessors (undefined = no pack → the caller keeps its legacy config path) ──

const safe = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };

/** Accounts of `provider` allowed to spend credits now. */
export function decidedCreditAccounts(provider: string, consumer = 'codex-credit-accounts'): string[] | undefined {
  return safe(() => { const d = llmAccountDecision(consumer); return d.revision ? d.accounts.filter(a => a.provider === provider && a.credits.value && a.routable).map(a => a.account) : undefined; });
}
/** codex quota policy implied by the decision: any codex account may spend credits → `credits`, else `fallback`. */
export function decidedCodexQuotaPolicy(consumer = 'codex-rotation'): 'credits' | 'fallback' | undefined {
  return safe(() => { const d = llmAccountDecision(consumer); if (!d.revision) return undefined; return d.accounts.some(a => a.provider === 'openai-codex' && a.credits.value && a.routable) ? 'credits' : 'fallback'; });
}
/** Effective rotate-away thresholds per codex account. */
export function decidedRotationThresholds(consumer = 'codex-rotation'): Record<string, number> | undefined {
  return safe(() => { const d = llmAccountDecision(consumer); if (!d.revision) return undefined; const rows = d.accounts.filter(a => a.provider === 'openai-codex'); return rows.length ? Object.fromEntries(rows.map(a => [a.account, a.rotateAtPercent])) : undefined; });
}
/** Effective route order of a provider's accounts. */
export function decidedAccountOrder(provider: string, consumer = 'codex-rotation'): string[] | undefined {
  // A valid pack answers even when nothing is routable ([]) — only «no pack» falls back to the config order.
  return safe(() => { const d = llmAccountDecision(consumer); if (!d.revision) return undefined; return [...(d.route[provider] ?? [])]; });
}
export function decidedGrokWeeklyCap(consumer = 'grok-cap'): number | undefined {
  return safe(() => { const d = llmAccountDecision(consumer); return d.revision && d.grokWeeklyCapPercent !== null ? d.grokWeeklyCapPercent : undefined; });
}
/** The fallback chain (fallback index applied). */
export function decidedFallbackChain(consumer = 'fallback-chain'): string[] | undefined {
  // A valid policy that leaves nothing (every step off) answers [] — only «no pack» answers undefined (legacy path).
  return safe(() => { const d = llmAccountDecision(consumer); return d.revision ? [...d.fallback] : undefined; });
}
export function decidedFallbackModel(consumer = 'fallback-chain'): string | undefined {
  return safe(() => { const d = llmAccountDecision(consumer); return d.revision && d.fallbackModel ? d.fallbackModel : undefined; });
}
/** One model tier down for new cells on `provider`: every routable account of it says tier_down → the reason, else null. */
export function decidedProviderTierDown(provider: string, consumer = 'model-by-difficulty'): string | null {
  return safe(() => {
    const d = llmAccountDecision(consumer);
    const rows = d.accounts.filter(a => a.provider === provider && a.routable);
    return rows.length && rows.every(a => a.tierDown.value) ? rows.map(a => a.tierDown.winner?.why ?? a.id).join(' · ') : null;
  }) ?? null;
}
/** What a Pod snapshot carries: the revision and phase the host decided with. */
export function decidedSnapshotStamp(consumer = 'pod-snapshot'): { revision: string | null; phase: string } {
  return safe(() => { const d = llmAccountDecision(consumer); return { revision: d.revision, phase: d.phase.value }; }) ?? { revision: null, phase: 'normal' };
}
