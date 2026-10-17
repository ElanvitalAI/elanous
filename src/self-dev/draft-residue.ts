import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename, dirname, join } from 'node:path';
import { findGitDir } from '../git-fs/locate.js';
import { debug } from '../debug/log.js';
import { PR_LABELS } from '../github/pr-labels.js';
import { appendRunLedgerEntry, listRunLedgers, loadRunLedger, runLedgerDir, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { queryRunningRuns } from '../self-implement/running-runs.js';
import { clipRegateDetail, regateFailureFacts, type HostRegateFailure } from '../self-implement/regate-detail.js';
import { DRAFT_SWEEP_CLOSE_CAP } from './draft-sweep.js';
import { PROTECTED_LABELS, type DraftTriagePr } from './draft-triage-rules.js';

export type PodTerminalClass = 'landed' | 'merge-ready-not-merged' | 'failed-with-pr' | 'failed-no-pr' | 'failed-pr-unobserved' | 'timed-out-harvestable';
export interface PrTerminalRecord {
  childRunId: string;
  prNumber: number | null;
  prUrl: string | null;
  repository: string | null;
  headSha: string | null;
  /** Copied from disposition.branch when present; null when the child did not name a branch. */
  branch?: string | null;
  terminalClass: PodTerminalClass;
  stage: string | null;
  owner: string;
  ownerSource: 'seat' | 'card' | 'unknown';
  card: string | null;
  at: string;
  /** Which host-regate gate failed and why — null for every other terminal. */
  /** HOST-REGATE-REASON-LOST: detail keeps a bounded head ⊕ tail (4KB); pr-head · merge steps add the expected/actual
   *  head, merge-conflict adds the conflicted files, merge adds the failure kind (race · moved head · conflict · policy). */
  hostRegateFailure: (HostRegateFailure & { os: string }) | null;
}
export interface PodTerminalInput {
  childRunId: string;
  state: 'complete' | 'failed' | 'aborted';
  disposition?: { prNumber?: number | null; prUrl?: string | null; checkedHeadCommit?: string | null; stage?: string; merged?: boolean; ok?: boolean;
    branch?: string | null;
    hostRegate?: { passed: boolean; failures: HostRegateFailure[]; os: string } | null } | null;
  env?: Readonly<Record<string, string | undefined>>;
  prBody?: string;
  goalText?: string;
  at?: string;
}

function cardOf(text?: string): string | null {
  const lines = (text ?? '').split(/\r?\n/).filter((line) => line.startsWith('칸:'));
  if (lines.length !== 1) return null;
  const slot = lines[0]!.slice('칸:'.length).trim();
  // A blank marker cannot borrow an ID from the following line. Duplicate markers are
  // ambiguous even when they happen to name the same card.
  return slot && !/\s/.test(slot) ? slot : null;
}
const validCardSlot = (text: string | null): text is string => !!text && /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(text);
const goalLineage = (pr: ResiduePr): string | undefined =>
  /(?:^|[-/])goalid-([a-f0-9]+)(?=-|\/|$)/i.exec(pr.branch)?.[1]?.toLowerCase()
  ?? /^골(?: ID)?:\s*(\S.*?)\s*$/m.exec(pr.body ?? '')?.[1];
const hasCodeDiff = (paths: readonly string[]): boolean => paths.some((path) =>
  !path.startsWith('docs/') && (
    /\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|rs|go|c|cc|cpp|h|hpp|java|kt|swift|rb|php|lua|sql)$/.test(path)
    || /(?:^|\/)(?:Dockerfile|Containerfile|Makefile)(?:\.[^/]*)?$/.test(path)
    || (path.startsWith('graphs/') && /\.ya?ml$/.test(path))));
function sameCardSlot(previous: ResiduePr, current: ResiduePr, slot: string): boolean {
  return cardOf(previous.body) === slot && cardOf(current.body) === slot;
}
const harvestable = PR_LABELS.find((label) => label.name === 'elanous:harvestable')!.name;
const superseded = PR_LABELS.find((label) => label.name === 'elanous:superseded')!.name;

