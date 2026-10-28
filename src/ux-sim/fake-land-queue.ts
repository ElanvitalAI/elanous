/** In-process LAND-QUEUE simulator. Scheduling and verdict logic use the production train functions;
 * only git's merge-tree/commit-tree and the remote gate are replaced. */
import { integrateTrain, runTrain, type TrainCandidate, type TrainGit, type TrainVerdict } from '../self-implement/merge-train.js';

export type FakeLandQueueItem = TrainCandidate & { files: string[] };
export type FakeLandQueueInput = {
  readonly queue: readonly FakeLandQueueItem[];
  readonly load: number;
  readonly previousSlots?: 2 | 3;
  readonly cutWindowOpen?: boolean;
  readonly expedite?: number;
  readonly eject?: readonly number[];
  readonly conflicting?: readonly number[];
  readonly gates?: readonly ('pass' | 'fail' | 'unmeasured')[];
};
export type FakeLandQueueResult = {
  readonly slots: 2 | 3;
  readonly departed: readonly (readonly number[])[];
  readonly waiting: readonly number[];
  readonly ejected: readonly number[];
  readonly stoppedAtCut: boolean;
  readonly verdicts: readonly TrainVerdict[];
};

/** Hysteresis prevents slot oscillation: below 60% expand; at/above 80% contract. */
export function fakeLandSlots(load: number, previous: 2 | 3 = 2): 2 | 3 {
  if (!Number.isFinite(load) || load < 0 || load > 100) throw new Error('load must be between 0 and 100');
  if (load < 60) return 3;
  if (load >= 80) return 2;
  return previous;
}

function syntheticGit(conflicting: ReadonlySet<number>, prByHead: ReadonlyMap<string, number>): TrainGit {
  let commit = 0;
  const sha = (n: number) => n.toString(16).padStart(40, '0');
  return (args) => {
    const command = args.find((arg) => arg === 'merge-tree' || arg === 'commit-tree');
    if (command === 'merge-tree') {
      const pr = prByHead.get(args.at(-1) ?? '');
      return pr !== undefined && conflicting.has(pr)
        ? { status: 1, stdout: `${sha(900 + (pr ?? 0))}\0src/conflict.ts\0\0`, stderr: '' }
        : { status: 0, stdout: `${sha(900 + (pr ?? 0))}\0`, stderr: '' };
    }
    if (command === 'commit-tree') return { status: 0, stdout: sha(++commit), stderr: '' };
    return { status: 2, stdout: '', stderr: `unsupported fake git command: ${args[0]}` };
  };
}

/** One dry-run tick. Cut-window closure and ejection never call the train; no ref is updated. */
export async function simulateFakeLandQueue(input: FakeLandQueueInput): Promise<FakeLandQueueResult> {
  const ejected = new Set(input.eject ?? []);
  const queue = input.queue.filter((item) => !ejected.has(item.number)).map((item) => ({ ...item, files: [...item.files] }));
  if (input.expedite !== undefined) {
    const at = queue.findIndex((item) => item.number === input.expedite);
    if (at >= 0) queue.unshift(...queue.splice(at, 1));
  }
  const slots = fakeLandSlots(input.load, input.previousSlots);
  if (input.cutWindowOpen === false) return {
    slots, departed: [], waiting: queue.map((item) => item.number), ejected: [...ejected], stoppedAtCut: true, verdicts: [],
  };

  const departed: number[][] = [];
  const waiting: number[] = [];
  const verdicts: TrainVerdict[] = [];
  const gates = [...(input.gates ?? [])];
  const git = syntheticGit(new Set(input.conflicting ?? []), new Map(queue.map((item) => [item.head, item.number])));
  while (queue.length) {
    const batch: FakeLandQueueItem[] = [];
    const occupied = new Set<string>();
    for (let i = 0; i < queue.length && batch.length < slots;) {
      const candidate = queue[i]!;
      if (candidate.files.some((file) => occupied.has(file))) { waiting.push(candidate.number); queue.splice(i, 1); continue; }
      batch.push(candidate); queue.splice(i, 1); candidate.files.forEach((file) => occupied.add(file));
    }
    if (!batch.length) break;
    departed.push(batch.map((item) => item.number));
    const train = await runTrain(batch, {
      integrate: (candidates) => {
        const integrated = integrateTrain('/fake-land-queue', '1'.repeat(40), candidates, git);
        return integrated;
      },
      gate: async () => gates.shift() ?? 'pass',
      observe: () => {},
    });
    verdicts.push(...train.verdicts);
  }
  return { slots, departed, waiting: [...waiting, ...queue.map((item) => item.number)], ejected: [...ejected], stoppedAtCut: false, verdicts };
}
