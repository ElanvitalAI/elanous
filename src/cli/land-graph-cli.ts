/**
 * `eln land …` — operator surface of the land graph (src/land-graph/land-graph.ts).
 *
 *   land graph status            mode · slots · holds · latest decision per PR · lands today
 *   land graph plan              decide every open PR now (no ledger, no cards, no merge)
 *   land graph tick              one pass (the trigger-registry graph graphs/triggers/land-graph.yaml calls this)
 *   land graph replay [--date]   graph decision vs the coach landings of that day (COACH-ACTIONS + coach-land-*.out/.log)
 *   land graph synth --seat X    shadow-only synthetic PR records (tagged synthetic) · cards go to seat X
 *   land hold <PR> --reason R    JUD/OP hold (re-checked right before the merge) · land unhold <PR>
 *
 * Mode is never a flag: live only when config `land.graph.mode` = live; otherwise shadow.
 */
import type { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { readRemoteUrl } from '../git-fs/origin-url.js';
import { getElanousConfigDir, getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { userConfigPath } from '../user-config.js';
import { landingOwner, mayRunLandOps } from '../org/land-authority.js';
import { defaultRetryHosts, nextHost, tscHostsFor } from '../land-graph/red-receipt.js';
import { filterRoutable, hostsFor } from '../kit/resource-facts/index.js';
import type { RefreshResult } from '../land-graph/finisher.js';
import { gitAt } from '../git-fs/smart-run.js';
import { carriesOwnDiff, prDelta } from '../git-smart/delta.js';
import { mergeTree } from '../git-smart/merge-tree.js';
import { discoverParents, smartRefresh, smartRefreshSync, type SmartRefreshResult } from '../git-smart/smart-refresh.js';
import { autofixPr, redRaw } from '../land-graph/autofix.js';
import { runGhCliWithResult } from '../git-fs/gh-cli.js';
import { GhGovernorRefusal, liveGhGovernorPolicy } from '../kit/gh-governor/index.js';
import { headCommitTimes, livePrAgingPolicy } from '../kit/pr-aging/index.js';
import { invalidateOpenPrSnapshot, readOpenPrSnapshot, sleepSync, type OpenPrRecord } from '../kit/gh-governor/open-pr-snapshot.js';
import {
  clearHold, focusedCounts, isDocOnly, readHolds, readLedger, replayAttempt, SECURITY4, setHold, tickLand,
  type BaselineDiff, type Focused, type LandDeps, type Mode, type PrInfo, type Receipt, type ReplayRow, type TerraReview,
} from '../land-graph/land-graph.js';

interface LandConfig { orgPath?: unknown; repo?: unknown; mode?: unknown; slots?: unknown; cardSeat?: unknown; landCmd?: unknown; authors?: unknown; retryHosts?: unknown }
/** `land.graph.retryHosts` (tsc-timeout re-runs) · default = the registry's retry hosts (resource facts) · a configured host the
 *  registry rules out for tsc (unhealthy · reserved · off · HQ) is dropped · `first` moves to the front. */
export function retryHosts(cfg: { retryHosts?: unknown }, first?: string): string[] {
  const configured = Array.isArray(cfg.retryHosts) && cfg.retryHosts.every(h => typeof h === 'string' && /^[\w.-]+$/.test(h)) && cfg.retryHosts.length ? filterRoutable(cfg.retryHosts as string[], 'tsc') : [];
  const list = configured.length ? configured : defaultRetryHosts();
  return first ? [first, ...list.filter(h => h !== first)] : [...list];
}

function readConfig(): LandConfig {
  const path = getElanousConfigDirOverride() ? join(effectiveInstanceRoot(), 'config.json') : userConfigPath();
  try { return ((JSON.parse(readFileSync(path, 'utf8')) as { land?: { graph?: LandConfig } }).land?.graph) ?? {}; } catch { return {}; }
}
const seatState = () => process.env.ELANOUS_SEAT_STATE ?? join(homedir(), 'elanous-hq', 'seat-state');
const gh = () => process.env.LAND_GRAPH_GH ?? 'gh';
const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/** owner/name from an origin URL (https or scp form) — same pattern as hq/repo-maintenance originRepoSlug. */
export function repoSlugFromUrl(url: string): string | null {
  const m = /(?:github\.com[:/])([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m?.[1] ?? null;
}

export interface LandRepo { root: string | null; slug: string | null }
/** Where the land graph's gh/git calls point — never the process cwd (the trigger runs from the installed package dir, not a git repo).
 *  root = config land.graph.repo, else the HQ repo clone when present. slug = GH_REPO, else root's origin URL. */
export function resolveLandRepo(o: { env?: NodeJS.ProcessEnv; cfgRepo?: unknown; defaultRoot?: string } = {}): LandRepo {
  const env = o.env ?? process.env;
  const cands = [typeof o.cfgRepo === 'string' ? o.cfgRepo : null, o.defaultRoot ?? null].filter((x): x is string => !!x);
  const root = cands.find(c => existsSync(c)) ?? null;
  const fromEnv = (env.GH_REPO ?? '').trim();
  if (fromEnv) return { root, slug: fromEnv };
  if (!root) return { root, slug: null };
  const url = readRemoteUrl(root); // GH-MIRROR-ORIGIN-URL-SAFE: raw configured URL, never the insteadOf mirror path
  return { root, slug: url ? repoSlugFromUrl(url) : null };
}

/** gh argv + spawn cwd for one call: `--repo <slug>` when known, and cwd = repo root, so gh never depends on the caller's cwd. */
export function ghInvocation(args: string[], repo: LandRepo): { args: string[]; cwd?: string } {
  return { args: repo.slug ? [...args, '--repo', repo.slug] : args, ...(repo.root ? { cwd: repo.root } : {}) };
}

const hqRepo = () => join(homedir(), 'elanous-hq', 'repo.git');
const landTarget = (cfg: LandConfig = readConfig()) => resolveLandRepo({ cfgRepo: cfg.repo, defaultRoot: hqRepo() });

const noRepo = (repo: LandRepo) => { if (!repo.slug && !repo.root) throw new Error('no repo: set GH_REPO or config land.graph.repo (gh would read the cwd, which is the installed package)'); };
/** One gh call through the governed door (src/git-fs/gh-cli.ts · kit/gh-governor): cooldown / budget refusals throw GhGovernorRefusal. */
function ghRun(args: string[], repo: LandRepo) {
  noRepo(repo);
  const inv = ghInvocation(args, repo);
  return runGhCliWithResult(inv.args, { bin: gh(), timeoutMs: 60_000, ...(inv.cwd ? { cwd: inv.cwd } : {}) }); // Source: one gh call per PR re-read / write.
}
function ghJson(args: string[], repo: LandRepo): unknown {
  const out = ghRun(args, repo);
  if (out.refused) throw new GhGovernorRefusal(out.refused, out.stderr.toString('utf8').trim().split('\n')[0] ?? 'gh refused');
  if (!out.ok) throw new Error(`gh ${args[0]} ${args[1]} exit ${out.exitCode}: ${out.stderr.toString('utf8').trim().slice(0, 160)}`);
  return JSON.parse(out.stdout.toString('utf8'));
}
/** GH-BUDGET-GOVERNOR: the open PRs from the shared snapshot (one refresher for every seat · TTL in graphs/policies/gh-governor.yaml). */
export function openPrsFromSnapshot(repo: LandRepo, stateRoot: string): OpenPrRecord[] {
  noRepo(repo);
  const policy = liveGhGovernorPolicy();
  if (!policy) throw new Error('gh-governor policy unreadable (graphs/policies/gh-governor.yaml)');
  return readOpenPrSnapshot({ slug: repo.slug, ...(repo.root ? { cwd: repo.root } : {}) }, {
    stateRoot, now: Date.now, policy, sleep: sleepSync, timeoutMs: 60_000,
    run: (args, opts) => runGhCliWithResult(args, { ...opts, bin: gh() }),
  }).prs;
}

interface GhPr { number: number; headRefOid: string; baseRefName: string; isDraft: boolean; state: string; title: string; author?: { login?: string }; files?: Array<{ path: string }>;
  headRefName?: string; isCrossRepository?: boolean; createdAt?: string; updatedAt?: string; body?: string; labels?: Array<{ name: string }> }
const FIELDS = 'number,headRefOid,baseRefName,isDraft,state,title,author,files,headRefName,isCrossRepository,createdAt,body,labels';

function toPr(p: GhPr, authors: Record<string, string>): PrInfo {
  const login = p.author?.login ?? '';
  return { number: p.number, head: p.headRefOid, base: p.baseRefName, draft: p.isDraft, state: p.state as PrInfo['state'], title: p.title,
    author: authors[login] ?? 'OP', files: (p.files ?? []).map(f => f.path),
    ...(p.headRefName ? { headRef: p.headRefName } : {}), ...(p.isCrossRepository ? { crossRepo: true } : {}), ...(p.createdAt ? { createdAt: p.createdAt } : {}),
    ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
    ...(typeof p.body === 'string' ? { body: p.body } : {}), labels: (p.labels ?? []).map(l => l.name) };
}

function receiptDirs(pr: number, kind: 'PREGATE-GREEN' | 'PREGATE-RED' = 'PREGATE-GREEN'): string[] {
  const root = join(seatState(), 'RES', 'evidence', kind);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(n => n.startsWith(`${pr}-`)).map(n => join(root, n));
}
/** LAND-STEWARD RED-RECEIPT: same-head PREGATE-RED receipts, newest first (read as `red` receipts; decide() keeps only focused/tsc-timeout reds). */
export function redReceipts(dirs: string[], head: string, pr?: number): Receipt[] {
  return dirs.filter(d => d.split('/').pop()!.includes(`-${head.slice(0, 12)}-`) && existsSync(join(d, 'receipt.json')))
    .map(d => { try { return { d, m: statSync(join(d, 'receipt.json')).mtimeMs }; } catch { return { d, m: 0 }; } })
    .sort((a, b) => b.m - a.m).map(x => readReceipt(x.d, { red: true, expectedPr: pr })).filter((r): r is Receipt => !!r && r.head === head);
}
interface RawReceipt { pr?: unknown; head?: unknown; host?: unknown; focused?: unknown; rawDir?: unknown; steps?: unknown; rawSha256?: unknown; grade?: unknown; focusedBaseline?: unknown; failure?: unknown; patchId?: unknown }
/** Receipt layout written by RES pregate.py (light and full): receipt.json with steps[] {name, exit} and rawSha256 {<stage>.raw: sha}. */
export function readReceipt(dir: string, o: { red?: boolean; expectedPr?: number } = {}): Receipt | null {
  try {
    const r = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')) as RawReceipt;
    if (typeof r.head !== 'string' || (o.expectedPr !== undefined && r.pr !== o.expectedPr)) return null;
    const steps = Array.isArray(r.steps) ? r.steps as Array<{ name?: unknown; exit?: unknown }> : [];
    const step = steps.find(x => x && x.name === 'focused');
    const sha = r.rawSha256 && typeof r.rawSha256 === 'object' ? (r.rawSha256 as Record<string, unknown>)['focused.raw'] : undefined;
    return {
      dir, head: r.head,
      // `host` is the ssh alias (minim5 · node-b · gcp1); `actualHost` is the machine hostname and does not resolve over ssh.
      host: typeof r.host === 'string' && r.host ? r.host : 'minim5',
      focused: Array.isArray(r.focused) ? r.focused.filter((x): x is string => typeof x === 'string') : [],
      rawDir: typeof r.rawDir === 'string' ? r.rawDir : '',
      focusedExit: step && typeof step.exit === 'number' ? step.exit : null,
      ...(typeof sha === 'string' ? { focusedSha: sha } : {}),
      ...(typeof r.grade === 'string' ? { grade: r.grade } : {}),
      ...(focusedBaselineOf(r.focusedBaseline)),
      ...(typeof r.patchId === 'string' && /^[0-9a-f]{40}$/.test(r.patchId) ? { patchId: r.patchId } : {}),
      ...(o.red ? { red: { failed: steps.filter(x => x && typeof x.name === 'string' && typeof x.exit === 'number' && x.exit !== 0).map(x => ({ name: x.name as string, exit: x.exit as number })),
        ...(typeof r.failure === 'string' ? { failure: r.failure } : {}) } } : {}),
    };
  } catch { return null; }
}

/** pregate A244 ③ `focusedBaseline` {mine, onMain, newFailures[]} — only a well-formed record counts. */
function focusedBaselineOf(v: unknown): { focusedBaseline?: NonNullable<Receipt['focusedBaseline']> } {
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  if (typeof o.mine !== 'number' || typeof o.onMain !== 'number' || !Array.isArray(o.newFailures)) return {};
  return { focusedBaseline: { mine: o.mine, onMain: o.onMain, newFailures: o.newFailures.map(String) } };
}

/** Local copies of focused.raw a receipt dir may carry (seat mirrors: <dir>/focused.raw · raws/ · raw/), then the host temp rawDir. */
export function localFocusedRaw(r: Receipt): string | null {
  const cands = [join(r.dir, 'focused.raw'), join(r.dir, 'raws', 'focused.raw'), join(r.dir, 'raw', 'focused.raw'), ...(r.rawDir ? [join(r.rawDir, 'focused.raw')] : [])];
  for (const p of cands) {
    try {
      if (!statSync(p).isFile()) continue;
      const buf = readFileSync(p);
      if (r.focusedSha && createHash('sha256').update(buf).digest('hex') !== r.focusedSha) continue; // a copy from another run is not this receipt's raw
      return buf.toString('utf8');
    } catch { /* missing → next */ }
  }
  return null;
}

/** Remote raw read: same command and 30 s bound as coach-land.sh. Returns stdout, or null when ssh/grep failed (raw gone, host down). */
export type RemoteGrep = (host: string, rawDir: string) => { ok: boolean; stdout: string; missing: boolean };
const sshGrep: RemoteGrep = (host, rawDir) => {
  const out = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host,
    `f='${rawDir}/focused.raw'; [ -f "$f" ] || { echo RAW-MISSING; exit 3; }; grep -hE '^ ?[0-9]+ (pass|fail)' "$f"`],
  { encoding: 'utf8', timeout: 30_000 }); // Source: coach-land.sh reads the raw the same way (30 s bound).
  return { ok: out.status === 0, stdout: out.stdout ?? '', missing: out.status === 3 && /RAW-MISSING/.test(out.stdout ?? '') };
};

/**
 * Focused pass/fail of a receipt: local raw (SHA-checked) → ssh to the receipt host → the receipt's own focused step exit.
 * pregate.py keeps raws only in a host temp dir (mkdtemp res-a161-*) that the host sweeps within hours; the GREEN lane
 * mirrors receipt.json + SUMMARY.json only. When the raw is gone the step exit is all that is left (`swept`).
 */
export function readFocused(r: Receipt, remote: RemoteGrep = sshGrep): Focused {
  const local = localFocusedRaw(r);
  if (local !== null) return parseFocused(local);
  if (r.rawDir) {
    const out = remote(r.host, r.rawDir);
    if (out.ok) return parseFocused(out.stdout);
    if (!out.missing) return 'unreadable'; // host unreachable: the raw may still be there
  }
  return typeof r.focusedExit === 'number' ? { swept: true, exit: r.focusedExit } : 'unreadable';
}

export function parseFocused(text: string): Focused {
  // bun summary lines: « 26 pass» / « 0 fail» (one leading space). Last match wins — a raw may hold a baseline run first.
  const last = (re: RegExp) => { let m: RegExpExecArray | null = null; for (const x of text.matchAll(re)) m = x; return m; };
  const pass = last(/^\s*(\d+) pass\s*$/gm); const fail = last(/^\s*(\d+) fail\s*$/gm);
  return pass ? { pass: Number(pass[1]), fail: fail ? Number(fail[1]) : 0 } : 'unreadable';
}

const readJsonFile = (p: string): Record<string, unknown> | null => {
  try { const v = JSON.parse(readFileSync(p, 'utf8')) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
};

/** The review of this exact head: review-results/pr-<PR>-<head12>.json written by `elanous self review` on a policy route (Terra · Claude ACP · grok fallback).
 *  Security findings = structured securityFindings · a securityClass · legacy findings[] in a security-4 category without a disposition. */
export function readTerraReview(dir: string, pr: number, head: string): TerraReview | null {
  const j = readJsonFile(join(dir, `pr-${pr}-${head.slice(0, 12)}.json`));
  if (!j || typeof j.verdict !== 'string' || j.reviewed !== true || j.invalid === true) return null; // a completed review only
  // The model that actually answered must satisfy the review routing policy (LLM-ROUTE-BY-GUARDIAN: Terra · Claude ACP ·
  // grok fallback — never GLM), not one hardcoded engine: an 11-11 grok-fallback review is a review.
  const model = String(j.respondedModel ?? j.model ?? '');
  const { acceptReviewModel } = require('../kit/resource-facts/index.js') as typeof import('../kit/resource-facts/index.js');
  if (!acceptReviewModel(model).ok) return null;
  if (j.headCommit !== head) return null;
  const sec: string[] = [];
  if (typeof j.securityClass === 'string' && j.securityClass) sec.push(`class:${j.securityClass}`);
  for (const x of Array.isArray(j.securityFindings) ? j.securityFindings : []) {
    const o = x && typeof x === 'object' ? x as Record<string, unknown> : {};
    sec.push(`${String(o.securityClass ?? o.kind ?? 'security')}:${String(o.text ?? x).slice(0, 60)}`);
  }
  for (const x of Array.isArray(j.findings) ? j.findings as Array<Record<string, unknown>> : []) {
    if (x && SECURITY4.includes(String(x.category ?? '').toLowerCase()) && !x.disposition) sec.push(`${String(x.category)}:${String(x.title ?? '').slice(0, 60)}`);
  }
  return { verdict: j.verdict, securityFindings: sec };
}

/** JUD veto verdicts on file for this head: review-results/{hold,jud,judb,jud3,judb-security}-<PR>-<head12>.json with verdict HOLD. */
export function readJudHold(dir: string, pr: number, head: string): { reason: string; by: string } | null {
  for (const pre of ['hold', 'jud', 'judb', 'jud3', 'judb-security']) {
    const j = readJsonFile(join(dir, `${pre}-${pr}-${head.slice(0, 12)}.json`));
    if (!j || String(j.verdict ?? '').toLowerCase() !== 'hold') continue;
    if (typeof j.headCommit === 'string' && j.headCommit !== head) continue;
    const reviewer = typeof j.reviewer === 'string' ? j.reviewer : '';
    if (reviewer && !/^JUD/i.test(reviewer)) continue; // only the judiciary's verdicts are vetoes
    const why = Array.isArray(j.mustFix) && j.mustFix.length ? String(j.mustFix[0]).slice(0, 100) : '';
    const kind = typeof j.securityClass === 'string' && j.securityClass ? `security ${j.securityClass}` : 'HOLD';
    return { reason: `${kind} verdict ${pre}-${pr}-${head.slice(0, 12)}${why ? ` · ${why}` : ''}`, by: 'JUD' };
  }
  return null;
}

/** Baseline failure-name diff receipt for this head (land-name-diff-check.py format · introducedFailureNames = []).
 *  Looked up in the receipt dir and the OP evidence nd<PR>/ dirs of the last 3 days. headPass is read from the head raw log. */
export function findBaselineDiff(dirs: string[], head: string): BaselineDiff | null {
  for (const d of dirs) {
    let names: string[] = [];
    try { names = readdirSync(d).filter(n => /^(namediff|receipt|nd)[\w.-]*\.json$/.test(n)); } catch { continue; }
    for (const n of names) {
      const j = readJsonFile(join(d, n));
      if (!j || j.head !== head || !Array.isArray(j.introducedFailureNames) || j.introducedFailureNames.length !== 0) continue;
      if (typeof j.command !== 'string' || !j.command || !Array.isArray(j.headFailureNames) || typeof j.headLog !== 'string') continue;
      let log = '';
      try { log = readFileSync(j.headLog, 'utf8'); } catch { continue; }
      const f = parseFocused(log);
      if (f === 'unreadable' || !('pass' in f) || f.pass === 0) continue;
      return { receipt: join(d, n), command: j.command, headPass: f.pass, headFail: j.headFailureNames.length };
    }
  }
  return null;
}

/** extra.json for op-direct-land-v2.sh. Numbers come only from a receipt (A138): L0 doc-only and a swept raw carry no
 *  headTestRun (op-waiver plain mode needs none) · a baseline-name-diff carries the diff's own head run. */
export function landExtra(pr: PrInfo, r: Receipt, why: string, focused: Focused, ctx: { lane?: string; baselineDiff?: BaselineDiff | null } = {}): Record<string, unknown> {
  const receipt = join(r.dir, 'receipt.json');
  const base = { receipt, note: `land-graph (JUD-RELAX · veto only) · ${why}` };
  if (ctx.lane === 'L0-doc-only') return base;
  const nd = ctx.baselineDiff;
  const counts = focusedCounts(focused);
  if (counts && counts.fail === 0 && counts.pass > 0) return { ...base, headTestRun: { sha: pr.head, command: `bun test ${r.focused.join(' ')}`, pass: counts.pass, fail: 0, exit: 0, receipt } };
  if (nd) return { ...base, baselineNameDiff: { receipt: nd.receipt }, headTestRun: { sha: pr.head, command: nd.command, pass: nd.headPass, fail: nd.headFail, exit: 1, receipt } };
  return base; // swept raw with focused step exit 0: the receipt is the evidence, no hand-written counts
}

/**
 * PATH for the golden-path land command. The trigger runs under launchd, whose PATH resolves `python3` to the macOS
 * system Python 3.9 — and land-name-diff-check.py (PEP 604 `str | None` annotations) dies there with a TypeError, so
 * v2 printed «STOP baseline failure-name diff» for every live land on 11-26 (0 landed). Package-manager bin dirs that
 * exist go first, so `python3` is the same interpreter the seats use by hand.
 */
export function landToolPath(path: string | undefined, exists: (dir: string) => boolean = existsSync): string {
  const front = ['/opt/homebrew/bin', '/usr/local/bin'].filter(d => exists(d));
  if (path === undefined) return front.join(':');
  // Keep every original segment (an empty one means the cwd) in order; only the moved dirs leave their old place.
  const rest = path.split(':').filter(d => !front.includes(d));
  return front.length ? [...front, ...rest].join(':') : path;
}

export function defaultLandDeps(over: Partial<LandDeps> = {}): LandDeps {
  const cfg = readConfig();
  const authors = (cfg.authors && typeof cfg.authors === 'object' ? cfg.authors : {}) as Record<string, string>;
  const mode: Mode = cfg.mode === 'live' ? 'live' : 'shadow';
  const slots = typeof cfg.slots === 'number' && cfg.slots > 0 ? cfg.slots : 1; // single-flight by default: one merge at a time
  const target = landTarget(cfg);
  const repoCwd = target.root ?? process.cwd();
  // 착지 집사 policy pack (graphs/loop-agents/land-steward/policies.yaml · decision 11-27): only explicit lane pins reorder a
  // land run; no pins (or no pack) → no `order` → tickLand's own landOrder, exactly as before. The pack's `mode` is the
  // steward's live order (stewardDeps), never applied here.
  const policy = (require('../land-graph/lane-order.js') as typeof import('../land-graph/lane-order.js'));
  const pinned = policy.pinOrder((require('../kit/lane-pins/index.js') as typeof import('../kit/lane-pins/index.js')).loadLivePolicy(effectiveInstanceRoot())); // ⊕ the train manager's runtime pins (TTL)
  return {
    now: () => new Date(),
    stateRoot: effectiveInstanceRoot(),
    mode, slots,
    ...(typeof cfg.orgPath === 'string' ? { org: { path: cfg.orgPath } } : {}),
    ...(typeof cfg.cardSeat === 'string' ? { cardSeat: cfg.cardSeat } : {}),
    async listPrs() {
      // GH-BUDGET-GOVERNOR ①: the shared snapshot (every page · files from the per-head cache), not a fresh 100-PR read per tick.
      return (openPrsFromSnapshot(target, this.stateRoot) as unknown as GhPr[]).map(p => toPr(p, authors));
    },
    async prNow(n) { return toPr(ghJson(['pr', 'view', String(n), '--json', FIELDS], target) as GhPr, authors); },
    receipt(pr, head) {
      // Several hosts may hold a same-head receipt (…-minim5 · …-node-b): prefer one whose focused raw is still readable locally.
      const all = receiptDirs(pr).map(d => readReceipt(d, { expectedPr: pr })).filter((r): r is Receipt => !!r);
      const rs = all.filter(r => r.head === head && r.dir.split('/').pop()!.startsWith(`${pr}-${head.slice(0, 12)}-`));
      // GREEN same head → GREEN reused by patch-id → RED same head (RED-RECEIPT · decide() keeps only focused / tsc-timeout reds).
      return rs.find(r => localFocusedRaw(r) !== null) ?? rs[0] ?? reuseByPatchId(all, head, p => patchIdOf(repoCwd, p, pr), old => carriesOwnDiff(repoCwd, old, head))
        ?? redReceipts(receiptDirs(pr, 'PREGATE-RED'), head, pr)[0] ?? null;
    },
    olderReceiptHead(pr, head) {
      const rs = receiptDirs(pr).map(d => readReceipt(d, { expectedPr: pr })).filter((r): r is Receipt => !!r && r.head !== head);
      return rs.length ? rs[rs.length - 1]!.head : null;
    },
    focused: r => readFocused(r),
    security(pr, head) {
      const f = join(getElanousConfigDir(), 'review-results', `pr-${pr}-${head.slice(0, 12)}.json`);
      try {
        const j = JSON.parse(readFileSync(f, 'utf8')) as { findings?: Array<{ category?: string; disposition?: string; title?: string }> };
        return (j.findings ?? []).filter(x => SECURITY4.includes(String(x.category ?? '').toLowerCase()) && !x.disposition).map(x => `${x.category}:${x.title ?? ''}`.slice(0, 80));
      } catch { return []; }
    },
    terra: (pr, head) => readTerraReview(join(getElanousConfigDir(), 'review-results'), pr, head),
    judHold: (pr, head) => readJudHold(join(getElanousConfigDir(), 'review-results'), pr, head),
    baselineDiff(pr, head) {
      const days = [0, 1, 2].map(k => join(seatState(), 'OP', 'evidence', ymd(new Date(Date.now() - k * 86_400_000)), `nd${pr}`));
      const own = [...receiptDirs(pr), ...receiptDirs(pr, 'PREGATE-RED')].filter(d => d.split('/').pop()!.startsWith(`${pr}-${head.slice(0, 12)}-`));
      return findBaselineDiff([...own, ...days], head);
    },
    async land(pr, r, why, ctx) {
      const e = join(seatState(), 'OP', 'evidence', ymd(new Date())); mkdirSync(e, { recursive: true });
      const extra = join(e, `land-graph-extra-${pr.number}.json`);
      const focused: Focused = ctx?.lane === 'L0-doc-only' ? 'unreadable' : this.focused(r);
      writeFileSync(extra, JSON.stringify(landExtra(pr, r, why, focused, ctx ?? {})));
      const cmd = typeof cfg.landCmd === 'string' ? cfg.landCmd : join(seatState(), 'OP', 'tools', 'op-direct-land-v2.sh');
      const out = spawnSync('zsh', [cmd, String(pr.number), pr.head, `land-graph 착지 · ${why}`, extra],
        { encoding: 'utf8', cwd: repoCwd, env: { ...process.env, PATH: landToolPath(process.env.PATH), ...(target.slug ? { GH_REPO: target.slug } : {}), LAND_RATCHET_HOST: 'minim5',
          // TSC-TIMEOUT: an unmeasured land-time tsc retries on the next host of the rotation (minim5 first, as before).
          LAND_TSC_HOSTS: tscHostsFor(ctx?.tscAttempt ?? 0, retryHosts(cfg, hostsFor('tsc')[0])) }, timeout: 40 * 60_000 }); // Source: v2 preflight ≤ ~30 min on the first registry tsc host.
      const text = `${out.stdout ?? ''}\n${out.stderr ?? ''}`;
      appendFileSync(join(e, `land-graph-${pr.number}.log`), text);
      if (out.status === 0) invalidateOpenPrSnapshot(this.stateRoot, { slug: target.slug }); // the open set changed
      return { rc: out.status ?? 99, text };
    },
    staleRevert(pr) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { detectStaleBaseRevert, parseDeclaredRemovals } = require('../land-guard/stale-base-revert.js') as typeof import('../land-guard/stale-base-revert.js');
      const cwd = repoCwd;
      const g = (args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 120_000 }); // Source: one fetch of main + the PR head.
      const f = g(['fetch', '-q', 'origin']);
      if (f.status !== 0) return { ok: false, why: `fetch failed: ${(f.stderr ?? '').trim().slice(0, 120)}` };
      if (g(['cat-file', '-e', `${pr.head}^{commit}`]).status !== 0) g(['fetch', '-q', 'origin', `pull/${pr.number}/head`]);
      // REVERT-GUARD-DECLARED-SUPERSEDE: the PR body's «의도된 삭제: <path|#PR> (<reason>)» lines are honored.
      const r = detectStaleBaseRevert(cwd, 'origin/main', pr.head, { declared: parseDeclaredRemovals(pr.body) });
      if (r.ok) return { ok: true };
      // SMART-MERGE ①: say whether each wiped file is in the PR's own change (merge-base..head) — «not own» = a stale copy.
      const own = prDelta(gitAt(cwd), pr.head);
      const ownFiles = new Set('error' in own ? [] : own.files);
      return { ok: false, why: r.hits.map(h => `${h.file}←${h.commit.slice(0, 10)}${'error' in own ? '' : ownFiles.has(h.file) ? ' (own)' : ' (not own)'}`).join(', ').slice(0, 240) };
    },
    post(to, body) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { openMsgStore } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
      const store = openMsgStore();
      try { store.post({ from: 'land-graph', to, kind: 'info', body } as Parameters<typeof store.post>[0]); } finally { store.close(); }
    },
    record(line) {
      appendFileSync(join(seatState(), 'OP', `COACH-ACTIONS-${ymd(new Date())}.md`), `- ${line}\n`);
    },
    finisher: finisherDeps(target, repoCwd, retryHosts(cfg)),
    smartMerge: smartMergeDeps(target),
    baseMerged(pr) {
      // The base branch's own PR merged → the stack's lower layer is in main.
      const v = ghJson(['pr', 'list', '--head', pr.base, '--state', 'merged', '--json', 'number', '--limit', '1'], target) as unknown[];
      return Array.isArray(v) && v.length > 0;
    },
    retargetToMain(pr) {
      const out = ghRun(['pr', 'edit', String(pr.number), '--base', 'main'], target);
      if (out.ok) invalidateOpenPrSnapshot(this.stateRoot, { slug: target.slug });
      return out.ok ? { ok: true } : { ok: false, why: out.stderr.toString('utf8').trim().slice(0, 160) };
    },
    superseded: pr => supersededInMain(repoCwd, pr),
    ...cellLinkDeps(),
    closePr(pr, comment) {
      const out = ghRun(['pr', 'close', String(pr.number), '--comment', comment], target);
      if (out.ok) invalidateOpenPrSnapshot(this.stateRoot, { slug: target.slug });
      return out.ok ? { ok: true } : { ok: false, why: out.stderr.toString('utf8').trim().slice(0, 160) };
    },
    // PR-ZOMBIE-AGING (graphs/policies/pr-aging.yaml): head age from the local head commit (no fetch) · conflict from RED steps.
    prAging: livePrAgingPolicy(),
    headTimes: heads => headCommitTimes(repoCwd, heads),
    redSteps: (pr, head) => [...new Set(redReceipts(receiptDirs(pr, 'PREGATE-RED'), head, pr).flatMap(r => (r.red?.failed ?? []).map(f => f.name)))],
    toDraft(pr) {
      const out = ghRun(['pr', 'ready', String(pr.number), '--undo'], target);
      if (out.ok) invalidateOpenPrSnapshot(this.stateRoot, { slug: target.slug });
      return out.ok ? { ok: true } : { ok: false, why: out.stderr.toString('utf8').trim().slice(0, 160) };
    },
    ...(pinned ? { order: pinned } : {}),
    ...over,
  };
}

