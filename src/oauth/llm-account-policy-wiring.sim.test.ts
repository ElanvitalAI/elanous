// LLM-ACCOUNT-POLICY-WIRING sim (seeds 1–5) — the consumers (codex quota policy · credit allow list · llm-route veto ·
// fallback chain · child chain) read the ONE decision of the policy pack and keep their legacy path without a pack.
// Expectations are literals (rule 11): account names, ranks and phase names are spelled here, not imported from the product.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadLlmAccountPack, resetLlmAccountPackCache } from '../kit/resource-facts/llm-accounts.js';
import { decidedCodexQuotaPolicy, llmAccountDecision, resetAppliedBeats, resetLlmDecisionCache } from '../kit/resource-facts/llm-decide.js';
import { setOverride } from '../kit/resource-facts/llm-override.js';
import { recordLlmPolicyEvent } from '../resource-ledger/resource-ledger.js';
import { readCodexCreditAccounts } from './codex-credit-accounts.js';
import { resolveCodexQuotaPolicy } from './codex-quota-policy.js';
import { accountPolicyVeto } from '../llm-route/route-store.js';

const REPO_PACK = resolve(import.meta.dir, '../../graphs/policies/llm-accounts.yaml');
let dir = '';
const saved: Record<string, string | undefined> = {};
const ENV = ['LLM_ACCOUNT_POLICY_PACK', 'LLM_ACCOUNT_POLICY_OVERLAY', 'RESOURCE_FACTS_LEDGER', 'ELANOUS_CODEX_QUOTA_POLICY', 'ELANOUS_STATE_DIR'] as const;

function rng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function state(phase: string, levels: Record<string, string>, at = new Date().toISOString()): void {
  recordLlmPolicyEvent({ event: 'llm-state', at, by: 'GUARDIAN', revision: null, phase, phaseSince: at,
    levels: Object.fromEntries(Object.entries(levels).map(([k, l]) => [k, { level: l as 'L0', since: at }])) }, process.env.RESOURCE_FACTS_LEDGER!);
  resetLlmDecisionCache();
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'llm-wiring-sim-'));
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

describe('consumers read the decision — YAML edit (credits off) stops credits on the next call, no restart', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}`, () => {
      const r = rng(seed);
      const creditsRoute = { provider: 'codex', accounts: ['default'], engine: 'terra', model: 'gpt-6.1-terra', cost: 'credits' as const };
      expect(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'fallback' }, undefined, decidedCodexQuotaPolicy())).toEqual({ policy: 'credits', source: 'policy-pack' });
      expect(readCodexCreditAccounts(() => ({ codexCreditAccounts: [] }))).toEqual({ names: ['default'], source: 'policy-pack' });
      expect(accountPolicyVeto(creditsRoute)).toBeNull();
      for (let i = 0; i < 1 + Math.floor(r() * 4); i++) expect(readCodexCreditAccounts(() => undefined).names).toEqual(['default']);
      writeFileSync(join(dir, 'overlay.yaml'), `# seed ${seed}\nproviders:\n  openai-codex:\n    accounts:\n      default: { credits: false }\n`);
      expect(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'credits' }, 'use', decidedCodexQuotaPolicy())).toEqual({ policy: 'fallback', source: 'policy-pack' });
      expect(readCodexCreditAccounts(() => ({ codexCreditAccounts: ['default'] }))).toEqual({ names: [], source: 'policy-pack' });
      expect(accountPolicyVeto(creditsRoute)).toContain('openai-codex:default credits OFF');
    });
  }
});

describe('legacy path without a pack', () => {
  test('no pack → the config list stands', () => {
    process.env.LLM_ACCOUNT_POLICY_PACK = join(dir, 'absent.yaml');
    resetLlmAccountPackCache();
    expect(readCodexCreditAccounts(() => ({ codexCreditAccounts: ['default'] }), () => undefined)).toEqual({ names: ['default'], source: 'config' });
    expect(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'credits' }, undefined, decidedCodexQuotaPolicy())).toEqual({ policy: 'credits', source: 'config' });
  });
  test('a Pod child uses the host-carried snapshot values, never its image copy of the pack', () => {
    const keep = { s: process.env.ELANOUS_SUBSTRATE, p: process.env.LLM_ACCOUNT_POLICY_PACK };
    process.env.ELANOUS_SUBSTRATE = 'pod';
    delete process.env.LLM_ACCOUNT_POLICY_PACK;
    try {
      resetLlmAccountPackCache();
      expect(loadLlmAccountPack().pack).toBeNull();
      expect(readCodexCreditAccounts(() => ({ codexCreditAccounts: [] }), () => undefined)).toEqual({ names: [], source: 'config' });
    } finally {
      if (keep.s === undefined) delete process.env.ELANOUS_SUBSTRATE; else process.env.ELANOUS_SUBSTRATE = keep.s;
      process.env.LLM_ACCOUNT_POLICY_PACK = keep.p;
      resetLlmAccountPackCache();
    }
  });
});

