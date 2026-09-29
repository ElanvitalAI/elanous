// P.3 — First-boot PWA share wizard.
//
// Asks the user (Y/N once) whether to expose the local NEXUS HTTP API on
// the tailnet via `tailscale serve`. The decision is persisted in the
// `global.nexus.pwa.shareTailnet` switch so re-boots stay zero-prompt.
//
// Flow (called from runNexus after printBootBanner, before TUI / headless
// branch):
//
//   1. Read switch — if 'enabled' or 'disabled', return early ('skipped').
//   2. Skip when stdin is non-TTY (launchd / Docker · headless mode).
//   3. Probe Tailscale (probeTailscale).
//      - installed + alive   → show "Y/N · enable share?" prompt.
//      - missing             → show one-line install hint, switch stays 'ask'
//                              so the next interactive boot re-asks.
//   4. On Y: build PWA if missing (runPwaBuild) → tailscale serve → save 'enabled'.
//   5. On N: save 'disabled'.

import type { TailscaleProbe } from './tailscale-probe.js';
import type { WizardIO } from '../../onboarding.js';
import { debug } from '../../debug/log.js';
import {
  chooseFrom,
  showStepOr,
  showSuccessOr,
} from '../../onboarding/io-extended.js';

export type ShareTailnetValue = 'ask' | 'enabled' | 'disabled';

export interface PwaSharePromptDeps {
  /** Probe Tailscale presence + state. */
  probeFn: () => Promise<TailscaleProbe>;
  /** Run the PWA build (P.2 runPwaBuild). Called when user opts in but
   *  apps/pwa/out is missing. Should resolve to a child exit code. */
  buildFn: () => Promise<{ exitCode: number }>;
  /** Run `tailscale serve --bg --tls-terminated-tcp <port> tcp://localhost:<port>`. */
  serveFn: (binary: string, port: number) => Promise<{ exitCode: number }>;
  /** Read current switch value (default 'ask' when unset). */
  readSwitch: () => ShareTailnetValue;
  /** Persist switch value. */
  saveSwitch: (v: ShareTailnetValue) => void;
  /** WizardIO host. */
  io: WizardIO;
  /** Whether `apps/pwa/out` exists (skip build when true). */
  pwaBuilt: boolean;
  /** Actual bound HTTP port for the tailscale serve forward. */
  port: number;
  /** Force the prompt path even when stdin is non-TTY (tests). */
  forceTty?: boolean;
  /** Output sink (default = console). */
  out?: { log: (s: string) => void; error: (s: string) => void };
}

export type PwaSharePromptResult =
  | { action: 'skipped'; reason: 'switch-set' | 'no-tty' }
  | { action: 'tailscale-missing-hint' }
  | { action: 'enabled'; serveExitCode: number; built: boolean }
  | { action: 'disabled' };

function isTty(force?: boolean): boolean {
  if (force === true) return true;
  if (force === false) return false;
  return Boolean(process.stdin.isTTY);
}

export async function runPwaSharePrompt(
  deps: PwaSharePromptDeps,
): Promise<PwaSharePromptResult> {
  const out = deps.out ?? console;
  const port = deps.port;
  const io = deps.io;

  const current = deps.readSwitch();
  if (current !== 'ask') {
    return { action: 'skipped', reason: 'switch-set' };
  }

  if (!isTty(deps.forceTty)) {
    return { action: 'skipped', reason: 'no-tty' };
  }

  const probe = await deps.probeFn();
  if (!probe.installed || !probe.alive) {
    out.log('');
    out.log('  PWA share — Tailscale not detected.');
    out.log('  To expose this NEXUS to other tailnet devices later:');
    out.log('    1. Install Tailscale: https://tailscale.com/download');
    out.log('    2. Re-run `elanous nexus` (this prompt re-appears).');
    out.log('');
    return { action: 'tailscale-missing-hint' };
  }

  const hostHint = probe.magicDnsHost ?? probe.hostname ?? probe.ips?.[0] ?? '<host>';
  showStepOr(io, {
    index: 1,
    total: 1,
    title: 'PWA share — Tailscale detected',
    excerpt: `Detected: ${hostHint}\nExpose this NEXUS to other tailnet devices?`,
  });
  const yes = await chooseFrom(io, '', [
    { key: 'y', value: true, label: `Yes — share via https://${hostHint}:${port}/app/` },
    { key: 'n', value: false, label: 'No — local-only (change later with `elanous nexus pwa share enable`)' },
  ], {
    defaultIndex: 0,
    help: 'arrow keys / numbers / Enter',
  });

  if (!yes) {
    deps.saveSwitch('disabled');
    out.log('  → local-only. Use `elanous nexus pwa share enable` later to flip.');
    out.log('');
    return { action: 'disabled' };
  }

  let built = false;
  if (!deps.pwaBuilt) {
    out.log('  → building PWA static export first (one-time)...');
    const buildResult = await deps.buildFn();
    if (buildResult.exitCode !== 0) {
      out.error(`  ✗ build failed (exit ${buildResult.exitCode}); aborting share setup.`);
      out.error('  Switch left at \'ask\' — fix build, then re-run.');
      return { action: 'tailscale-missing-hint' };
    }
    built = true;
  }

  out.log(`  → tailscale serve --bg --tls-terminated-tcp ${port} tcp://localhost:${port}`);
  debug.log('nexus.pwa-share', 'port-resolved', { port, source: 'bound' });
  const serveResult = await deps.serveFn(probe.binary ?? 'tailscale', port);
  if (serveResult.exitCode !== 0) {
    out.error(`  ✗ tailscale serve failed (exit ${serveResult.exitCode}); switch left at 'ask'.`);
    return { action: 'tailscale-missing-hint' };
  }

  deps.saveSwitch('enabled');
  showSuccessOr(io, `tailnet share enabled. https://${hostHint}:${port}/app/`);
  out.log('  Toggle later: `elanous nexus pwa share disable`.');
  out.log('');
  return { action: 'enabled', serveExitCode: serveResult.exitCode, built };
}

