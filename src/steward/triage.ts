import { closeSync, existsSync, openSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fetchLinearIssues } from '../connectors/linear.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { getUserConfig } from '../user-config.js';
import { emitDecision } from '../live/detail-switch.js';
import { debug, redactSecretText } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { redactSecrets } from '../task-cards/card-store.js';
import { directiveHash } from './directive.js';
import { recordTriageOnCards, type StewardCardDeps } from './steward-cards.js';
import { triageWithinBudget } from './triage-budget.js';
import { askSteward, classifyIssue, planIssues, ruleJudgment, unsafeReason, type ClassifiedIssue, type StewardAsk } from './triage-plan.js';
import { failureAlertText, markStageStart, markStageEnd, readFailureStreak, shouldAlert, writeFailureStreak, type FailureStreak, type StewardStage } from './failure-streak.js';

export type Rung = 0 | 1 | 2 | 3 | 4 | 5 | 'hitl';
/** `other` = the judge chose human review for a reason outside the four named ones (kept as HITL, never downgraded). */
export type HitlReason = 'money' | 'public' | 'security' | 'irreversible' | 'other';
export interface TriageIssue { identifier: string; ref: string; title: string; body: string }
export interface TriageDecision {
  issue: string; rung: Rung; dependsOn: string[]; priority: number; duplicateOf?: string;
  hitlReason?: HitlReason; why: string; role?: string; cost?: number;
  /** Owner track from `loops.steward.tracks` (absent when no table is configured or the judge picked none of its keys). */
  owner?: string;
  /** Carried from a previous triage without a current judgment; scheduling must not route it. */
  deferred?: true;
}
export interface ScheduledDecision extends TriageDecision { disposition: 'now' | 'wait' | 'hitl' }
export interface StewardSettings {
  mode?: 'observe' | 'act'; linearTeam?: string;
  roles?: Record<string, { maxConcurrent?: number }>;
  budget?: number;
  tracks?: Record<string, string>;
  alertAfterFailures?: number;
}
export interface StewardDeps {
  fetch?: typeof fetch;
  getSecret?: (id: string) => Promise<string | undefined>;
  judge?: (issue: TriageIssue, issues: TriageIssue[], tracks?: Record<string, string>) => Promise<unknown>;
  decide?: typeof emitDecision;
  sendDigest?: (text: string) => Promise<void>;
  now?: () => Date;
  root?: string;
  cardStore?: StewardCardDeps['store'];
  warn?: (message: string) => void;
  ask?: StewardAsk;
  /** Internal command boundary: the current sync has already claimed this pid. */
  stageOwnedByCommand?: boolean;
}

export function stewardSettings(): StewardSettings {
  return getUserConfig().loops?.steward ?? {};
}


