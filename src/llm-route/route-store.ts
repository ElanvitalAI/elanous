// LLM-ROUTE-BY-GUARDIAN — the I/O side of router.ts: the routing policy (ONE source: kit/resource-facts — routes · uses ·
// review rules · caps, from its policy file ⊕ code defaults), the usage snapshot the status line already keeps, the router
// state (route health ⊕ alarm marks) owned by the guardian, and mail.
//   policy  : resourceFacts() — <state>/resource-facts/policy.json keys `llm` · `review` · `caps.accountCap` (LLM-ROUTE-ONE-SOURCE)
//   health  : <state>/loop-agents/guardian/llm-route-state.json (atomic tmp+rename · fail-open)
//   usage   : <state>/status/llm-usage.json (written by `eln usage status-cache`)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveFacts, resourceFacts, type ResourceFacts } from '../kit/resource-facts/index.js';
import type { RoutePolicy, RouterPorts, RouterState, UseRule, UsageSnapshotIn } from './router.js';

export const routeStatePath = (stateRoot: string) => join(stateRoot, 'loop-agents', 'guardian', 'llm-route-state.json');

const family = (fam: string, r: { engine: string; model: string }) => r.engine.toLowerCase().includes(fam.toLowerCase()) || r.model.toLowerCase().includes(fam.toLowerCase());

/** The router's policy from the resource facts: routes and uses as they are; the review use derived from the review rules
 *  (primary family routes in route order → `also` families → fallback, forbidden families excluded; the fallback rule =
 *  N overloads on the primary engine or every primary route unavailable, under its own used-% limit); cap = accountCap. */
export function policyFromFacts(f: Pick<ResourceFacts, 'llm' | 'review' | 'caps'>): RoutePolicy {
  const ids = Object.keys(f.llm.routes);
  const allowed = ids.filter(id => !f.review.forbidden.some(x => family(x, f.llm.routes[id]!)));
  const of = (fam: string) => allowed.filter(id => family(fam, f.llm.routes[id]!));
  const primary = of(f.review.primary);
  const also = f.review.also.flatMap(of).filter(id => !primary.includes(id));
  const fallback = f.review.fallback ? of(f.review.fallback).filter(id => !primary.includes(id) && !also.includes(id)) : [];
  const primaryEngine = primary[0] ? f.llm.routes[primary[0]]!.engine : f.review.primary;
  const rule: UseRule = { afterFailures: { engine: primaryEngine, class: 'overload', count: f.review.fallbackAfterFailures },
    ...(f.review.fallbackWhenPrimaryUnavailable ? { orWhenAllUnavailable: primaryEngine } : {}), maxUsedPct: f.review.fallbackMaxUsedPercent };
  const forbidEngines = [...new Set(ids.filter(id => !allowed.includes(id)).map(id => f.llm.routes[id]!.engine))];
  return {
    version: 1, capPct: Math.round(f.caps.accountCap * 100), alarmTo: f.llm.alarmTo, routes: f.llm.routes,
    uses: { ...f.llm.uses, review: { order: [...primary, ...also, ...fallback], forbidEngines, whenAllDown: 'wait', rules: Object.fromEntries(fallback.map(id => [id, rule])) } },
  };
}

/** The code-default policy (resource-facts defaults only) — sims and tests; live callers use loadRoutePolicy. */
export const DEFAULT_ROUTE_POLICY: RoutePolicy = policyFromFacts(resolveFacts({ actors: null, policy: null, warnings: [] }));

/** The live policy: resource facts (policy file ⊕ ledger ⊕ defaults). Warnings from the facts are passed on. */
export function loadRoutePolicy(): { policy: RoutePolicy; warnings: readonly string[] } {
  const f = resourceFacts();
  return { policy: policyFromFacts(f), warnings: f.warnings.filter(w => /llm|review|caps|policy/u.test(w)) };
}

export function readRouterState(stateRoot: string): RouterState {
  try {
    const s = JSON.parse(readFileSync(routeStatePath(stateRoot), 'utf8')) as Partial<RouterState>;
    return { health: s.health && typeof s.health === 'object' ? s.health : {}, alarms: s.alarms && typeof s.alarms === 'object' ? s.alarms : {} };
  } catch { return { health: {}, alarms: {} }; }
}

