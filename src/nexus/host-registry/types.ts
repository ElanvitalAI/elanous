export type HostChannel = 'dev' | 'release' | 'unknown';
export type HostState = 'current' | 'behind' | 'unknown' | 'stale';

export interface HostRecord {
  host: string;
  /** Other names this host reports itself by (e.g. a machine hostname such as «MacStudioB1» for the registry key «node-b»). */
  aliases?: string[];
  seat?: string;
  channel: HostChannel;
  /** 40-hex sha the host last reported as installed. */
  installedSha: string;
  lastHeartbeatMs: number;
  state: HostState;
}

export interface HostLedger {
  version: 1;
  hosts: Record<string, HostRecord>;
}