// ── PATCHID-1127 receipt reuse ─────────────────────────────────────────────────────────────────────────────────

const patchIds = new Map<string, string | null>();
/** patch-id of the PR-own change: git diff $(git merge-base origin/main <head>) <head> | git patch-id --stable · null when unreadable. */
export function patchIdOf(repo: string, head: string, pr?: number, mainRef = 'origin/main'): string | null {
  const key = `${repo}\0${mainRef}\0${head}`;
  if (patchIds.has(key)) return patchIds.get(key)!;
  // SMART-MERGE ①: the one PR-own delta definition (src/git-smart/delta.ts prDelta).
  const g = gitAt(repo, { timeoutMs: 60_000 });
  if (g(['cat-file', '-e', `${head}^{commit}`]).status !== 0 && pr) g(['fetch', '-q', 'origin', `pull/${pr}/head`]);
  const d = prDelta(g, head, mainRef);
  const id = 'error' in d ? null : d.patchId;
  patchIds.set(key, id);
  return id;
}

/** LAND10-FINISHER-WAIT: the memoized carry proof now lives with carryProof (src/git-smart/delta.ts · shared with the judge). */
export { carriesOwnDiff };

/** A GREEN receipt of an older head whose PR-own change is the same counts for `head`: same stable patch-id, or (`carry`) the
 *  own-diff proof — the receipt key is the PR's own change, the head is only recorded (대표 11-28 18:1x). */
