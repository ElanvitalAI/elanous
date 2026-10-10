import { readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { streamLLM } from '../llm.js';
import { condenseContextDay, guardianRetireAged, readCondenseEvents, type MemoryItem, type MemorySource, type MemorySummary } from './long-term-memory.js';
import type { CoordEvent } from './coord-events.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { acquireLockAsync } from '../storage/file-lock.js';

type Stage = 'collect' | 'condense' | 'record' | 'conflict-candidates';
type Input = { day?: string; events?: CoordEvent[]; decisions?: DecisionEntry[]; summaries?: Record<string, MemorySummary> };
type Context = { graphId?: string; nodeId?: string; input: Input | null; outputs: Record<string, { day?: string; events?: CoordEvent[]; decisions?: DecisionEntry[]; items?: MemoryItem[]; memoryItems?: MemoryItem[] } | null> };
type NightlyTask = (source: MemorySource, assignee: 'nightly-task-agent', recipe: 'sleep-review') => Promise<MemorySummary>;
type GuardianTask = (items: readonly MemoryItem[], assignee: 'guardian', now: Date) => MemoryItem[] | Promise<MemoryItem[]>;
type NightlyAssignment = { owner: 'coordinator'; assignee: 'nightly-task-agent'; contract: 'librarian'; recipe: 'sleep-review'; source: MemorySource; summary?: MemorySummary };
type GuardianAssignment = { owner: 'guardian'; assignee: 'guardian'; recipe: 'retire-aged'; items: readonly MemoryItem[]; now: string }
  | { owner: 'guardian'; assignee: 'guardian'; recipe: 'store-snapshot'; root: string; project: string; seat: string; value: MemoryItem[] }
  | { owner: 'guardian'; assignee: 'guardian'; recipe: 'store-candidates'; root: string; value: unknown[] };
type Assignment = NightlyAssignment | GuardianAssignment;

/** Execute an assigned recipe in a separate, short-lived task worker, never in the coordinator's stage process. */
async function dispatchAssignment<T>(assignment: Assignment): Promise<{ result: T; workerPid: number }> {
  const worker = Bun.spawn([process.execPath, import.meta.path, '--assigned-task'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  worker.stdin.write(JSON.stringify(assignment));
  worker.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited,
  ]);
  if (exit !== 0) throw new Error(`nightly ${assignment.recipe} task failed: ${stderr.trim()}`);
  return { result: JSON.parse(stdout) as T, workerPid: worker.pid };
}

async function executeAssignment(assignment: Assignment): Promise<MemorySummary | MemoryItem[] | { stored: true }> {
  if (assignment.owner === 'coordinator' && assignment.assignee === 'nightly-task-agent'
    && assignment.contract === 'librarian' && assignment.recipe === 'sleep-review') {
    return summarize(assignment.source, assignment.summary ? { [assignment.source.source]: assignment.summary } : undefined, assignment.recipe);
  }
  if (assignment.owner === 'guardian' && assignment.assignee === 'guardian') {
    if (assignment.recipe === 'retire-aged') return guardianRetireAged(assignment.items, new Date(assignment.now));
    if (assignment.recipe === 'store-snapshot') {
      if (!assignment.value.every(item => item.project === assignment.project && item.seat === assignment.seat)) {
        throw new Error('guardian memory group mismatch');
      }
      guardianSave(snapshotPath(assignment.root, assignment.project, assignment.seat), assignment.value);
      return { stored: true };
    }
    if (assignment.recipe === 'store-candidates') {
      guardianSave(join(assignment.root, 'context-memory', 'conflict-candidates.json'), assignment.value);
      return { stored: true };
    }
  }
  throw new Error('invalid nightly assignment');
}

const dayBefore = (date: Date) => new Date(date.getTime() - 86_400_000).toISOString().slice(0, 10);
const fileName = (value: string) => encodeURIComponent(value).replace(/\./g, '%2E');

function snapshotPath(root: string, project: string, seat: string): string {
  if (project === '.' || project === '..' || seat === '.' || seat === '..') throw new Error('invalid memory path');
  return join(root, 'context-memory', fileName(project), `${fileName(seat)}.json`);
}

function save(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, file);
}

const GUARDIAN_SIZE_BUDGET_BYTES = 16 * 1024 * 1024;

