// LLM-ACCOUNT-POLICY-YAML sim (seeds 1–5) — the pack, the live overlay, overrides as ledger facts and the ONE decision.
// Expectations are literals (rule 11): account names, ranks and phase names are spelled here, not imported from the product.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lintPack, loadLlmAccountPack, resetLlmAccountPackCache } from './llm-accounts.js';
import { decideLlmAccounts, decidedCodexQuotaPolicy, decidedCreditAccounts, decidedFallbackChain, decidedRotationThresholds, explainLines, judgeConsumers, llmAccountDecision, resetAppliedBeats, resetLlmDecisionCache } from './llm-decide.js';
import { clearOverride, setOverride } from './llm-override.js';
import { recordLlmPolicyEvent } from '../../resource-ledger/resource-ledger.js';
import { parse } from 'yaml';

const REPO_PACK = resolve(import.meta.dir, '../../../graphs/policies/llm-accounts.yaml');
let dir = '';
const saved: Record<string, string | undefined> = {};
const ENV = ['LLM_ACCOUNT_POLICY_PACK', 'LLM_ACCOUNT_POLICY_OVERLAY', 'RESOURCE_FACTS_LEDGER', 'ELANOUS_CODEX_QUOTA_POLICY', 'ELANOUS_STATE_DIR'] as const;
/** Crown refs the tests treat as CEO decisions in the ledger (the live lookup is tested on its own below). */
const CROWNS = new Set(['dec-1', 'dec-7', 'dec-x', 'dec-1630']);
const crownApproves = (ref: string) => CROWNS.has(ref);

