/** Immediate TA repair collection. The card and atomic worker result remain authoritative. */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { spawnElanous } from '../instance/spawn-elanous.js';
import { acquireLockSync } from '../storage/file-lock.js';
import { subscribeInsideEvent, type InsideLiveEvent } from '../nexus/api/inside-events.js';
import type { NexusEventBus } from '../nexus/api/event-bus.js';
import { parseRepairWorkerResult } from '../task-agent/repair-worker.js';
import { pairMoveId } from '../task-agent/repair-next-move.js';
import { readTaskCard, taskAgentStatePath } from '../task-agent/task-hand.js';

const SHA40 = /^[0-9a-f]{40}$/i;
const CARD = /^ta-[a-z0-9-]{1,80}$/;
const TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 1024 * 1024;

export interface TaRepairCompleted {
  kind: 'ta.repair.completed'; schema: 1; card: string; pr: number; head: string;
  runId: string; resultPath: string; completedAt: string;
  /** HARNESS-FULL-GRAPH-NEXTMOVE — worker 가 받은 수 id(옛 worker 는 없다 · 꼴이 틀려도 사건을 버리지 않고 짝짓기에서 «못 짝지음»으로 남긴다). */
  moveId?: string;
}

export function parseTaRepairCompleted(value: unknown): TaRepairCompleted | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'ta.repair.completed' || v.schema !== 1 || typeof v.card !== 'string' || !CARD.test(v.card)
    || !Number.isSafeInteger(v.pr) || Number(v.pr) < 1 || typeof v.head !== 'string' || !SHA40.test(v.head)
    || typeof v.runId !== 'string' || !/^run-[a-z0-9-]{1,100}$/i.test(v.runId)
    || typeof v.resultPath !== 'string' || !v.resultPath.startsWith('/')
    || typeof v.completedAt !== 'string' || !Number.isFinite(Date.parse(v.completedAt))) return null;
  return v as unknown as TaRepairCompleted;
}

export interface TaRepairCollectDeps {
  statePath?: string;
  /** Test entry for a child that runs the real tasks CLI with isolated dependencies. */
  cliBin?: string;
  read?: (path: string) => string;
  run?: (card: string) => Promise<{ code: number | null; output: string; truncated?: boolean }>;
  now?: () => Date;
  log?: (data: Record<string, unknown>) => void;
}

