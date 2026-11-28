// Kit gh-governor — GH-BUDGET-GOVERNOR (0.3.39 P0 · 11-28 19:0x · 20:0x KST). The one gh door (src/git-fs/gh-cli.ts) asks this
// kit before and after every GitHub call: a global secondary-limit cooldown every caller honours (no retry storm), a per-seat
// GraphQL budget per rolling hour with a ledger, and (open-pr-snapshot.ts) one shared open-PR snapshot instead of N seats each
// paging the whole PR list. Numbers live in graphs/policies/gh-governor.yaml — this file holds none.
//
// Incident: `API rate limit already exceeded for user ID …` on GraphQL while `gh api rate_limit` showed ~4,600/5,000 left =
// the SECONDARY limit. Measured 20:0x (process sampling 2 s · 295 s): 56 full open-PR `--paginate --slurp` queries (body ⊕
// files(first:100) per PR) from 23 seat worker processes, 9 at the same instant; the land graph tick then failed (gh-error).
//
// 세 얼굴: 관측 = <stateRoot>/gh-governor/{cooldown.json · ledger/<yyyymmdd>.jsonl} ⊕ debug `gh.governor` events /
// 판단 근거 = the YAML (cooldown · budget) ⊕ the answer text GitHub gave (secondary / rate limit · Retry-After) /
// 수복과 인계 = the cooldown expires by itself (escalating on repeat hits) · a refusal names the git alternative.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { resolveCallerIdentity } from '../../allocation/identity.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';

export interface GhGovernorPolicy {
  readonly snapshot: {
    readonly ttlSec: number; readonly staleMaxSec: number; readonly waitForRefresherSec: number;
    readonly lockStaleSec: number; readonly listLimit: number; readonly filesBatch: number;
  };
  readonly cooldown: { readonly defaultSec: number; readonly maxSec: number; readonly escalateFactor: number; readonly escalateWindowSec: number };
  readonly budget: { readonly graphqlPerSeatPerHour: number; readonly overrides: Readonly<Record<string, number>> };
}

export const ghGovernorPolicyPath = (root = resolve(import.meta.dir, '../../..')): string => join(root, 'graphs', 'policies', 'gh-governor.yaml');

/** Parse the policy text. A missing / non-positive number throws (the caller decides what an unreadable policy means). */
export function parseGhGovernorPolicy(text: string): GhGovernorPolicy {
  const v = parse(text) as Record<string, Record<string, unknown>> | null;
  const num = (sec: string, key: string, min = 1): number => {
    const n = v?.[sec]?.[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min) throw new Error(`gh-governor policy: invalid ${sec}.${key}`);
    return n;
  };
  const rawOverrides = v?.budget?.overrides;
  const overrides: Record<string, number> = {};
  if (rawOverrides && typeof rawOverrides === 'object') {
    for (const [seat, n] of Object.entries(rawOverrides)) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error(`gh-governor policy: invalid budget.overrides.${seat}`);
      overrides[seat.toUpperCase()] = n;
    }
  }
  return {
    snapshot: {
      ttlSec: num('open_pr_snapshot', 'ttl_sec'), staleMaxSec: num('open_pr_snapshot', 'stale_max_sec'),
      waitForRefresherSec: num('open_pr_snapshot', 'wait_for_refresher_sec', 0), lockStaleSec: num('open_pr_snapshot', 'lock_stale_sec'),
      listLimit: num('open_pr_snapshot', 'list_limit'), filesBatch: num('open_pr_snapshot', 'files_batch'),
    },
    cooldown: {
      defaultSec: num('cooldown', 'default_sec'), maxSec: num('cooldown', 'max_sec'),
      escalateFactor: num('cooldown', 'escalate_factor'), escalateWindowSec: num('cooldown', 'escalate_window_sec', 0),
    },
    budget: { graphqlPerSeatPerHour: num('budget', 'graphql_per_seat_per_hour', 0), overrides },
  };
}

