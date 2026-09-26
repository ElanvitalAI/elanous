// PWA · Nexus client types (Phase N-4 PR ν)
//
// Mirrors the wire shape returned by the nexus HTTP API. Kept in sync
// with src/nexus/{state,kinds}/types.ts via duck-typing — no shared
// import (apps/pwa is its own tsconfig project) so we re-declare the
// minimal slice the PWA consumes.

// Surface-unification v2.2 V2.2-6 v2 (2026-05-11) — `'scheduler'` NEXUS
// process kind retired together with the dashboard scheduler view +
// server `/v1/scheduler*` endpoint group. NEXUS daemon 의 legacy
// scheduler subsystem 자체가 V2.2-8 에서 물리 삭제 예정.
export type NexusTabKind =
  | 'chat'
  | 'webterm'
  | 'daemon'
  | 'pwa-host'
  | 'channel-bot';

export type NexusTabStatus =
  | 'idle'
  | 'starting'
  | 'active'
  | 'unhealthy'
  | 'restarting'
  | 'crashed'
  | 'stopped'
  | 'external';

export interface NexusTabSpec {
  id: string;
  kind: NexusTabKind;
  label: string;
  spawn?: { command: string[]; cwd?: string; env?: Record<string, string> };
  health?: unknown;
  restart?: unknown;
  meta?: Record<string, unknown>;
}

export interface NexusTabState {
  spec: NexusTabSpec;
  status: NexusTabStatus;
  pid?: number;
  startedAt?: number;
  lastHealthAt?: number;
  lastHealthOk?: boolean;
  restartCount: number;
  restartCountWindowStart: number;
  lastError?: string;
}

export interface NexusEvent {
  ts: number;
  kind: string;
  tabId?: string;
  detail?: Record<string, unknown>;
}

export interface NexusSnapshot {
  nexusVersion: string;
  phase: string;
  startedAt: number;
  template?: string;
  tabs: NexusTabState[];
  recentEvents: NexusEvent[];
}

export interface NexusHealth {
  ok: boolean;
  nexusVersion: string;
  phase: string;
  startedAt: number;
  uptimeMs: number;
  tabs: { total: number; byStatus: Record<NexusTabStatus, number> };
  /** Present only when the daemon booted in setup mode (P24b). Old daemons omit it. */
  setupMode?: boolean;
  /** Names of required slots still missing (e.g. `['llm']`). Absent when the daemon does not report them. */
  setupMissing?: string[];
}

export interface NexusRuntimeMeta {
  pid: number;
  startedAt: string;
  nexusVersion: string;
  phase: string;
  httpPort?: number;
  httpHost?: string;
  httpAuth?: 'on' | 'off';
  template?: string;
}
