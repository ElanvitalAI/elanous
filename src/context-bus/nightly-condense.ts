import { readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { streamLLM } from '../llm.js';
import { condenseContextDay, type MemoryItem, type MemorySource, type MemorySummary } from './long-term-memory.js';
import { listCoordEvents, type CoordEvent } from './coord-events.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { acquireLockAsync } from '../storage/file-lock.js';

type Stage = 'collect' | 'condense' | 'record' | 'conflict-candidates';
type Input = { day?: string; events?: CoordEvent[]; decisions?: DecisionEntry[]; summaries?: Record<string, MemorySummary> };
type Context = { graphId?: string; nodeId?: string; input: Input | null; outputs: Record<string, { day?: string; events?: CoordEvent[]; decisions?: DecisionEntry[]; items?: MemoryItem[] } | null> };

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
    return write();
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

export async function summarize(source: MemorySource, injected?: Record<string, MemorySummary>): Promise<MemorySummary> {
  if (injected) {
    const result = injected[source.source];
    if (!result) throw new Error(`missing test summary: ${source.source}`);
    return result;
  }
  const response = await streamLLM([
    { role: 'system', content: 'Summarize this one-line context event as a compact project/seat memory item. Return ONLY JSON: {"project":"...","topic":"...","summary":"...","claim":{"key":"...","value":"..."}}. Omit claim when the event makes no comparable factual assertion. Never invent a project, topic or claim.' },
    { role: 'user', content: JSON.stringify(source) },
  ], () => {}, { maxTokens: 350, usageRole: 'research' });
  const parsed: unknown = JSON.parse(response.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid memory summary');
  const value = parsed as Record<string, unknown>;
  if (typeof value.project !== 'string' || typeof value.topic !== 'string' || typeof value.summary !== 'string' ||
    (value.claim !== undefined && (!value.claim || typeof value.claim !== 'object' || Array.isArray(value.claim) ||
      typeof (value.claim as Record<string, unknown>).key !== 'string' || typeof (value.claim as Record<string, unknown>).value !== 'string'))) {
    throw new Error('invalid memory summary');
  }
  return value as unknown as MemorySummary;
}

/** Stage outputs travel only through the graph runner's per-run contexts. No decision ledger write occurs here. */
export async function runNightlyStage(stage: Stage, context: Context, root: string, dryRun: boolean, now = new Date()): Promise<Record<string, unknown>> {
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
    const events = input.events ?? listCoordEvents({ since: new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString() });
    const decisions = input.decisions ?? (dryRun ? [] : new DecisionLedger().list({ status: 'all' }));
    return { outcome: 'ok', day, events, decisions };
  }
  const collected = context.outputs.collect;
  if (!collected?.day || !collected.events || !collected.decisions) throw new Error('collect output missing');
  if (stage === 'condense') {
    const items = await condenseContextDay(collected.day, dryRun ? [] : storedItems(root).filter(item => Date.parse(item.updatedAt) < Date.parse(`${collected.day}T00:00:00Z`)), {
      events: () => collected.events!, decisions: () => collected.decisions!,
      summarize: source => summarize(source, input.summaries),
    }, now);
    return { outcome: 'ok', items };
  }
  const items = context.outputs.condense?.items;
  if (!items) throw new Error('condense output missing');
  if (stage === 'record') {
    const grouped = new Map<string, MemoryItem[]>();
    for (const item of items) {
      const file = snapshotPath(root, item.project, item.seat);
      grouped.set(file, [...grouped.get(file) ?? [], item]);
    }
    if (!dryRun) await withCurrentDay(root, day, () => {
      for (const [file, group] of grouped) save(file, group);
    });
    return { outcome: 'ok', files: [...grouped.keys()], items: items.length, memoryItems: dryRun ? items : undefined, dryRun };
  }
  if (stage === 'conflict-candidates') {
    if (!context.outputs.record) throw new Error('record output missing');
    const candidates = items.filter(item => item.conflict && item.status === 'active').map(item => ({
      project: item.project, topic: item.topic, owner: item.conflict!.owner,
      sources: item.conflict!.sources, status: 'candidate' as const,
    }));
    if (!dryRun) await withCurrentDay(root, day, () => save(join(root, 'context-memory', 'conflict-candidates.json'), candidates));
    return { outcome: 'ok', candidates, published: 0 };
  }
  throw new Error(`unknown stage: ${stage}`);
}

if (import.meta.main) {
  const stage = process.argv[2] as Stage;
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path || !['collect', 'condense', 'record', 'conflict-candidates'].includes(stage)) throw new Error('invalid nightly graph stage');
  const context = JSON.parse(readFileSync(path, 'utf8')) as Context;
  if (context.graphId !== 'nightly-condense' || context.nodeId !== stage) throw new Error('nightly graph context mismatch');
  const statePath = resolve(path, '..', '..', '..', '..');
  const result = await runNightlyStage(stage, context, statePath, process.env.ELANOUS_GRAPH_DRY_RUN === '1');
  console.log(JSON.stringify(result));
}
