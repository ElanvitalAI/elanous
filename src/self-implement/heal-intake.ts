import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { debug } from '../debug/log.js';
import { passJourneyNode } from '../self-dev/graph-journey-nodes.js';
import { getUserConfig } from '../user-config.js';
import { psProcessStartMs, START_TOLERANCE_MS } from '../harness/harness-stop.js';
import { appendRunLedgerEntry, runLedgerDir } from './run-ledger.js';

export type FailureSource = 'release-run' | 'harness-run' | 'loop-tick' | 'cron';

export interface FailureEvent {
  source: FailureSource;
  kind: string;
  ref: string;
  summary: string;
  goalText?: string;
  goalId?: string;
  goalFile?: string;
  cellKey?: string;
  at: string;
}

const FOLD_WINDOW_MS = 60 * 60 * 1_000;
const HEAL_GRAPH = join(import.meta.dir, '../../graphs/heal/heal-loop.yaml');

type HealLoopOptions = { runId: string; input: { failureEvent: FailureEvent; runId?: string; goal?: string; goalId?: string; goalFile?: string }; deps: { root: string } };
type StartHealLoop = (file: string, options: HealLoopOptions) => Promise<unknown>;
export type HealRelaunch = (input: { runId: string; goalText: string; goalId?: string; goalFile?: string; cellKey: string; stateRoot: string }) => Promise<unknown>;

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
  run: StartHealLoop = async (graph, args) => (await import('../graph-runner/runner.js')).runGraph(graph, args),
  relaunch: HealRelaunch = runReauthoredGoal): Promise<unknown> {
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
    const result = await run(file, { runId: selected.runId, input: { failureEvent: selected.event, runId: selected.event.ref, goal: selected.event.goalText, goalId: selected.event.goalId, goalFile: selected.event.goalFile }, deps: { root } });
    started = true;
    const request = reauthorRequest(result);
    if (request) {
      const cellKey = selected.event.goalId || selected.event.goalFile || selected.event.cellKey
        || (selected.event.goalText?.trim() ? `goal:${createHash('sha256').update(selected.event.goalText.replace(/\s+/g, ' ').trim()).digest('hex')}` : `run:${selected.event.ref}`);
      if (!claimReauthorAttempt(root, cellKey, selected.runId)) {
        debug.log('heal.intake', 'reauthor-already-attempted', { runId: selected.runId, goalId: selected.event.goalId ?? null });
        return { result, reauthor: 'already-attempted' };
      }
      try {
        debug.log('self-dev.supervisor', 'reauthor-relaunch-requested', { runId: selected.runId, goalId: selected.event.goalId ?? null });
        const relaunched = await relaunch({ runId: selected.event.ref, goalText: request.revisedGoal,
          ...(selected.event.goalId ? { goalId: selected.event.goalId } : {}),
          ...(selected.event.goalFile ? { goalFile: selected.event.goalFile } : {}), cellKey, stateRoot: root });
        if (relaunched && typeof relaunched === 'object' && 'ok' in relaunched && (relaunched as { ok?: unknown }).ok !== true) {
          const value = relaunched as { stage?: unknown; node?: unknown; outcome?: unknown };
          throw new Error(`needs-human: reauthored run failed (${String(value.stage ?? value.node ?? value.outcome ?? 'unknown')})`);
        }
        appendRunLedgerEntry({ timestamp: new Date().toISOString(), runId: selected.event.ref, event: 'reauthor-relaunch-result',
          data: { outcome: 'started', goalId: selected.event.goalId ?? null, requestRunId: selected.runId, result: summarizeRelaunch(relaunched) } }, runLedgerDir(root));
        return { result, reauthor: 'relaunched', relaunched };
      } catch (error) {
        appendRunLedgerEntry({ timestamp: new Date().toISOString(), runId: selected.event.ref, event: 'reauthor-relaunch-result',
          data: { outcome: 'needs-human', reason: error instanceof Error ? error.message : String(error) } }, runLedgerDir(root));
        return { result, reauthor: 'needs-human', reason: error instanceof Error ? error.message : String(error) };
      }
    }
    const replanFailure = reauthorFailure(result);
    if (replanFailure) {
      appendRunLedgerEntry({ timestamp: new Date().toISOString(), runId: selected.event.ref, event: 'reauthor-relaunch-result',
        data: { outcome: 'needs-human', reason: replanFailure, graphRunId: selected.runId } }, runLedgerDir(root));
      return { result, reauthor: 'needs-human', reason: replanFailure };
    }
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
    if (started) void Promise.resolve().then(() => startHealLoop(file, options, env, run, relaunch)).catch(error => {
      debug.log('heal.intake', 'loop-start-failed', { runId: selected.runId, error: String(error) }, { level: 'error' });
    });
  }
}

