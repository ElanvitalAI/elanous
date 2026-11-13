import type { GraphRunState } from '../graph-runner/runner-types.js';
import type { LoopReplyBody, MessageWake } from './msg-address.js';
import type { WakeResolution } from './msg-wake.js';

export interface LoopRun {
  at: string;
  status: GraphRunState['status'];
  path: string;
  runId: string;
  failedNodes: string[];
  durationMs: number | null;
}

export type LoopRoot = '조율자' | '수호자';
export type LoopStage = 'proposed' | 'shadow' | 'live' | 'retiring' | 'retired';

export interface LoopEntry {
  id: string;
  parent?: string | null;
  root?: LoopRoot | null;
  purpose?: string | null;
  stage?: LoopStage | null;
  msgAddress?: string | null;
  replyBody?: LoopReplyBody;
  wake?: MessageWake;
  wakeSource?: WakeResolution['source'];
  unreadCount?: number | null;
  title: string;
  description: string | null;
  owner?: string | null;
  ownerSource?: 'header' | 'config' | 'seat' | 'seat-arg' | 'default';
  mode?: string | null;
  file: string;
  trigger: { cron: string | null; events: string[] };
  jobs: Array<{ id: string; cron: string | null; enabled: boolean; entryScript?: boolean }>;
  enabled: boolean;
  lastRun: LoopRun | null;
  nextRun: string | null;
}
