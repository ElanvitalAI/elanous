// Share auto-mount — extracted from pwa-start.ts `bringShareUp` so that
// non-TTY nexus daemons (launchd · systemd · Docker · nohup) can mount
// `tailscale serve` themselves when `global.nexus.pwa.shareTailnet=enabled`.
//
// pwa-start owns the TTY path (banner + bg-launch parent prints the URL
// line after the child detaches). This module covers the !TTY path so
// `elanous nexus run` restarts in any context bring share back up without
// extra user steps.
//
// FU2 (2026-05-13) — sudo behavior in fork+detach:
//
//   `mountTailscaleServe` shells out to `sudo -n tailscale serve …`
//   (non-interactive · cached creds only). A bg-launch child inherits
//   the parent's sudo cache when the parent ran in a TTY recently;
//   without that cache (launchd / systemd / Docker / nohup · or a
//   long-idle daily restart) the mount fails with reason='serve-error'
//   and `daemon log` shows `share ERR serve exit 1`. Daemons in those
//   contexts have no terminal to prompt on — by design we fall through
//   silently and the user discovers the missing mount via the iPad URL
//   not loading. This module now also emits `share.auto-mount.*`
//   events through `debug.log` so the keytrace tail at least carries
//   the diagnosis even when the console output got buffered away.
//
//   Recovery paths surfaced to the user (in the daemon's `share ERR`
//   line + this module's keytrace events):
//     1. `sudo -v` once in any TTY · re-run nexus → cache hits
//     2. `elanous nexus pwa share enable` (parent-side mount with the
//        user's terminal sudo) — independent of bg-launch lifecycle
//     3. macOS NOPASSWD entry for `tailscale serve` (long-term daemon
//        operators)

import { autoServe } from '../nexus/onboarding/pwa-share-prompt.js';
import { probeTailscale, type TailscaleProbe } from '../nexus/onboarding/tailscale-probe.js';
import { readSwitchValue, readUserConfig } from '../nexus/config/user-config.js';
import { debug } from '../debug/log.js';

export type ShareTailnetValue = 'ask' | 'enabled' | 'disabled';

export type ShareMountOutcome = 'serving' | 'skipped' | 'failed';

export interface ShareMountResult {
  outcome: ShareMountOutcome;
  reason?:
    | 'switch-disabled'
    | 'switch-ask'
    | 'tailscale-missing'
    | 'tailscale-down'
    | 'serve-error';
  url?: string;
  serveExitCode?: number;
}

export interface MountShareOpts {
  /** Live HTTP port the nexus is listening on. Mount target = this port. */
  httpPort: number;
  /** Force-enable for THIS call only, bypassing the switch (caller's
   *  `--https` flag). switch=enabled + https=true is a safe no-op. */
  https?: boolean;
  // ─── Test seams ─────────────────────────────────────────────────
  readShareSwitchFn?: () => ShareTailnetValue;
  shareProbeFn?: () => Promise<TailscaleProbe>;
  shareServeFn?: (binary: string, port: number) => Promise<{ exitCode: number; ladderExhausted?: boolean }>;
}

/** Read `global.nexus.pwa.shareTailnet` switch (default 'ask' when unset). */
export function readShareSwitch(): ShareTailnetValue {
  try {
    const v = readSwitchValue(readUserConfig(), 'global.nexus.pwa.shareTailnet');
    if (v === 'enabled' || v === 'disabled') return v;
  } catch { /* swallow — config absent, treat as 'ask' */ }
  return 'ask';
}

/** Mount `tailscale serve` against the live HTTP port when switch=enabled
 *  (or when forced via `https=true`). Failures are surfaced as warnings —
 *  the nexus daemon stays up regardless so the caller can render a banner.
 *  Every outcome also emits a `share.auto-mount.*` event through
 *  `debug.log` so the keytrace tail records the diagnosis even when the
 *  daemon's console output got buffered away. */
export async function mountShareIfEnabled(opts: MountShareOpts): Promise<ShareMountResult> {
  const trace = (event: string, data?: Record<string, unknown>): void => {
    try { debug.log('share.auto-mount', event, data); } catch { /* never throw */ }
  };
  trace('start', { httpPort: opts.httpPort, force: opts.https === true });

  const readSwitch = opts.readShareSwitchFn ?? readShareSwitch;
  const switchValue = readSwitch();
  const force = opts.https === true;
  if (!force && switchValue === 'disabled') {
    trace('skipped', { reason: 'switch-disabled' });
    return { outcome: 'skipped', reason: 'switch-disabled' };
  }
  if (!force && switchValue === 'ask') {
    trace('skipped', { reason: 'switch-ask' });
    return { outcome: 'skipped', reason: 'switch-ask' };
  }

  const probeFn = opts.shareProbeFn ?? (() => probeTailscale());
  const probe = await probeFn();
  if (!probe.installed) {
    trace('skipped', { reason: 'tailscale-missing' });
    return { outcome: 'skipped', reason: 'tailscale-missing' };
  }
  if (!probe.alive) {
    trace('skipped', { reason: 'tailscale-down' });
    return { outcome: 'skipped', reason: 'tailscale-down' };
  }

  const serveFn = opts.shareServeFn ?? autoServe;
  const serve = await serveFn(probe.binary ?? 'tailscale', opts.httpPort);
  if (serve.exitCode !== 0) {
    // Only a caller that actually saw the ladder fail through sudo
    // (`ladderExhausted === true`) may claim the cache was empty.
    // Unknown or false leaves the hint off.
    trace('failed', {
      reason: 'serve-error',
      serveExitCode: serve.exitCode,
      ...(serve.ladderExhausted === true
        ? {
            likelyCause: 'sudo-cache-empty-in-fork-detach',
            recoveryHint: 'run `sudo -v` once in a TTY then restart, or `elanous nexus pwa share enable`',
          }
        : {}),
    });
    return { outcome: 'failed', reason: 'serve-error', serveExitCode: serve.exitCode };
  }
  const host = probe.magicDnsHost ?? probe.hostname ?? probe.ips?.[0];
  const url = host ? `https://${host}:${opts.httpPort}/app/` : undefined;
  trace('serving', { url: url ?? '(host-unknown)' });
  return {
    outcome: 'serving',
    ...(url ? { url } : {}),
    serveExitCode: 0,
  };
}
