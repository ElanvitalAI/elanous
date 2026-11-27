// LLM-ROUTE-BY-GUARDIAN (CEO 11-27 10:0x «결국 정책 문제 · 고정값이 문제») — one provider ledger ⊕ one routing policy
// table (data) ⊕ route health with bounded self-repair. Pure: no disk, no clock, no network (route-store.ts is the I/O side).
//
// S: one review (#40386) was blocked by five fixed values — a hardcoded expiry date, «explicit engine ⇒ mshq only»,
//    «reviews run via claude-acp only» while Claude was down, an installed-build lag and a preflight refusal; the spend
//    guard «no-candidate» blocked compaction and hand capsules the same way.
// C: the engine/host/account for each use was a constant in code or an ops script, blind to what is left and what works.
// A: every use asks this router: candidates come from the policy table (ordered per use, with rules), each is checked
//    against the ledger (remaining % per account from the usage snapshot) and route health (last success/failure +
//    error class); the first allowed ∧ healthy ∧ under-cap ∧ rule-passing candidate wins. Nothing passes → the cheapest
//    healthy allowed candidate and a 🚨 one-liner — never a stall. A forbidden engine (GLM for review) is never chosen.
//
// 세 얼굴: 관측 = `eln usage route ledger|pick` (every skip prints its reason) ⊕ health file · 판단 근거 = policy table ⊕
//          usage snapshot ⊕ health · 수복과 인계 = a failure marks the route with its class, a bounded repair (re-probe ·
//          refresh · switch account) runs, repeated failure → a card to the route owner.

export type CostClass = 'subscription' | 'credits' | 'paid';
export type FailureClass = 'auth' | 'expired' | 'quota' | 'overload' | 'network' | 'policy' | 'unknown';

export interface RouteDef {
  readonly provider: string;
  /** Usage-snapshot accounts of the provider this route draws from; the fullest one counts (e.g. zai 5h ⊕ week). */
  readonly accounts: readonly string[];
  readonly engine: string;
  readonly model: string;
  readonly cost: CostClass;
  readonly env?: Readonly<Record<string, string>>;
  readonly owner?: string;
}
export interface UseRule {
  /** Allowed only after this many failures of `class` on routes of `engine` (in the window / for the same ref). */
  readonly afterFailures?: { readonly engine: string; readonly class: FailureClass; readonly count: number };
  /** …or right away when every route of this engine in the use's order is unavailable (at cap · unhealthy · tried ·
   *  not runnable) — the same condition as «N overloads», reached without burning N calls (CEO 11-27 «unblock today»). */
  readonly orWhenAllUnavailable?: string;
  /** Allowed only while the account is under this used % (stricter than the global cap). */
  readonly maxUsedPct?: number;
}
export interface UsePolicy {
  readonly order: readonly string[];
  readonly forbidEngines?: readonly string[];
  readonly rules?: Readonly<Record<string, UseRule>>;
  /** 'first' (default) = policy order · 'cheapest' = cost class, then least used. */
  readonly pick?: 'first' | 'cheapest';
  /** Nothing passes: 'cheapest' (default · never stall) = cheapest healthy allowed candidate · 'wait' = no route, the
   *  alarm says «waiver path» (review: a wrong reviewer is worse than a late one — CEO rule «GLM never for review»). */
  readonly whenAllDown?: 'cheapest' | 'wait';
}
export interface RoutePolicy {
  readonly version: number;
  readonly capPct: number;
  readonly alarmTo: string;
  readonly routes: Readonly<Record<string, RouteDef>>;
  readonly uses: Readonly<Record<string, UsePolicy>>;
}

/** Usage snapshot rows (the status line's `<state>/status/llm-usage.json`). */
export interface UsageRow { readonly provider: string; readonly account: string; readonly usedPercent: number | null; readonly leftUsd?: number; readonly status: 'ok' | 'error' | 'unknown' }