function rng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function state(phase: string, levels: Record<string, string>, at = new Date().toISOString()): void {
  recordLlmPolicyEvent({ event: 'llm-state', at, by: 'GUARDIAN', revision: null, phase, phaseSince: at,
    levels: Object.fromEntries(Object.entries(levels).map(([k, l]) => [k, { level: l as 'L0', since: at }])) }, process.env.RESOURCE_FACTS_LEDGER!);
  resetLlmDecisionCache();
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'llm-pack-sim-'));
  copyFileSync(REPO_PACK, join(dir, 'pack.yaml'));
  process.env.LLM_ACCOUNT_POLICY_PACK = join(dir, 'pack.yaml');
  process.env.LLM_ACCOUNT_POLICY_OVERLAY = join(dir, 'overlay.yaml');
  process.env.RESOURCE_FACTS_LEDGER = join(dir, 'events.jsonl');
  // The state root too: the revision marker, the policy.changed bus line, applied reports and the decisions ledger stay here.
  process.env.ELANOUS_STATE_DIR = join(dir, 'state');
  delete process.env.ELANOUS_CODEX_QUOTA_POLICY;
  resetLlmAccountPackCache(); resetLlmDecisionCache(); resetAppliedBeats();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetLlmAccountPackCache(); resetLlmDecisionCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('pack — lint and the live values of 11-27', () => {
  test('the repo pack lints clean and carries the migrated live values', () => {
    const l = loadLlmAccountPack();
    expect(l.errors).toEqual([]);
    expect(l.revision).toMatch(/^[0-9a-f]{12}$/u);
    const codex = l.pack!.providers['openai-codex']!;
    expect(codex.order).toEqual(['team', 'third', 'default']);
    expect(codex.accounts.team!.credits).toBe(false);
    expect(codex.accounts.third!.credits).toBe(false);
    expect(codex.accounts.default!.credits).toBe(true);
    expect([codex.accounts.team!.capPercent, codex.accounts.third!.capPercent, codex.accounts.default!.capPercent]).toEqual([100, 100, 100]);
    expect(l.pack!.providers.grok!.weeklyCapPercent).toBe(70);
    expect(l.pack!.fallback).toEqual(['codex-credits', 'openrouter']);
    expect(l.pack!.phases.map(p => p.name)).toEqual(['maintenance', 'fallback-openrouter', 'credits-default', 'subscription-tight']);
  });
  test('unknown fields and bad values are errors, never silent defaults', () => {
    const raw = parse(require('node:fs').readFileSync(REPO_PACK, 'utf8'));
    raw.providers['openai-codex'].accounts.team.credit = true;
    raw.providers['openai-codex'].accounts.third.subscription_cap_percent = 140;
    raw.levels.watermarks.L1 = { below: 30, exit_at: 20 };
    raw.phases[0].when = ['openai-codex:team>>L3'];
    const l = lintPack(raw);
    expect(l.pack).toBeNull();
    expect(l.errors).toContain('unknown field providers.openai-codex.accounts.team.credit');
    expect(l.errors).toContain('providers.openai-codex.accounts.third.subscription_cap_percent must be 0..100 (or null = no subscription window)');
    expect(l.errors).toContain('levels.watermarks.L1.exit_at must be ≥ below (hysteresis)');
    expect(l.errors.some(e => e.includes('phases[0].when'))).toBe(true);
  });
  test('an invalid overlay is ignored — the repo pack holds', () => {
    writeFileSync(join(dir, 'overlay.yaml'), 'providers:\n  openai-codex:\n    accounts:\n      default: { credits: maybe }\n');
    const l = loadLlmAccountPack();
    expect(l.overlayApplied).toBe(false);
    expect(l.pack!.providers['openai-codex']!.accounts.default!.credits).toBe(true);
    expect(l.warnings.some(w => w.startsWith('overlay ignored'))).toBe(true);
  });
  test('a Pod child never decides from its image copy of the pack — the host-carried snapshot values stand', () => {
    const saved = { s: process.env.ELANOUS_SUBSTRATE, p: process.env.LLM_ACCOUNT_POLICY_PACK };
    process.env.ELANOUS_SUBSTRATE = 'pod';
    delete process.env.LLM_ACCOUNT_POLICY_PACK;
    try {
      resetLlmAccountPackCache();
      expect(loadLlmAccountPack().pack).toBeNull();
      expect(decidedCreditAccounts('openai-codex')).toBeUndefined();
    } finally {
      if (saved.s === undefined) delete process.env.ELANOUS_SUBSTRATE; else process.env.ELANOUS_SUBSTRATE = saved.s;
      process.env.LLM_ACCOUNT_POLICY_PACK = saved.p;
      resetLlmAccountPackCache();
    }
  });
  test('a missing or broken repo pack never activates policy — even with a complete, valid overlay', () => {
    writeFileSync(join(dir, 'overlay.yaml'), readFileSync(REPO_PACK, 'utf8'));
    process.env.LLM_ACCOUNT_POLICY_PACK = join(dir, 'absent.yaml');
    resetLlmAccountPackCache();
    let l = loadLlmAccountPack();
    expect([l.pack, l.revision]).toEqual([null, null]);
    expect(l.warnings.some(w => w.startsWith('repo pack missing'))).toBe(true);
    writeFileSync(join(dir, 'broken.yaml'), 'version: 1\nproviders: [oops\n');
    process.env.LLM_ACCOUNT_POLICY_PACK = join(dir, 'broken.yaml');
    resetLlmAccountPackCache();
    l = loadLlmAccountPack();
    expect(l.pack).toBeNull();
    expect(l.warnings).toContain('overlay not applied (no valid repo pack)');
    expect(decidedCreditAccounts('openai-codex')).toBeUndefined();
  });
  test('exit_at must not rise with the level (lint)', () => {
    const raw = parse(readFileSync(REPO_PACK, 'utf8'));
    raw.levels.watermarks.L2 = { below: 10, exit_at: 40 };
    expect(lintPack(raw).errors).toContain('levels.watermarks: exit_at must not rise with the level (L1.exit_at ≥ L2.exit_at ≥ L3.exit_at)');
  });
  test('policy.changed: adoption is silent · a change posts ONE bus line · a held claim or a failed post never moves the marker', () => {
    const { readBus } = require('../../op-context-bus/bus.js') as typeof import('../../op-context-bus/bus.js');
    const state = join(dir, 'state');
    const marker = join(state, 'resource-facts', 'llm-accounts.revision');
    const posts = () => readBus(state).filter(i => i.refs.includes('policy:llm-accounts')).length;
    const markerNow = () => readFileSync(marker, 'utf8').trim();
    const rev0 = loadLlmAccountPack().revision!;
    expect(markerNow()).toBe(rev0);
    expect(posts()).toBe(0);
    // A failed post (the bus file is a directory → unwritable): the marker stays, no claim is left behind.
    mkdirSync(join(state, 'op-context-bus', 'OP.jsonl'), { recursive: true });
    writeFileSync(join(dir, 'overlay.yaml'), 'providers:\n  openai-codex:\n    accounts:\n      default: { credits: false }\n');
    const rev1 = loadLlmAccountPack().revision!;
    expect(rev1).not.toBe(rev0);
    expect(markerNow()).toBe(rev0);
    expect(existsSync(join(state, 'resource-facts', 'llm-accounts.notice.claim'))).toBe(false);
    // Another process holds the claim: no post from here, the marker stays.
    rmSync(join(state, 'op-context-bus', 'OP.jsonl'), { recursive: true, force: true });
    writeFileSync(join(state, 'resource-facts', 'llm-accounts.notice.claim'), '');
    resetLlmAccountPackCache(); loadLlmAccountPack();
    expect(posts()).toBe(0);
    expect(markerNow()).toBe(rev0);
    // The claim is released → the next reader posts exactly once and moves the marker; a further reader posts nothing.
    rmSync(join(state, 'resource-facts', 'llm-accounts.notice.claim'), { force: true });
    resetLlmAccountPackCache(); loadLlmAccountPack();
    resetLlmAccountPackCache(); loadLlmAccountPack();
    expect(posts()).toBe(1);
    expect(markerNow()).toBe(rev1);
  });
  test('no pack → consumers keep the legacy config path (accessors answer undefined)', () => {
    process.env.LLM_ACCOUNT_POLICY_PACK = join(dir, 'absent.yaml');
    resetLlmAccountPackCache();
    expect(decidedCreditAccounts('openai-codex')).toBeUndefined();
    expect(decidedCodexQuotaPolicy()).toBeUndefined();
  });
});

