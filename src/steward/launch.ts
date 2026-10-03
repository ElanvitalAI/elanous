import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { publishInsideEvent } from '../nexus/api/inside-events.js';
import { redactSecrets } from '../task-cards/card-store.js';
import { preLaunchGate, type PreLaunchGateDecision } from '../execution-loop/launch-gate.js';
import type { BudgetDecision } from '../self-implement/budget-gate.js';
import type { ScheduledDecision, StewardSettings, TriageIssue } from './triage.js';

/** `completed` = the run finished without a merge (a non-code artifact, or nothing to deliver) — never reported as a failure. */
export type LaunchStatus = 'shadow' | 'launched' | 'skipped-budget' | 'blocked-duplicate' | 'blocked-location' | 'failed' | 'running' | 'merged' | 'completed';
export interface LaunchEntry {
  issue: string;
  title: string;
  source: string;
  command: string;
  status: LaunchStatus;
  runId?: string;
  pid?: number;
  log?: string;
  reason?: string;
  prNumber?: number;
  prUrl?: string;
  reported?: boolean;
  notified?: 'sent' | 'shadow' | 'skipped-no-origin' | 'failed';
  notifyAttempts?: number;
  notifyRecipients?: Record<string, { notified: 'sent' | 'failed'; attempts: number }>;
  notifyPreview?: { hasChatId: boolean; kind: 'file' | 'link' };
  artifactRef?: string;
  artifactBranch?: string;
  artifactWorktree?: string;
  awaitingMerge?: boolean;
}
export interface HitlEntry { issue: string; reason: string; raised: boolean; attempted?: boolean }
export interface LaunchLedger { launches: Record<string, LaunchEntry>; hitl: Record<string, HitlEntry> }
export interface LaunchItem { issue: TriageIssue; row: ScheduledDecision; command: string; source: string }
export interface LaunchPlan { launches: LaunchItem[]; hitl: Array<{ issue: TriageIssue; row: ScheduledDecision }> }
export interface LaunchDeps {
  root: string;
  settings: StewardSettings;
  ledger: LaunchLedger;
  /** Injected command boundary; the production adapter runs only argv, never a shell. */
  command?: (args: string[]) => { exitCode: number; stdout: string; stderr?: string };
  spawn?: (args: string[], log: string) => { pid: number };
  gate?: (goalId: string, budget: BudgetDecision | 'unknown') => PreLaunchGateDecision;
}

const RUN_ID = /\brun-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const DEFAULT_POOL = 'pool-node-b@node-b:8';
// `harness budget --json` outcomes: proceed | next-provider | wait-reset | stop. next-provider still runs (the harness switches provider itself).
const BUDGET_PROCEED: readonly string[] = ['proceed', 'next-provider'];
const launchMode = (settings: StewardSettings): 'off' | 'shadow' | 'live' => settings.mode ?? settings.launch ?? 'shadow';
const cli = (args: string[]) => ['bun', 'bin/elanous.mjs', ...(process.env.NODE_ENV === 'test' ? ['--test'] : []), ...args];
const sourceOf = (issue: TriageIssue): string => /^출처: (telegram|pwa|tui|cli)$/m.exec(issue.body)?.[1] ?? `linear:${issue.identifier}`;
const promptOf = (issue: TriageIssue): string => `${issue.title}\n${issue.body.slice(0, 1500)}`;
const argvFor = (issue: TriageIssue, settings: StewardSettings): string[] =>
  // Options first, then `--`: an issue title that starts with `-` must stay part of the sentence.
  cli(['harness', 'say', '--substrate', 'pod', '--pod-pool', settings.podPool ?? DEFAULT_POOL, '--base', 'main', '--json', '--', promptOf(issue)]);

export function readLaunchLedger(root: string): LaunchLedger {
  try {
    const value = JSON.parse(readFileSync(join(root, 'steward', 'launches.json'), 'utf8')) as LaunchLedger;
    if (!value || typeof value.launches !== 'object' || !value.launches || typeof value.hitl !== 'object' || !value.hitl) throw new Error('Invalid steward launch ledger');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { launches: {}, hitl: {} };
    throw error;
  }
}

export function saveLaunchLedger(root: string, ledger: LaunchLedger): void {
  const dir = join(root, 'steward');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'launches.json');
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(ledger));
  renameSync(temp, target);
}

