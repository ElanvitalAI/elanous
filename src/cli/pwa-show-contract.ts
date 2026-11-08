import type { PwaInstanceListing } from './pwa-registry.js';
import type { TailscaleProbe } from '../nexus/onboarding/tailscale-probe.js';
import type { NexusLifecycleState } from '../nexus/supervisor/lock.js';

export interface PwaShowOpts {
  format?: 'human' | 'json';
  cwd?: string;
  listFn?: (opts: { prune?: boolean }) => PwaInstanceListing[];
  probeFn?: () => Promise<TailscaleProbe>;
  out?: { log: (s: string) => void; error: (s: string) => void };
}

export interface PwaShowResult {
  exitCode: number;
  instance?: PwaInstanceListing;
  urls?: { loopback: string; tailnet?: string };
}

export interface NexusShowUrls {
  pwa: { loopback: string; tailnet?: string };
  rest: { loopback: string; tailnet?: string };
  sse: { loopback: string; tailnet?: string };
}

export type NexusShowStatus = 'registered' | 'unregistered' | 'absent';

export interface NexusShowResult {
  exitCode: number;
  status: NexusShowStatus;
  instance?: PwaShowResult['instance'];
  urls?: NexusShowUrls;
}

export type NexusPwaUnavailableReason = 'daemon-absent' | 'pwa-url-unknown' | 'pwa-query-failed';
export type NexusPwaLinkSource = 'local' | 'tailnet';

export type NexusPwaResolution =
  | { readonly status: 'registered'; readonly loopback: string; readonly url: string; readonly source: NexusPwaLinkSource; readonly tailnetRecordedAt?: string }
  | { readonly status: 'unregistered'; readonly loopback: string; readonly url: string; readonly pid: number; readonly source: NexusPwaLinkSource; readonly tailnetRecordedAt?: string }
  | { readonly status: 'absent'; readonly reason: Extract<NexusPwaUnavailableReason, 'daemon-absent' | 'pwa-query-failed'> }
  | { readonly status: 'unregistered'; readonly reason: Extract<NexusPwaUnavailableReason, 'pwa-url-unknown'>; readonly pid: number };

export interface ResolveNexusPwaOpts {
  cwd?: string;
  listFn?: PwaShowOpts['listFn'];
  lifecycleFn?: () => NexusLifecycleState | null;
  nexusRootFn?: () => string;
  pwaResult?: Pick<PwaShowResult, 'instance' | 'urls'>;
}