export interface FailureMark { readonly at: string; readonly class: FailureClass; readonly ref?: string; readonly error?: string }
export interface RouteHealth {
  readonly lastOkAt?: string;
  readonly lastFailAt?: string;
  readonly lastClass?: FailureClass;
  readonly lastError?: string;
  /** Which of ok/fail was recorded last — breaks a same-millisecond tie in write order (no ms collision reads as ok). */
  readonly lastEvent?: 'ok' | 'fail';
  readonly failures: readonly FailureMark[];
  readonly repairs: readonly { readonly at: string; readonly class: FailureClass; readonly steps: readonly string[]; readonly result: string }[];
}
export type HealthBook = Readonly<Record<string, RouteHealth>>;

export interface LedgerRow {
  readonly route: string;
  readonly provider: string;
  readonly engine: string;
  readonly model: string;
  readonly cost: CostClass;
  /** Remaining share of the fullest account, 0–100; null = the provider did not say. */
  readonly remainingPct: number | null;
  readonly usedPct: number | null;
  readonly healthy: boolean;
  readonly health: string;
  readonly lastOkAt: string | null;
  readonly lastFailAt: string | null;
  readonly lastClass: FailureClass | null;
}

// 출처: CEO 11-27 brief — cooldown per failure class before a route is tried again without a fresh success:
// overload clears quickly (provider-side burst), network a little later, quota/policy wait half an hour; auth/expired
// stay down until a repair probe or a success says otherwise.
export const COOLDOWN_MS: Readonly<Record<FailureClass, number | null>> = {
  overload: 5 * 60_000, network: 2 * 60_000, quota: 30 * 60_000, policy: 30 * 60_000, unknown: 10 * 60_000, auth: null, expired: null,
};
// 출처: CEO 11-27 «Terra 2회 과부하 실패 뒤 grok» — the failure window rules count in when no ref (PR@head) is given.
export const FAILURE_WINDOW_MS = 60 * 60_000;
// 출처: CEO 11-27 «bounded repair» — at most this many repairs per route and class per hour; the next failure → owner card.
export const REPAIRS_PER_HOUR = 2;
const KEEP_MARKS = 20;
const COST_RANK: Readonly<Record<CostClass, number>> = { subscription: 0, credits: 1, paid: 2 };

const emptyHealth = (): RouteHealth => ({ failures: [], repairs: [] });

/** Classify a provider/tool failure text. Order matters: expiry before auth, quota before overload (429 + quota words). */
export function classifyFailure(text: string): FailureClass {
  const t = text.toLowerCase();
  // A fixed value in our own tooling (hardcoded expiry · «X only» · spend-guard no-lease) is a policy fault, not a
  // provider fault — it must not read as an expired credential.
  if (/\bpolicy\b|authority expired|no-lease|no-candidate|only\b.*\b(?:engine|host)|unsupported (?:review )?engine/u.test(t)) return 'policy';
  if (/expired|invalid_grant|refresh[ _-]?token|token (?:has )?expired|re-?login|session expired/u.test(t)) return 'expired';
  if (/\b401\b|\b403\b|unauthori[sz]ed|invalid[ _-]api[ _-]key|not logged in|authentication|forbidden: auth/u.test(t)) return 'auth';
  if (/insufficient_quota|quota|usage limit|limit reached|exhausted|out of credits|credit balance|billing|\b402\b/u.test(t)) return 'quota';
  if (/overload|server_is_overloaded|\b529\b|\b503\b|\b502\b|\b500\b|rate[ _-]?limit|\b429\b|too many requests|capacity/u.test(t)) return 'overload';
  if (/econn|etimedout|enotfound|socket hang up|connection (?:refused|reset|closed)|ssh:|network|timed? ?out|unreachable/u.test(t)) return 'network';
  if (/refus|forbidden|not allowed|unsupported/u.test(t)) return 'policy';
  return 'unknown';
}

