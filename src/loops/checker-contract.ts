export type LoopState = 'off' | 'unregistered' | 'failing' | 'late' | 'unknown' | 'alive';
export type LoopScope = 'graph-only' | 'registry';

export interface CheckEntry {
  id: string;
  owner?: string;
  ownerSource?: 'header' | 'config' | 'seat' | 'seat-arg' | 'default';
  evidence?: 'log-mtime' | 'registry';
  mode?: string;
  expectEveryMinutes?: number;
  dueAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  recentStatuses?: string[];
  observedSince?: string;
  health?: 'healthy' | 'degraded';
  endsAt?: string;
  installedVersion?: string;
  expectedVersion?: string;
  file?: string;
  cron?: string;
  command?: string;
  enabled: boolean;
  registered: boolean;
}

export interface CheckResult extends CheckEntry {
  state: LoopState;
  reason: string;
}

export type LoopCounts = Record<LoopState, number>;
export type ScheduleFinding = {
  id: string;
  owner?: string;
  kind: 'late' | 'failing' | 'degraded' | 'end-expired' | 'version-mismatch';
  reason: string;
  lastRunAt?: string;
};