describe('YAML edit (credits off) → the next decision stops credits, no restart', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}`, () => {
      const r = rng(seed);
      // Before: default may spend credits; the codex quota policy reads «credits»; the credits route is allowed.
      expect(decidedCreditAccounts('openai-codex')).toEqual(['default']);
      expect(decidedCodexQuotaPolicy()).toBe('credits');
      const rev0 = loadLlmAccountPack().revision;
      // A few unrelated reads (the same process keeps running) …
      for (let i = 0; i < 1 + Math.floor(r() * 4); i++) expect(decidedCreditAccounts('openai-codex')).toEqual(['default']);
      // … then OP edits the live overlay: credits off for default.
      writeFileSync(join(dir, 'overlay.yaml'), `# seed ${seed}\nproviders:\n  openai-codex:\n    accounts:\n      default: { credits: false }\n`);
      const t0 = Date.now();
      expect(decidedCreditAccounts('openai-codex')).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(30_000);
      expect(loadLlmAccountPack().revision).not.toBe(rev0);
      expect(decidedCodexQuotaPolicy()).toBe('fallback');
      expect(decidedRotationThresholds()).toEqual({ team: 100, third: 100, default: 100 });
    });
  }
});

describe('overrides — ranked, expiring, explained', () => {
  test('CEO «no credits» beats the guardian phase credits-default and an OP allow; the conflict is reported', () => {
    state('credits-default', { 'openai-codex:team': 'L3', 'openai-codex:third': 'L3', 'openai-codex:default': 'L3' });
    expect(decidedCreditAccounts('openai-codex')).toEqual(['default']);
    const op = setOverride({ by: 'OP', scope: 'openai-codex:default', action: 'credits_allow', why: 'keep the train moving', until: '6h' });
    const ceo = setOverride({ by: 'CEO', scope: 'openai-codex', action: 'credits_deny', why: 'no credits today', until: '12h', ref: 'dec-1630', crownApproves });
    expect('event' in op && 'event' in ceo).toBe(true);
    const d = llmAccountDecision();
    const def = d.accounts.find(a => a.id === 'openai-codex:default')!;
    expect(def.credits.value).toBe(false);
    expect(def.credits.winner!.layer).toBe('CEO');
    expect(d.conflicts.some(c => c.knob === 'credits' && c.winner === 'CEO=false' && c.loser.startsWith('OP=true'))).toBe(true);
    const lines = explainLines(d, 'default').join('\n');
    expect(lines).toContain('credits OFF because override by CEO');
    expect(lines).toContain('no credits today');
    expect(decidedCodexQuotaPolicy()).toBe('fallback');
  });
  test('a CEO override without its crown ref is refused; GUARDIAN cannot clear an OP override', () => {
    expect(setOverride({ by: 'CEO', scope: '*', action: 'credits_deny', why: 'x' })).toEqual({ error: 'a CEO override needs --crown <decision id> (the CEO decision it carries out)' });
    // The live lookup: a ref that is not a decision in (this test's empty) decisions ledger is refused.
    expect(setOverride({ by: 'CEO', scope: '*', action: 'credits_deny', why: 'x', ref: 'dec-forged' })).toEqual({ error: 'crown dec-forged is not a CEO decision answered with an option that carries out credits_deny *' });
    expect(setOverride({ by: 'TC', scope: '*', action: 'credits_deny', why: 'x' })).toEqual({ error: 'by TC cannot set an override (CEO|OP|RES|GUARDIAN) — other seats ask OP' });
    expect(setOverride({ by: 'OP', scope: 'openai-codex:team', action: 'mode:maintenance', why: 'x' })).toEqual({ error: "mode:maintenance is global — use --scope '*'" });
    const op = setOverride({ by: 'OP', scope: 'openai-codex:team', action: 'skip', why: 'team flaky' });
    if (!('event' in op)) throw new Error(op.error);
    expect(clearOverride({ by: 'GUARDIAN', id: op.event.id, why: 'auto' })).toEqual({ error: `GUARDIAN cannot clear a OP override (${op.event.id}) — rank CEO > OP=RES > GUARDIAN` });
    expect('event' in clearOverride({ by: 'OP', id: op.event.id, why: 'team ok again' })).toBe(true);
  });
  test('expiry restores the policy — until passed, or until_event reset seen', () => {
    const t0 = new Date('2026-11-27T16:30:00Z');
    const a = setOverride({ by: 'CEO', scope: '*', action: 'credits_deny', why: 'no credits', until: '2h', ref: 'dec-1', now: t0, crownApproves });
    const b = setOverride({ by: 'OP', scope: 'openai-codex:default', action: 'credits_deny', why: 'until team/third reset', until: '24h', untilEvent: 'reset:openai-codex:team,openai-codex:third', now: t0 });
    if (!('event' in a) || !('event' in b)) throw new Error('set failed');
    const loaded = loadLlmAccountPack();
    const { events } = require('./llm-decide.js').readLlmPolicyEvents() as { events: never[] };
    const at = (iso: string, st: Parameters<typeof decideLlmAccounts>[0]['state'] = null) => decideLlmAccounts({ loaded, state: st, events, now: new Date(iso) });
    expect(at('2026-11-27T17:00:00Z').accounts.find(x => x.account === 'default')!.credits.value).toBe(false);
    // 3 h later the CEO override has expired; OP's still holds until the reset.
    const later = at('2026-11-27T19:30:00Z');
    expect(later.overrides.expired.map(e => e.o.id)).toEqual([a.event.id]);
    expect(later.accounts.find(x => x.account === 'default')!.credits.value).toBe(false);
    // team and third back at L0 after the override → it expires, default credits back ON (pack).
    const reset = { event: 'llm-state' as const, at: '2026-11-27T20:00:00Z', by: 'GUARDIAN' as const, revision: null, phase: 'normal', phaseSince: '2026-11-27T20:00:00Z',
      levels: { 'openai-codex:team': { level: 'L0' as const, since: '2026-11-27T19:59:00Z' }, 'openai-codex:third': { level: 'L0' as const, since: '2026-11-27T19:59:00Z' } } };
    const after = at('2026-11-27T20:01:00Z', reset);
    expect(after.overrides.active).toEqual([]);
    expect(after.accounts.find(x => x.account === 'default')!.credits.value).toBe(true);
  });
  test('safety (credit floor) denies above OP and guardian; only the CEO lifts it', () => {
    state('credits-default', { 'openai-codex:team': 'L3', 'openai-codex:third': 'L3', 'openai-codex:default': 'L3', 'openai-codex:default:credits': 'L3' });
    setOverride({ by: 'OP', scope: 'openai-codex:default', action: 'credits_allow', why: 'push through' });
    let def = llmAccountDecision().accounts.find(a => a.account === 'default')!;
    expect([def.credits.value, def.credits.winner!.layer]).toEqual([false, 'safety']);
    setOverride({ by: 'CEO', scope: 'openai-codex:default:credits', action: 'credits_allow', why: 'demo tonight', ref: 'dec-7', crownApproves });
    def = llmAccountDecision().accounts.find(a => a.account === 'default')!;
    expect([def.credits.value, def.credits.winner!.layer]).toEqual([true, 'CEO']);
  });
  test('the YAML chain order is kept (codex-credits first) · an index starting at OpenRouter is respected · credits off drop the credits step', () => {
    expect(decidedFallbackChain()).toEqual(['codex-credits', 'openrouter']);
    // The policy order and its index are respected — nothing is inserted ahead of a chain that starts at OpenRouter.
    setOverride({ by: 'OP', scope: '*', action: 'fallback:1', why: 'start at OpenRouter' });
    expect(decidedFallbackChain()).toEqual(['openrouter']);
    resetLlmDecisionCache();
    require('node:fs').writeFileSync(join(dir, 'events.jsonl'), '');
    writeFileSync(join(dir, 'overlay.yaml'), 'providers:\n  openai-codex:\n    accounts:\n      default: { credits: false }\n');
    expect(decidedFallbackChain()).toEqual(['openrouter']);
  });
  test('a skipped account with credits is NOT on the subscription route — credits path only; rotation leaves it at once', () => {
    state('credits-default', { 'openai-codex:team': 'L3', 'openai-codex:third': 'L3', 'openai-codex:default': 'L3' });
    const def = llmAccountDecision().accounts.find(a => a.account === 'default')!;
    expect([def.subscriptionRoutable, def.credits.value, def.routable, def.rotateAtPercent]).toEqual([false, true, true, 0]);
    expect(decidedCreditAccounts('openai-codex')).toEqual(['default']);
  });
  test('a valid policy that leaves no fallback step answers [] — never undefined (legacy)', () => {
    writeFileSync(join(dir, 'overlay.yaml'), 'fallback: [codex-credits]\nproviders:\n  openai-codex:\n    accounts:\n      default: { credits: false }\n');
    expect(decidedFallbackChain()).toEqual([]);
  });
  test('an until_event override that expired stays expired when the level rises again (ledger history)', () => {
    const t0 = Date.now();
    const o = setOverride({ by: 'OP', scope: 'openai-codex:default', action: 'credits_deny', why: 'until team resets', untilEvent: 'reset:openai-codex:team', now: new Date(t0) });
    if (!('event' in o)) throw new Error(o.error);
    state('normal', { 'openai-codex:team': 'L0' }, new Date(t0 + 60_000).toISOString());
    state('subscription-tight', { 'openai-codex:team': 'L3' }, new Date(t0 + 120_000).toISOString());
    const d = llmAccountDecision('sim', new Date(t0 + 180_000));
    expect(d.overrides.active).toEqual([]);
    expect(d.overrides.expired.map(e => e.o.id)).toEqual([o.event.id]);
  });
  test('a CEO approval names its scope — one account\'s credits_allow never authorizes *', () => {
    const { optionApproves } = require('./llm-override.js') as typeof import('./llm-override.js');
    expect(optionApproves('approve credits_allow openai-codex:default:credits tonight', 'credits_allow', 'openai-codex:default:credits')).toBe(true);
    expect(optionApproves('approve credits_allow openai-codex:default:credits tonight', 'credits_allow', '*')).toBe(false);
    expect(optionApproves('approve credits_allow openai-codex:default:credits tonight', 'credits_allow', 'openai-codex:default')).toBe(false);
    expect(optionApproves('no credits today: credits_deny *', 'credits_deny', '*')).toBe(true);
    expect(optionApproves('수호자가 CEO mode:credits-default 오버라이드를 쓴다', 'mode:credits-default', '*')).toBe(true);
    // Whole tokens: fallback:10 never approves fallback:1; mode:credits never approves mode:credits-default.
    expect(optionApproves('start at fallback:10', 'fallback:1', '*')).toBe(false);
    expect(optionApproves('start at fallback:1 tonight', 'fallback:1', '*')).toBe(true);
    expect(optionApproves('enter mode:credits-default', 'mode:credits', '*')).toBe(false);
  });
  test('applied reports are per process — two processes of one consumer never overwrite each other', () => {
    const { reportApplied, readAppliedReports, appliedDir } = require('./llm-decide.js') as typeof import('./llm-decide.js');
    reportApplied('sim-shared', 'aaaaaaaaaaaa', 'normal', new Date());
    writeFileSync(join(appliedDir(), 'sim-shared@other-host-1.json'), JSON.stringify({ consumer: 'sim-shared', revision: 'bbbbbbbbbbbb', phase: 'normal', at: new Date().toISOString(), host: 'other-host', pid: 1 }));
    expect(readAppliedReports().filter(r => r.consumer === 'sim-shared').map(r => r.revision).sort()).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  });
  test('demote moves an account behind the others even at L0', () => {
    const { decidedAccountOrder } = require('./llm-decide.js') as typeof import('./llm-decide.js');
    setOverride({ by: 'OP', scope: 'openai-codex:team', action: 'demote', why: 'team flaky' });
    expect(decidedAccountOrder('openai-codex')).toEqual(['third', 'default', 'team']);
  });
  test('a consumer deciding right after a change is written at once (stale within the grace, not 5 min later)', () => {
    const { reportApplied, readAppliedReports } = require('./llm-decide.js') as typeof import('./llm-decide.js');
    const t0 = Date.now();
    reportApplied('sim-old', 'aaaaaaaaaaaa', 'normal', new Date(t0), 0);
    reportApplied('sim-old', 'aaaaaaaaaaaa', 'normal', new Date(t0 + 60_000), t0 + 10_000);
    expect(readAppliedReports().find(r => r.consumer === 'sim-old')!.at).toBe(new Date(t0 + 60_000).toISOString());
    const v = judgeConsumers(readAppliedReports().filter(r => r.consumer === 'sim-old'), { revision: 'bbbbbbbbbbbb', changedAtMs: t0 + 10_000 });
    expect(v[0]!.status).toBe('stale');
  });
  test('clears: read from and written to the same ledger · rank and crown checked on every append path', () => {
    const alt = join(dir, 'alt-events.jsonl');
    const op = setOverride({ by: 'OP', scope: 'openai-codex:team', action: 'skip', why: 'team flaky' }, alt);
    if (!('event' in op)) throw new Error(op.error);
    expect(clearOverride({ by: 'GUARDIAN', id: op.event.id, why: 'auto' }, alt)).toEqual({ error: `GUARDIAN cannot clear a OP override (${op.event.id}) — rank CEO > OP=RES > GUARDIAN` });
    const at = new Date().toISOString();
    expect(() => recordLlmPolicyEvent({ event: 'llm-override', at, by: 'GUARDIAN', op: 'clear', id: op.event.id, why: 'direct' }, alt)).toThrow('cannot clear a OP override');
    expect(() => recordLlmPolicyEvent({ event: 'llm-override', at, by: 'CEO', op: 'clear', id: op.event.id, why: 'no crown' }, alt)).toThrow();
    expect('event' in clearOverride({ by: 'OP', id: op.event.id, why: 'team ok' }, alt)).toBe(true);
  });
  test('a valid pack with nothing routable answers [] — never the old config order', () => {
    const { decidedAccountOrder } = require('./llm-decide.js') as typeof import('./llm-decide.js');
    expect(decidedAccountOrder('openai-codex')).toEqual(['team', 'third', 'default']);
    state('fallback-openrouter', { 'openai-codex:team': 'L3', 'openai-codex:third': 'L3', 'openai-codex:default': 'L3', 'openai-codex:default:credits': 'L2' });
    expect(decidedAccountOrder('openai-codex')).toEqual([]);
  });
  test('a level action mode:<phase> is a phase claim (rank level) and shows in explain', () => {
    writeFileSync(join(dir, 'overlay.yaml'), "levels:\n  actions:\n    L2: [demote, tier_down, 'mode:maintenance']\n");
    state('normal', { 'openai-codex:team': 'L2' });
    const d = llmAccountDecision();
    expect(d.phase.value).toBe('normal');
    expect(d.phase.claims.map(c => [c.layer, c.value])).toEqual([['GUARDIAN', 'normal'], ['level', 'maintenance']]);
    expect(explainLines(d).join('\n')).toContain('✗ level maintenance: level L2 on openai-codex:team → mode:maintenance');
  });
  test('the ledger disappearing keeps the last good overrides (a CEO deny never silently vanishes); a CEO line without its crown is never appended', () => {
    setOverride({ by: 'CEO', scope: '*', action: 'credits_deny', why: 'no credits', ref: 'dec-1', crownApproves });
    expect(decidedCreditAccounts('openai-codex')).toEqual([]);
    rmSync(join(dir, 'events.jsonl'), { force: true });
    const { readLlmPolicyEvents } = require('./llm-decide.js') as typeof import('./llm-decide.js');
    const r = readLlmPolicyEvents(Date.now() + 60_000);
    expect(r.events.length).toBe(1);
    expect(r.warning).toContain('disappeared');
    expect(() => recordLlmPolicyEvent({ event: 'llm-override', at: new Date().toISOString(), by: 'CEO', op: 'set', id: 'ovr-x', scope: '*', action: 'credits_allow', why: 'forged', until: new Date(Date.now() + 3_600_000).toISOString() }, join(dir, 'events.jsonl'))).toThrow();
  });
  test('a :credits scope reaches the credits knob only — never the account routing', () => {
    setOverride({ by: 'OP', scope: 'openai-codex:default:credits', action: 'skip', why: 'aimed at credits' });
    setOverride({ by: 'OP', scope: 'openai-codex:default:credits', action: 'credits_deny', why: 'no credits for default' });
    const def = llmAccountDecision().accounts.find(a => a.account === 'default')!;
    expect([def.skip.value, def.credits.value, def.routable]).toEqual([false, false, true]);
  });
  test('phase fallback-openrouter: codex not routable, chain from step 0', () => {
    state('fallback-openrouter', { 'openai-codex:team': 'L3', 'openai-codex:third': 'L3', 'openai-codex:default': 'L3', 'openai-codex:default:credits': 'L2' });
    const d = llmAccountDecision();
    expect(d.route['openai-codex']).toEqual([]);
    expect(decidedCreditAccounts('openai-codex')).toEqual([]);
    expect(decidedFallbackChain()).toEqual(['openrouter']);
    expect(decidedRotationThresholds()).toEqual({ team: 0, third: 0, default: 0 });
  });
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`rank invariant under random override order (seed ${seed})`, () => {
      const r = rng(seed);
      const actors = ['GUARDIAN', 'OP', 'RES', 'CEO'] as const;
      const rank: Record<string, number> = { GUARDIAN: 1, OP: 2, RES: 2, CEO: 3 };
      const sets: Array<{ by: string; allow: boolean; i: number }> = [];
      for (let i = 0; i < 6; i++) {
        const by = actors[Math.floor(r() * actors.length)]!;
        const allow = r() < 0.5;
        const res = setOverride({ by, scope: 'openai-codex:team', action: allow ? 'credits_allow' : 'credits_deny', why: `s${seed}#${i}`, ref: 'dec-x', crownApproves, now: new Date(Date.now() - 60_000 + i * 1000) });
        if (!('event' in res)) throw new Error(res.error);
        sets.push({ by, allow, i });
      }
      const top = Math.max(...sets.map(s => rank[s.by]!));
      const expected = sets.filter(s => rank[s.by] === top).at(-1)!;
      const team = llmAccountDecision().accounts.find(a => a.account === 'team')!;
      expect(team.credits.value).toBe(expected.allow);
    });
  }
});