function graphOutput(result: unknown, nodeId: string): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const nodes = (result as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return undefined;
  const node = nodes.find((item) => item && typeof item === 'object' && (item as { nodeId?: unknown }).nodeId === nodeId) as { output?: unknown } | undefined;
  if (typeof node?.output === 'string') {
    const text = node.output.trim().split(/\r?\n/).at(-1) ?? '';
    try { return JSON.parse(text) as Record<string, unknown>; } catch { return undefined; }
  }
  return node?.output && typeof node.output === 'object' ? node.output as Record<string, unknown> : undefined;
}

function reauthorRequest(result: unknown): { revisedGoal: string } | undefined {
  const output = graphOutput(result, 'replan');
  return output?.outcome === 'ok' && output.reauthor === true && typeof output.revisedGoal === 'string' && output.revisedGoal.trim()
    ? { revisedGoal: output.revisedGoal } : undefined;
}

function reauthorFailure(result: unknown): string | undefined {
  const output = graphOutput(result, 'replan');
  return output?.outcome === 'fail' && output.needsHuman === true
    ? (typeof output.reason === 'string' ? output.reason : 'reauthor could not produce a safe revised goal') : undefined;
}

function claimReauthorAttempt(root: string, cellKey: string, runId: string): boolean {
  const path = join(root, 'heal', 'reauthor-attempts', `${createHash('sha256').update(cellKey).digest('hex')}.json`);
  return withInboxLock(path, () => {
    if (existsSync(path)) return false;
    writeFileSync(path, JSON.stringify({ cellKey, runId, claimedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    return true;
  });
}

function summarizeRelaunch(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return { resultType: typeof result };
  const value = result as Record<string, unknown>;
  return Object.fromEntries(['ok', 'stage', 'node', 'runId', 'worktreePath', 'branch', 'detail'].flatMap((key) => key in value ? [[key, value[key]]] : []));
}

async function runReauthoredGoal(input: Parameters<HealRelaunch>[0]): Promise<unknown> {
  const [{ runSelfImplement, readQuotaExhausted }, { defaultSeams }, devCli, { reselectChildForRework }, { resolveGrokCredential }, { inspectCodexRotation }, ledger] = await Promise.all([
    import('./orchestrator.js'), import('./seams.js'), import('../self-dev/dev-cli.js'), import('./rework-child-provider.js'),
    import('../grok/credential.js'), import('../oauth/codex-account-store.js'), import('./run-ledger.js'),
  ]);
  let childLlm = devCli.buildChildLlmSelection({});
  if (childLlm?.provider === 'grok') {
    const grokQuota = devCli.readGrokQuotaForLaunch();
    const grokCredential = resolveGrokCredential() ? 'available' as const : 'unavailable' as const;
    const rotation = inspectCodexRotation();
    const quota = readQuotaExhausted(inspectCodexRotation, 'openai-codex');
    const hasCodex = rotation.knownAccountCount > 0;
    const alternate = hasCodex ? { provider: 'openai-codex', model: devCli.defaultChildLlmModel('openai-codex'), source: 'config' as const } : undefined;
    const decision = reselectChildForRework({ current: childLlm, grokQuota, grokCredential, ...(alternate ? { alternate } : {}),
      alternateCredential: hasCodex ? 'available' : 'unavailable', alternateQuotaExhausted: quota.exhausted });
    if (decision.action === 'reselect') {
      childLlm = decision.selection;
      ledger.appendRunLedgerEntry({ timestamp: new Date().toISOString(), runId: input.runId, event: 'rework-child-model-reselected',
        data: { previousProvider: decision.previous.provider, previousModel: decision.previous.model, provider: childLlm.provider,
          model: childLlm.model, reason: decision.reason, quota: grokQuota, grokCredential,
          alternateQuotaExhausted: quota.exhausted ?? null } }, runLedgerDir(input.stateRoot));
    }
    else if (grokQuota === 'exhausted' || grokCredential === 'unavailable') throw new Error('needs-human: Grok unusable and no measured alternate provider');
  }
  const runId = `reauthor-${createHash('sha256').update(`${input.runId}\0${input.goalId ?? ''}`).digest('hex').slice(0, 20)}`;
  return runSelfImplement({ feature: input.goalText, runId, ...(input.goalId ? { goalId: input.goalId } : {}),
    ...(input.goalFile ? { goalFile: input.goalFile } : {}), healCellKey: input.cellKey, ...(childLlm ? { childLlm } : {}),
    completion: 'worktree-only', draft: true, maxReworkRounds: 0, seams: defaultSeams({ stateDir: input.stateRoot }) });
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

/** One durable JSON line per failure; repeat source+ref within an hour is folded.
 *  POD-HEAL-HOST — the loop start itself is refused inside a Pod (`startHealLoop` → `skipped-in-pod`):
 *  a loop started there dies with the Pod. The line stays in the inbox, and the host re-records the
 *  recovered Pod ledger failure into the HOST universe (`pod-ledger-collect.ts` → `intakeCollectedFailure`),
 *  so the host heal loop triages it (harvest + narrowed relaunch). */
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