export function reuseByPatchId(receipts: readonly Receipt[], head: string, pidOf: (sha: string) => string | null, carry?: (oldHead: string) => boolean): Receipt | null {
  const older = receipts.filter(r => r.head !== head);
  if (!older.length) return null;
  const cur = pidOf(head);
  const newest = [...older].reverse();
  if (cur) for (const r of newest) {
    const old = r.patchId ?? pidOf(r.head);
    if (old && old === cur) return { ...r, head, reusedFrom: r.head, reusedVia: 'patch-id' };
  }
  if (carry) for (const r of newest) if (carry(r.head)) return { ...r, head, reusedFrom: r.head, reusedVia: 'own-diff' };
  return null;
}

// ── LAND-CELL-LINK adapters ──────────────────────────────────────────────────────────────────────────────────

/** Cell of the release in play (`release.graph.version`) · attach = the `checklist evidence add` store call. Checklist read once per tick. */
export function cellLinkDeps(): Pick<LandDeps, 'cellLink' | 'attachCell'> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { readBoardPointer } = require('../ops-dashboard/current-version.js') as typeof import('../ops-dashboard/current-version.js');
  const { listChecklist } = require('../release-loop/checklist.js') as typeof import('../release-loop/checklist.js');
  const { matchCell } = require('../land-graph/cell-link.js') as typeof import('../land-graph/cell-link.js');
  /* eslint-enable @typescript-eslint/no-require-imports */
  let cache: { at: number; version: string; items: ReturnType<typeof listChecklist>['items'] } | null = null;
  const current = () => {
    const version = readBoardPointer();
    if (!version) return null;
    if (!cache || cache.version !== version || Date.now() - cache.at > 60_000) {
      try { cache = { at: Date.now(), version, items: listChecklist(version).items }; } catch { return null; }
    }
    return cache;
  };
  return {
    cellLink(pr) { const c = current(); return c && c.items.length ? matchCell(pr, c.items) : undefined; },
    attachCell(cell, pr) {
      const c = current(); if (!c) return { ok: false, why: 'no current board (release/current-board.json · release.graph.version)' };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const features = require('../release-loop/feature-store.js') as typeof import('../release-loop/feature-store.js');
      const snap = listChecklist(c.version);
      features.evidenceAdd(cell, c.version, `#${pr.number}`, 'land-graph', snap.released, snap.dev);
      cache = null;
      return { ok: true };
    },
  };
}