/** Used % of a route: the fullest of its accounts; openrouter (prepaid) = 100 when the balance is gone, else its row. */
export function routeUsedPct(route: RouteDef, usage: readonly UsageRow[]): { usedPct: number | null; probeError: boolean } {
  const rows = usage.filter(r => r.provider === route.provider && route.accounts.includes(r.account));
  if (!rows.length) return { usedPct: null, probeError: false };
  const ok = rows.filter(r => r.status === 'ok');
  if (!ok.length) return { usedPct: null, probeError: rows.every(r => r.status === 'error') };
  if (route.cost === 'credits' && ok.some(r => typeof r.leftUsd === 'number')) return { usedPct: ok.some(r => (r.leftUsd ?? 0) > 0) ? 0 : 100, probeError: false };
  const used = ok.map(r => r.usedPercent).filter((u): u is number => typeof u === 'number' && Number.isFinite(u));
  return { usedPct: used.length ? Math.max(...used) : null, probeError: false };
}

// 출처: CEO 11-27 «provider flaps → hysteresis, no thrash» — this many failures inside FAILURE_WINDOW_MS make a route
// «flapping»: a success no longer clears it at once; it waits out a backoff that doubles per failure (capped).
export const FLAP_FAILURES = 2;
const BACKOFF_MAX_STEPS = 4;

/** Is the route healthy now? A failure newer than the last success holds it down for its class cooldown (auth/expired:
 *  until a success or a repair probe clears it). A flapping route (≥ FLAP_FAILURES in the window) stays down for the
 *  backed-off cooldown since its last failure even when a success came in between (hysteresis). An account whose
 *  usage probe errors (e.g. `claude ✗`) is down too, unless a success was recorded after the snapshot. */
export function routeHealthy(health: RouteHealth | undefined, nowMs: number, probe: { probeError: boolean; snapshotTs?: number }): { healthy: boolean; why: string } {
  const h = health ?? emptyHealth();
  const okMs = h.lastOkAt ? Date.parse(h.lastOkAt) : -Infinity;
  const failMs = h.lastFailAt ? Date.parse(h.lastFailAt) : -Infinity;
  // Order-preserving: a failure at the same millisecond as the success is newer when it was written last.
  const failNewer = failMs > okMs || (failMs === okMs && failMs !== -Infinity && h.lastEvent === 'fail');
  const recent = h.failures.filter(f => nowMs - Date.parse(f.at) <= FAILURE_WINDOW_MS).length;
  const flapping = recent >= FLAP_FAILURES;
  if (h.lastClass && (failNewer || flapping)) {
    const base = COOLDOWN_MS[h.lastClass];
    if (base === null && failNewer) return { healthy: false, why: `${h.lastClass} since ${h.lastFailAt} (until repaired or a success)` };
    const cd = (base ?? COOLDOWN_MS.unknown!) * (flapping ? 2 ** Math.min(BACKOFF_MAX_STEPS, recent - 1) : 1);
    if (nowMs - failMs < cd) return { healthy: false, why: `${flapping ? `flapping (${recent} failures/h) · ` : ''}${h.lastClass} cooldown ${Math.ceil((cd - (nowMs - failMs)) / 60_000)}m left` };
  }
  if (probe.probeError && !(okMs > (probe.snapshotTs ?? -Infinity))) return { healthy: false, why: 'usage probe error (account unavailable)' };
  return { healthy: true, why: failNewer ? `recovered after ${h.lastClass} cooldown` : 'ok' };
}

export function buildLedger(policy: RoutePolicy, usage: readonly UsageRow[], health: HealthBook, nowMs: number, snapshotTs?: number): LedgerRow[] {
  return Object.entries(policy.routes).map(([id, r]) => {
    const u = routeUsedPct(r, usage);
    const h = routeHealthy(health[id], nowMs, { probeError: u.probeError, ...(snapshotTs !== undefined ? { snapshotTs } : {}) });
    const hb = health[id];
    return { route: id, provider: r.provider, engine: r.engine, model: r.model, cost: r.cost,
      remainingPct: u.usedPct === null ? null : Math.max(0, 100 - u.usedPct), usedPct: u.usedPct, healthy: h.healthy, health: h.why,
      lastOkAt: hb?.lastOkAt ?? null, lastFailAt: hb?.lastFailAt ?? null, lastClass: hb?.lastClass ?? null };
  });
}

