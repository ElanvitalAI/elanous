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
import { readRemoteUrl } from '../../git-fs/origin-url.js';
import { activeBoardVersion } from '../../ops-dashboard/current-version.js';
import { spawnElanousSync } from '../../instance/spawn-elanous.js';
import { dedupeHands, loadDeclaredSeatRoles, loadFederationLadder, openHands } from '../../msg/hand-raise-ladder.js';
import { defaultMsgStorePath, openMsgStoreReadOnly } from '../../msg/msg-store.js';
import { getElanousConfigDir, getElanousConfigDirOverride } from '../../elanous-config-dir.js';
import { defaultWakeLedgerPath, recentSeatWakes } from '../../seat/wake-ledger.js';
import { activityFromClock, sessionIdOfCommand, sessionModelActivityMs } from './activity.js';
import { STEWARD_SPACE_DEFAULTS, type StewardSpaceConfig } from './config.js';
import { readGreenTriageSources, triageGreen, type GreenTriageSources } from '../../release-loop/green-triage.js';
import { lanesOfTriage, type CellLanes } from './cell-wait.js';
import { loadHqPolicy } from './hq-shadow.js';
import { readAllOpenPrs } from '../../kit/work-pull/open-pr-pages.js';
import { livePullPolicy, readRoster, rosterRank, rosterRankRecord, type PullPolicy, type RosterRankLike } from '../../kit/work-pull/index.js';
import { cellAreaPaths, liveSeatRoles, type SeatRolesPolicy } from '../../kit/seat-area/index.js';
import type { CellView, HostView, JudgeCellView, MergedView, OpenHandView, PrView, ReceiptView, SeatView, Snapshot, VerdictView } from './model.js';

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
export function ghJson(args: readonly string[], target: GhTarget, timeoutMs: number = CHILD.timeout): unknown {
  return parsed(`gh ${args.slice(0, 3).join(' ')}`, spawnSync('gh', [...args, ...target.args], { ...CHILD, timeout: timeoutMs, ...(target.cwd ? { cwd: target.cwd } : {}) }));
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
  /** The raw configured origin URL of `dir` (src/git-fs/origin-url.ts · null = none). */
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
      // GH-MIRROR-ORIGIN-URL-SAFE: the raw configured URL — a fetch mirror's insteadOf turns get-url into a local path
      return readRemoteUrl(dir);
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
function cliJson(args: readonly string[], timeoutMs: number = CHILD.timeout): unknown {
  return parsed(args.slice(0, 3).join(' '), spawnElanousSync(args, { ...CHILD, timeout: timeoutMs }));
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
      ...(typeof i.priority === 'string' ? { priority: i.priority } : {}), updatedAt: String(i.updatedAt ?? ''),
      ...(typeof i.dispatchKind === 'string' && i.dispatchKind ? { dispatchKind: i.dispatchKind } : {}),
      ...(typeof i.evidence === 'string' && i.evidence.trim() ? { evidenceHead: i.evidence.trim().split('\n')[0]!.slice(0, 120) } : {}),
      ...(typeof i.updatedBy === 'string' && i.updatedBy ? { updatedBy: i.updatedBy } : {}),
      ...(i.writer && typeof (i.writer as { seat?: unknown }).seat === 'string' && typeof (i.writer as { at?: unknown }).at === 'string'
        ? { writer: { seat: (i.writer as { seat: string }).seat, at: (i.writer as { at: string }).at } } : {}),
      // SEAT-AREA-GUARD — area signals over the full text (the view keeps only the title's first line).
      ...(() => { const paths = cellAreaPaths({ id: i.id as string, title: String(i.title ?? ''), body: typeof i.body === 'string' ? i.body : '', doneCriterion: typeof i.doneCriterion === 'string' ? i.doneCriterion : '' }); return paths.length ? { areaPaths: paths } : {}; })() }];
  }) };
}