/** Guardian-owned snapshot hygiene. The JSON ledger stays byte-for-byte in its existing format. */
function guardianSave(file: string, value: unknown): void {
  const text = JSON.stringify(value, null, 2) + '\n';
  const previous = existsSync(file) ? readFileSync(file) : undefined;
  const backup = `${file}.gz`;
  if (previous) {
    // Write the new backup beside the old one and verify it on disk before it replaces the old backup,
    // so a failed or corrupt backup write never destroys the previous backup.
    const backupTemp = `${backup}.${process.pid}.tmp`;
    try {
      writeFileSync(backupTemp, gzipSync(previous));
      if (!gunzipSync(readFileSync(backupTemp)).equals(previous)) throw new Error('guardian backup integrity check failed');
      renameSync(backupTemp, backup);
    } catch (error) {
      if (existsSync(backupTemp)) unlinkSync(backupTemp);
      throw error;
    }
  }
  try {
    if (Buffer.byteLength(text) > GUARDIAN_SIZE_BUDGET_BYTES) throw new Error('guardian memory size budget exceeded');
    save(file, value);
    if (readFileSync(file, 'utf8') !== text) throw new Error('guardian memory integrity check failed');
  } catch (error) {
    if (previous) writeFileSync(file, gunzipSync(readFileSync(backup)));
    else if (existsSync(file)) unlinkSync(file);
    const temp = `${file}.${process.pid}.tmp`;
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

async function withCurrentDay<T>(root: string, day: string, write: () => T): Promise<T> {
  const dir = join(root, 'context-memory');
  mkdirSync(dir, { recursive: true });
  const lock = await acquireLockAsync(join(dir, '.nightly-write.lock'));
  try {
    const marker = join(dir, 'latest-day');
    const latest = latestDay(root);
    if ((latest && latest > day) || storedItems(root).some(item =>
      Date.parse(item.updatedAt) >= Date.parse(`${day}T00:00:00Z`) + 86_400_000)) {
      throw new Error(`cannot replay ${day}: later project/seat memory exists`);
    }
    if (!lock.stillHeld()) throw new Error('nightly memory write lock lost');
    // Reserve the day before touching either output, so a failed writer cannot let an older run overwrite it.
    if (!latest || latest < day) save(marker, day);
    return await write();
  } finally { lock.release(); }
}

function latestDay(root: string): string | undefined {
  const marker = join(root, 'context-memory', 'latest-day');
  return existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) as string : undefined;
}

function storedItems(root: string): MemoryItem[] {
  const dir = join(root, 'context-memory');
  if (!existsSync(dir)) return [];
  const items: MemoryItem[] = [];
  for (const project of readdirSync(dir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const seat of readdirSync(join(dir, project.name))) {
      if (!seat.endsWith('.json')) continue;
      const content: unknown = JSON.parse(readFileSync(join(dir, project.name, seat), 'utf8'));
      if (!Array.isArray(content)) throw new Error('invalid context memory file');
      items.push(...content as MemoryItem[]);
    }
  }
  return items;
}

/** A sleep-review rejection: counted as `not-promoted` by the condenser, never as a malformed summary. */
function notPromoted(value: Record<string, unknown>): MemorySummary {
  const text = (key: string) => typeof value[key] === 'string' ? value[key] as string : '';
  return { promote: false, project: text('project'), topic: text('topic'), summary: text('summary') };
}

export function summaryInstruction(recipe: 'standard' | 'sleep-review' = 'standard'): string {
  const system = 'Summarize this one-line context event as a compact project/seat memory item. Return ONLY JSON: {"project":"...","topic":"...","summary":"...","claim":{"key":"...","value":"..."}}. Omit claim when the event makes no comparable factual assertion. Never invent a project, topic or claim.';
  if (recipe === 'standard') return system;
  // SLEEP1 builds on this librarian recipe; the guardian owns storage hygiene, not promotion judgments.
  return `${system.replace('"project":"..."', '"promote":false,"project":"..."')} You are the nightly task agent (librarian). Sleep review (librarian contract): apply the coordinator promotion policy. Return a boolean "promote" for every source. Set promote=true only for sourced, durable project/seat facts or decisions, including durable updates without a comparable claim; set promote=false for chatter or speculative claims. A correction with a later timestamp wins; return a comparable claim only for an explicit factual assertion so opposing claims can become OP conflict candidates. Do not perform guardian hygiene (retention, compression, size, backup, integrity or rollback).`;
}

export async function summarize(source: MemorySource, injected?: Record<string, MemorySummary>, recipe: 'standard' | 'sleep-review' = 'standard'): Promise<MemorySummary> {
  if (injected) {
    const result = injected[source.source];
    if (!result) throw new Error(`missing test summary: ${source.source}`);
    if (recipe === 'sleep-review' && typeof result.promote !== 'boolean') throw new Error('invalid memory summary');
    if (recipe === 'sleep-review' && result.promote === false) return notPromoted(result as unknown as Record<string, unknown>);
    return result;
  }
  const response = await streamLLM([
    { role: 'system', content: summaryInstruction(recipe) },
    { role: 'user', content: JSON.stringify(source) },
  ], () => {}, { maxTokens: 350, usageRole: 'research' });
  const parsed: unknown = JSON.parse(response.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid memory summary');
  const value = parsed as Record<string, unknown>;
  // A librarian rejection needs no project/topic/summary — chatter often has none to give.
  if (recipe === 'sleep-review' && value.promote === false) return notPromoted(value);
  if (typeof value.project !== 'string' || typeof value.topic !== 'string' || typeof value.summary !== 'string' ||
    (recipe === 'sleep-review' && typeof value.promote !== 'boolean') ||
    (value.claim !== undefined && (!value.claim || typeof value.claim !== 'object' || Array.isArray(value.claim) ||
      typeof (value.claim as Record<string, unknown>).key !== 'string' || typeof (value.claim as Record<string, unknown>).value !== 'string'))) {
    throw new Error('invalid memory summary');
  }
  return value as unknown as MemorySummary;
}

const defaultGuardianTask: GuardianTask = (items, assignee, now) => {
  if (assignee !== 'guardian') throw new Error('invalid guardian assignee');
  return guardianRetireAged(items, now);
};

/** Stage outputs travel only through the graph runner's per-run contexts. No decision ledger write occurs here. */
export async function runNightlyStage(stage: Stage, context: Context, root: string, dryRun: boolean, now = new Date(),
  nightlyTask?: NightlyTask, guardianTask: GuardianTask = defaultGuardianTask): Promise<Record<string, unknown>> {
  const input = context.input ?? {};
  if (dryRun && stage !== 'collect' && (!input.events || !input.decisions || !input.summaries)) {
    throw new Error('dry-run requires fake events, decisions and summaries');
  }
  const day = context.outputs.collect?.day ?? input.day ?? dayBefore(now);
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new Error('invalid UTC day');
  }
  if (stage === 'collect') {
    if (!dryRun && ((latestDay(root) ?? '') > day || storedItems(root).some(item =>
      Date.parse(item.updatedAt) >= Date.parse(`${day}T00:00:00Z`) + 86_400_000))) {
      throw new Error(`cannot replay ${day}: later project/seat memory exists`);
    }
    if (dryRun && (!input.events || !input.decisions || !input.summaries)) {
      throw new Error('dry-run requires fake events, decisions and summaries');
    }
    const events = input.events ?? readCondenseEvents(new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString());
    const decisions = input.decisions ?? (dryRun ? [] : new DecisionLedger({ stateDir: root }).list({ status: 'all' })
      .filter(decision => decision.raisedBy.agent !== 'context-condense'));
    return { outcome: 'ok', day, events, decisions };
  }
  const collected = context.outputs.collect;
  if (!collected?.day || !collected.events || !collected.decisions) throw new Error('collect output missing');
  if (stage === 'condense') {
    const assignments: Array<{ owner: 'coordinator'; assignee: 'nightly-task-agent'; contract: 'librarian'; recipe: 'sleep-review'; workerPid: number }> = [];
    const policy = { promotion: 'sleep-review', retention: 'guardian' } as const;
    const items = await condenseContextDay(collected.day, dryRun ? [] : storedItems(root).filter(item => Date.parse(item.updatedAt) < Date.parse(`${collected.day}T00:00:00Z`)), {
      events: () => collected.events!, decisions: () => collected.decisions!,
      summarize: async source => {
        if (dryRun) return summarize(source, input.summaries, 'sleep-review');
        if (nightlyTask) return nightlyTask(source, 'nightly-task-agent', 'sleep-review');
        const { result, workerPid } = await dispatchAssignment<MemorySummary>({ owner: 'coordinator', assignee: 'nightly-task-agent',
          contract: 'librarian', recipe: 'sleep-review', source, ...(input.summaries ? { summary: input.summaries[source.source] } : {}) });
        assignments.push({ owner: 'coordinator', assignee: 'nightly-task-agent', contract: 'librarian', recipe: 'sleep-review', workerPid });
        return result;
      },
    }, now, policy);
    return { outcome: 'ok', items, assignments };
  }
  const items = context.outputs.condense?.items;
  if (!items) throw new Error('condense output missing');
  if (stage === 'record') {
    const grouped = new Map<string, MemoryItem[]>();
    // The guardian task owns retirement; the librarian never mutates the stored status.
    const guardianRun = guardianTask === defaultGuardianTask && !dryRun
      ? await dispatchAssignment<MemoryItem[]>({ owner: 'guardian', assignee: 'guardian', recipe: 'retire-aged', items, now: now.toISOString() })
      : { result: await guardianTask(items, 'guardian', now), workerPid: undefined };
    const memoryItems = guardianRun.result;
    for (const item of memoryItems) {
      const file = snapshotPath(root, item.project, item.seat);
      grouped.set(file, [...grouped.get(file) ?? [], item]);
    }
    if (!dryRun) await withCurrentDay(root, day, async () => {
      // The record is all-or-nothing: each guardian write rolls back its own file, and if a later group
      // fails (size budget, integrity, worker error) the files this record already wrote are restored too.
      const written: Array<{ file: string; previous: Buffer | undefined; previousBackup: Buffer | undefined }> = [];
      const snapshot = (path: string) => existsSync(path) ? readFileSync(path) : undefined;
      try {
        for (const [file, group] of grouped) {
          const first = group[0]!;
          written.push({ file, previous: snapshot(file), previousBackup: snapshot(`${file}.gz`) });
          const stored = await dispatchAssignment<{ stored: true }>({ owner: 'guardian', assignee: 'guardian', recipe: 'store-snapshot',
            root, project: first.project, seat: first.seat, value: group });
          if (!stored.result.stored) throw new Error('guardian snapshot not stored');
        }
      } catch (error) {
        // Restore both the snapshot and its backup to what they were before this record started.
        for (const { file, previous, previousBackup } of written.reverse()) {
          for (const [path, before] of [[file, previous], [`${file}.gz`, previousBackup]] as const) {
            if (before) writeFileSync(path, before);
            else if (existsSync(path)) unlinkSync(path);
          }
        }
        throw error;
      }
    });
    return { outcome: 'ok', files: [...grouped.keys()], items: items.length, memoryItems, dryRun,
      guardian: { assignee: 'guardian', recipe: 'retire-aged', retired: memoryItems.filter(item => item.status === 'retired').length,
        workerPid: guardianRun.workerPid } };
  }
  if (stage === 'conflict-candidates') {
    if (!context.outputs.record) throw new Error('record output missing');
    const recorded = context.outputs.record.memoryItems;
    if (!recorded) throw new Error('guardian record output missing');
    const candidates = recorded.filter(item => item.conflict && item.status === 'active').map(item => ({
      project: item.project, topic: item.topic, owner: item.conflict!.owner,
      sources: item.conflict!.sources, status: 'candidate' as const,
    }));
    if (!dryRun) await withCurrentDay(root, day, async () => {
      const stored = await dispatchAssignment<{ stored: true }>({ owner: 'guardian', assignee: 'guardian', recipe: 'store-candidates',
        root, value: candidates });
      if (!stored.result.stored) throw new Error('guardian candidates not stored');
    });
    return { outcome: 'ok', candidates, published: 0 };
  }
  throw new Error(`unknown stage: ${stage}`);
}

if (import.meta.main && process.argv[2] === '--assigned-task') {
  const assignment = await new Response(Bun.stdin.stream()).json() as Assignment;
  console.log(JSON.stringify(await executeAssignment(assignment)));
} else if (import.meta.main) {
  const stage = process.argv[2] as Stage;
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path || !['collect', 'condense', 'record', 'conflict-candidates'].includes(stage)) throw new Error('invalid nightly graph stage');
  const context = JSON.parse(readFileSync(path, 'utf8')) as Context;
  if (context.graphId !== 'nightly-condense' || context.nodeId !== stage) throw new Error('nightly graph context mismatch');
  const statePath = resolve(path, '..', '..', '..', '..');
  const result = await runNightlyStage(stage, context, statePath, process.env.ELANOUS_GRAPH_DRY_RUN === '1',
    new Date());
  console.log(JSON.stringify(result));
}
