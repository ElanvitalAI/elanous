// LLM-PHASE-BY-GUARDIAN — the 연료관's I/O around planFuelPhase (fuel-phase.ts): read pack ⊕ ledger ⊕ usage ⊕ credit balances,
// write the ONE `llm-state` fact, hold/clear its own floor overrides, raise a CEO money card for a phase no YAML budget
// bounds (and carry the CEO's «yes» out as a CEO `mode:` override with the decision id as crown evidence), journal
// transitions · conflicts · stale consumers. Never touches a CEO/OP/RES override; never throws into the pulse.
import { loadLlmAccountPack } from '../kit/resource-facts/llm-accounts.js';
import { foldOverrides, judgeConsumers, latestState, llmAccountDecision, readAppliedReports, readLlmPolicyEvents, resetLlmDecisionCache } from '../kit/resource-facts/llm-decide.js';
import { clearOverride, setOverride } from '../kit/resource-facts/llm-override.js';
import type { JournalRow } from '../loop-agent/journal.js';
import type { UsageAccount } from './fuel.js';
import { planFuelPhase, prepaidBalances, type FuelPhasePlan } from './fuel-phase.js';

export interface PhaseCard {
  readonly title: string; readonly category: 'money';
  readonly scqa: { readonly s: string; readonly c: string; readonly q: string; readonly a: string };
  readonly options: ReadonlyArray<{ readonly key: string; readonly label: string; readonly consequence: string }>;
  readonly recommendation: { readonly option: string; readonly why: string };
  readonly raisedBy: { readonly agent: string }; readonly refs: readonly string[];
}
export interface FuelPhasePorts {
  readonly now: Date;
  /** The operator's day of `now` (credit budgets are per day). */
  readonly day: string;
  /** Guardian memory marks (`sent`) — what was already raised / journaled. */
  readonly sent: Readonly<Record<string, string>>;
  mark(key: string, value: string): void;
  usage(): readonly UsageAccount[] | null;
  /** `<provider>:<account>` → measured credit balance (absent/null = unknown). */
  credits(): Readonly<Record<string, number | null>>;
  maintenance(): boolean;
  /** Raise a CEO card once per ref — the decision id, or null when it could not be raised. */
  raise(card: PhaseCard, ref: string): string | null;
  /** A raised card's outcome — null while open/unknown. */
  decided(id: string): { readonly choice: string; readonly human: boolean } | null;
  journal(rows: readonly JournalRow[]): void;
  /** Crown check for the CEO override the card's «a» becomes (default = the live decisions ledger: answered «a»). */
  readonly crownApproves?: (ref: string, action: string, scope: string) => boolean;
  /** Credit-pace day ledger root (tests/sims); absent = the codex credential root (same as the rotation reads). */
  readonly paceStateDir?: string;
  /** Ledger path override (tests/sims); absent = the live ledger. */
  readonly ledgerPath?: string;
}
export interface FuelPhaseResult { readonly kpi: { readonly value: string; readonly ok: boolean | null }; readonly actions: readonly string[]; readonly plan: FuelPhasePlan | null }

const row = (p: FuelPhasePorts, status: JournalRow['status'], action: string, target: string, what: string, why: string, before: string | null = null, after: string | null = null, evidence: readonly string[] = [], undo: string | null = null): JournalRow =>
  ({ v: 1, at: p.now.toISOString(), agent: 'guardian', status, action, target, what, why, before, after, evidence, undo, source: 'tick', by: 'GUARDIAN' });

export const phaseCard = (phase: string, why: string, day: string): PhaseCard => ({
  title: `LLM 국면 ${phase} 진입 승인 (돈)`, category: 'money',
  scqa: { s: `연료관 규칙이 국면 ${phase} 를 원한다 (${why.slice(0, 120)}).`, c: '이 국면은 YAML 예산이 묶지 않는 지출을 연다.',
    q: `${phase} 로 갈까요?`, a: '승인하면 수호자가 대표 mode 오버라이드(이 결정 id)로 들어가고, 거절이면 지금 국면을 유지한다.' },
  options: [
    { key: 'a', label: `${phase} 승인`, consequence: `수호자가 CEO mode:${phase} 오버라이드를 24h 쓴다(이 결정 id 가 근거)` },
    { key: 'b', label: '보류', consequence: '지금 국면 유지 · 작업은 더 싼 경로로 계속' },
  ],
  recommendation: { option: 'b', why: '예산 밖 지출은 대표 확인 뒤에만 — 작업은 폴백으로 계속 돈다' },
  raisedBy: { agent: 'guardian' }, refs: [`llm-phase:${phase}`, `day:${day}`],
});