// LLM-POLICY-CREDIT-MIX-YAML — the HQ overlay as the operator writes it (every provider · [overlay] layer).
const HQ_OVERLAY = `providers:
  openai-codex:
    credit_order: by_balance_desc
    accounts:
      team:  { credits: until_reset }
      third: { credits: until_reset }
      default: { credits: true }
  grok:
    accounts:
      default: { subscription_cap_percent: 70, credits: false }
  zai:
    accounts:
      plan-5h:   { uses: { review: false } }
      plan-week: { uses: { review: false } }
  openrouter:
    accounts:
      default: { credits: true, daily_credit_budget: 50, credit_floor: 5 }
`;
function creditState(levels: Record<string, string>, balances: Record<string, number>, at = new Date().toISOString()): void {
  recordLlmPolicyEvent({ event: 'llm-state', at, by: 'GUARDIAN', revision: null, phase: 'credits-default', phaseSince: at,
    levels: Object.fromEntries(Object.entries(levels).map(([k, l]) => [k, { level: l as 'L0', since: at }])),
    credits: Object.fromEntries(Object.entries(balances).map(([k, b]) => [`${k}:credits`, { day: at.slice(0, 10), startBalance: b, balance: b, spent: 0 }])) },
  process.env.RESOURCE_FACTS_LEDGER!);
  resetLlmDecisionCache();
}

