// SEAT-INPLACE-UPDATE — the thin pane launcher (design B). The pane runs `els seat-launch <SEAT> -- <eln args>`; it runs
// eln on the CURRENT install with `--resume <session>` and relaunches it in the same pane:
//   · exit SEAT_UPDATE_EXIT_CODE (75) → relaunch at once on the current install (the update);
//   · crash (non-zero) → backoff 2 s · 4 s · 8 s; after CRASH_LIMIT crashes within CRASH_WINDOW_MS on one build →
//     fall back to install.json `previous` and post ONE card;
//   · exit 0 (person quit) → the launcher ends, the pane closes as before.
// The pane id never changes, so watchers (els peek/watch, seat-inbox, wake-ledger) keep pointing at it.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEAT_UPDATE_EXIT_CODE } from './inplace-update.js';

export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 5 * 60_000;
export const CRASH_BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000];

export interface LaunchState {
  readonly build: 'current' | 'previous';
  readonly crashes: readonly number[];
  readonly launches: number;
}

export type LaunchStep =
  | { readonly kind: 'stop'; readonly code: number }
  | { readonly kind: 'relaunch'; readonly build: 'current' | 'previous'; readonly delayMs: number; readonly why: 'update' | 'crash-backoff' | 'fallback-previous'; readonly card?: string };

/** Pure — what the launcher does after eln exits with `code` at `now`. */
export function planNextLaunch(state: LaunchState, code: number, now: number): { readonly step: LaunchStep; readonly state: LaunchState } {
  if (code === 0) return { step: { kind: 'stop', code: 0 }, state };
  if (code === SEAT_UPDATE_EXIT_CODE) {
    // An update always goes to the current install and clears the crash history of the old build.
    return { step: { kind: 'relaunch', build: 'current', delayMs: 0, why: 'update' }, state: { build: 'current', crashes: [], launches: state.launches + 1 } };
  }
  const crashes = [...state.crashes.filter((at) => now - at <= CRASH_WINDOW_MS), now];
  if (crashes.length >= CRASH_LIMIT) {
    if (state.build === 'previous') return { step: { kind: 'stop', code }, state: { ...state, crashes } };
    return {
      step: { kind: 'relaunch', build: 'previous', delayMs: 0, why: 'fallback-previous',
        card: `seat crashed ${crashes.length}x in ${Math.round(CRASH_WINDOW_MS / 60_000)} min on the current build (last exit ${code}) — fell back to the previous build` },
      state: { build: 'previous', crashes: [], launches: state.launches + 1 },
    };
  }
  return {
    step: { kind: 'relaunch', build: state.build, delayMs: CRASH_BACKOFF_MS[Math.min(crashes.length - 1, CRASH_BACKOFF_MS.length - 1)]!, why: 'crash-backoff' },
    state: { ...state, crashes, launches: state.launches + 1 },
  };
}

/** Entry script for a build: `current` → <root>/current/…, `previous` → <root>/<install.json previous>/…. */
export function entryForBuild(installRoot: string, build: 'current' | 'previous'): string | null {
  const tail = ['node_modules', 'elanous', 'bin', 'elanous.mjs'];
  if (build === 'current') return join(installRoot, 'current', ...tail);
  try {
    const record = JSON.parse(readFileSync(join(installRoot, 'install.json'), 'utf8')) as { previous?: string };
    if (!record.previous || record.previous.includes('..')) return null;
    const path = join(installRoot, record.previous, ...tail);
    return existsSync(path) ? path : null;
  } catch { return null; }
}

/** Strip prior `--resume X` / `--continue` and put the session last. */
export function launchArgv(args: readonly string[], sessionId: string | null): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--resume') { const next = args[i + 1]; if (next !== undefined && !next.startsWith('-')) i += 1; continue; }
    if (arg === '--continue' || arg.startsWith('--resume=')) continue;
    kept.push(arg);
  }
  return sessionId ? [...kept, '--resume', sessionId] : kept;
}

export interface LauncherDeps {
  readonly installRoot: string;
  readonly args: readonly string[];
  /** The session to resume on each relaunch — read fresh each time (the seat may have switched session). */
  readonly sessionId: () => string | null;
  readonly run?: (command: string, argv: readonly string[], env: Record<string, string>) => Promise<number>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly card?: (body: string) => void;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  readonly maxLaunches?: number;
}

export async function runSeatLauncher(deps: LauncherDeps): Promise<number> {
  const run = deps.run ?? ((command, argv, env) => new Promise<number>((resolve) => {
    const child = spawn(command, [...argv], { stdio: 'inherit', env: env as NodeJS.ProcessEnv });
    child.on('error', () => resolve(1));
    child.on('exit', (code, signal) => resolve(typeof code === 'number' ? code : signal ? 1 : 0));
  }));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  let state: LaunchState = { build: 'current', crashes: [], launches: 1 };
  for (;;) {
    const entry = entryForBuild(deps.installRoot, state.build) ?? entryForBuild(deps.installRoot, 'current');
    if (!entry) { log('no-entry', { build: state.build }); return 1; }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
    env.ELANOUS_SEAT_LAUNCHER = '1';
    const argv = [entry, ...launchArgv(deps.args, deps.sessionId())];
    log('launch', { build: state.build, argv, launches: state.launches });
    const code = await run(process.execPath, argv, env);
    const next = planNextLaunch(state, code, now());
    log('exit', { code, step: next.step });
    if (next.step.kind === 'stop') return next.step.code;
    if (next.step.card) { try { deps.card?.(next.step.card); } catch { /* the card never blocks the relaunch */ } }
    if (deps.maxLaunches !== undefined && next.state.launches > deps.maxLaunches) return code;
    state = next.state;
    if (next.step.delayMs > 0) await sleep(next.step.delayMs);
  }
}
