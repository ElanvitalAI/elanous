// STEWARD-SPACE R0 — the snapshot, read only through existing CLIs and ledgers:
//   els panes = `eln side ls --json` · cells = `eln release checklist status --json` · PRs = `gh pr list --json`
//   receipts = PREGATE-GREEN dirs (config) · verdicts = review-results jud/judb/hold files (config) · host load = latest UTIL
//   tsv · scopes = federation ladder (els journal ⊕ federation.yaml) · open ✋ = msg ledger (read-only).
// A source that fails is named in `sourceErrors`; the nodes that depend on it skip (fail closed — an unreadable receipts
// dir must never look like «no receipts»).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { spawnElanousSync } from '../../instance/spawn-elanous.js';
import { dedupeHands, loadDeclaredSeatRoles, loadFederationLadder, openHands } from '../../msg/hand-raise-ladder.js';
import { defaultMsgStorePath, openMsgStoreReadOnly } from '../../msg/msg-store.js';
import { getElanousConfigDir, getElanousConfigDirOverride } from '../../elanous-config-dir.js';
import { defaultWakeLedgerPath, recentSeatWakes } from '../../seat/wake-ledger.js';
import { activityFromClock, sessionIdOfCommand, sessionModelActivityMs } from './activity.js';
import type { StewardSpaceConfig } from './config.js';
import type { CellView, HostView, MergedView, OpenHandView, PrView, ReceiptView, SeatView, Snapshot, VerdictView } from './model.js';

export const DEFAULT_RECEIPTS_DIR = join(homedir(), 'elanous-hq/seat-state/RES/evidence/PREGATE-GREEN');
/** review-results lives under the state root (resolver, never a literal home path — isolation gate). */
export const defaultReviewResultsDir = (): string => join(effectiveInstanceRoot(), 'review-results');
export const DEFAULT_UTIL_DIR = join(homedir(), 'elanous-hq/seat-state/K-EAST');
const RECENT_MS = 7 * 24 * 60 * 60_000;

const json = (text: string): unknown => JSON.parse(text);

const CHILD = { encoding: 'utf8' as const, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 };

function parsed(label: string, out: { status: number | null; stdout: string | Buffer }): unknown {
  if (out.status !== 0) throw new Error(`${label} rc=${out.status ?? 'signal'}`);
  return json(String(out.stdout));
}

/** GitHub CLI read (gh pr list) — run in the release repo's checkout (or with `--repo`), never the caller's cwd. */
export function ghJson(args: readonly string[], target: GhTarget): unknown {
  return parsed(`gh ${args.slice(0, 3).join(' ')}`, spawnSync('gh', [...args, ...target.args], { ...CHILD, ...(target.cwd ? { cwd: target.cwd } : {}) }));
}

/**
 * RAIL30 ③ — where `gh pr list` runs. 11-25: the steward ran from a non-git cwd, `gh pr list` exited rc=1 and R2/R5
 * deferred «source-missing:prs» all day. Order (no home literal):
 *   config `loops.stewardSpace.repo` = `owner/name` → `--repo owner/name`
 *   config `loops.stewardSpace.repo` = a checkout path → cwd there (+ `--repo` from its origin remote)
 *   absent → the checkout this code runs from (git root above the code) as cwd, `--repo` from its origin remote, else
 *            from package.json `repository.url` (an installed copy has no .git)
 */
export interface GhTarget { readonly cwd?: string; readonly args: readonly string[] }

export interface GhTargetDeps {
  readonly codeRoot: string;
  readonly exists: (path: string) => boolean;
  /** `git remote get-url origin` in `dir` (null = none). */
  readonly originUrl: (dir: string) => string | null;
  /** package.json `repository` url at `dir` (null = none). */
  readonly packageRepoUrl: (dir: string) => string | null;
}

const SLUG = /^[\w.-]+\/[\w.-]+$/;

