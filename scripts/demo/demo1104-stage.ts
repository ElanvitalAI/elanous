import { DEMO1104_STAGE_CONFIG, type DemoActId, type DemoLaneId } from './demo1104-stage.config.js';

type Act = typeof DEMO1104_STAGE_CONFIG.acts[number];
type Lane = typeof DEMO1104_STAGE_CONFIG.lanes[number];
type ActStatus = 'pending' | 'running' | 'live' | 'failed' | 'video';
type TimerHandle = ReturnType<typeof setTimeout>;
type TimerScheduler = {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};
type LaneStatus = 'pending' | 'running' | 'started' | 'failed';
type VideoTrigger = 'failure' | 'deadline' | 'manual';
type VideoTransition = { actId: DemoActId; videoId: string; trigger: VideoTrigger; failedAt: number; requestedAt: number; completedAt: number | null; latencyMs: number | null; status: 'shown' | 'failed' | 'superseded'; error: string | null };

export type StageAdapters = {
  startLane(lane: Lane): Promise<void>;
  runAct(act: Act, signal: AbortSignal): Promise<void>;
  showVideo(videoId: string, act: Act, signal: AbortSignal): Promise<void>;
};

export type StageSnapshot = {
  startedAt: number | null;
  elapsedMs: number;
  lanes: Array<{ id: DemoLaneId; title: string; startsAtAct: DemoActId; status: LaneStatus; startedAt: number | null }>;
  acts: Array<{ id: DemoActId; title: string; targetStartSec: number; targetEndSec: number; videoId: string | null; status: ActStatus }>;
  transitions: VideoTransition[];
};

