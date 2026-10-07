import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { queryRunningRuns, type QueriedRunningRunsResult } from '../self-implement/running-runs.js';
import { loadRunLedger } from '../self-implement/run-ledger.js';
import { localLoopRows } from '../dashboard/slash-runtime/loops-table.js';
import { checkBrand } from '../../scripts/brand/check.js';
import { debug, redactSecretText } from '../debug/log.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { listChecklist, devVersion, type Checklist } from '../release-loop/checklist.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { seatDay, seatLedgerPath, type SeatEntry } from '../seat-loop/seat-loop.js';
import { listCoordEvents, type CoordEvent } from './coord-events.js';
import { filterPublicDemoContext } from './context-now-public.js';

export type ContextFact =
  | { kind: 'version'; version: string; source: string }
  | { kind: 'cell'; version: string; id: string; title: string; status: string; owner: string | null; source: string }
  | { kind: 'decision'; id: string; title: string; status: string; dueAt: string | null; source: string }
  | { kind: 'seat'; seat: string; at: string; status: string; id: string | null; title: string | null; source: string }
  | { kind: 'run'; goal: string; phase: string; elapsed: string; source: string; unreadable?: string }
  | { kind: 'release'; version: string; node: string; status: string; source: string; unreadable?: string }
  | { kind: 'schedule-late'; count: number | null; names: string[]; source: string; unreadable?: string };
export type ContextEvent = { at: string; kind: string; summary: string; source: string };
export type ContextNowAnswer = { at: string; topic: string | null; facts: ContextFact[]; events: ContextEvent[]; guide: string[]; hiddenCount?: number };

export interface ContextNowDeps {
  now?: () => Date;
  version?: () => string;
  checklist?: (version: string) => Checklist;
  decisions?: () => DecisionEntry[];
  seatEntries?: (now: Date) => Array<{ entry: SeatEntry; source: string }>;
  events?: (since: string) => CoordEvent[];
  runningRuns?: (now: Date) => Extract<ContextFact, { kind: 'run' }>[];
  queryRuns?: () => QueriedRunningRunsResult;
  releaseRun?: () => Extract<ContextFact, { kind: 'release' }> | null;
  lateSchedules?: (now: Date) => Extract<ContextFact, { kind: 'schedule-late' }> | null;
  brandCheck?: typeof checkBrand;
}

function todaySeatEntries(now: Date): Array<{ entry: SeatEntry; source: string }> {
  const root = effectiveInstanceRoot();
  const day = seatDay(now);
  return ['OP', 'TC', 'MK', 'UX'].flatMap(seat => {
    const path = seatLedgerPath(seat, root, now);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').flatMap((line, index) => line.trim() ? [{
      entry: JSON.parse(line) as SeatEntry,
      source: `elanous://seat-loop/${seat}/${day}#${index + 1}`,
    }] : []);
  });
}

const runSource = 'elanous://self-implement/running-runs';
const releaseSource = 'elanous://graph-runs/release-loop';
const scheduleSource = 'elanous://schedules';
const oneLine = (text: string) => redactSecretText(text.split(/\r?\n/, 1)[0] ?? '').slice(0, 120);

function runningRunFacts(now: Date, queryRuns: () => QueriedRunningRunsResult = () => queryRunningRuns({ includeTest: false, caller: 'context-now' })): Extract<ContextFact, { kind: 'run' }>[] {
  const observed = queryRuns();
  const unreadable = observed.completeness === 'partial' || observed.pty.unreadable.length || !!observed.phases?.unreadableTargetCount;
  const facts = observed.entries.filter(entry => observed.countedStatuses.includes(entry.status)).slice(0, 8).flatMap(entry => {
    let ledgerReadFailure = false;
    const starts = entry.ledgerDirectories.flatMap(directory => {
      try { return loadRunLedger(entry.runId, directory)?.filter(record => record.event === 'start') ?? []; }
      catch { ledgerReadFailure = true; return []; }
    });
    const goalRecord = starts.find(record => typeof record.data.feature === 'string' && record.data.feature.trim());
    const goal = typeof goalRecord?.data.feature === 'string' ? goalRecord.data.feature : ledgerReadFailure ? '골 관측 불가' : '골 미기록';
    const started = starts.map(record => record.timestamp ? Date.parse(record.timestamp) : NaN).find(Number.isFinite) ?? NaN;
    const minutes = Number.isFinite(started)
      ? Math.max(0, Math.floor((now.getTime() - started) / 60_000)) : null;
    const fact = { kind: 'run' as const, goal: oneLine(goal),
      phase: entry.lastPhase ?? '단계 미관측', elapsed: minutes === null ? ledgerReadFailure ? '경과 관측 불가' : '경과 미관측' : `${minutes}분`,
      source: `${runSource}/${encodeURIComponent(entry.runId)}` };
    return ledgerReadFailure
      ? [
          ...(goalRecord || minutes !== null ? [fact] : []),
          { kind: 'run' as const, goal: '', phase: '', elapsed: '', source: fact.source, unreadable: '런 원장 일부 관측 불가' },
        ] : [fact];
  });
  return unreadable ? [...facts, { kind: 'run', goal: '', phase: '', elapsed: '', source: runSource, unreadable: '런 원장 또는 관측 대상 일부' }] : facts;
}

