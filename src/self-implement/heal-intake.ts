import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { debug } from '../debug/log.js';
import { passJourneyNode } from '../self-dev/graph-journey-nodes.js';
import { getUserConfig } from '../user-config.js';
import { psProcessStartMs, START_TOLERANCE_MS } from '../harness/harness-stop.js';

export type FailureSource = 'release-run' | 'harness-run' | 'loop-tick' | 'cron';

export interface FailureEvent {
  source: FailureSource;
  kind: string;
  ref: string;
  summary: string;
  at: string;
}

const FOLD_WINDOW_MS = 60 * 60 * 1_000;
const HEAL_GRAPH = join(import.meta.dir, '../../graphs/heal/heal-loop.yaml');

type HealLoopOptions = { runId: string; input: { failureEvent: FailureEvent }; deps: { root: string } };
type StartHealLoop = (file: string, options: HealLoopOptions) => Promise<unknown>;

function healRunId(event: FailureEvent): string {
  return `heal-${createHash('sha256').update(JSON.stringify([event.source, event.ref, event.at])).digest('hex')}`;
}

function maxConcurrentLoops(): number {
  const raw = getUserConfig().raw.heal;
  const cap = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).maxConcurrentLoops : undefined;
  return typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0 ? cap : 2;
}

function ownerAlive(pid: unknown, pidStartedAt: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof pidStartedAt !== 'string') return false;
  const started = Date.parse(pidStartedAt);
  if (!Number.isFinite(started)) return false;
  try {
    const actual = psProcessStartMs(pid as number);
    return actual !== null && Number.isFinite(actual) && Math.abs(actual - started) <= START_TOLERANCE_MS;
  } catch { return false; }
}

function liveHealRuns(root: string): Set<string> {
  const live = new Set<string>();
  const dir = join(root, 'graph-runs', 'heal-loop');
  let files: string[];
  try { files = readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return live;
    throw error;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const state = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
      if (state.graphId === 'heal-loop' && state.runId === file.slice(0, -5) &&
          state.status === 'running' && ownerAlive(state.pid, state.pidStartedAt)) live.add(state.runId as string);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  return live;
}

/** A test process must never start the real heal loop — it spawns external grounding (10-05 load 150 incident). */
export async function startHealLoop(file: string, options: HealLoopOptions, env: NodeJS.ProcessEnv = process.env,
  run: StartHealLoop = async (graph, args) => (await import('../graph-runner/runner.js')).runGraph(graph, args)): Promise<unknown> {
  if (env.ELANOUS_POD_NAME) {
    debug.log('heal.intake', 'skipped-in-pod', { ref: options.input.failureEvent.ref });
    return undefined;
  }
  if (env.NODE_ENV === 'test' || env.ELANOUS_TEST_HOME) {
    debug.log('heal.intake', 'loop-start-skipped-test', { runId: options.runId });
    return undefined;
  }
  const root = options.deps.root;
  const claimDir = join(root, 'heal', 'starts');
  const selected = withInboxLock(inboxPath(root), () => {
    mkdirSync(claimDir, { recursive: true });
    const live = liveHealRuns(root);
    const claimed = new Set<string>();
    for (const name of readdirSync(claimDir)) {
      if (!/^heal-[a-f0-9]{64}\.json$/.test(name)) continue;
      const runId = name.slice(0, -5);
      const path = join(claimDir, name);
      const claim = JSON.parse(readFileSync(path, 'utf8')) as { active?: boolean; started?: boolean; pid?: number; pidStartedAt?: string };
      const owner = claim.active && ownerAlive(claim.pid, claim.pidStartedAt);
      if (!owner && !claim.started && !existsSync(join(root, 'graph-runs', 'heal-loop', `${runId}.json`))) {
        unlinkSync(path);
        continue;
      }
      claimed.add(runId);
      if (owner && !live.has(runId)) live.add(runId);
    }
    const cap = maxConcurrentLoops();
    if (live.size >= cap) {
      debug.log('heal.intake', 'loop-start-deferred', { running: live.size, cap, runId: options.runId });
      return undefined;
    }
    const next = readInbox(inboxPath(root)).find(event => !claimed.has(healRunId(event)) &&
      !existsSync(join(root, 'graph-runs', 'heal-loop', `${healRunId(event)}.json`)));
    if (!next) return undefined;
    const runId = healRunId(next);
    writeFileSync(join(claimDir, `${runId}.json`), JSON.stringify({ active: true, pid: process.pid,
      pidStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString() }), { flag: 'wx' });
    return { event: next, runId };
  });
  if (!selected) return undefined;
  let started = false;
  try {
    const result = await run(file, { runId: selected.runId, input: { failureEvent: selected.event }, deps: { root } });
    started = true;
    return result;
  } finally {
    withInboxLock(inboxPath(root), () => {
      const claim = join(claimDir, `${selected.runId}.json`);
      if (started || existsSync(join(root, 'graph-runs', 'heal-loop', `${selected.runId}.json`))) {
        writeFileSync(claim, JSON.stringify({ active: false, started: true }));
      } else {
        unlinkSync(claim);
      }
    });
    // A completed run opens a slot; a pre-ledger failure waits for the next intake rather than retrying in a tight loop.
    if (started) void Promise.resolve().then(() => startHealLoop(file, options, env, run)).catch(error => {
      debug.log('heal.intake', 'loop-start-failed', { runId: selected.runId, error: String(error) }, { level: 'error' });
    });
  }
}

function inboxPath(root: string): string {
  return join(root, 'heal', 'inbox.jsonl');
}

function readInbox(file: string): FailureEvent[] {
  let content: string;
  try { content = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line) as FailureEvent);
}

