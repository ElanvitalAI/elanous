import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename, dirname, join } from 'node:path';
import { findGitDir } from '../git-fs/locate.js';
import { debug } from '../debug/log.js';
import { PR_LABELS } from '../github/pr-labels.js';
import { appendRunLedgerEntry, listRunLedgers, loadRunLedger, runLedgerDir, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { queryRunningRuns } from '../self-implement/running-runs.js';
import { DRAFT_SWEEP_CLOSE_CAP } from './draft-sweep.js';
import { PROTECTED_LABELS, sameVerifiedGoal, type DraftTriagePr } from './draft-triage-rules.js';

export type PodTerminalClass = 'landed' | 'merge-ready-not-merged' | 'failed-with-pr' | 'failed-no-pr' | 'failed-pr-unobserved';
export interface PrTerminalRecord {
  childRunId: string;
  prNumber: number | null;
  prUrl: string | null;
  repository: string | null;
  headSha: string | null;
  terminalClass: PodTerminalClass;
  stage: string | null;
  owner: string;
  ownerSource: 'seat' | 'card' | 'unknown';
  card: string | null;
  at: string;
}
export interface PodTerminalInput {
  childRunId: string;
  state: 'complete' | 'failed' | 'aborted';
  disposition?: { prNumber?: number | null; prUrl?: string | null; checkedHeadCommit?: string | null; stage?: string; merged?: boolean; ok?: boolean } | null;
  env?: Readonly<Record<string, string | undefined>>;
  prBody?: string;
  goalText?: string;
  at?: string;
}

const cardOf = (text?: string): string | null => /^칸:\s*(\S.*?)\s*$/m.exec(text ?? '')?.[1]?.trim() || null;
const harvestable = PR_LABELS.find((label) => label.name === 'elanous:harvestable')!.name;
const superseded = PR_LABELS.find((label) => label.name === 'elanous:superseded')!.name;

export function classifyPodTerminal(input: PodTerminalInput): PrTerminalRecord {
  const d = input.disposition;
  const prNumber = Number.isSafeInteger(d?.prNumber) && (d?.prNumber ?? 0) > 0 ? d!.prNumber! : null;
  const prUrl = typeof d?.prUrl === 'string' ? d.prUrl : null;
  const match = prUrl && /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/.exec(prUrl);
  const repository = match && Number(match[3]) === prNumber ? `${match[1]}/${match[2]}` : null;
  const card = cardOf(input.prBody) ?? cardOf(input.goalText);
  const seat = input.env?.ELANOUS_HARNESS_SEAT;
  const ownerSource = seat === 'OP' || seat === 'TC' || seat === 'MK' || seat === 'UX' ? 'seat' : card ? 'card' : 'unknown';
  return {
    childRunId: input.childRunId, prNumber, prUrl, repository,
    headSha: typeof d?.checkedHeadCommit === 'string' && /^[a-f0-9]{40}$/i.test(d.checkedHeadCommit) ? d.checkedHeadCommit : null,
    terminalClass: !d ? 'failed-pr-unobserved' : d.merged === true ? 'landed'
      : prNumber === null ? 'failed-no-pr'
        : input.state === 'complete' && d.ok !== false ? 'merge-ready-not-merged' : 'failed-with-pr',
    stage: d?.stage ?? null,
    owner: ownerSource === 'seat' ? seat! : ownerSource === 'card' ? card! : 'unknown',
    ownerSource, card, at: input.at ?? new Date().toISOString(),
  };
}

export interface ResiduePr extends DraftTriagePr {
  createdAt: string;
  labels: readonly string[];
  body?: string;
  comments?: readonly string[];
  /** GitHub PR state at lookup time (review r8) — absent only from injected inventories. */
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
}
export interface DraftResidueAdapters {
  loadLedger(runId: string, ledgerDir: string): readonly RunLedgerEntry[] | null;
  appendLedger(entry: RunLedgerEntry, ledgerDir: string): void;
  getPr(number: number): Promise<ResiduePr | undefined> | ResiduePr | undefined;
  listOpenDrafts(repository: string): Promise<readonly ResiduePr[] | undefined> | readonly ResiduePr[] | undefined;
  addLabel(repository: string, number: number, label: string): Promise<void> | void;
  setLabels(repository: string, number: number, change: { add: string; remove: readonly string[] }): Promise<void> | void;
  comment(repository: string, number: number, body: string): Promise<void> | void;
  closePr(repository: string, number: number): Promise<void> | void;
  /** Undefined means liveness could not be established, not that no branch is live. */
  listLiveBranches(repository: string): Promise<ReadonlySet<string> | undefined> | ReadonlySet<string> | undefined;
  /** Undefined means the prior run could not be identified as ended. */
  getRunStatus(draft: ResiduePr, repository: string): Promise<string | undefined> | string | undefined;
}
/** One close budget shared by every terminal replayed in a tick and the draft sweep that follows. */
export interface DraftCloseBudget { remaining: number }
export interface DraftResidueContext {
  ledgerRunId: string;
  ledgerDir: string;
  adapters?: DraftResidueAdapters;
  closeBudget?: DraftCloseBudget;
}
export type DraftResidueResult = { status: 'recorded' | 'skipped' | 'failed'; reason?: string; step?: string };

function gh(args: string[]): string {
  const result = spawnSync('gh', args, { cwd: findGitDir(process.cwd())?.root ?? process.cwd(), encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || `gh exited ${result.status}`).trim().slice(0, 200));
  return result.stdout.trim();
}
function ghPr(row: { number: number; title: string; headRefName: string; createdAt: string; body: string; labels: Array<{ name: string }>; comments?: Array<{ body: string }>; state?: string }): ResiduePr {
  const state = row.state === 'OPEN' || row.state === 'CLOSED' || row.state === 'MERGED' ? row.state : undefined;
  return { number: row.number, title: row.title, branch: row.headRefName, createdAt: row.createdAt, body: row.body,
    labels: row.labels.map((label) => label.name), comments: row.comments?.map((comment) => comment.body), ...(state ? { state } : {}) };
}
/** Where the default `getRunStatus` reads run facts. Production reads the federated host ledgers and the running-runs
 *  query; tests pass ledgers on disk and a running snapshot, exercising the same decision code (review r6). */
export interface ResidueRunStatusSources {
  ledgers(): ReadonlyArray<{ runId: string; entries: readonly RunLedgerEntry[] }>;
  running(): { completeness: 'complete' | 'partial'; entries: ReadonlyArray<{ runId: string; status?: string }> };
}

const defaultRunStatusSources: ResidueRunStatusSources = {
  ledgers: () => listRunLedgers().matches,
  running: () => queryRunningRuns(),
};

function refersToPr(entry: RunLedgerEntry, number: number, repository: string): boolean {
  const repo = typeof entry.data.repository === 'string' ? entry.data.repository : undefined;
  const url = entry.data.url ?? entry.data.html_url;
  const sameRepo = repo !== undefined ? repo.toLowerCase() === repository.toLowerCase()
    : typeof url === 'string' ? url.toLowerCase() === `https://github.com/${repository}/pull/${number}`.toLowerCase() : false;
  if (entry.event === 'pr-opened') return entry.data.number === number && sameRepo;
  if (entry.event === 'pr-terminal') return entry.data.prNumber === number && sameRepo;
  // Any other entry naming this PR without a repository is counted as related: more related runs only defers a close.
  return entry.data.prNumber === number && (repo === undefined || sameRepo);
}

/** Review r6: the status of the run(s) behind a draft. A recorded `pr-terminal` settles it only when no run that
 *  touched that PR is still alive — a later run reworking the same PR keeps it «running». Unknown stays undefined. */
export function residueRunStatus(draft: Pick<ResiduePr, 'number'>, repository: string, sources: ResidueRunStatusSources = defaultRunStatusSources): string | undefined {
  const related = sources.ledgers().filter((match) => match.entries.some((entry) => refersToPr(entry, draft.number, repository)));
  if (related.length === 0) return undefined;
  const running = sources.running();
  if (running.completeness !== 'complete') return undefined;
  const statuses = related.map((match) => running.entries.find((entry) => entry.runId === match.runId)?.status
    ?? [...match.entries].reverse().find((entry) => entry.event === 'run-status')?.data.runStatus);
  if (statuses.some((status) => status === 'running' || status === 'probable-running')) return 'running';
  // Review r9: every related run must be accounted for — its own pr-terminal for this PR, or an observed status.
  // A related run with neither is unconfirmed, so another run's terminal cannot settle the PR.
  const unconfirmed = related.some((match, index) => typeof statuses[index] !== 'string'
    && terminalRunStatus(draft.number, repository, [match]) === undefined);
  if (unconfirmed) return undefined;
  const ended = terminalRunStatus(draft.number, repository, related);
  if (ended) return ended;
  return statuses.length === 1 && typeof statuses[0] === 'string' ? statuses[0] : undefined;
}

export function defaultAdapters(sources: ResidueRunStatusSources = defaultRunStatusSources): DraftResidueAdapters {
  const fields = 'number,title,headRefName,createdAt,body,labels,comments,state';
  return {
    loadLedger: loadRunLedger,
    appendLedger: appendRunLedgerEntry,
    getPr: (number) => ghPr(JSON.parse(gh(['pr', 'view', String(number), '-R', hostRepository() ?? '', '--json', fields]))),
    listOpenDrafts: (repository) => {
      const rows: ResiduePr[] = [];
      for (let page = 1; page <= 100; page++) {
        const result = JSON.parse(gh(['api', `repos/${repository}/pulls?state=open&per_page=100&page=${page}`])) as Array<{
          number: number; title: string; head: { ref: string }; created_at: string; body: string; draft: boolean; labels: Array<{ name: string }>;
        }>;
        if (!Array.isArray(result)) throw new Error('Invalid open PR inventory');
        rows.push(...result.filter((pr) => pr.draft).map((pr) => ghPr({ number: pr.number, title: pr.title, headRefName: pr.head.ref, createdAt: pr.created_at, body: pr.body, labels: pr.labels })));
        if (result.length < 100) return rows;
      }
      throw new Error('Open PR inventory exceeded pagination limit');
    },
    addLabel: (repository, number, label) => { gh(['pr', 'edit', String(number), '-R', repository, '--add-label', label]); },
    setLabels: (repository, number, change) => { gh(['pr', 'edit', String(number), '-R', repository, '--add-label', change.add, ...change.remove.flatMap((label) => ['--remove-label', label])]); },
    comment: (repository, number, body) => { gh(['pr', 'comment', String(number), '-R', repository, '--body', body]); },
    closePr: (repository, number) => { gh(['pr', 'close', String(number), '-R', repository]); },
    listLiveBranches: (repository) => {
      if (repository.toLowerCase() !== hostRepository()?.toLowerCase()) return undefined;
      const root = findGitDir(process.cwd())?.root;
      if (!root) return undefined;
      const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
      if (result.status !== 0) return undefined;
      return new Set(result.stdout.split('\n').filter((line) => line.startsWith('branch refs/heads/'))
        .map((line) => line.slice('branch refs/heads/'.length).trim()));
    },
    getRunStatus: (draft, repository) => residueRunStatus(draft, repository, sources),
  };
}

/** Review r5: a host ledger `pr-terminal` for that PR proves the run that opened it has ended (it is written at the
 *  run's terminal). Returns the ended status, or undefined when no terminal for that PR is recorded. */
export function terminalRunStatus(draftNumber: number, repository: string, ledgers: ReadonlyArray<{ entries: readonly RunLedgerEntry[] }>): 'completed' | 'failed' | undefined {
  for (const ledger of ledgers) {
    for (const entry of ledger.entries) {
      if (entry.event !== 'pr-terminal' || entry.data.prNumber !== draftNumber) continue;
      const repo = typeof entry.data.repository === 'string' ? entry.data.repository : '';
      if (repo.toLowerCase() !== repository.toLowerCase()) continue;
      return entry.data.terminalClass === 'landed' ? 'completed' : 'failed';
    }
  }
  return undefined;
}

export function podTerminalPrBody(disposition: PodTerminalInput['disposition']): string | undefined {
  const url = disposition?.prUrl;
  const number = disposition?.prNumber;
  const match = typeof url === 'string' ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(url) : null;
  if (!match || Number(match[2]) !== number || match[1]!.toLowerCase() !== hostRepository()?.toLowerCase()) return undefined;
  try { return gh(['pr', 'view', String(number), '-R', match[1]!, '--json', 'body', '--jq', '.body']); }
  catch { return undefined; }
}

function hostRepository(): string | null {
  const root = findGitDir(process.cwd())?.root;
  if (!root) return null;
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  const match = result.status === 0 ? /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?\s*$/.exec(result.stdout) : null;
  return match?.[1] ?? null;
}

export interface DraftResidueReplayOptions {
  repository?: string;
  ledgerDir?: string;
  adapters?: DraftResidueAdapters;
  /** Directory enumeration seam for the host run-ledger scan. */
  listLedgers?: (dir: string) => readonly string[];
  /** This tick's close cap — shared with the sweep that runs after the replay. */
  closeCap?: number;
}

/** Replay unfinished terminal effects from the host ledger, not from PR age or title guesses. */
export async function replayPodTerminals(options: DraftResidueReplayOptions = {}): Promise<{
  /** `unresolved` — terminals that can never be settled from the record (no repository); settled once, not retried. */
  attempted: number; recovered: number; pending: number; unresolved: number; closed: number;
}> {
  const cap = Number.isSafeInteger(options.closeCap) && (options.closeCap ?? 0) >= 0 ? options.closeCap! : DRAFT_SWEEP_CLOSE_CAP;
  const closeBudget: DraftCloseBudget = { remaining: cap };
  const closedSoFar = () => cap - closeBudget.remaining;
  const ledgerDir = options.ledgerDir ?? runLedgerDir();
  const list = options.listLedgers ?? readdirSync;
  let attempted = 0;
  let recovered = 0;
  let pending = 0;
  let unresolved = 0;
  let files: readonly string[];
  try { files = list(ledgerDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { attempted, recovered, pending, unresolved, closed: 0 };
    throw error;
  }
  const canonical = /^run-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  const active = files.filter((file) => file.endsWith('.jsonl')).map((file) => file.slice(0, -'.jsonl'.length)).filter((id) => canonical.test(id));
  const archiveDir = join(ledgerDir, 'archive');
  let archived: string[] = [];
  try { archived = (options.listLedgers ?? readdirSync)(archiveDir).filter((file) => /^\.archived-run-/.test(file))
    .map((file) => file.slice('.archived-'.length)).filter((id) => canonical.test(id)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const ledgerRunId of [...new Set([...active, ...archived])]) {
    const entries = active.includes(ledgerRunId) ? (options.adapters?.loadLedger ?? loadRunLedger)(ledgerRunId, ledgerDir)
      : (() => {
        const path = readFileSync(join(archiveDir, `.archived-${ledgerRunId}`), 'utf8');
        const month = basename(dirname(path));
        if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)
          || path !== join(archiveDir, month, `${ledgerRunId}.jsonl.gz`) || !existsSync(path)) {
          throw new Error(`Archived terminal ledger unavailable: ${ledgerRunId}`);
        }
        const lines = gunzipSync(readFileSync(path)).toString('utf8').trimEnd().split('\n').filter(Boolean);
        return lines.map((line) => {
          const entry = JSON.parse(line) as RunLedgerEntry;
          if (entry.runId !== ledgerRunId || typeof entry.event !== 'string' || !entry.data || typeof entry.data !== 'object') {
            throw new Error(`Invalid archived terminal ledger: ${ledgerRunId}`);
          }
          return entry;
        });
      })();
    if (!entries) throw new Error(`Terminal ledger disappeared: ${ledgerRunId}`);
    const terminals = entries.filter((entry) => entry.event === 'pr-terminal');
    for (const terminal of terminals) {
      const record = terminal.data as unknown as PrTerminalRecord;
      if (typeof record.childRunId !== 'string' || typeof record.owner !== 'string'
        || !['landed', 'merge-ready-not-merged', 'failed-with-pr', 'failed-no-pr', 'failed-pr-unobserved'].includes(record.terminalClass)
        || (record.prNumber !== null && (!Number.isSafeInteger(record.prNumber) || record.prNumber <= 0))
        || (record.repository !== null && (typeof record.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(record.repository)))) {
        throw new Error(`Invalid terminal record: ${ledgerRunId}`);
      }
      if (record.repository && options.repository && record.repository.toLowerCase() !== options.repository.toLowerCase()) continue;
      if (!options.adapters && record.repository) {
        const host = hostRepository();
        // Unknown host ≠ foreign repository: an unreadable origin keeps the terminal pending for a later replay.
        if (host === null) { attempted++; pending++; debug.log('draft.residue', 'skipped', { childRunId: record.childRunId, prNumber: record.prNumber, reason: 'host-repository-unobserved' }); continue; }
        if (record.repository.toLowerCase() !== host.toLowerCase()) continue;
      }
      if (entries.some((entry) => entry.event === 'pr-terminal-effect' && entry.data.childRunId === record.childRunId
        && (entry.data.effect === 'complete' || entry.data.effect === 'protected') && entry.data.number === (record.prNumber ?? 0))) continue;
      if (!record.repository && entries.some((entry) => entry.event === 'pr-terminal-effect' && entry.data.childRunId === record.childRunId
        && entry.data.effect === 'unresolved-repository')) { unresolved++; continue; }
      attempted++;
      const adapters = options.adapters ?? defaultAdapters();
      const replayAdapters: DraftResidueAdapters = active.includes(ledgerRunId) ? adapters : {
        ...adapters,
        loadLedger: (id, dir) => {
          const live = adapters.loadLedger(id, dir);
          return live?.some((entry) => entry.event === 'pr-terminal') ? live : [...entries, ...(live ?? [])];
        },
      };
      const outcome = await applyPodTerminal(record, { ledgerDir, ledgerRunId, adapters: replayAdapters, closeBudget });
      if (outcome.status === 'recorded' || outcome.reason === 'already-recorded') recovered++;
      else if (outcome.status === 'skipped' && outcome.reason === 'repository-unobserved') unresolved++;
      else if (outcome.status === 'skipped' && !['previous-run-unverified', 'previous-run-live', 'close-cap', 'host-repository-unobserved'].includes(outcome.reason ?? '')) recovered++;
      else pending++;
    }
  }
  return { attempted, recovered, pending, unresolved, closed: closedSoFar() };
}

export async function applyPodTerminal(record: PrTerminalRecord, ctx: DraftResidueContext): Promise<DraftResidueResult> {
  const adapters = ctx.adapters ?? defaultAdapters();
  const fields = { childRunId: record.childRunId, prNumber: record.prNumber, terminalClass: record.terminalClass, owner: record.owner, ownerSource: record.ownerSource };
  const log = (event: string, data: Record<string, unknown> = {}) => debug.log('draft.residue', event, { ...fields, ...data });
  const skipped = (reason: string): DraftResidueResult => { log('skipped', { reason }); return { status: 'skipped', reason }; };
  const budget: DraftCloseBudget = ctx.closeBudget ?? { remaining: DRAFT_SWEEP_CLOSE_CAP };
  let step = 'ledger';
  try {
    const ledger = adapters.loadLedger(ctx.ledgerRunId, ctx.ledgerDir);
    if (ledger === undefined) throw new Error('Terminal ledger unavailable');
    const rows = (ledger ?? []).filter((entry) => entry.data.childRunId === record.childRunId);
    const completed = (effect: string, number: number): boolean => rows.some((entry) => entry.event === 'pr-terminal-effect'
      && entry.data.effect === effect && entry.data.number === number);
    const acknowledge = (effect: string, number: number): void => {
      adapters.appendLedger({ runId: ctx.ledgerRunId, event: 'pr-terminal-effect', data: { childRunId: record.childRunId, effect, number } }, ctx.ledgerDir);
    };
    if (completed('complete', record.prNumber ?? 0) || completed('protected', record.prNumber ?? 0)) return skipped('already-recorded');
    if (!rows.some((entry) => entry.event === 'pr-terminal')) {
      adapters.appendLedger({ runId: ctx.ledgerRunId, event: 'pr-terminal', data: { ...record } }, ctx.ledgerDir);
      log('terminal-recorded');
    }
    if (record.terminalClass === 'failed-no-pr' || record.terminalClass === 'failed-pr-unobserved' || record.prNumber === null) {
      acknowledge('complete', 0);
      return skipped(record.terminalClass);
    }
    // Review r7: the record is immutable — a terminal without a parseable PR URL can never learn its repository on
    // replay. Settle it once with a distinct `unresolved-repository` effect (never a normal `complete`: no GitHub write
    // happened) so replay stops retrying it, and leave it visible as `unresolved` for a human.
    if (!record.repository) {
      if (!completed('unresolved-repository', record.prNumber)) {
        acknowledge('unresolved-repository', record.prNumber);
        log('unresolved', { reason: 'repository-unobserved', prUrl: record.prUrl });
      }
      return skipped('repository-unobserved');
    }
    if (!ctx.adapters) {
      const host = hostRepository();
      // Unknown host is recoverable — never complete it; only a confirmed different repository is foreign.
      if (host === null) return skipped('host-repository-unobserved');
      if (record.repository.toLowerCase() !== host.toLowerCase()) {
        acknowledge('complete', record.prNumber);
        return skipped('foreign-repository');
      }
    }
    step = 'get-pr';
    const pr = await adapters.getPr(record.prNumber);
    if (!pr || pr.number !== record.prNumber || !Array.isArray(pr.labels) || !pr.branch || !Number.isFinite(Date.parse(pr.createdAt))) throw new Error('PR lookup unavailable');
    // Review r8: the PR may have merged or closed after this run's terminal — a failed terminal then writes nothing
    // (no harvestable label, no owner comment) and settles once.
    if (record.terminalClass !== 'landed' && pr.state !== undefined && pr.state !== 'OPEN') {
      step = 'ledger';
      acknowledge('complete', pr.number);
      return skipped(`pr-${pr.state.toLowerCase()}`);
    }
    const protectedPr = pr.labels.some((label) => PROTECTED_LABELS.has(label));
    // Policy (review r4 · r6): a protected PR (keep · release-path · …) that is still open belongs to a human. The
    // terminal does not label, comment on, or supersede around it, and records a distinct `protected` effect — never a
    // normal `complete`. A protected PR that has LANDED is no longer pending a human: its merge makes older same-goal
    // drafts stale, so it supersedes them like any landed PR (the label protects that PR, not other runs' drafts).
    if (protectedPr && record.terminalClass !== 'landed') {
      step = 'ledger';
      acknowledge('protected', pr.number);
      return skipped('protected');
    }
    if (record.terminalClass !== 'landed') {
      if (!completed('harvestable', pr.number)) {
        if (!pr.labels.includes(harvestable)) {
          step = 'add-label';
          await adapters.addLabel(record.repository, pr.number, harvestable);
          log('harvestable-labeled');
        }
        step = 'ledger';
        acknowledge('harvestable', pr.number);
      }
      const body = `Draft residue: ${record.terminalClass} · owner=${record.owner}(${record.ownerSource}) · run=${record.childRunId} · head=${record.headSha ?? 'unobserved'}`;
      if (!completed('owner-comment', pr.number)) {
        if (!pr.comments?.includes(body)) { step = 'comment'; await adapters.comment(record.repository, pr.number, body); }
        step = 'ledger';
        acknowledge('owner-comment', pr.number);
      }
    } else skipped('landed');
    step = 'list-open-drafts';
    const drafts = await adapters.listOpenDrafts(record.repository);
    if (!drafts || !Array.isArray(drafts) || drafts.some((draft) => !Number.isSafeInteger(draft.number) || draft.number <= 0
      || !Array.isArray(draft.labels) || !draft.branch || !Number.isFinite(Date.parse(draft.createdAt)))) {
      throw new Error('Open draft lookup unavailable or incomplete');
    }
    const newerAt = Date.parse(pr.createdAt);
    const candidates = drafts.filter((draft: ResiduePr) => draft.number !== pr.number && draft.branch.startsWith('self-impl/')
      && Date.parse(draft.createdAt) < newerAt && !draft.labels.some((label: string) => PROTECTED_LABELS.has(label))
      && !completed('superseded-close', draft.number)
      && (!draft.labels.includes(superseded) || completed('supersede-intent', draft.number))
      // Only a verified goal identifier may close a PR — a shared «칸:» value or seat is not the same goal.
      && sameVerifiedGoal(draft, pr));
    let liveBranches: ReadonlySet<string> | undefined;
    if (candidates.length) {
      step = 'list-live-branches';
      liveBranches = await adapters.listLiveBranches(record.repository);
      if (!liveBranches) throw new Error('Branch liveness unavailable');
    }
    let deferred = false;
    let capped = false;
    for (const draft of candidates) {
      if (budget.remaining <= 0) { capped = true; break; }
      step = 'get-run-status';
      const status = await adapters.getRunStatus(draft, record.repository);
      if (liveBranches!.has(draft.branch) || !['completed', 'failed', 'cancelled', 'abandoned', 'self-implement.result final'].includes(status ?? '')) {
        deferred = true;
        skipped(`previous-run-${status === 'running' || status === 'probable-running' || liveBranches!.has(draft.branch) ? 'live' : 'unobserved'}`);
        continue;
      }
      if (!completed('supersede-intent', draft.number)) {
        step = 'ledger';
        acknowledge('supersede-intent', draft.number);
      }
      if (!completed('superseded-label', draft.number)) {
        if (!draft.labels.includes(superseded)) {
          step = 'set-labels';
          await adapters.setLabels(record.repository, draft.number, { add: superseded,
            remove: PR_LABELS.filter((label) => label.axis === 'state' && draft.labels.includes(label.name) && label.name !== superseded).map((label) => label.name) });
        }
        step = 'ledger';
        acknowledge('superseded-label', draft.number);
      }
      const body = `Draft residue: superseded-by #${pr.number} (newer run ${record.childRunId} of the same goal). Branch preserved.`;
      if (!completed('supersede-comment', draft.number)) {
        // REST draft listings do not contain comments; fetch them on a retry after the label was applied.
        let comments = draft.comments;
        if (comments === undefined && completed('superseded-label', draft.number)) {
          step = 'get-pr';
          const prior = await adapters.getPr(draft.number);
          if (!prior || prior.number !== draft.number) throw new Error('Previous PR lookup unavailable');
          comments = prior.comments;
        }
        if (!comments?.includes(body)) { step = 'comment'; await adapters.comment(record.repository, draft.number, body); }
        step = 'ledger';
        acknowledge('supersede-comment', draft.number);
      }
      step = 'close-pr';
      await adapters.closePr(record.repository, draft.number);
      budget.remaining--;
      step = 'ledger';
      acknowledge('superseded-close', draft.number);
      log('superseded-previous', { previousPrNumber: draft.number });
    }
    if (deferred) return skipped('previous-run-unverified');
    if (capped) return skipped('close-cap');
    step = 'ledger';
    acknowledge('complete', record.prNumber);
    return { status: 'recorded' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log('failed', { step, reason });
    return { status: 'failed', step, reason };
  }
}