// ── Finisher adapters (LAND-OWNS-RECEIPT) ─────────────────────────────────────────────────────────────────────

const git = (cwd: string, args: string[], timeout = 120_000) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout }); // Source: fetch/merge/push of one PR branch.

/** true ⇔ merging the PR head into origin/main changes nothing (ancestor, or squash-landed content): the PR is superseded. */
export function supersededInMain(repo: string, pr: PrInfo): boolean {
  if (git(repo, ['fetch', '-q', 'origin', 'main']).status !== 0) return false;
  if (git(repo, ['cat-file', '-e', `${pr.head}^{commit}`]).status !== 0) git(repo, ['fetch', '-q', 'origin', `pull/${pr.number}/head`]);
  const mt = mergeTree(args => git(repo, args), 'origin/main', pr.head, [], []);
  if (mt.status !== 0) return false; // conflict or error: not provably contained
  const tree = (mt.stdout ?? '').split('\n')[0]?.trim();
  const mainTree = (git(repo, ['rev-parse', 'origin/main^{tree}']).stdout ?? '').trim();
  return !!tree && tree === mainTree;
}

/** SMART-MERGE lock dir (one smart-merge per PR across ticks and capsules). */
export const smartMergeLockDir = () => join(effectiveInstanceRoot(), 'land-graph', 'smart-merge-locks');