function parseJudgment(issue: TriageIssue, raw: unknown, tracks?: Record<string, string>): TriageDecision {
  const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid triage judgment: ${issue.identifier}`);
  const d = value as Record<string, unknown>;
  if (![0, 1, 2, 3, 4, 5, 'hitl'].includes(d.rung as Rung) ||
      !Array.isArray(d.dependsOn) || !d.dependsOn.every(v => typeof v === 'string') ||
      typeof d.priority !== 'number' || !Number.isFinite(d.priority) || typeof d.why !== 'string' || !d.why.trim()) {
    throw new Error(`Invalid triage judgment: ${issue.identifier}`);
  }
  const forced = unsafeReason(issue);
  const named = forced ?? (['money', 'public', 'security', 'irreversible'].includes(d.hitlReason as string) ? d.hitlReason as HitlReason : undefined);
  // A HITL judgment without one of the four named reasons stays HITL (`other`) — one issue must not stop the stage.
  const hitlReason = named ?? (d.rung === 'hitl' ? 'other' as const : undefined);
  return {
    issue: issue.identifier, rung: hitlReason ? 'hitl' : d.rung as Rung,
    dependsOn: d.dependsOn as string[], priority: d.priority as number,
    ...(typeof d.duplicateOf === 'string' ? { duplicateOf: d.duplicateOf } : {}),
    ...(hitlReason ? { hitlReason } : {}), why: (d.why as string).trim().replace(/\s+/g, ' '),
    ...(typeof d.role === 'string' ? { role: d.role } : {}),
    ...(typeof d.cost === 'number' && Number.isFinite(d.cost) && d.cost >= 0 ? { cost: d.cost } : {}),
    ...(tracks && typeof d.owner === 'string' && Object.hasOwn(tracks, d.owner) ? { owner: d.owner } : {}),
  };
}

/** The role table as prompt lines — read from config so a reorg edits one place. */
export function trackTablePrompt(tracks?: Record<string, string>): string {
  if (!tracks || !Object.keys(tracks).length) return '';
  const keys = Object.keys(tracks);
  return `\n담당 트랙(owner) — 아래 중 하나(${keys.map(k => JSON.stringify(k)).join('|')}) · 이슈가 어느 트랙 일인지:\n${keys.map(k => `- ${k}: ${tracks[k]}`).join('\n')}`;
}

export async function triageIssues(issues: TriageIssue[], judge?: NonNullable<StewardDeps['judge']>, decide: typeof emitDecision = emitDecision, tracks?: Record<string, string>, previous: Array<TriageDecision & { inputHash?: string }> = [], ask: StewardAsk = askSteward): Promise<TriageDecision[]> {
  const started = judge ? 0 : Date.now();
  const classified: ClassifiedIssue[] = [];
  const classifiedIds = new Set<string>();
  const counts = { rule: 0, classify: 0, planning: 0 };
  const signal = (result: TriageDecision): void => {
    decide({ kind: result.rung === 'hitl' ? 'ESCALATE' : 'ROUTE', what: result.issue, reason: result.why,
      purpose: 'steward triage', target: result.owner ? `${result.rung} · ${result.owner}` : String(result.rung), refs: { issue: result.issue } });
  };
  const { decisions } = await triageWithinBudget({ issues, previous, tracks, judge: async (issue, observedIssues) => {
    try {
      if (judge) return parseJudgment(issue, await judge(issue, observedIssues ?? issues, tracks), tracks);
      const byRule = ruleJudgment(issue, observedIssues ?? issues);
      if (byRule) { counts.rule++; return { ...byRule, dependsOn: [], priority: 0 }; }
      counts.classify++;
      const row = await classifyIssue(issue, ask);
      return { ...row, dependsOn: [], priority: 0 };
    } catch (error) {
      try { debug.log('steward.stage', 'judgment-invalid', { issue: issue.identifier, reason: redactSecrets(String(error)) }); } catch { /* fail-soft */ }
      return { issue: issue.identifier, rung: 'hitl', hitlReason: 'other', dependsOn: [], priority: 0, why: 'triage judgment unavailable — human review' };
    }
  }, onJudged: result => {
    if (!judge && !result.deferred && !result.duplicateOf &&
        result.why !== 'triage judgment unavailable — human review' &&
        result.why !== 'triage judgment timed out — human review' &&
        result.why !== 'triage deferred — deadline') {
      classified.push({ issue: result.issue, rung: result.rung, why: result.why,
        ...(result.hitlReason ? { hitlReason: result.hitlReason } : {}) });
      classifiedIds.add(result.issue);
    } else signal(result);
  } });
  const planningBatch = classified.slice();
  if (!judge && planningBatch.length) {
    const remaining = 240_000 - (Date.now() - started);
    try {
      if (remaining <= 0) throw new Error('planning deadline');
      counts.planning++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let plans;
      try {
        plans = await Promise.race([planIssues(planningBatch, ask, tracks, issues), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('planning deadline')), remaining);
        })]);
      } finally { if (timer) clearTimeout(timer); }
      const byIssue = new Map(plans.map(plan => [plan.issue, plan]));
      for (const row of decisions) {
        const plan = byIssue.get(row.issue);
        if (plan && !row.deferred) {
          row.priority = plan.priority;
          row.dependsOn = plan.dependsOn;
          if (plan.owner) row.owner = plan.owner;
        }
      }
    } catch (error) {
      debug.log('steward.stage', 'planning-invalid', { reason: redactSecrets(String(error)) });
      for (const row of decisions) if (classifiedIds.has(row.issue) && !row.deferred && !row.duplicateOf) {
        row.rung = 'hitl'; row.hitlReason = 'other'; row.why = 'triage judgment unavailable — human review';
      }
    }
    for (const row of decisions) if (classifiedIds.has(row.issue) && !row.deferred) signal(row);
  }
  debug.log('steward.triage', 'llm-calls', counts);
  return decisions;
}

/** Stable priority-ordered topological schedule; missing/cyclic dependencies wait, never auto-approve. */
export function scheduleTriage(decisions: TriageDecision[], settings: StewardSettings = {}, running: Record<string, number> = {}, completed: ReadonlySet<string> = new Set()): ScheduledDecision[] {
  const byId = new Map(decisions.map(d => [d.issue, d]));
  if (byId.size !== decisions.length) throw new Error('Duplicate issue identifier');
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: TriageDecision[] = [];
  const visit = (item: TriageDecision): void => {
    if (visited.has(item.issue) || visiting.has(item.issue)) return;
    visiting.add(item.issue);
    for (const dep of item.dependsOn) { const upstream = byId.get(dep); if (upstream) visit(upstream); }
    visiting.delete(item.issue); visited.add(item.issue); sorted.push(item);
  };
  for (const item of [...decisions].sort((a, b) => a.priority - b.priority || a.issue.localeCompare(b.issue))) visit(item);
  const slots = { ...running };
  let remaining = settings.budget ?? Infinity;
  return sorted.map(item => {
    const role = item.owner ?? item.role ?? String(item.rung);
    const max = settings.roles?.[role]?.maxConcurrent ?? Infinity;
    const blocked = item.dependsOn.some(dep => !completed.has(dep));
    const status: ScheduledDecision['disposition'] = item.deferred || item.rung === 'hitl' || item.hitlReason ? 'hitl' :
      item.rung === 0 || item.duplicateOf || blocked || (slots[role] ?? 0) >= max || (item.cost ?? 0) > remaining ? 'wait' : 'now';
    if (status === 'now') { slots[role] = (slots[role] ?? 0) + 1; remaining -= item.cost ?? 0; }
    return { ...item, disposition: status };
  });
}

async function linear<T>(key: string, query: string, variables: Record<string, unknown>, fetchFn: typeof fetch): Promise<T> {
  let response: Response;
  try { response = await fetchFn('https://api.linear.app/graphql', { method: 'POST', headers: { Authorization: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) }); }
  catch { throw new Error('Linear GraphQL request failed'); }
  if (!response.ok) throw new Error(`Linear GraphQL HTTP ${response.status}`);
  let body: { data?: T; errors?: unknown[] };
  try { body = await response.json() as typeof body; }
  catch { throw new Error('Linear GraphQL invalid JSON response'); }
  if (body.errors?.length || !body.data) throw new Error('Linear GraphQL returned errors or missing data');
  return body.data;
}

function graphRunId(): string | undefined {
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path) return undefined;
  try {
    const context = JSON.parse(readFileSync(path, 'utf8')) as { graphId?: string; runId?: string };
    return context.graphId === 'steward' && /^[a-zA-Z0-9._-]+$/.test(context.runId ?? '') ? context.runId : undefined;
  } catch { return undefined; }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function skippedPath(root: string): string {
  // A graph run has a stable id across command nodes. Without a graph context,
  // keep the skip until the next sync: stage subprocess parents may differ.
  const runId = graphRunId();
  return join(root, 'steward', runId ? `skipped-${runId}.json` : 'skipped-no-context.json');
}

function currentOpen(root: string, stage: StewardStage): FailureStreak['open'] & { pid?: number; runId?: string } {
  const open = readFailureStreak(root).open;
  return open ?? { stage, startedAt: new Date().toISOString() };
}

function skipOverlappingRun(root: string, open: FailureStreak['open'] & { pid?: number; runId?: string }): void {
  // The skip marker is shared by every stage of one graph run. A loser inside the SAME run must not write it,
  // or the winner's own triage·schedule·report would skip too — it just exits.
  if (open.runId && open.runId === graphRunId()) {
    debug.log('steward.stage', 'skipped-overlap-same-run', { openStage: open.stage, pid: open.pid });
    return;
  }
  debug.log('steward.stage', 'skipped-overlap', { openStage: open.stage, pid: open.pid });
  writeFileSync(skippedPath(root), JSON.stringify({ openStage: open.stage, pid: open.pid }));
}

function reportPath(root: string): string { return join(root, 'steward', 'observe.json'); }
function readState(path: string): { issues: Record<string, string>; digestDay?: string } {
  try { return JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof readState>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { issues: {} }; throw error; }
}

/** Each command node invokes one stage. No stage can spawn, launch, merge or approve. */
export async function runStewardStage(stage: 'sync' | 'triage' | 'schedule' | 'report', deps: StewardDeps = {}): Promise<void> {
  const settings = stewardSettings();
  if ((settings.mode ?? 'observe') !== 'observe') throw new Error('steward act mode is out of scope');
  const root = deps.root ?? effectiveInstanceRoot();
  if (stage === 'sync' && !deps.stageOwnedByCommand) {
    return withStageSlot(root, async () => {
      const open = readFailureStreak(root).open as (FailureStreak['open'] & { pid?: number }) | undefined;
      if (open?.pid && isProcessAlive(open.pid)) { skipOverlappingRun(root, open); return; }
      rmSync(skippedPath(root), { force: true });
      await runStewardStage(stage, { ...deps, stageOwnedByCommand: true });
    }, () => { skipOverlappingRun(root, currentOpen(root, stage)); });
  }
  const dir = join(root, 'steward');
  mkdirSync(dir, { recursive: true });
  const snapshot = join(dir, 'issues.json');
  const judgments = join(dir, 'triage.json');
  const schedule = join(dir, 'schedule.json');
  const fetchFn = deps.fetch ?? fetch;
  const skip = skippedPath(root);
  if (stage !== 'sync' && existsSync(skip)) return;
  const key = await (deps.getSecret ?? getSecretAsync)('connector.linear.apiKey');
  if (!key) throw new Error('connector.linear.apiKey missing');
  if (stage === 'sync') {
    const events = await fetchLinearIssues({ apiKey: key, teamKey: settings.linearTeam ?? 'ELA', fetch: fetchFn });
    writeFileSync(snapshot, JSON.stringify(events.map(e => ({ identifier: e.identifier, ref: e.ref, title: e.title, body: e.body }))));
  } else if (stage === 'triage') {
    const issues = JSON.parse(readFileSync(snapshot, 'utf8')) as TriageIssue[];
    const judge = deps.judge;
    let previous: Array<TriageDecision & { inputHash?: string }> = [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(judgments, 'utf8'));
      if (Array.isArray(parsed) && parsed.every((item): item is TriageDecision & { inputHash?: string } =>
        item !== null && typeof item === 'object' && typeof item.issue === 'string' &&
        (item.inputHash === undefined || typeof item.inputHash === 'string') &&
        (item.deferred === undefined || item.deferred === true) &&
        (item.contextInputs === undefined || (Array.isArray(item.contextInputs) &&
          item.contextInputs.every((id: unknown) => typeof id === 'string'))) &&
        [0, 1, 2, 3, 4, 5, 'hitl'].includes(item.rung) &&
        Array.isArray(item.dependsOn) && item.dependsOn.every((dep: unknown) => typeof dep === 'string') &&
        typeof item.priority === 'number' && Number.isFinite(item.priority) && typeof item.why === 'string')) previous = parsed;
    } catch { /* Missing or corrupt previous judgments are an empty cache. */ }
    writeFileSync(judgments, JSON.stringify(await triageIssues(issues, judge, deps.decide, settings.tracks, previous, deps.ask)));
  } else if (stage === 'schedule') {
    const decisions = JSON.parse(readFileSync(judgments, 'utf8')) as TriageDecision[];
    const pending = new Set(decisions.flatMap(decision => decision.dependsOn));
    const completed = new Set<string>();
    if (pending.size) {
      const ids = [...pending];
      for (let offset = 0; offset < ids.length; offset += 250) {
        const batch = ids.slice(offset, offset + 250);
        let cursor: string | null = null;
        do {
          const data: { issues: { nodes: Array<{ identifier: string; state?: { type: string } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await linear(key,
            'query($ids:[String!]!,$after:String){issues(filter:{identifier:{in:$ids}},first:250,after:$after){nodes{identifier state{type}} pageInfo{hasNextPage endCursor}}}',
            { ids: batch, after: cursor }, fetchFn);
          if (!Array.isArray(data.issues?.nodes) || !data.issues.pageInfo ||
              (data.issues.pageInfo.hasNextPage && (!data.issues.pageInfo.endCursor || data.issues.pageInfo.endCursor === cursor))) {
            throw new Error('Linear dependencies incomplete');
          }
          for (const item of data.issues.nodes) if (pending.has(item.identifier) && item.state?.type === 'completed') completed.add(item.identifier);
          cursor = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
        } while (cursor);
      }
    }
    writeFileSync(schedule, JSON.stringify(scheduleTriage(decisions, settings, {}, completed)));
  } else {
    const rows = JSON.parse(readFileSync(schedule, 'utf8')) as ScheduledDecision[];
    const path = reportPath(root);
    const state = readState(path);
    const at = (deps.now ?? (() => new Date()))().toISOString();
    const issues = JSON.parse(readFileSync(snapshot, 'utf8')) as TriageIssue[];
    try {
      recordTriageOnCards(rows, issues, { root, store: deps.cardStore, now: deps.now });
    } catch (error) {
      const message = `steward report: card write failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`;
      debug.log('steward.cards', 'write-failed', { error: message });
      (deps.warn ?? console.warn)(message);
    }
    for (const row of rows) {
      const issue = issues.find(item => item.identifier === row.issue);
      if (!issue) throw new Error(`Missing issue ${row.issue}`);
      const body = `스튜어드 observe · ${row.disposition} · rung ${row.rung} · 우선순위 ${row.priority} · 의존 ${row.dependsOn.join(', ') || '없음'}${row.duplicateOf ? ` · 중복 ${row.duplicateOf}` : ''} · ${row.why}${row.hitlReason ? ` · HITL ${row.hitlReason}` : ''}`;
      const hash = directiveHash(body);
      if (state.issues[row.issue] === hash) continue;
      const result = await linear<{ commentCreate: { success: boolean } }>(key, 'mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}', { input: { issueId: issue.ref, body } }, fetchFn);
      if (!result.commentCreate?.success) throw new Error(`Linear comment failed: ${row.issue}`);
      state.issues[row.issue] = hash;
      writeFileSync(path, JSON.stringify(state));
    }
    const day = at.slice(0, 10);
    if (state.digestDay !== day) {
      const send = deps.sendDigest ?? sendStewardDigest;
      await send(`스튜어드 ${day}: ${rows.map(row => `${row.issue} ${row.disposition}`).join(' · ')}`);
      state.digestDay = day;
      writeFileSync(path, JSON.stringify(state));
    }
  }
}

async function sendStewardDigest(text: string): Promise<void> {
  const { deliver } = await import('../domains/outbound-alert.js');
  if (!deliver(text, 'digest')) throw new Error('steward digest delivery failed');
}

export interface StewardCommandDeps extends StewardDeps {
  runStage?: typeof runStewardStage;
  deliverAlert?: (text: string, kind: 'alert') => boolean | Promise<boolean>;
}

// One stage at a time per instance: an exclusive flock(2) on a stable file, taken in-process through libc
// (as graph-tick does). The kernel drops it when the process dies, so a killed stage never leaves a stale lock.
// The `flock` command-line tool is Linux-only — on macOS, where the steward cron runs, it does not exist (10-01).
const STAGE_LOCK_WAIT_MS = 15 * 60_000;

async function withStageSlot<T>(root: string, run: () => Promise<T>, onBusy?: () => T): Promise<T> {
  const dir = join(root, 'steward');
  mkdirSync(dir, { recursive: true });
  const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : process.platform === 'linux' ? 'libc.so.6' : null;
  if (!library) throw new Error(`steward stage lock unavailable on ${process.platform}`);
  const { dlopen, FFIType } = await import('bun:ffi');
  const lib = dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  const flock = (fd: number, operation: number): number => lib.symbols.flock(fd, operation) as number;
  const fd = openSync(join(dir, 'stage-slot.lock'), 'a');
  // LOCK_EX|LOCK_NB (2|4), retried on a timer: a blocking FFI call would freeze the event loop, and a holder in the
  // same process could then never release (the lock is per open file, so a second open in one process contends too).
  // With onBusy (sync), one try only: a busy slot means another run is in flight — skip instead of waiting.
  if (onBusy && flock(fd, 2 | 4) !== 0) { closeSync(fd); lib.close(); return onBusy(); }
  const deadline = Date.now() + STAGE_LOCK_WAIT_MS;
  while (flock(fd, 2 | 4) !== 0) {
    if (Date.now() >= deadline) { closeSync(fd); lib.close(); throw new Error('steward stage lock unavailable: another stage is still running'); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  try { return await run(); }
  finally { try { flock(fd, 8); } finally { closeSync(fd); lib.close(); } }
}

/** The command-node boundary records both normal exits and an unclosed stage from a killed process. */
export async function runStewardStageCommand(stage: StewardStage, deps: StewardCommandDeps = {}): Promise<0 | 1> {
  const root = deps.root ?? effectiveInstanceRoot();
  if (stage !== 'sync' && existsSync(skippedPath(root))) return 0;
  return withStageSlot(root, async () => {
    const now = deps.now ?? (() => new Date());
    const threshold = stewardSettings().alertAfterFailures ?? 3;
    const alertIfNeeded = async (state: FailureStreak): Promise<void> => {
      if (!shouldAlert(state, threshold)) return;
      try {
        const send = deps.deliverAlert ?? (async (text: string, kind: 'alert') => {
          const { deliver } = await import('../domains/outbound-alert.js');
          return deliver(text, kind) !== false;
        });
        if (!await send(failureAlertText(state), 'alert')) throw new Error('steward alert delivery failed');
        state.alertedAt = now().toISOString();
        writeFailureStreak(root, state);
        debug.log('steward.streak', 'alerted', { consecutive: state.consecutive, stage: state.lastStage });
      } catch (error) {
        try { debug.log('steward.streak', 'alert-failed', { consecutive: state.consecutive, stage: state.lastStage,
          reason: redactSecretText(error instanceof Error ? error.message : String(error)) }); } catch { /* alert observability must not change the stage result */ }
      }
    };
    const open = readFailureStreak(root).open as (FailureStreak['open'] & { pid?: number; runId?: string }) | undefined;
    if (stage === 'sync') {
      if (open?.pid && isProcessAlive(open.pid)) {
        skipOverlappingRun(root, open);
        return 0;
      }
      rmSync(skippedPath(root), { force: true });
    } else if (existsSync(skippedPath(root))) return 0;
    const hadOpen = open !== undefined;
    const started = markStageStart(root, stage, now());
    if (started.open) {
      Object.assign(started.open, { pid: process.pid, ...(graphRunId() ? { runId: graphRunId() } : {}) });
      writeFailureStreak(root, started);
    }
    if (hadOpen) {
      debug.log('steward.streak', 'recorded', { consecutive: started.consecutive, stage: started.lastStage });
      await alertIfNeeded(started);
    }
    let error: unknown;
    let ok = false;
    try { await (deps.runStage ?? runStewardStage)(stage, { ...deps, stageOwnedByCommand: true }); ok = true; }
    catch (caught) { error = caught; }
    const reason = ok ? '' : redactSecretText(error instanceof Error ? error.message : String(error)).slice(0, 300);
    const state = markStageEnd(root, stage, ok, reason, now());
    debug.log('steward.streak', 'recorded', { consecutive: state.consecutive, stage });
    await alertIfNeeded(state);
    if (!ok) {
      console.error(`steward ${stage}: stage failed — ${reason}`);
      debug.log('steward.stage', 'failed', { stage, reason });
      return 1;
    }
    return 0;
  }, stage === 'sync' ? () => { skipOverlappingRun(root, currentOpen(root, stage)); return 0 as const; } : undefined);
}

if (import.meta.main) {
  const stage = process.argv[2];
  if (!['sync', 'triage', 'schedule', 'report'].includes(stage ?? '')) {
    console.error('steward: expected sync|triage|schedule|report');
    process.exitCode = 2;
  } else {
    runStewardStageCommand(stage as StewardStage).then(code => { process.exitCode = code; }).catch((error: unknown) => {
      console.error(`steward ${stage}: ${redactSecretText(error instanceof Error ? error.message : String(error))}`);
      process.exitCode = 1;
    });
  }
}
