import { describe, expect, test } from 'bun:test';
import { DEFAULT_ROUTE_POLICY, loadRoutePolicy, policyFromFacts, resolveUse, readRouterState, writeRouterState } from './route-store.js';
import { acceptReviewModel, resetResourceFactsCache, resolveFacts } from '../kit/resource-facts/index.js';
import { classifyFailure, decideRoute, markFail, markOk, pickRoute, reportResult, routeHealthy, type RouterPorts, type RouterState, type UsageRow } from './router.js';
import { selfReviewArgsFor } from './route-cli.js';
import { judgeReviewEnd } from './review-start.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = Date.parse('2026-11-27T01:00:00.000Z');
const row = (provider: string, account: string, used: number | 'error'): UsageRow => used === 'error'
  ? { provider, account, usedPercent: null, status: 'error' } : { provider, account, usedPercent: used, status: 'ok' };
const today = (over: Partial<Record<string, number | 'error'>> = {}): UsageRow[] => {
  const v = { 'codex:default': 69, 'codex:team': 95, 'codex:third': 95, 'claude:default': 'error', 'grok:default': 7, 'zai:plan-5h': 0, 'zai:plan-week': 100, ...over } as Record<string, number | 'error'>;
  return [...Object.entries(v).map(([k, u]) => { const [p, a] = k.split(':'); return row(p!, a!, u); }), { provider: 'openrouter', account: 'default', usedPercent: 93, leftUsd: 892, status: 'ok' }];
};

function ports(usage: UsageRow[], mail: string[] = [], ts = NOW): RouterPorts {
  let state: RouterState = { health: {}, alarms: {} };
  return { policy: DEFAULT_ROUTE_POLICY, now: () => NOW, readUsage: () => ({ ts, accounts: usage }), refreshUsage: () => ({ ts: NOW, accounts: usage }),
    readState: () => state, writeState: (s) => { state = s; }, post: (to, t) => { mail.push(`${to} ${t}`); }, refreshCredential: () => false };
}