/**
 * Bring a same-repo PR branch onto fresh main (src/git-smart/smart-refresh.ts): rebuild after a squash-landed parent ·
 * else merge main · rerere + structural ladder · revert guard · plain push (never force). In-tick = no LLM.
 */
export function refreshBranch(repo: string, pr: PrInfo, ctx?: { parentHeads?: readonly string[] }): { result: RefreshResult; newHead?: string; why?: string } {
  if (!pr.headRef || pr.crossRepo) return { result: 'error', why: 'no same-repo head branch' };
  const parentHeads = withDiscoveredParents(repo, pr.number, pr.head, ctx?.parentHeads ?? [], landTarget());
  const r = smartRefreshSync({ repo, pr: pr.number, head: pr.head, branch: pr.headRef, ...(parentHeads.length ? { parentHeads } : {}), lockDir: smartMergeLockDir() });
  return smartResultToRefresh(r);
}

export function smartResultToRefresh(r: SmartRefreshResult): { result: RefreshResult; newHead?: string; why?: string } {
  switch (r.result) {
    case 'merged': case 'rebuilt': return { result: r.result, newHead: r.newHead, ...(r.resolved.length ? { why: `resolved ${r.resolved.map(x => `${x.path}:${x.rule}`).join(', ').slice(0, 160)}` } : {}) };
    case 'up-to-date': return { result: 'up-to-date' };
    case 'conflict': return { result: 'conflict', why: r.card.slice(0, 1500) };
    case 'guard': return { result: 'guard', why: r.card.slice(0, 1500) };
    case 'needs-llm': return { result: 'needs-llm', why: r.files.slice(0, 5).join(', ') };
    default: return { result: r.result, why: r.why };
  }
}

/**
 * Given parents ∪ automatically discovered ones: the merged PRs (≠ this one) that contain the branch's own commits
 * (`gh api repos/<slug>/commits/<sha>/pulls`, newest own commit first · bounded). Fails open to the given list.
 */
