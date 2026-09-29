import { spawn, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { detectProviders, type DetectedProvider } from '../llm/provider-detect.js';
import { resolveDaemonEndpoint, type DaemonEndpoint, type ResolveDaemonEndpointOpts } from '../nexus/daemon-endpoint.js';
import { runBgLaunch } from './bg-launch.js';

export interface StartOptions {
  gui?: boolean;
  tui?: boolean;
  json?: boolean;
  login?: boolean;
}

export interface StartState {
  providers: readonly Pick<DetectedProvider, 'provider' | 'auth' | 'available' | 'rank'>[];
  tty: boolean;
  healthy: boolean;
  discoveryFailed?: boolean;
}

export type StartStepId = 'detect-llm' | 'login' | 'check-daemon' | 'launch-daemon' | 'open-gui' | 'open-tui';
export interface StartPlannedStep { id: StartStepId; needed: boolean }
export interface StartStep { id: StartStepId; status: 'done' | 'skipped' | 'failed'; detail: string }
export interface StartResult {
  exitCode: number;
  steps: StartStep[];
  llm: 'available' | 'missing' | 'unknown';
  daemon: 'running' | 'started' | 'failed';
  surface: 'gui' | 'tui' | 'none';
}

/** No I/O and no credential values: the same observations always produce the same actions. */
export function planStart(options: StartOptions, state: StartState): StartPlannedStep[] {
  const available = state.providers.some((entry) => entry.available && entry.auth !== 'agent-cli');
  const gui = options.gui === true || options.tui !== true;
  return [
    { id: 'detect-llm', needed: true },
    { id: 'login', needed: !state.discoveryFailed && !available && state.tty && options.json !== true && options.login !== false },
    { id: 'check-daemon', needed: true },
    { id: 'launch-daemon', needed: !state.healthy },
    { id: 'open-gui', needed: gui },
    { id: 'open-tui', needed: !gui },
  ];
}

export interface StartDeps {
  detect?: () => Promise<DetectedProvider[]>;
  isTty?: () => boolean;
  confirmLogin?: () => Promise<boolean>;
  login?: () => Promise<boolean>;
  health?: () => Promise<boolean>;
  launch?: () => Promise<{ exitCode: number }>;
  openGui?: (url: string) => Promise<boolean>;
  openTui?: (json: boolean) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  output?: (line: string) => void;
  /** Test seam — daemon address. `null` means this universe has no daemon (do not guess a port).
   *  Called again after a launch so the opened address is the daemon that was just started. */
  resolveEndpoint?: (opts?: ResolveDaemonEndpointOpts) => DaemonEndpoint | null;
  /** Test seam — records the health URL actually fetched. */
  recordHealthUrl?: (url: string) => void;
}

function child(command: string, args: string[], options: SpawnOptions): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, options);
    proc.once('error', () => resolve(1));
    proc.once('exit', (code) => resolve(code ?? 1));
  });
}

async function confirmLogin(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^(y|yes)$/i.test((await rl.question('No LLM login found. Sign in to OpenAI Codex now? [y/N] ')).trim()); }
  catch { return false; }
  finally { rl.close(); }
}

function childArgs(bin: string, ...args: string[]): string[] {
  return [bin, ...(process.argv.includes('--test') ? ['--test'] : []), ...args];
}

async function defaultLogin(): Promise<boolean> {
  const bin = process.argv[1];
  if (!bin) return false;
  // Use the existing device-code login rather than handling or printing tokens here.
  return (await child(process.execPath, childArgs(bin, 'login', 'openai-codex'), { stdio: ['inherit', process.stderr, process.stderr] })) === 0;
}

async function defaultHealth(deps: StartDeps): Promise<boolean> {
  const endpoint = (deps.resolveEndpoint ?? resolveDaemonEndpoint)();
  if (!endpoint) return false;
  deps.recordHealthUrl?.(endpoint.healthUrl);
  try {
    return (await fetch(endpoint.healthUrl, { signal: AbortSignal.timeout(800) })).ok;
  } catch { return false; }
}

async function defaultOpenGui(url: string): Promise<boolean> {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return false;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return (await child(command, args, { stdio: 'ignore' })) === 0;
}

async function defaultOpenTui(json: boolean): Promise<number> {
  const bin = process.argv[1];
  return bin ? child(process.execPath, childArgs(bin), { stdio: json ? ['inherit', process.stderr, process.stderr] : 'inherit' }) : 1;
}