describe('credit mix as YAML — every provider · until_reset · credit_order · uses · [overlay] layer', () => {
  test('paid-credit phase: team 14k · third 22k · default 8.5k → credit route third → team → default (by_balance_desc)', () => {
    writeFileSync(join(dir, 'overlay.yaml'), HQ_OVERLAY);
    creditState({ 'openai-codex:team': 'L3', 'openai-codex:third': 'L3', 'openai-codex:default': 'L3' },
      { 'openai-codex:team': 14_000, 'openai-codex:third': 22_000, 'openai-codex:default': 8_500 });
    const d = llmAccountDecision();
    expect(d.creditRoute['openai-codex']).toEqual({ order: 'by_balance_desc', accounts: ['third', 'team', 'default'] });
    expect(decidedCreditAccounts('openai-codex')!.sort()).toEqual(['default', 'team', 'third']);
    const lines = explainLines(d, 'team').join('\n');
    expect(lines).toContain('credits ON because [overlay] providers.openai-codex.accounts.team.credits=until_reset — subscription exhausted (L3): credits ON until it resets');
    expect(lines).toContain('credit route openai-codex (by_balance_desc): third → team → default');
  });
  test('team resets → team back to subscription, credits off; third and default keep the credit route', () => {
    writeFileSync(join(dir, 'overlay.yaml'), HQ_OVERLAY);
    creditState({ 'openai-codex:team': 'L0', 'openai-codex:third': 'L3', 'openai-codex:default': 'L3' },
      { 'openai-codex:team': 14_000, 'openai-codex:third': 22_000, 'openai-codex:default': 8_500 });
    const d = llmAccountDecision();
    const team = d.accounts.find(a => a.id === 'openai-codex:team')!;
    expect([team.credits.value, team.subscriptionRoutable]).toEqual([false, true]);
    expect(team.credits.winner!.why).toContain('subscription not exhausted (L0): subscription only');
    expect(d.creditRoute['openai-codex']!.accounts).toEqual(['third', 'default']);
  });
  test('listed credit_order keeps the pack order', () => {
    writeFileSync(join(dir, 'overlay.yaml'), HQ_OVERLAY.replace('credit_order: by_balance_desc', 'credit_order: listed'));
    creditState({ 'openai-codex:team': 'L3', 'openai-codex:third': 'L3', 'openai-codex:default': 'L3' },
      { 'openai-codex:team': 14_000, 'openai-codex:third': 22_000, 'openai-codex:default': 8_500 });
    expect(llmAccountDecision().creditRoute['openai-codex']).toEqual({ order: 'listed', accounts: ['team', 'third', 'default'] });
  });
  test('every provider in one vocabulary: grok window · zai never for review · OpenRouter prepaid $ with budget/floor', () => {
    writeFileSync(join(dir, 'overlay.yaml'), HQ_OVERLAY);
    const l = loadLlmAccountPack();
    expect(l.errors).toEqual([]);
    expect(l.leafSources['providers.openai-codex.accounts.team.credits']).toBe('overlay');
    expect(l.leafSources['providers.zai.accounts.plan-5h.uses.review']).toBe('overlay');
    const d = llmAccountDecision();
    const by = (id: string) => d.accounts.find(a => a.id === id)!;
    expect(by('zai:plan-5h').uses.review).toBe(false);
    expect(by('zai:plan-5h').uses.implementation).toBe(true);
    expect(by('grok:default').capPercent).toBe(70);
    expect([by('openrouter:default').capPercent, by('openrouter:default').credits.value]).toEqual([null, true]);
    const text = explainLines(d).join('\n');
    expect(text).toContain('zai:plan-week · level L0 · credit level L0 · cap 100% → rotate at 100% · subscription routable · never for review');
    expect(text).toContain('openrouter:default · level L0 · credit level L0 · no subscription window (prepaid)');
  });
  test('lint names the vocabulary: credits true|false|until_reset · credit_order · uses', () => {
    const raw = parse(readFileSync(REPO_PACK, 'utf8'));
    raw.providers['openai-codex'].accounts.team.credits = 'maybe';
    raw.providers['openai-codex'].credit_order = 'random';
    raw.providers.zai.accounts['plan-5h'].uses = { deploy: false };
    const e = lintPack(raw).errors;
    expect(e).toContain('providers.openai-codex.accounts.team.credits must be true|false|until_reset');
    expect(e).toContain('providers.openai-codex.credit_order must be by_balance_desc|listed');
    expect(e).toContain('unknown field providers.zai.accounts.plan-5h.uses.deploy (implementation|review|judge|chat)');
  });
});