describe('chain · route veto · child chain', () => {
  test('effectiveFallbackChain = the pack chain (order and index kept) · normalizeFallbackChain stays pure', () => {
    const fc = require('./fallback-chain.js') as typeof import('./fallback-chain.js');
    expect(fc.effectiveFallbackChain(['grok'], 'auto')).toMatchObject({ chain: ['codex-credits', 'openrouter'], source: 'policy-pack' });
    expect(fc.normalizeFallbackChain(['grok'], 'auto').chain).toEqual(['grok']);
    setOverride({ by: 'OP', scope: '*', action: 'fallback:1', why: 'start at OpenRouter' });
    expect(fc.effectiveFallbackChain(['grok'], 'auto').chain).toEqual(['openrouter']);
    process.env.LLM_ACCOUNT_POLICY_PACK = join(dir, 'absent.yaml');
    resetLlmAccountPackCache();
    expect(fc.effectiveFallbackChain(['grok'], 'auto')).toMatchObject({ chain: ['grok'], source: 'config' });
  });
  test('a skipped account with credits: subscription route vetoed (credits path only) · a credits route needs a non-skipped account', () => {
    state('credits-default', { 'openai-codex:team': 'L3', 'openai-codex:third': 'L3', 'openai-codex:default': 'L3' });
    expect(accountPolicyVeto({ provider: 'codex', accounts: ['default'], engine: 'terra', model: 'gpt-6.1-terra', cost: 'subscription' })).toContain('(credits path only)');
    expect(accountPolicyVeto({ provider: 'codex', accounts: ['default'], engine: 'terra', model: 'gpt-6.1-terra', cost: 'credits' })).toContain('openai-codex:default skipped');
    expect(readCodexCreditAccounts(() => undefined).names).toEqual(['default']);
    expect(llmAccountDecision().accounts.find(a => a.account === 'default')!.rotateAtPercent).toBe(0);
  });
  test('a policy leaving no step: effectiveFallbackChain = [] (never the legacy default)', () => {
    writeFileSync(join(dir, 'overlay.yaml'), 'fallback: [codex-credits]\nproviders:\n  openai-codex:\n    accounts:\n      default: { credits: false }\n');
    const fc = require('./fallback-chain.js') as typeof import('./fallback-chain.js');
    expect(fc.effectiveFallbackChain(['grok'], 'auto')).toEqual({ chain: [], dropped: [], usedDefault: false, source: 'policy-pack' });
  });
  test('the warm Pod path carries the policy-applied chain (same as a fresh Job)', () => {
    const { siWarmFallbackFiles } = require('../task-orchestrator/surfaces/pod-si-warm-host.js') as typeof import('../task-orchestrator/surfaces/pod-si-warm-host.js');
    const files = siWarmFallbackFiles(['openrouter'], { grokApiKey: 'k' }, 'auto', ['codex-rotate', 'grok']);
    expect(JSON.parse(files['llm-fallback-config.json']!)).toEqual({ llm: { fallbackChain: ['codex-rotate', 'grok'] } });
  });
  test('the REAL acquireSiWarmChild entry hands the policy chain to the warm bundle (only the lease/launch boundary stubbed)', async () => {
    const host = require('../task-orchestrator/surfaces/pod-si-warm-host.js') as typeof import('../task-orchestrator/surfaces/pod-si-warm-host.js');
    // Policy chain = [codex-rotate] (all carryable); the config says only [openrouter] (not carryable to a warm Pod).
    writeFileSync(join(dir, 'overlay.yaml'), 'fallback: [codex-rotate]\n');
    const seen: Array<Record<string, string>> = [];
    host._setSiWarmLeaseForTesting(async (prepared) => {
      seen.push((JSON.parse(Buffer.from(prepared.credentialBundle).toString('utf8')) as { files: Record<string, string> }).files);
      return { status: 'no-entry', reason: 'invalid-input' } as never;
    });
    const input = { spaceId: 'space-a', feature: 'policy chain on the warm path', base: 'HEAD', autoMerge: false, openPr: true, draft: true };
    const options = {
      fallbackConfig: () => ({ llm: { provider: 'auto', fallbackChain: ['openrouter'] } }) as never,
      credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh-test' }),
    };
    try {
      await host.acquireSiWarmChild(input as never, options as never);
      expect(seen.length).toBe(1);
      expect(JSON.parse(seen[0]!['llm-fallback-config.json']!)).toEqual({ llm: { fallbackChain: ['codex-rotate'] } });
      // A policy chain with a step the warm runner cannot carry → the cold Job path whole (no lease, no truncated chain).
      writeFileSync(join(dir, 'overlay.yaml'), 'fallback: [codex-rotate, codex-credits, openrouter]\n');
      expect(await host.acquireSiWarmChild(input as never, options as never)).toEqual({ status: 'no-entry', reason: 'invalid-input' });
      expect(seen.length).toBe(1);
      // Without a pack the config chain [openrouter] stands — nothing carryable → no lease at all (cold path).
      process.env.LLM_ACCOUNT_POLICY_PACK = join(dir, 'absent.yaml');
      resetLlmAccountPackCache();
      expect(await host.acquireSiWarmChild(input as never, options as never)).toEqual({ status: 'no-entry', reason: 'invalid-input' });
      expect(seen.length).toBe(1);
      // Without a pack a MIXED config chain keeps the old behavior: the carryable steps run warm (no whole-chain rule).
      const mixed = { ...options, fallbackConfig: () => ({ llm: { provider: 'auto', fallbackChain: ['codex-rotate', 'openrouter'] } }) as never };
      await host.acquireSiWarmChild(input as never, mixed as never);
      expect(seen.length).toBe(2);
      expect(JSON.parse(seen[1]!['llm-fallback-config.json']!)).toEqual({ llm: { fallbackChain: ['codex-rotate'] } });
    } finally { host._setSiWarmLeaseForTesting(null); }
  });
  test('alloc budget: the pack\'s grok cap holds unless a trusted budget row sets grok itself', () => {
    writeFileSync(join(dir, 'overlay.yaml'), 'providers:\n  grok:\n    weekly_cap_percent: 60\n');
    const { effectivePolicy } = require('../allocation/policy.js') as typeof import('../allocation/policy.js');
    expect(effectivePolicy([]).providers.grok!.windowCapPct).toBe(60);
    const row = (providers: Record<string, unknown>) => ({ event: 'alloc-budget-policy', at: new Date().toISOString(), by: 'OP', policy: { providers } });
    const withoutGrok = effectivePolicy([row({ openrouter: { dailyUsd: 10 } })] as never);
    expect([withoutGrok.providers.grok!.windowCapPct, withoutGrok.providers.openrouter!.dailyUsd]).toEqual([60, 10]);
    expect(effectivePolicy([row({ grok: { windowCapPct: 40 } })] as never).providers.grok!.windowCapPct).toBe(40);
  });
  test('a veto that cannot be evaluated fails closed for a credits route only (no pack = no veto)', () => {
    const { pickRoute } = require('../llm-route/router.js') as typeof import('../llm-route/router.js');
    const routes = {
      'or-credits': { provider: 'openrouter', accounts: ['default'], engine: 'glm', model: 'z-ai/glm-5.3', cost: 'credits' as const },
      'sub': { provider: 'codex', accounts: ['team'], engine: 'terra', model: 'gpt-6.1-terra', cost: 'subscription' as const },
    };
    const policy = { version: 1, capPct: 95, alarmTo: 'OP', routes, uses: { u: { order: ['or-credits', 'sub'] } } };
    const boom = () => { throw new Error('policy read failed'); };
    const p = pickRoute({ policy, use: 'u', usage: [], health: {}, nowMs: Date.now(), veto: boom });
    expect(p.route).toBe('sub');
    expect(p.skipped).toEqual([{ route: 'or-credits', reason: 'account policy: account policy could not be evaluated — credits route fails closed' }]);
    expect(pickRoute({ policy, use: 'u', usage: [], health: {}, nowMs: Date.now(), veto: () => null }).route).toBe('or-credits');
  });
  test('route veto judges every account: one the policy does not name may not spend credits (never skips the veto)', () => {
    const credits = (accounts: string[]) => accountPolicyVeto({ provider: 'codex', accounts, engine: 'terra', model: 'gpt-6.1-terra', cost: 'credits' });
    expect(credits(['ghost'])).toBe('openai-codex:ghost not in the policy — credits not allowed');
    expect(credits(['ghost', 'default'])).toBeNull(); // default may spend credits and is not skipped
    expect(accountPolicyVeto({ provider: 'codex', accounts: ['ghost'], engine: 'terra', model: 'gpt-6.1-terra', cost: 'subscription' })).toBeNull();
    expect(accountPolicyVeto({ provider: 'zai', accounts: ['plan-5h'], engine: 'glm', model: 'glm-5.3', cost: 'subscription' })).toBeNull();
  });
  test('provider=auto with no configured chain keeps the POLICY chain for the child (never blanked to the legacy default)', () => {
    const { resolveChildLlmPreference } = require('../self-implement/child-llm-preference.js') as typeof import('../self-implement/child-llm-preference.js');
    const r = resolveChildLlmPreference({ llm: { provider: 'auto' }, tools: { selfImplement: {} } } as never);
    expect(r.chain.map(c => c.provider)).toEqual(['openai-codex', 'openrouter']);
    expect(r.chain[0]).toMatchObject({ codexCredits: true });
  });
});