/** Side effects are explicitly injected; only stable, non-secret outcomes reach steps/output. */
export async function runStart(options: StartOptions = {}, deps: StartDeps = {}): Promise<StartResult> {
  const output = deps.output ?? console.log;
  const steps: StartStep[] = [];
  const record = (id: StartStepId, status: StartStep['status'], detail: string) => steps.push({ id, status, detail });
  let providers: DetectedProvider[] = [];
  let discoveryFailed = false;
  try {
    providers = await (deps.detect ?? detectProviders)();
    record('detect-llm', 'done', 'LLM discovery finished');
  } catch {
    discoveryFailed = true;
    record('detect-llm', 'failed', 'LLM discovery failed');
  }
  const tty = (deps.isTty ?? (() => process.stdin.isTTY === true))();
  let healthy = false;
  const probeHealth = deps.health ?? (() => defaultHealth(deps));
  try { healthy = await probeHealth(); } catch { /* No health response; try launch. */ }
  const plan = planStart(options, { providers, tty, healthy, discoveryFailed });
  let llm: StartResult['llm'] = discoveryFailed ? 'unknown' : providers.some((entry) => entry.available && entry.auth !== 'agent-cli') ? 'available' : 'missing';
  if (plan.find((entry) => entry.id === 'login')?.needed) {
    let agreed = false;
    try { agreed = await (deps.confirmLogin ?? confirmLogin)(); } catch { /* No consent. */ }
    if (agreed) {
      try {
        if (await (deps.login ?? defaultLogin)()) {
          try {
            providers = await (deps.detect ?? detectProviders)();
            llm = providers.some((entry) => entry.available && entry.auth !== 'agent-cli') ? 'available' : 'missing';
            record('login', llm === 'available' ? 'done' : 'failed', llm === 'available' ? 'LLM login detected' : 'No usable LLM login detected');
          } catch {
            llm = 'unknown';
            record('login', 'failed', 'LLM discovery after login failed');
          }
        } else record('login', 'failed', 'LLM login did not complete');
      } catch { record('login', 'failed', 'LLM login or discovery did not complete'); }
    } else record('login', 'skipped', 'Login declined');
  } else record('login', 'skipped', llm === 'available' ? 'LLM already available' : llm === 'unknown' ? 'LLM discovery unavailable; login not offered' : 'Interactive login unavailable');
  record('check-daemon', healthy ? 'done' : 'failed', healthy ? 'Daemon healthy' : 'Daemon did not respond');
  let daemon: StartResult['daemon'] = healthy ? 'running' : 'failed';
  if (plan.find((entry) => entry.id === 'launch-daemon')?.needed) {
    try {
      const launch = await (deps.launch ?? (() => runBgLaunch({ forwardArgs: ['--tools', 'webterm'], out: { log: () => {}, error: () => {} } })))();
      if (launch.exitCode === 0) {
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        for (let i = 0; i < 40; i++) {
          try { if (await probeHealth()) { healthy = true; break; } } catch { /* Retry until deadline. */ }
          if (i < 39) await sleep(250);
        }
      }
      daemon = healthy ? 'started' : 'failed';
    } catch { daemon = 'failed'; }
    record('launch-daemon', daemon === 'started' ? 'done' : 'failed', daemon === 'started' ? 'Daemon started and healthy' : 'Daemon launch or readiness failed');
  } else record('launch-daemon', 'skipped', 'Daemon already healthy');

  let surface: StartResult['surface'] = 'none';
  const requested = plan.find((entry) => entry.id === 'open-gui')?.needed ? 'open-gui' : 'open-tui';
  const openUrl = daemon === 'failed' ? null : (deps.resolveEndpoint ?? resolveDaemonEndpoint)()?.pwaUrl ?? null;
  if (daemon === 'failed') {
    record('open-gui', 'skipped', 'Daemon unavailable');
    record('open-tui', 'skipped', 'Daemon unavailable');
  } else {
    if (requested === 'open-gui') {
      if (!openUrl) {
        record('open-gui', 'failed', 'Daemon address unknown');
      } else {
        try {
          if (await (deps.openGui ?? defaultOpenGui)(openUrl)) surface = 'gui';
        } catch { /* A browser is optional; retain the URL for manual opening. */ }
        record('open-gui', surface === 'gui' ? 'done' : 'failed', surface === 'gui' ? `Opened ${openUrl}` : `Open manually: ${openUrl}`);
      }
      record('open-tui', 'skipped', 'GUI selected');
    } else {
      record('open-gui', 'skipped', 'TUI selected');
      if (!tty) record('open-tui', 'failed', 'TUI requires a TTY');
      else {
        try { if ((await (deps.openTui ?? defaultOpenTui)(options.json === true)) === 0) surface = 'tui'; }
        catch { /* Exit with a stable diagnostic, not process/credential details. */ }
        record('open-tui', surface === 'tui' ? 'done' : 'failed', surface === 'tui' ? 'TUI closed' : 'TUI failed');
      }
    }
  }
  const exitCode = llm === 'unknown' || daemon === 'failed' || steps.some((step) => (step.id === requested) && step.status === 'failed') ? 1 : 0;
  const result: StartResult = { exitCode, steps, llm, daemon, surface };
  if (options.json) output(JSON.stringify(result));
  else {
    for (const step of steps) output(`${step.status === 'done' ? '✓' : step.status === 'failed' ? '✗' : '–'} ${step.id}: ${step.detail}`);
    if (llm === 'missing') output('LLM not configured; run `elanous login openai-codex` or `elanous llm detect`.');
    if (llm === 'unknown') output('LLM status unknown; discovery failed. Run `elanous llm detect` to check configuration.');
  }
  return result;
}

export function registerStartCommand(program: Command, deps: StartDeps = {}): void {
  program.command('start').description('Discover LLM, ensure Nexus is healthy, and open the GUI or TUI')
    .option('--gui', 'Open the browser UI (default)')
    .option('--tui', 'Open the terminal UI instead')
    .option('--no-login', 'Do not offer interactive LLM login')
    .option('--json', 'Print one secret-free JSON result')
    .action(async (options: StartOptions) => {
      if (options.gui && options.tui) {
        (deps.output ?? console.log)(options.json ? JSON.stringify({ exitCode: 2, error: '--gui and --tui are mutually exclusive' }) : '--gui and --tui are mutually exclusive');
        process.exitCode = 2;
        return;
      }
      const result = await runStart(options, deps);
      if (result.exitCode) process.exitCode = result.exitCode;
    });
}
