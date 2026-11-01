import type { TerminalSessionRegistry } from '../../src/terminal/session-registry.js';
import {
  createDemo1104ParallelScenes,
  createDemo1104TuiTabAdapters,
  type DemoParallelSnapshot,
  type DemoSurfaceAdapter,
} from './demo1104-parallel-scenes.js';
import type { DemoActId } from './demo1104-stage.config.js';
import { spawnCodingAgent } from '../../src/terminal/coding-agent.js';

export type Demo1104ParallelHostOptions = {
  registry: TerminalSessionRegistry;
  cwd: string;
  termSize: () => { cols: number; rows: number };
  runMission: Parameters<typeof createDemo1104TuiTabAdapters>[0]['runMission'];
  showVideo: Parameters<typeof createDemo1104TuiTabAdapters>[0]['showVideo'];
  videoSources: Readonly<Record<string, string>>;
  webRunGraph: DemoSurfaceAdapter;
  telegram: DemoSurfaceAdapter;
  spawnAgent?: typeof spawnCodingAgent;
};

export type Demo1104ParallelStage = {
  start(): Promise<void>;
  runActNow(id: DemoActId): Promise<void>;
  switchToVideo(id: DemoActId): Promise<void>;
  snapshot(): DemoParallelSnapshot;
};

/** The single host composition point for the two visible agent tabs and the two secretary surfaces. */
export function createDemo1104ParallelHost(options: Demo1104ParallelHostOptions): Demo1104ParallelStage {
  const tuiTabs = createDemo1104TuiTabAdapters({
    registry: options.registry,
    cwd: options.cwd,
    termSize: options.termSize,
    runMission: options.runMission,
    showVideo: options.showVideo,
    videoSources: options.videoSources,
    ...(options.spawnAgent ? { spawnAgent: options.spawnAgent } : {}),
  });
  return createDemo1104ParallelScenes({
    ...tuiTabs,
    'web-run-graph': options.webRunGraph,
    telegram: options.telegram,
  });
}

/** Start all four demo surfaces together and return the live controls to the demo runner. */
export async function startDemo1104ParallelHost(options: Demo1104ParallelHostOptions): Promise<{
  stage: Demo1104ParallelStage;
  snapshot: DemoParallelSnapshot;
}> {
  const stage = createDemo1104ParallelHost(options);
  await stage.start();
  return { stage, snapshot: stage.snapshot() };
}