/** Default `tailscale serve` runner. Idempotent: tailscale's CLI exits 0
 *  when the requested forward already exists.
 *
 *  As of P1 mode unification (2026-05-10), this delegates to the
 *  unified `mountTailscaleServe` helper in `src/cli/tailscale-serve.ts`
 *  with `mode: { kind: 'tls-tcp', port }`. Previously this was
 *  `https-443` (URL clean, no port) but that mode forwards via HTTP/2
 *  which strips WebSocket Upgrade — voice + Showroom multi-LLM WS
 *  bridge both 502 in production. Mode unification (single tls-tcp
 *  mode for both `pwa share enable` and `pwa test --https`) makes
 *  voice/WS work in daily-driver mode at the cost of a port in the
 *  surfaced URL. The trade was decided 2026-05-10 (P1-P6 redesign).
 *
 *  `useSudo: true` because tls-tcp on macOS requires a privileged
 *  bind; the GUI CLI's interactive sudo path that worked for
 *  `--https=443` does not cover `--tls-terminated-tcp`. Caller is
 *  responsible for prompting the user / running `sudo -v` ahead.
 *  The external signature is kept so existing callers in
 *  `pwa-start` / `pwa-share` and their tests do not move. */
export type ServeMountResult = { exitCode: number; ladderExhausted?: boolean };

async function serveViaMount(
  binary: string,
  port: number,
  useSudo: true | undefined,
): Promise<ServeMountResult> {
  const { mountTailscaleServe } = await import('../../cli/tailscale-serve.js');
  // The unified helper expects to discover the binary via probe; we
  // already have the binary path from the caller (pwa-start /
  // pwa-share probe earlier). Inject the binary as a no-op probe so
  // the helper doesn't repeat the discovery — keeps the contract
  // exactly the same as the legacy execFile call.
  // `useSudo` is omitted when undefined so mountTailscaleServe's own
  // ladder runs: no sudo first, then `sudo -n` once on permission failure.
  // `false` is never passed — that would drop the sudo retry.
  const res = await mountTailscaleServe({
    mode: { kind: 'tls-tcp', port },
    upstreamPort: port,
    ...(useSudo === undefined ? {} : { useSudo }),
    probeFn: async () => ({
      installed: true,
      alive: true,
      hostname: 'localhost', // placeholder · we never surface URL here
      magicDnsHost: 'localhost',
      binary,
    }),
  });
  if (res.ok) return { exitCode: 0, ladderExhausted: false };
  if (res.reason === 'sudo-required') return { exitCode: 1, ladderExhausted: true };
  if (res.reason === 'serve-cmd-failed') {
    // Best-effort exit-code recovery from `detail` (which carries
    // stderr in the legacy contract callers consume).
    const m = /exit (\d+)/.exec(res.detail ?? '');
    return { exitCode: m ? Number.parseInt(m[1]!, 10) : 1, ladderExhausted: false };
  }
  return { exitCode: 1 };
}

export async function defaultServe(binary: string, port: number): Promise<ServeMountResult> {
  return serveViaMount(binary, port, true);
}

/** Daemon auto-mount. Leaves `useSudo` undefined so the existing
 *  ladder tries without sudo first and `sudo -n` only once on a
 *  permission failure. Manual paths stay on `defaultServe`. */
export async function autoServe(binary: string, port: number): Promise<ServeMountResult> {
  return serveViaMount(binary, port, undefined);
}
