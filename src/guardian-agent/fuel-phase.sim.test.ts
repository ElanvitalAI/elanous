// LLM-PHASE-BY-GUARDIAN sim (seeds 1–5) — the 연료관 judges levels (hysteresis ⊕ dwell) and phases, writes ONE ledger fact,
// holds its own floor overrides and asks the CEO for unbudgeted money. Expectations are literals (rule 11).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadLlmAccountPack, resetLlmAccountPackCache } from '../kit/resource-facts/llm-accounts.js';
import { decidedCreditAccounts, latestState, llmAccountDecision, readLlmPolicyEvents, resetAppliedBeats, resetLlmDecisionCache } from '../kit/resource-facts/llm-decide.js';
import { setOverride } from '../kit/resource-facts/llm-override.js';
import type { JournalRow } from '../loop-agent/journal.js';
import type { UsageAccount } from './fuel.js';
import { nextLevel } from './fuel-phase.js';
import { fuelPhaseDue, runFuelPhase, type FuelPhasePorts, type PhaseCard } from './fuel-phase-run.js';
import { dueSubAgents, worldEvents } from './subagents.js';

const REPO_PACK = resolve(import.meta.dir, '../../graphs/policies/llm-accounts.yaml');
const ENV = ['LLM_ACCOUNT_POLICY_PACK', 'LLM_ACCOUNT_POLICY_OVERLAY', 'RESOURCE_FACTS_LEDGER', 'ELANOUS_STATE_DIR'] as const;
const CROWNS = new Set(['bus-1630', 'bus-1631']);
const crownApproves = (ref: string) => CROWNS.has(ref);
const saved: Record<string, string | undefined> = {};
let dir = '';

function rng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'fuel-phase-sim-'));
  copyFileSync(REPO_PACK, join(dir, 'pack.yaml'));
  process.env.LLM_ACCOUNT_POLICY_PACK = join(dir, 'pack.yaml');
  process.env.LLM_ACCOUNT_POLICY_OVERLAY = join(dir, 'overlay.yaml');
  process.env.RESOURCE_FACTS_LEDGER = join(dir, 'events.jsonl');
  process.env.ELANOUS_STATE_DIR = join(dir, 'state');
  resetLlmAccountPackCache(); resetLlmDecisionCache(); resetAppliedBeats();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetLlmAccountPackCache(); resetLlmDecisionCache();
  rmSync(dir, { recursive: true, force: true });
});

/** A world the 연료관 reads: usage per codex account, the default credit balance, cards and journal kept in memory. */
function world() {
  const w = {
    used: { team: 10, third: 10, default: 10 } as Record<string, number>,
    balance: 30_000 as number | null,
    sent: {} as Record<string, string>,
    cards: [] as Array<{ id: string; card: PhaseCard }>,
    answers: {} as Record<string, { choice: string; human: boolean }>,
    journal: [] as JournalRow[],
    raiseFails: 0,
    crownOk: true,
    ports(now: Date): FuelPhasePorts {
      return {
        now, day: DAY, sent: { ...w.sent }, mark: (k, v) => { w.sent[k] = v; },
        usage: (): UsageAccount[] => Object.entries(w.used).map(([account, usedPercent]) => ({ provider: 'codex', account, usedPercent, status: 'ok' })),
        credits: () => ({ 'openai-codex:default': w.balance }),
        maintenance: () => false,
        raise: (card) => { if (w.raiseFails > 0) { w.raiseFails--; return null; } const id = `dec-${w.cards.length + 1}`; w.cards.push({ id, card }); return id; },
        crownApproves: (ref) => w.crownOk && w.cards.some(c => c.id === ref),
        decided: (id) => w.answers[id] ?? null,
        journal: (rows) => { w.journal.push(...rows); },
      };
    },
    tick(now: Date) { resetLlmDecisionCache(); return runFuelPhase(w.ports(now)); },
  };
  return w;
}
// Times relative to the real clock (overrides set by tests use it; a guardian override lives 24 h from its tick).
const BASE = Date.now();
const DAY = new Date(BASE).toISOString().slice(0, 10);
const at = (min: number) => new Date(BASE + min * 60_000);
const phaseNow = () => { resetLlmDecisionCache(); return latestState(readLlmPolicyEvents().events)?.phase ?? 'normal'; };