export function withDiscoveredParents(repo: string, pr: number, head: string, given: readonly string[], target: LandRepo): string[] {
  const out = new Set(given.map(x => x.toLowerCase()));
  try {
    const g = gitAt(repo, { timeoutMs: 60_000 });
    if (g(['cat-file', '-e', `${head}^{commit}`]).status !== 0) g(['fetch', '-q', 'origin', `pull/${pr}/head`]);
    if (!target.slug) return [...out];
    const lookup = (commit: string): string | null => {
      const v = ghJson(['api', `repos/${target.slug}/commits/${commit}/pulls`], { ...target, slug: null }) as Array<{ number?: number; merged_at?: string | null; head?: { sha?: string } }>;
      const hit = Array.isArray(v) ? v.find(x => x.number !== pr && !!x.merged_at && typeof x.head?.sha === 'string') : undefined;
      return hit?.head?.sha ?? null;
    };
    for (const h of discoverParents(g, head, 'origin/main', lookup, 20)) out.add(h);
  } catch { /* discovery is best effort */ }
  return [...out];
}

/** SMART-MERGE parents: recent squash-landed heads (one gh call per tick) · the merged head of a stacked PR's base branch. */
export function smartMergeDeps(target: LandRepo): NonNullable<LandDeps['smartMerge']> {
  return {
    mergedHeads() {
      const v = ghJson(['pr', 'list', '--state', 'merged', '--base', 'main', '--limit', '60', '--json', 'headRefOid'], target) as Array<{ headRefOid?: string }>;
      return Array.isArray(v) ? v.map(x => x.headRefOid ?? '').filter(h => /^[0-9a-f]{40}$/.test(h)) : [];
    },
    mergedBaseHead(pr) {
      const v = ghJson(['pr', 'list', '--head', pr.base, '--state', 'merged', '--json', 'headRefOid', '--limit', '1'], target) as Array<{ headRefOid?: string }>;
      const h = Array.isArray(v) ? v[0]?.headRefOid : undefined;
      return h && /^[0-9a-f]{40}$/.test(h) ? h : null;
    },
  };
}

/**
 * PREGATE-RETRY host: the guardian's choice when present (guardian v2 #40352/#40362) — its fresh route
 * (`<state>/res/route.json` {host, at} ≤ 15 min) unless that is the host that timed out, else `eln res host pick --reserved <avoid>`
 * — then the configured rotation (`land.graph.retryHosts`). Every step fails open to the next.
 */
export function retryHost(avoid: string, hosts: readonly string[], o: { stateRoot?: string; nowMs?: number; pick?: (avoid: string) => string | null } = {}): string {
  const okHost = (h: unknown): h is string => typeof h === 'string' && /^[\w.-]{1,64}$/.test(h) && h !== avoid;
  try {
    const r = JSON.parse(readFileSync(join(o.stateRoot ?? effectiveInstanceRoot(), 'res', 'route.json'), 'utf8')) as { host?: unknown; at?: unknown };
    const age = typeof r.at === 'string' ? (o.nowMs ?? Date.now()) - Date.parse(r.at) : NaN;
    if (okHost(r.host) && age >= 0 && age <= 15 * 60_000) return r.host; // a future-dated route (clock skew) is not fresh
  } catch { /* no route file */ }
  const picked = (() => { try { return (o.pick ?? guardianPick)(avoid); } catch { return null; } })();
  if (okHost(picked)) return picked;
  return nextHost(avoid, hosts);
}
/** `eln res host pick --reserved <avoid>` through this same CLI (only when the command exists · 90 s: it probes hosts over ssh). */
function guardianPick(avoid: string): string | null {
  const bin = process.argv[1];
  if (!bin || !/elanous\.mjs$/.test(bin)) return null;
  const r = spawnSync(process.execPath, [bin, 'res', 'host', 'pick', '--reserved', avoid], { encoding: 'utf8', timeout: 90_000 });
  return r.status === 0 ? (r.stdout ?? '').trim().split('\n').pop() ?? null : null;
}

/** Detached `pregate <PR> --light` (the RES launcher picks the least-loaded host) · log under the land-graph state dir. */
export function finisherDeps(target: LandRepo, repo: string, hosts: readonly string[] = defaultRetryHosts()): NonNullable<LandDeps['finisher']> {
  return {
    launchPregate(pr, opts) {
      const tool = join(seatState(), 'RES', 'tools', 'pregate');
      if (!existsSync(tool)) return { ok: false, why: `${tool} missing` };
      const dir = join(effectiveInstanceRoot(), 'land-graph', 'finisher'); mkdirSync(dir, { recursive: true });
      const log = join(dir, `${pr.number}-${pr.head.slice(0, 12)}.log`);
      const fd = openSync(log, 'a');
      try {
        // PREGATE-RETRY: a tsc-timeout re-run goes to the next host of the rotation, never the one that timed out.
        const host = opts?.avoidHost ? retryHost(opts.avoidHost, hosts) : '';
        const args = [tool, String(pr.number), '--light', ...(host ? ['--host', host] : [])]; // '' = no routable host → pregate auto-picks
        const child = spawn('sh', args, { detached: true, stdio: ['ignore', fd, fd], cwd: repo,
          env: { ...process.env, PATH: landToolPath(process.env.PATH), ...(target.slug ? { GH_REPO: target.slug } : {}) } });
        child.unref();
        return child.pid ? { ok: true, pid: child.pid, log } : { ok: false, why: 'spawn failed' };
      } catch (e) { return { ok: false, why: String(e).slice(0, 120) }; } finally { closeSync(fd); }
    },
    alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } },
    refresh: (pr, ctx) => refreshBranch(repo, pr, ctx),
    autofix(pr, red) {
      // LAND10-AUTOFIX-LANE: only the mechanical red the ratchets named · plain push (the same PR lock as smart-merge).
      if (!pr.headRef || pr.crossRepo) return { result: 'semantic', why: 'no same-repo head branch' };
      const r = autofixPr({ repo, pr: pr.number, head: pr.head, branch: pr.headRef, lockDir: smartMergeLockDir(),
        red: red.failed.map(s => ({ step: s.name, text: redRaw(red.dir, s.name) })),
        stillOpen: () => { try { return (ghJson(['pr', 'view', String(pr.number), '--json', 'state'], target) as { state?: string }).state === 'OPEN'; } catch { return false; } } });
      if (r.result === 'fixed') return { result: 'fixed', newHead: r.newHead, why: r.applied.map(a => `${a.kind} ${a.file}:${a.line}`).join(', ').slice(0, 300) };
      return { result: r.result, why: r.why };
    },
    launchResolve(pr, ctx) {
      // SMART-MERGE (c): the LLM step runs in a detached capsule — `eln land smart-merge <pr> --llm` (same CLI entry).
      const dir = join(effectiveInstanceRoot(), 'land-graph', 'finisher'); mkdirSync(dir, { recursive: true });
      const log = join(dir, `${pr.number}-${pr.head.slice(0, 12)}-smart-merge.log`);
      const entry = process.argv[1] && /\.(m?[jt]s|mjs|cjs)$/.test(process.argv[1]) ? [process.argv[1]] : [];
      const args = [...entry, 'land', 'smart-merge', String(pr.number), '--head', pr.head, '--branch', pr.headRef ?? '', '--llm',
        ...(ctx?.parentHeads?.length ? ['--parent-heads', ctx.parentHeads.join(',')] : [])];
      const fd = openSync(log, 'a');
      try {
        const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd], cwd: repo,
          env: { ...process.env, PATH: landToolPath(process.env.PATH), ...(target.slug ? { GH_REPO: target.slug } : {}) } });
        child.unref();
        return child.pid ? { ok: true, pid: child.pid, log } : { ok: false, why: 'spawn failed' };
      } catch (e) { return { ok: false, why: String(e).slice(0, 120) }; } finally { closeSync(fd); }
    },
  };
}