describe('LLM-ROUTE-BY-GUARDIAN router', () => {
  test('Claude down → Terra chosen (team/third at 95 % → default account)', () => {
    const d = decideRoute(ports(today()), 'review');
    expect(d.route).toBe('terra-default');
    expect(d.skipped.map(s => s.route)).toEqual(['terra-third', 'terra-team']);
    expect(d.skipped[0]!.reason).toBe('95% used ≥ cap 95%');
  });

  test('Terra 2× overload → grok while grok is under 70 %', () => {
    const usage = today({ 'codex:default': 99, 'codex:team': 10, 'codex:third': 10 });
    const p = ports(usage); const ref = '40386@0123456789ab';
    reportResult(p, 'terra-third', { ok: false, error: 'server_is_overloaded', ref });
    const mid = decideRoute(p, 'review', { ref, exclude: ['terra-third'] });
    expect(mid.route).toBe('terra-team');
    reportResult(p, 'terra-team', { ok: false, error: 'HTTP 529 overloaded', ref });
    expect(decideRoute(p, 'review', { ref }).route).toBe('grok');
    const hot = ports(today({ 'codex:default': 99, 'codex:team': 10, 'codex:third': 10, 'grok:default': 71 }));
    reportResult(hot, 'terra-third', { ok: false, error: 'overloaded', ref }); reportResult(hot, 'terra-team', { ok: false, error: 'overloaded', ref });
    const w = decideRoute(hot, 'review', { ref });
    expect([w.route, w.via]).toEqual([null, 'wait']);
    expect(w.skipped.find(s => s.route === 'grok')!.reason).toBe('71% used ≥ rule max 70%');
  });

  test('GLM is never picked for review, even as the only healthy provider', () => {
    const usage = today({ 'codex:default': 100, 'codex:team': 100, 'codex:third': 100, 'grok:default': 99, 'zai:plan-week': 0 });
    const mail: string[] = [];
    const d = decideRoute(ports(usage, mail), 'review');
    expect(d.route).toBeNull();
    expect(mail.length).toBe(1);
    expect(mail[0]!.startsWith('OP 🚨 [route review]')).toBe(true);
    const policyWithGlm = { ...DEFAULT_ROUTE_POLICY, uses: { ...DEFAULT_ROUTE_POLICY.uses, review: { ...DEFAULT_ROUTE_POLICY.uses.review!, order: ['glm-plan', 'terra-default'] } } };
    const p = pickRoute({ policy: policyWithGlm, use: 'review', usage, health: {}, nowMs: NOW });
    expect(p.skipped[0]).toEqual({ route: 'glm-plan', reason: 'engine glm forbidden for review' });
  });

  test('expired auth → unhealthy, repair attempted (re-check auth · refresh), probe still failing keeps it down', () => {
    const p = ports(today());
    const r = reportResult(p, 'claude-acp', { ok: false, error: 'refresh token expired: invalid_grant' });
    expect(r.class).toBe('expired');
    expect(r.unhealthy).toBe(true);
    expect(r.repair!.steps).toEqual(['re-check-auth', 'refresh-credential', 're-probe', 'switch-account']);
    expect(routeHealthy(p.readState().health['claude-acp'], NOW + 24 * 3_600_000, { probeError: false }).healthy).toBe(false);
  });

  test('all down → cheapest healthy (or cheapest allowed) + one 🚨 line', () => {
    const mail: string[] = [];
    const p = ports(today({ 'zai:plan-week': 100, 'codex:default': 99, 'codex:team': 99, 'codex:third': 99 }), mail);
    for (const id of ['glm-openrouter', 'luna-default', 'luna-team', 'luna-third', 'terra-default']) reportResult(p, id, { ok: false, error: 'ECONNRESET' });
    const d = decideRoute(p, 'compaction');
    expect([d.route, d.via]).toEqual(['glm-plan', 'fallback']);
    decideRoute(p, 'compaction');
    expect(mail.filter(m => m.includes('🚨 [route compaction]')).length).toBe(1);
  });

  test('failure classes', () => {
    expect(classifyFailure('policy: OP78110 subscription authority expired06KST')).toBe('policy');
    expect(classifyFailure('no-candidate (codex-default:no-lease)')).toBe('policy');
    expect(classifyFailure('HTTP 401 Unauthorized')).toBe('auth');
    expect(classifyFailure('insufficient_quota: 429')).toBe('quota');
    expect(classifyFailure('server_is_overloaded')).toBe('overload');
    expect(classifyFailure('ssh: connect to host x port 22: Connection refused')).toBe('network');
  });

  test('stale snapshot → refreshed before deciding', () => {
    const d = decideRoute(ports(today(), [], NOW - 11 * 60_000), 'review');
    expect(d.refreshed).toBe(true);
    expect(decideRoute(ports(today(), [], NOW - 60_000), 'review').refreshed).toBe(false);
  });

  test('flapping route needs its backoff even after a success', () => {
    let h = {} as ReturnType<typeof markFail>;
    for (const m of [0, 2, 4]) h = markFail(h, 'terra-default', { at: new Date(NOW + m * 60_000).toISOString(), class: 'overload' });
    const withOk = { ...h, 'terra-default': { ...h['terra-default']!, lastOkAt: new Date(NOW + 5 * 60_000).toISOString() } };
    expect(routeHealthy(withOk['terra-default'], NOW + 6 * 60_000, { probeError: false }).healthy).toBe(false);
    expect(routeHealthy(withOk['terra-default'], NOW + 30 * 60_000, { probeError: false }).healthy).toBe(true);
  });

  test('one source: the router policy comes from the resource-facts policy file (llm · review · caps) over its defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'llm-route-'));
    const file = join(root, 'policy.json');
    writeFileSync(file, JSON.stringify({ llm: { uses: { voice: { order: ['grok'] } } }, review: { fallbackMaxUsedPercent: 50 }, caps: { accountCap: 0.9 } }));
    const prior = process.env.RESOURCE_FACTS_POLICY; process.env.RESOURCE_FACTS_POLICY = file; resetResourceFactsCache();
    try {
      const { policy } = loadRoutePolicy();
      expect(policy.uses.voice!.order).toEqual(['grok']);
      expect(policy.uses.review!.order).toEqual(['terra-third', 'terra-team', 'terra-default', 'claude-acp', 'grok']);
      expect(policy.uses.review!.rules!.grok).toEqual({ afterFailures: { engine: 'terra', class: 'overload', count: 2 }, orWhenAllUnavailable: 'terra', maxUsedPct: 50 });
      expect(policy.uses.review!.forbidEngines).toEqual(['glm']);
      expect(policy.capPct).toBe(90);
    } finally { if (prior === undefined) delete process.env.RESOURCE_FACTS_POLICY; else process.env.RESOURCE_FACTS_POLICY = prior; resetResourceFactsCache(); }
    // review rules change in one place → the router follows: fallback off, no Claude
    const p = policyFromFacts(resolveFacts({ actors: null, policy: { review: { fallback: null, also: [] } } }));
    expect(p.uses.review!.order).toEqual(['terra-third', 'terra-team', 'terra-default']);
    writeRouterState(root, { health: { grok: { failures: [], repairs: [], lastOkAt: '2026-11-27T00:00:00.000Z' } }, alarms: {} });
    expect(readRouterState(root).health.grok!.lastOkAt).toBe('2026-11-27T00:00:00.000Z');
  });

  test('self review flags per engine', () => {
    expect(selfReviewArgsFor(DEFAULT_ROUTE_POLICY.routes['claude-acp']!)).toEqual(['--acp', '--acp-backend', 'claude', '--acp-model', 'opus']);
    expect(selfReviewArgsFor(DEFAULT_ROUTE_POLICY.routes['terra-team']!)).toEqual(['--model', 'gpt-6.1-terra']);
  });

  test('land side: a review satisfies the policy by its answered model, never GLM', () => {
    const cases: [string, boolean][] = [['gpt-6.1-terra', true], ['openai-codex/gpt-6.1-terra', true], ['acp:claude', true],
      ['acp:claude/opus', true], ['claude-opus-4-6', true], ['grok-4.7', true], ['acp:grok/grok-4', true],
      ['openrouter/z-ai/glm-5.3', false], ['glm-5.3', false], ['gpt-6-luna', false], ['', false]];
    const review = resolveFacts({ actors: null, policy: null }).review;
    for (const [m, want] of cases) expect([m, acceptReviewModel(m, review).ok]).toEqual([m, want]);
  });

  test('work = hand-<difficulty>; other uses pass through', () => {
    expect([resolveUse('work'), resolveUse('work', 'hard'), resolveUse('review')]).toEqual(['hand-medium', 'hand-hard', 'review']);
  });

  test('every Terra unavailable (cap · probe error) and Claude down → grok at once, no alarm', () => {
    const mail: string[] = [];
    const d = decideRoute(ports(today({ 'codex:default': 'error' }), mail), 'review', { ref: '39824@abcdefabcdef' });
    expect([d.route, d.via, mail.length]).toEqual(['grok', 'policy', 0]);
    expect(d.skipped.map(s => s.route)).toEqual(['terra-third', 'terra-team', 'terra-default', 'claude-acp']);
  });

  test('same-millisecond success then failure: the failure (written last) wins', () => {
    const at = '2026-11-27T01:00:00.000Z';
    let h = markOk({}, 'claude-acp', at);
    h = markFail(h, 'claude-acp', { at, class: 'auth' });
    expect(routeHealthy(h['claude-acp'], NOW + 60_000, { probeError: false }).healthy).toBe(false);
  });

  test('auth failure is not recovered when the probe has no row for the account', () => {
    const p = ports(today().filter(r => r.provider !== 'claude'));
    const r = reportResult(p, 'claude-acp', { ok: false, error: 'HTTP 401 unauthorized' });
    expect([r.class, r.unhealthy, r.repair!.cleared]).toEqual(['auth', true, false]);
  });

  test('head unreadable after the review → re-queue, never record', () => {
    const end = judgeReviewEnd({ headAtStart: '1'.repeat(40), headNow: null, text: '', result: { reviewed: true, verdict: 'pass', headCommit: '1'.repeat(40) } });
    expect(end.action).toBe('requeue');
  });
});
