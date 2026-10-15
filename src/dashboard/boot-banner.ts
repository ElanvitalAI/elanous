import type { NexusShowResult } from '../cli/nexus-show.js';
import { buildFirstScreenBand, type TuiDaemonLink } from './first-screen-band.js';

/**
 * Boot banner policy (#28 · 대표 «불필요한 메시지가 많다»).
 *
 * `minimal` (default): the first screen keeps the transcript for who/where/what-is-left.
 * A healthy daemon link, the PWA address and a hitl callback-port shift are held for
 * `/status`; only a failed daemon link and first-run guidance reach the transcript.
 * `full`: the historical band, byte-identical.
 */
export type BootBannerMode = 'minimal' | 'full';

export function normalizeBootBannerMode(value: unknown): BootBannerMode {
  return value === 'full' ? 'full' : 'minimal';
}

/** Rows the minimal banner kept out of the transcript; `/status` reads them. */
export interface BootBannerHeld {
  daemon?: string;
  pwa?: string;
  hitl?: string;
}

export function bootBannerStatusLines(held: BootBannerHeld): string[] {
  return [held.daemon, held.pwa, held.hitl].filter((line): line is string => !!line);
}

export interface MinimalBootBandInput {
  readonly history: ReadonlyArray<{ role: string }>;
  readonly lines: string[];
  readonly width: number;
  readonly locale?: 'ko' | 'en';
  /** First run (onboarding not complete): keep the action/example guidance rows. */
  readonly guidance: boolean;
  readonly held: BootBannerHeld;
  readonly draw: () => void;
  readonly observe: (data: { daemon: boolean; hasPwa: boolean; hasTailnet: boolean }) => void;
  readonly observeHeld?: (data: { row: 'daemon' | 'pwa'; status: string }) => void;
  readonly show: () => Promise<Pick<NexusShowResult, 'status' | 'urls'>>;
  readonly daemonLink: () => Promise<TuiDaemonLink>;
  /** Styles the one failure row (the dashboard passes its warning color). */
  readonly styleFailure?: (line: string) => string;
}

export function renderMinimalBootBand(input: MinimalBootBandInput): Promise<void> {
  if (input.history.some((message) => message.role !== 'system')) return Promise.resolve();
  const observeHeld = (data: { row: 'daemon' | 'pwa'; status: string }): void => {
    try { input.observeHeld?.(data); } catch { /* observation is best-effort */ }
  };
  if (input.guidance) {
    input.lines.unshift(...buildFirstScreenBand({ width: input.width, daemon: false, locale: input.locale ?? 'en' }).slice(2));
  }
  const linkPending = Promise.resolve().then(() => input.daemonLink())
    .catch((): TuiDaemonLink => ({ status: 'error', stage: 'health' }))
    .then((link) => {
      const row = buildFirstScreenBand({ width: input.width, daemon: false, link, locale: input.locale })[0]!;
      // /status «연결:» is the remote attach, not this write-daemon probe — the held row says it there.
      if (link.status === 'connected' || link.status === 'checking') {
        input.held.daemon = row;
        observeHeld({ row: 'daemon', status: link.status });
        return;
      }
      input.lines.push(input.styleFailure ? input.styleFailure(row) : row);
      try { input.draw(); } catch { /* screen may have closed */ }
    });
  const observe = (data: { daemon: boolean; hasPwa: boolean; hasTailnet: boolean }): void => {
    try { input.observe(data); } catch { /* observation cannot interrupt the transcript */ }
  };
  const pwaPending = Promise.resolve().then(input.show).then((result) => {
    const daemon = result.status !== 'absent';
    const pwa = result.urls?.pwa;
    observe({ daemon, hasPwa: !!pwa, hasTailnet: !!pwa?.tailnet });
    input.held.pwa = buildFirstScreenBand({ width: Number.MAX_SAFE_INTEGER, daemon, pwa, locale: input.locale })[1]!;
    observeHeld({ row: 'pwa', status: pwa ? 'address' : result.status });
  }).catch(() => {
    observe({ daemon: false, hasPwa: false, hasTailnet: false });
  });
  return Promise.all([linkPending, pwaPending]).then(() => {});
}