export function planLaunches(rows: ScheduledDecision[], issues: TriageIssue[], ledger: LaunchLedger, settings: StewardSettings): LaunchPlan {
  const byId = new Map(issues.map(issue => [issue.identifier, issue]));
  const activeCount = Object.values(ledger.launches).filter(entry => !entry.awaitingMerge && (entry.status === 'launched' || entry.status === 'running')).length;
  const available = Math.max(0, (settings.maxParallel ?? 3) - activeCount);
  const launches: LaunchItem[] = [];
  const hitl: LaunchPlan['hitl'] = [];
  for (const row of rows) {
    const issue = byId.get(row.issue);
    if (!issue) continue;
    if (row.rung === 'hitl' || row.hitlReason || row.disposition === 'hitl') {
      if (launchMode(settings) !== 'off' && (!ledger.hitl[row.issue] || launchMode(settings) === 'live' && !ledger.hitl[row.issue].attempted)) hitl.push({ issue, row });
      continue;
    }
    if (launchMode(settings) === 'off' || row.disposition !== 'now' || row.rung !== 4 || (ledger.launches[row.issue] && !['skipped-budget', 'blocked-duplicate', 'blocked-location'].includes(ledger.launches[row.issue].status) && !(launchMode(settings) === 'live' && ledger.launches[row.issue].status === 'shadow')) || launches.length >= available) continue;
    const args = argvFor(issue, settings);
    launches.push({ issue, row, source: sourceOf(issue), command: args.map(arg => JSON.stringify(arg)).join(' ') });
  }
  debug.log('steward.launch', 'planned', { count: launches.length, hitl: hitl.length, available });
  return { launches, hitl };
}