/** Lock the read/fold/append transaction across processes, not just within one runner. */
function withInboxLock<T>(file: string, work: () => T): T {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) {
          rmdirSync(lock);
          continue;
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
      if (Date.now() >= deadline) throw new Error(`heal inbox lock is held: ${file}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return work(); }
  finally { rmdirSync(lock); }
}

/** One durable JSON line per failure; repeat source+ref within an hour is folded. */
export function recordFailureEvent(event: FailureEvent, root = effectiveInstanceRoot(), startLoop: StartHealLoop = startHealLoop): { folded: boolean } {
  if (!['release-run', 'harness-run', 'loop-tick', 'cron'].includes(event.source) ||
      !event.kind || !event.ref || !event.summary || !Number.isFinite(Date.parse(event.at))) {
    throw new Error('invalid heal failure event');
  }
  const file = inboxPath(root);
  const folded = withInboxLock(file, () => {
    const incoming = Date.parse(event.at);
    if (readInbox(file).some(previous => previous.source === event.source && previous.ref === event.ref &&
      incoming - Date.parse(previous.at) >= 0 && incoming - Date.parse(previous.at) < FOLD_WINDOW_MS)) return true;
    appendFileSync(file, JSON.stringify(event) + '\n');
    return false;
  });
  debug.log('heal.intake', 'recorded', { source: event.source, kind: event.kind, ref: event.ref, folded });
  // HARNESS-FULL-GRAPH — 하니스 런 실패 사건의 접수가 그래프 노드 heal 이다(출구: started | folded).
  if (event.source === 'harness-run') passJourneyNode('heal', { provenance: 'heal-intake', outcome: folded ? 'folded' : 'started', data: { kind: event.kind, ref: event.ref } });
  if (!folded) {
    const runId = healRunId(event);
    void Promise.resolve().then(() => startLoop(HEAL_GRAPH, { runId, input: { failureEvent: event }, deps: { root } }))
      .catch(error => {
        debug.log('heal.intake', 'loop-start-failed', { source: event.source, kind: event.kind, ref: event.ref, runId, error: String(error) }, { level: 'error' });
      });
  }
  return { folded };
}

export function readFailureInbox({ since }: { since?: string } = {}, root = effectiveInstanceRoot()): FailureEvent[] {
  const threshold = since === undefined ? -Infinity : Date.parse(since);
  if (Number.isNaN(threshold)) throw new Error('invalid heal inbox since');
  return readInbox(inboxPath(root)).filter(event => Date.parse(event.at) >= threshold);
}