function latestReleaseRun(): Extract<ContextFact, { kind: 'release' }> | null {
  const dir = join(effectiveInstanceRoot(), 'graph-runs', 'release-loop');
  let filenames: string[];
  try { filenames = readdirSync(dir).filter(name => /^[A-Za-z0-9-]+\.json$/.test(name)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const runs = filenames.flatMap(filename => {
    const path = join(dir, filename);
    let run: { startedAt?: unknown; status?: unknown; input?: { version?: unknown }; path?: unknown; nodes?: unknown };
    try {
      if (!lstatSync(path).isFile()) return [];
      run = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return [];
      throw error;
    }
    if (typeof run.startedAt !== 'string' || typeof run.status !== 'string' || !Array.isArray(run.path) || !Array.isArray(run.nodes)) return [];
    const steps = run.path.filter((step): step is string => typeof step === 'string');
    const nodes = run.nodes.filter((node): node is { nodeId: string } => !!node && typeof node.nodeId === 'string');
    const version = typeof run.input?.version === 'string' && /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(run.input.version) ? run.input.version : '판 미기록';
    const index = Math.min(steps.length, nodes.length + (run.status === 'running' || run.status === 'awaiting-approval' ? 1 : 0));
    return [{ startedAt: run.startedAt, fact: { kind: 'release' as const, version, node: `${index}/${steps.length}${steps[index - 1] ? ` ${oneLine(steps[index - 1]!)}` : ''}`,
      status: oneLine(run.status), source: `${releaseSource}/${encodeURIComponent(filename.slice(0, -5))}` } }];
  });
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.fact ?? null;
}

function lateScheduleFact(now: Date): Extract<ContextFact, { kind: 'schedule-late' }> {
  const names = localLoopRows(now).filter(row => row.verdict === 'late').map(row => oneLine(row.name));
  return { kind: 'schedule-late', count: names.length, names, source: scheduleSource };
}

function unreadableReason(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error)) || '원천 조회 실패';
}