export function createDemoStageConsole(options: {
  adapters: StageAdapters;
  now?: () => number;
  timers?: TimerScheduler;
}): {
  start(): Promise<void>;
  runActNow(id: DemoActId): Promise<void>;
  switchToVideo(id: DemoActId): Promise<void>;
  snapshot(): StageSnapshot;
} {
  const now = options.now ?? Date.now;
  const timers: TimerScheduler = options.timers ?? {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as TimerHandle,
    clearTimeout: handle => clearTimeout(handle),
  };
  const startedAt = { value: null as number | null };
  const laneStarts = new Map<DemoLaneId, number>();
  const laneStatuses = new Map<DemoLaneId, LaneStatus>(
    DEMO1104_STAGE_CONFIG.lanes.map(lane => [lane.id, 'pending']),
  );
  const actStatuses = new Map<DemoActId, ActStatus>(DEMO1104_STAGE_CONFIG.acts.map(act => [act.id, 'pending']));
  const actGenerations = new Map<DemoActId, number>();
  const actControllers = new Map<DemoActId, { generation: number; controller: AbortController }>();
  const videoControllers = new Map<DemoActId, { generation: number; controller: AbortController }>();
  const transitions: VideoTransition[] = [];
  const abortActWork = (id: DemoActId): void => {
    actControllers.get(id)?.controller.abort();
    videoControllers.get(id)?.controller.abort();
  };
  const nextActGeneration = (id: DemoActId): number => {
    abortActWork(id);
    const next = (actGenerations.get(id) ?? 0) + 1;
    actGenerations.set(id, next);
    return next;
  };
  const isCurrentActGeneration = (id: DemoActId, generation: number): boolean => actGenerations.get(id) === generation;

  const actFor = (id: DemoActId): Act => {
    const act = DEMO1104_STAGE_CONFIG.acts.find(candidate => candidate.id === id);
    if (!act) throw new Error(`Unknown demo act: ${id}`);
    return act;
  };

  const switchToVideo = async (id: DemoActId, failedAt: number, trigger: VideoTrigger, generation: number): Promise<void> => {
    const act = actFor(id);
    if (!act.highlightVideoId) throw new Error(`${id} has no configured highlight video`);
    if (!isCurrentActGeneration(id, generation)) return;
    const requestedAt = now();
    const transition: VideoTransition = { actId: id, videoId: act.highlightVideoId, trigger, failedAt, requestedAt, completedAt: null, latencyMs: null, status: 'failed', error: null };
    transitions.push(transition);
    const controller = new AbortController();
    videoControllers.set(id, { generation, controller });
    const remainingMs = DEMO1104_STAGE_CONFIG.failoverDeadlineMs - (requestedAt - failedAt);
    if (remainingMs <= 0) {
      transition.error = `video display exceeded ${DEMO1104_STAGE_CONFIG.failoverDeadlineMs}ms`;
      if (isCurrentActGeneration(id, generation)) actStatuses.set(id, 'failed');
      controller.abort();
      videoControllers.delete(id);
      throw new Error(`${id} video transition failed: ${transition.error}`);
    }
    let timeout: TimerHandle | undefined;
    let timedOut = false;
    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new Error('video transition superseded'));
      if (controller.signal.aborted) onAbort();
      else {
        controller.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
      }
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = timers.setTimeout(() => {
        timedOut = true;
        reject(new Error(`video display exceeded ${DEMO1104_STAGE_CONFIG.failoverDeadlineMs}ms`));
      }, remainingMs);
    });
    const display = Promise.resolve()
      .then(() => options.adapters.showVideo(act.highlightVideoId!, act, controller.signal))
      .then(() => {
        transition.completedAt = now();
        transition.latencyMs = transition.completedAt - failedAt;
      });
    try {
      await Promise.race([display, deadline, aborted]);
      if (transition.latencyMs! > DEMO1104_STAGE_CONFIG.failoverDeadlineMs) {
        timedOut = true;
        throw new Error(`video display exceeded ${DEMO1104_STAGE_CONFIG.failoverDeadlineMs}ms`);
      }
      if (!isCurrentActGeneration(id, generation)) {
        transition.status = 'superseded';
        transition.error = 'video transition superseded';
        return;
      }
      transition.status = 'shown';
      actStatuses.set(id, 'video');
    } catch (error) {
      if (!isCurrentActGeneration(id, generation)) {
        transition.status = 'superseded';
        transition.error = 'video transition superseded';
        return;
      }
      transition.error = timedOut ? `video display exceeded ${DEMO1104_STAGE_CONFIG.failoverDeadlineMs}ms` : error instanceof Error ? error.message : String(error);
      if (isCurrentActGeneration(id, generation)) actStatuses.set(id, 'failed');
      controller.abort();
      throw new Error(`${id} video transition failed: ${transition.error}`);
    } finally {
      removeAbortListener();
      if (timeout) timers.clearTimeout(timeout);
      if (videoControllers.get(id)?.generation === generation) videoControllers.delete(id);
    }
  };

  return {
    async start() {
      if (startedAt.value !== null) throw new Error('Demo stage already started');
      startedAt.value = now();
      // Invoke both lanes before awaiting either one so the two story lines start together.
      const launches = DEMO1104_STAGE_CONFIG.lanes.map(lane => {
        laneStatuses.set(lane.id, 'running');
        const laneStartedAt = now();
        laneStarts.set(lane.id, laneStartedAt);
        return options.adapters.startLane(lane).then(
          () => { laneStatuses.set(lane.id, 'started'); },
          error => { laneStatuses.set(lane.id, 'failed'); throw error; },
        );
      });
      await Promise.all(launches);
    },

    async runActNow(id) {
      if (startedAt.value === null) throw new Error('Start the demo stage before running an act');
      const act = actFor(id);
      const generation = nextActGeneration(id);
      const controller = new AbortController();
      actControllers.set(id, { generation, controller });
      actStatuses.set(id, 'running');
      let timeout: TimerHandle | undefined;
      let failedAt: number | undefined;
      let trigger: VideoTrigger = 'failure';
      let removeAbortListener = () => {};
      const timeoutMs = DEMO1104_STAGE_CONFIG.failoverDeadlineMs;
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new Error('act execution superseded'));
        if (controller.signal.aborted) onAbort();
        else {
          controller.signal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
        }
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = timers.setTimeout(() => {
          failedAt = now();
          trigger = 'deadline';
          reject(new Error(`Act exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      });
      try {
        await Promise.race([options.adapters.runAct(act, controller.signal), deadline, aborted]);
        if (!isCurrentActGeneration(id, generation)) return;
        actStatuses.set(id, 'live');
      } catch {
        if (!isCurrentActGeneration(id, generation)) return;
        failedAt ??= now();
        actStatuses.set(id, 'failed');
        if (!act.highlightVideoId) throw new Error(`${id} failed and has no configured highlight video`);
        controller.abort();
        if (actControllers.get(id)?.generation === generation) actControllers.delete(id);
        await switchToVideo(id, failedAt, trigger, generation);
      } finally {
        removeAbortListener();
        if (timeout) timers.clearTimeout(timeout);
        if (actControllers.get(id)?.generation === generation) actControllers.delete(id);
      }
    },

    switchToVideo(id) {
      if (startedAt.value === null) throw new Error('Start the demo stage before switching to video');
      if (!actFor(id).highlightVideoId) throw new Error(`${id} has no configured highlight video`);
      const generation = nextActGeneration(id);
      return switchToVideo(id, now(), 'manual', generation);
    },

    snapshot() {
      const current = now();
      return {
        startedAt: startedAt.value,
        elapsedMs: startedAt.value === null ? 0 : Math.max(0, current - startedAt.value),
        lanes: DEMO1104_STAGE_CONFIG.lanes.map(lane => ({
          id: lane.id,
          title: lane.title,
          startsAtAct: lane.startsAtAct,
          status: laneStatuses.get(lane.id) ?? 'pending',
          startedAt: laneStarts.get(lane.id) ?? null,
        })),
        acts: DEMO1104_STAGE_CONFIG.acts.map(act => ({
          id: act.id,
          title: act.title,
          targetStartSec: act.targetStartSec,
          targetEndSec: act.targetEndSec,
          videoId: act.highlightVideoId,
          status: actStatuses.get(act.id) ?? 'pending',
        })),
        transitions: transitions.map(transition => ({ ...transition })),
      };
    },
  };
}

type CliOptions = { mock: boolean; help?: boolean; runAct?: DemoActId; failAct?: DemoActId; hangAct?: DemoActId; switchToVideo?: DemoActId };

const HELP = 'Usage: bun scripts/demo/demo1104-stage.ts --mock [--run-act <act> [--fail-act <act>|--hang-act <act>]] [--switch-to-video <act>]';

export function parseStageArgs(argv: string[]): CliOptions {
  if (argv.includes('--help')) return { mock: false, help: true };
  let mock = false;
  let runAct: DemoActId | undefined;
  let failAct: DemoActId | undefined;
  let hangAct: DemoActId | undefined;
  let switchToVideo: DemoActId | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mock') { mock = true; continue; }
    if (arg === '--run-act' || arg === '--fail-act' || arg === '--hang-act' || arg === '--switch-to-video') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} needs an act id`);
      const act = DEMO1104_STAGE_CONFIG.acts.find(candidate => candidate.id === value);
      if (!act) throw new Error(`Unknown act id: ${value}`);
      if (arg !== '--run-act' && !act.highlightVideoId) throw new Error(`${value} has no configured highlight video`);
      if (arg === '--run-act') runAct = act.id;
      else if (arg === '--fail-act') failAct = act.id;
      else if (arg === '--hang-act') hangAct = act.id;
      else switchToVideo = act.id;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (!mock) throw new Error('This first-stage console is mock-only; pass --mock');
  if (failAct && failAct !== runAct) throw new Error('--fail-act must match --run-act');
  if (hangAct && hangAct !== runAct) throw new Error('--hang-act must match --run-act');
  if (hangAct && failAct) throw new Error('--hang-act cannot be combined with --fail-act');
  if (switchToVideo && (runAct || failAct)) throw new Error('--switch-to-video cannot be combined with act execution');
  if (switchToVideo && hangAct) throw new Error('--switch-to-video cannot be combined with --hang-act');
  return { mock, ...(runAct ? { runAct } : {}), ...(failAct ? { failAct } : {}), ...(hangAct ? { hangAct } : {}), ...(switchToVideo ? { switchToVideo } : {}) };
}

export async function runMockStage(args: CliOptions, stageOptions: { now?: () => number; timers?: TimerScheduler } = {}): Promise<StageSnapshot> {
  const adapters: StageAdapters = {
    async startLane(lane) { console.log(`시작: ${lane.title}`); },
    async runAct(act) {
      console.log(`지금 실행: ${act.title}`);
      if (args.failAct === act.id) throw new Error('mock failure injected');
      if (args.hangAct === act.id) return new Promise<void>(() => {});
    },
    async showVideo(videoId, act) { console.log(`영상 전환: ${act.title} → ${videoId}`); },
  };
  const stage = createDemoStageConsole({ adapters, ...stageOptions });
  await stage.start();
  if (args.runAct) {
    await stage.runActNow(args.runAct);
    const transition = stage.snapshot().transitions.at(-1);
    if (transition?.status === 'shown') {
      const cause = transition.trigger === 'deadline' ? '정체' : transition.trigger === 'failure' ? '실패' : '수동';
      console.log(`씬 ${cause} · 영상 전환 완료: ${transition.actId} → ${transition.videoId} · ${transition.latencyMs}ms`);
    }
  }
  if (args.switchToVideo) {
    await stage.switchToVideo(args.switchToVideo);
    const transition = stage.snapshot().transitions.at(-1);
    if (transition?.status === 'shown') console.log(`수동 영상 전환 완료: ${transition.actId} → ${transition.videoId} · ${transition.latencyMs}ms`);
  }
  return stage.snapshot();
}

if (import.meta.main) {
  try {
    const args = parseStageArgs(process.argv.slice(2));
    if (args.help) {
      console.log(HELP);
      process.exit(0);
    }
    const snapshot = await runMockStage(args);
    console.log(JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