export interface Pick {
  readonly use: string;
  readonly route: string | null;
  readonly def: RouteDef | null;
  /** Each candidate looked at before the pick, with the reason it was passed over. */
  readonly skipped: readonly { readonly route: string; readonly reason: string }[];
  /** 'policy' = a candidate passed every check · 'fallback' = nothing passed, cheapest healthy (or any allowed) taken ·
   *  'wait' = nothing passed and the use waits (waiver path) · 'none' = no policy / no allowed candidate. */
  readonly via: 'policy' | 'fallback' | 'wait' | 'none';
  /** One line for OP when the router fell back (never a stall, but someone must know). */
  readonly alarm: string | null;
}

function failuresFor(health: HealthBook, policy: RoutePolicy, engine: string, cls: FailureClass, nowMs: number, ref?: string): number {
  let n = 0;
  for (const [id, r] of Object.entries(policy.routes)) {
    if (r.engine !== engine) continue;
    for (const f of health[id]?.failures ?? []) {
      if (f.class !== cls) continue;
      if (ref ? f.ref === ref : nowMs - Date.parse(f.at) <= FAILURE_WINDOW_MS) n++;
    }
  }
  return n;
}

/** Pick the route for a use. `ref` (e.g. `40386@abcdef12`) scopes failure-count rules to one job. `exclude` = routes
 *  already tried by this caller (switch account / engine). */
let vetoErrorLogged = false;
export function pickRoute(input: { policy: RoutePolicy; use: string; usage: readonly UsageRow[]; health: HealthBook; nowMs: number; snapshotTs?: number; ref?: string; exclude?: readonly string[];
  /** LLM-ACCOUNT-POLICY-YAML — the account decision's veto (credits OFF on a credits route · every account skipped): a reason, or null. */
  veto?: (def: RouteDef) => string | null }): Pick {
  const { policy, use, nowMs } = input;
  const up = policy.uses[use];
  if (!up) return { use, route: null, def: null, skipped: [], via: 'none', alarm: `no routing policy for use «${use}»` };
  const forbid = new Set(up.forbidEngines ?? []);
  const skipped: { route: string; reason: string }[] = [];
  type C = { id: string; def: RouteDef; used: number | null; healthy: boolean };
  const allowed: C[] = [];
  for (const id of up.order) {
    const def = policy.routes[id];
    if (!def) { skipped.push({ route: id, reason: 'not in routes table' }); continue; }
    if (forbid.has(def.engine)) { skipped.push({ route: id, reason: `engine ${def.engine} forbidden for ${use}` }); continue; }
    if (input.exclude?.includes(id)) { skipped.push({ route: id, reason: 'already tried for this job' }); continue; }
    // null = no veto (no pack / allowed). An evaluation ERROR is not «no pack»: a credits route fails closed (money), a
    // subscription route stays allowed — logged once per process.
    const vetoed = (() => {
      try { return input.veto?.(def) ?? null; }
      catch (e) {
        if (!vetoErrorLogged) { vetoErrorLogged = true; try { (require('../debug/log.js') as typeof import('../debug/log.js')).debug.log('llm-route', 'account-policy-veto-error', { route: id, error: String(e).slice(0, 160) }, { level: 'warn' }); } catch { /* */ } }
        return def.cost === 'credits' ? 'account policy could not be evaluated — credits route fails closed' : null;
      }
    })();
    if (vetoed) { skipped.push({ route: id, reason: `account policy: ${vetoed}` }); continue; }
    const u = routeUsedPct(def, input.usage);
    const h = routeHealthy(input.health[id], nowMs, { probeError: u.probeError, ...(input.snapshotTs !== undefined ? { snapshotTs: input.snapshotTs } : {}) });
    allowed.push({ id, def, used: u.usedPct, healthy: h.healthy });
    if (!h.healthy) { skipped.push({ route: id, reason: `unhealthy: ${h.why}` }); continue; }
    if (u.usedPct !== null && u.usedPct >= policy.capPct) { skipped.push({ route: id, reason: `${u.usedPct}% used ≥ cap ${policy.capPct}%` }); continue; }
    const rule = up.rules?.[id];
    if (rule?.maxUsedPct !== undefined && u.usedPct !== null && u.usedPct >= rule.maxUsedPct) { skipped.push({ route: id, reason: `${u.usedPct}% used ≥ rule max ${rule.maxUsedPct}%` }); continue; }
    if (rule?.afterFailures) {
      const a = rule.afterFailures; const seen = failuresFor(input.health, policy, a.engine, a.class, nowMs, input.ref);
      const sameEngine = rule.orWhenAllUnavailable ? up.order.filter(o => policy.routes[o]?.engine === rule.orWhenAllUnavailable) : [];
      const allDown = sameEngine.length > 0 && sameEngine.every(o => skipped.some(s => s.route === o));
      if (seen < a.count && !allDown) { skipped.push({ route: id, reason: `fallback only after ${a.count}× ${a.engine} ${a.class} (seen ${seen})${rule.orWhenAllUnavailable ? ` or every ${rule.orWhenAllUnavailable} route unavailable` : ''}` }); continue; }
    }
    if (up.pick !== 'cheapest') return { use, route: id, def, skipped, via: 'policy', alarm: null };
  }
  const byCost = (a: C, b: C) => COST_RANK[a.def.cost] - COST_RANK[b.def.cost] || (a.used ?? 50) - (b.used ?? 50);
  if (up.pick === 'cheapest') {
    const passing = allowed.filter(c => !skipped.some(s => s.route === c.id)).sort(byCost);
    if (passing[0]) return { use, route: passing[0].id, def: passing[0].def, skipped, via: 'policy', alarm: null };
  }
  const reasons = skipped.map(s => `${s.route}: ${s.reason}`).join(' · ');
  if (up.whenAllDown === 'wait') return { use, route: null, def: null, skipped, via: 'wait', alarm: `🚨 [route ${use}] no candidate passed the policy — waiting (waiver path), not falling back · ${reasons}` };
  const healthy = allowed.filter(c => c.healthy).sort(byCost);
  const pick = healthy[0] ?? [...allowed].sort(byCost)[0];
  if (!pick) return { use, route: null, def: null, skipped, via: 'none', alarm: `🚨 [route ${use}] no allowed candidate at all — ${reasons || 'empty order'}` };
  return { use, route: pick.id, def: pick.def, skipped, via: 'fallback',
    alarm: `🚨 [route ${use}] nothing passed the policy — using ${healthy[0] ? 'cheapest healthy' : 'cheapest allowed (none healthy)'} ${pick.id} (${pick.def.provider}/${pick.def.model}) · ${reasons}` };
}