export function writeRouterState(stateRoot: string, s: RouterState): void {
  const path = routeStatePath(stateRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s)}\n`);
    renameSync(tmp, path);
  } catch { /* fail-open: routing never stops on a state write */ }
}

/** The one swap point for account facts (CEO 11-27 10:5x «원장에 의해 라우팅»): today the status line's usage snapshot;
 *  when kit/resource-facts (built from the guardian world registry) lands, this adapter reads it instead. */
export function readAccountFacts(): UsageSnapshotIn | null { return readUsage(); }

function readUsage(): UsageSnapshotIn | null {
  try {
    const { llmUsageCachePath, parseLlmUsageSnapshot } = require('../statusline/sources/llm-usage.js') as typeof import('../statusline/sources/llm-usage.js');
    const snap = parseLlmUsageSnapshot(readFileSync(llmUsageCachePath(), 'utf8'));
    return snap ? { ts: snap.ts, accounts: snap.accounts } : null;
  } catch { return null; }
}

/** Re-run the usage collector of this build (`usage status-cache`) and read the fresh snapshot. */
function refreshUsage(): UsageSnapshotIn | null {
  const entry = process.argv[1];
  if (entry && existsSync(entry)) {
    // 출처: llm-usage.ts REFRESH_CHILD_TIMEOUT_MS — the same 90 s bound as the status line's refresh child.
    spawnSync(process.execPath, [entry, 'usage', 'status-cache'], { stdio: 'ignore', timeout: 90_000, env: process.env });
  }
  return readUsage();
}

export function liveRouterPorts(stateRoot: string, opts: { post?: (to: string, text: string) => void } = {}): RouterPorts & { overrideError: string | null } {
  const { policy, warnings } = loadRoutePolicy();
  return {
    policy, overrideError: warnings.find(w => !w.startsWith('default used')) ?? null,
    now: () => Date.now(),
    readUsage: readAccountFacts, refreshUsage,
    veto: accountPolicyVeto,
    readState: () => readRouterState(stateRoot),
    writeState: (s) => writeRouterState(stateRoot, s),
    post: opts.post ?? ((to, text) => {
      try {
        const m = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
        const store = m.openMsgStore(m.defaultMsgStorePath());
        try { store.post({ from: 'GUARDIAN', to, body: text, kind: 'request' }); } finally { store.close(); }
      } catch { process.stderr.write(`${text}\n`); }
    }),
  };
}

/** LLM-ACCOUNT-POLICY-YAML — route provider names → account-policy providers. */
const POLICY_PROVIDER: Readonly<Record<string, string>> = { codex: 'openai-codex' };

/** A route is vetoed when every account it draws from is refused by the account decision: a credits route whose
 *  accounts may not spend credits, or a subscription route whose accounts are skipped without credits. */
export function accountPolicyVeto(def: import('./router.js').RouteDef): string | null {
  const { llmAccountDecision } = require('../kit/resource-facts/llm-decide.js') as typeof import('../kit/resource-facts/llm-decide.js');
  const d = llmAccountDecision('llm-route');
  if (!d.revision) return null;
  const provider = POLICY_PROVIDER[def.provider] ?? def.provider;
  // A provider the policy does not govern has no veto. For a governed provider every route account is judged on its
  // own; an account the policy does not name may NOT spend credits (unknown ≠ allowed) and has no subscription rule.
  if (!d.accounts.some(x => x.provider === provider)) return null;
  const rows = def.accounts.map(a => ({ account: a, row: d.accounts.find(x => x.provider === provider && x.account === a) ?? null }));
  if (def.cost === 'credits') {
    // A credits route needs at least one account on it that may spend credits AND is not skipped.
    if (rows.some(({ row }) => row && row.credits.value && !row.skip.value)) return null;
    return rows.map(({ account, row }) => !row ? `${provider}:${account} not in the policy — credits not allowed`
      : !row.credits.value ? `${row.id} credits OFF — ${row.credits.winner?.why ?? 'pack'}` : `${row.id} skipped — ${row.skip.winner?.why ?? 'skip'}`).join(' · ') || 'no account on the route';
  }
  const why = rows.map(({ row }) => (!row || row.subscriptionRoutable ? null : `${row.id} subscription skipped — ${row.skip.winner?.why ?? 'skip'}${row.credits.value ? ' (credits path only)' : ''}`));
  return why.length && why.every(Boolean) ? why.join(' · ') : null;
}

/** Uses the CLI accepts: the policy's own names plus `work` (= hand-<difficulty>). */
export function resolveUse(use: string, difficulty: 'hard' | 'medium' | 'easy' = 'medium'): string {
  return use === 'work' ? `hand-${difficulty}` : use;
}

/** Library entry — every LLM choice asks this (`eln route llm <use>` is the same call). */
export function routeLlm(use: string, opts: { stateRoot: string; ref?: string; exclude?: readonly string[]; difficulty?: 'hard' | 'medium' | 'easy' }): import('./router.js').Decision {
  const { decideRoute } = require('./router.js') as typeof import('./router.js');
  return decideRoute(liveRouterPorts(opts.stateRoot), resolveUse(use, opts.difficulty), { ...(opts.ref ? { ref: opts.ref } : {}), ...(opts.exclude ? { exclude: opts.exclude } : {}) });
}