// ── Replay ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One row per recorded coach-land attempt (.out file) of `date`, in file order. */
export function replayDay(dir: string, files: (pr: number) => string[]): ReplayRow[] {
  if (!existsSync(dir)) return [];
  const outs = readdirSync(dir).filter(n => /^coach-land-\d+[a-z]?\.out$/.test(n)).sort();
  const rows: ReplayRow[] = [];
  for (const n of outs) {
    const m = /^coach-land-(\d+)([a-z]?)\.out$/.exec(n)!; const pr = Number(m[1]);
    const out = readFileSync(join(dir, n), 'utf8');
    const log = join(dir, `coach-land-${pr}${m[2]}.log`);
    // A later attempt (b/c…) rewrites the bare .log — use it only for the newest attempt of the PR.
    const newest = !outs.some(o => o > n && o.startsWith(`coach-land-${pr}`) && /^coach-land-\d+[a-z]?\.out$/.test(o) && Number(/\d+/.exec(o)![0]) === pr);
    const text = out + (existsSync(log) && (m[2] || newest) ? `\n${readFileSync(log, 'utf8')}` : '');
    const line = /· rc=(\d+) · (MERGED|OPEN|CLOSED)/.exec(out);
    const rc = line ? Number(line[1]) : Number(/^RC=(\d+)/m.exec(out)?.[1] ?? 1);
    const state = line ? line[2]! : 'OPEN';
    // A coach pre-check STOP prints only «STOP …» (no ledger line).
    if (!line && !/STOP/.test(out)) continue;
    rows.push(replayAttempt(pr, n.replace(/\.out$/, ''), rc, state, text, isDocOnly(files(pr))));
  }
  return rows;
}