export function classifyPodTerminal(input: PodTerminalInput): PrTerminalRecord {
  const d = input.disposition;
  const prNumber = Number.isSafeInteger(d?.prNumber) && (d?.prNumber ?? 0) > 0 ? d!.prNumber! : null;
  const prUrl = typeof d?.prUrl === 'string' ? d.prUrl : null;
  const match = prUrl && /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/.exec(prUrl);
  const repository = match && Number(match[3]) === prNumber ? `${match[1]}/${match[2]}` : null;
  const branch = typeof d?.branch === 'string' && d.branch.trim() ? d.branch.trim() : null;
  const card = cardOf(input.prBody) ?? cardOf(input.goalText);
  const seat = input.env?.ELANOUS_HARNESS_SEAT;
  const ownerSource = seat === 'OP' || seat === 'TC' || seat === 'MK' || seat === 'UX' ? 'seat' : card ? 'card' : 'unknown';
  const hostRegate = d?.hostRegate;
  const firstFailure = hostRegate?.passed === false && Array.isArray(hostRegate.failures) ? hostRegate.failures[0] : undefined;
  const hostRegateFailure = d?.stage === 'host-regate-failed' && hostRegate?.passed === false
    ? { step: typeof firstFailure?.step === 'string' && firstFailure.step ? firstFailure.step : 'unknown',
      detail: typeof firstFailure?.detail === 'string' && firstFailure.detail
        ? clipRegateDetail(firstFailure.detail.split(/\s+/).filter(Boolean).join(' '))
        : 'failures empty',
      ...regateFailureFacts(firstFailure),
      os: hostRegate.os }
    : null;
  return {
    childRunId: input.childRunId, prNumber, prUrl, repository, branch,
    headSha: typeof d?.checkedHeadCommit === 'string' && /^[a-f0-9]{40}$/i.test(d.checkedHeadCommit) ? d.checkedHeadCommit : null,
    terminalClass: !d ? 'failed-pr-unobserved' : d.merged === true ? 'landed'
      : prNumber === null && d.stage === 'timed-out' && branch ? 'timed-out-harvestable'
      : prNumber === null ? 'failed-no-pr'
        : input.state === 'complete' && d.ok !== false ? 'merge-ready-not-merged' : 'failed-with-pr',
    stage: d?.stage ?? null, hostRegateFailure,
    owner: ownerSource === 'seat' ? seat! : ownerSource === 'card' ? card! : 'unknown',
    ownerSource, card, at: input.at ?? new Date().toISOString(),
  };
}

