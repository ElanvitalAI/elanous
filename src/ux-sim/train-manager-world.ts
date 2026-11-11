import { debug } from '../debug/log.js';
import { forecastPrPushConflicts, type PrPushConflictForecast } from '../cli/pr-land-overlap-evidence.js';
import type { CmdRunner } from '../autopilot/pr-manager.js';
import { simulateTrainManagerDecision } from './train-manager-decision-sim.js';
import { orderTrainQueueEntries } from '../loops/train/decisions.js';
import { simulateFakeLandQueue, type FakeLandQueueItem, type FakeLandQueueResult } from './fake-land-queue.js';

export interface TrainManagerWorldPr {
  readonly number: number;
  readonly head: string;
  readonly baseRef: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly gate: 'passed' | 'unmeasured' | 'conflict' | 'failed';
  readonly owner: string;
  readonly files: readonly string[];
  readonly radius?: number;
  readonly priority?: 'S1' | 'normal';
  readonly expressRank?: number;
  readonly mustRank?: number;
  readonly solo?: boolean;
}

export interface TrainManagerWorldConflict {
  readonly pr: number;
  readonly otherPr: number;
  readonly files: readonly string[];
}

export interface TrainManagerWorldInput {
  readonly base: string;
  readonly now?: string;
  readonly prs: readonly TrainManagerWorldPr[];
  readonly activePrs?: readonly string[];
  readonly slots?: readonly { host: string; slot: number; expressOnly: boolean }[];
  readonly groupLimit?: number;
  readonly explicitConflicts?: readonly TrainManagerWorldConflict[];
}

export interface TrainManagerWorldEvent {
  readonly at: string;
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface TrainManagerWorldResult {
  readonly base: string;
  readonly mainBasePrs: readonly number[];
  readonly orderedPrs: readonly number[];
  readonly excludedBasePrs: readonly { pr: number; reason: 'base-not-main' | 'not-open' }[];
  readonly assignments: ReturnType<typeof simulateTrainManagerDecision>['assignments'];
  readonly conflictForecastJsonl: string;
  readonly landing: FakeLandQueueResult;
  readonly trace: readonly TrainManagerWorldEvent[];
}

const SHA40 = /^[a-f0-9]{40}$/i;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;

function clonePr(pr: TrainManagerWorldPr): TrainManagerWorldPr {
  return { ...pr, files: [...pr.files] };
}

function fixedClock(start: string) {
  let time = Date.parse(start);
  if (!Number.isFinite(time)) throw new Error('train-manager-world: invalid clock start');
  return {
    now: () => new Date(time),
  };
}

function overlap(left: readonly string[], right: readonly string[]): string[] {
  const other = new Set(right);
  return [...new Set(left.filter(path => other.has(path)))].sort();
}

/**
 * Run the queue, landing, and conflict forecast workflow in a hermetic world.
 * GitHub, merge-tree, clock, and operator mail are memory-backed boundaries;
 * train selection and landing integration call the existing production paths.
 */
export async function simulateTrainManagerWorld(input: TrainManagerWorldInput): Promise<TrainManagerWorldResult> {
  if (!SHA40.test(input.base)) throw new Error('train-manager-world: base must be a 40-character SHA');
  const rows = input.prs.map(clonePr);
  if (new Set(rows.map(pr => pr.number)).size !== rows.length) throw new Error('train-manager-world: PR numbers must be unique');
  for (const pr of rows) {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 || !SHA40.test(pr.head) || !OWNER.test(pr.owner)
      || pr.files.some(path => !path || path.startsWith('/'))) {
      throw new Error(`train-manager-world: invalid PR snapshot #${pr.number}`);
    }
  }

  const clock = fixedClock(input.now ?? '2026-11-10T00:00:00.000Z');
  const trace: TrainManagerWorldEvent[] = [];
  const emit = (event: string, data: Readonly<Record<string, unknown>>) => {
    const record = { at: clock.now().toISOString(), event, data: { ...data } };
    trace.push(record);
    if (debug.enabled) debug.log('train.manager.sim', event, data);
  };

  // fake gh pr list returns an immutable open-PR census.
  const open = rows.filter(pr => pr.state === 'open');
  emit('github.snapshot', { openPrs: open.map(pr => pr.number) });
  const mainPrs = open.filter(pr => pr.baseRef === 'main');
  if (mainPrs.some(pr => pr.radius !== undefined) && mainPrs.some(pr => pr.radius === undefined)) {
    throw new Error('train-manager-world: hotspot radius is only partially measured');
  }
  const excludedBasePrs = rows.filter(pr => pr.state !== 'open' || pr.baseRef !== 'main').map(pr => ({
    pr: pr.number, reason: pr.state !== 'open' ? 'not-open' as const : 'base-not-main' as const,
  }));
  emit('train.base-filter', { accepted: mainPrs.map(pr => pr.number), excluded: excludedBasePrs });