/** CREDIT-PACE-METERING — the measured balances (`openai-codex:<account>`) into the credit-pace day ledger the codex
 *  rotation reads (`creditPaceStatus` · todaySpent = day-open − now). Unknown balances are skipped; never throws. */
export function recordObservedCredits(credits: Readonly<Record<string, number | null>>, now: Date, stateDir?: string): void {
  const balances: Record<string, number> = {};
  for (const [id, b] of Object.entries(credits)) {
    const m = /^openai-codex:(.+)$/u.exec(id);
    if (m && typeof b === 'number' && Number.isFinite(b) && b >= 0) balances[m[1]!] = b;
  }
  if (!Object.keys(balances).length) return;
  try { (require('../budget/codex-credit-pace.js') as typeof import('../budget/codex-credit-pace.js')).recordCreditBalances(balances, now, stateDir); }
  catch (e) { try { (require('../debug/log.js') as typeof import('../debug/log.js')).debug.log('guardian.fuel', 'credit-pace-record-failed', { error: String(e).slice(0, 160) }, { level: 'warn' }); } catch { /* */ } }
}

/** One 연료관 phase pass. */
export function runFuelPhase(p: FuelPhasePorts): FuelPhaseResult {
  const acts: string[] = [];
  const rows: JournalRow[] = [];
  const loaded = loadLlmAccountPack();
  if (!loaded.pack) return { kpi: { value: 'llm-accounts pack missing/invalid — consumers on legacy config', ok: null }, actions: [], plan: null };
  const now = p.now;
  let { events } = readLlmPolicyEvents(now.getTime());
  const prev = latestState(events);
  let active = foldOverrides(events, prev, now).active;
  // The inputs are read once per pass (the card check and the final plan judge the same world).
  const usage = p.usage(); const maintenance = p.maintenance();
  // Every provider's balance the same way: the codex balances the ports measure ⊕ prepaid balances the usage snapshot carries.
  const credits = { ...prepaidBalances(usage), ...p.credits() };
  const approvedNow = (list: typeof active) => list.filter(o => o.by === 'CEO' && o.action.startsWith('mode:')).map(o => o.action.slice('mode:'.length));
  // What the rules want right now, before any card answer is carried out — a «yes» is applied only while its phase is
  // still the pending one (conditions still hold, still needs the CEO); otherwise the card is superseded.
  const before = planFuelPhase({ pack: loaded.pack, revision: loaded.revision, prev, usage, credits, maintenance, ceoApproved: approvedNow(active), now, day: p.day });
  // ① carry out a CEO «yes» on a phase card as a CEO mode override (crown evidence = the decision id).
  for (const [k, id] of Object.entries(p.sent)) {
    const m = /^llm-phase-card:([a-z0-9-]+):\d{4}-\d{2}-\d{2}$/u.exec(k);
    if (!m || p.sent[`${k}:done`]) continue;
    const d = p.decided(id);
    if (!d) continue;
    if (d.choice === 'a' && d.human) {
      if (active.some(o => o.by === 'CEO' && o.action === `mode:${m[1]}`)) { p.mark(`${k}:done`, now.toISOString()); continue; }
      if (before.state.pendingPhase !== m[1]) {
        p.mark(`${k}:done`, `superseded ${now.toISOString()}`);
        acts.push(`card-superseded ${m[1]}`);
        rows.push(row(p, 'refused', 'phase-card-superseded', 'llm-accounts', `CEO «a» on ${m[1]} not applied — the rules no longer want it`, `decision ${id} = a · pending now ${before.state.pendingPhase ?? '-'} · phase ${before.state.phase}`, null, null, [id]));
        continue;
      }
      // Done only once the override is written — a failed write is retried on the next pass (the card stays due).
      let r: ReturnType<typeof setOverride>;
      try { r = setOverride({ by: 'CEO', scope: '*', action: `mode:${m[1]}`, why: `CEO approved phase ${m[1]} (decision ${id})`, ref: id, now, ...(p.crownApproves ? { crownApproves: p.crownApproves } : {}) }, p.ledgerPath); }
      catch (e) { r = { error: String(e).slice(0, 160) }; }
      if ('event' in r) {
        p.mark(`${k}:done`, now.toISOString());
        acts.push(`ceo-approved ${m[1]}`); rows.push(row(p, 'acted', 'phase-approved', 'llm-accounts', `CEO mode:${m[1]} override ${r.event.id} until ${r.event.until}`, `decision ${id} = a`, null, m[1]!, [id, r.event.id]));
      } else { acts.push(`ceo-approve-failed ${m[1]}`); rows.push(row(p, 'failed', 'phase-approved', 'llm-accounts', `CEO mode:${m[1]} override not written — retried next pass`, r.error, null, null, [id])); }
    } else {
      p.mark(`${k}:done`, now.toISOString());
      rows.push(row(p, 'refused', 'phase-held', 'llm-accounts', `phase ${m[1]} not entered`, `decision ${id} = ${d.choice}`, null, null, [id]));
    }
  }
  ({ events } = readLlmPolicyEvents(now.getTime()));
  active = foldOverrides(events, prev, now).active;
  const ceoApproved = approvedNow(active);
  // The 연료관 is the credit-balance poller: every pass's balances also feed the credit-pace day ledger
  // (budget/codex-credit-pace · todaySpent), so the rotation's credit-pace line measures what is really spent.
  recordObservedCredits(credits, now, p.paceStateDir);
  // ② evaluate levels and the phase (pure).
  const plan = planFuelPhase({ pack: loaded.pack, revision: loaded.revision, prev, usage, credits, maintenance, ceoApproved, now, day: p.day });
  const r = require('../resource-ledger/resource-ledger.js') as typeof import('../resource-ledger/resource-ledger.js');
  const ledger = p.ledgerPath ?? (process.env.RESOURCE_FACTS_LEDGER?.trim() || r.resourceLedgerPath());
  if (plan.changed) { r.recordLlmPolicyEvent(plan.state, ledger); resetLlmDecisionCache(); acts.push('state'); }
  for (const t of plan.transitions) {
    rows.push(row(p, 'acted', t.kind, t.target, `${t.target} ${t.from} → ${t.to}`, t.why, t.from, t.to));
    acts.push(`${t.kind} ${t.target} ${t.from}→${t.to}`);
  }
  // ③ guardian auto overrides: credits_deny on every credit balance at/below its floor; cleared when it recovers.
  const mine = active.filter(o => o.by === 'GUARDIAN' && o.action === 'credits_deny' && o.scope.endsWith(':credits'));
  for (const b of plan.floorBreached) {
    if (mine.some(o => o.scope === b.resource)) continue;
    const s = setOverride({ by: 'GUARDIAN', scope: b.resource, action: 'credits_deny', why: b.why, now }, ledger);
    if ('event' in s) { acts.push(`auto-deny ${b.resource}`); rows.push(row(p, 'acted', 'auto-override', b.resource, `credits_deny ${s.event.id} until ${s.event.until}`, b.why, 'credits ON', 'credits OFF', [s.event.id], `eln policy override clear ${s.event.id} --by GUARDIAN --why <text>`)); }
  }
  for (const o of mine) {
    if (plan.floorBreached.some(b => b.resource === o.scope)) continue;
    const c = clearOverride({ by: 'GUARDIAN', id: o.id, why: 'credit balance back above its floor', now }, ledger);
    if ('event' in c) { acts.push(`auto-clear ${o.scope}`); rows.push(row(p, 'acted', 'auto-override-cleared', o.scope, `cleared ${o.id}`, 'credit balance back above its floor', 'credits OFF', 'policy', [o.id])); }
  }
  // ④ a phase that needs the CEO → one money card per phase per day (never automatic).
  if (plan.state.pendingPhase) {
    const key = `llm-phase-card:${plan.state.pendingPhase}:${p.day}`;
    if (!p.sent[key]) {
      const why = plan.transitions.find(t => t.kind === 'pending')?.why ?? 'rules want it';
      const id = p.raise(phaseCard(plan.state.pendingPhase, why, p.day), key);
      if (id) { p.mark(key, id); acts.push(`card ${plan.state.pendingPhase}`); rows.push(row(p, 'acted', 'phase-card', 'llm-accounts', `CEO card ${id} for phase ${plan.state.pendingPhase}`, why, plan.state.phase, plan.state.pendingPhase, [id])); }
      else rows.push(row(p, 'failed', 'phase-card', 'llm-accounts', `could not raise the CEO card for ${plan.state.pendingPhase}`, why));
    }
  }
  // ⑤ conflicts between interventions and stale consumers — journaled once per day each.
  const d = llmAccountDecision('guardian-fuel', now);
  for (const c of d.conflicts) {
    const key = `llm-conflict:${c.knob}:${c.scope}:${c.winner}:${c.loser}:${p.day}`;
    if (p.sent[key]) continue;
    p.mark(key, now.toISOString());
    rows.push(row(p, 'refused', 'override-conflict', c.scope, `${c.knob}: ${c.winner} beats ${c.loser}`, 'ranked CEO > safety > OP=RES > GUARDIAN · the loser stays until it expires'));
  }
  const consumers = judgeConsumers(readAppliedReports(), { revision: loaded.revision, changedAtMs: loaded.changedAtMs });
  const stale = consumers.filter(v => v.status === 'stale');
  for (const v of stale) {
    const key = `llm-stale:${v.consumer}:${loaded.revision}`;
    if (p.sent[key]) continue;
    p.mark(key, now.toISOString());
    rows.push(row(p, 'failed', 'stale-consumer', v.consumer, `decides with an old policy revision`, v.why, v.report.revision, loaded.revision));
  }
  if (rows.length) { try { p.journal(rows); } catch { /* the journal must not break the pulse */ } }
  if (plan.noFact.length) { try { (require('../debug/log.js') as typeof import('../debug/log.js')).debug.log('guardian.fuel', 'no-usage-fact', { accounts: plan.noFact }, { level: 'warn' }); } catch { /* */ } }
  const l3 = Object.entries(plan.state.levels).filter(([, v]) => v.level !== 'L0').map(([k, v]) => `${k} ${v.level}`);
  return {
    kpi: { value: `phase ${d.phase.value}${plan.state.pendingPhase ? ` (⏳ ${plan.state.pendingPhase})` : ''} · ${l3.join(' · ') || 'all L0'} · overrides ${d.overrides.active.length}${plan.noFact.length ? ` · no fact ${plan.noFact.join(',')} (holds last known)` : ''}${stale.length ? ` · stale consumers ${stale.map(s => s.consumer).join(',')}` : ''}`,
      ok: stale.length === 0 && !plan.state.pendingPhase },
    actions: acts, plan,
  };
}