export interface ResiduePr extends DraftTriagePr {
  createdAt: string;
  labels: readonly string[];
  headSha?: string;
  isDraft?: boolean;
  body?: string;
  comments?: readonly string[];
  /** GitHub PR state at lookup time (review r8) — absent only from injected inventories. */
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
}
export interface DraftResidueAdapters {
  loadLedger(runId: string, ledgerDir: string): readonly RunLedgerEntry[] | null;
  appendLedger(entry: RunLedgerEntry, ledgerDir: string): void;
  getPr(number: number): Promise<ResiduePr | undefined> | ResiduePr | undefined;
  /** Return all issue comments only after pagination completes; undefined means completeness is unknown. */
  getAllComments?(repository: string, number: number): Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** Undefined means the open-draft inventory could not be observed («못 셌음») — never a disguised zero count. */
  listOpenDrafts(repository: string): Promise<readonly ResiduePr[] | undefined> | readonly ResiduePr[] | undefined;
  /** Complete changed-path inventory for the newly opened PR; undefined is unmeasured. */
  listPrChangedPaths?(repository: string, number: number): Promise<readonly string[] | undefined> | readonly string[] | undefined;
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

/** A REST pulls page carries up to 100 full PR bodies; the spawn default buffer (1 MiB) overflowed daily as
 *  `spawnSync gh ENOBUFS`, so every gh call gets an explicit ceiling that fits a full page of large-bodied drafts. */
const GH_MAX_BUFFER = 64 * 1024 * 1024;
/** Only the fields the residue consumes. The raw REST page (base/head repo objects, _links, review metadata, …) is
 *  several times larger than this projection, so the listing asks gh to project each page down to these fields. */
const OPEN_DRAFT_FIELDS = '[.[] | {number, title, headRefName: .head.ref, createdAt: .created_at, body, labels: [.labels[] | {name}], draft}]';

function gh(args: string[]): string {
  const result = spawnSync('gh', args, { cwd: findGitDir(process.cwd())?.root ?? process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: GH_MAX_BUFFER });
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || `gh exited ${result.status}`).trim().slice(0, 200));
  return result.stdout.trim();
}
function ghPr(row: { number: number; title: string; headRefName: string; headRefOid?: string; isDraft?: boolean; createdAt: string; body: string; labels: Array<{ name: string }>; comments?: Array<{ body: string }>; state?: string }): ResiduePr {
  const state = row.state === 'OPEN' || row.state === 'CLOSED' || row.state === 'MERGED' ? row.state : undefined;
  return { number: row.number, title: row.title, branch: row.headRefName, headSha: row.headRefOid, isDraft: row.isDraft, createdAt: row.createdAt, body: row.body,
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
  const fields = 'number,title,headRefName,headRefOid,isDraft,createdAt,body,labels,comments,state';
  return {
    loadLedger: loadRunLedger,
    appendLedger: appendRunLedgerEntry,
    getPr: (number) => ghPr(JSON.parse(gh(['pr', 'view', String(number), '-R', hostRepository() ?? '', '--json', fields]))),
    getAllComments: (repository, number) => {
      try {
        const pages: unknown = JSON.parse(gh(['api', `repos/${repository}/issues/${number}/comments?per_page=100`, '--paginate', '--slurp']));
        if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page)
          && page.every((row: unknown) => !!row && typeof row === 'object' && typeof (row as { body?: unknown }).body === 'string'))) return undefined;
        return (pages as Array<Array<{ body: string }>>).flat().map((row) => row.body);
      } catch (error) {
        debug.log('draft.residue', 'comments-unobserved', { repository, number, reason: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
    },
    listOpenDrafts: (repository) => {
      const rows: ResiduePr[] = [];
      try {
        for (let page = 1; page <= 100; page++) {
          const result = JSON.parse(gh(['api', `repos/${repository}/pulls?state=open&per_page=100&page=${page}`, '--jq', OPEN_DRAFT_FIELDS])) as Array<{
            number: number; title: string; headRefName: string; createdAt: string; body: string;
            labels: Array<{ name: string }>; draft: boolean;
          }>;
          if (!Array.isArray(result)) throw new Error('Invalid open PR inventory');
          rows.push(...result.filter((pr) => pr.draft).map((pr) => ghPr({ number: pr.number, title: pr.title, headRefName: pr.headRefName, createdAt: pr.createdAt, body: pr.body, labels: pr.labels })));
          if (result.length < 100) return rows;
        }
        throw new Error('Open PR inventory exceeded pagination limit');
      } catch (error) {
        // «못 셌음»: a failed (or truncated) listing is unmeasurable — it must never surface as a counted zero.
        debug.log('draft.residue', 'list-open-drafts-unobserved', { repository, reason: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
    },
    listPrChangedPaths: (repository, number) => {
      try {
        const pages: unknown = JSON.parse(gh(['api', `repos/${repository}/pulls/${number}/files?per_page=100`, '--paginate', '--slurp']));
        if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page)
          && page.every((row: unknown) => !!row && typeof row === 'object' && typeof (row as { filename?: unknown }).filename === 'string'))) return undefined;
        return (pages as Array<Array<{ filename: string }>>).flat().map((row) => row.filename);
      } catch { return undefined; }
    },
    addLabel: (repository, number, label) => { gh(['pr', 'edit', String(number), '-R', repository, '--add-label', label]); },
    setLabels: (repository, number, change) => {
      const flags = [...(change.add ? ['--add-label', change.add] : []), ...change.remove.flatMap((label) => ['--remove-label', label])];
      if (flags.length) gh(['pr', 'edit', String(number), '-R', repository, ...flags]);
    },
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
          || !['landed', 'merge-ready-not-merged', 'failed-with-pr', 'failed-no-pr', 'failed-pr-unobserved', 'timed-out-harvestable'].includes(record.terminalClass)
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
      else if (outcome.status === 'skipped' && !['previous-run-unverified', 'previous-run-live', 'close-cap', 'host-repository-unobserved', 'restore-unverified'].includes(outcome.reason ?? '')) recovered++;
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
  let pendingSupersession: { repository: string; number: number; prNumber: number; commentMayExist: boolean } | null = null;
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
    // AUT-TIMEOUT-NO-HARVEST 첫 조각은 «분류만» — 그 branch 로 PR 을 여는 효과는 다음 조각(원격 가지 존재·기존 PR 확인 관문과 함께).
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
      // PR1a records a recovery pointer but never closes this failed draft. PR1b owns the close decision.
      if (record.terminalClass === 'failed-with-pr' && !completed('restore-comment', pr.number)) {
        step = 'get-pr';
        let latest: ResiduePr | undefined;
        try { latest = await adapters.getPr(pr.number); }
        catch { return skipped('restore-unverified'); }
        if (!latest || latest.state !== 'OPEN' || latest.isDraft !== true || !record.headSha
          || latest.headSha?.toLowerCase() !== record.headSha.toLowerCase()
          || !latest.branch?.trim() || latest.branch !== pr.branch || (record.branch && latest.branch !== record.branch)
          || !Array.isArray(latest.labels) || latest.labels.some((label) => PROTECTED_LABELS.has(label))) {
          return skipped('restore-unverified');
        }
        step = 'list-comments';
        let comments: readonly string[] | undefined;
        try { comments = await adapters.getAllComments?.(record.repository, pr.number); }
        catch { return skipped('restore-unverified'); }
        if (!Array.isArray(comments) || comments.some((comment) => typeof comment !== 'string'
          || /landing-verified\s*:|land-enqueue\s*:/i.test(comment))) return skipped('restore-unverified');
        const restore = `Draft residue: failed-run recovery · run=${record.childRunId} · head=${record.headSha} · branch=${latest.branch} preserved. Restore from this branch.`;
        if (!comments.includes(restore)) { step = 'comment'; await adapters.comment(record.repository, pr.number, restore); }
        step = 'ledger'; acknowledge('restore-comment', pr.number);
      }
    } else skipped('landed');
    step = 'list-open-drafts';
    const drafts = await adapters.listOpenDrafts(record.repository);
    if (!drafts || !Array.isArray(drafts) || drafts.some((draft) => !Number.isSafeInteger(draft.number) || draft.number <= 0
      || !Array.isArray(draft.labels) || !draft.branch || !Number.isFinite(Date.parse(draft.createdAt)))) {
      throw new Error('Open draft lookup unavailable or incomplete');
    }
    const newerAt = Date.parse(pr.createdAt);
    const slot = cardOf(pr.body);
    const taSlot = validCardSlot(slot) ? slot : undefined;
    const earlier: ResiduePr[] = drafts.filter((draft: ResiduePr) => draft.number !== pr.number && draft.branch.startsWith('self-impl/')
      && Date.parse(draft.createdAt) < newerAt && !draft.labels.some((label: string) => PROTECTED_LABELS.has(label))
      && !completed('superseded-close', draft.number));
    const sameSlot = taSlot ? earlier.filter((draft) => /^[a-f0-9]{40}$/i.test(draft.headSha ?? '') && sameCardSlot(draft, pr, taSlot)
      && !draft.labels.some((label) => label === 'elanous:running' || label.includes('harvest-claimed'))) : [];
    let codeDiff = false;
    if (taSlot && sameSlot.length) {
      // A changed PR head can turn a measured code PR into a goal-only PR while files are being fetched.
      step = 'get-pr';
      const beforeFiles = await adapters.getPr(pr.number);
      if (!beforeFiles || beforeFiles.number !== pr.number || beforeFiles.state !== pr.state
        || !pr.headSha || beforeFiles.headSha !== pr.headSha || beforeFiles.branch !== pr.branch
        || !sameCardSlot(beforeFiles, pr, taSlot)) return skipped('new-pr-changed-before-files');
      step = 'list-pr-changed-paths';
      const paths = await adapters.listPrChangedPaths?.(record.repository, pr.number);
      if (!paths || !Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) return skipped('new-pr-code-diff-unobserved');
      step = 'get-pr';
      const afterFiles = await adapters.getPr(pr.number);
      if (!afterFiles || afterFiles.number !== pr.number || afterFiles.state !== pr.state
        || afterFiles.headSha !== pr.headSha || afterFiles.branch !== pr.branch
        || !sameCardSlot(afterFiles, pr, taSlot)) return skipped('new-pr-changed-after-files');
      codeDiff = hasCodeDiff(paths);
      if (!codeDiff) log('skipped', { reason: 'new-pr-goal-only', prNumber: pr.number });
    }
    const candidates = codeDiff ? sameSlot : [];
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
      if (taSlot) {
        step = 'get-pr';
        const latest = await adapters.getPr(draft.number);
        if (!latest || latest.number !== draft.number || latest.state !== 'OPEN' || latest.isDraft !== true
          || !draft.headSha
          || latest.branch !== draft.branch || latest.headSha !== draft.headSha
          || !Array.isArray(latest.labels) || latest.labels.some((label) => PROTECTED_LABELS.has(label)
            || label === 'elanous:running' || label.includes('harvest-claimed'))
          || !sameCardSlot(latest, pr, taSlot)) { deferred = true; skipped('previous-pr-changed'); continue; }
      }
      step = 'get-run-status';
      const status = await adapters.getRunStatus(draft, record.repository);
      if (liveBranches!.has(draft.branch) || !['completed', 'failed', 'cancelled', 'abandoned', 'self-implement.result final'].includes(status ?? '')) {
        deferred = true;
        skipped(`previous-run-${status === 'running' || status === 'probable-running' || liveBranches!.has(draft.branch) ? 'live' : 'unobserved'}`);
        continue;
      }
      if (taSlot) {
        step = 'list-live-branches';
        const liveNow = await adapters.listLiveBranches(record.repository);
        step = 'get-run-status';
        const statusNow = await adapters.getRunStatus(draft, record.repository);
        if (!liveNow || liveNow.has(draft.branch)
          || !['completed', 'failed', 'cancelled', 'abandoned', 'self-implement.result final'].includes(statusNow ?? '')) {
          deferred = true; skipped('previous-run-changed-before-label'); continue;
        }
      }
      // Revalidate the effective diff and both PRs before applying any public supersession marker.
      if (taSlot) {
        const newBeforeClose = await adapters.getPr(pr.number);
        if (!newBeforeClose || newBeforeClose.number !== pr.number || newBeforeClose.state !== pr.state
          || newBeforeClose.headSha !== pr.headSha || newBeforeClose.branch !== pr.branch
          || !sameCardSlot(newBeforeClose, pr, taSlot)) { deferred = true; skipped('new-pr-changed-before-close'); continue; }
        // The base can move without changing this PR's head. Re-read the effective diff before closing the old draft.
        step = 'list-pr-changed-paths';
        const currentPaths = await adapters.listPrChangedPaths?.(record.repository, pr.number);
        if (!currentPaths || !Array.isArray(currentPaths) || currentPaths.some((path) => typeof path !== 'string')
          || !hasCodeDiff(currentPaths)) { deferred = true; skipped('new-pr-code-diff-changed-before-close'); continue; }
        step = 'get-pr';
        const afterCloseDiff = await adapters.getPr(pr.number);
        if (!afterCloseDiff || afterCloseDiff.number !== pr.number || afterCloseDiff.state !== pr.state
          || afterCloseDiff.headSha !== pr.headSha || afterCloseDiff.branch !== pr.branch
          || !sameCardSlot(afterCloseDiff, pr, taSlot)) { deferred = true; skipped('new-pr-changed-after-close-diff'); continue; }
        const beforeClose = await adapters.getPr(draft.number);
        if (!beforeClose || beforeClose.number !== draft.number || beforeClose.state !== 'OPEN' || beforeClose.isDraft !== true
          || !draft.headSha
          || beforeClose.branch !== draft.branch || beforeClose.headSha !== draft.headSha
          || !Array.isArray(beforeClose.labels) || beforeClose.labels.some((label) => PROTECTED_LABELS.has(label)
            || label === 'elanous:running' || label.includes('harvest-claimed'))
          || !sameCardSlot(beforeClose, pr, taSlot)) { deferred = true; skipped('previous-pr-changed-before-close'); continue; }
        step = 'list-live-branches';
        const liveBeforeClose = await adapters.listLiveBranches(record.repository);
        step = 'get-run-status';
        const statusBeforeClose = await adapters.getRunStatus(draft, record.repository);
        if (!liveBeforeClose || liveBeforeClose.has(draft.branch)
          || !['completed', 'failed', 'cancelled', 'abandoned', 'self-implement.result final'].includes(statusBeforeClose ?? '')) {
          deferred = true; skipped('previous-run-changed-before-close'); continue;
        }
      }
      if (!completed('supersede-intent', draft.number)) {
        step = 'ledger';
        acknowledge('supersede-intent', draft.number);
      }
      // The inventory was read before the liveness and diff checks. Labels can change while
      // those checks run, so ownership and the state to restore come from a fresh PR read.
      step = 'get-pr';
      const beforeLabel = await adapters.getPr(draft.number);
      if (!beforeLabel || beforeLabel.number !== draft.number || beforeLabel.state !== 'OPEN'
        || beforeLabel.isDraft !== true || beforeLabel.branch !== draft.branch
        || beforeLabel.headSha !== draft.headSha || !Array.isArray(beforeLabel.labels)
        || beforeLabel.labels.some((label) => PROTECTED_LABELS.has(label)
          || label === 'elanous:running' || label.includes('harvest-claimed'))
        || (taSlot && !sameCardSlot(beforeLabel, pr, taSlot))) {
        deferred = true; skipped('previous-pr-changed-before-label-write'); continue;
      }
      // There is no conditional GitHub add-label operation. A label written before close
      // cannot be safely removed on a race: another run may have added that same label
      // between our read and write. Apply the public state marker only after close succeeds.
      pendingSupersession = { repository: record.repository, number: draft.number, prNumber: pr.number,
        commentMayExist: false };
      const body = taSlot
        ? `Draft residue: superseded-by #${pr.number} (same card ${taSlot}; old goalid=${goalLineage(draft) ?? 'unobserved'}; new goalid=${goalLineage(pr) ?? 'unobserved'}; newer run ${record.childRunId}). Branch preserved.`
        : `Draft residue: superseded-by #${pr.number} (newer run ${record.childRunId} of the same goal). Branch preserved.`;
      pendingSupersession.commentMayExist = completed('supersede-comment', draft.number);
      if (!completed('supersede-comment', draft.number)) {
        // REST draft listings do not contain comments; fetch them before deciding whether to comment.
        let comments = draft.comments;
        if (comments === undefined) {
          step = 'get-pr';
          const prior = await adapters.getPr(draft.number);
          if (!prior || prior.number !== draft.number) throw new Error('Previous PR lookup unavailable');
          comments = prior.comments;
        }
        if (!comments?.includes(body)) {
          pendingSupersession.commentMayExist = true;
          step = 'comment'; await adapters.comment(record.repository, draft.number, body);
        }
        step = 'ledger';
        acknowledge('supersede-comment', draft.number);
      }
      if (taSlot) {
        // A claimant or new commit can arrive while GitHub accepts the label/comment writes.
        step = 'list-pr-changed-paths';
        const pathsAfterEffects = await adapters.listPrChangedPaths?.(record.repository, pr.number);
        // The diff lookup can race a new head; bind its result to the head read after it.
        step = 'get-pr';
        const newAfterEffects = await adapters.getPr(pr.number);
        step = 'list-live-branches';
        const liveAfterEffects = await adapters.listLiveBranches(record.repository);
        step = 'get-run-status';
        const statusAfterEffects = await adapters.getRunStatus(draft, record.repository);
        step = 'get-pr';
        const oldAfterEffects = await adapters.getPr(draft.number);
        if (!newAfterEffects || newAfterEffects.number !== pr.number || newAfterEffects.state !== pr.state
          || newAfterEffects.headSha !== pr.headSha || newAfterEffects.branch !== pr.branch
          || !sameCardSlot(newAfterEffects, pr, taSlot)
          || !pathsAfterEffects || !Array.isArray(pathsAfterEffects)
          || pathsAfterEffects.some((path) => typeof path !== 'string') || !hasCodeDiff(pathsAfterEffects)
          || !oldAfterEffects || oldAfterEffects.number !== draft.number || oldAfterEffects.state !== 'OPEN'
          || oldAfterEffects.isDraft !== true || oldAfterEffects.headSha !== draft.headSha
          || oldAfterEffects.branch !== draft.branch || !Array.isArray(oldAfterEffects.labels)
          || oldAfterEffects.labels.some((label) => PROTECTED_LABELS.has(label)
            || label === 'elanous:running' || label.includes('harvest-claimed'))
          || !sameCardSlot(oldAfterEffects, pr, taSlot)
          || !liveAfterEffects || liveAfterEffects.has(draft.branch)
          || !['completed', 'failed', 'cancelled', 'abandoned', 'self-implement.result final'].includes(statusAfterEffects ?? '')) {
          const correction = `Draft residue: supersession by #${pr.number} deferred after PR or run changed; branch preserved. Prior superseded-by comment is no longer a close decision.`;
          if (!oldAfterEffects?.comments?.includes(correction)) {
            step = 'comment';
            await adapters.comment(record.repository, draft.number, correction);
          }
          pendingSupersession = null;
          deferred = true; skipped('supersession-changed-after-effects'); continue;
        }
      }
      step = 'close-pr';
      await adapters.closePr(record.repository, draft.number);
      pendingSupersession = null;
      budget.remaining--;
      step = 'ledger';
      acknowledge('superseded-close', draft.number);
      // The close is irreversible. Label failure is diagnostic, never a reason to retry
      // supersession or to roll back a label whose writer cannot be identified.
      if (!beforeLabel.labels.includes(superseded)) {
        try {
          step = 'set-labels';
          // A state label read before close may have been written by another run
          // before this call. Its writer is unknown, so only add our marker.
          await adapters.setLabels(record.repository, draft.number, { add: superseded, remove: [] });
          step = 'ledger';
          if (!completed('superseded-label', draft.number)) acknowledge('superseded-label', draft.number);
        } catch (labelError) {
          log('superseded-label-unobserved', { previousPrNumber: draft.number,
            reason: labelError instanceof Error ? labelError.message : String(labelError) });
        }
      }
      log('superseded-previous', { previousPrNumber: draft.number });
    }
    if (deferred) return skipped('previous-run-unverified');
    if (capped) return skipped('close-cap');
    step = 'ledger';
    acknowledge('complete', record.prNumber);
    return { status: 'recorded' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (pendingSupersession) {
      const pending = pendingSupersession;
      try {
        if (pending.commentMayExist) await adapters.comment(pending.repository, pending.number,
          `Draft residue: supersession by #${pending.prNumber} deferred after an interrupted check; branch preserved. Prior superseded-by comment is no longer a close decision.`);
        log('supersession-compensated', { previousPrNumber: pending.number, failedStep: step });
      } catch (compensationError) {
        log('supersession-compensation-failed', { previousPrNumber: pending.number,
          reason: compensationError instanceof Error ? compensationError.message : String(compensationError) });
      }
    }
    log('failed', { step, reason });
    return { status: 'failed', step, reason };
  }
}