describe('consumers — applied revision · stale flagged', () => {
  test('stale = decided with an old revision after the new one was on disk; idle = not decided since', () => {
    const changed = Date.parse('2026-11-27T16:40:00Z');
    const v = judgeConsumers([
      { consumer: 'codex-rotation', revision: 'bbbbbbbbbbbb', phase: 'normal', at: '2026-11-27T16:40:05Z', host: 'h', pid: 1 },
      { consumer: 'pod-snapshot', revision: 'aaaaaaaaaaaa', phase: 'normal', at: '2026-11-27T16:42:00Z', host: 'h', pid: 2 },
      { consumer: 'grok-cap', revision: 'aaaaaaaaaaaa', phase: 'normal', at: '2026-11-27T16:10:00Z', host: 'h', pid: 3 },
    ], { revision: 'bbbbbbbbbbbb', changedAtMs: changed });
    expect(v.map(x => [x.consumer, x.status])).toEqual([['codex-rotation', 'current'], ['pod-snapshot', 'stale'], ['grok-cap', 'idle']]);
  });
  test('a consumer decision writes its applied report with the current revision', () => {
    llmAccountDecision('sim-consumer');
    const { readAppliedReports } = require('./llm-decide.js') as typeof import('./llm-decide.js');
    const rep = readAppliedReports().find(x => x.consumer === 'sim-consumer');
    expect(rep?.revision).toBe(loadLlmAccountPack().revision);
  });
});