// ── health updates (pure: book in → book out) ─────────────────────────────────────────────────────────────────────

export function markOk(book: HealthBook, route: string, at: string): HealthBook {
  const h = book[route] ?? emptyHealth();
  return { ...book, [route]: { ...h, lastOkAt: at, lastEvent: 'ok' } };
}

export function markFail(book: HealthBook, route: string, f: FailureMark): HealthBook {
  const h = book[route] ?? emptyHealth();
  return { ...book, [route]: { ...h, lastFailAt: f.at, lastClass: f.class, lastEvent: 'fail', ...(f.error ? { lastError: f.error.slice(0, 300) } : {}), failures: [...h.failures, { ...f, ...(f.error ? { error: f.error.slice(0, 300) } : {}) }].slice(-KEEP_MARKS) } };
}

export interface RepairPlan {
  /** false = the repair budget for this class is spent → card to the owner instead. */
  readonly attempt: boolean;
  readonly steps: readonly ('re-probe' | 're-check-auth' | 'refresh-credential' | 'switch-account' | 'wait-cooldown')[];
  readonly card: string | null;
}

/** What the guardian does after a failure of `cls` on `route` (bounded: REPAIRS_PER_HOUR per route and class). */
export function planRepair(book: HealthBook, policy: RoutePolicy, route: string, cls: FailureClass, nowMs: number): RepairPlan {
  const h = book[route] ?? emptyHealth(); const def = policy.routes[route];
  const recent = h.repairs.filter(r => r.class === cls && nowMs - Date.parse(r.at) < 60 * 60_000).length;
  const steps: RepairPlan['steps'] = cls === 'auth' || cls === 'expired' ? ['re-check-auth', 'refresh-credential', 're-probe', 'switch-account']
    : cls === 'quota' ? ['re-probe', 'switch-account']
    : cls === 'overload' ? ['wait-cooldown', 'switch-account']
    : cls === 'network' ? ['re-probe'] : ['switch-account'];
  if (cls === 'policy') {
    // A fixed value in our tooling cannot be repaired by retrying: route around it now and tell its owner once.
    return { attempt: true, steps: ['switch-account'], card: `[수호자·연료관 · 정책 고정값] ${route} (${def?.provider ?? '?'}/${def?.model ?? '?'}) 정책 거절: ${(h.lastError ?? '').slice(0, 200)} — 다음 후보로 우회 중. 고정값(날짜·호스트·엔진·임대)을 정책표/상태로 옮겨 주세요.` };
  }
  if (recent >= REPAIRS_PER_HOUR) {
    return { attempt: false, steps: ['switch-account'], card: `[수호자·연료관 · 경로 수리 한도] ${route} (${def?.provider ?? '?'}/${def?.model ?? '?'}) ${cls} — 1시간 ${recent}회 수리 뒤에도 실패. 마지막 오류: ${(h.lastError ?? '').slice(0, 160)} · 다음 후보로 우회 중. 자격·계정 확인 부탁.` };
  }
  return { attempt: true, steps, card: null };
}