function defaultRun(card: string, statePath: string, cliBin?: string): Promise<{ code: number | null; output: string; truncated?: boolean }> {
  return new Promise(done => {
    const child = spawnElanous(['tasks', 'rejudge', card, '--json'], { stateDir: dirname(statePath),
      ...(cliBin ? { bin: cliBin } : {}), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let truncated = false;
    let settled = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (force) clearTimeout(force);
      done({ code, output, truncated });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      // Keep the card lock until close confirms the child has stopped writing the card.
      force = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
    }, TIMEOUT_MS);
    const append = (chunk: unknown) => {
      const next = output + String(chunk);
      if (next.length > OUTPUT_LIMIT) { truncated = true; output = next.slice(-OUTPUT_LIMIT); }
      else output = next;
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    // Node emits close after error, including spawn failure. An error can also
    // describe a failed kill while the child is still alive: keep the lock.
    child.once('error', (error) => { append(`\nchild error: ${String(error)}`); });
    child.once('close', finish);
  });
}

function childConsumedRepair(output: string, event: TaRepairCompleted): boolean {
  for (const line of output.split(/\r?\n/).reverse()) {
    if (!line.trimStart().startsWith('[')) continue;
    try {
      const rows: unknown = JSON.parse(line);
      if (Array.isArray(rows) && rows.some(row => row && typeof row === 'object' && row.card === event.card
        && row.pr === event.pr && row.repairRunId === event.runId && row.repairHead === event.head
        && row.step === 'repair' && (row.decision === 'repair-applied' || row.decision === 'repair-failed'))) return true;
    } catch { /* not a JSON result line */ }
  }
  return false;
}

/** One event may start one card rejudge. A periodic rejudge can race; its existing card CAS still owns side effects. */
export async function collectTaRepairCompleted(input: unknown, deps: TaRepairCollectDeps = {}): Promise<'invalid' | 'duplicate' | 'deferred' | 'collected'> {
  const event = parseTaRepairCompleted(input);
  if (!event) return 'invalid';
  const statePath = deps.statePath ?? taskAgentStatePath();
  const emit = (outcome: string, extra: Record<string, unknown> = {}) => {
    const collectedAt = (deps.now?.() ?? new Date()).toISOString();
    const data = { card: event.card, pr: event.pr, runId: event.runId, completedAt: event.completedAt,
      collectedAt, ...(outcome === 'collected' ? { latencyMs: Date.parse(collectedAt) - Date.parse(event.completedAt) } : {}),
      delivery: 'event', outcome, ...extra };
    try { (deps.log ?? ((d) => debug.log('task-agent', 'ta.repair.collected', d)))(data); } catch { /* observability cannot change the result */ }
  };
  let card;
  try { card = readTaskCard(event.card, statePath); } catch { emit('deferred', { reason: 'card unreadable' }); return 'deferred'; }
  const repair = Array.isArray(card?.repairs) ? card.repairs.find(entry => entry && typeof entry === 'object' && entry.runId === event.runId) : undefined;
  // NEXTMOVE-GENERAL-RELAUNCH-MOVEID — 사건의 수 id 를 카드(발사 순간 적은 값)와 짝짓는다. 결과는 관측 칸에만 싣는다(fail-soft · 수거 판단은 그대로).
  const observedMoveId: unknown = (event as { moveId?: unknown }).moveId;
  const pairing = pairMoveId(repair?.moveId, observedMoveId);
  const moveFields: Record<string, unknown> = pairing.kind === 'legacy' ? {}
    : { moveId: pairing.kind === 'paired' ? pairing.moveId : typeof observedMoveId === 'string' ? observedMoveId : null,
      moveIdPaired: pairing.kind === 'paired', ...(pairing.kind === 'unpaired' ? { expectedMoveId: pairing.expected } : {}) };
  const emitPaired = (outcome: string, extra: Record<string, unknown> = {}) => emit(outcome, { ...moveFields, ...extra });
  if (!repair || repair.pr !== event.pr || typeof repair.head !== 'string' || repair.head.toLowerCase() !== event.head.toLowerCase()
    || typeof repair.resultPath !== 'string' || !repair.resultPath.startsWith('/')
    // 카드 귀속이 안 맞는 사건엔 짝짓기 칸을 싣지 않는다 — 남의 수리와 대조한 값이 관측에 섞이지 않게(r1 should-fix).
    || resolve(repair.resultPath) !== resolve(event.resultPath)) { emit('invalid', { reason: 'event differs from card binding' }); return 'invalid'; }
  if (repair.status !== 'requested') { emitPaired('duplicate', { reason: `repair ${repair.status}` }); return 'duplicate'; }
  let result;
  try { result = parseRepairWorkerResult((deps.read ?? ((path) => readFileSync(path, 'utf8')))(repair.resultPath), event.pr, event.head, event.runId); }
  catch { /* periodic tick can recover a missing result */ }
  if (!result) { emitPaired('deferred', { reason: 'worker result missing or invalid' }); return 'deferred'; }

  // Existing PID-aware lock recovers a dead daemon without making later events wait forever.
  // A live holder keeps the lock through the child process; the card CAS covers periodic-tick races.
  const lock = join(dirname(statePath), 'steward', 'ta-repair-collect', `${event.card}.lock`);
  let release: () => void;
  try {
    mkdirSync(dirname(lock), { recursive: true });
    release = acquireLockSync(lock, { breakDeadHolder: true, staleMs: TIMEOUT_MS + 60_000, maxTries: 2 });
  }
  catch { emitPaired('deferred', { reason: 'collector busy; periodic fallback remains' }); return 'deferred'; }
  try {
    // Recheck after claiming: another collector or the periodic tick may have consumed the file.
    const current = readTaskCard(event.card, statePath);
    const latest = Array.isArray(current?.repairs) ? current.repairs.find(entry => entry && typeof entry === 'object' && entry.runId === event.runId) : undefined;
    if (!latest || latest.status !== 'requested' || latest.pr !== event.pr || typeof latest.head !== 'string'
      || latest.head.toLowerCase() !== event.head.toLowerCase() || typeof latest.resultPath !== 'string'
      || !latest.resultPath.startsWith('/') || resolve(latest.resultPath) !== resolve(event.resultPath)) { emitPaired('duplicate'); return 'duplicate'; }
    const child = await (deps.run ?? ((card) => defaultRun(card, statePath, deps.cliBin)))(event.card);
    const after = readTaskCard(event.card, statePath)?.repairs?.find(entry => entry.runId === event.runId);
    const consumed = child.code === 0 && !child.truncated && after?.status !== 'requested' && after !== undefined
      && childConsumedRepair(child.output, event);
    const outcome = consumed ? 'collected' : child.truncated ? 'deferred' : after && after.status !== 'requested' ? 'duplicate' : 'deferred';
    emitPaired(outcome, { rc: child.code, repairStatus: after?.status,
      ...(child.truncated ? { reason: 'rejudge output exceeded 1 MiB; event attribution unmeasured' } : {}),
      detail: child.output.slice(-300) });
    return consumed ? 'collected' : outcome === 'duplicate' ? 'duplicate' : 'deferred';
  } catch (error) {
    emitPaired('deferred', { reason: String(error).slice(-300) });
    return 'deferred';
  } finally { release(); }
}

/** Bridge child-process inside events to Nexus pub/sub; keep the handler nonblocking. */
export function startTaRepairEventCollector(bus: NexusEventBus, deps: TaRepairCollectDeps = {}): () => void {
  const unsubscribeBus = bus.subscribe(event => {
    void collectTaRepairCompleted(event.detail, deps).catch(error => {
      try { debug.log('task-agent', 'ta.repair.collect-error', { reason: String(error).slice(-300) }, { level: 'warn' }); }
      catch { /* observer failure cannot reject the Nexus callback */ }
    });
  }, ['ta.repair.completed']);
  const unsubscribeInside = subscribeInsideEvent((event: InsideLiveEvent) => {
    if (event.kind !== 'ta.repair.completed') return;
    bus.publish({ kind: 'ta.repair.completed', ts: Date.now(), detail: event as unknown as Record<string, unknown> });
  });
  return () => { unsubscribeInside(); unsubscribeBus(); };
}