export function parsePrs(body: unknown): PrView[] {
  if (!Array.isArray(body)) throw new Error('gh pr list: not an array');
  return body.flatMap((raw) => {
    const p = raw as Record<string, unknown>;
    if (typeof p.number !== 'number' || typeof p.headRefOid !== 'string') return [];
    const files = Array.isArray(p.files) ? p.files.map((f) => String((f as { path?: unknown }).path ?? '')).filter(Boolean) : undefined;
    return [{ number: p.number, head: p.headRefOid, branch: String(p.headRefName ?? ''), title: String(p.title ?? ''),
      body: typeof p.body === 'string' ? p.body : '', draft: p.isDraft === true, updatedAt: String(p.updatedAt ?? ''), ...(files ? { files } : {}) }];
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
  /** JUD-HAND-DISCOVERY: the judge-butler's last tick (JSON) — cells it refused with «JUD signs this one». */
  readonly judgeCells?: () => unknown;
  /** Declared federation seats (seat registry ⊕ federation.yaml) — a declared hand with no pane joins as `no-pane`. */
  readonly declaredSeats?: () => Iterable<string>;
  /** STEWARD-READY-LANES — green-triage lanes of the board items (lane a judge · lane b evidence). Absent = no lanes. */
  readonly lanes?: (version: string, items: readonly unknown[]) => CellLanes;
  /** WORK-PULL-REACHES-ROSTER — the shared pull policy ⊕ OP's roster rank for the board version. Absent = pre-policy steward. */
  readonly pull?: (version: string) => { policy: PullPolicy; rosterRank?: RosterRankLike };
  /** SEAT-AREA-GUARD — graphs/policies/seat-roles.yaml (kit/seat-area). Absent/throws = no area rule (named in sourceErrors). */
  readonly seatRoles?: () => SeatRolesPolicy;
}

/**
 * STEWARD-READY-LANES — the board's green-triage lanes, read the way `eln release checklist green-triage` reads them
 * (local `git log origin/main` squash subjects ⊕ the pregate GREEN lane dirs · no network). One reader for the space
 * steward snapshot, `eln work next` and hand-steward: lane a «merged ⊕ receipt» is JUD's (cell-wait 'awaiting-judge'),
 * lane b «merged, no receipt» is one hand's for the policy pack's stall_min (unreadable pack → the plain lease).
 */
export function liveCellLanes(version: string, items: readonly unknown[], opts: { receiptsDir?: string; triage?: GreenTriageSources } = {}): CellLanes {
  const receiptsDir = opts.receiptsDir ?? DEFAULT_RECEIPTS_DIR;
  const rows = items.flatMap((raw) => {
    const i = raw as Record<string, unknown>;
    return typeof i?.id === 'string' && typeof i.status === 'string'
      ? [{ id: i.id, title: String(i.title ?? ''), status: i.status, ...(typeof i.owner === 'string' ? { owner: i.owner } : {}), ...(typeof i.evidence === 'string' ? { evidence: i.evidence } : {}) }]
      : [];
  }) as unknown as Parameters<typeof triageGreen>[1];
  const sources = opts.triage ?? readGreenTriageSources({ greenLanes: () => (existsSync(receiptsDir) ? readdirSync(receiptsDir) : []) });
  let holdMin: number | undefined;
  try { holdMin = loadHqPolicy().stallMin; } catch { holdMin = undefined; }
  return lanesOfTriage(triageGreen(version, rows, sources).rows, holdMin);
}

/** The judge-butler's tick report (src/judge-butler/butler-cli.ts writes `<stateRoot>/loop-agents/judge-butler/last-tick.json`). */
export const butlerLastTickPath = (stateRoot: string): string => join(stateRoot, 'loop-agents', 'judge-butler', 'last-tick.json');

/** Cells the butler will not sign and says a judge must (notSignedWhy in src/judge-butler/body.ts: «security-4 → JUD/Terra — …»
 *  · «veto stands (…) — …»). Every other refusal (missing receipt · E4 run · HOLD) is not judge work. A tick older than
 *  `judgeCellsMaxAgeMinutes` (or unparsable) throws — named in sourceErrors, R3 keeps judging open PRs. */
export function parseButlerJudgeCells(body: unknown, nowMs: number, maxAgeMinutes: number = STEWARD_SPACE_DEFAULTS.judgeCellsMaxAgeMinutes): JudgeCellView[] {
  const tick = (body && typeof body === 'object' ? body : {}) as { at?: unknown; notSigned?: unknown };
  const at = typeof tick.at === 'string' ? Date.parse(tick.at) : NaN;
  if (!Number.isFinite(at)) throw new Error('butler last tick: no «at»');
  if (nowMs - at > maxAgeMinutes * 60_000) throw new Error(`butler last tick ${Math.floor((nowMs - at) / 60_000)}m old`);
  if (!Array.isArray(tick.notSigned)) throw new Error('butler last tick: no «notSigned»');
  const out: JudgeCellView[] = [];
  for (const raw of tick.notSigned) {
    const { cell, why } = (raw ?? {}) as { cell?: unknown; why?: unknown };
    if (typeof cell !== 'string' || !cell.trim() || typeof why !== 'string') continue;
    const kind = why.startsWith('security-4 → JUD') ? 'security-4' : why.startsWith('veto stands') ? 'veto' : null;
    if (!kind) continue;
    const prs = [...new Set([...why.matchAll(/#(\d{3,7})\b/gu)].map((m) => Number(m[1])))];
    out.push({ cell: cell.trim(), kind, why: why.slice(0, 240), prs });
  }
  return out;
}

/**
 * STEWARD-HQ 11-28 (CEO «왜 낮은가»): the board read had no `--version`, so the child `eln` stripped ITS package version —
 * the installed 0.3.38 — while `release.graph.version` said 0.3.39. 22:10Z: 262 cells of the published 0.3.38 board
 * (yellow 4, all P2) → backlog 0 → «idle 6 · no backlog 6» and steward-live 0, next to 73 yellow P0/P1 on 0.3.39.
 * One board version for every «current» reader (`eln work next` · hand pool · hand-steward): {@link activeBoardVersion}.
 */
export function checklistStatusArgs(version: string): string[] {
  return ['release', 'checklist', 'status', '--version', version, '--json'];
}

/** `childTimeoutMs` — per-child deadline for the `eln side ls` / `gh` reads (absent = {@link CHILD} timeout, the steward tick's). */
export function liveSources(config: StewardSpaceConfig | undefined, nowMs: number, opts: { childTimeoutMs?: number } = {}): SnapshotSources {
  let target: GhTarget | null = null;
  const childTimeoutMs = opts.childTimeoutMs ?? CHILD.timeout;
  const gh = (args: readonly string[]): unknown => ghJson(args, target ??= resolveGhTarget(config?.repo, liveGhTargetDeps()), childTimeoutMs);
  return {
    panes: () => cliJson(['side', 'ls', '--json'], childTimeoutMs),
    checklist: () => cliJson(checklistStatusArgs(activeBoardVersion())),
    prs: () => readAllOpenPrs(target ??= resolveGhTarget(config?.repo, liveGhTargetDeps()), childTimeoutMs),
    merged: () => gh(['pr', 'list', '--state', 'merged', '--limit', '60', '--json', 'number,headRefName,mergedAt']),
    receipts: () => readReceipts(config?.receiptsDir ?? DEFAULT_RECEIPTS_DIR, nowMs),
    verdicts: () => readVerdicts(config?.reviewResultsDir ?? defaultReviewResultsDir(), nowMs),
    util: () => (existsSync(config?.utilDir ?? DEFAULT_UTIL_DIR) ? readUtil(config?.utilDir ?? DEFAULT_UTIL_DIR, nowMs) : { hosts: [], ageMs: null }),
    ladder: () => loadFederationLadder(),
    sessionActivity: (sessionId) => sessionModelActivityMs(seatSessionsDir(), sessionId),
    pulls: () => readPulls(effectiveInstanceRoot(), nowMs),
    wakes: () => recentSeatWakes(defaultWakeLedgerPath(), nowMs),
    roles: () => loadDeclaredSeatRoles(),
    judgeCells: () => JSON.parse(readFileSync(butlerLastTickPath(effectiveInstanceRoot()), 'utf8')),
    lanes: (version, items) => liveCellLanes(version, items, { receiptsDir: config?.receiptsDir ?? DEFAULT_RECEIPTS_DIR }),
    // Unreadable policy file → throw: the snapshot has no `pull` (the pre-policy steward) and sourceErrors names it.
    pull: (version) => {
      const live = livePullPolicy();
      if (live.error) throw new Error(live.error);
      const rank = rosterRank(readRoster(effectiveInstanceRoot()), version);
      // A plain record, not the Map: the snapshot is persisted as JSON between graph nodes (a Map would arrive as `{}`).
      return { policy: live.policy, ...(rank ? { rosterRank: rosterRankRecord(rank) } : {}) };
    },
    // Unreadable seat-roles file → throw: the snapshot has no `seatRoles` (pre-policy) and sourceErrors names it.
    seatRoles: () => {
      const live = liveSeatRoles();
      if (live.error) throw new Error(live.error);
      return live.policy;
    },
    declaredSeats: () => {
      const { declaredFederationSeats } = require('../../msg/seat-mail-trust.js') as typeof import('../../msg/seat-mail-trust.js');
      const { resolveSeatStateRoot } = require('../../loops/msg-wake.js') as typeof import('../../loops/msg-wake.js');
      return declaredFederationSeats({ stateRoot: resolveSeatStateRoot() });
    },
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
  const seats = [...attempt('panes', () => parsePanes(sources.panes(), nowMs, sources.sessionActivity), [] as SeatView[])];
  let board: unknown;
  const list = attempt('checklist', () => parseChecklist(board = sources.checklist()), { version: '', cells: [] as CellView[] });
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
  // STEWARD-HQ-LIVE-ALIGN ② — a declared hand with no pane (HAND-ELN-TA · HAND-VM-GOLDEN 11-28: OP's tab assigned them,
  // `eln side ls` never showed them) is in the snapshot as `no-pane`: visible, never idle, never paired.
  const declared = sources.declaredSeats ? attempt('declaredSeats', () => [...sources.declaredSeats!()], [] as string[]) : [];
  const inPanes = new Set(seats.map((s) => s.seat));
  for (const raw of declared) {
    const seat = raw.trim().toUpperCase();
    if (!seat || seat === hq || inPanes.has(seat) || coordinators.has(seat) || ladder.depthOf(seat) <= 2) continue;
    seats.push({ seat, activity: 'no-pane', idleForMs: null });
    inPanes.add(seat);
    parent[seat] ??= ladder.parentOf(seat).toUpperCase();
  }
  const hands = attempt('hands', () => sources.openHands(ladder), [] as OpenHandView[]);
  const pulls = sources.pulls ? attempt('pulls', () => sources.pulls!(), {} as Record<string, number>) : {};
  const wakes = sources.wakes ? attempt('wakes', () => sources.wakes!(), {} as Record<string, { by: string; atMs: number }>) : {};
  const roles = sources.roles ? attempt('roles', () => sources.roles!(), {} as Record<string, string>) : {};
  const judgeCells = sources.judgeCells ? attempt('judgeCells', () => parseButlerJudgeCells(sources.judgeCells!(), nowMs), [] as JudgeCellView[]) : [];
  // Unreadable lanes (no full-history checkout · receipts dir) = no lane rule — the pre-lane board, named in sourceErrors.
  const items = (board as { items?: unknown } | undefined)?.items;
  const lanes = sources.lanes && list.version && Array.isArray(items) ? attempt('lanes', () => sources.lanes!(list.version, items), { cells: {} } as CellLanes) : undefined;
  const pull = sources.pull && list.version ? attempt('pull', () => sources.pull!(list.version), undefined) : undefined;
  const seatRoles = sources.seatRoles ? attempt('seatRoles', () => sources.seatRoles!(), undefined) : undefined;
  return { nowMs, hq, coordinators: [...coordinators].sort(), parent, seats, version: list.version, cells: list.cells, prs, merged,
    receipts, verdicts, hosts: util.hosts, utilAgeMs: util.ageMs, openHands: hands, pulls, wakes, roles, judgeCells, ...(lanes ? { lanes } : {}), ...(pull ? { pull } : {}), ...(seatRoles ? { seatRoles } : {}), sourceErrors: errors };
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