export function recordRepair(book: HealthBook, route: string, r: { at: string; class: FailureClass; steps: readonly string[]; result: string; cleared: boolean }): HealthBook {
  const h = book[route] ?? emptyHealth();
  return { ...book, [route]: { ...h, repairs: [...h.repairs, { at: r.at, class: r.class, steps: r.steps, result: r.result }].slice(-KEEP_MARKS), ...(r.cleared ? { lastOkAt: r.at, lastEvent: 'ok' as const } : {}) } };
}


// ── orchestration (ports injected: the CLI wires disk/children/mail, the sim world wires fakes) ─────────────────────

// 출처: src/statusline/sources/llm-usage.ts LLM_USAGE_STALE_MS — numbers older than 10 minutes are «(stale)»; the router
// refreshes them before deciding instead of routing on old remaining %.
export const USAGE_STALE_MS = 600_000;
// 출처: CEO 11-27 «all down → 🚨 once» — one alarm per use and kind per hour (guardian fuel alert cadence).
export const ALARM_EVERY_MS = 60 * 60_000;

export interface RouterState { readonly health: HealthBook; readonly alarms: Readonly<Record<string, string>> }
export interface UsageSnapshotIn { readonly ts: number; readonly accounts: readonly UsageRow[] }
export interface RouterPorts {
  readonly policy: RoutePolicy;
  now(): number;
  readUsage(): UsageSnapshotIn | null;
  /** Re-run the usage collector (also re-reads every provider's credentials · the «re-check auth» probe). */
  refreshUsage(): UsageSnapshotIn | null;
  readState(): RouterState;
  writeState(s: RouterState): void;
  /** One mail line (alarm to OP · card to an owner). */
  post(to: string, text: string): void;
  /** Bounded credential refresh for a route (token refresh · re-login helper); true = it says it worked. */
  refreshCredential?(route: string, def: RouteDef): boolean;
  /** LLM-ACCOUNT-POLICY-YAML — the account decision's veto for a route (null = allowed). */
  veto?(def: RouteDef): string | null;
}

export interface Decision extends Pick { readonly refreshed: boolean; readonly alarmSent: boolean }

function sendAlarmOnce(ports: RouterPorts, state: RouterState, key: string, to: string, text: string): { state: RouterState; sent: boolean } {
  const nowMs = ports.now(); const last = state.alarms[key];
  if (last && nowMs - Date.parse(last) < ALARM_EVERY_MS) return { state, sent: false };
  ports.post(to, text);
  return { state: { ...state, alarms: { ...state.alarms, [key]: new Date(nowMs).toISOString() } }, sent: true };
}