describe('levels — hysteresis and dwell (no flapping)', () => {
  const wm = { L1: { below: 30, exitAt: 35 }, L2: { below: 10, exitAt: 15 }, L3: { below: null, exitAt: 5 } };
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`usage oscillating around the 30 % watermark → ≤ 1 transition per 15-min dwell (seed ${seed})`, () => {
      const r = rng(seed);
      let prev: ReturnType<typeof nextLevel> | undefined;
      const moves: number[] = [];
      for (let m = 0; m <= 240; m += 2) {
        // remaining swings 22..42 % — across both the enter (30) and the exit (35) watermark.
        const remaining = 32 + (r() * 2 - 1) * 10;
        const next = nextLevel(prev, remaining, false, wm, 15 * 60_000, at(m));
        if (prev && next.level !== prev.level) moves.push(m);
        prev = next;
      }
      for (const m of moves) expect(moves.filter(x => x > m - 15 && x <= m).length).toBeLessThanOrEqual(1);
      expect(moves.length).toBeLessThanOrEqual(Math.ceil(240 / 15));
    });
  }
  test('inside the hysteresis band nothing moves: 28 → L1, then 32·34·31 stay L1; 36 inside the dwell stays, after it → L0', () => {
    let l = nextLevel(undefined, 50, false, wm, 15 * 60_000, at(0));
    l = nextLevel(l, 28, false, wm, 15 * 60_000, at(16));
    expect(l.level).toBe('L1');
    for (const [m, rem] of [[20, 32], [22, 34], [24, 31]] as const) { l = nextLevel(l, rem, false, wm, 15 * 60_000, at(m)); expect(l.level).toBe('L1'); }
    expect(nextLevel(l, 36, false, wm, 15 * 60_000, at(26)).level).toBe('L1');
    expect(nextLevel(l, 36, false, wm, 15 * 60_000, at(40)).level).toBe('L0');
  });
  test('exhaustion is a fact — L3 at once, even inside the dwell', () => {
    let l = nextLevel(undefined, 50, false, wm, 15 * 60_000, at(0));
    l = nextLevel(l, 20, false, wm, 15 * 60_000, at(1));
    expect(nextLevel(l, 0, false, wm, 15 * 60_000, at(2)).level).toBe('L3');
  });
});