let memo: { path: string; mtimeMs: number; policy: GhGovernorPolicy | null } | null = null;
/** The live policy (re-read when the file changes) · null = unreadable / invalid → the door passes calls through unchanged. */
export function liveGhGovernorPolicy(path = ghGovernorPolicyPath()): GhGovernorPolicy | null {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (memo && memo.path === path && memo.mtimeMs === mtimeMs) return memo.policy;
    let policy: GhGovernorPolicy | null = null;
    try { policy = parseGhGovernorPolicy(readFileSync(path, 'utf8')); } catch { policy = null; }
    memo = { path, mtimeMs, policy };
    return policy;
  } catch { return null; }
}

// ── Call classification ──────────────────────────────────────────────────────────────────────────────────────────────

export type GhCallKind = 'graphql' | 'rest' | 'meta';
export interface GhCallClass { readonly kind: GhCallKind; readonly write: boolean; readonly label: string }

/** gh subcommands that never reach the API (or only the free rate_limit endpoint). */
const META_TOP = new Set(['auth', 'config', 'alias', 'completion', 'help', 'version', '--version', 'extension']);
/** gh top-level commands built on GraphQL (pr · issue · repo · label · project · search). The rest of gh uses REST. */
const GRAPHQL_TOP = new Set(['pr', 'issue', 'repo', 'label', 'project', 'search', 'discussion']);
/** Read-only subcommands of the GraphQL/REST top-level commands. */
const READ_SUB = new Set(['list', 'view', 'status', 'diff', 'checks', 'search', 'watch', 'download']);

function methodOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--method' || a === '-X') return args[i + 1]?.toUpperCase();
    if (a.startsWith('--method=')) return a.slice(9).toUpperCase();
    if (/^-X.+/.test(a)) return a.slice(2).toUpperCase();
  }
  return undefined;
}
const hasField = (args: readonly string[]): boolean => args.some(a => /^(-f|-F|--raw-field|--field)(=|$)|^-[fF].+/.test(a));

/** What one gh argv costs: GraphQL or REST, read or write. `api graphql` with a mutation counts as a write. */
export function classifyGhCall(args: readonly string[]): GhCallClass {
  const top = args[0] ?? '';
  if (!top || META_TOP.has(top)) return { kind: 'meta', write: false, label: top || '(none)' };
  if (top === 'api') {
    const endpoint = args.slice(1).find(a => !a.startsWith('-') && !/^[A-Za-z_]+=/.test(a)) ?? '';
    if (/^\/?rate_limit$/.test(endpoint)) return { kind: 'meta', write: false, label: 'api rate_limit' };
    if (endpoint === 'graphql') {
      const query = args.find(a => /^query=/.test(a)) ?? '';
      return { kind: 'graphql', write: /^query=\s*mutation\b/.test(query), label: 'api graphql' };
    }
    const m = methodOf(args);
    const write = m !== undefined ? m !== 'GET' && m !== 'HEAD' : hasField(args);
    return { kind: 'rest', write, label: 'api rest' };
  }
  const sub = args[1] && !args[1].startsWith('-') ? args[1] : '';
  return { kind: GRAPHQL_TOP.has(top) ? 'graphql' : 'rest', write: !READ_SUB.has(sub), label: `${top}${sub ? ` ${sub}` : ''}` };
}

// ── Secondary-limit detection ───────────────────────────────────────────────────────────────────────────────────────

export interface RateLimitHit { readonly secondary: boolean; readonly retryAfterSec?: number; readonly text: string }