/** Decide the route for a use: refresh a stale (or missing) usage snapshot first, pick, alarm once on fallback/wait. */
export function decideRoute(ports: RouterPorts, use: string, opts: { ref?: string; exclude?: readonly string[] } = {}): Decision {
  const nowMs = ports.now();
  let usage = ports.readUsage(); let refreshed = false;
  if (!usage || nowMs - usage.ts > USAGE_STALE_MS) { usage = ports.refreshUsage() ?? usage; refreshed = true; }
  let state = ports.readState();
  const pick = pickRoute({ policy: ports.policy, use, usage: usage?.accounts ?? [], health: state.health, nowMs,
    ...(usage ? { snapshotTs: usage.ts } : {}), ...(opts.ref ? { ref: opts.ref } : {}), ...(opts.exclude ? { exclude: opts.exclude } : {}),
    ...(ports.veto ? { veto: (d: RouteDef) => ports.veto!(d) } : {}) });
  let alarmSent = false;
  if (pick.alarm) {
    const r = sendAlarmOnce(ports, state, `${use}:${pick.via}`, ports.policy.alarmTo, pick.alarm);
    state = r.state; alarmSent = r.sent;
    if (r.sent) ports.writeState(state);
  }
  return { ...pick, refreshed, alarmSent };
}

export interface FailureReport { readonly route: string; readonly class: FailureClass; readonly unhealthy: boolean; readonly repair: { readonly steps: readonly string[]; readonly result: string; readonly cleared: boolean } | null; readonly cardSent: boolean }

/** Record a call result. A failure marks the route with its class, runs the bounded repair (re-check auth via a usage
 *  re-probe · credential refresh · switch account = the next decideRoute skips it) and sends a card when repair is
 *  spent or the fault is a fixed policy value. */
export function reportResult(ports: RouterPorts, route: string, result: { ok: true } | { ok: false; error: string; ref?: string }): FailureReport {
  const nowMs = ports.now(); const at = new Date(nowMs).toISOString();
  let state = ports.readState();
  if (result.ok) {
    ports.writeState({ ...state, health: markOk(state.health, route, at) });
    return { route, class: 'unknown', unhealthy: false, repair: null, cardSent: false };
  }
  const cls = classifyFailure(result.error);
  state = { ...state, health: markFail(state.health, route, { at, class: cls, error: result.error, ...(result.ref ? { ref: result.ref } : {}) }) };
  const plan = planRepair(state.health, ports.policy, route, cls, nowMs);
  const def = ports.policy.routes[route];
  let repair: FailureReport['repair'] = null; let cardSent = false;
  if (plan.attempt && def) {
    const done: string[] = []; let cleared = false; let result_ = 'still down';
    for (const step of plan.steps) {
      if (step === 're-check-auth' || step === 're-probe') {
        done.push(step);
        const snap = ports.refreshUsage();
        // Recovered only on a verified read: the probe has this route's account row and it answered ok (the collector
        // used the credential). No row / error / unknown = not verified — the mark stays. network/quota marks wait out
        // their cooldown — the usage endpoint answering says nothing about the model's.
        const verified = !!snap && snap.accounts.some(a => a.provider === def.provider && def.accounts.includes(a.account) && a.status === 'ok');
        if (verified && (cls === 'auth' || cls === 'expired')) { cleared = true; result_ = 'probe ok (account read verified)'; break; }
      } else if (step === 'refresh-credential') {
        done.push(step);
        if (ports.refreshCredential?.(route, def)) { result_ = 'credential refreshed'; }
      } else { done.push(step); }
    }
    if (!cleared && plan.steps.includes('switch-account')) result_ = `${result_} · next candidate`;
    repair = { steps: done, result: result_, cleared };
    state = { ...state, health: recordRepair(state.health, route, { at, class: cls, steps: done, result: result_, cleared }) };
  }
  if (plan.card) {
    const r = sendAlarmOnce(ports, state, `card:${route}:${cls}`, def?.owner ?? ports.policy.alarmTo, plan.card);
    state = r.state; cardSent = r.sent;
  }
  ports.writeState(state);
  return { route, class: cls, unhealthy: !(repair?.cleared ?? false), repair, cardSent };
}
