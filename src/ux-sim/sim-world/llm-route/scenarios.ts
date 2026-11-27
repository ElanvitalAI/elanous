// SIM-WORLD llm-route — LLM-ROUTE-BY-GUARDIAN under edge events (CEO 11-27 10:2x «시뮬월드에서 충분히 검증»).
// Device LLM-ROUTE-FAKE-PROVIDERS: a fake provider world (usage snapshot per account · a fake clock · a mail sink · a
// credential refresher) wired into the real router through RouterPorts. LLM 0, network 0. Every scenario runs five
// sub-seeds (ctx.seed … ctx.seed+4): the seed moves the noise (unrelated accounts' usage, event timing jitter), never
// the literal expectation. Expectations are literals here, not product constants.
import { checkRealGit } from './real-git.js';
import { DEFAULT_ROUTE_POLICY } from '../../../llm-route/route-store.js';
import { judgeReviewEnd, planReviewStart } from '../../../llm-route/review-start.js';
import { decideRoute, reportResult, type RoutePolicy, type RouterPorts, type RouterState, type UsageRow, type UsageSnapshotIn } from '../../../llm-route/router.js';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const DEVICE = 'LLM-ROUTE-FAKE-PROVIDERS';
const SUB_SEEDS = 5;
const T0 = Date.parse('2026-11-27T01:00:00.000Z');
const MIN = 60_000;

const rng = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

type Acc = `${string}:${string}`;
const ALL_ACCOUNTS: readonly Acc[] = ['codex:default', 'codex:team', 'codex:third', 'claude:default', 'grok:default', 'openrouter:default', 'zai:plan-5h', 'zai:plan-week'];
type Setting = number | 'error';

export interface FakeWorld {
  readonly ports: RouterPorts;
  readonly mail: { to: string; text: string }[];
  refreshes: number;
  credentialRefreshes: number;
  advance(ms: number): void;
  set(acc: Acc, v: Setting): void;
  /** Make the snapshot old (as if the collector stopped writing). */
  ageSnapshot(ms: number): void;
  /** What the next refresh will read (the provider's real numbers). */
  setFresh(acc: Acc, v: Setting): void;
}

/** A fake provider world. Unlisted accounts get seeded noise in 5–60 % (healthy, under every cap and rule). */
export function fakeWorld(seed: number, fixed: Partial<Record<Acc, Setting>>, policy: RoutePolicy = DEFAULT_ROUTE_POLICY): FakeWorld {
  const r = rng(seed);
  let now = T0 + Math.floor(r() * 5 * MIN);
  const live = new Map<Acc, Setting>(); const fresh = new Map<Acc, Setting>();
  for (const a of ALL_ACCOUNTS) { const v = fixed[a] ?? Math.round(5 + r() * 55); live.set(a, v); fresh.set(a, v); }
  let snapTs = now;
  const rows = (m: Map<Acc, Setting>): UsageRow[] => [...m].map(([a, v]) => {
    const [provider, account] = a.split(':') as [string, string];
    if (v === 'error') return { provider, account, usedPercent: null, status: 'error' as const };
    return provider === 'openrouter' ? { provider, account, usedPercent: v, leftUsd: v >= 100 ? 0 : 500, status: 'ok' as const } : { provider, account, usedPercent: v, status: 'ok' as const };
  });
  let state: RouterState = { health: {}, alarms: {} };
  const w: FakeWorld = {
    mail: [], refreshes: 0, credentialRefreshes: 0,
    ports: {
      policy,
      now: () => now,
      readUsage: (): UsageSnapshotIn => ({ ts: snapTs, accounts: rows(live) }),
      refreshUsage: (): UsageSnapshotIn => { w.refreshes++; for (const [a, v] of fresh) live.set(a, v); snapTs = now; return { ts: snapTs, accounts: rows(live) }; },
      readState: () => state,
      writeState: (s) => { state = s; },
      post: (to, text) => { w.mail.push({ to, text }); },
      refreshCredential: () => { w.credentialRefreshes++; return false; },
    },
    advance: (ms) => { now += ms; },
    set: (a, v) => { live.set(a, v); fresh.set(a, v); },
    ageSnapshot: (ms) => { snapTs = now - ms; },
    setFresh: (a, v) => { fresh.set(a, v); },
  };
  return w;
}