  const decisionQueue = mainPrs.map(pr => ({ pr: String(pr.number), head: pr.head, state: 'open' as const, gate: pr.gate,
    files: pr.radius === undefined ? undefined : pr.files, radius: pr.radius, priority: pr.priority,
    expressRank: pr.expressRank, mustRank: pr.mustRank, solo: pr.solo }));
  const orderedPrs = orderTrainQueueEntries(decisionQueue).map(row => mainPrs.find(pr => pr.number === Number(row.pr))!);
  const decision = simulateTrainManagerDecision({
    base: input.base,
    queue: decisionQueue,
    activePrs: input.activePrs ?? [],
    refusals: [],
    lastParks: [],
    slots: input.slots ?? [{ host: 'aws1', slot: 1, expressOnly: false }],
    groupLimit: input.groupLimit ?? 4,
  });
  emit('train.tick', { assignments: decision.assignments });
  const assignedNumbers = new Set(decision.assignments.filter(row => row.stage !== 'preflight').flatMap(row => row.prs.map(Number)));

  const explicit = new Map((input.explicitConflicts ?? []).map(conflict => [`${conflict.pr}:${conflict.otherPr}`, conflict.files]));
  const forecasts: PrPushConflictForecast[] = [];
  let mergeTreeCallCount = 0;
  for (let leftIndex = 0; leftIndex < mainPrs.length; leftIndex += 1) {
    const left = mainPrs[leftIndex]!;
    const peers = mainPrs.slice(leftIndex + 1).map(right => ({ pr: right.number, head: right.head,
      files: right.files, owner: right.owner }));
    const fakeRun: CmdRunner = (_command, args) => {
      const [operation, ...rest] = args;
      if (operation === 'diff' && rest.includes('--name-only') && rest.includes('-z'))
        return { ok: true, out: [...left.files].join('\0') + (left.files.length ? '\0' : ''), err: '' };
      if (operation === 'rev-parse') {
        const peerHead = rest.at(-1) ?? '';
        return peers.some(peer => peer.head === peerHead)
          ? { ok: true, out: peerHead, err: '' } : { ok: false, out: '', err: 'unknown fake peer head' };
      }
      if (operation === 'merge-tree') {
        const peerHead = rest.at(-1) ?? '';
        const peer = peers.find(row => row.head === peerHead);
        if (!peer) return { ok: false, out: '', err: 'unknown fake peer head' };
        const paths = [...(explicit.get(`${left.number}:${peer.pr}`) ?? explicit.get(`${peer.pr}:${left.number}`)
          ?? overlap(left.files, peer.files))].sort();
        mergeTreeCallCount += 1;
        return paths.length
          ? { ok: false, out: `${'e'.repeat(40)}\0${paths.join('\0')}\0\0`, err: '' }
          : { ok: true, out: `${'e'.repeat(40)}\0`, err: '' };
      }
      return { ok: false, out: '', err: `unsupported fake git operation: ${operation ?? ''}` };
    };
    forecastPrPushConflicts({ cwd: '/fake/train-manager-world', pr: left.number, head: left.head,
      base: input.base, owner: left.owner, peers, run: fakeRun, now: () => clock.now(),
      append: row => forecasts.push(row) });
  }
  for (const row of forecasts) if (row.conflict === true) emit('conflict.forecast', { pr: row.pr, otherPr: row.otherPr, files: row.files });
  emit('merge-tree.probe', { calls: mergeTreeCallCount });

  const queueOrder = orderedPrs.filter(pr => assignedNumbers.has(pr.number)).map(pr => pr.number);
  const admittedNumbers = new Set(queueOrder);
  const landingQueue: FakeLandQueueItem[] = queueOrder.map(number => {
    const pr = mainPrs.find(row => row.number === number)!;
    // Forecast owns real path overlaps; unique synthetic paths keep the batch scheduler from
    // pre-filtering those candidates before merge-train can exercise its fake merge-tree.
    return { number, head: pr.head, files: [`__train_manager_world__/${number}`] };
  });
  const conflictNumbers = new Set<number>();
  for (const row of forecasts) if (row.conflict === true && row.otherPr !== null
    && row.pr !== null && admittedNumbers.has(row.pr) && admittedNumbers.has(row.otherPr)) conflictNumbers.add(row.otherPr);
  const landing = await simulateFakeLandQueue({ queue: landingQueue, load: 70, conflicting: [...conflictNumbers] });
  emit('train.land-simulation', { departed: landing.departed, verdicts: landing.verdicts });

  return {
    base: input.base,
    mainBasePrs: mainPrs.map(pr => pr.number),
    orderedPrs: orderedPrs.map(pr => pr.number),
    excludedBasePrs,
    assignments: decision.assignments,
    conflictForecastJsonl: forecasts.map(row => JSON.stringify(row)).join('\n') + (forecasts.length ? '\n' : ''),
    landing,
    trace,
  };
}