/** Read a bounded, source-labelled view of current ledgers, never a transcript or decision body. */
export function contextNow(options: { topic?: string; limit?: number; audience?: 'operator' | 'user' | 'public-demo' } = {}, deps: ContextNowDeps = {}): ContextNowAnswer {
  const now = (deps.now ?? (() => new Date()))();
  const at = `${now.toISOString().slice(0, 16)}:00.000Z`;
  const topic = options.topic?.trim() || null;
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(1, Math.min(100, Math.floor(options.limit))) : 20;
  const version = (deps.version ?? devVersion)().replace(/-.*$/, '');
  const next = version.replace(/^(\d+)\.(\d+)\.(\d+)$/, (_, major: string, minor: string, patch: string) => `${major}.${minor}.${Number(patch) + 1}`);
  const facts: ContextFact[] = [];
  for (const v of [...new Set([version, next])]) {
    const checklist = (deps.checklist ?? listChecklist)(v);
    if (v === version) facts.push({ kind: 'version', version: v, source: `elanous://release/${v}/checklist` });
    for (const item of checklist.items) {
      if (item.status === 'done') continue;
      facts.push({ kind: 'cell', version: v, id: item.id, title: redactSecretText(item.title.split(/\r?\n/, 1)[0] ?? '').slice(0, 120),
        status: item.status, owner: item.owner ?? null, source: `elanous://release/${v}/checklist#${encodeURIComponent(item.id)}` });
    }
  }
  for (const item of (deps.decisions ?? (() => new DecisionLedger().list({ status: 'open' })))()) {
    if (item.status !== 'open') continue;
    facts.push({ kind: 'decision', id: item.id, title: redactSecretText(item.title.split(/\r?\n/, 1)[0] ?? '').slice(0, 120),
      status: item.status, dueAt: item.dueAt ?? null, source: `elanous://decisions/${encodeURIComponent(item.id)}` });
  }
  for (const { entry, source } of (deps.seatEntries ?? todaySeatEntries)(now)) {
    facts.push({ kind: 'seat', seat: entry.seat, at: entry.at, status: entry.status,
      id: entry.item?.id ?? null, title: entry.item?.source === 'checklist'
        ? redactSecretText(entry.item.title.split(/\r?\n/, 1)[0] ?? '').slice(0, 120) : null, source });
  }
  const rawEvents = (deps.events ?? (since => listCoordEvents({ since })))(new Date(now.getTime() - 7 * 86_400_000).toISOString());
  const chronologicalEvents = rawEvents.slice().sort((a, b) => a.at.localeCompare(b.at));
  const matches = (text: string) => !topic || text.toLocaleLowerCase().includes(topic.toLocaleLowerCase());
  const operational: ContextFact[] = [];
  if (options.audience !== 'public-demo') {
    try { operational.push(...(deps.runningRuns ?? (date => runningRunFacts(date, deps.queryRuns)))(now)); }
    catch (error) { operational.push({ kind: 'run', goal: '', phase: '', elapsed: '', source: runSource, unreadable: unreadableReason(error) }); }
    try {
      const release = (deps.releaseRun ?? latestReleaseRun)();
      if (release) operational.push(release);
    } catch (error) { operational.push({ kind: 'release', version: '', node: '', status: '', source: releaseSource, unreadable: unreadableReason(error) }); }
    try { const schedules = (deps.lateSchedules ?? lateScheduleFact)(now); if (schedules) operational.push(schedules); }
    catch (error) { operational.push({ kind: 'schedule-late', count: null, names: [], source: scheduleSource, unreadable: unreadableReason(error) }); }
  }
  const selectedOperational = operational.filter(f => !topic || ('unreadable' in f && !!f.unreadable) || (f.kind === 'run' && matches(`${f.goal} ${f.phase}`))
    || (f.kind === 'release' && matches(`${f.version} ${f.node} ${f.status}`))
    || (f.kind === 'schedule-late' && matches(f.names.join(' '))));
  const selectedFacts = facts.filter(f => !topic || (f.kind === 'cell' && matches(`${f.id} ${f.title}`))
    || (f.kind === 'seat' && matches(`${f.id ?? ''} ${f.title ?? ''}`)));
  const groups = (['version', 'cell', 'decision', 'seat'] as const).map(kind => selectedFacts.filter(f => f.kind === kind));
  groups[3]!.sort((a, b) => (a.kind === 'seat' && b.kind === 'seat' ? b.at.localeCompare(a.at) : 0));
  const nonEmpty = groups.filter(group => group.length > 0);
  const perKind = Math.floor(limit / nonEmpty.length);
  const chosen = groups.map(group => group.splice(0, perKind));
  let remaining = limit - chosen.reduce((total, group) => total + group.length, 0);
  for (const index of [2, 3, 0, 1]) {
    if (remaining <= 0) break;
    if (chosen[index]!.length === 0 && groups[index]!.length > 0) {
      chosen[index]!.push(...groups[index]!.splice(0, 1));
      remaining--;
    }
  }
  for (const index of [1, 2, 3, 0]) {
    if (remaining <= 0) break;
    const extra = groups[index]!.splice(0, remaining);
    chosen[index]!.push(...extra);
    remaining -= extra.length;
  }
  const boundedFacts = [...selectedOperational.slice(0, limit), ...chosen.flat()];
  const summaries = chronologicalEvents.map(event => ({
    at: event.at, kind: event.kind, summary: redactSecretText(event.summary.split(/\r?\n/, 1)[0] ?? '').slice(0, 120),
    source: event.refs.source ?? event.refs.url ?? `elanous://context/event/${encodeURIComponent(event.id)}`,
  }));
  const selectedEvents = summaries.filter(event => matches(event.summary)).reverse().slice(0, limit);
  const guide = summaries.filter(event => event.kind === 'guide-changed' || event.kind === 'guidance-changed' || event.summary.startsWith('📌안내'))
    .filter(event => matches(event.summary)).reverse().slice(0, limit)
    .map(event => `📌 ${event.summary} — ${event.source}`);
  const answer = { at, topic, facts: boundedFacts, events: selectedEvents, guide };
  debug.log('context.now', 'answer', { topic, facts: answer.facts, events: answer.events });
  return options.audience === 'public-demo' ? filterPublicDemoContext(answer, deps.brandCheck) : answer;
}