/** GitHub's own words for a limit hit (primary or secondary) in gh's stderr/stdout · null = no limit hit. */
export function detectRateLimit(output: string): RateLimitHit | null {
  const secondary = /secondary rate limit|abuse detection|exceeded a secondary/i.test(output);
  const primary = /API rate limit (already )?exceeded|rate limit exceeded|HTTP 429|was submitted too quickly/i.test(output);
  if (!secondary && !primary) return null;
  const ra = /retry[- ]after[":=\s]+(\d{1,5})/i.exec(output);
  const line = output.split(/\r?\n/).find(l => /rate limit|abuse|too quickly|429/i.test(l)) ?? '';
  return { secondary, ...(ra ? { retryAfterSec: Number(ra[1]) } : {}), text: line.trim().slice(0, 200) };
}

// ── State: cooldown file · ledger ───────────────────────────────────────────────────────────────────────────────────

export interface GovernorDeps {
  readonly stateRoot: string;
  readonly now: () => number;
  /** The caller's seat (budget key). */
  readonly seat: string;
  readonly policy: GhGovernorPolicy;
}

export interface Cooldown {
  readonly until: number; readonly at: number; readonly durationSec: number; readonly reason: string;
  readonly seat: string; readonly label: string; readonly hits: number;
}

export const governorHome = (stateRoot: string): string => join(stateRoot, 'gh-governor');
export const cooldownPath = (stateRoot: string): string => join(governorHome(stateRoot), 'cooldown.json');
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
export const ledgerPath = (stateRoot: string, ms: number): string => join(governorHome(stateRoot), 'ledger', `${ymd(ms)}.jsonl`);

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.floor(Math.random() * 1e9)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

function readCooldownFile(stateRoot: string): Cooldown | null {
  try {
    const c = JSON.parse(readFileSync(cooldownPath(stateRoot), 'utf8')) as Partial<Cooldown>;
    return typeof c.until === 'number' && typeof c.at === 'number' && typeof c.durationSec === 'number'
      ? { until: c.until, at: c.at, durationSec: c.durationSec, reason: String(c.reason ?? ''), seat: String(c.seat ?? '?'), label: String(c.label ?? ''), hits: Number(c.hits ?? 1) }
      : null;
  } catch { return null; }
}

/** The cooldown in force now · null = none (expired or absent). */
export function activeCooldown(d: Pick<GovernorDeps, 'stateRoot' | 'now'>): Cooldown | null {
  const c = readCooldownFile(d.stateRoot);
  return c && c.until > d.now() ? c : null;
}

/** Record a limit hit: Retry-After when GitHub gave one, else the default; a repeat hit soon after the last one escalates. */
export function noteRateLimit(d: GovernorDeps, hit: RateLimitHit, label: string): Cooldown {
  const now = d.now();
  const prev = readCooldownFile(d.stateRoot);
  const p = d.policy.cooldown;
  // Still cooling: another caller's answer arrived late — keep the cooldown (no extension storm), count the hit.
  if (prev && prev.until > now) {
    const kept = { ...prev, hits: prev.hits + 1 };
    writeJsonAtomic(cooldownPath(d.stateRoot), kept);
    return kept;
  }
  const repeat = prev !== null && now - prev.until <= p.escalateWindowSec * 1000;
  const base = hit.retryAfterSec ?? (repeat ? prev!.durationSec * p.escalateFactor : p.defaultSec);
  const durationSec = Math.min(p.maxSec, Math.max(1, Math.round(base)));
  const c: Cooldown = { until: now + durationSec * 1000, at: now, durationSec, reason: hit.text || 'rate limit', seat: d.seat, label, hits: 1 };
  writeJsonAtomic(cooldownPath(d.stateRoot), c);
  return c;
}

/** `cache` = the gh-proxy door answered an identical read from its shared cache (kit/gh-proxy/door.ts) — no GitHub call, never budgeted. */
export type LedgerOutcome = 'ok' | 'fail' | 'rate-limited' | 'cooldown' | 'budget' | 'cache';
export interface LedgerRow { readonly t: number; readonly s: string; readonly k: GhCallKind; readonly w: 0 | 1; readonly l: string; readonly o: LedgerOutcome }

export function appendLedger(d: Pick<GovernorDeps, 'stateRoot' | 'now'>, row: Omit<LedgerRow, 't'>): void {
  const t = d.now();
  const p = ledgerPath(d.stateRoot, t);
  try { mkdirSync(join(p, '..'), { recursive: true }); appendFileSync(p, `${JSON.stringify({ t, ...row })}\n`); } catch { /* the ledger must never fail a call */ }
}

export function readLedgerWindow(stateRoot: string, fromMs: number, toMs: number): LedgerRow[] {
  const days = [...new Set([ledgerPath(stateRoot, fromMs), ledgerPath(stateRoot, toMs)])];
  const rows: LedgerRow[] = [];
  for (const p of days) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line) as LedgerRow; if (r.t >= fromMs && r.t <= toMs) rows.push(r); } catch { /* torn line */ }
    }
  }
  return rows;
}