function runCommand(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(args, { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function spawnDetached(args: string[], log: string): { pid: number } {
  const fd = openSync(log, 'a');
  try {
    const child = Bun.spawn(args, { cwd: resolve(import.meta.dir, '../..'), stdout: fd, stderr: fd, stdin: 'ignore', detached: true });
    child.unref();
    return { pid: child.pid };
  } finally { closeSync(fd); }
}

function lastJson(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split('\n').at(-1);
  const value: unknown = JSON.parse(line ?? '');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CLI JSON');
  return value as Record<string, unknown>;
}

/** One issue is reserved before any side effect; budget skips are retriable, never counted as a launch. */
export function launch(item: LaunchItem, deps: LaunchDeps): LaunchEntry {
  const { ledger, settings, root } = deps;
  if (item.row.rung !== 4 || item.row.hitlReason || item.row.disposition !== 'now' || (ledger.launches[item.issue.identifier] && !['skipped-budget', 'blocked-duplicate', 'blocked-location'].includes(ledger.launches[item.issue.identifier].status) && !(launchMode(settings) === 'live' && ledger.launches[item.issue.identifier].status === 'shadow'))) throw new Error('steward launch is not eligible');
  if (launchMode(settings) === 'off') throw new Error('steward launch is off');
  const key = item.issue.identifier;
  const entry: LaunchEntry = { issue: key, title: redactSecrets(item.issue.title), source: item.source, command: redactSecrets(item.command), status: 'shadow' };
  if (launchMode(settings) !== 'live') {
    ledger.launches[key] = entry;
    saveLaunchLedger(root, ledger);
    debug.log('steward.launch', 'shadow', { issue: key, command: entry.command });
    publishInsideEvent({ kind: 'steward', issue: key, status: entry.status });
    return entry;
  }
  const command = deps.command ?? runCommand;
  const blocked = (status: LaunchStatus, reason: string): LaunchEntry => {
    entry.status = status;
    entry.reason = redactSecrets(reason);
    ledger.launches[key] = entry;
    saveLaunchLedger(root, ledger);
    debug.log('steward.launch', status, { issue: key, reason: entry.reason });
    publishInsideEvent({ kind: 'steward', issue: key, status: entry.status, reason: entry.reason });
    return entry;
  };
  // L6: a launch must remain on the isolated Pod pool, never fall back to the host or another substrate.
  if (!/^[a-zA-Z0-9_-]+(?:@[a-zA-Z0-9._-]+(?::[1-9][0-9]*)?)?$/.test(settings.podPool ?? DEFAULT_POOL))
    return blocked('blocked-location', 'invalid steward pod pool');
  let budget: BudgetDecision | 'unknown' = 'unknown';
  try {
    const result = command(cli(['harness', 'budget', '--json']));
    const decision = result.exitCode === 0 ? lastJson(result.stdout) : {};
    if (!BUDGET_PROCEED.includes(String(decision.outcome)))
      return blocked('skipped-budget', result.exitCode === 0 ? JSON.stringify(decision.reasons ?? ['budget unavailable']) : result.stderr ?? 'budget unavailable');
    budget = { action: decision.outcome as 'proceed' | 'next-provider', reasons: Array.isArray(decision.reasons) ? decision.reasons.map(String) : [] };
  } catch (error) {
    return blocked('skipped-budget', String(error));
  }
  // L6: the shared gate checks active same-goal runs and the budget decision immediately before spawn.
  let gate: PreLaunchGateDecision;
  try { gate = (deps.gate ?? ((goalId, decision) => preLaunchGate({ goalId, budget: decision })))(`linear:${key}`, budget); }
  catch (error) { return blocked('blocked-duplicate', `launch gate unavailable: ${String(error)}`); }
  if (gate.action !== 'proceed' || gate.sameGoalActiveRuns === 'unknown')
    return blocked(gate.action === 'blocked-budget' || gate.action === 'wait-reset' ? 'skipped-budget' : 'blocked-duplicate', gate.sameGoalActiveRuns === 'unknown' ? 'active runs unknown' : gate.reason);
  entry.status = 'launched';
  entry.log = join(root, 'steward', 'launch', `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.log`);
  mkdirSync(join(root, 'steward', 'launch'), { recursive: true });
  ledger.launches[key] = entry;
  saveLaunchLedger(root, ledger);
  try {
    entry.pid = (deps.spawn ?? spawnDetached)(argvFor(item.issue, settings), entry.log).pid;
  } catch (error) {
    entry.status = 'failed';
    entry.reason = redactSecrets(String(error));
  }
  if (entry.pid) {
    try { entry.runId = readFileSync(entry.log, 'utf8').match(RUN_ID)?.[0]; }
    catch { /* The detached child may not have written its log yet. */ }
  }
  saveLaunchLedger(root, ledger);
  debug.log('steward.launch', 'launched', { issue: key, runId: entry.runId, pid: entry.pid, status: entry.status });
  publishInsideEvent({ kind: 'steward', issue: key, status: entry.status, ...(entry.runId ? { runId: entry.runId } : {}) });
  return entry;
}

export function raiseHitl(issue: TriageIssue, row: ScheduledDecision, deps: LaunchDeps): HitlEntry {
  const old = deps.ledger.hitl[issue.identifier];
  if (old && (old.attempted || launchMode(deps.settings) !== 'live')) return old;
  const entry: HitlEntry = old ?? { issue: issue.identifier, reason: redactSecrets(row.hitlReason ?? row.why), raised: false };
  deps.ledger.hitl[issue.identifier] = entry;
  if (launchMode(deps.settings) !== 'live') {
    saveLaunchLedger(deps.root, deps.ledger);
    return entry;
  }
  entry.attempted = true;
  saveLaunchLedger(deps.root, deps.ledger);
  try {
    const category = row.hitlReason === 'public' ? 'publish' : ['money', 'security', 'irreversible'].includes(row.hitlReason ?? '') ? row.hitlReason! : 'other';
    const title = redactSecrets(issue.title);
    const result = (deps.command ?? runCommand)(cli(['decisions', 'raise', '--title', title, '--category', category,
      '--s', title.slice(0, 240), '--c', redactSecrets(row.why).slice(0, 240), '--option', 'a=approve:execute after human decision',
      '--option', 'b=decline:do not execute', '--skip-recommend', 'human decision required', '--agent', 'steward', ...(issue.ref ? ['--ref', issue.ref] : []), '--json']));
    entry.raised = result.exitCode === 0;
  } catch { /* Command may not be installed; card remains the human handoff. */ }
  saveLaunchLedger(deps.root, deps.ledger);
  if (entry.raised) debug.log('steward.launch', 'hitl-raised', { issue: issue.identifier });
  return entry;
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function collectOutcomes(ledger: LaunchLedger, deps: LaunchDeps): LaunchEntry[] {
  if (launchMode(deps.settings) !== 'live') return [];
  const done: LaunchEntry[] = [];
  for (const entry of Object.values(ledger.launches)) {
    if (entry.reported || entry.status === 'shadow' || entry.status === 'skipped-budget' || entry.status === 'blocked-duplicate' || entry.status === 'blocked-location') continue;
    if (!entry.runId && entry.log) {
      try { entry.runId = readFileSync(entry.log, 'utf8').match(RUN_ID)?.[0]; } catch { /* Wait for log. */ }
    }
    if (entry.runId) {
      try {
        const result = (deps.command ?? runCommand)(cli(['self', 'run-ledger', entry.runId, '--json']));
        if (result.exitCode !== 0) throw new Error(result.stderr ?? 'run ledger unavailable');
        const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { event?: string; data?: Record<string, unknown> });
        if (!events.length) throw new Error('empty run ledger');
        const reversed = [...events].reverse();
        const mergedOffset = reversed.findIndex(event => event.event === 'merged' && event.data?.merged === true);
        const terminalOffset = reversed.findIndex(event => event.event === 'run-status' || event.event === 'terminal');
        const mergedIndex = mergedOffset < 0 ? -1 : events.length - 1 - mergedOffset;
        const terminalIndex = terminalOffset < 0 ? -1 : events.length - 1 - terminalOffset;
        const merged = mergedIndex >= 0 ? events[mergedIndex] : undefined;
        const terminal = terminalIndex >= 0 ? events[terminalIndex] : undefined;
        const pr = reversed.find(event => event.event === 'pr-opened');
        const artifact = reversed.find(event => event.event === 'deploy-noncode' && typeof event.data?.ref === 'string');
        entry.artifactRef = typeof artifact?.data?.ref === 'string' ? artifact.data.ref : undefined;
        entry.artifactBranch = typeof artifact?.data?.branch === 'string' ? artifact.data.branch : undefined;
        const worktree = reversed.find(event => event.event === 'planned' && typeof event.data?.worktree === 'string' && event.data.worktree);
        entry.artifactWorktree = typeof worktree?.data?.worktree === 'string' ? worktree.data.worktree : undefined;
        const number = merged?.data?.number ?? pr?.data?.number;
        const url = merged?.data?.url ?? pr?.data?.url;
        const validUrl = typeof url === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url) ? url : undefined;
        entry.prNumber = typeof number === 'number' ? number : validUrl ? Number(validUrl.split('/').at(-1)) : undefined;
        entry.prUrl = validUrl && (entry.prNumber === undefined || validUrl.endsWith(`/pull/${entry.prNumber}`)) ? validUrl : undefined;
        const failed = terminalIndex > mergedIndex && (terminal?.data?.runStatus === 'failed' || terminal?.data?.terminal === 'failed');
        entry.awaitingMerge = !failed && !merged && !artifact && !!pr && terminal?.data?.runStatus === 'completed';
        const completed = !failed && !merged && terminal?.data?.runStatus === 'completed';
        // A finished run is only «merged» when a merge event exists; finishing with an artifact or with nothing is `completed`, not a failure.
        entry.status = failed ? 'failed' : merged ? 'merged' : entry.awaitingMerge ? 'running' : completed ? 'completed' : terminal ? 'failed' : 'running';
        if (entry.status === 'failed' && !entry.reason) {
          const reason = terminal?.data?.reason ?? terminal?.data?.terminal;
          entry.reason = redactSecrets(typeof reason === 'string' ? reason : '런 실패');
        }
      } catch { if (entry.status !== 'failed') entry.status = 'running'; }
    } else if (entry.status !== 'failed') entry.status = alive(entry.pid) ? 'running' : 'failed';
    if (entry.status === 'running') continue;
    done.push(entry);
    debug.log('steward.launch', 'outcome', { issue: entry.issue, status: entry.status, runId: entry.runId, prNumber: entry.prNumber });
    publishInsideEvent({ kind: 'steward', issue: entry.issue, status: entry.status, ...(entry.runId ? { runId: entry.runId } : {}) });
  }
  saveLaunchLedger(deps.root, ledger);
  return done;
}