export function replayMarkdown(rows: ReplayRow[]): string {
  const lines = ['| PR | attempt | actual | graph | class | match |', '|---|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| #${r.pr} | ${r.attempt} | ${r.actual} | ${r.graph} | ${r.cls ?? ''} | ${r.match ? '✓' : `✗ ${r.note ?? ''}`} |`);
  const m = rows.filter(r => r.match).length;
  lines.push('', `${m}/${rows.length} match · lands ${rows.filter(r => r.actual === 'MERGED').length} · STOPs ${rows.filter(r => r.actual !== 'MERGED').length}`);
  return lines.join('\n');
}

// ── Synthetic shadow injection ─────────────────────────────────────────────────────────────────────────────────

export const SYNTH_HEAD = (n: number) => `${String(n).padStart(4, '0')}${'5'.repeat(36)}`;
export function synthPrs(): { prs: PrInfo[]; receipts: Record<number, Receipt>; focused: Record<number, Focused>; older: Record<number, string>; security: Record<number, string[]> } {
  const base = { base: 'main', draft: false, state: 'OPEN' as const, author: 'SYNTH' };
  const prs: PrInfo[] = [
    { ...base, number: 990001, head: SYNTH_HEAD(1), title: 'synthetic: clean land', files: ['src/a.ts'] },
    { ...base, number: 990002, head: SYNTH_HEAD(2), title: 'synthetic: stale head', files: ['src/b.ts'] },
    { ...base, number: 990003, head: SYNTH_HEAD(3), title: 'synthetic: baseline-failing focused', files: ['src/c.ts'] },
    { ...base, number: 990004, head: SYNTH_HEAD(4), title: 'synthetic: doc-only', files: ['docs/x.md'] },
    { ...base, number: 990005, head: SYNTH_HEAD(5), title: 'synthetic: hot file', files: ['src/index.ts'] },
  ];
  const r = (n: number, focused: string[]): Receipt => ({ dir: `synthetic/${n}`, head: SYNTH_HEAD(n % 10), host: 'synthetic', focused, rawDir: '' });
  return {
    prs,
    receipts: { 990001: r(990001, ['src/a.test.ts']), 990003: r(990003, ['src/c.test.ts']), 990004: r(990004, []), 990005: r(990005, ['src/i.test.ts']) },
    focused: { 990001: { pass: 12, fail: 0 }, 990003: { pass: 40, fail: 3 }, 990005: { pass: 5, fail: 0 } },
    older: { 990002: 'f'.repeat(40) },
    security: {},
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────────

function emit(v: unknown, json: boolean, text: () => string): void { console.log(json ? JSON.stringify(v) : text()); }
function handle(fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(fn).catch(e => { console.error(`land: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
}

export function registerLandCommands(program: Command, deps: () => LandDeps = () => defaultLandDeps()): void {
  const land = program.command('land').description('Land graph — judge → land under judge-kingdom autonomy (shadow by default)');
  const graph = land.command('graph').description('Land graph status · plan · tick · replay · synth');
  graph.command('status').option('--json').action((o: { json?: boolean }) => handle(async () => {
    const d = deps(); const rows = readLedger(d.stateRoot).filter(r => !r.synthetic);
    const latest = new Map<number, (typeof rows)[number]>();
    for (const r of rows) if (r.event === 'decision' || r.event === 'refused' || r.event === 'landed') latest.set(r.pr, r);
    // LAND-STEWARD: closed / merged PRs leave the view (11-27 #39114 · #39243 still listed «refuse stale-base-revert» after close).
    // Fail-open: when gh cannot list, the ledger view stays whole.
    const open = await d.listPrs().then(ps => new Set(ps.filter(p => p.state === 'OPEN').map(p => p.number)), () => null);
    if (open) for (const pr of [...latest.keys()]) if (!open.has(pr)) latest.delete(pr);
    const today = new Date().toISOString().slice(0, 10);
    const v = { mode: d.mode, slots: d.slots, holds: readHolds(d.stateRoot), landedToday: rows.filter(r => r.event === 'landed' && r.at.startsWith(today)).map(r => r.pr), latest: [...latest.values()] };
    emit(v, !!o.json, () => [`land graph · mode ${v.mode} · slots ${v.slots} · landed today ${v.landedToday.length}`,
      ...Object.entries(v.holds).map(([pr, h]) => `HOLD #${pr} · ${h.reason} (${h.by})`),
      ...v.latest.map(r => `#${r.pr} @${r.head.slice(0, 12)} ${r.event === 'decision' ? r.action : r.event}${r.cls ? ` ${r.cls}` : ''} · ${r.why ?? ''}`)].join('\n'));
  }));
  graph.command('plan').option('--json')
    .option('--reap', 'list open >24h PRs whose whole diff is already in main (dry run)').option('--apply', 'with --reap: close them with a comment')
    .action((o: { json?: boolean; reap?: boolean; apply?: boolean }) => handle(async () => {
    const res = await tickLand({ ...deps(), dry: true, ...(o.reap ? { reap: o.apply ? 'apply' as const : 'dry' as const } : {}) });
    emit(res, !!o.json, () => [`plan · mode ${res.mode} · ready ${res.ready ?? 0}${res.error ? ` · ${res.error}` : ''}`, ...res.decisions.map(x => `#${x.pr} ${x.action}${x.cls ? ` ${x.cls}` : ''} · ${x.why}`),
      ...(res.finisher ?? []).map(f => `finisher #${f.pr} @${f.head.slice(0, 12)} ${f.kind} ${f.state} · ${f.why}`),
      ...(res.autofixPerHour !== undefined ? [`KPI autofix/h ${res.autofixPerHour}`] : []),
      ...(res.stale ?? []).map(s => `stale #${s.pr} ${s.ageH}h · ${s.reason}`),
      ...(res.reaped ?? []).map(r => `reap #${r.pr} ${r.action} · ${r.why}`),
      ...(res.cells ?? []).map(c => c.cell ? `cell #${c.pr} ${c.action} ${c.cell} (${c.basis})` : `cell #${c.pr} landed-no-cell`)].join('\n'));
    if (res.error) process.exitCode = 1;
  }));
  graph.command('tick').option('--json').action((o: { json?: boolean }) => handle(async () => {
    const d = deps();
    // Land ops: landing owner (org duty «landing») or the HQ seat; the trigger runs as the landing owner.
    const seat = process.env.ELANOUS_TRACK ?? landingOwner();
    const res = d.mode === 'live' && !mayRunLandOps(seat) ? { ...(await tickLand({ ...d, mode: 'shadow' })), error: `seat ${seat} may not run land ops (live → shadow)` } : await tickLand(d);
    emit(res, !!o.json, () => res.locked ? 'tick: another tick holds the lock' : [`tick · mode ${res.mode} · landed ${res.landed.join(',') || '—'}${res.error ? ` · ${res.error}` : ''}`,
      ...res.decisions.map(x => `#${x.pr} ${x.action}${x.cls ? ` ${x.cls}` : ''} · ${x.why}`),
      ...(res.finisher ?? []).map(f => `finisher #${f.pr} @${f.head.slice(0, 12)} ${f.kind} ${f.state} · ${f.why}`),
      ...(res.autofixPerHour !== undefined ? [`KPI autofix/h ${res.autofixPerHour}`] : []),
      ...(res.cells ?? []).map(c => c.cell ? `cell #${c.pr} ${c.action} ${c.cell} (${c.basis})${c.why ? ` · ${c.why}` : ''}` : `cell #${c.pr} landed-no-cell`)].join('\n'));
    if (res.error && !res.skipped) process.exitCode = 1; // GH-BUDGET-GOVERNOR ④: skipped = exit 0, the next tick retries
  }));
  graph.command('replay').option('--date <yyyymmdd>', 'evidence day', '20261125').option('--json').action((o: { date: string; json?: boolean }) => handle(() => {
    const dir = join(seatState(), 'OP', 'evidence', o.date);
    const cache = new Map<number, string[]>();
    const target = landTarget();
    const files = (pr: number) => {
      if (!cache.has(pr)) { try { cache.set(pr, ((ghJson(['pr', 'view', String(pr), '--json', 'files'], target) as GhPr).files ?? []).map(f => f.path)); } catch { cache.set(pr, []); } }
      return cache.get(pr)!;
    };
    const rows = replayDay(dir, files);
    emit(rows, !!o.json, () => replayMarkdown(rows));
  }));
  graph.command('synth').requiredOption('--seat <seat>', 'test seat that receives the shadow cards (never JUD)').option('--json').action((o: { seat: string; json?: boolean }) => handle(async () => {
    if (/^(JUD|OP)$/i.test(o.seat)) throw new Error('synth cards go to a test seat, not JUD/OP');
    const s = synthPrs(); const base = deps();
    const res = await tickLand({ ...base, mode: 'shadow', synthetic: true, cardSeat: o.seat,
      listPrs: async () => s.prs, prNow: async n => s.prs.find(p => p.number === n) ?? null,
      receipt: pr => s.receipts[pr] ?? null, olderReceiptHead: pr => s.older[pr] ?? null,
      focused: r => s.focused[Number(r.dir.split('/')[1])] ?? 'unreadable', security: pr => s.security[pr] ?? [],
      land: async () => { throw new Error('synthetic never lands'); } });
    emit(res, !!o.json, () => res.decisions.map(x => `[synthetic] #${x.pr} ${x.action}${x.cls ? ` ${x.cls}` : ''} · ${x.why}`).join('\n'));
  }));
  // SMART-MERGE capsule / hand entry: rebuild-or-merge one PR onto main with the full ladder (rerere → structural → LLM).
  land.command('smart-merge <pr>').description('Bring a PR branch onto main: stack rebuild after a squash or main merge · conflict ladder · revert guard · plain push')
    .option('--head <sha>', 'expected PR head (default: the PR\'s current head from gh)').option('--branch <name>', 'PR head branch (default: from gh)')
    .option('--parent-heads <shas>', 'comma-separated squash-landed heads that may be inside the branch (default: the last 60 merged PR heads)').option('--llm', 'allow the LLM step for hunks rerere / structural left')
    .option('--dry', 'compute and guard, push nothing').option('--json')
    .action((pr: string, o: { head?: string; branch?: string; parentHeads?: string; llm?: boolean; dry?: boolean; json?: boolean }) => handle(async () => {
      const cfg = readConfig(); const target = landTarget(cfg); const repo = target.root ?? process.cwd();
      let head = o.head; let branch = o.branch;
      if (!head || !branch) {
        const v = ghJson(['pr', 'view', String(Number(pr)), '--json', 'headRefOid,headRefName,isCrossRepository,state'], target) as { headRefOid?: string; headRefName?: string; isCrossRepository?: boolean; state?: string };
        if (v.isCrossRepository) throw new Error(`#${pr} lives in a fork — the smart-merge never pushes there`);
        if (v.state && v.state !== 'OPEN') throw new Error(`#${pr} is ${v.state}`);
        head = head ?? v.headRefOid; branch = branch ?? v.headRefName;
      }
      if (!head || !branch) throw new Error(`#${pr}: head / branch unknown`);
      const given = o.parentHeads ? o.parentHeads.split(',').map(x => x.trim()).filter(Boolean)
        : (() => { try { return [...smartMergeDeps(target).mergedHeads()]; } catch { return []; } })();
      const parentHeads = withDiscoveredParents(repo, Number(pr), head, given, target);
      const input = { repo, pr: Number(pr), head, branch, lockDir: smartMergeLockDir(), push: !o.dry, ...(parentHeads.length ? { parentHeads } : {}) };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const llm = o.llm ? (require('../git-smart/llm.js') as typeof import('../git-smart/llm.js')).defaultSmartMergeLlm() : null;
      const r = llm ? await smartRefresh({ ...input, llm }) : smartRefreshSync(input);
      console.log(o.json ? JSON.stringify(r) : `smart-merge #${pr} ${r.result}${'newHead' in r ? ` → ${r.newHead.slice(0, 12)}` : ''}${'why' in r ? ` · ${r.why}` : ''}${'card' in r ? `\n${r.card}` : ''}`);
      if (!['merged', 'rebuilt', 'up-to-date'].includes(r.result)) process.exitCode = 1;
    }));
  land.command('hold <pr>').requiredOption('--reason <text>').option('--by <seat>', 'who holds', process.env.ELANOUS_TRACK ?? 'JUD')
    .action((pr: string, o: { reason: string; by: string }) => handle(() => { setHold(deps().stateRoot, Number(pr), o.reason, o.by); console.log(`HOLD #${pr} · ${o.reason}`); }));
  land.command('unhold <pr>').action((pr: string) => handle(() => {
    // CLAUDE-OP-PROXY-IDENTITY — ELANOUS_TRACK=CLAUDE-OP: only the verified proxy session, audited ⊕ noticed to OP, and
    // never over a JUD hold (the judiciary's veto stays the judiciary's). Other callers keep today's behavior.
    const claimed = (process.env.ELANOUS_TRACK ?? '').trim().toUpperCase();
    if (claimed === 'CLAUDE-OP') {
      const { resolveProxyActor, auditProxyRefusal } = require('../proxy/proxy-identity.js') as typeof import('../proxy/proxy-identity.js');
      const hold = readHolds(deps().stateRoot)[String(Number(pr))];
      if (hold && /^JUD/i.test(hold.by.trim())) {
        auditProxyRefusal('land-unhold', `#${pr}`, 'jud-hold');
        throw new Error(`land unhold: #${pr} is held by ${hold.by} (JUD veto) — the proxy never lifts a JUD hold`);
      }
      const r = resolveProxyActor({ claimed, op: 'land-unhold', target: `#${pr}` });
      if (r.kind === 'refused') throw new Error(r.line);
      // Conditional clear: a JUD hold set between the check and the clear is kept.
      console.log(clearHold(deps().stateRoot, Number(pr), (h) => !/^JUD/i.test(h.by.trim())) ? `unhold #${pr}` : `#${pr} was not held (or is now a JUD hold)`);
      return;
    }
    console.log(clearHold(deps().stateRoot, Number(pr)) ? `unhold #${pr}` : `#${pr} was not held`);
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('./land-rail-watch-cli.js') as typeof import('./land-rail-watch-cli.js')).registerRailWatch(land);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('../land-steward/cli.js') as typeof import('../land-steward/cli.js')).registerStewardCommands(land, deps);
}