/** Cheap probe for the pulse body (no writes): would a 연료관 pass change anything a consumer reads? */
export function fuelPhaseDue(p: Pick<FuelPhasePorts, 'now' | 'day' | 'usage' | 'credits' | 'maintenance' | 'sent' | 'decided'>): boolean {
  try {
    const loaded = loadLlmAccountPack();
    if (!loaded.pack) return false;
    const { events } = readLlmPolicyEvents(p.now.getTime());
    const prev = latestState(events);
    const active = foldOverrides(events, prev, p.now).active;
    const ceoApproved = active.filter(o => o.by === 'CEO' && o.action.startsWith('mode:')).map(o => o.action.slice('mode:'.length));
    const plan = planFuelPhase({ pack: loaded.pack, revision: loaded.revision, prev, usage: p.usage(), credits: p.credits(), maintenance: p.maintenance(), ceoApproved, now: p.now, day: p.day });
    const mine = active.filter(o => o.by === 'GUARDIAN' && o.action === 'credits_deny');
    const overrideDue = plan.floorBreached.some(b => !mine.some(o => o.scope === b.resource)) || mine.some(o => !plan.floorBreached.some(b => b.resource === o.scope));
    // An open card makes the 연료관 due only once it is ANSWERED (the probe reads the answer; an unanswered card costs
    // no pass per tick).
    const cardDue = Object.entries(p.sent).some(([k, id]) => /^llm-phase-card:[a-z0-9-]+:\d{4}-\d{2}-\d{2}$/u.test(k) && !p.sent[`${k}:done`] && !!p.decided(id))
      // a pending phase whose card is not raised yet (a raise failed) is due until it is
      || (!!plan.state.pendingPhase && !p.sent[`llm-phase-card:${plan.state.pendingPhase}:${p.day}`]);
    return plan.changed || overrideDue || cardDue;
  } catch { return false; }
}