/** `owner/name` from a GitHub remote url (https · ssh · git+https) — null when it is not one. */
export function githubSlug(url: string | null | undefined): string | null {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec((url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function gitRootAbove(dir: string, exists: (p: string) => boolean): string | null {
  let d = dir;
  for (let i = 0; i < 30; i++) {
    if (exists(join(d, '.git'))) return d;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  return null;
}

export function resolveGhTarget(configRepo: string | undefined, deps: GhTargetDeps): GhTarget {
  const given = configRepo?.trim();
  if (given && SLUG.test(given) && !given.startsWith('/') && !given.startsWith('.')) return { args: ['--repo', given] };
  const viaCheckout = (dir: string): GhTarget => {
    const slug = githubSlug(deps.originUrl(dir)) ?? githubSlug(deps.packageRepoUrl(dir));
    return { cwd: dir, args: slug ? ['--repo', slug] : [] };
  };
  if (given && deps.exists(given)) return viaCheckout(given);
  const root = gitRootAbove(deps.codeRoot, deps.exists);
  if (root) return viaCheckout(root);
  const slug = githubSlug(deps.packageRepoUrl(deps.codeRoot));
  return { cwd: deps.codeRoot, args: slug ? ['--repo', slug] : [] };
}

/** Production deps: this module's package root (src/steward/space → ../../..). */
export function liveGhTargetDeps(): GhTargetDeps {
  return {
    codeRoot: join(import.meta.dir, '..', '..', '..'),
    exists: existsSync,
    originUrl: (dir) => {
      const out = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 10_000 });
      return out.status === 0 ? String(out.stdout).trim() || null : null;
    },
    packageRepoUrl: (dir) => {
      try {
        const pkg = json(readFileSync(join(dir, 'package.json'), 'utf8')) as { repository?: string | { url?: string } };
        const repo = pkg.repository;
        return typeof repo === 'string' ? repo : typeof repo?.url === 'string' ? repo.url : null;
      } catch { return null; }
    },
  };
}

/** Our own CLI read, through the universe-stamped helper. */
function cliJson(args: readonly string[]): unknown {
  return parsed(args.slice(0, 3).join(' '), spawnElanousSync(args, CHILD));
}

/** `activityOf(sessionId)` = the session's last model row (activity.ts); absent or null = els decides (older behaviour). */
export function parsePanes(body: unknown, nowMs: number, activityOf?: (sessionId: string) => number | null): SeatView[] {
  const panes = (body as { panes?: unknown[] })?.panes;
  if (!Array.isArray(panes)) throw new Error('els ls: no panes');
  const out = new Map<string, SeatView>();
  for (const raw of panes) {
    const p = raw as { seat?: unknown; activityState?: unknown; lastEventAtMs?: unknown; status?: { state?: unknown; since?: unknown }; fgCommand?: unknown };
    if (typeof p.seat !== 'string' || !p.seat) continue;
    const seat = p.seat.toUpperCase();
    const els = typeof p.activityState === 'string' ? p.activityState : 'unknown';
    // The model clock (the session's last assistant/tool row) decides; els only confirms a long continuous WORKING.
    const sessionId = activityOf ? sessionIdOfCommand(p.fgCommand) : null;
    let modelAtMs: number | null = null;
    if (sessionId) { try { modelAtMs = activityOf!(sessionId); } catch { modelAtMs = null; } }
    const st = p.status && typeof p.status === 'object' ? p.status : undefined;
    const clock = activityFromClock({ els, modelAtMs,
      elsWorkingSinceMs: st && String(st.state ?? '').toUpperCase() === 'WORKING' && typeof st.since === 'number' ? st.since : null }, nowMs);
    if (clock) {
      const prior = out.get(seat);
      const view: SeatView = { seat, activity: clock.activity, idleForMs: clock.idleForMs, lastActiveMs: clock.lastActiveMs };
      if (!prior || clock.activity === 'working' || (prior.activity !== 'working' && (clock.idleForMs ?? 0) < (prior.idleForMs ?? Infinity))) out.set(seat, view);
      continue;
    }
    const activity = els;
    // Idle duration = since the pane ENTERED idle (`status.since`). `lastEventAtMs` is refreshed by every screen/heartbeat
    // event, so on 11-25 15:37 every idle hand read 4 min idle and none reached the 10-min bar (TC «idle 12», 0 matched).
    // Fallback to the last event only for an older els that has no status block.
    const status = p.status && typeof p.status === 'object' ? p.status : undefined;
    const since = status && String(status.state ?? '').toLowerCase() === 'idle' && typeof status.since === 'number' ? status.since
      : !status && typeof p.lastEventAtMs === 'number' ? p.lastEventAtMs : null;
    const idleForMs = activity === 'idle' && since !== null ? Math.max(0, nowMs - since) : null;
    const prior = out.get(seat);
    // One seat in two panes: working wins; otherwise the shorter idle (the seat is as busy as its busiest pane).
    if (!prior || activity === 'working' || (prior.activity !== 'working' && (idleForMs ?? 0) < (prior.idleForMs ?? Infinity))) out.set(seat, { seat, activity, idleForMs });
  }
  return [...out.values()];
}

export function parseChecklist(body: unknown): { version: string; cells: CellView[] } {
  const b = body as { version?: unknown; items?: unknown[] };
  if (typeof b?.version !== 'string' || !Array.isArray(b.items)) throw new Error('checklist: no items');
  return { version: b.version, cells: b.items.flatMap((raw) => {
    const i = raw as Record<string, unknown>;
    if (typeof i.id !== 'string' || typeof i.status !== 'string') return [];
    return [{ id: i.id, title: String(i.title ?? '').split('\n')[0]!.slice(0, 120), status: i.status,
      ...(typeof i.owner === 'string' && i.owner ? { owner: i.owner } : {}),
      ...(typeof i.priority === 'string' ? { priority: i.priority } : {}), updatedAt: String(i.updatedAt ?? '') }];
  }) };
}

export function parsePrs(body: unknown): PrView[] {
  if (!Array.isArray(body)) throw new Error('gh pr list: not an array');
  return body.flatMap((raw) => {
    const p = raw as Record<string, unknown>;
    if (typeof p.number !== 'number' || typeof p.headRefOid !== 'string') return [];
    const files = Array.isArray(p.files) ? p.files.map((f) => String((f as { path?: unknown }).path ?? '')).filter(Boolean) : undefined;
    return [{ number: p.number, head: p.headRefOid, branch: String(p.headRefName ?? ''), title: String(p.title ?? ''),
      draft: p.isDraft === true, updatedAt: String(p.updatedAt ?? ''), ...(files ? { files } : {}) }];
  });
}

export function parseMerged(body: unknown): MergedView[] {
  if (!Array.isArray(body)) throw new Error('gh merged: not an array');
  return body.flatMap((raw) => {
    const p = raw as Record<string, unknown>;
    const at = Date.parse(String(p.mergedAt ?? ''));
    return typeof p.number === 'number' && Number.isFinite(at) ? [{ number: p.number, branch: String(p.headRefName ?? ''), mergedAtMs: at }] : [];
  });
}

const RECEIPT_DIR = /^(\d+)-([0-9a-f]{12})-([\w.-]+)$/;
export function readReceipts(dir: string, nowMs: number): ReceiptView[] {
  return readdirSync(dir).flatMap((name) => {
    const m = RECEIPT_DIR.exec(name);
    if (!m) return [];
    const path = join(dir, name, 'receipt.json');
    try {
      const st = statSync(path);
      if (nowMs - st.mtimeMs > RECENT_MS) return [];
      const status = String((json(readFileSync(path, 'utf8')) as { status?: unknown }).status ?? 'unknown');
      return [{ pr: Number(m[1]), head12: m[2]!, host: m[3]!, status, atMs: st.mtimeMs }];
    } catch { return [{ pr: Number(m[1]), head12: m[2]!, host: m[3]!, status: 'unreadable', atMs: 0 }]; }
  });
}

const VERDICT_FILE = /^(jud|judb|hold)-(\d+)-([0-9a-f]{12})[^/]*\.json$/;
export function readVerdicts(dir: string, nowMs: number): VerdictView[] {
  return readdirSync(dir).flatMap((name) => {
    const m = VERDICT_FILE.exec(name);
    if (!m) return [];
    try {
      const path = join(dir, name);
      const st = statSync(path);
      if (nowMs - st.mtimeMs > RECENT_MS) return [];
      const kind = m[1] as VerdictView['kind'];
      const verdict = kind === 'hold' ? 'hold' : String((json(readFileSync(path, 'utf8')) as { verdict?: unknown }).verdict ?? 'unknown');
      return [{ pr: Number(m[2]), head12: m[3]!, kind, verdict, atMs: st.mtimeMs }];
    } catch { return []; }
  });
}

/** Latest `UTIL-HHMM.tsv`: host · load1 · ncpu (`stopped` load = stopped VM). Unmeasured values stay null. */
export function readUtil(dir: string, nowMs: number): { hosts: HostView[]; ageMs: number | null } {
  const latest = readdirSync(dir).filter((n) => /^UTIL-\d{4}\.tsv$/.test(n))
    .map((n) => ({ path: join(dir, n), mtime: statSync(join(dir, n)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0];
  if (!latest) return { hosts: [], ageMs: null };
  return { hosts: parseUtil(readFileSync(latest.path, 'utf8')), ageMs: Math.max(0, nowMs - latest.mtime) };
}

export function parseUtil(text: string): HostView[] {
  const [head, ...lines] = text.trimEnd().split(/\r?\n/);
  const cols = (head ?? '').split('\t');
  const [h, l, n] = ['host', 'load1', 'ncpu'].map((c) => cols.indexOf(c));
  if (h! < 0 || l! < 0 || n! < 0) return [];
  const num = (v: string | undefined): number | null => (v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
  return lines.map((line) => line.split('\t')).filter((f) => f.length === cols.length)
    .map((f) => ({ host: f[h!]!, load1: num(f[l!]), ncpu: num(f[n!]), stopped: f[l!] === 'stopped' }));
}

export interface SnapshotSources {
  readonly panes: () => unknown;
  readonly checklist: () => unknown;
  readonly prs: () => unknown;
  readonly merged: () => unknown;
  readonly receipts: () => ReceiptView[];
  readonly verdicts: () => VerdictView[];
  readonly util: () => { hosts: HostView[]; ageMs: number | null };
  readonly ladder: () => { hq: string; parentOf(seat: string): string; depthOf(seat: string): number };
  readonly openHands: (ladder: { parentOf(seat: string): string }) => OpenHandView[];
  /** The seat session's last model row (epoch ms); absent = els state only. */
  readonly sessionActivity?: (sessionId: string) => number | null;
  /** Latest `eln work next` call per seat (epoch ms) — a hand that pulled is not woken. */
  readonly pulls?: () => Record<string, number>;
  /** SHARED-WAKE-LEDGER rows inside the window (seat → by · at). */
  readonly wakes?: () => Record<string, { by: string; atMs: number }>;
  /** federation.yaml seat roles (seat → role) — the judge side is decided by role, not by name prefix only. */
  readonly roles?: () => Record<string, string>;
}

export function liveSources(config: StewardSpaceConfig | undefined, nowMs: number): SnapshotSources {
  let target: GhTarget | null = null;
  const gh = (args: readonly string[]): unknown => ghJson(args, target ??= resolveGhTarget(config?.repo, liveGhTargetDeps()));
  return {
    panes: () => cliJson(['side', 'ls', '--json']),
    checklist: () => cliJson(['release', 'checklist', 'status', '--json']),
    prs: () => gh(['pr', 'list', '--state', 'open', '--limit', '150', '--json', 'number,headRefOid,headRefName,title,isDraft,updatedAt,files']),
    merged: () => gh(['pr', 'list', '--state', 'merged', '--limit', '60', '--json', 'number,headRefName,mergedAt']),
    receipts: () => readReceipts(config?.receiptsDir ?? DEFAULT_RECEIPTS_DIR, nowMs),
    verdicts: () => readVerdicts(config?.reviewResultsDir ?? defaultReviewResultsDir(), nowMs),
    util: () => (existsSync(config?.utilDir ?? DEFAULT_UTIL_DIR) ? readUtil(config?.utilDir ?? DEFAULT_UTIL_DIR, nowMs) : { hosts: [], ageMs: null }),
    ladder: () => loadFederationLadder(),
    sessionActivity: (sessionId) => sessionModelActivityMs(seatSessionsDir(), sessionId),
    pulls: () => readPulls(effectiveInstanceRoot(), nowMs),
    wakes: () => recentSeatWakes(defaultWakeLedgerPath(), nowMs),
    roles: () => loadDeclaredSeatRoles(),
    openHands: (ladder) => {
      const store = openMsgStoreReadOnly(defaultMsgStorePath());
      try { return dedupeHands(openHands(store, { now: nowMs, ladder })).map(({ lead: h, members }) => ({ receiver: h.receiver, waitedMs: Math.max(...members.map((m) => m.waitedMs)), sender: h.sender, blockedSeat: h.blockedSeat })); }
      finally { store.close(); }
    },
  };
}

/** Build the snapshot. Each source is independent; a failure is named and its data stays empty. */
export function buildSnapshot(sources: SnapshotSources, nowMs: number): Snapshot {
  const errors: string[] = [];
  const attempt = <T>(name: string, fn: () => T, fallback: T): T => {
    try { return fn(); } catch (error) { errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)); return fallback; }
  };
  const seats = attempt('panes', () => parsePanes(sources.panes(), nowMs, sources.sessionActivity), [] as SeatView[]);
  const list = attempt('checklist', () => parseChecklist(sources.checklist()), { version: '', cells: [] as CellView[] });
  const prs = attempt('prs', () => parsePrs(sources.prs()), [] as PrView[]);
  const merged = attempt('merged', () => parseMerged(sources.merged()), [] as MergedView[]);
  const receipts = attempt('receipts', () => sources.receipts(), [] as ReceiptView[]);
  const verdicts = attempt('verdicts', () => sources.verdicts(), [] as VerdictView[]);
  const util = attempt('util', () => sources.util(), { hosts: [] as HostView[], ageMs: null as number | null });
  const fallbackHq = (() => { try { return (require('../../org/org-map.js') as typeof import('../../org/org-map.js')).orgDuty('escalation-parent'); } catch { return 'OP'; } })();
  const ladder = attempt('ladder', () => sources.ladder(), { hq: fallbackHq, parentOf: () => fallbackHq, depthOf: (s: string) => (s === fallbackHq ? 1 : 3) });
  const hq = ladder.hq;
  const known = new Set<string>([hq, ...seats.map((s) => s.seat),
    ...list.cells.flatMap((c) => (c.owner ? [c.owner.split('/')[0]!.toUpperCase()] : []))]);
  const parent: Record<string, string> = {};
  const coordinators = new Set<string>();
  for (const seat of known) {
    if (seat === hq) continue;
    parent[seat] = ladder.parentOf(seat).toUpperCase();
    if (ladder.depthOf(seat) === 2) coordinators.add(seat);
  }
  // A coordinator only named as some seat's parent is still a scope.
  for (const p of Object.values(parent)) if (p !== hq && ladder.depthOf(p) === 2) coordinators.add(p);
  const hands = attempt('hands', () => sources.openHands(ladder), [] as OpenHandView[]);
  const pulls = sources.pulls ? attempt('pulls', () => sources.pulls!(), {} as Record<string, number>) : {};
  const wakes = sources.wakes ? attempt('wakes', () => sources.wakes!(), {} as Record<string, { by: string; atMs: number }>) : {};
  const roles = sources.roles ? attempt('roles', () => sources.roles!(), {} as Record<string, string>) : {};
  return { nowMs, hq, coordinators: [...coordinators].sort(), parent, seats, version: list.version, cells: list.cells, prs, merged,
    receipts, verdicts, hosts: util.hosts, utilAgeMs: util.ageMs, openHands: hands, pulls, wakes, roles, sourceErrors: errors };
}

/** Nodes that must not act on a snapshot missing these sources. */
export const NODE_NEEDS: Record<string, readonly string[]> = {
  r1: ['panes', 'checklist', 'ladder'],
  r2: ['prs', 'receipts', 'util', 'ladder'],
  r3: ['panes', 'prs', 'receipts', 'verdicts', 'ladder'],
  r4: ['prs', 'verdicts'],
  r5: ['checklist', 'prs', 'receipts'],
  r6: [],
};

export function missingFor(node: string, snap: Pick<Snapshot, 'sourceErrors'>): string[] {
  const failed = new Set(snap.sourceErrors.map((e) => e.split(':')[0]!));
  return (NODE_NEEDS[node] ?? []).filter((s) => failed.has(s));
}

// ── work next ledger (PULL) ───────────────────────────────────────────────────────────────────

export const pullLedgerPath = (root: string): string => join(root, 'steward', 'work-next.jsonl');

/** seat → latest `eln work next` call within the last 2 h. */
export function readPulls(root: string, nowMs: number): Record<string, number> {
  const path = pullLedgerPath(root);
  if (!existsSync(path)) return {};
  const out: Record<string, number> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { seat?: unknown; at?: unknown };
      const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
      if (typeof row.seat === 'string' && Number.isFinite(at) && nowMs - at <= 2 * 3_600_000 && at > (out[row.seat] ?? 0)) out[row.seat] = at;
    } catch { /* a torn line is skipped */ }
  }
  return out;
}

/** The eln session store (same resolution as session/index.ts sessionRoot, without importing the session runtime). */
export function seatSessionsDir(): string {
  const override = process.env.ELANOUS_SESSION_ROOT?.trim();
  if (override) return override;
  const configDir = getElanousConfigDirOverride()?.trim();
  if (configDir) return join(configDir, 'sessions');
  const stateDir = process.env.ELANOUS_STATE_DIR?.trim();
  if (stateDir) return join(stateDir, 'sessions');
  return join(getElanousConfigDir(), 'sessions');
}