export const simWorldDevices: readonly SimWorldDeviceDef<{ fakeWorld: typeof fakeWorld }>[] = [{
  id: DEVICE,
  title: 'fake LLM provider world — usage snapshot per account, fake clock, mail sink, credential refresher (router ports · LLM 0)',
  create: () => ({ fakeWorld }),
}];

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
type Check = (seed: number, mk: typeof fakeWorld) => string | null;

/** Run a check over five sub-seeds; the first failing seed is the diff. */
function scenario(id: string, title: string, check: Check): SimWorldScenario {
  return {
    id, title, devices: [DEVICE],
    async run(ctx) {
      const { fakeWorld: mk } = ctx.device<{ fakeWorld: typeof fakeWorld }>(DEVICE);
      for (let i = 0; i < SUB_SEEDS; i++) {
        const seed = ctx.seed + i;
        const problem = check(seed, mk);
        ctx.recorder.event('llm-route:seed', { scenario: id, seed, ok: problem === null, ...(problem ? { problem } : {}) });
        if (problem) return fail(`${id} expectation broken`, `seed ${seed}: ${problem}`);
      }
      return { ok: true };
    },
  };
}

const eq = (what: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? null : `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const first = (...xs: (string | null)[]) => xs.find(x => x !== null) ?? null;
// Today's picture (status line 11-27 10:0x): codex team/third 95 % · default 69 % · claude ✗ · grok 7 % · zai week 100 %.
const TODAY: Partial<Record<Acc, Setting>> = { 'codex:default': 69, 'codex:team': 95, 'codex:third': 95, 'claude:default': 'error', 'grok:default': 7, 'zai:plan-week': 100 };

export const SCENARIOS: readonly { id: string; title: string; check: (seed: number, mk: typeof fakeWorld) => string | null }[] = [
  { id: 'LR-CLAUDE-DOWN-TERRA', title: 'Claude ACP down (claude ✗) · team/third 95 % → review on Terra default', check: (seed, mk) => {
    const w = mk(seed, TODAY);
    const d = decideRoute(w.ports, 'review', { ref: '40386@aaaaaaaaaaaa' });
    return first(eq('route', d.route, 'terra-default'), eq('via', d.via, 'policy'), eq('mail', w.mail.length, 0));
  } },
  { id: 'LR-TERRA-OVERLOAD-GROK', title: 'Terra overload ×2 for the same review → grok (7 %)', check: (seed, mk) => {
    const w = mk(seed, { 'codex:default': 96, 'codex:team': 40, 'codex:third': 40, 'claude:default': 'error', 'grok:default': 7 });
    const ref = '40386@bbbbbbbbbbbb';
    const a = decideRoute(w.ports, 'review', { ref });
    reportResult(w.ports, a.route!, { ok: false, error: 'stream error: server_is_overloaded (529)', ref });
    w.advance(MIN);
    const b = decideRoute(w.ports, 'review', { ref, exclude: [a.route!] });
    reportResult(w.ports, b.route!, { ok: false, error: 'HTTP 503 overloaded', ref });
    w.advance(MIN);
    const c = decideRoute(w.ports, 'review', { ref, exclude: [a.route!, b.route!] });
    return first(eq('first', a.route, 'terra-third'), eq('second', b.route, 'terra-team'), eq('third', c.route, 'grok'));
  } },
  { id: 'LR-TERRA-OVERLOAD-GROK-HOT', title: 'Terra overload ×2 but grok 75 % → no grok · waiver path with one 🚨', check: (seed, mk) => {
    const w = mk(seed, { 'codex:default': 96, 'codex:team': 40, 'codex:third': 40, 'claude:default': 'error', 'grok:default': 75 });
    const ref = '40386@cccccccccccc';
    reportResult(w.ports, 'terra-third', { ok: false, error: 'server_is_overloaded', ref });
    reportResult(w.ports, 'terra-team', { ok: false, error: 'server_is_overloaded', ref });
    const c = decideRoute(w.ports, 'review', { ref });
    return first(eq('route', c.route, null), eq('via', c.via, 'wait'), eq('alarms', w.mail.filter(m => m.text.includes('waiver')).length, 1));
  } },
  { id: 'LR-TERRA-ALL-UNAVAILABLE-GROK', title: 'every Terra unavailable (team/third at cap · default not runnable) · Claude ✗ → grok at once (no 2 wasted calls) · 0 alarms', check: (seed, mk) => {
    const w = mk(seed, { ...TODAY, 'codex:default': 'error' });
    const d = decideRoute(w.ports, 'review', { ref: '39824@eeeeeeeeeeee' });
    const terraLeft = mk(seed, { ...TODAY });
    return first(eq('route', d.route, 'grok'), eq('via', d.via, 'policy'), eq('alarms', w.mail.length, 0), eq('terra still first when one is up', decideRoute(terraLeft.ports, 'review').route, 'terra-default'));
  } },
  { id: 'LR-GROK-70-NEVER', title: 'grok at exactly 70 % is not a review fallback', check: (seed, mk) => {
    const w = mk(seed, { 'codex:default': 99, 'codex:team': 99, 'codex:third': 99, 'claude:default': 'error', 'grok:default': 70 });
    const ref = '1@dddddddddddd';
    reportResult(w.ports, 'terra-default', { ok: false, error: 'overloaded', ref });
    reportResult(w.ports, 'terra-default', { ok: false, error: 'overloaded', ref });
    return eq('route', decideRoute(w.ports, 'review', { ref }).route, null);
  } },
  { id: 'LR-GLM-NEVER-REVIEW', title: 'GLM never reviews — 40 random worlds per seed, everything else down in half of them', check: (seed, mk) => {
    const r = rng(seed * 7919);
    for (let k = 0; k < 40; k++) {
      const down = r() < 0.5;
      const pct = () => (down ? 96 + Math.floor(r() * 5) : Math.floor(r() * 100));
      const w = mk(seed * 100 + k, { 'codex:default': pct(), 'codex:team': pct(), 'codex:third': pct(), 'claude:default': down || r() < 0.5 ? 'error' : 10, 'grok:default': down ? 90 : Math.floor(r() * 100), 'zai:plan-5h': 0, 'zai:plan-week': 0, 'openrouter:default': 0 });
      const d = decideRoute(w.ports, 'review');
      if (d.def && d.def.engine === 'glm') return `world ${k}: review routed to ${d.route}`;
      if (down && d.route !== null) return `world ${k}: all non-GLM down but review took ${d.route}`;
      if (down && !w.mail.some(m => m.text.startsWith('🚨'))) return `world ${k}: all down without 🚨`;
    }
    return null;
  } },
  { id: 'LR-CODEX-95-DEFAULT', title: 'codex team/third 95 % → default account for review and hard work', check: (seed, mk) => {
    const w = mk(seed, { 'codex:default': 60, 'codex:team': 95, 'codex:third': 95 });
    return first(eq('review', decideRoute(w.ports, 'review').route, 'terra-default'), eq('hand-hard', decideRoute(w.ports, 'hand-hard').route, 'terra-default'));
  } },
  { id: 'LR-ALL-CODEX-95-OPENROUTER', title: 'every codex ≥ 95 % · zai week 100 % → OpenRouter credits for work · review on grok (every Terra unavailable), never OpenRouter', check: (seed, mk) => {
    const w = mk(seed, { 'codex:default': 97, 'codex:team': 95, 'codex:third': 99, 'zai:plan-week': 100, 'claude:default': 'error', 'grok:default': 7 });
    const work = ['hand-hard', 'hand-medium', 'hand-easy', 'capsule', 'compaction'].map(u => decideRoute(w.ports, u).route);
    const review = decideRoute(w.ports, 'review');
    return first(eq('work', work, ['glm-openrouter', 'glm-openrouter', 'glm-openrouter', 'glm-openrouter', 'glm-openrouter']), eq('review', review.route, 'grok'));
  } },
  { id: 'LR-POLICY-FIXED-VALUE', title: 'a hardcoded expiry in ops tooling → policy class · rerouted · one card to the owner', check: (seed, mk) => {
    const w = mk(seed, TODAY);
    const f = reportResult(w.ports, 'terra-default', { ok: false, error: 'policy: OP78110 subscription authority expired06KST' });
    reportResult(w.ports, 'terra-default', { ok: false, error: 'policy: OP78110 subscription authority expired06KST' });
    const next = decideRoute(w.ports, 'hand-hard');
    const cards = w.mail.filter(m => m.to === 'RES' && m.text.includes('정책 고정값'));
    return first(eq('class', f.class, 'policy'), eq('next', next.route, 'luna-default'), eq('cards', cards.length, 1));
  } },
  { id: 'LR-EXPIRED-AUTH-REPAIR', title: 'expired auth → unhealthy · re-check auth + refresh attempted · repair budget spent → card', check: (seed, mk) => {
    const w = mk(seed, { ...TODAY, 'claude:default': 'error' });
    const a = reportResult(w.ports, 'claude-acp', { ok: false, error: 'OAuth refresh token expired (invalid_grant)' });
    w.advance(MIN); reportResult(w.ports, 'claude-acp', { ok: false, error: 'OAuth refresh token expired (invalid_grant)' });
    w.advance(MIN); const c = reportResult(w.ports, 'claude-acp', { ok: false, error: 'OAuth refresh token expired (invalid_grant)' });
    // The provider comes back: the next probe reads the account fine and clears the mark.
    w.setFresh('claude:default', 20); w.advance(31 * MIN);
    const d = reportResult(w.ports, 'claude-acp', { ok: false, error: 'HTTP 401 unauthorized' });
    return first(eq('class', a.class, 'expired'), eq('steps', a.repair?.steps, ['re-check-auth', 'refresh-credential', 're-probe', 'switch-account']),
      eq('credential refreshes', w.credentialRefreshes >= 2, true), eq('third → card', c.cardSent, true), eq('repaired', d.repair?.cleared, true));
  } },
  { id: 'LR-NO-LEASE-NEVER-STALL', title: 'spend guard «no-candidate (codex-default:no-lease)» on every codex route → compaction and work still get a route', check: (seed, mk) => {
    const w = mk(seed, { 'zai:plan-week': 100 });
    for (const id of ['terra-default', 'terra-team', 'terra-third', 'luna-default', 'luna-team', 'luna-third']) reportResult(w.ports, id, { ok: false, error: 'spend guard: no-candidate (codex-default:no-lease)' });
    const got = ['compaction', 'capsule', 'hand-medium', 'hand-hard'].map(u => decideRoute(w.ports, u).route);
    return eq('routes', got, ['glm-openrouter', 'glm-openrouter', 'glm-openrouter', 'glm-openrouter']);
  } },
  { id: 'LR-NO-HOST-PIN', title: 'no route is pinned to a host; no skip reason names a host', check: (seed, mk) => {
    const w = mk(seed, TODAY);
    const pinned = Object.entries(DEFAULT_ROUTE_POLICY.routes).filter(([, r]) => 'hosts' in (r as object)).map(([id]) => id);
    const d = decideRoute(w.ports, 'review');
    return first(eq('pinned', pinned, []), eq('host in reasons', d.skipped.some(s => /mshq|host/u.test(s.reason)), false));
  } },
  { id: 'LR-FLAP-HYSTERESIS', title: 'terra default flaps fail/ok every minute for 30 min → at most 3 route switches', check: (seed, mk) => {
    const w = mk(seed, { 'codex:default': 30 });
    let last: string | null = null; let switches = 0;
    for (let m = 0; m < 30; m++) {
      const d = decideRoute(w.ports, 'hand-hard');
      if (last !== null && d.route !== last) switches++;
      last = d.route;
      reportResult(w.ports, 'terra-default', m % 2 === 0 ? { ok: false, error: 'HTTP 503 overloaded' } : { ok: true });
      w.advance(MIN);
    }
    return switches <= 3 ? null : `switches ${switches} > 3`;
  } },
  { id: 'LR-STALE-USAGE-REFRESH', title: 'usage snapshot 11 min old → one refresh, then decide on the fresh numbers', check: (seed, mk) => {
    const w = mk(seed, { 'codex:default': 40, 'codex:team': 30, 'codex:third': 95 });
    w.setFresh('codex:default', 99); w.ageSnapshot(11 * MIN);
    const d = decideRoute(w.ports, 'hand-hard');
    const again = decideRoute(w.ports, 'hand-hard');
    return first(eq('refreshed', d.refreshed, true), eq('refreshes', w.refreshes, 1), eq('route', d.route, 'terra-team'), eq('second refreshed', again.refreshed, false));
  } },
  { id: 'LR-ALL-DOWN-ALARM-ONCE', title: 'every provider failing → compaction still routed (cheapest) · 🚨 exactly once in 10 min', check: (seed, mk) => {
    const w = mk(seed, { 'zai:plan-5h': 1, 'zai:plan-week': 1, 'codex:default': 50, 'codex:team': 50, 'codex:third': 50 });
    const ids = Object.keys(DEFAULT_ROUTE_POLICY.routes);
    const got: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      for (const id of ids) reportResult(w.ports, id, { ok: false, error: 'connect ECONNREFUSED' });
      got.push(decideRoute(w.ports, 'compaction').route);
      w.advance(MIN);
    }
    const alarms = w.mail.filter(m => m.text.startsWith('🚨 [route compaction]'));
    return first(eq('never null', got.every(g => g !== null), true), eq('cheapest', got[0], 'glm-plan'), eq('alarms', alarms.length, 1));
  } },
  { id: 'LR-REVIEW-MERGE-BASE', title: 'review requested on a PR with main merged → merge-base diff, no refusal', check: () => {
    const p = planReviewStart({ mainMerged: true, savedReviewHead: null, deltaChars: null, deltaBudgetChars: 20562 });
    return first(eq('path', p.path, 'merge-base'), eq('extra', p.extraArgs, []));
  } },
  { id: 'LR-REVIEW-DELTA-OVER', title: 'delta over budget → full re-review (no refusal)', check: (seed, mk) => {
    const over = 20563 + (seed % 7) * 1000;
    const p = planReviewStart({ mainMerged: false, savedReviewHead: 'e'.repeat(40), deltaChars: over, deltaBudgetChars: 20562 });
    const end = judgeReviewEnd({ headAtStart: 'f'.repeat(40), headNow: 'f'.repeat(40), text: '', result: { reviewed: false, verdict: null, refusal: 'delta-base-invalid', deltaRefusal: 'delta-diff-over-20562-chars' } });
    return first(eq('path', p.path, 'full-rereview'), eq('extra', p.extraArgs, ['--full']), eq('end', end.action, 'retry-full'));
  } },
  { id: 'LR-REVIEW-HEAD-MOVED', title: 'PR head moves mid-review → re-queue, the verdict is not recorded', check: () => {
    const a = judgeReviewEnd({ headAtStart: '1'.repeat(40), headNow: '2'.repeat(40), text: '', result: { reviewed: true, verdict: 'pass', headCommit: '1'.repeat(40) } });
    const b = judgeReviewEnd({ headAtStart: '1'.repeat(40), headNow: '1'.repeat(40), text: '', result: { reviewed: true, verdict: 'pass', headCommit: '3'.repeat(40) } });
    const c = judgeReviewEnd({ headAtStart: '1'.repeat(40), headNow: '1'.repeat(40), text: '', result: { reviewed: true, verdict: 'pass', headCommit: '1'.repeat(40) } });
    return first(eq('moved', a.action, 'requeue'), eq('stale result', b.action, 'requeue'), eq('same head', c.action, 'record'));
  } },
];

export const simWorldScenarios: readonly SimWorldScenario[] = [
  ...SCENARIOS.map(s => scenario(s.id, s.title, s.check)),
  ...(['merge-base', 'range-diff', 'head-moved'] as const).map(kind =>
    scenario(`LR-REVIEW-GIT-${kind.toUpperCase()}`, `synthetic actual git ${kind} + pure review decision`, () => checkRealGit(kind))),
];