/** GraphQL calls of this seat that reached GitHub in the last hour (refusals do not count). */
export function graphqlUsedLastHour(d: Pick<GovernorDeps, 'stateRoot' | 'now'>, seat: string): number {
  const now = d.now();
  return readLedgerWindow(d.stateRoot, now - 3_600_000, now).filter(r => r.s === seat && r.k === 'graphql' && (r.o === 'ok' || r.o === 'fail' || r.o === 'rate-limited')).length;
}

export const seatBudget = (policy: GhGovernorPolicy, seat: string): number => policy.budget.overrides[seat.toUpperCase()] ?? policy.budget.graphqlPerSeatPerHour;

/** The budget key of this process: its seat (ELANOUS_TRACK · ELANOUS_SEAT · cwd seats/<X> · COORD_ID), else the principal. */
export function governorSeat(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const id = resolveCallerIdentity(env, cwd);
  const seat = id.chain.find(l => l.kind === 'seat');
  return seat ? seat.id : id.kind === 'unattributed' ? 'unattributed' : `${id.kind}:${id.id}`;
}

/** The governor of this process (live policy · instance state root · caller seat) · null = policy unreadable → pass-through.
 *  Shared by the gh gateway (git-fs/gh-cli.ts) and the gh-proxy shim door (kit/gh-proxy/door.ts). */
export function liveGhGovernorDeps(): GovernorDeps | null {
  const policy = liveGhGovernorPolicy();
  if (!policy) return null;
  try { return { stateRoot: effectiveInstanceRoot(), now: Date.now, seat: governorSeat(), policy }; } catch { return null; }
}

// ── The door's decision ─────────────────────────────────────────────────────────────────────────────────────────────

/** Exit code of a governed refusal (EX_TEMPFAIL): the caller may retry after the named time. */
export const GOVERNOR_EXIT = 75;
/** Env marker on every gh child a governed door spawns (git-fs/gh-cli.ts · kit/gh-proxy/door.ts): the PATH shim
 *  (bin/gh-shim/gh) seeing it execs the real gh at once — one call is governed once, and the shim can never loop. */
export const GH_DOOR_ENV = 'ELN_GH_DOOR';
export const GIT_ALTERNATIVES = 'git ls-remote origin refs/pull/<N>/head (PR head) · git log origin/main --grep "(#<N>)" (착지 감지) · eln work next (공유 열린 PR 스냅숏)';

export type Preflight = { readonly allow: true } | { readonly allow: false; readonly outcome: 'cooldown' | 'budget'; readonly message: string };

const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 19) + 'Z';