describe('phase chain — subscriptions → credits → OpenRouter → reset → normal', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}`, () => {
      const r = rng(seed);
      const w = world();
      w.tick(at(0));
      expect(phaseNow()).toBe('normal');
      // team and third fill up (in a seed-chosen order) → subscription-tight.
      const [first, second] = r() < 0.5 ? ['team', 'third'] : ['third', 'team'];
      w.used[first!] = 100; w.tick(at(2));
      expect(phaseNow()).toBe('normal');
      w.used[second!] = 100; w.tick(at(4));
      expect(phaseNow()).toBe('subscription-tight');
      expect(decidedCreditAccounts('openai-codex')).toEqual(['default']);
      // default's subscription is full → credits-default (bounded by its daily budget) — automatic, no card.
      w.used.default = 100; w.tick(at(6));
      expect(phaseNow()).toBe('credits-default');
      expect(w.cards).toEqual([]);
      // a day's credit spend reaches the 30 000 budget → credit level L2 (safety) → fallback-openrouter.
      w.balance = 30_000 - 30_000 - Math.floor(r() * 10) + 30_000 - 30_000 + 29_999; w.tick(at(8));
      w.balance = 30_000 - 30_000; w.tick(at(10)); // spent 30 000 today (start 30 000 → 0): budget reached, and balance 0 ≤ floor
      expect(phaseNow()).toBe('fallback-openrouter');
      const d = llmAccountDecision();
      expect(d.route['openai-codex']).toEqual([]);
      expect(d.fallback).toEqual(['openrouter']);
      // reset: every window back to 0 % and the balance topped up — the phase relaxes only after the dwell.
      w.used = { team: 0, third: 0, default: 0 }; w.balance = 40_000;
      w.tick(at(12));
      const held = phaseNow();
      expect(['fallback-openrouter', 'normal']).toContain(held);
      w.tick(at(40)); w.tick(at(60));
      expect(phaseNow()).toBe('normal');
      const phases = w.journal.filter(j => j.action === 'phase').map(j => `${j.before}→${j.after}`);
      expect(phases[0]).toBe('normal→subscription-tight');
      expect(phases).toContain('subscription-tight→credits-default');
      expect(phases).toContain('credits-default→fallback-openrouter');
      expect(phases.at(-1)).toBe('fallback-openrouter→normal');
    });
  }
});

describe('every provider the same way — usage facts, prepaid balances, no fact = hold + warn', () => {
  test('grok/zai levels from their usage rows · OpenRouter prepaid $ from leftUsd · a missing fact holds the last level', () => {
    const { planFuelPhase, prepaidBalances } = require('./fuel-phase.js') as typeof import('./fuel-phase.js');
    const pack = loadLlmAccountPack().pack!;
    const usage: UsageAccount[] = [
      { provider: 'codex', account: 'default', usedPercent: 10, status: 'ok' },
      { provider: 'codex', account: 'team', usedPercent: 10, status: 'ok' },
      { provider: 'codex', account: 'third', usedPercent: 10, status: 'ok' },
      { provider: 'zai', account: 'plan-5h', usedPercent: 0, status: 'ok' },
      { provider: 'zai', account: 'plan-week', usedPercent: 100, status: 'ok' },
      { provider: 'openrouter', account: 'default', usedPercent: 93.2, leftUsd: 887.23, status: 'ok' },
    ]; // no grok row this pass
    const plan = planFuelPhase({ pack, revision: 'r', prev: null, usage, credits: prepaidBalances(usage), maintenance: false, ceoApproved: [], now: at(0), day: DAY });
    expect(plan.state.levels['zai:plan-week']!.level).toBe('L3');
    expect(plan.state.levels['zai:plan-5h']!.level).toBe('L0');
    expect(plan.noFact).toEqual(['grok:default']);
    expect(plan.state.levels['openrouter:default']!.level).toBe('L0'); // no subscription window
    expect(plan.state.credits!['openrouter:default:credits']).toEqual({ day: DAY, startBalance: 887.23, balance: 887.23, spent: 0 });
  });
});

describe('interventions', () => {
  test('CEO «no credits» beats the automatic credits-default phase', () => {
    const w = world();
    w.used = { team: 100, third: 100, default: 100 }; w.tick(at(0));
    expect(phaseNow()).toBe('credits-default');
    expect(decidedCreditAccounts('openai-codex')).toEqual(['default']);
    const o = setOverride({ by: 'CEO', scope: '*', action: 'credits_deny', why: 'no credits today', until: '1h', ref: 'bus-1630', now: new Date(), crownApproves });
    expect('event' in o).toBe(true);
    w.tick(at(2));
    expect(phaseNow()).toBe('credits-default');
    expect(decidedCreditAccounts('openai-codex')).toEqual([]);
    expect(llmAccountDecision().accounts.find(a => a.account === 'default')!.credits.winner!.layer).toBe('CEO');
  });
  test('override expiry restores the policy', () => {
    const w = world();
    w.used = { team: 100, third: 100, default: 100 }; w.tick(at(0));
    const now = Date.now();
    setOverride({ by: 'CEO', scope: '*', action: 'credits_deny', why: 'one hour only', until: '1h', ref: 'bus-1631', now: new Date(now), crownApproves });
    resetLlmDecisionCache();
    expect(llmAccountDecision('sim', new Date(now + 30 * 60_000)).accounts.find(a => a.account === 'default')!.credits.value).toBe(false);
    resetLlmDecisionCache();
    const later = llmAccountDecision('sim', new Date(now + 61 * 60_000));
    expect(later.accounts.find(a => a.account === 'default')!.credits.value).toBe(true);
    expect(later.overrides.expired.map(e => e.why)).toEqual([expect.stringContaining('passed')]);
  });
  test('guardian auto override when the credit balance falls under the floor — cleared on recovery; an OP override is never touched', () => {
    const w = world();
    w.used = { team: 100, third: 100, default: 100 }; w.tick(at(0));
    const op = setOverride({ by: 'OP', scope: 'openai-codex:team', action: 'demote', why: 'team flaky', now: new Date() });
    if (!('event' in op)) throw new Error(op.error);
    w.balance = 1_500; w.tick(at(2));
    resetLlmDecisionCache();
    let d = llmAccountDecision();
    const auto = d.overrides.active.filter(o => o.by === 'GUARDIAN');
    expect(auto.map(o => [o.scope, o.action])).toEqual([['openai-codex:default:credits', 'credits_deny']]);
    expect(auto[0]!.why).toBe('credit balance 1500 ≤ floor 2000');
    expect(d.accounts.find(a => a.account === 'default')!.credits.value).toBe(false);
    expect(w.journal.some(j => j.action === 'auto-override' && j.target === 'openai-codex:default:credits')).toBe(true);
    w.balance = 9_000; w.tick(at(4));
    resetLlmDecisionCache();
    d = llmAccountDecision();
    expect(d.overrides.active.filter(o => o.by === 'GUARDIAN')).toEqual([]);
    expect(d.overrides.active.map(o => o.id)).toEqual([op.event.id]);
  });
  test('a phase no YAML budget bounds → one CEO money card, held pending; the CEO «a» enters it via a CEO mode override', () => {
    writeFileSync(join(dir, 'overlay.yaml'), 'providers:\n  openai-codex:\n    accounts:\n      default: { daily_credit_budget: null }\n');
    resetLlmAccountPackCache();
    expect(loadLlmAccountPack().pack!.providers['openai-codex']!.accounts.default!.dailyCreditBudget).toBeNull();
    const w = world();
    w.used = { team: 100, third: 100, default: 100 }; w.tick(at(0));
    expect(phaseNow()).toBe('subscription-tight');
    expect(w.cards.map(c => c.card.title)).toEqual(['LLM 국면 credits-default 진입 승인 (돈)']);
    expect(w.cards[0]!.card.category).toBe('money');
    w.tick(at(2));
    expect(w.cards.length).toBe(1);
    w.answers['dec-1'] = { choice: 'a', human: true };
    expect(fuelPhaseDue(w.ports(at(4)))).toBe(true);
    w.tick(at(4)); w.tick(at(6));
    expect(phaseNow()).toBe('credits-default');
    const ceo = llmAccountDecision().overrides.active.find(o => o.by === 'CEO');
    expect([ceo?.action, ceo?.ref]).toEqual(['mode:credits-default', 'dec-1']);
  });
  test('pending cleared is a state change (recorded) · a failed CEO-override write is retried, the card stays due', () => {
    writeFileSync(join(dir, 'overlay.yaml'), 'providers:\n  openai-codex:\n    accounts:\n      default: { daily_credit_budget: null }\n');
    resetLlmAccountPackCache();
    const w = world();
    w.used = { team: 100, third: 100, default: 100 }; w.tick(at(0));
    expect(latestState(readLlmPolicyEvents().events)!.pendingPhase).toBe('credits-default');
    w.answers['dec-1'] = { choice: 'a', human: true };
    w.crownOk = false; // the override write is refused this pass
    w.tick(at(2));
    expect(w.sent['llm-phase-card:credits-default:' + DAY + ':done']).toBeUndefined();
    expect(w.journal.some(j => j.action === 'phase-approved' && j.status === 'failed')).toBe(true);
    expect(fuelPhaseDue(w.ports(at(3)))).toBe(true);
    w.crownOk = true; w.tick(at(4));
    expect(w.sent['llm-phase-card:credits-default:' + DAY + ':done']).toBeDefined();
    resetLlmDecisionCache();
    const st = latestState(readLlmPolicyEvents().events)!;
    expect([st.phase, st.pendingPhase]).toEqual(['credits-default', null]);
    expect(w.journal.some(j => j.action === 'pending' && j.before === 'credits-default' && j.after === '-')).toBe(true);
  });
  test('a phase that becomes CEO-gated by a policy edit is left at once (no dwell keeps unbudgeted credits going)', () => {
    const w = world();
    w.used = { team: 100, third: 100, default: 100 }; w.tick(at(0));
    expect(phaseNow()).toBe('credits-default');
    writeFileSync(join(dir, 'overlay.yaml'), 'providers:\n  openai-codex:\n    accounts:\n      default: { daily_credit_budget: null }\n');
    resetLlmAccountPackCache();
    w.tick(at(2)); // inside the 15-min dwell
    resetLlmDecisionCache();
    const st = latestState(readLlmPolicyEvents().events)!;
    expect([st.phase, st.pendingPhase]).toEqual(['subscription-tight', 'credits-default']);
  });
  test('an unanswered card does not make the 연료관 due every tick; its answer does', () => {
    writeFileSync(join(dir, 'overlay.yaml'), 'providers:\n  openai-codex:\n    accounts:\n      default: { daily_credit_budget: null }\n');
    resetLlmAccountPackCache();
    const w = world();
    w.used = { team: 100, third: 100, default: 100 }; w.tick(at(0));
    expect(fuelPhaseDue(w.ports(at(1)))).toBe(false);
    w.answers['dec-1'] = { choice: 'b', human: true };
    expect(fuelPhaseDue(w.ports(at(2)))).toBe(true);
  });
  test('a failed card raise is retried on the next tick', () => {
    writeFileSync(join(dir, 'overlay.yaml'), 'providers:\n  openai-codex:\n    accounts:\n      default: { daily_credit_budget: null }\n');
    resetLlmAccountPackCache();
    const w = world();
    w.raiseFails = 1;
    w.used = { team: 100, third: 100, default: 100 }; w.tick(at(0));
    expect(w.cards).toEqual([]);
    expect(w.journal.some(j => j.action === 'phase-card' && j.status === 'failed')).toBe(true);
    expect(fuelPhaseDue(w.ports(at(1)))).toBe(true);
    w.tick(at(2));
    expect(w.cards.map(c => c.id)).toEqual(['dec-1']);
    w.tick(at(4));
    expect(w.cards.length).toBe(1); // raised once — the open card is polled for its answer, never raised again
  });
  test('a top-up keeps the day\'s cumulative spend — the daily budget still binds', () => {
    const w = world();
    w.balance = 30_000; w.tick(at(0));
    w.balance = 5_000; w.tick(at(2));   // spent 25 000
    w.balance = 25_000; w.tick(at(4));  // +20 000 top-up — spent stays 25 000
    let def = (resetLlmDecisionCache(), llmAccountDecision()).accounts.find(a => a.account === 'default')!;
    expect([def.creditLevel, def.credits.value]).toEqual(['L0', true]);
    w.balance = 20_000; w.tick(at(6));  // spent 30 000 = the daily budget
    resetLlmDecisionCache();
    def = llmAccountDecision().accounts.find(a => a.account === 'default')!;
    expect([def.creditLevel, def.credits.value, def.credits.winner!.layer]).toEqual(['L2', false, 'safety']);
    const c = latestState(readLlmPolicyEvents().events)!.credits!['openai-codex:default:credits']!;
    expect([c.spent, c.startBalance - c.balance]).toEqual([30_000, 30_000]);
  });
  test('sub-1 % drops are all counted — a 30 000 → 29 900 → 30 000 loop is 100 spent each time', () => {
    const w = world();
    w.balance = 30_000; w.tick(at(0));
    for (let i = 0; i < 3; i++) { w.balance = 29_900; w.tick(at(2 + i * 4)); w.balance = 30_000; w.tick(at(4 + i * 4)); }
    resetLlmDecisionCache();
    expect(latestState(readLlmPolicyEvents().events)!.credits!['openai-codex:default:credits']!.spent).toBe(300);
  });
  test('a CEO «a» on a card whose phase is no longer wanted is superseded — no override', () => {
    writeFileSync(join(dir, 'overlay.yaml'), 'providers:\n  openai-codex:\n    accounts:\n      default: { daily_credit_budget: null }\n');
    resetLlmAccountPackCache();
    const w = world();
    w.used = { team: 100, third: 100, default: 100 }; w.tick(at(0));
    expect(w.cards.map(c => c.id)).toEqual(['dec-1']);
    w.used = { team: 0, third: 0, default: 0 }; w.tick(at(20)); w.tick(at(40));
    resetLlmDecisionCache();
    expect(latestState(readLlmPolicyEvents().events)!.pendingPhase).toBeNull();
    w.answers['dec-1'] = { choice: 'a', human: true };
    w.tick(at(42));
    resetLlmDecisionCache();
    expect(llmAccountDecision().overrides.active.filter(o => o.by === 'CEO')).toEqual([]);
    expect(w.sent['llm-phase-card:credits-default:' + DAY + ':done']).toMatch(/^superseded /u);
    expect(w.journal.some(j => j.action === 'phase-card-superseded')).toBe(true);
    expect(phaseNow()).toBe('normal');
  });
  test('the pulse spawns the 연료관 at once on a level change (event fuel-level)', () => {
    const ev = worldEvents([], { fuelLevel: true });
    expect([...ev]).toEqual(['fuel-level']);
    const due = dueSubAgents(ev, { fuel: new Date(Date.now() - 5 * 60_000).toISOString() }, Date.now());
    expect(due.find(x => x.spec.id === 'fuel')?.why).toBe('event fuel-level');
  });
});