/** Before one gh call: cooldown (every caller, read or write) → budget (reads only). Writes the ledger row of a refusal. */
export function preflightGhCall(d: GovernorDeps, c: GhCallClass): Preflight {
  if (c.kind === 'meta') return { allow: true };
  const cool = activeCooldown(d);
  if (cool) {
    appendLedger(d, { s: d.seat, k: c.kind, w: c.write ? 1 : 0, l: c.label, o: 'cooldown' });
    return { allow: false, outcome: 'cooldown', message: `[gh-governor] SKIPPED ${c.label} · GitHub cooldown until ${clock(cool.until)} (${Math.ceil((cool.until - d.now()) / 1000)}s left · ${cool.reason || 'rate limit'} · set by ${cool.seat} at ${clock(cool.at)}) — 재시도 금지, 만료 뒤 다시 · 대안: ${GIT_ALTERNATIVES}` };
  }
  // An unattributed caller (daemon · no seat) is metered, never refused — the allocation identity rule (allocation/identity.ts).
  if (c.kind === 'graphql' && !c.write && d.seat !== 'unattributed') {
    const cap = seatBudget(d.policy, d.seat);
    const used = graphqlUsedLastHour(d, d.seat);
    if (used >= cap) {
      appendLedger(d, { s: d.seat, k: c.kind, w: 0, l: c.label, o: 'budget' });
      return { allow: false, outcome: 'budget', message: `[gh-governor] REFUSED ${c.label} · seat ${d.seat} GraphQL budget ${used}/${cap} per hour (graphs/policies/gh-governor.yaml) — 반복 조회 대신: ${GIT_ALTERNATIVES}` };
    }
  }
  return { allow: true };
}

/** After one gh call that reached GitHub: the ledger row, and a limit hit → the global cooldown. Returns the hit, if any. */
export function observeGhCall(d: GovernorDeps, c: GhCallClass, r: { readonly exitCode: number; readonly output: string }): Cooldown | null {
  if (c.kind === 'meta') return null;
  const hit = r.exitCode === 0 ? null : detectRateLimit(r.output);
  appendLedger(d, { s: d.seat, k: c.kind, w: c.write ? 1 : 0, l: c.label, o: hit ? 'rate-limited' : r.exitCode === 0 ? 'ok' : 'fail' });
  return hit ? noteRateLimit(d, hit, c.label) : null;
}

export interface RawGhRun { readonly status: number | null; readonly stdout: Buffer; readonly stderr: Buffer }

/** One governed attempt: refuse (cooldown · budget) without spawning, else run and observe. `exec` is the real (or sim) gh. */
export function governGhRun(d: GovernorDeps | null, args: readonly string[], exec: () => RawGhRun): RawGhRun & { refused?: 'cooldown' | 'budget' } {
  if (!d) return exec();
  const c = classifyGhCall(args);
  const pre = preflightGhCall(d, c);
  if (!pre.allow) return { status: GOVERNOR_EXIT, stdout: Buffer.alloc(0), stderr: Buffer.from(`${pre.message}\n`), refused: pre.outcome };
  const out = exec();
  observeGhCall(d, c, { exitCode: out.status ?? 1, output: `${out.stderr.toString('utf8')}\n${out.stdout.length < 4096 ? out.stdout.toString('utf8') : ''}` });
  return out;
}

export async function governGhRunAsync(d: GovernorDeps | null, args: readonly string[], exec: () => Promise<RawGhRun>): Promise<RawGhRun & { refused?: 'cooldown' | 'budget' }> {
  if (!d) return exec();
  const c = classifyGhCall(args);
  const pre = preflightGhCall(d, c);
  if (!pre.allow) return { status: GOVERNOR_EXIT, stdout: Buffer.alloc(0), stderr: Buffer.from(`${pre.message}\n`), refused: pre.outcome };
  const out = await exec();
  observeGhCall(d, c, { exitCode: out.status ?? 1, output: `${out.stderr.toString('utf8')}\n${out.stdout.length < 4096 ? out.stdout.toString('utf8') : ''}` });
  return out;
}

/** Thrown by governed readers (snapshot · land graph) when the door refused: a skip, not a failure of the caller's logic. */
export class GhGovernorRefusal extends Error {
  readonly governor = true as const;
  constructor(readonly outcome: 'cooldown' | 'budget' | 'rate-limited', message: string) { super(message); this.name = 'GhGovernorRefusal'; }
}
export const isGovernorRefusal = (e: unknown): e is GhGovernorRefusal => !!e && typeof e === 'object' && (e as { governor?: unknown }).governor === true;
